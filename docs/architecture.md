# Architecture

Research Deposition MCP is designed around a repository-independent core rather than a direct one-to-one exposure of any repository API.

## Components

```text
MCP client / agent
      |
      v
MCP tool layer
      |
      +--> deterministic validation and policy
      |
      +--> common ResearchDeposit model
      |
      +--> deterministic file-manifest layer
      |
      +--> canonical publication package + digest
      |
      +--> operator public-key approval verifier
      |
      v
RepositoryAdapter interface
      |
+-----+----------------+
|                      |
v                      v
Zenodo            future adapters
                  (InvenioRDM,
                   Dataverse, ...)

Human/operator side
      |
      +--> separate interactive approval CLI
      +--> private Ed25519 key (never supplied to MCP)
```

## Common model

`ResearchDeposit` contains repository-independent concepts such as title, description, creators, resource type, license, version, keywords, publication date, and related identifiers.

It should evolve toward a sufficiently expressive scholarly-deposit contract while avoiding fields whose meaning exists only in a single backend.

## File manifest

The manifest is the deterministic identity of the selected publication files. It contains repository-independent relative source/deposit paths, byte size, SHA-256, and optional media type. Local absolute paths are operational-only and excluded from package identity.

See [file-manifest.md](file-manifest.md).

## Publication package identity

Canonical `ResearchDeposit` metadata and the canonical file manifest are wrapped in a versioned publication package. A domain-separated SHA-256 digest becomes the stable identity that approval is bound to.

Canonicalization is deterministic and versioned. Creator order is preserved; keyword and related-identifier ordering is canonicalized as unordered sets.

See [package-identity.md](package-identity.md).

## Approval boundary

The MCP server does not hold the approval private key. `publication_review` returns an exact approval request. A separate interactive operator-side CLI signs that request with Ed25519.

The MCP server receives only the public key and verifies that the receipt matches:

- current package digest;
- repository adapter;
- repository endpoint;
- draft ID;
- publication-policy version;
- time/expiry constraints.

The package is recomputed immediately before publication, so package mutation invalidates authorization.

See [approval.md](approval.md) and [safety-model.md](safety-model.md).

## Repository adapters

`RepositoryAdapter` defines the writable repository operations currently required by the MCP layer:

- create draft;
- retrieve draft;
- update draft;
- upload file;
- publish draft.

Repository-specific field mapping and HTTP behavior belong inside adapter implementations.

The current interface does not yet prove that the remote repository file set exactly matches the local package manifest. Adapter-level verification/conformance is tracked in #10 and later repository-independence work.

## Audit event log

A repository-independent, append-only audit event model records operation-level activity (validation, manifest/digest generation, draft and file operations, approval lifecycle, publication) as a SHA-256 hash chain, without repository credentials or the approval private key.

See [audit.md](audit.md).

## Metadata-source adapters

A separate future layer will transform existing scientific metadata sources into the common model:

```text
ISA ---------+
RO-Crate ----+--> common ResearchDeposit --> package identity --> repository adapter
CITATION.cff-+
ORW ---------+
```

Parsing/importing metadata and depositing it are intentionally separate concerns. This makes it possible to test source mappings independently of repository writes.

## Trust boundaries

The MCP client may be an LLM-driven agent. Therefore:

- agent-generated metadata is candidate input, not trusted truth;
- validation and canonicalization are deterministic;
- repository credentials remain server-side;
- the operator approval private key remains outside the MCP/agent process;
- draft operations and final publication have different risk levels;
- final authorization is independently verifiable and package-bound rather than prompt-dependent.
