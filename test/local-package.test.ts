import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkLocalPackage, digestLocalPackage } from "../src/local-package.js";

const validMetadata = {
  title: "Example dataset",
  description: "A sufficiently descriptive test research dataset.",
  resourceType: "dataset",
  creators: [{ name: "Doe, Jane", orcid: "0000-0002-1825-0097" }],
  license: "MIT",
  keywords: ["FAIR"],
};

async function withPackageFixture(
  files: Record<string, string>,
  configFiles: { sourcePath: string; depositName: string }[],
  run: (root: string, configPath: string) => Promise<void>,
  metadata: unknown = validMetadata,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rdm-local-package-"));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const filePath = path.join(root, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content);
    }
    const configPath = path.join(root, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({ schemaVersion: "1", metadata, files: configFiles }, null, 2),
    );
    await run(root, configPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("checkLocalPackage accepts a well-formed config and returns a manifest", async () => {
  await withPackageFixture(
    { "data/readings.csv": "id,value\n1,2\n" },
    [{ sourcePath: "data/readings.csv", depositName: "readings.csv" }],
    async (_root, configPath) => {
      const result = await checkLocalPackage(configPath);
      assert.equal(result.report.valid, true);
      assert.equal(result.manifest?.entries.length, 1);
      assert.equal(result.manifest?.entries[0].sourcePath, "data/readings.csv");
      assert.equal(result.manifest?.entries[0].depositPath, "readings.csv");
    },
  );
});

test("checkLocalPackage reports invalid metadata without a manifest", async () => {
  await withPackageFixture(
    { "data/readings.csv": "id,value\n1,2\n" },
    [{ sourcePath: "data/readings.csv", depositName: "readings.csv" }],
    async (_root, configPath) => {
      const result = await checkLocalPackage(configPath);
      assert.equal(result.report.valid, false);
      assert.equal(result.manifest, undefined);
      assert.ok(result.report.issues.some((issue) => issue.severity === "error"));
    },
    { title: "x", creators: [] },
  );
});

test("checkLocalPackage reports a missing selected file as an error", async () => {
  await withPackageFixture(
    {},
    [{ sourcePath: "data/missing.csv", depositName: "missing.csv" }],
    async (_root, configPath) => {
      const result = await checkLocalPackage(configPath);
      assert.equal(result.report.valid, false);
      assert.ok(result.report.issues.some((issue) => issue.code === "file_missing"));
    },
  );
});

test("checkLocalPackage rejects a traversal source path", async () => {
  await withPackageFixture(
    {},
    [{ sourcePath: "../outside.csv", depositName: "outside.csv" }],
    async (_root, configPath) => {
      const result = await checkLocalPackage(configPath);
      assert.equal(result.report.valid, false);
      assert.ok(result.report.issues.some((issue) => issue.code === "path_traversal"));
    },
  );
});

test("checkLocalPackage rejects an absolute source path", async () => {
  await withPackageFixture(
    {},
    [{ sourcePath: "/etc/passwd", depositName: "passwd" }],
    async (_root, configPath) => {
      const result = await checkLocalPackage(configPath);
      assert.equal(result.report.valid, false);
      assert.ok(result.report.issues.some((issue) => issue.code === "absolute_path"));
    },
  );
});

test("checkLocalPackage does not treat literal wildcard characters as globs", async () => {
  await withPackageFixture(
    { "data/[weird]*name?.csv": "id\n1\n" },
    [{ sourcePath: "data/[weird]*name?.csv", depositName: "weird.csv" }],
    async (_root, configPath) => {
      const result = await checkLocalPackage(configPath);
      assert.equal(result.report.valid, true);
      assert.equal(result.manifest?.entries.length, 1);
    },
  );
});

test("checkLocalPackage output omits the absolute local root", async () => {
  await withPackageFixture(
    { "data/readings.csv": "id,value\n1,2\n" },
    [{ sourcePath: "data/readings.csv", depositName: "readings.csv" }],
    async (root, configPath) => {
      const result = await checkLocalPackage(configPath);
      assert.ok(!JSON.stringify(result).includes(root));
    },
  );
});

test("digestLocalPackage returns a stable digest for identical content in different roots", async () => {
  const build = async (): Promise<string> => {
    let digest = "";
    await withPackageFixture(
      { "data/readings.csv": "id,value\n1,2\n" },
      [{ sourcePath: "data/readings.csv", depositName: "readings.csv" }],
      async (_root, configPath) => {
        const result = await digestLocalPackage(configPath);
        assert.equal(result.report.valid, true);
        assert.ok(result.digest);
        digest = result.digest!;
      },
    );
    return digest;
  };

  const first = await build();
  const second = await build();
  assert.equal(first, second);
});

test("digestLocalPackage changes when file content changes", async () => {
  await withPackageFixture(
    { "data/readings.csv": "id,value\n1,2\n" },
    [{ sourcePath: "data/readings.csv", depositName: "readings.csv" }],
    async (root, configPath) => {
      const before = await digestLocalPackage(configPath);
      await writeFile(path.join(root, "data", "readings.csv"), "id,value\n1,3\n");
      const after = await digestLocalPackage(configPath);
      assert.notEqual(before.digest, after.digest);
    },
  );
});

test("digestLocalPackage changes when depositName changes", async () => {
  const buildWithDepositName = async (depositName: string) => {
    let digest = "";
    await withPackageFixture(
      { "data/readings.csv": "id,value\n1,2\n" },
      [{ sourcePath: "data/readings.csv", depositName }],
      async (_root, configPath) => {
        const result = await digestLocalPackage(configPath);
        assert.ok(result.digest);
        digest = result.digest!;
      },
    );
    return digest;
  };

  const first = await buildWithDepositName("readings.csv");
  const second = await buildWithDepositName("renamed.csv");
  assert.notEqual(first, second);
});

test("checkLocalPackage rejects a source path that traverses a symlinked directory", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows symlink creation may require elevated privileges");
    return;
  }

  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "rdm-local-package-outside-"));
  try {
    await writeFile(path.join(outsideDir, "secret.csv"), "id,value\n99,99\n");
    await withPackageFixture(
      {},
      [{ sourcePath: "data/secret.csv", depositName: "secret.csv" }],
      async (root, configPath) => {
        await mkdir(path.dirname(path.join(root, "data")), { recursive: true });
        await symlink(outsideDir, path.join(root, "data"), "dir");

        const result = await checkLocalPackage(configPath);
        assert.equal(result.report.valid, false);
        assert.equal(result.manifest, undefined);
        assert.ok(result.report.issues.some((issue) => issue.code === "symlink_rejected"));
        assert.ok(!JSON.stringify(result).includes(outsideDir));
      },
    );
  } finally {
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("digestLocalPackage does not compute a digest when the package is invalid", async () => {
  await withPackageFixture(
    {},
    [{ sourcePath: "data/missing.csv", depositName: "missing.csv" }],
    async (_root, configPath) => {
      const result = await digestLocalPackage(configPath);
      assert.equal(result.report.valid, false);
      assert.equal(result.digest, undefined);
    },
  );
});
