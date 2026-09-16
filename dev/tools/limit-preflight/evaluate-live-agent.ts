#!/usr/bin/env bun

import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

type Scenario = {
  id: string;
  shape: string;
  expected: { classification: string; disposition: string };
  requiredReview: string[];
  forbiddenShortcut: string;
};

type EvaluationResult = {
  id: string;
  classification: string;
  disposition: string;
  scannerFact: string;
  authority: string;
  lossAndCompleteness: string;
  visibility: string;
  continuationOrRecovery: string;
  addressedReview: string[];
  rejectedShortcut: boolean;
  rationale: string;
};

const repositoryRoot = resolve(import.meta.dir, "../../..");
const scenarioPath = join(import.meta.dir, "fixtures/review-scenarios.json");
const skillPath = join(import.meta.dir, "codex/skills/limit-preflight/SKILL.md");

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function allowedDispositions(expected: string): readonly string[] {
  if (expected === "remove_or_redesign") return ["remove", "redesign"];
  if (expected === "retain_with_proof") return ["retain"];
  if (expected === "surface_or_redesign") return ["redesign", "defer_named"];
  return [expected];
}

async function run(): Promise<void> {
  const model = argument("--model");
  if (!model) throw new Error("Usage: bun evaluate-live-agent.ts --model MODEL [--output PATH]");
  const outputPath = resolve(repositoryRoot, argument("--output") ?? "dev/tools/limit-preflight/fixtures/live-agent-evaluation.json");
  const scenarioContent = await readFile(scenarioPath, "utf8");
  const scenarios = (JSON.parse(scenarioContent) as { cases: Scenario[] }).cases;
  const skill = await readFile(skillPath, "utf8");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "nautilo-limit-agent-eval-"));
  const schemaPath = join(temporaryDirectory, "schema.json");
  const responsePath = join(temporaryDirectory, "response.json");
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "classification", "disposition", "scannerFact", "authority", "lossAndCompleteness", "visibility", "continuationOrRecovery", "addressedReview", "rejectedShortcut", "rationale"],
          properties: {
            id: { type: "string" },
            classification: { type: "string" },
            disposition: { type: "string" },
            scannerFact: { type: "string" },
            authority: { type: "string" },
            lossAndCompleteness: { type: "string" },
            visibility: { type: "string" },
            continuationOrRecovery: { type: "string" },
            addressedReview: { type: "array", items: { type: "string" } },
            rejectedShortcut: { type: "boolean" },
            rationale: { type: "string" },
          },
        },
      },
    },
  };
  await Bun.write(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);
  const prompt = [
    "Evaluate every supplied limit-preflight scenario using the supplied skill instructions.",
    "The scenario shape is the only repository fact available; do not use tools or invent implementation evidence.",
    "Use only canonical classifications and dispositions from the skill.",
    "For addressedReview, copy each requiredReview string only when your other fields actually address it.",
    "Set rejectedShortcut=true only when you explicitly avoid the forbidden shortcut in your reasoning.",
    "Return exactly one result per scenario, in scenario order.",
    "",
    "SKILL:",
    skill,
    "",
    "SCENARIOS:",
    scenarioContent,
  ].join("\n");
  const processResult = Bun.spawnSync([
    "codex", "exec", "--ephemeral", "--ignore-user-config", "--sandbox", "read-only",
    "--skip-git-repo-check", "--model", model, "--output-schema", schemaPath,
    "--output-last-message", responsePath, "-",
  ], { cwd: repositoryRoot, stdin: new TextEncoder().encode(prompt), stdout: "pipe", stderr: "pipe" });
  if (processResult.exitCode !== 0) {
    throw new Error(`codex exec failed (${processResult.exitCode}): ${processResult.stderr.toString().trim()}`);
  }
  const parsed = JSON.parse(await readFile(responsePath, "utf8")) as { results: EvaluationResult[] };
  const failures: string[] = [];
  const byId = new Map(parsed.results.map((result) => [result.id, result]));
  if (byId.size !== parsed.results.length) failures.push("duplicate result id");
  if (parsed.results.length !== scenarios.length) failures.push(`expected ${scenarios.length} results, received ${parsed.results.length}`);
  for (const scenario of scenarios) {
    const result = byId.get(scenario.id);
    if (!result) {
      failures.push(`${scenario.id}: missing result`);
      continue;
    }
    if (result.classification !== scenario.expected.classification) {
      failures.push(`${scenario.id}: classification ${result.classification} != ${scenario.expected.classification}`);
    }
    if (!allowedDispositions(scenario.expected.disposition).includes(result.disposition)) {
      failures.push(`${scenario.id}: disposition ${result.disposition} does not satisfy ${scenario.expected.disposition}`);
    }
    for (const obligation of scenario.requiredReview) {
      if (!result.addressedReview.includes(obligation)) failures.push(`${scenario.id}: missing review obligation ${obligation}`);
    }
    if (!result.rejectedShortcut) failures.push(`${scenario.id}: forbidden shortcut was not explicitly rejected`);
  }
  const version = Bun.spawnSync(["codex", "--version"], { stdout: "pipe" }).stdout.toString().trim();
  const receipt = {
    schemaVersion: 1,
    runner: "codex exec",
    model,
    codexVersion: version,
    executedAt: new Date().toISOString(),
    scenarioSha256: new Bun.CryptoHasher("sha256").update(scenarioContent).digest("hex"),
    passed: failures.length === 0,
    failures,
    results: parsed.results,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`Live-agent limit preflight: model=${model} cases=${scenarios.length} failures=${failures.length} receipt=${outputPath}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

await run();
