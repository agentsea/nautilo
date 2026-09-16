export const CLIENT_PROFILE_VAULT_FORMAT_VERSION = 1 as const;
// One profile may retain the provider state for the canonical 256-Domain
// device inventory. A fresh one-member OpenMLS state is already about 6.5 KiB,
// so the former 1 MiB ceiling contradicted the advertised Domain capacity.
export const CLIENT_PROFILE_VAULT_MAX_BYTES = 4 * 1_048_576;
export const CLIENT_PROFILE_VAULT_MAX_PROFILES = 64 as const;

export type CryptoClientKind = "browser" | "electron" | "tui";
export type ClientProfileVaultStatus =
  | "available"
  | "locked"
  | "unsupported"
  | "corrupt"
  | "storage_lost";

export interface ClientProfileVaultAvailability {
  readonly status: ClientProfileVaultStatus;
  readonly reasonCode?: string;
}

export interface ClientProfileCoordinates {
  readonly serverScope: string;
  readonly userId: string;
  readonly humanActorId: string;
  readonly profileId: string;
  readonly deviceId: string;
  readonly installationLineageDigest: string;
}

export interface ClientProfilePublicState {
  readonly clientKind: CryptoClientKind;
  readonly publicFingerprint: string;
}

export interface PublicClientProfile {
  readonly coordinates: ClientProfileCoordinates;
  readonly generation: number;
  readonly lifecycle: "staged" | "active";
  readonly publicState: ClientProfilePublicState;
  readonly stageId?: string;
}

export interface StageClientProfileInput {
  readonly coordinates: ClientProfileCoordinates;
  readonly stageId: string;
  readonly generation: number;
  readonly profileBytes: Uint8Array;
  readonly publicState: ClientProfilePublicState;
}

export interface StagedClientProfileReceipt {
  readonly formatVersion: typeof CLIENT_PROFILE_VAULT_FORMAT_VERSION;
  readonly profileId: string;
  readonly stageId: string;
  readonly generation: number;
}

export interface InterruptedClientProfileResolution {
  readonly stageId: string;
  readonly action: "activate" | "abort";
}

export interface ClientProfileVault {
  availability(): Promise<ClientProfileVaultAvailability>;
  unlock(): Promise<ClientProfileVaultAvailability>;
  lock(): Promise<void>;
  stageProfile(
    input: StageClientProfileInput,
  ): Promise<StagedClientProfileReceipt>;
  activateProfile(
    coordinates: ClientProfileCoordinates,
    stageId: string,
  ): Promise<void>;
  abortStagedProfile(
    coordinates: ClientProfileCoordinates,
    stageId: string,
  ): Promise<void>;
  recoverInterruptedActivation(
    coordinates: ClientProfileCoordinates,
    resolution: InterruptedClientProfileResolution,
  ): Promise<void>;
  withOpenProfile<T>(
    coordinates: ClientProfileCoordinates,
    operation: (profileBytes: Uint8Array) => Promise<T> | T,
  ): Promise<T>;
  /** Opens one exact staged generation and wipes callback-local plaintext. */
  withOpenStagedProfile?<T>(
    coordinates: ClientProfileCoordinates,
    stageId: string,
    operation: (profileBytes: Uint8Array) => Promise<T> | T,
  ): Promise<T>;
  listPublicProfiles(): Promise<readonly PublicClientProfile[]>;
  rotateWrappingMaterial(): Promise<void>;
  forgetProfile(coordinates: ClientProfileCoordinates): Promise<void>;
}
