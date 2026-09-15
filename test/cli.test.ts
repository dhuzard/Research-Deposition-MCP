import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

const validMetadata = {
  title: "Example dataset",
  description: "A sufficiently descriptive test research dataset.",
  resourceType: "dataset",
  creators: [{ name: "Doe, Jane", orcid: "0000-0002-1825-0097" }],
  license: "MIT",
  keywords: ["FAIR"],
};

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_PATH, ...args], {
      env: { ...process.env, ...env },
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1 };
  }
}

async function withPackageFixture(
  files: Record<string, string>,
  configFiles: { sourcePath: string; depositName: string }[],
  run: (root: string, configPath: string) => Promise<void>,
  metadata: unknown = validMetadata,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rdm-cli-"));
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

test("status reports repository, sandbox default, and no secrets", async () => {
  const result = await runCli(["status", "--json"], { ZENODO_API_KEY: "" });
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.repository, "zenodo");
  assert.equal(payload.baseUrl, "https://sandbox.zenodo.org");
  assert.equal(payload.sandbox, true);
  assert.equal(payload.authenticated, false);
  assert.equal(payload.publicationEnabled, false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "token"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "apiKey"), false);
});

test("status represents a configured token only as a boolean, never its value", async () => {
  const secret = "s3cr3t-token-value";
  const result = await runCli(["status", "--json"], { ZENODO_API_KEY: secret });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.includes(secret), false);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.authenticated, true);
});

test("status --json emits exactly one parseable JSON document and nothing else on stdout", async () => {
  const result = await runCli(["status", "--json"]);
  assert.equal(result.code, 0);
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  assert.equal(result.stdout.trim().split("\n\n").length, 1);
});

test("package check succeeds on a valid config and exits 0", async () => {
  await withPackageFixture(
    { "data/readings.csv": "id,value\n1,2\n" },
    [{ sourcePath: "data/readings.csv", depositName: "readings.csv" }],
    async (_root, configPath) => {
      const result = await runCli(["package", "check", configPath, "--json"]);
      assert.equal(result.code, 0);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.report.valid, true);
      assert.equal(payload.manifest.entries.length, 1);
    },
  );
});

test("package check with warning-only issues still exits 0", async () => {
  await withPackageFixture(
    { "data/readings.csv": "id,value\n1,2\n" },
    [{ sourcePath: "data/readings.csv", depositName: "readings.csv" }],
    async (_root, configPath) => {
      const result = await runCli(["package", "check", configPath, "--json"]);
      assert.equal(result.code, 0);
      const payload = JSON.parse(result.stdout);
      assert.ok(payload.report.issues.some((issue: { code: string }) => issue.code === "missing_orcid"));
    },
    {
      title: "Example dataset",
      description: "A sufficiently descriptive test research dataset.",
      resourceType: "dataset",
      creators: [{ name: "Doe, Jane" }],
    },
  );
});

test("package check on invalid metadata exits 1 and reports errors via --json", async () => {
  await withPackageFixture(
    { "data/readings.csv": "id,value\n1,2\n" },
    [{ sourcePath: "data/readings.csv", depositName: "readings.csv" }],
    async (_root, configPath) => {
      const result = await runCli(["package", "check", configPath, "--json"]);
      assert.equal(result.code, 1);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.report.valid, false);
    },
    { title: "x", creators: [] },
  );
});

test("package check on an unsafe (traversal) path exits 1", async () => {
  await withPackageFixture(
    {},
    [{ sourcePath: "../secret.csv", depositName: "secret.csv" }],
    async (_root, configPath) => {
      const result = await runCli(["package", "check", configPath, "--json"]);
      assert.equal(result.code, 1);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.report.valid, false);
      assert.ok(payload.report.issues.some((issue: { code: string }) => issue.code === "path_traversal"));
    },
  );
});

test("package check on a missing file exits 1", async () => {
  await withPackageFixture(
    {},
    [{ sourcePath: "data/missing.csv", depositName: "missing.csv" }],
    async (_root, configPath) => {
      const result = await runCli(["package", "check", configPath, "--json"]);
      assert.equal(result.code, 1);
      const payload = JSON.parse(result.stdout);
      assert.ok(payload.report.issues.some((issue: { code: string }) => issue.code === "file_missing"));
    },
  );
});

test("package digest is stable across two independent temp roots with identical content", async () => {
  const build = async (): Promise<string> => {
    let digest = "";
    await withPackageFixture(
      { "data/readings.csv": "id,value\n1,2\n" },
      [{ sourcePath: "data/readings.csv", depositName: "readings.csv" }],
      async (_root, configPath) => {
        const result = await runCli(["package", "digest", configPath, "--json"]);
        assert.equal(result.code, 0);
        digest = JSON.parse(result.stdout).digest;
        assert.ok(digest);
      },
    );
    return digest;
  };

  const first = await build();
  const second = await build();
  assert.equal(first, second);
});

test("package digest changes when selected file content changes", async () => {
  await withPackageFixture(
    { "data/readings.csv": "id,value\n1,2\n" },
    [{ sourcePath: "data/readings.csv", depositName: "readings.csv" }],
    async (root, configPath) => {
      const before = await runCli(["package", "digest", configPath, "--json"]);
      await writeFile(path.join(root, "data", "readings.csv"), "id,value\n1,9\n");
      const after = await runCli(["package", "digest", configPath, "--json"]);
      assert.notEqual(JSON.parse(before.stdout).digest, JSON.parse(after.stdout).digest);
    },
  );
});

test("package digest changes when depositName changes", async () => {
  const buildWithDepositName = async (depositName: string): Promise<string> => {
    let digest = "";
    await withPackageFixture(
      { "data/readings.csv": "id,value\n1,2\n" },
      [{ sourcePath: "data/readings.csv", depositName }],
      async (_root, configPath) => {
        const result = await runCli(["package", "digest", configPath, "--json"]);
        digest = JSON.parse(result.stdout).digest;
      },
    );
    return digest;
  };

  const first = await buildWithDepositName("readings.csv");
  const second = await buildWithDepositName("renamed.csv");
  assert.notEqual(first, second);
});

test("package digest does not include the raw config, canonical package JSON, or absolute local root", async () => {
  await withPackageFixture(
    { "data/readings.csv": "id,value\n1,2\n" },
    [{ sourcePath: "data/readings.csv", depositName: "readings.csv" }],
    async (root, configPath) => {
      const result = await runCli(["package", "digest", configPath, "--json"]);
      assert.equal(result.code, 0);
      assert.equal(result.stdout.includes(root), false);
      assert.equal(result.stderr.includes(root), false);
      const payload = JSON.parse(result.stdout);
      assert.equal(Object.prototype.hasOwnProperty.call(payload, "package"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(payload, "canonical"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(payload, "metadata"), false);
    },
  );
});

test("package digest is invalid and omits digest when the package is invalid", async () => {
  await withPackageFixture(
    {},
    [{ sourcePath: "data/missing.csv", depositName: "missing.csv" }],
    async (_root, configPath) => {
      const result = await runCli(["package", "digest", configPath, "--json"]);
      assert.equal(result.code, 1);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.report.valid, false);
      assert.equal(payload.digest, undefined);
    },
  );
});

test("unknown command exits 2 with usage on stderr and nothing on stdout", async () => {
  const result = await runCli(["bogus"]);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.ok(result.stderr.includes("Usage:"));
});

test("unsupported --token flag exits 2 and never reaches package logic", async () => {
  await withPackageFixture(
    { "data/readings.csv": "id,value\n1,2\n" },
    [{ sourcePath: "data/readings.csv", depositName: "readings.csv" }],
    async (_root, configPath) => {
      const result = await runCli(["package", "check", configPath, "--token", "secret-value"]);
      assert.equal(result.code, 2);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr.includes("secret-value"), false);
    },
  );
});

test("unsupported equals-form token flag exits 2 without echoing the credential", async () => {
  await withPackageFixture(
    { "data/readings.csv": "id,value\n1,2\n" },
    [{ sourcePath: "data/readings.csv", depositName: "readings.csv" }],
    async (_root, configPath) => {
      const result = await runCli(["package", "check", configPath, "--token=secret-value"]);
      assert.equal(result.code, 2);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr.includes("secret-value"), false);
    },
  );
});

test("missing config path argument exits 2", async () => {
  const result = await runCli(["package", "check"]);
  assert.equal(result.code, 2);
});

test("human-readable output (no --json) does not leak the temp root either", async () => {
  await withPackageFixture(
    { "data/readings.csv": "id,value\n1,2\n" },
    [{ sourcePath: "data/readings.csv", depositName: "readings.csv" }],
    async (root, configPath) => {
      const result = await runCli(["package", "check", configPath]);
      assert.equal(result.code, 0);
      assert.equal(result.stdout.includes(root), false);
      assert.ok(result.stdout.includes("valid"));
    },
  );
});
