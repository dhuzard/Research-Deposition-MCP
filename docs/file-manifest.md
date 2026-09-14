# File manifest contract

The file manifest is the repository-independent description of the exact files selected for deposition. It is intended to become part of the publication identity in v0.2.

## Core rule

Local filesystem locations are operational inputs only. Absolute paths are never serialized into the manifest.

Each manifest entry records:

- `sourcePath` — POSIX-normalized path relative to the declared local root;
- `depositPath` — POSIX-normalized path/name that should be used by the target repository;
- `size` — file size in bytes;
- `sha256` — lowercase SHA-256 digest of file content;
- `mediaType` — optional inferred media type for a small set of common extensions.

This distinction allows a local file such as:

```text
analysis/final_table.csv
```

to be deposited deliberately as:

```text
data/behavior-summary.csv
```

without embedding `/home/user/project/...` or another machine-specific path in the publication contract.

## Explicit selection rules

`buildFileManifest(rootDir, rules)` requires at least one `include` rule. Directory walking alone never implies publication intent.

Example:

```ts
const manifest = await buildFileManifest("./project", {
  include: ["data/**", "README.md"],
  exclude: ["data/intermediate/**"],
  destinations: {
    "README.md": "documentation/README.md",
  },
});
```

Exclusion rules always take precedence over inclusion rules.

The supported glob subset is deliberately small:

- `*` — zero or more characters except `/`;
- `?` — one character except `/`;
- `**` — zero or more path segments/characters, including `/`.

Examples:

```text
*.csv
**/*.csv
data/**
results/**/summary?.json
```

Character classes (`[abc]`) and brace expansion (`{csv,tsv}`) are not supported in manifest schema v1. Keeping the matcher small makes the selection semantics easier to audit and reproduce independently.

## Path safety

All manifest and rule paths are normalized to POSIX `/` separators.

The following are rejected:

- absolute POSIX paths;
- Windows drive-absolute paths;
- UNC-style paths;
- any explicit `..` path segment;
- NUL bytes;
- duplicate normalized source paths;
- duplicate normalized `depositPath` values.

Destination mappings are exact source-path mappings. A destination mapping that refers to a file not selected by the include/exclude rules is rejected rather than silently ignored.

## Symbolic links

Manifest schema v1 uses a deliberately strict policy: **symbolic links are rejected and never followed**.

The root itself may not be a symbolic link, and any symbolic link encountered below the traversed root causes manifest construction to fail. This prevents a selection from silently escaping the declared root or changing meaning depending on host filesystem layout.

A later schema version may introduce an explicit, independently reviewable symlink policy, but following links implicitly is not permitted.

## Determinism

Before serialization:

1. paths are normalized;
2. entries are validated;
3. entries are sorted by `depositPath`, then `sourcePath` using code-unit ordering;
4. duplicate normalized paths are rejected;
5. JSON object field order is fixed by the serializer.

`serializeManifest()` returns byte-stable JSON with a trailing newline. The same files, selection rules, destination mappings, and schema version therefore produce the same canonical output across runs and machines.

Changes to selected file content, selected file names, selected membership, or deposition names change the canonical manifest. Changes to excluded files do not.

## File mutation while hashing

Files are checked before and after streaming SHA-256 computation. If file size or modification time changes during hashing, manifest construction fails with `file_changed_during_hash` rather than returning a potentially inconsistent record.

This is a guard against ordinary concurrent modification. It is not yet a complete hostile-filesystem threat model; stronger immutable-package handling belongs to the broader v0.2 publication-integrity work.

## MCP tool

The `build_file_manifest` MCP tool exposes the same core implementation:

```json
{
  "rootDir": "/path/to/project",
  "include": ["data/**", "README.md"],
  "exclude": ["data/intermediate/**"],
  "destinations": {
    "README.md": "documentation/README.md"
  }
}
```

It returns both the parsed manifest and its canonical serialized representation. It does not upload or publish anything.
