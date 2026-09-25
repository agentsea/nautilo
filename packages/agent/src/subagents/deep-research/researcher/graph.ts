import { StateGraph, START, END } from "@langchain/langgraph";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import { ResearcherStateAnnotation } from "./state";
import type { Configuration } from "../shared/config";
import { get_all_tools, get_langchain_tools } from "../tools/index";
import { buildResearchSystemPrompt, buildCompressResearchPrompt, researchCompleteTool, thinkTool } from "../tools/core";
import { createModel } from "../providers/router";
import type { BaseMessageLike, BaseMessage } from "@langchain/core/messages";
import type { ChatModel } from "../../../providers/types";
import { ToolMessage, AIMessage } from "@langchain/core/messages";
import { extractTextFromResponse } from "../shared/utils";
import { getModelTokenLimit } from "../../../providers/models";
import { ModelOutputLimitError, modelResponseReachedOutputLimit } from "../../../graph/model-output-limit";
import { isTokenLimitError } from "../../../utils/errors";
import { invokeWithRetry } from "../../../utils/invoke";
import { hasNativeWebsearch } from "../shared/native_search";
import { getStringField, isRecord, toStringArray } from "../shared/langchain-helpers";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import { log, warn } from "@nautilo/logger";

const toToolCallArgs = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const getToolCallId = (value: unknown): string => (typeof value === "string" ? value : "");

/** ~150 tokens — per-turn system context for research brief without crowding the topic line. */
const RESEARCH_BRIEF_PROMPT_MAX_CHARS = 600;

export function truncateResearchBriefForPrompt(brief: string): string {
  if (brief.length <= RESEARCH_BRIEF_PROMPT_MAX_CHARS) return brief;
  return brief.slice(0, RESEARCH_BRIEF_PROMPT_MAX_CHARS) + "…";
}

export function buildSearchResultToolContent(
  items: Array<{ title?: string; url?: string; snippet?: string }>,
  notes: string[],
  maxResults: number,
): string {
  const embedded = notes.slice(0, maxResults);
  const searchResults = embedded.join("\n\n");
  if (items.length > embedded.length) {
    return `Found ${items.length} results (showing ${embedded.length} of ${items.length}):\n\n${searchResults}`;
  }
  return `Found ${items.length} results:\n\n${searchResults}`;
}

export function selectNotesForCompression(rawNotes: string[], maxItems: number): {
  text: string;
  takeCount: number;
  droppedCount: number;
} {
  const takeCount = Math.min(maxItems, rawNotes.length || 0) || 0;
  const droppedCount = Math.max(0, rawNotes.length - takeCount);
  let text = rawNotes.slice(-takeCount).join("\n\n");
  if (droppedCount > 0) {
    text = `[${droppedCount} older note(s) omitted; compressing ${takeCount} most recent]\n\n${text}`;
  }
  return { text, takeCount, droppedCount };
}

export function appendDroppedNotesNotice(compressed: string, droppedCount: number): string {
  if (droppedCount <= 0) return compressed;
  return `[${droppedCount} older note(s) dropped from compression]\n\n${compressed}`;
}

async function researcher(
  state: typeof ResearcherStateAnnotation.State,
  cfg: Configuration,
  config?: import("@langchain/core/runnables").RunnableConfig,
): Promise<{ researcher_messages: BaseMessageLike[] }> {
  const topic = state.research_topic ?? "";
  const existingMessages = state.researcher_messages ?? [];

  try {
    let systemPrompt = buildResearchSystemPrompt(cfg.mcp_prompt ?? "");
    const searches = Number(state.search_call_count ?? 0);
    const findings = Number((state.raw_notes ?? []).length);
    const briefForTurn = truncateResearchBriefForPrompt(state.research_brief ?? "");
    const topicLine = `Topic: ${topic}`;
    const briefLine = briefForTurn ? `Original request: "${briefForTurn}"` : undefined;
    const status = `Progress: searches=${searches}, notes=${findings}.`;
    const rule = `Do not claim the question is missing; use the topic and brief above.`;
    const guidance = `If coverage is sufficient to write a confident, well-cited answer, call ResearchComplete now; otherwise continue targeted searches and use think_tool after each search to reflect.`;
    const sysLines = [topicLine, briefLine, status, rule, guidance].filter(Boolean) as string[];
    systemPrompt = `${systemPrompt}\n\n${sysLines.join("\n")}`;
    const callbacks = config?.callbacks;
    let extractedCallbacks: unknown[] | undefined;
    if (Array.isArray(callbacks)) {
      extractedCallbacks = callbacks;
    } else if (callbacks && typeof callbacks === "object" && "handlers" in callbacks) {
      const manager = callbacks as { handlers?: unknown[] };
      extractedCallbacks = Array.isArray(manager.handlers) ? manager.handlers : undefined;
    }

    const baseTools: DynamicStructuredTool[] = await get_langchain_tools(cfg, extractedCallbacks);
    const lcTools = [...baseTools, researchCompleteTool, thinkTool];

    const firstTurn = existingMessages.length === 0;
    const maxToolMsgs = Math.max(1, cfg.max_tool_messages);
    const windowed = firstTurn ? [] : existingMessages.slice(-maxToolMsgs);
    // Opus 5.5 rejects forced tool choice. The existing research prompt and
    // LangGraph loop still request and execute tools with automatic selection.
    const requiresAutomaticToolChoice = [
      "anthropic:claude-opus-5-5",
      "openrouter:anthropic/claude-opus-5.5",
      "venice:claude-opus-5-5",
    ].includes(cfg.research_model);
    let messages: BaseMessageLike[];

    if (existingMessages.length === 0) {
      const brief = state.research_brief ?? "";
      const directive = state.supervisor_directive ?? "";
      const lines: string[] = [
        `You are researching: ${topic}`,
        brief ? `This is part of the request: "${brief}"` : undefined,
        directive ? `Supervisor guidance: ${directive}` : undefined,
        "Begin immediately with a web search. Gather URLs and dates, cite sources, and provide a concise TLDR. Do not ask for clarification. Use think_tool only after a search to reflect, not before.",
      ].filter(Boolean) as string[];
      let userContent = lines.join("\n\n");

      try {
        const limit = getModelTokenLimit(cfg.research_model, { anthropicLongContextBeta: cfg.anthropic_long_context_beta });
        const budgetChars = Math.max(2000, Math.floor(limit * 0.15) * 4);
        if (userContent.length > budgetChars) {
          const focusLine = `You are researching: ${topic}`;
          let briefPart = brief ? `This is part of the request: "${brief}"` : "";
          let dirPart = directive ? `Supervisor guidance: ${directive}` : "";
          const maxPart = Math.floor((budgetChars - focusLine.length - 200) / 2);
          if (dirPart.length > maxPart) dirPart = dirPart.slice(0, maxPart) + "...";
          if (briefPart.length > maxPart) briefPart = briefPart.slice(0, maxPart) + "...";
          userContent = [focusLine, briefPart || undefined, dirPart || undefined,
            "Begin immediately with a web search. Gather URLs and dates, cite sources, and provide a concise TLDR. Do not ask for clarification. Use think_tool only after a search to reflect, not before.",
          ].filter(Boolean).join("\n\n");
        }
      } catch { /* best-effort */ }

      messages = [{ role: "system", content: systemPrompt }, { role: "user", content: userContent }];
    } else {
      messages = [{ role: "system", content: systemPrompt }, ...windowed];
    }

    const model = await createModel(cfg.research_model, cfg, {
      maxTokens: cfg.research_model_max_tokens,
      useOpenAIResponsesApi: true,
      messages, tools: lcTools,
    });
    if (!model.bindTools) throw new Error("Model does not support tool binding");
    const toolBoundModel: ChatModel<BaseMessageLike, unknown> = firstTurn || requiresAutomaticToolChoice
      ? model.bindTools(lcTools)
      : model.bindTools(lcTools, { tool_choice: "required" });

    const response = await invokeWithRetry<BaseMessageLike, unknown>(toolBoundModel, messages, {
      label: "researcher.invoke",
      attempts: 3,
      timeoutMs: 45000,
      ...(config?.signal ? { signal: config.signal } : {}),
    });
    const aiResponse = response as BaseMessageLike;
    if (!AIMessage.isInstance(aiResponse as BaseMessage)) throw new Error("Model response is not an AIMessage");
    return { researcher_messages: [aiResponse] };
  } catch (e) {
    if (config?.signal?.aborted) throw e;
    warn(`[researcher] research step failed: ${e instanceof Error ? e.message : String(e)}`);
    return { researcher_messages: existingMessages };
  }
}

async function researcherTools(
  state: typeof ResearcherStateAnnotation.State,
  cfg: Configuration,
  config?: import("@langchain/core/runnables").RunnableConfig,
): Promise<{ raw_notes: string[]; tool_call_iterations: number; researcher_messages: BaseMessageLike[]; research_complete_called: boolean; tool_call_count: number; search_call_count: number }> {
  const messages = Array.isArray(state.researcher_messages) ? state.researcher_messages : [];
  const candidate = messages[messages.length - 1];
  const lastMessage = candidate && AIMessage.isInstance(candidate as BaseMessage) ? (candidate as AIMessage) : undefined;
  if (lastMessage && modelResponseReachedOutputLimit(lastMessage)) {
    throw new ModelOutputLimitError();
  }

  if (!lastMessage?.tool_calls?.length) {
    const native = cfg.prefer_native_search ? hasNativeWebsearch(lastMessage) : false;
    if (native) log("[researcher] native websearch detected (provider), continuing loop");
    return {
      raw_notes: toStringArray(state.raw_notes),
      tool_call_iterations: (state.tool_call_iterations ?? 0) + 1,
      researcher_messages: messages,
      research_complete_called: false,
      tool_call_count: state.tool_call_count ?? 0,
      search_call_count: state.search_call_count ?? 0,
    };
  }

  const callbacks = config?.callbacks;
  let extractedCallbacks: unknown[] | undefined;
  if (Array.isArray(callbacks)) extractedCallbacks = callbacks;
  else if (callbacks && typeof callbacks === "object" && "handlers" in callbacks) {
    const manager = callbacks as { handlers?: unknown[] };
    extractedCallbacks = Array.isArray(manager.handlers) ? manager.handlers : undefined;
  }

  const tools = get_all_tools(cfg, extractedCallbacks);
  let accumulatedNotes = toStringArray(state.raw_notes);
  const toolMessages: ToolMessage[] = [];
  let researchCompleteFlag = false;
  let toolCallCount = Number(state.tool_call_count ?? 0);
  let searchCallCount = Number(state.search_call_count ?? 0);

  const toolCalls = lastMessage.tool_calls ?? [];

  for (const toolCall of toolCalls) {
    const toolName = toolCall.name;
    const args = toToolCallArgs(toolCall.args);
    const toolCallId = getToolCallId(toolCall.id);
    toolCallCount += 1;

    if (toolName === "search") {
      const query = (getStringField(args, "query") ?? "").trim();
      const queryPreview = query.length > 40 ? query.slice(0, 40) + "..." : query;

      try {
        await dispatchCustomEvent("job.progress", {
          phase: "Searching the web...",
          step: 3, totalSteps: 5,
          detail: `Query: "${queryPreview}"`,
          currentItem: queryPreview,
        }, config);
      } catch { /* ignore */ }

      const res = await tools.search(query);
      const items = Array.isArray(res.items) ? res.items : [];
      searchCallCount += 1;

      const notes = items.map((item) => {
        const title = item.title ?? item.url ?? "";
        const url = item.url ?? "";
        const snippet = item.snippet ? `\n${item.snippet}` : "";
        return `${title}\n${url}${snippet}`;
      });
      accumulatedNotes = [...accumulatedNotes, ...notes];

      toolMessages.push(new ToolMessage({
        content: buildSearchResultToolContent(items, notes, cfg.search_max_results),
        tool_call_id: toolCallId,
        name: toolName,
      }));
    } else if (toolName === "ResearchComplete") {
      researchCompleteFlag = true;
      toolMessages.push(new ToolMessage({ content: "Research completed successfully.", tool_call_id: toolCallId, name: toolName }));
    } else if (toolName === "think_tool") {
      const reflection = (getStringField(args, "reflection") ?? "thinking...").trim();
      toolMessages.push(new ToolMessage({ content: `Reflection: ${reflection}`, tool_call_id: toolCallId, name: toolName }));
    }
  }

  return {
    raw_notes: accumulatedNotes,
    tool_call_iterations: (state.tool_call_iterations ?? 0) + 1,
    researcher_messages: toolMessages,
    research_complete_called: researchCompleteFlag,
    tool_call_count: toolCallCount,
    search_call_count: searchCallCount,
  };
}

async function compressResearch(
  state: typeof ResearcherStateAnnotation.State,
  cfg: Configuration,
  config?: import("@langchain/core/runnables").RunnableConfig,
): Promise<{ compressed_research: string; raw_notes: string[] }> {
  const prompt = buildCompressResearchPrompt();
  const rawNotes = state.raw_notes ?? [];
  const maxItems = cfg.summarization_max_items;
  let { text, takeCount, droppedCount } = selectNotesForCompression(rawNotes, maxItems);

  try {
    const model = await createModel(cfg.compression_model, cfg, {
      maxTokens: cfg.compression_model_max_tokens,
    });
    if (!model) throw new Error("Failed to create compression model");

    let attempts = 0;
    const maxAttempts = 3;
    while (attempts < maxAttempts) {
      attempts += 1;
      const messages: BaseMessageLike[] = [
        { role: "system", content: prompt },
        { role: "user", content: text },
      ];
      try {
        const resp: unknown = await model.invoke(messages, {
          ...(config?.signal ? { signal: config.signal } : {}),
        });
        config?.signal?.throwIfAborted();
        if (AIMessage.isInstance(resp) && modelResponseReachedOutputLimit(resp)) {
          throw new ModelOutputLimitError();
        }
        const out: string = extractTextFromResponse(resp);
        return { compressed_research: appendDroppedNotesNotice(out, droppedCount), raw_notes: rawNotes };
      } catch (err) {
        if (err instanceof ModelOutputLimitError) throw err;
        if (config?.signal?.aborted) throw err;
        if (isTokenLimitError(err) && takeCount > 3) {
          takeCount = Math.max(3, Math.floor(takeCount * 0.8));
          droppedCount = Math.max(0, rawNotes.length - takeCount);
          text = rawNotes.slice(-takeCount).join("\n\n");
          if (droppedCount > 0) {
            text = `[${droppedCount} older note(s) omitted; compressing ${takeCount} most recent]\n\n${text}`;
          }
          continue;
        }
        throw err;
      }
    }
  } catch (e) {
    if (e instanceof ModelOutputLimitError) throw e;
    if (config?.signal?.aborted) throw e;
    warn(`[researcher] compression failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { compressed_research: "Error synthesizing research report: Maximum retries exceeded", raw_notes: rawNotes };
}

interface CompiledGraph {
  invoke(input: Record<string, unknown>, config?: Record<string, unknown>): Promise<unknown>;
  stream(input: Record<string, unknown>, config?: Record<string, unknown>): Promise<AsyncIterable<unknown>>;
  streamEvents(input: Record<string, unknown>, config?: Record<string, unknown>): AsyncIterable<unknown>;
  getState(config: Record<string, unknown>): Promise<{ values: Record<string, unknown> } | undefined>;
}

export function createResearcherGraph(
  configuration: Configuration,
  checkpointSaver?: import("@langchain/langgraph-checkpoint-postgres").PostgresSaver,
): CompiledGraph {
  const researcherBuilder = new StateGraph(ResearcherStateAnnotation)
    .addNode("researcher", (state, config) => researcher(state, configuration, config))
    .addNode("researcher_tools", (state, config) => researcherTools(state, configuration, config))
    .addNode("compress_research", (state, config) => compressResearch(state, configuration, config))
    .addEdge(START, "researcher")
    .addEdge("researcher", "researcher_tools")
    .addConditionalEdges("researcher_tools", (state: typeof ResearcherStateAnnotation.State) => {
      if (state.research_complete_called) return "compress_research";
      const iterations = state.tool_call_iterations ?? 0;
      const maxIterations = configuration.max_react_tool_calls;
      if (iterations >= maxIterations) return "compress_research";
      return "researcher";
    })
    .addEdge("compress_research", END);

  if (checkpointSaver) return researcherBuilder.compile({ checkpointer: checkpointSaver }) as CompiledGraph;
  return researcherBuilder.compile() as CompiledGraph;
}
