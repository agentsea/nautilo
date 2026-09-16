import { describe, test, expect } from "bun:test";
import { Runner } from "../../src/runner";
import { formatJson } from "../../src/reporter";
import { makeMockDriver, makeMockClient, makeExpectations } from "./mock-driver";

/**
 * D063 Phase 2.11 integration test — smoke-run round-trip.
 *
 * Drives a multi-test, multi-platform run through Runner and asserts:
 *   - the report's structure is what consumers expect
 *   - RunnerEvent order is run-start → (test-start, test-end)* → run-end
 *   - two runs of the same input produce byte-identical Reporter JSON
 *     (regression guard for the stable-key invariant from Phase 2.8)
 */

describe("D063 Phase 2.11 — smoke run round-trip", () => {
  function buildRunner() {
    const linuxDriver = makeMockDriver({ platform: "linux" });
    const linuxClient = makeMockClient({
      scanResults: [
        { layer: "command", level: "standard", blocked: true, reason: "scanner matched" },
        { layer: "command", level: "standard", blocked: false, reason: "benign echo" },
      ],
    });
    const macosDriver = makeMockDriver({ platform: "macos" });
    const macosClient = makeMockClient({
      scanResults: [
        { layer: "command", level: "standard", blocked: true, reason: "scanner matched" },
      ],
    });

    const expectations = makeExpectations({
      "SCAN-01": {
        platforms: ["linux", "macos"],
        layer: "command-scanner",
        destructive_command: "rm -rf /",
        modes_supported: ["destructive"],
        expect_blocked: true,
        security_levels: ["standard"],
      },
      "SCAN-02": {
        platforms: ["linux"],
        layer: "command-scanner",
        destructive_command: "echo hi",
        modes_supported: ["destructive"],
        expect_blocked: false, // benign — scanner correctly allows
        security_levels: ["standard"],
      },
    });

    const events: Array<{ type: string; detail: string }> = [];

    const runner = new Runner({
      expectations,
      platforms: {
        linux: { driver: linuxDriver, client: linuxClient },
        macos: { driver: macosDriver, client: macosClient },
      },
      watchdogIntervalMs: 100,
      onEvent: (e) => {
        if (e.type === "run-start") events.push({ type: e.type, detail: `total=${e.total}` });
        else if (e.type === "test-start") events.push({ type: e.type, detail: `${e.testId}/${e.platform}` });
        else if (e.type === "test-end") events.push({ type: e.type, detail: `${e.result.testId}/${e.result.platform}:${e.result.outcome}` });
        else if (e.type === "run-end") events.push({ type: e.type, detail: `results=${e.report.results.length}` });
      },
    });

    return { runner, events };
  }

  test("event order: run-start → (test-start, test-end)* → run-end", async () => {
    const { runner, events } = buildRunner();
    await runner.runMatrix({ platforms: ["linux", "macos"] });

    expect(events[0]!.type).toBe("run-start");
    expect(events[events.length - 1]!.type).toBe("run-end");

    // Between run-start and run-end, events alternate test-start, test-end.
    let expected: "test-start" | "test-end" = "test-start";
    for (let i = 1; i < events.length - 1; i++) {
      expect(events[i]!.type).toBe(expected);
      expected = expected === "test-start" ? "test-end" : "test-start";
    }
  });

  test("report totals match executed tests", async () => {
    const { runner } = buildRunner();
    const report = await runner.runMatrix({ platforms: ["linux", "macos"] });

    // SCAN-01 runs on both platforms (2 results); SCAN-02 linux only (1).
    expect(report.results).toHaveLength(3);
    expect(report.summary.total).toBe(3);
    expect(report.summary.pass + report.summary.fail + report.summary.warn + report.summary.vmDead + report.summary.skipped + report.summary.error).toBe(3);
  });

  test("report JSON is byte-stable across runs with identical input", async () => {
    const report1 = await buildRunner().runner.runMatrix({ platforms: ["linux", "macos"] });
    const report2 = await buildRunner().runner.runMatrix({ platforms: ["linux", "macos"] });

    // Dates differ between runs — normalize them before comparing.
    const normalize = (r: typeof report1) => ({
      ...r,
      runId: "NORMALIZED",
      startedAt: "NORMALIZED",
      finishedAt: "NORMALIZED",
      durationMs: 0,
      results: r.results.map((tr) => ({
        ...tr,
        startedAt: "NORMALIZED",
        finishedAt: "NORMALIZED",
        durationMs: 0,
        watchdogEvents: tr.watchdogEvents.map((e) => ({ ...e, at: "NORMALIZED" })),
      })),
    });

    expect(formatJson(normalize(report1))).toBe(formatJson(normalize(report2)));
  });

  test("platform filter narrows the scheduled matrix", async () => {
    const { runner } = buildRunner();
    const report = await runner.runMatrix({ platforms: ["linux"] });
    expect(report.results.every((r) => r.platform === "linux")).toBe(true);
    expect(report.platform).toBe("linux");
  });

  test("pattern filter narrows by test id", async () => {
    const { runner } = buildRunner();
    const report = await runner.runMatrix({ platforms: ["linux", "macos"], pattern: "SCAN-01" });
    expect(report.results.every((r) => r.testId === "SCAN-01")).toBe(true);
    expect(report.results).toHaveLength(2); // linux + macos
  });
});
