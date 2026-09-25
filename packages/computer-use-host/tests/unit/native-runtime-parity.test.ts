import { describe, expect, mock, test } from "bun:test";
import { Jimp, JimpMime } from "jimp";
import { CuaComputerUseAdapter } from "../../src/native-runtime.ts";
import { CuaNativeContractRuntime } from "../../src/native-contract-runtime.ts";
import { ComputerUseHost } from "../../src/runtime.ts";
import { ComputerUseContextRegistry, type ComputerUseContextScope } from "../../src/native-context-registry.ts";
import type { CuaCheckedContextPort } from "../../src/native-cua-lifecycle.ts";
import type { CuaContextToolCallResult, CuaContextToolName, CuaContextToolResult } from "../../src/native-cua-supervisor.ts";
import { applicationWindowsObservationSchema, COMPUTER_USE_NATIVE_CONTRACTS, computerLaunchReceiptSchema, computerMutationReceiptSchema, computerVerificationReceiptSchema, windowRegionObservationSchema, windowStateObservationSchema } from "@nautilo/computer-use-contracts/native";

const scope: ComputerUseContextScope = {
  computerUseContextId: "computer-use-context-1",
  installationEpoch: "epoch-1",
  grantGeneration: 1,
  provider: "cua",
  providerGeneration: "provider-generation-1",
  originHumanId: "human-1",
  originRunId: "run-1",
  originAgentId: "agent-1",
  lineageId: "lineage-1",
  serverBindingId: "server-binding-1",
  relayId: "relay-1",
  pairingGeneration: "pairing-1",
  desktopSessionId: "session-1",
};

const generation = "cua_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const sessionId = "cua-session-1";

function result(structuredContent: Readonly<Record<string, unknown>>, isError = false): CuaContextToolResult {
  return { content: [{ type: "text", text: "fixture" }], isError, structuredContent };
}

function unusedCheckedCall(): Promise<CuaContextToolCallResult> {
  return Promise.resolve({ ok: false, code: "context_fenced", stage: "session" });
}

function apps() {
  return result({ apps: [
    { pid: 42, name: "Nautilo", bundle_id: "com.nautilo.desktop", active: true, running: true, launch_path: null, kind: "application", last_used: null, windows: [] },
    { pid: 0, name: "Preview", bundle_id: "com.apple.Preview", active: false, running: false, launch_path: "/Applications/Preview.app", kind: "application", last_used: null, windows: [] },
  ] });
}

function windows() {
  return result({ windows: [{
    window_id: 90, pid: 42, app_name: "Nautilo", title: "Connections",
    bounds: { x: 1, y: 2, width: 800, height: 600 }, layer: 0, z_index: 4,
    is_on_screen: true, current_space_id: 1, on_current_space: true, space_ids: [1],
  }], current_space_id: 1 });
}

function installedApps(rows: readonly Readonly<Record<string, unknown>>[]) {
  return result({ apps: rows });
}

function launchSuccess(bundleId = "com.apple.TextEdit", name = "TextEdit", count = 1, windowOverrides: Readonly<Record<string, unknown>> = {}) {
  return result({
    pid: 77, bundle_id: bundleId, name,
    windows: Array.from({ length: count }, (_, index) => ({
      window_id: 500 + index, pid: 77, app_name: name, title: `Untitled ${index + 1}`,
      bounds: { x: 1, y: 2, width: 800, height: 600 }, layer: 0, z_index: index,
      is_on_screen: true, current_space_id: 1, on_current_space: true, space_ids: [1],
      ...windowOverrides,
    })),
    launch_state: { requested: true, process_running: true, window_ready: count > 0 },
  });
}

function rawWindowRow(options: Readonly<{
  windowId: number;
  pid?: number;
  appName: string;
  title: string;
  width: number;
  height: number;
  onScreen?: boolean;
  located?: boolean;
}>) {
  return {
    window_id: options.windowId, pid: options.pid ?? 77, app_name: options.appName, title: options.title,
    bounds: { x: 1, y: 2, width: options.width, height: options.height }, layer: 0, z_index: options.windowId,
    is_on_screen: options.onScreen ?? false, current_space_id: 1,
    on_current_space: options.located === false ? null : false,
    space_ids: options.located === false ? null : [2],
  };
}

function launchWithRawWindows(bundleId: string, name: string, rows: readonly Readonly<Record<string, unknown>>[]) {
  return result({
    pid: 77, bundle_id: bundleId, name, windows: rows,
    launch_state: { requested: true, process_running: true, window_ready: rows.length > 0 },
  });
}

function listedRawWindows(rows: readonly Readonly<Record<string, unknown>>[]) {
  return result({ windows: rows, current_space_id: 1 });
}

function listedWindows(pid: number, name: string, count: number) {
  return result({
    windows: Array.from({ length: count }, (_, index) => ({
      window_id: 500 + index, pid, app_name: name, title: `Untitled ${index + 1}`,
      bounds: { x: 1, y: 2, width: 800, height: 600 }, layer: 0, z_index: index,
      is_on_screen: true, current_space_id: 1, on_current_space: true, space_ids: [1],
    })),
    current_space_id: 1,
  });
}

function windowState(degraded = false) {
  return result({
    window_id: 500, pid: 77, element_count: 0, total_element_count: 0, returned_element_count: 0,
    elements_complete: false, tree_markdown: "sensitive tree", elements: [], _note: "provider note",
    ...(degraded ? { degraded: true, degraded_reason: "ax_tree_empty: sensitive provider reason" } : {}),
  });
}

function windowStateScreenshot(width = 800, height = 600, degraded = false) {
  const crc32 = (bytes: Uint8Array): number => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 0 ? crc >>> 1 : (crc >>> 1) ^ 0xedb88320;
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data = Buffer.alloc(0)): Buffer => {
    const typeBytes = Buffer.from(type, "ascii");
    const framed = Buffer.alloc(12 + data.length);
    framed.writeUInt32BE(data.length, 0);
    typeBytes.copy(framed, 4);
    data.copy(framed, 8);
    framed.writeUInt32BE(crc32(framed.subarray(4, 8 + data.length)), 8 + data.length);
    return framed;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", Buffer.from([0x78, 0x01])),
    chunk("IEND"),
  ]);
  const base = windowState(degraded).structuredContent!;
  return {
    content: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }, { type: "text", text: "window fixture" }],
    isError: false,
    structuredContent: {
      ...base,
      screenshot_width: width, screenshot_height: height, screenshot_mime_type: "image/png",
      window_bounds: { x: 10, y: 20, width: width / 2, height: height / 2 }, screenshot_scale: 2,
      screenshot_frame_valid: true,
    },
  } satisfies CuaContextToolResult;
}

async function decodableWindowStateScreenshot(width: number, height: number): Promise<CuaContextToolResult> {
  const image = new Jimp({ width, height, color: 0x223344ff });
  image.setPixelColor(0xffaa00ff, width - 1, height - 1);
  const png = await image.getBuffer(JimpMime.png);
  const base = windowStateScreenshot(width, height);
  return {
    ...base,
    content: [
      { type: "image", mimeType: "image/png", data: png.toString("base64") },
      { type: "text", text: "window fixture" },
    ],
  };
}

function focused() {
  return result({
    status: "activated", code: "bring_to_front_exact_window_verified", pid: 42, window_id: 90,
    activated: true, path: "cocoa_ax", request_accepted: true, process_activated: true,
    exact_window_effect: { verified: true, focused: true, frontmost_ordinary: true, target_visible_ordinary: true },
    observed: { frontmost_pid: 42, workspace_frontmost_pid: 42, front_process_matches_target: true, focused_window_id: 90, frontmost_ordinary_window_id: 90 },
  });
}

function focusedWithProviderOverlay(frontmostWindowId = 46_529) {
  return result({
    status: "partial", code: "bring_to_front_exact_window_unverified", pid: 42, window_id: 90,
    activated: false, path: "skylight_process_exact", request_accepted: true, process_activated: true,
    exact_window_effect: { verified: false, focused: true, frontmost_ordinary: false, target_visible_ordinary: true },
    observed: {
      frontmost_pid: 42, workspace_frontmost_pid: 42, front_process_matches_target: true,
      focused_window_id: 90, frontmost_ordinary_window_id: frontmostWindowId,
    },
  }, true);
}

function exactWindowState(pid: number, windowId: number, degraded = false) {
  return result({
    window_id: windowId, pid, element_count: 0, total_element_count: 0, returned_element_count: 0,
    elements_complete: false, tree_markdown: "private tree", elements: [], _note: "private note",
    ...(degraded ? { degraded: true, degraded_reason: "ax_window_unresolved: private reason" } : {}),
  });
}

function port(responses: readonly CuaContextToolResult[]) {
  const calls: { readonly name: CuaContextToolName; readonly args: Readonly<Record<string, unknown>> }[] = [];
  const dispatched: typeof calls = [];
  const leaseState = { active: 0, minimumAfterAdoption: Number.POSITIVE_INFINITY, adopted: false };
  const acquire = () => {
    leaseState.active += 1;
    if (leaseState.adopted) leaseState.minimumAfterAdoption = Math.min(leaseState.minimumAfterAdoption, leaseState.active);
  };
  const endContextLease = mock(async () => {
    leaseState.active -= 1;
    if (leaseState.adopted) leaseState.minimumAfterAdoption = Math.min(leaseState.minimumAfterAdoption, leaseState.active);
  });
  const callContextTool = mock(async (
    _scope: ComputerUseContextScope,
    name: CuaContextToolName,
    args: Readonly<Record<string, unknown>>,
    _signal?: AbortSignal,
    onProviderDispatch?: () => boolean | Promise<boolean>,
  ) => {
    calls.push({ name, args });
    if (onProviderDispatch !== undefined && !await onProviderDispatch()) {
      return { ok: false as const, code: "context_fenced" as const, stage: "tool" as const };
    }
    dispatched.push({ name, args });
    const next = responses[calls.length - 1];
    if (next === undefined) throw new Error("unexpected Cua call");
    acquire();
    return { ok: true as const, generation, sessionId, result: next };
  });
  const captureDesktopState = mock(async () => {
    acquire();
    return {
      ok: true as const,
      generation,
      sessionId,
      png: Uint8Array.from([137, 80, 78, 71]),
      nativeWidth: 1200,
      nativeHeight: 800,
      screenWidth: 600,
      screenHeight: 400,
      scaleFactor: 2,
    };
  });
  const clickDesktop = mock(async (...args: Parameters<CuaCheckedContextPort["clickDesktop"]>) => {
    if (args[5] !== undefined && !await args[5]()) return { ok: false as const, code: "context_fenced" as const, stage: "session" as const };
    acquire();
    return {
      ok: true as const,
      generation,
      sessionId,
      effect: "unverifiable" as const,
      route: "global_input" as const,
      delivery: "not_applicable" as const,
    };
  });
  const invalidateCheckedGeneration = mock(() => undefined);
  const launchApplication = mock(async (currentScope: ComputerUseContextScope, bundleId: string, signal?: AbortSignal) =>
    callContextTool(currentScope, "launch_app", { bundle_id: bundleId }, signal));
  const getWindowState = mock(async (currentScope: ComputerUseContextScope, pid: number, windowId: number, query?: string, signal?: AbortSignal, effort?: Readonly<{ maxElements?: number; maxDepth?: number }>) =>
    callContextTool(currentScope, "get_window_state", {
      pid, window_id: windowId, include_screenshot: false,
      ...(effort?.maxElements === undefined ? {} : { max_elements: effort.maxElements }),
      ...(effort?.maxDepth === undefined ? {} : { max_depth: effort.maxDepth }),
    }, signal));
  const captureWindowState = mock(async (_currentScope: ComputerUseContextScope, pid: number, windowId: number, _signal?: AbortSignal, effort?: Readonly<{ maxElements?: number; maxDepth?: number }>) => {
    calls.push({ name: "get_window_state", args: {
      pid, window_id: windowId, include_screenshot: true,
      ...(effort?.maxElements === undefined ? {} : { max_elements: effort.maxElements }),
      ...(effort?.maxDepth === undefined ? {} : { max_depth: effort.maxDepth }),
    } });
    const next = responses[calls.length - 1];
    if (next === undefined) throw new Error("unexpected Cua capture call");
    acquire();
    const image = next.content.find((entry) => entry["type"] === "image");
    const png = typeof image?.["data"] === "string" ? Buffer.from(image["data"], "base64") : null;
    return {
      ok: true as const,
      generation,
      sessionId,
      result: { ...next, content: next.content.filter((entry) => entry["type"] === "text") },
      png,
    };
  });
  return {
    calls, dispatched, invalidateCheckedGeneration, leaseState,
    captureDesktopState,
    clickDesktop,
    endContextLease,
    captureWindowState,
    value: { generation, invalidateCheckedGeneration, callContextTool, launchApplication, getWindowState, captureWindowState, captureDesktopState, clickDesktop, endContextLease } satisfies CuaCheckedContextPort,
  };
}

describe("Cua semantic adapter foundation", () => {
  test("launches only one exact full-inventory semantic match through the named bundle seam", async () => {
    const checked = port([
      installedApps([
        { pid: 0, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: false, running: false, launch_path: "/Applications/TextEdit.app" },
        { pid: 0, name: "Preview", bundle_id: "com.apple.Preview", active: false, running: false },
        { pid: 0, name: "1Password", bundle_id: "com.1password.1password", active: false, running: false },
        { pid: 0, name: "Image Capture", bundle_id: "com.apple.Image_Capture", active: false, running: false },
        { pid: 0, name: "Unbundled Helper", bundle_id: null, active: false, running: false },
      ]),
      launchSuccess(),
      windowState(),
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    expect(computerLaunchReceiptSchema.safeParse(launched.receipt).success).toBe(true);
    expect({ ...launched.receipt, app: { ...launched.receipt.app, target: launched.receipt.app.target === null ? null : { ...launched.receipt.app.target } }, window: launched.receipt.window === null ? null : { ...launched.receipt.window } }).toMatchObject({ app: { name: "TextEdit", target: { reference: expect.stringMatching(/^datgt_/) } }, window: { reference: expect.stringMatching(/^dtgt_/) }, windowSelection: "unique" });
    expect(JSON.stringify(launched.receipt)).not.toMatch(/com\.apple|"pid"|"window_id"|"bundle_id"|"launch_path"|sensitive/i);
    expect(checked.calls).toEqual([{ name: "list_apps", args: {} }, { name: "launch_app", args: { bundle_id: "com.apple.TextEdit" } }]);
    if (launched.receipt.window === null) throw new Error("expected window");
    expect(subject.registry.resolveTarget(launched.receipt.window.context, scope, launched.receipt.window.reference)).toMatchObject({ ok: true });
    const state = await subject.observeWindowState({ scope, target: launched.receipt.window });
    if (!state.ok) throw new Error(JSON.stringify(state));
    expect(state.ok).toBe(true);
    expect(windowStateObservationSchema.safeParse(state.observation).success).toBe(true);
    expect(JSON.stringify(state.observation)).not.toMatch(/secret|tree|provider note|"pid"|"window_id"|"bundle_id"|"launch_path"/i);
  });

  test("accepts additive private Cua fields across launch, window capture, focus, and action families", async () => {
    const privateSentinel = "provider-private-addition";
    const launchBase = launchSuccess("com.spotify.client", "Spotify").structuredContent!;
    const launchWindow = (launchBase["windows"] as readonly Readonly<Record<string, unknown>>[])[0]!;
    const additiveLaunch = result({
      ...launchBase,
      provider_extension: { sentinel: privateSentinel },
      launch_state: { ...(launchBase["launch_state"] as Readonly<Record<string, unknown>>), provider_phase: "ready" },
      windows: [{
        ...launchWindow,
        provider_window_extension: privateSentinel,
        bounds: { ...(launchWindow["bounds"] as Readonly<Record<string, unknown>>), coordinate_epoch: 4 },
      }],
    });
    const stateBase = windowState().structuredContent!;
    const additiveState = result({ ...stateBase, provider_ax_revision: 3, provider_note_v2: privateSentinel });
    const launchChecked = port([
      installedApps([{
        pid: 0, name: "Spotify", bundle_id: "com.spotify.client", active: false, running: false,
        provider_inventory_extension: privateSentinel,
      }]),
      additiveLaunch,
      additiveState,
    ]);
    const launchAdapter = new CuaComputerUseAdapter({ port: launchChecked.value });
    const launched = await launchAdapter.launchApp({ scope, operation: { kind: "launch_app", app: { name: "Spotify" } } });
    expect(launched).toMatchObject({ ok: true, receipt: { app: { name: "Spotify" }, windowSelection: "unique" } });
    if (!launched.ok || launched.receipt.window === null) throw new Error("expected additive launch window");
    const observedState = await launchAdapter.observeWindowState({ scope, target: launched.receipt.window });
    expect(observedState).toMatchObject({ ok: true, observation: { operation: "window_state", verification: "supported" } });
    expect(JSON.stringify({ launched, observedState })).not.toContain(privateSentinel);

    const captureBase = windowStateScreenshot(1200, 800);
    const captureBounds = captureBase.structuredContent["window_bounds"] as Readonly<Record<string, unknown>>;
    const additiveCapture: CuaContextToolResult = {
      ...captureBase,
      structuredContent: {
        ...captureBase.structuredContent,
        provider_capture_revision: 9,
        window_bounds: { ...captureBounds, provider_coordinate_space: "retina" },
      },
    };
    const additiveAction = result({
      effect: "unverifiable",
      route: "synthetic_events",
      delivery: { mode: "background", provider_delivery_sequence: 12 },
      provider_action_extension: privateSentinel,
    });
    const captureChecked = port([
      installedApps([{ pid: 0, name: "Spotify", bundle_id: "com.spotify.client", active: false, running: false }]),
      additiveLaunch,
      additiveCapture,
      additiveAction,
    ]);
    const captureAdapter = new CuaComputerUseAdapter({ port: captureChecked.value });
    const captureLaunch = await captureAdapter.launchApp({ scope, operation: { kind: "launch_app", app: { name: "Spotify" } } });
    if (!captureLaunch.ok || captureLaunch.receipt.window === null) throw new Error("expected capture launch window");
    const captured = await captureAdapter.observeWindowState({ scope, target: captureLaunch.receipt.window, capture: "window_snapshot" });
    if (!captured.ok || captured.observation.windowSnapshot === undefined) throw new Error("expected additive capture");
    const clicked = await captureAdapter.click({
      scope,
      operation: {
        kind: "click",
        target: captured.observation.windowSnapshot.target,
        coordinateSpace: "window_snapshot_pixels",
        x: 248,
        y: 776,
      },
    });
    expect(clicked).toMatchObject({ ok: true, receipt: { completionCertainty: "completed", providerAction: { route: "synthetic_events" } } });
    expect(JSON.stringify({ captured: captured.observation, clicked })).not.toContain(privateSentinel);

    const appsBase = apps().structuredContent!;
    const windowsBase = windows().structuredContent!;
    const focusBase = focused().structuredContent!;
    const additiveApps = result({
      ...appsBase,
      provider_inventory_revision: 8,
      apps: (appsBase["apps"] as readonly Readonly<Record<string, unknown>>[]).map((app) => ({ ...app, provider_app_extension: privateSentinel })),
    });
    const additiveWindows = result({
      ...windowsBase,
      provider_window_revision: 8,
      windows: (windowsBase["windows"] as readonly Readonly<Record<string, unknown>>[]).map((window) => ({ ...window, provider_window_extension: privateSentinel })),
    });
    const additiveFocus = result({
      ...focusBase,
      provider_focus_extension: privateSentinel,
      exact_window_effect: { ...(focusBase["exact_window_effect"] as Readonly<Record<string, unknown>>), provider_proof_revision: 2 },
      observed: { ...(focusBase["observed"] as Readonly<Record<string, unknown>>), provider_observation_revision: 2 },
    });
    const focusChecked = port([additiveApps, additiveWindows, additiveApps, additiveWindows, additiveFocus]);
    const focusAdapter = new CuaComputerUseAdapter({ port: focusChecked.value });
    const desktop = await focusAdapter.observe({ scope, operation: "desktop_state" });
    if (!desktop.ok) throw new Error("expected additive desktop observation");
    const focusedResult = await focusAdapter.focus({
      scope,
      operation: { kind: "focus", target: desktop.observation.targets[0]!.target },
    });
    expect(focusedResult).toMatchObject({ ok: true, receipt: { completionCertainty: "completed", verification: "verified" } });
    expect(JSON.stringify({ desktop: desktop.observation, focusedResult })).not.toContain(privateSentinel);
  });

  test("refuses zero or multiple exact app names before the launch boundary without first-match fallback", async () => {
    const ambiguous = port([installedApps([
      { pid: 0, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: false, running: false },
      { pid: 0, name: "TextEdit", bundle_id: "org.example.TextEdit", active: false, running: false },
    ])]);
    const subject = new CuaComputerUseAdapter({ port: ambiguous.value });
    const result = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    expect(result.ok).toBe(false);
    expect(ambiguous.calls).toEqual([{ name: "list_apps", args: {} }]);
    expect(JSON.stringify(result)).not.toMatch(/com\.apple|org\.example/);
  });

  test("keeps the requested semantic label public when Cua returns its legitimate bundle-derived launch label", async () => {
    const checked = port([
      installedApps([{ pid: 0, name: "Microsoft Word", bundle_id: "com.microsoft.Word", active: false, running: false }]),
      launchSuccess("com.microsoft.Word", "Word"),
    ]);
    const launched = await new CuaComputerUseAdapter({ port: checked.value }).launchApp({ scope, operation: { kind: "launch_app", app: { name: "Microsoft Word" } } });
    expect(launched).toMatchObject({ ok: true, receipt: { app: { name: "Microsoft Word" }, windowSelection: "unique" } });
    expect(checked.calls).toEqual([{ name: "list_apps", args: {} }, { name: "launch_app", args: { bundle_id: "com.microsoft.Word" } }]);
    expect(JSON.stringify(launched)).not.toContain("com.microsoft.Word");
  });

  test("admits only the ordinary Spotify candidate from raw launch/list inventory and keeps helpers private", async () => {
    const rows = [
      rawWindowRow({ windowId: 610, appName: "Spotify", title: "Spotify Premium", width: 1200, height: 800 }),
      rawWindowRow({ windowId: 611, appName: "Spotify", title: "", width: 1512, height: 33, located: false }),
      rawWindowRow({ windowId: 612, appName: "Spotify", title: " ", width: 1512, height: 32, located: false }),
      rawWindowRow({ windowId: 613, appName: "Spotify", title: "", width: 500, height: 500, located: false }),
      rawWindowRow({ windowId: 614, appName: "Spotify", title: "", width: 64, height: 64, located: false }),
      rawWindowRow({ windowId: 615, appName: "Spotify", title: "helper", width: 0, height: 0 }),
      rawWindowRow({ windowId: 616, appName: "Spotify", title: "overlay", width: 0, height: 32 }),
    ];
    const checked = port([
      installedApps([{ pid: 0, name: "Spotify", bundle_id: "com.spotify.client", active: false, running: false }]),
      launchWithRawWindows("com.spotify.client", "Spotify", rows),
      installedApps([{ pid: 77, name: "Spotify", bundle_id: "com.spotify.client", active: true, running: true }]),
      listedRawWindows(rows),
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "Spotify" } } });
    if (!launched.ok || launched.receipt.app.target === null) throw new Error(JSON.stringify(launched));
    expect(launched.receipt).toMatchObject({
      app: { name: "Spotify" }, windowSelection: "unique",
      window: { reference: expect.stringMatching(/^dtgt_/) },
    });
    const observed = await subject.observeApplicationWindows({ scope, target: launched.receipt.app.target });
    expect(observed).toMatchObject({
      ok: true,
      observation: {
        completeness: "complete", discovered: 1, returned: 1, omitted: 0,
        candidates: [{ evidence: { appLabel: "Spotify", windowLabel: "Spotify Premium" } }],
      },
    });
    expect(JSON.stringify({ launched, observed })).not.toMatch(/Untitled window|helper|overlay|1512|window_id|com\.spotify/i);
  });

  test("joins Proton launch rows by exact pid and bundle authority rather than display-label punctuation", async () => {
    const rows = [
      rawWindowRow({ windowId: 680, appName: "ProtonVPN", title: "Proton VPN", width: 340, height: 632 }),
      rawWindowRow({ windowId: 681, appName: "ProtonVPN", title: "", width: 1512, height: 33, located: false }),
      rawWindowRow({ windowId: 682, appName: "ProtonVPN", title: "", width: 500, height: 500, located: false }),
      rawWindowRow({ windowId: 683, appName: "ProtonVPN", title: "helper", width: 0, height: 0 }),
      rawWindowRow({ windowId: 684, appName: "ProtonVPN", title: "", width: 64, height: 64, located: false }),
      rawWindowRow({ windowId: 685, appName: "ProtonVPN", title: "overlay", width: 0, height: 32 }),
    ];
    const checked = port([
      installedApps([{ pid: 0, name: "Proton VPN", bundle_id: "ch.protonvpn.mac", active: false, running: false }]),
      launchWithRawWindows("ch.protonvpn.mac", "Proton VPN", rows),
    ]);
    const launched = await new CuaComputerUseAdapter({ port: checked.value }).launchApp({
      scope, operation: { kind: "launch_app", app: { name: "Proton VPN" } },
    });
    expect(launched).toMatchObject({
      ok: true,
      receipt: { app: { name: "Proton VPN" }, windowSelection: "unique", window: { reference: expect.stringMatching(/^dtgt_/) } },
    });
    expect(JSON.stringify(launched)).not.toMatch(/ProtonVPN|ch\.protonvpn|helper|overlay|window_id/i);
  });

  test("filters unlocated helper fixtures without filtering off-Space candidates", async () => {
    const families = [
      { name: "Firefox", bundleId: "org.mozilla.firefox", raw: 9, candidates: 2 },
      { name: "TextEdit", bundleId: "com.apple.TextEdit", raw: 9, candidates: 4 },
      { name: "Finder", bundleId: "com.apple.finder", raw: 11, candidates: 6 },
      { name: "Slack", bundleId: "com.tinyspeck.slackmacgap", raw: 7, candidates: 1 },
      { name: "Google Chrome", bundleId: "com.google.Chrome", raw: 11, candidates: 1 },
      { name: "Electron", bundleId: "com.github.Electron", raw: 7, candidates: 1 },
    ] as const;
    for (const family of families) {
      const rows = Array.from({ length: family.raw }, (_, index) => rawWindowRow({
        windowId: 700 + index,
        appName: family.name,
        title: index < family.candidates ? `${family.name} ${index + 1}` : "",
        width: index < family.candidates ? 900 : index % 2 === 0 ? 1512 : 0,
        height: index < family.candidates ? 700 : index % 2 === 0 ? 33 : 0,
        onScreen: false,
        located: index < family.candidates,
      }));
      const checked = port([
        installedApps([{ pid: 0, name: family.name, bundle_id: family.bundleId, active: false, running: false }]),
        launchWithRawWindows(family.bundleId, family.name, rows),
        installedApps([{ pid: 77, name: family.name, bundle_id: family.bundleId, active: true, running: true }]),
        listedRawWindows(rows),
      ]);
      const subject = new CuaComputerUseAdapter({ port: checked.value });
      const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: family.name } } });
      if (!launched.ok || launched.receipt.app.target === null) throw new Error(JSON.stringify(launched));
      const observed = await subject.observeApplicationWindows({ scope, target: launched.receipt.app.target });
      if (!observed.ok) throw new Error(JSON.stringify(observed));
      expect(observed.observation).toMatchObject({
        completeness: "complete", discovered: family.candidates, returned: family.candidates, omitted: 0,
      });
      expect(observed.observation.candidates).toHaveLength(family.candidates);
      expect(observed.observation.candidates.every((candidate) => candidate.evidence.bounds !== undefined)).toBe(true);
      expect(JSON.stringify(observed)).not.toMatch(/Untitled window|window_id|bundle_id|1512/);
    }
  });

  test("preserves untitled off-Space windows in launch, app discovery and desktop discovery", async () => {
    const rows = [
      rawWindowRow({ windowId: 500, appName: "Sketchpad", title: "", width: 960, height: 720 }),
      rawWindowRow({ windowId: 501, appName: "Sketchpad", title: "", width: 1440, height: 33, located: false }),
    ];
    const apps = installedApps([{ pid: 77, name: "Sketchpad", bundle_id: "org.example.sketchpad", active: false, running: true }]);
    const checked = port([apps, launchWithRawWindows("org.example.sketchpad", "Sketchpad", rows), apps, listedRawWindows(rows),
      apps, listedRawWindows(rows), exactWindowState(77, 500, true)]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "Sketchpad" } } });
    if (!launched.ok || !launched.receipt.app.target) throw new Error("expected launched app");
    expect(launched.receipt).toMatchObject({ windowSelection: "unique", window: { reference: expect.any(String) } });
    const appWindows = await subject.observeApplicationWindows({ scope, target: launched.receipt.app.target });
    expect(appWindows).toMatchObject({ ok: true, observation: { discovered: 1, candidates: [{ evidence: { windowLabel: "Untitled window" } }] } });
    const desktop = await subject.observe({ scope, operation: "desktop_state" });
    expect(desktop).toMatchObject({ ok: true, observation: { discovered: 1, targets: [{ evidence: { windowLabel: "Untitled window" } }] } });
    expect(checked.calls.every(call => ["list_apps", "launch_app", "list_windows"].includes(call.name))).toBe(true);
    if (!desktop.ok) throw new Error("expected window discovery");
    const observed = await subject.observeWindowState({ scope, target: desktop.observation.targets[0]!.target });
    expect(observed).toMatchObject({ ok: true, observation: { degraded: true, outcome: { recovery: ["focus_target"] } } });
  });

  test("does not hide located untitled surfaces by label or arbitrary size", async () => {
    const rows = [
      rawWindowRow({ windowId: 500, appName: "Sketchpad", title: "", width: 960, height: 720 }),
      rawWindowRow({ windowId: 501, appName: "Sketchpad", title: " ", width: 64, height: 33 }),
    ];
    const checked = port([installedApps([{ pid: 77, name: "Sketchpad", bundle_id: "org.example.sketchpad", active: false, running: true }]),
      launchWithRawWindows("org.example.sketchpad", "Sketchpad", rows)]);
    const launched = await new CuaComputerUseAdapter({ port: checked.value }).launchApp({ scope, operation: { kind: "launch_app", app: { name: "Sketchpad" } } });
    expect(launched).toMatchObject({ ok: true, receipt: { windowSelection: "ambiguous", window: null } });
  });

  test("retains app authority when raw helpers contain no semantic window candidate", async () => {
    const rows = [
      rawWindowRow({ windowId: 801, appName: "Helper App", title: "", width: 1512, height: 33, located: false }),
      rawWindowRow({ windowId: 802, appName: "Helper App", title: "helper", width: 0, height: 0 }),
    ];
    const checked = port([
      installedApps([{ pid: 0, name: "Helper App", bundle_id: "org.example.HelperApp", active: false, running: false }]),
      launchWithRawWindows("org.example.HelperApp", "Helper App", rows),
    ]);
    const launched = await new CuaComputerUseAdapter({ port: checked.value }).launchApp({
      scope, operation: { kind: "launch_app", app: { name: "Helper App" } },
    });
    if (launched.ok) {
      const parsed = computerLaunchReceiptSchema.safeParse(launched.receipt);
      if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
    }
    expect(launched).toMatchObject({
      ok: true,
      receipt: {
        app: { target: { reference: expect.stringMatching(/^datgt_/) } },
        window: null, windowSelection: "none", launchProgress: { windowReady: false },
      },
    });
    expect(JSON.stringify(launched)).not.toMatch(/Untitled window|1512|window_id/i);
  });

  test("keeps null-bundle identities conservative but deduplicates identical running bundle identity", async () => {
    const ambiguous = port([installedApps([
      { pid: 0, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: false, running: false },
      { pid: 0, name: "TextEdit", bundle_id: null, active: false, running: false },
    ])]);
    const ambiguousLaunch = await new CuaComputerUseAdapter({ port: ambiguous.value }).launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    expect(ambiguousLaunch.ok).toBe(false);
    expect(ambiguous.calls).toEqual([{ name: "list_apps", args: {} }]);

    const duplicateRunning = port([installedApps([
      { pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true },
      { pid: 78, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: false, running: true },
    ]), launchSuccess()]);
    const idempotent = await new CuaComputerUseAdapter({ port: duplicateRunning.value }).launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    expect(idempotent.ok).toBe(true);
    expect(duplicateRunning.calls).toEqual([{ name: "list_apps", args: {} }, { name: "launch_app", args: { bundle_id: "com.apple.TextEdit" } }]);
  });

  test("refreshes delayed launch windows under the same opaque app capability without dropping the provider tail", async () => {
    const checked = port([
      installedApps([{ pid: 0, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: false, running: false }]),
      launchSuccess("com.apple.TextEdit", "TextEdit", 101),
      installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true }]),
      listedWindows(77, "TextEdit", 101),
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!launched.ok || launched.receipt.app.target === null) throw new Error("expected launch");
    expect(launched.receipt.windowSelection).toBe("ambiguous");
    const candidates = await subject.observeApplicationWindows({ scope, target: launched.receipt.app.target });
    expect(candidates).toMatchObject({ ok: true, observation: { completeness: "complete", discovered: 101, returned: 101, omitted: 0 } });
    if (!candidates.ok) return;
    expect(candidates.observation.candidates).toHaveLength(101);
    expect(JSON.stringify(candidates.observation)).not.toContain("com.apple");
    expect(candidates.observation.target).toEqual(launched.receipt.app.target);
    expect(checked.calls).toEqual([
      { name: "list_apps", args: {} }, { name: "launch_app", args: { bundle_id: "com.apple.TextEdit" } },
      { name: "list_apps", args: {} }, { name: "list_windows", args: { pid: 77 } },
    ]);
  });

  test("discovers a window published after a process-running launch without changing the opaque app context", async () => {
    const checked = port([
      installedApps([{ pid: 0, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: false, running: false }]),
      launchSuccess("com.apple.TextEdit", "TextEdit", 0),
      installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true }]),
      listedWindows(77, "TextEdit", 1),
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!launched.ok || launched.receipt.app.target === null) throw new Error("expected launched application");
    expect(launched.receipt).toMatchObject({ window: null, launchProgress: { processRunning: true, windowReady: false } });
    const fresh = await subject.observeApplicationWindows({ scope, target: launched.receipt.app.target });
    if (!fresh.ok) throw new Error(JSON.stringify(fresh));
    expect(fresh.observation).toMatchObject({
      target: launched.receipt.app.target, completeness: "complete", discovered: 1, returned: 1, omitted: 0,
      candidates: [{ target: { context: launched.receipt.app.target.context, reference: expect.stringMatching(/^dtgt_/) } }],
    });
    expect(computerLaunchReceiptSchema.safeParse(launched.receipt).success).toBe(true);
    expect(JSON.stringify(fresh)).not.toMatch(/com\.apple|"pid"|"window_id"/);
  });

  test("keeps complete fresh window identity separate from non-exhaustive literal query matches", async () => {
    const windowCount = 30;
    const queriedStates = Array.from({ length: windowCount }, (_, index) => {
      const positive = index === 4 || index === 29;
      return result({
        window_id: 500 + index,
        pid: 77,
        element_count: 92,
        total_element_count: 92,
        returned_element_count: positive ? 1 : 0,
        filtered_element_count: positive ? 1 : 0,
        elements_complete: false,
        tree_markdown: "private query tree",
        elements: positive ? [{
          element_index: index,
          element_token: `private-${index}`,
          role: "AXStaticText",
          label: "Needle project",
          depth: 1,
          parent_index: 0,
        }] : [],
        _note: "private note",
      });
    });
    const checked = port([
      installedApps([{ pid: 0, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: false, running: false }]),
      launchSuccess("com.apple.TextEdit", "TextEdit", 0),
      installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true }]),
      listedWindows(77, "TextEdit", windowCount),
      ...queriedStates,
    ]);
    const registry = new ComputerUseContextRegistry();
    const subject = new CuaComputerUseAdapter({ port: checked.value, registry });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!launched.ok || launched.receipt.app.target === null) throw new Error("expected launched application");

    const fresh = await subject.observeApplicationWindows({
      scope,
      target: launched.receipt.app.target,
      query: "Needle",
      effort: { maxElements: 7_500, maxDepth: 50 },
    });

    if (!fresh.ok) throw new Error(JSON.stringify(fresh));
    expect(fresh.observation).toMatchObject({
      completeness: "complete",
      discovered: 30,
      returned: 30,
      omitted: 0,
      semanticQuery: { query: "Needle", effort: { maxElements: 7_500, maxDepth: 50 }, exhaustive: false, inspected: 30, uninspected: 0 },
    });
    expect(fresh.observation.candidates).toHaveLength(30);
    expect(fresh.observation.candidates.filter((candidate) => candidate.semanticQuery?.matched === 1))
      .toMatchObject([
        { semanticQuery: { query: "Needle", exhaustive: false, returned: 1, omitted: 0, matches: [{ role: "text", label: "Needle project" }] } },
        { semanticQuery: { query: "Needle", exhaustive: false, returned: 1, omitted: 0, matches: [{ role: "text", label: "Needle project" }] } },
      ]);
    expect(fresh.observation.candidates.filter((candidate) => candidate.semanticQuery?.matched === 0)).toHaveLength(28);
    const privateWindowIds = fresh.observation.candidates.map((candidate) => {
      const resolved = registry.resolveTarget(candidate.target.context, scope, candidate.target.reference);
      if (!resolved.ok) throw new Error("expected every freshly inventoried window target to remain usable");
      return resolved.data.providerTarget.windowId;
    });
    expect(privateWindowIds).toEqual(Array.from({ length: windowCount }, (_, index) => 500 + index));
    expect(checked.calls.slice(-windowCount).map((call) => call.args["window_id"])).toEqual(
      Array.from({ length: windowCount }, (_, index) => 500 + index),
    );
    expect(checked.calls.slice(-windowCount).every((call) =>
      call.args["max_elements"] === 7_500 && call.args["max_depth"] === 50)).toBe(true);
    expect(applicationWindowsObservationSchema.safeParse(fresh.observation).success).toBe(true);
    expect(applicationWindowsObservationSchema.safeParse({
      ...fresh.observation,
      candidates: fresh.observation.candidates.map((candidate, index) => index === 0
        ? { ...candidate, semanticQuery: { ...candidate.semanticQuery!, effort: { maxDepth: 51 } } }
        : candidate),
    }).success).toBe(false);
    expect(JSON.stringify(fresh)).not.toMatch(/"role":"AX|"element_index"|"element_token"|"parent_index"|private|"pid"|"window_id"/);
  });

  test("keeps mixed no-match and degraded query availability truthful while returning both fresh windows", async () => {
    const checked = port([
      installedApps([{ pid: 0, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: false, running: false }]),
      launchSuccess("com.apple.TextEdit", "TextEdit", 0),
      installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true }]),
      listedWindows(77, "TextEdit", 2),
      result({
        window_id: 500, pid: 77, element_count: 0, total_element_count: 0, returned_element_count: 0,
        filtered_element_count: 0, elements_complete: false, tree_markdown: "private empty tree", elements: [], _note: "private",
      }),
      result({
        window_id: 501, pid: 77, element_count: 0, total_element_count: 0, returned_element_count: 0,
        filtered_element_count: 0, elements_complete: false, tree_markdown: "private degraded tree", elements: [], _note: "private",
        degraded: true, degraded_reason: "ax_window_unresolved: private provider detail",
      }),
    ]);
    const registry = new ComputerUseContextRegistry();
    const subject = new CuaComputerUseAdapter({ port: checked.value, registry });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!launched.ok || launched.receipt.app.target === null) throw new Error("expected launched application");

    const fresh = await subject.observeApplicationWindows({ scope, target: launched.receipt.app.target, query: "Needle" });

    expect(fresh).toMatchObject({ ok: true, observation: {
      completeness: "complete", discovered: 2, returned: 2, omitted: 0,
      semanticQuery: { query: "Needle", exhaustive: false, inspected: 1, uninspected: 1 },
      candidates: [
        { semanticQuery: { query: "Needle", matched: 0, returned: 0, omitted: 0, matches: [] } },
        { semanticQueryUnavailable: { query: "Needle", status: "unavailable", recovery: "focus_target" } },
      ],
    } });
    if (!fresh.ok) throw new Error("expected mixed query result");
    expect(fresh.observation.candidates.every((candidate) =>
      registry.resolveTarget(candidate.target.context, scope, candidate.target.reference).ok)).toBe(true);
    expect(applicationWindowsObservationSchema.safeParse(fresh.observation).success).toBe(true);
    expect(JSON.stringify(fresh)).not.toMatch(/ax_window_unresolved|degraded_reason|private|window_id|element_token|"pid"/);
  });

  test("returns every positive aggregate candidate without a terminal response cap", async () => {
    const windowCount = 25;
    const positiveState = (index: number) => result({
      window_id: 500 + index,
      pid: 77,
      element_count: 1,
      total_element_count: 1,
      returned_element_count: 1,
      filtered_element_count: 1,
      elements_complete: false,
      tree_markdown: "private query tree",
      elements: [{ element_index: 0, element_token: `private-${index}`, role: "AXStaticText", label: "Needle", depth: 0 }],
      _note: "private note",
    });
    const checked = port([
      installedApps([{ pid: 0, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: false, running: false }]),
      launchSuccess("com.apple.TextEdit", "TextEdit", 0),
      installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true }]),
      listedWindows(77, "TextEdit", windowCount),
      ...Array.from({ length: windowCount }, (_, index) => positiveState(index)),
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!launched.ok || launched.receipt.app.target === null) throw new Error("expected launched application");

    const fresh = await subject.observeApplicationWindows({ scope, target: launched.receipt.app.target, query: "Needle" });

    expect(fresh).toMatchObject({
      ok: true,
      observation: {
        completeness: "complete",
        discovered: 25,
        returned: 25,
        omitted: 0,
        semanticQuery: { query: "Needle", exhaustive: false, inspected: 25, uninspected: 0 },
      },
    });
    if (!fresh.ok) throw new Error("expected complete aggregate query");
    expect(fresh.observation.candidates).toHaveLength(25);
    expect(applicationWindowsObservationSchema.safeParse(fresh.observation).success).toBe(true);
  });

  test("does not replace retained app windows when one aggregate semantic response is malformed", async () => {
    const checked = port([
      installedApps([{ pid: 0, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: false, running: false }]),
      launchSuccess("com.apple.TextEdit", "TextEdit", 1),
      installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true }]),
      listedWindows(77, "TextEdit", 2),
      result({
        window_id: 500, pid: 77, element_count: 0, total_element_count: 0, returned_element_count: 0,
        filtered_element_count: 0, elements_complete: false, tree_markdown: "private", elements: [], _note: "private",
      }),
      result({
        window_id: 501, pid: 77, element_count: 0, total_element_count: 0, returned_element_count: 0,
        filtered_element_count: 0, elements_complete: false, tree_markdown: "private", elements: [],
      }),
    ]);
    const registry = new ComputerUseContextRegistry();
    const subject = new CuaComputerUseAdapter({ port: checked.value, registry });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!launched.ok || launched.receipt.app.target === null) throw new Error("expected launched application");
    const prior = registry.resolveApplicationWindows(
      launched.receipt.app.target.context, scope, launched.receipt.app.target.reference,
    );
    if (!prior.ok) throw new Error("expected prior retained windows");

    const failed = await subject.observeApplicationWindows({ scope, target: launched.receipt.app.target, query: "Needle" });

    expect(failed).toMatchObject({ ok: false, outcome: { providerCondition: "malformed_response" } });
    expect(checked.invalidateCheckedGeneration).toHaveBeenCalledTimes(1);
    expect(registry.resolveApplicationWindows(
      launched.receipt.app.target.context, scope, launched.receipt.app.target.reference,
    )).toEqual(prior);
  });

  test("does not commit refreshed app windows after cancellation or a checked-session generation change", async () => {
    const launchPort = port([
      installedApps([{ pid: 0, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: false, running: false }]), launchSuccess("com.apple.TextEdit", "TextEdit", 0),
    ]);
    const registry = new ComputerUseContextRegistry();
    const launcher = new CuaComputerUseAdapter({ port: launchPort.value, registry });
    const launched = await launcher.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!launched.ok || launched.receipt.app.target === null) throw new Error("expected launch");

    const cancelled = new AbortController();
    cancelled.abort();
    const noCall = port([]);
    const cancelledResult = await new CuaComputerUseAdapter({ port: noCall.value, registry }).observeApplicationWindows({
      scope, signal: cancelled.signal, target: launched.receipt.app.target,
    });
    expect(cancelledResult).toMatchObject({ ok: false, outcome: { providerCondition: "cancelled", recovery: ["retry_same_request"] } });
    expect(noCall.calls).toEqual([]);

    let calls = 0;
    const stalePort: CuaCheckedContextPort = {
      ...noCall.value,
      callContextTool: async (_scope, name) => {
        calls += 1;
        return {
          ok: true as const,
          generation: calls === 1 ? generation : "cua_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          sessionId,
          result: name === "list_apps"
            ? installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true }])
            : listedWindows(77, "TextEdit", 1),
        };
      },
    };
    const stale = await new CuaComputerUseAdapter({ port: stalePort, registry }).observeApplicationWindows({ scope, target: launched.receipt.app.target });
    expect(stale).toMatchObject({ ok: false, outcome: { providerCondition: "malformed_response", recovery: ["observe_again"] } });
    expect(registry.resolveApplicationWindows(launched.receipt.app.target.context, scope, launched.receipt.app.target.reference))
      .toMatchObject({ ok: true, data: { discovered: 0, targets: [] } });
  });

  test("post-read cancellation preserves aggregate references while retiring queried-window elements", async () => {
    const queryState = result({
      window_id: 500,
      pid: 77,
      element_count: 1,
      total_element_count: 1,
      returned_element_count: 1,
      filtered_element_count: 1,
      elements_complete: false,
      tree_markdown: "private query tree",
      elements: [{ element_index: 0, element_token: "private-query-token", role: "AXStaticText", label: "Needle", depth: 0 }],
      _note: "private note",
    });
    const checked = port([
      installedApps([{ pid: 0, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: false, running: false }]),
      launchSuccess(),
      installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true }]),
      listedWindows(77, "TextEdit", 1),
      queryState,
    ]);
    const registry = new ComputerUseContextRegistry();
    const controller = new AbortController();
    let abortAtPublication = false;
    let humanChecks = 0;
    const readHidIdleNanoseconds = async () => {
      if (abortAtPublication) {
        humanChecks += 1;
        if (humanChecks === 2) controller.abort();
      }
      return 1_000_000_000;
    };
    const launched = await new CuaComputerUseAdapter({
      port: checked.value,
      registry,
      monotonicMilliseconds: () => 10_000,
      readHidIdleNanoseconds,
    }).launchApp({
      scope,
      operation: { kind: "launch_app", app: { name: "TextEdit" } },
    });
    if (!launched.ok || launched.receipt.window === null) throw new Error("expected launched window");
    const prior = registry.resolveApplicationWindows(
      launched.receipt.app.target.context,
      scope,
      launched.receipt.app.target.reference,
    );
    if (!prior.ok) throw new Error("expected aggregate authority");
    const oldElement = registry.registerTargets(launched.receipt.window.context, scope, [{
      evidence: { kind: "element", role: "button", action: "click" },
      providerTarget: { provider: "cua", operation: "click", pid: 77, windowId: 500, elementToken: "private-old-element" },
    }]);
    if (!oldElement.ok) throw new Error("expected old element");

    abortAtPublication = true;
    const subject = new CuaComputerUseAdapter({
      port: checked.value,
      registry,
      monotonicMilliseconds: () => 10_000,
      readHidIdleNanoseconds,
    });
    const cancelled = await subject.observeApplicationWindows({
      scope,
      target: launched.receipt.app.target,
      query: "Needle",
      signal: controller.signal,
    });

    expect(cancelled).toMatchObject({ ok: false, outcome: { providerCondition: "cancelled", recovery: ["retry_same_request"] } });
    expect(cancelled).not.toHaveProperty("observation");
    expect(checked.calls.filter((call) => call.name === "get_window_state")).toHaveLength(1);
    expect(registry.resolveTarget(launched.receipt.window.context, scope, oldElement.data[0]!.reference))
      .toEqual({ ok: false, code: "not_found" });
    expect(registry.resolveTarget(launched.receipt.app.target.context, scope, launched.receipt.app.target.reference).ok).toBe(true);
    expect(registry.resolveTarget(launched.receipt.window.context, scope, launched.receipt.window.reference).ok).toBe(true);
    expect(registry.resolveApplicationWindows(
      launched.receipt.app.target.context,
      scope,
      launched.receipt.app.target.reference,
    )).toEqual(prior);
  });

  test("fails closed on a pid-filtered foreign process but canonicalizes a presentation-label variant", async () => {
    const foreign = port([
      installedApps([{ pid: 0, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: false, running: false }]), launchSuccess("com.apple.TextEdit", "TextEdit", 0),
      installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true }]), listedWindows(78, "TextEdit", 1),
    ]);
    const subject = new CuaComputerUseAdapter({ port: foreign.value });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!launched.ok || launched.receipt.app.target === null) throw new Error("expected launch");
    const rejected = await subject.observeApplicationWindows({ scope, target: launched.receipt.app.target });
    expect(rejected).toMatchObject({ ok: false, outcome: { providerCondition: "malformed_response", recovery: ["observe_again"] } });
    expect(foreign.invalidateCheckedGeneration).toHaveBeenCalledTimes(1);

    const variant = port([
      installedApps([{ pid: 0, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: false, running: false }]), launchSuccess("com.apple.TextEdit", "TextEdit", 0),
      installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true }]), listedWindows(77, "Text Edit", 1),
    ]);
    const variantSubject = new CuaComputerUseAdapter({ port: variant.value });
    const variantLaunch = await variantSubject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!variantLaunch.ok || variantLaunch.receipt.app.target === null) throw new Error("expected variant launch");
    const refreshed = await variantSubject.observeApplicationWindows({ scope, target: variantLaunch.receipt.app.target });
    expect(refreshed).toMatchObject({
      ok: true,
      observation: { candidates: [{ evidence: { appLabel: "TextEdit" } }] },
    });
    expect(variant.invalidateCheckedGeneration).not.toHaveBeenCalled();
    expect(JSON.stringify(refreshed)).not.toContain("Text Edit");
  });

  test("CAS-fences an older concurrent app-window refresh instead of revoking the newer opaque result", async () => {
    const launchPort = port([
      installedApps([{ pid: 0, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: false, running: false }]), launchSuccess("com.apple.TextEdit", "TextEdit", 0),
    ]);
    const registry = new ComputerUseContextRegistry();
    const launcher = new CuaComputerUseAdapter({ port: launchPort.value, registry });
    const launched = await launcher.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!launched.ok || launched.receipt.app.target === null) throw new Error("expected launch");

    let releaseFirstApps: (() => void) | undefined;
    let releaseSecondApps: (() => void) | undefined;
    const firstApps = new Promise<void>((resolve) => { releaseFirstApps = resolve; });
    const secondApps = new Promise<void>((resolve) => { releaseSecondApps = resolve; });
    const refreshPort = (appsGate: Promise<void>, title: string): CuaCheckedContextPort => ({
      generation,
      callContextTool: async (_scope, name, args) => {
        if (name === "list_apps") {
          await appsGate;
          return { ok: true as const, generation, sessionId, result: installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true }]) };
        }
        expect(name).toBe("list_windows");
        expect(args).toEqual({ pid: 77 });
        const rows = listedWindows(77, "TextEdit", 1);
        return {
          ok: true as const, generation, sessionId,
          result: result({ ...rows.structuredContent!, windows: [{ ...(rows.structuredContent!["windows"] as readonly Record<string, unknown>[])[0]!, title }] }),
        };
      },
      launchApplication: unusedCheckedCall,
      getWindowState: unusedCheckedCall,
      captureDesktopState: async () => ({ ok: false, code: "context_fenced" }),
      clickDesktop: async () => ({ ok: false, code: "context_fenced", stage: "session" }),
      endContextLease: async () => undefined,
    });
    const first = new CuaComputerUseAdapter({ port: refreshPort(firstApps, "Older"), registry }).observeApplicationWindows({ scope, target: launched.receipt.app.target });
    const second = new CuaComputerUseAdapter({ port: refreshPort(secondApps, "Newer"), registry }).observeApplicationWindows({ scope, target: launched.receipt.app.target });
    releaseSecondApps!();
    const winner = await second;
    if (!winner.ok) throw new Error(JSON.stringify(winner));
    releaseFirstApps!();
    const loser = await first;
    expect(loser).toMatchObject({
      ok: false,
      error: "A newer app-window observation won; repeat if needed.",
      outcome: { phase: "observe", retrySafety: "safe", providerCondition: "ready", targetCondition: "current", recovery: ["retry_same_request"] },
    });
    expect(registry.resolveApplicationWindows(launched.receipt.app.target.context, scope, launched.receipt.app.target.reference))
      .toMatchObject({ ok: true, data: { targets: winner.observation.candidates.map((candidate) => ({ reference: candidate.target.reference })) } });
  });

  test("keeps the prior context usable when post-boundary launch output is malformed and never fabricates swapped identity", async () => {
    const registry = new ComputerUseContextRegistry();
    const prior = registry.create(scope);
    if (!prior.ok) throw new Error("expected prior context");
    const priorTarget = registry.registerTargets(prior.data.context, scope, [{
      evidence: { kind: "window", appLabel: "Existing", windowLabel: "Old" },
      providerTarget: { provider: "cua", operation: "focus", pid: 1, windowId: 2, bundleId: "org.example.Existing" },
    }]);
    if (!priorTarget.ok) throw new Error("expected prior target");
    const checked = port([installedApps([{ pid: 0, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: false, running: false }]), launchSuccess("org.evil.TextEdit")]);
    const subject = new CuaComputerUseAdapter({ port: checked.value, registry });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    expect(launched.ok).toBe(false);
    expect(checked.invalidateCheckedGeneration).toHaveBeenCalledTimes(1);
    expect(registry.resolveTarget(prior.data.context, scope, priorTarget.data[0]!.reference).ok).toBe(true);
    expect(JSON.stringify(launched)).not.toMatch(/evil|com\.apple|77|500/i);
  });

  test("rejects launch windows that contradict the exact resolved app or layer-zero geometry", async () => {
    for (const overrides of [
      { app_name: "" },
      { layer: 3 },
      { z_index: -1 },
      { bounds: { x: 1, y: 2, width: -1, height: 600 } },
    ]) {
      const checked = port([
        installedApps([{ pid: 0, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: false, running: false }]),
        launchSuccess("com.apple.TextEdit", "TextEdit", 1, overrides),
      ]);
      const launched = await new CuaComputerUseAdapter({ port: checked.value }).launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
      expect(launched.ok).toBe(false);
      expect(launched.receipt.completionCertainty).toBe("unknown_completion");
      expect(checked.invalidateCheckedGeneration).toHaveBeenCalledTimes(1);
    }
  });

  test("withdraws on unbound structured launch errors and no-screenshot window-state drift without exposing provider facts", async () => {
    for (const launchError of [
      result({ error: "APP_NOT_INSTALLED", bundle_id: "org.evil.TextEdit" }, true),
      result({ error: "UNREVIEWED_PROVIDER_ERROR", native_diagnostic: "private launch diagnostic" }, true),
    ]) {
      const checked = port([
        installedApps([{ pid: 0, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: false, running: false }]),
        launchError,
      ]);
      const launched = await new CuaComputerUseAdapter({ port: checked.value }).launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
      expect(launched).toMatchObject({ ok: false, receipt: { completionCertainty: "unknown_completion" } });
      expect(checked.invalidateCheckedGeneration).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(launched)).not.toMatch(/evil|diagnostic|UNREVIEWED/i);
    }

    const checked = port([
      installedApps([{ pid: 0, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: false, running: false }]),
      launchSuccess(),
      result({
        window_id: 500, pid: 77, element_count: 0, total_element_count: 0, returned_element_count: 0,
        elements_complete: false, tree_markdown: "private AX tree", elements: [], _note: "private provider note",
        screenshot_file_path: "/private/capture.png",
      }),
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!launched.ok || launched.receipt.window === null) throw new Error("expected launch window");
    const state = await subject.observeWindowState({ scope, target: launched.receipt.window });
    expect(state).toMatchObject({ ok: false, outcome: { providerCondition: "malformed_response" } });
    expect(checked.invalidateCheckedGeneration).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(state)).not.toMatch(/private|capture|tree/i);
  });

  test("maps exact Cua window-scope refusals to a content-free stale target and keeps degraded state semantic", async () => {
    const checked = port([
      installedApps([{ pid: 0, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: false, running: false }]), launchSuccess(),
      result({ code: "window_id_not_found", pid: 77, window_id: 500, suggestion: "sensitive native retry" }, true),
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!launched.ok || launched.receipt.window === null) throw new Error("expected launch window");
    const stale = await subject.observeWindowState({ scope, target: launched.receipt.window });
    expect(stale).toMatchObject({ ok: false, outcome: { targetCondition: "stale", recovery: ["observe_again"] } });
    expect(JSON.stringify(stale)).not.toContain("sensitive native retry");
  });

  test("marks an AX-empty window-state observation observe-before-retry rather than falsely safe", async () => {
    const checked = port([
      installedApps([{ pid: 0, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: false, running: false }]), launchSuccess(), windowState(true),
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!launched.ok || launched.receipt.window === null) throw new Error("expected launch window");
    const observed = await subject.observeWindowState({ scope, target: launched.receipt.window });
    expect(observed).toMatchObject({
      ok: true,
      observation: { completeness: "partial", degraded: true, outcome: { retrySafety: "observe_before_retry", recovery: ["observe_again"] } },
    });
    if (!observed.ok) return;
    expect(windowStateObservationSchema.safeParse(observed.observation).success).toBe(true);
    expect(JSON.stringify(observed)).not.toMatch(/sensitive|ax_tree_empty/);
  });

  test("routes an unresolved exact window through focus rather than a futile observation loop", async () => {
    const checked = port([
      installedApps([{ pid: 0, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: false, running: false }]),
      launchSuccess(),
      exactWindowState(77, 500, true),
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!launched.ok || launched.receipt.window === null) throw new Error("expected launch window");
    const observed = await subject.observeWindowState({ scope, target: launched.receipt.window });
    expect(observed).toMatchObject({
      ok: true,
      observation: { completeness: "partial", degraded: true, outcome: { retrySafety: "never", recovery: ["focus_target"] } },
    });
    if (observed.ok) expect(windowStateObservationSchema.safeParse(observed.observation).success).toBe(true);
    expect(JSON.stringify(observed)).not.toMatch(/private|ax_window_unresolved/);
  });

  test("accepts Cua 0.23.2 degraded AX state when the exact off-Space window screenshot is valid", async () => {
    const capture = windowStateScreenshot(1440, 1304, true);
    capture.structuredContent = {
      ...capture.structuredContent,
      degraded_reason: "ax_window_unresolved: the requested AX window is not currently resolvable",
      background_input: {
        exact_status: "ax_unresolved",
        observation: { frame_freshness: "unknown", one_shot_capture: "available" },
      },
      escalation: { recommended: "foreground" },
    };
    const checked = port([
      installedApps([{ pid: 0, name: "Cua Lab Fixture", bundle_id: "dev.nautilo.cualabfixture", active: false, running: false }]),
      launchSuccess("dev.nautilo.cualabfixture", "Cua Lab Fixture"),
      capture,
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "Cua Lab Fixture" } } });
    if (!launched.ok || launched.receipt.window === null) throw new Error("expected exact fixture window");

    const observed = await subject.observeWindowState({ scope, target: launched.receipt.window, capture: "window_snapshot" });

    expect(observed).toMatchObject({
      ok: true,
      observation: {
        completeness: "partial",
        degraded: true,
        verification: "indeterminate",
        windowSnapshot: { metadata: { format: "png", dimensions: { width: 1440, height: 1304 }, coordinateSpace: "window_snapshot_pixels" } },
        outcome: { providerCondition: "ready", targetCondition: "current", retrySafety: "never" },
      },
    });
    expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
    expect(JSON.stringify(observed)).not.toMatch(/ax_window_unresolved|background_input|foreground/);
  });

  test("projects only direct bounded semantic-query matches and keeps Cua ancestor/token state private", async () => {
    const longLabel = `${"x".repeat(300)} fixture semantic tail`;
    const queryState = result({
      window_id: 500, pid: 77,
      element_count: 92, total_element_count: 92, returned_element_count: 12, filtered_element_count: 12,
      elements_complete: false, tree_markdown: "private filtered tree", _note: "private note",
      elements: [
        { element_index: 0, element_token: "private-window-token", role: "AXWindow", label: "Cua Lab Document 1", depth: 0 },
        { element_index: 1, element_token: "private-checkbox-token", role: "AXCheckBox", label: "Enable fixture", value: "0", depth: 1, parent_index: 0, enabled: true },
        { element_index: 2, element_token: "private-slider-token", role: "AXSlider", label: "Fixture level", value: "25", depth: 1, parent_index: 0, enabled: true },
        { element_index: 3, element_token: "private-button-token", role: "AXButton", label: "New fixture window", depth: 1, parent_index: 0, enabled: true },
        { element_index: 9, element_token: "private-menubar-token", role: "AXMenuBar", label: null, depth: 0 },
        { element_index: 10, element_token: "private-apple-token", role: "AXMenuBarItem", label: "Apple", depth: 1, parent_index: 9 },
        { element_index: 11, element_token: "private-menu-token", role: "AXMenu", label: null, depth: 2, parent_index: 10 },
        { element_index: 12, element_token: "private-force-token", role: "AXMenuItem", label: "Force Quit Cua Lab Fixture", depth: 3, parent_index: 11 },
        { element_index: 84, element_token: "private-app-token", role: "AXMenuBarItem", label: "Cua Lab Fixture", depth: 1, parent_index: 9 },
        { element_index: 85, element_token: "private-app-menu-token", role: "AXMenu", label: null, depth: 2, parent_index: 84 },
        { element_index: 86, element_token: "private-quit-token", role: "AXMenuItem", label: "Quit Cua Lab Fixture", depth: 3, parent_index: 85 },
        { element_index: 87, element_token: "private-long-token", role: "AXStaticText", label: longLabel, depth: 1, parent_index: 0 },
      ],
    });
    const checked = port([
      installedApps([{ pid: 0, name: "Cua Lab Fixture", bundle_id: "dev.nautilo.cualabfixture", active: false, running: false }]),
      launchSuccess("dev.nautilo.cualabfixture", "Cua Lab Fixture"),
      queryState,
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "Cua Lab Fixture" } } });
    if (!launched.ok || launched.receipt.window === null) throw new Error("expected exact fixture window");

    const observed = await subject.observeWindowState({
      scope,
      target: launched.receipt.window,
      query: "fixture",
      effort: { maxElements: 8_000, maxDepth: 45 },
    });

    if (!observed.ok) throw new Error("expected semantic query observation");
    const publicObservation = windowStateObservationSchema.safeParse(observed.observation);
    if (!publicObservation.success) throw new Error(JSON.stringify(publicObservation.error.issues));
    expect(observed).toMatchObject({
      ok: true,
      observation: {
        completeness: "sufficient",
        semanticQuery: {
          query: "fixture", effort: { maxElements: 8_000, maxDepth: 45 }, exhaustive: false, matched: 7, returned: 7, omitted: 0,
          matches: [
            { role: "checkbox", label: "Enable fixture", value: "0", labelTruncated: false, valueTruncated: false },
            { role: "slider", label: "Fixture level", value: "25" },
            { role: "button", label: "New fixture window" },
            { role: "menu_item", label: "Force Quit Cua Lab Fixture" },
            { role: "menu_bar_item", label: "Cua Lab Fixture" },
            { role: "menu_item", label: "Quit Cua Lab Fixture" },
            { role: "text", label: expect.stringContaining("fixture semantic tail"), labelTruncated: true },
          ],
        },
      },
    });
    expect(checked.calls.at(-1)).toEqual({
      name: "get_window_state",
      args: { pid: 77, window_id: 500, include_screenshot: false, max_elements: 8_000, max_depth: 45 },
    });
    const projectedLongMatch = publicObservation.data.semanticQuery?.matches.find((match) => match.labelTruncated);
    expect(Array.from(projectedLongMatch?.label ?? "")).toHaveLength(240);
    expect(projectedLongMatch?.label?.toLocaleLowerCase()).toContain("fixture semantic tail");
    // Opaque capability references are random and may legitimately contain
    // the byte pair "AX". Check only the semantic projection for provider
    // vocabulary or private tree fields.
    expect(JSON.stringify(observed.observation.semanticQuery)).not.toMatch(/AX|element_index|element_token|parent_index|private|Apple/);
  });

  test("publishes query, control, and PNG from one exact window read with one traversal effort", async () => {
    const captured = await decodableWindowStateScreenshot(120, 80);
    const combinedState: CuaContextToolResult = {
      ...captured,
      structuredContent: {
        ...captured.structuredContent,
        element_count: 1,
        total_element_count: 1,
        returned_element_count: 1,
        tree_markdown: '- [0] AXButton "Needle action"\n- AXStaticText = "Needle detail"',
        elements: [{
          element_index: 0, element_token: "private-combined-token", role: "AXButton",
          label: "Needle action", enabled: true, depth: 0,
        }],
      },
    };
    const checked = port([
      installedApps([{ pid: 0, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: false, running: false }]),
      launchSuccess(),
      combinedState,
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!launched.ok || launched.receipt.window === null) throw new Error("expected exact window");

    const runtime = new CuaNativeContractRuntime({ adapter: subject, scopeForAuthority: () => scope });
    const host = new ComputerUseHost({ hostGeneration: "host-1", driverGeneration: "driver-1", handlers: runtime.handlers });
    const observed = await host.dispatch({
      kind: "request",
      protocol: { major: 3, minor: 0 },
      requestId: "combined-window-observe",
      authority: { authorityLeaseId: "lease-1", authorityGeneration: 1 },
      fence: { hostGeneration: "host-1", driverGeneration: "driver-1", cancellationGeneration: 1 },
      contract: COMPUTER_USE_NATIVE_CONTRACTS.observe,
      arguments: {
        operation: "window_state",
        target: launched.receipt.window,
        query: "Needle",
        selector: { role: "button", labelEquals: "Needle action" },
        capture: "window_snapshot",
        effort: { maxElements: 8_000, maxDepth: 45 },
      },
    });

    expect(observed).toMatchObject({
      settlement: "completed",
      result: {
        completeness: "sufficient",
        element: { selector: { role: "button" }, disposition: "unique", evidence: { role: "button", action: "click" } },
        windowSnapshot: { metadata: { dimensions: { width: 120, height: 80 } } },
        semanticQuery: {
          query: "Needle", effort: { maxElements: 8_000, maxDepth: 45 }, exhaustive: false,
          matched: 2, returned: 2, omitted: 0,
          matches: [{ role: "button", label: "Needle action" }, { role: "text", value: "Needle detail" }],
        },
      },
      attachment: { width: 120, height: 80, coordinateSpace: "window_snapshot_pixels" },
    });
    expect(windowStateObservationSchema.safeParse(observed.result).success).toBe(true);
    expect(host.takeAttachment("combined-window-observe")).not.toBeNull();
    expect(host.takeAttachment("combined-window-observe")).toBeNull();
    expect(checked.calls.filter((call) => call.name === "get_window_state")).toEqual([{
      name: "get_window_state",
      args: { pid: 77, window_id: 500, include_screenshot: true, max_elements: 8_000, max_depth: 45 },
    }]);
    expect(JSON.stringify(observed)).not.toMatch(/private-combined-token|AXButton|AXStaticText|element_token|tree_markdown/);
    await subject.close();
  });

  test("projects untokenized static text from Cua's bounded stable tree without exposing raw AX markup", async () => {
    const checked = port([
      installedApps([{ pid: 0, name: "Cua Lab Fixture", bundle_id: "dev.nautilo.cualabfixture", active: false, running: false }]),
      launchSuccess("dev.nautilo.cualabfixture", "Cua Lab Fixture"),
      result({
        window_id: 500, pid: 77,
        element_count: 0, total_element_count: 0, returned_element_count: 0,
        elements_complete: false,
        tree_markdown: '- AXStaticText = "toggle:off" (Fixture status)\n- AXStaticText = "unrelated"',
        elements: [], _note: "private note",
      }),
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "Cua Lab Fixture" } } });
    if (!launched.ok || launched.receipt.window === null) throw new Error("expected exact fixture window");

    const observed = await subject.observeWindowState({ scope, target: launched.receipt.window, query: "toggle:off" });
    expect(observed).toMatchObject({
      ok: true,
      observation: {
        semanticQuery: {
          query: "toggle:off", exhaustive: false, matched: 1, returned: 1, omitted: 0,
          matches: [{ role: "text", label: "Fixture status", value: "toggle:off" }],
        },
      },
    });
    if (!observed.ok) throw new Error("expected static-text query result");
    expect(windowStateObservationSchema.safeParse(observed.observation).success).toBe(true);
    expect(JSON.stringify(observed.observation.semanticQuery)).not.toMatch(/AXStaticText|tree_markdown|private|actions=/);
  });

  test("accounts for semantic-query omissions and never promotes zero matches into proof of absence", async () => {
    const manyMatches = Array.from({ length: 30 }, (_, index) => ({
      element_index: index,
      element_token: `private-${index}`,
      role: "AXStaticText",
      label: `Fixture result ${index + 1}`,
      depth: 1,
      parent_index: 99,
    }));
    const checked = port([
      installedApps([{ pid: 0, name: "Cua Lab Fixture", bundle_id: "dev.nautilo.cualabfixture", active: false, running: false }]),
      launchSuccess("dev.nautilo.cualabfixture", "Cua Lab Fixture"),
      result({
        window_id: 500, pid: 77,
        element_count: 92, total_element_count: 92, returned_element_count: 30, filtered_element_count: 30,
        elements_complete: false, tree_markdown: "private bounded tree", elements: manyMatches, _note: "private note",
      }),
      result({
        window_id: 500, pid: 77,
        element_count: 92, total_element_count: 92, returned_element_count: 0, filtered_element_count: 0,
        elements_complete: false, tree_markdown: "private empty tree", elements: [], _note: "private note",
      }),
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "Cua Lab Fixture" } } });
    if (!launched.ok || launched.receipt.window === null) throw new Error("expected exact fixture window");

    const complete = await subject.observeWindowState({ scope, target: launched.receipt.window, query: "Fixture" });
    expect(complete).toMatchObject({
      ok: true,
      observation: {
        semanticQuery: { query: "Fixture", exhaustive: false, matched: 30, returned: 30, omitted: 0 },
      },
    });
    if (!complete.ok) throw new Error("expected complete query observation");
    expect(complete.observation.semanticQuery?.matches).toHaveLength(30);
    expect(windowStateObservationSchema.safeParse(complete.observation).success).toBe(true);

    const absent = await subject.observeWindowState({ scope, target: launched.receipt.window, query: "missing sentinel" });
    expect(absent).toMatchObject({
      ok: true,
      observation: {
        semanticQuery: {
          query: "missing sentinel", exhaustive: false, matched: 0, returned: 0, omitted: 0, matches: [],
        },
      },
    });
    if (!absent.ok) throw new Error("expected non-exhaustive zero-match observation");
    expect(windowStateObservationSchema.safeParse(absent.observation).success).toBe(true);
  });

  test("keeps completion unknown and does not call Cua when cancelled before launch, or replay after cancellation at the boundary", async () => {
    const before = new AbortController();
    before.abort();
    const checked = port([]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const pre = await subject.launchApp({ scope, signal: before.signal, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    expect(pre.ok).toBe(false);
    expect(checked.calls).toEqual([]);

    const controller = new AbortController();
    const calls: string[] = [];
    const boundaryPort: CuaCheckedContextPort = {
      generation,
      callContextTool: async (_scope, name) => {
        calls.push(name);
        return { ok: true, generation, sessionId, result: installedApps([{ pid: 0, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: false, running: false }]) };
      },
      launchApplication: async () => {
        calls.push("launch_app"); controller.abort();
        return { ok: true, generation, sessionId, result: launchSuccess() };
      },
      getWindowState: unusedCheckedCall,
      captureDesktopState: async () => { throw new Error("unused"); }, clickDesktop: async () => { throw new Error("unused"); }, endContextLease: async () => undefined,
    };
    const post = await new CuaComputerUseAdapter({ port: boundaryPort }).launchApp({ scope, signal: controller.signal, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    expect(post.ok).toBe(false);
    expect(post.receipt.completionCertainty).toBe("unknown_completion");
    expect(post.outcome.recovery).toContain("do_not_replay");
    expect(calls).toEqual(["list_apps", "launch_app"]);
  });
  test("normalizes only opaque Cua app/window targets and exact-releases both observation leases", async () => {
    const checked = port([apps(), windows()]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const observed = await subject.observe({ scope, operation: "desktop_state" });
    expect(observed).toMatchObject({
      ok: true,
      observation: {
        completeness: "complete", discovered: 1, returned: 1, omitted: 0,
        targets: [{ target: { context: expect.stringMatching(/^dctx_/), reference: expect.stringMatching(/^dtgt_/) }, evidence: { kind: "window", appLabel: "Nautilo", windowLabel: "Connections" } }],
        applicationTargets: { discovered: 1, returned: 1, omitted: 0, targets: [{ target: { reference: expect.stringMatching(/^datgt_/) }, evidence: { kind: "app", appLabel: "Nautilo" } }] },
        screenSnapshot: {
          target: { context: expect.stringMatching(/^dctx_/), reference: expect.stringMatching(/^dsnap_/) },
          evidence: { kind: "screen" },
          metadata: {
            format: "png",
            nativeDimensions: { width: 1200, height: 800 },
            presentedDimensions: { width: 1200, height: 800 },
            display: { coordinateSpace: "desktop_pixels", origin: { x: 0, y: 0 } },
          },
        },
      },
      visionImage: { mime: "image/png", bytes: Uint8Array.from([137, 80, 78, 71]) },
    });
    if (!observed.ok) return;
    const publicTarget = observed.observation.targets[0]!;
    expect(Object.keys(publicTarget.target).sort()).toEqual(["context", "reference", "version"]);
    expect(Object.keys(publicTarget.evidence).sort()).toEqual(["appLabel", "bounds", "kind", "windowLabel"]);
    const publicApplication = observed.observation.applicationTargets.targets[0]!;
    expect(Object.keys(publicApplication.evidence).sort()).toEqual(["appLabel", "focused", "kind"]);
    expect(publicApplication.evidence).not.toHaveProperty("hidden");
    expect(checked.calls).toEqual([{ name: "list_apps", args: {} }, { name: "list_windows", args: {} }]);
    expect(checked.captureDesktopState).toHaveBeenCalledWith(scope, undefined);
    expect(checked.endContextLease).toHaveBeenCalledTimes(2);
    expect(checked.endContextLease).toHaveBeenNthCalledWith(1, scope, generation, sessionId);
    expect(checked.endContextLease).toHaveBeenNthCalledWith(2, scope, generation, sessionId);
  });

  test("retains one provider lease across a desktop observation and subsequent focus", async () => {
    const checked = port([apps(), windows(), apps(), windows(), focused()]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const observed = await subject.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected observation");
    expect(checked.leaseState.active).toBe(1);

    const focusedResult = await subject.focus({
      scope,
      operation: { kind: "focus", target: observed.observation.targets[0]!.target },
    });
    expect(focusedResult.ok).toBe(true);
    expect(checked.leaseState.active).toBe(1);
    expect(checked.endContextLease).toHaveBeenCalledTimes(5);
  });

  test("replaces a desktop context without a zero-reference provider gap", async () => {
    const checked = port([apps(), windows(), apps(), windows()]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const first = await subject.observe({ scope, operation: "desktop_state" });
    if (!first.ok) throw new Error("expected first observation");
    checked.leaseState.adopted = true;
    checked.leaseState.minimumAfterAdoption = checked.leaseState.active;

    const second = await subject.observe({ scope, operation: "desktop_state" });
    if (!second.ok) throw new Error("expected replacement observation");
    expect(second.observation.context).not.toBe(first.observation.context);
    expect(checked.leaseState.active).toBe(1);
    expect(checked.leaseState.minimumAfterAdoption).toBeGreaterThanOrEqual(1);
    await expect(subject.focus({
      scope,
      operation: { kind: "focus", target: first.observation.targets[0]!.target },
    })).resolves.toMatchObject({
      ok: false,
      receipt: { outcome: { phase: "resolve_target", targetCondition: "stale" } },
    });
  });

  test("does not adopt provider leases when launch or desktop observation fails", async () => {
    const failedLaunchPort = port([
      installedApps([{ pid: 0, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: false, running: false }]),
      result({ pid: 77, bundle_id: "com.apple.TextEdit", name: "TextEdit", windows: "malformed" }),
    ]);
    const launchSubject = new CuaComputerUseAdapter({ port: failedLaunchPort.value });
    await expect(launchSubject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } }))
      .resolves.toMatchObject({ ok: false });
    expect(failedLaunchPort.leaseState.active).toBe(0);

    const failedObservationPort = port([apps(), result({ windows: "malformed" })]);
    const observationSubject = new CuaComputerUseAdapter({ port: failedObservationPort.value });
    await expect(observationSubject.observe({ scope, operation: "desktop_state" }))
      .resolves.toMatchObject({ ok: false });
    expect(failedObservationPort.leaseState.active).toBe(0);
  });

  test("close fences the adapter and releases its last retained provider lease", async () => {
    const checked = port([apps(), windows()]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    await expect(subject.observe({ scope, operation: "desktop_state" })).resolves.toMatchObject({ ok: true });
    expect(checked.leaseState.active).toBe(1);
    await subject.close();
    expect(checked.leaseState.active).toBe(0);
    expect(checked.endContextLease).toHaveBeenCalledTimes(3);
    await expect(subject.observe({ scope, operation: "desktop_state" }))
      .resolves.toMatchObject({ ok: false });
  });

  test("does not expose desktop targets when the retained-lease expiry cannot be scheduled", async () => {
    const checked = port([apps(), windows()]);
    const registry = new ComputerUseContextRegistry({
      scheduleExpiry: () => { throw new Error("fixture scheduler unavailable"); },
    });
    const subject = new CuaComputerUseAdapter({ port: checked.value, registry });
    const observed = await subject.observe({ scope, operation: "desktop_state" });
    expect(observed).toMatchObject({
      ok: false,
      code: "context_fenced",
      outcome: { phase: "observe", targetCondition: "stale" },
    });
    expect(observed).not.toHaveProperty("observation");
    expect(checked.leaseState.active).toBe(0);
    expect(checked.endContextLease).toHaveBeenCalledTimes(3);
  });

  test("keeps launch completion unknown and releases every lease when retention scheduling fails", async () => {
    const checked = port([
      installedApps([{ pid: 0, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: false, running: false }]),
      launchSuccess(),
    ]);
    const registry = new ComputerUseContextRegistry({
      scheduleExpiry: () => { throw new Error("fixture scheduler unavailable"); },
    });
    const subject = new CuaComputerUseAdapter({ port: checked.value, registry });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    expect(launched).toMatchObject({
      ok: false,
      receipt: {
        completionCertainty: "unknown_completion",
        outcome: { retrySafety: "never", recovery: ["observe_again", "do_not_replay"] },
      },
    });
    if (!launched.ok) {
      expect(launched.receipt.app.target).toBeNull();
      expect(launched.receipt.window).toBeNull();
    }
    expect(checked.leaseState.active).toBe(0);
    expect(checked.endContextLease).toHaveBeenCalledTimes(2);
  });

  test("withholds an appeared-window handoff when successor lease retention cannot be scheduled", async () => {
    const existing = rawWindowRow({ windowId: 500, pid: 77, appName: "TextEdit", title: "Untitled 1", width: 800, height: 600, onScreen: true });
    const appeared = rawWindowRow({ windowId: 501, pid: 77, appName: "TextEdit", title: "Untitled 2", width: 800, height: 600, onScreen: true });
    const checked = port([
      installedApps([{ pid: 0, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: false, running: false }]),
      launchSuccess(),
      result({ windows: [existing], current_space_id: 1 }),
      result({ effect: "unverifiable", route: "accessibility", delivery: { mode: "foreground" } }),
      result({ windows: [existing, appeared], current_space_id: 1 }),
    ]);
    let rejectScheduling = false;
    const registry = new ComputerUseContextRegistry({
      scheduleExpiry: () => {
        if (rejectScheduling) throw new Error("fixture successor scheduler unavailable");
        return { cancel: () => undefined };
      },
    });
    const subject = new CuaComputerUseAdapter({
      port: checked.value,
      registry,
      readHidIdleNanoseconds: async () => 1_000_000_000,
      monotonicMilliseconds: () => 10_000,
    });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!launched.ok) throw new Error("expected retained launch context");
    rejectScheduling = true;

    const created = await subject.createWindow({
      scope,
      operation: { kind: "create_window", target: launched.receipt.app.target, menuPath: ["File", "New"] },
    });
    expect(created).toMatchObject({
      ok: false,
      receipt: {
        completionCertainty: "unknown_completion",
        postObservation: { kind: "appeared_window", disposition: "incomplete" },
        outcome: { retrySafety: "observe_before_retry", recovery: ["observe_again", "do_not_replay"] },
      },
    });
    if (!created.ok) {
      expect(created.receipt.postObservation).not.toHaveProperty("app");
      expect(created.receipt.postObservation).not.toHaveProperty("window");
    }
    expect(checked.leaseState.active).toBe(0);
    expect(checked.endContextLease).toHaveBeenCalledTimes(5);
  });

  test("keeps raw helper surfaces private in global desktop observation", async () => {
    const checked = port([
      result({ apps: [{ pid: 42, name: "Nautilo", bundle_id: "com.nautilo.desktop", active: true, running: true }] }),
      result({
        windows: [
          rawWindowRow({ windowId: 990, pid: 42, appName: "Nautilo", title: "", width: 500, height: 500, onScreen: false, located: false }),
          rawWindowRow({ windowId: 991, pid: 42, appName: "Nautilo", title: "Connections", width: 800, height: 600, onScreen: false }),
        ],
        current_space_id: 1,
      }),
    ]);
    const observed = await new CuaComputerUseAdapter({ port: checked.value }).observe({ scope, operation: "desktop_state" });
    expect(observed).toMatchObject({
      ok: true,
      observation: {
        discovered: 1,
        targets: [{ evidence: { kind: "window", windowLabel: "Connections", bounds: { width: 800, height: 600 } } }],
        applicationTargets: { discovered: 1, targets: [{ evidence: { kind: "app", appLabel: "Nautilo" } }] },
      },
    });
    expect(JSON.stringify(observed)).not.toContain("Untitled window");
  });

  test("joins app and WindowServer records by fresh PID without requiring display-label byte equality", async () => {
    const checked = port([
      result({ apps: [{
        pid: 768,
        name: "Proton VPN",
        bundle_id: "ch.protonvpn.mac",
        active: true,
        running: true,
      }] }),
      result({
        windows: [{
          window_id: 68,
          pid: 768,
          app_name: "ProtonVPN",
          title: "Proton VPN",
          bounds: { x: 26, y: 185, width: 340, height: 632 },
          layer: 0,
          z_index: 48,
          is_on_screen: false,
          current_space_id: 476,
          on_current_space: false,
          space_ids: [3],
        }],
        current_space_id: 476,
      }),
    ]);

    const observed = await new CuaComputerUseAdapter({ port: checked.value }).observe({
      scope,
      operation: "desktop_state",
    });

    expect(observed).toMatchObject({
      ok: true,
      observation: {
        applicationTargets: {
          targets: [{ evidence: { kind: "app", appLabel: "Proton VPN" } }],
        },
        targets: [{ evidence: { kind: "window", appLabel: "Proton VPN" } }],
      },
    });
    expect(JSON.stringify(observed)).not.toContain("ProtonVPN");
  });

  test("fences a crossed global snapshot click after retaining Cua's exact unverified ActionResult", async () => {
    const checked = port([apps(), windows()]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const observed = await subject.observe({ scope, operation: "desktop_state" });
    if (!observed.ok || observed.observation.screenSnapshot === undefined) throw new Error("expected snapshot");
    const clicked = await subject.click({
      scope,
      operation: {
        kind: "click",
        target: observed.observation.screenSnapshot.target,
        coordinateSpace: "presented_snapshot_pixels",
        x: 600,
        y: 400,
      },
    });
    expect(clicked).toMatchObject({
      ok: true,
      receipt: {
        action: "click",
        provider: "cua",
        deliveryMode: "not_applicable",
        completionCertainty: "completed",
        verification: "not_verified",
        providerAction: { effect: "unverifiable", route: "global_input", delivery: { mode: "not_applicable" } },
        outcome: { recovery: ["observe_again", "do_not_replay"] },
        resolvedTarget: { kind: "screen", bounds: { x: 0, y: 0, width: 1200, height: 800 } },
      },
    });
    if (!clicked.ok) throw new Error("global click delivery must remain available for fresh verification");
    expect(computerMutationReceiptSchema.safeParse(clicked.receipt).success).toBe(true);
    expect(checked.clickDesktop).toHaveBeenCalledWith(scope, 600, 400, undefined, {}, expect.any(Function));
    // The retained lifecycle lease survives; only this operation's lease ends.
    expect(checked.endContextLease).toHaveBeenCalledTimes(3);
    await expect(subject.click({
      scope,
      operation: {
        kind: "click", target: observed.observation.screenSnapshot.target,
        coordinateSpace: "presented_snapshot_pixels", x: 600, y: 400,
      },
    })).resolves.toMatchObject({
      ok: false,
      error: "This desktop reference is no longer available. Observe again before acting.",
    });
  });

  test("clicks one literal point in a fresh exact window snapshot and reports delivered-unverified", async () => {
    const checked = port([
      installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true, launch_path: null, kind: "application", last_used: null, windows: [] }]),
      launchSuccess(),
      windowStateScreenshot(1200, 800),
      result({ effect: "unverifiable", route: "accessibility", delivery: { mode: "background" } }),
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!launched.ok || launched.receipt.window === null) throw new Error("expected exact window");
    const observed = await subject.observeWindowState({ scope, target: launched.receipt.window, capture: "window_snapshot" });
    if (!observed.ok || observed.observation.windowSnapshot === undefined) throw new Error("expected exact window snapshot");

    const clicked = await subject.click({
      scope,
      operation: {
        kind: "click", target: observed.observation.windowSnapshot.target,
        coordinateSpace: "window_snapshot_pixels", x: 248, y: 776,
      },
    });
    expect(clicked).toMatchObject({
      ok: true,
      receipt: {
        action: "click", deliveryMode: "background", completionCertainty: "completed", verification: "not_verified",
        providerAction: { effect: "unverifiable", route: "accessibility", delivery: { mode: "background" } },
        resolvedTarget: { kind: "screen", bounds: { x: 0, y: 0, width: 1200, height: 800 } },
        outcome: { stateChangeCertainty: "unknown", recovery: ["observe_again", "do_not_replay"] },
      },
    });
    if (!clicked.ok) throw new Error("expected delivered window-local click");
    expect(computerMutationReceiptSchema.safeParse(clicked.receipt).success).toBe(true);
    expect(checked.calls.at(-1)).toEqual({
      name: "click", args: { pid: 77, window_id: 500, x: 248, y: 776, delivery_mode: "background" },
    });
    await expect(subject.click({
      scope,
      operation: {
        kind: "click", target: observed.observation.windowSnapshot.target,
        coordinateSpace: "window_snapshot_pixels", x: 248, y: 776,
      },
    })).resolves.toMatchObject({ ok: false, error: "This desktop reference is no longer available. Observe again before acting." });
  });

  test("preserves window pixel options and the actual foreground or background delivery receipt", async () => {
    for (const actualMode of ["foreground", "background"] as const) {
      const checked = port([
        installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true, launch_path: null, kind: "application", last_used: null, windows: [] }]),
        launchSuccess(), windowStateScreenshot(1200, 800),
        result({ effect: "unverifiable", route: "synthetic_events", delivery: { mode: actualMode } }),
      ]);
      const subject = new CuaComputerUseAdapter({ port: checked.value });
      const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
      if (!launched.ok || launched.receipt.window === null) throw new Error("expected window");
      const observed = await subject.observeWindowState({ scope, target: launched.receipt.window, capture: "window_snapshot" });
      if (!observed.ok || observed.observation.windowSnapshot === undefined) throw new Error("expected image");
      const operation = {
        kind: "click" as const, target: observed.observation.windowSnapshot.target,
        coordinateSpace: "window_snapshot_pixels" as const, x: 248, y: 776,
        button: "middle" as const, count: 3, modifiers: ["cmd", "shift"] as const, deliveryMode: "foreground" as const,
      };
      const clicked = await subject.click({ scope, operation });
      expect(clicked).toMatchObject({ ok: true, receipt: {
        deliveryMode: actualMode, completionCertainty: "completed", verification: "not_verified",
        outcome: { stateChangeCertainty: "unknown", recovery: ["observe_again", "do_not_replay"] },
      } });
      expect(computerMutationReceiptSchema.safeParse(clicked.receipt).success).toBe(true);
      expect(checked.calls.at(-1)).toEqual({ name: "click", args: {
        pid: 77, window_id: 500, x: 248, y: 776, delivery_mode: "foreground", button: "middle", count: 3, modifier: ["cmd", "shift"],
      } });
      await subject.click({ scope, operation });
      expect(checked.calls.filter((call) => call.name === "click")).toHaveLength(1);
    }
  });

  test("native snapshot actions recover on the same exact window and lease without replaying spent pixels", async () => {
    for (const kind of ["click", "scroll", "press_key", "type_text", "drag_drop"] as const) {
      const action = result({ effect: "unverifiable", route: "global_input", delivery: { mode: "foreground" } });
      const checked = port([
        installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true, launch_path: null, kind: "application", last_used: null, windows: [] }]),
        launchSuccess(), windowStateScreenshot(1200, 800), action, windowStateScreenshot(1400, 840), action,
      ]);
      const subject = new CuaComputerUseAdapter({ port: checked.value });
      const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
      if (!launched.ok || launched.receipt.window === null) throw new Error("expected exact window");
      const window = launched.receipt.window;
      const observed = await subject.observeWindowState({ scope, target: window, capture: "window_snapshot" });
      if (!observed.ok || observed.observation.windowSnapshot === undefined) throw new Error("expected snapshot");
      const target = observed.observation.windowSnapshot.target;
      const base = { target, coordinateSpace: "window_snapshot_pixels" as const, x: 100, y: 100, deliveryMode: "foreground" as const };
      const invoke = () => kind === "click" ? subject.click({ scope, operation: { ...base, kind } })
        : kind === "scroll" ? subject.scroll({ scope, operation: { ...base, kind, direction: "down", amount: 3, by: "page" } })
        : kind === "press_key" ? subject.pressKey({ scope, operation: { ...base, kind, key: "Return", modifiers: [] } })
        : kind === "type_text" ? subject.typeText({ scope, operation: { ...base, kind, text: "fixture" } })
        : subject.dragDrop({ scope, operation: { ...base, kind, from: { x: 100, y: 100 }, to: { x: 200, y: 200 } } });
      const changed = await invoke();
      expect(changed.receipt.providerAction?.effect).toBe("unverifiable");
      expect(computerMutationReceiptSchema.safeParse(changed.receipt).success).toBe(true);
      expect((await invoke()).ok).toBe(false);
      expect(checked.calls).toHaveLength(4);
      const fresh = await subject.observeWindowState({ scope, target: window, capture: "window_snapshot" });
      expect(fresh).toMatchObject({ ok: true, observation: { evidence: { bounds: { x: 10, y: 20, width: 700, height: 420 } } } });
      if (!fresh.ok || fresh.observation.windowSnapshot === undefined) throw new Error("expected targeted recovery");
      expect(fresh.observation.windowSnapshot.target.reference).not.toBe(target.reference);
      expect(subject.registry.resolveTarget(window.context, scope, window.reference)).toMatchObject({ ok: true, data: { evidence: { bounds: { width: 700, height: 420 } } } });
      expect(checked.leaseState.active).toBe(1);
      expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
      const next = await subject.click({ scope, operation: { ...base, kind: "click", target: fresh.observation.windowSnapshot.target } });
      expect(next.ok).toBe(true);
      expect(checked.calls).toHaveLength(6);
      await subject.close();
      expect(checked.leaseState.active).toBe(0);
    }
  });

  test("preserves a confirmed pixel selection receipt instead of declaring valid Cua evidence malformed", async () => {
    const checked = port([
      installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true, launch_path: null, kind: "application", last_used: null, windows: [] }]),
      launchSuccess(), windowStateScreenshot(1200, 800),
      result({ effect: "confirmed", route: "synthetic_events", delivery: { mode: "foreground" }, evidence: [{ kind: "value_readback" }] }),
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!launched.ok || launched.receipt.window === null) throw new Error("expected window");
    const observed = await subject.observeWindowState({ scope, target: launched.receipt.window, capture: "window_snapshot" });
    if (!observed.ok || observed.observation.windowSnapshot === undefined) throw new Error("expected snapshot");
    const clicked = await subject.click({ scope, operation: {
      kind: "click", target: observed.observation.windowSnapshot.target, coordinateSpace: "window_snapshot_pixels", x: 100, y: 100, deliveryMode: "foreground",
    } });
    expect(clicked).toMatchObject({ ok: true, receipt: { completionCertainty: "completed", verification: "verified", providerAction: { effect: "confirmed", evidenceKinds: ["value_readback"] } } });
    expect(computerMutationReceiptSchema.safeParse(clicked.receipt).success).toBe(true);
    expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
    await subject.close();
  });

  test("lost snapshot completion still destroys mutation and observation authority without replay", async () => {
    const checked = port([
      installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true, launch_path: null, kind: "application", last_used: null, windows: [] }]),
      launchSuccess(), windowStateScreenshot(1200, 800), result(null, true),
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!launched.ok || launched.receipt.window === null) throw new Error("expected window");
    const observed = await subject.observeWindowState({ scope, target: launched.receipt.window, capture: "window_snapshot" });
    if (!observed.ok || observed.observation.windowSnapshot === undefined) throw new Error("expected snapshot");
    const clicked = await subject.click({ scope, operation: {
      kind: "click", target: observed.observation.windowSnapshot.target, coordinateSpace: "window_snapshot_pixels", x: 100, y: 100, deliveryMode: "foreground",
    } });
    expect(clicked).toMatchObject({ ok: false, receipt: { completionCertainty: "unknown_completion", outcome: { recovery: ["observe_again", "do_not_replay"] } } });
    expect((await subject.observeWindowState({ scope, target: launched.receipt.window })).ok).toBe(false);
    expect(checked.calls).toHaveLength(4);
    await subject.close();
    expect(checked.leaseState.active).toBe(0);
  });

  test("forwards desktop snapshot pointer options without changing coordinates", async () => {
    const checked = port([apps(), windows()]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const observed = await subject.observe({ scope, operation: "desktop_state" });
    if (!observed.ok || observed.observation.screenSnapshot === undefined) throw new Error("expected desktop image");
    const clicked = await subject.click({ scope, operation: {
      kind: "click", target: observed.observation.screenSnapshot.target, coordinateSpace: "presented_snapshot_pixels",
      x: 100, y: 200, button: "right", count: 2, modifiers: ["ctrl"], deliveryMode: "foreground",
    } });
    expect(clicked).toMatchObject({ ok: true, receipt: { verification: "not_verified" } });
    expect(checked.clickDesktop).toHaveBeenCalledWith(scope, 100, 200, undefined, { button: "right", count: 2, modifiers: ["ctrl"] }, expect.any(Function));
  });

  test("rejects an explicit desktop-background posture before input without withdrawing Cua", async () => {
    const checked = port([apps(), windows()]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const observed = await subject.observe({ scope, operation: "desktop_state" });
    if (!observed.ok || observed.observation.screenSnapshot === undefined) throw new Error("expected desktop image");
    const clicked = await subject.click({ scope, operation: {
      kind: "click", target: observed.observation.screenSnapshot.target, coordinateSpace: "presented_snapshot_pixels",
      x: 100, y: 200, deliveryMode: "background",
    } });
    expect(clicked).toMatchObject({ ok: false, receipt: {
      completionCertainty: "not_completed", deliveryMode: "not_delivered", outcome: { stateChangeCertainty: "not_changed", providerCondition: "ready" },
    } });
    expect(checked.clickDesktop).not.toHaveBeenCalled();
    expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
    expect(computerMutationReceiptSchema.safeParse(clicked.receipt).success).toBe(true);
  });

  test("retains independently observed window images and crops only the selected window", async () => {
    const firstImage = await decodableWindowStateScreenshot(120, 80);
    const secondImage = await decodableWindowStateScreenshot(160, 100);
    const checked = port([firstImage, {
      ...secondImage, structuredContent: { ...secondImage.structuredContent, window_id: 501 },
    }]);
    const registry = new ComputerUseContextRegistry();
    const created = registry.create(scope);
    if (!created.ok) throw new Error("expected context");
    const registered = registry.registerTargets(created.data.context, scope, [500, 501].map((windowId) => ({
      evidence: { kind: "window" as const, appLabel: "TextEdit" },
      providerTarget: { provider: "cua" as const, operation: "focus" as const, app: "TextEdit", pid: 77, windowId },
    })));
    if (!registered.ok) throw new Error("expected window targets");
    const subject = new CuaComputerUseAdapter({ port: checked.value, registry });
    const [first, second] = await Promise.all(registered.data.map((window) => subject.observeWindowState({
      scope, target: { version: 1, context: created.data.context, reference: window.reference }, capture: "window_snapshot",
    })));
    if (!first?.ok || first.observation.windowSnapshot === undefined || !first.visionImage
      || !second?.ok || second.observation.windowSnapshot === undefined || !second.visionImage) throw new Error("expected both images");
    const firstTarget = first.observation.windowSnapshot.target;
    const secondTarget = second.observation.windowSnapshot.target;
    expect(registry.resolveScreenSnapshot(firstTarget.context, scope, firstTarget.reference).ok).toBe(true);
    expect(registry.resolveScreenSnapshot(secondTarget.context, scope, secondTarget.reference).ok).toBe(true);
    expect(first.observation.windowSnapshot.metadata.dimensions).toEqual({ width: 120, height: 80 });
    expect(second.observation.windowSnapshot.metadata.dimensions).toEqual({ width: 160, height: 100 });
    const cropped = await subject.observeWindowRegion({
      scope, target: firstTarget, coordinateSpace: "window_snapshot_pixels", region: { x: 20, y: 10, width: 30, height: 20 },
    });
    if (!cropped.ok) throw new Error(cropped.error);
    expect(registry.resolveScreenSnapshot(firstTarget.context, scope, firstTarget.reference).ok).toBe(false);
    const retainedSecond = registry.resolveScreenSnapshot(secondTarget.context, scope, secondTarget.reference);
    if (!retainedSecond.ok) throw new Error("other image must survive");
    expect(retainedSecond.data.pngBytes).toEqual(Buffer.from(second.visionImage.bytes));
    expect(cropped.observation.regionSnapshot.metadata.dimensions).toEqual({ width: 30, height: 20 });
    expect(checked.calls).toEqual([500, 501].map((windowId) => ({
      name: "get_window_state", args: { pid: 77, window_id: windowId, include_screenshot: true },
    })));
    retainedSecond.data.pngBytes.fill(0);
    await subject.close();
  });

  test("withholds a precision image when cancellation arrives during its final human-input check", async () => {
    const checked = port([
      installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true }]),
      launchSuccess(),
      await decodableWindowStateScreenshot(120, 80),
    ]);
    const controller = new AbortController();
    let cropReads = 0;
    let cropping = false;
    const subject = new CuaComputerUseAdapter({
      port: checked.value,
      monotonicMilliseconds: () => 10_000,
      readHidIdleNanoseconds: async () => {
        if (cropping && ++cropReads === 2) controller.abort();
        return 1_000_000_000;
      },
    });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!launched.ok || launched.receipt.window === null) throw new Error("expected exact window");
    const observed = await subject.observeWindowState({ scope, target: launched.receipt.window, capture: "window_snapshot" });
    if (!observed.ok || observed.observation.windowSnapshot === undefined) throw new Error("expected snapshot");
    const target = observed.observation.windowSnapshot.target;
    const register = mock(subject.registry.registerWindowRegionSnapshot.bind(subject.registry));
    subject.registry.registerWindowRegionSnapshot = register;
    cropping = true;
    const cropped = await subject.observeWindowRegion({
      scope, target, coordinateSpace: "window_snapshot_pixels", region: { x: 0, y: 0, width: 20, height: 10 },
      signal: controller.signal,
    });
    expect(cropped).toMatchObject({ ok: false, outcome: { providerCondition: "cancelled" } });
    expect(cropped).not.toHaveProperty("visionImage");
    expect(register).not.toHaveBeenCalled();
    expect(subject.registry.resolveScreenSnapshot(target.context, scope, target.reference).ok).toBe(true);
    expect(checked.calls).toHaveLength(3);
    await subject.close();
  });

  test("zeroes an unpublished precision image if capability registration throws", async () => {
    const checked = port([
      installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true }]),
      launchSuccess(),
      await decodableWindowStateScreenshot(120, 80),
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!launched.ok || launched.receipt.window === null) throw new Error("expected exact window");
    const observed = await subject.observeWindowState({ scope, target: launched.receipt.window, capture: "window_snapshot" });
    if (!observed.ok || observed.observation.windowSnapshot === undefined) throw new Error("expected snapshot");
    const target = observed.observation.windowSnapshot.target;
    const unpublished: Uint8Array[] = [];
    subject.registry.registerWindowRegionSnapshot = (_context, _scope, _reference, image) => {
      unpublished.push(image.pngBytes);
      throw new Error("injected capability mint failure");
    };
    await expect(subject.observeWindowRegion({
      scope, target, coordinateSpace: "window_snapshot_pixels", region: { x: 0, y: 0, width: 20, height: 10 },
    })).rejects.toThrow("injected capability mint failure");
    expect(unpublished).toHaveLength(1);
    expect(unpublished[0]!.byteLength).toBeGreaterThan(0);
    expect(unpublished[0]!.every((byte) => byte === 0)).toBe(true);
    expect(subject.registry.resolveScreenSnapshot(target.context, scope, target.reference).ok).toBe(true);
    await subject.close();
  });

  test("crops a one-shot precision view and translates nested region pixels back to the exact Cua window", async () => {
    const checked = port([
      installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true, launch_path: null, kind: "application", last_used: null, windows: [] }]),
      launchSuccess(),
      await decodableWindowStateScreenshot(120, 80),
      result({ effect: "unverifiable", route: "synthetic_events", delivery: { mode: "background" } }),
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!launched.ok || launched.receipt.window === null) throw new Error("expected exact window");
    const observed = await subject.observeWindowState({ scope, target: launched.receipt.window, capture: "window_snapshot" });
    if (!observed.ok || observed.observation.windowSnapshot === undefined) throw new Error("expected exact window snapshot");

    const first = await subject.observeWindowRegion({
      scope,
      target: observed.observation.windowSnapshot.target,
      coordinateSpace: "window_snapshot_pixels",
      region: { x: 20, y: 10, width: 60, height: 50 },
    });
    if (!first.ok) throw new Error(first.error);
    expect(windowRegionObservationSchema.safeParse(first.observation).success).toBe(true);
    expect(first.observation).toMatchObject({
      operation: "window_region",
      regionSnapshot: { metadata: { dimensions: { width: 60, height: 50 }, coordinateSpace: "presented_snapshot_pixels" } },
      outcome: { retrySafety: "never", recovery: [] },
    });
    const firstImage = await Jimp.read(Buffer.from(first.visionImage.bytes));
    expect({ width: firstImage.bitmap.width, height: firstImage.bitmap.height }).toEqual({ width: 60, height: 50 });
    expect(subject.registry.resolveScreenSnapshot(
      observed.observation.windowSnapshot.target.context,
      scope,
      observed.observation.windowSnapshot.target.reference,
    )).toEqual({ ok: false, code: "not_found" });

    const nested = await subject.observeWindowRegion({
      scope,
      target: first.observation.regionSnapshot.target,
      coordinateSpace: "presented_snapshot_pixels",
      region: { x: 5, y: 6, width: 20, height: 10 },
    });
    if (!nested.ok) throw new Error(nested.error);
    expect(nested.observation.regionSnapshot.metadata.dimensions).toEqual({ width: 20, height: 10 });
    expect(subject.registry.resolveScreenSnapshot(
      first.observation.regionSnapshot.target.context,
      scope,
      first.observation.regionSnapshot.target.reference,
    )).toEqual({ ok: false, code: "not_found" });

    const clicked = await subject.click({
      scope,
      operation: {
        kind: "click",
        target: nested.observation.regionSnapshot.target,
        coordinateSpace: "presented_snapshot_pixels",
        x: 2,
        y: 3,
        button: "right",
        count: 1,
        deliveryMode: "background",
      },
    });
    expect(clicked).toMatchObject({ ok: true, receipt: { completionCertainty: "completed", verification: "not_verified" } });
    expect(checked.calls.at(-1)).toEqual({
      name: "click",
      args: { pid: 77, window_id: 500, x: 27, y: 19, delivery_mode: "background", button: "right", count: 1 },
    });
  });

  test("rejects mismatched or out-of-bounds precision regions without replacing the parent snapshot", async () => {
    const checked = port([
      installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true, launch_path: null, kind: "application", last_used: null, windows: [] }]),
      launchSuccess(),
      await decodableWindowStateScreenshot(120, 80),
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!launched.ok || launched.receipt.window === null) throw new Error("expected exact window");
    const observed = await subject.observeWindowState({ scope, target: launched.receipt.window, capture: "window_snapshot" });
    if (!observed.ok || observed.observation.windowSnapshot === undefined) throw new Error("expected exact window snapshot");
    const target = observed.observation.windowSnapshot.target;

    await expect(subject.observeWindowRegion({
      scope, target, coordinateSpace: "presented_snapshot_pixels", region: { x: 0, y: 0, width: 20, height: 10 },
    })).resolves.toMatchObject({ ok: false, error: "The requested precision region is outside this exact snapshot." });
    await expect(subject.observeWindowRegion({
      scope, target, coordinateSpace: "window_snapshot_pixels", region: { x: 119, y: 79, width: 2, height: 2 },
    })).resolves.toMatchObject({ ok: false, error: "The requested precision region is outside this exact snapshot." });
    expect(subject.registry.resolveScreenSnapshot(target.context, scope, target.reference).ok).toBe(true);
    expect(checked.calls).toHaveLength(3);
  });

  test("translates precision-region text, key, and scroll points through the same private mapping", async () => {
    const run = async (kind: "type_text" | "press_key" | "hotkey" | "scroll") => {
      const text = "region sentinel";
      const actionResult = kind === "type_text"
        ? result({ effect: "confirmed", route: "accessibility", delivery: { mode: "background", delivered_count: [...text].length }, evidence: [{ kind: "value_readback" }] })
        : result({ effect: "unverifiable", route: "synthetic_events", delivery: { mode: "background" } });
      const checked = port([
        installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true, launch_path: null, kind: "application", last_used: null, windows: [] }]),
        launchSuccess(),
        await decodableWindowStateScreenshot(120, 80),
        actionResult,
      ]);
      const subject = new CuaComputerUseAdapter({ port: checked.value });
      const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
      if (!launched.ok || launched.receipt.window === null) throw new Error("expected exact window");
      const observed = await subject.observeWindowState({ scope, target: launched.receipt.window, capture: "window_snapshot" });
      if (!observed.ok || observed.observation.windowSnapshot === undefined) throw new Error("expected exact window snapshot");
      const precision = await subject.observeWindowRegion({
        scope,
        target: observed.observation.windowSnapshot.target,
        coordinateSpace: "window_snapshot_pixels",
        region: { x: 20, y: 10, width: 60, height: 50 },
      });
      if (!precision.ok) throw new Error(precision.error);
      const target = precision.observation.regionSnapshot.target;
      if (kind === "type_text") {
        await subject.typeText({ scope, operation: { kind, target, coordinateSpace: "presented_snapshot_pixels", x: 2, y: 3, text } });
      } else if (kind === "press_key") {
        await subject.pressKey({ scope, operation: { kind, target, coordinateSpace: "presented_snapshot_pixels", x: 2, y: 3, key: "return", modifiers: ["shift"] } });
      } else if (kind === "hotkey") {
        const performed = await subject.hotkey({ scope, operation: { kind, target, coordinateSpace: "presented_snapshot_pixels", x: 2, y: 3, keys: ["cmd", "s"] } });
        expect(computerMutationReceiptSchema.safeParse(performed.receipt).success).toBe(true);
        const count = checked.calls.length;
        await subject.hotkey({ scope, operation: { kind, target, coordinateSpace: "presented_snapshot_pixels", x: 2, y: 3, keys: ["cmd", "s"] } });
        expect(checked.calls).toHaveLength(count);
      } else {
        await subject.scroll({ scope, operation: { kind, target, coordinateSpace: "presented_snapshot_pixels", x: 2, y: 3, direction: "down", amount: 4, by: "line" } });
      }
      return checked.calls.at(-1);
    };

    await expect(run("type_text")).resolves.toEqual({
      name: "type_text",
      args: { pid: 77, window_id: 500, x: 22, y: 13, text: "region sentinel", delivery_mode: "background" },
    });
    await expect(run("press_key")).resolves.toEqual({
      name: "press_key",
      args: { pid: 77, window_id: 500, x: 22, y: 13, key: "return", modifiers: ["shift"], delivery_mode: "background" },
    });
    await expect(run("hotkey")).resolves.toEqual({
      name: "hotkey", args: { pid: 77, window_id: 500, x: 22, y: 13, keys: ["cmd", "s"], delivery_mode: "background" },
    });
    await expect(run("scroll")).resolves.toEqual({
      name: "scroll",
      args: { pid: 77, window_id: 500, x: 22, y: 13, direction: "down", amount: 4, by: "line", delivery_mode: "background" },
    });
  });

  test("carries foreground and desktop wheel input with exact frames and actual delivery truth", async () => {
    for (const surface of ["window", "desktop"] as const) {
      const mode = surface === "desktop" ? "not_applicable" : "foreground";
      const captured = windowStateScreenshot(1200, 800);
      const checked = port([apps(), windows(),
        ...(surface === "window" ? [{ ...captured, structuredContent: { ...captured.structuredContent, pid: 42, window_id: 90 } }] : []),
        result({ effect: "unverifiable", route: "global_input", delivery: { mode } }),
      ]);
      const subject = new CuaComputerUseAdapter({ port: checked.value });
      const desktop = await subject.observe({ scope, operation: "desktop_state" });
      if (!desktop.ok) throw new Error("expected desktop");
      const window = surface === "window" ? await subject.observeWindowState({ scope, target: desktop.observation.targets[0]!.target, capture: "window_snapshot" }) : null;
      if (surface === "window" && !window?.ok) throw new Error(JSON.stringify(window));
      const target = window?.ok ? window.observation.windowSnapshot!.target : desktop.observation.screenSnapshot!.target;
      const operation = { kind: "scroll" as const, target, coordinateSpace: surface === "window" ? "window_snapshot_pixels" as const : "presented_snapshot_pixels" as const,
        x: 120, y: 80, direction: "left" as const, by: "page" as const, amount: 50, deliveryMode: "foreground" as const };
      const scrolled = await subject.scroll({ scope, operation });
      expect(scrolled).toMatchObject({ receipt: { deliveryMode: mode, providerAction: { route: "global_input" }, outcome: { providerCondition: "ready" } } });
      expect(computerMutationReceiptSchema.safeParse(scrolled.receipt).success).toBe(true);
      expect(checked.calls.at(-1)).toEqual({ name: "scroll", args: {
        ...(surface === "window" ? { pid: 42, window_id: 90, delivery_mode: "foreground" } : { scope: "desktop" }),
        x: 120, y: 80, direction: "left", by: "page", amount: 50,
      } });
      await subject.scroll({ scope, operation });
      expect(checked.dispatched.filter((call) => call.name === "scroll")).toHaveLength(1);
      expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
    }
  });

  test("dispatches explicit desktop text and shortcuts once without inventing point focus or losing readiness", async () => {
    for (const kind of ["type_text", "press_key"] as const) {
      const checked = port([apps(), windows(), result({ effect: "unverifiable", route: "global_input", delivery: { mode: "not_applicable" } })]);
      const subject = new CuaComputerUseAdapter({ port: checked.value });
      const observed = await subject.observe({ scope, operation: "desktop_state" });
      if (!observed.ok) throw new Error("expected desktop");
      const target = observed.observation.screenSnapshot!.target;
      const perform = () => kind === "type_text"
        ? subject.typeText({ scope, operation: { kind, scope: "desktop", target, text: "private input", delayMs: 0 } })
        : subject.pressKey({ scope, operation: { kind, scope: "desktop", target, key: "TAB", modifiers: ["command"] } });
      const performed = await perform();
      expect(performed).toMatchObject({ receipt: { deliveryMode: "not_applicable", verification: "not_verified", outcome: { providerCondition: "ready" } } });
      expect(computerMutationReceiptSchema.safeParse(performed.receipt).success).toBe(true);
      expect(checked.dispatched.at(-1)).toEqual({ name: kind, args: kind === "type_text"
        ? { scope: "desktop", text: "private input", delay_ms: 0 }
        : { scope: "desktop", key: "tab", modifiers: ["cmd"] } });
      expect(JSON.stringify(performed)).not.toContain("private input");
      await perform();
      expect(checked.dispatched.filter((call) => call.name === kind)).toHaveLength(1);
      expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
    }
  });

  test("exposes synthesis chunk guidance through the full Host for window, pixel and desktop typing", async () => {
    for (const route of ["window", "pixel", "desktop"] as const) {
      const text = "x".repeat(565);
      // Pinned macOS Unicode synthesis: (8 + delay200) per character,
      // plus a 2000ms drain, within Cua's 100000ms per-call budget.
      const refusal = result({
        code: "type_text_synthesis_budget_exceeded", path: route === "desktop" ? "hid" : "key_events_fg", effect: "refused",
        requested_chars: 565, estimated_duration_ms: 119520, synthesis_budget_ms: 100000,
        per_character_ms: 208, max_chunk_chars: 471, synthesized_chars: 0,
        atomic_ax_effect: "not_attempted", retryable: true, delivered_chars: 0, retry_from_character: 0,
        escalation: { recommended: "chunk", reason: "synthesis budget exceeded" },
      }, true);
      const appInventory = installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true, launch_path: null, kind: "application", last_used: null, windows: [] }]);
      const checked = port(route === "desktop" ? [apps(), windows(), refusal]
        : route === "pixel" ? [appInventory, launchSuccess(), windowStateScreenshot(1200, 800), refusal]
          : [appInventory, launchSuccess(), appInventory, listedWindows(77, "TextEdit", 1), refusal]);
      const adapter = new CuaComputerUseAdapter({ port: checked.value });
      const operation = await (async () => {
        if (route === "desktop") {
          const observed = await adapter.observe({ scope, operation: "desktop_state" });
          if (!observed.ok || !observed.observation.screenSnapshot) throw new Error("expected desktop snapshot");
          return { kind: "type_text" as const, scope: "desktop" as const, target: observed.observation.screenSnapshot.target, text, delayMs: 200 };
        }
        const launched = await adapter.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
        if (!launched.ok || !launched.receipt.window) throw new Error("expected window");
        if (route === "window") return { kind: "type_text" as const, target: launched.receipt.window, text, delayMs: 200, deliveryMode: "foreground" as const };
        const observed = await adapter.observeWindowState({ scope, target: launched.receipt.window, capture: "window_snapshot" });
        if (!observed.ok || !observed.observation.windowSnapshot) throw new Error("expected window snapshot");
        return { kind: "type_text" as const, target: observed.observation.windowSnapshot.target,
          coordinateSpace: "window_snapshot_pixels" as const, x: 360, y: 274, text, delayMs: 200, deliveryMode: "foreground" as const };
      })();
      const native = new CuaNativeContractRuntime({ adapter, scopeForAuthority: () => scope });
      const host = new ComputerUseHost({ hostGeneration: "host-1", driverGeneration: "driver-1", handlers: native.handlers });
      const response = await host.dispatch({ kind: "request", protocol: { major: 3, minor: 0 }, requestId: `chunk-${route}`,
        authority: { authorityLeaseId: "lease-1", authorityGeneration: 1 },
        fence: { hostGeneration: "host-1", driverGeneration: "driver-1", cancellationGeneration: 1 },
        contract: COMPUTER_USE_NATIVE_CONTRACTS.do, arguments: { operation } });
      expect(response).toMatchObject({ settlement: "not_completed", result: {
        completionCertainty: "not_completed", deliveryMode: "not_delivered", verification: "unavailable",
        textDelivery: { requestedCharacters: 565, deliveredCharacters: 0, maxChunkCharacters: 471 },
        unexecutedRemainder: { count: 565, reason: "failed" },
        outcome: { phase: "pre_effect_dispatch", providerCondition: "ready", stateChangeCertainty: "not_changed", recovery: [] },
      } });
      expect(checked.dispatched.filter(call => call.name === "type_text")).toHaveLength(1);
      expect(checked.dispatched.at(-1)?.args).toMatchObject({ text, delay_ms: 200 });
      expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
      expect(JSON.stringify(response)).not.toContain(text);
    }
  });

  test("recognizes the pinned desktop synthesis refusal as zero input, not malformed provider", async () => {
    const checked = port([apps(), windows(), result({
      code: "type_text_synthesis_budget_exceeded", path: "hid", effect: "refused",
      requested_chars: 12, estimated_duration_ms: 120_000, synthesis_budget_ms: 100_000,
      per_character_ms: 10_000, max_chunk_chars: 4, synthesized_chars: 0,
      atomic_ax_effect: "not_attempted", retryable: true, delivered_chars: 0, retry_from_character: 0,
      escalation: { recommended: "chunk", reason: "bounded fixture" },
    }, true)]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const observed = await subject.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected desktop");
    const performed = await subject.typeText({ scope, operation: { kind: "type_text", scope: "desktop", target: observed.observation.screenSnapshot!.target, text: "abcdefghijkl" } });
    expect(performed).toMatchObject({ receipt: { completionCertainty: "not_completed", textDelivery: { deliveredCharacters: 0, maxChunkCharacters: 4 }, outcome: { providerCondition: "ready" } } });
    expect(computerMutationReceiptSchema.safeParse(performed.receipt).success).toBe(true);
    expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
  });

  test("moves the real desktop pointer once and requires fresh observation to establish hover effects", async () => {
    const checked = port([apps(), windows(), result({ effect: "unverifiable", route: "global_input", delivery: { mode: "not_applicable" } })]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const observed = await subject.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected desktop");
    const operation = { kind: "move_pointer", scope: "desktop", target: observed.observation.screenSnapshot!.target, coordinateSpace: "presented_snapshot_pixels", x: 12, y: 24 } as const;
    const moved = await subject.movePointer({ scope, operation });
    expect(moved).toMatchObject({ ok: true, receipt: { action: "move_pointer", completionCertainty: "completed", verification: "not_verified", deliveryMode: "not_applicable", outcome: { providerCondition: "ready", stateChangeCertainty: "unknown" } } });
    expect(computerMutationReceiptSchema.safeParse(moved.receipt).success).toBe(true);
    expect(checked.dispatched.at(-1)).toEqual({ name: "move_cursor", args: { scope: "desktop", x: 12, y: 24 } });
    await subject.movePointer({ scope, operation });
    expect(checked.dispatched.filter((call) => call.name === "move_cursor")).toHaveLength(1);
    expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
  });

  test("rechecks human takeover after desktop input setup, before any key, text or pointer event", async () => {
    for (const kind of ["type_text", "press_key", "hotkey", "move_pointer"] as const) {
      const providerName = kind === "move_pointer" ? "move_cursor" : kind;
      const checked = port([apps(), windows()]);
      const subject = new CuaComputerUseAdapter({ port: checked.value, monotonicMilliseconds: () => 10_000,
        readHidIdleNanoseconds: async () => checked.calls.some((call) => call.name === providerName) ? 0 : 1_000_000_000 });
      const observed = await subject.observe({ scope, operation: "desktop_state" });
      if (!observed.ok) throw new Error("expected desktop");
      const target = observed.observation.screenSnapshot!.target;
      const performed = kind === "type_text" ? await subject.typeText({ scope, operation: { kind, scope: "desktop", target, text: "no input" } })
        : kind === "press_key" ? await subject.pressKey({ scope, operation: { kind, scope: "desktop", target, key: "tab", modifiers: [] } })
        : kind === "hotkey" ? await subject.hotkey({ scope, operation: { kind, scope: "desktop", target, keys: ["cmd", "s"] } })
        : await subject.movePointer({ scope, operation: { kind, scope: "desktop", target, coordinateSpace: "presented_snapshot_pixels", x: 12, y: 24 } });
      expect(performed).toMatchObject({ ok: false, receipt: { completionCertainty: "not_completed", outcome: { stateChangeCertainty: "not_changed", externalInterference: "user_input" } } });
      expect(checked.dispatched.filter((call) => call.name === providerName)).toHaveLength(0);
      expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
    }
  });

  test("desktop input refuses a window snapshot, invalid pointer geometry, cancellation, and takeover before dispatch", async () => {
    for (const condition of ["window_snapshot", "outside", "cancelled", "takeover"] as const) {
      const captured = windowStateScreenshot();
      const checked = port([apps(), windows(), { ...captured, structuredContent: { ...captured.structuredContent, pid: 42, window_id: 90 } }]);
      let changed = false;
      const subject = new CuaComputerUseAdapter({ port: checked.value, monotonicMilliseconds: () => 10_000,
        readHidIdleNanoseconds: async () => changed ? 0 : 1_000_000_000 });
      const observed = await subject.observe({ scope, operation: "desktop_state" });
      if (!observed.ok) throw new Error("expected desktop");
      const window = condition === "window_snapshot" ? await subject.observeWindowState({ scope, target: observed.observation.targets[0]!.target, capture: "window_snapshot" }) : null;
      const target = window?.ok ? window.observation.windowSnapshot!.target : observed.observation.screenSnapshot!.target;
      changed = condition === "takeover";
      const aborted = new AbortController();
      if (condition === "cancelled") aborted.abort();
      const moved = await subject.movePointer({ scope, signal: aborted.signal, operation: {
        kind: "move_pointer", scope: "desktop", target, coordinateSpace: "presented_snapshot_pixels", x: condition === "outside" ? Number.MAX_SAFE_INTEGER : 12, y: 24,
      } });
      expect(moved).toMatchObject({ ok: false, receipt: { completionCertainty: "not_completed", outcome: { stateChangeCertainty: "not_changed" } } });
      expect(checked.dispatched.filter((call) => call.name === "move_cursor")).toHaveLength(0);
      expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
    }
  });

  test("scrolls one fresh exact window-snapshot point with the requested portable direction, amount, and granularity", async () => {
    const checked = port([
      installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true, launch_path: null, kind: "application", last_used: null, windows: [] }]),
      launchSuccess(),
      windowStateScreenshot(1200, 800),
      result({ effect: "unverifiable", route: "synthetic_events", delivery: { mode: "background" } }),
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!launched.ok || launched.receipt.window === null) throw new Error("expected exact window");
    const observed = await subject.observeWindowState({ scope, target: launched.receipt.window, capture: "window_snapshot" });
    if (!observed.ok || observed.observation.windowSnapshot === undefined) throw new Error("expected exact window snapshot");

    const scrolled = await subject.scroll({
      scope,
      operation: {
        kind: "scroll", target: observed.observation.windowSnapshot.target,
        coordinateSpace: "window_snapshot_pixels", x: 840, y: 320,
        direction: "right", amount: 2, by: "page",
      },
    });
    expect(scrolled).toMatchObject({
      ok: false,
      receipt: {
        action: "scroll", deliveryMode: "background", completionCertainty: "unknown_completion", verification: "not_verified",
        providerAction: { effect: "unverifiable", route: "synthetic_events", delivery: { mode: "background" } },
        resolvedTarget: { kind: "screen", bounds: { x: 0, y: 0, width: 1200, height: 800 } },
        outcome: { stateChangeCertainty: "unknown", recovery: ["observe_again", "do_not_replay"] },
      },
    });
    if (scrolled.ok) throw new Error("expected fresh observation to verify the scroll effect");
    expect(computerMutationReceiptSchema.safeParse(scrolled.receipt).success).toBe(true);
    expect(checked.calls.at(-1)).toEqual({
      name: "scroll",
      args: { pid: 77, window_id: 500, x: 840, y: 320, direction: "right", amount: 2, by: "page", delivery_mode: "background" },
    });
    await expect(subject.scroll({
      scope,
      operation: {
        kind: "scroll", target: observed.observation.windowSnapshot.target,
        coordinateSpace: "window_snapshot_pixels", x: 840, y: 320,
        direction: "left", amount: 1, by: "line",
      },
    })).resolves.toMatchObject({ ok: false, error: "This desktop reference is no longer available. Observe again before acting." });
  });

  test("keeps a typed window-click refusal operational but withdraws a malformed success envelope", async () => {
    const run = async (clickResult: CuaContextToolResult) => {
      const checked = port([
        installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true, launch_path: null, kind: "application", last_used: null, windows: [] }]),
        launchSuccess(),
        windowStateScreenshot(1200, 800),
        clickResult,
      ]);
      const subject = new CuaComputerUseAdapter({ port: checked.value });
      const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
      if (!launched.ok || launched.receipt.window === null) throw new Error("expected exact window");
      const observed = await subject.observeWindowState({ scope, target: launched.receipt.window, capture: "window_snapshot" });
      if (!observed.ok || observed.observation.windowSnapshot === undefined) throw new Error("expected exact window snapshot");
      const clicked = await subject.click({
        scope,
        operation: {
          kind: "click", target: observed.observation.windowSnapshot.target,
          coordinateSpace: "window_snapshot_pixels", x: 248, y: 776,
        },
      });
      return { checked, clicked };
    };

    const refused = await run(result({
      code: "off_space_or_ax_unresolved", effect: "refused", pid: 77, window_id: 500,
      reason: "private refusal", escalation: { reason: "private refusal", recommended: "foreground" },
    }, true));
    expect(refused.clicked).toMatchObject({
      ok: false,
      receipt: { completionCertainty: "not_completed", deliveryMode: "not_delivered", outcome: { stateChangeCertainty: "not_changed", targetCondition: "unavailable" } },
    });
    expect(refused.checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
    expect(JSON.stringify(refused.clicked)).not.toContain("private refusal");

    const foregroundRequired = await run(result({
      code: "background_unavailable", effect: "refused",
      escalation: { reason: "private modifier delivery detail", recommended: "foreground" },
    }, true));
    expect(foregroundRequired.clicked).toMatchObject({ ok: false, receipt: {
      completionCertainty: "not_completed", deliveryMode: "not_delivered",
      outcome: { stateChangeCertainty: "not_changed", providerCondition: "ready" },
    } });
    expect(foregroundRequired.clicked.error).toContain("foreground");
    expect(foregroundRequired.checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
    expect(JSON.stringify(foregroundRequired.clicked)).not.toContain("private modifier delivery detail");

    const malformed = await run(result({
      effect: "confirmed", route: "synthetic_events", delivery: { mode: "background" },
    }));
    expect(malformed.clicked).toMatchObject({
      ok: false,
      receipt: { completionCertainty: "unknown_completion", outcome: { providerCondition: "malformed_response", recovery: ["observe_again", "do_not_replay"] } },
    });
    expect(malformed.checked.invalidateCheckedGeneration).toHaveBeenCalledTimes(1);
  });

  test("acknowledges delivered Cua drag while requiring fresh effect verification without replay", async () => {
    const checked = port([
      installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true, launch_path: null, kind: "application", last_used: null, windows: [] }]),
      launchSuccess(),
      windowStateScreenshot(1200, 800),
      result({ effect: "unverifiable", route: "global_input", delivery: { mode: "foreground" } }),
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!launched.ok || launched.receipt.window === null) throw new Error("expected exact window");
    const observed = await subject.observeWindowState({ scope, target: launched.receipt.window, capture: "window_snapshot" });
    if (!observed.ok || observed.observation.windowSnapshot === undefined || observed.visionImage === undefined) throw new Error("expected exact window snapshot");
    expect(windowStateObservationSchema.safeParse(observed.observation).success).toBe(true);
    expect(observed.observation.windowSnapshot.metadata).toEqual({
      format: "png", dimensions: { width: 1200, height: 800 }, coordinateSpace: "window_snapshot_pixels",
    });
    expect(observed.visionImage.bytes.subarray(0, 8)).toEqual(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const dragged = await subject.dragDrop({
      scope,
      operation: {
        kind: "drag_drop", target: observed.observation.windowSnapshot.target,
        coordinateSpace: "window_snapshot_pixels", from: { x: 248, y: 776 }, to: { x: 720, y: 776 },
      },
    });
    expect(dragged).toMatchObject({
      ok: true,
      receipt: {
        action: "drag_drop", deliveryMode: "foreground", completionCertainty: "completed", verification: "not_verified",
        providerAction: { effect: "unverifiable", route: "global_input", delivery: { mode: "foreground" } },
        unexecutedRemainder: { count: 0, reason: "none" },
        outcome: { retrySafety: "never", stateChangeCertainty: "unknown", recovery: ["observe_again", "do_not_replay"] },
      },
    });
    if (!dragged.ok) throw new Error("expected acknowledged drag delivery");
    const parsed = computerMutationReceiptSchema.safeParse(dragged.receipt);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
    expect(checked.calls.at(-1)).toEqual({ name: "drag", args: {
      pid: 77, window_id: 500, from_x: 248, from_y: 776, to_x: 720, to_y: 776,
      delivery_mode: "foreground",
    } });
    expect(JSON.stringify(dragged.receipt)).toContain('"action":"drag_drop"');
    await expect(subject.dragDrop({
      scope,
      operation: {
        kind: "drag_drop", target: observed.observation.windowSnapshot.target,
        coordinateSpace: "window_snapshot_pixels", from: { x: 248, y: 776 }, to: { x: 720, y: 776 },
      },
    })).resolves.toMatchObject({ ok: false, error: "This desktop reference is no longer available. Observe again before acting." });
  });

  test("preserves caller drag options through a cropped window or desktop snapshot", async () => {
    for (const desktop of [false, true]) {
      const action = result({ effect: "unverifiable", route: "global_input", delivery: { mode: desktop ? "not_applicable" : "foreground" } });
      const checked = port(desktop ? [apps(), windows(), action] : [
        installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true }]),
        launchSuccess(), await decodableWindowStateScreenshot(120, 80), action,
      ]);
      const subject = new CuaComputerUseAdapter({ port: checked.value });
      const target = await (async () => {
        if (desktop) {
          const observed = await subject.observe({ scope, operation: "desktop_state" });
          if (!observed.ok || !observed.observation.screenSnapshot) throw new Error("expected desktop");
          return observed.observation.screenSnapshot.target;
        }
        const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
        if (!launched.ok || !launched.receipt.window) throw new Error("expected window");
        const observed = await subject.observeWindowState({ scope, target: launched.receipt.window, capture: "window_snapshot" });
        if (!observed.ok || !observed.observation.windowSnapshot) throw new Error("expected window image");
        const cropped = await subject.observeWindowRegion({ scope, target: observed.observation.windowSnapshot.target,
          coordinateSpace: "window_snapshot_pixels", region: { x: 20, y: 10, width: 80, height: 60 } });
        if (!cropped.ok) throw new Error("expected crop");
        return cropped.observation.regionSnapshot.target;
      })();
      const operation = { kind: "drag_drop" as const, target, coordinateSpace: "presented_snapshot_pixels" as const,
        from: { x: 2, y: 3 }, to: { x: 70, y: 50 }, durationMs: 1500, steps: 120,
        button: "right" as const, modifiers: ["option", "shift"] as const, deliveryMode: "foreground" as const };
      const dragged = await subject.dragDrop({ scope, operation });
      expect(dragged).toMatchObject({ ok: true, receipt: { completionCertainty: "completed", verification: "not_verified",
        deliveryMode: desktop ? "not_applicable" : "foreground", outcome: { stateChangeCertainty: "unknown", recovery: ["observe_again", "do_not_replay"] } } });
      expect(computerMutationReceiptSchema.safeParse(dragged.receipt).success).toBe(true);
      expect(checked.calls.at(-1)).toEqual({ name: "drag", args: {
        ...(desktop ? { scope: "desktop" } : { pid: 77, window_id: 500, delivery_mode: "foreground" }),
        from_x: desktop ? 2 : 22, from_y: desktop ? 3 : 13, to_x: desktop ? 70 : 90, to_y: desktop ? 50 : 60,
        duration_ms: 1500, steps: 120, button: "right", modifier: ["option", "shift"],
      } });
      await subject.dragDrop({ scope, operation });
      expect(checked.calls.filter((call) => call.name === "drag")).toHaveLength(1);
      expect(computerMutationReceiptSchema.safeParse({ ...dragged.receipt, verification: "verified" }).success).toBe(false);
    }
  });

  test("rejects desktop drag frame errors and background input before dispatch", async () => {
    for (const variant of ["background", "wrong_frame", "outside_from", "outside_to"] as const) {
      const checked = port([apps(), windows()]);
      const subject = new CuaComputerUseAdapter({ port: checked.value });
      const observed = await subject.observe({ scope, operation: "desktop_state" });
      if (!observed.ok || !observed.observation.screenSnapshot) throw new Error("expected desktop");
      const dragged = await subject.dragDrop({ scope, operation: { kind: "drag_drop", target: observed.observation.screenSnapshot.target,
        coordinateSpace: variant === "wrong_frame" ? "window_snapshot_pixels" : "presented_snapshot_pixels",
        from: { x: variant === "outside_from" ? 1200 : 10, y: 20 }, to: { x: 30, y: variant === "outside_to" ? 800 : 40 },
        ...(variant === "background" ? { deliveryMode: "background" as const } : {}),
      } });
      expect(dragged).toMatchObject({ ok: false, receipt: { completionCertainty: "not_completed",
        outcome: { stateChangeCertainty: "not_changed", providerCondition: "ready" } } });
      expect(checked.calls.filter((call) => call.name === "drag")).toHaveLength(0);
      expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
      expect(computerMutationReceiptSchema.safeParse(dragged.receipt).success).toBe(true);
    }
  });

  test("keeps driver background-drag refusal recoverable without withdrawing Cua", async () => {
    const checked = port([
      installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true }]),
      launchSuccess(), windowStateScreenshot(120, 80), result({ code: "background_unavailable" }, true),
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!launched.ok || !launched.receipt.window) throw new Error("expected window");
    const observed = await subject.observeWindowState({ scope, target: launched.receipt.window, capture: "window_snapshot" });
    if (!observed.ok || !observed.observation.windowSnapshot) throw new Error("expected image");
    const dragged = await subject.dragDrop({ scope, operation: { kind: "drag_drop", target: observed.observation.windowSnapshot.target,
      coordinateSpace: "window_snapshot_pixels", from: { x: 10, y: 10 }, to: { x: 20, y: 20 }, deliveryMode: "background" } });
    expect(dragged).toMatchObject({ ok: false, receipt: { completionCertainty: "not_completed",
      outcome: { providerCondition: "ready", stateChangeCertainty: "not_changed", recovery: ["observe_again"] } } });
    expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
    expect(computerMutationReceiptSchema.safeParse(dragged.receipt).success).toBe(true);
  });

  test("classifies desktop takeover during lease setup before click dispatch", async () => {
    const checked = port([apps(), windows()]);
    let takeover = false;
    let delivered = false;
    const wrapped: CuaCheckedContextPort = { ...checked.value, clickDesktop: async (...args) => {
      takeover = true;
      if (args[5] !== undefined && !await args[5]()) return { ok: false, code: "context_fenced", stage: "session" };
      delivered = true;
      return checked.value.clickDesktop(...args);
    } };
    const subject = new CuaComputerUseAdapter({ port: wrapped, monotonicMilliseconds: () => 10_000,
      readHidIdleNanoseconds: async () => takeover ? 0 : 1_000_000_000 });
    const observed = await subject.observe({ scope, operation: "desktop_state" });
    if (!observed.ok || !observed.observation.screenSnapshot) throw new Error("expected desktop");
    const clicked = await subject.click({ scope, operation: { kind: "click", target: observed.observation.screenSnapshot.target,
      coordinateSpace: "presented_snapshot_pixels", x: 10, y: 20 } });
    expect(clicked).toMatchObject({ ok: false, receipt: { completionCertainty: "not_completed",
      outcome: { phase: "pre_effect_dispatch", stateChangeCertainty: "not_changed", externalInterference: "user_input" } } });
    expect(delivered).toBe(false);
    expect(computerMutationReceiptSchema.safeParse(clicked.receipt).success).toBe(true);
  });

  test("types and presses at one exact fresh window-snapshot point without exposing content", async () => {
    const makeSnapshot = async (action: CuaContextToolResult) => {
      const checked = port([
        installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true, launch_path: null, kind: "application", last_used: null, windows: [] }]),
        launchSuccess(),
        windowStateScreenshot(1200, 800),
        action,
      ]);
      const subject = new CuaComputerUseAdapter({ port: checked.value });
      const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
      if (!launched.ok || launched.receipt.window === null) throw new Error("expected exact window");
      const observed = await subject.observeWindowState({ scope, target: launched.receipt.window, capture: "window_snapshot" });
      if (!observed.ok || observed.observation.windowSnapshot === undefined) throw new Error("expected exact window snapshot");
      return { checked, subject, snapshot: observed.observation.windowSnapshot.target };
    };

    const text = "pixel sentinel";
    const typedFixture = await makeSnapshot(result({
      effect: "confirmed", route: "accessibility", delivery: { mode: "background", delivered_count: [...text].length },
      evidence: [{ kind: "value_readback" }],
    }));
    const typed = await typedFixture.subject.typeText({
      scope,
      operation: { kind: "type_text", target: typedFixture.snapshot, coordinateSpace: "window_snapshot_pixels", x: 360, y: 274, text },
    });
    expect(typed).toMatchObject({
      ok: true,
      receipt: {
        action: "type_text", deliveryMode: "background", completionCertainty: "completed", verification: "verified",
        textDelivery: { requestedCharacters: 14, deliveredCharacters: 14 },
        providerAction: { effect: "confirmed", route: "accessibility", evidenceKinds: ["value_readback"] },
        outcome: { recovery: ["observe_again", "do_not_replay"] },
      },
    });
    if (!typed.ok) throw new Error("expected confirmed pixel text");
    expect(computerMutationReceiptSchema.safeParse(typed.receipt).success).toBe(true);
    expect(JSON.stringify(typed.receipt)).not.toContain(text);
    expect(typedFixture.checked.calls.at(-1)).toEqual({
      name: "type_text", args: { pid: 77, window_id: 500, x: 360, y: 274, text, delivery_mode: "background" },
    });

    const keyFixture = await makeSnapshot(result({ effect: "unverifiable", route: "synthetic_events", delivery: { mode: "background" } }));
    const pressed = await keyFixture.subject.pressKey({
      scope,
      operation: { kind: "press_key", target: keyFixture.snapshot, coordinateSpace: "window_snapshot_pixels", x: 360, y: 274, key: "a", modifiers: [] },
    });
    expect(pressed).toMatchObject({
      ok: false,
      receipt: {
        action: "press_key", deliveryMode: "background", completionCertainty: "unknown_completion", verification: "not_verified",
        providerAction: { effect: "unverifiable", route: "synthetic_events" },
        unexecutedRemainder: { count: 1, reason: "unknown_completion" },
        outcome: { recovery: ["observe_again", "do_not_replay"] },
      },
    });
    if (pressed.ok) throw new Error("unverified pixel key must require observation");
    expect(computerMutationReceiptSchema.safeParse(pressed.receipt).success).toBe(true);
    expect(keyFixture.checked.calls.at(-1)).toEqual({
      name: "press_key", args: { pid: 77, window_id: 500, x: 360, y: 274, key: "a", modifiers: [], delivery_mode: "background" },
    });
  });

  test("rechecks Human input after Cua session setup and before the exact drag dispatch", async () => {
    const checked = port([
      installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true, launch_path: null, kind: "application", last_used: null, windows: [] }]),
      launchSuccess(),
      windowStateScreenshot(1200, 800),
    ]);
    let providerDispatch = false;
    const wrapped: CuaCheckedContextPort = {
      ...checked.value,
      callContextTool: async (currentScope, name, args, signal, onProviderDispatch) => {
        if (name === "drag" && onProviderDispatch !== undefined) {
          providerDispatch = true;
          if (!await onProviderDispatch()) return { ok: false as const, code: "context_fenced" as const, stage: "tool" as const };
          throw new Error("Human-input fence should stop provider transport");
        }
        return checked.value.callContextTool(currentScope, name, args, signal, onProviderDispatch);
      },
    };
    const subject = new CuaComputerUseAdapter({
      port: wrapped,
      readHidIdleNanoseconds: async () => providerDispatch ? 0 : 1_000_000_000,
      monotonicMilliseconds: () => 10_000,
    });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!launched.ok || launched.receipt.window === null) throw new Error("expected exact window");
    const observed = await subject.observeWindowState({ scope, target: launched.receipt.window, capture: "window_snapshot" });
    if (!observed.ok || observed.observation.windowSnapshot === undefined) throw new Error("expected exact window snapshot");
    const dragged = await subject.dragDrop({
      scope,
      operation: {
        kind: "drag_drop", target: observed.observation.windowSnapshot.target,
        coordinateSpace: "window_snapshot_pixels", from: { x: 248, y: 776 }, to: { x: 720, y: 776 },
      },
    });
    expect(dragged).toMatchObject({
      ok: false,
      receipt: {
        completionCertainty: "not_completed", deliveryMode: "not_delivered",
        outcome: { phase: "pre_effect_dispatch", stateChangeCertainty: "not_changed", externalInterference: "user_input", recovery: ["observe_again"] },
      },
    });
    if (dragged.ok) throw new Error("expected pre-dispatch Human-input fence");
    expect(computerMutationReceiptSchema.safeParse(dragged.receipt).success).toBe(true);
    expect(checked.calls.filter((call) => call.name === "drag")).toHaveLength(0);
  });

  test("withdraws the checked Cua route when window screenshot bytes contradict structured dimensions", async () => {
    const malformedScreenshot = windowStateScreenshot(1200, 800);
    const checked = port([
      installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true, launch_path: null, kind: "application", last_used: null, windows: [] }]),
      launchSuccess(),
      { ...malformedScreenshot, structuredContent: { ...malformedScreenshot.structuredContent, screenshot_width: 1199 } },
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!launched.ok || launched.receipt.window === null) throw new Error("expected exact window");
    const observed = await subject.observeWindowState({ scope, target: launched.receipt.window, capture: "window_snapshot" });
    expect(observed).toMatchObject({
      ok: false,
      outcome: { providerCondition: "malformed_response", stateChangeCertainty: "not_applicable", recovery: ["observe_again"] },
    });
    expect(checked.invalidateCheckedGeneration).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(observed)).not.toMatch(/private|screenshot_width|base64|window_id/);
  });

  test("prevents a stale snapshot click on measured Human input and distinguishes an unavailable HID sample", async () => {
    const run = async (mode: "external" | "unavailable") => {
      let samples = 0;
      const checked = port([apps(), windows()]);
      const subject = new CuaComputerUseAdapter({
        port: checked.value,
        readHidIdleNanoseconds: async () => {
          samples += 1;
          if (mode === "unavailable" && samples >= 4) throw new Error("ioreg unavailable");
          return samples >= 4 ? 0 : 1_000_000_000;
        },
        monotonicMilliseconds: () => 10_000,
      });
      const observed = await subject.observe({ scope, operation: "desktop_state" });
      if (!observed.ok || observed.observation.screenSnapshot === undefined) throw new Error("expected snapshot");
      const clicked = await subject.click({
        scope,
        operation: {
          kind: "click", target: observed.observation.screenSnapshot.target,
          coordinateSpace: "presented_snapshot_pixels", x: 1, y: 1,
        },
      });
      expect(clicked).toMatchObject({
        ok: false,
        receipt: { completionCertainty: "not_completed", outcome: { stateChangeCertainty: "not_changed", recovery: ["observe_again"] } },
      });
      expect(JSON.stringify(clicked).includes("externalInterference")).toBe(mode === "external");
      expect(checked.clickDesktop).not.toHaveBeenCalled();
      if (!clicked.ok) expect(computerMutationReceiptSchema.safeParse(clicked.receipt).success).toBe(true);
    };
    await run("external");
    await run("unavailable");
  });

  test("uses receipt-only unavailable evidence that preserves unresolved window versus element scope", async () => {
    const registry = new ComputerUseContextRegistry();
    const initial = registry.create(scope);
    if (!initial.ok) throw new Error("expected context");
    const subject = new CuaComputerUseAdapter({ port: port([]).value, registry });
    const missingWindow = { context: initial.data.context, reference: `dtgt_${"A".repeat(43)}` };
    const missingElement = { context: initial.data.context, reference: `detgt_${"B".repeat(43)}` };
    const focused = await subject.focus({ scope, operation: { kind: "focus", target: missingWindow } });
    const typedWindow = await subject.typeText({ scope, operation: { kind: "type_text", target: missingWindow, text: "TEST" } });
    const typedElement = await subject.typeText({ scope, operation: { kind: "type_text", target: missingElement, text: "TEST" } });
    expect(focused).toMatchObject({ ok: false, receipt: { resolvedTarget: { kind: "window", role: "unavailable" }, completionCertainty: "not_completed" } });
    expect(typedWindow).toMatchObject({ ok: false, receipt: { resolvedTarget: { kind: "window", role: "unavailable" }, completionCertainty: "not_completed" } });
    expect(typedElement).toMatchObject({ ok: false, receipt: { resolvedTarget: { kind: "element", state: "unavailable" }, completionCertainty: "not_completed" } });
    for (const result of [focused, typedWindow, typedElement]) {
      if (result.ok) throw new Error("expected unresolved target");
      const parsed = computerMutationReceiptSchema.safeParse(result.receipt);
      if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
      expect(JSON.stringify(result.receipt)).not.toMatch(/"pid"|"window_id"/);
    }
  });

  test("rejects an out-of-bounds point before Cua and fences post-boundary uncertainty", async () => {
    const checked = port([apps(), windows()]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const observed = await subject.observe({ scope, operation: "desktop_state" });
    if (!observed.ok || observed.observation.screenSnapshot === undefined) throw new Error("expected snapshot");
    const operation = {
      kind: "click" as const,
      target: observed.observation.screenSnapshot.target,
      coordinateSpace: "presented_snapshot_pixels" as const,
      x: 1200,
      y: 0,
    };
    await expect(subject.click({ scope, operation })).resolves.toMatchObject({
      ok: false,
      receipt: { completionCertainty: "not_completed", deliveryMode: "not_delivered" },
    });
    expect(checked.clickDesktop).not.toHaveBeenCalled();

    const uncertainPort: CuaCheckedContextPort = {
      ...checked.value,
      clickDesktop: async () => ({ ok: false, code: "context_fenced", stage: "tool" }),
    };
    const uncertain = new CuaComputerUseAdapter({ port: uncertainPort, registry: subject.registry });
    await expect(uncertain.click({ scope, operation: { ...operation, x: 1 } })).resolves.toMatchObject({
      ok: false,
      receipt: { completionCertainty: "unknown_completion", deliveryMode: "unknown", outcome: { recovery: ["observe_again", "do_not_replay"] } },
    });
    await expect(uncertain.click({ scope, operation: { ...operation, x: 1 } })).resolves.toMatchObject({
      ok: false,
      error: "The prior desktop action may have completed. Observe again; do not replay it.",
    });
  });

  test("releases retained Cua contexts immediately when a checked generation is cleared", async () => {
    const registry = new ComputerUseContextRegistry({ maxContexts: 1 });
    const first = port([apps(), windows()]);
    await expect(new CuaComputerUseAdapter({ port: first.value, registry }).observe({ scope, operation: "desktop_state" }))
      .resolves.toMatchObject({ ok: true });
    const nextScope = { ...scope, computerUseContextId: "computer-use-context-2", providerGeneration: "provider-generation-2" };
    const blocked = port([apps(), windows()]);
    await expect(new CuaComputerUseAdapter({ port: blocked.value, registry }).observe({ scope: nextScope, operation: "desktop_state" }))
      .resolves.toMatchObject({ ok: false, code: "capacity_exhausted" });
    expect(blocked.calls).toEqual([]);

    registry.clear();
    const afterClear = port([apps(), windows()]);
    await expect(new CuaComputerUseAdapter({ port: afterClear.value, registry }).observe({ scope: nextScope, operation: "desktop_state" }))
      .resolves.toMatchObject({ ok: true });
  });

  test("fails closed on duplicate window ids and pid-zero entries incorrectly marked running", async () => {
    const duplicate = result({ windows: [
      { window_id: 90, pid: 42, app_name: "Nautilo", title: "One", bounds: { x: 0, y: 0, width: 1, height: 1 }, layer: 0, z_index: null, is_on_screen: true, current_space_id: null, on_current_space: null, space_ids: null },
      { window_id: 90, pid: 42, app_name: "Nautilo", title: "Two", bounds: { x: 0, y: 0, width: 1, height: 1 }, layer: 0, z_index: null, is_on_screen: true, current_space_id: null, on_current_space: null, space_ids: null },
    ], current_space_id: null });
    const unbound = result({ windows: [{ window_id: 90, pid: 777, app_name: "Other", title: "Other", bounds: { x: 0, y: 0, width: 1, height: 1 }, layer: 0, z_index: null, is_on_screen: true, current_space_id: null, on_current_space: null, space_ids: null }], current_space_id: null });
    const duplicateChecked = port([apps(), duplicate]);
    await expect(new CuaComputerUseAdapter({ port: duplicateChecked.value }).observe({ scope, operation: "desktop_state" }))
      .resolves.toMatchObject({ ok: false, code: "provider_malformed" });
    const crowdedApps = Array.from({ length: 65 }, (_, index) => ({
      pid: index === 64 ? 777 : index + 42,
      name: index === 64 ? "Other" : `App ${index}`,
      bundle_id: index === 64 ? "example.other" : `example.${index}`,
      active: false, running: true, launch_path: null, kind: "application", last_used: null, windows: [],
    }));
    // Every checked application row is retained. A valid window from the
    // provider tail remains reachable instead of being classified uninspected.
    const unboundChecked = port([result({ apps: crowdedApps }), unbound]);
    await expect(new CuaComputerUseAdapter({ port: unboundChecked.value }).observe({ scope, operation: "desktop_state" }))
      .resolves.toMatchObject({ ok: true, observation: { completeness: "complete", discovered: 1, uninspected: null, applicationTargets: { discovered: 65, returned: 65, omitted: 0 } } });
    const checked = port([result({ apps: [{ pid: 0, name: "Bad", bundle_id: "example.bad", active: false, running: true, launch_path: null, kind: "application", last_used: null, windows: [] }] })]);
    await expect(new CuaComputerUseAdapter({ port: checked.value }).observe({ scope, operation: "desktop_state" }))
      .resolves.toMatchObject({ ok: false, code: "provider_malformed" });
  });

  test("focuses only the current exact opaque Cua window and accepts the independently verified proof", async () => {
    const checked = port([apps(), windows(), apps(), windows(), focused()]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const observed = await subject.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected observation");
    const target = observed.observation.targets[0]!.target;
    const focusedResult = await subject.focus({ scope, operation: { kind: "focus", target } });
    expect(focusedResult).toMatchObject({
      ok: true,
      receipt: { provider: "cua", action: "focus", deliveryMode: "foreground_escalated", completionCertainty: "completed", verification: "verified", resolvedTarget: { kind: "window", appLabel: "Nautilo" } },
    });
    if (focusedResult.ok) {
      expect(Object.keys(focusedResult.receipt.target).sort()).toEqual(["context", "reference", "version"]);
      expect(Object.keys(focusedResult.receipt.resolvedTarget).sort()).toEqual(["appLabel", "bounds", "kind"]);
    }
    expect(checked.calls.slice(-3)).toEqual([
      { name: "list_apps", args: {} },
      { name: "list_windows", args: { pid: 42 } },
      { name: "bring_to_front", args: { pid: 42, window_id: 90 } },
    ]);
    expect(checked.endContextLease).toHaveBeenCalledTimes(5);
  });

  test("preflights focus through the bound PID instead of losing a valid window beyond a crowded global page", async () => {
    const observedPort = port([apps(), windows()]);
    const observedAdapter = new CuaComputerUseAdapter({ port: observedPort.value });
    const observed = await observedAdapter.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected observation");
    const target = observed.observation.targets[0]!.target;

    const calls: { readonly name: CuaContextToolName; readonly args: Readonly<Record<string, unknown>> }[] = [];
    const crowdedGlobal = listedRawWindows([
      ...Array.from({ length: 101 }, (_, index) => rawWindowRow({
        windowId: 1_000 + index,
        pid: 10_000 + index,
        appName: `Foreign ${index}`,
        title: `Foreign ${index}`,
        width: 800,
        height: 600,
      })),
      windows().structuredContent!.windows![0] as Readonly<Record<string, unknown>>,
    ]);
    const checked: CuaCheckedContextPort = {
      generation,
      captureDesktopState: async () => ({ ok: false, code: "context_fenced" }),
      clickDesktop: async () => ({ ok: false, code: "context_fenced", stage: "session" }),
      callContextTool: async (_scope, name, args) => {
        calls.push({ name, args });
        const fixture = name === "list_apps"
          ? apps()
          : name === "list_windows"
            ? (args["pid"] === 42 ? windows() : crowdedGlobal)
            : focused();
        return { ok: true, generation, sessionId, result: fixture };
      },
      launchApplication: unusedCheckedCall,
      getWindowState: unusedCheckedCall,
      endContextLease: async () => undefined,
    };

    await expect(new CuaComputerUseAdapter({ port: checked, registry: observedAdapter.registry }).focus({
      scope,
      operation: { kind: "focus", target },
    })).resolves.toMatchObject({ ok: true, receipt: { completionCertainty: "completed", verification: "verified" } });
    expect(calls).toEqual([
      { name: "list_apps", args: {} },
      { name: "list_windows", args: { pid: 42 } },
      { name: "bring_to_front", args: { pid: 42, window_id: 90 } },
    ]);
  });

  test("composes Cua's exact focused partial with a same-session resolved state when its overlay shadows z-order", async () => {
    const checked = port([apps(), windows(), apps(), windows(), focusedWithProviderOverlay(), exactWindowState(42, 90)]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const observed = await subject.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected observation");
    const target = observed.observation.targets[0]!.target;
    const focusedResult = await subject.focus({ scope, operation: { kind: "focus", target } });
    expect(focusedResult).toMatchObject({
      ok: true,
      receipt: {
        action: "focus", completionCertainty: "completed", verification: "verified",
        outcome: { providerCondition: "ready", targetCondition: "current", recovery: [] },
      },
    });
    if (!focusedResult.ok) throw new Error(JSON.stringify(focusedResult));
    expect(computerMutationReceiptSchema.safeParse(focusedResult.receipt).success).toBe(true);
    expect(checked.calls.slice(-4)).toEqual([
      { name: "list_apps", args: {} },
      { name: "list_windows", args: { pid: 42 } },
      { name: "bring_to_front", args: { pid: 42, window_id: 90 } },
      { name: "get_window_state", args: { pid: 42, window_id: 90, include_screenshot: false } },
    ]);
    expect(JSON.stringify(focusedResult)).not.toMatch(/46529|frontmost|tree|private|window_id/i);
  });

  test("keeps an overlay-shadowed exact focus when one post-read HID sample is transiently unavailable", async () => {
    const checked = port([apps(), windows(), apps(), windows(), focusedWithProviderOverlay(), exactWindowState(42, 90)]);
    let samples = 0;
    const subject = new CuaComputerUseAdapter({
      port: checked.value,
      readHidIdleNanoseconds: async () => {
        samples += 1;
        if (samples === 6) throw new Error("transient ioreg failure");
        return 1_000_000_000;
      },
      monotonicMilliseconds: () => 10_000,
    });
    const observed = await subject.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected observation");
    const focusedResult = await subject.focus({
      scope,
      operation: { kind: "focus", target: observed.observation.targets[0]!.target },
    });
    expect(focusedResult).toMatchObject({
      ok: true,
      receipt: { completionCertainty: "completed", verification: "verified" },
    });
    expect(samples).toBe(7);
    expect(checked.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(1);
    expect(checked.calls.filter((call) => call.name === "get_window_state")).toHaveLength(1);
  });

  test("still detects measured Human takeover after a transient HID read failure", async () => {
    const checked = port([apps(), windows()]);
    let samples = 0;
    const subject = new CuaComputerUseAdapter({
      port: checked.value,
      readHidIdleNanoseconds: async () => {
        samples += 1;
        if (samples === 1) throw new Error("transient ioreg failure");
        return samples === 2 ? 1_000_000_000 : 0;
      },
      monotonicMilliseconds: () => 10_000,
    });
    await expect(subject.observe({ scope, operation: "desktop_state" })).resolves.toMatchObject({
      ok: false,
      outcome: { externalInterference: "user_input", recovery: ["observe_again"] },
    });
    expect(samples).toBe(3);
  });

  test("does not promote an exact focused partial when the same-window read remains degraded", async () => {
    const checked = port([apps(), windows(), apps(), windows(), focusedWithProviderOverlay(), exactWindowState(42, 90, true)]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const observed = await subject.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected observation");
    const target = observed.observation.targets[0]!.target;
    const focusedResult = await subject.focus({ scope, operation: { kind: "focus", target } });
    expect(focusedResult).toMatchObject({
      ok: false,
      receipt: { completionCertainty: "unknown_completion", outcome: { recovery: ["observe_again", "do_not_replay"] } },
    });
    expect(checked.calls.filter((call) => call.name === "get_window_state")).toHaveLength(1);
  });

  test("never broadens the captured Cua-overlay focus family into a generic partial-focus success", async () => {
    const captured = focusedWithProviderOverlay();
    const structured = captured.structuredContent!;
    const observed = structured["observed"] as Record<string, unknown>;
    const effect = structured["exact_window_effect"] as Record<string, unknown>;
    const hostilePartials = [
      result({ ...structured, observed: { ...observed, front_process_matches_target: false } }, true),
      result({ ...structured, observed: { ...observed, focused_window_id: 91 } }, true),
      result({ ...structured, observed: { ...observed, workspace_frontmost_pid: 999 } }, true),
      result({ ...structured, exact_window_effect: { ...effect, target_visible_ordinary: false } }, true),
    ];

    for (const partial of hostilePartials) {
      const checked = port([apps(), windows(), apps(), windows(), partial]);
      const subject = new CuaComputerUseAdapter({ port: checked.value });
      const desktop = await subject.observe({ scope, operation: "desktop_state" });
      if (!desktop.ok) throw new Error("expected observation");
      await expect(subject.focus({
        scope,
        operation: { kind: "focus", target: desktop.observation.targets[0]!.target },
      })).resolves.toMatchObject({
        ok: false,
        receipt: { completionCertainty: "unknown_completion", outcome: { recovery: ["observe_again", "do_not_replay"] } },
      });
      expect(checked.calls.filter((call) => call.name === "get_window_state")).toHaveLength(0);
    }
  });

  test("accepts a null optional bundle and retains an off-screen ordinary window", async () => {
    const offScreen = result({ windows: [{
      window_id: 90, pid: 42, app_name: "Nautilo", title: "Connections",
      bounds: { x: 1, y: 2, width: 800, height: 600 }, layer: 0, z_index: null,
      is_on_screen: false, current_space_id: 1, on_current_space: false, space_ids: [2],
    }], current_space_id: 1 });
    const checked = port([
      result({ apps: [{ pid: 42, name: "Nautilo", bundle_id: null, active: false, running: true, launch_path: null, kind: "application", last_used: null, windows: [] }] }),
      offScreen,
    ]);
    await expect(new CuaComputerUseAdapter({ port: checked.value }).observe({ scope, operation: "desktop_state" }))
      .resolves.toMatchObject({ ok: true, observation: { completeness: "complete", discovered: 1, returned: 1 } });
  });

  test("keeps real off-Space windows but excludes a closed retained AppKit object with historical bounds", async () => {
    const inventory = result({ windows: [
      {
        window_id: 90, pid: 42, app_name: "Nautilo", title: "Connections",
        bounds: { x: 1, y: 2, width: 800, height: 600 }, layer: 0, z_index: null,
        is_on_screen: false, current_space_id: 1, on_current_space: false, space_ids: [2],
      },
      {
        window_id: 91, pid: 42, app_name: "Nautilo", title: "Closed document",
        bounds: { x: 10, y: 20, width: 720, height: 652 }, layer: 0, z_index: null,
        is_on_screen: false, current_space_id: 1, on_current_space: null, space_ids: null,
      },
    ], current_space_id: 1 });
    const checked = port([apps(), inventory]);
    const observed = await new CuaComputerUseAdapter({ port: checked.value }).observe({ scope, operation: "desktop_state" });
    expect(observed).toMatchObject({ ok: true, observation: { completeness: "complete", discovered: 1, returned: 1 } });
    if (!observed.ok) return;
    expect(observed.observation.targets).toHaveLength(1);
    expect(observed.observation.targets[0]!.evidence.windowLabel).toBe("Connections");
    expect(JSON.stringify(observed)).not.toContain("Closed document");
  });

  test("refuses PID/name/bundle reuse during preflight without crossing bring_to_front", async () => {
    const changedApps = result({ apps: [{ pid: 42, name: "Nautilo", bundle_id: "example.reused", active: false, running: true, launch_path: null, kind: "application", last_used: null, windows: [] }] });
    const checked = port([apps(), windows(), changedApps, windows()]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const observed = await subject.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected observation");
    await expect(subject.focus({ scope, operation: { kind: "focus", target: observed.observation.targets[0]!.target } }))
      .resolves.toMatchObject({ ok: false, receipt: { completionCertainty: "not_completed", outcome: { stateChangeCertainty: "not_changed" } } });
    expect(checked.calls.map((call) => call.name)).toEqual(["list_apps", "list_windows", "list_apps", "list_windows"]);
  });

  test("uses one exact preflight, canonical Cua key wire values, and only a confirmed ActionResult as completed input", async () => {
    const observedPort = port([apps(), windows()]);
    const observedAdapter = new CuaComputerUseAdapter({ port: observedPort.value });
    const observed = await observedAdapter.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected observation");
    const target = observed.observation.targets[0]!.target;
    const typedPort = port([
      apps(), windows(),
      result({ effect: "confirmed", route: "accessibility", delivery: { mode: "background", delivered_count: 3 }, evidence: [{ kind: "value_readback" }] }),
    ]);
    const typed = new CuaComputerUseAdapter({ port: typedPort.value, registry: observedAdapter.registry });
    const typedResult = await typed.typeText({ scope, operation: { kind: "type_text", target, text: "a😀b" } });
    expect(typedResult).toMatchObject({
      ok: true,
      receipt: {
        action: "type_text", deliveryMode: "background", completionCertainty: "completed", verification: "verified",
        textDelivery: { requestedCharacters: 3, deliveredCharacters: 3 },
        providerAction: { effect: "confirmed", route: "accessibility", delivery: { mode: "background", deliveredCount: 3 }, evidenceKinds: ["value_readback"] },
      },
    });
    if (!typedResult.ok) throw new Error("expected typed receipt");
    expect(computerMutationReceiptSchema.safeParse(typedResult.receipt).success).toBe(true);
    expect(typedPort.calls).toEqual([
      { name: "list_apps", args: {} }, { name: "list_windows", args: {} },
      { name: "type_text", args: { pid: 42, window_id: 90, text: "a😀b", scope: "window", delivery_mode: "background" } },
    ]);

    const keyedPort = port([
      apps(), windows(),
      result({ effect: "confirmed", route: "synthetic_events", delivery: { mode: "background" }, evidence: [{ kind: "value_readback" }] }),
    ]);
    const keyed = new CuaComputerUseAdapter({ port: keyedPort.value, registry: observedAdapter.registry });
    await expect(keyed.pressKey({ scope, operation: { kind: "press_key", target, key: "ENTER", modifiers: ["alt", "cmd"] } })).resolves.toMatchObject({
      ok: true, receipt: { action: "press_key", completionCertainty: "completed", verification: "verified" },
    });
    expect(keyedPort.calls.at(-1)).toEqual({ name: "press_key", args: { pid: 42, window_id: 90, key: "return", modifiers: ["option", "cmd"], scope: "window", delivery_mode: "background" } });
  });

  test("does not attribute background keyboard synthesis to the Human, and requires a checked read before another action", async () => {
    for (const scenario of ["text-confirmed", "text-unverified", "key-confirmed", "key-unverified", "hotkey", "text-partial"] as const) {
      const isText = scenario.startsWith("text-");
      const name = isText ? "type_text" : scenario === "hotkey" ? "hotkey" : "press_key";
      const confirmed = scenario.endsWith("confirmed");
      const partial = scenario === "text-partial";
      const action = partial
        ? result({ code: "type_text_incomplete", path: "key_events", effect: "partial", requested_chars: 3, delivered_chars: 2, retryable: true, retry_from_character: 2 }, true)
        : result({
          effect: confirmed ? "confirmed" : "unverifiable", route: "synthetic_events",
          delivery: { mode: "background", ...(isText ? { delivered_count: 3 } : {}) },
          ...(confirmed ? { evidence: [{ kind: "value_readback" }] } : {}),
          ...(isText && !confirmed ? { escalation: { target: "foreground", reason: "delivery_failed" } } : {}),
        });
      const checked = port([apps(), windows(), apps(), windows(), action, exactWindowState(42, 90), exactWindowState(42, 90)]);
      let humanDuringRead = false;
      const subject = new CuaComputerUseAdapter({ port: checked.value, monotonicMilliseconds: () => 10_000,
        readHidIdleNanoseconds: async () => humanDuringRead && checked.dispatched.filter((call) => call.name === "get_window_state").length > 1
          ? 0 : checked.dispatched.some((call) => call.name === name) ? 1_000_000_000 : 2_000_000_000 });
      const observed = await subject.observe({ scope, operation: "desktop_state" });
      if (!observed.ok) throw new Error("expected desktop");
      const target = observed.observation.targets[0]!.target;
      const act = () => isText ? subject.typeText({ scope, operation: { kind: "type_text", target, text: "a😀b" } })
        : scenario === "hotkey" ? subject.hotkey({ scope, operation: { kind: "hotkey", target, keys: ["cmd", "end"] } })
        : subject.pressKey({ scope, operation: { kind: "press_key", target, key: "return", modifiers: [] } });
      const performed = await act();
      expect(performed.receipt).toMatchObject({ completionCertainty: partial ? "partially_completed" : confirmed ? "completed" : "unknown_completion" });
      expect(performed.outcome).not.toHaveProperty("externalInterference");
      if (!partial) expect(performed.receipt).toMatchObject({ providerAction: { route: "synthetic_events" } });
      expect(computerMutationReceiptSchema.safeParse(performed.receipt).success).toBe(true);
      expect(subject.registry.resolveTarget(target.context, scope, target.reference).ok).toBe(false);
      await act();
      expect(checked.dispatched.filter((call) => call.name === name)).toHaveLength(1);
      const read = await subject.observeWindowState({ scope, target });
      expect(read.ok).toBe(true);
      expect(checked.dispatched.filter((call) => call.name === name)).toHaveLength(1);
      // Rebaselining after our own settled input must not suppress actual
      // activity during the next read or mint targets from that changed state.
      humanDuringRead = true;
      const interrupted = await subject.observeWindowState({ scope, target });
      expect(interrupted).toMatchObject({ ok: false, outcome: { externalInterference: "user_input" } });
      expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
      await subject.close();
    }
  });

  test("retains pre-dispatch keyboard takeover checks and post-dispatch AX attribution", async () => {
    for (const scenario of ["type_text", "press_key", "hotkey", "ax"] as const) {
      const name = scenario === "ax" ? "type_text" : scenario;
      const checked = port([apps(), windows(), apps(), windows(), result({ effect: "confirmed", route: "accessibility",
        delivery: { mode: "background", delivered_count: 3 }, evidence: [{ kind: "value_readback" }] })]);
      const subject = new CuaComputerUseAdapter({ port: checked.value, monotonicMilliseconds: () => 10_000,
        readHidIdleNanoseconds: async () => (scenario === "ax" ? checked.dispatched : checked.calls).some((call) => call.name === name) ? 0 : 1_000_000_000 });
      const observed = await subject.observe({ scope, operation: "desktop_state" });
      if (!observed.ok) throw new Error("expected desktop");
      const target = observed.observation.targets[0]!.target;
      const performed = name === "type_text" ? await subject.typeText({ scope, operation: { kind: name, target, text: "abc" } })
        : name === "hotkey" ? await subject.hotkey({ scope, operation: { kind: name, target, keys: ["cmd", "end"] } })
        : await subject.pressKey({ scope, operation: { kind: name, target, key: "return", modifiers: [] } });
      expect(performed).toMatchObject({ ok: false, outcome: { externalInterference: "user_input" } });
      expect(checked.dispatched.filter((call) => call.name === name)).toHaveLength(scenario === "ax" ? 1 : 0);
      await subject.close();
    }
  });

  test("accepts Cua 0.19.3's public background press-key ActionResult as unknown completion without a raw leak", async () => {
    const observedAdapter = new CuaComputerUseAdapter({ port: port([apps(), windows()]).value });
    const observed = await observedAdapter.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected observation");
    const checked = port([
      apps(), windows(),
      // Literal public projection from platform-macos press_key::action_record:
      // NativeApiResult is intentionally omitted from ActionResult evidence.
      result({ effect: "unverifiable", route: "synthetic_events", delivery: { mode: "background" } }),
    ]);
    const pressed = await new CuaComputerUseAdapter({ port: checked.value, registry: observedAdapter.registry }).pressKey({
      scope, operation: { kind: "press_key", target: observed.observation.targets[0]!.target, key: "n", modifiers: ["cmd"] },
    });
    expect(pressed).toMatchObject({
      ok: false,
      receipt: { action: "press_key", completionCertainty: "unknown_completion", providerAction: { effect: "unverifiable", route: "synthetic_events", delivery: { mode: "background" } } },
      outcome: { recovery: ["observe_again", "do_not_replay"] },
    });
    expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
    // Opaque random authority tokens can contain "pid"; inspect field names,
    // not arbitrary substrings inside those intentionally public tokens.
    expect(JSON.stringify(pressed)).not.toMatch(/"(?:pid|window_id|native_api|private)"\s*:/i);
  });

  test("delivers the dedicated hotkey once and retains unverified foreground advice without invalidating Cua", async () => {
    for (const deliveryMode of ["background", "foreground"] as const) {
      const checked = port([apps(), windows(), apps(), windows(), result({
        effect: "unverifiable", route: deliveryMode === "background" ? "synthetic_events" : "global_input",
        delivery: { mode: deliveryMode },
        ...(deliveryMode === "background" ? { escalation: { target: "foreground", reason: "delivery_failed" } } : {}),
      })]);
      const subject = new CuaComputerUseAdapter({ port: checked.value });
      const observed = await subject.observe({ scope, operation: "desktop_state" });
      if (!observed.ok) throw new Error("expected observation");
      const completed = await subject.hotkey({ scope, operation: {
        kind: "hotkey", target: observed.observation.targets[0]!.target, keys: ["COMMAND", "alt", "option", "plus"], deliveryMode,
      } });
      expect(checked.calls.filter((call) => call.name === "hotkey")).toEqual([
        { name: "hotkey", args: { pid: 42, window_id: 90, scope: "window", keys: ["cmd", "option", "shift", "="], delivery_mode: deliveryMode } },
      ]);
      expect(completed).toMatchObject({ receipt: { action: "hotkey", completionCertainty: "unknown_completion", verification: "not_verified" }, outcome: { providerCondition: "ready", recovery: ["observe_again", "do_not_replay"] } });
      expect(computerMutationReceiptSchema.safeParse(completed.receipt).success).toBe(true);
      expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
      const count = checked.calls.length;
      await subject.hotkey({ scope, operation: { kind: "hotkey", target: observed.observation.targets[0]!.target, keys: ["cmd", "s"] } });
      expect(checked.calls).toHaveLength(count);
      expect(JSON.stringify(completed)).not.toMatch(/"(?:keys|pid|window_id|element_token)"\s*:/);
    }
  });

  test("a known pre-effect hotkey refusal escalates the same chord through hotkey, never press_key", async () => {
    const checked = port([apps(), windows(), apps(), windows(),
      result({ code: "SCREEN_SHARING_REQUIRES_FOREGROUND_HID", effect: "refused",
        escalation: { recommended: "foreground", reason: "fixture", requires: ["window_id"] } }, true),
      result({ effect: "unverifiable", route: "global_input", delivery: { mode: "foreground" } }),
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const observed = await subject.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected observation");
    const performed = await subject.hotkey({ scope, operation: {
      kind: "hotkey", target: observed.observation.targets[0]!.target, keys: ["cmd", "s"],
    } });
    expect(checked.calls.filter((call) => call.name === "hotkey" || call.name === "press_key")).toEqual(
      ["background", "foreground"].map((delivery_mode) => ({ name: "hotkey", args: {
        pid: 42, window_id: 90, scope: "window", keys: ["cmd", "s"], delivery_mode,
      } })),
    );
    expect(performed).toMatchObject({ receipt: { action: "hotkey", completionCertainty: "unknown_completion" },
      outcome: { providerCondition: "ready", recovery: ["observe_again", "do_not_replay"] } });
    expect(computerMutationReceiptSchema.safeParse(performed.receipt).success).toBe(true);
    expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
  });

  test("hotkey uses snapshot-bound native elements regardless of role or advisory action lists", async () => {
    for (const [nativeRole, role] of [["AXTextField", "text_field"], ["AXOutline", "outline"], ["AXFutureControl", "future_control"]]) {
      const state = result({
        window_id: 90, pid: 42, element_count: 1, total_element_count: 1, returned_element_count: 1,
        elements_complete: false, tree_markdown: "private tree", _note: "private note",
        elements: [{ role: nativeRole, label: "Fixture", element_token: "private-key-token", enabled: true, actions: [] }],
      });
      const checked = port([apps(), windows(), state, apps(), windows(), result({ effect: "unverifiable", route: "global_input", delivery: { mode: "foreground" } })]);
      const subject = new CuaComputerUseAdapter({ port: checked.value });
      const observed = await subject.observe({ scope, operation: "desktop_state" });
      if (!observed.ok) throw new Error("expected desktop");
      const selected = await subject.observeWindowState({ scope, target: observed.observation.targets[0]!.target, selector: { role: role!, action: "press_key" } });
      if (!selected.ok || !selected.observation.element?.target) throw new Error("expected keyboard element");
      const operation = { kind: "hotkey" as const, target: selected.observation.element.target, keys: ["cmd", "s"], deliveryMode: "foreground" as const };
      const performed = await subject.hotkey({ scope, operation });
      expect(performed).toMatchObject({ receipt: { action: "hotkey", resolvedTarget: { kind: "element", role, action: "press_key" }, outcome: { providerCondition: "ready" } } });
      expect(computerMutationReceiptSchema.safeParse(performed.receipt).success).toBe(true);
      expect(checked.calls.at(-1)).toEqual({ name: "hotkey", args: { pid: 42, window_id: 90, element_token: "private-key-token", keys: ["cmd", "s"], delivery_mode: "foreground" } });
      const count = checked.calls.length;
      await subject.hotkey({ scope, operation });
      expect(checked.calls).toHaveLength(count);
      expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
    }
  });

  test("desktop hotkeys use the current-focus route once and reject cancellation or a different authority before dispatch", async () => {
    for (const variant of ["deliver", "cancel", "wrong_authority"] as const) {
      const checked = port([apps(), windows(), result({ effect: "unverifiable", route: "global_input", delivery: { mode: "not_applicable" } })]);
      const subject = new CuaComputerUseAdapter({ port: checked.value });
      const observed = await subject.observe({ scope, operation: "desktop_state" });
      if (!observed.ok || !observed.observation.screenSnapshot) throw new Error("expected snapshot");
      const controller = new AbortController();
      if (variant === "cancel") controller.abort();
      const performed = await subject.hotkey({ scope: variant === "wrong_authority" ? { ...scope, originHumanId: "another-human" } : scope,
        signal: controller.signal, operation: { kind: "hotkey", scope: "desktop", target: observed.observation.screenSnapshot.target, keys: ["ctrl", "left"] } });
      expect(computerMutationReceiptSchema.safeParse(performed.receipt).success).toBe(true);
      expect(checked.dispatched.filter((call) => call.name === "hotkey")).toEqual(variant === "deliver"
        ? [{ name: "hotkey", args: { scope: "desktop", keys: ["ctrl", "left"] } }] : []);
      expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
    }
  });

  test("confirmed foreground input preserves exact-window read recovery without permitting replay", async () => {
    const state = result({ window_id: 90, pid: 42, element_count: 0, total_element_count: 0,
      returned_element_count: 0, elements_complete: false, elements: [], tree_markdown: "fixture", _note: "fixture" });
    const checked = port([apps(), windows(), apps(), windows(),
      result({ effect: "confirmed", route: "global_input", delivery: { mode: "foreground", delivered_count: 3 }, evidence: [{ kind: "value_readback" }] }),
      state,
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value, monotonicMilliseconds: () => 10_000,
      readHidIdleNanoseconds: async () => checked.dispatched.some(call => call.name === "type_text") ? 0 : 1_000_000_000 });
    const desktop = await subject.observe({ scope, operation: "desktop_state" });
    if (!desktop.ok) throw new Error("expected desktop observation");
    const target = desktop.observation.targets[0]!.target;
    const operation = { kind: "type_text" as const, target, text: "abc", deliveryMode: "foreground" as const };
    const typed = await subject.typeText({ scope, operation });
    expect(typed.receipt).toMatchObject({ completionCertainty: "completed", verification: "verified" });
    expect(subject.registry.resolveTarget(target.context, scope, target.reference)).toEqual({ ok: false, code: "replay_forbidden" });
    await subject.typeText({ scope, operation });
    expect(checked.dispatched.filter(call => call.name === "type_text")).toHaveLength(1);
    await expect(subject.observeWindowState({ scope, target })).resolves.toMatchObject({ ok: true, observation: { operation: "window_state" } });
    expect(checked.dispatched.filter(call => call.name === "list_apps")).toHaveLength(2);
    expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
  });

  test.each(["takeover", "cancel", "authority"] as const)("settled foreground recovery still fences %s", async (variant) => {
    const state = result({ window_id: 90, pid: 42, element_count: 0, total_element_count: 0,
      returned_element_count: 0, elements_complete: false, elements: [], tree_markdown: "fixture", _note: "fixture" });
    const checked = port([apps(), windows(), apps(), windows(),
      result({ effect: "confirmed", route: "global_input", delivery: { mode: "foreground", delivered_count: 3 }, evidence: [{ kind: "value_readback" }] }), state]);
    const subject = new CuaComputerUseAdapter({ port: checked.value, monotonicMilliseconds: () => 10_000,
      readHidIdleNanoseconds: async () => checked.dispatched.some(call => call.name === "get_window_state") ? 0
        : checked.dispatched.some(call => call.name === "type_text") ? 500_000_000 : 1_000_000_000 });
    const desktop = await subject.observe({ scope, operation: "desktop_state" });
    if (!desktop.ok) throw new Error("expected desktop observation");
    const target = desktop.observation.targets[0]!.target;
    await subject.typeText({ scope, operation: { kind: "type_text", target, text: "abc", deliveryMode: "foreground" } });
    const controller = new AbortController();
    if (variant === "cancel") controller.abort();
    const recovered = await subject.observeWindowState({
      scope: variant === "authority" ? { ...scope, grantGeneration: 2 } : scope, target, signal: controller.signal,
    });
    expect(recovered.ok).toBe(false);
    if (variant === "takeover") expect(recovered.outcome.externalInterference).toBe("user_input");
    else expect(checked.dispatched.filter(call => call.name === "get_window_state")).toHaveLength(0);
    expect(subject.registry.resolveTarget(target.context, scope, target.reference).ok).toBe(false);
    expect(checked.dispatched.filter(call => call.name === "type_text")).toHaveLength(1);
  });

  test("requires the pinned type-text ActionResult delivery count rather than inventing accounting", async () => {
    const axObservedAdapter = new CuaComputerUseAdapter({ port: port([apps(), windows()]).value });
    const axObserved = await axObservedAdapter.observe({ scope, operation: "desktop_state" });
    if (!axObserved.ok) throw new Error("expected AX observation");
    // A confirmed type_text receipt cannot fabricate its delivery accounting
    // from a private readback; 0.22 must supply the exact count.
    const axWithoutCount = port([
      apps(), windows(),
      result({ effect: "confirmed", route: "accessibility", delivery: { mode: "background" }, evidence: [{ kind: "value_readback" }] }),
    ]);
    const axCompleted = await new CuaComputerUseAdapter({ port: axWithoutCount.value, registry: axObservedAdapter.registry }).typeText({
      scope, operation: { kind: "type_text", target: axObserved.observation.targets[0]!.target, text: "abc" },
    });
    expect(axCompleted).toMatchObject({ ok: false, outcome: { providerCondition: "malformed_response", recovery: ["observe_again", "do_not_replay"] } });
    expect(axWithoutCount.invalidateCheckedGeneration).toHaveBeenCalledTimes(1);

    const foregroundObservedAdapter = new CuaComputerUseAdapter({ port: port([apps(), windows()]).value });
    const foregroundObserved = await foregroundObservedAdapter.observe({ scope, operation: "desktop_state" });
    if (!foregroundObserved.ok) throw new Error("expected foreground observation");
    const foreground = port([
      apps(), windows(),
      result({ code: "off_space_or_ax_unresolved", effect: "refused", pid: 42, window_id: 90, reason: "fixture", escalation: { recommended: "foreground", reason: "fixture" } }, true),
      // Legacy `key_events_fg` is normalized by the pinned dispatch seam to
      // the closed foreground global-input ActionResult.
      result({ effect: "confirmed", route: "global_input", delivery: { mode: "foreground", delivered_count: 3 }, evidence: [{ kind: "value_readback" }] }),
    ]);
    const foregroundCompleted = await new CuaComputerUseAdapter({ port: foreground.value, registry: foregroundObservedAdapter.registry }).typeText({
      scope, operation: { kind: "type_text", target: foregroundObserved.observation.targets[0]!.target, text: "abc" },
    });
    expect(foregroundCompleted).toMatchObject({
      ok: false,
      receipt: {
        deliveryMode: "foreground_escalated", completionCertainty: "completed",
        textDelivery: { requestedCharacters: 3, deliveredCharacters: 3 },
        providerAction: { route: "global_input", delivery: { mode: "foreground" } },
      },
      outcome: { targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"] },
    });
    expect(foregroundObservedAdapter.registry.resolveTarget(
      foregroundObserved.observation.targets[0]!.target.context,
      scope,
      foregroundObserved.observation.targets[0]!.target.reference,
    )).toEqual({ ok: false, code: "replay_forbidden" });
    expect(foreground.calls.filter((call) => call.name === "type_text").map((call) => call.args["delivery_mode"])).toEqual(["background", "foreground"]);

    const synthesisObservedAdapter = new CuaComputerUseAdapter({ port: port([apps(), windows()]).value });
    const synthesisObserved = await synthesisObservedAdapter.observe({ scope, operation: "desktop_state" });
    if (!synthesisObserved.ok) throw new Error("expected synthesis observation");
    const synthesis = port([
      apps(), windows(),
      // Exact delivery accounting from the bounded key-event observation does
      // not prove semantic landing; it remains unknown and non-replayable.
      result({ effect: "unverifiable", route: "synthetic_events", delivery: { mode: "background", delivered_count: 3 }, escalation: { target: "foreground", reason: "delivery_failed" } }),
    ]);
    const synthesisUnverifiable = await new CuaComputerUseAdapter({ port: synthesis.value, registry: synthesisObservedAdapter.registry }).typeText({
      scope, operation: { kind: "type_text", target: synthesisObserved.observation.targets[0]!.target, text: "abc" },
    });
    expect(synthesisUnverifiable).toMatchObject({
      ok: false,
      receipt: {
        completionCertainty: "unknown_completion",
        textDelivery: { requestedCharacters: 3, deliveredCharacters: null },
        providerAction: { effect: "unverifiable", route: "synthetic_events", delivery: { mode: "background", deliveredCount: 3 } },
      },
      outcome: { retrySafety: "observe_before_retry", recovery: ["observe_again", "do_not_replay"] },
    });
    expect(synthesis.invalidateCheckedGeneration).not.toHaveBeenCalled();
  });

  test("binds press-key ActionResult routes to the requested Cua delivery rung", async () => {
    const backgroundObservedAdapter = new CuaComputerUseAdapter({ port: port([apps(), windows()]).value });
    const backgroundObserved = await backgroundObservedAdapter.observe({ scope, operation: "desktop_state" });
    if (!backgroundObserved.ok) throw new Error("expected background observation");
    const background = port([
      apps(), windows(),
      result({ effect: "confirmed", route: "synthetic_events", delivery: { mode: "background" }, evidence: [{ kind: "value_readback" }] }),
    ]);
    await expect(new CuaComputerUseAdapter({ port: background.value, registry: backgroundObservedAdapter.registry }).pressKey({
      scope, operation: { kind: "press_key", target: backgroundObserved.observation.targets[0]!.target, key: "n", modifiers: ["cmd"] },
    })).resolves.toMatchObject({ ok: true, receipt: { deliveryMode: "background", completionCertainty: "completed" } });

    const foregroundObservedAdapter = new CuaComputerUseAdapter({ port: port([apps(), windows()]).value });
    const foregroundObserved = await foregroundObservedAdapter.observe({ scope, operation: "desktop_state" });
    if (!foregroundObserved.ok) throw new Error("expected foreground observation");
    const foreground = port([
      apps(), windows(),
      result({ code: "off_space_or_ax_unresolved", effect: "refused", pid: 42, window_id: 90, reason: "fixture", escalation: { recommended: "foreground", reason: "fixture" } }, true),
      result({ effect: "confirmed", route: "global_input", delivery: { mode: "foreground" }, evidence: [{ kind: "value_readback" }] }),
    ]);
    await expect(new CuaComputerUseAdapter({ port: foreground.value, registry: foregroundObservedAdapter.registry }).pressKey({
      scope, operation: { kind: "press_key", target: foregroundObserved.observation.targets[0]!.target, key: "n", modifiers: ["cmd"] },
    })).resolves.toMatchObject({ ok: false, receipt: { deliveryMode: "foreground_escalated", completionCertainty: "completed" }, outcome: { recovery: ["observe_again", "do_not_replay"] } });
    expect(foreground.calls.filter((call) => call.name === "press_key").map((call) => call.args["delivery_mode"]))
      .toEqual(["background", "foreground"]);

    const foregroundUnverifiableObservedAdapter = new CuaComputerUseAdapter({ port: port([apps(), windows()]).value });
    const foregroundUnverifiableObserved = await foregroundUnverifiableObservedAdapter.observe({ scope, operation: "desktop_state" });
    if (!foregroundUnverifiableObserved.ok) throw new Error("expected foreground-unverifiable observation");
    const foregroundUnverifiable = port([
      apps(), windows(),
      result({ code: "off_space_or_ax_unresolved", effect: "refused", pid: 42, window_id: 90, reason: "fixture", escalation: { recommended: "foreground", reason: "fixture" } }, true),
      // Pinned foreground `press_key` truthfully records global-input
      // dispatch without a readback when delivery cannot be verified.
      result({ effect: "unverifiable", route: "global_input", delivery: { mode: "foreground" } }),
    ]);
    const foregroundUnverifiableResult = await new CuaComputerUseAdapter({
      port: foregroundUnverifiable.value,
      registry: foregroundUnverifiableObservedAdapter.registry,
    }).pressKey({
      scope,
      operation: { kind: "press_key", target: foregroundUnverifiableObserved.observation.targets[0]!.target, key: "n", modifiers: ["cmd"] },
    });
    expect(foregroundUnverifiableResult).toMatchObject({
      ok: false,
      receipt: {
        action: "press_key", deliveryMode: "foreground_escalated", completionCertainty: "unknown_completion",
        providerAction: { effect: "unverifiable", route: "global_input", delivery: { mode: "foreground" } },
      },
      outcome: { retrySafety: "observe_before_retry", recovery: ["observe_again", "do_not_replay"] },
    });
    expect(foregroundUnverifiable.invalidateCheckedGeneration).not.toHaveBeenCalled();
    expect(foregroundUnverifiable.calls.filter((call) => call.name === "press_key").map((call) => call.args["delivery_mode"]))
      .toEqual(["background", "foreground"]);
  });

  test("fences press-key ActionResults whose public route does not match the requested delivery rung", async () => {
    const backgroundObservedAdapter = new CuaComputerUseAdapter({ port: port([apps(), windows()]).value });
    const backgroundObserved = await backgroundObservedAdapter.observe({ scope, operation: "desktop_state" });
    if (!backgroundObserved.ok) throw new Error("expected background observation");
    const wrongBackground = port([
      apps(), windows(),
      result({ effect: "confirmed", route: "global_input", delivery: { mode: "background" }, evidence: [{ kind: "value_readback" }] }),
    ]);
    await expect(new CuaComputerUseAdapter({ port: wrongBackground.value, registry: backgroundObservedAdapter.registry }).pressKey({
      scope, operation: { kind: "press_key", target: backgroundObserved.observation.targets[0]!.target, key: "n", modifiers: ["cmd"] },
    })).resolves.toMatchObject({ ok: false, outcome: { providerCondition: "malformed_response" } });
    expect(wrongBackground.invalidateCheckedGeneration).toHaveBeenCalledTimes(1);

    const foregroundObservedAdapter = new CuaComputerUseAdapter({ port: port([apps(), windows()]).value });
    const foregroundObserved = await foregroundObservedAdapter.observe({ scope, operation: "desktop_state" });
    if (!foregroundObserved.ok) throw new Error("expected foreground observation");
    const wrongForeground = port([
      apps(), windows(),
      result({ code: "off_space_or_ax_unresolved", effect: "refused", pid: 42, window_id: 90, reason: "fixture", escalation: { recommended: "foreground", reason: "fixture" } }, true),
      result({ effect: "confirmed", route: "synthetic_events", delivery: { mode: "foreground" }, evidence: [{ kind: "value_readback" }] }),
    ]);
    await expect(new CuaComputerUseAdapter({ port: wrongForeground.value, registry: foregroundObservedAdapter.registry }).pressKey({
      scope, operation: { kind: "press_key", target: foregroundObserved.observation.targets[0]!.target, key: "n", modifiers: ["cmd"] },
    })).resolves.toMatchObject({ ok: false, outcome: { providerCondition: "malformed_response" } });
    expect(wrongForeground.invalidateCheckedGeneration).toHaveBeenCalledTimes(1);
  });

  test("fences a legacy press-key envelope with a content-free stage discriminator", async () => {
    const observedAdapter = new CuaComputerUseAdapter({ port: port([apps(), windows()]).value });
    const observed = await observedAdapter.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected observation");
    const checked = port([apps(), windows(), result({ effect: "unverifiable", path: "key_events", verified: false, private_native_id: 77 })]);
    const pressed = await new CuaComputerUseAdapter({ port: checked.value, registry: observedAdapter.registry }).pressKey({
      scope, operation: { kind: "press_key", target: observed.observation.targets[0]!.target, key: "n", modifiers: ["cmd"] },
    });
    expect(pressed).toMatchObject({ ok: false, error: expect.stringContaining("legacy_action_projection"), outcome: { providerCondition: "malformed_response", recovery: ["observe_again", "do_not_replay"] } });
    expect(checked.invalidateCheckedGeneration).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(pressed);
    expect(serialized).not.toContain("key_events");
    expect(serialized).not.toContain("private_native_id");
  });

  test("withdraws the route for type/key ActionResults with omitted, wrong-rung, or mismatched delivery", async () => {
    const fixtures = [
      { effect: "confirmed", route: "accessibility", evidence: [{ kind: "value_readback" }] },
      { effect: "confirmed", route: "accessibility", delivery: { mode: "foreground", delivered_count: 3 }, evidence: [{ kind: "value_readback" }] },
      { effect: "confirmed", route: "accessibility", delivery: { mode: "background", delivered_count: 2 }, evidence: [{ kind: "value_readback" }] },
      { effect: "suspected_noop", route: "synthetic_events", delivery: { mode: "background" } },
      { effect: "confirmed", route: "accessibility", delivery: { mode: "background", delivered_count: 3 }, evidence: [{ kind: "window_change" }] },
      { effect: "confirmed", route: "accessibility", delivery: { mode: "background", delivered_count: 3 }, evidence: [{ kind: "value_readback" }], escalation: { target: "foreground", reason: "delivery_failed" } },
      { effect: "unverifiable", route: "synthetic_events", delivery: { mode: "background" } },
      // A background request must not accept an unrequested foreground branch.
      { effect: "unverifiable", route: "global_input", delivery: { mode: "foreground" } },
      { effect: "unverifiable", route: "synthetic_events", delivery: { mode: "background" }, evidence: [{ kind: "value_readback" }], escalation: { target: "foreground", reason: "delivery_failed" } },
      { effect: "unverifiable", route: "synthetic_events", delivery: { mode: "background", delivered_count: 1 }, escalation: { target: "foreground", reason: "delivery_failed" } },
      { effect: "unverifiable", route: "synthetic_events", delivery: { mode: "background", delivered_count: 4 }, escalation: { target: "foreground", reason: "delivery_failed" } },
    ];
    for (const fixture of fixtures) {
      const observedAdapter = new CuaComputerUseAdapter({ port: port([apps(), windows()]).value });
      const observed = await observedAdapter.observe({ scope, operation: "desktop_state" });
      if (!observed.ok) throw new Error("expected observation");
      const hostilePort = port([apps(), windows(), result(fixture)]);
      const hostile = await new CuaComputerUseAdapter({ port: hostilePort.value, registry: observedAdapter.registry }).typeText({
        scope, operation: { kind: "type_text", target: observed.observation.targets[0]!.target, text: "abc" },
      });
      expect(hostile).toMatchObject({ ok: false, outcome: { providerCondition: "malformed_response" } });
      expect(hostilePort.invalidateCheckedGeneration).toHaveBeenCalledTimes(1);
      if (hostile.ok) throw new Error("expected malformed receipt");
      expect(computerMutationReceiptSchema.safeParse(hostile.receipt).success).toBe(true);
    }
    for (const fixture of [
      { effect: "confirmed", route: "accessibility", delivery: { mode: "background" }, evidence: [{ kind: "value_readback" }] },
      { effect: "confirmed", route: "synthetic_events", delivery: { mode: "background", delivered_count: 1 }, evidence: [{ kind: "value_readback" }] },
    ]) {
      const observedAdapter = new CuaComputerUseAdapter({ port: port([apps(), windows()]).value });
      const observed = await observedAdapter.observe({ scope, operation: "desktop_state" });
      if (!observed.ok) throw new Error("expected observation");
      const hostilePort = port([apps(), windows(), result(fixture)]);
      await expect(new CuaComputerUseAdapter({ port: hostilePort.value, registry: observedAdapter.registry }).pressKey({
        scope, operation: { kind: "press_key", target: observed.observation.targets[0]!.target, key: "return", modifiers: [] },
      })).resolves.toMatchObject({ ok: false, outcome: { providerCondition: "malformed_response" } });
      expect(hostilePort.invalidateCheckedGeneration).toHaveBeenCalledTimes(1);
    }
  });

  test("preserves known text prefixes and fences an unverifiable post boundary without retaining the text", async () => {
    const observedPort = port([apps(), windows()]);
    const observedAdapter = new CuaComputerUseAdapter({ port: observedPort.value });
    const observed = await observedAdapter.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected observation");
    const target = observed.observation.targets[0]!.target;
    const partialPort = port([
      apps(), windows(),
      result({ code: "type_text_incomplete", path: "ax", effect: "partial", requested_chars: 3, delivered_chars: 2, retryable: true, retry_from_character: 2 }, true),
    ]);
    const partial = new CuaComputerUseAdapter({ port: partialPort.value, registry: observedAdapter.registry });
    const partialResult = await partial.typeText({ scope, operation: { kind: "type_text", target, text: "a😀b" } });
    expect(partialResult).toMatchObject({
      ok: false,
      receipt: { completionCertainty: "partially_completed", deliveryMode: "background", textDelivery: { requestedCharacters: 3, deliveredCharacters: 2 }, unexecutedRemainder: { count: 1, reason: "failed" } },
    });
    expect(JSON.stringify(partialResult)).not.toContain("a😀b");

    const uncertainPort = port([
      apps(), windows(),
      result({ effect: "unverifiable", route: "synthetic_events", delivery: { mode: "background" }, escalation: { target: "foreground", reason: "delivery_failed" } }),
    ]);
    const uncertain = new CuaComputerUseAdapter({ port: uncertainPort.value, registry: observedAdapter.registry });
    const uncertainResult = await uncertain.typeText({ scope, operation: { kind: "type_text", target, text: "private text" } });
    expect(uncertainResult).toMatchObject({
      ok: false,
      receipt: { completionCertainty: "unknown_completion", textDelivery: { requestedCharacters: 12, deliveredCharacters: null }, providerAction: { effect: "unverifiable", delivery: { mode: "background" } }, outcome: { recovery: ["observe_again", "do_not_replay"] } },
    });
    expect(JSON.stringify(uncertainResult)).not.toContain("private text");
    await expect(uncertain.typeText({ scope, operation: { kind: "type_text", target, text: "private text" } })).resolves.toMatchObject({
      ok: false, error: "The prior desktop action may have completed. Observe again; do not replay it.",
    });
  });

  test("fences pinned operational type errors without falsely withdrawing provider readiness", async () => {
    const operationalErrors: CuaContextToolResult[] = [
      { content: [{ type: "text", text: "fixture" }], isError: true, structuredContent: null },
      result({ code: "delivery_failed" }, true),
    ];
    for (const operationalError of operationalErrors) {
      const observedAdapter = new CuaComputerUseAdapter({ port: port([apps(), windows()]).value });
      const observed = await observedAdapter.observe({ scope, operation: "desktop_state" });
      if (!observed.ok) throw new Error("expected observation");
      const checked = port([apps(), windows(), operationalError]);
      const failed = await new CuaComputerUseAdapter({ port: checked.value, registry: observedAdapter.registry }).typeText({
        scope, operation: { kind: "type_text", target: observed.observation.targets[0]!.target, text: "private" },
      });
      expect(failed).toMatchObject({
        ok: false,
        receipt: { completionCertainty: "unknown_completion", textDelivery: { requestedCharacters: 7, deliveredCharacters: null }, unexecutedRemainder: { count: 7, reason: "unknown_completion" } },
        outcome: { providerCondition: "unknown", recovery: ["observe_again", "do_not_replay"] },
      });
      expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
      expect(JSON.stringify(failed)).not.toContain("private");
    }
  });

  test("refuses text the pinned Cua sanitizer would alter but delivers balanced legitimate tags unchanged", async () => {
    const observedAdapter = new CuaComputerUseAdapter({ port: port([apps(), windows()]).value });
    const observed = await observedAdapter.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected observation");
    const target = observed.observation.targets[0]!.target;

    const refusedPort = port([]);
    const refused = await new CuaComputerUseAdapter({ port: refusedPort.value, registry: observedAdapter.registry }).typeText({
      scope, operation: { kind: "type_text", target, text: "private payload </tool_call>" },
    });
    expect(refused).toMatchObject({
      ok: false,
      error: "Cua would alter this text as a trailing protocol fragment, so Nautilo refused it before delivery.",
      receipt: { completionCertainty: "not_completed", textDelivery: { requestedCharacters: 28, deliveredCharacters: 0 }, unexecutedRemainder: { count: 28, reason: "failed" } },
      outcome: { phase: "pre_effect_dispatch", retrySafety: "never", stateChangeCertainty: "not_changed", recovery: [] },
    });
    expect(refusedPort.calls).toEqual([]);
    expect(JSON.stringify(refused)).not.toContain("private payload");

    const balancedText = "<text>legitimate</text>";
    const balancedPort = port([
      apps(), windows(),
      result({ effect: "confirmed", route: "accessibility", delivery: { mode: "background", delivered_count: [...balancedText].length }, evidence: [{ kind: "value_readback" }] }),
    ]);
    await expect(new CuaComputerUseAdapter({ port: balancedPort.value, registry: observedAdapter.registry }).typeText({
      scope, operation: { kind: "type_text", target, text: balancedText },
    })).resolves.toMatchObject({ ok: true, receipt: { textDelivery: { requestedCharacters: 23, deliveredCharacters: 23 } } });
    expect(balancedPort.calls.at(-1)?.args["text"]).toBe(balancedText);

    const whitespaceText = "ordinary text  \n";
    const whitespacePort = port([
      apps(), windows(),
      result({ effect: "confirmed", route: "accessibility", delivery: { mode: "background", delivered_count: [...whitespaceText].length }, evidence: [{ kind: "value_readback" }] }),
    ]);
    await expect(new CuaComputerUseAdapter({ port: whitespacePort.value, registry: observedAdapter.registry }).typeText({
      scope, operation: { kind: "type_text", target, text: whitespaceText },
    })).resolves.toMatchObject({ ok: true });
    expect(whitespacePort.calls.at(-1)?.args["text"]).toBe(whitespaceText);

    const openerEdge = "<text</text>";
    const openerPort = port([
      apps(), windows(),
      result({ effect: "confirmed", route: "accessibility", delivery: { mode: "background", delivered_count: [...openerEdge].length }, evidence: [{ kind: "value_readback" }] }),
    ]);
    await expect(new CuaComputerUseAdapter({ port: openerPort.value, registry: observedAdapter.registry }).typeText({
      scope, operation: { kind: "type_text", target, text: openerEdge },
    })).resolves.toMatchObject({ ok: true });
    expect(openerPort.calls.at(-1)?.args["text"]).toBe(openerEdge);
  });

  test("returns exact non-circular chunk guidance and rejects hostile partial counts as route drift", async () => {
    const observedPort = port([apps(), windows()]);
    const observedAdapter = new CuaComputerUseAdapter({ port: observedPort.value });
    const observed = await observedAdapter.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected observation");
    const target = observed.observation.targets[0]!.target;
    const text = "abcdefghijkl";
    const chunkPort = port([
      apps(), windows(),
      result({
        code: "type_text_synthesis_budget_exceeded", path: "key_events", effect: "refused",
        requested_chars: 12, estimated_duration_ms: 120_000, synthesis_budget_ms: 100_000,
        per_character_ms: 10_000, max_chunk_chars: 4, synthesized_chars: 0,
        atomic_ax_effect: "rejected", retryable: true, delivered_chars: 0, retry_from_character: 0,
        escalation: { recommended: "chunk", reason: "bounded fixture" },
      }, true),
    ]);
    const chunked = await new CuaComputerUseAdapter({ port: chunkPort.value, registry: observedAdapter.registry })
      .typeText({ scope, operation: { kind: "type_text", target, text } });
    expect(chunked).toMatchObject({
      ok: false,
      error: "Cua refused text synthesis before delivery. Submit separate text chunks of at most 4 characters.",
      receipt: {
        deliveryMode: "not_delivered", completionCertainty: "not_completed", verification: "unavailable",
        textDelivery: { requestedCharacters: 12, deliveredCharacters: 0, maxChunkCharacters: 4 },
        unexecutedRemainder: { count: 12, reason: "failed" },
        outcome: { phase: "pre_effect_dispatch", retrySafety: "never", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "current", recovery: [] },
      },
    });
    expect(JSON.stringify(chunked)).not.toContain(text);
    expect(chunkPort.invalidateCheckedGeneration).not.toHaveBeenCalled();

    const hostilePort = port([
      apps(), windows(),
      result({ code: "type_text_incomplete", path: "ax", effect: "partial", requested_chars: 99, delivered_chars: 98, retryable: true, retry_from_character: 98 }, true),
    ]);
    const hostile = await new CuaComputerUseAdapter({ port: hostilePort.value, registry: observedAdapter.registry })
      .typeText({ scope, operation: { kind: "type_text", target, text: "abc" } });
    expect(hostile).toMatchObject({
      ok: false,
      receipt: { completionCertainty: "unknown_completion", textDelivery: { requestedCharacters: 3, deliveredCharacters: null }, unexecutedRemainder: { count: 3, reason: "unknown_completion" } },
      outcome: { providerCondition: "malformed_response", recovery: ["observe_again", "do_not_replay"] },
    });
    expect(hostilePort.invalidateCheckedGeneration).toHaveBeenCalledTimes(1);

    const wrongRungObservedAdapter = new CuaComputerUseAdapter({ port: port([apps(), windows()]).value });
    const wrongRungObserved = await wrongRungObservedAdapter.observe({ scope, operation: "desktop_state" });
    if (!wrongRungObserved.ok) throw new Error("expected wrong-rung observation");
    const wrongRungTarget = wrongRungObserved.observation.targets[0]!.target;
    const wrongRungPartialPort = port([
      apps(), windows(),
      result({ code: "type_text_incomplete", path: "key_events_fg", effect: "partial", requested_chars: 3, delivered_chars: 2, retryable: true, retry_from_character: 2 }, true),
    ]);
    await expect(new CuaComputerUseAdapter({ port: wrongRungPartialPort.value, registry: wrongRungObservedAdapter.registry }).typeText({
      scope, operation: { kind: "type_text", target: wrongRungTarget, text: "abc" },
    })).resolves.toMatchObject({ ok: false, outcome: { providerCondition: "malformed_response" } });
    expect(wrongRungPartialPort.invalidateCheckedGeneration).toHaveBeenCalledTimes(1);

    const synthesisObservedAdapter = new CuaComputerUseAdapter({ port: port([apps(), windows()]).value });
    const synthesisObserved = await synthesisObservedAdapter.observe({ scope, operation: "desktop_state" });
    if (!synthesisObserved.ok) throw new Error("expected synthesis observation");
    const wrongRungSynthesisPort = port([
      apps(), windows(),
      result({
        code: "type_text_synthesis_budget_exceeded", path: "key_events_fg", effect: "refused",
        requested_chars: 12, estimated_duration_ms: 120_000, synthesis_budget_ms: 100_000,
        per_character_ms: 10_000, max_chunk_chars: 4, synthesized_chars: 0,
        atomic_ax_effect: "rejected", retryable: true, delivered_chars: 0, retry_from_character: 0,
        escalation: { recommended: "chunk", reason: "bounded fixture" },
      }, true),
    ]);
    await expect(new CuaComputerUseAdapter({ port: wrongRungSynthesisPort.value, registry: synthesisObservedAdapter.registry }).typeText({
      scope, operation: { kind: "type_text", target: synthesisObserved.observation.targets[0]!.target, text },
    })).resolves.toMatchObject({ ok: false, outcome: { providerCondition: "malformed_response" } });
    expect(wrongRungSynthesisPort.invalidateCheckedGeneration).toHaveBeenCalledTimes(1);
  });

  test("keeps a second-rung session failure pre-effect after Cua's proven background refusal", async () => {
    const observedPort = port([apps(), windows()]);
    const observedAdapter = new CuaComputerUseAdapter({ port: observedPort.value });
    const observed = await observedAdapter.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected observation");
    const target = observed.observation.targets[0]!.target;
    const calls: Array<{ name: CuaContextToolName; args: Readonly<Record<string, unknown>> }> = [];
    const foregroundPort: CuaCheckedContextPort = {
      generation,
      callContextTool: async (_scope, name, args) => {
        calls.push({ name, args });
        if (name === "list_apps") return { ok: true, generation, sessionId, result: apps() };
        if (name === "list_windows") return { ok: true, generation, sessionId, result: windows() };
        if (args["delivery_mode"] === "background") return {
          ok: true, generation, sessionId,
          result: result({
            code: "SCREEN_SHARING_REQUIRES_FOREGROUND_HID", effect: "refused",
            escalation: { recommended: "foreground", reason: "foreground required", requires: ["window_id"] },
          }, true),
        };
        return { ok: false, code: "session_start_failed", stage: "session" };
      },
      launchApplication: unusedCheckedCall,
      getWindowState: unusedCheckedCall,
      captureDesktopState: async () => ({ ok: false, code: "context_fenced" }),
      clickDesktop: async () => ({ ok: false, code: "context_fenced", stage: "session" }),
      endContextLease: async () => undefined,
    };
    await expect(new CuaComputerUseAdapter({ port: foregroundPort, registry: observedAdapter.registry }).typeText({
      scope, operation: { kind: "type_text", target, text: "safe" },
    })).resolves.toMatchObject({
      ok: false,
      error: "Cua could not begin foreground desktop input after its safe background refusal.",
      receipt: { completionCertainty: "not_completed", deliveryMode: "not_delivered", textDelivery: { requestedCharacters: 4, deliveredCharacters: 0 }, outcome: { phase: "pre_effect_dispatch", stateChangeCertainty: "not_changed" } },
    });
    expect(calls.filter((call) => call.name === "type_text").map((call) => call.args["delivery_mode"]))
      .toEqual(["background", "foreground"]);

    const hostileKeyPort = port([
      apps(), windows(),
      result({ code: "SCREEN_SHARING_REQUIRES_FOREGROUND_HID", effect: "refused", escalation: { recommended: "foreground", reason: "fixture", requires: ["window_id"] } }, true),
    ]);
    await expect(new CuaComputerUseAdapter({ port: hostileKeyPort.value, registry: observedAdapter.registry }).pressKey({
      scope, operation: { kind: "press_key", target, key: "return", modifiers: [] },
    })).resolves.toMatchObject({ ok: false, outcome: { providerCondition: "malformed_response" } });
    expect(hostileKeyPort.calls.filter((call) => call.name === "press_key").map((call) => call.args["delivery_mode"]))
      .toEqual(["background"]);
    expect(hostileKeyPort.invalidateCheckedGeneration).toHaveBeenCalledTimes(1);
  });

  test("preserves pinned foreground synthesis refusal and non-fronted foreground partial truth", async () => {
    const observedAdapter = new CuaComputerUseAdapter({ port: port([apps(), windows()]).value });
    const observed = await observedAdapter.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected observation");
    const target = observed.observation.targets[0]!.target;
    const screenRefusal = result({ code: "SCREEN_SHARING_REQUIRES_FOREGROUND_HID", effect: "refused", escalation: { recommended: "foreground", reason: "fixture", requires: ["window_id"] } }, true);
    const synthesisPort = port([
      apps(), windows(), screenRefusal,
      result({
        code: "type_text_synthesis_budget_exceeded", path: "key_events_fg", effect: "refused",
        requested_chars: 12, estimated_duration_ms: 120_000, synthesis_budget_ms: 100_000,
        per_character_ms: 10_000, max_chunk_chars: 4, synthesized_chars: 0,
        atomic_ax_effect: "not_attempted", retryable: true, delivered_chars: 0, retry_from_character: 0,
        escalation: { recommended: "chunk", reason: "bounded fixture" },
      }, true),
    ]);
    await expect(new CuaComputerUseAdapter({ port: synthesisPort.value, registry: observedAdapter.registry }).typeText({
      scope, operation: { kind: "type_text", target, text: "abcdefghijkl" },
    })).resolves.toMatchObject({ ok: false, receipt: { completionCertainty: "not_completed", textDelivery: { maxChunkCharacters: 4 } } });
    expect(synthesisPort.invalidateCheckedGeneration).not.toHaveBeenCalled();

    const partialObservedAdapter = new CuaComputerUseAdapter({ port: port([apps(), windows()]).value });
    const partialObserved = await partialObservedAdapter.observe({ scope, operation: "desktop_state" });
    if (!partialObserved.ok) throw new Error("expected partial observation");
    const partialPort = port([
      apps(), windows(), screenRefusal,
      result({ code: "type_text_incomplete", path: "key_events", effect: "partial", requested_chars: 3, delivered_chars: 2, retryable: true, retry_from_character: 2 }, true),
    ]);
    await expect(new CuaComputerUseAdapter({ port: partialPort.value, registry: partialObservedAdapter.registry }).typeText({
      scope, operation: { kind: "type_text", target: partialObserved.observation.targets[0]!.target, text: "abc" },
    })).resolves.toMatchObject({ ok: false, receipt: { completionCertainty: "partially_completed", deliveryMode: "background", textDelivery: { deliveredCharacters: 2 } } });
    expect(partialPort.invalidateCheckedGeneration).not.toHaveBeenCalled();

    const unverifiableObservedAdapter = new CuaComputerUseAdapter({ port: port([apps(), windows()]).value });
    const unverifiableObserved = await unverifiableObservedAdapter.observe({ scope, operation: "desktop_state" });
    if (!unverifiableObserved.ok) throw new Error("expected unverifiable observation");
    const unverifiablePort = port([
      apps(), windows(), screenRefusal,
      result({ effect: "unverifiable", route: "global_input", delivery: { mode: "foreground" } }),
    ]);
    await expect(new CuaComputerUseAdapter({ port: unverifiablePort.value, registry: unverifiableObservedAdapter.registry }).typeText({
      scope, operation: { kind: "type_text", target: unverifiableObserved.observation.targets[0]!.target, text: "abc" },
    })).resolves.toMatchObject({ ok: false, receipt: { completionCertainty: "unknown_completion", deliveryMode: "foreground_escalated" }, outcome: { providerCondition: "ready" } });
    expect(unverifiablePort.invalidateCheckedGeneration).not.toHaveBeenCalled();
  });

  test("accepts only the five pinned background refusal envelopes and never loops unchanged requests", async () => {
    const observedAdapter = new CuaComputerUseAdapter({ port: port([apps(), windows()]).value });
    const observed = await observedAdapter.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected observation");
    const target = observed.observation.targets[0]!.target;
    const fixtures = [
      { code: "window_not_found", reason: "fixture", expectedTarget: "stale" },
      { code: "owner_pid_mismatch", reason: "fixture", expectedTarget: "stale" },
      { code: "minimized_or_hidden_window", reason: "fixture", escalation: { recommended: "accessibility", reason: "fixture" }, expectedTarget: "unavailable" },
      { code: "same_pid_keyboard_ambiguity", reason: "fixture", escalation: { recommended: "accessibility", reason: "fixture" }, expectedTarget: "current" },
    ] as const;
    for (const fixture of fixtures) {
      const { expectedTarget, ...providerFixture } = fixture;
      const checked = port([apps(), windows(), result({ effect: "refused", pid: 42, window_id: 90, ...providerFixture }, true)]);
      const refusal = await new CuaComputerUseAdapter({ port: checked.value, registry: observedAdapter.registry }).typeText({
        scope, operation: { kind: "type_text", target, text: "safe" },
      });
      expect(refusal).toMatchObject({ ok: false, receipt: { completionCertainty: "not_completed" }, outcome: { retrySafety: "never", stateChangeCertainty: "not_changed", targetCondition: expectedTarget } });
      expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
    }

    const foreground = port([
      apps(), windows(),
      result({ code: "off_space_or_ax_unresolved", effect: "refused", pid: 42, window_id: 90, reason: "fixture", escalation: { recommended: "foreground", reason: "fixture" } }, true),
      result({ effect: "confirmed", route: "global_input", delivery: { mode: "foreground", delivered_count: 4 }, evidence: [{ kind: "value_readback" }] }),
    ]);
    await expect(new CuaComputerUseAdapter({ port: foreground.value, registry: observedAdapter.registry }).typeText({
      scope, operation: { kind: "type_text", target, text: "safe" },
    })).resolves.toMatchObject({ ok: false, receipt: { deliveryMode: "foreground_escalated", completionCertainty: "completed" }, outcome: { recovery: ["observe_again", "do_not_replay"] } });
    expect(observedAdapter.registry.resolveTarget(target.context, scope, target.reference)).toEqual({ ok: false, code: "replay_forbidden" });
    expect(foreground.calls.filter((call) => call.name === "type_text").map((call) => call.args["delivery_mode"]))
      .toEqual(["background", "foreground"]);
  });

  test("withdraws the checked route on malformed successful action and verify output, but not semantic provider errors", async () => {
    const observedPort = port([apps(), windows()]);
    const observedAdapter = new CuaComputerUseAdapter({ port: observedPort.value });
    const observed = await observedAdapter.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected observation");
    const target = observed.observation.targets[0]!.target;

    const malformedActionPort = port([apps(), windows(), result({ effect: "confirmed", route: "accessibility", evidence: [{ kind: "value_readback" }], extra: true })]);
    await expect(new CuaComputerUseAdapter({ port: malformedActionPort.value, registry: observedAdapter.registry }).pressKey({
      scope, operation: { kind: "press_key", target, key: "return", modifiers: [] },
    })).resolves.toMatchObject({ ok: false, outcome: { providerCondition: "malformed_response" } });
    expect(malformedActionPort.invalidateCheckedGeneration).toHaveBeenCalledTimes(1);

    // Use a fresh observation because the malformed mutation correctly fenced
    // the prior retained context.
    const freshObservedPort = port([apps(), windows()]);
    const freshAdapter = new CuaComputerUseAdapter({ port: freshObservedPort.value });
    const freshObserved = await freshAdapter.observe({ scope, operation: "desktop_state" });
    if (!freshObserved.ok) throw new Error("expected fresh observation");
    const freshTarget = freshObserved.observation.targets[0]!.target;
    const malformedVerifyPort = port([
      apps(), windows(),
      result({ status: "satisfied", stable: true, elapsed_ms: 0, samples: 1, predicates: [{ index: 0, status: "satisfied", unknown_reason: null, observed_json: null }], extra: true }),
    ]);
    await expect(new CuaComputerUseAdapter({ port: malformedVerifyPort.value, registry: freshAdapter.registry }).verify({
      scope, target: freshTarget, expect: [{ window: { exists: true } }],
    })).resolves.toMatchObject({ ok: false, outcome: { providerCondition: "malformed_response" } });
    expect(malformedVerifyPort.invalidateCheckedGeneration).toHaveBeenCalledTimes(1);

    const providerErrorPort = port([apps(), windows(), result({ code: "provider_busy" }, true)]);
    const providerErrorAdapter = new CuaComputerUseAdapter({ port: providerErrorPort.value, registry: freshAdapter.registry });
    await expect(providerErrorAdapter.verify({ scope, target: freshTarget, expect: [{ window: { exists: true } }] }))
      .resolves.toMatchObject({ ok: false, outcome: { providerCondition: "unknown" } });
    expect(providerErrorPort.invalidateCheckedGeneration).not.toHaveBeenCalled();
  });

  test("converts the qualified stable verification to Cua snake case and discards observed content", async () => {
    const observedPort = port([apps(), windows()]);
    const observedAdapter = new CuaComputerUseAdapter({ port: observedPort.value });
    const observed = await observedAdapter.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected observation");
    const target = observed.observation.targets[0]!.target;
    const verifyPort = port([
      apps(), windows(),
      result({ status: "satisfied", stable: true, elapsed_ms: 0, samples: 2, predicates: [{ index: 0, status: "satisfied", unknown_reason: null, observed_json: "{\\\"private\\\":\\\"text\\\"}" }] }),
    ]);
    const verified = await new CuaComputerUseAdapter({ port: verifyPort.value, registry: observedAdapter.registry }).verify({
      scope, target, expect: [{ element: { selector: { role: "AXTextField", labelContains: "Account" }, valueEquals: "not-retained" } }],
    });
    expect(verified).toMatchObject({
      ok: true,
      verification: { status: "satisfied", stable: true, elapsedMs: 0, samples: 2, predicates: [{ index: 0, status: "satisfied", unknownReason: null }], outcome: { phase: "post_effect_verification", retrySafety: "never", stateChangeCertainty: "not_applicable" } },
    });
    expect(verifyPort.calls.at(-1)).toEqual({ name: "verify_state", args: {
      pid: 42, window_id: 90, timeout_ms: 2000, stable_samples: 2, include_screenshot: false,
      expect: [{ element: { selector: { role: "AXTextField", label_contains: "Account" }, value_equals: "not-retained" } }],
    } });
    expect(JSON.stringify(verified)).not.toContain("private");
    expect(JSON.stringify(verified)).not.toContain("not-retained");
    if (!verified.ok) throw new Error("expected verification receipt");
    expect(computerVerificationReceiptSchema.safeParse(verified.verification).success).toBe(true);
  });

  test("withdraws verification readiness for wrong count, insufficient stable proof, unstable satisfied, and wrong aggregate precedence", async () => {
    const observedAdapter = new CuaComputerUseAdapter({ port: port([apps(), windows()]).value });
    const observed = await observedAdapter.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected observation");
    const target = observed.observation.targets[0]!.target;
    const predicate = (index: number, status: "satisfied" | "unsatisfied" | "unknown") => ({
      index, status, unknown_reason: status === "unknown" ? "stability_unproven" : null, observed_json: null,
    });
    const cases = [
      { expect: [{ window: { exists: true } }, { window: { exists: true } }], output: { status: "satisfied", stable: true, elapsed_ms: 0, samples: 1, predicates: [predicate(0, "satisfied")] } },
      { expect: [{ window: { exists: true } }], output: { status: "satisfied", stable: true, elapsed_ms: 0, samples: 1, predicates: [predicate(0, "satisfied")] } },
      { expect: [{ window: { exists: true } }], output: { status: "unsatisfied", stable: true, elapsed_ms: 0, samples: 1, predicates: [predicate(0, "unsatisfied")] } },
      { expect: [{ window: { exists: true } }, { window: { exists: true } }], output: { status: "unknown", stable: false, elapsed_ms: 0, samples: 1, predicates: [predicate(0, "unsatisfied"), predicate(1, "unknown")] } },
    ];
    for (const hostileCase of cases) {
      const hostilePort = port([apps(), windows(), result(hostileCase.output)]);
      await expect(new CuaComputerUseAdapter({ port: hostilePort.value, registry: observedAdapter.registry }).verify({
        scope, target, expect: hostileCase.expect,
      })).resolves.toMatchObject({ ok: false, outcome: { providerCondition: "malformed_response" } });
      expect(hostilePort.invalidateCheckedGeneration).toHaveBeenCalledTimes(1);
    }
  });

  test("keeps a pinned typed pre-delivery refusal non-mutating, but fences aborted post-boundary delivery", async () => {
    const typedRefusal = result({ code: "bring_to_front_window_not_found", pid: 42, window_id: 90, activated: false, request_accepted: false }, true);
    const checked = port([apps(), windows(), apps(), windows(), typedRefusal, apps(), windows(), focused()]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const observed = await subject.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected observation");
    const target = observed.observation.targets[0]!.target;
    await expect(subject.focus({ scope, operation: { kind: "focus", target } })).resolves.toMatchObject({ ok: false, receipt: { completionCertainty: "not_completed" } });
    await expect(subject.focus({ scope, operation: { kind: "focus", target } })).resolves.toMatchObject({ ok: true, receipt: { completionCertainty: "completed" } });

    const controller = new AbortController();
    const abortedPort = port([apps(), windows(), apps(), windows(), focused()]);
    const aborted = new CuaComputerUseAdapter({ port: {
      ...abortedPort.value,
      callContextTool: async (currentScope, name, args, signal) => {
        const response = await abortedPort.value.callContextTool(currentScope, name, args, signal);
        if (name === "bring_to_front") controller.abort();
        return response;
      },
    } });
    const abortedObservation = await aborted.observe({ scope, operation: "desktop_state" });
    if (!abortedObservation.ok) throw new Error("expected observation");
    const abortedTarget = abortedObservation.observation.targets[0]!.target;
    await expect(aborted.focus({ scope, signal: controller.signal, operation: { kind: "focus", target: abortedTarget } }))
      .resolves.toMatchObject({ ok: false, receipt: { completionCertainty: "unknown_completion" } });
    await expect(aborted.focus({ scope, operation: { kind: "focus", target: abortedTarget } }))
      .resolves.toMatchObject({ ok: false, error: "The prior desktop action may have completed. Observe again; do not replay it." });
  });

  test("accepts byte-exact pinned focus refusals including required owner_pid and layer facts", async () => {
    const observedAdapter = new CuaComputerUseAdapter({ port: port([apps(), windows()]).value });
    const observed = await observedAdapter.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected observation");
    const target = observed.observation.targets[0]!.target;
    const refusals = [
      { code: "bring_to_front_pid_not_found", pid: 42, activated: false, request_accepted: false },
      { code: "bring_to_front_window_id_out_of_range", pid: 42, window_id: 90, activated: false, request_accepted: false },
      { code: "bring_to_front_window_not_found", pid: 42, window_id: 90, activated: false, request_accepted: false },
      { code: "bring_to_front_window_pid_mismatch", pid: 42, window_id: 90, owner_pid: 43, activated: false, request_accepted: false },
      { code: "bring_to_front_window_not_ordinary", pid: 42, window_id: 90, layer: 2, activated: false, request_accepted: false },
    ];
    for (const refusal of refusals) {
      const checked = port([apps(), windows(), result(refusal, true)]);
      await expect(new CuaComputerUseAdapter({ port: checked.value, registry: observedAdapter.registry }).focus({
        scope, operation: { kind: "focus", target },
      })).resolves.toMatchObject({
        ok: false, receipt: { completionCertainty: "not_completed" },
        outcome: { phase: "pre_effect_dispatch", retrySafety: "never", stateChangeCertainty: "not_changed", recovery: ["observe_again"] },
      });
      expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
    }
  });

  test("keeps a supervisor session-stage focus failure pre-effect and reusable", async () => {
    const observedPort = port([apps(), windows()]);
    const observedAdapter = new CuaComputerUseAdapter({ port: observedPort.value });
    const observed = await observedAdapter.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected observation");
    const target = observed.observation.targets[0]!.target;
    let index = 0;
    const endContextLease = mock(async () => undefined);
    const sessionThenSuccess: CuaCheckedContextPort = {
      generation,
      captureDesktopState: async () => ({ ok: false, code: "context_fenced" }),
      clickDesktop: async () => ({ ok: false, code: "context_fenced", stage: "session" }),
      callContextTool: async (_scope, name) => {
        index += 1;
        if (index === 3) return { ok: false as const, code: "session_start_failed" as const, stage: "session" as const };
        const fixture = name === "list_apps" ? apps() : name === "list_windows" ? windows() : focused();
        return { ok: true as const, generation, sessionId, result: fixture };
      },
      launchApplication: unusedCheckedCall,
      getWindowState: unusedCheckedCall,
      endContextLease,
    };
    const subject = new CuaComputerUseAdapter({ port: sessionThenSuccess, registry: observedAdapter.registry });
    await expect(subject.focus({ scope, operation: { kind: "focus", target } })).resolves.toMatchObject({
      ok: false,
      receipt: { deliveryMode: "not_delivered", completionCertainty: "not_completed", outcome: { phase: "pre_effect_dispatch", stateChangeCertainty: "not_changed", retrySafety: "observe_before_retry" } },
    });
    await expect(subject.focus({ scope, operation: { kind: "focus", target } })).resolves.toMatchObject({
      ok: true,
      receipt: { completionCertainty: "completed", verification: "verified" },
    });
    // The failed session did not acquire a lease; the five successful
    // preflight/mutation calls released their exact session leases.
    expect(endContextLease).toHaveBeenCalledTimes(5);
  });

  test("treats a thrown preflight as not-completed and releases every acquired lease on a session mismatch", async () => {
    const endContextLease = mock(async () => undefined);
    const rejecting: CuaCheckedContextPort = {
      generation,
      captureDesktopState: async () => ({ ok: false, code: "context_fenced" }),
      clickDesktop: async () => ({ ok: false, code: "context_fenced", stage: "session" }),
      callContextTool: async () => { throw new Error("preflight transport unavailable"); },
      launchApplication: unusedCheckedCall,
      getWindowState: unusedCheckedCall,
      endContextLease,
    };
    const registrySubject = new CuaComputerUseAdapter({ port: port([apps(), windows()]).value });
    const observed = await registrySubject.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected observation");
    // Use the same retained opaque target while replacing only the checked port.
    const preflightSubject = new CuaComputerUseAdapter({ port: rejecting, registry: registrySubject.registry });
    await expect(preflightSubject.focus({ scope, operation: { kind: "focus", target: observed.observation.targets[0]!.target } }))
      .resolves.toMatchObject({ ok: false, receipt: { completionCertainty: "not_completed", outcome: { phase: "pre_effect_dispatch", stateChangeCertainty: "not_changed" } } });

    const calls: CuaContextToolName[] = [];
    const mismatch: CuaCheckedContextPort = {
      generation,
      captureDesktopState: async () => ({ ok: false, code: "context_fenced" }),
      clickDesktop: async () => ({ ok: false, code: "context_fenced", stage: "session" }),
      callContextTool: async (_scope, name) => {
        calls.push(name);
        return { ok: true, generation, sessionId: name === "list_apps" ? "session-a" : "session-b", result: name === "list_apps" ? apps() : windows() };
      },
      launchApplication: unusedCheckedCall,
      getWindowState: unusedCheckedCall,
      endContextLease,
    };
    await expect(new CuaComputerUseAdapter({ port: mismatch }).observe({ scope: { ...scope, computerUseContextId: "other" }, operation: "desktop_state" }))
      .resolves.toMatchObject({ ok: false, code: "provider_malformed" });
    expect(calls).toEqual(["list_apps", "list_windows"]);
    expect(endContextLease).toHaveBeenCalledWith({ ...scope, computerUseContextId: "other" }, generation, "session-a");
    expect(endContextLease).toHaveBeenCalledWith({ ...scope, computerUseContextId: "other" }, generation, "session-b");
  });

  test("fences immediately after a malformed post-boundary focus result and never replays it", async () => {
    const malformedProof = result({
      status: "activated", code: "bring_to_front_exact_window_verified", pid: 42, window_id: 90,
      activated: true, request_accepted: true, process_activated: true,
      exact_window_effect: { verified: true, focused: true, frontmost_ordinary: false, target_visible_ordinary: true },
    });
    const checked = port([apps(), windows(), apps(), windows(), malformedProof]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const observed = await subject.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected observation");
    const target = observed.observation.targets[0]!.target;
    await expect(subject.focus({ scope, operation: { kind: "focus", target } })).resolves.toMatchObject({
      ok: false,
      receipt: { completionCertainty: "unknown_completion", deliveryMode: "unknown", outcome: { recovery: ["observe_again", "do_not_replay"] } },
    });
    await expect(subject.focus({ scope, operation: { kind: "focus", target } })).resolves.toMatchObject({
      ok: false,
      error: "The prior desktop action may have completed. Observe again; do not replay it.",
      receipt: { completionCertainty: "not_completed" },
    });
  });

  test("composes fourteen indistinguishable TextEdit siblings into one fresh element-token write and verified sentinel", async () => {
    const siblingRows = Array.from({ length: 14 }, (_, index) => ({
      window_id: 500 + index, pid: 77, app_name: "TextEdit", title: "Untitled",
      bounds: { x: 1, y: 2, width: 800, height: 600 }, layer: 0, z_index: index,
      is_on_screen: true, current_space_id: 1, on_current_space: true, space_ids: [1],
    }));
    const newRow = { ...siblingRows[0]!, window_id: 900 };
    const stateFor = (windowId: number, elements: readonly Record<string, unknown>[] = []) => result({
      window_id: windowId, pid: 77, element_count: elements.length, total_element_count: elements.length,
      returned_element_count: elements.length, elements_complete: false, tree_markdown: "private tree", elements, _note: "private note",
    });
    const sentinel = "TEST-SENTINEL";
    const checked = port([
      result({ windows: siblingRows, current_space_id: 1 }),
      result({ effect: "unverifiable", route: "accessibility", delivery: { mode: "foreground" } }),
      result({ windows: [...siblingRows, newRow], current_space_id: 1 }),
      stateFor(900, [{ role: "AXTextArea", element_token: "private-element-token", enabled: true }]),
      stateFor(900, [{ role: "AXTextArea", element_token: "private-fresh-element-token", enabled: true }]),
      installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true, launch_path: "/System/Applications/TextEdit.app", kind: "application", last_used: null, windows: [] }]),
      result({ windows: [newRow], current_space_id: 1 }),
      result({ effect: "confirmed", route: "accessibility", delivery: { mode: "background", delivered_count: [...sentinel].length }, evidence: [{ kind: "value_readback" }] }),
      installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true, launch_path: "/System/Applications/TextEdit.app", kind: "application", last_used: null, windows: [] }]),
      result({ windows: [newRow], current_space_id: 1 }),
      result({ status: "satisfied", stable: true, elapsed_ms: 12, samples: 2, predicates: [{ index: 0, status: "satisfied", unknown_reason: null, observed_json: JSON.stringify(sentinel) }] }),
    ]);
    const registry = new ComputerUseContextRegistry();
    const initial = registry.create(scope);
    if (!initial.ok) throw new Error("expected initial app context");
    const app = registry.registerTargets(initial.data.context, scope, [{
      evidence: { kind: "app", appLabel: "TextEdit" },
      providerTarget: { provider: "cua", operation: "observe_only", app: "TextEdit", pid: 77, bundleId: "com.apple.TextEdit" },
    }]);
    if (!app.ok) throw new Error("expected TextEdit app target");
    const subject = new CuaComputerUseAdapter({
      port: checked.value, registry,
      readHidIdleNanoseconds: async () => 1_000_000_000,
      monotonicMilliseconds: () => 10_000,
    });
    const created = await subject.createWindow({ scope, operation: { kind: "create_window", target: { context: initial.data.context, reference: app.data[0]!.reference }, menuPath: ["File", "New"] } });
    expect(created).toMatchObject({ ok: true, receipt: { action: "create_window", completionCertainty: "completed", verification: "verified", postObservation: { disposition: "unique" } } });
    if (!created.ok) throw new Error("expected created receipt");
    expect(computerMutationReceiptSchema.safeParse(created.receipt).success).toBe(true);
    if (!created.ok || created.receipt.postObservation?.disposition !== "unique") throw new Error("expected unique successor");
    const handoff = created.receipt.postObservation;
    expect(handoff.app.target.context).not.toBe(initial.data.context);
    expect(handoff.window.target.context).toBe(handoff.app.target.context);
    expect(registry.resolveTarget(initial.data.context, scope, app.data[0]!.reference)).toEqual({ ok: false, code: "not_found" });
    const state = await subject.observeWindowState({ scope, target: handoff.window.target, selector: { role: "text_area" } });
    expect(state).toMatchObject({ ok: true, observation: { element: { evidence: { kind: "element", role: "text_area", action: "type_text" } }, outcome: { retrySafety: "safe", recovery: ["retry_same_request"] } } });
    if (state.ok) {
      const publicState = windowStateObservationSchema.safeParse(state.observation);
      if (!publicState.success) throw new Error(JSON.stringify(publicState.error.issues));
    }
    if (!state.ok || state.observation.element === undefined) throw new Error("expected one fresh text element");
    const repeated = await subject.observeWindowState({ scope, target: handoff.window.target, selector: { role: "text_area" } });
    expect(repeated).toMatchObject({ ok: true, observation: { element: { selector: { role: "text_area" }, disposition: "unique" }, outcome: { retrySafety: "safe", recovery: ["retry_same_request"] } } });
    expect(checked.calls.filter((call) => call.name === "get_window_state" && call.args.window_id === 900)).toHaveLength(2);
    if (state.observation.element.target === undefined || !repeated.ok || repeated.observation.element?.target === undefined) throw new Error("expected refreshed writer target");
    expect(registry.resolveTarget(state.observation.element.target.context, scope, state.observation.element.target.reference)).toEqual({ ok: false, code: "not_found" });
    const freshTarget = repeated.observation.element.target;
    const sanitized = await subject.typeText({ scope, operation: { kind: "type_text", target: freshTarget, text: "private payload </tool_call>" } });
    expect(sanitized).toMatchObject({ ok: false, receipt: { completionCertainty: "not_completed", outcome: { recovery: [] } } });
    expect(checked.calls.filter((call) => call.name === "type_text")).toHaveLength(0);
    const typed = await subject.typeText({ scope, operation: { kind: "type_text", target: freshTarget, text: sentinel } });
    expect(typed).toMatchObject({ ok: true, receipt: { deliveryMode: "background", completionCertainty: "completed" } });
    if (!typed.ok) throw new Error("expected typed receipt");
    const typedReceipt = computerMutationReceiptSchema.safeParse(typed.receipt);
    if (!typedReceipt.success) throw new Error(JSON.stringify(typedReceipt.error.issues));
    expect(JSON.stringify(typed.receipt)).not.toMatch(/private-element-token|private tree|private note|"pid"|"window_id"|TEST-SENTINEL/);
    const verified = await subject.verify({ scope, target: handoff.window.target, expect: [{ element: { selector: { role: "text_area" }, valueEquals: sentinel } }] });
    expect(verified).toMatchObject({ ok: true, verification: { status: "satisfied", stable: true, samples: 2 } });
    expect(checked.calls.filter((call) => call.name === "invoke_menu")).toEqual([{ name: "invoke_menu", args: { pid: 77, window_id: 513, path: ["File", "New"] } }]);
    expect(checked.calls.filter((call) => call.name === "type_text")).toEqual([{ name: "type_text", args: { pid: 77, window_id: 900, element_token: "private-fresh-element-token", text: sentinel, delivery_mode: "background" } }]);
    expect(checked.calls.filter((call) => call.name === "type_text" && call.args.delivery_mode === "foreground")).toHaveLength(0);
    expect(checked.calls.filter((call) => call.name === "verify_state")).toMatchObject([{ args: { timeout_ms: 2_000, stable_samples: 2, include_screenshot: false, expect: [{ element: { selector: { role: "AXTextArea" }, value_equals: sentinel } }] } }]);
    const consumed = await subject.typeText({ scope, operation: { kind: "type_text", target: freshTarget, text: sentinel } });
    expect(consumed).toMatchObject({ ok: false, receipt: { completionCertainty: "not_completed", resolvedTarget: { kind: "element", state: "unavailable" } } });
    if (consumed.ok) throw new Error("expected consumed element target");
    const consumedReceipt = computerMutationReceiptSchema.safeParse(consumed.receipt);
    if (!consumedReceipt.success) throw new Error(JSON.stringify(consumedReceipt.error.issues));
    expect(checked.calls.filter((call) => call.name === "type_text")).toHaveLength(1);
    expect(JSON.stringify({ created, state, typed, verified })).not.toMatch(/private-element-token|private tree|private note|"pid"|"window_id"|TEST-SENTINEL/);
  });

  test("selects one existing semantic value control and performs one private-token set_value", async () => {
    const privateValue = "private slider value";
    const privateElementToken = `private-${"s".repeat(5_000)}`;
    const checked = port([
      apps(),
      windows(),
      result({
        window_id: 90, pid: 42, element_count: 2, total_element_count: 2, returned_element_count: 2,
        elements_complete: false, tree_markdown: "private value tree", _note: "private value note",
        elements: [
          { role: "AXSlider", label: "Chosen", element_token: privateElementToken, enabled: true, value: "12" },
          { role: "AXSlider", label: "Sibling", element_token: "private-sibling", enabled: true, value: "5" },
        ],
      }),
      apps(),
      windows(),
      result({ effect: "unverifiable", route: "accessibility", delivery: { mode: "background" } }),
      result({
        window_id: 90, pid: 42, element_count: 2, total_element_count: 2, returned_element_count: 2,
        elements_complete: false, tree_markdown: "private post-value tree", _note: "private post-value note",
        elements: [
          { role: "AXSlider", label: "Sibling", element_token: "private-post-sibling", enabled: true, value: "5" },
          { role: "AXSlider", label: "Chosen", element_token: "private-post-value-token", enabled: true, value: privateValue },
        ],
      }),
      apps(),
      windows(),
      result({ status: "satisfied", stable: true, elapsed_ms: 9, samples: 2, predicates: [{ index: 0, status: "satisfied", unknown_reason: null, observed_json: JSON.stringify(privateValue) }] }),
    ]);
    const subject = new CuaComputerUseAdapter({
      port: checked.value,
      readHidIdleNanoseconds: async () => 1_000_000_000,
      monotonicMilliseconds: () => 10_000,
    });
    const observed = await subject.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected desktop observation");
    const window = observed.observation.targets[0]!.target;
    const selected = await subject.observeWindowState({ scope, target: window, selector: { role: "slider", labelEquals: "Chosen" } });
    expect(selected).toMatchObject({
      ok: true,
      observation: {
        element: { selector: { role: "slider" }, disposition: "unique", evidence: { kind: "element", role: "slider", action: "set_value", enabled: true } },
        outcome: { retrySafety: "safe", recovery: ["retry_same_request"] },
      },
    });
    if (!selected.ok || selected.observation.element?.target === undefined) throw new Error("expected one semantic slider target");
    const publicSelection = windowStateObservationSchema.safeParse(selected.observation);
    if (!publicSelection.success) throw new Error(JSON.stringify(publicSelection.error.issues));

    const changed = await subject.setValue({
      scope,
      operation: { kind: "set_value", target: selected.observation.element.target, value: privateValue },
    });
    expect(changed).toMatchObject({
      ok: true,
      receipt: {
        action: "set_value", deliveryMode: "background", completionCertainty: "completed", verification: "verified",
        resolvedTarget: { kind: "element", role: "slider", action: "set_value", enabled: true },
        outcome: { stateChangeCertainty: "unknown", recovery: ["do_not_replay"] },
      },
    });
    if (!changed.ok) throw new Error("expected confirmed semantic set_value");
    const publicReceipt = computerMutationReceiptSchema.safeParse(changed.receipt);
    if (!publicReceipt.success) throw new Error(JSON.stringify(publicReceipt.error.issues));
    expect(JSON.stringify(changed.receipt)).not.toContain(privateValue);
    expect(JSON.stringify(changed.receipt)).not.toContain(privateElementToken);
    expect(JSON.stringify(changed.receipt)).not.toMatch(/private value tree|"pid"|"window_id"/);
    expect(checked.calls.filter((call) => call.name === "set_value")).toEqual([{
      name: "set_value", args: { pid: 42, window_id: 90, element_token: privateElementToken, value: privateValue },
    }]);

    const verified = await subject.verify({ scope, target: window, expect: [{ element: { selector: { role: "slider" }, valueEquals: privateValue } }] });
    expect(verified).toMatchObject({ ok: true, verification: { status: "satisfied", stable: true, samples: 2 } });
    expect(checked.calls.filter((call) => call.name === "verify_state")).toMatchObject([{
      args: { timeout_ms: 2_000, stable_samples: 2, include_screenshot: false, expect: [{ element: { selector: { role: "AXSlider" }, value_equals: privateValue } }] },
    }]);
  });

  test("never promotes changed text-area geometry into scroll completion", async () => {
    const scrollState = result({
      window_id: 90, pid: 42, element_count: 6, total_element_count: 6, returned_element_count: 6,
      elements_complete: false, tree_markdown: "private scroll tree", _note: "private scroll note",
      elements: [
        { role: "AXWindow", depth: 0, frame: { x: 406, y: 39, w: 700, h: 892 } },
        { role: "AXTextArea", element_token: "private-scroll-token", depth: 1, frame: { x: 427, y: 529, w: 478, h: 448 } },
        { role: "AXButton", depth: 2 },
        { role: "AXButton", depth: 2 },
        { role: "AXButton", depth: 2 },
        { role: "AXButton", depth: 2, frame: { x: 896, y: 561.5, w: 6, h: 82.5 } },
      ],
    });
    const checked = port([
      apps(), windows(), scrollState,
      apps(), windows(),
      result({ effect: "unverifiable", route: "accessibility", delivery: { mode: "background" } }),
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000 });
    const observed = await subject.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected desktop observation");
    const selected = await subject.observeWindowState({ scope, target: observed.observation.targets[0]!.target, selector: { role: "text_area", action: "scroll" } });
    expect(selected).toMatchObject({ ok: true, observation: { element: { selector: { role: "text_area", action: "scroll" }, disposition: "unique", evidence: { kind: "element", role: "text_area", action: "scroll" } } } });
    if (!selected.ok || selected.observation.element?.target === undefined) throw new Error("expected scroll target");
    const changed = await subject.scroll({ scope, operation: { kind: "scroll", target: selected.observation.element.target, direction: "up", amount: 5, by: "line" } });
    expect(changed).toMatchObject({
      ok: false,
      receipt: {
        action: "scroll", deliveryMode: "background", completionCertainty: "unknown_completion", verification: "not_verified",
        providerAction: { effect: "unverifiable", route: "accessibility", delivery: { mode: "background" } },
        outcome: { recovery: ["observe_again", "do_not_replay"] },
      },
    });
    if (changed.ok) throw new Error("expected unverifiable scroll to remain unknown");
    const publicReceipt = computerMutationReceiptSchema.safeParse(changed.receipt);
    if (!publicReceipt.success) throw new Error(JSON.stringify(publicReceipt.error.issues));
    expect(computerMutationReceiptSchema.safeParse({
      ...changed.receipt,
      completionCertainty: "completed",
      verification: "verified",
      unexecutedRemainder: { count: 0, reason: "none" },
      outcome: {
        ...changed.receipt.outcome,
        retrySafety: "never",
        stateChangeCertainty: "changed",
        targetCondition: "current",
        recovery: [],
      },
    }).success).toBe(false);
    expect(JSON.stringify(changed.receipt)).not.toMatch(/private-scroll-token|"window_id"|"pid"/);
    expect(checked.calls.filter((call) => call.name === "scroll")).toEqual([{
      name: "scroll", args: { pid: 42, window_id: 90, element_token: "private-scroll-token", direction: "up", amount: 5, by: "line", delivery_mode: "background" },
    }]);
    expect(checked.calls.filter((call) => call.name === "get_window_state")).toHaveLength(1);
    expect(JSON.stringify(changed)).not.toMatch(/private-scroll-token|private scroll tree|"x"|"y"/);
  });

  test("retains exact accessibility scroll truth when post-dispatch Human attribution advances or is unavailable", async () => {
    const scrollState = result({
      window_id: 90, pid: 42, element_count: 2, total_element_count: 2, returned_element_count: 2,
      elements_complete: false, tree_markdown: "private scroll tree", _note: "private scroll note",
      elements: [
        { role: "AXWindow", depth: 0, frame: { x: 406, y: 39, w: 700, h: 892 } },
        { role: "AXTextArea", element_token: "private-scroll-token", depth: 1, frame: { x: 427, y: 529, w: 478, h: 448 } },
      ],
    });
    for (const mode of ["advance", "unavailable"] as const) {
      const checked = port([
        apps(), windows(), scrollState,
        apps(), windows(), result({ effect: "unverifiable", route: "accessibility", delivery: { mode: "background" } }),
      ]);
      let scrollDispatched = false;
      const wrapped: CuaCheckedContextPort = {
        ...checked.value,
        callContextTool: async (currentScope, name, args, signal, onProviderDispatch) => {
          const response = await checked.value.callContextTool(currentScope, name, args, signal, onProviderDispatch);
          if (name === "scroll" && response.ok) scrollDispatched = true;
          return response;
        },
      };
      const subject = new CuaComputerUseAdapter({
        port: wrapped,
        readHidIdleNanoseconds: async () => {
          if (!scrollDispatched) return 1_000_000_000;
          if (mode === "unavailable") throw new Error("ioreg unavailable");
          return 0;
        },
        monotonicMilliseconds: () => 10_000,
      });
      const observed = await subject.observe({ scope, operation: "desktop_state" });
      if (!observed.ok) throw new Error("expected desktop observation");
      const selected = await subject.observeWindowState({ scope, target: observed.observation.targets[0]!.target, selector: { role: "text_area", action: "scroll" } });
      if (!selected.ok || selected.observation.element?.target === undefined) throw new Error("expected scroll target");
      const crossed = await subject.scroll({ scope, operation: { kind: "scroll", target: selected.observation.element.target, direction: "down", amount: 5, by: "line" } });
      expect(crossed).toMatchObject({
        ok: false,
        receipt: {
          action: "scroll", deliveryMode: "background", completionCertainty: "unknown_completion", verification: "not_verified",
          providerAction: { effect: "unverifiable", route: "accessibility", delivery: { mode: "background" }, evidenceKinds: [], escalation: null },
          outcome: { recovery: ["observe_again", "do_not_replay"], ...(mode === "advance" ? { externalInterference: "user_input" } : {}) },
        },
      });
      if (crossed.ok) throw new Error("expected interrupted scroll");
      expect(computerMutationReceiptSchema.safeParse(crossed.receipt).success).toBe(true);
      expect(JSON.stringify(crossed.receipt)).not.toMatch(/private-scroll-token|private scroll tree|"pid"|"window_id"/);
      expect(checked.calls.filter((call) => call.name === "scroll")).toHaveLength(1);
      expect(checked.calls.filter((call) => call.name === "get_window_state")).toHaveLength(1);
    }
  });

  test("never claims an unchanged or incomplete reported scroll geometry as completed, and never replays", async () => {
    const state = (frame: Record<string, unknown> | undefined) => result({
      window_id: 90, pid: 42, element_count: 3, total_element_count: 3, returned_element_count: 3,
      elements_complete: false, tree_markdown: "private scroll tree", _note: "private scroll note",
      elements: [
        { role: "AXWindow", depth: 0, frame: { x: 406, y: 39, w: 700, h: 892 } },
        { role: "AXTextArea", element_token: "private-scroll-token", enabled: true, depth: 1, frame: { x: 427, y: 529, w: 478, h: 448 } },
        { role: "AXButton", depth: 2, ...(frame === undefined ? {} : { frame }) },
      ],
    });
    const checked = port([
      apps(), windows(), state({ x: 896, y: 561.5, w: 6, h: 82.5 }),
      apps(), windows(), result({ effect: "unverifiable", route: "accessibility", delivery: { mode: "background" } }),
      state({ x: 896, y: 561.5, w: 6, h: 82.5 }),
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000 });
    const observed = await subject.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected desktop observation");
    const selected = await subject.observeWindowState({ scope, target: observed.observation.targets[0]!.target, selector: { role: "text_area", action: "scroll" } });
    if (!selected.ok || selected.observation.element?.target === undefined) throw new Error("expected scroll target");
    const unchanged = await subject.scroll({ scope, operation: { kind: "scroll", target: selected.observation.element.target, direction: "down", amount: 5, by: "line" } });
    expect(unchanged).toMatchObject({
      ok: false, receipt: { action: "scroll", completionCertainty: "unknown_completion", verification: "not_verified", outcome: { recovery: ["observe_again", "do_not_replay"] } },
    });
    if (unchanged.ok) throw new Error("expected unchanged scroll frame to remain unknown");
    expect(computerMutationReceiptSchema.safeParse(unchanged.receipt).success).toBe(true);
    expect(checked.calls.filter((call) => call.name === "scroll")).toHaveLength(1);

    const changedWindowState = result({
      window_id: 90, pid: 42, element_count: 2, total_element_count: 2, returned_element_count: 2,
      elements_complete: false, tree_markdown: "private scroll tree", _note: "private scroll note",
      elements: [
        { role: "AXWindow", depth: 0, frame: { x: 407, y: 39, w: 700, h: 892 } },
        { role: "AXTextArea", element_token: "private-post-scroll-token", depth: 1, frame: { x: 427, y: 479, w: 478, h: 448 } },
      ],
    });
    const changedWindowPort = port([
      apps(), windows(), state({ x: 896, y: 561.5, w: 6, h: 82.5 }),
      apps(), windows(), result({ effect: "unverifiable", route: "accessibility", delivery: { mode: "background" } }),
      changedWindowState,
    ]);
    const changedWindowSubject = new CuaComputerUseAdapter({ port: changedWindowPort.value, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000 });
    const changedWindowObserved = await changedWindowSubject.observe({ scope, operation: "desktop_state" });
    if (!changedWindowObserved.ok) throw new Error("expected desktop observation");
    const changedWindowSelected = await changedWindowSubject.observeWindowState({ scope, target: changedWindowObserved.observation.targets[0]!.target, selector: { role: "text_area", action: "scroll" } });
    if (!changedWindowSelected.ok || changedWindowSelected.observation.element?.target === undefined) throw new Error("expected scroll target");
    const changedWindow = await changedWindowSubject.scroll({ scope, operation: { kind: "scroll", target: changedWindowSelected.observation.element.target, direction: "down", amount: 5, by: "line" } });
    expect(changedWindow).toMatchObject({ ok: false, receipt: { completionCertainty: "unknown_completion", verification: "not_verified", outcome: { recovery: ["observe_again", "do_not_replay"] } } });
    if (changedWindow.ok) throw new Error("expected changed window frame to fence scroll verification");
    expect(computerMutationReceiptSchema.safeParse(changedWindow.receipt).success).toBe(true);
  });

  test("retains Cua's exact synthetic scroll fallback as unknown without post-HID attribution or frame promotion", async () => {
    const state = result({
      window_id: 90, pid: 42, element_count: 2, total_element_count: 2, returned_element_count: 2,
      elements_complete: false, tree_markdown: "private scroll tree", _note: "private scroll note",
      elements: [
        { role: "AXWindow", depth: 0, frame: { x: 406, y: 39, w: 700, h: 892 } },
        { role: "AXTextArea", element_token: "private-scroll-token", enabled: true, depth: 1, frame: { x: 427, y: 529, w: 478, h: 448 } },
      ],
    });
    const checked = port([
      apps(), windows(), state,
      apps(), windows(), result({ effect: "unverifiable", route: "synthetic_events", delivery: { mode: "background" } }),
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000 });
    const observed = await subject.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected desktop observation");
    const selected = await subject.observeWindowState({ scope, target: observed.observation.targets[0]!.target, selector: { role: "text_area", action: "scroll" } });
    if (!selected.ok || selected.observation.element?.target === undefined) throw new Error("expected scroll target");
    const synthetic = await subject.scroll({ scope, operation: { kind: "scroll", target: selected.observation.element.target, direction: "down", amount: 5, by: "line" } });
    expect(synthetic).toMatchObject({
      ok: false,
      receipt: { action: "scroll", completionCertainty: "unknown_completion", verification: "not_verified", providerAction: { route: "synthetic_events", delivery: { mode: "background" } }, outcome: { recovery: ["observe_again", "do_not_replay"] } },
    });
    if (synthetic.ok) throw new Error("expected synthetic scroll fallback to remain unknown");
    expect(computerMutationReceiptSchema.safeParse(synthetic.receipt).success).toBe(true);
    expect(checked.calls.filter((call) => call.name === "scroll")).toHaveLength(1);
    expect(checked.calls.filter((call) => call.name === "get_window_state")).toHaveLength(1);
  });

  test("treats Cua's exact background_unavailable scroll envelope as known not-completed without provider withdrawal", async () => {
    const state = result({
      window_id: 90, pid: 42, element_count: 2, total_element_count: 2, returned_element_count: 2,
      elements_complete: false, tree_markdown: "private scroll tree", _note: "private scroll note",
      elements: [
        { role: "AXWindow", depth: 0, frame: { x: 406, y: 39, w: 700, h: 892 } },
        { role: "AXTextArea", element_token: "private-scroll-token", enabled: true, depth: 1, frame: { x: 427, y: 529, w: 478, h: 448 } },
      ],
    });
    const checked = port([apps(), windows(), state, apps(), windows(), result({ code: "background_unavailable" }, true)]);
    const subject = new CuaComputerUseAdapter({ port: checked.value, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000 });
    const observed = await subject.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected desktop observation");
    const selected = await subject.observeWindowState({ scope, target: observed.observation.targets[0]!.target, selector: { role: "text_area", action: "scroll" } });
    if (!selected.ok || selected.observation.element?.target === undefined) throw new Error("expected scroll target");
    const unavailable = await subject.scroll({ scope, operation: { kind: "scroll", target: selected.observation.element.target, direction: "down", amount: 5, by: "line" } });
    expect(unavailable).toMatchObject({
      ok: false, receipt: { action: "scroll", completionCertainty: "not_completed", deliveryMode: "not_delivered", verification: "unavailable", providerAction: null, outcome: { stateChangeCertainty: "not_changed", recovery: ["observe_again"] } },
    });
    if (unavailable.ok) throw new Error("expected unavailable background scroll");
    expect(computerMutationReceiptSchema.safeParse(unavailable.receipt).success).toBe(true);
    expect(checked.value.invalidateCheckedGeneration).not.toHaveBeenCalled();
  });

  test("fences every indistinguishable tool-stage scroll cancellation without replay, while session cancellation stays pre-claim", async () => {
    const scrollState = result({
      window_id: 90, pid: 42, element_count: 2, total_element_count: 2, returned_element_count: 2,
      elements_complete: false, tree_markdown: "private scroll tree", _note: "private scroll note",
      elements: [
        { role: "AXWindow", depth: 0, frame: { x: 406, y: 39, w: 700, h: 892 } },
        { role: "AXTextArea", element_token: "private-scroll-token", depth: 1, frame: { x: 427, y: 529, w: 478, h: 448 } },
      ],
    });
    for (const callbackRuns of [false, true]) {
      const checked = port([apps(), windows(), scrollState, apps(), windows()]);
      let scrollCalls = 0;
      const wrapped: CuaCheckedContextPort = {
        ...checked.value,
        callContextTool: async (currentScope, name, args, signal, onProviderDispatch) => {
          if (name !== "scroll") return checked.value.callContextTool(currentScope, name, args, signal, onProviderDispatch);
          scrollCalls += 1;
          if (callbackRuns && onProviderDispatch !== undefined) await onProviderDispatch();
          return { ok: false, code: "cancelled", stage: "tool" };
        },
      };
      const subject = new CuaComputerUseAdapter({ port: wrapped, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000 });
      const observed = await subject.observe({ scope, operation: "desktop_state" });
      if (!observed.ok) throw new Error("expected desktop observation");
      const selected = await subject.observeWindowState({ scope, target: observed.observation.targets[0]!.target, selector: { role: "text_area", action: "scroll" } });
      if (!selected.ok || selected.observation.element?.target === undefined) throw new Error("expected scroll target");
      const cancelled = await subject.scroll({ scope, operation: { kind: "scroll", target: selected.observation.element.target, direction: "down", amount: 5, by: "line" } });
      expect(cancelled).toMatchObject({ ok: false, receipt: { action: "scroll", completionCertainty: "unknown_completion", deliveryMode: "unknown", verification: "unavailable", outcome: { providerCondition: "cancelled", recovery: ["observe_again", "do_not_replay"] } } });
      if (cancelled.ok) throw new Error("expected tool-stage cancellation to remain unknown");
      const parsedReceipt = computerMutationReceiptSchema.safeParse(cancelled.receipt);
      if (!parsedReceipt.success) throw new Error(JSON.stringify(parsedReceipt.error.issues));
      await expect(subject.scroll({ scope, operation: { kind: "scroll", target: selected.observation.element.target, direction: "down", amount: 5, by: "line" } })).resolves.toMatchObject({ ok: false, receipt: { completionCertainty: "not_completed" } });
      expect(scrollCalls).toBe(1);
    }

    const checked = port([apps(), windows(), scrollState, apps(), windows()]);
    const sessionCancelled: CuaCheckedContextPort = {
      ...checked.value,
      callContextTool: async (currentScope, name, args, signal, onProviderDispatch) => name === "scroll"
        ? { ok: false, code: "cancelled", stage: "session" }
        : checked.value.callContextTool(currentScope, name, args, signal, onProviderDispatch),
    };
    const subject = new CuaComputerUseAdapter({ port: sessionCancelled, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000 });
    const observed = await subject.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected desktop observation");
    const selected = await subject.observeWindowState({ scope, target: observed.observation.targets[0]!.target, selector: { role: "text_area", action: "scroll" } });
    if (!selected.ok || selected.observation.element?.target === undefined) throw new Error("expected scroll target");
    const cancelled = await subject.scroll({ scope, operation: { kind: "scroll", target: selected.observation.element.target, direction: "down", amount: 5, by: "line" } });
    expect(cancelled).toMatchObject({ ok: false, receipt: { action: "scroll", completionCertainty: "not_completed", deliveryMode: "not_delivered", verification: "unavailable", outcome: { providerCondition: "cancelled", recovery: ["retry_same_request"] } } });
    if (cancelled.ok) throw new Error("expected session cancellation");
    expect(subject.registry.resolveTarget(selected.observation.element.target.context, scope, selected.observation.element.target.reference).ok).toBe(true);
  });

  test("does not require scroll geometry but rejects non-exact successful scroll envelopes", async () => {
    const scrollState = (elements: readonly Record<string, unknown>[]) => result({
      window_id: 90, pid: 42, element_count: elements.length, total_element_count: elements.length, returned_element_count: elements.length,
      elements_complete: false, tree_markdown: "private scroll tree", _note: "private scroll note", elements,
    });
    const completeElements = [
      { role: "AXWindow", depth: 0, frame: { x: 406, y: 39, w: 700, h: 892 } },
      { role: "AXTextArea", element_token: "private-scroll-token", depth: 1, frame: { x: 427, y: 529, w: 478, h: 448 } },
    ];
    for (const elements of [
      completeElements.slice(1),
      [...completeElements, { role: "AXWindow", depth: 0, frame: { x: 406, y: 39, w: 700, h: 892 } }],
      [{ role: "AXWindow", depth: 0, frame: { x: 406, y: 39, w: 0, h: 892 } }, completeElements[1]!],
      [completeElements[0]!, { role: "AXTextArea", element_token: "private-scroll-token", depth: 1, frame: { x: 427, y: 529, w: 478, h: 0 } }],
    ]) {
      const checked = port([apps(), windows(), scrollState(elements)]);
      const subject = new CuaComputerUseAdapter({ port: checked.value });
      const observed = await subject.observe({ scope, operation: "desktop_state" });
      if (!observed.ok) throw new Error("expected desktop observation");
      const selected = await subject.observeWindowState({ scope, target: observed.observation.targets[0]!.target, selector: { role: "text_area", action: "scroll" } });
      expect(selected).toMatchObject({ ok: true, observation: { element: { disposition: "unique" } } });
      expect(checked.calls.filter((call) => call.name === "scroll")).toHaveLength(0);
    }
    for (const action of [
      { effect: "unverifiable", route: "accessibility", delivery: { mode: "background" }, evidence: [] },
      { effect: "unverifiable", route: "accessibility", delivery: { mode: "background" }, escalation: null },
      { effect: "unverifiable", delivery: { mode: "background" } },
    ]) {
      const checked = port([apps(), windows(), scrollState(completeElements), apps(), windows(), result(action)]);
      const subject = new CuaComputerUseAdapter({ port: checked.value, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000 });
      const observed = await subject.observe({ scope, operation: "desktop_state" });
      if (!observed.ok) throw new Error("expected desktop observation");
      const selected = await subject.observeWindowState({ scope, target: observed.observation.targets[0]!.target, selector: { role: "text_area", action: "scroll" } });
      if (!selected.ok || selected.observation.element?.target === undefined) throw new Error("expected scroll target");
      const malformed = await subject.scroll({ scope, operation: { kind: "scroll", target: selected.observation.element.target, direction: "down", amount: 5, by: "line" } });
      expect(malformed).toMatchObject({ ok: false, receipt: { action: "scroll", completionCertainty: "unknown_completion", verification: "unavailable", outcome: { providerCondition: "malformed_response", recovery: ["observe_again", "do_not_replay"] } } });
      if (malformed.ok) throw new Error("expected malformed scroll action result");
      const parsedReceipt = computerMutationReceiptSchema.safeParse(malformed.receipt);
      if (!parsedReceipt.success) throw new Error(JSON.stringify(parsedReceipt.error.issues));
    }
  });

  test("locks every source-known scroll refusal receipt, provider readiness, and no-replay fence", async () => {
    const scrollState = result({
      window_id: 90, pid: 42, element_count: 2, total_element_count: 2, returned_element_count: 2,
      elements_complete: false, tree_markdown: "private scroll tree", _note: "private scroll note",
      elements: [
        { role: "AXWindow", depth: 0, frame: { x: 406, y: 39, w: 700, h: 892 } },
        { role: "AXTextArea", element_token: "private-scroll-token", depth: 1, frame: { x: 427, y: 529, w: 478, h: 448 } },
      ],
    });
    const tokenReceipt = {
      deliveryMode: "not_delivered", completionCertainty: "not_completed", verification: "unavailable", providerAction: null,
      outcome: { retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", providerCondition: "ready", targetCondition: "stale", recovery: ["observe_again"] },
    } as const;
    const crossedReceipt = {
      deliveryMode: "unknown", completionCertainty: "unknown_completion", verification: "not_verified", providerAction: null,
      outcome: { retrySafety: "observe_before_retry", stateChangeCertainty: "unknown", providerCondition: "ready", targetCondition: "unknown", recovery: ["observe_again", "do_not_replay"] },
    } as const;
    for (const { envelope, expected } of [
      { envelope: { status: "refused", refusal: { code: "stale_element_token", message: "private" } }, expected: tokenReceipt },
      { envelope: { status: "refused", refusal: { code: "generation_mismatch", message: "private" } }, expected: tokenReceipt },
      { envelope: { status: "refused", refusal: { code: "invalid_element_token", message: "private" } }, expected: tokenReceipt },
      { envelope: { status: "refused", refusal: { code: "conflicting_element_target", message: "private" } }, expected: tokenReceipt },
      { envelope: { effect: "refused", code: "window_not_found", pid: 42, window_id: 90, reason: "private" }, expected: crossedReceipt },
      { envelope: { effect: "refused", code: "owner_pid_mismatch", pid: 42, window_id: 90, reason: "private" }, expected: crossedReceipt },
      { envelope: { effect: "refused", code: "element_outside_target_window", pid: 42, window_id: 90, reason: "private", escalation: { recommended: "get_window_state", reason: "private" } }, expected: crossedReceipt },
      { envelope: { effect: "refused", code: "off_space_or_ax_unresolved", pid: 42, window_id: 90, reason: "private", escalation: { recommended: "foreground", reason: "private" } }, expected: crossedReceipt },
      { envelope: { effect: "refused", code: "minimized_or_hidden_window", pid: 42, window_id: 90, reason: "private", escalation: { recommended: "accessibility", reason: "private" } }, expected: crossedReceipt },
    ] as const) {
      const checked = port([apps(), windows(), scrollState, apps(), windows(), result(envelope, true)]);
      const subject = new CuaComputerUseAdapter({ port: checked.value, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000 });
      const observed = await subject.observe({ scope, operation: "desktop_state" });
      if (!observed.ok) throw new Error("expected desktop observation");
      const selected = await subject.observeWindowState({ scope, target: observed.observation.targets[0]!.target, selector: { role: "text_area", action: "scroll" } });
      if (!selected.ok || selected.observation.element?.target === undefined) throw new Error("expected scroll target");
      const refused = await subject.scroll({ scope, operation: { kind: "scroll", target: selected.observation.element.target, direction: "down", amount: 5, by: "line" } });
      expect(refused).toMatchObject({ ok: false, receipt: { action: "scroll", ...expected } });
      if (refused.ok) throw new Error("expected refused scroll");
      const parsedReceipt = computerMutationReceiptSchema.safeParse(refused.receipt);
      if (!parsedReceipt.success) throw new Error(JSON.stringify({ envelope, issues: parsedReceipt.error.issues }));
      expect(checked.value.invalidateCheckedGeneration).not.toHaveBeenCalled();
      expect(checked.calls.filter((call) => call.name === "scroll")).toHaveLength(1);
      await expect(subject.scroll({ scope, operation: { kind: "scroll", target: selected.observation.element.target, direction: "down", amount: 5, by: "line" } })).resolves.toMatchObject({ ok: false, receipt: { action: "scroll", completionCertainty: "not_completed" } });
      expect(checked.calls.filter((call) => call.name === "scroll")).toHaveLength(1);
    }
  });

  test("preserves mismatched selected-action evidence through the real Host and permits fresh selection", async () => {
    const editor = result({ window_id: 90, pid: 42, element_count: 1, total_element_count: 1, returned_element_count: 1,
      elements_complete: false, tree_markdown: "private tree", _note: "private note",
      elements: [{ role: "AXTextField", label: "Editor", value: "Existing contents", enabled: true, element_token: "private-editor-token" }] });
    const checked = port([apps(), windows(), editor, editor, apps(), windows(),
      result({ effect: "confirmed", route: "accessibility", delivery: { mode: "background", delivered_count: 6 }, evidence: [{ kind: "value_readback" }] }),
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000 });
    const desktop = await subject.observe({ scope, operation: "desktop_state" });
    if (!desktop.ok) throw new Error("expected desktop");
    const window = desktop.observation.targets[0]!.target;
    const selected = await subject.observeWindowState({ scope, target: window, selector: { role: "text_field", action: "set_value" } });
    if (!selected.ok || !selected.observation.element?.target) throw new Error("expected value target");
    const runtime = new CuaNativeContractRuntime({ adapter: subject, scopeForAuthority: () => scope });
    const host = new ComputerUseHost({ hostGeneration: "host-1", driverGeneration: "driver-1", handlers: runtime.handlers });
    const dispatch = (requestId: string, target: typeof window) => host.dispatch({
      kind: "request", protocol: { major: 3, minor: 0 }, requestId,
      authority: { authorityLeaseId: "lease-1", authorityGeneration: 1 },
      fence: { hostGeneration: "host-1", driverGeneration: "driver-1", cancellationGeneration: 1 },
      contract: COMPUTER_USE_NATIVE_CONTRACTS.do,
      arguments: { operation: { kind: "type_text", target, text: "append" } },
    });
    const refused = await dispatch("mismatched-action", selected.observation.element.target);
    expect(refused).toMatchObject({ settlement: "not_completed", result: {
      action: "type_text", resolvedTarget: { kind: "element", role: "text_field", action: "set_value" },
      completionCertainty: "not_completed", deliveryMode: "not_delivered", providerAction: null,
      textDelivery: { requestedCharacters: 6, deliveredCharacters: 0 },
      outcome: { phase: "resolve_target", providerCondition: "ready", targetCondition: "unavailable", recovery: ["observe_again"] },
    } });
    expect(checked.calls).toHaveLength(3);
    expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
    expect(computerMutationReceiptSchema.safeParse(refused.result).success).toBe(true);
    // No incompatible evidence may be laundered into an effectful receipt.
    for (const patch of [
      { completionCertainty: "completed" },
      { completionCertainty: "unknown_completion", deliveryMode: "unknown" },
      { deliveryMode: "background" },
      { verification: "verified" },
      { providerAction: undefined },
      { textDelivery: { requestedCharacters: 6, deliveredCharacters: 1 } },
      { outcome: { ...(refused.result.outcome as Record<string, unknown>), phase: "post_effect_verification" } },
      { outcome: { ...(refused.result.outcome as Record<string, unknown>), stateChangeCertainty: "unknown" } },
    ]) expect(computerMutationReceiptSchema.safeParse({ ...refused.result, ...patch }).success).toBe(false);
    const fresh = await subject.observeWindowState({ scope, target: window, selector: { role: "text_field", action: "type_text" } });
    if (!fresh.ok || !fresh.observation.element?.target) throw new Error("expected fresh typing target");
    expect(await dispatch("fresh-insertion", fresh.observation.element.target)).toMatchObject({ settlement: "completed", result: {
      action: "type_text", textDelivery: { requestedCharacters: 6, deliveredCharacters: 6 },
    } });
    expect(checked.calls.filter((call) => call.name === "type_text")).toHaveLength(1);
    expect(checked.calls.filter((call) => call.name === "set_value")).toHaveLength(0);
    expect(JSON.stringify(refused)).not.toMatch(/private-editor-token|Existing contents|append/);
    await subject.close();
  });

  test("settles every incompatible element-input action without invoking the driver", async () => {
    for (const kind of ["type_text", "set_value", "scroll", "click", "press_key", "hotkey"] as const) {
      const checked = port([apps(), windows(), result({ window_id: 90, pid: 42, element_count: 1,
        total_element_count: 1, returned_element_count: 1, elements_complete: false,
        tree_markdown: "private tree", _note: "private note",
        elements: [{ role: "AXTextField", enabled: true, element_token: "private-editor-token" }] }),
      ]);
      const subject = new CuaComputerUseAdapter({ port: checked.value,
        readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000 });
      const desktop = await subject.observe({ scope, operation: "desktop_state" });
      if (!desktop.ok) throw new Error("expected desktop");
      const selected = await subject.observeWindowState({ scope, target: desktop.observation.targets[0]!.target,
        selector: { role: "text_field", action: kind === "set_value" ? "type_text" : "set_value" } });
      if (!selected.ok || !selected.observation.element?.target) throw new Error("expected incompatible target");
      const runtime = new CuaNativeContractRuntime({ adapter: subject, scopeForAuthority: () => scope });
      const host = new ComputerUseHost({ hostGeneration: "host-1", driverGeneration: "driver-1", handlers: runtime.handlers });
      const fields = kind === "type_text" ? { text: "append" } : kind === "set_value" ? { value: "replacement" }
        : kind === "scroll" ? { direction: "up", amount: 2, by: "line" }
        : kind === "press_key" ? { key: "Escape" } : kind === "hotkey" ? { keys: ["cmd", "a"] } : {};
      const refused = await host.dispatch({ kind: "request", protocol: { major: 3, minor: 0 }, requestId: `mismatch-${kind}`,
        authority: { authorityLeaseId: "lease-1", authorityGeneration: 1 },
        fence: { hostGeneration: "host-1", driverGeneration: "driver-1", cancellationGeneration: 1 },
        contract: COMPUTER_USE_NATIVE_CONTRACTS.do,
        arguments: { operation: { kind, target: selected.observation.element.target, ...fields } },
      });
      expect(refused).toMatchObject({ settlement: "not_completed", result: { action: kind,
        deliveryMode: "not_delivered", providerAction: null, outcome: { providerCondition: "ready", recovery: ["observe_again"] },
      } });
      expect(computerMutationReceiptSchema.safeParse(refused.result).success).toBe(true);
      if (kind === "scroll") {
        // A current target plus a final no-retry outcome is not one of scroll's
        // closed pre-effect failure families. The mismatch exception must not
        // let arbitrary outcome semantics bypass that contract.
        expect(computerMutationReceiptSchema.safeParse({
          ...refused.result,
          outcome: {
            ...refused.result.outcome,
            retrySafety: "never",
            targetCondition: "current",
            recovery: [],
          },
        }).success).toBe(false);
      }
      expect(checked.calls).toHaveLength(3);
      expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
      await subject.close();
    }
  });

  test("keeps mismatched target refusals valid before cancellation and Human-input checks", async () => {
    for (const mode of ["cancelled", "external", "unavailable"] as const) {
      let idle: number | null = 1_000_000_000;
      const checked = port([apps(), windows(), result({ window_id: 90, pid: 42, element_count: 1,
        total_element_count: 1, returned_element_count: 1, elements_complete: false,
        tree_markdown: "private tree", _note: "private note",
        elements: [{ role: "AXTextField", enabled: true, element_token: "private-editor-token" }] }),
      ]);
      const subject = new CuaComputerUseAdapter({ port: checked.value,
        readHidIdleNanoseconds: async () => idle, monotonicMilliseconds: () => 10_000 });
      const desktop = await subject.observe({ scope, operation: "desktop_state" });
      if (!desktop.ok) throw new Error("expected desktop");
      const selected = await subject.observeWindowState({ scope, target: desktop.observation.targets[0]!.target,
        selector: { role: "text_field", action: "set_value" } });
      if (!selected.ok || !selected.observation.element?.target) throw new Error("expected value target");
      const controller = new AbortController();
      if (mode === "cancelled") controller.abort();
      else idle = mode === "external" ? 0 : null;
      const refused = await subject.typeText({ scope, signal: controller.signal,
        operation: { kind: "type_text", target: selected.observation.element.target, text: "append" } });
      expect(refused.ok).toBe(false);
      expect(computerMutationReceiptSchema.safeParse(refused.receipt).success).toBe(true);
      expect(refused.receipt).toMatchObject({ resolvedTarget: { action: "set_value" },
        textDelivery: { deliveredCharacters: 0 }, outcome: mode === "cancelled"
          ? { providerCondition: "cancelled", targetCondition: "current" }
          : { providerCondition: "unknown", targetCondition: "unknown", ...(mode === "external" ? { externalInterference: "user_input" } : {}) },
      });
      expect(checked.calls).toHaveLength(3);
      expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
      await subject.close();
    }
  });

  test("types into existing nonempty controls without new-document provenance", async () => {
    for (const [role, axRole] of [["text_area", "AXTextArea"], ["text_field", "AXTextField"], ["combo_box", "AXComboBox"]] as const) {
      const checked = port([
        apps(), windows(),
        result({ window_id: 90, pid: 42, element_count: 1, total_element_count: 1, returned_element_count: 1,
          elements_complete: false, tree_markdown: "private tree", _note: "private note",
          elements: [{ role: axRole, label: "Editor", value: "Existing document contents", enabled: true, element_token: "private-existing-token" }] }),
        apps(), windows(),
        result({ effect: "confirmed", route: "accessibility", delivery: { mode: "background", delivered_count: 6 }, evidence: [{ kind: "value_readback" }] }),
      ]);
      const subject = new CuaComputerUseAdapter({ port: checked.value, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000 });
      const desktop = await subject.observe({ scope, operation: "desktop_state" });
      if (!desktop.ok) throw new Error("expected desktop");
      const selected = await subject.observeWindowState({ scope, target: desktop.observation.targets[0]!.target, selector: { role, action: "type_text", labelEquals: "Editor" } });
      if (!selected.ok || selected.observation.element?.target === undefined) throw new Error("expected existing editable target");
      expect(windowStateObservationSchema.safeParse(selected.observation).success).toBe(true);
      const typed = await subject.typeText({ scope, operation: { kind: "type_text", target: selected.observation.element.target, text: "append" } });
      expect(typed).toMatchObject({ ok: true, receipt: { action: "type_text", resolvedTarget: { role, action: "type_text" }, verification: "verified" } });
      if (!typed.ok) throw new Error("expected confirmed typing");
      expect(computerMutationReceiptSchema.safeParse(typed.receipt).success).toBe(true);
      expect(checked.calls.filter((call) => call.name === "type_text")).toMatchObject([{ args: { element_token: "private-existing-token", text: "append" } }]);
      expect(JSON.stringify(typed)).not.toContain("Existing document contents");
    }
  });

  test("sets any uniquely selected observed value role and scrolls controls without frame prerequisites", async () => {
    for (const [action, role, axRole] of [
      ["set_value", "popup_button", "AXPopUpButton"], ["set_value", "checkbox", "AXCheckBox"],
      ["set_value", "incrementor", "AXIncrementor"], ["set_value", "future_control", "AXFutureControl"],
      ["scroll", "scroll_area", "AXScrollArea"], ["scroll", "outline", "AXOutline"],
      ["scroll", "list", "AXList"], ["scroll", "group", "AXGroup"],
    ] as const) {
      const checked = port([apps(), windows(),
        result({ window_id: 90, pid: 42, element_count: 2, total_element_count: 2, returned_element_count: 2,
          elements_complete: false, tree_markdown: "private tree", _note: "private note",
          elements: [
            { role: axRole, label: "Chosen", value: "old", enabled: true, element_token: "private-chosen-token" },
            { role: axRole, label: "Sibling", enabled: true, element_token: "private-sibling-token" },
          ] }), apps(), windows(),
        result(action === "set_value"
          ? { effect: "confirmed", route: "accessibility", delivery: { mode: "background" }, evidence: [{ kind: "value_readback" }] }
          : { effect: "unverifiable", route: "accessibility", delivery: { mode: "background" } }),
      ]);
      const subject = new CuaComputerUseAdapter({ port: checked.value, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000 });
      const desktop = await subject.observe({ scope, operation: "desktop_state" });
      if (!desktop.ok) throw new Error("expected desktop");
      const selected = await subject.observeWindowState({ scope, target: desktop.observation.targets[0]!.target, selector: { role, action, labelEquals: "Chosen" } });
      if (!selected.ok || selected.observation.element?.target === undefined) throw new Error(`expected ${role} target`);
      expect(windowStateObservationSchema.safeParse(selected.observation).success).toBe(true);
      const operation = action === "set_value"
        ? { kind: action, target: selected.observation.element.target, value: "42" }
        : { kind: action, target: selected.observation.element.target, direction: "up" as const, amount: 7, by: "page" as const };
      const acted = operation.kind === "set_value" ? await subject.setValue({ scope, operation }) : await subject.scroll({ scope, operation });
      expect(computerMutationReceiptSchema.safeParse(acted.receipt).success).toBe(true);
      expect(acted.receipt).toMatchObject({ action, resolvedTarget: { role, action } });
      expect(checked.calls.filter((call) => call.name === action)).toMatchObject([{ args: { element_token: "private-chosen-token", ...(action === "set_value" ? { value: "42" } : { direction: "up", amount: 7, by: "page" }) } }]);
      if (action === "scroll") expect(acted.receipt).toMatchObject({ completionCertainty: "unknown_completion", verification: "not_verified" });
    }
  });

  test("reports an inline editor outside its window as unavailable, not a stale token", async () => {
    const privateReason = "the addressed element could not be proven to belong to window 90; take a fresh get_window_state snapshot and re-address it";
    const checked = port([apps(), windows(),
      result({ window_id: 90, pid: 42, element_count: 1, total_element_count: 1, returned_element_count: 1,
        elements_complete: false, tree_markdown: "private tree", _note: "private note",
        elements: [{ role: "AXTextField", depth: 0, value: "example.txt", element_token: "private-editor-token", enabled: true }] }),
      apps(), windows(), result({ code: "element_outside_target_window", effect: "refused", pid: 42, window_id: 90,
        reason: privateReason, escalation: { reason: privateReason, recommended: "get_window_state" } }, true),
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000 });
    const desktop = await subject.observe({ scope, operation: "desktop_state" });
    if (!desktop.ok) throw new Error("expected desktop");
    const selected = await subject.observeWindowState({ scope, target: desktop.observation.targets[0]!.target, selector: { role: "text_field", action: "set_value" } });
    if (!selected.ok || selected.observation.element?.target === undefined) throw new Error("expected editor target");
    const operation = { kind: "set_value" as const, target: selected.observation.element.target, value: "renamed.txt" };
    const changed = await subject.setValue({ scope, operation });
    expect(changed).toMatchObject({ ok: false, receipt: {
      completionCertainty: "not_completed", deliveryMode: "not_delivered", providerAction: null,
      outcome: { phase: "pre_effect_dispatch", providerCondition: "ready", targetCondition: "unavailable",
        stateChangeCertainty: "not_changed", retrySafety: "never", recovery: ["observe_again"] },
    } });
    expect(computerMutationReceiptSchema.safeParse(changed.receipt).success).toBe(true);
    expect(JSON.stringify(changed)).not.toMatch(/private-editor-token|example\.txt|renamed\.txt|window 90/);
    await subject.setValue({ scope, operation });
    expect(checked.calls.filter((call) => call.name === "set_value")).toHaveLength(1);
    expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
    // Refusing this action must preserve the parent window for visual recovery.
    expect(subject.registry.resolveTarget(desktop.observation.context, scope, desktop.observation.targets[0]!.target.reference).ok).toBe(true);
  });

  test("does not promote an untrusted AX value echo over Cua's pixel verification requirement", async () => {
    const checked = port([apps(), windows(),
      result({ window_id: 90, pid: 42, element_count: 1, total_element_count: 1, returned_element_count: 1,
        elements_complete: false, tree_markdown: "private tree", _note: "private note",
        elements: [{ role: "AXTextField", value: "old", element_token: "private-web-token" }] }),
      apps(), windows(), result({ effect: "unverifiable", route: "accessibility", delivery: { mode: "background" }, escalation: { target: "pixel", reason: "effect_unconfirmed" } }),
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000 });
    const desktop = await subject.observe({ scope, operation: "desktop_state" });
    if (!desktop.ok) throw new Error("expected desktop");
    const selected = await subject.observeWindowState({ scope, target: desktop.observation.targets[0]!.target, selector: { role: "text_field", action: "set_value" } });
    if (!selected.ok || selected.observation.element?.target === undefined) throw new Error("expected value target");
    const operation = { kind: "set_value" as const, target: selected.observation.element.target, value: "new" };
    const changed = await subject.setValue({ scope, operation });
    expect(changed).toMatchObject({ ok: false, receipt: { completionCertainty: "unknown_completion", verification: "not_verified", providerAction: { escalation: { target: "pixel" } } } });
    expect(computerMutationReceiptSchema.safeParse(changed.receipt).success).toBe(true);
    expect(computerMutationReceiptSchema.safeParse({ ...changed.receipt,
      completionCertainty: "completed", verification: "verified", unexecutedRemainder: { count: 0, reason: "none" },
      outcome: { ...changed.receipt.outcome, retrySafety: "never", recovery: ["do_not_replay"] },
    }).success).toBe(false);
    expect(checked.calls.filter((call) => call.name === "get_window_state")).toHaveLength(1);
    await subject.setValue({ scope, operation });
    expect(checked.calls.filter((call) => call.name === "set_value")).toHaveLength(1);
    expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
  });

  test("never guesses among value controls and fences an unverifiable set_value without replay", async () => {
    const state = (elements: readonly Record<string, unknown>[]) => result({
      window_id: 90, pid: 42, element_count: elements.length, total_element_count: elements.length, returned_element_count: elements.length,
      elements_complete: false, tree_markdown: "private tree", elements, _note: "private note",
    });
    const ambiguousPort = port([
      apps(), windows(),
      state([
        { role: "AXSlider", element_token: "private-a", enabled: true },
        { role: "AXSlider", element_token: "private-b", enabled: true },
      ]),
    ]);
    const ambiguous = new CuaComputerUseAdapter({
      port: ambiguousPort.value, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000,
    });
    const observedAmbiguous = await ambiguous.observe({ scope, operation: "desktop_state" });
    if (!observedAmbiguous.ok) throw new Error("expected desktop observation");
    const ambiguousSelection = await ambiguous.observeWindowState({ scope, target: observedAmbiguous.observation.targets[0]!.target, selector: { role: "slider" } });
    expect(ambiguousSelection).toMatchObject({ ok: true, observation: { element: { disposition: "ambiguous" } } });
    if (!ambiguousSelection.ok) throw new Error("expected ambiguous selector result");
    expect(ambiguousSelection.observation.element?.target).toBeUndefined();
    expect(ambiguousSelection.observation.element?.evidence).toBeUndefined();
    expect(ambiguousPort.calls.filter((call) => call.name === "set_value")).toHaveLength(0);

    const uncertainPort = port([
      apps(), windows(),
      state([{ role: "AXTextField", element_token: "private-field-token", enabled: true, value: "private old value" }]),
      apps(), windows(),
      result({ effect: "unverifiable", route: "accessibility", delivery: { mode: "background" } }),
      state([{ role: "AXTextField", element_token: "private-post-field-token", enabled: true, value: "private old value" }]),
    ]);
    const uncertain = new CuaComputerUseAdapter({
      port: uncertainPort.value, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000,
    });
    const observed = await uncertain.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected desktop observation");
    const selected = await uncertain.observeWindowState({ scope, target: observed.observation.targets[0]!.target, selector: { role: "text_field" } });
    if (!selected.ok || selected.observation.element?.target === undefined) throw new Error("expected text-field target");
    const changed = await uncertain.setValue({ scope, operation: { kind: "set_value", target: selected.observation.element.target, value: "private uncertain value" } });
    expect(changed).toMatchObject({
      ok: false,
      receipt: { action: "set_value", completionCertainty: "unknown_completion", verification: "not_verified", outcome: { recovery: ["observe_again", "do_not_replay"] } },
    });
    if (changed.ok) throw new Error("expected unverifiable set_value");
    const publicReceipt = computerMutationReceiptSchema.safeParse(changed.receipt);
    if (!publicReceipt.success) throw new Error(JSON.stringify(publicReceipt.error.issues));
    expect(JSON.stringify(changed)).not.toMatch(/private-field-token|private uncertain value|private tree|private note/);
    expect(uncertainPort.invalidateCheckedGeneration).toHaveBeenCalledTimes(0);
    expect(uncertainPort.calls.filter((call) => call.name === "set_value")).toHaveLength(1);

    const impossibleEffectPort = port([
      apps(), windows(),
      state([{ role: "AXSlider", element_token: "private-impossible-token", enabled: true }]),
      apps(), windows(),
      result({ effect: "suspected_noop", route: "accessibility", delivery: { mode: "background" } }),
    ]);
    const impossibleEffect = new CuaComputerUseAdapter({
      port: impossibleEffectPort.value, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000,
    });
    const impossibleObserved = await impossibleEffect.observe({ scope, operation: "desktop_state" });
    if (!impossibleObserved.ok) throw new Error("expected desktop observation");
    const impossibleSelected = await impossibleEffect.observeWindowState({
      scope, target: impossibleObserved.observation.targets[0]!.target, selector: { role: "slider" },
    });
    if (!impossibleSelected.ok || impossibleSelected.observation.element?.target === undefined) throw new Error("expected slider target");
    await expect(impossibleEffect.setValue({
      scope, operation: { kind: "set_value", target: impossibleSelected.observation.element.target, value: "private impossible value" },
    })).resolves.toMatchObject({
      ok: false,
      receipt: { completionCertainty: "unknown_completion", outcome: { providerCondition: "malformed_response", recovery: ["observe_again", "do_not_replay"] } },
    });
    expect(impossibleEffectPort.invalidateCheckedGeneration).toHaveBeenCalledTimes(1);

    const stalePort = port([
      apps(), windows(),
      state([{ role: "AXComboBox", element_token: "private-combo-token", enabled: true }]),
      apps(), windows(),
      result({ status: "refused", refusal: { code: "stale_element_token", message: "private refusal" } }, true),
    ]);
    const stale = new CuaComputerUseAdapter({
      port: stalePort.value, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000,
    });
    const staleObserved = await stale.observe({ scope, operation: "desktop_state" });
    if (!staleObserved.ok) throw new Error("expected desktop observation");
    const staleSelected = await stale.observeWindowState({ scope, target: staleObserved.observation.targets[0]!.target, selector: { role: "combo_box" } });
    if (!staleSelected.ok || staleSelected.observation.element?.target === undefined) throw new Error("expected combo-box target");
    const refused = await stale.setValue({ scope, operation: { kind: "set_value", target: staleSelected.observation.element.target, value: "private refused value" } });
    expect(refused).toMatchObject({
      ok: false,
      receipt: { action: "set_value", completionCertainty: "not_completed", deliveryMode: "not_delivered", outcome: { retrySafety: "observe_before_retry", targetCondition: "stale", recovery: ["observe_again"] } },
    });
    if (refused.ok) throw new Error("expected stale element refusal");
    const refusedReceipt = computerMutationReceiptSchema.safeParse(refused.receipt);
    if (!refusedReceipt.success) throw new Error(JSON.stringify(refusedReceipt.error.issues));
    expect(stalePort.invalidateCheckedGeneration).toHaveBeenCalledTimes(0);
    expect(JSON.stringify(refused)).not.toMatch(/private-combo-token|private refused value|private refusal/);
  });

  test("refreshes a selectable element from the provider and retires the prior same-window token", async () => {
    const checkboxState = (label: string, token: string) => result({
      window_id: 90, pid: 42, element_count: 1, total_element_count: 1, returned_element_count: 1,
      elements_complete: false, tree_markdown: "private tree", _note: "private note",
      elements: [{ role: "AXCheckBox", label, element_token: token, enabled: true, selected: false }],
    });
    const checked = port([apps(), windows(), checkboxState("First", "private-old-token"), checkboxState("Second", "private-fresh-token")]);
    const registry = new ComputerUseContextRegistry();
    const subject = new CuaComputerUseAdapter({ port: checked.value, registry });
    const desktop = await subject.observe({ scope, operation: "desktop_state" });
    if (!desktop.ok) throw new Error("expected desktop observation");
    const window = desktop.observation.targets[0]!.target;
    const first = await subject.observeWindowState({ scope, target: window, selector: { role: "checkbox", labelEquals: "First" } });
    if (!first.ok || first.observation.element?.target === undefined) throw new Error("expected first element target");
    const oldTarget = first.observation.element.target;

    const second = await subject.observeWindowState({ scope, target: window, selector: { role: "checkbox", labelEquals: "Second" } });
    expect(second).toMatchObject({ ok: true, observation: { element: { disposition: "unique", evidence: { role: "checkbox" } } } });
    expect(checked.calls.filter((call) => call.name === "get_window_state")).toHaveLength(2);
    expect(registry.resolveTarget(oldTarget.context, scope, oldTarget.reference)).toEqual({ ok: false, code: "not_found" });
    await expect(subject.click({ scope, operation: { kind: "click", target: oldTarget } }))
      .resolves.toMatchObject({ ok: false, receipt: { completionCertainty: "not_completed" } });
  });

  test("returns a fresh same-window screenshot after an element-bearing observation", async () => {
    const screenshotFixture = windowStateScreenshot();
    const exactScreenshotFixture: CuaContextToolResult = {
      ...screenshotFixture,
      structuredContent: { ...screenshotFixture.structuredContent, window_id: 90, pid: 42 },
    };
    const checked = port([
      apps(), windows(),
      result({
        window_id: 90, pid: 42, element_count: 1, total_element_count: 1, returned_element_count: 1,
        elements_complete: false, tree_markdown: "private tree", _note: "private note", elements: [{ role: "AXCheckBox", label: "Open", element_token: "private-old-checkbox", enabled: true, selected: false }],
      }),
      exactScreenshotFixture,
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const desktop = await subject.observe({ scope, operation: "desktop_state" });
    if (!desktop.ok) throw new Error("expected desktop observation");
    const window = desktop.observation.targets[0]!.target;
    const first = await subject.observeWindowState({ scope, target: window, selector: { role: "checkbox", labelEquals: "Open" } });
    if (!first.ok || first.observation.element?.target === undefined) throw new Error("expected checkbox target");

    const refreshed = await subject.observeWindowState({ scope, target: window, capture: "window_snapshot" });
    expect(refreshed).toMatchObject({ ok: true, observation: { windowSnapshot: { metadata: { format: "png" } } }, visionImage: { mime: "image/png" } });
    expect(checked.calls.filter((call) => call.name === "get_window_state")).toHaveLength(2);
  });

  test("retires a prior same-window element when its refresh fails or is cancelled after dispatch", async () => {
    const outcomes: Array<Readonly<{ mode: "failed" | "cancelled"; ok: boolean; reads: number; oldTargetStatus: string }>> = [];
    for (const mode of ["failed", "cancelled"] as const) {
      const initialState = result({
        window_id: 90, pid: 42, element_count: 1, total_element_count: 1, returned_element_count: 1,
        elements_complete: false, tree_markdown: "private tree", _note: "private note", elements: [{ role: "AXCheckBox", label: "Old", element_token: `private-${mode}-old`, enabled: true, selected: false }],
      });
      const checked = port([apps(), windows(), initialState, mode === "failed" ? result({ malformed: true }) : initialState]);
      const registry = new ComputerUseContextRegistry();
      const controller = new AbortController();
      const baseGetWindowState = checked.value.getWindowState;
      let windowReads = 0;
      const refreshPort: CuaCheckedContextPort = mode === "cancelled" ? {
        ...checked.value,
        getWindowState: async (...args) => {
          const response = await baseGetWindowState(...args);
          windowReads += 1;
          if (windowReads === 2) controller.abort();
          return response;
        },
      } : checked.value;
      const subject = new CuaComputerUseAdapter({ port: refreshPort, registry });
      const desktop = await subject.observe({ scope, operation: "desktop_state" });
      if (!desktop.ok) throw new Error("expected desktop observation");
      const window = desktop.observation.targets[0]!.target;
      const selected = await subject.observeWindowState({ scope, target: window, selector: { role: "checkbox", labelEquals: "Old" } });
      if (!selected.ok || selected.observation.element?.target === undefined) throw new Error("expected old target");
      const oldTarget = selected.observation.element.target;

      const refreshed = await subject.observeWindowState({
        scope, target: window, selector: { role: "checkbox", labelEquals: "New" },
        ...(mode === "cancelled" ? { signal: controller.signal } : {}),
      });
      const oldTargetResult = registry.resolveTarget(oldTarget.context, scope, oldTarget.reference);
      outcomes.push({
        mode,
        ok: refreshed.ok,
        reads: checked.calls.filter((call) => call.name === "get_window_state").length,
        oldTargetStatus: oldTargetResult.ok ? "current" : oldTargetResult.code,
      });
    }
    expect(outcomes).toEqual([
      { mode: "failed", ok: false, reads: 2, oldTargetStatus: "not_found" },
      { mode: "cancelled", ok: false, reads: 2, oldTargetStatus: "not_found" },
    ]);
  });

  test("preserves a prior same-window element when observation is already cancelled", async () => {
    const registry = new ComputerUseContextRegistry();
    const created = registry.create(scope);
    if (!created.ok) throw new Error("expected context");
    const registered = registry.registerTargets(created.data.context, scope, [
      { evidence: { kind: "window", appLabel: "Nautilo" }, providerTarget: { provider: "cua", operation: "focus", app: "Nautilo", pid: 42, windowId: 90 } },
      { evidence: { kind: "element", role: "checkbox", action: "click" }, providerTarget: { provider: "cua", operation: "click", pid: 42, windowId: 90, elementToken: "private-current-token" } },
    ]);
    if (!registered.ok) throw new Error("expected targets");
    const checked = port([]);
    const subject = new CuaComputerUseAdapter({ port: checked.value, registry });
    const controller = new AbortController();
    controller.abort();

    await expect(subject.observeWindowState({
      scope,
      target: { version: 1, context: created.data.context, reference: registered.data[0]!.reference },
      selector: { role: "checkbox" },
      signal: controller.signal,
    })).resolves.toMatchObject({ ok: false, outcome: { providerCondition: "cancelled" } });
    expect(checked.calls.filter((call) => call.name === "get_window_state")).toHaveLength(0);
    expect(registry.resolveTarget(created.data.context, scope, registered.data[1]!.reference).ok).toBe(true);
  });

  test("does not publish returned element or PNG when cancellation arrives during the post-read Human check", async () => {
    const registry = new ComputerUseContextRegistry();
    const created = registry.create(scope);
    if (!created.ok) throw new Error("expected context");
    const registered = registry.registerTargets(created.data.context, scope, [{
      evidence: { kind: "window", appLabel: "Nautilo" },
      providerTarget: { provider: "cua", operation: "focus", app: "Nautilo", pid: 42, windowId: 90 },
    }]);
    if (!registered.ok) throw new Error("expected window");
    const screenshot = windowStateScreenshot();
    const captureResult: CuaContextToolResult = {
      ...screenshot,
      structuredContent: {
        ...screenshot.structuredContent,
        window_id: 90,
        pid: 42,
        element_count: 1,
        total_element_count: 1,
        returned_element_count: 1,
        elements: [{ role: "AXCheckBox", label: "Choice", element_token: "private-cancelled-token", enabled: true, selected: false }],
      },
    };
    const rawPng = Buffer.from(captureResult.content.find((entry) => entry["type"] === "image")!["data"] as string, "base64");
    const checked = port([]);
    const capturePort: CuaCheckedContextPort = {
      ...checked.value,
      captureWindowState: async () => ({
        ok: true,
        generation,
        sessionId,
        result: { ...captureResult, content: captureResult.content.filter((entry) => entry.type === "text") },
        png: rawPng,
      }),
    };
    const controller = new AbortController();
    let humanChecks = 0;
    const subject = new CuaComputerUseAdapter({
      port: capturePort,
      registry,
      monotonicMilliseconds: () => 10_000,
      readHidIdleNanoseconds: async () => {
        humanChecks += 1;
        if (humanChecks === 2) controller.abort();
        return 1_000_000_000;
      },
    });
    const observed = await subject.observeWindowState({
      scope,
      target: { version: 1, context: created.data.context, reference: registered.data[0]!.reference },
      selector: { role: "checkbox", labelEquals: "Choice" },
      capture: "window_snapshot",
      signal: controller.signal,
    });
    expect(observed).toMatchObject({ ok: false, outcome: { providerCondition: "cancelled" } });
    expect(observed).not.toHaveProperty("observation");
    expect(observed).not.toHaveProperty("visionImage");
    expect(registry.hasElementTargetForWindow(created.data.context, scope, 42, 90)).toEqual({ ok: true, data: false });
    expect([...rawPng]).toEqual(Array.from({ length: rawPng.length }, () => 0));
  });

  test("refreshing one window preserves an element token owned by another window", async () => {
    const registry = new ComputerUseContextRegistry();
    const created = registry.create(scope);
    if (!created.ok) throw new Error("expected context");
    const registered = registry.registerTargets(created.data.context, scope, [
      { evidence: { kind: "window", appLabel: "Nautilo" }, providerTarget: { provider: "cua", operation: "focus", app: "Nautilo", pid: 42, windowId: 90 } },
      { evidence: { kind: "window", appLabel: "Nautilo" }, providerTarget: { provider: "cua", operation: "focus", app: "Nautilo", pid: 42, windowId: 91 } },
    ]);
    if (!registered.ok) throw new Error("expected windows");
    const states = (windowId: number, token: string) => result({
      window_id: windowId, pid: 42, element_count: 1, total_element_count: 1, returned_element_count: 1,
      elements_complete: false, tree_markdown: "private tree", _note: "private note", elements: [{ role: "AXCheckBox", label: "Choice", element_token: token, enabled: true, selected: false }],
    });
    const checked = port([states(90, "private-window-90"), states(91, "private-window-91"), states(91, "private-window-91-fresh")]);
    const subject = new CuaComputerUseAdapter({ port: checked.value, registry });
    const first = await subject.observeWindowState({ scope, target: { version: 1, context: created.data.context, reference: registered.data[0]!.reference }, selector: { role: "checkbox", labelEquals: "Choice" } });
    if (!first.ok || first.observation.element?.target === undefined) throw new Error("expected first-window element");
    const firstTarget = first.observation.element.target;
    const secondTarget = { version: 1 as const, context: created.data.context, reference: registered.data[1]!.reference };
    await expect(subject.observeWindowState({ scope, target: secondTarget, selector: { role: "checkbox", labelEquals: "Choice" } })).resolves.toMatchObject({ ok: true });
    await expect(subject.observeWindowState({ scope, target: secondTarget, selector: { role: "checkbox", labelEquals: "Choice" } })).resolves.toMatchObject({ ok: true });
    expect(registry.resolveTarget(firstTarget.context, scope, firstTarget.reference).ok).toBe(true);
  });

  test("registry completion fencing allows only the newest concurrent same-window read to mint", async () => {
    const registry = new ComputerUseContextRegistry();
    const created = registry.create(scope);
    if (!created.ok) throw new Error("expected context");
    const registered = registry.registerTargets(created.data.context, scope, [
      { evidence: { kind: "window", appLabel: "Nautilo" }, providerTarget: { provider: "cua", operation: "focus", app: "Nautilo", pid: 42, windowId: 90 } },
      { evidence: { kind: "window", appLabel: "Nautilo" }, providerTarget: { provider: "cua", operation: "focus", app: "Nautilo", pid: 42, windowId: 91 } },
    ]);
    if (!registered.ok) throw new Error("expected windows");
    const state = (windowId: number, token: string, selected = false) => result({
      window_id: windowId, pid: 42, element_count: 1, total_element_count: 1, returned_element_count: 1,
      elements_complete: false, tree_markdown: "private tree", _note: "private note",
      elements: [{ role: "AXCheckBox", label: "Choice", element_token: token, enabled: true, selected }],
    });
    const checked = port([
      state(90, "private-initial-90"), state(91, "private-initial-91"),
      state(90, "unused-older"), state(90, "unused-newer"),
    ]);
    const baseGetWindowState = checked.value.getWindowState;
    const deferred: Array<(value: CuaContextToolCallResult) => void> = [];
    let reads = 0;
    const concurrentPort: CuaCheckedContextPort = {
      ...checked.value,
      getWindowState: async (currentScope, pid, windowId, query, signal, effort) => {
        reads += 1;
        if (reads <= 2) return baseGetWindowState(currentScope, pid, windowId, query, signal, effort);
        checked.calls.push({ name: "get_window_state", args: { pid, window_id: windowId, include_screenshot: false } });
        return new Promise<CuaContextToolCallResult>((resolve) => deferred.push(resolve));
      },
    };
    const subject = new CuaComputerUseAdapter({ port: concurrentPort, registry });
    const window90 = { version: 1 as const, context: created.data.context, reference: registered.data[0]!.reference };
    const window91 = { version: 1 as const, context: created.data.context, reference: registered.data[1]!.reference };
    const initial90 = await subject.observeWindowState({ scope, target: window90, selector: { role: "checkbox", labelEquals: "Choice" } });
    const initial91 = await subject.observeWindowState({ scope, target: window91, selector: { role: "checkbox", labelEquals: "Choice" } });
    if (!initial90.ok || initial90.observation.element?.target === undefined || !initial91.ok || initial91.observation.element?.target === undefined) throw new Error("expected initial targets");
    const otherWindowTarget = initial91.observation.element.target;

    const older = subject.observeWindowState({ scope, target: window90, selector: { role: "checkbox", labelEquals: "Choice" } });
    const newer = subject.observeWindowState({ scope, target: window90, selector: { role: "checkbox", labelEquals: "Choice" } });
    await Promise.resolve();
    deferred[1]!({ ok: true, generation, sessionId, result: state(90, "private-newest-90") });
    const newerResult = await newer;
    if (!newerResult.ok || newerResult.observation.element?.target === undefined) throw new Error("expected newest target");
    const newestTarget = newerResult.observation.element.target;
    deferred[0]!({ ok: true, generation, sessionId, result: state(90, "private-late-older-90") });
    await expect(older).resolves.toMatchObject({ ok: false });
    expect(registry.resolveTarget(newestTarget.context, scope, newestTarget.reference).ok).toBe(true);
    expect(registry.resolveTarget(otherWindowTarget.context, scope, otherWindowTarget.reference).ok).toBe(true);
  });

  test("selects and dispatches arbitrary observed native roles without treating advisory actions as an allowlist", async () => {
    for (const [nativeRole, role] of [
      ["AXRow", "row"], ["AXLink", "link"], ["AXOutline", "outline"],
      ["AXRadioButton", "radio_button"], ["AXTabGroup", "tab_group"],
      ["AXPopUpButton", "popup_button"], ["AXFutureControl", "future_control"],
      ["AXTextField", "text_field"],
    ] as const) {
      for (const interaction of [undefined, "right_click", "double_click"] as const) {
        const state = result({
          window_id: 90, pid: 42, element_count: 1, total_element_count: 1, returned_element_count: 1,
          elements_complete: false, tree_markdown: "private native tree", _note: "private note",
          elements: [{ role: nativeRole, label: "Observed control", element_token: "private-native-token", enabled: true, actions: [] }],
        });
        const name = interaction ?? "click";
        const effect = interaction === undefined
          ? { effect: "unverifiable", route: "accessibility", delivery: { mode: "background" } }
          : { effect: "unverifiable", route: "synthetic_events", delivery: { mode: "unknown" } };
        const checked = port([apps(), windows(), state, apps(), windows(), result(effect)]);
        const subject = new CuaComputerUseAdapter({
          port: checked.value, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000,
        });
        const desktop = await subject.observe({ scope, operation: "desktop_state" });
        if (!desktop.ok) throw new Error("expected desktop observation");
        const selected = await subject.observeWindowState({
          scope, target: desktop.observation.targets[0]!.target, query: "Observed control",
          selector: { role, action: "click", labelEquals: "Observed control", ...(interaction === undefined ? {} : { interaction }) },
        });
        expect(selected).toMatchObject({ ok: true, observation: {
          element: { disposition: "unique", selector: { role, action: "click" }, evidence: { role, action: name } },
          semanticQuery: { matches: [{ role, label: "Observed control" }] },
        } });
        if (!selected.ok || selected.observation.element?.target === undefined) throw new Error("expected selected native control");
        expect(windowStateObservationSchema.safeParse(selected.observation).success).toBe(true);
        const operation = { kind: "click" as const, target: selected.observation.element.target };
        const clicked = await subject.click({ scope, operation });
        expect(clicked).toMatchObject({ ok: false, receipt: {
          completionCertainty: "unknown_completion", verification: "not_verified",
          resolvedTarget: { kind: "element", role, action: name },
          outcome: { providerCondition: "ready", recovery: ["observe_again", "do_not_replay"] },
        } });
        expect(computerMutationReceiptSchema.safeParse(clicked.receipt).success).toBe(true);
        await subject.click({ scope, operation });
        expect(checked.calls.filter((call) => call.name === name)).toEqual([{
          name, args: { pid: 42, window_id: 90, element_token: "private-native-token", delivery_mode: "background" },
        }]);
        expect(checked.calls.filter((call) => call.name === "set_value")).toHaveLength(0);
        expect(JSON.stringify({ selected, clicked })).not.toMatch(/private-native-token|private native tree|"pid"|"window_id"/);
      }
    }
  });

  test("general role selection preserves exact-match ambiguity and disabled-target handling", async () => {
    for (const [elements, disposition] of [
      [[{ role: "AXRow", label: "Choice", element_token: "private-a", enabled: true }, { role: "AXRow", label: "Choice", element_token: "private-b", enabled: true }], "ambiguous"],
      [[{ role: "AXRow", label: "Choice", element_token: "private-a", enabled: false }], "incomplete"],
    ] as const) {
      const state = result({
        window_id: 90, pid: 42, element_count: elements.length, total_element_count: elements.length, returned_element_count: elements.length,
        elements_complete: false, tree_markdown: "private native tree", _note: "private note", elements,
      });
      const checked = port([apps(), windows(), state]);
      const subject = new CuaComputerUseAdapter({ port: checked.value });
      const desktop = await subject.observe({ scope, operation: "desktop_state" });
      if (!desktop.ok) throw new Error("expected desktop observation");
      const selected = await subject.observeWindowState({
        scope, target: desktop.observation.targets[0]!.target,
        selector: { role: "row", action: "click", labelEquals: "Choice" },
      });
      expect(selected).toMatchObject({ ok: true, observation: { element: { disposition } } });
      if (!selected.ok) throw new Error("expected selection result");
      expect(selected.observation.element?.target).toBeUndefined();
      expect(windowStateObservationSchema.safeParse(selected.observation).success).toBe(true);
      expect(checked.calls.filter((call) => call.name === "click")).toHaveLength(0);
    }
  });

  test("dispatches each explicit native action once without inventing a verified postcondition", async () => {
    for (const axAction of ["press", "show_menu", "pick", "confirm", "cancel", "open"] as const) {
      const state = result({
        window_id: 90, pid: 42, element_count: 1, total_element_count: 1, returned_element_count: 1,
        elements_complete: false, tree_markdown: "private tree", _note: "private note",
        elements: [{ role: "AXRow", label: "Document", element_token: "private-row", enabled: true, actions: [] }],
      });
      const checked = port([apps(), windows(), state, apps(), windows(), result({
        effect: "unverifiable", route: "accessibility", delivery: { mode: "background" },
      })]);
      const subject = new CuaComputerUseAdapter({ port: checked.value });
      const desktop = await subject.observe({ scope, operation: "desktop_state" });
      if (!desktop.ok) throw new Error("expected desktop observation");
      const selected = await subject.observeWindowState({ scope, target: desktop.observation.targets[0]!.target,
        selector: { role: "row", action: "click", labelEquals: "Document" } });
      if (!selected.ok || selected.observation.element?.target === undefined) throw new Error("expected row target");
      const operation = { kind: "click" as const, target: selected.observation.element.target, axAction };
      const clicked = await subject.click({ scope, operation });
      expect(clicked).toMatchObject({ receipt: { verification: "not_verified", outcome: {
        stateChangeCertainty: "unknown", recovery: ["observe_again", "do_not_replay"],
      } } });
      expect(computerMutationReceiptSchema.safeParse(clicked.receipt).success).toBe(true);
      await subject.click({ scope, operation });
      expect(checked.calls.filter((call) => call.name === "click")).toEqual([{
        name: "click", args: { pid: 42, window_id: 90, element_token: "private-row", delivery_mode: "background", action: axAction },
      }]);
    }
  });

  test("carries element pointer options and key aliases through foreground input without blaming agent HID on the Human", async () => {
    for (const kind of ["click", "press_key", "type_text", "scroll"] as const) {
      const state = result({
        window_id: 90, pid: 42, element_count: 1, total_element_count: 1, returned_element_count: 1,
        elements_complete: false, tree_markdown: "private", _note: "private",
        elements: [{ role: "AXTextField", label: "Fixture", element_token: "private-target", enabled: true, value: "existing", actions: [] }],
      });
      const checked = port([apps(), windows(), state, apps(), windows(), result({
        effect: "unverifiable", route: kind === "click" || kind === "scroll" ? "accessibility" : "global_input", delivery: { mode: "foreground" },
        ...(kind === "press_key" ? { evidence: [{ kind: "native_api_result" }] } : {}),
      })]);
      const subject = new CuaComputerUseAdapter({ port: checked.value, monotonicMilliseconds: () => 10_000,
        readHidIdleNanoseconds: async () => checked.dispatched.some((call) => call.name === kind) ? 0 : 1_000_000_000 });
      const observed = await subject.observe({ scope, operation: "desktop_state" });
      if (!observed.ok) throw new Error("expected desktop");
      const selected = await subject.observeWindowState({ scope, target: observed.observation.targets[0]!.target,
        selector: { role: "text_field", action: kind, labelEquals: "Fixture" } });
      if (!selected.ok || !selected.observation.element?.target) throw new Error("expected element");
      expect(windowStateObservationSchema.safeParse(selected.observation).success).toBe(true);
      const target = selected.observation.element.target;
      const performed = kind === "click"
        ? await subject.click({ scope, operation: { kind, target, button: "right", modifiers: ["shift"], deliveryMode: "foreground" } })
        : kind === "scroll"
          ? await subject.scroll({ scope, operation: { kind, target, direction: "up", amount: 50, by: "page", deliveryMode: "foreground" } })
        : kind === "type_text"
          ? await subject.typeText({ scope, operation: { kind, target, text: "sentinel", deliveryMode: "foreground" } })
          : await subject.pressKey({ scope, operation: { kind, target, key: "+", modifiers: ["command"], deliveryMode: "foreground" } });
      expect(performed).toMatchObject({ receipt: { verification: "not_verified",
        outcome: { providerCondition: "ready", stateChangeCertainty: "unknown" } } });
      expect(performed.receipt.outcome.externalInterference).toBeUndefined();
      const receipt = computerMutationReceiptSchema.safeParse(performed.receipt);
      if (!receipt.success) throw new Error(`${kind}: ${JSON.stringify(receipt.error.issues)} ${JSON.stringify(performed.receipt)}`);
      expect(checked.calls.at(-1)).toEqual({ name: kind, args: { pid: 42, window_id: 90, element_token: "private-target", delivery_mode: "foreground",
        ...(kind === "click" ? { button: "right", modifier: ["shift"] }
          : kind === "scroll" ? { direction: "up", amount: 50, by: "page" }
          : kind === "type_text" ? { text: "sentinel" } : { key: "=", modifiers: ["cmd", "shift"] }) } });
      expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
    }
  });

  test("preserves Cua's confirmed row selection on both AX and pointer fallback routes", async () => {
    // Pinned Cua action_record.rs::click_selection_readback_preserves_confirmed_effect
    // projects an AXSelected readback after a pointer fallback to this envelope.
    for (const route of ["accessibility", "synthetic_events"] as const) {
      const state = result({
        window_id: 90, pid: 42, element_count: 1, total_element_count: 1, returned_element_count: 1,
        elements_complete: false, tree_markdown: "private tree", _note: "private note",
        elements: [{ role: "AXRow", label: "Document", element_token: "private-row", enabled: true, actions: [] }],
      });
      const checked = port([apps(), windows(), state, apps(), windows(), result({
        effect: "confirmed", route, delivery: { mode: "background" }, evidence: [{ kind: "value_readback" }],
      }), state]);
      const subject = new CuaComputerUseAdapter({
        port: checked.value, monotonicMilliseconds: () => 10_000,
        readHidIdleNanoseconds: async () => checked.dispatched.some((call) => call.name === "click") && route === "synthetic_events" ? 0 : 1_000_000_000,
      });
      const desktop = await subject.observe({ scope, operation: "desktop_state" });
      if (!desktop.ok) throw new Error("expected desktop observation");
      const selected = await subject.observeWindowState({ scope, target: desktop.observation.targets[0]!.target, selector: { role: "row", action: "click", labelEquals: "Document" } });
      if (!selected.ok || selected.observation.element?.target === undefined) throw new Error("expected row target");
      const operation = { kind: "click" as const, target: selected.observation.element.target };
      const clicked = await subject.click({ scope, operation });
      expect(clicked).toMatchObject({ ok: true, receipt: {
        completionCertainty: "completed", verification: "verified", deliveryMode: "background",
        providerAction: { effect: "confirmed", route, evidenceKinds: ["value_readback"] },
        outcome: { providerCondition: "ready", stateChangeCertainty: "unknown", recovery: route === "synthetic_events" ? ["observe_again", "do_not_replay"] : ["do_not_replay"] },
      } });
      const publicReceipt = computerMutationReceiptSchema.safeParse(clicked.receipt);
      if (!publicReceipt.success) throw new Error(JSON.stringify(publicReceipt.error.issues));
      expect(clicked.receipt.outcome.externalInterference).toBeUndefined();
      expect(computerMutationReceiptSchema.safeParse({
        ...clicked.receipt, providerAction: { ...clicked.receipt.providerAction, evidenceKinds: [] },
      }).success).toBe(false);
      expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
      await subject.click({ scope, operation });
      expect(checked.calls.filter((call) => call.name === "click")).toHaveLength(1);
      await expect(subject.observeWindowState({ scope, target: desktop.observation.targets[0]!.target })).resolves.toMatchObject({ ok: true });
    }
  });

  test("selects one labelled checkbox, presses its private token once, and verifies fresh state", async () => {
    const privateLabel = "Enable fixture";
    const state = result({
      window_id: 90, pid: 42, element_count: 3, total_element_count: 3, returned_element_count: 3,
      elements_complete: false, tree_markdown: "private checkbox tree", _note: "private checkbox note",
      elements: [
        { role: "AXCheckBox", element_token: "private-unlabelled-token", enabled: true, selected: false },
        { role: "AXCheckBox", label: "Other control", element_token: "private-other-token", enabled: true, selected: false },
        { role: "AXCheckBox", label: privateLabel, element_token: "private-checkbox-token", enabled: true, value: "0" },
      ],
    });
    const postState = result({
      window_id: 90, pid: 42, element_count: 3, total_element_count: 3, returned_element_count: 3,
      elements_complete: false, tree_markdown: "private post-checkbox tree", _note: "private post-checkbox note",
      elements: [
        { role: "AXCheckBox", element_token: "private-post-unlabelled-token", enabled: true, selected: false },
        { role: "AXCheckBox", label: "Other control", element_token: "private-post-other-token", enabled: true, selected: false },
        { role: "AXCheckBox", label: privateLabel, element_token: "private-post-checkbox-token", enabled: true, value: "1" },
      ],
    });
    const checked = port([
      apps(), windows(), state,
      apps(), windows(),
      result({ effect: "unverifiable", route: "accessibility", delivery: { mode: "background" } }),
      postState,
      apps(), windows(),
      result({ status: "satisfied", stable: true, elapsed_ms: 8, samples: 2, predicates: [{ index: 0, status: "satisfied", unknown_reason: null, observed_json: "true" }] }),
    ]);
    const subject = new CuaComputerUseAdapter({
      port: checked.value,
      readHidIdleNanoseconds: async () => 1_000_000_000,
      monotonicMilliseconds: () => 10_000,
    });
    const observed = await subject.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected desktop observation");
    const window = observed.observation.targets[0]!.target;
    const selected = await subject.observeWindowState({
      scope, target: window, selector: { role: "checkbox", labelEquals: privateLabel },
    });
    expect(selected).toMatchObject({
      ok: true,
      observation: {
        element: {
          selector: { role: "checkbox" }, disposition: "unique",
          evidence: { kind: "element", role: "checkbox", action: "click", enabled: true },
        },
        outcome: { retrySafety: "safe", recovery: ["retry_same_request"] },
      },
    });
    if (!selected.ok || selected.observation.element?.target === undefined) throw new Error("expected checkbox target");
    expect(JSON.stringify(selected)).not.toContain(privateLabel);
    const publicSelection = windowStateObservationSchema.safeParse(selected.observation);
    if (!publicSelection.success) throw new Error(JSON.stringify(publicSelection.error.issues));

    const clicked = await subject.click({ scope, operation: { kind: "click", target: selected.observation.element.target } });
    expect(clicked).toMatchObject({
      ok: true,
      receipt: {
        action: "click", deliveryMode: "background", completionCertainty: "completed", verification: "verified",
        resolvedTarget: { kind: "element", role: "checkbox", action: "click", enabled: true },
      },
    });
    if (!clicked.ok) throw new Error("expected confirmed semantic click");
    const publicReceipt = computerMutationReceiptSchema.safeParse(clicked.receipt);
    if (!publicReceipt.success) throw new Error(JSON.stringify(publicReceipt.error.issues));
    expect(JSON.stringify(clicked.receipt)).not.toMatch(/private-checkbox-token|private-other-token|private-unlabelled-token|private checkbox tree|Enable fixture|Other control|"pid"|"window_id"/);
    expect(checked.calls.filter((call) => call.name === "click")).toEqual([{
      name: "click", args: { pid: 42, window_id: 90, element_token: "private-checkbox-token", delivery_mode: "background" },
    }]);

    const verified = await subject.verify({ scope, target: window, expect: [{ element: { selector: { role: "checkbox", labelContains: privateLabel }, selected: true } }] });
    expect(verified).toMatchObject({ ok: true, verification: { status: "satisfied", stable: true, samples: 2 } });
    expect(checked.calls.filter((call) => call.name === "verify_state")).toMatchObject([{
      args: { timeout_ms: 2_000, stable_samples: 2, include_screenshot: false, expect: [{ element: { selector: { role: "AXCheckBox", label_contains: privateLabel }, selected: true } }] },
    }]);
    const consumed = await subject.click({ scope, operation: { kind: "click", target: selected.observation.element.target } });
    expect(consumed).toMatchObject({ ok: false, receipt: { completionCertainty: "not_completed", resolvedTarget: { kind: "element", state: "unavailable" } } });
    if (consumed.ok) throw new Error("expected consumed checkbox target");
    const consumedReceipt = computerMutationReceiptSchema.safeParse(consumed.receipt);
    if (!consumedReceipt.success) throw new Error(JSON.stringify(consumedReceipt.error.issues));
    expect(checked.calls.filter((call) => call.name === "click")).toHaveLength(1);
  });

  test("binds one labelled control to an exact background right-click and preserves unavailable menu-item verification", async () => {
    const privateLabel = "Right-click target";
    const privateMenuItem = "Fixture Context Item";
    const state = result({
      window_id: 90, pid: 42, element_count: 2, total_element_count: 2, returned_element_count: 2,
      elements_complete: false, tree_markdown: "private right-click tree", _note: "private right-click note",
      elements: [
        { role: "AXButton", label: "Other control", element_token: "private-other-token", enabled: true },
        { role: "AXButton", label: privateLabel, element_token: "private-right-click-token", enabled: true },
      ],
    });
    const checked = port([
      apps(), windows(), state,
      apps(), windows(),
      result({ effect: "unverifiable", route: "synthetic_events", delivery: { mode: "unknown" } }),
      apps(), windows(),
      apps(), windows(),
      result({ status: "unknown", stable: false, elapsed_ms: 9, samples: 11, predicates: [{ index: 0, status: "unknown", unknown_reason: "observation_unavailable", observed_json: "{\"contains_untrusted_region\":false,\"elements_complete\":false,\"matches\":0}" }] }),
    ]);
    const subject = new CuaComputerUseAdapter({
      port: checked.value,
      readHidIdleNanoseconds: async () => 1_000_000_000,
      monotonicMilliseconds: () => 10_000,
    });
    const observed = await subject.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected desktop observation");
    const window = observed.observation.targets[0]!.target;
    const selected = await subject.observeWindowState({
      scope, target: window, selector: { role: "button", interaction: "right_click", labelEquals: privateLabel },
    });
    expect(selected).toMatchObject({
      ok: true,
      observation: {
        element: {
          selector: { role: "button", interaction: "right_click" }, disposition: "unique",
          evidence: { kind: "element", role: "button", action: "right_click", enabled: true },
        },
        outcome: { retrySafety: "safe", recovery: ["retry_same_request"] },
      },
    });
    if (!selected.ok || selected.observation.element?.target === undefined) throw new Error("expected right-click target");
    const publicSelection = windowStateObservationSchema.safeParse(selected.observation);
    if (!publicSelection.success) throw new Error(JSON.stringify(publicSelection.error.issues));

    const clicked = await subject.click({ scope, operation: { kind: "click", target: selected.observation.element.target } });
    expect(clicked).toMatchObject({
      ok: false,
      receipt: {
        action: "click", deliveryMode: "unknown", completionCertainty: "unknown_completion", verification: "not_verified",
        resolvedTarget: { kind: "element", role: "button", action: "right_click", enabled: true },
        providerAction: { effect: "unverifiable", route: "synthetic_events", delivery: { mode: "unknown" }, evidenceKinds: [], escalation: null },
        outcome: { stateChangeCertainty: "unknown", recovery: ["observe_again", "do_not_replay"] },
      },
    });
    if (clicked.ok) throw new Error("expected right-click to require fresh verification");
    const publicReceipt = computerMutationReceiptSchema.safeParse(clicked.receipt);
    if (!publicReceipt.success) throw new Error(JSON.stringify(publicReceipt.error.issues));
    expect(checked.calls.filter((call) => call.name === "right_click")).toEqual([{
      name: "right_click", args: { pid: 42, window_id: 90, element_token: "private-right-click-token", delivery_mode: "background" },
    }]);
    expect(checked.calls.filter((call) => call.name === "click")).toHaveLength(0);
    expect(JSON.stringify({ selected: selected.observation, receipt: clicked.receipt })).not.toMatch(/private-right-click-token|private-other-token|private right-click tree|Right-click target|Other control|Fixture Context Item|"pid"|"window_id"/);

    const refreshed = await subject.observe({ scope, operation: "desktop_state" });
    if (!refreshed.ok) throw new Error("expected fresh desktop observation");
    const verified = await subject.verify({
      scope,
      target: refreshed.observation.targets[0]!.target,
      expect: [{ element: { selector: { role: "menu_item", labelContains: privateMenuItem }, exists: true } }],
    });
    expect(verified).toMatchObject({ ok: true, verification: { status: "unknown", stable: false, samples: 11, predicates: [{ unknownReason: "observation_unavailable" }] } });
    expect(checked.calls.filter((call) => call.name === "verify_state")).toMatchObject([{
      args: { timeout_ms: 2_000, stable_samples: 2, include_screenshot: false, expect: [{ element: { selector: { role: "AXMenuItem", label_contains: privateMenuItem }, exists: true } }] },
    }]);
  });

  test("accepts redundant button intent on specialized native targets without sending unsupported fields", async () => {
    for (const [interaction, button] of [["right_click", "right"], ["double_click", "left"]] as const) {
      const state = result({
        window_id: 90, pid: 42, element_count: 1, total_element_count: 1, returned_element_count: 1,
        elements_complete: false, tree_markdown: "private fixture tree", _note: "private note",
        elements: [{ role: "AXTextField", label: "Fixture item", element_token: "private-pointer-token", enabled: true }],
      });
      const checked = port([apps(), windows(), state, apps(), windows(),
        result({ effect: "unverifiable", route: "global_input", delivery: { mode: "foreground" } }), state]);
      const subject = new CuaComputerUseAdapter({
        port: checked.value, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000,
      });
      const observed = await subject.observe({ scope, operation: "desktop_state" });
      if (!observed.ok) throw new Error("expected window");
      const selected = await subject.observeWindowState({ scope, target: observed.observation.targets[0]!.target,
        selector: { role: "text_field", action: "click", interaction, labelEquals: "Fixture item" } });
      if (!selected.ok || !selected.observation.element?.target) throw new Error("expected element");
      const operation = { kind: "click" as const, target: selected.observation.element.target,
        button, axAction: interaction === "right_click" ? "show_menu" as const : "open" as const,
        modifiers: [], deliveryMode: "foreground" as const };
      const clicked = await subject.click({ scope, operation });
      expect(clicked.receipt).toMatchObject({ completionCertainty: "unknown_completion", verification: "not_verified", deliveryMode: "foreground",
        providerAction: { effect: "unverifiable", route: "global_input", delivery: { mode: "foreground" } } });
      expect(computerMutationReceiptSchema.safeParse(clicked.receipt).success).toBe(true);
      expect(checked.calls.at(-1)).toEqual({ name: interaction,
        args: { pid: 42, window_id: 90, element_token: "private-pointer-token", delivery_mode: "foreground" } });
      expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
      await subject.click({ scope, operation });
      expect(checked.calls.filter((call) => call.name === interaction)).toHaveLength(1);
      const refreshed = await subject.observeWindowState({ scope, target: observed.observation.targets[0]!.target });
      expect(refreshed.ok).toBe(true);
    }
  });

  test("does not discard conflicting specialized click intent or consume a target before dispatch", async () => {
    for (const interaction of ["right_click", "double_click"] as const) {
      const checked = port([apps(), windows(), result({
        window_id: 90, pid: 42, element_count: 1, total_element_count: 1, returned_element_count: 1,
        elements_complete: false, tree_markdown: "private tree", _note: "private note",
        elements: [{ role: "AXTextField", label: "Fixture item", element_token: "private-pointer-token", enabled: true }],
      }), apps(), windows(), result({ effect: "unverifiable", route: "synthetic_events", delivery: { mode: "unknown" } })]);
      const subject = new CuaComputerUseAdapter({
        port: checked.value, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000,
      });
      const observed = await subject.observe({ scope, operation: "desktop_state" });
      if (!observed.ok) throw new Error("expected window");
      const selected = await subject.observeWindowState({ scope, target: observed.observation.targets[0]!.target,
        selector: { role: "text_field", action: "click", interaction, labelEquals: "Fixture item" } });
      if (!selected.ok || !selected.observation.element?.target) throw new Error("expected element");
      const target = selected.observation.element.target;
      for (const options of [{ button: "middle" as const }, { modifiers: ["cmd" as const] }, { axAction: "cancel" as const }]) {
        const refused = await subject.click({ scope, operation: { kind: "click", target, ...options } });
        expect(refused).toMatchObject({ ok: false, receipt: {
          completionCertainty: "not_completed", deliveryMode: "not_delivered", outcome: { stateChangeCertainty: "not_changed" },
        } });
        expect(checked.calls.some((call) => call.name === interaction)).toBe(false);
      }
      await subject.click({ scope, operation: { kind: "click", target } });
      expect(checked.calls.filter((call) => call.name === interaction)).toHaveLength(1);
      expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
    }
  });

  test("accepts only the pinned right-click ActionResult and preserves exact token refusal as pre-effect", async () => {
    const state = result({
      window_id: 90, pid: 42, element_count: 1, total_element_count: 1, returned_element_count: 1,
      elements_complete: false, tree_markdown: "private tree",
      elements: [{ role: "AXButton", label: "Right-click target", element_token: "private-right-token", enabled: true }],
      _note: "private note",
    });
    const malformedResults = [
      { effect: "confirmed", route: "synthetic_events", delivery: { mode: "unknown" } },
      { effect: "unverifiable", route: "accessibility", delivery: { mode: "unknown" } },
      { effect: "unverifiable", route: "synthetic_events", delivery: { mode: "background" } },
      { effect: "unverifiable", route: "synthetic_events", delivery: { mode: "unknown" }, evidence: [{ kind: "value_readback" }] },
    ];
    for (const malformedResult of malformedResults) {
      const checked = port([apps(), windows(), state, apps(), windows(), result(malformedResult)]);
      const subject = new CuaComputerUseAdapter({
        port: checked.value, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000,
      });
      const observed = await subject.observe({ scope, operation: "desktop_state" });
      if (!observed.ok) throw new Error("expected desktop observation");
      const selected = await subject.observeWindowState({
        scope, target: observed.observation.targets[0]!.target,
        selector: { role: "button", interaction: "right_click", labelEquals: "Right-click target" },
      });
      if (!selected.ok || selected.observation.element?.target === undefined) throw new Error("expected right-click target");
      const clicked = await subject.click({ scope, operation: { kind: "click", target: selected.observation.element.target } });
      expect(clicked).toMatchObject({
        ok: false,
        receipt: { completionCertainty: "unknown_completion", verification: "unavailable", outcome: { providerCondition: "malformed_response", recovery: ["observe_again", "do_not_replay"] } },
      });
      if (clicked.ok) throw new Error("expected malformed right-click result");
      const malformedReceipt = computerMutationReceiptSchema.safeParse(clicked.receipt);
      if (!malformedReceipt.success) throw new Error(JSON.stringify(malformedReceipt.error.issues));
      expect(checked.invalidateCheckedGeneration).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(clicked)).not.toMatch(/private-right-token|Right-click target|private tree|private note/);
    }

    const refusedPort = port([
      apps(), windows(), state, apps(), windows(),
      result({ status: "refused", refusal: { code: "stale_element_token", message: "private refusal" } }, true),
    ]);
    const refusedSubject = new CuaComputerUseAdapter({
      port: refusedPort.value, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000,
    });
    const observed = await refusedSubject.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected desktop observation");
    const selected = await refusedSubject.observeWindowState({
      scope, target: observed.observation.targets[0]!.target,
      selector: { role: "button", interaction: "right_click", labelEquals: "Right-click target" },
    });
    if (!selected.ok || selected.observation.element?.target === undefined) throw new Error("expected right-click target");
    const refused = await refusedSubject.click({ scope, operation: { kind: "click", target: selected.observation.element.target } });
    expect(refused).toMatchObject({
      ok: false,
      receipt: { completionCertainty: "not_completed", deliveryMode: "not_delivered", resolvedTarget: { action: "right_click" }, outcome: { targetCondition: "stale", recovery: ["observe_again"] } },
    });
    if (refused.ok) throw new Error("expected source-proven token refusal");
    const refusedReceipt = computerMutationReceiptSchema.safeParse(refused.receipt);
    if (!refusedReceipt.success) throw new Error(JSON.stringify(refusedReceipt.error.issues));
    expect(refusedPort.invalidateCheckedGeneration).toHaveBeenCalledTimes(0);
    expect(JSON.stringify(refused)).not.toMatch(/private-right-token|Right-click target|private tree|private note|private refusal/);
  });

  test("binds one button to an exact background double-click and preserves unavailable status verification", async () => {
    const privateLabel = "Right-click target";
    const privateStatus = "double:clicked";
    const state = result({
      window_id: 90, pid: 42, element_count: 1, total_element_count: 1, returned_element_count: 1,
      elements_complete: false, tree_markdown: "private double-click tree", _note: "private double-click note",
      elements: [{ role: "AXButton", label: privateLabel, element_token: "private-double-click-token", enabled: true }],
    });
    const checked = port([
      apps(), windows(), state,
      apps(), windows(),
      result({ effect: "unverifiable", route: "synthetic_events", delivery: { mode: "unknown" } }),
      apps(), windows(), apps(), windows(),
      result({ status: "unknown", stable: false, elapsed_ms: 7, samples: 11, predicates: [{ index: 0, status: "unknown", unknown_reason: "observation_unavailable", observed_json: "{\"contains_untrusted_region\":false,\"elements_complete\":false,\"matches\":0}" }] }),
    ]);
    const subject = new CuaComputerUseAdapter({
      port: checked.value, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000,
    });
    const observed = await subject.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected desktop observation");
    const selected = await subject.observeWindowState({
      scope, target: observed.observation.targets[0]!.target,
      selector: { role: "button", interaction: "double_click", labelEquals: privateLabel },
    });
    expect(selected).toMatchObject({
      ok: true,
      observation: { element: { selector: { role: "button", interaction: "double_click" }, disposition: "unique", evidence: { action: "double_click" } } },
    });
    if (!selected.ok || selected.observation.element?.target === undefined) throw new Error("expected double-click target");
    const publicSelection = windowStateObservationSchema.safeParse(selected.observation);
    if (!publicSelection.success) throw new Error(JSON.stringify(publicSelection.error.issues));
    const clicked = await subject.click({ scope, operation: { kind: "click", target: selected.observation.element.target } });
    expect(clicked).toMatchObject({
      ok: false,
      receipt: {
        deliveryMode: "unknown", completionCertainty: "unknown_completion", verification: "not_verified",
        resolvedTarget: { kind: "element", role: "button", action: "double_click", enabled: true },
        providerAction: { effect: "unverifiable", route: "synthetic_events", delivery: { mode: "unknown" } },
        outcome: { recovery: ["observe_again", "do_not_replay"] },
      },
    });
    if (clicked.ok) throw new Error("expected double-click to require fresh verification");
    const publicReceipt = computerMutationReceiptSchema.safeParse(clicked.receipt);
    if (!publicReceipt.success) throw new Error(JSON.stringify(publicReceipt.error.issues));
    expect(checked.calls.filter((call) => call.name === "double_click")).toEqual([{
      name: "double_click", args: { pid: 42, window_id: 90, element_token: "private-double-click-token", delivery_mode: "background" },
    }]);
    expect(checked.calls.filter((call) => call.name === "click")).toHaveLength(0);
    expect(JSON.stringify({ selected, clicked })).not.toMatch(/private-double-click-token|Right-click target|private double-click tree|private double-click note|double:clicked|"pid"|"window_id"/);

    const refreshed = await subject.observe({ scope, operation: "desktop_state" });
    if (!refreshed.ok) throw new Error("expected fresh desktop observation");
    const verified = await subject.verify({
      scope, target: refreshed.observation.targets[0]!.target,
      expect: [{ element: { selector: { role: "status_text", labelContains: privateStatus }, exists: true } }],
    });
    expect(verified).toMatchObject({ ok: true, verification: { status: "unknown", stable: false, samples: 11, predicates: [{ unknownReason: "observation_unavailable" }] } });
    expect(checked.calls.filter((call) => call.name === "verify_state")).toMatchObject([{
      args: { expect: [{ element: { selector: { role: "AXStaticText", label_contains: privateStatus }, exists: true } }] },
    }]);

    const invalidPort = port([apps(), windows(), exactWindowState(42, 90)]);
    const invalid = new CuaComputerUseAdapter({
      port: invalidPort.value, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000,
    });
    const invalidObserved = await invalid.observe({ scope, operation: "desktop_state" });
    if (!invalidObserved.ok) throw new Error("expected desktop observation");
    const checkbox = await invalid.observeWindowState({
      scope, target: invalidObserved.observation.targets[0]!.target,
      selector: { role: "checkbox", interaction: "double_click" },
    });
    expect(checkbox).toMatchObject({ ok: true, observation: { element: { selector: { role: "checkbox", interaction: "double_click" }, disposition: "zero" } } });
    expect(invalidPort.calls.filter((call) => call.name === "get_window_state")).toHaveLength(1);
  });

  test("does not guess among buttons and fences an unverifiable semantic click", async () => {
    const state = (elements: readonly Record<string, unknown>[]) => result({
      window_id: 90, pid: 42, element_count: elements.length, total_element_count: elements.length, returned_element_count: elements.length,
      elements_complete: false, tree_markdown: "private tree", elements, _note: "private note",
    });
    const ambiguousPort = port([apps(), windows(), state([
      { role: "AXButton", label: "First", element_token: "private-first", enabled: true },
      { role: "AXButton", label: "Second", element_token: "private-second", enabled: true },
    ])]);
    const ambiguous = new CuaComputerUseAdapter({
      port: ambiguousPort.value, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000,
    });
    const observedAmbiguous = await ambiguous.observe({ scope, operation: "desktop_state" });
    if (!observedAmbiguous.ok) throw new Error("expected desktop observation");
    const ambiguousSelection = await ambiguous.observeWindowState({
      scope, target: observedAmbiguous.observation.targets[0]!.target, selector: { role: "button" },
    });
    expect(ambiguousSelection).toMatchObject({ ok: true, observation: { element: { selector: { role: "button" }, disposition: "ambiguous" } } });
    expect(ambiguousPort.calls.filter((call) => call.name === "click")).toHaveLength(0);

    const uncertainPort = port([
      apps(), windows(),
      state([{ role: "AXButton", label: "Search", element_token: "private-search-token", enabled: true }]),
      apps(), windows(),
      result({ effect: "unverifiable", route: "accessibility", delivery: { mode: "background" } }),
    ]);
    const uncertain = new CuaComputerUseAdapter({
      port: uncertainPort.value, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000,
    });
    const observed = await uncertain.observe({ scope, operation: "desktop_state" });
    if (!observed.ok) throw new Error("expected desktop observation");
    const selected = await uncertain.observeWindowState({
      scope, target: observed.observation.targets[0]!.target, selector: { role: "button", labelEquals: "Search" },
    });
    if (!selected.ok || selected.observation.element?.target === undefined) throw new Error("expected Search button target");
    const clicked = await uncertain.click({ scope, operation: { kind: "click", target: selected.observation.element.target } });
    expect(clicked).toMatchObject({
      ok: false,
      receipt: { action: "click", completionCertainty: "unknown_completion", verification: "not_verified", outcome: { recovery: ["observe_again", "do_not_replay"] } },
    });
    if (clicked.ok) throw new Error("expected unverifiable semantic click");
    const publicReceipt = computerMutationReceiptSchema.safeParse(clicked.receipt);
    if (!publicReceipt.success) throw new Error(JSON.stringify(publicReceipt.error.issues));
    expect(computerMutationReceiptSchema.safeParse({
      ...clicked.receipt,
      completionCertainty: "completed",
      verification: "verified",
      unexecutedRemainder: { count: 0, reason: "none" },
      outcome: {
        ...clicked.receipt.outcome,
        retrySafety: "never",
        stateChangeCertainty: "changed",
        recovery: [],
      },
    }).success).toBe(false);
    expect(uncertainPort.calls.filter((call) => call.name === "click")).toHaveLength(1);
    expect(JSON.stringify(clicked)).not.toMatch(/private-search-token|private tree|private note|Search/);
  });

  test("distinguishes measured Human input from an unavailable HID sample while minting desktop authority", async () => {
    const externalPort = port([apps(), windows()]);
    const external = new CuaComputerUseAdapter({
      port: externalPort.value,
      readHidIdleNanoseconds: async () => externalPort.calls.length === 0 ? 1_000_000_000 : 0,
      monotonicMilliseconds: () => 10_000,
    });
    await expect(external.observe({ scope, operation: "desktop_state" })).resolves.toMatchObject({
      ok: false, outcome: { externalInterference: "user_input", recovery: ["observe_again"] },
    });
    const unavailablePort = port([apps(), windows()]);
    const unavailable = new CuaComputerUseAdapter({
      port: unavailablePort.value,
      readHidIdleNanoseconds: async () => { throw new Error("ioreg unavailable"); },
      monotonicMilliseconds: () => 10_000,
    });
    await expect(unavailable.observe({ scope, operation: "desktop_state" })).resolves.toMatchObject({
      ok: false, outcome: { recovery: ["observe_again"] },
    });
    const unavailableResult = await unavailable.observe({ scope, operation: "desktop_state" });
    expect(JSON.stringify(unavailableResult)).not.toContain("externalInterference");
  });

  test("invokes one exact generic menu path and keeps its semantic effect unknown", async () => {
    const runningApps = installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true, launch_path: null, kind: "application", last_used: null, windows: [] }]);
    const checked = port([
      runningApps,
      launchSuccess(),
      runningApps,
      listedWindows(77, "TextEdit", 1),
      result({ effect: "unverifiable", route: "accessibility", delivery: { mode: "foreground" } }),
      windowState(),
      runningApps,
      listedWindows(77, "TextEdit", 1),
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!launched.ok || launched.receipt.window === null) throw new Error("expected exact window");
    const invoked = await subject.invokeMenu({
      scope,
      operation: { kind: "invoke_menu", target: launched.receipt.window, menuPath: ["View", "as List"] },
    });
    expect(invoked).toMatchObject({
      ok: false,
      receipt: {
        action: "invoke_menu", deliveryMode: "foreground", completionCertainty: "unknown_completion", verification: "not_verified",
        providerAction: { effect: "unverifiable", route: "accessibility", delivery: { mode: "foreground" } },
        unexecutedRemainder: { count: 1, reason: "unknown_completion" },
        outcome: { recovery: ["observe_again", "do_not_replay"] },
      },
    });
    if (invoked.ok) throw new Error("generic menu effect must require fresh observation");
    expect(computerMutationReceiptSchema.safeParse(invoked.receipt).success).toBe(true);
    expect(checked.calls.at(-1)).toEqual({ name: "invoke_menu", args: { pid: 77, window_id: 500, path: ["View", "as List"] } });
    expect((await subject.invokeMenu({ scope, operation: { kind: "invoke_menu", target: launched.receipt.window, menuPath: ["View", "as List"] } })).ok).toBe(false);
    expect(checked.calls).toHaveLength(5);
    expect((await subject.observeWindowState({ scope, target: launched.receipt.window })).ok).toBe(true);
    if (launched.receipt.app.target === null) throw new Error("expected application anchor");
    expect((await subject.observeApplicationWindows({ scope, target: launched.receipt.app.target })).ok).toBe(true);
    expect(checked.calls.filter((call) => call.name === "invoke_menu")).toHaveLength(1);
    expect(checked.leaseState.active).toBe(1);
    await subject.close();
  });

  test("sets one exact window frame and verifies it from fresh same-session inventory", async () => {
    const runningApps = installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true, launch_path: null, kind: "application", last_used: null, windows: [] }]);
    const changedWindows = listedRawWindows([{
      window_id: 500, pid: 77, app_name: "TextEdit", title: "Untitled 1",
      bounds: { x: -100, y: 120, width: 900, height: 700 }, layer: 0, z_index: 0,
      is_on_screen: true, current_space_id: 1, on_current_space: true, space_ids: [1],
    }]);
    const checked = port([
      runningApps,
      launchSuccess(),
      runningApps,
      listedWindows(77, "TextEdit", 1),
      result({ effect: "confirmed", route: "accessibility", delivery: { mode: "not_applicable" }, evidence: [{ kind: "value_readback" }] }),
      runningApps,
      changedWindows,
    ]);
    const subject = new CuaComputerUseAdapter({ port: checked.value });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!launched.ok || launched.receipt.window === null) throw new Error("expected exact window");
    const framed = await subject.setWindowFrame({
      scope,
      operation: { kind: "set_window_frame", target: launched.receipt.window, frame: { x: -100, y: 120, width: 900, height: 700 } },
    });
    expect(framed).toMatchObject({
      ok: true,
      receipt: {
        action: "set_window_frame", deliveryMode: "not_applicable", completionCertainty: "completed", verification: "verified",
        providerAction: { effect: "confirmed", route: "accessibility", delivery: { mode: "not_applicable" }, evidenceKinds: ["value_readback"] },
        unexecutedRemainder: { count: 0, reason: "none" },
        outcome: { stateChangeCertainty: "changed", targetCondition: "current", recovery: [] },
      },
    });
    if (!framed.ok) throw new Error("expected exact verified frame");
    expect(computerMutationReceiptSchema.safeParse(framed.receipt).success).toBe(true);
    expect(checked.calls[4]).toEqual({
      name: "set_window_frame", args: { pid: 77, window_id: 500, x: -100, y: 120, width: 900, height: 700 },
    });
    expect(checked.calls.slice(5).map((call) => call.name)).toEqual(["list_apps", "list_windows"]);
  });

  test("accepts normal two-pixel AppKit frame settlement and returns a schema-valid unknown beyond it", async () => {
    const runningApps = installedApps([{ pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true, launch_path: null, kind: "application", last_used: null, windows: [] }]);
    const changed = (bounds: Readonly<{ x: number; y: number; width: number; height: number }>) => listedRawWindows([{
      window_id: 500, pid: 77, app_name: "TextEdit", title: "Untitled 1", bounds,
      layer: 0, z_index: 0, is_on_screen: true, current_space_id: 1, on_current_space: true, space_ids: [1],
    }]);
    const action = result({ effect: "confirmed", route: "accessibility", delivery: { mode: "not_applicable" }, evidence: [{ kind: "value_readback" }] });

    const within = port([runningApps, launchSuccess(), runningApps, listedWindows(77, "TextEdit", 1), action, runningApps, changed({ x: -98, y: 119, width: 899, height: 702 })]);
    const withinSubject = new CuaComputerUseAdapter({ port: within.value });
    const withinLaunch = await withinSubject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!withinLaunch.ok || withinLaunch.receipt.window === null) throw new Error("expected exact window");
    await expect(withinSubject.setWindowFrame({
      scope, operation: { kind: "set_window_frame", target: withinLaunch.receipt.window, frame: { x: -100, y: 120, width: 900, height: 700 } },
    })).resolves.toMatchObject({ ok: true, receipt: { completionCertainty: "completed", verification: "verified" } });

    const beyond = port([runningApps, launchSuccess(), runningApps, listedWindows(77, "TextEdit", 1), action, runningApps, changed({ x: -97, y: 120, width: 900, height: 700 })]);
    const beyondSubject = new CuaComputerUseAdapter({ port: beyond.value });
    const beyondLaunch = await beyondSubject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    if (!beyondLaunch.ok || beyondLaunch.receipt.window === null) throw new Error("expected exact window");
    const uncertain = await beyondSubject.setWindowFrame({
      scope, operation: { kind: "set_window_frame", target: beyondLaunch.receipt.window, frame: { x: -100, y: 120, width: 900, height: 700 } },
    });
    expect(uncertain).toMatchObject({ ok: false, receipt: { completionCertainty: "unknown_completion", verification: "not_verified", providerAction: null } });
    if (uncertain.ok) throw new Error("three-pixel settlement must remain unverified");
    expect(computerMutationReceiptSchema.safeParse(uncertain.receipt).success).toBe(true);
  });

  test("retains only the checked foreground menu fact for a complete nonunique create handoff", async () => {
    const row = { window_id: 500, pid: 77, app_name: "TextEdit", title: "Untitled", bounds: { x: 1, y: 2, width: 800, height: 600 }, layer: 0, z_index: 0, is_on_screen: true, current_space_id: 1, on_current_space: true, space_ids: [1] };
    const checked = port([
      result({ windows: [row], current_space_id: 1 }),
      result({ effect: "unverifiable", route: "accessibility", delivery: { mode: "foreground" } }),
      ...Array.from({ length: 12 }, () => result({ windows: [row], current_space_id: 1 })),
    ]);
    const registry = new ComputerUseContextRegistry();
    const initial = registry.create(scope);
    if (!initial.ok) throw new Error("expected context");
    const app = registry.registerTargets(initial.data.context, scope, [{
      evidence: { kind: "app", appLabel: "TextEdit" },
      providerTarget: { provider: "cua", operation: "observe_only", app: "TextEdit", pid: 77, bundleId: "com.apple.TextEdit" },
    }]);
    if (!app.ok) throw new Error("expected app");
    const subject = new CuaComputerUseAdapter({
      port: checked.value, registry, readHidIdleNanoseconds: async () => 1_000_000_000,
      monotonicMilliseconds: () => 10_000, sleep: async () => undefined,
    });
    const created = await subject.createWindow({ scope, operation: { kind: "create_window", target: { context: initial.data.context, reference: app.data[0]!.reference }, menuPath: ["File", "New"] } });
    expect(created).toMatchObject({
      ok: false,
      receipt: {
        completionCertainty: "unknown_completion", verification: "not_verified", deliveryMode: "foreground",
        providerAction: { effect: "unverifiable", route: "accessibility", delivery: { mode: "foreground" } },
        postObservation: { disposition: "none_observed" },
        outcome: { retrySafety: "observe_before_retry", providerCondition: "ready", targetCondition: "current", recovery: ["observe_again", "do_not_replay"] },
      },
    });
    if (!created.ok) expect(computerMutationReceiptSchema.safeParse(created.receipt).success).toBe(true);
  });

  test("creates a Chrome window through the caller's exact native menu path and unique set difference", async () => {
    const existing = { window_id: 700, pid: 88, app_name: "Google Chrome", title: "New Tab", bounds: { x: 1, y: 2, width: 800, height: 600 }, layer: 0, z_index: 0, is_on_screen: true, current_space_id: 1, on_current_space: true, space_ids: [1] };
    const appeared = { ...existing, window_id: 701, z_index: 1 };
    const helper = { ...existing, window_id: 702, title: "", bounds: { x: 0, y: 0, width: 800, height: 33 }, z_index: 2,
      is_on_screen: false, on_current_space: null, space_ids: null };
    const checked = port([
      result({ windows: [existing, helper], current_space_id: 1 }),
      result({ effect: "unverifiable", route: "accessibility", delivery: { mode: "foreground" } }),
      result({ windows: [existing, appeared, helper, { ...helper, window_id: 703, z_index: 3 }], current_space_id: 1 }),
    ]);
    const registry = new ComputerUseContextRegistry();
    const initial = registry.create(scope);
    if (!initial.ok) throw new Error("expected context");
    const app = registry.registerTargets(initial.data.context, scope, [{
      evidence: { kind: "app", appLabel: "Google Chrome" },
      providerTarget: { provider: "cua", operation: "observe_only", app: "Google Chrome", pid: 88, bundleId: "com.google.Chrome" },
    }]);
    if (!app.ok) throw new Error("expected Chrome app");
    const subject = new CuaComputerUseAdapter({
      port: checked.value,
      registry,
      readHidIdleNanoseconds: async () => 1_000_000_000,
      monotonicMilliseconds: () => 10_000,
    });

    const created = await subject.createWindow({
      scope,
      operation: {
        kind: "create_window",
        target: { context: initial.data.context, reference: app.data[0]!.reference },
        menuPath: ["File", "New Window"],
      },
    });

    expect(created).toMatchObject({
      ok: true,
      receipt: {
        action: "create_window",
        completionCertainty: "completed",
        verification: "verified",
        postObservation: { disposition: "unique" },
      },
    });
    expect(checked.calls.filter((call) => call.name === "invoke_menu")).toEqual([{
      name: "invoke_menu",
      args: { pid: 88, window_id: 700, path: ["File", "New Window"] },
    }]);
  });

  test("projects an unresolved create_window app target as the receipt-only unavailable evidence variant", async () => {
    const registry = new ComputerUseContextRegistry();
    const initial = registry.create(scope);
    if (!initial.ok) throw new Error("expected context");
    const subject = new CuaComputerUseAdapter({ port: port([]).value, registry });
    const failed = await subject.createWindow({
      scope,
      operation: { kind: "create_window", target: { context: initial.data.context, reference: `datgt_${"A".repeat(43)}` }, menuPath: ["File", "New"] },
    });
    expect(failed).toMatchObject({ ok: false, receipt: { resolvedTarget: { kind: "app", state: "unavailable" } } });
    if (failed.ok) throw new Error("expected unresolved create receipt");
    expect(computerMutationReceiptSchema.safeParse(failed.receipt).success).toBe(true);
    // The caller's opaque app reference remains usable semantic routing
    // state; native provider identifiers never cross this boundary.
    expect(JSON.stringify(failed.receipt)).not.toMatch(/"pid"|"window_id"/);
  });

  test("fails closed at exact mutation and verification boundaries without confusing HID unavailability for Human input", async () => {
    const freshTarget = async (mode: "external" | "unavailable") => {
      let idle: number | null = 1_000_000_000;
      const checked = port([apps(), windows()]);
      const subject = new CuaComputerUseAdapter({
        port: checked.value,
        readHidIdleNanoseconds: async () => {
          if (idle === null) throw new Error("ioreg unavailable");
          return idle;
        },
        monotonicMilliseconds: () => 10_000,
      });
      const observed = await subject.observe({ scope, operation: "desktop_state" });
      if (!observed.ok) throw new Error("expected authority mint");
      idle = mode === "external" ? 0 : null;
      return { checked, subject, target: observed.observation.targets[0]!.target };
    };

    for (const mode of ["external", "unavailable"] as const) {
      const mutation = await freshTarget(mode);
      const typed = await mutation.subject.typeText({ scope, operation: { kind: "type_text", target: mutation.target, text: "TEST" } });
      expect(typed).toMatchObject({ ok: false, outcome: { recovery: ["observe_again"] } });
      expect(JSON.stringify(typed).includes("externalInterference")).toBe(mode === "external");
      expect(mutation.checked.calls.filter((call) => call.name === "type_text")).toHaveLength(0);

      const verification = await freshTarget(mode);
      const verified = await verification.subject.verify({ scope, target: verification.target, expect: [{ window: { exists: true } }] });
      expect(verified).toMatchObject({ ok: false, outcome: { recovery: ["observe_again"] } });
      expect(JSON.stringify(verified).includes("externalInterference")).toBe(mode === "external");
      expect(verification.checked.calls.filter((call) => call.name === "verify_state")).toHaveLength(0);
    }
  });

  test("fences a Human epoch advance during awaited preflight before type_text or verify_state dispatch", async () => {
    const afterPreflightTakeover = async (kind: "type" | "verify") => {
      let samples = 0;
      const checked = port([apps(), windows(), apps(), windows()]);
      const subject = new CuaComputerUseAdapter({
        port: checked.value,
        readHidIdleNanoseconds: async () => (++samples >= 4 ? 0 : 1_000_000_000),
        monotonicMilliseconds: () => 10_000,
      });
      const observed = await subject.observe({ scope, operation: "desktop_state" });
      if (!observed.ok) throw new Error("expected authority mint");
      const target = observed.observation.targets[0]!.target;
      if (kind === "type") {
        const typed = await subject.typeText({ scope, operation: { kind: "type_text", target, text: "TEST" } });
        expect(typed).toMatchObject({ ok: false, outcome: { externalInterference: "user_input", recovery: ["observe_again"] } });
        expect(checked.calls.filter((call) => call.name === "type_text")).toHaveLength(0);
      } else {
        const verified = await subject.verify({ scope, target, expect: [{ window: { exists: true } }] });
        expect(verified).toMatchObject({ ok: false, outcome: { externalInterference: "user_input", recovery: ["observe_again"] } });
        expect(checked.calls.filter((call) => call.name === "verify_state")).toHaveLength(0);
      }
    };
    await afterPreflightTakeover("type");
    await afterPreflightTakeover("verify");
  });

  test("fences Human takeover around focus preflight and action without falsely labeling an unavailable sample", async () => {
    const runFocus = async (mode: "pre" | "post" | "unavailable") => {
      let samples = 0;
      const checked = port([apps(), windows(), apps(), windows(), focused()]);
      const subject = new CuaComputerUseAdapter({
        port: checked.value,
        readHidIdleNanoseconds: async () => {
          samples += 1;
          if (mode === "unavailable" && samples >= 4) throw new Error("ioreg unavailable");
          if (mode === "pre" && samples >= 4) return 0;
          if (mode === "post" && samples >= 5) return 0;
          return 1_000_000_000;
        },
        monotonicMilliseconds: () => 10_000,
      });
      const observed = await subject.observe({ scope, operation: "desktop_state" });
      if (!observed.ok) throw new Error("expected authority mint");
      const focusedResult = await subject.focus({ scope, operation: { kind: "focus", target: observed.observation.targets[0]!.target } });
      expect(focusedResult.ok).toBe(false);
      expect(JSON.stringify(focusedResult).includes("externalInterference")).toBe(mode !== "unavailable");
      if (mode === "pre") {
        expect(focusedResult).toMatchObject({ receipt: { completionCertainty: "not_completed", outcome: { stateChangeCertainty: "not_changed", recovery: ["observe_again"] } } });
        expect(checked.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(0);
      } else {
        expect(focusedResult).toMatchObject({ receipt: { completionCertainty: mode === "post" ? "unknown_completion" : "not_completed" } });
        expect(checked.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(mode === "post" ? 1 : 0);
      }
    };
    await runFocus("pre");
    await runFocus("post");
    await runFocus("unavailable");
  });

  test("fences Human input during launch discovery before launch_app dispatch", async () => {
    let samples = 0;
    const checked = port([installedApps([
      { pid: 0, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: false, running: false, launch_path: "/System/Applications/TextEdit.app", kind: "application", last_used: null, windows: [] },
    ])]);
    const subject = new CuaComputerUseAdapter({
      port: checked.value,
      readHidIdleNanoseconds: async () => (++samples >= 2 ? 0 : 1_000_000_000),
      monotonicMilliseconds: () => 10_000,
    });
    const launched = await subject.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
    expect(launched).toMatchObject({ ok: false, outcome: { externalInterference: "user_input", recovery: ["observe_again"] } });
    expect(checked.calls).toEqual([{ name: "list_apps", args: {} }]);
  });

  test("never chooses a blank-looking AXTextArea with a sibling or malformed enabled state", async () => {
    const registry = new ComputerUseContextRegistry();
    const successor = registry.createAppearedWindowContext(scope, 0, {
      evidence: { kind: "app", appLabel: "TextEdit" },
      providerTarget: { provider: "cua", operation: "observe_only", app: "TextEdit", pid: 77, bundleId: "com.apple.TextEdit" },
    }, {
      evidence: { kind: "window", appLabel: "TextEdit" },
      providerTarget: { provider: "cua", operation: "focus", app: "TextEdit", pid: 77, windowId: 900, bundleId: "com.apple.TextEdit", freshAppeared: true },
    });
    if (!successor.ok) throw new Error("expected successor");
    const checked = port([result({
      window_id: 900, pid: 77, element_count: 2, total_element_count: 2, returned_element_count: 2,
      elements_complete: false, tree_markdown: "private", _note: "private",
      elements: [
        { role: "AXTextArea", element_token: "blank-token", enabled: true },
        { role: "AXTextArea", element_token: "nonblank-token", value: "existing", enabled: true },
      ],
    })]);
    const subject = new CuaComputerUseAdapter({ port: checked.value, registry });
    const observed = await subject.observeWindowState({
      scope,
      target: { context: successor.data.context, reference: successor.data.window.reference },
      selector: { role: "text_area" },
    });
    expect(observed).toMatchObject({ ok: true, observation: { element: { disposition: "ambiguous" } } });
    if (!observed.ok || observed.observation.element === undefined) throw new Error("expected element resolution");
    expect(observed.observation.element.target).toBeUndefined();

    const malformedRegistry = new ComputerUseContextRegistry();
    const malformedSuccessor = malformedRegistry.createAppearedWindowContext(scope, 0, {
      evidence: { kind: "app", appLabel: "TextEdit" },
      providerTarget: { provider: "cua", operation: "observe_only", app: "TextEdit", pid: 77, bundleId: "com.apple.TextEdit" },
    }, {
      evidence: { kind: "window", appLabel: "TextEdit" },
      providerTarget: { provider: "cua", operation: "focus", app: "TextEdit", pid: 77, windowId: 901, bundleId: "com.apple.TextEdit", freshAppeared: true },
    });
    if (!malformedSuccessor.ok) throw new Error("expected malformed successor fixture");
    const malformedPort = port([result({
      window_id: 901, pid: 77, element_count: 1, total_element_count: 1, returned_element_count: 1,
      elements_complete: false, tree_markdown: "private", _note: "private",
      elements: [{ role: "AXTextArea", element_token: "private-token", enabled: "false" }],
    })]);
    const malformedSubject = new CuaComputerUseAdapter({ port: malformedPort.value, registry: malformedRegistry });
    const malformed = await malformedSubject.observeWindowState({
      scope,
      target: { context: malformedSuccessor.data.context, reference: malformedSuccessor.data.window.reference },
      selector: { role: "text_area" },
    });
    expect(malformed).toMatchObject({ ok: true, observation: { element: { disposition: "incomplete" } } });
    if (!malformed.ok || malformed.observation.element === undefined) throw new Error("expected malformed element resolution");
    expect(malformed.observation.element.target).toBeUndefined();
  });

  test("keeps source-proven element token and target-window refusals pre-effect without withdrawing Cua", async () => {
    const refusals = [
      { status: "refused", refusal: { code: "stale_element_token", message: "private" } },
      { status: "refused", refusal: { code: "generation_mismatch", message: "private" } },
      { status: "refused", refusal: { code: "invalid_element_token", message: "private" } },
      { status: "refused", refusal: { code: "conflicting_element_target", message: "private" } },
      { effect: "refused", code: "element_outside_target_window", pid: 42, window_id: 90, reason: "private", escalation: { recommended: "get_window_state", reason: "private" } },
    ] as const;
    for (const refusal of refusals) {
      const registry = new ComputerUseContextRegistry();
      const initial = registry.create(scope);
      if (!initial.ok) throw new Error("expected context");
      const element = registry.registerTargets(initial.data.context, scope, [{
        evidence: { kind: "element", role: "text_area" },
        providerTarget: { provider: "cua", operation: "type_text", app: "Nautilo", pid: 42, windowId: 90, elementToken: "private-token" },
      }]);
      if (!element.ok) throw new Error("expected element");
      const checked = port([apps(), windows(), result(refusal, true)]);
      const subject = new CuaComputerUseAdapter({ port: checked.value, registry });
      const typed = await subject.typeText({ scope, operation: { kind: "type_text", target: { context: initial.data.context, reference: element.data[0]!.reference }, text: "TEST" } });
      expect(typed).toMatchObject({ ok: false, receipt: { completionCertainty: "not_completed", outcome: { phase: "pre_effect_dispatch", retrySafety: "observe_before_retry", recovery: ["observe_again"] } } });
      expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
    }
  });

  test("rejects hostile successful invoke_menu envelopes before a successor context can mint", async () => {
    const base = { window_id: 500, pid: 77, app_name: "TextEdit", title: "Untitled", bounds: { x: 1, y: 2, width: 800, height: 600 }, layer: 0, z_index: 0, is_on_screen: true, current_space_id: 1, on_current_space: true, space_ids: [1] };
    for (const action of [
      { effect: "confirmed", route: "accessibility", delivery: { mode: "foreground" }, evidence: [{ kind: "native_api_result" }] },
      { effect: "unverifiable", route: "system_api", delivery: { mode: "foreground" } },
      { effect: "unverifiable", route: "accessibility", delivery: { mode: "background" } },
      { effect: "unverifiable", route: "accessibility", delivery: { mode: "foreground" }, evidence: [{ kind: "native_api_result" }] },
    ]) {
      const checked = port([result({ windows: [base], current_space_id: 1 }), result(action)]);
      const registry = new ComputerUseContextRegistry();
      const initial = registry.create(scope);
      if (!initial.ok) throw new Error("expected context");
      const app = registry.registerTargets(initial.data.context, scope, [{ evidence: { kind: "app", appLabel: "TextEdit" }, providerTarget: { provider: "cua", operation: "observe_only", app: "TextEdit", pid: 77, bundleId: "com.apple.TextEdit" } }]);
      if (!app.ok) throw new Error("expected app");
      const subject = new CuaComputerUseAdapter({ port: checked.value, registry, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000 });
      const outcome = await subject.createWindow({ scope, operation: { kind: "create_window", target: { context: initial.data.context, reference: app.data[0]!.reference }, menuPath: ["File", "New"] } });
      expect(outcome).toMatchObject({ ok: false, receipt: { completionCertainty: "unknown_completion", verification: "not_verified", postObservation: { disposition: "incomplete" } } });
      expect(registry.resolveTarget(initial.data.context, scope, app.data[0]!.reference)).toEqual({ ok: false, code: "replay_forbidden" });
      expect(checked.calls.filter((call) => call.name === "list_windows")).toHaveLength(1);
    }
  });

  test("delegates exact menu activation to invoke_menu without pre-focus or AX probing", async () => {
    const base = { window_id: 500, pid: 77, app_name: "TextEdit", title: "Untitled", bounds: { x: 1, y: 2, width: 800, height: 600 }, layer: 0, z_index: 0, is_on_screen: true, current_space_id: 1, on_current_space: true, space_ids: [1] };
    const appeared = { ...base, window_id: 501, z_index: 1 };
    const checked = port([
      result({ windows: [base], current_space_id: 1 }),
      result({ effect: "unverifiable", route: "accessibility", delivery: { mode: "foreground" } }),
      result({ windows: [base, appeared], current_space_id: 1 }),
    ]);
    const registry = new ComputerUseContextRegistry();
    const initial = registry.create(scope);
    if (!initial.ok) throw new Error("expected context");
    const app = registry.registerTargets(initial.data.context, scope, [{
      evidence: { kind: "app", appLabel: "TextEdit" },
      providerTarget: { provider: "cua", operation: "observe_only", app: "TextEdit", pid: 77, bundleId: "com.apple.TextEdit" },
    }]);
    if (!app.ok) throw new Error("expected app");
    const subject = new CuaComputerUseAdapter({
      port: checked.value, registry, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000,
    });
    const created = await subject.createWindow({
      scope,
      operation: { kind: "create_window", target: { context: initial.data.context, reference: app.data[0]!.reference }, menuPath: ["File", "New"] },
    });
    expect(created).toMatchObject({ ok: true, receipt: { completionCertainty: "completed", postObservation: { disposition: "unique" } } });
    if (!created.ok) throw new Error("expected direct menu completion");
    expect(computerMutationReceiptSchema.safeParse(created.receipt).success).toBe(true);
    expect(checked.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(0);
    expect(checked.calls.filter((call) => call.name === "get_window_state")).toHaveLength(0);
    expect(checked.calls.filter((call) => call.name === "invoke_menu")).toEqual([{ name: "invoke_menu", args: { pid: 77, window_id: 500, path: ["File", "New"] } }]);
  });

  test("keeps an exact invoke_menu path refusal pre-effect and reusable", async () => {
    const base = { window_id: 500, pid: 77, app_name: "TextEdit", title: "Untitled", bounds: { x: 1, y: 2, width: 800, height: 600 }, layer: 0, z_index: 0, is_on_screen: true, current_space_id: 1, on_current_space: true, space_ids: [1] };
    const checked = port([
      result({ windows: [base], current_space_id: 1 }),
      result({ status: "refused", refusal: { code: "menu_path_unavailable", message: "private" } }, true),
    ]);
    const registry = new ComputerUseContextRegistry();
    const initial = registry.create(scope);
    if (!initial.ok) throw new Error("expected context");
    const app = registry.registerTargets(initial.data.context, scope, [{
      evidence: { kind: "app", appLabel: "TextEdit" },
      providerTarget: { provider: "cua", operation: "observe_only", app: "TextEdit", pid: 77, bundleId: "com.apple.TextEdit" },
    }]);
    if (!app.ok) throw new Error("expected app");
    const subject = new CuaComputerUseAdapter({
      port: checked.value, registry, readHidIdleNanoseconds: async () => 1_000_000_000, monotonicMilliseconds: () => 10_000,
    });
    const created = await subject.createWindow({
      scope,
      operation: { kind: "create_window", target: { context: initial.data.context, reference: app.data[0]!.reference }, menuPath: ["File", "New"] },
    });
    expect(created).toMatchObject({
      ok: false,
      receipt: {
        completionCertainty: "not_completed", deliveryMode: "not_delivered", providerAction: null,
        outcome: { phase: "pre_effect_dispatch", stateChangeCertainty: "not_changed", recovery: ["observe_again"] },
      },
    });
    if (created.ok) throw new Error("expected menu refusal");
    expect(computerMutationReceiptSchema.safeParse(created.receipt).success).toBe(true);
    expect(checked.calls.filter((call) => call.name === "bring_to_front")).toHaveLength(0);
    expect(checked.calls.filter((call) => call.name === "invoke_menu")).toHaveLength(1);
    expect(registry.resolveTarget(initial.data.context, scope, app.data[0]!.reference).ok).toBe(true);
  });
});
