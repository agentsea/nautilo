import { describe, expect, spyOn, test } from "bun:test";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { ChildIdentity } from "@nautilo/codex-app-server-host/internal";
import type {
  BindingScope,
  RelayCodexClientMessage,
  RelayCodexSession,
} from "@nautilo/relay";
import {
  AtomicJsonCodexBindingStore,
  ElectronCodexHost,
  createElectronCodexHostServiceFactory,
  type CodexBindingPersistence,
  type ElectronCodexClientCallbackBuilderInput,
  type ElectronCodexHostServiceFactoryOptions,
  type ElectronCodexHostServices,
} from "../../electron/codex-host.ts";
import {
  ElectronCodexController,
  ElectronCodexControllerError,
} from "../../electron/codex-controller.ts";

const {
  createRelayClient,
  isRelayCodexCommandResponseForCommand,
  parseRelayCodexClientMessage,
  parseRelayCodexServerMessage,
} = await import("@nautilo/relay");

const session: RelayCodexSession = {
  relayId: "relay",
  relaySessionId: "relay-session",
  desktopSessionId: "desktop",
  pairingGenerationRef: "pairing",
  selectedProtocolVersion: 8,
  capabilityRevision: 3,
};
const wireWorkspace = {
  workspaceRef: "workspace",
  revision: 7,
  fingerprint: "fingerprint",
  issuedAt: "1970-01-01T00:00:00.001Z",
  expiresAt: "1970-01-01T00:00:01.001Z",
};
const bindingScope: BindingScope = {
  ...session,
  profileHandle: "profile",
  profileGeneration: 1,
  accountGeneration: 2,
  runtimeGeneration: 3,
  childGeneration: 4,
  bindingId: "binding",
  bindingGeneration: 1,
  workspace: wireWorkspace,
  taskId: "task",
  jobId: "job",
  threadId: "thread",
};

describe("ElectronCodexHost", () => {
  test("preserves bounded controller rejection codes at the host boundary", async () => {
    const sent: RelayCodexClientMessage[] = [];
    const services = fakeServices({
      admin: {
        async enable() {},
        async detach() {},
        async close() {},
        async ensureProfileChild() {
          throw new ElectronCodexControllerError("CODEX_PROFILE_UNAVAILABLE");
        },
        async execute() {
          return { kind: "rejected", code: "CODEX_CAPABILITY_UNAVAILABLE" };
        },
      },
    });
    const host = new ElectronCodexHost({
      currentActorId: () => "actor",
      createServices: async () => services,
      status: () => ({ state: "ready", runtimeGeneration: 3 }),
    });
    await host.onRegistered(session, { send: (message) => { sent.push(message); return true; } });
    await host.onCommand({
      type: "relay:codex-command",
      commandId: "ensure",
      scope: { ...session, profileHandle: "profile", profileGeneration: 1, accountGeneration: 2, runtimeGeneration: 3 },
      command: { kind: "ensure_profile_child", posture: { kind: "codex_default", anchorMode: "default" } },
    });
    expect(sent.at(-1)).toMatchObject({
      commandId: "ensure",
      result: { kind: "rejected", code: "CODEX_PROFILE_UNAVAILABLE" },
    });
  });

  test("preserves closed host codes when a bundled error loses constructor identity", async () => {
    const sent: RelayCodexClientMessage[] = [];
    const host = new ElectronCodexHost({
      currentActorId: () => "actor",
      createServices: async () => fakeServices({
        async ensure() {
          throw Object.assign(new Error("private child launch detail"), {
            code: "SUPERVISOR_UNAVAILABLE",
          });
        },
      }),
      status: () => ({ state: "ready", runtimeGeneration: 3 }),
    });
    await host.onRegistered(session, { send: (message) => { sent.push(message); return true; } });
    await host.onCommand({
      type: "relay:codex-command",
      commandId: "ensure",
      scope: { ...session, profileHandle: "profile", profileGeneration: 1, accountGeneration: 2, runtimeGeneration: 3 },
      command: { kind: "ensure_profile_child", posture: { kind: "codex_default", anchorMode: "default" } },
    });
    expect(sent.at(-1)).toMatchObject({
      commandId: "ensure",
      result: { kind: "rejected", code: "CODEX_CHILD_START_FAILED" },
    });
  });

  test("logs only bounded command kind and stable code when command handling fails", async () => {
    const sent: RelayCodexClientMessage[] = [];
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const host = new ElectronCodexHost({
        currentActorId: () => "actor",
        createServices: async () => fakeServices({
          async open() {
            throw new Error("private workspace / secret account detail");
          },
        }),
        status: () => ({ state: "ready", runtimeGeneration: 3 }),
      });
      await host.onRegistered(session, {
        send: (message) => {
          sent.push(message);
          return true;
        },
      });
      await host.onCommand({
        type: "relay:codex-command",
        commandId: "open",
        scope: bindingScope,
        command: {
          kind: "open_binding",
          posture: { kind: "codex_default", anchorMode: "default" },
        },
      });

      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning.mock.calls[0]).toEqual([
        "[desktop][d453] Codex command rejected",
        { kind: "open_binding", stableCode: "CODEX_CONTEXT_INVALID" },
      ]);
      expect(JSON.stringify(warning.mock.calls)).not.toContain("private workspace");
      expect(sent.at(-1)).toMatchObject({
        commandId: "open",
        result: { kind: "rejected", code: "CODEX_CONTEXT_INVALID" },
      });
    } finally {
      warning.mockRestore();
    }
  });

  test("publishes the current controller projection before acknowledging admin results", async () => {
    const sent: RelayCodexClientMessage[] = [];
    let generation = 0;
    let calls = 0;
    const services = fakeServices({
      admin: {
        async enable() {},
        async detach() {},
        async close() {},
        async ensureProfileChild() { return {} as never; },
        async execute() {
          calls += 1;
          if (calls === 1) {
            generation = 7;
            return { kind: "runtime_status" as const, state: "ready" as const, runtimeGeneration: generation };
          }
          return { kind: "rejected" as const, code: "CODEX_RUNTIME_UNAVAILABLE" as const };
        },
      },
    });
    const host = new ElectronCodexHost({
      currentActorId: () => "actor",
      createServices: async () => services,
      status: () => generation
        ? { state: "ready", runtimeGeneration: generation, runtime: { state: "ready" } }
        : { state: "runtime_unavailable", runtime: { state: "absent" } },
    });
    const negotiatedSession = { ...session, selectedProtocolVersion: 9 };
    await host.onRegistered(negotiatedSession, { send: (message) => { sent.push(message); return true; } });
    await host.onCommand({ type: "relay:codex-command", commandId: "inspect", scope: negotiatedSession, command: { kind: "runtime_inspect" } });
    expect(sent.at(-2)).toMatchObject({ type: "relay:codex-status", socket: { selectedProtocolVersion: 9 }, status: { state: "ready", runtimeGeneration: 7, workspace: { state: "bound" } } });
    expect(sent.at(-1)).toMatchObject({ commandId: "inspect", result: { kind: "runtime_status", state: "ready", runtimeGeneration: 7 } });
    await host.onCommand({ type: "relay:codex-command", commandId: "rejected", scope: negotiatedSession, command: { kind: "runtime_inspect" } });
    expect(sent.at(-2)).toMatchObject({ type: "relay:codex-status", status: { runtimeGeneration: 7 } });
    expect(sent.at(-1)).toMatchObject({ commandId: "rejected", result: { kind: "rejected", code: "CODEX_RUNTIME_UNAVAILABLE" } });
  });

  test("delegates admin and account-only child admission to the one controller without a workspace", async () => {
    const sent: RelayCodexClientMessage[] = [];
    const calls: string[] = [];
    const services = fakeServices({
      async mintWorkspace() { throw new Error("Current Folder is unavailable"); },
      async ensure() { throw new Error("host ensure must not be used when controller is present"); },
      admin: {
        async enable() { calls.push("enable"); },
        async detach() { calls.push("detach"); },
        async close() { calls.push("close"); },
        async ensureProfileChild(scope) {
          calls.push(`ensure:${scope.profileHandle}`);
          return {
            profile: { actorId: "actor", profileHandle: scope.profileHandle as never, profileGeneration: scope.profileGeneration },
            accountGeneration: scope.accountGeneration, runtimeGeneration: scope.runtimeGeneration, childGeneration: 9,
          };
        },
        async execute(_scope, command) {
          calls.push(`admin:${command.kind}`);
          return command.kind === "runtime_inspect"
            ? { kind: "runtime_status", state: "absent" }
            : { kind: "rejected", code: "CODEX_CAPABILITY_UNAVAILABLE" };
        },
      },
    });
    const host = new ElectronCodexHost({
      currentActorId: () => "actor",
      createServices: async () => services,
      status: () => ({ state: "ready" }),
    });
    await host.onRegistered(session, { send: (message) => { sent.push(message); return true; } });
    await host.onCommand({ type: "relay:codex-command", commandId: "inspect", scope: session, command: { kind: "runtime_inspect" } });
    const launch = { ...session, profileHandle: "profile", profileGeneration: 1, accountGeneration: 2, runtimeGeneration: 3 };
    await host.onCommand({ type: "relay:codex-command", commandId: "ensure", scope: launch, command: { kind: "ensure_profile_child", posture: { kind: "codex_default", anchorMode: "default" } } });
    expect(calls).toEqual(["enable", "admin:runtime_inspect", "ensure:profile"]);
    expect(sent.at(-2)).toMatchObject({ type: "relay:codex-status", status: { workspace: { state: "unavailable" } } });
    expect(sent.at(-1)).toMatchObject({ commandId: "ensure", scope: { childGeneration: 9 }, result: { kind: "child_ready" } });
    await host.shutdown();
    expect(calls.at(-1)).toBe("close");
  });

  test("emits protocol-correct resume response and ignores stale socket scope", async () => {
    const sent: RelayCodexClientMessage[] = [];
    const services = fakeServices();
    const host = new ElectronCodexHost({
      currentActorId: () => "actor",
      createServices: async () => services,
      status: () => ({ state: "ready", runtimeGeneration: 3 }),
    });
    await host.onRegistered(session, { send: (message) => { sent.push(message); return true; } });
    await host.onCommand({
      type: "relay:codex-command",
      commandId: "resume",
      scope: bindingScope,
      command: { kind: "resume_binding" },
    });
    expect(sent.at(-1)).toEqual({
      type: "relay:codex-command-response",
      commandId: "resume",
      scope: bindingScope,
      result: { kind: "binding_ready" },
    });
    await host.onCommand({
      type: "relay:codex-command",
      commandId: "stale",
      scope: { ...bindingScope, relaySessionId: "old" },
      command: { kind: "resume_binding" },
    });
    expect(services.calls.resume).toBe(1);
  });

  test("releases only the exact binding scope and acknowledges the cleanup", async () => {
    const sent: RelayCodexClientMessage[] = [];
    const services = fakeServices();
    const host = new ElectronCodexHost({
      currentActorId: () => "actor",
      createServices: async () => services,
      status: () => ({ state: "ready", runtimeGeneration: 3 }),
    });
    await host.onRegistered(session, { send: (message) => { sent.push(message); return true; } });
    await host.onCommand({
      type: "relay:codex-command",
      commandId: "release",
      scope: bindingScope,
      command: { kind: "release_binding" },
    });
    expect(services.calls.release).toBe(1);
    expect(sent.at(-1)).toEqual({
      type: "relay:codex-command-response",
      commandId: "release",
      scope: bindingScope,
      result: { kind: "binding_released" },
    });
  });

  test("forwards an event-before-response using only the upstream-owned turn id", async () => {
    const sent: RelayCodexClientMessage[] = [];
    let normalizedMode: "work" | "plan" | undefined;
    let sink:
      | Parameters<ElectronCodexHostServices["setNotificationSink"]>[0]
      | undefined;
    const exactChild = {
      profile: {
        actorId: "actor",
        profileHandle: "profile",
        profileGeneration: 1,
      },
      accountGeneration: 2,
      runtimeGeneration: 3,
      childGeneration: 4,
    } as ChildIdentity;
    const services = fakeServices({
      setNotificationSink(next) {
        sink = next;
      },
      async start(_scope, input) {
        normalizedMode = input.collaborationMode;
        sink?.(
          exactChild,
          {
            bindingId: "binding",
            bindingGeneration: 1,
            workspace: localReceipt(),
            taskId: "task",
            jobId: "job",
            threadId: "thread",
          } as never,
          {
            method: "item/agentMessage/delta",
            params: {
              threadId: "thread",
              turnId: "upstream-turn",
              itemId: "agent-message",
              delta: "hello from Codex",
            },
          },
        );
        return { turnId: "upstream-turn" };
      },
    });
    const host = new ElectronCodexHost({
      currentActorId: () => "actor",
      createServices: async () => services,
      status: () => ({ state: "ready", runtimeGeneration: 3 }),
    });
    await host.onRegistered(session, {
      send: (message) => {
        sent.push(message);
        return true;
      },
    });
    await host.onCommand({
      type: "relay:codex-command",
      commandId: "start",
      scope: bindingScope,
      command: {
        kind: "start_turn",
        userText: "hello",
        turnInputRef: "input",
      },
    });
    expect(normalizedMode).toBe("work");

    const event = sent.find(
      (message) =>
        message.type === "relay:codex-event" &&
        message.event.kind === "message_delta",
    );
    expect(event).toMatchObject({
      scope: {
        threadId: "thread",
        turnId: "upstream-turn",
      },
      event: { kind: "message_delta", text: "hello from Codex" },
    });
    expect(sent.at(-1)).toMatchObject({
      type: "relay:codex-command-response",
      commandId: "start",
      scope: {
        turnId: "upstream-turn",
      },
      result: { kind: "turn_started" },
    });
  });

  test("relays one bounded authoritative completion as the sole terminal edge", async () => {
    const sent: RelayCodexClientMessage[] = [];
    let sink: Parameters<ElectronCodexHostServices["setNotificationSink"]>[0] | undefined;
    const exactChild = child();
    const binding = {
      bindingId: "binding",
      bindingGeneration: 1,
      workspace: localReceipt(),
      taskId: "task",
      jobId: "job",
      threadId: "thread",
    } as never;
    const services = fakeServices({
      setNotificationSink(next) { sink = next; },
      async start() { return { turnId: "upstream-turn" }; },
    });
    const host = new ElectronCodexHost({
      currentActorId: () => "actor",
      createServices: async () => services,
      status: () => ({ state: "ready", runtimeGeneration: 3 }),
    });
    await host.onRegistered(session, { send: (message) => { sent.push(message); return true; } });
    await host.onCommand({
      type: "relay:codex-command",
      commandId: "start",
      scope: bindingScope,
      command: {
        kind: "start_turn", userText: "hello", turnInputRef: "input",
      },
    });

    sink?.(exactChild, binding, {
      method: "item/completed",
      params: {
        threadId: "thread", turnId: "upstream-turn", completedAtMs: 1,
        item: { type: "agentMessage", id: "final", text: "Final answer", phase: "final_answer" },
      },
    });
    sink?.(exactChild, binding, {
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: {
          id: "upstream-turn", status: "completed", error: null, itemsView: "full",
          items: [
            { type: "agentMessage", id: "commentary", text: "Working", phase: "commentary" },
            { type: "agentMessage", id: "final", text: "Final answer", phase: "final_answer" },
          ],
          startedAt: null, completedAt: 2, durationMs: null,
        },
      },
    });

    const completionIndex = sent.findIndex((message) =>
      message.type === "relay:codex-event" && message.event.kind === "turn_completed",
    );
    expect(completionIndex).toBeGreaterThan(-1);
    expect(sent[completionIndex]).toMatchObject({
      scope: { threadId: "thread", turnId: "upstream-turn" },
      event: {
        kind: "turn_completed",
        status: "completed",
        itemsView: "full",
        assistantItems: [
          { itemId: "commentary", text: "Working", phase: "commentary" },
          { itemId: "final", text: "Final answer", phase: "final_answer" },
        ],
      },
    });
    expect(sent.filter((message) =>
      message.type === "relay:codex-event" &&
      message.event.kind === "turn_completed"
    )).toHaveLength(1);
  });

  test("streams bounded command and patch activity while hiding dynamic Tool items", async () => {
    const sent: RelayCodexClientMessage[] = [];
    let sink: Parameters<ElectronCodexHostServices["setNotificationSink"]>[0] | undefined;
    const exactChild = child();
    const binding = {
      bindingId: "binding",
      bindingGeneration: 1,
      workspace: localReceipt(),
      taskId: "task",
      jobId: "job",
      threadId: "thread",
    } as never;
    const services = fakeServices({
      setNotificationSink(next) { sink = next; },
      async start() { return { turnId: "upstream-turn" }; },
    });
    const host = new ElectronCodexHost({
      currentActorId: () => "actor",
      createServices: async () => services,
      status: () => ({ state: "ready", runtimeGeneration: 3 }),
    });
    await host.onRegistered(session, { send: (message) => { sent.push(message); return true; } });
    await host.onCommand({
      type: "relay:codex-command",
      commandId: "start",
      scope: bindingScope,
      command: { kind: "start_turn", userText: "inspect", turnInputRef: "input" },
    });

    sink?.(exactChild, binding, {
      method: "item/started",
      params: {
        threadId: "thread", turnId: "upstream-turn", startedAtMs: 1,
        item: {
          type: "commandExecution", id: "command-1", command: "bun test",
          cwd: "/workspace", processId: "42", status: "inProgress",
          aggregatedOutput: null, exitCode: null, durationMs: null,
        },
      },
    });
    sink?.(exactChild, binding, {
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: "thread", turnId: "upstream-turn", itemId: "command-1",
        delta: "test output",
      },
    });
    sink?.(exactChild, binding, {
      method: "item/fileChange/patchUpdated",
      params: {
        threadId: "thread", turnId: "upstream-turn", itemId: "patch-1",
        changes: [{
          path: "src/example.ts",
          kind: { type: "update", move_path: null },
          diff: "@@ -1 +1 @@",
        }],
      },
    });
    const activity = sent.filter((message) =>
      message.type === "relay:codex-event" &&
      (message.event.kind === "command_summary" || message.event.kind === "patch_summary")
    );
    expect(activity).toHaveLength(3);
    expect(activity[0]).toMatchObject({
      scope: { itemId: "command-1" },
      event: { kind: "command_summary", summary: "Command started\nbun test\n/workspace" },
    });
    expect(activity[1]).toMatchObject({
      scope: { itemId: "command-1" },
      event: { kind: "command_summary", summary: "Command output\ntest output" },
    });
    expect(activity[2]).toMatchObject({
      scope: { itemId: "patch-1" },
      event: { kind: "patch_summary", summary: "Patch updated\nupdate src/example.ts" },
    });
  });

  test("maps an exact relay steer command to the active host turn", async () => {
    const sent: RelayCodexClientMessage[] = [];
    const calls: Array<{ text: string; actorRef: string }> = [];
    const services = fakeServices({
      async steer(_scope, input) {
        calls.push(input);
      },
    });
    const host = new ElectronCodexHost({
      currentActorId: () => "actor",
      createServices: async () => services,
      status: () => ({ state: "ready", runtimeGeneration: 3 }),
    });
    await host.onRegistered(session, {
      send: (message) => {
        sent.push(message);
        return true;
      },
    });
    await host.onCommand({
      type: "relay:codex-command",
      commandId: "steer",
      scope: { ...bindingScope, turnId: "active-turn" },
      command: {
        kind: "steer_turn",
        userText: "Focus on the failing test",
        actorRef: "actor-ref",
      },
    });

    expect(calls).toEqual([{
      text: "Focus on the failing test",
      actorRef: "actor-ref",
    }]);
    expect(sent.at(-1)).toMatchObject({
      type: "relay:codex-command-response",
      commandId: "steer",
      scope: { turnId: "active-turn" },
      result: { kind: "accepted" },
    });
  });

  test("invalidates synchronously and serializes disconnect shutdown before recreation", async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = fakeServices({
      invalidateWorkspaces() { order.push("invalidate"); },
      shutdown: () => new Promise<void>((resolve) => { order.push("shutdown:start"); release = () => { order.push("shutdown:end"); resolve(); }; }),
    });
    const second = fakeServices();
    let created = 0;
    const host = new ElectronCodexHost({
      currentActorId: () => "actor",
      createServices: async () => (++created === 1 ? first : second),
      status: () => ({ state: "ready" }),
    });
    await host.onRegistered(session, { send: () => true });
    host.onDisconnected();
    expect(order).toEqual(["invalidate"]);
    await Promise.resolve();
    expect(order).toEqual(["invalidate", "shutdown:start"]);
    let registered = false;
    const registration = host.onRegistered({ ...session, relaySessionId: "next" }, { send: () => true }).then(() => { registered = true; });
    await Promise.resolve();
    expect(registered).toBeFalse();
    release();
    await registration;
    expect(order).toEqual(["invalidate", "shutdown:start", "shutdown:end"]);
    expect(created).toBe(2);
  });

  test("logs only bounded cleanup diagnostics when disconnect containment fails", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    const privateDetail = "/Users/private/.codex/account-secret";
    const services = fakeServices({
      async shutdown() {
        throw Object.assign(new Error(`kill EPERM: ${privateDetail}`), { code: "EPERM" });
      },
    });
    const host = new ElectronCodexHost({
      currentActorId: () => "actor",
      createServices: async () => services,
      status: () => ({ state: "ready" }),
    });

    try {
      await host.onRegistered(session, { send: () => true });
      host.onDisconnected();
      await host.shutdown();

      expect(warning).toHaveBeenCalledWith(
        "[desktop][d453] Codex service cleanup failed",
        {
          final: false,
          stage: "supervisor",
          errorName: "Error",
          stableCode: "CODEX_CONTEXT_INVALID",
        },
      );
      expect(JSON.stringify(warning.mock.calls)).not.toContain(privateDetail);

      warning.mockClear();
      let supervisorShutdowns = 0;
      const adminFailure = fakeServices({
        admin: {
          async enable() {},
          async detach() { throw new Error(`detach failed: ${privateDetail}`); },
          async close() {},
          async ensureProfileChild() { return {} as never; },
          async execute() { return { kind: "rejected", code: "CODEX_CAPABILITY_UNAVAILABLE" }; },
        },
        async shutdown() { supervisorShutdowns += 1; },
      });
      const adminFailureHost = new ElectronCodexHost({
        currentActorId: () => "actor",
        createServices: async () => adminFailure,
        status: () => ({ state: "ready" }),
      });
      await adminFailureHost.onRegistered(session, { send: () => true });
      adminFailureHost.onDisconnected();
      await adminFailureHost.shutdown();
      expect(supervisorShutdowns).toBe(1);
      expect(warning.mock.calls[0]?.[1]).toMatchObject({ stage: "admin" });
      expect(JSON.stringify(warning.mock.calls)).not.toContain(privateDetail);
    } finally {
      warning.mockRestore();
    }
  });

  test("contains a disconnect during delayed service creation", async () => {
    const gate = deferred<ElectronCodexHostServices>();
    const started = deferred<void>();
    const created = fakeServices();
    let sent = 0;
    const host = new ElectronCodexHost({
      currentActorId: () => "actor",
      createServices: () => { started.resolve(); return gate.promise; },
      status: () => ({ state: "ready" }),
    });
    const registration = host.onRegistered(session, { send: () => { sent += 1; return true; } });
    await started.promise;
    host.onDisconnected();
    gate.resolve(created);
    await registration;
    expect(created.calls.invalidations).toBe(1);
    expect(created.calls.shutdown).toBe(1);
    expect(created.calls.mint).toBe(0);
    expect(sent).toBe(0);
  });

  test("waits for a late created service to close and shut down after final shutdown", async () => {
    const creation = deferred<ElectronCodexHostServices>();
    const started = deferred<void>();
    const closeStarted = deferred<void>();
    const shutdownStarted = deferred<void>();
    let releaseClose!: () => void;
    let releaseShutdown!: () => void;
    const calls: string[] = [];
    const late = fakeServices({
      invalidateWorkspaces() { calls.push("invalidate"); },
      shutdown: () => new Promise<void>((resolve) => { calls.push("shutdown:start"); shutdownStarted.resolve(); releaseShutdown = () => { calls.push("shutdown:end"); resolve(); }; }),
      admin: {
        async enable() { calls.push("enable"); },
        async detach() { calls.push("detach"); },
        close: () => new Promise<void>((resolve) => { calls.push("close:start"); closeStarted.resolve(); releaseClose = () => { calls.push("close:end"); resolve(); }; }),
        async ensureProfileChild() { return {} as never; },
        async execute() { return { kind: "rejected", code: "CODEX_CAPABILITY_UNAVAILABLE" }; },
      },
    });
    const host = new ElectronCodexHost({
      currentActorId: () => "actor",
      createServices: () => { started.resolve(); return creation.promise; },
      status: () => ({ state: "ready" }),
    });
    const registration = host.onRegistered(session, { send: () => true });
    await started.promise;
    let completed = false;
    const shutdown = host.shutdown().then(() => { completed = true; });
    creation.resolve(late);
    await closeStarted.promise;
    expect(completed).toBeFalse();
    releaseClose();
    await shutdownStarted.promise;
    expect(completed).toBeFalse();
    releaseShutdown();
    await Promise.all([registration, shutdown]);
    expect(calls).toEqual(["invalidate", "close:start", "close:end", "shutdown:start", "shutdown:end"]);
    expect(late.calls.shutdown).toBe(0);
  });

  test("contains a superseded delayed creation failure and admits the fresh registration", async () => {
    const staleGate = deferred<ElectronCodexHostServices>();
    const staleStarted = deferred<void>();
    const fresh = fakeServices({
      async mintWorkspace() {
        fresh.calls.mint += 1;
        return { local: {} as never, wire: { ...wireWorkspace, workspaceRef: "fresh-after-stale-failure" } };
      },
    });
    const staleSent: RelayCodexClientMessage[] = [];
    const freshSent: RelayCodexClientMessage[] = [];
    const replacement = { ...session, relaySessionId: "replacement", capabilityRevision: 4 };
    const host = new ElectronCodexHost({
      currentActorId: () => "actor",
      createServices: (requested) => {
        if (requested.relaySessionId === session.relaySessionId) {
          staleStarted.resolve();
          return staleGate.promise;
        }
        return Promise.resolve(fresh);
      },
      status: () => ({ state: "ready" }),
    });
    const staleRegistration = host.onRegistered(session, { send: (message) => { staleSent.push(message); return true; } });
    await staleStarted.promise;
    const staleCommand = host.onCommand({
      type: "relay:codex-command",
      commandId: "stale-delayed-failure",
      scope: bindingScope,
      command: { kind: "resume_binding" },
    });
    const freshRegistration = host.onRegistered(replacement, { send: (message) => { freshSent.push(message); return true; } });
    const staleOutcome = staleRegistration.then(
      () => new Error("stale registration unexpectedly succeeded"),
      (error: unknown) => error,
    );
    staleGate.reject(new Error("superseded failure"));
    const staleError = await staleOutcome;
    expect(staleError).toBeInstanceOf(Error);
    expect((staleError as Error).message).toBe("superseded failure");
    await Promise.all([staleCommand, freshRegistration]);
    expect(staleSent.filter((message) => message.type === "relay:codex-command-response")).toEqual([
      expect.objectContaining({
        commandId: "stale-delayed-failure",
        result: { kind: "rejected", code: "CODEX_CHILD_START_FAILED" },
      }),
    ]);
    expect(fresh.calls.mint).toBe(1);
    expect(freshSent.at(-1)).toMatchObject({
      socket: { relaySessionId: "replacement" },
      capabilityRevision: 4,
      status: { workspace: { state: "bound", receipt: { workspaceRef: "fresh-after-stale-failure" } } },
    });
    expect(host.isReady()).toBeTrue();
  });

  test("holds an exact-session command behind registration instead of dropping it", async () => {
    const gate = deferred<ElectronCodexHostServices>();
    const services = fakeServices();
    const sent: RelayCodexClientMessage[] = [];
    const host = new ElectronCodexHost({
      currentActorId: () => "actor",
      createServices: () => gate.promise,
      status: () => ({ state: "ready" }),
    });
    const registration = host.onRegistered(session, { send: (message) => { sent.push(message); return true; } });
    const command = host.onCommand({ type: "relay:codex-command", commandId: "waiting", scope: bindingScope, command: { kind: "resume_binding" } });
    await Promise.resolve();
    expect(services.calls.resume).toBe(0);
    gate.resolve(services);
    await Promise.all([registration, command]);
    expect(services.calls.resume).toBe(1);
    expect(sent.at(-1)).toMatchObject({ commandId: "waiting", result: { kind: "binding_ready" } });
  });

  test("stably rejects a pending command when registration fails", async () => {
    const gate = deferred<ElectronCodexHostServices>();
    const sent: RelayCodexClientMessage[] = [];
    const host = new ElectronCodexHost({
      currentActorId: () => "actor",
      createServices: () => gate.promise,
      status: () => ({ state: "ready" }),
    });
    const registration = host.onRegistered(session, { send: (message) => { sent.push(message); return true; } });
    const command = host.onCommand({ type: "relay:codex-command", commandId: "failed-registration", scope: bindingScope, command: { kind: "resume_binding" } });
    gate.reject(new Error("unavailable"));
    await expect(registration).rejects.toThrow("unavailable");
    await command;
    expect(sent.at(-1)).toMatchObject({
      commandId: "failed-registration",
      result: { kind: "rejected", code: "CODEX_CHILD_START_FAILED" },
    });
  });

  test("emits a response-owned rebind rejection accepted by the real relay correlator", async () => {
    const sent: RelayCodexClientMessage[] = [];
    const services = fakeServices({
      async rebind() { throw new Error("rebind unavailable"); },
    });
    const host = new ElectronCodexHost({
      currentActorId: () => "actor",
      createServices: async () => services,
      status: () => ({ state: "ready" }),
    });
    await host.onRegistered(session, { send: (message) => { sent.push(message); return true; } });
    const { workspace: _workspace, ...rebindScope } = bindingScope;
    const command = {
      type: "relay:codex-command" as const,
      commandId: "rebind-rejection",
      scope: rebindScope,
      command: { kind: "rebind_binding" as const, nextBindingGeneration: 2, successorWorkspace: { ...wireWorkspace, workspaceRef: "successor" } },
    };
    await host.onCommand(command);
    const response = sent.at(-1);
    const parsed = parseRelayCodexClientMessage(response);
    expect(parsed.ok).toBeTrue();
    if (!parsed.ok || parsed.value.type !== "relay:codex-command-response") throw new Error("expected parsed response");
    expect(isRelayCodexCommandResponseForCommand(command, parsed.value)).toBeTrue();
    expect(parsed.value).toMatchObject({
      scope: { bindingGeneration: 2, workspace: { workspaceRef: "successor" } },
      result: { kind: "rejected" },
    });
  });

  test("delivers one correlated terminal rejection through the real relay before readiness drops", async () => {
    const gate = deferred<ElectronCodexHostServices>();
    const host = new ElectronCodexHost({
      currentActorId: () => "actor",
      createServices: () => gate.promise,
      status: () => ({ state: "ready" }),
    });
    const commandAdmitted = deferred<void>();
    const onCommand = host.onCommand.bind(host);
    host.onCommand = async (message) => {
      commandAdmitted.resolve();
      await onCommand(message);
    };
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected loopback relay address");
    const peerConnected = new Promise<{ peer: WebSocket; frames: ReturnType<typeof captureWsFrames> }>((resolve) => {
      server.once("connection", (peer) => resolve({ peer, frames: captureWsFrames(peer) }));
    });
    const client = createRelayClient({
      serverUrl: `http://127.0.0.1:${address.port}`,
      userId: "actor",
      relayId: "relay",
      capabilities: { profile: "desktop-agent", codex: { version: 1, hostKind: "electron", maxProfiles: 4, maxActiveTurns: 4 } },
      desktopSessionId: "desktop",
      initialCapabilityRevision: 3,
      onDispatch: async () => ({ status: "ok" }),
      codexHostPort: host,
    });
    const connecting = client.connect();
    const { peer, frames } = await peerConnected;
    await frames.next((value) => (
      typeof value === "object"
      && value !== null
      && "type" in value
      && value.type === "relay:register"
    ));
    peer.send(JSON.stringify({
      type: "relay:registered",
      relayId: "relay",
      relaySessionId: "relay-session",
      pairingGenerationRef: "pairing",
      selectedProtocolVersion: 8,
    }));
    await connecting;
    const command = { type: "relay:codex-command" as const, commandId: "terminal-registration", scope: bindingScope, command: { kind: "resume_binding" as const } };
    expect(parseRelayCodexServerMessage(command).ok).toBeTrue();
    const terminalResponse = frames.next((value) => (
      typeof value === "object"
      && value !== null
      && "type" in value
      && value.type === "relay:codex-command-response"
    ));
    peer.send(JSON.stringify(command));
    await commandAdmitted.promise;
    gate.reject(new Error("service creation failed"));
    const response = parseRelayCodexClientMessage(await terminalResponse);
    if (!response.ok || response.value.type !== "relay:codex-command-response") throw new Error("expected terminal response");
    expect(isRelayCodexCommandResponseForCommand(command, response.value)).toBeTrue();
    expect(response.value.result).toEqual({ kind: "rejected", code: "CODEX_CHILD_START_FAILED" });
    expect(host.isReady()).toBeFalse();
    await client.disconnect();
    peer.terminate();
    server.close();
  });

  test("holds an exact-session cancel behind registration and revalidates before interrupt", async () => {
    const gate = deferred<ElectronCodexHostServices>();
    let interrupted = 0;
    const services = fakeServices({ async interrupt() { interrupted += 1; } });
    const host = new ElectronCodexHost({
      currentActorId: () => "actor",
      createServices: () => gate.promise,
      status: () => ({ state: "ready" }),
    });
    const registration = host.onRegistered(session, { send: () => true });
    const cancel = host.onCancel({
      type: "relay:codex-cancel",
      scope: { ...bindingScope, turnId: "turn" },
      reason: "job_stop",
    });
    await Promise.resolve();
    expect(interrupted).toBe(0);
    gate.resolve(services);
    await Promise.all([registration, cancel]);
    expect(interrupted).toBe(1);
  });

  test("replaces a capability/session revision with fresh services and receipt", async () => {
    const first = fakeServices();
    const second = fakeServices({
      async mintWorkspace() { second.calls.mint += 1; return { local: {} as never, wire: { ...wireWorkspace, workspaceRef: "fresh" } }; },
    });
    let created = 0;
    const sent: RelayCodexClientMessage[] = [];
    const host = new ElectronCodexHost({
      currentActorId: () => "actor",
      createServices: async () => (++created === 1 ? first : second),
      status: () => ({ state: "ready" }),
    });
    await host.onRegistered(session, { send: (message) => { sent.push(message); return true; } });
    const replacement = { ...session, relaySessionId: "next-session", capabilityRevision: 4 };
    await host.onRegistered(replacement, { send: (message) => { sent.push(message); return true; } });
    expect(first.calls.invalidations).toBe(1);
    expect(first.calls.shutdown).toBe(1);
    expect(created).toBe(2);
    expect(sent.at(-1)).toMatchObject({
      socket: { relaySessionId: "next-session" },
      capabilityRevision: 4,
      status: { workspace: { state: "bound", receipt: { workspaceRef: "fresh" } } },
    });
  });

  test("factory readiness uses the stable Genie Workspace and does not require Current Folder", async () => {
    let folder: { path: string; revision: number } | null = null;
    const filesystem = {
      async lstat(path: string) { return path === "/workspace" ? workspaceStat() : fileStat(path); },
      async stat(path: string) { return path === "/workspace" ? workspaceStat() : fileStat(path); },
      async realpath(path: string) { return path; },
      async mkdir() { return true; },
      async chmod() {},
      async writeFile() {},
      async readFile() { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      async unlink() {},
      async rename() {},
    };
    const factory = createElectronCodexHostServiceFactory({
      actorId: () => "actor",
      currentFolder: () => folder,
      defaultWorkingDirectory: "/workspace",
      profileHomesRoot: "/private/profiles",
      profileHomesTrustedParent: "/private",
      bindingStateFile: "/private/state/bindings.json",
      hmacKey: "secret",
      filesystem,
      clock: { now: () => 1 },
      timer: { setTimeout: () => 1 as never, clearTimeout() {} },
      runtimes: {} as never,
      processes: {} as never,
      clients: {} as never,
      turnTerminal: {} as never,
      currentUid: () => 501,
      bindingPersistence: new MemoryPersistence(),
    });
    const services = await factory(session);
    const minted = await services.mintWorkspace();
    expect(minted.wire.revision).toBe(0);
    expect(JSON.stringify(minted.wire)).not.toContain("/workspace");
    folder = { path: "/selected", revision: 11 };
    expect((await services.mintWorkspace()).wire.revision).toBe(0);
    const source = await Bun.file(new URL("../../electron/codex-host.ts", import.meta.url)).text();
    expect(source).not.toContain("@nautilo/sandbox");
    expect(source).not.toContain("@nautilo/desktop-filesystem-grants");
  });

  test("factory enforces exclusive composition inputs and retains the exact controller instance", async () => {
    const controller = new ElectronCodexController({
      runtime: { inspect: async () => ({ state: "absent" }) },
      artifactAuthority: { allows: () => false },
      openExternal: async () => undefined,
      now: () => 1,
      mintId: () => "controller-id",
    });
    const base = hostFactoryOptions();
    expect(() => createElectronCodexHostServiceFactory({
      ...base,
      clients: {} as never,
      createClients: () => ({} as never),
    })).toThrow("exactly one of clients or createClients is required");
    expect(() => createElectronCodexHostServiceFactory({
      ...base,
      clients: undefined,
    })).toThrow("exactly one of clients or createClients is required");
    expect(() => createElectronCodexHostServiceFactory({
      ...base,
      controller: {} as never,
      controllerInstance: controller,
    })).toThrow("controller and controllerInstance are mutually exclusive");

    const factory = createElectronCodexHostServiceFactory({
      ...base,
      controllerInstance: controller,
    });
    const services = await factory(session);
    expect(services.admin).toBe(controller);
    await services.shutdown();
    await controller.detach();
    await controller.close();
  });

  test("per-session client callbacks stay bound to the exact supervisor and delegate faults", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "nautilo-codex-client-callbacks-")));
    const callbacks: ElectronCodexClientCallbackBuilderInput[] = [];
    const faults: unknown[] = [];
    try {
      const factory = createElectronCodexHostServiceFactory({
        ...hostFactoryOptions({
          profileHomesRoot: join(root, "profiles"),
          profileHomesTrustedParent: root,
          bindingStateFile: join(root, "state", "bindings.json"),
          clients: undefined,
          filesystem: undefined,
          currentUid: () => process.getuid?.() ?? 0,
        }),
        runtimes: {
          async acquire(generation: number) {
            return {
              launch: {
                executablePath: "/verified/codex",
                args: ["app-server"],
                runtimeGeneration: generation,
              },
              lease: { release: async () => undefined },
            };
          },
        },
        processes: {
          async spawn(spec) {
            let gone = false;
            let finish!: (value: { code: number | null; signal: string | null }) => void;
            const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
              finish = resolve;
            });
            return {
              pid: 42,
              spec,
              stdio: {
                stdin: { write: async () => undefined, end: async () => undefined },
                stdout: { async *[Symbol.asyncIterator]() {} },
                stderr: { async *[Symbol.asyncIterator]() {} },
              },
              exited,
              isProcessGroupGone: async () => gone,
              sendInterrupt: async () => {
                gone = true;
                finish({ code: null, signal: "SIGINT" });
              },
              signalProcessGroup: async (signal) => {
                if (signal === "SIGTERM" || signal === "SIGKILL") {
                  gone = true;
                  finish({ code: null, signal });
                }
              },
            } as never;
          },
        },
        createClients(input) {
          callbacks.push(input);
          return {
            async connect(process) {
              const codexHome = (process as unknown as {
                spec: { env: Readonly<Record<string, string>> };
              }).spec.env["CODEX_HOME"]!;
              return {
                initialize: async () => ({ codexHome }),
                startChatgptLogin: async () => ({ upstreamLoginId: "login", authUrl: "https://auth.openai.com/" }),
                cancelLogin: async () => ({ cancelled: true }),
                readAccount: async () => ({ state: "signed_out", requiresOpenaiAuth: true }),
                readUsage: async () => ({ dailyUsage: [] }),
                logout: async () => undefined,
                startThread: async () => ({ threadId: "thread", cwd: root }),
                resumeThread: async () => ({ cwd: root }),
                interruptThread: async () => undefined,
                steerThread: async () => undefined,
                close: async () => undefined,
              };
            },
          };
        },
        onFault: (fault) => {
          faults.push(fault);
        },
      });
      const services = await factory(session);
      expect(callbacks).toHaveLength(1);
      const first = await services.ensure({
        ...session,
        profileHandle: "profile",
        profileGeneration: 1,
        accountGeneration: 1,
        runtimeGeneration: 3,
      });
      expect(callbacks[0]!.isCurrent(first)).toBeTrue();
      expect(callbacks[0]!.isCurrent({ ...first, childGeneration: first.childGeneration + 1 })).toBeFalse();

      const successor = await services.ensure({
        ...session,
        profileHandle: "profile",
        profileGeneration: 1,
        accountGeneration: 1,
        runtimeGeneration: 4,
      });
      expect(callbacks[0]!.isCurrent(first)).toBeFalse();
      expect(callbacks[0]!.isCurrent(successor)).toBeTrue();
      await callbacks[0]!.onClientFault(first);
      expect(callbacks[0]!.isCurrent(successor)).toBeTrue();
      await callbacks[0]!.onClientFault(successor);
      expect(callbacks[0]!.isCurrent(successor)).toBeFalse();
      expect(faults).toEqual([{ kind: "child_crashed", child: successor }]);
      await services.shutdown();

      const replacement = await factory({ ...session, relaySessionId: "replacement" });
      expect(callbacks).toHaveLength(2);
      const replacementChild = await replacement.ensure({
        ...session,
        relaySessionId: "replacement",
        profileHandle: "profile",
        profileGeneration: 1,
        accountGeneration: 1,
        runtimeGeneration: 4,
      });
      expect(callbacks[0]!.isCurrent(replacementChild)).toBeFalse();
      expect(callbacks[1]!.isCurrent(replacementChild)).toBeTrue();
      await callbacks[0]!.onClientFault(replacementChild);
      expect(callbacks[1]!.isCurrent(replacementChild)).toBeTrue();
      await replacement.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("AtomicJsonCodexBindingStore", () => {
  test("accepts protocol-defined zero generations for a newly opened binding", async () => {
    const persistence = new MemoryPersistence();
    const store = new AtomicJsonCodexBindingStore("/state/bindings.json", persistence);
    const zeroChild = {
      profile: { actorId: "actor", profileHandle: "profile", profileGeneration: 0 },
      accountGeneration: 0,
      runtimeGeneration: 0,
      childGeneration: 0,
    };
    const zeroWorkspace = { ...localReceipt(), capabilityRevision: 0, revision: 0 };
    const reservation = openReservation("initial-zero", {
      bindingGeneration: 0,
      child: zeroChild,
      workspace: zeroWorkspace,
    });
    const record = bindingRecord({
      bindingGeneration: 0,
      child: zeroChild,
      workspace: zeroWorkspace,
    });
    expect(await store.beginOpen(reservation)).toBe("started");
    expect(await store.completeOpen(reservation, record)).toBeTrue();
    expect(await store.get("binding" as never)).toEqual(record);
  });

  test("treats a restarted reservation id as same pending only for identical authority", async () => {
    const persistence = new MemoryPersistence();
    const store = new AtomicJsonCodexBindingStore("/state/bindings.json", persistence);
    const reservation = openReservation("reservation");
    expect(await store.beginOpen(reservation)).toBe("started");
    expect(await store.beginOpen(openReservation("new-process-reservation"))).toBe("same_pending");
    expect(await store.beginOpen(openReservation("different-authority", { jobId: "other-job" }))).toBe("conflict");
    expect(persistence.renames).toBe(3);
    expect([...persistence.files.keys()].some((path) => path.endsWith(".tmp"))).toBeFalse();
  });

  test("completes durably, rejects reopen, and fails closed on malformed nested state", async () => {
    const persistence = new MemoryPersistence();
    const store = new AtomicJsonCodexBindingStore("/state/bindings.json", persistence);
    const reservation = openReservation("reservation");
    const record = bindingRecord();
    expect(await store.beginOpen(reservation)).toBe("started");
    expect(await store.completeOpen(reservation, record)).toBeTrue();
    const restarted = new AtomicJsonCodexBindingStore("/state/bindings.json", persistence);
    expect(await restarted.get("binding" as never)).toEqual(record);
    expect(await restarted.beginOpen(openReservation("reopen"))).toBe("conflict");
    persistence.files.set("/state/bindings.json", JSON.stringify({
      schemaVersion: 1,
      records: { binding: { bindingId: "binding", child: { profile: null } } },
      reservations: {},
    }));
    await expect(store.get("binding" as never)).rejects.toThrow("invalid_codex_binding_state");
  });

  test("accepts a full exact record but rejects extra fields and raw paths", async () => {
    const persistence = new MemoryPersistence();
    const store = new AtomicJsonCodexBindingStore("/state/bindings.json", persistence);
    const reservation = openReservation("full", {
      model: "gpt-codex",
    });
    const record = bindingRecord({
      model: "gpt-codex",
    });
    expect(await store.beginOpen(reservation)).toBe("started");
    expect(await store.completeOpen(reservation, record)).toBeTrue();
    expect(await store.get("binding" as never)).toEqual(record);

    expect(() => store.update({ ...record, rawPath: "/secret" } as never)).toThrow("invalid_codex_binding_record");
    expect(() => store.update({ ...record, workspace: { ...localReceipt(), selectedPath: "/secret" } } as never)).toThrow("invalid_codex_binding_record");
    expect(() => store.update({
      ...record,
      child: { ...child(), profile: { ...child().profile, extra: true } },
    } as never)).toThrow("invalid_codex_binding_record");
    expect(() => store.update({ ...record, model: " invalid model " } as never)).toThrow("invalid_codex_binding_record");
    expect(() => store.beginOpen(openReservation("bad-generation", { bindingGeneration: -1 })))
      .toThrow("invalid_codex_binding_reservation:binding_generation");
    expect(() => store.beginOpen(openReservation("bad-posture", { posture: { kind: "anything" } })))
      .toThrow("invalid_codex_binding_reservation:posture");
    persistence.files.set("/state/bindings.json", JSON.stringify({ schemaVersion: 1, records: {}, reservations: {}, rawPath: "/secret" }));
    await expect(store.get("binding" as never)).rejects.toThrow("invalid_codex_binding_state");
  });

  test("migrates only the retired callback key and rewrites canonical binding state", async () => {
    const persistence = new MemoryPersistence();
    const record = bindingRecord();
    const reservation = openReservation("reservation");
    persistence.files.set("/state/bindings.json", JSON.stringify({
      schemaVersion: 1,
      records: { binding: { ...record, callbacks: { manifestHash: "retired", declarations: [] } } },
      reservations: { binding: { ...reservation, callbacks: { manifestHash: "retired", declarations: [] } } },
    }));
    const store = new AtomicJsonCodexBindingStore("/state/bindings.json", persistence);
    expect(await store.get("binding" as never)).toEqual(record);
    const rewritten = JSON.parse(persistence.files.get("/state/bindings.json")!);
    expect(rewritten.records.binding.callbacks).toBeUndefined();
    expect(rewritten.reservations.binding.callbacks).toBeUndefined();
    expect(persistence.renames).toBe(1);

    persistence.files.set("/state/bindings.json", JSON.stringify({
      schemaVersion: 1,
      records: { binding: { ...record, callbacks: {}, rawPath: "/secret" } },
      reservations: {},
    }));
    await expect(store.get("binding" as never)).rejects.toThrow("invalid_codex_binding_state");
  });

  test("normalizes omitted model and ignores only mutable current activity for restart recovery", async () => {
    const persistence = new MemoryPersistence();
    const store = new AtomicJsonCodexBindingStore("/state/bindings.json", persistence);
    const opening = openReservation("open-one");
    expect(await store.beginOpen(opening)).toBe("started");
    const restartedOpen = new AtomicJsonCodexBindingStore("/state/bindings.json", persistence);
    expect(await restartedOpen.beginOpen(openReservation("open-two", { model: undefined }))).toBe("same_pending");

    const rebindPersistence = new MemoryPersistence();
    const rebindStore = new AtomicJsonCodexBindingStore("/state/rebind.json", rebindPersistence);
    const completed = bindingRecord();
    const initialOpen = openReservation("initial");
    expect(await rebindStore.beginOpen(initialOpen)).toBe("started");
    expect(await rebindStore.completeOpen(initialOpen, completed)).toBeTrue();
    expect(await rebindStore.beginRebind(rebindReservation("rebind-one", completed), completed)).toBe("started");
    const restartedRebind = new AtomicJsonCodexBindingStore("/state/rebind.json", rebindPersistence);
    const activityDrift = { ...completed, activeTurns: 4, pendingRequests: 2, outstandingRpcs: 3 };
    expect(await restartedRebind.beginRebind(rebindReservation("rebind-two", activityDrift), completed)).toBe("same_pending");
    const immutableDrift = { ...completed, model: "other-model" };
    expect(await restartedRebind.beginRebind(rebindReservation("rebind-three", immutableDrift), completed)).toBe("conflict");
  });
});

function fakeServices(overrides: Partial<ElectronCodexHostServices> = {}): ElectronCodexHostServices & {
  calls: { release: number; resume: number; mint: number; invalidations: number; shutdown: number };
} {
  const calls = { release: 0, resume: 0, mint: 0, invalidations: 0, shutdown: 0 };
  return {
    calls,
    async mintWorkspace() { calls.mint += 1; return { local: {} as never, wire: wireWorkspace }; },
    async resolveWorkspace() { return {} as never; },
    invalidateWorkspaces() { calls.invalidations += 1; },
    async ensure() { return {} as never; },
    async open() { return {} as never; },
    async resume() { calls.resume += 1; return {} as never; },
    async release() { calls.release += 1; },
    async rebind() { return {} as never; },
    async start() { return { turnId: "turn" }; },
    async interrupt() {},
    async steer() {},
    setNotificationSink() {},
    setRequestSink() {},
    async drain() {},
    async hasActiveWork() { return false; },
    async shutdown() { calls.shutdown += 1; },
    ...overrides,
  };
}

function hostFactoryOptions(
  overrides: Partial<ElectronCodexHostServiceFactoryOptions> = {},
): ElectronCodexHostServiceFactoryOptions {
  return {
    actorId: () => "actor",
    currentFolder: () => ({ path: "/selected", revision: 1 }),
    defaultWorkingDirectory: "/workspace",
    profileHomesRoot: "/private/profiles",
    profileHomesTrustedParent: "/private",
    bindingStateFile: "/private/state/bindings.json",
    hmacKey: "secret",
    filesystem: {
      async lstat(path: string) { return fileStat(path); },
      async stat(path: string) { return fileStat(path); },
      async realpath(path: string) { return path; },
      async mkdir() { return true; },
      async chmod() {},
      async writeFile() {},
      async readFile() { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      async unlink() {},
      async rename() {},
    },
    clock: { now: () => 1 },
    timer: { setTimeout: () => 1 as never, clearTimeout() {} },
    runtimes: {} as never,
    processes: {} as never,
    clients: {} as never,
    turnTerminal: { wait: async () => true },
    currentUid: () => 501,
    bindingPersistence: new MemoryPersistence(),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function openReservation(reservationId: string, overrides: Record<string, unknown> = {}) {
  return {
    bindingId: "binding",
    bindingGeneration: 1,
    workspace: localReceipt(),
    taskId: "task",
    jobId: "job",
    workingDirectory: "/workspace",
    posture: { kind: "codex_default" },
    child: child(),
    reservationId,
    state: "opening",
    ...overrides,
  } as never;
}

function bindingRecord(overrides: Record<string, unknown> = {}) {
  return {
    bindingId: "binding",
    bindingGeneration: 1,
    threadId: "thread",
    child: child(),
    workspace: localReceipt(),
    taskId: "task",
    jobId: "job",
    workingDirectory: "/workspace",
    posture: { kind: "codex_default" },
    activeTurns: 0,
    pendingRequests: 0,
    outstandingRpcs: 0,
    ...overrides,
  } as never;
}

function rebindReservation(reservationId: string, current: ReturnType<typeof bindingRecord>) {
  return {
    bindingId: "binding",
    bindingGeneration: 1,
    taskId: "task",
    jobId: "job",
    threadId: "thread",
    successorWorkspace: localReceipt(),
    nextBindingGeneration: 2,
    child: child(),
    current,
    reservationId,
    state: "rebinding",
  } as never;
}

function child() {
  return {
    profile: { actorId: "actor", profileHandle: "profile", profileGeneration: 1 },
    accountGeneration: 1,
    runtimeGeneration: 1,
    childGeneration: 1,
  };
}

function localReceipt() {
  return {
    handle: "workspace",
    actorId: "actor",
    relayId: "relay",
    relaySessionId: "relay-session",
    desktopSessionId: "desktop",
    pairingGenerationRef: "pairing",
    capabilityRevision: 3,
    revision: 7,
    fingerprint: "fingerprint",
    issuedAt: 1,
    expiresAt: 1_001,
  };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function captureWsFrames(socket: WebSocket) {
  const buffered: unknown[] = [];
  const waiters: Array<{
    predicate: (value: unknown) => boolean;
    resolve: (value: unknown) => void;
  }> = [];
  socket.on("message", (data) => {
    let value: unknown;
    try {
      value = JSON.parse(data.toString()) as unknown;
    } catch {
      return;
    }
    const waiterIndex = waiters.findIndex(({ predicate }) => predicate(value));
    if (waiterIndex < 0) {
      buffered.push(value);
      return;
    }
    waiters.splice(waiterIndex, 1)[0]!.resolve(value);
  });
  return {
    next(predicate: (value: unknown) => boolean): Promise<unknown> {
      const bufferedIndex = buffered.findIndex(predicate);
      if (bufferedIndex >= 0) return Promise.resolve(buffered.splice(bufferedIndex, 1)[0]);
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
  };
}

function fileStat(path: string) {
  if (path !== "/selected") throw Object.assign(new Error("missing"), { code: "ENOENT" });
  return { mode: 0o700, uid: 501, dev: 1, ino: 2, isDirectory: true, isSymbolicLink: false };
}

function workspaceStat() {
  return { mode: 0o700, uid: 501, dev: 1, ino: 3, isDirectory: true, isSymbolicLink: false };
}

class MemoryPersistence implements CodexBindingPersistence {
  readonly files = new Map<string, string>();
  renames = 0;
  async mkdir() {}
  async readFile(path: string) {
    const value = this.files.get(path);
    if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return value;
  }
  async writeFile(path: string, contents: string) {
    if (this.files.has(path)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
    this.files.set(path, contents);
  }
  async rename(from: string, to: string) {
    const value = this.files.get(from);
    if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    this.files.delete(from);
    this.files.set(to, value);
    this.renames += 1;
  }
  async unlink(path: string) { this.files.delete(path); }
}
