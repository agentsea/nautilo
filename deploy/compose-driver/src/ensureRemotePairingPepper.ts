/**
 * Compatibility export for the compose driver. The implementation is shared
 * with local server startup so deploy and development cannot drift on secret
 * shape, persistence, locking, or redaction.
 */
export {
  REMOTE_PAIRING_PEPPER_KEY,
  defaultEnsureRemotePairingPepperDeps,
  ensureRemotePairingPepper,
  isValidRemotePairingPepper,
  type EnsureRemotePairingPepperArgs,
  type EnsureRemotePairingPepperDeps,
} from "@nautilo/operator-secrets";
