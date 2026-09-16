import { beforeAll, describe, expect, mock, test } from "bun:test";
import {
  computeRelaySshApprovedRequestDigestV1,
  createWorkspaceGuard,
  RELAY_SSH_APPROVED_REQUEST_VERSION,
  RELAY_SSH_DISPATCH_BINDING_VERSION,
  type RelayDispatchRequest,
  type RelaySshDispatchBindingV1,
} from "@nautilo/relay";
import { RunShellOutputArtifactStore } from "../../electron/run-shell-output-continuity.ts";

mock.module("electron", () => ({
  app: { getPath: () => "/tmp/nautilo-d500-test-userdata" },
}));

let makeDispatchHandler: typeof import("../../electron/relay").makeDispatchHandler;

beforeAll(async () => {
  ({ makeDispatchHandler } = await import("../../electron/relay"));
});

const subject = {
  instanceId: "instance-1",
  userId: "user-1",
  actorId: "actor-1",
  actorRole: "owner" as const,
  agentId: "agent-1",
  executionEntrypoint: "foreground.main" as const,
  relayId: "relay-1",
  relaySessionId: "relay-session-1",
  desktopSessionId: "desktop-session-1",
  pairingGenerationRef: "pairing-1",
  capabilityRevision: 7,
};
const destination = { connection: "build-alias" } as const;
const destinationPlan = {
  destination: { host: "build.example.test", remoteUser: "deploy", port: 2222 },
  identitySources: [],
  knownHostFiles: [],
  safetyDirectives: {},
} as const;
const pinnedFingerprint = `SHA256:${"a".repeat(43)}`;

function approved(operation: "auth" | "exec") {
  return operation === "auth"
    ? { version: RELAY_SSH_APPROVED_REQUEST_VERSION, toolCallId: "tool-call-1", toolName: "structured_ssh_auth" as const, args: { destination } }
    : { version: RELAY_SSH_APPROVED_REQUEST_VERSION, toolCallId: "tool-call-1", toolName: "structured_ssh_exec" as const, args: { destination, program: "printf", argv: ["hello"], timeoutSeconds: 300 } };
}

function binding(operation: "auth" | "exec"): RelaySshDispatchBindingV1 {
  return {
    version: RELAY_SSH_DISPATCH_BINDING_VERSION,
    admissionId: "admission-1",
    toolCallId: "tool-call-1",
    approvedRequestDigest: computeRelaySshApprovedRequestDigestV1(approved(operation)),
    operation,
    preparationId: "ssh-preparation-1",
    subject,
  };
}

function request(operation: "auth" | "exec", sshBinding = binding(operation)): RelayDispatchRequest {
  return {
    correlationId: "correlation-1",
    toolName: "ssh",
    args: operation === "auth" ? { operation, destination } : { operation, destination, program: "printf", argv: ["hello"], timeoutSeconds: 300 },
    impact: "high",
    approvalObtained: true,
    executionClass: "structured-ssh",
    sshBinding,
  };
}

type Broker = typeof import("../../electron/structured-ssh/broker.ts").runStructuredSshBroker;

function runtime(runBroker: Broker, overrides: Record<string, unknown> = {}) {
  return {
    instanceId: subject.instanceId,
    serverBindingId: "ssh-server-binding-aaaaaaaaaaaaaaaa",
    userId: subject.userId,
    relayId: subject.relayId,
    desktopSessionId: subject.desktopSessionId,
    appDataDirectory: "/tmp/nautilo-d500-app-data",
    workspaceRoot: process.cwd(),
    getCapabilityRevision: () => subject.capabilityRevision,
    capabilityStore: {
      get: async () => ({
        ok: true as const,
        data: {
          revision: 41,
          capability: {
            version: 1 as const,
            subject: { instanceId: subject.instanceId, userId: subject.userId, agentId: subject.agentId, relayId: subject.relayId, desktopSessionId: subject.desktopSessionId },
            enabled: true,
            tools: { auth: true, exec: true, copyUpload: true, copyDownload: true },
            issuedAt: "2026-08-08T12:00:00.000Z",
            updatedAt: "2026-08-08T12:00:00.000Z",
          },
        },
      }),
    },
    preparationStore: {
      create: () => { throw new Error("unused"); },
      consume: () => ({ ok: true as const, data: { capabilityStoreRevision: 41, destinationPlan, destinationIntent: destination, connectionSource: { kind: "openssh" as const, name: "build-alias" }, semanticFingerprint: "a".repeat(64), trustDecision: { state: "trusted" as const, hostKeyFingerprint: pinnedFingerprint } } }),
    } as never,
    hostTrustStore: {
      lookup: async () => ({ ok: true as const, data: { state: "trusted" as const, record: { version: 1 as const, host: destinationPlan.destination.host, port: destinationPlan.destination.port, hostKeyFingerprint: pinnedFingerprint, confirmedAt: "2026-08-08T12:00:00.000Z" } } }),
    } as never,
    observeHostKey: async ({ approvedFingerprint }: { approvedFingerprint: string }) => ({ ok: true as const, data: { fingerprint: approvedFingerprint, publicKey: "private", knownHostsLine: "private" } }),
    probeReadiness: async () => ({ version: 1 as const, state: "enabled" as const, provider: "openssh" as const, ssh: "observed" as const, scp: "observed" as const, auth: true, exec: true, upload: true, download: true }),
    resolveDestinationPlan: async () => ({ ok: true as const, intent: destination, plan: destinationPlan, semanticFingerprint: "a".repeat(64), summary: { destination: destinationPlan.destination, connectionSource: { kind: "openssh" as const, name: "build-alias" }, identitySourceCount: 0, identitySourceKinds: [], knownHostFileCount: 0 } }),
    runBroker,
    ...overrides,
  };
}

describe("D500 structured SSH relay dispatch", () => {
  test("reads owner-bound retained output locally without invoking the SSH runtime", async () => {
    const store = new RunShellOutputArtifactStore();
    const owner = { instanceId: subject.instanceId, userId: subject.userId, relayId: subject.relayId, desktopSessionId: subject.desktopSessionId };
    const draft = store.createDraft(owner);
    draft.append("stdout", Buffer.from("build complete\n"), 15);
    draft.append("stderr", Buffer.from("warning: inspect me\n"), 20);
    const artifact = draft.commit();
    let brokerCalls = 0;
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: process.cwd() }), {
      runShellOutputArtifactStore: store,
      structuredSsh: runtime(async () => { brokerCalls += 1; throw new Error("SSH must not run"); }) as never,
    });
    const outputRequest: RelayDispatchRequest = {
      correlationId: "output-1",
      toolName: "structured_ssh_output",
      args: { output_artifact: { reference: artifact.reference, operation: "search", query: "inspect" } },
      impact: "read-only",
      approvalObtained: true,
      executionClass: "desktop",
      structuredSshOutputOwnerBinding: owner,
    };
    await expect(handler(outputRequest)).resolves.toMatchObject({
      status: "ok",
      result: { totalMatches: 1, matches: [expect.objectContaining({ stream: "stderr", context: expect.stringContaining("inspect") })] },
    });
    await expect(handler({
      ...outputRequest,
      structuredSshOutputOwnerBinding: { ...owner, desktopSessionId: "other-session" },
    })).resolves.toMatchObject({ status: "error", errorCode: "STRUCTURED_SSH_OUTPUT_ARTIFACT_NOT_FOUND" });
    expect(brokerCalls).toBe(0);
    store.clear();
  });

  test("re-resolves after consume and stops source or private-plan drift before host observation, trust, or broker", async () => {
    for (const changed of ["source", "destination", "identity", "known-hosts", "safety"] as const) {
      let hostObservations = 0;
      let brokerCalls = 0;
      const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: process.cwd() }), {
        structuredSsh: runtime(async () => { brokerCalls += 1; return { ok: true, operation: "auth", authenticated: true, sideEffectStarted: true, retrySafe: false }; }, {
          resolveDestinationPlan: async () => ({
            ok: true as const,
            intent: destination,
            plan: changed === "destination" ? { ...destinationPlan, destination: { ...destinationPlan.destination, host: "other.example.test" } } : destinationPlan,
            semanticFingerprint: "b".repeat(64),
            summary: { destination: destinationPlan.destination, connectionSource: changed === "source" ? { kind: "nautilo-profile" as const, name: "build-alias" } : { kind: "openssh" as const, name: "build-alias" }, identitySourceCount: 0, identitySourceKinds: [], knownHostFileCount: 0 },
          }),
          observeHostKey: async () => { hostObservations += 1; return { ok: true as const, data: { fingerprint: pinnedFingerprint, publicKey: "private", knownHostsLine: "private" } }; },
        }) as never,
      });
      await expect(handler(request("auth"))).resolves.toMatchObject({ status: "error", errorCode: "STRUCTURED_SSH_CONNECTION_SOURCE_DRIFT", result: { structuredSshFailure: { code: "connection_source_drift", phase: "dispatch_reresolve", retrySafe: true, sideEffectStarted: false, stateChanged: false, recovery: "retry" } } });
      expect(hostObservations).toBe(0);
      expect(brokerCalls).toBe(0);
    }
  });

  test("rebuilds the exact approved request including destination and passes only private preparation data", async () => {
    const calls: unknown[][] = [];
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: process.cwd() }), {
      structuredSsh: runtime(async (...input) => {
        calls.push(input);
        return { ok: true, operation: "exec", exitCode: 0, stdout: "hello", stderr: "", sideEffectStarted: true, retrySafe: false };
      }),
    });

    await expect(handler(request("exec"))).resolves.toMatchObject({ status: "ok" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toEqual(approved("exec"));
    expect(calls[0]?.[1]).toMatchObject({
      sshCapabilityRevision: 41,
      plan: destinationPlan,
      subject,
      appDataDirectory: "/tmp/nautilo-d500-app-data",
    });
    expect(calls[0]?.[1]).not.toHaveProperty("grantRef");
  });

  test("forwards v15 progress only into the exact prepared broker operation", async () => {
    const observations: unknown[] = [];
    let brokerReport: unknown;
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: process.cwd() }), {
      structuredSsh: runtime(async (_approved, _input, dependencies) => {
        brokerReport = dependencies.reportProgress;
        dependencies.reportProgress?.({
          version: 1,
          sequence: 0,
          operation: "exec",
          kind: "exec-output",
          stream: "stdout",
          offsetBytes: 0,
          endOffsetBytes: 5,
          text: "hello",
          elapsedMs: 1,
          phase: "running",
        });
        return { ok: true, operation: "exec", exitCode: 0, stdout: "hello", stderr: "", sideEffectStarted: true, retrySafe: false };
      }),
    });
    const dispatch = request("exec");
    dispatch.reportStructuredSshProgress = (event) => observations.push(event);
    await expect(handler(dispatch)).resolves.toMatchObject({ status: "ok" });
    expect(brokerReport).toBe(dispatch.reportStructuredSshProgress);
    expect(observations).toEqual([expect.objectContaining({ operation: "exec", kind: "exec-output", text: "hello" })]);
  });

  test("reports a remote public-key rejection instead of inventing another Nautilo grant", async () => {
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: process.cwd() }), {
      structuredSsh: runtime(async () => ({
        ok: false,
        operation: "auth",
        reason: "ssh_exit_nonzero",
        sideEffectStarted: true,
        retrySafe: false,
      })),
    });

    await expect(handler(request("auth"))).resolves.toMatchObject({
      status: "error",
      errorCode: "STRUCTURED_SSH_SSH_EXIT_NONZERO",
      error: expect.stringContaining("remote SSH server rejected the identities"),
    });
  });

  test("reports the exact broker failure instead of collapsing it to authorization", async () => {
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: process.cwd() }), {
      structuredSsh: runtime(async () => ({
        ok: false,
        operation: "auth",
        reason: "identity_source_unavailable",
        sideEffectStarted: false,
        retrySafe: true,
      })),
    });

    await expect(handler(request("auth"))).resolves.toMatchObject({
      status: "error",
      errorCode: "STRUCTURED_SSH_IDENTITY_SOURCE_UNAVAILABLE",
      error: expect.stringContaining("identities selected by this Mac's OpenSSH configuration"),
    });
  });

  test("rejects forged destination, digest, capability revision, and topology before broker execution", async () => {
    let calls = 0;
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: process.cwd() }), {
      structuredSsh: runtime(async () => {
        calls += 1;
        return { ok: true, operation: "auth", authenticated: true, sideEffectStarted: true, retrySafe: false };
      }),
    });
    const forgedDestination = request("exec");
    forgedDestination.args.destination = { host: "attacker.example.test" };
    await expect(handler(forgedDestination)).resolves.toMatchObject({ status: "error", errorCode: "STRUCTURED_SSH_REQUEST_INVALID" });
    await expect(handler(request("exec", { ...binding("exec"), approvedRequestDigest: "b".repeat(64) }))).resolves.toMatchObject({ status: "error", errorCode: "STRUCTURED_SSH_REQUEST_MISMATCH" });
    await expect(handler(request("auth", { ...binding("auth"), subject: { ...subject, capabilityRevision: 6 } }))).resolves.toMatchObject({ status: "error", errorCode: "STRUCTURED_SSH_BINDING_STALE" });
    const localStoreStale = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: process.cwd() }), {
      structuredSsh: runtime(async () => { calls += 1; return { ok: true, operation: "auth", authenticated: true, sideEffectStarted: true, retrySafe: false }; }, {
        capabilityStore: { get: async () => ({ ok: true as const, data: { revision: 42, capability: null } }) },
      }) as never,
    });
    await expect(localStoreStale(request("auth"))).resolves.toMatchObject({ status: "error", errorCode: "STRUCTURED_SSH_CAPABILITY_STALE" });
    expect(calls).toBe(0);
  });

  test("confirms an unknown exact pin only after dispatch approval, and a denied dispatch mutates nothing", async () => {
    let pinned: string | null = null;
    let confirmations = 0;
    let brokerCalls = 0;
    const hostTrustStore = {
      lookup: async () => pinned === null
        ? { ok: true as const, data: { state: "unknown" as const } }
        : { ok: true as const, data: { state: "trusted" as const, record: { version: 1 as const, host: destinationPlan.destination.host, port: destinationPlan.destination.port, hostKeyFingerprint: pinned, confirmedAt: "2026-08-08T12:00:00.000Z" } } },
      confirm: async ({ hostKeyFingerprint }: { hostKeyFingerprint: string }) => {
        confirmations += 1;
        pinned = hostKeyFingerprint;
        return { ok: true as const, data: { record: { version: 1 as const, host: destinationPlan.destination.host, port: destinationPlan.destination.port, hostKeyFingerprint, confirmedAt: "2026-08-08T12:00:00.000Z" }, revision: 1 } };
      },
    };
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: process.cwd() }), {
      structuredSsh: runtime(async () => { brokerCalls += 1; return { ok: true, operation: "auth", authenticated: true, sideEffectStarted: true, retrySafe: false }; }, {
        hostTrustStore,
        preparationStore: { create: () => { throw new Error("unused"); }, consume: () => ({ ok: true as const, data: { capabilityStoreRevision: 41, destinationPlan, destinationIntent: destination, connectionSource: { kind: "openssh" as const, name: "build-alias" }, semanticFingerprint: "a".repeat(64), trustDecision: { state: "unknown" as const, hostKeyFingerprint: pinnedFingerprint } } }) } as never,
      }) as never,
    });
    await expect(handler({ ...request("auth"), approvalObtained: false })).resolves.toMatchObject({ status: "error" });
    expect(confirmations).toBe(0);
    await expect(handler(request("auth"))).resolves.toMatchObject({ status: "ok" });
    expect(confirmations).toBe(1);
    expect(pinned).toBe(pinnedFingerprint);
    expect(brokerCalls).toBe(1);

    let racedConfirmations = 0;
    const raced = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: process.cwd() }), {
      structuredSsh: runtime(async () => { brokerCalls += 1; return { ok: true, operation: "auth", authenticated: true, sideEffectStarted: true, retrySafe: false }; }, {
        hostTrustStore: {
          lookup: async () => ({ ok: true as const, data: { state: "unknown" as const } }),
          confirm: async () => { racedConfirmations += 1; throw new Error("must not mutate"); },
        },
        observeHostKey: async () => ({ ok: false as const, reason: "host_key_changed" as const }),
        preparationStore: { create: () => { throw new Error("unused"); }, consume: () => ({ ok: true as const, data: { capabilityStoreRevision: 41, destinationPlan, destinationIntent: destination, connectionSource: { kind: "openssh" as const, name: "build-alias" }, semanticFingerprint: "a".repeat(64), trustDecision: { state: "unknown" as const, hostKeyFingerprint: pinnedFingerprint } } }) } as never,
      }) as never,
    });
    await expect(raced(request("auth"))).resolves.toMatchObject({ status: "error", errorCode: "STRUCTURED_SSH_TRUST_STALE" });
    expect(racedConfirmations).toBe(0);
    expect(brokerCalls).toBe(1);
  });

  test("replaces only the approved prior pin and denies race/corruption without broker side effects", async () => {
    const previous = `SHA256:${"p".repeat(43)}`;
    const next = `SHA256:${"n".repeat(43)}`;
    let pinned = previous;
    let replacements = 0;
    let brokerCalls = 0;
    const record = () => ({ version: 1 as const, host: destinationPlan.destination.host, port: destinationPlan.destination.port, hostKeyFingerprint: pinned, confirmedAt: "2026-08-08T12:00:00.000Z" });
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: process.cwd() }), {
      structuredSsh: runtime(async () => { brokerCalls += 1; return { ok: true, operation: "auth", authenticated: true, sideEffectStarted: true, retrySafe: false }; }, {
        hostTrustStore: {
          lookup: async () => ({ ok: true as const, data: { state: "trusted" as const, record: record() } }),
          replace: async ({ previousFingerprint, nextFingerprint }: { previousFingerprint: string; nextFingerprint: string }) => {
            if (previousFingerprint !== pinned) return { ok: false as const, code: "trust_changed" as const };
            replacements += 1;
            pinned = nextFingerprint;
            return { ok: true as const, data: { record: record(), revision: 2 } };
          },
        },
        preparationStore: { create: () => { throw new Error("unused"); }, consume: () => ({ ok: true as const, data: { capabilityStoreRevision: 41, destinationPlan, destinationIntent: destination, connectionSource: { kind: "openssh" as const, name: "build-alias" }, semanticFingerprint: "a".repeat(64), trustDecision: { state: "changed" as const, previousHostKeyFingerprint: previous, hostKeyFingerprint: next } } }) } as never,
      }) as never,
    });
    await expect(handler(request("auth"))).resolves.toMatchObject({ status: "ok" });
    expect(replacements).toBe(1);
    expect(pinned).toBe(next);
    expect(brokerCalls).toBe(1);

    let racedReplacements = 0;
    const raced = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: process.cwd() }), {
      structuredSsh: runtime(async () => { brokerCalls += 1; return { ok: true, operation: "auth", authenticated: true, sideEffectStarted: true, retrySafe: false }; }, {
        hostTrustStore: { replace: async () => { racedReplacements += 1; throw new Error("must not mutate"); } },
        observeHostKey: async () => ({ ok: false as const, reason: "host_key_changed" as const }),
        preparationStore: { create: () => { throw new Error("unused"); }, consume: () => ({ ok: true as const, data: { capabilityStoreRevision: 41, destinationPlan, destinationIntent: destination, connectionSource: { kind: "openssh" as const, name: "build-alias" }, semanticFingerprint: "a".repeat(64), trustDecision: { state: "changed" as const, previousHostKeyFingerprint: previous, hostKeyFingerprint: next } } }) } as never,
      }) as never,
    });
    await expect(raced(request("auth"))).resolves.toMatchObject({ status: "error", errorCode: "STRUCTURED_SSH_TRUST_STALE" });
    expect(racedReplacements).toBe(0);
    expect(brokerCalls).toBe(1);

    const corrupt = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: process.cwd() }), {
      structuredSsh: runtime(async () => { brokerCalls += 1; return { ok: true, operation: "auth", authenticated: true, sideEffectStarted: true, retrySafe: false }; }, {
        hostTrustStore: { lookup: async () => ({ ok: false as const, code: "store_corrupt" as const }) },
        preparationStore: { create: () => { throw new Error("unused"); }, consume: () => ({ ok: true as const, data: { capabilityStoreRevision: 41, destinationPlan, destinationIntent: destination, connectionSource: { kind: "openssh" as const, name: "build-alias" }, semanticFingerprint: "a".repeat(64), trustDecision: { state: "trusted" as const, hostKeyFingerprint: next } } }) } as never,
      }) as never,
    });
    await expect(corrupt(request("auth"))).resolves.toMatchObject({ status: "error", errorCode: "STRUCTURED_SSH_TRUST_STALE" });
    expect(brokerCalls).toBe(1);
  });
});
