import { ApiError, ArtifactWriteRequiredError, type NautiloApiClient } from "@nautilo/api-client/browser";

import { emitAuthDead } from "@/lib/auth-events";
import type { ArtifactBytesResult } from "@/lib/artifact-bytes";

export type ArtifactDeleteFailure = "auth-dead" | "capability" | "disposed" | "missing" | "offline" | "permission" | "server";
export type ArtifactDeleteResult =
  | { state: "deleted" }
  | { state: "error"; reason: ArtifactDeleteFailure; reconcileBeforeClose: boolean; retryable: boolean };

type DeleteClient = Pick<NautiloApiClient, "deleteWorkspaceArtifact">;
type FrozenDelete = { id: string; serverId: string };

/** Only absence or loss of read access leaves the viewer after a reconciliation load. */
export function shouldExitDeletedArtifactReconciliation(kind: ArtifactBytesResult["kind"]): boolean {
  return kind === "auth_dead" || kind === "forbidden" || kind === "not_found";
}

function mapFailure(error: unknown): Omit<Extract<ArtifactDeleteResult, { state: "error" }>, "state"> {
  if (error instanceof ArtifactWriteRequiredError) {
    return { reason: "capability", retryable: false, reconcileBeforeClose: true };
  }
  if (!(error instanceof ApiError)) return { reason: "offline", retryable: true, reconcileBeforeClose: true };
  if (error.status === 401) return { reason: "auth-dead", retryable: false, reconcileBeforeClose: false };
  // A DELETE 404 is not proof of deletion: canonical aggregate reload decides.
  if (error.status === 403) return { reason: "permission", retryable: false, reconcileBeforeClose: true };
  if (error.status === 404) return { reason: "missing", retryable: false, reconcileBeforeClose: true };
  return { reason: "server", retryable: error.status >= 500, reconcileBeforeClose: error.status >= 500 };
}

/** Owns only the delete request identity and retry semantics. Viewer reconciliation stays at the route. */
export class ArtifactDeleteCoordinator {
  private disposed = false;
  private inFlight: Promise<ArtifactDeleteResult> | null = null;
  private pending: FrozenDelete | null = null;

  dispose(): void { this.disposed = true; }

  delete(input: { client: DeleteClient; id: string; serverId: string }): Promise<ArtifactDeleteResult> {
    if (this.inFlight) return this.inFlight;
    if (this.disposed) return Promise.resolve(this.failure("disposed", false, false));
    if (!this.pending) this.pending = { id: input.id, serverId: input.serverId };
    return this.run(input.client);
  }

  retry(client: DeleteClient): Promise<ArtifactDeleteResult> {
    if (this.inFlight) return this.inFlight;
    if (this.disposed) return Promise.resolve(this.failure("disposed", false, false));
    if (!this.pending) return Promise.resolve(this.failure("server", false, false));
    return this.run(client);
  }

  /** Close an uncertain recovery before asking the server for canonical state. */
  abandon(): boolean {
    if (this.inFlight) return false;
    this.pending = null;
    return true;
  }

  private run(client: DeleteClient): Promise<ArtifactDeleteResult> {
    const pending = this.pending;
    if (!pending) return Promise.resolve(this.failure("server", false, false));
    const task = (async (): Promise<ArtifactDeleteResult> => {
      try {
        await client.deleteWorkspaceArtifact(pending.id);
        if (this.disposed) return this.failure("disposed", false, false);
        this.pending = null;
        return { state: "deleted" };
      } catch (error) {
        if (this.disposed) return this.failure("disposed", false, false);
        const mapped = mapFailure(error);
        if (mapped.reason === "auth-dead") emitAuthDead(pending.serverId);
        if (!mapped.retryable) this.pending = null;
        return { state: "error", ...mapped };
      } finally {
        this.inFlight = null;
      }
    })();
    this.inFlight = task;
    return task;
  }

  private failure(reason: ArtifactDeleteFailure, retryable: boolean, reconcileBeforeClose: boolean): ArtifactDeleteResult {
    return { state: "error", reason, retryable, reconcileBeforeClose };
  }
}
