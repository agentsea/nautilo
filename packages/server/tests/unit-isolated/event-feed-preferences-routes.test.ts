import { afterEach, describe, expect, mock, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { EventFeedPreference } from "@nautilo/types";
import { eventFeedPreferenceRoutes } from "../../src/routes/event-feed-preferences";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const apps: FastifyInstance[] = [];

function setup() {
  const app = Fastify({ logger: false });
  apps.push(app);
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", async (request) => {
    const user = request.headers["x-test-user"];
    request.sessionUserId = typeof user === "string" ? user : null;
  });
  const stored = new Map<string, EventFeedPreference>();
  const get = mock(async (userId: string): Promise<EventFeedPreference> => stored.get(userId) ?? { mode: "active" });
  const set = mock(async (userId: string, preference: EventFeedPreference) => { stored.set(userId, preference); return preference; });
  const changed = mock(async (_userId: string) => {});
  eventFeedPreferenceRoutes(app, { preferences: { get, set }, changed });
  return { app, get, set, changed, stored };
}

afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

describe("personal Events preference routes", () => {
  test("requires authentication before every operation", async () => {
    const { app, get, set } = setup();
    expect((await app.inject({ method: "GET", url: "/api/event-feed/preference" })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url: "/api/event-feed/preference", payload: { mode: "quiet" } })).statusCode).toBe(401);
    expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled();
  });

  test("persists only the caller's preference and targets only their sessions", async () => {
    const { app, changed, set } = setup();
    for (const preference of [{ mode: "quiet" }, { mode: "snoozed", until: "2099-01-01T09:00:00+02:00" }, { mode: "active" }] as const) {
      const response = await app.inject({ method: "PUT", url: "/api/event-feed/preference", payload: preference, headers: { "x-test-user": USER_A } });
      expect(response.statusCode).toBe(200); expect(response.json<EventFeedPreference>()).toEqual(preference);
      expect(set).toHaveBeenLastCalledWith(USER_A, preference);
      expect(changed).toHaveBeenLastCalledWith(USER_A);
      const readA = await app.inject({ method: "GET", url: "/api/event-feed/preference", headers: { "x-test-user": USER_A } });
      expect(readA.json<EventFeedPreference>()).toEqual(preference);
      const readB = await app.inject({ method: "GET", url: "/api/event-feed/preference", headers: { "x-test-user": USER_B } });
      expect(readB.json<EventFeedPreference>()).toEqual({ mode: "active" });
    }
  });

  test("rejects foreign identity, unknown modes, extra fields and invalid or past deadlines", async () => {
    const { app, set, changed } = setup();
    for (const payload of [
      { mode: "quiet", userId: USER_B }, { mode: "off" }, {},
      { mode: "quiet", until: "2099-01-01T09:00:00Z" },
      { mode: "snoozed" }, { mode: "snoozed", until: "not a date" },
      { mode: "snoozed", until: "2099-01-01T09:00:00+99:99" },
      { mode: "snoozed", until: "2000-01-01T09:00:00Z" },
      { mode: "snoozed", until: "2099-01-01T09:00" },
    ]) {
      const response = await app.inject({ method: "PUT", url: "/api/event-feed/preference", payload, headers: { "x-test-user": USER_A } });
      expect(response.statusCode).toBe(400);
    }
    for (const method of ["GET", "PUT"] as const) {
      const response = await app.inject({ method, url: `/api/event-feed/preference?userId=${USER_B}`, headers: { "x-test-user": USER_A }, ...(method === "PUT" ? { payload: { mode: "quiet" } } : {}) });
      expect(response.statusCode).toBe(400);
    }
    expect(set).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
  });

  test("a failed hint does not turn a durable save into a failed write", async () => {
    const { app, changed, stored } = setup();
    changed.mockImplementation(async () => { throw new Error("socket unavailable"); });
    const response = await app.inject({ method: "PUT", url: "/api/event-feed/preference", payload: { mode: "quiet" }, headers: { "x-test-user": USER_A } });
    expect(response.statusCode).toBe(200); expect(stored.get(USER_A)).toEqual({ mode: "quiet" });
  });

  test("storage errors do not publish a preference change or leak diagnostics", async () => {
    const { app, get, set, changed } = setup();
    get.mockImplementation(async () => { throw new Error("private database details"); });
    set.mockImplementation(async () => { throw new Error("private database details"); });
    for (const method of ["GET", "PUT"] as const) {
      const response = await app.inject({ method, url: "/api/event-feed/preference", headers: { "x-test-user": USER_A }, ...(method === "PUT" ? { payload: { mode: "quiet" } } : {}) });
      expect(response.statusCode).toBe(500); expect(response.body).not.toContain("private");
    }
    expect(changed).not.toHaveBeenCalled();
  });
});
