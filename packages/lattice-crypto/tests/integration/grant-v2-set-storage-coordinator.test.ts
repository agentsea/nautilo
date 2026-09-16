import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  grantV2SigningBytes,
  serializeGrantSecretV2,
  serializeGrantV2,
  type GrantV2,
} from "../../src/format/grant-v2.ts";
import {
  mintGrantV2,
} from "../../src/grant/authorization.ts";
import type {
  GrantAuthoritySetAuthorizationV2,
} from "../../src/grant/set-authorization.ts";
import {
  openGrantV2ForAuthoritySet,
  snapshotGrantAuthoritySetAuthorizationV2,
} from "../../src/grant/set-authorization.ts";
import {
  abortGrantAuthoritySetUseV2,
  assertAuthenticGrantAuthoritySetExecutionEvidenceV2,
  coordinateGrantAuthoritySetUseV2,
  preflightGrantAuthoritySetUseV2,
  withGrantAuthoritySetExecutionEvidenceNamespaceSubsetV2,
  withGrantAuthoritySetExecutionEvidenceSubsetV2,
  type GrantAuthoritySetExecutionEvidenceV2,
  type GrantAuthoritySetUseAuthorizationDecisionV2,
} from "../../src/grant/set-storage-coordinator.ts";
import { InMemoryV2Store } from "../../src/storage/v2-store.ts";
import {
  accessRevision,
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  grantId,
  humanId,
  namespaceId,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";
import { opaqueBytes } from "../../src/v2-types/opaque.ts";

const NOW = 8_000_000;

type CoordinateInput = Parameters<
  typeof coordinateGrantAuthoritySetUseV2<unknown>
>[0];
type AuthorizationContext = Parameters<
  CoordinateInput["resolveCurrentAuthorization"]
>[0];

function bytes(marker: number): Uint8Array {
  return new Uint8Array(32).fill(marker);
}

function allowDecision(context: AuthorizationContext) {
  return Object.freeze({
    context,
    currentTime: context.preflightTime,
    issuingDeviceActive: true,
    recipientAgentAuthorized: true,
    requestedNamespacesAuthorized: true,
    requestedDomainsAuthorized: true,
    hostAllowsOperation: true,
    currentSingleUseStatus: context.singleUseStatus,
  });
}

async function observeAuthorityRootWipes<T>(
  run: () => Promise<T>,
): Promise<{
  readonly result: T;
  readonly wipedMarkers: readonly number[];
}> {
  const originalFill = Uint8Array.prototype.fill;
  const wipedMarkers = new Set<number>();
  Uint8Array.prototype.fill = function (
    value: number,
    start?: number,
    end?: number,
  ): Uint8Array {
    const marker = this[0];
    const wasAuthorityRoot =
      this.length === 32
      && (marker === 0xa1 || marker === 0xb2)
      && this.every((byte) => byte === marker);
    const result = originalFill.call(this, value, start, end);
    if (
      value === 0
      && wasAuthorityRoot
      && marker !== undefined
      && this.every((byte) => byte === 0)
    ) {
      wipedMarkers.add(marker);
    }
    return result;
  };
  try {
    return {
      result: await run(),
      wipedMarkers: Object.freeze([...wipedMarkers].sort((a, b) => a - b)),
    };
  } finally {
    Uint8Array.prototype.fill = originalFill;
  }
}

async function fixture(seed = 11_100, singleUse = true): Promise<{
  readonly crypto: LatticeCrypto;
  readonly issuer: {
    readonly privateKey: Uint8Array;
    readonly publicKey: Uint8Array;
  };
  readonly grant: GrantV2;
  readonly authorization: GrantAuthoritySetAuthorizationV2;
  readonly store: InMemoryV2Store;
  readonly roots: readonly Uint8Array[];
}> {
  const crypto = new LatticeCrypto(seededRng(seed));
  const issuer = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const roots = Object.freeze([bytes(0xa1), bytes(0xb2)]);
  const grant = await mintGrantV2(crypto, {
    id: grantId(`grant-authority-set-${seed}`),
    issuingDeviceId: cryptoDeviceId("alice-phone"),
    issuingHumanId: humanId("alice"),
    issuingDeviceSigningPrivateKey: issuer.privateKey,
    recipientAgentId: agentId("genie"),
    recipientKeyId: "background-recipient",
    recipientEncryptionPublicKey: recipient.publicKey,
    scope: [humanId("alice")],
    operations: ["decrypt", "encrypt"],
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
    coveredDomains: [
      {
        domainId: cryptoDomainId("domain-alpha"),
        domainEpoch: domainEpoch(4),
        agentAuthorizationRevision: authorizationRevision(11),
        aiRoot: roots[0]!,
      },
      {
        domainId: cryptoDomainId("domain-beta"),
        domainEpoch: domainEpoch(7),
        agentAuthorizationRevision: authorizationRevision(13),
        aiRoot: roots[1]!,
      },
    ],
    singleUse,
  });
  const authorization: GrantAuthoritySetAuthorizationV2 = Object.freeze({
    now: NOW + 1,
    expectedIssuingDeviceId: cryptoDeviceId("alice-phone"),
    issuingDeviceHumanId: humanId("alice"),
    issuingDeviceSigningPublicKey: issuer.publicKey,
    issuingDeviceActive: true,
    recipientAgentId: agentId("genie"),
    recipientKeyId: "background-recipient",
    recipientEncryptionPrivateKey: recipient.privateKey,
    grantScope: Object.freeze([humanId("alice")]),
    singleUseAvailable: true,
    namespaceRequirements: Object.freeze([
      Object.freeze({
        namespaceId: namespaceId("room-alpha-a"),
        domainId: cryptoDomainId("domain-alpha"),
        operations: Object.freeze(["decrypt"] as const),
        namespaceParticipants: Object.freeze([humanId("alice")]),
        expectedAccessRevision: accessRevision(2),
        expectedPolicyRevision: authorizationRevision(21),
      }),
      Object.freeze({
        namespaceId: namespaceId("room-alpha-b"),
        domainId: cryptoDomainId("domain-alpha"),
        operations: Object.freeze(["encrypt"] as const),
        namespaceParticipants: Object.freeze([humanId("alice")]),
        expectedAccessRevision: accessRevision(5),
        expectedPolicyRevision: authorizationRevision(22),
      }),
      Object.freeze({
        namespaceId: namespaceId("room-beta"),
        domainId: cryptoDomainId("domain-beta"),
        operations: Object.freeze(["decrypt", "encrypt"] as const),
        namespaceParticipants: Object.freeze([
          humanId("alice"),
          humanId("bob"),
        ]),
        expectedAccessRevision: accessRevision(8),
        expectedPolicyRevision: authorizationRevision(31),
      }),
    ]),
    domainRequirements: Object.freeze([
      Object.freeze({
        domainId: cryptoDomainId("domain-alpha"),
        expectedEpoch: domainEpoch(4),
        expectedAgentAuthorizationRevision: authorizationRevision(11),
      }),
      Object.freeze({
        domainId: cryptoDomainId("domain-beta"),
        expectedEpoch: domainEpoch(7),
        expectedAgentAuthorizationRevision: authorizationRevision(13),
      }),
    ]),
    hostAllowsOperation: true,
  });
  const store = new InMemoryV2Store();
  await store.putGrant({
    grantId: grant.id,
    grantBytes: opaqueBytes("grant", serializeGrantV2(grant)),
    consumed: false,
  });
  return { crypto, issuer, grant, authorization, store, roots };
}

async function preflight(
  state: Awaited<ReturnType<typeof fixture>>,
) {
  const prepared = await preflightGrantAuthoritySetUseV2(
    state.crypto,
    state.grant,
    state.authorization,
  );
  if (prepared === null) throw new Error("expected authority-set preflight");
  return prepared;
}

async function expectPreflightRejection(
  state: Awaited<ReturnType<typeof fixture>>,
  authorization: GrantAuthoritySetAuthorizationV2,
): Promise<void> {
  const prepared = await preflightGrantAuthoritySetUseV2(
    state.crypto,
    state.grant,
    authorization,
  );
  if (prepared !== null) abortGrantAuthoritySetUseV2(prepared);
  expect(prepared).toBeNull();
  expect((await state.store.getGrant(state.grant.id))?.consumed).toBe(false);
}

describe("v2 atomic Grant authority-set storage coordinator", () => {
  test("lends exact mixed per-Namespace operations with derived Domain coverage", async () => {
    const state = await fixture(11_023);
    const prepared = await preflight(state);
    let retained: GrantAuthoritySetExecutionEvidenceV2 | null = null;
    const result = await coordinateGrantAuthoritySetUseV2({
      preflight: prepared,
      storage: state.store,
      resolveCurrentAuthorization: (context) => allowDecision(context),
      execute: async (_opened, evidence) => {
        const value = await withGrantAuthoritySetExecutionEvidenceNamespaceSubsetV2({
          evidence,
          namespaceRequirements: [
            {
              namespaceId: namespaceId("room-alpha-a"),
              requiredOperations: ["decrypt"],
            },
            {
              namespaceId: namespaceId("room-alpha-b"),
              requiredOperations: ["encrypt"],
            },
          ],
          execute: (subset) => {
            retained = subset;
            expect(() =>
              assertAuthenticGrantAuthoritySetExecutionEvidenceV2(subset)
            ).not.toThrow();
            expect(subset.operations).toEqual(["decrypt", "encrypt"]);
            expect(subset.namespaceRequirements.map((entry) => ({
              namespaceId: entry.namespaceId,
              operations: entry.operations,
            }))).toEqual([
              { namespaceId: "room-alpha-a", operations: ["decrypt"] },
              { namespaceId: "room-alpha-b", operations: ["encrypt"] },
            ]);
            expect(subset.domainRequirements.map((entry) => entry.domainId))
              .toEqual(["domain-alpha"]);
            const forged = { ...subset } as GrantAuthoritySetExecutionEvidenceV2;
            expect(() =>
              assertAuthenticGrantAuthoritySetExecutionEvidenceV2(forged)
            ).toThrow("is not active");
            subset.grantHash[0] = subset.grantHash[0]! ^ 1;
            expect(() =>
              assertAuthenticGrantAuthoritySetExecutionEvidenceV2(subset)
            ).toThrow("is not active");
            subset.grantHash[0] = subset.grantHash[0] ^ 1;
            return "mixed";
          },
        });
        expect(() =>
          assertAuthenticGrantAuthoritySetExecutionEvidenceV2(retained!)
        ).toThrow("is not active");

        const decryptOnly = await withGrantAuthoritySetExecutionEvidenceNamespaceSubsetV2({
          evidence,
          namespaceRequirements: [{
            namespaceId: namespaceId("room-alpha-a"),
            requiredOperations: ["decrypt"],
          }],
          execute: (subset) => ({
            operations: subset.operations,
            namespaces: subset.namespaceRequirements.map((entry) =>
              entry.namespaceId
            ),
          }),
        });
        expect(decryptOnly).toEqual({
          operations: ["decrypt"],
          namespaces: ["room-alpha-a"],
        });

        const reverseInsertedFields = {
          requiredOperations: ["decrypt"] as const,
          namespaceId: namespaceId("room-alpha-a"),
        };
        expect(await withGrantAuthoritySetExecutionEvidenceNamespaceSubsetV2({
          evidence,
          namespaceRequirements: [reverseInsertedFields],
          execute: (subset) => subset.operations,
        })).toEqual(["decrypt"]);

        const crossDomain = await withGrantAuthoritySetExecutionEvidenceNamespaceSubsetV2({
          evidence,
          namespaceRequirements: [
            {
              namespaceId: namespaceId("room-alpha-a"),
              requiredOperations: ["decrypt"],
            },
            {
              namespaceId: namespaceId("room-beta"),
              requiredOperations: ["encrypt"],
            },
          ],
          execute: (subset) => ({
            domains: subset.domainRequirements.map((entry) => entry.domainId),
            operations: subset.operations,
          }),
        });
        expect(crossDomain).toEqual({
          domains: ["domain-alpha", "domain-beta"],
          operations: ["decrypt", "encrypt"],
        });

        const rejectSubset = (
          namespaceRequirements: unknown,
          execute: unknown = () => "must-not-run",
        ): Promise<unknown> =>
          withGrantAuthoritySetExecutionEvidenceNamespaceSubsetV2({
            evidence,
            namespaceRequirements,
            execute,
          } as Parameters<
            typeof withGrantAuthoritySetExecutionEvidenceNamespaceSubsetV2
          >[0]);
        for (const namespaceRequirements of [
          null,
          "not-an-array",
          [],
          [null],
          [() => undefined],
          [Object.assign(() => undefined, {
            namespaceId: namespaceId("room-alpha-a"),
            requiredOperations: ["decrypt"] as const,
          })],
          [{
            namespaceId: namespaceId("room-alpha-a"),
            requiredOperations: ["decrypt"],
            unexpected: true,
          }],
          [{
            namespaceId: namespaceId("room-unknown"),
            requiredOperations: ["decrypt"],
          }],
          [{
            namespaceId: namespaceId("room-alpha-a"),
            requiredOperations: ["decrypt", "decrypt"],
          }],
          [{
            namespaceId: namespaceId("room-alpha-a"),
            requiredOperations: ["encrypt", "decrypt"],
          }],
          [
            {
              namespaceId: namespaceId("room-alpha-a"),
              requiredOperations: ["decrypt"],
            },
            {
              namespaceId: namespaceId("room-alpha-a"),
              requiredOperations: ["decrypt"],
            },
          ],
          [
            {
              namespaceId: namespaceId("room-alpha-b"),
              requiredOperations: ["encrypt"],
            },
            {
              namespaceId: namespaceId("room-alpha-a"),
              requiredOperations: ["decrypt"],
            },
            {
              namespaceId: namespaceId("room-beta"),
              requiredOperations: ["decrypt"],
            },
          ],
        ]) {
          expect(rejectSubset(namespaceRequirements)).rejects.toThrow();
        }
        expect(rejectSubset([{
          namespaceId: namespaceId("room-alpha-a"),
          requiredOperations: ["decrypt"],
        }], null)).rejects.toThrow("per-Namespace subset is invalid");

        const invalid = [
          [
            {
              namespaceId: namespaceId("room-alpha-b"),
              requiredOperations: ["encrypt"] as const,
            },
            {
              namespaceId: namespaceId("room-alpha-a"),
              requiredOperations: ["decrypt"] as const,
            },
          ],
          [{
            namespaceId: namespaceId("room-alpha-a"),
            requiredOperations: ["encrypt"] as const,
          }],
          [{
            namespaceId: namespaceId("room-alpha-a"),
            requiredOperations: [] as const,
          }],
        ];
        for (const namespaceRequirements of invalid) {
          expect(withGrantAuthoritySetExecutionEvidenceNamespaceSubsetV2({
            evidence,
            namespaceRequirements,
            execute: () => "must-not-run",
          })).rejects.toThrow();
        }
        return value;
      },
    });
    expect(result).toEqual({ status: "executed", value: "mixed" });
    expect(() =>
      assertAuthenticGrantAuthoritySetExecutionEvidenceV2(retained!)
    ).toThrow("is not active");
  });

  test("lends only canonical authorized Namespace subsets with exact Domain coverage", async () => {
    const state = await fixture(11_025);
    const prepared = await preflight(state);
    const retained: GrantAuthoritySetExecutionEvidenceV2[] = [];

    const result = await coordinateGrantAuthoritySetUseV2({
      preflight: prepared,
      storage: state.store,
      resolveCurrentAuthorization: (context) => allowDecision(context),
      execute: async (_opened, evidence) => {
        const alpha = await withGrantAuthoritySetExecutionEvidenceSubsetV2({
          evidence,
          namespaceIds: [namespaceId("room-alpha-b")],
          requiredOperations: ["encrypt"],
          execute: (subset) => {
            expect(() =>
              assertAuthenticGrantAuthoritySetExecutionEvidenceV2(subset)
            ).not.toThrow();
            expect(subset.operations).toEqual(["encrypt"]);
            expect(subset.namespaceRequirements.map((entry) => ({
              namespaceId: entry.namespaceId,
              operations: entry.operations,
            }))).toEqual([{
              namespaceId: "room-alpha-b",
              operations: ["encrypt"],
            }]);
            expect(subset.domainRequirements.map((entry) => entry.domainId))
              .toEqual(["domain-alpha"]);
            expect(JSON.stringify(subset)).not.toContain("aiRoot");
            retained.push(subset);
            return "alpha";
          },
        });
        const crossDomain =
          await withGrantAuthoritySetExecutionEvidenceSubsetV2({
            evidence,
            namespaceIds: [
              namespaceId("room-alpha-b"),
              namespaceId("room-beta"),
            ],
            requiredOperations: ["encrypt"],
            execute: (subset) => {
              expect(subset.namespaceRequirements.map((entry) =>
                entry.namespaceId
              )).toEqual(["room-alpha-b", "room-beta"]);
              expect(subset.domainRequirements.map((entry) => entry.domainId))
                .toEqual(["domain-alpha", "domain-beta"]);
              retained.push(subset);
              return "cross-domain";
            },
          });
        const bothOperations =
          await withGrantAuthoritySetExecutionEvidenceSubsetV2({
            evidence,
            namespaceIds: [namespaceId("room-beta")],
            requiredOperations: ["decrypt", "encrypt"],
            execute: (subset) => {
              expect(subset.operations).toEqual(["decrypt", "encrypt"]);
              expect(subset.namespaceRequirements[0]!.operations)
                .toEqual(["decrypt", "encrypt"]);
              return "both-operations";
            },
          });
        return [alpha, crossDomain, bothOperations];
      },
    });

    expect(result).toEqual({
      status: "executed",
      value: ["alpha", "cross-domain", "both-operations"],
    });
    for (const subset of retained) {
      expect(() =>
        assertAuthenticGrantAuthoritySetExecutionEvidenceV2(subset)
      ).toThrow("is not active");
    }
  });

  test("rejects subset widening, noncanonical inputs, and missing operations", async () => {
    const state = await fixture(11_030);
    const prepared = await preflight(state);
    const result = await coordinateGrantAuthoritySetUseV2({
      preflight: prepared,
      storage: state.store,
      resolveCurrentAuthorization: (context) => allowDecision(context),
      execute: async (_opened, evidence) => {
        const invalid = [
          {
            namespaceIds: [],
            requiredOperations: ["encrypt"],
          },
          {
            namespaceIds: [
              namespaceId("room-beta"),
              namespaceId("room-alpha-b"),
            ],
            requiredOperations: ["encrypt"],
          },
          {
            namespaceIds: [
              namespaceId("room-alpha-b"),
              namespaceId("room-alpha-b"),
            ],
            requiredOperations: ["encrypt"],
          },
          {
            namespaceIds: [namespaceId("room-missing")],
            requiredOperations: ["encrypt"],
          },
          {
            namespaceIds: [namespaceId("room-alpha-a")],
            requiredOperations: ["encrypt"],
          },
          {
            namespaceIds: [namespaceId("room-beta")],
            requiredOperations: ["encrypt", "decrypt"],
          },
          {
            namespaceIds: [namespaceId("room-beta")],
            requiredOperations: [],
          },
        ] as const;
        for (const candidate of invalid) {
          expect(withGrantAuthoritySetExecutionEvidenceSubsetV2({
            evidence,
            namespaceIds: candidate.namespaceIds,
            requiredOperations: candidate.requiredOperations,
            execute: () => "must-not-run",
          })).rejects.toThrow();
        }
        return "rejected";
      },
    });
    expect(result).toEqual({ status: "executed", value: "rejected" });
  });

  test("invalidates mutated, forged, callback-expired, and parent-expired subsets", async () => {
    const state = await fixture(11_035);
    const prepared = await preflight(state);
    let retained: GrantAuthoritySetExecutionEvidenceV2 | null = null;
    let deferredAssertion: (() => void) | null = null;
    const result = await coordinateGrantAuthoritySetUseV2({
      preflight: prepared,
      storage: state.store,
      resolveCurrentAuthorization: (context) => allowDecision(context),
      execute: async (_opened, evidence) => {
        await withGrantAuthoritySetExecutionEvidenceSubsetV2({
          evidence,
          namespaceIds: [namespaceId("room-beta")],
          requiredOperations: ["encrypt"],
          execute: (subset) => {
            retained = subset;
            deferredAssertion = () =>
              assertAuthenticGrantAuthoritySetExecutionEvidenceV2(subset);
            const forged = { ...subset } as GrantAuthoritySetExecutionEvidenceV2;
            expect(() =>
              assertAuthenticGrantAuthoritySetExecutionEvidenceV2(forged)
            ).toThrow("is not active");
            subset.grantHash[0] = subset.grantHash[0]! ^ 1;
            expect(() =>
              assertAuthenticGrantAuthoritySetExecutionEvidenceV2(subset)
            ).toThrow("is not active");
            subset.grantHash[0] = subset.grantHash[0] ^ 1;
          },
        });
        expect(deferredAssertion).not.toBeNull();
        expect(() => deferredAssertion!()).toThrow("is not active");
        return "expired";
      },
    });
    expect(result).toEqual({ status: "executed", value: "expired" });
    expect(retained).not.toBeNull();
    expect(() =>
      assertAuthenticGrantAuthoritySetExecutionEvidenceV2(retained!)
    ).toThrow("is not active");
  });

  test("invalidates a still-running subset callback as soon as its parent expires", async () => {
    const state = await fixture(11_040);
    const prepared = await preflight(state);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let subsetRun: Promise<"parent-expired"> | null = null;
    const result = await coordinateGrantAuthoritySetUseV2({
      preflight: prepared,
      storage: state.store,
      resolveCurrentAuthorization: (context) => allowDecision(context),
      execute: (_opened, evidence) => {
        subsetRun = withGrantAuthoritySetExecutionEvidenceSubsetV2({
          evidence,
          namespaceIds: [namespaceId("room-beta")],
          requiredOperations: ["encrypt"],
          execute: async (subset) => {
            await gate;
            expect(() =>
              assertAuthenticGrantAuthoritySetExecutionEvidenceV2(subset)
            ).toThrow("is not active");
            return "parent-expired" as const;
          },
        });
        return "parent-complete";
      },
    });
    expect(result).toEqual({
      status: "executed",
      value: "parent-complete",
    });
    expect(subsetRun).not.toBeNull();
    release();
    expect(await subsetRun!).toBe("parent-expired");
  });

  test("lends canonical non-secret execution evidence only during execute", async () => {
    const state = await fixture(11_050);
    const prepared = await preflight(state);
    let retained: GrantAuthoritySetExecutionEvidenceV2 | null = null;

    const result = await coordinateGrantAuthoritySetUseV2({
      preflight: prepared,
      storage: state.store,
      resolveCurrentAuthorization: (context) => allowDecision(context),
      execute: (_opened, evidence) => {
        expect(() =>
          assertAuthenticGrantAuthoritySetExecutionEvidenceV2(evidence)
        ).not.toThrow();
        expect(evidence.grantId).toBe(state.grant.id);
        expect(evidence.grantHash).toEqual(
          state.crypto.hash(serializeGrantV2(state.grant)),
        );
        expect(evidence.grantUseStatus).toBe("claimed-by-preflight");
        expect(evidence.recipientAgentId).toBe(state.grant.recipientAgentId);
        expect(evidence.recipientKeyId).toBe(state.grant.recipientKeyId);
        expect(evidence.grantScope).toEqual(state.grant.scope);
        expect(evidence.operations).toEqual(state.grant.operations);
        expect(evidence.issuedAt).toBe(state.grant.issuedAt);
        expect(evidence.expiresAt).toBe(state.grant.expiresAt);
        expect(evidence.namespaceRequirements).toEqual(
          state.authorization.namespaceRequirements,
        );
        expect(evidence.domainRequirements).toEqual(
          state.authorization.domainRequirements,
        );
        expect(JSON.stringify(evidence)).not.toContain("aiRoot");
        expect(JSON.stringify(evidence)).not.toContain("PrivateKey");
        retained = evidence;
        return "complete";
      },
    });

    expect(result).toEqual({ status: "executed", value: "complete" });
    expect(retained).not.toBeNull();
    expect(() =>
      assertAuthenticGrantAuthoritySetExecutionEvidenceV2(retained!)
    ).toThrow("is not active");
  });

  test("rejects execution evidence whose public bytes mutate in callback", async () => {
    const state = await fixture(11_075);
    const prepared = await preflight(state);
    const result = await coordinateGrantAuthoritySetUseV2({
      preflight: prepared,
      storage: state.store,
      resolveCurrentAuthorization: (context) => allowDecision(context),
      execute: (_opened, evidence) => {
        evidence.grantHash[0] = evidence.grantHash[0]! ^ 1;
        expect(() =>
          assertAuthenticGrantAuthoritySetExecutionEvidenceV2(evidence)
        ).toThrow("is not active");
        return "rejected";
      },
    });
    expect(result).toEqual({ status: "executed", value: "rejected" });
  });

  test("snapshots the complete canonical authority set with owned key bytes", async () => {
    const state = await fixture(11_050);
    const snapshot = snapshotGrantAuthoritySetAuthorizationV2(
      state.authorization,
    );

    expect(snapshot).toEqual(state.authorization);
    expect(snapshot).not.toBe(state.authorization);
    expect(snapshot.issuingDeviceSigningPublicKey).not.toBe(
      state.authorization.issuingDeviceSigningPublicKey,
    );
    expect(snapshot.recipientEncryptionPrivateKey).not.toBe(
      state.authorization.recipientEncryptionPrivateKey,
    );
    expect(snapshot.namespaceRequirements[0]).not.toBe(
      state.authorization.namespaceRequirements[0],
    );
    expect(snapshot.domainRequirements[0]).not.toBe(
      state.authorization.domainRequirements[0],
    );
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.namespaceRequirements)).toBe(true);
    expect(Object.isFrozen(snapshot.domainRequirements)).toBe(true);
  });

  test("rejects every malformed authority-set shape and canonical ordering", async () => {
    const state = await fixture(11_051);
    const firstNamespace = state.authorization.namespaceRequirements[0]!;
    const betaNamespace = state.authorization.namespaceRequirements[2]!;
    const firstDomain = state.authorization.domainRequirements[0]!;
    const invalid: unknown[] = [
      { ...state.authorization, unexpected: true },
      (() => {
        const { recipientKeyId: _, ...missing } = state.authorization;
        return { ...missing, unexpectedRecipientKeyId: "background-recipient" };
      })(),
      { ...state.authorization, now: Number.NaN },
      { ...state.authorization, issuingDeviceActive: "yes" },
      { ...state.authorization, singleUseAvailable: "yes" },
      { ...state.authorization, hostAllowsOperation: "yes" },
      { ...state.authorization, grantScope: [] },
      { ...state.authorization, grantScope: ["alice", "alice"] },
      { ...state.authorization, namespaceRequirements: null },
      { ...state.authorization, namespaceRequirements: [] },
      { ...state.authorization, domainRequirements: null },
      { ...state.authorization, domainRequirements: [] },
      {
        ...state.authorization,
        namespaceRequirements: [
          { ...firstNamespace, unexpected: true },
          ...state.authorization.namespaceRequirements.slice(1),
        ],
      },
      {
        ...state.authorization,
        namespaceRequirements: [
          { ...firstNamespace, operations: [] },
          ...state.authorization.namespaceRequirements.slice(1),
        ],
      },
      {
        ...state.authorization,
        namespaceRequirements: [
          { ...firstNamespace, operations: ["decrypt", "decrypt"] },
          ...state.authorization.namespaceRequirements.slice(1),
        ],
      },
      {
        ...state.authorization,
        namespaceRequirements: [
          { ...firstNamespace, operations: ["destroy"] },
          ...state.authorization.namespaceRequirements.slice(1),
        ],
      },
      {
        ...state.authorization,
        namespaceRequirements: [
          { ...firstNamespace, operations: ["decrypt", "destroy"] },
          ...state.authorization.namespaceRequirements.slice(1),
        ],
      },
      {
        ...state.authorization,
        namespaceRequirements: [
          ...state.authorization.namespaceRequirements.slice(0, 2),
          {
            ...betaNamespace,
            operations: ["encrypt", "decrypt"],
          },
        ],
      },
      {
        ...state.authorization,
        namespaceRequirements: [
          ...state.authorization.namespaceRequirements.slice(0, 2),
          {
            ...betaNamespace,
            namespaceParticipants: ["bob", "alice", "carol"],
          },
        ],
      },
      {
        ...state.authorization,
        namespaceRequirements: [
          ...state.authorization.namespaceRequirements.slice(0, 2),
          { ...betaNamespace, namespaceParticipants: [] },
        ],
      },
      {
        ...state.authorization,
        namespaceRequirements: [
          ...state.authorization.namespaceRequirements.slice(0, 2),
          {
            ...betaNamespace,
            namespaceParticipants: ["bob", "alice"],
          },
        ],
      },
      {
        ...state.authorization,
        namespaceRequirements: [
          ...state.authorization.namespaceRequirements.slice(0, 2),
          {
            ...betaNamespace,
            namespaceParticipants: ["alice", "alice"],
          },
        ],
      },
      {
        ...state.authorization,
        namespaceRequirements: [
          { ...firstNamespace, expectedAccessRevision: -1 },
          ...state.authorization.namespaceRequirements.slice(1),
        ],
      },
      {
        ...state.authorization,
        namespaceRequirements: [
          { ...firstNamespace, expectedPolicyRevision: -1 },
          ...state.authorization.namespaceRequirements.slice(1),
        ],
      },
      {
        ...state.authorization,
        namespaceRequirements: [
          state.authorization.namespaceRequirements[1]!,
          state.authorization.namespaceRequirements[0]!,
          betaNamespace,
        ],
      },
      {
        ...state.authorization,
        namespaceRequirements: [
          firstNamespace,
          { ...state.authorization.namespaceRequirements[1]!, namespaceId: firstNamespace.namespaceId },
          betaNamespace,
        ],
      },
      {
        ...state.authorization,
        domainRequirements: [
          { ...firstDomain, unexpected: true },
          state.authorization.domainRequirements[1]!,
        ],
      },
      {
        ...state.authorization,
        domainRequirements: [...state.authorization.domainRequirements].reverse(),
      },
      {
        ...state.authorization,
        domainRequirements: [
          firstDomain,
          { ...state.authorization.domainRequirements[1]!, domainId: firstDomain.domainId },
        ],
      },
      {
        ...state.authorization,
        domainRequirements: [
          { ...firstDomain, expectedEpoch: -1 },
          state.authorization.domainRequirements[1]!,
        ],
      },
      {
        ...state.authorization,
        domainRequirements: [
          { ...firstDomain, expectedAgentAuthorizationRevision: -1 },
          state.authorization.domainRequirements[1]!,
        ],
      },
      {
        ...state.authorization,
        domainRequirements: [
          { ...firstDomain, domainId: cryptoDomainId("domain-other") },
          state.authorization.domainRequirements[1]!,
        ],
      },
    ];

    for (const value of invalid) {
      expect(() => snapshotGrantAuthoritySetAuthorizationV2(
        value as GrantAuthoritySetAuthorizationV2,
      )).toThrow();
    }
  });

  test("accepts exact minimum and maximum authority-set collection bounds", async () => {
    const state = await fixture(11_052);
    expect(() => snapshotGrantAuthoritySetAuthorizationV2({
      ...state.authorization,
      namespaceRequirements: [state.authorization.namespaceRequirements[0]!],
      domainRequirements: [state.authorization.domainRequirements[0]!],
    })).not.toThrow();

    const grantScope = Array.from(
      { length: V2_LIMITS.grantScopeHumans },
      (_, index) => humanId(`human-${index.toString().padStart(3, "0")}`),
    );
    const namespaceParticipants = Array.from(
      { length: V2_LIMITS.humanParticipantsPerDomain },
      (_, index) => humanId(`participant-${index.toString().padStart(3, "0")}`),
    );
    const namespaceRequirements = Array.from(
      { length: V2_LIMITS.agentGrantNamespaces },
      (_, index) => ({
        namespaceId: namespaceId(
          `namespace-${index.toString().padStart(5, "0")}`,
        ),
        domainId: cryptoDomainId(
          `domain-${index.toString().padStart(5, "0")}`,
        ),
        operations: ["decrypt"] as const,
        namespaceParticipants,
        expectedAccessRevision: accessRevision(index),
        expectedPolicyRevision: authorizationRevision(index),
      }),
    );
    const domainRequirements = Array.from(
      { length: V2_LIMITS.agentGrantDomains },
      (_, index) => ({
        domainId: cryptoDomainId(
          `domain-${index.toString().padStart(5, "0")}`,
        ),
        expectedEpoch: domainEpoch(index),
        expectedAgentAuthorizationRevision: authorizationRevision(index),
      }),
    );

    expect(() => snapshotGrantAuthoritySetAuthorizationV2({
      ...state.authorization,
      grantScope,
      namespaceRequirements,
      domainRequirements,
    })).not.toThrow();

    expect(() => snapshotGrantAuthoritySetAuthorizationV2({
      ...state.authorization,
      grantScope: [
        ...grantScope,
        humanId("human-over-limit"),
      ].sort(),
    })).toThrow("Grant authority scope is empty or exceeds its bound");
    expect(() => snapshotGrantAuthoritySetAuthorizationV2({
      ...state.authorization,
      namespaceRequirements: [{
        ...state.authorization.namespaceRequirements[0]!,
        namespaceParticipants: [
          ...namespaceParticipants,
          humanId("participant-over-limit"),
        ].sort(),
      }],
      domainRequirements: [state.authorization.domainRequirements[0]!],
    })).toThrow("Grant Namespace participants is empty or exceeds its bound");
    expect(() => snapshotGrantAuthoritySetAuthorizationV2({
      ...state.authorization,
      grantScope,
      namespaceRequirements: [
        ...namespaceRequirements,
        {
          ...namespaceRequirements.at(-1)!,
          namespaceId: namespaceId("namespace-256"),
        },
      ],
      domainRequirements,
    })).toThrow("Grant authority-set authorization is invalid");
  });

  test("fails closed on each independent authority-set authorization axis", async () => {
    const changes: readonly Partial<GrantAuthoritySetAuthorizationV2>[] = [
      { issuingDeviceActive: false },
      { hostAllowsOperation: false },
      { singleUseAvailable: false },
      { now: NOW - 1 },
      { now: NOW + 60_000 },
      { expectedIssuingDeviceId: cryptoDeviceId("mallory-phone") },
      { issuingDeviceHumanId: humanId("mallory") },
      { recipientAgentId: agentId("other-agent") },
      { recipientKeyId: "other-recipient" },
      { grantScope: [humanId("bob")] },
      { issuingDeviceSigningPublicKey: bytes(0x71) },
      { recipientEncryptionPrivateKey: bytes(0x72) },
    ];

    for (const [index, change] of changes.entries()) {
      const state = await fixture(11_060 + index);
      await expectPreflightRejection(state, {
        ...state.authorization,
        ...change,
      });
    }

    const state = await fixture(11_080);
    await expectPreflightRejection(state, {
      ...state.authorization,
      namespaceRequirements: state.authorization.namespaceRequirements.map(
        (entry, index) => index === 0
          ? { ...entry, namespaceParticipants: [humanId("bob")] }
          : entry,
      ),
    });

    const partialSubset = await fixture(11_081);
    const twoHumanGrant = {
      ...partialSubset.grant,
      scope: [humanId("alice"), humanId("bob")],
    };
    twoHumanGrant.signature = partialSubset.crypto.sign(
      partialSubset.issuer.privateKey,
      grantV2SigningBytes(twoHumanGrant),
    );
    expect(await openGrantV2ForAuthoritySet(
      partialSubset.crypto,
      twoHumanGrant,
      {
        ...partialSubset.authorization,
        grantScope: [humanId("alice"), humanId("bob")],
      },
    )).toBeNull();
  });

  test("accepts the exact issue-time boundary and rejects malformed opened secrets", async () => {
    const boundary = await fixture(11_081);
    const boundaryPrepared = await preflightGrantAuthoritySetUseV2(
      boundary.crypto,
      boundary.grant,
      { ...boundary.authorization, now: NOW },
    );
    expect(boundaryPrepared).not.toBeNull();
    abortGrantAuthoritySetUseV2(boundaryPrepared!);

    const malformed = await fixture(11_082);
    const originalOpenSealed = malformed.crypto.openSealed.bind(
      malformed.crypto,
    );
    const plaintexts = [
      new Uint8Array([1]),
      serializeGrantSecretV2([{
        domainId: cryptoDomainId("domain-alpha"),
        aiRoot: bytes(0xa1),
      }]),
      serializeGrantSecretV2([
        { domainId: cryptoDomainId("domain-other-a"), aiRoot: bytes(0xa1) },
        { domainId: cryptoDomainId("domain-other-b"), aiRoot: bytes(0xb2) },
      ]),
    ];
    for (const plaintext of plaintexts) {
      malformed.crypto.openSealed = (() =>
        Promise.resolve(plaintext.slice())) as typeof malformed.crypto.openSealed;
      expect(await openGrantV2ForAuthoritySet(
        malformed.crypto,
        malformed.grant,
        malformed.authorization,
      )).toBeNull();
    }
    malformed.crypto.openSealed = originalOpenSealed;
  });

  test("claims once and lends the exact complete two-Domain, three-Namespace set", async () => {
    const state = await fixture();
    const prepared = await preflight(state);
    const phases: string[] = [];
    const callbackRoots: Uint8Array[] = [];
    let claims = 0;

    const result = await coordinateGrantAuthoritySetUseV2({
      preflight: prepared,
      storage: {
        consumeGrant: (id) => {
          claims += 1;
          return state.store.consumeGrant(id);
        },
      },
      resolveCurrentAuthorization: (context) => {
        phases.push(context.phase);
        expect(context.requestedNamespaces).toEqual(
          state.authorization.namespaceRequirements,
        );
        expect(context.requestedDomains).toEqual(
          state.authorization.domainRequirements,
        );
        return allowDecision(context);
      },
      execute: async (opened) => {
        expect((await state.store.getGrant(state.grant.id))?.consumed).toBe(
          true,
        );
        expect(opened.namespaceRequirements).toEqual(
          state.authorization.namespaceRequirements.map((requirement) => ({
            namespaceId: requirement.namespaceId,
            domainId: requirement.domainId,
            operations: requirement.operations,
            expectedAccessRevision: requirement.expectedAccessRevision,
            expectedPolicyRevision: requirement.expectedPolicyRevision,
          })),
        );
        expect(opened.domains.map((domain) => ({
          domainId: domain.domainId,
          expectedEpoch: domain.expectedEpoch,
          expectedAgentAuthorizationRevision:
            domain.expectedAgentAuthorizationRevision,
        }))).toEqual([...state.authorization.domainRequirements]);
        callbackRoots.push(...opened.domains.map((domain) => domain.aiRoot));
        expect(callbackRoots).toEqual([...state.roots]);
        return "complete";
      },
    });

    expect(result).toEqual({ status: "executed", value: "complete" });
    expect(phases).toEqual(["before-claim", "before-execute"]);
    expect(claims).toBe(1);
    expect(callbackRoots).toHaveLength(2);
    expect(callbackRoots.every((root) => root.every((byte) => byte === 0)))
      .toBe(true);
  });

  test("issues unique opaque preflights and supports the reusable path without a claim", async () => {
    const singleUseState = await fixture(11_101);
    const first = await preflight(singleUseState);
    const second = await preflight(singleUseState);
    expect(first.preflightId).toMatch(/^grant-set-use-[a-f0-9]{32}$/u);
    expect(second.preflightId).toMatch(/^grant-set-use-[a-f0-9]{32}$/u);
    expect(first.preflightId).not.toBe(second.preflightId);
    expect(first.singleUse).toBe(true);
    abortGrantAuthoritySetUseV2(first);
    abortGrantAuthoritySetUseV2(second);

    const reusable = await fixture(11_102, false);
    const prepared = await preflight(reusable);
    const phases: string[] = [];
    let claims = 0;
    const result = await coordinateGrantAuthoritySetUseV2({
      preflight: prepared,
      storage: {
        consumeGrant: async () => {
          claims += 1;
          return null;
        },
      },
      resolveCurrentAuthorization: (context) => {
        phases.push(`${context.phase}:${context.singleUseStatus}`);
        expect(context.grantScope).toEqual(reusable.grant.scope);
        expect(context.operations).toEqual(reusable.grant.operations);
        return allowDecision(context);
      },
      execute: (opened) => opened.domains.length,
    });
    expect(result).toEqual({ status: "executed", value: 2 });
    expect(phases).toEqual(["before-execute:reusable"]);
    expect(claims).toBe(0);

    const denied = await fixture(11_103, false);
    const deniedPrepared = await preflight(denied);
    let executions = 0;
    expect(await coordinateGrantAuthoritySetUseV2({
      preflight: deniedPrepared,
      storage: denied.store,
      resolveCurrentAuthorization: () => null,
      execute: () => {
        executions += 1;
        return "forbidden";
      },
    })).toEqual({ status: "unavailable" });
    expect(executions).toBe(0);
  });

  test("rejects incomplete, extra, and stale authority sets before claim", async () => {
    const cases: readonly ((
      state: Awaited<ReturnType<typeof fixture>>,
    ) => GrantAuthoritySetAuthorizationV2)[] = [
      (state) => ({
        ...state.authorization,
        domainRequirements: state.authorization.domainRequirements.slice(0, 1),
      }),
      (state) => ({
        ...state.authorization,
        domainRequirements: Object.freeze([
          ...state.authorization.domainRequirements,
          Object.freeze({
            domainId: cryptoDomainId("domain-extra"),
            expectedEpoch: domainEpoch(1),
            expectedAgentAuthorizationRevision: authorizationRevision(1),
          }),
        ]),
      }),
      (state) => ({
        ...state.authorization,
        domainRequirements: Object.freeze([
          {
            ...state.authorization.domainRequirements[0]!,
            expectedEpoch: domainEpoch(5),
          },
          state.authorization.domainRequirements[1]!,
        ]),
      }),
      (state) => ({
        ...state.authorization,
        domainRequirements: Object.freeze([
          state.authorization.domainRequirements[0]!,
          {
            ...state.authorization.domainRequirements[1]!,
            expectedAgentAuthorizationRevision: authorizationRevision(14),
          },
        ]),
      }),
      (state) => ({
        ...state.authorization,
        namespaceRequirements: state.authorization.namespaceRequirements
          .slice(0, 2),
      }),
    ];

    for (const [index, mutate] of cases.entries()) {
      const state = await fixture(11_200 + index);
      await expectPreflightRejection(state, mutate(state));
    }
  });

  test("fails closed on an adversarial changing authorization getter", async () => {
    const state = await fixture(11_250);
    const adversarial = { ...state.authorization };
    let namespaceReads = 0;
    Object.defineProperty(adversarial, "namespaceRequirements", {
      enumerable: true,
      get: () => {
        namespaceReads += 1;
        return namespaceReads === 1
          ? state.authorization.namespaceRequirements
          : state.authorization.namespaceRequirements.slice(0, 2);
      },
    });

    const prepared = await preflightGrantAuthoritySetUseV2(
      state.crypto,
      state.grant,
      adversarial,
    );
    expect(prepared).toBeNull();
    expect(namespaceReads).toBeGreaterThan(1);
    expect((await state.store.getGrant(state.grant.id))?.consumed).toBe(false);
  });

  test("fresh denial before claim rejects the complete work without storage mutation", async () => {
    const state = await fixture(11_300);
    const prepared = await preflight(state);
    let claims = 0;
    let executions = 0;

    const result = await coordinateGrantAuthoritySetUseV2({
      preflight: prepared,
      storage: {
        consumeGrant: (id) => {
          claims += 1;
          return state.store.consumeGrant(id);
        },
      },
      resolveCurrentAuthorization: (context) => {
        expect(context.phase).toBe("before-claim");
        return null;
      },
      execute: () => {
        executions += 1;
        return "forbidden";
      },
    });

    expect(result).toEqual({ status: "unavailable" });
    expect({ claims, executions }).toEqual({ claims: 0, executions: 0 });
    expect((await state.store.getGrant(state.grant.id))?.consumed).toBe(false);
  });

  test("rejects every independently stale before-claim decision axis", async () => {
    const mutations: readonly ((
      context: AuthorizationContext,
    ) => GrantAuthoritySetUseAuthorizationDecisionV2)[] = [
      (context) => ({ ...allowDecision(context), currentTime: context.preflightTime - 1 }),
      (context) => ({ ...allowDecision(context), currentTime: context.expiresAt }),
      (context) => ({ ...allowDecision(context), issuingDeviceActive: false }),
      (context) => ({ ...allowDecision(context), recipientAgentAuthorized: false }),
      (context) => ({ ...allowDecision(context), requestedNamespacesAuthorized: false }),
      (context) => ({ ...allowDecision(context), requestedDomainsAuthorized: false }),
      (context) => ({ ...allowDecision(context), hostAllowsOperation: false }),
      (context) => ({ ...allowDecision(context), currentSingleUseStatus: "reusable" }),
      (context) => ({
        ...allowDecision(context),
        context: { ...context, phase: "before-execute" },
      }),
      (context) => ({
        ...allowDecision(context),
        context: { ...context, preflightId: `${context.preflightId}-stale` },
      }),
      (context) => ({
        ...allowDecision(context),
        context: { ...context, grantId: grantId("other-grant") },
      }),
      (context) => ({
        ...allowDecision(context),
        context: { ...context, grantHash: bytes(0x41) },
      }),
      (context) => ({
        ...allowDecision(context),
        context: { ...context, grantBytes: new Uint8Array([1]) },
      }),
      (context) => ({
        ...allowDecision(context),
        context: { ...context, issuingDeviceId: "other-device" },
      }),
      (context) => ({
        ...allowDecision(context),
        context: { ...context, issuingDeviceHumanId: "mallory" },
      }),
      (context) => ({
        ...allowDecision(context),
        context: { ...context, issuingDeviceSigningPublicKeyHash: bytes(0x42) },
      }),
      (context) => ({
        ...allowDecision(context),
        context: { ...context, recipientAgentId: "other-agent" },
      }),
      (context) => ({
        ...allowDecision(context),
        context: { ...context, recipientKeyId: "other-key" },
      }),
      (context) => ({
        ...allowDecision(context),
        context: { ...context, grantScope: ["bob"] },
      }),
      (context) => ({
        ...allowDecision(context),
        context: { ...context, operations: ["decrypt"] },
      }),
      (context) => ({
        ...allowDecision(context),
        context: { ...context, issuedAt: context.issuedAt + 1 },
      }),
      (context) => ({
        ...allowDecision(context),
        context: { ...context, expiresAt: context.expiresAt + 1 },
      }),
      (context) => ({
        ...allowDecision(context),
        context: { ...context, preflightTime: context.preflightTime + 1 },
      }),
      (context) => ({
        ...allowDecision(context),
        context: {
          ...context,
          requestedNamespaces: context.requestedNamespaces.slice(1),
        },
      }),
      (context) => ({
        ...allowDecision(context),
        context: {
          ...context,
          requestedDomains: context.requestedDomains.slice(1),
        },
      }),
      (context) => ({
        ...allowDecision(context),
        context: { ...context, singleUseStatus: "reusable" },
      }),
    ];

    for (const [index, mutate] of mutations.entries()) {
      const state = await fixture(11_310 + index);
      const prepared = await preflight(state);
      let claims = 0;
      let executions = 0;
      const result = await coordinateGrantAuthoritySetUseV2({
        preflight: prepared,
        storage: {
          consumeGrant: (id) => {
            claims += 1;
            return state.store.consumeGrant(id);
          },
        },
        resolveCurrentAuthorization: (context) => mutate(context),
        execute: () => {
          executions += 1;
          return "forbidden";
        },
      });
      expect(result).toEqual({ status: "unavailable" });
      expect({ claims, executions }).toEqual({ claims: 0, executions: 0 });
    }
  });

  test("rejects malformed fresh decisions before any claim", async () => {
    const mutations: readonly ((
      decision: ReturnType<typeof allowDecision>,
    ) => unknown)[] = [
      (decision) => ({ ...decision, unexpected: true }),
      (decision) => {
        const { context: _context, ...missing } = decision;
        return missing;
      },
      (decision) => ({ ...decision, currentTime: Number.NaN }),
      (decision) => ({ ...decision, issuingDeviceActive: "yes" }),
      (decision) => ({ ...decision, recipientAgentAuthorized: "yes" }),
      (decision) => ({ ...decision, requestedNamespacesAuthorized: "yes" }),
      (decision) => ({ ...decision, requestedDomainsAuthorized: "yes" }),
      (decision) => ({ ...decision, hostAllowsOperation: "yes" }),
      (decision) => ({ ...decision, currentSingleUseStatus: "unknown" }),
    ];

    for (const [index, mutate] of mutations.entries()) {
      const state = await fixture(11_350 + index);
      const prepared = await preflight(state);
      let claims = 0;
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
      await expect(coordinateGrantAuthoritySetUseV2({
        preflight: prepared,
        storage: {
          consumeGrant: (id) => {
            claims += 1;
            return state.store.consumeGrant(id);
          },
        },
        resolveCurrentAuthorization: (context) =>
          mutate(allowDecision(context)) as never,
        execute: () => "forbidden",
      })).rejects.toThrow("decision is invalid");
      expect(claims).toBe(0);
    }
  });

  test("requires a resolver and rejects resolver mutation of its context", async () => {
    const missingState = await fixture(11_380);
    const missingPrepared = await preflight(missingState);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(coordinateGrantAuthoritySetUseV2({
      preflight: missingPrepared,
      storage: missingState.store,
      resolveCurrentAuthorization: undefined as never,
      execute: () => "forbidden",
    })).rejects.toThrow("resolver is required");

    const mutatedState = await fixture(11_381);
    const mutatedPrepared = await preflight(mutatedState);
    let claims = 0;
    const result = await coordinateGrantAuthoritySetUseV2({
      preflight: mutatedPrepared,
      storage: {
        consumeGrant: (id) => {
          claims += 1;
          return mutatedState.store.consumeGrant(id);
        },
      },
      resolveCurrentAuthorization: (context) => {
        context.grantHash.fill(0);
        return allowDecision(context);
      },
      execute: () => "forbidden",
    });
    expect(result).toEqual({ status: "unavailable" });
    expect(claims).toBe(0);
  });

  test("validates the claimed wire record exactly before execution", async () => {
    const other = await fixture(11_390);
    const cases: readonly ((
      state: Awaited<ReturnType<typeof fixture>>,
    ) => unknown)[] = [
      () => null,
      (state) => ({
        grantId: state.grant.id,
        grantBytes: serializeGrantV2(state.grant),
        consumed: false,
      }),
      (state) => ({
        grantId: state.grant.id,
        grantBytes: serializeGrantV2(state.grant),
        consumed: true,
        unexpected: true,
      }),
      (state) => ({
        grantId: state.grant.id,
        grantBytes: "not-bytes",
        consumed: true,
      }),
      () => ({
        grantId: other.grant.id,
        grantBytes: serializeGrantV2(other.grant),
        consumed: true,
      }),
    ];

    for (const [index, claimed] of cases.entries()) {
      const state = await fixture(11_400 + index);
      const prepared = await preflight(state);
      let executions = 0;
      const run = coordinateGrantAuthoritySetUseV2({
        preflight: prepared,
        storage: { consumeGrant: () => claimed(state) as never },
        resolveCurrentAuthorization: allowDecision,
        execute: () => {
          executions += 1;
          return "forbidden";
        },
      });
      if (index === 0) {
        expect(await run).toEqual({ status: "unavailable" });
      } else {
        // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
        await expect(run).rejects.toThrow(/Claimed Grant/);
      }
      expect(executions).toBe(0);
    }
  });

  test("wraps an ambiguous claim failure and never retries the preflight", async () => {
    const state = await fixture(11_410);
    const prepared = await preflight(state);
    const cause = new Error("storage acknowledgement lost");
    let claims = 0;
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(coordinateGrantAuthoritySetUseV2({
      preflight: prepared,
      storage: {
        consumeGrant: () => {
          claims += 1;
          throw cause;
        },
      },
      resolveCurrentAuthorization: allowDecision,
      execute: () => "forbidden",
    })).rejects.toMatchObject({
      name: "GrantClaimOutcomeUnknownV2",
      cause,
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(coordinateGrantAuthoritySetUseV2({
      preflight: prepared,
      storage: state.store,
      resolveCurrentAuthorization: allowDecision,
      execute: () => "forbidden",
    })).rejects.toThrow("already used");
    expect(claims).toBe(1);
  });

  test("fresh denial after the one claim rejects the complete work before execute", async () => {
    const state = await fixture(11_301);
    const prepared = await preflight(state);
    let claims = 0;
    let executions = 0;

    const observed = await observeAuthorityRootWipes(() =>
      coordinateGrantAuthoritySetUseV2({
        preflight: prepared,
        storage: {
          consumeGrant: (id) => {
            claims += 1;
            return state.store.consumeGrant(id);
          },
        },
        resolveCurrentAuthorization: (context) =>
          context.phase === "before-claim" ? allowDecision(context) : null,
        execute: () => {
          executions += 1;
          return "forbidden";
        },
      })
    );

    expect(observed.result).toEqual({ status: "unavailable" });
    expect({ claims, executions }).toEqual({ claims: 1, executions: 0 });
    expect((await state.store.getGrant(state.grant.id))?.consumed).toBe(true);
    expect(observed.wipedMarkers).toEqual([0xa1, 0xb2]);
  });

  test("rejects forged and replayed preflights without another claim", async () => {
    const state = await fixture(11_400);
    const prepared = await preflight(state);
    const forged = Object.freeze({
      grantId: state.grant.id,
      preflightId: "forged-authority-set-preflight",
      singleUse: true,
    }) as typeof prepared;

    expect(() => abortGrantAuthoritySetUseV2(forged)).toThrow("untrusted");
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(
      coordinateGrantAuthoritySetUseV2({
        preflight: forged,
        storage: state.store,
        resolveCurrentAuthorization: allowDecision,
        execute: () => "forbidden",
      }),
    ).rejects.toThrow("untrusted");

    let claims = 0;
    await coordinateGrantAuthoritySetUseV2({
      preflight: prepared,
      storage: {
        consumeGrant: (id) => {
          claims += 1;
          return state.store.consumeGrant(id);
        },
      },
      resolveCurrentAuthorization: allowDecision,
      execute: () => "once",
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(
      coordinateGrantAuthoritySetUseV2({
        preflight: prepared,
        storage: state.store,
        resolveCurrentAuthorization: allowDecision,
        execute: () => "replayed",
      }),
    ).rejects.toThrow("already used");
    expect(claims).toBe(1);
  });

  test("aborts a trusted preflight exactly once", async () => {
    const state = await fixture(11_450);
    const prepared = await preflight(state);
    abortGrantAuthoritySetUseV2(prepared);
    expect(() => abortGrantAuthoritySetUseV2(prepared)).toThrow(
      "already used",
    );
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(coordinateGrantAuthoritySetUseV2({
      preflight: prepared,
      storage: state.store,
      resolveCurrentAuthorization: allowDecision,
      execute: () => "forbidden",
    })).rejects.toThrow("already used");
    expect((await state.store.getGrant(state.grant.id))?.consumed).toBe(false);
  });
});
