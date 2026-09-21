#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AIMessage, HumanMessage, type BaseMessageLike } from "@langchain/core/messages";
import { createEvaluationModel } from "@nautilo/agent/model-evaluation";
import { configureRuntimeModelCatalog } from "../../../packages/agent/src/config/model-catalog/runtime-catalog.ts";
import { resolveCatalogModel } from "../../../packages/agent/src/config/resolved-catalog.ts";
import { ChoiceRequestError } from "../../../packages/agent/src/providers/choice-driver.ts";
import { loadBaselineTasks, loadCapture } from "./baseline.ts";
import { runCapturedJevChoice } from "./jev-evaluation.ts";
import {
  loadVisualOracles,
  parseVisualGrounding,
  prepareVisualDecision,
  scoreVisualSelection,
  VISUAL_GROUNDING_PROMPT,
} from "./visual-grounding.ts";

const DEFAULT_VISION_MODEL_ID = "openai:gpt-5.6-sol";
const DEFAULT_DECISION_MODEL_ID = "openrouter:typesafe/jev-1.13";
const resultsRoot = path.join(import.meta.dir, ".results");

export interface VisualBaselineArgs {
  readonly live: boolean;
  readonly caseId: string | null;
  readonly visionModelId: string;
  readonly decisionModelId: string;
}

export function parseVisualBaselineArgs(argv: readonly string[]): VisualBaselineArgs {
  let live = false;
  let caseId: string | null = null;
  let visionModelId = DEFAULT_VISION_MODEL_ID;
  let decisionModelId = DEFAULT_DECISION_MODEL_ID;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--live") live = true;
    else if (value === "--case") {
      caseId = argv[++index] ?? null;
      if (!caseId) throw new Error("--case requires a case id");
    } else if (value === "--vision-model") {
      visionModelId = argv[++index] ?? "";
      if (!visionModelId) throw new Error("--vision-model requires a model id");
    } else if (value === "--decision-model") {
      decisionModelId = argv[++index] ?? "";
      if (!decisionModelId) throw new Error("--decision-model requires a model id");
    } else throw new Error(`Unknown argument: ${value}`);
  }
  return { live, caseId, visionModelId, decisionModelId };
}

function safeError(error: unknown): Record<string, unknown> {
  if (error instanceof ChoiceRequestError) {
    return { name: error.name, code: error.code, status: error.status, retryable: error.retryable };
  }
  return { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) };
}

function flattenAiContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object" || Array.isArray(part)) return "";
    const text = (part as Record<string, unknown>)["text"];
    return typeof text === "string" ? text : "";
  }).join("");
}

export function parseVisualGroundingText(
  text: string,
  image: { readonly width: number; readonly height: number },
) {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return parseVisualGrounding(JSON.parse(fenced?.[1] ?? trimmed) as unknown, image);
}

function isoFilePart(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

export async function runVisualBaseline(
  args: VisualBaselineArgs,
): Promise<{ readonly status: number; readonly reportPath: string }> {
  configureRuntimeModelCatalog({ catalogPointerUrl: null });
  const decisionModel = resolveCatalogModel(args.decisionModelId);
  const maxChoices = decisionModel.decision?.maxChoices;
  if (decisionModel.workload !== "decision"
    || !decisionModel.decision?.operations.includes("choice")
    || maxChoices === undefined) {
    throw new Error(`${args.decisionModelId} is not a catalogued Choice model`);
  }
  const allTasks = await loadBaselineTasks();
  const allOracles = await loadVisualOracles();
  const tasks = args.caseId === null ? allTasks : allTasks.filter(({ caseId }) => caseId === args.caseId);
  if (tasks.length === 0) throw new Error(`Unknown visual baseline case: ${args.caseId}`);
  const oracleByCase = new Map(allOracles.map((oracle) => [oracle.caseId, oracle]));
  const started = new Date();
  const cases: Record<string, unknown>[] = [];
  let failures = 0;
  const visionModel = args.live ? await createEvaluationModel(args.visionModelId, {
    useOpenAIResponsesApi: true,
    reasoningEffort: "low",
    reasoningOutput: false,
    timeoutMs: null,
  }) : null;

  for (const task of tasks) {
    const oracle = oracleByCase.get(task.caseId);
    if (!oracle) throw new Error(`Missing visual oracle for ${task.caseId}`);
    const capture = await loadCapture(task.caseId);
    const screenshotPath = path.join(import.meta.dir, "cases", task.caseId, capture.screenshot.file);
    const common = {
      caseId: task.caseId,
      name: task.name,
      sourceUrl: capture.sourceUrl,
      screenshot: screenshotPath,
      screenshotSha256: capture.screenshot.sha256,
      plan: task.plan,
      oracle,
    };
    if (!args.live) {
      cases.push({ ...common, sol: null, visualSnapshot: null, jev: null, verdict: "not_run" });
      continue;
    }
    const controller = new AbortController();
    try {
      const png = await readFile(screenshotPath);
      const prompt = `${VISUAL_GROUNDING_PROMPT}\n\nScreenshot dimensions: ${capture.viewport.image.width}x${capture.viewport.image.height} image pixels.`;
      const message = new HumanMessage({ content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } },
      ] });
      const response = await visionModel!.invoke([message] as BaseMessageLike[], { signal: controller.signal });
      if (!AIMessage.isInstance(response)) throw new Error("Sol returned a non-AI message");
      const rawText = flattenAiContent(response.content).trim();
      if (!rawText) throw new Error("Sol returned no textual grounding");
      const grounding = parseVisualGroundingText(rawText, capture.viewport.image);
      const prepared = prepareVisualDecision({
        task,
        capture,
        grounding,
        modelId: args.decisionModelId,
        signal: controller.signal,
      });
      const jev = await runCapturedJevChoice(prepared.input, maxChoices);
      const score = scoreVisualSelection(prepared, oracle, jev.result.selectedId);
      if (!score.passed) failures += 1;
      cases.push({
        ...common,
        sol: {
          modelId: args.visionModelId,
          prompt,
          rawText,
          usage: response.usage_metadata,
          grounding,
        },
        visualSnapshot: prepared.snapshot,
        candidates: prepared.input.choices,
        jev,
        selectedCandidate: score.selected,
        verdict: score.passed ? "pass" : "fail",
      });
    } catch (error) {
      failures += 1;
      cases.push({ ...common, sol: null, visualSnapshot: null, jev: null, verdict: "error", error: safeError(error) });
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
    approach: "sol-screenshot-to-snapshot-to-jev",
    mode: args.live ? "live" : "dry-run",
    visionModelId: args.visionModelId,
    decisionModelId: args.decisionModelId,
    maxChoices,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    summary,
    cases,
  };
  await mkdir(resultsRoot, { recursive: true });
  const reportPath = path.join(resultsRoot, `${isoFilePart(started)}-visual-${args.live ? "live" : "dry-run"}.json`);
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath, rendered, { encoding: "utf8", mode: 0o600 });
  await writeFile(path.join(resultsRoot, "visual-latest.json"), rendered, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`[eval:browser-visual-grounding] approach=sol-screenshot-to-snapshot-to-jev mode=${report.mode}\n`);
  process.stdout.write(`[eval:browser-visual-grounding] total=${summary.total} passed=${summary.passed} failed=${summary.failed} errors=${summary.errors} not_run=${summary.notRun}\n`);
  process.stdout.write(`[eval:browser-visual-grounding] report=${reportPath}\n`);
  return { status: args.live && failures > 0 ? 1 : 0, reportPath };
}

if (import.meta.main) {
  const result = await runVisualBaseline(parseVisualBaselineArgs(process.argv.slice(2)));
  process.exit(result.status);
}
