# Canonical package identity

The publication package is the repository-independent object that a human approves and that the MCP server re-computes immediately before final publication.

It contains only two scientific components:

1. canonical `ResearchDeposit` metadata;
2. the canonical file manifest defined in [`file-manifest.md`](file-manifest.md).

Machine-local paths, repository access tokens, draft API responses, timestamps, log fields, and other operational state are not part of package identity.

## Schema versions

v0.2 uses three explicit schema/version markers:

- canonical metadata schema: `1`;
- file manifest schema: `1`;
- publication package schema: `1`.

Changing canonicalization semantics in a way that can change package identity requires a schema-version change rather than silently changing old digests.

## Canonical metadata rules

Scientific strings are normalized to Unicode NFC before serialization.

The following rules are deliberate:

- **creator order is preserved** because authorship/contributor order may carry meaning;
- **keywords are treated as an unordered set**, normalized, deduplicated, and sorted;
- **related identifiers are treated as an unordered set**, normalized, deduplicated, and sorted by identifier, relation, then resource type;
- absent optional fields remain absent;
- `null` is invalid under the repository-independent metadata schema and is not silently converted to an absent field;
- an empty string is preserved only where `ResearchDepositSchema` currently permits one (for example `notes`);
- unknown/unmodeled input fields are stripped by schema validation and do not affect the digest.

This last rule is what prevents operational values such as `/home/alice/project` from contaminating package identity.

## Canonical JSON v1

The project uses a deliberately small canonical JSON profile rather than relying on JavaScript object insertion order.

Canonical JSON v1 is UTF-8 JSON with:

1. object keys sorted by UTF-16 code-unit order;
2. arrays retained in their supplied canonical order;
3. JSON string escaping performed by standard JSON serialization;
4. finite safe integers only;
5. no whitespace;
6. exactly one trailing newline.

The metadata and file-manifest canonicalizers are responsible for semantic normalization before this structural serializer is used.

## Publication package

Conceptually:

```json
{
  "schemaVersion": "1",
  "metadata": {
    "schemaVersion": "1",
    "...": "canonical research metadata"
  },
  "manifest": {
    "schemaVersion": "1",
    "entries": []
  }
}
```

## Digest algorithm

The package digest is:

```text
SHA-256(
  UTF8("research-deposition-package-v1\\0")
  || UTF8(canonical_package_json_with_trailing_newline)
)
```

It is represented as:

```text
sha256:<64 lowercase hexadecimal characters>
```

The domain-separation prefix prevents the same byte sequence used in another protocol from being interpreted as a Research Deposition MCP package digest.

## Consequences

The package digest changes when any scientifically relevant canonical metadata changes, when creator order changes, when a selected file changes, when a selected file is renamed, or when a repository-facing deposited filename changes.

The digest does **not** change because of JavaScript object insertion order, duplicate/reordered keywords, duplicate/reordered related identifiers, machine-local root paths, or unknown operational metadata fields.

## Golden fixtures

`test/package-identity.test.ts` contains a hard-coded canonical metadata representation, canonical publication package, and expected SHA-256 digest. Those values intentionally act as a compatibility fixture. A future change that alters them must be reviewed as a package-identity contract change rather than accepted as routine formatting drift.
