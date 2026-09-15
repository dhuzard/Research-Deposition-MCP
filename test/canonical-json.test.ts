import test from "node:test";
import assert from "node:assert/strict";
import { canonicalize, canonicalStringify } from "../src/canonical-json.js";

test("canonicalize sorts object keys and drops undefined values", () => {
  const result = canonicalize({ b: 1, a: 2, c: undefined });
  assert.deepEqual(result, { a: 2, b: 1 });
});

test("canonicalStringify produces a stable string regardless of key order", () => {
  assert.equal(canonicalStringify({ b: 1, a: 2 }), canonicalStringify({ a: 2, b: 1 }));
});

test("canonicalize rejects NaN", () => {
  assert.throws(() => canonicalize(Number.NaN), TypeError);
});

test("canonicalize rejects Infinity and -Infinity", () => {
  assert.throws(() => canonicalize(Number.POSITIVE_INFINITY), TypeError);
  assert.throws(() => canonicalize(Number.NEGATIVE_INFINITY), TypeError);
});

test("canonicalize rejects unsafe integers", () => {
  assert.throws(() => canonicalize(Number.MAX_SAFE_INTEGER + 1), TypeError);
  assert.throws(() => canonicalize(-(Number.MAX_SAFE_INTEGER + 1)), TypeError);
});

test("canonicalize accepts safe integers and finite non-integer numbers", () => {
  assert.equal(canonicalize(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  assert.equal(canonicalize(3.14), 3.14);
  assert.equal(canonicalize(0), 0);
});

test("canonicalize rejects non-finite numbers nested inside objects/arrays", () => {
  assert.throws(() => canonicalize({ a: [1, Number.NaN] }), TypeError);
});
