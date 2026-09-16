/// <reference lib="dom" />

import {
  type PreparedMutationJournalIndex,
  type PreparedMutationJournalVaultPort,
} from "./prepared-mutation-journal.ts";
import type { PreparedMutationJournalCustodyAvailability } from "./file-prepared-mutation-journal-vault.ts";
import { PREPARED_MUTATION_JOURNAL_LIMITS } from "./prepared-mutation-journal-limits.ts";

// V1 accepted records produced before the journal became a shared durability
// boundary for messages, Artifacts, and device transitions. Reusing that
// database after the stricter index contract landed makes one stale record
// fail closed for every future encrypted write. Keep V1 intact for forensic
// recovery and start the current contract in an isolated generation.
const DATABASE_NAME = "nautilo-protected-memory-mutation-journal-v2";
const ADDITIONAL_DEVICE_DATABASE_NAME =
  "nautilo-additional-device-transition-journal-v1";
const DATABASE_VERSION = 1;
const KEY_STORE = "wrapping_keys";
const RECORD_STORE = "journal_records";
const KEY_ID = "root";
const AES_NONCE_BYTES = 12;
const AES_TAG_BYTES = 16;

interface BrowserJournalKey {
  readonly id: typeof KEY_ID;
  readonly formatVersion: 1;
  readonly key: CryptoKey;
}

interface BrowserJournalRecord {
  readonly formatVersion: 1;
  readonly operationId: string;
  readonly index: PreparedMutationJournalIndex;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(bytes.length);
  owned.set(bytes);
  return owned.buffer;
}

function aad(index: PreparedMutationJournalIndex): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(index));
}

async function seal(
  key: CryptoKey,
  index: PreparedMutationJournalIndex,
  plaintext: Uint8Array,
): Promise<BrowserJournalRecord> {
  const nonce = crypto.getRandomValues(new Uint8Array(AES_NONCE_BYTES));
  const persistedIndex = Object.freeze({
    ...index,
    sealedBytes: plaintext.length + AES_TAG_BYTES,
  });
  const additionalData = aad(persistedIndex);
  try {
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
      name: "AES-GCM",
      iv: ownedBuffer(nonce),
      additionalData: ownedBuffer(additionalData),
      tagLength: 128,
    }, key, ownedBuffer(plaintext)));
    return {
      formatVersion: 1,
      operationId: persistedIndex.operationId,
      index: persistedIndex,
      nonce,
      ciphertext,
    };
  } finally {
    additionalData.fill(0);
  }
}

async function open(
  key: CryptoKey,
  record: BrowserJournalRecord,
): Promise<Uint8Array> {
  const additionalData = aad(record.index);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: ownedBuffer(record.nonce),
      additionalData: ownedBuffer(additionalData),
      tagLength: 128,
    }, key, ownedBuffer(record.ciphertext)));
  } finally {
    additionalData.fill(0);
  }
}

function requestResult<Result>(request: IDBRequest<Result>): Promise<Result> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(
      transaction.error ?? new Error("IndexedDB transaction aborted"),
    );
    transaction.onerror = () => reject(
      transaction.error ?? new Error("IndexedDB transaction failed"),
    );
  });
}

function openDatabase(databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(KEY_STORE)) {
        request.result.createObjectStore(KEY_STORE, { keyPath: "id" });
      }
      if (!request.result.objectStoreNames.contains(RECORD_STORE)) {
        request.result.createObjectStore(RECORD_STORE, { keyPath: "operationId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB upgrade blocked"));
  });
}

async function readOne<Result>(
  database: IDBDatabase,
  storeName: string,
  key: string,
): Promise<Result | undefined> {
  const transaction = database.transaction(storeName, "readonly");
  const done = transactionDone(transaction);
  const result = await requestResult(transaction.objectStore(storeName).get(key)) as
    Result | undefined;
  await done;
  return result;
}

async function readAll<Result>(
  database: IDBDatabase,
  storeName: string,
): Promise<readonly Result[]> {
  const transaction = database.transaction(storeName, "readonly");
  const done = transactionDone(transaction);
  const result = await requestResult(transaction.objectStore(storeName).getAll()) as Result[];
  await done;
  return result;
}

async function putOne(
  database: IDBDatabase,
  storeName: string,
  value: unknown,
): Promise<void> {
  const transaction = database.transaction(storeName, "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore(storeName).put(value);
  await done;
}

function assertKey(value: BrowserJournalKey): void {
  if (
    value.id !== KEY_ID
    || value.formatVersion !== 1
    || !(value.key instanceof CryptoKey)
    || value.key.extractable
    || value.key.algorithm.name !== "AES-GCM"
  ) throw new Error("browser prepared mutation journal key is corrupt");
}

function assertRecord(value: BrowserJournalRecord): void {
  const isMemory = ["create", "update", "access", "repair"].includes(value.index.kind);
  const isArtifact = [
    "artifact_create",
    "artifact_content",
    "artifact_control",
    "artifact_access",
  ].includes(value.index.kind);
  const isLiveShadowMessage = value.index.kind === "live_shadow_message";
  const isAdditionalDevice = value.index.kind === "additional_device_transition";
  const isAdditionalDeviceTargetPlan =
    value.index.kind === "additional_device_target_plan";
  const maximumCanonicalBytes = isAdditionalDevice || isAdditionalDeviceTargetPlan
    ? PREPARED_MUTATION_JOURNAL_LIMITS.maxAdditionalDeviceCampaignBytes
    : PREPARED_MUTATION_JOURNAL_LIMITS.maxCanonicalRecordBytes;
  if (
    value.formatVersion !== 1
    || value.operationId !== value.index.operationId
    || value.index.formatVersion !== 1
    || typeof value.index.authenticatedRequestDigestBase64url !== "string"
    || (!isMemory && !isArtifact && !isLiveShadowMessage && !isAdditionalDevice
      && !isAdditionalDeviceTargetPlan)
    || (isMemory && (!("memoryId" in value.index) || value.index.memoryId.length === 0))
    || (isArtifact
      && (!("artifactId" in value.index) || value.index.artifactId.length === 0))
    || (isLiveShadowMessage
      && (!("roomId" in value.index) || value.index.roomId.length === 0))
    || (isAdditionalDevice && (
      !("targetDeviceId" in value.index)
      || value.index.targetDeviceId.length === 0
      || value.index.targetDeviceId.length > 128
      || value.index.targetClientKind !== "browser"
        && value.index.targetClientKind !== "electron"
      || value.index.verificationCode.length === 0
      || value.index.verificationCode.length > 64
      || value.index.candidateProfileDigestBase64url.length !== 43
      || !Number.isSafeInteger(value.index.candidateProfileGeneration)
      || value.index.candidateProfileGeneration < 1
    ))
    || (isAdditionalDeviceTargetPlan && (
      !("targetDeviceId" in value.index)
      || value.index.targetDeviceId.length === 0
      || value.index.targetDeviceId.length > 128
      || value.index.verificationCode.length === 0
      || value.index.verificationCode.length > 64
      || value.index.deliveryHighWatermark !== null
        && (!Number.isSafeInteger(value.index.deliveryHighWatermark)
          || value.index.deliveryHighWatermark < 0)
      || !validDeliveryManifest(value.index.deliveryManifest)
      || (value.index.deliveryManifest.length === 0)
        !== (value.index.deliveryHighWatermark === null)
    ))
    || !Number.isSafeInteger(value.index.canonicalBytes)
    || value.index.canonicalBytes < 1
    || value.index.canonicalBytes > maximumCanonicalBytes
    || !(value.nonce instanceof Uint8Array)
    || value.nonce.length !== AES_NONCE_BYTES
    || !(value.ciphertext instanceof Uint8Array)
    || value.ciphertext.length !== value.index.sealedBytes
    || value.ciphertext.length <= AES_TAG_BYTES
  ) throw new Error("browser prepared mutation journal record is corrupt");
}

function validDeliveryManifest(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 4_096) return false;
  let previousSequence = 0;
  for (const candidate of value as unknown[]) {
    if (typeof candidate !== "object" || candidate === null) return false;
    const message = candidate as Record<string, unknown>;
    const messageId = message["messageId"];
    const recipientSequence = message["recipientSequence"];
    const payloadHashBase64url = message["payloadHashBase64url"];
    if (
      typeof messageId !== "string"
      || messageId.length === 0
      || messageId.length > 128
      || typeof recipientSequence !== "number"
      || !Number.isSafeInteger(recipientSequence)
      || recipientSequence <= previousSequence
      || typeof payloadHashBase64url !== "string"
      || payloadHashBase64url.length !== 43
    ) return false;
    previousSequence = recipientSequence;
  }
  return true;
}

function sameIndex(
  left: PreparedMutationJournalIndex,
  right: PreparedMutationJournalIndex,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class BrowserPreparedMutationJournalVault
implements PreparedMutationJournalVaultPort {
  readonly #databaseName: string;
  #database: IDBDatabase | undefined;
  #key: CryptoKey | undefined;
  #terminal: PreparedMutationJournalCustodyAvailability | undefined;

  constructor(databaseName = DATABASE_NAME) {
    this.#databaseName = databaseName;
  }

  availability(): Promise<PreparedMutationJournalCustodyAvailability> {
    return Promise.resolve(this.#terminal ?? {
      status: this.#key === undefined ? "locked" : "available",
    });
  }

  unlock(): Promise<PreparedMutationJournalCustodyAvailability> {
    if (
      typeof globalThis.indexedDB === "undefined"
      || typeof globalThis.crypto?.subtle === "undefined"
      || typeof globalThis.navigator?.locks?.request !== "function"
    ) return Promise.resolve(this.#setTerminal(
      "unsupported",
      "durable_webcrypto_unavailable",
    ));
    return this.#exclusive(async () => {
      try {
        const database = await this.#requiredDatabase();
        const records = await this.#records();
        const persisted = await readOne<BrowserJournalKey>(database, KEY_STORE, KEY_ID);
        if (persisted === undefined) {
          if (records.length > 0) {
            return this.#setTerminal("storage_lost", "browser_journal_key_missing");
          }
          const key = await crypto.subtle.generateKey(
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"],
          );
          await putOne(database, KEY_STORE, { id: KEY_ID, formatVersion: 1, key });
          this.#key = key;
          this.#terminal = undefined;
          return { status: "available" };
        }
        assertKey(persisted);
        await this.#authenticateRecords(persisted.key, records);
        this.#key = persisted.key;
        this.#terminal = undefined;
        return { status: "available" };
      } catch {
        return this.#setTerminal("corrupt", "browser_journal_authentication_failed");
      }
    });
  }

  lock(): Promise<void> {
    this.#key = undefined;
    this.#database?.close();
    this.#database = undefined;
    return Promise.resolve();
  }

  putSealed(input: Readonly<{
    index: PreparedMutationJournalIndex;
    canonicalBody: Uint8Array;
  }>): Promise<"inserted" | "exact_duplicate" | "collision"> {
    return this.#exclusive(async () => {
      const key = this.#requiredKey();
      const records = await this.#authenticatedRecords(key);
      const existing = records.find((record) =>
        record.operationId === input.index.operationId
      );
      if (existing !== undefined) {
        return existing.index.authenticatedRequestDigestBase64url
          === input.index.authenticatedRequestDigestBase64url
          ? "exact_duplicate"
          : "collision";
      }
      const record = await seal(key, input.index, input.canonicalBody);
      const total = records.reduce((sum, item) =>
        sum + item.index.sealedBytes, record.index.sealedBytes);
      if (
        records.length >= PREPARED_MUTATION_JOURNAL_LIMITS.maxRecords
        || total > PREPARED_MUTATION_JOURNAL_LIMITS.maxTotalSealedBytes
      ) throw new RangeError("prepared mutation journal is full");
      await putOne(await this.#requiredDatabase(), RECORD_STORE, record);
      return "inserted";
    });
  }

  listIndexes(): Promise<readonly PreparedMutationJournalIndex[]> {
    return this.#exclusive(async () => {
      const key = this.#requiredKey();
      return (await this.#authenticatedRecords(key)).map((record) =>
        Object.freeze({ ...record.index })
      );
    });
  }

  withOpenedBody<Result>(
    operationId: string,
    expectedDigestBase64url: string,
    use: (canonicalBody: Uint8Array) => Promise<Result> | Result,
  ): Promise<Result> {
    return this.#openThenUse(
      operationId,
      expectedDigestBase64url,
      use,
    );
  }

  async #openThenUse<Result>(
    operationId: string,
    expectedDigestBase64url: string,
    use: (canonicalBody: Uint8Array) => Promise<Result> | Result,
  ): Promise<Result> {
    const plaintext = await this.#exclusive(async () => {
      const key = this.#requiredKey();
      const record = await readOne<BrowserJournalRecord>(
        await this.#requiredDatabase(), RECORD_STORE, operationId,
      );
      if (record === undefined) throw new Error("prepared mutation journal record is unavailable");
      assertRecord(record);
      if (record.index.authenticatedRequestDigestBase64url !== expectedDigestBase64url) {
        throw new Error("prepared mutation journal record is unavailable");
      }
      return open(key, record);
    });
    try {
      // Do not hold the Web Lock while caller-owned reconciliation performs
      // another exact journal read/update. The authenticated detached bytes
      // remain bound to the requested digest and are wiped below.
      return await use(plaintext);
    } finally {
      plaintext.fill(0);
    }
  }

  updateIndex(
    expected: PreparedMutationJournalIndex,
    replacement: PreparedMutationJournalIndex,
  ): Promise<boolean> {
    return this.#exclusive(async () => {
      const key = this.#requiredKey();
      const records = await this.#authenticatedRecords(key);
      const current = records.find((record) =>
        record.operationId === expected.operationId
      );
      if (current === undefined) return false;
      assertRecord(current);
      if (!sameIndex(current.index, expected)) return false;
      const plaintext = await open(key, current);
      try {
        await putOne(
          await this.#requiredDatabase(),
          RECORD_STORE,
          await seal(key, replacement, plaintext),
        );
        return true;
      } finally {
        plaintext.fill(0);
      }
    });
  }

  removeExact(operationId: string, expectedDigestBase64url: string): Promise<boolean> {
    return this.#exclusive(async () => {
      const key = this.#requiredKey();
      const database = await this.#requiredDatabase();
      const current = (await this.#authenticatedRecords(key)).find((record) =>
        record.operationId === operationId
      );
      if (current === undefined) return false;
      assertRecord(current);
      if (current.index.authenticatedRequestDigestBase64url !== expectedDigestBase64url) {
        return false;
      }
      const transaction = database.transaction(RECORD_STORE, "readwrite");
      const done = transactionDone(transaction);
      transaction.objectStore(RECORD_STORE).delete(operationId);
      await done;
      return true;
    });
  }

  async #records(): Promise<readonly BrowserJournalRecord[]> {
    const records = await readAll<BrowserJournalRecord>(
      await this.#requiredDatabase(), RECORD_STORE,
    );
    if (records.length > PREPARED_MUTATION_JOURNAL_LIMITS.maxRecords) {
      throw new Error("browser prepared mutation journal is corrupt");
    }
    let total = 0;
    for (const record of records) {
      assertRecord(record);
      total += record.index.sealedBytes;
    }
    if (total > PREPARED_MUTATION_JOURNAL_LIMITS.maxTotalSealedBytes) {
      throw new Error("browser prepared mutation journal is corrupt");
    }
    return records;
  }

  async #authenticatedRecords(
    key: CryptoKey,
  ): Promise<readonly BrowserJournalRecord[]> {
    const records = await this.#records();
    await this.#authenticateRecords(key, records);
    return records;
  }

  async #authenticateRecords(
    key: CryptoKey,
    records: readonly BrowserJournalRecord[],
  ): Promise<void> {
    for (const record of records) {
      const plaintext = await open(key, record);
      try {
        if (plaintext.length !== record.index.canonicalBytes) {
          throw new Error("browser prepared mutation journal record is corrupt");
        }
      } finally {
        plaintext.fill(0);
      }
    }
  }

  async #requiredDatabase(): Promise<IDBDatabase> {
    this.#database ??= await openDatabase(this.#databaseName);
    return this.#database;
  }

  #requiredKey(): CryptoKey {
    if (this.#key === undefined) throw new Error("prepared mutation journal is locked");
    return this.#key;
  }

  #setTerminal(
    status: "unsupported" | "corrupt" | "storage_lost",
    reasonCode: string,
  ): PreparedMutationJournalCustodyAvailability {
    this.#key = undefined;
    this.#terminal = { status, reasonCode };
    return this.#terminal;
  }

  #exclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    return navigator.locks.request(
      this.#databaseName,
      { mode: "exclusive" },
      operation,
    ) as unknown as Promise<Result>;
  }
}

export function createBrowserPreparedMutationJournalVault(): BrowserPreparedMutationJournalVault {
  return new BrowserPreparedMutationJournalVault();
}

export function createBrowserAdditionalDeviceTransitionJournalVault():
BrowserPreparedMutationJournalVault {
  return new BrowserPreparedMutationJournalVault(ADDITIONAL_DEVICE_DATABASE_NAME);
}
