/**
 * Integration test — health key routes and retired /setup pathway.
 *
 * Originally lived in `tests/unit/health-keys.test.ts`, moved here
 * because `createApp()` boots the full production app and runs DB-backed
 * startup queries — not unit-shaped.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { ensureDatabase } from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";

import { createApp } from "../../src/app";

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
});

describe("health key routes", () => {
  const instances: Awaited<ReturnType<typeof createApp>>[] = [];

  afterEach(async () => {
    await Promise.all(instances.splice(0).map((app) => app.close()));
  });

  test("GET /api/health/keys returns KeyReport array", async () => {
    const app = await createApp({ silent: true });
    instances.push(app);
    const res = await app.inject({ method: "GET", url: "/api/health/keys" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as unknown;
    expect(Array.isArray(body)).toBe(true);
    expect((body as { length: number }).length).toBeGreaterThan(0);
    const first = (body as { id: string; envVar: string; status: string }[])[0];
    expect(first).toHaveProperty("id");
    expect(first).toHaveProperty("envVar");
    expect(first).toHaveProperty("status");
  });

  test("GET /api/health/keys rejects unauthenticated remote callers with 401", async () => {
    const app = await createApp({ silent: true });
    instances.push(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/health/keys",
      remoteAddress: "10.0.0.5",
    });
    expect(res.statusCode).toBe(401);
  });

  // D091 Phase 3 — legacy /setup/index.html + /setup redirect
  // tests intentionally deleted alongside the route removal in
  // app.ts. The Electron desktop wizard replaced the server-side
  // SPA; there is no /setup pathway anymore.

  test("GET /setup returns 404 (route deleted in D091)", async () => {
    const app = await createApp({ silent: true });
    instances.push(app);
    const res = await app.inject({ method: "GET", url: "/setup" });
    expect(res.statusCode).toBe(404);
  });

  test("GET /setup/images/avatars/avatar-03.webp returns 404 (legacy static route deleted)", async () => {
    const app = await createApp({ silent: true });
    instances.push(app);
    const res = await app.inject({
      method: "GET",
      url: "/setup/images/avatars/avatar-03.webp",
    });
    expect(res.statusCode).toBe(404);
  });

  // The `GET /api/onboarding/audio/<lang>/...` static-streaming case
  // moved to `tests/integration/onboarding-audio.test.ts` — it spins up
  // a real Fastify instance AND streams a 148 KB binary off disk
  // through `@fastify/static`, which doesn't compose with `app.inject`
  // (the request reaches Fastify but the streamed body never drains
  // back through the inject Promise, the test deadlocks at 5s). That
  // test is integration-shaped by every meaningful criterion — full
  // app composition + real filesystem + real streaming pipe — so it
  // lives in the integration tier where it can use a real HTTP
  // round-trip via `app.listen({ port: 0 }) + fetch`.
});
