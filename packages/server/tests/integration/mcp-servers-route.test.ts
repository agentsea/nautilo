/**
 * D384 Phase 3 §3.0 (SEC7) + §3.1 — integration tests for the
 * `/api/mcp-servers` mutation route.
 *
 * Mirrors the `securityRoutes` test pattern (injectable deps +
 * bearer-session preHandler) so the full surface — capability gate,
 * audit events, DB CRUD, hot-reload reconcile — is exercised with no
 * real Postgres and no disk-backed audit log. The DB is a tiny
 * in-memory fake that implements only the chains the route uses
 * (`select/from/where`, `insert/values/returning`,
 * `update/set/where/returning`, `delete/where/returning`).
 *
 * Coverage:
 *  (a) `manage_agents`-only actor → 403 `capability_missing` on POST
 *      and PATCH-enable, AND a `capability_check_failed` audit row is
 *      written for each denial.
 *  (b) `manage_server_security` actor → can create (row lands
 *      `enabled:false`), enable, and delete.
 *  (c) create rejects a duplicate name with 409.
 *  (d) after a successful enable, the installed `McpClientManager`'s
 *      `reconcile` is invoked with the enabled server-tier configs.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { CAP_MANAGE_SERVER_SECURITY } from "@nautilo/trust";
import type { DirectDatabase, McpServer } from "@nautilo/db";
import type { McpClientManager } from "@nautilo/mcp-client";
import { setRelayRegistry, type ToolRelayRegistry } from "@nautilo/agent";

import { mcpServersRoutes } from "../../src/routes/mcp-servers";
import { setMcpClientManager } from "../../src/mcp/mcp-manager-singleton";
import type { SecurityAuditEvent } from "../../src/lib/security-audit-log";
import { SessionStore } from "../helpers/test-session-store";

// ---------------------------------------------------------------------------
// In-memory fake DirectDatabase — implements ONLY the chains the route
// uses. It decodes the `name`, `host`, and `enabled` equality predicates from
// Drizzle's opaque SQL tree so compound host+name mutations are exercised.
// ---------------------------------------------------------------------------

function extractMcpPredicates(expr: unknown): Partial<Pick<McpServer, "name" | "host" | "enabled">> {
  const predicates: Partial<Pick<McpServer, "name" | "host" | "enabled">> = {};
  let column: "name" | "host" | "enabled" | undefined;
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const chunks = (value as Record<string, unknown>)["queryChunks"];
    if (!Array.isArray(chunks)) return;
    for (const chunk of chunks) {
      if (!chunk || typeof chunk !== "object") continue;
      const record = chunk as Record<string, unknown>;
      if (Array.isArray(record["queryChunks"])) {
        walk(chunk);
        continue;
      }
      if (record["name"] === "name" || record["name"] === "host" || record["name"] === "enabled") {
        column = record["name"];
        continue;
      }
      const parameter = record["value"];
      if ((column === "name" || column === "host") && typeof parameter === "string") {
        predicates[column] = parameter;
        column = undefined;
      } else if (column === "enabled" && typeof parameter === "boolean") {
        predicates.enabled = parameter;
        column = undefined;
      }
    }
  };
  walk(expr);
  return predicates;
}

class FakeMcpServersDb {
  private rows = new Map<string, McpServer>();

  private key(row: Pick<McpServer, "name" | "host">): string {
    return `${row.host}\u0000${row.name}`;
  }

  private matching(expr: unknown): McpServer[] {
    const predicate = extractMcpPredicates(expr);
    return this.all().filter((row) =>
      (predicate.name === undefined || row.name === predicate.name) &&
      (predicate.host === undefined || row.host === predicate.host) &&
      (predicate.enabled === undefined || row.enabled === predicate.enabled),
    );
  }

  reset(): void {
    this.rows.clear();
  }

  /** Test-only seed (bypasses the route). D384 §5.5 local-tier tests use this. */
  seed(row: Partial<McpServer> & Pick<McpServer, "name">): McpServer {
    const full = this.makeFullRow(row);
    this.rows.set(this.key(full), full);
    return full;
  }

  private all(): McpServer[] {
    return Array.from(this.rows.values());
  }

  private makeFullRow(input: Partial<McpServer>): McpServer {
    const now = new Date();
    return {
      id: randomUUID(),
      name: input.name ?? "",
      // Honor the caller-supplied host so the D384 §5.5.2 local-tier
      // create test can verify `host="relay-<id>"` is preserved end-to-
      // end. Default "server" keeps the existing SEC7 tests' rows on
      // the server tier.
      host: input.host ?? "server",
      transportKind: input.transportKind ?? "stdio",
      transport: input.transport ?? {},
      envPassthrough: input.envPassthrough ?? null,
      envLiteral: null,
      authRef: null,
      namespaceId: input.namespaceId ?? null,
      includeTools: input.includeTools ?? null,
      excludeTools: input.excludeTools ?? null,
      enabled: input.enabled ?? false,
      trustTier: input.trustTier ?? null,
      spawnSandboxProfile: null,
      lastCheckStatus: input.lastCheckStatus ?? null,
      lastCheckFailureCode: input.lastCheckFailureCode ?? null,
      lastCheckMissingEnvironment: input.lastCheckMissingEnvironment ?? null,
      lastCheckedAt: input.lastCheckedAt ?? null,
      lastConnectedAt: input.lastConnectedAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }

  // Drizzle-style chains. The loose typing is intentional — we only
  // need to satisfy the route's call sites, not the full Drizzle API.
  select(_fields?: unknown): {
    from: (_table: unknown) => Promise<McpServer[]> & {
      where: (expr: unknown) => Promise<McpServer[]>;
    };
  } {
    const all = () => this.all();
    return {
      from: (_table: unknown) => {
        const p = Promise.resolve(all()) as Promise<McpServer[]> & {
          where: (expr: unknown) => Promise<McpServer[]>;
        };
        p.where = (expr: unknown): Promise<McpServer[]> => {
          return Promise.resolve(this.matching(expr));
        };
        return p;
      },
    };
  }

  insert(_table: unknown): {
    values: (row: Partial<McpServer>) => { returning: () => Promise<McpServer[]> };
  } {
    return {
      values: (row: Partial<McpServer>) => ({
        returning: async (): Promise<McpServer[]> => {
          const full = this.makeFullRow(row);
          this.rows.set(this.key(full), full);
          return [full];
        },
      }),
    };
  }

  update(_table: unknown): {
    set: (
      patch: Partial<McpServer>,
    ) => { where: (expr: unknown) => { returning: () => Promise<McpServer[]> } };
  } {
    return {
      set: (patch: Partial<McpServer>) => ({
        where: (expr: unknown) => ({
          returning: async (): Promise<McpServer[]> => {
            const matched = this.matching(expr);
            this.rows = new Map(this.all().map((existing) => {
              if (!matched.includes(existing)) return [this.key(existing), existing];
              const updated: McpServer = {
                ...existing,
                ...patch,
                updatedAt: patch.updatedAt ?? new Date(),
              };
              return [this.key(updated), updated];
            }));
            return matched.map((existing) => ({
              ...existing,
              ...patch,
              updatedAt: patch.updatedAt ?? new Date(),
            }));
          },
        }),
      }),
    };
  }

  delete(_table: unknown): {
    where: (expr: unknown) => { returning: () => Promise<McpServer[]> };
  } {
    return {
      where: (expr: unknown) => ({
        returning: async (): Promise<McpServer[]> => {
          const matched = this.matching(expr);
          for (const existing of matched) this.rows.delete(this.key(existing));
          return matched;
        },
      }),
    };
  }
}

// ---------------------------------------------------------------------------
// Fake McpClientManager — only the `reconcile` method is invoked by the
// route; the spy captures the configs the route passed.
// ---------------------------------------------------------------------------

interface ReconcileSpy {
  calls: readonly (readonly unknown[])[];
  reconcile: (configs: readonly unknown[]) => Promise<void>;
}

function makeReconcileSpy(): ReconcileSpy {
  const calls: (readonly unknown[])[] = [];
  return {
    calls,
    reconcile: async (configs: readonly unknown[]): Promise<void> => {
      calls.push(configs);
    },
  };
}

// ---------------------------------------------------------------------------
// Bearer-session preHandler — mirrors the production trust preHandler's
// request decorations (`sessionUserId`, `sessionActorId`, `policyContext`)
// so the route gate sees what production sees. Same shape as the
// security-posture test's `installBearerSessionPreHandler`.
// ---------------------------------------------------------------------------

function installBearerSessionPreHandler(
  app: FastifyInstance,
  store: SessionStore,
): void {
  app.decorateRequest("sessionUserId", null);
  app.decorateRequest("sessionActorId", null);
  app.decorateRequest("policyContext", null);
  app.addHook("preHandler", async (request) => {
    const auth = request.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    const session = token ? store.validateSession(token) : null;
    if (!session) return;
    request.sessionUserId = session.userId;
    request.sessionActorId = session.actorId;
    const role = session.userId === session.ownerId ? "owner" : "guest";
    request.policyContext = {
      actorRole: role,
      actorLabel: role,
    } as unknown as typeof request.policyContext;
  });
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const ADMIN_ACTOR_ID = "admin-actor";
const ADMIN_USER_ID = "admin-user";
const AGENT_ACTOR_ID = "agent-actor";
const AGENT_USER_ID = "agent-user";
const OWNER_USER_ID = ADMIN_USER_ID; // admin is the "server owner" here

let app: FastifyInstance;
let store: SessionStore;
let adminToken: string;
let agentToken: string;
let db: FakeMcpServersDb;
let auditCalls: SecurityAuditEvent[];
let reconcileSpy: ReconcileSpy;

const userCaps = new Map<string, readonly string[]>();

beforeAll(async () => {
  store = new SessionStore(undefined, { persistPath: null });
  app = Fastify({ logger: false });
  installBearerSessionPreHandler(app, store);

  db = new FakeMcpServersDb();
  auditCalls = [];

  mcpServersRoutes(app, {
    getCapabilities: (userId) =>
      Promise.resolve(userCaps.get(userId) ?? []),
    auditEvent: async (event) => {
      auditCalls.push(event);
    },
    db: db as unknown as DirectDatabase,
    now: () => new Date("2026-07-07T20:12:00.000Z"),
  });
  await app.ready();

  adminToken = store.createSession(
    ADMIN_ACTOR_ID,
    OWNER_USER_ID,
    ADMIN_USER_ID,
  ).token;
  agentToken = store.createSession(
    AGENT_ACTOR_ID,
    OWNER_USER_ID,
    AGENT_USER_ID,
  ).token;
});

beforeEach(() => {
  db.reset();
  auditCalls = [];
  userCaps.clear();
  userCaps.set(ADMIN_USER_ID, [CAP_MANAGE_SERVER_SECURITY]);
  userCaps.set(AGENT_USER_ID, ["manage_agents"]);
  // Install a fresh reconcile spy + fake manager before each test so
  // call counts don't bleed across cases.
  reconcileSpy = makeReconcileSpy();
  setMcpClientManager({
    reconcile: reconcileSpy.reconcile,
  } as unknown as McpClientManager);
  // No relay registry by default; D384 §5.5 tests opt in per-case.
  setRelayRegistry(null);
});

afterAll(async () => {
  setMcpClientManager(null);
  setRelayRegistry(null);
  if (app) await app.close();
});

// ---------------------------------------------------------------------------
// (a) capability gate: manage_agents-only actor is denied
// ---------------------------------------------------------------------------

describe("capability gate (SEC7)", () => {
  test("POST /api/mcp-servers → 403 capability_missing + capability_check_failed audit", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      headers: { Authorization: `Bearer ${agentToken}` },
      payload: {
        name: "ghost",
        transportKind: "stdio",
        transport: { command: "node", args: ["--version"] },
      },
    });
    expect(res.statusCode).toBe(403);
    const body: { error: string; capability: string } = res.json();
    expect(body.error).toBe("capability_missing");
    expect(body.capability).toBe(CAP_MANAGE_SERVER_SECURITY);

    expect(auditCalls.length).toBe(1);
    const audit = auditCalls[0]!;
    expect(audit.kind).toBe("capability_check_failed");
    if (audit.kind !== "capability_check_failed") throw new Error("narrow");
    expect(audit.capability).toBe(CAP_MANAGE_SERVER_SECURITY);
    expect(audit.attemptedRoute).toBe("POST /api/mcp-servers");
    expect(audit.actorId).toBe(AGENT_ACTOR_ID);
  });

  test("PATCH /api/mcp-servers/:name/enabled → 403 capability_missing + capability_check_failed audit", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/mcp-servers/ghost/enabled",
      headers: { Authorization: `Bearer ${agentToken}` },
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(403);
    const body2: { error: string; capability: string } = res.json();
    expect(body2.error).toBe("capability_missing");

    expect(auditCalls.length).toBe(1);
    const audit = auditCalls[0]!;
    expect(audit.kind).toBe("capability_check_failed");
    if (audit.kind !== "capability_check_failed") {
      throw new Error("narrow");
    }
    expect(audit.attemptedRoute).toBe(
      "PATCH /api/mcp-servers/:name/enabled",
    );
  });

  test("GET /api/mcp-servers hides official rows from verified non-admins", async () => {
    db.seed({ name: "official-hidden", host: "server" });
    const res = await app.inject({
      method: "GET",
      url: "/api/mcp-servers",
      headers: { Authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body: { servers: Array<{ name: string }> } = res.json();
    expect(body.servers.some((server) => server.name === "official-hidden")).toBe(false);
  });

  test("401 without a session (no audit row)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      payload: {
        name: "ghost",
        transportKind: "stdio",
        transport: { command: "node" },
      },
    });
    expect(res.statusCode).toBe(401);
    expect(auditCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (b) admin happy path: create → enable → delete
// ---------------------------------------------------------------------------

describe("admin happy path (manage_server_security)", () => {
  test("create lands enabled:false + host:'server', then enable + delete succeed", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: {
        name: "fs",
        transportKind: "stdio",
        transport: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
        envPassthrough: ["HOME"],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const createBody = bodyOf<ServerRowResponse>(createRes);
    const created = createBody.server;
    expect(created.name).toBe("fs");
    expect(created.enabled).toBe(false);
    expect(created.host).toBe("server");
    expect(created.envPassthrough).toEqual(["HOME"]);

    // audit row for the create
    const createAudit = auditCalls.find(
      (e) => e.kind === "mcp_server_config" &&
        (e as { action?: string }).action === "create",
    );
    expect(createAudit).toBeDefined();
    if (createAudit && createAudit.kind === "mcp_server_config") {
      expect(createAudit.serverName).toBe("fs");
      expect(createAudit.outcome).toBe("ok");
      expect(createAudit.actorId).toBe(ADMIN_ACTOR_ID);
    }

    // enable
    const enableRes = await app.inject({
      method: "PATCH",
      url: "/api/mcp-servers/fs/enabled",
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { enabled: true },
    });
    expect(enableRes.statusCode).toBe(200);
    const enableBody = bodyOf<ServerRowResponse>(enableRes);
    expect(enableBody.server.enabled).toBe(true);

    const enableAudit = auditCalls.find(
      (e) =>
        e.kind === "mcp_server_config" &&
        (e as { action?: string }).action === "enable",
    );
    expect(enableAudit).toBeDefined();

    // delete
    const deleteRes = await app.inject({
      method: "DELETE",
      url: "/api/mcp-servers/fs",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(deleteRes.statusCode).toBe(200);
    const deleteBody = bodyOf<OkResponse>(deleteRes);
    expect(deleteBody.ok).toBe(true);

    const deleteAudit = auditCalls.find(
      (e) =>
        e.kind === "mcp_server_config" &&
        (e as { action?: string }).action === "delete",
    );
    expect(deleteAudit).toBeDefined();

    // row is gone
    const listRes = await app.inject({
      method: "GET",
      url: "/api/mcp-servers",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const listBody = bodyOf<ListResponse>(listRes);
    expect(listBody.servers.some((s) => s.name === "fs")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (c) duplicate-name create → 409
// ---------------------------------------------------------------------------

describe("duplicate name conflict", () => {
  test("second create with the same name → 409", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: {
        name: "dupe",
        transportKind: "stdio",
        transport: { command: "node" },
      },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: {
        name: "dupe",
        transportKind: "stdio",
        transport: { command: "node" },
      },
    });
    expect(second.statusCode).toBe(409);
    const body = bodyOf<ErrorResponse>(second);
    expect(body.error).toBe("conflict");
  });
});

// ---------------------------------------------------------------------------
// (d) reconcile is called after a successful enable
// ---------------------------------------------------------------------------

describe("hot-reload reconcile", () => {
  test("after a successful enable, the installed manager's reconcile is invoked with enabled server-tier configs", async () => {
    // Seed a row by creating it (enabled:false).
    await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: {
        name: "reload",
        transportKind: "stdio",
        transport: { command: "node", args: ["x"] },
      },
    });

    // Reset the spy's call count to isolate the enable's reconcile call.
    // We re-install a fresh spy + manager.
    const enableSpy = makeReconcileSpy();
    setMcpClientManager({
      reconcile: enableSpy.reconcile,
    } as unknown as McpClientManager);

    const enableRes = await app.inject({
      method: "PATCH",
      url: "/api/mcp-servers/reload/enabled",
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { enabled: true },
    });
    expect(enableRes.statusCode).toBe(200);

    expect(enableSpy.calls.length).toBe(1);
    const configs = enableSpy.calls[0]!;
    // The enabled row is the one we just enabled — reconcile should
    // have received exactly that one server-tier config.
    expect(Array.isArray(configs)).toBe(true);
    const names = (configs as Array<{ name: string }>).map((c) => c.name);
    expect(names).toContain("reload");
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface ServerRowResponse {
  readonly server: McpServer;
}
interface OkResponse {
  readonly ok: boolean;
  readonly name: string;
}
interface ListResponse {
  readonly servers: McpServer[];
}
interface ErrorResponse {
  readonly error: string;
  readonly capability?: string;
  readonly message?: string;
}

function bodyOf<T>(res: { body: string }): T {
  return JSON.parse(res.body) as T;
}

// ---------------------------------------------------------------------------
// D384 §5.5.1 + §5.5.2 — relay-id source + owner-gated local create
// (integration: full route + audit + reconcile surface)
// ---------------------------------------------------------------------------

/**
 * Fake relay registry satisfying the `RelayRegistryHealthView` cast in
 * `connection-status.ts` (`listConnected` + `getUserId`). Each entry is
 * a relay id + the owning user id.
 */
function makeFakeRelayRegistry(
  relays: ReadonlyArray<{ readonly relayId: string; readonly userId: string }>,
): ToolRelayRegistry {
  const byId = new Map(relays.map((r) => [r.relayId, r.userId] as const));
  return {
    listConnected: () => relays.map((r) => r.relayId),
    getUserId: (relayId: string) => byId.get(relayId) ?? null,
  } as unknown as ToolRelayRegistry;
}

describe("D384 §5.5.1 — GET /api/mcp-servers/relays", () => {
  test("returns the requesting user's connected relays; empty when none", async () => {
    setRelayRegistry(
      makeFakeRelayRegistry([
        { relayId: "relay-A", userId: AGENT_USER_ID },
        { relayId: "relay-B", userId: ADMIN_USER_ID },
      ]),
    );

    const agentRes = await app.inject({
      method: "GET",
      url: "/api/mcp-servers/relays",
      headers: { Authorization: `Bearer ${agentToken}` },
    });
    expect(agentRes.statusCode).toBe(200);
    expect(bodyOf<{ relays: Array<{ relayId: string }> }>(agentRes).relays).toEqual([
      { relayId: "relay-A" },
    ]);

    const adminRes = await app.inject({
      method: "GET",
      url: "/api/mcp-servers/relays",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(adminRes.statusCode).toBe(200);
    expect(bodyOf<{ relays: Array<{ relayId: string }> }>(adminRes).relays).toEqual([
      { relayId: "relay-B" },
    ]);
  });

  test("empty when the user owns no connected relays", async () => {
    setRelayRegistry(
      makeFakeRelayRegistry([{ relayId: "relay-X", userId: ADMIN_USER_ID }]),
    );
    const res = await app.inject({
      method: "GET",
      url: "/api/mcp-servers/relays",
      headers: { Authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(bodyOf<{ relays: unknown[] }>(res).relays).toEqual([]);
  });

  test("401 without a session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/mcp-servers/relays" });
    expect(res.statusCode).toBe(401);
  });

  test("route is not shadowed by GET /api/mcp-servers/:name", async () => {
    setRelayRegistry(
      makeFakeRelayRegistry([{ relayId: "relay-A", userId: AGENT_USER_ID }]),
    );
    // Seed a row named "relays" to PROVE the static route wins over
    // the parametric one even when a row named "relays" exists.
    db.seed({ name: "relays", host: "server", enabled: false });
    const res = await app.inject({
      method: "GET",
      url: "/api/mcp-servers/relays",
      headers: { Authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(bodyOf<{ relays: Array<{ relayId: string }> }>(res).relays).toEqual([
      { relayId: "relay-A" },
    ]);
  });
});

describe("D384 §5.5.2 — owner-gated local create (integration)", () => {
  test("non-admin verified user creates host=relay-<ownedId> → 201, enabled=false, host preserved + audited", async () => {
    setRelayRegistry(
      makeFakeRelayRegistry([{ relayId: "relay-A", userId: AGENT_USER_ID }]),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      headers: { Authorization: `Bearer ${agentToken}` },
      payload: {
        name: "local-fs",
        transportKind: "stdio",
        transport: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
        envPassthrough: ["HOME"],
        host: "relay-relay-A",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = bodyOf<ServerRowResponse>(res);
    expect(body.server.name).toBe("local-fs");
    expect(body.server.host).toBe("relay-relay-A");
    expect(body.server.enabled).toBe(false);
    expect(body.server.envPassthrough).toEqual(["HOME"]);

    // Audit row written for the create.
    const createAudit = auditCalls.find(
      (e) =>
        e.kind === "mcp_server_config" &&
        (e as { action?: string }).action === "create",
    );
    expect(createAudit).toBeDefined();
    if (createAudit && createAudit.kind === "mcp_server_config") {
      expect(createAudit.serverName).toBe("local-fs");
      expect(createAudit.outcome).toBe("ok");
      expect(createAudit.actorId).toBe(AGENT_ACTOR_ID);
    }

    // Server-tier reconcile is NOT invoked for a local-tier create
    // (the relay reconciles local MCPs, not the server fleet).
    expect(reconcileSpy.calls.length).toBe(0);
  });

  test("non-owner creating host=relay-<notOwned> → 403 forbidden + capability_check_failed audit; no row written", async () => {
    setRelayRegistry(
      makeFakeRelayRegistry([
        { relayId: "relay-A", userId: AGENT_USER_ID },
        { relayId: "relay-B", userId: ADMIN_USER_ID },
      ]),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      headers: { Authorization: `Bearer ${agentToken}` },
      payload: {
        name: "ghost-local",
        transportKind: "stdio",
        transport: { command: "node" },
        host: "relay-relay-B",
      },
    });
    expect(res.statusCode).toBe(403);
    const body = bodyOf<ErrorResponse>(res);
    expect(body.error).toBe("forbidden");

    expect(auditCalls.length).toBe(1);
    const audit = auditCalls[0]!;
    expect(audit.kind).toBe("capability_check_failed");
    if (audit.kind !== "capability_check_failed") throw new Error("narrow");
    expect(audit.capability).toBe("own_relay");
    expect(audit.attemptedRoute).toBe("POST /api/mcp-servers");
    expect(audit.actorId).toBe(AGENT_ACTOR_ID);

    // Fail closed: no row was written.
    const listRes = await app.inject({
      method: "GET",
      url: "/api/mcp-servers",
      headers: { Authorization: `Bearer ${agentToken}` },
    });
    const listBody = bodyOf<ListResponse>(listRes);
    expect(listBody.servers.some((s) => s.name === "ghost-local")).toBe(false);
  });

  test("host=relay-<notConnected> (registry has no connected relay for that id) → 403", async () => {
    // Agent owns relay-A but it isn't in the registry (not connected).
    setRelayRegistry(
      makeFakeRelayRegistry([{ relayId: "relay-B", userId: ADMIN_USER_ID }]),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      headers: { Authorization: `Bearer ${agentToken}` },
      payload: {
        name: "ghost-local",
        transportKind: "stdio",
        transport: { command: "node" },
        host: "relay-relay-A",
      },
    });
    expect(res.statusCode).toBe(403);
  });

  test("SEC7 regression guard: non-admin with host=server → 403 capability_missing + audit", async () => {
    setRelayRegistry(null);
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      headers: { Authorization: `Bearer ${agentToken}` },
      payload: {
        name: "server-tier-attempt",
        transportKind: "stdio",
        transport: { command: "node" },
        host: "server",
      },
    });
    expect(res.statusCode).toBe(403);
    const body = bodyOf<ErrorResponse>(res);
    expect(body.error).toBe("capability_missing");
    expect(body.capability).toBe(CAP_MANAGE_SERVER_SECURITY);

    expect(auditCalls.length).toBe(1);
    expect(auditCalls[0]!.kind).toBe("capability_check_failed");
  });

  test("SEC7 regression guard: non-admin with no host → 403 capability_missing (server tier default)", async () => {
    setRelayRegistry(null);
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      headers: { Authorization: `Bearer ${agentToken}` },
      payload: {
        name: "server-tier-no-host",
        transportKind: "stdio",
        transport: { command: "node" },
      },
    });
    expect(res.statusCode).toBe(403);
    const body = bodyOf<ErrorResponse>(res);
    expect(body.error).toBe("capability_missing");
  });

  test("SEC7 regression guard: admin server-tier create → 201, host=server, reconcile invoked", async () => {
    setRelayRegistry(null);
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: {
        name: "admin-server",
        transportKind: "stdio",
        transport: { command: "node" },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = bodyOf<ServerRowResponse>(res);
    expect(body.server.name).toBe("admin-server");
    expect(body.server.host).toBe("server");
    expect(body.server.enabled).toBe(false);
    // Server-tier create reconciles the live fleet.
    expect(reconcileSpy.calls.length).toBe(1);
  });

  test("admin attempting host=relay-<notOwned> → 403 (admin cap does NOT bypass ownership)", async () => {
    setRelayRegistry(
      makeFakeRelayRegistry([{ relayId: "relay-A", userId: AGENT_USER_ID }]),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: {
        name: "admin-local-attempt",
        transportKind: "stdio",
        transport: { command: "node" },
        host: "relay-relay-A",
      },
    });
    expect(res.statusCode).toBe(403);
    const body = bodyOf<ErrorResponse>(res);
    expect(body.error).toBe("forbidden");
  });

  test("owner local create with duplicate name → 409 (after ownership passes)", async () => {
    setRelayRegistry(
      makeFakeRelayRegistry([{ relayId: "relay-A", userId: AGENT_USER_ID }]),
    );
    db.seed({ name: "dupe-local", host: "relay-relay-A", enabled: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      headers: { Authorization: `Bearer ${agentToken}` },
      payload: {
        name: "dupe-local",
        transportKind: "stdio",
        transport: { command: "node" },
        host: "relay-relay-A",
      },
    });
    expect(res.statusCode).toBe(409);
    const body = bodyOf<ErrorResponse>(res);
    expect(body.error).toBe("conflict");
  });
});
