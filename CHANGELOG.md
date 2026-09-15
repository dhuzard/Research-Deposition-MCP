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
- Canonical metadata serialization with explicit semantic ordering rules.
- Versioned publication package combining canonical metadata and the file manifest.
- Domain-separated SHA-256 publication package digest with golden compatibility fixture.
- `build_publication_package` MCP tool.
- Ed25519 operator approval key generation and interactive signing CLI.
- Short-lived signed approval receipts bound to package digest, repository adapter, endpoint, draft ID, and publication-policy version.
- Pre-publication package re-computation and receipt verification.
- Package identity and approval-protocol documentation.
- Repository-independent, append-only audit event schema (v1) with a domain-separated SHA-256 hash chain covering validation, manifest/digest generation, draft and file operations, approval lifecycle, and publication.
- `AuditLog` application-level recorder with serialized concurrent `record()` calls and an `AuditFileSink` NDJSON persistence layer that validates and refuses to resume a tampered log.
- Audit event documentation, including tamper-evidence limits.

### Changed

- `publication_review` now emits the exact package identity and approval request rather than a self-generatable confirmation phrase.
- `publish_draft` now requires a valid operator-signed receipt in addition to process-level publication enablement.

### Planned

- Wiring the audit event log into MCP tool handlers and provenance-aware log sinks (signed/externally anchored logs).
- Stronger Zenodo metadata coverage, remote package verification, and Sandbox E2E tests.
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
