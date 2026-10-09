import { expect, spyOn, test } from "bun:test";
import { RELAY_DELEGATED_LOCAL_EXECUTION_PROTOCOL_VERSION, RELAY_LOCAL_EXECUTION_NETWORK_POLICY_PROTOCOL_VERSION,
  type RelayLocalExecutionDelegationCapture, type RelayServerMessage } from "@nautilo/relay";
import { InMemoryRelayRegistry } from "@nautilo/runtime";
import { resolveTaskLocalExecutionCaptureTarget } from "../../src/local-execution-task-capture";

async function fixture() {
  const registry = new InMemoryRelayRegistry();
  const sent: RelayServerMessage[] = [];
  const caps = { profile: "desktop-agent" as const, canExecuteLocal: true, canDelegateLocalExecution: true,
    localExecution: { version: 1 as const, generation: "host-generation", pipe: true as const, pty: true,
      localNetworkPolicy: true as const, capacity: 2 } };
  let duringDispatch: () => void = () => {};
  await registry.register("relay", "human", caps, message => {
    sent.push(message);
    if (message.type === "relay:dispatch") {
      duringDispatch();
      registry.resolveDispatch(message.correlationId, { status: "ok", result: { captured: true } });
    }
  }, RELAY_LOCAL_EXECUTION_NETWORK_POLICY_PROTOCOL_VERSION, "desktop", 1, "raw-pairing-row");
  const context = { relayId: "relay", relaySessionId: registry.getRelaySessionId("relay")!,
    desktopSessionId: "desktop", pairingGeneration: "raw-pairing-row" };
  const target = () => resolveTaskLocalExecutionCaptureTarget(context, "human", registry);
  return { registry, context, sent, target, duringDispatch: (callback: () => void) => { duringDispatch = callback; } };
}

function capture(target: NonNullable<ReturnType<typeof resolveTaskLocalExecutionCaptureTarget>>): RelayLocalExecutionDelegationCapture {
  return { version: 1, invocationId: "capture-task", ...target.captureBinding,
    source: { version: 1, humanUserId: "human", agentId: "agent", rootTaskId: "task", sourceRoomId: "room",
      sourceConversationId: "conversation", ceiling: "basic", profile: null,
      target: { instanceId: "", relayId: "relay", pairingGeneration: target.rawPairingGeneration } } };
}

test("raw ordinary origin captures the distinct managed pairing reference on the real Registry wire", async () => {
  const f = await fixture(); const target = f.target(); expect(target).not.toBeNull();
  expect(target!.captureBinding.pairingGeneration).not.toBe(f.context.pairingGeneration);
  const result = await f.registry.dispatch("relay", { toolName: "__local_execution_delegate", args: {}, impact: "read-only",
    approvalObtained: false, localExecutionDelegationCapture: capture(target!) });
  expect(result.status).toBe("ok"); expect(target!.isCurrent()).toBe(true);
  expect(f.sent.find(message => message.type === "relay:dispatch")).toMatchObject({
    localExecutionDelegationCapture: { pairingGeneration: f.registry.getLocalExecutionPairingGeneration("relay"),
      source: { target: { pairingGeneration: "raw-pairing-row" } } },
  });
  expect(f.context.pairingGeneration).toBe("raw-pairing-row");
});

test("either pairing identity changing while capture awaits invalidates its result", async () => {
  for (const getter of ["getPairingGeneration", "getLocalExecutionPairingGeneration"] as const) {
    const f = await fixture(); const target = f.target()!;
    const read = f.registry[getter].bind(f.registry);
    let changed = false;
    const spy = spyOn(f.registry, getter).mockImplementation(relayId => changed ? "replacement" : read(relayId));
    try {
      f.duringDispatch(() => { changed = true; });
      expect((await f.registry.dispatch("relay", { toolName: "__local_execution_delegate", args: {}, impact: "read-only",
        approvalObtained: false, localExecutionDelegationCapture: capture(target) })).status).toBe("ok");
      expect(target.isCurrent()).toBe(false);
      if (getter === "getPairingGeneration") expect(f.target()).toBeNull();
    } finally { spy.mockRestore(); }
  }
});

test("wrong raw origin and current transport or capability loss cannot capture", async () => {
  const f = await fixture();
  expect(resolveTaskLocalExecutionCaptureTarget({ ...f.context, pairingGeneration: f.registry.getLocalExecutionPairingGeneration("relay")! }, "human", f.registry)).toBeNull();
  expect(resolveTaskLocalExecutionCaptureTarget(f.context, "other-human", f.registry)).toBeNull();
  expect(resolveTaskLocalExecutionCaptureTarget({ ...f.context, desktopSessionId: "other-desktop" }, "human", f.registry)).toBeNull();
  expect(resolveTaskLocalExecutionCaptureTarget({ ...f.context, relaySessionId: "other-socket" }, "human", f.registry)).toBeNull();
  const target = f.target()!;
  const protocol = spyOn(f.registry, "getProtocolVersion")
    .mockReturnValue(RELAY_DELEGATED_LOCAL_EXECUTION_PROTOCOL_VERSION - 1);
  try { expect(f.target()).toBeNull(); expect(target.isCurrent()).toBe(false); } finally { protocol.mockRestore(); }
  const capability = spyOn(f.registry, "getCapabilities").mockReturnValue({ profile: "desktop-agent", canDelegateLocalExecution: false });
  try { expect(f.target()).toBeNull(); expect(target.isCurrent()).toBe(false); } finally { capability.mockRestore(); }
  await f.registry.unregister("relay"); expect(target.isCurrent()).toBe(false);
});
