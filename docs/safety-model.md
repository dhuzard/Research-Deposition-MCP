# Safety model

Publishing a scholarly deposit can create a persistent public record, mint a DOI, expose files, and establish authorship/provenance claims. The safety model therefore treats final publication as a higher-risk operation than draft preparation.

## v0.1 controls

The current implementation provides three practical guardrails:

1. **Sandbox by default** — the default endpoint is `https://sandbox.zenodo.org`.
2. **Publication disabled by default** — `ZENODO_ALLOW_PUBLISH=false` unless deliberately changed by the operator.
3. **Exact confirmation phrase** — publication requires `PUBLISH <draft-id>`.

These controls reduce accidental writes. They do not constitute strong human authentication.

## Known limitation

An MCP client able to call tools could potentially provide the confirmation phrase itself. Therefore the confirmation phrase should not be interpreted as proof that a specific human reviewed a specific immutable set of files and metadata.

## Target approval model

The planned v0.2 flow is:

```text
metadata + selected files
          |
          v
 deterministic validation
          |
          v
 manifest: path + size + SHA-256
          |
          v
 canonical metadata + manifest
          |
          v
 publication digest
          |
          +--> human review/approval bound to digest
          |
          v
 re-check digest immediately before publish
          |
          v
 repository publish
          |
          v
 audit event
```

If metadata or any file changes after approval, the digest changes and approval must be repeated.

## Metadata integrity

The system should never silently invent or normalize away uncertainty in fields that carry scientific or attribution meaning, including:

- creators/authors;
- ORCID/ROR identifiers;
- affiliations;
- licenses;
- funding;
- related publications/datasets;
- access conditions;
- study relationships or scientific descriptions.

Missing or inconsistent values should produce explicit validation findings or require human input.

## Local file access

`upload_file` accepts a server-local path. Deployments should therefore run the MCP server with least privilege and restrict filesystem access at the process/container level. Future releases should add path allowlists and manifest-based selection before production use.

## Secrets

Repository tokens remain server-side environment variables. They must never be returned by MCP tools or included in logs, exceptions intended for users, test fixtures, or committed configuration.
