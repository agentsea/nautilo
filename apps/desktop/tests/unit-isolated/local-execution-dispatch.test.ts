import { afterEach, describe, expect, test } from "bun:test";
import { RELAY_WORKSTATION_SHELL_BINDING_VERSION, type RelayDispatchRequest, type RelayLocalExecutionBindingV1, type RelayWorkstationShellBinding } from "@nautilo/relay";
import { LocalExecutionHost } from "../../electron/local-execution-host";
import { LocalExecutionDispatch, localExecutionOwnerKey, type LocalExecutionView } from "../../electron/relay-dispatch/local-execution";
import type { LocalProcessExit, PreparedLocalExecution } from "../../electron/local-execution-process";

const hosts: LocalExecutionHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.finishDisposal(); });

function fixture() {
  let spawns = 0;
  let preparations = 0;
  let releases = 0;
  let writes = 0;
  let revoked = false;
  let finish!: (exit: LocalProcessExit) => void;
  let emit!: (stream: "stdout" | "stderr", bytes: Buffer) => void;
  const host = new LocalExecutionHost({ retention: {
    maxOutputBytes: 1024, maxTotalOutputBytes: 4096, maxExecutions: 8,
    maxActiveExecutions: 4, completedTtlMs: 1000, maxInputRequestsPerExecution: 8,
  }, spawn(_prepared, _tty, output) {
    spawns += 1; emit = output;
    let settle!: (exit: LocalProcessExit) => void;
    const exited = new Promise<LocalProcessExit>((resolve) => { settle = resolve; });
    if (spawns === 1) finish = settle;
    return { pid: 42, exited, write() { writes += 1; }, terminate() { settle({ exitCode: null, signal: "SIGKILL" }); } };
  } });
  hosts.push(host);
  const dispatch = new LocalExecutionDispatch(host);
  const shell: RelayWorkstationShellBinding = {
    version: RELAY_WORKSTATION_SHELL_BINDING_VERSION, toolCallId: "call-a", relayId: "relay-a", desktopSessionId: "desktop-a",
    serverBindingId: "server-a", pairingGeneration: "pair-a", profileId: "profile-a", profileRevision: 1,
    grantIds: ["grant-a"], capabilityRevision: 1, currentFolder: "/tmp", grantRevision: 1, protectedPolicyVersion: 1,
    subject: { userId: "human-a", instanceId: "instance-a", relayId: "relay-a", agentScope: "all_owned_agents" },
    operation: "execute", executionClass: "profile_bound_sandbox",
  };
  const binding: RelayLocalExecutionBindingV1 = {
    version: 1, generation: host.hostGeneration, invocationId: "call-a", executionId: "execution-a", operation: "start",
    owner: { instanceId: "instance-a", humanUserId: "human-a", agentId: "agent-a", runId: "run-a", conversationId: "conversation-a",
      relayId: "relay-a", desktopSessionId: "desktop-a", pairingGeneration: "pair-a", serverBindingId: "server-a",
      profileId: "profile-a", profileRevision: 1, grantIds: ["grant-a"], grantRevision: 1, protectedPolicyVersion: 1 },
  };
  const request: RelayDispatchRequest = {
    correlationId: "dispatch-a", toolName: "exec_command", args: { cmd: "printf build", yield_time_ms: 0 },
    impact: "destructive", approvalObtained: true, workstationShellBinding: shell, localExecutionBinding: binding,
    runShellOwnerBinding: { instanceId: "instance-a", userId: "human-a", relayId: "relay-a", desktopSessionId: "desktop-a" },
  };
  const revalidate = async (_binding: RelayWorkstationShellBinding) => {
    if (revoked) throw new Error("GRANT_REVOKED");
  };
  const prepared: PreparedLocalExecution = { program: "/bin/sh", args: ["-c", "printf build"], cwd: "/tmp", env: {},
    dispose() { releases += 1; } };
  const prepare = async () => { preparations += 1; return prepared; };
  const run = (overrides: Partial<RelayDispatchRequest> = {}) => dispatch.dispatch({ request: { ...request, ...overrides }, revalidate, prepare });
  const follow = (operation: "read" | "input" | "cancel", args: Record<string, unknown> = {}) => run({
    toolName: "write_stdin", args: { session_id: binding.executionId, ...args },
    localExecutionBinding: { ...binding, invocationId: "call-follow", operation },
  });
  return { host, dispatch, binding, shell, request, revalidate, prepare, prepared, run, follow,
    counts: () => ({ spawns, preparations, releases, writes }),
    finish: (code = 0, failureCode?: string) => finish({ exitCode: code, signal: null, ...(failureCode ? { failureCode } : {}) }),
    output: (text: string) => emit("stdout", Buffer.from(text)),
    revoke: () => { revoked = true; },
    viewRequest: { generation: host.hostGeneration, executionId: binding.executionId, cursor: 0, maxBytes: 1024 },
  };
}

describe("Desktop managed execution admission adapter", () => {
  test("missing or wrong authenticated ownership fails before preparation", async () => {
    const f = fixture();
    expect(await f.run({ localExecutionBinding: undefined })).toMatchObject({ status: "error", errorCode: "LOCAL_EXECUTION_BINDING_INVALID" });
    expect(await f.run({ runShellOwnerBinding: { ...f.request.runShellOwnerBinding!, userId: "foreign" } }))
      .toMatchObject({ status: "error", errorCode: "LOCAL_EXECUTION_OWNER_MISMATCH" });
    expect(f.counts().spawns).toBe(0);
    expect(f.counts().preparations).toBe(0);
  });

  test("uncontained authority and mismatched profile cannot reach either adapter", async () => {
    const f = fixture();
    expect(await f.run({ executionClass: "real_workstation" }))
      .toMatchObject({ status: "error", errorCode: "LOCAL_EXECUTION_REQUIRES_CONTAINMENT" });
    expect(await f.run({ uncontainedHostCommandsSession: true }))
      .toMatchObject({ status: "error", errorCode: "LOCAL_EXECUTION_REQUIRES_CONTAINMENT" });
    expect(await f.run({ workstationShellBinding: { ...f.shell, profileRevision: 2 } }))
      .toMatchObject({ status: "error", errorCode: "LOCAL_EXECUTION_AUTHORITY_MISMATCH" });
    expect(f.counts().preparations).toBe(0);
  });

  test("invalid response budget, unknown arguments and missing approval have no effects", async () => {
    const f = fixture();
    for (const max_output_bytes of [0, 1, 3, -1, 1.5]) {
      expect((await f.run({ args: { cmd: "touch would-mutate", max_output_bytes } })).status).toBe("error");
    }
    expect((await f.run({ args: { cmd: "touch would-mutate", permission: "all" } })).status).toBe("error");
    expect(await f.run({ approvalObtained: false }))
      .toMatchObject({ status: "error", errorCode: "LOCAL_EXECUTION_APPROVAL_REQUIRED" });
    expect(f.counts().preparations).toBe(0);
    expect(f.counts().spawns).toBe(0);
  });

  test("lost start reply recovers the same execution and retained final diagnostics", async () => {
    const f = fixture();
    expect((await f.run()).status).toBe("ok");
    expect((await f.run()).status).toBe("ok");
    expect(f.counts().spawns).toBe(1);
    f.output("build failed\n");
    f.finish(7);
    await f.follow("read", { cursor: Buffer.byteLength("build failed\n"), yield_time_ms: 100 });
    const first = await f.follow("read");
    const second = await f.follow("read");
    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: "ok", result: { state: "completed", exitCode: 7, output: { data: "build failed\n" } } });
    expect(f.counts().releases).toBe(1);
  });

  test("trusted cancellation before a delayed start prevents all preparation effects", async () => {
    const f = fixture();
    const cancel = await f.follow("cancel", { cancel: true });
    expect(cancel).toMatchObject({ status: "ok", result: { state: "cancelled" } });
    expect(await f.run()).toMatchObject({ status: "ok", result: { state: "cancelled" } });
    expect(f.counts().preparations).toBe(0);
    expect(f.counts().spawns).toBe(0);
  });

  test("Human Stop fences a reserved start while initial authority validation is pending", async () => {
    const f = fixture();
    let admit!: () => void;
    const pending = new Promise<void>((resolve) => { admit = resolve; });
    const start = f.dispatch.dispatch({ request: f.request, prepare: f.prepare, revalidate: () => pending });
    expect(await f.dispatch.humanRead(f.viewRequest)).toMatchObject({ state: "starting", resources: "pending" });
    expect(await f.dispatch.humanRead(f.viewRequest, true)).toMatchObject({ state: "cancelling" });
    admit();
    await start;
    await f.host.finishDisposal();
    expect(await f.dispatch.humanRead(f.viewRequest)).toMatchObject({ state: "cancelled", resources: "released" });
    expect(f.counts()).toEqual({ preparations: 0, spawns: 0, releases: 0, writes: 0 });
  });

  test("initial policy denial retains a safe failed receipt without preparation", async () => {
    for (const [message, failureCode] of [["GRANT_REVOKED", "GRANT_REVOKED"],
      ["private token or /private/path", "LOCAL_EXECUTION_START_FAILED"]]) {
      const f = fixture();
      await f.dispatch.dispatch({ request: { ...f.request, args: { cmd: "printf build", yield_time_ms: 100 } },
        prepare: f.prepare, revalidate: async () => { throw new Error(message); } });
      expect(await f.dispatch.humanRead(f.viewRequest)).toMatchObject({ state: "failed", failureCode, resources: "released" });
      expect(f.counts()).toEqual({ preparations: 0, spawns: 0, releases: 0, writes: 0 });
    }
  });

  test("duplicate starts still require fresh admission before revealing retained output", async () => {
    const f = fixture();
    await f.run({ args: { cmd: "printf build", yield_time_ms: 1 } });
    f.output("retained private diagnostic");
    f.revoke();
    expect(await f.run()).toMatchObject({ status: "error", errorCode: "GRANT_REVOKED" });
    expect(f.counts().spawns).toBe(1);
  });

  test("revocation denies model reads while Human can inspect final receipt and Stop", async () => {
    const f = fixture();
    await f.run({ args: { cmd: "printf build", yield_time_ms: 1 } });
    f.output("available diagnostic\n");
    f.revoke();
    expect(await f.follow("read")).toMatchObject({ status: "error", errorCode: "GRANT_REVOKED" });
    const human = await f.dispatch.humanRead(f.viewRequest);
    expect(human.output.data).toBe("available diagnostic\n");
    await f.dispatch.humanRead(f.viewRequest, true);
    await f.host.finishDisposal();
    expect((await f.dispatch.humanRead(f.viewRequest)).state).toBe("cancelled");
  });

  test("PTY input delivery acknowledgement survives duplicate transport requests", async () => {
    const f = fixture();
    await f.run({ args: { cmd: "interactive-command", tty: true } });
    await f.follow("input", { chars: "yes\n" });
    await f.follow("input", { chars: "yes\n" });
    expect(f.counts().writes).toBe(1);
    f.revoke();
    expect(await f.follow("input", { chars: "new\n" })).toMatchObject({ status: "error", errorCode: "GRANT_REVOKED" });
    expect(f.counts().writes).toBe(1);
  });

  test("folder grant revocation stops only matching executions under the same owner", async () => {
    const f = fixture();
    await f.run({ workstationShellBinding: { ...f.shell, currentFolder: "/tmp/first" } });
    const second = { ...f.binding, executionId: "execution-b", invocationId: "call-b" };
    await f.run({ workstationShellBinding: { ...f.shell, toolCallId: "call-b", currentFolder: "/tmp/second" },
      localExecutionBinding: second });
    f.dispatch.fenceAll("folder-grant", "/tmp/first");
    await f.follow("read", { yield_time_ms: 100 });
    const states = f.host.list(localExecutionOwnerKey(f.binding.owner));
    expect(states.find((record) => record.executionId === "execution-a")?.state).toBe("cancelled");
    expect(states.find((record) => record.executionId === "execution-b")?.state).toBe("running");
  });

  test("a duplicate start cannot replace the original authority used for continuation", async () => {
    const f = fixture();
    const observed: string[] = [];
    const run = (request: RelayDispatchRequest) => f.dispatch.dispatch({ request, prepare: f.prepare,
      revalidate: async (authority) => { observed.push("authority" in authority ? authority.version === 2 ? authority.authority.currentFolder : "full-mac" : authority.currentFolder); },
    });
    await run({ ...f.request, args: { ...f.request.args, tty: true } });
    await run({ ...f.request, args: { ...f.request.args, tty: true },
      workstationShellBinding: { ...f.shell, currentFolder: "/tmp/changed" } });
    await run({ ...f.request, toolName: "write_stdin", args: { session_id: f.binding.executionId, chars: "y" },
      workstationShellBinding: { ...f.shell, currentFolder: "/tmp/changed" },
      localExecutionBinding: { ...f.binding, operation: "input", invocationId: "input-a" } });
    expect(observed).toEqual(["/tmp", "/tmp/changed", "/tmp"]);
    expect(f.counts().spawns).toBe(1);
    expect(f.counts().writes).toBe(1);
  });

  test("unexpected continuation exceptions never expose paths in error receipts", async () => {
    const f = fixture();
    await f.run();
    const result = await f.dispatch.dispatch({ request: { ...f.request, toolName: "write_stdin",
      args: { session_id: f.binding.executionId }, localExecutionBinding: { ...f.binding, operation: "read" } },
      prepare: f.prepare, revalidate: async () => { throw new Error("ENOENT /private/user-folder/private-file"); },
    });
    expect(result).toEqual({ status: "error", errorCode: "LOCAL_EXECUTION_FAILED", error: "LOCAL_EXECUTION_FAILED" });
  });

  test("response refs are tied to the current host generation", async () => {
    const f = fixture();
    const started = await f.run();
    expect(started.status).toBe("ok");
    if (started.status === "ok") {
      const view = started.result as LocalExecutionView;
      expect(view.generation).toBe(f.host.hostGeneration);
      expect(view.session_id).toBe(f.binding.executionId);
    }
    expect(await f.run({ localExecutionBinding: { ...f.binding, generation: "old-generation" } }))
      .toMatchObject({ status: "error", errorCode: "LOCAL_EXECUTION_GENERATION_MISMATCH" });
    expect(f.counts().spawns).toBe(1);
  });
});

test("Development reduction cancels only retained Development variant, preserving running Basic", async () => {
  const f = fixture(); await f.run();
  const basic = { ...f.binding, version: 2 as const, executionId: "basic-execution", invocationId: "basic-call",
    authority: { kind: "basic" as const, roomId: "room-basic", currentFolder: "/tmp", capabilityRevision: 1, protectedPolicyVersion: 1 },
    owner: { ...f.binding.owner, profileId: null, profileRevision: null, grantIds: [], grantRevision: null } };
  expect(await f.dispatch.dispatch({ request: { ...f.request, args: { ...f.request.args, yield_time_ms: 1 }, workstationShellBinding: undefined, localExecutionBinding: basic },
    revalidate: async () => {}, prepare: f.prepare })).toMatchObject({ status: "ok", result: { state: "running" } });
  f.dispatch.fenceDevelopment();
  const development = await f.host.read({ executionId: f.binding.executionId, ownerKey: localExecutionOwnerKey(f.binding.owner), cursor: 0, maxBytes: 1024, yieldMs: 100 });
  const retained = await f.dispatch.humanRead({ ...f.viewRequest, executionId: basic.executionId });
  expect(development.state).toBe("cancelled"); expect(retained.state).toBe("running");
  expect(f.counts().spawns).toBe(2);
});

test("Full Mac transport fencing leaves both contained variants alive", async () => {
  const f = fixture(); await f.run();
  const owner = { ...f.binding.owner, profileId: null, profileRevision: null, grantIds: [], grantRevision: null };
  const basic = { ...f.binding, version: 2 as const, owner, executionId: "basic-execution", invocationId: "basic-call",
    authority: { kind: "basic" as const, roomId: "room", currentFolder: "/tmp", capabilityRevision: 1, protectedPolicyVersion: 1 } };
  await f.run({ workstationShellBinding: undefined, localExecutionBinding: basic });
  const fullMac = { ...f.binding, version: 3 as const, owner, executionId: "full-mac-execution", invocationId: "full-mac-call",
    authority: { kind: "full_mac" as const, roomId: "room", activationId: "activation" } };
  await f.run({ workstationShellBinding: undefined, args: { cmd: "printf build", yield_time_ms: 100 }, localExecutionBinding: fullMac, executionClass: "real_workstation", uncontainedHostCommandsSession: true });
  expect(f.counts().spawns).toBe(3);
  f.dispatch.fenceFullMac();
  expect(await f.host.read({ executionId: fullMac.executionId, ownerKey: localExecutionOwnerKey(owner), cursor: 0, maxBytes: 1024, yieldMs: 100 })).toMatchObject({ state: "cancelled" });
  expect(await f.dispatch.humanRead(f.viewRequest)).toMatchObject({ state: "running", resources: "owned" });
  expect(await f.dispatch.humanRead({ ...f.viewRequest, executionId: "basic-execution" })).toMatchObject({ state: "running", resources: "owned" });
});

test("live literal search returns UTF8 match pages without input or output consumption and keeps fresh authority", async () => {
  const f = fixture(); await f.run({ args: { cmd: "fixture", yield_time_ms: 10 } });
  f.output("界ababa🌊tail");
  const first = await f.follow("read", { search: "aba", cursor: 0, max_output_bytes: 4 });
  expect(first).toMatchObject({ status: "ok", result: { state: "running", output: { cursor: 3, nextCursor: 7, data: "abab" },
    search: { matchedAt: 3, nextSearchCursor: 4, complete: false, gap: false, availableFrom: 0, produced: 16 } } });
  expect(await f.follow("read", { search: "aba", cursor: 4, max_output_bytes: 4 })).toMatchObject({ result: { search: { matchedAt: 5, nextSearchCursor: 6 } } });
  const read = await f.follow("read", { cursor: 0 });
  expect(read).toMatchObject({ result: { output: { data: "界ababa🌊tail", cursor: 0 } } });
  for (const extra of [{ chars: "" }, { cancel: false }, { yield_time_ms: 0 }]) {
    expect(await f.follow("read", { search: "aba", ...extra })).toMatchObject({ status: "error", errorCode: "LOCAL_EXECUTION_ARGUMENT_INVALID" });
  }
  expect(f.counts()).toMatchObject({ spawns: 1, preparations: 1, writes: 0 });
  f.revoke(); expect(await f.follow("read", { search: "aba" })).toMatchObject({ status: "error", errorCode: "GRANT_REVOKED" });
});


test("custody roots retain starting and uncertain cleanup but exclude released history", async () => {
  for (const releaseFails of [false, true]) {
    const f = fixture();
    let releasePreparation!: () => void;
    const barrier = new Promise<void>(resolve => { releasePreparation = resolve; });
    const pending = f.dispatch.dispatch({ request: f.request, revalidate: f.revalidate,
      prepare: async () => { await barrier; return { ...f.prepared, dispose() { if (releaseFails) throw new Error("uncertain cleanup"); } }; } });
    expect(f.dispatch.retainedContainedRoots()).toEqual(["/tmp"]);
    releasePreparation();
    await pending;
    await new Promise(resolve => setImmediate(resolve));
    expect(f.dispatch.retainedContainedRoots()).toEqual(["/tmp"]);
    f.finish();
    await f.host.read({ executionId: f.binding.executionId, ownerKey: localExecutionOwnerKey(f.binding.owner), cursor: 0, maxBytes: 1024, yieldMs: 100 });
    expect(f.dispatch.retainedContainedRoots()).toEqual(releaseFails ? ["/tmp"] : []);
  }
});


test("uncertain process cleanup retains original roots and grants even after sandbox release", async () => {
  const f = fixture();
  await f.run();
  await new Promise(resolve => setImmediate(resolve));
  f.finish(0, "LOCAL_EXECUTION_GROUP_CLEANUP_FAILED");
  await f.host.read({ executionId: f.binding.executionId, ownerKey: localExecutionOwnerKey(f.binding.owner), cursor: 0, maxBytes: 1024, yieldMs: 100 });
  expect(f.dispatch.retainedContainedRoots()).toEqual(["/tmp"]);
  expect(f.dispatch.retainedContainedGrantIds()).toEqual(["grant-a"]);
});
