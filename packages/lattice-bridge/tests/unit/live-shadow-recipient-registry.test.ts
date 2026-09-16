import { describe, expect, test } from "bun:test";
import {
  agentId,
  agentRuntimeGeneration,
  LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  authenticateForegroundRuntimeRecipientKeyPair,
  createProtectedInvocationRecipient,
  type ProtectedInvocationRecipient,
} from "../../src/invocation/protected-grant-invocation.ts";

import {
  LIVE_SHADOW_RECIPIENTS_PER_CLIENT_SESSION,
  LiveShadowRecipientRegistry,
} from "../../src/server/message/live-shadow-recipient-registry.ts";

function fakeRecipient(index: number): ProtectedInvocationRecipient {
  return Object.freeze({
    recipientAgentId: `agent-${index}`,
    recipientKeyId: `key-${index}`,
  }) as ProtectedInvocationRecipient;
}

function fakeRuntime(index: number) {
  return Object.freeze({
    agentId: agentId(`agent-${index}`),
    keyClass: "runtime" as const,
    generation: agentRuntimeGeneration(0),
    key: new Uint8Array(32).fill(index),
  });
}

describe("M282 live Shadow recipient custody", () => {
  test("synchronous runtime reservations share existing capacity and complete only their exact live slot", async () => {
    let now = 1_000;
    const registry = new LiveShadowRecipientRegistry(() => now);
    const reservation = {operationId: "pending", clientActionSessionId: "session", actorId: "actor", deadlineAt: 2_000};
    expect(registry.reserveRuntime(reservation)).toBe(true);
    for (let index = 1; index < LIVE_SHADOW_RECIPIENTS_PER_CLIENT_SESSION; index++) {
      expect(registry.reserveRuntime({...reservation, operationId: `pending-${index}`})).toBe(true);
    }
    expect(registry.reserveRuntime({...reservation, operationId: "overflow"})).toBe(false);
    const crypto = new LatticeCrypto();
    const keyPair = await crypto.generateEncryptionKeyPair();
    const recipient = await authenticateForegroundRuntimeRecipientKeyPair({crypto, ...keyPair,
      recipientKind: "nautilo_foreground_runtime", recipientKeyId: "reserved-key"});
    const completion = {...reservation, publicKey: keyPair.publicKey, recipient};
    expect(registry.completeReservedRuntime({...completion, actorId: "foreign"})).toBe(false);
    expect(registry.completeReservedRuntime({...completion, deadlineAt: 3_000})).toBe(false);
    expect(registry.completeReservedRuntime(completion)).toBe(true);
    expect(registry.completeReservedRuntime(completion)).toBe(false);
    expect(registry.size()).toBe(LIVE_SHADOW_RECIPIENTS_PER_CLIENT_SESSION);
    registry.delete(reservation.operationId);
    expect(registry.completeReservedRuntime(completion)).toBe(false);
    now = 2_000;
    expect(registry.size()).toBe(0);
    expect(registry.completeReservedRuntime({...completion, operationId: "pending-1"})).toBe(false);
    keyPair.privateKey.fill(0);
  });
  test("returns detached exact-session copies and destroys opaque custody on removal", async () => {
    const registry = new LiveShadowRecipientRegistry(() => 1_000);
    const created = await createProtectedInvocationRecipient({
      crypto: new LatticeCrypto(),
      recipientAgentId: agentId("agent-a"),
      recipientKeyId: "key-a",
    });
    const expectedPublicByte = created.publicKey[0];
    expect(registry.put({
      operationId: "operation-a",
      clientActionSessionId: "session-a",
      actorId: "actor-a",
      deadlineAt: 2_000,
      publicKey: created.publicKey,
      recipient: created.recipient,
      agentRuntime: fakeRuntime(1),
    })).toBe(true);
    created.publicKey.fill(99);

    expect(registry.get({
      operationId: "operation-a",
      clientActionSessionId: "session-b",
      actorId: "actor-a",
    })).toBeNull();
    const opened = registry.get({
      operationId: "operation-a",
      clientActionSessionId: "session-a",
      actorId: "actor-a",
    });
    expect(opened?.publicKey[0]).toBe(expectedPublicByte);
    opened?.publicKey.fill(44);
    expect(registry.get({
      operationId: "operation-a",
      clientActionSessionId: "session-a",
      actorId: "actor-a",
    })?.publicKey[0]).not.toBe(44);

    registry.delete("operation-a");
    expect(registry.size()).toBe(0);
  });

  test("expires and bounds recipient custody per live client session", () => {
    let now = 1_000;
    const registry = new LiveShadowRecipientRegistry(() => now);
    for (let index = 0; index < LIVE_SHADOW_RECIPIENTS_PER_CLIENT_SESSION; index++) {
      expect(registry.put({
        operationId: `operation-${index}`,
        clientActionSessionId: "session-a",
        actorId: "actor-a",
        deadlineAt: 2_000,
        publicKey: new Uint8Array(65).fill(index),
        recipient: fakeRecipient(index),
        agentRuntime: fakeRuntime(index),
      })).toBe(true);
    }
    expect(registry.put({
      operationId: "operation-overflow",
      clientActionSessionId: "session-a",
      actorId: "actor-a",
      deadlineAt: 2_000,
      publicKey: new Uint8Array(65).fill(99),
      recipient: fakeRecipient(99),
      agentRuntime: fakeRuntime(99),
    })).toBe(false);
    expect(registry.put({
      operationId: "operation-other-session",
      clientActionSessionId: "session-b",
      actorId: "actor-a",
      deadlineAt: 2_000,
      publicKey: new Uint8Array(65).fill(100),
      recipient: fakeRecipient(100),
      agentRuntime: fakeRuntime(100),
    })).toBe(true);

    now = 2_000;
    expect(registry.size()).toBe(0);
  });

  test("transfers exact custody once without letting a foreign session consume it", async () => {
    const registry = new LiveShadowRecipientRegistry(() => 1_000);
    const created = await createProtectedInvocationRecipient({
      crypto: new LatticeCrypto(),
      recipientAgentId: agentId("agent-transfer"),
      recipientKeyId: "key-transfer",
    });
    expect(registry.put({
      operationId: "operation-transfer",
      clientActionSessionId: "session-transfer",
      actorId: "actor-transfer",
      deadlineAt: 2_000,
      publicKey: created.publicKey,
      recipient: created.recipient,
      agentRuntime: fakeRuntime(2),
    })).toBe(true);
    expect(registry.take({
      operationId: "operation-transfer",
      clientActionSessionId: "foreign-session",
      actorId: "actor-transfer",
    })).toBeNull();
    const transferred = registry.take({
      operationId: "operation-transfer",
      clientActionSessionId: "session-transfer",
      actorId: "actor-transfer",
    });
    expect(transferred?.recipient).toBe(created.recipient);
    expect(registry.size()).toBe(1);
    expect(registry.take({
      operationId: "operation-transfer",
      clientActionSessionId: "session-transfer",
      actorId: "actor-transfer",
    })).toBeNull();
    const runtime = registry.takeAgentRuntime("operation-transfer");
    expect(runtime?.key).toEqual(new Uint8Array(32).fill(2));
    expect(registry.size()).toBe(0);
    runtime?.key.fill(0);
  });

  test("keeps a Runtime recipient Agent-free and transfers it only to its Browser session", async () => {
    const crypto = new LatticeCrypto();
    const keyPair = await crypto.generateEncryptionKeyPair();
    const recipient = await authenticateForegroundRuntimeRecipientKeyPair({
      crypto,
      recipientKind: "nautilo_foreground_runtime",
      recipientKeyId: "runtime-key-1",
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey,
    });
    const registry = new LiveShadowRecipientRegistry(() => 1_000);
    expect("recipientAgentId" in recipient).toBeFalse();
    expect(registry.putRuntime({
      operationId: "runtime-operation",
      clientActionSessionId: "browser-session",
      actorId: "human-1",
      deadlineAt: 2_000,
      publicKey: keyPair.publicKey,
      recipient,
      agentRuntime: fakeRuntime(3),
    })).toBeTrue();
    expect(registry.takeRuntime({
      operationId: "runtime-operation",
      clientActionSessionId: "foreign-browser-session",
      actorId: "human-1",
    })).toBeNull();
    const transferred = registry.takeRuntime({
      operationId: "runtime-operation",
      clientActionSessionId: "browser-session",
      actorId: "human-1",
    });
    expect(transferred?.recipient.recipientKind)
      .toBe("nautilo_foreground_runtime");
    expect(registry.takeRuntime({
      operationId: "runtime-operation",
      clientActionSessionId: "browser-session",
      actorId: "human-1",
    })).toBeNull();
    const runtime = registry.takeAgentRuntime("runtime-operation");
    expect(runtime?.agentId).toBe(agentId("agent-3"));
    runtime?.key.fill(0);
    keyPair.publicKey.fill(0);
    keyPair.privateKey.fill(0);
  });

  test("can retain an Agent-free Runtime recipient before Conductor selection", async () => {
    const crypto = new LatticeCrypto();
    const keyPair = await crypto.generateEncryptionKeyPair();
    const recipient = await authenticateForegroundRuntimeRecipientKeyPair({
      crypto,
      recipientKind: "nautilo_foreground_runtime",
      recipientKeyId: "runtime-key-conductor",
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey,
    });
    const registry = new LiveShadowRecipientRegistry(() => 1_000);
    expect(registry.putRuntime({
      operationId: "invocation-conductor",
      clientActionSessionId: "browser-session",
      actorId: "human-1",
      deadlineAt: 2_000,
      publicKey: keyPair.publicKey,
      recipient,
    })).toBeTrue();
    expect(registry.takeRuntime({
      operationId: "invocation-conductor",
      clientActionSessionId: "browser-session",
      actorId: "human-1",
    })?.recipient.recipientKind).toBe("nautilo_foreground_runtime");
    expect(registry.takeAgentRuntime("invocation-conductor")).toBeNull();
    expect(registry.size()).toBe(0);
    keyPair.publicKey.fill(0);
    keyPair.privateKey.fill(0);
  });
});
