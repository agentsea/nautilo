// Adapted from the qualified serial persistence lane; document authority stays in the host bridge.
import type { DocumentEnvelope, BoardBridge } from "./board-bridge";
import { BoardRecovery } from "./board-recovery";
export type BoardSaveStatus = "saved" | "unsaved" | "saving" | "conflict" | "error";

type SessionView = {
  snapshot(): string | Promise<string>;
  /** Includes the focused editor without committing or moving its caret. */
  recoverySnapshot?(): { content: string; exact: boolean };
  replace(content: string): void | Promise<void>;
  status(state: BoardSaveStatus, message?: string): void;
  label(path?: string): void;
};

type FailedSubmission = {
  content: string;
  generation: number;
  baseSha256: string | null;
  baseRevision: number | null;
};

type SuccessfulCopy = {
  content: string;
  generation: number;
};

/** One serial persistence lane. An external revision never replaces a dirty
 * editor. Acknowledging a save never clears edits made while it was in flight. */
export class BoardSession {
  private base: DocumentEnvelope | undefined;
  private generation = 0;
  private savedGeneration = 0;
  private blocked = false;
  private localEditing = false;
  private disposed = false;
  private lane: Promise<void> = Promise.resolve();
  private scheduled = false;
  private copying = false;
  private acknowledgedCopyGeneration?: number;
  private successfulCopy?: SuccessfulCopy;
  private failedSubmission?: FailedSubmission;
  private unsubscribe?: () => void;
  private recovery?: BoardRecovery;
  private recoveryError?: string;
  private recoveryReady = false;
  private recoveryScheduled = false;
  private recoveryOpening?: Promise<void>;
  private unverifiedRecovery?: { exact: boolean };
  private lastStatus: BoardSaveStatus = "saved";
  private lastStatusMessage?: string;

  constructor(private bridge: BoardBridge, private view: SessionView) {
    if (bridge.context.mode !== "preview" && bridge.recovery) this.recovery = new BoardRecovery(bridge.recovery);
  }
  get dirty(): boolean { return this.generation !== this.savedGeneration; }
  get canClose(): boolean { return Boolean(this.base) && !this.dirty && !this.localEditing && !this.blocked; }
  reportError(error: unknown): void {
    this.status(this.blocked ? "conflict" : "error", error instanceof Error ? error.message : String(error));
  }
  private status(state: BoardSaveStatus, message?: string): void {
    if (this.disposed) return;
    this.lastStatus = state;
    this.lastStatusMessage = message;
    this.renderStatus();
    this.bridge.humanEdit?.set({ state: this.blocked ? "conflict" : this.localEditing ? "dirty" : state === "saved" ? "clean" : state === "saving" ? "saving" : "dirty" });
  }
  private renderStatus(): void {
    if (this.disposed) return;
    const warning = this.dirty || this.localEditing ? this.recoveryError : undefined;
    this.view.status(this.lastStatus, [this.lastStatusMessage, warning].filter(Boolean).join(" ") || undefined);
  }
  private recoveryFailed(error: unknown): void {
    this.recoveryError = `Crash recovery could not be updated. Keep this board open until it saves. ${error instanceof Error ? error.message : ""}`.trim();
    if (!this.disposed && (this.dirty || this.localEditing)) this.renderStatus();
  }
  private scheduleRecovery(): void {
    if (this.disposed || !this.recovery || this.recoveryScheduled) return;
    if (!this.recoveryReady) { this.retryRecovery(); return; }
    this.recoveryScheduled = true;
    queueMicrotask(() => {
      this.recoveryScheduled = false;
      if (this.disposed) return;
      void this.persistRecovery().catch(error => this.recoveryFailed(error));
    });
  }
  private retryRecovery(): void {
    if (this.disposed || !this.base || !this.recovery || this.recoveryReady || this.recoveryOpening) return;
    this.recoveryOpening = this.recovery.read().then(draft => {
      if (this.disposed) return;
      if (draft && (!draft.exact || draft.content !== this.base?.content)) {
        // Opening may have failed before an older/parallel draft was read.
        // Never replace it with edits made while recovery was unavailable.
        this.recoveryError = "A previous recovery copy is still present. Save your current edits or a copy before reopening this board to recover it.";
        this.renderStatus();
        return;
      }
      this.recoveryReady = true;
      this.recoveryError = undefined;
      this.scheduleRecovery();
      this.renderStatus();
    }).catch(error => this.recoveryFailed(error)).finally(() => { this.recoveryOpening = undefined; });
  }
  /** This lane must not wait for a server request in the canonical save lane. */
  async persistRecovery(): Promise<void> {
    if (!this.recovery || !this.recoveryReady || !this.base) return;
    // A clean model can still have an incomplete view-local operation (image
    // bytes being read/decoded). Preserve its inexact checkpoint until the
    // surface reports that operation finished.
    if (!this.dirty && !this.blocked && !this.localEditing) {
      await this.recovery.update(null);
      this.recoveryError = undefined;
      return;
    }
    const base = this.base;
    const generation = this.generation;
    const snapshot = this.view.recoverySnapshot?.() ?? { content: await this.view.snapshot(), exact: !this.localEditing };
    if (this.disposed) return;
    // Async adapters cannot associate a newer snapshot with an older base.
    if (base !== this.base || generation !== this.generation) { this.scheduleRecovery(); return; }
    // A lifecycle copy has already preserved this generation elsewhere and
    // cleared its journal. An older async checkpoint must not resurrect it.
    if (this.acknowledgedCopyGeneration !== undefined && generation <= this.acknowledgedCopyGeneration) return;
    await this.recovery.update({ version: 1, ...snapshot, baseSha256: base.baseSha256, baseRevision: base.baseRevision });
    if (this.recoveryError) { this.recoveryError = undefined; this.renderStatus(); }
  }
  private scheduleSave(): void {
    if (this.disposed || this.blocked || this.localEditing || this.scheduled || this.copying) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.copying) return;
      void this.save().catch(() => { /* enqueue reports; explicit Save retries */ });
    });
  }
  private enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.lane.then(async () => { if (!this.disposed) await work(); });
    this.lane = result.catch((error: unknown) => {
      this.reportError(error);
    });
    return result;
  }
  async start(): Promise<void> {
    if (this.disposed) return;
    this.unsubscribe ??= this.bridge.document.onChange?.((event) => {
      if (this.disposed) return;
      if (event.type === "renamed") { this.view.label(event.path); return; }
      void this.enqueue(async () => {
        if (event.type === "deleted") {
          this.blocked = true;
          this.status("conflict", "This file was deleted. Save a copy to preserve your edits.");
          return;
        }
        // Read current authority after queued saves; event envelopes can arrive
        // out of order or echo the app's own older write.
        const remote = await this.bridge.document.read({ fresh: true });
        if (this.disposed) return;
        if (this.unverifiedRecovery) {
          const exact = this.unverifiedRecovery.exact;
          this.unverifiedRecovery = undefined;
          const unchanged = remote.baseSha256 === this.base?.baseSha256 && remote.baseRevision === this.base?.baseRevision;
          this.blocked = !exact || !unchanged;
          this.view.label(remote.path);
          if (this.blocked) {
            this.status("conflict", "Your recovery draft is preserved. Save a copy or reload the saved file.");
          } else {
            this.base = remote;
            this.status("unsaved", "Reconnected. Saving your recovered edits.");
            this.scheduleSave();
          }
          return;
        }
        const failed = this.failedSubmission;
        if (failed) {
          const authorityUnchanged = remote.baseSha256 === failed.baseSha256
            && remote.baseRevision === failed.baseRevision;
          if (authorityUnchanged) {
            this.scheduleSave();
            return;
          }
          if (remote.content === failed.content) {
            this.failedSubmission = undefined;
            this.base = remote;
            this.savedGeneration = failed.generation;
            this.view.label(remote.path);
            this.status(this.dirty || this.localEditing ? "unsaved" : "saved");
            this.scheduleRecovery();
            if (this.dirty && !this.localEditing) this.scheduleSave();
            return;
          }
        }
        if (remote.baseSha256 === this.base?.baseSha256 && remote.baseRevision === this.base?.baseRevision) return;
        if (this.dirty || this.localEditing || this.blocked) {
          this.blocked = true;
          this.status("conflict");
          return;
        }
        await this.view.replace(remote.content);
        if (this.disposed) return;
        this.base = remote;
        this.view.label(remote.path);
        this.status("saved");
      }).catch(() => { /* enqueue reports and retains local edits */ });
    });
    await this.enqueue(async () => {
      let remote: DocumentEnvelope;
      try { remote = await this.bridge.document.read({ fresh: true }); }
      catch (readError) {
        // An authenticated host can still hold a protected recovery copy when
        // the canonical file was moved/deleted or its storage is unavailable.
        // Display it without treating its old base as permission to write.
        if (!this.recovery || this.disposed) throw readError;
        const draft = await this.recovery.read();
        if (this.disposed) return;
        this.recoveryReady = true;
        if (!draft) throw readError;
        await this.view.replace(draft.content);
        if (this.disposed) return;
        this.base = { content: draft.content, baseSha256: draft.baseSha256, baseRevision: draft.baseRevision };
        this.generation += 1;
        this.blocked = true;
        this.unverifiedRecovery = { exact: draft.exact };
        this.status("conflict", "Recovered your draft, but the saved file is unavailable. Save a copy to keep your work. Reopening a moved file at its new location will not include these unsaved edits.");
        return;
      }
      if (this.disposed) return;
      let draft;
      if (this.recovery) {
        try { draft = await this.recovery.read(); this.recoveryReady = true; }
        catch (error) { this.recoveryFailed(error); }
      }
      if (this.disposed) return;
      if (draft && (!draft.exact || draft.content !== remote.content)) {
        // Validate and stage the recovered editor before replacing anything.
        // If malformed, retain the journal and fail opening rather than clear it.
        await this.view.replace(draft.content);
        this.base = { ...remote, baseSha256: draft.baseSha256, baseRevision: draft.baseRevision };
        this.generation += 1;
        this.blocked = !draft.exact || draft.baseSha256 !== remote.baseSha256 || draft.baseRevision !== remote.baseRevision;
        this.view.label(remote.path);
        this.status(this.blocked ? "conflict" : "unsaved", !draft.exact
          ? "Recovered the last available draft. An unfinished operation may be missing. Save a copy to preserve it or reload the saved file."
          : this.blocked
            ? "Recovered your unsaved edits. The saved file also changed; save a copy or reload the latest version."
            : "Recovered your unsaved edits.");
        if (!this.blocked) this.scheduleSave();
      } else {
        await this.view.replace(remote.content);
        this.base = remote;
        this.view.label(remote.path);
        this.status("saved");
        // Also reconciles a canonical write whose acknowledgement was lost.
        if (draft) this.scheduleRecovery();
      }
    });
  }
  changed(): void {
    if (this.disposed) return;
    this.generation += 1;
    this.status(this.blocked ? "conflict" : "unsaved");
    this.scheduleRecovery();
    this.scheduleSave();
  }
  setLocalEditing(active: boolean): void {
    if (this.disposed || this.localEditing === active) return;
    this.localEditing = active;
    this.status(active ? this.blocked ? "conflict" : "unsaved" : this.blocked ? "conflict" : this.dirty ? "unsaved" : "saved");
    this.scheduleRecovery();
    if (!active && this.dirty) this.scheduleSave();
  }
  run(work: () => Promise<void>): Promise<void> { return this.enqueue(work); }
  edit(work: () => Promise<boolean | void>): Promise<void> {
    return this.enqueue(async () => {
      const changed = await work();
      if (!this.disposed && changed !== false) this.changed();
    });
  }
  save(): Promise<void> {
    // An explicit retry must also repair a transient local journal opening
    // failure, independently of a possibly stalled canonical network save.
    this.retryRecovery();
    return this.enqueue(async () => {
      if (this.disposed || this.blocked || this.localEditing) return;
      if (!this.base || !this.dirty) return;
      const submittedGeneration = this.generation;
      const content = await this.view.snapshot();
      if (this.disposed) return;
      this.status("saving");
      const failedSubmission = {
        content,
        generation: submittedGeneration,
        baseSha256: this.base.baseSha256,
        baseRevision: this.base.baseRevision,
      };
      let result;
      try {
        result = await this.bridge.document.write(content, { ...this.base, conflictPolicy: "strict" });
      } catch (error) {
        this.failedSubmission = failedSubmission;
        throw error;
      }
      if (this.disposed) return;
      if (result.kind === "conflict") {
        this.failedSubmission = undefined;
        this.blocked = true;
        this.status("conflict");
        return;
      }
      if (result.kind === "error") {
        this.failedSubmission = failedSubmission;
        throw new Error(result.message);
      }
      this.failedSubmission = undefined;
      const persisted = result.persistedContent ?? content;
      this.base = { content: persisted, baseSha256: result.sha256 ?? null, baseRevision: result.revision ?? null, path: result.path ?? this.base.path };
      this.view.label(this.base.path);
      if (persisted !== content) {
        if (this.generation !== submittedGeneration || this.localEditing) {
          this.blocked = true;
          this.status("conflict", "The saved file also changed elsewhere. Your newer edits are kept here; save a copy or reload.");
          return;
        }
        await this.view.replace(persisted);
      }
      this.savedGeneration = submittedGeneration;
      this.status(this.dirty || this.localEditing ? "unsaved" : "saved");
      this.scheduleRecovery();
    });
  }
  reload(): Promise<void> {
    return this.enqueue(async () => {
      const remote = await this.bridge.document.read({ fresh: true });
      if (this.disposed) return;
      await this.view.replace(remote.content);
      if (this.disposed) return;
      this.base = remote;
      this.unverifiedRecovery = undefined;
      this.failedSubmission = undefined;
      this.savedGeneration = this.generation;
      this.blocked = false;
      this.view.label(remote.path);
      this.status("saved");
      this.scheduleRecovery();
    });
  }
  saveCopy(commit?: () => void | Promise<void>): Promise<void> {
    return this.enqueue(async () => {
      if (!this.bridge.document.saveCopy) throw new Error("Save a copy is unavailable. Keep this board open and retry saving.");
      // Committing a focused editor normally schedules an autosave. A copy
      // action must not retry the original as a side effect of that commit.
      this.copying = true;
      this.successfulCopy = undefined;
      try {
        await commit?.();
        const content = await this.view.snapshot();
        if (this.disposed) return;
        const generation = this.generation;
        const copy = await this.bridge.document.saveCopy(content);
        if (this.disposed) return;
        this.successfulCopy = { content, generation };
        this.status(this.blocked ? "conflict" : this.dirty ? "unsaved" : "saved", `Copy saved as ${copy.path}. Your open file is unchanged.`);
      } finally { this.copying = false; }
    });
  }
  finalizeRecoveryCopy(content: string): Promise<void> {
    return this.enqueue(async () => {
      const copied = this.successfulCopy;
      if (!copied || copied.content !== content) throw new Error("The recovery copy no longer matches this board. Save a new copy before closing.");
      const generation = this.generation;
      const snapshot = this.view.recoverySnapshot?.() ?? { content: await this.view.snapshot(), exact: !this.localEditing };
      if (this.disposed) return;
      if (!snapshot.exact || snapshot.content !== content || generation !== copied.generation || generation !== this.generation) {
        throw new Error("The board changed after the recovery copy was saved. Save a new copy before closing.");
      }
      // Browser-only hosts have no durable journal to clear. The exact copied
      // content check above is still required before authorizing their close.
      if (!this.recovery) return;
      if (!this.recoveryReady) throw new Error("Crash recovery is unavailable. Keep this board open and retry Save Copy.");

      const previousAcknowledged = this.acknowledgedCopyGeneration;
      this.acknowledgedCopyGeneration = generation;
      try {
        await this.recovery.update(null);
      } catch (error) {
        this.acknowledgedCopyGeneration = previousAcknowledged;
        this.scheduleRecovery();
        throw error;
      }

      const current = this.view.recoverySnapshot?.() ?? { content: await this.view.snapshot(), exact: !this.localEditing };
      if (!current.exact || current.content !== content || generation !== this.generation) {
        this.scheduleRecovery();
        throw new Error("The board changed while its recovery copy was being finalized. Save a new copy before closing.");
      }
      this.recoveryError = undefined;
    });
  }
  dispose(): void { this.disposed = true; this.unsubscribe?.(); }
}
