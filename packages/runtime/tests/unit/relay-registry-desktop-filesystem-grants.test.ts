import { describe, expect, it } from "bun:test";
import {
  DESKTOP_FILESYSTEM_GRANT_REQUEST_PROTOCOL_VERSION,
  RELAY_STRUCTURED_SSH_PROGRESS_PROTOCOL_VERSION,
  type RelayCapabilities,
  type RelayServerMessage,
  type RelaySshDispatchBindingV1,
} from "@nautilo/relay";
import {
  InMemoryRelayRegistry,
  RelayDispatchOutcomeUnknownError,
} from "../../src/relay-registry";

const CAPS: RelayCapabilities = { profile: "desktop-agent" } as RelayCapabilities;

const SSH_BINDING: RelaySshDispatchBindingV1 = {
  version: 2,
  admissionId: "admission-1",
  toolCallId: "tool-call-1",
  approvedRequestDigest: "a".repeat(64),
  operation: "exec",
  preparationId: "ssh-preparation-1",
  subject: {
    userId: "user-1",
    actorId: "user-1",
    actorRole: "owner",
    agentId: "agent-1",
    executionEntrypoint: "foreground.main",
    instanceId: "default",
    relayId: "relay-1",
    relaySessionId: "relay-session-1",
    desktopSessionId: "desktop-session-1",
    pairingGenerationRef: "pairing-ref-1",
    capabilityRevision: 1,
  },
};

function structuredSshDispatchRequest() {
  return {
    toolName: "ssh",
    args: { operation: "exec" },
    impact: "high" as const,
    approvalObtained: true,
    executionClass: "structured-ssh" as const,
    sshBinding: SSH_BINDING,
  };
}

describe("InMemoryRelayRegistry desktop-filesystem-grant request transport (D418)", () => {
  it("stores and forwards the optional typed request without changing allowedRoots", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register(
      "relay-1",
      "user-1",
      CAPS,
      (message) => sent.push(message),
      DESKTOP_FILESYSTEM_GRANT_REQUEST_PROTOCOL_VERSION,
    );

    const pending = registry.dispatch("relay-1", {
      toolName: "local-file",
      args: {},
      impact: "read-only",
      approvalObtained: false,
      allowedRoots: ["/server-path-is-not-authority"],
      desktopFilesystemGrantRequest: {
        version: 1,
        grantIds: ["grant-1"],
        requestedRoot: "/Users/alice/project",
        operation: "read",
        subject: {
          userId: "user-1",
          instanceId: "instance-1",
          relayId: "relay-1",
          agentScope: "agent-1",
        },
        policy: { policyVersion: 4, lifetime: "session" },
      },
    });

    const dispatch = sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    expect(dispatch.desktopFilesystemGrantRequest).toEqual({
      version: 1,
      grantIds: ["grant-1"],
      requestedRoot: "/Users/alice/project",
      operation: "read",
      subject: {
        userId: "user-1",
        instanceId: "instance-1",
        relayId: "relay-1",
        agentScope: "agent-1",
      },
      policy: { policyVersion: 4, lifetime: "session" },
    });
    expect(dispatch.allowedRoots).toEqual(["/server-path-is-not-authority"]);

    registry.resolveDispatch(dispatch.correlationId, { status: "ok" });
    expect(await pending).toEqual({ status: "ok" });
  });

  it("strips the renamed envelope for pre-v9 peers without blocking local-file dispatch", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "user-1", CAPS, (message) => sent.push(message), 8);

    const pending = registry.dispatch("relay-1", {
      toolName: "local-file",
      args: {},
      impact: "low",
      approvalObtained: true,
      desktopFilesystemGrantRequest: {
        version: 1,
        grantIds: ["grant-1"],
        requestedRoot: "/Users/alice/project",
        operation: "read",
        subject: {
          userId: "user-1",
          instanceId: "instance-1",
          relayId: "relay-1",
          agentScope: "agent-1",
        },
        policy: { policyVersion: 4, lifetime: "session" },
      },
    });

    const dispatch = sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    expect(dispatch.desktopFilesystemGrantRequest).toBeUndefined();
    registry.resolveDispatch(dispatch.correlationId, { status: "ok" });
    await pending;
  });
});

describe("D538 activation-signal cancellation", () => {
  const rawShell = (signal?: AbortSignal) => ({
    toolName: "run_shell",
    args: { command: "echo harmless" },
    impact: "low" as const,
    approvalObtained: true,
    executionClass: "real_workstation" as const,
    uncontainedHostCommandsSession: true as const,
    ...(signal === undefined ? {} : { signal }),
  });
  const ordinaryRawShell = () => ({
    toolName: "run_shell",
    args: { command: "echo sandboxed" },
    impact: "low" as const,
    approvalObtained: true,
  });

  it("sends nothing when the exact activation was revoked before dispatch", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    const activation = new AbortController();
    activation.abort();
    await registry.register("relay-1", "user-1", CAPS, (message) => sent.push(message), 11);

    const error = await registry.dispatch("relay-1", rawShell(activation.signal))
      .then(() => null, (reason: unknown) => reason);

    expect(sent).toEqual([]);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RelayDispatchOutcomeUnknownError);
  });

  it("cancels only the exact raw-shell correlation when its activation aborts", async () => {
    const registry = new InMemoryRelayRegistry({ runShellResultReceiptGraceMs: 0 });
    const sent: RelayServerMessage[] = [];
    const activation = new AbortController();
    await registry.register("relay-1", "user-1", CAPS, (message) => sent.push(message), 11);
    const pending = registry.dispatch("relay-1", rawShell(activation.signal));
    const dispatch = sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    expect(dispatch.uncontainedHostCommandsSession).toBe(true);

    activation.abort();

    const cancel = sent[1] as Extract<RelayServerMessage, { type: "relay:cancel" }>;
    expect(cancel).toEqual({ type: "relay:cancel", correlationId: dispatch.correlationId });
    const error = await pending.then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(RelayDispatchOutcomeUnknownError);
    expect((error as RelayDispatchOutcomeUnknownError).reason).toBe("cancel");
  });

  it("cancels concurrent work under one activation without touching another relay", async () => {
    const registry = new InMemoryRelayRegistry({ runShellResultReceiptGraceMs: 0 });
    const sentOne: RelayServerMessage[] = [];
    const sentTwo: RelayServerMessage[] = [];
    const activation = new AbortController();
    await registry.register("relay-1", "user-1", CAPS, (message) => sentOne.push(message), 11);
    await registry.register("relay-2", "user-2", CAPS, (message) => sentTwo.push(message), 11);
    const first = registry.dispatch("relay-1", rawShell(activation.signal));
    const second = registry.dispatch("relay-1", rawShell(activation.signal));
    const other = registry.dispatch("relay-2", rawShell());

    activation.abort();

    const cancelled = sentOne
      .filter((message): message is Extract<RelayServerMessage, { type: "relay:cancel" }> =>
        message.type === "relay:cancel",
      )
      .map((message) => message.correlationId);
    expect(cancelled).toHaveLength(2);
    expect(sentTwo.some((message) => message.type === "relay:cancel")).toBe(false);
    await Promise.all([first, second].map((pending) => pending.catch(() => undefined)));
    const otherDispatch = sentTwo[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    registry.resolveDispatch(otherDispatch.correlationId, { status: "ok", result: "unaffected" });
    expect(await other).toEqual({ status: "ok", result: "unaffected" });
  });

  it("cancels only old-connection uncontained shells without touching sandboxed raw shell or structured SSH", async () => {
    const registry = new InMemoryRelayRegistry({ runShellResultReceiptGraceMs: 0 });
    const oldMessages: RelayServerMessage[] = [];
    await registry.register("relay-1", "user-1", CAPS, (message) => oldMessages.push(message), 11);
    const rawPending = registry.dispatch("relay-1", rawShell());
    const rawDispatch = oldMessages[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    const sshPending = registry.dispatch("relay-1", structuredSshDispatchRequest());
    const sshDispatch = oldMessages[1] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    const ordinaryPending = registry.dispatch("relay-1", ordinaryRawShell());
    const ordinaryDispatch = oldMessages[2] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;

    await registry.register("relay-1", "user-1", CAPS, () => {}, 11);

    expect(oldMessages).toContainEqual({ type: "relay:cancel", correlationId: rawDispatch.correlationId });
    expect(oldMessages).not.toContainEqual({ type: "relay:cancel", correlationId: sshDispatch.correlationId });
    expect(oldMessages).not.toContainEqual({ type: "relay:cancel", correlationId: ordinaryDispatch.correlationId });
    const rawError = await rawPending.then(() => null, (reason: unknown) => reason);
    const sshError = await sshPending.then(() => null, (reason: unknown) => reason);
    const ordinaryError = await ordinaryPending.then(() => null, (reason: unknown) => reason);
    expect(rawError).toBeInstanceOf(RelayDispatchOutcomeUnknownError);
    expect((rawError as RelayDispatchOutcomeUnknownError).reason).toBe("replacement");
    expect(sshError).toBeInstanceOf(RelayDispatchOutcomeUnknownError);
    expect((sshError as RelayDispatchOutcomeUnknownError).reason).toBe("replacement");
    expect(ordinaryError).toBeInstanceOf(RelayDispatchOutcomeUnknownError);
    expect((ordinaryError as RelayDispatchOutcomeUnknownError).reason).toBe("replacement");
  });

  it("runs the relevant Desktop lifecycle fence before sending replacement cancel", async () => {
    const events: string[] = [];
    const registry = new InMemoryRelayRegistry({
      runShellResultReceiptGraceMs: 0,
      onDesktopSessionReplaced: () => { events.push("lifecycle"); },
    });
    await registry.register(
      "relay-1",
      "user-1",
      CAPS,
      (message) => {
        if (message.type === "relay:cancel") events.push("cancel");
      },
      11,
      "desktop-1",
      1,
      "pairing-1",
    );
    const pending = registry.dispatch("relay-1", rawShell());

    await registry.register(
      "relay-1",
      "user-1",
      CAPS,
      () => {},
      11,
      "desktop-2",
      1,
      "pairing-1",
    );

    expect(events).toEqual(["lifecycle", "cancel"]);
    await pending.catch(() => undefined);
  });

  it("keeps cancel-send failure an honest unknown outcome", async () => {
    const registry = new InMemoryRelayRegistry({ runShellResultReceiptGraceMs: 0 });
    const activation = new AbortController();
    let sendCount = 0;
    await registry.register("relay-1", "user-1", CAPS, () => {
      sendCount += 1;
      if (sendCount > 1) throw new Error("cancel transport unavailable");
    }, 11);
    const pending = registry.dispatch("relay-1", rawShell(activation.signal));

    activation.abort();

    const error = await pending.then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(RelayDispatchOutcomeUnknownError);
    expect((error as RelayDispatchOutcomeUnknownError).reason).toBe("cancel");
  });
});

describe("D500 structured SSH progress routing", () => {
  it("keeps exec progress output-only and leaves the canonical receipt authoritative", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    const received: Array<{ sequence: number; kind: string }> = [];
    await registry.register("relay-1", "user-1", CAPS, (message) => sent.push(message), RELAY_STRUCTURED_SSH_PROGRESS_PROTOCOL_VERSION);
    const pending = registry.dispatch("relay-1", {
      ...structuredSshDispatchRequest(),
      onStructuredSshProgress: (progress) => received.push({ sequence: progress.sequence, kind: progress.kind }),
    });
    const correlationId = (sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>).correlationId;
    registry.acceptStructuredSshProgress({
      type: "relay:structured-ssh-progress", correlationId, version: 1, sequence: 0,
      operation: "exec", kind: "exec-output", stream: "stdout", offsetBytes: 0, endOffsetBytes: 2, text: "ok", elapsedMs: 1, phase: "running",
    });
    // An exec call cannot emit copy-transfer observations.
    registry.acceptStructuredSshProgress({
      type: "relay:structured-ssh-progress", correlationId, version: 1, sequence: 1,
      operation: "copy-upload", kind: "transfer", phase: "starting", transferredBytes: 0, totalBytes: 4, elapsedMs: 2,
    });
    registry.acceptStructuredSshProgress({
      type: "relay:structured-ssh-progress", correlationId, version: 1, sequence: 1,
      operation: "exec", kind: "exec-output", stream: "stdout", offsetBytes: 2, endOffsetBytes: 4, text: "go", elapsedMs: 3, phase: "running",
    });
    expect(received).toEqual([
      { sequence: 0, kind: "exec-output" },
      { sequence: 1, kind: "exec-output" },
    ]);
    registry.resolveDispatch(correlationId, { status: "ok", result: { canonical: true } });
    expect(await pending).toEqual({ status: "ok", result: { canonical: true } });
  });

  it("keeps copy progress transfer-only and rejects output from an exact copy binding", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    const received: string[] = [];
    await registry.register("relay-1", "user-1", CAPS, (message) => sent.push(message), RELAY_STRUCTURED_SSH_PROGRESS_PROTOCOL_VERSION);
    const pending = registry.dispatch("relay-1", {
      ...structuredSshDispatchRequest(),
      sshBinding: { ...SSH_BINDING, operation: "copy-upload" },
      onStructuredSshProgress: (progress) => received.push(progress.kind),
    });
    const correlationId = (sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>).correlationId;
    registry.acceptStructuredSshProgress({
      type: "relay:structured-ssh-progress", correlationId, version: 1, sequence: 0,
      operation: "copy-upload", kind: "transfer", phase: "starting", transferredBytes: 0, totalBytes: 4, elapsedMs: 1,
    });
    // A copy preparation cannot emit command output, even with a valid sequence.
    registry.acceptStructuredSshProgress({
      type: "relay:structured-ssh-progress", correlationId, version: 1, sequence: 1,
      operation: "exec", kind: "exec-output", stream: "stdout", offsetBytes: 0, endOffsetBytes: 2, text: "no", elapsedMs: 2, phase: "running",
    });
    registry.acceptStructuredSshProgress({
      type: "relay:structured-ssh-progress", correlationId, version: 1, sequence: 1,
      operation: "copy-upload", kind: "transfer", phase: "transferring", transferredBytes: 4, totalBytes: 4, elapsedMs: 3,
    });
    expect(received).toEqual(["transfer", "transfer"]);
    registry.resolveDispatch(correlationId, { status: "ok" });
    await pending;
  });
});

describe("InMemoryRelayRegistry advisory grant snapshot retention (D418)", () => {
  const VALID_SNAPSHOT = {
    revision: 7,
    instanceId: "instance-1",
    agentScope: "all_owned_agents" as const,
    grants: [
      {
        id: "grant-1",
        canonicalRoot: "/Users/alice/project",
        access: ["read", "create_modify"] as const,
        policyVersion: 2,
        lifetime: "durable" as const,
      },
    ],
  };

  it("retains a valid advisory snapshot under the relay association", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent", desktopFilesystemGrantSnapshot: VALID_SNAPSHOT } as RelayCapabilities,
      () => {},
      DESKTOP_FILESYSTEM_GRANT_REQUEST_PROTOCOL_VERSION,
    );

    expect(registry.getDesktopFilesystemGrantSnapshot("relay-1")).toEqual(VALID_SNAPSHOT);
    expect(registry.getCapabilities("relay-1")?.desktopFilesystemGrantSnapshot).toEqual(VALID_SNAPSHOT);
  });

  it("strips a renamed snapshot from a pre-v9 registration while retaining ordinary capabilities", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register(
      "relay-1",
      "user-1",
      {
        profile: "desktop-agent",
        canReadWorkspace: true,
        desktopFilesystemGrantSnapshot: VALID_SNAPSHOT,
      } as RelayCapabilities,
      () => {},
      8,
    );

    expect(registry.getDesktopFilesystemGrantSnapshot("relay-1")).toBeNull();
    expect(registry.getCapabilities("relay-1")?.desktopFilesystemGrantSnapshot).toBeUndefined();
    expect(registry.getCapabilities("relay-1")?.canReadWorkspace).toBe(true);
  });

  it("ignores a malformed snapshot safely while keeping the relay registered", async () => {
    const registry = new InMemoryRelayRegistry();
    const malformed = { ...VALID_SNAPSHOT, agentScope: "everyone" };
    await registry.register(
      "relay-1",
      "user-1",
      {
        profile: "desktop-agent",
        canReadWorkspace: true,
        desktopFilesystemGrantSnapshot: malformed,
      } as unknown as RelayCapabilities,
      () => {},
      DESKTOP_FILESYSTEM_GRANT_REQUEST_PROTOCOL_VERSION,
    );

    // Fail closed for discovery: the malformed snapshot is dropped, but the
    // relay stays registered and its other capabilities survive intact.
    expect(registry.getDesktopFilesystemGrantSnapshot("relay-1")).toBeNull();
    expect(registry.getCapabilities("relay-1")?.desktopFilesystemGrantSnapshot).toBeUndefined();
    expect(registry.getCapabilities("relay-1")?.canReadWorkspace).toBe(true);
    expect(await registry.listConnected()).toEqual(["relay-1"]);
  });

  it("leaves the snapshot absent when none is advertised", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register("relay-1", "user-1", CAPS, () => {}, 8);
    expect(registry.getDesktopFilesystemGrantSnapshot("relay-1")).toBeNull();
  });
});

describe("D502 run_shell progress registry delivery", () => {
  it("keeps a synchronous structured SSH send failure known pre-dispatch", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register("relay-1", "user-1", CAPS, () => {
      throw new Error("transport rejected frame");
    }, 11);

    const error = await registry.dispatch("relay-1", structuredSshDispatchRequest())
      .then(() => null, (reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RelayDispatchOutcomeUnknownError);
    expect((error as { structuredSshOutcome?: unknown }).structuredSshOutcome).toBeUndefined();
  });

  it("marks a post-send structured SSH dispatch unknown for every lost-result seam", async () => {
    const expectUnknown = async (
      promise: Promise<unknown>,
      reason: RelayDispatchOutcomeUnknownError["reason"],
    ) => {
      const error = await promise.then(() => null, (rejection: unknown) => rejection);
      expect(error).toBeInstanceOf(RelayDispatchOutcomeUnknownError);
      expect((error as RelayDispatchOutcomeUnknownError).reason).toBe(reason);
      expect((error as RelayDispatchOutcomeUnknownError).structuredSshOutcome).toBe("unknown");
      expect((error as RelayDispatchOutcomeUnknownError).runShellOutcome).toBeUndefined();
    };

    const timedOutRegistry = new InMemoryRelayRegistry();
    await timedOutRegistry.register("relay-1", "user-1", CAPS, () => {}, 11);
    await expectUnknown(
      timedOutRegistry.dispatch("relay-1", { ...structuredSshDispatchRequest(), timeout: 1 }),
      "timeout",
    );

    const disconnectedRegistry = new InMemoryRelayRegistry();
    await disconnectedRegistry.register("relay-1", "user-1", CAPS, () => {}, 11);
    const disconnected = disconnectedRegistry.dispatch("relay-1", structuredSshDispatchRequest());
    await disconnectedRegistry.unregister("relay-1");
    await expectUnknown(disconnected, "disconnect");

    const replacedRegistry = new InMemoryRelayRegistry();
    await replacedRegistry.register("relay-1", "user-1", CAPS, () => {}, 11);
    const replaced = replacedRegistry.dispatch("relay-1", structuredSshDispatchRequest());
    await replacedRegistry.register("relay-1", "user-1", CAPS, () => {}, 11);
    await expectUnknown(replaced, "replacement");

    const stoppedRegistry = new InMemoryRelayRegistry();
    await stoppedRegistry.register("relay-1", "user-1", CAPS, () => {}, 11);
    const stopped = stoppedRegistry.dispatch("relay-1", structuredSshDispatchRequest());
    stoppedRegistry.stop();
    await expectUnknown(stopped, "shutdown");

    const cancelledRegistry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await cancelledRegistry.register("relay-1", "user-1", CAPS, (message) => sent.push(message), 11);
    const cancelled = cancelledRegistry.dispatch("relay-1", structuredSshDispatchRequest());
    const dispatch = sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    cancelledRegistry.cancelDispatch(dispatch.correlationId);
    await expectUnknown(cancelled, "cancel");
  });

  it("keeps a pre-dispatch missing relay as an ordinary error", async () => {
    const registry = new InMemoryRelayRegistry();
    const error = await registry.dispatch("offline", {
      toolName: "run_shell",
      args: { command: "echo never-sent" },
      impact: "low",
      approvalObtained: true,
    }).then(() => null, (reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RelayDispatchOutcomeUnknownError);
    expect((error as { runShellOutcome?: unknown }).runShellOutcome).toBeUndefined();
  });

  it("marks a dispatched raw run_shell unknown on disconnect", async () => {
    const registry = new InMemoryRelayRegistry({ runShellResultReceiptGraceMs: 1 });
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "user-1", CAPS, (message) => sent.push(message), 11);

    const disconnected = registry.dispatch("relay-1", {
      toolName: "run_shell", args: { command: "echo started" }, impact: "low", approvalObtained: true,
    });
    await registry.unregister("relay-1");
    const disconnectError = await disconnected.then(() => null, (reason: unknown) => reason);
    expect(disconnectError).toBeInstanceOf(RelayDispatchOutcomeUnknownError);
    expect((disconnectError as RelayDispatchOutcomeUnknownError).reason).toBe("disconnect");
  });

  it("keeps the raw shell timeout receipt grace while preserving the wire timeout", async () => {
    // Keep the production-sized grace here. The runtime unit suite executes
    // many files concurrently, so a 20ms grace can expire during an unrelated
    // event-loop stall before this test's 5ms timer is serviced.
    const registry = new InMemoryRelayRegistry({ runShellResultReceiptGraceMs: 5_000 });
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "user-1", CAPS, (message) => sent.push(message), 11);

    const pending = registry.dispatch("relay-1", {
      toolName: "run_shell", args: { command: "sleep 1" }, impact: "low", approvalObtained: true, timeout: 1,
    });
    const dispatch = sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    expect(dispatch.timeout).toBe(1);
    // This is after the command deadline but before its 5s result receipt
    // grace. Electron's canonical timedOut result must still win.
    await new Promise((resolve) => setTimeout(resolve, 10));
    registry.resolveDispatch(dispatch.correlationId, {
      status: "ok",
      result: { timedOut: true, cancelled: false, exitCode: null },
    });
    expect(await pending).toEqual({
      status: "ok",
      result: { timedOut: true, cancelled: false, exitCode: null },
    });
  });

  it("forwards raw-shell cancel and lets the canonical cancelled result win", async () => {
    const registry = new InMemoryRelayRegistry({ runShellResultReceiptGraceMs: 20 });
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "user-1", CAPS, (message) => sent.push(message), 11);

    const pending = registry.dispatch("relay-1", {
      toolName: "run_shell", args: { command: "sleep 1" }, impact: "low", approvalObtained: true,
    });
    const dispatch = sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    registry.cancelDispatch(dispatch.correlationId);
    expect(sent.at(-1)).toEqual({ type: "relay:cancel", correlationId: dispatch.correlationId });
    registry.resolveDispatch(dispatch.correlationId, {
      status: "ok",
      result: { timedOut: false, cancelled: true, exitCode: null },
    });
    expect(await pending).toEqual({
      status: "ok",
      result: { timedOut: false, cancelled: true, exitCode: null },
    });
  });

  it("binds the enclosing Job AbortSignal to raw-shell correlation cancellation", async () => {
    const registry = new InMemoryRelayRegistry({ runShellResultReceiptGraceMs: 20 });
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "user-1", CAPS, (message) => sent.push(message), 11);
    const controller = new AbortController();

    const pending = registry.dispatch("relay-1", {
      toolName: "run_shell",
      args: { command: "sleep 1" },
      impact: "low",
      approvalObtained: true,
      signal: controller.signal,
    });
    const dispatch = sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    controller.abort();
    expect(sent.at(-1)).toEqual({ type: "relay:cancel", correlationId: dispatch.correlationId });
    registry.resolveDispatch(dispatch.correlationId, {
      status: "ok",
      result: { timedOut: false, cancelled: true, exitCode: null },
    });
    expect(await pending).toEqual({
      status: "ok",
      result: { timedOut: false, cancelled: true, exitCode: null },
    });
  });

  it("marks raw shell unknown only after one timeout or cancel receipt grace", async () => {
    const registry = new InMemoryRelayRegistry({ runShellResultReceiptGraceMs: 12 });
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "user-1", CAPS, (message) => sent.push(message), 11);

    const timedOut = registry.dispatch("relay-1", {
      toolName: "run_shell", args: { command: "sleep 1" }, impact: "low", approvalObtained: true, timeout: 1,
    });
    const timeoutError = await timedOut.then(() => null, (reason: unknown) => reason);
    expect(timeoutError).toBeInstanceOf(RelayDispatchOutcomeUnknownError);
    expect((timeoutError as RelayDispatchOutcomeUnknownError).reason).toBe("timeout");

    const cancelled = registry.dispatch("relay-1", {
      toolName: "run_shell", args: { command: "sleep 1" }, impact: "low", approvalObtained: true,
    });
    const cancelFrame = sent.at(-1) as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    registry.cancelDispatch(cancelFrame.correlationId);
    await new Promise((resolve) => setTimeout(resolve, 8));
    // Duplicate cancel is deliberately a no-op: it cannot prolong uncertainty.
    registry.cancelDispatch(cancelFrame.correlationId);
    let cancelError: unknown = null;
    void cancelled.then(() => undefined, (reason: unknown) => { cancelError = reason; });
    await new Promise((resolve) => setTimeout(resolve, 8));
    expect(cancelError).toBeInstanceOf(RelayDispatchOutcomeUnknownError);
    expect((cancelError as RelayDispatchOutcomeUnknownError).reason).toBe("cancel");
  });

  it("keeps typed git and output-artifact variants on ordinary immediate errors", async () => {
    const registry = new InMemoryRelayRegistry({ runShellResultReceiptGraceMs: 20 });
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "user-1", CAPS, (message) => sent.push(message), 11);
    const git = registry.dispatch("relay-1", {
      toolName: "run_shell", args: { git: { operation: "status" } }, impact: "read-only", approvalObtained: true, timeout: 1,
    });
    const gitError = await git.then(() => null, (reason: unknown) => reason);
    expect(gitError).toBeInstanceOf(Error);
    expect(gitError).not.toBeInstanceOf(RelayDispatchOutcomeUnknownError);

    const artifact = registry.dispatch("relay-1", {
      toolName: "run_shell", args: { output_artifact: { reference: "opaque" } }, impact: "read-only", approvalObtained: true,
    });
    const artifactFrame = sent.at(-1) as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    registry.cancelDispatch(artifactFrame.correlationId);
    const artifactError = await artifact.then(() => null, (reason: unknown) => reason);
    expect(artifactError).toBeInstanceOf(Error);
    expect(artifactError).not.toBeInstanceOf(RelayDispatchOutcomeUnknownError);
  });

  it("dedupes offsets, isolates observer faults, and ignores progress after result", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    const received: number[] = [];
    await registry.register("relay-1", "user-1", CAPS, (message) => sent.push(message), 11);
    const pending = registry.dispatch("relay-1", {
      toolName: "run_shell",
      args: { command: "echo hi" },
      impact: "low",
      approvalObtained: true,
      onRunShellProgress: (progress) => {
        received.push(progress.sequence);
        if (progress.sequence === 1) throw new Error("renderer unavailable");
      },
    });
    const correlationId = (sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>).correlationId;
    registry.acceptRunShellProgress({
      type: "relay:run-shell-progress", correlationId, version: 1, sequence: 0,
      stream: "stdout", offsetBytes: 0, endOffsetBytes: 2, text: "ok", elapsedMs: 1, phase: "running",
    });
    registry.acceptRunShellProgress({
      type: "relay:run-shell-progress", correlationId, version: 1, sequence: 1,
      stream: "stderr", offsetBytes: 0, endOffsetBytes: 1, text: "!", elapsedMs: 2, phase: "running",
    });
    // Duplicate offset/sequence cannot replay into the observer.
    registry.acceptRunShellProgress({
      type: "relay:run-shell-progress", correlationId, version: 1, sequence: 1,
      stream: "stderr", offsetBytes: 0, endOffsetBytes: 1, text: "!", elapsedMs: 2, phase: "running",
    });
    expect(received).toEqual([0, 1]);
    registry.resolveDispatch(correlationId, { status: "ok" });
    await pending;
    registry.acceptRunShellProgress({
      type: "relay:run-shell-progress", correlationId, version: 1, sequence: 2,
      stream: "stdout", offsetBytes: 2, endOffsetBytes: 6, text: "late", elapsedMs: 3, phase: "running",
    });
    expect(received).toEqual([0, 1]);
  });
});

describe("InMemoryRelayRegistry updateCapabilities (D418 protocol v7)", () => {
  const SESSION = "session-1";
  const VALID_SNAPSHOT = {
    revision: 7,
    instanceId: "instance-1",
    agentScope: "all_owned_agents" as const,
    grants: [
      {
        id: "grant-1",
        canonicalRoot: "/Users/alice/project",
        access: ["read", "create_modify"] as const,
        policyVersion: 2,
        lifetime: "durable" as const,
      },
    ],
  };

  async function registeredRegistry(
    protocolVersion = DESKTOP_FILESYSTEM_GRANT_REQUEST_PROTOCOL_VERSION,
  ): Promise<InMemoryRelayRegistry> {
    const registry = new InMemoryRelayRegistry();
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent", canReadWorkspace: true } as RelayCapabilities,
      () => {},
      protocolVersion,
      SESSION,
      0,
    );
    return registry;
  }

  it("atomically replaces capabilities and snapshot on a valid update", async () => {
    const registry = await registeredRegistry();
    const result = registry.updateCapabilities({
      relayId: "relay-1",
      userId: "user-1",
      desktopSessionId: SESSION,
      capabilityRevision: 1,
      capabilities: {
        profile: "desktop-agent",
        canReadWorkspace: false,
        desktopFilesystemGrantSnapshot: VALID_SNAPSHOT,
      } as RelayCapabilities,
    });
    expect(result).toEqual({ ok: true });
    expect(registry.getCapabilityRevision("relay-1")).toBe(1);
    expect(registry.getDesktopSessionId("relay-1")).toBe(SESSION);
    expect(registry.getCapabilities("relay-1")?.canReadWorkspace).toBe(false);
    expect(registry.getDesktopFilesystemGrantSnapshot("relay-1")).toEqual(VALID_SNAPSHOT);
  });

  it("rejects a renamed snapshot in a pre-v9 capability update and leaves state intact", async () => {
    const registry = await registeredRegistry(8);
    const result = registry.updateCapabilities({
      relayId: "relay-1",
      userId: "user-1",
      desktopSessionId: SESSION,
      capabilityRevision: 1,
      capabilities: {
        profile: "desktop-agent",
        canReadWorkspace: false,
        desktopFilesystemGrantSnapshot: VALID_SNAPSHOT,
      } as RelayCapabilities,
    });

    expect(result).toEqual({
      ok: false,
      error: "desktop filesystem grant snapshot requires relay protocol v9",
    });
    expect(registry.getCapabilityRevision("relay-1")).toBe(0);
    expect(registry.getCapabilities("relay-1")?.canReadWorkspace).toBe(true);
    expect(registry.getDesktopFilesystemGrantSnapshot("relay-1")).toBeNull();
  });

  it("applies a narrower/empty snapshot immediately", async () => {
    const registry = await registeredRegistry();
    // First advertise a snapshot.
    registry.updateCapabilities({
      relayId: "relay-1",
      userId: "user-1",
      desktopSessionId: SESSION,
      capabilityRevision: 1,
      capabilities: {
        profile: "desktop-agent",
        desktopFilesystemGrantSnapshot: VALID_SNAPSHOT,
      } as RelayCapabilities,
    });
    expect(registry.getDesktopFilesystemGrantSnapshot("relay-1")).toEqual(VALID_SNAPSHOT);
    // Then narrow to no grants (revoked) — the empty snapshot applies immediately.
    const result = registry.updateCapabilities({
      relayId: "relay-1",
      userId: "user-1",
      desktopSessionId: SESSION,
      capabilityRevision: 2,
      capabilities: {
        profile: "desktop-agent",
        desktopFilesystemGrantSnapshot: { ...VALID_SNAPSHOT, grants: [] },
      } as RelayCapabilities,
    });
    expect(result).toEqual({ ok: true });
    expect(registry.getDesktopFilesystemGrantSnapshot("relay-1")?.grants).toEqual([]);
  });

  it("requires an exact desktopSessionId match", async () => {
    const registry = await registeredRegistry();
    const result = registry.updateCapabilities({
      relayId: "relay-1",
      userId: "user-1",
      desktopSessionId: "wrong-session",
      capabilityRevision: 1,
      capabilities: { profile: "desktop-agent" } as RelayCapabilities,
    });
    expect(result.ok).toBe(false);
    // Old state intact.
    expect(registry.getCapabilityRevision("relay-1")).toBe(0);
    expect(registry.getCapabilities("relay-1")?.canReadWorkspace).toBe(true);
  });

  it("rejects updates for a mismatched (unauthenticated) user", async () => {
    const registry = await registeredRegistry();
    const result = registry.updateCapabilities({
      relayId: "relay-1",
      userId: "attacker",
      desktopSessionId: SESSION,
      capabilityRevision: 1,
      capabilities: { profile: "desktop-agent" } as RelayCapabilities,
    });
    expect(result.ok).toBe(false);
    expect(registry.getCapabilityRevision("relay-1")).toBe(0);
  });

  it("rejects stale and duplicate revisions", async () => {
    const registry = await registeredRegistry();
    // revision 1 applies.
    expect(
      registry.updateCapabilities({
        relayId: "relay-1",
        userId: "user-1",
        desktopSessionId: SESSION,
        capabilityRevision: 1,
        capabilities: { profile: "desktop-agent", canReadWorkspace: false } as RelayCapabilities,
      }).ok,
    ).toBe(true);
    // duplicate revision 1 → rejected.
    const dup = registry.updateCapabilities({
      relayId: "relay-1",
      userId: "user-1",
      desktopSessionId: SESSION,
      capabilityRevision: 1,
      capabilities: { profile: "desktop-agent", canReadWorkspace: true } as RelayCapabilities,
    });
    expect(dup.ok).toBe(false);
    // stale revision 0 → rejected.
    const stale = registry.updateCapabilities({
      relayId: "relay-1",
      userId: "user-1",
      desktopSessionId: SESSION,
      capabilityRevision: 0,
      capabilities: { profile: "desktop-agent", canReadWorkspace: true } as RelayCapabilities,
    });
    expect(stale.ok).toBe(false);
    // Old state intact: revision stays 1, canReadWorkspace stays false.
    expect(registry.getCapabilityRevision("relay-1")).toBe(1);
    expect(registry.getCapabilities("relay-1")?.canReadWorkspace).toBe(false);
  });

  it("leaves the old state intact on a malformed snapshot", async () => {
    const registry = await registeredRegistry();
    // Establish a known good state.
    registry.updateCapabilities({
      relayId: "relay-1",
      userId: "user-1",
      desktopSessionId: SESSION,
      capabilityRevision: 1,
      capabilities: {
        profile: "desktop-agent",
        canReadWorkspace: true,
        desktopFilesystemGrantSnapshot: VALID_SNAPSHOT,
      } as RelayCapabilities,
    });
    // Malformed snapshot (unsupported agent scope) → whole update rejected.
    const result = registry.updateCapabilities({
      relayId: "relay-1",
      userId: "user-1",
      desktopSessionId: SESSION,
      capabilityRevision: 2,
      capabilities: {
        profile: "desktop-agent",
        canReadWorkspace: false,
        desktopFilesystemGrantSnapshot: { ...VALID_SNAPSHOT, agentScope: "everyone" },
      } as unknown as RelayCapabilities,
    });
    expect(result.ok).toBe(false);
    // Prior state intact: revision 1, canReadWorkspace true, snapshot preserved.
    expect(registry.getCapabilityRevision("relay-1")).toBe(1);
    expect(registry.getCapabilities("relay-1")?.canReadWorkspace).toBe(true);
    expect(registry.getDesktopFilesystemGrantSnapshot("relay-1")).toEqual(VALID_SNAPSHOT);
  });

  it("rejects an update for an unregistered relay and a relay with no desktop session", async () => {
    const registry = new InMemoryRelayRegistry();
    // No such relay.
    expect(
      registry
        .updateCapabilities({
          relayId: "ghost",
          userId: "user-1",
          desktopSessionId: SESSION,
          capabilityRevision: 1,
          capabilities: { profile: "desktop-agent" } as RelayCapabilities,
        })
        .ok,
    ).toBe(false);
    // Headless relay registered without a desktop session cannot be updated.
    await registry.register("relay-2", "user-1", CAPS, () => {}, 7);
    expect(
      registry
        .updateCapabilities({
          relayId: "relay-2",
          userId: "user-1",
          desktopSessionId: SESSION,
          capabilityRevision: 1,
          capabilities: { profile: "desktop-agent" } as RelayCapabilities,
        })
        .ok,
    ).toBe(false);
  });
});
