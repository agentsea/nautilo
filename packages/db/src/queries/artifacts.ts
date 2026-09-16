/**
 * M088B — Artifact DB query helpers (junction-backed).
 *
 * The `file` tool's `workspace` zone delegates row visibility + identity
 * to these helpers. Bytes still live on disk; the row + its
 * `artifact_namespaces` rows are what the tool filters and resolves
 * against the room/memory envelope.
 *
 * All helpers accept the readable / writable namespace sets from
 * `MemoryAccessEnvelope` rather than reaching into the envelope itself —
 * keeps the query layer free of the trust-layer type.
 *
 * Post-M127: `artifacts.agent_id` is gone. Row-level access is gated by
 * Namespace membership only; the helpers no longer accept an `agentId`
 * parameter. Trust-context routing (`withAgentTrustContext`) still uses
 * envelope `agentId` upstream — only the DB predicate is namespace-only.
 *
 * The shape mirrors memory's (M076 + M078) — one artifact row may attach
 * to many namespaces via the junction; reads `INNER JOIN` and filter by
 * overlap; `share_artifact` adds a junction row instead of mutating any
 * column on `artifacts`.
 */

import { and, desc, eq, exists, inArray, isNotNull, isNull, like, lt, lte, ne, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, type Database } from "../config/database";
import { artifacts, type Artifact, type NewArtifact } from "../schema/artifacts";
import { artifactNamespaces } from "../schema/artifact-namespaces";
import { roomMembers, rooms } from "../schema/rooms";
import { actors } from "../schema/trust";
import type { WorkspaceDocumentMutationTx } from "./workspace-document-mutations";
import {
  createNamespaceBoundaryProjection,
  namespaceSubsetPredicate,
} from "./namespace-access";
import { discoverRoomAuthorityInTx, lockDiscoveredRoomAuthorityInTx, RoomAuthorityChangedError } from "./room-authority-locks";

type Db = Database;

/** Structural identity only, NOT access authority. An admitted caller must
 * prove current Namespace access before reading any authored Artifact fields. */
export async function findArtifactInternalIdByPublicId(artifactId: string, conn: Database = db): Promise<string | null> {
  const [row] = await conn.select({ id: artifacts.id }).from(artifacts)
    .where(and(eq(artifacts.artifactId, artifactId), isNull(artifacts.deletedAt)));
  return row?.id ?? null;
}

/**
 * Ordinary Artifact paths remain authoritative in both legacy-only and
 * Shadow dual-form rows. Protected-only rows have all four fields NULL and
 * must remain invisible to ordinary readers and writers.
 */
function ordinaryArtifactRowPredicate() {
  return and(
    isNotNull(artifacts.path),
    isNotNull(artifacts.mimeType),
    isNotNull(artifacts.size),
    isNotNull(artifacts.storageUri),
  );
}

type LegacyArtifactProjection = Readonly<{
  id: string;
  artifactId: string;
  path: string | null;
  mimeType: string | null;
  size: number | null;
  storageUri: string | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}>;

/** Identity-only row used to reconcile an ambiguous create commit. Nullable
 * ordinary fields are intentional: any row with this external id proves the
 * bytes may still be owned by a committed lifecycle, including protected or
 * deleted rows. */
export type ArtifactReconciliationIdentity = LegacyArtifactProjection;

function legacyArtifact(row: LegacyArtifactProjection | undefined): Artifact | null {
  if (row === undefined) return null;
  if (row.path === null || row.mimeType === null || row.size === null
    || row.storageUri === null) {
    throw new Error("Legacy Artifact repository received a protected row");
  }
  return row as Artifact;
}

export interface InsertArtifactInput {
  artifactId: string;
  path: string;
  storageUri: string;
  mimeType?: string;
  size?: number;
  /**
   * M033 Phase 6 — client-generated internal `artifacts.id` UUID. When
   * supplied, `insertArtifact` SKIPS the `RETURNING` clause and builds
   * the result object from the input. Required when the caller runs
   * under the narrow `nautilo_agent` role: PostgreSQL evaluates the
   * SELECT-policy `USING` clause on `INSERT ... RETURNING`, and the
   * `artifacts_path_c_select` policy requires an `artifact_namespaces`
   * junction row that does not exist yet at insert time. Wide-handle
   * callers (e.g. `packages/server/src/routes/workspace-artifacts.ts`)
   * may omit this and keep the existing `defaultRandom` + RETURNING
   * path, since superuser bypasses RLS. Mirrors `memory-store.saveMemory`,
   * which generates `crypto.randomUUID()` client-side for the same reason.
   */
  internalId?: string;
}

/**
 * Insert ONLY the `artifacts` row. Junction attachment is a separate
 * call (`attachArtifactToNamespace`) so the create path can pick the
 * target Namespace from the envelope's `writableNamespaces[0]`. Mirrors
 * the way `memory-store.ts` inserts a memory then attaches it.
 *
 * Two execution paths:
 *   - `internalId` provided  → client-side UUID, no RETURNING (RLS-safe;
 *                              required under `nautilo_agent` per M033).
 *   - `internalId` absent    → DB `defaultRandom` + RETURNING (wide
 *                              handle / superuser path, BYPASSRLS).
 */
export async function insertArtifact(
  input: InsertArtifactInput,
  conn: Database = db,
): Promise<Artifact> {
  const baseRow: NewArtifact = {
    artifactId: input.artifactId,
    path: input.path,
    storageUri: input.storageUri,
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    ...(typeof input.size === "number" ? { size: input.size } : {}),
  };
  if (input.internalId) {
    const row: NewArtifact = { id: input.internalId, ...baseRow };
    await conn.insert(artifacts).values(row);
    const now = new Date();
    return {
      id: input.internalId,
      artifactId: input.artifactId,
      path: input.path,
      mimeType: input.mimeType ?? "application/octet-stream",
      size: input.size ?? 0,
      storageUri: input.storageUri,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
  }
  const [created] = await conn.insert(artifacts).values(baseRow).returning();
  const legacy = legacyArtifact(created);
  if (legacy === null) throw new Error("insertArtifact returned no row");
  return legacy;
}

/**
 * Attach an artifact to a namespace via the M:N junction. ON CONFLICT
 * DO NOTHING so re-attaching the same pair is a no-op (mirrors
 * `attachMemoryToNamespace`).
 */
export async function attachArtifactToNamespace(
  params: { artifactId: string; namespaceId: string },
  conn: Database = db,
): Promise<void> {
  await conn
    .insert(artifactNamespaces)
    .values({
      artifactId: params.artifactId,
      namespaceId: params.namespaceId,
    })
    .onConflictDoNothing();
}

/**
 * List the namespaces an artifact attaches to. Mirrors
 * `getMemoryNamespaces` from memory-store.
 */
export async function getArtifactNamespaces(
  artifactId: string,
  conn: Database = db,
): Promise<string[]> {
  const rows = await conn
    .select({ namespaceId: artifactNamespaces.namespaceId })
    .from(artifactNamespaces)
    .where(eq(artifactNamespaces.artifactId, artifactId));
  return rows.map((r) => r.namespaceId);
}

/**
 * Batched sibling of `getArtifactNamespaces` — looks up junction rows
 * for many artifacts in a single SQL round-trip. Returns a Map keyed by
 * artifact internal id; missing keys mean "no junction rows" (artifacts
 * not in the input set are absent from the map). M088C item 7.
 */
export async function getNamespacesForArtifactIds(
  artifactIds: string[],
  conn: Database = db,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (artifactIds.length === 0) return out;
  const rows = await conn
    .select({
      artifactId: artifactNamespaces.artifactId,
      namespaceId: artifactNamespaces.namespaceId,
    })
    .from(artifactNamespaces)
    .where(inArray(artifactNamespaces.artifactId, artifactIds));
  for (const r of rows) {
    const list = out.get(r.artifactId);
    if (list) list.push(r.namespaceId);
    else out.set(r.artifactId, [r.namespaceId]);
  }
  return out;
}

/**
 * Detach an artifact from a single namespace. Returns the number of
 * junction rows removed.
 */
export async function detachArtifactFromNamespace(
  params: { artifactId: string; namespaceId: string },
  conn: Database = db,
): Promise<number> {
  const result = await conn
    .delete(artifactNamespaces)
    .where(
      and(
        eq(artifactNamespaces.artifactId, params.artifactId),
        eq(artifactNamespaces.namespaceId, params.namespaceId),
      ),
    )
    .returning({ artifactId: artifactNamespaces.artifactId });
  return result.length;
}

/**
 * Look up a single artifact row by external `artifactId` and the caller's
 * readable namespace set. Returns `null` when the row doesn't exist, is
 * soft-deleted, or attaches to NO namespace in the readable set. The
 * same null is returned in every "not visible" case — distinguishing
 * them would leak existence.
 */
export async function findArtifactByIdForNamespaces(
  params: {
    artifactId: string;
    readableNamespaceIds: string[];
  },
  conn: Database = db,
): Promise<Artifact | null> {
  if (params.readableNamespaceIds.length === 0) return null;
  const [row] = await conn
    .selectDistinct({
      id: artifacts.id,
      artifactId: artifacts.artifactId,
      path: artifacts.path,
      mimeType: artifacts.mimeType,
      size: artifacts.size,
      storageUri: artifacts.storageUri,
      revision: artifacts.revision,
      createdAt: artifacts.createdAt,
      updatedAt: artifacts.updatedAt,
      deletedAt: artifacts.deletedAt,
    })
    .from(artifacts)
    .innerJoin(
      artifactNamespaces,
      eq(artifactNamespaces.artifactId, artifacts.id),
    )
    .where(
      and(
        eq(artifacts.artifactId, params.artifactId),
        ordinaryArtifactRowPredicate(),
        inArray(artifactNamespaces.namespaceId, params.readableNamespaceIds),
        isNull(artifacts.deletedAt),
      ),
    )
    .limit(1);
  return legacyArtifact(row);
}

export function buildArtifactReconciliationIdentityQuery(
  artifactId: string,
  conn: Database = db,
) {
  return conn
    .select({
      id: artifacts.id,
      artifactId: artifacts.artifactId,
      path: artifacts.path,
      mimeType: artifacts.mimeType,
      size: artifacts.size,
      storageUri: artifacts.storageUri,
      revision: artifacts.revision,
      createdAt: artifacts.createdAt,
      updatedAt: artifacts.updatedAt,
      deletedAt: artifacts.deletedAt,
    })
    .from(artifacts)
    .where(eq(artifacts.artifactId, artifactId))
    .limit(1);
}

/** Global identity reconciliation only. Do not use this as an authorization
 * lookup: it deliberately ignores Namespace edges and includes deleted and
 * protected rows so callers never unlink bytes while any lifecycle row exists. */
export async function findArtifactReconciliationIdentity(
  artifactId: string,
  conn: Database = db,
): Promise<ArtifactReconciliationIdentity | null> {
  const [row] = await buildArtifactReconciliationIdentityQuery(artifactId, conn);
  return row ?? null;
}

export async function findArtifactByInternalIdForNamespaces(
  params: {
    internalId: string;
    readableNamespaceIds: string[];
  },
  conn: Database = db,
): Promise<Artifact | null> {
  if (params.readableNamespaceIds.length === 0) return null;
  const [row] = await conn
    .selectDistinct({
      id: artifacts.id,
      artifactId: artifacts.artifactId,
      path: artifacts.path,
      mimeType: artifacts.mimeType,
      size: artifacts.size,
      storageUri: artifacts.storageUri,
      revision: artifacts.revision,
      createdAt: artifacts.createdAt,
      updatedAt: artifacts.updatedAt,
      deletedAt: artifacts.deletedAt,
    })
    .from(artifacts)
    .innerJoin(
      artifactNamespaces,
      eq(artifactNamespaces.artifactId, artifacts.id),
    )
    .where(
      and(
        eq(artifacts.id, params.internalId),
        ordinaryArtifactRowPredicate(),
        inArray(artifactNamespaces.namespaceId, params.readableNamespaceIds),
        isNull(artifacts.deletedAt),
      ),
    )
    .limit(1);
  return legacyArtifact(row);
}

/**
 * D448 commit-time Workspace mutation admission.
 *
 * Unlike the ordinary read resolver, this deliberately takes row locks on
 * both the live artifact and one matching mutable Namespace attachment.  The
 * junction lock is the authorization proof: a concurrent detach/revocation
 * of the last mutable attachment cannot commit between this check and the
 * pointer CAS in the same transaction.  It is two statements on purpose:
 * Postgres rejects `DISTINCT ... FOR UPDATE`, and a plain joined read would
 * not lock the junction row that proves authority.
 *
 * Call only inside the Workspace mutation transaction.  The caller retains
 * the transaction through its artifact advisory lock and CAS; do not use this
 * as a generic read helper.
 */
export async function lockMutableArtifactForWorkspaceMutation(
  params: {
    internalId: string;
    mutableNamespaceIds: string[];
  },
  tx: WorkspaceDocumentMutationTx,
): Promise<Artifact | null> {
  if (params.mutableNamespaceIds.length === 0) return null;

  // Lock the artifact separately so logical rename/delete cannot drift while
  // the mutation backend proves its expected identity and executes the CAS.
  const [artifact] = await tx
    .select()
    .from(artifacts)
    .where(and(
      eq(artifacts.id, params.internalId),
      ordinaryArtifactRowPredicate(),
      isNull(artifacts.deletedAt),
    ))
    .limit(1)
    .for("update");
  if (!artifact) return null;

  // A matching junction is the durable mutable-authority evidence. Lock at
  // least one such row; detach/revocation of that proof then serializes after
  // the mutation transaction instead of racing its re-check/CAS window.
  const [namespace] = await tx
    .select({ artifactId: artifactNamespaces.artifactId })
    .from(artifactNamespaces)
    .where(and(
      eq(artifactNamespaces.artifactId, artifact.id),
      inArray(artifactNamespaces.namespaceId, params.mutableNamespaceIds),
    ))
    .limit(1)
    .for("update");
  if (!namespace) return null;
  return legacyArtifact(artifact);
}

/** Pure final gate for the transaction proof; kept separate for hermetic race fixtures. */
export function workspaceRoomAuthorityProofAllows(input: {
  readonly currentRoomExists: boolean;
  readonly currentRoomHumanActorIds: readonly string[];
  readonly humanActorId: string;
  readonly humanMembershipExists: boolean;
  readonly agentMirrorMembershipExists: boolean;
  readonly readableNamespaceIds: readonly string[];
  readonly attachedNamespaceIds: readonly string[];
}): boolean {
  return input.currentRoomExists &&
    input.currentRoomHumanActorIds.length > 0 &&
    input.currentRoomHumanActorIds.includes(input.humanActorId) &&
    input.humanMembershipExists &&
    input.agentMirrorMembershipExists &&
    input.readableNamespaceIds.some((namespaceId) => input.attachedNamespaceIds.includes(namespaceId));
}

export type LockedWorkspaceRoomMutationAuthority = {
  /** The current Room's own Namespace is the existing create authority. */
  readonly createNamespaceId: string;
  /** Exact current PersonalPolicyResolver-compatible readable Namespace set. */
  readonly readableNamespaceIds: readonly string[];
};

/**
 * Read-only current-Room authority used before a Workspace coordinator takes
 * its transaction locks. The transaction path re-proves the same facts with
 * `lockWorkspaceRoomMutationAuthority` before any authoritative mutation.
 */
export async function resolveWorkspaceRoomMutationAuthority(
  params: {
    humanActorId: string;
    agentId: string;
    roomId: string;
  },
  conn: Database = db,
): Promise<LockedWorkspaceRoomMutationAuthority | null> {
  if (!params.humanActorId || !params.agentId || !params.roomId) return null;
  const boundary = createNamespaceBoundaryProjection();
  const [currentRoom] = await conn
    .select({
      id: boundary.sourceRoom.id,
      namespaceId: boundary.sourceRoom.namespaceId,
      humanActorIds: boundary.sourceRoom.humanActorIds,
      publicBoundaryRoomId: boundary.publicBoundaryRoomId,
    })
    .from(boundary.sourceRoom)
    .leftJoin(
      boundary.publicBoundaryRoom,
      boundary.publicBoundaryJoin,
    )
    .where(eq(boundary.sourceRoom.id, params.roomId))
    .limit(1);
  if (!currentRoom) return null;

  const [humanMembership] = await conn
    .select({ actorId: roomMembers.actorId })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, currentRoom.id), eq(roomMembers.actorId, params.humanActorId)))
    .limit(1);
  const [agentActor] = await conn
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.agentId, params.agentId), eq(actors.kind, "agent")))
    .limit(1);
  if (!agentActor) return null;
  const [agentMembership] = await conn
    .select({ actorId: roomMembers.actorId })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, currentRoom.id), eq(roomMembers.actorId, agentActor.id)))
    .limit(1);
  if (
    !humanMembership ||
    !agentMembership ||
    currentRoom.humanActorIds.length === 0 ||
    !currentRoom.humanActorIds.includes(params.humanActorId)
  ) return null;

  const readableRooms = await conn
    .select({ namespaceId: rooms.namespaceId })
    .from(rooms)
    .where(
      namespaceSubsetPredicate(
        currentRoom.humanActorIds,
        currentRoom.publicBoundaryRoomId !== null,
      ),
    );
  return {
    createNamespaceId: currentRoom.namespaceId,
    readableNamespaceIds: [
      ...new Set([
        currentRoom.namespaceId,
        ...readableRooms.map((room) => room.namespaceId),
      ]),
    ],
  };
}

/**
 * Locks and proves the existing current-Room mutation authority without
 * selecting an artifact. This is the create-path counterpart to
 * `lockWorkspaceArtifactForCurrentRoomAuthority`; both reuse the same Room,
 * human membership, agent mirror membership, and subset Namespace rule.
 */
export async function lockWorkspaceRoomMutationAuthority(
  params: {
    humanActorId: string;
    agentId: string;
    roomId: string;
  },
  tx: WorkspaceDocumentMutationTx,
): Promise<LockedWorkspaceRoomMutationAuthority | null> {
  if (!params.humanActorId || !params.agentId || !params.roomId) return null;
  const boundary = createNamespaceBoundaryProjection();
  const [currentRoom] = await tx
    .select({
      id: boundary.sourceRoom.id,
      namespaceId: boundary.sourceRoom.namespaceId,
      humanActorIds: boundary.sourceRoom.humanActorIds,
      publicBoundaryRoomId: boundary.publicBoundaryRoomId,
    })
    .from(boundary.sourceRoom)
    .leftJoin(
      boundary.publicBoundaryRoom,
      boundary.publicBoundaryJoin,
    )
    .where(eq(boundary.sourceRoom.id, params.roomId))
    .limit(1);
  if (!currentRoom) return null;

  // Discover first, then lock the complete Room set in the same parent-first
  // order used by access publication. A source-first lock followed by an
  // unsorted readable set can deadlock with a writer from another Room.
  const candidates = await tx.select({ id: rooms.id, namespaceId: rooms.namespaceId })
    .from(rooms).where(namespaceSubsetPredicate(currentRoom.humanActorIds,
      currentRoom.publicBoundaryRoomId !== null));
  const discovered = await discoverRoomAuthorityInTx(tx, [currentRoom.id, ...candidates.map((room) => room.id)]);
  let locked: Awaited<ReturnType<typeof lockDiscoveredRoomAuthorityInTx>>;
  try {
    locked = await lockDiscoveredRoomAuthorityInTx(tx, discovered, "update");
  } catch (error) {
    if (error instanceof RoomAuthorityChangedError) return null;
    throw error;
  }
  const lockedSource = locked.find((room) => room.id === currentRoom.id);
  const publicBoundary = locked.some((room) => room.namespaceId === currentRoom.namespaceId && room.kind === "open");
  if (!lockedSource || lockedSource.namespaceId !== currentRoom.namespaceId
    || JSON.stringify([...lockedSource.humanActorIds].sort()) !== JSON.stringify([...currentRoom.humanActorIds].sort())
    || publicBoundary !== (currentRoom.publicBoundaryRoomId !== null)) return null;
  const readableRooms = await tx.select({ id: rooms.id, namespaceId: rooms.namespaceId })
    .from(rooms).where(namespaceSubsetPredicate(lockedSource.humanActorIds, publicBoundary));
  // A changed readable set is not permission to acquire another Room after
  // the ordered phase. The caller can resolve fresh authority for a new try.
  if (JSON.stringify(readableRooms.map((room) => room.id).sort())
    !== JSON.stringify(candidates.map((room) => room.id).sort())) return null;

  const [humanMembership] = await tx
    .select({ actorId: roomMembers.actorId })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, currentRoom.id), eq(roomMembers.actorId, params.humanActorId)))
    .limit(1)
    .for("update");
  const [agentActor] = await tx
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.agentId, params.agentId), eq(actors.kind, "agent")))
    .limit(1)
    .for("update");
  if (!agentActor) return null;
  const [agentMembership] = await tx
    .select({ actorId: roomMembers.actorId })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, currentRoom.id), eq(roomMembers.actorId, agentActor.id)))
    .limit(1)
    .for("update");
  if (
    !humanMembership ||
    !agentMembership ||
    currentRoom.humanActorIds.length === 0 ||
    !currentRoom.humanActorIds.includes(params.humanActorId)
  ) return null;

  return {
    createNamespaceId: currentRoom.namespaceId,
    readableNamespaceIds: [
      ...new Set([
        currentRoom.namespaceId,
        ...readableRooms.map((room) => room.namespaceId),
      ]),
    ],
  };
}

/**
 * D448/M227 transaction-time Workspace authority proof. This reproduces the
 * PersonalPolicyResolver's effective-audience rule from current trusted rows:
 * a private room can read every Room namespace whose human set is a superset;
 * a public boundary can read only qualifying public boundaries. Both include
 * their own namespace. It locks the current Room, both named
 * actor memberships, every qualifying Room namespace, the artifact and its
 * qualifying attachment through the caller's eventual CAS.
 *
 * No envelope namespace snapshot is accepted here. A deleted room/member,
 * a changed human set, or an attachment detach therefore cannot slip between
 * admission and CAS.
 */
export async function lockWorkspaceArtifactForCurrentRoomAuthority(
  params: {
    internalId: string;
    humanActorId: string;
    agentId: string;
    roomId: string;
  },
  tx: WorkspaceDocumentMutationTx,
): Promise<Artifact | null> {
  const roomAuthority = await lockWorkspaceRoomMutationAuthority(params, tx);
  if (!roomAuthority || roomAuthority.readableNamespaceIds.length === 0) return null;

  const [artifact] = await tx
    .select()
    .from(artifacts)
    .where(and(
      eq(artifacts.id, params.internalId),
      ordinaryArtifactRowPredicate(),
      isNull(artifacts.deletedAt),
    ))
    .limit(1)
    .for("update");
  if (!artifact) return null;
  const [attachment] = await tx
    .select({ namespaceId: artifactNamespaces.namespaceId })
    .from(artifactNamespaces)
    .where(and(
      eq(artifactNamespaces.artifactId, artifact.id),
      inArray(artifactNamespaces.namespaceId, roomAuthority.readableNamespaceIds),
    ))
    .limit(1)
    .for("update");
  return attachment ? legacyArtifact(artifact) : null;
}

/** Transaction-time twin used only by canonical history restoration. */
export async function lockWorkspaceArtifactIncludingDeletedForCurrentRoomAuthority(
  params: {
    internalId: string;
    humanActorId: string;
    agentId: string;
    roomId: string;
  },
  tx: WorkspaceDocumentMutationTx,
): Promise<Artifact | null> {
  const roomAuthority = await lockWorkspaceRoomMutationAuthority(params, tx);
  if (!roomAuthority || roomAuthority.readableNamespaceIds.length === 0) return null;
  const [artifact] = await tx
    .select()
    .from(artifacts)
    .where(and(
      eq(artifacts.id, params.internalId),
      ordinaryArtifactRowPredicate(),
    ))
    .limit(1)
    .for("update");
  if (!artifact) return null;
  const [attachment] = await tx
    .select({ namespaceId: artifactNamespaces.namespaceId })
    .from(artifactNamespaces)
    .where(and(
      eq(artifactNamespaces.artifactId, artifact.id),
      inArray(
        artifactNamespaces.namespaceId,
        roomAuthority.readableNamespaceIds,
      ),
    ))
    .limit(1)
    .for("update");
  return attachment ? legacyArtifact(artifact) : null;
}

/**
 * D448 — trusted restore lookup. This is deliberately narrower than the
 * normal resolver: the caller already has a history row naming the internal
 * artifact id, and needs to revalidate that its Namespace attachment is
 * still mutable even when the artifact is currently soft-deleted. It never
 * accepts a logical path and therefore cannot be used to discover hidden
 * artifacts by path.
 */
export async function findArtifactByInternalIdForNamespacesIncludingDeleted(
  params: {
    internalId: string;
    mutableNamespaceIds: string[];
  },
  conn: Database = db,
): Promise<Artifact | null> {
  if (params.mutableNamespaceIds.length === 0) return null;
  const [row] = await conn
    .selectDistinct({
      id: artifacts.id,
      artifactId: artifacts.artifactId,
      path: artifacts.path,
      mimeType: artifacts.mimeType,
      size: artifacts.size,
      storageUri: artifacts.storageUri,
      revision: artifacts.revision,
      createdAt: artifacts.createdAt,
      updatedAt: artifacts.updatedAt,
      deletedAt: artifacts.deletedAt,
    })
    .from(artifacts)
    .innerJoin(
      artifactNamespaces,
      eq(artifactNamespaces.artifactId, artifacts.id),
    )
    .where(
      and(
        eq(artifacts.id, params.internalId),
        ordinaryArtifactRowPredicate(),
        inArray(artifactNamespaces.namespaceId, params.mutableNamespaceIds),
      ),
    )
    .limit(1);
  return legacyArtifact(row);
}

export async function findArtifactByPathForNamespaces(
  params: {
    path: string;
    readableNamespaceIds: string[];
  },
  conn: Database | WorkspaceDocumentMutationTx = db,
): Promise<Artifact | null> {
  if (params.readableNamespaceIds.length === 0) return null;
  const [row] = await conn
    .selectDistinct({
      id: artifacts.id,
      artifactId: artifacts.artifactId,
      path: artifacts.path,
      mimeType: artifacts.mimeType,
      size: artifacts.size,
      storageUri: artifacts.storageUri,
      revision: artifacts.revision,
      createdAt: artifacts.createdAt,
      updatedAt: artifacts.updatedAt,
      deletedAt: artifacts.deletedAt,
    })
    .from(artifacts)
    .innerJoin(
      artifactNamespaces,
      eq(artifactNamespaces.artifactId, artifacts.id),
    )
    .where(
      and(
        eq(artifacts.path, params.path),
        ordinaryArtifactRowPredicate(),
        inArray(artifactNamespaces.namespaceId, params.readableNamespaceIds),
        isNull(artifacts.deletedAt),
      ),
    )
    .limit(1);
  return legacyArtifact(row);
}

export async function listArtifactsForNamespaces(
  params: {
    readableNamespaceIds: string[];
    pathPrefix?: string;
    limit?: number;
  },
  conn: Database = db,
): Promise<Artifact[]> {
  if (params.readableNamespaceIds.length === 0) return [];
  const conditions = [
    inArray(artifactNamespaces.namespaceId, params.readableNamespaceIds),
    ordinaryArtifactRowPredicate(),
    isNull(artifacts.deletedAt),
  ];
  if (params.pathPrefix && params.pathPrefix.length > 0) {
    conditions.push(sql`${artifacts.path} LIKE ${params.pathPrefix + "%"}`);
  }
  const query = conn
    .selectDistinct({
      id: artifacts.id,
      artifactId: artifacts.artifactId,
      path: artifacts.path,
      mimeType: artifacts.mimeType,
      size: artifacts.size,
      storageUri: artifacts.storageUri,
      revision: artifacts.revision,
      createdAt: artifacts.createdAt,
      updatedAt: artifacts.updatedAt,
      deletedAt: artifacts.deletedAt,
    })
    .from(artifacts)
    .innerJoin(
      artifactNamespaces,
      eq(artifactNamespaces.artifactId, artifacts.id),
    )
    .where(and(...conditions))
    .orderBy(desc(artifacts.updatedAt));
  if (typeof params.limit === "number" && params.limit > 0) {
    return (await query.limit(params.limit)).map((row) => legacyArtifact(row)!);
  }
  return (await query).map((row) => legacyArtifact(row)!);
}

export type ArtifactListKeyset = Readonly<{
  createdAt: string;
  id: string;
  snapshotAt: Date;
}>;

/**
 * M322 — opt-in bounded Artifact inventory page. The legacy list above keeps
 * its exact ordering and response behavior for frozen Mobile callers. The
 * creation-time cutoff makes one traversal finite; access changes to older
 * rows are reconciled by list invalidation and a fresh traversal, not claimed
 * as an MVCC snapshot.
 */
export async function listArtifactPageForNamespaces(
  params: {
    readableNamespaceIds: string[];
    pathPrefix?: string;
    limit: number;
    snapshotAt: Date;
    after?: Readonly<{ createdAt: string; id: string }>;
  },
  conn: Database = db,
): Promise<Readonly<{ artifacts: Artifact[]; next: ArtifactListKeyset | null }>> {
  if (params.readableNamespaceIds.length === 0) {
    return { artifacts: [], next: null };
  }
  const conditions = [
    inArray(artifactNamespaces.namespaceId, params.readableNamespaceIds),
    ordinaryArtifactRowPredicate(),
    isNull(artifacts.deletedAt),
    lte(artifacts.createdAt, params.snapshotAt),
  ];
  if (params.pathPrefix && params.pathPrefix.length > 0) {
    conditions.push(like(artifacts.path, params.pathPrefix + "%"));
  }
  if (params.after) {
    const afterCreatedAt = sql`${params.after.createdAt}::timestamptz`;
    conditions.push(or(
      lt(artifacts.createdAt, afterCreatedAt),
      and(
        eq(artifacts.createdAt, afterCreatedAt),
        lt(artifacts.id, params.after.id),
      ),
    ));
  }
  const rows = await conn
    .selectDistinct({
      id: artifacts.id,
      artifactId: artifacts.artifactId,
      path: artifacts.path,
      mimeType: artifacts.mimeType,
      size: artifacts.size,
      storageUri: artifacts.storageUri,
      revision: artifacts.revision,
      createdAt: artifacts.createdAt,
      createdAtCursor: sql<string>`to_char(${artifacts.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      updatedAt: artifacts.updatedAt,
      deletedAt: artifacts.deletedAt,
    })
    .from(artifacts)
    .innerJoin(
      artifactNamespaces,
      eq(artifactNamespaces.artifactId, artifacts.id),
    )
    .where(and(...conditions))
    .orderBy(desc(artifacts.createdAt), desc(artifacts.id))
    .limit(params.limit + 1);
  const hasMore = rows.length > params.limit;
  const pageRows = rows.slice(0, params.limit);
  const page = pageRows.map((row) => legacyArtifact(row)!);
  const last = pageRows.at(-1);
  return {
    artifacts: page,
    next: hasMore && last
      ? { createdAt: last.createdAtCursor, id: last.id, snapshotAt: params.snapshotAt }
      : null,
  };
}


export type ExactNamespaceArtifactPageCursor = Readonly<{
  updatedAt: Date;
  id: string;
}>;

/**
 * Keyset page for a host-owned collection stored as ordinary Artifacts.
 * Every returned row must have exactly one Namespace edge, equal to the
 * requested Namespace. This is stricter than ordinary Workspace visibility:
 * a later share removes the row from the private collection immediately.
 */
export function buildExactNamespaceArtifactPageQuery(
  params: Readonly<{
    namespaceId: string;
    pathPrefix: string;
    mimeType: string;
    pageSize: number;
    cursor?: ExactNamespaceArtifactPageCursor;
  }>,
  conn: Database = db,
) {
  const otherEdges = alias(artifactNamespaces, "artifact_collection_other_edges");
  const conditions = [
    eq(artifactNamespaces.namespaceId, params.namespaceId),
    ordinaryArtifactRowPredicate(),
    isNull(artifacts.deletedAt),
    like(artifacts.path, params.pathPrefix + "%"),
    eq(artifacts.mimeType, params.mimeType),
    notExists(
      conn
        .select({ artifactId: otherEdges.artifactId })
        .from(otherEdges)
        .where(and(
          eq(otherEdges.artifactId, artifacts.id),
          ne(otherEdges.namespaceId, params.namespaceId),
        )),
    ),
  ];
  if (params.cursor) {
    conditions.push(or(
      lt(artifacts.updatedAt, params.cursor.updatedAt),
      and(
        eq(artifacts.updatedAt, params.cursor.updatedAt),
        lt(artifacts.id, params.cursor.id),
      ),
    ));
  }
  return conn
    .select({
      id: artifacts.id,
      artifactId: artifacts.artifactId,
      path: artifacts.path,
      mimeType: artifacts.mimeType,
      size: artifacts.size,
      storageUri: artifacts.storageUri,
      revision: artifacts.revision,
      createdAt: artifacts.createdAt,
      updatedAt: artifacts.updatedAt,
      deletedAt: artifacts.deletedAt,
    })
    .from(artifacts)
    .innerJoin(
      artifactNamespaces,
      eq(artifactNamespaces.artifactId, artifacts.id),
    )
    .where(and(...conditions))
    .orderBy(desc(artifacts.updatedAt), desc(artifacts.id))
    .limit(params.pageSize);
}

export async function listArtifactsForExactNamespacePage(
  params: Readonly<{
    namespaceId: string;
    pathPrefix: string;
    mimeType: string;
    pageSize: number;
    cursor?: ExactNamespaceArtifactPageCursor;
  }>,
  conn: Database = db,
): Promise<Artifact[]> {
  const rows = await buildExactNamespaceArtifactPageQuery(params, conn);
  return rows.map((row) => legacyArtifact(row)!);
}

/** Soft-delete only while the Artifact still belongs to this Namespace alone. */
export async function markArtifactDeletedForExactNamespace(
  params: Readonly<{ id: string; namespaceId: string }>,
  conn: Database = db,
): Promise<Artifact | null> {
  const otherEdges = alias(artifactNamespaces, "artifact_delete_other_edges");
  const requiredEdge = alias(artifactNamespaces, "artifact_delete_required_edge");
  const [deleted] = await conn
    .update(artifacts)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(artifacts.id, params.id),
      ordinaryArtifactRowPredicate(),
      isNull(artifacts.deletedAt),
      notExists(
        conn
          .select({ artifactId: otherEdges.artifactId })
          .from(otherEdges)
          .where(and(
            eq(otherEdges.artifactId, artifacts.id),
            ne(otherEdges.namespaceId, params.namespaceId),
          )),
      ),
      exists(
        conn
          .select({ artifactId: requiredEdge.artifactId })
          .from(requiredEdge)
          .where(and(
            eq(requiredEdge.artifactId, artifacts.id),
            eq(requiredEdge.namespaceId, params.namespaceId),
          )),
      ),
    ))
    .returning();
  return legacyArtifact(deleted);
}

/**
 * Logical-path rename. Caller is responsible for confirming the
 * artifact's namespaces overlap the envelope's `mutableNamespaces`
 * before invoking. Returns the updated row, or `null` if no row
 * matched.
 */
/**
 * Cheap path-only lookup by internal uuid. No filters: callers (e.g. the
 * agent's `applyWorkspaceArtifactRowChange` `logical_move` branch) need
 * the row's CURRENT path so the emitted SSE `renamed` event carries the
 * right `oldPath`. Returns null when the row doesn't exist.
 */
export async function getArtifactPathByInternalId(
  id: string,
  conn: Database = db,
): Promise<string | null> {
  const [row] = await conn
    .select({ path: artifacts.path })
    .from(artifacts)
    .where(and(eq(artifacts.id, id), ordinaryArtifactRowPredicate()))
    .limit(1);
  return row?.path ?? null;
}

export async function updateArtifactPath(
  params: {
    id: string;
    newPath: string;
    /** Workspace logical moves opt in; existing callers preserve prior revision behavior. */
    bumpRevision?: boolean;
  },
  conn: Database = db,
): Promise<Artifact | null> {
  const [updated] = await conn
    .update(artifacts)
    .set({
      path: params.newPath,
      ...(params.bumpRevision ? { revision: sql`${artifacts.revision} + 1` } : {}),
      updatedAt: new Date(),
    })
    .where(and(
      eq(artifacts.id, params.id),
      ordinaryArtifactRowPredicate(),
      isNull(artifacts.deletedAt),
    ))
    .returning();
  return legacyArtifact(updated);
}

/**
 * Bump revision + updatedAt + size on apply_patch success. Bytes have
 * already been written to disk at this point.
 */
export async function bumpArtifactRevision(
  params: {
    id: string;
    size: number;
    /** When set (e.g. from logical path at write time), refresh stored mime on bump. */
    mimeType?: string;
  },
  conn: Database = db,
): Promise<Artifact | null> {
  const [updated] = await conn
    .update(artifacts)
    .set({
      revision: sql`${artifacts.revision} + 1`,
      size: params.size,
      ...(params.mimeType !== undefined && params.mimeType.length > 0
        ? { mimeType: params.mimeType }
        : {}),
      updatedAt: new Date(),
    })
    .where(and(
      eq(artifacts.id, params.id),
      ordinaryArtifactRowPredicate(),
      isNull(artifacts.deletedAt),
    ))
    .returning();
  return legacyArtifact(updated);
}

export async function markArtifactDeleted(
  params: {
    id: string;
    /** Workspace deletes opt in; existing callers preserve prior behavior. */
    bumpRevision?: boolean;
    /** D448 restore/undo caller's authoritative row-drift guard. */
    expectedRevision?: number;
  },
  conn: Database = db,
): Promise<Artifact | null> {
  const [updated] = await conn
    .update(artifacts)
    .set({
      deletedAt: new Date(),
      ...(params.bumpRevision ? { revision: sql`${artifacts.revision} + 1` } : {}),
      updatedAt: new Date(),
    })
    .where(and(
      eq(artifacts.id, params.id),
      ordinaryArtifactRowPredicate(),
      isNull(artifacts.deletedAt),
      ...(params.expectedRevision === undefined ? [] : [eq(artifacts.revision, params.expectedRevision)]),
    ))
    .returning();
  return legacyArtifact(updated);
}

/**
 * D448 — atomically make a previously soft-deleted Workspace artifact
 * visible again, or restore an active artifact's historical path/size. The
 * expected revision is the authoritative drift guard captured through the
 * existing Namespace resolver immediately before the byte mutation.
 */
export async function restoreArtifactRevision(
  params: {
    id: string;
    expectedRevision: number;
    path: string;
    size: number;
    mimeType?: string;
    expectedDeleted: boolean;
  },
  conn: Database = db,
): Promise<Artifact | null> {
  const [updated] = await conn
    .update(artifacts)
    .set({
      deletedAt: null,
      path: params.path,
      size: params.size,
      revision: sql`${artifacts.revision} + 1`,
      ...(params.mimeType !== undefined && params.mimeType.length > 0
        ? { mimeType: params.mimeType }
        : {}),
      updatedAt: new Date(),
    })
    .where(and(
      eq(artifacts.id, params.id),
      ordinaryArtifactRowPredicate(),
      eq(artifacts.revision, params.expectedRevision),
      params.expectedDeleted ? isNotNull(artifacts.deletedAt) : isNull(artifacts.deletedAt),
    ))
    .returning();
  return legacyArtifact(updated);
}

/**
 * D442 Phase 4.1 — eligible discussion rooms for a specific readable
 * artifact, from the requesting viewer's perspective.
 *
 * Returns rooms that satisfy ALL of:
 *   1. The room backs a namespace attached to the artifact
 *      (`rooms.namespace_id = artifact_namespaces.namespace_id`).
 *   2. That namespace is in the viewer's `readableNamespaceIds` set
 *      (the envelope's authorized All-contexts set). This is the
 *      authorization gate: namespaces the viewer cannot read are
 *      never resolved to a room, so an unreadable attachment can't
 *      leak the room that owns it.
 *   3. The viewer (`viewerActorId`) is currently a member of the room
 *      (`room_members`). This is the stale-envelope / revoked-membership
 *      denial: an envelope may carry a readable namespace whose room
 *      the viewer was removed from since the envelope was minted; the
 *      membership row is the source of truth, not the envelope.
 *
 * Archived rooms and non-conversational kinds (`task`, `access`) are
 * excluded, mirroring `listRoomsForActor`. The result is deduped by
 * room id (defensive — `rooms.namespace_id` is unique 1:1, so an
 * artifact's distinct attached namespaces already map to distinct
 * rooms; DISTINCT keeps the contract stable if that invariant ever
 * widens).
 *
 * The shape intentionally carries NO namespace id: callers must not
 * surface raw namespaces as UI. The route returns `{ id, label, kind }`
 * per room.
 */
export type ArtifactDiscussionRoomCandidate = {
  id: string;
  label: string;
  kind: string;
};

export interface ListDiscussionRoomsForArtifactInput {
  artifactInternalId: string;
  readableNamespaceIds: string[];
  viewerActorId: string;
}

export async function listDiscussionRoomsForArtifact(
  params: ListDiscussionRoomsForArtifactInput,
  conn: Db = db,
): Promise<ArtifactDiscussionRoomCandidate[]> {
  if (!params.viewerActorId || params.readableNamespaceIds.length === 0) {
    return [];
  }
  const rows = await conn
    .selectDistinct({
      id: rooms.id,
      label: rooms.label,
      kind: rooms.kind,
      // PostgreSQL requires every ORDER BY expression to appear in a
      // SELECT DISTINCT projection. Keep this internal sort key out of the
      // public candidate shape when mapping below.
      createdAt: rooms.createdAt,
    })
    .from(artifactNamespaces)
    .innerJoin(artifacts, eq(artifacts.id, artifactNamespaces.artifactId))
    .innerJoin(rooms, eq(rooms.namespaceId, artifactNamespaces.namespaceId))
    .innerJoin(
      roomMembers,
      and(eq(roomMembers.roomId, rooms.id), eq(roomMembers.actorId, params.viewerActorId)),
    )
    .where(
      and(
        eq(artifactNamespaces.artifactId, params.artifactInternalId),
        ordinaryArtifactRowPredicate(),
        isNull(artifacts.deletedAt),
        inArray(artifactNamespaces.namespaceId, params.readableNamespaceIds),
        isNull(rooms.archivedAt),
        sql`${rooms.kind} NOT IN ('task', 'access')`,
      ),
    )
    .orderBy(desc(rooms.createdAt));
  return rows.map((r) => ({ id: r.id, label: r.label, kind: r.kind }));
}
