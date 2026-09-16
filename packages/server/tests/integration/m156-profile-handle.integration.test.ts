/**
 * M156 — HTTP integration coverage for the editable Agent handle and the
 * rename → auto-derive flow through `PUT /api/profile` +
 * `PATCH /api/profile/agent-handle`.
 *
 * Maps to ISSUE-M156 §5 (Integration → server profile-route test) and
 * Blast-radius S2 (derive on rename), S3 (uniqueness 409 + freeze on
 * customize + invalid-format 400). The shared test bootstrap defaults to the
 * disposable `test-cruft` database:
 *   bun test packages/server/tests/integration/m156-profile-handle.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import {
  actors,
  agents,
  createDirectDb,
  ensureDatabase,
  eq,
  profiles,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { profileRoutes } from "../../src/routes/profile";

let db: ReturnType<typeof createDirectDb>;
const ts = Date.now().toString(36);

const createdUserIds = new Set<string>();
const createdAgentIds = new Set<string>();
const createdActorIds = new Set<string>();

function rand(): string {
  return (Math.random().toString(36).slice(2, 7).replace(/[^a-z]/g, "x") || "abc");
}

async function seedUserWithAgent(): Promise<{
  userId: string;
  agentId: string;
  ownerHandle: string;
}> {
  const tag = rand();
  const ownerHandle = `m156h${tag}`;
  const [u] = await db
    .insert(users)
    .values({
      name: "M156 route owner",
      email: `m156-route-${tag}-${ts}@test.local`,
      handle: ownerHandle,
    })
    .returning({ id: users.id });
  if (!u) throw new Error("user insert failed");
  createdUserIds.add(u.id);

  const [a] = await db
    .insert(agents)
    .values({ handle: `genie_${ownerHandle}` })
    .returning({ id: agents.id });
  if (!a) throw new Error("agent insert failed");
  createdAgentIds.add(a.id);

  const [actor] = await db
    .insert(actors)
    .values({ ownerId: u.id, displayName: "Genie", kind: "agent", agentId: a.id })
    .returning({ id: actors.id });
  if (!actor) throw new Error("actor insert failed");
  createdActorIds.add(actor.id);

  return { userId: u.id, agentId: a.id, ownerHandle };
}

async function makeBareAgent(handle: string): Promise<void> {
  const [a] = await db.insert(agents).values({ handle }).returning({ id: agents.id });
  if (!a) throw new Error("bare agent insert failed");
  createdAgentIds.add(a.id);
}

async function makeBareHuman(handle: string): Promise<void> {
  const [u] = await db
    .insert(users)
    .values({
      name: "M156 human collider",
      email: `m156-human-${rand()}-${ts}@test.local`,
      handle,
    })
    .returning({ id: users.id });
  if (!u) throw new Error("human collider insert failed");
  createdUserIds.add(u.id);
}

async function readAgentHandle(agentId: string): Promise<string | null> {
  const [row] = await db
    .select({ handle: agents.handle })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return row?.handle ?? null;
}

function makeApp(userId: string): FastifyInstance {
  const app = Fastify({ logger: false });
  app.decorateRequest("policyContext", null);
  app.decorateRequest("memoryEnvelope", null);
  app.decorateRequest("sessionActorId", null);
  app.decorateRequest("sessionUserId", null);
  profileRoutes(app, { ownerId: userId });
  app.addHook("preHandler", async (request) => {
    (request as { sessionUserId?: string | null }).sessionUserId = userId;
    (request as { policyContext?: { actorRole: string; actorId: string } }).policyContext = {
      actorRole: "owner",
      actorId: userId,
    };
  });
  return app;
}

const apps: FastifyInstance[] = [];

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);
});

afterAll(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  if (!db) return;
  for (const agentId of createdAgentIds) {
    await db.delete(profiles).where(eq(profiles.agentId, agentId));
  }
  for (const actorId of createdActorIds) {
    await db.delete(actors).where(eq(actors.id, actorId));
  }
  for (const agentId of createdAgentIds) {
    await db.delete(agents).where(eq(agents.id, agentId));
  }
  for (const userId of createdUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
  await db.end();
});

describe("M156 PUT /api/profile — rename auto-derives the handle (S2)", () => {
  test("name change on a fresh agent derives the handle; GET returns name + derived handle", async () => {
    const { userId, agentId } = await seedUserWithAgent();
    const app = makeApp(userId);
    apps.push(app);

    const tag = rand();
    const name = `Robo ${tag}`;
    const expectedHandle = `robo_${tag}`;

    const put = await app.inject({ method: "PUT", url: "/api/profile", payload: { name } });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({ method: "GET", url: "/api/profile" });
    expect(get.statusCode).toBe(200);
    const body = JSON.parse(get.body) as { agent: { name: string; handle: string } };
    expect(body.agent.name).toBe(name);
    expect(body.agent.handle).toBe(expectedHandle);
    expect(await readAgentHandle(agentId)).toBe(expectedHandle);
  });

  test("re-saving the same name is idempotent (no handle churn)", async () => {
    const { userId, agentId } = await seedUserWithAgent();
    const app = makeApp(userId);
    apps.push(app);
    const name = `Echo ${rand()}`;

    const first = await app.inject({ method: "PUT", url: "/api/profile", payload: { name } });
    expect(first.statusCode).toBe(200);
    const handle1 = await readAgentHandle(agentId);

    const second = await app.inject({ method: "PUT", url: "/api/profile", payload: { name } });
    expect(second.statusCode).toBe(200);
    const handle2 = await readAgentHandle(agentId);

    expect(handle2).toBe(handle1);
  });
});

describe("M156 PATCH /api/profile/agent-handle (S3)", () => {
  test("valid custom handle → 200, and a later rename leaves it frozen", async () => {
    const { userId, agentId } = await seedUserWithAgent();
    const app = makeApp(userId);
    apps.push(app);
    const custom = `mybot${rand()}`;

    const patch = await app.inject({
      method: "PATCH",
      url: "/api/profile/agent-handle",
      payload: { handle: custom },
    });
    expect(patch.statusCode).toBe(200);
    expect((JSON.parse(patch.body) as { handle: string }).handle).toBe(custom);
    expect(await readAgentHandle(agentId)).toBe(custom);

    // Subsequent rename must NOT re-derive the (now customized) handle.
    const put = await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: `Anything ${rand()}` },
    });
    expect(put.statusCode).toBe(200);
    expect(await readAgentHandle(agentId)).toBe(custom);
  });

  test("handle already used by another Agent → 409 handle_taken", async () => {
    const taken = `dupagent${rand()}`;
    await makeBareAgent(taken);
    const { userId } = await seedUserWithAgent();
    const app = makeApp(userId);
    apps.push(app);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/profile/agent-handle",
      payload: { handle: taken },
    });
    expect(res.statusCode).toBe(409);
    expect((JSON.parse(res.body) as { code: string }).code).toBe("handle_taken");
  });

  test("handle already used by a local Human → 409 handle_taken", async () => {
    const taken = `duphuman${rand()}`;
    await makeBareHuman(taken);
    const { userId } = await seedUserWithAgent();
    const app = makeApp(userId);
    apps.push(app);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/profile/agent-handle",
      payload: { handle: taken },
    });
    expect(res.statusCode).toBe(409);
    expect((JSON.parse(res.body) as { code: string }).code).toBe("handle_taken");
  });

  test("invalid format → 400 invalid_handle", async () => {
    const { userId } = await seedUserWithAgent();
    const app = makeApp(userId);
    apps.push(app);

    for (const bad of ["AB", "9bad"]) {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/profile/agent-handle",
        payload: { handle: bad },
      });
      expect(res.statusCode).toBe(400);
      expect((JSON.parse(res.body) as { code: string }).code).toBe("invalid_handle");
    }
  });
});
