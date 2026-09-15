import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, canonicalJsonLine } from "../src/canonical-json.js";

test("canonicalJson sorts object keys deterministically", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test("canonicalJsonLine appends a newline", () => {
  assert.equal(canonicalJsonLine({ b: 1, a: 2 }), '{"a":2,"b":1}\n');
});

test("canonicalJson produces a stable string regardless of key order", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
});

test("canonicalJson rejects NaN", () => {
  assert.throws(() => canonicalJson(Number.NaN), TypeError);
});

test("canonicalJson rejects Infinity and -Infinity", () => {
  assert.throws(() => canonicalJson(Number.POSITIVE_INFINITY), TypeError);
  assert.throws(() => canonicalJson(Number.NEGATIVE_INFINITY), TypeError);
});

test("canonicalJson rejects unsafe integers", () => {
  assert.throws(() => canonicalJson(Number.MAX_SAFE_INTEGER + 1), TypeError);
  assert.throws(() => canonicalJson(-(Number.MAX_SAFE_INTEGER + 1)), TypeError);
});

test("canonicalJson accepts safe integers", () => {
  assert.equal(canonicalJson(Number.MAX_SAFE_INTEGER), String(Number.MAX_SAFE_INTEGER));
  assert.equal(canonicalJson(0), "0");
});

test("canonicalJson rejects non-integer numbers", () => {
  assert.throws(() => canonicalJson(3.14), TypeError);
});

test("canonicalJson rejects non-finite numbers nested inside objects/arrays", () => {
  assert.throws(() => canonicalJson({ a: [1, Number.NaN] }), TypeError);
});
