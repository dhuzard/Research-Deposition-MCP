export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Project-specific canonical JSON v1.
 *
 * - object keys are sorted by UTF-16 code-unit order;
 * - arrays retain their supplied order;
 * - strings are serialized by JSON.stringify (callers normalize semantic
 *   strings before reaching this layer);
 * - numbers must be finite safe integers;
 * - undefined and non-JSON values are rejected by construction.
 */
export function canonicalJson(value: CanonicalJsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new TypeError("Canonical JSON only supports finite safe integers.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const keys = Object.keys(value).sort(compareCodeUnits);
  const members = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${members.join(",")}}`;
}

export function canonicalJsonLine(value: CanonicalJsonValue): string {
  return `${canonicalJson(value)}\n`;
}

export function normalizeCanonicalString(value: string): string {
  return value.normalize("NFC");
}

export function compareCanonicalStrings(a: string, b: string): number {
  return compareCodeUnits(a, b);
}
