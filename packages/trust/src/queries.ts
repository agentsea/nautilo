import { createHash, randomUUID } from "node:crypto";
import {
  eq,
  and,
  isNull,
  isNotNull,
  sql,
  desc,
  asc,
  inArray,
  notInArray,
  count,
  ilike,
  notLike,
  getSharedDirectDb,
  agentDb,
  getSharedDirectAgentDb,
  type Database,
  withTrustContext,
  usersPublic,
  actors,
  agents,
  users,
  groups,
  groupMembers,
  groupRoles,
  roles,
  roleCapabilities,
  capabilities,
  rooms,
  roomMembers,
  profiles,
  sessions,
  sessionMessages,
  channelIdentities,
  namespaces,
  agentScopes,
  memoryScopes,
  memoryNamespaces,
  type InviteSeedTx,
  type SQL,
  acquireRoomWriteLock,
  createNamespaceBoundaryProjection,
  createRoomJournalStateInTx,
  reconcileRoomJournalMembershipInTx,
  namespaceSubsetPredicate,
  privateNamespaceBoundarySql,
} from "@nautilo/db";
import { composeFederatedId, getServerHostname } from "@nautilo/config";
import type { MemoryAccessEnvelope } from "./types";
import type { CapabilitySlug } from "./capabilities";
import type { AvatarRef, RoomMembershipSystemEventPayload } from "@nautilo/types";
import {
  invalidateRespondersForBotInParentChildren,
  invalidateSubthreadResponders,
} from "./focus/responder";
import {
  getChangedNotificationState,
  getLegacyOwnRoomUnreadCounts,
} from "./notification-state";

// ---------------------------------------------------------------------------
// Actor queries
// ---------------------------------------------------------------------------

/**
 * Finds the human owner actor for a given users.id.
 *
 * M042B: filters on `kind = 'user'`. Post-M042B, a single ownerId has
 * multiple actor rows (owner-human + agent-mirror-actor) — without
 * the kind filter this query could silently return the agent actor
 * and break approval routing. The filter is the canonical guard; do
 * NOT add a caller-supplied kind parameter.
 */
export async function findActorByOwnerId(
  ownerId: string,
): Promise<{ id: string; displayName: string; trustState: string } | null> {
  const db = getSharedDirectDb();
  const [actor] = await db
    .select({
      id: actors.id,
      displayName: actors.displayName,
      trustState: actors.trustState,
    })
    .from(actors)
    .where(and(eq(actors.ownerId, ownerId), eq(actors.kind, "user")))
    .limit(1);
  return actor ?? null;
}

/**
 * M126 — resolve a Logto `sub` to the local `(actorId, userId)` pair.
 * Pure read; invites are the only path to a `users` row (JIT retired).
 * Returns `null` when no `users.external_id` match exists.
 */
export async function findActorByLogtoSub(
  sub: string,
): Promise<{ actorId: string; userId: string; disabledAt: Date | null } | null> {
  const db = getSharedDirectDb();
  const [user] = await db
    .select({ id: users.id, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.externalId, sub))
    .limit(1);
  if (!user) return null;
  const actor = await findActorByOwnerId(user.id);
  if (!actor) {
    throw new Error(
      `User ${user.id} has external_id=${sub} but no user-kind actor row — invariant violated`,
    );
  }
  // D219 — surface soft-delete state so the bearer resolver can
  // fail-closed (the trust preHandler 401s a disabled account).
  return { actorId: actor.id, userId: user.id, disabledAt: user.disabledAt };
}

/**
 * M045 — find the mirror Actor row for a specific Agent. REL-ACT-AGT is
 * 1:1 (one agent-kind Actor per Agent), so `.limit(1)` is deterministic
 * when keyed on `agentId`. Replaces the pre-M045 `findAgentActorByOwnerId`
 * which was keyed on the owner (non-deterministic the moment a single
 * user owns more than one Agent).
 *
 * Dead-code cleanup: the old helper was exported but never called in
 * production — `seedDefaultRoom` and `loadRoomRoster` both inline their
 * own queries against `actors`. Keeping a well-shaped primitive here for
 * the forward-looking multi-agent surface (M042 Iteration 2+).
 */
export async function findAgentActorForAgent(
  agentId: string,
): Promise<{ id: string; displayName: string; agentId: string } | null> {
  if (!agentId) return null;
  const db = getSharedDirectDb();
  const [actor] = await db
    .select({
      id: actors.id,
      displayName: actors.displayName,
      agentId: actors.agentId,
    })
    .from(actors)
    .where(and(eq(actors.agentId, agentId), eq(actors.kind, "agent")))
    .limit(1);
  if (!actor || !actor.agentId) return null;
  return {
    id: actor.id,
    displayName: actor.displayName,
    agentId: actor.agentId,
  };
}

/**
 * Resolve the canonical Human owner of one exact Genie mirror Actor.
 * REL-ACT-AGT is 1:1; duplicate mirror rows are malformed authority and must
 * fail closed instead of silently selecting one owner.
 */
export async function findAgentOwnerUserId(
  agentId: string,
): Promise<string | null> {
  if (!agentId) return null;
  const db = getSharedDirectDb();
  const rows = await db
    .select({ userId: users.id })
    .from(actors)
    .innerJoin(users, eq(users.id, actors.ownerId))
    .where(and(eq(actors.kind, "agent"), eq(actors.agentId, agentId)))
    .limit(2);
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new AmbiguousAgentOwnerError();
  }
  return rows[0]!.userId;
}

export class AmbiguousAgentOwnerError extends Error {
  constructor() {
    super("Agent target unavailable: ambiguous owner");
    this.name = "AmbiguousAgentOwnerError";
  }
}

// ---------------------------------------------------------------------------
// Agent queries
// ---------------------------------------------------------------------------

/**
 * M042A: look up an agent by id. Used by resolveContext +
 * getFederatedIdForActor to compose the agent's `@handle@server` string.
 *
 * M045: `agents.owner_id` was dropped. Post-M128, Agents are
 * Resources without per-Agent permission semantics; any Human
 * holding `manage_agents` can manage every Agent. The return shape
 * no longer carries `ownerId`.
 */
export async function findAgentById(
  agentId: string,
): Promise<{ id: string; handle: string; displayName: string } | null> {
  const db = getSharedDirectDb();
  const [agent] = await db
    .select({
      id: agents.id,
      handle: agents.handle,
      displayName: sql<string>`COALESCE(${profiles.name}, 'Genie')`,
    })
    .from(agents)
    .leftJoin(profiles, eq(profiles.agentId, agents.id))
    .where(eq(agents.id, agentId))
    .limit(1);
  return agent ?? null;
}

// ---------------------------------------------------------------------------
// M042C — user / actor / channel identity lookups
// ---------------------------------------------------------------------------

/**
 * M042C: look up a user by id, returning the federated-id local part
 * (`users.handle`) alongside display name. Used by `resolveContext` to
 * compose the owner's `actorFederatedId` and by the preHandler's
 * `getFederatedIdForActor`.
 *
 * M047: return shape grows `server: string | null`. NULL = local (the
 * canonical default); non-NULL = the home Server's hostname for a
 * foreign-origin stub. `getFederatedIdForActor` reads this to render
 * `@handle@home-server` correctly for federated Humans.
 *
 * D219: the legacy M061 `serverRole` enum was retired — server-wide
 * authority is derived from Capabilities (`getUserCapabilities`) /
 * `userHasCapability`, not a column on `users`.
 */
export async function findUserById(
  userId: string,
): Promise<{
  id: string;
  name: string;
  handle: string | null;
  server: string | null;
  externalId: string | null;
} | null> {
  const db = getSharedDirectDb();
  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      handle: users.handle,
      server: users.server,
      externalId: users.externalId,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return user ?? null;
}

/**
 * M087 — read the account-level IANA timezone for a user. Returns `null`
 * when the user has no stored timezone (consumers fall back to "UTC") or the
 * user row is absent.
 */
export async function loadUserTimezone(userId: string): Promise<string | null> {
  if (!userId) return null;
  const db = getSharedDirectDb();
  const [row] = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.timezone ?? null;
}

/**
 * M087 — persist `users.timezone` only when it differs from the stored
 * value (single read-then-write, skip when equal). Best-effort: callers
 * invoke this fire-and-forget so a failure logs but never blocks the turn.
 * A race with another concurrent update is acceptable (last-write-wins).
 */
export async function persistUserTimezoneIfChanged(
  userId: string,
  tz: string,
): Promise<void> {
  if (!userId || !tz) return;
  const db = getSharedDirectDb();
  const [row] = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return;
  if (row.timezone === tz) return;
  await db.update(users).set({ timezone: tz }).where(eq(users.id, userId));
}

/**
 * M033 Phase 3 — sanitized user-display lookup readable by `nautilo_agent`.
 * Returns ONLY identity columns (no `external_id`, no `server_role`).
 * Use this from agent-callable code paths instead of `findUserById`,
 * which exposes PII and is auth-side only.
 *
 * Reads via the `users_public` view (exists by `infra/postgres-init.sh`).
 * Uses Neon HTTP `agentDb` — `users_public` is not RLS-gated, no wrap needed.
 */
export async function findUserDisplayInfo(
  userId: string,
): Promise<{
  id: string;
  name: string;
  handle: string | null;
  server: string | null;
} | null> {
  const [user] = await agentDb
    .select({
      id: usersPublic.id,
      name: usersPublic.name,
      handle: usersPublic.handle,
      server: usersPublic.server,
    })
    .from(usersPublic)
    .where(eq(usersPublic.id, userId))
    .limit(1);
  return user ?? null;
}

/**
 * D219: replaces the retired `isUserAdmin` enum read. True when `userId`
 * holds Capability `slug` via any Group→Role membership (REL-CAP-HUM).
 * Single indexed `EXISTS` (no N+1, no full cap-set materialisation).
 *
 * Server-tier gates map to capabilities, not a `server_role` enum:
 *   - "admin" surfaces  → `manage_members`
 *   - room management    → `manage_rooms`
 *   - agent management   → `manage_agents`
 *   - owner-only posture → `manage_server_security`
 */
export async function userHasCapability(
  userId: string,
  slug: CapabilitySlug,
): Promise<boolean> {
  const db = getSharedDirectDb();
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(groupMembers)
    .innerJoin(groups, eq(groupMembers.groupId, groups.id))
    .innerJoin(groupRoles, eq(groupRoles.groupId, groups.id))
    .innerJoin(roles, eq(groupRoles.roleId, roles.id))
    .innerJoin(roleCapabilities, eq(roles.id, roleCapabilities.roleId))
    .innerJoin(
      capabilities,
      eq(roleCapabilities.capabilityId, capabilities.id),
    )
    .where(and(eq(groupMembers.userId, userId), eq(capabilities.slug, slug)))
    .limit(1);
  return Boolean(row);
}

/**
 * M042C: look up an actor by id with its kind + back-pointer to agent.
 * Used by `resolveContext` after a channel_identities lookup, and by
 * `getFederatedIdForActor` in the preHandler.
 */
export async function findActorById(
  actorId: string,
): Promise<{
  id: string;
  ownerId: string;
  displayName: string;
  kind: "user" | "agent";
  agentId: string | null;
} | null> {
  const db = getSharedDirectDb();
  const [actor] = await db
    .select({
      id: actors.id,
      ownerId: actors.ownerId,
      displayName: actors.displayName,
      kind: actors.kind,
      agentId: actors.agentId,
    })
    .from(actors)
    .where(eq(actors.id, actorId))
    .limit(1);
  if (!actor) return null;
  const kind: "user" | "agent" = actor.kind === "agent" ? "agent" : "user";
  return {
    id: actor.id,
    ownerId: actor.ownerId,
    displayName: actor.displayName,
    kind,
    agentId: actor.agentId,
  };
}

/**
 * M043: resolve a `(channel, externalId)` pair to its user binding.
 * Returns null when no row exists; this is the stranger path.
 *
 * Pre-M043 this was `findActorByChannelIdentity` and returned an
 * actor-id + kind. Post-M043 channels only bind to Humans (see
 * REL-CHN-HUM), so the return shape collapses to `{ userId }`. Callers
 * that still need an actor id (sessions, room_members) resolve via
 * `findActorByOwnerId(userId)` as a separate step.
 */
export async function findUserByChannelIdentity(
  channel: string,
  externalId: string,
): Promise<{
  userId: string;
  verifiedAt: Date | null;
} | null> {
  const db = getSharedDirectDb();
  const [row] = await db
    .select({
      userId: channelIdentities.userId,
      verifiedAt: channelIdentities.verifiedAt,
    })
    .from(channelIdentities)
    .where(
      and(
        eq(channelIdentities.channel, channel),
        eq(channelIdentities.externalId, externalId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    userId: row.userId,
    verifiedAt: row.verifiedAt,
  };
}

/**
 * M042C: resolve a handle (the local part of a federated id) to its
 * actor. Channel-agnostic — joins `users.handle` for human actors and
 * `agents.handle` for agent-mirror actors. Used by WebFinger and the
 * handle-indexed profile route. Returns null when no match.
 *
 * M047: the human path scopes to `users.server IS NULL` (local-origin
 * rows only) so foreign-origin stubs for federated Humans don't leak
 * into `acct:<handle>@<local>` WebFinger resolution. An incoming
 * WebFinger request for `acct:alice@<local>` must only match a local
 * Human named `alice` — never a foreign stub `@alice@remote.com` that
 * happens to share the local-part handle.
 */
export async function findActorByHandle(
  handle: string,
): Promise<{
  actorId: string;
  kind: "user" | "agent";
  displayName: string;
  /** M125 Phase 2.9 — populated only for agent-kind rows. WebFinger uses this
   *  to resolve the agent's owner without a second handle lookup. */
  agentId?: string;
} | null> {
  const db = getSharedDirectDb();
  // Human path: local users.handle → owner-actor (actors.kind='user').
  const [userHit] = await db
    .select({
      actorId: actors.id,
      displayName: actors.displayName,
    })
    .from(users)
    .innerJoin(
      actors,
      and(eq(actors.ownerId, users.id), eq(actors.kind, "user")),
    )
    .where(and(eq(users.handle, handle), isNull(users.server)))
    .limit(1);
  if (userHit) {
    return {
      actorId: userHit.actorId,
      kind: "user",
      displayName: userHit.displayName,
    };
  }

  // Agent path: agents.handle → agent-actor (actors.kind='agent').
  const [agentHit] = await db
    .select({
      actorId: actors.id,
      displayName: actors.displayName,
      agentId: agents.id,
    })
    .from(agents)
    .innerJoin(
      actors,
      and(eq(actors.agentId, agents.id), eq(actors.kind, "agent")),
    )
    .where(eq(agents.handle, handle))
    .limit(1);
  if (agentHit) {
    return {
      actorId: agentHit.actorId,
      kind: "agent",
      displayName: agentHit.displayName,
      agentId: agentHit.agentId,
    };
  }

  return null;
}

/**
 * M042C: compose the federated id for whichever entity a given actor
 * row represents. Used by the server preHandler to map
 * `session.actorId` (a UUID) into the `@handle@server` string
 * `resolveContext` expects. Returns `""` when the actor has no
 * resolvable handle (stranger with no backing user/agent row, or a
 * pre-M042C row where `users.handle` is still NULL pre-seed).
 *
 * M047: for user-kind actors, the home-server part comes from
 * `users.server` when non-NULL (foreign-origin stub for a federated
 * Human) and falls back to `getServerHostname()` when NULL (local-origin
 * Human, the canonical case today). Agent-kind actors always render
 * against the local hostname — Agents are Server-local per REL-ACT-SRV
 * and do not federate.
 */
export async function getFederatedIdForActor(
  actorId: string,
): Promise<string> {
  const actor = await findActorById(actorId);
  if (!actor) return "";
  const localServer = getServerHostname();
  if (actor.kind === "agent" && actor.agentId) {
    const agent = await findAgentById(actor.agentId);
    return agent ? composeFederatedId(agent.handle, localServer) : "";
  }
  // kind === 'user' — join to users.handle; M047: use users.server
  // when set so foreign-origin rows render `@handle@home-server`.
  const user = await findUserById(actor.ownerId);
  if (!user?.handle) return "";
  return composeFederatedId(user.handle, user.server ?? localServer);
}

/**
 * M042C: unused today but retained as a primitive — union of user and
 * agent handle lookups keyed by handle string. Exposed for completeness;
 * `findActorByHandle` is the preferred entry point.
 */
export async function findHandleOwner(
  handle: string,
): Promise<{ kind: "user" | "agent"; id: string } | null> {
  const db = getSharedDirectDb();
  const [u] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.handle, handle))
    .limit(1);
  if (u) return { kind: "user", id: u.id };
  const [a] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.handle, handle))
    .limit(1);
  if (a) return { kind: "agent", id: a.id };
  return null;
}

// ---------------------------------------------------------------------------
// Namespace queries (M044 — Room-derived)
// ---------------------------------------------------------------------------
//
// Pre-M044 `getNamespacesForOwner` is gone — `namespaces.owner_id` was
// dropped because Namespace belongs to a Room (REL-NSP-RMS). The
// helpers below back the resolver's Room-subset rule: take a `roomId`,
// get the Room's Namespace id + human-member set; take a human-set,
// get every Room-NS whose human-set is a superset.

/**
 * M044/M227 — fetch a Room's Namespace id + denormalized human-member set
 * and derive whether its top-level Namespace boundary is public. Subthreads
 * inherit the boundary because the projection checks every Room backed by the
 * same Namespace.
 *
 * Returns `null` when the room doesn't exist (defensive — the resolver
 * falls back to the empty-envelope path).
 */
export async function getRoomWithAccess(
  roomId: string,
): Promise<{
  namespaceId: string;
  humanActorIds: string[];
  isPublicNamespaceBoundary: boolean;
} | null> {
  if (!roomId) return null;
  const db = getSharedDirectDb();
  const boundary = createNamespaceBoundaryProjection();
  const [row] = await db
    .select({
      namespaceId: boundary.sourceRoom.namespaceId,
      humanActorIds: boundary.sourceRoom.humanActorIds,
      publicBoundaryRoomId: boundary.publicBoundaryRoomId,
    })
    .from(boundary.sourceRoom)
    .leftJoin(
      boundary.publicBoundaryRoom,
      boundary.publicBoundaryJoin,
    )
    .where(eq(boundary.sourceRoom.id, roomId))
    .limit(1);
  if (!row) return null;
  return {
    namespaceId: row.namespaceId,
    humanActorIds: row.humanActorIds ?? [],
    isPublicNamespaceBoundary: row.publicBoundaryRoomId !== null,
  };
}

export type NamespaceSubsetSourcePolicy = {
  /**
   * Virtual `cosmos` audience marker. It is derived from the source
   * Namespace's top-level open Room and is never persisted as an Actor.
   */
  isPublicNamespaceBoundary: boolean;
};

/**
 * D476 — a deliberately small, requester-scoped Room candidate row for
 * name-driven projection sharing. Unlike `listRoomsForActor`, this is not an
 * explorer query: it does not load message activity, unread counts, or a
 * roster, and it never returns a caller's complete Room directory.
 */
export type AuthorizedRoomNameCandidateRow = Readonly<{
  id: string;
  namespaceId: string;
  label: string;
  normalizedLabel: string;
  kind: RoomSummaryRow["kind"];
  memberCount: number;
  /** Opaque trusted snapshot value; never place it in a candidate/UI DTO. */
  audienceFingerprint: string;
}>;

export type FindAuthorizedRoomNameCandidatesInput = Readonly<{
  /** Authenticated `users.id`, never supplied by the model. */
  requesterUserId: string;
  /** Authenticated Human `actors.id`, cross-checked against requesterUserId. */
  requesterActorId: string;
  /** Normalized human Room name, never a Room or Namespace identifier. */
  normalizedTargetRoomName: string;
  /** Internal bound; callers cannot request a directory listing. */
  limit?: number;
}>;

/** Never let a caller turn the resolver primitive into a Room directory. */
const MAX_AUTHORIZED_ROOM_NAME_QUERY_ROWS = 6;

export type AuthorizedRoomNameLookupStage = "exact" | "prefix" | "fuzzy";

/**
 * D476 query-shape contract. One- and two-character names are valid, but they
 * can only take btree-backed exact/prefix paths. pg_trgm is not selective
 * enough below three Unicode code points, so substring/fuzzy work is absent
 * from the plan rather than hidden behind a SQL FALSE branch.
 */
export function authorizedRoomNameLookupStages(
  normalizedTargetRoomName: string,
): readonly AuthorizedRoomNameLookupStage[] {
  return Array.from(normalizedTargetRoomName).length >= 3
    ? ["exact", "prefix", "fuzzy"]
    : ["exact", "prefix"];
}

/**
 * D476 — hash canonical membership identities after the database has applied
 * Room membership filters. This is an integrity fingerprint, not a public
 * identifier: it travels only through the trusted approval snapshot and is
 * compared against a fresh server-derived value before execution.
 */
function fingerprintAuthorizedRoomAudience(roomId: string, membershipRows: string): string {
  return createHash("sha256")
    .update(`d476:room-audience:v1\u0000${roomId}\u0000${membershipRows}`)
    .digest("hex");
}

/**
 * D476 — fetch a bounded candidate set for an authorized Room-name lookup.
 *
 * The membership join is canonical authority, not the denormalized
 * `human_actor_ids` cache. Joining the requester actor to `actors` verifies
 * that it is a Human actor owned by the authenticated user, so callers cannot
 * combine one user's capability with another user's actor membership. The
 * generated `rooms.normalized_label` has a partial btree index for exact and
 * prefix paths plus a partial trigram index for bounded token/typo discovery.
 */
export async function findAuthorizedRoomNameCandidates(
  input: FindAuthorizedRoomNameCandidatesInput,
): Promise<AuthorizedRoomNameCandidateRow[]> {
  const requesterUserId = input.requesterUserId.trim();
  const requesterActorId = input.requesterActorId.trim();
  const normalizedTargetRoomName = input.normalizedTargetRoomName.trim();
  if (!requesterUserId || !requesterActorId || !normalizedTargetRoomName) return [];

  // Keep the database work bounded even if an internal caller accidentally
  // passes a larger value. We ask for one extra candidate so ranking can
  // distinguish a unique exact match from an over-cap duplicate class.
  const limit = Math.min(
    Math.max(1, input.limit ?? MAX_AUTHORIZED_ROOM_NAME_QUERY_ROWS),
    MAX_AUTHORIZED_ROOM_NAME_QUERY_ROWS,
  );
  const db = getSharedDirectDb();
  const selection = {
      id: rooms.id,
      namespaceId: rooms.namespaceId,
      label: rooms.label,
      normalizedLabel: rooms.normalizedLabel,
      kind: rooms.kind,
      memberCount: sql<number>`(
        SELECT count(*)::int
        FROM ${roomMembers} AS candidate_members
        WHERE candidate_members.room_id = ${rooms.id}
      )`,
      // `room_members` is the membership authority. Include every current
      // participant identity (Human and Agent) deterministically: a same-size
      // member swap must invalidate a pending public projection just as a
      // count change does. The raw rows stay inside this trust query and are
      // immediately reduced to an opaque fingerprint below.
      audienceMembershipRows: sql<string>`(
        SELECT COALESCE(string_agg(
          audience_actors.kind || ':' || audience_actors.owner_id::text || ':' || audience_members.actor_id::text,
          E'\n' ORDER BY audience_actors.kind, audience_actors.owner_id, audience_members.actor_id
        ), '')
        FROM ${roomMembers} AS audience_members
        INNER JOIN ${actors} AS audience_actors
          ON audience_actors.id = audience_members.actor_id
        WHERE audience_members.room_id = ${rooms.id}
      )`,
  };
  const queryStage = async (
    match: SQL,
    ordering: readonly SQL[],
  ) => await db
      .select(selection)
      .from(rooms)
      .innerJoin(
        roomMembers,
        and(
          eq(roomMembers.roomId, rooms.id),
          eq(roomMembers.actorId, requesterActorId),
        ),
      )
      .innerJoin(
        actors,
        and(
          eq(actors.id, roomMembers.actorId),
          eq(actors.ownerId, requesterUserId),
          eq(actors.kind, "user"),
        ),
      )
      .where(
        and(
          isNull(rooms.archivedAt),
          // Keep these literals structurally identical to the partial-index
          // predicate. Parameterized NOT IN values cannot reliably prove the
          // predicate implication for a prepared/generic PostgreSQL plan.
          sql`${rooms.kind} NOT IN ('task', 'access', 'subthread')`,
          match,
        ),
      )
      .orderBy(...ordering)
      .limit(limit);

  // Exact matches dominate every weaker class, so do not make PostgreSQL
  // evaluate or sort prefix/fuzzy candidates when one exists.
  let rows = await queryStage(
    sql`${rooms.normalizedLabel} = ${normalizedTargetRoomName}`,
    [asc(rooms.id)],
  );
  if (rows.length === 0) {
    // text_pattern_ops on (normalized_label, id) makes even a one-character
    // prefix a bounded ordered index walk rather than a membership-table scan.
    rows = await queryStage(
      sql`${rooms.normalizedLabel} LIKE ${`${normalizedTargetRoomName}%`}`,
      [sql`${rooms.normalizedLabel} USING ~<~`, asc(rooms.id)],
    );
  }
  if (
    rows.length === 0
    && authorizedRoomNameLookupStages(normalizedTargetRoomName).includes("fuzzy")
  ) {
    // GiST pg_trgm supports KNN distance ordering. LIMIT therefore bounds the
    // nearest-neighbour traversal instead of sorting a large `%token%` result.
    rows = await queryStage(
      sql`${rooms.normalizedLabel} % ${normalizedTargetRoomName}`,
      [sql`${rooms.normalizedLabel} <-> ${normalizedTargetRoomName}`],
    );
  }

  return rows.map(({ audienceMembershipRows, ...row }) => ({
    ...row,
    // The generated expression is non-null for the non-null label column,
    // but Drizzle currently infers generated fields as nullable.
    normalizedLabel: row.normalizedLabel ?? "",
    kind: row.kind,
    memberCount: Number(row.memberCount),
    audienceFingerprint: fingerprintAuthorizedRoomAudience(row.id, audienceMembershipRows ?? ""),
  }));
}

/**
 * M044 — REL-HUM-NSP subset rule. Given the human-actor set
 * `H(currentRoom)`, returns every Room's `namespace_id` whose
 * `human_actor_ids` is a superset. For an M227 public source, candidates are
 * restricted to top-level open Rooms — equivalent to adding the virtual
 * `cosmos` member to both public effective audiences. Drives
 * `readableNamespaces`.
 *
 * Implementation note: Drizzle's expression builder doesn't have a
 * first-class `@>` (array contains) operator, so we reach for the
 * `sql` tag — same pattern memory-store.ts uses for pgvector `<=>`.
 * The GIN index on `rooms.human_actor_ids` (migration 0016) makes
 * this sub-millisecond for any realistic room population.
 *
 * Empty input returns `[]` — no sensible "readable rooms" set for an
 * empty human-set. The resolver never calls this with an empty set in
 * the happy path (member rooms always have at least the speaker as a
 * human).
 */
export async function findReadableNamespacesForSubset(
  humanActorIds: string[],
  sourcePolicy: NamespaceSubsetSourcePolicy = {
    isPublicNamespaceBoundary: false,
  },
): Promise<string[]> {
  if (humanActorIds.length === 0) return [];
  const db = getSharedDirectDb();
  // `human_actor_ids @> ARRAY[…]::uuid[]` — parameterized literal
  // list so the GIN index gets used. sql.join accepts our per-id
  // parameter nodes; the `::uuid[]` cast is load-bearing because
  // the driver's inference picks `text[]` otherwise and the index
  // is typed on `uuid[]`.
  const rows = await db
    .select({ namespaceId: rooms.namespaceId })
    .from(rooms)
    .where(namespaceSubsetPredicate(
      humanActorIds,
      sourcePolicy.isPublicNamespaceBoundary,
    ));
  return [...new Set(rows.map((r) => r.namespaceId))];
}

/**
 * M165 — resolve the Room + Namespace whose human-member set is EXACTLY the
 * given set (cardinality + element equality), i.e. the "shared namespace of
 * exactly these humans". This is the multi-user counterpart to
 * `findAgentOwnerPrivateRoom` (the single-user 1:1 case) and backs the Task
 * namespace-from-target-users rule: an `ask_peer` run whose target set is
 * `{requester, peer}` writes into the namespace of a room of precisely those
 * two humans (decoupled from the agent↔peer DM transcript room).
 *
 * `human_actor_ids` is stored sorted (`createRoomFromMembers` /
 * `updateRoomHumanActors` both `.sort()` before write), so the input is sorted
 * here to match the `=` array comparison. Empty input returns `null` (no
 * sensible "shared namespace of nobody"). When multiple rooms share the exact
 * set, public Namespace boundaries are excluded: an open audience contains
 * virtual `cosmos` and cannot satisfy a human-only exact audience. Of the
 * remaining matches, the oldest is returned for determinism (mirrors
 * `pickDefaultRoomFromPrivateMemberCandidates`'s created-at preference).
 */
export async function findRoomByExactHumanActorSet(
  humanActorIds: string[],
): Promise<{ roomId: string; namespaceId: string } | null> {
  if (humanActorIds.length === 0) return null;
  const sorted = [...new Set(humanActorIds)].sort();
  const db = getSharedDirectDb();
  const [row] = await db
    .select({ roomId: rooms.id, namespaceId: rooms.namespaceId })
    .from(rooms)
    .where(
      and(
        // Directed file-inbox containers carry sender provenance and cannot host unrelated grants or task output.
        notLike(rooms.graphThreadId, "workspace-share:%"),
        sql`${rooms.humanActorIds} = ARRAY[${sql.join(
          sorted.map((id) => sql`${id}`),
          sql`, `,
        )}]::uuid[]`,
        privateNamespaceBoundarySql(rooms.namespaceId),
      ),
    )
    .orderBy(asc(rooms.createdAt))
    .limit(1);
  return row ? { roomId: row.roomId, namespaceId: row.namespaceId } : null;
}

/**
 * M258 — strict Record projection lookup. Unlike the older generic helper,
 * this can reuse only a hidden immutable access Room and therefore cannot
 * silently turn a conversational Room into an authority container.
 */
export async function findRecordAccessRoomByExactHumanActorSet(
  humanActorIds: string[],
): Promise<{ roomId: string; namespaceId: string } | null> {
  if (humanActorIds.length === 0) return null;
  const sorted = [...new Set(humanActorIds)].sort();
  const db = getSharedDirectDb();
  const [row] = await db
    .select({ roomId: rooms.id, namespaceId: rooms.namespaceId })
    .from(rooms)
    .where(
      and(
        // Directed file-inbox containers carry sender provenance and cannot host unrelated grants or task output.
        notLike(rooms.graphThreadId, "workspace-share:%"),
        eq(rooms.kind, "access"),
        sql`${rooms.humanActorIds} = ARRAY[${sql.join(
          sorted.map((id) => sql`${id}`),
          sql`, `,
        )}]::uuid[]`,
        privateNamespaceBoundarySql(rooms.namespaceId),
      ),
    )
    .orderBy(asc(rooms.createdAt), asc(rooms.id))
    .limit(1);
  return row ? { roomId: row.roomId, namespaceId: row.namespaceId } : null;
}

/**
 * M173 — reverse of {@link getRoomWithAccess}: a Namespace (1:1 with a Room,
 * REL-NSP-RMS) → its Room. `rooms.namespace_id` is unique, so this is a single
 * indexed lookup. Returns `null` when no room backs the namespace.
 */
export async function findRoomByNamespaceId(
  namespaceId: string,
): Promise<{ roomId: string; label: string; humanActorIds: string[] } | null> {
  if (!namespaceId) return null;
  const db = getSharedDirectDb();
  const [row] = await db
    .select({
      roomId: rooms.id,
      label: rooms.label,
      humanActorIds: rooms.humanActorIds,
    })
    .from(rooms)
    .where(eq(rooms.namespaceId, namespaceId))
    .limit(1);
  if (!row) return null;
  return {
    roomId: row.roomId,
    label: row.label,
    humanActorIds: row.humanActorIds ?? [],
  };
}

/**
 * M173 — batch resolve actor ids → user display info, deduped by user id.
 * Filters to user-kind actors only (agent-kind actors are skipped — memory
 * access is answered about Humans, never Agents). Used to build a memory's
 * `accessList`. Order is not guaranteed.
 */
export async function resolveActorsDisplay(
  actorIds: string[],
): Promise<Array<{ userHandle: string; displayName: string }>> {
  if (actorIds.length === 0) return [];
  const db = getSharedDirectDb();
  const rows = await db
    .select({
      userId: actors.ownerId,
      handle: usersPublic.handle,
      name: usersPublic.name,
    })
    .from(actors)
    .innerJoin(usersPublic, eq(usersPublic.id, actors.ownerId))
    .where(and(inArray(actors.id, actorIds), eq(actors.kind, "user")));
  const seen = new Set<string>();
  const out: Array<{ userHandle: string; displayName: string }> = [];
  for (const r of rows) {
    if (seen.has(r.userId)) continue;
    seen.add(r.userId);
    out.push({ userHandle: r.handle ?? "", displayName: r.name ?? "" });
  }
  return out;
}

/**
 * M173/D328 — batched form of {@link findRoomByNamespaceId}: resolve many
 * Namespaces → their Rooms' human members in **one** query. Returns a Map keyed
 * by namespaceId; namespaces with no backing room are simply absent. Lets the
 * memory-list route compute per-row `accessList` without an N+1 fan-out (the
 * single-namespace helper opens a connection per call).
 */
export async function findRoomsByNamespaceIds(
  namespaceIds: string[],
): Promise<Map<string, { humanActorIds: string[] }>> {
  const out = new Map<string, { humanActorIds: string[] }>();
  if (namespaceIds.length === 0) return out;
  const db = getSharedDirectDb();
  const rows = await db
    .select({
      namespaceId: rooms.namespaceId,
      humanActorIds: rooms.humanActorIds,
    })
    .from(rooms)
    .where(inArray(rooms.namespaceId, namespaceIds));
  for (const r of rows) {
    if (!r.namespaceId) continue;
    out.set(r.namespaceId, { humanActorIds: r.humanActorIds ?? [] });
  }
  return out;
}

/**
 * M173/D328 — like {@link resolveActorsDisplay} but **keyed by actorId** so a
 * caller can map specific actors back to people (the deduped-array form drops
 * that association). User-kind actors only (memory access is about Humans).
 * Used to build per-row `accessList` for the memory list.
 */
export async function resolveActorsDisplayMap(
  actorIds: string[],
): Promise<Map<string, { userHandle: string; displayName: string }>> {
  const out = new Map<string, { userHandle: string; displayName: string }>();
  if (actorIds.length === 0) return out;
  const db = getSharedDirectDb();
  const rows = await db
    .select({
      actorId: actors.id,
      handle: usersPublic.handle,
      name: usersPublic.name,
    })
    .from(actors)
    .innerJoin(usersPublic, eq(usersPublic.id, actors.ownerId))
    .where(and(inArray(actors.id, actorIds), eq(actors.kind, "user")));
  for (const r of rows) {
    out.set(r.actorId, { userHandle: r.handle ?? "", displayName: r.name ?? "" });
  }
  return out;
}

/**
 * M044 — recompute `rooms.human_actor_ids` for a single room from the
 * authoritative `room_members JOIN actors WHERE kind='user'` source.
 * Call this after any room-membership mutation (future M040
 * `classify_actor` / multi-room expansion sites) to keep the
 * denormalized column in sync with `room_members`.
 *
 * `seedDefaultRoom` calls a local copy of this logic directly during
 * the idempotent re-boot reconcile; this exported version is for
 * application-layer callers outside the bootstrap path.
 */
export async function updateRoomHumanActors(roomId: string): Promise<void> {
  if (!roomId) return;
  const db = getSharedDirectDb();
  const memberRows = await db
    .select({ actorId: roomMembers.actorId, kind: actors.kind })
    .from(roomMembers)
    .innerJoin(actors, eq(actors.id, roomMembers.actorId))
    .where(eq(roomMembers.roomId, roomId));
  const humans = memberRows
    .filter((r) => r.kind === "user")
    .map((r) => r.actorId)
    .sort();
  await db
    .update(rooms)
    .set({ humanActorIds: humans })
    .where(eq(rooms.id, roomId));
}

/** Same as {@link updateRoomHumanActors} but uses caller's transaction. */
export async function updateRoomHumanActorsInTx(
  tx: InviteSeedTx,
  roomId: string,
): Promise<void> {
  if (!roomId) return;
  const memberRows = await tx
    .select({ actorId: roomMembers.actorId, kind: actors.kind })
    .from(roomMembers)
    .innerJoin(actors, eq(actors.id, roomMembers.actorId))
    .where(eq(roomMembers.roomId, roomId));
  const humans = memberRows
    .filter((r) => r.kind === "user")
    .map((r) => r.actorId)
    .sort();
  await tx
    .update(rooms)
    .set({ humanActorIds: humans })
    .where(eq(rooms.id, roomId));
}

// ---------------------------------------------------------------------------
// Group membership queries (M043 — keyed on users.id)
// ---------------------------------------------------------------------------
//
// Pre-M043 these functions were `getActor*` / `findActors*` and joined
// through `actors (kind='user')` with an implicit runtime kind filter.
// M043 makes the FK target `users.id` directly; the "actor" axis goes
// away for Subject queries (it stays on room_members, which is
// polymorphic by design).

// M044: `namespaceId` dropped — Groups no longer carry a Namespace
// (REL-GRP-NSP). A membership row now describes (group, roles[]);
// Namespace access is settled by Room membership independently.
// M131: a Group carries one or more Roles via `group_roles`, so the
// per-group shape is `roleSlugs: string[]` (the union of that Group's
// Roles), not a single `roleSlug`.
export type MembershipRow = {
  groupId: string;
  groupType: string;
  groupLabel: string;
  roleSlugs: string[];
};

/**
 * M131: every Group a user belongs to, with the set of Role slugs each
 * Group carries via the `group_roles` junction. One row per Group; a
 * Group with multiple Roles lists them all in `roleSlugs`. For the
 * canonical 1:1-seeded install each `roleSlugs` has exactly one entry.
 */
export async function getUserMemberships(
  userId: string,
): Promise<MembershipRow[]> {
  const db = getSharedDirectDb();
  const rows = await db
    .select({
      groupId: groups.id,
      groupType: groups.type,
      groupLabel: groups.label,
      roleSlug: roles.slug,
    })
    .from(groupMembers)
    .innerJoin(groups, eq(groupMembers.groupId, groups.id))
    .innerJoin(groupRoles, eq(groupRoles.groupId, groups.id))
    .innerJoin(roles, eq(groupRoles.roleId, roles.id))
    .where(eq(groupMembers.userId, userId));

  // Collapse the (group × role) rows into one MembershipRow per Group
  // with a de-duped roleSlugs[]. Preserves group order of first sight.
  const byGroup = new Map<string, MembershipRow>();
  for (const r of rows) {
    const existing = byGroup.get(r.groupId);
    if (existing) {
      if (!existing.roleSlugs.includes(r.roleSlug)) {
        existing.roleSlugs.push(r.roleSlug);
      }
    } else {
      byGroup.set(r.groupId, {
        groupId: r.groupId,
        groupType: r.groupType,
        groupLabel: r.groupLabel,
        roleSlugs: [r.roleSlug],
      });
    }
  }
  return [...byGroup.values()];
}

// ---------------------------------------------------------------------------
// Capability queries
// ---------------------------------------------------------------------------

/**
 * M131: union of capabilities across every Role of every Group the
 * user belongs to. The Role hop now goes through the `group_roles`
 * junction (a Group may carry more than one Role); the de-duped union
 * result is unchanged for the canonical 1:1-seeded install.
 */
export async function getUserCapabilities(
  userId: string,
): Promise<string[]> {
  const db = getSharedDirectDb();
  const rows = await db
    .select({ slug: capabilities.slug })
    .from(groupMembers)
    .innerJoin(groups, eq(groupMembers.groupId, groups.id))
    .innerJoin(groupRoles, eq(groupRoles.groupId, groups.id))
    .innerJoin(roles, eq(groupRoles.roleId, roles.id))
    .innerJoin(roleCapabilities, eq(roles.id, roleCapabilities.roleId))
    .innerJoin(
      capabilities,
      eq(roleCapabilities.capabilityId, capabilities.id),
    )
    .where(eq(groupMembers.userId, userId));

  return [...new Set(rows.map((r) => r.slug))];
}

/**
 * M128 — every `users.id` holding the given Capability via any Group
 * they belong to. Post-M128 the `prove_it` approver pool resolves to
 * `findUsersWithCapability("approve_destructive_actions")` (per
 * `permission-model.md` §4 invariant). Returns `[]` when no Human is
 * seated in a Group whose Role bundles the cap.
 */
export async function findUsersWithCapability(
  capabilitySlug: string,
): Promise<string[]> {
  const db = getSharedDirectDb();
  const rows = await db
    .selectDistinct({ userId: groupMembers.userId })
    .from(groupMembers)
    .innerJoin(groups, eq(groupMembers.groupId, groups.id))
    .innerJoin(groupRoles, eq(groupRoles.groupId, groups.id))
    .innerJoin(roles, eq(groupRoles.roleId, roles.id))
    .innerJoin(roleCapabilities, eq(roles.id, roleCapabilities.roleId))
    .innerJoin(
      capabilities,
      eq(roleCapabilities.capabilityId, capabilities.id),
    )
    .where(eq(capabilities.slug, capabilitySlug));
  return rows.map((r) => r.userId);
}

// ---------------------------------------------------------------------------
// Room queries (M042B)
// ---------------------------------------------------------------------------

/** Seeded default room keeps this LangGraph thread id (pre-M042B saver). */
const LEGACY_GRAPH_THREAD_ID = "app:default";

/**
 * M065 — deterministic pick when several private rooms share the same
 * human+agent member pair. Pure function so unit tests pin ordering
 * without Postgres (Risk Note #1).
 */
export type PrivateRoomMemberCandidate = {
  id: string;
  type: string;
  graphThreadId: string;
  createdAt: Date | null;
};

export function pickDefaultRoomFromPrivateMemberCandidates(
  valid: PrivateRoomMemberCandidate[],
): { id: string; type: string; graphThreadId: string } | null {
  if (valid.length === 0) return null;
  const legacy = valid.find((r) => r.graphThreadId === LEGACY_GRAPH_THREAD_ID);
  if (legacy) {
    return {
      id: legacy.id,
      type: legacy.type,
      graphThreadId: legacy.graphThreadId,
    };
  }
  const sorted = [...valid].sort((a, b) => {
    const ta = a.createdAt?.getTime() ?? 0;
    const tb = b.createdAt?.getTime() ?? 0;
    if (ta !== tb) return ta - tb;
    return a.id.localeCompare(b.id);
  });
  const pick = sorted[0]!;
  return {
    id: pick.id,
    type: pick.type,
    graphThreadId: pick.graphThreadId,
  };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidString(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * M042B: resolves the default private room for a given (actor, agent)
 * pair. M065: when multiple private rooms share the same two members
 * (owner + default agent), pick deterministically — prefer the legacy
 * `app:default` graph thread if present, else oldest `created_at`, then
 * `id` ascending.
 *
 * Returns the room's id, type, and opaque `graphThreadId` (the
 * LangGraph saver key). `graphThreadId` MUST be the string passed to
 * `configurable.thread_id`; it is NOT the laneKey.
 */
export async function findDefaultRoomForActor(
  actorId: string,
  agentId: string,
): Promise<{ id: string; type: string; graphThreadId: string } | null> {
  const db = getSharedDirectDb();
  const [agentActor] = await db
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.agentId, agentId), eq(actors.kind, "agent")))
    .limit(1);
  if (!agentActor) return null;

  const agentMemberRoomIds = db
    .select({ roomId: roomMembers.roomId })
    .from(roomMembers)
    .where(eq(roomMembers.actorId, agentActor.id));

  const candidates = await db
    .select({
      id: rooms.id,
      type: rooms.type,
      graphThreadId: rooms.graphThreadId,
      createdAt: rooms.createdAt,
    })
    .from(rooms)
    .innerJoin(
      roomMembers,
      and(
        eq(roomMembers.roomId, rooms.id),
        eq(roomMembers.actorId, actorId),
      ),
    )
    .where(
      and(eq(rooms.type, "private"), inArray(rooms.id, agentMemberRoomIds)),
    );

  return pickDefaultRoomFromPrivateMemberCandidates(candidates);
}

/**
 * M065 — resolve `rooms.id` from LangGraph `thread_id` for the deployment
 * owner (single-owner invariant). Used by identity-resume so the envelope
 * matches the checkpoint thread.
 */
export async function findRoomIdByGraphThreadIdForOwner(
  ownerUserId: string,
  graphThreadId: string,
): Promise<string | null> {
  if (!ownerUserId || !graphThreadId) return null;
  const db = getSharedDirectDb();
  const [row] = await db
    .select({ id: rooms.id })
    .from(rooms)
    .where(
      and(
        eq(rooms.ownerId, ownerUserId),
        eq(rooms.graphThreadId, graphThreadId),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * M075 — resolve a LangGraph `thread_id` to a room the given **user** is a
 * member of (via their user-kind actor in `room_members`). Unlike
 * {@link findRoomIdByGraphThreadIdForOwner}, this is the trust boundary for
 * resume routes: `graph_thread_id` may match a room the user participates in
 * even when they are not `rooms.owner_id` (household rooms).
 */
export async function findRoomIdByGraphThreadIdForUser(
  sessionUserId: string,
  graphThreadId: string,
): Promise<string | null> {
  if (!sessionUserId || !graphThreadId) return null;
  const userActor = await findActorByOwnerId(sessionUserId);
  if (!userActor) return null;
  const db = getSharedDirectDb();
  const [row] = await db
    .select({ id: rooms.id })
    .from(rooms)
    .innerJoin(
      roomMembers,
      and(eq(roomMembers.roomId, rooms.id), eq(roomMembers.actorId, userActor.id)),
    )
    .where(eq(rooms.graphThreadId, graphThreadId))
    .limit(1);
  return row?.id ?? null;
}

/**
 * M065 — when the caller requests a specific room, verify both the human
 * actor and the running agent's mirror actor are members; return the room
 * row shape the resolver needs, or null.
 */
export async function findRoomForUserAndAgentMembers(
  roomId: string,
  userActorId: string,
  agentId: string,
): Promise<{ id: string; type: string; graphThreadId: string } | null> {
  if (!isUuidString(roomId) || !userActorId || !agentId) return null;
  const db = getSharedDirectDb();
  const [agentActor] = await db
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.agentId, agentId), eq(actors.kind, "agent")))
    .limit(1);
  if (!agentActor) return null;

  const agentMemberRoomIds = db
    .select({ roomId: roomMembers.roomId })
    .from(roomMembers)
    .where(
      and(
        eq(roomMembers.roomId, roomId),
        eq(roomMembers.actorId, agentActor.id),
      ),
    );

  const [row] = await db
    .select({
      id: rooms.id,
      type: rooms.type,
      graphThreadId: rooms.graphThreadId,
    })
    .from(rooms)
    .innerJoin(
      roomMembers,
      and(
        eq(roomMembers.roomId, rooms.id),
        eq(roomMembers.actorId, userActorId),
      ),
    )
    .where(and(eq(rooms.id, roomId), inArray(rooms.id, agentMemberRoomIds)))
    .limit(1);
  return row ?? null;
}

/**
 * M227 — Human-facing content surfaces scope by the Human's Room membership,
 * independent of which Agent mirror is present. Agent-turn admission continues
 * to use {@link findRoomForUserAndAgentMembers}.
 */
export async function findRoomForUserMember(
  roomId: string,
  userActorId: string,
): Promise<{ id: string; type: string; graphThreadId: string } | null> {
  if (!isUuidString(roomId) || !userActorId) return null;
  const db = getSharedDirectDb();
  const [row] = await db
    .select({
      id: rooms.id,
      type: rooms.type,
      graphThreadId: rooms.graphThreadId,
    })
    .from(rooms)
    .innerJoin(
      roomMembers,
      and(
        eq(roomMembers.roomId, rooms.id),
        eq(roomMembers.actorId, userActorId),
      ),
    )
    .where(eq(rooms.id, roomId))
    .limit(1);
  return row ?? null;
}

export type RoomSummaryRow = {
  id: string;
  label: string;
  type: string;
  graphThreadId: string;
  createdAt: string;
  memberCount: number;
  messageCount: number;
  lastMessageAt: string | null;
  /** M122 — count of display-eligible messages in this room not authored by the
   *  viewer and not yet read by the viewer. 0 for agent-actor callers (agents
   *  don't have unread) and for producers that don't compute it (manage/discover). */
  unreadCount: number;
  /** D111 + M124 ('open') + M141 ('task') + M173 ('access'). Conversational
   *  surfaces exclude 'task'/'access', but the column type admits them. */
  kind: "private" | "group" | "multi_agent" | "subthread" | "open" | "task" | "access";
  parentRoomId: string | null;
  threadRootMessageId: number | null;
  /**
   * D246 Wave 2 — compact roster projection folded from one batch query keyed
   * by `roomId`. Populated by `listRoomsForActor` and the bounded manageable
   * Room catalogue; discoverable producers omit it. Absent → explorer
   * heuristics still work.
   */
  roster?: RoomSummaryRosterMember[];
};

/**
 * D246 Wave 2 — minimal roster member shape folded into `RoomSummaryRow`.
 * Mirrors {@link RoomSummaryRosterMemberDto} (the wire shape): only the
 * grouping/display fields the explorer consumes. No `roomRole`,
 * `agentResponseMode` or owner cues — those arrive with the
 * authoritative active-room detail fetch.
 */
export type RoomSummaryRosterMember = {
  actorId: string;
  kind: "user" | "agent";
  displayName: string;
  handle?: string | null;
  federatedId?: string;
  userId?: string;
  agentId?: string;
  agentAvatar?: AvatarRef | null;
};

function isoFromDbTimestamp(value: Date | string | null | undefined): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}

/**
 * M122 — resolve the human `users.id` for an actor, or `null` when the actor is
 * an agent (agents have no per-viewer unread semantics) or does not resolve.
 */
export async function resolveViewerUserIdForActor(
  actorId: string,
): Promise<string | null> {
  if (!actorId) return null;
  const actor = await findActorById(actorId);
  if (!actor || actor.kind !== "user") return null;
  return actor.ownerId;
}

/**
 * @deprecated M236 compatibility wrapper. Uses the authoritative set-based
 * changed-family service and performs exactly one DB query for all recipients.
 */
export async function getRoomUnreadCountsForRecipients(
  roomId: string,
  recipientUserIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!roomId || recipientUserIds.length === 0) return out;
  const changes = await getChangedNotificationState(roomId, recipientUserIds);
  for (const change of changes) {
    out.set(change.userId, change.roomOwnUnreadCount);
  }
  return out;
}

/**
 * M122 — human `users.id`s that are members of a room (distinct). Used to derive
 * the recipient set ("all humans minus sender") for message-arrival deltas.
 */
export async function listHumanUserIdsInRoom(roomId: string): Promise<string[]> {
  if (!roomId) return [];
  const db = getSharedDirectDb();
  const rows = await db
    .selectDistinct({ userId: actors.ownerId })
    .from(roomMembers)
    .innerJoin(actors, eq(roomMembers.actorId, actors.id))
    .where(and(eq(roomMembers.roomId, roomId), eq(actors.kind, "user")));
  return rows.map((r) => r.userId).filter((u): u is string => typeof u === "string" && u.length > 0);
}

/** Options for {@link listRoomsForActor}. Default preserves explorer/API behavior. */
export type ListRoomsForActorOptions = {
  /**
   * When `true` (default), fold compact roster rows for every visible room.
   * Internal callers that only need room IDs (WS subscription refresh, WS
   * connect scope) should pass `false` to skip `queryRoomSummaryRosters`.
   */
  includeRoster?: boolean;
  /**
   * Internal realtime callers need every conversational membership, including
   * child Subthreads. User-facing Room lists must leave this false so a child
   * can only surface through its parent message/thread UI.
   */
  includeSubthreads?: boolean;
};

/**
 * M065 — rooms the actor is a member of, newest first.
 */
export async function listRoomsForActor(
  actorId: string,
  options: ListRoomsForActorOptions = {},
): Promise<RoomSummaryRow[]> {
  const includeRoster = options.includeRoster !== false;
  const includeSubthreads = options.includeSubthreads === true;
  if (!actorId) return [];
  const db = getSharedDirectDb();
  const rows = await db
    .select({
      id: rooms.id,
      label: rooms.label,
      type: rooms.type,
      graphThreadId: rooms.graphThreadId,
      createdAt: rooms.createdAt,
      kind: rooms.kind,
      parentRoomId: rooms.parentRoomId,
      threadRootMessageId: rooms.threadRootMessageId,
    })
    .from(rooms)
    .innerJoin(
      roomMembers,
      and(eq(roomMembers.roomId, rooms.id), eq(roomMembers.actorId, actorId)),
    )
    // M157/M173/D426 — task/access containers and Subthread children are not
    // top-level navigation rows. Realtime auth/refresh explicitly opts into
    // Subthreads while continuing to exclude non-conversational containers.
    .where(
      and(
        isNull(rooms.archivedAt),
        notInArray(
          rooms.kind,
          includeSubthreads ? ["task", "access"] : ["task", "access", "subthread"],
        ),
      ),
    )
    .orderBy(desc(rooms.createdAt));

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const countRows = await db
    .select({ roomId: roomMembers.roomId, n: count() })
    .from(roomMembers)
    .where(inArray(roomMembers.roomId, ids))
    .groupBy(roomMembers.roomId);
  const countMap = new Map(
    countRows.map((c) => [c.roomId, Number(c.n)] as const),
  );

  const messageActivityRows = await db
    .select({
      roomId: sessions.roomId,
      messageCount: sql<number>`count(${sessionMessages.id})`,
      lastMessageAt: sql<Date | null>`max(${sessionMessages.createdAt})`,
    })
    .from(sessions)
    .innerJoin(sessionMessages, eq(sessionMessages.sessionId, sessions.id))
    .where(inArray(sessions.roomId, ids))
    .groupBy(sessions.roomId);
  const messageActivityMap = new Map(
    messageActivityRows
      .filter((r) => typeof r.roomId === "string")
      .map((r) => [
        r.roomId as string,
        {
          messageCount: Number(r.messageCount),
          lastMessageAt: isoFromDbTimestamp(r.lastMessageAt as Date | string | null),
        },
      ] as const),
  );

  // M122 — third batch: per-room unread for this viewer. Agent-actor callers
  // short-circuit (no unread semantics) → empty map → all rooms default 0.
  const viewerUserId = await resolveViewerUserIdForActor(actorId);
  const unreadMap = new Map<string, number>();
  if (viewerUserId) {
    const ownCounts = await getLegacyOwnRoomUnreadCounts(viewerUserId, db);
    for (const [roomId, unreadCount] of ownCounts) {
      unreadMap.set(roomId, unreadCount);
    }
  }

  // D246 Wave 2 — fourth batch: compact roster projection for every visible
  // room, folded from ONE query keyed by `roomId` (joined to actors + users +
  // agents for display/handle/identity). Grouped in-memory into a
  // Map<roomId, RoomSummaryRosterMember[]> so the explorer classifies every
  // row without a per-room `GET /api/rooms/:id` fan-out. Deliberately skips
  // `room_members.room_role`, `agent_response_mode`, the agent-owner users
  // join. The profile join carries only the avatar reference so relationship
  // surfaces can distinguish a custom avatar from the generic shell without
  // introducing per-room detail requests.
  const rosterMap = includeRoster
    ? await queryRoomSummaryRosters(db, ids)
    : null;

  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    type: r.type,
    graphThreadId: r.graphThreadId,
    createdAt: (r.createdAt ?? new Date()).toISOString(),
    memberCount: countMap.get(r.id) ?? 0,
    messageCount: messageActivityMap.get(r.id)?.messageCount ?? 0,
    lastMessageAt: messageActivityMap.get(r.id)?.lastMessageAt ?? null,
    unreadCount: unreadMap.get(r.id) ?? 0,
    kind: r.kind,
    parentRoomId: r.parentRoomId ?? null,
    threadRootMessageId: r.threadRootMessageId ?? null,
    ...(includeRoster ? { roster: rosterMap?.get(r.id) ?? [] } : {}),
  }));
}

/**
 * D246 Wave 2 — fold compact roster rows for every `roomIds` member in ONE
 * query. Returns Map<roomId, RoomSummaryRosterMember[]>; rooms with zero
 * members map to an empty array (caller-friendly — the explorer treats
 * absent and empty identically). The query count is constant w.r.t. room
 * count (exactly one SELECT), so the explorer's startup traffic no longer
 * scales O(rooms).
 *
 * Visibility is already enforced by the caller (`listRoomsForActor` only
 * passes rooms the actor is a member of); this query does NOT re-check
 * membership or archived/kind filters — it returns the roster for whatever
 * room IDs it is handed.
 */
async function queryRoomSummaryRosters(
  db: Database,
  roomIds: string[],
): Promise<Map<string, RoomSummaryRosterMember[]>> {
  const out = new Map<string, RoomSummaryRosterMember[]>();
  if (roomIds.length === 0) return out;
  const rows = await db
    .select({
      roomId: roomMembers.roomId,
      actorId: actors.id,
      kind: actors.kind,
      displayName: actors.displayName,
      agentId: actors.agentId,
      ownerId: actors.ownerId,
      userHandle: users.handle,
      userServer: users.server,
      agentHandle: agents.handle,
      agentAvatar: profiles.avatarRef,
    })
    .from(roomMembers)
    .innerJoin(actors, eq(roomMembers.actorId, actors.id))
    .leftJoin(users, eq(actors.ownerId, users.id))
    .leftJoin(agents, eq(actors.agentId, agents.id))
    .leftJoin(profiles, eq(profiles.agentId, actors.agentId))
    .where(inArray(roomMembers.roomId, roomIds))
    .orderBy(asc(roomMembers.roomId), asc(actors.id));

  const localServer = getServerHostname();
  for (const r of rows) {
    const kind: "user" | "agent" = r.kind === "agent" ? "agent" : "user";
    const roomId = r.roomId;
    const handle = kind === "agent" ? r.agentHandle ?? null : r.userHandle ?? null;
    const member: RoomSummaryRosterMember = {
      actorId: r.actorId,
      kind,
      displayName: r.displayName,
      handle,
    };
    if (handle) {
      member.federatedId = composeFederatedId(
        handle,
        kind === "user" ? r.userServer ?? localServer : localServer,
      );
    }
    if (kind === "agent" && r.agentId) member.agentId = r.agentId;
    if (kind === "agent") member.agentAvatar = r.agentAvatar ?? null;
    if (kind === "user" && r.ownerId) member.userId = r.ownerId;
    const list = out.get(roomId);
    if (list) list.push(member);
    else out.set(roomId, [member]);
  }
  return out;
}

/**
 * M068 — rooms the user may manage members on (`/manage-rooms` picker): all rooms
 * for server admins; owned rooms (`rooms.owner_id`) for non-admins.
 */
export async function listManageableRoomsForUser(
  userId: string,
  opts: { isAdmin: boolean; includeArchived?: boolean },
): Promise<RoomSummaryRow[]> {
  if (!userId) return [];
  const db = getSharedDirectDb();
  const cols = {
    id: rooms.id,
    label: rooms.label,
    type: rooms.type,
    graphThreadId: rooms.graphThreadId,
    createdAt: rooms.createdAt,
    kind: rooms.kind,
    parentRoomId: rooms.parentRoomId,
    threadRootMessageId: rooms.threadRootMessageId,
  };
  // M157 — `task` (internal transcript holders) and `subthread` (nested,
  // not independently manageable — REL-RMS-RMS) must never appear in the
  // /manage-rooms picker. M173 — `access` (non-conversational memory-access
  // containers) likewise must never appear (§5.7).
  const kindFilter = notInArray(rooms.kind, ["task", "subthread", "access"]);
  const archivedFilter = opts.includeArchived ? undefined : isNull(rooms.archivedAt);
  const ownerFilter = opts.isAdmin
    ? undefined
    : sql`(
        ${rooms.ownerId} = ${userId}
        OR EXISTS (
          SELECT 1
          FROM ${roomMembers} rm_manage
          INNER JOIN ${actors} a_manage ON a_manage.id = rm_manage.actor_id
          WHERE rm_manage.room_id = ${rooms.id}
            AND rm_manage.room_role = 'admin'
            AND a_manage.kind = 'user'
            AND a_manage.owner_id = ${userId}
        )
      )`;

  // Compose only the defined clauses (drizzle `and(...)` tolerates undefined).
  const where = and(kindFilter, archivedFilter, ownerFilter);

  const rows = await db
    .select(cols)
    .from(rooms)
    .where(where)
    .orderBy(desc(rooms.createdAt));

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const countRows = await db
    .select({ roomId: roomMembers.roomId, n: count() })
    .from(roomMembers)
    .where(inArray(roomMembers.roomId, ids))
    .groupBy(roomMembers.roomId);
  const countMap = new Map(
    countRows.map((c) => [c.roomId, Number(c.n)] as const),
  );
  // D529 — management surfaces also need an identity-safe membership cue for
  // archived rows. This remains one bounded query keyed by the selected room
  // ids; it does not expand into a per-room detail fan-out.
  const rosterMap = await queryRoomSummaryRosters(db, ids);

  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    type: r.type,
    graphThreadId: r.graphThreadId,
    createdAt: (r.createdAt ?? new Date()).toISOString(),
    memberCount: countMap.get(r.id) ?? 0,
    messageCount: 0,
    lastMessageAt: null,
    unreadCount: 0,
    kind: r.kind,
    parentRoomId: r.parentRoomId ?? null,
    threadRootMessageId: r.threadRootMessageId ?? null,
    roster: rosterMap.get(r.id) ?? [],
  }));
}

function rosterToDto(participants: RoomParticipant[]): Array<{
  actorId: string;
  kind: "user" | "agent";
  displayName: string;
  handle?: string | null;
  userId?: string;
  agentId?: string;
  roomRole: "admin" | "member";
  agentResponseMode?: AgentResponseMode | null;
  agentOwnerUserId?: string;
  agentOwnerHandle?: string | null;
  agentOwnerDisplayName?: string | null;
  agentAvatar?: AvatarRef | null;
}> {
  return participants.map((p) => {
    const m: {
      actorId: string;
      kind: "user" | "agent";
      displayName: string;
      handle?: string | null;
      userId?: string;
      agentId?: string;
      roomRole: "admin" | "member";
      agentResponseMode?: AgentResponseMode | null;
      agentOwnerUserId?: string;
      agentOwnerHandle?: string | null;
      agentOwnerDisplayName?: string | null;
      agentAvatar?: AvatarRef | null;
    } = {
      actorId: p.actorId,
      kind: p.kind,
      displayName: p.displayName,
      roomRole: p.roomRole,
    };
    if (p.handle) m.handle = p.handle;
    if (p.agentId) m.agentId = p.agentId;
    if (p.kind === "user" && p.userId) m.userId = p.userId;
    if (p.kind === "agent" && p.agentResponseMode != null) {
      m.agentResponseMode = p.agentResponseMode;
    }
    if (p.kind === "agent" && p.agentOwnerUserId) {
      m.agentOwnerUserId = p.agentOwnerUserId;
      if (p.agentOwnerHandle) m.agentOwnerHandle = p.agentOwnerHandle;
      if (p.agentOwnerDisplayName) m.agentOwnerDisplayName = p.agentOwnerDisplayName;
    }
    if (p.kind === "agent" && p.agentAvatar !== undefined) {
      m.agentAvatar = p.agentAvatar;
    }
    return m;
  });
}

export type RoomDetailPayload = {
  id: string;
  namespaceId?: string | null;
  label: string;
  type: string;
  graphThreadId: string;
  createdAt: string;
  /** D111 + M124 ('open') + M141 ('task') + M173 ('access') */
  kind: "private" | "group" | "multi_agent" | "subthread" | "open" | "task" | "access";
  parentRoomId: string | null;
  threadRootMessageId: number | null;
  /** D302 — `advanced` (FM default-arbiter inference) | `standard` (today's conductor). */
  conductorMode: "advanced" | "standard";
  members: Array<{
    actorId: string;
    kind: "user" | "agent";
    displayName: string;
    handle?: string | null;
    userId?: string;
    agentId?: string;
    roomRole: "admin" | "member";
    agentResponseMode?: AgentResponseMode | null;
    agentOwnerUserId?: string;
    agentOwnerHandle?: string | null;
    agentOwnerDisplayName?: string | null;
    agentAvatar?: AvatarRef | null;
  }>;
};

/**
 * M065 — room detail if `requesterActorId` is a member; otherwise null
 * (caller maps to HTTP 404).
 */
export async function getRoomDetailForMember(
  roomId: string,
  requesterActorId: string,
): Promise<RoomDetailPayload | null> {
  if (!roomId || !requesterActorId) return null;
  const db = getSharedDirectDb();
  const [membership] = await db
    .select({ roomId: roomMembers.roomId })
    .from(roomMembers)
    .where(
      and(
        eq(roomMembers.roomId, roomId),
        eq(roomMembers.actorId, requesterActorId),
      ),
    )
    .limit(1);
  if (!membership) return null;

  const [room] = await db
    .select({
      id: rooms.id,
      namespaceId: rooms.namespaceId,
      label: rooms.label,
      type: rooms.type,
      graphThreadId: rooms.graphThreadId,
      createdAt: rooms.createdAt,
      kind: rooms.kind,
      parentRoomId: rooms.parentRoomId,
      threadRootMessageId: rooms.threadRootMessageId,
      conductorMode: rooms.conductorMode,
    })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);
  if (!room) return null;

  const roster = await loadRoomRoster(roomId);
  return {
    id: room.id,
    namespaceId: room.namespaceId,
    label: room.label,
    type: room.type,
    graphThreadId: room.graphThreadId,
    createdAt: (room.createdAt ?? new Date()).toISOString(),
    kind: room.kind,
    parentRoomId: room.parentRoomId ?? null,
    threadRootMessageId: room.threadRootMessageId ?? null,
    conductorMode: room.conductorMode === "standard" ? "standard" : "advanced",
    members: rosterToDto(roster),
  };
}

/**
 * M068 — full room roster for the members-management UI when the caller is
 * a server admin (any room) or the room owner (`rooms.owner_id`).
 */
export async function getRoomDetailForManager(
  roomId: string,
  managerUserId: string,
  opts: { isAdmin: boolean },
): Promise<RoomDetailPayload | null> {
  if (!roomId || !managerUserId) return null;
  const db = getSharedDirectDb();
  const [room] = await db
    .select({
      id: rooms.id,
      ownerId: rooms.ownerId,
      label: rooms.label,
      type: rooms.type,
      graphThreadId: rooms.graphThreadId,
      createdAt: rooms.createdAt,
      kind: rooms.kind,
      parentRoomId: rooms.parentRoomId,
      threadRootMessageId: rooms.threadRootMessageId,
      conductorMode: rooms.conductorMode,
    })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);
  if (!room) return null;
  if (!opts.isAdmin && room.ownerId !== managerUserId) {
    const [membership] = await db
      .select({ roomRole: roomMembers.roomRole })
      .from(roomMembers)
      .innerJoin(actors, eq(roomMembers.actorId, actors.id))
      .where(
        and(
          eq(roomMembers.roomId, roomId),
          eq(roomMembers.roomRole, "admin"),
          eq(actors.kind, "user"),
          eq(actors.ownerId, managerUserId),
        ),
      )
      .limit(1);
    if (!membership) return null;
  }

  const roster = await loadRoomRoster(roomId);
  return {
    id: room.id,
    label: room.label,
    type: room.type,
    graphThreadId: room.graphThreadId,
    createdAt: (room.createdAt ?? new Date()).toISOString(),
    kind: room.kind,
    parentRoomId: room.parentRoomId ?? null,
    threadRootMessageId: room.threadRootMessageId ?? null,
    conductorMode: room.conductorMode === "standard" ? "standard" : "advanced",
    members: rosterToDto(roster),
  };
}

/**
 * M065 — `graph_thread_id` for sessions/latest when `?roomId=` is set.
 * Validates dual membership (owner user-actor + default agent actor).
 */
/**
 * @deprecated M125 Phase 2.5 — use `getRoomGraphThreadForViewer`.
 *
 * Pre-M125 this resolver took a caller-supplied `defaultAgentId` —
 * routes (notably `routes/sessions.ts`) passed
 * `getBootstrapDefaultAgentId()`, which scoped the membership join to
 * the OPERATOR's agent. Non-operator users fetching their own room's
 * history got a clean `null` → `404` because the join didn't find the
 * operator's agent in their room. `getRoomGraphThreadForViewer` resolves
 * the agent member from the room itself.
 */
export async function getRoomGraphThreadForOwnerSession(
  roomId: string,
  sessionUserId: string,
  defaultAgentId: string,
): Promise<string | null> {
  if (!isUuidString(roomId) || !sessionUserId || !defaultAgentId) {
    return null;
  }
  const userActor = await findActorByOwnerId(sessionUserId);
  if (!userActor) return null;
  return (
    (
      await findRoomForUserAndAgentMembers(
        roomId,
        userActor.id,
        defaultAgentId,
      )
    )?.graphThreadId ?? null
  );
}

/**
 * M125 Phase 2.5 — resolver that scopes membership on the room's OWN
 * agent member instead of a caller-supplied `defaultAgentId`. The room
 * already knows which agent it contains; ask the room.
 *
 * Returns the room's `graphThreadId` when the viewer has a user-actor
 * row that's a member of the room AND the room has at least one
 * `kind = 'agent'` member. Returns `null` otherwise (matches the
 * legacy behavior for `routes/sessions.ts` 404 mapping).
 */
export async function getRoomGraphThreadForViewer(
  roomId: string,
  sessionUserId: string,
): Promise<string | null> {
  if (!isUuidString(roomId) || !sessionUserId) return null;
  const userActor = await findActorByOwnerId(sessionUserId);
  if (!userActor) return null;

  const db = getSharedDirectDb();
  // Find any agent member of this room. Multi-agent rooms exist but
  // for the legacy `/api/sessions/latest?roomId=` shape the graph
  // thread is room-scoped; the agent membership is just the gate.
  const [agentMember] = await db
    .select({ agentId: actors.agentId })
    .from(roomMembers)
    .innerJoin(actors, eq(actors.id, roomMembers.actorId))
    .where(
      and(
        eq(roomMembers.roomId, roomId),
        eq(actors.kind, "agent"),
      ),
    )
    .limit(1);
  if (!agentMember?.agentId) return null;

  return (
    (
      await findRoomForUserAndAgentMembers(
        roomId,
        userActor.id,
        agentMember.agentId,
      )
    )?.graphThreadId ?? null
  );
}

export type CreateRoomForOwnerParams = {
  ownerUserId: string;
  ownerActorId: string;
  defaultAgentId: string;
  label: string;
};

/**
 * M078 — shared transactional mint for `private` rooms + namespace +
 * `room_members`. Callers run {@link updateRoomHumanActors} after commit
 * when human memberships need recomputation from `room_members`.
 */
export async function insertPrivateRoomBundleTx(
  tx: InviteSeedTx,
  params: {
    roomId: string;
    ownerUserId: string;
    label: string;
    graphThreadId: string;
    humanActorIds: string[];
    memberRows: Array<{
      actorId: string;
      roomRole: "admin" | "member";
      /** D128 — set only for agent-kind members when minting. */
      agentResponseMode?: AgentResponseMode | null;
    }>;
    createdByActorId: string;
    /** D111 + M124 — defaults to `private`. M173 adds `access`. */
    roomKind?: "private" | "group" | "multi_agent" | "open" | "access";
    /**
     * M042B legacy `type` bucket. Defaults to `private`; M124 open rooms
     * pass `shared`. (The `type` axis is independent of D111 `kind` and will
     * be retired in a later sweep.)
     */
    roomType?: "private" | "shared" | "room";
  },
): Promise<{ namespaceId: string }> {
  const [nsRow] = await tx
    .insert(namespaces)
    .values({
      scope: "private",
      label: params.label,
    })
    .returning({ id: namespaces.id });
  if (!nsRow) {
    throw new Error("insertPrivateRoomBundleTx: namespace insert failed");
  }

  await tx.insert(rooms).values({
    id: params.roomId,
    ownerId: params.ownerUserId,
    type: params.roomType ?? "private",
    label: params.label,
    graphThreadId: params.graphThreadId,
    namespaceId: nsRow.id,
    humanActorIds: params.humanActorIds,
    createdBy: params.createdByActorId,
    kind: params.roomKind ?? "private",
  });
  await createRoomJournalStateInTx(tx, params.roomId);

  await tx.insert(roomMembers).values(
    params.memberRows.map((m) => ({
      roomId: params.roomId,
      actorId: m.actorId,
      roomRole: m.roomRole,
      ...(m.agentResponseMode != null
        ? { agentResponseMode: m.agentResponseMode }
        : {}),
    })),
  );
  await reconcileRoomJournalMembershipInTx(tx, [params.roomId]);

  return { namespaceId: nsRow.id };
}

export type CreateSharedRoomParams = {
  ownerUserId: string;
  requesterActorId: string;
  targetActorId: string;
  agentId: string;
  label: string;
};

/**
 * M078 — mint a private room shared by two humans + the current Agent's
 * mirror actor (three `room_members`). Requester is `rooms.owner_id` and
 * room admin.
 */
export async function createSharedRoomForPair(
  params: CreateSharedRoomParams,
): Promise<{ roomId: string; namespaceId: string }> {
  const { ownerUserId, requesterActorId, targetActorId, agentId, label } =
    params;
  const agentActor = await findAgentActorForAgent(agentId);
  if (!agentActor) {
    throw new Error(
      `createSharedRoomForPair: no agent-actor for agent ${agentId}`,
    );
  }

  const roomId = randomUUID();
  const graphThreadId = `room:${roomId}`;

  const db = getSharedDirectDb();
  let namespaceId = "";
  await db.transaction(async (tx) => {
    const got = await insertPrivateRoomBundleTx(tx, {
      roomId,
      ownerUserId,
      label,
      graphThreadId,
      humanActorIds: [requesterActorId, targetActorId].sort(),
      memberRows: [
        { actorId: requesterActorId, roomRole: "admin" },
        { actorId: targetActorId, roomRole: "member" },
        {
          actorId: agentActor.id,
          roomRole: "member",
          agentResponseMode: "mention_only",
        },
      ],
      createdByActorId: requesterActorId,
    });
    namespaceId = got.namespaceId;
  });
  await updateRoomHumanActors(roomId);
  return { roomId, namespaceId };
}

/**
 * M173 — mint a non-conversational `kind='access'` Room + its 1:1 Namespace
 * for an exact human set. Humans-only (NO agent member — memory is
 * agent-agnostic and nothing should ever route a turn here); the
 * `graph_thread_id` is the degenerate `access:<id>` that is never invoked.
 *
 * `requesterActorId` MUST appear in `humanActorIds`; it becomes the room admin
 * + `created_by`. `human_actor_ids` is stored sorted (matches
 * `findRoomByExactHumanActorSet`'s `=` comparison). The legacy `type` bucket is
 * `'shared'` (harmless). Excluded from every room-enumeration surface (§5.7).
 */
export async function createAccessRoomForHumanSet(params: {
  ownerUserId: string;
  requesterActorId: string;
  humanActorIds: string[];
  label: string;
}): Promise<{ roomId: string; namespaceId: string }> {
  const humanActorIds = [...new Set(params.humanActorIds)].sort();
  if (humanActorIds.length === 0) {
    throw new Error("createAccessRoomForHumanSet: humanActorIds required");
  }
  if (!humanActorIds.includes(params.requesterActorId)) {
    throw new Error(
      "createAccessRoomForHumanSet: requesterActorId must appear in humanActorIds",
    );
  }

  const roomId = randomUUID();
  const graphThreadId = `access:${roomId}`;

  const db = getSharedDirectDb();
  let namespaceId = "";
  await db.transaction(async (tx) => {
    const got = await insertPrivateRoomBundleTx(tx, {
      roomId,
      ownerUserId: params.ownerUserId,
      label: params.label,
      graphThreadId,
      humanActorIds,
      memberRows: humanActorIds.map((actorId) => ({
        actorId,
        roomRole:
          actorId === params.requesterActorId
            ? ("admin" as const)
            : ("member" as const),
      })),
      createdByActorId: params.requesterActorId,
      roomKind: "access",
      roomType: "shared",
    });
    namespaceId = got.namespaceId;
  });
  await updateRoomHumanActors(roomId);
  return { roomId, namespaceId };
}

/**
 * M173/M227 — resolve a Namespace whose backing Room's human set is EXACTLY
 * `humanActorIds`. Prefers an existing non-public Room
 * (`findRoomByExactHumanActorSet`); only when none exists does it mint a
 * non-conversational `kind='access'` Room (`createAccessRoomForHumanSet`).
 * `minted` reports whether a new room was created (vs an existing one reused).
 *
 * `requesterActorId` MUST be in `humanActorIds` (it is the minted room's admin).
 * Used by the panel's revoke re-home (§5.4) and grant-by-handle (§5.5).
 */
export async function findOrCreateAccessNamespace(
  humanActorIds: string[],
  ctx: { requesterUserId: string; requesterActorId: string; label?: string },
): Promise<{ namespaceId: string; roomId: string; minted: boolean }> {
  const set = [...new Set(humanActorIds)].sort();
  if (set.length === 0) {
    throw new Error("findOrCreateAccessNamespace: humanActorIds required");
  }
  const existing = await findRoomByExactHumanActorSet(set);
  if (existing) {
    return {
      namespaceId: existing.namespaceId,
      roomId: existing.roomId,
      minted: false,
    };
  }
  const created = await createAccessRoomForHumanSet({
    ownerUserId: ctx.requesterUserId,
    requesterActorId: ctx.requesterActorId,
    humanActorIds: set,
    label: ctx.label ?? `Access (${set.length})`,
  });
  return {
    namespaceId: created.namespaceId,
    roomId: created.roomId,
    minted: true,
  };
}

/**
 * M258 — dormant strict resolve/reuse/create operation for Record projection.
 * The first sorted current Human is deterministic bookkeeping owner/admin;
 * that choice contributes no additional Record authority.
 */
export async function findOrCreateRecordAccessNamespace(
  humanActorIds: string[],
  options: { label?: string } = {},
): Promise<{ namespaceId: string; roomId: string; minted: boolean }> {
  const set = [...new Set(humanActorIds)].sort();
  if (set.length === 0) {
    throw new Error("findOrCreateRecordAccessNamespace: humanActorIds required");
  }
  const db = getSharedDirectDb();
  const humanRows = await db
    .select({ actorId: actors.id, ownerUserId: actors.ownerId })
    .from(actors)
    .where(and(inArray(actors.id, set), eq(actors.kind, "user")));
  const byActor = new Map(humanRows.map((row) => [row.actorId, row.ownerUserId]));
  if (byActor.size !== set.length || set.some((actorId) => !byActor.has(actorId))) {
    throw new Error(
      "findOrCreateRecordAccessNamespace: exact audience must contain current Humans only",
    );
  }
  const existing = await findRecordAccessRoomByExactHumanActorSet(set);
  if (existing !== null) return { ...existing, minted: false };
  const bookkeepingActorId = set[0]!;
  const ownerUserId = byActor.get(bookkeepingActorId)!;
  const created = await createAccessRoomForHumanSet({
    ownerUserId,
    requesterActorId: bookkeepingActorId,
    humanActorIds: set,
    label: options.label ?? `Record access (${set.length})`,
  });
  return { ...created, minted: true };
}

export type ShareTargetRoomRow = {
  roomId: string;
  namespaceId: string;
  label: string;
  humanActorCount: number;
};

/**
 * M078/M227 — smallest non-public Room (by human count, then oldest) where
 * both humans are present and the Agent's mirror actor is a member. An open
 * Namespace boundary cannot satisfy a human-only sharing audience.
 */
// M212 Phase 4 — full-role shared pool (`getSharedDirectDb`). Agent-scoped
// migration to `withTrustContext` requires adding userId to params and
// threading it through callers (D197 chokepoint refactor surface).
export async function findShareTargetRoom(params: {
  requesterActorId: string;
  targetActorId: string;
  agentId: string;
}): Promise<ShareTargetRoomRow | null> {
  const { requesterActorId, targetActorId, agentId } = params;
  if (!requesterActorId || !targetActorId || !agentId) {
    return null;
  }
  const db = getSharedDirectDb();
  const rows = await db
    .select({
      roomId: rooms.id,
      namespaceId: rooms.namespaceId,
      label: rooms.label,
      humanActorCount: sql<number>`cardinality(${rooms.humanActorIds})`.mapWith(
        Number,
      ),
    })
    .from(rooms)
    .innerJoin(roomMembers, eq(roomMembers.roomId, rooms.id))
    .innerJoin(actors, eq(actors.id, roomMembers.actorId))
    .where(
      and(
        sql`${rooms.humanActorIds} @> ARRAY[${sql.join(
          [sql`${requesterActorId}`, sql`${targetActorId}`],
          sql`, `,
        )}]::uuid[]`,
        privateNamespaceBoundarySql(rooms.namespaceId),
        eq(actors.kind, "agent"),
        eq(actors.agentId, agentId),
      ),
    )
    .orderBy(asc(sql`cardinality(${rooms.humanActorIds})`), asc(rooms.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    roomId: row.roomId,
    namespaceId: row.namespaceId,
    label: row.label,
    humanActorCount: row.humanActorCount,
  };
}

/**
 * M065 — mint namespace + private room + memberships; `graphThreadId`
 * is `room:<uuid>` (fresh uuid for `rooms.id`).
 */
export async function createRoomForOwner(
  params: CreateRoomForOwnerParams,
): Promise<RoomDetailPayload> {
  const { ownerUserId, ownerActorId, defaultAgentId, label } = params;
  const agentActor = await findAgentActorForAgent(defaultAgentId);
  if (!agentActor) {
    throw new Error(
      `createRoomForOwner: no agent-actor for agent ${defaultAgentId}`,
    );
  }

  const roomId = randomUUID();
  const graphThreadId = `room:${roomId}`;

  const db = getSharedDirectDb();
  await db.transaction(async (tx) => {
    await insertPrivateRoomBundleTx(tx, {
      roomId,
      ownerUserId,
      label,
      graphThreadId,
      humanActorIds: [ownerActorId],
      memberRows: [
        { actorId: ownerActorId, roomRole: "admin" },
        {
          actorId: agentActor.id,
          roomRole: "member",
          agentResponseMode: "active",
        },
      ],
      createdByActorId: ownerActorId,
    });
  });

  await updateRoomHumanActors(roomId);
  const detail = await getRoomDetailForMember(roomId, ownerActorId);
  if (!detail) {
    throw new Error("createRoomForOwner: room not visible after create");
  }
  return detail;
}

// ---------------------------------------------------------------------------
// M124 — public rooms (`kind='open'`): discovery, self-join, self-leave.
// ---------------------------------------------------------------------------

/**
 * M124 (MR2) — public rooms the caller can discover and join.
 *
 * Returns every `kind='open'` room that
 *   - belongs to this Server (the creator is a local user — `users.server IS
 *     NULL`, REL-HUM-SRV; future federation will widen this), AND
 *   - the caller is NOT already a member of.
 *
 * Same `RoomSummaryRow` shape `listRoomsForActor` returns, so the route can
 * reuse `toListResponse`. Server-level discovery is keyed purely on "is the
 * caller signed in" — there is NO Agent-relationship-role (`actorRole`)
 * filter here; that axis is the wrong one for Server discovery.
 *
 * `kind='subthread'` is mutually exclusive with `kind='open'`, so the
 * `kind = 'open'` filter already excludes subthreads — no extra clause.
 */
export async function listDiscoverableRoomsForUser(
  userId: string,
): Promise<RoomSummaryRow[]> {
  if (!userId) return [];
  const callerActor = await findActorByOwnerId(userId);
  const callerActorId = callerActor?.id ?? null;

  const db = getSharedDirectDb();
  const candidates = await db
    .select({
      id: rooms.id,
      label: rooms.label,
      type: rooms.type,
      graphThreadId: rooms.graphThreadId,
      createdAt: rooms.createdAt,
      kind: rooms.kind,
      parentRoomId: rooms.parentRoomId,
      threadRootMessageId: rooms.threadRootMessageId,
    })
    .from(rooms)
    .innerJoin(users, eq(users.id, rooms.ownerId))
    // M157 — `kind='open'` already excludes internal `task` rooms and nested
    // `subthread` rooms; no extra guard needed here.
    .where(
      and(eq(rooms.kind, "open"), isNull(users.server), isNull(rooms.archivedAt)),
    )
    .orderBy(desc(rooms.createdAt));

  if (candidates.length === 0) return [];

  // Anti-join: drop rooms the caller already belongs to. Done as a
  // follow-up membership lookup (not a SQL NOT EXISTS) to keep the
  // primary select index-friendly and the logic obvious.
  let joinedRoomIds = new Set<string>();
  if (callerActorId) {
    const candidateIds = candidates.map((r) => r.id);
    const memberRows = await db
      .select({ roomId: roomMembers.roomId })
      .from(roomMembers)
      .where(
        and(
          eq(roomMembers.actorId, callerActorId),
          inArray(roomMembers.roomId, candidateIds),
        ),
      );
    joinedRoomIds = new Set(memberRows.map((m) => m.roomId));
  }

  const visible = candidates.filter((r) => !joinedRoomIds.has(r.id));
  if (visible.length === 0) return [];

  const ids = visible.map((r) => r.id);
  const countRows = await db
    .select({ roomId: roomMembers.roomId, n: count() })
    .from(roomMembers)
    .where(inArray(roomMembers.roomId, ids))
    .groupBy(roomMembers.roomId);
  const countMap = new Map(
    countRows.map((c) => [c.roomId, Number(c.n)] as const),
  );

  const messageActivityRows = await db
    .select({
      roomId: sessions.roomId,
      messageCount: sql<number>`count(${sessionMessages.id})`,
      lastMessageAt: sql<Date | null>`max(${sessionMessages.createdAt})`,
    })
    .from(sessions)
    .innerJoin(sessionMessages, eq(sessionMessages.sessionId, sessions.id))
    .where(inArray(sessions.roomId, ids))
    .groupBy(sessions.roomId);
  const messageActivityMap = new Map(
    messageActivityRows
      .filter((r) => typeof r.roomId === "string")
      .map((r) => [
        r.roomId as string,
        {
          messageCount: Number(r.messageCount),
          lastMessageAt: isoFromDbTimestamp(r.lastMessageAt as Date | string | null),
        },
      ] as const),
  );

  return visible.map((r) => ({
    id: r.id,
    label: r.label,
    type: r.type,
    graphThreadId: r.graphThreadId,
    createdAt: (r.createdAt ?? new Date()).toISOString(),
    memberCount: countMap.get(r.id) ?? 0,
    messageCount: messageActivityMap.get(r.id)?.messageCount ?? 0,
    lastMessageAt: messageActivityMap.get(r.id)?.lastMessageAt ?? null,
    unreadCount: 0,
    kind: r.kind,
    parentRoomId: r.parentRoomId ?? null,
    threadRootMessageId: r.threadRootMessageId ?? null,
  }));
}

/**
 * M259 — public-Room landing candidates for a Human who cannot invoke Agents.
 * Discovery itself remains unchanged; this internal projection removes every
 * Room containing an Agent so the server-owned fallback can never seat a Guest
 * in an Agent Room merely because it is the largest public Room.
 */
export async function listHumanOnlyDiscoverableRoomsForUser(
  userId: string,
): Promise<RoomSummaryRow[]> {
  const candidates = await listDiscoverableRoomsForUser(userId);
  const classified = await Promise.all(
    candidates.map(async (room) => ({ room, roster: await loadRoomRoster(room.id) })),
  );
  return classified
    .filter(({ roster }) => roster.every((member) => member.kind === "user"))
    .map(({ room }) => room);
}

async function inheritOpenParentMemberIntoSubthreadsInTx(
  tx: InviteSeedTx,
  parentRoomId: string,
  actorId: string,
): Promise<{
  roomIds: string[];
  event: RoomMembershipSystemEventPayload | null;
}> {
  const [parentMembership] = await tx
    .select({
      roomRole: roomMembers.roomRole,
      agentResponseMode: roomMembers.agentResponseMode,
      kind: actors.kind,
      displayName: actors.displayName,
    })
    .from(roomMembers)
    .innerJoin(actors, eq(actors.id, roomMembers.actorId))
    .where(
      and(
        eq(roomMembers.roomId, parentRoomId),
        eq(roomMembers.actorId, actorId),
      ),
    )
    .limit(1);
  if (!parentMembership) return { roomIds: [], event: null };

  const childRooms = (
    await tx
      .select({ id: rooms.id })
      .from(rooms)
      .where(
        and(
          eq(rooms.parentRoomId, parentRoomId),
          eq(rooms.kind, "subthread"),
        ),
      )
  ).sort((a, b) => a.id.localeCompare(b.id));

  const repairedRoomIds: string[] = [];
  for (const child of childRooms) {
    await acquireRoomWriteLock(tx, child.id);
    const [existing] = await tx
      .select({ actorId: roomMembers.actorId })
      .from(roomMembers)
      .where(
        and(
          eq(roomMembers.roomId, child.id),
          eq(roomMembers.actorId, actorId),
        ),
      )
      .limit(1);
    if (existing) continue;
    await tx.insert(roomMembers).values({
      roomId: child.id,
      actorId,
      roomRole: parentMembership.roomRole,
      ...(parentMembership.agentResponseMode
        ? { agentResponseMode: parentMembership.agentResponseMode }
        : {}),
    });
    if (parentMembership.kind === "user") {
      await updateRoomHumanActorsInTx(tx, child.id);
    }
    repairedRoomIds.push(child.id);
  }

  return {
    roomIds: repairedRoomIds,
    event:
      repairedRoomIds.length > 0
        ? {
            kind: "member_added",
            actorId,
            actorKind: parentMembership.kind as "user" | "agent",
            displayName: parentMembership.displayName,
          }
        : null,
  };
}

async function repairOpenParentMemberSubthreads(
  parentRoomId: string,
  actorId: string,
): Promise<{
  roomIds: string[];
  event: RoomMembershipSystemEventPayload | null;
}> {
  const db = getSharedDirectDb();
  return db.transaction(async (tx) => {
    await acquireRoomWriteLock(tx, parentRoomId);
    const [parent] = await tx
      .select({ kind: rooms.kind })
      .from(rooms)
      .where(eq(rooms.id, parentRoomId))
      .limit(1);
    if (parent?.kind !== "open") return { roomIds: [], event: null };

    const repaired = await inheritOpenParentMemberIntoSubthreadsInTx(
      tx,
      parentRoomId,
      actorId,
    );
    if (repaired.roomIds.length > 0) {
      await reconcileRoomJournalMembershipInTx(tx, repaired.roomIds);
    }
    return repaired;
  });
}

/**
 * M124 (MR3) — self-join an open room. Idempotent.
 *
 * Validates `rooms.kind = 'open'` (else `MembershipOpError('not_open')`) and
 * existence (else `MembershipOpError('not_found')`). On a fresh join inserts
 * a human `room_members` row (`room_role='member'`, `agent_response_mode`
 * NULL — the joiner is a human), refreshes `rooms.human_actor_ids`, and
 * returns the membership event for the route to publish + audit. Every join
 * also reconciles the actor into child Subthreads, so an idempotent parent
 * join may still return repaired child IDs for subscription/WS convergence.
 * A fully converged rejoin returns no events (D196 "emit only on real
 * change").
 */
export async function joinOpenRoom(params: {
  userId: string;
  actorId: string;
  roomId: string;
}): Promise<{
  membershipEvent: RoomMembershipSystemEventPayload | null;
  membershipMessageId?: number;
  humanMembershipTransitions?: readonly HumanRoomMembershipTransitionFact[];
  repairedSubthreadIds: string[];
  repairedSubthreadEvent: RoomMembershipSystemEventPayload | null;
}> {
  const { actorId, roomId } = params;
  const db = getSharedDirectDb();
  return await db.transaction(async (tx) => {
    await acquireRoomWriteLock(tx, roomId);

    const [room] = await tx
      .select({ id: rooms.id, kind: rooms.kind })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1);
    if (!room) {
      throw new MembershipOpError("not_found");
    }
    if (room.kind !== "open") {
      throw new MembershipOpError("not_open");
    }

    const [existing] = await tx
      .select({ actorId: roomMembers.actorId })
      .from(roomMembers)
      .where(
        and(eq(roomMembers.roomId, roomId), eq(roomMembers.actorId, actorId)),
      )
      .limit(1);
    let membershipMessageId: number | undefined;
    let membershipEvent: RoomMembershipSystemEventPayload | null = null;
    let previousHumanSnapshot: RoomHumanAuthoritySnapshot | null = null;
    if (!existing) {
      previousHumanSnapshot = await loadRoomHumanAuthoritySnapshotInTx(tx, roomId);
      await tx.insert(roomMembers).values({
        roomId,
        actorId,
        roomRole: "member",
      });
      await updateRoomHumanActorsInTx(tx, roomId);
      const displayName = await resolveActorDisplayNameInTx(tx, actorId);
      membershipEvent = {
        kind: "member_added",
        actorId,
        actorKind: "user",
        displayName,
      };
      membershipMessageId = await appendRoomMembershipSystemMessagesInTx(tx, roomId, membershipEvent);
    }

    const repaired = await inheritOpenParentMemberIntoSubthreadsInTx(
      tx,
      roomId,
      actorId,
    );
    if (membershipEvent || repaired.roomIds.length > 0) {
      await reconcileRoomJournalMembershipInTx(tx, [roomId, ...repaired.roomIds]);
    }

    const currentHumanSnapshot = previousHumanSnapshot === null
      ? null
      : await loadRoomHumanAuthoritySnapshotInTx(tx, roomId);
    const humanMembershipTransitions = previousHumanSnapshot !== null
        && currentHumanSnapshot !== null
      ? [Object.freeze({
        kind: "human_add" as const,
        targetHumanActorId: actorId,
        previous: previousHumanSnapshot,
        current: currentHumanSnapshot,
      })]
      : [];

    return {
      membershipEvent,
      ...(membershipMessageId === undefined ? {} : { membershipMessageId }),
      ...(humanMembershipTransitions.length > 0
        ? { humanMembershipTransitions: Object.freeze(humanMembershipTransitions) }
        : {}),
      repairedSubthreadIds: repaired.roomIds,
      repairedSubthreadEvent: repaired.event,
    };
  });
}

export type CreateOpenRoomParams = {
  creatorUserId: string;
  creatorActorId: string;
  label: string;
  /** D473 — optional exact initial roster; omit for creator-only open rooms. */
  members?: Array<{ kind: "user" | "agent"; id: string }>;
};

type ResolvedCreateRoomMember = {
  actorId: string;
  actorKind: "user" | "agent";
};

/** Resolve a create-room entity roster to actor rows before minting anything. */
async function resolveCreateRoomMembers(
  members: Array<{ kind: "user" | "agent"; id: string }>,
  operation: "createOpenRoom" | "createRoomFromMembers",
): Promise<ResolvedCreateRoomMember[]> {
  const db = getSharedDirectDb();
  const resolved: ResolvedCreateRoomMember[] = [];
  for (const m of members) {
    if (m.kind === "user") {
      const [row] = await db
        .select({ id: actors.id })
        .from(actors)
        .where(and(eq(actors.ownerId, m.id), eq(actors.kind, "user")))
        .limit(1);
      if (!row) {
        throw new Error(`${operation}: no user actor for user ${m.id}`);
      }
      resolved.push({ actorId: row.id, actorKind: "user" });
    } else {
      const [row] = await db
        .select({ id: actors.id })
        .from(actors)
        .where(and(eq(actors.agentId, m.id), eq(actors.kind, "agent")))
        .limit(1);
      if (!row) {
        throw new Error(`${operation}: no agent actor for agent ${m.id}`);
      }
      resolved.push({ actorId: row.id, actorKind: "agent" });
    }
  }

  const seen = new Set<string>();
  for (const member of resolved) {
    if (seen.has(member.actorId)) {
      throw new Error(`${operation}: duplicate members`);
    }
    seen.add(member.actorId);
  }
  return resolved;
}

/**
 * M124 (MR4) — mint a `kind='open'`, `type='shared'` public room with the
 * creator as the sole initial member (`room_role='admin'`,
 * `agent_response_mode=NULL`) when no roster is supplied. A supplied exact
 * roster must contain that creator exactly once and is inserted in the same
 * room + room-members transaction.
 *
 * Unlike `createRoomForOwner`, NO default agent is auto-added (a chatty bot
 * in a public channel is a footgun — the creator opts in later via the
 * members panel). Route callers validate supplied rosters and reachability;
 * this query defensively verifies the resolved roster before minting. The
 * namespace is minted transactionally exactly like the private path.
 */
export async function createOpenRoom(
  params: CreateOpenRoomParams,
): Promise<RoomDetailPayload> {
  const { creatorUserId, creatorActorId, label, members } = params;
  const resolved = members
    ? await resolveCreateRoomMembers(members, "createOpenRoom")
    : [{ actorId: creatorActorId, actorKind: "user" as const }];
  const creatorCount = resolved.filter((member) => member.actorId === creatorActorId).length;
  if (creatorCount !== 1) {
    throw new Error("createOpenRoom: creatorActorId must appear exactly once in members");
  }
  const humanActorIds = resolved
    .filter((member) => member.actorKind === "user")
    .map((member) => member.actorId)
    .sort();
  const mintedAgentMode = members ? defaultAgentResponseModeAtMint(members) : null;
  const memberRows = resolved.map((member) => ({
    actorId: member.actorId,
    roomRole: member.actorId === creatorActorId ? ("admin" as const) : ("member" as const),
    ...(member.actorKind === "agent" && mintedAgentMode != null
      ? { agentResponseMode: mintedAgentMode }
      : {}),
  }));
  const roomId = randomUUID();
  const graphThreadId = `room:${roomId}`;

  const db = getSharedDirectDb();
  await db.transaction(async (tx) => {
    await insertPrivateRoomBundleTx(tx, {
      roomId,
      ownerUserId: creatorUserId,
      label,
      graphThreadId,
      humanActorIds,
      memberRows,
      createdByActorId: creatorActorId,
      roomKind: "open",
      roomType: "shared",
    });
  });

  await updateRoomHumanActors(roomId);
  const detail = await getRoomDetailForMember(roomId, creatorActorId);
  if (!detail) {
    throw new Error("createOpenRoom: room not visible after create");
  }
  return detail;
}

/**
 * M124 (MR8 helper) — human admin members of a room other than
 * `excludingActorId`. Backs the self-leave guard: a room owner may only
 * leave once another admin exists. Agents can't be `room_role='admin'`
 * owners, so the `actors.kind='user'` filter keeps this to humans.
 */
export async function findOtherAdminMembers(
  roomId: string,
  excludingActorId: string,
): Promise<string[]> {
  if (!roomId) return [];
  const db = getSharedDirectDb();
  const rowsResult = await db
    .select({ actorId: roomMembers.actorId })
    .from(roomMembers)
    .innerJoin(actors, eq(actors.id, roomMembers.actorId))
    .where(
      and(
        eq(roomMembers.roomId, roomId),
        eq(roomMembers.roomRole, "admin"),
        eq(actors.kind, "user"),
        sql`${roomMembers.actorId} <> ${excludingActorId}`,
      ),
    );
  return rowsResult.map((r) => r.actorId);
}

/**
 * M124 (MR8 helper) — `rooms.owner_id` for a room, or `null` if no such
 * room. Used by the self-leave guard to decide whether the caller is the
 * room creator (creator-leave is blocked until another admin exists).
 */
export async function findRoomOwnerUserId(
  roomId: string,
): Promise<string | null> {
  if (!roomId) return null;
  const db = getSharedDirectDb();
  const [row] = await db
    .select({ ownerId: rooms.ownerId })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);
  return row?.ownerId ?? null;
}

/** D111 — initial `rooms.kind` from an explicit member list (never `subthread`). */
export type RoomKindNonSubthread = "private" | "group" | "multi_agent";

export function deriveInitialKind(
  members: Array<{ kind: "user" | "agent" }>,
): RoomKindNonSubthread {
  const humans = members.filter((m) => m.kind === "user").length;
  const agents = members.filter((m) => m.kind === "agent").length;
  if (agents === 0 && humans >= 2) return "group";
  if (agents >= 2 && humans === 0) return "multi_agent";
  return "private";
}

/** D128 — default `agent_response_mode` stamped on new agent memberships at mint. */
export type AgentResponseMode = "active" | "mention_only" | "observe";

export function defaultAgentResponseModeAtMint(
  members: Array<{ kind: "user" | "agent" }>,
): AgentResponseMode | null {
  const humanCount = members.filter((m) => m.kind === "user").length;
  const agentCount = members.filter((m) => m.kind === "agent").length;
  if (agentCount < 1) return null;
  if (humanCount === 1) return "active";
  if (humanCount >= 2) return "mention_only";
  return null;
}

export type CreateRoomFromMembersParams = {
  ownerUserId: string;
  ownerActorId: string;
  label: string;
  members: Array<{ kind: "user" | "agent"; id: string }>;
  /** Human-facing named Room marker; dispatch kind remains roster-derived. */
  roomType?: "private" | "room";
};

/**
 * D111 — mint namespace + room from an explicit member list (agent-less
 * rooms supported). Caller passes `members` with `kind` + entity id
 * (`users.id` or `agents.id`).
 */
export async function createRoomFromMembers(
  params: CreateRoomFromMembersParams,
): Promise<RoomDetailPayload> {
  const { ownerUserId, ownerActorId, label, members } = params;
  if (members.length === 0) {
    throw new Error("createRoomFromMembers: members required");
  }

  const resolved = await resolveCreateRoomMembers(members, "createRoomFromMembers");
  const db = getSharedDirectDb();
  if (!resolved.some((member) => member.actorId === ownerActorId)) {
    throw new Error("createRoomFromMembers: ownerActorId must appear in members");
  }

  const roomKind = deriveInitialKind(members);
  const humanActorIds = resolved
    .filter((r) => r.actorKind === "user")
    .map((r) => r.actorId)
    .sort();

  const mintedAgentMode = defaultAgentResponseModeAtMint(members);
  const memberRows = resolved.map((r) => ({
    actorId: r.actorId,
    roomRole: r.actorId === ownerActorId ? ("admin" as const) : ("member" as const),
    ...(r.actorKind === "agent" && mintedAgentMode != null
      ? { agentResponseMode: mintedAgentMode }
      : {}),
  }));

  const roomId = randomUUID();
  const graphThreadId = `room:${roomId}`;

  await db.transaction(async (tx) => {
    await insertPrivateRoomBundleTx(tx, {
      roomId,
      ownerUserId,
      label,
      graphThreadId,
      humanActorIds,
      memberRows,
      createdByActorId: ownerActorId,
      roomKind,
      ...(params.roomType ? { roomType: params.roomType } : {}),
    });
  });

  await updateRoomHumanActors(roomId);
  const detail = await getRoomDetailForMember(roomId, ownerActorId);
  if (!detail) {
    throw new Error("createRoomFromMembers: room not visible after create");
  }
  return detail;
}

/**
 * M259 — canonical active Server owner used only as the final Guest landing
 * fallback. Authority is canonical `owners` Group membership, never a Role
 * label cached by a client. Disabled and foreign Humans are excluded.
 */
export async function findCanonicalActiveServerOwner(): Promise<{
  userId: string;
  actorId: string;
  displayName: string;
} | null> {
  const db = getSharedDirectDb();
  const [row] = await db
    .select({
      userId: users.id,
      actorId: actors.id,
      displayName: actors.displayName,
    })
    .from(groups)
    .innerJoin(groupMembers, eq(groupMembers.groupId, groups.id))
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .innerJoin(
      actors,
      and(eq(actors.ownerId, users.id), eq(actors.kind, "user")),
    )
    .where(
      and(
        eq(groups.type, "owners"),
        isNull(users.disabledAt),
        isNull(users.server),
      ),
    )
    .orderBy(asc(groupMembers.grantedAt), asc(users.id))
    .limit(1);
  return row ?? null;
}

/**
 * M260 — resolve and publish an Invite's landing membership inside the
 * caller-owned completion transaction.
 *
 * An explicit target is exact and never falls back. Without one, the largest
 * eligible open Room wins (Agent-bearing Rooms are intentionally eligible now
 * that `invoke_agents` is authoritative), followed by the canonical Human-only
 * owner DM. Returning `null` lets the completion transaction fail without
 * publishing Group membership or consuming an Invite use.
 */
export async function resolveInviteLandingRoomInTx(
  tx: InviteSeedTx,
  params: {
    inviteeUserId: string;
    inviteeActorId: string;
    targetRoomId: string | null;
  },
): Promise<{ roomId: string; joinedExistingRoom: boolean } | null> {
  if (params.targetRoomId) {
    const [target] = await tx
      .select({ id: rooms.id, kind: rooms.kind })
      .from(rooms)
      .where(
        and(
          eq(rooms.id, params.targetRoomId),
          isNull(rooms.archivedAt),
        ),
      )
      .limit(1);
    if (!target) return null;

    await acquireRoomWriteLock(tx, target.id);

    const insertedMembership = await tx
      .insert(roomMembers)
      .values({
        roomId: target.id,
        actorId: params.inviteeActorId,
        roomRole: "member",
      })
      .onConflictDoNothing({
        target: [roomMembers.roomId, roomMembers.actorId],
      }).returning({ actorId: roomMembers.actorId });
    await updateRoomHumanActorsInTx(tx, target.id);
    const repaired =
      target.kind === "open"
        ? await inheritOpenParentMemberIntoSubthreadsInTx(
            tx,
            target.id,
            params.inviteeActorId,
          )
        : { roomIds: [], event: null };
    await reconcileRoomJournalMembershipInTx(tx, [
      target.id,
      ...repaired.roomIds,
    ]);
    return { roomId: target.id, joinedExistingRoom: insertedMembership.length > 0 && target.kind !== "subthread" && target.kind !== "access" && target.kind !== "task" };
  }

  const memberCount = count(roomMembers.actorId);
  const [openRoom] = await tx
    .select({ id: rooms.id, memberCount })
    .from(rooms)
    .innerJoin(users, eq(users.id, rooms.ownerId))
    .leftJoin(roomMembers, eq(roomMembers.roomId, rooms.id))
    .where(
      and(
        eq(rooms.kind, "open"),
        isNull(rooms.archivedAt),
        isNull(users.server),
      ),
    )
    .groupBy(rooms.id, rooms.createdAt)
    .orderBy(desc(memberCount), asc(rooms.createdAt), asc(rooms.id))
    .limit(1);

  if (openRoom) {
    await acquireRoomWriteLock(tx, openRoom.id);
    const insertedMembership = await tx
      .insert(roomMembers)
      .values({
        roomId: openRoom.id,
        actorId: params.inviteeActorId,
        roomRole: "member",
      })
      .onConflictDoNothing({
        target: [roomMembers.roomId, roomMembers.actorId],
      }).returning({ actorId: roomMembers.actorId });
    await updateRoomHumanActorsInTx(tx, openRoom.id);
    const repaired = await inheritOpenParentMemberIntoSubthreadsInTx(
      tx,
      openRoom.id,
      params.inviteeActorId,
    );
    await reconcileRoomJournalMembershipInTx(tx, [
      openRoom.id,
      ...repaired.roomIds,
    ]);
    return { roomId: openRoom.id, joinedExistingRoom: insertedMembership.length > 0 };
  }

  const [owner] = await tx
    .select({
      userId: users.id,
      actorId: actors.id,
      displayName: actors.displayName,
    })
    .from(groups)
    .innerJoin(groupMembers, eq(groupMembers.groupId, groups.id))
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .innerJoin(
      actors,
      and(eq(actors.ownerId, users.id), eq(actors.kind, "user")),
    )
    .where(
      and(
        eq(groups.type, "owners"),
        isNull(users.disabledAt),
        isNull(users.server),
      ),
    )
    .orderBy(asc(groupMembers.grantedAt), asc(users.id))
    .limit(1);
  if (!owner) return null;
  if (
    owner.userId === params.inviteeUserId ||
    owner.actorId === params.inviteeActorId
  ) {
    const [personalRoom] = await tx
      .select({ id: rooms.id })
      .from(rooms)
      .innerJoin(
        roomMembers,
        and(
          eq(roomMembers.roomId, rooms.id),
          eq(roomMembers.actorId, params.inviteeActorId),
        ),
      )
      .where(
        and(
          eq(rooms.ownerId, params.inviteeUserId),
          isNull(rooms.archivedAt),
        ),
      )
      .orderBy(asc(rooms.createdAt), asc(rooms.id))
      .limit(1);
    return personalRoom ? { roomId: personalRoom.id, joinedExistingRoom: false } : null;
  }

  const humanActorIds = [owner.actorId, params.inviteeActorId].sort();
  const lockKey = `m260:invite-human-dm:${humanActorIds.join(":")}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);

  const [existing] = await tx
    .select({ id: rooms.id })
    .from(rooms)
    .where(
      and(
        sql`${rooms.humanActorIds} = ARRAY[${sql.join(
          humanActorIds.map((id) => sql`${id}`),
          sql`, `,
        )}]::uuid[]`,
        isNull(rooms.archivedAt),
        sql`${rooms.kind} IN ('private', 'group')`,
        sql`NOT EXISTS (
          SELECT 1
          FROM ${roomMembers} landing_members
          INNER JOIN ${actors} landing_actors
            ON landing_actors.id = landing_members.actor_id
          WHERE landing_members.room_id = ${rooms.id}
            AND landing_actors.kind = 'agent'
        )`,
      ),
    )
    .orderBy(asc(rooms.createdAt), asc(rooms.id))
    .limit(1);
  if (existing) return { roomId: existing.id, joinedExistingRoom: false };

  const roomId = randomUUID();
  await insertPrivateRoomBundleTx(tx, {
    roomId,
    ownerUserId: owner.userId,
    label: owner.displayName,
    graphThreadId: `room:${roomId}`,
    humanActorIds,
    memberRows: [
      { actorId: owner.actorId, roomRole: "admin" },
      { actorId: params.inviteeActorId, roomRole: "member" },
    ],
    createdByActorId: owner.actorId,
    roomKind: "group",
    roomType: "shared",
  });
  return { roomId, joinedExistingRoom: false };
}

/**
 * M259 — resolve or atomically create the final Human-only administrator DM.
 * The transaction-scoped advisory lock makes concurrent first-load requests
 * converge on one Room without introducing schema solely for this fallback.
 */
export async function findOrCreateHumanOnlyDirectRoom(params: {
  ownerUserId: string;
  ownerActorId: string;
  guestActorId: string;
  label: string;
}): Promise<RoomDetailPayload> {
  const humanActorIds = [...new Set([params.ownerActorId, params.guestActorId])].sort();
  if (humanActorIds.length !== 2) {
    throw new Error("findOrCreateHumanOnlyDirectRoom: two distinct Humans required");
  }
  const db = getSharedDirectDb();
  const roomId = await db.transaction(async (tx) => {
    const lockKey = `m259:human-dm:${humanActorIds.join(":")}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);

    const [existing] = await tx
      .select({ id: rooms.id })
      .from(rooms)
      .where(
        and(
          sql`${rooms.humanActorIds} = ARRAY[${sql.join(
            humanActorIds.map((id) => sql`${id}`),
            sql`, `,
          )}]::uuid[]`,
          isNull(rooms.archivedAt),
          sql`${rooms.kind} IN ('private', 'group')`,
          sql`NOT EXISTS (
            SELECT 1
            FROM ${roomMembers} landing_members
            INNER JOIN ${actors} landing_actors
              ON landing_actors.id = landing_members.actor_id
            WHERE landing_members.room_id = ${rooms.id}
              AND landing_actors.kind = 'agent'
          )`,
        ),
      )
      .orderBy(asc(rooms.createdAt), asc(rooms.id))
      .limit(1);
    if (existing) return existing.id;

    const createdRoomId = randomUUID();
    await insertPrivateRoomBundleTx(tx, {
      roomId: createdRoomId,
      ownerUserId: params.ownerUserId,
      label: params.label,
      graphThreadId: `room:${createdRoomId}`,
      humanActorIds,
      memberRows: [
        { actorId: params.ownerActorId, roomRole: "admin" },
        { actorId: params.guestActorId, roomRole: "member" },
      ],
      createdByActorId: params.ownerActorId,
      roomKind: "group",
      roomType: "shared",
    });
    return createdRoomId;
  });

  await updateRoomHumanActors(roomId);
  const detail = await getRoomDetailForMember(roomId, params.guestActorId);
  if (!detail) {
    throw new Error("findOrCreateHumanOnlyDirectRoom: room not visible after resolve");
  }
  return detail;
}

function isPostgresUniqueViolation(err: unknown): boolean {
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  ) {
    return true;
  }
  if (typeof err === "object" && err !== null && "cause" in err) {
    return isPostgresUniqueViolation((err as { cause: unknown }).cause);
  }
  return false;
}

export interface CreateSubthreadInput {
  parentRoomId: string;
  anchorMessageId: number;
  label?: string | null;
  requesterActorId: string;
  /** Optional explicit member list; must be a subset of parent members. */
  members?: { actorId: string }[];
}

export interface SubthreadSummary {
  id: string;
  parentRoomId: string;
  anchorMessageId: number;
  label: string;
  replyCount: number;
  lastReplyAt: string | null;
  createdAt: string;
}

export interface SubthreadDetailPayload {
  parentRoomId: string;
  subthreadRoomId: string;
  anchor: {
    id: number;
    role: string;
    content: string | null;
    toolCalls: string | null;
    toolName: string | null;
    createdAt: Date;
    editedAt: Date | null;
    editRevision: number;
    fingerprint: string | null;
    replyToMessageId: number | null;
    replyCount: number;
    lastReplyAt: Date | null;
    summaryRevision: number;
    sourceUserId: string;
    authorAgentId: string | null;
  };
  summary: {
    replyCount: number;
    lastReplyAt: Date | null;
    summaryRevision: number;
  };
}

/**
 * D426 — canonical child hydration, gated on requester membership before the
 * parent anchor is read. Invalid room shape and a missing/cross-parent anchor
 * deliberately collapse to null so HTTP callers can fail closed with 404.
 */
export async function getSubthreadDetailForMember(
  subthreadRoomId: string,
  requesterActorId: string,
): Promise<SubthreadDetailPayload | null> {
  if (!subthreadRoomId || !requesterActorId) return null;
  const db = getSharedDirectDb();
  return getSubthreadDetailForMemberWithDb(db, subthreadRoomId, requesterActorId);
}

export async function getSubthreadDetailForMemberWithDb(
  db: Pick<Database, "select">,
  subthreadRoomId: string,
  requesterActorId: string,
): Promise<SubthreadDetailPayload | null> {
  if (!subthreadRoomId || !requesterActorId) return null;
  const [child] = await db
    .select({
      id: rooms.id,
      kind: rooms.kind,
      parentRoomId: rooms.parentRoomId,
      threadRootMessageId: rooms.threadRootMessageId,
    })
    .from(rooms)
    .innerJoin(
      roomMembers,
      and(
        eq(roomMembers.roomId, rooms.id),
        eq(roomMembers.actorId, requesterActorId),
      ),
    )
    .where(and(eq(rooms.id, subthreadRoomId), isNull(rooms.archivedAt)))
    .limit(1);
  if (
    !child ||
    child.kind !== "subthread" ||
    !child.parentRoomId ||
    child.threadRootMessageId == null
  ) {
    return null;
  }

  const [anchor] = await db
    .select({
      id: sessionMessages.id,
      role: sessionMessages.role,
      content: sessionMessages.content,
      toolCalls: sessionMessages.toolCalls,
      toolName: sessionMessages.toolName,
      createdAt: sessionMessages.createdAt,
      editedAt: sessionMessages.editedAt,
      editRevision: sessionMessages.editRevision,
      fingerprint: sessionMessages.fingerprint,
      replyToMessageId: sessionMessages.replyToMessageId,
      replyCount: sessionMessages.replyCount,
      lastReplyAt: sessionMessages.lastReplyAt,
      summaryRevision: sessionMessages.summaryRevision,
      sourceUserId: sessions.ownerId,
      authorAgentId: sessions.agentId,
    })
    .from(sessionMessages)
    .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
    .where(
      and(
        eq(sessionMessages.id, child.threadRootMessageId),
        eq(sessions.roomId, child.parentRoomId),
      ),
    )
    .limit(1);
  if (!anchor) return null;

  return {
    parentRoomId: child.parentRoomId,
    subthreadRoomId: child.id,
    anchor,
    summary: {
      replyCount: anchor.replyCount,
      lastReplyAt: anchor.lastReplyAt,
      summaryRevision: anchor.summaryRevision,
    },
  };
}

/**
 * D111 — create a Subthread Room anchored to a message in `parentRoomId`.
 * Inherits `namespace_id`, `human_actor_ids`, `owner_id`, and `type` from parent.
 */
export async function createSubthreadRoom(
  input: CreateSubthreadInput,
): Promise<{
  subthreadRoomId: string;
  repairedMembership?: RoomMembershipSystemEventPayload;
  repairedSubthreadIds?: string[];
}> {
  const db = getSharedDirectDb();
  const [dup] = await db
    .select({ id: rooms.id, parentRoomId: rooms.parentRoomId })
    .from(rooms)
    .where(
      and(
        eq(rooms.threadRootMessageId, input.anchorMessageId),
        eq(rooms.kind, "subthread"),
      ),
    )
    .limit(1);
  if (dup) {
    const [membership] = await db
      .select({ actorId: roomMembers.actorId })
      .from(roomMembers)
      .where(
        and(
          eq(roomMembers.roomId, dup.id),
          eq(roomMembers.actorId, input.requesterActorId),
        ),
      )
      .limit(1);
    if (dup.parentRoomId !== input.parentRoomId) {
      throw new MembershipOpError("subthread_not_visible");
    }
    if (!membership) {
      const repaired = await repairOpenParentMemberSubthreads(
        input.parentRoomId,
        input.requesterActorId,
      );
      if (!repaired.roomIds.includes(dup.id) || !repaired.event) {
        throw new MembershipOpError("subthread_not_visible");
      }
      return {
        subthreadRoomId: dup.id,
        repairedMembership: repaired.event,
        repairedSubthreadIds: repaired.roomIds,
      };
    }
    return { subthreadRoomId: dup.id };
  }

  const subId = randomUUID();
  const graphThreadId = `room:${subId}`;

  try {
    await db.transaction(async (tx) => {
      // Parent membership changes and child creation share one stable lock
      // order. Re-read the parent roster after locking so a concurrent open
      // join cannot commit a parent-only member while this child snapshots an
      // older roster.
      await acquireRoomWriteLock(tx, input.parentRoomId);
      const [anchorRow] = await tx
        .select({ id: sessionMessages.id })
        .from(sessionMessages)
        .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
        .where(
          and(
            eq(sessionMessages.id, input.anchorMessageId),
            eq(sessions.roomId, input.parentRoomId),
          ),
        )
        .limit(1);
      if (!anchorRow) {
        throw new MembershipOpError("subthread_invalid_anchor");
      }

      const [parent] = await tx
        .select({
          ownerId: rooms.ownerId,
          type: rooms.type,
          label: rooms.label,
          namespaceId: rooms.namespaceId,
          humanActorIds: rooms.humanActorIds,
          kind: rooms.kind,
        })
        .from(rooms)
        .where(eq(rooms.id, input.parentRoomId))
        .limit(1);
      if (!parent || parent.kind === "subthread") {
        throw new MembershipOpError("subthread_invalid_anchor");
      }

      const parentMemberRows = await tx
        .select({
          actorId: roomMembers.actorId,
          roomRole: roomMembers.roomRole,
          agentResponseMode: roomMembers.agentResponseMode,
        })
        .from(roomMembers)
        .where(eq(roomMembers.roomId, input.parentRoomId));
      if (!parentMemberRows.some((member) => member.actorId === input.requesterActorId)) {
        throw new MembershipOpError("subthread_not_parent_member");
      }

      let memberRows = parentMemberRows;
      // Open Rooms have one inherited audience; no persisted restricted-child
      // mode exists. Private/group direct callers may still request a subset.
      if (parent.kind !== "open" && input.members && input.members.length > 0) {
        const parentActorSet = new Set(parentMemberRows.map((m) => m.actorId));
        const chosen = new Set(input.members.map((m) => m.actorId));
        for (const aid of chosen) {
          if (!parentActorSet.has(aid)) {
            throw new MembershipOpError(
              "subthread_member_not_in_parent",
              `actor ${aid} is not in parent room ${input.parentRoomId}`,
            );
          }
        }
        memberRows = parentMemberRows.filter((m) => chosen.has(m.actorId));
        if (memberRows.length === 0) {
          throw new MembershipOpError("subthread_invalid_anchor");
        }
      }

      const subLabel =
        (typeof input.label === "string" && input.label.trim().length > 0
          ? input.label.trim()
          : null) ?? parent.label;
      await tx.insert(rooms).values({
        id: subId,
        ownerId: parent.ownerId,
        type: parent.type,
        label: subLabel,
        graphThreadId,
        namespaceId: parent.namespaceId,
        humanActorIds: parent.humanActorIds,
        createdBy: input.requesterActorId,
        kind: "subthread",
        parentRoomId: input.parentRoomId,
        threadRootMessageId: input.anchorMessageId,
      });
      await createRoomJournalStateInTx(tx, subId);

      await tx.insert(roomMembers).values(
        memberRows.map((m) => ({
          roomId: subId,
          actorId: m.actorId,
          roomRole: m.roomRole === "admin" ? "admin" : "member",
          ...(m.agentResponseMode
            ? { agentResponseMode: m.agentResponseMode }
            : {}),
        })),
      );
      await reconcileRoomJournalMembershipInTx(tx, [subId]);
    });
  } catch (err) {
    if (!isPostgresUniqueViolation(err)) throw err;
    const [existing] = await db
      .select({ id: rooms.id, parentRoomId: rooms.parentRoomId })
      .from(rooms)
      .where(
        and(
          eq(rooms.threadRootMessageId, input.anchorMessageId),
          eq(rooms.kind, "subthread"),
        ),
      )
      .limit(1);
    if (!existing) throw err;
    const [membership] = await db
      .select({ actorId: roomMembers.actorId })
      .from(roomMembers)
      .where(
        and(
          eq(roomMembers.roomId, existing.id),
          eq(roomMembers.actorId, input.requesterActorId),
        ),
      )
      .limit(1);
    if (existing.parentRoomId !== input.parentRoomId) {
      throw new MembershipOpError("subthread_not_visible");
    }
    if (!membership) {
      const repaired = await repairOpenParentMemberSubthreads(
        input.parentRoomId,
        input.requesterActorId,
      );
      if (!repaired.roomIds.includes(existing.id) || !repaired.event) {
        throw new MembershipOpError("subthread_not_visible");
      }
      return {
        subthreadRoomId: existing.id,
        repairedMembership: repaired.event,
        repairedSubthreadIds: repaired.roomIds,
      };
    }
    await updateRoomHumanActors(existing.id);
    return { subthreadRoomId: existing.id };
  }

  await updateRoomHumanActors(subId);
  return { subthreadRoomId: subId };
}

/**
 * D111 — list Subthreads under `parentRoomId` visible to `requesterActorId`.
 */
export async function listSubthreadsForRoom(
  parentRoomId: string,
  requesterActorId: string,
): Promise<SubthreadSummary[]> {
  if (!parentRoomId || !requesterActorId) return [];
  const db = getSharedDirectDb();
  const rows = await db
    .select({
      id: rooms.id,
      parentRoomId: rooms.parentRoomId,
      anchorMessageId: rooms.threadRootMessageId,
      label: rooms.label,
      replyCount: sessionMessages.replyCount,
      lastReplyAt: sessionMessages.lastReplyAt,
      createdAt: rooms.createdAt,
    })
    .from(rooms)
    .innerJoin(
      sessionMessages,
      eq(sessionMessages.id, rooms.threadRootMessageId),
    )
    .innerJoin(
      roomMembers,
      and(eq(roomMembers.roomId, rooms.id), eq(roomMembers.actorId, requesterActorId)),
    )
    .where(and(eq(rooms.parentRoomId, parentRoomId), eq(rooms.kind, "subthread")));

  return rows.map((r) => ({
    id: r.id,
    parentRoomId: r.parentRoomId!,
    anchorMessageId: r.anchorMessageId!,
    label: r.label,
    replyCount: r.replyCount,
    lastReplyAt: isoFromDbTimestamp(r.lastReplyAt as Date | string | null),
    createdAt: (r.createdAt ?? new Date()).toISOString(),
  }));
}

export type RenamePrivateRoomForOwnerParams = {
  roomId: string;
  ownerUserId: string;
  requesterActorId: string;
  label: string;
  /** Explicit server-authorized global manager path; membership still applies. */
  allowNonOwner?: boolean;
};

/**
 * D106 — rename a private Room owned by `ownerUserId`, or explicitly admit a
 * server-authorized global Room manager. Both paths still require the
 * requester's Actor membership and keep the paired Namespace label aligned.
 */
export async function renamePrivateRoomForOwner(
  params: RenamePrivateRoomForOwnerParams,
): Promise<RoomDetailPayload | null> {
  const { roomId, ownerUserId, requesterActorId, label, allowNonOwner = false } = params;
  if (!roomId || !ownerUserId || !requesterActorId || !label) return null;

  const db = getSharedDirectDb();
  const [membership] = await db
    .select({ roomId: roomMembers.roomId })
    .from(roomMembers)
    .where(
      and(eq(roomMembers.roomId, roomId), eq(roomMembers.actorId, requesterActorId)),
    )
    .limit(1);
  if (!membership) return null;

  const [room] = await db
    .select({
      id: rooms.id,
      ownerId: rooms.ownerId,
      type: rooms.type,
      namespaceId: rooms.namespaceId,
    })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);
  if (!room) return null;
  if (!allowNonOwner && room.ownerId !== ownerUserId) return null;
  if (room.type !== "private") return null;

  await db.transaction(async (tx) => {
    await tx
      .update(rooms)
      .set({ label, updatedAt: new Date() })
      .where(eq(rooms.id, roomId));
    await tx
      .update(namespaces)
      .set({ label })
      .where(eq(namespaces.id, room.namespaceId));
  });

  return getRoomDetailForMember(roomId, requesterActorId);
}

/**
 * M042B: roster entry for `loadRoomRoster`. Unifies human and agent
 * members behind a single shape so `pre_model` can render a roster
 * block without caring about actor kind.
 *
 * M046: `roomRole` replaces the earlier `role` field — distinct from
 * the Role entity (owner / household / teammate / guest), this is the
 * per-membership admin/non-admin bit sourced from
 * `room_members.room_role`. See REL-RMS-ROL.
 */
export interface RoomParticipant {
  actorId: string;
  kind: "user" | "agent";
  displayName: string;
  /** Canonical mention handle; for agents this matches `agents.handle`. */
  handle?: string | null;
  /** Present iff kind === "user" — `users.id` backing the actor. */
  userId?: string;
  /** Present iff kind === "agent". */
  agentId?: string;
  roomRole: "admin" | "member";
  /**
   * D128 — per-(Room, Agent) reply policy. NULL on `kind === "user"`
   * rows; the trust gate treats NULL on agent rows as `'active'`
   * (legacy default for pre-D128 backfill). See migration 0054.
   */
  agentResponseMode?: AgentResponseMode | null;
  /** D300 — human owner of this agent member (`actors.owner_id`). */
  agentOwnerUserId?: string;
  /** D300 — owner handle from the existing users join. */
  agentOwnerHandle?: string | null;
  /** D300 — owner display name from the existing users join. */
  agentOwnerDisplayName?: string | null;
  /** D300 — profile avatar ref for this agent member. */
  agentAvatar?: AvatarRef | null;
}

/**
 * M042B: load all members of a room as a roster snapshot. Single
 * query; no caching in M042B. Called once per turn at ingress and
 * attached to graph state so pre_model + other nodes can read
 * without touching the DB.
 */
export async function loadRoomRoster(
  roomId: string,
): Promise<RoomParticipant[]> {
  if (!roomId) return [];
  const db = getSharedDirectDb();
  const rows = await db
    .select({
      actorId: actors.id,
      kind: actors.kind,
      displayName: actors.displayName,
      agentId: actors.agentId,
      ownerId: actors.ownerId,
      userHandle: users.handle,
      userDisplayName: users.name,
      agentHandle: agents.handle,
      agentAvatar: profiles.avatarRef,
      roomRole: roomMembers.roomRole,
      agentResponseMode: roomMembers.agentResponseMode,
    })
    .from(roomMembers)
    .innerJoin(actors, eq(roomMembers.actorId, actors.id))
    .leftJoin(users, eq(actors.ownerId, users.id))
    .leftJoin(agents, eq(actors.agentId, agents.id))
    .leftJoin(profiles, eq(profiles.agentId, actors.agentId))
    .where(eq(roomMembers.roomId, roomId));

  return rows.map((r) => {
    const kind: "user" | "agent" = r.kind === "agent" ? "agent" : "user";
    const roomRole: "admin" | "member" =
      r.roomRole === "admin" ? "admin" : "member";
    const participant: RoomParticipant = {
      actorId: r.actorId,
      kind,
      displayName: r.displayName,
      handle: kind === "agent" ? r.agentHandle : r.userHandle,
      roomRole,
    };
    if (kind === "agent" && r.agentId) {
      participant.agentId = r.agentId;
    }
    if (kind === "agent" && r.ownerId) {
      participant.agentOwnerUserId = r.ownerId;
      if (r.userHandle) participant.agentOwnerHandle = r.userHandle;
      if (r.userDisplayName) participant.agentOwnerDisplayName = r.userDisplayName;
    }
    if (kind === "agent" && r.agentAvatar !== undefined) {
      participant.agentAvatar = r.agentAvatar;
    }
    if (kind === "user" && r.ownerId) {
      participant.userId = r.ownerId;
    }
    if (kind === "agent" && r.agentResponseMode != null) {
      participant.agentResponseMode = r.agentResponseMode as AgentResponseMode;
    }
    return participant;
  });
}

// ---------------------------------------------------------------------------
// Role queries
// ---------------------------------------------------------------------------

export async function getRoleCapabilities(
  roleId: string,
): Promise<string[]> {
  const db = getSharedDirectDb();
  const rows = await db
    .select({ slug: capabilities.slug })
    .from(roleCapabilities)
    .innerJoin(
      capabilities,
      eq(roleCapabilities.capabilityId, capabilities.id),
    )
    .where(eq(roleCapabilities.roleId, roleId));
  return rows.map((r) => r.slug);
}

// ---------------------------------------------------------------------------
// M066 — invite / multi-user onboarding queries
// ---------------------------------------------------------------------------

/**
 * Local-origin (`users.server IS NULL`) handle collision probe for
 * invite redemption — 409 `handle_taken` before Logto calls.
 */
export async function findLocalUserByHandle(
  handle: string,
): Promise<{ id: string } | null> {
  const db = getSharedDirectDb();
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.handle, handle), isNull(users.server)))
    .limit(1);
  return row ?? null;
}

/**
 * M128 — Agents the user can manage. Post-M128 there is no per-Agent
 * ownership group; any Human who holds `manage_agents` can manage
 * every Agent on the Server. Returns all Agents ordered by
 * `agents.created_at ASC` for that user, and `[]` for users without
 * the capability (e.g. guests, anonymous).
 *
 * Used by call sites that need "Agents this user can administer" —
 * `/api/agents` admin list, the `manage_agents` mint-authz gate, etc.
 * NOT the right query for "the user's personal Genie" — use
 * `findPersonalAgentsForUser` for that (the post-D201 personal-Genie
 * model still seeds one Agent per Human via the `actors.agent_id`
 * pointer; that ownership is independent of the `manage_agents` cap).
 *
 * The "owned" terminology is kept for backwards-compat at the
 * function name; the post-M128 semantics is "manageable."
 */
export async function findAgentsOwnedByUser(
  userId: string,
): Promise<
  Array<{ agentId: string; handle: string; displayName: string }>
> {
  const caps = await getUserCapabilities(userId);
  if (!caps.includes("manage_agents")) return [];
  const db = getSharedDirectDb();
  return await db
    .select({
      agentId: agents.id,
      handle: agents.handle,
      displayName: sql<string>`COALESCE(${profiles.name}, 'Genie')`,
    })
    .from(agents)
    .leftJoin(profiles, eq(profiles.agentId, agents.id))
    .orderBy(asc(agents.createdAt));
}

/**
 * M128 unify follow-up (2026-05-28) — the user's PERSONAL Agents
 * (one or more), resolved via the `actors` mirror table:
 * `actors.owner_id = userId AND actors.kind = 'agent'`.
 *
 * Post-D201 every Human gets one personal-Genie Agent seeded by
 * `seedPersonalAgentForInviteeInTx` at redeem time; today's invite
 * model produces exactly one row, but the query returns an array
 * so future sub-Agent work can extend it without an API churn.
 *
 * This is the right query whenever a call site needs "MY agent"
 * (resolve-bearer's preferred-agent hint and the client profile
 * view, the invite-form Agent dropdown for a non-admin caller). It
 * does NOT consult capabilities — owning a personal Agent is
 * independent of `manage_agents`, so a `member`-rung Human still
 * sees their own Genie even though they can't administer the
 * server's Agent roster.
 */
export async function findPersonalAgentsForUser(
  userId: string,
): Promise<
  Array<{ agentId: string; handle: string; displayName: string }>
> {
  const db = getSharedDirectDb();
  const rows = await db
    .select({
      agentId: agents.id,
      handle: agents.handle,
      displayName: sql<string>`COALESCE(${profiles.name}, 'Genie')`,
    })
    .from(actors)
    .innerJoin(agents, eq(actors.agentId, agents.id))
    .leftJoin(profiles, eq(profiles.agentId, agents.id))
    .where(and(eq(actors.ownerId, userId), eq(actors.kind, "agent")))
    .orderBy(asc(agents.createdAt));
  return rows;
}

export async function findAllAgents(): Promise<
  Array<{ agentId: string; handle: string; displayName: string }>
> {
  const db = getSharedDirectDb();
  const rows = await db
    .select({
      agentId: agents.id,
      handle: agents.handle,
      displayName: sql<string>`COALESCE(${profiles.name}, 'Genie')`,
    })
    .from(agents)
    .leftJoin(profiles, eq(profiles.agentId, agents.id));
  return rows;
}

export interface InvitableRoomRow {
  roomId: string;
  label: string;
  type: string;
}

/**
 * Rooms whose membership includes the agent's mirror actor. When
 * `ownerScopeUserId` is set (non-admin inviter), restricts to rooms
 * owned by that user.
 */
export async function findRoomsContainingAgent(
  agentId: string,
  opts?: { ownerScopeUserId?: string },
): Promise<InvitableRoomRow[]> {
  const db = getSharedDirectDb();
  const [agentActor] = await db
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.agentId, agentId), eq(actors.kind, "agent")))
    .limit(1);
  if (!agentActor) return [];

  const ownerClause =
    opts?.ownerScopeUserId !== undefined
      ? eq(rooms.ownerId, opts.ownerScopeUserId)
      : undefined;

  return await db
    .select({
      roomId: rooms.id,
      label: rooms.label,
      type: rooms.type,
    })
    .from(rooms)
    .innerJoin(roomMembers, eq(roomMembers.roomId, rooms.id))
    .where(
      ownerClause
        ? and(eq(roomMembers.actorId, agentActor.id), ownerClause)
        : eq(roomMembers.actorId, agentActor.id),
    );
}

// ---------------------------------------------------------------------------
// M068 — agent / room membership management (day-2 ops)
// ---------------------------------------------------------------------------

/** Structured errors for membership rails (M068) + D111 Subthreads. */
export class MembershipOpError extends Error {
  constructor(
    public readonly opCode:
      | "last_owner"
      | "already_member"
      | "room_owner"
      | "subthread_member_not_in_parent"
      | "subthread_anchor_exists"
      | "subthread_invalid_anchor"
      | "subthread_not_parent_member"
      | "subthread_not_visible"
      | "not_member"
      | "not_agent"
      // M124 — public-room self-join / self-leave rails.
      | "not_open"
      | "not_found"
      | "room_owner_last_admin"
      // Community exists for a later enrollment phase but is not yet an
      // assignable Role, directly or through a custom Group.
      | "community_enrollment_unavailable"
      // M258 — hidden access Rooms are immutable authority containers.
      | "access_room_immutable"
      // D194 — visibility flip (open ↔ group only).
      | "invalid_kind_for_visibility",
    message?: string,
  ) {
    super(message ?? opCode);
    this.name = "MembershipOpError";
  }
}

export function assertRoomAllowsDirectMembershipMutation(
  roomKind: string,
): void {
  if (roomKind === "access") {
    throw new MembershipOpError("access_room_immutable");
  }
}

/**
 * D128 — flip `room_members.agent_response_mode` for an agent member.
 *
 * Throws `MembershipOpError("not_member")` if the (room, actor) row
 * doesn't exist, and `MembershipOpError("not_agent")` if the row
 * exists but the actor is `kind = 'user'` (the column is meaningful
 * only on agent rows). Both error codes are surfaced as 4xx by the
 * caller route; neither indicates server fault.
 *
 * Caller must validate manage authorization (owner / server-admin)
 * BEFORE invoking; this function does NOT recheck.
 */
export async function updateRoomMemberAgentResponseMode(
  roomId: string,
  actorId: string,
  mode: AgentResponseMode,
): Promise<void> {
  if (!roomId || !actorId) {
    throw new MembershipOpError("not_member");
  }
  const db = getSharedDirectDb();
  const [row] = await db
    .select({
      actorId: roomMembers.actorId,
      actorKind: actors.kind,
      roomKind: rooms.kind,
    })
    .from(roomMembers)
    .innerJoin(actors, eq(roomMembers.actorId, actors.id))
    .innerJoin(rooms, eq(roomMembers.roomId, rooms.id))
    .where(
      and(eq(roomMembers.roomId, roomId), eq(roomMembers.actorId, actorId)),
    )
    .limit(1);
  if (!row) {
    throw new MembershipOpError("not_member");
  }
  if (row.actorKind !== "agent") {
    throw new MembershipOpError("not_agent");
  }
  await db
    .update(roomMembers)
    .set({ agentResponseMode: mode })
    .where(
      and(eq(roomMembers.roomId, roomId), eq(roomMembers.actorId, actorId)),
    );
  if (mode === "observe" && row.roomKind !== "subthread") {
    await invalidateRespondersForBotInParentChildren(db, {
      parentRoomId: roomId,
      botActorId: actorId,
      reason: "observe",
      now: new Date(),
    });
  }
}

/**
 * D302 P5b — flip `rooms.conductor_mode` for smart routing.
 *
 * Caller must validate manage authorization (owner / server-admin) BEFORE
 * invoking; this function does NOT recheck.
 */
export async function updateRoomConductorMode(
  roomId: string,
  mode: "advanced" | "standard",
): Promise<boolean> {
  if (!roomId) return false;
  const db = getSharedDirectDb();
  const result = await db
    .update(rooms)
    .set({ conductorMode: mode, updatedAt: new Date() })
    .where(eq(rooms.id, roomId))
    .returning({ id: rooms.id });
  return result.length > 0;
}

/**
 * D194 C2 — flip `room_members.room_role` for a human member.
 *
 * Throws `MembershipOpError("not_member")` if the (room, actor) row
 * doesn't exist, and `MembershipOpError("not_agent")` if the row
 * exists but the actor is `kind = 'agent'` (room_role moderation
 * applies only to user rows). Caller must validate manage authorization
 * BEFORE invoking; this function does NOT recheck.
 */
export async function updateRoomMemberRole(
  roomId: string,
  actorId: string,
  role: "admin" | "member",
): Promise<void> {
  if (!roomId || !actorId) {
    throw new MembershipOpError("not_member");
  }
  const db = getSharedDirectDb();
  const [row] = await db
    .select({
      actorId: roomMembers.actorId,
      actorKind: actors.kind,
    })
    .from(roomMembers)
    .innerJoin(actors, eq(roomMembers.actorId, actors.id))
    .where(
      and(eq(roomMembers.roomId, roomId), eq(roomMembers.actorId, actorId)),
    )
    .limit(1);
  if (!row) {
    throw new MembershipOpError("not_member");
  }
  if (row.actorKind !== "user") {
    throw new MembershipOpError("not_agent");
  }
  await db
    .update(roomMembers)
    .set({ roomRole: role })
    .where(
      and(eq(roomMembers.roomId, roomId), eq(roomMembers.actorId, actorId)),
    );
}

/**
 * D194 — flip `rooms.kind` between `open` (public) and `group` (private).
 *
 * Throws `MembershipOpError("not_found")` when the room row is missing,
 * and `MembershipOpError("invalid_kind_for_visibility")` when the current
 * kind is not `open` or `group`. Returns `true` when the kind was updated,
 * `false` when already at the target (idempotent no-op).
 *
 * Caller must validate `manage_rooms` authorization BEFORE invoking.
 */
export async function updateRoomVisibility(
  roomId: string,
  kind: "open" | "group",
): Promise<boolean> {
  if (!roomId) {
    throw new MembershipOpError("not_found");
  }
  const db = getSharedDirectDb();
  const [row] = await db
    .select({ kind: rooms.kind })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);
  if (!row) {
    throw new MembershipOpError("not_found");
  }
  if (row.kind !== "open" && row.kind !== "group") {
    throw new MembershipOpError("invalid_kind_for_visibility");
  }
  if (row.kind === kind) {
    return false;
  }
  await db
    .update(rooms)
    .set({ kind, updatedAt: new Date() })
    .where(eq(rooms.id, roomId));
  return true;
}

// ---------------------------------------------------------------------------
// M128 — server-wide Role catalogue (mirrors permission-model.md §3).
// ---------------------------------------------------------------------------

export type ServerRoleSlug =
  | "owner"
  | "admin"
  | "superuser"
  | "member"
  | "contributor"
  | "community"
  | "guest";

/**
 * Strict-subset ladder rank. Lower = stronger (owner=0, guest=6).
 * Used to compute "highest-rank Role across every Group the Human
 * is in" for the resolver's `actorRole` derivation.
 */
export const SERVER_ROLE_RANK: Record<ServerRoleSlug, number> = {
  owner: 0,
  admin: 1,
  superuser: 2,
  member: 3,
  contributor: 4,
  community: 5,
  guest: 6,
};

/**
 * Map a server-wide Role slug to the canonical Group `type` slug
 * (one Group per Role, per `permission-model.md` §4).
 */
export const SERVER_ROLE_TO_GROUP_TYPE: Record<ServerRoleSlug, string> = {
  owner: "owners",
  admin: "admins",
  superuser: "superusers",
  member: "members",
  contributor: "contributors",
  community: "communities",
  guest: "guests",
};

const M128_CANONICAL_GROUP_TYPES = Object.values(SERVER_ROLE_TO_GROUP_TYPE);

function isServerRoleSlug(slug: string): slug is ServerRoleSlug {
  return slug in SERVER_ROLE_RANK;
}

/**
 * @deprecated M128 — kept as an alias so callers that still type-spell
 * `AgentMemberRoleSlug` typecheck. New code should use
 * `ServerRoleSlug` directly.
 */
export type AgentMemberRoleSlug = ServerRoleSlug;

export type AgentUserRow = {
  userId: string;
  handle: string;
  displayName: string;
  /** Highest-rank Server Role this user holds; `guest` for users with no Group membership. */
  role: ServerRoleSlug;
};

/**
 * M078 — humans visible to the current Agent. Post-M128 there is no
 * per-Agent roster: every Human seated on the Server is visible to
 * every Agent. The `agentId` parameter is unused (kept for the
 * `list_my_users` tool signature backwards-compat). Each user's
 * `role` is their highest-rank Group Role.
 *
 * De-duped by `userId` (a Human in multiple Groups appears once at
 * their best rank). Sorted by rank then handle.
 */
export async function listAgentUsers(agentId: string): Promise<AgentUserRow[]> {
  void agentId;
  const db = getSharedDirectDb();
  const memberRows = await db
    .select({
      userId: groupMembers.userId,
      handle: users.handle,
      displayName: users.name,
      roleSlug: roles.slug,
    })
    .from(groupMembers)
    .innerJoin(groups, eq(groupMembers.groupId, groups.id))
    .innerJoin(groupRoles, eq(groupRoles.groupId, groups.id))
    .innerJoin(roles, eq(groupRoles.roleId, roles.id))
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(inArray(groups.type, [...M128_CANONICAL_GROUP_TYPES]))
    .orderBy(asc(users.handle));

  const merged = new Map<string, AgentUserRow>();
  for (const m of memberRows) {
    const slug = isServerRoleSlug(m.roleSlug) ? m.roleSlug : "guest";
    const candidate: AgentUserRow = {
      userId: m.userId,
      handle: m.handle ?? "",
      displayName: m.displayName,
      role: slug,
    };
    const prev = merged.get(m.userId);
    if (!prev || SERVER_ROLE_RANK[candidate.role] < SERVER_ROLE_RANK[prev.role]) {
      merged.set(m.userId, candidate);
    }
  }

  const list = [...merged.values()];
  list.sort((a, b) => {
    const dr = SERVER_ROLE_RANK[a.role] - SERVER_ROLE_RANK[b.role];
    if (dr !== 0) return dr;
    return a.handle.localeCompare(b.handle);
  });
  return list;
}

/** Normalize handle for roster equality (trim, strip leading @, lowercase). */
export function normalizeHandleForAgentRosterMatch(handle: string): string {
  const t = handle.trim();
  const s = t.startsWith("@") ? t.slice(1) : t;
  return s.toLowerCase();
}

/**
 * M078 — resolve a human on this agent's `list_my_users` roster by handle.
 * Does not hit `findActorByHandle`; use after this passes when you need actor rows.
 */
export async function findAgentUserByNormalizedHandle(
  agentId: string,
  rawHandle: string,
): Promise<AgentUserRow | null> {
  const target = normalizeHandleForAgentRosterMatch(rawHandle);
  if (!target) return null;
  const rows = await listAgentUsers(agentId);
  for (const r of rows) {
    if (normalizeHandleForAgentRosterMatch(r.handle) === target) {
      return r;
    }
  }
  return null;
}

/**
 * M128 — highest-rank Server Role for the user, across every Group
 * they're in. `agentId` is unused (server-wide model); kept for
 * backwards-compat at the call site. Returns `null` if the user is
 * in no Group at all (callers map this to `guest`).
 */
export async function findUserAgentRoleSlug(
  userId: string,
  agentId?: string,
): Promise<ServerRoleSlug | null> {
  void agentId;
  return findUserHighestRoleSlug(userId);
}

/**
 * M128 — canonical helper: highest-rank Role slug across every Group
 * the user is in. Returns `null` when the user has zero Group
 * memberships (anonymous, unknown_sub, or pre-claim dummy). Resolver
 * call sites map `null` → `guest` for the `actorRole` field.
 */
export async function findUserHighestRoleSlug(
  userId: string,
): Promise<ServerRoleSlug | null> {
  const db = getSharedDirectDb();
  const rows = await db
    .select({ slug: roles.slug })
    .from(groupMembers)
    .innerJoin(groups, eq(groupMembers.groupId, groups.id))
    .innerJoin(groupRoles, eq(groupRoles.groupId, groups.id))
    .innerJoin(roles, eq(groupRoles.roleId, roles.id))
    .where(eq(groupMembers.userId, userId));
  if (rows.length === 0) return null;
  let best: ServerRoleSlug | null = null;
  for (const r of rows) {
    const slug = r.slug;
    if (typeof slug !== "string" || !isServerRoleSlug(slug)) continue;
    if (best === null || SERVER_ROLE_RANK[slug] < SERVER_ROLE_RANK[best]) {
      best = slug;
    }
  }
  return best;
}

/**
 * M128 — list every member of one canonical Group (by `groups.id`).
 * Sorted by handle ascending.
 */
export async function listGroupMembers(
  groupId: string,
): Promise<Array<{ userId: string; handle: string; displayName: string; roleSlug: ServerRoleSlug; groupType: string }>> {
  const db = getSharedDirectDb();
  const rows = await db
    .select({
      userId: groupMembers.userId,
      handle: users.handle,
      displayName: users.name,
      roleSlug: roles.slug,
      groupType: groups.type,
    })
    .from(groupMembers)
    .innerJoin(groups, eq(groupMembers.groupId, groups.id))
    .innerJoin(groupRoles, eq(groupRoles.groupId, groups.id))
    .innerJoin(roles, eq(groupRoles.roleId, roles.id))
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(eq(groupMembers.groupId, groupId))
    .orderBy(asc(users.handle));
  return rows.map((r) => ({
    userId: r.userId,
    handle: r.handle ?? "",
    displayName: r.displayName,
    roleSlug: isServerRoleSlug(r.roleSlug) ? r.roleSlug : "guest",
    groupType: r.groupType,
  }));
}

/**
 * M128 — find a canonical Group by its `type` slug. Returns `null`
 * if the Group is missing (fresh DB pre-seed).
 */
export async function findCanonicalGroupByType(
  groupType: string,
): Promise<{ id: string; type: string; label: string; roleSlug: ServerRoleSlug } | null> {
  const db = getSharedDirectDb();
  const [row] = await db
    .select({
      id: groups.id,
      type: groups.type,
      label: groups.label,
      roleSlug: roles.slug,
    })
    .from(groups)
    .innerJoin(groupRoles, eq(groupRoles.groupId, groups.id))
    .innerJoin(roles, eq(groupRoles.roleId, roles.id))
    .where(eq(groups.type, groupType))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    label: row.label,
    roleSlug: isServerRoleSlug(row.roleSlug) ? row.roleSlug : "guest",
    };
}

/**
 * Stack 195 / W3.0.2 — the complete capability bundle granted by a Group:
 * the de-duped union of every Capability across every Role the Group
 * carries via `group_roles` → `role_capabilities`. Returns `null` when
 * the Group does not exist. A Group that exists but whose Roles carry no
 * Capabilities (e.g. the canonical `guests` Group, whose `guest` Role has
 * an empty bundle) returns `{ capabilities: [] }` — existence and bundle
 * emptiness are distinct so the anti-escalation resolver can distinguish
 * "no such Group" from "Group grants nothing".
 *
 * This is the target-side input to the shared anti-escalation resolver
 * (`rbac-anti-escalation.ts`): a mutation on a Group requires the actor to
 * hold `manage_members` AND every Capability in this bundle, so an Admin
 * (who lacks `manage_server_settings` / `manage_server_security`) cannot
 * add to or remove from the `owners` Group whose `owner` Role bundles both.
 */
export async function getGroupCapabilityBundle(
  groupId: string,
): Promise<{
  groupId: string;
  groupType: string;
  capabilities: string[];
} | null> {
  const db = getSharedDirectDb();
  const [group] = await db
    .select({ id: groups.id, type: groups.type })
    .from(groups)
    .where(eq(groups.id, groupId))
    .limit(1);
  if (!group) return null;
  const rows = await db
    .select({ capSlug: capabilities.slug })
    .from(groupRoles)
    .innerJoin(roles, eq(groupRoles.roleId, roles.id))
    .innerJoin(roleCapabilities, eq(roles.id, roleCapabilities.roleId))
    .innerJoin(
      capabilities,
      eq(roleCapabilities.capabilityId, capabilities.id),
    )
    .where(eq(groupRoles.groupId, groupId));
  const bundle = [...new Set(rows.map((r) => r.capSlug))];
  return { groupId: group.id, groupType: group.type, capabilities: bundle };
}

/**
 * M128 — add a Human to a canonical server-wide Group. Idempotent
 * via the (group_id, user_id) PK on `group_members`. `grantedBy` is
 * the audit field; pass the caller's user-actor id when available.
 */
export async function addUserToGroup(
  groupId: string,
  userId: string,
  grantedBy: string | null,
): Promise<void> {
  const db = getSharedDirectDb();
  await db.transaction(async (tx) => {
    const [group] = await tx
      .select({ type: groups.type })
      .from(groups)
      .where(eq(groups.id, groupId))
      .limit(1)
      .for("update");
    const roleRows = await tx
      .select({ slug: roles.slug })
      .from(groupRoles)
      .innerJoin(roles, eq(roles.id, groupRoles.roleId))
      .where(eq(groupRoles.groupId, groupId));
    assertCommunityEnrollmentAvailable(
      group?.type ?? "",
      roleRows.map((row) => row.slug),
    );
    await tx
      .insert(groupMembers)
      .values({ groupId, userId, grantedBy: grantedBy ?? null })
      .onConflictDoNothing({
        target: [groupMembers.groupId, groupMembers.userId],
      });
  });
}

/**
 * Community enrollment stays closed until its complete personal-funding
 * journey ships. The fence follows the effective Role assignment so a custom
 * Group carrying `community` cannot bypass the canonical `communities` Group.
 */
export function assertCommunityEnrollmentAvailable(
  groupType: string,
  roleSlugs: readonly string[],
): void {
  if (groupType === "communities" || roleSlugs.includes("community")) {
    throw new MembershipOpError("community_enrollment_unavailable");
  }
}

/**
 * M128 — remove a Human from a canonical Group. Enforces the
 * last-owners-Group guard: removing the only member of `owners`
 * throws `MembershipOpError("last_owner")` unless
 * `opts.allowLastOwnerBypass` is true.
 */
export async function removeUserFromGroup(
  groupId: string,
  userId: string,
  opts: { allowLastOwnerBypass?: boolean } = {},
): Promise<void> {
  const db = getSharedDirectDb();
  await db.transaction(async (tx) => {
    const [groupRow] = await tx
      .select({ type: groups.type })
      .from(groups)
      .where(eq(groups.id, groupId))
      .limit(1);
    if (!groupRow) {
      throw new MembershipOpError("not_member");
    }
    if (groupRow.type === "owners" && !opts.allowLastOwnerBypass) {
      const locked = await tx
        .select({ userId: groupMembers.userId })
        .from(groupMembers)
        .where(eq(groupMembers.groupId, groupId))
        .for("update");
      if (locked.length === 1 && locked[0]!.userId === userId) {
        throw new MembershipOpError("last_owner");
      }
    }
    await tx
      .delete(groupMembers)
      .where(
        and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)),
      );
  });
}

/**
 * M128 — set a Human's role on the Server by adding them to the
 * canonical Group for that Role and removing them from every other
 * canonical M128 Group. Replaces the pre-M128 per-Agent
 * `addUserToAgentRole`; `agentId` and `agentOwnerUserId` are kept
 * on the signature for the deprecated `/api/agents/:id/members`
 * route shape but ignored. Returns the target Group id and the id of
 * any Group the user was removed from.
 *
 * Enforces the last-owners-Group guard: demoting the sole `owners`
 * member throws `MembershipOpError("last_owner")` unless
 * `opts.allowLastOwnerBypass` is true.
 */
export async function addUserToAgentRole(
  agentId: string,
  agentOwnerUserId: string,
  targetUserId: string,
  newRoleSlug: ServerRoleSlug,
  opts?: { allowLastOwnerBypass?: boolean },
): Promise<{ groupId: string; replacedFromGroupId: string | null }> {
  void agentId;
  void agentOwnerUserId;
  if (!isServerRoleSlug(newRoleSlug)) {
    throw new Error(`addUserToAgentRole: unknown server role slug ${String(newRoleSlug)}`);
  }
  if (newRoleSlug === "community") {
    throw new MembershipOpError("community_enrollment_unavailable");
  }
  const targetGroupType = SERVER_ROLE_TO_GROUP_TYPE[newRoleSlug];
  const db = getSharedDirectDb();
  return await db.transaction(async (tx) => {
    const [targetGroupRow] = await tx
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.type, targetGroupType))
      .limit(1);
    if (!targetGroupRow) {
      throw new Error(
        `addUserToAgentRole: canonical group ${targetGroupType} missing — did seedTrustPersonal run?`,
      );
    }
    const targetGroupId = targetGroupRow.id;

    const existing = await tx
      .select({ groupId: groupMembers.groupId, groupType: groups.type })
      .from(groupMembers)
      .innerJoin(groups, eq(groupMembers.groupId, groups.id))
      .where(
        and(
          eq(groupMembers.userId, targetUserId),
          inArray(groups.type, [...M128_CANONICAL_GROUP_TYPES]),
        ),
      );

    const otherGroups = existing
      .filter((e) => e.groupId !== targetGroupId)
      .map((e) => ({ id: e.groupId, type: e.groupType }));
    const alreadyOnlyTarget =
      existing.length > 0 && existing.every((e) => e.groupId === targetGroupId);

    if (alreadyOnlyTarget) {
      return { groupId: targetGroupId, replacedFromGroupId: null };
    }

    const wasOnlyOwner = otherGroups.some((g) => g.type === "owners");
    if (wasOnlyOwner && newRoleSlug !== "owner" && !opts?.allowLastOwnerBypass) {
      const [ownersRow] = await tx
        .select({ id: groups.id })
        .from(groups)
        .where(eq(groups.type, "owners"))
        .limit(1);
      if (ownersRow) {
        const locked = await tx
          .select({ userId: groupMembers.userId })
          .from(groupMembers)
          .where(eq(groupMembers.groupId, ownersRow.id))
          .for("update");
        if (locked.length === 1 && locked[0]!.userId === targetUserId) {
          throw new MembershipOpError("last_owner");
        }
      }
    }

    let replacedFromGroupId: string | null = null;
    for (const g of otherGroups) {
      await tx
        .delete(groupMembers)
        .where(
          and(eq(groupMembers.groupId, g.id), eq(groupMembers.userId, targetUserId)),
        );
      replacedFromGroupId = replacedFromGroupId ?? g.id;
    }

    const stillInTarget = existing.some((e) => e.groupId === targetGroupId);
    if (!stillInTarget) {
      await tx.insert(groupMembers).values({
        groupId: targetGroupId,
        userId: targetUserId,
      });
    }

    return { groupId: targetGroupId, replacedFromGroupId };
  });
}

/**
 * M128 — remove a Human from the canonical Group for the given Role.
 * `agentId` is unused (server-wide model). Last-owners-Group guard
 * applies when `roleSlug === 'owner'`.
 */
export async function removeUserFromAgentRole(
  agentId: string,
  targetUserId: string,
  roleSlug: ServerRoleSlug,
  opts: { allowLastOwnerBypass?: boolean },
): Promise<{ groupId: string }> {
  void agentId;
  if (!isServerRoleSlug(roleSlug)) {
    throw new Error(`removeUserFromAgentRole: unknown server role slug ${String(roleSlug)}`);
  }
  const groupType = SERVER_ROLE_TO_GROUP_TYPE[roleSlug];
  const db = getSharedDirectDb();
  return await db.transaction(async (tx) => {
    const [groupRow] = await tx
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.type, groupType))
      .limit(1);
    if (!groupRow) {
      throw new Error(
        `removeUserFromAgentRole: canonical group ${groupType} missing — did seedTrustPersonal run?`,
      );
    }
    const groupId = groupRow.id;

    if (groupType === "owners") {
      const locked = await tx
        .select({ userId: groupMembers.userId })
        .from(groupMembers)
        .where(eq(groupMembers.groupId, groupId))
        .for("update");
      if (
        locked.length === 1 &&
        locked[0]!.userId === targetUserId &&
        !opts.allowLastOwnerBypass
      ) {
        throw new MembershipOpError("last_owner");
      }
    }

    await tx
      .delete(groupMembers)
      .where(
        and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, targetUserId)),
      );

    return { groupId };
  });
}

/**
 * D124 P8 — human-readable line for membership system rows.
 */
export function formatRoomMembershipSystemLine(event: RoomMembershipSystemEventPayload): string {
  if (event.kind === "member_added") {
    return `${event.displayName} joined the room`;
  }
  return `${event.displayName} left the room`;
}

async function resolveActorDisplayNameInTx(tx: InviteSeedTx, actorId: string): Promise<string> {
  const [row] = await tx
    .select({ displayName: actors.displayName })
    .from(actors)
    .where(eq(actors.id, actorId))
    .limit(1);
  return row?.displayName?.trim() || "Someone";
}

/**
 * Inserts a SINGLE `role = system` transcript row for a membership change
 * (join / leave), homed in the room owner's canonical session. Skips
 * Subthreads.
 *
 * Write-once is deliberate: the room transcript reader
 * (`getRoomMessagesAcrossMemberSessions`) aggregates `session_messages`
 * across every member's session by `room_id` and only de-dupes `role=user`
 * rows (by fingerprint). This function used to fan out one row per member
 * session, which surfaced the same "X joined the room" line once per human
 * member in the aggregated transcript (e.g. 3 members ⇒ 3 identical lines).
 * One row in any member session — the owner's, which is always present and
 * stable across joins/leaves — is visible to every member exactly once.
 */
async function appendRoomMembershipSystemMessagesInTx(
  tx: InviteSeedTx,
  roomId: string,
  event: RoomMembershipSystemEventPayload,
): Promise<number | undefined> {
  const [roomRow] = await tx
    .select({
      kind: rooms.kind,
      graphThreadId: rooms.graphThreadId,
      ownerId: rooms.ownerId,
    })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);
  if (!roomRow || roomRow.kind === "subthread") {
    return;
  }
  const ownerUserId = roomRow.ownerId;
  if (!ownerUserId) return;

  const threadSeed =
    roomRow.graphThreadId?.trim().length > 0 ? roomRow.graphThreadId.trim() : `room:${roomId}`;
  const content = formatRoomMembershipSystemLine(event);
  const sidecarJson = JSON.stringify(event);

  const existing = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.ownerId, ownerUserId),
        eq(sessions.roomId, roomId),
        sql`${sessions.threadId} NOT LIKE 'subagent:%'`,
      ),
    )
    .orderBy(desc(sessions.startedAt))
    .limit(1);

  let sessionId = existing[0]?.id;
  if (!sessionId) {
    const inserted = await tx
      .insert(sessions)
      .values({
        threadId: threadSeed,
        ownerId: ownerUserId,
        personaId: "owner",
        roomId,
      })
      .returning({ id: sessions.id });
    sessionId = inserted[0]?.id;
  }
  if (!sessionId) return;

  const [message] = await tx.insert(sessionMessages).values({
    sessionId,
    role: "system",
    content,
    toolCalls: sidecarJson,
  }).returning({ id: sessionMessages.id });

  await tx
    .update(sessions)
    .set({
      messageCount: sql`${sessions.messageCount} + 1`,
      endedAt: new Date(),
    })
    .where(eq(sessions.id, sessionId));

  // Only conversational Rooms expose feed occurrences; internal containers
  // keep their existing system-message behavior without producing feed events.
  return roomRow.kind === "task" || roomRow.kind === "access" ? undefined : message?.id;
}

/**
 * M068 — add a human user or an agent actor to a room.
 */
export type RoomHumanAuthoritySnapshot = Readonly<{
  roomId: string;
  namespaceId: string;
  namespaceAccessRevision: number;
  participantHumanActorIds: readonly string[];
}>;

export type HumanRoomMembershipTransitionFact = Readonly<{
  kind: "human_add" | "human_remove";
  targetHumanActorId: string;
  previous: RoomHumanAuthoritySnapshot;
  current: RoomHumanAuthoritySnapshot;
}>;

function roomHumanAuthoritySnapshot(row: Readonly<{
  id: string;
  namespaceId: string;
  namespaceAccessRevision: number;
  humanActorIds: string[];
}>): RoomHumanAuthoritySnapshot {
  return Object.freeze({
    roomId: row.id,
    namespaceId: row.namespaceId,
    namespaceAccessRevision: row.namespaceAccessRevision,
    participantHumanActorIds: Object.freeze([...row.humanActorIds].sort()),
  });
}

async function loadRoomHumanAuthoritySnapshotInTx(
  tx: InviteSeedTx,
  roomId: string,
): Promise<RoomHumanAuthoritySnapshot | null> {
  const [row] = await tx
    .select({
      id: rooms.id,
      namespaceId: rooms.namespaceId,
      namespaceAccessRevision: rooms.namespaceAccessRevision,
      humanActorIds: rooms.humanActorIds,
    })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);
  return row === undefined ? null : roomHumanAuthoritySnapshot(row);
}

export async function addRoomMember(
  roomId: string,
  target: { userId: string } | { agentId: string },
  roomRole: "admin" | "member",
): Promise<{
  actorId: string;
  kind: "user" | "agent";
  membershipEvent?: RoomMembershipSystemEventPayload;
  membershipMessageId?: number;
  humanMembershipTransitions?: readonly HumanRoomMembershipTransitionFact[];
}> {
  const db = getSharedDirectDb();
  return await db.transaction(async (tx) => {
    let actorId: string;
    let kind: "user" | "agent";

    if ("userId" in target) {
      const [row] = await tx
        .select({ id: actors.id })
        .from(actors)
        .where(and(eq(actors.ownerId, target.userId), eq(actors.kind, "user")))
        .limit(1);
      if (!row) {
        throw new Error(`addRoomMember: no user actor for user ${target.userId}`);
      }
      actorId = row.id;
      kind = "user";
    } else {
      const [row] = await tx
        .select({ id: actors.id })
        .from(actors)
        .where(and(eq(actors.agentId, target.agentId), eq(actors.kind, "agent")))
        .limit(1);
      if (!row) {
        throw new Error(`addRoomMember: no agent actor for agent ${target.agentId}`);
      }
      actorId = row.id;
      kind = "agent";
    }

    // M219 — membership transitions share the Room-first lock order with
    // transcript writes and journal claim/publish. This also guarantees the
    // membership system row below cannot allocate a message id first.
    await acquireRoomWriteLock(tx, roomId);

    const [roomMeta] = await tx
      .select({ kind: rooms.kind, parentRoomId: rooms.parentRoomId })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1);
    if (!roomMeta) {
      throw new Error(`addRoomMember: unknown room ${roomId}`);
    }
    assertRoomAllowsDirectMembershipMutation(roomMeta.kind);

    if (roomMeta.kind === "subthread" && roomMeta.parentRoomId) {
      const [inParent] = await tx
        .select({ actorId: roomMembers.actorId })
        .from(roomMembers)
        .where(
          and(
            eq(roomMembers.roomId, roomMeta.parentRoomId),
            eq(roomMembers.actorId, actorId),
          ),
        )
        .limit(1);
      if (!inParent) {
        throw new MembershipOpError(
          "subthread_member_not_in_parent",
          `actor ${actorId} is not in parent room ${roomMeta.parentRoomId}`,
        );
      }
    }

    const [existing] = await tx
      .select({ actorId: roomMembers.actorId })
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.actorId, actorId)))
      .limit(1);
    if (existing) {
      throw new MembershipOpError("already_member");
    }

    const previousHumanSnapshot = kind === "user"
        && roomMeta.kind !== "subthread"
      ? await loadRoomHumanAuthoritySnapshotInTx(tx, roomId)
      : null;

    let agentResponseMode: AgentResponseMode | undefined;
    if (kind === "agent") {
      const memberKindRows = await tx
        .select({ kind: actors.kind })
        .from(roomMembers)
        .innerJoin(actors, eq(roomMembers.actorId, actors.id))
        .where(eq(roomMembers.roomId, roomId));
      const postAddMembers: Array<{ kind: "user" | "agent" }> = [
        ...memberKindRows.map((r) => ({ kind: r.kind as "user" | "agent" })),
        { kind: "agent" },
      ];
      agentResponseMode = defaultAgentResponseModeAtMint(postAddMembers) ?? undefined;
    }

    await tx.insert(roomMembers).values({
      roomId,
      actorId,
      roomRole,
      ...(agentResponseMode ? { agentResponseMode } : {}),
    });

    if (kind === "user") {
      await updateRoomHumanActorsInTx(tx, roomId);
    }

    const affectedRoomIds = [roomId];
    if (roomMeta.kind !== "subthread") {
      const childRooms = (await tx
        .select({ id: rooms.id })
        .from(rooms)
        .where(
          and(eq(rooms.parentRoomId, roomId), eq(rooms.kind, "subthread")),
        )).sort((a, b) => a.id.localeCompare(b.id));
      for (const { id: childId } of childRooms) {
        // Parent is already locked; lock propagated child Rooms in stable id
        // order before mutating each membership.
        await acquireRoomWriteLock(tx, childId);
        const [exChild] = await tx
          .select({ actorId: roomMembers.actorId })
          .from(roomMembers)
          .where(and(eq(roomMembers.roomId, childId), eq(roomMembers.actorId, actorId)))
          .limit(1);
        if (!exChild) {
          await tx.insert(roomMembers).values({
            roomId: childId,
            actorId,
            roomRole,
            ...(agentResponseMode ? { agentResponseMode } : {}),
          });
          if (kind === "user") {
            await updateRoomHumanActorsInTx(tx, childId);
          }
          affectedRoomIds.push(childId);
        }
      }
    }

    let membershipMessageId: number | undefined;
    let membershipEvent: RoomMembershipSystemEventPayload | undefined;
    if (roomMeta.kind !== "subthread") {
      const displayName = await resolveActorDisplayNameInTx(tx, actorId);
      membershipEvent = {
        kind: "member_added",
        actorId,
        actorKind: kind,
        displayName,
      };
      membershipMessageId = await appendRoomMembershipSystemMessagesInTx(tx, roomId, membershipEvent);
    }

    await reconcileRoomJournalMembershipInTx(tx, affectedRoomIds);

    const currentHumanSnapshot = previousHumanSnapshot === null
      ? null
      : await loadRoomHumanAuthoritySnapshotInTx(tx, roomId);
    const humanMembershipTransitions = previousHumanSnapshot !== null
        && currentHumanSnapshot !== null
      ? [Object.freeze({
        kind: "human_add" as const,
        targetHumanActorId: actorId,
        previous: previousHumanSnapshot,
        current: currentHumanSnapshot,
      })]
      : [];

    return {
      actorId,
      kind,
      ...(membershipEvent ? { membershipEvent } : {}),
      ...(membershipMessageId === undefined ? {} : { membershipMessageId }),
      ...(humanMembershipTransitions.length > 0
        ? { humanMembershipTransitions: Object.freeze(humanMembershipTransitions) }
        : {}),
    };
  });
}

/**
 * M068 — remove a room member by actor id (human or agent).
 */
export async function removeRoomMember(
  roomId: string,
  actorId: string,
  opts: { allowOrphanBypass?: boolean },
): Promise<{
  kind: "user" | "agent";
  membershipEvent?: RoomMembershipSystemEventPayload;
  membershipMessageId?: number;
  humanMembershipTransitions?: readonly HumanRoomMembershipTransitionFact[];
}> {
  const db = getSharedDirectDb();
  return await db.transaction(async (tx) => {
    // M219 — lock before reading/mutating membership or appending the
    // membership system row. Journal reconciliation will use this same
    // transaction boundary.
    await acquireRoomWriteLock(tx, roomId);

    const [roomRow] = await tx
      .select({ ownerId: rooms.ownerId, kind: rooms.kind })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1);
    if (!roomRow) {
      throw new Error(`removeRoomMember: unknown room ${roomId}`);
    }
    assertRoomAllowsDirectMembershipMutation(roomRow.kind);

    const [mem] = await tx
      .select({ actorId: roomMembers.actorId })
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.actorId, actorId)))
      .limit(1);
    if (!mem) {
      throw new Error(`removeRoomMember: actor ${actorId} is not in room ${roomId}`);
    }

    const ownerActor = await tx
      .select({ id: actors.id })
      .from(actors)
      .where(and(eq(actors.ownerId, roomRow.ownerId), eq(actors.kind, "user")))
      .limit(1);

    if (
      ownerActor[0]?.id === actorId &&
      !opts.allowOrphanBypass
    ) {
      throw new MembershipOpError("room_owner");
    }

    const [actorRow] = await tx
      .select({ kind: actors.kind })
      .from(actors)
      .where(eq(actors.id, actorId))
      .limit(1);
    if (!actorRow) {
      throw new Error(`removeRoomMember: unknown actor ${actorId}`);
    }
    const kind: "user" | "agent" = actorRow.kind === "agent" ? "agent" : "user";

    const displayName = await resolveActorDisplayNameInTx(tx, actorId);

    const childRooms = await tx
      .select({ id: rooms.id })
      .from(rooms)
      .where(and(eq(rooms.parentRoomId, roomId), eq(rooms.kind, "subthread")));
    if (childRooms.length > 0) {
      const childIds = childRooms.map((c) => c.id).sort();
      for (const childId of childIds) {
        // Parent is already locked; lock child Rooms deterministically before
        // the cascade delete and journal reconciliation.
        await acquireRoomWriteLock(tx, childId);
      }
      await tx
        .delete(roomMembers)
        .where(
          and(eq(roomMembers.actorId, actorId), inArray(roomMembers.roomId, childIds)),
        );
      if (kind === "user") {
        for (const cid of childIds) {
          await updateRoomHumanActorsInTx(tx, cid);
        }
      }
      if (kind === "agent" && roomRow.kind !== "subthread") {
        await invalidateSubthreadResponders(tx, {
          subthreadRoomIds: childIds,
          botActorId: actorId,
          reason: "parent_membership_removed",
          now: new Date(),
        });
      }
    }

    const previousHumanSnapshot = kind === "user"
        && roomRow.kind !== "subthread"
      ? await loadRoomHumanAuthoritySnapshotInTx(tx, roomId)
      : null;

    await tx
      .delete(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.actorId, actorId)));

    if (kind === "user") {
      await updateRoomHumanActorsInTx(tx, roomId);
    }

    let membershipMessageId: number | undefined;
    let membershipEvent: RoomMembershipSystemEventPayload | undefined;
    if (roomRow.kind !== "subthread") {
      membershipEvent = {
        kind: "member_removed",
        actorId,
        actorKind: kind,
        displayName,
      };
      membershipMessageId = await appendRoomMembershipSystemMessagesInTx(tx, roomId, membershipEvent);
    }

    await reconcileRoomJournalMembershipInTx(tx, [
      roomId,
      ...childRooms.map((child) => child.id),
    ]);

    const currentHumanSnapshot = previousHumanSnapshot === null
      ? null
      : await loadRoomHumanAuthoritySnapshotInTx(tx, roomId);
    const humanMembershipTransitions = previousHumanSnapshot !== null
        && currentHumanSnapshot !== null
      ? [Object.freeze({
        kind: "human_remove" as const,
        targetHumanActorId: actorId,
        previous: previousHumanSnapshot,
        current: currentHumanSnapshot,
      })]
      : [];

    return {
      kind,
      ...(membershipEvent ? { membershipEvent } : {}),
      ...(membershipMessageId === undefined ? {} : { membershipMessageId }),
      ...(humanMembershipTransitions.length > 0
        ? { humanMembershipTransitions: Object.freeze(humanMembershipTransitions) }
        : {}),
    };
  });
}

export type CreateRoomMemberInput = { kind: "user" | "agent"; id: string };

export class CreateRoomReachabilityError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "user_not_reachable"
      | "agent_not_reachable"
      | "user_not_found"
      | "agent_not_found",
    public readonly memberKind: "user" | "agent",
    public readonly memberId: string,
  ) {
    super(message);
    this.name = "CreateRoomReachabilityError";
  }
}

/**
 * D543 — validate an exact new-Room roster against the Server's social and
 * delegation boundaries.
 *
 * Every active local Human is reachable by every authenticated local Human;
 * an existing shared Room is deliberately not a prerequisite. Disabled and
 * federated identities remain outside this Server-local directory.
 *
 * Every Server Genie is socially reachable by callers with `invoke_agents`.
 * Ownership protects identity, loyalty, customization, and private state; it
 * does not make a Genie unavailable to the rest of the Server.
 *
 * Throws `CreateRoomReachabilityError` on the first violation; the route maps
 * reachability denial to 403 and missing entities to 404.
 */
export async function assertCanCreateRoomMembers(args: {
  callerUserId: string;
  members: CreateRoomMemberInput[];
  isAdmin: boolean;
}): Promise<void> {
  const { callerUserId, members } = args;
  const db = getSharedDirectDb();

  for (const m of members) {
    if (m.kind === "user") {
      if (m.id === callerUserId) continue;
      const [row] = await db
        .select({ id: users.id, server: users.server, disabledAt: users.disabledAt })
        .from(users)
        .where(eq(users.id, m.id))
        .limit(1);
      if (!row) {
        throw new CreateRoomReachabilityError(
          `User not found: ${m.id}`,
          "user_not_found",
          "user",
          m.id,
        );
      }
      if (row.server !== null || row.disabledAt !== null) {
        throw new CreateRoomReachabilityError(
          `User not reachable: ${m.id}`,
          "user_not_reachable",
          "user",
          m.id,
        );
      }
    } else {
      const [row] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, m.id))
        .limit(1);
      if (!row) {
        throw new CreateRoomReachabilityError(
          `Agent not found: ${m.id}`,
          "agent_not_found",
          "agent",
          m.id,
        );
      }
      if (!(await userHasCapability(callerUserId, "invoke_agents"))) {
        throw new CreateRoomReachabilityError(
          `Agent not reachable: ${m.id}`,
          "agent_not_reachable",
          "agent",
          m.id,
        );
      }
    }
  }
}

/**
 * M068 — users whose human actor is not in `room_members` for this room.
 */
export async function listAddableUsersForRoom(
  roomId: string,
  opts?: { forAdmin?: boolean },
): Promise<Array<{ userId: string; handle: string; displayName: string }>> {
  const db = getSharedDirectDb();
  const humanInRoom = await db
    .select({ actorId: actors.id })
    .from(roomMembers)
    .innerJoin(actors, eq(roomMembers.actorId, actors.id))
    .where(and(eq(roomMembers.roomId, roomId), eq(actors.kind, "user")));

  const occupiedActorIds = humanInRoom.map((r) => r.actorId);

  const parts = [];
  if (!opts?.forAdmin) parts.push(isNull(users.server));
  if (occupiedActorIds.length > 0) {
    parts.push(
      sql`${actors.id} NOT IN (${sql.join(
        occupiedActorIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  }
  const whereClause = parts.length === 0 ? sql`true` : parts.length === 1 ? parts[0]! : and(...parts);

  const rows = await db
    .select({
      userId: users.id,
      handle: users.handle,
      displayName: users.name,
    })
    .from(users)
    .innerJoin(actors, and(eq(actors.ownerId, users.id), eq(actors.kind, "user")))
    .where(whereClause)
    .orderBy(asc(users.handle));

  return rows.map((r) => ({
    userId: r.userId,
    handle: r.handle ?? "",
    displayName: r.displayName,
  }));
}

/**
 * D543 — Server-wide Human directory for new conversations. All authenticated
 * callers see every other active local Human, independent of Role and prior
 * Room overlap. Disabled, federated, and self identities are excluded.
 */
export async function listDirectoryHumans(
  callerUserId: string,
  _opts: { isAdmin: boolean },
): Promise<Array<{ userId: string; handle: string; displayName: string }>> {
  const db = getSharedDirectDb();
  const rows = await db
    .select({
      userId: users.id,
      handle: users.handle,
      displayName: users.name,
    })
    .from(users)
    .where(
      and(
        isNull(users.server),
        isNull(users.disabledAt),
        sql`${users.id} <> ${callerUserId}`,
      ),
    )
    .orderBy(asc(users.handle));
  return rows.map((r) => ({
    userId: r.userId,
    handle: r.handle ?? "",
    displayName: r.displayName,
  }));
}

/**
 * D187 (Stack 129) — unified directory search for the "New conversation"
 * member picker. Returns humans + agents in one recency-ranked list so the
 * client picker no longer has to load the whole directory and sort locally.
 *
 * Recency is DERIVED — no new table, no new write-path. For a given
 * (caller, target) pair:
 *
 *     last_contact_at = MAX(session_messages.created_at)
 *
 * over rooms where BOTH the caller's human actor and the target's actor are
 * members, excluding rooms with `kind IN ('task','access')` (non-conversational
 * containers — same exclusion `listRoomsForActor` applies). Mirrors the
 * `lastMessageAt` derivation in `listRoomsForActor` (MAX over session_messages
 * grouped by sessions.room_id), just constrained to shared rooms.
 *
 * Scoping:
 *   - Human side: every active local Human, excluding self.
 *   - Genie side: basic identity for every Genie. Every Genie is actionable
 *     when the caller has `invoke_agents`; ownership is not a social boundary.
 *
 * Ordering: `lastContactAt DESC NULLS LAST, handle ASC`. With `q` empty this
 * is the "recent contacts" seed; with `q` non-empty it's a case-insensitive
 * substring match on `handle`, `displayName`, and `id`.
 */
export type DirectorySearchResult = {
  kind: "user" | "agent";
  id: string;
  handle: string;
  displayName: string;
  agentOwnerUserId?: string;
  agentOwnerHandle?: string | null;
  agentOwnerDisplayName?: string | null;
  lastContactAt: string | null;
  actionable: boolean;
  actionReason: "available" | "invoke_agents_required";
};

export async function searchDirectory(
  callerUserId: string,
  opts: {
    isAdmin: boolean;
    q: string;
    kind: "user" | "agent" | "both";
    limit: number;
    offset: number;
    agentScope?: "owned";
    canInvokeAgents?: boolean;
  },
): Promise<DirectorySearchResult[]> {
  const q = (opts.q ?? "").trim();
  const limit = Math.max(1, Math.min(50, Math.floor(opts.limit)));
  const offset = Math.max(0, Math.floor(opts.offset));
  const db = getSharedDirectDb();
  const results: DirectorySearchResult[] = [];

  if (opts.kind === "user" || opts.kind === "both") {
    const userRows = await db.execute<{
      id: string;
      handle: string | null;
      display_name: string | null;
      last_contact_at: Date | string | null;
    }>(sql`
      WITH caller_recency AS (
        SELECT rm_t.actor_id AS target_actor_id,
               MAX(sm.created_at) AS last_contact_at
        FROM room_members rm_t
        INNER JOIN room_members rm_c ON rm_t.room_id = rm_c.room_id
        INNER JOIN actors a_c ON rm_c.actor_id = a_c.id
        INNER JOIN rooms r ON r.id = rm_t.room_id
        INNER JOIN sessions s ON s.room_id = r.id
        INNER JOIN session_messages sm ON sm.session_id = s.id
        WHERE a_c.owner_id = ${callerUserId}
          AND a_c.kind = 'user'
          AND r.kind NOT IN ('task', 'access')
        GROUP BY rm_t.actor_id
      )
      SELECT u.id AS id,
             u.handle AS handle,
             u.name AS display_name,
             cr.last_contact_at AS last_contact_at
      FROM users u
      INNER JOIN actors a ON a.owner_id = u.id AND a.kind = 'user'
      LEFT JOIN caller_recency cr ON cr.target_actor_id = a.id
      WHERE u.server IS NULL
        AND u.disabled_at IS NULL
        AND u.id <> ${callerUserId}
        AND (
          ${q}::text = ''
          OR u.handle ILIKE '%' || ${q} || '%'
          OR u.name ILIKE '%' || ${q} || '%'
          OR u.id::text ILIKE '%' || ${q} || '%'
        )
      ORDER BY cr.last_contact_at DESC NULLS LAST, u.handle ASC
      LIMIT ${limit} OFFSET ${offset}
    `);
    for (const r of userRows) {
      results.push({
        kind: "user",
        id: r.id,
        handle: r.handle ?? "",
        displayName: r.display_name ?? "",
        lastContactAt: isoFromDbTimestamp(r.last_contact_at),
        actionable: true,
        actionReason: "available",
      });
    }
  }

  if (opts.kind === "agent" || opts.kind === "both") {
    const agentRows = await db.execute<{
      id: string;
      handle: string | null;
      display_name: string | null;
      owner_user_id: string | null;
      owner_handle: string | null;
      owner_display_name: string | null;
      last_contact_at: Date | string | null;
    }>(sql`
      WITH caller_recency AS (
        SELECT rm_t.actor_id AS target_actor_id,
               MAX(sm.created_at) AS last_contact_at
        FROM room_members rm_t
        INNER JOIN room_members rm_c ON rm_t.room_id = rm_c.room_id
        INNER JOIN actors a_c ON rm_c.actor_id = a_c.id
        INNER JOIN rooms r ON r.id = rm_t.room_id
        INNER JOIN sessions s ON s.room_id = r.id
        INNER JOIN session_messages sm ON sm.session_id = s.id
        WHERE a_c.owner_id = ${callerUserId}
          AND a_c.kind = 'user'
          AND r.kind NOT IN ('task', 'access')
        GROUP BY rm_t.actor_id
      ),
      agent_recency AS (
        SELECT a.agent_id AS agent_id,
               MAX(cr.last_contact_at) AS last_contact_at
        FROM caller_recency cr
        INNER JOIN actors a ON a.id = cr.target_actor_id AND a.kind = 'agent'
        GROUP BY a.agent_id
      )
      SELECT ag.id AS id,
             ag.handle AS handle,
             COALESCE(p.name, 'Genie') AS display_name,
             owner_user.id AS owner_user_id,
             owner_user.handle AS owner_handle,
             owner_user.name AS owner_display_name,
             ar.last_contact_at AS last_contact_at
      FROM agents ag
      LEFT JOIN agent_recency ar ON ar.agent_id = ag.id
      LEFT JOIN profiles p ON p.agent_id = ag.id
      LEFT JOIN actors owner_actor
        ON owner_actor.agent_id = ag.id AND owner_actor.kind = 'agent'
      LEFT JOIN users owner_user ON owner_user.id = owner_actor.owner_id
      WHERE (${opts.agentScope !== "owned"}::boolean OR EXISTS (
          SELECT 1 FROM actors a
          WHERE a.agent_id = ag.id
            AND a.kind = 'agent'
            AND a.owner_id = ${callerUserId}
        ))
      AND (
        ${q}::text = ''
        OR ag.handle ILIKE '%' || ${q} || '%'
        OR COALESCE(p.name, 'Genie') ILIKE '%' || ${q} || '%'
        OR ag.id::text ILIKE '%' || ${q} || '%'
      )
      ORDER BY ar.last_contact_at DESC NULLS LAST, ag.handle ASC
      LIMIT ${limit} OFFSET ${offset}
    `);
    for (const r of agentRows) {
      const actionable = opts.canInvokeAgents === true;
      results.push({
        kind: "agent",
        id: r.id,
        handle: r.handle ?? "",
        displayName: r.display_name ?? "",
        ...(r.owner_user_id ? { agentOwnerUserId: r.owner_user_id } : {}),
        agentOwnerHandle: r.owner_handle,
        agentOwnerDisplayName: r.owner_display_name,
        lastContactAt: isoFromDbTimestamp(r.last_contact_at),
        actionable,
        actionReason: actionable ? "available" : "invoke_agents_required",
      });
    }
  }

  // For `both`, merge the two per-side pages into one recency-ranked list.
  // Each side already applied its own LIMIT/OFFSET, so the merge re-sorts
  // the union and trims to `limit`. This means true global OFFSET paging
  // across the merged stream is approximate at page boundaries (a side may
  // contribute fewer than `limit` rows when its page is exhausted). For the
  // picker use-case (typeahead, small pages) this is fine; callers needing
  // strict global paging should query a single side via `kind=user|agent`.
  if (opts.kind === "both") {
    results.sort((a, b) => {
      const aT = a.lastContactAt ? Date.parse(a.lastContactAt) : NaN;
      const bT = b.lastContactAt ? Date.parse(b.lastContactAt) : NaN;
      const aHas = Number.isFinite(aT);
      const bHas = Number.isFinite(bT);
      if (aHas && bHas) {
        if (aT !== bT) return bT - aT;
      } else if (aHas && !bHas) {
        return -1;
      } else if (!aHas && bHas) {
        return 1;
      }
      return a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0;
    });
    return results.slice(0, limit);
  }

  return results;
}

/**
 * M068 — agents whose mirror actor is not in `room_members` for this room.
 */
export async function listAddableAgentsForRoom(
  roomId: string,
  callerUserId: string,
): Promise<
  Array<{
    agentId: string;
    handle: string;
    displayName: string;
    agentOwnerUserId?: string;
    agentOwnerHandle?: string | null;
    agentOwnerDisplayName?: string | null;
  }>
> {
  if (!(await userHasCapability(callerUserId, "invoke_agents"))) return [];
  const db = getSharedDirectDb();
  const inRoom = await db
    .select({ agentId: actors.agentId })
    .from(roomMembers)
    .innerJoin(actors, eq(roomMembers.actorId, actors.id))
    .where(
      and(
        eq(roomMembers.roomId, roomId),
        eq(actors.kind, "agent"),
        isNotNull(actors.agentId),
      ),
    );

  const occupied = inRoom.map((r) => r.agentId).filter((id): id is string => id !== null);

  const whereClause = occupied.length > 0
    ? sql`${agents.id} NOT IN (${sql.join(occupied.map((id) => sql`${id}`), sql`, `)})`
    : undefined;

  const rows = await db
    .select({
      agentId: agents.id,
      handle: agents.handle,
      displayName: sql<string>`COALESCE(${profiles.name}, 'Genie')`,
      agentOwnerUserId: users.id,
      agentOwnerHandle: users.handle,
      agentOwnerDisplayName: users.name,
    })
    .from(agents)
    .leftJoin(profiles, eq(profiles.agentId, agents.id))
    .leftJoin(actors, and(eq(actors.agentId, agents.id), eq(actors.kind, "agent")))
    .leftJoin(users, eq(users.id, actors.ownerId))
    .where(whereClause)
    .orderBy(asc(agents.handle));

  return rows.map((r) => ({
    agentId: r.agentId,
    handle: r.handle,
    displayName: r.displayName,
    ...(r.agentOwnerUserId ? { agentOwnerUserId: r.agentOwnerUserId } : {}),
    agentOwnerHandle: r.agentOwnerHandle,
    agentOwnerDisplayName: r.agentOwnerDisplayName,
  }));
}

/**
 * M076 — Returns the Room and Namespace for the canonical agent+owner
 * private 1:1: exactly two members (the memory owner's human actor + agent
 * mirror actor), `human_actor_ids` cardinality 1 matching that human.
 * `rooms.owner_id` is not part of the contract (a room may be provisioned
 * under another household user but still be the 1:1 private lane for this
 * owner+agent pair).
 *
 * Used by `cascadeMemoriesOnNamespaceDelete` to re-home orphaned memories.
 */
export async function findAgentOwnerPrivateRoom(
  ownerId: string,
  agentId: string,
): Promise<{ roomId: string; namespaceId: string } | null> {
  const db = getSharedDirectDb();
  const [human] = await db
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.ownerId, ownerId), eq(actors.kind, "user")))
    .limit(1);
  if (!human) return null;

  const [room] = await db
    .select({ roomId: rooms.id, namespaceId: rooms.namespaceId })
    .from(rooms)
    .innerJoin(roomMembers, eq(roomMembers.roomId, rooms.id))
    .innerJoin(actors, eq(actors.id, roomMembers.actorId))
    .groupBy(rooms.id, rooms.namespaceId, rooms.humanActorIds)
    .having(sql`
      count(*) = 2
      and count(*) filter (
        where ${actors.kind} = 'agent' and ${actors.agentId} = ${agentId}
      ) = 1
      and count(*) filter (
        where ${actors.kind} = 'user' and ${actors.id} = ${human.id}
      ) = 1
      and cardinality(${rooms.humanActorIds}) = 1
      and ${rooms.humanActorIds}[1] = ${human.id}
    `)
    .limit(1);

  return room ?? null;
}

// ---------------------------------------------------------------------------
// M080 — Ephemeral agent scopes (speaker-keyed memory bags)
// ---------------------------------------------------------------------------

/**
 * M080 — resolve the **current speaker's** users.id from the
 * envelope's actorId. This is NOT envelope.ownerId (which is the
 * deployment owner). Returns null when actorId is empty or the
 * actor is not a user-kind row.
 */
export async function resolveSpeakerUserId(
  envelope: Pick<MemoryAccessEnvelope, "actorId"> | null | undefined,
): Promise<string | null> {
  const actorId = envelope?.actorId;
  if (!actorId) return null;
  const db = getSharedDirectDb();
  const [row] = await db
    .select({ ownerId: actors.ownerId, kind: actors.kind })
    .from(actors)
    .where(eq(actors.id, actorId))
    .limit(1);
  if (!row || row.kind !== "user") return null;
  return row.ownerId;
}

export type ScopeRow = {
  scopeId: string;
  name: string;
  purpose: string | null;
  memoryCount: number;
  createdAt: Date;
};

export async function createScope(params: {
  parentAgentId: string;
  speakerUserId: string;
  name: string;
  purpose?: string;
}): Promise<{ scopeId: string; name: string } | { error: "name_exists" }> {
  const db = getSharedDirectDb();
  try {
    const [row] = await db
      .insert(agentScopes)
      .values({
        parentAgentId: params.parentAgentId,
        speakerUserId: params.speakerUserId,
        name: params.name,
        purpose: params.purpose,
      })
      .returning({ scopeId: agentScopes.id, name: agentScopes.name });
    if (!row) throw new Error("create_scope: insert returned no row");
    return { scopeId: row.scopeId, name: row.name };
  } catch (err) {
    if (isPostgresUniqueViolation(err)) {
      return { error: "name_exists" };
    }
    throw err;
  }
}

export async function findScopes(params: {
  parentAgentId: string;
  speakerUserId: string;
  nameQuery?: string;
}): Promise<ScopeRow[]> {
  const db = getSharedDirectDb();
  const raw = params.nameQuery?.trim() ?? "";
  const stripped = raw.replace(/[%_\\]/g, "");
  const nameClause =
    raw.length === 0
      ? sql`true`
      : stripped.length > 0
        ? ilike(agentScopes.name, `%${stripped}%`)
        : sql`false`;

  const scopeRows = await db
    .select({
      scopeId: agentScopes.id,
      name: agentScopes.name,
      purpose: agentScopes.purpose,
      createdAt: agentScopes.createdAt,
    })
    .from(agentScopes)
    .where(
      and(
        eq(agentScopes.parentAgentId, params.parentAgentId),
        eq(agentScopes.speakerUserId, params.speakerUserId),
        nameClause,
      ),
    )
    .orderBy(desc(agentScopes.createdAt))
    .limit(50);

  if (scopeRows.length === 0) return [];

  const ids = scopeRows.map((r) => r.scopeId);
  const countRows = await db
    .select({
      scopeId: memoryScopes.scopeId,
      n: count(memoryScopes.memoryId),
    })
    .from(memoryScopes)
    .where(inArray(memoryScopes.scopeId, ids))
    .groupBy(memoryScopes.scopeId);

  const countMap = new Map<string, number>();
  for (const c of countRows) {
    countMap.set(c.scopeId, Number(c.n));
  }

  return scopeRows.map((r) => ({
    scopeId: r.scopeId,
    name: r.name,
    purpose: r.purpose,
    createdAt: r.createdAt,
    memoryCount: countMap.get(r.scopeId) ?? 0,
  }));
}

export async function getScopeForSpeaker(params: {
  scopeId: string;
  parentAgentId: string;
  speakerUserId: string;
}): Promise<ScopeRow | null> {
  const scopeDb = getSharedDirectAgentDb();
  return await withTrustContext(
    { userId: params.speakerUserId, agentId: params.parentAgentId },
    async (tx) => {
      const conn = tx as unknown as typeof agentDb;
      const [scope] = await conn
        .select({
          scopeId: agentScopes.id,
          name: agentScopes.name,
          purpose: agentScopes.purpose,
          createdAt: agentScopes.createdAt,
        })
        .from(agentScopes)
        .where(
          and(
            eq(agentScopes.id, params.scopeId),
            eq(agentScopes.parentAgentId, params.parentAgentId),
            eq(agentScopes.speakerUserId, params.speakerUserId),
          ),
        )
        .limit(1);
      if (!scope) return null;

      const [agg] = await conn
        .select({ n: count(memoryScopes.memoryId) })
        .from(memoryScopes)
        .where(eq(memoryScopes.scopeId, params.scopeId));

      return {
        scopeId: scope.scopeId,
        name: scope.name,
        purpose: scope.purpose,
        createdAt: scope.createdAt,
        memoryCount: Number(agg?.n ?? 0),
      };
    },
    scopeDb,
  );
}

export async function closeScope(params: {
  scopeId: string;
  parentAgentId: string;
  speakerUserId: string;
  /**
   * M084 — room namespace to attach scope-authored memories before the
   * scope row is deleted. Required when any `memory_scopes.origin = 'scope'`
   * rows exist for this scope.
   */
  promoteToNamespaceId?: string | null;
}): Promise<
  | {
      closed: true;
      name: string;
      promotedMemoryCount: number;
      targetNamespaceId: string | null;
    }
  | { error: "not_found" | "promote_blocked_missing_namespace" }
> {
  const db = getSharedDirectDb();
  const [scopeRow] = await db
    .select({ id: agentScopes.id, name: agentScopes.name })
    .from(agentScopes)
    .where(
      and(
        eq(agentScopes.id, params.scopeId),
        eq(agentScopes.parentAgentId, params.parentAgentId),
        eq(agentScopes.speakerUserId, params.speakerUserId),
      ),
    )
    .limit(1);
  if (!scopeRow) return { error: "not_found" };

  const toPromote = await db
    .select({ memoryId: memoryScopes.memoryId })
    .from(memoryScopes)
    .where(
      and(eq(memoryScopes.scopeId, params.scopeId), eq(memoryScopes.origin, "scope")),
    );

  const promoteNs = params.promoteToNamespaceId?.trim() ?? "";
  if (toPromote.length > 0 && !promoteNs) {
    return { error: "promote_blocked_missing_namespace" };
  }

  for (const row of toPromote) {
    await db
      .insert(memoryNamespaces)
      .values({ memoryId: row.memoryId, namespaceId: promoteNs })
      .onConflictDoNothing();
  }

  const [deleted] = await db
    .delete(agentScopes)
    .where(
      and(
        eq(agentScopes.id, params.scopeId),
        eq(agentScopes.parentAgentId, params.parentAgentId),
        eq(agentScopes.speakerUserId, params.speakerUserId),
      ),
    )
    .returning({ name: agentScopes.name });

  if (!deleted) return { error: "not_found" };

  return {
    closed: true,
    name: deleted.name,
    promotedMemoryCount: toPromote.length,
    targetNamespaceId: toPromote.length > 0 ? promoteNs : null,
  };
}

/**
 * D124 — best-effort presence bump; callers should fire-and-forget.
 */
export async function bumpLastSeen(userId: string): Promise<void> {
  const db = getSharedDirectDb();
  await db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, userId));
}

/**
 * D124 — read-side counterpart to {@link bumpLastSeen}. Returns the
 * stored `users.last_seen_at` for `userId`, or `null` when the user
 * does not exist OR has no recorded presence yet (the route handler
 * intentionally does not distinguish — see `users-presence.ts`).
 */
export async function getUserLastSeenAt(userId: string): Promise<Date | null> {
  const db = getSharedDirectDb();
  const [row] = await db
    .select({ lastSeenAt: users.lastSeenAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.lastSeenAt ?? null;
}

/**
 * M121 — Defense-in-depth check that a message belongs to the given room.
 */
export async function isMessageInRoom(args: {
  messageId: number;
  roomId: string;
}): Promise<boolean> {
  const { messageId, roomId } = args;
  if (!Number.isFinite(messageId) || !roomId) return false;
  const db = getSharedDirectDb();
  const [row] = await db
    .select({ id: sessionMessages.id })
    .from(sessionMessages)
    .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
    .where(and(eq(sessionMessages.id, messageId), eq(sessions.roomId, roomId)))
    .limit(1);
  return Boolean(row);
}

/**
 * M121 — Resolve a reactable room message from a loose, agent-friendly anchor.
 *
 * Both anchors are OPTIONAL because the agent usually can't produce an exact
 * timestamp: the message that triggered its turn arrives as the live turn
 * input (no bracketed `[…Z]` line to copy), so it tends to approximate
 * wall-clock time (observed off-by-2s in practice). Targeting therefore:
 *
 * - `authorHandle` given → restrict to that author's messages (user-kind
 *   matches `role='user'` on the author's owned sessions; agent-kind matches
 *   `role='assistant'` on the author's agent sessions). The author must be a
 *   member of the room. `null` → any reactable author.
 * - `atIso` given → pick the message whose *second-truncated* timestamp is
 *   CLOSEST to `atIso` (ties → most recent), within a ±5min sanity window, so
 *   a small clock approximation still lands on the right message. `null` /
 *   omitted → the MOST RECENT reactable message (handles "react to what was
 *   just said to me").
 *
 * Only `transcript_origin='main'` rows with `role IN ('user','assistant')` are
 * reactable. Returns the message id or `null` when nothing matches.
 */
export async function resolveRoomMessageByAuthorAndTime(args: {
  roomId: string;
  authorHandle: string | null;
  atIso?: string | null;
  /**
   * M121 fix — the caller agent's own agentId. When the anchor is
   * unspecified (no `authorHandle`), the "most recent reactable message"
   * must NOT resolve to the caller's OWN turn: by the time `react` runs
   * inside an agent turn, that agent's assistant row (often an empty
   * tool-call-only turn) is already the newest row in the room, so a
   * naive `ORDER BY created_at DESC` self-targets. Excluding the caller's
   * agent messages makes the omitted-anchor case target the message the
   * agent is actually replying to (the triggering user/peer message).
   */
  excludeCallerAgentId?: string | null;
}): Promise<number | null> {
  const { roomId, authorHandle } = args;
  const atIso = args.atIso ?? null;
  const excludeCallerAgentId = args.excludeCallerAgentId ?? null;
  if (!roomId) return null;
  const db = getSharedDirectDb();
  let authorshipCond: SQL | undefined;
  if (authorHandle) {
    const found = await findActorByHandle(authorHandle);
    if (!found) return null;

    // Verify the author is a member of this room + fetch kind/owner/agent.
    const [author] = await db
      .select({
        kind: actors.kind,
        ownerId: actors.ownerId,
        agentId: actors.agentId,
      })
      .from(roomMembers)
      .innerJoin(actors, eq(actors.id, roomMembers.actorId))
      .where(
        and(
          eq(roomMembers.roomId, roomId),
          eq(roomMembers.actorId, found.actorId),
        ),
      )
      .limit(1);
    if (!author) return null;

    const cond =
      author.kind === "agent"
        ? author.agentId
          ? and(
              eq(sessionMessages.role, "assistant"),
              eq(sessions.agentId, author.agentId),
            )
          : undefined
        : and(
            eq(sessionMessages.role, "user"),
            eq(sessions.ownerId, author.ownerId),
          );
    if (!cond) return null;
    authorshipCond = cond;
  }

  const reactableRole = sql`${sessionMessages.role} IN ('user', 'assistant')`;
  // Empty turns are not reactable: an agent's tool-call-only assistant
  // row carries empty content and must never be the resolved target
  // (it renders no bubble client-side, so a reaction on it is invisible).
  const nonEmptyContent = sql`length(btrim(${sessionMessages.content})) > 0`;
  // When the caller didn't name an author, never self-target the caller
  // agent's own messages (see excludeCallerAgentId docs above). An
  // explicit `authorHandle` is an intentional target, so honor it as-is.
  const notCallerOwn =
    !authorHandle && excludeCallerAgentId
      ? sql`NOT (${sessionMessages.role} = 'assistant' AND ${sessions.agentId} = ${excludeCallerAgentId})`
      : undefined;
  const conds: (SQL | undefined)[] = [
    eq(sessions.roomId, roomId),
    eq(sessionMessages.transcriptOrigin, "main"),
    // M143 — never let a Task report-back synthetic row be reactable.
    // NULL-safe (see getRoomMessagesAcrossMemberSessions note).
    sql`(${sessionMessages.metadata}->>'originatedBy') IS DISTINCT FROM 'task' AND (${sessionMessages.metadata}->>'originatedBy') IS DISTINCT FROM 'connected_web_operation'`,
    reactableRole,
    nonEmptyContent,
    authorshipCond,
    notCallerOwn,
  ];
  const whereCond = and(...conds.filter((c): c is SQL => c !== undefined));

  const query = db
    .select({ id: sessionMessages.id })
    .from(sessionMessages)
    .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId));

  if (atIso) {
    // Nearest message at SECOND granularity (ties → most recent), bounded to
    // a ±5min window so a wild clock guess can't match a stale message.
    const [row] = await query
      .where(
        and(
          whereCond,
          sql`${sessionMessages.createdAt} BETWEEN ${atIso}::timestamptz - interval '5 minutes' AND ${atIso}::timestamptz + interval '5 minutes'`,
        ),
      )
      .orderBy(
        sql`abs(extract(epoch from (date_trunc('second', ${sessionMessages.createdAt}) - ${atIso}::timestamptz)))`,
        desc(sessionMessages.createdAt),
        desc(sessionMessages.id),
      )
      .limit(1);
    return row ? Number(row.id) : null;
  }

  const [row] = await query
    .where(whereCond)
    .orderBy(desc(sessionMessages.createdAt), desc(sessionMessages.id))
    .limit(1);
  return row ? Number(row.id) : null;
}

// ---------------------------------------------------------------------------
// M213 — canonical principal + RBAC read models (Phase 1–2 foundation)
// ---------------------------------------------------------------------------

export type {
  CanonicalPrincipal,
  PersonalAgentSnapshot,
  RbacGroupChip,
  RbacMembershipFoldRow,
  RbacProjection,
  RoleRankMap,
  WorkbenchChannelBindingCandidate,
  WorkbenchChannelBinding,
} from "./m213-read-models.ts";
export {
  M213_WORKBENCH_CHANNEL,
  bindingForCanonicalFederatedId,
  dedupeCapabilitySlugs,
  deepFreeze,
  foldGroupChipsFromMembershipRows,
  foldRbacProjection,
  freezeCanonicalPrincipal,
  pickHighestRoleSlug,
} from "./m213-read-models.ts";

import {
  M213_WORKBENCH_CHANNEL,
  bindingForCanonicalFederatedId,
  foldRbacProjection,
  freezeCanonicalPrincipal,
  type CanonicalPrincipal,
  type PersonalAgentSnapshot,
  type RbacProjection,
} from "./m213-read-models.ts";

/**
 * M213 — resolve a Logto `sub` to the canonical identity principal in a
 * bounded two-query read set. Returns `null` for an unknown subject (no
 * `users.external_id` row). Throws on actor invariant violation or DB failure.
 * The workbench binding join is constrained to the exact canonical
 * `@handle@server` identity, so another/stale workbench identity for the same
 * user cannot establish verification. Does not JIT-provision and does not fall
 * back to bootstrap identity.
 */
export async function resolveCanonicalPrincipalByLogtoSub(
  logtoSub: string,
): Promise<CanonicalPrincipal | null> {
  if (!logtoSub) return null;

  const db = getSharedDirectDb();
  const localServer = getServerHostname();
  const [identityRow] = await db
    .select({
      userId: users.id,
      disabledAt: users.disabledAt,
      handle: users.handle,
      displayName: users.name,
      server: users.server,
      actorId: actors.id,
      actorDisplayName: actors.displayName,
      workbenchExternalId: channelIdentities.externalId,
      workbenchVerifiedAt: channelIdentities.verifiedAt,
    })
    .from(users)
    .leftJoin(
      actors,
      and(eq(actors.ownerId, users.id), eq(actors.kind, "user")),
    )
    .leftJoin(
      channelIdentities,
      and(
        eq(channelIdentities.userId, users.id),
        eq(channelIdentities.channel, M213_WORKBENCH_CHANNEL),
        eq(
          channelIdentities.externalId,
          sql<string>`'@' || ${users.handle} || '@' || COALESCE(${users.server}, ${localServer})`,
        ),
      ),
    )
    .where(eq(users.externalId, logtoSub))
    .limit(1);

  if (!identityRow) return null;

  if (!identityRow.actorId || !identityRow.actorDisplayName) {
    throw new Error(
      `User ${identityRow.userId} has external_id=${logtoSub} but no user-kind actor row — invariant violated`,
    );
  }

  const actorId = identityRow.actorId;
  const actorDisplayName = identityRow.actorDisplayName;

  let personalAgent: PersonalAgentSnapshot | null = null;
  const [agentRow] = await db
    .select({
      agentId: agents.id,
      handle: agents.handle,
      displayName: sql<string>`COALESCE(${profiles.name}, 'Genie')`,
    })
    .from(actors)
    .innerJoin(agents, eq(actors.agentId, agents.id))
    .leftJoin(profiles, eq(profiles.agentId, agents.id))
    .where(
      and(eq(actors.ownerId, identityRow.userId), eq(actors.kind, "agent")),
    )
    .orderBy(asc(agents.createdAt))
    .limit(1);
  if (agentRow) {
    personalAgent = {
      agentId: agentRow.agentId,
      handle: agentRow.handle,
      displayName: agentRow.displayName,
    };
  }

  const federatedId = identityRow.handle
    ? composeFederatedId(
        identityRow.handle,
        identityRow.server ?? localServer,
      )
    : "";
  const workbenchChannelBinding = bindingForCanonicalFederatedId(federatedId, {
    externalId: identityRow.workbenchExternalId,
    verifiedAt: identityRow.workbenchVerifiedAt,
  });

  return freezeCanonicalPrincipal({
    logtoSub,
    userId: identityRow.userId,
    disabledAt: identityRow.disabledAt,
    actorId,
    actorDisplayName,
    handle: identityRow.handle,
    displayName: identityRow.displayName,
    server: identityRow.server,
    federatedId,
    workbenchChannelBinding,
    personalAgent,
  });
}

/**
 * M213 — server-wide RBAC projection for a principal's `userId` in one
 * joined query. Capabilities are returned as raw server slugs (no browser
 * filtering). Group chips collapse many-to-many Group→Role rows to each
 * Group's highest-rank Role via `SERVER_ROLE_RANK`.
 */
export async function projectUserRbac(userId: string): Promise<RbacProjection> {
  if (!userId) {
    return foldRbacProjection([], SERVER_ROLE_RANK);
  }

  const db = getSharedDirectDb();
  const rows = await db
    .select({
      groupId: groups.id,
      groupType: groups.type,
      groupLabel: groups.label,
      roleSlug: roles.slug,
      capabilitySlug: capabilities.slug,
    })
    .from(groupMembers)
    .innerJoin(groups, eq(groupMembers.groupId, groups.id))
    .innerJoin(groupRoles, eq(groupRoles.groupId, groups.id))
    .innerJoin(roles, eq(groupRoles.roleId, roles.id))
    .leftJoin(roleCapabilities, eq(roles.id, roleCapabilities.roleId))
    .leftJoin(
      capabilities,
      eq(roleCapabilities.capabilityId, capabilities.id),
    )
    .where(eq(groupMembers.userId, userId));

  return foldRbacProjection(rows, SERVER_ROLE_RANK);
}

/**
 * M308 — the signed-in Human's current widest readable Namespace union.
 *
 * A singleton Human audience is the canonical lower bound for every Room the
 * Human currently belongs to. Reusing the subset resolver preserves private,
 * shared, joined-public, and revocation behavior without inventing a second
 * membership rule for personal projections.
 */
export async function findCurrentReadableNamespacesForHumanActor(
  humanActorId: string,
): Promise<string[]> {
  if (!humanActorId) return [];
  return findReadableNamespacesForSubset([humanActorId]);
}
