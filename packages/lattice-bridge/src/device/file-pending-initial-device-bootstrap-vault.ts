import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  atomicWritePrivateFile,
  type WrappingKeyStore,
  WrappingKeyStoreUnavailableError,
} from "../client/file-vault.ts";
import {
  decodePendingInitialDeviceBootstrap,
  encodePendingInitialDeviceBootstrap,
  pendingInitialDeviceBootstrapBytesEqual,
} from "./pending-initial-device-bootstrap-codec.ts";
import type {
  PendingInitialDeviceBootstrap,
  PendingInitialDeviceBootstrapVault,
} from "./restart-safe-initial-device-client-ceremony.ts";
import { destroyPendingInitialDeviceBootstrap } from
  "./restart-safe-initial-device-client-ceremony.ts";

const FORMAT_VERSION = 1 as const;
const FILE_NAME = "pending-initial-device-bootstrap.json";
const AES_KEY_BYTES = 32;
const AES_NONCE_BYTES = 12;
const AES_TAG_BYTES = 16;
const MAX_RECORDS = 8;
const fileTails = new Map<string, Promise<void>>();

interface PersistedPendingRecord {
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly idempotencyKey: string;
  readonly revision: 1 | 2;
  readonly plaintextSha256: string;
  readonly nonceBase64: string;
  readonly ciphertextBase64: string;
}

interface PersistedPendingDocument {
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly records: readonly PersistedPendingRecord[];
}

function emptyDocument(): PersistedPendingDocument {
  return { formatVersion: FORMAT_VERSION, records: [] };
}

function metadata(record: PersistedPendingRecord): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    formatVersion: record.formatVersion,
    idempotencyKey: record.idempotencyKey,
    revision: record.revision,
    plaintextSha256: record.plaintextSha256,
  }));
}

function digest(plaintext: Uint8Array): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

function seal(
  key: Uint8Array,
  value: PendingInitialDeviceBootstrap,
): PersistedPendingRecord {
  const plaintext = encodePendingInitialDeviceBootstrap(value);
  const nonce = randomBytes(AES_NONCE_BYTES);
  const record: PersistedPendingRecord = {
    formatVersion: FORMAT_VERSION,
    idempotencyKey: value.idempotencyKey,
    revision: value.revision,
    plaintextSha256: digest(plaintext),
    nonceBase64: nonce.toString("base64"),
    ciphertextBase64: "",
  };
  const aad = metadata(record);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return { ...record, ciphertextBase64: encrypted.toString("base64") };
  } finally {
    plaintext.fill(0);
    aad.fill(0);
  }
}

function open(
  key: Uint8Array,
  record: PersistedPendingRecord,
): PendingInitialDeviceBootstrap {
  const nonce = Buffer.from(record.nonceBase64, "base64");
  const encrypted = Buffer.from(record.ciphertextBase64, "base64");
  if (key.length !== AES_KEY_BYTES || nonce.length !== AES_NONCE_BYTES
    || encrypted.length <= AES_TAG_BYTES) {
    throw new Error("pending initial-device bootstrap record is corrupt");
  }
  const aad = metadata(record);
  let plaintext: Uint8Array | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(encrypted.subarray(-AES_TAG_BYTES));
    plaintext = new Uint8Array(Buffer.concat([
      decipher.update(encrypted.subarray(0, -AES_TAG_BYTES)),
      decipher.final(),
    ]));
    if (digest(plaintext) !== record.plaintextSha256) {
      throw new Error("pending initial-device bootstrap digest is corrupt");
    }
    const value = decodePendingInitialDeviceBootstrap(plaintext);
    if (value.idempotencyKey !== record.idempotencyKey
      || value.revision !== record.revision) {
      throw new Error("pending initial-device bootstrap metadata is corrupt");
    }
    return value;
  } finally {
    plaintext?.fill(0);
    aad.fill(0);
  }
}

function assertRecord(record: PersistedPendingRecord): void {
  const nonce = Buffer.from(record.nonceBase64, "base64");
  const ciphertext = Buffer.from(record.ciphertextBase64, "base64");
  if (record.formatVersion !== FORMAT_VERSION
    || typeof record.idempotencyKey !== "string"
    || record.idempotencyKey.length < 1 || record.idempotencyKey.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(record.idempotencyKey)
    || (record.revision !== 1 && record.revision !== 2)
    || !/^[0-9a-f]{64}$/u.test(record.plaintextSha256)
    || nonce.length !== AES_NONCE_BYTES
    || nonce.toString("base64") !== record.nonceBase64
    || ciphertext.length <= AES_TAG_BYTES
    || ciphertext.toString("base64") !== record.ciphertextBase64) {
    throw new Error("pending initial-device bootstrap document is corrupt");
  }
}

async function readDocument(path: string): Promise<PersistedPendingDocument> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyDocument();
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null
    || !("formatVersion" in parsed) || parsed.formatVersion !== FORMAT_VERSION
    || !("records" in parsed) || !Array.isArray(parsed.records)
    || parsed.records.length > MAX_RECORDS) {
    throw new Error("pending initial-device bootstrap document is corrupt");
  }
  const document = parsed as unknown as PersistedPendingDocument;
  const seen = new Set<string>();
  for (const record of document.records) {
    assertRecord(record);
    if (seen.has(record.idempotencyKey)) {
      throw new Error("pending initial-device bootstrap document is corrupt");
    }
    seen.add(record.idempotencyKey);
  }
  return document;
}

async function writeDocument(
  path: string,
  document: PersistedPendingDocument,
): Promise<void> {
  if (document.records.length > MAX_RECORDS) {
    throw new RangeError("pending initial-device bootstrap vault is full");
  }
  await atomicWritePrivateFile(path, JSON.stringify(document));
}

export class EncryptedFilePendingInitialDeviceBootstrapVault
implements PendingInitialDeviceBootstrapVault {
  readonly #path: string;
  readonly #keyStore: WrappingKeyStore;

  constructor(directory: string, keyStore: WrappingKeyStore) {
    this.#path = join(directory, FILE_NAME);
    this.#keyStore = keyStore;
  }

  load(idempotencyKey: string): Promise<PendingInitialDeviceBootstrap | null> {
    return this.#exclusive(async () => {
      const document = await readDocument(this.#path);
      const record = document.records.find((candidate) =>
        candidate.idempotencyKey === idempotencyKey
      );
      if (record === undefined) return null;
      return this.#withKey(document, (key) => open(key, record));
    });
  }

  create(value: PendingInitialDeviceBootstrap): Promise<
    "inserted" | "exact_duplicate" | "collision"
  > {
    return this.#exclusive(async () => {
      const document = await readDocument(this.#path);
      const existing = document.records.find((record) =>
        record.idempotencyKey === value.idempotencyKey
      );
      if (existing !== undefined) {
        const current = await this.#withKey(document, (key) => open(key, existing));
        try {
          return pendingInitialDeviceBootstrapBytesEqual(current, value)
            ? "exact_duplicate" : "collision";
        } finally {
          destroyPendingInitialDeviceBootstrap(current);
        }
      }
      if (document.records.length >= MAX_RECORDS) {
        throw new RangeError("pending initial-device bootstrap vault is full");
      }
      const record = await this.#withKey(document, (key) => seal(key, value));
      await writeDocument(this.#path, {
        formatVersion: FORMAT_VERSION,
        records: [...document.records, record],
      });
      return "inserted";
    });
  }

  compareAndSwap(input: Readonly<{
    expected: PendingInitialDeviceBootstrap;
    replacement: PendingInitialDeviceBootstrap;
  }>): Promise<boolean> {
    return this.#exclusive(async () => {
      if (input.expected.idempotencyKey !== input.replacement.idempotencyKey) {
        throw new TypeError("pending initial-device bootstrap key changed");
      }
      const document = await readDocument(this.#path);
      const position = document.records.findIndex((record) =>
        record.idempotencyKey === input.expected.idempotencyKey
      );
      const record = document.records[position];
      if (record === undefined) return false;
      const replacement = await this.#withKey(document, (key) => {
        const current = open(key, record);
        try {
          if (!pendingInitialDeviceBootstrapBytesEqual(current, input.expected)) {
            return null;
          }
          return seal(key, input.replacement);
        } finally {
          destroyPendingInitialDeviceBootstrap(current);
        }
      });
      if (replacement === null) return false;
      await writeDocument(this.#path, {
        formatVersion: FORMAT_VERSION,
        records: document.records.map((candidate, index) =>
          index === position ? replacement : candidate
        ),
      });
      return true;
    });
  }

  removeExact(value: PendingInitialDeviceBootstrap): Promise<boolean> {
    return this.#exclusive(async () => {
      const document = await readDocument(this.#path);
      const position = document.records.findIndex((record) =>
        record.idempotencyKey === value.idempotencyKey
      );
      const record = document.records[position];
      if (record === undefined) return false;
      const exact = await this.#withKey(document, (key) => {
        const current = open(key, record);
        try {
          return pendingInitialDeviceBootstrapBytesEqual(current, value);
        } finally {
          destroyPendingInitialDeviceBootstrap(current);
        }
      });
      if (!exact) return false;
      await writeDocument(this.#path, {
        formatVersion: FORMAT_VERSION,
        records: document.records.filter((_, index) => index !== position),
      });
      return true;
    });
  }

  async #withKey<Result>(
    document: PersistedPendingDocument,
    operation: (key: Uint8Array) => Result,
  ): Promise<Result> {
    const support = await this.#keyStore.support();
    if (!support.supported) {
      throw new WrappingKeyStoreUnavailableError(
        support.reasonCode ?? "pending bootstrap wrapping key unsupported",
      );
    }
    const candidates = await this.#keyStore.loadCandidates();
    if (candidates.length === 0) {
      if (document.records.length > 0) {
        throw new Error("pending initial-device bootstrap wrapping key is missing");
      }
      const created = randomBytes(AES_KEY_BYTES);
      try {
        await this.#keyStore.initialize(created);
        return operation(created);
      } finally {
        created.fill(0);
      }
    }
    try {
      if (document.records.length === 0) return operation(candidates[0]!);
      for (const candidate of candidates) {
        let opened: PendingInitialDeviceBootstrap | undefined;
        try {
          opened = open(candidate, document.records[0]!);
          return operation(candidate);
        } catch {
          // Try an interrupted-rotation predecessor key.
        } finally {
          destroyPendingInitialDeviceBootstrap(opened ?? null);
        }
      }
      throw new Error("pending initial-device bootstrap authentication failed");
    } finally {
      for (const candidate of candidates) candidate.fill(0);
    }
  }

  #exclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    const prior = fileTails.get(this.#path) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = prior.catch(() => undefined).then(operation);
    fileTails.set(this.#path, tail);
    return queued.finally(() => {
      release();
      if (fileTails.get(this.#path) === tail) fileTails.delete(this.#path);
    });
  }
}
