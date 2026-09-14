#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createApprovalRequest,
  normalizeRepositoryTarget,
  publicKeyFingerprint,
  verifyApprovalReceipt,
} from "./approval.js";
import { buildFileManifest, ManifestError, serializeManifest } from "./manifest.js";
import {
  buildPublicationIdentity,
  PackageIdentityError,
} from "./package-identity.js";
import { validateDeposit } from "./model.js";
import { ZenodoAdapter } from "./adapters/zenodo.js";

const baseUrl = process.env.ZENODO_BASE_URL ?? "https://sandbox.zenodo.org";
const token = process.env.ZENODO_API_KEY;
const allowPublish = /^(1|true)$/i.test(process.env.ZENODO_ALLOW_PUBLISH ?? "false");
const maxUploadBytes = Number(process.env.ZENODO_MAX_UPLOAD_BYTES ?? 50 * 1024 * 1024);
const approvalPublicKeyFile = process.env.DEPOSITION_APPROVAL_PUBLIC_KEY_FILE;
const publicationPolicyVersion = process.env.DEPOSITION_PUBLICATION_POLICY_VERSION ?? "1";
const approvalMaxAgeSeconds = Number(process.env.DEPOSITION_APPROVAL_MAX_AGE_SECONDS ?? 900);

if (!Number.isSafeInteger(approvalMaxAgeSeconds) || approvalMaxAgeSeconds <= 0) {
  throw new Error("DEPOSITION_APPROVAL_MAX_AGE_SECONDS must be a positive integer.");
}

const approvalPublicKey = approvalPublicKeyFile
  ? await readFile(approvalPublicKeyFile, "utf8")
  : undefined;
const repository = new ZenodoAdapter({ baseUrl, token, maxUploadBytes });
const repositoryTarget = normalizeRepositoryTarget(baseUrl);
const server = new McpServer({ name: "research-deposition-mcp", version: "0.2.0-dev" });

const packageInputFields = {
  metadata: z.unknown(),
  rootDir: z.string().min(1),
  include: z.array(z.string().min(1)).min(1),
  exclude: z.array(z.string().min(1)).optional(),
  destinations: z.record(z.string(), z.string()).optional(),
};

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function packageFailure(error: unknown) {
  if (error instanceof ManifestError) {
    return {
      ...text({ error: error.code, message: error.message, path: error.manifestPath }),
      isError: true,
    };
  }
  if (error instanceof PackageIdentityError) {
    return {
      ...text({ error: error.code, message: error.message, details: error.details }),
      isError: true,
    };
  }
  throw error;
}

async function packageIdentity(input: {
  metadata: unknown;
  rootDir: string;
  include: string[];
  exclude?: string[];
  destinations?: Record<string, string>;
}) {
  return buildPublicationIdentity(input.metadata, input.rootDir, {
    include: input.include,
    exclude: input.exclude,
    destinations: input.destinations,
  });
}

function approvalRequestFor(id: string, packageDigest: string) {
  return createApprovalRequest({
    packageDigest,
    repository: repository.name,
    repositoryTarget,
    draftId: id,
    policyVersion: publicationPolicyVersion,
  });
}

server.registerTool("deposition_status", {
  description: "Report deposition backend and safety configuration. Does not expose secrets.",
  inputSchema: {},
}, async () => text({
  repository: repository.name,
  baseUrl,
  sandbox: baseUrl.includes("sandbox.zenodo.org"),
  authenticated: Boolean(token),
  publicationEnabled: allowPublish,
  publicationPolicyVersion,
  approvalVerifierConfigured: Boolean(approvalPublicKey),
  approvalKeyId: approvalPublicKey ? publicKeyFingerprint(approvalPublicKey) : undefined,
  approvalMaxAgeSeconds,
}));

server.registerTool("validate_deposition", {
  description: "Deterministically validate repository-independent research deposition metadata. Never publishes anything.",
  inputSchema: { metadata: z.unknown() },
}, async ({ metadata }) => text(validateDeposit(metadata).report));

server.registerTool("build_file_manifest", {
  description: "Build a deterministic repository-independent SHA-256 manifest from explicit include/exclude rules. Never uploads or publishes files.",
  inputSchema: {
    rootDir: z.string().min(1),
    include: z.array(z.string().min(1)).min(1),
    exclude: z.array(z.string().min(1)).optional(),
    destinations: z.record(z.string(), z.string()).optional(),
  },
}, async ({ rootDir, include, exclude, destinations }) => {
  try {
    const manifest = await buildFileManifest(rootDir, { include, exclude, destinations });
    return text({ manifest, canonical: serializeManifest(manifest) });
  } catch (error) {
    return packageFailure(error);
  }
});

server.registerTool("build_publication_package", {
  description: "Build canonical metadata + file manifest and compute the package SHA-256 identity. Never writes to a repository.",
  inputSchema: packageInputFields,
}, async (input) => {
  try {
    return text(await packageIdentity(input));
  } catch (error) {
    return packageFailure(error);
  }
});

server.registerTool("create_draft", {
  description: "Validate metadata and create an unpublished repository draft. Default backend is Zenodo Sandbox.",
  inputSchema: { metadata: z.unknown() },
}, async ({ metadata }) => {
  const result = validateDeposit(metadata);
  if (!result.data || !result.report.valid) return { ...text(result.report), isError: true };
  const draft = await repository.createDraft(result.data);
  return text({ draft, validation: result.report, published: false });
});

server.registerTool("get_draft", {
  description: "Retrieve an existing unpublished deposition draft.",
  inputSchema: { id: z.string().min(1) },
}, async ({ id }) => text(await repository.getDraft(id)));

server.registerTool("update_draft", {
  description: "Validate and replace metadata on an existing unpublished draft.",
  inputSchema: { id: z.string().min(1), metadata: z.unknown() },
}, async ({ id, metadata }) => {
  const result = validateDeposit(metadata);
  if (!result.data || !result.report.valid) return { ...text(result.report), isError: true };
  return text({ draft: await repository.updateDraft(id, result.data), validation: result.report });
});

server.registerTool("upload_file", {
  description: "Upload a local file to an existing draft. Never publishes the draft.",
  inputSchema: {
    id: z.string().min(1),
    filePath: z.string().min(1),
    remoteName: z.string().min(1).optional(),
  },
}, async ({ id, filePath, remoteName }) => text(await repository.uploadFile(id, filePath, remoteName)));

server.registerTool("publication_review", {
  description: "Rebuild the exact package identity, retrieve the draft, and return the approval request a human operator may sign out-of-band. Does not publish.",
  inputSchema: { id: z.string().min(1), ...packageInputFields },
}, async ({ id, ...input }) => {
  try {
    const [draft, identity] = await Promise.all([
      repository.getDraft(id),
      packageIdentity(input),
    ]);
    const approvalRequest = approvalRequestFor(id, identity.digest);
    return text({
      draft,
      package: identity,
      approvalRequest,
      publicationEnabled: allowPublish,
      approvalVerifierConfigured: Boolean(approvalPublicKey),
      warning: "Publication creates a persistent scholarly record. Review the draft and canonical package, then sign the approval request using the separate operator-side approval CLI.",
    });
  } catch (error) {
    return packageFailure(error);
  }
});

server.registerTool("publish_draft", {
  description: "Publish only when process-level publication is enabled and a valid short-lived operator-signed receipt matches a freshly recomputed package, repository endpoint, draft, and policy.",
  inputSchema: {
    id: z.string().min(1),
    receipt: z.unknown(),
    ...packageInputFields,
  },
}, async ({ id, receipt, ...input }) => {
  if (!allowPublish) {
    return {
      ...text({ error: "publication_disabled", message: "Publication is disabled. Set ZENODO_ALLOW_PUBLISH=true only in an explicitly authorized environment." }),
      isError: true,
    };
  }
  if (!approvalPublicKey) {
    return {
      ...text({ error: "approval_verifier_unconfigured", message: "Final publication requires DEPOSITION_APPROVAL_PUBLIC_KEY_FILE to point to the operator public key." }),
      isError: true,
    };
  }

  try {
    // Recompute immediately before publication. Any metadata or selected-file
    // mutation after approval changes the digest and invalidates the receipt.
    const identity = await packageIdentity(input);
    const expected = approvalRequestFor(id, identity.digest);
    const approval = verifyApprovalReceipt(receipt, approvalPublicKey, expected, {
      maxAgeSeconds: approvalMaxAgeSeconds,
    });
    if (!approval.valid) {
      return {
        ...text({ error: "approval_invalid", approval, currentPackageDigest: identity.digest }),
        isError: true,
      };
    }

    // Confirm the target draft still exists immediately before the irreversible action.
    await repository.getDraft(id);
    const published = await repository.publishDraft(id);
    return text({ published, packageDigest: identity.digest, approval });
  } catch (error) {
    return packageFailure(error);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
