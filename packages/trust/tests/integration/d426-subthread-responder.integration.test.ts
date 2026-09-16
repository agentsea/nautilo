/**
 * D426 Phase 2 §2.1 / §2.2 / §2.5 — durable, requester-private Thread
 * Responder substrate: validated read / replace / clear / invalidation,
 * dynamic parent agent-response eligibility (observe cannot drift into
 * child rooms), eager + lazy invalidation, and per-(Subthread, human)
 * isolation between two humans. Live Postgres; run against a scratch
 * instance.
 */
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  and,
  createDirectDb,
  ensureDatabase,
  eq,
  namespaces,
  rooms,
  roomMembers,
  sessionMessages,
  sessions,
  subthreadUserFocus,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  readSubthreadResponder,
  replaceSubthreadResponder,
  clearSubthreadResponder,
  invalidateSubthreadResponders,
  resolveSubthreadAgentEligibility,
  removeRoomMember,
  updateRoomMemberAgentResponseMode,
  ResponderOpError,
} from "@nautilo/trust";

let db: ReturnType<typeof createDirectDb>;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(5);
});

afterAll(async () => {
  await db.end();
});

async function createUser(label: string): Promise<string> {
  const ts = Date.now();
  const [u] = await db
    .insert(users)
    .values({
      name: label,
      email: `${label}-${ts}-${randomUUID()}@d426p2tr.test`,
      handle: `${label}${ts}${Math.floor(Math.random() * 1e6)}`,
    })
    .returning({ id: users.id });
  if (!u) throw new Error("user");
  return u.id;
}

async function createHumanActor(ownerId: string, label: string): Promise<string> {
  const [a] = await db
    .insert(actors)
    .values({ ownerId, displayName: label, kind: "user" })
    .returning({ id: actors.id });
  if (!a) throw new Error("actor");
  return a.id;
}

async function createAgentActor(
  ownerId: string,
  label: string,
): Promise<{ actorId: string; agentId: string }> {
  const [ag] = await db
    .insert(agents)
    .values({ handle: `ag-${label}-${randomUUID()}` })
    .returning({ id: agents.id });
  if (!ag) throw new Error("agent");
  const [a] = await db
    .insert(actors)
    .values({ ownerId, displayName: label, kind: "agent", agentId: ag.id })
    .returning({ id: actors.id });
  if (!a) throw new Error("agent-actor");
  return { actorId: a.id, agentId: ag.id };
}

export {};

interface Fixture {
  userId: string;
  userActorId: string;
  botActorId: string;
  botAgentId: string;
  namespaceId: string;
  parentRoomId: string;
  subthreadRoomId: string;
  parentSessionId: string;
  anchorMessageId: number;
}

async function makeFixture(
  label: string,
  opts?: { botMode?: "active" | "mention_only" | "observe"; secondUser?: boolean },
): Promise<Fixture & { secondUserActorId?: string }> {
  const userId = await createUser(`d426p2tr${label}`);
  const userActorId = await createHumanActor(userId, label.toUpperCase());
  const bot = await createAgentActor(userId, `BOT-${label}`);
  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `ns-${randomUUID()}` })
    .returning({ id: namespaces.id });
  if (!ns) throw new Error("ns");

  const parentRoomId = randomUUID();
  await db.insert(rooms).values({
    id: parentRoomId,
    ownerId: userId,
    type: "private",
    label: `parent-${label}`,
    graphThreadId: `room:${parentRoomId}`,
    namespaceId: ns.id,
    humanActorIds: [userActorId],
    createdBy: userActorId,
    kind: "group",
  });
  await db.insert(roomMembers).values({ roomId: parentRoomId, actorId: userActorId, roomRole: "admin" });
  await db.insert(roomMembers).values({
    roomId: parentRoomId,
    actorId: bot.actorId,
    roomRole: "member",
    agentResponseMode: opts?.botMode ?? "mention_only",
  });

  const [parentSess] = await db
    .insert(sessions)
    .values({
      threadId: `room:${parentRoomId}`,
      ownerId: userId,
      personaId: "owner",
      agentId: bot.agentId,
      roomId: parentRoomId,
      channel: "tui",
    })
    .returning({ id: sessions.id });
  if (!parentSess) throw new Error("parentSess");
  const [anchor] = await db
    .insert(sessionMessages)
    .values({ sessionId: parentSess.id, role: "user", content: "anchor" })
    .returning({ id: sessionMessages.id });
  if (!anchor) throw new Error("anchor");

  const subthreadRoomId = randomUUID();
  await db.insert(rooms).values({
    id: subthreadRoomId,
    ownerId: userId,
    type: "private",
    label: `sub-${label}`,
    graphThreadId: `room:${subthreadRoomId}`,
    namespaceId: ns.id,
    humanActorIds: [userActorId],
    createdBy: userActorId,
    kind: "subthread",
    parentRoomId,
    threadRootMessageId: anchor.id,
  });
  await db.insert(roomMembers).values({ roomId: subthreadRoomId, actorId: userActorId, roomRole: "admin" });
  await db.insert(roomMembers).values({
    roomId: subthreadRoomId,
    actorId: bot.actorId,
    roomRole: "member",
    agentResponseMode: opts?.botMode ?? "mention_only",
  });

  const base: Fixture = {
    userId,
    userActorId,
    botActorId: bot.actorId,
    botAgentId: bot.agentId,
    namespaceId: ns.id,
    parentRoomId,
    subthreadRoomId,
    parentSessionId: parentSess.id,
    anchorMessageId: anchor.id,
  };

  if (opts?.secondUser) {
    const secondUserActorId = await createHumanActor(userId, `SECOND-${label}`);
    await db.insert(roomMembers).values({ roomId: parentRoomId, actorId: secondUserActorId, roomRole: "member" });
    await db.insert(roomMembers).values({ roomId: subthreadRoomId, actorId: secondUserActorId, roomRole: "member" });
    return { ...base, secondUserActorId };
  }

  return base;
}

async function cleanup(f: { subthreadRoomId: string; parentRoomId: string; namespaceId: string; botActorId: string; botAgentId: string; userActorId: string; userId: string; secondUserActorId?: string; parentSessionId: string }): Promise<void> {
  if (f.secondUserActorId) {
    await db.delete(actors).where(eq(actors.id, f.secondUserActorId)).catch(() => {});
  }
  await db.delete(subthreadUserFocus).where(eq(subthreadUserFocus.subthreadRoomId, f.subthreadRoomId));
  await db.delete(roomMembers).where(eq(roomMembers.roomId, f.subthreadRoomId));
  await db.delete(rooms).where(eq(rooms.id, f.subthreadRoomId));
  await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, f.parentSessionId));
  await db.delete(sessions).where(eq(sessions.id, f.parentSessionId));
  await db.delete(roomMembers).where(eq(roomMembers.roomId, f.parentRoomId));
  await db.delete(rooms).where(eq(rooms.id, f.parentRoomId));
  await db.delete(namespaces).where(eq(namespaces.id, f.namespaceId));
  await db.delete(actors).where(eq(actors.id, f.botActorId));
  await db.delete(agents).where(eq(agents.id, f.botAgentId));
  await db.delete(actors).where(eq(actors.id, f.userActorId));
  await db.delete(users).where(eq(users.id, f.userId));
}

async function readRow(subthreadRoomId: string, userActorId: string) {
  const [row] = await db
    .select()
    .from(subthreadUserFocus)
    .where(
      and(
        eq(subthreadUserFocus.subthreadRoomId, subthreadRoomId),
        eq(subthreadUserFocus.userActorId, userActorId),
      ),
    )
    .limit(1);
  return row ?? null;
}

const NOW = new Date("2026-07-15T10:00:00.000Z");
function later(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

describe("D426 Phase 2 — responder replace / read / clear", () => {
  test("replace establishes an active responder (revision 1) and read is available", async () => {
    const f = await makeFixture("basic");
    try {
      const row = await replaceSubthreadResponder(db, {
        subthreadRoomId: f.subthreadRoomId,
        userActorId: f.userActorId,
        botActorId: f.botActorId,
        source: "ui",
        now: NOW,
      });
      expect(row.status).toBe("active");
      expect(row.botActorId).toBe(f.botActorId);
      expect(row.source).toBe("ui");
      expect(row.revision).toBe(1);
      expect(row.establishedAt?.toISOString()).toBe(NOW.toISOString());

      const read = await readSubthreadResponder(db, {
        subthreadRoomId: f.subthreadRoomId,
        userActorId: f.userActorId,
        now: later(1000),
      });
      expect(read.available).toBe(true);
      expect(read.unavailableReason).toBeNull();
      expect(read.responder?.botActorId).toBe(f.botActorId);
      expect(read.effectiveMode).toBe("mention_only");
    } finally {
      await cleanup(f);
    }
  });

  test("idempotent re-replace with same bot + source does NOT bump revision", async () => {
    const f = await makeFixture("idem");
    try {
      await replaceSubthreadResponder(db, {
        subthreadRoomId: f.subthreadRoomId,
        userActorId: f.userActorId,
        botActorId: f.botActorId,
        source: "ui",
        now: NOW,
      });
      const row = await replaceSubthreadResponder(db, {
        subthreadRoomId: f.subthreadRoomId,
        userActorId: f.userActorId,
        botActorId: f.botActorId,
        source: "ui",
        now: later(1000),
      });
      expect(row.revision).toBe(1);
    } finally {
      await cleanup(f);
    }
  });

  test("replace with a different bot bumps revision and switches the selection", async () => {
    const f = await makeFixture("switch");
    try {
      await replaceSubthreadResponder(db, {
        subthreadRoomId: f.subthreadRoomId,
        userActorId: f.userActorId,
        botActorId: f.botActorId,
        source: "ui",
        now: NOW,
      });
      const bot2 = await createAgentActor(f.userId, `BOT2-switch`);
      // bot2 must be an eligible parent agent member for the switch to land.
      await db.insert(roomMembers).values({
        roomId: f.parentRoomId,
        actorId: bot2.actorId,
        roomRole: "member",
        agentResponseMode: "mention_only",
      });
      await db.insert(roomMembers).values({
        roomId: f.subthreadRoomId,
        actorId: bot2.actorId,
        roomRole: "member",
        agentResponseMode: "mention_only",
      });
      try {
        const row = await replaceSubthreadResponder(db, {
          subthreadRoomId: f.subthreadRoomId,
          userActorId: f.userActorId,
          botActorId: bot2.actorId,
          source: "mention",
          now: later(2000),
        });
        expect(row.revision).toBe(2);
        expect(row.botActorId).toBe(bot2.actorId);
        expect(row.source).toBe("mention");
      } finally {
        await db.delete(actors).where(eq(actors.id, bot2.actorId));
        await db.delete(agents).where(eq(agents.id, bot2.agentId));
      }
    } finally {
      await cleanup(f);
    }
  });

  test("read with no responder returns unavailable no_responder and never throws", async () => {
    const f = await makeFixture("noreply");
    try {
      const read = await readSubthreadResponder(db, {
        subthreadRoomId: f.subthreadRoomId,
        userActorId: f.userActorId,
        now: NOW,
      });
      expect(read.available).toBe(false);
      expect(read.unavailableReason).toBe("no_responder");
      expect(read.responder).toBeNull();
    } finally {
      await cleanup(f);
    }
  });

  test("clear sets status cleared, bumps revision, and read returns unavailable cleared", async () => {
    const f = await makeFixture("clear");
    try {
      await replaceSubthreadResponder(db, {
        subthreadRoomId: f.subthreadRoomId,
        userActorId: f.userActorId,
        botActorId: f.botActorId,
        source: "ui",
        now: NOW,
      });
      const cleared = await clearSubthreadResponder(db, {
        subthreadRoomId: f.subthreadRoomId,
        userActorId: f.userActorId,
        now: later(1000),
      });
      expect(cleared?.status).toBe("cleared");
      expect(cleared?.revision).toBe(2);

      // idempotent: clearing again does NOT bump revision
      const again = await clearSubthreadResponder(db, {
        subthreadRoomId: f.subthreadRoomId,
        userActorId: f.userActorId,
        now: later(2000),
      });
      expect(again?.revision).toBe(2);

      const read = await readSubthreadResponder(db, {
        subthreadRoomId: f.subthreadRoomId,
        userActorId: f.userActorId,
        now: later(3000),
      });
      expect(read.available).toBe(false);
      expect(read.unavailableReason).toBe("cleared");
    } finally {
      await cleanup(f);
    }
  });

  test("replace after cleared re-establishes active and bumps revision", async () => {
    const f = await makeFixture("reest");
    try {
      await replaceSubthreadResponder(db, {
        subthreadRoomId: f.subthreadRoomId,
        userActorId: f.userActorId,
        botActorId: f.botActorId,
        source: "ui",
        now: NOW,
      });
      await clearSubthreadResponder(db, {
        subthreadRoomId: f.subthreadRoomId,
        userActorId: f.userActorId,
        now: later(1000),
      });
      const row = await replaceSubthreadResponder(db, {
        subthreadRoomId: f.subthreadRoomId,
        userActorId: f.userActorId,
        botActorId: f.botActorId,
        source: "mention",
        now: later(2000),
      });
      expect(row.status).toBe("active");
      expect(row.revision).toBe(3);
    } finally {
      await cleanup(f);
    }
  });
});

describe("D426 Phase 2 — validated writes (non-subthread / non-member / ineligible bot)", () => {
  test("read and replace on a non-subthread room are unavailable / throw", async () => {
    const f = await makeFixture("nonsub");
    try {
      const read = await readSubthreadResponder(db, {
        subthreadRoomId: f.parentRoomId, // parent is kind='group', not subthread
        userActorId: f.userActorId,
        now: NOW,
      });
      expect(read.available).toBe(false);
      expect(read.unavailableReason).toBe("not_subthread");

      let err: unknown;
      try {
        await replaceSubthreadResponder(db, {
          subthreadRoomId: f.parentRoomId,
          userActorId: f.userActorId,
          botActorId: f.botActorId,
          source: "ui",
          now: NOW,
        });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ResponderOpError);
      expect((err as ResponderOpError).code).toBe("not_subthread");
    } finally {
      await cleanup(f);
    }
  });

  test("read and replace for a non-member human are unavailable / throw", async () => {
    const f = await makeFixture("nonmember");
    try {
      const strangerActorId = await createHumanActor(f.userId, "STRANGER");
      try {
        const read = await readSubthreadResponder(db, {
          subthreadRoomId: f.subthreadRoomId,
          userActorId: strangerActorId,
          now: NOW,
        });
        expect(read.available).toBe(false);
        expect(read.unavailableReason).toBe("not_member");

        let err: unknown;
        try {
          await replaceSubthreadResponder(db, {
            subthreadRoomId: f.subthreadRoomId,
            userActorId: strangerActorId,
            botActorId: f.botActorId,
            source: "ui",
            now: NOW,
          });
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(ResponderOpError);
        expect((err as ResponderOpError).code).toBe("not_member");
      } finally {
        await db.delete(actors).where(eq(actors.id, strangerActorId));
      }
    } finally {
      await cleanup(f);
    }
  });

  test("replace with a bot that is not an eligible parent agent member throws bot_not_eligible", async () => {
    const f = await makeFixture("ineligible");
    try {
      // A second agent that is NOT a member of the parent room.
      const bot2 = await createAgentActor(f.userId, `BOT2-inelig`);
      try {
        let err: unknown;
        try {
          await replaceSubthreadResponder(db, {
            subthreadRoomId: f.subthreadRoomId,
            userActorId: f.userActorId,
            botActorId: bot2.actorId,
            source: "ui",
            now: NOW,
          });
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(ResponderOpError);
        expect((err as ResponderOpError).code).toBe("bot_not_eligible");

        // No row was written.
        const row = await readRow(f.subthreadRoomId, f.userActorId);
        expect(row).toBeNull();
      } finally {
        await db.delete(actors).where(eq(actors.id, bot2.actorId));
        await db.delete(agents).where(eq(agents.id, bot2.agentId));
      }
    } finally {
      await cleanup(f);
    }
  });
});

describe("D426 Phase 2 §2.2 — dynamic parent eligibility (observe cannot drift in child rooms)", () => {
  test("resolveSubthreadAgentEligibility returns eligible for a parent agent member", async () => {
    const f = await makeFixture("elig");
    try {
      const elig = await resolveSubthreadAgentEligibility(db, f.subthreadRoomId, f.botActorId);
      expect(elig.status).toBe("eligible");
      expect(elig.mode).toBe("mention_only");
      expect(elig.parentRoomId).toBe(f.parentRoomId);
    } finally {
      await cleanup(f);
    }
  });

  test("parent observe makes the child responder unavailable even when the child row drifted to active", async () => {
    const f = await makeFixture("drift");
    try {
      // Flip parent to observe (eager-invalidates the responder too).
      await updateRoomMemberAgentResponseMode(f.parentRoomId, f.botActorId, "observe");

      // Simulate a drifted child row that says 'active' (the drift this
      // rule exists to neutralize).
      await db
        .update(roomMembers)
        .set({ agentResponseMode: "active" })
        .where(
          and(
            eq(roomMembers.roomId, f.subthreadRoomId),
            eq(roomMembers.actorId, f.botActorId),
          ),
        );

      // The resolver reads the PARENT, so observe still wins.
      const elig = await resolveSubthreadAgentEligibility(db, f.subthreadRoomId, f.botActorId);
      expect(elig.status).toBe("unavailable_observe");
      expect(elig.mode).toBe("observe");
    } finally {
      await cleanup(f);
    }
  });

  test("lazy invalidation on read when parent flipped to observe without the eager hook", async () => {
    const f = await makeFixture("lazyobs");
    try {
      await replaceSubthreadResponder(db, {
        subthreadRoomId: f.subthreadRoomId,
        userActorId: f.userActorId,
        botActorId: f.botActorId,
        source: "ui",
        now: NOW,
      });
      // Bypass the eager hook by setting observe directly on the parent row.
      await db
        .update(roomMembers)
        .set({ agentResponseMode: "observe" })
        .where(
          and(
            eq(roomMembers.roomId, f.parentRoomId),
            eq(roomMembers.actorId, f.botActorId),
          ),
        );

      const read = await readSubthreadResponder(db, {
        subthreadRoomId: f.subthreadRoomId,
        userActorId: f.userActorId,
        now: later(1000),
      });
      expect(read.available).toBe(false);
      expect(read.unavailableReason).toBe("unavailable_observe");

      const stored = await readRow(f.subthreadRoomId, f.userActorId);
      expect(stored?.status).toBe("invalidated");
      expect(stored?.invalidatedReason).toBe("unavailable_observe");
      expect(stored?.revision).toBe(2); // lazily bumped
    } finally {
      await cleanup(f);
    }
  });

  test("lazy invalidation on read when the subthread is archived", async () => {
    const f = await makeFixture("arch");
    try {
      await replaceSubthreadResponder(db, {
        subthreadRoomId: f.subthreadRoomId,
        userActorId: f.userActorId,
        botActorId: f.botActorId,
        source: "affinity",
        now: NOW,
      });
      await db
        .update(rooms)
        .set({ archivedAt: NOW })
        .where(eq(rooms.id, f.subthreadRoomId));

      const read = await readSubthreadResponder(db, {
        subthreadRoomId: f.subthreadRoomId,
        userActorId: f.userActorId,
        now: later(1000),
      });
      expect(read.available).toBe(false);
      expect(read.unavailableReason).toBe("unavailable_archived");

      const stored = await readRow(f.subthreadRoomId, f.userActorId);
      expect(stored?.status).toBe("invalidated");
      expect(stored?.invalidatedReason).toBe("unavailable_archived");
    } finally {
      await cleanup(f);
    }
  });

  test("lazy invalidation on read when the bot was removed from the parent (no eager hook)", async () => {
    const f = await makeFixture("lazynotmem");
    try {
      await replaceSubthreadResponder(db, {
        subthreadRoomId: f.subthreadRoomId,
        userActorId: f.userActorId,
        botActorId: f.botActorId,
        source: "ui",
        now: NOW,
      });
      // Bypass removeRoomMember (which eager-invalidates) by deleting the
      // parent room_members row directly.
      await db
        .delete(roomMembers)
        .where(
          and(
            eq(roomMembers.roomId, f.parentRoomId),
            eq(roomMembers.actorId, f.botActorId),
          ),
        );

      const read = await readSubthreadResponder(db, {
        subthreadRoomId: f.subthreadRoomId,
        userActorId: f.userActorId,
        now: later(1000),
      });
      expect(read.available).toBe(false);
      expect(read.unavailableReason).toBe("unavailable_not_member");

      const stored = await readRow(f.subthreadRoomId, f.userActorId);
      expect(stored?.status).toBe("invalidated");
      expect(stored?.invalidatedReason).toBe("unavailable_not_member");
    } finally {
      await cleanup(f);
    }
  });
});

describe("D426 Phase 2 §2.2 — eager invalidation hooks on membership mutation", () => {
  test("updateRoomMemberAgentResponseMode → observe eagerly invalidates active responders", async () => {
    const f = await makeFixture("eagerobs");
    try {
      await replaceSubthreadResponder(db, {
        subthreadRoomId: f.subthreadRoomId,
        userActorId: f.userActorId,
        botActorId: f.botActorId,
        source: "ui",
        now: NOW,
      });
      const before = await readRow(f.subthreadRoomId, f.userActorId);
      expect(before?.status).toBe("active");
      expect(before?.revision).toBe(1);

      await updateRoomMemberAgentResponseMode(f.parentRoomId, f.botActorId, "observe");

      const stored = await readRow(f.subthreadRoomId, f.userActorId);
      expect(stored?.status).toBe("invalidated");
      expect(stored?.invalidatedReason).toBe("observe");
      expect(stored?.revision).toBe(2);

      const read = await readSubthreadResponder(db, {
        subthreadRoomId: f.subthreadRoomId,
        userActorId: f.userActorId,
        now: later(1000),
      });
      expect(read.available).toBe(false);
      expect(read.unavailableReason).toBe("invalidated");
    } finally {
      await cleanup(f);
    }
  });

  test("removeRoomMember (parent, agent) eagerly invalidates active responders", async () => {
    const f = await makeFixture("eagerrem");
    try {
      await replaceSubthreadResponder(db, {
        subthreadRoomId: f.subthreadRoomId,
        userActorId: f.userActorId,
        botActorId: f.botActorId,
        source: "ui",
        now: NOW,
      });

      await removeRoomMember(f.parentRoomId, f.botActorId, {});

      const stored = await readRow(f.subthreadRoomId, f.userActorId);
      expect(stored?.status).toBe("invalidated");
      expect(stored?.invalidatedReason).toBe("parent_membership_removed");
      expect(stored?.revision).toBe(2);

      const read = await readSubthreadResponder(db, {
        subthreadRoomId: f.subthreadRoomId,
        userActorId: f.userActorId,
        now: later(1000),
      });
      expect(read.available).toBe(false);
      // Stored is already invalidated by the eager hook.
      expect(read.unavailableReason).toBe("invalidated");
    } finally {
      await cleanup(f);
    }
  });

  test("invalidateSubthreadResponders only touches active rows for the targeted bot", async () => {
    const f = await makeFixture("bulk", { secondUser: true });
    try {
      const bot2 = await createAgentActor(f.userId, `BOT2-bulk`);
      // Make bot2 a parent + subthread member so it is eligible.
      await db.insert(roomMembers).values({
        roomId: f.parentRoomId,
        actorId: bot2.actorId,
        roomRole: "member",
        agentResponseMode: "mention_only",
      });
      await db.insert(roomMembers).values({
        roomId: f.subthreadRoomId,
        actorId: bot2.actorId,
        roomRole: "member",
        agentResponseMode: "mention_only",
      });
      try {
        // Human A selects bot1; second human selects bot2.
        await replaceSubthreadResponder(db, {
          subthreadRoomId: f.subthreadRoomId,
          userActorId: f.userActorId,
          botActorId: f.botActorId,
          source: "ui",
          now: NOW,
        });
        await replaceSubthreadResponder(db, {
          subthreadRoomId: f.subthreadRoomId,
          userActorId: f.secondUserActorId!,
          botActorId: bot2.actorId,
          source: "ui",
          now: NOW,
        });

        const n = await invalidateSubthreadResponders(db, {
          subthreadRoomIds: [f.subthreadRoomId],
          botActorId: f.botActorId,
          reason: "test_invalidate",
          now: later(1000),
        });
        expect(n).toBe(1);

        const aRow = await readRow(f.subthreadRoomId, f.userActorId);
        const bRow = await readRow(f.subthreadRoomId, f.secondUserActorId!);
        expect(aRow?.status).toBe("invalidated");
        expect(aRow?.invalidatedReason).toBe("test_invalidate");
        // second human's responder (different bot) is untouched.
        expect(bRow?.status).toBe("active");
      } finally {
        await db.delete(actors).where(eq(actors.id, bot2.actorId));
        await db.delete(agents).where(eq(agents.id, bot2.agentId));
      }
    } finally {
      await cleanup(f);
    }
  });
});

describe("D426 Phase 2 §2.5 — requester-private isolation between two humans", () => {
  test("two humans select different Genies in the same subthread without cross-user leakage", async () => {
    const f = await makeFixture("iso", { secondUser: true });
    try {
      const bot2 = await createAgentActor(f.userId, `BOT2-iso`);
      await db.insert(roomMembers).values({
        roomId: f.parentRoomId,
        actorId: bot2.actorId,
        roomRole: "member",
        agentResponseMode: "mention_only",
      });
      await db.insert(roomMembers).values({
        roomId: f.subthreadRoomId,
        actorId: bot2.actorId,
        roomRole: "member",
        agentResponseMode: "mention_only",
      });
      try {
        await replaceSubthreadResponder(db, {
          subthreadRoomId: f.subthreadRoomId,
          userActorId: f.userActorId,
          botActorId: f.botActorId,
          source: "ui",
          now: NOW,
        });
        await replaceSubthreadResponder(db, {
          subthreadRoomId: f.subthreadRoomId,
          userActorId: f.secondUserActorId!,
          botActorId: bot2.actorId,
          source: "mention",
          now: later(500),
        });

        const readA = await readSubthreadResponder(db, {
          subthreadRoomId: f.subthreadRoomId,
          userActorId: f.userActorId,
          now: later(1000),
        });
        const readB = await readSubthreadResponder(db, {
          subthreadRoomId: f.subthreadRoomId,
          userActorId: f.secondUserActorId!,
          now: later(1500),
        });

        expect(readA.responder?.botActorId).toBe(f.botActorId);
        expect(readA.responder?.source).toBe("ui");
        expect(readB.responder?.botActorId).toBe(bot2.actorId);
        expect(readB.responder?.source).toBe("mention");
        expect(readA.available).toBe(true);
        expect(readB.available).toBe(true);

        // Clearing A's responder does not affect B.
        await clearSubthreadResponder(db, {
          subthreadRoomId: f.subthreadRoomId,
          userActorId: f.userActorId,
          now: later(2000),
        });
        const readB2 = await readSubthreadResponder(db, {
          subthreadRoomId: f.subthreadRoomId,
          userActorId: f.secondUserActorId!,
          now: later(2500),
        });
        expect(readB2.available).toBe(true);
        expect(readB2.responder?.botActorId).toBe(bot2.actorId);
      } finally {
        await db.delete(actors).where(eq(actors.id, bot2.actorId));
        await db.delete(agents).where(eq(agents.id, bot2.agentId));
      }
    } finally {
      await cleanup(f);
    }
  });
});
// End D426 persistent responder integration coverage.
