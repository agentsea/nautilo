export { BuiltinVaultBackend, deriveRowMetadata } from "./builtin-vault-backend.ts";
export type { VaultMasterPersistence } from "./master-persistence.ts";
export {
  BunOrPinVaultMasterPersistence,
  MemoryVaultMasterPersistence,
  VAULT_MASTER_BUN_SERVICE,
  probeBunSecretsRoundTrip,
  deleteBunKeyForTests,
  deletePinEnvelopeForTests,
} from "./master-persistence.ts";
export {
  VaultCryptoError,
  VaultLockedError,
  VaultSchemaError,
  VaultScopeError,
} from "./errors.ts";

export type { VaultDiskEnvelope } from "./disk-types.ts";
export {
  aesGcmDecrypt,
  aesGcmEncrypt,
} from "./payload-crypto.ts";
export { StreamScrubber, scrubSecrets, type ScrubResult } from "./scrubber.ts";
export {
  redactSecretLikeValues,
  type LeakScanResult,
  type SecretLeakFinding,
} from "./leak-scanner.ts";
export {
  clearRegisteredSecretsForRedaction,
  redactSecrets,
  registerSecretForRedaction,
  unregisterSecretForRedaction,
  type SecretRedactionResult,
} from "./redaction.ts";
export {
  atomicWriteVaultFile,
  readVaultFile,
} from "./atomic-fs.ts";
export { validateVaultEnvelope, emptyVaultEnvelope } from "./disk-validate.ts";
export {
  resolveVaultEncryptedFilePath,
} from "./path-defaults.ts";
