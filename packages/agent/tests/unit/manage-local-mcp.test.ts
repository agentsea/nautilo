/**
 * D384 §5.4 — unit tests for the `manage_local_mcp` tool dispatcher.
 *
 * Uses a fake {@link LocalMcpToolRuntime} injected via
 * `setLocalMcpToolRuntime` (DI) — no DB, no server. Locks:
 *   - verb routing (list / status / register / enable / disable)
 *   - server-tier refusal surfaced from the runtime
 *   - register with no connected relay → error
 *   - register delegates to the runtime with the acting owner + inputs
 *   - list / status read paths
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  dispatchManageLocalMcpCommand,
  manageLocalMcpToolSchema,
  resolveLocalMcpActorUserId,
  type ManageLocalMcpToolArgs,
} from "../../src/tools/mcp/manage-local-mcp";
import {
  setLocalMcpToolRuntime,
  resetLocalMcpToolRuntimeForTests,
  type LocalMcpActionResult,
  type LocalMcpRegisterInput,
  type LocalMcpToolActorContext,
  type LocalMcpToolRuntime,
} from "../../src/tools/mcp/local-mcp-runtime";
import type { LocalMcpInstallPrepared, LocalMcpInstallResult } from "@nautilo/types";
import { sanitizeToolCallArgsForEvent } from "../../src/tools/invocation-service";
import type { NautiloState } from "../../src/agent/state";

interface Call {
  method: string;
  ctx: LocalMcpToolActorContext;
  input?: unknown;
}

class FakeRuntime implements LocalMcpToolRuntime {
  readonly calls: Call[] = [];
  connectedRelays: string[] = ["relay-A"];
  setEnabledResult: LocalMcpActionResult = { ok: true, server: { name: "x", host: "relay-relay-A", enabled: true, transportKind: "stdio" } };
  removeResult: LocalMcpActionResult = { ok: true, server: { name: "x", host: "relay-relay-A", enabled: false, transportKind: "stdio", health: "removed", toolCount: 0 } };
  listResult: LocalMcpActionResult = { ok: true, servers: [] };
  statusResult: LocalMcpActionResult = { ok: true, server: { name: "x", host: "relay-relay-A", enabled: true, transportKind: "stdio", health: "connected", toolCount: 3 } };

  listConnectedRelays(ctx: LocalMcpToolActorContext): Promise<readonly string[]> {
    this.calls.push({ method: "listConnectedRelays", ctx });
    return Promise.resolve(this.connectedRelays);
  }
  register(ctx: LocalMcpToolActorContext, input: LocalMcpRegisterInput): Promise<LocalMcpActionResult> {
    this.calls.push({ method: "register", ctx, input });
    return Promise.resolve({ ok: false, error: "legacy register is not exposed to Genie" });
  }
  setEnabled(ctx: LocalMcpToolActorContext, input: { name: string; enabled: boolean }): Promise<LocalMcpActionResult> {
    this.calls.push({ method: "setEnabled", ctx, input });
    return Promise.resolve(this.setEnabledResult);
  }
  remove(ctx: LocalMcpToolActorContext, input: { name: string; relayId?: string }): Promise<LocalMcpActionResult> {
    this.calls.push({ method: "remove", ctx, input });
    return Promise.resolve(this.removeResult);
  }
  list(ctx: LocalMcpToolActorContext): Promise<LocalMcpActionResult> {
    this.calls.push({ method: "list", ctx });
    return Promise.resolve(this.listResult);
  }
  status(ctx: LocalMcpToolActorContext, input: { name: string }): Promise<LocalMcpActionResult> {
    this.calls.push({ method: "status", ctx, input });
    return Promise.resolve(this.statusResult);
  }
  prepareInstall(): Promise<{ ok: true; prepared: LocalMcpInstallPrepared }> {
    throw new Error("install preparation belongs to post-model, not the dispatcher");
  }
  install(): Promise<LocalMcpInstallResult> {
    throw new Error("install execution belongs to invocation-service, not the dispatcher");
  }
  validateInstallApproval(): boolean { return false; }
  isInstallApproval(): boolean { return false; }
}

let fake: FakeRuntime;
const OWNER = "user-owner";

interface ParsedResult {
  ok: boolean;
  error?: string;
  servers?: Array<Record<string, unknown>>;
  server?: Record<string, unknown>;
}

async function run(args: ManageLocalMcpToolArgs, ctx = { ownerId: OWNER }): Promise<ParsedResult> {
  return JSON.parse(await dispatchManageLocalMcpCommand(args, ctx)) as ParsedResult;
}

beforeEach(() => {
  fake = new FakeRuntime();
  setLocalMcpToolRuntime(fake);
});

afterEach(() => {
  resetLocalMcpToolRuntimeForTests();
});

describe("actor resolution", () => {
  test("prefers ownerId, falls back to userId then envelope.ownerId", () => {
    expect(resolveLocalMcpActorUserId({ ownerId: "o", userId: "u" })).toBe("o");
    expect(resolveLocalMcpActorUserId({ userId: "u" })).toBe("u");
    expect(
      resolveLocalMcpActorUserId({ memoryAccessEnvelope: { ownerId: "e" } as never }),
    ).toBe("e");
    expect(resolveLocalMcpActorUserId(undefined)).toBe("");
  });

  test("no acting user → error, runtime never touched", async () => {
    const out = await run({ action: "list" }, {} as never);
    expect(out.ok).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("verb routing", () => {
  test("list → runtime.list with the owner ctx", async () => {
    fake.listResult = { ok: true, servers: [{ name: "gh", host: "relay-relay-A", enabled: false, transportKind: "stdio" }] };
    const out = (await run({ action: "list" }));
    expect(out.ok).toBe(true);
    expect(out.servers).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ method: "list", ctx: { userId: OWNER } });
  });

  test("status requires a name", async () => {
    const out = (await run({ action: "status" }));
    expect(out.ok).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  test("status → runtime.status read path (health + toolCount)", async () => {
    const out = (await run({ action: "status", name: "gh" }));
    expect(out.ok).toBe(true);
    expect(out.server?.["health"]).toBe("connected");
    expect(out.server?.["toolCount"]).toBe(3);
    expect(fake.calls[0]).toMatchObject({ method: "status", input: { name: "gh" } });
  });

  test("disable → setEnabled({enabled:false})", async () => {
    await run({ action: "disable", name: "gh" });
    expect(fake.calls[0]).toMatchObject({ method: "setEnabled", input: { name: "gh", enabled: false } });
  });

  test("disable requires a name", async () => {
    expect((await run({ action: "disable" })).ok).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  test("remove → runtime.remove with exact name and relay", async () => {
    const out = await run({ action: "remove", name: "gh", relayId: "relay-A" });
    expect(out.ok).toBe(true);
    expect(fake.calls[0]).toMatchObject({
      method: "remove",
      ctx: { userId: OWNER },
      input: { name: "gh", relayId: "relay-A" },
    });
  });

  test("remove requires a name", async () => {
    expect((await run({ action: "remove" })).ok).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("install and server-tier refusal", () => {
  test("model schema refuses a source label rather than silently carrying it into provenance", () => {
    const parsed = manageLocalMcpToolSchema.safeParse({
      action: "install",
      request: {
        version: "local-mcp-install-v1",
        name: "gh",
        transport: { kind: "streamable-http", url: "https://mcp.example.test" },
        source: { url: "https://docs.example.test/path?token=secret", label: "model secret" },
      },
    });
    expect(parsed.success).toBe(false);
  });

  test("install is never directly executable from model-facing dispatcher", async () => {
    const out = await run({
      action: "install",
      request: {
        version: "local-mcp-install-v1",
        name: "gh",
        transport: { kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
      },
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("prepared and explicitly approved");
    expect(fake.calls).toHaveLength(0);
  });

  test("disable on a server-wide MCP → refused", async () => {
    fake.setEnabledResult = {
      ok: false,
      error: '"official" is a server-wide MCP; this tool only manages your local MCPs.',
    };
    const out = (await run({ action: "disable", name: "official" }));
    expect(out.ok).toBe(false);
    expect(out.error).toContain("server-wide MCP");
  });

  test("remove on a server-wide MCP → refused", async () => {
    fake.removeResult = {
      ok: false,
      error: '"official" is a server-wide MCP; this tool only manages your local MCPs.',
    };
    const out = await run({ action: "remove", name: "official" });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("server-wide MCP");
  });
});

describe("runtime not injected", () => {
  test("clear error when runtime is missing", async () => {
    resetLocalMcpToolRuntimeForTests();
    const out = (await run({ action: "list" }));
    expect(out.ok).toBe(false);
    expect(out.error).toContain("runtime not set");
  });
});

test("install telemetry exposes only the action, never prepared launch authority", () => {
  const eventArgs = sanitizeToolCallArgsForEvent({
    name: "manage_local_mcp",
    args: {
      action: "install",
      prepared: { binding: { actorId: "user", deviceSessionId: "session" } },
      request: { transport: { command: "npx", args: ["package@1.2.3"] }, source: { url: "https://docs.test/private" } },
    },
  }, {} as NautiloState);
  expect(eventArgs).toEqual({ action: "install" });
  expect(JSON.stringify(eventArgs)).not.toContain("npx");
  expect(JSON.stringify(eventArgs)).not.toContain("session");
});
