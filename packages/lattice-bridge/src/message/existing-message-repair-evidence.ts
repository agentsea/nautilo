/** Retained publication provenance; original attribution remains on the Message. */
export type ExistingMessageRepairEvidence = Readonly<{
  identityDigestBase64url: string;
  allocationDigestBase64url: string;
  attestationDigestBase64url: string;
  publisherSignerKeyId: string;
  publisherSigningPublicKeyBase64url: string;
}> & (
  | Readonly<{ publisherKind?: "foreground_runtime"; publisherHumanId?: never }>
  | Readonly<{ publisherKind: "human_device"; publisherHumanId: string }>
);

/** Authenticated retained Namespace coordinates used by the existing vault opener. */
export type ExistingMessageRetainedGeneration = Readonly<{
  namespaceGeneration: number;
  accessRevision: number;
  headDigestBase64url: string;
  publicationDigestBase64url: string;
  publicationSetDigestBase64url: string;
  audienceFingerprintBase64url: string;
}>;
