#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chooseBrowserAction } from "../../../packages/agent/src/graph/browser-choice.ts";
import { configureRuntimeModelCatalog } from "../../../packages/agent/src/config/model-catalog/runtime-catalog.ts";
import { resolveCatalogModel } from "../../../packages/agent/src/config/resolved-catalog.ts";
import {
  ChoiceRequestError,
  invokeChoice,
  type ChoiceInput,
  type ChoiceResult,
} from "../../../packages/agent/src/providers/choice-driver.ts";
import {
  candidatesMatchingExpectation,
  choiceInputReceipt,
  loadBaselineTasks,
  prepareBaselineCase,
  scoreBaselineSelection,
} from "./baseline.ts";

const DEFAULT_MODEL_ID = "openrouter:typesafe/jev-1.13";
const resultsRoot = path.join(import.meta.dir, ".results");

export interface BaselineArgs {
  readonly live: boolean;
  readonly caseId: string | null;
  readonly modelId: string;
}

export function parseBaselineArgs(argv: readonly string[]): BaselineArgs {
  let live = false;
  let caseId: string | null = null;
  let modelId = DEFAULT_MODEL_ID;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--live") live = true;
    else if (value === "--case") {
      caseId = argv[++index] ?? null;
      if (!caseId) throw new Error("--case requires a case id");
    } else if (value === "--model") {
      modelId = argv[++index] ?? "";
      if (!modelId) throw new Error("--model requires a model id");
    } else throw new Error(`Unknown argument: ${value}`);
  }
  return { live, caseId, modelId };
}

function safeError(error: unknown): Record<string, unknown> {
  if (error instanceof ChoiceRequestError) {
    return { name: error.name, code: error.code, status: error.status, retryable: error.retryable };
  }
  return { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) };
}

function isoFilePart(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

export async function runBaseline(args: BaselineArgs): Promise<{ readonly status: number; readonly reportPath: string }> {
  configureRuntimeModelCatalog({ catalogPointerUrl: null });
  const model = resolveCatalogModel(args.modelId);
  const maxChoices = model.decision?.maxChoices;
  if (model.workload !== "decision" || !model.decision?.operations.includes("choice") || maxChoices === undefined) {
    throw new Error(`${args.modelId} is not a catalogued Choice model`);
  }
  const allTasks = await loadBaselineTasks();
  const tasks = args.caseId === null ? allTasks : allTasks.filter(({ caseId }) => caseId === args.caseId);
  if (tasks.length === 0) throw new Error(`Unknown baseline case: ${args.caseId}`);
  const started = new Date();
  const cases: Record<string, unknown>[] = [];
  let failures = 0;

  for (const task of tasks) {
    const controller = new AbortController();
    const prepared = await prepareBaselineCase({ task, modelId: args.modelId, maxChoices, signal: controller.signal });
    const expectedCandidates = candidatesMatchingExpectation(prepared);
    if (expectedCandidates.length === 0) {
      throw new Error(`No generated candidate satisfies the oracle for ${task.caseId}`);
    }
    const requests: ReturnType<typeof choiceInputReceipt>[] = [];
    const providerCalls: Record<string, unknown>[] = [];
    const common = {
      caseId: task.caseId,
      name: task.name,
      sourceUrl: prepared.capture.sourceUrl,
      screenshot: path.join(import.meta.dir, "cases", task.caseId, prepared.capture.screenshot.file),
      plan: prepared.plan,
      deterministic: {
        candidateCount: prepared.candidates.length,
        candidateDigest: prepared.candidateDigest,
        candidates: prepared.input.choices,
      },
      oracle: {
        acceptable: task.acceptable,
        matchingCandidateIds: expectedCandidates.map(({ id }) => id),
      },
    };
    if (!args.live) {
      cases.push({
        ...common,
        jev: { choiceRequests: [choiceInputReceipt(prepared.input)], providerCalls, result: null },
        verdict: "not_run",
      });
      continue;
    }
    try {
      const result = await chooseBrowserAction(prepared.input, maxChoices, async (input: ChoiceInput): Promise<ChoiceResult> => {
        requests.push(choiceInputReceipt(input));
        const captureFetch = (async (request: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
          const call: Record<string, unknown> = {
            request: {
              url: typeof request === "string" ? request : request instanceof URL ? request.href : request.url,
              method: init?.method ?? "GET",
              body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null,
            },
            response: null,
          };
          providerCalls.push(call);
          const response = await globalThis.fetch(request, init);
          call["response"] = {
            status: response.status,
            body: response.ok ? await response.clone().json().catch(() => null) : null,
          };
          return response;
        }) as typeof fetch;
        // The report is the standalone eval's usage ledger; do not require or
        // mutate a Nautilo instance database merely to exercise the provider.
        return invokeChoice(input, { fetch: captureFetch, recordUsage: () => {} });
      });
      const score = scoreBaselineSelection(prepared, result.selectedId);
      if (!score.passed) failures += 1;
      cases.push({
        ...common,
        jev: { choiceRequests: requests, providerCalls, result },
        selectedCandidate: score.selected,
        verdict: score.passed ? "pass" : "fail",
      });
    } catch (error) {
      failures += 1;
      cases.push({
        ...common,
        jev: { choiceRequests: requests, providerCalls, result: null, error: safeError(error) },
        selectedCandidate: null,
        verdict: "error",
      });
    }
  }

  const finished = new Date();
  const summary = {
    total: cases.length,
    passed: cases.filter(({ verdict }) => verdict === "pass").length,
    failed: cases.filter(({ verdict }) => verdict === "fail").length,
    errors: cases.filter(({ verdict }) => verdict === "error").length,
    notRun: cases.filter(({ verdict }) => verdict === "not_run").length,
  };
  const report = {
    schemaVersion: 1,
    mode: args.live ? "live" : "dry-run",
    modelId: args.modelId,
    maxChoices,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    summary,
    cases,
  };
  await mkdir(resultsRoot, { recursive: true });
  const reportPath = path.join(resultsRoot, `${isoFilePart(started)}-${args.live ? "live" : "dry-run"}.json`);
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath, rendered, { encoding: "utf8", mode: 0o600 });
  await writeFile(path.join(resultsRoot, "latest.json"), rendered, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`[eval:browser-visual-grounding] mode=${report.mode} model=${args.modelId}\n`);
  process.stdout.write(`[eval:browser-visual-grounding] total=${summary.total} passed=${summary.passed} failed=${summary.failed} errors=${summary.errors} not_run=${summary.notRun}\n`);
  process.stdout.write(`[eval:browser-visual-grounding] report=${reportPath}\n`);
  return { status: args.live && failures > 0 ? 1 : 0, reportPath };
}

if (import.meta.main) {
  const result = await runBaseline(parseBaselineArgs(process.argv.slice(2)));
  process.exit(result.status);
}
