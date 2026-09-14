import { z } from "zod";

const orcid = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

export const CreatorSchema = z.object({
  name: z.string().min(1),
  orcid: z.string().regex(orcid, "ORCID must use 0000-0000-0000-0000 form").optional(),
  affiliation: z.string().min(1).optional(),
});

export const RelatedIdentifierSchema = z.object({
  identifier: z.string().min(1),
  relation: z.string().min(1),
  resourceType: z.string().min(1).optional(),
});

export const ResearchDepositSchema = z.object({
  title: z.string().min(3),
  description: z.string().min(10),
  resourceType: z.enum(["dataset", "software", "other"]),
  creators: z.array(CreatorSchema).min(1),
  keywords: z.array(z.string().min(1)).default([]),
  license: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  publicationDate: z.string().date().optional(),
  relatedIdentifiers: z.array(RelatedIdentifierSchema).default([]),
  notes: z.string().optional(),
});

export type ResearchDeposit = z.infer<typeof ResearchDepositSchema>;

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  path?: string;
}

export interface ValidationReport {
  valid: boolean;
  issues: ValidationIssue[];
}

export function validateDeposit(input: unknown): { data?: ResearchDeposit; report: ValidationReport } {
  const parsed = ResearchDepositSchema.safeParse(input);
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
  if (!data.license) {
    issues.push({ severity: "warning", code: "missing_license", message: "No license supplied; reuse conditions may be unclear." });
  }
  if (data.creators.some((c) => !c.orcid)) {
    issues.push({ severity: "warning", code: "missing_orcid", message: "At least one creator has no ORCID." });
  }
  if (data.keywords.length === 0) {
    issues.push({ severity: "warning", code: "missing_keywords", message: "No keywords supplied." });
  }

  return { data, report: { valid: !issues.some((i) => i.severity === "error"), issues } };
}
