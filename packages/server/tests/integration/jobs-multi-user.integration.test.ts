/**
 * M077 — cross-user isolation for `GET /api/jobs/:id`.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { hashPin } from "@nautilo/trust";
import { composeFederatedId, getServerHostname } from "@nautilo/config";
import {
  users,
  actors,
  agents,
  credentials,
  channelIdentities,
  groupMembers,
  jobs,
  profiles,
  eq,
} from "@nautilo/db";
import {
  seatPeerUser,
  setupOwnerAppFixture,
  type AppFixture,
} from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

let fx: AppFixture;

beforeAll(async () => {
  fx = await setupOwnerAppFixture({ suiteName: "jobs-mu" });
});

afterAll(async () => {
  if (!fx) return;
  await fx.cleanup();
});

describe("jobs multi-user (Logto JWT)", () => {
  test("Guest without invoke_agents cannot create a direct Job", async () => {
    const guest = await seatPeerUser(fx.db, {
      suiteName: "jobsmu",
      groupType: "guests",
    });
    try {
      const before = await fx.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(eq(jobs.ownerId, guest.userId));
      const res = await authedInject(fx.app, {
        method: "POST",
        url: "/api/jobs",
        bearer: guest.bearer,
        payload: { task: "must not start" },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({
        error: "invoke_agents_required",
        code: "invoke_agents_required",
        capability: "invoke_agents",
      });
      const after = await fx.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(eq(jobs.ownerId, guest.userId));
      expect(after).toEqual(before);
    } finally {
      await fx.db.delete(profiles).where(eq(profiles.userId, guest.userId));
      await fx.db.delete(actors).where(eq(actors.ownerId, guest.userId));
      await fx.db.delete(agents).where(eq(agents.id, guest.agentId));
      await fx.db.delete(groupMembers).where(eq(groupMembers.userId, guest.userId));
      await fx.db
        .delete(channelIdentities)
        .where(eq(channelIdentities.userId, guest.userId));
      await fx.db.delete(credentials).where(eq(credentials.userId, guest.userId));
      await fx.db.delete(users).where(eq(users.id, guest.userId));
    }
  });

  test("user B cannot read user A job by id (404)", async () => {
    const tokenA = await fx.mintOwnerBearer();
    const createRes = await authedInject(fx.app, {
      method: "POST",
      url: "/api/jobs",
      bearer: tokenA,
      payload: { task: "noop" },
    });
    expect(createRes.statusCode).toBe(202);
    const { jobId } = JSON.parse(createRes.body) as { jobId: string };

    const otherPin = "918273";
    const peerHandle = `jmpeer${Date.now().toString(36).slice(-8)}`;
    const [u] = await fx.db
      .insert(users)
      .values({
        name: "jobs-mu-peer",
        email: `jobs-mu-peer-${Date.now()}@test.local`,
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
    await fx.db.insert(credentials).values({
      userId: u.id,
      type: "pin",
      value: await hashPin(otherPin),
    });
    const fed = composeFederatedId(peerHandle, getServerHostname());
    await fx.db.insert(channelIdentities).values([
      { channel: "tui", externalId: fed, userId: u.id, verifiedAt: new Date() },
      { channel: "workbench", externalId: fed, userId: u.id, verifiedAt: new Date() },
    ]);

    const tokenB = await fx.mintSessionBearerForUser(a.id, u.id);
    const getRes = await authedInject(fx.app, {
      method: "GET",
      url: `/api/jobs/${jobId}`,
      bearer: tokenB,
    });
    expect(getRes.statusCode).toBe(404);

    await fx.db.delete(jobs).where(eq(jobs.id, jobId));
    await fx.db.delete(channelIdentities).where(eq(channelIdentities.userId, u.id));
    await fx.db.delete(credentials).where(eq(credentials.userId, u.id));
    await fx.db.delete(actors).where(eq(actors.ownerId, u.id));
    await fx.db.delete(users).where(eq(users.id, u.id));
  });
});
