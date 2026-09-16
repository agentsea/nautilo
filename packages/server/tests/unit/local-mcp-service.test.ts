/**
 * D384 §5.4 — unit tests for the shared local-tier MCP config service.
 *
 * Fake DirectDatabase (in-memory) + fake relay registry (installed via
 * `setRelayRegistry`, which is what `connection-status.listConnectedRelaysForUser`
 * reads). No Postgres, no live relay.
 *
 * Locks:
 *   - createLocalMcpServer owner happy path (enabled=false, host preserved)
 *   - non-owner / not-connected → not_owner (no row written)
 *   - duplicate name → duplicate (after ownership)
 *   - setLocalMcpEnabled refuses server-tier + non-owner; flips owned local rows
 *   - listLocalMcpServersForUser returns only the user's own local rows
 *   - assertLocalTierOnly rejects host=server, accepts relay-<id>
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { DirectDatabase, McpServer } from "@nautilo/db";
import { setRelayRegistry, type ToolRelayRegistry } from "@nautilo/agent";
import { ToolCatalog, initToolCatalog, clearToolCatalog } from "@nautilo/catalog";
import { RELAY_MCP_TRUTH_PROTOCOL_VERSION, type RelayAdvertisedMcpTool } from "@nautilo/relay";

import {
  assertLocalTierOnly,
  createLocalMcpServer,
  createLocalMcpToolRuntime,
  listLocalMcpServersForUser,
  LocalTierViolationError,
  removeLocalMcpServer,
  setLocalMcpEnabled,
} from "../../src/mcp/local-mcp-service";
import { registerRelayAdvertisedTools } from "../../src/mcp/relay-mcp-bridge";
import { setLocalMcpInstallRelaySocketSafetyCloser } from "../../src/mcp/local-mcp-install-service";

// ---------------------------------------------------------------------------
// In-memory fake DirectDatabase (mirrors the mcp-servers-route test fake).
// ---------------------------------------------------------------------------

function expressionValues(value: unknown, result: unknown[] = [], seen = new WeakSet<object>()): unknown[] {
  if (!value || typeof value !== "object") return result;
  if (Array.isArray(value)) {
    for (const item of value) expressionValues(item, result, seen);
    return result;
  }
  if (seen.has(value)) return result;
  seen.add(value);
  const record = value as Record<string, unknown>;
  if ("value" in record && ["string", "boolean"].includes(typeof record["value"])) {
    result.push(record["value"]);
  }
  for (const child of Object.values(record)) expressionValues(child, result, seen);
  return result;
}

class FakeDb {
  private rows: McpServer[] = [];
  failCommitNumbers = new Set<number>();
  transactionCount = 0;

  async transaction<T>(callback: (tx: FakeDb) => Promise<T>): Promise<T> {
    const number = ++this.transactionCount;
    const snapshot = this.rows.map((row) => ({ ...row }));
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

  reset(): void {
    this.rows = [];
  }

  seed(row: Partial<McpServer> & Pick<McpServer, "name">): McpServer {
    const full = this.makeFullRow(row);
    this.rows.push(full);
    return full;
  }

  get(name: string, host?: string): McpServer | undefined {
    return this.rows.find((row) => row.name === name && (host === undefined || row.host === host));
  }

  snapshot(): string {
    return JSON.stringify(this.rows);
  }

  private all(): McpServer[] {
    return [...this.rows];
  }

  private matching(expr: unknown): McpServer[] {
    const values = expressionValues(expr);
    const strings = values.filter((value): value is string => typeof value === "string");
    const booleans = values.filter((value): value is boolean => typeof value === "boolean");
    return this.rows.filter((row) =>
      strings.every((value) => value === row.name || value === row.host) &&
      booleans.every((value) => row.enabled === value),
    );
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

  select(_fields?: unknown) {
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

  insert(_table: unknown) {
    return {
      values: (row: Partial<McpServer>) => ({
        returning: async (): Promise<McpServer[]> => {
          const full = this.makeFullRow(row);
          this.rows.push(full);
          return [full];
        },
      }),
    };
  }

  update(_table: unknown) {
    return {
      set: (patch: Partial<McpServer>) => ({
        where: (expr: unknown) => ({
          returning: async (): Promise<McpServer[]> => {
            const matched = this.matching(expr);
            this.rows = this.rows.map((row) => matched.includes(row)
              ? { ...row, ...patch, updatedAt: patch.updatedAt ?? new Date() }
              : row);
            return this.rows.filter((row) => matched.some((before) => before.id === row.id));
          },
        }),
      }),
    };
  }

  delete(_table: unknown) {
    return {
      where: (expr: unknown) => ({
        returning: async (): Promise<McpServer[]> => {
          const matched = this.matching(expr);
          this.rows = this.rows.filter((row) => !matched.includes(row));
          return matched;
        },
      }),
    };
  }
}

function makeFakeRelayRegistry(
  relays: ReadonlyArray<{ relayId: string; userId: string }>,
  opts?: { withConfigure?: boolean },
): ToolRelayRegistry {
  const byId = new Map(relays.map((r) => [r.relayId, r.userId] as const));
  const base: Record<string, unknown> = {
    listConnected: () => relays.map((r) => r.relayId),
    getUserId: (relayId: string) => byId.get(relayId) ?? null,
  };
  // Presence of `sendConfigureMcp` is what makes `reconfigureRelayNow` report
  // the relay as LIVE (relayLive=true) so `enable` waits for tools.
  if (opts?.withConfigure) {
    base["getDesktopSessionId"] = (relayId: string) => byId.has(relayId) ? `desktop-${relayId}` : null;
    base["getProtocolVersion"] = () => 11;
    base["sendConfigureMcp"] = (relayId: string) => byId.has(relayId);
  }
  return base as unknown as ToolRelayRegistry;
}

function installV12Registry(states: Array<"connected" | "stopped" | "failed">) {
  const calls: Array<{ phase: "start" | "rollback"; names: string[]; session: string }> = [];
  setRelayRegistry({
    listConnected: () => ["A"],
    getUserId: () => ALICE,
    getDesktopSessionId: () => "desktop-A",
    getProtocolVersion: () => RELAY_MCP_TRUTH_PROTOCOL_VERSION,
    configureMcpWithOutcome: async (_relayId: string, request: {
      operation: { phase: "start" | "rollback" };
      servers: Array<{ name: string }>;
      expectedDesktopSessionId: string;
    }) => {
      calls.push({
        phase: request.operation.phase,
        names: request.servers.map((server) => server.name),
        session: request.expectedDesktopSessionId,
      });
      const state = states.shift() ?? "stopped";
      return state === "failed"
        ? { state, toolNames: [], failure: { code: "spawn_failed" } }
        : { state, toolNames: state === "connected" ? ["tool"] : [] };
    },
  } as unknown as ToolRelayRegistry);
  return calls;
}

const READ_ONLY_TOOL: RelayAdvertisedMcpTool = {
  name: "gh-do-thing",
  description: "does a thing",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const ALICE = "user-alice";
const BOB = "user-bob";

let db: FakeDb;
function asDb(): DirectDatabase {
  return db as unknown as DirectDatabase;
}

beforeEach(() => {
  db = new FakeDb();
  setRelayRegistry(makeFakeRelayRegistry([{ relayId: "A", userId: ALICE }]));
});

afterEach(() => {
  setRelayRegistry(null);
  setLocalMcpInstallRelaySocketSafetyCloser(null);
});

const STDIO_FIELDS = {
  name: "gh",
  transportKind: "stdio" as const,
  transport: { command: "npx", args: ["-y", "server-github"] },
  envPassthrough: ["GITHUB_TOKEN"],
};

// ---------------------------------------------------------------------------
// createLocalMcpServer
// ---------------------------------------------------------------------------

describe("createLocalMcpServer", () => {
  test("owner happy path: enabled=false, host=relay-<id>, secret-free fields preserved", async () => {
    const result = await createLocalMcpServer(asDb(), {
      userId: ALICE,
      relayId: "A",
      fields: STDIO_FIELDS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("narrow");
    expect(result.row.host).toBe("relay-A");
    expect(result.row.enabled).toBe(false);
    expect(result.row.envPassthrough).toEqual(["GITHUB_TOKEN"]);
    // No secrets persisted.
    expect(result.row.envLiteral).toBeNull();
    expect(result.row.authRef).toBeNull();
    expect(db.get("gh")?.host).toBe("relay-A");
  });

  test("non-owner refused (not_owner) — no row written", async () => {
    const result = await createLocalMcpServer(asDb(), {
      userId: BOB,
      relayId: "A",
      fields: STDIO_FIELDS,
    });
    expect(result).toEqual({ ok: false, reason: "not_owner" });
    expect(db.get("gh")).toBeUndefined();
  });

  test("relay not connected refused (not_owner)", async () => {
    setRelayRegistry(makeFakeRelayRegistry([{ relayId: "A", userId: ALICE }]));
    const result = await createLocalMcpServer(asDb(), {
      userId: ALICE,
      relayId: "Z",
      fields: STDIO_FIELDS,
    });
    expect(result).toEqual({ ok: false, reason: "not_owner" });
  });

  test("duplicate name refused after ownership passes", async () => {
    db.seed({ name: "gh", host: "relay-A", enabled: false });
    const result = await createLocalMcpServer(asDb(), {
      userId: ALICE,
      relayId: "A",
      fields: STDIO_FIELDS,
    });
    expect(result).toEqual({ ok: false, reason: "duplicate" });
  });

  test("allows a local row whose friendly name is already used by an official row", async () => {
    db.seed({ name: "gh", host: "server", enabled: true });
    const result = await createLocalMcpServer(asDb(), {
      userId: ALICE,
      relayId: "A",
      fields: STDIO_FIELDS,
    });
    expect(result.ok).toBe(true);
    expect(db.get("gh", "server")?.enabled).toBe(true);
    expect(db.get("gh", "relay-A")?.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// setLocalMcpEnabled
// ---------------------------------------------------------------------------

describe("setLocalMcpEnabled", () => {
  test("owner enables their local row", async () => {
    db.seed({ name: "gh", host: "relay-A", enabled: false });
    const result = await setLocalMcpEnabled(asDb(), { userId: ALICE, name: "gh", enabled: true });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("narrow");
    expect(result.row.enabled).toBe(true);
    expect(db.get("gh")?.enabled).toBe(true);
  });

  test("updates only the owned host+name row when names are shared across tiers and relays", async () => {
    db.seed({ name: "gh", host: "server", enabled: true });
    db.seed({ name: "gh", host: "relay-B", enabled: false });
    db.seed({ name: "gh", host: "relay-A", enabled: false });
    const result = await setLocalMcpEnabled(asDb(), { userId: ALICE, name: "gh", enabled: true });
    expect(result).toMatchObject({ ok: true, row: { host: "relay-A", enabled: true } });
    expect(db.get("gh", "server")?.enabled).toBe(true);
    expect(db.get("gh", "relay-B")?.enabled).toBe(false);
    expect(db.get("gh", "relay-A")?.enabled).toBe(true);
  });

  test("same owner on two relays must disambiguate by relayId", async () => {
    setRelayRegistry(makeFakeRelayRegistry([
      { relayId: "A", userId: ALICE },
      { relayId: "C", userId: ALICE },
    ]));
    db.seed({ name: "gh", host: "relay-A", enabled: true });
    db.seed({ name: "gh", host: "relay-C", enabled: true });
    expect(await setLocalMcpEnabled(asDb(), { userId: ALICE, name: "gh", enabled: false }))
      .toEqual({ ok: false, reason: "ambiguous" });
    const exact = await setLocalMcpEnabled(asDb(), {
      userId: ALICE, name: "gh", enabled: false, relayId: "C",
    });
    expect(exact).toMatchObject({ ok: true, row: { host: "relay-C", enabled: false } });
    expect(db.get("gh", "relay-A")?.enabled).toBe(true);
  });

  test("commit failure after v12 enable compensates to durable disabled truth and reports failure", async () => {
    db.seed({ name: "gh", host: "relay-A", enabled: false });
    db.failCommitNumbers.add(1);
    const calls = installV12Registry(["connected", "stopped"]);
    const audits: unknown[] = [];
    const runtime = createLocalMcpToolRuntime({ db: asDb(), audit: (event) => audits.push(event) });
    const result = await runtime.setEnabled({ userId: ALICE }, { name: "gh", enabled: true });
    expect(result.ok).toBe(false);
    expect(db.get("gh", "relay-A")?.enabled).toBe(false);
    expect(db.transactionCount).toBe(2);
    expect(calls.map((call) => call.phase)).toEqual(["start", "rollback"]);
    expect(calls.every((call) => call.session === "desktop-A")).toBe(true);
    expect(audits).toEqual([]);
  });

  test("failed v12 reconcile rolls back, compensates, and emits no success audit", async () => {
    db.seed({ name: "gh", host: "relay-A", enabled: false });
    const calls = installV12Registry(["failed", "stopped"]);
    const audits: unknown[] = [];
    const runtime = createLocalMcpToolRuntime({ db: asDb(), audit: (event) => audits.push(event) });
    const result = await runtime.setEnabled({ userId: ALICE }, { name: "gh", enabled: true });
    expect(result.ok).toBe(false);
    expect(db.get("gh", "relay-A")?.enabled).toBe(false);
    expect(calls.map((call) => call.phase)).toEqual(["start", "rollback"]);
    expect(audits).toEqual([]);
  });

  test("same-host duplicate rows remain byte-for-byte unchanged with no relay command or audit", async () => {
    db.seed({ id: "duplicate-1", name: "gh", host: "relay-A", enabled: false });
    db.seed({ id: "duplicate-2", name: "gh", host: "relay-A", enabled: false });
    const before = db.snapshot();
    const calls = installV12Registry([]);
    const audits: unknown[] = [];
    const runtime = createLocalMcpToolRuntime({ db: asDb(), audit: (event) => audits.push(event) });
    const result = await runtime.setEnabled({ userId: ALICE }, { name: "gh", enabled: true });
    expect(result.ok).toBe(false);
    expect(db.snapshot()).toBe(before);
    expect(calls).toEqual([]);
    expect(audits).toEqual([]);
  });

  test("refuses a server-tier row (not_local_tier)", async () => {
    db.seed({ name: "official", host: "server", enabled: false });
    const result = await setLocalMcpEnabled(asDb(), {
      userId: ALICE,
      name: "official",
      enabled: true,
    });
    expect(result).toEqual({ ok: false, reason: "not_local_tier" });
    expect(db.get("official")?.enabled).toBe(false);
  });

  test("refuses a non-owner's local row (not_owner)", async () => {
    db.seed({ name: "gh", host: "relay-A", enabled: false });
    const result = await setLocalMcpEnabled(asDb(), { userId: BOB, name: "gh", enabled: true });
    expect(result).toEqual({ ok: false, reason: "not_owner" });
  });

  test("missing row (not_found)", async () => {
    const result = await setLocalMcpEnabled(asDb(), { userId: ALICE, name: "nope", enabled: true });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("removeLocalMcpServer", () => {
  test("owner deletion stops the exact live MCP and removes its row", async () => {
    db.seed({ name: "gh", host: "relay-A", enabled: true });
    const calls = installV12Registry(["stopped"]);
    const result = await removeLocalMcpServer(asDb(), { userId: ALICE, name: "gh", relayId: "A" });
    expect(result).toMatchObject({ ok: true, row: { name: "gh", host: "relay-A" }, relayLive: true });
    expect(db.get("gh", "relay-A")).toBeUndefined();
    expect(calls).toEqual([{ phase: "rollback", names: [], session: "desktop-A" }]);
  });

  test("refuses server-tier and foreign local rows", async () => {
    db.seed({ name: "official", host: "server", enabled: true });
    db.seed({ name: "foreign", host: "relay-A", enabled: true });
    expect(await removeLocalMcpServer(asDb(), { userId: ALICE, name: "official" }))
      .toEqual({ ok: false, reason: "not_local_tier" });
    expect(await removeLocalMcpServer(asDb(), { userId: BOB, name: "foreign" }))
      .toEqual({ ok: false, reason: "not_owner" });
    expect(db.get("official", "server")).toBeDefined();
    expect(db.get("foreign", "relay-A")).toBeDefined();
  });

  test("same-name rows on two owned relays require exact relayId", async () => {
    setRelayRegistry(makeFakeRelayRegistry([
      { relayId: "A", userId: ALICE },
      { relayId: "C", userId: ALICE },
    ]));
    db.seed({ name: "gh", host: "relay-A", enabled: true });
    db.seed({ name: "gh", host: "relay-C", enabled: true });
    expect(await removeLocalMcpServer(asDb(), { userId: ALICE, name: "gh" }))
      .toEqual({ ok: false, reason: "ambiguous" });
    expect((await removeLocalMcpServer(asDb(), { userId: ALICE, name: "gh", relayId: "C" })).ok)
      .toBe(true);
    expect(db.get("gh", "relay-A")).toBeDefined();
    expect(db.get("gh", "relay-C")).toBeUndefined();
  });

  test("commit failure restores the row and reports failure without audit", async () => {
    db.seed({ name: "gh", host: "relay-A", enabled: true });
    db.failCommitNumbers.add(1);
    const calls = installV12Registry(["stopped", "connected"]);
    const audits: unknown[] = [];
    const runtime = createLocalMcpToolRuntime({ db: asDb(), audit: (event) => audits.push(event) });
    const result = await runtime.remove({ userId: ALICE }, { name: "gh", relayId: "A" });
    expect(result.ok).toBe(false);
    expect(db.get("gh", "relay-A")).toBeDefined();
    expect(calls.map((call) => call.phase)).toEqual(["rollback", "start"]);
    expect(audits).toEqual([]);
  });

  test("runtime emits a delete audit only after successful removal", async () => {
    db.seed({ name: "gh", host: "relay-A", enabled: true });
    const audits: unknown[] = [];
    const runtime = createLocalMcpToolRuntime({ db: asDb(), audit: (event) => audits.push(event) });
    const result = await runtime.remove({ userId: ALICE }, { name: "gh" });
    expect(result).toMatchObject({ ok: true, server: { name: "gh", enabled: false, health: "removed", toolCount: 0 } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "delete", serverName: "gh" });
  });
});

// ---------------------------------------------------------------------------
// createLocalMcpToolRuntime — the agent-facing adapter (async-loading note)
// ---------------------------------------------------------------------------

describe("createLocalMcpToolRuntime.setEnabled (deterministic wait, D384 P5)", () => {
  afterEach(() => clearToolCatalog());

  test("enable on a LIVE relay that advertises tools returns the REAL tool count with no note (deterministic success)", async () => {
    db.seed({ name: "gh", host: "relay-A", enabled: false });
    setRelayRegistry(
      makeFakeRelayRegistry([{ relayId: "A", userId: ALICE }], { withConfigure: true }),
    );
    // Simulate the relay having advertised its tools into the catalog.
    const catalog = new ToolCatalog();
    await registerRelayAdvertisedTools({
      db: asDb(),
      catalog,
      relayId: "A",
      serverName: "gh",
      tools: [READ_ONLY_TOOL],
    });
    initToolCatalog(catalog);

    const audited: string[] = [];
    const runtime = createLocalMcpToolRuntime({
      db: asDb(),
      audit: (e) => audited.push(e.kind),
      toolsWaitMs: 1_000,
      toolsPollIntervalMs: 10,
    });
    const result = await runtime.setEnabled({ userId: ALICE }, { name: "gh", enabled: true });
    expect(result.ok).toBe(true);
    expect(result.server?.enabled).toBe(true);
    expect(result.server?.toolCount).toBe(1);
    expect(result.server?.health).toBe("connected");
    expect(result.note).toBeUndefined();
    expect(audited).toEqual(["mcp_server_config"]);
  });

  test("enable on a LIVE relay that advertises nothing waits the budget then reports the real empty state + status hint", async () => {
    db.seed({ name: "gh", host: "relay-A", enabled: false });
    setRelayRegistry(
      makeFakeRelayRegistry([{ relayId: "A", userId: ALICE }], { withConfigure: true }),
    );
    const runtime = createLocalMcpToolRuntime({
      db: asDb(),
      audit: () => {},
      toolsWaitMs: 40,
      toolsPollIntervalMs: 10,
    });
    const result = await runtime.setEnabled({ userId: ALICE }, { name: "gh", enabled: true });
    expect(result.ok).toBe(true);
    expect(result.server?.toolCount).toBe(0);
    expect(result.note).toBeDefined();
    expect(result.note).toContain("no tools");
    expect(result.note).toContain("status");
  });

  test("enable when the relay can't be reached reports it will start on reconnect (no false success)", async () => {
    db.seed({ name: "gh", host: "relay-A", enabled: false });
    // Default registry (no sendConfigureMcp) → reconfigure no-op → relayLive=false.
    const runtime = createLocalMcpToolRuntime({
      db: asDb(),
      audit: () => {},
      toolsWaitMs: 40,
      toolsPollIntervalMs: 10,
    });
    const result = await runtime.setEnabled({ userId: ALICE }, { name: "gh", enabled: true });
    expect(result.ok).toBe(true);
    expect(result.note).toBeDefined();
    expect(result.note).toContain("reconnect");
  });

  test("disable carries no note", async () => {
    db.seed({ name: "gh", host: "relay-A", enabled: true });
    const runtime = createLocalMcpToolRuntime({ db: asDb(), audit: () => {} });
    const result = await runtime.setEnabled({ userId: ALICE }, { name: "gh", enabled: false });
    expect(result.ok).toBe(true);
    expect(result.note).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listLocalMcpServersForUser
// ---------------------------------------------------------------------------

describe("listLocalMcpServersForUser", () => {
  test("returns only the user's own local rows (excludes server-tier + others' relays)", async () => {
    setRelayRegistry(
      makeFakeRelayRegistry([
        { relayId: "A", userId: ALICE },
        { relayId: "B", userId: BOB },
      ]),
    );
    db.seed({ name: "gh", host: "relay-A", enabled: false });
    db.seed({ name: "official", host: "server", enabled: true });
    db.seed({ name: "bobs", host: "relay-B", enabled: false });

    const rows = await listLocalMcpServersForUser(asDb(), ALICE);
    expect(rows.map((r) => r.name)).toEqual(["gh"]);
  });
});

// ---------------------------------------------------------------------------
// assertLocalTierOnly
// ---------------------------------------------------------------------------

describe("assertLocalTierOnly", () => {
  test("accepts a relay-<id> host", () => {
    expect(() => assertLocalTierOnly("relay-A")).not.toThrow();
  });

  test("rejects host=server", () => {
    expect(() => assertLocalTierOnly("server")).toThrow(LocalTierViolationError);
  });

  test("rejects a malformed relay host", () => {
    expect(() => assertLocalTierOnly("relay-")).toThrow(LocalTierViolationError);
  });
});
