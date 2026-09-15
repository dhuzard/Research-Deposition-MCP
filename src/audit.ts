import { createHash } from "node:crypto";
import { z } from "zod";
import { normalizeRepositoryTarget } from "./approval.js";
import { canonicalJsonLine, type CanonicalJsonValue } from "./canonical-json.js";

export const AUDIT_EVENT_SCHEMA_VERSION = "1" as const;
export const AUDIT_EVENT_HASH_DOMAIN = "research-deposition-audit-event-v1" + String.fromCharCode(0);

/**
 * Stable operation vocabulary for schemaVersion "1". Every event -- however
 * old -- is validated against this single current list (there is no
 * per-schemaVersion vocabulary dispatch), so renaming or removing an entry
 * breaks parsing of any already-persisted event that used it. Only add new
 * entries here; treat a rename/removal as a breaking change that requires
 * introducing a new AUDIT_EVENT_SCHEMA_VERSION with its own vocabulary and
 * validation path, not merely bumping the version constant.
 */
export const AUDIT_OPERATIONS = [
  "deposit.validate",
  "manifest.generate",
  "package.digest",
  "draft.create",
  "draft.read",
  "draft.update",
  "file.upload",
  "file.remove",
  "approval.request",
  "approval.issue",
  "approval.invalidate",
  "publication.publish",
  "version.initiate",
] as const;

export type AuditOperation = (typeof AUDIT_OPERATIONS)[number];

export const AUDIT_OUTCOMES = ["attempted", "succeeded", "failed"] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export const AUDIT_SOURCE_KINDS = ["mcp-tool", "operator-cli", "system"] as const;
export type AuditSourceKind = (typeof AUDIT_SOURCE_KINDS)[number];

export const AUDIT_ERROR_CATEGORIES = [
  "validation",
  "policy",
  "not_found",
  "conflict",
  "network",
  "authentication",
  "authorization",
  "repository_rejected",
  "approval_invalid",
  "internal",
] as const;
export type AuditErrorCategory = (typeof AUDIT_ERROR_CATEGORIES)[number];

const APPROVAL_INVALIDATE_REASONS = [
  "digest_mismatch",
  "expired",
  "superseded",
  "revoked",
  "policy_changed",
] as const;

const hex64Pattern = /^[a-f0-9]{64}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** Rejects any ASCII control character so no NDJSON line break or hidden byte can enter a stored identifier. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Bounded, control-character-free identifier. Not a claim that the value is free of PII. */
const safeIdentifier = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !hasControlCharacter(value), "must not contain control characters");

const hex64 = z.string().regex(hex64Pattern, "must be a lowercase 64-character hex SHA-256 digest");
const nonNegativeInt = z.number().int().nonnegative();

export class AuditError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AuditError";
  }
}

const AuditSourceSchema = z
  .object({
    kind: z.enum(AUDIT_SOURCE_KINDS),
    id: safeIdentifier.optional(),
  })
  .strict();

export type AuditSource = z.infer<typeof AuditSourceSchema>;

const AuditRepositoryRefSchema = z
  .object({
    adapter: safeIdentifier.optional(),
    target: safeIdentifier.optional(),
  })
  .strict();

export type AuditRepositoryRef = z.infer<typeof AuditRepositoryRefSchema>;

const REPOSITORY_TARGET_ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * `repository.target` must already be a normalized, canonical absolute
 * http(s) URL with no userinfo, query, or fragment -- those components can
 * carry credentials (`https://user:token@host/...`, `?api_key=...`) that
 * must never be hashed or persisted into the audit log. This is
 * intentionally a hard rejection, not silent stripping/rewriting: silently
 * laundering the value would let a caller bug that leaks credentials into
 * `target`, or a non-canonical variant (trailing slash, mixed-case host)
 * that would hash differently for the "same" target, go unnoticed instead of
 * failing loudly. Canonical form is computed with the same
 * `normalizeRepositoryTarget` used for signed approval requests so both
 * subsystems agree on what "canonical" means; the result is only used here
 * to detect and reject non-canonical input, never to overwrite it.
 */
function rejectUnsafeRepositoryTarget(target: string): void {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new AuditError(
      "repository_target_invalid",
      'Audit event "repository.target" must be an absolute URL.',
    );
  }
  if (!REPOSITORY_TARGET_ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new AuditError(
      "repository_target_invalid",
      'Audit event "repository.target" must use the "http" or "https" scheme.',
    );
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new AuditError(
      "repository_target_credentials_rejected",
      'Audit event "repository.target" must not contain userinfo, a query string, or a fragment.',
    );
  }
  const canonical = normalizeRepositoryTarget(target);
  if (canonical !== target) {
    throw new AuditError(
      "repository_target_not_canonical",
      `Audit event "repository.target" must already be in canonical form; expected "${canonical}".`,
    );
  }
}

const SECRET_LIKE_SUBSTRINGS = [
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "authorization",
  "apikey",
  "privatekey",
  "signature",
  "cookie",
  "header",
  "receipt",
  "message",
  "path",
  "filepath",
  "localpath",
];

/** Shared substring check reused both for object field names and for free-standing values (e.g. machine error codes) that must not look secret-bearing. */
function containsSecretLikeSubstring(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[_-]/gu, "");
  return SECRET_LIKE_SUBSTRINGS.some((needle) => normalized.includes(needle));
}

/**
 * `error.code` is a machine-readable identifier, never a place to carry a raw
 * exception message. `safeIdentifier` alone (bounded, control-char-free) is
 * not enough: it still accepts spaces, mixed case, and arbitrary free text
 * such as `"Authorization Bearer <token>"`. Restrict it to a deterministic
 * machine-code shape (lowercase ASCII letters/digits separated by `.`, `_`,
 * or `-`) and reject any value containing a secret-like substring, so a
 * caller cannot smuggle raw error text or credentials through this field.
 */
const ERROR_CODE_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const errorCode = z
  .string()
  .min(1)
  .max(100)
  .regex(ERROR_CODE_PATTERN, "must be a lowercase machine code (letters, digits, '.', '_', '-' only; no spaces or uppercase)")
  .refine((value) => !containsSecretLikeSubstring(value), "must not contain a secret-like substring");

const AuditEventFailureSchema = z
  .object({
    category: z.enum(AUDIT_ERROR_CATEGORIES),
    code: errorCode,
  })
  .strict();

export type AuditEventFailure = z.infer<typeof AuditEventFailureSchema>;

/**
 * Per-operation "safe summary" detail shapes. Each is a small, fixed, strict
 * schema of counts/booleans/enums/hashes. Free-text messages, arbitrary
 * payloads, and file-system paths are deliberately not representable here.
 */
const AUDIT_DETAILS_SCHEMAS: Record<AuditOperation, z.ZodTypeAny> = {
  "deposit.validate": z
    .object({
      valid: z.boolean(),
      errorCount: nonNegativeInt,
      warningCount: nonNegativeInt,
    })
    .strict(),
  "manifest.generate": z
    .object({
      entryCount: nonNegativeInt,
      totalBytes: nonNegativeInt,
    })
    .strict(),
  "package.digest": z.object({}).strict(),
  "draft.create": z.object({}).strict(),
  "draft.read": z.object({}).strict(),
  "draft.update": z.object({}).strict(),
  "file.upload": z
    .object({
      fileCount: nonNegativeInt.optional(),
      totalBytes: nonNegativeInt.optional(),
      sha256: z
        .string()
        .regex(hex64Pattern)
        .optional(),
    })
    .strict(),
  "file.remove": z
    .object({
      fileCount: nonNegativeInt.optional(),
    })
    .strict(),
  "approval.request": z.object({}).strict(),
  "approval.issue": z
    .object({
      expiresInSeconds: z.number().int().positive().optional(),
    })
    .strict(),
  "approval.invalidate": z
    .object({
      reason: z.enum(APPROVAL_INVALIDATE_REASONS).optional(),
    })
    .strict(),
  "publication.publish": z.object({}).strict(),
  "version.initiate": z.object({}).strict(),
};

function findSecretLikeKeys(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findSecretLikeKeys(item, `${prefix}[${index}]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, val]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      const hit = containsSecretLikeSubstring(key) ? [path] : [];
      return [...hit, ...findSecretLikeKeys(val, path)];
    });
  }
  return [];
}

function validateDetails(operation: AuditOperation, details: unknown): Record<string, unknown> | undefined {
  if (details === undefined) return undefined;

  const hits = findSecretLikeKeys(details);
  if (hits.length > 0) {
    throw new AuditError(
      "secret_like_field_rejected",
      `Audit event details contain disallowed field name(s): ${hits.join(", ")}.`,
    );
  }

  const schema = AUDIT_DETAILS_SCHEMAS[operation];
  const parsed = schema.safeParse(details);
  if (!parsed.success) {
    throw new AuditError(
      "invalid_details",
      `Audit event details do not match the safe-summary schema for operation "${operation}".`,
      parsed.error.issues,
    );
  }
  return parsed.data as Record<string, unknown>;
}

const AuditEventBodySchema = z
  .object({
    schemaVersion: z.literal(AUDIT_EVENT_SCHEMA_VERSION),
    sequence: z.number().int().positive(),
    timestamp: z.string().regex(isoTimestampPattern, "must be an ISO-8601 UTC timestamp with millisecond precision"),
    operation: z.enum(AUDIT_OPERATIONS),
    outcome: z.enum(AUDIT_OUTCOMES),
    source: AuditSourceSchema,
    repository: AuditRepositoryRefSchema.optional(),
    draftId: safeIdentifier.optional(),
    packageDigest: z.string().regex(digestPattern).optional(),
    attemptEventHash: hex64.optional(),
    details: z.unknown().optional(),
    error: AuditEventFailureSchema.optional(),
    previousEventHash: z.union([z.null(), hex64]),
  })
  .strict();

const AuditEventSchema = AuditEventBodySchema.extend({
  eventHash: hex64,
}).strict();

export type AuditEventBody = z.infer<typeof AuditEventBodySchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;

function hashEventBody(body: AuditEventBody): string {
  const canonical = canonicalJsonLine(body as unknown as CanonicalJsonValue);
  return createHash("sha256").update(AUDIT_EVENT_HASH_DOMAIN, "utf8").update(canonical, "utf8").digest("hex");
}

export interface AuditRecordInput {
  operation: AuditOperation;
  outcome: AuditOutcome;
  source: AuditSource;
  repository?: AuditRepositoryRef;
  draftId?: string;
  packageDigest?: string;
  attemptEventHash?: string;
  details?: unknown;
  error?: AuditEventFailure;
  /** Override for deterministic tests; defaults to `new Date()`. */
  timestamp?: Date;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/**
 * Build the next event in the chain. Sequence and previousEventHash are
 * derived from `previous` rather than accepted from the caller, because the
 * chain -- not the caller -- is the source of truth for event ordering.
 */
export function buildAuditEvent(input: AuditRecordInput, previous: AuditEvent | null): AuditEvent {
  if (input.error !== undefined && input.outcome !== "failed") {
    throw new AuditError("error_requires_failed_outcome", 'Audit event "error" is only valid with outcome "failed".');
  }
  if (input.attemptEventHash !== undefined && input.outcome === "attempted") {
    throw new AuditError(
      "attempt_hash_requires_terminal_outcome",
      'Audit event "attemptEventHash" is only valid for "succeeded"/"failed" outcomes.',
    );
  }

  const source = AuditSourceSchema.parse(input.source);
  const repository = input.repository !== undefined ? AuditRepositoryRefSchema.parse(input.repository) : undefined;
  if (repository?.target !== undefined) rejectUnsafeRepositoryTarget(repository.target);
  const draftId = input.draftId !== undefined ? safeIdentifier.parse(input.draftId) : undefined;
  const packageDigest = input.packageDigest !== undefined
    ? z.string().regex(digestPattern).parse(input.packageDigest)
    : undefined;
  const attemptEventHash = input.attemptEventHash !== undefined ? hex64.parse(input.attemptEventHash) : undefined;
  const error = input.error !== undefined ? AuditEventFailureSchema.parse(input.error) : undefined;
  const details = validateDetails(input.operation, input.details);

  const sequence = previous ? previous.sequence + 1 : 1;
  const previousEventHash = previous ? previous.eventHash : null;
  const timestamp = (input.timestamp ?? new Date()).toISOString();

  const body: AuditEventBody = omitUndefined({
    schemaVersion: AUDIT_EVENT_SCHEMA_VERSION,
    sequence,
    timestamp,
    operation: input.operation,
    outcome: input.outcome,
    source,
    repository,
    draftId,
    packageDigest,
    attemptEventHash,
    details,
    error,
    previousEventHash,
  }) as AuditEventBody;

  const eventHash = hashEventBody(body);
  return { ...body, eventHash };
}

/**
 * Parse and fully validate a single serialized event: schema shape,
 * operation-specific detail shape, outcome/error/attemptEventHash
 * consistency, and self-consistency of eventHash against its own body.
 * Does not check sequence continuity or chain linkage; use
 * `verifyAuditChain` for that.
 */
export function parseAuditEvent(raw: unknown): AuditEvent {
  const parsed = AuditEventSchema.parse(raw);
  validateDetails(parsed.operation, parsed.details);
  if (parsed.repository?.target !== undefined) rejectUnsafeRepositoryTarget(parsed.repository.target);

  if (parsed.error !== undefined && parsed.outcome !== "failed") {
    throw new AuditError("error_requires_failed_outcome", 'Audit event "error" is only valid with outcome "failed".');
  }
  if (parsed.attemptEventHash !== undefined && parsed.outcome === "attempted") {
    throw new AuditError(
      "attempt_hash_requires_terminal_outcome",
      'Audit event "attemptEventHash" is only valid for "succeeded"/"failed" outcomes.',
    );
  }

  const { eventHash, ...body } = parsed;
  const recomputed = hashEventBody(body);
  if (recomputed !== eventHash) {
    throw new AuditError("event_hash_mismatch", `Audit event at sequence ${body.sequence} does not match its recomputed hash.`);
  }

  return parsed;
}

export interface AuditChainIssue {
  code: string;
  message: string;
  index: number;
  sequence?: number;
}

export interface AuditChainVerification {
  valid: boolean;
  issues: AuditChainIssue[];
  length: number;
  headEventHash: string | null;
}

export interface AuditChainVerificationOptions {
  /** Previously recorded head hash (external checkpoint) used to detect tail truncation. */
  expectedHeadEventHash?: string | null;
}

/**
 * Verify an ordered sequence of raw (untrusted) events: schema validity,
 * sequence continuity starting at 1, hash self-consistency, previous-hash
 * linkage, and attempt/terminal-event linkage. Deleting or reordering an
 * interior event breaks continuity or linkage and is detected. Deleting a
 * *tail* of the log leaves the remaining chain internally consistent; pass
 * `expectedHeadEventHash` from an external checkpoint to detect that case.
 *
 * `attemptEventHash` on a `succeeded`/`failed` event must reference a
 * strictly earlier event in this same sequence that has outcome
 * `"attempted"` for the same `operation`, and each attempt may be resolved
 * by at most one terminal event -- a second terminal event pointing at an
 * already-resolved attempt is reported as `duplicate_attempt_resolution`
 * rather than silently accepted.
 */
export function verifyAuditChain(rawEvents: unknown[], options: AuditChainVerificationOptions = {}): AuditChainVerification {
  const issues: AuditChainIssue[] = [];
  let previous: AuditEvent | null = null;
  const eventsByHash = new Map<string, AuditEvent>();
  const resolvedAttemptHashes = new Set<string>();

  rawEvents.forEach((raw, index) => {
    let event: AuditEvent;
    try {
      event = parseAuditEvent(raw);
    } catch (error) {
      issues.push({
        code: error instanceof AuditError ? error.code : "schema_invalid",
        message: error instanceof Error ? error.message : "Audit event failed validation.",
        index,
      });
      return;
    }

    const expectedSequence = previous ? previous.sequence + 1 : 1;
    if (event.sequence !== expectedSequence) {
      issues.push({
        code: "sequence_mismatch",
        message: `Expected sequence ${expectedSequence} at position ${index}, found ${event.sequence}.`,
        index,
        sequence: event.sequence,
      });
    }

    const expectedPreviousHash = previous ? previous.eventHash : null;
    if (event.previousEventHash !== expectedPreviousHash) {
      issues.push({
        code: "previous_hash_mismatch",
        message: `Audit event at position ${index} does not link to the prior event hash.`,
        index,
        sequence: event.sequence,
      });
    }

    if (event.attemptEventHash !== undefined) {
      const attemptEvent = eventsByHash.get(event.attemptEventHash);
      if (!attemptEvent) {
        issues.push({
          code: "attempt_reference_not_found",
          message: `Audit event at position ${index} has an "attemptEventHash" that does not match any prior event in this chain.`,
          index,
          sequence: event.sequence,
        });
      } else if (attemptEvent.outcome !== "attempted") {
        issues.push({
          code: "attempt_reference_not_attempt",
          message: `Audit event at position ${index} has an "attemptEventHash" that does not reference an "attempted" event.`,
          index,
          sequence: event.sequence,
        });
      } else if (attemptEvent.operation !== event.operation) {
        issues.push({
          code: "attempt_reference_operation_mismatch",
          message: `Audit event at position ${index} has an "attemptEventHash" that references an attempt for a different operation.`,
          index,
          sequence: event.sequence,
        });
      } else if (resolvedAttemptHashes.has(event.attemptEventHash)) {
        issues.push({
          code: "duplicate_attempt_resolution",
          message: `Audit event at position ${index} resolves an attempt that a prior event already resolved.`,
          index,
          sequence: event.sequence,
        });
      } else {
        resolvedAttemptHashes.add(event.attemptEventHash);
      }
    }

    eventsByHash.set(event.eventHash, event);
    previous = event;
  });

  const headEventHash = previous ? (previous as AuditEvent).eventHash : null;
  if (options.expectedHeadEventHash !== undefined && options.expectedHeadEventHash !== null) {
    if (headEventHash !== options.expectedHeadEventHash) {
      issues.push({
        code: "head_mismatch",
        message: "Audit log head does not match the expected checkpoint hash; the log may have been truncated.",
        index: rawEvents.length - 1,
      });
    }
  }

  return { valid: issues.length === 0, issues, length: rawEvents.length, headEventHash };
}

export interface AuditSink {
  /**
   * Called once before the first append. Must validate any pre-existing
   * events and return the current head event, or null for an empty/new log.
   * Must throw rather than silently repair a tampered log.
   */
  initialize(): Promise<AuditEvent | null>;
  /** Append exactly one already-chained event. */
  append(event: AuditEvent): Promise<void>;
}

/**
 * Application-level append-only audit recorder. Owns sequence assignment and
 * hash chaining; a sink (if provided) only persists already-validated
 * events. Concurrent `record()` calls are serialized so sequence numbers and
 * the hash chain stay well-formed under concurrent callers within this
 * process.
 */
export class AuditLog {
  private readonly sink?: AuditSink;
  private queue: Promise<void> = Promise.resolve();
  private lastEvent: AuditEvent | null = null;
  private initialized = false;
  private poisoned: AuditError | null = null;
  /**
   * Every "attempted" event this instance has recorded, keyed by its
   * eventHash, so a later terminal event's `attemptEventHash` can be checked
   * against a real, same-operation, not-yet-resolved attempt from this same
   * chain rather than trusted blindly. Entries persist (resolved: true) after
   * resolution so a second terminal event referencing the same attempt is
   * rejected rather than silently accepted. Scoped to this in-memory
   * instance: an attempt left unresolved by a crashed process is not
   * recovered by a later instance resuming the same sink, matching the
   * "outcome unknown, not corruption" behavior documented in docs/audit.md.
   */
  private readonly attempts = new Map<string, { operation: AuditOperation; resolved: boolean }>();

  constructor(sink?: AuditSink) {
    this.sink = sink;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.lastEvent = this.sink ? await this.sink.initialize() : null;
    this.initialized = true;
  }

  /**
   * Mark this instance permanently unusable after a sink I/O failure, whose
   * effect on durable storage is unknown (a partially-written line, an
   * unresolvable initialize() error, etc.). Retrying against the same
   * in-memory `lastEvent`/sequence state could duplicate or desynchronize
   * the persisted chain, so every later `record()` fails fast instead;
   * callers must construct a fresh `AuditLog`, which re-verifies the sink
   * from scratch via `initialize()`.
   *
   * The underlying sink error is never retained here beyond a sanitized,
   * bounded code: a filesystem/network/HTTP client error's `message` can
   * legitimately contain request bodies, headers, or other raw content (e.g.
   * `"Authorization Bearer <token>"`), and this failure is surfaced to
   * callers/logs, so no arbitrary cause text -- from this codebase or from a
   * caller-supplied `AuditSink` implementation -- is ever copied into
   * `AuditError.details`.
   */
  private poison(stage: "initialize" | "append", error: unknown): AuditError {
    const causeCode =
      error instanceof AuditError && errorCode.safeParse(error.code).success ? error.code : "sink_error";
    this.poisoned = new AuditError(
      "audit_log_poisoned",
      `AuditLog can no longer record events after a sink ${stage} failure; its in-memory state may not match durable storage. Construct a fresh AuditLog (which re-verifies the sink from scratch) instead of reusing this instance.`,
      { stage, cause: { code: causeCode } },
    );
    return this.poisoned;
  }

  record(input: AuditRecordInput): Promise<AuditEvent> {
    const result = this.queue.then(async () => {
      if (this.poisoned) throw this.poisoned;

      try {
        await this.ensureInitialized();
      } catch (error) {
        throw this.poison("initialize", error);
      }

      // Structural/content validation (schema, secret-like fields, etc.) is
      // an input-validation failure, not a durable-state failure, and must
      // not poison the log.
      const event = buildAuditEvent(input, this.lastEvent);

      let resolvedAttempt: { operation: AuditOperation; resolved: boolean } | undefined;
      if (event.attemptEventHash !== undefined) {
        resolvedAttempt = this.attempts.get(event.attemptEventHash);
        if (!resolvedAttempt) {
          throw new AuditError(
            "attempt_reference_not_found",
            'Audit event "attemptEventHash" does not reference an "attempted" event previously recorded by this AuditLog instance.',
          );
        }
        if (resolvedAttempt.operation !== event.operation) {
          throw new AuditError(
            "attempt_reference_operation_mismatch",
            'Audit event "attemptEventHash" references an attempt recorded for a different operation.',
          );
        }
        if (resolvedAttempt.resolved) {
          throw new AuditError(
            "duplicate_attempt_resolution",
            'Audit event "attemptEventHash" references an attempt that a prior terminal event already resolved.',
          );
        }
      }

      if (this.sink) {
        try {
          await this.sink.append(event);
        } catch (error) {
          throw this.poison("append", error);
        }
      }

      this.lastEvent = event;
      if (event.outcome === "attempted") {
        this.attempts.set(event.eventHash, { operation: event.operation, resolved: false });
      } else if (resolvedAttempt) {
        resolvedAttempt.resolved = true;
      }
      return event;
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Convenience: record the start of an operation with outcome "attempted". */
  recordAttempt(input: Omit<AuditRecordInput, "outcome" | "attemptEventHash" | "error">): Promise<AuditEvent> {
    return this.record({ ...input, outcome: "attempted" });
  }

  /**
   * Convenience: record the terminal outcome of a previously recorded
   * attempt. `attempt` must be an event this same `AuditLog` instance
   * returned from `recordAttempt()`/`record()` with outcome "attempted";
   * `record()` rejects any other value (including an event with a
   * non-"attempted" outcome, or one already resolved by an earlier terminal
   * event) via `attempt_reference_not_found` / `_operation_mismatch` /
   * `duplicate_attempt_resolution`.
   */
  recordOutcome(
    attempt: AuditEvent,
    outcome: "succeeded" | "failed",
    input: Omit<AuditRecordInput, "operation" | "outcome" | "attemptEventHash">,
  ): Promise<AuditEvent> {
    return this.record({ ...input, operation: attempt.operation, outcome, attemptEventHash: attempt.eventHash });
  }

  get head(): AuditEvent | null {
    return this.lastEvent;
  }
}
