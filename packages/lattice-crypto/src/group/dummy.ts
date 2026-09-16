import type { LatticeCrypto } from "../crypto/index.ts";
import { LATTICE_LIMITS } from "../limits.ts";
import type { DeviceId, Epoch, NamespaceId } from "../types/index.ts";
import type {
  GroupKeyProvider,
  GroupMember,
  GroupRosterEntry,
} from "./provider.ts";

interface GroupState {
  members: Map<DeviceId, GroupRosterEntry & { roots: Map<Epoch, Uint8Array> }>;
  epoch: Epoch;
}

/**
 * A stand-in for a real MLS group. It models the SEMANTICS the lattice depends
 * on — per-device retained roots, same-user device add without a lattice
 * bump, and new-user add/removal with a bump —
 * WITHOUT real forward secrecy / post-compromise security / per-member key
 * isolation. Those only arrive with `ts-mls` in M1. The `GroupKeyProvider`
 * interface is shaped so that swap is a one-line change.
 */
export class DummyGroupProvider implements GroupKeyProvider {
  readonly id = "dummy";
  private groups = new Map<NamespaceId, GroupState>();

  constructor(private readonly crypto: LatticeCrypto) {}

  initGroup(namespaceId: NamespaceId, members: GroupMember[]): Promise<void> {
    if (this.groups.has(namespaceId)) return Promise.resolve();
    const root = this.crypto.randomBytes(32);
    const roster = new Map<
      DeviceId,
      GroupRosterEntry & { roots: Map<Epoch, Uint8Array> }
    >();
    for (const [leafIndex, member] of members.entries()) {
      roster.set(member.deviceId, {
        ...member,
        leafIndex,
        roots: new Map([[0, root.slice()]]),
      });
    }
    this.groups.set(namespaceId, {
      members: roster,
      epoch: 0,
    });
    return Promise.resolve();
  }

  private state(namespaceId: NamespaceId): GroupState {
    const g = this.groups.get(namespaceId);
    if (!g) throw new Error(`DummyGroupProvider: unknown group ${namespaceId}`);
    return g;
  }

  private assertRetentionCapacity(
    members: Iterable<{ roots: Map<Epoch, Uint8Array> }>,
  ): void {
    for (const member of members) {
      if (member.roots.size >= LATTICE_LIMITS.retainedEpochsPerDevice) {
        throw new Error("retained epoch limit reached");
      }
    }
  }

  currentEpoch(namespaceId: NamespaceId): Epoch {
    return this.state(namespaceId).epoch;
  }

  addDevices(namespaceId: NamespaceId, members: GroupMember[]): Promise<void> {
    const g = this.state(namespaceId);
    for (const member of members) {
      if (g.members.has(member.deviceId)) continue;
      const occupied = new Set([...g.members.values()].map((m) => m.leafIndex));
      let leafIndex = 0;
      while (occupied.has(leafIndex)) leafIndex += 1;
      g.members.set(member.deviceId, {
        ...member,
        leafIndex,
        roots: g.members.size === 0
          ? new Map<Epoch, Uint8Array>([
              [g.epoch, this.crypto.randomBytes(32)],
            ])
          : new Map<Epoch, Uint8Array>(),
      });
    }
    return Promise.resolve();
  }

  async addDevicesAndRotate(
    namespaceId: NamespaceId,
    members: GroupMember[],
  ): Promise<Epoch> {
    const g = this.state(namespaceId);
    this.assertRetentionCapacity(g.members.values());
    await this.addDevices(namespaceId, members);
    g.epoch += 1;
    const root = this.crypto.randomBytes(32);
    for (const member of g.members.values()) {
      member.roots.set(g.epoch, root.slice());
    }
    return g.epoch;
  }

  removeDevices(namespaceId: NamespaceId, deviceIds: DeviceId[]): Promise<Epoch> {
    const g = this.state(namespaceId);
    const removals = new Set(deviceIds);
    this.assertRetentionCapacity(
      [...g.members.entries()]
        .filter(([deviceId]) => !removals.has(deviceId))
        .map(([, member]) => member),
    );
    for (const deviceId of deviceIds) g.members.delete(deviceId);
    g.epoch += 1;
    const root = this.crypto.randomBytes(32);
    for (const member of g.members.values()) {
      member.roots.set(g.epoch, root.slice());
    }
    return Promise.resolve(g.epoch);
  }

  roster(namespaceId: NamespaceId): GroupRosterEntry[] {
    return [...this.state(namespaceId).members.values()]
      .map(({ roots: _roots, ...member }) => ({ ...member }))
      .sort((a, b) => a.leafIndex - b.leafIndex);
  }

  exporterSecret(
    namespaceId: NamespaceId,
    epoch: Epoch,
    label: string,
    deviceId: DeviceId,
  ): Promise<Uint8Array> {
    const g = this.groups.get(namespaceId);
    if (!g) {
      return Promise.reject(
        new Error(`DummyGroupProvider: unknown group ${namespaceId}`),
      );
    }
    if (!g.members.has(deviceId)) {
      return Promise.reject(
        new Error(
          `DummyGroupProvider: device ${deviceId} is not a current member`,
        ),
      );
    }
    const root = g.members.get(deviceId)?.roots.get(epoch);
    if (!root) {
      return Promise.reject(
        new Error(`DummyGroupProvider: no epoch secret ${namespaceId}@${epoch}`),
      );
    }
    return Promise.resolve(this.crypto.deriveKey(root, `mls-exporter/${label}`));
  }

  hasEpochSecret(namespaceId: NamespaceId, epoch: Epoch, deviceId: DeviceId): boolean {
    const g = this.groups.get(namespaceId);
    return !!g && g.members.get(deviceId)?.roots.has(epoch) === true;
  }

  retainedEpochs(namespaceId: NamespaceId, deviceId: DeviceId): Epoch[] {
    const member = this.state(namespaceId).members.get(deviceId);
    return member ? [...member.roots.keys()].sort((a, b) => a - b) : [];
  }

  exportEpochSecret(
    namespaceId: NamespaceId,
    epoch: Epoch,
    deviceId: DeviceId,
  ): Promise<Uint8Array> {
    const secret = this.state(namespaceId).members.get(deviceId)?.roots.get(epoch);
    return secret
      ? Promise.resolve(secret.slice())
      : Promise.reject(new Error(`no retained secret for ${namespaceId}@${epoch}`));
  }

  importEpochSecret(
    namespaceId: NamespaceId,
    epoch: Epoch,
    deviceId: DeviceId,
    secret: Uint8Array,
  ): Promise<void> {
    const member = this.state(namespaceId).members.get(deviceId);
    if (!member) {
      return Promise.reject(new Error(`device ${deviceId} is not a current member`));
    }
    if (secret.length !== 32) {
      return Promise.reject(new Error("retained epoch secret must be 32 bytes"));
    }
    if (
      !member.roots.has(epoch) &&
      member.roots.size >= LATTICE_LIMITS.retainedEpochsPerDevice
    ) {
      return Promise.reject(new Error("retained epoch limit reached"));
    }
    member.roots.set(epoch, secret.slice());
    return Promise.resolve();
  }

  deliverCurrentEpochSecret(
    namespaceId: NamespaceId,
    senderDeviceId: DeviceId,
    recipientDeviceId: DeviceId,
  ): Promise<void> {
    const group = this.state(namespaceId);
    const sender = group.members.get(senderDeviceId);
    const recipient = group.members.get(recipientDeviceId);
    const secret = sender?.roots.get(group.epoch);
    if (!sender || !recipient || !secret) {
      return Promise.reject(
        new Error("current epoch delivery requires two current member devices"),
      );
    }
    recipient.roots.set(group.epoch, secret.slice());
    return Promise.resolve();
  }
}
