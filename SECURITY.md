# Security Policy

## Supported versions

Research Deposition MCP is in early development. Security fixes target the latest code on the default branch and the most recent tagged release, when releases exist.

## Reporting a vulnerability

Do **not** open a public issue for vulnerabilities involving:

- repository credentials or token exposure;
- unauthorized publication or mutation of scholarly records;
- bypass of publication approval controls;
- arbitrary local file access through MCP tools;
- command/path injection;
- leakage of unpublished research data or metadata.

Prefer GitHub's private vulnerability reporting feature if it is enabled for this repository. Otherwise contact the repository owner privately through the contact mechanisms on their GitHub profile.

Include a minimal reproduction, affected version/commit, expected impact, and any suggested mitigation. Do not include real access tokens or sensitive unpublished data.

## Secrets

Zenodo tokens must be supplied at runtime and must never be committed, logged, or included in bug reports. Revoke and rotate any token that may have been exposed.

## Safety versus security

The publication confirmation gate is currently a safety guardrail, not an authentication or authorization system. See [docs/safety-model.md](docs/safety-model.md).
