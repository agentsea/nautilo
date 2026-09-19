import { afterEach, expect, mock, test } from "bun:test";
import { COMPUTER_USE_NATIVE_CONTRACTS, NATIVE_CONTRACT_SCHEMAS } from "@nautilo/computer-use-contracts/native";

import { CuaNativeContractRuntime } from "../../src/native-contract-runtime.ts";
import type { CuaCheckedContextPort } from "../../src/native-cua-lifecycle.ts";
import type { CuaContextToolCallResult, CuaContextToolName, CuaContextToolResult } from "../../src/native-cua-supervisor.ts";
import { CuaComputerUseAdapter } from "../../src/native-runtime.ts";
import { ComputerUseHost } from "../../src/runtime.ts";

const authority = { authorityLeaseId: "lease-1", authorityGeneration: 1 } as const;
const fence = { hostGeneration: "host-1", driverGeneration: "driver-1", cancellationGeneration: 1 } as const;
const scope = {
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
const adapters: CuaComputerUseAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
});

function result(structuredContent: Readonly<Record<string, unknown>>, isError = false): CuaContextToolResult {
  return { content: [{ type: "text", text: "fixture" }], isError, structuredContent };
}

function apps() {
  return result({ apps: [{
    pid: 42, name: "Fixture", bundle_id: "com.nautilo.fixture", active: true, running: true,
    launch_path: null, kind: "application", last_used: null, windows: [],
  }] });
}

function windows() {
  return result({ windows: [{
    window_id: 90, pid: 42, app_name: "Fixture", title: "Private fixture window",
    bounds: { x: 1, y: 2, width: 800, height: 600 }, layer: 0, z_index: 0,
    is_on_screen: true, current_space_id: 1, on_current_space: true, space_ids: [1],
  }], current_space_id: 1 });
}

function windowState(element: Readonly<Record<string, unknown>>) {
  return result({
    window_id: 90, pid: 42, element_count: 1, total_element_count: 1, returned_element_count: 1,
    elements_complete: false, tree_markdown: "private raw accessibility tree", _note: "private provider diagnostic",
    elements: [element],
  });
}

function effect() {
  return result({ effect: "unverifiable", route: "accessibility", delivery: { mode: "background" } });
}

function checkedPort(responses: readonly CuaContextToolResult[]) {
  let index = 0;
  const calls: Array<Readonly<{ name: CuaContextToolName; args: Readonly<Record<string, unknown>> }>> = [];
  const next = (name: CuaContextToolName, args: Readonly<Record<string, unknown>>): CuaContextToolCallResult => {
    calls.push({ name, args });
    const response = responses[index++];
    if (response === undefined) throw new Error(`unexpected Cua call: ${name}`);
    return { ok: true, generation: "cua_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", sessionId: "cua-session-1", result: response };
  };
  const callContextTool = mock(async (
    _scope: typeof scope,
    name: CuaContextToolName,
    args: Readonly<Record<string, unknown>>,
    _signal?: AbortSignal,
    onProviderDispatch?: () => boolean | Promise<boolean>,
  ) => {
    if (onProviderDispatch !== undefined && !await onProviderDispatch()) {
      return { ok: false as const, code: "context_fenced" as const, stage: "tool" as const };
    }
    return next(name, args);
  });
  const getWindowState = mock(async (
    _scope: typeof scope,
    pid: number,
    windowId: number,
    _query?: string,
    _signal?: AbortSignal,
    effort?: Readonly<{ maxElements?: number; maxDepth?: number }>,
  ) => next("get_window_state", {
    pid, window_id: windowId, include_screenshot: false,
    ...(effort?.maxElements === undefined ? {} : { max_elements: effort.maxElements }),
    ...(effort?.maxDepth === undefined ? {} : { max_depth: effort.maxDepth }),
  }));
  const invalidateCheckedGeneration = mock(() => undefined);
  const value = {
    generation: "cua_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    callContextTool,
    getWindowState,
    invalidateCheckedGeneration,
    captureDesktopState: mock(async () => ({
      ok: true as const,
      generation: "cua_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sessionId: "cua-session-1",
      png: Uint8Array.from([137, 80, 78, 71]),
      nativeWidth: 1200,
      nativeHeight: 800,
      screenWidth: 600,
      screenHeight: 400,
      scaleFactor: 2,
    })),
    endContextLease: mock(async () => undefined),
  } as unknown as CuaCheckedContextPort;
  return { calls, invalidateCheckedGeneration, value };
}

function request(
  contract: typeof COMPUTER_USE_NATIVE_CONTRACTS[keyof typeof COMPUTER_USE_NATIVE_CONTRACTS],
  requestId: string,
  argumentsValue: object,
) {
  return { kind: "request" as const, protocol: { major: 3 as const, minor: 0 as const }, requestId, authority, fence, contract, arguments: argumentsValue };
}

function hostFor(responses: readonly CuaContextToolResult[]) {
  const checked = checkedPort(responses);
  const adapter = new CuaComputerUseAdapter({
    port: checked.value,
    readHidIdleNanoseconds: async () => 1_000_000_000,
    monotonicMilliseconds: () => 10_000,
  });
  adapters.push(adapter);
  const native = new CuaNativeContractRuntime({ adapter, scopeForAuthority: () => scope });
  return { checked, host: new ComputerUseHost({ hostGeneration: "host-1", driverGeneration: "driver-1", handlers: native.handlers }) };
}

async function observedWindow(host: ComputerUseHost, requestId: string) {
  const window = await desktopTarget(host, `${requestId}-desktop`);
  return host.dispatch(request(COMPUTER_USE_NATIVE_CONTRACTS.observe, requestId, {
    operation: "window_state", target: window, selector: { role: "slider" },
  }));
}

async function desktopTarget(host: ComputerUseHost, requestId: string) {
  const desktop = await host.dispatch(request(COMPUTER_USE_NATIVE_CONTRACTS.observe, requestId, { operation: "desktop_state" }));
  return (desktop.result as { targets: Array<{ target: object }> }).targets[0]!.target;
}

test("publishes exact slider state only on the unique selected element through adapter, runtime, and Host", async () => {
  const privateDescription = "exact value description ".repeat(48);
  const { host } = hostFor([apps(), windows(), windowState({
    role: "AXSlider", label: "Private volume", element_token: "private-slider-token", enabled: true,
    value: "0", value_description: privateDescription, selected: false, min: 0, max: 100,
  })]);

  const observed = await observedWindow(host, "slider-state");
  expect(COMPUTER_USE_NATIVE_CONTRACTS.observe.contractVersion).toBe(10);
  expect(observed).toMatchObject({ settlement: "completed", result: {
    operation: "window_state",
    element: { disposition: "unique", state: {
      completeness: "partial", value: "0", valueDescription: privateDescription, selected: false, range: { minimum: 0, maximum: 100 },
    } },
  } });
  expect(NATIVE_CONTRACT_SCHEMAS.observe.result.safeParse(observed.result).success).toBe(true);
  expect(observed.result).not.toHaveProperty("element.evidence.state");
  expect(JSON.stringify(observed.result)).not.toMatch(/private-slider-token|Private volume|private raw accessibility tree|private provider diagnostic/);
  for (const disposition of ["zero", "ambiguous", "incomplete"] as const) {
    expect(NATIVE_CONTRACT_SCHEMAS.observe.result.safeParse({
      ...(observed.result as object),
      element: { selector: { role: "slider" }, disposition, state: { completeness: "partial" } },
    }).success).toBe(false);
  }
});

test("keeps absent and malformed optional state non-fatal, without numeric coercion", async () => {
  const absent = hostFor([apps(), windows(), windowState({
    role: "AXSlider", label: "Private absent", element_token: "private-absent-token", enabled: true,
    value: null,
  })]);
  const absentObserved = await observedWindow(absent.host, "absent-state");
  expect(absentObserved).toMatchObject({ settlement: "completed", result: {
    element: { disposition: "unique", state: { completeness: "partial" } },
  } });

  const malformed = hostFor([apps(), windows(), windowState({
    role: "AXSlider", label: "Private malformed", element_token: "private-malformed-token", enabled: true,
    value: "0", value_description: false, min: "0", max: 100,
  })]);
  const malformedObserved = await observedWindow(malformed.host, "malformed-state");
  expect(malformedObserved).toMatchObject({ settlement: "completed", result: {
    element: { disposition: "unique", state: { completeness: "partial", value: "0" } },
  } });
  expect(NATIVE_CONTRACT_SCHEMAS.observe.result.safeParse(malformedObserved.result).success).toBe(true);
  expect(JSON.stringify(malformedObserved.result)).not.toMatch(/private-malformed-token|Private malformed|private raw accessibility tree/);

  const nonIncreasing = hostFor([apps(), windows(), windowState({
    role: "AXSlider", label: "Private range", element_token: "private-range-token", enabled: true,
    min: 10, max: 10,
  })]);
  const nonIncreasingObserved = await observedWindow(nonIncreasing.host, "non-increasing-range");
  expect(nonIncreasingObserved).toMatchObject({ settlement: "completed", result: {
    element: { disposition: "unique", state: { completeness: "partial" } },
  } });
});

test("does not guess a boolean from a provider string and leaves the provider session usable", async () => {
  const { checked, host } = hostFor([
    apps(), windows(),
    windowState({ role: "AXSlider", label: "Private boolean", element_token: "private-boolean-token", enabled: true, selected: "false" }),
    windowState({ role: "AXSlider", label: "Private fresh boolean", element_token: "private-fresh-boolean-token", enabled: true, selected: false }),
  ]);
  const target = await desktopTarget(host, "guessed-boolean-desktop");
  const observed = await host.dispatch(request(COMPUTER_USE_NATIVE_CONTRACTS.observe, "guessed-boolean", {
    operation: "window_state", target, selector: { role: "slider" },
  }));
  expect(observed).toMatchObject({ settlement: "completed", result: {
    element: { disposition: "incomplete" },
  } });
  expect(observed.result).not.toHaveProperty("element.state");
  expect(NATIVE_CONTRACT_SCHEMAS.observe.result.safeParse(observed.result).success).toBe(true);
  expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
  const fresh = await host.dispatch(request(COMPUTER_USE_NATIVE_CONTRACTS.observe, "fresh-boolean", {
    operation: "window_state", target, selector: { role: "slider" },
  }));
  expect(fresh).toMatchObject({ settlement: "completed", result: {
    element: { disposition: "unique", state: { completeness: "partial", selected: false } },
  } });
  expect(checked.invalidateCheckedGeneration).not.toHaveBeenCalled();
});

test("a set_value receipt never republishes state, while the next explicit read returns fresh state", async () => {
  const { checked, host } = hostFor([
    apps(), windows(),
    windowState({ role: "AXSlider", label: "Private mutation", element_token: "private-before-token", enabled: true, value: "0", value_description: "private before description", selected: false, min: 0, max: 100 }),
    apps(), windows(), effect(),
    windowState({ role: "AXSlider", label: "Private mutation", element_token: "private-post-effect-token", enabled: true, value: "42", value_description: "private post-effect description", selected: false, min: 0, max: 100 }),
    windowState({ role: "AXSlider", label: "Private mutation", element_token: "private-fresh-token", enabled: true, value: "42", value_description: "private fresh description", selected: false, min: 0, max: 100 }),
  ]);
  const initial = await observedWindow(host, "state-before-set");
  const target = (initial.result as { element: { target: object } }).element.target;
  const acted = await host.dispatch(request(COMPUTER_USE_NATIVE_CONTRACTS.do, "set-slider", {
    operation: { kind: "set_value", target, value: "42" },
  }));
  expect(acted).toMatchObject({ settlement: "completed", result: { action: "set_value" } });
  expect(acted.result).not.toHaveProperty("state");
  expect(acted.result).not.toHaveProperty("resolvedTarget.state");
  expect(acted.result).not.toHaveProperty("value");
  expect(acted.result).not.toHaveProperty("valueDescription");
  expect(JSON.stringify(acted.result)).not.toMatch(/private-before-token|private-post-effect-token|Private mutation|private raw accessibility tree|private before description|private post-effect description|"42"/);

  const refreshed = await host.dispatch(request(COMPUTER_USE_NATIVE_CONTRACTS.observe, "state-after-set", {
    operation: "window_state", target: (initial.result as { target: object }).target, selector: { role: "slider" },
  }));
  expect(refreshed).toMatchObject({ settlement: "completed", result: {
    element: { disposition: "unique", state: { completeness: "partial", value: "42", valueDescription: "private fresh description", selected: false, range: { minimum: 0, maximum: 100 } } },
  } });
  const freshTarget = (refreshed.result as { element: { target: object } }).element.target;
  expect(freshTarget).not.toEqual(target);
  const stale = await host.dispatch(request(COMPUTER_USE_NATIVE_CONTRACTS.do, "stale-slider", {
    operation: { kind: "set_value", target, value: "99" },
  }));
  expect(stale).toMatchObject({ result: {
    action: "set_value", completionCertainty: "not_completed", resolvedTarget: { kind: "element", state: "unavailable" },
  } });
  expect(checked.calls.filter((call) => call.name === "get_window_state")).toHaveLength(3);
  expect(NATIVE_CONTRACT_SCHEMAS.observe.result.safeParse(refreshed.result).success).toBe(true);
});
