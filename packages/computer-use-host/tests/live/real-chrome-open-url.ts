import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { COMPUTER_USE_BROWSER_CONTRACTS } from "@nautilo/computer-use-contracts";
import { COMPUTER_USE_NATIVE_CONTRACTS } from "@nautilo/computer-use-contracts/native";
import type {
  ComputerUseHostAuthorityScope,
  ComputerUseHostContract,
  ComputerUseHostResult,
  ComputerUseJson,
} from "@nautilo/computer-use-host-protocol";

import { createNativeCuaHost, type NativeCuaHost } from "../../src/index.ts";
import {
  HostContractRunner,
  type HostContractCallEvidence,
} from "../support/host-contract-runner.ts";

const driver = process.env["NAUTILO_CUA_DRIVER"] ?? "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
const destination = "https://en.wikipedia.org/wiki/Kyushu";
const authority: ComputerUseHostAuthorityScope = { authorityLeaseId: "real-chrome-live", authorityGeneration: 1 };
let sequence = 0;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function fenceFor(runtime: NativeCuaHost) {
  return {
    hostGeneration: runtime.hostGeneration,
    driverGeneration: runtime.driverGeneration,
    cancellationGeneration: 1,
  } as const;
}

async function execute(
  runner: HostContractRunner,
  contract: ComputerUseHostContract,
  args: Readonly<Record<string, ComputerUseJson>>,
): Promise<ComputerUseHostResult> {
  const requestId = `real-chrome-${++sequence}`;
  const call = runner.start({ requestId, contract, arguments: args });
  const watchdog = setTimeout(() => {
    call.cancel();
  }, 30_000);
  const outcome = await call.result.finally(() => clearTimeout(watchdog));
  outcome.attachment?.dispose();
  return outcome.result;
}

function completed(result: ComputerUseHostResult, status: string): Readonly<Record<string, ComputerUseJson>> {
  if (result.settlement !== "completed" || result.result["status"] !== status) {
    throw new Error(`real Chrome Host request failed: ${result.settlement}/${String(result.result["status"])}/${String(result.result["recovery"])}`);
  }
  return result.result;
}

function observed(result: ComputerUseHostResult, operation: string): Readonly<Record<string, ComputerUseJson>> {
  if (result.settlement !== "completed" || result.result["operation"] !== operation) {
    throw new Error(`real Chrome Host observation failed: ${result.settlement}/${String(result.result["operation"])}`);
  }
  return result.result;
}

async function exactChromeWindow(runner: HostContractRunner): Promise<Readonly<Record<string, ComputerUseJson>>> {
  const desktop = observed(await execute(runner, COMPUTER_USE_NATIVE_CONTRACTS.observe, {
    operation: "desktop_state",
    maxWindows: 100,
  }), "desktop_state");
  const applicationTargets = record(desktop["applicationTargets"]);
  const targets = Array.isArray(applicationTargets?.["targets"]) ? applicationTargets["targets"] : [];
  const chromeApps = targets.map(record).filter((candidate) => {
    const evidence = record(candidate?.["evidence"]);
    return evidence?.["kind"] === "app" && evidence["appLabel"] === "Google Chrome";
  });
  if (chromeApps.length !== 1) throw new Error(`expected one real Google Chrome application, observed ${chromeApps.length}`);
  const appTarget = record(chromeApps[0]?.["target"]);
  if (appTarget === null) throw new Error("real Chrome application target malformed");
  const windows = observed(await execute(runner, COMPUTER_USE_NATIVE_CONTRACTS.observe, {
    operation: "application_windows",
    target: appTarget as Readonly<Record<string, ComputerUseJson>>,
  }), "application_windows");
  const candidates = Array.isArray(windows["candidates"]) ? windows["candidates"] : [];
  if (candidates.length !== 1) throw new Error(`expected one ordinary real Chrome window, observed ${candidates.length}`);
  const windowTarget = record(record(candidates[0])?.["target"]);
  if (windowTarget === null) throw new Error("real Chrome window target malformed");
  return windowTarget as Readonly<Record<string, ComputerUseJson>>;
}

const runtimeRoot = await mkdtemp(`${tmpdir()}/nautilo-real-chrome-host-`);
let runtime: NativeCuaHost | null = null;
let runner: HostContractRunner | null = null;
const measurements: HostContractCallEvidence[] = [];
try {
  runtime = await createNativeCuaHost({
    driverPath: driver,
    runtimeRoot,
    hostBundleId: "com.nautilo.desktop",
    hostGeneration: "host:real-chrome-live",
  });
  runner = new HostContractRunner({
    host: runtime.host,
    authority,
    fence: fenceFor(runtime),
    evidenceMode: "source-live",
    recordEvidence: (evidence) => measurements.push(evidence),
  });
  const window = await exactChromeWindow(runner);
  const initial = await execute(runner, COMPUTER_USE_BROWSER_CONTRACTS.bindWindow, { window });
  let bound: Readonly<Record<string, ComputerUseJson>>;
  if (initial.settlement === "completed" && initial.result["status"] === "bound") {
    bound = initial.result;
  } else if (initial.settlement === "not_completed" && initial.result["recovery"] === "prepare_browser") {
    bound = completed(await execute(runner, COMPUTER_USE_BROWSER_CONTRACTS.prepare, { window }), "prepared");
  } else {
    throw new Error(`real Chrome was neither bound nor explicitly preparable: ${initial.settlement}/${String(initial.result["recovery"])}`);
  }
  const beforeTabs = Array.isArray(bound["tabs"]) ? bound["tabs"].length : -1;
  if (beforeTabs < 1) throw new Error("real Chrome binding did not contain current tabs");
  const target = record(bound["target"]);
  if (target === null) throw new Error("real Chrome browser target malformed");
  const opened = completed(await execute(runner, COMPUTER_USE_BROWSER_CONTRACTS.openUrl, {
    target: target as Readonly<Record<string, ComputerUseJson>>,
    url: destination,
  }), "opened");
  const page = record(opened["page"]);
  if (page?.["url"] !== destination || page["title"] !== "Kyushu - Wikipedia") {
    throw new Error(`real Chrome open_url did not prove the exact rendered destination: ${JSON.stringify(page)}`);
  }
  const openedTarget = record(opened["target"]);
  const openedTab = record(opened["tab"]);
  if (openedTarget === null || openedTab === null) throw new Error("real Chrome open_url references malformed");
  const read = completed(await execute(runner, COMPUTER_USE_BROWSER_CONTRACTS.readPage, {
    target: openedTarget as Readonly<Record<string, ComputerUseJson>>,
    tab: openedTab as Readonly<Record<string, ComputerUseJson>>,
  }), "observed");
  const readPage = record(read["page"]);
  if (readPage?.["url"] !== destination || typeof read["outline"] !== "string"
    || !read["outline"].includes("Kyushu") || !read["outline"].includes("Japan")) {
    throw new Error("real Chrome read_page did not return the rendered Kyushu article text");
  }
  await exactChromeWindow(runner);
  process.stdout.write(`${JSON.stringify({
    status: "pass",
    evidenceMode: "source-live",
    qualification: "unverified",
    chromeWindowsBeforeAndAfter: 1,
    tabsBefore: beforeTabs,
    tabsAfter: beforeTabs + 1,
    page: { title: readPage["title"], url: readPage["url"] },
    semanticOutlineLength: read["outline"].length,
    outlineHasKyushu: true,
    outlineHasJapan: true,
    measurements,
  })}\n`);
} finally {
  if (runner !== null) await runner.dispose();
  if (runtime !== null) await runtime.shutdown().catch(() => undefined);
  await rm(runtimeRoot, { recursive: true, force: true });
}
