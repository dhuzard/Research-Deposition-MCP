import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
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
