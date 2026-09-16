/**
 * Real MLS-backed group provider (roadmap item 3), using `ts-mls` (RFC 9420).
 *
 * This runs a genuine MLS group across many simulated member devices in one
 * process: real key packages, real Add/Remove commits, real Welcomes + joins,
 * and members kept in sync by processing each commit. The lattice per-epoch
 * root is derived from the group's real MLS exporter secret.
 *
 * Key modelling decision — MLS epoch vs LATTICE epoch:
 *   Every MLS commit advances the MLS epoch. The separate lattice epoch advances
 *   when a principal is added or removed, but not when another device for an
 *   already-authorized user joins. This prevents a newly invited user from
 *   receiving pre-join history while preserving same-user device continuity.
 *
 * Sandbox simplification (not shipped to prod): this one object simulates all
 * device-local member states and holds retained per-epoch roots centrally.
 * Production must distribute/restore those roots per device without putting
 * exporter-capable state on the server.
 *
 * Ciphersuite: DHKEM-P521 + AES-256-GCM + Ed... (P-521). Rationale for P-521
 * specifically:
 *   - X25519 is unavailable: ts-mls routes the DHKEM through @hpke/core
 *     (WebCrypto), and Bun's WebCrypto has no X25519.
 *   - P-256 / P-384 intermittently throw `DeserializeError: Invalid private
 *     key` in ts-mls 1.6.2 (~1/256) when a private scalar has a leading zero
 *     byte — ts-mls does NOT left-pad them.
 *   - P-521 IS left-padded by ts-mls (`prepadPrivateKeyP521`), so it has no
 *     leading-zero edge case, and P-521 ECDH works in Bun's WebCrypto.
 * (Production uses OpenMLS, not ts-mls — see docs/security-primitives.md.)
 */

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { LATTICE_LIMITS } from "../limits.ts";
import {
  acceptAll,
  createCommit,
  createGroup,
  defaultCapabilities,
  defaultLifetime,
  emptyPskIndex,
  generateKeyPackage,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  joinGroup,
  mlsExporter,
  processMessage,
  type CiphersuiteImpl,
  type CiphersuiteName,
  type ClientState,
  type Credential,
  type Proposal,
} from "ts-mls";
import type { DeviceId, Epoch, NamespaceId, UserId } from "../types/index.ts";
import type {
  GroupKeyProvider,
  GroupMember,
  GroupRosterEntry,
} from "./provider.ts";

const ROOT_LABEL = "lattice-root";
const ROOT_LEN = 32;

interface Member {
  deviceId: DeviceId;
  userId: UserId;
  leafIndex: number;
  state: ClientState;
  roots: Map<Epoch, Uint8Array>;
}

interface MlsGroup {
  namespaceId: NamespaceId;
  committerDeviceId: DeviceId | null;
  members: Map<DeviceId, Member>;
  epoch: Epoch; // lattice epoch (principal add/remove, not same-user device add)
}

function credentialFor(deviceId: DeviceId): Credential {
  return { credentialType: "basic", identity: new TextEncoder().encode(deviceId) };
}

export class MlsGroupProvider implements GroupKeyProvider {
  readonly id = "mls";
  private impl!: CiphersuiteImpl;
  private readonly ready: Promise<void>;
  private readonly groups = new Map<NamespaceId, MlsGroup>();

  constructor(ciphersuiteName: CiphersuiteName = "MLS_256_DHKEMP521_AES256GCM_SHA512_P521") {
    this.ready = getCiphersuiteImpl(getCiphersuiteFromName(ciphersuiteName)).then(
      (impl) => {
        this.impl = impl;
      },
    );
  }

  private group(namespaceId: NamespaceId): MlsGroup {
    const g = this.groups.get(namespaceId);
    if (!g) throw new Error(`MlsGroupProvider: unknown group ${namespaceId}`);
    return g;
  }

  private assertRetentionCapacity(members: Iterable<Member>): void {
    for (const member of members) {
      if (member.roots.size >= LATTICE_LIMITS.retainedEpochsPerDevice) {
        throw new Error("retained epoch limit reached");
      }
    }
  }

  private creator(g: MlsGroup): Member {
    if (!g.committerDeviceId) {
      throw new Error("MlsGroupProvider: group has no current devices");
    }
    const c = g.members.get(g.committerDeviceId);
    if (!c) throw new Error("MlsGroupProvider: creator left the group (unsupported)");
    return c;
  }

  private async rootFrom(g: MlsGroup): Promise<Uint8Array> {
    return mlsExporter(
      this.creator(g).state.keySchedule.exporterSecret,
      ROOT_LABEL,
      new Uint8Array(0),
      ROOT_LEN,
      this.impl,
    );
  }

  private async commitAdd(g: MlsGroup, newMember: GroupMember): Promise<void> {
    if (g.members.has(newMember.deviceId)) return;
    if (g.members.size === 0) {
      const keyPackage = await generateKeyPackage(
        credentialFor(newMember.deviceId),
        defaultCapabilities(),
        defaultLifetime,
        [],
        this.impl,
      );
      const state = await createGroup(
        new TextEncoder().encode(g.namespaceId),
        keyPackage.publicPackage,
        keyPackage.privatePackage,
        [],
        this.impl,
      );
      g.committerDeviceId = newMember.deviceId;
      g.members.set(newMember.deviceId, {
        ...newMember,
        leafIndex: state.privatePath.leafIndex,
        state,
        roots: new Map(),
      });
      const root = await this.rootFrom(g);
      g.members.get(newMember.deviceId)?.roots.set(g.epoch, root);
      this.assertRosterParity(g);
      return;
    }
    const kp = await generateKeyPackage(
      credentialFor(newMember.deviceId),
      defaultCapabilities(),
      defaultLifetime,
      [],
      this.impl,
    );
    const proposal: Proposal = { proposalType: "add", add: { keyPackage: kp.publicPackage } };
    const creator = this.creator(g);
    const commit = await createCommit(
      { state: creator.state, cipherSuite: this.impl },
      { extraProposals: [proposal] },
    );
    creator.state = commit.newState;
    await this.syncOthers(
      g,
      commit.commit,
      new Set([g.committerDeviceId as DeviceId]),
    );
    const joined = await joinGroup(
      commit.welcome!,
      kp.publicPackage,
      kp.privatePackage,
      emptyPskIndex,
      this.impl,
      creator.state.ratchetTree,
    );
    g.members.set(newMember.deviceId, {
      ...newMember,
      leafIndex: joined.privatePath.leafIndex,
      state: joined,
      roots: new Map(),
    });
    this.assertRosterParity(g);
  }

  private async commitRemove(g: MlsGroup, deviceId: DeviceId): Promise<void> {
    const target = g.members.get(deviceId);
    if (!target) return;
    if (g.members.size < 2) {
      g.members.delete(deviceId);
      g.committerDeviceId = null;
      return;
    }
    if (g.committerDeviceId === deviceId) {
      const replacement = [...g.members.keys()].find((id) => id !== deviceId);
      if (!replacement) throw new Error("MlsGroupProvider: no replacement committer");
      g.committerDeviceId = replacement;
    }
    const proposal: Proposal = {
      proposalType: "remove",
      remove: { removed: target.leafIndex },
    };
    const creator = this.creator(g);
    const commit = await createCommit(
      { state: creator.state, cipherSuite: this.impl },
      { extraProposals: [proposal] },
    );
    creator.state = commit.newState;
    const committerDeviceId = g.committerDeviceId;
    if (!committerDeviceId) {
      throw new Error("MlsGroupProvider: missing committer after removal");
    }
    await this.syncOthers(
      g,
      commit.commit,
      new Set([committerDeviceId, deviceId]),
    );
    g.members.delete(deviceId);
    this.assertRosterParity(g);
  }

  /** Apply a commit to every current member except those in `skip`. */
  private async syncOthers(
    g: MlsGroup,
    commit: Awaited<ReturnType<typeof createCommit>>["commit"],
    skip: Set<DeviceId>,
  ): Promise<void> {
    if (commit.wireformat !== "mls_private_message" && commit.wireformat !== "mls_public_message") {
      throw new Error(`MlsGroupProvider: unexpected commit wireformat ${commit.wireformat}`);
    }
    for (const m of g.members.values()) {
      if (skip.has(m.deviceId)) continue;
      const result = await processMessage(commit, m.state, emptyPskIndex, acceptAll, this.impl);
      if (result.kind === "newState") m.state = result.newState;
    }
  }

  private authoritativeRoster(g: MlsGroup): GroupRosterEntry[] {
    const creator = this.creator(g);
    const roster: GroupRosterEntry[] = [];
    for (const [nodeIndex, node] of creator.state.ratchetTree.entries()) {
      if (node?.nodeType !== "leaf") continue;
      const credential = node.leaf.credential;
      if (credential.credentialType !== "basic") {
        throw new Error("MlsGroupProvider: non-basic credential in roster");
      }
      const deviceId = new TextDecoder().decode(credential.identity);
      const member = g.members.get(deviceId);
      if (!member) {
        throw new Error(`MlsGroupProvider: unknown MLS credential ${deviceId}`);
      }
      roster.push({ deviceId, userId: member.userId, leafIndex: nodeIndex / 2 });
    }
    return roster.sort((a, b) => a.leafIndex - b.leafIndex);
  }

  private assertRosterParity(g: MlsGroup): void {
    const authoritative = this.authoritativeRoster(g);
    if (authoritative.length !== g.members.size) {
      throw new Error("MlsGroupProvider: MLS roster/member map size mismatch");
    }
    for (const entry of authoritative) {
      const member = g.members.get(entry.deviceId);
      if (!member || member.leafIndex !== entry.leafIndex) {
        throw new Error(`MlsGroupProvider: MLS roster mismatch for ${entry.deviceId}`);
      }
    }
  }

  async initGroup(namespaceId: NamespaceId, members: GroupMember[]): Promise<void> {
    await this.ready;
    if (this.groups.has(namespaceId)) return;
    const creatorMember = members[0];
    if (!creatorMember) throw new Error("MlsGroupProvider: initGroup needs >= 1 device");

    const creatorKp = await generateKeyPackage(
      credentialFor(creatorMember.deviceId),
      defaultCapabilities(),
      defaultLifetime,
      [],
      this.impl,
    );
    const creatorState = await createGroup(
      new TextEncoder().encode(namespaceId),
      creatorKp.publicPackage,
      creatorKp.privatePackage,
      [],
      this.impl,
    );

    const g: MlsGroup = {
      namespaceId,
      committerDeviceId: creatorMember.deviceId,
      members: new Map([
        [
          creatorMember.deviceId,
          {
            ...creatorMember,
            leafIndex: creatorState.privatePath.leafIndex,
            state: creatorState,
            roots: new Map(),
          },
        ],
      ]),
      epoch: 0,
    };
    this.groups.set(namespaceId, g);

    for (const member of members.slice(1)) await this.commitAdd(g, member);
    this.assertRosterParity(g);
    const root = await this.rootFrom(g);
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
    for (const member of members) await this.commitAdd(g, member);
    // No lattice-epoch bump; the current root stays valid.
  }

  async addDevicesAndRotate(
    namespaceId: NamespaceId,
    members: GroupMember[],
  ): Promise<Epoch> {
    await this.ready;
    const g = this.group(namespaceId);
    this.assertRetentionCapacity(g.members.values());
    for (const member of members) await this.commitAdd(g, member);
    g.epoch += 1;
    const root = await this.rootFrom(g);
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
    for (const deviceId of deviceIds) await this.commitRemove(g, deviceId);
    g.epoch += 1;
    if (g.members.size > 0) {
      const root = await this.rootFrom(g);
      for (const member of g.members.values()) {
        member.roots.set(g.epoch, root.slice());
      }
    }
    return g.epoch;
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
      throw new Error(`MlsGroupProvider: device ${deviceId} is not a current member`);
    }
    const root = group.members.get(deviceId)?.roots.get(epoch);
    if (!root) throw new Error(`MlsGroupProvider: no root for ${namespaceId}@${epoch}`);
    return hkdf(sha256, root, new Uint8Array(0), new TextEncoder().encode(`mls-exporter/${label}`), ROOT_LEN);
  }

  roster(namespaceId: NamespaceId): GroupRosterEntry[] {
    const group = this.group(namespaceId);
    return group.members.size === 0 ? [] : this.authoritativeRoster(group);
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
}
