import { createHash } from "node:crypto";
import {
  canonicalJson,
  canonicalJsonLine,
  compareCanonicalStrings,
  normalizeCanonicalString,
  type CanonicalJsonValue,
} from "./canonical-json.js";
import {
  buildFileManifest,
  canonicalizeManifest,
  type FileManifest,
  type FileSelectionRules,
} from "./manifest.js";
import { validateDeposit, type ResearchDeposit, type ValidationReport } from "./model.js";

export const CANONICAL_METADATA_SCHEMA_VERSION = "1" as const;
export const PUBLICATION_PACKAGE_SCHEMA_VERSION = "1" as const;
export const PACKAGE_DIGEST_DOMAIN = "research-deposition-package-v1\0";

export interface CanonicalCreator {
  name: string;
  orcid?: string;
  affiliation?: string;
}

export interface CanonicalRelatedIdentifier {
  identifier: string;
  relation: string;
  resourceType?: string;
}

export interface CanonicalResearchDeposit {
  schemaVersion: typeof CANONICAL_METADATA_SCHEMA_VERSION;
  title: string;
  description: string;
  resourceType: ResearchDeposit["resourceType"];
  creators: CanonicalCreator[];
  keywords: string[];
  license?: string;
  version?: string;
  publicationDate?: string;
  relatedIdentifiers: CanonicalRelatedIdentifier[];
  notes?: string;
}

export interface PublicationPackage {
  schemaVersion: typeof PUBLICATION_PACKAGE_SCHEMA_VERSION;
  metadata: CanonicalResearchDeposit;
  manifest: FileManifest;
}

export interface PublicationIdentity {
  package: PublicationPackage;
  canonical: string;
  digest: string;
  validation: ValidationReport;
}

export class PackageIdentityError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "PackageIdentityError";
  }
}

function nfc(value: string): string {
  return normalizeCanonicalString(value);
}

function canonicalCreator(creator: ResearchDeposit["creators"][number]): CanonicalCreator {
  return {
    name: nfc(creator.name),
    ...(creator.orcid !== undefined ? { orcid: nfc(creator.orcid) } : {}),
    ...(creator.affiliation !== undefined ? { affiliation: nfc(creator.affiliation) } : {}),
  };
}

function canonicalRelatedIdentifier(
  related: ResearchDeposit["relatedIdentifiers"][number],
): CanonicalRelatedIdentifier {
  return {
    identifier: nfc(related.identifier),
    relation: nfc(related.relation),
    ...(related.resourceType !== undefined ? { resourceType: nfc(related.resourceType) } : {}),
  };
}

function compareRelated(a: CanonicalRelatedIdentifier, b: CanonicalRelatedIdentifier): number {
  return (
    compareCanonicalStrings(a.identifier, b.identifier)
    || compareCanonicalStrings(a.relation, b.relation)
    || compareCanonicalStrings(a.resourceType ?? "", b.resourceType ?? "")
  );
}

function dedupeSorted<T>(items: T[], identity: (item: T) => string): T[] {
  const output: T[] = [];
  let previous: string | undefined;
  for (const item of items) {
    const current = identity(item);
    if (current !== previous) output.push(item);
    previous = current;
  }
  return output;
}

/**
 * Validate and canonicalize repository-independent scientific metadata.
 *
 * Semantic choices in schema v1:
 * - creator order is preserved because authorship order can be meaningful;
 * - keywords and related identifiers are treated as unordered sets and sorted;
 * - absent optional fields remain absent;
 * - null is invalid under ResearchDepositSchema;
 * - empty strings are preserved only where the source schema permits them;
 * - unknown/unmodeled input fields are stripped by Zod validation and therefore
 *   do not enter the scientific package identity.
 */
export function canonicalizeResearchDeposit(input: unknown): {
  metadata: CanonicalResearchDeposit;
  validation: ValidationReport;
} {
  const result = validateDeposit(input);
  if (!result.data || !result.report.valid) {
    throw new PackageIdentityError(
      "invalid_metadata",
      "Research deposition metadata is invalid and cannot be canonicalized.",
      result.report,
    );
  }

  const data = result.data;
  const keywords = [...new Set(data.keywords.map(nfc))].sort(compareCanonicalStrings);
  const related = data.relatedIdentifiers.map(canonicalRelatedIdentifier).sort(compareRelated);
  const relatedIdentifiers = dedupeSorted(related, (item) => canonicalJson(item as unknown as CanonicalJsonValue));

  const metadata: CanonicalResearchDeposit = {
    schemaVersion: CANONICAL_METADATA_SCHEMA_VERSION,
    title: nfc(data.title),
    description: nfc(data.description),
    resourceType: data.resourceType,
    creators: data.creators.map(canonicalCreator),
    keywords,
    ...(data.license !== undefined ? { license: nfc(data.license) } : {}),
    ...(data.version !== undefined ? { version: nfc(data.version) } : {}),
    ...(data.publicationDate !== undefined ? { publicationDate: data.publicationDate } : {}),
    relatedIdentifiers,
    ...(data.notes !== undefined ? { notes: nfc(data.notes) } : {}),
  };

  return { metadata, validation: result.report };
}

export function serializeCanonicalMetadata(metadata: CanonicalResearchDeposit): string {
  return canonicalJsonLine(metadata as unknown as CanonicalJsonValue);
}

export function createPublicationIdentity(
  metadataInput: unknown,
  manifestInput: FileManifest,
): PublicationIdentity {
  const { metadata, validation } = canonicalizeResearchDeposit(metadataInput);
  const manifest = canonicalizeManifest(manifestInput);
  const publicationPackage: PublicationPackage = {
    schemaVersion: PUBLICATION_PACKAGE_SCHEMA_VERSION,
    metadata,
    manifest,
  };
  const canonical = canonicalJsonLine(publicationPackage as unknown as CanonicalJsonValue);
  const hex = createHash("sha256")
    .update(PACKAGE_DIGEST_DOMAIN, "utf8")
    .update(canonical, "utf8")
    .digest("hex");

  return {
    package: publicationPackage,
    canonical,
    digest: `sha256:${hex}`,
    validation,
  };
}

export async function buildPublicationIdentity(
  metadataInput: unknown,
  rootDir: string,
  rules: FileSelectionRules,
): Promise<PublicationIdentity> {
  const manifest = await buildFileManifest(rootDir, rules);
  return createPublicationIdentity(metadataInput, manifest);
}
