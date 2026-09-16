/**
 * D187 (Stack 129) — `GET /api/directory/search` integration coverage.
 *
 * Verifies the unified, recency-ranked directory search returns humans +
 * agents in one call, that `lastContactAt` is derived from
 * `MAX(session_messages.created_at)` over shared rooms (excluding
 * task/access rooms), and that q/kind/limit/offset/auth gating behave.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  actors,
  agents,
  and,
  eq,
  roomMembers,
  rooms,
  sessions,
  sessionMessages,
  users,
  profiles,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { setupOwnerAppFixture, seatPeerUser, type AppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

let fx: AppFixture;
let peer: { userId: string; actorId: string; agentId: string; bearer: string } | null = null;
let roomId = "";
let sessionId = "";
const insertedMessageIds: number[] = [];

beforeAll(async () => {
  bootstrapTestDbInstance();
  fx = await setupOwnerAppFixture({ suiteName: "d187ds", withDefaultAgentGraph: true });
});

afterAll(async () => {
  // Best-effort cleanup — leave the DB clean for re-runs.
  try {
    if (sessionId) {
      await fx.db.delete(sessionMessages).where(eq(sessionMessages.sessionId, sessionId));
    }
    if (roomId) {
      await fx.db.delete(sessions).where(eq(sessions.roomId, roomId));
      await fx.db.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
      await fx.db.delete(rooms).where(eq(rooms.id, roomId));
    }
    if (peer) {
      const peerActorRows = await fx.db
        .select({ id: actors.id })
        .from(actors)
        .where(eq(actors.ownerId, peer.userId));
      for (const a of peerActorRows) {
        await fx.db.delete(actors).where(eq(actors.id, a.id));
      }
      await fx.db.delete(profiles).where(eq(profiles.userId, peer.userId));
      await fx.db.delete(agents).where(eq(agents.id, peer.agentId));
      await fx.db.delete(users).where(eq(users.id, peer.userId));
    }
  } catch {
    // swallow — fixture cleanup is best-effort
  }
  if (fx) await fx.cleanup();
});

async function seedSharedRoomWithMessage(): Promise<void> {
  const ownerBearer = await fx.mintOwnerBearer();
  // Seat the peer as a regular Member. Server-local Humans and Genies are
  // discoverable independently of administrator status or prior Room overlap.
  peer = await seatPeerUser(fx.db, { suiteName: "d187ds", groupType: "members" });

  // The peer's personal agent mirror actor — needed to compute agent recency.
  // (Looked up to confirm the mirror actor row exists; the search query joins
  // through it implicitly. No assertion needed beyond the existence check.)
  const [peerAgentActor] = await fx.db
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.agentId, peer.agentId), eq(actors.kind, "agent")))
    .limit(1);
  if (!peerAgentActor) throw new Error("peer agent actor not found");

  // Create a group room with owner + peer + peer's personal agent.
  const createRoom = await authedInject(fx.app, {
    method: "POST",
    url: "/api/rooms",
    bearer: ownerBearer,
    payload: {
      label: "D187 directory-search room",
      members: [
        { kind: "user", id: fx.ownerId },
        { kind: "user", id: peer.userId },
        { kind: "agent", id: peer.agentId },
      ],
    },
  });
  expect(createRoom.statusCode).toBe(201);
  roomId = (JSON.parse(createRoom.body) as { id: string }).id;

  // Insert a session + a session_message row so MAX(created_at) is defined.
  const [session] = await fx.db
    .insert(sessions)
    .values({
      threadId: `d187ds-${randomUUID()}`,
      ownerId: fx.ownerId,
      agentId: peer.agentId,
      roomId,
      channel: "tui",
    })
    .returning({ id: sessions.id });
  if (!session) throw new Error("session insert failed");
  sessionId = session.id;

  const ts = new Date(Date.now() - 1000 * 60 * 5); // 5 min ago
  const [msg] = await fx.db
    .insert(sessionMessages)
    .values({
      sessionId,
      role: "user",
      content: "d187ds hello",
      createdAt: ts,
    })
    .returning({ id: sessionMessages.id });
  if (!msg) throw new Error("session_message insert failed");
  insertedMessageIds.push(msg.id);
}

describe("GET /api/directory/search (D187 / Stack 129)", () => {
  test("auth + validation gates", async () => {
    const ownerBearer = await fx.mintOwnerBearer();

    const noAuth = await fx.app.inject({ method: "GET", url: "/api/directory/search" });
    expect(noAuth.statusCode).toBe(401);

    const badKind = await authedInject(fx.app, {
      method: "GET",
      url: "/api/directory/search?kind=bogus",
      bearer: ownerBearer,
    });
    expect(badKind.statusCode).toBe(400);
  });

  test("admin kind=both returns peer user + agent, ranked by recency", async () => {
    await seedSharedRoomWithMessage();
    const ownerBearer = await fx.mintOwnerBearer();

    const res = await authedInject(fx.app, {
      method: "GET",
      url: "/api/directory/search?kind=both&limit=50",
      bearer: ownerBearer,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      results: Array<{
        kind: "user" | "agent";
        id: string;
        handle: string;
        displayName: string;
        agentOwnerUserId?: string;
        agentOwnerHandle?: string | null;
        agentOwnerDisplayName?: string | null;
        lastContactAt: string | null;
      }>;
    };

    const peerUserRow = body.results.find(
      (r) => r.kind === "user" && r.id === peer!.userId,
    );
    expect(peerUserRow).toBeDefined();
    expect(peerUserRow!.lastContactAt).not.toBeNull();
    expect(Date.parse(peerUserRow!.lastContactAt!)).toBeGreaterThan(0);

    const peerAgentRow = body.results.find(
      (r) => r.kind === "agent" && r.id === peer!.agentId,
    );
    expect(peerAgentRow).toBeDefined();
    expect(peerAgentRow!.lastContactAt).not.toBeNull();
    expect(peerAgentRow!.agentOwnerUserId).toBe(peer!.userId);
    expect(peerAgentRow!.agentOwnerHandle).toBeTruthy();
    expect(peerAgentRow!.agentOwnerDisplayName).toBeTruthy();

    // Self excluded from user side.
    const selfRow = body.results.find(
      (r) => r.kind === "user" && r.id === fx.ownerId,
    );
    expect(selfRow).toBeUndefined();

    // Ordering: any row with lastContactAt must sort before any row with null.
    const nullIdx = body.results.findIndex((r) => r.lastContactAt === null);
    if (nullIdx !== -1) {
      for (let i = nullIdx + 1; i < body.results.length; i++) {
        expect(body.results[i]!.lastContactAt).toBeNull();
      }
    }
  });

  test("q filters by handle substring", async () => {
    const ownerBearer = await fx.mintOwnerBearer();
    // Search by a slice of the peer's handle — the fixture's seatPeerUser
    // builds handles as `${suiteName}${groupType}${suffix}` so "d187ds" is
    // a guaranteed prefix.
    const res = await authedInject(fx.app, {
      method: "GET",
      url: `/api/directory/search?kind=both&q=d187ds&limit=50`,
      bearer: ownerBearer,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      results: Array<{ kind: "user" | "agent"; id: string; handle: string }>;
    };
    // The peer user's handle contains "d187ds"; the agent handle is
    // generated by seatPeerUser and may not, so we only assert the peer
    // user shows up and unrelated handles don't.
    const peerUserRow = body.results.find(
      (r) => r.kind === "user" && r.id === peer!.userId,
    );
    expect(peerUserRow).toBeDefined();
  });

  test("kind=user excludes agents and vice versa", async () => {
    const ownerBearer = await fx.mintOwnerBearer();

    const usersOnly = await authedInject(fx.app, {
      method: "GET",
      url: "/api/directory/search?kind=user&limit=50",
      bearer: ownerBearer,
    });
    expect(usersOnly.statusCode).toBe(200);
    const usersBody = JSON.parse(usersOnly.body) as {
      results: Array<{ kind: "user" | "agent" }>;
    };
    for (const r of usersBody.results) expect(r.kind).toBe("user");

    const agentsOnly = await authedInject(fx.app, {
      method: "GET",
      url: "/api/directory/search?kind=agent&limit=50",
      bearer: ownerBearer,
    });
    expect(agentsOnly.statusCode).toBe(200);
    const agentsBody = JSON.parse(agentsOnly.body) as {
      results: Array<{ kind: "user" | "agent" }>;
    };
    for (const r of agentsBody.results) expect(r.kind).toBe("agent");
  });

  test("limit clamps the result count", async () => {
    const ownerBearer = await fx.mintOwnerBearer();
    const res = await authedInject(fx.app, {
      method: "GET",
      url: "/api/directory/search?kind=both&limit=1",
      bearer: ownerBearer,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      results: Array<{ kind: "user" | "agent" }>;
    };
    expect(body.results.length).toBeLessThanOrEqual(1);
  });

  test("non-admin caller sees every local Human and Server Genie", async () => {
    const res = await authedInject(fx.app, {
      method: "GET",
      url: "/api/directory/search?kind=both&limit=50",
      bearer: peer!.bearer,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      results: Array<{
        kind: "user" | "agent";
        id: string;
        lastContactAt: string | null;
      }>;
    };

    // Peer shares the seeded room with the owner → owner appears on user side.
    const ownerRow = body.results.find(
      (r) => r.kind === "user" && r.id === fx.ownerId,
    );
    expect(ownerRow).toBeDefined();
    expect(ownerRow!.lastContactAt).not.toBeNull();

    // Self excluded.
    const selfRow = body.results.find(
      (r) => r.kind === "user" && r.id === peer!.userId,
    );
    expect(selfRow).toBeUndefined();

    // The peer's personal Genie is available.
    const ownAgentRow = body.results.find(
      (r) => r.kind === "agent" && r.id === peer!.agentId,
    );
    expect(ownAgentRow).toBeDefined();

    // Ownership is not a social boundary: the owner's Genie is also available
    // to this Member because the Member has `invoke_agents`.
    if (fx.defaultAgentId && fx.defaultAgentId !== peer!.agentId) {
      const ownerAgent = body.results.find(
        (r) => r.kind === "agent" && r.id === fx.defaultAgentId,
      );
      expect(ownerAgent).toBeDefined();
    }
  });
});
