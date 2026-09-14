# Safety model

Publishing a scholarly deposit can create a persistent public record, mint a DOI, expose files, and establish authorship/provenance claims. Final publication is therefore treated as a higher-risk operation than draft preparation.

## Layered controls

The v0.2 publication path uses independent controls rather than a single confirmation phrase:

1. **Sandbox by default** — the default endpoint is `https://sandbox.zenodo.org`.
2. **Publication disabled by default** — `ZENODO_ALLOW_PUBLISH=false` unless deliberately changed by the operator.
3. **Deterministic package identity** — canonical scientific metadata and the selected-file manifest produce a versioned SHA-256 package digest.
4. **Out-of-band operator approval** — a separate interactive CLI signs an approval receipt with an Ed25519 private key that should not be available to the MCP process or agent.
5. **Target binding** — the receipt binds the package digest, repository adapter, repository endpoint, draft ID, and publication-policy version.
6. **Short lifetime** — receipts expire and the server independently enforces a maximum age.
7. **Immediate revalidation** — the package digest is recomputed immediately before the irreversible publish call.

The old `PUBLISH <draft-id>` phrase is no longer the authorization boundary because an MCP client could generate it itself.

## Approval architecture

```text
metadata + selected files
          |
          v
 deterministic validation
          |
          v
 canonical metadata + SHA-256 file manifest
          |
          v
 versioned publication package
          |
          v
 package digest
          |
          +----> approval request
                    |
                    v
             human/operator CLI
             private Ed25519 key
                    |
                    v
              signed receipt
                    |
          +---------+
          v
 recompute package immediately before publish
          |
          v
 verify signature + digest + target + draft + policy + time
          |
          v
 repository publish
          |
          v
 audit event (tracked for #9)
```

If metadata or any selected file changes after approval, the digest changes and the receipt no longer authorizes publication.

## Key separation

The MCP server is configured only with the operator **public** key via `DEPOSITION_APPROVAL_PUBLIC_KEY_FILE`.

The matching private key belongs on the human/operator side and is used through `research-deposition-approve`. It should not be:

- stored in the repository;
- passed to the MCP server;
- placed in an agent-readable workspace;
- included in prompts, logs, issue bodies, or CI output.

The approval CLI intentionally requires an interactive TTY and provides no non-interactive bypass flag.

This is a practical authorization boundary, not a claim of hardware-backed identity. If an agent has arbitrary access to the operator account, terminal, and private key, this boundary can still be defeated. Higher-assurance deployments can replace the software private key with an external signing service or hardware-backed key in a future version.

## Package integrity

The package identity contract is documented in [`package-identity.md`](package-identity.md). The file-selection contract is documented in [`file-manifest.md`](file-manifest.md).

Operational values such as local absolute paths, repository access tokens, timestamps, or draft API responses do not enter the scientific package digest.

Scientific values that do enter package identity include:

- title and description;
- creator identity and order;
- affiliations and ORCIDs when supplied;
- license and version;
- publication date;
- related identifiers;
- selected filenames/deposition names;
- selected file content hashes.

## Metadata integrity

The system must never silently invent uncertainty-bearing scientific or attribution fields. Missing or inconsistent values should produce explicit validation findings or require human input.

Canonicalization is not semantic inference. It normalizes representation (for example Unicode NFC and unordered keyword ordering) only where the project contract explicitly defines those values as semantically equivalent.

## Process-level publication policy

A valid receipt does not enable publication by itself. `ZENODO_ALLOW_PUBLISH=true` is still required.

`DEPOSITION_PUBLICATION_POLICY_VERSION` is included in the signed authorization target. Changing the configured policy version invalidates older receipts.

`DEPOSITION_APPROVAL_MAX_AGE_SECONDS` independently limits how old an otherwise-valid receipt may be.

## Local and remote file boundary

`build_file_manifest` rejects symlinks, path traversal, and non-regular filesystem objects and hashes selected regular files with SHA-256.

The current receipt verifies the declared local package. Full adapter-level attestation that the remote Zenodo draft contains exactly the same file set is tracked in #10. Until that work lands, direct `upload_file` calls mean a receipt should not be interpreted as proof of remote-file equality.

## Secrets

Repository access tokens and approval private keys must never be returned by MCP tools or included in user-facing exceptions, test fixtures, committed configuration, or logs.

The operator public key fingerprint is safe to expose and is returned by `deposition_status` when configured.
