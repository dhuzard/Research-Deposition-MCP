import test from "node:test";
import assert from "node:assert/strict";
import {
  createApprovalReceipt,
  createApprovalRequest,
  generateApprovalKeyPair,
  verifyApprovalReceipt,
} from "../src/approval.js";

const ISSUED = new Date("2026-09-14T18:00:00.000Z");
const NOW = new Date("2026-09-14T18:05:00.000Z");

function request(overrides: Partial<ReturnType<typeof createApprovalRequest>> = {}) {
  return createApprovalRequest({
    packageDigest: `sha256:${"a".repeat(64)}`,
    repository: "zenodo",
    repositoryTarget: "https://sandbox.zenodo.org/",
    draftId: "12345",
    policyVersion: "1",
    ...overrides,
  });
}

test("signed approval verifies deterministically for the exact target and package", () => {
  const pair = generateApprovalKeyPair();
  const req = request();
  const receipt = createApprovalReceipt(req, pair.privateKeyPem, {
    issuedAt: ISSUED,
    expiresInSeconds: 900,
    nonce: "fixed-nonce-for-test-123",
  });
  const sameReceipt = createApprovalReceipt(req, pair.privateKeyPem, {
    issuedAt: ISSUED,
    expiresInSeconds: 900,
    nonce: "fixed-nonce-for-test-123",
  });

  assert.deepEqual(receipt, sameReceipt);
  const first = verifyApprovalReceipt(receipt, pair.publicKeyPem, req, { now: NOW, maxAgeSeconds: 900 });
  const second = verifyApprovalReceipt(receipt, pair.publicKeyPem, req, { now: NOW, maxAgeSeconds: 900 });
  assert.deepEqual(first, second);
  assert.equal(first.valid, true);
  assert.deepEqual(first.issues, []);
});

test("metadata/package mutation invalidates approval through digest mismatch", () => {
  const pair = generateApprovalKeyPair();
  const req = request();
  const receipt = createApprovalReceipt(req, pair.privateKeyPem, { issuedAt: ISSUED, nonce: "fixed-nonce-for-test-123" });
  const expected = request({ packageDigest: `sha256:${"b".repeat(64)}` });
  const report = verifyApprovalReceipt(receipt, pair.publicKeyPem, expected, { now: NOW });
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((issue) => issue.code === "package_digest_mismatch"));
});

test("changing draft, repository, endpoint, or policy invalidates approval", () => {
  const pair = generateApprovalKeyPair();
  const req = request();
  const receipt = createApprovalReceipt(req, pair.privateKeyPem, { issuedAt: ISSUED, nonce: "fixed-nonce-for-test-123" });

  const cases = [
    [request({ draftId: "other" }), "draft_mismatch"],
    [request({ repository: "dataverse" }), "repository_mismatch"],
    [request({ repositoryTarget: "https://zenodo.org" }), "repository_target_mismatch"],
    [request({ policyVersion: "2" }), "policy_version_mismatch"],
  ] as const;

  for (const [expected, code] of cases) {
    const report = verifyApprovalReceipt(receipt, pair.publicKeyPem, expected, { now: NOW });
    assert.equal(report.valid, false);
    assert.ok(report.issues.some((issue) => issue.code === code));
  }
});

test("wrong operator key and tampering are rejected", () => {
  const pair = generateApprovalKeyPair();
  const other = generateApprovalKeyPair();
  const req = request();
  const receipt = createApprovalReceipt(req, pair.privateKeyPem, { issuedAt: ISSUED, nonce: "fixed-nonce-for-test-123" });

  const wrongKey = verifyApprovalReceipt(receipt, other.publicKeyPem, req, { now: NOW });
  assert.equal(wrongKey.valid, false);
  assert.ok(wrongKey.issues.some((issue) => issue.code === "approval_key_mismatch" || issue.code === "signature_invalid"));

  const tampered = structuredClone(receipt);
  tampered.payload.draftId = "999";
  const report = verifyApprovalReceipt(tampered, pair.publicKeyPem, req, { now: NOW });
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((issue) => issue.code === "signature_invalid"));
});

test("expired and over-age approvals are rejected", () => {
  const pair = generateApprovalKeyPair();
  const req = request();
  const short = createApprovalReceipt(req, pair.privateKeyPem, {
    issuedAt: ISSUED,
    expiresInSeconds: 60,
    nonce: "fixed-nonce-for-test-123",
  });
  const expired = verifyApprovalReceipt(short, pair.publicKeyPem, req, { now: NOW, clockSkewSeconds: 0 });
  assert.equal(expired.valid, false);
  assert.ok(expired.issues.some((issue) => issue.code === "approval_expired"));

  const longer = createApprovalReceipt(req, pair.privateKeyPem, {
    issuedAt: ISSUED,
    expiresInSeconds: 900,
    nonce: "fixed-nonce-for-test-123",
  });
  const tooOld = verifyApprovalReceipt(longer, pair.publicKeyPem, req, {
    now: new Date("2026-09-14T18:10:01.000Z"),
    maxAgeSeconds: 600,
    clockSkewSeconds: 0,
  });
  assert.equal(tooOld.valid, false);
  assert.ok(tooOld.issues.some((issue) => issue.code === "approval_too_old"));
});
