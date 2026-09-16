import { describe, expect, test } from "bun:test";

import {
  LatticeCrypto,
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  encryptedObjectWriteRecord,
  encryptObjectPayload,
  grantId,
  grantWriteRecord,
  humanId,
  mintGrant,
  namespaceId,
  objectId,
  persistAgentRuntimeInitialization,
  prepareAgentRuntimeInitialization,
  unixTimestamp,
  type OpenedGrantDomain,
  type Rng,
} from "@nautilo/lattice-crypto";
import {
  encodeEncryptedPayloadV2,
  serializeGrantV2,
} from "@nautilo/lattice-crypto/wire";

import {
  executeProtectedAgentRuntimeCapabilityOperation,
  executeProtectedAgentRuntimeSessionCapabilityOperation,
  withProtectedAgentRuntimeConfiguration,
} from "../../src/invocation/protected-agent-runtime";
import {
  createProtectedInvocationCapability,
  createProtectedInvocationRecipient,
  destroyProtectedInvocationCapability,
  inspectProtectedInvocationCapability,
  type ProtectedGrantAuthorityPort,
  type ProtectedInvocationCoordinates,
} from "../../src/invocation/protected-grant-invocation";
import { createFakeLatticeStorage } from "../../src/testing/fake-lattice-storage";

const CONFIG_CANARY = "WAVE8-SYNTHETIC-SOUL-CONFIG-CANARY";

function seededRng(seed: number): Rng {
  let state = seed >>> 0 || 0x9e3779b9;
  return {
    bytes(length: number): Uint8Array {
      const value = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        value[index] = state & 0xff;
      }
      return value;
    },
  };
}

async function fixture(options: Readonly<{
  readonly singleUse?: boolean;
}> = {}) {
  const crypto = new LatticeCrypto(
    seededRng(0x235_30),
    { now: () => 5_000_000 },
  );
  const signing = crypto.generateSigningKeyPair();
  const domainRoot = new Uint8Array(32).fill(0x53);
  const plaintext = new TextEncoder().encode(CONFIG_CANARY);
  const encrypted = encryptObjectPayload(
    crypto,
    {
      objectId: objectId("synthetic-runtime-config"),
      keyClass: "ai",
      objectType: "synthetic-agent-runtime-config",
      createdAt: unixTimestamp(5_000_000),
    },
    plaintext,
  );
  const prepared = await prepareAgentRuntimeInitialization({
    crypto,
    operationId: "operation-synthetic-runtime-initialization",
    agentId: agentId("genie"),
    authorizationRevision: authorizationRevision(8),
    configObjects: [{
      objectId: objectId("synthetic-runtime-config"),
      configRevision: authorizationRevision(3),
      plaintextDek: encrypted.dek,
    }],
    domains: [{
      domainId: cryptoDomainId("domain-alice"),
      domainEpoch: domainEpoch(4),
      agentAuthorizationRevision: authorizationRevision(8),
      committerDeviceId: cryptoDeviceId("alice-phone"),
      domainRoot,
      committerSigningPrivateKey: signing.privateKey,
    }],
    resolveCurrentDomainCommitterAuthority: () => signing.publicKey,
    manager: {
      managerHumanId: humanId("alice"),
      managerAuthorizationRevision: authorizationRevision(8),
      managerDeviceId: cryptoDeviceId("alice-phone"),
    },
    managerSigningPrivateKey: signing.privateKey,
    resolveCurrentManagerAuthority: () => signing.publicKey,
  });
  encrypted.dek.fill(0);

  const { storage } = createFakeLatticeStorage();
  expect(await persistAgentRuntimeInitialization({
    crypto,
    storage,
    prepared,
    resolveCurrentAuthorization: () => ({
      currentState: {
        agentId: agentId("genie"),
        authorizationRevision: authorizationRevision(8),
        runtimeGeneration: agentRuntimeGeneration(0),
      },
      currentManager: {
        managerHumanId: humanId("alice"),
        managerAuthorizationRevision: authorizationRevision(8),
        managerDeviceId: cryptoDeviceId("alice-phone"),
      },
      currentManagerSigningPublicKey: signing.publicKey,
      domains: [{
        domainId: cryptoDomainId("domain-alice"),
        domainEpoch: domainEpoch(4),
        agentAuthorizationRevision: authorizationRevision(8),
        committerDeviceId: cryptoDeviceId("alice-phone"),
        committerSigningPublicKey: signing.publicKey,
      }],
    }),
  })).toBe("inserted");
  prepared.runtime.key.fill(0);

  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  await storage.putObject(encryptedObjectWriteRecord(payloadBytes));
  encrypted.payload.ciphertext.fill(0);
  payloadBytes.fill(0);
  plaintext.fill(0);

  const issuer = crypto.generateSigningKeyPair();
  const createdRecipient = await createProtectedInvocationRecipient({
    crypto,
    recipientAgentId: agentId("genie"),
    recipientKeyId: "runtime-invocation-key",
  });
  const grant = await mintGrant(crypto, {
    id: grantId("grant-wave-8"),
    issuingDeviceId: cryptoDeviceId("alice-phone"),
    issuingHumanId: humanId("alice"),
    issuingDeviceSigningPrivateKey: issuer.privateKey,
    recipientAgentId: agentId("genie"),
    recipientKeyId: "runtime-invocation-key",
    recipientEncryptionPublicKey: createdRecipient.publicKey,
    scope: [humanId("alice")],
    operations: ["decrypt"],
    issuedAt: 5_000_000,
    expiresAt: 5_060_000,
    coveredDomains: [{
      domainId: cryptoDomainId("domain-alice"),
      domainEpoch: domainEpoch(4),
      agentAuthorizationRevision: authorizationRevision(8),
      aiRoot: domainRoot,
    }],
    singleUse: options.singleUse ?? true,
  });
  await storage.putGrant(grantWriteRecord(serializeGrantV2(grant)));
  const coordinates: ProtectedInvocationCoordinates = Object.freeze({
    invocationId: "runtime-invocation",
    grantId: grant.id,
    issuingHumanId: "alice",
    recipientAgentId: grant.recipientAgentId,
    recipientKeyId: grant.recipientKeyId,
    issuingDeviceId: grant.issuingDeviceId,
    namespaceIds: Object.freeze(["room-alice"]),
    domainIds: Object.freeze(["domain-alice"]),
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
  });
  const capability = createProtectedInvocationCapability({
    coordinates,
    recipient: createdRecipient.recipient,
  });
  const authority: ProtectedGrantAuthorityPort = {
    resolvePreflightFacts: () => ({
      now: 5_000_001,
      expectedIssuingDeviceId: cryptoDeviceId("alice-phone"),
      issuingDeviceHumanId: humanId("alice"),
      issuingDeviceSigningPublicKey: issuer.publicKey,
      issuingDeviceActive: true,
      recipientAgentId: agentId("genie"),
      recipientKeyId: "runtime-invocation-key",
      operation: "decrypt",
      singleUseAvailable: true,
      namespaceId: namespaceId("room-alice"),
      namespaceAccessRevision: accessRevision(3),
      namespaceParticipants: [humanId("alice")],
      domainId: cryptoDomainId("domain-alice"),
      domainEpoch: domainEpoch(4),
      agentAuthorizationRevision: authorizationRevision(8),
      hostAllowsOperation: true,
    }),
    resolveCurrentAuthorization: (context) => ({
      context,
      currentTime: 5_000_002,
      issuingDeviceActive: true,
      recipientAgentAuthorized: true,
      requestedNamespacesAuthorized: true,
      requestedDomainsAuthorized: true,
      hostAllowsOperation: true,
      currentSingleUseStatus: context.singleUseStatus,
    }),
  };

  const opened: OpenedGrantDomain = Object.freeze({
    grantId: grantId("grant-wave-8"),
    namespaceId: namespaceId("room-alice"),
    namespaceAccessRevision: accessRevision(3),
    domainId: cryptoDomainId("domain-alice"),
    domainEpoch: domainEpoch(4),
    agentAuthorizationRevision: authorizationRevision(8),
    aiRoot: domainRoot.slice(),
  });

  return {
    authority,
    capability,
    crypto,
    opened,
    signing,
    storage,
  };
}

describe("Wave 8 transient protected Agent Runtime loading", () => {
  test("binds the Grant recipient Agent to the Runtime configuration it opens", async () => {
    const state = await fixture();
    const result = await executeProtectedAgentRuntimeCapabilityOperation({
      capability: state.capability,
      crypto: state.crypto,
      storage: state.storage,
      operation: "decrypt",
      authority: state.authority,
      agentId: agentId("genie"),
      objectId: objectId("synthetic-runtime-config"),
      expectedObjectType: "synthetic-agent-runtime-config",
      resolveHistoricalCommitter: () => state.signing.publicKey,
      execute: (plaintext) => new TextDecoder().decode(plaintext),
    });
    expect(result).toEqual({
      status: "executed",
      value: CONFIG_CANARY,
    });
    expect(inspectProtectedInvocationCapability(state.capability))
      .toBeNull();

    const other = await fixture();
    expect(await executeProtectedAgentRuntimeCapabilityOperation({
      capability: other.capability,
      crypto: other.crypto,
      storage: other.storage,
      operation: "decrypt",
      authority: other.authority,
      agentId: agentId("other-agent"),
      objectId: objectId("synthetic-runtime-config"),
      expectedObjectType: "synthetic-agent-runtime-config",
      resolveHistoricalCommitter: () => other.signing.publicKey,
      execute: () => "must-not-run",
    })).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });
    expect(inspectProtectedInvocationCapability(other.capability))
      .toBeNull();
  });

  test("reopens Runtime configuration through one reusable foreground recipient", async () => {
    const state = await fixture({ singleUse: false });

    for (const expected of ["first", "second"]) {
      expect(await executeProtectedAgentRuntimeSessionCapabilityOperation({
        capability: state.capability,
        crypto: state.crypto,
        storage: state.storage,
        operation: "decrypt",
        namespaceId: "room-alice",
        domainId: "domain-alice",
        authority: state.authority,
        agentId: agentId("genie"),
        objectId: objectId("synthetic-runtime-config"),
        expectedObjectType: "synthetic-agent-runtime-config",
        resolveHistoricalCommitter: () => state.signing.publicKey,
        execute: (plaintext) => {
          expect(new TextDecoder().decode(plaintext))
            .toBe(CONFIG_CANARY);
          return expected;
        },
      })).toEqual({ status: "executed", value: expected });
      expect(inspectProtectedInvocationCapability(state.capability))
        .not.toBeNull();
    }
    destroyProtectedInvocationCapability(state.capability);
  });

  test("opens current synthetic configuration only inside the callback and wipes it", async () => {
    const state = await fixture();
    const capture: { plaintext: Uint8Array | null } = { plaintext: null };

    const result = await withProtectedAgentRuntimeConfiguration({
      crypto: state.crypto,
      storage: state.storage,
      opened: state.opened,
      agentId: agentId("genie"),
      objectId: objectId("synthetic-runtime-config"),
      expectedObjectType: "synthetic-agent-runtime-config",
      resolveHistoricalCommitter: () => state.signing.publicKey,
      execute: (plaintext) => {
        capture.plaintext = plaintext;
        expect(new TextDecoder().decode(plaintext)).toBe(CONFIG_CANARY);
        return "model-dispatched";
      },
    });

    expect(result).toEqual({
      status: "executed",
      value: "model-dispatched",
    });
    expect(capture.plaintext).toEqual(new Uint8Array(CONFIG_CANARY.length));
    expect(JSON.stringify(result)).not.toContain(CONFIG_CANARY);
  });

  test("rejects stale Domain authorization before opening configuration", async () => {
    const state = await fixture();
    let executed = false;
    const staleOpened = Object.freeze({
      ...state.opened,
      agentAuthorizationRevision: authorizationRevision(9),
    });

    const result = await withProtectedAgentRuntimeConfiguration({
      crypto: state.crypto,
      storage: state.storage,
      opened: staleOpened,
      agentId: agentId("genie"),
      objectId: objectId("synthetic-runtime-config"),
      expectedObjectType: "synthetic-agent-runtime-config",
      resolveHistoricalCommitter: () => state.signing.publicKey,
      execute: () => {
        executed = true;
      },
    });

    expect(result).toEqual({
      status: "unavailable",
      reason: "runtime_unavailable",
    });
    expect(executed).toBe(false);
  });

  test("wipes configuration even when the bounded callback throws", async () => {
    const state = await fixture();
    const capture: { plaintext: Uint8Array | null } = { plaintext: null };
    let failure: unknown;

    try {
      await withProtectedAgentRuntimeConfiguration({
        crypto: state.crypto,
        storage: state.storage,
        opened: state.opened,
        agentId: agentId("genie"),
        objectId: objectId("synthetic-runtime-config"),
        expectedObjectType: "synthetic-agent-runtime-config",
        resolveHistoricalCommitter: () => state.signing.publicKey,
        execute: (plaintext) => {
          capture.plaintext = plaintext;
          throw new Error("synthetic model failure");
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toEqual(new Error("synthetic model failure"));
    expect(capture.plaintext).toEqual(new Uint8Array(CONFIG_CANARY.length));
  });

  test("rejects a missing historical committer and wrong object type", async () => {
    const state = await fixture();
    const base = {
      crypto: state.crypto,
      storage: state.storage,
      opened: state.opened,
      agentId: agentId("genie"),
      objectId: objectId("synthetic-runtime-config"),
      execute: () => "must-not-run",
    } as const;

    expect(await withProtectedAgentRuntimeConfiguration({
      ...base,
      expectedObjectType: "synthetic-agent-runtime-config",
      resolveHistoricalCommitter: () => null,
    })).toEqual({
      status: "unavailable",
      reason: "runtime_unavailable",
    });
    expect(await withProtectedAgentRuntimeConfiguration({
      ...base,
      expectedObjectType: "different-object-type",
      resolveHistoricalCommitter: () => state.signing.publicKey,
    })).toEqual({
      status: "unavailable",
      reason: "configuration_invalid",
    });
  });

  test("rejects tampered Runtime envelope bytes before decryption", async () => {
    const state = await fixture();
    const original = await state.storage.getAgentRuntimeAtomicState("genie");
    if (original === null) throw new Error("missing Runtime fixture");
    const tampered = structuredClone(original);
    const envelopeBytes = tampered.domainEnvelopes[0]!.envelopeBytes;
    envelopeBytes[0] = envelopeBytes[0]! ^ 0xff;

    const result = await withProtectedAgentRuntimeConfiguration({
      crypto: state.crypto,
      storage: {
        getAgentRuntimeAtomicState: async () => tampered,
        getObject: state.storage.getObject.bind(state.storage),
      },
      opened: state.opened,
      agentId: agentId("genie"),
      objectId: objectId("synthetic-runtime-config"),
      expectedObjectType: "synthetic-agent-runtime-config",
      resolveHistoricalCommitter: () => state.signing.publicKey,
      execute: () => "must-not-run",
    });

    expect(result).toEqual({
      status: "unavailable",
      reason: "runtime_unavailable",
    });
  });
});
