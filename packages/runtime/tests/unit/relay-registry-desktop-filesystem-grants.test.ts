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

describe("retired Agent execution refuses before transport effects", () => {
  for (const toolName of ["run_shell", "terminal"]) it(`${toolName} returns an upgrade result without sending`, async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "user-1", CAPS, message => sent.push(message), 29);
    expect(registry.dispatch("relay-1", { toolName, args: { command: "printf fixture" },
      impact: "low", approvalObtained: true })).rejects.toThrow("LOCAL_EXECUTION_UPGRADE_REQUIRED");
    expect(sent).toHaveLength(0);
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

describe("structured SSH and retained output delivery", () => {
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
