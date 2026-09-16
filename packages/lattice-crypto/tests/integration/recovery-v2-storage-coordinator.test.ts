import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  seededRng,
} from "../../src/crypto/index.ts";
import {
  recoveryKeyGeneration,
  recoveryPublicKeyDigest,
} from "../../src/format/recovery-v2.ts";
import {
  HumanRecoveryArchivePersistenceOutcomeUnknownV2,
  persistPublishedHumanRecoveryArchiveV2,
  publishHumanRecoveryArchiveV2,
} from "../../src/recovery/human-archive-v2.ts";
import {
  InMemoryV2Store,
  type OpaqueRecoveryPackageRecordV2,
  type RecoveryArchiveStorageExpectationV2,
  type RecoveryArchiveWireRecordV2,
} from "../../src/storage/v2-store.ts";
import {
  cryptoDeviceId,
  humanId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

async function publication(
  seed: number,
  generation: number,
  overrides: {
    readonly crypto?: LatticeCrypto;
    readonly recoveryKeyId?: string;
    readonly issuerDeviceId?: string;
  } = {},
) {
  const crypto = overrides.crypto
    ?? new LatticeCrypto(seededRng(seed));
  const recovery = await crypto.generateEncryptionKeyPair();
  const issuer = crypto.generateSigningKeyPair();
  const human = humanId("alice");
  const recoveryKeyId =
    overrides.recoveryKeyId ?? `recovery-${generation}`;
  const issuerDeviceId = cryptoDeviceId(
    overrides.issuerDeviceId ?? "alice-phone",
  );
  const trustedRecoveryKey = {
    humanId: human,
    recoveryKeyId,
    recoveryGeneration: recoveryKeyGeneration(generation),
    publicKeyDigest: recoveryPublicKeyDigest(recovery.publicKey),
  };
  const prepared = await publishHumanRecoveryArchiveV2({
    crypto,
    humanId: human,
    recoveryKeyId,
    recoveryGeneration: recoveryKeyGeneration(generation),
    recoveryPublicKey: recovery.publicKey,
    resolveTrustedCurrentRecoveryKey: () => trustedRecoveryKey,
    issuerDeviceId,
    createdAt: unixTimestamp(10_000 + generation),
    sources: [],
    issuerSigningPrivateKey: issuer.privateKey,
    resolveIssuerDevice: () => issuer.publicKey,
  });
  return {
    crypto,
    prepared,
    trustedRecoveryKey,
    issuer,
    issuerDeviceId,
    recovery,
  };
}

function persistenceInput(
  state: Awaited<ReturnType<typeof publication>>,
  storage: InMemoryV2Store | {
    getRecoveryArchive: InMemoryV2Store["getRecoveryArchive"];
    compareAndSwapRecoveryArchive:
      InMemoryV2Store["compareAndSwapRecoveryArchive"];
  },
) {
  return {
    crypto: state.crypto,
    storage,
    prepared: state.prepared,
    resolveTrustedCurrentRecoveryKey: () => state.trustedRecoveryKey,
    resolveIssuerDevice: () => state.issuer.publicKey,
  };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

async function expectRejection(
  operation: Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(message);
    return;
  }
  throw new Error(`Expected rejection containing: ${message}`);
}

describe("Human recovery archive storage coordinator", () => {
  test("validates persistence inputs and prepared publication shape exactly", async () => {
    const state = await publication(0x225_ad, 1);
    const store = new InMemoryV2Store();
    const input = persistenceInput(state, store);

    await expectRejection(persistPublishedHumanRecoveryArchiveV2({
      ...input,
      unexpected: true,
    } as never),
      "Human recovery archive persistence input contains unknown field unexpected",
    );
    await expectRejection(persistPublishedHumanRecoveryArchiveV2({
      ...input,
      resolveTrustedCurrentRecoveryKey: null as never,
    }),
      "Trusted current recovery-key resolver is required",
    );
    await expectRejection(persistPublishedHumanRecoveryArchiveV2({
      ...input,
      resolveIssuerDevice: null as never,
    }),
      "Current Human recovery issuer resolver is required",
    );
    await expectRejection(persistPublishedHumanRecoveryArchiveV2({
      ...input,
      prepared: {
        ...state.prepared,
        unexpected: true,
      } as never,
    }),
      "Human recovery archive publication contains unknown field unexpected",
    );

    state.prepared.archive.signature[0] =
      state.prepared.archive.signature[0]! ^ 1;
    await expectRejection(
      persistPublishedHumanRecoveryArchiveV2(input),
      "Human recovery archive publication is untrusted or mutated",
    );
  });

  test("rejects malformed durable recovery records before authorization or CAS", async () => {
    const state = await publication(0x225_ae, 1);
    let authorizationCalls = 0;
    let casCalls = 0;
    const run = (wire: unknown) => persistPublishedHumanRecoveryArchiveV2({
      ...persistenceInput(state, {
        getRecoveryArchive: async () => wire as never,
        compareAndSwapRecoveryArchive: async () => {
          casCalls += 1;
          return "applied";
        },
      }),
      resolveTrustedCurrentRecoveryKey: () => {
        authorizationCalls += 1;
        return state.trustedRecoveryKey;
      },
    });
    const canonicalWire = {
      humanId: state.prepared.archive.humanId,
      recoveryKeyGeneration: state.prepared.archive.recoveryGeneration,
      archiveBytes: state.prepared.archiveBytes,
    };

    await expectRejection(run({
      ...canonicalWire,
      unexpected: true,
    }),
      "Stored Human recovery archive contains unknown field unexpected",
    );
    await expectRejection(run({
      ...canonicalWire,
      archiveBytes: "not-bytes",
    }), "Stored Human recovery archive must be bytes");
    await expectRejection(run({
      ...canonicalWire,
      humanId: "mallory",
    }),
      "Stored Human recovery archive coordinates do not match its canonical bytes",
    );
    await expectRejection(run({
      ...canonicalWire,
      recoveryKeyGeneration: recoveryKeyGeneration(2),
    }),
      "Stored Human recovery archive coordinates do not match its canonical bytes",
    );
    expect(authorizationCalls).toBe(0);
    expect(casCalls).toBe(0);
  });

  test("persists genesis, exact replay, rotation, and rejects a fork", async () => {
    const store = new InMemoryV2Store();
    const first = await publication(0x225_a1, 1);
    expect(await persistPublishedHumanRecoveryArchiveV2(
      persistenceInput(first, store),
    )).toBe("applied");
    expect(await persistPublishedHumanRecoveryArchiveV2(
      persistenceInput(first, store),
    )).toBe("duplicate");

    const fork = await publication(0x225_a2, 1, {
      recoveryKeyId: first.trustedRecoveryKey.recoveryKeyId,
    });
    expect(await persistPublishedHumanRecoveryArchiveV2(
      persistenceInput(fork, store),
    )).toBe("stale");

    const second = await publication(0x225_a3, 2);
    expect(await persistPublishedHumanRecoveryArchiveV2(
      persistenceInput(second, store),
    )).toBe("applied");
    expect((await store.getRecoveryArchive("alice"))
      ?.recoveryKeyGeneration).toBe(2);
  });

  test("fresh recovery rotation or issuer revocation fails before CAS", async () => {
    const state = await publication(0x225_a4, 1);
    const replacementRecovery =
      await state.crypto.generateEncryptionKeyPair();
    let casCalls = 0;
    const storage = {
      getRecoveryArchive: async () => null,
      compareAndSwapRecoveryArchive: async () => {
        casCalls += 1;
        return "applied" as const;
      },
    };
    await expectRejection(persistPublishedHumanRecoveryArchiveV2({
      ...persistenceInput(state, storage),
      resolveTrustedCurrentRecoveryKey: () => ({
        ...state.trustedRecoveryKey,
        recoveryKeyId: "other-recovery-key",
      }),
    }), "trusted current recovery key");
    await expectRejection(persistPublishedHumanRecoveryArchiveV2({
      ...persistenceInput(state, storage),
      resolveTrustedCurrentRecoveryKey: () => ({
        ...state.trustedRecoveryKey,
        recoveryGeneration: recoveryKeyGeneration(2),
      }),
    }), "trusted current recovery key");
    await expectRejection(persistPublishedHumanRecoveryArchiveV2({
      ...persistenceInput(state, storage),
      resolveTrustedCurrentRecoveryKey: () => ({
        ...state.trustedRecoveryKey,
        publicKeyDigest: recoveryPublicKeyDigest(
          replacementRecovery.publicKey,
        ),
      }),
    }), "trusted current recovery key");
    await expectRejection(persistPublishedHumanRecoveryArchiveV2({
      ...persistenceInput(state, storage),
      resolveIssuerDevice: (context) => {
        expect(context.purpose).toBe("human-recovery-archive");
        return null;
      },
    }), "issuer is not currently authorized");
    await expectRejection(persistPublishedHumanRecoveryArchiveV2({
      ...persistenceInput(state, storage),
      resolveIssuerDevice: () => new Uint8Array(31),
    }),
      "Human recovery archive issuer signing public key must contain exactly 32 bytes",
    );
    const otherIssuer = state.crypto.generateSigningKeyPair();
    await expectRejection(persistPublishedHumanRecoveryArchiveV2({
      ...persistenceInput(state, storage),
      resolveIssuerDevice: () => otherIssuer.publicKey,
    }),
      "Human recovery archive signature is invalid for the current issuer",
    );
    expect(casCalls).toBe(0);
  });

  test("rejects missing generations and accepts every valid adapter CAS status", async () => {
    const missingGenesis = await publication(0x225_af, 2);
    let missingGenesisCasCalls = 0;
    expect(await persistPublishedHumanRecoveryArchiveV2({
      ...persistenceInput(missingGenesis, {
        getRecoveryArchive: async () => null,
        compareAndSwapRecoveryArchive: async () => {
          missingGenesisCasCalls += 1;
          return "applied";
        },
      }),
    })).toBe("stale");
    expect(missingGenesisCasCalls).toBe(0);

    const first = await publication(0x225_b0, 1);
    const store = new InMemoryV2Store();
    expect(await persistPublishedHumanRecoveryArchiveV2(
      persistenceInput(first, store),
    )).toBe("applied");
    const skipped = await publication(0x225_b1, 3);
    const current = await store.getRecoveryArchive("alice");
    let skippedCasCalls = 0;
    expect(await persistPublishedHumanRecoveryArchiveV2({
      ...persistenceInput(skipped, {
        getRecoveryArchive: async () => current,
        compareAndSwapRecoveryArchive: async () => {
          skippedCasCalls += 1;
          return "stale";
        },
      }),
    })).toBe("stale");
    expect(skippedCasCalls).toBe(0);

    for (const status of ["applied", "duplicate", "stale"] as const) {
      const genesis = await publication(
        0x225_b2 + ["applied", "duplicate", "stale"].indexOf(status),
        1,
      );
      expect(await persistPublishedHumanRecoveryArchiveV2({
        ...persistenceInput(genesis, {
          getRecoveryArchive: async () => null,
          compareAndSwapRecoveryArchive: async () => status,
        }),
      })).toBe(status);
    }
  });

  test("orders the final fresh authorization check directly before CAS", async () => {
    const state = await publication(0x225_ab, 1);
    const events: string[] = [];
    expect(await persistPublishedHumanRecoveryArchiveV2({
      crypto: state.crypto,
      prepared: state.prepared,
      storage: {
        getRecoveryArchive: async () => {
          events.push("read");
          return null;
        },
        compareAndSwapRecoveryArchive: async () => {
          events.push("cas");
          return "applied";
        },
      },
      resolveTrustedCurrentRecoveryKey: () => {
        events.push("recovery-authorization");
        return state.trustedRecoveryKey;
      },
      resolveIssuerDevice: () => {
        events.push("issuer-authorization");
        return state.issuer.publicKey;
      },
    })).toBe("applied");
    expect(events).toEqual([
      "read",
      "recovery-authorization",
      "issuer-authorization",
      "cas",
    ]);
  });

  test("fails closed on an invalid adapter CAS status without retrying", async () => {
    const state = await publication(0x225_ac, 1);
    let casCalls = 0;
    const storage = {
      getRecoveryArchive: async () => null,
      compareAndSwapRecoveryArchive: async () => {
        casCalls += 1;
        return "surprise";
      },
    };
    expect(persistPublishedHumanRecoveryArchiveV2({
      ...persistenceInput(state, storage as never),
    })).rejects.toThrow(
      "Human recovery archive storage returned an invalid CAS status",
    );
    expect(casCalls).toBe(1);
  });

  test("wraps before/after-commit throws, never retries, and explicit retry deduplicates", async () => {
    const before = await publication(0x225_a5, 1);
    let beforeCalls = 0;
    const beforeCause = new Error("failed before recovery CAS");
    const beforeError = await persistPublishedHumanRecoveryArchiveV2({
      ...persistenceInput(before, {
        getRecoveryArchive: async () => null,
        compareAndSwapRecoveryArchive: async () => {
          beforeCalls += 1;
          throw beforeCause;
        },
      }),
    }).catch((cause: unknown) => cause);
    expect(beforeError).toBeInstanceOf(
      HumanRecoveryArchivePersistenceOutcomeUnknownV2,
    );
    expect((beforeError as Error).name).toBe(
      "HumanRecoveryArchivePersistenceOutcomeUnknownV2",
    );
    expect((beforeError as Error).message).toBe(
      "Human recovery archive storage outcome is ambiguous; retry must be explicit",
    );
    expect((beforeError as Error).cause).toBe(beforeCause);
    expect(beforeCalls).toBe(1);

    const after = await publication(0x225_a6, 1);
    const backing = new InMemoryV2Store();
    let afterCalls = 0;
    const afterCause = new Error("lost recovery CAS response");
    const afterStorage = {
      getRecoveryArchive: backing.getRecoveryArchive.bind(backing),
      async compareAndSwapRecoveryArchive(
        expected: Parameters<
          InMemoryV2Store["compareAndSwapRecoveryArchive"]
        >[0],
        intended: OpaqueRecoveryPackageRecordV2,
      ) {
        afterCalls += 1;
        await backing.compareAndSwapRecoveryArchive(expected, intended);
        throw afterCause;
      },
    };
    const afterError = await persistPublishedHumanRecoveryArchiveV2({
      ...persistenceInput(after, afterStorage),
    }).catch((cause: unknown) => cause);
    expect(afterError).toBeInstanceOf(
      HumanRecoveryArchivePersistenceOutcomeUnknownV2,
    );
    expect((afterError as Error).cause).toBe(afterCause);
    expect(afterCalls).toBe(1);
    expect(await persistPublishedHumanRecoveryArchiveV2({
      ...persistenceInput(after, afterStorage),
    })).toBe("duplicate");
    expect(afterCalls).toBe(1);
  });

  test("rejects forged or mutated publication and stores only canonical opaque archive bytes", async () => {
    const state = await publication(0x225_a7, 1);
    const store = new InMemoryV2Store();
    expect(persistPublishedHumanRecoveryArchiveV2({
      ...persistenceInput(state, store),
      prepared: structuredClone(state.prepared),
    })).rejects.toThrow("publication is untrusted or mutated");

    state.prepared.archiveBytes[0] =
      state.prepared.archiveBytes[0]! ^ 0xff;
    expect(persistPublishedHumanRecoveryArchiveV2(
      persistenceInput(state, store),
    )).rejects.toThrow("publication is untrusted or mutated");

    const clean = await publication(0x225_a8, 1);
    let captured: OpaqueRecoveryPackageRecordV2 | null = null;
    await persistPublishedHumanRecoveryArchiveV2({
      ...persistenceInput(clean, {
        getRecoveryArchive: async () => null,
        compareAndSwapRecoveryArchive: async (_expected, intended) => {
          captured = intended;
          return "applied";
        },
      }),
    });
    expect(Object.keys(captured ?? {})).toEqual([
      "humanId",
      "recoveryKeyGeneration",
      "archiveBytes",
    ]);
    expect(JSON.stringify(captured)).not.toContain("privateKey");
    expect(JSON.stringify(captured)).not.toContain("recoveryPublicKey");
  });

  test("survives restart through a raw durable adapter exposed at the package root", async () => {
    const first = await publication(0x225_a9, 1);
    let durable: RecoveryArchiveWireRecordV2 | null = null;
    let casCalls = 0;
    const adapter = {
      getRecoveryArchive: async () =>
        durable === null ? null : structuredClone(durable),
      async compareAndSwapRecoveryArchive(
        expected: RecoveryArchiveStorageExpectationV2 | null,
        intended: OpaqueRecoveryPackageRecordV2,
      ) {
        casCalls += 1;
        if (
          durable !== null
          && durable.recoveryKeyGeneration
            === intended.recoveryKeyGeneration
          && equalBytes(
            durable.archiveBytes,
            intended.archiveBytes.ciphertext,
          )
        ) {
          return "duplicate" as const;
        }
        if (expected === null) {
          if (durable !== null) return "stale" as const;
        } else if (
          durable === null
          || durable.humanId !== expected.humanId
          || durable.recoveryKeyGeneration
            !== expected.recoveryKeyGeneration
          || !equalBytes(
            first.crypto.hash(durable.archiveBytes),
            expected.archiveHash,
          )
        ) {
          return "stale" as const;
        }
        durable = {
          humanId: intended.humanId,
          recoveryKeyGeneration: intended.recoveryKeyGeneration,
          archiveBytes: intended.archiveBytes.ciphertext.slice(),
        };
        return "applied" as const;
      },
    };

    expect(await persistPublishedHumanRecoveryArchiveV2(
      persistenceInput(first, adapter),
    )).toBe("applied");
    expect(await persistPublishedHumanRecoveryArchiveV2(
      persistenceInput(first, adapter),
    )).toBe("duplicate");
    expect(casCalls).toBe(1);

    // A detached read models a new adapter/process with no in-memory brands.
    const restarted = structuredClone(durable);
    durable = restarted;
    const second = await publication(0x225_aa, 2);
    expect(await persistPublishedHumanRecoveryArchiveV2(
      persistenceInput(second, adapter),
    )).toBe("applied");
    expect((await adapter.getRecoveryArchive())
      ?.recoveryKeyGeneration).toBe(2);
    expect(casCalls).toBe(2);
  });
});
