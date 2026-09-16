import { afterEach, expect, test } from "bun:test";
import { Command, MemorySaver, entrypoint } from "@langchain/langgraph";
import {
  createConnectedWebAccountActionTool,
  registerAllTools,
  resetConnectedWebAccountReadToolRuntimeForTests,
  setConnectedWebAccountActionToolRuntime,
  ToolCatalog,
} from "../src";
import { AgentToolCallTracker } from "../src/runtime-hooks";

afterEach(() => resetConnectedWebAccountReadToolRuntimeForTests());

test("connected website write refuses a missing exact delivery identity before runtime execution", async () => {
  setConnectedWebAccountActionToolRuntime({ act: async () => {
    throw new Error("must_not_run_without_delivery_id");
  } });
  const tool = createConnectedWebAccountActionTool({
    userId: "user", agentId: "agent", roomId: "room", callingRoomId: null,
    memoryAccessEnvelope: {} as never,
  });
  expect(await tool.invoke({
    account: "Nebius", action: "save_item", target: "item",
  })).toBe(JSON.stringify({ ok: false, code: "approval_required", recovery: "none" }));
});

test("connected website write projects a successful receipt without provider or live-browser fields", async () => {
  const deliveryIds: string[] = [];
  setConnectedWebAccountActionToolRuntime({ act: async (_actor, input) => {
    deliveryIds.push(input.deliveryId);
    return {
      ok: true, status: "completed", action: "save_item", target: "item",
      account: { id: "account", label: "Nebius", service: "Nebius", origin: "https://console.nebius.com", providerId: "provider", runId: "run", liveUrl: "https://live", cdpUrl: "wss://cdp" },
      receipt: { executionRef: "operation", effectState: "observed", postcondition: "saved", evidenceCode: "postcondition_observed", cost: { amountUsd: 0.1, state: "actual", providerId: "provider", runId: "run" } },
    } as never;
  } });
  const tool = createConnectedWebAccountActionTool({ userId: "user", agentId: "agent", roomId: "room", callingRoomId: null, memoryAccessEnvelope: {} as never });
  const serialized = await tool.invoke({ account: "Nebius", action: "save_item", target: "item" }, { configurable: { connectedWebActionDeliveryId: "exact-delivery" } });
  expect(deliveryIds).toEqual(["exact-delivery"]);
  expect(JSON.parse(serialized)).toEqual({
    ok: true, status: "completed", action: "save_item", target: "item",
    account: { id: "account", label: "Nebius", service: "Nebius", origin: "https://console.nebius.com" },
    receipt: { executionRef: "operation", effectState: "observed", postcondition: "saved", evidenceCode: "postcondition_observed", cost: { amountUsd: 0.1, state: "actual" } },
  });
});

test("connected website write rebuilds authentication intervention without provider capabilities", async () => {
  setConnectedWebAccountActionToolRuntime({ act: async () => ({
    ok: false, code: "authentication_required", recovery: "reconnect",
    intervention: { kind: "authentication_required", mode: "reconnect", reason: "mfa", account: { id: "account", label: "Nebius", service: "Nebius", origin: "https://console.nebius.com", providerId: "provider", runId: "run", liveUrl: "https://live", cdpUrl: "wss://cdp" } },
  } as never) });
  const tool = createConnectedWebAccountActionTool({ userId: "user", agentId: "agent", roomId: "room", callingRoomId: null, memoryAccessEnvelope: {} as never });
  const serialized = await tool.invoke({ account: "Nebius", action: "save_item", target: "item" }, { configurable: { connectedWebActionDeliveryId: "exact-delivery" } });
  expect(JSON.parse(serialized)).toEqual({
    ok: false, code: "authentication_required", recovery: "reconnect",
    intervention: { kind: "authentication_required", mode: "reconnect", reason: "mfa", account: { id: "account", label: "Nebius", service: "Nebius", origin: "https://console.nebius.com" } },
  });
});

test("a protected Cancel is consumed before replay can act on a newly connected profile", async () => {
  let actCalls = 0;
  let cancelCalls = 0;
  const intervention = {
    kind: "authentication_required" as const,
    mode: "connect" as const,
    reason: "not_connected" as const,
    target: { selector: "https://example.test" },
  };
  setConnectedWebAccountActionToolRuntime({
    act: async () => {
      actCalls++;
      return { ok: false, code: "authentication_required", recovery: "connect", intervention };
    },
    cancelAuthentication: async () => {
      cancelCalls++;
      return { ok: false, code: "not_found", recovery: "connect" };
    },
  });
  const tool = createConnectedWebAccountActionTool({
    userId: "user", agentId: "agent", roomId: "room", callingRoomId: null,
    memoryAccessEnvelope: {} as never,
  });
  const workflow = entrypoint({
    name: "connected-web-cancel-before-replay",
    checkpointer: new MemorySaver(),
  }, async (_input: unknown, config) => tool.invoke({
    account: "https://example.test", action: "save_item", target: "item",
  }, config));
  const base = {
    configurable: {
      thread_id: "connected-web-cancel-before-replay",
      connectedWebActionDeliveryId: "exact-delivery",
    },
  };
  const first: unknown = await workflow.invoke("start", base);
  expect(first).toMatchObject({ __interrupt__: [{ value: { toolCallId: "exact-delivery" } }] });

  const result = await workflow.invoke(new Command({
    resume: { toolCallId: "exact-delivery", decision: "cancel" },
  }), {
    configurable: {
      ...base.configurable,
      connectedWebActionResumeContext: {
        version: "connected-web-action-resume-v1",
        toolCallId: "exact-delivery",
        userId: "user",
        intervention,
      },
    },
  });

  expect(JSON.parse(String(result))).toEqual({ ok: false, code: "cancelled", recovery: "none" });
  expect(actCalls).toBe(1);
  expect(cancelCalls).toBe(1);
});

test("a protected Cancel preserves an action that completed before cancellation", async () => {
  const intervention = {
    kind: "authentication_required" as const,
    mode: "connect" as const,
    reason: "not_connected" as const,
    target: { selector: "https://example.test" },
  };
  setConnectedWebAccountActionToolRuntime({
    act: async () => ({
      ok: false, code: "authentication_required", recovery: "connect", intervention,
    }),
    cancelAuthentication: async () => ({
      ok: true,
      status: "completed",
      action: "save_item",
      target: "item",
      account: {
        id: "account",
        label: "Example",
        service: "Example",
        origin: "https://example.test",
      },
      receipt: {
        executionRef: "operation",
        effectState: "observed",
        postcondition: "saved",
        evidenceCode: "postcondition_observed",
        cost: { amountUsd: 0.1, state: "actual" },
      },
    }),
  });
  const tool = createConnectedWebAccountActionTool({
    userId: "user", agentId: "agent", roomId: "room", callingRoomId: null,
    memoryAccessEnvelope: {} as never,
  });
  const workflow = entrypoint({
    name: "connected-web-cancel-completed-race",
    checkpointer: new MemorySaver(),
  }, async (_input: unknown, config) => tool.invoke({
    account: "https://example.test", action: "save_item", target: "item",
  }, config));
  const configurable = {
    thread_id: "connected-web-cancel-completed-race",
    connectedWebActionDeliveryId: "exact-delivery",
  };
  await workflow.invoke("start", { configurable });

  const result = await workflow.invoke(new Command({
    resume: { toolCallId: "exact-delivery", decision: "cancel" },
  }), {
    configurable: {
      ...configurable,
      connectedWebActionResumeContext: {
        version: "connected-web-action-resume-v1",
        toolCallId: "exact-delivery",
        userId: "user",
        intervention,
      },
    },
  });

  expect(JSON.parse(String(result))).toMatchObject({
    ok: true,
    status: "completed",
    receipt: { effectState: "observed" },
  });
});

test("a protected Done resumes the exact first-connect delivery once", async () => {
  let actCalls = 0;
  const intervention = {
    kind: "authentication_required" as const,
    mode: "connect" as const,
    reason: "not_connected" as const,
    target: { selector: "https://example.test" },
  };
  setConnectedWebAccountActionToolRuntime({
    act: async () => {
      actCalls++;
      return actCalls === 1
        ? { ok: false as const, code: "authentication_required" as const, recovery: "connect" as const, intervention }
        : {
          ok: true as const, status: "completed" as const, action: "save_item" as const, target: "item",
          account: { id: "account", label: "Example", service: "Example", origin: "https://example.test" },
          receipt: { executionRef: "operation", effectState: "observed" as const, postcondition: "saved", evidenceCode: "observed", cost: { amountUsd: 0.1, state: "actual" as const } },
        };
    },
  });
  const tool = createConnectedWebAccountActionTool({
    userId: "user", agentId: "agent", roomId: "room", callingRoomId: null,
    memoryAccessEnvelope: {} as never,
  });
  const workflow = entrypoint({
    name: "connected-web-done-once",
    checkpointer: new MemorySaver(),
  }, async (_input: unknown, config) => tool.invoke({
    account: "https://example.test", action: "save_item", target: "item",
  }, config));
  const base = {
    configurable: {
      thread_id: "connected-web-done-once",
      connectedWebActionDeliveryId: "exact-delivery",
    },
  };
  await workflow.invoke("start", base);
  const result = await workflow.invoke(new Command({
    resume: { toolCallId: "exact-delivery", decision: "done" },
  }), {
    configurable: {
      ...base.configurable,
      connectedWebActionResumeContext: {
        version: "connected-web-action-resume-v1",
        toolCallId: "exact-delivery",
        userId: "user",
        intervention,
      },
    },
  });

  expect(JSON.parse(String(result))).toMatchObject({ ok: true, status: "completed" });
  expect(actCalls).toBe(2);
});

test("connected website write fails closed when a malformed runtime success is not observed save_item completion", async () => {
  setConnectedWebAccountActionToolRuntime({ act: async () => ({
    ok: true, status: "working", action: "delete_item", target: "item",
    account: { id: "account", label: "Nebius", service: "Nebius", origin: "https://console.nebius.com" },
    receipt: { executionRef: "operation", effectState: "ambiguous", postcondition: "saved", evidenceCode: "bad", cost: { amountUsd: 0.1, state: "actual" } },
  } as never) });
  const tool = createConnectedWebAccountActionTool({ userId: "user", agentId: "agent", roomId: "room", callingRoomId: null, memoryAccessEnvelope: {} as never });
  expect(await tool.invoke({ account: "Nebius", action: "save_item", target: "item" }, { configurable: { connectedWebActionDeliveryId: "exact-delivery" } }))
    .toBe(JSON.stringify({ ok: false, code: "invalid_result", recovery: "none" }));
});

test("requested website save is capability-gated without a duplicate confirmation", () => {
  const catalog = new ToolCatalog();
  registerAllTools(catalog);
  expect(catalog.get("act_connected_web_account")).toMatchObject({
    category: "integrations",
    trustTier: "high",
    impact: "high",
    exposure: "discoverable",
    requiredCapabilities: ["use_connections"],
    requiresApproval: false,
  });
});

test("connected website read supervision and basic direct control never prompt again", () => {
  const catalog = new ToolCatalog();
  registerAllTools(catalog);
  for (const name of ["manage_connected_web_operation", "control_connected_web_operation"]) {
    expect(catalog.get(name)).toMatchObject({
      category: "integrations",
      trustTier: "high",
      impact: "low",
      exposure: "core",
      // Public operation management checks its initiating room authority;
      // direct saved-account control still requires Connections.
      requiredCapabilities: name === "manage_connected_web_operation" ? [] : ["use_connections"],
      requiresApproval: false,
    });
  }
  expect(catalog.get("act_connected_web_account")).toMatchObject({
    impact: "high",
    requiresApproval: false,
  });
});

test("connected website action lifecycle args remain bounded valid JSON for a long target", () => {
  const tracker = new AgentToolCallTracker();
  const event = tracker.toolStart("action-call", "act_connected_web_account", {
    account: "A".repeat(2_048), action: "save_item", target: "x".repeat(1_024),
    ignoredProviderField: "must-not-appear",
  });
  expect(event.argsSummary).toBeDefined();
  const projected: unknown = JSON.parse(event.argsSummary!);
  expect(projected).toEqual({
    account: "A".repeat(2_048), action: "save_item", target: "x".repeat(1_024),
  });
  expect(event.argsSummary).not.toContain("ignoredProviderField");
});
