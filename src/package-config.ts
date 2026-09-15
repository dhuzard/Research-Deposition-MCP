import { z } from "zod";
import { ResearchDepositSchema, validateDeposit, type ValidationIssue, type ValidationReport } from "./model.js";

export const PackageFileEntrySchema = z
  .object({
    sourcePath: z.string().min(1),
    depositName: z.string().min(1),
  })
  .strict();

export type PackageFileEntry = z.infer<typeof PackageFileEntrySchema>;

export const PackageConfigSchema = z
  .object({
    schemaVersion: z.literal("1"),
    metadata: ResearchDepositSchema,
    files: z.array(PackageFileEntrySchema).min(1),
  })
  .strict();

export type PackageConfig = z.infer<typeof PackageConfigSchema>;

/**
 * Validates the structural shape of a package config: schema version,
 * repository-independent metadata (via `ResearchDepositSchema`), and an
 * explicit, non-empty list of file entries. Does not touch the filesystem;
 * see `buildManifest` for file-safety checks (missing files, symlinks,
 * duplicate normalized paths, etc.).
 */
export function validatePackageConfig(input: unknown): { data?: PackageConfig; report: ValidationReport } {
  const parsed = PackageConfigSchema.safeParse(input);
  const issues: ValidationIssue[] = [];

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        severity: "error",
        code: "schema",
        message: issue.message,
        path: issue.path.join("."),
      });
    }
    return { report: { valid: false, issues } };
  }

  const data = parsed.data;
  const metadataResult = validateDeposit(data.metadata);
  issues.push(...metadataResult.report.issues.map((issue) => ({ ...issue, path: issue.path ? `metadata.${issue.path}` : "metadata" })));

  return { data, report: { valid: !issues.some((i) => i.severity === "error"), issues } };
}
