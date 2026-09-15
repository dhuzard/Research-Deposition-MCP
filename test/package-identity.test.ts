import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemblePackage, computePackageDigest } from "../src/package-identity.js";
import type { FileManifestEntry } from "../src/manifest.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "rdmcp-identity-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const metadata = {
  title: "Example dataset",
  description: "A sufficiently descriptive test research dataset.",
  resourceType: "dataset" as const,
  creators: [{ name: "Doe, Jane" }],
  keywords: [] as string[],
  relatedIdentifiers: [] as unknown[],
};

test("computePackageDigest is deterministic for identical inputs", () => {
  const manifest: FileManifestEntry[] = [
    { sourcePath: "a.txt", depositName: "a.txt", size: 5, sha256: "abc123" },
  ];
  const first = computePackageDigest("1", metadata, manifest);
  const second = computePackageDigest("1", metadata, manifest);
  assert.equal(first, second);
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
});

test("computePackageDigest is independent of object key ordering", () => {
  const manifest: FileManifestEntry[] = [
    { sourcePath: "a.txt", depositName: "a.txt", size: 5, sha256: "abc123" },
  ];
  const reorderedMetadata = {
    keywords: [] as string[],
    relatedIdentifiers: [] as unknown[],
    description: metadata.description,
    creators: metadata.creators,
    resourceType: metadata.resourceType,
    title: metadata.title,
  };
  const a = computePackageDigest("1", metadata, manifest);
  const b = computePackageDigest("1", reorderedMetadata, manifest);
  assert.equal(a, b);
});

test("computePackageDigest changes when metadata changes", () => {
  const manifest: FileManifestEntry[] = [
    { sourcePath: "a.txt", depositName: "a.txt", size: 5, sha256: "abc123" },
  ];
  const a = computePackageDigest("1", metadata, manifest);
  const b = computePackageDigest("1", { ...metadata, title: "A different title" }, manifest);
  assert.notEqual(a, b);
});

test("computePackageDigest changes when manifest content changes", () => {
  const manifestA: FileManifestEntry[] = [
    { sourcePath: "a.txt", depositName: "a.txt", size: 5, sha256: "abc123" },
  ];
  const manifestB: FileManifestEntry[] = [
    { sourcePath: "a.txt", depositName: "a.txt", size: 5, sha256: "def456" },
  ];
  const a = computePackageDigest("1", metadata, manifestA);
  const b = computePackageDigest("1", metadata, manifestB);
  assert.notEqual(a, b);
});

test("computePackageDigest changes when schemaVersion changes", () => {
  const manifest: FileManifestEntry[] = [
    { sourcePath: "a.txt", depositName: "a.txt", size: 5, sha256: "abc123" },
  ];
  const a = computePackageDigest("1", metadata, manifest);
  const b = computePackageDigest("2", metadata, manifest);
  assert.notEqual(a, b);
});

test("assemblePackage produces the same digest regardless of the package root path", async () => {
  await withTempDir(async (dirA) => {
    await withTempDir(async (dirB) => {
      await mkdir(join(dirA, "data"));
      await mkdir(join(dirB, "data"));
      await writeFile(join(dirA, "data", "readings.csv"), "x,y\n1,2\n");
      await writeFile(join(dirB, "data", "readings.csv"), "x,y\n1,2\n");

      const files = [{ sourcePath: "data/readings.csv", depositName: "readings.csv" }];
      const resultA = await assemblePackage(dirA, "1", metadata, files);
      const resultB = await assemblePackage(dirB, "1", metadata, files);

      assert.equal(resultA.ok, true);
      assert.equal(resultB.ok, true);
      if (!resultA.ok || !resultB.ok) return;
      assert.equal(resultA.digest, resultB.digest);
      assert.deepEqual(resultA.manifest, resultB.manifest);
      // The manifest itself must never leak the local root directory.
      for (const entry of resultA.manifest) {
        assert.ok(!entry.sourcePath.includes(dirA));
        assert.ok(!entry.depositName.includes(dirA));
      }
    });
  });
});

test("assemblePackage digest changes when a selected file's content changes", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "readings.csv"), "x,y\n1,2\n");
    const files = [{ sourcePath: "readings.csv", depositName: "readings.csv" }];

    const before = await assemblePackage(dir, "1", metadata, files);
    assert.equal(before.ok, true);

    await writeFile(join(dir, "readings.csv"), "x,y\n1,3\n");
    const after = await assemblePackage(dir, "1", metadata, files);
    assert.equal(after.ok, true);

    if (!before.ok || !after.ok) return;
    assert.notEqual(before.digest, after.digest);
  });
});

test("computePackageDigest changes when a file's sourcePath (deposit path) is renamed", () => {
  const manifestA: FileManifestEntry[] = [
    { sourcePath: "a.txt", depositName: "a.txt", size: 5, sha256: "abc123" },
  ];
  const manifestB: FileManifestEntry[] = [
    { sourcePath: "renamed.txt", depositName: "a.txt", size: 5, sha256: "abc123" },
  ];
  const a = computePackageDigest("1", metadata, manifestA);
  const b = computePackageDigest("1", metadata, manifestB);
  assert.notEqual(a, b);
});

test("computePackageDigest changes when a file's depositName changes", () => {
  const manifestA: FileManifestEntry[] = [
    { sourcePath: "a.txt", depositName: "a.txt", size: 5, sha256: "abc123" },
  ];
  const manifestB: FileManifestEntry[] = [
    { sourcePath: "a.txt", depositName: "renamed.txt", size: 5, sha256: "abc123" },
  ];
  const a = computePackageDigest("1", metadata, manifestA);
  const b = computePackageDigest("1", metadata, manifestB);
  assert.notEqual(a, b);
});

test("computePackageDigest matches a known golden value for a fixed input", () => {
  const manifest: FileManifestEntry[] = [
    { sourcePath: "a.txt", depositName: "a.txt", size: 5, sha256: "abc123" },
  ];
  const digest = computePackageDigest("1", metadata, manifest);
  assert.equal(digest, "sha256:22b488c345bf98747e47890b092c6b8a16f5cf435d22c80c45024ae091ee62dc");
});

test("assemblePackage fails without a digest when a file is unsafe", async () => {
  await withTempDir(async (dir) => {
    const files = [{ sourcePath: "../outside.txt", depositName: "outside.txt" }];
    const result = await assemblePackage(dir, "1", metadata, files);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.issues.length > 0);
  });
});
