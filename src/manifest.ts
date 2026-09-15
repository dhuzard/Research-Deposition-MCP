import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface PathNormalizationSuccess {
  ok: true;
  value: string;
}

export interface PathNormalizationFailure {
  ok: false;
  code: string;
  message: string;
}

export type PathNormalizationResult = PathNormalizationSuccess | PathNormalizationFailure;

function fail(code: string, message: string): PathNormalizationFailure {
  return { ok: false, code, message };
}

const WINDOWS_DRIVE_RE = /^[a-zA-Z]:/;

/**
 * Normalizes a portable, repository-independent relative file path.
 *
 * Rejects anything that could escape a package root or behave differently
 * across operating systems: absolute paths (POSIX or Windows), Windows
 * drive-letter paths, UNC paths, and any ".." traversal segment. Repeated
 * separators and "." segments are collapsed. The result is NFC-normalized
 * and uses "/" as the only separator.
 */
export function normalizePortablePath(raw: string): PathNormalizationResult {
  if (typeof raw !== "string" || raw.length === 0) {
    return fail("empty_path", "Path must be a non-empty string.");
  }
  if (raw.includes("\0")) {
    return fail("nul_byte", "Path must not contain NUL bytes.");
  }

  const normalized = raw.normalize("NFC");

  if (normalized.startsWith("\\\\") || normalized.startsWith("//")) {
    return fail("unc_path", "UNC paths are not permitted.");
  }
  if (WINDOWS_DRIVE_RE.test(normalized)) {
    return fail("windows_absolute", "Windows drive-letter absolute paths are not permitted.");
  }
  if (normalized.startsWith("/") || normalized.startsWith("\\")) {
    return fail("absolute_path", "Absolute paths are not permitted.");
  }
  if (normalized.includes("\\")) {
    return fail("backslash_separator", "Backslash path separators are not permitted; use POSIX-style forward slashes.");
  }

  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      return fail("path_traversal", "Path segments of '..' are not permitted.");
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    return fail("empty_path", "Path must resolve to at least one path segment.");
  }

  return { ok: true, value: segments.join("/") };
}

export interface PackageFileInput {
  sourcePath: string;
  depositName: string;
}

export interface FileManifestEntry {
  sourcePath: string;
  depositName: string;
  size: number;
  sha256: string;
}

export interface ManifestIssue {
  code: string;
  message: string;
  sourcePath?: string;
  depositName?: string;
}

export interface ManifestSuccess {
  ok: true;
  manifest: FileManifestEntry[];
  issues: [];
}

export interface ManifestFailure {
  ok: false;
  manifest: [];
  issues: ManifestIssue[];
}

export type ManifestResult = ManifestSuccess | ManifestFailure;

async function hashFile(absPath: string): Promise<{ size: number; sha256: string }> {
  const hash = createHash("sha256");
  let size = 0;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(absPath);
    stream.on("data", (chunk: string | Buffer) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      hash.update(buf);
    });
    stream.on("error", rejectPromise);
    stream.on("end", () => resolvePromise());
  });
  return { size, sha256: hash.digest("hex") };
}

/**
 * Builds a deterministic file manifest for a package: normalized source
 * path, deposit-side name, size, and SHA-256 digest, sorted by deposit
 * name then source path. Performs no repository network access and uses
 * no credentials.
 *
 * Rejects (as issues, never throwing): absolute or traversal-unsafe paths,
 * duplicate normalized source paths or deposit names, missing files,
 * non-regular files (directories, sockets, etc.), and symlinks (final or
 * intermediate path components). If any issue is found, the manifest is
 * empty; callers should surface `issues` to the caller instead of a
 * partial manifest.
 */
export async function buildManifest(rootDir: string, files: readonly PackageFileInput[]): Promise<ManifestResult> {
  const issues: ManifestIssue[] = [];
  const resolvedRoot = resolve(rootDir);

  const normalizedEntries: { sourcePath: string; depositName: string }[] = [];
  const seenSource = new Set<string>();
  const seenDeposit = new Set<string>();

  for (const file of files) {
    const sourceResult = normalizePortablePath(file.sourcePath);
    if (!sourceResult.ok) {
      issues.push({
        code: `source_${sourceResult.code}`,
        message: `Invalid sourcePath "${file.sourcePath}": ${sourceResult.message}`,
        sourcePath: file.sourcePath,
      });
      continue;
    }
    const depositResult = normalizePortablePath(file.depositName);
    if (!depositResult.ok) {
      issues.push({
        code: `deposit_${depositResult.code}`,
        message: `Invalid depositName "${file.depositName}": ${depositResult.message}`,
        depositName: file.depositName,
      });
      continue;
    }
    if (seenSource.has(sourceResult.value)) {
      issues.push({
        code: "duplicate_source_path",
        message: `Duplicate normalized sourcePath: ${sourceResult.value}`,
        sourcePath: sourceResult.value,
      });
      continue;
    }
    if (seenDeposit.has(depositResult.value)) {
      issues.push({
        code: "duplicate_deposit_name",
        message: `Duplicate normalized depositName: ${depositResult.value}`,
        depositName: depositResult.value,
      });
      continue;
    }
    seenSource.add(sourceResult.value);
    seenDeposit.add(depositResult.value);
    normalizedEntries.push({ sourcePath: sourceResult.value, depositName: depositResult.value });
  }

  if (issues.length > 0) {
    return { ok: false, manifest: [], issues };
  }

  const entries: FileManifestEntry[] = [];

  for (const entry of normalizedEntries) {
    const absPath = resolve(resolvedRoot, entry.sourcePath);
    const rootRelativePath = relative(resolvedRoot, absPath);
    if (rootRelativePath === "" || rootRelativePath === ".." || rootRelativePath.startsWith(`..${sep}`) || isAbsolute(rootRelativePath)) {
      issues.push({
        code: "path_escapes_root",
        message: `sourcePath resolves outside the package root: ${entry.sourcePath}`,
        sourcePath: entry.sourcePath,
      });
      continue;
    }

    let before;
    try {
      before = await lstat(absPath);
    } catch {
      issues.push({ code: "missing_file", message: `File not found: ${entry.sourcePath}`, sourcePath: entry.sourcePath });
      continue;
    }

    if (before.isSymbolicLink()) {
      issues.push({ code: "symlink_rejected", message: `Symlinks are not permitted: ${entry.sourcePath}`, sourcePath: entry.sourcePath });
      continue;
    }
    if (!before.isFile()) {
      issues.push({ code: "not_a_regular_file", message: `Not a regular file: ${entry.sourcePath}`, sourcePath: entry.sourcePath });
      continue;
    }

    // Guards against symlinked intermediate directories: if any ancestor
    // component is a symlink, the real path will differ from absPath.
    let real: string;
    try {
      real = await realpath(absPath);
    } catch {
      issues.push({ code: "missing_file", message: `File not found: ${entry.sourcePath}`, sourcePath: entry.sourcePath });
      continue;
    }
    if (resolve(real) !== absPath) {
      issues.push({ code: "symlink_rejected", message: `Path contains a symlinked component: ${entry.sourcePath}`, sourcePath: entry.sourcePath });
      continue;
    }

    let hashed: { size: number; sha256: string };
    try {
      hashed = await hashFile(absPath);
    } catch {
      issues.push({ code: "read_error", message: `Failed to read file: ${entry.sourcePath}`, sourcePath: entry.sourcePath });
      continue;
    }

    let after;
    try {
      after = await lstat(absPath);
    } catch {
      issues.push({ code: "file_changed", message: `File disappeared while hashing: ${entry.sourcePath}`, sourcePath: entry.sourcePath });
      continue;
    }
    if (after.isSymbolicLink() || !after.isFile() || after.size !== hashed.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
      issues.push({ code: "file_changed", message: `File changed while hashing: ${entry.sourcePath}`, sourcePath: entry.sourcePath });
      continue;
    }

    entries.push({ sourcePath: entry.sourcePath, depositName: entry.depositName, size: hashed.size, sha256: hashed.sha256 });
  }

  if (issues.length > 0) {
    return { ok: false, manifest: [], issues };
  }

  entries.sort((a, b) => {
    if (a.depositName !== b.depositName) return a.depositName < b.depositName ? -1 : 1;
    return a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0;
  });

  return { ok: true, manifest: entries, issues: [] };
}
