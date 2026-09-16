import { describe, expect, test } from "bun:test";
import type {
  RelayCapabilities,
  RelayServerMessage,
  RelaySshDispatchBindingV1,
} from "@nautilo/relay";
import { InMemoryRelayRegistry } from "../../src/relay-registry";

const CAPS: RelayCapabilities = { profile: "desktop-agent" };

const SSH_BINDING: RelaySshDispatchBindingV1 = {
  version: 2,
  admissionId: "admission-1",
  toolCallId: "tool-call-1",
  approvedRequestDigest: "a".repeat(64),
  operation: "exec",
  preparationId: "ssh-preparation-1",
  subject: {
    userId: "owner-1",
    actorId: "owner-1",
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

describe("InMemoryRelayRegistry structured SSH dispatch forwarding (D500)", () => {
  test("forwards the typed binding unchanged with the structured execution class", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "owner-1", CAPS, (message) => sent.push(message), 10);

    const pending = registry.dispatch("relay-1", {
      toolName: "ssh",
      args: { operation: "exec" },
      impact: "high",
      approvalObtained: true,
      executionClass: "structured-ssh",
      sshBinding: SSH_BINDING,
    });

    const dispatch = sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    expect(dispatch.executionClass).toBe("structured-ssh");
    expect(dispatch.sshBinding).toBe(SSH_BINDING);
    expect(dispatch.args).toEqual({ operation: "exec" });

    registry.resolveDispatch(dispatch.correlationId, { status: "ok" });
    expect(await pending).toEqual({ status: "ok" });
  });

  test("leaves the existing dispatch envelope unchanged when no SSH binding is supplied", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "owner-1", CAPS, (message) => sent.push(message), 10);

    const pending = registry.dispatch("relay-1", {
      toolName: "existing-tool",
      args: { existing: true },
      impact: "read-only",
      approvalObtained: false,
    });

    const dispatch = sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    expect(dispatch).not.toHaveProperty("sshBinding");
    expect(dispatch).not.toHaveProperty("executionClass");
    expect(dispatch.args).toEqual({ existing: true });

    registry.resolveDispatch(dispatch.correlationId, { status: "ok" });
    expect(await pending).toEqual({ status: "ok" });
  });
});
