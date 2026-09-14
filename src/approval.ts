import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { z } from "zod";
import {
  canonicalJsonLine,
  normalizeCanonicalString,
  type CanonicalJsonValue,
} from "./canonical-json.js";

export const APPROVAL_REQUEST_SCHEMA_VERSION = "1" as const;
export const APPROVAL_RECEIPT_SCHEMA_VERSION = "1" as const;
export const APPROVAL_METHOD = "operator-ed25519-v1" as const;
export const APPROVAL_SIGNATURE_DOMAIN = "research-deposition-approval-v1\0";

const digestPattern = /^sha256:[a-f0-9]{64}$/u;

const ApprovalRequestSchema = z.object({
  schemaVersion: z.literal(APPROVAL_REQUEST_SCHEMA_VERSION),
  packageDigest: z.string().regex(digestPattern),
  repository: z.string().min(1),
  repositoryTarget: z.string().url(),
  draftId: z.string().min(1),
  policyVersion: z.string().min(1),
});

const ApprovalPayloadSchema = ApprovalRequestSchema.extend({
  approvalMethod: z.literal(APPROVAL_METHOD),
  issuedAt: z.string().min(1),
  expiresAt: z.string().min(1),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,}$/u),
});

const ApprovalReceiptSchema = z.object({
  schemaVersion: z.literal(APPROVAL_RECEIPT_SCHEMA_VERSION),
  keyId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  payload: ApprovalPayloadSchema,
  signature: z.string().min(32),
});

export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export type ApprovalPayload = z.infer<typeof ApprovalPayloadSchema>;
export type ApprovalReceipt = z.infer<typeof ApprovalReceiptSchema>;

export interface ApprovalVerificationIssue {
  code: string;
  message: string;
}

export interface ApprovalVerificationReport {
  valid: boolean;
  issues: ApprovalVerificationIssue[];
  keyId?: string;
}

export interface ApprovalReceiptOptions {
  issuedAt?: Date;
  expiresInSeconds?: number;
  nonce?: string;
}

export interface ApprovalVerificationOptions {
  now?: Date;
  maxAgeSeconds?: number;
  clockSkewSeconds?: number;
}

function nfc(value: string): string {
  return normalizeCanonicalString(value);
}

export function normalizeRepositoryTarget(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url.toString().replace(/\/$/u, "");
}

export function canonicalizeApprovalRequest(input: unknown): ApprovalRequest {
  const parsed = ApprovalRequestSchema.parse(input);
  return {
    schemaVersion: APPROVAL_REQUEST_SCHEMA_VERSION,
    packageDigest: parsed.packageDigest,
    repository: nfc(parsed.repository),
    repositoryTarget: normalizeRepositoryTarget(parsed.repositoryTarget),
    draftId: nfc(parsed.draftId),
    policyVersion: nfc(parsed.policyVersion),
  };
}

export function createApprovalRequest(input: Omit<ApprovalRequest, "schemaVersion">): ApprovalRequest {
  return canonicalizeApprovalRequest({ schemaVersion: APPROVAL_REQUEST_SCHEMA_VERSION, ...input });
}

function signingMaterial(payload: ApprovalPayload): Buffer {
  const canonical = canonicalJsonLine(payload as unknown as CanonicalJsonValue);
  return Buffer.from(`${APPROVAL_SIGNATURE_DOMAIN}${canonical}`, "utf8");
}

export function publicKeyFingerprint(publicKeyPem: string): string {
  const key = createPublicKey(publicKeyPem);
  const der = key.export({ type: "spki", format: "der" });
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

export function generateApprovalKeyPair(): { publicKeyPem: string; privateKeyPem: string; keyId: string } {
  const generated = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    publicKeyPem: generated.publicKey,
    privateKeyPem: generated.privateKey,
    keyId: publicKeyFingerprint(generated.publicKey),
  };
}

export function createApprovalReceipt(
  requestInput: ApprovalRequest,
  privateKeyPem: string,
  options: ApprovalReceiptOptions = {},
): ApprovalReceipt {
  const request = canonicalizeApprovalRequest(requestInput);
  const issuedAt = options.issuedAt ?? new Date();
  const expiresInSeconds = options.expiresInSeconds ?? 900;
  if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds <= 0 || expiresInSeconds > 86400) {
    throw new Error("Approval expiry must be a positive integer no greater than 86400 seconds.");
  }

  const privateKey = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const expiresAt = new Date(issuedAt.getTime() + expiresInSeconds * 1000);

  const payload: ApprovalPayload = {
    ...request,
    approvalMethod: APPROVAL_METHOD,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    nonce: options.nonce ?? randomBytes(18).toString("base64url"),
  };

  const signature = sign(null, signingMaterial(payload), privateKey).toString("base64url");
  return {
    schemaVersion: APPROVAL_RECEIPT_SCHEMA_VERSION,
    keyId: publicKeyFingerprint(publicKeyPem),
    payload,
    signature,
  };
}

function mismatch(issues: ApprovalVerificationIssue[], code: string, message: string): void {
  issues.push({ code, message });
}

export function verifyApprovalReceipt(
  receiptInput: unknown,
  publicKeyPem: string,
  expectedInput: ApprovalRequest,
  options: ApprovalVerificationOptions = {},
): ApprovalVerificationReport {
  const issues: ApprovalVerificationIssue[] = [];
  const parsed = ApprovalReceiptSchema.safeParse(receiptInput);
  if (!parsed.success) {
    return {
      valid: false,
      issues: [{ code: "receipt_schema", message: "Approval receipt does not match schema v1." }],
    };
  }

  const receipt = parsed.data;
  const expected = canonicalizeApprovalRequest(expectedInput);
  const configuredKeyId = publicKeyFingerprint(publicKeyPem);
  if (receipt.keyId !== configuredKeyId) {
    mismatch(issues, "approval_key_mismatch", "Approval receipt was not issued by the configured operator key.");
  }

  let signatureValid = false;
  try {
    signatureValid = verify(
      null,
      signingMaterial(receipt.payload),
      createPublicKey(publicKeyPem),
      Buffer.from(receipt.signature, "base64url"),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    mismatch(issues, "signature_invalid", "Approval receipt signature is invalid.");
    return { valid: false, issues, keyId: configuredKeyId };
  }

  if (receipt.payload.packageDigest !== expected.packageDigest) {
    mismatch(issues, "package_digest_mismatch", "Approved package digest does not match the current package.");
  }
  if (receipt.payload.repository !== expected.repository) {
    mismatch(issues, "repository_mismatch", "Approval targets a different repository adapter.");
  }
  if (normalizeRepositoryTarget(receipt.payload.repositoryTarget) !== expected.repositoryTarget) {
    mismatch(issues, "repository_target_mismatch", "Approval targets a different repository endpoint.");
  }
  if (receipt.payload.draftId !== expected.draftId) {
    mismatch(issues, "draft_mismatch", "Approval targets a different draft identifier.");
  }
  if (receipt.payload.policyVersion !== expected.policyVersion) {
    mismatch(issues, "policy_version_mismatch", "Approval was issued under a different publication policy version.");
  }

  const issuedMs = Date.parse(receipt.payload.issuedAt);
  const expiresMs = Date.parse(receipt.payload.expiresAt);
  if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs) || expiresMs <= issuedMs) {
    mismatch(issues, "invalid_approval_time", "Approval receipt timestamps are invalid.");
  } else {
    const nowMs = (options.now ?? new Date()).getTime();
    const skewMs = (options.clockSkewSeconds ?? 60) * 1000;
    if (issuedMs > nowMs + skewMs) {
      mismatch(issues, "approval_from_future", "Approval receipt was issued too far in the future.");
    }
    if (expiresMs < nowMs - skewMs) {
      mismatch(issues, "approval_expired", "Approval receipt has expired.");
    }
    const maxAgeSeconds = options.maxAgeSeconds ?? 900;
    if (Number.isSafeInteger(maxAgeSeconds) && maxAgeSeconds > 0 && nowMs - issuedMs > maxAgeSeconds * 1000 + skewMs) {
      mismatch(issues, "approval_too_old", "Approval receipt exceeds the configured maximum age.");
    }
  }

  return { valid: issues.length === 0, issues, keyId: configuredKeyId };
}
