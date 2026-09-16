import { describe, expect, test } from "bun:test";

import {
  LatticeCrypto,
  accessRevision,
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  grantId,
  grantWriteRecord,
  humanId,
  mintGrant,
  namespaceId,
  type GrantOperationAuthorization,
  type GrantUseAuthorizationContext,
  type GrantUseAuthorizationDecision,
  type Rng,
} from "@nautilo/lattice-crypto";
import { serializeGrantV2 } from "@nautilo/lattice-crypto/wire";

import {
  createProtectedInvocationRecipient,
  createProtectedInvocationCapability,
  destroyProtectedInvocationCapability,
  destroyProtectedInvocationRecipient,
  executeProtectedGrantCapabilityOperation,
  executeProtectedGrantSessionCapabilityOperation,
  executeProtectedGrantOperation,
  inspectProtectedInvocationCapability,
  type ProtectedGrantAuthorityPort,
  type ProtectedGrantOperationFacts,
  type ProtectedInvocationCoordinates,
} from "../../src/invocation/protected-grant-invocation";
import { createFakeLatticeStorage } from "../../src/testing/fake-lattice-storage";

const NOW = 5_000_000;

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

async function fixture(options: {
  readonly singleUse?: boolean;
  readonly seed?: number;
} = {}) {
  const crypto = new LatticeCrypto(
    seededRng(options.seed ?? 0x235_01),
    { now: () => NOW },
  );
  const issuer = crypto.generateSigningKeyPair();
  const createdRecipient = await createProtectedInvocationRecipient({
    crypto,
    recipientAgentId: agentId("genie"),
    recipientKeyId: "invocation-key",
  });
  const root = new Uint8Array(32).fill(0xab);
  const grant = await mintGrant(crypto, {
    id: grantId("grant-wave-8"),
    issuingDeviceId: cryptoDeviceId("alice-phone"),
    issuingHumanId: humanId("alice"),
    issuingDeviceSigningPrivateKey: issuer.privateKey,
    recipientAgentId: agentId("genie"),
    recipientKeyId: "invocation-key",
    recipientEncryptionPublicKey: createdRecipient.publicKey,
    scope: [humanId("alice")],
    operations: ["decrypt"],
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
    coveredDomains: [{
      domainId: cryptoDomainId("domain-alice"),
      domainEpoch: domainEpoch(4),
      agentAuthorizationRevision: authorizationRevision(8),
      aiRoot: root,
    }],
    singleUse: options.singleUse ?? true,
  });
  const { storage } = createFakeLatticeStorage();
  await storage.putGrant(grantWriteRecord(serializeGrantV2(grant)));

  const coordinates: ProtectedInvocationCoordinates = Object.freeze({
    invocationId: "invocation-wave-8",
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
  const facts: Omit<
    GrantOperationAuthorization,
    "recipientEncryptionPrivateKey"
  > = Object.freeze({
    now: NOW + 1,
    expectedIssuingDeviceId: cryptoDeviceId("alice-phone"),
    issuingDeviceHumanId: humanId("alice"),
    issuingDeviceSigningPublicKey: issuer.publicKey,
    issuingDeviceActive: true,
    recipientAgentId: agentId("genie"),
    recipientKeyId: "invocation-key",
    operation: "decrypt",
    singleUseAvailable: true,
    namespaceId: namespaceId("room-alice"),
    namespaceAccessRevision: accessRevision(3),
    namespaceParticipants: [humanId("alice")],
    domainId: cryptoDomainId("domain-alice"),
    domainEpoch: domainEpoch(4),
    agentAuthorizationRevision: authorizationRevision(8),
    hostAllowsOperation: true,
  });
  const phases: string[] = [];
  const authority: ProtectedGrantAuthorityPort = {
    resolvePreflightFacts: (request) => {
      phases.push(request.phase);
      return facts;
    },
    resolveCurrentAuthorization: (context) => {
      phases.push(context.phase);
      return allowDecision(context);
    },
  };

  return {
    authority,
    coordinates,
    createdRecipient,
    crypto,
    facts,
    phases,
    root,
    storage,
  };
}

describe("Wave 8 protected Grant invocation coordinator", () => {
  test("loads the canonical Grant and lends one Domain root only inside the callback", async () => {
    const state = await fixture();
    const capture: { root: Uint8Array | null } = { root: null };

    const result = await executeProtectedGrantOperation({
      crypto: state.crypto,
      storage: state.storage,
      coordinates: state.coordinates,
      recipient: state.createdRecipient.recipient,
      operation: "decrypt",
      authority: state.authority,
      execute: (opened) => {
        capture.root = opened.aiRoot;
        expect(opened.domainId).toBe(cryptoDomainId("domain-alice"));
        expect(opened.namespaceId).toBe(namespaceId("room-alice"));
        return "opened";
      },
    });

    expect(result).toEqual({ status: "executed", value: "opened" });
    expect(state.phases).toEqual([
      "preflight",
      "before-claim",
      "before-execute",
    ]);
    expect(capture.root).toEqual(new Uint8Array(32));
  });

  test("keeps recipient private material off enumerable and serializable objects", async () => {
    const state = await fixture();
    const recipient = state.createdRecipient.recipient;

    expect(Object.keys(recipient).sort()).toEqual([
      "recipientAgentId",
      "recipientKeyId",
    ]);
    expect(JSON.stringify(recipient)).toBe(
      '{"recipientAgentId":"genie","recipientKeyId":"invocation-key"}',
    );
    expect((Object.values(recipient) as unknown[]).some((value) =>
      value instanceof Uint8Array
    )).toBe(false);
  });

  test("creates an opaque invocation capability that rejects structural clones", async () => {
    const state = await fixture();
    const capability = createProtectedInvocationCapability({
      coordinates: state.coordinates,
      recipient: state.createdRecipient.recipient,
    });

    expect(inspectProtectedInvocationCapability(capability)).toEqual({
      domainIds: state.coordinates.domainIds,
      expiresAt: state.coordinates.expiresAt,
      grantId: state.coordinates.grantId,
      invocationId: state.coordinates.invocationId,
      issuedAt: state.coordinates.issuedAt,
      issuingHumanId: state.coordinates.issuingHumanId,
      issuingDeviceId: state.coordinates.issuingDeviceId,
      namespaceIds: state.coordinates.namespaceIds,
      recipientAgentId: state.coordinates.recipientAgentId,
      recipientKeyId: state.coordinates.recipientKeyId,
    });
    expect(Object.keys(capability).sort()).toEqual([
      "expiresAt",
      "invocationId",
    ]);
    expect(JSON.stringify(capability)).toBe(
      `{"invocationId":"${state.coordinates.invocationId}",`
        + `"expiresAt":${state.coordinates.expiresAt}}`,
    );

    const clone = {
      ...capability,
    } as typeof capability;
    expect(inspectProtectedInvocationCapability(clone)).toBeNull();
  });

  test("destroying an invocation capability destroys its recipient authority", async () => {
    const state = await fixture();
    const capability = createProtectedInvocationCapability({
      coordinates: state.coordinates,
      recipient: state.createdRecipient.recipient,
    });

    destroyProtectedInvocationCapability(capability);

    expect(inspectProtectedInvocationCapability(capability)).toBeNull();
    expect(await executeProtectedGrantOperation({
      crypto: state.crypto,
      storage: state.storage,
      coordinates: state.coordinates,
      recipient: state.createdRecipient.recipient,
      operation: "decrypt",
      authority: state.authority,
      execute: () => "must-not-run",
    })).toEqual({
      status: "unavailable",
      reason: "recipient_unavailable",
    });
  });

  test("terminal capability execution always destroys recipient custody", async () => {
    const state = await fixture();
    const capability = createProtectedInvocationCapability({
      coordinates: state.coordinates,
      recipient: state.createdRecipient.recipient,
    });

    expect(await executeProtectedGrantCapabilityOperation({
      capability,
      crypto: state.crypto,
      storage: state.storage,
      operation: "decrypt",
      authority: state.authority,
      execute: () => "opened",
    })).toEqual({
      status: "executed",
      value: "opened",
    });
    expect(inspectProtectedInvocationCapability(capability)).toBeNull();
  });

  test("reuses one recipient capability while reopening and wiping a reusable Grant per operation", async () => {
    const state = await fixture({ singleUse: false });
    const capability = createProtectedInvocationCapability({
      coordinates: state.coordinates,
      recipient: state.createdRecipient.recipient,
    });
    const borrowed: Uint8Array[] = [];

    for (const value of ["first", "second"]) {
      expect(await executeProtectedGrantSessionCapabilityOperation({
        capability,
        crypto: state.crypto,
        storage: state.storage,
        operation: "decrypt",
        namespaceId: "room-alice",
        domainId: "domain-alice",
        authority: state.authority,
        execute: (opened) => {
          borrowed.push(opened.aiRoot);
          return value;
        },
      })).toEqual({ status: "executed", value });
      expect(inspectProtectedInvocationCapability(capability)).not.toBeNull();
      expect(borrowed.at(-1)).toEqual(new Uint8Array(32));
    }

    expect(state.phases).toEqual([
      "preflight",
      "before-execute",
      "preflight",
      "before-execute",
    ]);
    expect(borrowed[0]).not.toBe(borrowed[1]);
    destroyProtectedInvocationCapability(capability);
    expect(inspectProtectedInvocationCapability(capability)).toBeNull();
  });

  test("refuses to retain a single-use Grant as a reusable session capability", async () => {
    const state = await fixture();
    const capability = createProtectedInvocationCapability({
      coordinates: state.coordinates,
      recipient: state.createdRecipient.recipient,
    });

    expect(await executeProtectedGrantSessionCapabilityOperation({
      capability,
      crypto: state.crypto,
      storage: state.storage,
      operation: "decrypt",
      namespaceId: "room-alice",
      domainId: "domain-alice",
      authority: state.authority,
      execute: () => "must-not-run",
    })).toEqual({
      status: "unavailable",
      reason: "grant_not_reusable",
    });
    expect(inspectProtectedInvocationCapability(capability)).not.toBeNull();
    expect(state.phases).toEqual([]);
    destroyProtectedInvocationCapability(capability);
  });

  test("binds reusable execution to the exact Human, Namespace, and Domain", async () => {
    for (const mismatch of [
      {
        coordinates: {},
        target: { namespaceId: "room-other", domainId: "domain-alice" },
      },
      {
        coordinates: {},
        target: { namespaceId: "room-alice", domainId: "domain-other" },
      },
      {
        coordinates: { issuingHumanId: "mallory" },
        target: { namespaceId: "room-alice", domainId: "domain-alice" },
      },
    ] as const) {
      const state = await fixture({ singleUse: false });
      const capability = createProtectedInvocationCapability({
        coordinates: Object.freeze({
          ...state.coordinates,
          ...mismatch.coordinates,
        }),
        recipient: state.createdRecipient.recipient,
      });

      expect(await executeProtectedGrantSessionCapabilityOperation({
        capability,
        crypto: state.crypto,
        storage: state.storage,
        operation: "decrypt",
        ...mismatch.target,
        authority: state.authority,
        execute: () => "must-not-run",
      })).toEqual({
        status: "unavailable",
        reason: "authorization_unavailable",
      });
      destroyProtectedInvocationCapability(capability);
    }
  });

  test("fails closed when fresh authorization disappears after the atomic claim", async () => {
    const state = await fixture();
    let currentChecks = 0;
    let executed = false;

    const result = await executeProtectedGrantOperation({
      crypto: state.crypto,
      storage: state.storage,
      coordinates: state.coordinates,
      recipient: state.createdRecipient.recipient,
      operation: "decrypt",
      authority: {
        ...state.authority,
        resolveCurrentAuthorization: (context) => {
          currentChecks += 1;
          return currentChecks === 1 ? allowDecision(context) : null;
        },
      },
      execute: () => {
        executed = true;
      },
    });

    expect(result).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });
    expect(executed).toBe(false);
    expect(await state.storage.getGrant(state.coordinates.grantId))
      .toMatchObject({ consumed: true });
  });

  test("rejects a forged or mismatched recipient before authorization", async () => {
    const state = await fixture();
    const other = await createProtectedInvocationRecipient({
      crypto: state.crypto,
      recipientAgentId: agentId("other-agent"),
      recipientKeyId: "other-key",
    });

    const result = await executeProtectedGrantOperation({
      crypto: state.crypto,
      storage: state.storage,
      coordinates: state.coordinates,
      recipient: other.recipient,
      operation: "decrypt",
      authority: state.authority,
      execute: () => "must-not-run",
    });

    expect(result).toEqual({
      status: "unavailable",
      reason: "recipient_unavailable",
    });
    expect(state.phases).toEqual([]);
    destroyProtectedInvocationRecipient(other.recipient);
  });

  test("allows exactly one of two concurrent single-use executions", async () => {
    const state = await fixture();
    let executions = 0;
    const execute = () => {
      executions += 1;
      return executions;
    };
    const request = {
      crypto: state.crypto,
      storage: state.storage,
      coordinates: state.coordinates,
      recipient: state.createdRecipient.recipient,
      operation: "decrypt" as const,
      authority: state.authority,
      execute,
    };

    const results = await Promise.all([
      executeProtectedGrantOperation(request),
      executeProtectedGrantOperation(request),
    ]);

    expect(results.filter((result) => result.status === "executed"))
      .toHaveLength(1);
    expect(results.filter((result) => result.status === "unavailable"))
      .toHaveLength(1);
    expect(executions).toBe(1);
  });

  test("destroys a recipient explicitly and never reconstructs its key", async () => {
    const state = await fixture();
    destroyProtectedInvocationRecipient(state.createdRecipient.recipient);

    const result = await executeProtectedGrantOperation({
      crypto: state.crypto,
      storage: state.storage,
      coordinates: state.coordinates,
      recipient: state.createdRecipient.recipient,
      operation: "decrypt",
      authority: state.authority,
      execute: () => "must-not-run",
    });

    expect(result).toEqual({
      status: "unavailable",
      reason: "recipient_unavailable",
    });
  });

  test("rejects widened or noncanonical durable coordinates before Grant use", async () => {
    const state = await fixture();
    const widened = Object.freeze({
      ...state.coordinates,
      domainIds: Object.freeze(["domain-other", "domain-alice"]),
    });

    const result = await executeProtectedGrantOperation({
      crypto: state.crypto,
      storage: state.storage,
      coordinates: widened,
      recipient: state.createdRecipient.recipient,
      operation: "decrypt",
      authority: state.authority,
      execute: () => "must-not-run",
    });

    expect(result).toEqual({
      status: "unavailable",
      reason: "coordinates_invalid",
    });
    expect(state.phases).toEqual([]);
  });

  test("rejects canonically widened coordinates not covered by the Grant", async () => {
    const state = await fixture();
    const widened = Object.freeze({
      ...state.coordinates,
      domainIds: Object.freeze(["domain-alice", "domain-other"]),
    });

    const result = await executeProtectedGrantOperation({
      crypto: state.crypto,
      storage: state.storage,
      coordinates: widened,
      recipient: state.createdRecipient.recipient,
      operation: "decrypt",
      authority: state.authority,
      execute: () => "must-not-run",
    });

    expect(result).toEqual({
      status: "unavailable",
      reason: "grant_invalid",
    });
    expect(state.phases).toEqual([]);
  });

  test("rejects stale, inactive, wrong-operation, and wrong-revision facts", async () => {
    const mutations: ReadonlyArray<
      (facts: ProtectedGrantOperationFacts) => ProtectedGrantOperationFacts
    > = [
      (facts) => ({ ...facts, now: NOW + 60_000 }),
      (facts) => ({
        ...facts,
        issuingDeviceActive: false,
      }),
      (facts) => ({
        ...facts,
        operation: "encrypt" as const,
      }),
      (facts) => ({
        ...facts,
        agentAuthorizationRevision: authorizationRevision(9),
      }),
    ];

    for (const mutate of mutations) {
      const state = await fixture({ seed: 0x235_02 });
      const result = await executeProtectedGrantOperation({
        crypto: state.crypto,
        storage: state.storage,
        coordinates: state.coordinates,
        recipient: state.createdRecipient.recipient,
        operation: "decrypt",
        authority: {
          ...state.authority,
          resolvePreflightFacts: () => mutate(state.facts),
        },
        execute: () => "must-not-run",
      });

      expect(result).toEqual({
        status: "unavailable",
        reason: "authorization_unavailable",
      });
    }
  });

  test("rejects replay after a successful single-use execution", async () => {
    const state = await fixture();
    const request = {
      crypto: state.crypto,
      storage: state.storage,
      coordinates: state.coordinates,
      recipient: state.createdRecipient.recipient,
      operation: "decrypt" as const,
      authority: state.authority,
      execute: () => "opened",
    };

    expect(await executeProtectedGrantOperation(request)).toEqual({
      status: "executed",
      value: "opened",
    });
    expect(await executeProtectedGrantOperation(request)).toEqual({
      status: "unavailable",
      reason: "grant_consumed",
    });
  });

  test("wipes the lent Domain root when protected execution throws", async () => {
    const state = await fixture();
    const capture: { root: Uint8Array | null } = { root: null };

    let failure: unknown;
    try {
      await executeProtectedGrantOperation({
        crypto: state.crypto,
        storage: state.storage,
        coordinates: state.coordinates,
        recipient: state.createdRecipient.recipient,
        operation: "decrypt",
        authority: state.authority,
        execute: (opened) => {
          capture.root = opened.aiRoot;
          throw new Error("synthetic protected failure");
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toEqual(new Error("synthetic protected failure"));
    expect(capture.root).toEqual(new Uint8Array(32));
  });
});
