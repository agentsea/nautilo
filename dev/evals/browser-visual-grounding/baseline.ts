import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  browserDecisionCandidates,
  browserDecisionChoiceInput,
  browserDecisionObservationSchema,
  browserDecisionPlanSchema,
  type BrowserDecisionCandidate,
  type BrowserDecisionObservation,
  type BrowserDecisionPlan,
} from "../../../packages/agent/src/graph/browser-decision.ts";
import { BROWSER_DECISION_CONTROL_IDS } from "../../../packages/agent/src/graph/browser-choice.ts";
import type { ChoiceInput } from "../../../packages/agent/src/providers/choice.ts";
import type { BrowserVisualGroundingCase } from "./schema.ts";

const baselineSchemaVersion = 1 as const;
const nonBlank = z.string().refine((value) => value.trim().length > 0);
const expectedOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("control"), id: z.enum(BROWSER_DECISION_CONTROL_IDS) }).strict(),
  z.object({
    kind: z.literal("call"),
    name: nonBlank,
    args: z.record(z.string(), z.json()),
  }).strict(),
]);
const baselineTaskSchema = z.object({
  caseId: nonBlank,
  name: nonBlank,
  plan: browserDecisionPlanSchema,
  acceptable: z.array(expectedOutcomeSchema).nonempty(),
}).strict();
const baselineManifestSchema = z.object({
  schemaVersion: z.literal(baselineSchemaVersion),
  tasks: z.array(baselineTaskSchema).nonempty(),
}).strict();

export type BaselineTask = z.infer<typeof baselineTaskSchema>;
export type ExpectedOutcome = z.infer<typeof expectedOutcomeSchema>;

export interface PreparedBaselineCase {
  readonly task: BaselineTask;
  readonly capture: BrowserVisualGroundingCase;
  readonly observation: BrowserDecisionObservation;
  readonly plan: BrowserDecisionPlan;
  readonly candidates: readonly BrowserDecisionCandidate[];
  readonly input: ChoiceInput;
  readonly candidateDigest: string;
}

const casesRoot = path.join(import.meta.dir, "cases");

export async function loadCapture(caseId: string): Promise<BrowserVisualGroundingCase> {
  const capture = JSON.parse(
    await readFile(path.join(casesRoot, caseId, "case.json"), "utf8"),
  ) as BrowserVisualGroundingCase;
  if (capture.id !== caseId) throw new Error(`Capture id mismatch for ${caseId}`);
  return capture;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function loadBaselineTasks(): Promise<readonly BaselineTask[]> {
  const manifest = baselineManifestSchema.parse(
    JSON.parse(await readFile(path.join(import.meta.dir, "tasks.json"), "utf8")),
  );
  const ids = manifest.tasks.map(({ caseId }) => caseId);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate baseline case id");
  if ([...ids].sort().some((id, index) => id !== ids[index])) {
    throw new Error("Baseline tasks must be sorted by case id");
  }
  return manifest.tasks;
}

export async function prepareBaselineCase(options: {
  readonly task: BaselineTask;
  readonly modelId: string;
  readonly maxChoices: number;
  readonly signal: AbortSignal;
}): Promise<PreparedBaselineCase> {
  const caseRoot = path.join(casesRoot, options.task.caseId);
  const capture = await loadCapture(options.task.caseId);
  const snapshot = await readFile(path.join(caseRoot, capture.snapshot.file), "utf8");
  const observation = browserDecisionObservationSchema.parse({
    version: 1,
    snapshot,
    refs: capture.refs,
    pageUrl: capture.sourceUrl,
    browserSessionId: `baseline:${capture.id}`,
    observationId: `capture:${capture.snapshot.sha256}`,
  });
  const plan = {
    ...options.task.plan,
    allowedOrigins: options.task.plan.allowedOrigins.length
      ? [...new Set(options.task.plan.allowedOrigins.map((value) => new URL(value).origin))].sort()
      : [new URL(observation.pageUrl).origin],
  };
  const built = browserDecisionCandidates(plan, observation, options.maxChoices);
  if (built.reason !== null) throw new Error(`Candidate generation failed for ${capture.id}: ${built.reason}`);
  const candidates = built.candidates;
  const input = browserDecisionChoiceInput({
    modelId: options.modelId,
    signal: options.signal,
    plan,
    observation,
    candidates,
  });
  return {
    task: options.task,
    capture,
    observation,
    plan,
    candidates,
    input,
    candidateDigest: createHash("sha256").update(stableJson(input.choices)).digest("hex"),
  };
}

function expectedMatches(candidate: BrowserDecisionCandidate, expected: ExpectedOutcome): boolean {
  if (expected.kind === "control") return candidate.id === expected.id && candidate.call === null;
  return candidate.call?.name === expected.name
    && stableJson(candidate.call.args) === stableJson(expected.args);
}

export function candidatesMatchingExpectation(
  prepared: PreparedBaselineCase,
): readonly BrowserDecisionCandidate[] {
  return prepared.candidates.filter((candidate) =>
    prepared.task.acceptable.some((expected) => expectedMatches(candidate, expected)));
}

export function scoreBaselineSelection(
  prepared: PreparedBaselineCase,
  selectedId: string,
): { readonly passed: boolean; readonly selected: BrowserDecisionCandidate | null } {
  const selected = prepared.candidates.find((candidate) => candidate.id === selectedId) ?? null;
  return {
    selected,
    passed: selected !== null
      && prepared.task.acceptable.some((expected) => expectedMatches(selected, expected)),
  };
}
