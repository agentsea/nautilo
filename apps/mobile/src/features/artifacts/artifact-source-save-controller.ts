import { ApiError, ArtifactWriteRequiredError, ConflictError, type NautiloApiClient } from "@nautilo/api-client/browser";

import {
  MAX_NATIVE_SOURCE_EDIT_BYTES,
  nativeSourceByteLength,
} from "./artifact-edit-limits";

export type SourceSaveSnapshot = { revision: number | null; sha256: string | null };
export type SourceSaveFailure =
  | "auth-dead"
  | "capability"
  | "conflict"
  | "disposed"
  | "missing"
  | "offline"
  | "permission"
  | "server"
  | "size"
  | "validation";
export type SourceSaveResult =
  | { state: "idle"; snapshot: SourceSaveSnapshot; acceptedContent: string }
  | {
    state: "error";
    snapshot: SourceSaveSnapshot;
    reason: SourceSaveFailure;
    retryable: boolean;
  }
  | {
    state: "conflict";
    snapshot: SourceSaveSnapshot;
    reason: "conflict";
    retryable: false;
    currentSha256: string | null;
  };

type SaveClient = Pick<NautiloApiClient, "saveWorkspaceArtifactContent">;
export type SourceSaveInput = {
  client: SaveClient;
  id: string;
  content: string;
  mimeType: string;
  checkpoint: true;
};
type FrozenAttempt = {
  id: string;
  content: string;
  mimeType: string;
  checkpoint: true;
  base: SourceSaveSnapshot;
  mutationId: string;
};

type MappedFailure = { state: "error"; reason: Exclude<SourceSaveFailure, "conflict">; retryable: boolean };

function failure(error: unknown): MappedFailure {
  if (error instanceof ArtifactWriteRequiredError) {
    return { state: "error", reason: "capability", retryable: false };
  }
  if (!(error instanceof ApiError)) {
    return { state: "error", reason: "offline", retryable: true };
  }
  if (error.status === 401) return { state: "error", reason: "auth-dead", retryable: false };
  if (error.status === 403) return { state: "error", reason: "permission", retryable: false };
  if (error.status === 404) return { state: "error", reason: "missing", retryable: false };
  if (error.status === 413) return { state: "error", reason: "size", retryable: false };
  if (error.status === 400 || error.status === 422) {
    return { state: "error", reason: "validation", retryable: false };
  }
  return {
    state: "error",
    reason: error.status >= 500 ? "server" : "validation",
    retryable: error.status >= 500,
  };
}

export function createArtifactReloadFence() {
  let generation = 0;
  let abort: AbortController | undefined;
  return {
    begin(): { generation: number; signal: AbortSignal } {
      abort?.abort();
      abort = new AbortController();
      generation += 1;
      return { generation, signal: abort.signal };
    },
    cancel(): void {
      generation += 1;
      abort?.abort();
      abort = undefined;
    },
    isCurrent(candidate: number): boolean {
      return candidate === generation && abort !== undefined && !abort.signal.aborted;
    },
  };
}

/** Source-only frozen-attempt coordinator. The shared API client owns auth retry. */
export class ArtifactSourceSaveController {
  private disposed = false;
  private inFlight: Promise<SourceSaveResult> | null = null;
  private conflict: { currentSha256: string | null } | null = null;
  private retryAttempt: FrozenAttempt | null = null;

  constructor(
    private snapshot: SourceSaveSnapshot,
    private readonly createMutationId: () => string,
  ) {}

  dispose(): void {
    this.disposed = true;
  }

  /** Only a confirmed successful Reload latest may replace the optimistic base. */
  resolveConflictWithLatest(snapshot: SourceSaveSnapshot): boolean {
    if (
      !this.conflict
      || this.inFlight
      || this.disposed
      || !Number.isInteger(snapshot.revision)
      || snapshot.revision === null
      || snapshot.revision < 0
      || !snapshot.sha256
    ) return false;
    this.snapshot = { ...snapshot };
    this.conflict = null;
    this.retryAttempt = null;
    return true;
  }

  save(input: SourceSaveInput): Promise<SourceSaveResult> {
    if (this.inFlight) return this.inFlight;
    if (this.conflict) return Promise.resolve(this.conflictResult());
    if (this.disposed) return Promise.resolve(this.errorResult("disposed", false));
    // An unconfirmed request may already have committed. Every subsequent Save
    // must replay that exact mutation before newer editor bytes can be sent.
    if (this.retryAttempt) return this.run(input.client, this.retryAttempt);
    if (nativeSourceByteLength(input.content) > MAX_NATIVE_SOURCE_EDIT_BYTES) {
      return Promise.resolve(this.errorResult("size", false));
    }
    const attempt: FrozenAttempt = {
      id: input.id,
      content: input.content,
      mimeType: input.mimeType,
      checkpoint: input.checkpoint,
      base: { ...this.snapshot },
      mutationId: this.createMutationId(),
    };
    return this.run(input.client, attempt);
  }

  retry(client: SaveClient): Promise<SourceSaveResult> {
    if (this.inFlight) return this.inFlight;
    if (this.conflict) return Promise.resolve(this.conflictResult());
    if (this.disposed) return Promise.resolve(this.errorResult("disposed", false));
    if (!this.retryAttempt) return Promise.resolve(this.errorResult("validation", false));
    return this.run(client, this.retryAttempt);
  }

  private run(client: SaveClient, attempt: FrozenAttempt): Promise<SourceSaveResult> {
    const task = (async (): Promise<SourceSaveResult> => {
      try {
        const saved = await client.saveWorkspaceArtifactContent(attempt.id, attempt.content, {
          baseRevision: attempt.base.revision,
          baseSha256: attempt.base.sha256,
          checkpoint: attempt.checkpoint,
          mimeType: attempt.mimeType,
          clientMutationId: attempt.mutationId,
        });
        if (this.disposed) return this.errorResult("disposed", false);
        if (!Number.isInteger(saved.revision) || saved.revision < 0 || !saved.sha256) {
          this.retryAttempt = attempt;
          return this.errorResult("server", true);
        }
        this.snapshot = { revision: saved.revision, sha256: saved.sha256 };
        this.retryAttempt = null;
        return { state: "idle", snapshot: { ...this.snapshot }, acceptedContent: attempt.content };
      } catch (error) {
        if (this.disposed) return this.errorResult("disposed", false);
        if (error instanceof ConflictError) {
          this.conflict = { currentSha256: error.currentSha256 };
          this.retryAttempt = null;
          return this.conflictResult();
        }
        const mapped = failure(error);
        this.retryAttempt = mapped.retryable ? attempt : null;
        return { ...mapped, snapshot: { ...this.snapshot } };
      } finally {
        this.inFlight = null;
      }
    })();
    this.inFlight = task;
    return task;
  }

  private errorResult(reason: SourceSaveFailure, retryable: boolean): SourceSaveResult {
    if (reason === "conflict") return this.conflictResult();
    return { state: "error", snapshot: { ...this.snapshot }, reason, retryable };
  }

  private conflictResult(): SourceSaveResult {
    return {
      state: "conflict",
      snapshot: { ...this.snapshot },
      reason: "conflict",
      retryable: false,
      currentSha256: this.conflict?.currentSha256 ?? null,
    };
  }
}
