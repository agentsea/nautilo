/**
 * `run` command — execute the smoke matrix.
 *
 * Usage:
 *   nautilo-smoke run [--platform=linux|macos|both] [--mode=destructive|substitution]
 *                     [--level=standard|yolo|...] [--only=<glob>] [--layer=...]
 *                     [--dry-run] [--json-report=<path>] [--md-report=<path>]
 *
 * Report flags use the D063 Phase 2.8 Reporter — stable-key JSON or
 * human-readable Markdown. Both can be written in a single run; --json-report
 * writes machine-readable output, --md-report writes a PR-friendly summary.
 */

import { writeFile } from "node:fs/promises";
import {
  Runner,
  formatJson,
  formatMarkdown,
  registerShutdownHandlers,
  stopAllDrivers,
  type NamedDriver,
  type Platform,
  type Mode,
  type SecurityLevel,
  type TestResult,
  type RunnerEvent,
  type RunFilter,
  type TestLayer,
  type TestSpec,
} from "@nautilo/smoke-runner";
import { getString, type ParsedArgs } from "../lib/args.ts";
import { buildPlatformEntry, loadExpectations } from "../lib/factory.ts";

export async function runCommand(args: ParsedArgs): Promise<number> {
  const platformArg = getString(args, "platform", "both");
  const mode = getString(args, "mode", "destructive") as Mode;
  const level = getString(args, "level", "standard") as SecurityLevel;
  const pattern = typeof args.flags["only"] === "string" ? args.flags["only"] : undefined;
  const layer = typeof args.flags["layer"] === "string" ? args.flags["layer"] : undefined;
  const jsonReport = typeof args.flags["json-report"] === "string" ? args.flags["json-report"] : undefined;
  const mdReport = typeof args.flags["md-report"] === "string" ? args.flags["md-report"] : undefined;
  const keepVms = args.flags["keep-vms"] === true || args.flags["keep-vms"] === "";
  const dryRun = args.flags["dry-run"] === true || args.flags["dry-run"] === "";

  const platforms = parsePlatforms(platformArg);
  if (platforms.length === 0) {
    console.error(`nautilo-smoke run: invalid --platform=${platformArg} (expected linux | macos | both)`);
    return 64;
  }

  console.log(`nautilo-smoke run — platform=${platforms.join(",")} mode=${mode} level=${level}${dryRun ? " dry-run" : ""}`);

  const expectations = await loadExpectations();
  const scheduled = listScheduledSpecs(expectations, {
    platforms,
    ...(pattern !== undefined ? { pattern } : {}),
    ...(layer !== undefined ? { layer: layer as TestLayer } : {}),
  });

  if (dryRun) {
    renderDryRun(scheduled, mode, level);
    return scheduled.length === 0 ? 1 : 0;
  }

  const platformEntries: {
    linux?: Awaited<ReturnType<typeof buildPlatformEntry>>;
    macos?: Awaited<ReturnType<typeof buildPlatformEntry>>;
  } = {};
  for (const p of platforms) {
    platformEntries[p] = buildPlatformEntry(p);
  }

  // Collected once so both the finally and the signal handler stop the
  // same driver set. Keeps "did we leak a VM?" answerable by looking at
  // one list.
  const namedDrivers: NamedDriver[] = platforms.map((p) => ({
    name: `${p} VM`,
    driver: platformEntries[p]!.driver,
  }));

  // Ctrl-C / SIGTERM during a long matrix: stop VMs, exit cleanly.
  // Repeat signals are idempotent. beforeExit is unused here — no
  // HTTP server or writer to drain on the `run` path.
  const unregister = registerShutdownHandlers({
    drivers: namedDrivers,
    keepVms,
  });

  const runner = new Runner({
    expectations,
    platforms: platformEntries,
    onEvent: (e) => renderEvent(e),
  });

  const filter: RunFilter = {
    mode,
    level,
    platforms,
    ...(pattern !== undefined ? { pattern } : {}),
    ...(layer !== undefined ? { layer: layer as TestLayer } : {}),
  };

  try {
    const report = await runner.runMatrix(filter);

    if (jsonReport) {
      await writeFile(jsonReport, formatJson(report));
      console.log(`\n[nautilo-smoke] wrote JSON report → ${jsonReport}`);
    }
    if (mdReport) {
      await writeFile(mdReport, formatMarkdown(report));
      console.log(`[nautilo-smoke] wrote Markdown report → ${mdReport}`);
    }

    const { summary } = report;
    console.log("");
    console.log("Summary");
    console.log("-------");
    console.log(`  pass:     ${summary.pass}`);
    console.log(`  fail:     ${summary.fail}`);
    console.log(`  warn:     ${summary.warn}`);
    console.log(`  vm_dead:  ${summary.vmDead}`);
    console.log(`  skipped:  ${summary.skipped}`);
    console.log(`  error:    ${summary.error}`);
    console.log(`  total:    ${summary.total}`);
    console.log(`  duration: ${(report.durationMs / 1000).toFixed(1)}s`);

    return summary.fail + summary.vmDead + summary.error === 0 ? 0 : 1;
  } finally {
    unregister();
    if (keepVms) {
      console.log(`[nautilo-smoke] --keep-vms set; leaving ${namedDrivers.length} VM(s) running`);
    } else {
      await stopAllDrivers(namedDrivers);
    }
  }
}

function parsePlatforms(arg: string): Platform[] {
  if (arg === "both" || arg === "all") return ["linux", "macos"];
  if (arg === "linux") return ["linux"];
  if (arg === "macos") return ["macos"];
  return [];
}

function listScheduledSpecs(
  expectations: Awaited<ReturnType<typeof loadExpectations>>,
  filter: Pick<RunFilter, "platforms" | "pattern" | "layer">,
): readonly TestSpec[] {
  const specs: TestSpec[] = [];
  for (const platform of filter.platforms ?? []) {
    specs.push(...expectations.list({
      platform,
      ...(filter.pattern !== undefined ? { pattern: filter.pattern } : {}),
      ...(filter.layer !== undefined ? { layer: filter.layer } : {}),
    }));
  }
  return specs;
}

function renderDryRun(
  specs: readonly TestSpec[],
  mode: Mode,
  level: SecurityLevel,
): void {
  console.log("");
  console.log("Dry run schedule");
  console.log("----------------");
  if (specs.length === 0) {
    console.log("  no tests matched");
    return;
  }

  for (const spec of specs) {
    const runnable =
      spec.modesSupported.includes(mode) &&
      spec.securityLevels.includes(level);
    const suffix = runnable ? "" : " (would skip for selected mode/level)";
    console.log(`  [${spec.platform}] ${spec.id} layer=${spec.layer}${suffix}`);
  }
  console.log(`  total: ${specs.length}`);
}

function renderEvent(e: RunnerEvent): void {
  switch (e.type) {
    case "run-start":
      console.log(`  ${e.total} tests scheduled (run=${e.runId})`);
      break;
    case "test-start":
      process.stdout.write(`  [${e.platform}] ${e.testId} ... `);
      break;
    case "test-end":
      renderResult(e.result);
      break;
    case "run-end":
      break;
  }
}

function renderResult(r: TestResult): void {
  const tag = {
    pass: "PASS",
    fail: "FAIL",
    warn: "WARN",
    vm_dead: "DEAD",
    skipped: "SKIP",
    error: "ERR ",
  }[r.outcome];
  const ms = `${r.durationMs}ms`;
  console.log(`${tag} (${ms})`);
  if (r.outcome !== "pass" && r.outcome !== "skipped") {
    for (const m of r.messages) {
      console.log(`         ${m}`);
    }
  }
}
