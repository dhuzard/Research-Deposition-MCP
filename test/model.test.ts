import test from "node:test";
import assert from "node:assert/strict";
import { validateDeposit } from "../src/model.js";

test("accepts minimal valid deposition and emits useful warnings", () => {
  const result = validateDeposit({
    title: "Example dataset",
    description: "A sufficiently descriptive test research dataset.",
    resourceType: "dataset",
    creators: [{ name: "Doe, Jane" }],
  });
  assert.equal(result.report.valid, true);
  assert.ok(result.report.issues.some((i) => i.code === "missing_license"));
  assert.ok(result.report.issues.some((i) => i.code === "missing_orcid"));
});

test("rejects malformed metadata", () => {
  const result = validateDeposit({ title: "x", creators: [] });
  assert.equal(result.report.valid, false);
  assert.ok(result.report.issues.some((i) => i.severity === "error"));
});

test("accepts ORCID shape", () => {
  const result = validateDeposit({
    title: "Example software",
    description: "A sufficiently descriptive software research output.",
    resourceType: "software",
    creators: [{ name: "Doe, Jane", orcid: "0000-0002-1825-0097" }],
    license: "MIT",
    keywords: ["FAIR"],
  });
  assert.equal(result.report.valid, true);
  assert.equal(result.report.issues.length, 0);
});
