# Agent development rules

This server mediates scholarly publication. Treat write operations as provenance-critical.

- Never log or persist repository tokens.
- Never log, return, request, or store the operator approval **private** key in the MCP process or agent workspace.
- Sandbox must remain the default endpoint.
- Never enable final publication by default.
- Do not infer or silently invent missing creators, affiliations, licenses, identifiers, funding, or scientific metadata.
- Validation, canonicalization, hashing, approval verification, and repository mappings must be deterministic code, not LLM prompts.
- Repository-specific logic belongs under `src/adapters/`.
- The common research-deposit model and package-identity model must not depend on Zenodo-specific field names.
- Final publication authorization must remain bound to the exact package digest, repository endpoint, draft, and publication-policy version.
- Approval signing must remain outside the MCP tool surface unless a future external identity/signing service provides an equivalent or stronger human authorization boundary.
- Any post-approval package mutation must fail closed and require a new receipt.
- Schema/canonicalization changes that can change package digests require explicit versioning and golden-fixture review.
- Tests are required before adding or changing writable capabilities.
