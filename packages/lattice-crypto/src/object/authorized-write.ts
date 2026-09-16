import type {
  ObjectAccessManifestStorageHeadV2,
  ObjectAccessStorageStateV2,
} from "../storage/v2-records.ts";
import {
  assertOpaqueBytes,
  cloneOpaqueBytes,
  copyOwnedBytesV2,
  type OpaqueByteKind,
  type OpaqueBytes,
} from "../v2-types/opaque.ts";
import type {
  HumanObjectAccessGenesisPersistenceAuthorizationContextV5,
  ObjectAccessGenesisPersistenceAuthorizationContextV2,
  ObjectAccessUpdatePersistenceAuthorizationContextV2,
} from "./storage-coordinator.ts";
import type {
  AgentObjectAccessGenesisAuthorityContextV3,
  DeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorityContextV1,
} from "./agent-access-manifest.ts";
import type {
  DeviceWrappedAgentObjectAccessGenesisSetAuthorityContextV1,
} from "./device-wrapped-agent-access-manifest-set-v1.ts";
import type {
  AgentRuntimeSignerPublicationV1,
} from "../agent-runtime/signer-publication-v1.ts";

declare const authorizedObjectAccessWriteBrand: unique symbol;

export interface ObjectAccessGenesisAuthorizationExpectationV2 {
  readonly kind: "genesis";
  readonly context: ObjectAccessGenesisPersistenceAuthorizationContextV2;
  readonly currentHostAuthorizationRevision: number;
  readonly committerSigningPublicKeyHash: Uint8Array;
}

export interface ObjectAccessUpdateAuthorizationExpectationV2 {
  readonly kind: "update";
  readonly context: ObjectAccessUpdatePersistenceAuthorizationContextV2;
  readonly currentManifestHostAuthorizationRevision: number;
  readonly currentHostAuthorizationRevision: number;
  readonly currentCommitterSigningPublicKeyHash: Uint8Array;
  readonly nextCommitterSigningPublicKeyHash: Uint8Array;
}

export interface HumanObjectAccessGenesisAuthorizationExpectationV5 {
  readonly kind: "human-v5-genesis";
  readonly context: HumanObjectAccessGenesisPersistenceAuthorizationContextV5;
  readonly currentHostAuthorizationRevision: number;
  readonly committerSigningPublicKeyHash: Uint8Array;
}

export interface AgentObjectAccessGenesisAuthorizationExpectationV3 {
  readonly kind: "agent-genesis";
  readonly context: AgentObjectAccessGenesisAuthorityContextV3;
  readonly signerPublication: AgentRuntimeSignerPublicationV1;
  readonly signerPublicationHash: Uint8Array;
  readonly signerPublicKeyHash: Uint8Array;
  readonly managerSigningPublicKeyHash: Uint8Array;
}

export interface DeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorizationExpectationV1 {
  readonly kind: "device-wrapped-live-shadow-agent-genesis";
  readonly context:
    DeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorityContextV1;
  readonly signerPublicKey: Uint8Array;
  readonly signerPublicKeyHash: Uint8Array;
}

export interface DeviceWrappedAgentObjectAccessGenesisSetAuthorizationExpectationV1 {
  readonly kind: "device-wrapped-live-shadow-agent-genesis-set";
  readonly context:
    DeviceWrappedAgentObjectAccessGenesisSetAuthorityContextV1;
  readonly signerPublicKey: Uint8Array;
  readonly signerPublicKeyHash: Uint8Array;
}

export type ObjectAccessAuthorizationExpectationV2 =
  | ObjectAccessGenesisAuthorizationExpectationV2
  | HumanObjectAccessGenesisAuthorizationExpectationV5
  | ObjectAccessUpdateAuthorizationExpectationV2
  | AgentObjectAccessGenesisAuthorizationExpectationV3
  | DeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorizationExpectationV1
  | DeviceWrappedAgentObjectAccessGenesisSetAuthorizationExpectationV1;

/**
 * Process-local proof that one object-access state write passed fresh host
 * authorization and exact committer-signature verification.
 *
 * The public snapshot lets a durable adapter execute the CAS without crypto
 * dependencies. The nominal brand and private one-shot provenance prevent
 * supported callers from constructing or replaying this proof.
 */
export type AuthorizedObjectAccessWriteV2 = Readonly<{
  readonly expected: ObjectAccessManifestStorageHeadV2 | null;
  readonly intended: ObjectAccessStorageStateV2;
  readonly authorization: ObjectAccessAuthorizationExpectationV2;
  readonly [authorizedObjectAccessWriteBrand]: true;
}>;

export interface AuthorizedObjectAccessWriteSnapshotV2 {
  readonly expected: ObjectAccessManifestStorageHeadV2 | null;
  readonly intended: ObjectAccessStorageStateV2;
  readonly authorization: ObjectAccessAuthorizationExpectationV2;
}

const authorizedObjectAccessWrites = new WeakMap<
  object,
  AuthorizedObjectAccessWriteSnapshotV2
>();

function assertAuthenticObjectEnvelopeFields(
  intended: ObjectAccessStorageStateV2,
): void {
  const candidate = Object(intended) as Record<string, unknown>;
  if (!Array.isArray(candidate["namespaceEnvelopes"])) return;
  for (const envelope of candidate["namespaceEnvelopes"]) {
    const record = Object(envelope) as Record<string, unknown>;
    assertOpaqueBytes(
      "Namespace object envelope",
      record["envelopeBytes"],
      "namespace-object-envelope",
    );
  }
}

function cloneSnapshot(
  input: Readonly<{
    readonly expected: ObjectAccessManifestStorageHeadV2 | null;
    readonly intended: ObjectAccessStorageStateV2;
    readonly authorization: ObjectAccessAuthorizationExpectationV2;
  }>,
): AuthorizedObjectAccessWriteSnapshotV2 {
  return cloneValue(input) as AuthorizedObjectAccessWriteSnapshotV2;
}

function cloneValue<T>(value: T): T {
  if (value instanceof Uint8Array) return copyOwnedBytesV2(value) as T;
  if (Array.isArray(value)) {
    const entries = value as readonly unknown[];
    return entries.map((entry) => cloneValue<unknown>(entry)) as T;
  }
  if (typeof value !== "object" || value === null) return value;
  const candidate = value as Record<string, unknown>;
  // Any value claiming the opaque classification must carry prior provenance.
  // A broader branch only routes malformed values into cloneOpaqueBytes,
  // which rejects them rather than widening authorization.
  const hasOpaqueClassification =
    candidate["classification"] === "opaque-ciphertext";
  if (
    hasOpaqueClassification
    && candidate["ciphertext"] instanceof Uint8Array
  ) {
    return cloneOpaqueBytes(
      value as unknown as OpaqueBytes<OpaqueByteKind>,
    ) as T;
  }
  return Object.fromEntries(
    Object.entries(candidate).map(([field, child]) => [
      field,
      cloneValue(child),
    ]),
  ) as T;
}

function freezeCapabilityShape(value: unknown): void {
  if (value instanceof Uint8Array) {
    Object.preventExtensions(value);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const child of Object.values(value)) {
    freezeCapabilityShape(child);
  }
  Object.freeze(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return Uint8Array.prototype.every.call(
    left,
    (byte, index) => byte === right[index],
  );
}

/**
 * Every containing object is recursively frozen at mint time. The only
 * remaining mutable surface is the indexed content of each Uint8Array.
 */
function mutableBytesAreUnchanged(
  value: unknown,
  snapshot: unknown,
): boolean {
  if (snapshot instanceof Uint8Array) {
    return value instanceof Uint8Array && equalBytes(value, snapshot);
  }
  if (typeof snapshot !== "object" || snapshot === null) return true;
  return Object.keys(snapshot).every((field) =>
    mutableBytesAreUnchanged(
      (value as Record<string, unknown>)[field],
      (snapshot as Record<string, unknown>)[field],
    )
  );
}

/** Internal minting boundary; production callers must first verify auth. */
export function authorizeObjectAccessWriteV2(
  input: Readonly<{
    readonly expected: ObjectAccessManifestStorageHeadV2 | null;
    readonly intended: ObjectAccessStorageStateV2;
    readonly authorization: ObjectAccessAuthorizationExpectationV2;
  }>,
): AuthorizedObjectAccessWriteV2 {
  assertAuthenticObjectEnvelopeFields(input.intended);
  const snapshot = cloneSnapshot(input);
  const authorized = cloneSnapshot(snapshot) as AuthorizedObjectAccessWriteV2;
  freezeCapabilityShape(authorized);
  authorizedObjectAccessWrites.set(authorized, snapshot);
  return authorized;
}

/**
 * Authenticate, consume, and detach a single write before the storage decision.
 * An ambiguous outcome requires a fresh authorization and a new capability.
 */
export function consumeAuthorizedObjectAccessWriteV2(
  value: AuthorizedObjectAccessWriteV2,
): AuthorizedObjectAccessWriteSnapshotV2 {
  const snapshot = authorizedObjectAccessWrites.get(value as object);
  authorizedObjectAccessWrites.delete(value as object);
  if (
    snapshot === undefined
    || !mutableBytesAreUnchanged(value, snapshot)
  ) {
    throw new TypeError(
      "Object access CAS requires an authorized object access write capability",
    );
  }
  return cloneSnapshot(snapshot);
}
