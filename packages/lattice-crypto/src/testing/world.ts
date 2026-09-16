import { LatticeCrypto, manualClock, seededRng, type ManualClock } from "../crypto/index.ts";
import {
  LatticeCryptoEngine,
  type DelegationSession,
  type DeviceCapability,
} from "../engine/engine.ts";
import type { GroupKeyProvider } from "../group/provider.ts";
import type { LatticeScheme } from "../lattice/scheme.ts";
import { InMemoryRelationalStore } from "../storage/in-memory-relational-store.ts";
import type { DeviceId, Grant, GrantOperation, NamespaceId, ObjectId, UserId } from "../types/index.ts";
import { fromUtf8, utf8 } from "../util/bytes.ts";

export interface WorldConfig {
  name: string;
  makeGroup: (crypto: LatticeCrypto) => GroupKeyProvider;
  makeScheme: () => LatticeScheme;
}

export interface AgentGrant {
  grant: Grant;
  session: DelegationSession;
}

export type ReadOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: string };

export type WriteOutcome =
  | { ok: true; id: ObjectId }
  | { ok: false; reason: string };

/**
 * Ergonomic test/experiment harness. Wraps the engine with a manual clock +
 * seeded RNG for deterministic runs, and holds device private keys the way a
 * fleet of client devices would. Scenarios and the conformance suite drive
 * everything through this.
 */
export class World {
  readonly engine: LatticeCryptoEngine;
  readonly clock: ManualClock;
  /** The in-memory store — exposed so tests/scenarios can inspect what an
   *  attacker who steals the DB would actually see. */
  readonly store: InMemoryRelationalStore;
  readonly group: GroupKeyProvider;
  private readonly capabilities = new Map<DeviceId, DeviceCapability>();

  constructor(config: WorldConfig, seed = 1) {
    this.clock = manualClock(1_000);
    const crypto = new LatticeCrypto(seededRng(seed), this.clock);
    this.group = config.makeGroup(crypto);
    this.store = new InMemoryRelationalStore();
    this.engine = new LatticeCryptoEngine({
      storage: this.store,
      scheme: config.makeScheme(),
      group: this.group,
      crypto,
    });
  }

  async user(id: UserId): Promise<UserId> {
    await this.engine.registerUser(id);
    return id;
  }

  /** Register a device for a user and stash its signing key. */
  async device(userId: UserId): Promise<DeviceId> {
    const reg = await this.engine.registerDevice(userId);
    if (!reg.device.authorized) {
      const issuer = (await this.engine.listDevices(userId))
        .find((device) =>
          device.authorized &&
          !device.revoked &&
          this.capabilities.has(device.id)
        );
      if (!issuer) {
        throw new Error(`no authorized device can approve ${reg.device.id}`);
      }
      const approval = await this.engine.approveDevice(
        reg.device.id,
        this.deviceCapability(issuer.id),
      );
      await this.engine.acceptDeviceApproval(
        reg.device.id,
        reg.encryptionPrivateKey,
        approval,
      );
      reg.device.authorized = true;
    }
    this.capabilities.set(reg.device.id, reg.capability);
    return reg.device.id;
  }

  /** Test-harness view of one device-held capability. Returns owned key bytes. */
  deviceCapability(deviceId: DeviceId): DeviceCapability {
    const capability = this.capabilities.get(deviceId);
    if (!capability) throw new Error(`no device capability for ${deviceId}`);
    return {
      deviceId: capability.deviceId,
      signingPrivateKey: capability.signingPrivateKey.slice(),
    };
  }

  async namespace(participants: UserId[]): Promise<NamespaceId> {
    for (const userId of participants) {
      const hasActiveDevice = (await this.engine
        .listDevices(userId))
        .some((device) => device.authorized && !device.revoked);
      if (!hasActiveDevice) await this.device(userId);
    }
    return (await this.engine.findOrCreateNamespace(participants)).id;
  }

  async encrypt(
    namespaceId: NamespaceId,
    text: string,
    deviceId?: DeviceId,
  ): Promise<ObjectId> {
    const selectedDevice =
      deviceId ?? this.group.roster(namespaceId)[0]?.deviceId;
    if (!selectedDevice) throw new Error(`namespace ${namespaceId} has no device`);
    const capability = this.capabilities.get(selectedDevice);
    if (!capability) throw new Error(`no device capability for ${selectedDevice}`);
    return (await this.engine.encryptObject(namespaceId, utf8(text), capability)).id;
  }

  /** A member device mints a time-bounded grant sealed to a fresh agent
   *  delegation session. */
  async grantToAgent(
    issuingDeviceId: DeviceId,
    scope: UserId[],
    ttlMs = 2 * 60 * 60 * 1000,
    singleUse = false,
    operations?: GrantOperation[],
  ): Promise<AgentGrant> {
    const issuer = this.capabilities.get(issuingDeviceId);
    if (!issuer) throw new Error(`no device capability for ${issuingDeviceId}`);
    const session = await this.engine.createDelegationSession();
    const grant = await this.engine.mintGrant({
      issuer,
      scope,
      recipientPublicKey: session.keyPair.publicKey,
      ttlMs,
      singleUse,
      ...(operations ? { operations } : {}),
    });
    return { grant, session };
  }

  async agentRead(objectId: ObjectId, agentGrant: AgentGrant): Promise<ReadOutcome> {
    const res = await this.engine.decryptObject(objectId, agentGrant.grant, agentGrant.session);
    return res.ok
      ? { ok: true, text: fromUtf8(res.plaintext) }
      : { ok: false, reason: res.reason };
  }

  /** Batch read: one `decryptMany` call, results aligned 1:1 with `objectIds`. */
  async agentReadMany(
    objectIds: ObjectId[],
    agentGrant: AgentGrant,
  ): Promise<ReadOutcome[]> {
    const res = await this.engine.decryptMany(objectIds, agentGrant.grant, agentGrant.session);
    return res.map((r) =>
      r.ok ? { ok: true, text: fromUtf8(r.plaintext) } : { ok: false, reason: r.reason },
    );
  }

  /** Batch write: one `encryptMany` call, results aligned 1:1 with `items`. */
  async agentWriteMany(
    items: { namespaceId: NamespaceId; text: string }[],
    agentGrant: AgentGrant,
  ): Promise<WriteOutcome[]> {
    const res = await this.engine.encryptMany(
      items.map((i) => ({ namespaceId: i.namespaceId, plaintext: utf8(i.text) })),
      agentGrant.grant,
      agentGrant.session,
    );
    return res.map((r) =>
      r.ok ? { ok: true, id: r.object.id } : { ok: false, reason: r.reason },
    );
  }

  /** The agent authors a new object into a namespace using only its grant. */
  async agentWrite(
    namespaceId: NamespaceId,
    text: string,
    agentGrant: AgentGrant,
  ): Promise<WriteOutcome> {
    const res = await this.engine.encryptWithGrant(
      namespaceId,
      utf8(text),
      agentGrant.grant,
      agentGrant.session,
    );
    return res.ok ? { ok: true, id: res.object.id } : { ok: false, reason: res.reason };
  }

  async removeMember(namespaceId: NamespaceId, user: UserId): Promise<void> {
    await this.engine.removeParticipants(namespaceId, [user]);
  }

  async addMember(namespaceId: NamespaceId, user: UserId): Promise<void> {
    await this.engine.addParticipants(namespaceId, [user]);
  }

  advanceClock(ms: number): void {
    this.clock.advance(ms);
  }
}
