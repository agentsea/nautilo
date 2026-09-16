import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  NodeCodexAppServerClientFactory,
  assertHostProjectionBound,
  type CodexAppServerCallbacks,
  type ChildIdentity,
  type ChildStdio,
  type ManagedChildProcess,
  type OpaqueHandle,
} from "../../src/internal";

describe("NodeCodexAppServerClientFactory", () => {
  test("enforces host projection N/N+1 bounds and canonical usage fields", async () => {
    expect((await requestLogin({ type: "chatgpt", loginId: "x".repeat(1024), authUrl: authUrl(4096) })).upstreamLoginId).toHaveLength(1024);
    await rejectsAny(requestLogin({ type: "chatgpt", loginId: "x".repeat(1025), authUrl: "https://chatgpt.com/auth" }));
    expect((await requestLogin({ type: "chatgpt", loginId: "login", authUrl: authUrl(4096) })).authUrl).toHaveLength(4096);
    await rejectsAny(requestLogin({ type: "chatgpt", loginId: "login", authUrl: authUrl(4097) }));

    const maxDigits = "9".repeat(32);
    const maxBuckets = Array.from({ length: 366 }, (_, index) => ({ startDate: `2025-${String(Math.floor(index / 28) % 12 + 1).padStart(2, "0")}-${String(index % 28 + 1).padStart(2, "0")}`, tokens: maxDigits }));
    const usage = await requestUsage({ summary: { lifetimeTokens: maxDigits, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null }, dailyUsageBuckets: maxBuckets });
    expect(usage.lifetimeTokens).toBe(maxDigits); expect(usage.dailyUsage).toHaveLength(366);
    await rejectsAny(requestUsage({ summary: { lifetimeTokens: "9".repeat(33), peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null }, dailyUsageBuckets: [] }));
    await rejectsAny(requestUsage({ summary: emptyUsageSummary(), dailyUsageBuckets: Array.from({ length: 367 }, () => ({ startDate: "2026-01-01", tokens: 1 })) }));
    await rejectsAny(requestUsage({ summary: emptyUsageSummary(), dailyUsageBuckets: [{ startDate: "2026-02-30", tokens: 1 }] }));

    expect(() => assertHostProjectionBound("x".repeat(65_534))).not.toThrow();
    expect(() => assertHostProjectionBound("x".repeat(65_535))).toThrow();
  });
  test("drops stale callbacks, contains callback rejection, and reports the exact transport fault", async () => {
    const child = new RpcChild(); let current = false; let delivered = 0; let callbackFaults = 0; let transportFaults = 0;
    const client = await new NodeCodexAppServerClientFactory({ callbacks: {
      isCurrent: () => current,
      onTransportFault: ({ child: faulted }) => { expect(faulted).toEqual(identity()); transportFaults += 1; },
      onCallbackFault: () => { callbackFaults += 1; },
      onNotification: () => { delivered += 1; throw new Error("receiver failed"); },
    } }).connect(child, identity());
    const initializing = client.initialize(); const init = await child.nextFrame(); expect(init).toMatchObject({ method: "initialize", params: { capabilities: { experimentalApi: false } } }); child.respond(init, { userAgent: "Codex", codexHome: "/private", platformFamily: "unix", platformOs: "macos" }); await initializing; await child.nextFrame();
    child.server({ method: "item/agentMessage/delta", params: { threadId: "thread", turnId: "turn", itemId: "item", delta: "stale" } });
    await Bun.sleep(2); expect(delivered).toBe(0);
    current = true; child.server({ method: "item/agentMessage/delta", params: { threadId: "thread", turnId: "turn", itemId: "item", delta: "live" } });
    await eventually(() => callbackFaults === 1); expect(delivered).toBe(1);
    child.stdout.end(); await eventually(() => transportFaults === 1);
  });
  test("preserves upstream notification order across asynchronous host projection", async () => {
    const child = new RpcChild();
    const delivered: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const client = await new NodeCodexAppServerClientFactory({
      callbacks: {
        isCurrent: () => true,
        onTransportFault: () => undefined,
        onCallbackFault: () => undefined,
        onNotification: async ({ notification }) => {
          const delta =
            notification.method === "item/agentMessage/delta"
              ? notification.params.delta
              : notification.method;
          if (delta === "first") await firstBlocked;
          delivered.push(delta);
        },
      },
    }).connect(child, identity());
    const initializing = client.initialize();
    const init = await child.nextFrame();
    child.respond(init, {
      userAgent: "Codex",
      codexHome: "/private",
      platformFamily: "unix",
      platformOs: "macos",
    });
    await initializing;
    await child.nextFrame();

    child.server({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread",
        turnId: "turn",
        itemId: "item",
        delta: "first",
      },
    });
    child.server({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread",
        turnId: "turn",
        itemId: "item",
        delta: "second",
      },
    });
    await Bun.sleep(2);
    expect(delivered).toEqual([]);
    releaseFirst?.();
    await eventually(() => delivered.length === 2);
    expect(delivered).toEqual(["first", "second"]);
  });
  test("maps each native posture, omits dynamic tools, and rejects unsupported tool calls", async () => {
    const child = new RpcChild();
    const events: string[] = [];
    let nativeRequestCount = 0;
    const callbackHandler = (async () => {
      nativeRequestCount += 1;
      return { contentItems: [{ type: "inputText", text: "done" }], success: true };
    }) as unknown as NonNullable<CodexAppServerCallbacks["onServerRequest"]>;
    const factory = new NodeCodexAppServerClientFactory({
      experimentalApi: true,
      callbacks: {
        isCurrent: (candidate) => candidate.childGeneration === 3,
        onTransportFault: () => undefined,
        onCallbackFault: () => undefined,
        onNotification: ({ notification }) => { events.push(notification.method); },
        onServerRequest: callbackHandler,
      },
    });
    const client = await factory.connect(child, identity());

    const initialized = client.initialize();
    const init = await child.nextFrame();
    expect(init).toMatchObject({ method: "initialize", params: { capabilities: { experimentalApi: true } } });
    child.respond(init, { userAgent: "Codex", codexHome: "/private", platformFamily: "unix", platformOs: "macos" });
    await initialized;
    expect((await child.nextFrame())["method"]).toBe("initialized");

    const login = client.startChatgptLogin();
    const loginFrame = await child.nextFrame();
    expect(loginFrame).toMatchObject({ method: "account/login/start", params: { type: "chatgpt" } });
    expect((loginFrame["params"] as Record<string, unknown>)["apiKey"]).toBeUndefined();
    child.respond(loginFrame, { type: "chatgpt", loginId: "upstream-login", authUrl: "https://chatgpt.com/auth" });
    expect(await login).toEqual({ upstreamLoginId: "upstream-login", authUrl: "https://chatgpt.com/auth" });

    const canceled = client.cancelLogin("upstream-login");
    const cancelFrame = await child.nextFrame();
    expect(cancelFrame).toMatchObject({ method: "account/login/cancel", params: { loginId: "upstream-login" } });
    child.respond(cancelFrame, { status: "canceled" });
    expect(await canceled).toEqual({ cancelled: true });

    const account = client.readAccount();
    const accountFrame = await child.nextFrame();
    expect(accountFrame).toMatchObject({ method: "account/read", params: { refreshToken: false } });
    child.respond(accountFrame, { account: { type: "chatgpt", email: "private@example.test", planType: "pro" }, requiresOpenaiAuth: true });
    expect(await account).toEqual({ state: "signed_in", requiresOpenaiAuth: true, email: "private@example.test", planType: "pro" });

    const usage = client.readUsage();
    const usageFrame = await child.nextFrame();
    expect(usageFrame).toMatchObject({ method: "account/usage/read" });
    child.respond(usageFrame, { summary: { lifetimeTokens: "42", peakDailyTokens: null, longestRunningTurnSec: 1, currentStreakDays: null, longestStreakDays: 2 }, dailyUsageBuckets: [{ startDate: "2026-07-27", tokens: 3 }] });
    expect(await usage).toEqual({ lifetimeTokens: "42", longestRunningTurnSec: "1", longestStreakDays: "2", dailyUsage: [{ startDate: "2026-07-27", tokens: "3" }] });

    const models = client.listModels();
    const modelsFrame = await child.nextFrame();
    expect(modelsFrame).toMatchObject({
      method: "model/list",
      params: { cursor: null, limit: 100, includeHidden: false },
    });
    child.respond(modelsFrame, {
      data: [{
        id: "gpt-5.6-sol",
        model: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        description: "Frontier coding model",
        hidden: false,
        isDefault: true,
      }],
      nextCursor: null,
    });
    expect(await models).toEqual({ models: [{
      id: "gpt-5.6-sol",
      model: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      description: "Frontier coding model",
      isDefault: true,
    }] });

    const logout = client.logout();
    const logoutFrame = await child.nextFrame();
    expect(logoutFrame).toMatchObject({ method: "account/logout" });
    child.respond(logoutFrame, {});
    await logout;

    const started = client.startThread({
      cwd: "/workspace",
      model: "gpt-5.6-codex",
      posture: { kind: "prompted_workspace" },
    });
    const start = await child.nextFrame();
    expect(start).toMatchObject({ method: "thread/start", params: { cwd: "/workspace", model: "gpt-5.6-codex", sandbox: "workspace-write", approvalPolicy: "on-request" } });
    expect((start["params"] as Record<string, unknown>)["dynamicTools"]).toBeUndefined();
    child.respond(start, threadResponse("thread-a", "/workspace"));
    expect(await started).toEqual({ threadId: "thread-a", cwd: "/workspace" });

    const headless = client.startThread({ cwd: "/workspace", posture: { kind: "full_access_headless" } });
    const headlessFrame = await child.nextFrame();
    expect(headlessFrame).toMatchObject({ method: "thread/start", params: { sandbox: "danger-full-access", approvalPolicy: "never" } });
    expect((headlessFrame["params"] as Record<string, unknown>)["dynamicTools"]).toBeUndefined();
    child.respond(headlessFrame, threadResponse("thread-b", "/workspace"));
    await headless;

    const defaultPosture = client.startThread({ cwd: "/workspace", posture: { kind: "codex_default" } });
    const defaultFrame = await child.nextFrame();
    expect(defaultFrame).toMatchObject({ method: "thread/start", params: { cwd: "/workspace" } });
    expect((defaultFrame["params"] as Record<string, unknown>)["sandbox"]).toBeUndefined();
    expect((defaultFrame["params"] as Record<string, unknown>)["approvalPolicy"]).toBeUndefined();
    expect((defaultFrame["params"] as Record<string, unknown>)["dynamicTools"]).toBeUndefined();
    child.respond(defaultFrame, threadResponse("thread-c", "/workspace"));
    await defaultPosture;

    const planned = client.startTurn({
      threadId: "thread-c",
      text: "ask one focused question",
      clientUserMessageId: "message-c",
      collaborationMode: "plan",
    });
    const modes = await child.nextFrame();
    expect(modes).toEqual({ id: modes["id"], method: "collaborationMode/list", params: {} });
    child.respond(modes, {
      data: [
        { name: "Plan", mode: "plan", model: null, reasoning_effort: "medium" },
        { name: "Default", mode: "default", model: null, reasoning_effort: null },
      ],
    });
    const turn = await child.nextFrame();
    expect(turn).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "thread-c",
        collaborationMode: {
          mode: "plan",
          settings: {
            model: "gpt-5.6-codex",
            reasoning_effort: "medium",
            developer_instructions: null,
          },
        },
      },
    });
    child.respond(turn, { turn: { id: "turn-c", items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null } });
    expect(await planned).toEqual({ turnId: "turn-c" });

    const worked = client.startTurn({
      threadId: "thread-c",
      text: "continue normally",
      clientUserMessageId: "message-d",
      collaborationMode: "work",
    });
    const workModes = await child.nextFrame();
    expect(workModes).toEqual({ id: workModes["id"], method: "collaborationMode/list", params: {} });
    child.respond(workModes, {
      data: [{ name: "Default", mode: "default", model: null, reasoning_effort: null }],
    });
    const workTurn = await child.nextFrame();
    expect(workTurn).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "thread-c",
        collaborationMode: {
          mode: "default",
          settings: {
            model: "gpt-5.6-codex",
            reasoning_effort: null,
            developer_instructions: null,
          },
        },
      },
    });
    child.respond(workTurn, { turn: { id: "turn-d", items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null } });
    expect(await worked).toEqual({ turnId: "turn-d" });

    const steered = client.steerThread({
      threadId: "thread-c",
      turnId: "turn-d",
      text: "Focus on the failing test",
      clientUserMessageId: "steer-message",
    });
    const steer = await child.nextFrame();
    expect(steer).toMatchObject({
      method: "turn/steer",
      params: {
        threadId: "thread-c",
        expectedTurnId: "turn-d",
        clientUserMessageId: "steer-message",
        input: [{ type: "text", text: "Focus on the failing test", text_elements: [] }],
      },
    });
    child.respond(steer, { turnId: "turn-d" });
    await steered;

    child.server({ method: "item/agentMessage/delta", params: { threadId: "thread-a", turnId: "turn-a", itemId: "item-a", delta: "hello" } });
    child.server({ id: "request-1", method: "item/tool/call", params: { threadId: "thread-a", turnId: "turn-a", callId: "call-a", namespace: "nautilo", tool: "inspect", arguments: {} } });
    await eventually(() => events.includes("item/agentMessage/delta") && child.frames.some((frame) => frame["id"] === "request-1"));
    expect(child.frames.find((frame) => frame["id"] === "request-1")).toMatchObject({
      error: { code: -32601, message: "Method not available" },
    });
    expect(nativeRequestCount).toBe(0);
    await client.close();
  });
});

class RpcChild implements ManagedChildProcess {
  readonly pid = 991;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly frames: Array<Record<string, unknown>> = [];
  private readCursor = 0;
  readonly stdio: ChildStdio = {
    stdin: { write: async (chunk) => { this.frames.push(JSON.parse(Buffer.from(chunk).toString("utf8").trim()) as Record<string, unknown>); }, end: async () => undefined },
    stdout: this.stdout,
    stderr: this.stderr,
  };
  readonly exited = new Promise<{ readonly code: number | null; readonly signal: string | null }>(() => undefined);
  async isProcessGroupGone() { return false; }
  async sendInterrupt() {}
  async signalProcessGroup(_signal: "SIGTERM" | "SIGKILL") {}
  async nextFrame(): Promise<Record<string, unknown>> {
    await eventually(() => this.frames.length > this.readCursor);
    return this.frames[this.readCursor++]!;
  }
  respond(frame: Record<string, unknown>, result: unknown) { this.server({ id: frame["id"], result }); }
  server(frame: Record<string, unknown>) { this.stdout.write(`${JSON.stringify(frame)}\n`); }
}

function identity(): ChildIdentity { return { profile: { actorId: "human", profileHandle: "profile" as OpaqueHandle, profileGeneration: 1 }, accountGeneration: 2, runtimeGeneration: 3, childGeneration: 3 }; }
function threadResponse(id: string, cwd: string) { return { thread: { id, status: { type: "idle" }, turns: [] }, model: "gpt-5.6-codex", cwd }; }
async function eventually(predicate: () => boolean): Promise<void> {
  for (let count = 0; count < 100; count += 1) { if (predicate()) return; await Bun.sleep(1); }
  throw new Error("condition did not become true");
}
async function connectedClient(child: RpcChild) {
  const client = await new NodeCodexAppServerClientFactory({ callbacks: {
    isCurrent: () => true,
    onTransportFault: () => undefined,
    onCallbackFault: () => undefined,
  } }).connect(child, identity());
  const initializing = client.initialize(); const frame = await child.nextFrame();
  child.respond(frame, { userAgent: "Codex", codexHome: "/private", platformFamily: "unix", platformOs: "macos" });
  await initializing; await child.nextFrame();
  return client;
}
async function requestLogin(response: unknown) {
  const child = new RpcChild(); const client = await connectedClient(child);
  try {
    const pending = client.startChatgptLogin(); const frame = await child.nextFrame(); child.respond(frame, response); return await pending;
  } finally { await client.close(); }
}
async function requestUsage(response: unknown) {
  const child = new RpcChild(); const client = await connectedClient(child);
  try {
    const pending = client.readUsage(); const frame = await child.nextFrame(); child.respond(frame, response); return await pending;
  } finally { await client.close(); }
}
function authUrl(bytes: number): string { const prefix = "https://chatgpt.com/"; return `${prefix}${"a".repeat(bytes - prefix.length)}`; }
function emptyUsageSummary() { return { lifetimeTokens: null, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null }; }
async function rejectsAny(work: Promise<unknown>): Promise<void> { try { await work; } catch { return; } throw new Error("Expected rejection"); }
