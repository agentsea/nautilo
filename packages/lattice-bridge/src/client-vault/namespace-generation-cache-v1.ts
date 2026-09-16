import type { ClientProfileCoordinates } from "./types.ts";

export const CLIENT_NAMESPACE_GENERATION_CACHE_FORMAT_VERSION_V1 = 1 as const;
export const CLIENT_NAMESPACE_GENERATION_CACHE_MAX_ENTRIES_V1 = 512 as const;
export const CLIENT_NAMESPACE_GENERATION_CACHE_MAX_PENDING_V1 = 2 as const;
const CLIENT_NAMESPACE_GENERATION_CACHE_MAX_PUBLICATION_BYTES_V1 =
  8_388_608 as const;

const HASH_BYTES = 32;

export interface ClientNamespaceGenerationCacheRequirementV1 {
  readonly namespaceId: string;
  readonly keyClass: "ai" | "human";
  readonly accessRevision: number;
  readonly generation: number;
  readonly headDigest: Uint8Array;
  readonly publicationDigest: Uint8Array;
  readonly publicationSetDigest: Uint8Array;
  readonly audienceFingerprint: Uint8Array;
  readonly recipientKeyGeneration: number;
}

export interface ClientNamespaceGenerationCacheEntryV1
  extends ClientNamespaceGenerationCacheRequirementV1 {
  readonly generationKey: Uint8Array;
}

export interface PendingClientNamespaceGenerationPublicationV1 {
  readonly formatVersion:
    typeof CLIENT_NAMESPACE_GENERATION_CACHE_FORMAT_VERSION_V1;
  readonly operationId: string;
  readonly namespaceId: string;
  readonly expiresAt: number;
  readonly publicationSetBytes: Uint8Array;
  readonly entries: readonly ClientNamespaceGenerationCacheEntryV1[];
}

export type ClientNamespaceGenerationCacheAvailabilityV1 = Readonly<{
  status: "available" | "locked" | "unsupported" | "corrupt" | "storage_lost";
  reasonCode?: string;
}>;

export interface ClientNamespaceGenerationCacheVaultV1 {
  availability(): Promise<ClientNamespaceGenerationCacheAvailabilityV1>;
  unlock(): Promise<ClientNamespaceGenerationCacheAvailabilityV1>;
  lock(): Promise<void>;
  withEntries<Value>(
    coordinates: ClientProfileCoordinates,
    requirements: readonly ClientNamespaceGenerationCacheRequirementV1[],
    use: (
      entries: readonly ClientNamespaceGenerationCacheEntryV1[],
    ) => Promise<Value> | Value,
  ): Promise<Readonly<{ status: "hit"; value: Value }> | Readonly<{
    status: "miss";
  }>>;
  putEntries(
    coordinates: ClientProfileCoordinates,
    entries: readonly ClientNamespaceGenerationCacheEntryV1[],
  ): Promise<void>;
  stagePublication(
    coordinates: ClientProfileCoordinates,
    publication: PendingClientNamespaceGenerationPublicationV1,
  ): Promise<void>;
  withPendingPublication<Value>(
    coordinates: ClientProfileCoordinates,
    operationId: string,
    use: (
      publication: PendingClientNamespaceGenerationPublicationV1,
    ) => Promise<Value> | Value,
  ): Promise<Readonly<{ status: "present"; value: Value }> | Readonly<{
    status: "absent";
  }>>;
  activatePublication(
    coordinates: ClientProfileCoordinates,
    operationId: string,
  ): Promise<void>;
  abortPublication(
    coordinates: ClientProfileCoordinates,
    operationId: string,
  ): Promise<void>;
  pruneExpiredPublications?(
    coordinates: ClientProfileCoordinates,
    now: number,
  ): Promise<number>;
  evict(
    coordinates: ClientProfileCoordinates,
    namespaceId?: string,
  ): Promise<void>;
  forget(coordinates: ClientProfileCoordinates): Promise<void>;
}

export function pendingNamespaceGenerationPublicationExpiredV1(
  input: PendingClientNamespaceGenerationPublicationV1,
  now: number,
): boolean {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError("Namespace publication reconciliation time is invalid");
  }
  return counter("Namespace publication expiry", input.expiresAt) <= now;
}

function exactBytes(label: string, value: Uint8Array, length?: number): Uint8Array {
  if (
    !(value instanceof Uint8Array)
    || (length !== undefined && value.length !== length)
  ) throw new TypeError(`${label} bytes are invalid`);
  return value.slice();
}

function counter(label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function portable(label: string, value: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 256
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value)
  ) throw new TypeError(`${label} is invalid`);
  return value;
}

export function copyClientNamespaceGenerationCacheRequirementV1(
  input: ClientNamespaceGenerationCacheRequirementV1,
): ClientNamespaceGenerationCacheRequirementV1 {
  return Object.freeze({
    namespaceId: portable("Namespace", input.namespaceId),
    keyClass: input.keyClass === "ai" || input.keyClass === "human"
      ? input.keyClass
      : (() => { throw new TypeError("Namespace key class is invalid"); })(),
    accessRevision: counter("Namespace access revision", input.accessRevision),
    generation: counter("Namespace generation", input.generation),
    headDigest: exactBytes("Namespace head digest", input.headDigest, HASH_BYTES),
    publicationDigest: exactBytes(
      "Namespace publication digest",
      input.publicationDigest,
      HASH_BYTES,
    ),
    publicationSetDigest: exactBytes(
      "Namespace publication-set digest",
      input.publicationSetDigest,
      HASH_BYTES,
    ),
    audienceFingerprint: exactBytes(
      "Namespace audience fingerprint",
      input.audienceFingerprint,
      HASH_BYTES,
    ),
    recipientKeyGeneration: counter(
      "Namespace recipient key generation",
      input.recipientKeyGeneration,
    ),
  });
}

export function copyClientNamespaceGenerationCacheEntryV1(
  input: ClientNamespaceGenerationCacheEntryV1,
): ClientNamespaceGenerationCacheEntryV1 {
  return Object.freeze({
    ...copyClientNamespaceGenerationCacheRequirementV1(input),
    generationKey: exactBytes(
      "Namespace generation key",
      input.generationKey,
      32,
    ),
  });
}

export function destroyClientNamespaceGenerationCacheEntryV1(
  entry: ClientNamespaceGenerationCacheEntryV1,
): void {
  entry.headDigest.fill(0);
  entry.publicationDigest.fill(0);
  entry.publicationSetDigest.fill(0);
  entry.audienceFingerprint.fill(0);
  entry.generationKey.fill(0);
}

export function destroyPendingClientNamespaceGenerationPublicationV1(
  publication: PendingClientNamespaceGenerationPublicationV1,
): void {
  publication.publicationSetBytes.fill(0);
  publication.entries.forEach(destroyClientNamespaceGenerationCacheEntryV1);
}

function entryKey(
  entry: ClientNamespaceGenerationCacheRequirementV1,
): string {
  return `${entry.namespaceId}\u0000${entry.keyClass}\u0000${String(entry.generation)}`;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameRequirement(
  left: ClientNamespaceGenerationCacheRequirementV1,
  right: ClientNamespaceGenerationCacheRequirementV1,
): boolean {
  return entryKey(left) === entryKey(right)
    && left.accessRevision === right.accessRevision
    && left.recipientKeyGeneration === right.recipientKeyGeneration
    && sameBytes(left.headDigest, right.headDigest)
    && sameBytes(left.publicationDigest, right.publicationDigest)
    && sameBytes(left.publicationSetDigest, right.publicationSetDigest)
    && sameBytes(left.audienceFingerprint, right.audienceFingerprint);
}

function sameEntry(
  left: ClientNamespaceGenerationCacheEntryV1,
  right: ClientNamespaceGenerationCacheEntryV1,
): boolean {
  return sameRequirement(left, right)
    && sameBytes(left.generationKey, right.generationKey);
}

function coordinateKey(coordinates: ClientProfileCoordinates): string {
  return JSON.stringify([
    coordinates.serverScope,
    coordinates.userId,
    coordinates.humanActorId,
    coordinates.profileId,
    coordinates.deviceId,
    coordinates.installationLineageDigest,
  ]);
}

interface MemoryState {
  readonly entries: Map<string, ClientNamespaceGenerationCacheEntryV1>;
  readonly pending: Map<string, PendingClientNamespaceGenerationPublicationV1>;
}

/** Deterministic test/platform fallback; production Browser uses sealed IDB. */
export class MemoryClientNamespaceGenerationCacheVaultV1
implements ClientNamespaceGenerationCacheVaultV1 {
  readonly #states = new Map<string, MemoryState>();
  #locked = false;

  availability(): Promise<ClientNamespaceGenerationCacheAvailabilityV1> {
    return Promise.resolve({ status: this.#locked ? "locked" : "available" });
  }

  unlock(): Promise<ClientNamespaceGenerationCacheAvailabilityV1> {
    this.#locked = false;
    return Promise.resolve({ status: "available" });
  }

  lock(): Promise<void> {
    this.#locked = true;
    return Promise.resolve();
  }

  async withEntries<Value>(
    coordinates: ClientProfileCoordinates,
    requirements: readonly ClientNamespaceGenerationCacheRequirementV1[],
    use: (
      entries: readonly ClientNamespaceGenerationCacheEntryV1[],
    ) => Promise<Value> | Value,
  ): Promise<Readonly<{ status: "hit"; value: Value }> | Readonly<{
    status: "miss";
  }>> {
    this.#assertOpen();
    const state = this.#state(coordinates);
    const selected: ClientNamespaceGenerationCacheEntryV1[] = [];
    try {
      for (const requirement of requirements) {
        const normalized = copyClientNamespaceGenerationCacheRequirementV1(
          requirement,
        );
        const entry = state.entries.get(entryKey(normalized));
        if (entry === undefined || !sameRequirement(entry, normalized)) {
          return Object.freeze({ status: "miss" as const });
        }
        selected.push(copyClientNamespaceGenerationCacheEntryV1(entry));
      }
      return Object.freeze({
        status: "hit" as const,
        value: await use(Object.freeze(selected)),
      });
    } finally {
      selected.forEach(destroyClientNamespaceGenerationCacheEntryV1);
    }
  }

  putEntries(
    coordinates: ClientProfileCoordinates,
    entries: readonly ClientNamespaceGenerationCacheEntryV1[],
  ): Promise<void> {
    this.#assertOpen();
    const state = this.#state(coordinates);
    for (const candidate of entries) {
      const entry = copyClientNamespaceGenerationCacheEntryV1(candidate);
      const key = entryKey(entry);
      const current = state.entries.get(key);
      if (current !== undefined && !sameEntry(current, entry)) {
        destroyClientNamespaceGenerationCacheEntryV1(entry);
        throw new TypeError("Namespace cache entry collided");
      }
      if (current === undefined) state.entries.set(key, entry);
      else destroyClientNamespaceGenerationCacheEntryV1(entry);
    }
    while (state.entries.size > CLIENT_NAMESPACE_GENERATION_CACHE_MAX_ENTRIES_V1) {
      const oldest = state.entries.keys().next().value;
      if (oldest === undefined) break;
      const removed = state.entries.get(oldest);
      if (removed === undefined) break;
      destroyClientNamespaceGenerationCacheEntryV1(removed);
      state.entries.delete(oldest);
    }
    return Promise.resolve();
  }

  stagePublication(
    coordinates: ClientProfileCoordinates,
    publication: PendingClientNamespaceGenerationPublicationV1,
  ): Promise<void> {
    this.#assertOpen();
    const state = this.#state(coordinates);
    const candidate = copyPendingClientNamespaceGenerationPublicationV1(
      publication,
    );
    const current = state.pending.get(candidate.operationId);
    if (current !== undefined) {
      const matches = samePending(current, candidate);
      destroyPendingClientNamespaceGenerationPublicationV1(candidate);
      if (!matches) throw new TypeError("Namespace publication stage collided");
      return Promise.resolve();
    }
    if (state.pending.size >= CLIENT_NAMESPACE_GENERATION_CACHE_MAX_PENDING_V1) {
      destroyPendingClientNamespaceGenerationPublicationV1(candidate);
      throw new RangeError("Namespace publication stage inventory is full");
    }
    state.pending.set(candidate.operationId, candidate);
    return Promise.resolve();
  }

  async withPendingPublication<Value>(
    coordinates: ClientProfileCoordinates,
    operationId: string,
    use: (
      publication: PendingClientNamespaceGenerationPublicationV1,
    ) => Promise<Value> | Value,
  ): Promise<Readonly<{ status: "present"; value: Value }> | Readonly<{
    status: "absent";
  }>> {
    this.#assertOpen();
    const current = this.#state(coordinates).pending.get(operationId);
    if (current === undefined) return Object.freeze({ status: "absent" });
    const copy = copyPendingClientNamespaceGenerationPublicationV1(current);
    try {
      return Object.freeze({
        status: "present" as const,
        value: await use(copy),
      });
    } finally {
      destroyPendingClientNamespaceGenerationPublicationV1(copy);
    }
  }

  async activatePublication(
    coordinates: ClientProfileCoordinates,
    operationId: string,
  ): Promise<void> {
    this.#assertOpen();
    const state = this.#state(coordinates);
    const pending = state.pending.get(operationId);
    if (pending === undefined) throw new TypeError("Namespace publication stage is absent");
    await this.putEntries(coordinates, pending.entries);
    state.pending.delete(operationId);
    destroyPendingClientNamespaceGenerationPublicationV1(pending);
  }

  abortPublication(
    coordinates: ClientProfileCoordinates,
    operationId: string,
  ): Promise<void> {
    this.#assertOpen();
    const state = this.#state(coordinates);
    const pending = state.pending.get(operationId);
    if (pending !== undefined) {
      state.pending.delete(operationId);
      destroyPendingClientNamespaceGenerationPublicationV1(pending);
    }
    return Promise.resolve();
  }

  pruneExpiredPublications(
    coordinates: ClientProfileCoordinates,
    now: number,
  ): Promise<number> {
    this.#assertOpen();
    const state = this.#state(coordinates);
    let removed = 0;
    for (const [operationId, pending] of state.pending) {
      if (!pendingNamespaceGenerationPublicationExpiredV1(pending, now)) {
        continue;
      }
      state.pending.delete(operationId);
      destroyPendingClientNamespaceGenerationPublicationV1(pending);
      removed++;
    }
    return Promise.resolve(removed);
  }

  evict(
    coordinates: ClientProfileCoordinates,
    namespaceId?: string,
  ): Promise<void> {
    this.#assertOpen();
    const state = this.#state(coordinates);
    for (const [key, entry] of state.entries) {
      if (namespaceId === undefined || entry.namespaceId === namespaceId) {
        state.entries.delete(key);
        destroyClientNamespaceGenerationCacheEntryV1(entry);
      }
    }
    return Promise.resolve();
  }

  forget(coordinates: ClientProfileCoordinates): Promise<void> {
    this.#assertOpen();
    const key = coordinateKey(coordinates);
    const state = this.#states.get(key);
    if (state !== undefined) {
      state.entries.forEach(destroyClientNamespaceGenerationCacheEntryV1);
      state.pending.forEach(
        destroyPendingClientNamespaceGenerationPublicationV1,
      );
      this.#states.delete(key);
    }
    return Promise.resolve();
  }

  #assertOpen(): void {
    if (this.#locked) throw new TypeError("Namespace cache is locked");
  }

  #state(coordinates: ClientProfileCoordinates): MemoryState {
    const key = coordinateKey(coordinates);
    let state = this.#states.get(key);
    if (state === undefined) {
      state = { entries: new Map(), pending: new Map() };
      this.#states.set(key, state);
    }
    return state;
  }
}

export function copyPendingClientNamespaceGenerationPublicationV1(
  input: PendingClientNamespaceGenerationPublicationV1,
): PendingClientNamespaceGenerationPublicationV1 {
  if (
    input.formatVersion !== CLIENT_NAMESPACE_GENERATION_CACHE_FORMAT_VERSION_V1
    || input.publicationSetBytes.length < 1
    || input.publicationSetBytes.length
      > CLIENT_NAMESPACE_GENERATION_CACHE_MAX_PUBLICATION_BYTES_V1
    || input.entries.length < 2
    || input.entries.length > CLIENT_NAMESPACE_GENERATION_CACHE_MAX_ENTRIES_V1
  ) throw new TypeError("Namespace publication stage is invalid");
  return Object.freeze({
    formatVersion: CLIENT_NAMESPACE_GENERATION_CACHE_FORMAT_VERSION_V1,
    operationId: portable("Namespace publication operation", input.operationId),
    namespaceId: portable("Namespace publication Namespace", input.namespaceId),
    expiresAt: counter("Namespace publication expiry", input.expiresAt),
    publicationSetBytes: input.publicationSetBytes.slice(),
    entries: Object.freeze(
      input.entries.map(copyClientNamespaceGenerationCacheEntryV1),
    ),
  });
}

function samePending(
  left: PendingClientNamespaceGenerationPublicationV1,
  right: PendingClientNamespaceGenerationPublicationV1,
): boolean {
  return left.operationId === right.operationId
    && left.namespaceId === right.namespaceId
    && left.expiresAt === right.expiresAt
    && sameBytes(left.publicationSetBytes, right.publicationSetBytes)
    && left.entries.length === right.entries.length
    && left.entries.every((entry, index) => sameEntry(entry, right.entries[index]!));
}
