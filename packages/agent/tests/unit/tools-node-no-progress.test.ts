import { afterEach, expect, test } from "bun:test";
import { AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { z } from "zod";
import { browserDecisionPlanSchema } from "../../src/graph/browser-decision";
import type { NautiloState } from "../../src/agent/state";
import { toolsNode } from "../../src/nodes/tools";
import { registerAllTools } from "../../src/tools/register-all";
import {
  setRelayRegistry,
  type ToolRelayRegistry,
} from "../../src/tools/invocation-service";

afterEach(() => {
  setRelayRegistry(null);
  clearToolCatalog();
});

test("reports the exact contract when a requested browser delegation cannot start", async () => {
  const catalog = new ToolCatalog();
  registerAllTools(catalog);
  initToolCatalog(catalog);

  let dispatches = 0;
  setRelayRegistry({
    findByCapabilityForUser: () => ["relay-1"],
    getCapabilities: () => ({
      profile: "desktop-agent",
      canControlBrowser: true,
      browserSessionId: "browser-1",
    }),
    getUserId: () => "owner",
    getRelaySessionId: () => "socket-1",
    getDesktopSessionId: () => "desktop-1",
    getPairingGeneration: () => "pairing-1",
    isRelayHeartbeatFresh: () => true,
    dispatch: async () => {
      dispatches += 1;
      return { status: "ok", result: "must not dispatch" };
    },
  } as ToolRelayRegistry);

  const delegated = {
    id: "snapshot-delegated",
    name: "browser_snapshot",
    args: {
      goal: "Search for the exact product",
      actions: [{ kind: "click_observed" }],
      progress: [{ kind: "snapshot_contains", text: "Results" }],
      success: [{ kind: "snapshot_contains", text: "Found" }],
    },
    type: "tool_call" as const,
  };
  const batched = {
    id: "snapshot-extra",
    name: "browser_snapshot",
    args: {},
    type: "tool_call" as const,
  };
  const state = {
    messages: [new AIMessage({ content: "", tool_calls: [delegated, batched] })],
    approvedToolCalls: [delegated, batched],
    actorRole: "owner",
    userId: "owner",
    personaId: "owner",
    turnId: "turn",
    agentId: "agent",
    roomId: "room",
    activatedToolNames: [],
    activatedToolLeases: [],
    engagedSkillNames: [],
    memoryAccessEnvelope: null,
    relayCapabilities: { canControlBrowser: true, control_browser: true },
    requiredHostRelays: { [delegated.id]: "relay-1" },
    trustedExecutionEntrypoint: "foreground.main",
    verifiedOrdinaryOrigin: {
      kind: "local_electron",
      userId: "owner",
      actorId: "owner",
      relayId: "relay-1",
      desktopSessionId: "desktop-1",
      pairingGeneration: "pairing-1",
      requestId: "request-1",
    },
    browserDecision: null,
  } as unknown as NautiloState;

  const output = await toolsNode(state);

  expect(dispatches).toBe(0);
  const rejected = output.messages?.find((message) => ToolMessage.isInstance(message)
    && message.tool_call_id === delegated.id);
  expect(rejected?.content).toContain("decision_plan_requires_singleton");
  const feedback = output.messages?.find((message) => SystemMessage.isInstance(message));
  expect(feedback).toBeDefined();
  if (!feedback || typeof feedback.content !== "string") {
    throw new Error("expected string system feedback");
  }
  const contract = JSON.parse(feedback.content) as Record<string, unknown>;
  expect(contract).toMatchObject({
    error: "browser_delegation_not_started",
    browserRequestSent: null,
    issues: [],
  });
  expect(contract["expectedContract"]).toEqual(z.toJSONSchema(browserDecisionPlanSchema, { io: "input" }));
  expect(output.browserDecision).toBeNull();
});
