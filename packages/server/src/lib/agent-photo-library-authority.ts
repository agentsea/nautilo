import {
  actors,
  and,
  eq,
  nautiloInstanceIdentity,
  profiles,
  type DirectDatabase,
} from "@nautilo/db";
import type { AvatarRef } from "@nautilo/types";

export interface AgentPhotoLibraryAuthority {
  readonly serverInstanceId: string;
  readonly viewerUserId: string;
  readonly ownerUserId: string;
  readonly agentId: string;
}

export interface AgentPhotoLibraryScope {
  readonly serverInstanceId: string;
  readonly viewerUserId: string;
  readonly agentId: string;
  readonly selectionRevision: string;
  readonly libraryRevision: string;
}

export interface AgentPhotoLibraryCurrentState {
  readonly avatarRef: AvatarRef | null;
  readonly entryId: string | null;
  readonly scope: AgentPhotoLibraryScope;
}

export type AgentPhotoLibraryErrorCode =
  | "idempotency_mismatch"
  | "deleted_library_capacity_reached"
  | "library_capacity_reached"
  | "invalid_photo_request"
  | "operation_incomplete"
  | "photo_blob_missing"
  | "photo_deleted"
  | "photo_forbidden"
  | "photo_library_unavailable"
  | "photo_not_found"
  | "selection_conflict"
  | "stale_library_revision"
  | "stale_viewer_scope"
  | "undo_conflict";

export interface AgentPhotoLibraryFailure {
  readonly code: AgentPhotoLibraryErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly current?: AgentPhotoLibraryCurrentState;
  /** Only safe for already-authorized stale-library refreshes. */
  readonly scope?: AgentPhotoLibraryScope;
}

export class AgentPhotoLibraryError extends Error {
  readonly code: AgentPhotoLibraryErrorCode;
  readonly retryable: boolean;
  readonly current: AgentPhotoLibraryCurrentState | undefined;
  readonly scope: AgentPhotoLibraryScope | undefined;

  constructor(error: AgentPhotoLibraryFailure) {
    super(error.message);
    this.name = "AgentPhotoLibraryError";
    this.code = error.code;
    this.retryable = error.retryable;
    this.current = error.current;
    this.scope = error.scope;
  }
}

export interface AgentPhotoLibraryProfileSnapshot {
  readonly id: string;
  readonly userId: string;
  readonly agentId: string;
  readonly avatarRef: AvatarRef | null;
  readonly avatarSelectionRevision: number;
  readonly avatarLibraryRevision: number;
}

type AuthorityDb = DirectDatabase | Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0];

function failure(code: AgentPhotoLibraryErrorCode, message: string): AgentPhotoLibraryError {
  return new AgentPhotoLibraryError({ code, message, retryable: false });
}

/**
 * One durable authority snapshot for all D487 paths. The mutation service
 * requests row locks; ordinary reads stay non-blocking but validate the exact
 * same server, Human, profile, and actor-mirror facts.
 */
export async function validateAgentPhotoLibraryAuthority(
  db: AuthorityDb,
  authority: AgentPhotoLibraryAuthority,
  mode: "read" | "mutation",
): Promise<AgentPhotoLibraryProfileSnapshot> {
  const [identity] = await db
    .select({ serverInstanceId: nautiloInstanceIdentity.serverInstanceId })
    .from(nautiloInstanceIdentity)
    .where(eq(nautiloInstanceIdentity.id, "self"))
    .limit(1);
  if (!identity || identity.serverInstanceId !== authority.serverInstanceId) {
    throw failure("stale_viewer_scope", "The selected Server identity changed");
  }
  if (authority.viewerUserId !== authority.ownerUserId) {
    throw failure("photo_forbidden", "Agent photo access is not available for this viewer");
  }
  const profileSelection = db
    .select({
      id: profiles.id,
      userId: profiles.userId,
      agentId: profiles.agentId,
      avatarRef: profiles.avatarRef,
      avatarSelectionRevision: profiles.avatarSelectionRevision,
      avatarLibraryRevision: profiles.avatarLibraryRevision,
    })
    .from(profiles)
    .where(eq(profiles.agentId, authority.agentId))
    .limit(1);
  const [profile] = mode === "mutation"
    ? await profileSelection.for("update")
    : await profileSelection;
  if (!profile || profile.userId !== authority.ownerUserId) {
    throw failure("photo_forbidden", "Agent photo access is not available for this viewer");
  }
  const mirrorSelection = db
    .select({ ownerUserId: actors.ownerId })
    .from(actors)
    .where(and(eq(actors.kind, "agent"), eq(actors.agentId, authority.agentId)));
  const mirrors = mode === "mutation"
    ? await mirrorSelection.for("update")
    : await mirrorSelection;
  if (mirrors.length !== 1 || mirrors[0]?.ownerUserId !== authority.ownerUserId) {
    throw failure("photo_forbidden", "Agent photo access is not available for this viewer");
  }
  return profile;
}
