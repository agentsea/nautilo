import { beforeAll, describe, expect, mock, test } from "bun:test";
import {
  computeRelaySshApprovedRequestDigestV1,
  RELAY_SSH_APPROVED_REQUEST_VERSION,
  RELAY_SSH_PREPARE_VERSION,
  type RelaySshPrepareRequestV1,
} from "@nautilo/relay";
import { parseRelaySshResolutionFailure } from "../../../../packages/relay/src/protocol.ts";
import { SshPreparationStore } from "../../electron/structured-ssh/preparation-store.ts";

mock.module("electron", () => ({
  app: { getPath: () => "/tmp/nautilo-d500-test-userdata" },
}));

let prepareStructuredSsh: typeof import("../../electron/relay-dispatch/structured-ssh").prepareStructuredSsh;
type Runtime = import("../../electron/relay-dispatch/structured-ssh").StructuredSshDispatchRuntime;

beforeAll(async () => {
  ({ prepareStructuredSsh } = await import("../../electron/relay-dispatch/structured-ssh"));
});

const subject = {
  instanceId: "",
  userId: "user-1",
  actorId: "actor-1",
  actorRole: "owner" as const,
  agentId: "agent-1",
  executionEntrypoint: "foreground.main" as const,
  relayId: "relay-1",
  relaySessionId: "relay-session-1",
  desktopSessionId: "desktop-1",
  pairingGenerationRef: "pairing-1",
  capabilityRevision: 7,
};
const approvedRequest = {
  version: RELAY_SSH_APPROVED_REQUEST_VERSION,
  toolCallId: "tool-call-1",
  toolName: "structured_ssh_exec" as const,
  args: { destination: { connection: "build-alias" }, program: "printf", argv: ["hello"], timeoutSeconds: 300 },
};
const request: RelaySshPrepareRequestV1 = {
  version: RELAY_SSH_PREPARE_VERSION,
  requestId: "prepare-1",
  toolCallId: approvedRequest.toolCallId,
  approvedRequestDigest: computeRelaySshApprovedRequestDigestV1(approvedRequest),
  operation: "exec",
  approvedRequest,
  subject,
};
const destinationPlan = {
  destination: { host: "build.example.test", port: 2222, remoteUser: "deploy" },
  identitySources: [],
  knownHostFiles: [],
  safetyDirectives: {},
} as const;
const firstFingerprint = `SHA256:${"a".repeat(43)}`;
const nextFingerprint = `SHA256:${"b".repeat(43)}`;

function runtime(get = async () => ({
  ok: true as const,
  data: {
    revision: 41,
    capability: {
      version: 1 as const,
      subject: { instanceId: "", userId: "user-1", agentId: "agent-1", relayId: "relay-1", desktopSessionId: "desktop-1" },
      enabled: true,
      tools: { auth: true, exec: true, copyUpload: false, copyDownload: false },
      issuedAt: "2026-08-08T12:00:00.000Z",
      updatedAt: "2026-08-08T12:00:00.000Z",
    },
  },
}), overrides: Partial<Runtime> = {}) {
  return {
    instanceId: "",
    serverBindingId: "ssh-server-binding-aaaaaaaaaaaaaaaa",
    userId: "user-1",
    relayId: "relay-1",
    desktopSessionId: "desktop-1",
    appDataDirectory: "/tmp/d500",
    workspaceRoot: "/tmp/d500-workspace",
    getCapabilityRevision: () => 7,
    capabilityStore: { get },
    preparationStore: new SshPreparationStore({ idFactory: () => "ssh-preparation-1" }),
    hostTrustStore: { lookup: async () => ({ ok: true as const, data: { state: "unknown" as const } }) } as never,
    resolveDestinationPlan: async () => ({ ok: true as const, intent: { connection: "build-alias" } as const, plan: destinationPlan, semanticFingerprint: "a".repeat(64), summary: { destination: destinationPlan.destination, connectionSource: { kind: "openssh" as const, name: "build-alias" }, identitySourceCount: 0, identitySourceKinds: [], knownHostFileCount: 0 } }),
    discoverPreferredHostKey: async () => ({ ok: true as const, data: { algorithm: "ssh-ed25519" as const, fingerprint: firstFingerprint } }),
    observeHumanKnownHosts: async () => ({ ok: true as const, trust: "absent" as const, hostKeys: [] }),
    ...overrides,
  } satisfies Runtime;
}

describe("D500 Electron relay prepare", () => {
  test("reparses the full approved request, binds its digest, and makes alias expansion visible", async () => {
    const result = await prepareStructuredSsh(request, runtime());
    expect(result).toMatchObject({
      ok: true,
      response: {
        requestId: request.requestId,
        toolCallId: request.toolCallId,
        approvedRequestDigest: request.approvedRequestDigest,
        preparationId: "ssh-preparation-1",
        approval: {
          requestedDestination: { connection: "build-alias" },
          host: "build.example.test", port: 2222, remoteUser: "deploy",
          operation: "exec", hostTrust: "unknown", hostKeyFingerprint: firstFingerprint,
        },
      },
    });
  });

  test("projects trusted and changed exact pins without offering ambiguous choices", async () => {
    const trusted = await prepareStructuredSsh(request, runtime(undefined, {
      hostTrustStore: { lookup: async () => ({ ok: true as const, data: { state: "trusted" as const, record: { version: 1 as const, host: destinationPlan.destination.host, port: destinationPlan.destination.port, hostKeyFingerprint: firstFingerprint, confirmedAt: "2026-08-08T12:00:00.000Z" } } }) } as never,
      observeHostKey: async () => ({ ok: true as const, data: { fingerprint: firstFingerprint, publicKey: "private", knownHostsLine: "private" } }),
    }));
    expect(trusted).toMatchObject({ ok: true, response: { approval: { hostTrust: "trusted", hostKeyFingerprint: firstFingerprint } } });
    const changed = await prepareStructuredSsh(request, runtime(undefined, {
      hostTrustStore: { lookup: async () => ({ ok: true as const, data: { state: "trusted" as const, record: { version: 1 as const, host: destinationPlan.destination.host, port: destinationPlan.destination.port, hostKeyFingerprint: firstFingerprint, confirmedAt: "2026-08-08T12:00:00.000Z" } } }) } as never,
      observeHostKey: async () => ({ ok: false as const, reason: "host_key_changed" as const }),
      discoverPreferredHostKey: async () => ({ ok: true as const, data: { algorithm: "ssh-ed25519" as const, fingerprint: nextFingerprint } }),
    }));
    expect(changed).toMatchObject({ ok: true, response: { approval: { hostTrust: "changed", hostKeyFingerprint: nextFingerprint, previousHostKeyFingerprint: firstFingerprint } } });
  });

  test("reuses exact Human known_hosts trust and flags a mismatched trusted key", async () => {
    const trusted = await prepareStructuredSsh(request, runtime(undefined, {
      observeHumanKnownHosts: async () => ({
        ok: true as const,
        trust: "trusted" as const,
        hostKeys: [{ algorithm: "ssh-ed25519" as const, fingerprint: firstFingerprint }],
      }),
    }));
    expect(trusted).toMatchObject({ ok: true, response: { approval: { hostTrust: "trusted", hostKeyFingerprint: firstFingerprint } } });

    const changed = await prepareStructuredSsh(request, runtime(undefined, {
      observeHumanKnownHosts: async () => ({
        ok: true as const,
        trust: "trusted" as const,
        hostKeys: [{ algorithm: "ssh-ed25519" as const, fingerprint: nextFingerprint }],
      }),
    }));
    expect(changed).toMatchObject({
      ok: true,
      response: { approval: { hostTrust: "changed", previousHostKeyFingerprint: nextFingerprint, hostKeyFingerprint: firstFingerprint } },
    });
  });

  test("preserves typed, secret-free pre-effect failures for trust-store, ~5s scan, and known_hosts lookup phases", async () => {
    const trustStore = await prepareStructuredSsh(request, runtime(undefined, {
      hostTrustStore: {
        lookup: async () => ({
          ok: false as const,
          code: "store_unavailable" as const,
          message: "secret trust-store path /Users/human/.nautilo/host-trust.json",
        }),
      } as never,
    }));
    expect(trustStore).toEqual({
      ok: false,
      errorCode: "trust_store_unavailable",
      failure: {
        code: "trust_store_unavailable",
        phase: "trust_store_lookup",
        retrySafe: true,
        sideEffectStarted: false,
        stateChanged: false,
        recovery: "retry",
      },
    });
    expect(JSON.stringify(trustStore)).not.toContain("/Users/human");
    if (trustStore.ok || trustStore.failure === undefined) {
      throw new Error("expected a typed trust-store preparation failure");
    }
    expect(parseRelaySshResolutionFailure(trustStore.failure)).toEqual(trustStore.failure);

    const scanTimeout = await prepareStructuredSsh(request, runtime(undefined, {
      discoverPreferredHostKey: async () => ({ ok: false as const, reason: "scan_timed_out" as const }),
    }));
    expect(scanTimeout).toEqual({
      ok: false,
      errorCode: "scan_timed_out",
      failure: {
        code: "scan_timed_out",
        phase: "host_key_scan",
        retrySafe: true,
        sideEffectStarted: false,
        stateChanged: false,
        recovery: "retry",
      },
    });
    if (scanTimeout.ok || scanTimeout.failure === undefined) {
      throw new Error("expected a typed host-key scan preparation failure");
    }
    expect(parseRelaySshResolutionFailure(scanTimeout.failure)).toEqual(scanTimeout.failure);

    const knownHostsTimeout = await prepareStructuredSsh(request, runtime(undefined, {
      observeHumanKnownHosts: async () => ({ ok: false as const, reason: "lookup_timed_out" as const }),
    }));
    expect(knownHostsTimeout).toEqual({
      ok: false,
      errorCode: "lookup_timed_out",
      failure: {
        code: "lookup_timed_out",
        phase: "known_hosts_lookup",
        retrySafe: true,
        sideEffectStarted: false,
        stateChanged: false,
        recovery: "retry",
      },
    });
    if (knownHostsTimeout.ok || knownHostsTimeout.failure === undefined) {
      throw new Error("expected a typed known_hosts preparation failure");
    }
    expect(parseRelaySshResolutionFailure(knownHostsTimeout.failure)).toEqual(knownHostsTimeout.failure);
  });

  test("fails closed for forged request fields, topology, absent capability, disabled tool, and resolution failure", async () => {
    expect(await prepareStructuredSsh({ ...request, approvedRequestDigest: "b".repeat(64) }, runtime()))
      .toEqual({ ok: false, errorCode: "invalid_request" });
    expect(await prepareStructuredSsh({ ...request, approvedRequest: { ...approvedRequest, toolCallId: "other-call" } }, runtime()))
      .toEqual({ ok: false, errorCode: "invalid_request" });
    expect(await prepareStructuredSsh({ ...request, subject: { ...subject, capabilityRevision: 8 } }, runtime()))
      .toEqual({ ok: false, errorCode: "topology_mismatch" });
    expect(await prepareStructuredSsh(request, runtime(async () => ({ ok: true as const, data: { revision: 7, capability: null } }))))
      .toEqual({ ok: false, errorCode: "capability_unavailable" });
    const disabled = runtime(async () => ({
      ok: true as const,
      data: {
        revision: 7,
        capability: {
          version: 1 as const,
          subject: { instanceId: "", userId: "user-1", agentId: "agent-1", relayId: "relay-1", desktopSessionId: "desktop-1" },
          enabled: true,
          tools: { auth: true, exec: false, copyUpload: false, copyDownload: false },
          issuedAt: "2026-08-08T12:00:00.000Z",
          updatedAt: "2026-08-08T12:00:00.000Z",
        },
      },
    }));
    expect(await prepareStructuredSsh(request, disabled)).toEqual({ ok: false, errorCode: "tool_disabled" });
    for (const code of ["resolve_failed", "connection_ambiguous", "connection_catalog_unreadable", "connection_catalog_overflow", "openssh_connection_catalog_unsupported_match", "remote_user_missing"] as const) {
      const recovery = code === "connection_ambiguous" ? "choose_connection" : code === "remote_user_missing" ? "provide_remote_user" : code.includes("overflow") ? "reduce_connection_catalog" : code.includes("catalog") ? "repair_connection_source" : "retry";
      expect(await prepareStructuredSsh(request, { ...runtime(), resolveDestinationPlan: async () => ({ ok: false as const, failure: { phase: "catalog" as const, code, retrySafe: true as const, sideEffectStarted: false as const, stateChanged: false as const, recovery, ...(code.includes("catalog") ? { source: "openssh" as const, observed: { files: 1, records: 2, bytes: 3 }, completeness: false as const } : {}) } }) }))
        .toMatchObject({ ok: false, errorCode: code, failure: { code, retrySafe: true, sideEffectStarted: false, stateChanged: false, recovery } });
    }
  });
});
