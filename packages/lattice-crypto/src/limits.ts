/**
 * Bridge-visible production input/resource ceilings. Adapters should reject
 * above these bounds before allocating, querying, parsing, or invoking crypto.
 */
export const LATTICE_LIMITS = Object.freeze({
  idBytes: 128,
  namespaceParticipants: 64,
  grantScope: 32,
  coveredNamespaces: 256,
  epochsPerNamespace: 32,
  totalGrantEpochs: 1_024,
  retainedEpochsPerDevice: 4_096,
  recoveryPackages: 4_096,
  recoveryPackageBytes: 4 * 1024,
  deviceStateBytes: 16 * 1024 * 1024,
  batchItems: 256,
  plaintextBytes: 1024 * 1024,
  ciphertextBytes: 1024 * 1024 + 40,
  wrappedDekBytes: 4 * 1024,
  grantSecretBytes: 1024 * 1024,
  grantWireBytes: 2 * 1024 * 1024,
  grantTtlMs: 24 * 60 * 60 * 1000,
  schemeIdBytes: 64,
  hpkePublicKeyBytes: 65,
  hpkePrivateKeyBytes: 32,
  signingPrivateKeyBytes: 32,
  signatureBytes: 64,
});
