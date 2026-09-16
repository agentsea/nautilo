/**
 * D063 Phase 6 task 6.3 — end-to-end matrix test for FILE-* rows.
 *
 * Validates three things together:
 *   1. expected-outcomes.json parses FILE-01..06 rows cleanly
 *      (tool_invocation + expect_layer_hit present).
 *   2. Runner routes layer="tool-invocation" through the
 *      ToolInvocationClient, not the scanner client.
 *   3. Outcome + layer assertions drive pass/fail correctly
 *      (including the "right blocked, wrong layer" failure case).
 *
 * No real Lima/Tart VM required. Uses a mock driver + in-memory
 * ToolInvocationClient that returns canned responses. The live-VM
 * version of this matrix runs when `nautilo-smoke run --filter=FILE-*`
 * is invoked against a real server — tested manually for now, will
 * be part of the smoke playbook's CI rotation.
 */

import { describe, test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Runner,
  Expectations,
  type ToolInvocationClient,
  type ToolInvocationRequest,
  type ToolInvocationResponse,
  type RunnerEvent,
  type TestResult,
} from "../../src/index";
import { makeMockDriver } from "./mock-driver";

const EXPECTED_OUTCOMES_PATH = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "scripts",
  "security-test-env",
  "expected-outcomes.json",
);

describe("D063 Phase 6 — FILE-* matrix parses + runs through ToolInvocationClient", () => {
  test("expected-outcomes.json exposes FILE-01..06 with layer=tool-invocation", async () => {
    const raw = await readFile(EXPECTED_OUTCOMES_PATH, "utf8");
    const parsed = JSON.parse(raw) as { tests: Record<string, { layer?: string; tool_invocation?: unknown }> };
    const fileRows = Object.entries(parsed.tests).filter(([id]) => id.startsWith("FILE-"));
    expect(fileRows.length).toBe(6);
    for (const [id, row] of fileRows) {
      expect(row.layer).toBe("tool-invocation");
      expect(row.tool_invocation).toBeDefined();
      // Smoke: every row has a meaningful id
      expect(id).toMatch(/^FILE-0[1-6]$/);
    }
  });

  test("Expectations.load materializes tool_invocation payload + expect_layer_hit", async () => {
    const exp = await Expectations.load(EXPECTED_OUTCOMES_PATH);
    const file01 = exp.get("FILE-01", "linux");
    expect(file01).toBeDefined();
    expect(file01?.layer).toBe("tool-invocation");
    expect(file01?.toolInvocation).toEqual({
      tool: "file",
      args: { command: "read", zone: "absolute", path: "~/.ssh/id_rsa" },
    });
    expect(file01?.expectLayerHit).toBe("validate-before-execution");

    const file03 = exp.get("FILE-03", "linux");
    expect(file03?.toolInvocation?.workspaceRoot).toBe("~/nautilo-smoke-workspace");
    expect(file03?.expectLayerHit).toBe("realpath-containment");

    const file06 = exp.get("FILE-06", "macos");
    expect(file06).toBeDefined();
    expect(file06?.platform).toBe("macos");
    // FILE-06 is macOS-only — no linux spec should exist
    expect(exp.get("FILE-06", "linux")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Runner dispatch
// ---------------------------------------------------------------------------

interface CannedResponse {
  readonly match: (req: ToolInvocationRequest) => boolean;
  readonly response: ToolInvocationResponse;
}

class StubToolInvocationClient implements ToolInvocationClient {
  readonly invocations: ToolInvocationRequest[] = [];
  constructor(private readonly canned: CannedResponse[]) {}

   
  async toolInvoke(req: ToolInvocationRequest): Promise<ToolInvocationResponse> {
    this.invocations.push(req);
    for (const c of this.canned) {
      if (c.match(req)) return c.response;
    }
    return {
      blocked: false,
      result: "unmatched-canned-response",
      layerHit: "handler",
    };
  }
}

describe("Runner dispatches FILE-* through ToolInvocationClient", () => {
  test("FILE-01 blocked at validate-before-execution → outcome=pass", async () => {
    const exp = await Expectations.load(EXPECTED_OUTCOMES_PATH);
    const driver = makeMockDriver({ platform: "linux" });
    const scanClient = {
      securityScan: async () => {
        throw new Error("scan client should not be called for tool-invocation tests");
      },
    };
    const toolClient = new StubToolInvocationClient([
      {
        match: (r) =>
          r.tool === "file" &&
          (r.args as { path?: string }).path === "~/.ssh/id_rsa",
        response: {
          blocked: true,
          reason: "Security: /.ssh resolves to protected path",
          layerHit: "validate-before-execution",
        },
      },
    ]);

    const results: TestResult[] = [];
    const runner = new Runner({
      expectations: exp,
      platforms: {
        linux: { driver, client: scanClient, toolInvocationClient: toolClient },
      },
      restoreBetweenTests: false,
      onEvent: (e: RunnerEvent) => {
        if (e.type === "test-end") results.push(e.result);
      },
    });

    await runner.runMatrix({ pattern: "FILE-01", platforms: ["linux"] });
    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toBe("pass");
    expect(results[0]!.blocked).toBe(true);
    // Stub was actually called — proves dispatch went through the tool client
    expect(toolClient.invocations).toHaveLength(1);
    expect(toolClient.invocations[0]!.tool).toBe("file");
  });

  test("FILE-03 layer drift (right block, wrong layer) → outcome=error", async () => {
    const exp = await Expectations.load(EXPECTED_OUTCOMES_PATH);
    const driver = makeMockDriver({ platform: "linux" });
    const scanClient = {
      securityScan: async () => {
        throw new Error("scan client should not be called");
      },
    };
    // FILE-03 expects layer=realpath-containment. Return blocked but
    // from a different layer — this MUST fail (outcome=error) so the
    // test catches the class of drift where the right outcome happens
    // by the wrong gate.
    const toolClient = new StubToolInvocationClient([
      {
        match: () => true,
        response: {
          blocked: true,
          reason: "Security: /.ssh resolves to protected path",
          layerHit: "validate-before-execution", // ← WRONG layer for FILE-03
        },
      },
    ]);

    const results: TestResult[] = [];
    const runner = new Runner({
      expectations: exp,
      platforms: {
        linux: { driver, client: scanClient, toolInvocationClient: toolClient },
      },
      restoreBetweenTests: false,
      onEvent: (e: RunnerEvent) => {
        if (e.type === "test-end") results.push(e.result);
      },
    });

    await runner.runMatrix({ pattern: "FILE-03", platforms: ["linux"] });
    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toBe("error");
    expect(results[0]!.errorDetail).toMatch(/layer drift/);
    expect(results[0]!.errorDetail).toMatch(/realpath-containment/);
  });

  test("FILE-05 allowed walker (handler, no block) → outcome=pass", async () => {
    const exp = await Expectations.load(EXPECTED_OUTCOMES_PATH);
    const driver = makeMockDriver({ platform: "linux" });
    const scanClient = { securityScan: async () => { throw new Error("nope"); } };
    const toolClient = new StubToolInvocationClient([
      {
        match: (r) => r.tool === "file" && (r.args as { command?: string }).command === "grep",
        response: {
          blocked: false,
          result: "0 matches", // walker skipped hijack-dir
          layerHit: "handler",
        },
      },
    ]);

    const results: TestResult[] = [];
    const runner = new Runner({
      expectations: exp,
      platforms: {
        linux: { driver, client: scanClient, toolInvocationClient: toolClient },
      },
      restoreBetweenTests: false,
      onEvent: (e: RunnerEvent) => {
        if (e.type === "test-end") results.push(e.result);
      },
    });

    await runner.runMatrix({ pattern: "FILE-05", platforms: ["linux"] });
    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toBe("pass");
    expect(results[0]!.blocked).toBe(false);
  });

  test("missing toolInvocationClient on platform → outcome=error with clear message", async () => {
    const exp = await Expectations.load(EXPECTED_OUTCOMES_PATH);
    const driver = makeMockDriver({ platform: "linux" });
    const scanClient = { securityScan: async () => { throw new Error("nope"); } };

    const results: TestResult[] = [];
    const runner = new Runner({
      expectations: exp,
      platforms: {
        linux: { driver, client: scanClient /* no toolInvocationClient */ },
      },
      restoreBetweenTests: false,
      onEvent: (e: RunnerEvent) => {
        if (e.type === "test-end") results.push(e.result);
      },
    });

    await runner.runMatrix({ pattern: "FILE-01", platforms: ["linux"] });
    expect(results[0]!.outcome).toBe("error");
    expect(results[0]!.errorDetail).toMatch(/toolInvocationClient/);
  });

  // -------------------------------------------------------------------------
  // beforeToolInvocation hook — D060 Phase 1 / D063 Phase 6 follow-up
  // -------------------------------------------------------------------------

  test("beforeToolInvocation runs exactly once before dispatch", async () => {
    const exp = await Expectations.load(EXPECTED_OUTCOMES_PATH);
    const driver = makeMockDriver({ platform: "linux" });
    const scanClient = { securityScan: async () => { throw new Error("nope"); } };
    const toolClient = new StubToolInvocationClient([
      {
        match: () => true,
        response: {
          blocked: true,
          reason: "Security: denied",
          layerHit: "validate-before-execution",
        },
      },
    ]);
    let hookCallCount = 0;
    const beforeToolInvocation = async (): Promise<void> => {
      hookCallCount += 1;
    };

    const runner = new Runner({
      expectations: exp,
      platforms: {
        linux: { driver, client: scanClient, toolInvocationClient: toolClient, beforeToolInvocation },
      },
      restoreBetweenTests: false,
      onEvent: () => {},
    });

    await runner.runMatrix({ pattern: "FILE-01", platforms: ["linux"] });
    expect(hookCallCount).toBe(1);
    expect(toolClient.invocations).toHaveLength(1);
  });

  test("beforeToolInvocation throw → outcome=error, dispatch skipped", async () => {
    const exp = await Expectations.load(EXPECTED_OUTCOMES_PATH);
    const driver = makeMockDriver({ platform: "linux" });
    const scanClient = { securityScan: async () => { throw new Error("nope"); } };
    const toolClient = new StubToolInvocationClient([
      {
        match: () => true,
        response: { blocked: true, reason: "x", layerHit: "handler" },
      },
    ]);
    const beforeToolInvocation = async (): Promise<void> => {
      throw new Error("service never came up");
    };

    const results: TestResult[] = [];
    const runner = new Runner({
      expectations: exp,
      platforms: {
        linux: { driver, client: scanClient, toolInvocationClient: toolClient, beforeToolInvocation },
      },
      restoreBetweenTests: false,
      onEvent: (e: RunnerEvent) => {
        if (e.type === "test-end") results.push(e.result);
      },
    });

    await runner.runMatrix({ pattern: "FILE-01", platforms: ["linux"] });
    expect(results[0]!.outcome).toBe("error");
    expect(results[0]!.errorDetail).toMatch(/service never came up/);
    // Runner wraps the error with context in `messages` (raw error
    // alone in errorDetail stays consistent with other error-shape
    // branches like snapshot-restore failure).
    expect(results[0]!.messages.join("\n")).toMatch(/beforeToolInvocation failed/);
    // Tool client must NOT have been called — hook failure short-circuits.
    expect(toolClient.invocations).toHaveLength(0);
  });

  test("beforeToolInvocation NOT invoked for scanner-layer tests", async () => {
    // Build a minimal scanner spec and verify the hook doesn't fire for it.
    const raw = {
      "SCAN-HOOK-01": {
        platforms: ["linux"],
        layer: "command-scanner" as const,
        description: "hook guard",
        destructive_command: "rm -rf /",
        substitution_command: null,
        modes_supported: ["destructive" as const],
        expect_blocked: true,
        expect_message_contains: [],
        honeypot_required: false,
        security_levels: ["standard" as const],
      },
    };
    const exp = new Expectations(raw);
    const driver = makeMockDriver({ platform: "linux" });
    const scanClient = {
      securityScan: async () => ({
        layer: "command" as const,
        level: "standard" as const,
        blocked: true,
        reason: "blocked",
      }),
    };
    const toolClient = new StubToolInvocationClient([]);
    let hookCallCount = 0;
    const beforeToolInvocation = async (): Promise<void> => {
      hookCallCount += 1;
    };

    const runner = new Runner({
      expectations: exp,
      platforms: {
        linux: { driver, client: scanClient, toolInvocationClient: toolClient, beforeToolInvocation },
      },
      restoreBetweenTests: false,
      onEvent: () => {},
    });

    await runner.runMatrix({ platforms: ["linux"] });
    expect(hookCallCount).toBe(0); // scanner tests don't need the in-VM server
  });
});
