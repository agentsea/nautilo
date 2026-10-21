import { expect, spyOn, test } from "bun:test";
import { RELAY_DELEGATED_LOCAL_EXECUTION_PROTOCOL_VERSION, RELAY_LOCAL_EXECUTION_NETWORK_POLICY_PROTOCOL_VERSION,
  type RelayLocalExecutionDelegationCapture, type RelayServerMessage } from "@nautilo/relay";
import { InMemoryRelayRegistry } from "@nautilo/runtime";
import { createTaskLocalExecutionCaptureAdmission, resolveTaskLocalExecutionCaptureTarget,
  taskNeedsLocalExecutionCapture } from "../../src/local-execution-task-capture";

test("capture admission reads policy and source facts through the borrowed transaction", async () => {
  const database = { select() { throw new Error("dependency should receive the exact borrowed handle"); } };
  const events: string[] = [];
  const admission = createTaskLocalExecutionCaptureAdmission({ database: database as never,
    humanUserId: "human", agentId: "agent", roomId: "room", conversationId: "lane-thread",
    assertCurrentProtected: async () => { events.push("protected"); } }, {
    readPolicy: async received => {
      expect(received).toBe(database as never); events.push("policy");
      return { mode: "full_encryption", shadowBehavior: "strict", revision: 4 };
    },
    readSourceAuthority: async (received, input) => {
      expect(received).toBe(database as never); events.push("scope");
      expect(input).toEqual({ humanUserId: "human", agentId: "agent", roomId: "room", graphThreadId: "lane-thread" });
      return { roomId: "room", graphThreadId: "lane-thread", agentActorId: "agent-actor" };
    },
  });
  expect(await admission.readPolicy()).toMatchObject({ mode: "full_encryption", revision: 4 });
  expect(await admission.readScope()).toEqual({ roomId: "room", graphThreadId: "lane-thread", agentActorId: "agent-actor" });
  await admission.validateProtected({ mode: "full_encryption", revision: 4 });
  expect(events).toEqual(["policy", "scope", "protected"]);
});

test("capture admission refuses protected policy without the current protected owner", async () => {
  const admission = createTaskLocalExecutionCaptureAdmission({ database: {} as never,
    humanUserId: "human", agentId: "agent", roomId: "room", conversationId: "thread" }, {
    readPolicy: async () => ({ mode: "full_encryption", shadowBehavior: "strict", revision: 1 }),
    readSourceAuthority: async () => null,
  });
  expect(await admission.validateProtected({ mode: "full_encryption", revision: 1 }).then(() => false, () => true)).toBeTrue();
});

test("only protected file-only repo-docs adds project capture; ordinary admission stays identical", () => {
  for (const preset of ["task", "repo_docs", "schedule", "in_scope"]) {
    for (const toolsMode of [undefined, "none", "auto", "whitelist"]) {
      for (const toolsWhitelist of [undefined, [], ["file"], ["exec_command"], ["write_stdin"], ["file", "exec_command"]]) {
        const candidate = { preset, toolsMode, toolsWhitelist };
        const legacy = !(toolsMode === "none" || (toolsMode === "whitelist"
          && !toolsWhitelist?.some(name => name === "exec_command" || name === "write_stdin")));
        expect(taskNeedsLocalExecutionCapture(candidate, false)).toBe(legacy);
        if (preset !== "repo_docs") expect(taskNeedsLocalExecutionCapture(candidate, true)).toBe(legacy);
      }
    }
  }
  expect(taskNeedsLocalExecutionCapture({ preset: "repo_docs", toolsMode: "whitelist", toolsWhitelist: ["file"] }, true)).toBe(true);
  for (const toolsWhitelist of [[], ["exec_command"], ["file", "exec_command"], ["file", "file"]]) {
    expect(taskNeedsLocalExecutionCapture({ preset: "repo_docs", toolsMode: "whitelist", toolsWhitelist }, true)).toBe(false);
  }
});

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
