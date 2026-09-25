import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatModel } from "./types";
import { createUniversalModel } from "./universal";
import { CHOICE_ID_INSTRUCTIONS, parseChoiceIdResponse } from "./choice-id";
import { NATIVE_CONTROLLER_MODEL_OPTIONS, resolveNativeControllerModel } from "../config/native-decision-model";
import type { NativeExecutionReply, NativeExecutionRoots } from "../graph/native-execution";
import { selectNativeOperation, type NativeBindingCapability } from "../graph/native-operation-binding";
import { ChoiceRequestError } from "./choice";
import { classifyError } from "../utils/errors";
import { invokeDecision } from "./decision-driver";
import { resolveCatalogModel } from "../config/resolved-catalog";
import { invokeChoice } from "./choice-driver";
import { modelSupportsInput } from "@nautilo/model-capabilities";

export interface NativeExecutionInput {
  modelId: string;
  /** Already admitted Choice model for CUA action/routing and input decisions. */
  decisionModelId?: string;
  signal: AbortSignal;
  capabilities: readonly NativeBindingCapability[];
  state: Record<string, unknown>;
  /** Private captured bytes, never serialized wholesale to the provider. */
  roots?: NativeExecutionRoots;
  completion?: Extract<NativeExecutionReply, { kind: "complete" }> | undefined;
  completionNominated?: boolean | undefined;
  images?: Exclude<BaseMessage["content"], string>;
  onProgress?: (progress: { modelCalls: number; usage: NativeExecutionResult["usage"]; modelUsage: NativeModelUsage[] }) => void;
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
const metric = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
export interface NativeExecutionResult {
  decision: NativeExecutionReply;
  modelId: string;
  modelCalls?: number;
  modelUsage?: NativeModelUsage[];
  usage: { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; actualCostUsd: number | null };
}
interface NativeModelAttempt {
  /** UTF-8 request-payload sizes, not decoded image pixels or token estimates. */
  stage: string; route: "choice" | "typed_choice" | "interpreter"; candidateCount: number;
  sourceCount: number | null; textBytes: number; imageBytes: number; elapsedMs: number | null;
  outcome: "pending" | "returned" | "failed" | "cancelled";
}
interface NativeModelUsage { modelId: string; modelCalls: number; usage: NativeExecutionResult["usage"]; attempts: NativeModelAttempt[] }
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
const stageOf = (state: unknown) => {
  const row = record(state);
  return typeof row["decisionStage"] === "string" ? row["decisionStage"] : row["review"] ? "completion_review" : row["inputScope"] ? "input_binding"
    : row["question"] ? "operation_or_recovery" : "operation_selection";
};
const sourceCountOf = (state: unknown) => metric(record(state)["sourceCount"]);

/** Selection-only adapter. Code owns schemas, source references and JSON
 * construction. Each model invocation is counted, including rejected IDs;
 * transport-level retries require the separate wire telemetry. */
export async function invokeNativeExecution(input: NativeExecutionInput, createModel: (id: string, options?: Record<string, unknown>) => Promise<ChatModel> = createUniversalModel,
  decide: typeof invokeDecision = invokeDecision, choose: typeof invokeChoice = invokeChoice): Promise<NativeExecutionResult> {
  input.signal.throwIfAborted();
  if (!input.roots) throw new Error("native_execution_sources_missing");
  // A complete text-grounded action needs no Flash initialization or call.
  let model: Promise<ChatModel> | undefined;
  const usage: NativeExecutionResult["usage"] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, actualCostUsd: 0 };
  let modelCalls = 0;
  const byModel = new Map<string, NativeModelUsage>();
  const attempt = (modelId: string, metric: Omit<NativeModelAttempt, "elapsedMs" | "outcome">) => {
    modelCalls++;
    let row = byModel.get(modelId);
    if (!row) { row = { modelId, modelCalls: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, actualCostUsd: 0 }, attempts: [] }; byModel.set(modelId, row); }
    row.modelCalls++;
    const attemptRow: NativeModelAttempt = { ...metric, elapsedMs: null, outcome: "pending" };
    row.attempts.push(attemptRow);
    return { row, attemptRow, started: performance.now() };
  };
  const account = (row: NativeModelUsage, current: NativeExecutionResult["usage"]) => {
    for (const key of Object.keys(usage) as (keyof typeof usage)[]) {
      usage[key] = usage[key] === null || current[key] === null ? null : usage[key] + current[key];
      row.usage[key] = row.usage[key] === null || current[key] === null ? null : row.usage[key] + current[key];
    }
  };
  const unknownUsage = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, actualCostUsd: null };
  const progress = () => input.onProgress?.({ modelCalls, usage: { ...usage }, modelUsage: structuredClone([...byModel.values()]) });
  const choiceModel = input.decisionModelId ? resolveCatalogModel(input.decisionModelId) : null;
  const operationChoice = choiceModel?.availability === "selectable" && choiceModel.workload === "decision"
    && choiceModel.decision?.operations.includes("choice");
  const typedInputs = operationChoice && choiceModel.decision!.supportsMultipleQuestions;
  // No authored bodies, full control collection or opaque handles in shared
  // screening context. Candidate-specific source evidence is projected later.
  const summarize = (value: unknown): unknown => {
    if (Array.isArray(value)) return { count: value.length };
    if (value && typeof value === "object") {
      if (typeof record(value)["reference"] === "string" && typeof record(value)["context"] === "string") return { boundTargetAvailable: true };
      return Object.fromEntries(Object.entries(record(value)).map(([key, child]) => [key, summarize(child)]));
    }
    return value;
  };
  const state = { ...input.state, request: input.roots.request, values: Object.keys(input.roots.values), observation: summarize(input.roots.observation),
    visualEvidenceAvailable: !!input.images?.length,
    decisionRoles: {
      selector: { modelId: choiceModel?.id ?? null, input: "text evidence and supplied choices only",
        suitableFor: "Compare grounded action/input candidates using the delegated goal, current evidence and prior outcomes",
        cannot: "See screenshots, invent candidates, author missing content or execute actions" },
      interpreter: { modelId: input.modelId || null, suppliedImages: input.images?.length ?? 0,
        suitableFor: "Handle moderately complex multi-step execution, resolve ambiguity from available evidence, interpret supplied screenshots/layout and adapt after recoverable errors using the same supported tools",
        cannot: "See an image not supplied, assume unobserved UI state, invent target authority, rewrite supplied content or execute outside ordinary admission" },
      genie: { role: "existing user-selected Genie",
        suitableFor: "Resolve intent that available evidence cannot settle, author missing content, perform deep reasoning or long-range planning, or redefine an approach the fast interpreter cannot resolve; retain completed work",
        cannot: "Treat an unknown effect as not executed, gain authority by replanning or discard the user's original constraints" },
    } };
  const decision = await selectNativeOperation({ capabilities: input.capabilities, roots: input.roots,
    state, completion: input.completion, completionNominated: input.completionNominated,
    ...(operationChoice ? { operationDecision: { modelId: choiceModel.id, maxChoices: choiceModel.decision!.maxChoices,
      choose: async request => {
        request.signal.throwIfAborted();
        const measuredAttempt = attempt(choiceModel.id, { stage: stageOf(request.state), route: "choice",
          candidateCount: request.choices.length, sourceCount: sourceCountOf(request.state),
          textBytes: bytes([request.instructions, request.state, request.choices]), imageBytes: 0 });
        let measured = false;
        try {
          const result = await choose(request);
          account(measuredAttempt.row, { ...result.usage, cacheReadTokens: null, cacheWriteTokens: null });
          measured = true;
          measuredAttempt.attemptRow.outcome = "returned";
          request.signal.throwIfAborted();
          return result;
        } finally {
          if (!measured) account(measuredAttempt.row, unknownUsage);
          if (request.signal.aborted) measuredAttempt.attemptRow.outcome = "cancelled";
          else if (measuredAttempt.attemptRow.outcome === "pending") measuredAttempt.attemptRow.outcome = "failed";
          measuredAttempt.attemptRow.elapsedMs = performance.now() - measuredAttempt.started;
          progress();
        }
      } } } : {}),
    ...(typedInputs ? { inputDecision: { modelId: choiceModel.id, maxChoices: choiceModel.decision!.maxChoices,
      decide: async request => {
        request.signal.throwIfAborted();
        const measuredAttempt = attempt(choiceModel.id, { stage: "input_binding", route: "typed_choice",
          candidateCount: Object.values(request.questions).reduce((count, question) => count + Object.keys(record(question["criteria"])).length, 0),
          sourceCount: sourceCountOf(request.state),
          textBytes: bytes([request.questions, request.state]), imageBytes: 0 });
        let measured = false;
        try {
          const result = await decide(request);
          account(measuredAttempt.row, { ...result.usage, cacheReadTokens: null, cacheWriteTokens: null });
          measured = true;
          measuredAttempt.attemptRow.outcome = "returned";
          input.signal.throwIfAborted();
          return result;
        } finally {
          if (!measured) account(measuredAttempt.row, unknownUsage);
          if (request.signal.aborted) measuredAttempt.attemptRow.outcome = "cancelled";
          else if (measuredAttempt.attemptRow.outcome === "pending") measuredAttempt.attemptRow.outcome = "failed";
          measuredAttempt.attemptRow.elapsedMs = performance.now() - measuredAttempt.started;
          progress();
        }
      } } } : {}),
    modelId: input.modelId ?? input.decisionModelId ?? "", signal: input.signal, choose: async request => {
      request.signal.throwIfAborted();
      // Text-grounded field/option binding does not retransmit the observation
      // image. A visual interpretation escape still receives the full current
      // image set; no crop or evidence is silently dropped on that route.
      const images = record(request.state)["evidenceMode"] === "text" ? [] : input.images ?? [];
      const admitted = input.modelId ? resolveNativeControllerModel(input.modelId) : null;
      if (!admitted || (images.length && !modelSupportsInput(admitted.id, "image"))) {
        throw new ChoiceRequestError("unsupported_model");
      }
      model ??= createModel(admitted.id, NATIVE_CONTROLLER_MODEL_OPTIONS);
      const middle = await model;
      request.signal.throwIfAborted();
      const measuredAttempt = attempt(admitted.id, { stage: stageOf(request.state), route: "interpreter",
        candidateCount: request.choices.length, sourceCount: sourceCountOf(request.state),
        textBytes: bytes([request.instructions, request.state, request.choices]),
        imageBytes: images.length ? bytes(images) : 0 });
      let measured = false;
      try {
        const response = record(await middle.invoke([
          new SystemMessage(request.instructions + "\n" + CHOICE_ID_INSTRUCTIONS
            + (input.state["readbackFailed"] === true
              ? "\nThe last readback failed. Inspect its outcome and choose fresh acquisition or another supported read route; do not blindly refresh a stale target. Mutation and completion remain blocked until fresh state is available."
              : "")),
          new HumanMessage({ content: [{ type: "text", text: JSON.stringify({ state: request.state, choices: request.choices }) }, ...images] }),
        ], { signal: request.signal, metadata: { nautilo_output_visibility: "internal_decision" } }));
        const raw = record(response["usage_metadata"]);
        const details = record(raw["input_token_details"]);
        const current = { inputTokens: metric(raw["input_tokens"]), outputTokens: metric(raw["output_tokens"]),
          cacheReadTokens: metric(details["cache_read"]), cacheWriteTokens: metric(details["cache_creation"]),
          actualCostUsd: metric(record(record(response["response_metadata"])["usage"])["cost"]) };
        account(measuredAttempt.row, current);
        measured = true;
        measuredAttempt.attemptRow.outcome = "returned";
        input.signal.throwIfAborted();
        const selectedId = parseChoiceIdResponse(response, request.choices.map(choice => choice.id));
        return { selectedId, requestedModelId: admitted.id, resolvedModelId: admitted.id,
          usage: { inputTokens: current.inputTokens ?? 0, outputTokens: current.outputTokens ?? 0, actualCostUsd: current.actualCostUsd } };
      } catch (error) {
        // A failed transport may still have incurred usage. Missing accounting
        // is unknown, never a zero-cost attempt or a complete subtotal.
        if (!measured) account(measuredAttempt.row, unknownUsage);
        if (classifyError(error).category === "TOKEN_LIMIT") throw new ChoiceRequestError("context_length_exceeded");
        throw error;
      } finally {
        if (request.signal.aborted) measuredAttempt.attemptRow.outcome = "cancelled";
        else if (measuredAttempt.attemptRow.outcome === "pending") measuredAttempt.attemptRow.outcome = "failed";
        measuredAttempt.attemptRow.elapsedMs = performance.now() - measuredAttempt.started;
        progress();
      }
    } });
  input.signal.throwIfAborted();
  return { decision, modelId: byModel.size === 1 ? [...byModel.keys()][0]! : input.decisionModelId ?? input.modelId ?? "", modelCalls, usage, modelUsage: [...byModel.values()] };
}
