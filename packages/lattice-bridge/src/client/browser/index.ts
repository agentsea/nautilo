/// <reference lib="dom" />

import { LatticeCrypto } from "@nautilo/lattice-crypto";
import type { NautiloApiClient } from "@nautilo/api-client/browser";
import {
  createInitialDeviceBootstrapApiClientPort,
  createInitialHumanDomainApiClientPort,
} from "../../device/initial-readiness-api-client.ts";
import {
  createLocalInitialDeviceReadinessClient,
  type LocalInitialDeviceReadinessClient,
  type LocalInitialDeviceReadinessClientInput,
} from "../../device/local-initial-device-readiness-client.ts";
import { deriveAdditionalDeviceClientIdentity } from
  "../../device/additional-device-client.ts";
import {
  createHumanDeviceMembershipClient,
  type HumanDeviceMembershipApiPort,
} from "../../device/human-device-membership-client.ts";
import { createBrowserPendingInitialDeviceBootstrapVault } from
  "../../device/browser-pending-initial-device-bootstrap-vault.ts";
import {
  type AuthorizedHumanLiveShadowMessageClient,
} from "../message/authorized-human-live-shadow-message-client.ts";
import type { VaultLiveShadowMessageReceiver } from
  "../message/vault-live-shadow-message-receiver.ts";
import type { VaultHumanPeerLiveShadowMessageReceiver } from
  "../message/vault-human-peer-live-shadow-message-receiver.ts";
import type { VaultSharedAgentLiveShadowMessageReceiver } from
  "../message/vault-shared-agent-live-shadow-message-receiver.ts";
import type { VaultSharedAgentOutputLiveShadowReceiver } from
  "../message/vault-shared-agent-output-live-shadow-receiver.ts";
import {
  createBrowserPreparedMutationJournalVault,
} from
  "../memory/browser-prepared-mutation-journal-vault.ts";
import { createBrowserClientNamespaceGenerationCacheVaultV1 } from
  "./namespace-generation-cache-vault.ts";
import type { AuthorizedHumanMemoryClient } from
  "../memory/authorized-human-memory-client.ts";
import {
  createForegroundHumanPeerLiveShadowMessageReceiver,
  createForegroundBackgroundAuthorizationClientV2,
  createForegroundDomainKeyAuthorityClientV2,
  ensurePersonalDomainAuthorityV2,
  recoverPersonalDomainAuthorityV2,
  createForegroundLiveShadowMessageClient,
  createForegroundHumanMemoryClient,
  createForegroundHumanTaskClient,
  createForegroundLiveShadowMessageReceiver,
  createForegroundMessageBackfillClient,
  createForegroundRoomHistoryShadowMessageReader,
  createForegroundSharedAgentLiveShadowMessageReceiver,
  createForegroundSharedAgentOutputLiveShadowReceiver,
  deriveForegroundCryptoDeviceId,
  type ForegroundLiveShadowMessageClientInput,
  type ForegroundBackgroundAuthorizationClientInput,
  type ForegroundMessageBackfillClientInput,
  type ForegroundHumanMemoryClientInput,
  type ForegroundHumanTaskClientInput,
  type ForegroundRoomHistoryShadowAcknowledgementInput,
  type ForegroundRoomHistoryShadowMessageReaderInput,
  type ForegroundRoomHistoryShadowMessageReader,
} from "../message/foreground-shadow-client-composition.ts";

const browserForegroundShadowPlatform = Object.freeze({
  clientKind: "browser" as const,
  clientLabel: "Browser" as const,
  createProfileVault: createBrowserClientProfileVault,
  createPreparedMutationJournalVault: createBrowserPreparedMutationJournalVault,
  createNamespaceGenerationCacheVault:
    createBrowserClientNamespaceGenerationCacheVaultV1,
  createId: () => globalThis.crypto.randomUUID(),
});

export {
  createObservedHumanMemoryDeviceContent,
  type HumanMemoryReadObservationAdmissionV1,
} from "../memory/observed-human-memory-device-content.ts";

export {
  BrowserClientNamespaceGenerationCacheVaultV1,
  createBrowserClientNamespaceGenerationCacheVaultV1,
} from "./namespace-generation-cache-vault.ts";

export {
  BrowserPendingInitialDeviceBootstrapVault,
  createBrowserPendingInitialDeviceBootstrapVault,
} from "../../device/browser-pending-initial-device-bootstrap-vault.ts";

export {
  BrowserPreparedArtifactCiphertextSidecar,
} from "../artifact/browser-prepared-artifact-ciphertext-sidecar.ts";
export {
  createPreparedArtifactMutationJournal,
  type PreparedArtifactCiphertextSidecarPort,
  type PreparedArtifactCiphertextSidecarReference,
} from "../artifact/prepared-artifact-ciphertext-sidecar.ts";

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
} from "../../client-vault/types.ts";
import {
  assertClientProfileCoordinates,
  assertStageInput,
  coordinatesKey,
} from "../../client-vault/validation.ts";

const DATABASE_NAME = "nautilo-crypto-client-profile-v1";
const DATABASE_VERSION = 1;
const WRAPPING_KEY_STORE = "wrapping_keys";
const DOCUMENT_STORE = "vault_documents";
const ROOT_RECORD_ID = "root";
const DOCUMENT_RECORD_ID = "profiles";
const LOCK_NAME = "nautilo-crypto-client-profile-v1";
const AES_NONCE_BYTES = 12;
const MAX_RECORDS = CLIENT_PROFILE_VAULT_MAX_PROFILES * 2;

interface BrowserProfileRecord {
  readonly formatVersion: typeof CLIENT_PROFILE_VAULT_FORMAT_VERSION;
  readonly recordId: string;
  readonly lifecycle: "staged" | "active";
  readonly coordinates: ClientProfileCoordinates;
  readonly generation: number;
  readonly publicState: ClientProfilePublicState;
  readonly stageId?: string;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
}

interface BrowserVaultDocument {
  readonly id: typeof DOCUMENT_RECORD_ID;
  readonly formatVersion: typeof CLIENT_PROFILE_VAULT_FORMAT_VERSION;
  readonly records: readonly BrowserProfileRecord[];
}

interface BrowserWrappingKeys {
  readonly id: typeof ROOT_RECORD_ID;
  readonly formatVersion: typeof CLIENT_PROFILE_VAULT_FORMAT_VERSION;
  readonly current: CryptoKey;
  readonly previous?: CryptoKey;
}

function recordId(
  coordinates: ClientProfileCoordinates,
  lifecycle: "staged" | "active",
): string {
  return `${coordinatesKey(coordinates)}\u0000${lifecycle}`;
}

function metadata(record: BrowserProfileRecord): Omit<
  BrowserProfileRecord,
  "nonce" | "ciphertext"
> {
  return {
    formatVersion: record.formatVersion,
    recordId: record.recordId,
    lifecycle: record.lifecycle,
    coordinates: record.coordinates,
    generation: record.generation,
    publicState: record.publicState,
    ...(record.stageId === undefined ? {} : { stageId: record.stageId }),
  };
}

function aad(value: Omit<
  BrowserProfileRecord,
  "nonce" | "ciphertext"
>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(bytes.length);
  owned.set(bytes);
  return owned.buffer;
}

async function seal(
  key: CryptoKey,
  recordMetadata: Omit<BrowserProfileRecord, "nonce" | "ciphertext">,
  plaintext: Uint8Array,
): Promise<BrowserProfileRecord> {
  const nonce = crypto.getRandomValues(new Uint8Array(AES_NONCE_BYTES));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv: ownedArrayBuffer(nonce),
    additionalData: ownedArrayBuffer(aad(recordMetadata)),
    tagLength: 128,
  }, key, ownedArrayBuffer(plaintext)));
  return {
    ...recordMetadata,
    nonce,
    ciphertext,
  };
}

async function open(
  key: CryptoKey,
  record: BrowserProfileRecord,
): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.decrypt({
    name: "AES-GCM",
    iv: ownedArrayBuffer(record.nonce),
    additionalData: ownedArrayBuffer(aad(metadata(record))),
    tagLength: 128,
  }, key, ownedArrayBuffer(record.ciphertext)));
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
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
      const database = request.result;
      if (!database.objectStoreNames.contains(WRAPPING_KEY_STORE)) {
        database.createObjectStore(WRAPPING_KEY_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(DOCUMENT_STORE)) {
        database.createObjectStore(DOCUMENT_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error ?? new Error("IndexedDB open failed"),
    );
    request.onblocked = () => reject(new Error("IndexedDB upgrade blocked"));
  });
}

async function readRecord<T>(
  database: IDBDatabase,
  storeName: string,
  id: string,
): Promise<T | undefined> {
  const transaction = database.transaction(storeName, "readonly");
  const completed = transactionDone(transaction);
  const result = await requestResult(
    transaction.objectStore(storeName).get(id),
  ) as T | undefined;
  await completed;
  return result;
}

async function writeRecord<T>(
  database: IDBDatabase,
  storeName: string,
  value: T,
): Promise<void> {
  const transaction = database.transaction(storeName, "readwrite");
  const completed = transactionDone(transaction);
  transaction.objectStore(storeName).put(value);
  await completed;
}

function emptyDocument(): BrowserVaultDocument {
  return {
    id: DOCUMENT_RECORD_ID,
    formatVersion: CLIENT_PROFILE_VAULT_FORMAT_VERSION,
    records: [],
  };
}

function assertRecord(record: BrowserProfileRecord): void {
  assertClientProfileCoordinates(record.coordinates);
  if (
    record.formatVersion !== CLIENT_PROFILE_VAULT_FORMAT_VERSION
    || record.recordId !== recordId(record.coordinates, record.lifecycle)
    || !Number.isSafeInteger(record.generation)
    || record.generation < 1
    || (record.lifecycle === "staged") !== (record.stageId !== undefined)
    || !(record.nonce instanceof Uint8Array)
    || record.nonce.length !== AES_NONCE_BYTES
    || !(record.ciphertext instanceof Uint8Array)
    || record.ciphertext.length <= 16
  ) {
    throw new Error("browser client profile vault is corrupt");
  }
}

function assertDocument(document: BrowserVaultDocument): void {
  const candidateRecords: unknown = document.records;
  if (
    document.id !== DOCUMENT_RECORD_ID
    || document.formatVersion !== CLIENT_PROFILE_VAULT_FORMAT_VERSION
    || !Array.isArray(candidateRecords)
    || candidateRecords.length > MAX_RECORDS
  ) {
    throw new Error("browser client profile vault is corrupt");
  }
  const records =
    candidateRecords as unknown as readonly BrowserProfileRecord[];
  const seen = new Set<string>();
  for (const record of records) {
    assertRecord(record);
    if (seen.has(record.recordId)) {
      throw new Error("browser client profile vault is corrupt");
    }
    seen.add(record.recordId);
  }
}

function assertWrappingKeys(keys: BrowserWrappingKeys): void {
  if (
    keys.id !== ROOT_RECORD_ID
    || keys.formatVersion !== CLIENT_PROFILE_VAULT_FORMAT_VERSION
    || !(keys.current instanceof CryptoKey)
    || keys.current.extractable
    || keys.current.algorithm.name !== "AES-GCM"
    || (keys.previous !== undefined
      && (!(keys.previous instanceof CryptoKey)
        || keys.previous.extractable
        || keys.previous.algorithm.name !== "AES-GCM"))
  ) {
    throw new Error("browser wrapping key is corrupt");
  }
}

function publicProfile(record: BrowserProfileRecord): PublicClientProfile {
  return {
    coordinates: { ...record.coordinates },
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

export class BrowserClientProfileVault implements ClientProfileVault {
  #database: IDBDatabase | undefined;
  #key: CryptoKey | undefined;
  #terminalStatus: ClientProfileVaultAvailability | undefined;

  availability(): Promise<ClientProfileVaultAvailability> {
    if (this.#terminalStatus !== undefined) {
      return Promise.resolve(this.#terminalStatus);
    }
    return Promise.resolve({
      status: this.#key === undefined ? "locked" : "available",
    });
  }

  unlock(): Promise<ClientProfileVaultAvailability> {
    if (
      typeof globalThis.indexedDB === "undefined"
      || typeof globalThis.crypto?.subtle === "undefined"
      || typeof globalThis.navigator?.locks?.request !== "function"
    ) {
      this.#terminalStatus = {
        status: "unsupported",
        reasonCode: "durable_webcrypto_unavailable",
      };
      return Promise.resolve(this.#terminalStatus);
    }

    return this.#exclusive(async () => {
      let document: BrowserVaultDocument;
      let keys: BrowserWrappingKeys | undefined;
      try {
        const database = await this.#requiredDatabase();
        document = await readRecord<BrowserVaultDocument>(
          database,
          DOCUMENT_STORE,
          DOCUMENT_RECORD_ID,
        ) ?? emptyDocument();
        keys = await readRecord<BrowserWrappingKeys>(
          database,
          WRAPPING_KEY_STORE,
          ROOT_RECORD_ID,
        );
      } catch {
        this.#terminalStatus = {
          status: "unsupported",
          reasonCode: "browser_vault_storage_unavailable",
        };
        return this.#terminalStatus;
      }
      try {
        assertDocument(document);
        if (keys !== undefined) assertWrappingKeys(keys);
      } catch {
        this.#terminalStatus = {
          status: "corrupt",
          reasonCode: "browser_vault_storage_corrupt",
        };
        return this.#terminalStatus;
      }

      if (keys === undefined) {
        if (document.records.length > 0) {
          this.#terminalStatus = {
            status: "storage_lost",
            reasonCode: "browser_wrapping_key_missing",
          };
          return this.#terminalStatus;
        }
        let current: CryptoKey;
        try {
          current = await crypto.subtle.generateKey(
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"],
          );
          await writeRecord(
            await this.#requiredDatabase(),
            WRAPPING_KEY_STORE,
            {
              id: ROOT_RECORD_ID,
              formatVersion: CLIENT_PROFILE_VAULT_FORMAT_VERSION,
              current,
            } satisfies BrowserWrappingKeys,
          );
        } catch {
          this.#terminalStatus = {
            status: "unsupported",
            reasonCode: "browser_vault_storage_unavailable",
          };
          return this.#terminalStatus;
        }
        this.#key = current;
        this.#terminalStatus = undefined;
        return { status: "available" };
      }

      const selected = await this.#selectKey(keys, document);
      if (selected === undefined) {
        this.#terminalStatus = {
          status: "corrupt",
          reasonCode: "browser_vault_authentication_failed",
        };
        return this.#terminalStatus;
      }
      try {
        await writeRecord(
          await this.#requiredDatabase(),
          WRAPPING_KEY_STORE,
          {
            id: ROOT_RECORD_ID,
            formatVersion: CLIENT_PROFILE_VAULT_FORMAT_VERSION,
            current: selected,
          } satisfies BrowserWrappingKeys,
        );
      } catch {
        this.#terminalStatus = {
          status: "unsupported",
          reasonCode: "browser_vault_storage_unavailable",
        };
        return this.#terminalStatus;
      }
      this.#key = selected;
      this.#terminalStatus = undefined;
      return { status: "available" };
    });
  }

  lock(): Promise<void> {
    this.#key = undefined;
    this.#database?.close();
    this.#database = undefined;
    return Promise.resolve();
  }

  stageProfile(
    input: StageClientProfileInput,
  ): Promise<StagedClientProfileReceipt> {
    return this.#exclusive(async () => {
      const key = this.#requiredKey();
      assertStageInput(input);
      const document = await this.#readDocument();
      const stagedId = recordId(input.coordinates, "staged");
      const existing = document.records.find(
        (record) => record.recordId === stagedId,
      );
      if (existing !== undefined) {
        const plaintext = await open(key, existing);
        try {
          if (
            existing.stageId !== input.stageId
            || existing.generation !== input.generation
            || existing.publicState.clientKind
              !== input.publicState.clientKind
            || existing.publicState.publicFingerprint
              !== input.publicState.publicFingerprint
            || !sameBytes(plaintext, input.profileBytes)
          ) {
            throw new Error("another client profile stage is already pending");
          }
          return this.#receipt(existing);
        } finally {
          plaintext.fill(0);
        }
      }
      const active = document.records.find(
        (record) => record.recordId === recordId(input.coordinates, "active"),
      );
      const expectedGeneration = (active?.generation ?? 0) + 1;
      if (input.generation !== expectedGeneration) {
        throw new Error("client profile stage generation is stale");
      }
      const profileKeys = new Set(document.records.map(
        (record) => coordinatesKey(record.coordinates),
      ));
      if (
        !profileKeys.has(coordinatesKey(input.coordinates))
        && profileKeys.size >= CLIENT_PROFILE_VAULT_MAX_PROFILES
      ) {
        throw new RangeError("client profile vault is full");
      }
      const record = await seal(key, {
        formatVersion: CLIENT_PROFILE_VAULT_FORMAT_VERSION,
        recordId: stagedId,
        lifecycle: "staged",
        coordinates: { ...input.coordinates },
        generation: input.generation,
        publicState: { ...input.publicState },
        stageId: input.stageId,
      }, input.profileBytes);
      await this.#writeDocument({
        ...document,
        records: [...document.records, record],
      });
      return this.#receipt(record);
    });
  }

  activateProfile(
    coordinates: ClientProfileCoordinates,
    stageId: string,
  ): Promise<void> {
    return this.#exclusive(async () => {
      const key = this.#requiredKey();
      assertClientProfileCoordinates(coordinates);
      const document = await this.#readDocument();
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
      const plaintext = await open(key, staged);
      try {
        const active = await seal(key, {
          formatVersion: CLIENT_PROFILE_VAULT_FORMAT_VERSION,
          recordId: activeId,
          lifecycle: "active",
          coordinates: { ...coordinates },
          generation: staged.generation,
          publicState: { ...staged.publicState },
        }, plaintext);
        await this.#writeDocument({
          ...document,
          records: [
            ...document.records.filter((record) =>
              record.recordId !== stagedId && record.recordId !== activeId
            ),
            active,
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
      const document = await this.#readDocument();
      const stagedId = recordId(coordinates, "staged");
      const staged = document.records.find(
        (record) => record.recordId === stagedId,
      );
      if (staged === undefined) return;
      if (staged.stageId !== stageId) {
        throw new Error("client profile stage does not match");
      }
      await this.#writeDocument({
        ...document,
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
      const document = await this.#readDocument();
      const active = document.records.find(
        (record) => record.recordId === recordId(coordinates, "active"),
      );
      if (active === undefined) {
        throw new Error("active client profile is unavailable");
      }
      const plaintext = await open(key, active);
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
      const document = await this.#readDocument();
      const staged = document.records.find(
        (record) => record.recordId === recordId(coordinates, "staged"),
      );
      if (staged === undefined || staged.stageId !== stageId) {
        throw new Error("staged client profile does not match");
      }
      const plaintext = await open(key, staged);
      try {
        return await operation(plaintext);
      } finally {
        plaintext.fill(0);
      }
    });
  }

  listPublicProfiles(): Promise<readonly PublicClientProfile[]> {
    return this.#exclusive(async () =>
      (await this.#readDocument()).records.map(publicProfile).sort(
        (left, right) =>
          coordinatesKey(left.coordinates).localeCompare(
            coordinatesKey(right.coordinates),
          )
          || left.lifecycle.localeCompare(right.lifecycle),
      )
    );
  }

  rotateWrappingMaterial(): Promise<void> {
    return this.#exclusive(async () => {
      const previous = this.#requiredKey();
      const document = await this.#readDocument();
      const current = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
      const database = await this.#requiredDatabase();
      await writeRecord(database, WRAPPING_KEY_STORE, {
        id: ROOT_RECORD_ID,
        formatVersion: CLIENT_PROFILE_VAULT_FORMAT_VERSION,
        current,
        previous,
      } satisfies BrowserWrappingKeys);
      const records: BrowserProfileRecord[] = [];
      for (const record of document.records) {
        const plaintext = await open(previous, record);
        try {
          records.push(await seal(current, metadata(record), plaintext));
        } finally {
          plaintext.fill(0);
        }
      }
      await this.#writeDocument({ ...document, records });
      await writeRecord(database, WRAPPING_KEY_STORE, {
        id: ROOT_RECORD_ID,
        formatVersion: CLIENT_PROFILE_VAULT_FORMAT_VERSION,
        current,
      } satisfies BrowserWrappingKeys);
      this.#key = current;
    });
  }

  forgetProfile(coordinates: ClientProfileCoordinates): Promise<void> {
    return this.#exclusive(async () => {
      this.#requiredKey();
      assertClientProfileCoordinates(coordinates);
      const document = await this.#readDocument();
      const activeId = recordId(coordinates, "active");
      const stagedId = recordId(coordinates, "staged");
      await this.#writeDocument({
        ...document,
        records: document.records.filter((record) =>
          record.recordId !== activeId && record.recordId !== stagedId
        ),
      });
    });
  }

  async #requiredDatabase(): Promise<IDBDatabase> {
    this.#database ??= await openDatabase();
    return this.#database;
  }

  #requiredKey(): CryptoKey {
    if (this.#key === undefined) {
      throw new Error("client profile vault is locked");
    }
    return this.#key;
  }

  async #readDocument(): Promise<BrowserVaultDocument> {
    const document = await readRecord<BrowserVaultDocument>(
      await this.#requiredDatabase(),
      DOCUMENT_STORE,
      DOCUMENT_RECORD_ID,
    ) ?? emptyDocument();
    assertDocument(document);
    return document;
  }

  #writeDocument(document: BrowserVaultDocument): Promise<void> {
    assertDocument(document);
    return this.#requiredDatabase().then((database) =>
      writeRecord(database, DOCUMENT_STORE, document)
    );
  }

  async #selectKey(
    keys: BrowserWrappingKeys,
    document: BrowserVaultDocument,
  ): Promise<CryptoKey | undefined> {
    if (document.records.length === 0) return keys.current;
    for (const candidate of [keys.current, keys.previous]) {
      if (candidate === undefined) continue;
      try {
        const plaintext = await open(candidate, document.records[0]!);
        plaintext.fill(0);
        return candidate;
      } catch {
        // Try the previous non-extractable key after interrupted rotation.
      }
    }
    return undefined;
  }

  #receipt(record: BrowserProfileRecord): StagedClientProfileReceipt {
    return {
      formatVersion: CLIENT_PROFILE_VAULT_FORMAT_VERSION,
      profileId: record.coordinates.profileId,
      stageId: record.stageId!,
      generation: record.generation,
    };
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return navigator.locks.request(
      LOCK_NAME,
      { mode: "exclusive" },
      operation,
    ) as unknown as Promise<T>;
  }
}

export function createBrowserClientProfileVault(): ClientProfileVault {
  return new BrowserClientProfileVault();
}

export interface BrowserInitialDeviceReadinessClientInput
extends Pick<LocalInitialDeviceReadinessClientInput,
  "serverScope" | "userId" | "humanActorId" | "installationId" | "crypto"> {
  readonly api: Parameters<typeof createInitialDeviceBootstrapApiClientPort>[0]
    & HumanDeviceMembershipApiPort;
  readonly createRecoveryInstallationId?: () => string;
  readonly activateRecoveryInstallationId?: (installationId: string) => void;
  readonly onRecoveryIdentityActivated?: () => void;
}

function createBrowserInitialDeviceReadinessClientForIdentity(
  input: BrowserInitialDeviceReadinessClientInput,
): LocalInitialDeviceReadinessClient {
  const crypto = input.crypto ?? new LatticeCrypto();
  const profileVault = createBrowserClientProfileVault();
  const identity = deriveAdditionalDeviceClientIdentity({
    crypto,
    ...input,
    clientKind: "browser",
  });
  const personalDomainAuthority = createForegroundDomainKeyAuthorityClientV2(
    browserForegroundShadowPlatform,
    {
      api: input.api,
      crypto,
      vault: profileVault,
      coordinates: identity.coordinates,
      now: () => Date.now(),
      createId: () => globalThis.crypto.randomUUID(),
    },
  );
  const membership = createHumanDeviceMembershipClient({
    api: input.api,
    crypto,
    vault: profileVault,
    coordinates: identity.coordinates,
    clientKind: "browser",
    installationLineageDigest: identity.installationLineageDigest,
    idempotencyKey: identity.idempotencyKey,
    ...(personalDomainAuthority === null ? {} : {
      personalAuthority: {
        ensure: (anchor) =>
          ensurePersonalDomainAuthorityV2(personalDomainAuthority, anchor),
        recover: (anchor, credential) =>
          recoverPersonalDomainAuthorityV2(
            personalDomainAuthority,
            anchor,
            credential,
          ),
      },
    }),
  });
  return createLocalInitialDeviceReadinessClient({
    ...input,
    crypto,
    clientKind: "browser",
    profileVault,
    pendingVault: createBrowserPendingInitialDeviceBootstrapVault(),
    bootstrap: createInitialDeviceBootstrapApiClientPort(input.api),
    initialHumanDomain: createInitialHumanDomainApiClientPort(input.api),
    humanDeviceMembership: membership,
    additionalDeviceTarget: membership,
    additionalDeviceApprover: membership,
  });
}

export function createBrowserInitialDeviceReadinessClient(
  input: BrowserInitialDeviceReadinessClientInput,
): LocalInitialDeviceReadinessClient {
  const current = createBrowserInitialDeviceReadinessClientForIdentity(input);
  const createRecoveryInstallationId = input.createRecoveryInstallationId;
  const activateRecoveryInstallationId = input.activateRecoveryInstallationId;
  if (createRecoveryInstallationId === undefined
    || activateRecoveryInstallationId === undefined) return current;
  return Object.freeze({
    ...current,
    async reconnectEncryptionDevice() {
      const readiness = await current.inspect();
      if (readiness.status !== "recovery_required") return readiness;
      const installationId = createRecoveryInstallationId();
      const previousIdentity = deriveAdditionalDeviceClientIdentity({
        crypto: input.crypto ?? new LatticeCrypto(),
        serverScope: input.serverScope,
        userId: input.userId,
        humanActorId: input.humanActorId,
        installationId: input.installationId,
        clientKind: "browser",
      });
      activateRecoveryInstallationId(installationId);
      await createBrowserClientProfileVault()
        .forgetProfile(previousIdentity.coordinates)
        .catch(() => undefined);
      const next = createBrowserInitialDeviceReadinessClientForIdentity({
        api: input.api,
        serverScope: input.serverScope,
        userId: input.userId,
        humanActorId: input.humanActorId,
        installationId,
        ...(input.crypto === undefined ? {} : { crypto: input.crypto }),
      });
      try {
        if (next.continueAdditionalDevice === undefined) {
          throw new Error("Additional-device connection is unavailable");
        }
        return await next.continueAdditionalDevice();
      } finally {
        input.onRecoveryIdentityActivated?.();
      }
    },
    async recoverEncryptionDevice(mnemonic: string) {
      const installationId = createRecoveryInstallationId();
      const nextInput: BrowserInitialDeviceReadinessClientInput = {
        api: input.api,
        serverScope: input.serverScope,
        userId: input.userId,
        humanActorId: input.humanActorId,
        installationId,
        ...(input.crypto === undefined ? {} : { crypto: input.crypto }),
      };
      const next = createBrowserInitialDeviceReadinessClientForIdentity(
        nextInput,
      );
      let recovered = false;
      try {
        const readiness = await next.recoverEncryptionDevice!(mnemonic);
        recovered = true;
        activateRecoveryInstallationId(installationId);
        input.onRecoveryIdentityActivated?.();
        return readiness;
      } catch (error) {
        if (recovered) throw error;
        const identity = deriveAdditionalDeviceClientIdentity({
          crypto: input.crypto ?? new LatticeCrypto(),
          serverScope: input.serverScope,
          userId: input.userId,
          humanActorId: input.humanActorId,
          installationId,
          clientKind: "browser",
        });
        await createBrowserClientProfileVault()
          .forgetProfile(identity.coordinates)
          .catch(() => undefined);
        throw error;
      }
    },
  });
}

export type BrowserLiveShadowMessageClientInput =
  ForegroundLiveShadowMessageClientInput;

export type BrowserBackgroundAuthorizationClientInput =
  ForegroundBackgroundAuthorizationClientInput;

/** Browser device responder using the existing foreground IndexedDB custody. */
export function createBrowserBackgroundAuthorizationClientV2(
  input: BrowserBackgroundAuthorizationClientInput,
) {
  return createForegroundBackgroundAuthorizationClientV2(
    browserForegroundShadowPlatform,
    input,
  );
}

export type BrowserMessageBackfillClientInput =
  ForegroundMessageBackfillClientInput;

/** Browser adapter for the shared, policy-free Message backfill client. */
export function createBrowserMessageBackfillClient(
  input: BrowserMessageBackfillClientInput,
) {
  return createForegroundMessageBackfillClient(
    browserForegroundShadowPlatform,
    input,
  );
}

export {
  createMessageBackfillWorker,
  type MessageBackfillBatchResult,
} from "../message/message-backfill-worker.ts";

export type BrowserHumanMemoryClientInput = ForegroundHumanMemoryClientInput;

export function createBrowserHumanMemoryClient(
  input: BrowserHumanMemoryClientInput,
): AuthorizedHumanMemoryClient {
  return createForegroundHumanMemoryClient(browserForegroundShadowPlatform, input);
}

export type BrowserHumanTaskClientInput = ForegroundHumanTaskClientInput;

/** Browser vault-backed protected Task client. Plain uses the legacy API adapter. */
export function createBrowserHumanTaskClient(
  input: BrowserHumanTaskClientInput,
) {
  return createForegroundHumanTaskClient(browserForegroundShadowPlatform, input);
}

/** Public, secret-free coordinate used to bind browser resume approvals. */
export function deriveBrowserCryptoDeviceId(input: Readonly<{
  serverScope: string;
  userId: string;
  humanActorId: string;
  installationId: string;
}>): string {
  return deriveForegroundCryptoDeviceId("browser", input);
}

/** Browser adapter for the shared foreground live Shadow composition. */
export function createBrowserLiveShadowMessageClient(
  input: BrowserLiveShadowMessageClientInput,
): AuthorizedHumanLiveShadowMessageClient {
  return createForegroundLiveShadowMessageClient(
    browserForegroundShadowPlatform,
    input,
  );
}

export type BrowserLiveShadowMessageReceiverInput = Omit<
  BrowserLiveShadowMessageClientInput,
  "normalizeContent" | "createIdempotencyKey" | "onHumanVerified"
> & Readonly<{
  api: Pick<NautiloApiClient, "verifyLiveShadowRoomMessage">;
  onTerminalVerification?: (operationId: string) => Promise<void> | void;
  onVerificationAttemptFailed?: (diagnostic: Readonly<{
    operationId: string;
    attempt: number;
    willRetry: boolean;
  }>) => void;
}>;

/** Browser causal receiver using the exact installation-bound profile. */
export function createBrowserLiveShadowMessageReceiver(
  input: BrowserLiveShadowMessageReceiverInput,
): VaultLiveShadowMessageReceiver {
  return createForegroundLiveShadowMessageReceiver(
    browserForegroundShadowPlatform,
    input,
  );
}

export type BrowserHumanPeerLiveShadowMessageReceiverInput = Omit<
  BrowserLiveShadowMessageClientInput,
  "normalizeContent" | "createIdempotencyKey" | "onHumanVerified"
> & Readonly<{
  api: BrowserLiveShadowMessageClientInput["api"] & Pick<
    NautiloApiClient,
    | "planHumanPeerLiveShadowAcknowledgement"
    | "acknowledgeHumanPeerLiveShadowMessage"
  >;
}>;

/** Browser peer receiver using its own enrolled device and Human key. */
export function createBrowserHumanPeerLiveShadowMessageReceiver(
  input: BrowserHumanPeerLiveShadowMessageReceiverInput,
): VaultHumanPeerLiveShadowMessageReceiver {
  return createForegroundHumanPeerLiveShadowMessageReceiver(
    browserForegroundShadowPlatform,
    input,
  );
}

export type BrowserSharedAgentLiveShadowMessageReceiverInput = Omit<
  BrowserLiveShadowMessageClientInput,
  "normalizeContent" | "createIdempotencyKey" | "onHumanVerified"
> & Readonly<{
  api: BrowserLiveShadowMessageClientInput["api"] & Pick<
    NautiloApiClient,
    | "planSharedAgentLiveShadowAcknowledgement"
    | "acknowledgeSharedAgentLiveShadowMessage"
  >;
}>;

/** Browser receiver for an AI-key Human Message in a closed XH1A Room. */
export function createBrowserSharedAgentLiveShadowMessageReceiver(
  input: BrowserSharedAgentLiveShadowMessageReceiverInput,
): VaultSharedAgentLiveShadowMessageReceiver {
  return createForegroundSharedAgentLiveShadowMessageReceiver(
    browserForegroundShadowPlatform,
    input,
  );
}

export type BrowserSharedAgentOutputLiveShadowReceiverInput = Omit<
  BrowserLiveShadowMessageClientInput,
  "normalizeContent" | "createIdempotencyKey" | "onHumanVerified"
> & Readonly<{
  api: BrowserLiveShadowMessageClientInput["api"] & Pick<
    NautiloApiClient,
    "planSharedAgentOutputRead" | "acknowledgeSharedAgentOutput"
  >;
}>;

/** Browser receiver for self-contained Agent output in a closed XH1A Room. */
export function createBrowserSharedAgentOutputLiveShadowReceiver(
  input: BrowserSharedAgentOutputLiveShadowReceiverInput,
): VaultSharedAgentOutputLiveShadowReceiver {
  return createForegroundSharedAgentOutputLiveShadowReceiver(
    browserForegroundShadowPlatform,
    input,
  );
}

export type BrowserRoomHistoryShadowMessageReaderInput = Omit<
  BrowserLiveShadowMessageClientInput,
  "api" | "normalizeContent" | "onHumanVerified" | "onDurableRecovery"
> & Readonly<{
  api: BrowserLiveShadowMessageClientInput["api"] & Pick<
    NautiloApiClient,
    "acknowledgeRoomHistoryShadowRead"
  >;
  resolveTrustedDeviceSigningPublicKey?: (input: Readonly<{
    deviceId: string;
    hostAuthorizationRevision: number;
    trustedDeviceRevision: number;
  }>) => Promise<Uint8Array | null>;
  onHistoryVerificationDiagnostic?: NonNullable<ForegroundRoomHistoryShadowMessageReaderInput[
    "onHistoryVerificationDiagnostic"
  ]>;
}>;

export type BrowserRoomHistoryShadowAcknowledgementInput =
  ForegroundRoomHistoryShadowAcknowledgementInput;

export type BrowserRoomHistoryShadowMessageReader =
  ForegroundRoomHistoryShadowMessageReader;

/** Browser durable history reader using the shared foreground composition. */
export function createBrowserRoomHistoryShadowMessageReader(
  input: BrowserRoomHistoryShadowMessageReaderInput,
): BrowserRoomHistoryShadowMessageReader {
  return createForegroundRoomHistoryShadowMessageReader(
    browserForegroundShadowPlatform,
    input,
  );
}

export type {
  VaultLiveShadowMessageReceiver,
  VaultLiveShadowReceiveResult,
} from "../message/vault-live-shadow-message-receiver.ts";
export type {
  OpenedDomainNamespaceAuthorityV2,
  ProtectedRoomAccessStateV2,
} from
  "../message/domain-namespace-authority-client.ts";
export type {
  HumanPeerLiveShadowReceiveResult,
  VaultHumanPeerLiveShadowMessageReceiver,
} from "../message/vault-human-peer-live-shadow-message-receiver.ts";
export type {
  SharedAgentLiveShadowReceiveResult,
  VaultSharedAgentLiveShadowMessageReceiver,
} from "../message/vault-shared-agent-live-shadow-message-receiver.ts";
export type {
  SharedAgentOutputReadApiPort,
  VaultSharedAgentOutputLiveShadowReceiver,
} from "../message/vault-shared-agent-output-live-shadow-receiver.ts";
export {
  type RoomHistoryShadowAuthorityTransportV1,
  type RoomHistoryShadowFallbackReasonV1,
  type RoomHistoryShadowDomainKeyAuthorityTransportV2,
  type RoomHistoryShadowRecordTransportV1,
  type RoomHistoryShadowSignerEvidenceTransportV1,
  type VaultRoomHistoryShadowMessageReader,
  type VaultRoomHistoryShadowReadInputV1,
  type VaultRoomHistoryShadowReadResultV1,
  type VaultRoomHistoryShadowRecordResultV1,
} from "../message/vault-room-history-shadow-message-reader.ts";

export type {
  LocalInitialDeviceReadiness,
  LocalInitialDeviceReadinessClient,
} from "../../device/local-initial-device-readiness-client.ts";

export { createClientProfileObjectAccessAnchorPort }
  from "../../client-vault/profile-v3.ts";
export {
  CLIENT_DEVICE_PROFILE_MAX_SIGNER_EVIDENCE,
  CLIENT_DEVICE_PROFILE_V4_DOMAIN,
  authenticateClientDeviceProfileV4,
  createClientDeviceProfileV4Candidate,
  destroyOpenedClientDeviceProfileV4,
  type ClientSignerEvidenceV4,
  type OpenedClientDeviceProfileV4,
} from "../../client-vault/profile-v4.ts";

export {
  BrowserPreparedMutationJournalVault,
  createBrowserPreparedMutationJournalVault,
} from "../memory/browser-prepared-mutation-journal-vault.ts";

export {
  prepareVaultHumanLiveShadowMessageV4,
  type PreparedHumanLiveShadowMessageV1,
  type PrepareVaultHumanLiveShadowMessageInputV1,
  type PrepareVaultHumanLiveShadowMessageInputV4,
  type PrepareVaultHumanLiveShadowMessageResultV1,
} from "../message/vault-human-live-shadow-message.ts";

export {
  AuthorizedHumanMemoryUnavailableError,
  createAuthorizedHumanMemoryClient,
  type AuthorizedHumanMemoryClient,
  type AuthorizedHumanMemoryDeviceContentPort,
  type AuthorizedHumanMemoryOpenedV1,
  type AuthorizedHumanMemoryReadResultV1,
  type AuthorizedHumanMemoryTestAuthority,
  type AuthorizedHumanMemoryUnavailableReason,
  type AuthorizedHumanMemoryWriteIntentV1,
} from "../memory/authorized-human-memory-client.ts";
export {
  createVaultAuthorizedHumanMemoryDeviceContentPort,
  type HumanMemoryObjectAccessAnchorPort,
  type VaultHumanMemoryDeviceContentInput,
} from "../memory/vault-human-memory-device-content.ts";
export {
  createAuthorizedHumanTaskClientV1,
  type HumanTaskDeviceContentPortV1,
  type HumanTaskOpenedDefinitionV1,
  type HumanTaskPreparedJournalV1,
  type HumanTaskPublicationPlansV1,
} from "../task/authorized-human-task-client.ts";
export {
  createVaultHumanTaskDeviceContentPortV1,
  type VaultHumanTaskDeviceContentInputV1,
} from "../task/vault-human-task-device-content.ts";
export {
  createVaultHumanArtifactDeviceContentPort,
  type AuthorizedHumanArtifactContentIntentV1,
  type PreparedHumanArtifactContentPublicationV1,
  type VaultHumanArtifactDeviceContentInput,
} from "../artifact/vault-human-artifact-device-content.ts";
export {
  AuthorizedHumanArtifactUnavailableError,
  createAuthorizedHumanArtifactClient,
  createAuthorizedHumanArtifactViewerByteSource,
  type AuthorizedHumanArtifactClient,
  type AuthorizedHumanArtifactContentPort,
  type AuthorizedHumanArtifactMutationJournal,
  type AuthorizedHumanArtifactTestAuthority,
  type AuthorizedHumanArtifactViewerByteSourceInput,
} from "../artifact/authorized-human-artifact-client.ts";

export type {
  ClientProfileVault,
  ClientProfileVaultAvailability,
  PublicClientProfile,
} from "../../client-vault/types.ts";
