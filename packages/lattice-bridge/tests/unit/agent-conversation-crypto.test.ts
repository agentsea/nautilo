import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  decryptObjectThroughNamespace,
  domainEpoch,
  humanId,
  objectId,
  prepareAgentRuntimeInitialization,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import {
  prepareAgentConversationCryptoRevision,
  prepareForegroundRuntimeExistingMessageCryptoRevision,
} from "../../src/message/agent-conversation-crypto.ts";
import {
  readPreparedConversationCryptoRevisionSnapshot,
} from "../../src/message/conversation-prepared-revision.ts";
import {
  decodeMessagePayloadV2,
} from "../../src/message/message-payload-v2.ts";

function seededRng(seed: number) {
  let state = seed >>> 0;
  return (length: number): Uint8Array => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      bytes[index] = state & 0xff;
    }
    return bytes;
  };
}

async function fixture() {
  const crypto = new LatticeCrypto(
    { bytes: seededRng(0x237_81) },
    { now: () => 1_800_000_000_000 },
  );
  const manager = crypto.generateSigningKeyPair();
  const initialized = await prepareAgentRuntimeInitialization({
      crypto,
      operationId: "operation-conversation-agent-runtime",
      agentId: agentId("agent-conversation-writer"),
      authorizationRevision: authorizationRevision(8),
      configObjects: [{
        objectId: objectId("config-conversation-writer"),
        configRevision: authorizationRevision(1),
        plaintextDek: new Uint8Array(32).fill(0x82),
      }],
      domains: [],
      resolveCurrentDomainCommitterAuthority: () => null,
      manager: {
        managerHumanId: humanId("human-conversation-manager"),
        managerAuthorizationRevision: authorizationRevision(3),
        managerDeviceId: cryptoDeviceId("device-conversation-manager"),
      },
      managerSigningPrivateKey: manager.privateKey,
      resolveCurrentManagerAuthority: () => manager.publicKey,
    });
  const runtime = initialized.runtime;
  const signerPublication = initialized.signerPublication;
  const aiKey = new Uint8Array(32).fill(0x83);
  const resolveCurrentAuthorization = (context: Parameters<
    Parameters<typeof prepareAgentConversationCryptoRevision>[0][
      "resolveCurrentAuthorization"
    ]
  >[0]) => ({
    context,
    grantAuthorized: true,
    namespaceAuthorized: true,
    domainAuthorized: true,
    agentAuthorized: true,
    hostAllowsOperation: true,
    currentRuntime: {
      agentId: runtime.agentId,
      authorizationRevision: authorizationRevision(8),
      runtimeGeneration: runtime.generation,
    },
    signerPublication,
    currentManagerSigningPublicKey: manager.publicKey,
  });
  return {
    crypto,
    runtime,
    manager,
    signerPublication,
    aiKey,
    resolveCurrentAuthorization,
  };
}

describe("Agent conversation crypto preparation", () => {
  test("encrypts one canonical Agent message and binds its v3 signer/authority coordinates", async () => {
    const state = await fixture();
    const runtimeKey = state.runtime.key.slice();
    const aiKey = state.aiKey.slice();
    const revision = prepareAgentConversationCryptoRevision({
      crypto: state.crypto,
      objectId: "conversation-message-agent-object",
      payload: {
        role: "assistant",
        content: "Agent-authored encrypted response",
        toolCalls: [{
          id: "call-1",
          name: "search",
          args: { query: "private" },
        }],
      },
      createdAt: 1_800_000_000_000,
      namespace: {
        namespaceId: "namespace-conversation-agent",
        accessRevision: 4,
        bindingHash: new Uint8Array(32).fill(0x84),
        domainId: cryptoDomainId("domain-conversation-agent"),
        domainEpoch: domainEpoch(2),
        keyGeneration: 3,
        aiKey: state.aiKey,
      },
      grant: {
        grantId: "grant-conversation-agent",
        grantHash: new Uint8Array(32).fill(0x85),
        useStatus: "reusable",
      },
      runtime: state.runtime,
      signerPublication: state.signerPublication,
      resolveCurrentAuthorization: state.resolveCurrentAuthorization,
    });
    const snapshot =
      readPreparedConversationCryptoRevisionSnapshot(revision);
    expect(snapshot.kind).toBe("agent-v3");
    if (snapshot.kind !== "agent-v3") throw new Error("expected Agent snapshot");
    expect(snapshot.value.access.manifest.signer).toEqual({
      kind: "agent_runtime",
      agentId: state.runtime.agentId,
      runtimeGeneration: state.runtime.generation,
      signerKeyId: state.signerPublication.signerKeyId,
    });
    const payload = decodeEncryptedPayloadV2(
      snapshot.value.object.payloadBytes.ciphertext,
    );
    const envelope = decodeNamespaceObjectEnvelopeV2(
      snapshot.value.access.envelopeBytes[0],
    );
    const plaintext = decryptObjectThroughNamespace(
      state.crypto,
      state.aiKey,
      envelope,
      payload,
    );
    expect(plaintext).not.toBeNull();
    expect(decodeMessagePayloadV2(plaintext!)).toEqual({
      role: "assistant",
      content: "Agent-authored encrypted response",
      toolCalls: [{
        id: "call-1",
        name: "search",
        args: { query: "private" },
      }],
    });
    plaintext!.fill(0);
    expect(state.runtime.key).toEqual(runtimeKey);
    expect(state.aiKey).toEqual(aiKey);
  });

  test("rejects Human authorship and wrong Namespace/signer coordinates", async () => {
    const state = await fixture();
    const common = {
      crypto: state.crypto,
      objectId: "conversation-message-agent-object",
      createdAt: 1_800_000_000_000,
      namespace: {
        namespaceId: "namespace-conversation-agent",
        accessRevision: 4,
        bindingHash: new Uint8Array(32).fill(0x84),
        domainId: cryptoDomainId("domain-conversation-agent"),
        domainEpoch: domainEpoch(2),
        keyGeneration: 3,
        aiKey: state.aiKey,
      },
      grant: {
        grantId: "grant-conversation-agent",
        grantHash: new Uint8Array(32).fill(0x85),
        useStatus: "reusable" as const,
      },
      runtime: state.runtime,
      signerPublication: state.signerPublication,
      resolveCurrentAuthorization: state.resolveCurrentAuthorization,
    };
    expect(() =>
      prepareAgentConversationCryptoRevision({
        ...common,
        payload: { role: "user", content: "not Agent-authored" },
      })
    ).toThrow("cannot author a Human message");
    expect(() =>
      prepareAgentConversationCryptoRevision({
        ...common,
        payload: { role: "assistant", content: "stale signer" },
        signerPublication: {
          ...state.signerPublication,
          runtimeGeneration: agentRuntimeGeneration(1),
        },
      })
    ).toThrow();
  });

  test("repairs Human-authored payload without relabeling its authorship", async () => {
    const state = await fixture();
    const revision = prepareForegroundRuntimeExistingMessageCryptoRevision({
      crypto: state.crypto,
      objectId: "conversation-message-human-repair",
      payload: { role: "user", content: "Original Human text" },
      createdAt: 1_800_000_000_000,
      namespace: {
        namespaceId: "namespace-conversation-agent",
        accessRevision: 4,
        bindingHash: new Uint8Array(32).fill(0x84),
        domainId: cryptoDomainId("domain-conversation-agent"),
        domainEpoch: domainEpoch(2),
        keyGeneration: 3,
        aiKey: state.aiKey,
      },
      grant: {
        grantId: "grant-conversation-agent",
        grantHash: new Uint8Array(32).fill(0x85),
        useStatus: "reusable",
      },
      runtime: state.runtime,
      signerPublication: state.signerPublication,
      resolveCurrentAuthorization: state.resolveCurrentAuthorization,
    });
    const snapshot = readPreparedConversationCryptoRevisionSnapshot(revision);
    expect(snapshot.kind).toBe("agent-v3");
    if (snapshot.kind !== "agent-v3") throw new Error("expected Agent snapshot");
    const payload = decodeEncryptedPayloadV2(
      snapshot.value.object.payloadBytes.ciphertext,
    );
    const envelope = decodeNamespaceObjectEnvelopeV2(
      snapshot.value.access.envelopeBytes[0],
    );
    const plaintext = decryptObjectThroughNamespace(
      state.crypto,
      state.aiKey,
      envelope,
      payload,
    );
    expect(plaintext).not.toBeNull();
    expect(decodeMessagePayloadV2(plaintext!)).toEqual({
      role: "user",
      content: "Original Human text",
    });
    plaintext!.fill(0);
  });
});
