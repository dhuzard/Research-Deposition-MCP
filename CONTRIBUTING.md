# Contributing

Thanks for contributing to Research Deposition MCP.

This project mediates scholarly publication, so correctness, provenance, and safe defaults take precedence over convenience.

## Before opening a pull request

For bug fixes, a pull request may be opened directly. For new tools, writable operations, metadata fields, repository adapters, or changes to the publication safety model, open an issue first.

Please describe:

- the user/research workflow;
- the repository or metadata standard involved;
- what can be changed or published by the proposed feature;
- failure modes and irreversible effects;
- how behavior can be tested deterministically.

## Development setup

Requirements: Node.js 20+ and npm.

```bash
npm install
npm test
```

## Engineering rules

- Keep Zenodo Sandbox as the default endpoint.
- Never enable publication by default.
- Never commit, log, echo, or persist repository access tokens.
- Do not silently infer missing authorship, affiliations, licenses, funding, identifiers, or scientific metadata.
- Validation and repository mappings must be deterministic code rather than prompt-only logic.
- Repository-specific behavior belongs under `src/adapters/`.
- The common model must remain independent of Zenodo-specific field names.
- New writable operations require tests for validation, failure behavior, and safety controls.
- Changes that affect publication authorization must document the threat model and approval semantics.

## Pull requests

Keep changes focused. Include:

1. a concise problem statement;
2. the implementation approach;
3. tests or an explanation of why tests are not applicable;
4. any backward-compatibility or safety implications;
5. documentation changes when behavior is user-visible.

All CI checks should pass before merge.

## Commit messages

Use short imperative summaries where practical, for example:

```text
Add Zenodo metadata mapping tests
Reject publication without frozen manifest
Document ORCID validation policy
```

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
