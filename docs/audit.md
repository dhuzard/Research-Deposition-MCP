# Audit event model

The audit log records, at the operation level, what was attempted against a deposition and how it concluded, without exposing repository credentials, the approval private key, or arbitrary scientific/operational payloads.

It is repository-independent: `src/audit.ts` does not import or depend on any adapter-specific field names, and repository identity is limited to an opaque `adapter` name and normalized `target` string.

## Event shape (schema v1)

Each event (`AuditEvent` in `src/audit.ts`) has:

- `schemaVersion`: `"1"`.
- `sequence`: a positive integer, starting at `1` and incrementing by exactly `1` for every later event. Sequence is authoritative for ordering.
- `timestamp`: `Date.prototype.toISOString()` output (millisecond-precision UTC).
- `operation`: one of a fixed vocabulary — `deposit.validate`, `manifest.generate`, `package.digest`, `draft.create`, `draft.read`, `draft.update`, `file.upload`, `file.remove`, `approval.request`, `approval.issue`, `approval.invalidate`, `publication.publish`, `version.initiate`.
- `outcome`: `attempted` | `succeeded` | `failed`.
- `source`: `{ kind: "mcp-tool" | "operator-cli" | "system", id?: string }`.
- `repository?`: `{ adapter?: string, target?: string }`.
- `draftId?`, `packageDigest?`: bound identifiers, not free text.
- `attemptEventHash?`: the `eventHash` of a prior `attempted` event, set only on a later `succeeded`/`failed` event for the same operation. Lets a terminal event be linked directly to its attempt without scanning the whole chain.
- `details?`: a small, strict, per-operation "safe summary" object (counts, booleans, bounded enums, hex digests only — see `AUDIT_DETAILS_SCHEMAS` in `src/audit.ts`).
- `error?`: `{ category, code }` — a stable category from a fixed vocabulary plus a short machine code. Never a raw exception message.
- `previousEventHash`: `null` for the first event, otherwise the prior event's `eventHash`.
- `eventHash`: `sha256` of the event body (every field above except `eventHash` itself).

## Hashing

```text
eventHash = lowercase_hex(
  SHA-256(
    UTF8("research-deposition-audit-event-v1\0")
    || UTF8(canonicalJsonLine(body_without_eventHash))
  )
)
```

The event body is serialized with the same Canonical JSON v1 profile used for package identity (`src/canonical-json.ts`): sorted object keys, no whitespace, one trailing newline. The domain-separation prefix keeps an audit event hash from colliding with a package digest or an approval signature even if the same byte sequence were reused.

Changing any recorded field of an event changes its `eventHash`. This is what makes tampering with an already-recorded event detectable.

## What is deliberately excluded

`details` and `error` are small closed schemas, not free-form payloads. The following are never accepted as audit event fields:

- repository access tokens or `Authorization` headers;
- the approval private key or any private key material;
- full approval receipts or signatures;
- raw exception/error messages (only a stable `category`/`code` pair);
- local absolute file paths;
- arbitrary/unmodeled metadata payloads.

As defense in depth, `details` is also scanned for field names that look secret-like (`token`, `secret`, `password`, `credential`, `authorization`, `signature`, `path`, and similar substrings) and rejected outright if any are present, even if the value would otherwise satisfy the per-operation schema.

## Chain verification

`verifyAuditChain(rawEvents, { expectedHeadEventHash? })` re-derives trust from the events themselves:

1. each event is independently schema-validated and its `eventHash` is recomputed and compared (`parseAuditEvent`);
2. `sequence` must start at `1` and increase by exactly `1` per event;
3. `previousEventHash` must equal the prior event's `eventHash` (or `null` for the first event);
4. if `expectedHeadEventHash` is supplied, the final event's `eventHash` must match it.

Modifying a stored event, deleting an interior event, or reordering events all break rule 1, 2, or 3 and are reported as issues (`event_hash_mismatch`, `sequence_mismatch`, `previous_hash_mismatch`).

## Integrity limits — read before relying on this for compliance

**Tamper-evident, not tamper-proof.** The chain proves that a *given sequence of events, taken as a whole,* is internally self-consistent. It cannot prove that the sequence you were given is *the only* sequence that ever existed, because:

- **Tail deletion is invisible without an external checkpoint.** Deleting the last N events from a log leaves the remaining prefix perfectly self-consistent — rule 1-3 above all still pass. The only defense is rule 4: record the current head `eventHash` somewhere outside the log itself (a separate append-only store, a periodically published checkpoint, etc.) and pass it as `expectedHeadEventHash`. This project does not currently implement automatic external checkpointing; it is the caller's responsibility if this guarantee is required.
- **A determined attacker with write access to the whole file can rewrite the whole suffix.** If an attacker can change event *k* and also recompute `eventHash`/`previousEventHash`/`sequence` for every event after *k*, the resulting file re-verifies as internally consistent. Nothing about a local hash chain alone can prevent this; only an external, independently-controlled checkpoint (rule 4) or a separate signing/anchoring mechanism can. v0.2 does not add signed or externally anchored logs — see `BACKLOG.md` (#9) for later work.
- **A crash between "attempted" and its terminal event is expected and visible, not corruption.** If the process dies after recording `outcome: "attempted"` for an operation but before recording its `succeeded`/`failed` counterpart, the log is still valid — it just contains an attempt with no matching terminal event. Readers should treat a trailing unresolved `attempted` event as "outcome unknown," not as evidence of tampering.
- **One-process ownership.** `AuditLog` serializes concurrent `record()` calls *within a single process* using an in-memory queue. `AuditFileSink` assumes it is the sole writer to its file; it does not implement cross-process file locking. Running two processes against the same audit file concurrently is unsupported and can corrupt sequencing.

## Persistence

`AuditFileSink` (`src/audit-sinks.ts`) is a newline-delimited JSON (NDJSON) file sink:

- `initialize()` reads any existing file, verifies the entire chain (`verifyAuditChain`), and throws `AuditError("audit_log_tampered", ...)` rather than silently repairing, rewriting, or truncating an invalid log. Resuming is only possible against a log that already re-verifies cleanly.
- `append()` writes exactly one canonical JSON line using append-mode (`O_APPEND`) file writes and never rewrites prior lines.

Other sinks (for example stdout, or a future signed/anchored store) can be added by implementing the small `AuditSink` interface (`initialize()` / `append()`); `AuditLog` itself owns sequence assignment and hash chaining and does not need to change.
