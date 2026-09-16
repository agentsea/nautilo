import { describe, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseGitleaksReport,
  parseSecurityProbeReportFile,
  parseOsvScannerReport,
  parseSemgrepReport,
  parseTrivyReport,
  runSecurityProbeSuite,
  runSecurityProbeProcess,
} from "../../electron/security-scan/probes.ts";

const unavailable = async () => ({ state: "unavailable" as const, internalPath: null });

describe("D560 Desktop security probes", () => {
  test("distinguishes OSV missing package sources from failure and cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-osv-coverage-test-"));
    const scratchRoot = join(root, "scratch");
    await mkdir(scratchRoot, { mode: 0o700 });
    for (const outcome of [
      { exitCode: 128, cancelled: false, timedOut: false },
      { exitCode: 127, cancelled: false, timedOut: false },
      { exitCode: 128, cancelled: true, timedOut: false },
    ]) {
      const result = await runSecurityProbeSuite(root, {
        scratchRoot, cacheRoot: join(root, "cache"),
        resolveGitleaks: unavailable,
        resolveOsvScanner: async () => ({ state: "ready", internalPath: "/managed/osv-scanner" }),
        resolveTrivy: unavailable, resolveSemgrep: unavailable, resolveSemgrepRules: unavailable,
        runProcess: async () => outcome,
      });
      const lane = result.lanes.find((item) => item.probe === "osv_scanner")!;
      if (outcome.cancelled) expect(lane).toMatchObject({ state: "cancelled", error: null });
      else if (outcome.exitCode === 127) expect(lane).toMatchObject({ state: "failed", error: { code: "probe_failed", retryable: true } });
      else expect(lane).toMatchObject({
        state: "unavailable", coverage: "limited", observationCount: 0,
        error: { code: "probe_unavailable", retryable: false },
      });
      expect(result.observations).toEqual([]);
    }
  });

  test("admits only redacted, relative Gitleaks evidence with stable identity", () => {
    const parsed = parseGitleaksReport("/repo", JSON.stringify([{
      RuleID: "generic-api-key",
      File: "/repo/src/config.ts",
      StartLine: 4,
      EndLine: 4,
      Secret: "must-not-survive",
      Match: "token=must-not-survive",
      Author: "private-person",
    }]));
    expect(parsed.observations).toHaveLength(1);
    expect(parsed.observations[0]).toMatchObject({
      probe: "gitleaks",
      sourceScope: "current_tree",
      ruleId: "generic-api-key",
      relativePath: "src/config.ts",
      secretRedacted: true,
    });
    expect(parsed.observations[0]?.id).toMatch(/^observation_gitleaks_[a-f0-9]{24}$/);
    expect(JSON.stringify(parsed)).not.toContain("must-not-survive");
    expect(JSON.stringify(parsed)).not.toContain("private-person");
    expect(JSON.stringify(parsed)).not.toContain("/repo");
    expect(() => parseGitleaksReport("/repo", JSON.stringify([{
      RuleID: "outside",
      File: "/other/private.ts",
      StartLine: 1,
    }]))).toThrow("probe_output_invalid");
  });

  test("runs only fixed Gitleaks argv and reports unsupported lanes honestly", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-security-probe-test-"));
    const scratchRoot = join(root, "scratch");
    await mkdir(scratchRoot, { mode: 0o700 });
    let captured: { executablePath: string; argv: readonly string[]; cwd: string } | undefined;
    const result = await runSecurityProbeSuite(root, {
      scratchRoot,
      cacheRoot: join(root, "cache"),
      resolveGitleaks: async () => ({ state: "ready", internalPath: "/managed/gitleaks" }),
      resolveOsvScanner: unavailable,
      resolveTrivy: unavailable,
      resolveSemgrep: unavailable,
      resolveSemgrepRules: unavailable,
      runProcess: async (request) => {
        captured = request;
        const reportIndex = request.argv.indexOf("--report-path");
        const reportPath = request.argv[reportIndex + 1]!;
        await Bun.write(reportPath, JSON.stringify([{
          RuleID: "secret-rule",
          File: join(root, "src", "secret.ts"),
          StartLine: 9,
          Secret: "never-returned",
        }]));
        return { exitCode: 0, cancelled: false, timedOut: false };
      },
    });
    expect(captured?.executablePath).toBe("/managed/gitleaks");
    expect(captured?.cwd).toBe(root);
    expect(captured?.argv[0]).toBe("dir");
    expect(captured?.argv).toContain("--redact=100");
    expect(captured?.argv).not.toContain("--timeout=300");
    expect(captured?.argv.at(-1)).toBe(root);
    expect(result.lanes).toEqual([
      expect.objectContaining({ probe: "gitleaks", state: "completed", observationCount: 1, coverage: "limited" }),
      expect.objectContaining({ probe: "osv_scanner", state: "unavailable" }),
      expect.objectContaining({ probe: "trivy", state: "unavailable" }),
      expect.objectContaining({ probe: "semgrep", state: "unavailable" }),
    ]);
    expect(JSON.stringify(result)).not.toContain("never-returned");
  });

  test("does not spawn when the managed Gitleaks runtime is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-security-probe-test-"));
    const scratchRoot = join(root, "scratch");
    await mkdir(scratchRoot, { mode: 0o700 });
    let spawned = false;
    const result = await runSecurityProbeSuite(root, {
      scratchRoot,
      cacheRoot: join(root, "cache"),
      resolveGitleaks: async () => ({ state: "unavailable", internalPath: null }),
      resolveOsvScanner: unavailable,
      resolveTrivy: unavailable,
      resolveSemgrep: unavailable,
      resolveSemgrepRules: unavailable,
      runProcess: async () => {
        spawned = true;
        return { exitCode: 0, cancelled: false, timedOut: false };
      },
    });
    expect(spawned).toBe(false);
    expect(result.lanes[0]).toMatchObject({ probe: "gitleaks", state: "unavailable" });
  });

  test("scans both the current tree and git history without duplicating admitted secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-security-probe-test-"));
    const scratchRoot = join(root, "scratch");
    await mkdir(scratchRoot, { mode: 0o700 });
    await mkdir(join(root, ".git"), { mode: 0o700 });
    const invocations: string[] = [];
    const result = await runSecurityProbeSuite(root, {
      scratchRoot,
      cacheRoot: join(root, "cache"),
      resolveGitleaks: async () => ({ state: "ready", internalPath: "/managed/gitleaks" }),
      resolveOsvScanner: unavailable,
      resolveTrivy: unavailable,
      resolveSemgrep: unavailable,
      resolveSemgrepRules: unavailable,
      runProcess: async (request) => {
        invocations.push(request.argv[0]!);
        const reportPath = request.argv[request.argv.indexOf("--report-path") + 1]!;
        const findings = [{ RuleID: "secret-rule", File: join(root, "src", "secret.ts"), StartLine: 9 }];
        if (request.argv[0] === "git") {
          findings.push({ RuleID: "history-secret", File: join(root, "deleted", "old.env"), StartLine: 2 });
        }
        await Bun.write(reportPath, JSON.stringify(findings));
        return { exitCode: 0, cancelled: false, timedOut: false };
      },
    });
    expect(invocations.sort()).toEqual(["dir", "git"]);
    expect(result.lanes[0]).toMatchObject({ probe: "gitleaks", state: "completed", observationCount: 2 });
    expect(result.observations).toHaveLength(2);
    expect(result.observations.find((item) => item.sourceScope === "current_tree")).toMatchObject({ relativePath: "src/secret.ts" });
    expect(result.observations.find((item) => item.sourceScope === "git_history")).toMatchObject({ relativePath: null, historyOnlyPath: "deleted/old.env" });
  });

  test("preserves every distinct finding when every scanner is noisy", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-security-probe-test-"));
    const scratchRoot = join(root, "scratch");
    await mkdir(scratchRoot, { mode: 0o700 });
    const ready = (name: string) => async () => ({ state: "ready" as const, internalPath: `/managed/${name}` });
    const result = await runSecurityProbeSuite(root, {
      scratchRoot,
      cacheRoot: join(root, "cache"),
      resolveGitleaks: ready("gitleaks"),
      resolveOsvScanner: ready("osv-scanner"),
      resolveTrivy: ready("trivy"),
      resolveSemgrep: ready("semgrep-core"),
      resolveSemgrepRules: ready("semgrep-rules"),
      runProcess: async (request) => {
        if (request.executablePath.endsWith("gitleaks")) {
          const reportPath = request.argv[request.argv.indexOf("--report-path") + 1]!;
          await Bun.write(reportPath, JSON.stringify(Array.from({ length: 1_000 }, (_, index) => ({ RuleID: `secret-${index}`, File: join(root, "src", `secret-${index}.ts`), StartLine: 1 }))));
        } else if (request.executablePath.endsWith("osv-scanner")) {
          const reportPath = request.argv[request.argv.indexOf("--output-file") + 1]!;
          await Bun.write(reportPath, JSON.stringify({ results: [{ source: { path: join(root, "bun.lock") }, packages: Array.from({ length: 1_000 }, (_, index) => ({ package: { name: `package-${index}`, version: "1.0.0" }, groups: [{ ids: [`GHSA-${String(index).padStart(4, "0")}-aaaa-bbbb`] }] })) }] }));
        } else if (request.executablePath.endsWith("trivy")) {
          const reportPath = request.argv[request.argv.indexOf("--output") + 1]!;
          await Bun.write(reportPath, JSON.stringify({ Results: [{ Target: "Dockerfile", Misconfigurations: Array.from({ length: 1_000 }, (_, index) => ({ ID: `DS-${index}`, Title: `Configuration lead ${index}`, Severity: "HIGH", CauseMetadata: { StartLine: index + 1 } })) }] }));
        } else {
          await Bun.write(request.stdoutPath!, JSON.stringify({ results: Array.from({ length: 1_000 }, (_, index) => ({ check_id: `nautilo.rule-${index}`, path: join(root, "src", `code-${index}.ts`), start: { line: 1 }, end: { line: 1 }, extra: { message: `Code lead ${index}`, severity: "ERROR" } })) }));
        }
        return { exitCode: 0, cancelled: false, timedOut: false };
      },
    });
    expect(result.observations).toHaveLength(4_000);
    expect(result.lanes.map((lane) => lane.observationCount)).toEqual([1_000, 1_000, 1_000, 1_000]);
    expect(result.lanes.every((lane) => lane.state === "completed")).toBeTrue();
  });

  test("streams reports beyond 16 MiB without retaining raw sibling records or secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-d577-large-report-"));
    try {
      const reportPath = join(root, "gitleaks.json");
      const records = Array.from({ length: 1_000 }, (_, index) => ({
        RuleID: `secret-${index}`, File: `src/é-${index}.ts`, StartLine: 1,
        Secret: "never-admit-this-secret", Match: "x".repeat(20_000),
      }));
      const raw = JSON.stringify(records);
      expect(Buffer.byteLength(raw)).toBeGreaterThan(16 * 1024 * 1024);
      await Bun.write(reportPath, raw);
      let largestNormalization = 0;
      const result = await parseSecurityProbeReportFile({
        probe: "gitleaks", root, reportPath,
        parse: (target, group) => {
          largestNormalization = Math.max(largestNormalization, Buffer.byteLength(group));
          return parseGitleaksReport(target, group);
        },
      });
      expect(result.observations).toHaveLength(records.length);
      expect(new Set(result.observations.map((item) => item.id)).size).toBe(records.length);
      expect(result.observations.at(-1)?.relativePath).toBe("src/é-999.ts");
      expect(largestNormalization).toBeLessThan(21_000);
      expect(JSON.stringify(result)).not.toContain("never-admit-this-secret");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("retains a sanitized valid prefix and marks malformed report tails incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-d577-partial-report-"));
    try {
      await mkdir(join(root, "scratch"), { mode: 0o700 });
      const result = await runSecurityProbeSuite(root, {
        scratchRoot: join(root, "scratch"), cacheRoot: join(root, "cache"),
        resolveGitleaks: async () => ({ state: "ready", internalPath: "/managed/gitleaks" }),
        resolveOsvScanner: unavailable, resolveTrivy: unavailable,
        resolveSemgrep: unavailable, resolveSemgrepRules: unavailable,
        runProcess: async (request) => {
          const reportPath = request.argv[request.argv.indexOf("--report-path") + 1]!;
          await Bun.write(reportPath, '[{"RuleID":"secret","File":"src/a.ts","StartLine":1,"Secret":"private-value"},{"broken":');
          return { exitCode: 0, cancelled: false, timedOut: false };
        },
      });
      expect(result.observations).toHaveLength(1);
      expect(result.lanes[0]).toMatchObject({ state: "failed", coverage: "limited", observationCount: 1, error: { code: "probe_output_invalid" } });
      expect(JSON.stringify(result)).not.toContain("private-value");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("aborts streaming reads without returning a successful empty report", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(parseSecurityProbeReportFile({
      probe: "gitleaks", root: "/repo", reportPath: "/not-opened.json",
      parse: parseGitleaksReport, signal: controller.signal,
    })).rejects.toThrow();
  });

  test("reports preparation before a stalled acquisition and propagates cancellation to owned work", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-d577-startup-events-"));
    try {
      await mkdir(join(root, "scratch"), { mode: 0o700 });
      const controller = new AbortController();
      const events: string[] = [];
      let acquisitionStarted!: () => void;
      const started = new Promise<void>((resolve) => { acquisitionStarted = resolve; });
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let sawCancelledSignal = false;
      const work = runSecurityProbeSuite(root, {
        scratchRoot: join(root, "scratch"), cacheRoot: join(root, "cache"),
        resolveGitleaks: async (signal) => {
          acquisitionStarted();
          await held;
          sawCancelledSignal = signal?.aborted === true;
          return { state: "ready", internalPath: "/managed/gitleaks" };
        },
        resolveOsvScanner: unavailable, resolveTrivy: unavailable,
        resolveSemgrep: unavailable, resolveSemgrepRules: unavailable,
        runProcess: async (request) => ({ exitCode: null, cancelled: request.signal?.aborted === true, timedOut: false }),
      }, controller.signal, (event) => events.push(event.stage));
      await started;
      expect(events).toEqual(["preparing_scanners"]);
      controller.abort();
      release();
      const result = await work;
      expect(sawCancelledSignal).toBeTrue();
      expect(result.lanes[0]?.state).toBe("cancelled");
      expect(events).not.toContain("research_ready");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("normalizes OSV, Trivy, and Semgrep findings without source excerpts", () => {
    const root = "/repo";
    const osv = parseOsvScannerReport(root, JSON.stringify({ results: [{
      source: { path: "/repo/bun.lock" },
      packages: [{ package: { name: "example", version: "1.0.0" }, groups: [{ ids: ["GHSA-aaaa-bbbb-cccc"], max_severity: "9.1" }] }],
    }] }));
    const trivy = parseTrivyReport(root, JSON.stringify({ Results: [{
      Target: "Dockerfile",
      Misconfigurations: [{ ID: "DS-0002", Title: "Image user should not be root", Severity: "HIGH", CauseMetadata: { StartLine: 2, EndLine: 2, Code: { Lines: [{ Content: "USER root" }] } } }],
    }] }));
    const semgrep = parseSemgrepReport(root, `.\n${JSON.stringify({ results: [{
      check_id: "nautilo.javascript.command-injection", path: "/repo/src/run.ts",
      start: { line: 7 }, end: { line: 7 },
      extra: { message: "Untrusted input reaches a command sink", severity: "ERROR", metavars: { "$X": { abstract_content: "do-not-return" } } },
    }] })}`);
    expect(osv.observations[0]).toMatchObject({ probe: "osv_scanner", advisoryId: "GHSA-aaaa-bbbb-cccc", packageName: "example", severity: "critical" });
    expect(trivy.observations[0]).toMatchObject({ probe: "trivy", ruleId: "DS-0002", relativePath: "Dockerfile", startLine: 2, severity: "high" });
    expect(semgrep.observations[0]).toMatchObject({ probe: "semgrep", ruleId: "nautilo.javascript.command-injection", relativePath: "src/run.ts", startLine: 7 });
    expect(JSON.stringify({ osv, trivy, semgrep })).not.toContain("USER root");
    expect(JSON.stringify(semgrep)).not.toContain("do-not-return");
  });
});


test("probe completion and spawn failure close output handles and detach cancellation listeners", async () => {
  const root = await mkdtemp(join(tmpdir(), "nautilo-probe-cleanup-"));
  const originalOpen = fsPromises.open;
  try {
    for (const executablePath of ["/usr/bin/true", join(root, "missing-executable")]) {
      const controller = new AbortController();
      const remove = spyOn(controller.signal, "removeEventListener");
      let close: { mockRestore(): void } | undefined;
      const opened = spyOn(fsPromises, "open").mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        close = spyOn(handle, "close");
        return handle;
      });
      try {
        const outcome = runSecurityProbeProcess({ executablePath, argv: [], cwd: root, signal: controller.signal, stdoutPath: join(root, executablePath === "/usr/bin/true" ? "success" : "error") });
        if (executablePath === "/usr/bin/true") expect(await outcome).toMatchObject({ exitCode: 0, cancelled: false });
        else expect(await outcome.catch((error: unknown) => error)).toBeInstanceOf(Error);
        expect(close).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      } finally { opened.mockRestore(); close?.mockRestore(); remove.mockRestore(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
