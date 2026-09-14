import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

export const FILE_MANIFEST_SCHEMA_VERSION = "1" as const;

export interface FileManifestEntry {
  /** POSIX-normalized path relative to the declared local root. */
  sourcePath: string;
  /** POSIX-normalized path/name to use in the target repository. */
  depositPath: string;
  size: number;
  sha256: string;
  mediaType?: string;
}

export interface FileManifest {
  schemaVersion: typeof FILE_MANIFEST_SCHEMA_VERSION;
  entries: FileManifestEntry[];
}

export interface FileSelectionRules {
  /** Explicit repository-relative glob patterns. At least one is required. */
  include: string[];
  /** Exclusion globs take precedence over inclusion globs. */
  exclude?: string[];
  /** Optional exact source-path to repository-path renames. */
  destinations?: Record<string, string>;
}

export class ManifestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly manifestPath?: string,
  ) {
    super(message);
    this.name = "ManifestError";
  }
}

const MEDIA_TYPES: Record<string, string> = {
  ".csv": "text/csv",
  ".json": "application/json",
  ".jsonld": "application/ld+json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".zip": "application/zip",
};

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeSlashes(value: string): string {
  // NFC avoids machine/filesystem-dependent composed-vs-decomposed Unicode
  // representations changing the canonical manifest.
  return value.replaceAll("\\", "/").normalize("NFC");
}

function hasTraversalSegment(value: string): boolean {
  return normalizeSlashes(value).split("/").some((part) => part === "..");
}

function looksAbsolute(value: string): boolean {
  const normalized = normalizeSlashes(value);
  return path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//u.test(normalized) || normalized.startsWith("//");
}

/**
 * Normalize a path that must remain relative to the declared publication root.
 * Any explicit `..` segment is rejected rather than silently normalized away.
 */
export function normalizeManifestPath(value: string, label = "path"): string {
  if (value.length === 0) {
    throw new ManifestError("empty_path", `${label} must not be empty.`);
  }
  if (value.includes("\0")) {
    throw new ManifestError("invalid_path", `${label} contains a NUL byte.`, value);
  }
  if (looksAbsolute(value)) {
    throw new ManifestError("absolute_path", `${label} must be relative to the declared root.`, value);
  }
  if (hasTraversalSegment(value)) {
    throw new ManifestError("path_traversal", `${label} must not contain '..' path segments.`, value);
  }

  let normalized = path.posix.normalize(normalizeSlashes(value));
  while (normalized.startsWith("./")) normalized = normalized.slice(2);

  if (normalized === "." || normalized === "") {
    throw new ManifestError("empty_path", `${label} must resolve to a file path.`, value);
  }
  if (normalized.startsWith("../") || normalized === "..") {
    throw new ManifestError("path_traversal", `${label} escapes the declared root.`, value);
  }
  return normalized;
}

function normalizePattern(value: string, label: string): string {
  // The same path-safety rules apply to patterns. Wildcards are path-segment
  // syntax, not an exception to the root boundary.
  return normalizeManifestPath(value, label);
}

/**
 * Supported glob subset: `*`, `?`, and `**`. Character classes and brace
 * expansion are deliberately not supported so matching remains small and
 * independently auditable.
 */
function globToRegExp(pattern: string): RegExp {
  let source = "^";

  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];

    if (char === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    source += char.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
  }

  source += "$";
  return new RegExp(source, "u");
}

function compilePatterns(patterns: string[], label: string): RegExp[] {
  return patterns.map((pattern, index) => globToRegExp(normalizePattern(pattern, `${label}[${index}]`)));
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

async function walkFiles(rootDir: string): Promise<string[]> {
  const rootStat = await lstat(rootDir).catch((error: NodeJS.ErrnoException) => {
    throw new ManifestError("root_unavailable", `Cannot inspect manifest root: ${error.message}`, rootDir);
  });

  if (rootStat.isSymbolicLink()) {
    throw new ManifestError("symlink_rejected", "The manifest root must not be a symbolic link.", rootDir);
  }
  if (!rootStat.isDirectory()) {
    throw new ManifestError("root_not_directory", "The manifest root must be a directory.", rootDir);
  }

  const files: string[] = [];

  async function walk(absoluteDir: string, relativeDir: string): Promise<void> {
    const entries = await readdir(absoluteDir, { withFileTypes: true });
    entries.sort((a, b) => compareCodeUnits(a.name, b.name));

    for (const entry of entries) {
      const relative = normalizeManifestPath(
        relativeDir ? `${relativeDir}/${entry.name}` : entry.name,
        "filesystem path",
      );
      const absolute = path.join(absoluteDir, entry.name);

      if (entry.isSymbolicLink()) {
        throw new ManifestError(
          "symlink_rejected",
          "Symbolic links are not allowed anywhere under a manifest root in schema v1.",
          relative,
        );
      }
      if (entry.isDirectory()) {
        await walk(absolute, relative);
        continue;
      }
      if (entry.isFile()) {
        files.push(relative);
        continue;
      }

      throw new ManifestError(
        "unsupported_file_type",
        "Only regular files and directories are allowed under a manifest root in schema v1.",
        relative,
      );
    }
  }

  await walk(rootDir, "");
  return files;
}

async function sha256File(filePath: string): Promise<{ sha256: string; size: number }> {
  const before = await lstat(filePath);
  if (before.isSymbolicLink()) {
    throw new ManifestError("symlink_rejected", "Selected files must not be symbolic links.", filePath);
  }
  if (!before.isFile()) {
    throw new ManifestError("not_regular_file", "Selected manifest entries must be regular files.", filePath);
  }

  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });

  const after = await lstat(filePath);
  if (!after.isFile() || after.isSymbolicLink()) {
    throw new ManifestError("file_changed_during_hash", "File type changed while hashing.", filePath);
  }
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new ManifestError("file_changed_during_hash", "File changed while its manifest hash was being computed.", filePath);
  }

  return { sha256: hash.digest("hex"), size: after.size };
}

function mediaTypeFor(filePath: string): string | undefined {
  return MEDIA_TYPES[path.posix.extname(filePath).toLowerCase()];
}

function canonicalEntry(entry: FileManifestEntry): FileManifestEntry {
  const sourcePath = normalizeManifestPath(entry.sourcePath, "manifest sourcePath");
  const depositPath = normalizeManifestPath(entry.depositPath, "manifest depositPath");

  if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
    throw new ManifestError("invalid_size", `Invalid byte size for ${sourcePath}.`, sourcePath);
  }
  if (!/^[a-f0-9]{64}$/u.test(entry.sha256)) {
    throw new ManifestError("invalid_sha256", `Invalid SHA-256 digest for ${sourcePath}.`, sourcePath);
  }

  return {
    sourcePath,
    depositPath,
    size: entry.size,
    sha256: entry.sha256,
    ...(entry.mediaType ? { mediaType: entry.mediaType } : {}),
  };
}

/** Validate, normalize, and deterministically order a manifest. */
export function canonicalizeManifest(manifest: FileManifest): FileManifest {
  if (manifest.schemaVersion !== FILE_MANIFEST_SCHEMA_VERSION) {
    throw new ManifestError("unsupported_manifest_schema", `Unsupported file manifest schema: ${manifest.schemaVersion}`);
  }

  const entries = manifest.entries.map(canonicalEntry);
  entries.sort((a, b) => compareCodeUnits(a.depositPath, b.depositPath) || compareCodeUnits(a.sourcePath, b.sourcePath));

  const sources = new Set<string>();
  const destinations = new Set<string>();
  for (const entry of entries) {
    if (sources.has(entry.sourcePath)) {
      throw new ManifestError("duplicate_source_path", `Duplicate normalized source path: ${entry.sourcePath}`, entry.sourcePath);
    }
    if (destinations.has(entry.depositPath)) {
      throw new ManifestError("duplicate_deposit_path", `Duplicate normalized deposit path: ${entry.depositPath}`, entry.depositPath);
    }
    sources.add(entry.sourcePath);
    destinations.add(entry.depositPath);
  }

  return { schemaVersion: FILE_MANIFEST_SCHEMA_VERSION, entries };
}

/** Byte-stable JSON representation used by the next publication-digest layer. */
export function serializeManifest(manifest: FileManifest): string {
  return `${JSON.stringify(canonicalizeManifest(manifest))}\n`;
}

/**
 * Build the repository-independent file manifest for an explicit selection.
 *
 * Absolute local paths are operational inputs only; they are never serialized
 * into the manifest. `exclude` always wins over `include`.
 */
export async function buildFileManifest(rootDir: string, rules: FileSelectionRules): Promise<FileManifest> {
  if (rules.include.length === 0) {
    throw new ManifestError("missing_include_rules", "At least one explicit include pattern is required.");
  }

  const absoluteRoot = path.resolve(rootDir);
  const include = compilePatterns(rules.include, "include");
  const exclude = compilePatterns(rules.exclude ?? [], "exclude");

  const destinationMap = new Map<string, string>();
  for (const [source, destination] of Object.entries(rules.destinations ?? {})) {
    const normalizedSource = normalizeManifestPath(source, "destination source");
    const normalizedDestination = normalizeManifestPath(destination, "destination path");
    if (destinationMap.has(normalizedSource)) {
      throw new ManifestError("duplicate_source_path", `Duplicate normalized destination source: ${normalizedSource}`, normalizedSource);
    }
    destinationMap.set(normalizedSource, normalizedDestination);
  }

  const discovered = await walkFiles(absoluteRoot);
  const selected = discovered.filter((candidate) => matchesAny(candidate, include) && !matchesAny(candidate, exclude));
  selected.sort(compareCodeUnits);
  const selectedSet = new Set(selected);

  for (const source of destinationMap.keys()) {
    if (!selectedSet.has(source)) {
      throw new ManifestError(
        "destination_source_not_selected",
        `Destination mapping refers to a file that is not selected: ${source}`,
        source,
      );
    }
  }

  const entries: FileManifestEntry[] = [];
  for (const sourcePath of selected) {
    const absolutePath = path.resolve(absoluteRoot, ...sourcePath.split("/"));
    const relativeCheck = path.relative(absoluteRoot, absolutePath);
    if (relativeCheck === ".." || relativeCheck.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCheck)) {
      throw new ManifestError("path_traversal", `Selected file escapes the declared root: ${sourcePath}`, sourcePath);
    }

    const { sha256, size } = await sha256File(absolutePath);
    const depositPath = destinationMap.get(sourcePath) ?? sourcePath;
    const mediaType = mediaTypeFor(depositPath);
    entries.push({
      sourcePath,
      depositPath,
      size,
      sha256,
      ...(mediaType ? { mediaType } : {}),
    });
  }

  return canonicalizeManifest({ schemaVersion: FILE_MANIFEST_SCHEMA_VERSION, entries });
}
