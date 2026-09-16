/**
 * Runner unit tests — mock driver + mock client to exercise the
 * orchestration paths without needing live VMs.
 *
 * Separate integration tests (gated on NAUTILO_SMOKE_INTEGRATION_SLOW)
 * drive the Runner against real Lima/Tart VMs.
 */

import { describe, test, expect } from "bun:test";
import { Runner, type RunnerEvent } from "../../src/runner.ts";
import { Expectations } from "../../src/expectations.ts";
import type { VmDriver, VmStatus, HealthProbeOptions } from "../../src/driver.ts";
import type {
  NautiloClient,
  SecurityScanRequest,
  SecurityScanResult,
  ToolInvocationClient,
} from "../../src/nautilo-client.ts";
import type {
  Platform,
  HealthProbeResult,
  ExecResult,
  ExecOptions,
} from "../../src/types.ts";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const RAW_TESTS = {
  "SCAN-01": {
    platforms: ["linux", "macos"],
    layer: "command-scanner",
    description: "rm -rf /",
    destructive_command: "rm -rf /",
    substitution_command: null,
    modes_supported: ["destructive"],
    expect_blocked: true,
    expect_message_contains: ["rm"],
    honeypot_required: false,
    security_levels: ["standard"],
    timeout_ms: 5000,
  },
  "PATH-01": {
    platforms: ["linux"],
    layer: "path-deny",
    description: "~/.ssh/id_rsa",
    destructive_command: "~/.ssh/id_rsa",
    substitution_command: null,
    modes_supported: ["destructive"],
    expect_blocked: true,
    expect_message_contains: [],
    honeypot_required: true,
    security_levels: ["standard"],
    timeout_ms: 5000,
  },
  "UNMATCHED": {
    platforms: ["linux"],
    layer: "command-scanner",
    description: "this test's expected-reason won't match",
    destructive_command: "echo x",
    substitution_command: null,
    modes_supported: ["destructive"],
    expect_blocked: true,
    expect_message_contains: ["some-phrase-not-in-reason"],
    honeypot_required: false,
    security_levels: ["standard"],
    timeout_ms: 5000,
  },
};

class MockDriver implements VmDriver {
  readonly platform: Platform;
  readonly vmName: string;
  public snapshotRestoreCount = 0;
  public shouldFailRestore = false;
  public healthProbeOk = true;

  constructor(platform: Platform, vmName: string) {
    this.platform = platform;
    this.vmName = vmName;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async status(): Promise<VmStatus> { return "running"; }
  async snapshotTake(_name: string): Promise<void> {}
  async snapshotRestore(_name: string): Promise<void> {
    this.snapshotRestoreCount++;
    if (this.shouldFailRestore) throw new Error("restore boom");
  }
  async snapshotList(): Promise<readonly string[]> { return ["baseline"]; }
  async execShell(_cmd: string, _opts?: ExecOptions): Promise<ExecResult> {
    return { stdout: "", stderr: "", exitCode: 0, durationMs: 0, timedOut: false };
  }
  async healthProbe(_opts?: HealthProbeOptions): Promise<HealthProbeResult> {
    return {
      ok: this.healthProbeOk,
      checkedAt: new Date().toISOString(),
      probeResults: [{ probe: "ssh", ok: this.healthProbeOk }],
      ...(this.healthProbeOk ? {} : { reason: "mock-dead" }),
    };
  }
}

class MockClient implements NautiloClient {
  public calls: SecurityScanRequest[] = [];
  constructor(private readonly response: (req: SecurityScanRequest) => SecurityScanResult | Error) {}
  async securityScan(req: SecurityScanRequest): Promise<SecurityScanResult> {
    this.calls.push(req);
    const r = this.response(req);
    if (r instanceof Error) throw r;
    return r;
  }
}

class MockToolInvocationClient implements ToolInvocationClient {
  public calls: unknown[] = [];
  constructor(
    private readonly response: { blocked: boolean; result?: string; reason?: string; layerHit: "handler" },
  ) {}
  async toolInvoke(req: never): Promise<typeof this.response> {
    this.calls.push(req);
    return this.response;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Runner — basic orchestration", () => {
  test("runs a matrix and reports pass/fail/warn correctly", async () => {
    const expectations = new Expectations(RAW_TESTS);
    const driver = new MockDriver("linux", "linux-mock");
    const client = new MockClient((req) => {
      // SCAN-01: block with "rm -rf" reason → pass
      if (req.input === "rm -rf /") {
        return { layer: "command", level: "standard", blocked: true, reason: "rm -rf blocked" };
      }
      // PATH-01: block with ssh reason → pass (no expect_message_contains)
      if (req.input.includes(".ssh")) {
        return { layer: "path", level: "standard", blocked: true, reason: "protected path" };
      }
      // UNMATCHED: block, but with reason that doesn't match expected phrase → warn
      return {
        layer: "command",
        level: "standard",
        blocked: true,
        reason: "some other reason",
      };
    });

    const events: RunnerEvent[] = [];
    const runner = new Runner({
      expectations,
      platforms: { linux: { driver, client } },
      onEvent: (e) => events.push(e),
    });

    const report = await runner.runMatrix({ mode: "destructive", level: "standard" });

    expect(report.summary.pass).toBe(2);
    expect(report.summary.warn).toBe(1);
    expect(report.summary.fail).toBe(0);
    expect(client.calls.length).toBe(3);
    expect(driver.snapshotRestoreCount).toBe(3); // restore-before-each-test

    // Events: start, per-test start/end, end
    expect(events.filter((e) => e.type === "run-start")).toHaveLength(1);
    expect(events.filter((e) => e.type === "test-end")).toHaveLength(3);
  });

  test("reports fail when scanner allows something that should be blocked", async () => {
    const expectations = new Expectations({
      "SCAN-01": RAW_TESTS["SCAN-01"],
    });
    const driver = new MockDriver("linux", "mock");
    const client = new MockClient(() => ({
      layer: "command",
      level: "standard",
      blocked: false,
    }));

    const runner = new Runner({
      expectations,
      platforms: { linux: { driver, client } },
    });
    const report = await runner.runMatrix();

    expect(report.summary.fail).toBe(1);
    expect(report.summary.pass).toBe(0);
    expect(report.results[0]?.outcome).toBe("fail");
  });

  test("marks test as skipped when mode isn't supported", async () => {
    const expectations = new Expectations({
      "SCAN-01": {
        ...RAW_TESTS["SCAN-01"],
        modes_supported: ["substitution"], // only substitution
      },
    });
    const driver = new MockDriver("linux", "mock");
    const client = new MockClient(() => ({
      layer: "command",
      level: "standard",
      blocked: true,
    }));

    const runner = new Runner({
      expectations,
      platforms: { linux: { driver, client } },
    });
    const report = await runner.runMatrix({ mode: "destructive" });

    expect(report.summary.skipped).toBe(1);
    expect(client.calls.length).toBe(0);
  });

  test("marks test as error when snapshot restore throws", async () => {
    const expectations = new Expectations({
      "SCAN-01": RAW_TESTS["SCAN-01"],
    });
    const driver = new MockDriver("linux", "mock");
    driver.shouldFailRestore = true;
    const client = new MockClient(() => ({
      layer: "command",
      level: "standard",
      blocked: true,
    }));

    const runner = new Runner({
      expectations,
      platforms: { linux: { driver, client } },
    });
    const report = await runner.runMatrix();

    expect(report.summary.error).toBe(1);
    expect(report.results[0]?.errorDetail).toContain("restore boom");
    expect(client.calls.length).toBe(0); // client never called
  });

  test("marks test as error when scanner throws", async () => {
    const expectations = new Expectations({
      "SCAN-01": RAW_TESTS["SCAN-01"],
    });
    const driver = new MockDriver("linux", "mock");
    const client = new MockClient(() => new Error("network down"));

    const runner = new Runner({
      expectations,
      platforms: { linux: { driver, client } },
    });
    const report = await runner.runMatrix();

    expect(report.summary.error).toBe(1);
    expect(report.results[0]?.errorDetail).toContain("network down");
  });

  test("filters by pattern", async () => {
    const expectations = new Expectations(RAW_TESTS);
    const driver = new MockDriver("linux", "mock");
    const client = new MockClient(() => ({
      layer: "command",
      level: "standard",
      blocked: true,
      reason: "rm",
    }));

    const runner = new Runner({
      expectations,
      platforms: { linux: { driver, client } },
    });
    const report = await runner.runMatrix({ pattern: "SCAN-*" });

    // Only SCAN-01 matches (PATH-01 and UNMATCHED excluded by pattern)
    expect(report.results.length).toBe(1);
    expect(report.results[0]?.testId).toBe("SCAN-01");
  });

  test("tool-invocation rows assert on successful tool output", async () => {
    const expectations = new Expectations({
      "SANDBOX-NET-LINUX-01": {
        platforms: ["linux"],
        layer: "tool-invocation",
        description: "network marker",
        modes_supported: ["destructive"],
        expect_blocked: false,
        expect_message_contains: ["NETWORK-BLOCKED"],
        honeypot_required: false,
        security_levels: ["standard"],
        tool_invocation: {
          tool: "run_shell",
          args: { command: "curl example.com || echo NETWORK-BLOCKED" },
          deployment_mode: "server",
          network_policy: { mode: "isolated" },
        },
      },
    });
    const driver = new MockDriver("linux", "mock");
    const client = new MockClient(() => ({
      layer: "command",
      level: "standard",
      blocked: true,
    }));
    const toolInvocationClient = new MockToolInvocationClient({
      blocked: false,
      result: "NETWORK-BLOCKED",
      layerHit: "handler",
    });

    const runner = new Runner({
      expectations,
      platforms: { linux: { driver, client, toolInvocationClient } },
    });
    const report = await runner.runMatrix({ mode: "destructive", level: "standard" });

    expect(report.summary.pass).toBe(1);
    expect(toolInvocationClient.calls.length).toBe(1);
    expect(toolInvocationClient.calls[0]).toMatchObject({
      deploymentMode: "server",
      networkPolicy: { mode: "isolated" },
    });
  });

  test("runs both platforms when both configured", async () => {
    const expectations = new Expectations(RAW_TESTS);
    const linuxDriver = new MockDriver("linux", "lin");
    const macosDriver = new MockDriver("macos", "mac");
    const client = new MockClient(() => ({
      layer: "command",
      level: "standard",
      blocked: true,
      reason: "rm",
    }));

    const runner = new Runner({
      expectations,
      platforms: {
        linux: { driver: linuxDriver, client },
        macos: { driver: macosDriver, client },
      },
    });
    const report = await runner.runMatrix({ pattern: "SCAN-01" });

    // SCAN-01 runs on both platforms
    expect(report.results.length).toBe(2);
    expect(report.results.map((r) => r.platform).sort()).toEqual(["linux", "macos"]);
  });
});
