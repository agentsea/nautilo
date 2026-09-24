import {
  accessRevision,
  compareUnsignedUtf8,
  fingerprintNamespaceGenerationAudience,
  humanId,
  namespaceId,
  type AccessRevision,
  type CryptoDeviceId,
  type DomainKeyClass,
  type HumanId,
  type NamespaceId,
  type NamespaceKeyGeneration,
} from "@nautilo/lattice-crypto";
import { BACKGROUND_REFLECTION_MAX_NAMESPACES_V2 } from "@nautilo/lattice-crypto/background";
import { isProtectedTopLevelRoomKind } from "../../message/protected-room-topology.ts";
import type {
  PostgresJsBridgeConnection,
  PostgresJsBridgeRow,
} from "@nautilo/db";
import { and, asc, eq, inArray, isNull, sql, moderationEffectiveHumanActorIdsSql, actors, roomMembers, rooms as roomsTable } from "@nautilo/db";
import {
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
} from "../message/postgres-conversation-product-store.ts";

import { readableNamespacePolicyAllows } from "./namespace-readable-policy.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export class NamespaceKeyPublicationAuthorityDriftError extends Error {
  constructor() {
    super("Namespace key publication authority drifted");
    this.name = "NamespaceKeyPublicationAuthorityDriftError";
  }
}

export type HumanPeerNamespaceWriteAuthorityResult =
  | Readonly<{
      status: "ready";
      subjectHumanId: HumanId;
      committerDeviceId: CryptoDeviceId;
      committerDeviceSigningKeyGeneration: number;
      committerDeviceRevision: number;
      committerDeviceSigningPublicKey: Uint8Array;
      namespaceId: NamespaceId;
      namespaceAccessRevision: AccessRevision;
      namespaceKeyGeneration: NamespaceKeyGeneration;
      namespaceHeadDigest: Uint8Array;
      namespacePublicationDigest: Uint8Array;
      namespacePublicationSetDigest: Uint8Array;
      namespaceAudienceFingerprint: Uint8Array;
      participantHumanCount: number;
      protectedParticipantHumanCount: number;
      plaintextParticipantHumanCount: number;
      protectedRecipientDeviceCount: number;
    }>
  | Readonly<{
      status: "unavailable";
      reason:
        | "device_unavailable"
        | "namespace_unavailable"
        | "recipient_sync_required";
    }>;

/** Byte-identical authority evidence, selected from the AI generation. */
export type SharedAgentNamespaceWriteAuthorityResult =
  HumanPeerNamespaceWriteAuthorityResult;

declare const snapshotBrand: unique symbol;
export type NamespaceProductAuthoritySnapshot = Readonly<{
  [snapshotBrand]: true;
}>;

export type NamespaceProductAuthoritySetEntry = Readonly<{
  namespaceId: NamespaceId;
  authority: NamespaceProductAuthoritySnapshot;
}>;

type Snapshot = Readonly<{
  roomId: string;
  namespaceId: NamespaceId;
  accessRevision: AccessRevision;
  participantHumanIds: readonly HumanId[];
  audienceFingerprint: Uint8Array;
  subjectHumanId: HumanId;
}>;

const snapshots = new WeakMap<object, Snapshot>();

function number(row: PostgresJsBridgeRow, key: string): number {
  const raw = row[key];
  const value = typeof raw === "bigint"
    ? Number(raw)
    : typeof raw === "string" && /^(?:0|[1-9]\d*)$/u.test(raw)
    ? Number(raw)
    : raw;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`Namespace key authority ${key} is invalid`);
  }
  return value as number;
}

function text(row: PostgresJsBridgeRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Namespace key authority ${key} is invalid`);
  }
  return value;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function canonicalHumans(values: readonly string[]): readonly HumanId[] {
  if (
    values.length < 1
  ) {
    throw new TypeError("Namespace key participant inventory is invalid");
  }
  const canonical = values.map(humanId).sort(compareUnsignedUtf8);
  if (canonical.some((value, index) =>
    index > 0 && value === canonical[index - 1]
  )) throw new TypeError("Namespace key participant inventory is invalid");
  return Object.freeze(canonical);
}

function effectiveAudience(row: PostgresJsBridgeRow, key: string, canonical: readonly HumanId[], subject: string): readonly HumanId[] | null {
  const values = row[key];
  if (!Array.isArray(values) || values.length === 0 || values.some(value => typeof value !== "string")) return null;
  const effective = canonicalHumans(values as string[]);
  if (!effective.includes(humanId(subject)) || effective.some(value => !canonical.includes(value))) return null;
  return effective;
}

function snapshotOf(
  handle: NamespaceProductAuthoritySnapshot,
): Snapshot {
  const value = snapshots.get(handle);
  if (value === undefined) {
    throw new TypeError("Namespace key product authority is not authentic");
  }
  return value;
}

/**
 * Restricted same-callback view used by the Domain Key V2 repository.
 * The opaque handle remains authentic only while the product transaction and
 * its Room/membership locks are held. Returned bytes are detached copies.
 * This is intentionally not exported from the package root.
 */
export function inspectNamespaceProductAuthoritySnapshot(
  handle: NamespaceProductAuthoritySnapshot,
): Readonly<{
  roomId: string;
  namespaceId: NamespaceId;
  accessRevision: AccessRevision;
  participantHumanIds: readonly HumanId[];
  audienceFingerprint: Uint8Array;
  subjectHumanId: HumanId;
}> {
  const snapshot = snapshotOf(handle);
  return Object.freeze({
    roomId: snapshot.roomId,
    namespaceId: snapshot.namespaceId,
    accessRevision: snapshot.accessRevision,
    participantHumanIds: Object.freeze([...snapshot.participantHumanIds]),
    audienceFingerprint: snapshot.audienceFingerprint.slice(),
    subjectHumanId: snapshot.subjectHumanId,
  });
}

/**
 * Holds the canonical Room and membership rows while a restricted callback
 * plans or publishes. Product locks are always acquired before crypto locks.
 */
export class PostgresNamespaceProductAuthority {
  constructor(
    private readonly product: PostgresJsBridgeConnection,
  ) {}

  async withCurrentPrivateRoom<Value>(input: Readonly<{
    subjectUserId: string;
    subjectHumanId: string;
    roomId: string;
    namespaceId: string;
    use: (
      snapshot: NamespaceProductAuthoritySnapshot,
    ) => Promise<Value>;
  }>): Promise<Value | null> {
    if (
      !UUID.test(input.subjectUserId)
      || !UUID.test(input.subjectHumanId)
      || !UUID.test(input.roomId)
      || !UUID.test(input.namespaceId)
    ) throw new TypeError("Namespace key product coordinates are invalid");
    return this.product.transactionOnce(async (transaction) => {
      const rooms = await transaction.query(
        `/* m290_namespace_key_product_room */
         SELECT r.id::text AS room_id, r.namespace_id::text AS namespace_id,
                r.kind, r.parent_room_id, r.archived_at,
                r.namespace_access_revision,
                r.human_actor_ids::text[] AS human_actor_ids,
                public.moderation_effective_humans(r.human_actor_ids, r.id)::text[] AS effective_human_actor_ids,
                a.owner_id::text AS subject_user_id
           FROM rooms r
           JOIN actors a ON a.id = $2::uuid AND a.kind = 'user'
          WHERE r.id = $1::uuid AND r.namespace_id = $3::uuid
          LIMIT 2 FOR UPDATE OF r, a`,
        [input.roomId, input.subjectHumanId, input.namespaceId],
      );
      if (rooms.length !== 1) return null;
      const room = rooms[0]!;
      const members = await transaction.query(
        `/* m290_namespace_key_product_members */
         SELECT member.actor_id::text AS actor_id, actor.kind
           FROM room_members member
           JOIN actors actor ON actor.id = member.actor_id
          WHERE member.room_id = $1::uuid
          ORDER BY member.actor_id
          FOR UPDATE OF member`,
        [input.roomId],
      );
      const humans = canonicalHumans(members
        .filter((member) => member["kind"] === "user")
        .map((member) => text(member, "actor_id")));
      const agents = members.filter((member) => member["kind"] === "agent");
      const storedHumans = room["human_actor_ids"];
      if (
        text(room, "room_id") !== input.roomId
        || text(room, "namespace_id") !== input.namespaceId
        || room["kind"] !== "private"
        || room["parent_room_id"] !== null
        || room["archived_at"] !== null
        || text(room, "subject_user_id") !== input.subjectUserId
        || humans.length !== 1
        || agents.length !== 1
        || humans[0] !== input.subjectHumanId
        || !Array.isArray(storedHumans)
        || storedHumans.length !== humans.length
        || storedHumans.some((value, index) => value !== humans[index])
      ) return null;
      const effectiveHumans = effectiveAudience(room, "effective_human_actor_ids", humans, input.subjectHumanId);
      if (effectiveHumans === null) return null;
      const audienceFingerprint =
        fingerprintNamespaceGenerationAudience(effectiveHumans);
      const handle = Object.freeze({}) as NamespaceProductAuthoritySnapshot;
      snapshots.set(handle, Object.freeze({
        roomId: input.roomId,
        namespaceId: namespaceId(input.namespaceId),
        accessRevision: accessRevision(number(room, "namespace_access_revision")),
        participantHumanIds: effectiveHumans,
        audienceFingerprint,
        subjectHumanId: humanId(input.subjectHumanId),
      }));
      try {
        return await input.use(handle);
      } finally {
        snapshots.delete(handle);
        audienceFingerprint.fill(0);
      }
    }, { isolationLevel: "serializable" });
  }

  /**
   * Stable-roster Human-only authority. Keep this topology gate additive: the
   * one-Human/one-Agent callback remains an independently qualified topology.
   */
  async withCurrentHumanOnlyRoom<Value>(input: Readonly<{
    subjectUserId: string;
    subjectHumanId: string;
    roomId: string;
    namespaceId: string;
    use: (
      snapshot: NamespaceProductAuthoritySnapshot,
    ) => Promise<Value>;
  }>): Promise<Value | null> {
    return this.#withCurrentMultiHumanRoom(input, "human_only");
  }

  /** M296 stable-roster closed multi-Human/single-Agent write authority. */
  async withCurrentSharedAgentRoom<Value>(input: Readonly<{
    subjectUserId: string;
    subjectHumanId: string;
    roomId: string;
    namespaceId: string;
    recipientAgentId: string;
    use: (
      snapshot: NamespaceProductAuthoritySnapshot,
    ) => Promise<Value>;
  }>): Promise<Value | null> {
    return this.#withCurrentMultiHumanRoom(input, "shared_agent");
  }

  /**
   * M298 topology-neutral authority for any supported top-level Room containing
   * at least one Human and at least one Agent. Agent identity remains product
   * routing state and is deliberately absent from this content authority.
   */
  async withCurrentHumanAiReadableRoom<Value>(input: Readonly<{
    subjectUserId: string;
    subjectHumanId: string;
    roomId: string;
    namespaceId: string;
    use: (
      snapshot: NamespaceProductAuthoritySnapshot,
    ) => Promise<Value>;
  }>): Promise<Value | null> {
    return this.#withCurrentHumanReadableSourceRoom(input, true);
  }

  /** Exact Human Namespace read authority; unlike Message AI-readable
   * authority this admits Human-only Rooms while retaining the same locked
   * source/parent, membership, actor-owner, and roster verification. */
  async withCurrentHumanNamespaceRoom<Value>(input: Readonly<{
    subjectUserId: string;
    subjectHumanId: string;
    roomId: string;
    namespaceId: string;
    use: (snapshot: NamespaceProductAuthoritySnapshot) => Promise<Value>;
  }>): Promise<Value | null> {
    return this.#withCurrentHumanReadableSourceRoom(input, false);
  }

  /** Complete Human authority for background work across exact top-level
   * Namespace owners. Unlike foreground source-audience delivery, no source
   * Room stands in for the other Rooms. Output exposure remains a separate
   * product check under this transaction. No Agent identity is required.
   */
  async withCurrentHumanNamespaceSet<Value>(input: Readonly<{
    subjectUserId: string;
    subjectHumanId: string;
    coordinates: readonly Readonly<{ roomId: string; namespaceId: string }>[];
    use(entries: readonly NamespaceProductAuthoritySetEntry[]): Promise<Value>;
  }>): Promise<Value | null> {
    const coordinates = input.coordinates;
    if (!UUID.test(input.subjectUserId) || !UUID.test(input.subjectHumanId)
      || !Array.isArray(coordinates as unknown) || coordinates.length < 1
      || coordinates.length > BACKGROUND_REFLECTION_MAX_NAMESPACES_V2
      || coordinates.some((entry, index) => !UUID.test(entry.roomId)
        || !UUID.test(entry.namespaceId)
        || (index > 0 && coordinates[index - 1]!.namespaceId >= entry.namespaceId))
      || new Set(coordinates.map(entry => entry.roomId)).size !== coordinates.length) {
      throw new TypeError("Background Namespace authority coordinates are invalid");
    }
    // Copy caller-owned coordinates before crossing asynchronous boundaries.
    const expected = coordinates.map(entry => ({...entry}));
    const subjectUserId = input.subjectUserId;
    const subjectHumanId = humanId(input.subjectHumanId);
    return this.product.transactionOnce(async transaction => {
      const roomIds = expected.map(entry => entry.roomId).sort();
      const rows = await executeTypedConversationProductQuery(transaction,
        conversationProductTypedDb.select({
          room_id: sql<string>`${roomsTable.id}`.as("room_id"),
          namespace_id: roomsTable.namespaceId,
          kind: roomsTable.kind,
          parent_room_id: roomsTable.parentRoomId,
          archived_at: roomsTable.archivedAt,
          namespace_access_revision: roomsTable.namespaceAccessRevision,
          human_actor_ids: roomsTable.humanActorIds,
          effective_human_actor_ids: moderationEffectiveHumanActorIdsSql(sql`${roomsTable.humanActorIds}`, sql`${roomsTable.id}`).as("effective_human_actor_ids"),
        }).from(roomsTable)
          .where(sql`${roomsTable.id} = ANY(${sql.param(roomIds)}::uuid[])`)
          .orderBy(sql`${roomsTable.parentRoomId} nulls first`, asc(roomsTable.id))
          .for("update", {of: roomsTable}));
      if (rows.length !== expected.length) return null;
      const byNamespace = new Map(rows.map(row => [row.namespace_id, row]));
      if (byNamespace.size !== expected.length || expected.some(entry => {
        const row = byNamespace.get(entry.namespaceId);
        return row === undefined || row.room_id !== entry.roomId
          || row.parent_room_id !== null || row.archived_at !== null
          || !["private", "group", "open", "access"].includes(row.kind);
      })) return null;
      const owner = await executeTypedConversationProductQuery(transaction,
        conversationProductTypedDb.select({owner_id: actors.ownerId})
          .from(actors).where(and(eq(actors.id, subjectHumanId), eq(actors.kind, "user")))
          .for("update", {of: actors}));
      if (owner.length !== 1 || owner[0]!.owner_id !== subjectUserId) return null;
      const members = await executeTypedConversationProductQuery(transaction,
        conversationProductTypedDb.select({
          room_id: roomMembers.roomId,
          actor_id: roomMembers.actorId,
          kind: actors.kind,
        }).from(roomMembers).innerJoin(actors, eq(actors.id, roomMembers.actorId))
          .where(sql`${roomMembers.roomId} = ANY(${sql.param(roomIds)}::uuid[])`)
          .orderBy(asc(roomMembers.roomId), asc(roomMembers.actorId))
          .for("update", {of: roomMembers}));
      const humansByRoom = new Map<string, string[]>();
      for (const member of members) {
        if (member.kind !== "user") continue;
        const humans = humansByRoom.get(member.room_id) ?? [];
        humans.push(member.actor_id);
        humansByRoom.set(member.room_id, humans);
      }
      const entries: NamespaceProductAuthoritySetEntry[] = [];
      const fingerprints: Uint8Array[] = [];
      try {
        for (const coordinate of expected) {
          const row = byNamespace.get(coordinate.namespaceId)!;
          const humans = canonicalHumans(humansByRoom.get(coordinate.roomId) ?? []);
          const stored = row.human_actor_ids;
          if (!humans.includes(subjectHumanId) || !Array.isArray(stored)
            || stored.length !== humans.length
            || stored.some((value, index) => value !== humans[index])) return null;
          const effectiveHumans = effectiveAudience(row, "effective_human_actor_ids", humans, subjectHumanId);
          if (effectiveHumans === null) return null;
          const audienceFingerprint = fingerprintNamespaceGenerationAudience(effectiveHumans);
          fingerprints.push(audienceFingerprint);
          const authority = Object.freeze({}) as NamespaceProductAuthoritySnapshot;
          snapshots.set(authority, Object.freeze({
            roomId: coordinate.roomId,
            namespaceId: namespaceId(coordinate.namespaceId),
            accessRevision: accessRevision(number(row, "namespace_access_revision")),
            participantHumanIds: effectiveHumans, audienceFingerprint, subjectHumanId,
          }));
          entries.push(Object.freeze({namespaceId: namespaceId(coordinate.namespaceId), authority}));
        }
        return await input.use(Object.freeze(entries));
      } finally {
        entries.forEach(entry => snapshots.delete(entry.authority));
        fingerprints.forEach(bytes => bytes.fill(0));
      }
    }, {isolationLevel: "serializable"});
  }

  /** Protected Message topology classified under the same locked membership snapshot.
   * Existing mappings retain their own class; this class is only for new allocation.
   */
  async withCurrentMessageRepairRoom<Value>(input: Readonly<{
    subjectUserId: string;
    subjectHumanId: string;
    roomId: string;
    namespaceId: string;
    use: (snapshot: NamespaceProductAuthoritySnapshot, targetKeyClass: "ai" | "human") => Promise<Value>;
  }>): Promise<Value | null> {
    return this.#withCurrentHumanReadableSourceRoom(input, false, true);
  }

  async #withCurrentHumanReadableSourceRoom<Value>(input: Readonly<{
    subjectUserId: string;
    subjectHumanId: string;
    roomId: string;
    namespaceId: string;
    use: (snapshot: NamespaceProductAuthoritySnapshot, targetKeyClass: "ai" | "human") => Promise<Value>;
  }>, requireAgent: boolean, protectedMessageOnly = false): Promise<Value | null> {
    if (
      !UUID.test(input.subjectUserId)
      || !UUID.test(input.subjectHumanId)
      || !UUID.test(input.roomId)
      || !UUID.test(input.namespaceId)
    ) throw new TypeError("Namespace key product coordinates are invalid");
    return this.product.transactionOnce(async (transaction) => {
      const candidateRows = await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.select({
          source_room_id: roomsTable.id,
          namespace_id: roomsTable.namespaceId,
          authority_room_id: roomsTable.parentRoomId,
        }).from(roomsTable).where(and(
          eq(roomsTable.id, input.roomId),
          eq(roomsTable.namespaceId, input.namespaceId),
        )).limit(2),
      );
      if (candidateRows.length !== 1) return null;
      const candidateRoomIds = [...new Set([
        candidateRows[0]!.id,
        candidateRows[0]!.parent_room_id ?? candidateRows[0]!.id,
      ])].sort();
      // Membership propagation locks the authority parent before its Subthreads.
      // Keep that order even when a child's UUID sorts before its parent.
      const lockedRows = await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.select({ room_id: roomsTable.id })
          .from(roomsTable).where(inArray(roomsTable.id, candidateRoomIds))
          .orderBy(sql`${roomsTable.parentRoomId} nulls first`, asc(roomsTable.id))
          .for("update", { of: roomsTable }),
      );
      if (lockedRows.length !== candidateRoomIds.length) return null;
      const rooms = await transaction.query(
        `/* m298_namespace_key_human_ai_readable_source_room */
         SELECT source.id::text AS source_room_id,
                source.kind AS source_kind,
                source.parent_room_id::text AS source_parent_room_id,
                source.archived_at AS source_archived_at,
                authority.id::text AS room_id,
                authority.namespace_id::text AS namespace_id,
                authority.kind, authority.parent_room_id,
                authority.archived_at,
                authority.namespace_access_revision,
                public.moderation_access_allowed($3::uuid, source.id) AS source_access_allowed,
                authority.human_actor_ids::text[] AS human_actor_ids,
                public.moderation_effective_humans(authority.human_actor_ids, authority.id)::text[] AS effective_human_actor_ids
           FROM rooms source
           JOIN rooms authority
             ON authority.id = COALESCE(source.parent_room_id, source.id)
            AND authority.namespace_id = source.namespace_id
          WHERE source.id = $1::uuid
            AND source.namespace_id = $2::uuid
          LIMIT 2 FOR UPDATE OF source, authority`,
        [input.roomId, input.namespaceId, input.subjectUserId],
      );
      if (rooms.length !== 1) return null;
      const room = rooms[0]!;
      if (text(room, "room_id") !== (
        candidateRows[0]!.parent_room_id ?? candidateRows[0]!.id
      )) {
        return null;
      }
      const actorRows = await transaction.query(
        `/* m298_namespace_key_human_ai_readable_actor */
         SELECT actor.owner_id::text AS subject_user_id
           FROM actors actor
          WHERE actor.id = $1::uuid AND actor.kind = 'user'
          LIMIT 2 FOR UPDATE OF actor`,
        [input.subjectHumanId],
      );
      if (actorRows.length !== 1) return null;
      const authorityRoomId = text(room, "room_id");
      const members = await transaction.query(
        `/* m298_namespace_key_human_ai_readable_authority_members */
         SELECT member.actor_id::text AS actor_id, actor.kind,
                actor.agent_id::text AS agent_id
           FROM room_members member
           JOIN actors actor ON actor.id = member.actor_id
          WHERE member.room_id = $1::uuid
          ORDER BY member.actor_id
          FOR UPDATE OF member`,
        [authorityRoomId],
      );
      const humans = canonicalHumans(members
        .filter((member) => member["kind"] === "user")
        .map((member) => text(member, "actor_id")));
      const agents = members.filter((member) => member["kind"] === "agent");
      const storedHumans = room["human_actor_ids"];
      const sourceParentRoomId = room["source_parent_room_id"];
      const sourceShapeCurrent = sourceParentRoomId === null
        ? (requireAgent || protectedMessageOnly
          ? isProtectedTopLevelRoomKind(text(room, "source_kind"))
          : ["private", "group", "open", "access"].includes(text(room, "source_kind")))
        : text(room, "source_kind") === "subthread"
          && sourceParentRoomId === authorityRoomId;
      if (
        text(room, "source_room_id") !== input.roomId
        || !sourceShapeCurrent
        || room["source_access_allowed"] !== true
        || room["source_archived_at"] !== null
        || text(room, "namespace_id") !== input.namespaceId
        || !(requireAgent || protectedMessageOnly
          ? isProtectedTopLevelRoomKind(text(room, "kind"))
          : ["private", "group", "open", "access"].includes(text(room, "kind")))
        || room["parent_room_id"] !== null
        || room["archived_at"] !== null
        || text(actorRows[0]!, "subject_user_id") !== input.subjectUserId
        || humans.length < 1
        || (requireAgent && agents.length < 1)
        || !humans.includes(humanId(input.subjectHumanId))
        || !Array.isArray(storedHumans)
        || storedHumans.length !== humans.length
        || storedHumans.some((value, index) => value !== humans[index])
      ) return null;
      const effectiveHumans = effectiveAudience(room, "effective_human_actor_ids", humans, input.subjectHumanId);
      if (effectiveHumans === null) return null;
      const audienceFingerprint =
        fingerprintNamespaceGenerationAudience(effectiveHumans);
      const handle = Object.freeze({}) as NamespaceProductAuthoritySnapshot;
      snapshots.set(handle, Object.freeze({
        roomId: authorityRoomId,
        namespaceId: namespaceId(input.namespaceId),
        accessRevision: accessRevision(
          number(room, "namespace_access_revision"),
        ),
        participantHumanIds: effectiveHumans,
        audienceFingerprint,
        subjectHumanId: humanId(input.subjectHumanId),
      }));
      try {
        return await input.use(handle, agents.length === 0 ? "human" : "ai");
      } finally {
        snapshots.delete(handle);
        audienceFingerprint.fill(0);
      }
    }, { isolationLevel: "serializable" });
  }

  async #withCurrentMultiHumanRoom<Value>(input: Readonly<{
    subjectUserId: string;
    subjectHumanId: string;
    roomId: string;
    namespaceId: string;
    recipientAgentId?: string;
    use: (
      snapshot: NamespaceProductAuthoritySnapshot,
    ) => Promise<Value>;
  }>, topology: "human_only" | "shared_agent" | "human_ai_readable"):
    Promise<Value | null> {
    if (
      !UUID.test(input.subjectUserId)
      || !UUID.test(input.subjectHumanId)
      || !UUID.test(input.roomId)
      || !UUID.test(input.namespaceId)
      || (topology === "shared_agent"
        && (input.recipientAgentId === undefined
          || !UUID.test(input.recipientAgentId)))
    ) throw new TypeError("Namespace key product coordinates are invalid");
    return this.product.transactionOnce(async (transaction) => {
      const rooms = await transaction.query(
        `/* m295_namespace_key_human_only_product_room */
         SELECT r.id::text AS room_id, r.namespace_id::text AS namespace_id,
                r.kind, r.parent_room_id, r.archived_at,
                r.namespace_access_revision,
                r.human_actor_ids::text[] AS human_actor_ids,
                public.moderation_effective_humans(r.human_actor_ids, r.id)::text[] AS effective_human_actor_ids,
                a.owner_id::text AS subject_user_id
           FROM rooms r
           JOIN actors a ON a.id = $2::uuid AND a.kind = 'user'
          WHERE r.id = $1::uuid AND r.namespace_id = $3::uuid
          LIMIT 2 FOR UPDATE OF r, a`,
        [input.roomId, input.subjectHumanId, input.namespaceId],
      );
      if (rooms.length !== 1) return null;
      const room = rooms[0]!;
      const members = await transaction.query(
        `/* m295_namespace_key_human_only_product_members */
         SELECT member.actor_id::text AS actor_id, actor.kind,
                actor.agent_id::text AS agent_id
           FROM room_members member
           JOIN actors actor ON actor.id = member.actor_id
          WHERE member.room_id = $1::uuid
          ORDER BY member.actor_id
          FOR UPDATE OF member`,
        [input.roomId],
      );
      const humans = canonicalHumans(members
        .filter((member) => member["kind"] === "user")
        .map((member) => text(member, "actor_id")));
      const agents = members.filter((member) => member["kind"] === "agent");
      const storedHumans = room["human_actor_ids"];
      if (
        text(room, "room_id") !== input.roomId
        || text(room, "namespace_id") !== input.namespaceId
        || !(topology === "shared_agent"
          ? ["private", "group"].includes(text(room, "kind"))
          : isProtectedTopLevelRoomKind(text(room, "kind")))
        || room["parent_room_id"] !== null
        || room["archived_at"] !== null
        || text(room, "subject_user_id") !== input.subjectUserId
        || humans.length < (topology === "human_ai_readable" || room["kind"] === "open" ? 1 : 2)
        || (topology === "human_only"
          ? agents.length !== 0
          : topology === "shared_agent"
          ? agents.length !== 1
          : agents.length < 1)
        || (topology === "shared_agent"
          && agents[0]?.["agent_id"] !== input.recipientAgentId)
        || !humans.includes(humanId(input.subjectHumanId))
        || !Array.isArray(storedHumans)
        || storedHumans.length !== humans.length
        || storedHumans.some((value, index) => value !== humans[index])
      ) return null;
      const effectiveHumans = effectiveAudience(room, "effective_human_actor_ids", humans, input.subjectHumanId);
      if (effectiveHumans === null) return null;
      const audienceFingerprint =
        fingerprintNamespaceGenerationAudience(effectiveHumans);
      const handle = Object.freeze({}) as NamespaceProductAuthoritySnapshot;
      snapshots.set(handle, Object.freeze({
        roomId: input.roomId,
        namespaceId: namespaceId(input.namespaceId),
        accessRevision: accessRevision(number(room, "namespace_access_revision")),
        participantHumanIds: effectiveHumans,
        audienceFingerprint,
        subjectHumanId: humanId(input.subjectHumanId),
      }));
      try {
        return await input.use(handle);
      } finally {
        snapshots.delete(handle);
        audienceFingerprint.fill(0);
      }
    }, { isolationLevel: "serializable" });
  }

  /** Historical Message class is independent of today's Agent roster. */
  async withDetachedCurrentMessageHistoryRead<Value>(input: Readonly<{
    subjectUserId: string;
    subjectHumanId: string;
    roomId: string;
    namespaceId: string;
    use: (snapshot: NamespaceProductAuthoritySnapshot) => Promise<Value>;
  }>): Promise<Value | null> {
    return this.#withDetachedHumanRoomRead(input, false);
  }

  /** The canonical protected Human/AI topology, rechecked after detached crypto IO. */
  async withDetachedCurrentHumanAiReadableRoomRead<Value>(input: Readonly<{
    subjectUserId: string;
    subjectHumanId: string;
    roomId: string;
    namespaceId: string;
    use: (snapshot: NamespaceProductAuthoritySnapshot) => Promise<Value>;
  }>): Promise<Value | null> {
    return this.#withDetachedHumanRoomRead(input, true);
  }

  async #withDetachedHumanRoomRead<Value>(input: Readonly<{
    subjectUserId: string;
    subjectHumanId: string;
    roomId: string;
    namespaceId: string;
    use: (snapshot: NamespaceProductAuthoritySnapshot) => Promise<Value>;
  }>, requireAgent: boolean): Promise<Value | null> {
    const capture = () => this.#withCurrentHumanReadableSourceRoom({
      ...input,
      use: (handle) => {
        const state = snapshotOf(handle);
        return Promise.resolve({ ...state, audienceFingerprint: state.audienceFingerprint.slice() });
      },
    }, requireAgent, true);
    const initial = await capture();
    if (initial === null) return null;
    const handle = Object.freeze({}) as NamespaceProductAuthoritySnapshot;
    snapshots.set(handle, initial);
    try {
      const value = await input.use(handle);
      const current = await capture();
      if (current === null) return null;
      try {
        return current.roomId === initial.roomId
          && current.namespaceId === initial.namespaceId
          && current.accessRevision === initial.accessRevision
          && current.subjectHumanId === initial.subjectHumanId
          && current.participantHumanIds.length === initial.participantHumanIds.length
          && current.participantHumanIds.every((human, index) => human === initial.participantHumanIds[index])
          && equalBytes(current.audienceFingerprint, initial.audienceFingerprint)
          ? value : null;
      } finally {
        current.audienceFingerprint.fill(0);
      }
    } finally {
      snapshots.delete(handle);
      initial.audienceFingerprint.fill(0);
    }
  }

  /**
   * M275 read-only authority boundary. Capture the same canonical private-Room
   * facts as {@link withCurrentPrivateRoom}, close the product transaction,
   * run the restricted read through the authentic opaque handle, then capture
   * and exact-match fresh product facts before releasing the value.
   *
   * Publication/mutation paths intentionally keep using the lock-holding
   * method above; only disclosure reads may use this detached callback.
   */
  async withDetachedCurrentPrivateRoomRead<Value>(input: Readonly<{
    subjectUserId: string;
    subjectHumanId: string;
    roomId: string;
    namespaceId: string;
    use: (
      snapshot: NamespaceProductAuthoritySnapshot,
    ) => Promise<Value>;
  }>): Promise<Value | null> {
    if (
      !UUID.test(input.subjectUserId)
      || !UUID.test(input.subjectHumanId)
      || !UUID.test(input.roomId)
      || !UUID.test(input.namespaceId)
    ) throw new TypeError("Namespace key product coordinates are invalid");

    const capture = async (): Promise<Snapshot | null> =>
      this.product.transactionOnce(async (transaction) => {
        const rooms = await transaction.query(
          `/* m275_namespace_key_product_read_snapshot_room */
           SELECT r.id::text AS room_id, r.namespace_id::text AS namespace_id,
                  r.kind, r.parent_room_id, r.archived_at,
                  r.namespace_access_revision,
                  r.human_actor_ids::text[] AS human_actor_ids,
                public.moderation_effective_humans(r.human_actor_ids, r.id)::text[] AS effective_human_actor_ids,
                  a.owner_id::text AS subject_user_id
             FROM rooms r
             JOIN actors a ON a.id = $2::uuid AND a.kind = 'user'
            WHERE r.id = $1::uuid AND r.namespace_id = $3::uuid
            LIMIT 2`,
          [input.roomId, input.subjectHumanId, input.namespaceId],
        );
        if (rooms.length !== 1) return null;
        const room = rooms[0]!;
        const members = await transaction.query(
          `/* m275_namespace_key_product_read_snapshot_members */
           SELECT member.actor_id::text AS actor_id, actor.kind
             FROM room_members member
             JOIN actors actor ON actor.id = member.actor_id
            WHERE member.room_id = $1::uuid
            ORDER BY member.actor_id`,
          [input.roomId],
        );
        const humans = canonicalHumans(members
          .filter((member) => member["kind"] === "user")
          .map((member) => text(member, "actor_id")));
        const agents = members.filter((member) => member["kind"] === "agent");
        const storedHumans = room["human_actor_ids"];
        if (
          text(room, "room_id") !== input.roomId
          || text(room, "namespace_id") !== input.namespaceId
          || room["kind"] !== "private"
          || room["parent_room_id"] !== null
          || room["archived_at"] !== null
          || text(room, "subject_user_id") !== input.subjectUserId
          || humans.length !== 1
          || agents.length !== 1
          || humans[0] !== input.subjectHumanId
          || !Array.isArray(storedHumans)
          || storedHumans.length !== humans.length
          || storedHumans.some((value, index) => value !== humans[index])
        ) return null;
        const effectiveHumans = effectiveAudience(room, "effective_human_actor_ids", humans, input.subjectHumanId);
        if (effectiveHumans === null) return null;
        return Object.freeze({
          roomId: input.roomId,
          namespaceId: namespaceId(input.namespaceId),
          accessRevision: accessRevision(
            number(room, "namespace_access_revision"),
          ),
          participantHumanIds: effectiveHumans,
          audienceFingerprint:
            fingerprintNamespaceGenerationAudience(effectiveHumans),
          subjectHumanId: humanId(input.subjectHumanId),
        });
      }, { isolationLevel: "serializable" });

    const initial = await capture();
    if (initial === null) return null;
    const handle = Object.freeze({}) as NamespaceProductAuthoritySnapshot;
    snapshots.set(handle, initial);
    try {
      const value = await input.use(handle);
      const current = await capture();
      if (current === null) return null;
      try {
        if (
          current.roomId !== initial.roomId
          || current.namespaceId !== initial.namespaceId
          || current.accessRevision !== initial.accessRevision
          || current.subjectHumanId !== initial.subjectHumanId
          || current.participantHumanIds.length
            !== initial.participantHumanIds.length
          || current.participantHumanIds.some((participant, index) =>
            participant !== initial.participantHumanIds[index]
          )
          || !equalBytes(
            current.audienceFingerprint,
            initial.audienceFingerprint,
          )
        ) return null;
        return value;
      } finally {
        current.audienceFingerprint.fill(0);
      }
    } finally {
      snapshots.delete(handle);
      initial.audienceFingerprint.fill(0);
    }
  }

  /**
   * Holds the exact one-or-more-Human/one-or-more-Agent source Room plus one canonical
   * top-level Namespace whose Human audience contains the invoking Human.
   * This deliberately mirrors
   * `MemoryAccessEnvelope.readableNamespaces`, including retained archived,
   * access, and explicit-member public Namespaces: callers cannot nominate an
   * unrelated Namespace merely by knowing its identifier, while the protected
   * grant cannot silently narrow ordinary Agent authority. A Human-only source
   * may service either recipient key class for its own Namespace; it cannot
   * nominate another Room or issue an Agent grant without an Agent in the
   * source Room.
   */
  async withCurrentReadableNamespace<Value>(input: Readonly<{
    subjectUserId: string;
    subjectHumanId: string;
    sourceRoomId: string;
    namespaceId: string;
    keyClass: DomainKeyClass;
    use: (
      snapshot: NamespaceProductAuthoritySnapshot,
    ) => Promise<Value>;
  }>): Promise<Value | null> {
    if (
      !UUID.test(input.subjectUserId)
      || !UUID.test(input.subjectHumanId)
      || !UUID.test(input.sourceRoomId)
      || !UUID.test(input.namespaceId)
    ) throw new TypeError("Namespace key product coordinates are invalid");
    return this.product.transactionOnce(async (transaction) => {
      const candidateTargets = await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.select({ target_room_id: roomsTable.id })
          .from(roomsTable).where(and(
            eq(roomsTable.namespaceId, input.namespaceId),
            isNull(roomsTable.parentRoomId),
          )).limit(2),
      );
      if (candidateTargets.length !== 1) return null;
      const candidateRoomIds = [...new Set([
        input.sourceRoomId,
        candidateTargets[0]!.id,
      ])].sort();
      // Top-level sources/targets retain UUID order; inherited sources follow
      // their parent, matching the membership propagation lock protocol.
      const lockedRows = await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.select({ room_id: roomsTable.id })
          .from(roomsTable).where(inArray(roomsTable.id, candidateRoomIds))
          .orderBy(sql`${roomsTable.parentRoomId} nulls first`, asc(roomsTable.id))
          .for("update", { of: roomsTable }),
      );
      if (lockedRows.length !== candidateRoomIds.length) return null;
      const sources = await transaction.query(
        `/* m290_namespace_key_readable_rooms */
         SELECT source.id::text AS source_room_id,
                source.namespace_id::text AS source_namespace_id,
                source.kind AS source_kind,
                source.parent_room_id AS source_parent_room_id,
                source.archived_at AS source_archived_at,
                source.human_actor_ids::text[] AS source_human_actor_ids,
                public.moderation_effective_humans(source.human_actor_ids, source.id)::text[] AS effective_source_human_actor_ids
           FROM rooms source
          WHERE source.id = $1::uuid
          LIMIT 2 FOR UPDATE OF source`,
        [input.sourceRoomId],
      );
      if (sources.length !== 1) return null;
      const source = sources[0]!;
      const actorRows = await transaction.query(
        `/* m290_namespace_key_readable_actor */
         SELECT actor.owner_id::text AS subject_user_id
           FROM actors actor
          WHERE actor.id = $1::uuid AND actor.kind = 'user'
          LIMIT 2 FOR UPDATE OF actor`,
        [input.subjectHumanId],
      );
      if (actorRows.length !== 1) return null;
      const sourceMembers = await transaction.query(
        `/* m290_namespace_key_source_members */
         SELECT member.actor_id::text AS actor_id, actor.kind
           FROM room_members member
           JOIN actors actor ON actor.id = member.actor_id
          WHERE member.room_id = $1::uuid
          ORDER BY member.actor_id
          FOR UPDATE OF member`,
        [input.sourceRoomId],
      );
      const targets = await transaction.query(
        `/* m290_namespace_key_target_room */
         SELECT target.id::text AS target_room_id,
                target.namespace_id::text AS target_namespace_id,
                target.kind AS target_kind,
                target.parent_room_id AS target_parent_room_id,
                target.archived_at AS target_archived_at,
                target.namespace_access_revision AS target_access_revision,
                target.human_actor_ids::text[] AS target_human_actor_ids,
                public.moderation_effective_humans(target.human_actor_ids, target.id)::text[] AS effective_target_human_actor_ids
           FROM rooms target
          WHERE target.namespace_id = $1::uuid
            AND target.parent_room_id IS NULL
          LIMIT 2 FOR UPDATE OF target`,
        [input.namespaceId],
      );
      if (targets.length !== 1) return null;
      const target = targets[0]!;
      const targetRoomId = text(target, "target_room_id");
      if (targetRoomId !== candidateTargets[0]!.id) return null;
      const targetMembers = await transaction.query(
        `/* m290_namespace_key_target_members */
         SELECT member.actor_id::text AS actor_id, actor.kind
           FROM room_members member
           JOIN actors actor ON actor.id = member.actor_id
          WHERE member.room_id = $1::uuid
          ORDER BY member.actor_id
          FOR UPDATE OF member`,
        [targetRoomId],
      );
      const sourceHumans = canonicalHumans(sourceMembers
        .filter((member) => member["kind"] === "user")
        .map((member) => text(member, "actor_id")));
      const sourceAgents = sourceMembers.filter((member) =>
        member["kind"] === "agent"
      );
      const targetHumans = canonicalHumans(targetMembers
        .filter((member) => member["kind"] === "user")
        .map((member) => text(member, "actor_id")));
      const storedSourceHumans = source["source_human_actor_ids"];
      const storedTargetHumans = target["target_human_actor_ids"];
      const subjectHumanId = humanId(input.subjectHumanId);
      const isSameRoomNamespace = targetRoomId === input.sourceRoomId
        && text(source, "source_namespace_id") === input.namespaceId;
      // A Subthread consumes its parent's exact Namespace, with both current
      // memberships fenced above. It cannot nominate another readable Namespace.
      // Retained AI keys remain readable after the last Agent leaves the parent.
      const isInheritedNamespace = text(source, "source_kind") === "subthread"
        && source["source_parent_room_id"] === targetRoomId
        && text(source, "source_namespace_id") === input.namespaceId
        && isProtectedTopLevelRoomKind(text(target, "target_kind"))
        && target["target_archived_at"] === null;
      const sourceShapeCurrent = isInheritedNamespace
        || (source["source_parent_room_id"] === null
          && (isProtectedTopLevelRoomKind(text(source, "source_kind"))
            || (text(source, "source_kind") === "access" && isSameRoomNamespace)));
      if (
        text(source, "source_room_id") !== input.sourceRoomId
        || !sourceShapeCurrent
        || source["source_archived_at"] !== null
        || text(actorRows[0]!, "subject_user_id") !== input.subjectUserId
        || sourceHumans.length < 1
        || (sourceAgents.length < 1 && !isSameRoomNamespace && !isInheritedNamespace)
        || !sourceHumans.includes(subjectHumanId)
        || !Array.isArray(storedSourceHumans)
        || storedSourceHumans.length !== sourceHumans.length
        || storedSourceHumans.some((value, index) =>
          value !== sourceHumans[index]
        )
        || text(target, "target_namespace_id") !== input.namespaceId
        || target["target_parent_room_id"] !== null
        || !targetHumans.includes(subjectHumanId)
        || !Array.isArray(storedTargetHumans)
        || storedTargetHumans.length !== targetHumans.length
        || storedTargetHumans.some((value, index) =>
          value !== targetHumans[index]
        )
      ) return null;
      const effectiveSourceHumans = effectiveAudience(source, "effective_source_human_actor_ids", sourceHumans, subjectHumanId);
      const effectiveTargetHumans = effectiveAudience(target, "effective_target_human_actor_ids", targetHumans, subjectHumanId);
      if (effectiveSourceHumans === null || effectiveTargetHumans === null) return null;
      if (!await readableNamespacePolicyAllows(transaction, {
        sourceRoomId: input.sourceRoomId,
        sourceHumanIds: effectiveSourceHumans,
        namespaceIds: [input.namespaceId],
      })) return null;
      const audienceFingerprint =
        fingerprintNamespaceGenerationAudience(effectiveTargetHumans);
      const handle = Object.freeze({}) as NamespaceProductAuthoritySnapshot;
      snapshots.set(handle, Object.freeze({
        roomId: targetRoomId,
        namespaceId: namespaceId(input.namespaceId),
        accessRevision: accessRevision(number(target, "target_access_revision")),
        participantHumanIds: effectiveTargetHumans,
        audienceFingerprint,
        subjectHumanId,
      }));
      try {
        return await input.use(handle);
      } finally {
        snapshots.delete(handle);
        audienceFingerprint.fill(0);
      }
    }, { isolationLevel: "serializable" });
  }

  /**
   * Holds one complete server-derived readable Namespace inventory under one
   * product transaction. This is the foreground scaling boundary: Room and
   * membership rows are locked once, then the restricted callback can
   * resolve one content-free fact per distinct V2 Domain without issuing
   * one product transaction per Namespace. Each target must include the
   * invoking Human and the complete source audience under M227. Caller-supplied
   * inventories never replace the locked public-boundary/subset check; qualifying
   * supersets may still span distinct V2 Domains.
   */
  async withCurrentReadableNamespaceSet<Value>(input: Readonly<{
    subjectUserId: string;
    subjectHumanId: string;
    sourceRoomId: string;
    namespaceIds: readonly string[];
    use: (
      entries: readonly NamespaceProductAuthoritySetEntry[],
    ) => Promise<Value>;
  }>): Promise<Value | null> {
    if (
      !UUID.test(input.subjectUserId)
      || !UUID.test(input.subjectHumanId)
      || !UUID.test(input.sourceRoomId)
      || input.namespaceIds.length < 1
      || input.namespaceIds.length > 65_536
      || input.namespaceIds.some((value, index) =>
        !UUID.test(value)
        || (index > 0 && input.namespaceIds[index - 1]! >= value)
      )
    ) throw new TypeError("Namespace key product set coordinates are invalid");
    return this.product.transactionOnce(async (transaction) => {
      const candidateTargets = await transaction.query(
        `/* m291_namespace_key_readable_set_target_candidates */
         SELECT target.id::text AS room_id,
                target.namespace_id::text AS namespace_id
           FROM rooms target
          WHERE target.namespace_id = ANY($1::uuid[])
            AND target.parent_room_id IS NULL
          ORDER BY target.namespace_id`,
        [input.namespaceIds],
      );
      if (
        candidateTargets.length !== input.namespaceIds.length
        || candidateTargets.some((row, index) =>
          text(row, "namespace_id") !== input.namespaceIds[index]
        )
      ) return null;
      const candidateRoomIds = [...new Set([
        input.sourceRoomId,
        ...candidateTargets.map((row) => text(row, "room_id")),
      ])].sort();
      // Invalid inherited sources must follow the same order before rejection.
      // Retain one array parameter: the admitted set can exceed PostgreSQL's
      // bind-parameter count when the source is an additional Room.
      const lockedRows = await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.select({ room_id: roomsTable.id })
          .from(roomsTable)
          .where(sql`${roomsTable.id} = ANY(${sql.param(candidateRoomIds)}::uuid[])`)
          .orderBy(sql`${roomsTable.parentRoomId} nulls first`, asc(roomsTable.id))
          .for("update", { of: roomsTable }),
      );
      if (lockedRows.length !== candidateRoomIds.length) return null;
      const sourceRows = await transaction.query(
        `/* m291_namespace_key_readable_set_source */
         SELECT source.id::text AS source_room_id, source.kind,
                source.parent_room_id, source.archived_at,
                source.human_actor_ids::text[] AS human_actor_ids,
                public.moderation_effective_humans(source.human_actor_ids, source.id)::text[] AS effective_human_actor_ids
           FROM rooms source
          WHERE source.id = $1::uuid
          LIMIT 2 FOR UPDATE OF source`,
        [input.sourceRoomId],
      );
      if (sourceRows.length !== 1) return null;
      const source = sourceRows[0]!;
      const actorRows = await transaction.query(
        `/* m291_namespace_key_readable_set_actor */
         SELECT actor.owner_id::text AS subject_user_id
           FROM actors actor
          WHERE actor.id = $1::uuid AND actor.kind = 'user'
          LIMIT 2 FOR UPDATE OF actor`,
        [input.subjectHumanId],
      );
      if (actorRows.length !== 1) return null;
      const sourceMemberRows = await transaction.query(
        `/* m291_namespace_key_readable_set_source_members */
         SELECT member.actor_id::text AS actor_id, actor.kind
           FROM room_members member
           JOIN actors actor ON actor.id = member.actor_id
          WHERE member.room_id = $1::uuid
          ORDER BY member.actor_id
          FOR UPDATE OF member`,
        [input.sourceRoomId],
      );
      const sourceHumans = canonicalHumans(sourceMemberRows
        .filter((member) => member["kind"] === "user")
        .map((member) => text(member, "actor_id")));
      const sourceAgents = sourceMemberRows.filter((member) =>
        member["kind"] === "agent"
      );
      const storedSourceHumans = source["human_actor_ids"];
      if (
        text(source, "source_room_id") !== input.sourceRoomId
        || !isProtectedTopLevelRoomKind(text(source, "kind"))
        || source["parent_room_id"] !== null
        || source["archived_at"] !== null
        || text(actorRows[0]!, "subject_user_id") !== input.subjectUserId
        || sourceHumans.length < 1
        || sourceAgents.length < 1
        || !sourceHumans.includes(humanId(input.subjectHumanId))
        || !Array.isArray(storedSourceHumans)
        || storedSourceHumans.length !== sourceHumans.length
        || storedSourceHumans.some((value, index) =>
          value !== sourceHumans[index]
        )
      ) return null;

      const effectiveSourceHumans = effectiveAudience(source, "effective_human_actor_ids", sourceHumans, input.subjectHumanId);
      if (effectiveSourceHumans === null) return null;
      const targetRows = await transaction.query(
        `/* m291_namespace_key_readable_set_targets */
         SELECT target.id::text AS room_id,
                target.namespace_id::text AS namespace_id,
                target.parent_room_id, target.namespace_access_revision,
                target.human_actor_ids::text[] AS human_actor_ids,
                public.moderation_effective_humans(target.human_actor_ids, target.id)::text[] AS effective_human_actor_ids
           FROM rooms target
          WHERE target.namespace_id = ANY($1::uuid[])
            AND target.parent_room_id IS NULL
          ORDER BY target.namespace_id
          FOR UPDATE OF target`,
        [input.namespaceIds],
      );
      if (
        targetRows.length !== input.namespaceIds.length
        || targetRows.some((row, index) =>
          text(row, "namespace_id") !== input.namespaceIds[index]
        )
      ) return null;
      const targetRoomIds = targetRows.map((row) => text(row, "room_id"));
      if (targetRoomIds.some((roomId, index) =>
        roomId !== text(candidateTargets[index]!, "room_id")
      )) return null;
      const memberRows = await transaction.query(
        `/* m291_namespace_key_readable_set_target_members */
         SELECT member.room_id::text AS room_id,
                member.actor_id::text AS actor_id, actor.kind
           FROM room_members member
           JOIN actors actor ON actor.id = member.actor_id
          WHERE member.room_id = ANY($1::uuid[])
          ORDER BY member.room_id, member.actor_id
          FOR UPDATE OF member`,
        [targetRoomIds],
      );
      if (!await readableNamespacePolicyAllows(transaction, {
        sourceRoomId: input.sourceRoomId,
        sourceHumanIds: effectiveSourceHumans,
        namespaceIds: input.namespaceIds,
      })) return null;
      const subjectHumanId = humanId(input.subjectHumanId);
      const handles: NamespaceProductAuthoritySetEntry[] = [];
      const fingerprints: Uint8Array[] = [];
      try {
        for (const row of targetRows) {
          const roomId = text(row, "room_id");
          const humans = canonicalHumans(memberRows
            .filter((member) =>
              text(member, "room_id") === roomId
              && member["kind"] === "user"
            )
            .map((member) => text(member, "actor_id")));
          const storedHumans = row["human_actor_ids"];
          if (
            !humans.includes(subjectHumanId)
            || !Array.isArray(storedHumans)
            || storedHumans.length !== humans.length
            || storedHumans.some((value, index) => value !== humans[index])
          ) return null;
          const effectiveHumans = effectiveAudience(row, "effective_human_actor_ids", humans, subjectHumanId);
          if (effectiveHumans === null) return null;
          const audienceFingerprint =
            fingerprintNamespaceGenerationAudience(effectiveHumans);
          fingerprints.push(audienceFingerprint);
          const handle = Object.freeze(
            {},
          ) as NamespaceProductAuthoritySnapshot;
          snapshots.set(handle, Object.freeze({
            roomId,
            namespaceId: namespaceId(text(row, "namespace_id")),
            accessRevision: accessRevision(
              number(row, "namespace_access_revision"),
            ),
            participantHumanIds: effectiveHumans,
            audienceFingerprint,
            subjectHumanId,
          }));
          handles.push(Object.freeze({
            namespaceId: namespaceId(text(row, "namespace_id")),
            authority: handle,
          }));
        }
        return await input.use(Object.freeze(handles));
      } finally {
        handles.forEach((entry) => snapshots.delete(entry.authority));
        fingerprints.forEach((value) => value.fill(0));
      }
    }, { isolationLevel: "serializable" });
  }
}
