import { parseArgs } from "node:util";
import { runControllerLab, MODEL_LAB_CASES } from "./fast-controller/lab";
import { createModelDecider, type Measurement } from "./fast-controller/model";
import { createChoiceIdDecider } from "./fast-controller/choice-model";
import { observeOpenRouterFetch, type WireMeasurement } from "./fast-controller/transport";

export const MODEL_LAB_USAGE = "Use --help, --list, or --live --case NAME --model CATALOG_ID --entry router|controller [--controller-model CATALOG_ID] [--reasoning off|provider-default] [--reply tool|choice-id] --max-requests N --max-output-tokens N --duration-ms N. Choice-id asks the generative model for one bound ID without JSON or tool arguments. An optional controller model handles decision-model handoffs through the same executor. Decision models use controller entry and provider-default reasoning; output-token budget applies only to generative models. Live incurs provider charges on synthetic data only. Budgets bound model invocations/output/duration, NOT an exact dollar amount or provider-internal retries. No GUI access. Existing provider credentials are resolved by Nautilo, never CLI arguments.";

export function parseModelLabArguments(args: string[]) {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    help: { type: "boolean" }, list: { type: "boolean" }, live: { type: "boolean" },
    case: { type: "string" }, model: { type: "string" }, entry: { type: "string" }, reasoning: { type: "string" },
    "controller-model": { type: "string" }, "reply": { type: "string" },
    "max-requests": { type: "string" }, "max-output-tokens": { type: "string" }, "duration-ms": { type: "string" },
  } });
  if (args.length === 1 && values.help) return { kind: "help" as const };
  if (args.length === 1 && values.list) return { kind: "list" as const };
  const scenario = MODEL_LAB_CASES.find(item => item === values.case);
  const maxRequests = Number(values["max-requests"]);
  const maxOutputTokens = Number(values["max-output-tokens"]);
  const durationMs = Number(values["duration-ms"]);
  if (!values.live || values.help || values.list || !scenario || !values.model
    || (values.entry !== "router" && values.entry !== "controller")
    || [maxRequests, maxOutputTokens, durationMs].some(value => !Number.isSafeInteger(value) || value < 1)
    // Node/Bun timers otherwise overflow into an immediate deadline.
    || durationMs > 2_147_483_647) throw new Error("invalid_lab_arguments");
  if (values.reasoning !== undefined && values.reasoning !== "off" && values.reasoning !== "provider-default") throw new Error("invalid_reasoning_setting");
  if (values.reply !== undefined && values.reply !== "choice-id" && values.reply !== "tool") throw new Error("invalid_reply_setting");
  const entry: "router" | "controller" = values.entry;
  const reasoning: "off" | "provider-default" = values.reasoning ?? "provider-default";
  return { kind: "live" as const, scenario, modelId: values.model, controllerModelId: values["controller-model"] ?? null,
    entry, reasoning, reply: values.reply ?? "tool", maxRequests, maxOutputTokens, durationMs };
}

export async function runModelLabCli(args: string[]) {
  try {
    const options = parseModelLabArguments(args);
    if (options.kind === "help") { console.log(MODEL_LAB_USAGE); return 0; }
    if (options.kind === "list") {
      console.log(JSON.stringify({ cases: MODEL_LAB_CASES, scope: "Synthetic model decisions only; no Cua or Genie acceptance" }));
      return 0;
    }
    // Only explicit live mode imports provider/configuration code.
    const { hydrateRuntimeModelCatalog, getActiveModelCatalogSync } = await import("../src/config/model-catalog/runtime-catalog");
    const { resolveCatalogModel } = await import("../src/config/resolved-catalog");
    const { createEvaluationModel } = await import("../src/providers/model-evaluation");
    const { invokeChoice, resolveChoiceDriver } = await import("../src/providers/choice-driver");
    await hydrateRuntimeModelCatalog();
    const catalogue = getActiveModelCatalogSync();
    if (!catalogue.catalog.entries.some(row => row.id === options.modelId)) throw new Error("model_not_in_catalogue");
    const modelInfo = resolveCatalogModel(options.modelId);
    const decisionMode = modelInfo.workload === "decision" && resolveChoiceDriver(modelInfo.provider)
      && modelInfo.decision?.operations.includes("choice") && modelInfo.decision;
    if (modelInfo.availability !== "selectable" || (!decisionMode && (modelInfo.workload !== "chat" || modelInfo.features.tools !== true))) {
      throw new Error("model_not_eligible");
    }
    if (decisionMode && (options.entry !== "controller" || options.reasoning !== "provider-default")) throw new Error("decision_model_controller_only");
    if (options.controllerModelId && !decisionMode) throw new Error("controller_requires_decision_model");
    const controllerInfo = options.controllerModelId ? resolveCatalogModel(options.controllerModelId) : null;
    if (controllerInfo && (controllerInfo.availability !== "selectable" || controllerInfo.workload !== "chat"
      || controllerInfo.features.tools !== true || (controllerInfo.maxOutputTokens !== null && options.maxOutputTokens > controllerInfo.maxOutputTokens))) {
      throw new Error("controller_model_not_eligible");
    }
    if (modelInfo.maxOutputTokens !== null && options.maxOutputTokens > modelInfo.maxOutputTokens) throw new Error("output_exceeds_catalogue");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const timer = setTimeout(cancel, options.durationMs);
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    const measurements: Measurement[] = [];
    const wireMeasurements: WireMeasurement[] = [];
    const decisionMeasurements: Array<{ elapsedMs: number; selectedId: string | null; inputTokens: number | null; outputTokens: number | null; costUsd: number | null }> = [];
    const originalFetch = globalThis.fetch;
    const observedFetch = observeOpenRouterFetch(originalFetch, wireMeasurements, () => measurements.at(-1)?.role ?? null);
    globalThis.fetch = observedFetch;
    try {
      const generativeModelId = options.controllerModelId ?? (decisionMode ? null : options.modelId);
      const model = generativeModelId ? await createEvaluationModel(generativeModelId, { maxTokens: options.maxOutputTokens,
        timeoutMs: null, reasoningOutput: false, ...(options.reasoning === "off" ? { reasoningEffort: "off" } : {}) }) : null;
      const report = await runControllerLab({ ...options, signal: controller.signal,
        selectorHandoff: controllerInfo !== null,
        decide: model ? (options.reply === "choice-id" ? createChoiceIdDecider : createModelDecider)(model, measurements)
          : () => Promise.reject(new Error("unexpected_generative_call")),
        ...(decisionMode ? { selector: { modelId: options.modelId, maxChoices: decisionMode.maxChoices,
          choose: async (input: import("../src/providers/choice").ChoiceInput) => {
            const started = performance.now();
            const row = { elapsedMs: 0, selectedId: null as string | null, inputTokens: null as number | null,
              outputTokens: null as number | null, costUsd: null as number | null };
            decisionMeasurements.push(row);
            try {
              const result = await invokeChoice(input);
              row.inputTokens = result.usage.inputTokens;
              row.outputTokens = result.usage.outputTokens;
              row.costUsd = result.usage.actualCostUsd;
              row.selectedId = result.selectedId;
              return result;
            } finally { row.elapsedMs = performance.now() - started; }
          } } } : {}) });
      console.log(JSON.stringify({ ...report, modelId: options.modelId, controllerModelId: options.controllerModelId, reasoning: options.reasoning, reply: options.reply, catalogue: catalogue.provenance,
        callsByRole: { router: measurements.filter(row => row.role === "router").length,
          controller: measurements.filter(row => row.role === "controller").length, system2: 0, decision: decisionMeasurements.length },
        measurements, decisionMeasurements,
        budgets: { maxRequests: options.maxRequests, maxOutputTokens: model ? options.maxOutputTokens : "not_applicable_to_choice", durationMs: options.durationMs },
        wireMeasurements,
        transportAttempts: modelInfo.provider === "openrouter" && (!controllerInfo || controllerInfo.provider === "openrouter")
          ? decisionMeasurements.length + wireMeasurements.length : "not_measured",
        reportedCostUsd: [...wireMeasurements, ...decisionMeasurements].reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
        costCompleteness: [...wireMeasurements, ...decisionMeasurements].length > 0
          && [...wireMeasurements, ...decisionMeasurements].every(row => row.costUsd !== null) ? "reported" : "incomplete",
      }, null, 2));
      return report.phase === "complete" ? 0 : 1;
    } finally {
      clearTimeout(timer);
      if (globalThis.fetch === observedFetch) globalThis.fetch = originalFetch;
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  } catch {
    // Never dump a provider exception, credential value or request payload.
    console.error("Model lab setup failed. Check arguments, catalogue eligibility and configured credentials. " + MODEL_LAB_USAGE);
    return 2;
  }
}

if (import.meta.main) process.exitCode = await runModelLabCli(process.argv.slice(2));
