import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { projectNativeFactors, selectNativeFactorized } from "./native-factorized-selection";
import type { NativeDecisionCandidate } from "../src/graph/native-decision";
import { chooseBrowserAction } from "../src/graph/browser-choice";
import { invokeDecision } from "../src/providers/decision-driver";
import { invokeProviderChoice } from "../src/providers/provider-choice";
import { decisionProvider } from "../src/providers/decision-transport";
import { configureRuntimeModelCatalog } from "../src/config/model-catalog/runtime-catalog";
import { resolveCatalogModel } from "../src/config/resolved-catalog";
import { ChoiceRequestError, type ChoiceInput } from "../src/providers/choice";
import type { RecordUsageInput } from "../src/usage/record-usage";

// Deliberately synthetic, no tool executor, no desktop reads, no secret logging.
export function fixture(count: number, valueCount: number) {
  const values = Object.fromEntries(Array.from({ length: valueCount }, (_, n) => [`value${n}`, `Exact supplied text ${n}`]));
  const controls = Array.from({ length: count }, (_, n) => ({ id: `c${n}`, role: "text_field", label: n === count - 1 ? "Draft title" : `Other field ${n}`, value: "" }));
  const candidates: NativeDecisionCandidate[] = [];
  for (const kind of ["click", "type_text"]) for (const control of controls) for (const name of kind === "click" ? [null] : Object.keys(values)) {
    candidates.push({ id: `a${candidates.length}`, controlId: control.id,
      description: JSON.stringify({ purpose: kind === "click" ? "Select control" : "Insert supplied content", control: control.id,
        operation: { kind, ...(name ? { suppliedValue: name } : {}) } }),
      call: { name: "computer_do", args: { operation: { kind, target: `private:${control.id}`, ...(name ? { text: values[name] } : {}) } } },
    });
  }
  const expected = candidates.at(-1)!.id;
  const controlsIds = ["reobserve", "defer_to_genie", "request_replan"];
  for (const id of controlsIds) candidates.push({ id, description: id === "reobserve" ? "Read fresh state" : "Return to Genie for help", call: null });
  return { candidates, expected, controlsIds, state: { goal: `Insert value${valueCount - 1} into Draft title. Nothing has been inserted yet.`, values, controls } };
}

if (import.meta.main) {
  const args = parseArgs({ options: { live: { type: "boolean" }, model: { type: "string" }, output: { type: "string" }, "max-requests": { type: "string" }, repeats: { type: "string", default: "1" } } }).values;
  if (!args.live || !args.model || !args.output) throw new Error("Required: --live --model CATALOG_ID --output REPORT_PATH --max-requests N");
  const budget = Number(args["max-requests"]);
  if (!Number.isSafeInteger(budget) || budget < 1) throw new Error("Explicit positive request budget required");
  const repeats = Number(args.repeats);
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error("Positive repeat count required");
  configureRuntimeModelCatalog({ catalogPointerUrl: null });
  const model = resolveCatalogModel(args.model);
  const provider = decisionProvider(model.provider);
  if (!provider || model.availability !== "selectable" || !model.decision) throw new Error("Catalogue route is not selectable");
  const signal = AbortSignal.timeout(300_000); // Disposable paid lab wall budget, not product timeout.
  const reports: unknown[] = []; let calls = 0;
  for (let repetition = 0; repetition < repeats; repetition++) for (const [count, valueCount] of [[8, 1], [120, 3], [300, 2]] as const) {
    const sample = fixture(count, valueCount);
    const methods = ["complete_choice", "factorized"] as const;
    for (const method of repetition % 2 === 0 ? methods : [...methods].reverse()) {
      const wire: unknown[] = []; const usage: unknown[] = [];
      const measuredFetch = (async (url: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
        if (calls >= budget) throw new Error("Lab request budget exhausted");
        calls++; const start = performance.now();
        const response = await fetch(url, init);
        const payload = await response.clone().json().catch(() => null) as { usage?: Record<string, unknown> } | null;
        if (typeof init?.body !== "string") throw new Error("Expected JSON transport body");
        const sent = JSON.parse(init.body) as { questions: Record<string, unknown> };
        wire.push({ milliseconds: performance.now() - start, status: response.status,
          requestBytes: Buffer.byteLength(init.body),
          questions: Object.keys(sent.questions).length,
          // Unknown stays unknown; don't claim provider caching from repeated prompts.
          cacheReadTokens: payload?.usage?.["cached_tokens"] ?? payload?.usage?.["cache_read_input_tokens"] ?? null,
        });
        return response;
      }) as typeof fetch;
      const deps = { fetch: measuredFetch, recordUsage: (event: RecordUsageInput) => {
        usage.push({ inputTokens: event.inputTokens ?? null, outputTokens: event.outputTokens ?? null, costUsd: event.actualCostUsd ?? null });
      } };
      const input: ChoiceInput = { modelId: model.id, state: sample.state, signal,
        instructions: "Choose exactly one next action that advances the goal using the supplied text unchanged. Do not click first if an input action can perform the requested insertion.", choices: sample.candidates };
      const choose = (request: ChoiceInput) => {
        const ids = new Set(sample.candidates.filter(c => request.choices.some(choice => choice.id === c.id)).map(c => c.controlId));
        const state = request.choices.some(c => c.id === "none_in_group")
          ? { ...sample.state, controls: sample.state.controls.filter(c => ids.has(c.id)) } : sample.state;
        return invokeProviderChoice(provider, { ...request, state }, deps);
      };
      const start = performance.now();
      try {
        const result = method === "factorized"
          ? await selectNativeFactorized({ input, candidates: sample.candidates, maxChoices: model.decision.maxChoices,
            supportsMultipleQuestions: model.decision.supportsMultipleQuestions === true, choose,
            decide: request => invokeDecision(request, deps) })
          : await chooseBrowserAction(input, model.decision.maxChoices, choose, { controlIds: sample.controlsIds });
        reports.push({ repetition, count, valueCount, method, milliseconds: performance.now() - start, selectedId: result.selectedId,
          correct: result.selectedId === sample.expected, path: "path" in result ? result.path : method,
          fallbackReason: "fallbackReason" in result ? result.fallbackReason : null,
          factorQuestionSizes: Object.values(projectNativeFactors(sample.candidates).questions).map(q => q.type === "choice" ? Object.keys(q.criteria).length : 0), wire, usage });
      } catch (error) {
        reports.push({ repetition, count, valueCount, method, milliseconds: performance.now() - start,
          error: error instanceof ChoiceRequestError ? { code: error.code, status: error.status } : "lab_failure", wire, usage });
      }
      // Persist after every evaluation, including provider failures.
      await writeFile(args.output, JSON.stringify({ model: model.id, maxChoices: model.decision.maxChoices, calls, reports }, null, 2));
      console.log(JSON.stringify(reports.at(-1)));
    }
  }
}
