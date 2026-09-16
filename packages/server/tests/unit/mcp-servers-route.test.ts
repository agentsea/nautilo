/**
 * D384 task 3.4.1 — unit tests for the enriched `/api/mcp-servers` API:
 * health + toolCount on GET, admin-only official reads, tier-scoped mutations,
 * tools list, and per-tool excludeTools toggle.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { ToolCatalog, initToolCatalog, clearToolCatalog } from "@nautilo/catalog";
import { CAP_MANAGE_SERVER_SECURITY } from "@nautilo/trust";
import type { DirectDatabase, McpServer } from "@nautilo/db";
import type { McpClientManager } from "@nautilo/mcp-client";
import { setRelayRegistry, type ToolRelayRegistry } from "@nautilo/agent";
import { RELAY_MCP_TRUTH_PROTOCOL_VERSION } from "@nautilo/relay";

import { mcpServersRoutes } from "../../src/routes/mcp-servers";
import {
  createLocalMcpInstallService,
  setLocalMcpInstallRelaySocketSafetyCloser,
} from "../../src/mcp/local-mcp-install-service";
import { setMcpClientManager } from "../../src/mcp/mcp-manager-singleton";
import type { SecurityAuditEvent } from "../../src/lib/security-audit-log";
import { SessionStore } from "../helpers/test-session-store";

// ---------------------------------------------------------------------------
// In-memory fake DirectDatabase
// ---------------------------------------------------------------------------

function extractMcpPredicates(expr: unknown): Partial<Pick<McpServer, "id" | "name" | "host" | "enabled">> {
  const predicates: Partial<Pick<McpServer, "id" | "name" | "host" | "enabled">> = {};
  let column: "id" | "name" | "host" | "enabled" | undefined;
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
      if (record["name"] === "id" || record["name"] === "name" || record["name"] === "host" || record["name"] === "enabled") {
        column = record["name"];
        continue;
      }
      const parameter = record["value"];
      if ((column === "id" || column === "name" || column === "host") && typeof parameter === "string") {
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
  failCommitNumbers = new Set<number>();
  transactionCount = 0;

  private key(row: Pick<McpServer, "id">): string {
    return row.id;
  }

  async transaction<T>(callback: (tx: FakeMcpServersDb) => Promise<T>): Promise<T> {
    const number = ++this.transactionCount;
    const snapshot = new Map(this.all().map((row) => [row.id, { ...row }]));
    try {
      const result = await callback(this);
      if (!this.failCommitNumbers.has(number)) return result;
      this.rows = snapshot;
      throw new Error("commit failed");
    } catch (error) {
      this.rows = snapshot;
      throw error;
    }
  }

  private matching(expr: unknown): McpServer[] {
    const predicate = extractMcpPredicates(expr);
    return this.all().filter((row) =>
      (predicate.id === undefined || row.id === predicate.id) &&
      (predicate.name === undefined || row.name === predicate.name) &&
      (predicate.host === undefined || row.host === predicate.host) &&
      (predicate.enabled === undefined || row.enabled === predicate.enabled),
    );
  }

  reset(): void {
    this.rows.clear();
    this.failCommitNumbers.clear();
    this.transactionCount = 0;
  }

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
      id: input.id ?? randomUUID(),
      name: input.name ?? "",
      host: input.host ?? "server",
      transportKind: input.transportKind ?? "stdio",
      transport: input.transport ?? {},
      envPassthrough: input.envPassthrough ?? null,
      envLiteral: input.envLiteral ?? null,
      authRef: input.authRef ?? null,
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
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
  }

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
// Test helpers
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

function registerCatalogTool(
  catalog: ToolCatalog,
  name: string,
  sourceServer: string,
): void {
  catalog.register({
    name,
    source: "mcp",
    sourceServer,
    factory: () =>
      new DynamicStructuredTool({
        name,
        description: `Tool ${name}`,
        schema: z.object({}),
        func: async () => "ok",
      }),
    category: "meta",
    trustTier: "standard",
    impact: "read-only",
  });
}

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

function bodyOf<T>(res: { body: string }): T {
  return JSON.parse(res.body) as T;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition did not become true");
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const ADMIN_ACTOR_ID = "admin-actor";
const ADMIN_USER_ID = "admin-user";
const AGENT_ACTOR_ID = "agent-actor";
const AGENT_USER_ID = "agent-user";
const OWNER_USER_ID = ADMIN_USER_ID;

let app: FastifyInstance;
let store: SessionStore;
let adminToken: string;
let agentToken: string;
let db: FakeMcpServersDb;
let auditCalls: SecurityAuditEvent[];
let catalog: ToolCatalog;

const userCaps = new Map<string, readonly string[]>();

beforeAll(async () => {
  store = new SessionStore(undefined, { persistPath: null });
  app = Fastify({ logger: false });
  installBearerSessionPreHandler(app, store);

  db = new FakeMcpServersDb();
  auditCalls = [];

  mcpServersRoutes(app, {
    getCapabilities: (userId) => Promise.resolve(userCaps.get(userId) ?? []),
    auditEvent: async (event) => {
      auditCalls.push(event);
    },
    db: db as unknown as DirectDatabase,
    now: () => new Date("2026-07-08T12:00:00.000Z"),
  });
  await app.ready();

  adminToken = store.createSession(ADMIN_ACTOR_ID, OWNER_USER_ID, ADMIN_USER_ID).token;
  agentToken = store.createSession(AGENT_ACTOR_ID, OWNER_USER_ID, AGENT_USER_ID).token;
});

beforeEach(() => {
  db.reset();
  auditCalls = [];
  userCaps.clear();
  userCaps.set(ADMIN_USER_ID, [CAP_MANAGE_SERVER_SECURITY]);
  userCaps.set(AGENT_USER_ID, ["manage_agents"]);

  catalog = new ToolCatalog();
  initToolCatalog(catalog);

  setMcpClientManager({
    getState: () => "connected",
    reconcile: async () => {},
  } as unknown as McpClientManager);

  setRelayRegistry(null);
  setLocalMcpInstallRelaySocketSafetyCloser(null);
});

afterAll(async () => {
  setMcpClientManager(null);
  clearToolCatalog();
  setRelayRegistry(null);
  if (app) await app.close();
});

// ---------------------------------------------------------------------------
// GET enrichment + tier-separated reads
// ---------------------------------------------------------------------------

describe("GET enrichment + verified-user reads", () => {
  test("GET /api/mcp-servers returns health + toolCount; omits secrets", async () => {
    db.seed({
      name: "fs",
      host: "server",
      enabled: true,
      envLiteral: { SECRET: "nope" },
      authRef: { type: "bearer", vaultKey: "k" },
    });
    registerCatalogTool(catalog, "read_file", "fs");
    registerCatalogTool(catalog, "write_file", "fs");

    const res = await app.inject({
      method: "GET",
      url: "/api/mcp-servers",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = bodyOf<{ servers: Array<Record<string, unknown>> }>(res);
    expect(body.servers).toHaveLength(1);
    const row = body.servers[0]!;
    expect(row["health"]).toBe("connected");
    expect(row["toolCount"]).toBe(2);
    expect(row["envLiteral"]).toBeUndefined();
    expect(row["authRef"]).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain("nope");
    expect(JSON.stringify(row)).not.toContain("vaultKey");
  });

  test("verified non-admin cannot see or mutate server-tier", async () => {
    db.seed({ name: "fs", host: "server", enabled: false });

    const list = await app.inject({
      method: "GET",
      url: "/api/mcp-servers",
      headers: { Authorization: `Bearer ${agentToken}` },
    });
    expect(list.statusCode).toBe(200);
    expect(bodyOf<{ servers: unknown[] }>(list).servers).toHaveLength(0);

    const exact = await app.inject({
      method: "GET",
      url: "/api/mcp-servers/fs?host=server",
      headers: { Authorization: `Bearer ${agentToken}` },
    });
    expect(exact.statusCode).toBe(404);

    const post = await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      headers: { Authorization: `Bearer ${agentToken}` },
      payload: {
        name: "new",
        transportKind: "stdio",
        transport: { command: "node" },
      },
    });
    expect(post.statusCode).toBe(403);
    const postBody = bodyOf<{ error: string }>(post);
    expect(postBody.error).toBe("capability_missing");
  });

  test("GET /api/mcp-servers without session → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/mcp-servers" });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Tools endpoint + per-tool toggle
// ---------------------------------------------------------------------------

describe("tools endpoint + per-tool toggle", () => {
  beforeEach(() => {
    db.seed({ name: "fs", host: "server", enabled: true, excludeTools: ["write_file"] });
    registerCatalogTool(catalog, "read_file", "fs");
    registerCatalogTool(catalog, "write_file", "fs");
  });

  test("GET /api/mcp-servers/:name/tools returns enabled flags from excludeTools", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/mcp-servers/fs/tools",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = bodyOf<{
      tools: Array<{ name: string; enabled: boolean; description?: string }>;
    }>(res);
    expect(body.tools).toHaveLength(2);
    const read = body.tools.find((t) => t.name === "read_file");
    const write = body.tools.find((t) => t.name === "write_file");
    expect(read?.enabled).toBe(true);
    expect(write?.enabled).toBe(false);
    expect(read?.description).toBe("Tool read_file");
  });

  test("PATCH /api/mcp-servers/:name/tools/:tool toggles excludeTools (admin)", async () => {
    const enable = await app.inject({
      method: "PATCH",
      url: "/api/mcp-servers/fs/tools/write_file",
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { enabled: true },
    });
    expect(enable.statusCode).toBe(200);
    const enableBody = bodyOf<{
      server: { excludeTools: string[] | null };
      tools: Array<{ name: string; enabled: boolean }>;
    }>(enable);
    expect(enableBody.server.excludeTools ?? []).not.toContain("write_file");
    expect(enableBody.tools.find((t) => t.name === "write_file")?.enabled).toBe(true);

    const disable = await app.inject({
      method: "PATCH",
      url: "/api/mcp-servers/fs/tools/read_file",
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { enabled: false },
    });
    expect(disable.statusCode).toBe(200);
    const disableBody = bodyOf<{ server: { excludeTools: string[] | null } }>(disable);
    expect(disableBody.server.excludeTools).toContain("read_file");
  });

  test("PATCH tool toggle → 403 for verified non-admin on server-tier", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/mcp-servers/fs/tools/write_file",
      headers: { Authorization: `Bearer ${agentToken}` },
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(403);
  });

  test("PATCH tool toggle invokes reconcile for server-tier", async () => {
    const spy = makeReconcileSpy();
    setMcpClientManager({
      getState: () => "connected",
      reconcile: spy.reconcile,
    } as unknown as McpClientManager);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/mcp-servers/fs/tools/write_file",
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(spy.calls.length).toBe(1);
  });

  test("CLI revision precondition rejects a stale MCP mutation without writing", async () => {
    const before = await app.inject({
      method: "GET",
      url: "/api/mcp-servers/fs",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const revision = bodyOf<{ server: { updatedAt: string } }>(before).server.updatedAt;
    const first = await app.inject({
      method: "PATCH",
      url: "/api/mcp-servers/fs/enabled",
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { enabled: false, expectedRevision: revision },
    });
    expect(first.statusCode).toBe(200);
    const stale = await app.inject({
      method: "PATCH",
      url: "/api/mcp-servers/fs/enabled",
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { enabled: true, expectedRevision: revision },
    });
    expect(stale.statusCode).toBe(409);
    expect(bodyOf<{ error: string }>(stale).error).toBe("mcp_revision_conflict");
  });
});

// ---------------------------------------------------------------------------
// D384 §5.5.1 + §5.5.2 — relay-id source + owner-gated local create
// ---------------------------------------------------------------------------

/**
 * Build a fake relay registry that satisfies the `RelayRegistryHealthView`
 * cast in `connection-status.ts` (`listConnected` + `getUserId`). Each
 * entry is a relay id + the owning user id.
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

function makeMcpCheckRegistry(input: {
  status: "ready" | "blocked";
  environment: Array<{ name: string; present: boolean }>;
  failure?: { code: "missing_environment" | "missing_launcher" };
}): ToolRelayRegistry {
  return {
    listConnected: () => ["relay-A"],
    getUserId: () => AGENT_USER_ID,
    getDesktopSessionId: () => "desktop-session-A",
    getProtocolVersion: () => RELAY_MCP_TRUTH_PROTOCOL_VERSION,
    preflightMcp: (_relayId: string, request: { requestId: string; digest: string; server: { name: string } }) => Promise.resolve({
      type: "relay:mcp-preflight-result" as const,
      requestId: request.requestId,
      digest: request.digest,
      targetName: request.server.name,
      status: input.status,
      machineLabel: "This Desktop",
      launcher: "present" as const,
      environment: input.environment,
      ...(input.failure ? { failure: input.failure } : {}),
    }),
  } as unknown as ToolRelayRegistry;
}

describe("D503 local MCP prerequisite checks", () => {
  test("persists safe missing-environment evidence, then clears it when ready", async () => {
    db.seed({
      name: "github-local",
      host: "relay-relay-A",
      enabled: false,
      envPassthrough: ["GITHUB_TOKEN"],
    });
    setRelayRegistry(makeMcpCheckRegistry({
      status: "blocked",
      environment: [{ name: "GITHUB_TOKEN", present: false }],
      failure: { code: "missing_environment" },
    }));

    const missing = await app.inject({
      method: "POST",
      url: "/api/mcp-servers/github-local/check?host=relay-relay-A",
      headers: { Authorization: `Bearer ${agentToken}` },
    });
    expect(missing.statusCode).toBe(200);
    expect(bodyOf<{ server: McpServer }>(missing).server).toMatchObject({
      lastCheckStatus: "needs_attention",
      lastCheckFailureCode: "missing_environment",
      lastCheckMissingEnvironment: ["GITHUB_TOKEN"],
    });

    setRelayRegistry(makeMcpCheckRegistry({
      status: "ready",
      environment: [{ name: "GITHUB_TOKEN", present: true }],
    }));
    const ready = await app.inject({
      method: "POST",
      url: "/api/mcp-servers/github-local/check?host=relay-relay-A",
      headers: { Authorization: `Bearer ${agentToken}` },
    });
    expect(ready.statusCode).toBe(200);
    expect(bodyOf<{ server: McpServer }>(ready).server).toMatchObject({
      lastCheckStatus: "ready",
      lastCheckFailureCode: null,
      lastCheckMissingEnvironment: null,
    });
  });
});

describe("D384 §5.5.1 — GET /api/mcp-servers/relays", () => {
  test("returns the requesting user's connected relays; empty when none", async () => {
    // Agent user owns relay-A; admin user owns relay-B. Both connected.
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
    const agentBody = bodyOf<{ relays: Array<{ relayId: string }> }>(agentRes);
    expect(agentBody.relays).toEqual([{ relayId: "relay-A" }]);

    const adminRes = await app.inject({
      method: "GET",
      url: "/api/mcp-servers/relays",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(adminRes.statusCode).toBe(200);
    const adminBody = bodyOf<{ relays: Array<{ relayId: string }> }>(adminRes);
    expect(adminBody.relays).toEqual([{ relayId: "relay-B" }]);
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
    const body = bodyOf<{ relays: unknown[] }>(res);
    expect(body.relays).toEqual([]);
  });

  test("empty when no registry is installed", async () => {
    setRelayRegistry(null);
    const res = await app.inject({
      method: "GET",
      url: "/api/mcp-servers/relays",
      headers: { Authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = bodyOf<{ relays: unknown[] }>(res);
    expect(body.relays).toEqual([]);
  });

  test("401 without a session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/mcp-servers/relays" });
    expect(res.statusCode).toBe(401);
  });

  test("route is not shadowed by GET /api/mcp-servers/:name (no 404 lookup)", async () => {
    // If `:name` shadowed `/relays`, this would hit the single-row
    // handler and 404 (no row named "relays"). Instead it must return
    // the relays list.
    setRelayRegistry(
      makeFakeRelayRegistry([{ relayId: "relay-A", userId: AGENT_USER_ID }]),
    );
    // Also seed a row named "relays" to PROVE the static route wins
    // over the parametric one even when a row named "relays" exists.
    db.seed({ name: "relays", host: "server", enabled: false });
    const res = await app.inject({
      method: "GET",
      url: "/api/mcp-servers/relays",
      headers: { Authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = bodyOf<{ relays: Array<{ relayId: string }> }>(res);
    expect(body.relays).toEqual([{ relayId: "relay-A" }]);
  });
});

describe("D384 §5.5.2 — owner-gated local create", () => {
  test("non-admin verified user creates host=relay-<ownedId> → 201, enabled=false, host preserved", async () => {
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
        transport: { command: "npx", args: ["-y", "x"] },
        host: "relay-relay-A",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = bodyOf<{ server: { name: string; host: string; enabled: boolean } }>(res);
    expect(body.server.name).toBe("local-fs");
    expect(body.server.host).toBe("relay-relay-A");
    expect(body.server.enabled).toBe(false);

    // Audit row written for the create.
    const createAudit = auditCalls.find(
      (e) =>
        e.kind === "mcp_server_config" &&
        (e as { action?: string }).action === "create",
    );
    expect(createAudit).toBeDefined();
  });

  test("non-owner creating host=relay-<notOwned> → 403 forbidden + capability_check_failed audit", async () => {
    // Agent owns relay-A; tries to create on relay-B (owned by admin).
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
    const body = bodyOf<{ error: string }>(res);
    expect(body.error).toBe("forbidden");

    const audit = auditCalls[0]!;
    expect(audit.kind).toBe("capability_check_failed");
    if (audit.kind !== "capability_check_failed") throw new Error("narrow");
    expect(audit.capability).toBe("own_relay");
    expect(audit.attemptedRoute).toBe("POST /api/mcp-servers");
  });

  test("host=relay-<notConnected> (owned user id, but relay offline) → 403", async () => {
    // No registry installed → no connected relays. Even if the user
    // "would" own it, it isn't connected, so fail closed.
    setRelayRegistry(null);
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

  test("SEC7 regression guard: non-admin with host=server (no host) → 403 capability_missing", async () => {
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
    const body = bodyOf<{ error: string; capability: string }>(res);
    expect(body.error).toBe("capability_missing");
    expect(body.capability).toBe(CAP_MANAGE_SERVER_SECURITY);
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
    const body = bodyOf<{ error: string; capability: string }>(res);
    expect(body.error).toBe("capability_missing");
  });

  test("SEC7 regression guard: admin server-tier create → 201, host=server", async () => {
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
    const body = bodyOf<{ server: { name: string; host: string; enabled: boolean } }>(res);
    expect(body.server.name).toBe("admin-server");
    expect(body.server.host).toBe("server");
    expect(body.server.enabled).toBe(false);
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
    const body = bodyOf<{ error: string }>(res);
    expect(body.error).toBe("forbidden");
  });

  test("host=relay-<ownedId> with a duplicate name → 409 (after ownership passes)", async () => {
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
  });

  test("local PATCH updates only its exact host+name row when friendly names are shared", async () => {
    setRelayRegistry(
      makeFakeRelayRegistry([{ relayId: "relay-A", userId: AGENT_USER_ID }]),
    );
    // Insertion order deliberately makes the local row the route's target;
    // the test fake then proves the compound WHERE cannot touch its official
    // or other-relay namesakes.
    db.seed({ name: "shared", host: "relay-relay-A", enabled: true });
    db.seed({ name: "shared", host: "server", enabled: true });
    db.seed({ name: "shared", host: "relay-relay-B", enabled: true });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/mcp-servers/shared/enabled",
      headers: { Authorization: `Bearer ${agentToken}` },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(bodyOf<{ server: { host: string; enabled: boolean } }>(res).server).toMatchObject({
      host: "relay-relay-A",
      enabled: false,
    });

    const listed = bodyOf<{ servers: Array<{ host: string; enabled: boolean }> }>(
      await app.inject({
        method: "GET",
        url: "/api/mcp-servers",
        headers: { Authorization: `Bearer ${agentToken}` },
      }),
    );
    expect(listed.servers.find((row) => row.host === "server")).toBeUndefined();
    expect(listed.servers.find((row) => row.host === "relay-relay-A")?.enabled).toBe(false);
  });

  test("official and local names are separated by viewer authority", async () => {
    setRelayRegistry(makeFakeRelayRegistry([{ relayId: "relay-A", userId: AGENT_USER_ID }]));
    db.seed({ name: "shared-route", host: "server", enabled: true });
    db.seed({ name: "shared-route", host: "relay-relay-A", enabled: true });

    const personal = await app.inject({
      method: "GET", url: "/api/mcp-servers/shared-route", headers: { Authorization: `Bearer ${agentToken}` },
    });
    expect(personal.statusCode).toBe(200);
    expect(bodyOf<{ server: { host: string } }>(personal).server.host).toBe("relay-relay-A");

    const admin = await app.inject({
      method: "GET", url: "/api/mcp-servers/shared-route", headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(admin.statusCode).toBe(200);
    expect(bodyOf<{ server: { host: string } }>(admin).server.host).toBe("server");

    const official = await app.inject({
      method: "PATCH", url: "/api/mcp-servers/shared-route/enabled?host=server",
      headers: { Authorization: `Bearer ${adminToken}` }, payload: { enabled: false },
    });
    expect(official.statusCode).toBe(200);
    expect(bodyOf<{ server: { host: string } }>(official).server.host).toBe("server");

    const local = await app.inject({
      method: "PATCH", url: "/api/mcp-servers/shared-route/enabled?relayId=relay-A",
      headers: { Authorization: `Bearer ${agentToken}` }, payload: { enabled: false },
    });
    expect(local.statusCode).toBe(200);
    expect(bodyOf<{ server: { host: string } }>(local).server.host).toBe("relay-relay-A");
  });

  test("same owner and name on two relays is deterministic conflict until relayId is supplied", async () => {
    setRelayRegistry(makeFakeRelayRegistry([
      { relayId: "relay-A", userId: AGENT_USER_ID },
      { relayId: "relay-C", userId: AGENT_USER_ID },
    ]));
    db.seed({ name: "twice", host: "relay-relay-A", enabled: true });
    db.seed({ name: "twice", host: "relay-relay-C", enabled: true });
    const ambiguous = await app.inject({
      method: "PATCH", url: "/api/mcp-servers/twice/enabled",
      headers: { Authorization: `Bearer ${agentToken}` }, payload: { enabled: false },
    });
    expect(ambiguous.statusCode).toBe(409);
    const exact = await app.inject({
      method: "PATCH", url: "/api/mcp-servers/twice/enabled?relayId=relay-C",
      headers: { Authorization: `Bearer ${agentToken}` }, payload: { enabled: false },
    });
    expect(exact.statusCode).toBe(200);
    expect(bodyOf<{ server: { host: string } }>(exact).server.host).toBe("relay-relay-C");
  });

  test("generic local route compensates a commit failure and emits no success audit", async () => {
    db.seed({ name: "commit-route", host: "relay-relay-A", enabled: false });
    db.failCommitNumbers.add(1);
    const phases: string[] = [];
    setRelayRegistry({
      listConnected: () => ["relay-A"],
      getUserId: () => AGENT_USER_ID,
      getDesktopSessionId: () => "desktop-route",
      getProtocolVersion: () => RELAY_MCP_TRUTH_PROTOCOL_VERSION,
      configureMcpWithOutcome: async (_relayId: string, request: { operation: { phase: string } }) => {
        phases.push(request.operation.phase);
        return request.operation.phase === "start"
          ? { state: "connected", toolNames: ["tool"] }
          : { state: "stopped", toolNames: [] };
      },
    } as unknown as ToolRelayRegistry);
    const response = await app.inject({
      method: "PATCH",
      url: "/api/mcp-servers/commit-route/enabled?host=relay-relay-A",
      headers: { Authorization: `Bearer ${agentToken}` },
      payload: { enabled: true },
    });
    expect(response.statusCode).toBe(500);
    expect(phases).toEqual(["start", "rollback"]);
    const rows = await db.select().from(null).where(null);
    expect(rows.find((row) => row.name === "commit-route")?.enabled).toBe(false);
    expect(auditCalls).toEqual([]);
  });

  test("generic local route fails a v12 truth error and compensates before returning", async () => {
    db.seed({ name: "failed-route", host: "relay-relay-A", enabled: false });
    const phases: string[] = [];
    let first = true;
    setRelayRegistry({
      listConnected: () => ["relay-A"],
      getUserId: () => AGENT_USER_ID,
      getDesktopSessionId: () => "desktop-route",
      getProtocolVersion: () => RELAY_MCP_TRUTH_PROTOCOL_VERSION,
      configureMcpWithOutcome: async (_relayId: string, request: { operation: { phase: string } }) => {
        phases.push(request.operation.phase);
        if (first) {
          first = false;
          return { state: "failed", toolNames: [], failure: { code: "spawn_failed" } };
        }
        return { state: "stopped", toolNames: [] };
      },
    } as unknown as ToolRelayRegistry);
    const response = await app.inject({
      method: "PATCH",
      url: "/api/mcp-servers/failed-route/enabled?host=relay-relay-A",
      headers: { Authorization: `Bearer ${agentToken}` },
      payload: { enabled: true },
    });
    expect(response.statusCode).toBe(500);
    expect(phases).toEqual(["start", "rollback"]);
    expect(auditCalls).toEqual([]);
  });

  test("generic route rejects same-host duplicate rows without mutation, relay send, or audit", async () => {
    db.seed({ id: "route-duplicate-1", name: "duplicate-route", host: "relay-relay-A", enabled: false });
    db.seed({ id: "route-duplicate-2", name: "duplicate-route", host: "relay-relay-A", enabled: false });
    let sends = 0;
    setRelayRegistry({
      listConnected: () => ["relay-A"],
      getUserId: () => AGENT_USER_ID,
      getDesktopSessionId: () => "desktop-route",
      getProtocolVersion: () => 11,
      sendConfigureMcp: () => { sends++; return true; },
    } as unknown as ToolRelayRegistry);
    const response = await app.inject({
      method: "PATCH",
      url: "/api/mcp-servers/duplicate-route/enabled?host=relay-relay-A",
      headers: { Authorization: `Bearer ${agentToken}` },
      payload: { enabled: true },
    });
    expect(response.statusCode).toBe(409);
    const rows = await db.select().from(null).where(null);
    expect(rows.filter((row) => row.name === "duplicate-route").map((row) => row.enabled)).toEqual([false, false]);
    expect(sends).toBe(0);
    expect(auditCalls).toEqual([]);
  });

  test("two serialized per-tool toggles compute from the locked current row without lost update", async () => {
    db.seed({ name: "tool-race", host: "relay-relay-A", enabled: true, excludeTools: null });
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let configureCount = 0;
    setRelayRegistry({
      listConnected: () => ["relay-A"],
      getUserId: () => AGENT_USER_ID,
      getDesktopSessionId: () => "desktop-route",
      getProtocolVersion: () => RELAY_MCP_TRUTH_PROTOCOL_VERSION,
      configureMcpWithOutcome: async () => {
        configureCount++;
        if (configureCount === 1) await firstGate;
        return { state: "connected", toolNames: ["one", "two"] };
      },
    } as unknown as ToolRelayRegistry);
    const first = app.inject({
      method: "PATCH",
      url: "/api/mcp-servers/tool-race/tools/one?host=relay-relay-A",
      headers: { Authorization: `Bearer ${agentToken}` },
      payload: { enabled: false },
    });
    await waitFor(() => configureCount === 1);
    const second = app.inject({
      method: "PATCH",
      url: "/api/mcp-servers/tool-race/tools/two?host=relay-relay-A",
      headers: { Authorization: `Bearer ${agentToken}` },
      payload: { enabled: false },
    });
    releaseFirst?.();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    const rows = await db.select().from(null).where(null);
    expect(rows.find((row) => row.name === "tool-race")?.excludeTools?.sort()).toEqual(["one", "two"]);
  });

  test("a local route mutation waits for an in-flight installer fleet transaction", async () => {
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const configureCalls: Array<{ phase: string; servers: readonly { name: string }[] }> = [];
    const legacyConfigures: Array<readonly { name: string }[]> = [];
    const relay = {
      listConnected: () => ["relay-A"],
      getUserId: (relayId: string) => relayId === "relay-A" ? AGENT_USER_ID : null,
      getCapabilities: () => ({ mcpTools: [] }),
      getProtocolVersion: () => RELAY_MCP_TRUTH_PROTOCOL_VERSION,
      getDesktopSessionId: () => "desktop-A",
      preflightMcp: async () => ({
        machineLabel: "Agent Mac",
        launcher: "present" as const,
        environment: [],
        status: "ready" as const,
      }),
      configureMcpWithOutcome: async (_relayId: string, request: {
        operation: { phase: "start" | "rollback" };
        servers: readonly { name: string }[];
      }) => {
        configureCalls.push({ phase: request.operation.phase, servers: request.servers });
        if (request.operation.phase === "start") await startGate;
        return request.operation.phase === "start"
          ? { state: "connected" as const, toolNames: ["issues_list"] }
          : { state: "stopped" as const, toolNames: [] };
      },
      sendConfigureMcp: (_relayId: string, servers: readonly { name: string }[]) => {
        legacyConfigures.push(servers);
        return true;
      },
    };
    setRelayRegistry(relay as unknown as ToolRelayRegistry);
    db.seed({ name: "legacy", host: "relay-relay-A", enabled: true });
    const service = createLocalMcpInstallService(db as unknown as DirectDatabase);
    const prepared = await service.prepare({
      actorId: AGENT_USER_ID,
      approvalId: "local-mcp-install:turn-1:lane:install-call",
      threadId: "thread-1",
      laneKey: "lane",
      toolCallId: "install-call",
      checkpointKey: "turn-1",
      intent: {
        version: "local-mcp-install-v1",
        name: "github",
        relayId: "relay-A",
        transport: {
          kind: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github@2025.1.0"],
        },
        package: { name: "@modelcontextprotocol/server-github", version: "2025.1.0" },
        source: { url: "https://github.com/modelcontextprotocol/servers" },
        environment: [],
      },
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("expected prepared install");
    const installRun = service.install({
      actorId: AGENT_USER_ID,
      prepared: prepared.prepared,
      approvalId: prepared.prepared.binding.approvalId,
      toolCallId: prepared.prepared.binding.toolCallId,
      digest: prepared.prepared.binding.digest,
    });
    try {
      await waitFor(() => configureCalls.length === 1);
      expect(configureCalls[0]?.servers.map((server) => server.name).sort()).toEqual(["github", "legacy"]);

      const disableRun = app.inject({
        method: "PATCH",
        url: "/api/mcp-servers/legacy/enabled",
        headers: { Authorization: `Bearer ${agentToken}` },
        payload: { enabled: false },
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(legacyConfigures).toEqual([]);

      releaseStart?.();
      expect((await installRun).ok).toBe(true);
      expect((await disableRun).statusCode).toBe(200);
      expect(configureCalls[1]?.phase).toBe("rollback");
      expect(configureCalls[1]?.servers.map((server) => server.name)).toEqual(["github"]);
    } finally {
      releaseStart?.();
      await installRun.catch(() => undefined);
    }
  });
});
