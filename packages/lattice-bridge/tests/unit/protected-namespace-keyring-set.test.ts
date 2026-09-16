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
  type GrantAuthoritySetUseAuthorizationContext,
  type GrantAuthoritySetUseAuthorizationDecision,
  type OpenedGrantAuthoritySet,
  type Rng,
} from "@nautilo/lattice-crypto";
import {
  serializeGrantV2,
  serializeNamespaceBindingV2,
  serializeNamespaceKeyringEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import {
  createProtectedInvocationCapability,
  createProtectedInvocationRecipient,
  executeProtectedGrantSessionAuthoritySetCapabilityOperationV2,
  inspectProtectedInvocationCapability,
  type ProtectedGrantAuthoritySetFactsV2,
  type ProtectedGrantAuthoritySetPortV2,
} from "../../src/invocation/protected-grant-invocation";
import {
  withProtectedCurrentNamespaceKeyringSet,
} from "../../src/invocation/protected-namespace-keyring";
import { createFakeLatticeStorage } from "../../src/testing/fake-lattice-storage";

const NOW = 8_700_000;
const RUNTIME_AUTHORIZATION_REVISION = 31;

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

function allow(
  context: GrantAuthoritySetUseAuthorizationContext,
): GrantAuthoritySetUseAuthorizationDecision {
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
  const crypto = new LatticeCrypto(seededRng(14_001), { now: () => NOW });
  const issuer = crypto.generateSigningKeyPair();
  const { storage } = createFakeLatticeStorage();
  const roots = Object.freeze({
    "domain-a": new Uint8Array(32).fill(0xa1),
    "domain-b": new Uint8Array(32).fill(0xb2),
  });
  const keyrings = new Map<string, ReturnType<typeof createInitialNamespaceKeyrings>>();
  for (const item of [
    { namespaceId: "room-a", domainId: "domain-a", epoch: 4 },
    { namespaceId: "room-b", domainId: "domain-a", epoch: 4 },
    { namespaceId: "room-c", domainId: "domain-b", epoch: 5 },
  ] as const) {
    const created = createInitialNamespaceKeyrings(
      crypto,
      namespaceId(item.namespaceId),
    );
    keyrings.set(item.namespaceId, created);
    const metadata = {
      domainId: cryptoDomainId(item.domainId),
      domainEpoch: domainEpoch(item.epoch),
      previousBindingHash: null,
      committerDeviceId: cryptoDeviceId("alice-device"),
    } as const;
    const humanEnvelope = sealNamespaceKeyring({
      crypto,
      domainRoot: new Uint8Array(32).fill(item.epoch),
      keyring: created.human,
      metadata,
      committerSigningPrivateKey: issuer.privateKey,
      resolveCurrentCommitter: () => issuer.publicKey,
    });
    const aiEnvelope = sealNamespaceKeyring({
      crypto,
      domainRoot: roots[item.domainId],
      keyring: created.ai,
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
  }

  const recipient = await createProtectedInvocationRecipient({
    crypto,
    recipientAgentId: agentId("genie"),
    recipientKeyId: "foreground-set-key",
  });
  const grant = await mintGrant(crypto, {
    id: grantId("grant-keyring-set"),
    issuingDeviceId: cryptoDeviceId("alice-device"),
    issuingHumanId: humanId("alice"),
    issuingDeviceSigningPrivateKey: issuer.privateKey,
    recipientAgentId: agentId("genie"),
    recipientKeyId: "foreground-set-key",
    recipientEncryptionPublicKey: recipient.publicKey,
    scope: [humanId("alice")],
    operations: ["decrypt", "encrypt"],
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
    coveredDomains: [
      {
        domainId: cryptoDomainId("domain-a"),
        domainEpoch: domainEpoch(4),
        agentAuthorizationRevision: authorizationRevision(21),
        aiRoot: roots["domain-a"],
      },
      {
        domainId: cryptoDomainId("domain-b"),
        domainEpoch: domainEpoch(5),
        agentAuthorizationRevision: authorizationRevision(22),
        aiRoot: roots["domain-b"],
      },
    ],
    singleUse: false,
  });
  await storage.putGrant(grantWriteRecord(serializeGrantV2(grant)));
  const capability = createProtectedInvocationCapability({
    coordinates: Object.freeze({
      invocationId: "invocation-keyring-set",
      grantId: grant.id,
      issuingHumanId: "alice",
      recipientAgentId: grant.recipientAgentId,
      recipientKeyId: grant.recipientKeyId,
      issuingDeviceId: grant.issuingDeviceId,
      namespaceIds: Object.freeze(["room-a", "room-b", "room-c"]),
      domainIds: Object.freeze(["domain-a", "domain-b"]),
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
    }),
    recipient: recipient.recipient,
  });
  const baseFacts: ProtectedGrantAuthoritySetFactsV2 = Object.freeze({
    now: NOW + 1,
    expectedIssuingDeviceId: "alice-device",
    issuingDeviceHumanId: "alice",
    issuingDeviceSigningPublicKey: issuer.publicKey,
    issuingDeviceActive: true,
    recipientAgentId: "genie",
    recipientKeyId: "foreground-set-key",
    singleUseAvailable: true,
    grantScope: ["alice"],
    namespaceRequirements: [
      {
        namespaceId: namespaceId("room-a"),
        domainId: cryptoDomainId("domain-a"),
        operations: ["decrypt", "encrypt"] as const,
        namespaceParticipants: ["alice"],
        expectedAccessRevision: accessRevision(0),
        expectedPolicyRevision: 11,
      },
      {
        namespaceId: namespaceId("room-b"),
        domainId: cryptoDomainId("domain-a"),
        operations: ["decrypt", "encrypt"] as const,
        namespaceParticipants: ["alice"],
        expectedAccessRevision: accessRevision(0),
        expectedPolicyRevision: 12,
      },
      {
        namespaceId: namespaceId("room-c"),
        domainId: cryptoDomainId("domain-b"),
        operations: ["decrypt", "encrypt"] as const,
        namespaceParticipants: ["alice", "bob"],
        expectedAccessRevision: accessRevision(0),
        expectedPolicyRevision: 13,
      },
    ],
    domainRequirements: [
      {
        domainId: cryptoDomainId("domain-a"),
        expectedEpoch: domainEpoch(4),
        expectedAgentAuthorizationRevision: authorizationRevision(21),
      },
      {
        domainId: cryptoDomainId("domain-b"),
        expectedEpoch: domainEpoch(5),
        expectedAgentAuthorizationRevision: authorizationRevision(22),
      },
    ],
    hostAllowsOperation: true,
  });
  let facts = baseFacts;
  let runtimeRevision = RUNTIME_AUTHORIZATION_REVISION;
  let preflightChecks = 0;
  let runtimeChecks = 0;
  const authority: ProtectedGrantAuthoritySetPortV2 = {
    resolvePreflightFacts: () => {
      preflightChecks += 1;
      return facts;
    },
    resolveCurrentAuthorization: (context) => allow(context),
  };
  const keyringStorage = {
    getNamespaceHead: (id: string) => storage.getNamespaceHead(id),
    getBinding: (id: string, revision: number) =>
      storage.getBinding(id, revision),
    getAgentRuntimeAtomicState: async (id: string) => {
      runtimeChecks += 1;
      return {
        runtime: {
          agentId: id,
          authorizationRevision: runtimeRevision,
        },
      } as never;
    },
  };
  return {
    authority,
    baseFacts,
    capability,
    crypto,
    grant,
    issuer,
    keyringStorage,
    keyrings,
    preflightChecks: () => preflightChecks,
    roots,
    runtimeChecks: () => runtimeChecks,
    setFacts(value: ProtectedGrantAuthoritySetFactsV2) {
      facts = value;
    },
    setRuntimeRevision(value: number) {
      runtimeRevision = value;
    },
    storage,
  };
}

async function executeSet<Value>(
  state: Awaited<ReturnType<typeof fixture>>,
  execute: (opened: OpenedGrantAuthoritySet) => Value | PromiseLike<Value>,
) {
  return executeProtectedGrantSessionAuthoritySetCapabilityOperationV2({
    capability: state.capability,
    crypto: state.crypto,
    storage: state.storage,
    authority: state.authority,
    execute,
  });
}

describe("protected current Namespace keyring set", () => {
  test("opens an exact cross-Domain subset, separates every revision, revalidates, and wipes", async () => {
    const state = await fixture();
    const capability = inspectProtectedInvocationCapability(state.capability);
    if (capability === null) throw new Error("capability unavailable");
    const borrowedKeys: Uint8Array[] = [];
    const borrowedRoots: Uint8Array[] = [];
    const result = await executeSet(state, (opened) => {
      borrowedRoots.push(...opened.domains.map((entry) => entry.aiRoot));
      return withProtectedCurrentNamespaceKeyringSet({
        crypto: state.crypto,
        storage: state.keyringStorage,
        authority: state.authority,
        resolveHistoricalCommitter: () => state.issuer.publicKey,
        capability,
        opened,
        operation: "decrypt",
        requestedNamespaceIds: ["room-a", "room-c"],
        viewDomainIds: ["domain-a", "domain-b"],
        expectedRuntimeAuthorizationRevision:
          RUNTIME_AUTHORIZATION_REVISION,
        execute: (material) => {
          expect(Object.keys(material).sort()).toEqual([
            "namespaces",
            "recipientAgentId",
            "runtimeAuthorizationRevision",
          ]);
          expect(material.recipientAgentId).toBe("genie");
          expect(material.runtimeAuthorizationRevision).toBe(31);
          expect(material.namespaces.map((entry) => ({
            namespaceId: entry.namespaceId,
            domainId: entry.domainId,
            domainEpoch: entry.domainEpoch,
            accessRevision: entry.accessRevision,
            policyRevision: entry.policyRevision,
            domainAgentAuthorizationRevision:
              entry.domainAgentAuthorizationRevision,
          }))).toEqual([
            {
              namespaceId: "room-a",
              domainId: "domain-a",
              domainEpoch: 4,
              accessRevision: 0,
              policyRevision: 11,
              domainAgentAuthorizationRevision: 21,
            },
            {
              namespaceId: "room-c",
              domainId: "domain-b",
              domainEpoch: 5,
              accessRevision: 0,
              policyRevision: 13,
              domainAgentAuthorizationRevision: 22,
            },
          ]);
          for (const entry of material.namespaces) {
            borrowedKeys.push(...entry.generations.map((item) => item.key));
            expect(entry.generations[0]!.key).toEqual(
              state.keyrings.get(entry.namespaceId)!.ai.generations[0]!.key,
            );
          }
          return "opened";
        },
      });
    });

    expect(result).toEqual({
      status: "executed",
      value: { status: "executed", value: "opened" },
    });
    expect(state.preflightChecks()).toBe(3);
    expect(state.runtimeChecks()).toBe(2);
    expect(borrowedKeys).toHaveLength(2);
    expect(borrowedKeys.every((key) => key.every((byte) => byte === 0)))
      .toBeTrue();
    expect(borrowedRoots.every((root) => root.every((byte) => byte === 0)))
      .toBeTrue();
  });

  test("rejects noncanonical, widened, wrong-Domain, and cross-product requests", async () => {
    const state = await fixture();
    const capability = inspectProtectedInvocationCapability(state.capability);
    if (capability === null) throw new Error("capability unavailable");
    const cases = [
      { requestedNamespaceIds: [], viewDomainIds: ["domain-a"] },
      {
        requestedNamespaceIds: ["room-a", "room-a"],
        viewDomainIds: ["domain-a"],
      },
      {
        requestedNamespaceIds: ["room-c", "room-a"],
        viewDomainIds: ["domain-a", "domain-b"],
      },
      { requestedNamespaceIds: ["room-d"], viewDomainIds: ["domain-a"] },
      {
        requestedNamespaceIds: ["room-a"],
        viewDomainIds: ["domain-b"],
      },
      {
        requestedNamespaceIds: ["room-a"],
        viewDomainIds: ["domain-a", "domain-a"],
      },
      {
        requestedNamespaceIds: ["room-a"],
        viewDomainIds: ["domain-a", "domain-c"],
      },
    ];

    for (const request of cases) {
      let callbackRan = false;
      const result = await executeSet(state, (opened) =>
        withProtectedCurrentNamespaceKeyringSet({
          crypto: state.crypto,
          storage: state.keyringStorage,
          authority: state.authority,
          resolveHistoricalCommitter: () => state.issuer.publicKey,
          capability,
          opened,
          operation: "decrypt",
          requestedNamespaceIds: request.requestedNamespaceIds,
          viewDomainIds: request.viewDomainIds,
          expectedRuntimeAuthorizationRevision:
            RUNTIME_AUTHORIZATION_REVISION,
          execute: () => {
            callbackRan = true;
          },
        })
      );
      expect(result).toMatchObject({
        status: "executed",
        value: {
          status: "unavailable",
          reason: "authorization_unavailable",
        },
      });
      expect(callbackRan).toBeFalse();
    }
  });

  test("wipes selected keyrings and Grant roots when the callback throws", async () => {
    const state = await fixture();
    const capability = inspectProtectedInvocationCapability(state.capability);
    if (capability === null) throw new Error("capability unavailable");
    const borrowedKeys: Uint8Array[] = [];
    const borrowedRoots: Uint8Array[] = [];
    let thrown: unknown;
    try {
      await executeSet(state, (opened) => {
        borrowedRoots.push(...opened.domains.map((entry) => entry.aiRoot));
        return withProtectedCurrentNamespaceKeyringSet({
          crypto: state.crypto,
          storage: state.keyringStorage,
          authority: state.authority,
          resolveHistoricalCommitter: () => state.issuer.publicKey,
          capability,
          opened,
          operation: "decrypt",
          requestedNamespaceIds: ["room-a", "room-c"],
          viewDomainIds: ["domain-a", "domain-b"],
          expectedRuntimeAuthorizationRevision:
            RUNTIME_AUTHORIZATION_REVISION,
          execute: (material) => {
            borrowedKeys.push(...material.namespaces.flatMap((entry) =>
              entry.generations.map((generation) => generation.key)
            ));
            throw new Error("Namespace-set callback failed");
          },
        });
      });
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Namespace-set callback failed");
    expect(borrowedKeys).toHaveLength(2);
    expect(borrowedKeys.every((key) => key.every((byte) => byte === 0)))
      .toBeTrue();
    expect(borrowedRoots.every((root) => root.every((byte) => byte === 0)))
      .toBeTrue();
    expect(inspectProtectedInvocationCapability(state.capability)).not
      .toBeNull();
  });

  test("rejects partial, extra, and wrong-domain opened authority", async () => {
    const state = await fixture();
    const capability = inspectProtectedInvocationCapability(state.capability);
    if (capability === null) throw new Error("capability unavailable");
    const variants = (opened: OpenedGrantAuthoritySet) => [
      Object.freeze({
        ...opened,
        namespaceRequirements: opened.namespaceRequirements.slice(0, 2),
      }),
      Object.freeze({
        ...opened,
        namespaceRequirements: Object.freeze([
          ...opened.namespaceRequirements,
          Object.freeze({
            ...opened.namespaceRequirements[2]!,
            namespaceId: namespaceId("room-d"),
          }),
        ]),
      }),
      Object.freeze({
        ...opened,
        namespaceRequirements: Object.freeze([
          Object.freeze({
            ...opened.namespaceRequirements[0]!,
            domainId: cryptoDomainId("domain-b"),
          }),
          ...opened.namespaceRequirements.slice(1),
        ]),
      }),
      Object.freeze({ ...opened, domains: opened.domains.slice(0, 1) }),
      Object.freeze({
        ...opened,
        domains: Object.freeze([
          ...opened.domains,
          Object.freeze({
            ...opened.domains[1]!,
            domainId: cryptoDomainId("domain-c"),
          }),
        ]),
      }),
    ];

    expect(await executeSet(state, async (opened) => {
      for (const variant of variants(opened)) {
        let callbackRan = false;
        expect(await withProtectedCurrentNamespaceKeyringSet({
          crypto: state.crypto,
          storage: state.keyringStorage,
          authority: state.authority,
          resolveHistoricalCommitter: () => state.issuer.publicKey,
          capability,
          opened: variant,
          operation: "decrypt",
          requestedNamespaceIds: ["room-a"],
          viewDomainIds: ["domain-a", "domain-b"],
          expectedRuntimeAuthorizationRevision:
            RUNTIME_AUTHORIZATION_REVISION,
          execute: () => {
            callbackRan = true;
          },
        })).toEqual({
          status: "unavailable",
          reason: "authorization_unavailable",
        });
        expect(callbackRan).toBeFalse();
      }
      return "checked";
    })).toEqual({ status: "executed", value: "checked" });
  });

  test("fails closed after callback when policy, Runtime, or Namespace authority becomes stale", async () => {
    for (const stale of ["policy", "runtime", "head"] as const) {
      const state = await fixture();
      const capability = inspectProtectedInvocationCapability(state.capability);
      if (capability === null) throw new Error("capability unavailable");
      const borrowedKeys: Uint8Array[] = [];
      let headReads = 0;
      const storage = stale === "head"
        ? {
          ...state.keyringStorage,
          getNamespaceHead: async (id: string) => {
            const head = await state.storage.getNamespaceHead(id);
            headReads += 1;
            return headReads > 1 && head !== null
              ? { ...head, domainEpoch: head.domainEpoch + 1 }
              : head;
          },
        }
        : state.keyringStorage;
      const result = await executeSet(state, (opened) =>
        withProtectedCurrentNamespaceKeyringSet({
          crypto: state.crypto,
          storage,
          authority: state.authority,
          resolveHistoricalCommitter: () => state.issuer.publicKey,
          capability,
          opened,
          operation: "decrypt",
          requestedNamespaceIds: ["room-a"],
          viewDomainIds: ["domain-a", "domain-b"],
          expectedRuntimeAuthorizationRevision:
            RUNTIME_AUTHORIZATION_REVISION,
          execute: (material) => {
            borrowedKeys.push(material.namespaces[0]!.generations[0]!.key);
            if (stale === "policy") {
              state.setFacts(Object.freeze({
                ...state.baseFacts,
                namespaceRequirements: Object.freeze([
                  Object.freeze({
                    ...state.baseFacts.namespaceRequirements[0]!,
                    expectedPolicyRevision: 99,
                  }),
                  ...state.baseFacts.namespaceRequirements.slice(1),
                ]),
              }));
            } else if (stale === "runtime") {
              state.setRuntimeRevision(RUNTIME_AUTHORIZATION_REVISION + 1);
            }
          },
        })
      );
      expect(result).toEqual({
        status: "executed",
        value: {
          status: "unavailable",
          reason: "authorization_unavailable",
        },
      });
      expect(borrowedKeys).toHaveLength(1);
      expect(borrowedKeys[0]!.every((byte) => byte === 0)).toBeTrue();
    }
  });
});
