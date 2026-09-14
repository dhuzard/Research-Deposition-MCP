# Operator-signed publication approval

Final publication is authorized with a short-lived Ed25519-signed receipt bound to the exact publication package and repository target.

This replaces the v0.1 `PUBLISH <draft-id>` phrase, which an MCP client could generate by itself.

## Security boundary

The MCP server receives only the **public** approval key. The **private** key is used by a separate interactive operator-side CLI and should not be present in the MCP server environment or any agent-accessible workspace.

```text
Agent / MCP client                  Human/operator side
       |                                   |
       | build/review package              | private Ed25519 key
       v                                   v
 approval request JSON  ---------->  interactive approval CLI
       |                                   |
       | <----------- signed receipt ------+
       v
MCP verifies with public key
       |
rebuild package immediately before publish
       |
verify digest + target + draft + policy + time
       |
repository publish
```

A signed receipt is not a secret bearer token. It is a verifiable authorization statement that is useful only for the exact package, repository endpoint, draft, and policy encoded in it, and only for a short time.

## Approval request

`publication_review` returns an `approvalRequest` containing:

- package digest;
- repository adapter name;
- normalized repository endpoint;
- draft identifier;
- publication-policy version.

The request contains no repository credentials.

## Key generation

Build the project, then create an operator key pair outside the agent workspace:

```bash
npm run build
research-deposition-approve keygen \
  --private-key ~/.config/research-deposition/operator-private.pem \
  --public-key ~/.config/research-deposition/operator-public.pem
```

The CLI creates the private key with restrictive file permissions and refuses to overwrite an existing file.

Configure the MCP server with only the public key:

```bash
export DEPOSITION_APPROVAL_PUBLIC_KEY_FILE="$HOME/.config/research-deposition/operator-public.pem"
```

Do not put the private key in MCP configuration, repository secrets exposed to the agent, the project directory, or logs.

## Signing an approval request

Save the `approvalRequest` returned by `publication_review` as JSON and run:

```bash
research-deposition-approve sign \
  --request approval-request.json \
  --private-key ~/.config/research-deposition/operator-private.pem \
  --receipt approval-receipt.json
```

Signing requires an interactive TTY and an exact human-entered confirmation phrase derived from the package digest and draft ID. There is intentionally no non-interactive `--yes` mode.

The default receipt lifetime is 900 seconds. A shorter lifetime can be requested with `--expires-in`.

## Receipt payload

The signed payload contains:

- approval schema version;
- package digest;
- repository adapter;
- repository endpoint;
- draft ID;
- publication-policy version;
- approval method/version (`operator-ed25519-v1`);
- issuance timestamp;
- expiration timestamp;
- random nonce.

The receipt additionally carries a fingerprint of the signing public key and an Ed25519 signature.

## Server verification

`publish_draft` performs these checks before calling the repository publish endpoint:

1. `ZENODO_ALLOW_PUBLISH=true` must be configured;
2. an operator public key must be configured;
3. metadata + selected files are re-read and the publication package digest is recomputed;
4. the receipt signature must verify under the configured public key;
5. package digest must match;
6. repository adapter and endpoint must match;
7. draft ID must match;
8. publication-policy version must match;
9. the receipt must be within its signed expiration and the server's configured maximum age;
10. the target draft must still exist immediately before publication.

Any package mutation after approval therefore requires a new approval receipt.

## Process-level policy

Approval does not override operator configuration. Publication remains disabled by default with:

```text
ZENODO_ALLOW_PUBLISH=false
```

The policy version defaults to `1` and can be changed with:

```text
DEPOSITION_PUBLICATION_POLICY_VERSION=1
```

Changing the configured policy version invalidates receipts issued under an older policy.

The server also enforces its own receipt-age ceiling:

```text
DEPOSITION_APPROVAL_MAX_AGE_SECONDS=900
```

## Current limitation

The receipt proves authorization for the **declared local scientific package** and target draft. v0.2 currently re-checks the local package immediately before publication, but full adapter-level proof that every remotely uploaded repository file exactly corresponds to that manifest is part of the Zenodo end-to-end/conformance work tracked in #10.

This limitation is important: direct `upload_file` operations remain possible in the current API. Production deployments should not interpret the receipt as remote-file attestation until adapter-level package verification is implemented.
