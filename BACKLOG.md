# Implementation Backlog

This backlog turns the high-level roadmap into an execution plan. It is intentionally more detailed than `ROADMAP.md` and is the source of truth for sequencing, dependencies, acceptance criteria, and release readiness.

The project principle remains unchanged:

> The LLM may help interpret intent. Deterministic software must validate metadata and package identity. A human must authorize irreversible publication.

## Current baseline — v0.1

Implemented and CI-tested:

- common `ResearchDeposit` model
- deterministic metadata validation
- repository adapter interface
- Zenodo adapter
- Zenodo Sandbox as the default target
- create/read/update draft operations
- file upload
- publication review
- operator-level publication enable flag
- explicit `PUBLISH <draft-id>` confirmation
- unit tests and CI across supported Node versions

The main limitation of v0.1 is that approval is bound only to a draft identifier. It is not yet bound cryptographically to the exact metadata and files reviewed by the researcher.

---

# v0.2 — Publication integrity

**Primary objective:** make the scientific object approved by a human identical to the object that can be published.

Epic: #5

Recommended implementation order:

1. #6 deterministic file selection and manifest
2. #7 canonical metadata serialization and package digest
3. #8 human approval receipt bound to the digest
4. #9 audit event model — can proceed partly in parallel
5. #10 stronger Zenodo mapping and Sandbox end-to-end verification

## A. Package construction — P0

Issue: #6

### A1. File manifest model

- Define `FileManifestEntry`.
- Minimum fields: normalized relative path, byte size, SHA-256.
- Consider optional media type and deposited filename.
- Do not include absolute machine-specific paths in package identity.
- Define schema version from the first implementation.

### A2. Deterministic file discovery

- Add explicit publication root.
- Add include rules.
- Add exclude rules.
- Define precedence between include and exclude rules.
- Sort normalized paths before canonical serialization.
- Reject path traversal beyond the publication root.
- Reject duplicate normalized paths.
- Decide and document symlink policy; initial default should be reject.

### A3. Hashing

- Stream files rather than loading entire files into memory.
- SHA-256 for v0.2.
- Produce stable errors for unreadable/missing files.
- Re-hash immediately before final publication authorization check.

### A4. Tests

Cover:

- binary files
- empty files
- large-file streaming behavior
- Unicode filenames
- nested directories
- duplicate paths after normalization
- modified file contents
- include/exclude behavior
- symlink rejection

### Exit condition

The same selected local package produces byte-identical canonical manifest output on repeated runs under supported platforms.

---

## B. Package identity — P0

Issue: #7

### B1. Canonical metadata representation

- Define exactly which `ResearchDeposit` fields contribute to package identity.
- Separate scientific/deposition metadata from runtime state.
- Define absent vs `null` vs empty-value semantics.
- Sort unordered collections where semantically valid.
- Preserve ordering where order is scientifically meaningful.
- Version the canonicalization algorithm.

### B2. Publication package envelope

Introduce a stable envelope concept such as:

```text
PublicationPackage
├── schema_version
├── metadata
├── file_manifest
├── target_repository_class
└── canonicalization_version
```

Do not include credentials, local absolute paths, timestamps generated only for transport, or repository API response noise in the package identity.

### B3. Digest

- SHA-256 over the canonical package envelope.
- Prefix or annotate digest with algorithm/version.
- Expose canonical form for debugging and independent verification.
- Add golden fixtures to detect accidental serialization drift.

### Exit condition

Any scientifically relevant metadata or selected-file mutation changes the package digest; irrelevant runtime details do not.

---

## C. Authorization boundary — P0

Issue: #8

### C1. Approval receipt

Define an `ApprovalReceipt` containing at least:

- package digest
- repository adapter / target class
- draft identifier
- approval timestamp
- approval method/version
- optional actor descriptor

### C2. Human approval operation

- Separate `prepare/review` from `approve` and `publish`.
- The approval operation must display or return the package digest and concise package summary.
- Never treat an LLM-generated confirmation string alone as proof of human authorization.
- Keep process-level publication disabled unless explicitly enabled.

### C3. Pre-publication revalidation

Immediately before publication:

- regenerate manifest
- regenerate package digest
- compare with approval receipt
- verify target draft/repository
- verify approval receipt state
- fail closed on mismatch

### C4. Invalidation

Invalidate authorization when any of the following change:

- scientific metadata
- selected files
- file content
- relevant filenames
- repository target
- draft identity
- canonicalization/policy version

### Exit condition

An unchanged approved package can publish; any relevant mutation after approval blocks publication deterministically.

---

## D. Auditability — P0/P1

Issue: #9

### D1. Versioned audit events

Define an append-only `AuditEvent` model for:

- validation
- manifest generation
- digest generation
- draft creation/update
- upload/remove
- approval issuance/invalidation
- publication attempt/success/failure
- version creation later

### D2. Safe logging

Never log:

- access tokens
- authorization headers
- raw secrets
- unnecessary sensitive metadata payloads

Prefer safe identifiers, digests, event types, normalized error classes, and summaries.

### D3. Persistence

v0.2 minimum:

- newline-delimited JSON sink
- stdout/file sink abstraction
- testable ordering and timestamps

Later versions may add signed logs or external provenance stores; do not claim tamper-proof auditability in v0.2.

### Exit condition

A deposition can be reconstructed at the operation level without exposing repository credentials.

---

## E. Zenodo as reference adapter — P0

Issue: #10

### E1. Mapping audit

Document common model → Zenodo mapping for:

- title
- resource/upload type
- description
- creators
- ORCID
- contributors where represented
- keywords
- license
- version
- related identifiers
- dates where supported
- access rights

Explicitly document:

- lossy mappings
- unsupported fields
- repository-specific extensions

### E2. Error normalization

Create stable error categories for:

- authentication/authorization
- common-model validation
- Zenodo schema rejection
- upload failure
- network/transient errors
- conflict/state errors
- publication failure

### E3. Sandbox integration test harness

- Sandbox only by default.
- Tests require an explicitly supplied test token.
- Skip safely if no token is available.
- Never emit token in logs.
- Use synthetic fixture metadata only.
- Define cleanup/discard behavior.

### E4. End-to-end acceptance scenario

Exercise:

```text
ResearchDeposit
→ validate
→ select files
→ manifest
→ package digest
→ create Zenodo draft
→ upload
→ review
→ human approval receipt
→ pre-publish digest verification
→ publish to Sandbox
→ audit events
```

### Exit condition

A reproducible fixture completes the full v0.2 flow against Zenodo Sandbox without bypassing the common integrity layer.

---

## F. v0.2 supporting work — P1

These items do not need individual issues until implementation approaches them unless they block the P0 chain.

### F1. MCP tool contract cleanup

Review tool names and responsibilities. Target conceptual operations:

- `validate_deposit`
- `prepare_package`
- `review_package`
- `create_draft`
- `sync_draft`
- `request_approval` / approval handoff
- `verify_approval`
- `publish_approved_draft`

Avoid exposing redundant low-level mutations that let an agent bypass package-integrity checks.

### F2. State model

Define legal transitions, for example:

```text
UNPREPARED
→ VALIDATED
→ PACKAGED
→ DRAFTED
→ REVIEWED
→ APPROVED
→ PUBLISHED
```

Mutations after `APPROVED` should transition back to a state requiring new approval.

### F3. Test taxonomy

Maintain separate suites for:

- pure unit tests
- adapter contract tests
- security/invariant tests
- network integration tests
- Sandbox end-to-end tests

### F4. Documentation

Update:

- README
- `docs/architecture.md`
- `docs/safety-model.md`
- CHANGELOG
- MCP client examples

### v0.2 release gate

Do not tag v0.2 until:

- all #5 exit criteria pass
- Node CI is green
- security/invariant tests cover post-approval mutation
- Sandbox E2E passes at least once from a clean environment
- package digest format is documented
- breaking tool changes are documented

---

# v0.3 — Scientific metadata ingestion

Epic: #11

**Objective:** reuse structured scientific metadata rather than reconstructing it manually at deposition time.

## A. Importer architecture — P0

- Introduce a `MetadataImporter` interface separate from repository adapters.
- Every importer returns the common model or a structured partial model plus provenance.
- Preserve source provenance at field level where practical.
- Do not let importers call Zenodo/Dataverse directly.
- Define deterministic merge/conflict rules before supporting multiple simultaneous sources.

## B. CITATION.cff importer — P1

Start here because the format is constrained and useful for software deposits.

- parse title/version/authors/identifiers/repository URL/license/date
- map ORCID values
- retain unmapped fields in diagnostics rather than silently dropping
- support explicit precedence when combined with other sources

## C. RO-Crate importer — P0/P1

- identify root dataset entity
- map creators/contributors
- map files/distributions where appropriate
- map identifiers, license, keywords and related entities
- preserve graph provenance
- do not flatten relationships that would become misleading

## D. ORW importer — P0

- consume the ORW project contract rather than GitHub mechanics
- map project-level metadata to `ResearchDeposit`
- use ORW's structured project skeleton and future ISA/RO-Crate outputs where available
- keep ORW integration optional; this repository must remain useful independently

## E. ISA mapping — P0/P1

- define what becomes deposit-level metadata vs attached scientific metadata
- preserve Investigation → Study → Assay relationships
- avoid pretending Zenodo's flat metadata model can represent full ISA semantics
- likely deposit ISA artifacts/RO-Crate alongside the publication package while mapping only suitable discovery fields upward

## F. Identifier and vocabulary validation — P0

- ORCID syntax/checksum validation
- ROR identifier validation
- SPDX license identifiers where possible
- DataCite relation-type mapping
- URI/DOI normalization

External resolution should be optional and separately classified from local syntactic validation.

## G. Metadata conflict handling — P0

When sources disagree, return a structured conflict rather than silently choosing.

Example:

```text
version:
  CITATION.cff = 1.4.0
  RO-Crate     = 1.3.0
status: conflict
```

Allow explicit human resolution with provenance retained.

### v0.3 release gate

- at least CITATION.cff plus one scientific project format importer
- field provenance implemented
- conflict reporting implemented
- end-to-end example from structured project metadata to Zenodo Sandbox draft
- no repository-specific logic inside importers

---

# v0.4 — Repository independence

**Objective:** prove the common package model and safety contract are not Zenodo-specific.

## A. Adapter conformance suite — P0

Before a second adapter, formalize a shared contract test suite covering:

- create/read/update draft
- upload
- metadata synchronization
- publication capability declaration
- errors/state normalization
- versioning capability declaration
- safe handling of unsupported common fields

Adapters should declare capabilities rather than forcing every backend into the same behavior.

## B. InvenioRDM adapter — P1

High priority because Zenodo itself is InvenioRDM-based, but do not assume identical API semantics/configuration.

- configurable base URL
- token authentication
- draft/record lifecycle
- file upload
- metadata mapping
- publish/version semantics
- adapter conformance tests

## C. Dataverse adapter — P1

- dataset draft lifecycle
- file upload
- citation metadata mapping
- publish/version semantics
- persistent identifier handling
- adapter conformance tests

## D. Repository capability model — P0

Examples:

- supports DOI reservation
- supports versioning
- supports restricted access
- supports community/collection submission
- supports embargo
- supports draft discard

The MCP should expose capability differences instead of hiding them.

### v0.4 release gate

- Zenodo + at least one genuinely independent repository implementation
- shared conformance tests
- documented mapping/loss tables
- same approval-bound package model used across adapters

---

# v0.5 — Distribution, interoperability and operational maturity

This release is deliberately after the scientific and repository abstractions are stable.

## A. Package distribution

- publish npm package if naming is available and appropriate
- reproducible release workflow
- signed/provenance-aware release artifacts where practical
- semantic versioning policy
- release notes generated from maintained changelog

## B. MCP client onboarding

Provide tested configuration examples for major MCP-capable environments without coupling the project to one agent vendor.

Examples may include:

- Claude Desktop / Claude Code
- Codex or other MCP-compatible development agents
- generic MCP Inspector
- agent orchestration frameworks that can act as MCP clients

## C. Containerization

- minimal container image
- non-root runtime
- read-only filesystem where practical
- volume for explicit publication root/audit logs
- secret injection through environment or secret manager, not baked image layers

## D. Observability

- structured application logs
- operation durations
- adapter error counts
- no scientific payload export by default
- optional OpenTelemetry integration only if it can respect metadata/privacy boundaries

## E. Policy engine

Potential policies:

- repository allow-list
- production publication disabled globally
- allowed licenses
- required creator identifiers
- required related manuscript/dataset relation
- maximum upload size/count
- organization-specific metadata requirements

Keep policy deterministic and separate from LLM prompting.

## F. Versioning workflows

Support safe creation of new repository versions with the same integrity model:

```text
published record
→ prepare new version
→ new package digest
→ review
→ new approval
→ publish new version
```

Never reuse approval from a previous version.

---

# Cross-cutting backlog

## Security

- threat-model MCP tool misuse by autonomous clients
- fuzz validation/parsing boundaries
- dependency vulnerability monitoring
- secret-redaction tests
- path traversal tests
- production-vs-sandbox guard tests
- explicit network timeout/retry policy

## Scientific integrity

- never invent missing authors, ORCIDs, licenses, funding or relations
- distinguish inferred suggestions from validated metadata
- retain metadata provenance
- represent conflicts explicitly
- avoid flattening richer scientific structures into misleading repository metadata

## API stability

Until v1.0:

- expect MCP tool schemas to evolve
- document breaking changes in CHANGELOG
- version canonical package/audit schemas independently from npm package version where necessary

## Testing

Target layers:

1. unit tests — pure deterministic behavior
2. invariant/security tests — approval and package identity
3. adapter contract tests — shared repository behavior
4. network integration tests — backend API behavior
5. end-to-end tests — complete sandbox deposition

## Documentation

Maintain:

- architecture
- safety model
- common metadata model
- canonical package specification
- repository mappings
- importer mappings
- deployment/configuration
- examples
- release/migration notes

---

# Deferred ideas / do not implement prematurely

These may be valuable later but should not distract from the integrity contract:

- GUI/web dashboard
- hosted multi-tenant service
- autonomous metadata generation
- automatic license selection
- automatic author ordering
- automatic production publication
- blockchain/notarization layer
- generalized workflow engine
- repository search/discovery beyond what deposition requires

---

# Definition of Done for backlog items

A task is not complete merely when code exists. For user-visible or security-relevant work, completion should include:

- implementation
- unit/invariant tests
- adapter/integration tests where relevant
- documentation of behavior and limitations
- no credential leakage
- CI green
- CHANGELOG entry for externally visible changes
- explicit note for any remaining known limitation

---

# Issue strategy

Do not create a GitHub issue for every line in this file immediately. Keep the detailed long-range plan here and create issues when work becomes actionable.

Currently opened execution issues:

- #5 — v0.2 epic: reproducible, approval-bound publication package
- #6 — deterministic file selection and SHA-256 manifest
- #7 — canonical metadata serialization and publication digest
- #8 — human approval receipt bound to package digest
- #9 — append-only deposition audit event model
- #10 — expand Zenodo mapping and add Sandbox end-to-end tests
- #11 — v0.3 epic: scientific metadata ingestion

This keeps the issue tracker operational while `BACKLOG.md` preserves the larger technical plan.