import { describe, expect, spyOn, test } from "bun:test";
import { DISPATCH_DEFAULT_TIMEOUT_MS, type RelayLocalExecutionBindingV1, type RelayServerMessage } from "@nautilo/relay";
import { InMemoryRelayRegistry } from "../../src/relay-registry";
const NATIVE_TIMER_MAX = 2 ** 31 - 1;
async function fixture() {
  const registry = new InMemoryRelayRegistry(); const sent: RelayServerMessage[] = [];
  await registry.register("relay-fixture", "human-fixture", { profile: "desktop-agent", canExecuteLocal: true,
    localExecution: { version: 1, generation: "generation-fixture", pipe: true, pty: true, localNetworkPolicy: true, capacity: 1 } },
    message => sent.push(message), 29, "desktop-fixture", 1, "pairing-fixture");
  const binding: RelayLocalExecutionBindingV1 = { version: 1, localNetworkPolicy: { mode: "host" }, generation: "generation-fixture", executionId: "execution-fixture",
    invocationId: "call-fixture", operation: "start", owner: { instanceId: "instance-fixture", humanUserId: "human-fixture",
      agentId: "agent-fixture", runId: "run-fixture", conversationId: "conversation-fixture", relayId: "relay-fixture",
      desktopSessionId: "desktop-fixture", pairingGeneration: registry.getLocalExecutionPairingGeneration("relay-fixture")!,
      serverBindingId: "server-fixture", profileId: null, profileRevision: null, grantIds: [], grantRevision: null, protectedPolicyVersion: null } };
  const request = { toolName: "exec_command", args: { cmd: "echo fixture" }, impact: "destructive" as const,
    approvalObtained: true, localExecutionBinding: binding };
  return { registry, sent, binding, request };
}
function fakeTimers() {
  const timers: { delay: number; cancelled: boolean; fire: () => void }[] = [];
  const set = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number) => {
    const timer = { delay: delay ?? 0, cancelled: false, fire: callback }; timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(timer => {
    const candidate = timers.find(entry => entry === timer as unknown); if (candidate) candidate.cancelled = true;
  });
  return { timers, restore: () => { set.mockRestore(); clear.mockRestore(); } };
}
function startFrame(sent: RelayServerMessage[]) {
  const frame = sent.find(message => message.type === "relay:dispatch");
  if (frame?.type !== "relay:dispatch") throw new Error("missing fixture dispatch"); return frame;
}

describe("managed Relay observation response waits", () => {
  test("long yield retains the existing transport and raw receipt budgets, without changing the wire", async () => {
    const f = await fixture(); const clock = fakeTimers();
    try {
      const pending = f.registry.dispatch("relay-fixture", { ...f.request, args: { cmd: "echo fixture", yield_time_ms: 90000 } });
      expect(clock.timers[0]!.delay).toBe(90000 + DISPATCH_DEFAULT_TIMEOUT_MS + 5000);
      const frame = startFrame(f.sent); expect(frame.args["yield_time_ms"]).toBe(90000); expect(frame.timeout).toBeUndefined();
      f.registry.resolveDispatch(frame.correlationId, { status: "ok", result: { state: "running", resources: "owned" } });
      expect(await pending).toMatchObject({ status: "ok" }); expect(clock.timers[0]!.cancelled).toBe(true);
      expect(f.sent).toHaveLength(1);
    } finally { await f.registry.unregister("relay-fixture"); clock.restore(); }
  });
  test("maximum valid yield uses native-sized segments and response expiry never cancels execution", async () => {
    const f = await fixture(); const clock = fakeTimers(); const owner = new AbortController();
    try {
      const pending = f.registry.dispatch("relay-fixture", { ...f.request, signal: owner.signal,
        args: { cmd: "echo fixture", yield_time_ms: NATIVE_TIMER_MAX } }).catch((error: unknown) => error);
      let settled = false; void pending.then(() => { settled = true; });
      expect(clock.timers[0]!.delay).toBe(NATIVE_TIMER_MAX); clock.timers[0]!.fire(); await Promise.resolve();
      expect(settled).toBe(false); expect(clock.timers[1]!.delay).toBe(DISPATCH_DEFAULT_TIMEOUT_MS + 5000);
      expect(clock.timers.every(timer => timer.delay <= NATIVE_TIMER_MAX)).toBe(true);
      clock.timers[1]!.fire(); expect(await pending).toMatchObject({ runShellOutcome: "unknown", reason: "timeout" });
      expect(f.sent).toHaveLength(1); expect(owner.signal.aborted).toBe(false);
      owner.abort(); expect(f.sent.at(-1)).toMatchObject({ type: "relay:dispatch", localExecutionBinding: { operation: "cancel" } });
    } finally { await f.registry.unregister("relay-fixture"); clock.restore(); }
  });
  test("a read reserves its intentional wait plus the existing response budget", async () => {
    const f = await fixture(); const clock = fakeTimers();
    try {
      const started = f.registry.dispatch("relay-fixture", f.request);
      f.registry.resolveDispatch(startFrame(f.sent).correlationId, { status: "ok", result: { state: "running", resources: "owned" } }); await started;
      const pending = f.registry.dispatch("relay-fixture", { ...f.request, toolName: "write_stdin",
        args: { session_id: f.binding.executionId, yield_time_ms: 90000 },
        localExecutionBinding: { ...f.binding, invocationId: "read-fixture", operation: "read" } });
      expect(clock.timers[1]!.delay).toBe(90000 + DISPATCH_DEFAULT_TIMEOUT_MS);
      const frame = f.sent.at(-1); if (frame?.type !== "relay:dispatch") throw new Error("missing fixture read");
      f.registry.resolveDispatch(frame.correlationId, { status: "ok" }); await pending;
    } finally { await f.registry.unregister("relay-fixture"); clock.restore(); }
  });
  test("cancel replaces a segmented wait with the existing receipt grace and fences late timer callbacks", async () => {
    const f = await fixture(); const clock = fakeTimers(); const owner = new AbortController();
    try {
      const pending = f.registry.dispatch("relay-fixture", { ...f.request, signal: owner.signal,
        args: { cmd: "echo fixture", yield_time_ms: NATIVE_TIMER_MAX } });
      const frame = startFrame(f.sent); owner.abort();
      expect(clock.timers[0]!.cancelled).toBe(true); expect(clock.timers[1]!.delay).toBe(5000);
      clock.timers[0]!.fire(); expect(clock.timers).toHaveLength(2);
      f.registry.resolveDispatch(frame.correlationId, { status: "ok", result: { state: "cancelled", resources: "released" } });
      await pending; expect(clock.timers[1]!.cancelled).toBe(true);
    } finally { await f.registry.unregister("relay-fixture"); clock.restore(); }
  });
  test("a receipt clears the current timer segment, including an explicit maximum response budget", async () => {
    const f = await fixture(); const clock = fakeTimers();
    try {
      const pending = f.registry.dispatch("relay-fixture", { ...f.request, timeout: NATIVE_TIMER_MAX,
        args: { cmd: "echo fixture", yield_time_ms: NATIVE_TIMER_MAX } });
      expect(clock.timers[0]!.delay).toBe(NATIVE_TIMER_MAX); clock.timers[0]!.fire();
      expect(clock.timers[1]!.delay).toBe(NATIVE_TIMER_MAX); clock.timers[1]!.fire();
      expect(clock.timers[2]!.delay).toBe(5000);
      f.registry.resolveDispatch(startFrame(f.sent).correlationId, { status: "ok" }); await pending;
      expect(clock.timers[2]!.cancelled).toBe(true); clock.timers[2]!.fire();
      expect(clock.timers).toHaveLength(3); expect(f.sent).toHaveLength(1);
    } finally { await f.registry.unregister("relay-fixture"); clock.restore(); }
  });
  test("malformed waits fail before sending or consuming the retained identity capacity", async () => {
    const f = await fixture(); const clock = fakeTimers();
    try {
      for (const value of [-1, 0.5, NaN, Infinity, NATIVE_TIMER_MAX + 1, "90000", null]) {
        const failure = await f.registry.dispatch("relay-fixture", { ...f.request, args: { cmd: "echo fixture", yield_time_ms: value } }).catch((error: unknown) => error);
        expect(failure).toMatchObject({ message: "LOCAL_EXECUTION_RESPONSE_WAIT_INVALID" });
      }
      for (const timeout of [-1, 0.5, NaN, Infinity, NATIVE_TIMER_MAX + 1]) {
        const failure = await f.registry.dispatch("relay-fixture", { ...f.request, timeout }).catch((error: unknown) => error);
        expect(failure).toMatchObject({ message: "LOCAL_EXECUTION_RESPONSE_WAIT_INVALID" });
      }
      expect(f.sent).toHaveLength(0);
      const pending = f.registry.dispatch("relay-fixture", f.request); expect(clock.timers[0]!.delay).toBe(DISPATCH_DEFAULT_TIMEOUT_MS + 5000);
      f.registry.resolveDispatch(startFrame(f.sent).correlationId, { status: "ok" }); await pending;
    } finally { await f.registry.unregister("relay-fixture"); clock.restore(); }
  });
  test("ordinary tool deadlines keep their existing response budget even if args contain yield_time_ms", async () => {
    const f = await fixture(); const clock = fakeTimers();
    try {
      const pending = f.registry.dispatch("relay-fixture", { toolName: "ordinary-fixture", args: { yield_time_ms: NATIVE_TIMER_MAX },
        impact: "read-only", approvalObtained: true });
      expect(clock.timers[0]!.delay).toBe(DISPATCH_DEFAULT_TIMEOUT_MS);
      f.registry.resolveDispatch(startFrame(f.sent).correlationId, { status: "ok" }); await pending;
    } finally { await f.registry.unregister("relay-fixture"); clock.restore(); }
  });
});
