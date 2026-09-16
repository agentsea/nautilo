/// <reference lib="dom" />

import {
  CLIENT_NAMESPACE_GENERATION_CACHE_FORMAT_VERSION_V1,
  CLIENT_NAMESPACE_GENERATION_CACHE_MAX_ENTRIES_V1,
  CLIENT_NAMESPACE_GENERATION_CACHE_MAX_PENDING_V1,
  copyClientNamespaceGenerationCacheEntryV1,
  copyClientNamespaceGenerationCacheRequirementV1,
  copyPendingClientNamespaceGenerationPublicationV1,
  destroyClientNamespaceGenerationCacheEntryV1,
  destroyPendingClientNamespaceGenerationPublicationV1,
  pendingNamespaceGenerationPublicationExpiredV1,
  type ClientNamespaceGenerationCacheAvailabilityV1,
  type ClientNamespaceGenerationCacheEntryV1,
  type ClientNamespaceGenerationCacheRequirementV1,
  type ClientNamespaceGenerationCacheVaultV1,
  type PendingClientNamespaceGenerationPublicationV1,
} from "../../client-vault/namespace-generation-cache-v1.ts";
import type { ClientProfileCoordinates } from
  "../../client-vault/types.ts";
import { assertClientProfileCoordinates, coordinatesKey } from
  "../../client-vault/validation.ts";

const DATABASE_NAME = "nautilo-namespace-generation-cache-v1";
const DATABASE_VERSION = 1;
const KEY_STORE = "wrapping_keys";
const DOCUMENT_STORE = "cache_documents";
const ROOT_ID = "root";
const DOCUMENT_ID = "namespace-cache";
const LOCK_NAME = "nautilo-namespace-generation-cache-v1";
const NONCE_BYTES = 12;
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

interface KeyRecord {
  readonly id: typeof ROOT_ID;
  readonly formatVersion: 1;
  readonly key: CryptoKey;
}

interface SealedDocument {
  readonly id: typeof DOCUMENT_ID;
  readonly formatVersion: 1;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
}

interface StoredEntry extends ClientNamespaceGenerationCacheEntryV1 {
  readonly coordinates: ClientProfileCoordinates;
  readonly sequence: number;
}

interface StoredPending extends PendingClientNamespaceGenerationPublicationV1 {
  readonly coordinates: ClientProfileCoordinates;
}

interface OpenDocument {
  sequence: number;
  entries: StoredEntry[];
  pending: StoredPending[];
}

function emptyDocument(): OpenDocument {
  return { sequence: 0, entries: [], pending: [] };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error ?? new Error("Namespace cache IndexedDB request failed"),
    );
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(
      transaction.error ?? new Error("Namespace cache transaction aborted"),
    );
    transaction.onerror = () => reject(
      transaction.error ?? new Error("Namespace cache transaction failed"),
    );
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(KEY_STORE)) {
        database.createObjectStore(KEY_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(DOCUMENT_STORE)) {
        database.createObjectStore(DOCUMENT_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error ?? new Error("Namespace cache IndexedDB open failed"),
    );
    request.onblocked = () => reject(
      new Error("Namespace cache IndexedDB upgrade blocked"),
    );
  });
}

async function readRecord<T>(
  database: IDBDatabase,
  storeName: string,
  id: string,
): Promise<T | undefined> {
  const transaction = database.transaction(storeName, "readonly");
  const complete = transactionDone(transaction);
  const value: unknown = await requestResult<unknown>(
    transaction.objectStore(storeName).get(id) as IDBRequest<unknown>,
  );
  await complete;
  return value as T | undefined;
}

async function writeRecord<T>(
  database: IDBDatabase,
  storeName: string,
  value: T,
): Promise<void> {
  const transaction = database.transaction(storeName, "readwrite");
  const complete = transactionDone(transaction);
  transaction.objectStore(storeName).put(value);
  await complete;
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const owned = value.slice();
  return owned.buffer;
}

function aad(): Uint8Array {
  return new TextEncoder().encode(
    "nautilo/namespace-generation-cache-v1/document",
  );
}

function base64url(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function bytes(value: unknown, expected?: number): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError("Namespace cache bytes are invalid");
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4);
  const result = Uint8Array.from(
    atob(padded),
    (character) => character.charCodeAt(0),
  );
  if (
    (expected !== undefined && result.length !== expected)
    || base64url(result) !== value
  ) {
    result.fill(0);
    throw new TypeError("Namespace cache bytes are noncanonical");
  }
  return result;
}

function exactFields(value: unknown, fields: readonly string[]): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length === fields.length
    && fields.every((field) => keys.includes(field));
}

function jsonEntry(entry: StoredEntry) {
  return {
    coordinates: entry.coordinates,
    sequence: entry.sequence,
    namespaceId: entry.namespaceId,
    keyClass: entry.keyClass,
    accessRevision: entry.accessRevision,
    generation: entry.generation,
    headDigest: base64url(entry.headDigest),
    publicationDigest: base64url(entry.publicationDigest),
    publicationSetDigest: base64url(entry.publicationSetDigest),
    audienceFingerprint: base64url(entry.audienceFingerprint),
    recipientKeyGeneration: entry.recipientKeyGeneration,
    generationKey: base64url(entry.generationKey),
  };
}

function jsonPending(
  pending: StoredPending,
  includeExpiry = true,
): Record<string, unknown> {
  const encoded: Record<string, unknown> = {
    coordinates: pending.coordinates,
    formatVersion: pending.formatVersion,
    operationId: pending.operationId,
    namespaceId: pending.namespaceId,
    publicationSetBytes: base64url(pending.publicationSetBytes),
    entries: pending.entries.map((entry) => jsonEntry({
      ...entry,
      coordinates: pending.coordinates,
      sequence: 0,
    })),
  };
  if (includeExpiry) encoded["expiresAt"] = pending.expiresAt;
  return encoded;
}

function encodeDocument(
  document: OpenDocument,
  includePendingExpiry = true,
): Uint8Array {
  const sortedEntries = [...document.entries].sort((left, right) =>
    storedEntryKey(left).localeCompare(storedEntryKey(right))
  );
  const sortedPending = [...document.pending].sort((left, right) =>
    storedPendingKey(left).localeCompare(storedPendingKey(right))
  );
  const encoded = new TextEncoder().encode(JSON.stringify({
    formatVersion: 1,
    sequence: document.sequence,
    entries: sortedEntries.map(jsonEntry),
    pending: sortedPending.map((pending) =>
      jsonPending(pending, includePendingExpiry)
    ),
  }));
  if (encoded.length > MAX_DOCUMENT_BYTES) {
    encoded.fill(0);
    throw new RangeError("Namespace cache document exceeds its byte bound");
  }
  return encoded;
}

function decodeCoordinates(value: unknown): ClientProfileCoordinates {
  if (!exactFields(value, [
    "serverScope",
    "userId",
    "humanActorId",
    "profileId",
    "deviceId",
    "installationLineageDigest",
  ])) throw new TypeError("Namespace cache coordinates are invalid");
  const coordinates = value as ClientProfileCoordinates;
  assertClientProfileCoordinates(coordinates);
  return Object.freeze({ ...coordinates });
}

const ENTRY_FIELDS = [
  "coordinates",
  "sequence",
  "namespaceId",
  "keyClass",
  "accessRevision",
  "generation",
  "headDigest",
  "publicationDigest",
  "publicationSetDigest",
  "audienceFingerprint",
  "recipientKeyGeneration",
  "generationKey",
] as const;

function decodeEntry(value: unknown): StoredEntry {
  if (!exactFields(value, ENTRY_FIELDS)) {
    throw new TypeError("Namespace cache entry is invalid");
  }
  const raw = value as Record<string, unknown>;
  if (!Number.isSafeInteger(raw["sequence"]) || Number(raw["sequence"]) < 0) {
    throw new TypeError("Namespace cache sequence is invalid");
  }
  const headDigest = bytes(raw["headDigest"], 32);
  const publicationDigest = bytes(raw["publicationDigest"], 32);
  const publicationSetDigest = bytes(raw["publicationSetDigest"], 32);
  const audienceFingerprint = bytes(raw["audienceFingerprint"], 32);
  const generationKey = bytes(raw["generationKey"], 32);
  try {
    const normalized = copyClientNamespaceGenerationCacheEntryV1({
      namespaceId: String(raw["namespaceId"]),
      keyClass: raw["keyClass"] as "ai" | "human",
      accessRevision: Number(raw["accessRevision"]),
      generation: Number(raw["generation"]),
      headDigest,
      publicationDigest,
      publicationSetDigest,
      audienceFingerprint,
      recipientKeyGeneration: Number(raw["recipientKeyGeneration"]),
      generationKey,
    });
    return Object.freeze({
      ...normalized,
      coordinates: decodeCoordinates(raw["coordinates"]),
      sequence: Number(raw["sequence"]),
    });
  } finally {
    headDigest.fill(0);
    publicationDigest.fill(0);
    publicationSetDigest.fill(0);
    audienceFingerprint.fill(0);
    generationKey.fill(0);
  }
}

function decodePending(value: unknown): StoredPending {
  const fields = [
    "coordinates",
    "formatVersion",
    "operationId",
    "namespaceId",
    "expiresAt",
    "publicationSetBytes",
    "entries",
  ] as const;
  const legacyFields = fields.filter((field) => field !== "expiresAt");
  if (!exactFields(value, fields) && !exactFields(value, legacyFields)) {
    throw new TypeError("Namespace cache pending publication is invalid");
  }
  const raw = value as Record<string, unknown>;
  if (
    raw["formatVersion"] !== 1
    || !Array.isArray(raw["entries"])
    || raw["entries"].length < 2
    || raw["entries"].length > CLIENT_NAMESPACE_GENERATION_CACHE_MAX_ENTRIES_V1
  ) throw new TypeError("Namespace cache pending publication is invalid");
  const coordinates = decodeCoordinates(raw["coordinates"]);
  const entries: ClientNamespaceGenerationCacheEntryV1[] = [];
  let publicationSetBytes: Uint8Array | undefined;
  try {
    for (const entry of raw["entries"]) {
      const decoded = decodeEntry(entry);
      try {
        entries.push(copyClientNamespaceGenerationCacheEntryV1(decoded));
      } finally {
        destroyClientNamespaceGenerationCacheEntryV1(decoded);
      }
    }
    publicationSetBytes = bytes(raw["publicationSetBytes"]);
    return Object.freeze({
      formatVersion: CLIENT_NAMESPACE_GENERATION_CACHE_FORMAT_VERSION_V1,
      operationId: String(raw["operationId"]),
      namespaceId: String(raw["namespaceId"]),
      // Pre-reconciliation local records had no expiry coordinate and cannot
      // be resumed after their 30-second server admission. Treat them as
      // already expired so the durable envelope can be refetched instead.
      expiresAt: raw["expiresAt"] === undefined
        ? 0
        : Number(raw["expiresAt"]),
      publicationSetBytes,
      entries: Object.freeze(entries),
      coordinates,
    });
  } catch (error) {
    publicationSetBytes?.fill(0);
    entries.forEach(destroyClientNamespaceGenerationCacheEntryV1);
    throw error;
  }
}

function decodeDocument(plaintext: Uint8Array): OpenDocument {
  if (plaintext.length < 1 || plaintext.length > MAX_DOCUMENT_BYTES) {
    throw new TypeError("Namespace cache document is invalid");
  }
  const raw: unknown = JSON.parse(new TextDecoder("utf-8", {
    fatal: true,
  }).decode(plaintext));
  if (!exactFields(raw, ["formatVersion", "sequence", "entries", "pending"])) {
    throw new TypeError("Namespace cache document is invalid");
  }
  const value = raw as Record<string, unknown>;
  if (
    value["formatVersion"] !== 1
    || !Number.isSafeInteger(value["sequence"])
    || Number(value["sequence"]) < 0
    || !Array.isArray(value["entries"])
    || !Array.isArray(value["pending"])
    || value["entries"].length > CLIENT_NAMESPACE_GENERATION_CACHE_MAX_ENTRIES_V1
    || value["pending"].length > CLIENT_NAMESPACE_GENERATION_CACHE_MAX_PENDING_V1
  ) throw new TypeError("Namespace cache document is invalid");
  const document: OpenDocument = {
    sequence: Number(value["sequence"]),
    entries: [],
    pending: [],
  };
  try {
    for (const entry of value["entries"]) document.entries.push(decodeEntry(entry));
    for (const pending of value["pending"]) {
      document.pending.push(decodePending(pending));
    }
  } catch (error) {
    destroyDocument(document);
    throw error;
  }
  const canonical = encodeDocument(document);
  const canonicalMatch = canonical.length === plaintext.length
    && canonical.every((byte, index) => byte === plaintext[index]);
  canonical.fill(0);
  const legacyCanonical = canonicalMatch || document.pending.length === 0
    ? undefined
    : encodeDocument(document, false);
  const legacyCanonicalMatch = legacyCanonical !== undefined
    && legacyCanonical.length === plaintext.length
    && legacyCanonical.every((byte, index) => byte === plaintext[index]);
  legacyCanonical?.fill(0);
  if (!canonicalMatch && !legacyCanonicalMatch) {
    destroyDocument(document);
    throw new TypeError("Namespace cache document is noncanonical");
  }
  return document;
}

function destroyDocument(document: OpenDocument): void {
  document.entries.forEach(destroyClientNamespaceGenerationCacheEntryV1);
  document.pending.forEach((pending) =>
    destroyPendingClientNamespaceGenerationPublicationV1(pending)
  );
}

function storedEntryKey(entry: Readonly<{
  coordinates: ClientProfileCoordinates;
  namespaceId: string;
  keyClass: string;
  generation: number;
}>): string {
  return `${coordinatesKey(entry.coordinates)}\u0000${entry.namespaceId}\u0000${entry.keyClass}\u0000${String(entry.generation)}`;
}

function storedPendingKey(pending: Readonly<{
  coordinates: ClientProfileCoordinates;
  operationId: string;
}>): string {
  return `${coordinatesKey(pending.coordinates)}\u0000${pending.operationId}`;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function sameRequirement(
  left: ClientNamespaceGenerationCacheRequirementV1,
  right: ClientNamespaceGenerationCacheRequirementV1,
): boolean {
  return left.namespaceId === right.namespaceId
    && left.keyClass === right.keyClass
    && left.generation === right.generation
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

function samePending(
  left: PendingClientNamespaceGenerationPublicationV1,
  right: PendingClientNamespaceGenerationPublicationV1,
): boolean {
  return left.operationId === right.operationId
    && left.namespaceId === right.namespaceId
    && sameBytes(left.publicationSetBytes, right.publicationSetBytes)
    && left.entries.length === right.entries.length
    && left.entries.every((entry, index) => sameEntry(entry, right.entries[index]!));
}

async function sealDocument(
  key: CryptoKey,
  document: OpenDocument,
): Promise<SealedDocument> {
  const plaintext = encodeDocument(document);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  try {
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
      name: "AES-GCM",
      iv: ownedBuffer(nonce),
      additionalData: ownedBuffer(aad()),
      tagLength: 128,
    }, key, ownedBuffer(plaintext)));
    return Object.freeze({
      id: DOCUMENT_ID,
      formatVersion: 1 as const,
      nonce,
      ciphertext,
    });
  } finally {
    plaintext.fill(0);
  }
}

async function openDocument(
  key: CryptoKey,
  sealed: SealedDocument,
): Promise<OpenDocument> {
  if (
    sealed.id !== DOCUMENT_ID
    || sealed.formatVersion !== 1
    || !(sealed.nonce instanceof Uint8Array)
    || sealed.nonce.length !== NONCE_BYTES
    || !(sealed.ciphertext instanceof Uint8Array)
    || sealed.ciphertext.length <= 16
    || sealed.ciphertext.length > MAX_DOCUMENT_BYTES + 16
  ) throw new TypeError("Namespace cache sealed document is invalid");
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({
    name: "AES-GCM",
    iv: ownedBuffer(sealed.nonce),
    additionalData: ownedBuffer(aad()),
    tagLength: 128,
  }, key, ownedBuffer(sealed.ciphertext)));
  try {
    return decodeDocument(plaintext);
  } finally {
    plaintext.fill(0);
  }
}

export class BrowserClientNamespaceGenerationCacheVaultV1
implements ClientNamespaceGenerationCacheVaultV1 {
  #database: IDBDatabase | undefined;
  #key: CryptoKey | undefined;
  #terminal: ClientNamespaceGenerationCacheAvailabilityV1 | undefined;

  availability(): Promise<ClientNamespaceGenerationCacheAvailabilityV1> {
    return Promise.resolve(this.#terminal ?? {
      status: this.#key === undefined ? "locked" : "available",
    });
  }

  unlock(): Promise<ClientNamespaceGenerationCacheAvailabilityV1> {
    if (
      typeof indexedDB === "undefined"
      || typeof crypto?.subtle === "undefined"
      || typeof navigator?.locks?.request !== "function"
    ) return Promise.resolve(this.#terminal = Object.freeze({
      status: "unsupported",
      reasonCode: "durable_webcrypto_unavailable",
    }));
    return this.#exclusive(async () => {
      try {
        const database = await this.#requiredDatabase();
        const keys = await readRecord<KeyRecord>(database, KEY_STORE, ROOT_ID);
        const document = await readRecord<SealedDocument>(
          database,
          DOCUMENT_STORE,
          DOCUMENT_ID,
        );
        if (keys === undefined) {
          if (document !== undefined) return this.#terminal = Object.freeze({
            status: "storage_lost",
            reasonCode: "namespace_cache_wrapping_key_missing",
          });
          const key = await crypto.subtle.generateKey(
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"],
          );
          await writeRecord(database, KEY_STORE, {
            id: ROOT_ID,
            formatVersion: 1,
            key,
          } satisfies KeyRecord);
          this.#key = key;
          this.#terminal = undefined;
          return Object.freeze({ status: "available" as const });
        }
        if (
          keys.id !== ROOT_ID
          || keys.formatVersion !== 1
          || !(keys.key instanceof CryptoKey)
          || keys.key.extractable
          || keys.key.algorithm.name !== "AES-GCM"
        ) throw new TypeError("Namespace cache wrapping key is invalid");
        if (document !== undefined) {
          const opened = await openDocument(keys.key, document);
          destroyDocument(opened);
        }
        this.#key = keys.key;
        this.#terminal = undefined;
        return Object.freeze({ status: "available" as const });
      } catch {
        return this.#terminal = Object.freeze({
          status: "corrupt" as const,
          reasonCode: "namespace_cache_authentication_failed",
        });
      }
    });
  }

  lock(): Promise<void> {
    this.#key = undefined;
    this.#database?.close();
    this.#database = undefined;
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
    // The mutex protects only the authenticated document snapshot. Selected
    // entries are owned callback leases, so release it before user code can
    // acquire the Profile vault and invert the Profile/Cache lock order.
    const selected = await this.#exclusive(async () => {
      assertClientProfileCoordinates(coordinates);
      const document = await this.#readDocument();
      const selected: ClientNamespaceGenerationCacheEntryV1[] = [];
      try {
        for (const requirement of requirements) {
          const normalized = copyClientNamespaceGenerationCacheRequirementV1(
            requirement,
          );
          try {
            const entry = document.entries.find((candidate) =>
              coordinatesKey(candidate.coordinates) === coordinatesKey(coordinates)
              && storedEntryKey(candidate)
                === storedEntryKey({ ...normalized, coordinates })
            );
            if (entry === undefined || !sameRequirement(entry, normalized)) {
              selected.forEach(destroyClientNamespaceGenerationCacheEntryV1);
              return undefined;
            }
            selected.push(copyClientNamespaceGenerationCacheEntryV1(entry));
          } finally {
            normalized.headDigest.fill(0);
            normalized.publicationDigest.fill(0);
            normalized.publicationSetDigest.fill(0);
            normalized.audienceFingerprint.fill(0);
          }
        }
        return selected;
      } catch (error) {
        selected.forEach(destroyClientNamespaceGenerationCacheEntryV1);
        throw error;
      } finally {
        destroyDocument(document);
      }
    });
    if (selected === undefined) return Object.freeze({ status: "miss" as const });
    try {
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
    return this.#exclusive(async () => {
      assertClientProfileCoordinates(coordinates);
      const document = await this.#readDocument();
      try {
        this.#putEntries(document, coordinates, entries);
        await this.#writeDocument(document);
      } finally {
        destroyDocument(document);
      }
    });
  }

  stagePublication(
    coordinates: ClientProfileCoordinates,
    publication: PendingClientNamespaceGenerationPublicationV1,
  ): Promise<void> {
    return this.#exclusive(async () => {
      assertClientProfileCoordinates(coordinates);
      const document = await this.#readDocument();
      const candidate = copyPendingClientNamespaceGenerationPublicationV1(
        publication,
      );
      try {
        const key = storedPendingKey({ coordinates, operationId: candidate.operationId });
        const current = document.pending.find((pending) =>
          storedPendingKey(pending) === key
        );
        if (current !== undefined) {
          if (!samePending(current, candidate)) {
            throw new TypeError("Namespace publication stage collided");
          }
          return;
        }
        if (
          document.pending.length
            >= CLIENT_NAMESPACE_GENERATION_CACHE_MAX_PENDING_V1
        ) throw new RangeError("Namespace publication stage inventory is full");
        document.pending.push(Object.freeze({
          ...copyPendingClientNamespaceGenerationPublicationV1(candidate),
          coordinates: Object.freeze({ ...coordinates }),
        }));
        await this.#writeDocument(document);
      } finally {
        destroyPendingClientNamespaceGenerationPublicationV1(candidate);
        destroyDocument(document);
      }
    });
  }

  withPendingPublication<Value>(
    coordinates: ClientProfileCoordinates,
    operationId: string,
    use: (
      publication: PendingClientNamespaceGenerationPublicationV1,
    ) => Promise<Value> | Value,
  ): Promise<Readonly<{ status: "present"; value: Value }> | Readonly<{
    status: "absent";
  }>> {
    return this.#exclusive(async () => {
      const document = await this.#readDocument();
      try {
        const key = storedPendingKey({ coordinates, operationId });
        const pending = document.pending.find((candidate) =>
          storedPendingKey(candidate) === key
        );
        if (pending === undefined) return Object.freeze({ status: "absent" });
        const copy = copyPendingClientNamespaceGenerationPublicationV1(
          pending,
        );
        try {
          return Object.freeze({
            status: "present" as const,
            value: await use(copy),
          });
        } finally {
          destroyPendingClientNamespaceGenerationPublicationV1(copy);
        }
      } finally {
        destroyDocument(document);
      }
    });
  }

  activatePublication(
    coordinates: ClientProfileCoordinates,
    operationId: string,
  ): Promise<void> {
    return this.#exclusive(async () => {
      const document = await this.#readDocument();
      try {
        const key = storedPendingKey({ coordinates, operationId });
        const index = document.pending.findIndex((pending) =>
          storedPendingKey(pending) === key
        );
        const pending = document.pending[index];
        if (pending === undefined) {
          throw new TypeError("Namespace publication stage is absent");
        }
        this.#putEntries(document, coordinates, pending.entries);
        document.pending.splice(index, 1);
        destroyPendingClientNamespaceGenerationPublicationV1(pending);
        await this.#writeDocument(document);
      } finally {
        destroyDocument(document);
      }
    });
  }

  abortPublication(
    coordinates: ClientProfileCoordinates,
    operationId: string,
  ): Promise<void> {
    return this.#exclusive(async () => {
      const document = await this.#readDocument();
      try {
        const key = storedPendingKey({ coordinates, operationId });
        const index = document.pending.findIndex((pending) =>
          storedPendingKey(pending) === key
        );
        if (index >= 0) {
          const [removed] = document.pending.splice(index, 1);
          if (removed !== undefined) {
            destroyPendingClientNamespaceGenerationPublicationV1(removed);
          }
          await this.#writeDocument(document);
        }
      } finally {
        destroyDocument(document);
      }
    });
  }

  pruneExpiredPublications(
    coordinates: ClientProfileCoordinates,
    now: number,
  ): Promise<number> {
    return this.#exclusive(async () => {
      assertClientProfileCoordinates(coordinates);
      const document = await this.#readDocument();
      let removed = 0;
      try {
        document.pending = document.pending.filter((pending) => {
          if (!pendingNamespaceGenerationPublicationExpiredV1(pending, now)) {
            return true;
          }
          destroyPendingClientNamespaceGenerationPublicationV1(pending);
          removed++;
          return false;
        });
        if (removed > 0) await this.#writeDocument(document);
        return removed;
      } finally {
        destroyDocument(document);
      }
    });
  }

  evict(
    coordinates: ClientProfileCoordinates,
    namespaceId?: string,
  ): Promise<void> {
    return this.#exclusive(async () => {
      const document = await this.#readDocument();
      try {
        const coordinate = coordinatesKey(coordinates);
        const retained: StoredEntry[] = [];
        for (const entry of document.entries) {
          if (
            coordinatesKey(entry.coordinates) === coordinate
            && (namespaceId === undefined || entry.namespaceId === namespaceId)
          ) destroyClientNamespaceGenerationCacheEntryV1(entry);
          else retained.push(entry);
        }
        document.entries = retained;
        await this.#writeDocument(document);
      } finally {
        destroyDocument(document);
      }
    });
  }

  forget(coordinates: ClientProfileCoordinates): Promise<void> {
    return this.#exclusive(async () => {
      const document = await this.#readDocument();
      try {
        const coordinate = coordinatesKey(coordinates);
        document.entries = document.entries.filter((entry) => {
          if (coordinatesKey(entry.coordinates) !== coordinate) return true;
          destroyClientNamespaceGenerationCacheEntryV1(entry);
          return false;
        });
        document.pending = document.pending.filter((pending) => {
          if (coordinatesKey(pending.coordinates) !== coordinate) return true;
          destroyPendingClientNamespaceGenerationPublicationV1(pending);
          return false;
        });
        await this.#writeDocument(document);
      } finally {
        destroyDocument(document);
      }
    });
  }

  async #requiredDatabase(): Promise<IDBDatabase> {
    this.#database ??= await openDatabase();
    return this.#database;
  }

  #requiredKey(): CryptoKey {
    if (this.#key === undefined) throw new TypeError("Namespace cache is locked");
    return this.#key;
  }

  async #readDocument(): Promise<OpenDocument> {
    const sealed = await readRecord<SealedDocument>(
      await this.#requiredDatabase(),
      DOCUMENT_STORE,
      DOCUMENT_ID,
    );
    return sealed === undefined
      ? emptyDocument()
      : openDocument(this.#requiredKey(), sealed);
  }

  async #writeDocument(document: OpenDocument): Promise<void> {
    const sealed = await sealDocument(this.#requiredKey(), document);
    await writeRecord(
      await this.#requiredDatabase(),
      DOCUMENT_STORE,
      sealed,
    );
  }

  #putEntries(
    document: OpenDocument,
    coordinates: ClientProfileCoordinates,
    entries: readonly ClientNamespaceGenerationCacheEntryV1[],
  ): void {
    for (const input of entries) {
      const candidate = copyClientNamespaceGenerationCacheEntryV1(input);
      const key = storedEntryKey({ ...candidate, coordinates });
      const current = document.entries.find((entry) =>
        storedEntryKey(entry) === key
      );
      if (current !== undefined) {
        const matches = sameEntry(current, candidate);
        destroyClientNamespaceGenerationCacheEntryV1(candidate);
        if (!matches) throw new TypeError("Namespace cache entry collided");
        continue;
      }
      document.sequence++;
      document.entries.push(Object.freeze({
        ...candidate,
        coordinates: Object.freeze({ ...coordinates }),
        sequence: document.sequence,
      }));
    }
    while (
      document.entries.length > CLIENT_NAMESPACE_GENERATION_CACHE_MAX_ENTRIES_V1
    ) {
      let oldest = 0;
      for (let index = 1; index < document.entries.length; index++) {
        if (document.entries[index]!.sequence < document.entries[oldest]!.sequence) {
          oldest = index;
        }
      }
      const [removed] = document.entries.splice(oldest, 1);
      if (removed !== undefined) destroyClientNamespaceGenerationCacheEntryV1(removed);
    }
  }

  #exclusive<Value>(operation: () => Promise<Value>): Promise<Value> {
    return navigator.locks.request(
      LOCK_NAME,
      { mode: "exclusive" },
      operation,
    ) as unknown as Promise<Value>;
  }
}

export function createBrowserClientNamespaceGenerationCacheVaultV1():
ClientNamespaceGenerationCacheVaultV1 {
  return new BrowserClientNamespaceGenerationCacheVaultV1();
}
