import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildManifest, normalizePortablePath } from "../src/manifest.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "rdmcp-manifest-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// -- normalizePortablePath --------------------------------------------------

test("normalizePortablePath accepts a simple relative path", () => {
  const result = normalizePortablePath("data/readings.csv");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value, "data/readings.csv");
});

test("normalizePortablePath collapses '.' segments and repeated separators", () => {
  const result = normalizePortablePath("./data//./readings.csv");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value, "data/readings.csv");
});

test("normalizePortablePath rejects an empty string", () => {
  const result = normalizePortablePath("");
  assert.equal(result.ok, false);
});

test("normalizePortablePath rejects NUL bytes", () => {
  const result = normalizePortablePath("data/read\0ings.csv");
  assert.equal(result.ok, false);
});

test("normalizePortablePath rejects POSIX absolute paths", () => {
  const result = normalizePortablePath("/etc/passwd");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.code, "absolute_path");
});

test("normalizePortablePath rejects Windows drive-letter absolute paths", () => {
  const result = normalizePortablePath("C:/Windows/System32");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.code, "windows_absolute");
});

test("normalizePortablePath rejects Windows drive-letter absolute paths with backslashes", () => {
  const result = normalizePortablePath("C:\\Windows\\System32");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.code, "windows_absolute");
});

test("normalizePortablePath rejects Windows drive-relative paths without a slash", () => {
  const result = normalizePortablePath("C:x");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.code, "windows_absolute");
});

test("normalizePortablePath rejects Windows drive-relative paths with a nested segment", () => {
  const result = normalizePortablePath("C:foo/bar");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.code, "windows_absolute");
});

test("normalizePortablePath rejects UNC paths", () => {
  const result = normalizePortablePath("\\\\server\\share\\file.txt");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.code, "unc_path");
});

test("normalizePortablePath rejects a raw '..' segment", () => {
  const result = normalizePortablePath("data/../../etc/passwd");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.code, "path_traversal");
});

test("normalizePortablePath rejects a path that resolves to nothing", () => {
  const result = normalizePortablePath("./.");
  assert.equal(result.ok, false);
});

test("normalizePortablePath NFC-normalizes unicode so equivalent paths match", () => {
  const nfd = "café.txt"; // "café.txt" decomposed
  const nfc = "café.txt";
  const a = normalizePortablePath(nfd);
  const b = normalizePortablePath(nfc);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.ok && a.value, b.ok && b.value);
});

// -- buildManifest: safety rejections ---------------------------------------

test("buildManifest rejects an absolute sourcePath", async () => {
  await withTempDir(async (dir) => {
    const result = await buildManifest(dir, [{ sourcePath: "/etc/passwd", depositName: "passwd" }]);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.issues.some((i) => i.code === "source_absolute_path"));
  });
});

test("buildManifest rejects a traversal sourcePath", async () => {
  await withTempDir(async (dir) => {
    const result = await buildManifest(dir, [{ sourcePath: "../secret.txt", depositName: "secret.txt" }]);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.issues.some((i) => i.code === "source_path_traversal"));
  });
});

test("buildManifest rejects an absolute depositName", async () => {
  await withTempDir(async (dir) => {
    const result = await buildManifest(dir, [{ sourcePath: "a.txt", depositName: "/tmp/a.txt" }]);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.issues.some((i) => i.code === "deposit_absolute_path"));
  });
});

test("buildManifest rejects a traversal depositName", async () => {
  await withTempDir(async (dir) => {
    const result = await buildManifest(dir, [{ sourcePath: "a.txt", depositName: "../a.txt" }]);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.issues.some((i) => i.code === "deposit_path_traversal"));
  });
});

test("buildManifest rejects duplicate normalized sourcePath", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "a.txt"), "hello");
    const result = await buildManifest(dir, [
      { sourcePath: "a.txt", depositName: "one.txt" },
      { sourcePath: "./a.txt", depositName: "two.txt" },
    ]);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.issues.some((i) => i.code === "duplicate_source_path"));
  });
});

test("buildManifest rejects duplicate normalized depositName", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "a.txt"), "hello");
    await writeFile(join(dir, "b.txt"), "world");
    const result = await buildManifest(dir, [
      { sourcePath: "a.txt", depositName: "same.txt" },
      { sourcePath: "b.txt", depositName: "same.txt" },
    ]);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.issues.some((i) => i.code === "duplicate_deposit_name"));
  });
});

test("buildManifest rejects a missing file", async () => {
  await withTempDir(async (dir) => {
    const result = await buildManifest(dir, [{ sourcePath: "does-not-exist.txt", depositName: "x.txt" }]);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.issues.some((i) => i.code === "missing_file"));
  });
});

test("buildManifest rejects a directory in place of a file", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "adir"));
    const result = await buildManifest(dir, [{ sourcePath: "adir", depositName: "adir" }]);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.issues.some((i) => i.code === "not_a_regular_file"));
  });
});

test("buildManifest rejects a symlinked file", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "real.txt"), "hello");
    await symlink(join(dir, "real.txt"), join(dir, "link.txt"));
    const result = await buildManifest(dir, [{ sourcePath: "link.txt", depositName: "link.txt" }]);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.issues.some((i) => i.code === "symlink_rejected"));
  });
});

test("buildManifest rejects a file reached through a symlinked intermediate directory", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "real-dir"));
    await writeFile(join(dir, "real-dir", "file.txt"), "hello");
    await symlink(join(dir, "real-dir"), join(dir, "link-dir"));
    const result = await buildManifest(dir, [{ sourcePath: "link-dir/file.txt", depositName: "file.txt" }]);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.issues.some((i) => i.code === "symlink_rejected"));
  });
});

// -- buildManifest: deterministic content -------------------------------------

test("buildManifest produces correct size, sha256, and sorted order", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "b.txt"), "second");
    await writeFile(join(dir, "a.txt"), "first content");

    const result = await buildManifest(dir, [
      { sourcePath: "sub/b.txt", depositName: "zeta.txt" },
      { sourcePath: "a.txt", depositName: "alpha.txt" },
    ]);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.manifest.length, 2);
    // sorted by depositName: alpha.txt before zeta.txt
    assert.deepEqual(result.manifest.map((e) => e.depositName), ["alpha.txt", "zeta.txt"]);

    const alpha = result.manifest[0];
    assert.equal(alpha.sourcePath, "a.txt");
    assert.equal(alpha.size, Buffer.byteLength("first content"));
    assert.equal(alpha.sha256, sha256("first content"));

    const zeta = result.manifest[1];
    assert.equal(zeta.sourcePath, "sub/b.txt");
    assert.equal(zeta.size, Buffer.byteLength("second"));
    assert.equal(zeta.sha256, sha256("second"));
  });
});

test("buildManifest is deterministic across repeated calls and independent of input order", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "a.txt"), "alpha content");
    await writeFile(join(dir, "b.txt"), "beta content");

    const files = [
      { sourcePath: "b.txt", depositName: "b-out.txt" },
      { sourcePath: "a.txt", depositName: "a-out.txt" },
    ];

    const first = await buildManifest(dir, files);
    const second = await buildManifest(dir, [...files].reverse());

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(first, second);
  });
});

test("buildManifest accepts a filesystem root as rootDir without false containment rejection", async () => {
  const result = await buildManifest("/", [{ sourcePath: "etc/hosts", depositName: "hosts" }]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.manifest[0].sourcePath, "etc/hosts");
});

test("buildManifest accepts in-root filenames that begin with two dots", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "..data.txt"), "not traversal");
    const result = await buildManifest(dir, [{ sourcePath: "..data.txt", depositName: "dot-prefixed.txt" }]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.manifest[0].sourcePath, "..data.txt");
  });
});
