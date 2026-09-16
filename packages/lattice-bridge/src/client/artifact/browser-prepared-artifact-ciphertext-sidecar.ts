/// <reference lib="dom" />

import { sha256 } from "@noble/hashes/sha2.js";

import {
  assertPreparedArtifactCiphertextSidecarReference,
  preparedArtifactCiphertextSidecarReferencesEqual,
  type PreparedArtifactCiphertextSidecarPort,
  type PreparedArtifactCiphertextSidecarReference,
  type PreparedArtifactCiphertextStagingPort,
  type StagedArtifactCiphertextSidecarReference,
} from "./prepared-artifact-ciphertext-sidecar.ts";

const DATABASE_NAME = "nautilo-protected-artifact-ciphertext-sidecars-v1";
const DATABASE_VERSION = 1;
const METADATA_STORE = "sidecars";
const CHUNK_STORE = "chunks";
const LOCK_NAME = DATABASE_NAME;
const MAX_STORED_CHUNKS = 256;
const MAX_STORED_CHUNK_BYTES = 2 * 1_048_576;

interface BrowserSidecarMetadata {
  readonly operationId: string;
  readonly reference: PreparedArtifactCiphertextSidecarReference;
  readonly storedChunkCount: number;
}

interface BrowserSidecarChunk {
  readonly id: string;
  readonly operationId: string;
  readonly index: number;
  readonly bytes: Uint8Array;
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
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(METADATA_STORE)) {
        request.result.createObjectStore(METADATA_STORE, { keyPath: "operationId" });
      }
      if (!request.result.objectStoreNames.contains(CHUNK_STORE)) {
        const store = request.result.createObjectStore(CHUNK_STORE, { keyPath: "id" });
        store.createIndex("operationId", "operationId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB upgrade blocked"));
  });
}

function chunkId(operationId: string, index: number): string {
  return `${operationId}\u0000${index.toString().padStart(4, "0")}`;
}

function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function stagedDigest(stageId: string): string {
  const bytes = sha256(new TextEncoder().encode(
    `nautilo/artifact-sidecar-stage/v1\0${stageId}`,
  ));
  try {
    return toBase64url(bytes);
  } finally {
    bytes.fill(0);
  }
}

function assertMetadata(value: BrowserSidecarMetadata): void {
  assertPreparedArtifactCiphertextSidecarReference(value.reference);
  if (
    value.operationId !== value.reference.operationId
    || !Number.isSafeInteger(value.storedChunkCount)
    || value.storedChunkCount < 1
    || value.storedChunkCount > MAX_STORED_CHUNKS
  ) throw new Error("Browser Artifact ciphertext sidecar metadata is corrupt");
}

async function readMetadata(
  database: IDBDatabase,
  operationId: string,
): Promise<BrowserSidecarMetadata | undefined> {
  const transaction = database.transaction(METADATA_STORE, "readonly");
  const done = transactionDone(transaction);
  const result = await requestResult(
    transaction.objectStore(METADATA_STORE).get(operationId),
  ) as BrowserSidecarMetadata | undefined;
  await done;
  if (result !== undefined) assertMetadata(result);
  return result;
}

async function deleteOperation(database: IDBDatabase, operationId: string): Promise<void> {
  const transaction = database.transaction([METADATA_STORE, CHUNK_STORE], "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore(METADATA_STORE).delete(operationId);
  const index = transaction.objectStore(CHUNK_STORE).index("operationId");
  const cursor = index.openKeyCursor(IDBKeyRange.only(operationId));
  cursor.onsuccess = () => {
    if (cursor.result === null) return;
    transaction.objectStore(CHUNK_STORE).delete(cursor.result.primaryKey);
    cursor.result.continue();
  };
  await done;
}

async function readChunks(
  database: IDBDatabase,
  metadata: BrowserSidecarMetadata,
): Promise<readonly BrowserSidecarChunk[]> {
  const transaction = database.transaction(CHUNK_STORE, "readonly");
  const done = transactionDone(transaction);
  const chunks = await requestResult(
    transaction.objectStore(CHUNK_STORE).index("operationId").getAll(metadata.operationId),
  ) as BrowserSidecarChunk[];
  await done;
  chunks.sort((left, right) => left.index - right.index);
  if (
    chunks.length !== metadata.storedChunkCount
    || chunks.some((chunk, index) =>
      chunk.operationId !== metadata.operationId
      || chunk.index !== index
      || chunk.id !== chunkId(metadata.operationId, index)
      || !(chunk.bytes instanceof Uint8Array)
      || chunk.bytes.length < 1
      || chunk.bytes.length > MAX_STORED_CHUNK_BYTES
    )
  ) throw new Error("Browser Artifact ciphertext sidecar chunks are corrupt");
  return chunks;
}

function verifyChunks(
  metadata: BrowserSidecarMetadata,
  chunks: readonly BrowserSidecarChunk[],
): void {
  const hash = sha256.create();
  let length = 0;
  for (const chunk of chunks) {
    length += chunk.bytes.length;
    hash.update(chunk.bytes);
  }
  const digest = hash.digest();
  try {
    if (
      length !== metadata.reference.ciphertextLength
      || toBase64url(digest) !== metadata.reference.ciphertextSha256Base64url
    ) throw new Error("Browser Artifact ciphertext sidecar is corrupt");
  } finally {
    digest.fill(0);
  }
}

export class BrowserPreparedArtifactCiphertextSidecar
implements PreparedArtifactCiphertextSidecarPort, PreparedArtifactCiphertextStagingPort {
  #database: IDBDatabase | undefined;

  unlock(): Promise<void> {
    if (
      typeof globalThis.indexedDB === "undefined"
      || typeof globalThis.navigator?.locks?.request !== "function"
    ) throw new Error("Browser Artifact ciphertext sidecar storage is unavailable");
    return this.#exclusive(async () => {
      this.#database ??= await openDatabase();
      for (const metadata of await this.#metadata()) {
        verifyChunks(metadata, await readChunks(this.#database, metadata));
      }
    });
  }

  lock(): void {
    this.#database?.close();
    this.#database = undefined;
  }

  stage(input: Readonly<{
    operationId: string;
    artifactId: string;
    blobId: string;
    blobGeneration: number;
    ciphertext: AsyncIterable<Uint8Array>;
  }>): Promise<StagedArtifactCiphertextSidecarReference> {
    return this.#exclusive(async () => {
      const database = this.#requiredDatabase();
      if (await readMetadata(database, input.operationId) !== undefined) {
        throw new Error("Browser Artifact ciphertext stage already exists");
      }
      const hash = sha256.create();
      let length = 0;
      let count = 0;
      try {
        for await (const source of input.ciphertext) {
          if (
            !(source instanceof Uint8Array)
            || source.length < 1
            || source.length > MAX_STORED_CHUNK_BYTES
            || count >= MAX_STORED_CHUNKS
          ) throw new RangeError("Browser Artifact ciphertext stage chunk is invalid");
          length += source.length;
          if (length > 110_100_000) {
            throw new RangeError("Browser Artifact ciphertext stage exceeds its bound");
          }
          hash.update(source);
          const transaction = database.transaction(CHUNK_STORE, "readwrite");
          const done = transactionDone(transaction);
          transaction.objectStore(CHUNK_STORE).put({
            id: chunkId(input.operationId, count),
            operationId: input.operationId,
            index: count,
            bytes: source.slice(),
          } satisfies BrowserSidecarChunk);
          await done;
          count += 1;
        }
        if (length < 1 || count < 1) {
          throw new RangeError("Browser Artifact ciphertext stage is empty");
        }
        const digestBytes = hash.digest();
        const stageId = crypto.randomUUID();
        const staged = Object.freeze({
          formatVersion: 1 as const,
          stageId,
          operationId: input.operationId,
          artifactId: input.artifactId,
          blobId: input.blobId,
          blobGeneration: input.blobGeneration,
          ciphertextLength: length,
          ciphertextSha256Base64url: toBase64url(digestBytes),
        });
        digestBytes.fill(0);
        const transaction = database.transaction(METADATA_STORE, "readwrite");
        const done = transactionDone(transaction);
        transaction.objectStore(METADATA_STORE).put({
          operationId: input.operationId,
          reference: {
            formatVersion: 1,
            operationId: input.operationId,
            authenticatedRequestDigestBase64url: stagedDigest(stageId),
            artifactId: input.artifactId,
            blobId: input.blobId,
            blobGeneration: input.blobGeneration,
            ciphertextLength: length,
            ciphertextSha256Base64url: staged.ciphertextSha256Base64url,
          },
          storedChunkCount: count,
        } satisfies BrowserSidecarMetadata);
        await done;
        return staged;
      } catch (cause) {
        await deleteOperation(database, input.operationId);
        throw cause;
      }
    });
  }

  bind(input: Readonly<{
    staged: StagedArtifactCiphertextSidecarReference;
    reference: PreparedArtifactCiphertextSidecarReference;
  }>): Promise<"inserted" | "exact_duplicate" | "collision"> {
    return this.#exclusive(async () => {
      const database = this.#requiredDatabase();
      const metadata = await readMetadata(database, input.staged.operationId);
      if (metadata === undefined) return "collision";
      if (preparedArtifactCiphertextSidecarReferencesEqual(
        metadata.reference,
        input.reference,
      )) return "exact_duplicate";
      const sameStage = metadata.reference.authenticatedRequestDigestBase64url
          === stagedDigest(input.staged.stageId)
        && input.staged.operationId === input.reference.operationId
        && input.staged.artifactId === input.reference.artifactId
        && input.staged.blobId === input.reference.blobId
        && input.staged.blobGeneration === input.reference.blobGeneration
        && input.staged.ciphertextLength === input.reference.ciphertextLength
        && input.staged.ciphertextSha256Base64url
          === input.reference.ciphertextSha256Base64url;
      if (!sameStage) return "collision";
      verifyChunks(metadata, await readChunks(database, metadata));
      const transaction = database.transaction(METADATA_STORE, "readwrite");
      const done = transactionDone(transaction);
      transaction.objectStore(METADATA_STORE).put({
        ...metadata,
        reference: input.reference,
      } satisfies BrowserSidecarMetadata);
      await done;
      return "inserted";
    });
  }

  removeStagedExact(staged: StagedArtifactCiphertextSidecarReference): Promise<boolean> {
    return this.#exclusive(async () => {
      const database = this.#requiredDatabase();
      const metadata = await readMetadata(database, staged.operationId);
      if (
        metadata === undefined
        || metadata.reference.authenticatedRequestDigestBase64url !== stagedDigest(staged.stageId)
        || metadata.reference.artifactId !== staged.artifactId
        || metadata.reference.blobId !== staged.blobId
        || metadata.reference.blobGeneration !== staged.blobGeneration
        || metadata.reference.ciphertextLength !== staged.ciphertextLength
        || metadata.reference.ciphertextSha256Base64url
          !== staged.ciphertextSha256Base64url
      ) return false;
      await deleteOperation(database, staged.operationId);
      return true;
    });
  }

  put(input: Readonly<{
    reference: PreparedArtifactCiphertextSidecarReference;
    ciphertext: AsyncIterable<Uint8Array>;
  }>): Promise<"inserted" | "exact_duplicate" | "collision"> {
    assertPreparedArtifactCiphertextSidecarReference(input.reference);
    return this.#exclusive(async () => {
      const database = this.#requiredDatabase();
      const existing = await readMetadata(database, input.reference.operationId);
      if (existing !== undefined) {
        if (!preparedArtifactCiphertextSidecarReferencesEqual(
          existing.reference,
          input.reference,
        )) return "collision";
        verifyChunks(existing, await readChunks(database, existing));
        return "exact_duplicate";
      }
      await deleteOperation(database, input.reference.operationId);
      const hash = sha256.create();
      let length = 0;
      let count = 0;
      try {
        for await (const source of input.ciphertext) {
          if (
            !(source instanceof Uint8Array)
            || source.length < 1
            || source.length > MAX_STORED_CHUNK_BYTES
            || count >= MAX_STORED_CHUNKS
          ) throw new RangeError("Browser Artifact ciphertext sidecar chunk is invalid");
          length += source.length;
          if (length > input.reference.ciphertextLength) {
            throw new RangeError("Browser Artifact ciphertext sidecar overran its declaration");
          }
          hash.update(source);
          const owned = source.slice();
          const transaction = database.transaction(CHUNK_STORE, "readwrite");
          const done = transactionDone(transaction);
          transaction.objectStore(CHUNK_STORE).put({
            id: chunkId(input.reference.operationId, count),
            operationId: input.reference.operationId,
            index: count,
            bytes: owned,
          } satisfies BrowserSidecarChunk);
          await done;
          count += 1;
        }
        const digest = hash.digest();
        try {
          if (
            count < 1
            || length !== input.reference.ciphertextLength
            || toBase64url(digest) !== input.reference.ciphertextSha256Base64url
          ) throw new Error("Browser Artifact ciphertext sidecar disagrees with its declaration");
        } finally {
          digest.fill(0);
        }
        const transaction = database.transaction(METADATA_STORE, "readwrite");
        const done = transactionDone(transaction);
        transaction.objectStore(METADATA_STORE).put({
          operationId: input.reference.operationId,
          reference: input.reference,
          storedChunkCount: count,
        } satisfies BrowserSidecarMetadata);
        await done;
        return "inserted";
      } catch (cause) {
        await deleteOperation(database, input.reference.operationId);
        throw cause;
      }
    });
  }

  list(): Promise<readonly PreparedArtifactCiphertextSidecarReference[]> {
    return this.#exclusive(async () => Object.freeze(
      (await this.#metadata()).map((metadata) => Object.freeze({ ...metadata.reference })),
    ));
  }

  withOpened<Result>(
    reference: PreparedArtifactCiphertextSidecarReference,
    use: (ciphertext: AsyncIterable<Uint8Array>) => Promise<Result> | Result,
  ): Promise<Result> {
    return this.#exclusive(async () => {
      const metadata = await readMetadata(this.#requiredDatabase(), reference.operationId);
      if (
        metadata === undefined
        || !preparedArtifactCiphertextSidecarReferencesEqual(metadata.reference, reference)
      ) throw new Error("Browser Artifact ciphertext sidecar is unavailable");
      const chunks = await readChunks(this.#requiredDatabase(), metadata);
      verifyChunks(metadata, chunks);
      const opened: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]() {
          let index = 0;
          return {
            next(): Promise<IteratorResult<Uint8Array>> {
              const chunk = chunks[index++];
              return Promise.resolve(chunk === undefined
                ? { done: true, value: undefined }
                : { done: false, value: chunk.bytes.slice() });
            },
          };
        },
      };
      return await use(opened);
    });
  }

  removeExact(reference: PreparedArtifactCiphertextSidecarReference): Promise<boolean> {
    return this.#exclusive(async () => {
      const database = this.#requiredDatabase();
      const metadata = await readMetadata(database, reference.operationId);
      if (
        metadata === undefined
        || !preparedArtifactCiphertextSidecarReferencesEqual(metadata.reference, reference)
      ) return false;
      await deleteOperation(database, reference.operationId);
      return true;
    });
  }

  async #metadata(): Promise<readonly BrowserSidecarMetadata[]> {
    const transaction = this.#requiredDatabase().transaction(METADATA_STORE, "readonly");
    const done = transactionDone(transaction);
    const values = await requestResult(
      transaction.objectStore(METADATA_STORE).getAll(),
    ) as BrowserSidecarMetadata[];
    await done;
    for (const value of values) assertMetadata(value);
    return values.sort((left, right) =>
      left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0
    );
  }

  #requiredDatabase(): IDBDatabase {
    if (this.#database === undefined) {
      throw new Error("Browser Artifact ciphertext sidecar is locked");
    }
    return this.#database;
  }

  #exclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    return navigator.locks.request(
      LOCK_NAME,
      { mode: "exclusive" },
      operation,
    ) as unknown as Promise<Result>;
  }
}
