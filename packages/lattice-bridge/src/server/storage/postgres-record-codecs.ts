import {
  storageAdapterSupportV2,
  type AgentRuntimeAtomicStorageWireV2,
  type CryptoDomainPublicRecordV2,
  type EncryptedObjectWireRecordV2,
  type GrantWireRecordV2,
  type NamespaceBindingWireRecordV2,
  type NamespaceHeadV2,
  type ObjectAccessStorageWireStateV2,
  type ProviderPublicHeadV2,
  type RecoveryArchiveWireRecordV2,
} from "@nautilo/lattice-crypto/wire";

export type DatabaseScalar =
  | string
  | number
  | bigint
  | boolean
  | Uint8Array
  | readonly string[]
  | Date
  | null;

export type DatabaseRow = Readonly<Record<string, DatabaseScalar>>;

function requiredString(row: DatabaseRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") {
    throw new TypeError(`Crypto storage column ${name} must be text`);
  }
  return value;
}

function requiredNumber(row: DatabaseRow, name: string): number {
  const value = row[name];
  let normalized: number;
  if (typeof value === "bigint") {
    normalized =
      value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : Number.NaN;
  } else if (
    typeof value === "string"
    && /^(0|[1-9][0-9]*)$/.test(value)
  ) {
    normalized = Number(value);
  } else {
    normalized = typeof value === "number" ? value : Number.NaN;
  }
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new TypeError(`Crypto storage column ${name} must be a safe counter`);
  }
  return normalized;
}

function requiredBoolean(row: DatabaseRow, name: string): boolean {
  const value = row[name];
  if (typeof value !== "boolean") {
    throw new TypeError(`Crypto storage column ${name} must be boolean`);
  }
  return value;
}

function requiredBytes(row: DatabaseRow, name: string): Uint8Array {
  const value = row[name];
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`Crypto storage column ${name} must be bytea`);
  }
  return new Uint8Array(value);
}

function nullableBytes(row: DatabaseRow, name: string): Uint8Array | null {
  const value = row[name];
  if (value === null) return null;
  return requiredBytes(row, name);
}

export function domainFromRow(
  row: DatabaseRow & Readonly<{ participants: unknown }>,
): CryptoDomainPublicRecordV2 {
  const participants = row.participants;
  if (
    !Array.isArray(participants)
    || participants.some((participant) => typeof participant !== "string")
  ) {
    throw new TypeError(
      "Crypto storage column participants must be a text array",
    );
  }
  return storageAdapterSupportV2.validateDomain({
    id: requiredString(row, "id"),
    participantDigest: requiredBytes(row, "participant_digest"),
    participants: participants as string[],
    epoch: requiredNumber(row, "epoch"),
    authorizationRevision: requiredNumber(row, "authorization_revision"),
    rosterBytes: requiredBytes(row, "roster_bytes"),
  });
}

export function providerHeadFromRow(row: DatabaseRow): ProviderPublicHeadV2 {
  return storageAdapterSupportV2.validateProviderState({
    head: {
      providerId: requiredString(row, "provider_id"),
      domainId: requiredString(row, "domain_id"),
      epoch: requiredNumber(row, "epoch"),
      stateHash: requiredBytes(row, "state_hash"),
    } as ProviderPublicHeadV2,
    rosterBytes: requiredBytes(row, "roster_bytes"),
  }).head;
}

export function bindingFromRow(
  row: DatabaseRow,
): NamespaceBindingWireRecordV2 {
  return storageAdapterSupportV2.validateNamespaceBinding({
    namespaceId: requiredString(row, "namespace_id"),
    revision: requiredNumber(row, "revision"),
    bindingHash: requiredBytes(row, "binding_hash"),
    previousBindingHash: nullableBytes(row, "previous_binding_hash"),
    signedBindingBytes: requiredBytes(row, "signed_binding_bytes"),
    humanKeyringEnvelopeBytes: requiredBytes(
      row,
      "human_keyring_envelope_bytes",
    ),
    aiKeyringEnvelopeBytes: requiredBytes(row, "ai_keyring_envelope_bytes"),
  });
}

export function namespaceHeadFromRow(row: DatabaseRow): NamespaceHeadV2 {
  return storageAdapterSupportV2.validateNamespaceHead({
    namespaceId: requiredString(row, "namespace_id"),
    accessRevision: requiredNumber(row, "access_revision"),
    bindingHash: requiredBytes(row, "binding_hash"),
    domainId: requiredString(row, "domain_id"),
    domainEpoch: requiredNumber(row, "domain_epoch"),
  });
}

export function objectFromRow(row: DatabaseRow): EncryptedObjectWireRecordV2 {
  return storageAdapterSupportV2.validateEncryptedObject({
    objectId: requiredString(row, "object_id"),
    payloadBytes: requiredBytes(row, "payload_bytes"),
  });
}

export function objectAccessFromRows(
  head: DatabaseRow,
  envelopes: readonly DatabaseRow[],
): ObjectAccessStorageWireStateV2 {
  return storageAdapterSupportV2.validateObjectAccessState({
    head: {
      objectId: requiredString(head, "object_id"),
      accessRevision: requiredNumber(head, "access_revision"),
      manifestHash: requiredBytes(head, "manifest_hash"),
      manifestBytes: requiredBytes(head, "manifest_bytes"),
    },
    namespaceEnvelopes: envelopes.map((row) => ({
      namespaceId: requiredString(row, "namespace_id"),
      envelopeHash: requiredBytes(row, "envelope_hash"),
      envelopeBytes: requiredBytes(row, "envelope_bytes"),
    })),
  });
}

export function runtimeFromRows(
  state: DatabaseRow,
  configObjects: readonly DatabaseRow[],
  domainEnvelopes: readonly DatabaseRow[],
  challenges: readonly DatabaseRow[],
): AgentRuntimeAtomicStorageWireV2 {
  return storageAdapterSupportV2.validateAgentRuntimeAtomicState({
    runtime: {
      agentId: requiredString(state, "agent_id"),
      authorizationRevision: requiredNumber(state, "authorization_revision"),
      runtimeGeneration: requiredNumber(state, "runtime_generation"),
    },
    configInventory: {
      objectCount: requiredNumber(state, "config_object_count"),
      digest: requiredBytes(state, "config_inventory_digest"),
    },
    configObjects: configObjects.map((row) => ({
      agentId: requiredString(row, "agent_id"),
      objectId: requiredString(row, "object_id"),
      configRevision: requiredNumber(row, "config_revision"),
      runtimeGeneration: requiredNumber(row, "runtime_generation"),
      wrappedDekHash: requiredBytes(row, "wrapped_dek_hash"),
      wrappedDekBytes: requiredBytes(row, "wrapped_dek_bytes"),
    })),
    domainEnvelopes: domainEnvelopes.map((row) => ({
      agentId: requiredString(row, "agent_id"),
      domainId: requiredString(row, "domain_id"),
      domainEpoch: requiredNumber(row, "domain_epoch"),
      agentAuthorizationRevision: requiredNumber(
        row,
        "agent_authorization_revision",
      ),
      runtimeGeneration: requiredNumber(row, "runtime_generation"),
      committerDeviceId: requiredString(row, "committer_device_id"),
      envelopeHash: requiredBytes(row, "envelope_hash"),
      envelopeBytes: requiredBytes(row, "envelope_bytes"),
    })),
    challengeConsumptions: challenges.map((row) => ({
      challengeHash: requiredBytes(row, "challenge_hash"),
      consumed: requiredBoolean(row, "consumed"),
    })),
  } as unknown as AgentRuntimeAtomicStorageWireV2);
}

export function grantFromRow(row: DatabaseRow): GrantWireRecordV2 {
  return storageAdapterSupportV2.validateGrant({
    grantId: requiredString(row, "grant_id"),
    grantBytes: requiredBytes(row, "grant_bytes"),
    consumed: requiredBoolean(row, "consumed"),
  });
}

export function recoveryFromRow(row: DatabaseRow): RecoveryArchiveWireRecordV2 {
  return storageAdapterSupportV2.validateRecoveryArchive({
    humanId: requiredString(row, "human_id"),
    recoveryKeyGeneration: requiredNumber(row, "recovery_key_generation"),
    archiveBytes: requiredBytes(row, "archive_bytes"),
  });
}
