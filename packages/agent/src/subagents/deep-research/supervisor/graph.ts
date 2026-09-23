import { StateGraph, START } from "@langchain/langgraph";
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { RunnableConfig } from "@langchain/core/runnables";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import { SupervisorStateAnnotation } from "./state";
import { fromRuntimeConfig, type Configuration } from "../shared/config";
import { createModel } from "../providers/router";
import { createResearcherGraph } from "../researcher/graph";
import { toSupervisorState, toResearcherState } from "../shared/transform";
import { buildLeadResearcherPrompt, conductResearchTool, researchCompleteTool, thinkTool } from "../tools/core";
import type { BaseMessageLike, BaseMessage } from "@langchain/core/messages";
import { ToolMessage, AIMessage } from "@langchain/core/messages";
import type { ChatModel } from "../../../providers/types";
import { invokeWithRetry } from "../../../utils/invoke";
import { messageContentToString } from "../shared/utils";
import { warn } from "@nautilo/logger";
import {
  coerceString,
  getStringField,
  getToolCalls,
  isRecord,
  toAIMessage,
  toStringArray,
} from "../shared/langchain-helpers";

const getErrorMessage = (value: unknown): string => {
  if (value instanceof Error) return value.message;
  return coerceString(value) ?? "<unknown error>";
};

const toToolCallArgs = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const getToolCallId = (value: unknown): string => (typeof value === "string" ? value : "");

/** ~125 tokens — fits researcher per-turn context without crowding tool results. */
const SUPERVISOR_DIRECTIVE_MAX_CHARS = 500;

export function truncateSupervisorDirective(text: string): string {
  if (text.length <= SUPERVISOR_DIRECTIVE_MAX_CHARS) return text;
  return text.slice(0, SUPERVISOR_DIRECTIVE_MAX_CHARS) + "…";
}

function createSupervisorNode(cfg: Configuration) {
  return async function runSupervisor(
    state: typeof SupervisorStateAnnotation.State,
    config?: RunnableConfig,
  ): Promise<{ supervisor_messages: BaseMessageLike[] }> {
    const supervisorMessages = Array.isArray(state.supervisor_messages) ? state.supervisor_messages : [];
    try {
      const systemPrompt = buildLeadResearcherPrompt({
        max_researcher_iterations: cfg.max_researcher_iterations,
        max_concurrent_research_units: cfg.max_concurrent_research_units,
      });

      const model: ChatModel = await createModel(cfg.supervisor_model, cfg, {
        maxTokens: cfg.supervisor_model_max_tokens,
        useOpenAIResponsesApi: true,
      });
      const tools = [conductResearchTool, researchCompleteTool, thinkTool];

      if (!model.bindTools) throw new Error("Model does not support tool binding");
      const toolBoundModel: ChatModel<BaseMessageLike, unknown> = model.bindTools(tools);

      let messages: BaseMessageLike[];

      if (supervisorMessages.length === 0) {
        const brief = state.research_brief ?? "";
        messages = [{ role: "system", content: systemPrompt }, { role: "user", content: brief }];
      } else {
        messages = [{ role: "system", content: systemPrompt }, ...supervisorMessages];
      }

      const lastCandidate = supervisorMessages[supervisorMessages.length - 1];
      const lastAIMessage = lastCandidate && AIMessage.isInstance(lastCandidate as BaseMessage) ? (lastCandidate as AIMessage) : undefined;
      if (lastAIMessage && lastAIMessage.tool_calls?.length) {
        return { supervisor_messages: supervisorMessages };
      }

      const response = await invokeWithRetry<BaseMessageLike, unknown>(toolBoundModel, messages, {
        label: "supervisor.invoke",
        attempts: 3,
        timeoutMs: 60000,
        ...(config?.signal ? { signal: config.signal } : {}),
      });
      return { supervisor_messages: [...supervisorMessages, response as BaseMessageLike] };
    } catch (e) {
      warn(`[supervisor] failed: ${getErrorMessage(e)}`);
      // Retries are exhausted. Returning unchanged messages lets the graph
      // proceed to final synthesis, even when no research was performed.
      // Reject without modifying accumulated state so the Task reports failure.
      throw new Error("Deep Research supervisor failed", { cause: e });
    }
  };
}

export async function supervisor(
  state: typeof SupervisorStateAnnotation.State,
  configuration: Configuration = fromRuntimeConfig(),
): Promise<{ supervisor_messages: BaseMessageLike[] }> {
  return createSupervisorNode(configuration)(state);
}

function createSupervisorToolsNode(cfg: Configuration, _checkpointSaver?: PostgresSaver) {
  const researcherGraph = createResearcherGraph(cfg);

  return async function supervisorTools(
    state: typeof SupervisorStateAnnotation.State,
    config?: RunnableConfig,
  ): Promise<{ supervisor_messages: BaseMessageLike[]; raw_notes: string[]; notes: string[]; research_iterations: number }> {
    const supervisorMessages = Array.isArray(state.supervisor_messages) ? state.supervisor_messages : [];
    const mostRecentMessage = toAIMessage(supervisorMessages[supervisorMessages.length - 1]);

    if (!mostRecentMessage) {
      return {
        supervisor_messages: supervisorMessages,
        raw_notes: toStringArray(state.raw_notes),
        notes: toStringArray(state.notes),
        research_iterations: cfg.max_researcher_iterations,
      };
    }

    const toolCalls = getToolCalls(mostRecentMessage);
    if (toolCalls.length === 0) {
      return {
        supervisor_messages: supervisorMessages,
        raw_notes: toStringArray(state.raw_notes),
        notes: toStringArray(state.notes),
        research_iterations: cfg.max_researcher_iterations,
      };
    }

    const researchIterations = state.research_iterations ?? 0;
    const exceededIterations = researchIterations > cfg.max_researcher_iterations;
    const researchCompleteCalled = toolCalls.some((call) => call.name === "ResearchComplete");

    if (exceededIterations || researchCompleteCalled) {
      return {
        supervisor_messages: supervisorMessages,
        raw_notes: toStringArray(state.raw_notes),
        notes: toStringArray(state.notes),
        research_iterations: cfg.max_researcher_iterations,
      };
    }

    const toolMessages: ToolMessage[] = [];

    for (const toolCall of toolCalls) {
      const args = toToolCallArgs(toolCall.args);
      const toolCallId = getToolCallId(toolCall.id);

      if (toolCall.name === "think_tool") {
        const reflection = (getStringField(args, "reflection") ?? "").trim();
        const result = await thinkTool.func({ reflection }) as string;
        toolMessages.push(new ToolMessage({ content: result, tool_call_id: toolCallId, name: "think_tool" }));
      } else if (toolCall.name === "ConductResearch") {
        const researchTopic = (getStringField(args, "research_topic") ?? "").trim();
        const result = await conductResearchTool.func({ research_topic: researchTopic }) as string;
        toolMessages.push(new ToolMessage({ content: result, tool_call_id: toolCallId, name: "ConductResearch" }));
      } else if (toolCall.name === "ResearchComplete") {
        const result = await researchCompleteTool.func({}) as string;
        toolMessages.push(new ToolMessage({ content: result, tool_call_id: toolCallId, name: "ResearchComplete" }));
      }
    }

    // Build full conversation history: previous messages + AI message with tool_use + tool results.
    // Anthropic rejects tool_result blocks without a preceding tool_use,
    // and overrideListReducer replaces state, so we must include everything.
    const previousMessages = supervisorMessages.slice(0, -1);
    const conversationSoFar: BaseMessageLike[] = [...previousMessages, mostRecentMessage, ...toolMessages];

    const conductResearchCalls = toolCalls.filter((call) => call.name === "ConductResearch");

    if (conductResearchCalls.length > 0) {
      const existingRawNotes = toStringArray(state.raw_notes);
      const existingNotes = toStringArray(state.notes);

      const researchResults = await Promise.all(
        conductResearchCalls.map(async (toolCall, index) => {
          const args = toToolCallArgs(toolCall.args);
          const topic = (getStringField(args, "research_topic") ?? "").trim();

          try {
            await dispatchCustomEvent("job.progress", {
              phase: "Researching topics...",
              step: 3, totalSteps: 5,
              detail: `Topic ${index + 1}/${conductResearchCalls.length}: "${topic.length > 50 ? topic.slice(0, 50) + "..." : topic}"`,
              currentItem: topic.length > 50 ? topic.slice(0, 50) + "..." : topic,
              itemIndex: index + 1,
              totalItems: conductResearchCalls.length,
            }, config);
          } catch { /* ignore */ }

          const supervisorState = toSupervisorState({
            messages: [], supervisor_messages: supervisorMessages,
            research_brief: state.research_brief ?? "",
            raw_notes: existingRawNotes, notes: existingNotes, final_report: "",
          });

          const lastAssistant = [...supervisorMessages]
            .reverse()
            .find((message) => isRecord(message) && message["role"] === "assistant");
          const supervisorDirective = (() => {
            if (lastAssistant) {
              const preview = truncateSupervisorDirective(messageContentToString(lastAssistant));
              if (preview) return preview;
            }
            return `Focus on: ${topic}. Produce credible sources (URLs) and a concise TLDR.`;
          })();

          const researcherInput = toResearcherState(supervisorState, topic, {
            research_brief: state.research_brief ?? "",
            supervisor_directive: supervisorDirective,
          });

          const threadIdValue: unknown = config?.configurable?.["thread_id"];
          const threadId = typeof threadIdValue === "string" ? threadIdValue : undefined;
          const researcherConfig: RunnableConfig = {};
          if (threadId && config?.configurable) {
            researcherConfig.configurable = { thread_id: `${threadId}:researcher:${index}`, ...config.configurable };
          }
          if (config?.signal) researcherConfig.signal = config.signal;

          const graphInvoker = researcherGraph as unknown as { invoke: (arg: unknown, config?: unknown) => Promise<unknown> };
          const rawOutput = await graphInvoker.invoke(researcherInput, researcherConfig);

          const output = isRecord(rawOutput) ? rawOutput : {};
          return {
            raw_notes: toStringArray(output["raw_notes"]),
            compressed_research: typeof output["compressed_research"] === "string" ? output["compressed_research"] : undefined,
          };
        }),
      );

      const mergedRaw = researchResults.flatMap((r) => r.raw_notes);
      const mergedNotes = researchResults
        .map((r) => r.compressed_research)
        .filter((value): value is string => typeof value === "string" && value.length > 0);

      return {
        supervisor_messages: conversationSoFar,
        raw_notes: [...existingRawNotes, ...mergedRaw],
        notes: [...existingNotes, ...mergedNotes],
        research_iterations: researchIterations + 1,
      };
    }

    return {
      supervisor_messages: conversationSoFar,
      raw_notes: toStringArray(state.raw_notes),
      notes: toStringArray(state.notes),
      research_iterations: researchIterations + 1,
    };
  };
}

interface CompiledGraph {
  invoke(input: Record<string, unknown>, config?: Record<string, unknown>): Promise<unknown>;
  stream(input: Record<string, unknown>, config?: Record<string, unknown>): Promise<AsyncIterable<unknown>>;
  streamEvents(input: Record<string, unknown>, config?: Record<string, unknown>): AsyncIterable<unknown>;
  getState(config: Record<string, unknown>): Promise<{ values: Record<string, unknown> } | undefined>;
}

export function createSupervisorGraph(
  configuration: Configuration,
  checkpointSaver?: PostgresSaver,
): CompiledGraph {
  const supervisorNode = createSupervisorNode(configuration);
  const supervisorToolsNode = createSupervisorToolsNode(configuration, checkpointSaver);

  const supervisorBuilder = new StateGraph(SupervisorStateAnnotation)
    .addNode("supervisor", supervisorNode)
    .addNode("supervisor_tools", supervisorToolsNode);

  supervisorBuilder.addEdge(START, "supervisor");
  supervisorBuilder.addEdge("supervisor", "supervisor_tools");
  supervisorBuilder.addConditionalEdges("supervisor_tools", (state: typeof SupervisorStateAnnotation.State) => {
    const iter = Number(state?.research_iterations ?? 0);
    const max = Number(configuration.max_researcher_iterations);
    return iter >= max ? "__end__" : "supervisor";
  });

  if (checkpointSaver) return supervisorBuilder.compile({ checkpointer: checkpointSaver }) as CompiledGraph;
  return supervisorBuilder.compile() as CompiledGraph;
}
