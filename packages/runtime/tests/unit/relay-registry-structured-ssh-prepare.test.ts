import { describe, expect, test } from "bun:test";
import {
  computeRelaySshApprovedRequestDigestV1,
  RELAY_SSH_APPROVED_REQUEST_VERSION,
  RELAY_PROTOCOL_VERSION,
  type RelayCapabilities,
  type RelayServerMessage,
  type RelaySshApprovedRequestV1,
} from "@nautilo/relay";
import { InMemoryRelayRegistry, RelaySshPrepareError } from "../../src/relay-registry";

const enabledReadiness = {
  version: 1,
  state: "enabled",
  provider: "openssh",
  ssh: "observed",
  scp: "observed",
  auth: true,
  exec: true,
  upload: true,
  download: true,
} as const;
const capabilities: RelayCapabilities = {
  profile: "desktop-agent",
  structuredSsh: enabledReadiness,
};
const approvedRequest: RelaySshApprovedRequestV1 = {
  version: RELAY_SSH_APPROVED_REQUEST_VERSION,
  toolCallId: "tool-call-1",
  toolName: "structured_ssh_exec",
  args: {
    destination: { host: "build.example.test", user: "deploy", port: 22 },
    program: "uptime",
    argv: [],
    timeoutSeconds: 300,
  },
};
const invocation = {
  instanceId: "",
  userId: "user-1",
  actorId: "actor-1",
  actorRole: "owner" as const,
  agentId: "agent-1",
  executionEntrypoint: "foreground.main" as const,
  toolCallId: "tool-call-1",
  approvedRequestDigest: computeRelaySshApprovedRequestDigestV1(approvedRequest),
  operation: "exec" as const,
  approvedRequest,
};

async function registered(registeredCapabilities = capabilities) {
  const registry = new InMemoryRelayRegistry();
  const sent: RelayServerMessage[] = [];
  await registry.register(
    "relay-1", "user-1", registeredCapabilities, (message) => sent.push(message),
    RELAY_PROTOCOL_VERSION, "desktop-1", 7, "pairing-generation-1",
  );
  return { registry, sent };
}

function prepared(request: Extract<RelayServerMessage, { type: "relay:ssh-prepare" }>['request']) {
  const { approvedRequest: _approvedRequest, ...responseRequest } = request;
  return {
    type: "relay:ssh-prepared" as const,
    requestId: request.requestId,
    status: "ok" as const,
    response: {
      ...responseRequest,
      preparationId: "ssh-preparation-1",
      approval: {
        requestedDestination: { host: "build.example.test", user: "deploy", port: 22 },
        host: "build.example.test", port: 22, remoteUser: "deploy",
        operation: request.operation,
        hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAA",
        hostTrust: "trusted" as const,
      },
    },
  };
}

describe("relay registry structured SSH prepare", () => {
  test("derives current dynamic topology and resolves only its exact Electron response", async () => {
    const { registry, sent } = await registered();
    const pending = registry.prepareStructuredSsh("relay-1", invocation);
    const message = sent[0] as Extract<RelayServerMessage, { type: "relay:ssh-prepare" }>;
    expect(message).toMatchObject({
      type: "relay:ssh-prepare",
      request: {
        toolCallId: invocation.toolCallId,
        approvedRequestDigest: invocation.approvedRequestDigest,
        approvedRequest,
        subject: { relayId: "relay-1", desktopSessionId: "desktop-1", capabilityRevision: 7 },
      },
    });
    const response = prepared(message.request);
    expect(registry.acceptSshPrepared("relay-1", response)).toBe(true);
    expect(pending).resolves.toEqual(response.response);

    expect(registry.acceptSshPrepared("relay-1", {
      ...response,
      requestId: "not-pending",
    })).toBe(false);
  });

  test("fails closed before sending when readiness is not enabled or the requested operation is unavailable", async () => {
    for (const structuredSsh of [
      {
        version: 1,
        state: "not-enabled",
        provider: "openssh",
        ssh: "observed",
        scp: "observed",
      },
      { ...enabledReadiness, exec: false },
    ] as const) {
      const { registry, sent } = await registered({ profile: "desktop-agent", structuredSsh });
      const outcome = await registry.prepareStructuredSsh("relay-1", invocation)
        .then(() => null, (error: unknown) => error);
      expect(outcome).toMatchObject({
        name: "RelaySshPrepareError",
        code: "topology_stale",
      } satisfies Partial<RelaySshPrepareError>);
      expect(sent).toEqual([]);
    }

    const authRequest: RelaySshApprovedRequestV1 = {
      version: RELAY_SSH_APPROVED_REQUEST_VERSION,
      toolCallId: "tool-call-auth",
      toolName: "structured_ssh_auth",
      args: { destination: { host: "build.example.test", user: "deploy", port: 22 } },
    };
    const { registry, sent } = await registered({
      profile: "desktop-agent",
      structuredSsh: { ...enabledReadiness, auth: false },
    });
    const outcome = await registry.prepareStructuredSsh("relay-1", {
      ...invocation,
      toolCallId: authRequest.toolCallId,
      approvedRequestDigest: computeRelaySshApprovedRequestDigestV1(authRequest),
      operation: "auth",
      approvedRequest: authRequest,
    }).then(() => null, (error: unknown) => error);
    expect(outcome).toMatchObject({
      name: "RelaySshPrepareError",
      code: "topology_stale",
    } satisfies Partial<RelaySshPrepareError>);
    expect(sent).toEqual([]);
  });

  test("prepares each copy direction against its exact advertised readiness", async () => {
    for (const operation of ["copy-upload", "copy-download"] as const) {
      const toolCallId = `tool-call-${operation}`;
      const copyRequest: RelaySshApprovedRequestV1 = operation === "copy-upload"
        ? {
            version: RELAY_SSH_APPROVED_REQUEST_VERSION,
            toolCallId,
            toolName: "structured_ssh_copy_upload",
            args: {
              destination: { host: "build.example.test", user: "deploy", port: 22 },
              localPath: "artifacts/source.txt",
              remotePath: "/tmp/source.txt",
              timeoutSeconds: 300,
            },
          }
        : {
            version: RELAY_SSH_APPROVED_REQUEST_VERSION,
            toolCallId,
            toolName: "structured_ssh_copy_download",
            args: {
              destination: { host: "build.example.test", user: "deploy", port: 22 },
              remotePath: "/tmp/result.txt",
              localPath: "artifacts/result.txt",
              timeoutSeconds: 300,
            },
          };
      const { registry, sent } = await registered();
      const pending = registry.prepareStructuredSsh("relay-1", {
        ...invocation,
        toolCallId,
        approvedRequestDigest: computeRelaySshApprovedRequestDigestV1(copyRequest),
        operation,
        approvedRequest: copyRequest,
      });
      const message = sent[0] as Extract<RelayServerMessage, { type: "relay:ssh-prepare" }>;
      expect(message.request.operation).toBe(operation);
      const response = prepared(message.request);
      expect(registry.acceptSshPrepared("relay-1", response)).toBe(true);
      expect(pending).resolves.toEqual(response.response);
    }
  });

  test("fails closed only when the requested copy direction is unavailable", async () => {
    for (const [operation, structuredSsh] of [
      ["copy-upload", { ...enabledReadiness, upload: false }],
      ["copy-download", { ...enabledReadiness, download: false }],
      ["copy-upload", { ...enabledReadiness, scp: "unavailable" }],
    ] as const) {
      const { registry, sent } = await registered({ profile: "desktop-agent", structuredSsh });
      const outcome = await registry.prepareStructuredSsh("relay-1", {
        ...invocation,
        operation,
      }).then(() => null, (error: unknown) => error);
      expect(outcome).toMatchObject({
        name: "RelaySshPrepareError",
        code: "topology_stale",
      } satisfies Partial<RelaySshPrepareError>);
      expect(sent).toEqual([]);
    }
  });

  test("capability topology change invalidates an in-flight prepare before a response can resolve", async () => {
    const { registry, sent } = await registered();
    const pending = registry.prepareStructuredSsh("relay-1", invocation);
    const message = sent[0] as Extract<RelayServerMessage, { type: "relay:ssh-prepare" }>;
    expect(registry.updateCapabilities({
      relayId: "relay-1", userId: "user-1", desktopSessionId: "desktop-1",
      capabilityRevision: 8,
      capabilities: {
        profile: "desktop-agent",
        structuredSsh: { ...enabledReadiness, exec: false },
      },
    })).toEqual({ ok: true });
    expect(registry.acceptSshPrepared("relay-1", prepared(message.request))).toBe(false);
    expect(pending).rejects.toMatchObject({
      name: "RelaySshPrepareError",
      code: "topology_stale",
    } satisfies Partial<RelaySshPrepareError>);
  });
});
