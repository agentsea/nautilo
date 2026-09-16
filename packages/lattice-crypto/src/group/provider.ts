import type {
  DeviceId,
  Epoch,
  NamespaceId,
  UserId,
} from "../types/index.ts";

/** One authenticated device leaf in a namespace's MLS group. Namespace policy
 * remains user-scoped; cryptographic membership is always device-scoped. */
export interface GroupMember {
  deviceId: DeviceId;
  userId: UserId;
}

/** The authoritative member identity and leaf index reported by MLS. */
export interface GroupRosterEntry extends GroupMember {
  leafIndex: number;
}

/**
 * The membership + epoch + key-schedule substrate. This is the narrow surface
 * the lattice consumes from MLS — nothing more. In the real system this is
 * backed by MLS (RFC 9420); members are HUMAN DEVICES and the exporter secret
 * comes from the group's ratchet tree. Namespace participants remain users,
 * but this seam deliberately accepts only device identities.
 *
 * Swapping dummy -> ts-mls must not require any engine change: that is the
 * whole point of this interface. Human<->human MLS application messaging is
 * deliberately NOT here — that is transport/chat logic (a library non-goal)
 * and lives in the app.
 */
export interface GroupKeyProvider {
  readonly id: string;

  /** Create the group for a namespace at epoch 0. Idempotent. Async because a
   *  real MLS provider (ts-mls) creates a group + key packages here. */
  initGroup(namespaceId: NamespaceId, members: GroupMember[]): Promise<void>;

  currentEpoch(namespaceId: NamespaceId): Epoch;

  /** Add another device for an already-authorized principal. A real MLS commit
   * advances the MLS epoch, but the participant set and lattice epoch remain
   * unchanged; retained roots arrive through explicit device authorization. */
  addDevices(namespaceId: NamespaceId, members: GroupMember[]): Promise<void>;

  /** Add devices for newly invited users and advance the lattice epoch. Unlike
   * same-user device enrollment, this deliberately excludes the new
   * principals from every pre-join retained root. */
  addDevicesAndRotate(
    namespaceId: NamespaceId,
    members: GroupMember[],
  ): Promise<Epoch>;

  /** Remove device leaves. Advances the lattice epoch. Returns the new epoch. */
  removeDevices(namespaceId: NamespaceId, deviceIds: DeviceId[]): Promise<Epoch>;

  /** Current authoritative cryptographic roster, ordered by MLS leaf index. */
  roster(namespaceId: NamespaceId): GroupRosterEntry[];

  /**
   * The per-epoch shared secret, domain-separated by `label`. In MLS terms
   * this derives from the group's exporter secret. Only members can compute
   * it; the engine calls this only in DEVICE-side operations (encrypt /
   * mint-grant), never in the agent-side decrypt path.
   */
  exporterSecret(
    namespaceId: NamespaceId,
    epoch: Epoch,
    label: string,
    deviceId: DeviceId,
  ): Promise<Uint8Array>;

  hasEpochSecret(namespaceId: NamespaceId, epoch: Epoch, deviceId: DeviceId): boolean;

  /** Device-local retained-root inventory and transfer hooks. Implementations
   * must scope these values per device; a central namespace root map is not a
   * valid production model. Callers seal exported roots before relay/storage. */
  retainedEpochs(namespaceId: NamespaceId, deviceId: DeviceId): Epoch[];
  exportEpochSecret(
    namespaceId: NamespaceId,
    epoch: Epoch,
    deviceId: DeviceId,
  ): Promise<Uint8Array>;
  importEpochSecret(
    namespaceId: NamespaceId,
    epoch: Epoch,
    deviceId: DeviceId,
    secret: Uint8Array,
  ): Promise<void>;

  /** Model an authenticated MLS application delivery of the current retained
   * lattice root from one current member device to another. The server only
   * relays ciphertext and never observes the root. */
  deliverCurrentEpochSecret(
    namespaceId: NamespaceId,
    senderDeviceId: DeviceId,
    recipientDeviceId: DeviceId,
  ): Promise<void>;
}
