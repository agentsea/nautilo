import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

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
import { atomicWritePrivateFile } from "../file-vault.ts";
import type { ElectronSafeStoragePort } from "./index.ts";

const DOCUMENT_FILE_NAME = "namespace-generation-cache-v1.json";
const KEY_FILE_NAME = "namespace-generation-cache-v1-key";
const FORMAT_VERSION = 1 as const;
const AES_KEY_BYTES = 32;
const AES_NONCE_BYTES = 12;
const AES_TAG_BYTES = 16;
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
const pathTails = new Map<string, Promise<void>>();

interface ElectronKeyEnvelope {
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly currentBase64: string;
  readonly previousBase64?: string;
}

interface SealedDocument {
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly nonceBase64: string;
  readonly ciphertextBase64: string;
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

export interface ElectronClientNamespaceGenerationCacheVaultOptions {
  readonly directory: string;
  readonly safeStorage: ElectronSafeStoragePort;
}

function emptyDocument(): OpenDocument {
  return { sequence: 0, entries: [], pending: [] };
}

function exactFields(value: unknown, fields: readonly string[]): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length === fields.length
    && fields.every((field) => keys.includes(field));
}

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function bytes(value: unknown, expected?: number): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError("Namespace cache bytes are invalid");
  }
  const result = new Uint8Array(Buffer.from(value, "base64url"));
  if (
    (expected !== undefined && result.length !== expected)
    || base64url(result) !== value
  ) {
    result.fill(0);
    throw new TypeError("Namespace cache bytes are noncanonical");
  }
  return result;
}

function jsonEntry(entry: StoredEntry): Record<string, unknown> {
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

function jsonPending(pending: StoredPending): Record<string, unknown> {
  return {
    coordinates: pending.coordinates,
    formatVersion: pending.formatVersion,
    operationId: pending.operationId,
    namespaceId: pending.namespaceId,
    expiresAt: pending.expiresAt,
    publicationSetBytes: base64url(pending.publicationSetBytes),
    entries: pending.entries.map((entry) => jsonEntry({
      ...entry,
      coordinates: pending.coordinates,
      sequence: 0,
    })),
  };
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

function encodeDocument(document: OpenDocument): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify({
    formatVersion: FORMAT_VERSION,
    sequence: document.sequence,
    entries: [...document.entries]
      .sort((left, right) => storedEntryKey(left).localeCompare(storedEntryKey(right)))
      .map(jsonEntry),
    pending: [...document.pending]
      .sort((left, right) => storedPendingKey(left).localeCompare(storedPendingKey(right)))
      .map(jsonPending),
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

function decodeEntry(value: unknown, pending = false): StoredEntry {
  if (!exactFields(value, ENTRY_FIELDS)) {
    throw new TypeError("Namespace cache entry is invalid");
  }
  const raw = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(raw["sequence"])
    || Number(raw["sequence"]) < (pending ? 0 : 1)
  ) {
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
  if (!exactFields(value, [
    "coordinates",
    "formatVersion",
    "operationId",
    "namespaceId",
    "expiresAt",
    "publicationSetBytes",
    "entries",
  ])) throw new TypeError("Namespace cache pending publication is invalid");
  const raw = value as Record<string, unknown>;
  if (
    raw["formatVersion"] !== FORMAT_VERSION
    || !Array.isArray(raw["entries"])
    || raw["entries"].length < 2
    || raw["entries"].length > CLIENT_NAMESPACE_GENERATION_CACHE_MAX_ENTRIES_V1
  ) throw new TypeError("Namespace cache pending publication is invalid");
  const coordinates = decodeCoordinates(raw["coordinates"]);
  const entries: ClientNamespaceGenerationCacheEntryV1[] = [];
  let publicationSetBytes: Uint8Array | undefined;
  try {
    for (const entry of raw["entries"]) {
      const decoded = decodeEntry(entry, true);
      try {
        if (
          coordinatesKey(decoded.coordinates) !== coordinatesKey(coordinates)
          || decoded.namespaceId !== String(raw["namespaceId"])
        ) {
          throw new TypeError("Namespace cache pending entry is invalid");
        }
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
      expiresAt: Number(raw["expiresAt"]),
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
  const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true })
    .decode(plaintext));
  if (!exactFields(raw, ["formatVersion", "sequence", "entries", "pending"])) {
    throw new TypeError("Namespace cache document is invalid");
  }
  const value = raw as Record<string, unknown>;
  if (
    value["formatVersion"] !== FORMAT_VERSION
    || !Number.isSafeInteger(value["sequence"])
    || Number(value["sequence"]) < 0
    || !Array.isArray(value["entries"])
    || value["entries"].length > CLIENT_NAMESPACE_GENERATION_CACHE_MAX_ENTRIES_V1
    || !Array.isArray(value["pending"])
    || value["pending"].length > CLIENT_NAMESPACE_GENERATION_CACHE_MAX_PENDING_V1
  ) throw new TypeError("Namespace cache document is invalid");
  const document: OpenDocument = {
    sequence: Number(value["sequence"]),
    entries: [],
    pending: [],
  };
  try {
    const entryKeys = new Set<string>();
    const entrySequences = new Set<number>();
    for (const entry of value["entries"]) {
      const decoded = decodeEntry(entry);
      const key = storedEntryKey(decoded);
      if (entryKeys.has(key) || entrySequences.has(decoded.sequence)) {
        destroyClientNamespaceGenerationCacheEntryV1(decoded);
        throw new TypeError("Namespace cache document contains duplicates");
      }
      entryKeys.add(key);
      entrySequences.add(decoded.sequence);
      document.entries.push(decoded);
    }
    const largestSequence = document.entries.reduce(
      (largest, entry) => Math.max(largest, entry.sequence),
      0,
    );
    if (document.sequence < largestSequence) {
      throw new TypeError("Namespace cache document sequence is stale");
    }
    const pendingKeys = new Set<string>();
    for (const pending of value["pending"]) {
      const decoded = decodePending(pending);
      const key = storedPendingKey(decoded);
      if (pendingKeys.has(key)) {
        destroyPendingClientNamespaceGenerationPublicationV1(decoded);
        throw new TypeError("Namespace cache document contains duplicates");
      }
      pendingKeys.add(key);
      document.pending.push(decoded);
    }
    const canonical = encodeDocument(document);
    const matches = canonical.length === plaintext.length
      && canonical.every((byte, index) => byte === plaintext[index]);
    canonical.fill(0);
    if (!matches) throw new TypeError("Namespace cache document is noncanonical");
    return document;
  } catch (error) {
    destroyDocument(document);
    throw error;
  }
}

function destroyRequirement(
  requirement: ClientNamespaceGenerationCacheRequirementV1,
): void {
  requirement.headDigest.fill(0);
  requirement.publicationDigest.fill(0);
  requirement.publicationSetDigest.fill(0);
  requirement.audienceFingerprint.fill(0);
}

function destroyDocument(document: OpenDocument): void {
  document.entries.forEach(destroyClientNamespaceGenerationCacheEntryV1);
  document.pending.forEach(destroyPendingClientNamespaceGenerationPublicationV1);
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
    && left.expiresAt === right.expiresAt
    && sameBytes(left.publicationSetBytes, right.publicationSetBytes)
    && left.entries.length === right.entries.length
    && left.entries.every((entry, index) => sameEntry(entry, right.entries[index]!));
}

function aad(): Uint8Array {
  return new TextEncoder().encode(
    "nautilo/electron/namespace-generation-cache-v1/document",
  );
}

function sealDocument(key: Uint8Array, document: OpenDocument): SealedDocument {
  const plaintext = encodeDocument(document);
  const nonce = randomBytes(AES_NONCE_BYTES);
  const associated = aad();
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(associated);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return Object.freeze({
      formatVersion: FORMAT_VERSION,
      nonceBase64: nonce.toString("base64"),
      ciphertextBase64: ciphertext.toString("base64"),
    });
  } finally {
    plaintext.fill(0);
    associated.fill(0);
  }
}

function openDocument(key: Uint8Array, sealed: SealedDocument): OpenDocument {
  const nonce = Buffer.from(sealed.nonceBase64, "base64");
  const encrypted = Buffer.from(sealed.ciphertextBase64, "base64");
  if (
    key.length !== AES_KEY_BYTES
    || sealed.formatVersion !== FORMAT_VERSION
    || nonce.length !== AES_NONCE_BYTES
    || nonce.toString("base64") !== sealed.nonceBase64
    || encrypted.length <= AES_TAG_BYTES
    || encrypted.length > MAX_DOCUMENT_BYTES + AES_TAG_BYTES
    || encrypted.toString("base64") !== sealed.ciphertextBase64
  ) throw new TypeError("Namespace cache sealed document is invalid");
  const associated = aad();
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(associated);
  decipher.setAuthTag(encrypted.subarray(-AES_TAG_BYTES));
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = new Uint8Array(Buffer.concat([
      decipher.update(encrypted.subarray(0, -AES_TAG_BYTES)),
      decipher.final(),
    ]));
    return decodeDocument(plaintext);
  } finally {
    plaintext?.fill(0);
    associated.fill(0);
  }
}

async function readSealedDocument(path: string): Promise<SealedDocument | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (!exactFields(parsed, ["formatVersion", "nonceBase64", "ciphertextBase64"])) {
    throw new TypeError("Namespace cache sealed document is invalid");
  }
  const sealed = parsed as SealedDocument;
  if (
    sealed.formatVersion !== FORMAT_VERSION
    || typeof sealed.nonceBase64 !== "string"
    || typeof sealed.ciphertextBase64 !== "string"
  ) throw new TypeError("Namespace cache sealed document is invalid");
  return sealed;
}

function writeSealedDocument(
  path: string,
  document: OpenDocument,
  key: Uint8Array,
): Promise<void> {
  return atomicWritePrivateFile(path, JSON.stringify(sealDocument(key, document)));
}

async function readKeyCandidates(
  path: string,
  safeStorage: ElectronSafeStoragePort,
): Promise<readonly Uint8Array[]> {
  let protectedBytes: Buffer;
  try {
    protectedBytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const parsed: unknown = JSON.parse(safeStorage.decryptString(protectedBytes));
  if (
    !exactFields(parsed, ["formatVersion", "currentBase64"])
    && !exactFields(parsed, ["formatVersion", "currentBase64", "previousBase64"])
  ) throw new TypeError("Namespace cache wrapping key is corrupt");
  const envelope = parsed as ElectronKeyEnvelope;
  if (
    envelope.formatVersion !== FORMAT_VERSION
    || typeof envelope.currentBase64 !== "string"
    || (envelope.previousBase64 !== undefined
      && typeof envelope.previousBase64 !== "string")
  ) {
    throw new TypeError("Namespace cache wrapping key is corrupt");
  }
  const values = [envelope.currentBase64, envelope.previousBase64]
    .filter((value): value is string => value !== undefined);
  const keys = values.map((value) => new Uint8Array(Buffer.from(value, "base64")));
  if (keys.some((key, index) =>
    key.length !== AES_KEY_BYTES
    || Buffer.from(key).toString("base64") !== values[index]
  )) {
    keys.forEach((key) => key.fill(0));
    throw new TypeError("Namespace cache wrapping key is corrupt");
  }
  return keys;
}

function writeKey(
  path: string,
  safeStorage: ElectronSafeStoragePort,
  key: Uint8Array,
): Promise<void> {
  if (key.length !== AES_KEY_BYTES) {
    throw new TypeError("Namespace cache wrapping key is invalid");
  }
  const protectedBytes = safeStorage.encryptString(JSON.stringify({
    formatVersion: FORMAT_VERSION,
    currentBase64: Buffer.from(key).toString("base64"),
  } satisfies ElectronKeyEnvelope));
  return atomicWritePrivateFile(path, protectedBytes);
}

export class ElectronClientNamespaceGenerationCacheVaultV1
implements ClientNamespaceGenerationCacheVaultV1 {
  readonly #documentPath: string;
  readonly #keyPath: string;
  readonly #safeStorage: ElectronSafeStoragePort;
  #key: Uint8Array | undefined;
  #terminal: ClientNamespaceGenerationCacheAvailabilityV1 | undefined;

  constructor(options: ElectronClientNamespaceGenerationCacheVaultOptions) {
    this.#documentPath = join(options.directory, DOCUMENT_FILE_NAME);
    this.#keyPath = join(options.directory, KEY_FILE_NAME);
    this.#safeStorage = options.safeStorage;
  }

  availability(): Promise<ClientNamespaceGenerationCacheAvailabilityV1> {
    return Promise.resolve(this.#terminal ?? {
      status: this.#key === undefined ? "locked" : "available",
    });
  }

  unlock(): Promise<ClientNamespaceGenerationCacheAvailabilityV1> {
    return this.#exclusive(async () => {
      let encryptionAvailable: boolean;
      let selectedBackend: string | undefined;
      try {
        encryptionAvailable = this.#safeStorage.isEncryptionAvailable();
        selectedBackend = this.#safeStorage.getSelectedStorageBackend?.();
      } catch {
        return this.#setTerminal(
          "unsupported",
          "electron_safe_storage_unavailable",
        );
      }
      if (!encryptionAvailable) {
        return this.#setTerminal("unsupported", "electron_safe_storage_unavailable");
      }
      if (selectedBackend === "basic_text") {
        return this.#setTerminal("unsupported", "electron_safe_storage_basic_text");
      }
      let sealed: SealedDocument | undefined;
      try {
        sealed = await readSealedDocument(this.#documentPath);
      } catch {
        return this.#setTerminal("corrupt", "namespace_cache_document_corrupt");
      }
      let candidates: readonly Uint8Array[];
      try {
        candidates = await readKeyCandidates(this.#keyPath, this.#safeStorage);
      } catch {
        return this.#setTerminal("corrupt", "namespace_cache_wrapping_key_corrupt");
      }
      if (candidates.length === 0) {
        if (sealed !== undefined) {
          return this.#setTerminal("storage_lost", "namespace_cache_wrapping_key_missing");
        }
        const created = randomBytes(AES_KEY_BYTES);
        try {
          await writeKey(this.#keyPath, this.#safeStorage, created);
          this.#replaceKey(created);
          this.#terminal = undefined;
          return Object.freeze({ status: "available" as const });
        } catch {
          return this.#setTerminal("unsupported", "electron_safe_storage_unavailable");
        } finally {
          created.fill(0);
        }
      }
      let selected: Uint8Array | undefined;
      if (sealed === undefined) selected = candidates[0];
      else {
        for (const candidate of candidates) {
          try {
            const document = openDocument(candidate, sealed);
            destroyDocument(document);
            selected = candidate;
            break;
          } catch {
            // A protected previous key may still authenticate interrupted rotation.
          }
        }
      }
      const owned = selected === undefined ? undefined : Uint8Array.from(selected);
      candidates.forEach((candidate) => candidate.fill(0));
      if (owned === undefined) {
        return this.#setTerminal("corrupt", "namespace_cache_authentication_failed");
      }
      try {
        // Heal either side of an interrupted rotation: if current opened the
        // document this commits it; if previous opened it this rolls back.
        // In both cases the next restart has one unambiguous protected key.
        await writeKey(this.#keyPath, this.#safeStorage, owned);
      } catch {
        owned.fill(0);
        return this.#setTerminal(
          "unsupported",
          "electron_safe_storage_unavailable",
        );
      }
      this.#replaceKey(owned);
      owned.fill(0);
      this.#terminal = undefined;
      return Object.freeze({ status: "available" as const });
    });
  }

  lock(): Promise<void> {
    return this.#exclusive(() => {
      this.#key?.fill(0);
      this.#key = undefined;
      return Promise.resolve();
    });
  }

  withEntries<Value>(
    coordinates: ClientProfileCoordinates,
    requirements: readonly ClientNamespaceGenerationCacheRequirementV1[],
    use: (
      entries: readonly ClientNamespaceGenerationCacheEntryV1[],
    ) => Promise<Value> | Value,
  ): Promise<Readonly<{ status: "hit"; value: Value }> | Readonly<{
    status: "miss";
  }>> {
    return this.#exclusive(async () => {
      assertClientProfileCoordinates(coordinates);
      const document = await this.#readDocument();
      const selected: ClientNamespaceGenerationCacheEntryV1[] = [];
      try {
        for (const requirement of requirements) {
          const normalized = copyClientNamespaceGenerationCacheRequirementV1(requirement);
          try {
            const key = storedEntryKey({ ...normalized, coordinates });
            const entry = document.entries.find((candidate) =>
              storedEntryKey(candidate) === key
            );
            if (entry === undefined || !sameRequirement(entry, normalized)) {
              return Object.freeze({ status: "miss" as const });
            }
            selected.push(copyClientNamespaceGenerationCacheEntryV1(entry));
          } finally {
            destroyRequirement(normalized);
          }
        }
        return Object.freeze({
          status: "hit" as const,
          value: await use(Object.freeze(selected)),
        });
      } finally {
        selected.forEach(destroyClientNamespaceGenerationCacheEntryV1);
        destroyDocument(document);
      }
    });
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
      const candidate = copyPendingClientNamespaceGenerationPublicationV1(publication);
      try {
        const key = storedPendingKey({ coordinates, operationId: candidate.operationId });
        const current = document.pending.find((pending) => storedPendingKey(pending) === key);
        if (current !== undefined) {
          if (!samePending(current, candidate)) {
            throw new TypeError("Namespace publication stage collided");
          }
          return;
        }
        if (document.pending.length >= CLIENT_NAMESPACE_GENERATION_CACHE_MAX_PENDING_V1) {
          throw new RangeError("Namespace publication stage inventory is full");
        }
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
      assertClientProfileCoordinates(coordinates);
      const document = await this.#readDocument();
      try {
        const key = storedPendingKey({ coordinates, operationId });
        const pending = document.pending.find((candidate) => storedPendingKey(candidate) === key);
        if (pending === undefined) return Object.freeze({ status: "absent" as const });
        const copy = copyPendingClientNamespaceGenerationPublicationV1(pending);
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
      assertClientProfileCoordinates(coordinates);
      const document = await this.#readDocument();
      try {
        const key = storedPendingKey({ coordinates, operationId });
        const index = document.pending.findIndex((pending) => storedPendingKey(pending) === key);
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
      assertClientProfileCoordinates(coordinates);
      const document = await this.#readDocument();
      try {
        const key = storedPendingKey({ coordinates, operationId });
        const index = document.pending.findIndex((pending) => storedPendingKey(pending) === key);
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
      const coordinate = coordinatesKey(coordinates);
      let removed = 0;
      try {
        document.pending = document.pending.filter((pending) => {
          if (
            coordinatesKey(pending.coordinates) !== coordinate
            || !pendingNamespaceGenerationPublicationExpiredV1(pending, now)
          ) return true;
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

  evict(coordinates: ClientProfileCoordinates, namespaceId?: string): Promise<void> {
    return this.#exclusive(async () => {
      assertClientProfileCoordinates(coordinates);
      const document = await this.#readDocument();
      const coordinate = coordinatesKey(coordinates);
      try {
        document.entries = document.entries.filter((entry) => {
          if (
            coordinatesKey(entry.coordinates) !== coordinate
            || (namespaceId !== undefined && entry.namespaceId !== namespaceId)
          ) return true;
          destroyClientNamespaceGenerationCacheEntryV1(entry);
          return false;
        });
        await this.#writeDocument(document);
      } finally {
        destroyDocument(document);
      }
    });
  }

  forget(coordinates: ClientProfileCoordinates): Promise<void> {
    return this.#exclusive(async () => {
      assertClientProfileCoordinates(coordinates);
      const document = await this.#readDocument();
      const coordinate = coordinatesKey(coordinates);
      try {
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

  #putEntries(
    document: OpenDocument,
    coordinates: ClientProfileCoordinates,
    entries: readonly ClientNamespaceGenerationCacheEntryV1[],
  ): void {
    for (const input of entries) {
      const candidate = copyClientNamespaceGenerationCacheEntryV1(input);
      const key = storedEntryKey({ ...candidate, coordinates });
      const current = document.entries.find((entry) => storedEntryKey(entry) === key);
      if (current !== undefined) {
        const matches = sameEntry(current, candidate);
        destroyClientNamespaceGenerationCacheEntryV1(candidate);
        if (!matches) throw new TypeError("Namespace cache entry collided");
        continue;
      }
      if (document.sequence === Number.MAX_SAFE_INTEGER) {
        destroyClientNamespaceGenerationCacheEntryV1(candidate);
        throw new RangeError("Namespace cache sequence is exhausted");
      }
      document.sequence++;
      document.entries.push(Object.freeze({
        ...candidate,
        coordinates: Object.freeze({ ...coordinates }),
        sequence: document.sequence,
      }));
    }
    while (document.entries.length > CLIENT_NAMESPACE_GENERATION_CACHE_MAX_ENTRIES_V1) {
      let oldest = 0;
      for (let index = 1; index < document.entries.length; index++) {
        if (document.entries[index]!.sequence < document.entries[oldest]!.sequence) oldest = index;
      }
      const [removed] = document.entries.splice(oldest, 1);
      if (removed !== undefined) destroyClientNamespaceGenerationCacheEntryV1(removed);
    }
  }

  #requiredKey(): Uint8Array {
    if (this.#key === undefined) throw new TypeError("Namespace cache is locked");
    return this.#key;
  }

  async #readDocument(): Promise<OpenDocument> {
    const key = this.#requiredKey();
    const sealed = await readSealedDocument(this.#documentPath);
    return sealed === undefined ? emptyDocument() : openDocument(key, sealed);
  }

  #writeDocument(document: OpenDocument): Promise<void> {
    return writeSealedDocument(this.#documentPath, document, this.#requiredKey());
  }

  #replaceKey(key: Uint8Array): void {
    this.#key?.fill(0);
    this.#key = Uint8Array.from(key);
  }

  #setTerminal(
    status: "unsupported" | "corrupt" | "storage_lost",
    reasonCode: string,
  ): ClientNamespaceGenerationCacheAvailabilityV1 {
    this.#key?.fill(0);
    this.#key = undefined;
    this.#terminal = Object.freeze({ status, reasonCode });
    return this.#terminal;
  }

  #exclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    const tail = pathTails.get(this.#documentPath) ?? Promise.resolve();
    const result = tail.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    pathTails.set(this.#documentPath, settled);
    void settled.finally(() => {
      if (pathTails.get(this.#documentPath) === settled) {
        pathTails.delete(this.#documentPath);
      }
    });
    return result;
  }
}

export function createElectronClientNamespaceGenerationCacheVaultV1(
  options: ElectronClientNamespaceGenerationCacheVaultOptions,
): ClientNamespaceGenerationCacheVaultV1 {
  return new ElectronClientNamespaceGenerationCacheVaultV1(options);
}
