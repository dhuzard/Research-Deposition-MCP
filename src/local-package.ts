import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildExplicitFileManifest, type FileManifest } from "./manifest.js";
import { createPublicationIdentity, PackageIdentityError } from "./package-identity.js";
import { validatePackageConfig, type PackageConfig } from "./package-config.js";
import type { ValidationIssue, ValidationReport } from "./model.js";

export interface LocalPackageCheckResult {
  report: ValidationReport;
  manifest?: FileManifest;
}

export interface LocalPackageDigestResult {
  report: ValidationReport;
  manifest?: FileManifest;
  digest?: string;
}

interface LoadedConfig {
  data?: PackageConfig;
  issues: ValidationIssue[];
}

async function loadPackageConfig(configPath: string): Promise<LoadedConfig> {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return { issues: [{ severity: "error", code: "config_not_found", message: "Package config file was not found." }] };
    }
    return {
      issues: [{
        severity: "error",
        code: "config_unavailable",
        message: `Package config file could not be read (${err.code ?? "unknown_error"}).`,
      }],
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { issues: [{ severity: "error", code: "config_invalid_json", message: "Package config is not valid JSON." }] };
  }

  const { data, report } = validatePackageConfig(raw);
  return { data, issues: report.issues };
}

interface ResolvedPackage {
  data?: PackageConfig;
  issues: ValidationIssue[];
  manifest?: FileManifest;
}

async function resolveLocalPackage(configPath: string): Promise<ResolvedPackage> {
  const { data, issues: configIssues } = await loadPackageConfig(configPath);
  if (!data) return { issues: configIssues };

  const rootDir = path.dirname(path.resolve(configPath));
  const entries = data.files.map((file) => ({ sourcePath: file.sourcePath, depositPath: file.depositName }));
  const { manifest, issues: fileIssues } = await buildExplicitFileManifest(rootDir, entries);

  return { data, issues: [...configIssues, ...fileIssues], manifest };
}

/**
 * Validate a package config's structure, metadata, and every selected file
 * without touching a repository. The directory containing `configPath` is
 * the implicit root that `sourcePath` entries are resolved against.
 */
export async function checkLocalPackage(configPath: string): Promise<LocalPackageCheckResult> {
  const resolved = await resolveLocalPackage(configPath);
  const valid = !resolved.issues.some((issue) => issue.severity === "error");
  return { report: { valid, issues: resolved.issues }, manifest: valid ? resolved.manifest : undefined };
}

/**
 * Same validation as `checkLocalPackage`, plus the deterministic package
 * digest when the config, metadata, and files are all valid.
 */
export async function digestLocalPackage(configPath: string): Promise<LocalPackageDigestResult> {
  const resolved = await resolveLocalPackage(configPath);
  const valid = !resolved.issues.some((issue) => issue.severity === "error");
  if (!valid || !resolved.data || !resolved.manifest) {
    return { report: { valid, issues: resolved.issues } };
  }

  try {
    const identity = createPublicationIdentity(resolved.data.metadata, resolved.manifest);
    return { report: { valid: true, issues: resolved.issues }, manifest: resolved.manifest, digest: identity.digest };
  } catch (error) {
    if (error instanceof PackageIdentityError) {
      return {
        report: {
          valid: false,
          issues: [...resolved.issues, { severity: "error", code: error.code, message: error.message }],
        },
      };
    }
    throw error;
  }
}
