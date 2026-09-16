import { describe, expect, mock, test } from "bun:test";

import { COMPUTER_USE_NATIVE_CONTRACTS } from "@nautilo/computer-use-contracts/native";
import type { ComputerUseHostAuthorityScope } from "@nautilo/computer-use-host-protocol";

import { ComputerUseContextRegistry, type ComputerUseContextScope } from "../../src/native-context-registry.ts";
import { CuaBrowserRuntime, type CuaToolClient } from "../../src/browser-runtime.ts";
import { CuaNativeContractRuntime } from "../../src/native-contract-runtime.ts";
import type { CuaCheckedContextPort } from "../../src/native-cua-lifecycle.ts";
import type { CuaContextToolResult } from "../../src/native-cua-supervisor.ts";
import { CuaComputerUseAdapter } from "../../src/native-runtime.ts";
import { ComputerUseResourceCoordinator } from "../../src/resource-coordinator.ts";
import { ComputerUseHost } from "../../src/runtime.ts";

const hostGeneration = "host-coordination";
const driverGeneration = "driver-coordination";
const fence = { hostGeneration, driverGeneration, cancellationGeneration: 1 } as const;

function authority(id: string): ComputerUseHostAuthorityScope {
  return { authorityLeaseId: id, authorityGeneration: 1 };
}

function scope(id: string): ComputerUseContextScope {
  return {
    computerUseContextId: id, installationEpoch: hostGeneration, grantGeneration: 1,
    provider: "cua", providerGeneration: driverGeneration,
    originHumanId: id, originRunId: id, originAgentId: id, lineageId: id,
    serverBindingId: hostGeneration, relayId: hostGeneration,
    pairingGeneration: hostGeneration, desktopSessionId: hostGeneration,
  };
}

function toolResult(pid: number, windowId: number): CuaContextToolResult {
  return {
    content: [{ type: "text", text: "fixture" }], isError: false,
    structuredContent: {
      pid, window_id: windowId, element_count: 0, total_element_count: 0,
      returned_element_count: 0, elements_complete: false, tree_markdown: "",
      elements: [], _note: "fixture",
    },
  };
}

type WindowCall = Readonly<{
  pid: number;
  windowId: number;
  signal: AbortSignal | undefined;
  deferred: PromiseWithResolvers<CuaContextToolResult>;
}>;

function fixture() {
  const registry = new ComputerUseContextRegistry();
  const scopes = new Map<string, ComputerUseContextScope>();
  const calls: WindowCall[] = [];
  const getWindowState = mock((currentScope: ComputerUseContextScope, pid: number, windowId: number,
    _query?: string, signal?: AbortSignal) => {
    const deferred = Promise.withResolvers<CuaContextToolResult>();
    calls.push({ pid, windowId, signal, deferred });
    return deferred.promise.then((result) => ({
      ok: true as const, generation: driverGeneration, sessionId: `session-${currentScope.computerUseContextId}`, result,
    }));
  });
  const port = {
    generation: driverGeneration,
    getWindowState,
    callContextTool: mock(async () => ({ ok: false as const, code: "context_fenced" as const, stage: "session" as const })),
    launchApplication: mock(async () => ({ ok: false as const, code: "context_fenced" as const, stage: "session" as const })),
    captureWindowState: mock(async () => ({ ok: false as const, code: "context_fenced" as const })),
    captureDesktopState: mock(async () => ({ ok: false as const, code: "context_fenced" as const })),
    clickDesktop: mock(async () => ({ ok: false as const, code: "context_fenced" as const, stage: "session" as const })),
    endContextLease: mock(async () => undefined),
    awaitOutstandingOperations: mock(async () => undefined),
  } as unknown as CuaCheckedContextPort;
  const adapter = new CuaComputerUseAdapter({ port, registry });
  const coordinator = new ComputerUseResourceCoordinator();
  let requestSequence = 0;
  const runtime = new CuaNativeContractRuntime({
    adapter,
    registry,
    coordinator,
    drain: (currentScope, signal) => port.awaitOutstandingOperations(currentScope, signal),
    scopeForAuthority: (value) => {
      const found = scopes.get(value.authorityLeaseId);
      if (found === undefined) throw new Error("missing fixture scope");
      return found;
    },
  });
  const host = new ComputerUseHost({ hostGeneration, driverGeneration, handlers: runtime.handlers });
  const addWindow = (id: string, pid: number, windowId: number) => {
    const currentScope = scope(id);
    scopes.set(id, currentScope);
    const reservation = registry.reserveContext(currentScope);
    if (!reservation.ok) throw new Error("failed to reserve fixture context");
    const observed = registry.createReservedDesktopState(reservation.data.reservation, currentScope, [{
      evidence: { kind: "window", appLabel: "Fixture", windowLabel: `${pid}:${windowId}` },
      providerTarget: { provider: "cua", operation: "focus", pid, windowId },
    }], null);
    if (!observed.ok) throw new Error("failed to create fixture window");
    return { version: 1 as const, context: observed.data.context, reference: observed.data.targets[0]!.reference };
  };
  const dispatch = (id: string, target: ReturnType<typeof addWindow>) => {
    const requestId = `request-${id}-${++requestSequence}`;
    return { requestId, pending: host.dispatch({
      kind: "request", protocol: { major: 3, minor: 0 }, requestId,
      authority: authority(id), fence, contract: COMPUTER_USE_NATIVE_CONTRACTS.observe,
      arguments: { operation: "window_state", target },
    }) };
  };
  return { adapter, calls, coordinator, dispatch, addWindow, host, port, registry };
}

async function nextMicrotask(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("fixture condition did not become true");
}

describe("native Host resource coordination", () => {
  test("allows different physical windows to publish concurrently", async () => {
    const subject = fixture();
    const firstTarget = subject.addWindow("first", 42, 90);
    const secondTarget = subject.addWindow("second", 42, 91);
    const first = subject.dispatch("first", firstTarget).pending;
    const second = subject.dispatch("second", secondTarget).pending;
    await until(() => subject.calls.length === 2);
    expect(subject.calls.map(({ windowId }) => windowId)).toEqual([90, 91]);
    subject.calls[1]!.deferred.resolve(toolResult(42, 91));
    subject.calls[0]!.deferred.resolve(toolResult(42, 90));
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ settlement: "completed" }),
      expect.objectContaining({ settlement: "completed" }),
    ]);
  });

  test("serializes the same physical window across distinct opaque contexts through publication", async () => {
    const subject = fixture();
    const firstTarget = subject.addWindow("first", 42, 90);
    const secondTarget = subject.addWindow("second", 42, 90);
    const first = subject.dispatch("first", firstTarget).pending;
    const second = subject.dispatch("second", secondTarget).pending;
    await until(() => subject.calls.length === 1);
    expect(subject.calls).toHaveLength(1);
    subject.calls[0]!.deferred.resolve(toolResult(42, 90));
    await expect(first).resolves.toMatchObject({ settlement: "completed" });
    await until(() => subject.calls.length === 2);
    expect(subject.calls).toHaveLength(2);
    subject.calls[1]!.deferred.resolve(toolResult(42, 90));
    await expect(second).resolves.toMatchObject({ settlement: "completed" });
  });

  test("removes a cancelled queued window before provider dispatch", async () => {
    const subject = fixture();
    const firstTarget = subject.addWindow("first", 42, 90);
    const secondTarget = subject.addWindow("second", 42, 90);
    const first = subject.dispatch("first", firstTarget).pending;
    const secondRequest = subject.dispatch("second", secondTarget);
    await until(() => subject.calls.length === 1);
    expect(subject.calls).toHaveLength(1);
    await subject.host.dispatch({
      kind: "cancel", protocol: { major: 3, minor: 0 }, requestId: secondRequest.requestId,
      authority: authority("second"), fence,
    });
    await expect(secondRequest.pending).resolves.toMatchObject({ settlement: "cancelled" });
    subject.calls[0]!.deferred.resolve(toolResult(42, 90));
    await expect(first).resolves.toMatchObject({ settlement: "completed" });
    expect(subject.calls).toHaveLength(1);
  });

  test("holds the physical-window claim through deferred raw drain without blocking another window", async () => {
    const subject = fixture();
    const drains = new Map<AbortSignal, PromiseWithResolvers<void>>();
    let deferNextDrain = true;
    subject.port.awaitOutstandingOperations = mock((_scope, signal) => {
      if (signal === undefined || !deferNextDrain) return Promise.resolve();
      deferNextDrain = false;
      const deferred = Promise.withResolvers<void>();
      drains.set(signal, deferred);
      return deferred.promise;
    });
    const firstTarget = subject.addWindow("first", 42, 90);
    const secondTarget = subject.addWindow("second", 42, 90);
    const independentTarget = subject.addWindow("independent", 42, 91);
    const firstRequest = subject.dispatch("first", firstTarget);
    const first = firstRequest.pending;
    await until(() => subject.calls.length === 1);
    subject.calls[0]!.deferred.resolve(toolResult(42, 90));
    await until(() => drains.size === 1);
    const firstSignal = [...drains.keys()][0]!;
    const second = subject.dispatch("second", secondTarget).pending;
    const independent = subject.dispatch("independent", independentTarget).pending;
    await until(() => subject.calls.length === 2);
    expect(subject.calls.map(({ windowId }) => windowId)).toEqual([90, 91]);
    subject.calls[1]!.deferred.resolve(toolResult(42, 91));
    await expect(independent).resolves.toMatchObject({ settlement: "completed" });
    drains.get(firstSignal)!.resolve();
    await expect(first).resolves.toMatchObject({ settlement: "completed" });
    await until(() => subject.calls.length === 3);
    expect(subject.calls.map(({ windowId }) => windowId)).toEqual([90, 91, 90]);
    subject.calls[2]!.deferred.resolve(toolResult(42, 90));
    await expect(second).resolves.toMatchObject({ settlement: "completed" });
  });

  test("shares the workstation barrier with browser binding", async () => {
    const subject = fixture();
    const target = subject.addWindow("shared", 42, 90);
    const native = subject.dispatch("shared", target).pending;
    await until(() => subject.calls.length === 1);
    const browserCalls: string[] = [];
    const client: CuaToolClient = {
      callTool: mock(async (name) => {
        browserCalls.push(name);
        if (name === "start_session") return { isError: false, structuredContent: { session: "browser-session" } };
        return { isError: false, structuredContent: {
          status: "ok", mode: "bind", target_id: "private-target", binding_quality: "exact",
          binding_route: "native_cdp_window", endpoint_transport: "dev_tools_active_port",
          endpoint_access_class: "driver_owned", mutation_allowed: true, native_title: "Fixture",
          tabs: [{ tab_id: "private-tab", title: "Fixture", url: "https://example.test/", active: true }],
        } };
      }),
    };
    const browser = new CuaBrowserRuntime({
      client,
      coordinator: subject.coordinator,
      resolveNativeWindow: () => ({ pid: 42, windowId: 90 }),
    });
    const bind = browser.handlers.find(({ contract }) => contract.contractId === "browser.bind_window");
    if (bind === undefined) throw new Error("missing browser bind handler");
    const binding = bind.execute({ window: target }, {
      authority: authority("shared"), contract: bind.contract, signal: new AbortController().signal,
    });
    await nextMicrotask();
    expect(browserCalls).toEqual([]);
    subject.calls[0]!.deferred.resolve(toolResult(42, 90));
    await expect(native).resolves.toMatchObject({ settlement: "completed" });
    await expect(binding).resolves.toMatchObject({ settlement: "completed" });
    expect(browserCalls).toEqual(["start_session", "get_browser_state"]);
    await browser.close();
  });
});
