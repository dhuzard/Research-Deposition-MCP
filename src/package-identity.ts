import { createHash } from "node:crypto";
import { canonicalize, canonicalStringify } from "./canonical-json.js";
import { buildManifest, type FileManifestEntry, type ManifestIssue, type PackageFileInput } from "./manifest.js";

export { normalizePortablePath } from "./manifest.js";
export type { PathNormalizationResult, PathNormalizationSuccess, PathNormalizationFailure } from "./manifest.js";

const DIGEST_DOMAIN = "research-deposition-mcp/package-digest/v1";

/**
 * Computes a stable, repository-independent digest over a package's
 * schema version, metadata, and file manifest. The digest changes if the
 * metadata or the selected files (or their content) change, and is
 * independent of key ordering, whitespace, or the local filesystem root.
 */
export function computePackageDigest(schemaVersion: string, metadata: unknown, manifest: readonly FileManifestEntry[]): string {
  const payload = {
    domain: DIGEST_DOMAIN,
    schemaVersion,
    metadata: canonicalize(metadata),
    manifest: canonicalize(manifest),
  };
  const hex = createHash("sha256").update(canonicalStringify(payload), "utf8").digest("hex");
  return `sha256:${hex}`;
}

export interface AssembledPackage {
  ok: true;
  manifest: FileManifestEntry[];
  digest: string;
}

export interface AssemblePackageFailure {
  ok: false;
  issues: ManifestIssue[];
}

export type AssemblePackageResult = AssembledPackage | AssemblePackageFailure;

/**
 * Builds the file manifest for a package (never touching any repository or
 * token) and, if every file is safe to include, computes its digest over
 * the canonical metadata and canonical manifest.
 */
export async function assemblePackage(
  rootDir: string,
  schemaVersion: string,
  metadata: unknown,
  files: readonly PackageFileInput[],
): Promise<AssemblePackageResult> {
  const manifestResult = await buildManifest(rootDir, files);
  if (!manifestResult.ok) {
    return { ok: false, issues: manifestResult.issues };
  }
  const digest = computePackageDigest(schemaVersion, metadata, manifestResult.manifest);
  return { ok: true, manifest: manifestResult.manifest, digest };
}
