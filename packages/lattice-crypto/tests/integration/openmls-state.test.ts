import { describe, expect, test } from "bun:test";
import { LatticeCrypto, manualClock, seededRng } from "../../src/crypto/index.ts";
import { OpenMlsGroupProvider } from "../../src/group/openmls.ts";
import { DeviceStateVault } from "../../src/recovery/device-vault.ts";
import { concat, fromHex, utf8 } from "../../src/util/bytes.ts";

const OLD_DEVICE_BACKUP_DOMAIN = fromHex(
  "6b656e746175726f732f6c6174746963652d63727970746f2f6f70656e6d6c732d6465766963652d6261636b75702f7631",
);
const OLD_DEVICE_VAULT_DOMAIN = fromHex(
  "6b656e746175726f732f6c6174746963652d63727970746f2f6465766963652d73746174652d7661756c742f7631",
);
const DEVICE_VAULT_DOMAIN = utf8(
  "nautilo/lattice-crypto/device-state-vault/v1",
);

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function u64(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
}

function frame(value: Uint8Array): Uint8Array {
  return concat(u32(value.length), value);
}

function replaceLeadingDomain(
  canonical: Uint8Array,
  oldDomain: Uint8Array,
): Uint8Array {
  const canonicalLength = new DataView(
    canonical.buffer,
    canonical.byteOffset,
    canonical.byteLength,
  ).getUint32(0, false);
  return concat(frame(oldDomain), canonical.slice(4 + canonicalLength));
}

function vaultAad(
  domain: Uint8Array,
  deviceId: string,
  namespaceId: string,
  revision: number,
): Uint8Array {
  return concat(
    frame(domain),
    u32(1),
    frame(utf8(deviceId)),
    frame(utf8(namespaceId)),
    u64(revision),
  );
}

interface PublicOpenMlsState {
  namespaceId: string;
  epoch: number;
  ratchetTree: Uint8Array;
  roster: { deviceId: string; userId: string; leafIndex: number }[];
}

interface HardenedOpenMlsProvider {
  exportPublicGroupState(namespaceId: string): PublicOpenMlsState;
  serializeGroupState?: unknown;
  loadGroupState?: unknown;
}

describe("OpenMLS server/device state boundary (H5)", () => {
  test("the provider exposes public delivery state, never a serializable member keystore", async () => {
    const provider = new OpenMlsGroupProvider();
    await provider.initGroup("ns_state", [
      { deviceId: "alice-phone", userId: "alice" },
      { deviceId: "bob-phone", userId: "bob" },
    ]);

    const hardened = provider as unknown as HardenedOpenMlsProvider;
    expect(hardened.serializeGroupState).toBeUndefined();
    expect(hardened.loadGroupState).toBeUndefined();

    const state = hardened.exportPublicGroupState("ns_state");
    expect(state.namespaceId).toBe("ns_state");
    expect(state.epoch).toBe(0);
    expect(state.ratchetTree.length).toBeGreaterThan(0);
    expect(state.roster).toEqual([
      { deviceId: "alice-phone", userId: "alice", leafIndex: 0 },
      { deviceId: "bob-phone", userId: "bob", leafIndex: 1 },
    ]);
  });

  test("a complete public server snapshot cannot restore an exporter-capable member", async () => {
    const memberDevice = new OpenMlsGroupProvider();
    await memberDevice.initGroup("ns_public_only", [
      { deviceId: "alice-phone", userId: "alice" },
    ]);
    const memberSecret = await memberDevice.exporterSecret(
      "ns_public_only",
      0,
      "lattice",
      "alice-phone",
    );
    expect(memberSecret.length).toBeGreaterThan(0);

    const serverState = (
      memberDevice as unknown as HardenedOpenMlsProvider
    ).exportPublicGroupState("ns_public_only");
    expect(serverState.ratchetTree.length).toBeGreaterThan(0);

    // A server/database reader can create a fresh provider and possess every
    // byte of the public snapshot, but there is deliberately no import path
    // that turns those bytes into member state or an exporter secret.
    const databaseReader = new OpenMlsGroupProvider();
    const restoreOutcome = await databaseReader
      .exporterSecret(
        serverState.namespaceId,
        serverState.epoch,
        "lattice",
        "alice-phone",
      )
      .then(
        () => "resolved",
        (error: unknown) => String(error),
      );
    expect(restoreOutcome).toContain("unknown group");
  });

  test("an encrypted device-local snapshot restores a fully committing member", async () => {
    const provider = new OpenMlsGroupProvider();
    await provider.initGroup("ns_restart", [
      { deviceId: "alice-phone", userId: "alice" },
      { deviceId: "bob-phone", userId: "bob" },
    ]);
    const crypto = new LatticeCrypto(seededRng(44), manualClock(1_000));
    const vault = DeviceStateVault.create(crypto, "alice-phone");
    const before = await provider.exporterSecret(
      "ns_restart",
      0,
      "lattice",
      "alice-phone",
    );
    const snapshot = provider.backupDeviceState(
      "ns_restart",
      "alice-phone",
      7,
      vault,
    );

    provider.restoreDeviceState(
      "ns_restart",
      "alice-phone",
      snapshot,
      7,
      vault,
    );
    expect(
      await provider.exporterSecret(
        "ns_restart",
        0,
        "lattice",
        "alice-phone",
      ),
    ).toEqual(before);

    // The restored identity can author later commits; it is not the old
    // exporter-only restore that H5 removed.
    await provider.addDevices("ns_restart", [
      { deviceId: "alice-laptop", userId: "alice" },
    ]);
    await provider.removeDevices("ns_restart", ["bob-phone"]);
    expect(provider.roster("ns_restart").map((member) => member.deviceId)).toEqual([
      "alice-phone",
      "alice-laptop",
    ]);
    expect(
      await provider.exporterSecret(
        "ns_restart",
        1,
        "lattice",
        "alice-phone",
      ),
    ).toHaveLength(32);
  });

  test("device-local restore rejects rollback and the wrong vault", async () => {
    const provider = new OpenMlsGroupProvider();
    await provider.initGroup("ns_rollback", [
      { deviceId: "alice-phone", userId: "alice" },
    ]);
    const crypto = new LatticeCrypto(seededRng(45), manualClock(1_000));
    const vault = DeviceStateVault.create(crypto, "alice-phone");
    const snapshot = provider.backupDeviceState(
      "ns_rollback",
      "alice-phone",
      3,
      vault,
    );

    expect(() =>
      provider.restoreDeviceState(
        "ns_rollback",
        "alice-phone",
        snapshot,
        4,
        vault,
      )
    ).toThrow("rollback");

    const wrongVault = DeviceStateVault.create(crypto, "alice-phone");
    expect(() =>
      provider.restoreDeviceState(
        "ns_rollback",
        "alice-phone",
        snapshot,
        3,
        wrongVault,
      )
    ).toThrow("authentication");
  });

  test("device-local restore rejects both old backup and old vault domains", async () => {
    const provider = new OpenMlsGroupProvider();
    await provider.initGroup("ns_old_domain", [
      { deviceId: "alice-phone", userId: "alice" },
    ]);
    const crypto = new LatticeCrypto(seededRng(451), manualClock(1_000));
    const vault = DeviceStateVault.create(crypto, "alice-phone");
    const snapshot = provider.backupDeviceState(
      "ns_old_domain",
      "alice-phone",
      3,
      vault,
    );
    const plaintext = vault.open(snapshot, 3);
    if (!plaintext) throw new Error("expected canonical device backup");
    const key = vault.exportLocalKey();

    const oldBackupSnapshot = {
      ...snapshot,
      ciphertext: crypto.aeadSeal(
        key,
        replaceLeadingDomain(plaintext, OLD_DEVICE_BACKUP_DOMAIN),
        vaultAad(DEVICE_VAULT_DOMAIN, "alice-phone", "ns_old_domain", 3),
      ),
    };
    expect(() =>
      provider.restoreDeviceState(
        "ns_old_domain",
        "alice-phone",
        oldBackupSnapshot,
        3,
        vault,
      )
    ).toThrow("malformed device backup");

    const oldVaultSnapshot = {
      ...snapshot,
      ciphertext: crypto.aeadSeal(
        key,
        plaintext,
        vaultAad(OLD_DEVICE_VAULT_DOMAIN, "alice-phone", "ns_old_domain", 3),
      ),
    };
    expect(() =>
      provider.restoreDeviceState(
        "ns_old_domain",
        "alice-phone",
        oldVaultSnapshot,
        3,
        vault,
      )
    ).toThrow("authentication");
  });

  test("device-local restore binds namespace, identity, and lattice epoch", async () => {
    const provider = new OpenMlsGroupProvider();
    await provider.initGroup("ns_bound", [
      { deviceId: "alice-phone", userId: "alice" },
    ]);
    await provider.initGroup("ns_other", [
      { deviceId: "alice-phone", userId: "alice" },
    ]);
    const crypto = new LatticeCrypto(seededRng(46), manualClock(1_000));
    const vault = DeviceStateVault.create(crypto, "alice-phone");
    const snapshot = provider.backupDeviceState(
      "ns_bound",
      "alice-phone",
      1,
      vault,
    );

    expect(() =>
      provider.restoreDeviceState(
        "ns_other",
        "alice-phone",
        snapshot,
        1,
        vault,
      )
    ).toThrow("namespace mismatch");

    const impostor = new OpenMlsGroupProvider();
    await impostor.initGroup("ns_bound", [
      { deviceId: "alice-phone", userId: "mallory" },
    ]);
    const impostorSnapshot = impostor.backupDeviceState(
      "ns_bound",
      "alice-phone",
      2,
      vault,
    );
    expect(() =>
      provider.restoreDeviceState(
        "ns_bound",
        "alice-phone",
        impostorSnapshot,
        2,
        vault,
      )
    ).toThrow("identity mismatch");

    await provider.addDevicesAndRotate("ns_bound", [
      { deviceId: "bob-phone", userId: "bob" },
    ]);
    expect(() =>
      provider.restoreDeviceState(
        "ns_bound",
        "alice-phone",
        snapshot,
        1,
        vault,
      )
    ).toThrow("another lattice epoch");
  });
});
