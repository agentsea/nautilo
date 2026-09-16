/**
 * Compatibility export for the compose driver. The implementation is shared
 * with local server startup so local and managed deployments cannot drift on
 * encryption-key shape, persistence, locking, or redaction.
 */
export {
  PUSH_TOKEN_ENCRYPTION_KEY,
  defaultEnsurePushTokenEncryptionKeyDeps,
  ensurePushTokenEncryptionKey,
  isValidPushTokenEncryptionKey,
  type EnsurePushTokenEncryptionKeyArgs,
  type EnsurePushTokenEncryptionKeyDeps,
} from "@nautilo/operator-secrets";
