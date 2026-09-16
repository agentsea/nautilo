import { describe, expect, test } from "bun:test";
import {
  coordinateProviderTransitionV2 as coordinateProviderTransitionWithAuthorizationV2,
  ProviderTransitionOutcomeUnknownV2,
  type ProviderTransitionAuthorizationContextV2,
  type ProviderTransitionAuthorizationDecisionV2,
} from "../../src/transition/provider-coordinator.ts";
import {
  InMemoryV2Store,
  type CryptoDomainPublicRecordV2,
} from "../../src/storage/v2-store.ts";
import {
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  authorizationRevision,
} from "../../src/v2-types/ids.ts";
import {
  participantDigest,
} from "../../src/domain/participants.ts";
import {
  LatticeCrypto,
  seededRng,
} from "../../src/crypto/index.ts";
import {
  DeviceProviderStateVaultV2,
  type SealedProviderStateV2,
} from "../../src/device/v2-state-vault.ts";
import { TsMlsV2GroupProvider } from "../../src/group/v2-mls.ts";
import {
  v2ProviderMatrix,
  type V2ProviderFixture,
} from "../../src/testing/v2-matrix.ts";
import type {
  V2GroupKeyProvider,
} from "../../src/group/v2-provider.ts";
import {
  destroyOpenedProviderCandidateStateV2,
  markLocalProviderCandidateV2,
  openLocalProviderCandidateV2,
  sealLocalProviderCandidateV2,
  PreparedProviderCommitV2,
  type ProviderCandidateLifecycleV2,
  type ProviderPublicTransitionV2,
  ProviderApplyResultV2,
} from "../../src/transition/provider-candidate.ts";
import {
  authorizeProviderHeadWriteV2,
  consumeAuthorizedProviderHeadWriteV2,
} from "../../src/transition/provider-authorized-write.ts";

type ProviderCoordinationInputV2 = Parameters<
  typeof coordinateProviderTransitionWithAuthorizationV2
>[0];

async function expectExactRejection(
  action: Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
    return;
  }
  throw new Error(`expected exact error: ${message}`);
}

function allowDecision(
  context: ProviderTransitionAuthorizationContextV2,
): ProviderTransitionAuthorizationDecisionV2 {
  return Object.freeze({
    ...context,
    currentHead: {
      ...context.currentHead,
      stateHash: context.currentHead.stateHash.slice(),
    },
    nextHead: {
      ...context.nextHead,
      stateHash: context.nextHead.stateHash.slice(),
    },
    publicTransitionDigest: context.publicTransitionDigest.slice(),
    authorized: true,
    actorStatus: "active",
  });
}

function coordinateProviderTransitionV2(
  input: Omit<ProviderCoordinationInputV2, "authorization">,
) {
  return coordinateProviderTransitionWithAuthorizationV2({
    ...input,
    authorization: {
      authorizationRevision: authorizationRevision(0),
      resolveCurrentAuthorization: allowDecision,
    },
  });
}

function flipByte(bytes: Uint8Array, index: number): void {
  bytes[index] = bytes[index]! ^ 1;
}

function providerAuthorization(
  prepared: PreparedProviderCommitV2,
): ProviderTransitionAuthorizationContextV2 {
  return Object.freeze({
    providerId: prepared.publicResult.providerId,
    domainId: prepared.publicResult.domainId,
    authorizationRevision: authorizationRevision(7),
    actorDeviceId: prepared.localCandidate.deviceId,
    operation: prepared.publicResult.operation,
    targetHumanId: prepared.publicResult.targetHumanId,
    targetDeviceId: prepared.publicResult.targetDeviceId,
    currentHead: prepared.publicResult.expectedHead,
    nextHead: prepared.publicResult.nextHead,
    candidateId: prepared.localCandidate.candidateId,
    publicTransitionDigest:
      prepared.localCandidate.publicTransitionDigest,
  });
}

function domainRecord(
  fixture: V2ProviderFixture,
): CryptoDomainPublicRecordV2 {
  const head = fixture.provider.publicHead(fixture.active);
  return {
    id: head.domainId,
    participantDigest: participantDigest([humanId("alice")]),
    participants: ["alice"],
    epoch: Number(head.epoch),
    authorizationRevision: 0,
    rosterBytes: new Uint8Array(),
  };
}

async function initializedStore(
  fixture: V2ProviderFixture,
  currentAuthorizationRevision = authorizationRevision(0),
): Promise<InMemoryV2Store> {
  const store = new InMemoryV2Store();
  const rosterBytes = fixture.provider.publicRoster(fixture.active);
  const record = {
    ...domainRecord(fixture),
    authorizationRevision: currentAuthorizationRevision,
    rosterBytes,
  };
  await store.createDomainIfAbsent(record);
  expect(
    await store.putDomainProviderHeadIfAbsent(
      fixture.provider.publicHead(fixture.active),
      rosterBytes,
    ),
  ).toBe("inserted");
  return store;
}

function providerWrapper(
  base: V2GroupKeyProvider,
  overrides: Partial<{
    readonly publicHead:
      V2GroupKeyProvider["publicHead"];
    readonly validatePreparedCandidate:
      V2GroupKeyProvider["validatePreparedCandidate"];
    readonly applyCandidate:
      V2GroupKeyProvider["applyCandidate"];
    readonly abortCandidate:
      V2GroupKeyProvider["abortCandidate"];
  }>,
): V2GroupKeyProvider {
  return {
    id: base.id,
    publicHead: overrides.publicHead ?? base.publicHead.bind(base),
    publicRoster: base.publicRoster.bind(base),
    exportDomainRoots: base.exportDomainRoots.bind(base),
    prepareCommit: base.prepareCommit.bind(base),
    prepareIncoming: base.prepareIncoming.bind(base),
    validatePreparedCandidate:
      overrides.validatePreparedCandidate
      ?? base.validatePreparedCandidate.bind(base),
    applyCandidate:
      overrides.applyCandidate ?? base.applyCandidate.bind(base),
    abortCandidate:
      overrides.abortCandidate ?? base.abortCandidate.bind(base),
  };
}

async function dummyFixture(
  suffix: string,
): Promise<V2ProviderFixture> {
  const row = v2ProviderMatrix.find((candidate) => candidate.id === "dummy");
  if (!row) throw new Error("dummy provider row is absent");
  return row.create({
    seed: 8_900,
    domainId: cryptoDomainId(`domain-provider-adversary-${suffix}`),
  });
}

function tsMlsProvider(
  deviceId: string,
  seed: number,
): TsMlsV2GroupProvider {
  return tsMlsDevice(deviceId, seed & 0xff, seed).provider;
}

function tsMlsDevice(
  deviceId: string,
  keyFill: number,
  seed: number,
) {
  const crypto = new LatticeCrypto(seededRng(seed));
  const vault = DeviceProviderStateVaultV2.fromKey(
    crypto,
    cryptoDeviceId(deviceId),
    new Uint8Array(32).fill(keyFill),
  );
  return {
    crypto,
    vault,
    provider: new TsMlsV2GroupProvider(crypto, vault),
  };
}

function resealTsMlsCandidate(input: {
  readonly crypto: LatticeCrypto;
  readonly vault: DeviceProviderStateVaultV2;
  readonly prepared: PreparedProviderCommitV2;
  readonly payloadCandidate?: PreparedProviderCommitV2["localCandidate"];
  readonly publicResult?: ProviderPublicTransitionV2;
  readonly sourceId?: string;
}): PreparedProviderCommitV2["localCandidate"] {
  const publicResult = input.publicResult ?? input.prepared.publicResult;
  const opened = openLocalProviderCandidateV2({
    vault: input.vault,
    candidate: input.payloadCandidate ?? input.prepared.localCandidate,
  });
  try {
    return sealLocalProviderCandidateV2({
      crypto: input.crypto,
      vault: input.vault,
      providerId: publicResult.providerId,
      domainId: publicResult.domainId,
      expectedHead: publicResult.expectedHead,
      nextHead: publicResult.nextHead,
      publicTransition: publicResult,
      payload: opened.payload,
      ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
    });
  } finally {
    destroyOpenedProviderCandidateStateV2(opened);
  }
}

function tsMlsCandidateLifecycle(
  vault: DeviceProviderStateVaultV2,
  candidate: PreparedProviderCommitV2["localCandidate"],
): ProviderCandidateLifecycleV2 {
  const opened = openLocalProviderCandidateV2({ vault, candidate });
  try {
    return opened.lifecycle;
  } finally {
    destroyOpenedProviderCandidateStateV2(opened);
  }
}

async function tsMlsLifecycleFixture(
  suffix: string,
  seed: number,
): Promise<{
  readonly crypto: LatticeCrypto;
  readonly vault: DeviceProviderStateVaultV2;
  readonly provider: TsMlsV2GroupProvider;
  readonly restart: TsMlsV2GroupProvider;
  readonly active: SealedProviderStateV2;
}> {
  const deviceId = `alice-lifecycle-${suffix}`;
  const keyFill = seed & 0xff;
  const device = tsMlsDevice(deviceId, keyFill, seed);
  const restart = tsMlsDevice(deviceId, keyFill, seed + 10_000).provider;
  const active = await device.provider.createInitialState({
    domainId: cryptoDomainId(`domain-lifecycle-${suffix}`),
    humanId: humanId("alice"),
  });
  return { ...device, restart, active };
}

async function tsMlsWelcomeFixture(
  suffix: string,
  seed: number,
) {
  const domainId = cryptoDomainId(`domain-welcome-${suffix}`);
  const alice = tsMlsDevice(`alice-welcome-${suffix}`, 0xa1, seed);
  const bobDeviceId = `bob-welcome-${suffix}`;
  const bob = tsMlsDevice(bobDeviceId, 0xb2, seed + 1);
  const restartedBob = tsMlsDevice(
    bobDeviceId,
    0xb2,
    seed + 10_001,
  ).provider;
  const aliceActive = await alice.provider.createInitialState({
    domainId,
    humanId: humanId("alice"),
  });
  const join = await bob.provider.createJoinRequest({
    domainId,
    humanId: humanId("bob"),
    expectedHead: alice.provider.publicHead(aliceActive),
  });
  const add = await alice.provider.prepareAdd({
    active: aliceActive,
    joinRequest: join.publicResult,
  });
  const candidate = await bob.provider.prepareWelcome({
    joinState: join.localState,
    publicResult: add.publicResult,
  });
  return {
    domainId,
    alice,
    bob,
    restartedBob,
    aliceActive,
    join,
    add,
    candidate,
  };
}

async function tsMlsAddFixture(): Promise<{
  readonly fixture: V2ProviderFixture;
  readonly prepared: PreparedProviderCommitV2;
}> {
  const domainId = cryptoDomainId("domain-provider-add-detachment");
  const alice = tsMlsProvider("alice-provider-device", 91);
  const bob = tsMlsProvider("bob-provider-device", 92);
  const active = await alice.createInitialState({
    domainId,
    humanId: humanId("alice"),
  });
  const join = await bob.createJoinRequest({
    domainId,
    humanId: humanId("bob"),
    expectedHead: alice.publicHead(active),
  });
  const prepared = await alice.prepareAdd({
    active,
    joinRequest: join.publicResult,
  });
  return {
    fixture: {
      crypto: new LatticeCrypto(seededRng(93)),
      provider: alice,
      active,
    },
    prepared,
  };
}

describe("v2 provider transition storage coordinator", () => {
  test("authorized provider-head writes detach mint inputs, bind every mutable byte leaf, and are single-use", async () => {
    const fixture = await dummyFixture("capability-bytes");
    const prepared = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    const expected = structuredClone(prepared.publicResult.expectedHead);
    const next = structuredClone(prepared.publicResult.nextHead);
    const roster = Buffer.from(prepared.publicResult.rosterBytes);
    const originalExpectedHash = expected.stateHash.slice();
    const originalNextHash = next.stateHash.slice();
    const originalRoster = Uint8Array.from(roster);
    const detached = authorizeProviderHeadWriteV2({
      expected,
      next,
      nextRosterBytes: roster,
      authorization: providerAuthorization(prepared),
    });
    for (const immutableRecord of [
      detached,
      detached.expected,
      detached.next,
      detached.authorization,
      detached.authorization.currentHead,
      detached.authorization.nextHead,
    ]) {
      expect(Object.isFrozen(immutableRecord)).toBeTrue();
    }
    expect(Reflect.set(
      detached.authorization,
      "candidateId",
      "forged-candidate",
    )).toBeFalse();
    expect(detached.authorization.candidateId).toBe(
      prepared.localCandidate.candidateId,
    );
    expected.stateHash.fill(0xee);
    next.stateHash.fill(0xdd);
    roster.fill(0xcc);
    const consumed = consumeAuthorizedProviderHeadWriteV2(detached);
    expect(consumed).toEqual({
      expected: {
        ...prepared.publicResult.expectedHead,
        stateHash: originalExpectedHash,
      },
      next: {
        ...prepared.publicResult.nextHead,
        stateHash: originalNextHash,
      },
      nextRosterBytes: originalRoster,
      authorization: providerAuthorization(prepared),
    });
    expect(Buffer.isBuffer(consumed.nextRosterBytes)).toBeFalse();
    expect(() =>
      consumeAuthorizedProviderHeadWriteV2(detached)
    ).toThrow("authorized provider-head write capability");
    for (const forged of [
      null,
      "capability",
      {},
      { expected, next },
      {
        expected,
        next,
        nextRosterBytes: originalRoster,
        unexpected: true,
      },
    ]) {
      expect(() =>
        consumeAuthorizedProviderHeadWriteV2(forged as never)
      ).toThrow("authorized provider-head write capability");
    }

    for (const mutate of [
      (write: ReturnType<typeof authorizeProviderHeadWriteV2>) => {
        write.expected.stateHash[0] = write.expected.stateHash[0]! ^ 1;
      },
      (write: ReturnType<typeof authorizeProviderHeadWriteV2>) => {
        const index = write.expected.stateHash.length - 1;
        write.expected.stateHash[index] =
          write.expected.stateHash[index]! ^ 1;
      },
      (write: ReturnType<typeof authorizeProviderHeadWriteV2>) => {
        write.next.stateHash[0] = write.next.stateHash[0]! ^ 1;
      },
      (write: ReturnType<typeof authorizeProviderHeadWriteV2>) => {
        const index = write.next.stateHash.length - 1;
        write.next.stateHash[index] = write.next.stateHash[index]! ^ 1;
      },
      (write: ReturnType<typeof authorizeProviderHeadWriteV2>) => {
        write.nextRosterBytes[0] = write.nextRosterBytes[0]! ^ 1;
      },
      (write: ReturnType<typeof authorizeProviderHeadWriteV2>) => {
        const index = write.nextRosterBytes.length - 1;
        write.nextRosterBytes[index] =
          write.nextRosterBytes[index]! ^ 1;
      },
      (write: ReturnType<typeof authorizeProviderHeadWriteV2>) => {
        flipByte(write.authorization.currentHead.stateHash, 0);
      },
      (write: ReturnType<typeof authorizeProviderHeadWriteV2>) => {
        flipByte(write.authorization.nextHead.stateHash, 0);
      },
      (write: ReturnType<typeof authorizeProviderHeadWriteV2>) => {
        flipByte(write.authorization.publicTransitionDigest, 0);
      },
    ]) {
      const capability = authorizeProviderHeadWriteV2({
        expected: prepared.publicResult.expectedHead,
        next: prepared.publicResult.nextHead,
        nextRosterBytes: prepared.publicResult.rosterBytes,
        authorization: providerAuthorization(prepared),
      });
      mutate(capability);
      expect(() =>
        consumeAuthorizedProviderHeadWriteV2(capability)
      ).toThrow("authorized provider-head write capability");
      expect(() =>
        consumeAuthorizedProviderHeadWriteV2(capability)
      ).toThrow("authorized provider-head write capability");
    }

    expect(() => authorizeProviderHeadWriteV2({
      expected: prepared.publicResult.expectedHead,
      next: prepared.publicResult.nextHead,
      nextRosterBytes: prepared.publicResult.rosterBytes,
      authorization: {
        ...providerAuthorization(prepared),
        nextHead: {
          ...prepared.publicResult.nextHead,
          stateHash: new Uint8Array(32).fill(0xa5),
        },
      },
    })).toThrow(
      "Provider-head write authorization does not match the exact CAS pair",
    );

    const exactAuthorization = providerAuthorization(prepared);
    for (const [expected, authorization] of [
      [
        {
          ...prepared.publicResult.expectedHead,
          providerId: "provider-other",
        },
        {
          ...exactAuthorization,
          currentHead: {
            ...exactAuthorization.currentHead,
            providerId: "provider-other",
          },
        },
      ],
      [
        {
          ...prepared.publicResult.expectedHead,
          domainId: cryptoDomainId("domain-other"),
        },
        {
          ...exactAuthorization,
          currentHead: {
            ...exactAuthorization.currentHead,
            domainId: cryptoDomainId("domain-other"),
          },
        },
      ],
    ] as const) {
      expect(() => authorizeProviderHeadWriteV2({
        expected,
        next: prepared.publicResult.nextHead,
        nextRosterBytes: prepared.publicResult.rosterBytes,
        authorization,
      })).toThrow(
        "Provider-head write authorization does not match the exact CAS pair",
      );
    }
  });

  test("CAS capability carries the detached exact fresh authorization context", async () => {
    const fixture = await dummyFixture("cas-authorization");
    const prepared = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    const observed: {
      resolverContext?: ProviderTransitionAuthorizationContextV2;
      captured?: ReturnType<typeof authorizeProviderHeadWriteV2>;
    } = {};
    expect(await coordinateProviderTransitionWithAuthorizationV2({
      storage: {
        compareAndSwapDomainProviderHead: async (authorized) => {
          observed.captured = authorized;
          return "stale";
        },
      },
      provider: fixture.provider,
      active: fixture.active,
      prepared,
      authorization: {
        authorizationRevision: authorizationRevision(7),
        resolveCurrentAuthorization: (context) => {
          observed.resolverContext = context;
          return allowDecision(context);
        },
      },
    })).toMatchObject({ status: "stale" });
    if (
      observed.resolverContext === undefined
      || observed.captured === undefined
    ) {
      throw new Error("missing authorization boundary capture");
    }
    const { resolverContext, captured } = observed;
    expect(captured.authorization).toEqual(resolverContext);
    expect(captured.authorization).not.toBe(resolverContext);
    expect(captured.authorization.currentHead)
      .not.toBe(resolverContext.currentHead);
    expect(captured.authorization.nextHead).not.toBe(resolverContext.nextHead);
    expect(captured.authorization.publicTransitionDigest)
      .not.toBe(resolverContext.publicTransitionDigest);
    flipByte(resolverContext.publicTransitionDigest, 0);
    expect(captured.authorization.publicTransitionDigest).toEqual(
      prepared.localCandidate.publicTransitionDigest,
    );
  });

  for (const [index, row] of v2ProviderMatrix.entries()) {
    test(`${row.id}: prepare, abort, stale CAS, duplicate delivery, and retry remain atomic`, async () => {
      const domainId = cryptoDomainId(`domain-coordinator-${row.id}`);
      const fixture = await row.create({
        seed: 8_100 + index * 100,
        domainId,
      });
      const store = await initializedStore(fixture);
      const initialHead = fixture.provider.publicHead(fixture.active);
      const detachedRoster = fixture.provider.publicRoster(fixture.active);
      const expectedRoster = detachedRoster.slice();
      detachedRoster.fill(0xff);
      expect(fixture.provider.publicRoster(fixture.active)).toEqual(
        expectedRoster,
      );
      expect(
        fixture.provider.publicRoster(fixture.active),
      ).toEqual(store.snapshot().domains[0]!.rosterBytes);
      if (row.id !== "dummy") {
        expect(
          store.snapshot().domains[0]!.rosterBytes.length,
        ).toBeGreaterThan(0);
      }

      const aborted = await fixture.provider.prepareCommit({
        active: fixture.active,
      });
      fixture.provider.abortCandidate(aborted.localCandidate);
      const abortedResult = await coordinateProviderTransitionV2({
        storage: store,
        provider: fixture.provider,
        active: fixture.active,
        prepared: aborted,
      });
      expect(abortedResult.status).toBe("aborted");
      expect(await store.getDomainProviderHead(domainId)).toEqual(initialHead);

      const stale = await fixture.provider.prepareCommit({
        active: fixture.active,
      });
      const retry = await fixture.provider.prepareCommit({
        active: fixture.active,
      });
      const ambiguousCause = new Error("ambiguous storage outcome");
      let ambiguousError: unknown;
      try {
        await coordinateProviderTransitionV2({
          storage: {
            compareAndSwapDomainProviderHead: () => Promise.reject(
              ambiguousCause,
            ),
          },
          provider: fixture.provider,
          active: fixture.active,
          prepared: retry,
        });
      } catch (error) {
        ambiguousError = error;
      }
      expect(ambiguousError).toBeInstanceOf(
        ProviderTransitionOutcomeUnknownV2,
      );
      expect((ambiguousError as Error).name).toBe(
        "ProviderTransitionOutcomeUnknownV2",
      );
      expect((ambiguousError as Error).message).toBe(
        "Provider transition storage outcome is ambiguous; retry must be explicit",
      );
      expect((ambiguousError as Error).cause).toBe(ambiguousCause);
      expect(await store.getDomainProviderHead(domainId)).toEqual(initialHead);

      // An ambiguous CAS result is never retried internally and leaves the
      // sealed candidate prepared for an explicit caller-directed retry.
      const applied = await coordinateProviderTransitionV2({
        storage: store,
        provider: fixture.provider,
        active: fixture.active,
        prepared: retry,
      });
      expect(applied.status).toBe("applied");
      expect(await store.getDomainProviderHead(domainId)).toEqual(
        retry.publicResult.nextHead,
      );
      expect(fixture.provider.publicHead(applied.active)).toEqual(
        retry.publicResult.nextHead,
      );
      const serverSnapshot = JSON.stringify(store.snapshot());
      expect(serverSnapshot).not.toContain("candidateId");
      expect(serverSnapshot).not.toContain(
        "device-local-provider-ciphertext",
      );
      expect(serverSnapshot).not.toContain("exporterSecret");
      expect(serverSnapshot).not.toContain("domainRoot");

      const replay = await coordinateProviderTransitionV2({
        storage: store,
        provider: fixture.provider,
        active: applied.active,
        prepared: retry,
      });
      expect(replay.status).toBe("duplicate");
      expect(fixture.provider.publicHead(replay.active)).toEqual(
        retry.publicResult.nextHead,
      );

      const staleResult = await coordinateProviderTransitionV2({
        storage: store,
        provider: fixture.provider,
        active: fixture.active,
        prepared: stale,
      });
      expect(staleResult.status).toBe("stale");
      expect(fixture.provider.publicHead(staleResult.active)).toEqual(
        initialHead,
      );
      expect(await store.getDomainProviderHead(domainId)).toEqual(
        retry.publicResult.nextHead,
      );
      expect(
        fixture.provider.applyCandidate({
          active: fixture.active,
          candidate: stale.localCandidate,
        }).status,
      ).toBe("aborted");
    }, 60_000);

    test(`${row.id}: malformed local candidates cannot partially advance the public head`, async () => {
      const domainId = cryptoDomainId(`domain-malformed-${row.id}`);
      const fixture = await row.create({
        seed: 8_200 + index * 100,
        domainId,
      });
      const store = await initializedStore(fixture);
      const initialHead = fixture.provider.publicHead(fixture.active);
      const prepared = await fixture.provider.prepareCommit({
        active: fixture.active,
      });
      const malformed = structuredClone(prepared);
      const lastCiphertextIndex =
        malformed.localCandidate.snapshot.ciphertext.length - 1;
      malformed.localCandidate.snapshot.ciphertext[lastCiphertextIndex] =
        malformed.localCandidate.snapshot.ciphertext[lastCiphertextIndex]!
        ^ 0x01;

      expect(
        coordinateProviderTransitionV2({
          storage: store,
          provider: fixture.provider,
          active: fixture.active,
          prepared: malformed,
        }),
      ).rejects.toThrow();
      expect(await store.getDomainProviderHead(domainId)).toEqual(initialHead);

      const retargetedDigest = structuredClone(prepared);
      retargetedDigest.localCandidate.publicTransitionDigest[0] =
        retargetedDigest.localCandidate.publicTransitionDigest[0]! ^ 0x01;
      expect(
        coordinateProviderTransitionV2({
          storage: store,
          provider: fixture.provider,
          active: fixture.active,
          prepared: retargetedDigest,
        }),
      ).rejects.toThrow();
      expect(await store.getDomainProviderHead(domainId)).toEqual(initialHead);

      const malformedPublic = structuredClone(prepared);
      const lastCommitIndex =
        malformedPublic.publicResult.commitBytes.length - 1;
      malformedPublic.publicResult.commitBytes[lastCommitIndex] =
        malformedPublic.publicResult.commitBytes[lastCommitIndex]! ^ 0x01;
      expect(
        coordinateProviderTransitionV2({
          storage: store,
          provider: fixture.provider,
          active: fixture.active,
          prepared: malformedPublic,
        }),
      ).rejects.toThrow();
      expect(await store.getDomainProviderHead(domainId)).toEqual(initialHead);
    }, 60_000);

    test(`${row.id}: caller mutation during CAS cannot change the validated active snapshot`, async () => {
      const domainId = cryptoDomainId(`domain-detached-${row.id}`);
      const fixture = await row.create({
        seed: 8_300 + index * 100,
        domainId,
      });
      const store = await initializedStore(fixture);
      const prepared = await fixture.provider.prepareCommit({
        active: fixture.active,
      });
      let attempts = 0;

      const result = await coordinateProviderTransitionV2({
        storage: {
          compareAndSwapDomainProviderHead: async (authorized) => {
            attempts += 1;
            fixture.active.ciphertext.fill(0xff);
            prepared.publicResult.commitBytes.fill(0xff);
            prepared.localCandidate.publicTransitionDigest.fill(0xff);
            await Promise.resolve();
            return await store.compareAndSwapDomainProviderHead(
              authorized,
            );
          },
        },
        provider: fixture.provider,
        active: fixture.active,
        prepared,
      });

      expect(attempts).toBe(1);
      expect(result.status).toBe("applied");
      expect(fixture.provider.publicHead(result.active)).toEqual(
        prepared.publicResult.nextHead,
      );
      expect(await store.getDomainProviderHead(domainId)).toEqual(
        prepared.publicResult.nextHead,
      );
    }, 60_000);

    test(`${row.id}: applied candidate replay is bound to the exact public transition`, async () => {
      const domainId = cryptoDomainId(`domain-exact-replay-${row.id}`);
      const fixture = await row.create({
        seed: 8_400 + index * 100,
        domainId,
      });
      const store = await initializedStore(fixture);
      const prepared = await fixture.provider.prepareCommit({
        active: fixture.active,
      });
      const applied = await coordinateProviderTransitionV2({
        storage: store,
        provider: fixture.provider,
        active: fixture.active,
        prepared,
      });
      expect(applied.status).toBe("applied");
      const persistedReplay = structuredClone(prepared);

      for (
        const field of [
          "commitBytes",
          "welcomeBytes",
          "rosterBytes",
        ] as const
      ) {
        const publicBytes = prepared.publicResult[field].slice();
        if (publicBytes.length === 0) {
          const tampered = {
            ...prepared,
            publicResult: {
              ...prepared.publicResult,
              [field]: new Uint8Array([0x01]),
            },
          };
          let storageCalls = 0;
          expect(
            coordinateProviderTransitionV2({
              storage: {
                compareAndSwapDomainProviderHead: () => {
                  storageCalls += 1;
                  return Promise.resolve("duplicate" as const);
                },
              },
              provider: fixture.provider,
              active: applied.active,
              prepared: tampered,
            }),
          ).rejects.toThrow();
          expect(storageCalls).toBe(0);
          continue;
        }

        publicBytes[publicBytes.length - 1] =
          publicBytes[publicBytes.length - 1]! ^ 0x01;
        const tampered = {
          ...prepared,
          publicResult: {
            ...prepared.publicResult,
            [field]: publicBytes,
          },
        };
        let storageCalls = 0;
        expect(
          coordinateProviderTransitionV2({
            storage: {
              compareAndSwapDomainProviderHead: () => {
                storageCalls += 1;
                return Promise.resolve("duplicate" as const);
              },
            },
            provider: fixture.provider,
            active: applied.active,
            prepared: tampered,
          }),
        ).rejects.toThrow();
        expect(storageCalls).toBe(0);
      }

      const exactReplay = await coordinateProviderTransitionV2({
        storage: store,
        provider: fixture.provider,
        active: applied.active,
        prepared: persistedReplay,
      });
      expect(exactReplay.status).toBe("duplicate");
    }, 60_000);
  }

  test("ts-mls candidate lifecycle is exact across expected, next, forked, and restarted heads", async () => {
    const fixture = await tsMlsLifecycleFixture("head-matrix", 9_101);

    const preparedAfterRestart = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    const restartedApply = fixture.restart.applyCandidate({
      active: fixture.active,
      candidate: preparedAfterRestart.localCandidate,
    });
    expect(restartedApply.status).toBe("applied");
    expect(
      fixture.restart.applyCandidate({
        active: restartedApply.active,
        candidate: preparedAfterRestart.localCandidate,
      }).status,
    ).toBe("duplicate");
    expect(
      fixture.restart.abortCandidate(preparedAfterRestart.localCandidate).status,
    ).toBe("already-applied");
    expect(() =>
      fixture.restart.applyCandidate({
        active: fixture.active,
        candidate: preparedAfterRestart.localCandidate,
      })
    ).toThrow("Applied MLS candidate cannot be replayed against its old head");

    const aborted = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    expect(fixture.provider.abortCandidate(aborted.localCandidate).status).toBe(
      "aborted",
    );
    expect(
      fixture.restart.applyCandidate({
        active: fixture.active,
        candidate: aborted.localCandidate,
      }).status,
    ).toBe("aborted");
    expect(fixture.restart.abortCandidate(aborted.localCandidate).status).toBe(
      "already-aborted",
    );

    const staleTombstone = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    markLocalProviderCandidateV2({
      vault: fixture.vault,
      candidate: staleTombstone.localCandidate,
      lifecycle: "stale",
    });
    expect(
      fixture.restart.applyCandidate({
        active: fixture.active,
        candidate: staleTombstone.localCandidate,
      }).status,
    ).toBe("aborted");
    expect(
      fixture.restart.abortCandidate(staleTombstone.localCandidate).status,
    ).toBe("already-aborted");

    const winner = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    const forked = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    expect(winner.publicResult.nextHead).not.toEqual(
      forked.publicResult.nextHead,
    );
    const winningActive = fixture.provider.applyCandidate({
      active: fixture.active,
      candidate: winner.localCandidate,
    }).active;
    expect(
      fixture.restart.applyCandidate({
        active: winningActive,
        candidate: forked.localCandidate,
      }).status,
    ).toBe("stale");
    expect(
      fixture.restart.applyCandidate({
        active: fixture.active,
        candidate: forked.localCandidate,
      }).status,
    ).toBe("aborted");
    expect(fixture.restart.abortCandidate(forked.localCandidate).status).toBe(
      "already-aborted",
    );
  }, 60_000);

  test("ts-mls prepared validation and replay preserve exact terminal lifecycle semantics", async () => {
    const fixture = await tsMlsLifecycleFixture(
      "prepared-validation",
      9_151,
    );

    const valid = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    await fixture.restart.validatePreparedCandidate({
      active: fixture.active,
      prepared: valid,
    });

    const applied = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    const stillPrepared = structuredClone(applied.localCandidate);
    const appliedActive = fixture.provider.applyCandidate({
      active: fixture.active,
      candidate: applied.localCandidate,
    }).active;
    await fixture.restart.validatePreparedCandidate({
      active: appliedActive,
      prepared: applied,
    });
    expect(
      fixture.restart.validatePreparedCandidate({
        active: fixture.active,
        prepared: applied,
      }),
    ).rejects.toThrow(
      "Applied ts-mls candidate does not match the active public head",
    );

    expect(
      fixture.restart.applyCandidate({
        active: appliedActive,
        candidate: stillPrepared,
      }).status,
    ).toBe("duplicate");
    expect(
      tsMlsCandidateLifecycle(fixture.vault, stillPrepared),
    ).toBe("applied");
    expect(fixture.restart.abortCandidate(stillPrepared).status).toBe(
      "already-applied",
    );

    for (const lifecycle of ["aborted", "stale"] as const) {
      const terminal = await fixture.provider.prepareCommit({
        active: fixture.active,
      });
      markLocalProviderCandidateV2({
        vault: fixture.vault,
        candidate: terminal.localCandidate,
        lifecycle,
      });
      expect(
        fixture.restart.validatePreparedCandidate({
          active: fixture.active,
          prepared: terminal,
        }),
      ).rejects.toThrow(
        "ts-mls prepared candidate does not match the active public head",
      );
    }

    const forkWinner = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    const forkLoser = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    const forkActive = fixture.provider.applyCandidate({
      active: fixture.active,
      candidate: forkWinner.localCandidate,
    }).active;
    expect(
      fixture.restart.validatePreparedCandidate({
        active: forkActive,
        prepared: forkLoser,
      }),
    ).rejects.toThrow(
      "ts-mls prepared candidate does not match the active public head",
    );

    const appliedOnOtherFork = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    fixture.provider.applyCandidate({
      active: fixture.active,
      candidate: appliedOnOtherFork.localCandidate,
    });
    expect(
      fixture.restart.applyCandidate({
        active: forkActive,
        candidate: appliedOnOtherFork.localCandidate,
      }).status,
    ).toBe("stale");
    expect(
      tsMlsCandidateLifecycle(
        fixture.vault,
        appliedOnOtherFork.localCandidate,
      ),
    ).toBe("applied");
    expect(
      fixture.restart.abortCandidate(appliedOnOtherFork.localCandidate).status,
    ).toBe("already-applied");

    const wrongSourcePrepared = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    const wrongSource = resealTsMlsCandidate({
      crypto: fixture.crypto,
      vault: fixture.vault,
      prepared: wrongSourcePrepared,
      sourceId: "join_wrong-abort-source",
    });
    expect(() => fixture.restart.abortCandidate(wrongSource)).toThrow(
      "MLS Welcome candidates require the Welcome lifecycle",
    );
  }, 60_000);

  test("ts-mls coordinator handles every terminal candidate lifecycle without an unsafe CAS", async () => {
    const fixture = await tsMlsLifecycleFixture("coordinator-matrix", 9_201);
    const providerFixture: V2ProviderFixture = {
      crypto: fixture.crypto,
      provider: fixture.provider,
      active: fixture.active,
    };

    for (const lifecycle of ["aborted", "stale"] as const) {
      const prepared = await fixture.provider.prepareCommit({
        active: fixture.active,
      });
      markLocalProviderCandidateV2({
        vault: fixture.vault,
        candidate: prepared.localCandidate,
        lifecycle,
      });
      let storageCalls = 0;
      const result = await coordinateProviderTransitionV2({
        storage: {
          compareAndSwapDomainProviderHead: () => {
            storageCalls += 1;
            return Promise.resolve("applied");
          },
        },
        provider: fixture.restart,
        active: fixture.active,
        prepared,
      });
      expect(result.status).toBe("aborted");
      expect(storageCalls).toBe(0);
    }

    const locallyApplied = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    const nextActive = fixture.provider.applyCandidate({
      active: fixture.active,
      candidate: locallyApplied.localCandidate,
    }).active;
    const store = await initializedStore(providerFixture);
    const recovered = await coordinateProviderTransitionV2({
      storage: store,
      provider: fixture.restart,
      active: nextActive,
      prepared: locallyApplied,
    });
    expect(recovered.status).toBe("applied");
    expect(fixture.restart.publicHead(recovered.active)).toEqual(
      locallyApplied.publicResult.nextHead,
    );
    expect(
      fixture.restart.abortCandidate(locallyApplied.localCandidate).status,
    ).toBe("already-applied");

    const wrongSourcePrepared = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    const wrongSource = resealTsMlsCandidate({
      crypto: fixture.crypto,
      vault: fixture.vault,
      prepared: wrongSourcePrepared,
      sourceId: "join_foreign",
    });
    let storageCalls = 0;
    expect(
      coordinateProviderTransitionV2({
        storage: {
          compareAndSwapDomainProviderHead: () => {
            storageCalls += 1;
            return Promise.resolve("applied");
          },
        },
        provider: fixture.restart,
        active: fixture.active,
        prepared: {
          publicResult: wrongSourcePrepared.publicResult,
          localCandidate: wrongSource,
        },
      }),
    ).rejects.toThrow("MLS Welcome candidates require the Welcome lifecycle");
    expect(storageCalls).toBe(0);
  }, 60_000);

  test("ts-mls coordinator rejects independently forged digest, roster, commit, and sealed head bindings before CAS", async () => {
    const fixture = await tsMlsLifecycleFixture("binding-matrix", 9_301);
    const initialHead = fixture.provider.publicHead(fixture.active);

    const expectRejectedBeforeCas = async (
      prepared: PreparedProviderCommitV2,
    ): Promise<void> => {
      let storageCalls = 0;
      expect(
        coordinateProviderTransitionV2({
          storage: {
            compareAndSwapDomainProviderHead: () => {
              storageCalls += 1;
              return Promise.resolve("applied");
            },
          },
          provider: fixture.restart,
          active: fixture.active,
          prepared,
        }),
      ).rejects.toThrow();
      expect(storageCalls).toBe(0);
      expect(fixture.restart.publicHead(fixture.active)).toEqual(initialHead);
    };

    const malformedCiphertext = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    flipByte(
      malformedCiphertext.localCandidate.snapshot.ciphertext,
      malformedCiphertext.localCandidate.snapshot.ciphertext.length - 1,
    );
    await expectRejectedBeforeCas(malformedCiphertext);

    const externalDigest = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    flipByte(externalDigest.localCandidate.publicTransitionDigest, 0);
    await expectRejectedBeforeCas(externalDigest);

    const rosterPrepared = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    const forgedRosterResult = structuredClone(rosterPrepared.publicResult);
    flipByte(
      forgedRosterResult.rosterBytes,
      forgedRosterResult.rosterBytes.length - 1,
    );
    await expectRejectedBeforeCas({
      publicResult: forgedRosterResult,
      localCandidate: resealTsMlsCandidate({
        crypto: fixture.crypto,
        vault: fixture.vault,
        prepared: rosterPrepared,
        publicResult: forgedRosterResult,
      }),
    });

    const commitPrepared = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    const forgedCommitResult = structuredClone(commitPrepared.publicResult);
    flipByte(
      forgedCommitResult.commitBytes,
      forgedCommitResult.commitBytes.length - 1,
    );
    await expectRejectedBeforeCas({
      publicResult: forgedCommitResult,
      localCandidate: resealTsMlsCandidate({
        crypto: fixture.crypto,
        vault: fixture.vault,
        prepared: commitPrepared,
        publicResult: forgedCommitResult,
      }),
    });

    for (const head of ["expectedHead", "nextHead"] as const) {
      const headPrepared = await fixture.provider.prepareCommit({
        active: fixture.active,
      });
      const forged = structuredClone(headPrepared);
      flipByte(forged.publicResult[head].stateHash, 0);
      flipByte(forged.localCandidate[head].stateHash, 0);
      await expectRejectedBeforeCas(forged);
    }

    const intended = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    const forked = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    const crossPayload = resealTsMlsCandidate({
      crypto: fixture.crypto,
      vault: fixture.vault,
      prepared: intended,
      payloadCandidate: forked.localCandidate,
    });
    const crossPrepared = {
      publicResult: intended.publicResult,
      localCandidate: crossPayload,
    };
    expect(() =>
      fixture.restart.applyCandidate({
        active: fixture.active,
        candidate: crossPayload,
      })
    ).toThrow("MLS candidate does not match its exact next public head");
    await expectRejectedBeforeCas(crossPrepared);
    expect(
      fixture.restart.validatePreparedCandidate({
        active: fixture.active,
        prepared: crossPrepared,
      }),
    ).rejects.toThrow(
      "ts-mls public transition does not match its sealed candidate",
    );
  }, 60_000);

  test("ts-mls incoming candidates bind transition bytes and retain lifecycle across restart", async () => {
    const domainId = cryptoDomainId("domain-incoming-lifecycle");
    const alice = tsMlsDevice("alice-incoming", 0xa1, 9_401);
    const bob = tsMlsDevice("bob-incoming", 0xb2, 9_402);
    const restartedBob = tsMlsDevice("bob-incoming", 0xb2, 9_499).provider;
    let aliceActive = await alice.provider.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const join = await bob.provider.createJoinRequest({
      domainId,
      humanId: humanId("bob"),
      expectedHead: alice.provider.publicHead(aliceActive),
    });
    const add = await alice.provider.prepareAdd({
      active: aliceActive,
      joinRequest: join.publicResult,
    });
    const welcome = await bob.provider.prepareWelcome({
      joinState: join.localState,
      publicResult: add.publicResult,
    });
    aliceActive = alice.provider.applyCandidate({
      active: aliceActive,
      candidate: add.localCandidate,
    }).active;
    let bobActive = bob.provider.activateWelcome({
      candidate: welcome,
      joinState: join.localState,
    }).active;

    const update = await alice.provider.prepareCommit({ active: aliceActive });
    const malformedExpected = structuredClone(update.publicResult);
    flipByte(malformedExpected.expectedHead.stateHash, 0);
    expect(
      restartedBob.prepareIncoming({
        active: bobActive,
        publicResult: malformedExpected,
      }),
    ).rejects.toThrow("exact expected public head");

    const wrongWireformat = {
      ...update.publicResult,
      commitBytes: join.publicResult.keyPackageBytes,
    };
    expect(
      restartedBob.prepareIncoming({
        active: bobActive,
        publicResult: wrongWireformat,
      }),
    ).rejects.toThrow("Expected an MLS commit message");

    const malformedRoster = structuredClone(update.publicResult);
    flipByte(
      malformedRoster.rosterBytes,
      malformedRoster.rosterBytes.length - 1,
    );
    expect(
      restartedBob.prepareIncoming({
        active: bobActive,
        publicResult: malformedRoster,
      }),
    ).rejects.toThrow("roster does not match");

    const malformedNext = structuredClone(update.publicResult);
    flipByte(malformedNext.nextHead.stateHash, 0);
    expect(
      restartedBob.prepareIncoming({
        active: bobActive,
        publicResult: malformedNext,
      }),
    ).rejects.toThrow("exact next public head");

    const incoming = await restartedBob.prepareIncoming({
      active: bobActive,
      publicResult: update.publicResult,
    });
    await restartedBob.validatePreparedCandidate({
      active: bobActive,
      prepared: {
        publicResult: update.publicResult,
        localCandidate: incoming,
      },
    });
    const bobUpdated = restartedBob.applyCandidate({
      active: bobActive,
      candidate: incoming,
    });
    expect(bobUpdated.status).toBe("applied");
    expect(
      bob.provider.applyCandidate({
        active: bobUpdated.active,
        candidate: incoming,
      }).status,
    ).toBe("duplicate");
    expect(bob.provider.abortCandidate(incoming).status).toBe(
      "already-applied",
    );

    aliceActive = alice.provider.applyCandidate({
      active: aliceActive,
      candidate: update.localCandidate,
    }).active;
    bobActive = bobUpdated.active;
    const nextUpdate = await alice.provider.prepareCommit({
      active: aliceActive,
    });
    const abandoned = await bob.provider.prepareIncoming({
      active: bobActive,
      publicResult: nextUpdate.publicResult,
    });
    expect(bob.provider.abortCandidate(abandoned).status).toBe("aborted");
    expect(
      restartedBob.applyCandidate({
        active: bobActive,
        candidate: abandoned,
      }).status,
    ).toBe("aborted");
    expect(restartedBob.abortCandidate(abandoned).status).toBe(
      "already-aborted",
    );
  }, 60_000);

  test("ts-mls Welcome preparation rejects each independently mismatched lifecycle and transition binding", async () => {
    const fixture = await tsMlsWelcomeFixture(
      "prepare-boundaries",
      9_551,
    );
    const other = await tsMlsWelcomeFixture(
      "prepare-boundaries-other",
      9_561,
    );

    expect(
      fixture.restartedBob.prepareWelcome({
        joinState: fixture.join.localState,
        publicResult: other.add.publicResult,
      }),
    ).rejects.toThrow("MLS Welcome does not match the local join request");

    expect(
      fixture.restartedBob.prepareWelcome({
        joinState: fixture.join.localState,
        publicResult: {
          ...fixture.add.publicResult,
          welcomeBytes: fixture.join.publicResult.keyPackageBytes,
          welcomeHash: new LatticeCrypto().hash(
            fixture.join.publicResult.keyPackageBytes,
          ),
        },
      }),
    ).rejects.toThrow("Expected an MLS Welcome");

    const wrongRoster = structuredClone(fixture.add.publicResult);
    flipByte(wrongRoster.rosterBytes, wrongRoster.rosterBytes.length - 1);
    expect(
      fixture.restartedBob.prepareWelcome({
        joinState: fixture.join.localState,
        publicResult: wrongRoster,
      }),
    ).rejects.toThrow(
      "MLS Welcome roster does not match public transition bytes",
    );

    const wrongNext = structuredClone(fixture.add.publicResult);
    flipByte(wrongNext.nextHead.stateHash, 0);
    expect(
      fixture.restartedBob.prepareWelcome({
        joinState: fixture.join.localState,
        publicResult: wrongNext,
      }),
    ).rejects.toThrow("MLS Welcome does not match the exact next public head");

    expect(
      fixture.bob.provider.abortWelcome({
        candidate: fixture.candidate,
        joinState: fixture.join.localState,
      }).status,
    ).toBe("aborted");
    expect(
      fixture.restartedBob.prepareWelcome({
        joinState: fixture.join.localState,
        publicResult: fixture.add.publicResult,
      }),
    ).rejects.toThrow("MLS Welcome does not match the local join request");
  }, 60_000);

  test("ts-mls Welcome activation enforces source, lifecycle, nested head, and restart synchronization", async () => {
    const sourceFixture = await tsMlsWelcomeFixture(
      "activate-source",
      9_601,
    );
    const wrongSource = resealTsMlsCandidate({
      crypto: sourceFixture.bob.crypto,
      vault: sourceFixture.bob.vault,
      prepared: {
        publicResult: sourceFixture.add.publicResult,
        localCandidate: sourceFixture.candidate,
      },
      sourceId: "join_foreign-welcome",
    });
    expect(() =>
      sourceFixture.restartedBob.activateWelcome({
        candidate: wrongSource,
        joinState: sourceFixture.join.localState,
      })
    ).toThrow("MLS Welcome candidate does not match its sealed join request");

    const abortedJoin = await tsMlsWelcomeFixture(
      "activate-aborted-join",
      9_611,
    );
    const preparedAfterJoinAbort = structuredClone(abortedJoin.candidate);
    abortedJoin.bob.provider.abortWelcome({
      candidate: abortedJoin.candidate,
      joinState: abortedJoin.join.localState,
    });
    expect(() =>
      abortedJoin.restartedBob.activateWelcome({
        candidate: preparedAfterJoinAbort,
        joinState: abortedJoin.join.localState,
      })
    ).toThrow("MLS Welcome join state was aborted");

    const abortedCandidate = await tsMlsWelcomeFixture(
      "activate-aborted-candidate",
      9_621,
    );
    markLocalProviderCandidateV2({
      vault: abortedCandidate.bob.vault,
      candidate: abortedCandidate.candidate,
      lifecycle: "aborted",
    });
    expect(() =>
      abortedCandidate.restartedBob.activateWelcome({
        candidate: abortedCandidate.candidate,
        joinState: abortedCandidate.join.localState,
      })
    ).toThrow("MLS Welcome candidate was aborted");

    const appliedCandidate = await tsMlsWelcomeFixture(
      "activate-applied-candidate",
      9_631,
    );
    markLocalProviderCandidateV2({
      vault: appliedCandidate.bob.vault,
      candidate: appliedCandidate.candidate,
      lifecycle: "applied",
    });
    expect(() =>
      appliedCandidate.restartedBob.activateWelcome({
        candidate: appliedCandidate.candidate,
        joinState: appliedCandidate.join.localState,
      })
    ).toThrow("MLS Welcome was already activated");

    const crossHead = await tsMlsWelcomeFixture(
      "activate-cross-head",
      9_641,
    );
    const forkAdd = await crossHead.alice.provider.prepareAdd({
      active: crossHead.aliceActive,
      joinRequest: crossHead.join.publicResult,
    });
    const forkCandidate = await crossHead.bob.provider.prepareWelcome({
      joinState: crossHead.join.localState,
      publicResult: forkAdd.publicResult,
    });
    const openedIntended = openLocalProviderCandidateV2({
      vault: crossHead.bob.vault,
      candidate: crossHead.candidate,
    });
    const wrongNestedHead = resealTsMlsCandidate({
      crypto: crossHead.bob.crypto,
      vault: crossHead.bob.vault,
      prepared: {
        publicResult: crossHead.add.publicResult,
        localCandidate: crossHead.candidate,
      },
      payloadCandidate: forkCandidate,
      sourceId: openedIntended.sourceId,
    });
    destroyOpenedProviderCandidateStateV2(openedIntended);
    expect(() =>
      crossHead.restartedBob.activateWelcome({
        candidate: wrongNestedHead,
        joinState: crossHead.join.localState,
      })
    ).toThrow("MLS Welcome candidate does not match its next public head");

    const synchronized = await tsMlsWelcomeFixture(
      "activate-synchronized",
      9_651,
    );
    const retryCandidate = structuredClone(synchronized.candidate);
    const activated = synchronized.restartedBob.activateWelcome({
      candidate: synchronized.candidate,
      joinState: synchronized.join.localState,
    });
    expect(activated.status).toBe("applied");
    expect(
      synchronized.restartedBob.publicHead(activated.active),
    ).toEqual(synchronized.add.publicResult.nextHead);
    expect(
      tsMlsCandidateLifecycle(
        synchronized.bob.vault,
        synchronized.candidate,
      ),
    ).toBe("applied");
    expect(
      synchronized.restartedBob.abortWelcome({
        candidate: retryCandidate,
        joinState: synchronized.join.localState,
      }).status,
    ).toBe("already-applied");
    expect(
      tsMlsCandidateLifecycle(
        synchronized.bob.vault,
        retryCandidate,
      ),
    ).toBe("applied");
  }, 60_000);

  test("ts-mls Welcome abort synchronizes every reachable join and candidate lifecycle pair", async () => {
    const bothPrepared = await tsMlsWelcomeFixture(
      "abort-both-prepared",
      9_701,
    );
    expect(
      bothPrepared.restartedBob.abortWelcome({
        candidate: bothPrepared.candidate,
        joinState: bothPrepared.join.localState,
      }).status,
    ).toBe("aborted");
    expect(
      tsMlsCandidateLifecycle(
        bothPrepared.bob.vault,
        bothPrepared.candidate,
      ),
    ).toBe("aborted");
    expect(
      bothPrepared.restartedBob.abortWelcome({
        candidate: bothPrepared.candidate,
        joinState: bothPrepared.join.localState,
      }).status,
    ).toBe("already-aborted");

    const candidateApplied = await tsMlsWelcomeFixture(
      "abort-candidate-applied",
      9_711,
    );
    const preparedPeer = structuredClone(candidateApplied.candidate);
    markLocalProviderCandidateV2({
      vault: candidateApplied.bob.vault,
      candidate: candidateApplied.candidate,
      lifecycle: "applied",
    });
    expect(
      candidateApplied.restartedBob.abortWelcome({
        candidate: candidateApplied.candidate,
        joinState: candidateApplied.join.localState,
      }).status,
    ).toBe("already-applied");
    expect(
      candidateApplied.restartedBob.abortWelcome({
        candidate: preparedPeer,
        joinState: candidateApplied.join.localState,
      }).status,
    ).toBe("already-applied");
    expect(
      tsMlsCandidateLifecycle(candidateApplied.bob.vault, preparedPeer),
    ).toBe("applied");

    const joinApplied = await tsMlsWelcomeFixture(
      "abort-join-applied",
      9_721,
    );
    const preparedAfterApply = structuredClone(joinApplied.candidate);
    joinApplied.bob.provider.activateWelcome({
      candidate: joinApplied.candidate,
      joinState: joinApplied.join.localState,
    });
    expect(
      joinApplied.restartedBob.abortWelcome({
        candidate: preparedAfterApply,
        joinState: joinApplied.join.localState,
      }).status,
    ).toBe("already-applied");
    expect(
      tsMlsCandidateLifecycle(
        joinApplied.bob.vault,
        preparedAfterApply,
      ),
    ).toBe("applied");

    const joinAborted = await tsMlsWelcomeFixture(
      "abort-join-aborted",
      9_731,
    );
    const preparedAfterAbort = structuredClone(joinAborted.candidate);
    joinAborted.bob.provider.abortWelcome({
      candidate: joinAborted.candidate,
      joinState: joinAborted.join.localState,
    });
    expect(
      joinAborted.restartedBob.abortWelcome({
        candidate: preparedAfterAbort,
        joinState: joinAborted.join.localState,
      }).status,
    ).toBe("already-aborted");
    expect(
      tsMlsCandidateLifecycle(
        joinAborted.bob.vault,
        preparedAfterAbort,
      ),
    ).toBe("aborted");

    for (const lifecycle of ["aborted", "stale"] as const) {
      const candidateTerminal = await tsMlsWelcomeFixture(
        `abort-candidate-${lifecycle}`,
        lifecycle === "aborted" ? 9_741 : 9_751,
      );
      const preparedPeerCandidate = structuredClone(
        candidateTerminal.candidate,
      );
      markLocalProviderCandidateV2({
        vault: candidateTerminal.bob.vault,
        candidate: candidateTerminal.candidate,
        lifecycle,
      });
      expect(
        candidateTerminal.restartedBob.abortWelcome({
          candidate: candidateTerminal.candidate,
          joinState: candidateTerminal.join.localState,
        }).status,
      ).toBe("already-aborted");
      expect(
        tsMlsCandidateLifecycle(
          candidateTerminal.bob.vault,
          candidateTerminal.candidate,
        ),
      ).toBe(lifecycle);
      expect(
        candidateTerminal.restartedBob.abortWelcome({
          candidate: preparedPeerCandidate,
          joinState: candidateTerminal.join.localState,
        }).status,
      ).toBe("already-aborted");
      expect(
        tsMlsCandidateLifecycle(
          candidateTerminal.bob.vault,
          preparedPeerCandidate,
        ),
      ).toBe("aborted");
    }
  }, 60_000);

  test("ts-mls retained Welcome activation does not rewrite an already-applied join tombstone", async () => {
    const fixture = await tsMlsWelcomeFixture(
      "retained-activation",
      9_801,
    );
    const retainedPreparedCandidate = structuredClone(fixture.candidate);
    fixture.bob.provider.activateWelcome({
      candidate: fixture.candidate,
      joinState: fixture.join.localState,
    });
    const appliedJoinCiphertext = fixture.join.localState.ciphertext.slice();

    const retried = fixture.restartedBob.activateWelcome({
      candidate: retainedPreparedCandidate,
      joinState: fixture.join.localState,
    });

    expect(retried.status).toBe("applied");
    expect(fixture.join.localState.ciphertext).toEqual(
      appliedJoinCiphertext,
    );
    expect(
      tsMlsCandidateLifecycle(
        fixture.bob.vault,
        retainedPreparedCandidate,
      ),
    ).toBe("applied");
  }, 60_000);

  test("ts-mls applied retained candidate cannot rewrite an aborted join tombstone", async () => {
    const fixture = await tsMlsWelcomeFixture(
      "retained-applied-candidate",
      9_811,
    );
    const retainedAppliedCandidate = structuredClone(fixture.candidate);
    const retainedPreparedProbe = structuredClone(fixture.candidate);
    fixture.bob.provider.abortWelcome({
      candidate: fixture.candidate,
      joinState: fixture.join.localState,
    });
    markLocalProviderCandidateV2({
      vault: fixture.bob.vault,
      candidate: retainedAppliedCandidate,
      lifecycle: "applied",
    });
    const abortedJoinCiphertext = fixture.join.localState.ciphertext.slice();

    expect(
      fixture.restartedBob.abortWelcome({
        candidate: retainedAppliedCandidate,
        joinState: fixture.join.localState,
      }).status,
    ).toBe("already-applied");
    expect(fixture.join.localState.ciphertext).toEqual(
      abortedJoinCiphertext,
    );
    expect(
      fixture.restartedBob.abortWelcome({
        candidate: retainedPreparedProbe,
        joinState: fixture.join.localState,
      }).status,
    ).toBe("already-aborted");
    expect(
      tsMlsCandidateLifecycle(
        fixture.bob.vault,
        retainedPreparedProbe,
      ),
    ).toBe("aborted");
  }, 60_000);

  test("ts-mls aborted retained candidate cannot rewrite an aborted join tombstone", async () => {
    const fixture = await tsMlsWelcomeFixture(
      "retained-aborted-candidate",
      9_821,
    );
    const retainedAbortedCandidate = structuredClone(fixture.candidate);
    const retainedPreparedProbe = structuredClone(fixture.candidate);
    fixture.bob.provider.abortWelcome({
      candidate: fixture.candidate,
      joinState: fixture.join.localState,
    });
    markLocalProviderCandidateV2({
      vault: fixture.bob.vault,
      candidate: retainedAbortedCandidate,
      lifecycle: "aborted",
    });
    const abortedJoinCiphertext = fixture.join.localState.ciphertext.slice();

    expect(
      fixture.restartedBob.abortWelcome({
        candidate: retainedAbortedCandidate,
        joinState: fixture.join.localState,
      }).status,
    ).toBe("already-aborted");
    expect(fixture.join.localState.ciphertext).toEqual(
      abortedJoinCiphertext,
    );
    expect(
      fixture.restartedBob.abortWelcome({
        candidate: retainedPreparedProbe,
        joinState: fixture.join.localState,
      }).status,
    ).toBe("already-aborted");
    expect(
      tsMlsCandidateLifecycle(
        fixture.bob.vault,
        retainedPreparedProbe,
      ),
    ).toBe("aborted");
  }, 60_000);

  test("ts-mls duplicate apply does not rewrite an applied candidate tombstone", async () => {
    const fixture = await tsMlsLifecycleFixture(
      "retained-duplicate-apply",
      9_831,
    );
    const prepared = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    const applied = fixture.provider.applyCandidate({
      active: fixture.active,
      candidate: prepared.localCandidate,
    });
    const appliedCandidateCiphertext =
      prepared.localCandidate.snapshot.ciphertext.slice();

    expect(
      fixture.restart.applyCandidate({
        active: applied.active,
        candidate: prepared.localCandidate,
      }).status,
    ).toBe("duplicate");
    expect(prepared.localCandidate.snapshot.ciphertext).toEqual(
      appliedCandidateCiphertext,
    );
    expect(
      tsMlsCandidateLifecycle(
        fixture.vault,
        prepared.localCandidate,
      ),
    ).toBe("applied");
  }, 60_000);

  test("rejects every mismatched public/local coordinate before provider or storage work", async () => {
    const fixture = await dummyFixture("coordinates");
    const prepared = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    const variants: ((value: PreparedProviderCommitV2) => void)[] = [
      (value) => {
        (value.publicResult as unknown as { formatVersion: number })
          .formatVersion = 1;
      },
      (value) => {
        (value.publicResult as unknown as { providerId: string })
          .providerId = "provider-other";
      },
      (value) => {
        (value.publicResult as unknown as { domainId: string })
          .domainId = "domain-other";
      },
      (value) => {
        (value.localCandidate as unknown as { providerId: string })
          .providerId = "provider-other";
      },
      (value) => {
        const stateHash = value.localCandidate.expectedHead.stateHash;
        stateHash[0] = stateHash[0]! ^ 1;
      },
      (value) => {
        const stateHash = value.localCandidate.nextHead.stateHash;
        stateHash[0] = stateHash[0]! ^ 1;
      },
    ];
    for (const mutate of variants) {
      const value = structuredClone(prepared);
      mutate(value);
      let applyCalls = 0;
      let storageCalls = 0;
      const provider = providerWrapper(fixture.provider, {
        applyCandidate: () => {
          applyCalls += 1;
          throw new Error("provider must not run");
        },
      });
      expect(
        coordinateProviderTransitionV2({
          storage: {
            compareAndSwapDomainProviderHead: () => {
              storageCalls += 1;
              return Promise.resolve("applied");
            },
          },
          provider,
          active: fixture.active,
          prepared: value,
        }),
      ).rejects.toThrow(
        "Prepared provider transition public and device-local coordinates differ",
      );
      expect({ applyCalls, storageCalls }).toEqual({
        applyCalls: 0,
        storageCalls: 0,
      });
    }
  });

  test("owns transition and candidate authorization coordinates across awaited validation", async () => {
    const { fixture, prepared } = await tsMlsAddFixture();
    const callerPrepared = structuredClone(prepared);
    const store = await initializedStore(fixture);
    const expectedCommit = callerPrepared.publicResult.commitBytes.slice();
    const expectedWelcome = callerPrepared.publicResult.welcomeBytes.slice();
    const expectedRoster = callerPrepared.publicResult.rosterBytes.slice();
    const expectedCandidateId = callerPrepared.localCandidate.candidateId;
    const expectedActorDeviceId = callerPrepared.localCandidate.deviceId;
    const expectedTransitionDigest =
      callerPrepared.localCandidate.publicTransitionDigest.slice();
    expect(expectedWelcome.length).toBeGreaterThan(0);
    expect(expectedRoster.length).toBeGreaterThan(0);
    const provider = providerWrapper(fixture.provider, {
      validatePreparedCandidate: async (input) => {
        callerPrepared.publicResult.commitBytes.fill(0xa1);
        callerPrepared.publicResult.welcomeBytes.fill(0xa2);
        callerPrepared.publicResult.rosterBytes.fill(0xa3);
        (callerPrepared.localCandidate as unknown as { candidateId: string })
          .candidateId = "candidate_substituted";
        (callerPrepared.localCandidate as unknown as { deviceId: string })
          .deviceId = "device-substituted";
        callerPrepared.localCandidate.publicTransitionDigest.fill(0xa4);
        await Promise.resolve();
        expect(input.prepared.publicResult.commitBytes).toEqual(
          expectedCommit,
        );
        expect(input.prepared.publicResult.welcomeBytes).toEqual(
          expectedWelcome,
        );
        expect(input.prepared.publicResult.rosterBytes).toEqual(
          expectedRoster,
        );
        await fixture.provider.validatePreparedCandidate(input);
        input.active.ciphertext.fill(0xb1);
        input.prepared.publicResult.commitBytes.fill(0xb2);
        input.prepared.publicResult.welcomeBytes.fill(0xb3);
        input.prepared.publicResult.rosterBytes.fill(0xb4);
        input.prepared.localCandidate.publicTransitionDigest.fill(0xb5);
      },
    });
    const result = await coordinateProviderTransitionWithAuthorizationV2({
      storage: store,
      provider,
      active: fixture.active,
      prepared: callerPrepared,
      authorization: {
        authorizationRevision: authorizationRevision(0),
        resolveCurrentAuthorization: (context) => {
          expect(context.candidateId).toBe(expectedCandidateId);
          expect(context.actorDeviceId).toBe(expectedActorDeviceId);
          expect(context.publicTransitionDigest).toEqual(
            expectedTransitionDigest,
          );
          return allowDecision(context);
        },
      },
    });
    expect(result.status).toBe("applied");
    expect(store.snapshot().domains[0]!.rosterBytes).toEqual(expectedRoster);
  });

  test("a detached caller lifecycle target cannot turn an applied CAS into a post-commit failure", async () => {
    const fixture = await dummyFixture("post-cas-detached-lifecycle");
    const prepared = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    const store = await initializedStore(fixture);
    const target = prepared.localCandidate.snapshot.ciphertext;

    const result = await coordinateProviderTransitionV2({
      storage: {
        compareAndSwapDomainProviderHead: async (authorized) => {
          const status = await store.compareAndSwapDomainProviderHead(
            authorized,
          );
          if (!(target.buffer instanceof ArrayBuffer)) {
            throw new Error("expected transferable candidate storage");
          }
          structuredClone(target, {
            transfer: [target.buffer],
          });
          return status;
        },
      },
      provider: fixture.provider,
      active: fixture.active,
      prepared,
    });

    expect(result.status).toBe("applied");
    expect(fixture.provider.publicHead(result.active)).toEqual(
      prepared.publicResult.nextHead,
    );
    expect(await store.getDomainProviderHead(
      prepared.publicResult.domainId,
    )).toEqual(prepared.publicResult.nextHead);
  });

  test("owns a Buffer-backed active state returned by the provider", async () => {
    const fixture = await dummyFixture("buffer-backed-applied-state");
    const prepared = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    let applyCalls = 0;
    const providerByteResults: Buffer[] = [];
    const provider = providerWrapper(fixture.provider, {
      applyCandidate: (input) => {
        applyCalls += 1;
        const result = fixture.provider.applyCandidate(input);
        if (applyCalls === 1) return result;
        const providerBytes = Buffer.from(result.active.ciphertext);
        providerByteResults.push(providerBytes);
        return {
          ...result,
          active: {
            ...result.active,
            ciphertext: providerBytes,
          } as SealedProviderStateV2,
        };
      },
    });

    const result = await coordinateProviderTransitionV2({
      storage: await initializedStore(fixture),
      provider,
      active: {
        ...fixture.active,
        ciphertext: Buffer.from(fixture.active.ciphertext),
      } as SealedProviderStateV2,
      prepared,
    });
    const providerBytes = providerByteResults[0];
    if (providerBytes === undefined) throw new Error("missing provider bytes");
    const expected = Uint8Array.from(result.active.ciphertext);
    providerBytes.fill(0xff);

    expect(result.status).toBe("applied");
    expect(Buffer.isBuffer(result.active.ciphertext)).toBeFalse();
    expect(result.active.ciphertext).toEqual(expected);
  });

  test("preflight stale aborts the detached candidate and copies only a valid lifecycle tombstone", async () => {
    const fixture = await dummyFixture("preflight-stale");
    const prepared = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    const originalCandidateId = prepared.localCandidate.candidateId;
    let abortCalls = 0;
    let storageCalls = 0;
    const provider = providerWrapper(fixture.provider, {
      applyCandidate: ({ active }) => ({
        status: "stale",
        active,
      }),
      abortCandidate: (candidate) => {
        abortCalls += 1;
        return fixture.provider.abortCandidate(candidate);
      },
    });
    const result = await coordinateProviderTransitionV2({
      storage: {
        compareAndSwapDomainProviderHead: () => {
          storageCalls += 1;
          return Promise.resolve("applied");
        },
      },
      provider,
      active: fixture.active,
      prepared,
    });
    expect(result.status).toBe("stale");
    expect(result.active).toEqual(fixture.active);
    expect({ abortCalls, storageCalls }).toEqual({
      abortCalls: 1,
      storageCalls: 0,
    });
    expect(prepared.localCandidate.candidateId).toBe(originalCandidateId);
    expect(
      fixture.provider.applyCandidate({
        active: fixture.active,
        candidate: prepared.localCandidate,
      }).status,
    ).toBe("aborted");
  });

  test("rejects a preflight result whose active head is not the intended next head", async () => {
    const fixture = await dummyFixture("preflight-head");
    const prepared = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    let publicHeadCalls = 0;
    let validationCalls = 0;
    let storageCalls = 0;
    const provider = providerWrapper(fixture.provider, {
      publicHead: (active) => {
        publicHeadCalls += 1;
        const head = fixture.provider.publicHead(active);
        return publicHeadCalls === 1
          ? {
            ...head,
            stateHash: new Uint8Array(32).fill(0xee),
          }
          : head;
      },
      validatePreparedCandidate: async () => {
        validationCalls += 1;
      },
    });
    expect(
      coordinateProviderTransitionV2({
        storage: {
          compareAndSwapDomainProviderHead: () => {
            storageCalls += 1;
            return Promise.resolve("applied");
          },
        },
        provider,
        active: fixture.active,
        prepared,
      }),
    ).rejects.toThrow(
      "Provider candidate preflight did not produce the intended public head",
    );
    expect({ validationCalls, storageCalls }).toEqual({
      validationCalls: 0,
      storageCalls: 0,
    });
  });

  test("rejects invalid post-CAS apply status and wrong active head", async () => {
    for (const failure of ["status", "head"] as const) {
      const fixture = await dummyFixture(`post-cas-${failure}`);
      const prepared = await fixture.provider.prepareCommit({
        active: fixture.active,
      });
      let applyCalls = 0;
      const provider = providerWrapper(fixture.provider, {
        applyCandidate: (input): ProviderApplyResultV2 => {
          applyCalls += 1;
          const result = fixture.provider.applyCandidate(input);
          if (applyCalls === 1) return result;
          if (failure === "status") {
            return {
              status: "stale",
              active: result.active,
            };
          }
          return {
            status: result.status,
            active: fixture.active,
          };
        },
      });
      expect(
        coordinateProviderTransitionV2({
          storage: {
            compareAndSwapDomainProviderHead: () =>
              Promise.resolve("applied"),
          },
          provider,
          active: fixture.active,
          prepared,
        }),
      ).rejects.toThrow(
        "Provider candidate changed after successful public-head CAS",
      );
      expect(applyCalls).toBe(2);
    }
  });

  test("rejects every invalid storage CAS status before local apply without retry or lifecycle mutation", async () => {
    for (
      const [index, invalidStatus] of [
        undefined,
        null,
        "aborted",
        "applied ",
        { status: "applied" },
      ].entries()
    ) {
      const fixture = await dummyFixture(`invalid-cas-status-${index}`);
      const prepared = await fixture.provider.prepareCommit({
        active: fixture.active,
      });
      const initialHead = fixture.provider.publicHead(fixture.active);
      const initialCandidateCiphertext =
        prepared.localCandidate.snapshot.ciphertext.slice();
      let applyCalls = 0;
      let casCalls = 0;
      const provider = providerWrapper(fixture.provider, {
        applyCandidate: (input) => {
          applyCalls += 1;
          return fixture.provider.applyCandidate(input);
        },
      });

      const error = await coordinateProviderTransitionV2({
        storage: {
          compareAndSwapDomainProviderHead: () => {
            casCalls += 1;
            return Promise.resolve(invalidStatus as never);
          },
        },
        provider,
        active: fixture.active,
        prepared,
      }).catch((caught: unknown) => caught);

      expect(error).toEqual(
        new TypeError(
          "Provider transition storage returned an invalid CAS status",
        ),
      );
      expect({ applyCalls, casCalls }).toEqual({
        applyCalls: 1,
        casCalls: 1,
      });
      expect(fixture.provider.publicHead(fixture.active)).toEqual(initialHead);
      expect(prepared.localCandidate.snapshot.ciphertext).toEqual(
        initialCandidateCiphertext,
      );
    }
  });

  test("rechecks revision-bound add authorization after prepare and binds the exact candidate", async () => {
    const { fixture, prepared } = await tsMlsAddFixture();
    const store = await initializedStore(
      fixture,
      authorizationRevision(7),
    );
    let observed: ProviderTransitionAuthorizationContextV2 | null = null;

    const result = await coordinateProviderTransitionWithAuthorizationV2({
      storage: store,
      provider: fixture.provider,
      active: fixture.active,
      prepared,
      authorization: {
        authorizationRevision: authorizationRevision(7),
        resolveCurrentAuthorization: (context) => {
          observed = context;
          return allowDecision(context);
        },
      },
    });

    expect(result.status).toBe("applied");
    expect(observed).toMatchObject({
      providerId: prepared.publicResult.providerId,
      domainId: prepared.publicResult.domainId,
      authorizationRevision: 7,
      actorDeviceId: prepared.localCandidate.deviceId,
      operation: "add",
      targetHumanId: "bob",
      targetDeviceId: "bob-provider-device",
      candidateId: prepared.localCandidate.candidateId,
    });
    const seen = observed as unknown as ProviderTransitionAuthorizationContextV2;
    expect(seen.currentHead).toEqual(prepared.publicResult.expectedHead);
    expect(seen.nextHead).toEqual(prepared.publicResult.nextHead);
    expect(seen.publicTransitionDigest).toEqual(
      prepared.localCandidate.publicTransitionDigest,
    );
  });

  test("revocation or suspension after prepare rejects before provider-head CAS", async () => {
    for (const actorStatus of ["revoked", "suspended"] as const) {
      const { fixture, prepared } = await tsMlsAddFixture();
      const store = await initializedStore(fixture);
      let storageCalls = 0;
      const resolver = (
        context: ProviderTransitionAuthorizationContextV2,
      ): ProviderTransitionAuthorizationDecisionV2 | null =>
        actorStatus === "revoked"
          ? null
          : {
            ...allowDecision(context),
            authorized: false,
            actorStatus,
          };

      expect(
        coordinateProviderTransitionWithAuthorizationV2({
          storage: {
            compareAndSwapDomainProviderHead: () => {
              storageCalls += 1;
              return Promise.resolve("applied");
            },
          },
          provider: fixture.provider,
          active: fixture.active,
          prepared,
          authorization: {
            authorizationRevision: authorizationRevision(7),
            resolveCurrentAuthorization: resolver,
          },
        }),
      ).rejects.toThrow(
        actorStatus === "revoked"
          ? "authorization decision must be an object"
          : "fresh exact host authorization",
      );
      expect(storageCalls).toBe(0);

      const direct = store.compareAndSwapDomainProviderHead as unknown as (
        write: unknown,
      ) => Promise<unknown>;
      const directError = await direct.call(store, {
        expected: prepared.publicResult.expectedHead,
        next: prepared.publicResult.nextHead,
        nextRosterBytes: prepared.publicResult.rosterBytes,
      }).catch((error: unknown) => error);
      expect(directError).toEqual(
        new TypeError(
          "Domain provider CAS requires an authorized provider-head write capability",
        ),
      );
      expect(await store.getDomainProviderHead(
        prepared.publicResult.domainId,
      )).toEqual(prepared.publicResult.expectedHead);
    }
  });

  test("rejects stale, operation-substituted, and target-substituted decisions before CAS", async () => {
    const variants = [
      (
        context: ProviderTransitionAuthorizationContextV2,
      ): ProviderTransitionAuthorizationDecisionV2 => ({
        ...allowDecision(context),
        authorizationRevision: authorizationRevision(8),
      }),
      (
        context: ProviderTransitionAuthorizationContextV2,
      ): ProviderTransitionAuthorizationDecisionV2 => ({
        ...allowDecision(context),
        operation: "remove",
      }),
      (
        context: ProviderTransitionAuthorizationContextV2,
      ): ProviderTransitionAuthorizationDecisionV2 => ({
        ...allowDecision(context),
        targetDeviceId: cryptoDeviceId("substituted-device"),
      }),
      (
        context: ProviderTransitionAuthorizationContextV2,
      ): ProviderTransitionAuthorizationDecisionV2 => ({
        ...allowDecision(context),
        targetHumanId: humanId("mallory"),
      }),
    ];

    for (const resolve of variants) {
      const { fixture, prepared } = await tsMlsAddFixture();
      let storageCalls = 0;
      expect(
        coordinateProviderTransitionWithAuthorizationV2({
          storage: {
            compareAndSwapDomainProviderHead: () => {
              storageCalls += 1;
              return Promise.resolve("applied");
            },
          },
          provider: fixture.provider,
          active: fixture.active,
          prepared,
          authorization: {
            authorizationRevision: authorizationRevision(7),
            resolveCurrentAuthorization: resolve,
          },
        }),
      ).rejects.toThrow("fresh exact host authorization");
      expect(storageCalls).toBe(0);
    }
  });

  test("binds every fresh authorization decision coordinate independently", async () => {
    const variants: readonly ((
      context: ProviderTransitionAuthorizationContextV2,
    ) => ProviderTransitionAuthorizationDecisionV2)[] = [
      (context) => ({ ...allowDecision(context), providerId: "provider-other" }),
      (context) => ({
        ...allowDecision(context),
        domainId: cryptoDomainId("domain-other"),
      }),
      (context) => ({
        ...allowDecision(context),
        authorizationRevision: authorizationRevision(
          Number(context.authorizationRevision) + 1,
        ),
      }),
      (context) => ({
        ...allowDecision(context),
        actorDeviceId: cryptoDeviceId("device-other"),
      }),
      (context) => ({
        ...allowDecision(context),
        operation: context.operation === "update" ? "remove" : "update",
      }),
      (context) => ({
        ...allowDecision(context),
        targetHumanId: humanId("mallory"),
      }),
      (context) => ({
        ...allowDecision(context),
        targetDeviceId: cryptoDeviceId("device-other"),
      }),
      (context) => ({
        ...allowDecision(context),
        currentHead: {
          ...context.currentHead,
          providerId: "provider-other",
        },
      }),
      (context) => ({
        ...allowDecision(context),
        currentHead: {
          ...context.currentHead,
          domainId: cryptoDomainId("domain-other"),
        },
      }),
      (context) => ({
        ...allowDecision(context),
        currentHead: {
          ...context.currentHead,
          epoch: domainEpoch(Number(context.currentHead.epoch) + 1),
        },
      }),
      (context) => ({
        ...allowDecision(context),
        currentHead: {
          ...context.currentHead,
          stateHash: new Uint8Array(32).fill(0xe1),
        },
      }),
      (context) => ({
        ...allowDecision(context),
        nextHead: {
          ...context.nextHead,
          providerId: "provider-other",
        },
      }),
      (context) => ({
        ...allowDecision(context),
        nextHead: {
          ...context.nextHead,
          domainId: cryptoDomainId("domain-other"),
        },
      }),
      (context) => ({
        ...allowDecision(context),
        nextHead: {
          ...context.nextHead,
          epoch: domainEpoch(Number(context.nextHead.epoch) + 1),
        },
      }),
      (context) => ({
        ...allowDecision(context),
        nextHead: {
          ...context.nextHead,
          stateHash: new Uint8Array(32).fill(0xe2),
        },
      }),
      (context) => ({
        ...allowDecision(context),
        candidateId: "candidate-other",
      }),
      (context) => ({
        ...allowDecision(context),
        publicTransitionDigest: (() => {
          const digest = context.publicTransitionDigest.slice();
          digest[0] = digest[0]! ^ 1;
          return digest;
        })(),
      }),
    ];
    for (const [index, resolveCurrentAuthorization] of variants.entries()) {
      const fixture = await dummyFixture(`decision-coordinate-${index}`);
      const prepared = await fixture.provider.prepareCommit({
        active: fixture.active,
      });
      let storageCalls = 0;
      expect(
        coordinateProviderTransitionWithAuthorizationV2({
          storage: {
            compareAndSwapDomainProviderHead: () => {
              storageCalls += 1;
              return Promise.resolve("applied");
            },
          },
          provider: fixture.provider,
          active: fixture.active,
          prepared,
          authorization: {
            authorizationRevision: authorizationRevision(7),
            resolveCurrentAuthorization,
          },
        }),
      ).rejects.toThrow(
        "Provider transition persistence requires fresh exact host authorization",
      );
      expect(storageCalls).toBe(0);
    }
  });

  test("resolver-owned digest and head bytes cannot mutate the pristine authorization comparison", async () => {
    {
      const fixture = await dummyFixture("resolver-digest-detachment");
      const prepared = await fixture.provider.prepareCommit({
        active: fixture.active,
      });
      const result = await coordinateProviderTransitionWithAuthorizationV2({
        storage: {
          compareAndSwapDomainProviderHead: () =>
            Promise.resolve("applied"),
        },
        provider: fixture.provider,
        active: fixture.active,
        prepared,
        authorization: {
          authorizationRevision: authorizationRevision(7),
          resolveCurrentAuthorization: (context) => {
            const decision = allowDecision(context);
            const digest = decision.publicTransitionDigest.slice();
            context.publicTransitionDigest[0] =
              context.publicTransitionDigest[0]! ^ 1;
            return { ...decision, publicTransitionDigest: digest };
          },
        },
      });
      expect(result.status).toBe("applied");
    }

    {
      const fixture = await dummyFixture("resolver-head-detachment");
      const prepared = await fixture.provider.prepareCommit({
        active: fixture.active,
      });
      const result = await coordinateProviderTransitionWithAuthorizationV2({
        storage: {
          compareAndSwapDomainProviderHead: () =>
            Promise.resolve("applied"),
        },
        provider: fixture.provider,
        active: fixture.active,
        prepared,
        authorization: {
          authorizationRevision: authorizationRevision(7),
          resolveCurrentAuthorization: (context) => {
            const decision = {
              ...allowDecision(context),
              currentHead: {
                ...context.currentHead,
                stateHash: context.currentHead.stateHash.slice(),
              },
            };
            let reads = 0;
            Object.defineProperty(decision, "authorized", {
              enumerable: true,
              get() {
                reads += 1;
                if (reads === 2) {
                  decision.currentHead.stateHash[0] =
                    decision.currentHead.stateHash[0]! ^ 1;
                }
                return true;
              },
            });
            return decision;
          },
        },
      });
      expect(result.status).toBe("applied");
    }
  });

  test("requires both an affirmative authorization gate and active actor status independently", async () => {
    const gates = [
      { authorized: false, actorStatus: "active" },
      { authorized: true, actorStatus: "pending" },
      { authorized: true, actorStatus: "suspended" },
      { authorized: true, actorStatus: "revoked" },
    ] as const;
    for (const [index, gate] of gates.entries()) {
      const fixture = await dummyFixture(`decision-gate-${index}`);
      const prepared = await fixture.provider.prepareCommit({
        active: fixture.active,
      });
      let storageCalls = 0;
      expect(
        coordinateProviderTransitionWithAuthorizationV2({
          storage: {
            compareAndSwapDomainProviderHead: () => {
              storageCalls += 1;
              return Promise.resolve("applied");
            },
          },
          provider: fixture.provider,
          active: fixture.active,
          prepared,
          authorization: {
            authorizationRevision: authorizationRevision(7),
            resolveCurrentAuthorization: (context) => ({
              ...allowDecision(context),
              ...gate,
            }),
          },
        }),
      ).rejects.toThrow(
        "Provider transition persistence requires fresh exact host authorization",
      );
      expect(storageCalls).toBe(0);
    }
  });

  test("resolver failure is propagated before CAS and is never retried", async () => {
    const { fixture, prepared } = await tsMlsAddFixture();
    const cause = new Error("product authorization unavailable");
    let resolverCalls = 0;
    let storageCalls = 0;

    const error = await coordinateProviderTransitionWithAuthorizationV2({
      storage: {
        compareAndSwapDomainProviderHead: () => {
          storageCalls += 1;
          return Promise.resolve("applied");
        },
      },
      provider: fixture.provider,
      active: fixture.active,
      prepared,
      authorization: {
        authorizationRevision: authorizationRevision(7),
        resolveCurrentAuthorization: () => {
          resolverCalls += 1;
          throw cause;
        },
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBe(cause);
    expect({ resolverCalls, storageCalls }).toEqual({
      resolverCalls: 1,
      storageCalls: 0,
    });
  });

  test("orders candidate authenticity, fresh authorization, and the single CAS exactly", async () => {
    const fixture = await dummyFixture("authorization-order");
    const prepared = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    const store = await initializedStore(
      fixture,
      authorizationRevision(9),
    );
    const events: string[] = [];
    const provider = providerWrapper(fixture.provider, {
      validatePreparedCandidate: async (input) => {
        events.push("candidate-authentic");
        return fixture.provider.validatePreparedCandidate(input);
      },
    });

    expect(
      await coordinateProviderTransitionWithAuthorizationV2({
        storage: {
          compareAndSwapDomainProviderHead: (...args) => {
            events.push("cas");
            return store.compareAndSwapDomainProviderHead(...args);
          },
        },
        provider,
        active: fixture.active,
        prepared,
        authorization: {
          authorizationRevision: authorizationRevision(9),
          resolveCurrentAuthorization: (context) => {
            events.push("fresh-authorization");
            return allowDecision(context);
          },
        },
      }),
    ).toMatchObject({ status: "applied" });
    expect(events).toEqual([
      "candidate-authentic",
      "fresh-authorization",
      "cas",
    ]);
  });

  test("rejects every malformed authorization field, head, digest, and decision gate with exact diagnostics", async () => {
    const malformedDecisions: readonly [
      (
        context: ProviderTransitionAuthorizationContextV2,
      ) => unknown,
      string,
    ][] = [
      [
        () => null,
        "Current provider transition authorization decision must be an object",
      ],
      [
        () => "decision",
        "Current provider transition authorization decision must be an object",
      ],
      [
        (context) => ({ ...allowDecision(context), unexpected: true }),
        "Current provider transition authorization decision has an invalid field set",
      ],
      [
        (context) => {
          const { actorStatus: _actorStatus, ...missing } =
            allowDecision(context);
          return missing;
        },
        "Current provider transition authorization decision has an invalid field set",
      ],
      [
        (context) => {
          const { actorStatus: _actorStatus, ...missing } =
            allowDecision(context);
          return { ...missing, unexpected: true };
        },
        "Current provider transition authorization decision has an invalid field set",
      ],
      [
        (context) => ({
          ...allowDecision(context),
          publicTransitionDigest: "digest",
        }),
        "Provider public transition digest must be exactly 32 bytes",
      ],
      [
        (context) => ({
          ...allowDecision(context),
          publicTransitionDigest: new Uint8Array(31),
        }),
        "Provider public transition digest must be exactly 32 bytes",
      ],
      [
        (context) => ({
          ...allowDecision(context),
          currentHead: null,
        }),
        "Current provider head must be an object",
      ],
      [
        (context) => ({
          ...allowDecision(context),
          currentHead: { ...context.currentHead, unexpected: true },
        }),
        "Current provider head has an invalid field set",
      ],
      [
        (context) => ({
          ...allowDecision(context),
          currentHead: {
            ...context.currentHead,
            stateHash: new Uint8Array(31),
          },
        }),
        "Current provider head state hash must be exactly 32 bytes",
      ],
      [
        (context) => ({
          ...allowDecision(context),
          nextHead: null,
        }),
        "Next provider head must be an object",
      ],
      [
        (context) => ({
          ...allowDecision(context),
          nextHead: { ...context.nextHead, unexpected: true },
        }),
        "Next provider head has an invalid field set",
      ],
      [
        (context) => ({
          ...allowDecision(context),
          nextHead: {
            ...context.nextHead,
            stateHash: new Uint8Array(31),
          },
        }),
        "Next provider head state hash must be exactly 32 bytes",
      ],
      [
        (context) => ({ ...allowDecision(context), authorized: "yes" }),
        "Current provider transition authorization decision is invalid",
      ],
      [
        (context) => ({ ...allowDecision(context), actorStatus: "unknown" }),
        "Current provider transition authorization decision is invalid",
      ],
    ];
    for (const [index, [resolve, message]] of malformedDecisions.entries()) {
      const fixture = await dummyFixture(`malformed-decision-exact-${index}`);
      const prepared = await fixture.provider.prepareCommit({
        active: fixture.active,
      });
      await expectExactRejection(
        coordinateProviderTransitionWithAuthorizationV2({
          storage: {
            compareAndSwapDomainProviderHead: () =>
              Promise.resolve("applied"),
          },
          provider: fixture.provider,
          active: fixture.active,
          prepared,
          authorization: {
            authorizationRevision: authorizationRevision(7),
            resolveCurrentAuthorization: resolve as never,
          },
        }),
        message,
      );
    }

    const fixture = await dummyFixture("malformed-authorization-exact");
    const prepared = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    for (const [authorization, message] of [
      [
        null,
        "Provider transition persistence authorization must be an object",
      ],
      [
        {
          authorizationRevision: authorizationRevision(7),
          resolveCurrentAuthorization: allowDecision,
          unexpected: true,
        },
        "Provider transition persistence authorization has an invalid field set",
      ],
      [
        { authorizationRevision: authorizationRevision(7) },
        "Provider transition persistence authorization has an invalid field set",
      ],
      [
        {
          authorizationRevision: authorizationRevision(7),
          unexpected: true,
        },
        "Provider transition persistence authorization has an invalid field set",
      ],
      [
        {
          authorizationRevision: authorizationRevision(7),
          resolveCurrentAuthorization: "resolver",
        },
        "Current provider transition authorization resolver is required",
      ],
    ] as const) {
      await expectExactRejection(
        coordinateProviderTransitionWithAuthorizationV2({
          storage: {
            compareAndSwapDomainProviderHead: () =>
              Promise.resolve("applied"),
          },
          provider: fixture.provider,
          active: fixture.active,
          prepared,
          authorization: authorization as never,
        }),
        message,
      );
    }
  });

  test("validates prepared provider id, candidate id, and operation at the authorization boundary exactly", async () => {
    for (const [index, variant] of [
      {
        mutate(prepared: PreparedProviderCommitV2) {
          (prepared.publicResult as unknown as { providerId: string })
            .providerId = "";
          (prepared.localCandidate as unknown as { providerId: string })
            .providerId = "";
        },
        providerId: "",
        message:
          "Provider id must be 1-128 ASCII bytes using the portable identifier grammar",
      },
      {
        mutate(prepared: PreparedProviderCommitV2) {
          (prepared.localCandidate as unknown as { candidateId: string })
            .candidateId = "";
        },
        providerId: undefined,
        message:
          "Provider candidate id must be 1-128 ASCII bytes using the portable identifier grammar",
      },
      {
        mutate(prepared: PreparedProviderCommitV2) {
          (prepared.publicResult as unknown as { operation: string })
            .operation = "invalid";
        },
        providerId: undefined,
        message: "Provider transition operation is invalid",
      },
      {
        mutate(prepared: PreparedProviderCommitV2) {
          (prepared.publicResult.expectedHead as unknown as {
            providerId: string;
          }).providerId = "";
          (prepared.localCandidate.expectedHead as unknown as {
            providerId: string;
          }).providerId = "";
        },
        providerId: undefined,
        message:
          "Current provider head provider id must be 1-128 ASCII bytes using the portable identifier grammar",
      },
      {
        mutate(prepared: PreparedProviderCommitV2) {
          const hash = new Uint8Array(31);
          (prepared.publicResult.expectedHead as unknown as {
            stateHash: Uint8Array;
          }).stateHash = hash;
          (prepared.localCandidate.expectedHead as unknown as {
            stateHash: Uint8Array;
          }).stateHash = hash.slice();
        },
        providerId: undefined,
        message: "Current provider head state hash must be exactly 32 bytes",
      },
      {
        mutate(prepared: PreparedProviderCommitV2) {
          const hash = new Uint8Array(31);
          (prepared.publicResult.nextHead as unknown as {
            stateHash: Uint8Array;
          }).stateHash = hash;
          (prepared.localCandidate.nextHead as unknown as {
            stateHash: Uint8Array;
          }).stateHash = hash.slice();
        },
        providerId: undefined,
        message: "Next provider head state hash must be exactly 32 bytes",
      },
      {
        mutate(prepared: PreparedProviderCommitV2) {
          (prepared.localCandidate as unknown as {
            publicTransitionDigest: Uint8Array;
          }).publicTransitionDigest = new Uint8Array(31);
        },
        providerId: undefined,
        message:
          "Provider public transition digest must be exactly 32 bytes",
      },
    ].entries()) {
      const fixture = await dummyFixture(`prepared-validation-${index}`);
      const prepared = structuredClone(
        await fixture.provider.prepareCommit({ active: fixture.active }),
      );
      variant.mutate(prepared);
      const base = providerWrapper(fixture.provider, {
        publicHead: () => prepared.publicResult.nextHead,
        applyCandidate: ({ active }) => ({
          status: "applied",
          active,
        }),
        validatePreparedCandidate: () => Promise.resolve(),
      });
      const provider: V2GroupKeyProvider = {
        ...base,
        id: variant.providerId ?? base.id,
      };
      await expectExactRejection(
        coordinateProviderTransitionWithAuthorizationV2({
          storage: {
            compareAndSwapDomainProviderHead: () =>
              Promise.resolve("applied"),
          },
          provider,
          active: fixture.active,
          prepared,
          authorization: {
            authorizationRevision: authorizationRevision(7),
            resolveCurrentAuthorization: allowDecision,
          },
        }),
        variant.message,
      );
    }
  });

  test("the authorization boundary accepts add, remove, and update operations independently", async () => {
    for (const operation of ["add", "remove", "update"] as const) {
      const fixture = await dummyFixture(`authorization-operation-${operation}`);
      const prepared = structuredClone(
        await fixture.provider.prepareCommit({ active: fixture.active }),
      );
      (prepared.publicResult as unknown as { operation: string }).operation =
        operation;
      const provider = providerWrapper(fixture.provider, {
        publicHead: () => prepared.publicResult.nextHead,
        applyCandidate: ({ active }) => ({
          status: "applied",
          active,
        }),
        validatePreparedCandidate: () => Promise.resolve(),
      });
      expect(
        await coordinateProviderTransitionWithAuthorizationV2({
          storage: {
            compareAndSwapDomainProviderHead: () =>
              Promise.resolve("applied"),
          },
          provider,
          active: fixture.active,
          prepared,
          authorization: {
            authorizationRevision: authorizationRevision(7),
            resolveCurrentAuthorization: allowDecision,
          },
        }),
      ).toMatchObject({ status: "applied" });
    }
  });

  test("rejects malformed authorization inputs and decisions before CAS", async () => {
    const malformedDecisions = [
      () => null,
      (context: ProviderTransitionAuthorizationContextV2) => ({
        ...allowDecision(context),
        unexpected: true,
      }),
      (context: ProviderTransitionAuthorizationContextV2) => ({
        ...allowDecision(context),
        publicTransitionDigest: new Uint8Array(31),
      }),
      (context: ProviderTransitionAuthorizationContextV2) => ({
        ...allowDecision(context),
        actorStatus: "unknown",
      }),
    ];

    for (const resolve of malformedDecisions) {
      const { fixture, prepared } = await tsMlsAddFixture();
      let storageCalls = 0;
      expect(
        coordinateProviderTransitionWithAuthorizationV2({
          storage: {
            compareAndSwapDomainProviderHead: () => {
              storageCalls += 1;
              return Promise.resolve("applied");
            },
          },
          provider: fixture.provider,
          active: fixture.active,
          prepared,
          authorization: {
            authorizationRevision: authorizationRevision(7),
            resolveCurrentAuthorization: resolve as never,
          },
        }),
      ).rejects.toThrow();
      expect(storageCalls).toBe(0);
    }

    const fixture = await dummyFixture("malformed-authorization-input");
    const prepared = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    let providerCalls = 0;
    let storageCalls = 0;
    const provider = providerWrapper(fixture.provider, {
      applyCandidate: () => {
        providerCalls += 1;
        throw new Error("provider must not run");
      },
    });
    expect(
      coordinateProviderTransitionWithAuthorizationV2({
        storage: {
          compareAndSwapDomainProviderHead: () => {
            storageCalls += 1;
            return Promise.resolve("applied");
          },
        },
        provider,
        active: fixture.active,
        prepared,
        authorization: {
          authorizationRevision: authorizationRevision(7),
          resolveCurrentAuthorization: null,
        } as never,
      }),
    ).rejects.toThrow(
      "Current provider transition authorization resolver is required",
    );
    expect({ providerCalls, storageCalls }).toEqual({
      providerCalls: 0,
      storageCalls: 0,
    });
  });
});
