import { mergeVideoProjects } from "./project-history";
import { parseVideoHtml, serializeVideoHtml } from "./video-document";

export const VIDEO_AUTOSAVE_DEBOUNCE_MS = 750;

export type VideoAutosaveStatus = "idle" | "unsaved" | "saving" | "saved" | "conflict" | "failed";

export type VideoDocumentWriteResult =
  | { kind: "saved"; sha256: string; revision?: number | null; path?: string; persistedContent?: string }
  | { kind: "conflict"; currentSha256: string | null }
  | { kind: "failed"; message: string };

export type VideoDocumentReadEnvelope = {
  content: string;
  path?: string;
  baseSha256: string | null;
  baseRevision: number | null;
};

export type VideoAutosaveState = {
  status: VideoAutosaveStatus;
  dirty: boolean;
  errorMessage: string | null;
  conflictLatestContent: string | null;
  lastSavedAt: Date | null;
};

/** The exact saved document identity that a reviewed external action may bind. */
export type VideoSavedDocumentIdentity = Readonly<{
  sha256: string;
  revision: number | null;
}>;

export type VideoAutosaveListener = (state: VideoAutosaveState) => void;

export type VideoAutosaveWriteFn = (
  content: string,
  base: { sha256: string | null; revision: number | null },
) => Promise<VideoDocumentWriteResult>;

export type VideoAutosaveLoadLatestFn = () => Promise<VideoDocumentReadEnvelope | null>;

function parseWriteResponse(value: unknown): VideoDocumentWriteResult {
  if (!value || typeof value !== "object") {
    return { kind: "failed", message: "Unexpected save response." };
  }
  const record = value as Record<string, unknown>;
  if (record["kind"] === "saved" && typeof record["sha256"] === "string") {
    return {
      kind: "saved",
      sha256: record["sha256"],
      revision: typeof record["revision"] === "number" ? record["revision"] : null,
      ...(typeof record["path"] === "string" ? { path: record["path"] } : {}),
      ...(typeof record["persistedContent"] === "string" ? { persistedContent: record["persistedContent"] } : {}),
    };
  }
  if (record["kind"] === "conflict") {
    return {
      kind: "conflict",
      currentSha256: typeof record["currentSha256"] === "string" ? record["currentSha256"] : null,
    };
  }
  return { kind: "failed", message: "Unexpected save response." };
}

export class VideoAutosave {
  private savedContent = "";
  private draftContent = "";
  private baseSha256: string | null = null;
  private baseRevision: number | null = null;
  private status: VideoAutosaveStatus = "idle";
  private errorMessage: string | null = null;
  private conflictLatestContent: string | null = null;
  private lastSavedAt: Date | null = null;
  private initialLoadComplete = false;
  private saveGeneration = 0;
  private activeSave: Promise<void> | null = null;
  private saveQueued = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<VideoAutosaveListener>();

  constructor(
    private readonly writeFn: VideoAutosaveWriteFn,
    private readonly loadLatestFn?: VideoAutosaveLoadLatestFn,
  ) {}

  subscribe(listener: VideoAutosaveListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): VideoAutosaveState {
    return {
      status: this.status,
      dirty: this.draftContent !== this.savedContent,
      errorMessage: this.errorMessage,
      conflictLatestContent: this.conflictLatestContent,
      lastSavedAt: this.lastSavedAt,
    };
  }

  /** Exact current serialized draft, including automatic external merges. */
  getDraftContent(): string {
    return this.draftContent;
  }

  /** Canonical predecessor for authored receipts, even when the human draft is dirty. */
  getSavedSnapshot(): Readonly<{ content: string; sha256: string | null; revision: number | null }> {
    return { content: this.savedContent, sha256: this.baseSha256, revision: this.baseRevision };
  }

  /**
   * Returns a binding only when the current draft is known to equal the saved
   * document. Callers must still refuse it while the autosave state is failed
   * or conflicted; this method never manufactures an identity for an unsaved
   * local template.
   */
  getSavedDocumentIdentity(): VideoSavedDocumentIdentity | null {
    if (this.draftContent !== this.savedContent || this.baseSha256 === null) return null;
    return { sha256: this.baseSha256, revision: this.baseRevision };
  }

  markInitialLoad(content: string, baseSha256: string | null, baseRevision: number | null): void {
    this.saveGeneration += 1;
    this.clearDebounce();
    this.savedContent = content;
    this.draftContent = content;
    this.baseSha256 = baseSha256;
    this.baseRevision = baseRevision;
    this.status = "idle";
    this.errorMessage = null;
    this.conflictLatestContent = null;
    this.lastSavedAt = null;
    this.initialLoadComplete = true;
    this.emit();
  }

  notifyChange(nextContent: string): void {
    this.draftContent = nextContent;
    if (!this.initialLoadComplete) {
      this.emit();
      return;
    }
    if (nextContent === this.savedContent) {
      this.clearDebounce();
      this.status = this.conflictLatestContent ? "conflict" : "idle";
      this.errorMessage = null;
      this.emit();
      return;
    }
    if (this.conflictLatestContent) {
      this.status = "conflict";
      this.emit();
      return;
    }
    this.scheduleSave();
  }

  async saveNow(): Promise<void> {
    this.clearDebounce();
    await this.runSave();
  }

  async flush(): Promise<void> {
    if (this.draftContent !== this.savedContent) {
      this.clearDebounce();
      await this.runSave();
    }
  }

  markExternalChange(latestContent: string): void {
    this.conflictLatestContent = latestContent;
    this.status = this.draftContent !== this.savedContent ? "conflict" : "idle";
    this.errorMessage = null;
    this.emit();
  }

  applyRemoteEnvelope(envelope: VideoDocumentReadEnvelope): string {
    this.saveGeneration += 1;
    this.clearDebounce();
    if (this.draftContent !== this.savedContent) {
      const merged = this.mergeDirtyEnvelope(envelope);
      if (merged !== null) return merged;
      this.conflictLatestContent = envelope.content;
      this.status = "conflict";
      this.emit();
      return this.draftContent;
    }
    this.savedContent = envelope.content;
    this.draftContent = envelope.content;
    this.baseSha256 = envelope.baseSha256;
    this.baseRevision = envelope.baseRevision;
    this.conflictLatestContent = null;
    this.status = "idle";
    this.errorMessage = null;
    this.emit();
    return envelope.content;
  }

  async reloadLatest(): Promise<VideoDocumentReadEnvelope | null> {
    if (!this.loadLatestFn) return null;
    const latest = await this.loadLatestFn();
    if (!latest) return null;
    this.saveGeneration += 1;
    this.clearDebounce();
    this.savedContent = latest.content;
    this.draftContent = latest.content;
    this.baseSha256 = latest.baseSha256;
    this.baseRevision = latest.baseRevision;
    this.conflictLatestContent = null;
    this.status = "idle";
    this.errorMessage = null;
    this.emit();
    return latest;
  }

  destroy(): void {
    this.saveGeneration += 1;
    this.initialLoadComplete = false;
    this.saveQueued = false;
    this.clearDebounce();
    this.listeners.clear();
  }

  private scheduleSave(): void {
    this.clearDebounce();
    this.status = "unsaved";
    this.errorMessage = null;
    this.emit();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.runSave();
    }, VIDEO_AUTOSAVE_DEBOUNCE_MS);
  }

  private clearDebounce(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }

  private mergeDirtyEnvelope(envelope: VideoDocumentReadEnvelope): string | null {
    const base = parseVideoHtml(this.savedContent);
    const local = parseVideoHtml(this.draftContent);
    const external = parseVideoHtml(envelope.content);
    if (!base.ok || !local.ok || !external.ok) return null;
    const merged = mergeVideoProjects(base.document.project, local.document.project, external.document.project);
    if (!merged.ok) {
      this.errorMessage = merged.reason;
      return null;
    }
    let content: string;
    try {
      content = serializeVideoHtml(external.document.manifest, merged.project);
    } catch {
      return null;
    }
    this.savedContent = envelope.content;
    this.draftContent = content;
    this.baseSha256 = envelope.baseSha256;
    this.baseRevision = envelope.baseRevision;
    this.conflictLatestContent = null;
    this.scheduleSave();
    return content;
  }

  private async runSave(): Promise<void> {
    this.saveQueued = true;
    if (!this.activeSave) {
      this.activeSave = this.drainSaves().finally(() => {
        this.activeSave = null;
      });
    }
    await this.activeSave;
  }

  private async drainSaves(): Promise<void> {
    while (this.saveQueued) {
      this.saveQueued = false;
      if (this.draftContent !== this.savedContent && !this.conflictLatestContent) await this.performSave();
    }
  }

  private async performSave(): Promise<void> {
    if (!this.initialLoadComplete) return;
    const generation = ++this.saveGeneration;
    const content = this.draftContent;
    this.status = "saving";
    this.errorMessage = null;
    this.emit();

    let result: VideoDocumentWriteResult;
    try {
      result = await this.writeFn(content, { sha256: this.baseSha256, revision: this.baseRevision });
    } catch (err) {
      result = { kind: "failed", message: err instanceof Error ? err.message : "Save failed." };
    }

    if (generation !== this.saveGeneration) return;
    if (result.kind === "saved") {
      const persistedContent = result.persistedContent ?? content;
      this.savedContent = persistedContent;
      this.baseSha256 = result.sha256;
      this.baseRevision = result.revision ?? this.baseRevision;
      this.conflictLatestContent = null;
      this.lastSavedAt = new Date();
      if (this.draftContent === content) {
        this.draftContent = persistedContent;
        this.status = "saved";
      } else {
        this.status = "unsaved";
      }
      this.emit();
      return;
    }

    if (this.draftContent !== content) {
      this.status = this.draftContent !== this.savedContent ? "unsaved" : "idle";
      this.emit();
      return;
    }

    if (result.kind === "conflict") {
      if (this.loadLatestFn) {
        const latest = await this.loadLatestFn();
        if (generation !== this.saveGeneration) return;
        if (latest && this.mergeDirtyEnvelope(latest) !== null) return;
        if (latest) this.conflictLatestContent = latest.content;
      }
      this.status = "conflict";
      this.emit();
      return;
    }

    this.status = "failed";
    this.errorMessage = result.message;
    this.emit();
  }
}

export function bridgeWriteResult(value: unknown): VideoDocumentWriteResult {
  return parseWriteResponse(value);
}
