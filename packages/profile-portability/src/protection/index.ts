export {
  PROTECTION_SUITE_BOUNDS,
  DECLARED_PROTECTION_SUITE,
  PLAINTEXT_SUITE_IDS,
  validateProtectionSuiteDeclared,
  validateFrameAad,
  type ProtectionSuite,
  type ProtectionSuiteBounds,
} from "./suite";

export {
  ARGON2ID_BOUNDS,
  type Argon2idParams,
} from "./argon2-bounds";

export {
  // Wave 1A — framed recovery protection
  type Argon2idDeriveFn,
  type BundleEncryptResult,
  type VerifyFinalResult,
  type UnwrapDekResult,
  type WrapDekInput,
  type UnwrapDekInput,
  type EncryptBundleInput,
  type VerifyFinalInput,
  computeHeaderDigest,
  computeHeaderDigestBytes,
  deriveFrameNonce,
  deriveWrapNonce,
  computeFrameAad,
  computeSlotAad,
  generateDek,
  equalBytes,
  wrapDekWithRecoverySlot,
  unwrapDekFromRecoverySlot,
  encryptBundle,
  verifyFinalBundle,
} from "./framed-suite";
