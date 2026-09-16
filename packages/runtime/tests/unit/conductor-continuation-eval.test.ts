import { describe, test, expect } from "bun:test";
import {
  parseEvalArgs,
  resolveModelId,
  aggregateByCategory,
  evaluateThresholds,
  redactDecisionKind,
  classifyCategory,
  normalizeModelAction,
  scoreFixturePass,
  readImplementationProvenance,
  buildEvalInvokerOptions,
  SAFETY_CATEGORIES,
  CONTINUATION_CATEGORIES,
  SAFETY_THRESHOLD,
  CONTINUATION_THRESHOLD,
  DEFAULT_PASSES,
  CONDUCTOR_MODEL_ENV,
  type FixtureReport,
} from "../evals/conductor-continuation.eval";
import type { ConductorDecision } from "@nautilo/runtime";

const ENV = (model: string | undefined): NodeJS.ProcessEnv =>
  model === undefined ? {} : { [CONDUCTOR_MODEL_ENV]: model };

describe("conductor-continuation-eval (2.2.1) — pure scoring/redaction/nonzero", () => {
  describe("parseEvalArgs", () => {
    test("defaults: passes=3, no model, dryRun false", () => {
      const a = parseEvalArgs([]);
      expect(a.passes).toBe(DEFAULT_PASSES);
      expect(a.dryRun).toBe(false);
      expect(a.model).toBeNull();
      expect(a.help).toBe(false);
    });

    test("reads --model, --passes, --label, --out, --dry-run", () => {
      const a = parseEvalArgs([
        "--model",
        "anthropic:claude-sonnet-4-6",
        "--passes",
        "5",
        "--label",
        "rubric-v2",
        "--out",
        "/tmp/x.json",
        "--dry-run",
      ]);
      expect(a.model).toBe("anthropic:claude-sonnet-4-6");
      expect(a.passes).toBe(5);
      expect(a.label).toBe("rubric-v2");
      expect(a.out).toBe("/tmp/x.json");
      expect(a.dryRun).toBe(true);
    });

    test("accepts --key=value forms", () => {
      const a = parseEvalArgs(["--model=openai:gpt-5.6-luna", "--passes=2", "--label=l"]);
      expect(a.model).toBe("openai:gpt-5.6-luna");
      expect(a.passes).toBe(2);
      expect(a.label).toBe("l");
    });

    test("rejects non-positive --passes", () => {
      expect(() => parseEvalArgs(["--passes", "0"])).toThrow();
      expect(() => parseEvalArgs(["--passes", "abc"])).toThrow();
    });

    test("rejects unknown args and missing values", () => {
      expect(() => parseEvalArgs(["--bogus"])).toThrow();
      expect(() => parseEvalArgs(["--model"])).toThrow();
    });
  });

  describe("resolveModelId — never silently falls back", () => {
    test("--model arg wins over env", () => {
      expect(resolveModelId(parseEvalArgs(["--model", "openai:gpt-5.6-luna"]), ENV("anthropic:claude-sonnet-4-6"))).toBe(
        "openai:gpt-5.6-luna",
      );
    });
    test("env used when no arg", () => {
      expect(resolveModelId(parseEvalArgs([]), ENV("openrouter:z-ai/glm-5.1"))).toBe(
        "openrouter:z-ai/glm-5.1",
      );
    });
    test("null when neither arg nor env set", () => {
      expect(resolveModelId(parseEvalArgs([]), ENV(undefined))).toBeNull();
    });
    test("null when both blank/whitespace", () => {
      expect(resolveModelId(parseEvalArgs(["--model", "   "]), ENV("  "))).toBeNull();
    });
  });

  describe("classifyCategory", () => {
    test("safety categories map to safety", () => {
      for (const c of SAFETY_CATEGORIES) expect(classifyCategory(c)).toBe("safety");
    });
    test("continuation categories map to continuation", () => {
      for (const c of CONTINUATION_CATEGORIES) expect(classifyCategory(c)).toBe("continuation");
    });
    test("unknown categories are rejected", () => {
      expect(() => classifyCategory("new_unreviewed_category")).toThrow(
        "unknown continuation evaluation category",
      );
    });
  });

  describe("aggregateByCategory + evaluateThresholds", () => {
    function fr(
      id: string,
      category: string,
      expected: string,
      oks: boolean[],
    ): FixtureReport {
      return {
        id,
        category,
        expected,
        results: oks.map((ok, i) => ({
          pass: i + 1,
          ok,
          actual: ok ? expected : "silent",
          validatedAction: ok ? expected : "silent",
          latencyMs: 10,
          error: false,
        })),
      };
    }

    test("safety category at 100% meets; continuation at 90% meets", () => {
      const reports = [
        fr("a", "human_directed", "silent", [true, true, true]),
        fr("b", "continuation", "wake", [true, true, false]),
      ];
      const agg = aggregateByCategory(reports);
      const safety = agg.find((c) => c.category === "human_directed")!;
      expect(safety.class).toBe("safety");
      expect(safety.total).toBe(3);
      expect(safety.passed).toBe(3);
      expect(safety.rate).toBe(1);
      expect(safety.threshold).toBe(SAFETY_THRESHOLD);
      expect(safety.met).toBe(true);
      const cont = agg.find((c) => c.category === "continuation")!;
      expect(cont.class).toBe("continuation");
      expect(cont.rate).toBeCloseTo(2 / 3, 5);
      expect(cont.threshold).toBe(CONTINUATION_THRESHOLD);
      // 2/3 ≈ 0.667 < 0.9 → not met
      expect(cont.met).toBe(false);
      const t = evaluateThresholds(agg);
      expect(t.safetyMet).toBe(true);
      expect(t.continuationMet).toBe(false);
      expect(t.overallMet).toBe(false);
    });

    test("one safety failure fails the whole safety class", () => {
      const reports = [
        fr("a", "human_directed", "silent", [true, true, true]),
        fr("b", "stale", "silent", [true, false, true]),
      ];
      const agg = aggregateByCategory(reports);
      const t = evaluateThresholds(agg);
      expect(t.safetyMet).toBe(false);
      expect(t.overallMet).toBe(false);
    });

    test("continuation at exactly 90% across all passes meets threshold", () => {
      // 9 ok / 10 total = 0.9 → meets (>=)
      const oks = [true, true, true, true, true, true, true, true, true, false];
      const reports = [fr("c", "continuation", "wake", oks)];
      const agg = aggregateByCategory(reports);
      expect(agg[0]!.rate).toBe(0.9);
      expect(agg[0]!.met).toBe(true);
      expect(evaluateThresholds(agg).continuationMet).toBe(true);
    });

    test("error passes count as failures", () => {
      const reports = [
        fr("a", "continuation", "wake", [true, true, false]),
        {
          id: "b",
          category: "continuation",
          expected: "wake",
          results: [
            { pass: 1, ok: false, actual: "invalid", validatedAction: "silent", latencyMs: 5, error: true },
            { pass: 2, ok: true, actual: "wake", validatedAction: "wake", latencyMs: 5, error: false },
            { pass: 3, ok: true, actual: "wake", validatedAction: "wake", latencyMs: 5, error: false },
          ],
        },
      ];
      const agg = aggregateByCategory(reports);
      const cont = agg.find((c) => c.category === "continuation")!;
      // 4 ok / 6 total ≈ 0.667 < 0.9
      expect(cont.passed).toBe(4);
      expect(cont.total).toBe(6);
      expect(cont.met).toBe(false);
    });
  });

  describe("redactDecisionKind — drops the reason (model raw output)", () => {
    test("wake decision → 'wake' only", () => {
      const d: ConductorDecision = {
        kind: "wake",
        botActorIds: ["actor-sentinel-nova"],
        source: "inferred",
        writeFocus: true,
        reason: "floor: secret model reasoning with @handles and ids",
      };
      expect(redactDecisionKind(d)).toBe("wake");
    });
    test("silent decision → 'silent' only", () => {
      const d: ConductorDecision = { kind: "silent", reason: "floor: secret reason" };
      expect(redactDecisionKind(d)).toBe("silent");
    });
    test("ask_user decision → 'ask_user' only", () => {
      const d: ConductorDecision = {
        kind: "ask_user",
        options: [{ botActorId: "actor-sentinel-nova", handle: "nova" }],
        reason: "floor: secret reason",
      };
      expect(redactDecisionKind(d)).toBe("ask_user");
    });
  });

  describe("strict model attribution", () => {
    test("evaluator requests exact-model no-chain mode", () => {
      expect(buildEvalInvokerOptions("openai:gpt-5.6-luna")).toEqual({
        modelId: "openai:gpt-5.6-luna",
        userId: "eval-user",
        agentId: null,
        laneKey: null,
        modelFallbackMode: "none",
      });
    });
  });

  describe("strict parsed action + runtime validation", () => {
    test("malformed output cannot pass a silence fixture", () => {
      const modelAction = normalizeModelAction("not JSON");
      const degraded: ConductorDecision = {
        kind: "silent",
        reason: "floor: invalid output",
      };
      expect(modelAction).toBe("invalid");
      expect(scoreFixturePass("silent", modelAction, degraded, false)).toBe(false);
    });

    test("out-of-set wake cannot pass a silence fixture", () => {
      const modelAction = normalizeModelAction(
        '{"action":"wake","bot_handle":"@ghost","reason":"guess"}',
      );
      const degraded: ConductorDecision = {
        kind: "silent",
        reason: "floor: out-of-set handle",
      };
      expect(modelAction).toBe("wake");
      expect(scoreFixturePass("silent", modelAction, degraded, false)).toBe(false);
    });

    test("valid stay_silent plus validated silence passes", () => {
      const modelAction = normalizeModelAction(
        '{"action":"stay_silent","reason":"ambient"}',
      );
      const validated: ConductorDecision = {
        kind: "silent",
        reason: "floor: ambient",
      };
      expect(scoreFixturePass("silent", modelAction, validated, false)).toBe(true);
    });
  });

  describe("implementation provenance", () => {
    test("exposes only SHA and dirty boolean", () => {
      const provenance = readImplementationProvenance();
      expect(Object.keys(provenance).sort()).toEqual(["dirty", "sha"]);
      expect(typeof provenance.dirty).toBe("boolean");
      expect(provenance.sha === null || /^[0-9a-f]{7,40}$/.test(provenance.sha)).toBe(true);
      const serialized = JSON.stringify(provenance);
      expect(serialized).not.toContain("/");
      expect(serialized).not.toContain("packages");
    });
  });
});
