# Roadmap

This file gives the release-level direction. See [`BACKLOG.md`](BACKLOG.md) for the detailed execution plan, dependencies, acceptance criteria, release gates, and linked GitHub issues.

## v0.1 — safe Zenodo draft path
- Common deposition model
- Metadata validation
- Zenodo Sandbox default
- Draft creation/update
- File upload
- Publication review
- Operator publication gate

## v0.2 — reproducible, approval-bound publication package
- File manifest (path, size, SHA-256)
- Explicit include/exclude rules
- Canonical metadata + manifest digest
- Human approval bound to exact package digest
- Pre-publication mutation detection
- Append-only audit event log
- Stronger Zenodo mapping and Sandbox end-to-end tests

Epic: #5

## v0.3 — scientific metadata ingestion
- Importer abstraction
- RO-Crate importer
- CITATION.cff importer
- ORW project importer
- ISA Investigation/Study/Assay mapping
- Field-level provenance and conflict reporting
- ORCID, ROR, SPDX/license validation
- DataCite-compatible identifiers and relations

Epic: #11

## v0.4 — repository independence
- Adapter capability model
- Adapter conformance tests
- InvenioRDM adapter
- Dataverse adapter
- Documented mapping/loss semantics across repositories

## v0.5 — distribution and operational maturity
- Release/package distribution
- MCP client onboarding examples
- Containerization
- Structured observability
- Deterministic policy engine
- Safe repository versioning workflows

## Principle

The LLM may help interpret intent. It must not be the authority for metadata validity, package identity, or publication authorization.
