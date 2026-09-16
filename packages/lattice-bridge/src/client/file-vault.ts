import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CLIENT_PROFILE_VAULT_FORMAT_VERSION,
  CLIENT_PROFILE_VAULT_MAX_PROFILES,
  type ClientProfileCoordinates,
  type ClientProfilePublicState,
  type ClientProfileVault,
  type ClientProfileVaultAvailability,
  type InterruptedClientProfileResolution,
  type PublicClientProfile,
  type StageClientProfileInput,
  type StagedClientProfileReceipt,
} from "../client-vault/types.ts";
import {
  assertClientProfileCoordinates,
  assertStageInput,
  coordinatesKey,
} from "../client-vault/validation.ts";

const VAULT_FILE_NAME = "client-profile-vault.json";
const AES_KEY_BYTES = 32;
const AES_NONCE_BYTES = 12;
const AES_TAG_BYTES = 16;
const MAX_RECORDS = CLIENT_PROFILE_VAULT_MAX_PROFILES * 2;
const profileVaultFileTails = new Map<string, Promise<void>>();

export interface WrappingKeySupport {
  readonly supported: boolean;
  readonly reasonCode?: string;
}

export interface WrappingKeyStore {
  support(): Promise<WrappingKeySupport>;
  loadCandidates(): Promise<readonly Uint8Array[]>;
  initialize(key: Uint8Array): Promise<void>;
  stageRotation(current: Uint8Array, previous: Uint8Array): Promise<void>;
  commitRotation(): Promise<void>;
  rollbackRotation(): Promise<void>;
}

export class WrappingKeyStoreUnavailableError extends Error {
  override readonly name = "WrappingKeyStoreUnavailableError";
}

interface PersistedProfileRecord {
  readonly formatVersion: typeof CLIENT_PROFILE_VAULT_FORMAT_VERSION;
  readonly recordId: string;
  readonly lifecycle: "staged" | "active";
  readonly coordinates: ClientProfileCoordinates;
  readonly generation: number;
  readonly publicState: ClientProfilePublicState;
  readonly stageId?: string;
  readonly nonceBase64: string;
  readonly ciphertextBase64: string;
}

interface PersistedVaultDocument {
  readonly formatVersion: typeof CLIENT_PROFILE_VAULT_FORMAT_VERSION;
  readonly records: readonly PersistedProfileRecord[];
}

function recordId(
  coordinates: ClientProfileCoordinates,
  lifecycle: "staged" | "active",
): string {
  return createHash("sha256")
    .update(`${coordinatesKey(coordinates)}\u0000${lifecycle}`)
    .digest("hex");
}

function aad(record: Omit<
  PersistedProfileRecord,
  "nonceBase64" | "ciphertextBase64"
>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(record));
}

function seal(
  key: Uint8Array,
  metadata: Omit<
    PersistedProfileRecord,
    "nonceBase64" | "ciphertextBase64"
  >,
  plaintext: Uint8Array,
): PersistedProfileRecord {
  const nonce = randomBytes(AES_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad(metadata));
  const encrypted = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    ...metadata,
    nonceBase64: nonce.toString("base64"),
    ciphertextBase64: encrypted.toString("base64"),
  };
}

function open(key: Uint8Array, record: PersistedProfileRecord): Uint8Array {
  const nonce = Buffer.from(record.nonceBase64, "base64");
  const encrypted = Buffer.from(record.ciphertextBase64, "base64");
  if (
    key.length !== AES_KEY_BYTES
    || nonce.length !== AES_NONCE_BYTES
    || encrypted.length <= AES_TAG_BYTES
  ) {
    throw new Error("client profile vault record is corrupt");
  }
  const ciphertext = encrypted.subarray(0, -AES_TAG_BYTES);
  const tag = encrypted.subarray(-AES_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad({
    formatVersion: record.formatVersion,
    recordId: record.recordId,
    lifecycle: record.lifecycle,
    coordinates: record.coordinates,
    generation: record.generation,
    publicState: record.publicState,
    ...(record.stageId === undefined ? {} : { stageId: record.stageId }),
  }));
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]));
}

function assertRecord(record: PersistedProfileRecord): void {
  assertClientProfileCoordinates(record.coordinates);
  const expectedId = recordId(record.coordinates, record.lifecycle);
  if (
    record.formatVersion !== CLIENT_PROFILE_VAULT_FORMAT_VERSION
    || record.recordId !== expectedId
    || !Number.isSafeInteger(record.generation)
    || record.generation < 1
    || (record.lifecycle === "staged") !== (record.stageId !== undefined)
    || typeof record.nonceBase64 !== "string"
    || typeof record.ciphertextBase64 !== "string"
  ) {
    throw new Error("client profile vault record is corrupt");
  }
}

async function readDocument(path: string): Promise<PersistedVaultDocument> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        formatVersion: CLIENT_PROFILE_VAULT_FORMAT_VERSION,
        records: [],
      };
    }
    throw error;
  }

  const untrusted: unknown = JSON.parse(text);
  if (
    typeof untrusted !== "object"
    || untrusted === null
    || !("formatVersion" in untrusted)
    || untrusted.formatVersion !== CLIENT_PROFILE_VAULT_FORMAT_VERSION
    || !("records" in untrusted)
    || !Array.isArray(untrusted.records)
    || untrusted.records.length > MAX_RECORDS
  ) {
    throw new Error("client profile vault document is corrupt");
  }
  const parsed = untrusted as unknown as PersistedVaultDocument;
  const seen = new Set<string>();
  for (const record of parsed.records) {
    assertRecord(record);
    if (seen.has(record.recordId)) {
      throw new Error("client profile vault document is corrupt");
    }
    seen.add(record.recordId);
  }
  return parsed;
}

export async function atomicWritePrivateFile(
  path: string,
  contents: string | Uint8Array,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(
    dirname(path),
    `.${randomUUID()}.client-profile-vault.tmp`,
  );
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function writeDocument(
  path: string,
  document: PersistedVaultDocument,
): Promise<void> {
  await atomicWritePrivateFile(path, JSON.stringify(document));
}

function cloneCoordinates(
  coordinates: ClientProfileCoordinates,
): ClientProfileCoordinates {
  return { ...coordinates };
}

function publicProfile(record: PersistedProfileRecord): PublicClientProfile {
  return {
    coordinates: cloneCoordinates(record.coordinates),
    generation: record.generation,
    lifecycle: record.lifecycle,
    publicState: { ...record.publicState },
    ...(record.stageId === undefined ? {} : { stageId: record.stageId }),
  };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

export class EncryptedFileClientProfileVault implements ClientProfileVault {
  readonly #path: string;
  readonly #keyStore: WrappingKeyStore;
  #key: Uint8Array | undefined;
  #terminalStatus: ClientProfileVaultAvailability | undefined;

  constructor(directory: string, keyStore: WrappingKeyStore) {
    this.#path = join(directory, VAULT_FILE_NAME);
    this.#keyStore = keyStore;
  }

  availability(): Promise<ClientProfileVaultAvailability> {
    if (this.#terminalStatus !== undefined) {
      return Promise.resolve(this.#terminalStatus);
    }
    return Promise.resolve({
      status: this.#key === undefined ? "locked" : "available",
    });
  }

  unlock(): Promise<ClientProfileVaultAvailability> {
    return this.#exclusive(async () => {
      const support = await this.#keyStore.support();
      if (!support.supported) {
        this.#terminalStatus = {
          status: "unsupported",
          ...(support.reasonCode === undefined
            ? {}
            : { reasonCode: support.reasonCode }),
        };
        return this.#terminalStatus;
      }

      let document: PersistedVaultDocument;
      try {
        document = await readDocument(this.#path);
      } catch {
        this.#terminalStatus = {
          status: "corrupt",
          reasonCode: "vault_document_corrupt",
        };
        return this.#terminalStatus;
      }

      let candidates: readonly Uint8Array[];
      try {
        candidates = await this.#keyStore.loadCandidates();
      } catch (error) {
        this.#terminalStatus = error instanceof WrappingKeyStoreUnavailableError
          ? {
            status: "unsupported",
            reasonCode: "wrapping_key_store_unavailable",
          }
          : {
            status: "corrupt",
            reasonCode: "wrapping_key_store_corrupt",
          };
        return this.#terminalStatus;
      }
      if (candidates.length === 0) {
        if (document.records.length > 0) {
          this.#terminalStatus = {
            status: "storage_lost",
            reasonCode: "wrapping_key_missing",
          };
          return this.#terminalStatus;
        }
        const created = randomBytes(AES_KEY_BYTES);
        try {
          await this.#keyStore.initialize(created);
        } catch {
          created.fill(0);
          this.#terminalStatus = {
            status: "unsupported",
            reasonCode: "wrapping_key_store_unavailable",
          };
          return this.#terminalStatus;
        }
        this.#replaceResidentKey(created);
        created.fill(0);
        this.#terminalStatus = undefined;
        return { status: "available" };
      }

      const selected = this.#selectCandidate(candidates, document);
      for (const candidate of candidates) {
        if (candidate !== selected?.key) candidate.fill(0);
      }
      if (selected === undefined) {
        this.#terminalStatus = {
          status: "corrupt",
          reasonCode: "vault_authentication_failed",
        };
        return this.#terminalStatus;
      }
      try {
        if (selected.index === 0) {
          await this.#keyStore.commitRotation();
        } else {
          await this.#keyStore.rollbackRotation();
        }
      } catch {
        selected.key.fill(0);
        this.#terminalStatus = {
          status: "unsupported",
          reasonCode: "wrapping_key_store_unavailable",
        };
        return this.#terminalStatus;
      }
      this.#replaceResidentKey(selected.key);
      selected.key.fill(0);
      this.#terminalStatus = undefined;
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

  stageProfile(
    input: StageClientProfileInput,
  ): Promise<StagedClientProfileReceipt> {
    return this.#exclusive(async () => {
      const key = this.#requiredKey();
      assertStageInput(input);
      const document = await readDocument(this.#path);
      const stagedId = recordId(input.coordinates, "staged");
      const existing = document.records.find(
        (record) => record.recordId === stagedId,
      );
      if (existing !== undefined) {
        const opened = open(key, existing);
        try {
          if (
            existing.stageId !== input.stageId
            || existing.generation !== input.generation
            || existing.publicState.clientKind
              !== input.publicState.clientKind
            || existing.publicState.publicFingerprint
              !== input.publicState.publicFingerprint
            || !sameBytes(opened, input.profileBytes)
          ) {
            throw new Error("another client profile stage is already pending");
          }
          return this.#receipt(existing);
        } finally {
          opened.fill(0);
        }
      }

      const active = document.records.find(
        (record) => record.recordId === recordId(input.coordinates, "active"),
      );
      const expectedGeneration = (active?.generation ?? 0) + 1;
      if (input.generation !== expectedGeneration) {
        throw new Error("client profile stage generation is stale");
      }

      const activeProfiles = new Set(document.records.map(
        (record) => coordinatesKey(record.coordinates),
      ));
      if (
        !activeProfiles.has(coordinatesKey(input.coordinates))
        && activeProfiles.size >= CLIENT_PROFILE_VAULT_MAX_PROFILES
      ) {
        throw new RangeError("client profile vault is full");
      }

      const metadata = {
        formatVersion: CLIENT_PROFILE_VAULT_FORMAT_VERSION,
        recordId: stagedId,
        lifecycle: "staged" as const,
        coordinates: cloneCoordinates(input.coordinates),
        generation: input.generation,
        publicState: { ...input.publicState },
        stageId: input.stageId,
      };
      await writeDocument(this.#path, {
        formatVersion: CLIENT_PROFILE_VAULT_FORMAT_VERSION,
        records: [...document.records, seal(key, metadata, input.profileBytes)],
      });
      return {
        formatVersion: CLIENT_PROFILE_VAULT_FORMAT_VERSION,
        profileId: input.coordinates.profileId,
        stageId: input.stageId,
        generation: input.generation,
      };
    });
  }

  activateProfile(
    coordinates: ClientProfileCoordinates,
    stageId: string,
  ): Promise<void> {
    return this.#exclusive(async () => {
      const key = this.#requiredKey();
      assertClientProfileCoordinates(coordinates);
      const document = await readDocument(this.#path);
      const stagedId = recordId(coordinates, "staged");
      const staged = document.records.find(
        (record) => record.recordId === stagedId,
      );
      if (staged?.stageId !== stageId) {
        throw new Error("client profile stage does not match");
      }
      const activeId = recordId(coordinates, "active");
      const current = document.records.find(
        (record) => record.recordId === activeId,
      );
      if (staged.generation !== (current?.generation ?? 0) + 1) {
        throw new Error("client profile activation generation is stale");
      }
      const plaintext = open(key, staged);
      try {
        const activated = seal(key, {
          formatVersion: CLIENT_PROFILE_VAULT_FORMAT_VERSION,
          recordId: activeId,
          lifecycle: "active",
          coordinates: cloneCoordinates(coordinates),
          generation: staged.generation,
          publicState: { ...staged.publicState },
        }, plaintext);
        await writeDocument(this.#path, {
          formatVersion: CLIENT_PROFILE_VAULT_FORMAT_VERSION,
          records: [
            ...document.records.filter((record) =>
              record.recordId !== stagedId && record.recordId !== activeId
            ),
            activated,
          ],
        });
      } finally {
        plaintext.fill(0);
      }
    });
  }

  abortStagedProfile(
    coordinates: ClientProfileCoordinates,
    stageId: string,
  ): Promise<void> {
    return this.#exclusive(async () => {
      this.#requiredKey();
      assertClientProfileCoordinates(coordinates);
      const document = await readDocument(this.#path);
      const stagedId = recordId(coordinates, "staged");
      const staged = document.records.find(
        (record) => record.recordId === stagedId,
      );
      if (staged === undefined) return;
      if (staged.stageId !== stageId) {
        throw new Error("client profile stage does not match");
      }
      await writeDocument(this.#path, {
        formatVersion: CLIENT_PROFILE_VAULT_FORMAT_VERSION,
        records: document.records.filter(
          (record) => record.recordId !== stagedId,
        ),
      });
    });
  }

  recoverInterruptedActivation(
    coordinates: ClientProfileCoordinates,
    resolution: InterruptedClientProfileResolution,
  ): Promise<void> {
    return resolution.action === "activate"
      ? this.activateProfile(coordinates, resolution.stageId)
      : this.abortStagedProfile(coordinates, resolution.stageId);
  }

  withOpenProfile<T>(
    coordinates: ClientProfileCoordinates,
    operation: (profileBytes: Uint8Array) => Promise<T> | T,
  ): Promise<T> {
    return this.#exclusive(async () => {
      const key = this.#requiredKey();
      assertClientProfileCoordinates(coordinates);
      const document = await readDocument(this.#path);
      const active = document.records.find(
        (record) => record.recordId === recordId(coordinates, "active"),
      );
      if (active === undefined) {
        throw new Error("active client profile is unavailable");
      }
      const plaintext = open(key, active);
      try {
        return await operation(plaintext);
      } finally {
        plaintext.fill(0);
      }
    });
  }

  withOpenStagedProfile<T>(
    coordinates: ClientProfileCoordinates,
    stageId: string,
    operation: (profileBytes: Uint8Array) => Promise<T> | T,
  ): Promise<T> {
    return this.#exclusive(async () => {
      const key = this.#requiredKey();
      assertClientProfileCoordinates(coordinates);
      const document = await readDocument(this.#path);
      const staged = document.records.find(
        (record) => record.recordId === recordId(coordinates, "staged"),
      );
      if (staged === undefined || staged.stageId !== stageId) {
        throw new Error("staged client profile does not match");
      }
      const plaintext = open(key, staged);
      try {
        return await operation(plaintext);
      } finally {
        plaintext.fill(0);
      }
    });
  }

  listPublicProfiles(): Promise<readonly PublicClientProfile[]> {
    return this.#exclusive(async () => {
      const document = await readDocument(this.#path);
      return document.records.map(publicProfile).sort((left, right) =>
        coordinatesKey(left.coordinates).localeCompare(
          coordinatesKey(right.coordinates),
        )
        || left.lifecycle.localeCompare(right.lifecycle)
      );
    });
  }

  rotateWrappingMaterial(): Promise<void> {
    return this.#exclusive(async () => {
      const previous = this.#requiredKey();
      const document = await readDocument(this.#path);
      const current = randomBytes(AES_KEY_BYTES);
      await this.#keyStore.stageRotation(current, previous);
      try {
        const rotated: PersistedProfileRecord[] = [];
        for (const record of document.records) {
          const plaintext = open(previous, record);
          try {
            rotated.push(seal(current, {
              formatVersion: record.formatVersion,
              recordId: record.recordId,
              lifecycle: record.lifecycle,
              coordinates: record.coordinates,
              generation: record.generation,
              publicState: record.publicState,
              ...(record.stageId === undefined
                ? {}
                : { stageId: record.stageId }),
            }, plaintext));
          } finally {
            plaintext.fill(0);
          }
        }
        await writeDocument(this.#path, {
          formatVersion: CLIENT_PROFILE_VAULT_FORMAT_VERSION,
          records: rotated,
        });
        await this.#keyStore.commitRotation();
        this.#replaceResidentKey(current);
      } catch (error) {
        await this.#keyStore.rollbackRotation();
        throw error;
      } finally {
        current.fill(0);
      }
    });
  }

  forgetProfile(coordinates: ClientProfileCoordinates): Promise<void> {
    return this.#exclusive(async () => {
      this.#requiredKey();
      assertClientProfileCoordinates(coordinates);
      const document = await readDocument(this.#path);
      const activeId = recordId(coordinates, "active");
      const stagedId = recordId(coordinates, "staged");
      await writeDocument(this.#path, {
        formatVersion: CLIENT_PROFILE_VAULT_FORMAT_VERSION,
        records: document.records.filter((record) =>
          record.recordId !== activeId && record.recordId !== stagedId
        ),
      });
    });
  }

  #requiredKey(): Uint8Array {
    if (this.#key === undefined) {
      throw new Error("client profile vault is locked");
    }
    return this.#key;
  }

  #replaceResidentKey(key: Uint8Array): void {
    this.#key?.fill(0);
    this.#key = Uint8Array.from(key);
  }

  #selectCandidate(
    candidates: readonly Uint8Array[],
    document: PersistedVaultDocument,
  ): { readonly key: Uint8Array; readonly index: number } | undefined {
    if (document.records.length === 0) {
      return candidates[0] === undefined
        ? undefined
        : { key: candidates[0], index: 0 };
    }
    for (const [index, candidate] of candidates.entries()) {
      try {
        const plaintext = open(candidate, document.records[0]!);
        plaintext.fill(0);
        return { key: candidate, index };
      } catch {
        // Try the staged previous wrapping key after an interrupted rotation.
      }
    }
    return undefined;
  }

  #receipt(record: PersistedProfileRecord): StagedClientProfileReceipt {
    return {
      formatVersion: CLIENT_PROFILE_VAULT_FORMAT_VERSION,
      profileId: record.coordinates.profileId,
      stageId: record.stageId!,
      generation: record.generation,
    };
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const tail = profileVaultFileTails.get(this.#path) ?? Promise.resolve();
    const result = tail.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    profileVaultFileTails.set(this.#path, settled);
    void settled.finally(() => {
      if (profileVaultFileTails.get(this.#path) === settled) {
        profileVaultFileTails.delete(this.#path);
      }
    });
    return result;
  }
}
