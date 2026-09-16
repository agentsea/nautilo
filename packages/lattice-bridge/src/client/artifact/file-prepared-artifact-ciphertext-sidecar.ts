import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";

import { atomicWritePrivateFile } from "../file-vault.ts";
import {
  assertPreparedArtifactCiphertextSidecarReference,
  preparedArtifactCiphertextSidecarReferencesEqual,
  type PreparedArtifactCiphertextSidecarPort,
  type PreparedArtifactCiphertextSidecarReference,
  type PreparedArtifactCiphertextStagingPort,
  type StagedArtifactCiphertextSidecarReference,
} from "./prepared-artifact-ciphertext-sidecar.ts";

const DIRECTORY = "protected-artifact-ciphertext-sidecars";
const tails = new Map<string, Promise<void>>();

function encodedDigest(hash: ReturnType<typeof createHash>): string {
  return hash.digest("base64url");
}

async function writeOwned(
  output: ReturnType<typeof createWriteStream>,
  bytes: Uint8Array,
): Promise<void> {
  const owned = Buffer.from(bytes);
  try {
    await new Promise<void>((resolve, reject) => {
      output.write(owned, (error) => error === null || error === undefined
        ? resolve()
        : reject(error));
    });
  } finally {
    owned.fill(0);
  }
}

function stem(operationId: string): string {
  return createHash("sha256").update(operationId).digest("hex");
}

function stagedDigest(stageId: string): string {
  return createHash("sha256").update(`nautilo/artifact-sidecar-stage/v1\0${stageId}`)
    .digest("base64url");
}

function metadataPath(directory: string, operationId: string): string {
  return join(directory, `${stem(operationId)}.json`);
}

function ciphertextPath(directory: string, operationId: string): string {
  return join(directory, `${stem(operationId)}.blob`);
}

async function readReference(
  path: string,
): Promise<PreparedArtifactCiphertextSidecarReference | undefined> {
  let bytes: string;
  try {
    bytes = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(bytes);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Prepared Artifact ciphertext sidecar metadata is corrupt");
  }
  const reference = parsed as PreparedArtifactCiphertextSidecarReference;
  assertPreparedArtifactCiphertextSidecarReference(reference);
  return Object.freeze({ ...reference });
}

async function hashFile(path: string): Promise<Readonly<{
  bytes: number;
  sha256Base64url: string;
}>> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const owned = chunk as Buffer;
    bytes += owned.length;
    hash.update(owned);
  }
  return { bytes, sha256Base64url: encodedDigest(hash) };
}

async function verifyFile(
  path: string,
  reference: PreparedArtifactCiphertextSidecarReference,
): Promise<void> {
  const observed = await hashFile(path);
  if (
    observed.bytes !== reference.ciphertextLength
    || observed.sha256Base64url !== reference.ciphertextSha256Base64url
  ) throw new Error("Prepared Artifact ciphertext sidecar is corrupt");
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export class FilePreparedArtifactCiphertextSidecar
implements PreparedArtifactCiphertextSidecarPort, PreparedArtifactCiphertextStagingPort {
  readonly #directory: string;

  constructor(rootDirectory: string) {
    this.#directory = join(rootDirectory, DIRECTORY);
  }

  stage(input: Readonly<{
    operationId: string;
    artifactId: string;
    blobId: string;
    blobGeneration: number;
    ciphertext: AsyncIterable<Uint8Array>;
  }>): Promise<StagedArtifactCiphertextSidecarReference> {
    return this.#exclusive(async () => {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const metaPath = metadataPath(this.#directory, input.operationId);
      if (await readReference(metaPath) !== undefined) {
        throw new Error("Prepared Artifact ciphertext stage already exists");
      }
      const blobPath = ciphertextPath(this.#directory, input.operationId);
      const tempPath = `${blobPath}.${randomUUID()}.tmp`;
      const output = createWriteStream(tempPath, { flags: "wx", mode: 0o600 });
      const hash = createHash("sha256");
      let bytes = 0;
      try {
        for await (const chunk of input.ciphertext) {
          if (!(chunk instanceof Uint8Array) || chunk.length === 0) {
            throw new TypeError("Prepared Artifact ciphertext chunk is invalid");
          }
          bytes += chunk.length;
          if (bytes > 110_100_000) {
            throw new RangeError("Prepared Artifact ciphertext stage exceeds its bound");
          }
          hash.update(chunk);
          await writeOwned(output, chunk);
        }
        if (bytes < 1) throw new RangeError("Prepared Artifact ciphertext stage is empty");
        output.end();
        await once(output, "close");
        const stageId = randomUUID();
        const staged = Object.freeze({
          formatVersion: 1 as const,
          stageId,
          operationId: input.operationId,
          artifactId: input.artifactId,
          blobId: input.blobId,
          blobGeneration: input.blobGeneration,
          ciphertextLength: bytes,
          ciphertextSha256Base64url: encodedDigest(hash),
        });
        const placeholder: PreparedArtifactCiphertextSidecarReference = {
          formatVersion: 1,
          operationId: staged.operationId,
          authenticatedRequestDigestBase64url: stagedDigest(stageId),
          artifactId: staged.artifactId,
          blobId: staged.blobId,
          blobGeneration: staged.blobGeneration,
          ciphertextLength: staged.ciphertextLength,
          ciphertextSha256Base64url: staged.ciphertextSha256Base64url,
        };
        await rename(tempPath, blobPath);
        await atomicWritePrivateFile(metaPath, JSON.stringify(placeholder));
        return staged;
      } catch (cause) {
        output.destroy();
        await removeIfPresent(tempPath);
        throw cause;
      }
    });
  }

  bind(input: Readonly<{
    staged: StagedArtifactCiphertextSidecarReference;
    reference: PreparedArtifactCiphertextSidecarReference;
  }>): Promise<"inserted" | "exact_duplicate" | "collision"> {
    return this.#exclusive(async () => {
      const path = metadataPath(this.#directory, input.staged.operationId);
      const existing = await readReference(path);
      if (existing === undefined) return "collision";
      if (preparedArtifactCiphertextSidecarReferencesEqual(existing, input.reference)) {
        return "exact_duplicate";
      }
      const sameStage = input.staged.operationId === input.reference.operationId
        && existing.authenticatedRequestDigestBase64url === stagedDigest(input.staged.stageId)
        && input.staged.artifactId === input.reference.artifactId
        && input.staged.blobId === input.reference.blobId
        && input.staged.blobGeneration === input.reference.blobGeneration
        && input.staged.ciphertextLength === input.reference.ciphertextLength
        && input.staged.ciphertextSha256Base64url
          === input.reference.ciphertextSha256Base64url;
      if (!sameStage) return "collision";
      await verifyFile(ciphertextPath(this.#directory, input.staged.operationId), input.reference);
      await atomicWritePrivateFile(path, JSON.stringify(input.reference));
      return "inserted";
    });
  }

  removeStagedExact(staged: StagedArtifactCiphertextSidecarReference): Promise<boolean> {
    return this.#exclusive(async () => {
      const meta = await readReference(metadataPath(this.#directory, staged.operationId));
      if (
        meta === undefined
        || meta.authenticatedRequestDigestBase64url !== stagedDigest(staged.stageId)
        || meta.artifactId !== staged.artifactId
        || meta.blobId !== staged.blobId
        || meta.blobGeneration !== staged.blobGeneration
        || meta.ciphertextLength !== staged.ciphertextLength
        || meta.ciphertextSha256Base64url !== staged.ciphertextSha256Base64url
      ) return false;
      await removeIfPresent(ciphertextPath(this.#directory, staged.operationId));
      await removeIfPresent(metadataPath(this.#directory, staged.operationId));
      return true;
    });
  }

  put(input: Readonly<{
    reference: PreparedArtifactCiphertextSidecarReference;
    ciphertext: AsyncIterable<Uint8Array>;
  }>): Promise<"inserted" | "exact_duplicate" | "collision"> {
    assertPreparedArtifactCiphertextSidecarReference(input.reference);
    return this.#exclusive(async () => {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const metaPath = metadataPath(this.#directory, input.reference.operationId);
      const blobPath = ciphertextPath(this.#directory, input.reference.operationId);
      const existing = await readReference(metaPath);
      if (existing !== undefined) {
        if (!preparedArtifactCiphertextSidecarReferencesEqual(existing, input.reference)) {
          return "collision";
        }
        await verifyFile(blobPath, existing);
        return "exact_duplicate";
      }

      const tempPath = `${blobPath}.${randomUUID()}.tmp`;
      const output = createWriteStream(tempPath, { flags: "wx", mode: 0o600 });
      const hash = createHash("sha256");
      let bytes = 0;
      try {
        for await (const chunk of input.ciphertext) {
          if (!(chunk instanceof Uint8Array) || chunk.length === 0) {
            throw new TypeError("Prepared Artifact ciphertext chunk is invalid");
          }
          bytes += chunk.length;
          if (bytes > input.reference.ciphertextLength) {
            throw new RangeError("Prepared Artifact ciphertext sidecar overran its declaration");
          }
          hash.update(chunk);
          await writeOwned(output, chunk);
        }
        output.end();
        await once(output, "close");
        const digest = encodedDigest(hash);
        if (
          bytes !== input.reference.ciphertextLength
          || digest !== input.reference.ciphertextSha256Base64url
        ) throw new Error("Prepared Artifact ciphertext sidecar disagrees with its declaration");
        await rename(tempPath, blobPath);
        await atomicWritePrivateFile(metaPath, JSON.stringify(input.reference));
        return "inserted";
      } catch (cause) {
        output.destroy();
        await removeIfPresent(tempPath);
        throw cause;
      }
    });
  }

  list(): Promise<readonly PreparedArtifactCiphertextSidecarReference[]> {
    return this.#exclusive(async () => {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const names = await readdir(this.#directory);
      const references: PreparedArtifactCiphertextSidecarReference[] = [];
      for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
        const reference = await readReference(join(this.#directory, name));
        if (reference === undefined || name !== `${stem(reference.operationId)}.json`) {
          throw new Error("Prepared Artifact ciphertext sidecar metadata is corrupt");
        }
        await verifyFile(ciphertextPath(this.#directory, reference.operationId), reference);
        references.push(reference);
      }
      return Object.freeze(references);
    });
  }

  withOpened<Result>(
    reference: PreparedArtifactCiphertextSidecarReference,
    use: (ciphertext: AsyncIterable<Uint8Array>) => Promise<Result> | Result,
  ): Promise<Result> {
    assertPreparedArtifactCiphertextSidecarReference(reference);
    return this.#exclusive(async () => {
      const existing = await readReference(
        metadataPath(this.#directory, reference.operationId),
      );
      if (
        existing === undefined
        || !preparedArtifactCiphertextSidecarReferencesEqual(existing, reference)
      ) throw new Error("Prepared Artifact ciphertext sidecar is unavailable");
      const path = ciphertextPath(this.#directory, reference.operationId);
      await verifyFile(path, reference);
      const opened = createReadStream(path);
      try {
        return await use(opened);
      } finally {
        opened.destroy();
      }
    });
  }

  removeExact(reference: PreparedArtifactCiphertextSidecarReference): Promise<boolean> {
    return this.#exclusive(async () => {
      const metaPath = metadataPath(this.#directory, reference.operationId);
      const existing = await readReference(metaPath);
      if (
        existing === undefined
        || !preparedArtifactCiphertextSidecarReferencesEqual(existing, reference)
      ) return false;
      await removeIfPresent(ciphertextPath(this.#directory, reference.operationId));
      await removeIfPresent(metaPath);
      return true;
    });
  }

  async reconcileUnindexedFiles(): Promise<number> {
    return this.#exclusive(async () => {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const names = await readdir(this.#directory);
      const metadataStems = new Set(
        names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)),
      );
      let removed = 0;
      for (const name of names) {
        const candidateStem = name.split(".")[0]!;
        if (
          (name.endsWith(".blob") || name.endsWith(".tmp"))
          && !metadataStems.has(candidateStem)
        ) {
          await removeIfPresent(join(this.#directory, name));
          removed += 1;
        }
      }
      return removed;
    });
  }

  #exclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    const tail = tails.get(this.#directory) ?? Promise.resolve();
    const result = tail.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    tails.set(this.#directory, settled);
    void settled.finally(() => {
      if (tails.get(this.#directory) === settled) tails.delete(this.#directory);
    });
    return result;
  }
}
