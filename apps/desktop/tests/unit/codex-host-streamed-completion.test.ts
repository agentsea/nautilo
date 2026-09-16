import { describe, expect, test } from "bun:test";
import type { ChildIdentity } from "@nautilo/codex-app-server-host/internal";
import type {
  BindingScope,
  RelayCodexClientMessage,
  RelayCodexSession,
} from "@nautilo/relay";
import {
  ElectronCodexHost,
  type ElectronCodexHostServices,
} from "../../electron/codex-host.ts";

const { parseRelayCodexClientMessage } = await import("@nautilo/relay");

const session: RelayCodexSession = {
  relayId: "relay",
  relaySessionId: "relay-session",
  desktopSessionId: "desktop",
  pairingGenerationRef: "pairing",
  selectedProtocolVersion: 17,
  capabilityRevision: 3,
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
  workspace: {
    workspaceRef: "workspace",
    revision: 7,
    fingerprint: "fingerprint",
    issuedAt: "1970-01-01T00:00:00.001Z",
    expiresAt: "1970-01-01T00:00:01.001Z",
  },
  taskId: "task",
  jobId: "job",
  threadId: "thread",
};

describe("ElectronCodexHost streamed completion", () => {
  test("chunks long response deltas and references their complete streamed item on v17", async () => {
    const sent: RelayCodexClientMessage[] = [];
    let sink: Parameters<ElectronCodexHostServices["setNotificationSink"]>[0] | undefined;
    const services = fakeServices({
      setNotificationSink(next) { sink = next; },
      async start() { return { turnId: "upstream-turn" }; },
    });
    const host = new ElectronCodexHost({
      currentActorId: () => "actor",
      createServices: async () => services,
      status: () => ({ state: "ready", runtimeGeneration: 3 }),
    });
    await host.onRegistered(session, {
      send: (message) => { sent.push(message); return true; },
    });
    await host.onCommand({
      type: "relay:codex-command",
      commandId: "start",
      scope: bindingScope,
      command: { kind: "start_turn", userText: "hello", turnInputRef: "input" },
    });

    const response = `${"a".repeat(20 * 1024)}💥complete-tail`;
    const child: ChildIdentity = {
      profile: { actorId: "actor", profileHandle: "profile", profileGeneration: 1 },
      accountGeneration: 1,
      runtimeGeneration: 1,
      childGeneration: 1,
    };
    const binding = {
      bindingId: "binding",
      bindingGeneration: 1,
      workspace: localReceipt(),
      taskId: "task",
      jobId: "job",
      threadId: "thread",
    } as never;
    sink?.(child, binding, {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread",
        turnId: "upstream-turn",
        itemId: "final",
        delta: response,
      },
    });
    sink?.(child, binding, {
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: "upstream-turn",
        completedAtMs: 1,
        item: { type: "agentMessage", id: "final", text: response, phase: "final_answer" },
      },
    });
    sink?.(child, binding, {
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: {
          id: "upstream-turn",
          status: "completed",
          error: null,
          itemsView: "full",
          items: [{ type: "agentMessage", id: "final", text: response, phase: "final_answer" }],
          startedAt: null,
          completedAt: 2,
          durationMs: null,
        },
      },
    });

    const deltas = sent.filter((message) =>
      message.type === "relay:codex-event" && message.event.kind === "message_delta"
    );
    expect(deltas).toHaveLength(2);
    expect(deltas.map((message) =>
      message.type === "relay:codex-event" && message.event.kind === "message_delta"
        ? message.event.text
        : ""
    ).join("")).toBe(response);
    expect(deltas.every((message) => parseRelayCodexClientMessage(message).ok)).toBe(true);
    expect(sent.find((message) =>
      message.type === "relay:codex-event" && message.event.kind === "assistant_item_completed"
    )).toMatchObject({ event: { text: null } });
    expect(sent.find((message) =>
      message.type === "relay:codex-event" && message.event.kind === "turn_completed"
    )).toMatchObject({ event: { assistantItems: [{ itemId: "final", text: null }] } });
  });
});

function fakeServices(
  overrides: Partial<ElectronCodexHostServices> = {},
): ElectronCodexHostServices {
  return {
    async mintWorkspace() { return { local: {} as never, wire: bindingScope.workspace }; },
    async resolveWorkspace() { return {} as never; },
    invalidateWorkspaces() {},
    async ensure() { return {} as never; },
    async open() { return {} as never; },
    async resume() { return {} as never; },
    async release() {},
    async rebind() { return {} as never; },
    async start() { return { turnId: "turn" }; },
    async interrupt() {},
    async steer() {},
    setNotificationSink() {},
    setRequestSink() {},
    async drain() {},
    async hasActiveWork() { return false; },
    async shutdown() {},
    ...overrides,
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
