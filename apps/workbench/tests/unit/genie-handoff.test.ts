import { describe, expect, test } from "bun:test";
import type { NautiloApiClient } from "@nautilo/api-client/browser";
import {
  buildBrowserPageGenieHandoff,
  buildLocalMcpGenieHandoff,
  createBrowserPageDraftDispatcher,
  createGenieHandoffBridge,
  createGenieHandoffController,
  GenieHandoffDeliveryError,
  GenieHandoffPartialSuccessError,
  genieHandoffMessageContent,
  parseWorkbenchGenieHandoff,
} from "../../src/lib/genie-handoff";

function expectThrow(action: () => unknown, secret?: string): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  if (secret) {
    expect(String(thrown)).not.toContain(secret);
    expect(JSON.stringify(thrown)).not.toContain(secret);
  }
}

function makePorts(events: string[] = []) {
  const apiClient = {
    createRoom: async () => {
      events.push("create");
      return { id: "room-new" };
    },
    sendRoomMessage: async (roomId: string, body: { content: string }) => {
      events.push(`send:${roomId}:${body.content}`);
    },
  } as unknown as NautiloApiClient;
  return {
    apiClient,
    getCurrentRoomId: () => "room-current",
    appendCurrentRoomDraft: (content: string) => { events.push(`draft:${content}`); },
    refreshRooms: async () => { events.push("refresh"); },
    setActiveRoom: (roomId: string) => { events.push(`open:${roomId}`); },
  };
}

const browser = () => buildBrowserPageGenieHandoff({
  intent: "Help with this page.",
  context: { url: "https://example.com/guide", selection: "First line\nSecond line" },
});

const mcp = () => buildLocalMcpGenieHandoff({
  intent: "Help me fix the local MCP connection.",
  context: {
    mcpName: "github.mcp",
    failureCode: "missing_environment",
    environmentNames: ["PATH", "API_TOKEN", "PATH"],
  },
});

describe("Genie application handoff", () => {
  test("builds fixed browser draft and local MCP new-Room presets", () => {
    expect(browser()).toEqual({
      version: 1,
      source: "browser.page",
      intent: "Help with this page.",
      context: { url: "https://example.com/guide", selection: "First line\nSecond line" },
      delivery: "draft-current-room",
    });
    expect(mcp()).toMatchObject({
      source: "connections.local_mcp",
      delivery: "send-new-room",
      context: {
        mcpName: "github.mcp",
        failureCode: "missing_environment",
        environmentNames: "API_TOKEN\nPATH",
      },
    });
  });

  test("projects browser pages as URL plus a markdown quote and MCP as existing safe prose", () => {
    expect(genieHandoffMessageContent(browser())).toBe(
      "https://example.com/guide\n\n> First line\n> Second line",
    );
    expect(genieHandoffMessageContent(mcp())).toBe("Help me fix the local MCP connection.");
  });

  test("draft appends only and never sends", async () => {
    const events: string[] = [];
    await createGenieHandoffController(makePorts(events)).deliver(browser());
    expect(events).toEqual(["draft:https://example.com/guide\n\n> First line\n> Second line"]);
  });

  test("the shell bridge reports absent dispatchers and never queues or replays", async () => {
    const bridge = createGenieHandoffBridge();
    const received: unknown[] = [];
    await expect(bridge.deliverBrowserPageDraft(browser())).resolves.toBe(false);

    const cleanup = bridge.registerBrowserPageDraftDispatcher(async (handoff) => { received.push(handoff); });
    expect(received).toEqual([]);
    await expect(bridge.deliverBrowserPageDraft(browser())).resolves.toBe(true);
    cleanup();
    await expect(bridge.deliverBrowserPageDraft(browser())).resolves.toBe(false);
    expect(received).toEqual([browser()]);
  });

  test("the shell bridge cleanup is identity-safe and refuses non-browser draft delivery", async () => {
    const bridge = createGenieHandoffBridge();
    const calls: string[] = [];
    const first = bridge.registerBrowserPageDraftDispatcher(async () => { calls.push("first"); });
    const second = bridge.registerBrowserPageDraftDispatcher(async () => { calls.push("second"); });
    first();
    await expect(bridge.deliverBrowserPageDraft(browser())).resolves.toBe(true);
    expect(calls).toEqual(["second"]);
    await expect(bridge.deliverBrowserPageDraft({ ...browser(), delivery: "send-current-room" })).rejects.toThrow("browser drafts only");
    await expect(bridge.deliverBrowserPageDraft(mcp())).rejects.toThrow("browser drafts only");
    second();
  });

  test("the browser draft factory preserves the composer and orders same-tick handoffs without Room effects", async () => {
    let text = "Existing draft";
    let effects = 0;
    const bridge = createGenieHandoffBridge();
    const cleanup = bridge.registerBrowserPageDraftDispatcher(createBrowserPageDraftDispatcher({
      apiClient: {
        createRoom: async () => { effects += 1; return { id: "never" }; },
        sendRoomMessage: async () => { effects += 1; },
      } as unknown as NautiloApiClient,
      getCurrentRoomId: () => "room-current",
      getCurrentDraft: () => text,
      setCurrentDraft: (next) => { text = next; },
      refreshRooms: async () => { effects += 1; },
      setActiveRoom: () => { effects += 1; },
    }));

    await Promise.all([
      bridge.deliverBrowserPageDraft(buildBrowserPageGenieHandoff({
        intent: "Help me understand this page.",
        context: { url: "https://example.com/one", selection: "first\nline" },
      })),
      bridge.deliverBrowserPageDraft(buildBrowserPageGenieHandoff({
        intent: "Help me understand this page.",
        context: { url: "https://example.com/two", selection: "second" },
      })),
    ]);
    cleanup();

    expect(text).toBe(
      "Existing draft\nhttps://example.com/one\n\n> first\n> line\nhttps://example.com/two\n\n> second",
    );
    expect(effects).toBe(0);
  });

  test("the browser draft factory refuses a missing Room before changing the draft", async () => {
    let text = "Existing draft";
    let effects = 0;
    const bridge = createGenieHandoffBridge();
    const cleanup = bridge.registerBrowserPageDraftDispatcher(createBrowserPageDraftDispatcher({
      apiClient: {
        createRoom: async () => { effects += 1; return { id: "never" }; },
        sendRoomMessage: async () => { effects += 1; },
      } as unknown as NautiloApiClient,
      getCurrentRoomId: () => null,
      getCurrentDraft: () => text,
      setCurrentDraft: () => { effects += 1; },
      refreshRooms: async () => { effects += 1; },
      setActiveRoom: () => { effects += 1; },
    }));
    await expect(bridge.deliverBrowserPageDraft(browser())).rejects.toThrow("active Room");
    cleanup();
    expect(text).toBe("Existing draft");
    expect(effects).toBe(0);
  });

  test("immediate current-Room and new-Room handoffs require an explicit Human action", async () => {
    const current = { ...browser(), delivery: "send-current-room" as const };
    const events: string[] = [];
    const controller = createGenieHandoffController(makePorts(events));
    await expect(controller.deliver(current)).rejects.toThrow("explicit Human action");
    await expect(controller.deliver(mcp())).rejects.toThrow("explicit Human action");
    expect(events).toEqual([]);
  });

  test("delegates all three delivery branches in order", async () => {
    const draftEvents: string[] = [];
    await createGenieHandoffController(makePorts(draftEvents)).deliver(browser());
    expect(draftEvents).toEqual(["draft:https://example.com/guide\n\n> First line\n> Second line"]);

    const currentEvents: string[] = [];
    const current = { ...browser(), delivery: "send-current-room" as const };
    await createGenieHandoffController(makePorts(currentEvents)).deliver(current, { explicitHumanAction: true });
    expect(currentEvents).toEqual(["send:room-current:https://example.com/guide\n\n> First line\n> Second line"]);

    const newRoomEvents: string[] = [];
    await createGenieHandoffController(makePorts(newRoomEvents)).deliver(mcp(), { explicitHumanAction: true });
    expect(newRoomEvents).toEqual([
      "create",
      "send:room-new:Help me fix the local MCP connection.",
      "refresh",
      "open:room-new",
    ]);
  });

  test("uses source-aware new Room labels for generic supported delivery", async () => {
    const labels: string[] = [];
    const browserPorts = makePorts();
    browserPorts.apiClient = {
      createRoom: async ({ label }: { label: string }) => {
        labels.push(label);
        return { id: "browser-room" };
      },
      sendRoomMessage: async () => undefined,
    } as unknown as NautiloApiClient;
    await createGenieHandoffController(browserPorts).deliver(
      { ...browser(), delivery: "send-new-room" },
      { explicitHumanAction: true },
    );

    const mcpPorts = makePorts();
    mcpPorts.apiClient = {
      createRoom: async ({ label }: { label: string }) => {
        labels.push(label);
        return { id: "mcp-room" };
      },
      sendRoomMessage: async () => undefined,
    } as unknown as NautiloApiClient;
    await createGenieHandoffController(mcpPorts).deliver(mcp(), { explicitHumanAction: true });
    expect(labels).toEqual(["Ask Genie about this page", "Set up local MCP"]);
  });

  test("fails before effects for missing current Room or draft", async () => {
    const events: string[] = [];
    const missingRoom = makePorts(events);
    missingRoom.getCurrentRoomId = () => null;
    await expect(createGenieHandoffController(missingRoom).deliver(browser())).rejects.toThrow("active Room");
    expect(events).toEqual([]);

    const missingDraft = makePorts(events);
    delete missingDraft.appendCurrentRoomDraft;
    await expect(createGenieHandoffController(missingDraft).deliver(browser())).rejects.toThrow("draft is unavailable");
    expect(events).toEqual([]);
  });

  test("stops later effects at every ordinary port failure", async () => {
    const secret = "sk-do-not-echo-abcdefghijk";
    const createFailure = makePorts();
    createFailure.apiClient = {
      createRoom: async () => { throw new Error(secret); },
    } as unknown as NautiloApiClient;
    try {
      await createGenieHandoffController(createFailure).deliver(mcp(), { explicitHumanAction: true });
      throw new Error("Expected create failure.");
    } catch (error) {
      expect(error).toBeInstanceOf(GenieHandoffDeliveryError);
      expect((error as GenieHandoffDeliveryError).stage).toBe("create-room");
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }

    const sendEvents: string[] = [];
    const sendFailure = makePorts(sendEvents);
    sendFailure.apiClient = {
      createRoom: async () => { sendEvents.push("create"); return { id: "room-new" }; },
      sendRoomMessage: async () => { sendEvents.push("send"); throw new Error(secret); },
    } as unknown as NautiloApiClient;
    try {
      await createGenieHandoffController(sendFailure).deliver(mcp(), { explicitHumanAction: true });
      throw new Error("Expected send failure.");
    } catch (error) {
      expect(error).toBeInstanceOf(GenieHandoffDeliveryError);
      expect((error as GenieHandoffDeliveryError).stage).toBe("send-new-room");
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
    expect(sendEvents).toEqual(["create", "send"]);

    const currentEvents: string[] = [];
    const currentFailure = makePorts(currentEvents);
    currentFailure.apiClient = {
      sendRoomMessage: async () => { currentEvents.push("send"); throw new Error(secret); },
    } as unknown as NautiloApiClient;
    await expect(createGenieHandoffController(currentFailure).deliver(
      { ...browser(), delivery: "send-current-room" },
      { explicitHumanAction: true },
    )).rejects.toMatchObject({ name: "GenieHandoffDeliveryError", stage: "send-current-room" });
    expect(currentEvents).toEqual(["send"]);

    const refreshEvents: string[] = [];
    const refreshFailure = makePorts(refreshEvents);
    refreshFailure.refreshRooms = async () => { refreshEvents.push("refresh"); throw new Error(secret); };
    try {
      await createGenieHandoffController(refreshFailure).deliver(mcp(), { explicitHumanAction: true });
      throw new Error("Expected partial success.");
    } catch (error) {
      expect(error).toBeInstanceOf(GenieHandoffPartialSuccessError);
      expect((error as GenieHandoffPartialSuccessError).roomId).toBe("room-new");
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
    expect(refreshEvents).toEqual(["create", "send:room-new:Help me fix the local MCP connection.", "refresh"]);

    const navigateEvents: string[] = [];
    const navigateFailure = makePorts(navigateEvents);
    navigateFailure.setActiveRoom = () => { navigateEvents.push("open"); throw new Error(secret); };
    try {
      await createGenieHandoffController(navigateFailure).deliver(mcp(), { explicitHumanAction: true });
      throw new Error("Expected partial success.");
    } catch (error) {
      expect(error).toBeInstanceOf(GenieHandoffPartialSuccessError);
      expect((error as GenieHandoffPartialSuccessError).roomId).toBe("room-new");
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
    expect(navigateEvents).toEqual(["create", "send:room-new:Help me fix the local MCP connection.", "refresh", "open"]);
  });

  test("rejects unknown sources, keys, nested context, unsafe URLs, controls, and secret-shaped values", () => {
    const secret = "sk-do-not-echo-abcdefghijk";
    const base = browser();
    for (const input of [
      { ...base, source: "connections.google" },
      { ...base, version: 2 },
      { ...base, delivery: "not-a-delivery" },
      { ...base, context: { ...base.context, arbitrary: "no" } },
      { ...base, context: { url: { nested: "no" } } },
      { ...base, context: { url: "https://user:pass@example.com" } },
      { ...base, context: { url: "https://example.com/?token=abc" } },
      { ...base, context: { url: "https://example.com", selection: "bad\u0000text" } },
      { ...base, context: { url: "https://example.com", selection: secret } },
    ]) {
      expectThrow(() => parseWorkbenchGenieHandoff(input), secret);
    }
  });

  test("enforces source-specific selection, MCP, failure, and environment bounds", () => {
    expectThrow(() => buildBrowserPageGenieHandoff({
      intent: "Help.", context: { url: "https://example.com", selection: "x".repeat(4097) },
    }));
    expectThrow(() => buildLocalMcpGenieHandoff({ intent: "Help.", context: { mcpName: "bad name" } }));
    expectThrow(() => buildLocalMcpGenieHandoff({
      intent: "Help.", context: { failureCode: "approval_stale" as never },
    }));
    expectThrow(() => buildLocalMcpGenieHandoff({ intent: "Help.", context: { environmentNames: ["lowercase"] } }));
    expectThrow(() => buildLocalMcpGenieHandoff({
      intent: "Help.", context: { environmentNames: Array.from({ length: 65 }, (_, index) => `NAME_${index}`) },
    }));
    expectThrow(() => buildLocalMcpGenieHandoff({
      intent: "Help.",
      context: {
        environmentNames: Array.from(
          { length: 33 },
          (_, index) => `A${String(index).padStart(3, "0")}${"A".repeat(124)}`,
        ),
      },
    }));
    expect(buildLocalMcpGenieHandoff({
      intent: "Help.", context: { environmentNames: ["_A", "Z", "A", "Z"] },
    }).context.environmentNames).toBe("A\nZ\n_A");
  });

  test("inherits shared intent normalization, control, byte, and secret boundaries", () => {
    const context = { url: "https://example.com" };
    expectThrow(() => buildBrowserPageGenieHandoff({ intent: "e\u0301", context }));
    expectThrow(() => buildBrowserPageGenieHandoff({ intent: "bad\u0000intent", context }));
    expectThrow(() => buildBrowserPageGenieHandoff({ intent: "€".repeat(1366), context }));
    expectThrow(() => buildBrowserPageGenieHandoff({
      intent: "Bearer abcdefghijklmnop", context,
    }), "Bearer abcdefghijklmnop");
  });
});
