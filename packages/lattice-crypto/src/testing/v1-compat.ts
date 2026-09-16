/**
 * Imported v1 characterization surface.
 *
 * This module is test-only compatibility for the pre-v2 lattice-lab behavior.
 * Production consumers must import the supported v2 package root instead.
 */

export * from "../types/index.ts";
export {
  ENCRYPTED_OBJECT_FORMAT_VERSION,
  objectPayloadAad,
  wrappedDekAad,
} from "../format/object-v1.ts";
export type {
  ObjectCryptoContext,
  ObjectPayloadContext,
} from "../format/object-v1.ts";
export {
  GRANT_FORMAT_VERSION,
  grantSigningBytes,
  parseGrant,
  serializeGrant,
} from "../format/grant-v1.ts";
export { LATTICE_LIMITS } from "../limits.ts";
export { InputValidationError } from "../validation.ts";
export {
  RECOVERY_KIT_FORMAT_VERSION,
  parseRecoveryKit,
  serializeRecoveryKit,
} from "../recovery/kit-v1.ts";
export {
  DeviceStateVault,
  DEVICE_STATE_FORMAT_VERSION,
} from "../recovery/device-vault.ts";
export type { DeviceStateSnapshot } from "../recovery/device-vault.ts";
export {
  DEVICE_APPROVAL_FORMAT_VERSION,
  EPOCH_SECRET_PACKAGE_FORMAT_VERSION,
  RECOVERY_ARCHIVE_FORMAT_VERSION,
  InMemoryRecoveryRelay,
  deviceApprovalSigningBytes,
  epochSecretPackageKey,
  epochSecretPackageSigningBytes,
  recoveryArchiveSigningBytes,
} from "../recovery/protocol.ts";
export type {
  DeviceApproval,
  EpochSecretPackage,
  EpochSecretPurpose,
  RecoveryArchive,
  RecoveryPublicKeyRecord,
} from "../recovery/protocol.ts";

export {
  LatticeCrypto,
  systemRng,
  seededRng,
  systemClock,
  manualClock,
} from "../crypto/index.ts";
export type {
  Rng,
  Clock,
  ManualClock,
  KeyPair,
  RecoveryKit,
} from "../crypto/index.ts";

export type {
  GroupKeyProvider,
  GroupMember,
  GroupRosterEntry,
} from "../group/provider.ts";
export { DummyGroupProvider } from "../group/dummy.ts";
export { MlsGroupProvider } from "../group/mls.ts";
export { OpenMlsGroupProvider } from "../group/openmls.ts";

export type {
  LatticeScheme,
  SchemeAccess,
  WrapContext,
  UnwrapContext,
  CoveredNamespaceKey,
  DeriveGrantParams,
} from "../lattice/scheme.ts";
export { EnumerationScheme } from "../lattice/enumeration.ts";

export type { Storage } from "../storage/store.ts";
export {
  InMemoryRelationalStore,
} from "../storage/in-memory-relational-store.ts";

export { LatticeCryptoEngine } from "../engine/engine.ts";
export type {
  EngineDeps,
  DeviceRegistration,
  DeviceCapability,
  DelegationSession,
  MintGrantParams,
  EncryptManyItem,
  DecryptResult,
  EncryptResult,
  DenyReason,
  GrantCheck,
} from "../engine/engine.ts";

export { defineConformanceTests } from "../conformance/suite.ts";
export {
  canonicalizeParticipants,
  participantsKey,
  isSubset,
} from "../util/sets.ts";
