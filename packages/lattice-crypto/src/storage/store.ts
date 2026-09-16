import type {
  AuditEntry,
  Device,
  DeviceId,
  EncryptedObject,
  Grant,
  GrantId,
  NamespaceId,
  NamespaceRecord,
  ObjectId,
  UserId,
} from "../types/index.ts";

/**
 * The persistence seam. In M0 this is `InMemoryRelationalStore`; the Nautilo
 * bridge will implement the same interface over Drizzle/Postgres. The method
 * shapes are deliberately relational and mirror the real tables so the bridge
 * is a mechanical transcription, not a redesign. Every operation is async:
 * implementations may cross a process/network boundary and callers must
 * observe read/write failures before continuing.
 *
 * Storage persists STATE ONLY — never key material in plaintext, never any
 * crypto logic. Only public keys, ciphertext, wrapped keys, and grants live
 * here.
 */
export interface Storage {
  // users
  putUser(id: UserId): Promise<void>;
  listUsers(): Promise<UserId[]>;

  // devices
  putDevice(device: Device): Promise<void>;
  getDevice(id: DeviceId): Promise<Device | null>;
  listDevices(userId: UserId): Promise<Device[]>;
  authorizeDevice(id: DeviceId): Promise<void>;
  revokeDevice(id: DeviceId): Promise<void>;

  // namespaces (mirror: `namespaces` + `rooms.human_actor_ids`)
  putNamespace(ns: NamespaceRecord): Promise<void>;
  getNamespace(id: NamespaceId): Promise<NamespaceRecord | null>;
  findNamespaceByParticipants(canonical: UserId[]): Promise<NamespaceRecord | null>;
  listNamespaces(): Promise<NamespaceRecord[]>;
  /** Mirrors `findReadableNamespacesForSubset`: every N with `scope ⊆ N`.
   * Production adapters must apply the supplied SQL LIMIT before returning. */
  findNamespacesContainingSubset(
    scope: UserId[],
    limit: number,
  ): Promise<NamespaceRecord[]>;
  updateNamespace(
    id: NamespaceId,
    patch: Partial<Pick<NamespaceRecord, "participants" | "currentEpoch">>,
  ): Promise<void>;

  // objects (mirror: `memories`/`artifacts` + `*_namespaces` junction)
  putObject(obj: EncryptedObject): Promise<void>;
  getObject(id: ObjectId): Promise<EncryptedObject | null>;
  /** Bulk fetch mirroring `WHERE id IN (...)`. Returns only the objects that
   *  exist; missing ids are simply absent (the caller aligns by id). Order is
   *  not guaranteed. This is the batch-read primitive the bridge uses to keep DB
   *  round-trips O(1) instead of O(objects). */
  getObjects(ids: ObjectId[]): Promise<EncryptedObject[]>;
  listObjectsInNamespace(namespaceId: NamespaceId): Promise<EncryptedObject[]>;

  // grants
  putGrant(grant: Grant): Promise<void>;
  getGrant(id: GrantId): Promise<Grant | null>;
  /** Atomic single-use consume: returns the grant and marks it consumed the
   *  first time; returns null on every subsequent call. A production adapter
   *  must implement this as one conditional update across workers/processes,
   *  e.g. `UPDATE ... WHERE consumed = false RETURNING ...`, not a read followed
   *  by a write. Once claimed, an execution failure does not roll the grant
   *  back. An adapter error may be an ambiguous commit outcome: the engine
   *  propagates it and MUST NOT automatically retry the claim or operation.
   *  A later explicit attempt re-reads stored consumption state and either
   *  denies the spent grant or performs a new conditional claim. */
  consumeGrant(id: GrantId): Promise<Grant | null>;

  // audit
  appendAudit(entry: AuditEntry): Promise<void>;
  auditLog(): Promise<AuditEntry[]>;
}
