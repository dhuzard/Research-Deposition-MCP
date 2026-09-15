export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * Deep-clones a value into a canonical form: object keys sorted, `undefined`
 * values dropped. Arrays keep their order (order is meaningful).
 */
export function canonicalize(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cannot canonicalize non-finite number: ${value}`);
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new TypeError(`Cannot canonicalize unsafe integer: ${value}`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source)
      .filter((key) => source[key] !== undefined)
      .sort();
    const result: Record<string, JsonValue> = {};
    for (const key of keys) {
      result[key] = canonicalize(source[key]);
    }
    return result;
  }
  throw new TypeError(`Cannot canonicalize value of type ${typeof value}`);
}

/** Deterministic JSON serialization of a canonicalized value. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
