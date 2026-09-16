/**
 * D246 Wave 2 (task 2.1 / 2.5) — compact batched roster projection.
 *
 * Proves the two load-bearing invariants of the room-summary roster:
 *
 *  1. **Constant query count** — `listRoomsForActor` folds every visible
 *     room's roster from ONE batch query keyed by `roomId`. The number of
 *     SQL statements it issues does NOT scale with room count (no
 *     per-room `GET /api/rooms/:id` fan-out equivalent at the query layer).
 *     Measured via `setRuntimeStatementObserver` (the postgres.js debug
 *     seam) around the call, with fixtures inserted outside the window.
 *
 *  2. **Roster correctness** — each returned `RoomSummaryRow.roster`
 *     carries the minimal grouping/display fields (actorId, kind,
 *     displayName, userId for humans, agentId + handle for agents) the
 *     explorer needs; empty rosters are preserved as `[]`; existing
 *     room visibility / kind filtering is unchanged.
 *
 * Runs against a live, already-migrated disposable instance
 * (`NAUTILO_INSTANCE_ID` selects it; `bootstrapTestDbInstance` defaults
 * to the `test-cruft` scratch and refuses `(default)`). Does NOT call
 * ensureDatabase, so no migrations are applied.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createDirectDb, eq, setRuntimeStatementObserver, users } from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { listRoomsForActor } from "../../src/queries";
import {
  Tracker,
  cleanupAll,
  mkActor,
  mkAgent,
  mkNamespace,
  mkRoom,
  mkUser,
  type Db,
} from "./helpers/unread-fixtures";

let db: Db;
const t = new Tracker();

beforeAll(() => {
  bootstrapTestDbInstance();
  db = createDirectDb(2);
});

afterAll(async () => {
  try {
    await cleanupAll(db, t);
  } finally {
    await db.end();
  }
});

describe("D246 Wave 2 — room-summary roster projection", () => {
  test("roster carries user + agent identity for each visible room", async () => {
    const ns = await mkNamespace(db, t);
    const agentId = await mkAgent(db, t);
    const uid = await mkUser(db, t, "d246rost");
    await db.update(users).set({ server: "remote.example.com" }).where(eq(users.id, uid));
    const human = await mkActor(db, t, uid, "D246 Roster Owner");
    const agentActor = await mkActor(db, t, uid, "D246 Roster Bot", {
      kind: "agent",
      agentId,
    });

    const roomId = await mkRoom(db, t, {
      ownerId: uid,
      namespaceId: ns,
      humanActorIds: [human],
      memberActorIds: [human, agentActor],
      kind: "private",
    });

    const rows = await listRoomsForActor(human);
    const room = rows.find((r) => r.id === roomId);
    expect(room).toBeTruthy();
    expect(room?.roster).toBeInstanceOf(Array);
    expect(room?.roster).toHaveLength(2);

    const userMember = room?.roster?.find((m) => m.kind === "user");
    expect(userMember?.actorId).toBe(human);
    expect(userMember?.userId).toBe(uid);
    expect(userMember?.displayName).toBe("D246 Roster Owner");
    expect(userMember?.federatedId).toMatch(/^@d246rost.+@remote\.example\.com$/);

    const agentMember = room?.roster?.find((m) => m.kind === "agent");
    expect(agentMember?.actorId).toBe(agentActor);
    expect(agentMember?.agentId).toBe(agentId);
    expect(agentMember?.displayName).toBe("D246 Roster Bot");
    // Agent handle comes from agents.handle; users.handle for humans.
    expect(typeof agentMember?.handle === "string").toBe(true);
  });

  test("solo room yields a one-member roster (not undefined)", async () => {
    const ns = await mkNamespace(db, t);
    const uid = await mkUser(db, t, "d246solo");
    const human = await mkActor(db, t, uid, "D246 Solo Owner");

    const roomId = await mkRoom(db, t, {
      ownerId: uid,
      namespaceId: ns,
      humanActorIds: [human],
      memberActorIds: [human],
      kind: "private",
    });

    const rows = await listRoomsForActor(human);
    const room = rows.find((r) => r.id === roomId);
    // An explicitly-empty/sole-member roster is preserved as a real array
    // so the explorer can distinguish "loaded" from "not loaded".
    expect(room?.roster).toEqual([
      expect.objectContaining({ actorId: human, kind: "user", userId: uid }),
    ]);
  });

  test("query count is constant as fixture room count grows (no per-room fan-out)", async () => {
    const ns = await mkNamespace(db, t);
    const agentId = await mkAgent(db, t);
    const uid = await mkUser(db, t, "d246slope");
    const human = await mkActor(db, t, uid, "D246 Slope Owner");
    const agentActor = await mkActor(db, t, uid, "D246 Slope Bot", {
      kind: "agent",
      agentId,
    });

    // Seed 1 room, measure, then grow to 10 and measure again. The fixture
    // inserts happen OUTSIDE the observation window so only `listRoomsForActor`
    // statements are counted.
    const firstRoomId = await mkRoom(db, t, {
      ownerId: uid,
      namespaceId: ns,
      humanActorIds: [human],
      memberActorIds: [human, agentActor],
      kind: "private",
    });

    const countFor = async (expected: number): Promise<number> => {
      let n = 0;
      const stop = setRuntimeStatementObserver(() => {
        n += 1;
      });
      try {
        const rows = await listRoomsForActor(human);
        expect(rows.length).toBeGreaterThanOrEqual(expected);
        return n;
      } finally {
        stop();
      }
    };

    const count1 = await countFor(1);
    expect(count1).toBeGreaterThan(0);

    // Grow to 10 rooms total (9 more).
    for (let i = 0; i < 9; i++) {
      await mkRoom(db, t, {
        ownerId: uid,
        namespaceId: ns,
        humanActorIds: [human],
        memberActorIds: [human, agentActor],
        kind: "private",
      });
    }

    const count10 = await countFor(10);
    // The query set is fixed (rooms + counts + activity + unread + roster +
    // viewer resolve), independent of room count. A per-room fan-out would
    // show count10 ≈ count1 + 9 (one extra roster query per added room);
    // the projection folds them into one batch query, so the slope is 0.
    expect(count10).toBe(count1);
    expect(firstRoomId).toBeTruthy();
  });

  test("skip-roster mode omits roster and avoids the roster batch query", async () => {
    const ns = await mkNamespace(db, t);
    const agentId = await mkAgent(db, t);
    const uid = await mkUser(db, t, "d246skip");
    const human = await mkActor(db, t, uid, "D246 Skip Owner");
    const agentActor = await mkActor(db, t, uid, "D246 Skip Bot", {
      kind: "agent",
      agentId,
    });

    await mkRoom(db, t, {
      ownerId: uid,
      namespaceId: ns,
      humanActorIds: [human],
      memberActorIds: [human, agentActor],
      kind: "private",
    });

    const countFor = async (includeRoster: boolean): Promise<number> => {
      let n = 0;
      const stop = setRuntimeStatementObserver(() => {
        n += 1;
      });
      try {
        const rows = await listRoomsForActor(human, { includeRoster });
        expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) {
          if (includeRoster) {
            expect(Array.isArray(r.roster)).toBe(true);
          } else {
            expect(r.roster).toBeUndefined();
          }
        }
        return n;
      } finally {
        stop();
      }
    };

    const withRoster = await countFor(true);
    const withoutRoster = await countFor(false);
    expect(withoutRoster).toBe(withRoster - 1);
  });

  test("roster member order is deterministic within a room", async () => {
    const ns = await mkNamespace(db, t);
    const agentId = await mkAgent(db, t);
    const uid = await mkUser(db, t, "d246ord");
    const human = await mkActor(db, t, uid, "D246 Order Owner");
    const agentActor = await mkActor(db, t, uid, "D246 Order Bot", {
      kind: "agent",
      agentId,
    });

    const roomId = await mkRoom(db, t, {
      ownerId: uid,
      namespaceId: ns,
      humanActorIds: [human],
      memberActorIds: [human, agentActor],
      kind: "private",
    });

    const first = await listRoomsForActor(human);
    const second = await listRoomsForActor(human);
    const rosterA = first.find((r) => r.id === roomId)?.roster ?? [];
    const rosterB = second.find((r) => r.id === roomId)?.roster ?? [];
    expect(rosterA.map((m) => m.actorId)).toEqual(rosterB.map((m) => m.actorId));
    expect([...rosterA.map((m) => m.actorId)].sort()).toEqual(
      rosterA.map((m) => m.actorId),
    );
  });

  test("existing room visibility / kind filtering is preserved alongside roster", async () => {
    const ns = await mkNamespace(db, t);
    const uid = await mkUser(db, t, "d246vis");
    const human = await mkActor(db, t, uid, "D246 Vis Owner");

    // A task room must stay hidden from the explorer feed (M157), and the
    // roster projection must not leak it back in.
    const taskRoomId = await mkRoom(db, t, {
      ownerId: uid,
      namespaceId: ns,
      humanActorIds: [],
      memberActorIds: [human],
      kind: "task",
    });
    const visibleRoomId = await mkRoom(db, t, {
      ownerId: uid,
      namespaceId: ns,
      humanActorIds: [human],
      memberActorIds: [human],
      kind: "private",
    });

    const rows = await listRoomsForActor(human);
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.has(visibleRoomId)).toBe(true);
    expect(ids.has(taskRoomId)).toBe(false);
    // Every visible room carries a roster; hidden rooms never appear.
    for (const r of rows) {
      expect(Array.isArray(r.roster)).toBe(true);
    }
  });
});
