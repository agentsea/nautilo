import { describe, expect, test } from "bun:test";

import {
  LatticeCrypto,
  accessRevision,
  agentId,
  authorizationRevision,
  createInitialNamespaceKeyrings,
  createNamespaceBinding,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  grantId,
  grantWriteRecord,
  humanId,
  mintGrant,
  namespaceBindingHash,
  namespaceId,
  persistNamespaceBinding,
  sealNamespaceKeyring,
  type GrantOperationAuthorization,
  type GrantUseAuthorizationContext,
  type GrantUseAuthorizationDecision,
  type Rng,
} from "@nautilo/lattice-crypto";
import {
  serializeGrantV2,
  serializeNamespaceBindingV2,
  serializeNamespaceKeyringEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import {
  createProtectedCheckpointNamespaceSessionContentExecutor,
} from "../../src/checkpoint/protected-checkpoint-cell-crypto";
import {
  createProtectedInvocationCapability,
  createProtectedInvocationRecipient,
  type ProtectedGrantAuthorityPort,
  type ProtectedInvocationCoordinates,
} from "../../src/invocation/protected-grant-invocation";
import {
  createFakeLatticeStorage,
} from "../../src/testing/fake-lattice-storage";

const NOW = 9_000_000;
const NAMESPACE_ID = "room-checkpoint";
const DOMAIN_ID = "domain-checkpoint";

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

function allowDecision(
  context: GrantUseAuthorizationContext,
): GrantUseAuthorizationDecision {
  return Object.freeze({
    context,
    currentTime: NOW + 2,
    issuingDeviceActive: true,
    recipientAgentAuthorized: true,
    requestedNamespacesAuthorized: true,
    requestedDomainsAuthorized: true,
    hostAllowsOperation: true,
    currentSingleUseStatus: context.singleUseStatus,
  });
}

async function fixture() {
  const crypto = new LatticeCrypto(seededRng(0x237_04), {
    now: () => NOW,
  });
  const issuer = crypto.generateSigningKeyPair();
  const { storage } = createFakeLatticeStorage();
  const aiRoot = new Uint8Array(32).fill(0x81);
  const humanRoot = new Uint8Array(32).fill(0x71);
  const keyrings = createInitialNamespaceKeyrings(
    crypto,
    namespaceId(NAMESPACE_ID),
  );
  const metadata = {
    domainId: cryptoDomainId(DOMAIN_ID),
    domainEpoch: domainEpoch(2),
    previousBindingHash: null,
    committerDeviceId: cryptoDeviceId("alice-device"),
  } as const;
  const humanEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: humanRoot,
    keyring: keyrings.human,
    metadata,
    committerSigningPrivateKey: issuer.privateKey,
    resolveCurrentCommitter: () => issuer.publicKey,
  });
  const aiEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: aiRoot,
    keyring: keyrings.ai,
    metadata,
    committerSigningPrivateKey: issuer.privateKey,
    resolveCurrentCommitter: () => issuer.publicKey,
  });
  const binding = createNamespaceBinding({
    crypto,
    humanEnvelope,
    aiEnvelope,
    committerSigningPrivateKey: issuer.privateKey,
    resolveCurrentCommitter: () => issuer.publicKey,
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
    resolveCurrentCommitter: () => issuer.publicKey,
  })).toBe("applied");

  const createdRecipient = await createProtectedInvocationRecipient({
    crypto,
    recipientAgentId: agentId("agent-checkpoint"),
    recipientKeyId: "checkpoint-recipient",
  });
  const grant = await mintGrant(crypto, {
    id: grantId("grant-checkpoint"),
    issuingDeviceId: cryptoDeviceId("alice-device"),
    issuingHumanId: humanId("alice"),
    issuingDeviceSigningPrivateKey: issuer.privateKey,
    recipientAgentId: agentId("agent-checkpoint"),
    recipientKeyId: "checkpoint-recipient",
    recipientEncryptionPublicKey: createdRecipient.publicKey,
    scope: [humanId("alice")],
    operations: ["decrypt", "encrypt"],
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
    coveredDomains: [{
      domainId: cryptoDomainId(DOMAIN_ID),
      domainEpoch: domainEpoch(2),
      agentAuthorizationRevision: authorizationRevision(8),
      aiRoot,
    }],
    singleUse: false,
  });
  await storage.putGrant(grantWriteRecord(serializeGrantV2(grant)));
  const coordinates: ProtectedInvocationCoordinates = Object.freeze({
    invocationId: "invocation-checkpoint",
    grantId: grant.id,
    issuingHumanId: "alice",
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
    recipient: createdRecipient.recipient,
  });
  const facts: Omit<
    GrantOperationAuthorization,
    "recipientEncryptionPrivateKey"
  > = Object.freeze({
    now: NOW + 1,
    expectedIssuingDeviceId: cryptoDeviceId("alice-device"),
    issuingDeviceHumanId: humanId("alice"),
    issuingDeviceSigningPublicKey: issuer.publicKey,
    issuingDeviceActive: true,
    recipientAgentId: agentId("agent-checkpoint"),
    recipientKeyId: "checkpoint-recipient",
    operation: "decrypt",
    singleUseAvailable: true,
    namespaceId: namespaceId(NAMESPACE_ID),
    namespaceAccessRevision: accessRevision(0),
    namespaceParticipants: [humanId("alice")],
    domainId: cryptoDomainId(DOMAIN_ID),
    domainEpoch: domainEpoch(2),
    agentAuthorizationRevision: authorizationRevision(8),
    hostAllowsOperation: true,
  });
  let preflightChecks = 0;
  let denyPostExecution = false;
  const authority: ProtectedGrantAuthorityPort = {
    resolvePreflightFacts: (request) => {
      preflightChecks += 1;
      if (denyPostExecution && preflightChecks > 1) return null;
      return Object.freeze({
        ...facts,
        operation: request.operation,
      });
    },
    resolveCurrentAuthorization: (context) => allowDecision(context),
  };
  const executor =
    createProtectedCheckpointNamespaceSessionContentExecutor({
      crypto,
      storage,
      authority,
      resolveHistoricalCommitter: () => issuer.publicKey,
    });
  return {
    capability,
    denyPostExecution() {
      denyPostExecution = true;
    },
    executor,
    keyrings,
    preflightChecks: () => preflightChecks,
  };
}

describe("protected checkpoint Namespace executor", () => {
  test("rejects a non-foreground entrypoint before opening authority", async () => {
    const state = await fixture();
    expect(await state.executor.execute({
      capability: state.capability,
      entrypointId: "task.execute" as never,
      operation: "decrypt",
      namespaceId: NAMESPACE_ID,
      domainId: DOMAIN_ID,
      expectedAccessRevision: 0,
      expectedPolicyRevision: 8,
      execute: () => "must-not-run",
    })).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });
    expect(state.preflightChecks()).toBe(0);
  });

  test("opens exact current AI material, rechecks authority, and wipes it", async () => {
    const state = await fixture();
    const captured: { borrowed: Uint8Array | null } = { borrowed: null };
    const result = await state.executor.execute({
      capability: state.capability,
      entrypointId: "foreground.main",
      operation: "decrypt",
      namespaceId: NAMESPACE_ID,
      domainId: DOMAIN_ID,
      expectedAccessRevision: 0,
      expectedPolicyRevision: 8,
      execute: (material) => {
        captured.borrowed = material.generations[0]!.key;
        expect(material.currentGeneration).toBe(0);
        expect(captured.borrowed).toEqual(
          state.keyrings.ai.generations[0]!.key,
        );
        return "opened";
      },
    });

    expect(result).toEqual({ status: "executed", value: "opened" });
    expect(state.preflightChecks()).toBe(2);
    expect(captured.borrowed).toEqual(new Uint8Array(32));
  });

  test("does not report success when current authority disappears after async work", async () => {
    const state = await fixture();
    state.denyPostExecution();
    let executed = false;
    const result = await state.executor.execute({
      capability: state.capability,
      entrypointId: "foreground.main",
      operation: "decrypt",
      namespaceId: NAMESPACE_ID,
      domainId: DOMAIN_ID,
      expectedAccessRevision: 0,
      expectedPolicyRevision: 8,
      execute: async () => {
        executed = true;
        await Promise.resolve();
      },
    });

    expect(executed).toBe(true);
    expect(result).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });
  });

  test("exposes a fresh in-callback authority fence for pre-COMMIT rollback", async () => {
    const state = await fixture();
    state.denyPostExecution();
    expect(state.executor.execute({
      capability: state.capability,
      entrypointId: "foreground.main",
      operation: "encrypt",
      namespaceId: NAMESPACE_ID,
      domainId: DOMAIN_ID,
      expectedAccessRevision: 0,
      expectedPolicyRevision: 8,
      execute: async (_material, assertCurrentAuthority) => {
        await assertCurrentAuthority();
        return "must-not-commit";
      },
    })).rejects.toThrow("authority changed");
    expect(state.preflightChecks()).toBe(2);
  });

  test("propagates checkpoint-store failure instead of misclassifying durability", async () => {
    const state = await fixture();
    const failure = new Error("checkpoint store unavailable");
    try {
      await state.executor.execute({
        capability: state.capability,
        entrypointId: "foreground.main",
        operation: "encrypt",
        namespaceId: NAMESPACE_ID,
        domainId: DOMAIN_ID,
        expectedAccessRevision: 0,
        expectedPolicyRevision: 8,
        execute: () => {
          throw failure;
        },
      });
      throw new Error("expected checkpoint failure to propagate");
    } catch (error) {
      expect(error).toBe(failure);
    }
  });
});
