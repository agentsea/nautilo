/**
 * Wave 2 limits are part of the cryptographic format contract. Callers must
 * enforce them before allocating, querying, or invoking expensive crypto.
 */
export const V2_LIMITS = Object.freeze({
  idBytes: 128,
  humanParticipantsPerDomain: 64,
  deviceLeavesPerDomain: 256,
  grantScopeHumans: 32,
  /** Complete Domain authority carried by one current Agent grant. */
  agentGrantDomains: 16_384,
  /** Namespace coordinates needed to describe one current Agent grant. */
  agentGrantNamespaces: 16_384,
  /** Current V2 Agent-grant plan, plaintext, and complete signed-wire bounds. */
  agentGrantPlanBytes: 8 * 1024 * 1024,
  agentGrantSecretBytes: 8 * 1024 * 1024,
  agentGrantWireBytes: 16 * 1024 * 1024,

  // Retained compatibility limits. Current V2 Agent-grant paths use the
  // explicit agentGrant* policy above; do not widen legacy formats implicitly.
  distinctDomainsPerGrant: 256,
  bindingsPerBatch: 256,
  namespacesPerDomainTransition: 256,
  namespaceKeyringBytes: 256 * 1024,
  namespaceEnvelopesPerManifest: 256,
  manifestEnvelopeBytes: 1024 * 1024,
  proofEntriesPerSegment: 256,
  retainedNamespaceGenerations: 4_096,
  recoveryPackages: 4_096,
  recoveryArchiveBytes: 64 * 1024 * 1024,
  authorizedDomainsPerAgent: 256,
  runtimeEnvelopesPerAgent: 256,
  retainedAgentGenerations: 4_096,

  // Retained v1 resource ceilings, renamed here by v2 meaning.
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
  signingPublicKeyBytes: 32,
  signingPrivateKeyBytes: 32,
  signatureBytes: 64,
});

/** Complete retained generation history admitted by one V2 Namespace authority. */
export const MAX_RETAINED_NAMESPACE_GENERATIONS_V2 =
  V2_LIMITS.retainedNamespaceGenerations;

export class V2LimitError extends RangeError {
  override readonly name = "V2LimitError";
}

/**
 * Validate a count or byte length without widening it through coercion.
 * Returning the input keeps guards convenient at decode/query boundaries.
 */
export function assertV2Limit(
  label: string,
  value: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(maximum) || maximum < 0) {
    throw new TypeError("v2 limit maximum must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new V2LimitError(
      `${label} must be a non-negative safe integer`,
    );
  }
  if (value > maximum) {
    throw new V2LimitError(`${label} exceeds the ${maximum} limit`);
  }
  return value;
}

export function assertV2Range(
  label: string,
  value: number,
  minimum: number,
  maximum: number,
): number {
  assertV2Limit(label, value, maximum);
  if (!Number.isSafeInteger(minimum) || minimum < 0 || minimum > maximum) {
    throw new TypeError("v2 range minimum is invalid");
  }
  if (value < minimum) {
    throw new V2LimitError(
      `${label} must be between ${minimum} and ${maximum}`,
    );
  }
  return value;
}
