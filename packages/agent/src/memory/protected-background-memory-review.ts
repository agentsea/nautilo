import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { createHash } from "node:crypto";
import type {
  ProtectedAgentBackgroundMemoryWorkInput,
  ProtectedAgentBackgroundMemoryWorkOutput,
  ProtectedAgentMemoryEmbeddingPort,
  ProtectedMemoryAuthority,
} from "@nautilo/lattice-bridge";
import type { MemoryAccessEnvelope } from "@nautilo/trust";

import { SOUL_FILE_HEADER } from "../prompts/templates.ts";
import { createUniversalModel } from "../providers/universal.ts";
import { createManageMemoryTool } from "../tools/memory/manage-memory.ts";
import { createSearchMemoryTool } from "../tools/memory/search-memory.ts";
import { runWithUsageContext } from "../usage/usage-context.ts";
import {
  createProtectedBackgroundMemoryStaging,
  type ProtectedBackgroundMemoryOutputSlot,
  type ProtectedBackgroundMemoryTierSlot,
} from "./protected-background-memory-staging.ts";

const PROMPTS = Object.freeze({
  "memory.review": [
    "Review these authenticated conversation inputs for memory-worthy information.",
    "Use search_memory at most once before any write.",
    "Save a new Memory or replace an authenticated existing Memory only when warranted.",
    "Only signed save, replace, promote, or demote actions exposed by the tools are available.",
    "If nothing is worth saving, reply exactly: Nothing to save.",
  ].join(" "),
  "memory.exit_flush": [
    "Save important information from these authenticated conversation inputs before context is lost.",
    "Use search_memory at most once before any write.",
    "Save a new Memory or replace an authenticated existing Memory only when warranted.",
    "Only signed save, replace, promote, or demote actions exposed by the tools are available.",
    "If nothing is worth saving, reply exactly: Nothing to save.",
  ].join(" "),
});

interface InvokableTool {
  readonly name: string;
  invoke(input: unknown, config?: Readonly<{
    configurable: Readonly<Record<string, unknown>>;
  }>): Promise<unknown>;
}

interface ReviewModel {
  bindTools?(tools: readonly InvokableTool[]): ReviewModel;
  invoke(messages: readonly BaseMessage[]): Promise<unknown>;
}

function messageFromInput(
  input: Extract<ProtectedAgentBackgroundMemoryWorkInput, {
    productKind: "message";
  }>,
  index: number,
): BaseMessage {
  switch (input.payload.role) {
    case "user":
      return new HumanMessage(input.payload.content);
    case "assistant":
      return new AIMessage(input.payload.content);
    case "system":
      return new SystemMessage(input.payload.content);
    case "tool":
      return new ToolMessage({
        content: input.payload.content,
        tool_call_id: `protected_background_input_${index}`,
      });
  }
}

function envelope(
  authority: ProtectedMemoryAuthority,
  roomId: string,
): MemoryAccessEnvelope {
  if (authority.mode === "scope") {
    return {
      memoryMode: "scope",
      ownerId: authority.subjectUserId,
      actorId: authority.agentId,
      agentId: authority.agentId,
      roomId,
      scopeId: authority.scopeId,
      toolPolicy: {},
    };
  }
  return {
    memoryMode: "namespace",
    ownerId: authority.subjectUserId,
    actorId: authority.agentId,
    agentId: authority.agentId,
    roomId,
    readableNamespaces: [...authority.readableNamespaceIds],
    mutableNamespaces: [...authority.mutableNamespaceIds],
    writableNamespaces: authority.writableNamespaceId === null
      ? []
      : [authority.writableNamespaceId],
    toolPolicy: {},
  };
}

export function deriveProtectedBackgroundMemoryToolMutationRequestId(
  workId: string,
  toolCallId: string | undefined,
  toolName: string,
  iteration: number,
): string {
  return `background-memory-tool:v1:${createHash("sha256").update(
    `${workId}\n${toolCallId ?? `${toolName}_${iteration}`}`,
    "utf8",
  ).digest("hex")}`;
}

/**
 * Run the existing model/tool protocol wholly inside the bridge transform.
 * No BaseMessage, prompt, or decoded Memory survives in Runtime durable work.
 */
export async function runProtectedBackgroundMemoryReview(input: Readonly<{
  kind: "memory.review" | "memory.exit_flush";
  authority: ProtectedMemoryAuthority;
  inputs: readonly ProtectedAgentBackgroundMemoryWorkInput[];
  outputSlots: readonly ProtectedBackgroundMemoryOutputSlot[];
  tierSlots: readonly ProtectedBackgroundMemoryTierSlot[];
  embedding: ProtectedAgentMemoryEmbeddingPort;
  modelId: string;
  roomId: string;
  maximumIterations: number;
  assistantName?: string;
  soulFile?: string;
  mutationRequestId: string;
  signal?: AbortSignal;
  createModel?: (modelId: string) => Promise<ReviewModel>;
}>): Promise<readonly ProtectedAgentBackgroundMemoryWorkOutput[]> {
  if (
    !Number.isSafeInteger(input.maximumIterations)
    || input.maximumIterations < 1
    || input.maximumIterations > 8
    || input.signal?.aborted === true
    || input.roomId.trim().length < 1
  ) throw new TypeError("Protected background Memory model bound is invalid");
  const staging = createProtectedBackgroundMemoryStaging({
    authority: input.authority,
    inputs: input.inputs,
    candidateMetadata: input.inputs.flatMap((entry) =>
      entry.productKind === "memory"
        ? [Object.freeze({
            memoryId: entry.productId,
            contentRevision: entry.productRevision,
            cryptoAccessRevision: entry.cryptoAccessRevision,
            importance: entry.importance,
            tier: entry.tier,
            createdAt: entry.createdAt,
            embedding: entry.embedding,
          })]
        : []
    ),
    outputSlots: input.outputSlots,
    tierSlots: input.tierSlots,
    embedding: input.embedding,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const memoryAccessEnvelope = envelope(input.authority, input.roomId);
  const tools: InvokableTool[] = [
    createSearchMemoryTool({
      memoryAccessEnvelope,
      protectedMemoryRepository: staging.repository,
    }),
    createManageMemoryTool({
      memoryAccessEnvelope,
      protectedMemoryRepository: staging.repository,
    }),
  ];
  const model = input.createModel === undefined
    ? await createUniversalModel(input.modelId) as ReviewModel
    : await input.createModel(input.modelId);
  const modelWithTools = model.bindTools?.(tools) ?? model;
  const messages = input.inputs.flatMap((entry, index) =>
    entry.productKind === "message" ? [messageFromInput(entry, index)] : []
  );
  const system = input.soulFile === undefined
    ? PROMPTS[input.kind]
    : `${PROMPTS[input.kind]}\nYou are ${input.assistantName ?? "Genie"}.\n${SOUL_FILE_HEADER}${input.soulFile}`;
  let conversation: BaseMessage[] = [
    new SystemMessage(system),
    ...messages,
  ];
  for (let index = 0; index < input.maximumIterations; index += 1) {
    input.signal?.throwIfAborted();
    const response = await runWithUsageContext(
      { callType: input.kind === "memory.review" ? "memory_review" : "memory_flush" },
      () => modelWithTools.invoke(conversation),
    );
    if (!AIMessage.isInstance(response)) {
      throw new TypeError("Protected background Memory model response is invalid");
    }
    conversation = [...conversation, response];
    if (!response.tool_calls?.length) break;
    for (const toolCall of response.tool_calls) {
      const tool = tools.find((candidate) => candidate.name === toolCall.name);
      if (tool === undefined) continue;
      const result = await tool.invoke(toolCall.args, {
        configurable: {
          memoryToolMutationRequestId:
            deriveProtectedBackgroundMemoryToolMutationRequestId(
              input.mutationRequestId,
              toolCall.id,
              toolCall.name,
              index,
            ),
        },
      });
      conversation = [...conversation, new ToolMessage({
        content: typeof result === "string" ? result : JSON.stringify(result),
        tool_call_id: toolCall.id ?? `${toolCall.name}_${index}`,
        name: toolCall.name,
      })];
    }
  }
  return staging.outputs();
}
