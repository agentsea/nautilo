import { describe, expect, test } from "bun:test";

import type { ComputerUseHostAuthorityScope, ComputerUseJson } from "@nautilo/computer-use-host-protocol";

import {
  ComputerUseContextRegistry,
  CuaBrowserRuntime,
  createNativeComputerUseScopeFactory,
  createNativeRegistryWindowResolver,
  type CuaToolClient,
  type CuaToolResult,
} from "../../src/index.ts";
import type { ComputerUseContractHandler } from "../../src/runtime.ts";

const authority: ComputerUseHostAuthorityScope = {
  authorityLeaseId: "lease-native-browser-bridge",
  authorityGeneration: 7,
};

function deterministicRandom(): (size: number) => Uint8Array {
  let next = 1;
  return (size) => {
    const bytes = new Uint8Array(size);
    bytes.fill(next++);
    return bytes;
  };
}

class FakeCua implements CuaToolClient {
  readonly calls: Array<Readonly<{ name: string; argumentsValue: Readonly<Record<string, unknown>> }>> = [];
  readonly #responses: CuaToolResult[];

  constructor(responses: CuaToolResult[]) {
    this.#responses = [...responses];
  }

  async callTool(name: string, argumentsValue: Readonly<Record<string, unknown>>): Promise<CuaToolResult> {
    this.calls.push({ name, argumentsValue });
    const response = this.#responses.shift();
    if (response === undefined) throw new Error(`unexpected Cua call: ${name}`);
    return response;
  }
}

function ok(structuredContent: Readonly<Record<string, unknown>>): CuaToolResult {
  return { isError: false, structuredContent };
}

function binding(): CuaToolResult {
  return ok({
    status: "ok",
    mode: "bind",
    target_id: "private-cua-browser-target",
    binding_quality: "exact",
    binding_route: "native_cdp_window",
    endpoint_transport: "dev_tools_active_port",
    endpoint_access_class: "driver_owned",
    mutation_allowed: true,
    native_title: "Bridge fixture",
    tabs: [{ tab_id: "private-cua-tab", title: "Bridge", url: "https://example.test/", active: true }],
  });
}

function contract(runtime: CuaBrowserRuntime, contractId: string): ComputerUseContractHandler {
  const found = runtime.handlers.find((candidate) => candidate.contract.contractId === contractId);
  if (found === undefined) throw new Error(`missing contract ${contractId}`);
  return found;
}

describe("native observation to browser target bridge", () => {
  test("binds the exact opaque native window under the same authority without publishing its provider handle", async () => {
    const registry = new ComputerUseContextRegistry();
    const scopeForAuthority = createNativeComputerUseScopeFactory({
      hostGeneration: "host-generation",
      driverGeneration: "driver-generation",
    });
    const scope = scopeForAuthority(authority);
    const reservation = registry.reserveContext(scope);
    if (!reservation.ok) throw new Error("expected native observation reservation");
    const observed = registry.createReservedDesktopState(
      reservation.data.reservation,
      scope,
      [{
        evidence: { kind: "window", appLabel: "Browser", windowLabel: "Bridge fixture" },
        providerTarget: {
          provider: "cua",
          operation: "focus",
          pid: 4242,
          windowId: 777,
          bundleId: "com.example.browser",
        },
      }],
      null,
    );
    if (!observed.ok) throw new Error("expected native observation");
    const nativeWindow = {
      version: 1 as const,
      context: observed.data.context,
      reference: observed.data.targets[0]!.reference,
    };

    const client = new FakeCua([ok({ status: "ok" }), binding()]);
    const runtime = new CuaBrowserRuntime({
      client,
      randomBytes: deterministicRandom(),
      resolveNativeWindow: createNativeRegistryWindowResolver(registry, scopeForAuthority),
    });
    const bind = contract(runtime, "browser.bind_window");
    const result = await bind.execute({ window: nativeWindow }, {
      authority,
      contract: bind.contract,
      signal: new AbortController().signal,
    });

    expect(result.settlement).toBe("completed");
    expect(client.calls.map((call) => call.name)).toEqual(["start_session", "get_browser_state"]);
    expect(client.calls[1]!.argumentsValue).toMatchObject({ pid: 4242, window_id: 777 });
    const publicBytes = JSON.stringify(result.result);
    for (const privateValue of ["4242", "777", "com.example.browser", "private-cua-browser-target", "private-cua-tab", "native_cdp_window"]) {
      expect(publicBytes).not.toContain(privateValue);
    }
  });

  test("rejects the same opaque window under another authority lease or generation before Cua", async () => {
    const registry = new ComputerUseContextRegistry();
    const scopeForAuthority = createNativeComputerUseScopeFactory({
      hostGeneration: "host-generation",
      driverGeneration: "driver-generation",
    });
    const scope = scopeForAuthority(authority);
    const reservation = registry.reserveContext(scope);
    if (!reservation.ok) throw new Error("expected native observation reservation");
    const observed = registry.createReservedDesktopState(reservation.data.reservation, scope, [{
      evidence: { kind: "window", appLabel: "Browser", windowLabel: "Bridge fixture" },
      providerTarget: { provider: "cua", operation: "focus", pid: 4242, windowId: 777 },
    }], null);
    if (!observed.ok) throw new Error("expected native observation");
    const window = {
      version: 1 as const,
      context: observed.data.context,
      reference: observed.data.targets[0]!.reference,
    } satisfies Readonly<Record<string, ComputerUseJson>>;
    const client = new FakeCua([]);
    const runtime = new CuaBrowserRuntime({
      client,
      resolveNativeWindow: createNativeRegistryWindowResolver(registry, scopeForAuthority),
    });
    const bind = contract(runtime, "browser.bind_window");

    for (const deniedAuthority of [
      { authorityLeaseId: "another-lease", authorityGeneration: authority.authorityGeneration },
      { authorityLeaseId: authority.authorityLeaseId, authorityGeneration: authority.authorityGeneration + 1 },
    ]) {
      const result = await bind.execute({ window }, {
        authority: deniedAuthority,
        contract: bind.contract,
        signal: new AbortController().signal,
      });
      expect(result).toMatchObject({
        settlement: "not_completed",
        result: { status: "recovery_required", recovery: "observe_again" },
      });
    }
    registry.fence({
      installationEpoch: scope.installationEpoch,
      grantGeneration: scope.grantGeneration,
    });
    expect(await bind.execute({ window }, {
      authority,
      contract: bind.contract,
      signal: new AbortController().signal,
    })).toMatchObject({
      settlement: "not_completed",
      result: { status: "recovery_required", recovery: "observe_again" },
    });
    expect(client.calls).toEqual([]);
  });
});
