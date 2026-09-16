import { describe, expect, test } from "bun:test";
import {
  HIERARCHY_MODEL_BENCHMARK_FIXTURES,
  renderHierarchyModelBenchmarkReport,
  runHierarchyModelBenchmark,
} from "../../src/evaluation/model-benchmark";

const metadata = {
  provider: "openai",
  model: "openai:synthetic-test-model",
  runs: 2,
  implementationSha: "abc123",
  implementationDirty: false,
};

describe("Reflection-owned real-model benchmark semantics", () => {
  test("normalizes accepted proposals and reports repeated agreement", async () => {
    let call = 0;
    const responses = HIERARCHY_MODEL_BENCHMARK_FIXTURES.flatMap((fixture) =>
      Array.from({ length: metadata.runs }, () => fixture.expectedOperation === "no_change"
        ? '{"operation":"no_change"}'
        : fixture.expectedOperation === "extend_parent"
          ? JSON.stringify({
              operation: "extend_parent",
              parentRecordRef: fixture.requiredParentHandle,
              statement: "The PostgreSQL decision now includes managed branch previews.",
              additionRefs: fixture.requiredSelectedHandles,
            })
        : fixture.expectedOperation === "wrap_parent"
          ? JSON.stringify({
              operation: "wrap_parent",
              parentRecordRef: fixture.requiredParentHandle,
              statement: "The database decision and operating plan form a broader cluster.",
              additionRefs: fixture.requiredSelectedHandles,
            })
        : JSON.stringify({
            operation: "create_parent",
            statement: fixture.id === "preserved-disagreement"
              ? "The two cost estimates disagree and require measurement."
              : "The team selected PostgreSQL after comparing the requirements and alternatives.",
            childRecordRefs: fixture.requiredSelectedHandles,
          }))
    );
    const usage = [{ call: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 }];
    const report = await runHierarchyModelBenchmark({
      metadata,
      invoke: () => Promise.resolve(responses[call++]!),
      usage,
    });

    expect(report.scenarios).toHaveLength(HIERARCHY_MODEL_BENCHMARK_FIXTURES.length * 2);
    expect(report.aggregate).toMatchObject({
      structuralHardGatesPassed: true,
      expectedOperationRate: 1,
      usefulParentRate: 1,
      redundantParentCount: 0,
      agreementRate: 1,
    });
    expect(report.usage).toEqual(usage);
    expect(report.scenarios.every((scenario) => scenario.errorCode === null)).toBe(true);
  });

  test("replaces provider failures with a stable code and never serializes the error", async () => {
    const report = await runHierarchyModelBenchmark({
      metadata: { ...metadata, runs: 1 },
      invoke: () => Promise.reject(new Error("SECRET provider body and credential")),
      usage: [],
    });
    const serialized = renderHierarchyModelBenchmarkReport(report);
    expect(report.aggregate.structuralHardGatesPassed).toBe(false);
    expect(report.scenarios.every(
      (scenario) => scenario.errorCode === "provider_invocation_failed",
    )).toBe(true);
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("credential");
  });

  test("drops invalid token counts instead of claiming zero", async () => {
    const report = await runHierarchyModelBenchmark({
      metadata: { ...metadata, runs: 1 },
      invoke: () => Promise.resolve('{"operation":"no_change"}'),
      usage: [{ call: 1, inputTokens: -1, outputTokens: 2.5 }],
    });
    expect(report.usage).toEqual([{ call: 1 }]);
  });
});
