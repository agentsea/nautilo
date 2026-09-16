import { describe, expect, test } from "bun:test";
import {
  DeviceProviderStateVault,
  LatticeCrypto,
  OpenMlsGroupProvider,
  accessRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceId,
  restoreSealedProviderState,
} from "@nautilo/lattice-crypto";
import { seededRng } from "@nautilo/lattice-crypto/testing";

import {
  createClientDeviceProfileV3Candidate,
  addClientDomainProviderSnapshot,
  destroyOpenedClientDeviceProfileV3,
  encodeClientDeviceProfileV3,
} from "../../src/client-vault/profile-v3.ts";
import {
  createClientDeviceProfileV4Candidate,
  destroyOpenedClientDeviceProfileV4,
} from "../../src/client-vault/profile-v4.ts";
import {
  withSoleFoundingDeviceHistoricalCommitterV4,
} from "../../src/client-vault/sole-founding-device-historical-committer-v4.ts";
import {
  encodeClientDeviceProfileV2,
  type OpenedClientDeviceProfileV2,
} from "../../src/client-vault/profile-v2.ts";

const DEVICE = "device_sole_founder";
const HUMAN = "human_sole_founder";
const DOMAIN = cryptoDomainId("domain_sole_founder");

async function fixture() {
  const crypto = new LatticeCrypto(seededRng(27_405));
  const signing = crypto.generateSigningKeyPair();
  const encryption = await crypto.generateEncryptionKeyPair();
  const v2: OpenedClientDeviceProfileV2 = Object.freeze({
    formatVersion: 2,
    deviceId: DEVICE,
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey,
    encryptionPrivateKey: encryption.privateKey,
    trustedDeviceRevision: 1,
    trustedHostAuthorizationRevision: 1,
    deliveryHighWatermark: 0,
    keyringDeliveries: Object.freeze([]),
  });
  const v2Bytes = encodeClientDeviceProfileV2(v2);
  const v3 = await createClientDeviceProfileV3Candidate({
    crypto,
    currentProfileBytes: v2Bytes,
    expectedDeviceId: DEVICE,
  });
  const providerVault = DeviceProviderStateVault.fromKey(
    crypto,
    cryptoDeviceId(DEVICE),
    v3.providerStateSealingKey,
  );
  const provider = new OpenMlsGroupProvider(crypto, providerVault);
  const active = await provider.createInitialState({
    domainId: DOMAIN,
    humanId: humanId(HUMAN),
  });
  const head = provider.publicHead(active);
  const withProvider = await addClientDomainProviderSnapshot({
    crypto,
    profile: v3,
    snapshot: active,
    expectedHead: head,
  });
  const v3Bytes = encodeClientDeviceProfileV3(withProvider);
  const profile = await createClientDeviceProfileV4Candidate({
    crypto,
    currentProfileBytes: v3Bytes,
    expectedDeviceId: DEVICE,
  });
  destroyOpenedClientDeviceProfileV3(withProvider);
  destroyOpenedClientDeviceProfileV3(v3);
  v3Bytes.fill(0);
  v2Bytes.fill(0);
  active.ciphertext.fill(0);
  providerVault.destroy();
  return { crypto, signing, profile, head };
}

describe("sole founding-device historical committer v4", () => {
  test("resolves only the exact local genesis committer and wipes callback bytes", async () => {
    const state = await fixture();
    let observed: Uint8Array | null = null;
    const result = await withSoleFoundingDeviceHistoricalCommitterV4({
      crypto: state.crypto,
      profile: state.profile,
      humanId: HUMAN,
      expectedHead: state.head,
      operation: async (resolve) => {
        observed = resolve({
          purpose: "namespace-binding",
          namespaceId: namespaceId("namespace_sole_founder"),
          domainId: DOMAIN,
          domainEpoch: domainEpoch(0),
          accessRevision: accessRevision(0),
          committerDeviceId: cryptoDeviceId(DEVICE),
          previousBindingHash: null,
        });
        expect(observed).toEqual(state.signing.publicKey);
        expect(resolve({
          purpose: "namespace-binding",
          namespaceId: namespaceId("namespace_sole_founder"),
          domainId: DOMAIN,
          domainEpoch: domainEpoch(1),
          accessRevision: accessRevision(0),
          committerDeviceId: cryptoDeviceId(DEVICE),
          previousBindingHash: null,
        })).toBeNull();
        await Promise.resolve();
        return "authorized" as const;
      },
    });
    expect(result).toEqual({ status: "ready", value: "authorized" });
    expect(observed).not.toBeNull();
    expect([...observed!]).toEqual(Array.from({ length: 32 }, () => 0));
    destroyOpenedClientDeviceProfileV4(state.profile);
    state.head.stateHash.fill(0);
  });

  test("returns typed unavailable for a stale head or another Human", async () => {
    const state = await fixture();
    const stale = await withSoleFoundingDeviceHistoricalCommitterV4({
      crypto: state.crypto,
      profile: state.profile,
      humanId: HUMAN,
      expectedHead: {
        ...state.head,
        stateHash: new Uint8Array(32).fill(0xff),
      },
      operation: () => {
        throw new Error("must not run");
      },
    });
    expect(stale).toEqual({
      status: "unavailable",
      reason: "provider_head_mismatch",
    });
    const wrongHuman = await withSoleFoundingDeviceHistoricalCommitterV4({
      crypto: state.crypto,
      profile: state.profile,
      humanId: "human_someone_else",
      expectedHead: state.head,
      operation: () => {
        throw new Error("must not run");
      },
    });
    expect(wrongHuman).toEqual({
      status: "unavailable",
      reason: "not_sole_founding_device",
    });
    destroyOpenedClientDeviceProfileV4(state.profile);
    state.head.stateHash.fill(0);
  });

  test("does not treat an exact multi-device provider roster as historical evidence", async () => {
    const state = await fixture();
    const v3 = state.profile.baseProfile;
    const aliceVault = DeviceProviderStateVault.fromKey(
      state.crypto,
      cryptoDeviceId(DEVICE),
      v3.providerStateSealingKey,
    );
    const alice = new OpenMlsGroupProvider(state.crypto, aliceVault);
    const record = v3.activeProviderSnapshots[0]!;
    const initial = restoreSealedProviderState({
      providerId: record.providerId,
      domainId: cryptoDomainId(record.domainId),
      deviceId: cryptoDeviceId(DEVICE),
      revision: domainEpoch(record.epoch),
      snapshotKind: "active" as const,
      ciphertext: record.ciphertext,
    });
    const bobVault = DeviceProviderStateVault.fromKey(
      state.crypto,
      cryptoDeviceId("device_sole_founder_phone"),
      new Uint8Array(32).fill(0xb2),
    );
    const bob = new OpenMlsGroupProvider(state.crypto, bobVault);
    const join = await bob.createJoinRequest({
      domainId: DOMAIN,
      humanId: humanId(HUMAN),
      expectedHead: state.head,
    });
    const add = await alice.prepareAdd({
      active: initial,
      joinRequest: join.publicResult,
    });
    const applied = alice.applyCandidate({
      active: initial,
      candidate: add.localCandidate,
    });
    expect(applied.status).toBe("applied");
    if (applied.status !== "applied") throw new Error("provider add failed");
    const nextHead = alice.publicHead(applied.active);
    const nextV3 = await addClientDomainProviderSnapshot({
      crypto: state.crypto,
      profile: v3,
      snapshot: applied.active,
      expectedHead: nextHead,
    });
    const nextBytes = encodeClientDeviceProfileV3(nextV3);
    const nextV4 = await createClientDeviceProfileV4Candidate({
      crypto: state.crypto,
      currentProfileBytes: nextBytes,
      expectedDeviceId: DEVICE,
    });
    const result = await withSoleFoundingDeviceHistoricalCommitterV4({
      crypto: state.crypto,
      profile: nextV4,
      humanId: HUMAN,
      expectedHead: nextHead,
      operation: () => {
        throw new Error("must not run");
      },
    });
    expect(result).toEqual({
      status: "unavailable",
      reason: "not_sole_founding_device",
    });
    destroyOpenedClientDeviceProfileV4(nextV4);
    destroyOpenedClientDeviceProfileV3(nextV3);
    destroyOpenedClientDeviceProfileV4(state.profile);
    nextBytes.fill(0);
    nextHead.stateHash.fill(0);
    state.head.stateHash.fill(0);
    applied.active.ciphertext.fill(0);
    join.localState.ciphertext.fill(0);
    aliceVault.destroy();
    bobVault.destroy();
  });
});
