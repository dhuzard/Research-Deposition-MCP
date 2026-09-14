# Agent development rules

This server mediates scholarly publication. Treat write operations as provenance-critical.

- Never log or persist repository tokens.
- Sandbox must remain the default endpoint.
- Never enable final publication by default.
- Do not infer or silently invent missing creators, affiliations, licenses, identifiers, funding, or scientific metadata.
- Validation and repository mappings should be deterministic code, not LLM prompts.
- Repository-specific logic belongs under `src/adapters/`.
- The common research-deposit model must not depend on Zenodo-specific field names.
- Any future publication approval mechanism should bind approval to an immutable digest of metadata + file manifest.
- Tests for validation and mapping are required before adding new writable capabilities.
