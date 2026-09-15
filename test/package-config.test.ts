import test from "node:test";
import assert from "node:assert/strict";
import { validatePackageConfig } from "../src/package-config.js";

const validMetadata = {
  title: "Example dataset",
  description: "A sufficiently descriptive test research dataset.",
  resourceType: "dataset",
  creators: [{ name: "Doe, Jane", orcid: "0000-0002-1825-0097" }],
  license: "MIT",
  keywords: ["FAIR"],
};

test("accepts a well-formed package config", () => {
  const result = validatePackageConfig({
    schemaVersion: "1",
    metadata: validMetadata,
    files: [{ sourcePath: "data/readings.csv", depositName: "readings.csv" }],
  });
  assert.equal(result.report.valid, true);
  assert.ok(result.data);
  assert.equal(result.data?.files.length, 1);
});

test("rejects an unsupported schemaVersion", () => {
  const result = validatePackageConfig({
    schemaVersion: "2",
    metadata: validMetadata,
    files: [{ sourcePath: "a.txt", depositName: "a.txt" }],
  });
  assert.equal(result.report.valid, false);
  assert.ok(result.report.issues.some((i) => i.severity === "error"));
});

test("rejects a package config with an empty files array", () => {
  const result = validatePackageConfig({
    schemaVersion: "1",
    metadata: validMetadata,
    files: [],
  });
  assert.equal(result.report.valid, false);
});

test("rejects file entries missing sourcePath or depositName", () => {
  const result = validatePackageConfig({
    schemaVersion: "1",
    metadata: validMetadata,
    files: [{ sourcePath: "a.txt" }],
  });
  assert.equal(result.report.valid, false);
});

test("surfaces metadata schema errors with a metadata-prefixed path", () => {
  const result = validatePackageConfig({
    schemaVersion: "1",
    metadata: { title: "x", creators: [] },
    files: [{ sourcePath: "a.txt", depositName: "a.txt" }],
  });
  assert.equal(result.report.valid, false);
  assert.ok(result.report.issues.some((i) => i.severity === "error" && i.path?.startsWith("metadata.")));
});

test("rejects a package config with an unknown top-level field", () => {
  const result = validatePackageConfig({
    schemaVersion: "1",
    metadata: validMetadata,
    files: [{ sourcePath: "a.txt", depositName: "a.txt" }],
    extra: "not allowed",
  });
  assert.equal(result.report.valid, false);
});

test("rejects a file entry with an unknown field", () => {
  const result = validatePackageConfig({
    schemaVersion: "1",
    metadata: validMetadata,
    files: [{ sourcePath: "a.txt", depositName: "a.txt", extra: "not allowed" }],
  });
  assert.equal(result.report.valid, false);
});

test("surfaces metadata warnings (e.g. missing license) without invalidating the config", () => {
  const result = validatePackageConfig({
    schemaVersion: "1",
    metadata: {
      title: "Example dataset",
      description: "A sufficiently descriptive test research dataset.",
      resourceType: "dataset",
      creators: [{ name: "Doe, Jane" }],
    },
    files: [{ sourcePath: "a.txt", depositName: "a.txt" }],
  });
  assert.equal(result.report.valid, true);
  assert.ok(result.report.issues.some((i) => i.code === "missing_license"));
});
