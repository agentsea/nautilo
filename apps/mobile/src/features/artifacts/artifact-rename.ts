import { ApiError, ArtifactWriteRequiredError, type ArtifactDto, type NautiloApiClient } from "@nautilo/api-client/browser";
import { emitAuthDead } from "@/lib/auth-events";

export type ArtifactRenameFailure = "auth-dead" | "capability" | "conflict" | "disposed" | "missing" | "offline" | "permission" | "server" | "validation";
export type ArtifactRenameResult =
  | { state: "saved"; artifact: ArtifactDto }
  | { state: "unchanged" }
  | { state: "error"; reason: ArtifactRenameFailure; retryable: boolean; reloadBeforeClose: boolean };

type RenameClient = Pick<NautiloApiClient, "renameWorkspaceArtifact">;
type FrozenRename = { id: string; artifactId: string; originalPath: string; newPath: string; serverId: string };

export function renamePathFromBasename(path: string, basename: string): { ok: true; path: string } | { ok: false; reason: "validation" | "unchanged" } {
  const normalized = basename.trim();
  if (normalized.length === 0 || normalized === "." || normalized === ".." || normalized.includes("/") || normalized.includes("\\") || Array.from(normalized).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  })) {
    return { ok: false, reason: "validation" };
  }
  const slash = path.lastIndexOf("/");
  const next = slash >= 0 ? `${path.slice(0, slash + 1)}${normalized}` : normalized;
  if (next.length > 4096) return { ok: false, reason: "validation" };
  return next === path ? { ok: false, reason: "unchanged" } : { ok: true, path: next };
}

function mapFailure(error: unknown): Omit<Extract<ArtifactRenameResult, { state: "error" }>, "state"> {
  if (error instanceof ArtifactWriteRequiredError) {
    return { reason: "capability", retryable: false, reloadBeforeClose: true };
  }
  if (!(error instanceof ApiError)) return { reason: "offline", retryable: true, reloadBeforeClose: true };
  if (error.status === 401) return { reason: "auth-dead", retryable: false, reloadBeforeClose: false };
  // Permission/deletion can change the viewer's authoritative metadata and
  // canWrite flag. They are deterministic failures, but closing must reload.
  if (error.status === 403) return { reason: "permission", retryable: false, reloadBeforeClose: true };
  if (error.status === 404) return { reason: "missing", retryable: false, reloadBeforeClose: true };
  if (error.status === 409) return { reason: "conflict", retryable: false, reloadBeforeClose: false };
  if (error.status === 400 || error.status === 422) return { reason: "validation", retryable: false, reloadBeforeClose: false };
  return { reason: "server", retryable: error.status >= 500, reloadBeforeClose: error.status >= 500 };
}

/** Keeps retries byte-for-byte/path-for-path identical after an uncertain response. */
export class ArtifactRenameCoordinator {
  private inFlight: Promise<ArtifactRenameResult> | null = null;
  private pending: FrozenRename | null = null;
  private disposed = false;

  dispose(): void { this.disposed = true; }

  rename(input: { client: RenameClient; artifact: ArtifactDto; basename: string; serverId: string }): Promise<ArtifactRenameResult> {
    if (this.inFlight) return this.inFlight;
    if (this.disposed) return Promise.resolve(this.failure("disposed", false, false));
    if (!this.pending) {
      const target = renamePathFromBasename(input.artifact.path, input.basename);
      if (!target.ok) return Promise.resolve(target.reason === "unchanged" ? { state: "unchanged" } : this.failure(target.reason, false, false));
      this.pending = { id: input.artifact.id, artifactId: input.artifact.artifactId, originalPath: input.artifact.path, newPath: target.path, serverId: input.serverId };
    }
    return this.run(input.client);
  }

  retry(client: RenameClient): Promise<ArtifactRenameResult> {
    if (this.inFlight) return this.inFlight;
    if (this.disposed) return Promise.resolve(this.failure("disposed", false, false));
    if (!this.pending) return Promise.resolve(this.failure("validation", false, false));
    return this.run(client);
  }

  /**
   * Closing an uncertain recovery deliberately abandons its frozen request
   * before the viewer reloads authoritative metadata. It is never legal while
   * a request is still in flight.
   */
  abandon(): boolean {
    if (this.inFlight) return false;
    this.pending = null;
    return true;
  }

  private run(client: RenameClient): Promise<ArtifactRenameResult> {
    const pending = this.pending;
    if (!pending) return Promise.resolve(this.failure("validation", false, false));
    const task = (async (): Promise<ArtifactRenameResult> => {
      try {
        const artifact = await client.renameWorkspaceArtifact(pending.id, pending.newPath);
        if (this.disposed) return this.failure("disposed", false, false);
        if (artifact.id !== pending.id || artifact.artifactId !== pending.artifactId || artifact.path !== pending.newPath) {
          return this.failure("server", true, true);
        }
        this.pending = null;
        return { state: "saved", artifact };
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

  private failure(reason: ArtifactRenameFailure, retryable: boolean, reloadBeforeClose: boolean): ArtifactRenameResult {
    return { state: "error", reason, retryable, reloadBeforeClose };
  }
}
