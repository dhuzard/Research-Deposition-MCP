# Research Deposition MCP

[![CI](https://github.com/dhuzard/Research-Deposition-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/dhuzard/Research-Deposition-MCP/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Status: early development](https://img.shields.io/badge/status-early%20development-orange.svg)](ROADMAP.md)

A safety-first Model Context Protocol (MCP) server for preparing scholarly deposits from agentic research workflows. Zenodo is the first repository adapter; the core model is intentionally repository-independent.

> **Project status:** v0.2 in progress / early development. Use Zenodo Sandbox for testing. Package identity and signed human approval are implemented; full remote-draft/file attestation remains planned in #10.

## Why this exists

Repository APIs make programmatic deposition possible, but a raw API wrapper is not enough for trustworthy agentic publishing. Research Deposition MCP separates three responsibilities:

1. **Agent/LLM** — interpret researcher intent and assemble candidate metadata.
2. **Deterministic deposition layer** — validate, canonicalize, hash, transform, upload, and report inconsistencies.
3. **Human/operator** — authorize publication of a specific immutable package using a signing key kept outside the MCP/agent environment.

The design principle is simple: agents may help prepare a deposit, but they should not silently invent scientific metadata or obtain implicit authority to publish it.

## Current scope

Implemented:

- repository-independent research-deposit model;
- deterministic schema validation with warnings;
- deterministic file selection with explicit include/exclude rules;
- repository-independent file manifest with POSIX/NFC-normalized source/deposit paths, byte size, and SHA-256;
- canonical byte-stable file-manifest serialization;
- canonical scientific metadata serialization;
- versioned publication package combining metadata + manifest;
- SHA-256 package digest with domain separation;
- strict rejection of symlinks/path traversal for manifest construction;
- Zenodo adapter and Zenodo Sandbox default;
- draft creation, retrieval, metadata update, and local file upload;
- publication review that emits the exact approval request;
- Ed25519 operator-signed, short-lived approval receipts;
- pre-publication package digest recomputation;
- approval binding to package digest, repository adapter, endpoint, draft ID, and policy version;
- publication disabled by default at process level.

Still planned include append-only audit events (#9), full Zenodo remote-package verification and Sandbox E2E coverage (#10), RO-Crate/CITATION.cff/ISA/ORW importers, identifier validation, and additional repository adapters. See [ROADMAP.md](ROADMAP.md) and [BACKLOG.md](BACKLOG.md).

## MCP tools

| Tool | Purpose | Publishes? |
|---|---|---:|
| `deposition_status` | Report backend, approval verifier, and safety configuration without exposing secrets | No |
| `validate_deposition` | Validate repository-independent metadata | No |
| `build_file_manifest` | Deterministically select and SHA-256 files without uploading them | No |
| `build_publication_package` | Canonicalize metadata + manifest and compute the package digest | No |
| `create_draft` | Validate metadata and create an unpublished Zenodo draft | No |
| `get_draft` | Retrieve a draft | No |
| `update_draft` | Validate and replace draft metadata | No |
| `upload_file` | Upload a local file to a draft | No |
| `publication_review` | Recompute the package, retrieve the draft, and return the approval request | No |
| `publish_draft` | Recompute package, verify signed approval, then publish if process policy permits | **Yes** |

See [docs/file-manifest.md](docs/file-manifest.md), [docs/package-identity.md](docs/package-identity.md), and [docs/approval.md](docs/approval.md).

## Safety defaults

```text
ZENODO_BASE_URL=https://sandbox.zenodo.org
ZENODO_ALLOW_PUBLISH=false
DEPOSITION_PUBLICATION_POLICY_VERSION=1
DEPOSITION_APPROVAL_MAX_AGE_SECONDS=900
```

A valid approval receipt does **not** enable publication by itself. Final publication requires both:

1. deliberate process configuration (`ZENODO_ALLOW_PUBLISH=true`); and
2. a valid operator-signed receipt matching the freshly recomputed package and exact target.

The private approval key is intentionally not used by the MCP server. See [docs/safety-model.md](docs/safety-model.md).

## Requirements

- Node.js 20+
- npm
- a Zenodo Sandbox personal access token for writable tests

## Install

```bash
git clone https://github.com/dhuzard/Research-Deposition-MCP.git
cd Research-Deposition-MCP
npm install
npm test
```

Create a Zenodo **Sandbox** token and start the MCP server:

```bash
export ZENODO_API_KEY="..."
npm start
```

Do not commit tokens or put them into MCP configuration files that will be version-controlled.

## MCP client example

```json
{
  "mcpServers": {
    "research-deposition": {
      "command": "node",
      "args": ["/absolute/path/Research-Deposition-MCP/build/src/index.js"],
      "env": {
        "ZENODO_API_KEY": "YOUR_SANDBOX_TOKEN",
        "ZENODO_BASE_URL": "https://sandbox.zenodo.org",
        "DEPOSITION_APPROVAL_PUBLIC_KEY_FILE": "/safe/path/operator-public.pem"
      }
    }
  }
}
```

Only the public approval key belongs in the MCP process.

## Repository-independent metadata

```json
{
  "title": "Home-cage behavioral dataset",
  "description": "Behavioral and experimental metadata for ...",
  "resourceType": "dataset",
  "creators": [
    {
      "name": "Huzard, Damien",
      "orcid": "0000-0000-0000-0000",
      "affiliation": "..."
    }
  ],
  "keywords": ["FAIR", "home-cage monitoring"],
  "license": "cc-by-4.0",
  "version": "1.0.0",
  "relatedIdentifiers": []
}
```

The common model deliberately avoids Zenodo field names. Repository-specific transformations live in adapters.

## File manifest

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

`build_file_manifest` returns a canonical manifest containing only repository-independent relative paths and content identity. Absolute local paths are not serialized. Symlinks and `..` traversal are rejected.

## Publication package and digest

`build_publication_package` combines canonical metadata with the canonical file manifest. The resulting digest has the form:

```text
sha256:<64 lowercase hex characters>
```

The digest is over a versioned canonical JSON representation with explicit domain separation. Creator order is significant. Keywords and related identifiers are canonicalized as unordered sets. Unknown operational metadata fields and machine-local root paths do not affect the digest.

The full contract and golden test fixture are documented in [docs/package-identity.md](docs/package-identity.md).

## Human approval workflow

Generate an operator key pair outside the agent workspace:

```bash
npm run build
research-deposition-approve keygen \
  --private-key ~/.config/research-deposition/operator-private.pem \
  --public-key ~/.config/research-deposition/operator-public.pem
```

Configure the MCP process with only the public key:

```bash
export DEPOSITION_APPROVAL_PUBLIC_KEY_FILE="$HOME/.config/research-deposition/operator-public.pem"
```

Call `publication_review` with the draft ID, metadata, root directory, and file-selection rules. It returns an `approvalRequest` containing the package digest and exact publication target.

Save that request as JSON and sign it interactively:

```bash
research-deposition-approve sign \
  --request approval-request.json \
  --private-key ~/.config/research-deposition/operator-private.pem \
  --receipt approval-receipt.json
```

The signing command requires a TTY and an exact human-entered confirmation phrase. There is intentionally no non-interactive bypass flag.

`publish_draft` then requires the receipt plus the metadata/file-selection inputs. It re-reads the selected files and recomputes the package digest immediately before verifying the receipt and publishing.

Any change to metadata, selected file content, selected filenames, repository endpoint, draft ID, or configured policy version invalidates the authorization.

See [docs/approval.md](docs/approval.md) for the complete protocol and its current limitations.

## Architecture

```text
Agentic client
     │ MCP
     ▼
Research Deposition MCP
 ├─ deterministic validation / policy
 ├─ common research-deposit model
 ├─ deterministic file-manifest layer
 ├─ canonical publication-package identity
 ├─ operator public-key receipt verification
 └─ repository adapters
       ├─ Zenodo
       ├─ InvenioRDM (planned)
       └─ Dataverse (planned)

Human/operator side
 └─ private Ed25519 key + interactive approval CLI
```

Metadata-source adapters will eventually map structures such as ISA, RO-Crate, CITATION.cff, and Open Research Workspace (ORW) metadata into the common model without coupling those standards to Zenodo.

More detail: [docs/architecture.md](docs/architecture.md).

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ZENODO_API_KEY` | unset | Zenodo/Sandbox bearer token. Required for deposition operations. |
| `ZENODO_BASE_URL` | `https://sandbox.zenodo.org` | Repository endpoint and part of the approval target. |
| `ZENODO_ALLOW_PUBLISH` | `false` | Process-level final-publication enablement. |
| `ZENODO_MAX_UPLOAD_BYTES` | `52428800` | Per-file local safety ceiling used by this server. |
| `DEPOSITION_APPROVAL_PUBLIC_KEY_FILE` | unset | Operator public Ed25519 key used to verify receipts. Final publication fails closed when unset. |
| `DEPOSITION_PUBLICATION_POLICY_VERSION` | `1` | Policy identifier included in approval requests/receipts. Changing it invalidates older receipts. |
| `DEPOSITION_APPROVAL_MAX_AGE_SECONDS` | `900` | Server-side maximum accepted receipt age. |

## Current integrity boundary

The signed receipt authorizes the declared **local** publication package and exact repository target. The server recomputes that local package immediately before publication.

Full proof that the current remote Zenodo draft contains exactly the same file set is not yet implemented; that is part of #10. Direct `upload_file` operations therefore remain a known gap before this should be treated as production-grade remote package attestation.

## Development

```bash
npm install
npm run build
npm test
```

Source code lives under `src/`; repository-specific code belongs under `src/adapters/`. Tests use Node's built-in test runner.

Before adding any new write capability, read [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [docs/safety-model.md](docs/safety-model.md).

## Contributing

Issues and pull requests are welcome. For substantial features, open an issue first so the data model, safety boundary, and repository semantics can be discussed before implementation. See [CONTRIBUTING.md](CONTRIBUTING.md).

For security-sensitive problems, do not open a public issue; follow [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).
