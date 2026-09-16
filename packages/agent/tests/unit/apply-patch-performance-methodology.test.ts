/**
 * D448 Phase 0.3.3 — deterministic methodology guardrails only.
 *
 * This reads no clock and invokes no server, relay, package, or native parser.
 * Source-built and live measurements remain owned by tasks 4.3.2 and 4.3.3.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const FIXTURE_ROOT = join(import.meta.dir, "../fixtures/apply-patch/capability");

type Scenario = {
  readonly id: "one-file" | "twenty-file";
  readonly fixture: "one-file.patch" | "multi-file-20.patch";
  readonly changedFiles: number;
  readonly historicalFileWorkflow: {
    readonly tool: "file";
    readonly command: "str_replace";
    readonly expectedCallCount: number;
  };
  readonly applyPatchExpectedCallShape: {
    readonly tool: "apply_patch";
    readonly expectedTopLevelCallCount: number;
  };
};

type Methodology = {
  readonly version: number;
  readonly status: "frozen_methodology_with_unmeasured_acceptance_target";
  readonly purpose: string;
  readonly scenarios: readonly Scenario[];
  readonly workstationAcceptanceTarget: {
    readonly expectedRelayOperations: number;
    readonly claim: "unmeasured_acceptance_target";
  };
  readonly observationalFields: readonly string[];
  readonly measurementPolicy: {
    readonly timing: "observational_only";
    readonly latencyAssertions: "forbidden_in_unit_tests";
  };
  readonly verificationOwnership: {
    readonly deterministicUnitAssertions: readonly string[];
    readonly laterSourceBuiltAndLiveMeasurements: readonly string[];
  };
};

const methodology = JSON.parse(
  readFileSync(join(FIXTURE_ROOT, "performance-methodology.json"), "utf8"),
) as Methodology;

function readPatch(name: Scenario["fixture"]): string {
  return readFileSync(join(FIXTURE_ROOT, name), "utf8");
}

const REQUIRED_OBSERVATIONAL_FIELDS = [
  "wall_time",
  "model_tool_round_trips",
  "relay_operations",
  "request_bytes",
  "result_bytes",
  "changed_files",
  "revision_count",
  "run_identifier",
  "environment_identifier",
  "warmup_policy",
  "repetition_policy",
  "raw_samples",
  "median",
  "p95",
  "success_or_failure",
];

describe("D448 apply_patch performance measurement methodology", () => {
  test("keeps frozen call-shape evidence deterministic without making a latency claim", () => {
    expect(methodology.version).toBe(1);
    expect(methodology.status).toBe("frozen_methodology_with_unmeasured_acceptance_target");
    expect(methodology.scenarios).toEqual([
      expect.objectContaining({
        id: "one-file",
        fixture: "one-file.patch",
        changedFiles: 1,
        historicalFileWorkflow: { tool: "file", command: "str_replace", expectedCallCount: 1 },
        applyPatchExpectedCallShape: { tool: "apply_patch", expectedTopLevelCallCount: 1 },
      }),
      expect.objectContaining({
        id: "twenty-file",
        fixture: "multi-file-20.patch",
        changedFiles: 20,
        historicalFileWorkflow: { tool: "file", command: "str_replace", expectedCallCount: 20 },
        applyPatchExpectedCallShape: { tool: "apply_patch", expectedTopLevelCallCount: 1 },
      }),
    ]);
    expect(methodology.workstationAcceptanceTarget).toEqual({
      expectedRelayOperations: 1,
      claim: "unmeasured_acceptance_target",
    });
  });

  test("requires later runs to capture complete observational data without latency thresholds", () => {
    for (const field of REQUIRED_OBSERVATIONAL_FIELDS) expect(methodology.observationalFields).toContain(field);
    expect(new Set(methodology.observationalFields).size).toBe(methodology.observationalFields.length);
    expect(methodology.measurementPolicy.timing).toBe("observational_only");
    expect(methodology.measurementPolicy.latencyAssertions).toBe("forbidden_in_unit_tests");
    expect(methodology.purpose).toMatch(/does not report measured latency/i);
  });

  test("anchors workload labels to fixtures with one and twenty update operations", () => {
    const oneFilePatch = readPatch("one-file.patch");
    const twentyFilePatch = readPatch("multi-file-20.patch");

    expect((oneFilePatch.match(/^\*\*\* Update File: /gm) ?? [])).toHaveLength(1);
    expect((twentyFilePatch.match(/^\*\*\* Update File: /gm) ?? [])).toHaveLength(20);
    expect(methodology.scenarios.map((scenario) => scenario.fixture)).toEqual([
      "one-file.patch",
      "multi-file-20.patch",
    ]);
  });

  test("separates unit assertions from later source-built and live measurements", () => {
    expect(methodology.verificationOwnership.deterministicUnitAssertions).toContain("historical file-workflow and apply_patch expected call shapes");
    expect(methodology.verificationOwnership.deterministicUnitAssertions).toContain("observational field completeness");
    expect(methodology.verificationOwnership.laterSourceBuiltAndLiveMeasurements).toEqual(["4.3.2", "4.3.3"]);
  });
});
