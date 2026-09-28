export {
  OPERATOR_SECRET_KEY_REGEX,
  bootstrapAdminPasswordKey,
  bootstrapPinKey,
  claimInviteKey,
  isRecognizedOperatorSecretKey,
  assertFileMode600,
  assertPathOutsideGitWorkTree,
  prepareOperatorSecretsPath,
} from "./shared.ts";

export {
  bootstrapDirForInstance,
  readBootstrapDir,
  writeBootstrapAdminPassword,
  writeBootstrapAdminPin,
  writeBootstrapClaimInvite,
  markBootstrapUsed,
  isBootstrapUsed,
  purgeBootstrapDir,
  BOOTSTRAP_FILE_ALLOWLIST,
  listUnknownBootstrapFiles,
  type BootstrapDirSnapshot,
} from "./bootstrap-dir.ts";

export {
  defaultOperatorSecretsPath,
  parseOperatorSecretsBody,
  loadOperatorSecrets,
} from "./loader.ts";

export { appendOperatorSecrets } from "./appender.ts";
export {
  ensurePersonalProviderCustodyFile,
  resetPersonalProviderCustodyFile,
  type PersonalProviderCustodyFileOptions,
} from "./personal-provider-custody-file.ts";

export {
  PERSONAL_PROVIDER_CUSTODY_ENV,
  captureInjectedPersonalProviderCustody,
  readInjectedPersonalProviderCustody,
  PersonalProviderCustodyError,
  createPersonalProviderCustody,
  parsePersonalProviderCustody,
  serializePersonalProviderCustody,
  personalProviderCustodyFromEnvFile,
  encryptPersonalProviderCredential,
  decryptPersonalProviderCredential,
  type PersonalProviderCustody,
  type PersonalProviderCredentialContext,
  type PersonalProviderCredentialEnvelope,
  type PersonalProviderCustodyErrorCode,
} from "./personal-provider-custody.ts";

export {
  assertPersonalProviderCustodyHealth,
  assertPersonalProviderRestoreCustody,
  buildPersonalProviderCustodyBackupEvidence,
  readPersonalProviderCredentialEvidenceFromDump,
  type PersonalProviderCredentialDbEvidence,
  type PersonalProviderCustodyBackupEvidence,
  type PersonalProviderCustodyHealthEvidence,
} from "./personal-provider-backup.ts";

export {
  REMOTE_PAIRING_PEPPER_KEY,
  defaultEnsureRemotePairingPepperDeps,
  ensureRemotePairingPepper,
  isValidRemotePairingPepper,
  type EnsureRemotePairingPepperArgs,
  type EnsureRemotePairingPepperDeps,
} from "./remote-pairing-pepper.ts";

export {
  PUSH_TOKEN_ENCRYPTION_KEY,
  defaultEnsurePushTokenEncryptionKeyDeps,
  ensurePushTokenEncryptionKey,
  isValidPushTokenEncryptionKey,
  type EnsurePushTokenEncryptionKeyArgs,
  type EnsurePushTokenEncryptionKeyDeps,
} from "./push-token-encryption-key.ts";
