import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AuditError,
  AuditLog,
  buildAuditEvent,
  verifyAuditChain,
  type AuditEvent,
  type AuditRecordInput,
  type AuditSink,
} from "../src/audit.js";
import { AuditFileSink } from "../src/audit-sinks.js";
import { createPublicationIdentity } from "../src/package-identity.js";

const FIXED_TIME = new Date("2026-01-01T00:00:00.000Z");

function baseInput(overrides: Partial<AuditRecordInput> = {}): AuditRecordInput {
  return {
    operation: "deposit.validate",
    outcome: "succeeded",
    source: { kind: "system" },
    details: { valid: true, errorCount: 0, warningCount: 0 },
    timestamp: FIXED_TIME,
    ...overrides,
  };
}

test("event creation is deterministic for identical input", () => {
  const a = buildAuditEvent(baseInput(), null);
  const b = buildAuditEvent(baseInput(), null);
  assert.equal(a.eventHash, b.eventHash);
  assert.equal(a.sequence, 1);
  assert.equal(a.previousEventHash, null);
});

test("changing any recorded field changes the event hash", () => {
  const baseline = buildAuditEvent(baseInput(), null);
  const changedOutcome = buildAuditEvent(
    baseInput({ outcome: "failed", error: { category: "validation", code: "schema" } }),
    null,
  );
  const changedDetails = buildAuditEvent(
    baseInput({ details: { valid: false, errorCount: 1, warningCount: 0 } }),
    null,
  );
  assert.notEqual(baseline.eventHash, changedOutcome.eventHash);
  assert.notEqual(baseline.eventHash, changedDetails.eventHash);
});

test("hash chain links sequence and previousEventHash across events", () => {
  const first = buildAuditEvent(baseInput(), null);
  const second = buildAuditEvent(
    baseInput({ operation: "manifest.generate", details: { entryCount: 2, totalBytes: 10 } }),
    first,
  );
  const third = buildAuditEvent(baseInput({ operation: "package.digest", details: {} }), second);

  assert.equal(first.sequence, 1);
  assert.equal(first.previousEventHash, null);
  assert.equal(second.sequence, 2);
  assert.equal(second.previousEventHash, first.eventHash);
  assert.equal(third.sequence, 3);
  assert.equal(third.previousEventHash, second.eventHash);

  const verification = verifyAuditChain([first, second, third]);
  assert.equal(verification.valid, true);
  assert.deepEqual(verification.issues, []);
  assert.equal(verification.headEventHash, third.eventHash);
});

test("tampering with a stored event body is detected by hash mismatch", () => {
  const first = buildAuditEvent(baseInput(), null);
  const second = buildAuditEvent(
    baseInput({ operation: "manifest.generate", details: { entryCount: 2, totalBytes: 10 } }),
    first,
  );
  const tampered = { ...second, outcome: "failed" };
  const verification = verifyAuditChain([first, tampered]);
  assert.equal(verification.valid, false);
  assert.ok(verification.issues.some((issue) => issue.code === "event_hash_mismatch"));
});

test("reordering events is detected", () => {
  const first = buildAuditEvent(baseInput(), null);
  const second = buildAuditEvent(
    baseInput({ operation: "manifest.generate", details: { entryCount: 2, totalBytes: 10 } }),
    first,
  );
  const verification = verifyAuditChain([second, first]);
  assert.equal(verification.valid, false);
  assert.ok(verification.issues.some((issue) => issue.code === "sequence_mismatch"));
});

test("deleting an interior event is detected", () => {
  const first = buildAuditEvent(baseInput(), null);
  const second = buildAuditEvent(
    baseInput({ operation: "manifest.generate", details: { entryCount: 2, totalBytes: 10 } }),
    first,
  );
  const third = buildAuditEvent(baseInput({ operation: "package.digest", details: {} }), second);

  const verification = verifyAuditChain([first, third]);
  assert.equal(verification.valid, false);
  assert.ok(
    verification.issues.some((issue) => issue.code === "sequence_mismatch" || issue.code === "previous_hash_mismatch"),
  );
});

test("truncating the tail is invisible without an expected-head checkpoint, detected with one", () => {
  const first = buildAuditEvent(baseInput(), null);
  const second = buildAuditEvent(
    baseInput({ operation: "manifest.generate", details: { entryCount: 2, totalBytes: 10 } }),
    first,
  );

  const withoutCheckpoint = verifyAuditChain([first]);
  assert.equal(withoutCheckpoint.valid, true);

  const withCheckpoint = verifyAuditChain([first], { expectedHeadEventHash: second.eventHash });
  assert.equal(withCheckpoint.valid, false);
  assert.ok(withCheckpoint.issues.some((issue) => issue.code === "head_mismatch"));
});

test("attemptEventHash links a terminal event back to its attempt and is rejected on attempted events", () => {
  const attempt = buildAuditEvent(baseInput({ outcome: "attempted", details: undefined }), null);
  const success = buildAuditEvent(baseInput({ attemptEventHash: attempt.eventHash }), attempt);
  assert.equal(success.attemptEventHash, attempt.eventHash);

  assert.throws(
    () => buildAuditEvent(baseInput({ outcome: "attempted", attemptEventHash: attempt.eventHash }), attempt),
    (error: unknown) => error instanceof AuditError && error.code === "attempt_hash_requires_terminal_outcome",
  );
});

test("secret-like field names in details are rejected even when otherwise well-formed", () => {
  assert.throws(
    () =>
      buildAuditEvent(
        baseInput({ details: { valid: true, errorCount: 0, warningCount: 0, token: "should-not-be-here" } }),
        null,
      ),
    (error: unknown) => error instanceof AuditError && error.code === "secret_like_field_rejected",
  );
});

test("unknown details fields are rejected by the per-operation strict schema", () => {
  assert.throws(
    () =>
      buildAuditEvent(
        baseInput({ details: { valid: true, errorCount: 0, warningCount: 0, extra: "nope" } }),
        null,
      ),
    (error: unknown) => error instanceof AuditError && error.code === "invalid_details",
  );
});

test("AuditLog serializes concurrent record() calls into one well-formed chain", async () => {
  const log = new AuditLog();
  const inputs = Array.from({ length: 25 }, (_, index) =>
    baseInput({ operation: "draft.read", details: {}, draftId: `draft-${index}` }));

  const events = await Promise.all(inputs.map((input) => log.record(input)));
  const sequences = events.map((event) => event.sequence).sort((a, b) => a - b);
  assert.deepEqual(sequences, Array.from({ length: 25 }, (_, index) => index + 1));

  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  const verification = verifyAuditChain(ordered);
  assert.equal(verification.valid, true);
  assert.equal(log.head?.eventHash, ordered[ordered.length - 1]!.eventHash);
});

test("file sink appends canonical lines, resumes after restart, and refuses a tampered log", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "research-deposition-audit-"));
  const filePath = path.join(dir, "audit.ndjson");
  try {
    const firstLog = new AuditLog(new AuditFileSink(filePath));
    await firstLog.record(baseInput());
    await firstLog.record(baseInput({ operation: "manifest.generate", details: { entryCount: 1, totalBytes: 5 } }));

    const resumedLog = new AuditLog(new AuditFileSink(filePath));
    const third = await resumedLog.record(baseInput({ operation: "package.digest", details: {} }));
    assert.equal(third.sequence, 3);
    assert.equal(third.previousEventHash !== null, true);

    const contents = await readFile(filePath, "utf8");
    const lines = contents.split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, 3);
    assert.equal(contents.endsWith("\n"), true);

    const tamperedContents = lines
      .map((line, index) => (index === 0 ? line.replace('"outcome":"succeeded"', '"outcome":"failed"') : line))
      .join("\n") + "\n";
    await writeFile(filePath, tamperedContents, "utf8");

    await assert.rejects(
      () => new AuditFileSink(filePath).initialize(),
      (error: unknown) => error instanceof AuditError && error.code === "audit_log_tampered",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("existing publication package identity digest is unaffected by the audit module", () => {
  const manifest = { schemaVersion: "1" as const, entries: [] };
  const metadata = {
    resourceType: "dataset" as const,
    title: "Audit sanity dataset",
    description: "Confirms package identity is unaffected by adding the audit module.",
    creators: [{ name: "Doe, Jane" }],
  };
  const first = createPublicationIdentity(metadata, manifest);
  const second = createPublicationIdentity(metadata, manifest);
  assert.equal(first.digest, second.digest);
});

test("golden serialized event and hash for a fixed input (independently recomputed sha256)", () => {
  const event = buildAuditEvent(baseInput(), null);

  assert.equal(event.timestamp, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(event, {
    schemaVersion: "1",
    sequence: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    operation: "deposit.validate",
    outcome: "succeeded",
    source: { kind: "system" },
    details: { valid: true, errorCount: 0, warningCount: 0 },
    previousEventHash: null,
    eventHash: "4b252afa2eb25d82bfa71accfac5a43695989a6c978739f71d856fb78658e19d",
  });

  // Recomputed independently of src/canonical-json.ts to catch a regression
  // in the hashing/canonicalization pipeline itself, not just a change that
  // happens to keep buildAuditEvent and the golden value in lockstep.
  const domain = `research-deposition-audit-event-v1${String.fromCharCode(0)}`;
  const canonicalBody =
    '{"details":{"errorCount":0,"valid":true,"warningCount":0},"operation":"deposit.validate",' +
    '"outcome":"succeeded","previousEventHash":null,"schemaVersion":"1","sequence":1,' +
    '"source":{"kind":"system"},"timestamp":"2026-01-01T00:00:00.000Z"}\n';
  const expectedHash = createHash("sha256").update(domain, "utf8").update(canonicalBody, "utf8").digest("hex");
  assert.equal(event.eventHash, expectedHash);
});

test("repository.target rejects credential-bearing, query, and fragment URLs, and accepts a normalized target", () => {
  assert.throws(
    () => buildAuditEvent(baseInput({ repository: { adapter: "zenodo", target: "https://user:token@zenodo.org" } }), null),
    (error: unknown) => error instanceof AuditError && error.code === "repository_target_credentials_rejected",
  );
  assert.throws(
    () => buildAuditEvent(baseInput({ repository: { adapter: "zenodo", target: "https://zenodo.org/?api_key=abc" } }), null),
    (error: unknown) => error instanceof AuditError && error.code === "repository_target_credentials_rejected",
  );
  assert.throws(
    () => buildAuditEvent(baseInput({ repository: { adapter: "zenodo", target: "https://zenodo.org/#token=abc" } }), null),
    (error: unknown) => error instanceof AuditError && error.code === "repository_target_credentials_rejected",
  );
  assert.throws(
    () => buildAuditEvent(baseInput({ repository: { adapter: "zenodo", target: "not-a-url" } }), null),
    (error: unknown) => error instanceof AuditError && error.code === "repository_target_invalid",
  );

  const event = buildAuditEvent(baseInput({ repository: { adapter: "zenodo", target: "https://zenodo.org" } }), null);
  assert.equal(event.repository?.target, "https://zenodo.org");
});

test("verifyAuditChain detects a serialized event whose attemptEventHash does not reference a real prior attempt", () => {
  const attempt = buildAuditEvent(baseInput({ outcome: "attempted", details: undefined }), null);
  const bogusTerminal = buildAuditEvent(baseInput({ attemptEventHash: "a".repeat(64) }), attempt);

  const verification = verifyAuditChain([attempt, bogusTerminal]);
  assert.equal(verification.valid, false);
  assert.ok(verification.issues.some((issue) => issue.code === "attempt_reference_not_found"));
});

test("verifyAuditChain rejects an attemptEventHash pointing at a non-attempted or different-operation event", () => {
  const notAnAttempt = buildAuditEvent(baseInput({ details: { valid: true, errorCount: 0, warningCount: 0 } }), null);
  const terminalOnSucceeded = buildAuditEvent(baseInput({ attemptEventHash: notAnAttempt.eventHash }), notAnAttempt);
  const notAttemptVerification = verifyAuditChain([notAnAttempt, terminalOnSucceeded]);
  assert.equal(notAttemptVerification.valid, false);
  assert.ok(notAttemptVerification.issues.some((issue) => issue.code === "attempt_reference_not_attempt"));

  const attempt = buildAuditEvent(baseInput({ operation: "draft.read", outcome: "attempted", details: undefined }), null);
  const differentOperationTerminal = buildAuditEvent(
    baseInput({ operation: "package.digest", details: {}, attemptEventHash: attempt.eventHash }),
    attempt,
  );
  const operationMismatchVerification = verifyAuditChain([attempt, differentOperationTerminal]);
  assert.equal(operationMismatchVerification.valid, false);
  assert.ok(
    operationMismatchVerification.issues.some((issue) => issue.code === "attempt_reference_operation_mismatch"),
  );
});

test("verifyAuditChain rejects a second terminal event resolving an already-resolved attempt", () => {
  const attempt = buildAuditEvent(baseInput({ outcome: "attempted", details: undefined }), null);
  const first = buildAuditEvent(baseInput({ attemptEventHash: attempt.eventHash }), attempt);
  const second = buildAuditEvent(
    baseInput({ outcome: "failed", error: { category: "internal", code: "retry" }, attemptEventHash: attempt.eventHash }),
    first,
  );

  const verification = verifyAuditChain([attempt, first, second]);
  assert.equal(verification.valid, false);
  assert.ok(verification.issues.some((issue) => issue.code === "duplicate_attempt_resolution"));
});

test("AuditLog.recordOutcome rejects an attempt reference that was not recorded as an attempt by this log", async () => {
  const log = new AuditLog();
  const notAnAttempt = buildAuditEvent(baseInput({ outcome: "attempted", details: undefined }), null);
  // Fabricated: never actually recorded via this AuditLog instance.
  await assert.rejects(
    () => log.recordOutcome(notAnAttempt, "succeeded", { source: { kind: "system" }, details: undefined }),
    (error: unknown) => error instanceof AuditError && error.code === "attempt_reference_not_found",
  );
});

test("AuditLog.recordOutcome rejects resolving the same attempt twice", async () => {
  const log = new AuditLog();
  const attempt = await log.recordAttempt({ operation: "draft.read", source: { kind: "system" }, details: undefined });
  await log.recordOutcome(attempt, "succeeded", { source: { kind: "system" }, details: {} });

  await assert.rejects(
    () => log.recordOutcome(attempt, "succeeded", { source: { kind: "system" }, details: {} }),
    (error: unknown) => error instanceof AuditError && error.code === "duplicate_attempt_resolution",
  );
});

test("file sink refuses to resume a log whose file is missing a final newline", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "research-deposition-audit-"));
  const filePath = path.join(dir, "audit.ndjson");
  try {
    const log = new AuditLog(new AuditFileSink(filePath));
    await log.record(baseInput());

    const contents = await readFile(filePath, "utf8");
    await writeFile(filePath, contents.replace(/\n$/u, ""), "utf8");

    await assert.rejects(
      () => new AuditFileSink(filePath).initialize(),
      (error: unknown) => error instanceof AuditError && error.code === "audit_log_missing_trailing_newline",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AuditLog is poisoned after a sink initialize() failure and fails every later record()", async () => {
  const sink: AuditSink = {
    initialize: () => Promise.reject(new Error("disk unavailable")),
    append: () => Promise.resolve(),
  };
  const log = new AuditLog(sink);

  await assert.rejects(
    () => log.record(baseInput()),
    (error: unknown) => error instanceof AuditError && error.code === "audit_log_poisoned",
  );
  await assert.rejects(
    () => log.record(baseInput({ operation: "draft.read", details: {} })),
    (error: unknown) => error instanceof AuditError && error.code === "audit_log_poisoned",
  );
});

test("AuditLog is poisoned after a sink append() failure and fails every later record()", async () => {
  let appendCalls = 0;
  const sink: AuditSink = {
    initialize: () => Promise.resolve(null),
    append: () => {
      appendCalls += 1;
      return Promise.reject(new Error("write failed"));
    },
  };
  const log = new AuditLog(sink);

  await assert.rejects(
    () => log.record(baseInput()),
    (error: unknown) => error instanceof AuditError && error.code === "audit_log_poisoned",
  );
  assert.equal(appendCalls, 1);

  await assert.rejects(
    () => log.record(baseInput({ operation: "draft.read", details: {} })),
    (error: unknown) => error instanceof AuditError && error.code === "audit_log_poisoned",
  );
  // The poisoned log must not retry the sink at all for later calls.
  assert.equal(appendCalls, 1);
});

test("an input-validation failure does not poison AuditLog; later valid records still succeed", async () => {
  const log = new AuditLog();

  await assert.rejects(
    () => log.record(baseInput({ details: { valid: true, errorCount: 0, warningCount: 0, token: "nope" } })),
    (error: unknown) => error instanceof AuditError && error.code === "secret_like_field_rejected",
  );

  const event = await log.record(baseInput());
  assert.equal(event.sequence, 1);
  assert.equal(log.head?.eventHash, event.eventHash);
});

test("a poisoned AuditLog never retains the raw sink error message, only a sanitized code", async () => {
  const secret = "Authorization Bearer super-secret-token-abc123";
  const sink: AuditSink = {
    initialize: () => Promise.reject(new Error(secret)),
    append: () => Promise.resolve(),
  };
  const log = new AuditLog(sink);

  await assert.rejects(
    () => log.record(baseInput()),
    (error: unknown) => {
      assert.ok(error instanceof AuditError);
      assert.equal(error.code, "audit_log_poisoned");
      const serialized = JSON.stringify(error.details);
      assert.ok(!serialized.includes(secret), "poisoned AuditError.details must not contain the raw cause message");
      assert.deepEqual(error.details, { stage: "initialize", cause: { code: "sink_error" } });
      return true;
    },
  );
});

test("a poisoned AuditLog does not forward an AuditError cause code that fails the machine-code shape", async () => {
  const sink: AuditSink = {
    initialize: () => Promise.resolve(null),
    append: () => Promise.reject(new AuditError("Authorization Bearer TOKEN", "boom")),
  };
  const log = new AuditLog(sink);

  await assert.rejects(
    () => log.record(baseInput()),
    (error: unknown) => {
      assert.ok(error instanceof AuditError);
      assert.deepEqual(error.details, { stage: "append", cause: { code: "sink_error" } });
      return true;
    },
  );
});

test("error.code rejects raw/token-bearing messages and non-machine-code shapes", () => {
  const rejected = [
    "Authorization Bearer TOKEN",
    "token_leak_abc123",
    "Retry-Later",
    "code with spaces",
    "has\ttab",
    "",
  ];
  for (const code of rejected) {
    assert.throws(
      () => buildAuditEvent(baseInput({ outcome: "failed", error: { category: "internal", code } }), null),
      (error: unknown) => error instanceof Error,
      `expected code ${JSON.stringify(code)} to be rejected`,
    );
  }

  const event = buildAuditEvent(
    baseInput({ outcome: "failed", error: { category: "internal", code: "sink.write-failed_1" } }),
    null,
  );
  assert.equal(event.error?.code, "sink.write-failed_1");
});

test("repository.target rejects non-http(s) schemes", () => {
  assert.throws(
    () => buildAuditEvent(baseInput({ repository: { adapter: "zenodo", target: "ftp://zenodo.org" } }), null),
    (error: unknown) => error instanceof AuditError && error.code === "repository_target_invalid",
  );
  assert.throws(
    () => buildAuditEvent(baseInput({ repository: { adapter: "zenodo", target: "mailto:ops@zenodo.org" } }), null),
    (error: unknown) => error instanceof AuditError && error.code === "repository_target_invalid",
  );
  assert.throws(
    () => buildAuditEvent(baseInput({ repository: { adapter: "zenodo", target: "file:///etc/passwd" } }), null),
    (error: unknown) => error instanceof AuditError && error.code === "repository_target_invalid",
  );
});

test("repository.target rejects non-canonical trailing-slash and hostname-case variants", () => {
  assert.throws(
    () =>
      buildAuditEvent(
        baseInput({ repository: { adapter: "zenodo", target: "https://zenodo.org/records/123/" } }),
        null,
      ),
    (error: unknown) => error instanceof AuditError && error.code === "repository_target_not_canonical",
  );
  assert.throws(
    () => buildAuditEvent(baseInput({ repository: { adapter: "zenodo", target: "https://ZENODO.org" } }), null),
    (error: unknown) => error instanceof AuditError && error.code === "repository_target_not_canonical",
  );

  const event = buildAuditEvent(
    baseInput({ repository: { adapter: "zenodo", target: "https://zenodo.org/records/123" } }),
    null,
  );
  assert.equal(event.repository?.target, "https://zenodo.org/records/123");
});
