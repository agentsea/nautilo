/**
 * Debounced autosave for the Nautilo Design mini-app: debounce → write,
 * base sha/revision tracking, and conflict + external-change handling. Dirty authored changes are
 * merged only through the parsed Design scene graph: independent node changes
 * rebase, while structural or same-node changes remain explicit conflicts.
 *
 * The caller supplies `writeFn` (serialize current scene → bridge write) and,
 * optionally, `loadLatestFn` (re-read the host envelope) for conflict recovery.
 */

import { parseDesignHtml, serializeDesignHtml } from "./design-document";
import {
  createDesignDraftRecoveryRecord,
  draftRecoveryBaseMatches,
  type DesignDraftRecoveryAdapter,
  type DesignDraftRecoveryRecord,
} from "./draft-recovery";
import { mergeThreeWayDesignScenes, type SceneMergeConflict } from "./scene-merge";

export const AUTOSAVE_DEBOUNCE_MS = 750;

export type AutosaveStatus =
  | "idle"
  | "saved"
  | "saving"
  | "unsaved"
  | "conflict"
  | "failed"
  | "unavailable";

export type DocumentWriteResult =
  | {
      kind: "saved";
      sha256: string;
      revision?: number | null;
      path?: string;
      persistedContent?: string;
    }
  | { kind: "conflict"; currentSha256: string | null }
  | { kind: "failed"; message: string };

export type DocumentReadEnvelope = {
  content: string;
  path?: string;
  baseSha256: string | null;
  baseRevision: number | null;
};

export type RemoteEnvelope = {
  content: string;
  baseSha256: string | null;
  baseRevision: number | null;
};

export type AutosaveState = {
  status: AutosaveStatus;
  dirty: boolean;
  errorMessage: string | null;
  conflictLatestContent: string | null;
  conflictAffectedNodeIds: string[];
  conflictReason:
    | SceneMergeConflict["kind"]
    | "invalid_document"
    | "recovery_base_changed"
    | null;
  lastSavedAt: Date | null;
  recoverableDraftAvailable: boolean;
  recoverableDraftExact: boolean;
  recoveryErrorMessage: string | null;
};

export type AutosaveListener = (state: AutosaveState) => void;

export type AutosaveWriteFn = (
  content: string,
  base: { sha256: string | null; revision: number | null },
) => Promise<DocumentWriteResult>;

export type AutosaveLoadLatestFn = () => Promise<DocumentReadEnvelope | null>;

export type DesignAutosaveOptions = {
  recovery?: {
    scope: string;
    adapter: DesignDraftRecoveryAdapter;
  };
};

export type AutosaveFlushResult = {
  status: AutosaveStatus;
  dirty: boolean;
  documentSaved: boolean;
  recoveryPersisted: boolean;
  recoverableDraft: DesignDraftRecoveryRecord | null;
  errorMessage: string | null;
};

function parseWriteResponse(value: unknown): DocumentWriteResult {
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
      ...(typeof record["persistedContent"] === "string"
        ? { persistedContent: record["persistedContent"] }
        : {}),
    };
  }
  if (record["kind"] === "conflict") {
    return {
      kind: "conflict",
      currentSha256:
        typeof record["currentSha256"] === "string" ? record["currentSha256"] : null,
    };
  }
  return { kind: "failed", message: "Unexpected save response." };
}

export function bridgeWriteResult(value: unknown): DocumentWriteResult {
  return parseWriteResponse(value);
}

export class DesignAutosave {
  private savedContent = "";
  private draftContent = "";
  private baseSha256: string | null = null;
  private baseRevision: number | null = null;
  private status: AutosaveStatus = "idle";
  private errorMessage: string | null = null;
  private conflictLatestContent: string | null = null;
  private conflictActive = false;
  private conflictAffectedNodeIds: string[] = [];
  private conflictReason: AutosaveState["conflictReason"] = null;
  private lastSavedAt: Date | null = null;
  private initialLoadComplete = false;
  private documentAvailable = false;
  private unavailableMessage: string | null = null;
  private baselineGeneration = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private saveLoop: Promise<void> | null = null;
  private serializationFailure = false;
  private recoverableContentExact = true;
  private latestRecoverableContent = "";
  private recoveryTail: Promise<void> = Promise.resolve();
  private recoveryRequest = 0;
  private persistedRecoveryRequest = 0;
  private persistedRecovery: DesignDraftRecoveryRecord | null = null;
  private recoveryErrorMessage: string | null = null;
  private recovery: DesignAutosaveOptions["recovery"] | null;
  private readonly listeners = new Set<AutosaveListener>();

  constructor(
    private readonly writeFn: AutosaveWriteFn,
    private readonly loadLatestFn?: AutosaveLoadLatestFn,
    options: DesignAutosaveOptions = {},
  ) {
    if (options.recovery?.scope.length === 0) {
      throw new Error("Draft recovery requires a document scope.");
    }
    this.recovery = options.recovery ?? null;
  }

  subscribe(listener: AutosaveListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getState(): AutosaveState {
    return {
      status: this.status,
      dirty: this.isDirty(),
      errorMessage: this.errorMessage,
      conflictLatestContent: this.conflictLatestContent,
      conflictAffectedNodeIds: this.conflictAffectedNodeIds,
      conflictReason: this.conflictReason,
      lastSavedAt: this.lastSavedAt,
      recoverableDraftAvailable: this.getRecoverableDraft() !== null,
      recoverableDraftExact: this.recoverableContentExact,
      recoveryErrorMessage: this.recoveryErrorMessage,
    };
  }

  /** Current saved baseline for event-scoped receipt derivation; never a draft. */
  getSavedSnapshot(): { content: string; sha256: string | null; revision: number | null } {
    return {
      content: this.savedContent,
      sha256: this.baseSha256,
      revision: this.baseRevision,
    };
  }

  markInitialLoad(
    content: string,
    baseSha256: string | null,
    baseRevision: number | null,
  ): void {
    this.invalidatePendingSave();
    this.documentAvailable = true;
    this.unavailableMessage = null;
    this.savedContent = content;
    this.draftContent = content;
    this.latestRecoverableContent = content;
    this.baseSha256 = baseSha256;
    this.baseRevision = baseRevision;
    this.status = "idle";
    this.errorMessage = null;
    this.conflictLatestContent = null;
    this.conflictActive = false;
    this.conflictAffectedNodeIds = [];
    this.conflictReason = null;
    this.lastSavedAt = null;
    this.serializationFailure = false;
    this.recoverableContentExact = true;
    this.recoveryErrorMessage = null;
    this.initialLoadComplete = true;
    this.emit();
  }

  notifyChange(nextContent: string): void {
    this.draftContent = nextContent;
    this.latestRecoverableContent = nextContent;
    this.serializationFailure = false;
    this.recoverableContentExact = true;
    const dirty = this.isDirty();
    if (!this.initialLoadComplete) {
      this.emit();
      return;
    }
    this.queueRecoveryForCurrentState();
    if (!this.documentAvailable) {
      this.clearDebounce();
      this.status = "unavailable";
      this.errorMessage = this.unavailableMessage;
      this.emit();
      return;
    }
    if (!dirty) {
      this.clearDebounce();
      this.status = this.conflictActive ? "conflict" : "idle";
      this.emit();
      return;
    }
    if (this.conflictActive) {
      this.status = "conflict";
      this.emit();
      return;
    }
    if (this.saveLoop) {
      this.status = "saving";
      this.emit();
    } else {
      this.scheduleSave();
    }
  }

  async saveNow(): Promise<void> {
    this.clearDebounce();
    await this.startSaveLoop();
  }

  async flush(): Promise<AutosaveFlushResult> {
    this.clearDebounce();
    // A serialization failure or external conflict can arise while an earlier
    // exact write is still in flight. Close callers must still await that own
    // write because its result advances the base and recovery evidence.
    if (this.saveLoop) await this.saveLoop;
    if (
      this.documentAvailable &&
      this.isDirty() &&
      !this.serializationFailure &&
      !this.conflictActive
    ) {
      await this.startSaveLoop();
    }
    await this.recoveryTail;
    const recoverableDraft = this.getRecoverableDraft();
    return {
      status: this.status,
      dirty: this.isDirty(),
      documentSaved:
        this.initialLoadComplete && this.documentAvailable && !this.isDirty(),
      recoveryPersisted:
        recoverableDraft !== null &&
        this.persistedRecoveryRequest === this.recoveryRequest &&
        this.persistedRecovery?.scope === recoverableDraft.scope &&
        this.persistedRecovery.content === recoverableDraft.content &&
        this.persistedRecovery.exact === recoverableDraft.exact &&
        this.persistedRecovery.base.sha256 === recoverableDraft.base.sha256 &&
        this.persistedRecovery.base.revision === recoverableDraft.base.revision,
      recoverableDraft,
      errorMessage: this.errorMessage ?? this.recoveryErrorMessage,
    };
  }

  /** Retry the current exact serialized draft after a transport failure. */
  async retry(): Promise<void> {
    await this.saveNow();
  }

  /** Exact last serializable draft for a host-owned Save Copy action. */
  getSaveCopyContent(): string | null {
    return this.initialLoadComplete && this.isDirty() ? this.latestRecoverableContent : null;
  }

  async saveCopy(writeCopyFn: (content: string) => Promise<DocumentWriteResult>): Promise<DocumentWriteResult> {
    const content = this.getSaveCopyContent();
    if (content === null) return { kind: "failed", message: "There is no unsaved draft to copy." };
    try {
      return await writeCopyFn(content);
    } catch (err) {
      return { kind: "failed", message: err instanceof Error ? err.message : "Save copy failed." };
    }
  }

  /**
   * Fence a bound document that the host has removed. Already-admitted writes
   * may finish, but their callbacks cannot revive this target or report it as
   * saved. A new successful initial load is the only availability reset.
   */
  markUnavailable(message: string): void {
    this.invalidatePendingSave();
    this.documentAvailable = false;
    this.unavailableMessage = message;
    this.status = "unavailable";
    this.errorMessage = message;
    this.conflictLatestContent = null;
    this.conflictActive = false;
    this.conflictAffectedNodeIds = [];
    this.conflictReason = null;
    this.queueRecoveryForCurrentState();
    this.emit();
  }

  /**
   * Mark a mutation dirty when normal document serialization fails. Callers
   * may supply an independently serialized exact recovery payload; otherwise
   * the previous serializable draft remains available and is labelled partial.
   */
  markSerializationFailure(message: string, exactRecoverableContent?: string): void {
    if (exactRecoverableContent !== undefined) {
      this.draftContent = exactRecoverableContent;
      this.latestRecoverableContent = exactRecoverableContent;
      this.recoverableContentExact = true;
    } else {
      this.recoverableContentExact = false;
    }
    this.serializationFailure = true;
    this.clearDebounce();
    this.status = this.documentAvailable ? "failed" : "unavailable";
    this.errorMessage = this.documentAvailable ? message : this.unavailableMessage;
    this.queueRecoveryForCurrentState();
    this.emit();
  }

  getRecoverableDraft(): DesignDraftRecoveryRecord | null {
    const recovery = this.recovery;
    if (!recovery || !this.initialLoadComplete || !this.isDirty()) return null;
    return createDesignDraftRecoveryRecord(
      recovery.scope,
      this.latestRecoverableContent,
      { sha256: this.baseSha256, revision: this.baseRevision },
      this.recoverableContentExact,
    );
  }

  /** Configure or replace recovery after the host resolves document identity. */
  configureRecovery(scope: string, adapter: DesignDraftRecoveryAdapter): void {
    if (scope.length === 0) throw new Error("Draft recovery requires a document scope.");
    this.recovery = { scope, adapter };
    // A clean initial document must not erase a stored recovery record before
    // the caller has had a chance to read and restore it.
    if (this.isDirty()) this.queueRecoveryForCurrentState();
  }

  /**
   * Restore a validated record after initial host load. A changed host base is
   * kept as explicit local/remote conflict evidence and is never overwritten.
   */
  restoreRecoveryDraft(
    record: DesignDraftRecoveryRecord,
  ): "restored" | "conflict" | "scope_mismatch" {
    if (
      !this.initialLoadComplete ||
      !this.documentAvailable ||
      !this.recovery ||
      record.scope !== this.recovery.scope
    ) {
      return "scope_mismatch";
    }
    this.invalidatePendingSave();
    this.draftContent = record.content;
    this.latestRecoverableContent = record.content;
    this.serializationFailure = !record.exact;
    this.recoverableContentExact = record.exact;
    this.errorMessage = record.exact
      ? null
      : "The recovered draft is incomplete because its newest edit could not be serialized.";
    if (
      !draftRecoveryBaseMatches(record, {
        sha256: this.baseSha256,
        revision: this.baseRevision,
      })
    ) {
      this.conflictLatestContent = this.savedContent;
      this.conflictActive = true;
      this.conflictAffectedNodeIds = [];
      this.conflictReason = "recovery_base_changed";
      this.status = "conflict";
      this.queueRecoveryForCurrentState();
      this.emit();
      return "conflict";
    }
    this.conflictLatestContent = null;
    this.conflictActive = false;
    this.conflictAffectedNodeIds = [];
    this.conflictReason = null;
    this.queueRecoveryForCurrentState();
    if (this.isDirty() && !this.serializationFailure) this.scheduleSave();
    else {
      this.status = this.serializationFailure ? "failed" : "idle";
      this.emit();
    }
    return "restored";
  }

  async keepMine(): Promise<void> {
    if (!this.documentAvailable) return;
    this.clearDebounce();
    if (this.loadLatestFn) {
      this.invalidatePendingSave();
      const generation = this.baselineGeneration;
      let latest: DocumentReadEnvelope | null;
      try {
        latest = await this.loadLatestFn();
      } catch (err) {
        if (generation === this.baselineGeneration) {
          this.status = this.conflictActive ? "conflict" : "failed";
          this.errorMessage = err instanceof Error ? err.message : "Could not load the latest document.";
          this.emit();
        }
        return;
      }
      if (generation !== this.baselineGeneration) return;
      if (!latest) {
        this.status = this.conflictActive ? "conflict" : "failed";
        this.errorMessage = "Could not load the latest document.";
        this.emit();
        return;
      }
      this.baseSha256 = latest.baseSha256;
      this.baseRevision = latest.baseRevision;
    }
    this.conflictLatestContent = null;
    this.conflictActive = false;
    this.conflictAffectedNodeIds = [];
    this.conflictReason = null;
    this.errorMessage = null;
    await this.startSaveLoop();
  }

  async reloadLatest(): Promise<DocumentReadEnvelope | null> {
    if (!this.documentAvailable || !this.loadLatestFn) return null;
    this.invalidatePendingSave();
    const generation = this.baselineGeneration;
    let latest: DocumentReadEnvelope | null;
    try {
      latest = await this.loadLatestFn();
    } catch (err) {
      if (generation === this.baselineGeneration) {
        this.status = this.conflictActive ? "conflict" : "failed";
        this.errorMessage = err instanceof Error ? err.message : "Could not load the latest document.";
        this.emit();
      }
      return null;
    }
    if (!latest || generation !== this.baselineGeneration) return null;
    this.savedContent = latest.content;
    this.draftContent = latest.content;
    this.latestRecoverableContent = latest.content;
    this.baseSha256 = latest.baseSha256;
    this.baseRevision = latest.baseRevision;
    this.conflictLatestContent = null;
    this.conflictActive = false;
    this.conflictAffectedNodeIds = [];
    this.conflictReason = null;
    this.status = "idle";
    this.errorMessage = null;
    this.serializationFailure = false;
    this.recoverableContentExact = true;
    this.queueRecoveryForCurrentState();
    this.emit();
    return latest;
  }

  markExternalChange(
    latestContent: string,
    conflict?: { affectedNodeIds: string[]; reason: AutosaveState["conflictReason"] },
  ): void {
    if (!this.documentAvailable) return;
    this.invalidatePendingSave();
    this.conflictLatestContent = latestContent;
    this.conflictActive = true;
    this.conflictAffectedNodeIds = conflict?.affectedNodeIds ?? [];
    this.conflictReason = conflict?.reason ?? null;
    this.status = this.isDirty() ? "conflict" : "idle";
    this.errorMessage = null;
    this.emit();
  }

  /**
   * Adopt a remote envelope. When the local draft is clean, the remote content
   * becomes the new saved+draft baseline and the returned content is the remote
   * content. A dirty draft gets a conservative parsed-scene three-way merge;
   * unprovable structure or same-node changes remain a scoped conflict.
   */
  applyRemoteEnvelope(envelope: RemoteEnvelope): string {
    if (!this.documentAvailable) return this.draftContent;
    const dirty = this.isDirty();
    if (dirty) {
      if (this.serializationFailure) {
        this.markExternalChange(envelope.content, {
          affectedNodeIds: [],
          reason: "invalid_document",
        });
        return this.draftContent;
      }
      const base = parseDesignHtml(this.savedContent);
      const local = parseDesignHtml(this.draftContent);
      const remote = parseDesignHtml(envelope.content);
      if (!base.ok || !local.ok || !remote.ok) {
        this.markExternalChange(envelope.content, { affectedNodeIds: [], reason: "invalid_document" });
        return this.draftContent;
      }
      const merged = mergeThreeWayDesignScenes(base.document.scene, local.document.scene, remote.document.scene);
      if (!merged.ok) {
        this.markExternalChange(envelope.content, {
          affectedNodeIds: merged.conflict.affectedNodeIds,
          reason: merged.conflict.kind,
        });
        return this.draftContent;
      }
      let content: string;
      try {
        content = serializeDesignHtml(remote.document.manifest, merged.document);
      } catch {
        this.markExternalChange(envelope.content, { affectedNodeIds: merged.mergedNodeIds, reason: "invalid_document" });
        return this.draftContent;
      }
      this.invalidatePendingSave();
      this.savedContent = envelope.content;
      this.draftContent = content;
      this.latestRecoverableContent = content;
      this.baseSha256 = envelope.baseSha256;
      this.baseRevision = envelope.baseRevision;
      this.conflictLatestContent = null;
      this.conflictActive = false;
      this.conflictAffectedNodeIds = [];
      this.conflictReason = null;
      this.errorMessage = null;
      this.serializationFailure = false;
      this.recoverableContentExact = true;
      this.queueRecoveryForCurrentState();
      if (content !== envelope.content) this.scheduleSave();
      else {
        this.status = "idle";
        this.emit();
      }
      return content;
    }
    this.invalidatePendingSave();
    this.savedContent = envelope.content;
    this.draftContent = envelope.content;
    this.latestRecoverableContent = envelope.content;
    this.baseSha256 = envelope.baseSha256;
    this.baseRevision = envelope.baseRevision;
    this.conflictLatestContent = null;
    this.conflictActive = false;
    this.conflictAffectedNodeIds = [];
    this.conflictReason = null;
    this.errorMessage = null;
    this.serializationFailure = false;
    this.recoverableContentExact = true;
    this.status = "idle";
    this.queueRecoveryForCurrentState();
    this.emit();
    return envelope.content;
  }

  cancelConflict(): void {
    if (!this.documentAvailable) return;
    if (this.isDirty()) {
      this.status = "conflict";
      this.emit();
      return;
    }
    this.conflictLatestContent = null;
    this.conflictActive = false;
    this.conflictAffectedNodeIds = [];
    this.conflictReason = null;
    this.status = this.isDirty() ? "unsaved" : "idle";
    this.emit();
  }

  destroy(): void {
    this.clearDebounce();
    this.listeners.clear();
  }

  private scheduleSave(): void {
    if (!this.documentAvailable) return;
    this.clearDebounce();
    this.status = "unsaved";
    this.emit();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.startSaveLoop();
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  private clearDebounce(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /** Reject a save completion that was started against an older baseline. */
  private invalidatePendingSave(): void {
    this.clearDebounce();
    this.baselineGeneration += 1;
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  private isDirty(): boolean {
    return (
      this.serializationFailure ||
      (this.initialLoadComplete && !this.documentAvailable) ||
      this.draftContent !== this.savedContent
    );
  }

  private startSaveLoop(): Promise<void> {
    if (this.saveLoop) return this.saveLoop;
    if (!this.documentAvailable) return Promise.resolve();
    let resolveLoop!: () => void;
    const loop = new Promise<void>((resolve) => {
      resolveLoop = resolve;
    });
    this.saveLoop = loop;
    // Assign saveLoop before drainSaveQueue can emit. A synchronous listener
    // may call notifyChange from that first "saving" event.
    void this.drainSaveQueue().then(resolveLoop, (err: unknown) => {
      this.status = this.documentAvailable
        ? this.conflictActive ? "conflict" : "failed"
        : "unavailable";
      this.errorMessage = this.documentAvailable
        ? err instanceof Error ? err.message : "Save failed."
        : this.unavailableMessage;
      this.emit();
      resolveLoop();
    });
    void loop.then(() => {
      if (this.saveLoop === loop) this.saveLoop = null;
    });
    return loop;
  }

  private async drainSaveQueue(): Promise<void> {
    while (
      this.initialLoadComplete &&
      this.documentAvailable &&
      this.isDirty() &&
      !this.serializationFailure &&
      !this.conflictActive
    ) {
      const generation = this.baselineGeneration;
      const content = this.draftContent;
      const base = { sha256: this.baseSha256, revision: this.baseRevision };
      this.status = "saving";
      this.errorMessage = null;
      this.emit();
      // A synchronous listener may learn that the bound host document was
      // deleted while handling the saving state. Recheck the admission fence
      // before invoking the host write.
      if (generation !== this.baselineGeneration || !this.documentAvailable) continue;

      let result: DocumentWriteResult;
      try {
        result = await this.writeFn(content, base);
      } catch (err) {
        result = {
          kind: "failed",
          message: err instanceof Error ? err.message : "Save failed.",
        };
      }

      if (generation !== this.baselineGeneration) continue;

      if (result.kind === "saved") {
        const persistedContent = result.persistedContent ?? content;
        const serializationFailedWhileSaving = this.serializationFailure;
        const draftAdvancedWhileSaving =
          serializationFailedWhileSaving || this.draftContent !== content;
        this.savedContent = persistedContent;
        if (!draftAdvancedWhileSaving) {
          this.draftContent = persistedContent;
          this.latestRecoverableContent = persistedContent;
        }
        this.baseSha256 = result.sha256;
        this.baseRevision = result.revision ?? this.baseRevision;
        this.conflictLatestContent = null;
        this.conflictActive = false;
        this.conflictAffectedNodeIds = [];
        this.conflictReason = null;
        this.lastSavedAt = new Date();
        this.status = serializationFailedWhileSaving
          ? "failed"
          : this.isDirty()
            ? "saving"
            : "saved";
        this.queueRecoveryForCurrentState();
        this.emit();
        continue;
      }

      if (result.kind === "conflict") {
        this.status = "conflict";
        this.conflictActive = true;
        this.conflictLatestContent = null;
        this.conflictAffectedNodeIds = [];
        this.conflictReason = null;
        if (this.loadLatestFn) {
          try {
            const latest = await this.loadLatestFn();
            if (generation === this.baselineGeneration && latest) {
              this.conflictLatestContent = latest.content;
            } else if (generation === this.baselineGeneration) {
              this.errorMessage = "Could not load the latest document.";
            }
          } catch (err) {
            if (generation === this.baselineGeneration) {
              this.errorMessage =
                err instanceof Error ? err.message : "Could not load the latest document.";
            }
          }
        }
        this.emit();
        return;
      }

      this.status = "failed";
      this.errorMessage = result.message;
      this.emit();
      return;
    }
  }

  private queueRecoveryForCurrentState(): void {
    const adapter = this.recovery?.adapter;
    if (!adapter) return;
    const record = this.getRecoverableDraft();
    const request = ++this.recoveryRequest;
    this.recoveryTail = this.recoveryTail.then(async () => {
      try {
        await adapter.write(record);
        this.persistedRecoveryRequest = request;
        this.persistedRecovery = record;
        if (request === this.recoveryRequest) this.recoveryErrorMessage = null;
      } catch (err) {
        if (request === this.recoveryRequest) {
          this.recoveryErrorMessage =
            err instanceof Error ? err.message : "Draft recovery persistence failed.";
          this.emit();
        }
      }
    });
  }
}
