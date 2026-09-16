import { StateGraph, START, END } from "@langchain/langgraph";
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { RunnableConfig } from "@langchain/core/runnables";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import { AgentStateAnnotation } from "./state";
import { createSupervisorGraph } from "../supervisor/graph";
import { fromRuntimeConfig, type Configuration } from "../shared/config";
import { createModel } from "../providers/router";
import { buildFinalReportPrompt, buildClarifyWithUserPrompt } from "../tools/core";
import { parseJsonSafely, messageContentToString, extractTextFromResponse } from "../shared/utils";
import { toSupervisorState } from "../shared/transform";
import type { AgentState as AgentStateShape } from "../shared/transform";
import type { BaseMessageLike } from "@langchain/core/messages";
import { classifyError, isTokenLimitError } from "../../../utils/errors";
import { getModelTokenLimit } from "../../../providers/models";
import { warn } from "@nautilo/logger";
import { invokeWithRetry } from "../../../utils/invoke";
import type { ClarifyWithUser } from "../shared/types";
import { isRecord, toStringArray, coerceString } from "../shared/langchain-helpers";

const isBaseMessageLikeArray = (value: unknown): value is BaseMessageLike[] => Array.isArray(value);

function createClarifyWithUserNode(cfg: Configuration) {
  return async function clarifyWithUser(
    state: typeof AgentStateAnnotation.State,
    config?: RunnableConfig,
  ): Promise<{ messages: BaseMessageLike[] }> {
    if (!cfg.allow_clarification) return { messages: state.messages ?? [] };
    try {
      const model = await createModel(cfg.research_model, cfg, {
        maxTokens: cfg.research_model_max_tokens,
      });
      const transcript = Array.isArray(state.messages)
        ? state.messages.map((m) => messageContentToString(m)).join("\n\n")
        : "";
      const prompt = buildClarifyWithUserPrompt(transcript);
      const resp: unknown = await invokeWithRetry<BaseMessageLike, unknown>(model, [{ role: "user", content: prompt }] as BaseMessageLike[], {
        label: "clarify.invoke",
        attempts: 3,
        timeoutMs: 30000,
        ...(config?.signal ? { signal: config.signal } : {}),
      });
      const text = extractTextFromResponse(resp);
      const parsed = parseJsonSafely<ClarifyWithUser>(text);
      if (parsed?.need_clarification && parsed?.question) {
        const msg = `Clarification needed: ${parsed.question}`;
        return { messages: (state.messages ?? []).concat([{ role: "assistant", content: msg }]) };
      }
      if (parsed?.verification) {
        return { messages: (state.messages ?? []).concat([{ role: "assistant", content: parsed.verification }]) };
      }
    } catch { /* ignore */ }
    return { messages: state.messages ?? [] };
  };
}

function writeResearchBrief(_state: typeof AgentStateAnnotation.State): { research_brief: string } {
  return { research_brief: _state.research_brief ?? "" };
}

function createRunSupervisorNode(cfg: Configuration, _checkpointSaver?: PostgresSaver) {
  const supervisorGraph = createSupervisorGraph(cfg);

  return async function runSupervisor(
    state: typeof AgentStateAnnotation.State,
    config?: RunnableConfig,
  ): Promise<{ supervisor_messages: BaseMessageLike[]; raw_notes: string[]; notes: string[]; research_iterations: number }> {
    const agentShape: AgentStateShape = {
      messages: state.messages ?? [],
      supervisor_messages: state.supervisor_messages ?? [],
      research_brief: state.research_brief ?? "",
      raw_notes: state.raw_notes ?? [],
      notes: state.notes ?? [],
      final_report: state.final_report ?? "",
    };
    const sup = toSupervisorState(agentShape);

    const threadIdValue: unknown = config?.configurable?.["thread_id"];
    const threadId = typeof threadIdValue === "string" ? threadIdValue : undefined;
    const supervisorConfig: RunnableConfig = {};
    if (threadId && config?.configurable) {
      supervisorConfig.configurable = { thread_id: `${threadId}:supervisor`, ...config.configurable };
    }
    if (config?.signal) supervisorConfig.signal = config.signal;

    const graphInvoker = supervisorGraph as unknown as {
      invoke: (arg: unknown, config?: unknown) => Promise<unknown>;
    };
    const rawOutput = await graphInvoker.invoke(sup, supervisorConfig);

    const output = isRecord(rawOutput) ? rawOutput : {};
    const supervisorMessages: BaseMessageLike[] = isBaseMessageLikeArray(output["supervisor_messages"])
      ? output["supervisor_messages"]
      : [];
    const rawNotes = toStringArray(output["raw_notes"]);
    const notes = toStringArray(output["notes"]);
    const researchIterationsValue = output["research_iterations"];
    const researchIterations = typeof researchIterationsValue === "number"
      ? researchIterationsValue
      : Number(coerceString(researchIterationsValue) ?? 0);

    return {
      supervisor_messages: supervisorMessages,
      raw_notes: rawNotes,
      notes,
      research_iterations: Number.isFinite(researchIterations) ? researchIterations : 0,
    };
  };
}

export function createFinalReportGenerationNode(cfg: Configuration) {
  return async function finalReportGeneration(
    state: typeof AgentStateAnnotation.State,
    config?: RunnableConfig,
  ): Promise<{ final_report: string; messages: BaseMessageLike[] }> {
    let findings = (state.notes ?? []).join("\n\n");

    try {
      await dispatchCustomEvent("job.progress", {
        phase: "Writing final report...",
        step: 5, totalSteps: 5,
        detail: `Synthesizing ${state.notes?.length ?? 0} research notes into final report...`,
      }, config);
    } catch { /* ignore */ }

    try {
      const model = await createModel(cfg.final_report_model, cfg, {
        maxTokens: cfg.final_report_model_max_tokens,
      });
      let attempts = 0;
      const maxAttempts = 3;
      let findingsCharLimit: number | null = null;

      while (attempts < maxAttempts) {
        attempts += 1;
        const prompt = buildFinalReportPrompt({
          research_brief: state.research_brief ?? "",
          messages: JSON.stringify(state.messages ?? []),
          findings,
          report_language: state.report_language ?? "English",
        });
        try {
          const runnableModel = model as unknown as {
            invoke: (messages: BaseMessageLike[], config?: RunnableConfig) => Promise<unknown>;
          };
          const resp = await runnableModel.invoke(
            [{ role: "user", content: prompt }] as BaseMessageLike[],
            config,
          );
          const text: string = extractTextFromResponse(resp);
          if (!text.trim()) throw new Error("Final report model returned an empty report");
          return { final_report: text, messages: [resp as BaseMessageLike] };
        } catch (e) {
          if (isTokenLimitError(e) && attempts < maxAttempts) {
            if (findingsCharLimit == null) {
              const maxTokens = getModelTokenLimit(cfg.final_report_model, { anthropicLongContextBeta: cfg.anthropic_long_context_beta });
              findingsCharLimit = Math.max(1000, maxTokens * 4);
            } else {
              findingsCharLimit = Math.floor(findingsCharLimit * 0.9);
            }
            const before = findings.length;
            findings = findings.slice(0, findingsCharLimit);
            warn(`[agent] Token limit during final report; truncating findings ${before} -> ${findings.length} and retrying (${attempts}/${maxAttempts})`);
            continue;
          }
          throw e;
        }
      }
    } catch (e) {
      warn(`[agent] final report failed: ${(e as Error).message}`);
      // A failed synthesis must fail the Task, not become a successful report.
      // Preserve the provider cause rather than inventing retry exhaustion.
      const detail = classifyError(e).category === "TIMEOUT" ? ": the report model timed out" : "";
      throw new Error(`Deep Research final report generation failed${detail}`, { cause: e });
    }
    throw new Error("Deep Research final report generation did not produce a report");
  };
}

export interface CompiledGraph {
  invoke(input: Record<string, unknown>, config?: Record<string, unknown>): Promise<unknown>;
  stream(input: Record<string, unknown>, config?: Record<string, unknown>): Promise<AsyncIterable<unknown>>;
  streamEvents(input: Record<string, unknown>, config?: Record<string, unknown>): AsyncIterable<unknown>;
  getState(config: Record<string, unknown>): Promise<{ values: Record<string, unknown> } | undefined>;
}

export function createDeepResearchGraph(
  checkpointSaver?: PostgresSaver,
  configuration: Configuration = fromRuntimeConfig(),
): CompiledGraph {
  const runSupervisorNode = createRunSupervisorNode(configuration, checkpointSaver);
  const clarifyWithUser = createClarifyWithUserNode(configuration);
  const finalReportGeneration = createFinalReportGenerationNode(configuration);

  const agentBuilder = new StateGraph(AgentStateAnnotation)
    .addNode("clarify_with_user", clarifyWithUser)
    .addNode("write_research_brief", writeResearchBrief)
    .addNode("research_supervisor", runSupervisorNode)
    .addNode("final_report_generation", finalReportGeneration)
    .addEdge(START, "clarify_with_user")
    .addEdge("clarify_with_user", "write_research_brief")
    .addEdge("write_research_brief", "research_supervisor")
    .addEdge("research_supervisor", "final_report_generation")
    .addEdge("final_report_generation", END);

  if (checkpointSaver) return agentBuilder.compile({ checkpointer: checkpointSaver }) as CompiledGraph;
  return agentBuilder.compile() as CompiledGraph;
}
