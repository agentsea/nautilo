import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, count, eq, isNull, notExists, sql as dsql } from "drizzle-orm";
import { rooms, roomMembers } from "../schema/rooms";
import { actors, namespaces } from "../schema/trust";
import { sessions } from "../schema/sessions";
import { memories } from "../schema/memories";
import { memoryNamespaces } from "../schema/memory-namespaces";
import { jobs } from "../schema/jobs";
import { resolveDirectDatabaseConnectionString } from "../config/direct-database";
import {
  createRoomJournalStateInTx,
  reconcileRoomJournalMembershipInTx,
} from "../queries/room-journal-state";

/**
 * M042B — ensures a default private room exists for the given owner
 * and the seeded default agent. Backfills existing rows in our own
 * tables (sessions / jobs) to point at the new room and to
 * use the new `room:<uuid>` laneKey format.
 *
 * **M075** — every room (including the seeded default) uses
 * `graph_thread_id = "room:<roomId>"` so LangGraph checkpoints are not
 * shared across users. Migration `0034_m075_per_room_graph_thread`
 * rewrites existing `langchain.*` rows from `"app:default"` where
 * applicable.
 *
 * Runs AFTER seedDefaultAgent (which mints the agent and the
 * mirror actor row). Idempotent — safe to call on every startup.
 *
 * M044 additions:
 *   - Mints the Room's Namespace transactionally with the Room row
 *     (REL-NSP-RMS 1:1). Pre-M044 the owner's private Namespace was
 *     seeded by `seedTrustPersonal` one layer earlier; the M044
 *     migration reuses that row in place as the Room's Namespace, so
 *     on every post-migration boot THIS seed picks up the existing
 *     row via the `rooms.namespace_id` backfill. For a fresh DB (no
 *     pre-existing private NS), we mint a new Namespace here.
 *   - Populates `rooms.human_actor_ids` (denormalized REL-HUM-NSP
 *     subset-rule key) with the owner-actor id on insert, and
 *     reconciles on idempotent re-boots to catch any drift caused
 *     by future room-membership mutation sites that forgot to call
 *     `updateRoomHumanActors`.
 *
 * Returns the default room's UUID + its Namespace id.
 */
export async function seedDefaultRoom(
  ownerId: string,
  ownerActorId: string,
  defaultAgentId: string,
  log?: (message: string) => void,
): Promise<{ roomId: string; namespaceId: string }> {
  const print = log ?? (() => {});
  const directConnection = resolveDirectDatabaseConnectionString();

  const sql = postgres(directConnection, { max: 1 });
  const db = drizzle(sql);

  try {
    // 1. Resolve the agent-actor id (seedDefaultAgent creates it).
    const [agentActor] = await db
      .select({ id: actors.id, displayName: actors.displayName })
      .from(actors)
      .where(and(eq(actors.agentId, defaultAgentId), eq(actors.kind, "agent")))
      .limit(1);
    if (!agentActor) {
      throw new Error(
        `seedDefaultRoom: no agent-actor row for agent ${defaultAgentId}. ` +
          `Did seedDefaultAgent run?`,
      );
    }

    // 2. Idempotent lookup: existing `type='private'` room owned by this
    //    user whose membership set equals {ownerActor, agentActor}.
    const existingRooms = await db
      .select({
        id: rooms.id,
        namespaceId: rooms.namespaceId,
        graphThreadId: rooms.graphThreadId,
      })
      .from(rooms)
      .where(and(eq(rooms.ownerId, ownerId), eq(rooms.type, "private")));

    let roomId: string | null = null;
    let namespaceId: string | null = null;
    for (const candidate of existingRooms) {
      const memberRows = await db
        .select({ actorId: roomMembers.actorId })
        .from(roomMembers)
        .where(eq(roomMembers.roomId, candidate.id));
      const memberIds = new Set(memberRows.map((r) => r.actorId));
      if (
        memberIds.size === 2 &&
        memberIds.has(ownerActorId) &&
        memberIds.has(agentActor.id)
      ) {
        roomId = candidate.id;
        namespaceId = candidate.namespaceId;
        break;
      }
    }

    // 3. Create the room + Namespace + memberships if missing.
    //    M044: Namespace is minted transactionally with the Room
    //    (REL-NSP-RMS). `rooms.namespace_id` NOT NULL enforces this
    //    at the schema layer.
    if (!roomId) {
      const label = `Owner · ${agentActor.displayName}`;
      print(`Creating default private room (${label}) + its Namespace...`);

      const createdBundle = await db.transaction(async (tx) => {
        const [nsRow] = await tx
          .insert(namespaces)
          .values({
            scope: "private",
            label: "Private",
          })
          .returning({ id: namespaces.id });
        if (!nsRow) throw new Error("Failed to create default room Namespace");

        const pendingGraphId = `__m075_seed_pending_${randomUUID().replace(/-/g, "")}__`;
        const [created] = await tx
          .insert(rooms)
          .values({
            ownerId,
            type: "private",
            label,
            graphThreadId: pendingGraphId,
            namespaceId: nsRow.id,
            humanActorIds: [ownerActorId],
            createdBy: ownerActorId,
          })
          .returning({ id: rooms.id });
        if (!created) throw new Error("Failed to create default room");

        await createRoomJournalStateInTx(tx, created.id);

        await tx
          .update(rooms)
          .set({ graphThreadId: `room:${created.id}` })
          .where(eq(rooms.id, created.id));

        await tx.insert(roomMembers).values([
          { roomId: created.id, actorId: ownerActorId, roomRole: "admin" },
          { roomId: created.id, actorId: agentActor.id, roomRole: "member" },
        ]);
        await reconcileRoomJournalMembershipInTx(tx, [created.id]);

        return { roomId: created.id, namespaceId: nsRow.id };
      });
      roomId = createdBundle.roomId;
      namespaceId = createdBundle.namespaceId;
      print(`Default room created: ${roomId} (NS: ${namespaceId})`);
    } else {
      // 3b. Idempotent re-boot path: reconcile human_actor_ids from
      //     room_members to catch any drift.
      const existingRoomId = roomId;
      await reconcileRoomHumanActors(db, existingRoomId);
      await db.transaction(async (tx) => {
        await reconcileRoomJournalMembershipInTx(tx, [existingRoomId]);
      });
    }

    if (!namespaceId) {
      // Defensive — invariant-safe: rooms.namespace_id is NOT NULL, so
      // we should always have a value here. Fail loud if the invariant
      // regresses.
      throw new Error(
        `seedDefaultRoom: room ${roomId} has no namespaceId — invariant violation`,
      );
    }

    // 4. Backfill sessions and jobs to point at the default room.
    //    These writes are on Drizzle-owned tables ONLY. We never write
    //    to langchain.*.

    const [sessionNulls] = await db
      .select({ total: count() })
      .from(sessions)
      .where(and(eq(sessions.ownerId, ownerId), isNull(sessions.roomId)));
    if ((sessionNulls?.total ?? 0) > 0) {
      print(
        `Backfilling ${sessionNulls?.total} sessions with default room + room:<uuid> thread_id...`,
      );
      // Atomic UPDATE: set room_id AND rewrite thread_id for rows that
      // were using the legacy "app:default" literal. Rows with other
      // thread_ids (guest lanes, custom client strings) keep their
      // thread_id as-is but still get the room_id pointer.
      await db
        .update(sessions)
        .set({
          roomId,
          threadId: dsql`CASE WHEN ${sessions.threadId} = ${"app:default"} THEN ${`room:${roomId}`} ELSE ${sessions.threadId} END`,
        })
        .where(and(eq(sessions.ownerId, ownerId), isNull(sessions.roomId)));
    }

    const [jobNulls] = await db
      .select({ total: count() })
      .from(jobs)
      .where(and(eq(jobs.ownerId, ownerId), isNull(jobs.roomId)));
    if ((jobNulls?.total ?? 0) > 0) {
      print(
        `Backfilling ${jobNulls?.total} jobs with default room + room:<uuid> lane_key...`,
      );
      await db
        .update(jobs)
        .set({
          roomId,
          laneKey: dsql`CASE WHEN ${jobs.laneKey} = ${"app:default"} THEN ${`room:${roomId}`} ELSE ${jobs.laneKey} END`,
        })
        .where(and(eq(jobs.ownerId, ownerId), isNull(jobs.roomId)));
    }

    // 5. M076 — attach memories missing namespace edges to the default Room's
    //    Namespace (junction is canonical; legacy memories.namespace_id was
    //    dropped in migration 0036). Post-M127 there is no per-row agent
    //    filter — any memory missing a junction edge gets attached to the
    //    default Room's Namespace.
    const junctionGapWhere = notExists(
      db
        .select({ _: dsql`1` })
        .from(memoryNamespaces)
        .where(eq(memoryNamespaces.memoryId, memories.id)),
    );
    const [junctionNulls] = await db
      .select({ total: count() })
      .from(memories)
      .where(junctionGapWhere);
    if ((junctionNulls?.total ?? 0) > 0) {
      print(
        `Backfilling ${junctionNulls?.total} memory namespace junction rows for default room...`,
      );
      await db.insert(memoryNamespaces).select(db.select({
        memoryId: memories.id,
        namespaceId: dsql<string>`${namespaceId}::uuid`.as("namespace_id"),
        attachedAt: dsql<Date>`now()`.as("attached_at"),
      }).from(memories).where(notExists(
        db.select({ one: dsql<number>`1` }).from(memoryNamespaces).where(eq(
          memoryNamespaces.memoryId,
          memories.id,
        )),
      ))).onConflictDoNothing();
    }

    print("Default room seed complete.");
    return { roomId, namespaceId };
  } finally {
    await sql.end();
  }
}

/**
 * M044 — reconcile `rooms.human_actor_ids` from the authoritative
 * `room_members JOIN actors WHERE kind='user'` source. Called from
 * `seedDefaultRoom`'s idempotent re-boot path to heal any drift
 * caused by future room-membership mutation sites that forgot to
 * call `updateRoomHumanActors`. Cheap — one aggregate per room per
 * boot.
 */
async function reconcileRoomHumanActors(
  db: ReturnType<typeof drizzle>,
  roomId: string,
): Promise<void> {
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
