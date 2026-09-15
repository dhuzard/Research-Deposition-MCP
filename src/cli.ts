#!/usr/bin/env node
import { checkLocalPackage, digestLocalPackage } from "./local-package.js";
import type { ValidationIssue } from "./model.js";

const DISALLOWED_FLAGS = new Set(["--token", "--api-key", "--repository-token", "--zenodo-api-key"]);

function usage(): void {
  process.stderr.write(`Usage:
  research-deposition status [--json]
  research-deposition package check <config.json> [--json]
  research-deposition package digest <config.json> [--json]
`);
}

interface ParsedArgs {
  json: boolean;
  positionals: string[];
}

function parseArgs(args: string[]): ParsedArgs | undefined {
  let json = false;
  const positionals: string[] = [];
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    const flagName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (DISALLOWED_FLAGS.has(flagName)) {
      process.stderr.write("Unsupported credential flag. Repository tokens must never be passed on the command line.\n");
      return undefined;
    }
    if (arg.startsWith("--")) {
      process.stderr.write("Unknown flag.\n");
      return undefined;
    }
    positionals.push(arg);
  }
  return { json, positionals };
}

function sanitizeBaseUrl(raw: string): { baseUrl: string; hostname: string } | undefined {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return { baseUrl: url.toString().replace(/\/$/, ""), hostname: url.hostname };
  } catch {
    return undefined;
  }
}

function statusPayload() {
  const rawBaseUrl = process.env.ZENODO_BASE_URL ?? "https://sandbox.zenodo.org";
  const sanitized = sanitizeBaseUrl(rawBaseUrl);
  return {
    repository: "zenodo",
    baseUrl: sanitized?.baseUrl ?? "invalid",
    sandbox: sanitized?.hostname === "sandbox.zenodo.org",
    authenticated: Boolean(process.env.ZENODO_API_KEY),
    publicationEnabled: /^(1|true)$/i.test(process.env.ZENODO_ALLOW_PUBLISH ?? "false"),
  };
}

function runStatus(json: boolean): number {
  const payload = statusPayload();
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`repository: ${payload.repository}\n`);
  process.stdout.write(`baseUrl: ${payload.baseUrl}\n`);
  process.stdout.write(`sandbox: ${payload.sandbox}\n`);
  process.stdout.write(`authenticated: ${payload.authenticated}\n`);
  process.stdout.write(`publicationEnabled: ${payload.publicationEnabled}\n`);
  return 0;
}

function issueLine(issue: ValidationIssue): string {
  return `[${issue.severity}] ${issue.code}${issue.path ? ` (${issue.path})` : ""}: ${issue.message}`;
}

async function runCheck(configPath: string, json: boolean): Promise<number> {
  const result = await checkLocalPackage(configPath);
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(result.report.valid ? "Package config is valid.\n" : "Package config is invalid.\n");
    for (const issue of result.report.issues) process.stdout.write(`${issueLine(issue)}\n`);
    if (result.manifest) {
      process.stdout.write(`Files: ${result.manifest.entries.length}\n`);
      for (const entry of result.manifest.entries) {
        process.stdout.write(`  ${entry.sourcePath} -> ${entry.depositPath} (${entry.size} bytes, sha256:${entry.sha256})\n`);
      }
    }
  }
  return result.report.valid ? 0 : 1;
}

async function runDigest(configPath: string, json: boolean): Promise<number> {
  const result = await digestLocalPackage(configPath);
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(result.report.valid ? "Package config is valid.\n" : "Package config is invalid.\n");
    for (const issue of result.report.issues) process.stdout.write(`${issueLine(issue)}\n`);
    if (result.digest) {
      process.stdout.write(`Digest: ${result.digest}\n`);
      process.stdout.write(`Files: ${result.manifest?.entries.length ?? 0}\n`);
    }
  }
  return result.report.valid ? 0 : 1;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "status") {
    const parsed = parseArgs(rest);
    if (!parsed || parsed.positionals.length > 0) {
      usage();
      return 2;
    }
    return runStatus(parsed.json);
  }

  if (command === "package") {
    const [subcommand, ...subRest] = rest;
    if (subcommand !== "check" && subcommand !== "digest") {
      usage();
      return 2;
    }
    const parsed = parseArgs(subRest);
    if (!parsed || parsed.positionals.length !== 1) {
      usage();
      return 2;
    }
    const [configPath] = parsed.positionals;
    return subcommand === "check" ? runCheck(configPath, parsed.json) : runDigest(configPath, parsed.json);
  }

  usage();
  return 2;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unexpected error.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
