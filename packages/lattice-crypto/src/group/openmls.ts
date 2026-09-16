/**
 * Production MLS-backed group provider (roadmap item 7), using **OpenMLS**
 * (Rust, SRLabs-audited) via a vendored wasm wrapper. Same `GroupKeyProvider`
 * seam as `MlsGroupProvider` (ts-mls) and `DummyGroupProvider`, so the engine,
 * scheme, storage, and agent path never change across the swap.
 *
 * Mirrors `MlsGroupProvider`'s modelling decisions exactly:
 *  - MLS epoch (bumps on every commit) vs LATTICE epoch (bumps only on removal);
 *    a fresh root is snapshotted from the exporter secret at each lattice epoch.
 *  - Many simulated device-local member states are driven in-process (a lab
 *    simplification). Production keeps each usable member state on its device;
 *    the server only distributes public commits, welcomes, and ratchet trees.
 *
 * The wasm glue is produced by `scripts/build-openmls-wasm.sh` into
 * `../../vendor/openmls-wasm/` and loaded LAZILY (dynamic import), so the repo
 * typechecks/tests before the artifact exists. `ts-mls` stays the default
 * sandbox provider until this row is built and green.
 */

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { LATTICE_LIMITS } from "../limits.ts";
import {
  DeviceStateVault,
  type DeviceStateSnapshot,
} from "../recovery/device-vault.ts";
import type { DeviceId, Epoch, NamespaceId, UserId } from "../types/index.ts";
import { concat, utf8 } from "../util/bytes.ts";
import type {
  GroupKeyProvider,
  GroupMember,
  GroupRosterEntry,
} from "./provider.ts";

const ROOT_LABEL = "lattice-root";
const ROOT_LEN = 32;

/**
 * Electron copies the vendored module beside its main-process bundle, so its
 * build replaces this identifier with that bundle-relative path. Other
 * runtimes keep resolving from the lattice-crypto source tree.
 */
declare const __NAUTILO_OPENMLS_WASM_GLUE__: string | undefined;
declare const __NAUTILO_OPENMLS_WASM_BYTES__: Uint8Array | undefined;
const VENDOR_GLUE: string =
  typeof __NAUTILO_OPENMLS_WASM_GLUE__ === "string"
    ? __NAUTILO_OPENMLS_WASM_GLUE__
    : "../../vendor/openmls-wasm/openmls_wasm.js";
const VENDOR_WASM_BYTES: Uint8Array | undefined =
  typeof __NAUTILO_OPENMLS_WASM_BYTES__ === "undefined"
    ? undefined
    : __NAUTILO_OPENMLS_WASM_BYTES__;

// ---- The contract the vendored wrapper must satisfy (see openmls-wasm/src/lib.rs).
// wasm-bindgen keeps snake_case method names, so they are reflected verbatim.

interface WasmProvider {
  serialize_device_state(): Uint8Array;
  free(): void;
}
interface WasmIdentity {
  key_package(provider: WasmProvider): WasmKeyPackage;
  free(): void;
}
interface WasmKeyPackage {
  to_bytes(): Uint8Array;
  free(): void;
}
interface WasmRatchetTree {
  to_bytes(): Uint8Array;
  free(): void;
}
interface WasmAddMessages {
  readonly commit: Uint8Array;
  readonly welcome: Uint8Array;
}
interface WasmRemoveMessages {
  readonly commit: Uint8Array;
}
interface WasmGroup {
  export_ratchet_tree(): WasmRatchetTree;
  own_leaf_index(): number;
  member_roster(): Uint8Array;
  propose_and_commit_add(
    provider: WasmProvider,
    sender: WasmIdentity,
    newMember: WasmKeyPackage,
  ): WasmAddMessages;
  propose_and_commit_remove(
    provider: WasmProvider,
    sender: WasmIdentity,
    removedIndex: number,
  ): WasmRemoveMessages;
  merge_pending_commit(provider: WasmProvider): void;
  process_message(provider: WasmProvider, msg: Uint8Array): Uint8Array;
  export_key(
    provider: WasmProvider,
    label: string,
    context: Uint8Array,
    keyLength: number,
  ): Uint8Array;
  free(): void;
}
interface OpenMlsModule {
  /** Present for the `web` wasm-pack target; must be called once before use. */
  default?: (moduleOrPath?: unknown) => Promise<unknown>;
  Provider: (new () => WasmProvider) & {
    deserialize_device_state(bytes: Uint8Array): WasmProvider;
  };
  Identity: (new (provider: WasmProvider, name: string) => WasmIdentity) & {
    load(provider: WasmProvider, group: WasmGroup): WasmIdentity;
  };
  KeyPackage: { from_bytes(bytes: Uint8Array): WasmKeyPackage };
  RatchetTree: { from_bytes(bytes: Uint8Array): WasmRatchetTree };
  Group: {
    create_new(provider: WasmProvider, founder: WasmIdentity, groupId: string): WasmGroup;
    join(provider: WasmProvider, welcome: Uint8Array, ratchetTree: WasmRatchetTree): WasmGroup;
    load_device_state(provider: WasmProvider, groupId: string): WasmGroup;
  };
}

let modulePromise: Promise<OpenMlsModule> | null = null;

/** Load + init the vendored wasm module once, process-wide. */
function loadOpenMls(): Promise<OpenMlsModule> {
  modulePromise ??= (async (): Promise<OpenMlsModule> => {
    const mod = (await import(VENDOR_GLUE)) as OpenMlsModule;
    if (typeof mod.default === "function") await mod.default(VENDOR_WASM_BYTES);
    return mod;
  })();
  return modulePromise;
}

interface OpenMlsMember {
  deviceId: DeviceId;
  userId: UserId;
  leafIndex: number;
  provider: WasmProvider;
  identity: WasmIdentity;
  group: WasmGroup;
  roots: Map<Epoch, Uint8Array>;
}

interface OpenMlsGroupState {
  namespaceId: NamespaceId;
  committerDeviceId: DeviceId | null;
  members: Map<DeviceId, OpenMlsMember>;
  epoch: Epoch; // lattice epoch (principal add/remove, not same-user device add)
}

const DEVICE_BACKUP_FORMAT_VERSION = 1;
const DEVICE_BACKUP_DOMAIN = utf8(
  "nautilo/lattice-crypto/openmls-device-backup/v1",
);
const MAX_DEVICE_BACKUP_BYTES = LATTICE_LIMITS.deviceStateBytes;
const MAX_RETAINED_ROOTS = LATTICE_LIMITS.retainedEpochsPerDevice;

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function u64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), false);
  return out;
}

function frame(value: Uint8Array): Uint8Array {
  return concat(u32(value.length), value);
}

function encodeDeviceBackup(
  userId: UserId,
  latticeEpoch: Epoch,
  providerState: Uint8Array,
  roots: Map<Epoch, Uint8Array>,
): Uint8Array {
  const entries = [...roots.entries()].sort(([left], [right]) => left - right);
  if (
    providerState.length > MAX_DEVICE_BACKUP_BYTES ||
    entries.length > MAX_RETAINED_ROOTS
  ) {
    throw new Error("OpenMlsGroupProvider: device backup exceeds limits");
  }
  return concat(
    frame(DEVICE_BACKUP_DOMAIN),
    u32(DEVICE_BACKUP_FORMAT_VERSION),
    frame(utf8(userId)),
    u64(latticeEpoch),
    frame(providerState),
    u32(entries.length),
    ...entries.map(([epoch, root]) => concat(u64(epoch), frame(root))),
  );
}

function decodeDeviceBackup(bytes: Uint8Array): {
  userId: UserId;
  latticeEpoch: Epoch;
  providerState: Uint8Array;
  roots: Map<Epoch, Uint8Array>;
} | null {
  if (bytes.length > MAX_DEVICE_BACKUP_BYTES) return null;
  let offset = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readU32 = (): number | null => {
    if (offset + 4 > bytes.length) return null;
    const value = view.getUint32(offset, false);
    offset += 4;
    return value;
  };
  const readU64 = (): number | null => {
    if (offset + 8 > bytes.length) return null;
    const big = view.getBigUint64(offset, false);
    offset += 8;
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(big);
  };
  const readFrame = (): Uint8Array | null => {
    const length = readU32();
    if (length === null || offset + length > bytes.length) return null;
    const value = bytes.subarray(offset, offset + length);
    offset += length;
    return value;
  };
  const domain = readFrame();
  if (
    !domain ||
    domain.length !== DEVICE_BACKUP_DOMAIN.length ||
    !domain.every((byte, index) => byte === DEVICE_BACKUP_DOMAIN[index])
  ) {
    return null;
  }
  const version = readU32();
  const userBytes = readFrame();
  const latticeEpoch = readU64();
  const providerState = readFrame();
  const rootCount = readU32();
  if (
    version !== DEVICE_BACKUP_FORMAT_VERSION ||
    !userBytes ||
    latticeEpoch === null ||
    !providerState ||
    rootCount === null ||
    rootCount > MAX_RETAINED_ROOTS
  ) {
    return null;
  }
  let userId: string;
  try {
    userId = new TextDecoder("utf-8", { fatal: true }).decode(userBytes);
  } catch {
    return null;
  }
  const roots = new Map<Epoch, Uint8Array>();
  for (let index = 0; index < rootCount; index += 1) {
    const epoch = readU64();
    const root = readFrame();
    if (
      epoch === null ||
      !root ||
      root.length !== ROOT_LEN ||
      roots.has(epoch)
    ) {
      return null;
    }
    roots.set(epoch, root.slice());
  }
  if (offset !== bytes.length) return null;
  return {
    userId,
    latticeEpoch,
    providerState: providerState.slice(),
    roots,
  };
}

export class OpenMlsGroupProvider implements GroupKeyProvider {
  readonly id = "openmls";
  private mod!: OpenMlsModule;
  private readonly ready: Promise<void>;
  private readonly groups = new Map<NamespaceId, OpenMlsGroupState>();

  constructor() {
    this.ready = loadOpenMls().then((m) => {
      this.mod = m;
    });
  }

  private group(namespaceId: NamespaceId): OpenMlsGroupState {
    const g = this.groups.get(namespaceId);
    if (!g) throw new Error(`OpenMlsGroupProvider: unknown group ${namespaceId}`);
    return g;
  }

  private assertRetentionCapacity(members: Iterable<OpenMlsMember>): void {
    for (const member of members) {
      if (member.roots.size >= LATTICE_LIMITS.retainedEpochsPerDevice) {
        throw new Error("retained epoch limit reached");
      }
    }
  }

  private creator(g: OpenMlsGroupState): OpenMlsMember {
    if (!g.committerDeviceId) {
      throw new Error("OpenMlsGroupProvider: group has no current devices");
    }
    const c = g.members.get(g.committerDeviceId);
    if (!c) throw new Error("OpenMlsGroupProvider: creator left the group (unsupported)");
    return c;
  }

  private committerIdentity(g: OpenMlsGroupState): WasmIdentity {
    return this.creator(g).identity;
  }

  private rootFrom(g: OpenMlsGroupState): Uint8Array {
    const creator = this.creator(g);
    return creator.group.export_key(creator.provider, ROOT_LABEL, new Uint8Array(0), ROOT_LEN);
  }

  /** Apply a commit to every current member except those in `skip`. */
  private syncOthers(
    g: OpenMlsGroupState,
    commit: Uint8Array,
    skip: Set<DeviceId>,
  ): void {
    for (const m of g.members.values()) {
      if (skip.has(m.deviceId)) continue;
      m.group.process_message(m.provider, commit);
    }
  }

  private commitAdd(g: OpenMlsGroupState, newMember: GroupMember): void {
    if (g.members.has(newMember.deviceId)) return;
    if (g.members.size === 0) {
      const provider = new this.mod.Provider();
      const identity = new this.mod.Identity(provider, newMember.deviceId);
      const group = this.mod.Group.create_new(provider, identity, g.namespaceId);
      g.committerDeviceId = newMember.deviceId;
      g.members.set(newMember.deviceId, {
        ...newMember,
        leafIndex: group.own_leaf_index(),
        provider,
        identity,
        group,
        roots: new Map(),
      });
      const root = this.rootFrom(g);
      g.members.get(newMember.deviceId)?.roots.set(g.epoch, root);
      this.assertRosterParity(g);
      return;
    }
    const provider = new this.mod.Provider();
    const identity = new this.mod.Identity(provider, newMember.deviceId);
    const keyPackage = identity.key_package(provider);
    const creator = this.creator(g);
    const add = creator.group.propose_and_commit_add(
      creator.provider,
      this.committerIdentity(g),
      keyPackage,
    );
    creator.group.merge_pending_commit(creator.provider);
    this.syncOthers(
      g,
      add.commit,
      new Set([g.committerDeviceId as DeviceId]),
    );
    const tree = creator.group.export_ratchet_tree();
    const joined = this.mod.Group.join(provider, add.welcome, tree);
    g.members.set(newMember.deviceId, {
      ...newMember,
      leafIndex: joined.own_leaf_index(),
      provider,
      identity,
      group: joined,
      roots: new Map(),
    });
    this.assertRosterParity(g);
  }

  private commitRemove(g: OpenMlsGroupState, deviceId: DeviceId): void {
    const target = g.members.get(deviceId);
    if (!target) return;
    if (g.members.size < 2) {
      g.members.delete(deviceId);
      g.committerDeviceId = null;
      return;
    }
    if (g.committerDeviceId === deviceId) {
      const replacement = [...g.members.keys()].find((id) => id !== deviceId);
      if (!replacement) {
        throw new Error("OpenMlsGroupProvider: no replacement committer");
      }
      g.committerDeviceId = replacement;
    }
    const creator = this.creator(g);
    const rem = creator.group.propose_and_commit_remove(
      creator.provider,
      this.committerIdentity(g),
      target.leafIndex,
    );
    creator.group.merge_pending_commit(creator.provider);
    const committerDeviceId = g.committerDeviceId;
    if (!committerDeviceId) {
      throw new Error("OpenMlsGroupProvider: missing committer after removal");
    }
    this.syncOthers(g, rem.commit, new Set([committerDeviceId, deviceId]));
    g.members.delete(deviceId);
    this.assertRosterParity(g);
  }

  private authoritativeRoster(g: OpenMlsGroupState): GroupRosterEntry[] {
    const bytes = this.creator(g).group.member_roster();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    const readU32 = (): number => {
      if (offset + 4 > view.byteLength) {
        throw new Error("OpenMlsGroupProvider: truncated MLS roster");
      }
      const value = view.getUint32(offset, true);
      offset += 4;
      return value;
    };
    const count = readU32();
    const roster: GroupRosterEntry[] = [];
    for (let index = 0; index < count; index += 1) {
      const leafIndex = readU32();
      const identityLength = readU32();
      if (offset + identityLength > bytes.byteLength) {
        throw new Error("OpenMlsGroupProvider: truncated MLS identity");
      }
      const deviceId = new TextDecoder().decode(
        bytes.subarray(offset, offset + identityLength),
      );
      offset += identityLength;
      const member = g.members.get(deviceId);
      if (!member) {
        throw new Error(`OpenMlsGroupProvider: unknown MLS credential ${deviceId}`);
      }
      roster.push({ deviceId, userId: member.userId, leafIndex });
    }
    if (offset !== bytes.byteLength) {
      throw new Error("OpenMlsGroupProvider: trailing MLS roster bytes");
    }
    return roster.sort((a, b) => a.leafIndex - b.leafIndex);
  }

  private assertRosterParity(g: OpenMlsGroupState): void {
    const authoritative = this.authoritativeRoster(g);
    if (authoritative.length !== g.members.size) {
      throw new Error("OpenMlsGroupProvider: MLS roster/member map size mismatch");
    }
    for (const entry of authoritative) {
      const member = g.members.get(entry.deviceId);
      if (!member || member.leafIndex !== entry.leafIndex) {
        throw new Error(`OpenMlsGroupProvider: MLS roster mismatch for ${entry.deviceId}`);
      }
    }
  }

  async initGroup(namespaceId: NamespaceId, members: GroupMember[]): Promise<void> {
    await this.ready;
    if (this.groups.has(namespaceId)) return;
    const creatorMember = members[0];
    if (!creatorMember) {
      throw new Error("OpenMlsGroupProvider: initGroup needs >= 1 device");
    }

    const provider = new this.mod.Provider();
    const identity = new this.mod.Identity(provider, creatorMember.deviceId);
    const group = this.mod.Group.create_new(provider, identity, namespaceId);

    const g: OpenMlsGroupState = {
      namespaceId,
      committerDeviceId: creatorMember.deviceId,
      members: new Map([
        [
          creatorMember.deviceId,
          {
            ...creatorMember,
            leafIndex: group.own_leaf_index(),
            provider,
            identity,
            group,
            roots: new Map(),
          },
        ],
      ]),
      epoch: 0,
    };
    this.groups.set(namespaceId, g);

    for (const member of members.slice(1)) this.commitAdd(g, member);
    this.assertRosterParity(g);
    const root = this.rootFrom(g);
    for (const member of g.members.values()) {
      member.roots.set(0, root.slice());
    }
  }

  currentEpoch(namespaceId: NamespaceId): Epoch {
    return this.group(namespaceId).epoch;
  }

  async addDevices(namespaceId: NamespaceId, members: GroupMember[]): Promise<void> {
    await this.ready;
    const g = this.group(namespaceId);
    this.assertRetentionCapacity(g.members.values());
    for (const member of members) this.commitAdd(g, member);
    // No lattice-epoch bump; the current root stays valid.
  }

  async addDevicesAndRotate(
    namespaceId: NamespaceId,
    members: GroupMember[],
  ): Promise<Epoch> {
    await this.ready;
    const g = this.group(namespaceId);
    this.assertRetentionCapacity(g.members.values());
    for (const member of members) this.commitAdd(g, member);
    g.epoch += 1;
    const root = this.rootFrom(g);
    for (const current of g.members.values()) {
      current.roots.set(g.epoch, root.slice());
    }
    return g.epoch;
  }

  async removeDevices(namespaceId: NamespaceId, deviceIds: DeviceId[]): Promise<Epoch> {
    await this.ready;
    const g = this.group(namespaceId);
    const removals = new Set(deviceIds);
    this.assertRetentionCapacity(
      [...g.members.entries()]
        .filter(([deviceId]) => !removals.has(deviceId))
        .map(([, member]) => member),
    );
    for (const deviceId of deviceIds) this.commitRemove(g, deviceId);
    g.epoch += 1;
    if (g.members.size > 0) {
      const root = this.rootFrom(g);
      for (const member of g.members.values()) {
        member.roots.set(g.epoch, root.slice());
      }
    }
    return g.epoch;
  }

  roster(namespaceId: NamespaceId): GroupRosterEntry[] {
    const group = this.group(namespaceId);
    return group.members.size === 0 ? [] : this.authoritativeRoster(group);
  }

  async exporterSecret(
    namespaceId: NamespaceId,
    epoch: Epoch,
    label: string,
    deviceId: DeviceId,
  ): Promise<Uint8Array> {
    await this.ready;
    const group = this.group(namespaceId);
    if (!group.members.has(deviceId)) {
      throw new Error(
        `OpenMlsGroupProvider: device ${deviceId} is not a current member`,
      );
    }
    const root = group.members.get(deviceId)?.roots.get(epoch);
    if (!root) throw new Error(`OpenMlsGroupProvider: no root for ${namespaceId}@${epoch}`);
    return hkdf(sha256, root, new Uint8Array(0), new TextEncoder().encode(`mls-exporter/${label}`), ROOT_LEN);
  }

  hasEpochSecret(namespaceId: NamespaceId, epoch: Epoch, deviceId: DeviceId): boolean {
    const g = this.groups.get(namespaceId);
    return !!g && g.members.get(deviceId)?.roots.has(epoch) === true;
  }

  retainedEpochs(namespaceId: NamespaceId, deviceId: DeviceId): Epoch[] {
    const member = this.group(namespaceId).members.get(deviceId);
    return member ? [...member.roots.keys()].sort((a, b) => a - b) : [];
  }

  exportEpochSecret(
    namespaceId: NamespaceId,
    epoch: Epoch,
    deviceId: DeviceId,
  ): Promise<Uint8Array> {
    const secret = this.group(namespaceId).members.get(deviceId)?.roots.get(epoch);
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
    const member = this.group(namespaceId).members.get(deviceId);
    if (!member) {
      return Promise.reject(new Error(`device ${deviceId} is not a current member`));
    }
    if (secret.length !== ROOT_LEN) {
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
    const group = this.group(namespaceId);
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

  /** Encrypt one member's complete exporter-capable OpenMLS state under a
   * device-local vault key. Only the sealed snapshot may be persisted. */
  backupDeviceState(
    namespaceId: NamespaceId,
    deviceId: DeviceId,
    revision: number,
    vault: DeviceStateVault,
  ): DeviceStateSnapshot {
    if (vault.deviceId !== deviceId) {
      throw new Error("OpenMlsGroupProvider: vault belongs to another device");
    }
    const g = this.group(namespaceId);
    const member = g.members.get(deviceId);
    if (!member) {
      throw new Error(`OpenMlsGroupProvider: unknown device ${deviceId}`);
    }
    const providerState = member.provider.serialize_device_state();
    const plaintext = encodeDeviceBackup(
      member.userId,
      g.epoch,
      providerState,
      member.roots,
    );
    return vault.seal(namespaceId, revision, plaintext);
  }

  /** Replace one in-memory member with the state opened from its local vault.
   * The restored identity is commit-capable; stale/rolled-back revisions and
   * snapshots from a different lattice epoch are rejected before replacement. */
  restoreDeviceState(
    namespaceId: NamespaceId,
    deviceId: DeviceId,
    snapshot: DeviceStateSnapshot,
    minimumRevision: number,
    vault: DeviceStateVault,
  ): void {
    if (vault.deviceId !== deviceId) {
      throw new Error("OpenMlsGroupProvider: vault belongs to another device");
    }
    if (snapshot.namespaceId !== namespaceId) {
      throw new Error("OpenMlsGroupProvider: device backup namespace mismatch");
    }
    const plaintext = vault.open(snapshot, minimumRevision);
    if (!plaintext) {
      throw new Error("OpenMlsGroupProvider: device snapshot failed authentication or rollback check");
    }
    const decoded = decodeDeviceBackup(plaintext);
    if (!decoded) {
      throw new Error("OpenMlsGroupProvider: malformed device backup");
    }
    const g = this.group(namespaceId);
    const previous = g.members.get(deviceId);
    if (!previous || decoded.userId !== previous.userId) {
      throw new Error("OpenMlsGroupProvider: device backup identity mismatch");
    }
    if (decoded.latticeEpoch !== g.epoch) {
      throw new Error("OpenMlsGroupProvider: device backup is from another lattice epoch");
    }

    const provider = this.mod.Provider.deserialize_device_state(
      decoded.providerState,
    );
    let group: WasmGroup | null = null;
    let identity: WasmIdentity | null = null;
    try {
      group = this.mod.Group.load_device_state(provider, namespaceId);
      identity = this.mod.Identity.load(provider, group);
      const replacement: OpenMlsMember = {
        deviceId,
        userId: previous.userId,
        leafIndex: group.own_leaf_index(),
        provider,
        identity,
        group,
        roots: decoded.roots,
      };
      g.members.set(deviceId, replacement);
      this.assertRosterParity(g);
    } catch (error) {
      g.members.set(deviceId, previous);
      identity?.free();
      group?.free();
      provider.free();
      throw error;
    }
    previous.group.free();
    previous.identity.free();
    previous.provider.free();
  }

  /** Public Delivery Service material safe to persist server-side. This contains
   * no provider keystore, private tree path, exporter, or lattice root. */
  exportPublicGroupState(namespaceId: NamespaceId): {
    namespaceId: NamespaceId;
    epoch: Epoch;
    ratchetTree: Uint8Array;
    roster: GroupRosterEntry[];
  } {
    const g = this.group(namespaceId);
    const tree = this.creator(g).group.export_ratchet_tree();
    const ratchetTree = tree.to_bytes();
    tree.free();
    return {
      namespaceId,
      epoch: g.epoch,
      ratchetTree,
      roster: this.authoritativeRoster(g),
    };
  }
}
