/**
 * D516 3.6.14 production-node characterization.
 *
 * This runs the real signed catalogue registration, tools node, invocation
 * service, Relay request construction, LangGraph tasks, and MemorySaver. Only
 * the external Relay/Host response and Live Shadow port are deterministic
 * fixtures. It is not live Host, provider, Postgres, or release evidence.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import { MemorySaver } from "@langchain/langgraph";
import type { RelayDispatchRequest, RelayDispatchResult } from "@nautilo/relay";
import type { NautiloState } from "../../src/agent/state";
import { COMPUTER_RESULT_DURABLE_SIDECAR_KEY } from "../../src/tools/computer/model-result-projector";
import { bundledComputerUseContractCatalogue } from "../../src/config/computer-use-catalogue/catalog";
import {
  configureRuntimeComputerUseContractCatalogue,
  refreshRuntimeComputerUseContractCatalogue,
  resetRuntimeComputerUseContractCatalogue,
} from "../../src/config/computer-use-catalogue/runtime-catalogue";
import { canonicalComputerUseContractCatalogueSigningPayloadV1 } from "../../src/config/computer-use-catalogue/schema";
import {
  d516BindingFor as bindingFor,
  d516GraphFor as graphFor,
  d516HostResult as hostResult,
  d516ReadCall as call,
  d516StateFor as stateFor,
  setD516RelayDispatch,
  setupD516ProductionReadFixture,
  teardownD516ProductionReadFixture,
} from "../support/d516-production-read-fixture";

const actualDb = await import("@nautilo/db");
mock.module("@nautilo/db", () => ({
  ...actualDb,
  getCachedServerModelConfigRow: () => null,
}));

beforeAll(async () => {
  await setupD516ProductionReadFixture();
});

afterAll(async () => {
  await teardownD516ProductionReadFixture();
  mock.restore();
});

async function rejectionMessage(operation: PromiseLike<unknown>): Promise<string> {
  try { await operation; } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected operation to reject");
}

async function activateCatalogue(
  revisionOffset: number,
  mutate: (contracts: Array<Record<string, unknown>>) => Array<Record<string, unknown>>,
): Promise<void> {
  const keys = generateKeyPairSync("ed25519");
  const snapshot = JSON.parse(JSON.stringify(bundledComputerUseContractCatalogue)) as Record<string, unknown>;
  delete snapshot["provenance"];
  const [date, revision] = bundledComputerUseContractCatalogue.catalogueVersion.split(".");
  snapshot["catalogueVersion"] = `${date}.${Number(revision) + revisionOffset}`;
  snapshot["publishedAt"] = new Date(Date.parse(bundledComputerUseContractCatalogue.publishedAt) + revisionOffset * 1_000).toISOString();
  snapshot["contracts"] = mutate(snapshot["contracts"] as Array<Record<string, unknown>>);
  const artifactText = JSON.stringify(snapshot);
  const artifactSha256 = createHash("sha256").update(artifactText).digest("hex");
  const pointer = {
    catalogueVersion: snapshot["catalogueVersion"],
    artifactSha256,
    signingKeyId: "parallel-read-test",
    signature: sign(
      null,
      Buffer.from(canonicalComputerUseContractCatalogueSigningPayloadV1(
        snapshot["catalogueVersion"] as string,
        artifactSha256,
      )),
      keys.privateKey,
    ).toString("base64"),
  };
  let request = 0;
  configureRuntimeComputerUseContractCatalogue({
    pointerUrl: "https://catalogue.example.test/latest.json",
    allowedHosts: ["catalogue.example.test"],
    trustedKeys: {
      "parallel-read-test": keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    },
    fetchImpl: (async () => new Response(
      request++ === 0 ? JSON.stringify(pointer) : artifactText,
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch,
  });
  const result = await refreshRuntimeComputerUseContractCatalogue();
  expect(result.source).toBe("remote-fresh");
}

test("real tools node overlaps a coordinated read wave and preserves ordered protected state", async () => {
  const first = call("call:first");
  const second = call("call:second");
  const barrier = call("call:mutate", "computer_do", {
    operation: { kind: "launch_app", app: { name: "TextEdit" } },
  });
  const calls = [first, second, barrier];
  const pending = new Map<string, Readonly<{
    request: RelayDispatchRequest;
    resolve: (value: RelayDispatchResult) => void;
  }>>();
  const started: string[] = [];
  let markBothStarted!: () => void;
  const bothStarted = new Promise<void>((resolve) => { markBothStarted = resolve; });
  setD516RelayDispatch(async (request) => {
    const invocationId = request.desktopAutomationBinding!.computerUseInvocationId;
    started.push(invocationId);
    if (started.length === 2) markBothStarted();
    return await new Promise<RelayDispatchResult>((resolve) => {
      pending.set(invocationId, { request, resolve });
    });
  });
  let assistantProtections = 0;
  const resultProtections: string[] = [];
  const graph = graphFor(new MemorySaver(), () => ({
    protectAssistantToolCall: async (message: AIMessage) => { assistantProtections += 1; return message; },
    protectToolResult: async (message: ToolMessage) => {
      resultProtections.push(message.tool_call_id);
      message.additional_kwargs = { ...message.additional_kwargs, protected_fixture: true };
      return message;
    },
  }));
  const config = { configurable: { thread_id: "d516-production-parallel-order" } };
  const running = graph.invoke(stateFor(calls), config);
  await bothStarted;
  const firstInvocation = bindingFor(first).computerUseInvocationId;
  const secondInvocation = bindingFor(second).computerUseInvocationId;
  const secondPending = pending.get(secondInvocation)!;
  secondPending.resolve({ status: "ok", result: hostResult(secondPending.request, "second") });
  const firstPending = pending.get(firstInvocation)!;
  firstPending.resolve({ status: "ok", result: hostResult(firstPending.request, "first") });
  const output = await running as NautiloState;

  expect(started).toHaveLength(2);
  expect(output.approvedToolCalls).toEqual([barrier]);
  expect(output.computerUseInvocationBindings).toEqual({ [barrier.id!]: bindingFor(barrier) });
  const messages = output.messages.filter((message) => ToolMessage.isInstance(message));
  expect(messages.map((message) => message.tool_call_id)).toEqual([first.id!, second.id!]);
  expect(messages.every((message) => typeof message.id === "string" && message.id.length > 0)).toBe(true);
  expect(messages.every((message) => message.additional_kwargs?.["protected_fixture"] === true)).toBe(true);
  expect(messages.every((message) => COMPUTER_RESULT_DURABLE_SIDECAR_KEY in (message.additional_kwargs ?? {}))).toBe(true);
  expect(output.engagedSkillNames).toEqual(["computer-use"]);
  expect(output.activatedToolNames).toEqual(["run_shell"]);
  expect(output.activatedToolLeases).toEqual([{ name: "run_shell", idleTurns: 2 }]);
  expect(assistantProtections).toBe(1);
  expect(resultProtections).toEqual([second.id!, first.id!]);
});

test("Strict Shadow requires every assistant call in a read wave before any dispatch", async () => {
  const calls = [call("strict:first"), call("strict:second")];
  let dispatches = 0;
  setD516RelayDispatch(async () => {
    dispatches += 1;
    return { status: "error", error: "must not dispatch" };
  });
  for (const scenario of ["missing-boundary", "missing-peer"] as const) {
    const boundary = scenario === "missing-boundary" ? undefined : () => ({
      protectAssistantToolCall: async () => new AIMessage({ content: "", tool_calls: [calls[0]!] }),
      protectToolResult: async (message: ToolMessage) => message,
    });
    const graph = graphFor(new MemorySaver(), boundary, true);
    expect(await rejectionMessage(graph.invoke(stateFor(calls), {
      configurable: { thread_id: `d516-strict-wave-${scenario}` },
    }))).toContain("Strict Shadow tool protection is required");
  }
  expect(dispatches).toBe(0);
});

test("missing binding, at-most-once Computer Use, and ordinary tools remain serial barriers", async () => {
  const following = call("call:following");
  const cases = [
    {
      name: "missing-binding",
      calls: [call("call:missing"), following],
      bound: [following],
      expectedDispatches: 0,
    },
    {
      name: "at-most-once",
      calls: [call("call:mutation", "computer_do", {
        operation: { kind: "launch_app", app: { name: "TextEdit" } },
      }), following],
      bound: undefined,
      expectedDispatches: 1,
    },
    {
      name: "ordinary",
      calls: [call("call:ordinary", "skip", {}), following],
      bound: [following],
      expectedDispatches: 0,
    },
    {
      name: "idless",
      calls: [{ name: "computer_observe", args: { operation: "desktop_state" }, type: "tool_call" }, following],
      bound: [following],
      expectedDispatches: 0,
    },
  ] as const;

  for (const item of cases) {
    let dispatches = 0;
    setD516RelayDispatch(async () => {
      dispatches += 1;
      return { status: "error", error: "serial fixture" };
    });
    const graph = graphFor(new MemorySaver());
    const initial = stateFor(item.calls, item.bound ?? item.calls);
    const output = await graph.invoke(initial, {
      configurable: { thread_id: `d516-production-serial-${item.name}` },
    }) as NautiloState;

    expect(output.approvedToolCalls).toEqual([following]);
    expect(output.messages.filter((message) => ToolMessage.isInstance(message))).toHaveLength(1);
    expect(dispatches).toBe(item.expectedDispatches);
  }
});

test("an older v1 catalogue without scheduling metadata remains accepted and serial", async () => {
  const first = call("call:old-v1-first");
  const second = call("call:old-v1-second");
  let dispatches = 0;
  setD516RelayDispatch(async (request) => {
    dispatches += 1;
    return { status: "ok", result: hostResult(request, "old-v1") };
  });
  try {
    await activateCatalogue(1, (contracts) => contracts.map((entry) => {
      const copy = { ...entry };
      delete copy["scheduling"];
      return copy;
    }));
    const output = await graphFor(new MemorySaver()).invoke(stateFor([first, second]), {
      configurable: { thread_id: "d516-production-old-v1-serial" },
    }) as NautiloState;
    expect(dispatches).toBe(1);
    expect(output.approvedToolCalls).toEqual([second]);
    expect(output.messages.filter((message) => ToolMessage.isInstance(message))
      .map((message) => message.tool_call_id)).toEqual([first.id!]);
  } finally {
    resetRuntimeComputerUseContractCatalogue();
  }
});

test("a protected sibling is durable when the other result protection fails terminally", async () => {
  const first = call("call:replay-first");
  const second = call("call:replay-second");
  const dispatches = new Map<string, number>();
  setD516RelayDispatch(async (request) => {
    const invocationId = request.desktopAutomationBinding!.computerUseInvocationId;
    dispatches.set(invocationId, (dispatches.get(invocationId) ?? 0) + 1);
    return { status: "ok", result: hostResult(request, invocationId) };
  });
  let assistantProtections = 0;
  const resultProtections = new Map<string, number>();
  let failSecond = true;
  const { LiveShadowToolProtectionTerminalError } = await import("../../src/nodes/tools");
  const graph = graphFor(new MemorySaver(), () => ({
    protectAssistantToolCall: async (message: AIMessage) => {
      assistantProtections += 1;
      return message;
    },
    protectToolResult: async (message: ToolMessage) => {
      const id = message.tool_call_id;
      resultProtections.set(id, (resultProtections.get(id) ?? 0) + 1);
      if (id === second.id && failSecond) throw new LiveShadowToolProtectionTerminalError();
      return message;
    },
  }));
  const config = { configurable: { thread_id: "d516-production-shadow-replay" } };

  expect(await rejectionMessage(graph.invoke(stateFor([first, second]), config)))
    .toContain("Live Shadow tool protection failed terminally");
  failSecond = false;
  const resumed = await graph.invoke(null, config) as NautiloState;

  expect(resumed.approvedToolCalls).toEqual([]);
  expect(resumed.messages.filter((message) => ToolMessage.isInstance(message))
    .map((message) => message.tool_call_id)).toEqual([first.id!, second.id!]);
  expect(assistantProtections).toBe(1);
  expect(dispatches.get(bindingFor(first).computerUseInvocationId)).toBe(1);
  expect(dispatches.get(bindingFor(second).computerUseInvocationId)).toBe(2);
  expect(resultProtections.get(first.id!)).toBe(1);
  expect(resultProtections.get(second.id!)).toBe(2);
});

test("a resumed read wave reuses canonical protection but refuses a removed signed catalogue entry", async () => {
  const first = call("call:catalogue-first");
  const second = call("call:catalogue-second");
  const dispatches = new Map<string, number>();
  setD516RelayDispatch(async (request) => {
    const invocationId = request.desktopAutomationBinding!.computerUseInvocationId;
    dispatches.set(invocationId, (dispatches.get(invocationId) ?? 0) + 1);
    return { status: "ok", result: hostResult(request, invocationId) };
  });
  const protectedAssistantCalls: ToolCall[][] = [];
  const resultProtections = new Map<string, number>();
  let failSecond = true;
  const { LiveShadowToolProtectionTerminalError } = await import("../../src/nodes/tools");
  const graph = graphFor(new MemorySaver(), () => ({
    protectAssistantToolCall: async (message: AIMessage) => {
      protectedAssistantCalls.push([...(message.tool_calls ?? [])]);
      return message;
    },
    protectToolResult: async (message: ToolMessage) => {
      const id = message.tool_call_id;
      resultProtections.set(id, (resultProtections.get(id) ?? 0) + 1);
      if (id === second.id && failSecond) throw new LiveShadowToolProtectionTerminalError();
      return message;
    },
  }));
  const config = { configurable: { thread_id: "d516-production-catalogue-replacement" } };

  expect(await rejectionMessage(graph.invoke(stateFor([first, second]), config)))
    .toContain("Live Shadow tool protection failed terminally");
  failSecond = false;
  try {
    await activateCatalogue(2, (contracts) => contracts
      .filter((entry) => (entry["descriptor"] as Record<string, unknown>)["contractId"] !== "native.observe"));
    expect(await rejectionMessage(graph.invoke(null, config)))
      .toContain("Computer Use read contract changed before dispatch");
  } finally {
    resetRuntimeComputerUseContractCatalogue();
  }

  expect(protectedAssistantCalls).toHaveLength(1);
  expect(protectedAssistantCalls[0]!.map((item) => [item.id, item.name])).toEqual([
    [first.id, first.name],
    [second.id, second.name],
  ]);
  expect(dispatches.get(bindingFor(first).computerUseInvocationId)).toBe(1);
  expect(dispatches.get(bindingFor(second).computerUseInvocationId)).toBe(1);
  expect(resultProtections.get(first.id!)).toBe(1);
  expect(resultProtections.get(second.id!)).toBe(1);
});
