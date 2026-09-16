import { describe, expect, test } from "bun:test";

import {
  LatticeCrypto,
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  createInitialNamespaceKeyrings,
  createNamespaceBinding,
  cryptoDeviceId,
  cryptoDomainId,
  decryptObjectThroughNamespace,
  domainEpoch,
  grantId,
  grantWriteRecord,
  humanId,
  mintGrant,
  namespaceBindingHash,
  namespaceId,
  objectId,
  persistAgentRuntimeInitialization,
  persistNamespaceBinding,
  prepareAgentRuntimeInitialization,
  sealNamespaceKeyring,
  type GrantUseAuthorizationContext,
  type Rng,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  serializeGrantV2,
  serializeNamespaceBindingV2,
  serializeNamespaceKeyringEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import {
  createProtectedInvocationCapability,
  createProtectedInvocationRecipient,
  inspectProtectedInvocationCapability,
  type ProtectedGrantAuthorityPort,
  type ProtectedInvocationCoordinates,
} from "../../src/invocation/protected-grant-invocation";
import {
  createProtectedAgentConversationSessionCryptoPreparer,
} from "../../src/message/protected-agent-conversation-preparer";
import {
  readPreparedConversationCryptoRevisionSnapshot,
} from "../../src/message/conversation-prepared-revision";
import {
  decodeMessagePayloadV2,
} from "../../src/message/message-payload-v2";
import {
  createFakeLatticeStorage,
} from "../../src/testing/fake-lattice-storage";

const NOW = 1_800_000_000_000;
const AGENT_ID = "agent-protected-writer";
const NAMESPACE_ID = "namespace-protected-writer";
const DOMAIN_ID = "domain-protected-writer";

function seededRng(seed: number): Rng {
  let state = seed >>> 0 || 0x9e3779b9;
  return {
    bytes(length) {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        bytes[index] = state & 0xff;
      }
      return bytes;
    },
  };
}

function allowGrant(context: GrantUseAuthorizationContext) {
  return Object.freeze({
    context,
    currentTime: NOW + 3,
    issuingDeviceActive: true,
    recipientAgentAuthorized: true,
    requestedNamespacesAuthorized: true,
    requestedDomainsAuthorized: true,
    hostAllowsOperation: true,
    currentSingleUseStatus: context.singleUseStatus,
  });
}

async function fixture() {
  const crypto = new LatticeCrypto(seededRng(0x237_91), {
    now: () => NOW,
  });
  const manager = crypto.generateSigningKeyPair();
  const issuer = crypto.generateSigningKeyPair();
  const domainRoot = new Uint8Array(32).fill(0x91);
  const { storage } = createFakeLatticeStorage();

  const initialized = await prepareAgentRuntimeInitialization({
    crypto,
    operationId: "operation-protected-writer-runtime",
    agentId: agentId(AGENT_ID),
    authorizationRevision: authorizationRevision(7),
    configObjects: [{
      objectId: objectId("config-protected-writer"),
      configRevision: authorizationRevision(1),
      plaintextDek: new Uint8Array(32).fill(0x93),
    }],
    domains: [{
      domainId: cryptoDomainId(DOMAIN_ID),
      domainEpoch: domainEpoch(2),
      agentAuthorizationRevision: authorizationRevision(7),
      committerDeviceId: cryptoDeviceId("device-protected-writer"),
      domainRoot,
      committerSigningPrivateKey: manager.privateKey,
    }],
    resolveCurrentDomainCommitterAuthority: () => manager.publicKey,
    manager: {
      managerHumanId: humanId("human-protected-writer"),
      managerAuthorizationRevision: authorizationRevision(7),
      managerDeviceId: cryptoDeviceId("device-protected-writer"),
    },
    managerSigningPrivateKey: manager.privateKey,
    resolveCurrentManagerAuthority: () => manager.publicKey,
  });
  expect(await persistAgentRuntimeInitialization({
    crypto,
    storage,
    prepared: initialized,
    resolveCurrentAuthorization: () => ({
      currentState: {
        agentId: agentId(AGENT_ID),
        authorizationRevision: authorizationRevision(7),
        runtimeGeneration: agentRuntimeGeneration(0),
      },
      currentManager: {
        managerHumanId: humanId("human-protected-writer"),
        managerAuthorizationRevision: authorizationRevision(7),
        managerDeviceId: cryptoDeviceId("device-protected-writer"),
      },
      currentManagerSigningPublicKey: manager.publicKey,
      domains: [{
        domainId: cryptoDomainId(DOMAIN_ID),
        domainEpoch: domainEpoch(2),
        agentAuthorizationRevision: authorizationRevision(7),
        committerDeviceId: cryptoDeviceId("device-protected-writer"),
        committerSigningPublicKey: manager.publicKey,
      }],
    }),
  })).toBe("inserted");
  initialized.runtime.key.fill(0);

  const keyrings = createInitialNamespaceKeyrings(
    crypto,
    namespaceId(NAMESPACE_ID),
  );
  const namespaceMetadata = {
    domainId: cryptoDomainId(DOMAIN_ID),
    domainEpoch: domainEpoch(2),
    previousBindingHash: null,
    committerDeviceId: cryptoDeviceId("device-protected-writer"),
  } as const;
  const humanEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: new Uint8Array(32).fill(0x92),
    keyring: keyrings.human,
    metadata: namespaceMetadata,
    committerSigningPrivateKey: manager.privateKey,
    resolveCurrentCommitter: () => manager.publicKey,
  });
  const aiEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot,
    keyring: keyrings.ai,
    metadata: namespaceMetadata,
    committerSigningPrivateKey: manager.privateKey,
    resolveCurrentCommitter: () => manager.publicKey,
  });
  const binding = createNamespaceBinding({
    crypto,
    humanEnvelope,
    aiEnvelope,
    committerSigningPrivateKey: manager.privateKey,
    resolveCurrentCommitter: () => manager.publicKey,
  });
  const bindingHash = namespaceBindingHash(binding);
  expect(await persistNamespaceBinding({
    crypto,
    storage,
    prepared: {
      expectedHead: null,
      nextHead: {
        namespaceId: binding.namespaceId,
        accessRevision: binding.accessRevision,
        bindingHash,
        domainId: binding.domainId,
        domainEpoch: binding.domainEpoch,
      },
      signedBindingBytes: serializeNamespaceBindingV2(binding),
      humanKeyringEnvelopeBytes:
        serializeNamespaceKeyringEnvelopeV2(humanEnvelope),
      aiKeyringEnvelopeBytes:
        serializeNamespaceKeyringEnvelopeV2(aiEnvelope),
    },
    resolveCurrentCommitter: () => manager.publicKey,
  })).toBe("applied");

  const recipient = await createProtectedInvocationRecipient({
    crypto,
    recipientAgentId: agentId(AGENT_ID),
    recipientKeyId: "recipient-protected-writer",
  });
  const grant = await mintGrant(crypto, {
    id: grantId("grant-protected-writer"),
    issuingDeviceId: cryptoDeviceId("device-protected-writer"),
    issuingHumanId: humanId("human-protected-writer"),
    issuingDeviceSigningPrivateKey: issuer.privateKey,
    recipientAgentId: agentId(AGENT_ID),
    recipientKeyId: "recipient-protected-writer",
    recipientEncryptionPublicKey: recipient.publicKey,
    scope: [humanId("human-protected-writer")],
    operations: ["encrypt"],
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
    coveredDomains: [{
      domainId: cryptoDomainId(DOMAIN_ID),
      domainEpoch: domainEpoch(2),
      agentAuthorizationRevision: authorizationRevision(7),
      aiRoot: domainRoot,
    }],
    singleUse: false,
  });
  await storage.putGrant(grantWriteRecord(serializeGrantV2(grant)));
  const coordinates: ProtectedInvocationCoordinates = Object.freeze({
    invocationId: "invocation-protected-writer",
    grantId: grant.id,
    issuingHumanId: "human-protected-writer",
    recipientAgentId: grant.recipientAgentId,
    recipientKeyId: grant.recipientKeyId,
    issuingDeviceId: grant.issuingDeviceId,
    namespaceIds: Object.freeze([NAMESPACE_ID]),
    domainIds: Object.freeze([DOMAIN_ID]),
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
  });
  const capability = createProtectedInvocationCapability({
    coordinates,
    recipient: recipient.recipient,
  });
  let preflightChecks = 0;
  const authority: ProtectedGrantAuthorityPort = {
    resolvePreflightFacts: (request) => {
      preflightChecks += 1;
      return {
        now: NOW + preflightChecks,
        expectedIssuingDeviceId:
          cryptoDeviceId("device-protected-writer"),
        issuingDeviceHumanId: humanId("human-protected-writer"),
        issuingDeviceSigningPublicKey: issuer.publicKey,
        issuingDeviceActive: true,
        recipientAgentId: agentId(AGENT_ID),
        recipientKeyId: "recipient-protected-writer",
        operation: request.operation,
        singleUseAvailable: true,
        namespaceId: namespaceId(NAMESPACE_ID),
        namespaceAccessRevision: accessRevision(0),
        namespaceParticipants: [humanId("human-protected-writer")],
        domainId: cryptoDomainId(DOMAIN_ID),
        domainEpoch: domainEpoch(2),
        agentAuthorizationRevision: authorizationRevision(7),
        hostAllowsOperation: true,
      };
    },
    resolveCurrentAuthorization: allowGrant,
  };
  const resolveCurrentObjectAuthorization = (context: Parameters<
    Parameters<
      typeof createProtectedAgentConversationSessionCryptoPreparer
    >[0]["resolveCurrentObjectAuthorization"]
  >[0]) => ({
    context,
    grantAuthorized: true,
    namespaceAuthorized: true,
    domainAuthorized: true,
    agentAuthorized: true,
    hostAllowsOperation: true,
    currentRuntime: {
      agentId: agentId(AGENT_ID),
      authorizationRevision: authorizationRevision(7),
      runtimeGeneration: agentRuntimeGeneration(0),
    },
    signerPublication: initialized.signerPublication,
    currentManagerSigningPublicKey: manager.publicKey,
  });
  const preparer =
    createProtectedAgentConversationSessionCryptoPreparer({
      crypto,
      storage,
      authority,
      resolveHistoricalNamespaceCommitter: () => manager.publicKey,
      resolveHistoricalRuntimeCommitter: () => manager.publicKey,
      resolveCurrentObjectAuthorization,
    });
  return {
    authority,
    capability,
    crypto,
    keyrings,
    manager,
    preflightChecks: () => preflightChecks,
    preparer,
    resolveCurrentObjectAuthorization,
    storage,
  };
}

describe("protected Agent conversation preparation", () => {
  test("prepares one signed AI revision under the current reusable foreground authority", async () => {
    const state = await fixture();
    const result = await state.preparer.prepare({
      capability: state.capability,
      entrypointId: "foreground.main",
      namespaceId: NAMESPACE_ID,
      domainId: DOMAIN_ID,
      expectedAccessRevision: 0,
      expectedPolicyRevision: 7,
      agentId: AGENT_ID,
      objectId: "message-protected-writer",
      payload: {
        role: "assistant",
        content: "protected answer",
      },
      createdAt: NOW,
    });
    expect(result.status).toBe("prepared");
    if (result.status !== "prepared") throw new Error("expected preparation");
    const snapshot =
      readPreparedConversationCryptoRevisionSnapshot(result.revision);
    expect(snapshot.kind).toBe("agent-v3");
    if (snapshot.kind !== "agent-v3") throw new Error("expected Agent v3");
    const payload = decodeEncryptedPayloadV2(
      snapshot.value.object.payloadBytes.ciphertext,
    );
    const envelope = decodeNamespaceObjectEnvelopeV2(
      snapshot.value.access.envelopeBytes[0],
    );
    const plaintext = decryptObjectThroughNamespace(
      state.crypto,
      state.keyrings.ai.generations[0]!.key,
      envelope,
      payload,
    );
    expect(plaintext).not.toBeNull();
    expect(decodeMessagePayloadV2(plaintext!)).toEqual({
      role: "assistant",
      content: "protected answer",
    });
    plaintext!.fill(0);
    expect(state.preflightChecks()).toBe(3);
    expect(inspectProtectedInvocationCapability(state.capability))
      .not.toBeNull();
  });

  test("fails closed when the current Runtime signer publication is unavailable", async () => {
    const state = await fixture();
    const preparer =
      createProtectedAgentConversationSessionCryptoPreparer({
        crypto: state.crypto,
        storage: {
          getGrant: (id) => state.storage.getGrant(id),
          consumeGrant: (id) => state.storage.consumeGrant(id),
          getNamespaceHead: (id) =>
            state.storage.getNamespaceHead(id),
          getBinding: (id, revision) =>
            state.storage.getBinding(id, revision),
          getAgentRuntimeAtomicState: (id) =>
            state.storage.getAgentRuntimeAtomicState(id),
          getAgentRuntimeSignerPublication: async () => null,
        },
        authority: state.authority,
        resolveHistoricalNamespaceCommitter: () =>
          state.manager.publicKey,
        resolveHistoricalRuntimeCommitter: () =>
          state.manager.publicKey,
        resolveCurrentObjectAuthorization:
          state.resolveCurrentObjectAuthorization,
      });
    expect(await preparer.prepare({
      capability: state.capability,
      entrypointId: "foreground.main",
      namespaceId: NAMESPACE_ID,
      domainId: DOMAIN_ID,
      expectedAccessRevision: 0,
      expectedPolicyRevision: 7,
      agentId: AGENT_ID,
      objectId: "message-protected-writer-missing-signer",
      payload: { role: "assistant", content: "must not prepare" },
      createdAt: NOW,
    })).toEqual({
      status: "unavailable",
      reason: "signing_capability_unavailable",
    });
  });

  test("rejects non-foreground and Human-authored preparation before opening authority", async () => {
    const state = await fixture();
    const common = {
      capability: state.capability,
      namespaceId: NAMESPACE_ID,
      domainId: DOMAIN_ID,
      expectedAccessRevision: 0,
      expectedPolicyRevision: 7,
      agentId: AGENT_ID,
      objectId: "message-protected-writer-rejected",
      createdAt: NOW,
    } as const;
    expect(await state.preparer.prepare({
      ...common,
      entrypointId: "task.execute" as never,
      payload: { role: "assistant", content: "background" },
    })).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });
    expect(await state.preparer.prepare({
      ...common,
      entrypointId: "foreground.main",
      payload: { role: "user", content: "server-encrypted Human" },
    })).toEqual({
      status: "unavailable",
      reason: "content_invalid",
    });
    expect(state.preflightChecks()).toBe(0);
  });
});
