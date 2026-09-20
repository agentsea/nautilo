import { expect, test } from "bun:test";
import type { ConnectedWebOperationToolActorContext } from "@nautilo/agent";
import { ConnectedWebOperationDirectRuntime } from "../../src/connected-web-accounts/operation-direct-runtime";
import type { DirectBrowserRouterLease } from "../../src/connected-web-accounts/direct-browser-router";
import type { ConnectedWebOperation } from "../../src/connected-web-accounts/store";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const ROOM = "44444444-4444-4444-8444-444444444444";
const OP = "55555555-5555-4555-8555-555555555555";

function operation(overrides: Partial<ConnectedWebOperation> = {}): ConnectedWebOperation {
  return { id: OP, ownerUserId: OWNER, accountId: ACCOUNT, initiatingAgentId: AGENT, initiatingRoomId: ROOM,
    initiatingThreadId: "thread", initiatingLane: "lane", driver: "hosted", lifecycle: "running", controlEpoch: 7,
    actionOperationId: null, effectIdempotencyKey: null,
    safeActivity: { version: 1, phase: "working", code: "hosted", summary: "Hosted work." }, terminalReceipt: null,
    ...overrides } as ConnectedWebOperation;
}
function actor(overrides: Partial<ConnectedWebOperationToolActorContext> = {}): ConnectedWebOperationToolActorContext {
  return { userId: OWNER, agentId: AGENT, roomId: ROOM, callingRoomId: null, memoryAccessEnvelope: {} as never,
    toolCallId: "call", currentThreadId: "thread", turnId: "turn", laneKey: "lane", ...overrides };
}

test("direct control rechecks operation authority before opening or issuing commands", async () => {
  let admitted = true;
  let current = operation();
  let commands = 0;
  const runtime = new ConnectedWebOperationDirectRuntime({
    authorizeOperation: () => admitted,
    facts: { hasExactOwnedGenie: async () => true, isOwnersPersonalPrivateRoom: async () => true },
    store: { getOperationForOwner: async () => current, recordDirectOperationActivity: async () => true },
    router: { acquire: async () => {
      current = operation({ driver: "direct", controlEpoch: 8 });
      return { invoke: async () => { commands++; return { text: "observed", truncated: false }; } };
    } } as never,
  });
  expect(await runtime.takeControl(actor(), { operationId: OP, expectedControlEpoch: 7 })).toMatchObject({ driver: "direct" });
  admitted = false;
  expect(await runtime.control(actor(), { operationId: OP, expectedControlEpoch: 8, command: { kind: "click", ref: "e1" } })).toMatchObject({ ok: false, code: "forbidden" });
  expect(commands).toBe(0);
});

test("decision control keeps observation authority private, forwards cancellation, and never replays an action", async () => {
  let current = operation();
  const calls: string[] = [];
  let receivedSignal: AbortSignal | undefined;
  const lease = {
    observeDecision: async (signal?: AbortSignal) => {
      receivedSignal = signal;
      calls.push("observe");
      return { version: 1 as const, snapshot: '- button "Continue" [ref=e1]',
        refs: { e1: { role: "button", name: "Continue" } }, pageUrl: "https://example.test/",
        browserSessionId: "opaque", observationId: "observation" };
    },
    invokeDecision: async (_command: unknown, observationId: string) => {
      calls.push(`act:${observationId}`);
      return { text: "clicked", truncated: false };
    },
    close: async () => ({ browser: "stopped", directories: "released", operation: "released" }),
  } as unknown as DirectBrowserRouterLease;
  const runtime = new ConnectedWebOperationDirectRuntime({ authorizeOperation: () => true,
    facts: { hasExactOwnedGenie: async () => true, isOwnersPersonalPrivateRoom: async () => true },
    store: { getOperationForOwner: async () => current, recordDirectOperationActivity: async () => true },
    router: { acquire: async () => { current = operation({ driver: "direct", controlEpoch: 8 }); return lease; } } as never });
  await runtime.takeControl(actor(), { operationId: OP, expectedControlEpoch: 7 });
  const controller = new AbortController();
  const observed = await runtime.control(actor(), { operationId: OP, expectedControlEpoch: 8, command: { kind: "snapshot" } },
    { signal: controller.signal, decision: { kind: "observe" } });
  expect(observed).toMatchObject({ ok: true, observation: { observationId: "observation", refs: { e1: { name: "Continue" } } } });
  expect(receivedSignal).toBe(controller.signal);
  expect(await runtime.control(actor(), { operationId: OP, expectedControlEpoch: 8, command: { kind: "click", ref: "@e1" } },
    { decision: { kind: "act", observationId: "observation" } })).toMatchObject({ ok: true, command: { text: "clicked" } });
  controller.abort();
  expect(await runtime.control(actor(), { operationId: OP, expectedControlEpoch: 8, command: { kind: "click", ref: "@e1" } },
    { signal: controller.signal, decision: { kind: "act", observationId: "observation" } })).toMatchObject({ ok: false, browserFailure: "browser_cancelled" });
  expect(calls).toEqual(["observe", "act:observation"]);
});

test("direct runtime authorizes exactly, reuses one lease serially, and never silently reacquires", async () => {
  let current = operation();
  const invoked: string[] = [];
  const acquisitions: unknown[] = [];
  const activities: unknown[] = [];
  let closes = 0;
  const lease = {
    invoke: async (input: { toolName: string }) => { invoked.push(input.toolName); return { text: "page https://example.test", truncated: false }; },
    ownerLiveViewUrl: () => "https://live.browser-use.com/?opaque",
    close: async () => { closes += 1; current = operation({ driver: "checking", lifecycle: "attention", controlEpoch: 8 }); return { browser: "stopped", directories: "released", operation: "released" }; },
  } as unknown as DirectBrowserRouterLease;
  const router = { acquire: async (input: unknown) => { acquisitions.push(input); current = operation({ driver: "direct", controlEpoch: 8, safeActivity: { version: 1, phase: "working", code: "direct", summary: "Direct." } }); return lease; } };
  const runtime = new ConnectedWebOperationDirectRuntime({ authorizeOperation: () => true,
    facts: { hasExactOwnedGenie: async () => true, isOwnersPersonalPrivateRoom: async () => true },
    store: {
      getOperationForOwner: async () => current,
      recordDirectOperationActivity: async (input) => { activities.push(input); return true; },
    }, router: router as never,
  });
  expect(await runtime.takeControl(actor(), { operationId: OP, expectedControlEpoch: 7 })).toMatchObject({ driver: "direct", controlEpoch: 8 });
  expect(acquisitions).toEqual([expect.objectContaining({
    ownerUserId: OWNER,
    accountId: ACCOUNT,
    operationId: OP,
    expectedControlEpoch: 7,
    source: "saved_profile",
  })]);
  const [first, second] = await Promise.all([
    runtime.control(actor(), { operationId: OP, expectedControlEpoch: 8, command: { kind: "snapshot" } }),
    runtime.control(actor(), { operationId: OP, expectedControlEpoch: 8, command: { kind: "read", ref: "@e1" } }),
  ]);
  expect(first).toMatchObject({ ok: true, command: { text: "page https://example.test" } });
  expect(second).toMatchObject({ ok: true });
  expect(invoked).toEqual(["browser_snapshot", "browser_read"]);
  expect(activities).toEqual([
    expect.objectContaining({ expectedControlEpoch: 8, safeActivity: { version: 1, phase: "working", code: "direct_page_inspected", summary: "Moxie inspected the connected website." } }),
    expect.objectContaining({ expectedControlEpoch: 8, safeActivity: { version: 1, phase: "working", code: "direct_page_inspected", summary: "Moxie inspected the connected website." } }),
  ]);
  expect(JSON.stringify(activities)).not.toContain("@e1");
  expect(await runtime.ownerControls({ ownerUserId: OWNER, operationId: OP })).toMatchObject({
    operation: { driver: "direct", controlEpoch: 8 }, liveViewUrl: "https://live.browser-use.com/?opaque",
  });
  expect(await runtime.control(actor({ agentId: "other" }), { operationId: OP, expectedControlEpoch: 8, command: { kind: "snapshot" } })).toMatchObject({ ok: false, code: "forbidden" });
  expect(await runtime.release(actor(), { operationId: OP, expectedControlEpoch: 8 })).toMatchObject({ driver: "checking" });
  expect(closes).toBe(1);
  expect(await runtime.control(actor(), { operationId: OP, expectedControlEpoch: 8, command: { kind: "snapshot" } })).toMatchObject({ ok: false, code: "conflict" });
});

test("direct runtime closes the exact lease once on command failure and refuses a stale epoch", async () => {
  let current = operation({ driver: "direct", controlEpoch: 8 });
  let closes = 0;
  const lease = { invoke: async () => { throw new Error("broken"); }, close: async () => { closes += 1; return { browser: "stopped", directories: "released", operation: "released" }; } } as unknown as DirectBrowserRouterLease;
  const runtime = new ConnectedWebOperationDirectRuntime({ authorizeOperation: () => true, facts: { hasExactOwnedGenie: async () => true, isOwnersPersonalPrivateRoom: async () => true },
    store: { getOperationForOwner: async () => current, recordDirectOperationActivity: async () => true }, router: { acquire: async () => lease } as never });
  // Bootstrap only through take-control; a direct row after restart has no lease.
  expect(await runtime.control(actor(), { operationId: OP, expectedControlEpoch: 8, command: { kind: "snapshot" } })).toMatchObject({ ok: false, code: "unavailable" });
  current = operation();
  await runtime.takeControl(actor(), { operationId: OP, expectedControlEpoch: 7 });
  current = operation({ driver: "direct", controlEpoch: 8 });
  expect(await runtime.control(actor(), { operationId: OP, expectedControlEpoch: 7, command: { kind: "snapshot" } })).toMatchObject({ ok: false, code: "forbidden" });
  expect(await runtime.control(actor(), { operationId: OP, expectedControlEpoch: 8, command: { kind: "snapshot" } })).toMatchObject({ ok: false, code: "unavailable" });
  expect(closes).toBe(1);
});

test("direct runtime never admits a confirmed action operation into approval-free browser control", async () => {
  let acquires = 0;
  const runtime = new ConnectedWebOperationDirectRuntime({ authorizeOperation: () => true,
    facts: { hasExactOwnedGenie: async () => true, isOwnersPersonalPrivateRoom: async () => true },
    store: {
      getOperationForOwner: async () => operation({
        actionOperationId: "77777777-7777-4777-8777-777777777777",
        effectIdempotencyKey: "effect-private",
      }),
      recordDirectOperationActivity: async () => true,
    },
    router: { acquire: async () => { acquires += 1; throw new Error("must not acquire"); } } as never,
  });

  expect(await runtime.takeControl(actor(), { operationId: OP, expectedControlEpoch: 7 })).toBeNull();
  expect(acquires).toBe(0);
});

test("direct runtime keeps every control verb unavailable when startup recovery cannot inventory durable leases", async () => {
  const runtime = new ConnectedWebOperationDirectRuntime({ authorizeOperation: () => true,
    facts: { hasExactOwnedGenie: async () => true, isOwnersPersonalPrivateRoom: async () => true },
    store: { getOperationForOwner: async () => operation(), recordDirectOperationActivity: async () => true },
    router: { acquire: async () => { throw new Error("must not acquire"); } } as never,
    recover: async () => { throw new Error("database unavailable"); },
  });

  await runtime.recover();
  expect(await runtime.preflight()).toBe(false);
  expect(await runtime.takeControl(actor(), { operationId: OP, expectedControlEpoch: 7 })).toBeNull();
  expect(await runtime.control(actor(), {
    operationId: OP,
    expectedControlEpoch: 7,
    command: { kind: "snapshot" },
  })).toEqual({ ok: false, code: "unavailable", recovery: "none" });
});

test("direct preflight rechecks the executable without acquiring a browser", async () => {
  let available = false;
  const runtime = new ConnectedWebOperationDirectRuntime({ authorizeOperation: () => true,
    facts: { hasExactOwnedGenie: async () => true, isOwnersPersonalPrivateRoom: async () => true },
    store: { getOperationForOwner: async () => operation(), recordDirectOperationActivity: async () => true },
    router: { acquire: async () => { throw new Error("must not acquire"); } } as never,
    checkAvailability: async () => { if (!available) throw new Error("binary missing"); },
  });
  expect(await runtime.preflight()).toBe(false);
  available = true;
  expect(await runtime.preflight()).toBe(true);
  available = false;
  expect(await runtime.preflight()).toBe(false);
});

test("direct activity is informative without recording command arguments", async () => {
  let current = operation({ driver: "direct", controlEpoch: 8 });
  const activities: unknown[] = [];
  const commands: unknown[] = [];
  const lease = {
    invoke: async (input: unknown) => { commands.push(input); return { text: "ok", truncated: false }; },
    ownerLiveViewUrl: () => null,
    close: async () => ({ browser: "stopped" as const, directories: "released" as const, operation: "released" as const }),
  } as unknown as DirectBrowserRouterLease;
  const runtime = new ConnectedWebOperationDirectRuntime({ authorizeOperation: () => true,
    facts: { hasExactOwnedGenie: async () => true, isOwnersPersonalPrivateRoom: async () => true },
    store: {
      getOperationForOwner: async () => current,
      recordDirectOperationActivity: async (input) => { activities.push(input.safeActivity); return true; },
    },
    router: { acquire: async () => { current = operation({ driver: "direct", controlEpoch: 8 }); return lease; } } as never,
  });
  current = operation();
  await runtime.takeControl(actor(), { operationId: OP, expectedControlEpoch: 7 });
  for (const command of [
    { kind: "click", ref: "@private" }, { kind: "double_click", ref: "@private" }, { kind: "hover", ref: "@private" },
    { kind: "drag", from: "@private", to: "@private" }, { kind: "select", ref: "@private", values: ["private"] },
    { kind: "set_checked", ref: "@private", checked: true }, { kind: "press", key: "PrivateKey", ref: "@private" },
    { kind: "scroll_into_view", ref: "@private" },
  ] as const) {
    await runtime.control(actor(), { operationId: OP, expectedControlEpoch: 8, command });
  }
  expect(activities).toEqual([
    expect.objectContaining({ code: "direct_item_clicked" }),
    expect.objectContaining({ code: "direct_item_double_clicked" }),
    expect.objectContaining({ code: "direct_item_hovered" }),
    expect.objectContaining({ code: "direct_item_dragged" }),
    expect.objectContaining({ code: "direct_option_selected" }),
    expect.objectContaining({ code: "direct_option_checked" }),
    expect.objectContaining({ code: "direct_key_pressed" }),
    expect.objectContaining({ code: "direct_item_scrolled_into_view" }),
  ]);
  expect(JSON.stringify(activities)).not.toContain("private");
  expect(JSON.stringify(activities)).not.toContain("PrivateKey");
  expect(commands).toContainEqual({ toolName: "browser_press", args: { key: "PrivateKey", ref: "@private" } });
});

test("owner Stop retains an unresolved lease for exact cleanup retry without allowing more commands", async () => {
  let current = operation();
  let closes = 0;
  const lease = {
    invoke: async () => ({ text: "unused", truncated: false }),
    ownerLiveViewUrl: () => "https://live.browser-use.com/?opaque",
    cleanupControlEpoch: () => current.controlEpoch,
    close: async () => {
      closes += 1;
      if (closes > 1) {
        current = operation({ driver: "checking", lifecycle: "attention", controlEpoch: 10 });
        return { browser: "stopped", directories: "released", operation: "released" };
      }
      current = operation({
        driver: "direct", lifecycle: "attention", controlEpoch: 9,
        safeActivity: {
          version: 1, phase: "attention", code: "direct_browser_cleanup_unresolved",
          summary: "Connected website browser cleanup needs recovery before another writer can start.",
        },
      });
      return { browser: "cleanup_unresolved" as const, directories: "cleanup_unresolved" as const, operation: "recovery_fenced" as const };
    },
  } as unknown as DirectBrowserRouterLease;
  const runtime = new ConnectedWebOperationDirectRuntime({ authorizeOperation: () => true,
    facts: { hasExactOwnedGenie: async () => true, isOwnersPersonalPrivateRoom: async () => true },
    store: {
      getOperationForOwner: async (input) => {
        if (input.ownerUserId !== OWNER || input.operationId !== OP) throw new Error("not found");
        return current;
      },
      recordDirectOperationActivity: async () => true,
    },
    router: { acquire: async () => { current = operation({ driver: "direct", controlEpoch: 8 }); return lease; } } as never,
  });
  expect(await runtime.takeControl(actor(), { operationId: OP, expectedControlEpoch: 7 })).toMatchObject({ driver: "direct", controlEpoch: 8 });
  expect(await runtime.ownerControls({ ownerUserId: OWNER, operationId: OP })).toMatchObject({
    operation: { driver: "direct", lifecycle: "running", controlEpoch: 8 }, liveViewUrl: "https://live.browser-use.com/?opaque",
  });

  expect(await runtime.stopForOwner({ ownerUserId: OWNER, operationId: OP })).toMatchObject({
    driver: "direct", lifecycle: "attention", controlEpoch: 9,
    safeActivity: { code: "direct_browser_cleanup_unresolved" },
  });
  expect(closes).toBe(1);
  expect(await runtime.ownerControls({ ownerUserId: OWNER, operationId: OP })).toMatchObject({ liveViewUrl: null });
  expect(await runtime.control(actor(), { operationId: OP, expectedControlEpoch: 9, command: { kind: "snapshot" } })).toMatchObject({ ok: false });
  expect(await runtime.stopForOwner({ ownerUserId: "foreign-owner", operationId: OP })).toBeNull();
  expect(await runtime.stopForOwner({ ownerUserId: OWNER, operationId: OP })).toMatchObject({ driver: "checking" });
  current = operation({ driver: "direct", lifecycle: "running", controlEpoch: 10 });
  expect(await runtime.stopForOwner({ ownerUserId: OWNER, operationId: OP })).toBeNull();
  expect(closes).toBe(2);
});

test("owner can retry orphan cleanup without reacquiring, watching, or clearing an uncertain fence", async () => {
  let current = operation({ driver: "direct", controlEpoch: 9, lifecycle: "attention", sealedProviderRefs: { version: 1, browserRef: "sealed" } });
  let calls = 0;
  let finish!: (ok: boolean) => void;
  let recovery = new Promise<boolean>((resolve) => { finish = resolve; });
  const runtime = new ConnectedWebOperationDirectRuntime({ authorizeOperation: () => true,
    facts: { hasExactOwnedGenie: async () => true, isOwnersPersonalPrivateRoom: async () => true },
    store: { getOperationForOwner: async () => current, recordDirectOperationActivity: async () => true },
    router: { acquire: async () => { throw new Error("must not acquire"); } } as never,
    recoverOperation: async () => { calls += 1; const ok = await recovery; if (ok) current = { ...current, driver: "checking", controlEpoch: 10 }; return ok; },
  });
  const input = { ownerUserId: OWNER, operationId: OP };
  expect(await runtime.ownerControls(input)).toMatchObject({ liveViewUrl: null, operation: { controlEpoch: 9 } });
  expect(await runtime.stopForOwner({ ...input, ownerUserId: "another-owner" })).toBeNull();
  const first = runtime.stopForOwner(input);
  const duplicate = runtime.stopForOwner(input);
  finish(false);
  expect(await first).toMatchObject({ driver: "direct", controlEpoch: 9 });
  await duplicate;
  expect(calls).toBe(1);
  expect(await runtime.ownerControls(input)).not.toBeNull();
  recovery = Promise.resolve(true);
  expect(await runtime.stopForOwner(input)).toMatchObject({ driver: "checking", controlEpoch: 10 });
  expect(calls).toBe(2);
});

test("owner Stop waits for in-flight admission and closes its real lease instead of treating it as orphaned", async () => {
  let current = operation();
  let finish!: () => void;
  const setup = new Promise<void>((resolve) => { finish = resolve; });
  let entered!: () => void;
  const enteredSetup = new Promise<void>((resolve) => { entered = resolve; });
  let closes = 0;
  const runtime = new ConnectedWebOperationDirectRuntime({ authorizeOperation: () => true,
    facts: { hasExactOwnedGenie: async () => true, isOwnersPersonalPrivateRoom: async () => true },
    store: { getOperationForOwner: async () => current, recordDirectOperationActivity: async () => true },
    router: { acquire: async () => {
      current = operation({ driver: "direct", controlEpoch: 8 });
      entered();
      await setup;
      return { close: async () => { closes += 1; current = operation({ driver: "checking", controlEpoch: 9 }); return { operation: "released" }; } };
    } } as never,
    recoverOperation: async () => { throw new Error("must wait for admission"); },
  });
  const acquiring = runtime.takeControl(actor(), { operationId: OP, expectedControlEpoch: 7 });
  await enteredSetup;
  const stopping = runtime.stopForOwner({ ownerUserId: OWNER, operationId: OP });
  expect(closes).toBe(0);
  finish();
  await acquiring;
  expect(await stopping).toMatchObject({ driver: "checking", controlEpoch: 9 });
  expect(closes).toBe(1);
});

test("ordinary connected navigation automatically returns fresh observation without a decision model", async () => {
  let current = operation();
  const calls: string[] = [];
  const observation = { version: 1, snapshot: "- searchbox Keywords [ref=e9]", refs: { e9: { role: "searchbox", name: "Keywords" } },
    pageUrl: "https://example.test/", browserSessionId: "owned", observationId: "fresh" };
  const runtime = new ConnectedWebOperationDirectRuntime({ authorizeOperation: () => true,
    facts: { hasExactOwnedGenie: async () => true, isOwnersPersonalPrivateRoom: async () => true },
    store: { getOperationForOwner: async () => current, recordDirectOperationActivity: async () => true },
    router: { acquire: async () => { current = operation({ driver: "direct", controlEpoch: 8 }); return {
      invoke: async () => { calls.push("navigate"); return { text: "opened", truncated: false }; },
      observeDecision: async () => { calls.push("observe"); return observation; },
    }; } } as never });
  await runtime.takeControl(actor(), { operationId: OP, expectedControlEpoch: 7 });
  expect(await runtime.control(actor(), { operationId: OP, expectedControlEpoch: 8, command: { kind: "open", url: "https://example.test/" } }))
    .toMatchObject({ ok: true, command: { text: "opened" }, observation });
  expect(calls).toEqual(["navigate", "observe"]);
});
