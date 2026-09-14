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
                 v
          RepositoryAdapter interface
                 |
        +--------+---------+
        |                  |
        v                  v
     Zenodo          future adapters
                     (InvenioRDM,
                      Dataverse, ...)
```

## Common model

`ResearchDeposit` contains repository-independent concepts such as title, description, creators, resource type, license, version, keywords, publication date, and related identifiers.

It should evolve toward a sufficiently expressive scholarly-deposit contract while avoiding fields whose meaning exists only in a single backend.

## Repository adapters

`RepositoryAdapter` defines the writable repository operations currently required by the MCP layer:

- create draft;
- retrieve draft;
- update draft;
- upload file;
- publish draft.

Repository-specific field mapping and HTTP behavior belong inside adapter implementations.

## Metadata-source adapters

A separate future layer will transform existing scientific metadata sources into the common model:

```text
ISA ---------+
RO-Crate ----+--> common ResearchDeposit --> repository adapter
CITATION.cff-+
ORW ---------+
```

Parsing/importing metadata and depositing it are intentionally separate concerns. This makes it possible to test source mappings independently of repository writes.

## Trust boundary

The MCP client may be an LLM-driven agent. Therefore:

- agent-generated metadata is candidate input, not trusted truth;
- validation is deterministic;
- secrets remain server-side;
- draft operations and final publication have different risk levels;
- publication authorization must become independently verifiable rather than prompt-dependent.

See [safety-model.md](safety-model.md).
