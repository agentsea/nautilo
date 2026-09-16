import { describe, expect, test } from "bun:test";

import type { ComputerUseJson } from "@nautilo/computer-use-host-protocol";
import { BROWSER_CONTRACT_SCHEMAS, COMPUTER_USE_BROWSER_CONTRACTS } from "@nautilo/computer-use-contracts";

import {
  CUA_BROWSER_PRIMITIVE_EFFECT,
  COMPUTER_USE_BROWSER_CONTRACT_PRIMITIVES,
  CuaBrowserRuntime,
  type CuaToolClient,
  type CuaToolResult,
} from "../../src/index.ts";
import type { ComputerUseContractHandler, ComputerUseContractHandlerResult } from "../../src/runtime.ts";

const nativeWindow = {
  version: 1,
  context: `dctx_${"n".repeat(43)}`,
  reference: `dtgt_${"w".repeat(43)}`,
} as const;

function deterministicRandom(): (size: number) => Uint8Array {
  let next = 1;
  return (size) => {
    const value = new Uint8Array(size);
    value.fill(next++);
    return value;
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

class CoordinatedBrowserCua implements CuaToolClient {
  readonly calls: Array<Readonly<{ name: string; argumentsValue: Readonly<Record<string, unknown>> }>> = [];
  readonly pending = new Map<string, Array<(value: CuaToolResult) => void>>();

  async callTool(name: string, argumentsValue: Readonly<Record<string, unknown>>): Promise<CuaToolResult> {
    this.calls.push({ name, argumentsValue });
    if (name === "start_session" || name === "end_session") return ok({ status: "ok" });
    if (name === "get_browser_state" && argumentsValue["pid"] !== undefined) {
      const value = binding();
      return { ...value, structuredContent: {
        ...value.structuredContent!,
        tabs: [
          { tab_id: "tab-a", title: "A", url: "https://a.example/", active: true },
          { tab_id: "tab-b", title: "B", url: "https://b.example/", active: false },
        ],
      } };
    }
    if (name === "get_browser_state") {
      const tab = String(argumentsValue["tab_id"]);
      return new Promise<CuaToolResult>((resolve) => {
        const waiting = this.pending.get(tab) ?? [];
        waiting.push(resolve);
        this.pending.set(tab, waiting);
      });
    }
    if (name === "browser_navigate") return ok({
      status: "ok", target_id: argumentsValue["target_id"], tab_id: argumentsValue["tab_id"],
      url: argumentsValue["url"], refs_invalidated: true,
    });
    throw new Error(`unexpected Cua call: ${name}`);
  }

  release(tab: string): void {
    const resolve = this.pending.get(tab)?.shift();
    if (resolve === undefined) throw new Error(`no pending read for ${tab}`);
    const value = snapshot();
    resolve({ ...value, structuredContent: {
      ...value.structuredContent!, tab_id: tab,
      page: { url: `https://${tab}.example/`, title: tab },
    } });
  }
}

class DeferredBindCua implements CuaToolClient {
  readonly calls: string[] = [];
  resolveBinding!: (value: CuaToolResult) => void;

  async callTool(name: string): Promise<CuaToolResult> {
    this.calls.push(name);
    if (name === "start_session" || name === "end_session") return ok({ status: "ok" });
    if (name === "get_browser_state") return new Promise((resolve) => { this.resolveBinding = resolve; });
    throw new Error(`unexpected Cua call: ${name}`);
  }
}

class DeferredPrepareCua implements CuaToolClient {
  readonly calls: string[] = [];
  resolvePrepared!: (value: CuaToolResult) => void;

  async callTool(name: string): Promise<CuaToolResult> {
    this.calls.push(name);
    if (name === "start_session" || name === "end_session") return ok({ status: "ok" });
    if (name === "browser_prepare") return new Promise((resolve) => { this.resolvePrepared = resolve; });
    throw new Error(`unexpected Cua call: ${name}`);
  }
}

class HangingDialogCua implements CuaToolClient {
  readonly calls: Array<Readonly<{ name: string; argumentsValue: Readonly<Record<string, unknown>> }>> = [];
  readonly #responses: CuaToolResult[] = [ok({ status: "ok" }), binding()];

  async callTool(
    name: string,
    argumentsValue: Readonly<Record<string, unknown>>,
    callContext?: Parameters<CuaToolClient["callTool"]>[2],
  ): Promise<CuaToolResult> {
    this.calls.push({ name, argumentsValue });
    if (name !== "browser_dialog") {
      const response = this.#responses.shift();
      if (response === undefined) throw new Error(`unexpected Cua call: ${name}`);
      return response;
    }
    await new Promise<never>((_, reject) => {
      const signal = callContext?.signal;
      if (signal?.aborted === true) reject(new Error("cancelled"));
      else signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
    throw new Error("unreachable");
  }
}

class OpenUrlCua implements CuaToolClient {
  readonly calls: Array<Readonly<{ name: string; argumentsValue: Readonly<Record<string, unknown>> }>> = [];
  #reads = 0;
  #marker: string | null = null;
  #navigationCount = 0;
  #markedDestination: string | null = null;

  constructor(private readonly options: Readonly<{
    finalPage?: Readonly<{ url: string; title: string }>;
    ambiguousMarkedBinding?: boolean;
    abortAfterFinalNavigation?: AbortController;
  }> = {}) {}

  async callTool(name: string, argumentsValue: Readonly<Record<string, unknown>>): Promise<CuaToolResult> {
    this.calls.push({ name, argumentsValue });
    if (name === "start_session" || name === "end_session") return ok({ status: "ok" });
    if (name === "bring_to_front") return ok({ status: "partial", code: "bring_to_front_exact_window_unverified" });
    if (name === "list_windows") return ok({
      windows: [{ window_id: 77, on_current_space: true, is_on_screen: true }],
    });
    if (name === "hotkey" || name === "press_key") {
      return ok({ effect: "unverifiable", route: "global_input", delivery: { mode: "foreground", delivered_count: 1 } });
    }
    if (name === "type_text") {
      this.#marker = String(argumentsValue["text"]);
      return ok({ effect: "unverifiable", route: "global_input", delivery: { mode: "background", delivered_count: this.#marker.length } });
    }
    if (name === "browser_navigate") {
      this.#navigationCount += 1;
      if (this.#navigationCount === 1) this.#markedDestination = String(argumentsValue["url"]);
      if (this.#navigationCount === 2) this.options.abortAfterFinalNavigation?.abort();
      return ok({
        status: "ok",
        target_id: argumentsValue["target_id"],
        tab_id: argumentsValue["tab_id"],
        url: argumentsValue["url"],
        refs_invalidated: true,
      });
    }
    if (name !== "get_browser_state") throw new Error(`unexpected Cua call: ${name}`);
    this.#reads += 1;
    if (this.#reads <= 4) return binding();
    if (this.#reads === 5) {
      if (this.#marker === null) throw new Error("marker was not typed before rebound");
      return ok({
        status: "ok",
        mode: "bind",
        target_id: "cua-target-reminted",
        binding_quality: "exact",
        binding_route: "native_cdp_window",
        endpoint_transport: "dev_tools_active_port",
        endpoint_access_class: "existing_profile_approved",
        mutation_allowed: true,
        native_title: "Owned browser fixture",
        tabs: [
          { tab_id: "cua-tab-old-reminted", title: "Fixture", url: "http://127.0.0.1/", active: false },
          { tab_id: "cua-tab-reminted", title: "New Tab", url: this.#marker, active: true },
        ],
      });
    }
    if (this.#navigationCount === 1 && argumentsValue["pid"] === 4242) {
      if (this.#markedDestination === null) throw new Error("marked destination missing before rebound");
      return ok({
        status: "ok",
        mode: "bind",
        target_id: "cua-target-final",
        binding_quality: "exact",
        binding_route: "native_cdp_window",
        endpoint_transport: "dev_tools_active_port",
        endpoint_access_class: "existing_profile_approved",
        mutation_allowed: true,
        native_title: "Owned browser fixture",
        tabs: [
          { tab_id: "cua-tab-old-final", title: "Fixture", url: "http://127.0.0.1/", active: false },
          { tab_id: "cua-tab-final", title: "Kyushu - Wikipedia", url: this.#markedDestination, active: true },
          ...(this.options.ambiguousMarkedBinding
            ? [{ tab_id: "cua-tab-ambiguous", title: "Duplicate", url: this.#markedDestination, active: false }]
            : []),
        ],
      });
    }
    const value = snapshot();
    return {
      ...value,
      structuredContent: {
        ...value.structuredContent!,
        target_id: "cua-target-final",
        tab_id: "cua-tab-final",
        page: this.options.finalPage ?? {
          url: "https://en.wikipedia.org/wiki/Kyushu",
          title: "Kyushu - Wikipedia",
        },
        outline: "heading Kyushu\nparagraph Kyushu is an island of Japan.",
      },
    };
  }
}

class AbortAfterCmdTCua implements CuaToolClient {
  readonly calls: Array<Readonly<{ name: string; argumentsValue: Readonly<Record<string, unknown>> }>> = [];
  #reads = 0;

  constructor(private readonly abort: AbortController) {}

  async callTool(name: string, argumentsValue: Readonly<Record<string, unknown>>): Promise<CuaToolResult> {
    this.calls.push({ name, argumentsValue });
    if (name === "start_session" || name === "end_session") return ok({ status: "ok" });
    if (name === "get_browser_state") {
      this.#reads += 1;
      return binding();
    }
    if (name === "bring_to_front") return ok({ status: "partial", code: "bring_to_front_exact_window_unverified" });
    if (name === "list_windows") return ok({
      windows: [{ window_id: 77, on_current_space: true, is_on_screen: true }],
    });
    if (name === "hotkey") {
      this.abort.abort();
      return ok({ effect: "unverifiable", route: "global_input", delivery: { mode: "foreground", delivered_count: 1 } });
    }
    throw new Error(`unexpected Cua call after cancellation: ${name}`);
  }
}

const ok = (structuredContent: Readonly<Record<string, unknown>>): CuaToolResult => ({ isError: false, structuredContent });
const binding = () => ok({
  status: "ok",
  mode: "bind",
  target_id: "cua-target-private",
  binding_quality: "exact",
  binding_route: "native_cdp_window",
  endpoint_transport: "dev_tools_active_port",
  endpoint_access_class: "driver_owned",
  mutation_allowed: true,
  native_title: "Owned browser fixture",
  tabs: [{ tab_id: "cua-tab-private", title: "Fixture", url: "http://127.0.0.1/", active: true }],
});
const snapshot = () => ok({
  status: "ok",
  mode: "snapshot",
  target_id: "cua-target-private",
  tab_id: "cua-tab-private",
  snapshot: {
    id: "cua-snapshot-private",
    format: "semantic_v2",
    complete: true,
    scope: "document",
    selected_nodes: 3,
    total_nodes: 3,
    node_budget: 200,
    omitted: { css_hidden: 0, offscreen: 0, page_occluded: 0, no_layout: 0, unknown: 0, budget: 0, unprovable_frame: 0 },
    continuation: null,
  },
  page: { url: "http://127.0.0.1/", title: "Fixture" },
  outline: "heading Fixture\ntextbox Exact text\nbutton Increment",
  refs: [
    { ref: "cua-input-private", role: "textbox", name: "Exact text", value: "", states: {}, actions: ["type", "click"], frame: "main", visibility: "in_viewport" },
    { ref: "cua-button-private", role: "button", name: "Increment", value: null, states: {}, actions: ["click"], frame: "main", visibility: "in_viewport" },
    { ref: "cua-pointer-private", role: "button", name: "Pointer target", value: null, states: {}, actions: ["pointer"], frame: "main", visibility: "in_viewport" },
    { ref: "cua-scroll-private", role: "region", name: "Scrollable", value: null, states: {}, actions: ["scroll"], frame: "main", visibility: "in_viewport" },
  ],
  content_refs: [
    { ref: "cua-heading-private", role: "heading", name: "Fixture", value: null, states: {}, actions: [], frame: "main", visibility: "in_viewport" },
  ],
  oopif: { status: "attached", frames: 0 },
});
const prepared = () => ok({
  status: "ok",
  prepared: true,
  action: "attached_existing_profile",
  message: "attached",
  endpoint_ownership: { method: "listening_socket_pid", owner_pid: 4242, listener_pid: 4242, detail: null },
  prepared_pid: 4242,
  side_effects: {
    launched_browser: false, restarted_browser: false, created_profile: false, reused_driver_profile: false,
    copied_profile_data: false, changed_preferences: false, displayed_consent_prompt: false,
    opened_setup_page: false, closed_setup_page: false, enabled_remote_debugging: false,
    used_bounded_pixel_fallback: false, focused_setup_address_field: false, foregrounded_window: false,
    injected_global_input: false,
  },
  attachment: { kind: "existing_profile", browser: "Chromium", capabilities_invalidated: true, next_action: "get_browser_state" },
});
const requiresSetup = () => ({
  isError: true,
  structuredContent: {
    status: "refused",
    refusal: { code: "browser_requires_setup", message: "explicit preparation required", detail: { next_action: "browser_prepare" } },
  },
} satisfies CuaToolResult);

const context = {
  authority: { authorityLeaseId: "lease", authorityGeneration: 1 },
  signal: new AbortController().signal,
} as const;

function handler(runtime: CuaBrowserRuntime, contractId: string): ComputerUseContractHandler {
  const found = runtime.handlers.find((candidate) => candidate.contract.contractId === contractId);
  if (found === undefined) throw new Error(`missing handler ${contractId}`);
  return found;
}

async function execute(runtime: CuaBrowserRuntime, contractId: string, args: Readonly<Record<string, ComputerUseJson>>): Promise<ComputerUseContractHandlerResult> {
  const selected = handler(runtime, contractId);
  return selected.execute(args, { ...context, contract: selected.contract });
}

async function boundRuntime(client: CuaToolClient, sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>): Promise<Readonly<{
  runtime: CuaBrowserRuntime;
  target: Readonly<Record<string, ComputerUseJson>>;
  tab: Readonly<Record<string, ComputerUseJson>>;
}>> {
  const runtime = new CuaBrowserRuntime({ client, randomBytes: deterministicRandom(), ...(sleep === undefined ? {} : { sleep }) });
  runtime.targets.registerWindow(nativeWindow, { pid: 4242, windowId: 77 }, context.authority);
  const result = await execute(runtime, "browser.bind_window", { window: nativeWindow });
  expect(result.settlement).toBe("completed");
  expect(result.result["status"]).toBe("bound");
  const projected = result.result as unknown as { target: Readonly<Record<string, ComputerUseJson>>; tabs: Array<{ target: Readonly<Record<string, ComputerUseJson>> }> };
  return { runtime, target: projected.target, tab: projected.tabs[0]!.target };
}

describe("Cua browser Host runtime", () => {
  test("read contracts reach only read-class Cua primitives", () => {
    expect(COMPUTER_USE_BROWSER_CONTRACT_PRIMITIVES.bindWindow.every((name) => CUA_BROWSER_PRIMITIVE_EFFECT[name] === "read")).toBe(true);
    expect(COMPUTER_USE_BROWSER_CONTRACT_PRIMITIVES.readPage.every((name) => CUA_BROWSER_PRIMITIVE_EFFECT[name] === "read")).toBe(true);
    expect(CUA_BROWSER_PRIMITIVE_EFFECT.browser_click).toBe("mutate");
    expect(CUA_BROWSER_PRIMITIVE_EFFECT.browser_navigate).toBe("mutate");
    expect(CUA_BROWSER_PRIMITIVE_EFFECT.browser_type).toBe("mutate");
    expect(CUA_BROWSER_PRIMITIVE_EFFECT.browser_pointer).toBe("mutate");
    expect(CUA_BROWSER_PRIMITIVE_EFFECT.browser_dialog).toBe("mutate");
  });

  test("every advertised browser contract dominates every reachable Cua primitive", () => {
    const rank = { read: 0, mutate: 1, sensitive: 2 } as const;
    for (const key of Object.keys(COMPUTER_USE_BROWSER_CONTRACT_PRIMITIVES) as Array<keyof typeof COMPUTER_USE_BROWSER_CONTRACT_PRIMITIVES>) {
      const contract = COMPUTER_USE_BROWSER_CONTRACTS[key];
      for (const primitive of COMPUTER_USE_BROWSER_CONTRACT_PRIMITIVES[key]) {
        expect(rank[contract.effectClass]).toBeGreaterThanOrEqual(rank[CUA_BROWSER_PRIMITIVE_EFFECT[primitive]]);
      }
    }
  });

  test("prepares, binds, and reuses one retained Cua session across a later turn", async () => {
    const client = new FakeCua([ok({ status: "ok" }), prepared(), binding(), snapshot(), ok({ status: "ok" })]);
    const runtime = new CuaBrowserRuntime({ client, randomBytes: deterministicRandom(), sleep: async () => undefined });
    runtime.targets.registerWindow(nativeWindow, { pid: 4242, windowId: 77 }, context.authority);
    const result = await execute(runtime, "browser.prepare", { window: nativeWindow });
    expect(result).toMatchObject({
      settlement: "completed",
      result: {
        status: "prepared",
        action: "attached_existing_profile",
        bindingQuality: "exact",
        mutationAllowed: true,
        doNotReplay: true,
      },
    });
    expect(client.calls[1]).toMatchObject({ name: "browser_prepare", argumentsValue: {
      pid: 4242, window_id: 77, strategy: { kind: "existing_profile" },
    } });
    expect(await execute(runtime, "browser.bind_window", { window: nativeWindow }))
      .toMatchObject({ settlement: "not_completed", result: { recovery: "observe_again" } });
    const projection = result.result as unknown as {
      target: Readonly<Record<string, ComputerUseJson>>;
      tabs: Array<{ target: Readonly<Record<string, ComputerUseJson>> }>;
    };
    expect(await execute(runtime, "browser.read_page", {
      target: projection.target,
      tab: projection.tabs[0]!.target,
    })).toMatchObject({ settlement: "completed", result: { status: "observed" } });
    expect(client.calls.map((call) => call.name)).toEqual([
      "start_session", "browser_prepare", "get_browser_state", "get_browser_state",
    ]);
    expect(new Set(client.calls.slice(1).map((call) => call.argumentsValue["session"])).size).toBe(1);
    await runtime.close();
    expect(client.calls.map((call) => call.name).at(-1)).toBe("end_session");
  });

  test("retains the first checked Cua session across bind requiring setup and explicit prepare", async () => {
    const client = new FakeCua([ok({ status: "ok" }), requiresSetup(), prepared(), binding(), ok({ status: "ok" })]);
    const runtime = new CuaBrowserRuntime({ client, randomBytes: deterministicRandom() });
    runtime.targets.registerWindow(nativeWindow, { pid: 4242, windowId: 77 }, context.authority);

    expect(await execute(runtime, "browser.bind_window", { window: nativeWindow }))
      .toMatchObject({ settlement: "not_completed", result: { recovery: "prepare_browser" } });
    expect(await execute(runtime, "browser.prepare", { window: nativeWindow }))
      .toMatchObject({ settlement: "completed", result: { status: "prepared", action: "attached_existing_profile" } });

    expect(client.calls.map((call) => call.name)).toEqual([
      "start_session", "get_browser_state", "browser_prepare", "get_browser_state",
    ]);
    const providerSessions = client.calls.slice(1).map((call) => call.argumentsValue["session"]);
    expect(new Set(providerSessions).size).toBe(1);
    await runtime.close();
    expect(client.calls.map((call) => call.name).at(-1)).toBe("end_session");
  });

  test("binds an exact native window and projects only opaque public references", async () => {
    const client = new FakeCua([ok({ status: "ok" }), binding()]);
    const { target, tab } = await boundRuntime(client);
    expect(client.calls.map((call) => call.name)).toEqual(["start_session", "get_browser_state"]);
    expect(client.calls[1]!.argumentsValue).toMatchObject({ pid: 4242, window_id: 77 });
    const publicBytes = JSON.stringify({ target, tab });
    for (const privateValue of ["4242", "77", "cua-target-private", "cua-tab-private", "native_cdp_window"]) {
      expect(publicBytes).not.toContain(privateValue);
    }
    expect(target["reference"]).toMatch(/^dbtgt_/);
    expect(tab["reference"]).toMatch(/^dbtab_/);
  });

  test("never redeems native or browser references under another authority lease", async () => {
    const client = new FakeCua([ok({ status: "ok" }), binding()]);
    const { runtime, target, tab } = await boundRuntime(client);
    const read = handler(runtime, "browser.read_page");
    const denied = await read.execute({ target, tab }, {
      authority: { authorityLeaseId: "foreign", authorityGeneration: 1 },
      contract: read.contract,
      signal: new AbortController().signal,
    });
    expect(denied).toMatchObject({ settlement: "not_completed", result: { status: "recovery_required" } });
    expect(client.calls.map((call) => call.name)).toEqual(["start_session", "get_browser_state"]);

    const second = new CuaBrowserRuntime({ client: new FakeCua([]), randomBytes: deterministicRandom() });
    second.targets.registerWindow(nativeWindow, { pid: 4242, windowId: 77 }, context.authority);
    const bind = handler(second, "browser.bind_window");
    expect(await bind.execute({ window: nativeWindow }, {
      authority: { authorityLeaseId: "foreign", authorityGeneration: 1 },
      contract: bind.contract,
      signal: new AbortController().signal,
    })).toMatchObject({ settlement: "not_completed", result: { status: "recovery_required" } });
  });

  test("a repeated read-only bind reuses the retained exact-window context", async () => {
    const client = new FakeCua([
      ok({ status: "ok" }), binding(),
      snapshot(), ok({ status: "ok" }),
    ]);
    const runtime = new CuaBrowserRuntime({ client, randomBytes: deterministicRandom() });
    runtime.targets.registerWindow(nativeWindow, { pid: 4242, windowId: 77 }, context.authority);
    const first = await execute(runtime, "browser.bind_window", { window: nativeWindow });
    const firstProjection = first.result as unknown as { target: Readonly<Record<string, ComputerUseJson>>; tabs: Array<{ target: Readonly<Record<string, ComputerUseJson>> }> };
    const second = await execute(runtime, "browser.bind_window", { window: nativeWindow });
    expect(second.settlement).toBe("completed");
    expect(second.result["target"]).toEqual(firstProjection.target);
    expect(client.calls.map((call) => call.name)).toEqual(["start_session", "get_browser_state"]);
    expect(await execute(runtime, "browser.read_page", { target: firstProjection.target, tab: firstProjection.tabs[0]!.target }))
      .toMatchObject({ settlement: "completed", result: { status: "observed" } });
    await runtime.close();
    expect(client.calls.map((call) => call.name).at(-1)).toBe("end_session");
  });

  test("projects semantic_v2 privately and consumes a ref before one delivered click", async () => {
    const client = new FakeCua([
      ok({ status: "ok" }), binding(), snapshot(),
      ok({ effect: "unverifiable", route: "trusted_input", delivery: { mode: "not_applicable" } }),
    ]);
    const { runtime, target, tab } = await boundRuntime(client);
    const observed = await execute(runtime, "browser.read_page", { target, tab });
    expect(observed.settlement).toBe("completed");
    const projection = observed.result as unknown as { refs: Array<{ target: Readonly<Record<string, ComputerUseJson>>; name: string }> };
    const button = projection.refs.find((ref) => ref.name === "Increment")!.target;
    const publicBytes = JSON.stringify(observed.result);
    for (const privateValue of ["cua-target-private", "cua-tab-private", "cua-input-private", "cua-button-private", "cua-heading-private", "cua-snapshot-private"]) {
      expect(publicBytes).not.toContain(privateValue);
    }

    const clicked = await execute(runtime, "browser.click", { target, tab, element: button, inputRoute: "trusted" });
    expect(clicked).toEqual({ settlement: "completed", result: { status: "delivered", observeAgain: true, doNotReplay: true } });
    expect(client.calls.at(-1)).toEqual({ name: "browser_click", argumentsValue: {
      target_id: "cua-target-private", tab_id: "cua-tab-private", ref: "cua-button-private", input_route: "trusted",
      session: expect.stringMatching(/^nautilo-browser_/),
    } });
    const repeated = await execute(runtime, "browser.click", { target, tab, element: button, inputRoute: "trusted" });
    expect(repeated).toMatchObject({ settlement: "not_completed", result: { status: "not_delivered", recovery: "observe_again" } });
    expect(client.calls.filter((call) => call.name === "browser_click")).toHaveLength(1);
  });

  test("routes navigation and full type delivery to exact bound provider ids", async () => {
    const navigationClient = new FakeCua([
      ok({ status: "ok" }), binding(),
      ok({ status: "ok", target_id: "cua-target-private", tab_id: "cua-tab-private", url: "http://127.0.0.1/next", refs_invalidated: true }),
    ]);
    const navigation = await boundRuntime(navigationClient);
    expect(await execute(navigation.runtime, "browser.navigate", { target: navigation.target, tab: navigation.tab, url: "http://127.0.0.1/next" }))
      .toMatchObject({ settlement: "completed", result: { status: "delivered", doNotReplay: true } });

    const typeClient = new FakeCua([
      ok({ status: "ok" }), binding(), snapshot(),
      ok({ effect: "unverifiable", route: "trusted_input", delivery: { mode: "not_applicable", delivered_count: 4 } }),
    ]);
    const typing = await boundRuntime(typeClient);
    const observed = await execute(typing.runtime, "browser.read_page", { target: typing.target, tab: typing.tab });
    const refs = (observed.result as unknown as { refs: Array<{ target: Readonly<Record<string, ComputerUseJson>>; name: string }> }).refs;
    const input = refs.find((ref) => ref.name === "Exact text")!.target;
    expect(await execute(typing.runtime, "browser.type", { target: typing.target, tab: typing.tab, element: input, text: "Cua!", mode: "insert_text", replace: true }))
      .toMatchObject({ settlement: "completed", result: { status: "delivered", observeAgain: true } });
    expect(typeClient.calls.at(-1)).toMatchObject({ name: "browser_type", argumentsValue: { ref: "cua-input-private", text: "Cua!", replace: true } });
  });

  test("opens one URL in one new tab using count plus a unique rebound URL and retains the session", async () => {
    const client = new OpenUrlCua();
    const bound = await boundRuntime(client);
    const opened = await execute(bound.runtime, "browser.open_url", {
      target: bound.target,
      url: "https://en.wikipedia.org/wiki/Kyushu",
    });
    expect(opened).toMatchObject({
      settlement: "completed",
      result: {
        status: "opened",
        page: { title: "Kyushu - Wikipedia", url: "https://en.wikipedia.org/wiki/Kyushu" },
        outline: expect.stringContaining("island of Japan"),
        doNotReplay: true,
      },
    });
    const cmdT = client.calls.filter((call) => call.name === "hotkey"
      && JSON.stringify(call.argumentsValue["keys"]) === JSON.stringify(["cmd", "t"]));
    expect(cmdT).toHaveLength(1);
    const typed = client.calls.find((call) => call.name === "type_text")!;
    expect(typed.argumentsValue["text"]).toMatch(/^about:blank#nautilo-[a-z0-9_-]{43}$/);
    expect(typed.argumentsValue).toMatchObject({ pid: 4242, window_id: 77, delivery_mode: "foreground" });
    const navigations = client.calls.filter((call) => call.name === "browser_navigate");
    expect(navigations[0]!.argumentsValue).toMatchObject({
      target_id: "cua-target-reminted",
      tab_id: "cua-tab-reminted",
    });
    expect(navigations[0]!.argumentsValue["url"]).toMatch(/^https:\/\/en\.wikipedia\.org\/wiki\/Kyushu#nautilo-[a-z0-9_-]{43}$/);
    expect(navigations[1]!.argumentsValue).toMatchObject({
      target_id: "cua-target-final",
      tab_id: "cua-tab-final",
      url: "https://en.wikipedia.org/wiki/Kyushu",
    });
    expect(navigations).toHaveLength(2);
    const result = opened.result as unknown as {
      target: Readonly<Record<string, ComputerUseJson>>;
      tab: Readonly<Record<string, ComputerUseJson>>;
    };
    expect(await execute(bound.runtime, "browser.read_page", { target: result.target, tab: result.tab }))
      .toMatchObject({ settlement: "completed", result: { status: "observed", outline: expect.stringContaining("Kyushu") } });
    expect(client.calls.filter((call) => call.name === "start_session")).toHaveLength(1);
    expect(client.calls.filter((call) => call.name === "browser_prepare")).toHaveLength(0);
    expect(new Set(client.calls.filter((call) => call.argumentsValue["session"] !== undefined)
      .map((call) => call.argumentsValue["session"])).size).toBe(1);
  });

  test("settles an exact URL immediately while its title is empty or still generic", async () => {
    for (const title of ["", "New Tab"]) {
      const client = new OpenUrlCua({
        finalPage: { url: "https://en.wikipedia.org/wiki/Kyushu", title },
      });
      const bound = await boundRuntime(client);
      const opened = await execute(bound.runtime, "browser.open_url", {
        target: bound.target,
        url: "https://en.wikipedia.org/wiki/Kyushu",
      });
      expect(opened).toMatchObject({
        settlement: "completed",
        result: { status: "opened", page: { url: "https://en.wikipedia.org/wiki/Kyushu", title } },
      });
      expect(client.calls.filter((call) => call.name === "get_browser_state")).toHaveLength(7);
      expect(client.calls.filter((call) => call.name === "browser_navigate")).toHaveLength(2);
    }
  });

  test("does not claim an opened page for a wrong URL or ambiguous marked tab", async () => {
    const wrongUrlAbort = new AbortController();
    const wrongUrlClient = new OpenUrlCua({
      finalPage: { url: "https://example.invalid/redirect", title: "Redirect" },
    });
    let waits = 0;
    const wrongUrl = await boundRuntime(wrongUrlClient, async () => {
      waits += 1;
      if (waits === 4) wrongUrlAbort.abort();
    });
    const selected = handler(wrongUrl.runtime, "browser.open_url");
    const wrongUrlResult = await selected.execute({
      target: wrongUrl.target,
      url: "https://en.wikipedia.org/wiki/Kyushu",
    }, { authority: context.authority, contract: selected.contract, signal: wrongUrlAbort.signal });
    expect(wrongUrlResult).toMatchObject({
      settlement: "completed",
      result: { status: "delivered", observeAgain: true, doNotReplay: true },
    });
    expect(wrongUrlClient.calls.filter((call) => call.name === "browser_navigate")).toHaveLength(2);

    const ambiguousClient = new OpenUrlCua({ ambiguousMarkedBinding: true });
    const ambiguous = await boundRuntime(ambiguousClient);
    expect(await execute(ambiguous.runtime, "browser.open_url", {
      target: ambiguous.target,
      url: "https://en.wikipedia.org/wiki/Kyushu",
    })).toMatchObject({
      settlement: "unknown_completion",
      result: { status: "unknown_completion", observeAgain: true, doNotReplay: true },
    });
    expect(ambiguousClient.calls.filter((call) => call.name === "browser_navigate")).toHaveLength(1);
  });

  test("keeps completion unknown when cancellation follows delivered final navigation", async () => {
    const abort = new AbortController();
    const client = new OpenUrlCua({ abortAfterFinalNavigation: abort });
    const bound = await boundRuntime(client);
    const selected = handler(bound.runtime, "browser.open_url");
    const result = await selected.execute({
      target: bound.target,
      url: "https://en.wikipedia.org/wiki/Kyushu",
    }, { authority: context.authority, contract: selected.contract, signal: abort.signal });
    expect(result).toMatchObject({
      settlement: "unknown_completion",
      result: { status: "unknown_completion", observeAgain: true, doNotReplay: true },
    });
    expect(client.calls.filter((call) => call.name === "browser_navigate")).toHaveLength(2);
  });

  test("never replays a new-tab mutation when cancellation lands after Cmd+T", async () => {
    const abort = new AbortController();
    const client = new AbortAfterCmdTCua(abort);
    const bound = await boundRuntime(client);
    const selected = handler(bound.runtime, "browser.open_url");
    const result = await selected.execute({
      target: bound.target,
      url: "https://en.wikipedia.org/wiki/Kyushu",
    }, {
      authority: context.authority,
      contract: selected.contract,
      signal: abort.signal,
    });
    expect(result).toEqual({
      settlement: "unknown_completion",
      result: { status: "unknown_completion", observeAgain: true, doNotReplay: true },
    });
    expect(client.calls.filter((call) => call.name === "hotkey")).toHaveLength(1);
    expect(client.calls.filter((call) => call.name === "type_text" || call.name === "browser_navigate")).toHaveLength(0);
    expect(client.calls.filter((call) => call.name === "end_session")).toHaveLength(1);
  });

  test("routes pointer refs and page-dialog capabilities without exposing provider ids", async () => {
    const pointerClient = new FakeCua([
      ok({ status: "ok" }), binding(), snapshot(),
      ok({ effect: "unverifiable", route: "dom", delivery: { mode: "background" } }),
    ]);
    const pointer = await boundRuntime(pointerClient);
    const observed = await execute(pointer.runtime, "browser.read_page", { target: pointer.target, tab: pointer.tab });
    const refs = (observed.result as unknown as { refs: Array<{ target: Readonly<Record<string, ComputerUseJson>>; name: string | null }> }).refs;
    const scroll = refs.find((ref) => ref.name === "Scrollable")!.target;
    expect(await execute(pointer.runtime, "browser.pointer", {
      target: pointer.target, tab: pointer.tab, element: scroll, action: "scroll", inputRoute: "dom_event", deltaY: -240,
    })).toMatchObject({ settlement: "completed", result: { status: "delivered", observeAgain: true, doNotReplay: true } });
    expect(pointerClient.calls.at(-1)).toMatchObject({ name: "browser_pointer", argumentsValue: {
      ref: "cua-scroll-private", action: "scroll", delta_x: 0, delta_y: -240, input_route: "dom_event",
    } });

    const dialogClient = new FakeCua([
      ok({ status: "ok" }), binding(),
      ok({ status: "ok", target_id: "cua-target-private", tab_id: "cua-tab-private", present: true, dialog_id: "dialog-private", kind: "prompt" }),
      ok({ status: "ok", target_id: "cua-target-private", tab_id: "cua-tab-private", dialog_id: "dialog-private", kind: "prompt", action: "accept" }),
    ]);
    const dialogRuntime = await boundRuntime(dialogClient);
    const inspected = await execute(dialogRuntime.runtime, "browser.dialog", { target: dialogRuntime.target, tab: dialogRuntime.tab, action: "inspect" });
    expect(inspected).toMatchObject({ settlement: "completed", result: { status: "observed", present: true, kind: "prompt" } });
    const dialog = (inspected.result as unknown as { dialog: Readonly<Record<string, ComputerUseJson>> }).dialog;
    expect(JSON.stringify(dialog)).not.toContain("dialog-private");
    expect(await execute(dialogRuntime.runtime, "browser.dialog", {
      target: dialogRuntime.target, tab: dialogRuntime.tab, action: "accept", dialog, promptText: "private answer", deliveryMode: "background",
    })).toMatchObject({ settlement: "completed", result: { status: "delivered", observeAgain: true, doNotReplay: true } });
    expect(dialogClient.calls.at(-1)).toMatchObject({ name: "browser_dialog", argumentsValue: {
      dialog_id: "dialog-private", prompt_text: "private answer", delivery_mode: "background",
    } });
  });

  test("accepts additive provider fields but rejects contradictory known invariants", async () => {
    const additiveBinding = binding();
    const additive = new FakeCua([
      ok({ status: "ok", provider_addition: { version: 2 } }),
      { ...additiveBinding, structuredContent: { ...additiveBinding.structuredContent!, provider_addition: true } },
    ]);
    const runtime = new CuaBrowserRuntime({ client: additive, randomBytes: deterministicRandom() });
    runtime.targets.registerWindow(nativeWindow, { pid: 4242, windowId: 77 }, context.authority);
    expect(await execute(runtime, "browser.bind_window", { window: nativeWindow })).toMatchObject({ settlement: "completed" });

    const contradictory = new FakeCua([ok({ status: "ok" }), { ...binding(), structuredContent: { ...binding().structuredContent!, mutation_allowed: false } }, ok({ status: "ok" })]);
    const denied = new CuaBrowserRuntime({ client: contradictory, randomBytes: deterministicRandom() });
    denied.targets.registerWindow(nativeWindow, { pid: 4242, windowId: 77 }, context.authority);
    expect(await execute(denied, "browser.bind_window", { window: nativeWindow })).toMatchObject({ settlement: "failed" });
  });

  test.each([
    'multiple exact AXButton controls matched "New Tab"',
    "multiple distinct native New Tab buttons matched",
  ])("cold setup preserves the exact ambiguity category: %s", async (message) => {
    const client = new FakeCua([
      ok({ status: "ok" }),
      { isError: true, structuredContent: {
        status: "refused", refusal: {
          code: "browser_wrong_target_refused",
          message,
          detail: { diagnostic: "private-content-must-not-leak" },
        },
      } },
      ok({ status: "ok" }),
    ]);
    const runtime = new CuaBrowserRuntime({ client, randomBytes: deterministicRandom() });
    runtime.targets.registerWindow(nativeWindow, { pid: 4242, windowId: 77 }, context.authority);
    const failed = await execute(runtime, "browser.prepare", { window: nativeWindow });
    expect(failed).toEqual({ settlement: "not_completed", result: {
      status: "recovery_required", recovery: "use_native_window", observeAgain: true, doNotReplay: true,
      failure: {
        reason: "setup_control_ambiguous", stage: "prepare", stateChangeCertainty: "not_changed",
        retryCondition: "route_or_provider_change",
      },
    } });
    expect(BROWSER_CONTRACT_SCHEMAS.prepare.result.safeParse(failed.result).success).toBe(true);
    expect(JSON.stringify(failed)).not.toMatch(/AXButton|New Tab|private-content|4242|window_id/);
    await execute(runtime, "browser.prepare", { window: nativeWindow });
    await runtime.close();
    expect(client.calls.map((call) => call.name)).toEqual(["start_session", "browser_prepare", "end_session"]);
  });

  test("proven pre-effect refusal retires the old target without permanently fencing the window", async () => {
    const noEffects = {
      opened_setup_page: false, closed_setup_page: false, focused_setup_address_field: false,
      enabled_remote_debugging: false, used_bounded_pixel_fallback: false,
      foregrounded_window: false, injected_global_input: false,
    };
    for (const setup of [noEffects, { ...noEffects, restored_remote_debugging: true }]) {
      const client = new FakeCua([
        ok({ status: "ok" }),
        { isError: true, structuredContent: { status: "refused", refusal: {
          code: "browser_wrong_target_refused", message: "pre-effect refusal",
          detail: { setup_side_effects: setup },
        } } },
        ok({ status: "ok" }),
        ok({ status: "ok" }), prepared(), binding(), ok({ status: "ok" }),
      ]);
      const runtime = new CuaBrowserRuntime({ client, randomBytes: deterministicRandom() });
      runtime.targets.registerWindow(nativeWindow, { pid: 4242, windowId: 77 }, context.authority);
      expect(await execute(runtime, "browser.prepare", { window: nativeWindow })).toMatchObject({
        settlement: "not_completed", result: { failure: { stateChangeCertainty: "not_changed" } },
      });
      await execute(runtime, "browser.prepare", { window: nativeWindow });
      expect(client.calls.map(({ name }) => name)).toEqual(["start_session", "browser_prepare", "end_session"]);
      // A new observation after native recovery is a new authorized attempt,
      // not a replay of the consumed target or of an uncertain mutation.
      const fresh = { ...nativeWindow, reference: `dtgt_${"f".repeat(43)}` };
      runtime.targets.registerWindow(fresh, { pid: 4242, windowId: 77 }, context.authority);
      expect(await execute(runtime, "browser.prepare", { window: fresh })).toMatchObject({ settlement: "completed" });
      expect(client.calls.map(({ name }) => name)).toEqual([
        "start_session", "browser_prepare", "end_session", "start_session", "browser_prepare", "get_browser_state",
      ]);
      await runtime.close();
    }
  });

  test("setup side effects or missing evidence never become safe retry permission", async () => {
    const noEffects = {
      opened_setup_page: false, closed_setup_page: false, focused_setup_address_field: false,
      enabled_remote_debugging: false, used_bounded_pixel_fallback: false,
      foregrounded_window: false, injected_global_input: false,
    };
    for (const [setup, certainty, settlement] of [
      [{ ...noEffects, opened_setup_page: true }, "changed", "unknown_completion"],
      [{ ...noEffects, opened_setup_page: true, closed_setup_page: true, restored_remote_debugging: true }, "changed", "unknown_completion"],
      [{ ...noEffects, restored_remote_debugging: "unknown" }, "unknown", "unknown_completion"],
      [{ ...noEffects, opened_setup_page: "unknown" }, "unknown", "unknown_completion"],
      [undefined, "unknown", "unknown_completion"],
    ] as const) {
      const client = new FakeCua([
        ok({ status: "ok" }),
        { isError: true, structuredContent: { status: "refused", refusal: {
          code: "browser_wrong_target_refused", message: "unrecognized private target diagnostic",
          detail: setup === undefined ? {} : { setup_side_effects: setup },
        } } },
        requiresSetup(),
        ok({ status: "ok" }),
      ]);
      const runtime = new CuaBrowserRuntime({ client, randomBytes: deterministicRandom() });
      runtime.targets.registerWindow(nativeWindow, { pid: 4242, windowId: 77 }, context.authority);
      const failed = await execute(runtime, "browser.prepare", { window: nativeWindow });
      expect(failed).toMatchObject({ settlement, result: {
        doNotReplay: true, failure: { reason: "wrong_target", stage: "prepare", stateChangeCertainty: certainty,
          retryCondition: certainty === "not_changed" ? "route_or_provider_change" : "inspect_effects_before_continuing" },
      } });
      expect(BROWSER_CONTRACT_SCHEMAS.prepare.result.safeParse(failed.result).success).toBe(true);
      expect(JSON.stringify(failed)).not.toContain("private target diagnostic");
      const fresh = { ...nativeWindow, reference: `dtgt_${"f".repeat(43)}` };
      runtime.targets.registerWindow(fresh, { pid: 4242, windowId: 77 }, context.authority);
      expect(await execute(runtime, "browser.prepare", { window: fresh })).toEqual(failed);
      const rebound = await execute(runtime, "browser.bind_window", { window: fresh });
      expect(rebound).toMatchObject({ settlement: "not_completed", result: {
        recovery: "use_native_window", failure: { stage: "bind", reason: "setup_required", stateChangeCertainty: certainty },
      } });
      expect(BROWSER_CONTRACT_SCHEMAS.bindWindow.result.safeParse(rebound.result).success).toBe(true);
      expect(await execute(runtime, "browser.prepare", { window: fresh })).toEqual(failed);
      expect(client.calls.map(({ name }) => name)).toEqual(["start_session", "browser_prepare", "get_browser_state"]);
      await runtime.close();
      expect(client.calls.at(-1)?.name).toBe("end_session");
    }
  });

  test("reconciliation reports the current bind failure without erasing uncertain setup or replaying it", async () => {
    const cases: ReadonlyArray<readonly [CuaToolResult | null, string]> = [
      [{ isError: true, structuredContent: { status: "refused", refusal: {
        code: "browser_binding_ambiguous", message: "private current bind diagnostic",
      } } }, "target_ambiguous"],
      [{ isError: true, structuredContent: { status: "refused", refusal: {
        code: "browser_binding_stale", message: "private current bind diagnostic",
      } } }, "target_stale"],
      [requiresSetup(), "setup_required"],
      [ok({ status: "ok", malformed: true }), "invalid_provider_response"],
      [null, "transport_unavailable"],
    ];
    for (const [bindResponse, reason] of cases) {
      const calls: Array<{ name: string; session: unknown }> = [];
      const client: CuaToolClient = {
        async callTool(name, args) {
          calls.push({ name, session: args["session"] });
          if (name === "browser_prepare") return { isError: true, structuredContent: {
            status: "refused", refusal: { code: "browser_wrong_target_refused", message: "private setup diagnostic" },
          } };
          if (name === "get_browser_state") {
            if (bindResponse === null) throw new Error("private transport diagnostic");
            return bindResponse;
          }
          return ok({ status: "ok" });
        },
      };
      const runtime = new CuaBrowserRuntime({ client, randomBytes: deterministicRandom() });
      try {
        runtime.targets.registerWindow(nativeWindow, { pid: 4242, windowId: 77 }, context.authority);
        const preparation = await execute(runtime, "browser.prepare", { window: nativeWindow });
        const fresh = { ...nativeWindow, reference: `dtgt_${"f".repeat(43)}` };
        runtime.targets.registerWindow(fresh, { pid: 4242, windowId: 77 }, context.authority);
        const rebound = await execute(runtime, "browser.bind_window", { window: fresh });
        expect(rebound).toMatchObject({ settlement: "not_completed", result: {
          recovery: "use_native_window", failure: {
            stage: "bind", reason, stateChangeCertainty: "unknown", retryCondition: "inspect_effects_before_continuing",
          },
        } });
        expect(BROWSER_CONTRACT_SCHEMAS.bindWindow.result.safeParse(rebound.result).success).toBe(true);
        expect(JSON.stringify(rebound)).not.toContain("private");
        expect(await execute(runtime, "browser.prepare", { window: fresh })).toEqual(preparation);
        expect(calls.map(({ name }) => name)).toEqual(["start_session", "browser_prepare", "get_browser_state"]);
        expect(new Set(calls.map(({ session }) => session)).size).toBe(1);
      } finally {
        await runtime.close();
      }
      expect(calls.at(-1)?.name).toBe("end_session");
    }
  });

  test("fresh native references reconcile a lost bind in the prepared session without replaying setup", async () => {
    const calls: Array<{ name: string; session: unknown }> = [];
    let binds = 0;
    const client: CuaToolClient = {
      async callTool(name, args) {
        calls.push({ name, session: args["session"] });
        if (name === "browser_prepare") return prepared();
        if (name === "get_browser_state" && args["pid"] !== undefined) {
          if (++binds === 1) throw new Error("lost bind response");
          return binding();
        }
        if (name === "get_browser_state") return snapshot();
        return ok({ status: "ok" });
      },
    };
    const runtime = new CuaBrowserRuntime({ client, randomBytes: deterministicRandom() });
    runtime.targets.registerWindow(nativeWindow, { pid: 4242, windowId: 77 }, context.authority);
    const failed = await execute(runtime, "browser.prepare", { window: nativeWindow });
    expect(failed.settlement).toBe("unknown_completion");
    const fresh = { ...nativeWindow, reference: `dtgt_${"f".repeat(43)}` };
    runtime.targets.registerWindow(fresh, { pid: 4242, windowId: 77 }, context.authority);
    expect(await execute(runtime, "browser.prepare", { window: fresh })).toEqual(failed);
    expect(calls.filter(({ name }) => name === "browser_prepare")).toHaveLength(1);
    expect(calls.some(({ name }) => name === "end_session")).toBe(false);
    const rebound = await execute(runtime, "browser.bind_window", { window: fresh });
    expect(rebound.settlement).toBe("completed");
    expect(BROWSER_CONTRACT_SCHEMAS.bindWindow.result.safeParse(rebound.result).success).toBe(true);
    const projection = rebound.result as unknown as {
      target: Readonly<Record<string, ComputerUseJson>>;
      tabs: Array<{ target: Readonly<Record<string, ComputerUseJson>> }>;
    };
    expect((await execute(runtime, "browser.read_page", {
      target: projection.target, tab: projection.tabs[0]!.target,
    })).settlement).toBe("completed");
    expect(new Set(calls.map(({ session }) => session)).size).toBe(1);
    await runtime.close();
    expect(calls.filter(({ name }) => name === "end_session")).toHaveLength(1);
  });

  test("successful preparation followed by bind loss never discards setup completion evidence", async () => {
    for (const bindResponse of [null, ok({ status: "ok", malformed: true }), requiresSetup()]) {
      const prepareResponse = prepared();
      const fields = prepareResponse.structuredContent!;
      const client: CuaToolClient = {
        async callTool(name) {
          if (name === "browser_prepare") return ok({ ...fields, side_effects: {
            ...(fields["side_effects"] as Record<string, unknown>), enabled_remote_debugging: true,
          } });
          if (name === "get_browser_state") {
            if (bindResponse === null) throw new Error("private transport diagnostic");
            return bindResponse;
          }
          return ok({ status: "ok" });
        },
      };
      const runtime = new CuaBrowserRuntime({ client, randomBytes: deterministicRandom() });
      runtime.targets.registerWindow(nativeWindow, { pid: 4242, windowId: 77 }, context.authority);
      const failed = await execute(runtime, "browser.prepare", { window: nativeWindow });
      expect(failed).toMatchObject({ settlement: "unknown_completion", result: {
        status: "unknown_completion", observeAgain: true, doNotReplay: true,
        failure: { stage: "bind", stateChangeCertainty: "changed", retryCondition: "inspect_effects_before_continuing" },
      } });
      expect(BROWSER_CONTRACT_SCHEMAS.prepare.result.safeParse(failed.result).success).toBe(true);
      expect(JSON.stringify(failed)).not.toContain("private transport diagnostic");
      await runtime.close();
    }
  });

  test("maps recognized refusals exactly and treats malformed mutation completion as unknown", async () => {
    for (const [code, recovery] of [
      ["browser_requires_setup", "prepare_browser"],
      ["browser_consent_required", "request_access"],
      ["browser_route_unavailable", "use_native_window"],
      ["browser_binding_stale", "observe_again"],
    ] as const) {
      const client = new FakeCua([ok({ status: "ok" }), { isError: true, structuredContent: { status: "refused", refusal: { code, message: "bounded refusal" } } }, ok({ status: "ok" })]);
      const runtime = new CuaBrowserRuntime({ client, randomBytes: deterministicRandom() });
      runtime.targets.registerWindow(nativeWindow, { pid: 4242, windowId: 77 }, context.authority);
      expect(await execute(runtime, "browser.bind_window", { window: nativeWindow }))
        .toMatchObject({ settlement: "not_completed", result: { status: "recovery_required", recovery } });
      if (recovery === "prepare_browser") {
        expect(client.calls.at(-1)!.name).toBe("get_browser_state");
        await runtime.close();
      }
      expect(client.calls.at(-1)!.name).toBe("end_session");
    }

    const prepareNext = new FakeCua([
      ok({ status: "ok" }),
      { isError: true, structuredContent: {
        status: "refused",
        refusal: { code: "browser_consent_required", message: "bounded refusal", detail: { next_action: "browser_prepare" } },
      } },
      ok({ status: "ok" }),
    ]);
    const prepareRuntime = new CuaBrowserRuntime({ client: prepareNext, randomBytes: deterministicRandom() });
    prepareRuntime.targets.registerWindow(nativeWindow, { pid: 4242, windowId: 77 }, context.authority);
    expect(await execute(prepareRuntime, "browser.bind_window", { window: nativeWindow }))
      .toMatchObject({ settlement: "not_completed", result: { recovery: "prepare_browser" } });
    await prepareRuntime.close();

    const malformed = new FakeCua([ok({ status: "ok" }), binding(), ok({ status: "ok", surprise: true })]);
    const bound = await boundRuntime(malformed);
    expect(await execute(bound.runtime, "browser.navigate", { target: bound.target, tab: bound.tab, url: "https://example.com/" }))
      .toEqual({ settlement: "unknown_completion", result: {
        status: "unknown_completion", observeAgain: true, doNotReplay: true,
        failure: { reason: "invalid_provider_response", stage: "action", stateChangeCertainty: "unknown",
          retryCondition: "inspect_effects_before_continuing" },
      } });
  });

  test("classifies an aborted provider call as cancelled instead of failed or unknown completion", async () => {
    const client = new HangingDialogCua();
    const bound = await boundRuntime(client);
    const selected = handler(bound.runtime, "browser.dialog");
    const abort = new AbortController();
    const pending = selected.execute({ target: bound.target, tab: bound.tab, action: "inspect" }, {
      authority: context.authority,
      contract: selected.contract,
      signal: abort.signal,
    });
    await Bun.sleep(0);
    abort.abort();
    expect(await pending).toEqual({
      settlement: "cancelled",
      result: { status: "recovery_required", recovery: "observe_again" },
    });
  });

  test("maps a canonical action refusal without exposing provider diagnostics", async () => {
    const client = new FakeCua([
      ok({ status: "ok" }), binding(), snapshot(),
      { isError: true, structuredContent: { effect: "refused", route: "trusted_input", escalation: { target: "page", reason: "effect_unconfirmed" } } },
    ]);
    const { runtime, target, tab } = await boundRuntime(client);
    const observed = await execute(runtime, "browser.read_page", { target, tab });
    const refs = (observed.result as unknown as { refs: Array<{ target: Readonly<Record<string, ComputerUseJson>>; name: string | null }> }).refs;
    const button = refs.find((ref) => ref.name === "Increment")!.target;
    expect(await execute(runtime, "browser.click", { target, tab, element: button, inputRoute: "trusted" }))
      .toEqual({ settlement: "not_completed", result: {
        status: "not_delivered", observeAgain: true, doNotReplay: true, recovery: "observe_again",
        failure: { reason: "action_unavailable", stage: "action", stateChangeCertainty: "not_changed",
          retryCondition: "fresh_target", inputRoute: "trusted",
          escalation: { target: "page", reason: "effect_unconfirmed" } },
      } });
  });

  test("live-document preflight failure retains the exact session and tab without hidden activation", async () => {
    const client = new FakeCua([ok({ status: "ok" }), binding(), { isError: true, structuredContent: {
      status: "refused", refusal: { code: "authorization_host_failed",
        message: "confirmation provider failed: could not prove the live top-level browser document: CDP Page.getFrameTree timed out after 20s" },
    } }, snapshot()]);
    const { runtime, target, tab } = await boundRuntime(client);
    const failed = await execute(runtime, "browser.read_page", { target, tab });
    expect(failed).toEqual({ settlement: "not_completed", result: {
      status: "recovery_required", recovery: "use_native_window",
      failure: { reason: "page_unavailable", stage: "read", stateChangeCertainty: "not_changed",
        retryCondition: "route_or_provider_change" },
    } });
    expect(JSON.stringify(failed)).not.toMatch(/Page.getFrameTree|authorization_host|discard/);
    expect(await execute(runtime, "browser.read_page", { target, tab }))
      .toMatchObject({ settlement: "completed", result: { status: "observed" } });
    expect(client.calls.map((call) => call.name))
      .toEqual(["start_session", "get_browser_state", "get_browser_state", "get_browser_state"]);
    expect(client.calls[2]!.argumentsValue).toEqual(client.calls[3]!.argumentsValue);
  });

  test("generic authorization errors are not invented page recovery or safe mutation refusals", async () => {
    const failure = { isError: true, structuredContent: { status: "refused", refusal: {
      code: "authorization_host_failed", message: "confirmation provider failed: private diagnostic",
    } } };
    const client = new FakeCua([ok({ status: "ok" }), binding(), failure]);
    const { runtime, target, tab } = await boundRuntime(client);
    expect(await execute(runtime, "browser.read_page", { target, tab }))
      .toMatchObject({ settlement: "failed", result: { failure: { reason: "invalid_provider_response" } } });
    const mutation = await boundRuntime(new FakeCua([ok({ status: "ok" }), binding(), failure]));
    expect(await execute(mutation.runtime, "browser.navigate", { target: mutation.target, tab: mutation.tab, url: "https://example.com/" }))
      .toMatchObject({ settlement: "unknown_completion", result: { doNotReplay: true } });
  });

  test("legacy trusted-input refusal remains non-delivery without an automatic DOM retry", async () => {
    const client = new FakeCua([ok({ status: "ok" }), binding(), snapshot(), { isError: true, structuredContent: {
      status: "refused", refusal: { code: "browser_input_trust_unavailable", message: "private route diagnostic",
        detail: { alternative_route: "dom_event", trusted_delivery_attempted: false } },
    } }]);
    const { runtime, target, tab } = await boundRuntime(client);
    const observed = await execute(runtime, "browser.read_page", { target, tab });
    const refs = (observed.result as unknown as { refs: Array<{ target: Readonly<Record<string, ComputerUseJson>>; name: string | null }> }).refs;
    const result = await execute(runtime, "browser.click", {
      target, tab, element: refs.find((ref) => ref.name === "Increment")!.target, inputRoute: "trusted",
    });
    expect(result).toMatchObject({ settlement: "not_completed", result: {
      status: "not_delivered", recovery: "use_native_window", doNotReplay: true,
      failure: { reason: "input_trust_unavailable", stage: "action", stateChangeCertainty: "not_changed" },
    } });
    expect(JSON.stringify(result)).not.toContain("private route diagnostic");
    expect(client.calls.filter((call) => call.name === "browser_click")).toHaveLength(1);
  });

  test("contradictory action envelopes never become safe refusal or authorize replay", async () => {
    for (const response of [
      { effect: "refused", route: "trusted_input", delivery: { mode: "background", delivered_count: 1 } },
      { effect: "refused", route: "dom" },
      { effect: "partial", route: "trusted_input", delivery: { mode: "background", delivered_count: 1 } },
      { effect: "invalid", status: "refused", refusal: { code: "browser_input_trust_unavailable", message: "private" } },
    ]) {
      const client = new FakeCua([ok({ status: "ok" }), binding(), snapshot(), { isError: true, structuredContent: response }]);
      const { runtime, target, tab } = await boundRuntime(client);
      const observed = await execute(runtime, "browser.read_page", { target, tab });
      const refs = (observed.result as unknown as { refs: Array<{ target: Readonly<Record<string, ComputerUseJson>>; name: string | null }> }).refs;
      const args = { target, tab, element: refs.find((ref) => ref.name === "Increment")!.target, inputRoute: "trusted" };
      expect(await execute(runtime, "browser.click", args))
        .toMatchObject({ settlement: "unknown_completion", result: { observeAgain: true, doNotReplay: true } });
      expect(await execute(runtime, "browser.click", args)).toMatchObject({ settlement: "not_completed",
        result: { status: "not_delivered", observeAgain: true, doNotReplay: true } });
      expect(client.calls.filter((call) => call.name === "browser_click")).toHaveLength(1);
    }
  });

  test("serializes same-tab reads, and queued cancellation never reaches Cua or aborts its sibling", async () => {
    const client = new CoordinatedBrowserCua();
    const runtime = new CuaBrowserRuntime({ client, randomBytes: deterministicRandom() });
    runtime.targets.registerWindow(nativeWindow, { pid: 4242, windowId: 77 }, context.authority);
    const bound = await execute(runtime, "browser.bind_window", { window: nativeWindow });
    const projection = bound.result as unknown as {
      target: Readonly<Record<string, ComputerUseJson>>;
      tabs: Array<{ target: Readonly<Record<string, ComputerUseJson>> }>;
    };
    const selected = handler(runtime, "browser.read_page");
    const first = selected.execute({ target: projection.target, tab: projection.tabs[0]!.target }, {
      authority: context.authority, contract: selected.contract, signal: new AbortController().signal,
    });
    await Bun.sleep(0);
    const cancelled = new AbortController();
    const second = selected.execute({ target: projection.target, tab: projection.tabs[0]!.target }, {
      authority: context.authority, contract: selected.contract, signal: cancelled.signal,
    });
    await Bun.sleep(0);
    expect(client.calls.filter((call) => call.name === "get_browser_state" && call.argumentsValue["tab_id"] === "tab-a")).toHaveLength(1);
    cancelled.abort();
    expect(await second).toMatchObject({ settlement: "cancelled" });
    expect(client.calls.filter((call) => call.name === "get_browser_state" && call.argumentsValue["tab_id"] === "tab-a")).toHaveLength(1);
    client.release("tab-a");
    expect(await first).toMatchObject({ settlement: "completed", result: { status: "observed" } });
  });

  test("allows different-tab reads to overlap while a mutation waits for all active observations", async () => {
    const client = new CoordinatedBrowserCua();
    const runtime = new CuaBrowserRuntime({ client, randomBytes: deterministicRandom() });
    runtime.targets.registerWindow(nativeWindow, { pid: 4242, windowId: 77 }, context.authority);
    const bound = await execute(runtime, "browser.bind_window", { window: nativeWindow });
    const projection = bound.result as unknown as {
      target: Readonly<Record<string, ComputerUseJson>>;
      tabs: Array<{ target: Readonly<Record<string, ComputerUseJson>> }>;
    };
    const readA = execute(runtime, "browser.read_page", { target: projection.target, tab: projection.tabs[0]!.target });
    const readB = execute(runtime, "browser.read_page", { target: projection.target, tab: projection.tabs[1]!.target });
    await Bun.sleep(0);
    expect(client.calls.filter((call) => call.name === "get_browser_state" && call.argumentsValue["tab_id"] !== undefined)).toHaveLength(2);
    const navigation = execute(runtime, "browser.navigate", {
      target: projection.target, tab: projection.tabs[0]!.target, url: "https://next.example/",
    });
    await Bun.sleep(0);
    expect(client.calls.some((call) => call.name === "browser_navigate")).toBe(false);
    client.release("tab-a");
    await readA;
    expect(client.calls.some((call) => call.name === "browser_navigate")).toBe(false);
    client.release("tab-b");
    await readB;
    expect(await navigation).toMatchObject({ settlement: "completed" });
    expect(client.calls.at(-1)?.name).toBe("browser_navigate");
  });

  test("revocation immediately fences retained fast binds and cannot be revived", async () => {
    const client = new FakeCua([ok({ status: "ok" }), binding()]);
    const bound = await boundRuntime(client);
    const before = client.calls.length;
    bound.runtime.revoke();
    expect(await execute(bound.runtime, "browser.bind_window", { window: nativeWindow }))
      .toMatchObject({ settlement: "not_completed", result: { recovery: "observe_again" } });
    expect(await execute(bound.runtime, "browser.read_page", { target: bound.target, tab: bound.tab }))
      .toMatchObject({ settlement: "not_completed", result: { recovery: "observe_again" } });
    expect(client.calls).toHaveLength(before);
  });

  test("revocation fences queued reads before dispatch without disturbing the draining sibling", async () => {
    const client = new CoordinatedBrowserCua();
    const runtime = new CuaBrowserRuntime({ client, randomBytes: deterministicRandom() });
    runtime.targets.registerWindow(nativeWindow, { pid: 4242, windowId: 77 }, context.authority);
    const bound = await execute(runtime, "browser.bind_window", { window: nativeWindow });
    const projection = bound.result as unknown as {
      target: Readonly<Record<string, ComputerUseJson>>;
      tabs: Array<{ target: Readonly<Record<string, ComputerUseJson>> }>;
    };
    const first = execute(runtime, "browser.read_page", { target: projection.target, tab: projection.tabs[0]!.target });
    const queued = execute(runtime, "browser.read_page", { target: projection.target, tab: projection.tabs[0]!.target });
    await Bun.sleep(0);
    runtime.revoke();
    client.release("tab-a");
    expect(await first).toMatchObject({ settlement: "not_completed" });
    expect(await queued).toMatchObject({ settlement: "not_completed" });
    expect(client.calls.filter((call) => call.name === "get_browser_state" && call.argumentsValue["tab_id"] === "tab-a")).toHaveLength(1);
  });

  test("a deferred bind cannot publish a context after synchronous revocation", async () => {
    const client = new DeferredBindCua();
    const runtime = new CuaBrowserRuntime({ client, randomBytes: deterministicRandom() });
    runtime.targets.registerWindow(nativeWindow, { pid: 4242, windowId: 77 }, context.authority);
    const pending = execute(runtime, "browser.bind_window", { window: nativeWindow });
    await Bun.sleep(0);
    expect(client.calls).toEqual(["start_session", "get_browser_state"]);
    runtime.revoke();
    client.resolveBinding(binding());
    expect(await pending).toMatchObject({ settlement: "not_completed", result: { recovery: "observe_again" } });
    expect(client.calls).toEqual(["start_session", "get_browser_state", "end_session"]);
    expect(await execute(runtime, "browser.bind_window", { window: nativeWindow }))
      .toMatchObject({ settlement: "not_completed" });
    expect(client.calls).toHaveLength(3);
  });

  test("a deferred preparation cannot continue into binding or publish after revocation", async () => {
    const client = new DeferredPrepareCua();
    const runtime = new CuaBrowserRuntime({ client, randomBytes: deterministicRandom() });
    runtime.targets.registerWindow(nativeWindow, { pid: 4242, windowId: 77 }, context.authority);
    const pending = execute(runtime, "browser.prepare", { window: nativeWindow });
    await Bun.sleep(0);
    expect(client.calls).toEqual(["start_session", "browser_prepare"]);
    runtime.revoke();
    client.resolvePrepared(prepared());
    expect(await pending).toMatchObject({ settlement: "unknown_completion", result: {
      status: "unknown_completion", doNotReplay: true,
      failure: { reason: "authority_revoked", stage: "prepare", retryCondition: "inspect_effects_before_continuing" },
    } });
    expect(client.calls).toEqual(["start_session", "browser_prepare", "end_session"]);
    expect(await execute(runtime, "browser.prepare", { window: nativeWindow }))
      .toMatchObject({ settlement: "not_completed" });
    expect(client.calls).toHaveLength(3);
  });
});
