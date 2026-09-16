import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { DirectDatabase, McpServer } from "@nautilo/db";
import { setRelayRegistry } from "@nautilo/agent";
import { RELAY_MCP_TRUTH_PROTOCOL_VERSION } from "@nautilo/relay";
import type { LocalMcpInstallPrepared } from "@nautilo/types";
import type { SecurityAuditEvent } from "../../src/lib/security-audit-log";
import {
  createLocalMcpInstallService,
  setLocalMcpInstallRelaySocketSafetyCloser,
} from "../../src/mcp/local-mcp-install-service";
import { setLocalMcpEnabled } from "../../src/mcp/local-mcp-service";

function expressionValues(value: unknown, result: unknown[] = [], seen = new WeakSet<object>()): unknown[] {
  if (!value || typeof value !== "object") return result;
  if (Array.isArray(value)) {
    for (const item of value) expressionValues(item, result, seen);
    return result;
  }
  if (seen.has(value)) return result;
  seen.add(value);
  const record = value as Record<string, unknown>;
  if ("value" in record && ["string", "boolean"].includes(typeof record["value"])) result.push(record["value"]);
  for (const child of Object.values(record)) expressionValues(child, result, seen);
  return result;
}

class FakeDb {
  rows: McpServer[] = [];
  throwOnEnabledFleetRead = false;
  failCommitNumbers = new Set<number>();
  transactionCount = 0;

  async transaction<T>(callback: (tx: FakeDb) => Promise<T>): Promise<T> {
    const number = ++this.transactionCount;
    const snapshot = this.rows.map((row) => ({ ...row }));
    const result = await callback(this);
    if (this.failCommitNumbers.has(number)) {
      this.rows = snapshot;
      throw new Error("commit failed");
    }
    return result;
  }

  private full(input: Partial<McpServer>): McpServer {
    return {
      id: input.id ?? randomUUID(), name: input.name ?? "", host: input.host ?? "server",
      transportKind: input.transportKind ?? "stdio", transport: input.transport ?? {},
      envPassthrough: input.envPassthrough ?? null, envLiteral: null, authRef: null,
      namespaceId: null, includeTools: null, excludeTools: null, enabled: input.enabled ?? false,
      trustTier: null, spawnSandboxProfile: null, lastCheckStatus: input.lastCheckStatus ?? null,
      lastCheckFailureCode: input.lastCheckFailureCode ?? null,
      lastCheckMissingEnvironment: input.lastCheckMissingEnvironment ?? null,
      lastCheckedAt: input.lastCheckedAt ?? null, lastConnectedAt: input.lastConnectedAt ?? null,
      createdAt: new Date(), updatedAt: new Date(),
    };
  }

  private matching(expr: unknown): McpServer[] {
    const values = expressionValues(expr);
    const strings = values.filter((value): value is string => typeof value === "string");
    const bool = values.find((value): value is boolean => typeof value === "boolean");
    return this.rows.filter((row) =>
      strings.every((value) => value === row.name || value === row.host) &&
      (bool === undefined || row.enabled === bool),
    );
  }

  select() {
    return {
      from: () => ({
        where: async (expr: unknown) => {
          if (this.throwOnEnabledFleetRead && expressionValues(expr).includes(true)) {
            throw new Error("fleet read unavailable");
          }
          return this.matching(expr);
        },
      }),
    };
  }
  insert() { return { values: (input: Partial<McpServer>) => ({ returning: async () => {
    const row = this.full(input); this.rows.push(row); return [row];
  } }) }; }
  update() { return { set: (patch: Partial<McpServer>) => ({ where: (expr: unknown) => ({ returning: async () => {
    const matched = this.matching(expr);
    this.rows = this.rows.map((row) => matched.includes(row) ? { ...row, ...patch } : row);
    return this.rows.filter((row) => matched.some((before) => before.id === row.id));
  } }) }) }; }

  row(name: string, host: string): McpServer | undefined {
    return this.rows.find((item) => item.name === name && item.host === host);
  }
}

class FakeRelay {
  desktopSessionId = "desktop-session-1";
  preflightStatus: "ready" | "blocked" = "ready";
  preflightFailure: { code: "missing_launcher" | "missing_environment" } | undefined;
  configureStates: Array<"connected" | "failed" | "stopped"> = ["connected"];
  configureFailure: "spawn_failed" | "protocol_failed" = "spawn_failed";
  configureErrors: Error[] = [];
  configureGate: Promise<void> | undefined;
  onConfigure: ((phase: "start" | "rollback") => void) | undefined;
  preflightExpectedSessions: string[] = [];
  configureCalls: Array<{
    phase: "start" | "rollback";
    servers: readonly { name: string }[];
    expectedDesktopSessionId: string;
  }> = [];
  legacyConfigureCalls: Array<readonly { name: string }[]> = [];

  listConnected() { return ["relay-1"]; }
  getUserId(relayId: string) { return relayId === "relay-1" ? "user-1" : null; }
  getCapabilities() { return { mcpTools: { version: 1 }, profile: "desktop-agent" }; }
  getProtocolVersion() { return RELAY_MCP_TRUTH_PROTOCOL_VERSION; }
  getDesktopSessionId() { return this.desktopSessionId; }
  sendConfigureMcp(_relayId: string, servers: readonly { name: string }[]) {
    this.legacyConfigureCalls.push(servers);
    return true;
  }
  async preflightMcp(_relayId: string, request: {
    expectedDesktopSessionId: string;
    server: { envPassthrough?: string[] | null };
  }) {
    this.preflightExpectedSessions.push(request.expectedDesktopSessionId);
    if (request.expectedDesktopSessionId !== this.desktopSessionId) {
      throw Object.assign(new Error("relay replaced"), { code: "relay_replaced" });
    }
    return {
      machineLabel: "Writer Mac", launcher: "present" as const,
      environment: (request.server.envPassthrough ?? []).map((name) => ({ name, present: this.preflightStatus === "ready" })),
      status: this.preflightStatus,
      ...(this.preflightStatus === "blocked" ? { failure: this.preflightFailure ?? { code: "missing_environment" as const } } : {}),
    };
  }
  async configureMcpWithOutcome(_relayId: string, request: {
    expectedDesktopSessionId: string;
    operation: { phase: "start" | "rollback" };
    servers: readonly { name: string }[];
  }) {
    if (request.expectedDesktopSessionId !== this.desktopSessionId) {
      throw Object.assign(new Error("relay replaced"), { code: "relay_replaced" });
    }
    this.configureCalls.push({
      phase: request.operation.phase,
      servers: request.servers,
      expectedDesktopSessionId: request.expectedDesktopSessionId,
    });
    this.onConfigure?.(request.operation.phase);
    await this.configureGate;
    const configuredError = this.configureErrors.shift();
    if (configuredError) throw configuredError;
    const state = this.configureStates.shift() ?? "stopped";
    return {
      operationId: "operation", digest: "digest", targetName: "target", state,
      toolNames: state === "connected" ? ["issues_list", "issues_create"] : [],
      ...(state === "failed" ? { failure: { code: this.configureFailure } } : {}),
    };
  }
}

const intent = {
  version: "local-mcp-install-v1" as const,
  name: "github-mcp",
  transport: { kind: "stdio" as const, command: "npx", args: ["-y", "@modelcontextprotocol/server-github@2025.1.0"] },
  source: { url: "https://github.com/modelcontextprotocol/servers#github" },
  package: { name: "@modelcontextprotocol/server-github", version: "2025.1.0" },
  environment: ["GITHUB_TOKEN"],
};

let db: FakeDb;
let relay: FakeRelay;

beforeEach(() => { db = new FakeDb(); relay = new FakeRelay(); setRelayRegistry(relay as never); });
afterEach(() => { setRelayRegistry(null); setLocalMcpInstallRelaySocketSafetyCloser(null); });

async function prepare(
  service = createLocalMcpInstallService(db as unknown as DirectDatabase),
  input: { approvalId?: string; toolCallId?: string; localIntent?: typeof intent } = {},
) {
  const result = await service.prepare({
    actorId: "user-1", intent: input.localIntent ?? intent,
    approvalId: input.approvalId ?? "local-mcp-install:thread:lane:call",
    threadId: "thread", laneKey: "lane", toolCallId: input.toolCallId ?? "call", checkpointKey: "checkpoint",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected preparation");
  return { service, accepted: result.prepared };
}

function install(service: ReturnType<typeof createLocalMcpInstallService>, accepted: LocalMcpInstallPrepared, actorId = "user-1") {
  return service.install({
    actorId, prepared: accepted, approvalId: accepted.binding.approvalId,
    toolCallId: accepted.binding.toolCallId, digest: accepted.binding.digest,
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition did not become true");
}

describe("LocalMcpInstallService", () => {
  test("uses exact host+name persistence and enables only after truth-channel tools", async () => {
    db.rows.push({
      id: randomUUID(), name: "github-mcp", host: "server", transportKind: "stdio", transport: {},
      envPassthrough: null, envLiteral: null, authRef: null, namespaceId: null, includeTools: null,
      excludeTools: null, enabled: true, trustTier: null, spawnSandboxProfile: null, createdAt: new Date(), updatedAt: new Date(),
      lastCheckStatus: null, lastCheckFailureCode: null, lastCheckMissingEnvironment: null, lastCheckedAt: null, lastConnectedAt: null,
    });
    db.rows.push({
      id: randomUUID(), name: "github-mcp", host: "relay-other-user", transportKind: "stdio", transport: {},
      envPassthrough: null, envLiteral: null, authRef: null, namespaceId: null, includeTools: null,
      excludeTools: null, enabled: true, trustTier: null, spawnSandboxProfile: null, createdAt: new Date(), updatedAt: new Date(),
      lastCheckStatus: null, lastCheckFailureCode: null, lastCheckMissingEnvironment: null, lastCheckedAt: null, lastConnectedAt: null,
    });
    const { service, accepted } = await prepare();
    const result = await install(service, accepted);
    expect(result).toMatchObject({ ok: true, name: "github-mcp", toolNames: ["issues_list", "issues_create"] });
    expect(db.row("github-mcp", "server")?.enabled).toBe(true);
    expect(db.row("github-mcp", "relay-other-user")?.enabled).toBe(true);
    expect(db.row("github-mcp", "relay-relay-1")?.enabled).toBe(true);
    expect(db.row("github-mcp", "relay-relay-1")).toMatchObject({
      lastCheckStatus: "connected",
      lastCheckFailureCode: null,
    });
    expect(db.row("github-mcp", "relay-relay-1")?.lastConnectedAt).toBeInstanceOf(Date);
    expect(relay.configureCalls[0]?.servers.map((server) => server.name)).toEqual(["github-mcp"]);
    expect(relay.preflightExpectedSessions).toEqual(["desktop-session-1", "desktop-session-1"]);
    expect(relay.configureCalls[0]?.expectedDesktopSessionId).toBe("desktop-session-1");
  });

  test("requires the exact checkpoint-carried receipt and actor", async () => {
    const { service, accepted } = await prepare();
    const crossUser = await install(service, accepted, "other-user");
    expect(crossUser.failure?.code).toBe("approval_stale");
    const tampered = await service.install({ ...{
      actorId: "user-1", prepared: accepted, approvalId: accepted.binding.approvalId,
      toolCallId: accepted.binding.toolCallId, digest: "tampered",
    } });
    expect(tampered.failure?.code).toBe("approval_stale");
    expect(db.rows).toHaveLength(0);
  });

  test("same-host duplicate rows abort install before mutation, relay configure, or audit", async () => {
    const audits: SecurityAuditEvent[] = [];
    const service = createLocalMcpInstallService(db as unknown as DirectDatabase, (event) => audits.push(event));
    const { accepted } = await prepare(service);
    const duplicateBase: McpServer = {
      id: "duplicate-install-1", name: "github-mcp", host: "relay-relay-1",
      transportKind: "stdio", transport: {}, envPassthrough: null, envLiteral: null,
      authRef: null, namespaceId: null, includeTools: null, excludeTools: null,
      enabled: false, trustTier: null, spawnSandboxProfile: null,
      lastCheckStatus: null, lastCheckFailureCode: null, lastCheckMissingEnvironment: null,
      lastCheckedAt: null, lastConnectedAt: null,
      createdAt: new Date(), updatedAt: new Date(),
    };
    db.rows.push(duplicateBase, { ...duplicateBase, id: "duplicate-install-2" });
    const before = JSON.stringify(db.rows);
    const preflightsBefore = relay.preflightExpectedSessions.length;
    const result = await install(service, accepted);
    expect(result.failure?.code).toBe("internal");
    expect(JSON.stringify(db.rows)).toBe(before);
    expect(relay.preflightExpectedSessions).toHaveLength(preflightsBefore);
    expect(relay.configureCalls).toEqual([]);
    expect(audits).toEqual([]);
  });

  test("replays a checkpoint-carried receipt after service restart without a prepared map", async () => {
    const { accepted } = await prepare();
    const restarted = createLocalMcpInstallService(db as unknown as DirectDatabase);
    const result = await install(restarted, accepted);
    expect(result).toMatchObject({ ok: true, digest: accepted.binding.digest });
  });

  test("singleflights the entire fleet: same digest joins, different names cannot race", async () => {
    let release: (() => void) | undefined;
    relay.configureGate = new Promise<void>((resolve) => { release = resolve; });
    const service = createLocalMcpInstallService(db as unknown as DirectDatabase);
    const { accepted: first } = await prepare(service, { approvalId: "local-mcp-install:thread:lane:first", toolCallId: "first" });
    const { accepted: same } = await prepare(service, { approvalId: "local-mcp-install:thread:lane:same", toolCallId: "same" });
    const { accepted: different } = await prepare(service, {
      approvalId: "local-mcp-install:thread:lane:different", toolCallId: "different",
      localIntent: { ...intent, name: "filesystem-mcp" },
    });
    const firstRun = install(service, first);
    await Promise.resolve();
    const sameRun = install(service, same);
    const blocked = await install(service, different);
    expect(blocked.failure?.code).toBe("install_in_progress");
    release?.();
    const [firstResult, sameResult] = await Promise.all([firstRun, sameRun]);
    expect(firstResult.ok).toBe(true); expect(sameResult.ok).toBe(true);
    expect(relay.configureCalls.filter((call) => call.phase === "start")).toHaveLength(1);
  });

  test("sequential names reconcile a complete fleet without stopping the first MCP", async () => {
    relay.configureStates = ["connected", "connected"];
    const service = createLocalMcpInstallService(db as unknown as DirectDatabase);
    const { accepted: github } = await prepare(service);
    expect((await install(service, github)).ok).toBe(true);
    const { accepted: filesystem } = await prepare(service, {
      approvalId: "local-mcp-install:thread:lane:filesystem", toolCallId: "filesystem",
      localIntent: { ...intent, name: "filesystem-mcp" },
    });
    expect((await install(service, filesystem)).ok).toBe(true);
    expect(relay.configureCalls[1]?.servers.map((server) => server.name).sort()).toEqual(["filesystem-mcp", "github-mcp"]);
    expect(db.row("github-mcp", "relay-relay-1")?.enabled).toBe(true);
    expect(db.row("filesystem-mcp", "relay-relay-1")?.enabled).toBe(true);
  });

  test("serializes an installer and a legacy relay mutation so neither reconcile drops the other", async () => {
    db.rows.push({
      id: randomUUID(), name: "legacy-mcp", host: "relay-relay-1", transportKind: "stdio", transport: {},
      envPassthrough: null, envLiteral: null, authRef: null, namespaceId: null, includeTools: null,
      excludeTools: null, enabled: true, trustTier: null, spawnSandboxProfile: null, createdAt: new Date(), updatedAt: new Date(),
      lastCheckStatus: null, lastCheckFailureCode: null, lastCheckMissingEnvironment: null, lastCheckedAt: null, lastConnectedAt: null,
    });
    let release: (() => void) | undefined;
    relay.configureGate = new Promise<void>((resolve) => { release = resolve; });
    const { service, accepted } = await prepare();
    const installRun = install(service, accepted);
    try {
      await waitFor(() => relay.configureCalls.length === 1);
      expect(relay.configureCalls[0]?.servers.map((server) => server.name).sort()).toEqual(["github-mcp", "legacy-mcp"]);

      const disableRun = setLocalMcpEnabled(db as unknown as DirectDatabase, {
        userId: "user-1", name: "legacy-mcp", enabled: false,
      });
      await Promise.resolve();
      // The legacy mutation cannot update/reconcile the fleet while the install
      // owns the shared relay lock.
      expect(db.row("legacy-mcp", "relay-relay-1")?.enabled).toBe(true);

      release?.();
      const [installed, disabled] = await Promise.all([installRun, disableRun]);
      expect(installed.ok).toBe(true);
      expect(disabled).toMatchObject({ ok: true, row: { enabled: false } });
      // The later v12 truth reconcile retains the successfully installed MCP.
      expect(relay.configureCalls[1]?.phase).toBe("rollback");
      expect(relay.configureCalls[1]?.servers.map((server) => server.name)).toEqual(["github-mcp"]);
      expect(db.row("github-mcp", "relay-relay-1")?.enabled).toBe(true);
    } finally {
      release?.();
      await installRun.catch(() => undefined);
    }
  });

  test("a replacement session is never sent rollback and its socket is never closed", async () => {
    relay.configureStates = ["failed"];
    relay.onConfigure = (phase) => { if (phase === "start") relay.desktopSessionId = "replacement"; };
    const closes: Array<{ ids: readonly string[]; expected: string }> = [];
    setLocalMcpInstallRelaySocketSafetyCloser({ forceCloseRelays: (ids, expected) => {
      closes.push({ ids, expected });
      return relay.desktopSessionId === expected ? 1 : 0;
    } });
    const { service, accepted } = await prepare();
    const result = await install(service, accepted);
    expect(result.failure?.code).toBe("rollback_unconfirmed");
    expect(relay.configureCalls.map((call) => call.phase)).toEqual(["start"]);
    expect(relay.configureCalls[0]?.expectedDesktopSessionId).toBe("desktop-session-1");
    expect(closes).toEqual([{ ids: ["relay-1"], expected: "desktop-session-1" }]);
  });

  test("a reconnect after rollback failure cannot make the safety close target the replacement", async () => {
    relay.configureStates = ["failed", "failed"];
    relay.onConfigure = (phase) => { if (phase === "rollback") relay.desktopSessionId = "replacement"; };
    let closed = 0;
    setLocalMcpInstallRelaySocketSafetyCloser({ forceCloseRelays: (_ids, expected) => {
      if (relay.desktopSessionId === expected) closed++;
      return closed;
    } });
    const { service, accepted } = await prepare();
    const result = await install(service, accepted);
    expect(result.failure?.code).toBe("rollback_unconfirmed");
    expect(closed).toBe(0);
    expect(relay.configureCalls.map((call) => call.expectedDesktopSessionId)).toEqual([
      "desktop-session-1",
      "desktop-session-1",
    ]);
  });

  test("fixed preflight failures and audits never retain credential values", async () => {
    relay.preflightStatus = "blocked";
    relay.preflightFailure = { code: "missing_environment" };
    const audits: SecurityAuditEvent[] = [];
    const service = createLocalMcpInstallService(db as unknown as DirectDatabase, (event) => audits.push(event));
    const result = await service.prepare({
      actorId: "user-1", intent, approvalId: "local-mcp-install:thread:lane:call",
      threadId: "thread", laneKey: "lane", toolCallId: "call", checkpointKey: "checkpoint",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.result.failure?.code).toBe("missing_environment");
    expect(JSON.stringify({ result, audits })).not.toContain("GITHUB_TOKEN=");

    relay.preflightFailure = { code: "missing_launcher" };
    const missingLauncher = await service.prepare({
      actorId: "user-1", intent, approvalId: "local-mcp-install:thread:lane:launcher",
      threadId: "thread", laneKey: "lane", toolCallId: "launcher", checkpointKey: "checkpoint",
    });
    expect(missingLauncher.ok).toBe(false);
    if (!missingLauncher.ok) expect(missingLauncher.result.failure?.code).toBe("missing_launcher");
  });

  test("does not echo rejected proposal text into results or audit snapshots", async () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwx";
    const audits: SecurityAuditEvent[] = [];
    const service = createLocalMcpInstallService(db as unknown as DirectDatabase, (event) => audits.push(event));
    const result = await service.prepare({
      actorId: "user-1", intent: { ...intent, name: secret },
      approvalId: "local-mcp-install:thread:lane:call", threadId: "thread", laneKey: "lane",
      toolCallId: "call", checkpointKey: "checkpoint",
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify({ result, audits })).not.toContain(secret);
    expect(JSON.stringify({ result, audits })).toContain("local-mcp");
  });

  test("audits only mutation outcomes with the safe effect digest and relay id", async () => {
    const audits: SecurityAuditEvent[] = [];
    const service = createLocalMcpInstallService(db as unknown as DirectDatabase, (event) => audits.push(event));
    const { accepted } = await prepare(service);
    // Rendering/preparing a review is not itself a configuration mutation.
    expect(audits).toEqual([]);

    const result = await install(service, accepted);
    expect(result.ok).toBe(true);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      kind: "mcp_server_config",
      action: "enable",
      outcome: "ok",
      effectDigest: accepted.binding.digest,
      relayId: "relay-1",
    });
    const snapshot = JSON.stringify(audits);
    expect(snapshot).not.toContain("@modelcontextprotocol/server-github");
    expect(snapshot).not.toContain("desktop-session-1");
    expect(snapshot).not.toContain("https://github.com");
  });

  test("audits failed install and confirmed rollback with only the binding digest and relay", async () => {
    relay.configureStates = ["failed", "stopped"];
    const audits: SecurityAuditEvent[] = [];
    const service = createLocalMcpInstallService(db as unknown as DirectDatabase, (event) => audits.push(event));
    const { accepted } = await prepare(service);
    const result = await install(service, accepted);
    expect(result.failure?.code).toBe("spawn_failed");
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      action: "disable", outcome: "ok", effectDigest: accepted.binding.digest, relayId: "relay-1",
    });
    expect(audits[1]).toMatchObject({
      action: "enable", outcome: "error", effectDigest: accepted.binding.digest, relayId: "relay-1",
    });
    expect(JSON.stringify(audits)).not.toContain("desktop-session-1");
    expect(JSON.stringify(audits)).not.toContain("@modelcontextprotocol/server-github");
  });

  test("commit failure after a successful start performs a newly locked durable stop before audit", async () => {
    db.failCommitNumbers.add(1);
    relay.configureStates = ["connected", "stopped"];
    const audits: SecurityAuditEvent[] = [];
    const service = createLocalMcpInstallService(db as unknown as DirectDatabase, (event) => audits.push(event));
    const { accepted } = await prepare(service);
    const result = await install(service, accepted);
    expect(result.failure?.code).toBe("internal");
    expect(db.transactionCount).toBe(2);
    expect(relay.configureCalls.map((call) => call.phase)).toEqual(["start", "rollback"]);
    expect(db.row("github-mcp", "relay-relay-1")).toBeUndefined();
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ action: "disable", outcome: "ok" });
    expect(audits[1]).toMatchObject({ action: "enable", outcome: "error" });
  });

  test("commit compensation restoring an enabled row audits only the failed enable attempt", async () => {
    db.rows.push({
      id: "existing-enabled", name: "github-mcp", host: "relay-relay-1",
      transportKind: "stdio", transport: { command: "npx", args: ["old@1.0.0"] },
      envPassthrough: null, envLiteral: null, authRef: null, namespaceId: null,
      includeTools: null, excludeTools: null, enabled: true, trustTier: null,
      spawnSandboxProfile: null, createdAt: new Date(), updatedAt: new Date(),
      lastCheckStatus: null, lastCheckFailureCode: null, lastCheckMissingEnvironment: null,
      lastCheckedAt: null, lastConnectedAt: null,
    });
    db.failCommitNumbers.add(1);
    relay.configureStates = ["connected", "connected"];
    const audits: SecurityAuditEvent[] = [];
    const service = createLocalMcpInstallService(db as unknown as DirectDatabase, (event) => audits.push(event));
    const { accepted } = await prepare(service);
    const result = await install(service, accepted);
    expect(result.failure?.code).toBe("internal");
    expect(db.row("github-mcp", "relay-relay-1")?.enabled).toBe(true);
    expect(relay.configureCalls.map((call) => call.phase)).toEqual(["start", "start"]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "enable", outcome: "error" });
  });

  test("commit failure after rollback re-reconciles durable truth before reporting the fixed failure", async () => {
    db.failCommitNumbers.add(1);
    relay.configureStates = ["failed", "stopped", "stopped"];
    const audits: SecurityAuditEvent[] = [];
    const service = createLocalMcpInstallService(db as unknown as DirectDatabase, (event) => audits.push(event));
    const { accepted } = await prepare(service);
    const result = await install(service, accepted);
    expect(result.failure?.code).toBe("spawn_failed");
    expect(db.transactionCount).toBe(2);
    expect(relay.configureCalls.map((call) => call.phase)).toEqual(["start", "rollback", "rollback"]);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ action: "disable", outcome: "ok" });
    expect(audits[1]).toMatchObject({ action: "enable", outcome: "error" });
  });

  test("keeps verified relay failure codes and never treats a fleet read failure as empty", async () => {
    relay.configureStates = ["failed", "stopped"];
    const { service: spawnService, accepted: spawnAccepted } = await prepare();
    expect((await install(spawnService, spawnAccepted)).failure?.code).toBe("spawn_failed");

    db = new FakeDb();
    relay = new FakeRelay();
    relay.configureStates = ["stopped"];
    relay.configureErrors = [Object.assign(new Error("configure timeout"), { code: "mcp_configure_timeout" })];
    setRelayRegistry(relay as never);
    const timeoutService = createLocalMcpInstallService(db as unknown as DirectDatabase);
    const { accepted: timeoutAccepted } = await prepare(timeoutService);
    expect((await install(timeoutService, timeoutAccepted)).failure?.code).toBe("discovery_timeout");

    db = new FakeDb();
    relay = new FakeRelay();
    setRelayRegistry(relay as never);
    relay.configureStates = ["failed", "stopped"];
    relay.configureFailure = "protocol_failed";
    const { service, accepted } = await prepare();
    const protocolFailure = await install(service, accepted);
    expect(protocolFailure.failure?.code).toBe("protocol_failed");
    expect(db.row("github-mcp", "relay-relay-1")?.enabled).toBe(false);
    expect(db.row("github-mcp", "relay-relay-1")).toMatchObject({
      lastCheckStatus: "failed",
      lastCheckFailureCode: "protocol_failed",
    });

    db = new FakeDb();
    relay = new FakeRelay();
    relay.configureStates = ["stopped", "stopped"];
    setRelayRegistry(relay as never);
    const emptyService = createLocalMcpInstallService(db as unknown as DirectDatabase);
    const { accepted: emptyAccepted } = await prepare(emptyService);
    expect((await install(emptyService, emptyAccepted)).failure?.code).toBe("empty_toolset");

    db = new FakeDb();
    db.throwOnEnabledFleetRead = true;
    relay = new FakeRelay();
    setRelayRegistry(relay as never);
    const strictService = createLocalMcpInstallService(db as unknown as DirectDatabase);
    const { accepted: strictAccepted } = await prepare(strictService);
    expect((await install(strictService, strictAccepted)).failure?.code).toBe("internal");
    expect(relay.configureCalls).toHaveLength(0);
  });
});
