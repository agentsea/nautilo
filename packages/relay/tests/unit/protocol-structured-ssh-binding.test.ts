import { describe, expect, test } from "bun:test";
import {
  RELAY_SSH_DISPATCH_BINDING_VERSION,
  RELAY_SSH_APPROVED_REQUEST_VERSION,
  RELAY_SSH_PREPARE_VERSION,
  parseRelaySshPrepareRequest,
  parseRelaySshPrepareResponse,
  isRelaySshPreparedMessage,
  parseRelaySshDispatchBinding,
  computeRelaySshApprovedRequestDigestV1,
  type RelayDispatchMessage,
  type RelaySshDispatchBindingV1,
} from "../../src/protocol";

const BINDING: RelaySshDispatchBindingV1 = {
  version: RELAY_SSH_DISPATCH_BINDING_VERSION,
  admissionId: "admission-1",
  toolCallId: "tool-call-1",
  approvedRequestDigest: "a".repeat(64),
  operation: "exec",
  preparationId: "ssh-preparation-1",
  subject: {
    userId: "user-1",
    actorId: "actor-1",
    actorRole: "owner",
    agentId: "agent-1",
    executionEntrypoint: "foreground.main",
    instanceId: "instance-1",
    relayId: "relay-1",
    relaySessionId: "relay-session-1",
    desktopSessionId: "desktop-1",
    pairingGenerationRef: "pairing-1",
    capabilityRevision: 7,
  },
};

describe("D500 structured SSH dispatch binding", () => {
  test("requires bounded typed facts for every v2 destination-resolution failure and rejects stale v1 envelopes", () => {
    const failure = {
      code: "openssh_connection_catalog_overflow" as const,
      phase: "catalog" as const,
      retrySafe: true as const,
      sideEffectStarted: false as const,
      stateChanged: false as const,
      recovery: "reduce_connection_catalog" as const,
      source: "openssh" as const,
      observed: { files: 4, records: 7, bytes: 80 },
      configuredBounds: { files: 3, records: 6, bytes: 64, includeDepth: 2 },
      completeness: false as const,
      candidates: [{ source: "openssh" as const, name: "build" }],
    };
    expect(isRelaySshPreparedMessage({ type: "relay:ssh-prepared", requestId: "prepare-1", status: "error", errorCode: failure.code, failure })).toBe(true);
    expect(isRelaySshPreparedMessage({ type: "relay:ssh-prepared", requestId: "prepare-1", status: "error", errorCode: failure.code })).toBe(false);
    expect(isRelaySshPreparedMessage({ type: "relay:ssh-prepared", requestId: "prepare-1", status: "error", errorCode: failure.code, failure: { ...failure, stderr: "private" } })).toBe(false);
    expect(parseRelaySshPrepareRequest({ version: 1, requestId: "prepare-1", toolCallId: "tool-call-1", approvedRequestDigest: "a".repeat(64), operation: "exec", approvedRequest: { version: 1, toolCallId: "tool-call-1", toolName: "structured_ssh_exec", args: { destination: { host: "build", user: "deploy" }, program: "printf", argv: [] } }, subject: BINDING.subject })).toMatchObject({ ok: false });
  });

  test("strictly parses full canonical prepare requests without accepting local authority", () => {
    const approvedRequest = {
      version: RELAY_SSH_APPROVED_REQUEST_VERSION,
      toolCallId: BINDING.toolCallId,
      toolName: "structured_ssh_exec" as const,
      args: { destination: { connection: "build-alias" }, program: "printf", argv: ["hello"], timeoutSeconds: 300 },
    };
    const request = {
      version: RELAY_SSH_PREPARE_VERSION,
      requestId: "prepare-1",
      toolCallId: BINDING.toolCallId,
      approvedRequestDigest: computeRelaySshApprovedRequestDigestV1(approvedRequest),
      operation: BINDING.operation,
      approvedRequest,
      subject: BINDING.subject,
    };
    expect(parseRelaySshPrepareRequest(request)).toMatchObject({ ok: true, request });
    for (const smuggled of [
      { ...request, grantRef: "ssh-grant-1" },
      { ...request, host: "build.example.test" },
      { ...request, approvedRequestDigest: "b".repeat(64) },
      { ...request, approvedRequest: { ...approvedRequest, toolCallId: "other-tool-call" } },
      { ...request, subject: { ...request.subject, profileId: "forbidden" } },
    ]) expect(parseRelaySshPrepareRequest(smuggled)).toMatchObject({ ok: false });

    const { approvedRequest: _approvedRequest, ...responseRequest } = request;
    const response = {
      ...responseRequest,
      preparationId: "ssh-preparation-1",
      approval: {
        requestedDestination: { connection: "build-alias" },
        host: "build.example.test", port: 22, remoteUser: "deploy",
        operation: "exec", hostTrust: "changed",
        hostKeyFingerprint: `SHA256:${"b".repeat(43)}`,
        previousHostKeyFingerprint: `SHA256:${"a".repeat(43)}`,
      },
    };
    expect(parseRelaySshPrepareResponse(response)).toMatchObject({ ok: true, response });
    expect(parseRelaySshPrepareResponse({ ...response, approval: { ...response.approval, localHandle: "private" } }))
      .toMatchObject({ ok: false });
  });

  test("strictly round-trips the exact secret-free v1 binding", () => {
    expect(parseRelaySshDispatchBinding(BINDING)).toEqual({ ok: true, binding: BINDING });
    const dispatch: RelayDispatchMessage = {
      type: "relay:dispatch",
      correlationId: "corr-ssh-1",
      toolName: "ssh",
      args: { operation: "exec" },
      impact: "high",
      approvalObtained: true,
      executionClass: "structured-ssh",
      sshBinding: BINDING,
    };
    expect(dispatch.sshBinding).toEqual(BINDING);
    expect(Object.keys(BINDING).sort()).toEqual([
      "admissionId",
      "approvedRequestDigest",
      "operation",
      "preparationId",
      "subject",
      "toolCallId",
      "version",
    ]);
    expect(Object.keys(BINDING.subject).sort()).toEqual([
      "actorId",
      "actorRole",
      "agentId",
      "capabilityRevision",
      "desktopSessionId",
      "executionEntrypoint",
      "instanceId",
      "pairingGenerationRef",
      "relayId",
      "relaySessionId",
      "userId",
    ]);
  });

  test("rejects every forbidden authority-bearing key", () => {
    for (const forbidden of [
      "host", "remoteUser", "hostKeyFingerprint", "identityHandle", "identity",
      "path", "paths", "argv", "command", "environment", "socket", "roots", "secret",
    ]) {
      expect(parseRelaySshDispatchBinding({ ...BINDING, [forbidden]: "must-not-cross-the-wire" }))
        .toMatchObject({ ok: false });
    }
    for (const forbidden of ["host", "remoteUser", "fingerprint", "key", "path", "command"]) {
      expect(parseRelaySshDispatchBinding({
        ...BINDING,
        subject: { ...BINDING.subject, [forbidden]: "must-not-cross-the-wire" },
      })).toMatchObject({ ok: false });
    }
  });

  test("rejects bad role, provenance, instance, revisions, and digest", () => {
    for (const actorRole of ["member", "owner ", ""] as const) {
      expect(parseRelaySshDispatchBinding({
        ...BINDING,
        subject: { ...BINDING.subject, actorRole },
      })).toMatchObject({ ok: false });
    }
    for (const executionEntrypoint of ["foreground.fork", "background.task", "foreground.subagent"] as const) {
      expect(parseRelaySshDispatchBinding({
        ...BINDING,
        subject: { ...BINDING.subject, executionEntrypoint },
      })).toMatchObject({ ok: false });
    }
    for (const instanceId of [" default", "Default", "bad!"] as const) {
      expect(parseRelaySshDispatchBinding({
        ...BINDING,
        subject: { ...BINDING.subject, instanceId },
      })).toMatchObject({ ok: false });
    }
    expect(parseRelaySshDispatchBinding({
      ...BINDING,
      subject: { ...BINDING.subject, instanceId: "" },
    })).toEqual({ ok: true, binding: { ...BINDING, subject: { ...BINDING.subject, instanceId: "" } } });
    for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER] as const) {
      expect(parseRelaySshDispatchBinding({
        ...BINDING,
        subject: { ...BINDING.subject, capabilityRevision: revision },
      })).toMatchObject({ ok: false });
    }
    for (const approvedRequestDigest of ["A".repeat(64), "a".repeat(63), "sha256:" + "a".repeat(64)] as const) {
      expect(parseRelaySshDispatchBinding({ ...BINDING, approvedRequestDigest })).toMatchObject({ ok: false });
    }
  });
});
