/// <reference lib="dom" />

import {
  decodePendingInitialDeviceBootstrap,
  encodePendingInitialDeviceBootstrap,
  pendingInitialDeviceBootstrapBytesEqual,
} from "./pending-initial-device-bootstrap-codec.ts";
import {
  destroyPendingInitialDeviceBootstrap,
  type PendingInitialDeviceBootstrap,
  type PendingInitialDeviceBootstrapVault,
} from "./restart-safe-initial-device-client-ceremony.ts";

const DATABASE_NAME = "nautilo-pending-initial-device-bootstrap-v1";
const DATABASE_VERSION = 1;
const KEY_STORE = "wrapping_keys";
const RECORD_STORE = "pending_records";
const KEY_ID = "root";
const LOCK_NAME = DATABASE_NAME;
const AES_NONCE_BYTES = 12;
const AES_TAG_BYTES = 16;
const MAX_RECORDS = 8;

interface BrowserPendingKey {
  readonly id: typeof KEY_ID;
  readonly formatVersion: 1;
  readonly key: CryptoKey;
}

interface BrowserPendingRecord {
  readonly formatVersion: 1;
  readonly idempotencyKey: string;
  readonly revision: 1 | 2;
  readonly plaintextSha256: Uint8Array;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(bytes.length);
  owned.set(bytes);
  return owned.buffer;
}

function metadata(record: Omit<BrowserPendingRecord, "nonce" | "ciphertext">) {
  return new TextEncoder().encode(JSON.stringify({
    formatVersion: record.formatVersion,
    idempotencyKey: record.idempotencyKey,
    revision: record.revision,
    plaintextSha256: Array.from(record.plaintextSha256),
  }));
}

async function seal(
  key: CryptoKey,
  value: PendingInitialDeviceBootstrap,
): Promise<BrowserPendingRecord> {
  const plaintext = encodePendingInitialDeviceBootstrap(value);
  const nonce = crypto.getRandomValues(new Uint8Array(AES_NONCE_BYTES));
  const base = {
    formatVersion: 1 as const,
    idempotencyKey: value.idempotencyKey,
    revision: value.revision,
    plaintextSha256: new Uint8Array(
      await crypto.subtle.digest("SHA-256", ownedBuffer(plaintext)),
    ),
  };
  const additionalData = metadata(base);
  try {
    return {
      ...base,
      nonce,
      ciphertext: new Uint8Array(await crypto.subtle.encrypt({
        name: "AES-GCM",
        iv: ownedBuffer(nonce),
        additionalData: ownedBuffer(additionalData),
        tagLength: 128,
      }, key, ownedBuffer(plaintext))),
    };
  } finally {
    plaintext.fill(0);
    additionalData.fill(0);
  }
}

async function open(
  key: CryptoKey,
  record: BrowserPendingRecord,
): Promise<PendingInitialDeviceBootstrap> {
  const additionalData = metadata(record);
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = new Uint8Array(await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: ownedBuffer(record.nonce),
      additionalData: ownedBuffer(additionalData),
      tagLength: 128,
    }, key, ownedBuffer(record.ciphertext)));
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", ownedBuffer(plaintext)),
    );
    try {
      if (digest.length !== record.plaintextSha256.length
        || digest.some((byte, index) => byte !== record.plaintextSha256[index])) {
        throw new Error("browser pending bootstrap digest is corrupt");
      }
    } finally {
      digest.fill(0);
    }
    const value = decodePendingInitialDeviceBootstrap(plaintext);
    if (value.idempotencyKey !== record.idempotencyKey
      || value.revision !== record.revision) {
      throw new Error("browser pending bootstrap metadata is corrupt");
    }
    return value;
  } finally {
    plaintext?.fill(0);
    additionalData.fill(0);
  }
}

function requestResult<Result>(request: IDBRequest<Result>): Promise<Result> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error ?? new Error("IndexedDB request failed"),
    );
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

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(KEY_STORE)) {
        request.result.createObjectStore(KEY_STORE, { keyPath: "id" });
      }
      if (!request.result.objectStoreNames.contains(RECORD_STORE)) {
        request.result.createObjectStore(RECORD_STORE, {
          keyPath: "idempotencyKey",
        });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error ?? new Error("IndexedDB open failed"),
    );
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

async function count(database: IDBDatabase): Promise<number> {
  const transaction = database.transaction(RECORD_STORE, "readonly");
  const done = transactionDone(transaction);
  const result = await requestResult(transaction.objectStore(RECORD_STORE).count());
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

async function deleteOne(
  database: IDBDatabase,
  storeName: string,
  key: string,
): Promise<void> {
  const transaction = database.transaction(storeName, "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore(storeName).delete(key);
  await done;
}

function assertKey(value: BrowserPendingKey): void {
  if (value.id !== KEY_ID || value.formatVersion !== 1
    || !(value.key instanceof CryptoKey) || value.key.extractable
    || value.key.algorithm.name !== "AES-GCM") {
    throw new Error("browser pending bootstrap key is corrupt");
  }
}

function assertRecord(value: BrowserPendingRecord): void {
  if (value.formatVersion !== 1
    || typeof value.idempotencyKey !== "string"
    || value.idempotencyKey.length < 1 || value.idempotencyKey.length > 128
    || (value.revision !== 1 && value.revision !== 2)
    || !(value.plaintextSha256 instanceof Uint8Array)
    || value.plaintextSha256.length !== 32
    || !(value.nonce instanceof Uint8Array)
    || value.nonce.length !== AES_NONCE_BYTES
    || !(value.ciphertext instanceof Uint8Array)
    || value.ciphertext.length <= AES_TAG_BYTES) {
    throw new Error("browser pending bootstrap record is corrupt");
  }
}

export class BrowserPendingInitialDeviceBootstrapVault
implements PendingInitialDeviceBootstrapVault {
  #database: IDBDatabase | undefined;

  load(idempotencyKey: string): Promise<PendingInitialDeviceBootstrap | null> {
    return this.#exclusive(async () => {
      const database = await this.#requiredDatabase();
      const record = await readOne<BrowserPendingRecord>(
        database,
        RECORD_STORE,
        idempotencyKey,
      );
      if (record === undefined) return null;
      assertRecord(record);
      return open(await this.#requiredKey(database, true), record);
    });
  }

  create(value: PendingInitialDeviceBootstrap): Promise<
    "inserted" | "exact_duplicate" | "collision"
  > {
    return this.#exclusive(async () => {
      const database = await this.#requiredDatabase();
      const existing = await readOne<BrowserPendingRecord>(
        database,
        RECORD_STORE,
        value.idempotencyKey,
      );
      const key = await this.#requiredKey(database, existing !== undefined);
      if (existing !== undefined) {
        assertRecord(existing);
        const current = await open(key, existing);
        try {
          return pendingInitialDeviceBootstrapBytesEqual(current, value)
            ? "exact_duplicate" : "collision";
        } finally {
          destroyPendingInitialDeviceBootstrap(current);
        }
      }
      if (await count(database) >= MAX_RECORDS) {
        throw new RangeError("browser pending bootstrap vault is full");
      }
      await putOne(database, RECORD_STORE, await seal(key, value));
      return "inserted";
    });
  }

  compareAndSwap(input: Readonly<{
    expected: PendingInitialDeviceBootstrap;
    replacement: PendingInitialDeviceBootstrap;
  }>): Promise<boolean> {
    return this.#exclusive(async () => {
      if (input.expected.idempotencyKey !== input.replacement.idempotencyKey) {
        throw new TypeError("browser pending bootstrap key changed");
      }
      const database = await this.#requiredDatabase();
      const record = await readOne<BrowserPendingRecord>(
        database,
        RECORD_STORE,
        input.expected.idempotencyKey,
      );
      if (record === undefined) return false;
      assertRecord(record);
      const key = await this.#requiredKey(database, true);
      const current = await open(key, record);
      try {
        if (!pendingInitialDeviceBootstrapBytesEqual(current, input.expected)) {
          return false;
        }
      } finally {
        destroyPendingInitialDeviceBootstrap(current);
      }
      await putOne(database, RECORD_STORE, await seal(key, input.replacement));
      return true;
    });
  }

  removeExact(value: PendingInitialDeviceBootstrap): Promise<boolean> {
    return this.#exclusive(async () => {
      const database = await this.#requiredDatabase();
      const record = await readOne<BrowserPendingRecord>(
        database,
        RECORD_STORE,
        value.idempotencyKey,
      );
      if (record === undefined) return false;
      assertRecord(record);
      const current = await open(await this.#requiredKey(database, true), record);
      try {
        if (!pendingInitialDeviceBootstrapBytesEqual(current, value)) return false;
      } finally {
        destroyPendingInitialDeviceBootstrap(current);
      }
      await deleteOne(database, RECORD_STORE, value.idempotencyKey);
      return true;
    });
  }

  async #requiredDatabase(): Promise<IDBDatabase> {
    this.#database ??= await openDatabase();
    return this.#database;
  }

  async #requiredKey(
    database: IDBDatabase,
    recordsExist: boolean,
  ): Promise<CryptoKey> {
    const stored = await readOne<BrowserPendingKey>(database, KEY_STORE, KEY_ID);
    if (stored !== undefined) {
      assertKey(stored);
      return stored.key;
    }
    if (recordsExist || await count(database) > 0) {
      throw new Error("browser pending bootstrap wrapping key is missing");
    }
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    await putOne(database, KEY_STORE, {
      id: KEY_ID,
      formatVersion: 1,
      key,
    } satisfies BrowserPendingKey);
    return key;
  }

  #exclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (typeof globalThis.indexedDB === "undefined"
      || typeof globalThis.crypto?.subtle === "undefined"
      || typeof globalThis.navigator?.locks?.request !== "function") {
      return Promise.reject(
        new Error("browser pending bootstrap durable custody is unavailable"),
      );
    }
    return navigator.locks.request(
      LOCK_NAME,
      { mode: "exclusive" },
      operation,
    ) as unknown as Promise<Result>;
  }
}

export function createBrowserPendingInitialDeviceBootstrapVault():
PendingInitialDeviceBootstrapVault {
  return new BrowserPendingInitialDeviceBootstrapVault();
}
