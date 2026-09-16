import type { DocumentEnvelope, SheetsBridge } from "./sheet-bridge";
import type { SheetsShellStatus } from "./sheets-shell";

type SessionView = {
  snapshot(): Promise<string>;
  replace(content: string): Promise<void>;
  status(state: SheetsShellStatus, message?: string): void;
  label(path?: string): void;
};

type FailedSubmission = {
  content: string;
  generation: number;
  baseSha256: string | null;
  baseRevision: number | null;
};

/** One serial persistence lane. An external revision never replaces a dirty
 * editor. Acknowledging a save never clears edits made while it was in flight. */
export class SheetSession {
  private base: DocumentEnvelope | undefined;
  private generation = 0;
  private savedGeneration = 0;
  private blocked = false;
  private localEditing = false;
  private disposed = false;
  private lane: Promise<void> = Promise.resolve();
  private scheduled = false;
  private failedSubmission?: FailedSubmission;
  private unsubscribe?: () => void;

  constructor(private bridge: SheetsBridge, private view: SessionView) {}
  get dirty(): boolean { return this.generation !== this.savedGeneration; }
  private status(state: SheetsShellStatus, message?: string): void {
    if (this.disposed) return;
    this.view.status(state, message);
    this.bridge.humanEdit?.set({ state: this.blocked ? "conflict" : this.localEditing ? "dirty" : state === "saved" ? "clean" : state === "saving" ? "saving" : "dirty" });
  }
  private scheduleSave(): void {
    if (this.disposed || this.blocked || this.localEditing || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.save().catch(() => { /* enqueue reports; explicit Save retries */ });
    });
  }
  private enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.lane.then(async () => { if (!this.disposed) await work(); });
    this.lane = result.catch((error: unknown) => {
      this.status(this.blocked ? "conflict" : "error", error instanceof Error ? error.message : String(error));
    });
    return result;
  }
  async start(): Promise<void> {
    await this.reload();
    if (this.disposed) return;
    this.unsubscribe = this.bridge.document.onChange?.((event) => {
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
  }
  changed(): void {
    if (this.disposed) return;
    this.generation += 1;
    this.status(this.blocked ? "conflict" : "unsaved");
    this.scheduleSave();
  }
  setLocalEditing(active: boolean): void {
    if (this.disposed || this.localEditing === active) return;
    this.localEditing = active;
    this.status(active ? this.blocked ? "conflict" : "unsaved" : this.blocked ? "conflict" : this.dirty ? "unsaved" : "saved");
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
        if (this.generation !== submittedGeneration) {
          this.blocked = true;
          this.status("conflict", "The saved file also changed elsewhere. Your newer edits are kept here; save a copy or reload.");
          return;
        }
        await this.view.replace(persisted);
      }
      this.savedGeneration = submittedGeneration;
      this.status(this.dirty ? "unsaved" : "saved");
    });
  }
  reload(): Promise<void> {
    return this.enqueue(async () => {
      const remote = await this.bridge.document.read({ fresh: true });
      if (this.disposed) return;
      await this.view.replace(remote.content);
      if (this.disposed) return;
      this.base = remote;
      this.failedSubmission = undefined;
      this.savedGeneration = this.generation;
      this.blocked = false;
      this.view.label(remote.path);
      this.status("saved");
    });
  }
  downloadCopy(): Promise<void> {
    return this.enqueue(async () => {
      const content = await this.view.snapshot();
      if (this.disposed) return;
      await this.bridge.document.downloadCopy(content);
      if (this.disposed) return;
      this.status(this.blocked ? "conflict" : this.dirty ? "unsaved" : "saved", "Copy downloaded. Your open file is unchanged.");
    });
  }
  dispose(): void { this.disposed = true; this.unsubscribe?.(); }
}
