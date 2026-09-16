import { describe, expect, test } from "bun:test";
import {
  createApplicationMessage,
  createCommit,
  decodeGroupState,
  decodeMlsMessage,
  encodeGroupState,
  encodeMlsMessage,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  type CiphersuiteImpl,
  type ClientState,
  type Credential,
  type GroupState,
  type RatchetTree,
} from "ts-mls";
import { defaultClientConfig } from "ts-mls/clientConfig.js";
import {
  LatticeCrypto,
  seededRng,
} from "../../src/crypto/index.ts";
import {
  AI_DOMAIN_ROOT_EXPORTER_LABEL,
  HUMAN_DOMAIN_ROOT_EXPORTER_LABEL,
} from "../../src/domain/roots.ts";
import {
  DeviceProviderStateVaultV2,
  type SealedProviderStateV2,
  V2_PROVIDER_STATE_MAX_BYTES,
} from "../../src/device/v2-state-vault.ts";
import {
  concatV2,
  encodeU64,
  frame,
  frameText,
} from "../../src/format/v2-primitives.ts";
import { TsMlsV2GroupProvider } from "../../src/group/v2-mls.ts";
import {
  destroyOpenedProviderCandidateStateV2,
  openLocalProviderCandidateV2,
  redactProviderWelcomeV2,
  type ProviderPublicHeadV2,
  type ProviderPublicTransitionV2,
} from "../../src/transition/provider-candidate.ts";
import {
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";

function key(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

async function expectRejection(
  operation: Promise<unknown>,
  message: string,
): Promise<void> {
  let rejection: unknown;
  try {
    await operation;
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).message).toContain(message);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset);
}

function afterFrame(bytes: Uint8Array, offset: number): number {
  return offset + 4 + readU32(bytes, offset);
}

function replaceFrame(
  bytes: Uint8Array,
  offset: number,
  replacement: Uint8Array,
): Uint8Array {
  const oldEnd = afterFrame(bytes, offset);
  const result = new Uint8Array(
    offset + 4 + replacement.length + bytes.length - oldEnd,
  );
  result.set(bytes.subarray(0, offset), 0);
  new DataView(result.buffer).setUint32(offset, replacement.length);
  result.set(replacement, offset + 4);
  result.set(bytes.subarray(oldEnd), offset + 4 + replacement.length);
  return result;
}

function stateOffsets(plaintext: Uint8Array) {
  const afterDomain = afterFrame(plaintext, 0);
  const owner = afterDomain + 4;
  const stateHash = afterFrame(plaintext, owner);
  return {
    afterDomain,
    owner,
    stateHash,
    groupState: afterFrame(plaintext, stateHash),
  };
}

function joinPrivateKeyFrames(plaintext: Uint8Array): Uint8Array[] {
  let offset = afterFrame(plaintext, 0) + 4;
  offset = afterFrame(plaintext, offset);
  offset += 4;
  offset = afterFrame(plaintext, offset);
  offset = afterFrame(plaintext, offset);
  offset = afterFrame(plaintext, offset);
  offset = afterFrame(plaintext, offset);
  offset += 8;
  offset = afterFrame(plaintext, offset);
  offset = afterFrame(plaintext, offset);
  const privateKeys: Uint8Array[] = [];
  for (let index = 0; index < 3; index += 1) {
    privateKeys.push(
      plaintext.slice(offset + 4, afterFrame(plaintext, offset)),
    );
    offset = afterFrame(plaintext, offset);
  }
  return privateKeys;
}

function decodedGroupState(plaintext: Uint8Array): GroupState {
  const offset = stateOffsets(plaintext).groupState;
  const encoded = plaintext.subarray(offset + 4, afterFrame(plaintext, offset));
  const decoded = decodeGroupState(encoded, 0);
  if (!decoded || decoded[1] !== encoded.length) {
    throw new Error("Expected a canonical test group state");
  }
  return decoded[0];
}

function decodedClientState(plaintext: Uint8Array): ClientState {
  return {
    ...decodedGroupState(plaintext),
    clientConfig: defaultClientConfig,
  };
}

function replaceGroupState(
  plaintext: Uint8Array,
  mutate: (state: GroupState) => GroupState,
): Uint8Array {
  const offset = stateOffsets(plaintext).groupState;
  return replaceFrame(
    plaintext,
    offset,
    encodeGroupState(mutate(decodedGroupState(plaintext))),
  );
}

function credentialIdentity(
  human: string,
  device: string,
): Uint8Array {
  return concatV2(
    frameText("nautilo/lattice-crypto/ts-mls-credential/v2"),
    frameText(human),
    frameText(device),
  );
}

function encodeHeadForJoin(head: ProviderPublicHeadV2): Uint8Array {
  return concatV2(
    frameText(head.providerId),
    frameText(head.domainId),
    encodeU64(head.epoch),
    frame(head.stateHash),
  );
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bytesHex(bytes: Uint8Array): string {
  return Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function publicGroupContext(state: GroupState): Uint8Array {
  return concatV2(
    frameText(state.groupContext.cipherSuite),
    frame(state.groupContext.treeHash),
    frame(state.groupContext.confirmedTranscriptHash),
  );
}

function deviceProvider(
  device: string,
  keyFill: number,
  seed: number,
): TsMlsV2GroupProvider {
  return deviceFixture(device, keyFill, seed).provider;
}

function deviceFixture(
  device: string,
  keyFill: number,
  seed: number,
) {
  const crypto = new LatticeCrypto(seededRng(seed));
  const deviceId = cryptoDeviceId(device);
  const vault = DeviceProviderStateVaultV2.fromKey(
    crypto,
    deviceId,
    key(keyFill),
  );
  return {
    crypto,
    provider: new TsMlsV2GroupProvider(crypto, vault),
    vault,
  };
}

describe("ts-mls v2 per-device provider", () => {
  test("snapshots scalar coordinates before crossing lazy provider readiness", async () => {
    const alice = deviceProvider("alice-scalar-phone", 0xa0, 8);
    const initialInput = {
      domainId: cryptoDomainId("domain-before"),
      humanId: humanId("alice-before"),
    };
    const pendingInitial = alice.createInitialState(initialInput);
    initialInput.domainId = cryptoDomainId("domain-after");
    initialInput.humanId = humanId("mallory-after");
    const active = await pendingInitial;

    expect(alice.publicHead(active).domainId).toBe(
      cryptoDomainId("domain-before"),
    );
    const rosterText = new TextDecoder().decode(alice.publicRoster(active));
    expect(rosterText).toContain("alice-before");
    expect(rosterText).not.toContain("mallory-after");

    const removeInput = {
      active,
      removedDeviceId: cryptoDeviceId("absent-phone"),
    };
    const pendingRemove = alice.prepareRemove(removeInput);
    removeInput.removedDeviceId = cryptoDeviceId("alice-scalar-phone");
    expect(pendingRemove).rejects.toThrow(
      "Removed device is not in the authenticated MLS roster",
    );
  }, 60_000);

  test("snapshots mutable caller bytes before crossing lazy provider readiness", async () => {
    const alice = deviceProvider("alice-phone", 0xa1, 9);
    const bob = deviceProvider("bob-phone", 0xb2, 10);
    const domainId = cryptoDomainId("domain-ab");
    const active = await alice.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });

    const bufferedActive = {
      ...active,
      ciphertext: Buffer.from(active.ciphertext),
    } as SealedProviderStateV2;
    const pendingCommit = alice.prepareCommit({ active: bufferedActive });
    bufferedActive.ciphertext.fill(0);
    const preparedCommit = await pendingCommit;
    expect(Number(preparedCommit.publicResult.nextHead.epoch)).toBe(1);

    const expectedHead = alice.publicHead(active);
    const expectedHeadHash = Uint8Array.from(expectedHead.stateHash);
    const pendingJoin = bob.createJoinRequest({
      domainId,
      humanId: humanId("bob"),
      expectedHead,
    });
    expectedHead.stateHash.fill(0);
    const join = await pendingJoin;
    expect(join.publicResult.expectedHead.stateHash).toEqual(
      expectedHeadHash,
    );

    const bufferedKeyPackage = Buffer.from(
      join.publicResult.keyPackageBytes,
    );
    const pendingAdd = alice.prepareAdd({
      active,
      joinRequest: {
        ...join.publicResult,
        keyPackageBytes: bufferedKeyPackage,
      },
    });
    bufferedKeyPackage.fill(0);
    const preparedAdd = await pendingAdd;
    expect(preparedAdd.publicResult.operation).toBe("add");
  }, 60_000);

  test("wipes the first exported root when the second root export fails", async () => {
    const alice = deviceProvider("alice-export-failure", 0xa3, 10_001);
    const active = await alice.createInitialState({
      domainId: cryptoDomainId("domain-export-failure"),
      humanId: humanId("alice"),
    });
    const successfulRoots = await alice.exportDomainRoots(active);
    const expectedHumanHex = bytesHex(successfulRoots.human);
    successfulRoots.human.fill(0);
    successfulRoots.ai.fill(0);

    const impl = (alice as unknown as { readonly impl: CiphersuiteImpl }).impl;
    const originalExpand = impl.kdf.expand.bind(impl.kdf);
    impl.kdf.expand = async (_prk, info, _length) => {
      if (
        new TextDecoder().decode(info).includes(
          HUMAN_DOMAIN_ROOT_EXPORTER_LABEL,
        )
      ) {
        throw new Error("injected Human export failure");
      }
      return originalExpand(_prk, info, _length);
    };
    await expectRejection(
      alice.exportDomainRoots(active),
      "injected Human export failure",
    );
    impl.kdf.expand = async (prk, info, length) => {
      if (
        new TextDecoder().decode(info).includes(
          AI_DOMAIN_ROOT_EXPORTER_LABEL,
        )
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        throw new Error("injected AI export failure");
      }
      return originalExpand(prk, info, length);
    };

    const wipedHumanCopies: Uint8Array[] = [];
    const originalFill = Uint8Array.prototype.fill;
    Uint8Array.prototype.fill = function (
      ...args: Parameters<Uint8Array["fill"]>
    ): Uint8Array {
      if (args[0] === 0 && bytesHex(this) === expectedHumanHex) {
        wipedHumanCopies.push(Uint8Array.from(this));
      }
      return originalFill.apply(this, args);
    };
    try {
      await expectRejection(
        alice.exportDomainRoots(active),
        "injected AI export failure",
      );
    } finally {
      impl.kdf.expand = originalExpand;
      Uint8Array.prototype.fill = originalFill;
    }

    expect(wipedHumanCopies.length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  test("prepares a real update without mutating active state and exports exact-label roots", async () => {
    const alice = deviceProvider("alice-phone", 0xa1, 11);
    const domainId = cryptoDomainId("domain-ab");
    const active = await alice.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const oldRoots = await alice.exportDomainRoots(active);
    const forkedAlice = deviceProvider("alice-phone", 0xaf, 12);
    const forkedActive = await forkedAlice.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    expect(forkedAlice.publicHead(forkedActive)).not.toEqual(
      alice.publicHead(active),
    );
    expect(
      alice.prepareRemove({
        active,
        removedDeviceId: cryptoDeviceId("alice-phone"),
      }),
    ).rejects.toThrow("rebootstrap");

    const prepared = await alice.prepareCommit({ active });

    expect(Number(alice.publicHead(active).epoch)).toBe(0);
    expect(await alice.exportDomainRoots(active)).toEqual(oldRoots);
    expect(prepared.publicResult).not.toHaveProperty("localCandidate");
    expect(prepared.publicResult).not.toHaveProperty("ciphertext");
    expect(prepared.publicResult.commitBytes.length).toBeGreaterThan(0);
    expect(prepared.localCandidate.snapshot.classification).toBe(
      "device-local-provider-ciphertext",
    );

    prepared.publicResult.commitBytes[0] =
      prepared.publicResult.commitBytes[0]! ^ 0xff;
    expect(() =>
      alice.applyCandidate({
        active,
        candidate: {
          ...prepared.localCandidate,
          expectedHead: {
            ...prepared.localCandidate.expectedHead,
            stateHash: key(0xed),
          },
        },
      })
    ).toThrow("sealed candidate");
    const applied = alice.applyCandidate({
      active,
      candidate: prepared.localCandidate,
    });
    expect(applied.status).toBe("applied");
    expect(Number(alice.publicHead(applied.active).epoch)).toBe(1);
    expect(await alice.exportDomainRoots(applied.active)).not.toEqual(oldRoots);
  }, 60_000);

  test("processes a real Welcome and keeps the joiner's private state device-local", async () => {
    const alice = deviceProvider("alice-phone", 0xa1, 21);
    const bob = deviceProvider("bob-phone", 0xb2, 22);
    const domainId = cryptoDomainId("domain-ab");
    const aliceActive = await alice.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const join = await bob.createJoinRequest({
      domainId,
      humanId: humanId("bob"),
      expectedHead: alice.publicHead(aliceActive),
    });
    const joinStateBeforePrepare = join.localState.ciphertext.slice();

    expect(join.publicResult).not.toHaveProperty("privatePackage");
    expect(join.publicResult).not.toHaveProperty("ciphertext");
    expect(join.localState.classification).toBe(
      "device-local-provider-ciphertext",
    );
    expect(
      alice.prepareAdd({
        active: aliceActive,
        joinRequest: {
          ...join.publicResult,
          humanId: humanId("mallory"),
        },
      }),
    ).rejects.toThrow("signed MLS key package");
    expect(
      alice.prepareAdd({
        active: aliceActive,
        joinRequest: {
          ...join.publicResult,
          expectedHead: {
            ...join.publicResult.expectedHead,
            stateHash: key(0xee),
          },
        },
      }),
    ).rejects.toThrow("active Domain head");

    const add = await alice.prepareAdd({
      active: aliceActive,
      joinRequest: join.publicResult,
    });
    const crypto = new LatticeCrypto();
    await expectRejection(
      bob.prepareWelcome({
        joinState: join.localState,
        publicResult: {
          ...add.publicResult,
          welcomeBytes: new Uint8Array(),
          welcomeHash: crypto.hash(new Uint8Array()),
        },
      }),
      "MLS Welcome does not match its public commitment",
    );
    const oneByteWelcome = new Uint8Array([1]);
    await expectRejection(
      bob.prepareWelcome({
        joinState: join.localState,
        publicResult: {
          ...add.publicResult,
          welcomeBytes: oneByteWelcome,
          welcomeHash: crypto.hash(oneByteWelcome),
        },
      }),
      "MLS message is malformed or noncanonical",
    );
    const changedRoster = add.publicResult.rosterBytes.slice();
    changedRoster[changedRoster.length - 1] =
      changedRoster[changedRoster.length - 1]! ^ 1;
    for (const rosterBytes of [
      changedRoster,
      concatV2(add.publicResult.rosterBytes, new Uint8Array([0])),
    ]) {
      expect(
        bob.prepareWelcome({
          joinState: join.localState,
          publicResult: {
            ...add.publicResult,
            rosterBytes,
          },
        }),
      ).rejects.toThrow(
        "MLS Welcome roster does not match public transition bytes",
      );
    }
    const bobCandidate = await bob.prepareWelcome({
      joinState: join.localState,
      publicResult: add.publicResult,
    });
    const retryCandidate = await bob.prepareWelcome({
      joinState: join.localState,
      publicResult: add.publicResult,
    });
    expect(join.localState.ciphertext).toEqual(joinStateBeforePrepare);
    expect(retryCandidate.candidateId).toBe(bobCandidate.candidateId);
    expect(add.publicResult.welcomeBytes.length).toBeGreaterThan(0);
    expect(Number(alice.publicHead(aliceActive).epoch)).toBe(0);

    const aliceApplied = alice.applyCandidate({
      active: aliceActive,
      candidate: add.localCandidate,
    });
    const bobApplied = bob.activateWelcome({
      candidate: bobCandidate,
      joinState: join.localState,
    });
    expect(aliceApplied.status).toBe("applied");
    expect(bobApplied.status).toBe("applied");
    expect(alice.publicHead(aliceApplied.active)).toEqual(
      bob.publicHead(bobApplied.active),
    );
    expect(await alice.exportDomainRoots(aliceApplied.active)).toEqual(
      await bob.exportDomainRoots(bobApplied.active),
    );
    const restartedBob = deviceProvider("bob-phone", 0xb2, 220);
    expect(
      restartedBob.abortWelcome({
        candidate: retryCandidate,
        joinState: join.localState,
      }).status,
    ).toBe("already-applied");
    expect(
      restartedBob.abortWelcome({
        candidate: retryCandidate,
        joinState: join.localState,
      }).status,
    ).toBe("already-applied");

    const charlie = deviceProvider("charlie-phone", 0xc3, 23);
    const charlieJoin = await charlie.createJoinRequest({
      domainId,
      humanId: humanId("charlie"),
      expectedHead: alice.publicHead(aliceApplied.active),
    });
    const charlieAdd = await alice.prepareAdd({
      active: aliceApplied.active,
      joinRequest: charlieJoin.publicResult,
    });
    const mutatedWelcome = charlieAdd.publicResult.welcomeBytes.slice();
    mutatedWelcome[mutatedWelcome.length - 1] =
      mutatedWelcome[mutatedWelcome.length - 1]! ^ 0x01;
    expect(
      bob.prepareIncoming({
        active: bobApplied.active,
        publicResult: {
          ...charlieAdd.publicResult,
          welcomeBytes: mutatedWelcome,
          welcomeHash: new LatticeCrypto().hash(mutatedWelcome),
        },
      }),
    ).rejects.toThrow("next public head");
    const redactedCandidate = await bob.prepareIncoming({
      active: bobApplied.active,
      publicResult: redactProviderWelcomeV2(charlieAdd.publicResult),
    });
    expect(redactedCandidate.nextHead).toEqual(
      charlieAdd.publicResult.nextHead,
    );
  }, 60_000);

  test("aborts Welcome state explicitly and preserves the terminal lifecycle across restart", async () => {
    const alice = deviceProvider("alice-phone", 0xa1, 24);
    const bob = deviceProvider("bob-phone", 0xb2, 25);
    const domainId = cryptoDomainId("domain-abort-welcome");
    const active = await alice.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const join = await bob.createJoinRequest({
      domainId,
      humanId: humanId("bob"),
      expectedHead: alice.publicHead(active),
    });
    const add = await alice.prepareAdd({
      active,
      joinRequest: join.publicResult,
    });
    const candidate = await bob.prepareWelcome({
      joinState: join.localState,
      publicResult: add.publicResult,
    });

    expect(bob.abortWelcome({ candidate, joinState: join.localState }).status)
      .toBe("aborted");
    expect(join.localState.ciphertext.some((byte) => byte !== 0)).toBe(true);
    expect(candidate.snapshot.ciphertext.some((byte) => byte !== 0)).toBe(true);

    const restartedBob = deviceProvider("bob-phone", 0xb2, 26);
    expect(
      restartedBob.abortWelcome({
        candidate,
        joinState: join.localState,
      }).status,
    ).toBe("already-aborted");
    expect(
      restartedBob.prepareWelcome({
        joinState: join.localState,
        publicResult: add.publicResult,
      }),
    ).rejects.toThrow("local join request");
  }, 60_000);

  test("existing devices process updates and removal excludes the removed leaf", async () => {
    const alice = deviceProvider("alice-phone", 0xa1, 31);
    const bob = deviceProvider("bob-phone", 0xb2, 32);
    const domainId = cryptoDomainId("domain-ab");
    let aliceActive = await alice.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const join = await bob.createJoinRequest({
      domainId,
      humanId: humanId("bob"),
      expectedHead: alice.publicHead(aliceActive),
    });
    const add = await alice.prepareAdd({
      active: aliceActive,
      joinRequest: join.publicResult,
    });
    const bobJoinCandidate = await bob.prepareWelcome({
      joinState: join.localState,
      publicResult: add.publicResult,
    });
    aliceActive = alice.applyCandidate({
      active: aliceActive,
      candidate: add.localCandidate,
    }).active;
    let bobActive = bob.activateWelcome({
      candidate: bobJoinCandidate,
      joinState: join.localState,
    }).active;

    const update = await alice.prepareCommit({ active: aliceActive });
    expect(
      bob.prepareIncoming({
        active: bobActive,
        publicResult: {
          ...update.publicResult,
          nextHead: {
            ...update.publicResult.nextHead,
            stateHash: key(0xee),
          },
        },
      }),
    ).rejects.toThrow("next public head");
    const bobUpdate = await bob.prepareIncoming({
      active: bobActive,
      publicResult: update.publicResult,
    });
    aliceActive = alice.applyCandidate({
      active: aliceActive,
      candidate: update.localCandidate,
    }).active;
    bobActive = bob.applyCandidate({
      active: bobActive,
      candidate: bobUpdate,
    }).active;
    expect(await alice.exportDomainRoots(aliceActive)).toEqual(
      await bob.exportDomainRoots(bobActive),
    );

    const bobOldRoots = await bob.exportDomainRoots(bobActive);
    const removal = await alice.prepareRemove({
      active: aliceActive,
      removedDeviceId: cryptoDeviceId("bob-phone"),
    });
    const bobRemoval = await bob.prepareIncoming({
      active: bobActive,
      publicResult: removal.publicResult,
    });
    expect(await bob.exportDomainRoots(bobActive)).toEqual(bobOldRoots);

    aliceActive = alice.applyCandidate({
      active: aliceActive,
      candidate: removal.localCandidate,
    }).active;
    bobActive = bob.applyCandidate({
      active: bobActive,
      candidate: bobRemoval,
    }).active;
    expect(Number(alice.publicHead(aliceActive).epoch)).toBe(3);
    expect(bob.exportDomainRoots(bobActive)).rejects.toThrow(
      "Removed",
    );
  }, 60_000);

  test("abort, stale, duplicate, crash, and retry never double-advance", async () => {
    const alice = deviceProvider("alice-phone", 0xa1, 41);
    const domainId = cryptoDomainId("domain-ab");
    const active = await alice.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const aborted = await alice.prepareCommit({ active });

    expect(alice.abortCandidate(aborted.localCandidate).status).toBe("aborted");
    expect(
      alice.applyCandidate({
        active,
        candidate: aborted.localCandidate,
      }).status,
    ).toBe("aborted");

    const winner = await alice.prepareCommit({ active });
    const loser = await alice.prepareCommit({ active });
    const applied = alice.applyCandidate({
      active,
      candidate: winner.localCandidate,
    });
    expect(applied.status).toBe("applied");
    expect(
      alice.applyCandidate({
        active: applied.active,
        candidate: winner.localCandidate,
      }).status,
    ).toBe("duplicate");
    expect(
      alice.applyCandidate({
        active: applied.active,
        candidate: loser.localCandidate,
      }).status,
    ).toBe("stale");

    const crashCandidate = await alice.prepareCommit({
      active: applied.active,
    });
    const restarted = deviceProvider("alice-phone", 0xa1, 42);
    const afterCrash = restarted.applyCandidate({
      active: applied.active,
      candidate: crashCandidate.localCandidate,
    });
    expect(afterCrash.status).toBe("applied");
    expect(Number(restarted.publicHead(afterCrash.active).epoch)).toBe(2);
    expect(
      restarted.applyCandidate({
        active: afterCrash.active,
        candidate: crashCandidate.localCandidate,
      }).status,
    ).toBe("duplicate");
  }, 60_000);

  test("a crash before apply leaves old state usable and retry advances once", async () => {
    const alice = deviceProvider("alice-phone", 0xa1, 51);
    const domainId = cryptoDomainId("domain-ab");
    const active = await alice.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const rootsBefore = await alice.exportDomainRoots(active);
    const abandoned = await alice.prepareCommit({ active });

    const restarted = deviceProvider("alice-phone", 0xa1, 52);
    expect(await restarted.exportDomainRoots(active)).toEqual(rootsBefore);
    expect(Number(restarted.publicHead(active).epoch)).toBe(0);
    const retry = await restarted.prepareCommit({ active });
    const applied = restarted.applyCandidate({
      active,
      candidate: retry.localCandidate,
    });
    expect(applied.status).toBe("applied");
    expect(Number(restarted.publicHead(applied.active).epoch)).toBe(1);
    expect(
      restarted.applyCandidate({
        active: applied.active,
        candidate: abandoned.localCandidate,
      }).status,
    ).toBe("stale");
  }, 60_000);

  test("rejects every malformed public transition coordinate and byte boundary", async () => {
    const alice = deviceProvider("alice-validator", 0xa1, 61);
    const active = await alice.createInitialState({
      domainId: cryptoDomainId("domain-validator"),
      humanId: humanId("alice"),
    });
    const prepared = await alice.prepareCommit({ active });
    const transition = prepared.publicResult;
    const invalid: ProviderPublicTransitionV2[] = [
      { ...transition, formatVersion: 1 as never },
      { ...transition, providerId: "other-provider" },
      { ...transition, domainId: cryptoDomainId("other-domain") },
      {
        ...transition,
        expectedHead: {
          ...transition.expectedHead,
          domainId: cryptoDomainId("other-domain"),
        },
      },
      {
        ...transition,
        nextHead: {
          ...transition.nextHead,
          domainId: cryptoDomainId("other-domain"),
        },
      },
      {
        ...transition,
        expectedHead: {
          ...transition.expectedHead,
          providerId: "other-provider",
        },
      },
      {
        ...transition,
        nextHead: {
          ...transition.nextHead,
          providerId: "other-provider",
        },
      },
      {
        ...transition,
        nextHead: {
          ...transition.nextHead,
          epoch: transition.expectedHead.epoch,
        },
      },
      { ...transition, commitBytes: null as never },
      { ...transition, commitBytes: new Uint8Array() },
      {
        ...transition,
        commitBytes: new Uint8Array(V2_PROVIDER_STATE_MAX_BYTES + 1),
      },
      { ...transition, welcomeBytes: null as never },
      {
        ...transition,
        welcomeBytes: new Uint8Array(V2_PROVIDER_STATE_MAX_BYTES + 1),
      },
      { ...transition, welcomeHash: null as never },
      { ...transition, welcomeHash: new Uint8Array(31) },
      {
        ...transition,
        welcomeBytes: new Uint8Array([1]),
        welcomeHash: key(0xee),
      },
      { ...transition, rosterBytes: null as never },
      { ...transition, rosterBytes: new Uint8Array() },
      {
        ...transition,
        rosterBytes: new Uint8Array(V2_LIMITS.namespaceKeyringBytes + 1),
      },
      {
        ...transition,
        expectedHead: {
          ...transition.expectedHead,
          stateHash: null as never,
        },
      },
      {
        ...transition,
        expectedHead: {
          ...transition.expectedHead,
          stateHash: new Uint8Array(31),
        },
      },
      {
        ...transition,
        nextHead: {
          ...transition.nextHead,
          stateHash: null as never,
        },
      },
      {
        ...transition,
        nextHead: {
          ...transition.nextHead,
          stateHash: new Uint8Array(31),
        },
      },
    ];
    for (const publicResult of invalid) {
      await expectRejection(
        alice.prepareIncoming({ active, publicResult }),
        "ts-mls public transition is invalid",
      );
    }
  }, 60_000);

  test("rejects every malformed public join-request coordinate and byte boundary", async () => {
    const alice = deviceProvider("alice-join-validator", 0xa1, 62);
    const bob = deviceProvider("bob-join-validator", 0xb2, 63);
    const domainId = cryptoDomainId("domain-join-validator");
    const active = await alice.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const join = await bob.createJoinRequest({
      domainId,
      humanId: humanId("bob"),
      expectedHead: alice.publicHead(active),
    });
    const request = join.publicResult;
    const invalid = [
      { ...request, formatVersion: 1 as never },
      { ...request, providerId: "other-provider" },
      {
        ...request,
        providerId: "other-provider",
        expectedHead: {
          ...request.expectedHead,
          providerId: "other-provider",
        },
      },
      { ...request, domainId: cryptoDomainId("other-domain") },
      {
        ...request,
        expectedHead: {
          ...request.expectedHead,
          providerId: "other-provider",
        },
      },
      {
        ...request,
        expectedHead: {
          ...request.expectedHead,
          domainId: cryptoDomainId("other-domain"),
        },
      },
      {
        ...request,
        expectedHead: {
          ...request.expectedHead,
          stateHash: null as never,
        },
      },
      {
        ...request,
        expectedHead: {
          ...request.expectedHead,
          stateHash: new Uint8Array(31),
        },
      },
      { ...request, keyPackageBytes: null as never },
      { ...request, keyPackageBytes: new Uint8Array() },
      {
        ...request,
        keyPackageBytes: new Uint8Array(V2_PROVIDER_STATE_MAX_BYTES + 1),
      },
    ];
    for (const joinRequest of invalid) {
      expect(
        alice.prepareAdd({ active, joinRequest }),
      ).rejects.toThrow("ts-mls join request is invalid");
    }
  }, 60_000);

  test("accepts exact byte-size boundaries before semantic decoding and rejects malformed key-package credentials", async () => {
    const alice = deviceProvider("alice-decode-boundary", 0xa1, 630);
    const bob = deviceProvider("bob-decode-boundary", 0xb2, 631);
    const domainId = cryptoDomainId("domain-decode-boundary");
    const active = await alice.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const join = await bob.createJoinRequest({
      domainId,
      humanId: humanId("bob"),
      expectedHead: alice.publicHead(active),
    });
    for (const length of [1, V2_PROVIDER_STATE_MAX_BYTES]) {
      try {
        await alice.prepareAdd({
          active,
          joinRequest: {
            ...join.publicResult,
            keyPackageBytes: new Uint8Array(length),
          },
        });
        throw new Error("Expected key-package semantic decoding to fail");
      } catch (error) {
        expect(messageText(error)).not.toContain(
          "ts-mls join request is invalid",
        );
      }
    }

    const prepared = await alice.prepareCommit({ active });
    const transitionBoundaries: ProviderPublicTransitionV2[] = [
      {
        ...prepared.publicResult,
        commitBytes: new Uint8Array(1),
      },
      {
        ...prepared.publicResult,
        commitBytes: new Uint8Array(V2_PROVIDER_STATE_MAX_BYTES),
      },
      {
        ...prepared.publicResult,
        welcomeBytes: new Uint8Array(V2_PROVIDER_STATE_MAX_BYTES),
        welcomeHash: new LatticeCrypto().hash(
          new Uint8Array(V2_PROVIDER_STATE_MAX_BYTES),
        ),
      },
      {
        ...prepared.publicResult,
        rosterBytes: new Uint8Array([1]),
      },
      {
        ...prepared.publicResult,
        rosterBytes: new Uint8Array(V2_LIMITS.namespaceKeyringBytes),
      },
    ];
    for (const publicResult of transitionBoundaries) {
      expect(
        alice.validatePreparedCandidate({
          active,
          prepared: {
            ...prepared,
            publicResult,
          },
        }),
      ).rejects.toThrow(
        "ts-mls prepared candidate does not match its public transition",
      );
    }

    const decoded = decodeMlsMessage(join.publicResult.keyPackageBytes, 0);
    expect(decoded?.[1]).toBe(join.publicResult.keyPackageBytes.length);
    const message = decoded?.[0];
    if (!message || message.wireformat !== "mls_key_package") {
      throw new Error("Expected key-package message");
    }
    const withCredential = (credential: Credential): Uint8Array =>
      encodeMlsMessage({
        ...message,
        keyPackage: {
          ...message.keyPackage,
          leafNode: {
            ...message.keyPackage.leafNode,
            credential,
          },
        },
      });
    expect(
      alice.prepareAdd({
        active,
        joinRequest: {
          ...join.publicResult,
          keyPackageBytes: withCredential({
            credentialType: "x509",
            certificates: [new Uint8Array([1])],
          }),
        },
      }),
    ).rejects.toThrow("MLS credential must be basic");
    const wrongDomainIdentity = credentialIdentity("bob", "bob-decode-boundary");
    wrongDomainIdentity[4] = wrongDomainIdentity[4]! ^ 1;
    expect(
      alice.prepareAdd({
        active,
        joinRequest: {
          ...join.publicResult,
          keyPackageBytes: withCredential({
            credentialType: "basic",
            identity: wrongDomainIdentity,
          }),
        },
      }),
    ).rejects.toThrow("MLS credential domain is unsupported");
    expect(
      alice.prepareAdd({
        active,
        joinRequest: {
          ...join.publicResult,
          keyPackageBytes: withCredential({
            credentialType: "basic",
            identity: concatV2(
              credentialIdentity("bob", "bob-decode-boundary"),
              new Uint8Array([0]),
            ),
          }),
        },
      }),
    ).rejects.toThrow("trailing bytes");

    expect(
      alice.prepareAdd({
        active,
        joinRequest: {
          ...join.publicResult,
          keyPackageBytes: concatV2(
            join.publicResult.keyPackageBytes,
            new Uint8Array([0]),
          ),
        },
      }),
    ).rejects.toThrow("MLS message is malformed or noncanonical");
    expect(
      alice.prepareAdd({
        active,
        joinRequest: {
          ...join.publicResult,
          keyPackageBytes: prepared.publicResult.commitBytes,
        },
      }),
    ).rejects.toThrow("Expected an MLS key package");
  }, 60_000);

  test("clones join request bytes and rejects each untrusted create-join head axis and absent removal", async () => {
    const alice = deviceFixture("alice-clone-join", 0xa1, 632);
    const bob = deviceFixture("bob-clone-join", 0xb2, 633);
    const domainId = cryptoDomainId("domain-clone-join");
    const active = await alice.provider.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const head = alice.provider.publicHead(active);
    for (const expectedHead of [
      { ...head, providerId: "other-provider" },
      { ...head, domainId: cryptoDomainId("other-domain") },
    ]) {
      expect(
        bob.provider.createJoinRequest({
          domainId,
          humanId: humanId("bob"),
          expectedHead,
        }),
      ).rejects.toThrow(
        "Join request requires the exact trusted ts-mls public head",
      );
    }
    expect(
      bob.provider.createJoinRequest({
        domainId,
        humanId: humanId("bob"),
        expectedHead: {
          ...head,
          stateHash: new Uint8Array(31),
        },
      }),
    ).rejects.toThrow(
      "MLS public state hash must contain exactly 32 bytes",
    );

    const expectedHash = head.stateHash.slice();
    const join = await bob.provider.createJoinRequest({
      domainId,
      humanId: humanId("bob"),
      expectedHead: head,
    });
    head.stateHash.fill(0);
    expect(join.publicResult.expectedHead.stateHash).toEqual(expectedHash);

    const expectedPackage = join.publicResult.keyPackageBytes.slice();
    join.publicResult.keyPackageBytes.fill(0);
    const joinPlaintext = bob.vault.open(join.localState, {
      providerId: join.localState.providerId,
      domainId,
      revision: join.localState.revision,
      snapshotKind: "candidate",
    })!;
    let offset = afterFrame(joinPlaintext, 0) + 4;
    offset = afterFrame(joinPlaintext, offset);
    offset += 4;
    offset = afterFrame(joinPlaintext, offset);
    offset = afterFrame(joinPlaintext, offset);
    offset = afterFrame(joinPlaintext, offset);
    offset = afterFrame(joinPlaintext, offset);
    offset += 8;
    offset = afterFrame(joinPlaintext, offset);
    expect(
      joinPlaintext.subarray(offset + 4, afterFrame(joinPlaintext, offset)),
    ).toEqual(expectedPackage);

    expect(
      alice.provider.prepareRemove({
        active,
        removedDeviceId: cryptoDeviceId("absent-device"),
      }),
    ).rejects.toThrow(
      "Removed device is not in the authenticated MLS roster",
    );

    const joinIds: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const fixture = deviceFixture(
        `hex-device-${index}`,
        0xc0 + index,
        700 + index,
      );
      const generated = await fixture.provider.createJoinRequest({
        domainId,
        humanId: humanId(`human-${index}`),
        expectedHead: alice.provider.publicHead(active),
      });
      const plaintext = fixture.vault.open(generated.localState, {
        providerId: generated.localState.providerId,
        domainId,
        revision: generated.localState.revision,
        snapshotKind: "candidate",
      })!;
      const joinIdOffset = afterFrame(plaintext, 0) + 4;
      const joinId = new TextDecoder().decode(
        plaintext.subarray(
          joinIdOffset + 4,
          afterFrame(plaintext, joinIdOffset),
        ),
      );
      expect(joinId).toHaveLength(37);
      joinIds.push(joinId);
    }
    expect(
      joinIds.some((joinId) =>
        Array.from(
          { length: 16 },
          (_, index) => joinId.slice(5 + index * 2, 7 + index * 2),
        ).some((pair) => pair.startsWith("0"))
      ),
    ).toBe(true);
  }, 60_000);

  test("rejects sealed active-state domain and version substitution exactly", async () => {
    const state = deviceFixture("alice-state-codec", 0xa1, 64);
    const active = await state.provider.createInitialState({
      domainId: cryptoDomainId("domain-state-codec"),
      humanId: humanId("alice"),
    });
    const coordinates = {
      providerId: active.providerId,
      domainId: active.domainId,
      revision: active.revision,
      snapshotKind: "active" as const,
    };
    const plaintext = state.vault.open(active, coordinates)!;
    const domainLength = readU32(plaintext, 0);
    const versionOffset = 4 + domainLength;

    const wrongDomain = plaintext.slice();
    wrongDomain[4] = wrongDomain[4]! ^ 1;
    expect(() =>
      state.provider.publicHead(
        state.vault.seal(coordinates, wrongDomain),
      )
    ).toThrow("ts-mls state domain is unsupported");

    const wrongVersion = plaintext.slice();
    new DataView(wrongVersion.buffer).setUint32(versionOffset, 99);
    expect(() =>
      state.provider.publicHead(
        state.vault.seal(coordinates, wrongVersion),
      )
    ).toThrow("unsupported version 99");
  }, 60_000);

  test("pins every ts-mls internal domain and its independent head and join commitments", async () => {
    const alice = deviceFixture("alice-domain-golden", 0xa1, 640);
    const bob = deviceFixture("bob-domain-golden", 0xb2, 641);
    const domainId = cryptoDomainId("domain-golden");
    const active = await alice.provider.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const activeCoordinates = {
      providerId: active.providerId,
      domainId,
      revision: active.revision,
      snapshotKind: "active" as const,
    };
    const activePlaintext = alice.vault.open(active, activeCoordinates)!;
    expect(
      new TextDecoder().decode(
        activePlaintext.subarray(4, afterFrame(activePlaintext, 0)),
      ),
    ).toBe("nautilo/lattice-crypto/ts-mls-device-state/v2");

    const state = decodedGroupState(activePlaintext);
    const ownNode = state.ratchetTree[
      Number(state.privatePath.leafIndex) * 2
    ];
    expect(ownNode?.nodeType).toBe("leaf");
    if (!ownNode || ownNode.nodeType !== "leaf") {
      throw new Error("Expected own leaf");
    }
    const credential = ownNode.leaf.credential;
    expect(credential.credentialType).toBe("basic");
    if (credential.credentialType !== "basic") {
      throw new Error("Expected basic credential");
    }
    expect(
      new TextDecoder().decode(
        credential.identity.subarray(4, afterFrame(credential.identity, 0)),
      ),
    ).toBe("nautilo/lattice-crypto/ts-mls-credential/v2");

    const roster = alice.provider.publicRoster(active);
    expect(
      new TextDecoder().decode(roster.subarray(4, afterFrame(roster, 0))),
    ).toBe("nautilo/lattice-crypto/ts-mls-roster/v2");
    const initialHead = alice.provider.publicHead(active);
    expect(initialHead.stateHash).toEqual(
      alice.crypto.hash(concatV2(
        frameText("nautilo/lattice-crypto/ts-mls-initial-head/v2"),
        frameText(alice.provider.id),
        frameText(domainId),
        encodeU64(domainEpoch(0)),
        frame(roster),
        publicGroupContext(state),
      )),
    );

    const join = await bob.provider.createJoinRequest({
      domainId,
      humanId: humanId("bob"),
      expectedHead: initialHead,
    });
    const joinCoordinates = {
      providerId: join.localState.providerId,
      domainId,
      revision: join.localState.revision,
      snapshotKind: "candidate" as const,
    };
    const joinPlaintext = bob.vault.open(
      join.localState,
      joinCoordinates,
    )!;
    expect(
      new TextDecoder().decode(
        joinPlaintext.subarray(4, afterFrame(joinPlaintext, 0)),
      ),
    ).toBe("nautilo/lattice-crypto/ts-mls-join-state/v2");

    const add = await alice.provider.prepareAdd({
      active,
      joinRequest: join.publicResult,
    });
    const damagedActiveCiphertext = active.ciphertext.slice();
    damagedActiveCiphertext[damagedActiveCiphertext.length - 1] =
      damagedActiveCiphertext[damagedActiveCiphertext.length - 1]! ^ 1;
    expect(() =>
      alice.provider.applyCandidate({
        active: { ...active, ciphertext: damagedActiveCiphertext },
        candidate: add.localCandidate,
      })
    ).toThrow("Unable to open active ts-mls snapshot");
    const welcome = await bob.provider.prepareWelcome({
      joinState: join.localState,
      publicResult: add.publicResult,
    });
    const openedWelcome = openLocalProviderCandidateV2({
      vault: bob.vault,
      candidate: welcome,
    });
    try {
      const expectedJoinId = `join_${bytesHex(
        bob.crypto.hash(concatV2(
          frameText("nautilo/lattice-crypto/ts-mls-join-id/v2"),
          frameText("bob-domain-golden"),
          encodeHeadForJoin(initialHead),
          frame(join.publicResult.keyPackageBytes),
        )).subarray(0, 16),
      )}`;
      expect(openedWelcome.sourceId).toBe(expectedJoinId);
    } finally {
      destroyOpenedProviderCandidateStateV2(openedWelcome);
    }

    const applied = alice.provider.applyCandidate({
      active,
      candidate: add.localCandidate,
    });
    const appliedPlaintext = alice.vault.open(applied.active, {
      providerId: applied.active.providerId,
      domainId,
      revision: applied.active.revision,
      snapshotKind: "active",
    })!;
    const appliedState = decodedGroupState(appliedPlaintext);
    expect(add.publicResult.nextHead.stateHash).toEqual(
      alice.crypto.hash(concatV2(
        frameText("nautilo/lattice-crypto/ts-mls-next-head/v2"),
        frame(initialHead.stateHash),
        frame(add.publicResult.commitBytes),
        frame(add.publicResult.welcomeHash),
        frame(add.publicResult.rosterBytes),
        encodeU64(add.publicResult.nextHead.epoch),
        publicGroupContext(appliedState),
      )),
    );
  }, 60_000);

  test("rejects every active snapshot coordinate, vault-open, canonical-state, metadata, and own-leaf substitution", async () => {
    const fixture = deviceFixture("alice-active-raw", 0xa1, 642);
    const domainId = cryptoDomainId("domain-active-raw");
    const active = await fixture.provider.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const coordinates = {
      providerId: active.providerId,
      domainId,
      revision: active.revision,
      snapshotKind: "active" as const,
    };
    const plaintext = fixture.vault.open(active, coordinates)!;

    const wrongCoordinates: SealedProviderStateV2[] = [
      { ...active, providerId: "other-provider" },
      { ...active, deviceId: cryptoDeviceId("other-device") },
      { ...active, snapshotKind: "candidate" },
    ];
    for (const snapshot of wrongCoordinates) {
      expect(() => fixture.provider.publicHead(snapshot)).toThrow(
        "Invalid active ts-mls snapshot coordinates",
      );
    }

    const damagedCiphertext = active.ciphertext.slice();
    damagedCiphertext[damagedCiphertext.length - 1] =
      damagedCiphertext[damagedCiphertext.length - 1]! ^ 1;
    expect(() =>
      fixture.provider.publicHead({
        ...active,
        ciphertext: damagedCiphertext,
      })
    ).toThrow("Unable to open active ts-mls snapshot");

    const hashOffset = stateOffsets(plaintext).stateHash;
    for (const [length, message] of [
      [31, "ts-mls public state hash must contain exactly 32 bytes"],
      [33, "frame length exceeds the 32-byte limit"],
    ] as const) {
      const changed = replaceFrame(
        plaintext,
        hashOffset,
        new Uint8Array(length),
      );
      expect(() =>
        fixture.provider.publicHead(fixture.vault.seal(coordinates, changed))
      ).toThrow(message);
    }

    const groupOffset = stateOffsets(plaintext).groupState;
    const groupBytes = plaintext.subarray(
      groupOffset + 4,
      afterFrame(plaintext, groupOffset),
    );
    expect(() =>
      fixture.provider.publicHead(
        fixture.vault.seal(
          coordinates,
          replaceFrame(
            plaintext,
            groupOffset,
            concatV2(groupBytes, new Uint8Array([0])),
          ),
        ),
      )
    ).toThrow("ts-mls group state is malformed or noncanonical");

    const wrongDomain = fixture.vault.seal(
      {
        ...coordinates,
        domainId: cryptoDomainId("different-domain"),
      },
      plaintext,
    );
    expect(() => fixture.provider.publicHead(wrongDomain)).toThrow(
      "ts-mls state metadata does not match its sealed snapshot",
    );
    const wrongEpoch = fixture.vault.seal(
      { ...coordinates, revision: domainEpoch(1) },
      plaintext,
    );
    expect(() => fixture.provider.publicHead(wrongEpoch)).toThrow(
      "ts-mls state metadata does not match its sealed snapshot",
    );

    const changedOwner = plaintext.slice();
    const ownerOffset = stateOffsets(plaintext).owner;
    changedOwner[ownerOffset + 4] = "m".charCodeAt(0);
    expect(() =>
      fixture.provider.publicHead(
        fixture.vault.seal(coordinates, changedOwner),
      )
    ).toThrow(
      "Active ts-mls state identity does not match its device snapshot",
    );

    const missingOwnLeaf = replaceGroupState(plaintext, (state) => {
      const own = state.ratchetTree[
        Number(state.privatePath.leafIndex) * 2
      ];
      if (!own || own.nodeType !== "leaf") {
        throw new Error("Expected own leaf");
      }
      return {
        ...state,
        ratchetTree: [undefined, undefined, own],
      };
    });
    expect(() =>
      fixture.provider.publicHead(
        fixture.vault.seal(coordinates, missingOwnLeaf),
      )
    ).toThrow("Active ts-mls state has no authenticated own leaf");

    const wrongDevice = replaceGroupState(plaintext, (state) => {
      const ownIndex = Number(state.privatePath.leafIndex) * 2;
      const tree = [...state.ratchetTree];
      const own = tree[ownIndex];
      if (!own || own.nodeType !== "leaf") {
        throw new Error("Expected own leaf");
      }
      tree[ownIndex] = {
        ...own,
        leaf: {
          ...own.leaf,
          credential: {
            credentialType: "basic",
            identity: credentialIdentity("alice", "other-active-device"),
          },
        },
      };
      return { ...state, ratchetTree: tree };
    });
    expect(() =>
      fixture.provider.publicHead(
        fixture.vault.seal(coordinates, wrongDevice),
      )
    ).toThrow(
      "Active ts-mls state identity does not match its device snapshot",
    );

    const overflowEpoch = replaceGroupState(plaintext, (state) => ({
      ...state,
      groupContext: {
        ...state.groupContext,
        epoch: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      },
    }));
    expect(() =>
      fixture.provider.publicHead(
        fixture.vault.seal(coordinates, overflowEpoch),
      )
    ).toThrow("MLS epoch exceeds the safe integer range");

    const maximumSafeEpoch = domainEpoch(Number.MAX_SAFE_INTEGER);
    const safeBoundaryState = replaceGroupState(plaintext, (state) => ({
      ...state,
      groupContext: {
        ...state.groupContext,
        epoch: BigInt(Number.MAX_SAFE_INTEGER),
      },
    }));
    expect(
      fixture.provider.publicHead(
        fixture.vault.seal(
          { ...coordinates, revision: maximumSafeEpoch },
          safeBoundaryState,
        ),
      ).epoch,
    ).toBe(maximumSafeEpoch);
  }, 60_000);

  test("enforces exact authenticated roster uniqueness and 256-device and 64-Human boundaries", async () => {
    const alice = deviceFixture("alice-roster-limits", 0xa1, 643);
    const domainId = cryptoDomainId("domain-roster-limits");
    const active = await alice.provider.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const coordinates = {
      providerId: active.providerId,
      domainId,
      revision: active.revision,
      snapshotKind: "active" as const,
    };
    const plaintext = alice.vault.open(active, coordinates)!;
    const rosterState = (
      entries: readonly Readonly<{ human: string; device: string }>[],
    ): SealedProviderStateV2 => {
      const changed = replaceGroupState(plaintext, (state) => {
        const own = state.ratchetTree[
          Number(state.privatePath.leafIndex) * 2
        ];
        if (!own || own.nodeType !== "leaf") {
          throw new Error("Expected own leaf");
        }
        const tree: RatchetTree = Array.from(
          { length: entries.length * 2 - 1 },
          () => undefined,
        );
        entries.forEach((entry, index) => {
          tree[index * 2] = {
            ...own,
            leaf: {
              ...own.leaf,
              credential: {
                credentialType: "basic",
                identity: credentialIdentity(entry.human, entry.device),
              },
            },
          };
        });
        return { ...state, ratchetTree: tree };
      });
      return alice.vault.seal(coordinates, changed);
    };
    const entries = Array.from({ length: 256 }, (_, index) => ({
      human: index === 0 ? "alice" : `human-${((index - 1) % 63) + 1}`,
      device: index === 0
        ? "alice-roster-limits"
        : `device-${index.toString().padStart(3, "0")}`,
    }));
    const atDeviceLimit = rosterState(entries);
    const roster = alice.provider.publicRoster(atDeviceLimit);
    const countOffset = afterFrame(roster, 0);
    expect(readU32(roster, countOffset)).toBe(256);
    let rosterOffset = countOffset + 4;
    for (let leafIndex = 0; leafIndex < 256; leafIndex += 1) {
      expect(readU32(roster, rosterOffset)).toBe(leafIndex);
      rosterOffset += 4;
      rosterOffset = afterFrame(roster, rosterOffset);
      rosterOffset = afterFrame(roster, rosterOffset);
    }
    expect(rosterOffset).toBe(roster.length);

    const bob = deviceProvider("bob-roster-limits", 0xb2, 644);
    const bobJoin = await bob.createJoinRequest({
      domainId,
      humanId: humanId("bob"),
      expectedHead: alice.provider.publicHead(atDeviceLimit),
    });
    expect(
      alice.provider.prepareAdd({
        active: atDeviceLimit,
        joinRequest: bobJoin.publicResult,
      }),
    ).rejects.toThrow("256-device Domain limit");

    const overDeviceLimit = rosterState([
      ...entries,
      { human: "human-1", device: "device-256" },
    ]);
    expect(() => alice.provider.publicRoster(overDeviceLimit)).toThrow(
      "MLS roster exceeds the 256-device Domain limit",
    );

    const sixtyFourHumans = rosterState(
      Array.from({ length: 64 }, (_, index) => ({
        human: index === 0 ? "alice" : `human-${index}`,
        device: index === 0
          ? "alice-roster-limits"
          : `human-device-${index}`,
      })),
    );
    const newHuman = deviceProvider("new-human-device", 0xc3, 645);
    const newHumanJoin = await newHuman.createJoinRequest({
      domainId,
      humanId: humanId("new-human"),
      expectedHead: alice.provider.publicHead(sixtyFourHumans),
    });
    expect(
      alice.provider.prepareAdd({
        active: sixtyFourHumans,
        joinRequest: newHumanJoin.publicResult,
      }),
    ).rejects.toThrow("64-Human Domain limit");

    const sixtyFiveHumans = rosterState([
      ...Array.from({ length: 64 }, (_, index) => ({
        human: index === 0 ? "alice" : `human-${index}`,
        device: index === 0
          ? "alice-roster-limits"
          : `human-device-${index}`,
      })),
      { human: "human-64", device: "human-device-64" },
    ]);
    expect(() => alice.provider.publicRoster(sixtyFiveHumans)).toThrow(
      "MLS roster exceeds the 64-Human Domain limit",
    );

    const duplicateDevice = rosterState([
      { human: "alice", device: "alice-roster-limits" },
      { human: "bob", device: "alice-roster-limits" },
    ]);
    expect(() => alice.provider.publicRoster(duplicateDevice)).toThrow(
      "Authenticated MLS roster contains a duplicate device identity",
    );
  }, 60_000);

  test("rejects every sealed join-state identity and lifecycle substitution", async () => {
    const alice = deviceFixture("alice-join-codec", 0xa1, 65);
    const bob = deviceFixture("bob-join-codec", 0xb2, 66);
    const domainId = cryptoDomainId("domain-join-codec");
    const active = await alice.provider.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const join = await bob.provider.createJoinRequest({
      domainId,
      humanId: humanId("bob"),
      expectedHead: alice.provider.publicHead(active),
    });
    const add = await alice.provider.prepareAdd({
      active,
      joinRequest: join.publicResult,
    });
    const coordinates = {
      providerId: join.localState.providerId,
      domainId: join.localState.domainId,
      revision: join.localState.revision,
      snapshotKind: "candidate" as const,
    };
    const plaintext = bob.vault.open(join.localState, coordinates)!;

    for (const joinState of [
      { ...join.localState, providerId: "other-provider" },
      {
        ...join.localState,
        deviceId: cryptoDeviceId("other-join-device"),
      },
      { ...join.localState, snapshotKind: "active" as const },
    ]) {
      expect(
        bob.provider.prepareWelcome({
          joinState,
          publicResult: add.publicResult,
        }),
      ).rejects.toThrow("Invalid local ts-mls join state");
    }
    const damagedCiphertext = join.localState.ciphertext.slice();
    damagedCiphertext[damagedCiphertext.length - 1] =
      damagedCiphertext[damagedCiphertext.length - 1]! ^ 1;
    expect(
      bob.provider.prepareWelcome({
        joinState: { ...join.localState, ciphertext: damagedCiphertext },
        publicResult: add.publicResult,
      }),
    ).rejects.toThrow("Unable to open local ts-mls join state");
    expect(
      bob.provider.prepareWelcome({
        joinState: bob.vault.seal(
          {
            ...coordinates,
            domainId: cryptoDomainId("other-join-domain"),
          },
          plaintext,
        ),
        publicResult: add.publicResult,
      }),
    ).rejects.toThrow("Local ts-mls join state metadata mismatch");
    expect(
      bob.provider.prepareWelcome({
        joinState: bob.vault.seal(
          {
            ...coordinates,
            revision: domainEpoch(Number(coordinates.revision) + 1),
          },
          plaintext,
        ),
        publicResult: add.publicResult,
      }),
    ).rejects.toThrow("Local ts-mls join state metadata mismatch");
    expect(
      bob.provider.prepareWelcome({
        joinState: bob.vault.seal(
          coordinates,
          concatV2(plaintext, new Uint8Array([0])),
        ),
        publicResult: add.publicResult,
      }),
    ).rejects.toThrow("trailing bytes");

    let offset = 0;
    const domainValue = 4;
    offset = afterFrame(plaintext, offset);
    const versionOffset = offset;
    offset += 4;
    offset = afterFrame(plaintext, offset);
    const lifecycleOffset = offset;
    offset += 4;
    offset = afterFrame(plaintext, offset);
    const deviceValue = offset + 4;
    offset = afterFrame(plaintext, offset);
    const headProviderValue = offset + 4;
    offset = afterFrame(plaintext, offset);
    const headDomainValue = offset + 4;
    offset = afterFrame(plaintext, offset);
    const headEpochOffset = offset;
    const headHashOffset = headEpochOffset + 8;

    expect(
      bob.provider.prepareWelcome({
        joinState: bob.vault.seal(
          coordinates,
          replaceFrame(
            plaintext,
            headHashOffset,
            new Uint8Array(31),
          ),
        ),
        publicResult: add.publicResult,
      }),
    ).rejects.toThrow(
      "MLS public state hash must contain exactly 32 bytes",
    );

    const variants = [
      {
        mutate(bytes: Uint8Array) {
          bytes[domainValue] = bytes[domainValue]! ^ 1;
        },
        message: "ts-mls join state domain is unsupported",
      },
      {
        mutate(bytes: Uint8Array) {
          new DataView(bytes.buffer).setUint32(versionOffset, 99);
        },
        message: "unsupported version 99",
      },
      {
        mutate(bytes: Uint8Array) {
          new DataView(bytes.buffer).setUint32(lifecycleOffset, 99);
        },
        message: "Local ts-mls join lifecycle is invalid",
      },
      {
        mutate(bytes: Uint8Array) {
          bytes[deviceValue] = bytes[deviceValue]! ^ 1;
        },
        message: "Local ts-mls join state metadata mismatch",
      },
      {
        mutate(bytes: Uint8Array) {
          bytes[headProviderValue] = bytes[headProviderValue]! ^ 1;
        },
        message: "Local ts-mls join state metadata mismatch",
      },
      {
        mutate(bytes: Uint8Array) {
          bytes[headDomainValue] = bytes[headDomainValue]! ^ 1;
        },
        message: "Local ts-mls join state metadata mismatch",
      },
      {
        mutate(bytes: Uint8Array) {
          new DataView(bytes.buffer).setBigUint64(
            headEpochOffset,
            BigInt(Number(join.publicResult.expectedHead.epoch) + 2),
          );
        },
        message: "Local ts-mls join state metadata mismatch",
      },
    ];

    for (const variant of variants) {
      const changed = plaintext.slice();
      variant.mutate(changed);
      const joinState = bob.vault.seal(coordinates, changed);
      expect(
        bob.provider.prepareWelcome({
          joinState,
          publicResult: add.publicResult,
        }),
      ).rejects.toThrow(variant.message);
    }
  }, 60_000);

  test("locks Welcome activation and abort lifecycle cross-products", async () => {
    const alice = deviceProvider("alice-welcome-life", 0xa1, 67);
    const bob = deviceProvider("bob-welcome-life", 0xb2, 68);
    const domainId = cryptoDomainId("domain-welcome-life");
    const active = await alice.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const join = await bob.createJoinRequest({
      domainId,
      humanId: humanId("bob"),
      expectedHead: alice.publicHead(active),
    });
    const add = await alice.prepareAdd({
      active,
      joinRequest: join.publicResult,
    });
    const candidate = await bob.prepareWelcome({
      joinState: join.localState,
      publicResult: add.publicResult,
    });
    const applied = bob.activateWelcome({
      candidate,
      joinState: join.localState,
    });
    expect(applied.status).toBe("applied");
    expect(() =>
      bob.activateWelcome({
        candidate,
        joinState: join.localState,
      })
    ).toThrow("already activated");
    expect(
      bob.abortWelcome({
        candidate,
        joinState: join.localState,
      }).status,
    ).toBe("already-applied");

    const charlie = deviceProvider("charlie-welcome-life", 0xc3, 69);
    const charlieJoin = await charlie.createJoinRequest({
      domainId,
      humanId: humanId("charlie"),
      expectedHead: add.publicResult.nextHead,
    });
    const charlieAdd = await alice.prepareAdd({
      active: alice.applyCandidate({
        active,
        candidate: add.localCandidate,
      }).active,
      joinRequest: charlieJoin.publicResult,
    });
    const aborted = await charlie.prepareWelcome({
      joinState: charlieJoin.localState,
      publicResult: charlieAdd.publicResult,
    });
    expect(
      charlie.abortWelcome({
        candidate: aborted,
        joinState: charlieJoin.localState,
      }).status,
    ).toBe("aborted");
    expect(() =>
      charlie.activateWelcome({
        candidate: aborted,
        joinState: charlieJoin.localState,
      })
    ).toThrow("aborted");
  }, 60_000);

  test("validates prepared, applied, competing, and transition-substituted candidates exactly", async () => {
    const alice = deviceProvider("alice-prepared", 0xa1, 70);
    const domainId = cryptoDomainId("domain-prepared");
    const active = await alice.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const winner = await alice.prepareCommit({ active });
    const loser = await alice.prepareCommit({ active });
    expect(
      await alice.validatePreparedCandidate({ active, prepared: winner }),
    ).toBeUndefined();

    const applied = alice.applyCandidate({
      active,
      candidate: winner.localCandidate,
    });
    expect(
      await alice.validatePreparedCandidate({
        active: applied.active,
        prepared: winner,
      }),
    ).toBeUndefined();
    expect(
      alice.validatePreparedCandidate({ active, prepared: winner }),
    ).rejects.toThrow(
      "Applied ts-mls candidate does not match the active public head",
    );
    expect(
      alice.validatePreparedCandidate({
        active: applied.active,
        prepared: loser,
      }),
    ).rejects.toThrow(
      "ts-mls prepared candidate does not match the active public head",
    );

    const changedCommit = winner.publicResult.commitBytes.slice();
    changedCommit[0] = changedCommit[0]! ^ 1;
    expect(
      alice.validatePreparedCandidate({
        active,
        prepared: {
          ...winner,
          publicResult: {
            ...winner.publicResult,
            commitBytes: changedCommit,
          },
        },
      }),
    ).rejects.toThrow(
      "ts-mls prepared candidate does not match its public transition",
    );

    const wrongRoster = winner.publicResult.rosterBytes.slice();
    wrongRoster[wrongRoster.length - 1] =
      wrongRoster[wrongRoster.length - 1]! ^ 1;
    expect(
      alice.validatePreparedCandidate({
        active,
        prepared: {
          ...winner,
          publicResult: {
            ...winner.publicResult,
            rosterBytes: wrongRoster,
          },
        },
      }),
    ).rejects.toThrow();
  }, 60_000);

  test("rejects incoming non-commit messages, roster substitution, and exact-head forks", async () => {
    const alice = deviceProvider("alice-incoming", 0xa1, 71);
    const bob = deviceProvider("bob-incoming", 0xb2, 72);
    const domainId = cryptoDomainId("domain-incoming");
    const active = await alice.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const update = await alice.prepareCommit({ active });
    const join = await bob.createJoinRequest({
      domainId,
      humanId: humanId("bob"),
      expectedHead: alice.publicHead(active),
    });
    expect(
      alice.prepareIncoming({
        active,
        publicResult: {
          ...update.publicResult,
          commitBytes: join.publicResult.keyPackageBytes,
        },
      }),
    ).rejects.toThrow("Expected an MLS commit message");

    expect(
      alice.prepareIncoming({
        active,
        publicResult: {
          ...update.publicResult,
          expectedHead: {
            ...update.publicResult.expectedHead,
            stateHash: key(0x91),
          },
        },
      }),
    ).rejects.toThrow("exact expected public head");
  }, 60_000);

  test("accepts public commit wireformat and classifies private application messages explicitly", async () => {
    const alice = deviceFixture("alice-message-classes", 0xa1, 79);
    const bob = deviceFixture("bob-message-classes", 0xb2, 80);
    const domainId = cryptoDomainId("domain-message-classes");
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
    const bobActive = bob.provider.activateWelcome({
      candidate: welcome,
      joinState: join.localState,
    }).active;
    const activeCoordinates = {
      providerId: aliceActive.providerId,
      domainId,
      revision: aliceActive.revision,
      snapshotKind: "active" as const,
    };
    const impl = await getCiphersuiteImpl(
      getCiphersuiteFromName(
        "MLS_256_DHKEMP521_AES256GCM_SHA512_P521",
      ),
    );
    const transition = await alice.provider.prepareCommit({
      active: aliceActive,
    });

    const appState = decodedClientState(
      alice.vault.open(aliceActive, activeCoordinates)!,
    );
    const applicationPlaintext = new TextEncoder().encode("not-a-commit");
    const application = await createApplicationMessage(
      appState,
      applicationPlaintext,
      impl,
    );
    const applicationBytes = encodeMlsMessage({
      wireformat: "mls_private_message",
      version: "mls10",
      privateMessage: application.privateMessage,
    });
    application.consumed.forEach((bytes) => bytes.fill(0));
    const wipedApplicationMessages: Uint8Array[] = [];
    const originalFill = Uint8Array.prototype.fill;
    Uint8Array.prototype.fill = function (
      ...args: Parameters<Uint8Array["fill"]>
    ): Uint8Array {
      if (
        args[0] === 0
        && bytesHex(this) === bytesHex(applicationPlaintext)
      ) {
        wipedApplicationMessages.push(Uint8Array.from(this));
      }
      return originalFill.apply(this, args);
    };
    let applicationFailure: unknown;
    try {
      await bob.provider.prepareIncoming({
        active: bobActive,
        publicResult: {
          ...transition.publicResult,
          commitBytes: applicationBytes,
        },
      });
    } catch (error) {
      applicationFailure = error;
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }
    expect(applicationFailure).toBeInstanceOf(Error);
    expect((applicationFailure as Error).message).toBe(
      "MLS commit produced an application message",
    );
    expect(wipedApplicationMessages).toHaveLength(1);

    const publicState = decodedClientState(
      alice.vault.open(aliceActive, activeCoordinates)!,
    );
    const publicCommit = await createCommit(
      { state: publicState, cipherSuite: impl },
      {
        wireAsPublicMessage: true,
        ratchetTreeExtension: true,
      },
    );
    expect(publicCommit.commit.wireformat).toBe("mls_public_message");
    const publicCommitBytes = encodeMlsMessage(publicCommit.commit);
    publicCommit.consumed.forEach((bytes) => bytes.fill(0));
    expect(
      bob.provider.prepareIncoming({
        active: bobActive,
        publicResult: {
          ...transition.publicResult,
          commitBytes: publicCommitBytes,
        },
      }),
    ).rejects.toThrow("exact next public head");
  }, 60_000);

  test("rejects duplicate add devices and binds signed key-package Human and device identities", async () => {
    const alice = deviceProvider("alice-add-axes", 0xa1, 73);
    const bob = deviceProvider("bob-add-axes", 0xb2, 74);
    const domainId = cryptoDomainId("domain-add-axes");
    let active = await alice.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const join = await bob.createJoinRequest({
      domainId,
      humanId: humanId("bob"),
      expectedHead: alice.publicHead(active),
    });
    const otherDomain = cryptoDomainId("other-add-domain");
    expect(
      alice.prepareAdd({
        active,
        joinRequest: {
          ...join.publicResult,
          domainId: otherDomain,
          expectedHead: {
            ...join.publicResult.expectedHead,
            domainId: otherDomain,
          },
        },
      }),
    ).rejects.toThrow("Join request does not match the active Domain head");
    for (const request of [
      { ...join.publicResult, humanId: humanId("mallory") },
      {
        ...join.publicResult,
        deviceId: cryptoDeviceId("mallory-phone"),
      },
    ]) {
      expect(
        alice.prepareAdd({ active, joinRequest: request }),
      ).rejects.toThrow(
        "Join request identity does not match its signed MLS key package",
      );
    }
    const add = await alice.prepareAdd({
      active,
      joinRequest: join.publicResult,
    });
    active = alice.applyCandidate({
      active,
      candidate: add.localCandidate,
    }).active;
    expect(
      alice.prepareAdd({
        active,
        joinRequest: {
          ...join.publicResult,
          expectedHead: alice.publicHead(active),
        },
      }),
    ).rejects.toThrow(
      "Join request device already exists in the authenticated MLS roster",
    );
  }, 60_000);

  test("guards next-head epoch arithmetic and wipes decoded join secrets directly", async () => {
    const fixture = deviceFixture("alice-internal-guards", 0xa1, 81);
    const domainId = cryptoDomainId("domain-internal-guards");
    const active = await fixture.provider.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const plaintext = fixture.vault.open(active, {
      providerId: active.providerId,
      domainId,
      revision: active.revision,
      snapshotKind: "active",
    })!;
    const internal = fixture.provider as unknown as {
      nextHead(
        expected: ProviderPublicHeadV2,
        commitBytes: Uint8Array,
        welcomeBytes: Uint8Array,
        rosterBytes: Uint8Array,
        state: ClientState,
      ): ProviderPublicHeadV2;
      destroyJoinSecrets(join: {
        keyPackageBytes: Uint8Array;
        privatePackage: {
          initPrivateKey: Uint8Array;
          hpkePrivateKey: Uint8Array;
          signaturePrivateKey: Uint8Array;
        };
      }): void;
    };
    expect(() =>
      internal.nextHead(
        {
          ...fixture.provider.publicHead(active),
          epoch: domainEpoch(5),
        },
        new Uint8Array([1]),
        new Uint8Array(),
        fixture.provider.publicRoster(active),
        decodedClientState(plaintext),
      )
    ).toThrow("MLS commit must advance the Domain epoch exactly once");

    const secrets = {
      keyPackageBytes: new Uint8Array([1, 2]),
      privatePackage: {
        initPrivateKey: new Uint8Array([3]),
        hpkePrivateKey: new Uint8Array([4]),
        signaturePrivateKey: new Uint8Array([5]),
      },
    };
    internal.destroyJoinSecrets(secrets);
    expect([
      secrets.keyPackageBytes,
      secrets.privatePackage.initPrivateKey,
      secrets.privatePackage.hpkePrivateKey,
      secrets.privatePackage.signaturePrivateKey,
    ].every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
  }, 60_000);

  test("rejects any device-vault join tombstone whose sealed length changes", async () => {
    const alice = deviceProvider("alice-tombstone-length", 0xa1, 82);
    const backing = deviceFixture("bob-tombstone-length", 0xb2, 83);
    let distortNextSeal = false;
    const vault = {
      deviceId: backing.vault.deviceId,
      seal(
        ...args: Parameters<DeviceProviderStateVaultV2["seal"]>
      ) {
        const snapshot = backing.vault.seal(...args);
        if (!distortNextSeal) return snapshot;
        distortNextSeal = false;
        return {
          ...snapshot,
          ciphertext: concatV2(
            snapshot.ciphertext,
            new Uint8Array([0]),
          ),
        } as SealedProviderStateV2;
      },
      open(
        ...args: Parameters<DeviceProviderStateVaultV2["open"]>
      ) {
        return backing.vault.open(...args);
      },
    } as unknown as DeviceProviderStateVaultV2;
    const bob = new TsMlsV2GroupProvider(backing.crypto, vault);
    const domainId = cryptoDomainId("domain-tombstone-length");
    const active = await alice.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const join = await bob.createJoinRequest({
      domainId,
      humanId: humanId("bob"),
      expectedHead: alice.publicHead(active),
    });
    const add = await alice.prepareAdd({
      active,
      joinRequest: join.publicResult,
    });
    const candidate = await bob.prepareWelcome({
      joinState: join.localState,
      publicResult: add.publicResult,
    });
    distortNextSeal = true;
    expect(() =>
      bob.abortWelcome({
        candidate,
        joinState: join.localState,
      })
    ).toThrow("Local ts-mls join tombstone length changed unexpectedly");
  }, 60_000);

  test("wipes every observable active, join, and candidate plaintext at the vault boundary", async () => {
    const instrumented = (
      device: string,
      keyFill: number,
      seed: number,
    ) => {
      const backing = deviceFixture(device, keyFill, seed);
      const sealedInputs: Uint8Array[] = [];
      const sealedSnapshots: SealedProviderStateV2[] = [];
      const openedSnapshots: SealedProviderStateV2[] = [];
      const openedOutputs: Uint8Array[] = [];
      const vault = {
        deviceId: backing.vault.deviceId,
        seal(
          ...args: Parameters<DeviceProviderStateVaultV2["seal"]>
        ) {
          sealedInputs.push(args[1]);
          const snapshot = backing.vault.seal(...args);
          sealedSnapshots.push(snapshot);
          return snapshot;
        },
        open(
          ...args: Parameters<DeviceProviderStateVaultV2["open"]>
        ) {
          openedSnapshots.push(args[0]);
          const opened = backing.vault.open(...args);
          if (opened) openedOutputs.push(opened);
          return opened;
        },
      } as unknown as DeviceProviderStateVaultV2;
      return {
        provider: new TsMlsV2GroupProvider(backing.crypto, vault),
        sealedInputs,
        sealedSnapshots,
        openedSnapshots,
        openedOutputs,
      };
    };
    const alice = instrumented("alice-wipe-boundary", 0xa1, 77);
    const bob = instrumented("bob-wipe-boundary", 0xb2, 78);
    const domainId = cryptoDomainId("domain-wipe-boundary");
    const active = await alice.provider.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    expect(alice.sealedInputs.length).toBeGreaterThan(0);
    expect(
      alice.sealedInputs.every((bytes) => bytes.every((byte) => byte === 0)),
    ).toBe(true);

    alice.provider.publicHead(active);
    expect(alice.openedOutputs.length).toBeGreaterThan(0);
    expect(
      alice.openedOutputs.every((bytes) => bytes.every((byte) => byte === 0)),
    ).toBe(true);

    const join = await bob.provider.createJoinRequest({
      domainId,
      humanId: humanId("bob"),
      expectedHead: alice.provider.publicHead(active),
    });
    expect(
      bob.sealedInputs.every((bytes) => bytes.every((byte) => byte === 0)),
    ).toBe(true);
    const add = await alice.provider.prepareAdd({
      active,
      joinRequest: join.publicResult,
    });
    expect(
      alice.sealedSnapshots.at(-2)?.ciphertext.every((byte) => byte === 0),
    ).toBe(true);
    expect(
      alice.sealedSnapshots.at(-1)?.ciphertext.some((byte) => byte !== 0),
    ).toBe(true);
    const beforeValidation = alice.openedSnapshots.length;
    await alice.provider.validatePreparedCandidate({
      active,
      prepared: add,
    });
    const validationSnapshots = alice.openedSnapshots.slice(beforeValidation);
    expect(validationSnapshots).toHaveLength(3);
    expect(
      validationSnapshots.slice(0, -1).every((snapshot) =>
        snapshot.ciphertext.some((byte) => byte !== 0)
      ),
    ).toBe(true);
    expect(
      validationSnapshots.at(-1)?.ciphertext.every((byte) => byte === 0),
    ).toBe(true);
    const welcome = await bob.provider.prepareWelcome({
      joinState: join.localState,
      publicResult: add.publicResult,
    });
    expect(
      bob.sealedSnapshots.at(-2)?.ciphertext.every((byte) => byte === 0),
    ).toBe(true);
    expect(
      bob.sealedSnapshots.at(-1)?.ciphertext.some((byte) => byte !== 0),
    ).toBe(true);
    expect(welcome.snapshot.ciphertext.some((byte) => byte !== 0)).toBe(true);
    for (const buffers of [
      alice.sealedInputs,
      alice.openedOutputs,
      bob.sealedInputs,
      bob.openedOutputs,
    ]) {
      expect(buffers.length).toBeGreaterThan(0);
      expect(
        buffers.every((bytes) => bytes.every((byte) => byte === 0)),
      ).toBe(true);
    }
  }, 60_000);

  test("closes decoded ts-mls state after each public operation", async () => {
    const fixture = deviceFixture("alice-state-close", 0xa4, 79);
    const domainId = cryptoDomainId("domain-state-close");
    const active = await fixture.provider.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const plaintext = fixture.vault.open(active, {
      providerId: fixture.provider.id,
      domainId,
      revision: domainEpoch(0),
      snapshotKind: "active",
    });
    expect(plaintext).not.toBeNull();
    const groupFrameOffset = stateOffsets(plaintext!).groupState;
    const encodedState = plaintext!.slice(
      groupFrameOffset + 4,
      afterFrame(plaintext!, groupFrameOffset),
    );
    const expectedStateHex = bytesHex(encodedState);
    plaintext!.fill(0);

    const wipedStateFrames: Uint8Array[] = [];
    const originalFill = Uint8Array.prototype.fill;
    Uint8Array.prototype.fill = function (
      ...args: Parameters<Uint8Array["fill"]>
    ): Uint8Array {
      if (args[0] === 0 && bytesHex(this) === expectedStateHex) {
        wipedStateFrames.push(Uint8Array.from(this));
      }
      return originalFill.apply(this, args);
    };
    try {
      expect(fixture.provider.publicHead(active).domainId).toBe(domainId);
      fixture.provider.publicRoster(active);
      await fixture.provider.exportDomainRoots(active);
    } finally {
      Uint8Array.prototype.fill = originalFill;
      encodedState.fill(0);
    }

    expect(wipedStateFrames).toHaveLength(3);
  }, 60_000);

  test("cleans the first secret resource when a second acquisition fails", async () => {
    const alice = deviceFixture("alice-acquisition-cleanup", 0xa5, 84);
    const bob = deviceFixture("bob-acquisition-cleanup", 0xb5, 85);
    const domainId = cryptoDomainId("domain-acquisition-cleanup");
    const active = await alice.provider.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const join = await bob.provider.createJoinRequest({
      domainId,
      humanId: humanId("bob"),
      expectedHead: alice.provider.publicHead(active),
    });
    const add = await alice.provider.prepareAdd({
      active,
      joinRequest: join.publicResult,
    });
    const welcome = await bob.provider.prepareWelcome({
      joinState: join.localState,
      publicResult: add.publicResult,
    });
    const tamperedCiphertext = welcome.snapshot.ciphertext.slice();
    tamperedCiphertext[tamperedCiphertext.length - 1] =
      tamperedCiphertext[tamperedCiphertext.length - 1]! ^ 1;
    const tamperedWelcome = {
      ...welcome,
      snapshot: {
        ...welcome.snapshot,
        ciphertext: tamperedCiphertext,
      } as SealedProviderStateV2,
    } as typeof welcome;
    const tamperedPrepared = {
      ...add,
      localCandidate: {
        ...add.localCandidate,
        snapshot: tamperedWelcome.snapshot,
      } as typeof add.localCandidate,
    };

    const activePlaintext = alice.vault.open(active, {
      providerId: alice.provider.id,
      domainId,
      revision: active.revision,
      snapshotKind: "active",
    })!;
    const groupFrameOffset = stateOffsets(activePlaintext).groupState;
    const activeFrameHex = bytesHex(activePlaintext.slice(
      groupFrameOffset + 4,
      afterFrame(activePlaintext, groupFrameOffset),
    ));
    activePlaintext.fill(0);

    const joinPlaintext = bob.vault.open(join.localState, {
      providerId: bob.provider.id,
      domainId,
      revision: join.localState.revision,
      snapshotKind: "candidate",
    })!;
    const privateKeyHexes = joinPrivateKeyFrames(joinPlaintext).map(bytesHex);
    joinPlaintext.fill(0);

    let activeStateWipes = 0;
    const joinSecretWipes = new Map(
      privateKeyHexes.map((value) => [value, 0]),
    );
    const originalFill = Uint8Array.prototype.fill;
    Uint8Array.prototype.fill = function (
      ...args: Parameters<Uint8Array["fill"]>
    ): Uint8Array {
      if (args[0] === 0) {
        const value = bytesHex(this);
        if (value === activeFrameHex) activeStateWipes += 1;
        if (joinSecretWipes.has(value)) {
          joinSecretWipes.set(value, joinSecretWipes.get(value)! + 1);
        }
      }
      return originalFill.apply(this, args);
    };
    try {
      let validationFailure: unknown;
      try {
        await alice.provider.validatePreparedCandidate({
          active,
          prepared: tamperedPrepared,
        });
      } catch (error) {
        validationFailure = error;
      }
      expect(validationFailure).toBeInstanceOf(Error);
      expect(() =>
        bob.provider.activateWelcome({
          candidate: tamperedWelcome,
          joinState: join.localState,
        })
      ).toThrow();
      expect(() =>
        bob.provider.abortWelcome({
          candidate: tamperedWelcome,
          joinState: join.localState,
        })
      ).toThrow();
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }

    expect(activeStateWipes).toBe(1);
    expect([...joinSecretWipes.values()]).toEqual([2, 2, 2]);
  }, 60_000);

  test("exports detached roots and rejects every operation after local removal", async () => {
    const alice = deviceProvider("alice-export", 0xa1, 75);
    const bob = deviceProvider("bob-export", 0xb2, 76);
    const domainId = cryptoDomainId("domain-export");
    let aliceActive = await alice.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const roots = await alice.exportDomainRoots(aliceActive);
    const expectedHuman = roots.human.slice();
    const expectedAi = roots.ai.slice();
    roots.human.fill(0);
    roots.ai.fill(0);
    expect(await alice.exportDomainRoots(aliceActive)).toEqual({
      human: expectedHuman,
      ai: expectedAi,
    });

    const join = await bob.createJoinRequest({
      domainId,
      humanId: humanId("bob"),
      expectedHead: alice.publicHead(aliceActive),
    });
    const add = await alice.prepareAdd({
      active: aliceActive,
      joinRequest: join.publicResult,
    });
    const bobCandidate = await bob.prepareWelcome({
      joinState: join.localState,
      publicResult: add.publicResult,
    });
    aliceActive = alice.applyCandidate({
      active: aliceActive,
      candidate: add.localCandidate,
    }).active;
    let bobActive = bob.activateWelcome({
      candidate: bobCandidate,
      joinState: join.localState,
    }).active;
    const remove = await alice.prepareRemove({
      active: aliceActive,
      removedDeviceId: cryptoDeviceId("bob-export"),
    });
    const incoming = await bob.prepareIncoming({
      active: bobActive,
      publicResult: remove.publicResult,
    });
    bobActive = bob.applyCandidate({
      active: bobActive,
      candidate: incoming,
    }).active;
    expect(bob.exportDomainRoots(bobActive)).rejects.toThrow(
      "Removed MLS device cannot export the current Domain roots",
    );
    expect(bob.prepareCommit({ active: bobActive })).rejects.toThrow(
      "Removed",
    );
    expect(
      bob.prepareRemove({
        active: bobActive,
        removedDeviceId: cryptoDeviceId("alice-export"),
      }),
    ).rejects.toThrow("Removed");
  }, 60_000);
});
