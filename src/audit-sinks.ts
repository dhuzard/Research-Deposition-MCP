import { appendFile, readFile } from "node:fs/promises";
import { canonicalJsonLine, type CanonicalJsonValue } from "./canonical-json.js";
import { AuditError, type AuditEvent, type AuditSink, verifyAuditChain } from "./audit.js";

/**
 * Append-only NDJSON file sink for AuditLog.
 *
 * - `initialize()` reads and fully verifies any existing file content before
 *   the process is allowed to resume appending. A tampered, reordered,
 *   incomplete (missing final newline), or otherwise inconsistent existing
 *   log throws rather than being silently repaired, truncated, or
 *   overwritten -- appending onto a line that is missing its trailing
 *   newline would merge it with the next appended line and corrupt both.
 * - `append()` writes exactly one canonical JSON line per call using
 *   O_APPEND semantics. AuditLog already serializes concurrent `record()`
 *   calls within this process, so this sink assumes single-writer,
 *   single-process ownership of the file; it does not itself arbitrate
 *   across multiple processes.
 */
export class AuditFileSink implements AuditSink {
  constructor(private readonly filePath: string) {}

  async initialize(): Promise<AuditEvent | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }

    if (raw.length === 0) return null;

    if (!raw.endsWith("\n")) {
      throw new AuditError(
        "audit_log_missing_trailing_newline",
        "Existing audit log does not end with a newline; refusing to append, which would corrupt the incomplete final line.",
      );
    }

    const lines = raw.split("\n").filter((line) => line.length > 0);
    if (lines.length === 0) return null;

    const rawEvents = lines.map((line, index) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new AuditError(
          "audit_log_unreadable",
          `Existing audit log line ${index + 1} is not valid JSON; refusing to resume.`,
        );
      }
    });

    const verification = verifyAuditChain(rawEvents);
    if (!verification.valid) {
      throw new AuditError(
        "audit_log_tampered",
        "Existing audit log failed integrity verification; refusing to append to a tampered or corrupted log.",
        verification.issues,
      );
    }

    return JSON.parse(lines[lines.length - 1]!) as AuditEvent;
  }

  async append(event: AuditEvent): Promise<void> {
    const line = canonicalJsonLine(event as unknown as CanonicalJsonValue);
    await appendFile(this.filePath, line, { encoding: "utf8", flag: "a" });
  }
}
