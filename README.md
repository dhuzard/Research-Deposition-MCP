# Research Deposition MCP

[![CI](https://github.com/dhuzard/Research-Deposition-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/dhuzard/Research-Deposition-MCP/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Status: early development](https://img.shields.io/badge/status-early%20development-orange.svg)](ROADMAP.md)

A safety-first Model Context Protocol (MCP) server for preparing scholarly deposits from agentic research workflows. Zenodo is the first repository adapter; the core model is intentionally repository-independent.

> **Project status:** v0.2 in progress / early development. Use Zenodo Sandbox for testing. The current publication gate is a guardrail, not a complete authenticated human-approval system.

## Why this exists

Repository APIs make programmatic deposition possible, but a raw API wrapper is not enough for trustworthy agentic publishing. Research Deposition MCP separates three responsibilities:

1. **Agent/LLM** — interpret researcher intent and assemble candidate metadata.
2. **Deterministic deposition layer** — validate, transform, upload, and report inconsistencies.
3. **Human/operator** — authorize publication of the scholarly record.

The design principle is simple: agents may help prepare a deposit, but they should not silently invent scientific metadata or obtain implicit authority to publish it.

## Current scope

Implemented:

- repository-independent research-deposit model;
- deterministic schema validation with warnings;
- deterministic file selection with explicit include/exclude rules;
- repository-independent file manifest with POSIX-normalized source/deposit paths, byte size, and SHA-256;
- canonical byte-stable manifest serialization;
- strict rejection of symlinks and path traversal for manifest construction;
- Zenodo adapter;
- Zenodo Sandbox as the default endpoint;
- draft creation and retrieval;
- draft metadata updates;
- local file upload with a configurable size ceiling;
- publication review step;
- publication disabled by default;
- explicit confirmation phrase required when publication is enabled.

Planned, but **not yet implemented**, include a digest over canonical metadata plus the file manifest, approval bound to that immutable digest, audit logs, RO-Crate/CITATION.cff/ISA/ORW importers, identifier validation, and additional repository adapters. See [ROADMAP.md](ROADMAP.md) and [BACKLOG.md](BACKLOG.md).

## MCP tools

| Tool | Purpose | Publishes? |
|---|---|---:|
| `deposition_status` | Report backend and safety configuration without exposing secrets | No |
| `validate_deposition` | Validate repository-independent metadata | No |
| `build_file_manifest` | Deterministically select and SHA-256 files without uploading them | No |
| `create_draft` | Validate metadata and create an unpublished Zenodo draft | No |
| `get_draft` | Retrieve a draft | No |
| `update_draft` | Validate and replace draft metadata | No |
| `upload_file` | Upload a local file to a draft | No |
| `publication_review` | Retrieve the draft and required confirmation phrase | No |
| `publish_draft` | Publish a reviewed draft when explicitly enabled | **Yes** |

The manifest selection and normalization contract is documented in [docs/file-manifest.md](docs/file-manifest.md).

## Safety defaults

```text
ZENODO_BASE_URL=https://sandbox.zenodo.org
ZENODO_ALLOW_PUBLISH=false
```

Production publication therefore requires deliberate operator configuration. `publish_draft` additionally requires the exact confirmation string `PUBLISH <draft-id>`.

These controls reduce accidental publication, but they do **not** yet prove that a particular authenticated human approved an immutable package. The v0.2 design will bind approval to a digest over metadata plus the file manifest. See [docs/safety-model.md](docs/safety-model.md).

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
        "ZENODO_BASE_URL": "https://sandbox.zenodo.org"
      }
    }
  }
}
```

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

## File manifest example

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

`build_file_manifest` returns a manifest containing only repository-independent relative paths and content identity. Absolute local paths are not serialized. Symlinks and `..` traversal are rejected. See [docs/file-manifest.md](docs/file-manifest.md).

## Architecture

```text
Agentic client
     │ MCP
     ▼
Research Deposition MCP
 ├─ deterministic validation / policy
 ├─ common research-deposit model
 ├─ deterministic file-manifest layer
 └─ repository adapters
       ├─ Zenodo (v0.1)
       ├─ InvenioRDM (planned)
       └─ Dataverse (planned)
```

Metadata-source adapters will eventually map structures such as ISA, RO-Crate, CITATION.cff, and Open Research Workspace (ORW) metadata into the common model without coupling those standards to Zenodo.

More detail: [docs/architecture.md](docs/architecture.md).

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ZENODO_API_KEY` | unset | Zenodo/Sandbox bearer token. Required for deposition operations. |
| `ZENODO_BASE_URL` | `https://sandbox.zenodo.org` | Repository endpoint. |
| `ZENODO_ALLOW_PUBLISH` | `false` | Must be `true` or `1` before final publication is allowed. |
| `ZENODO_MAX_UPLOAD_BYTES` | `52428800` | Per-file local safety ceiling used by this server. |

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
