/**
 * Core domain vocabulary. Deliberately application-agnostic: the library
 * knows only Users, Devices, Namespaces, Objects, Grants, Epochs — never
 * Rooms, Memories, Artifacts, or Agents. The Nautilo bridge (later, and in
 * the Nautilo repo, not here) is responsible for translating between the two.
 */

export type UserId = string;
export type DeviceId = string;
export type NamespaceId = string;
export type ObjectId = string;
export type GrantId = string;

/** Monotonic per-namespace generation counter. Bumped on member removal. */
export type Epoch = number;

/**
 * One physical device. Owns an encryption keypair and a signing keypair.
 * Only PUBLIC keys ever live in storage — private keys stay on the device
 * (in these tests, in the `World` harness). Independently revocable.
 */
export interface Device {
  id: DeviceId;
  userId: UserId;
  encryptionPublicKey: Uint8Array;
  signingPublicKey: Uint8Array;
  /** A non-first device remains pending until an existing authorized device or
   * the offline recovery credential approves it. Account login is insufficient. */
  authorized: boolean;
  revoked: boolean;
  createdAt: number;
}

/**
 * A Namespace = an exact participant set + a current epoch. The id is stable
 * across epochs; `participants` and `currentEpoch` mutate when membership
 * changes (mirrors a Nautilo Room whose `human_actor_ids` changes over time).
 */
export interface NamespaceRecord {
  id: NamespaceId;
  participants: UserId[]; // canonical: sorted + unique
  currentEpoch: Epoch;
  createdAt: number;
}

/**
 * An encrypted object belongs to exactly one namespace and was sealed under
 * that namespace's key material at a specific epoch. The DEK exists at rest
 * ONLY in wrapped form. Format v1 authenticates this immutable metadata as AAD.
 */
export interface EncryptedObject {
  formatVersion: 1;
  id: ObjectId;
  namespaceId: NamespaceId;
  epoch: Epoch;
  wrappedDek: Uint8Array;
  ciphertext: Uint8Array;
  createdAt: number;
}

export type GrantOperation = "decrypt" | "encrypt";

/**
 * A time-bounded delegated capability. Minted by a member device, sealed to a
 * recipient's (e.g. the agent's) ephemeral public key. Carries the capability
 * named in `operations` (read via "decrypt", server-side write via "encrypt")
 * only for its bounded lifetime, only to its holder, and only for the epochs
 * captured at mint time (`coveredEpochs`). The set must include the namespace's
 * current epoch, so a rotation invalidates an older grant; a freshly minted
 * grant may also include explicitly authorized retained historical epochs.
 */
export interface Grant {
  formatVersion: 1;
  id: GrantId;
  issuingDeviceId: DeviceId;
  scope: UserId[]; // canonical subset S
  operations: GrantOperation[];
  issuedAt: number;
  expiresAt: number;
  coveredEpochs: Record<NamespaceId, Epoch[]>;
  /** Scheme-produced secret, sealed to the recipient's public key. Opaque. */
  encryptedSecret: Uint8Array;
  scheme: string;
  signature: Uint8Array;
  singleUse: boolean;
  consumed: boolean;
}

export interface AuditEntry {
  at: number;
  event: string;
  detail: Record<string, unknown>;
}
