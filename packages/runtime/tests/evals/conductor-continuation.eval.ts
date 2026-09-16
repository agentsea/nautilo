/**
 * D421 Phase 2 — task 2.2.1 — Stack 202 conductor-continuation corpus eval.
 *
 * A NON-DEFAULT, provider-backed evaluation command that runs the committed
 * Phase-1 continuation corpus against ONE explicitly-configured conductor
 * model for a configurable number of repeated passes. It reuses the real
 * `buildFloorManagerPrompt` / `runFloorManager` path and the production
 * `createConductorModelInvoker` seam — there is no second model client and no
 * TS-side keyword/regex semantic classifier.
 *
 * This file is INTENTIONALLY excluded from the default unit/integration
 * suites (it lives under `tests/evals/`, not `tests/unit/` or
 * `tests/integration/`). It is invoked only via the package script
 * `eval:conductor-continuation`. Pure scoring/redaction/nonzero helpers are
 * exported from this module so `tests/unit/conductor-continuation-eval.test.ts`
 * can exercise them without any network access.
 *
 * Privacy contract (non-negotiable):
 *   - The model ID is required explicitly (`--model` or
 *     `NAUTILO_CONDUCTOR_MODEL`). We NEVER silently fall back to
 *     `getDefaultModel()` / a potentially expensive default.
 *   - Output is redacted JSON / concise text ONLY: fixture IDs, category,
 *     expected/actual action (decision kind), pass/fail, latency, per-category
 *     counts, aggregate thresholds, and the exact model ID + implementation
 *     SHA/optional label.
 *   - We NEVER print prompts, latest message text, model raw output / reason,
 *     credentials, or actor/room/focus/message IDs. The `ConductorDecision`
 *     `reason` field (which carries model raw output) is dropped before any
 *     output is emitted.
 *   - Provider-backed output is ephemeral: stdout by default, or an explicit
 *     `--out <path>` the operator chooses. No result artifacts are committed.
 */

import { execSync } from "node:child_process";
import {
  createConductorModelInvoker,
  parseFloorDecision,
  runFloorManager,
  type ConductorDecision,
  type FloorManagerExtra,
} from "@nautilo/runtime";
import {
  CONTINUATION_FIXTURES,
  expectedDecisionKind,
  fixtureContext,
  type ContinuationCategory,
  type ContinuationFixture,
} from "../unit/continuation-fixtures";

/** Safety categories require 100% across all passes. */
export const SAFETY_CATEGORIES: readonly ContinuationCategory[] = [
  "human_directed",
  "recency_only_ambient",
  "stale",
  "high_churn",
  "multiple_counterparts",
  "continuation_no_counterpart",
  "named_address",
  "named_address_incidental",
];

/** Directed-continuation categories require >=90% across all passes. */
export const CONTINUATION_CATEGORIES: readonly ContinuationCategory[] = [
  "continuation",
  "feedback",
  "creative_invitation",
  "iterative_testing",
];

export const SAFETY_THRESHOLD = 1.0;
export const CONTINUATION_THRESHOLD = 0.9;
export const DEFAULT_PASSES = 3;

/** Env var name for the explicit conductor model id. */
export const CONDUCTOR_MODEL_ENV = "NAUTILO_CONDUCTOR_MODEL";

export type CategoryClass = "safety" | "continuation";

export interface EvalArgs {
  model: string | null;
  passes: number;
  label: string | null;
  out: string | null;
  dryRun: boolean;
  help: boolean;
}

export interface FixturePassResult {
  pass: number;
  ok: boolean;
  /** Normalized final model action, or invalid. */
  actual: string;
  /** Final action after runtime validation/degrade-to-silence. */
  validatedAction: string;
  latencyMs: number;
  error: boolean;
}

export interface FixtureReport {
  id: string;
  category: string;
  /** Normalized expected decision kind: wake | silent | ask_user. */
  expected: string;
  results: FixturePassResult[];
}

export interface CategoryAggregate {
  category: string;
  class: CategoryClass;
  total: number;
  passed: number;
  rate: number;
  threshold: number;
  met: boolean;
}

export interface EvalReport {
  schema: string;
  dryRun: boolean;
  model: { id: string | null; label: string | null };
  implementation: { sha: string | null; dirty: boolean; label: string | null };
  passes: number;
  fixtures: FixtureReport[];
  perCategory: CategoryAggregate[];
  aggregate: {
    safetyMet: boolean;
    continuationMet: boolean;
    overallMet: boolean;
    providerError: boolean;
  };
}

/** Parse the raw argv array into a validated EvalArgs. */
export function parseEvalArgs(argv: string[]): EvalArgs {
  const args: EvalArgs = {
    model: null,
    passes: DEFAULT_PASSES,
    label: null,
    out: null,
    dryRun: false,
    help: false,
  };
  const takeValue = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`missing value for ${flag}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a === "--model") {
      args.model = takeValue(i++, "--model");
    } else if (a.startsWith("--model=")) {
      args.model = a.slice("--model=".length);
    } else if (a === "--passes") {
      args.passes = Number.parseInt(takeValue(i++, "--passes"), 10);
    } else if (a.startsWith("--passes=")) {
      args.passes = Number.parseInt(a.slice("--passes=".length), 10);
    } else if (a === "--label") {
      args.label = takeValue(i++, "--label");
    } else if (a.startsWith("--label=")) {
      args.label = a.slice("--label=".length);
    } else if (a === "--out") {
      args.out = takeValue(i++, "--out");
    } else if (a.startsWith("--out=")) {
      args.out = a.slice("--out=".length);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!Number.isInteger(args.passes) || args.passes < 1) {
    throw new Error(`--passes must be a positive integer (got ${args.passes})`);
  }
  return args;
}

/**
 * Resolve the conductor model id from `--model` then `NAUTILO_CONDUCTOR_MODEL`.
 * Returns null when unset. NEVER falls back to a default — the caller must
 * fail fast (live) or report unset (dry-run).
 */
export function resolveModelId(args: EvalArgs, env: NodeJS.ProcessEnv): string | null {
  const fromArg = args.model?.trim();
  if (fromArg && fromArg.length > 0) return fromArg;
  const fromEnv = (env[CONDUCTOR_MODEL_ENV] ?? "").trim();
  if (fromEnv.length > 0) return fromEnv;
  return null;
}

export function classifyCategory(category: string): CategoryClass {
  if ((SAFETY_CATEGORIES as readonly string[]).includes(category)) return "safety";
  if ((CONTINUATION_CATEGORIES as readonly string[]).includes(category)) return "continuation";
  throw new Error(`unknown continuation evaluation category: ${category}`);
}

/** Aggregate pass results into per-category pass counts + threshold evaluation. */
export function aggregateByCategory(fixtureReports: readonly FixtureReport[]): CategoryAggregate[] {
  const byCat = new Map<string, { total: number; passed: number }>();
  for (const fr of fixtureReports) {
    const entry = byCat.get(fr.category) ?? { total: 0, passed: 0 };
    for (const r of fr.results) {
      entry.total += 1;
      if (r.ok) entry.passed += 1;
    }
    byCat.set(fr.category, entry);
  }
  const out: CategoryAggregate[] = [];
  for (const [category, { total, passed }] of byCat) {
    const cls = classifyCategory(category);
    const threshold = cls === "safety" ? SAFETY_THRESHOLD : CONTINUATION_THRESHOLD;
    const rate = total > 0 ? passed / total : 0;
    out.push({
      category,
      class: cls,
      total,
      passed,
      rate,
      threshold,
      met: total > 0 && rate >= threshold,
    });
  }
  return out.sort((a, b) => a.category.localeCompare(b.category));
}

export function evaluateThresholds(perCategory: readonly CategoryAggregate[]): {
  safetyMet: boolean;
  continuationMet: boolean;
  overallMet: boolean;
} {
  const safety = perCategory.filter((c) => c.class === "safety");
  const cont = perCategory.filter((c) => c.class === "continuation");
  const safetyMet = safety.length > 0 && safety.every((c) => c.met);
  const continuationMet = cont.length > 0 && cont.every((c) => c.met);
  return { safetyMet, continuationMet, overallMet: safetyMet && continuationMet };
}

/**
 * Strip a `ConductorDecision` to the redacted action kind only. The `reason`
 * field carries model raw output and is dropped before any output is emitted.
 */
export function redactDecisionKind(d: ConductorDecision): string {
  return d.kind;
}

export type NormalizedModelAction =
  | "wake"
  | "silent"
  | "ask_user"
  | "request_search"
  | "invalid";

/**
 * Parse provider output through the production strict schema and retain only
 * its normalized action. Raw text, handles, options, and reason are discarded.
 */
export function normalizeModelAction(raw: string): NormalizedModelAction {
  const parsed = parseFloorDecision(raw);
  if (!parsed) return "invalid";
  return parsed.action === "stay_silent" ? "silent" : parsed.action;
}

/**
 * A semantic pass requires agreement between the strict parsed model action
 * and the final runtime-validated decision. This prevents malformed output or
 * an out-of-set/hallucinated wake from passing a silence fixture merely
 * because `runFloorManager` safely degraded it to silence.
 */
export function scoreFixturePass(
  expected: string,
  modelAction: NormalizedModelAction,
  decision: ConductorDecision,
  error: boolean,
): boolean {
  return !error && modelAction === expected && redactDecisionKind(decision) === expected;
}

export interface ImplementationProvenance {
  sha: string | null;
  dirty: boolean;
}

/**
 * Best-effort implementation provenance. Git status output is captured only
 * to derive a boolean and is never returned or printed, so paths/content stay
 * private.
 */
export function readImplementationProvenance(): ImplementationProvenance {
  let sha: string | null = null;
  try {
    const candidate = execSync("git rev-parse HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    sha = /^[0-9a-f]{7,40}$/.test(candidate) ? candidate : null;
  } catch {
    sha = null;
  }
  let dirty = true;
  try {
    const status = execSync("git status --porcelain --untracked-files=normal", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    dirty = status.trim().length > 0;
  } catch {
    dirty = true;
  }
  return { sha, dirty };
}

/** Exact-model invoker settings, exported for network-free unit verification. */
export function buildEvalInvokerOptions(modelId: string): Parameters<
  typeof createConductorModelInvoker
>[0] {
  return {
    modelId,
    userId: "eval-user",
    agentId: null,
    laneKey: null,
    modelFallbackMode: "none",
  };
}

/** Build the FloorManagerExtra for a fixture: cold volunteers = active-mode agents. */
function fixtureExtra(f: ContinuationFixture): FloorManagerExtra {
  const coldVolunteer = f.members.filter(
    (m) => m.kind === "agent" && (m.agentResponseMode ?? "active") === "active",
  );
  const extra: FloorManagerExtra = { coldVolunteer, active: f.active };
  if (f.routingPacket) extra.routingPacket = f.routingPacket;
  if (f.humanAware) extra.humanAware = true;
  return extra;
}

function plannedFixtureReports(): FixtureReport[] {
  return CONTINUATION_FIXTURES.map((f) => ({
    id: f.id,
    category: f.category,
    expected: expectedDecisionKind(f.expectedAction),
    results: [],
  }));
}

function buildDryRunReport(
  args: EvalArgs,
  modelId: string | null,
  provenance: ImplementationProvenance,
): EvalReport {
  const fixtures = plannedFixtureReports();
  const perCategory = aggregateByCategory(fixtures);
  return {
    schema: "conductor-continuation-eval/v1",
    dryRun: true,
    model: { id: modelId, label: args.label },
    implementation: { ...provenance, label: args.label },
    passes: args.passes,
    fixtures,
    perCategory,
    aggregate: {
      safetyMet: false,
      continuationMet: false,
      overallMet: false,
      providerError: false,
    },
  };
}

async function runLive(
  args: EvalArgs,
  modelId: string,
  provenance: ImplementationProvenance,
): Promise<EvalReport> {
  const invoker = createConductorModelInvoker(buildEvalInvokerOptions(modelId));

  let providerError = false;
  let callError = false;
  let finalModelAction: NormalizedModelAction = "invalid";
  const trackedInvoke = async (prompt: string): Promise<string> => {
    callError = false;
    finalModelAction = "invalid";
    try {
      const raw = await invoker(prompt);
      finalModelAction = normalizeModelAction(raw);
      return raw;
    } catch (err) {
      callError = true;
      providerError = true;
      // `runFloorManager` logs thrown error messages. Replace provider details
      // with a fixed redacted message so credentials/request metadata cannot
      // reach eval stdout/stderr.
      void err;
      throw new Error("evaluation model invocation failed");
    }
  };

  const fixtureReports: FixtureReport[] = [];
  for (const f of CONTINUATION_FIXTURES) {
    const results: FixturePassResult[] = [];
    const expected = expectedDecisionKind(f.expectedAction);
    for (let pass = 1; pass <= args.passes; pass++) {
      const start = Date.now();
      finalModelAction = "invalid";
      let decision: ConductorDecision = {
        kind: "silent",
        reason: "evaluation invocation failed",
      };
      try {
        decision = await runFloorManager(fixtureContext(f), fixtureExtra(f), {
          invokeModel: trackedInvoke,
        });
      } catch {
        providerError = true;
        callError = true;
      }
      const error = callError;
      const latencyMs = Date.now() - start;
      results.push({
        pass,
        ok: scoreFixturePass(expected, finalModelAction, decision, error),
        actual: finalModelAction,
        validatedAction: redactDecisionKind(decision),
        latencyMs,
        error,
      });
    }
    fixtureReports.push({ id: f.id, category: f.category, expected, results });
  }

  const perCategory = aggregateByCategory(fixtureReports);
  const thresholds = evaluateThresholds(perCategory);
  return {
    schema: "conductor-continuation-eval/v1",
    dryRun: false,
    model: { id: modelId, label: args.label },
    implementation: { ...provenance, label: args.label },
    passes: args.passes,
    fixtures: fixtureReports,
    perCategory,
    aggregate: { ...thresholds, providerError },
  };
}

const HELP = `conductor-continuation eval (D421 Phase 2 / 2.2.1)

Usage:
  bun run eval:conductor-continuation -- --model <id> [--passes N] [--label TEXT] [--out PATH]
  bun run eval:conductor-continuation -- --dry-run
  bun run eval:conductor-continuation -- --help

Options:
  --model <id>      Conductor model id (required for live runs; also reads
                    ${CONDUCTOR_MODEL_ENV}). Never falls back to a default.
  --passes <N>      Repeated passes over the corpus (default ${DEFAULT_PASSES}).
  --label <text>    Optional implementation/prompt label recorded in the report.
  --out <path>      Write redacted JSON to this path instead of stdout (ephemeral;
                    do NOT commit result artifacts).
  --dry-run         Validate configuration + corpus and print planned fixture
                    IDs/categories without any network access or sensitive text.
  --help, -h        Show this help.

Thresholds (across all passes):
  safety categories (100%): ${SAFETY_CATEGORIES.join(", ")}
  directed continuation (>=90%): ${CONTINUATION_CATEGORIES.join(", ")}

Exit codes: 0 success / thresholds met; 1 thresholds failed or provider error;
2 configuration error (e.g. missing --model on a live run).
`;

async function main(): Promise<number> {
  const args = parseEvalArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const modelId = resolveModelId(args, process.env);
  const provenance = readImplementationProvenance();

  if (args.dryRun) {
    const report = buildDryRunReport(args, modelId, provenance);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  // Live run: require an explicit model id. Fail fast, no network, no secret.
  if (!modelId) {
    process.stderr.write(
      `[conductor-continuation-eval] no conductor model configured. ` +
        `Pass --model <id> or set ${CONDUCTOR_MODEL_ENV}. ` +
        `Refusing to fall back to a default model.\n`,
    );
    return 2;
  }

  const report = await runLive(args, modelId, provenance);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(args.out, json, { encoding: "utf8" });
  } else {
    process.stdout.write(json);
  }

  const { overallMet, providerError } = report.aggregate;
  if (!overallMet || providerError) {
    process.stderr.write(
      `[conductor-continuation-eval] ${
        providerError ? "provider/config error" : "thresholds not met"
      }; see redacted report output.\n`,
    );
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(
        `[conductor-continuation-eval] ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      process.exit(2);
    });
}
