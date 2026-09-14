#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildFileManifest, ManifestError, serializeManifest } from "./manifest.js";
import { validateDeposit } from "./model.js";
import { ZenodoAdapter } from "./adapters/zenodo.js";

const baseUrl = process.env.ZENODO_BASE_URL ?? "https://sandbox.zenodo.org";
const token = process.env.ZENODO_API_KEY;
const allowPublish = /^(1|true)$/i.test(process.env.ZENODO_ALLOW_PUBLISH ?? "false");
const maxUploadBytes = Number(process.env.ZENODO_MAX_UPLOAD_BYTES ?? 50 * 1024 * 1024);

const repository = new ZenodoAdapter({ baseUrl, token, maxUploadBytes });
const server = new McpServer({ name: "research-deposition-mcp", version: "0.1.0" });

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
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
    if (error instanceof ManifestError) {
      return {
        ...text({
          error: error.code,
          message: error.message,
          path: error.manifestPath,
        }),
        isError: true,
      };
    }
    throw error;
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
  description: "Return the current draft plus the exact confirmation phrase required for publication. This does not publish.",
  inputSchema: { id: z.string().min(1) },
}, async ({ id }) => {
  const draft = await repository.getDraft(id);
  return text({
    draft,
    publicationEnabled: allowPublish,
    warning: "Publication creates a public scholarly record. Review authorship, files, licensing, identifiers, and metadata before continuing.",
    requiredConfirmation: `PUBLISH ${id}`,
  });
});

server.registerTool("publish_draft", {
  description: "Publish a reviewed draft. Disabled unless ZENODO_ALLOW_PUBLISH=true and an exact confirmation phrase is supplied.",
  inputSchema: { id: z.string().min(1), confirmation: z.string() },
}, async ({ id, confirmation }) => {
  if (!allowPublish) {
    return { ...text({ error: "Publication is disabled. Set ZENODO_ALLOW_PUBLISH=true only in an explicitly authorized environment." }), isError: true };
  }
  if (confirmation !== `PUBLISH ${id}`) {
    return { ...text({ error: `Exact confirmation required: PUBLISH ${id}` }), isError: true };
  }
  return text(await repository.publishDraft(id));
});

const transport = new StdioServerTransport();
await server.connect(transport);
