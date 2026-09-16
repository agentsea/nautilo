import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { CuaMcpStdioClient, type CuaToolResult } from "../../src/index.ts";

const root = resolve(import.meta.dir, "../../../..");
const electron = resolve(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const fixture = resolve(import.meta.dir, "../fixtures/browser/main.ts");
const driver = process.env["NAUTILO_CUA_DRIVER"] ?? "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
const probe = process.env["NAUTILO_CUA_DIALOG_PROBE"] ?? "inspect";
if (
  probe !== "inspect"
  && probe !== "snapshot_then_inspect"
  && probe !== "prime_then_inspect"
  && probe !== "prime_then_resolve_probe"
  && probe !== "native_after_alert"
) {
  throw new Error("invalid dialog probe");
}
const resolution = process.env["NAUTILO_CUA_DIALOG_RESOLUTION"] ?? "accept";
if (resolution !== "accept" && resolution !== "dismiss") throw new Error("invalid dialog resolution");

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}_timeout`)), 5_000); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveReady);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("port_unavailable");
  await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
  return address.port;
}

function family(result: CuaToolResult): Readonly<Record<string, unknown>> {
  const value = result.structuredContent;
  return {
    isError: result.isError,
    keys: value === null ? [] : Object.keys(value).sort(),
    status: typeof value?.["status"] === "string" ? value["status"] : null,
    present: typeof value?.["present"] === "boolean" ? value["present"] : null,
    action: typeof value?.["action"] === "string" ? value["action"] : null,
    effect: typeof value?.["effect"] === "string" ? value["effect"] : null,
  };
}

const temp = await mkdtemp(`${tmpdir()}/nautilo-cua-dialog-direct-`);
const cdpPort = await reservePort();
const built = await Bun.build({ entrypoints: [fixture], outdir: temp, target: "node", format: "cjs", external: ["electron"] });
if (!built.success || built.outputs.length !== 1) throw new Error("fixture_build_failed");
const child = spawn(electron, [built.outputs[0]!.path, `--user-data-dir=${temp}`], {
  env: { ...process.env, NAUTILO_CUA_FIXTURE_CDP_PORT: String(cdpPort) },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr.resume();
let client: CuaMcpStdioClient | null = null;
try {
  const ready = await bounded(new Promise<Readonly<{ pid: number }>>((resolveReady, reject) => {
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const value = record(JSON.parse(buffer.slice(0, newline)));
      if (value === null || !Number.isSafeInteger(value["pid"])) reject(new Error("fixture_ready_malformed"));
      else resolveReady({ pid: value["pid"] as number });
    });
  }), "fixture_ready");
  client = await bounded(CuaMcpStdioClient.start({ executable: driver }), "mcp_start");
  const windows = await bounded(client.callTool("list_windows", { pid: ready.pid }), "list_windows");
  const candidates = Array.isArray(windows.structuredContent?.["windows"])
    ? windows.structuredContent["windows"].map(record).filter((value) => value?.["pid"] === ready.pid && value["title"] === "Cua Browser Fixture")
    : [];
  if (candidates.length !== 1 || !Number.isSafeInteger(candidates[0]?.["window_id"])) throw new Error("window_not_unique");
  const session = `direct-dialog-${ready.pid}`;
  await bounded(client.callTool("start_session", { session }), "start_session");
  const bound = await bounded(client.callTool("get_browser_state", { pid: ready.pid, window_id: candidates[0]!["window_id"], session }), "bind");
  const targetId = bound.structuredContent?.["target_id"];
  const tabs = bound.structuredContent?.["tabs"];
  const tabId = Array.isArray(tabs) ? record(tabs[0])?.["tab_id"] : null;
  if (typeof targetId !== "string" || typeof tabId !== "string") throw new Error("bind_missing_capability");
  const snapshot = await bounded(client.callTool("get_browser_state", { target_id: targetId, tab_id: tabId, snapshot_format: "semantic_v2", session }), "snapshot");
  const refs = snapshot.structuredContent?.["refs"];
  const alertRefs = Array.isArray(refs) ? refs.map(record).filter((value) => value?.["name"] === "Open alert") : [];
  if (alertRefs.length !== 1 || typeof alertRefs[0]?.["ref"] !== "string") throw new Error("alert_ref_missing");
  if (probe === "prime_then_inspect" || probe === "prime_then_resolve_probe") {
    const primed = await bounded(client.callTool("browser_dialog", { target_id: targetId, tab_id: tabId, action: "inspect", session }), "dialog_prime");
    process.stderr.write(`${JSON.stringify({ probe: "dialog_prime", family: family(primed) })}\n`);
    if (primed.isError || primed.structuredContent?.["present"] !== false) throw new Error("dialog_prime_failed");
  }
  const clicked = await bounded(client.callTool("browser_click", {
    target_id: targetId, tab_id: tabId, ref: alertRefs[0]["ref"], input_route: "dom_event", session,
  }), "click");
  if (clicked.isError) throw new Error(`click_refused:${JSON.stringify(family(clicked))}`);
  await Bun.sleep(100);
  if (probe === "snapshot_then_inspect") {
    const fresh = await bounded(client.callTool("get_browser_state", { target_id: targetId, tab_id: tabId, snapshot_format: "semantic_v2", session }), "fresh_snapshot");
    process.stderr.write(`${JSON.stringify({ probe: "fresh_snapshot", family: family(fresh) })}\n`);
  }
  if (probe === "native_after_alert") {
    const native = await bounded(client.callTool("get_window_state", {
      pid: ready.pid,
      window_id: candidates[0]!["window_id"],
      include_screenshot: false,
      max_elements: 500,
      max_depth: 25,
      session,
    }), "native_state");
    const elements = native.structuredContent?.["elements"];
    const candidatesByRole = Array.isArray(elements)
      ? elements.map(record).filter((value) => {
        const role = value?.["role"];
        const label = value?.["label"];
        return role === "AXButton" || (typeof label === "string" && /ok|cancel|alert|fixture/u.test(label.toLowerCase()));
      })
      : [];
    process.stdout.write(`${JSON.stringify({
      status: "native_state_settled",
      family: family(native),
      elements: candidatesByRole.map((value) => ({ role: value?.["role"] ?? null, label: value?.["label"] ?? null })),
    })}\n`);
    const actionable = candidatesByRole.filter((value) => value?.["role"] === "AXButton" && typeof value["element_token"] === "string");
    if (actionable.length === 1) {
      const clickedNative = await bounded(client.callTool("click", {
        pid: ready.pid,
        window_id: candidates[0]!["window_id"],
        element_token: actionable[0]!["element_token"],
        delivery_mode: "background",
        session,
      }), "native_click");
      process.stdout.write(`${JSON.stringify({ status: "native_click_settled", family: family(clickedNative) })}\n`);
      const verified = await bounded(client.callTool("get_window_state", {
        pid: ready.pid,
        window_id: candidates[0]!["window_id"],
        include_screenshot: false,
        query: "Dialog: accepted",
        session,
      }), "native_verify");
      process.stdout.write(`${JSON.stringify({
        status: "native_verify_settled",
        observedAccepted: typeof verified.structuredContent?.["tree_markdown"] === "string"
          && verified.structuredContent["tree_markdown"].includes("Dialog: accepted"),
      })}\n`);
    }
  } else if (probe === "prime_then_resolve_probe") {
    const resolved = await bounded(client.callTool("browser_dialog", {
      target_id: targetId,
      tab_id: tabId,
      action: resolution,
      // Probe-only: direct comparison of resolve dispatch with inspect. Product
      // code must use the opaque id returned by a successful inspect.
      dialog_id: "dialog-1",
      delivery_mode: "background",
      session,
    }), `dialog_${resolution}_probe`);
    process.stdout.write(`${JSON.stringify({ status: "resolve_probe_settled", probe, family: family(resolved) })}\n`);
  } else {
    const inspected = await bounded(client.callTool("browser_dialog", { target_id: targetId, tab_id: tabId, action: "inspect", session }), "dialog_inspect");
    process.stdout.write(`${JSON.stringify({ status: "settled", probe, family: family(inspected) })}\n`);
    if (inspected.structuredContent?.["present"] === true && typeof inspected.structuredContent["dialog_id"] === "string") {
      const accepted = await bounded(client.callTool("browser_dialog", {
        target_id: targetId, tab_id: tabId, action: resolution, dialog_id: inspected.structuredContent["dialog_id"], delivery_mode: "background", session,
      }), `dialog_${resolution}`);
      process.stdout.write(`${JSON.stringify({ status: "resolved", family: family(accepted) })}\n`);
    }
  }
} finally {
  if (client !== null) await client.close();
  child.kill("SIGTERM");
  if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolveExit) => child.once("exit", resolveExit));
  await rm(temp, { recursive: true, force: true });
}
