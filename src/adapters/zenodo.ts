import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { RepositoryAdapter, DraftResult } from "../adapter.js";
import type { ResearchDeposit } from "../model.js";

export interface ZenodoConfig {
  baseUrl: string;
  token?: string;
  maxUploadBytes: number;
}

function toZenodoMetadata(d: ResearchDeposit) {
  return {
    title: d.title,
    description: d.description,
    upload_type: d.resourceType,
    creators: d.creators.map((c: ResearchDeposit["creators"][number]) => ({
      name: c.name,
      orcid: c.orcid,
      affiliation: c.affiliation,
    })),
    keywords: d.keywords,
    license: d.license,
    version: d.version,
    publication_date: d.publicationDate,
    related_identifiers: d.relatedIdentifiers.map((r: ResearchDeposit["relatedIdentifiers"][number]) => ({
      identifier: r.identifier,
      relation: r.relation,
      resource_type: r.resourceType,
    })),
    notes: d.notes,
    access_right: "open",
  };
}

export class ZenodoAdapter implements RepositoryAdapter {
  readonly name = "zenodo";

  constructor(private readonly config: ZenodoConfig) {}

  private headers(json = true): HeadersInit {
    if (!this.config.token) throw new Error("ZENODO_API_KEY is required for deposition operations");
    return {
      Authorization: `Bearer ${this.config.token}`,
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  private async jsonRequest(url: string, init: RequestInit): Promise<any> {
    const response = await fetch(url, init);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Zenodo ${response.status}: ${JSON.stringify(body)}`);
    return body;
  }

  private asDraft(body: any): DraftResult {
    return {
      id: String(body.id),
      htmlUrl: body.links?.html,
      reservedDoi: body.metadata?.prereserve_doi?.doi,
      raw: body,
    };
  }

  async createDraft(metadata: ResearchDeposit): Promise<DraftResult> {
    const body = await this.jsonRequest(`${this.config.baseUrl}/api/deposit/depositions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ metadata: toZenodoMetadata(metadata) }),
    });
    return this.asDraft(body);
  }

  async getDraft(id: string): Promise<unknown> {
    return this.jsonRequest(`${this.config.baseUrl}/api/deposit/depositions/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: this.headers(false),
    });
  }

  async updateDraft(id: string, metadata: ResearchDeposit): Promise<DraftResult> {
    const body = await this.jsonRequest(`${this.config.baseUrl}/api/deposit/depositions/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify({ metadata: toZenodoMetadata(metadata) }),
    });
    return this.asDraft(body);
  }

  async uploadFile(id: string, filePath: string, remoteName?: string): Promise<unknown> {
    const info = await this.getDraft(id) as any;
    const bucket = info.links?.bucket;
    if (!bucket) throw new Error("Zenodo draft did not expose an upload bucket");

    const size = (await stat(filePath)).size;
    if (size > this.config.maxUploadBytes) {
      throw new Error(`File is ${size} bytes, above configured limit ${this.config.maxUploadBytes}`);
    }

    const name = remoteName ?? basename(filePath);
    const response = await fetch(`${bucket}/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: this.headers(false),
      body: createReadStream(filePath) as any,
      duplex: "half" as any,
    } as RequestInit);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Zenodo ${response.status}: ${JSON.stringify(body)}`);
    return body;
  }

  async publishDraft(id: string): Promise<unknown> {
    return this.jsonRequest(`${this.config.baseUrl}/api/deposit/depositions/${encodeURIComponent(id)}/actions/publish`, {
      method: "POST",
      headers: this.headers(false),
    });
  }
}
