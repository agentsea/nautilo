import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { AIMessage, ToolMessage, type BaseMessage, type BaseMessageLike } from "@langchain/core/messages";
import type {
  ProtectedAgentMemoryEmbeddingPort,
} from "@nautilo/lattice-bridge";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import type { ChatModel } from "../../src/providers/types";
import type { Configuration } from "../../src/subagents/deep-research/shared/config";
import {
  createMemoryReviewStaging,
  type MemoryReviewStagingPorts,
} from "../../src/memory/memory-review-staging";
import { runWithUsageContext } from "../../src/usage/usage-context";

const memoryEnvelope: MemoryAccessEnvelope = {
  ownerId: "human",
  actorId: "actor",
  agentId: "agent",
  roomId: "room",
  readableNamespaces: ["namespace"],
  mutableNamespaces: ["namespace"],
  writableNamespaces: ["namespace"],
  toolPolicy: {},
};
const memoryEmbedding = {
  vector: [1, 0],
  provider: "openai" as const,
  canonicalModel: "test-embedding",
  dimensions: 2,
  contractVersion: 1 as const,
};
let memoryPorts: MemoryReviewStagingPorts;

mock.module("../../src/memory/memory-review-publication", () => ({
  createOrdinaryMemoryReviewStaging: async (workId: string) => {
    const staging = createMemoryReviewStaging(workId, memoryPorts);
    return {
      ...staging,
      prepared: () => ({
        ...staging.prepared(),
        envelope: memoryEnvelope,
        speakerUserId: memoryEnvelope.ownerId,
      }),
    };
  },
}));

let providerReplies: AIMessage[] = [];
const providerInputs: BaseMessageLike[][] = [];
mock.module("../../src/providers/universal", () => ({
  createUniversalModel: async (): Promise<ChatModel> => {
    const model: ChatModel = {
      bindTools: () => model,
      invoke: async (messages) => {
        providerInputs.push([...messages]);
        const reply = providerReplies.shift();
        if (!reply) throw new Error("Unexpected model invocation");
        return reply;
      },
    };
    return model;
  },
}));

const trust = await import("@nautilo/trust");
const credentialAuthority = spyOn(trust, "assertCanUseServerProviderCredentials")
  .mockImplementation(async () => undefined);

const { prepareMemoryReview } = await import("../../src/memory/background-reviewer");
const { runProtectedBackgroundMemoryReview } = await import("../../src/memory/protected-background-memory-review");
const { ModelToolCallIdentityError } = await import("../../src/nodes/model-tool-call-identity");
const { createResearcherGraph } = await import("../../src/subagents/deep-research/researcher/graph");
const { supervisor } = await import("../../src/subagents/deep-research/supervisor/graph");

const deepResearchConfig = {
  research_model: "anthropic:claude-opus-5-5",
  research_model_max_tokens: 10_000,
  compression_model: "anthropic:claude-opus-5-5",
  compression_model_max_tokens: 4096,
  supervisor_model: "anthropic:claude-opus-5-5",
  supervisor_model_max_tokens: 10_000,
  final_report_model: "anthropic:claude-opus-5-5",
  final_report_model_max_tokens: 10_000,
  max_researcher_iterations: 2,
  max_concurrent_research_units: 1,
  max_react_tool_calls: 3,
  summarization_max_items: 3,
  max_tool_messages: 64,
  search_api: "none",
  search_max_results: 5,
  prefer_native_search: false,
  anthropic_long_context_beta: false,
  mcp_prompt: null,
  mcp_config: null,
  openai_api_key: "synthetic-key",
  anthropic_api_key: null,
  google_api_key: null,
  fireworks_api_key: null,
  openrouter_api_key: null,
  xai_api_key: null,
  together_api_key: null,
  venice_api_key: null,
  base_url_overrides: null,
} as Configuration;

function toolCall(id: string, name: string, args: Record<string, unknown>): AIMessage {
  return new AIMessage({ content: "", tool_calls: [{ id, name, args }] });
}

function pairedCallIds(messages: readonly BaseMessageLike[]): string[] {
  const base = messages as readonly BaseMessage[];
  const calls = base.filter((message): message is AIMessage =>
    AIMessage.isInstance(message) && Boolean(message.tool_calls?.length));
  const ids = calls.map((message) => message.tool_calls![0]!.id!);
  for (const id of ids) {
    expect(base.some((message) =>
      ToolMessage.isInstance(message) && message.tool_call_id === id)).toBe(true);
  }
  return ids;
}

function withServerFunding<T>(run: () => T): T {
  return runWithUsageContext({ callType: "subagent", userId: "deep-research-human" }, run);
}

beforeEach(() => {
  providerReplies = [];
  providerInputs.length = 0;
  memoryPorts = {
    read: async () => null,
    search: async () => [],
    embed: async () => memoryEmbedding,
    findSaveTarget: async () => null,
    dedupThreshold: 0.9,
  };
});

afterAll(() => {
  providerReplies = [];
  providerInputs.length = 0;
  credentialAuthority.mockRestore();
  mock.restore();
});

describe("secondary model tool-call admission", () => {
  test("ordinary background Memory pairs repeated provider IDs as distinct invocations", async () => {
    const inputs: BaseMessage[][] = [];
    const replies = [
      toolCall("provider-reused", "manage_memory", {
        action: "save", type: "fact", content: "First fact",
      }),
      toolCall("provider-reused", "manage_memory", {
        action: "save", type: "fact", content: "Second fact",
      }),
      new AIMessage("Done."),
    ];
    const result = await prepareMemoryReview([], {
      workId: "secondary-ingress-review",
      modelId: "review-model",
      memoryAccessEnvelope: memoryEnvelope,
      maxIterations: 3,
      invokeModel: async ({ messages }) => {
        inputs.push([...messages]);
        const reply = replies.shift();
        if (!reply) throw new Error("Unexpected model invocation");
        return reply;
      },
    });

    expect(result.status).toBe("prepared");
    const ids = pairedCallIds(inputs[2]!);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain("provider-reused");
  });

  test("protected background Memory keeps signed publication identity while calls become canonical", async () => {
    const namespaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const publicationId = "signed-publication-slot";
    const runOnce = async () => {
      const conversations: BaseMessage[][] = [];
      let invocation = 0;
      type ProtectedReviewModelDouble = {
        bindTools(): ProtectedReviewModelDouble;
        invoke(messages: readonly BaseMessage[]): Promise<unknown>;
      };
      const model: ProtectedReviewModelDouble = {
        bindTools: () => model,
        async invoke(messages) {
          conversations.push([...messages]);
          invocation += 1;
          return invocation === 1
            ? toolCall("provider-reused", "manage_memory", {
                action: "save", type: "fact", content: "Protected fact",
              })
            : new AIMessage("Done.");
        },
      };
      const outputs = await runProtectedBackgroundMemoryReview({
        kind: "memory.review",
        authority: {
          mode: "namespace",
          subjectUserId: "human",
          agentId: "agent",
          readableNamespaceIds: [namespaceId],
          mutableNamespaceIds: [namespaceId],
          writableNamespaceId: namespaceId,
        },
        inputs: [],
        outputSlots: [{
          action: "create",
          publicationIdempotencyId: publicationId,
          memoryId: "22222222-2222-4222-8222-222222222222",
          expectedContentRevision: 0,
          expectedCryptoAccessRevision: 0,
          nextContentRevision: 1,
          requiredNamespaceIds: [namespaceId],
          createdAt: 1_800_000_000_000,
        }],
        tierSlots: [],
        embedding: protectedEmbedding(),
        modelId: "review-model",
        roomId: "protected-secondary-ingress",
        maximumIterations: 2,
        mutationRequestId: "protected-review-request",
        createModel: async () => model,
      });
      return { outputs, canonicalId: pairedCallIds(conversations[1]!)[0]! };
    };

    const first = await runOnce();
    const second = await runOnce();
    expect(first.canonicalId).not.toBe(second.canonicalId);
    expect(first.outputs).toEqual(second.outputs);
    expect(first.outputs[0]).toMatchObject({ publicationIdempotencyId: publicationId });
  });

  test("researcher completed response is canonical before its tool node and next model call", async () => {
    providerReplies = [
      toolCall("provider-reused", "think_tool", { reflection: "First" }),
      toolCall("provider-reused", "ResearchComplete", {}),
      new AIMessage("Research summary"),
    ];

    const output = await withServerFunding(() => createResearcherGraph(deepResearchConfig).invoke({
      research_topic: "identity",
      research_brief: "Trace identity.",
    }));
    expect(output).toBeDefined();
    const ids = pairedCallIds((output as { researcher_messages: BaseMessageLike[] }).researcher_messages);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain("provider-reused");
  });

  test("researcher rejects ambiguous provider aliases before tools execute", async () => {
    providerReplies = [new AIMessage({
      content: "",
      tool_calls: [
        { id: "provider-reused", name: "ConductResearch", args: { research_topic: "first" } },
        { id: "provider-reused", name: "ConductResearch", args: { research_topic: "second" } },
      ],
      additional_kwargs: {
        __gemini_function_call_thought_signatures__: {
          "provider-reused": "lossy-single-signature",
        },
      },
    })];

    const error = await withServerFunding(() => createResearcherGraph(deepResearchConfig).invoke({
      research_topic: "identity",
      research_brief: "Trace identity.",
    })).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ModelToolCallIdentityError);
    expect((error as Error).message).toBe(
      "Ambiguous model tool-call correlation; no tools were admitted",
    );
    expect(providerInputs).toHaveLength(1);
  });

  test("supervisor admits each fresh response without rewriting resumed history", async () => {
    providerReplies = [
      toolCall("provider-reused", "think_tool", { reflection: "First" }),
      toolCall("provider-reused", "ResearchComplete", {}),
    ];
    const first = await withServerFunding(() => supervisor({
      supervisor_messages: [],
      research_brief: "Trace identity.",
    } as never, deepResearchConfig));
    const admitted = first.supervisor_messages[0] as AIMessage;
    const firstId = admitted.tool_calls![0]!.id!;
    const resumed = [
      admitted,
      new ToolMessage({ content: "Reflection: First", name: "think_tool", tool_call_id: firstId }),
    ];
    const second = await withServerFunding(() => supervisor({
      supervisor_messages: resumed,
      research_brief: "Trace identity.",
    } as never, deepResearchConfig));
    const secondCall = second.supervisor_messages.at(-1) as AIMessage;
    const secondId = secondCall.tool_calls![0]!.id!;

    expect(firstId).not.toBe(secondId);
    expect(firstId).not.toBe("provider-reused");
    expect(secondId).not.toBe("provider-reused");
    expect((providerInputs[1]![1] as AIMessage).tool_calls![0]!.id).toBe(firstId);
    expect((providerInputs[1]![2] as ToolMessage).tool_call_id).toBe(firstId);
  });
});

function protectedEmbedding(): ProtectedAgentMemoryEmbeddingPort {
  return {
    embed: async ({ plaintext }) => ({
      status: "success",
      value: {
        provider: "test-provider",
        canonicalModel: "test-embedding",
        dimensions: 1536,
        contractVersion: 1,
        vector: Array.from({ length: 1536 }, (_unused, index) =>
          ((plaintext.length + index) % 13) / 13),
      },
    }),
  };
}
