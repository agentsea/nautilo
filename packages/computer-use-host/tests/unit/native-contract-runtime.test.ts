import { deflateSync } from "node:zlib";
import { expect, mock, test } from "bun:test";
import { COMPUTER_USE_NATIVE_CONTRACTS, NATIVE_CONTRACT_SCHEMAS } from "@nautilo/computer-use-contracts/native";
import { NATIVE_COMPATIBILITY_SCHEMAS, validateNativeCompatibility } from "@nautilo/computer-use-contracts/native-compatibility";
import { parseComputerUseHostContract, type ComputerUseHostContract } from "@nautilo/computer-use-host-protocol";
import { encodePngAttachmentFrame } from "@nautilo/computer-use-host-protocol/node";

import { CuaNativeContractRuntime } from "../../src/native-contract-runtime.ts";
import { ComputerUseHost } from "../../src/runtime.ts";

const suffix = "a".repeat(43);
const context = `dctx_${suffix}`;
const windowTarget = { version: 1 as const, context, reference: `dtgt_${suffix}` };
const snapshotTarget = { version: 1 as const, context, reference: `dsnap_${suffix}` };
const regionTarget = { version: 1 as const, context, reference: `dsnap_${"b".repeat(43)}` };
const elementTarget = { version: 1 as const, context, reference: `detgt_${suffix}` };
const appTarget = { version: 1 as const, context, reference: `datgt_${suffix}` };
const authority = { authorityLeaseId: "lease-1", authorityGeneration: 1 } as const;
const fence = { hostGeneration: "host-1", driverGeneration: "driver-1", cancellationGeneration: 1 } as const;
const outcome = {
  version: 1 as const,
  phase: "observe" as const,
  retrySafety: "safe" as const,
  stateChangeCertainty: "not_applicable" as const,
  providerCondition: "ready" as const,
  targetCondition: "current" as const,
  recovery: ["retry_same_request" as const],
};

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const hashed = Buffer.concat([typeBytes, data]);
  let crc = 0xffffffff;
  for (const byte of hashed) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 0 ? crc >>> 1 : (crc >>> 1) ^ 0xedb88320;
  }
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length);
  typeBytes.copy(output, 4);
  Buffer.from(data).copy(output, 8);
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
  return output;
}

function onePixelPng(): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Uint8Array.from(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 255]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]));
}

function nativeScope() {
  return {
    computerUseContextId: "server-context-1",
    installationEpoch: "epoch-1",
    grantGeneration: 1,
    provider: "cua" as const,
    providerGeneration: "driver-1",
    originHumanId: "human-1",
    originRunId: "run-1",
    originAgentId: "agent-1",
    lineageId: "lineage-1",
    serverBindingId: "binding-1",
    relayId: "relay-1",
    pairingGeneration: "pairing-1",
    desktopSessionId: "desktop-1",
  };
}

function fakeAdapter() {
  const unexpected = mock(async () => { throw new Error("unexpected native route"); });
  return {
    observe: unexpected,
    observeApplicationWindows: unexpected,
    observeWindowState: mock(async () => ({
      ok: true as const,
      observation: {
        version: 1 as const,
        operation: "window_state" as const,
        target: windowTarget,
        evidence: { kind: "window" as const, appLabel: "Spotify", windowLabel: "Spotify Premium", bounds: { x: 0, y: 0, width: 1, height: 1 } },
        completeness: "sufficient" as const,
        degraded: false,
        verification: "supported" as const,
        element: {
          selector: { role: "button" as const },
          disposition: "unique" as const,
          target: elementTarget,
          evidence: { kind: "element" as const, role: "button" as const, action: "click" as const },
        },
        windowSnapshot: {
          target: snapshotTarget,
          evidence: { kind: "screen" as const },
          metadata: { format: "png" as const, dimensions: { width: 1, height: 1 }, coordinateSpace: "window_snapshot_pixels" as const },
        },
        semanticQuery: {
          query: "Premium",
          effort: { maxElements: 6_000, maxDepth: 40 },
          exhaustive: false as const,
          matched: 1,
          returned: 1,
          omitted: 0,
          matches: [{ role: "button" as const, label: "Premium", labelTruncated: false, valueTruncated: false }],
        },
        outcome,
      },
      visionImage: { mime: "image/png" as const, bytes: onePixelPng() },
    })),
    observeWindowRegion: mock(async () => ({
      ok: true as const,
      observation: {
        version: 1 as const,
        operation: "window_region" as const,
        source: snapshotTarget,
        regionSnapshot: {
          target: regionTarget,
          evidence: { kind: "screen" as const },
          metadata: { format: "png" as const, dimensions: { width: 1, height: 1 }, coordinateSpace: "presented_snapshot_pixels" as const },
        },
        outcome: { ...outcome, retrySafety: "never" as const, recovery: [] },
      },
      visionImage: { mime: "image/png" as const, bytes: onePixelPng() },
    })),
    launchApp: mock(async () => ({
      ok: true as const,
      receipt: {
        version: 1 as const,
        timing: "immediate" as const,
        action: "launch_app" as const,
        app: { name: "Spotify", target: { version: 1 as const, context, reference: `datgt_${suffix}` } },
        window: windowTarget,
        launchProgress: { requested: true, processRunning: true, windowReady: true },
        windowSelection: "unique" as const,
        completionCertainty: "completed" as const,
        verification: "required" as const,
        outcome: { ...outcome, phase: "post_effect_verification" as const, retrySafety: "never" as const, stateChangeCertainty: "changed" as const, recovery: [] },
      },
    })),
    focus: unexpected,
    click: unexpected,
    dragDrop: unexpected,
    movePointer: unexpected,
    invokeMenu: unexpected,
    typeText: unexpected,
    setValue: unexpected,
    setWindowFrame: unexpected,
    scroll: unexpected,
    pressKey: unexpected,
    hotkey: unexpected,
    createWindow: unexpected,
    verify: mock(async () => ({
      ok: true as const,
      verification: {
        version: 1 as const,
        target: windowTarget,
        provider: "cua" as const,
        status: "satisfied" as const,
        stable: true,
        elapsedMs: 5,
        samples: 2,
        predicates: [{ index: 0, status: "satisfied" as const, unknownReason: null }],
        outcome,
      },
    })),
  };
}

function request(contract: ComputerUseHostContract, requestId: string, argumentsValue: object) {
  return { kind: "request" as const, protocol: { major: 3 as const, minor: 0 as const }, requestId, authority, fence, contract, arguments: argumentsValue };
}

test("a new Host serves the previous native contracts without changing their schema or dispatching twice", async () => {
  const adapter = fakeAdapter();
  const original = adapter.observeWindowState;
  const enhanced = {
    ...adapter,
    observeWindowState: mock(async () => {
      const result = await original();
      return { ...result, observation: {
        ...result.observation,
        element: { ...result.observation.element, state: { completeness: "partial", value: "current" } },
        controlCollection: { completeness: "partial", received: 0, omitted: 0, controls: [] },
      } };
    }),
  };
  const native = new CuaNativeContractRuntime({ adapter: enhanced as never, scopeForAuthority: nativeScope });
  const host = new ComputerUseHost({ hostGeneration: "host-1", driverGeneration: "driver-1", handlers: native.handlers });
  for (const schema of NATIVE_COMPATIBILITY_SCHEMAS) {
    const contract = parseComputerUseHostContract(schema.descriptor);
    expect(host.ready().contracts).toContainEqual(contract);
    const observe = contract.contractId === "native.observe";
    const result = await host.dispatch(request(contract, observe ? "old-read" : "old-action", observe
      ? { operation: "window_state", target: windowTarget, capture: "window_snapshot", selector: { role: "button" } }
      : { operation: { kind: "launch_app", app: { name: "Spotify" } } }));
    expect(result?.settlement).toBe("completed");
    expect(validateNativeCompatibility(result?.result, schema.result)).toBe(true);
    expect(result?.contract).toEqual(contract);
    if (observe) {
      expect(result?.result).not.toHaveProperty("controlCollection");
      expect(result?.result).not.toHaveProperty("element.state");
      expect(host.takeAttachment("old-read")).not.toBeNull();
    }
  }
  expect(enhanced.observeWindowState).toHaveBeenCalledTimes(1);
  expect(adapter.launchApp).toHaveBeenCalledTimes(1);
});

test("a compatibility request with a substituted digest never reaches the native adapter", async () => {
  const adapter = fakeAdapter();
  const native = new CuaNativeContractRuntime({ adapter: adapter as never, scopeForAuthority: nativeScope });
  const host = new ComputerUseHost({ hostGeneration: "host-1", driverGeneration: "driver-1", handlers: native.handlers });
  const contract = parseComputerUseHostContract(NATIVE_COMPATIBILITY_SCHEMAS[0]!.descriptor);
  const result = await host.dispatch(request({ ...contract, schemaDigest: "sha256:" + "f".repeat(64) }, "wrong-digest", {
    operation: "window_state", target: windowTarget,
  }));
  expect(result?.result).toEqual({ status: "host_rejected", reason: "unsupported_contract" });
  expect(adapter.observeWindowState).not.toHaveBeenCalled();
});

test("native Host delegates exact semantic contracts and keeps PNG bytes on the dedicated attachment lane", async () => {
  const adapter = fakeAdapter();
  const scopeForAuthority = mock(() => nativeScope());
  const native = new CuaNativeContractRuntime({ adapter: adapter as never, scopeForAuthority });
  const host = new ComputerUseHost({ hostGeneration: "host-1", driverGeneration: "driver-1", handlers: native.handlers });

  const observed = await host.dispatch(request(COMPUTER_USE_NATIVE_CONTRACTS.observe, "observe-1", {
    operation: "window_state",
    target: windowTarget,
    capture: "window_snapshot",
    query: "Premium",
    selector: { role: "button" },
    effort: { maxElements: 6_000, maxDepth: 40 },
  }));
  expect(observed).toMatchObject({ settlement: "completed", result: { operation: "window_state" }, attachment: { width: 1, height: 1, coordinateSpace: "window_snapshot_pixels" } });
  expect(scopeForAuthority).toHaveBeenCalledWith(authority);
  expect(adapter.observeWindowState).toHaveBeenCalledTimes(1);
  expect(adapter.observeWindowState).toHaveBeenCalledWith(expect.objectContaining({
    query: "Premium",
    selector: { role: "button" },
    capture: "window_snapshot",
    effort: { maxElements: 6_000, maxDepth: 40 },
  }));
  const attachment = host.takeAttachment("observe-1");
  expect(attachment).not.toBeNull();
  expect(() => encodePngAttachmentFrame(attachment!.metadata, attachment!.bytes)).not.toThrow();
  expect(host.takeAttachment("observe-1")).toBeNull();

  const precision = await host.dispatch(request(COMPUTER_USE_NATIVE_CONTRACTS.observe, "observe-region-1", {
    operation: "window_region",
    target: snapshotTarget,
    coordinateSpace: "window_snapshot_pixels",
    region: { x: 0, y: 0, width: 1, height: 1 },
  }));
  expect(precision).toMatchObject({ settlement: "completed", result: { operation: "window_region" }, attachment: { width: 1, height: 1, coordinateSpace: "presented_snapshot_pixels" } });
  expect(adapter.observeWindowRegion).toHaveBeenCalledTimes(1);

  const acted = await host.dispatch(request(COMPUTER_USE_NATIVE_CONTRACTS.do, "do-1", {
    operation: { kind: "launch_app", app: { name: "Spotify" } },
  }));
  expect(acted).toMatchObject({ settlement: "completed", result: { action: "launch_app", completionCertainty: "completed" } });
  expect(adapter.launchApp).toHaveBeenCalledTimes(1);

  const verified = await host.dispatch(request(COMPUTER_USE_NATIVE_CONTRACTS.verify, "verify-1", {
    target: windowTarget,
    expect: [{ window: { exists: true } }],
  }));
  expect(verified).toMatchObject({ settlement: "completed", result: { status: "satisfied", stable: true } });
  expect(adapter.verify).toHaveBeenCalledTimes(1);
});

test("native Host accepts general role selection through admission and returns its checked result", async () => {
  const base = fakeAdapter();
  const fixture = await base.observeWindowState();
  const adapter = {
    ...base,
    observeWindowState: mock(async () => ({ ...fixture, observation: {
      ...fixture.observation,
      element: {
        selector: { role: "outline", action: "click", interaction: "double_click" },
        disposition: "unique", target: elementTarget,
        evidence: { kind: "element", role: "outline", action: "double_click", enabled: true },
      },
      semanticQuery: { ...fixture.observation.semanticQuery, matches: [{ role: "outline", label: "Files", labelTruncated: false, valueTruncated: false }] },
    } })),
  };
  const native = new CuaNativeContractRuntime({ adapter: adapter as never, scopeForAuthority: () => nativeScope() });
  const host = new ComputerUseHost({ hostGeneration: "host-1", driverGeneration: "driver-1", handlers: native.handlers });
  const selector = { role: "outline", action: "click", interaction: "double_click", labelEquals: "Files" };
  const observed = await host.dispatch(request(COMPUTER_USE_NATIVE_CONTRACTS.observe, "observe-general-role", {
    operation: "window_state", target: windowTarget, query: "Files", selector,
  }));
  expect(adapter.observeWindowState).toHaveBeenCalledWith(expect.objectContaining({ selector }));
  expect(observed).toMatchObject({ settlement: "completed", result: {
    element: { selector: { role: "outline", action: "click", interaction: "double_click" }, target: elementTarget },
    semanticQuery: { matches: [{ role: "outline", label: "Files" }] },
  } });
  expect(NATIVE_CONTRACT_SCHEMAS.observe.result.safeParse(observed.result).success).toBe(true);
});

test("native Host admits explicit editing and scrolling on general observed roles", async () => {
  for (const [role, action] of [["text_field", "type_text"], ["popup_button", "set_value"], ["outline", "scroll"]] as const) {
    const base = fakeAdapter();
    const fixture = await base.observeWindowState();
    const adapter = { ...base, observeWindowState: mock(async () => ({ ...fixture, observation: {
      ...fixture.observation,
      element: { selector: { role, action }, disposition: "unique", target: elementTarget,
        evidence: { kind: "element", role, action, enabled: true } },
    } })) };
    const native = new CuaNativeContractRuntime({ adapter: adapter as never, scopeForAuthority: () => nativeScope() });
    const host = new ComputerUseHost({ hostGeneration: "host-1", driverGeneration: "driver-1", handlers: native.handlers });
    const selector = { role, action, labelEquals: "Chosen" };
    const observed = await host.dispatch(request(COMPUTER_USE_NATIVE_CONTRACTS.observe, `observe-${action}`, {
      operation: "window_state", target: windowTarget, selector,
    }));
    expect(adapter.observeWindowState).toHaveBeenCalledWith(expect.objectContaining({ selector }));
    expect(observed).toMatchObject({ settlement: "completed", result: { element: { selector: { role, action }, target: elementTarget } } });
    expect(NATIVE_CONTRACT_SCHEMAS.observe.result.safeParse(observed.result).success).toBe(true);
  }
});

test("native Host failure results remain valid signed catalogue results", async () => {
  const staleOutcome = {
    ...outcome,
    retrySafety: "observe_before_retry" as const,
    targetCondition: "stale" as const,
    recovery: ["observe_again" as const],
  };
  const adapter = {
    ...fakeAdapter(),
    observeApplicationWindows: mock(async () => ({ ok: false as const, outcome: staleOutcome })),
    verify: mock(async () => ({ ok: false as const, outcome: staleOutcome })),
  };
  const native = new CuaNativeContractRuntime({ adapter: adapter as never, scopeForAuthority: () => nativeScope() });
  const host = new ComputerUseHost({ hostGeneration: "host-1", driverGeneration: "driver-1", handlers: native.handlers });

  const observed = await host.dispatch(request(COMPUTER_USE_NATIVE_CONTRACTS.observe, "observe-stale", {
    operation: "application_windows",
    target: appTarget,
    query: "Calculator",
  }));
  expect(observed).toMatchObject({
    settlement: "not_completed",
    result: { version: 1, operation: "application_windows", outcome: { targetCondition: "stale" } },
  });
  expect(NATIVE_CONTRACT_SCHEMAS.observe.result.safeParse(observed.result).success).toBe(true);

  const verified = await host.dispatch(request(COMPUTER_USE_NATIVE_CONTRACTS.verify, "verify-stale", {
    target: windowTarget,
    expect: [{ window: { exists: true } }],
  }));
  expect(verified).toMatchObject({
    settlement: "not_completed",
    result: { version: 1, operation: "verify", outcome: { targetCondition: "stale" } },
  });
  expect(NATIVE_CONTRACT_SCHEMAS.verify.result.safeParse(verified.result).success).toBe(true);
});

test("native Host preserves exact off-Space focus recovery through final result validation", async () => {
  const offSpaceOutcome = {
    ...outcome,
    retrySafety: "never" as const,
    recovery: ["focus_target" as const],
  };
  const adapter = {
    ...fakeAdapter(),
    observeWindowState: mock(async () => ({
      ok: true as const,
      observation: {
        version: 1 as const,
        operation: "window_state" as const,
        target: windowTarget,
        evidence: { kind: "window" as const, appLabel: "Cua Lab Fixture", windowLabel: "Cua Lab Document 1", bounds: { x: 396, y: 99, width: 720, height: 652 } },
        completeness: "partial" as const,
        degraded: true,
        verification: "indeterminate" as const,
        outcome: offSpaceOutcome,
      },
    })),
  };
  const native = new CuaNativeContractRuntime({ adapter: adapter as never, scopeForAuthority: () => nativeScope() });
  const host = new ComputerUseHost({ hostGeneration: "host-1", driverGeneration: "driver-1", handlers: native.handlers });

  const observed = await host.dispatch(request(COMPUTER_USE_NATIVE_CONTRACTS.observe, "observe-off-space", {
    operation: "window_state",
    target: windowTarget,
  }));

  expect(observed).toMatchObject({
    settlement: "completed",
    result: {
      operation: "window_state",
      completeness: "partial",
      degraded: true,
      outcome: { retrySafety: "never", recovery: ["focus_target"] },
    },
  });
  expect(NATIVE_CONTRACT_SCHEMAS.observe.result.safeParse(observed.result).success).toBe(true);
  expect(adapter.observeWindowState).toHaveBeenCalledTimes(1);
});

test("native Host rejects hostile public arguments before any Cua method runs", async () => {
  const adapter = fakeAdapter();
  const native = new CuaNativeContractRuntime({ adapter: adapter as never, scopeForAuthority: () => nativeScope() });
  const host = new ComputerUseHost({ hostGeneration: "host-1", driverGeneration: "driver-1", handlers: native.handlers });
  const result = await host.dispatch(request(COMPUTER_USE_NATIVE_CONTRACTS.do, "hostile-1", {
    operation: { kind: "launch_app", app: { name: "Spotify", bundle_id: "com.spotify.client" } },
  }));
  expect(result).toMatchObject({ settlement: "failed", result: { reason: "host_failure" } });
  expect(adapter.launchApp).not.toHaveBeenCalled();
  const invalidObserve = await host.dispatch(request(COMPUTER_USE_NATIVE_CONTRACTS.observe, "hostile-observe-invalid", {
    operation: "window_state", target: windowTarget, capture: "window_snapshot", query: " fixture",
  }));
  expect(invalidObserve).toMatchObject({ settlement: "failed", result: { reason: "host_failure" } });
  expect(adapter.observeWindowState).not.toHaveBeenCalled();
  for (const menuPath of [
    Array.from({ length: 17 }, () => "New"),
    ["N".repeat(201)],
  ]) {
    const rejected = await host.dispatch(request(COMPUTER_USE_NATIVE_CONTRACTS.do, `hostile-menu-${menuPath.length}-${menuPath[0]!.length}`, {
      operation: { kind: "create_window", target: appTarget, menuPath },
    }));
    expect(rejected).toMatchObject({ settlement: "failed", result: { reason: "host_failure" } });
  }
  expect(adapter.createWindow).not.toHaveBeenCalled();

  for (const [index, operation] of [
    { kind: "scroll", target: elementTarget, direction: "up", amount: 0, by: "line" },
    { kind: "scroll", target: elementTarget, direction: "down", amount: 51, by: "page" },
    { kind: "scroll", target: elementTarget, direction: "left", amount: 1.5, by: "line" },
    { kind: "scroll", target: elementTarget, direction: "diagonal", amount: 1, by: "line" },
    { kind: "scroll", target: elementTarget, direction: "right", amount: 1, by: "pixel" },
    { kind: "scroll", target: snapshotTarget, coordinateSpace: "window_snapshot_pixels", x: -1, y: 0, direction: "right", amount: 1, by: "line" },
    { kind: "scroll", target: snapshotTarget, coordinateSpace: "desktop_pixels", x: 0, y: 0, direction: "right", amount: 1, by: "line" },
  ].entries()) {
    const rejected = await host.dispatch(request(COMPUTER_USE_NATIVE_CONTRACTS.do, `hostile-scroll-${index}`, { operation }));
    expect(rejected).toMatchObject({ settlement: "failed", result: { reason: "host_failure" } });
  }
  expect(adapter.scroll).not.toHaveBeenCalled();
});

test("native do routes every public action exactly once, including the complete portable scroll contract", async () => {
  const cases = [
    ["launchApp", { kind: "launch_app", app: { name: "Spotify" } }],
    ["focus", { kind: "focus", target: windowTarget }],
    ["click", { kind: "click", target: snapshotTarget, coordinateSpace: "window_snapshot_pixels", x: 0, y: 0 }],
    ...["press", "show_menu", "pick", "confirm", "cancel", "open"].map((axAction) =>
      ["click", { kind: "click", target: elementTarget, axAction }] as const),
    ["click", { kind: "click", target: snapshotTarget, coordinateSpace: "window_snapshot_pixels", x: 0, y: 0, button: "middle", count: 3, modifiers: ["cmd", "shift"], deliveryMode: "foreground" }],
    ["click", { kind: "click", target: snapshotTarget, coordinateSpace: "presented_snapshot_pixels", x: 0, y: 0, button: "right", count: 2, deliveryMode: "foreground" }],
    ["click", { kind: "click", target: elementTarget, button: "right", modifiers: ["shift"], deliveryMode: "foreground" }],
    ["dragDrop", { kind: "drag_drop", target: snapshotTarget, coordinateSpace: "window_snapshot_pixels", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }],
    ["movePointer", { kind: "move_pointer", scope: "desktop", target: snapshotTarget, coordinateSpace: "presented_snapshot_pixels", x: 12, y: 24 }],
    ["dragDrop", { kind: "drag_drop", target: snapshotTarget, coordinateSpace: "presented_snapshot_pixels", from: { x: 0, y: 0 }, to: { x: 100, y: 200 }, durationMs: 1000, steps: 40, button: "middle", modifiers: ["option"], deliveryMode: "foreground" }],
    ["typeText", { kind: "type_text", target: windowTarget, text: "one exact write" }],
    ["typeText", { kind: "type_text", scope: "desktop", target: snapshotTarget, text: "focused input", delayMs: 0 }],
    ["typeText", { kind: "type_text", target: elementTarget, text: "paced input", delayMs: 200 }],
    ["typeText", { kind: "type_text", target: elementTarget, text: "existing edit", deliveryMode: "foreground" }],
    ["typeText", { kind: "type_text", target: snapshotTarget, coordinateSpace: "window_snapshot_pixels", x: 0, y: 0, text: "one exact pixel write" }],
    ["setValue", { kind: "set_value", target: elementTarget, value: "one exact value" }],
    ["scroll", { kind: "scroll", target: elementTarget, direction: "up", amount: 1, by: "line" }],
    ["scroll", { kind: "scroll", target: elementTarget, direction: "up", amount: 50, by: "page", deliveryMode: "foreground" }],
    ["scroll", { kind: "scroll", target: snapshotTarget, coordinateSpace: "presented_snapshot_pixels", x: 2, y: 3, direction: "left", amount: 2, by: "line", deliveryMode: "foreground" }],
    ["scroll", { kind: "scroll", target: elementTarget, direction: "down", amount: 50, by: "page" }],
    ["scroll", { kind: "scroll", target: elementTarget, direction: "left", amount: 2, by: "line" }],
    ["scroll", { kind: "scroll", target: elementTarget, direction: "right", amount: 3, by: "page" }],
    ["scroll", { kind: "scroll", target: snapshotTarget, coordinateSpace: "window_snapshot_pixels", x: 0, y: 0, direction: "right", amount: 2, by: "line" }],
    ["pressKey", { kind: "press_key", target: windowTarget, key: "return" }],
    ["hotkey", { kind: "hotkey", target: windowTarget, keys: ["command", "shift", "s"] }],
    ["hotkey", { kind: "hotkey", target: elementTarget, keys: ["cmd", "a"], deliveryMode: "foreground" }],
    ["hotkey", { kind: "hotkey", target: snapshotTarget, coordinateSpace: "window_snapshot_pixels", x: 12, y: 24, keys: ["cmd", "v"] }],
    ["hotkey", { kind: "hotkey", scope: "desktop", target: snapshotTarget, keys: ["ctrl", "left"] }],
    ["pressKey", { kind: "press_key", scope: "desktop", target: snapshotTarget, key: "tab", modifiers: ["command"] }],
    ["pressKey", { kind: "press_key", target: elementTarget, key: "+", modifiers: ["command"], deliveryMode: "foreground" }],
    ["pressKey", { kind: "press_key", target: snapshotTarget, coordinateSpace: "window_snapshot_pixels", x: 0, y: 0, key: "return" }],
    ["invokeMenu", { kind: "invoke_menu", target: windowTarget, menuPath: ["View", "as List"] }],
    ["setWindowFrame", { kind: "set_window_frame", target: windowTarget, frame: { x: -100, y: 20, width: 900, height: 700 } }],
    ["createWindow", { kind: "create_window", target: appTarget, menuPath: ["File", "New"] }],
  ] as const;

  for (const [method, operation] of cases) {
    const refusal = mock(async () => { throw new Error("provider fixture stops after routing"); });
    const adapter = {
      observe: mock(async () => { throw new Error("unexpected"); }),
      observeWindowState: mock(async () => { throw new Error("unexpected"); }),
      observeWindowRegion: mock(async () => { throw new Error("unexpected"); }),
      observeApplicationWindows: mock(async () => { throw new Error("unexpected"); }),
      launchApp: mock(async () => { throw new Error("unexpected"); }),
      focus: mock(async () => { throw new Error("unexpected"); }),
      click: mock(async () => { throw new Error("unexpected"); }),
      dragDrop: mock(async () => { throw new Error("unexpected"); }),
      movePointer: mock(async () => { throw new Error("unexpected"); }),
      invokeMenu: mock(async () => { throw new Error("unexpected"); }),
      typeText: mock(async () => { throw new Error("unexpected"); }),
      setValue: mock(async () => { throw new Error("unexpected"); }),
      setWindowFrame: mock(async () => { throw new Error("unexpected"); }),
      scroll: mock(async () => { throw new Error("unexpected"); }),
      pressKey: mock(async () => { throw new Error("unexpected"); }),
      hotkey: mock(async () => { throw new Error("unexpected"); }),
      createWindow: mock(async () => { throw new Error("unexpected"); }),
      verify: mock(async () => { throw new Error("unexpected"); }),
      [method]: refusal,
    };
    const native = new CuaNativeContractRuntime({ adapter: adapter as never, scopeForAuthority: () => nativeScope() });
    const host = new ComputerUseHost({ hostGeneration: "host-1", driverGeneration: "driver-1", handlers: native.handlers });
    const result = await host.dispatch(request(COMPUTER_USE_NATIVE_CONTRACTS.do, `route-${method}-${String(operation.kind)}-${String("direction" in operation ? operation.direction : "one")}`, { operation }));
    expect(result).toMatchObject({ settlement: "failed", result: { reason: "host_failure" } });
    expect(refusal).toHaveBeenCalledTimes(1);
    expect(refusal).toHaveBeenCalledWith(expect.objectContaining({ operation: expect.objectContaining(operation) }));
  }
});
