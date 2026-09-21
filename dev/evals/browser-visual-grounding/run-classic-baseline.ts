#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { configureRuntimeModelCatalog } from "../../../packages/agent/src/config/model-catalog/runtime-catalog.ts";
import { resolveCatalogModel } from "../../../packages/agent/src/config/resolved-catalog.ts";
import { ChoiceRequestError } from "../../../packages/agent/src/providers/choice-driver.ts";
import { loadBaselineTasks, loadCapture } from "./baseline.ts";
import {
  detectPerceptualEdgeRegions,
  extractMacosVisionGrounding,
  extractPpocrGrounding,
  extractPortableGrounding,
  type ClassicBackend,
  type ClassicExtraction,
  type MacosVisionRawResult,
  type PpocrRawResult,
} from "./classic-grounding.ts";
import { runCapturedJevChoice } from "./jev-evaluation.ts";
import {
  loadVisualOracles,
  prepareVisualDecision,
  scoreVisualSelection,
} from "./visual-grounding.ts";

const DEFAULT_DECISION_MODEL_ID = "openrouter:typesafe/jev-1.13";
const resultsRoot = path.join(import.meta.dir, ".results");

export interface ClassicBaselineArgs {
  readonly live: boolean;
  readonly caseId: string | null;
  readonly backends: readonly ClassicBackend[];
  readonly decisionModelId: string;
}

export function parseClassicBaselineArgs(argv: readonly string[]): ClassicBaselineArgs {
  let live = false;
  let caseId: string | null = null;
  let backends: readonly ClassicBackend[] = process.platform === "darwin"
    ? ["macos-vision", "macos-vision-accurate", "portable", "ppocr-v6-tiny", "ppocr-v6-small"]
    : ["portable", "ppocr-v6-tiny", "ppocr-v6-small"];
  let decisionModelId = DEFAULT_DECISION_MODEL_ID;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--live") live = true;
    else if (value === "--case") {
      caseId = argv[++index] ?? null;
      if (!caseId) throw new Error("--case requires a case id");
    } else if (value === "--backend") {
      const backend = argv[++index];
      if (backend === "all") {
        backends = process.platform === "darwin"
          ? ["macos-vision", "macos-vision-accurate", "portable", "ppocr-v6-tiny", "ppocr-v6-small"]
          : ["portable", "ppocr-v6-tiny", "ppocr-v6-small"];
      } else if (backend === "macos-vision" || backend === "macos-vision-accurate" || backend === "portable"
        || backend === "ppocr-v6-tiny" || backend === "ppocr-v6-small") backends = [backend];
      else throw new Error("--backend requires all or a supported local extractor name");
    } else if (value === "--decision-model") {
      decisionModelId = argv[++index] ?? "";
      if (!decisionModelId) throw new Error("--decision-model requires a model id");
    } else throw new Error(`Unknown argument: ${value}`);
  }
  if (backends.some((backend) => backend.startsWith("macos-vision")) && process.platform !== "darwin") {
    throw new Error("macos-vision backends are available only on macOS");
  }
  return { live, caseId, backends, decisionModelId };
}

function safeError(error: unknown): Record<string, unknown> {
  if (error instanceof ChoiceRequestError) {
    return { name: error.name, code: error.code, status: error.status, retryable: error.retryable };
  }
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function isoFilePart(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

async function extractMacosVision(
  screenshots: readonly string[],
  recognition: "fast" | "accurate",
  backend: "macos-vision" | "macos-vision-accurate",
): Promise<ReadonlyMap<string, ClassicExtraction>> {
  const helperPath = path.join(import.meta.dir, "macos-vision.swift");
  const subprocess = Bun.spawn(["swift", helperPath, "--recognition", recognition, ...screenshots], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  if (exitCode !== 0) throw new Error(`macOS Vision helper failed: ${stderr.trim()}`);
  const results = stdout.split(/\r?\n/u).filter(Boolean).map((line) =>
    extractMacosVisionGrounding(JSON.parse(line) as MacosVisionRawResult, backend));
  if (results.length !== screenshots.length) {
    throw new Error(`macOS Vision helper returned ${results.length} results for ${screenshots.length} screenshots`);
  }
  return new Map(results.map((result, index) => [screenshots[index]!, result]));
}

async function extractPpocr(
  screenshots: readonly string[],
  tier: "tiny" | "small",
): Promise<ReadonlyMap<string, PpocrRawResult>> {
  const helperPath = path.join(import.meta.dir, "ppocr-v6.py");
  const subprocess = Bun.spawn([
    "uv", "run", "--quiet", "--python", "3.12",
    "--with", "rapidocr>=3.9,<4",
    "--with", "onnxruntime>=1.22,<2",
    helperPath, "--tier", tier, ...screenshots,
  ], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  if (exitCode !== 0) throw new Error(`PP-OCRv6 ${tier} helper failed: ${stderr.trim()}`);
  const results = stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as PpocrRawResult);
  if (results.length !== screenshots.length) {
    throw new Error(`PP-OCRv6 ${tier} helper returned ${results.length} results for ${screenshots.length} screenshots`);
  }
  return new Map(results.map((result) => [path.resolve(result.imagePath), result]));
}

function candidateIdsInOracle(
  extraction: ClassicExtraction,
  oracle: Awaited<ReturnType<typeof loadVisualOracles>>[number],
  candidateIds: readonly string[],
): string[] {
  const { region } = oracle.expectedTarget;
  const matchingPrefixes = extraction.grounding.targets.flatMap((target, index) =>
    target.x >= region.xMin && target.x <= region.xMax && target.y >= region.yMin && target.y <= region.yMax
      ? [`visual_v${index + 1}`]
      : []);
  return candidateIds.filter((candidateId) => matchingPrefixes.some((prefix) =>
    candidateId === prefix || candidateId.startsWith(`${prefix}_value_`)));
}

export async function runClassicBaseline(
  args: ClassicBaselineArgs,
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
  const tasks = args.caseId === null ? allTasks : allTasks.filter(({ caseId }) => caseId === args.caseId);
  if (!tasks.length) throw new Error(`Unknown classic visual baseline case: ${args.caseId}`);
  const oracles = new Map((await loadVisualOracles()).map((oracle) => [oracle.caseId, oracle]));
  const captures = await Promise.all(tasks.map(async (task) => ({ task, capture: await loadCapture(task.caseId) })));
  const screenshots = captures.map(({ task, capture }) =>
    path.join(import.meta.dir, "cases", task.caseId, capture.screenshot.file));
  const macosExtractions = args.backends.includes("macos-vision")
    ? await extractMacosVision(screenshots, "fast", "macos-vision")
    : new Map<string, ClassicExtraction>();
  const macosAccurateExtractions = args.backends.includes("macos-vision-accurate")
    ? await extractMacosVision(screenshots, "accurate", "macos-vision-accurate")
    : new Map<string, ClassicExtraction>();
  const [ppocrTiny, ppocrSmall] = await Promise.all([
    args.backends.includes("ppocr-v6-tiny") ? extractPpocr(screenshots, "tiny") : new Map<string, PpocrRawResult>(),
    args.backends.includes("ppocr-v6-small") ? extractPpocr(screenshots, "small") : new Map<string, PpocrRawResult>(),
  ]);
  const started = new Date();
  const cases: Record<string, unknown>[] = [];
  let failures = 0;

  for (let index = 0; index < captures.length; index += 1) {
    const { task, capture } = captures[index]!;
    const screenshot = screenshots[index]!;
    const oracle = oracles.get(task.caseId);
    if (!oracle) throw new Error(`Missing visual oracle for ${task.caseId}`);
    for (const backend of args.backends) {
      const caseStarted = performance.now();
      try {
        let extraction: ClassicExtraction | undefined;
        if (backend === "macos-vision") extraction = macosExtractions.get(screenshot);
        else if (backend === "macos-vision-accurate") extraction = macosAccurateExtractions.get(screenshot);
        else if (backend === "portable") extraction = await extractPortableGrounding(screenshot);
        else {
          const raw = (backend === "ppocr-v6-tiny" ? ppocrTiny : ppocrSmall).get(path.resolve(screenshot));
          if (raw) extraction = extractPpocrGrounding(raw, await detectPerceptualEdgeRegions(screenshot), backend);
        }
        if (!extraction) throw new Error(`Missing ${backend} extraction for ${task.caseId}`);
        const extractionMs = extraction.timing["totalMs"];
        if (extractionMs === undefined) throw new Error(`${backend} did not report extraction timing`);
        const prepared = prepareVisualDecision({
          task,
          capture,
          grounding: extraction.grounding,
          modelId: args.decisionModelId,
          signal: new AbortController().signal,
        });
        const matchingCandidateIds = candidateIdsInOracle(
          extraction,
          oracle,
          prepared.input.choices.map(({ id }) => id),
        );
        const coveragePassed = matchingCandidateIds.length > 0;
        let jev: Awaited<ReturnType<typeof runCapturedJevChoice>> | null = null;
        let selectedCandidate = null;
        let decisionPassed: boolean | null = null;
        let jevMs: number | null = null;
        if (args.live) {
          const jevStarted = performance.now();
          jev = await runCapturedJevChoice(prepared.input, maxChoices);
          jevMs = performance.now() - jevStarted;
          const score = scoreVisualSelection(prepared, oracle, jev.result.selectedId);
          selectedCandidate = score.selected;
          decisionPassed = score.passed;
        }
        if (!coveragePassed || decisionPassed === false) failures += 1;
        cases.push({
          caseId: task.caseId,
          name: task.name,
          backend,
          screenshot,
          screenshotSha256: capture.screenshot.sha256,
          plan: task.plan,
          oracle,
          extraction: {
            timing: extraction.timing,
            rawCounts: extraction.rawCounts,
            text: extraction.text,
            regions: extraction.regions,
            grounding: extraction.grounding,
          },
          visualSnapshot: prepared.snapshot,
          candidates: prepared.input.choices,
          coverage: { passed: coveragePassed, matchingCandidateIds },
          jev,
          selectedCandidate,
          timing: {
            extractionMs,
            jevMs,
            totalMs: extractionMs + (jevMs ?? 0),
          },
          verdict: !coveragePassed ? "coverage_fail" : decisionPassed === false ? "decision_fail" : decisionPassed ? "pass" : "not_run",
        });
      } catch (error) {
        failures += 1;
        cases.push({
          caseId: task.caseId,
          name: task.name,
          backend,
          screenshot,
          plan: task.plan,
          oracle,
          verdict: "error",
          error: safeError(error),
          timing: { totalMs: performance.now() - caseStarted },
        });
      }
    }
  }

  const backendSummaries = Object.fromEntries(args.backends.map((backend) => {
    const backendCases = cases.filter((entry) => entry["backend"] === backend);
    const timingValues = backendCases.flatMap((entry) => {
      const timing = entry["timing"] as Record<string, unknown> | undefined;
      return typeof timing?.["extractionMs"] === "number" ? [timing["extractionMs"]] : [];
    });
    return [backend, {
      total: backendCases.length,
      covered: backendCases.filter((entry) => (entry["coverage"] as { passed?: boolean } | undefined)?.passed).length,
      passed: backendCases.filter((entry) => entry["verdict"] === "pass").length,
      failed: backendCases.filter((entry) => String(entry["verdict"]).endsWith("_fail")).length,
      errors: backendCases.filter((entry) => entry["verdict"] === "error").length,
      notRun: backendCases.filter((entry) => entry["verdict"] === "not_run").length,
      extractionMs: timingValues.length ? {
        total: timingValues.reduce((sum, value) => sum + value, 0),
        average: timingValues.reduce((sum, value) => sum + value, 0) / timingValues.length,
        maximum: Math.max(...timingValues),
      } : null,
    }];
  }));
  const finished = new Date();
  const report = {
    schemaVersion: 1,
    approach: "local-classic-screenshot-to-snapshot-to-jev",
    mode: args.live ? "live" : "extraction-only",
    backends: args.backends,
    decisionModelId: args.decisionModelId,
    maxChoices,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    summary: backendSummaries,
    cases,
  };
  await mkdir(resultsRoot, { recursive: true });
  const reportPath = path.join(resultsRoot, `${isoFilePart(started)}-classic-${args.live ? "live" : "extraction"}.json`);
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath, rendered, { encoding: "utf8", mode: 0o600 });
  await writeFile(path.join(resultsRoot, "classic-latest.json"), rendered, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`[eval:browser-visual-grounding] approach=${report.approach} mode=${report.mode}\n`);
  for (const [backend, summary] of Object.entries(backendSummaries)) {
    process.stdout.write(`[eval:browser-visual-grounding] backend=${backend} ${JSON.stringify(summary)}\n`);
  }
  process.stdout.write(`[eval:browser-visual-grounding] report=${reportPath}\n`);
  return { status: failures > 0 ? 1 : 0, reportPath };
}

if (import.meta.main) {
  const result = await runClassicBaseline(parseClassicBaselineArgs(process.argv.slice(2)));
  process.exit(result.status);
}
