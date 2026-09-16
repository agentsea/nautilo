import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateReflectionHierarchy } from "../evals/reflection-hierarchy/evaluator";
import {
  renderHierarchyHumanReport,
  renderHierarchyMachineReport,
} from "../evals/reflection-hierarchy/report";
import { runReflectionHierarchyEvaluation } from "../evals/reflection-hierarchy.eval";

describe("deterministic hierarchy evaluation", () => {
  test("covers all fifteen scenarios with stable structural gates", async () => {
    const first = await evaluateReflectionHierarchy();
    const second = await evaluateReflectionHierarchy();
    expect(first.scenarios).toHaveLength(15);
    expect(first.structuralHardGatesPassed).toBe(true);
    expect(renderHierarchyMachineReport(second)).toBe(renderHierarchyMachineReport(first));
    expect(renderHierarchyHumanReport(second)).toBe(renderHierarchyHumanReport(first));
  });

  test("matches reviewed artifacts and excludes requester-private evidence", async () => {
    expect(await runReflectionHierarchyEvaluation("check")).toBe(0);
    const artifact = await readFile(resolve(
      import.meta.dir,
      "../evals/reflection-hierarchy/artifacts/decision.json",
    ), "utf8");
    expect(artifact).not.toContain("requester-private");
  });
});
