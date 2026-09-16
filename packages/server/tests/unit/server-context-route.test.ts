import { describe, expect, test } from "bun:test";
import {
  parseServerContextUpdateBodyForTests,
  serverContextRoutes,
  type ServerContextRouteDeps,
} from "../../src/routes/server-context";

type Handler = (
  request: {
    sessionUserId?: string;
    body?: unknown;
    ip: string;
    headers: Record<string, string>;
  },
  reply: {
    code(status: number): unknown;
    send(body: unknown): unknown;
  },
) => Promise<unknown>;

function routeHarness(deps: ServerContextRouteDeps) {
  const handlers = new Map<string, Handler>();
  const app = {
    get(path: string, handler: Handler) {
      handlers.set(`GET ${path}`, handler);
    },
    post(path: string, handler: Handler) {
      handlers.set(`POST ${path}`, handler);
    },
  };
  serverContextRoutes(app as never, deps);

  return async (method: "GET" | "POST", request: Parameters<Handler>[0]) => {
    let status = 200;
    let body: unknown;
    const reply = {
      code(next: number) {
        status = next;
        return this;
      },
      send(next: unknown) {
        body = next;
        return next;
      },
    };
    await handlers.get(`${method} /api/admin/server-context`)!(request, reply);
    return { status, body };
  };
}

const requestBase = { ip: "127.0.0.1", headers: {} };
const contextConfig = {
  recentConversationLimit: 50,
  minimumFullTurns: 1,
  maxRoomContextPercent: 50,
  stenographerPriorConversationLimit: 10,
  passiveRecallEnabled: true,
  reflectionSleepEnabled: false,
  memoryReviewEnabled: null,
};

describe("server-context update validation", () => {
  test.each([10, 50, 100])("accepts %i", (recentConversationLimit) => {
    expect(parseServerContextUpdateBodyForTests({
      ...contextConfig,
      recentConversationLimit,
    })).toEqual({
      ok: true,
      patch: {
        recentConversationLimit,
        minimumFullTurns: 1,
        maxRoomContextPercent: 50,
        stenographerPriorConversationLimit: 10,
        passiveRecallEnabled: true,
        reflectionSleepEnabled: false,
        memoryReviewEnabled: null,
      },
    });
  });

  test.each([9, 100.5, 101, "50", null])("rejects %p", (recentConversationLimit) => {
    const result = parseServerContextUpdateBodyForTests({
      ...contextConfig,
      recentConversationLimit,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("integer between 10 and 100");
  });

  test("validates complete-turn and Room-percentage ranges", () => {
    const turns = parseServerContextUpdateBodyForTests({
      ...contextConfig,
      minimumFullTurns: 11,
    });
    expect(turns.ok).toBe(false);
    const percent = parseServerContextUpdateBodyForTests({
      ...contextConfig,
      maxRoomContextPercent: 29,
    });
    expect(percent.ok).toBe(false);
    const prior = parseServerContextUpdateBodyForTests({
      ...contextConfig,
      stenographerPriorConversationLimit: 51,
    });
    expect(prior.ok).toBe(false);
    if (!prior.ok) {
      expect(prior.error).toContain("integer between 0 and 50");
    }
  });

  test("accepts an older body without the switch and rejects invalid values", () => {
    const {
      passiveRecallEnabled: _passiveRecallEnabled,
      reflectionSleepEnabled: _reflectionSleepEnabled,
      memoryReviewEnabled: _memoryReviewEnabled,
      ...missing
    } = contextConfig;
    expect(parseServerContextUpdateBodyForTests(missing)).toEqual({
      ok: true,
      patch: {
        recentConversationLimit: 50,
        minimumFullTurns: 1,
        maxRoomContextPercent: 50,
        stenographerPriorConversationLimit: 10,
      },
    });
    expect(parseServerContextUpdateBodyForTests({
      ...contextConfig,
      passiveRecallEnabled: "true",
    })).toEqual({
      ok: false,
      error: "passiveRecallEnabled must be a boolean",
    });
  });

  test("rejects a non-object body", () => {
    expect(parseServerContextUpdateBodyForTests(null)).toEqual({
      ok: false,
      error: "invalid body",
    });
  });

  test("accepts an independent passive-recall update", () => {
    expect(parseServerContextUpdateBodyForTests({
      passiveRecallEnabled: false,
    })).toEqual({
      ok: true,
      patch: { passiveRecallEnabled: false },
    });
  });

  test("accepts an independent Reflection Sleep update", () => {
    expect(parseServerContextUpdateBodyForTests({
      reflectionSleepEnabled: true,
    })).toEqual({
      ok: true,
      patch: { reflectionSleepEnabled: true },
    });
    expect(parseServerContextUpdateBodyForTests({
      reflectionSleepEnabled: "true",
      memoryReviewEnabled: null,
    })).toEqual({
      ok: false,
      error: "reflectionSleepEnabled must be a boolean",
    });
  });

  test("rejects an update without a recognized setting", () => {
    expect(parseServerContextUpdateBodyForTests({ unknown: true })).toEqual({
      ok: false,
      error: "at least one server context setting is required",
    });
  });
});

describe("server-context route authorization and persistence", () => {
  test("requires authentication", async () => {
    const call = routeHarness({});
    expect(await call("GET", requestBase)).toEqual({
      status: 401,
      body: { error: "Authentication required" },
    });
    expect(await call("POST", { ...requestBase, body: contextConfig }))
      .toEqual({
        status: 401,
        body: { error: "Authentication required" },
      });
  });

  test("uses separate read and manage capabilities", async () => {
    const call = routeHarness({
      getCapabilities: async () => ["read_server_settings"],
      getDb: () => ({}) as never,
      getConfig: async () => contextConfig,
    });
    expect(await call("GET", { ...requestBase, sessionUserId: "user-1" })).toEqual({
      status: 200,
      body: contextConfig,
    });
    expect(
      await call("POST", {
        ...requestBase,
        sessionUserId: "user-1",
        body: { ...contextConfig, recentConversationLimit: 75 },
      }),
    ).toEqual({ status: 403, body: { error: "admin only" } });
  });

  test("persists an authorized update and audits before/after values", async () => {
    const patches: unknown[] = [];
    const events: Record<string, unknown>[] = [];
    const call = routeHarness({
      getCapabilities: async () => [
        "read_server_settings",
        "manage_server_operations",
      ],
      getDb: () => ({}) as never,
      getConfig: async () => contextConfig,
      upsertConfig: async (_db, patch) => {
        patches.push(patch);
        return {
          recentConversationLimit: patch.recentConversationLimit ?? 50,
          minimumFullTurns: patch.minimumFullTurns ?? 1,
          maxRoomContextPercent: patch.maxRoomContextPercent ?? 50,
          stenographerPriorConversationLimit:
            patch.stenographerPriorConversationLimit ?? 10,
          passiveRecallEnabled: patch.passiveRecallEnabled ?? true,
          reflectionSleepEnabled: patch.reflectionSleepEnabled ?? false,
          memoryReviewEnabled: null,
        };
      },
      auditEvent: (_request, event) => {
        events.push(event);
      },
    });
    expect(
      await call("POST", {
        ...requestBase,
        sessionUserId: "user-1",
        body: {
          recentConversationLimit: 75,
          minimumFullTurns: 2,
          maxRoomContextPercent: 60,
          stenographerPriorConversationLimit: 20,
          passiveRecallEnabled: false,
          reflectionSleepEnabled: true,
          memoryReviewEnabled: null,
        },
      }),
    ).toEqual({
      status: 200,
      body: {
        recentConversationLimit: 75,
        minimumFullTurns: 2,
        maxRoomContextPercent: 60,
        stenographerPriorConversationLimit: 20,
        passiveRecallEnabled: false,
        reflectionSleepEnabled: true,
        memoryReviewEnabled: null,
      },
    });
    expect(patches).toEqual([{
      recentConversationLimit: 75,
      minimumFullTurns: 2,
      maxRoomContextPercent: 60,
      stenographerPriorConversationLimit: 20,
      passiveRecallEnabled: false,
      reflectionSleepEnabled: true,
      memoryReviewEnabled: null,
    }]);
    expect(events).toEqual([{
      kind: "server_context_config_changed",
      actorId: "user-1",
      before: contextConfig,
      after: {
        recentConversationLimit: 75,
        minimumFullTurns: 2,
        maxRoomContextPercent: 60,
        stenographerPriorConversationLimit: 20,
        passiveRecallEnabled: false,
        reflectionSleepEnabled: true,
        memoryReviewEnabled: null,
      },
    }]);
  });

  test("updates passive recall without overwriting context retention", async () => {
    const patches: unknown[] = [];
    const call = routeHarness({
      getCapabilities: async () => ["manage_server_operations"],
      getDb: () => ({}) as never,
      getConfig: async () => contextConfig,
      upsertConfig: async (_db, patch) => {
        patches.push(patch);
        return {
          recentConversationLimit:
            patch.recentConversationLimit ?? contextConfig.recentConversationLimit,
          minimumFullTurns: patch.minimumFullTurns ?? contextConfig.minimumFullTurns,
          maxRoomContextPercent:
            patch.maxRoomContextPercent ?? contextConfig.maxRoomContextPercent,
          stenographerPriorConversationLimit:
            patch.stenographerPriorConversationLimit
            ?? contextConfig.stenographerPriorConversationLimit,
          passiveRecallEnabled:
            patch.passiveRecallEnabled ?? contextConfig.passiveRecallEnabled,
          reflectionSleepEnabled:
            patch.reflectionSleepEnabled ?? contextConfig.reflectionSleepEnabled,
          memoryReviewEnabled: null,
        };
      },
      auditEvent: () => {},
    });

    expect(await call("POST", {
      ...requestBase,
      sessionUserId: "user-1",
      body: { passiveRecallEnabled: false },
    })).toEqual({
      status: 200,
      body: { ...contextConfig, passiveRecallEnabled: false },
    });
    expect(patches).toEqual([{ passiveRecallEnabled: false }]);
  });

  test("reconciles a persisted Reflection Sleep change without failing the write", async () => {
    const updated = { ...contextConfig, reflectionSleepEnabled: true };
    const reconciled: unknown[] = [];
    const call = routeHarness({
      getCapabilities: async () => ["manage_server_operations"],
      getDb: () => ({}) as never,
      getConfig: async () => contextConfig,
      upsertConfig: async () => updated,
      auditEvent: () => {},
      onConfigUpdated: async (config) => { reconciled.push(config); },
    });

    expect(await call("POST", {
      ...requestBase,
      sessionUserId: "user-1",
      body: { reflectionSleepEnabled: true },
    })).toEqual({ status: 200, body: updated });
    expect(reconciled).toEqual([updated]);
  });

  test("returns the persisted policy when live reconciliation is unavailable", async () => {
    const updated = { ...contextConfig, reflectionSleepEnabled: true };
    const call = routeHarness({
      getCapabilities: async () => ["manage_server_operations"],
      getDb: () => ({}) as never,
      getConfig: async () => contextConfig,
      upsertConfig: async () => updated,
      auditEvent: () => {},
      onConfigUpdated: async () => { throw new Error("provider details"); },
    });

    expect(await call("POST", {
      ...requestBase,
      sessionUserId: "user-1",
      body: { reflectionSleepEnabled: true },
    })).toEqual({ status: 200, body: updated });
  });
});


test("Memory enablement retains a nullable override", () => {
  for (const memoryReviewEnabled of [null, false, true]) {
    expect(parseServerContextUpdateBodyForTests({ memoryReviewEnabled })).toEqual({ ok: true, patch: { memoryReviewEnabled } });
  }
  expect(parseServerContextUpdateBodyForTests({ memoryReviewEnabled: "true" }).ok).toBe(false);
});
