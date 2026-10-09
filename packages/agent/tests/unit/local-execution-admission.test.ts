import { describe, expect, test } from "bun:test";
import type { RelayLocalExecutionBindingV1 } from "@nautilo/relay";
import { localExecutionId, localExecutionOwnerKey, sameLocalExecutionCaller } from "../../src/tools/local-execution/admission";
import { execCommandSchema, writeStdinSchema, localExecutionOperation } from "../../src/tools/local-execution/local-execution";
const owner: RelayLocalExecutionBindingV1["owner"] = { instanceId: "instance-fixture", humanUserId: "human-fixture",
  agentId: "agent-fixture", runId: "run-fixture", conversationId: "conversation-fixture", relayId: "relay-fixture", desktopSessionId: "desktop-fixture",
  pairingGeneration: "pairing-fixture", serverBindingId: "server-fixture", profileId: "profile-fixture", profileRevision: 1,
  grantIds: ["grant-b", "grant-a"], grantRevision: 1, protectedPolicyVersion: 1 };
describe("contained command admission", () => {
  test("preserves identity on redelivery and separates generation and owner", () => {
    const id = localExecutionId("generation-fixture", owner, "call-fixture");
    expect(localExecutionId("generation-fixture", owner, "call-fixture")).toBe(id);
    expect(localExecutionId("other-generation", owner, "call-fixture")).not.toBe(id);
    expect(localExecutionId("generation-fixture", { ...owner, humanUserId: "other-human" }, "call-fixture")).not.toBe(id);
    expect(localExecutionId("generation-fixture", { ...owner, serverBindingId: "new-plan-binding", profileRevision: 2,
      grantIds: ["replacement-grant"], grantRevision: 2, protectedPolicyVersion: 2 }, "call-fixture")).toBe(id);
    for (const key of ["agentId", "conversationId", "runId"] as const) {
      expect(localExecutionId("generation-fixture", { ...owner, [key]: "other-identity" }, "call-fixture")).not.toBe(id);
    }
    expect(localExecutionOwnerKey({ ...owner, grantIds: [...owner.grantIds].reverse() })).toBe(localExecutionOwnerKey(owner));
    const binding: RelayLocalExecutionBindingV1 = { version: 1, generation: "generation-fixture", invocationId: "call-fixture", executionId: id, operation: "start", owner };
    const caller = { instanceId: owner.instanceId, humanUserId: owner.humanUserId, agentId: owner.agentId,
      conversationId: owner.conversationId, relayId: owner.relayId, desktopSessionId: owner.desktopSessionId, pairingGeneration: owner.pairingGeneration };
    expect(sameLocalExecutionCaller(binding, caller, "generation-fixture")).toBe(true);
    expect(sameLocalExecutionCaller(binding, { ...caller, conversationId: "other-conversation" }, "generation-fixture")).toBe(false);
  });
  test("rejects model authority and distinguishes reads, input, and exact cancellation", () => {
    expect(execCommandSchema.safeParse({ cmd: "echo fixture", execution: "workstation" }).success).toBe(false);
    expect(execCommandSchema.safeParse({ cmd: "echo fixture", max_output_bytes: 3 }).success).toBe(false);
    expect(execCommandSchema.safeParse({ cmd: "echo fixture", yield_time_ms: 2_147_483_648 }).success).toBe(false);
    expect(writeStdinSchema.safeParse({ session_id: "execution-fixture", cursor: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    expect(writeStdinSchema.safeParse({ session_id: "execution-fixture", cancel: true, chars: "" }).success).toBe(false);
    expect(localExecutionOperation("write_stdin", { chars: "" })).toBe("read");
    expect(localExecutionOperation("write_stdin", { chars: "\n" })).toBe("input");
    expect(localExecutionOperation("write_stdin", { cancel: true })).toBe("cancel");
  });
});
