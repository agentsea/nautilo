import { describe, expect, test } from "bun:test";

import {
  renderForegroundModelBenchmark,
  runForegroundModelBenchmark,
} from "../evals/reflection-foreground-model.eval";

describe("Reflection Wave 9 exact-model foreground benchmark", () => {
  test("scores baseline continuity and organized-decision improvement without raw output", async () => {
    const report = await runForegroundModelBenchmark({
      metadata: {
        provider: "test",
        model: "test:exact",
        runs: 1,
        implementationSha: null,
        implementationDirty: true,
      },
      invoke: async (prompt) => {
        if (prompt.includes("What do I still need to send?")) {
          return "Send the migration plan on Monday. SECRET_RESPONSE";
        }
        if (prompt.includes("When is the launch?")) {
          return "The corrected date is Thursday. SECRET_RESPONSE";
        }
        if (prompt.includes("[Organized records]")) {
          return "Postgres was selected for transaction guarantees. SECRET_RESPONSE";
        }
        return "The support is insufficient. SECRET_RESPONSE";
      },
      usage: [],
    });
    expect(report.aggregate).toEqual({
      hardGatesPassed: true,
      baselineCriticalContinuityRate: 1,
      baselineExpectedTermRate: 2 / 3,
      hybridExpectedTermRate: 1,
      organizedDecisionImproved: true,
    });
    const serialized = renderForegroundModelBenchmark(report);
    expect(serialized).not.toContain("SECRET_RESPONSE");
    expect(serialized).not.toContain("migration plan on Monday");
    expect(serialized).not.toContain("Organized records");
  });

  test("provider failure is a hard gate with a fixed boolean only", async () => {
    const report = await runForegroundModelBenchmark({
      metadata: {
        provider: "test",
        model: "test:exact",
        runs: 1,
        implementationSha: null,
        implementationDirty: false,
      },
      invoke: () => Promise.reject(new Error("credential and response body")),
      usage: [],
    });
    expect(report.aggregate.hardGatesPassed).toBe(false);
    expect(renderForegroundModelBenchmark(report)).not.toContain("credential");
  });
});
