import { describe, expect, test } from "bun:test";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import { DeviceProviderStateVaultV2 } from "../../src/device/v2-state-vault.ts";
import {
  concatV2,
  encodeU64,
  frame,
  frameText,
} from "../../src/format/v2-primitives.ts";
import { DummyV2GroupProvider } from "../../src/group/v2-dummy.ts";
import {
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";

function fixture(device: string, seed: number) {
  const crypto = new LatticeCrypto(seededRng(seed));
  const vault = DeviceProviderStateVaultV2.fromKey(
    crypto,
    cryptoDeviceId(device),
    new Uint8Array(32).fill(seed),
  );
  return {
    crypto,
    provider: new DummyV2GroupProvider(crypto, vault),
    vault,
  };
}

function provider(device: string, seed: number): DummyV2GroupProvider {
  return fixture(device, seed).provider;
}

describe("dummy v2 membership semantics", () => {
  test("adds and removes authenticated devices with shared roots and exclusion", async () => {
    const alice = provider("alice-phone", 41);
    const bob = provider("bob-phone", 42);
    let aliceActive = alice.bootstrapSemanticForTesting({
      domainId: cryptoDomainId("domain-ab"),
      epoch: domainEpoch(0),
      exporterSecret: new Uint8Array(32).fill(0x51),
      roster: [{
        humanId: humanId("alice"),
        deviceId: cryptoDeviceId("alice-phone"),
      }],
    });
    let bobActive = bob.bootstrapSemanticForTesting(
      alice.exportSemanticBootstrapForTesting(aliceActive),
    );
    const initialRoster = alice.publicRoster(aliceActive);
    const initialRoots = await alice.exportDomainRoots(aliceActive);

    const add = await alice.prepareAdd({
      active: aliceActive,
      humanId: humanId("bob"),
      deviceId: cryptoDeviceId("bob-phone"),
    });
    const bobAdd = await bob.prepareIncoming({
      active: bobActive,
      publicResult: add.publicResult,
    });
    aliceActive = alice.applyCandidate({
      active: aliceActive,
      candidate: add.localCandidate,
    }).active;
    bobActive = bob.applyCandidate({
      active: bobActive,
      candidate: bobAdd,
    }).active;

    expect(alice.publicRoster(aliceActive)).not.toEqual(initialRoster);
    expect(await alice.exportDomainRoots(aliceActive)).toEqual(
      await bob.exportDomainRoots(bobActive),
    );
    expect(await alice.exportDomainRoots(aliceActive)).not.toEqual(
      initialRoots,
    );

    const beforeRemoveRoots = await bob.exportDomainRoots(bobActive);
    const remove = await alice.prepareRemove({
      active: aliceActive,
      removedDeviceId: cryptoDeviceId("bob-phone"),
    });
    const bobRemove = await bob.prepareIncoming({
      active: bobActive,
      publicResult: remove.publicResult,
    });
    aliceActive = alice.applyCandidate({
      active: aliceActive,
      candidate: remove.localCandidate,
    }).active;
    bobActive = bob.applyCandidate({
      active: bobActive,
      candidate: bobRemove,
    }).active;

    expect(Number(alice.publicHead(aliceActive).epoch)).toBe(2);
    expect(await alice.exportDomainRoots(aliceActive)).not.toEqual(
      beforeRemoveRoots,
    );
    expect(bob.exportDomainRoots(bobActive)).rejects.toThrow(
      "Removed dummy device",
    );
    expect(
      alice.publicRoster(aliceActive),
    ).toEqual(initialRoster);
  });

  test("accepts both state versions and rejects unsupported versions and removed markers exactly", () => {
    const state = fixture("alice-phone", 43);
    const legacy = state.provider.bootstrapForTesting({
      domainId: cryptoDomainId("domain-version"),
      epoch: domainEpoch(3),
      exporterSecret: new Uint8Array(32).fill(0x31),
    });
    const semantic = state.provider.bootstrapSemanticForTesting({
      domainId: cryptoDomainId("domain-version"),
      epoch: domainEpoch(3),
      exporterSecret: new Uint8Array(32).fill(0x31),
      roster: [{
        humanId: humanId("alice"),
        deviceId: cryptoDeviceId("alice-phone"),
      }],
    });
    expect(state.provider.publicHead(legacy).epoch).toBe(domainEpoch(3));
    expect(state.provider.publicHead(semantic).epoch).toBe(domainEpoch(3));

    const coordinates = {
      providerId: semantic.providerId,
      domainId: semantic.domainId,
      revision: semantic.revision,
      snapshotKind: "active" as const,
    };
    const semanticPlaintext = state.vault.open(semantic, coordinates)!;
    const unsupported = semanticPlaintext.slice();
    new DataView(unsupported.buffer).setUint32(0, 99);
    expect(() =>
      state.provider.publicHead(state.vault.seal(coordinates, unsupported))
    ).toThrow("Unsupported dummy provider state version 99");

    const invalidRemoved = semanticPlaintext.slice();
    new DataView(invalidRemoved.buffer).setUint32(
      invalidRemoved.length - 4,
      2,
    );
    expect(() =>
      state.provider.publicHead(state.vault.seal(coordinates, invalidRemoved))
    ).toThrow("Dummy provider removed marker is invalid");
  });

  test("rejects duplicate devices and enforces the exact Human roster limit", () => {
    const state = fixture("alice-phone", 44);
    const base = {
      domainId: cryptoDomainId("domain-limits"),
      epoch: domainEpoch(0),
      exporterSecret: new Uint8Array(32).fill(0x41),
    };
    expect(() =>
      state.provider.bootstrapSemanticForTesting({
        ...base,
        roster: [
          {
            humanId: humanId("alice"),
            deviceId: cryptoDeviceId("shared-device"),
          },
          {
            humanId: humanId("bob"),
            deviceId: cryptoDeviceId("shared-device"),
          },
        ],
      })
    ).toThrow("Dummy provider roster contains duplicate devices");

    const rosterAtLimit = Array.from(
      { length: V2_LIMITS.humanParticipantsPerDomain },
      (_, index) => ({
        humanId: humanId(`human-${index}`),
        deviceId: cryptoDeviceId(`device-${index}`),
      }),
    );
    expect(() =>
      state.provider.bootstrapSemanticForTesting({
        ...base,
        roster: rosterAtLimit,
      })
    ).not.toThrow();
    expect(() =>
      state.provider.bootstrapSemanticForTesting({
        ...base,
        roster: [
          ...rosterAtLimit,
          {
            humanId: humanId("human-over-limit"),
            deviceId: cryptoDeviceId("device-over-limit"),
          },
        ],
      })
    ).toThrow("Dummy provider roster exceeds the Human limit");
  });

  test("owns custom semantic hashes and exported bootstrap secrets", () => {
    const state = fixture("alice-phone", 45);
    const base = {
      domainId: cryptoDomainId("domain-detachment"),
      epoch: domainEpoch(4),
      roster: [{
        humanId: humanId("alice"),
        deviceId: cryptoDeviceId("alice-phone"),
      }],
    };
    expect(() =>
      state.provider.bootstrapSemanticForTesting({
        ...base,
        exporterSecret: new Uint8Array(31),
      })
    ).toThrow("Dummy exporter secret must be exactly 32 bytes");
    expect(() =>
      state.provider.bootstrapSemanticForTesting({
        ...base,
        exporterSecret: new Uint8Array(32),
        stateHash: new Uint8Array(31),
      })
    ).toThrow("Dummy semantic state hash must be exactly 32 bytes");

    const customHash = new Uint8Array(32).fill(0x52);
    const active = state.provider.bootstrapSemanticForTesting({
      ...base,
      exporterSecret: new Uint8Array(32).fill(0x51),
      stateHash: customHash,
    });
    expect(state.provider.publicHead(active).stateHash).toEqual(customHash);
    customHash.fill(0xff);
    expect(state.provider.publicHead(active).stateHash).toEqual(
      new Uint8Array(32).fill(0x52),
    );

    const exported = state.provider.exportSemanticBootstrapForTesting(active);
    const exportedSecret = exported.exporterSecret.slice();
    const exportedHash = exported.stateHash.slice();
    exported.exporterSecret.fill(0);
    exported.stateHash.fill(0);
    const reexported =
      state.provider.exportSemanticBootstrapForTesting(active);
    expect(reexported.exporterSecret).toEqual(exportedSecret);
    expect(reexported.stateHash).toEqual(exportedHash);
    expect(reexported.exporterSecret).not.toBe(exported.exporterSecret);
    expect(reexported.stateHash).not.toBe(exported.stateHash);
  });

  test("selects the local update actor and rejects duplicate adds exactly", async () => {
    const state = fixture("alice-phone", 46);
    const active = state.provider.bootstrapSemanticForTesting({
      domainId: cryptoDomainId("domain-actors"),
      epoch: domainEpoch(0),
      exporterSecret: new Uint8Array(32).fill(0x61),
      roster: [
        {
          humanId: humanId("bob"),
          deviceId: cryptoDeviceId("bob-phone"),
        },
        {
          humanId: humanId("alice"),
          deviceId: cryptoDeviceId("alice-phone"),
        },
      ],
    });
    const update = await state.provider.prepareCommit({ active });
    expect(update.publicResult.operation).toBe("update");
    expect(update.publicResult.targetHumanId).toBe(humanId("alice"));
    expect(update.publicResult.targetDeviceId).toBe(
      cryptoDeviceId("alice-phone"),
    );

    for (const human of ["alice", "mallory"]) {
      expect(
        state.provider.prepareAdd({
          active,
          humanId: humanId(human),
          deviceId: cryptoDeviceId("alice-phone"),
        }),
      ).rejects.toThrow(
        "Dummy add device already exists in the authenticated roster",
      );
    }

    const originalRandom = state.crypto.randomBytes.bind(state.crypto);
    state.crypto.randomBytes = () => {
      throw null as unknown as Error;
    };
    expect(
      state.provider.prepareAdd({
        active,
        humanId: humanId("charlie"),
        deviceId: cryptoDeviceId("charlie-phone"),
      }),
    ).rejects.toThrow("Unable to prepare dummy add");
    state.crypto.randomBytes = originalRandom;
  });

  test("rejects missing and final removals and binds removal to the exact Human", async () => {
    const state = fixture("alice-phone", 47);
    const oneDevice = state.provider.bootstrapSemanticForTesting({
      domainId: cryptoDomainId("domain-remove"),
      epoch: domainEpoch(0),
      exporterSecret: new Uint8Array(32).fill(0x71),
      roster: [{
        humanId: humanId("alice"),
        deviceId: cryptoDeviceId("alice-phone"),
      }],
    });
    expect(
      state.provider.prepareRemove({
        active: oneDevice,
        removedDeviceId: cryptoDeviceId("missing-phone"),
      }),
    ).rejects.toThrow(
      "Removed dummy device is not in the authenticated roster",
    );
    expect(
      state.provider.prepareRemove({
        active: oneDevice,
        removedDeviceId: cryptoDeviceId("alice-phone"),
      }),
    ).rejects.toThrow(
      "Final dummy device removal requires explicit Domain rebootstrap",
    );

    const twoDevices = state.provider.bootstrapSemanticForTesting({
      domainId: cryptoDomainId("domain-remove"),
      epoch: domainEpoch(0),
      exporterSecret: new Uint8Array(32).fill(0x71),
      roster: [
        {
          humanId: humanId("alice"),
          deviceId: cryptoDeviceId("alice-phone"),
        },
        {
          humanId: humanId("bob"),
          deviceId: cryptoDeviceId("bob-phone"),
        },
      ],
    });
    const remove = await state.provider.prepareRemove({
      active: twoDevices,
      removedDeviceId: cryptoDeviceId("bob-phone"),
    });
    expect(remove.publicResult.operation).toBe("remove");
    expect(remove.publicResult.targetHumanId).toBe(humanId("bob"));
    expect(remove.publicResult.targetDeviceId).toBe(
      cryptoDeviceId("bob-phone"),
    );

    const originalRandom = state.crypto.randomBytes.bind(state.crypto);
    state.crypto.randomBytes = () => {
      throw null as unknown as Error;
    };
    expect(
      state.provider.prepareRemove({
        active: twoDevices,
        removedDeviceId: cryptoDeviceId("bob-phone"),
      }),
    ).rejects.toThrow("Unable to prepare dummy remove");
    state.crypto.randomBytes = originalRandom;
  });

  test("requires semantic active membership and blocks a removed device from further transitions", async () => {
    const alice = fixture("alice-phone", 48);
    const legacy = alice.provider.bootstrapForTesting({
      domainId: cryptoDomainId("domain-guards"),
      epoch: domainEpoch(0),
      exporterSecret: new Uint8Array(32).fill(0x81),
    });
    expect(
      alice.provider.prepareAdd({
        active: legacy,
        humanId: humanId("bob"),
        deviceId: cryptoDeviceId("bob-phone"),
      }),
    ).rejects.toThrow(
      "Dummy membership transition requires semantic roster state",
    );
    expect(
      alice.provider.prepareRemove({
        active: legacy,
        removedDeviceId: cryptoDeviceId("alice-phone"),
      }),
    ).rejects.toThrow(
      "Dummy membership transition requires semantic roster state",
    );

    const bob = fixture("bob-phone", 49);
    const bobAbsent = bob.provider.bootstrapSemanticForTesting({
      domainId: cryptoDomainId("domain-guards-absent"),
      epoch: domainEpoch(0),
      exporterSecret: new Uint8Array(32).fill(0x81),
      roster: [{
        humanId: humanId("alice"),
        deviceId: cryptoDeviceId("alice-phone"),
      }],
    });
    expect(bob.provider.exportDomainRoots(bobAbsent)).rejects.toThrow(
      "Removed dummy device cannot export current Domain roots",
    );

    const aliceActive = alice.provider.bootstrapSemanticForTesting({
      domainId: cryptoDomainId("domain-guards"),
      epoch: domainEpoch(0),
      exporterSecret: new Uint8Array(32).fill(0x81),
      roster: [
        {
          humanId: humanId("alice"),
          deviceId: cryptoDeviceId("alice-phone"),
        },
        {
          humanId: humanId("bob"),
          deviceId: cryptoDeviceId("bob-phone"),
        },
      ],
    });
    let bobActive = bob.provider.bootstrapSemanticForTesting(
      alice.provider.exportSemanticBootstrapForTesting(aliceActive),
    );
    const remove = await alice.provider.prepareRemove({
      active: aliceActive,
      removedDeviceId: cryptoDeviceId("bob-phone"),
    });
    const incoming = await bob.provider.prepareIncoming({
      active: bobActive,
      publicResult: remove.publicResult,
    });
    bobActive = bob.provider.applyCandidate({
      active: bobActive,
      candidate: incoming,
    }).active;
    expect(
      bob.provider.prepareAdd({
        active: bobActive,
        humanId: humanId("charlie"),
        deviceId: cryptoDeviceId("charlie-phone"),
      }),
    ).rejects.toThrow(
      "Removed dummy device cannot prepare a membership transition",
    );
    expect(
      bob.provider.prepareRemove({
        active: bobActive,
        removedDeviceId: cryptoDeviceId("alice-phone"),
      }),
    ).rejects.toThrow(
      "Removed dummy device cannot prepare a membership transition",
    );
  });

  test("binds the complete semantic roster into every next state hash", async () => {
    const state = fixture("alice-phone", 50);
    const active = state.provider.bootstrapSemanticForTesting({
      domainId: cryptoDomainId("domain-hash"),
      epoch: domainEpoch(5),
      exporterSecret: new Uint8Array(32).fill(0x91),
      roster: [{
        humanId: humanId("alice"),
        deviceId: cryptoDeviceId("alice-phone"),
      }],
    });
    const expectedHead = state.provider.publicHead(active);
    const prepared = await state.provider.prepareAdd({
      active,
      humanId: humanId("bob"),
      deviceId: cryptoDeviceId("bob-phone"),
    });
    const expectedHash = state.crypto.hash(concatV2(
      frameText("nautilo/lattice-crypto/dummy-provider-next-head/v2"),
      frameText("dummy-v2"),
      frameText(expectedHead.domainId),
      encodeU64(prepared.publicResult.nextHead.epoch),
      frame(expectedHead.stateHash),
      frame(prepared.publicResult.commitBytes),
      frame(prepared.publicResult.rosterBytes),
    ));
    expect(prepared.publicResult.nextHead.stateHash).toEqual(expectedHash);

    const oversized = {
      ...prepared.publicResult,
      rosterBytes:
        new Uint8Array(V2_LIMITS.namespaceKeyringBytes + 1),
    };
    expect(
      state.provider.prepareIncoming({
        active,
        publicResult: oversized,
      }),
    ).rejects.toThrow("Dummy provider public transition is invalid");
  });
});
