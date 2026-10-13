import { afterEach, describe, expect, mock, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { getUsageContext } from "../../src/usage/usage-context";
import { setConfigOverrides } from "@nautilo/config";
import { createMemoryReviewStaging, type MemoryReviewStagingPorts } from "../../src/memory/memory-review-staging";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import type { MemoryDetail } from "../../src/store/memory-store";
import { MemoryProviderOutcomeUnknownError } from "../../src/utils/chat-model-invocation";

const envelope: MemoryAccessEnvelope = { ownerId: "human", actorId: "actor", agentId: "agent", roomId: "room", readableNamespaces: ["ns"], mutableNamespaces: ["ns"], writableNamespaces: ["ns"], toolPolicy: {} };
const embedding = { vector: [1, 0], provider: "openai" as const, canonicalModel: "model-a", dimensions: 2, contractVersion: 1 as const };
let createCount = 0;
let activePorts: MemoryReviewStagingPorts;
mock.module("../../src/memory/memory-review-publication", () => ({
  createOrdinaryMemoryReviewStaging: async (workId: string) => {
    createCount += 1;
    const staging = createMemoryReviewStaging(workId, activePorts);
    return { ...staging, prepared: () => ({ ...staging.prepared(), envelope, speakerUserId: envelope.ownerId }) };
  },
}));
mock.module("../../src/providers/universal", () => ({
  createUniversalModel: async (_modelId: string, options?: Record<string, unknown>) => ({
    bindTools: () => ({ invoke: async () => {
      if (options?.["useOpenAIResponsesApi"] !== true || options["reasoningOutput"] !== true) throw new Error("function tools require Responses with reasoning");
      return new AIMessage("Nothing to save.");
    } }),
  }),
}));
const { prepareMemoryReview } = await import("../../src/memory/background-reviewer");
const { runExitFlush } = await import("../../src/memory/exit-flush");
afterEach(() => setConfigOverrides({}));
function setup() {
  createCount = 0;
  activePorts = { read: async () => null, search: async () => [], embed: async () => embedding, findSaveTarget: async () => null, dedupThreshold: 0.9 };
  setConfigOverrides({ nautilo_reviewer_max_iterations: 3 });
}
function model(responses: BaseMessage[]) {
  return async () => { const response = responses.shift(); if (!response) throw new Error("unexpected model call"); return response; };
}
function memory(id = "memory-1", content = "Original fact"): MemoryDetail & {
  type: string;
  content: string;
} {
  return {
    id, type: "fact", content, importance: 0.5, tier: 1,
    createdAt: new Date(0), updatedAt: new Date(0), demotedAt: null,
    demotedFrom: null, namespaceIds: ["ns"],
  };
}
describe("Memory transform completion", () => {
  test("reviews complete supplied assistant and tool evidence, with stable staged writes", async () => {
    setup();
    let firstPrompt = "";
    const invoke = model([new AIMessage({ content: "", tool_calls: [{ id: "provider-random", name: "manage_memory", args: { action: "save", content: "Prefers short replies", type: "preference" } }] }), new AIMessage("Done.")]);
    const result = await prepareMemoryReview([new HumanMessage("Remember"), new AIMessage("Completed response"), new ToolMessage({ content: "Actual result", tool_call_id: "tool" })], {
      workId: "work", attemptId: "attempt", modelId: "configured-model", memoryAccessEnvelope: envelope,
      invokeModel: async (input) => { firstPrompt ||= JSON.stringify(input.messages[0]!.content); return invoke(); },
    });
    expect(firstPrompt).toContain("Completed response");
    expect(firstPrompt).toContain("Actual result");
    expect(result.status).toBe("prepared");
    if (result.status === "prepared") expect(result.proposal.operations[0]?.operationId).toBe("work:mutation:0");
  });
  test("standalone tool reviews opt into the reasoning-capable Responses transport", async () => {
    setup();
    expect(await prepareMemoryReview([], {
      workId: "work", modelId: "openai:gpt-5.6-luna", memoryAccessEnvelope: envelope,
    })).toMatchObject({ status: "prepared", modelId: "openai:gpt-5.6-luna" });
  });
  test("only explicit successful no-change completes an empty proposal", async () => {
    setup();
    const options = { workId: "work", modelId: "model", memoryAccessEnvelope: envelope };
    const good = await prepareMemoryReview([], { ...options, invokeModel: model([new AIMessage("Nothing to save.")]) });
    expect(good.status).toBe("prepared");
    if (good.status === "prepared") expect(good.proposal.operations).toEqual([]);
    expect(await prepareMemoryReview([], { ...options, invokeModel: model([new AIMessage("")]) })).toMatchObject({ status: "failed", reason: "invalid_proposal" });
  });
  test("reports content-free exposure before the next paid call and publication", async () => {
    setup();
    const existing = memory();
    activePorts.read = async () => existing;
    activePorts.search = async () => [{ ...existing, score: 1 }];
    const observations: unknown[] = [];
    const result = await prepareMemoryReview([], {
      workId: "work", modelId: "model", memoryAccessEnvelope: envelope,
      onModelExposure: (snapshots) => { observations.push(snapshots); },
      invokeModel: model([
        new AIMessage({ content: "", tool_calls: [{
          name: "search_memory", args: { query: "fact" },
        }] }),
        new AIMessage("Nothing to save."),
      ]),
    });
    expect(result.status).toBe("prepared");
    expect(observations).toHaveLength(3);
    expect(observations[0]).toEqual([]);
    expect(observations[1]).toEqual([expect.objectContaining({ memoryId: existing.id })]);
    expect(observations[2]).toEqual(observations[1]);
    expect(JSON.stringify(observations)).not.toContain(existing.content);
  });
  test("freezes canonical initial and retrieved dependencies on prepared writes", async () => {
    setup();
    const existing = memory();
    activePorts.read = async () => existing;
    activePorts.search = async () => [{ ...existing, score: 1 }];
    const initial = {
      kind: "source" as const,
      sourceKind: "message",
      logicalSourceRef: "message:41",
      observedRevision: "3",
      observedContentFingerprint: "sha256:message",
      terminalAuthorityLeafHandle: "ns",
    };
    const retrieved = {
      kind: "source" as const,
      sourceKind: "memory",
      logicalSourceRef: "memory:10000000-0000-4000-8000-000000000001",
      observedRevision: "5",
      observedContentFingerprint: "hmac-sha256:memory",
      terminalAuthorityLeafHandle: "ns",
    };
    const result = await prepareMemoryReview([], {
      workId: "work",
      modelId: "model",
      memoryAccessEnvelope: envelope,
      modelExposureDependencies: [initial],
      resolveMemoryExposureDependencies: async (snapshots) =>
        snapshots.length === 0 ? [] : [retrieved],
      invokeModel: model([
        new AIMessage({ content: "", tool_calls: [{
          name: "search_memory", args: { query: "fact" },
        }] }),
        new AIMessage({ content: "", tool_calls: [{
          name: "manage_memory",
          args: { action: "save", content: "New fact" },
        }] }),
        new AIMessage("Done."),
      ]),
    });

    expect(result.status).toBe("prepared");
    if (result.status !== "prepared") throw new Error("expected preparation");
    expect(result.proposal.operations).toHaveLength(1);
    expect(result.proposal.modelExposureDependencies).toEqual([
      retrieved,
      initial,
    ]);
  });
  test("stops before the next model call when retrieved Memory changes", async () => {
    setup();
    const existing = memory();
    let reads = 0;
    activePorts.read = async () => {
      reads += 1;
      return reads === 1 ? existing : { ...existing, content: "Changed" };
    };
    activePorts.search = async () => [{ ...existing, score: 1 }];
    let modelCalls = 0;
    const result = await prepareMemoryReview([], {
      workId: "work", modelId: "model", memoryAccessEnvelope: envelope,
      invokeModel: async () => {
        modelCalls += 1;
        return new AIMessage({ content: "", tool_calls: [{
          name: "search_memory", args: { query: "fact" },
        }] });
      },
    });
    expect(result).toMatchObject({ status: "failed", reason: "source_changed" });
    expect(modelCalls).toBe(1);
  });
  test("iteration exhaustion discards staged writes instead of reporting no-change", async () => {
    setup();
    const result = await prepareMemoryReview([], { workId: "work", modelId: "model", memoryAccessEnvelope: envelope, maxIterations: 1,
      invokeModel: model([new AIMessage({ content: "", tool_calls: [{ name: "manage_memory", args: { action: "save", content: "Fact" } }] })]),
    });
    expect(result).toMatchObject({ status: "failed", reason: "iteration_exhausted" });
    expect(result).not.toHaveProperty("proposal");
  });
  test("denied targets, embedding and provider failures expose content-free reasons", async () => {
    setup();
    const options = { workId: "work", modelId: "model", memoryAccessEnvelope: envelope };
    const denied = await prepareMemoryReview([], { ...options, invokeModel: model([new AIMessage({ content: "", tool_calls: [{ name: "manage_memory", args: { action: "remove", memory_id: "denied" } }] })]) });
    expect(denied).toMatchObject({ status: "failed", reason: "memory_unavailable" });
    activePorts.embed = async () => { throw new Error("secret provider body"); };
    const embedding = await prepareMemoryReview([], { ...options, invokeModel: model([new AIMessage({ content: "", tool_calls: [{ name: "manage_memory", args: { action: "save", content: "Fact" } }] })]) });
    expect(embedding).toMatchObject({ status: "failed", reason: "embedding_failed" });
    const provider = await prepareMemoryReview([], { ...options, invokeModel: async () => { throw new Error("secret provider body"); } });
    expect(provider).toMatchObject({ status: "failed", reason: "provider_failed" });
    const uncertain = await prepareMemoryReview([], { ...options, invokeModel: async () => { throw new MemoryProviderOutcomeUnknownError(); } });
    expect(uncertain).toMatchObject({ status: "failed", reason: "provider_outcome_unknown" });
    expect(JSON.stringify(provider)).not.toContain("secret");
  });
  test("cancelled attempts do not open staging or accept late model responses", async () => {
    setup();
    const controller = new AbortController(); controller.abort();
    expect(await prepareMemoryReview([], { workId: "work", modelId: "model", memoryAccessEnvelope: envelope, signal: controller.signal })).toMatchObject({ status: "failed", reason: "cancelled" });
    expect(createCount).toBe(0);
    const late = new AbortController();
    expect(await prepareMemoryReview([], { workId: "work", modelId: "model", memoryAccessEnvelope: envelope, signal: late.signal,
      invokeModel: async () => { late.abort(); return new AIMessage("Nothing to save."); },
    })).toMatchObject({ status: "failed", reason: "cancelled" });
  });
  test("exit flush preserves its enable and minimum turns and prepares through the same transform", async () => {
    setup();
    setConfigOverrides({ nautilo_exit_flush_enabled: true, nautilo_flush_min_turns: 2 });
    const options = { workId: "flush", modelId: "flush-model", memoryAccessEnvelope: envelope, invokeModel: model([new AIMessage("Nothing to save.")]) };
    expect(await runExitFlush([new HumanMessage("one")], options)).toEqual({ status: "skipped", turns: 1 });
    expect((await runExitFlush([new HumanMessage("one"), new HumanMessage("two")], options)).status).toBe("prepared");
  });
  test("embedding work inherits Room, Agent and attempt cost correlation", async () => {
    setup();
    const contexts: unknown[] = [];
    activePorts.embed = async () => { contexts.push(getUsageContext()); return embedding; };
    await prepareMemoryReview([], { workId: "work", attemptId: "attempt", modelId: "model", memoryAccessEnvelope: envelope,
      invokeModel: model([new AIMessage({ content: "", tool_calls: [{ name: "manage_memory", args: { action: "save", content: "Fact" } }] }), new AIMessage("Done.")]),
    });
    expect(contexts).toEqual([{ callType: "memory_review", userId: "human", roomId: "room", metadata: { workId: "work", attemptId: "attempt", agentId: "agent" } }]);
    expect(getUsageContext()).toBeUndefined();
  });

});
