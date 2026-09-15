import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildExplicitFileManifest,
  buildFileManifest,
  canonicalizeManifest,
  ManifestError,
  normalizeManifestPath,
  serializeManifest,
} from "../src/manifest.js";

async function withFixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "research-deposition-manifest-"));
  try {
    await mkdir(path.join(root, "nested", "données"), { recursive: true });
    await writeFile(path.join(root, "empty.txt"), "");
    await writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2, 255]));
    await writeFile(path.join(root, "nested", "notes.md"), "first version\n");
    await writeFile(path.join(root, "nested", "données", "échantillon.csv"), "id,value\n1,42\n");
    await writeFile(path.join(root, "scratch.tmp"), "not for publication\n");
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("builds a byte-stable canonical manifest for empty, binary, Unicode, and nested files", async () => {
  await withFixture(async (root) => {
    const rules = { include: ["**/*"], exclude: ["**/*.tmp"] };
    const first = await buildFileManifest(root, rules);
    const second = await buildFileManifest(root, rules);

    assert.equal(serializeManifest(first), serializeManifest(second));
    assert.deepEqual(first.entries.map((entry) => entry.sourcePath), [
      "binary.bin",
      "empty.txt",
      "nested/données/échantillon.csv",
      "nested/notes.md",
    ]);

    const empty = first.entries.find((entry) => entry.sourcePath === "empty.txt");
    assert.equal(empty?.size, 0);
    assert.equal(empty?.sha256, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(first.entries.find((entry) => entry.sourcePath.endsWith("échantillon.csv"))?.mediaType, "text/csv");
  });
});

test("normalizes decomposed Unicode names without losing access to the raw local file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "research-deposition-unicode-"));
  try {
    const decomposedName = "e\u0301chantillon.txt";
    await writeFile(path.join(root, decomposedName), "unicode path\n");

    const manifest = await buildFileManifest(root, { include: ["échantillon.txt"] });
    assert.equal(manifest.entries.length, 1);
    assert.equal(manifest.entries[0].sourcePath, "échantillon.txt");
    assert.equal(normalizeManifestPath(decomposedName), "échantillon.txt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selected file content mutations change the manifest", async () => {
  await withFixture(async (root) => {
    const rules = { include: ["nested/**"] };
    const before = serializeManifest(await buildFileManifest(root, rules));
    await writeFile(path.join(root, "nested", "notes.md"), "second version\n");
    const after = serializeManifest(await buildFileManifest(root, rules));
    assert.notEqual(before, after);
  });
});

test("excluded file mutations do not influence the manifest", async () => {
  await withFixture(async (root) => {
    const rules = { include: ["**/*"], exclude: ["**/*.tmp"] };
    const before = serializeManifest(await buildFileManifest(root, rules));
    await writeFile(path.join(root, "scratch.tmp"), "changed but still excluded\n");
    const after = serializeManifest(await buildFileManifest(root, rules));
    assert.equal(before, after);
  });
});

test("renaming, adding, and removing selected files changes canonical output", async () => {
  await withFixture(async (root) => {
    const rules = { include: ["nested/**"] };
    const initial = serializeManifest(await buildFileManifest(root, rules));

    await rename(path.join(root, "nested", "notes.md"), path.join(root, "nested", "renamed.md"));
    const renamed = serializeManifest(await buildFileManifest(root, rules));
    assert.notEqual(initial, renamed);

    await writeFile(path.join(root, "nested", "added.txt"), "new\n");
    const added = serializeManifest(await buildFileManifest(root, rules));
    assert.notEqual(renamed, added);

    await unlink(path.join(root, "nested", "added.txt"));
    const removedAgain = serializeManifest(await buildFileManifest(root, rules));
    assert.equal(renamed, removedAgain);
  });
});

test("keeps local source names distinct from repository deposit names", async () => {
  await withFixture(async (root) => {
    const manifest = await buildFileManifest(root, {
      include: ["nested/notes.md"],
      destinations: { "nested/notes.md": "documentation/methods.md" },
    });

    assert.deepEqual(manifest.entries[0], {
      sourcePath: "nested/notes.md",
      depositPath: "documentation/methods.md",
      size: 14,
      sha256: manifest.entries[0].sha256,
      mediaType: "text/markdown",
    });
    assert.ok(!serializeManifest(manifest).includes(root));
  });
});

test("rejects traversal, absolute paths, and destination collisions after normalization", async () => {
  assert.throws(() => normalizeManifestPath("../secret.txt"), (error: unknown) => {
    return error instanceof ManifestError && error.code === "path_traversal";
  });
  assert.throws(() => normalizeManifestPath("/tmp/secret.txt"), (error: unknown) => {
    return error instanceof ManifestError && error.code === "absolute_path";
  });

  await withFixture(async (root) => {
    await assert.rejects(
      buildFileManifest(root, {
        include: ["empty.txt", "binary.bin"],
        destinations: {
          "empty.txt": "same//name.dat",
          "binary.bin": "same/name.dat",
        },
      }),
      (error: unknown) => error instanceof ManifestError && error.code === "duplicate_deposit_path",
    );
  });
});

test("canonicalization rejects duplicate normalized source paths", () => {
  const sha256 = "0".repeat(64);
  assert.throws(
    () => canonicalizeManifest({
      schemaVersion: "1",
      entries: [
        { sourcePath: "data//file.txt", depositPath: "one.txt", size: 1, sha256 },
        { sourcePath: "data/file.txt", depositPath: "two.txt", size: 1, sha256 },
      ],
    }),
    (error: unknown) => error instanceof ManifestError && error.code === "duplicate_source_path",
  );
});

test("requires explicit include rules", async () => {
  await withFixture(async (root) => {
    await assert.rejects(
      buildFileManifest(root, { include: [] }),
      (error: unknown) => error instanceof ManifestError && error.code === "missing_include_rules",
    );
  });
});

test("rejects symbolic links instead of following them", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows symlink creation may require elevated privileges");
    return;
  }

  await withFixture(async (root) => {
    await symlink(path.join(root, "empty.txt"), path.join(root, "linked.txt"));
    await assert.rejects(
      buildFileManifest(root, { include: ["**/*"] }),
      (error: unknown) => error instanceof ManifestError && error.code === "symlink_rejected",
    );
  });
});

test("buildExplicitFileManifest rejects a symlinked intermediate directory in the source path", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows symlink creation may require elevated privileges");
    return;
  }

  await withFixture(async (root) => {
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "research-deposition-outside-"));
    try {
      await writeFile(path.join(outsideDir, "secret.txt"), "outside contents\n");
      // "linked" looks like an ordinary subdirectory of root, but it is a
      // symlink pointing entirely outside the declared root.
      await symlink(outsideDir, path.join(root, "linked"), "dir");

      const outcome = await buildExplicitFileManifest(root, [
        { sourcePath: "linked/secret.txt", depositPath: "secret.txt" },
      ]);

      assert.equal(outcome.manifest, undefined);
      assert.ok(outcome.issues.some((issue) => issue.code === "symlink_rejected"));
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test("buildExplicitFileManifest accepts files nested under real (non-symlinked) directories", async () => {
  await withFixture(async (root) => {
    const outcome = await buildExplicitFileManifest(root, [
      { sourcePath: "nested/notes.md", depositPath: "notes.md" },
    ]);

    assert.ok(outcome.manifest);
    assert.equal(outcome.issues.length, 0);
    assert.equal(outcome.manifest?.entries[0].sourcePath, "nested/notes.md");
  });
});

test("buildExplicitFileManifest rejects a symlinked package root", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows symlink creation may require elevated privileges");
    return;
  }

  const realRoot = await mkdtemp(path.join(os.tmpdir(), "research-deposition-real-root-"));
  const parent = await mkdtemp(path.join(os.tmpdir(), "research-deposition-link-parent-"));
  try {
    await writeFile(path.join(realRoot, "file.txt"), "outside via root symlink\n");
    const linkedRoot = path.join(parent, "linked-root");
    await symlink(realRoot, linkedRoot, "dir");
    const outcome = await buildExplicitFileManifest(linkedRoot, [
      { sourcePath: "file.txt", depositPath: "file.txt" },
    ]);
    assert.equal(outcome.manifest, undefined);
    assert.ok(outcome.issues.some((issue) => issue.code === "symlink_rejected"));
  } finally {
    await rm(realRoot, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test("buildExplicitFileManifest uses raw safe filesystem names while serializing NFC paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "research-deposition-explicit-unicode-"));
  try {
    const decomposedName = "e\u0301chantillon.txt";
    await writeFile(path.join(root, decomposedName), "unicode explicit path\n");
    const outcome = await buildExplicitFileManifest(root, [
      { sourcePath: decomposedName, depositPath: "data.txt" },
    ]);
    assert.ok(outcome.manifest);
    assert.equal(outcome.issues.length, 0);
    assert.equal(outcome.manifest?.entries[0].sourcePath, "échantillon.txt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
