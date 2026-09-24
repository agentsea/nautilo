import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  atomicWritePrivateFile,
  type WrappingKeyStore,
  WrappingKeyStoreUnavailableError,
} from "../file-vault.ts";
import {
  decodePreparedMutationJournalIndex,
  type PreparedMutationJournalIndex,
  type PreparedMutationJournalVaultPort,
} from "./prepared-mutation-journal.ts";
import { PREPARED_MUTATION_JOURNAL_LIMITS } from "./prepared-mutation-journal-limits.ts";

const FORMAT_VERSION = 1;
const FILE_NAME = "protected-memory-mutation-journal.json";
const AES_KEY_BYTES = 32;
const AES_NONCE_BYTES = 12;
const AES_TAG_BYTES = 16;
const pathTails = new Map<string, Promise<void>>();

export type PreparedMutationJournalCustodyAvailability =
  | Readonly<{ status: "available" | "locked" }>
  | Readonly<{
      status: "unsupported" | "corrupt" | "storage_lost";
      reasonCode: string;
    }>;

interface PersistedJournalRecord {
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly index: PreparedMutationJournalIndex;
  readonly nonceBase64: string;
  readonly ciphertextBase64: string;
}

interface PersistedJournalDocument {
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly records: readonly PersistedJournalRecord[];
}

function emptyDocument(): PersistedJournalDocument {
  return { formatVersion: FORMAT_VERSION, records: [] };
}

function indexAad(index: PreparedMutationJournalIndex): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(index));
}

function seal(
  key: Uint8Array,
  index: PreparedMutationJournalIndex,
  plaintext: Uint8Array,
): PersistedJournalRecord {
  decodePreparedMutationJournalIndex(index);
  if (plaintext.length !== index.canonicalBytes) {
    throw new TypeError("file prepared mutation journal body length disagrees");
  }
  const nonce = randomBytes(AES_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const persistedIndex = Object.freeze({
    ...index,
    sealedBytes: plaintext.length + AES_TAG_BYTES,
  });
  decodePreparedMutationJournalIndex(persistedIndex);
  const aad = indexAad(persistedIndex);
  try {
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return {
      formatVersion: FORMAT_VERSION,
      index: persistedIndex,
      nonceBase64: nonce.toString("base64"),
      ciphertextBase64: encrypted.toString("base64"),
    };
  } finally {
    aad.fill(0);
  }
}

function open(key: Uint8Array, record: PersistedJournalRecord): Uint8Array {
  const nonce = Buffer.from(record.nonceBase64, "base64");
  const encrypted = Buffer.from(record.ciphertextBase64, "base64");
  if (
    key.length !== AES_KEY_BYTES
    || nonce.length !== AES_NONCE_BYTES
    || encrypted.length <= AES_TAG_BYTES
  ) throw new Error("prepared mutation journal record is corrupt");
  const ciphertext = encrypted.subarray(0, -AES_TAG_BYTES);
  const tag = encrypted.subarray(-AES_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  const aad = indexAad(record.index);
  try {
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]));
  } finally {
    aad.fill(0);
  }
}

function assertDocument(document: PersistedJournalDocument): void {
  const candidateRecords: unknown = document.records;
  if (
    document.formatVersion !== FORMAT_VERSION
    || !Array.isArray(candidateRecords)
    || candidateRecords.length > PREPARED_MUTATION_JOURNAL_LIMITS.maxRecords
  ) throw new Error("prepared mutation journal document is corrupt");
  const records = candidateRecords as readonly PersistedJournalRecord[];
  const seen = new Set<string>();
  let sealedBytes = 0;
  for (const record of records) {
    decodePreparedMutationJournalIndex(record.index);
    const ciphertext = Buffer.from(record.ciphertextBase64, "base64");
    if (
      record.formatVersion !== FORMAT_VERSION
      || Buffer.from(record.nonceBase64, "base64").length !== AES_NONCE_BYTES
      || ciphertext.length !== record.index.sealedBytes
      || record.index.sealedBytes !== record.index.canonicalBytes + AES_TAG_BYTES
      || seen.has(record.index.operationId)
    ) throw new Error("prepared mutation journal document is corrupt");
    seen.add(record.index.operationId);
    sealedBytes += ciphertext.length;
  }
  if (sealedBytes > PREPARED_MUTATION_JOURNAL_LIMITS.maxTotalSealedBytes) {
    throw new Error("prepared mutation journal document is corrupt");
  }
}

async function readDocument(path: string): Promise<PersistedJournalDocument> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyDocument();
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("prepared mutation journal document is corrupt");
  }
  const document = parsed as PersistedJournalDocument;
  assertDocument(document);
  return document;
}

function writeDocument(
  path: string,
  document: PersistedJournalDocument,
): Promise<void> {
  assertDocument(document);
  return atomicWritePrivateFile(path, JSON.stringify(document));
}

function sameIndex(
  left: PreparedMutationJournalIndex,
  right: PreparedMutationJournalIndex,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class EncryptedFilePreparedMutationJournalVault
implements PreparedMutationJournalVaultPort {
  readonly #path: string;
  readonly #keyStore: WrappingKeyStore;
  #key: Uint8Array | undefined;
  #terminal: PreparedMutationJournalCustodyAvailability | undefined;

  constructor(
    directory: string,
    keyStore: WrappingKeyStore,
    fileName = FILE_NAME,
  ) {
    this.#path = join(directory, fileName);
    this.#keyStore = keyStore;
  }

  availability(): Promise<PreparedMutationJournalCustodyAvailability> {
    return Promise.resolve(this.#terminal ?? {
      status: this.#key === undefined ? "locked" : "available",
    });
  }

  unlock(): Promise<PreparedMutationJournalCustodyAvailability> {
    return this.#exclusive(async () => {
      const support = await this.#keyStore.support();
      if (!support.supported) {
        return this.#setTerminal("unsupported", support.reasonCode ?? "wrapping_key_unsupported");
      }
      let document: PersistedJournalDocument;
      try {
        document = await readDocument(this.#path);
      } catch {
        return this.#setTerminal("corrupt", "journal_document_corrupt");
      }
      let candidates: readonly Uint8Array[];
      try {
        candidates = await this.#keyStore.loadCandidates();
      } catch (error) {
        return this.#setTerminal(
          error instanceof WrappingKeyStoreUnavailableError ? "unsupported" : "corrupt",
          error instanceof WrappingKeyStoreUnavailableError
            ? "wrapping_key_store_unavailable"
            : "wrapping_key_store_corrupt",
        );
      }
      if (candidates.length === 0) {
        if (document.records.length > 0) {
          return this.#setTerminal("storage_lost", "journal_wrapping_key_missing");
        }
        const created = randomBytes(AES_KEY_BYTES);
        try {
          await this.#keyStore.initialize(created);
          this.#replaceKey(created);
          this.#terminal = undefined;
          return { status: "available" };
        } catch {
          return this.#setTerminal("unsupported", "wrapping_key_store_unavailable");
        } finally {
          created.fill(0);
        }
      }
      const selected = this.#selectCandidate(candidates, document);
      const ownedSelected = selected === undefined
        ? undefined
        : Uint8Array.from(selected);
      for (const candidate of candidates) candidate.fill(0);
      if (ownedSelected === undefined) {
        return this.#setTerminal("corrupt", "journal_authentication_failed");
      }
      this.#replaceKey(ownedSelected);
      ownedSelected.fill(0);
      this.#terminal = undefined;
      return { status: "available" };
    });
  }

  lock(): Promise<void> {
    return this.#exclusive(() => {
      this.#key?.fill(0);
      this.#key = undefined;
      return Promise.resolve();
    });
  }

  putSealed(input: Readonly<{
    index: PreparedMutationJournalIndex;
    canonicalBody: Uint8Array;
  }>): Promise<"inserted" | "exact_duplicate" | "collision"> {
    return this.#exclusive(async () => {
      const key = this.#requiredKey();
      const document = await this.#readAuthenticatedDocument(key);
      const existing = document.records.find((record) =>
        record.index.operationId === input.index.operationId
      );
      if (existing !== undefined) {
        return existing.index.authenticatedRequestDigestBase64url
          === input.index.authenticatedRequestDigestBase64url
          ? "exact_duplicate"
          : "collision";
      }
      const record = seal(key, input.index, input.canonicalBody);
      const total = document.records.reduce((sum, item) =>
        sum + item.index.sealedBytes, record.index.sealedBytes);
      if (
        document.records.length >= PREPARED_MUTATION_JOURNAL_LIMITS.maxRecords
        || total > PREPARED_MUTATION_JOURNAL_LIMITS.maxTotalSealedBytes
      ) throw new RangeError("prepared mutation journal is full");
      await writeDocument(this.#path, {
        formatVersion: FORMAT_VERSION,
        records: [...document.records, record],
      });
      return "inserted";
    });
  }

  listIndexes(): Promise<readonly PreparedMutationJournalIndex[]> {
    return this.#exclusive(async () => {
      const key = this.#requiredKey();
      return (await this.#readAuthenticatedDocument(key)).records.map((record) =>
        Object.freeze({ ...record.index })
      );
    });
  }

  withOpenedBody<Result>(
    operationId: string,
    expectedDigestBase64url: string,
    use: (canonicalBody: Uint8Array) => Promise<Result> | Result,
  ): Promise<Result> {
    return this.#exclusive(async () => {
      const key = this.#requiredKey();
      const record = (await readDocument(this.#path)).records.find((item) =>
        item.index.operationId === operationId
      );
      if (
        record === undefined
        || record.index.authenticatedRequestDigestBase64url !== expectedDigestBase64url
      ) throw new Error("prepared mutation journal record is unavailable");
      const plaintext = open(key, record);
      try {
        return await use(plaintext);
      } finally {
        plaintext.fill(0);
      }
    });
  }

  updateIndex(
    expected: PreparedMutationJournalIndex,
    replacement: PreparedMutationJournalIndex,
  ): Promise<boolean> {
    return this.#exclusive(async () => {
      const key = this.#requiredKey();
      const document = await this.#readAuthenticatedDocument(key);
      const position = document.records.findIndex((record) =>
        record.index.operationId === expected.operationId
      );
      const current = document.records[position];
      if (current === undefined || !sameIndex(current.index, expected)) return false;
      const plaintext = open(key, current);
      try {
        const resealed = seal(key, replacement, plaintext);
        await writeDocument(this.#path, {
          formatVersion: FORMAT_VERSION,
          records: document.records.map((record, index) =>
            index === position ? resealed : record
          ),
        });
        return true;
      } finally {
        plaintext.fill(0);
      }
    });
  }

  removeExact(operationId: string, expectedDigestBase64url: string): Promise<boolean> {
    return this.#exclusive(async () => {
      const key = this.#requiredKey();
      const document = await this.#readAuthenticatedDocument(key);
      const current = document.records.find((record) =>
        record.index.operationId === operationId
      );
      if (
        current === undefined
        || current.index.authenticatedRequestDigestBase64url !== expectedDigestBase64url
      ) return false;
      await writeDocument(this.#path, {
        formatVersion: FORMAT_VERSION,
        records: document.records.filter((record) =>
          record.index.operationId !== operationId
        ),
      });
      return true;
    });
  }

  #requiredKey(): Uint8Array {
    if (this.#key === undefined) throw new Error("prepared mutation journal is locked");
    return this.#key;
  }

  #replaceKey(key: Uint8Array): void {
    this.#key?.fill(0);
    this.#key = Uint8Array.from(key);
  }

  #selectCandidate(
    candidates: readonly Uint8Array[],
    document: PersistedJournalDocument,
  ): Uint8Array | undefined {
    if (document.records.length === 0) return candidates[0];
    for (const candidate of candidates) {
      try {
        for (const record of document.records) {
          const plaintext = open(candidate, record);
          try {
            if (plaintext.length !== record.index.canonicalBytes) {
              throw new Error("prepared mutation journal record is corrupt");
            }
          } finally {
            plaintext.fill(0);
          }
        }
        return candidate;
      } catch {
        // Try every exact candidate exposed by the protected key store.
      }
    }
    return undefined;
  }

  async #readAuthenticatedDocument(
    key: Uint8Array,
  ): Promise<PersistedJournalDocument> {
    const document = await readDocument(this.#path);
    for (const record of document.records) {
      const plaintext = open(key, record);
      try {
        if (plaintext.length !== record.index.canonicalBytes) {
          throw new Error("prepared mutation journal record is corrupt");
        }
      } finally {
        plaintext.fill(0);
      }
    }
    return document;
  }

  #setTerminal(
    status: "unsupported" | "corrupt" | "storage_lost",
    reasonCode: string,
  ): PreparedMutationJournalCustodyAvailability {
    this.#key?.fill(0);
    this.#key = undefined;
    this.#terminal = { status, reasonCode };
    return this.#terminal;
  }

  #exclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    const tail = pathTails.get(this.#path) ?? Promise.resolve();
    const result = tail.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    pathTails.set(this.#path, settled);
    void settled.finally(() => {
      if (pathTails.get(this.#path) === settled) pathTails.delete(this.#path);
    });
    return result;
  }
}
