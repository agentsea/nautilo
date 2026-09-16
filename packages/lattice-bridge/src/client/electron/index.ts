import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  EncryptedFileClientProfileVault,
  atomicWritePrivateFile,
  type WrappingKeyStore,
  type WrappingKeySupport,
} from "../file-vault.ts";
import type { ClientProfileVault } from "../../client-vault/types.ts";
import type { ClientNamespaceGenerationCacheVaultV1 } from
  "../../client-vault/namespace-generation-cache-v1.ts";
import { EncryptedFilePreparedMutationJournalVault } from "../memory/file-prepared-mutation-journal-vault.ts";
import { FilePreparedArtifactCiphertextSidecar } from "../artifact/file-prepared-artifact-ciphertext-sidecar.ts";
import { EncryptedFilePendingInitialDeviceBootstrapVault } from
  "../../device/file-pending-initial-device-bootstrap-vault.ts";
import type { PendingInitialDeviceBootstrapVault } from
  "../../device/restart-safe-initial-device-client-ceremony.ts";
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
  createForegroundLiveShadowMessageReceiver,
  createForegroundMessageBackfillClient,
  createForegroundRoomHistoryShadowMessageReader,
  createForegroundSharedAgentLiveShadowMessageReceiver,
  createForegroundSharedAgentOutputLiveShadowReceiver,
  deriveForegroundCryptoDeviceId,
  type ForegroundHumanPeerLiveShadowMessageReceiverInput,
  type ForegroundBackgroundAuthorizationClientInput,
  type ForegroundLiveShadowMessageClientInput,
  type ForegroundHumanMemoryClientInput,
  type ForegroundLiveShadowMessageReceiverInput,
  type ForegroundMessageBackfillClientInput,
  type ForegroundRoomHistoryShadowAcknowledgementInput,
  type ForegroundRoomHistoryShadowMessageReader,
  type ForegroundRoomHistoryShadowMessageReaderInput,
  type ForegroundSharedAgentLiveShadowMessageReceiverInput,
  type ForegroundSharedAgentOutputLiveShadowReceiverInput,
} from "../message/foreground-shadow-client-composition.ts";
import type { AuthorizedHumanLiveShadowMessageClient } from
  "../message/authorized-human-live-shadow-message-client.ts";
import type { VaultLiveShadowMessageReceiver } from
  "../message/vault-live-shadow-message-receiver.ts";
import type { VaultHumanPeerLiveShadowMessageReceiver } from
  "../message/vault-human-peer-live-shadow-message-receiver.ts";
import type { VaultSharedAgentLiveShadowMessageReceiver } from
  "../message/vault-shared-agent-live-shadow-message-receiver.ts";
import type { VaultSharedAgentOutputLiveShadowReceiver } from
  "../message/vault-shared-agent-output-live-shadow-receiver.ts";
import { createElectronClientNamespaceGenerationCacheVaultV1 } from
  "./namespace-generation-cache-vault.ts";

const KEY_FILE_NAME = "client-profile-vault-key";
const JOURNAL_KEY_FILE_NAME = "protected-memory-mutation-journal-key";
const PENDING_INITIAL_DEVICE_BOOTSTRAP_KEY_FILE_NAME =
  "pending-initial-device-bootstrap-key";

export interface ElectronSafeStoragePort {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(plaintext: string): Buffer;
  decryptString(ciphertext: Buffer): string;
}

interface ElectronKeyEnvelope {
  readonly formatVersion: 1;
  readonly currentBase64: string;
  readonly previousBase64?: string;
}

function decodeKey(value: string | undefined): Uint8Array | undefined {
  if (value === undefined) return undefined;
  const key = Buffer.from(value, "base64");
  return key.length === 32 ? new Uint8Array(key) : undefined;
}

class ElectronSafeStorageKeyStore implements WrappingKeyStore {
  readonly #path: string;
  readonly #safeStorage: ElectronSafeStoragePort;

  constructor(
    directory: string,
    safeStorage: ElectronSafeStoragePort,
    keyFileName = KEY_FILE_NAME,
  ) {
    this.#path = join(directory, keyFileName);
    this.#safeStorage = safeStorage;
  }

  support(): Promise<WrappingKeySupport> {
    if (!this.#safeStorage.isEncryptionAvailable()) {
      return Promise.resolve({
        supported: false,
        reasonCode: "electron_safe_storage_unavailable",
      });
    }
    if (this.#safeStorage.getSelectedStorageBackend?.() === "basic_text") {
      return Promise.resolve({
        supported: false,
        reasonCode: "electron_safe_storage_basic_text",
      });
    }
    return Promise.resolve({ supported: true });
  }

  async loadCandidates(): Promise<readonly Uint8Array[]> {
    let protectedBytes: Buffer;
    try {
      protectedBytes = await readFile(this.#path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const plaintext = this.#safeStorage.decryptString(protectedBytes);
    const envelope = JSON.parse(plaintext) as ElectronKeyEnvelope;
    if (envelope.formatVersion !== 1) {
      throw new Error("Electron vault wrapping key is corrupt");
    }
    return [
      decodeKey(envelope.currentBase64),
      decodeKey(envelope.previousBase64),
    ].filter((key): key is Uint8Array => key !== undefined);
  }

  initialize(key: Uint8Array): Promise<void> {
    return this.#write({ formatVersion: 1, currentBase64: this.#encode(key) });
  }

  stageRotation(
    current: Uint8Array,
    previous: Uint8Array,
  ): Promise<void> {
    return this.#write({
      formatVersion: 1,
      currentBase64: this.#encode(current),
      previousBase64: this.#encode(previous),
    });
  }

  async commitRotation(): Promise<void> {
    const [current] = await this.loadCandidates();
    if (current === undefined) return;
    try {
      await this.initialize(current);
    } finally {
      current.fill(0);
    }
  }

  async rollbackRotation(): Promise<void> {
    const candidates = await this.loadCandidates();
    const previous = candidates[1];
    if (previous === undefined) return;
    try {
      await this.initialize(previous);
    } finally {
      for (const key of candidates) key.fill(0);
    }
  }

  #encode(key: Uint8Array): string {
    if (key.length !== 32) {
      throw new Error("Electron vault wrapping key is invalid");
    }
    return Buffer.from(key).toString("base64");
  }

  #write(envelope: ElectronKeyEnvelope): Promise<void> {
    const protectedBytes = this.#safeStorage.encryptString(
      JSON.stringify(envelope),
    );
    return atomicWritePrivateFile(this.#path, protectedBytes);
  }
}

export interface ElectronClientProfileVaultOptions {
  readonly directory: string;
  readonly safeStorage: ElectronSafeStoragePort;
}

export function createElectronClientProfileVault(
  options: ElectronClientProfileVaultOptions,
): ClientProfileVault {
  return new EncryptedFileClientProfileVault(
    options.directory,
    new ElectronSafeStorageKeyStore(options.directory, options.safeStorage),
  );
}

/** Dedicated pending-bootstrap custody; it never reuses profile wrapping keys. */
export function createElectronPendingInitialDeviceBootstrapVault(
  options: ElectronClientProfileVaultOptions,
): PendingInitialDeviceBootstrapVault {
  return new EncryptedFilePendingInitialDeviceBootstrapVault(
    options.directory,
    new ElectronSafeStorageKeyStore(
      options.directory,
      options.safeStorage,
      PENDING_INITIAL_DEVICE_BOOTSTRAP_KEY_FILE_NAME,
    ),
  );
}

export interface ElectronInitialDeviceReadinessClientInput
extends ElectronClientProfileVaultOptions, Pick<
  LocalInitialDeviceReadinessClientInput,
  "serverScope" | "userId" | "humanActorId" | "installationId" | "crypto"
> {
  readonly api: Parameters<typeof createInitialDeviceBootstrapApiClientPort>[0]
    & HumanDeviceMembershipApiPort;
  readonly createRecoveryInstallationId?: () => string;
  readonly activateRecoveryInstallationId?: (installationId: string) => void;
  readonly onRecoveryIdentityActivated?: () => Promise<void> | void;
}

function createElectronInitialDeviceReadinessClientForIdentity(
  input: ElectronInitialDeviceReadinessClientInput,
): LocalInitialDeviceReadinessClient {
  const crypto = input.crypto ?? new LatticeCrypto();
  const profileVault = createElectronClientProfileVault(input);
  const identity = deriveAdditionalDeviceClientIdentity({
    crypto,
    ...input,
    clientKind: "electron",
  });
  const personalDomainAuthority = createForegroundDomainKeyAuthorityClientV2(
    {
      createNamespaceGenerationCacheVault: () =>
        createElectronClientNamespaceGenerationCacheVaultV1(input),
    },
    {
      api: input.api,
      crypto,
      vault: profileVault,
      coordinates: identity.coordinates,
      now: () => Date.now(),
      createId: randomUUID,
    },
  );
  const membership = createHumanDeviceMembershipClient({
    api: input.api,
    crypto,
    vault: profileVault,
    coordinates: identity.coordinates,
    clientKind: "electron",
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
    clientKind: "electron",
    profileVault,
    pendingVault: createElectronPendingInitialDeviceBootstrapVault(input),
    bootstrap: createInitialDeviceBootstrapApiClientPort(input.api),
    initialHumanDomain: createInitialHumanDomainApiClientPort(input.api),
    humanDeviceMembership: membership,
    additionalDeviceTarget: membership,
    additionalDeviceApprover: membership,
  });
}

export function createElectronInitialDeviceReadinessClient(
  input: ElectronInitialDeviceReadinessClientInput,
): LocalInitialDeviceReadinessClient {
  const current = createElectronInitialDeviceReadinessClientForIdentity(input);
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
        clientKind: "electron",
      });
      activateRecoveryInstallationId(installationId);
      await createElectronClientProfileVault(input)
        .forgetProfile(previousIdentity.coordinates)
        .catch(() => undefined);
      const next = createElectronInitialDeviceReadinessClientForIdentity({
        api: input.api,
        serverScope: input.serverScope,
        userId: input.userId,
        humanActorId: input.humanActorId,
        installationId,
        directory: input.directory,
        safeStorage: input.safeStorage,
        ...(input.crypto === undefined ? {} : { crypto: input.crypto }),
      });
      try {
        if (next.continueAdditionalDevice === undefined) {
          throw new Error("Additional-device connection is unavailable");
        }
        return await next.continueAdditionalDevice();
      } finally {
        await input.onRecoveryIdentityActivated?.();
      }
    },
    async recoverEncryptionDevice(mnemonic: string) {
      const installationId = createRecoveryInstallationId();
      const next = createElectronInitialDeviceReadinessClientForIdentity({
        api: input.api,
        serverScope: input.serverScope,
        userId: input.userId,
        humanActorId: input.humanActorId,
        installationId,
        directory: input.directory,
        safeStorage: input.safeStorage,
        ...(input.crypto === undefined ? {} : { crypto: input.crypto }),
      });
      let recovered = false;
      try {
        const readiness = await next.recoverEncryptionDevice!(mnemonic);
        recovered = true;
        activateRecoveryInstallationId(installationId);
        await input.onRecoveryIdentityActivated?.();
        return readiness;
      } catch (error) {
        if (recovered) throw error;
        const identity = deriveAdditionalDeviceClientIdentity({
          crypto: input.crypto ?? new LatticeCrypto(),
          serverScope: input.serverScope,
          userId: input.userId,
          humanActorId: input.humanActorId,
          installationId,
          clientKind: "electron",
        });
        await createElectronClientProfileVault(input)
          .forgetProfile(identity.coordinates)
          .catch(() => undefined);
        throw error;
      }
    },
  });
}

export type {
  LocalInitialDeviceReadiness,
  LocalInitialDeviceReadinessClient,
} from "../../device/local-initial-device-readiness-client.ts";

export function createElectronPreparedMutationJournalVault(
  options: ElectronClientProfileVaultOptions,
): EncryptedFilePreparedMutationJournalVault {
  return new EncryptedFilePreparedMutationJournalVault(
    options.directory,
    new ElectronSafeStorageKeyStore(
      options.directory,
      options.safeStorage,
      JOURNAL_KEY_FILE_NAME,
    ),
  );
}

export interface ElectronForegroundShadowCustody {
  readonly profileVault: ClientProfileVault;
  readonly preparedMutationJournalVault:
    EncryptedFilePreparedMutationJournalVault;
  readonly namespaceGenerationCacheVault:
    ClientNamespaceGenerationCacheVaultV1;
  lock(): Promise<void>;
  dispose(): Promise<void>;
}

/** One Electron-main custody lifetime shared by all foreground clients. */
export function createElectronForegroundShadowCustody(
  options: ElectronClientProfileVaultOptions,
): ElectronForegroundShadowCustody {
  const profileVault = createElectronClientProfileVault(options);
  const preparedMutationJournalVault =
    createElectronPreparedMutationJournalVault(options);
  const namespaceGenerationCacheVault =
    createElectronClientNamespaceGenerationCacheVaultV1(options);
  let lockPromise: Promise<void> | undefined;
  const lock = (): Promise<void> => {
    lockPromise ??= Promise.allSettled([
      profileVault.lock(),
      preparedMutationJournalVault.lock(),
      namespaceGenerationCacheVault.lock(),
    ]).then((results) => {
      const failures = results
        .filter((result): result is PromiseRejectedResult =>
          result.status === "rejected"
        )
        .map((result): unknown => result.reason as unknown);
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "Electron foreground Shadow custody lock failed",
        );
      }
    });
    return lockPromise;
  };
  return Object.freeze({
    profileVault,
    preparedMutationJournalVault,
    namespaceGenerationCacheVault,
    lock,
    dispose: lock,
  });
}

export type ElectronForegroundShadowCustodyInput =
  | Readonly<{
    foregroundCustody: ElectronForegroundShadowCustody;
    directory?: string;
    safeStorage?: ElectronSafeStoragePort;
  }>
  | (ElectronClientProfileVaultOptions & Readonly<{
    foregroundCustody?: undefined;
  }>);

function electronForegroundShadowPlatform(
  input: ElectronForegroundShadowCustodyInput,
) {
  const custody = input.foregroundCustody
    ?? createElectronForegroundShadowCustody(input);
  return Object.freeze({
    clientKind: "electron" as const,
    clientLabel: "Electron" as const,
    createProfileVault: () => custody.profileVault,
    createPreparedMutationJournalVault: () =>
      custody.preparedMutationJournalVault,
    createNamespaceGenerationCacheVault: () =>
      custody.namespaceGenerationCacheVault,
    createId: randomUUID,
  });
}

export type ElectronLiveShadowMessageClientInput =
  ForegroundLiveShadowMessageClientInput & ElectronForegroundShadowCustodyInput;

export type ElectronBackgroundAuthorizationClientInput =
  ForegroundBackgroundAuthorizationClientInput
  & ElectronForegroundShadowCustodyInput;

/** Electron-main responder using the controller's shared foreground custody. */
export function createElectronBackgroundAuthorizationClientV2(
  input: ElectronBackgroundAuthorizationClientInput,
) {
  return createForegroundBackgroundAuthorizationClientV2(
    electronForegroundShadowPlatform(input),
    input,
  );
}

export type ElectronHumanMemoryClientInput =
  ForegroundHumanMemoryClientInput & ElectronForegroundShadowCustodyInput;

export type ElectronMessageBackfillClientInput =
  ForegroundMessageBackfillClientInput & ElectronForegroundShadowCustodyInput;

/** Electron-main adapter using the controller's existing private custody. */
export function createElectronMessageBackfillClient(
  input: ElectronMessageBackfillClientInput,
) {
  return createForegroundMessageBackfillClient(
    electronForegroundShadowPlatform(input),
    input,
  );
}

/** Electron-main only; file vault and mutation journal remain main-process custody. */
export function createElectronHumanMemoryClient(
  input: ElectronHumanMemoryClientInput,
): AuthorizedHumanMemoryClient {
  return createForegroundHumanMemoryClient(electronForegroundShadowPlatform(input), input);
}

/** Electron-main foreground sender with file-backed private custody. */
export function createElectronLiveShadowMessageClient(
  input: ElectronLiveShadowMessageClientInput,
): AuthorizedHumanLiveShadowMessageClient {
  return createForegroundLiveShadowMessageClient(
    electronForegroundShadowPlatform(input),
    input,
  );
}

export type ElectronLiveShadowMessageReceiverInput =
  ForegroundLiveShadowMessageReceiverInput
  & ElectronForegroundShadowCustodyInput;

export function createElectronLiveShadowMessageReceiver(
  input: ElectronLiveShadowMessageReceiverInput,
): VaultLiveShadowMessageReceiver {
  return createForegroundLiveShadowMessageReceiver(
    electronForegroundShadowPlatform(input),
    input,
  );
}

export type ElectronHumanPeerLiveShadowMessageReceiverInput =
  ForegroundHumanPeerLiveShadowMessageReceiverInput
  & ElectronForegroundShadowCustodyInput;

export function createElectronHumanPeerLiveShadowMessageReceiver(
  input: ElectronHumanPeerLiveShadowMessageReceiverInput,
): VaultHumanPeerLiveShadowMessageReceiver {
  return createForegroundHumanPeerLiveShadowMessageReceiver(
    electronForegroundShadowPlatform(input),
    input,
  );
}

export type ElectronSharedAgentLiveShadowMessageReceiverInput =
  ForegroundSharedAgentLiveShadowMessageReceiverInput
  & ElectronForegroundShadowCustodyInput;

export function createElectronSharedAgentLiveShadowMessageReceiver(
  input: ElectronSharedAgentLiveShadowMessageReceiverInput,
): VaultSharedAgentLiveShadowMessageReceiver {
  return createForegroundSharedAgentLiveShadowMessageReceiver(
    electronForegroundShadowPlatform(input),
    input,
  );
}

export type ElectronSharedAgentOutputLiveShadowReceiverInput =
  ForegroundSharedAgentOutputLiveShadowReceiverInput
  & ElectronForegroundShadowCustodyInput;

export function createElectronSharedAgentOutputLiveShadowReceiver(
  input: ElectronSharedAgentOutputLiveShadowReceiverInput,
): VaultSharedAgentOutputLiveShadowReceiver {
  return createForegroundSharedAgentOutputLiveShadowReceiver(
    electronForegroundShadowPlatform(input),
    input,
  );
}

export type ElectronRoomHistoryShadowMessageReaderInput =
  ForegroundRoomHistoryShadowMessageReaderInput
  & ElectronForegroundShadowCustodyInput;
export type ElectronRoomHistoryShadowAcknowledgementInput =
  ForegroundRoomHistoryShadowAcknowledgementInput;
export type ElectronRoomHistoryShadowMessageReader =
  ForegroundRoomHistoryShadowMessageReader;

export type {
  OpenedDomainNamespaceAuthorityV2,
  ProtectedRoomAccessStateV2,
} from
  "../message/domain-namespace-authority-client.ts";

export function createElectronRoomHistoryShadowMessageReader(
  input: ElectronRoomHistoryShadowMessageReaderInput,
): ElectronRoomHistoryShadowMessageReader {
  return createForegroundRoomHistoryShadowMessageReader(
    electronForegroundShadowPlatform(input),
    input,
  );
}

/** Public, secret-free coordinate used to bind Electron resume approvals. */
export function deriveElectronCryptoDeviceId(
  input: Readonly<{
    serverScope: string;
    userId: string;
    humanActorId: string;
    installationId: string;
  }>,
): string {
  return deriveForegroundCryptoDeviceId("electron", input);
}

export {
  createObservedHumanMemoryDeviceContent,
  type HumanMemoryReadObservationAdmissionV1,
} from "../memory/observed-human-memory-device-content.ts";

export {
  ElectronClientNamespaceGenerationCacheVaultV1,
  createElectronClientNamespaceGenerationCacheVaultV1,
  type ElectronClientNamespaceGenerationCacheVaultOptions,
} from "./namespace-generation-cache-vault.ts";

export function createElectronPreparedArtifactCiphertextSidecar(
  options: Pick<ElectronClientProfileVaultOptions, "directory">,
): FilePreparedArtifactCiphertextSidecar {
  return new FilePreparedArtifactCiphertextSidecar(options.directory);
}

export {
  createPreparedArtifactMutationJournal,
  type PreparedArtifactCiphertextSidecarPort,
  type PreparedArtifactCiphertextSidecarReference,
} from "../artifact/prepared-artifact-ciphertext-sidecar.ts";

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
