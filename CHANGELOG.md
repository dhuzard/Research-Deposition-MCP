# Changelog

All notable changes to this project will be documented here.

The project follows semantic versioning once stable public releases begin. During early `0.x` development, minor versions may include breaking changes when clearly documented.

## [Unreleased]

### Added

- Deterministic file selection with explicit include/exclude rules.
- Repository-independent file manifest with normalized source/deposit paths, byte size, SHA-256, and optional media type.
- Canonical byte-stable manifest serialization.
- Strict rejection of symlinks, absolute paths, traversal paths, and normalized path collisions.
- `build_file_manifest` MCP tool.
- File-manifest contract documentation and tests for empty, binary, Unicode, nested, excluded, renamed, added, removed, and symlinked files.

### Planned

- Immutable metadata + file-manifest digest before publication approval.
- Audit/provenance event log.
- Stronger Zenodo metadata coverage and tests.
- Metadata-source adapters for RO-Crate, CITATION.cff, ISA, and ORW.

## [0.1.0] - 2026-09-14

### Added

- Repository-independent research-deposit model.
- Deterministic validation with warnings.
- Zenodo deposition adapter.
- Zenodo Sandbox default configuration.
- Draft create/read/update tools.
- Local file upload tool with configurable maximum size.
- Publication review tool.
- Publication disabled by default and gated by an explicit confirmation phrase when enabled.
