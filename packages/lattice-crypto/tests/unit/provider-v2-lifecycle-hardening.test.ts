import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  seededRng,
} from "../../src/crypto/index.ts";
import { DeviceProviderStateVaultV2 } from "../../src/device/v2-state-vault.ts";
import { DummyV2GroupProvider } from "../../src/group/v2-dummy.ts";
import {
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
} from "../../src/v2-types/ids.ts";

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function setup(seed: number, exporterFill: number) {
  const crypto = new LatticeCrypto(seededRng(seed));
  const deviceId = cryptoDeviceId("alice-phone");
  const vault = DeviceProviderStateVaultV2.fromKey(
    crypto,
    deviceId,
    bytes(0xa1),
  );
  const provider = new DummyV2GroupProvider(crypto, vault);
  const active = provider.bootstrapForTesting({
    domainId: cryptoDomainId("domain-ab"),
    epoch: domainEpoch(7),
    exporterSecret: bytes(exporterFill),
  });
  return { active, crypto, deviceId, provider };
}

describe("v2 provider candidate lifecycle hardening", () => {
  test("rejects a candidate retargeted onto a same-epoch fork", async () => {
    const canonical = setup(701, 0x11);
    const fork = setup(702, 0x22);
    const prepared = await canonical.provider.prepareCommit({
      active: canonical.active,
    });
    const retargeted = {
      ...prepared.localCandidate,
      expectedHead: fork.provider.publicHead(fork.active),
    };

    expect(() =>
      fork.provider.applyCandidate({
        active: fork.active,
        candidate: retargeted,
      })
    ).toThrow("sealed candidate");
    expect(Number(fork.provider.publicHead(fork.active).epoch)).toBe(7);
  });

  test("rejects a candidate whose lifecycle identity was rewritten", async () => {
    const setupResult = setup(703, 0x33);
    const prepared = await setupResult.provider.prepareCommit({
      active: setupResult.active,
    });

    expect(() =>
      setupResult.provider.applyCandidate({
        active: setupResult.active,
        candidate: {
          ...prepared.localCandidate,
          candidateId: "candidate_retargeted",
        },
      })
    ).toThrow("sealed candidate");
  });

  test("persists aborted lifecycle without process-local tombstone sets", async () => {
    const first = setup(704, 0x44);
    const prepared = await first.provider.prepareCommit({
      active: first.active,
    });
    expect(first.provider.abortCandidate(prepared.localCandidate).status).toBe(
      "aborted",
    );
    expect(
      prepared.localCandidate.snapshot.ciphertext.some((byte) => byte !== 0),
    ).toBe(true);

    const restarted = new DummyV2GroupProvider(
      first.crypto,
      DeviceProviderStateVaultV2.fromKey(
        first.crypto,
        first.deviceId,
        bytes(0xa1),
      ),
    );
    expect(
      restarted.applyCandidate({
        active: first.active,
        candidate: prepared.localCandidate,
      }).status,
    ).toBe("aborted");
    expect(restarted.abortCandidate(prepared.localCandidate).status).toBe(
      "already-aborted",
    );
  });

  test("persists applied lifecycle for restart-safe abort resolution", async () => {
    const first = setup(705, 0x55);
    const prepared = await first.provider.prepareCommit({
      active: first.active,
    });
    const applied = first.provider.applyCandidate({
      active: first.active,
      candidate: prepared.localCandidate,
    });
    expect(applied.status).toBe("applied");

    const restarted = new DummyV2GroupProvider(
      first.crypto,
      DeviceProviderStateVaultV2.fromKey(
        first.crypto,
        first.deviceId,
        bytes(0xa1),
      ),
    );
    expect(restarted.abortCandidate(prepared.localCandidate).status).toBe(
      "already-applied",
    );
    expect(
      restarted.applyCandidate({
        active: applied.active,
        candidate: prepared.localCandidate,
      }).status,
    ).toBe("duplicate");
  });
});
