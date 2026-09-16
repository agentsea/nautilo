/**
 * M077 — cross-user resume: a peer cannot act on the owner's thread.
 * (Post-M254 resume routes preserve thread-ownership precedence over the
 * invocation Capability denial; the unrelated PIN route keeps its guest 401.)
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { and, eq, inArray, namespaces, rooms, roomMembers, users, actors, channelIdentities } from "@nautilo/db";
import { composeFederatedId, getServerHostname } from "@nautilo/config";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

let fx: AppFixture;
const nsIds: string[] = [];

beforeAll(async () => {
  fx = await setupOwnerAppFixture({ suiteName: "authrx" });
  for (const graphThreadId of ["test-thread-1", "test-thread-2"] as const) {
    const [ns] = await fx.db
      .insert(namespaces)
      .values({ scope: "room", label: `authrx-${graphThreadId}` })
      .returning({ id: namespaces.id });
    if (!ns) throw new Error("namespace");
    nsIds.push(ns.id);
    const [room] = await fx.db
      .insert(rooms)
      .values({
        ownerId: fx.ownerId,
        type: "private",
        label: `authrx ${graphThreadId}`,
        graphThreadId,
        namespaceId: ns.id,
        humanActorIds: [fx.ownerActorId],
      })
      .returning({ id: rooms.id });
    if (!room) throw new Error("room");
    await fx.db.insert(roomMembers).values({
      roomId: room.id,
      actorId: fx.ownerActorId,
      roomRole: "member",
    });
  }
});

afterAll(async () => {
  if (!fx) return;
  await fx.db
    .delete(rooms)
    .where(
      and(eq(rooms.ownerId, fx.ownerId), inArray(rooms.graphThreadId, ["test-thread-1", "test-thread-2"])),
    );
  if (nsIds.length > 0) {
    await fx.db.delete(namespaces).where(inArray(namespaces.id, nsIds));
  }
  await fx.cleanup();
});

describe("auth resume cross-user (Logto JWT)", () => {
  test("peer cannot prove-and-resume / approval-reply / enroll-Pin on owner thread; owner can", async () => {
    const peerPin = "918273";
    const peerHandle = `authrxp${Date.now().toString(36).slice(-8)}`;
    const [u] = await fx.db
      .insert(users)
      .values({
        name: "authrx-peer",
        email: `authrx-peer-${Date.now()}@test.local`,
        handle: peerHandle,
        externalId: randomUUID(),
      })
      .returning({ id: users.id });
    if (!u) throw new Error("user");
    const [a] = await fx.db
      .insert(actors)
      .values({
        ownerId: u.id,
        displayName: "Peer",
        trustState: "verified",
        kind: "user",
      })
      .returning({ id: actors.id });
    if (!a) throw new Error("actor");

    const fed = composeFederatedId(peerHandle, getServerHostname());
    await fx.db.insert(channelIdentities).values([
      { channel: "tui", externalId: fed, userId: u.id, verifiedAt: new Date() },
      { channel: "workbench", externalId: fed, userId: u.id, verifiedAt: new Date() },
    ]);

    const tokenB = await fx.mintSessionBearerForUser(a.id, u.id);

    // The peer here is seated WITHOUT any server-Group membership and resolves
    // to actorRole="guest". Resume ownership/binding still has precedence:
    // it returns the existing non-disclosing Forbidden response, never the
    // invoke_agents Capability denial. PIN enrollment is a separate action and
    // retains its existing guest 401.
    const pr = await authedInject(fx.app, {
      method: "POST",
      url: "/api/auth/prove-and-resume",
      bearer: tokenB,
      payload: { denied: true, threadId: "test-thread-1" },
    });
    expect(pr.statusCode).toBe(403);
    expect(JSON.parse(pr.body)).toEqual({ error: "Forbidden" });

    const ar = await authedInject(fx.app, {
      method: "POST",
      url: "/api/auth/approval-reply",
      bearer: tokenB,
      payload: { verb: "deny", threadId: "test-thread-1" },
    });
    expect(ar.statusCode).toBe(403);
    expect(JSON.parse(ar.body)).toEqual({ error: "Forbidden" });

    const pinEnroll = await authedInject(fx.app, {
      method: "POST",
      url: "/api/auth/pin",
      bearer: tokenB,
      payload: { newPin: peerPin, threadId: "test-thread-1" },
    });
    expect(pinEnroll.statusCode).toBe(401);

    const tokenOwner = await fx.mintOwnerBearer();
    const prOk = await authedInject(fx.app, {
      method: "POST",
      url: "/api/auth/prove-and-resume",
      bearer: tokenOwner,
      payload: { denied: true, threadId: "test-thread-1" },
    });
    expect(prOk.statusCode).toBe(200);

    const arOk = await authedInject(fx.app, {
      method: "POST",
      url: "/api/auth/approval-reply",
      bearer: tokenOwner,
      payload: { verb: "room", threadId: "test-thread-1" },
    });
    expect(arOk.statusCode).toBe(200);

    await fx.db.delete(channelIdentities).where(eq(channelIdentities.userId, u.id));
    await fx.db.delete(actors).where(eq(actors.ownerId, u.id));
    await fx.db.delete(users).where(eq(users.id, u.id));
  });
});
