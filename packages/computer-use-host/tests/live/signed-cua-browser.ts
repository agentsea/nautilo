import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { COMPUTER_USE_BROWSER_CONTRACTS } from "@nautilo/computer-use-contracts";
import { COMPUTER_USE_NATIVE_CONTRACTS } from "@nautilo/computer-use-contracts/native";
import type { ComputerUseHostAuthorityScope, ComputerUseHostContract, ComputerUseHostResult, ComputerUseJson } from "@nautilo/computer-use-host-protocol";

import { createNativeCuaHost, type NativeCuaHost } from "../../src/index.ts";

const root = resolve(import.meta.dir, "../../../..");
const electron = resolve(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const fixture = resolve(import.meta.dir, "../fixtures/browser/main.ts");
const driver = process.env["NAUTILO_CUA_DRIVER"] ?? "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
const timeoutMs = Number(process.env["NAUTILO_CUA_LIVE_TIMEOUT_MS"] ?? "30000");
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("NAUTILO_CUA_LIVE_TIMEOUT_MS must be a positive integer");

const authority: ComputerUseHostAuthorityScope = { authorityLeaseId: "owned-live-fixture", authorityGeneration: 1 };

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveReady);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not reserve fixture port");
  const port = address.port;
  await new Promise<void>((resolveClosed, reject) => server.close((error) => error ? reject(error) : resolveClosed()));
  return port;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}

async function bounded<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

let requestSequence = 0;
const fenceFor = (runtime: NativeCuaHost) => ({
  hostGeneration: runtime.hostGeneration,
  driverGeneration: runtime.driverGeneration,
  cancellationGeneration: 1,
} as const);

async function execute(runtime: NativeCuaHost, contract: ComputerUseHostContract, args: Readonly<Record<string, ComputerUseJson>>): Promise<ComputerUseHostResult> {
  const response = await runtime.host.dispatch({
    kind: "request",
    protocol: { major: 3, minor: 0 },
    requestId: `live-${++requestSequence}`,
    authority,
    fence: fenceFor(runtime),
    contract,
    arguments: args,
  });
  if (response === null) throw new Error("live Host request returned no settlement");
  runtime.host.takeAttachment(response.requestId)?.bytes.fill(0);
  return response;
}

async function executeWithCancellation(
  runtime: NativeCuaHost,
  contract: ComputerUseHostContract,
  args: Readonly<Record<string, ComputerUseJson>>,
  cancelAfterMs: number,
): Promise<ComputerUseHostResult> {
  const requestId = `live-${++requestSequence}`;
  const fence = fenceFor(runtime);
  const pending = runtime.host.dispatch({
    kind: "request",
    protocol: { major: 3, minor: 0 },
    requestId,
    authority,
    fence,
    contract,
    arguments: args,
  });
  const timer = setTimeout(() => {
    void runtime.host.dispatch({ kind: "cancel", protocol: { major: 3, minor: 0 }, requestId, authority, fence });
  }, cancelAfterMs);
  try {
    const response = await bounded(pending, cancelAfterMs + 5_000, "Host cancellation did not settle");
    if (response === null) throw new Error("cancelled live Host request returned no settlement");
    runtime.host.takeAttachment(response.requestId)?.bytes.fill(0);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function executeCapture(
  runtime: NativeCuaHost,
  contract: ComputerUseHostContract,
  args: Readonly<Record<string, ComputerUseJson>>,
) {
  const requestId = `live-${++requestSequence}`;
  const response = await runtime.host.dispatch({
    kind: "request",
    protocol: { major: 3, minor: 0 },
    requestId,
    authority,
    fence: fenceFor(runtime),
    contract,
    arguments: args,
  });
  if (response === null) throw new Error("live Host capture returned no settlement");
  const attachment = runtime.host.takeAttachment(requestId);
  return { response, attachment } as const;
}

function requireCompleted(value: ComputerUseHostResult, expectedStatus: string): Readonly<Record<string, ComputerUseJson>> {
  if (value.settlement !== "completed" || value.result["status"] !== expectedStatus) {
    const status = typeof value.result["status"] === "string" ? value.result["status"] : "missing";
    throw new Error(`live Cua contract failed: ${value.settlement}/${status}`);
  }
  return value.result;
}

type BrowserProjection = Readonly<{
  target: Readonly<Record<string, ComputerUseJson>>;
  tabs: Array<{ target: Readonly<Record<string, ComputerUseJson>> }>;
}>;
type BrowserObservation = Readonly<{
  outline: string;
  refs: Array<{ name: string | null; actions: string[]; target: Readonly<Record<string, ComputerUseJson>> }>;
}>;

function exactRef(observation: BrowserObservation, name: string, action: string): Readonly<Record<string, ComputerUseJson>> {
  const matches = observation.refs.filter((ref) => ref.name === name && ref.actions.includes(action));
  if (matches.length !== 1) throw new Error(`semantic_v2 did not mint one ${action} ref named ${name}`);
  return matches[0]!.target;
}

const temp = await mkdtemp(`${tmpdir()}/nautilo-cua-browser-fixture-`);
const cdpPort = await reservePort();
const built = await Bun.build({ entrypoints: [fixture], outdir: temp, target: "node", format: "cjs", external: ["electron"] });
if (!built.success || built.outputs.length !== 1) throw new Error("owned Electron fixture build failed");
const child = spawn(electron, [built.outputs[0]!.path, `--user-data-dir=${temp}`], {
  env: { ...process.env, NAUTILO_CUA_FIXTURE_CDP_PORT: String(cdpPort) },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr.resume();

let runtime: NativeCuaHost | null = null;
let dialogCancellationProbed = false;
try {
  const ready = await Promise.race([
    new Promise<Readonly<{ pid: number; appPort: number }>>((resolveReady, reject) => {
      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const parsed = record(JSON.parse(buffer.slice(0, newline)));
        if (parsed === null || parsed["status"] !== "ready" || !Number.isSafeInteger(parsed["pid"]) || !Number.isSafeInteger(parsed["appPort"])) {
          reject(new Error("fixture readiness payload malformed"));
          return;
        }
        resolveReady({ pid: parsed["pid"] as number, appPort: parsed["appPort"] as number });
      });
      child.once("exit", () => reject(new Error("fixture exited before readiness")));
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("fixture readiness timed out")), timeoutMs)),
  ]);
  if (ready.pid !== child.pid) throw new Error("fixture PID attestation mismatch");

  runtime = await createNativeCuaHost({
    driverPath: driver,
    runtimeRoot: temp,
    hostBundleId: "com.nautilo.desktop",
    hostGeneration: "host:signed-cua-live",
  });
  if (runtime.host.ready().contracts.length !== 12) throw new Error("production Host did not advertise all 12 reviewed contracts");

  const observeNative = async (): Promise<Readonly<Record<string, ComputerUseJson>>> => {
    let continuation: Readonly<Record<string, ComputerUseJson>> | undefined;
    const seen = new Set<string>();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const response = await execute(runtime!, COMPUTER_USE_NATIVE_CONTRACTS.observe, {
        operation: "desktop_state", maxWindows: 100, ...(continuation === undefined ? {} : { continuation }),
      });
      if (response.settlement !== "completed" || response.result["operation"] !== "desktop_state") {
        if (Date.now() < deadline) {
          await Bun.sleep(50);
          continue;
        }
        process.stderr.write(`${JSON.stringify({
          status: "native_observation_failed",
          settlement: response.settlement,
          result: response.result,
        })}\n`);
        throw new Error(`native observation failed: ${response.settlement}`);
      }
      const targets = response.result["targets"];
      if (!Array.isArray(targets)) throw new Error("native observation targets malformed");
      const matches = targets.map(record).filter((target): target is Readonly<Record<string, unknown>> => {
        const evidence = record(target?.["evidence"]);
        return evidence?.["kind"] === "window" && evidence["windowLabel"] === "Cua Browser Fixture";
      });
      if (matches.length > 1) throw new Error("native observation returned duplicate fixture windows");
      if (matches.length === 1) {
        const target = record(matches[0]!["target"]);
        if (target === null) throw new Error("native fixture target malformed");
        return target as Readonly<Record<string, ComputerUseJson>>;
      }
      const next = record(response.result["continuation"]);
      if (next === null) throw new Error("complete native observation did not contain the fixture window");
      const key = JSON.stringify(next);
      if (seen.has(key)) throw new Error("native observation continuation repeated");
      seen.add(key);
      continuation = next as Readonly<Record<string, ComputerUseJson>>;
    }
  };

  const firstWindow = await observeNative();
  const initialBind = await execute(runtime, COMPUTER_USE_BROWSER_CONTRACTS.bindWindow, { window: firstWindow });
  const initialAlreadyBound = initialBind.settlement === "completed" && initialBind.result["status"] === "bound";
  const initialRequiresSetup = initialBind.settlement === "not_completed" && initialBind.result["recovery"] === "prepare_browser";
  if (!initialAlreadyBound && !initialRequiresSetup) {
    const recovery = typeof initialBind.result["recovery"] === "string" ? initialBind.result["recovery"] : "missing";
    throw new Error(`fresh owned endpoint was neither directly bindable nor explicitly preparable: ${initialBind.settlement}/${recovery}`);
  }
  // Preparation returns the exact usable binding from the same retained Cua
  // lifecycle. Starting a second bind/session here would reproduce the 0.1.5
  // defect this live gate exists to prevent.
  const bound = requireCompleted(
    await execute(runtime, COMPUTER_USE_BROWSER_CONTRACTS.prepare, { window: firstWindow }),
    "prepared",
  ) as unknown as BrowserProjection;
  if (bound.tabs.length !== 1) throw new Error("owned Electron fixture did not bind exactly one tab");
  const target = bound.target;
  const tab = bound.tabs[0]!.target;
  const read = async (): Promise<BrowserObservation> => requireCompleted(await execute(
    runtime!, COMPUTER_USE_BROWSER_CONTRACTS.readPage, { target, tab },
  ), "observed") as unknown as BrowserObservation;

  let observed = await read();
  if (!observed.outline.includes("Owned Cua browser fixture")) throw new Error("semantic_v2 did not return fixture content");
  requireCompleted(await execute(runtime, COMPUTER_USE_BROWSER_CONTRACTS.type, {
    target, tab, element: exactRef(observed, "Exact text", "type"), text: "signed Cua", replace: true,
  }), "delivered");
  observed = await read();
  if (!observed.outline.includes("signed Cua")) throw new Error("fresh semantic state did not verify typed text");

  requireCompleted(await execute(runtime, COMPUTER_USE_BROWSER_CONTRACTS.click, {
    target, tab, element: exactRef(observed, "Increment", "click"), inputRoute: "trusted",
  }), "delivered");
  observed = await read();
  if (!observed.outline.includes("Count: 1")) throw new Error("fresh semantic state did not verify click");

  for (const [action, expected] of [["hover", "Pointer: hovered"], ["right_click", "Pointer: right-clicked"], ["double_click", "Pointer: double-clicked"]] as const) {
    requireCompleted(await execute(runtime, COMPUTER_USE_BROWSER_CONTRACTS.pointer, {
      target, tab, element: exactRef(observed, "Pointer target", "pointer"), action, inputRoute: "dom_event",
    }), "delivered");
    observed = await read();
    if (!observed.outline.includes(expected)) throw new Error(`fresh semantic state did not verify ${action}`);
  }

  requireCompleted(await execute(runtime, COMPUTER_USE_BROWSER_CONTRACTS.pointer, {
    target, tab, element: exactRef(observed, "Scrollable fixture", "scroll"), action: "scroll", inputRoute: "dom_event", deltaY: 240,
  }), "delivered");
  observed = await read();
  if (/Scroll: 0(?:\D|$)/u.test(observed.outline)) throw new Error("fresh semantic state did not verify scroll");
  requireCompleted(await execute(runtime, COMPUTER_USE_BROWSER_CONTRACTS.pointer, {
    target, tab, element: exactRef(observed, "Scrollable fixture", "scroll"), action: "scroll", inputRoute: "dom_event", deltaY: -240,
  }), "delivered");
  observed = await read();
  if (!observed.outline.includes("Scroll: 0")) throw new Error("fresh semantic state did not verify reverse scroll");

  requireCompleted(await execute(runtime, COMPUTER_USE_BROWSER_CONTRACTS.pointer, {
    target, tab, element: exactRef(observed, "Drag source", "pointer"), destination: exactRef(observed, "Drop target", "pointer"), action: "drag", inputRoute: "dom_event",
  }), "delivered");
  observed = await read();
  if (!observed.outline.includes("Drag: dropped")) throw new Error("fresh semantic state did not verify drag");

  const stalePointer = exactRef(observed, "Pointer target", "pointer");
  observed = await read();
  const stale = await execute(runtime, COMPUTER_USE_BROWSER_CONTRACTS.pointer, { target, tab, element: stalePointer, action: "hover", inputRoute: "dom_event" });
  if (stale.settlement !== "not_completed" || stale.result["status"] !== "not_delivered") throw new Error("stale semantic ref was not fenced");

  requireCompleted(await execute(runtime, COMPUTER_USE_BROWSER_CONTRACTS.navigate, { target, tab, url: `http://127.0.0.1:${ready.appPort}/next` }), "delivered");
  observed = await read();
  if (!observed.outline.includes("Navigation complete")) throw new Error("fresh semantic state did not verify navigation");
  requireCompleted(await execute(runtime, COMPUTER_USE_BROWSER_CONTRACTS.navigate, { target, tab, url: "about:blank" }), "delivered");
  await read();

  // Return to the fixture before exercising the current signed driver's
  // Electron-dialog boundary. Every supported operation above has already
  // completed and been freshly verified before this intentionally terminal
  // provider-defect probe.
  requireCompleted(await execute(runtime, COMPUTER_USE_BROWSER_CONTRACTS.navigate, { target, tab, url: `http://127.0.0.1:${ready.appPort}/` }), "delivered");
  observed = await read();

  requireCompleted(await execute(runtime, COMPUTER_USE_BROWSER_CONTRACTS.click, {
    target, tab, element: exactRef(observed, "Open alert", "click"), inputRoute: "dom_event",
  }), "delivered");
  let modalCapture = await executeCapture(runtime, COMPUTER_USE_NATIVE_CONTRACTS.observe, {
    operation: "window_state",
    target: firstWindow,
    capture: "window_snapshot",
  });
  const firstModalOutcome = record(modalCapture.response.result["outcome"]);
  const firstModalRecovery = firstModalOutcome?.["recovery"];
  if (modalCapture.attachment === null && Array.isArray(firstModalRecovery) && firstModalRecovery.includes("focus_target")) {
    const focused = await execute(runtime, COMPUTER_USE_NATIVE_CONTRACTS.do, {
      operation: { kind: "focus", target: firstWindow },
    });
    const focusKnownCompleted = focused.settlement === "completed" && focused.result["action"] === "focus"
      && focused.result["completionCertainty"] === "completed";
    const focusUnknown = focused.settlement === "unknown_completion" && focused.result["action"] === "focus"
      && focused.result["completionCertainty"] === "unknown_completion";
    if (!focusKnownCompleted && !focusUnknown) {
      throw new Error(`native modal focus recovery failed: ${focused.settlement}`);
    }
    if (focusUnknown) process.stderr.write(`${JSON.stringify({ status: "native_modal_focus_unknown_no_replay" })}\n`);
    const foregroundWindow = await observeNative();
    modalCapture = await executeCapture(runtime, COMPUTER_USE_NATIVE_CONTRACTS.observe, {
      operation: "window_state",
      target: foregroundWindow,
      capture: "window_snapshot",
    });
  }
  const dialogPixel = process.env["NAUTILO_CUA_DIALOG_PIXEL"];
  if (modalCapture.response.settlement !== "completed" || modalCapture.response.result["operation"] !== "window_state"
    || modalCapture.attachment === null) {
    modalCapture.attachment?.bytes.fill(0);
    process.stderr.write(`${JSON.stringify({
      status: "native_modal_px_unavailable",
      settlement: modalCapture.response.settlement,
      resultKeys: Object.keys(modalCapture.response.result).sort(),
      operation: modalCapture.response.result["operation"] ?? null,
      degraded: modalCapture.response.result["degraded"] ?? null,
      completeness: modalCapture.response.result["completeness"] ?? null,
      outcome: modalCapture.response.result["outcome"] ?? null,
    })}\n`);
    if (dialogPixel !== undefined) throw new Error(`native modal capture failed: ${modalCapture.response.settlement}`);
  } else {
    const modalSnapshot = record(modalCapture.response.result["windowSnapshot"]);
    const modalSnapshotTarget = record(modalSnapshot?.["target"]);
    if (modalSnapshotTarget === null) {
      modalCapture.attachment.bytes.fill(0);
      throw new Error("native modal capture did not mint a snapshot capability");
    }
    const screenshotOut = process.env["NAUTILO_CUA_LIVE_SCREENSHOT_OUT"];
    if (screenshotOut !== undefined) await Bun.write(screenshotOut, modalCapture.attachment.bytes);
    process.stderr.write(`${JSON.stringify({
      status: "native_modal_px_available",
      width: modalCapture.attachment.metadata.width,
      height: modalCapture.attachment.metadata.height,
      coordinateSpace: modalCapture.attachment.metadata.coordinateSpace,
    })}\n`);
    modalCapture.attachment.bytes.fill(0);

    if (dialogPixel !== undefined) {
      const coordinates = dialogPixel.split(",").map((value) => Number(value));
      if (coordinates.length !== 2 || !coordinates.every((value) => Number.isFinite(value) && value >= 0)) {
        throw new Error("NAUTILO_CUA_DIALOG_PIXEL must be x,y nonnegative snapshot pixels");
      }
      const clickedModal = await execute(runtime, COMPUTER_USE_NATIVE_CONTRACTS.do, {
        operation: {
          kind: "click",
          target: modalSnapshotTarget as Readonly<Record<string, ComputerUseJson>>,
          coordinateSpace: "window_snapshot_pixels",
          x: coordinates[0]!,
          y: coordinates[1]!,
        },
      });
      if (clickedModal.settlement !== "completed" || clickedModal.result["action"] !== "click"
        || clickedModal.result["completionCertainty"] !== "completed") {
        const certainty = typeof clickedModal.result["completionCertainty"] === "string"
          ? clickedModal.result["completionCertainty"]
          : "missing";
        throw new Error(`native modal pixel click failed: ${clickedModal.settlement}/${certainty}`);
      }
      observed = await read();
      if (!observed.outline.includes("Dialog: accepted")) throw new Error("fresh semantic state did not verify native modal pixel resolution");
      process.stderr.write(`${JSON.stringify({ status: "native_modal_px_verified" })}\n`);
      requireCompleted(await execute(runtime, COMPUTER_USE_BROWSER_CONTRACTS.click, {
        target, tab, element: exactRef(observed, "Open alert", "click"), inputRoute: "dom_event",
      }), "delivered");
    }
  }
  const cancelledDialog = await executeWithCancellation(
    runtime,
    COMPUTER_USE_BROWSER_CONTRACTS.dialog,
    { target, tab, action: "inspect" },
    5_000,
  );
  dialogCancellationProbed = true;
  if (cancelledDialog.settlement !== "cancelled") {
    throw new Error(`blocked signed-Cua dialog did not cancel safely (${cancelledDialog.settlement})`);
  }
  process.stderr.write(`${JSON.stringify({
    status: "signed_cua_dialog_defect_safely_cancelled",
    completedActions: ["type", "click", "hover", "right_click", "double_click", "scroll_down", "scroll_up", "drag", "navigate_http", "navigate_about"],
    dialogSettlement: cancelledDialog.settlement,
  })}\n`);
  throw new Error("signed Cua blocks Electron browser_dialog after a page-owned alert opens");
} finally {
  if (runtime !== null) {
    await bounded(runtime.shutdown(), 10_000, "Host-owned Cua child cleanup timed out");
    if (dialogCancellationProbed) process.stderr.write(`${JSON.stringify({ status: "host_owned_cua_child_cleanup_completed" })}\n`);
  }
  child.kill("SIGTERM");
  if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolveExit) => child.once("exit", resolveExit));
  await rm(temp, { recursive: true, force: true });
}
