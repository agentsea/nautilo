import { describe, expect, test } from "bun:test";
import {
  serverProfileRoutes,
  type ServerProfileRouteDeps,
} from "../../src/routes/server-profile";

type Handler = (
  request: { sessionUserId?: string; body?: unknown },
  reply: {
    code(status: number): unknown;
    send(body: unknown): unknown;
  },
) => Promise<unknown>;

function profileRouteHarness(deps: ServerProfileRouteDeps) {
  let handler: Handler | undefined;
  const app = {
    post(path: string, next: Handler) {
      if (path === "/api/server/profile") handler = next;
    },
  };
  serverProfileRoutes(app as never, deps);

  return async (request: Parameters<Handler>[0]) => {
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
    await handler!(request, reply);
    return { status, body };
  };
}

describe("server-profile route authorization and allowed identity fields", () => {
  test("allows an Admin with manage_server_operations to update identity fields", async () => {
    const patches: unknown[] = [];
    const events: Record<string, unknown>[] = [];
    const call = profileRouteHarness({
      getCapabilities: async () => ["manage_server_operations"],
      getDb: () => ({}) as never,
      resolveOpts: () => ({ defaultName: "Default Server" }),
      upsertProfile: async (_db, patch) => {
        patches.push(patch);
        const descriptionVisibility = patch.descriptionVisibility === "public"
          ? "public"
          : "members";
        return {
          name: patch.name ?? "Default Server",
          description: patch.description ?? null,
          descriptionVisibility,
          icon: { kind: "preset", id: "nautilo" },
          reviewedAt: null,
        };
      },
      auditEvent: (_request, event) => {
        events.push(event);
      },
    });

    expect(await call({
      sessionUserId: "admin-not-agent-owner",
      body: {
        name: "Operations",
        description: "Routine server configuration",
        descriptionVisibility: "public",
      },
    })).toEqual({
      status: 200,
      body: {
        serverProfile: {
          name: "Operations",
          description: "Routine server configuration",
          descriptionVisibility: "public",
          icon: { kind: "preset", id: "nautilo" },
          reviewedAt: null,
        },
      },
    });
    expect(patches).toEqual([{
      name: "Operations",
      description: "Routine server configuration",
      descriptionVisibility: "public",
    }]);
    expect(events).toEqual([{
      kind: "server_profile_changed",
      actorId: "admin-not-agent-owner",
      changes: {
        name: { after: "Operations" },
        description: { after: "Routine server configuration" },
        descriptionVisibility: { after: "public" },
      },
    }]);
  });

  test("denies callers without manage_server_operations and unknown fields", async () => {
    const call = profileRouteHarness({
      getCapabilities: async () => [],
    });
    expect(await call({ sessionUserId: "member", body: { name: "Nope" } }))
      .toEqual({ status: 403, body: { error: "admin only" } });

    const invalidCall = profileRouteHarness({
      getCapabilities: async () => ["manage_server_operations"],
    });
    expect(await invalidCall({ sessionUserId: "admin", body: { securityPolicy: "open" } }))
      .toEqual({ status: 400, body: { error: "invalid body" } });
  });
});
