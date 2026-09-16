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
import { isSubset, participantsKey } from "../util/sets.ts";
import type { Storage } from "./store.ts";

function cloneDevice(device: Device): Device {
  return {
    ...device,
    encryptionPublicKey: device.encryptionPublicKey.slice(),
    signingPublicKey: device.signingPublicKey.slice(),
  };
}

function cloneNamespace(namespace: NamespaceRecord): NamespaceRecord {
  return { ...namespace, participants: [...namespace.participants] };
}

function cloneObject(object: EncryptedObject): EncryptedObject {
  return {
    ...object,
    wrappedDek: object.wrappedDek.slice(),
    ciphertext: object.ciphertext.slice(),
  };
}

function cloneGrant(grant: Grant): Grant {
  return {
    ...grant,
    scope: [...grant.scope],
    operations: [...grant.operations],
    coveredEpochs: Object.fromEntries(
      Object.entries(grant.coveredEpochs).map(([namespaceId, epochs]) => [
        namespaceId,
        [...epochs],
      ]),
    ),
    encryptedSecret: grant.encryptedSecret.slice(),
    signature: grant.signature.slice(),
  };
}

function cloneAuditEntry(entry: AuditEntry): AuditEntry {
  return { ...entry, detail: structuredClone(entry.detail) };
}

/**
 * In-memory store whose internal tables intentionally mirror the Nautilo
 * relational shape — including an `object_namespaces` junction and a subset
 * containment query — but backed by plain Maps. This proves the `Storage`
 * interface is expressible over the real schema BEFORE any Postgres exists,
 * so the eventual bridge is a transcription. Records are detached on both
 * writes and reads to match database value semantics rather than exposing live
 * mutable Map references.
 */
export class InMemoryRelationalStore implements Storage {
  private users = new Set<UserId>();
  private devices = new Map<DeviceId, Device>();
  private namespaces = new Map<NamespaceId, NamespaceRecord>();
  private objects = new Map<ObjectId, EncryptedObject>();
  /** junction: objectId -> set of namespaceIds (mirrors `memory_namespaces`). */
  private objectNamespaces = new Map<ObjectId, Set<NamespaceId>>();
  private grants = new Map<GrantId, Grant>();
  private audit: AuditEntry[] = [];

  putUser(id: UserId): Promise<void> {
    this.users.add(id);
    return Promise.resolve();
  }
  listUsers(): Promise<UserId[]> {
    return Promise.resolve([...this.users]);
  }

  putDevice(device: Device): Promise<void> {
    this.devices.set(device.id, cloneDevice(device));
    return Promise.resolve();
  }
  getDevice(id: DeviceId): Promise<Device | null> {
    const device = this.devices.get(id);
    return Promise.resolve(device ? cloneDevice(device) : null);
  }
  listDevices(userId: UserId): Promise<Device[]> {
    return Promise.resolve(
      [...this.devices.values()]
        .filter((device) => device.userId === userId)
        .map(cloneDevice),
    );
  }
  authorizeDevice(id: DeviceId): Promise<void> {
    const device = this.devices.get(id);
    if (device) this.devices.set(id, { ...device, authorized: true });
    return Promise.resolve();
  }
  revokeDevice(id: DeviceId): Promise<void> {
    const d = this.devices.get(id);
    if (d) this.devices.set(id, { ...d, revoked: true });
    return Promise.resolve();
  }

  putNamespace(ns: NamespaceRecord): Promise<void> {
    this.namespaces.set(ns.id, cloneNamespace(ns));
    return Promise.resolve();
  }
  getNamespace(id: NamespaceId): Promise<NamespaceRecord | null> {
    const namespace = this.namespaces.get(id);
    return Promise.resolve(namespace ? cloneNamespace(namespace) : null);
  }
  findNamespaceByParticipants(
    canonical: UserId[],
  ): Promise<NamespaceRecord | null> {
    const key = participantsKey(canonical);
    for (const ns of this.namespaces.values()) {
      if (participantsKey(ns.participants) === key) {
        return Promise.resolve(cloneNamespace(ns));
      }
    }
    return Promise.resolve(null);
  }
  listNamespaces(): Promise<NamespaceRecord[]> {
    return Promise.resolve([...this.namespaces.values()].map(cloneNamespace));
  }
  findNamespacesContainingSubset(
    scope: UserId[],
    limit: number,
  ): Promise<NamespaceRecord[]> {
    const matches: NamespaceRecord[] = [];
    for (const namespace of this.namespaces.values()) {
      if (!isSubset(scope, namespace.participants)) continue;
      matches.push(cloneNamespace(namespace));
      if (matches.length === limit) break;
    }
    return Promise.resolve(matches);
  }
  updateNamespace(
    id: NamespaceId,
    patch: Partial<Pick<NamespaceRecord, "participants" | "currentEpoch">>,
  ): Promise<void> {
    const ns = this.namespaces.get(id);
    if (!ns) {
      return Promise.reject(new Error(`updateNamespace: unknown namespace ${id}`));
    }
    this.namespaces.set(id, cloneNamespace({ ...ns, ...patch }));
    return Promise.resolve();
  }

  putObject(obj: EncryptedObject): Promise<void> {
    this.objects.set(obj.id, cloneObject(obj));
    const set = this.objectNamespaces.get(obj.id) ?? new Set<NamespaceId>();
    set.add(obj.namespaceId);
    this.objectNamespaces.set(obj.id, set);
    return Promise.resolve();
  }
  getObject(id: ObjectId): Promise<EncryptedObject | null> {
    const object = this.objects.get(id);
    return Promise.resolve(object ? cloneObject(object) : null);
  }
  getObjects(ids: ObjectId[]): Promise<EncryptedObject[]> {
    const out: EncryptedObject[] = [];
    for (const id of ids) {
      const obj = this.objects.get(id);
      if (obj) out.push(cloneObject(obj));
    }
    return Promise.resolve(out);
  }
  listObjectsInNamespace(
    namespaceId: NamespaceId,
  ): Promise<EncryptedObject[]> {
    const out: EncryptedObject[] = [];
    for (const [objectId, nsSet] of this.objectNamespaces) {
      if (!nsSet.has(namespaceId)) continue;
      const obj = this.objects.get(objectId);
      if (obj) out.push(cloneObject(obj));
    }
    return Promise.resolve(out);
  }

  putGrant(grant: Grant): Promise<void> {
    this.grants.set(grant.id, cloneGrant(grant));
    return Promise.resolve();
  }
  getGrant(id: GrantId): Promise<Grant | null> {
    const grant = this.grants.get(id);
    return Promise.resolve(grant ? cloneGrant(grant) : null);
  }
  consumeGrant(id: GrantId): Promise<Grant | null> {
    const g = this.grants.get(id);
    if (!g || g.consumed) return Promise.resolve(null);
    const consumed = { ...g, consumed: true };
    this.grants.set(id, cloneGrant(consumed));
    return Promise.resolve(cloneGrant(consumed));
  }

  appendAudit(entry: AuditEntry): Promise<void> {
    this.audit.push(cloneAuditEntry(entry));
    return Promise.resolve();
  }
  auditLog(): Promise<AuditEntry[]> {
    return Promise.resolve(this.audit.map(cloneAuditEntry));
  }

  /**
   * Debug/validation-only introspection: everything an attacker who steals the
   * DB would see. NOT part of the `Storage` interface. Used by the adversary
   * test battery and the `attacker` play scenario to prove the store is opaque.
   */
  snapshot(): {
    objects: EncryptedObject[];
    grants: Grant[];
    devices: Device[];
    namespaces: NamespaceRecord[];
  } {
    return {
      objects: [...this.objects.values()].map(cloneObject),
      grants: [...this.grants.values()].map(cloneGrant),
      devices: [...this.devices.values()].map(cloneDevice),
      namespaces: [...this.namespaces.values()].map(cloneNamespace),
    };
  }
}
