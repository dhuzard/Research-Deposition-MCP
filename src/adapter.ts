import type { ResearchDeposit } from "./model.js";

export interface DraftResult {
  id: string;
  htmlUrl?: string;
  reservedDoi?: string;
  raw?: unknown;
}

export interface RepositoryAdapter {
  readonly name: string;
  createDraft(metadata: ResearchDeposit): Promise<DraftResult>;
  getDraft(id: string): Promise<unknown>;
  updateDraft(id: string, metadata: ResearchDeposit): Promise<DraftResult>;
  uploadFile(id: string, filePath: string, remoteName?: string): Promise<unknown>;
  publishDraft(id: string): Promise<unknown>;
}
