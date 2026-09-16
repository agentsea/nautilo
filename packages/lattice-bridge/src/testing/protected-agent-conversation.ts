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
  encryptedObjectWriteRecord,
  encryptObjectPayload,
  grantId,
  grantWriteRecord,
  humanId,
  mintGrant,
  namespaceBindingHash,
  namespaceGeneration,
  namespaceId,
  objectId,
  participantDigest,
  persistAgentRuntimeInitialization,
  persistNamespaceBinding,
  prepareAgentRuntimeInitialization,
  prepareObjectAccessManifestGenesis,
  sealNamespaceKeyring,
  unixTimestamp,
  wrapObjectDekForNamespace,
  type GrantUseAuthorizationContext,
  type LatticeStorage,
  type Rng,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
  serializeGrantV2,
  serializeNamespaceBindingV2,
  serializeNamespaceKeyringEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import {
  createProtectedInvocationCapability,
  createProtectedInvocationRecipient,
  type ProtectedGrantAuthorityPort,
  type ProtectedInvocationCapability,
  type ProtectedInvocationCoordinates,
} from "../invocation/protected-grant-invocation.ts";
import {
  createProtectedAgentConversationSessionCryptoPreparer,
  type ProtectedAgentConversationSessionCryptoPreparer,
} from "../message/protected-agent-conversation-preparer.ts";
import {
  createPreparedConversationCryptoRevision,
} from "../message/conversation-prepared-revision.ts";
import type {
  PreparedConversationCryptoRevision,
} from "../message/conversation-repository.ts";
import {
  decodeMessagePayloadV2,
  encodeMessagePayloadV2,
  type MessagePayloadV2,
} from "../message/message-payload-v2.ts";
import { createFakeLatticeStorage } from "./fake-lattice-storage.ts";

const NOW = 1_800_000_000_000;
const AGENT_ID = "40000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "30000000-0000-4000-8000-000000000001";
const DOMAIN_ID = "domain-wave-9-agent-conversation";
const HUMAN_ID = "human-wave-9-owner";
const DEVICE_ID = "device-wave-9-owner";

export interface SyntheticProtectedAgentConversationCryptoHarness {
  readonly agentId: string;
  readonly namespaceId: string;
  readonly domainId: string;
  readonly humanId: string;
  readonly deviceId: string;
  readonly now: number;
  readonly expectedAccessRevision: number;
  readonly expectedPolicyRevision: number;
  readonly preparationTrace: readonly string[];
  readonly capability: ProtectedInvocationCapability;
  readonly crypto: LatticeCrypto;
  readonly preparer: ProtectedAgentConversationSessionCryptoPreparer;
  readonly storage: LatticeStorage;
  readonly prepareHumanRevision: (
    objectIdentity: string,
    payload: MessagePayloadV2,
    keyClass?: "ai" | "human",
  ) => PreparedConversationCryptoRevision;
  readonly readPayload: (
    objectIdentity: string,
  ) => Promise<MessagePayloadV2>;
}

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

/**
 * Complete test-only authority graph for one reusable foreground Agent
 * conversation Grant. The helper deliberately persists the same Namespace,
 * Runtime, signer publication, and Grant state consumed by production
 * preparation and Agent-v3 access CAS code.
 */
export async function createSyntheticProtectedAgentConversationCryptoHarness():
  Promise<SyntheticProtectedAgentConversationCryptoHarness> {
  const crypto = new LatticeCrypto(seededRng(0x237_99), {
    now: () => NOW,
  });
  const manager = crypto.generateSigningKeyPair();
  const issuer = crypto.generateSigningKeyPair();
  const domainRoot = new Uint8Array(32).fill(0x91);
  const { storage } = createFakeLatticeStorage();
  const participants = [humanId(HUMAN_ID)];
  const domainStatus = await storage.createDomainIfAbsent({
    id: cryptoDomainId(DOMAIN_ID),
    participantDigest: participantDigest(participants),
    participants,
    epoch: domainEpoch(2),
    authorizationRevision: authorizationRevision(7),
    rosterBytes: new Uint8Array([0x23, 0x79]),
  });
  if (domainStatus.status !== "created") {
    throw new Error("Synthetic Crypto Domain initialization failed");
  }

  const initialized = await prepareAgentRuntimeInitialization({
    crypto,
    operationId: "operation-wave-9-agent-runtime",
    agentId: agentId(AGENT_ID),
    authorizationRevision: authorizationRevision(7),
    configObjects: [{
      objectId: objectId("config-wave-9-agent"),
      configRevision: authorizationRevision(1),
      plaintextDek: new Uint8Array(32).fill(0x93),
    }],
    domains: [{
      domainId: cryptoDomainId(DOMAIN_ID),
      domainEpoch: domainEpoch(2),
      agentAuthorizationRevision: authorizationRevision(7),
      committerDeviceId: cryptoDeviceId(DEVICE_ID),
      domainRoot,
      committerSigningPrivateKey: manager.privateKey,
    }],
    resolveCurrentDomainCommitterAuthority: () => manager.publicKey,
    manager: {
      managerHumanId: humanId(HUMAN_ID),
      managerAuthorizationRevision: authorizationRevision(7),
      managerDeviceId: cryptoDeviceId(DEVICE_ID),
    },
    managerSigningPrivateKey: manager.privateKey,
    resolveCurrentManagerAuthority: () => manager.publicKey,
  });
  const runtimeStatus = await persistAgentRuntimeInitialization({
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
        managerHumanId: humanId(HUMAN_ID),
        managerAuthorizationRevision: authorizationRevision(7),
        managerDeviceId: cryptoDeviceId(DEVICE_ID),
      },
      currentManagerSigningPublicKey: manager.publicKey,
      domains: [{
        domainId: cryptoDomainId(DOMAIN_ID),
        domainEpoch: domainEpoch(2),
        agentAuthorizationRevision: authorizationRevision(7),
        committerDeviceId: cryptoDeviceId(DEVICE_ID),
        committerSigningPublicKey: manager.publicKey,
      }],
    }),
  });
  if (runtimeStatus !== "inserted") {
    throw new Error("Synthetic Agent Runtime initialization failed");
  }
  initialized.runtime.key.fill(0);

  const keyrings = createInitialNamespaceKeyrings(
    crypto,
    namespaceId(NAMESPACE_ID),
  );
  const namespaceMetadata = {
    domainId: cryptoDomainId(DOMAIN_ID),
    domainEpoch: domainEpoch(2),
    previousBindingHash: null,
    committerDeviceId: cryptoDeviceId(DEVICE_ID),
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
  const namespaceStatus = await persistNamespaceBinding({
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
  });
  if (namespaceStatus !== "applied") {
    throw new Error("Synthetic Namespace initialization failed");
  }

  const recipient = await createProtectedInvocationRecipient({
    crypto,
    recipientAgentId: agentId(AGENT_ID),
    recipientKeyId: "recipient-wave-9-agent",
  });
  const grant = await mintGrant(crypto, {
    id: grantId("grant-wave-9-agent"),
    issuingDeviceId: cryptoDeviceId(DEVICE_ID),
    issuingHumanId: humanId(HUMAN_ID),
    issuingDeviceSigningPrivateKey: issuer.privateKey,
    recipientAgentId: agentId(AGENT_ID),
    recipientKeyId: "recipient-wave-9-agent",
    recipientEncryptionPublicKey: recipient.publicKey,
    scope: [humanId(HUMAN_ID)],
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
  const grantBytes = serializeGrantV2(grant);
  await storage.putGrant(grantWriteRecord(grantBytes));
  const coordinates: ProtectedInvocationCoordinates = Object.freeze({
    invocationId: "invocation-wave-9-agent",
    grantId: grant.id,
    issuingHumanId: HUMAN_ID,
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
  const preparationTrace: string[] = [];
  const tracedStorageMethods = new Set<PropertyKey>([
    "getGrant",
    "consumeGrant",
    "getNamespaceHead",
    "getBinding",
    "getAgentRuntimeAtomicState",
    "getAgentRuntimeSignerPublication",
  ]);
  const preparationStorage = new Proxy(storage, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (
        typeof value !== "function"
        || !tracedStorageMethods.has(property)
      ) {
        return value;
      }
      const operationCall = value as (
        this: LatticeStorage,
        ...args: unknown[]
      ) => unknown;
      return async (...args: unknown[]) => {
        const operation = String(property);
        preparationTrace.push(`${operation}:started`);
        try {
          const result: unknown = await operationCall.apply(target, args);
          preparationTrace.push(
            `${operation}:${result === null ? "missing" : "resolved"}`,
          );
          return result;
        } catch (cause) {
          preparationTrace.push(
            `${operation}:threw:${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
          throw cause;
        }
      };
    },
  });
  const authority: ProtectedGrantAuthorityPort = {
    resolvePreflightFacts: (request) => {
      preparationTrace.push("authority.preflight");
      return {
        now: NOW + 3,
        expectedIssuingDeviceId: cryptoDeviceId(DEVICE_ID),
        issuingDeviceHumanId: humanId(HUMAN_ID),
        issuingDeviceSigningPublicKey: issuer.publicKey,
        issuingDeviceActive: true,
        recipientAgentId: agentId(AGENT_ID),
        recipientKeyId: "recipient-wave-9-agent",
        operation: request.operation,
        singleUseAvailable: true,
        namespaceId: namespaceId(NAMESPACE_ID),
        namespaceAccessRevision: accessRevision(0),
        namespaceParticipants: [humanId(HUMAN_ID)],
        domainId: cryptoDomainId(DOMAIN_ID),
        domainEpoch: domainEpoch(2),
        agentAuthorizationRevision: authorizationRevision(7),
        hostAllowsOperation: true,
      };
    },
    resolveCurrentAuthorization: (context) => {
      preparationTrace.push("authority.current");
      return allowGrant(context);
    },
  };
  const preparer =
    createProtectedAgentConversationSessionCryptoPreparer({
      crypto,
      storage: preparationStorage,
      authority,
      resolveHistoricalNamespaceCommitter: () => {
        preparationTrace.push("namespace.committer");
        return manager.publicKey;
      },
      resolveHistoricalRuntimeCommitter: () => {
        preparationTrace.push("runtime.committer");
        return manager.publicKey;
      },
      resolveCurrentObjectAuthorization: (context) => {
        preparationTrace.push("object.authorization");
        return {
          context,
          grantAuthorized: true,
          namespaceAuthorized: true,
          domainAuthorized: true,
          agentAuthorized: true,
          hostAllowsOperation: true,
          currentRuntime: {
            agentId: agentId(AGENT_ID),
            authorizationRevision: authorizationRevision(7),
            runtimeGeneration:
              initialized.signerPublication.runtimeGeneration,
          },
          signerPublication: initialized.signerPublication,
          currentManagerSigningPublicKey: manager.publicKey,
        };
      },
    });

  return Object.freeze({
    agentId: AGENT_ID,
    namespaceId: NAMESPACE_ID,
    domainId: DOMAIN_ID,
    humanId: HUMAN_ID,
    deviceId: DEVICE_ID,
    now: NOW,
    expectedAccessRevision: 0,
    expectedPolicyRevision: 7,
    preparationTrace,
    capability,
    crypto,
    preparer,
    storage,
    prepareHumanRevision(
      objectIdentity: string,
      payload: MessagePayloadV2,
      keyClass: "ai" | "human" = "ai",
    ): PreparedConversationCryptoRevision {
      if (payload.role !== "user") {
        throw new TypeError(
          "Synthetic Human conversation revision requires a user payload",
        );
      }
      const encrypted = encryptObjectPayload(
        crypto,
        {
          objectId: objectId(objectIdentity),
          keyClass,
          objectType: "nautilo-message-v2",
          createdAt: unixTimestamp(NOW),
        },
        encodeMessagePayloadV2(payload),
      );
      const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
      const keyring = keyClass === "ai" ? keyrings.ai : keyrings.human;
      const current = keyring.generations.find((generation) =>
        generation.generation === keyring.currentGeneration
      );
      if (current === undefined) {
        throw new Error("Synthetic Human Namespace key is unavailable");
      }
      const envelope = wrapObjectDekForNamespace(
        crypto,
        current.key,
        {
          objectId: objectId(objectIdentity),
          namespaceId: namespaceId(NAMESPACE_ID),
          keyClass,
          keyGeneration: namespaceGeneration(current.generation),
          bindingRevisionAtWrap: accessRevision(binding.accessRevision),
        },
        encrypted.dek,
      );
      encrypted.dek.fill(0);
      const envelopeBytes = encodeNamespaceObjectEnvelopeV2(envelope);
      const access = prepareObjectAccessManifestGenesis(crypto, {
        objectId: objectId(objectIdentity),
        payloadHash: crypto.hash(payloadBytes),
        envelopeBytes: [envelopeBytes],
        sourceAuthorized: true,
        targetAuthorized: true,
        committerDeviceId: cryptoDeviceId(DEVICE_ID),
        hostAuthorizationRevision: authorizationRevision(7),
        signingPrivateKey: issuer.privateKey,
      });
      return createPreparedConversationCryptoRevision({
        objectId: objectIdentity,
        namespaceId: NAMESPACE_ID,
        object: encryptedObjectWriteRecord(payloadBytes),
        access,
        resolveCurrentAuthorization: (context) => ({
          ...context,
          sourceAuthorized: true,
          targetAuthorized: true,
          currentHostAuthorizationRevision:
            context.hostAuthorizationRevision,
          committerSigningPublicKey: issuer.publicKey,
        }),
      });
    },
    async readPayload(objectIdentity: string): Promise<MessagePayloadV2> {
      const object = await storage.getObject(objectIdentity);
      const access = await storage.getObjectAccessState(objectIdentity);
      if (object === null || access === null) {
        throw new Error("Synthetic Agent message is not complete");
      }
      const envelope = access.namespaceEnvelopes.find((candidate) =>
        candidate.namespaceId === NAMESPACE_ID
      );
      if (envelope === undefined) {
        throw new Error("Synthetic Agent message envelope is missing");
      }
      const decodedEnvelope = decodeNamespaceObjectEnvelopeV2(
        envelope.envelopeBytes,
      );
      const keyring = decodedEnvelope.context.keyClass === "ai"
        ? keyrings.ai
        : keyrings.human;
      const generation = keyring.generations.find((candidate) =>
        candidate.generation === decodedEnvelope.context.keyGeneration
      );
      if (generation === undefined) {
        throw new Error("Synthetic conversation key generation is missing");
      }
      const plaintext = decryptObjectThroughNamespace(
        crypto,
        generation.key,
        decodedEnvelope,
        decodeEncryptedPayloadV2(object.payloadBytes),
      );
      if (plaintext === null) {
        throw new Error("Synthetic Agent message decryption failed");
      }
      try {
        return decodeMessagePayloadV2(plaintext);
      } finally {
        plaintext.fill(0);
      }
    },
  });
}
