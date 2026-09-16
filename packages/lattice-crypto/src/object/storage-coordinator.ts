import type { LatticeCrypto } from "../crypto/index.ts";
import {
  decodeObjectAccessManifestV2,
  encodeObjectAccessManifestV2,
  objectAccessManifestSigningBytesV2,
} from "../format/object-access-manifest-v2.ts";
import {
  decodeObjectAccessManifestV5,
  encodeObjectAccessManifestV5,
  objectAccessManifestSigningBytesV5,
} from "../format/object-access-manifest-v5.ts";
import {
  decodeObjectAccessStorageManifest,
} from "../format/object-access-manifest.ts";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  encodeNamespaceObjectEnvelopeV2,
} from "../format/object-v2.ts";
import type {
  PreparedObjectAccessManifestGenesisV2,
  PreparedObjectAccessManifestUpdateV2,
} from "./access-manifest.ts";
import {
  assertAuthenticPreparedObjectAccessManifestGenesisV2,
  assertAuthenticPreparedObjectAccessManifestUpdateV2,
} from "./access-manifest.ts";
import {
  assertAuthenticPreparedHumanObjectAccessManifestGenesisSetV1,
  type PreparedHumanObjectAccessManifestGenesisSetV1,
} from "./human-access-manifest-set-v1.ts";
import type {
  EncryptedObjectWireRecordV2,
  ObjectAccessManifestStorageHeadV2,
  ObjectAccessStateCasStatusV2,
  ObjectAccessStorageStateV2,
  ObjectAccessStorageWireStateV2,
} from "../storage/v2-records.ts";
import { compareUnsignedUtf8 } from "../domain/participants.ts";
import { authorizationRevision } from "../v2-types/ids.ts";
import { V2_LIMITS, assertV2Limit } from "../v2-types/limits.ts";
import {
  copyOwnedBytesV2,
  opaqueBytes,
} from "../v2-types/opaque.ts";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  authorizeObjectAccessWriteV2,
  type AuthorizedObjectAccessWriteV2,
} from "./authorized-write.ts";

const HASH_BYTES = 32;

export interface ObjectAccessStateCasStorageV2 {
  getObject(
    objectId: string,
  ): Promise<EncryptedObjectWireRecordV2 | null>;
  /**
   * A product adapter MUST compare the carried authorization context with
   * authoritative object/Namespace authorization in the same transaction as
   * this CAS, returning `stale` when authority changed.
   */
  compareAndSwapObjectAccessState(
    authorized: AuthorizedObjectAccessWriteV2,
  ): Promise<ObjectAccessStateCasStatusV2>;
}

export interface ObjectAccessUpdateStateCasStorageV2
  extends ObjectAccessStateCasStorageV2 {
  getObjectAccessState(
    objectId: string,
  ): Promise<ObjectAccessStorageWireStateV2 | null>;
}

function validatedObjectWireRecordV2(
  object: EncryptedObjectWireRecordV2,
): EncryptedObjectWireRecordV2 {
  assertExactFields("persisted encrypted object", object, [
    "objectId",
    "payloadBytes",
  ]);
  if (!(object.payloadBytes instanceof Uint8Array)) {
    throw new TypeError("persisted encrypted payload must be Uint8Array");
  }
  assertV2Limit(
    "persisted encrypted payload bytes",
    object.payloadBytes.length,
    V2_LIMITS.ciphertextBytes,
  );
  const payload = decodeEncryptedPayloadV2(object.payloadBytes);
  if (payload.context.objectId !== object.objectId) {
    throw new Error(
      "persisted encrypted object does not match canonical payload bytes",
    );
  }
  return Object.freeze({
    objectId: payload.context.objectId,
    payloadBytes: copyOwnedBytesV2(object.payloadBytes),
  });
}

/**
 * Fresh host decision supplied at the CAS boundary. The crypto core cannot
 * infer product authorization; it requires both sides to be rechecked and
 * binds that result to the signed authorization revision.
 */
export interface ObjectAccessUpdatePersistenceAuthorizationContextV2 {
  readonly purpose: "persist-object-access-update";
  readonly operation: "attach" | "detach";
  readonly objectId: string;
  readonly payloadHash: Uint8Array;
  readonly currentHead: ObjectAccessManifestStorageHeadV2;
  readonly nextHead: ObjectAccessManifestStorageHeadV2;
  readonly currentEnvelopes:
    readonly ObjectAccessGenesisEnvelopeAuthorizationContextV2[];
  readonly nextEnvelopes:
    readonly ObjectAccessGenesisEnvelopeAuthorizationContextV2[];
  readonly affectedEnvelope:
    ObjectAccessGenesisEnvelopeAuthorizationContextV2;
  readonly currentCommitterDeviceId: string;
  readonly committerDeviceId: string;
  readonly currentManifestHostAuthorizationRevision: number;
  readonly hostAuthorizationRevision: number;
}

export interface ObjectAccessUpdatePersistenceAuthorizationDecisionV2
  extends ObjectAccessUpdatePersistenceAuthorizationContextV2 {
  readonly sourceAuthorized: boolean;
  readonly targetAuthorized: boolean;
  readonly currentHostAuthorizationRevision: number;
  readonly currentHeadCommitterSigningPublicKey: Uint8Array;
  readonly nextHeadCommitterSigningPublicKey: Uint8Array;
}

export type ResolveCurrentObjectAccessUpdateAuthorizationV2 = (
  context: ObjectAccessUpdatePersistenceAuthorizationContextV2,
) =>
  | ObjectAccessUpdatePersistenceAuthorizationDecisionV2
  | null
  | Promise<ObjectAccessUpdatePersistenceAuthorizationDecisionV2 | null>;

export interface ObjectAccessPersistenceAuthorizationV2 {
  readonly resolveCurrentAuthorization:
    ResolveCurrentObjectAccessUpdateAuthorizationV2;
}

export interface ObjectAccessGenesisPersistenceAuthorizationContextV2 {
  readonly purpose: "persist-object-access-genesis";
  readonly objectId: string;
  readonly payloadHash: Uint8Array;
  readonly envelopes:
    readonly ObjectAccessGenesisEnvelopeAuthorizationContextV2[];
  readonly committerDeviceId: string;
  readonly hostAuthorizationRevision: number;
}

export interface ObjectAccessGenesisEnvelopeAuthorizationContextV2 {
  readonly objectId: string;
  readonly namespaceId: string;
  readonly keyClass: "human" | "ai";
  readonly keyGeneration: number;
  readonly bindingRevisionAtWrap: number;
  readonly envelopeHash: Uint8Array;
}

export interface ObjectAccessGenesisPersistenceAuthorizationV2
  extends ObjectAccessGenesisPersistenceAuthorizationContextV2 {
  readonly sourceAuthorized: boolean;
  readonly targetAuthorized: boolean;
  readonly currentHostAuthorizationRevision: number;
  readonly committerSigningPublicKey: Uint8Array;
}

export type ResolveCurrentObjectAccessGenesisAuthorizationV2 = (
  context: ObjectAccessGenesisPersistenceAuthorizationContextV2,
) =>
  | ObjectAccessGenesisPersistenceAuthorizationV2
  | null
  | Promise<ObjectAccessGenesisPersistenceAuthorizationV2 | null>;

export interface HumanObjectAccessGenesisPersistenceAuthorizationContextV5 {
  readonly purpose: "persist-human-object-access-genesis-v5";
  readonly objectId: string;
  readonly payloadHash: Uint8Array;
  readonly envelopes:
    readonly ObjectAccessGenesisEnvelopeAuthorizationContextV2[];
  readonly subjectHumanId: string;
  readonly committerDeviceId: string;
  readonly hostAuthorizationRevision: number;
}

export interface HumanObjectAccessGenesisPersistenceAuthorizationV5
  extends HumanObjectAccessGenesisPersistenceAuthorizationContextV5 {
  readonly sourceAuthorized: boolean;
  readonly targetAuthorized: boolean;
  readonly currentHostAuthorizationRevision: number;
  readonly committerSigningPublicKey: Uint8Array;
}

export type ResolveCurrentHumanObjectAccessGenesisAuthorizationV5 = (
  context: HumanObjectAccessGenesisPersistenceAuthorizationContextV5,
) =>
  | HumanObjectAccessGenesisPersistenceAuthorizationV5
  | null
  | Promise<HumanObjectAccessGenesisPersistenceAuthorizationV5 | null>;

export class ObjectAccessPersistenceOutcomeUnknownV2 extends Error {
  override readonly name = "ObjectAccessPersistenceOutcomeUnknownV2";

  constructor(cause: unknown) {
    super(
      "Object access storage outcome is ambiguous; retry must be explicit",
      { cause },
    );
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return bytesToHex(left) === bytesToHex(right);
}

function compareHashes(left: Uint8Array, right: Uint8Array): number {
  return compareUnsignedUtf8(bytesToHex(left), bytesToHex(right));
}

function validatedObjectAccessStateCasStatus(
  status: ObjectAccessStateCasStatusV2,
): ObjectAccessStateCasStatusV2 {
  if (
    status !== "applied"
    && status !== "duplicate"
    && status !== "stale"
  ) {
    throw new TypeError(
      "object access storage returned an invalid status",
    );
  }
  return status;
}

function cloneGenesisEnvelopeAuthorizationContext(
  value: ObjectAccessGenesisEnvelopeAuthorizationContextV2,
): ObjectAccessGenesisEnvelopeAuthorizationContextV2 {
  assertExactFields("object access genesis authorized envelope", value, [
    "objectId",
    "namespaceId",
    "keyClass",
    "keyGeneration",
    "bindingRevisionAtWrap",
    "envelopeHash",
  ]);
  if (
    typeof value.objectId !== "string"
    || typeof value.namespaceId !== "string"
    || (value.keyClass !== "human" && value.keyClass !== "ai")
    || !Number.isSafeInteger(value.keyGeneration)
    || value.keyGeneration < 0
    || !Number.isSafeInteger(value.bindingRevisionAtWrap)
    || value.bindingRevisionAtWrap < 0
  ) {
    throw new TypeError(
      "object access genesis authorized envelope coordinates are invalid",
    );
  }
  assertHash("object access genesis authorized envelope hash", value.envelopeHash);
  return Object.freeze({
    objectId: value.objectId,
    namespaceId: value.namespaceId,
    keyClass: value.keyClass,
    keyGeneration: value.keyGeneration,
    bindingRevisionAtWrap: value.bindingRevisionAtWrap,
    envelopeHash: copyOwnedBytesV2(value.envelopeHash),
  });
}

function cloneGenesisAuthorizationContext(
  value: ObjectAccessGenesisPersistenceAuthorizationContextV2,
): ObjectAccessGenesisPersistenceAuthorizationContextV2 {
  if (
    value.purpose !== "persist-object-access-genesis"
    || typeof value.objectId !== "string"
    || typeof value.committerDeviceId !== "string"
    || !Number.isSafeInteger(value.hostAuthorizationRevision)
    || value.hostAuthorizationRevision < 0
  ) {
    throw new TypeError(
      "object access genesis authorization context is invalid",
    );
  }
  assertHash("object access genesis authorization payload hash", value.payloadHash);
  return Object.freeze({
    purpose: value.purpose,
    objectId: value.objectId,
    payloadHash: copyOwnedBytesV2(value.payloadHash),
    envelopes: Object.freeze(
      value.envelopes.map(cloneGenesisEnvelopeAuthorizationContext),
    ),
    committerDeviceId: value.committerDeviceId,
    hostAuthorizationRevision: value.hostAuthorizationRevision,
  });
}

function cloneHumanGenesisAuthorizationContext(
  value: HumanObjectAccessGenesisPersistenceAuthorizationContextV5,
): HumanObjectAccessGenesisPersistenceAuthorizationContextV5 {
  if (
    value.purpose !== "persist-human-object-access-genesis-v5"
    || typeof value.objectId !== "string"
    || typeof value.subjectHumanId !== "string"
    || typeof value.committerDeviceId !== "string"
    || !Number.isSafeInteger(value.hostAuthorizationRevision)
    || value.hostAuthorizationRevision < 0
  ) throw new TypeError(
    "Human v5 object access genesis authorization context is invalid",
  );
  assertHash(
    "Human v5 object access genesis authorization payload hash",
    value.payloadHash,
  );
  return Object.freeze({
    purpose: value.purpose,
    objectId: value.objectId,
    payloadHash: copyOwnedBytesV2(value.payloadHash),
    envelopes: Object.freeze(
      value.envelopes.map(cloneGenesisEnvelopeAuthorizationContext),
    ),
    subjectHumanId: value.subjectHumanId,
    committerDeviceId: value.committerDeviceId,
    hostAuthorizationRevision: value.hostAuthorizationRevision,
  });
}

function humanGenesisAuthorizationContextsEqual(
  left: HumanObjectAccessGenesisPersistenceAuthorizationContextV5,
  right: HumanObjectAccessGenesisPersistenceAuthorizationContextV5,
): boolean {
  return left.subjectHumanId === right.subjectHumanId
    && genesisAuthorizationContextsEqual(
      {
        purpose: "persist-object-access-genesis",
        objectId: left.objectId,
        payloadHash: left.payloadHash,
        envelopes: left.envelopes,
        committerDeviceId: left.committerDeviceId,
        hostAuthorizationRevision: left.hostAuthorizationRevision,
      },
      {
        purpose: "persist-object-access-genesis",
        objectId: right.objectId,
        payloadHash: right.payloadHash,
        envelopes: right.envelopes,
        committerDeviceId: right.committerDeviceId,
        hostAuthorizationRevision: right.hostAuthorizationRevision,
      },
    );
}

function genesisAuthorizationContextsEqual(
  left: ObjectAccessGenesisPersistenceAuthorizationContextV2,
  right: ObjectAccessGenesisPersistenceAuthorizationContextV2,
): boolean {
  return left.objectId === right.objectId
    && equalBytes(left.payloadHash, right.payloadHash)
    && left.committerDeviceId === right.committerDeviceId
    && left.hostAuthorizationRevision === right.hostAuthorizationRevision
    && left.envelopes.length === right.envelopes.length
    && left.envelopes.every((envelope, index) => {
      const candidate = right.envelopes[index]!;
      return envelope.objectId === candidate.objectId
        && envelope.namespaceId === candidate.namespaceId
        && envelope.keyClass === candidate.keyClass
        && envelope.keyGeneration === candidate.keyGeneration
        && envelope.bindingRevisionAtWrap
          === candidate.bindingRevisionAtWrap
        && equalBytes(envelope.envelopeHash, candidate.envelopeHash);
    });
}

function envelopeAuthorizationContexts(
  crypto: LatticeCrypto,
  envelopeBytes: readonly Uint8Array[],
): readonly ObjectAccessGenesisEnvelopeAuthorizationContextV2[] {
  return Object.freeze(
    envelopeBytes.map((bytes) => {
      const envelope = decodeNamespaceObjectEnvelopeV2(bytes);
      return cloneGenesisEnvelopeAuthorizationContext({
        objectId: envelope.context.objectId,
        namespaceId: envelope.context.namespaceId,
        keyClass: envelope.context.keyClass,
        keyGeneration: envelope.context.keyGeneration,
        bindingRevisionAtWrap: envelope.context.bindingRevisionAtWrap,
        envelopeHash: crypto.hash(bytes),
      });
    }).sort((left, right) =>
      compareUnsignedUtf8(left.namespaceId, right.namespaceId)
    ),
  );
}

function cloneAuthorizationHead(
  value: ObjectAccessManifestStorageHeadV2,
): ObjectAccessManifestStorageHeadV2 {
  assertExactFields("object access authorization head", value, [
    "objectId",
    "accessRevision",
    "manifestHash",
    "manifestBytes",
  ]);
  if (
    typeof value.objectId !== "string"
    || !Number.isSafeInteger(value.accessRevision)
    || value.accessRevision < 0
    || !(value.manifestBytes instanceof Uint8Array)
  ) {
    throw new TypeError("object access authorization head is invalid");
  }
  assertHash("object access authorization head hash", value.manifestHash);
  return Object.freeze({
    objectId: value.objectId,
    accessRevision: value.accessRevision,
    manifestHash: copyOwnedBytesV2(value.manifestHash),
    manifestBytes: copyOwnedBytesV2(value.manifestBytes),
  });
}

function headsEqual(
  left: ObjectAccessManifestStorageHeadV2,
  right: ObjectAccessManifestStorageHeadV2,
): boolean {
  return left.objectId === right.objectId
    && left.accessRevision === right.accessRevision
    && equalBytes(left.manifestHash, right.manifestHash)
    && equalBytes(left.manifestBytes, right.manifestBytes);
}

function cloneUpdateAuthorizationContext(
  value: ObjectAccessUpdatePersistenceAuthorizationContextV2,
): ObjectAccessUpdatePersistenceAuthorizationContextV2 {
  if (
    value.purpose !== "persist-object-access-update"
    || (value.operation !== "attach" && value.operation !== "detach")
    || typeof value.objectId !== "string"
    || typeof value.currentCommitterDeviceId !== "string"
    || typeof value.committerDeviceId !== "string"
    || !Number.isSafeInteger(value.currentManifestHostAuthorizationRevision)
    || value.currentManifestHostAuthorizationRevision < 0
    || !Number.isSafeInteger(value.hostAuthorizationRevision)
    || value.hostAuthorizationRevision < 0
    || !Array.isArray(value.currentEnvelopes as unknown)
    || !Array.isArray(value.nextEnvelopes as unknown)
  ) {
    throw new TypeError(
      "object access update authorization context is invalid",
    );
  }
  assertHash("object access update authorization payload hash", value.payloadHash);
  return Object.freeze({
    purpose: value.purpose,
    operation: value.operation,
    objectId: value.objectId,
    payloadHash: copyOwnedBytesV2(value.payloadHash),
    currentHead: cloneAuthorizationHead(value.currentHead),
    nextHead: cloneAuthorizationHead(value.nextHead),
    currentEnvelopes: Object.freeze(
      value.currentEnvelopes.map(
        cloneGenesisEnvelopeAuthorizationContext,
      ),
    ),
    nextEnvelopes: Object.freeze(
      value.nextEnvelopes.map(cloneGenesisEnvelopeAuthorizationContext),
    ),
    affectedEnvelope: cloneGenesisEnvelopeAuthorizationContext(
      value.affectedEnvelope,
    ),
    currentCommitterDeviceId: value.currentCommitterDeviceId,
    committerDeviceId: value.committerDeviceId,
    currentManifestHostAuthorizationRevision:
      value.currentManifestHostAuthorizationRevision,
    hostAuthorizationRevision: value.hostAuthorizationRevision,
  });
}

function updateAuthorizationContextsEqual(
  left: ObjectAccessUpdatePersistenceAuthorizationContextV2,
  right: ObjectAccessUpdatePersistenceAuthorizationContextV2,
): boolean {
  return left.operation === right.operation
    && left.objectId === right.objectId
    && equalBytes(left.payloadHash, right.payloadHash)
    && headsEqual(left.currentHead, right.currentHead)
    && headsEqual(left.nextHead, right.nextHead)
    && left.currentCommitterDeviceId === right.currentCommitterDeviceId
    && left.committerDeviceId === right.committerDeviceId
    && left.currentManifestHostAuthorizationRevision
      === right.currentManifestHostAuthorizationRevision
    && left.hostAuthorizationRevision === right.hostAuthorizationRevision
    && genesisEnvelopeContextsEqual(
      left.currentEnvelopes,
      right.currentEnvelopes,
    )
    && genesisEnvelopeContextsEqual(
      left.nextEnvelopes,
      right.nextEnvelopes,
    )
    && genesisEnvelopeContextsEqual(
      [left.affectedEnvelope],
      [right.affectedEnvelope],
    );
}

function genesisEnvelopeContextsEqual(
  left: readonly ObjectAccessGenesisEnvelopeAuthorizationContextV2[],
  right: readonly ObjectAccessGenesisEnvelopeAuthorizationContextV2[],
): boolean {
  return left.length === right.length
    && left.every((envelope, index) => {
      const candidate = right[index]!;
      return envelope.objectId === candidate.objectId
        && envelope.namespaceId === candidate.namespaceId
        && envelope.keyClass === candidate.keyClass
        && envelope.keyGeneration === candidate.keyGeneration
        && envelope.bindingRevisionAtWrap
          === candidate.bindingRevisionAtWrap
        && equalBytes(envelope.envelopeHash, candidate.envelopeHash);
    });
}

function assertExactFields(
  label: string,
  value: unknown,
  expected: readonly string[],
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${label} must be an object`);
  }
  const fields = Object.keys(value);
  if (
    fields.length !== expected.length
    || fields.some((field) => !expected.includes(field))
  ) {
    throw new TypeError(`${label} has an invalid field set`);
  }
}

function assertHash(label: string, value: unknown): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== HASH_BYTES) {
    throw new TypeError(`${label} must be exactly ${HASH_BYTES} bytes`);
  }
}

/**
 * Enforce cheap allocation/count limits before decoding or hashing any
 * attacker-controlled manifest or envelope bytes.
 */
function preflightWireInventory(
  manifestBytes: unknown,
  envelopeBytes: unknown,
): asserts envelopeBytes is readonly Uint8Array[] {
  if (!(manifestBytes instanceof Uint8Array)) {
    throw new TypeError("object access manifest must be Uint8Array");
  }
  assertV2Limit(
    "object access manifest bytes",
    manifestBytes.length,
    V2_LIMITS.ciphertextBytes,
  );
  if (!Array.isArray(envelopeBytes)) {
    throw new TypeError("Namespace envelope inventory must be an array");
  }
  assertV2Limit(
    "Namespace envelope count",
    envelopeBytes.length,
    V2_LIMITS.namespaceEnvelopesPerManifest,
  );
  let aggregateBytes = 0;
  for (const envelope of envelopeBytes) {
    if (!(envelope instanceof Uint8Array)) {
      throw new TypeError("Namespace envelope must be Uint8Array");
    }
    aggregateBytes += envelope.length;
    assertV2Limit(
      "manifest envelope bytes",
      aggregateBytes,
      V2_LIMITS.manifestEnvelopeBytes,
    );
  }
}

function validatedHeadV2(
  crypto: LatticeCrypto,
  head: ObjectAccessManifestStorageHeadV2,
): ObjectAccessManifestStorageHeadV2 {
  assertExactFields("object access storage head", head, [
    "objectId",
    "accessRevision",
    "manifestHash",
    "manifestBytes",
  ]);
  preflightWireInventory(head.manifestBytes, []);
  assertHash("object access manifest hash", head.manifestHash);
  const manifest = decodeObjectAccessStorageManifest(head.manifestBytes);
  if (
    manifest.objectId !== head.objectId
    || manifest.accessRevision !== head.accessRevision
    || !equalBytes(crypto.hash(head.manifestBytes), head.manifestHash)
  ) {
    throw new Error(
      "expected object access head does not match its canonical manifest",
    );
  }
  return Object.freeze({
    objectId: manifest.objectId,
    accessRevision: manifest.accessRevision,
    manifestHash: copyOwnedBytesV2(head.manifestHash),
    manifestBytes: copyOwnedBytesV2(head.manifestBytes),
  });
}

/**
 * Convert canonical wire bytes into the only object-access state accepted by
 * the storage seam. The signed manifest is public; wrapped DEKs are explicitly
 * classified as opaque ciphertext.
 */
export function objectAccessStorageStateV2(
  crypto: LatticeCrypto,
  manifestBytes: Uint8Array,
  envelopeBytes: readonly Uint8Array[],
): ObjectAccessStorageStateV2 {
  preflightWireInventory(manifestBytes, envelopeBytes);
  const manifest = decodeObjectAccessStorageManifest(manifestBytes);
  const manifestHash = crypto.hash(manifestBytes);
  const namespaceIds = new Set<string>();
  const envelopes = envelopeBytes.map((bytes) => {
    const envelope = decodeNamespaceObjectEnvelopeV2(bytes);
    if (
      !equalBytes(encodeNamespaceObjectEnvelopeV2(envelope), bytes)
      || envelope.context.objectId !== manifest.objectId
    ) {
      throw new Error("Namespace envelope object does not match manifest");
    }
    if (namespaceIds.has(envelope.context.namespaceId)) {
      throw new Error("duplicate Namespace envelope in object inventory");
    }
    namespaceIds.add(envelope.context.namespaceId);
    return {
      namespaceId: envelope.context.namespaceId,
      envelopeHash: copyOwnedBytesV2(crypto.hash(bytes)),
      envelopeBytes: opaqueBytes("namespace-object-envelope", bytes),
    };
  }).sort((left, right) =>
    compareHashes(left.envelopeHash, right.envelopeHash)
  );
  for (let index = 1; index < envelopes.length; index += 1) {
    if (
      equalBytes(
        envelopes[index - 1]!.envelopeHash,
        envelopes[index]!.envelopeHash,
      )
    ) {
      throw new Error("duplicate Namespace envelope hash in object inventory");
    }
  }
  if (manifest.envelopeHashes.length !== envelopes.length) {
    throw new Error("Namespace envelope inventory does not match manifest");
  }
  for (let index = 0; index < envelopes.length; index += 1) {
    if (
      !equalBytes(
        manifest.envelopeHashes[index]!,
        envelopes[index]!.envelopeHash,
      )
    ) {
      throw new Error("Namespace envelope inventory does not match manifest");
    }
  }
  return Object.freeze({
    head: Object.freeze({
      objectId: manifest.objectId,
      accessRevision: manifest.accessRevision,
      manifestHash: copyOwnedBytesV2(manifestHash),
      manifestBytes: copyOwnedBytesV2(manifestBytes),
    }),
    namespaceEnvelopes: Object.freeze(envelopes),
  });
}

function validatedObjectAccessWireStateV2(
  crypto: LatticeCrypto,
  wire: ObjectAccessStorageWireStateV2,
): ObjectAccessStorageStateV2 {
  assertExactFields("persisted object access state", wire, [
    "head",
    "namespaceEnvelopes",
  ]);
  if (!Array.isArray(wire.namespaceEnvelopes as unknown)) {
    throw new TypeError(
      "persisted object access Namespace envelopes must be an array",
    );
  }
  const head = validatedHeadV2(crypto, wire.head);
  const envelopeBytes = wire.namespaceEnvelopes.map((record) => {
    assertExactFields("persisted object access Namespace envelope", record, [
      "namespaceId",
      "envelopeHash",
      "envelopeBytes",
    ]);
    assertHash(
      "persisted object access Namespace envelope hash",
      record.envelopeHash,
    );
    if (!(record.envelopeBytes instanceof Uint8Array)) {
      throw new TypeError(
        "persisted object access Namespace envelope must be Uint8Array",
      );
    }
    return record.envelopeBytes;
  });
  const state = objectAccessStorageStateV2(
    crypto,
    head.manifestBytes,
    envelopeBytes,
  );
  if (
    state.namespaceEnvelopes.some((record, index) => {
      const persisted = wire.namespaceEnvelopes[index]!;
      return record.namespaceId !== persisted.namespaceId
        || !equalBytes(record.envelopeHash, persisted.envelopeHash);
    })
  ) {
    throw new Error(
      "persisted object access state does not match canonical wire bytes",
    );
  }
  return state;
}

function objectAccessStorageStatesEqual(
  left: ObjectAccessStorageStateV2,
  right: ObjectAccessStorageStateV2,
): boolean {
  return headsEqual(left.head, right.head)
    && left.namespaceEnvelopes.every((record, index) => {
      const candidate = right.namespaceEnvelopes[index]!;
      return record.namespaceId === candidate.namespaceId
        && equalBytes(
          record.envelopeBytes.ciphertext,
          candidate.envelopeBytes.ciphertext,
        );
    });
}

/**
 * Persist a previously prepared manifest transition exactly once.
 *
 * This function deliberately has no retry loop. A thrown/ambiguous storage
 * outcome is surfaced to the caller; a later retry is an explicit host
 * decision and resolves to `duplicate` if the first delivery committed.
 */
export async function persistPreparedObjectAccessManifestUpdateV2(
  crypto: LatticeCrypto,
  storage: ObjectAccessUpdateStateCasStorageV2,
  expected: ObjectAccessManifestStorageHeadV2,
  prepared: PreparedObjectAccessManifestUpdateV2,
  authorization: ObjectAccessPersistenceAuthorizationV2,
): Promise<ObjectAccessStateCasStatusV2> {
  assertAuthenticPreparedObjectAccessManifestUpdateV2(prepared);
  const expectedHead = validatedHeadV2(crypto, expected);
  const intended = objectAccessStorageStateV2(
    crypto,
    prepared.manifestBytes,
    prepared.envelopeBytes,
  );
  if (
    !equalBytes(
      encodeObjectAccessManifestV2(prepared.manifest),
      prepared.manifestBytes,
    )
    || !equalBytes(prepared.manifestHash, intended.head.manifestHash)
  ) {
    throw new Error(
      "prepared object access update does not match intended manifest",
    );
  }
  const expectedManifest = decodeObjectAccessManifestV2(
    expectedHead.manifestBytes,
  );
  if (
    intended.head.objectId !== expectedHead.objectId
    || intended.head.accessRevision !== expectedHead.accessRevision + 1
    || !equalBytes(
      prepared.manifest.previousManifestHash!,
      expectedHead.manifestHash,
    )
    || !equalBytes(
      prepared.manifest.payloadHash,
      expectedManifest.payloadHash,
    )
  ) {
    throw new Error(
      "prepared object access update is not one exact hash-chained revision",
    );
  }
  assertExactFields("object access persistence authorization", authorization, [
    "resolveCurrentAuthorization",
  ]);
  if (typeof authorization.resolveCurrentAuthorization !== "function") {
    throw new TypeError(
      "Current object access update authorization resolver is required",
    );
  }
  const affectedEnvelope = envelopeAuthorizationContexts(
    crypto,
    [prepared.operation.envelopeBytes],
  )[0]!;
  const reconstructedCurrentEnvelopeBytes =
    prepared.operation.type === "attach"
      ? prepared.envelopeBytes.filter((bytes) =>
        !equalBytes(crypto.hash(bytes), affectedEnvelope.envelopeHash)
      )
      : [...prepared.envelopeBytes, prepared.operation.envelopeBytes];
  const expectedState = objectAccessStorageStateV2(
    crypto,
    expectedHead.manifestBytes,
    reconstructedCurrentEnvelopeBytes,
  );
  const rawCurrent = await storage.getObjectAccessState(
    expectedHead.objectId,
  );
  if (rawCurrent === null) return "stale";
  const current = validatedObjectAccessWireStateV2(crypto, rawCurrent);
  if (
    !objectAccessStorageStatesEqual(current, expectedState)
    && !objectAccessStorageStatesEqual(current, intended)
  ) return "stale";
  const currentEnvelopeContexts = envelopeAuthorizationContexts(
    crypto,
    expectedState.namespaceEnvelopes.map(
      (record) => record.envelopeBytes.ciphertext,
    ),
  );
  const nextEnvelopeContexts = envelopeAuthorizationContexts(
    crypto,
    prepared.envelopeBytes,
  );
  const context = cloneUpdateAuthorizationContext({
    purpose: "persist-object-access-update",
    operation: prepared.operation.type,
    objectId: intended.head.objectId,
    payloadHash: prepared.manifest.payloadHash,
    currentHead: expectedHead,
    nextHead: intended.head,
    currentEnvelopes: currentEnvelopeContexts,
    nextEnvelopes: nextEnvelopeContexts,
    affectedEnvelope,
    currentCommitterDeviceId: expectedManifest.committerDeviceId,
    committerDeviceId: prepared.manifest.committerDeviceId,
    currentManifestHostAuthorizationRevision:
      expectedManifest.hostAuthorizationRevision,
    hostAuthorizationRevision:
      prepared.manifest.hostAuthorizationRevision,
  });
  const persistedObject = await storage.getObject(intended.head.objectId);
  const validatedObject = persistedObject === null
    ? null
    : validatedObjectWireRecordV2(persistedObject);
  if (
    validatedObject === null
    || !equalBytes(
      crypto.hash(validatedObject.payloadBytes),
      prepared.manifest.payloadHash,
    )
  ) {
    return "stale";
  }
  const resolved = await authorization.resolveCurrentAuthorization(
    cloneUpdateAuthorizationContext(context),
  );
  if (resolved === null) return "stale";
  assertExactFields(
    "object access update persistence authorization decision",
    resolved,
    [
      "purpose",
      "operation",
      "objectId",
      "payloadHash",
      "currentHead",
      "nextHead",
      "currentEnvelopes",
      "nextEnvelopes",
      "affectedEnvelope",
      "currentCommitterDeviceId",
      "committerDeviceId",
      "currentManifestHostAuthorizationRevision",
      "hostAuthorizationRevision",
      "sourceAuthorized",
      "targetAuthorized",
      "currentHostAuthorizationRevision",
      "currentHeadCommitterSigningPublicKey",
      "nextHeadCommitterSigningPublicKey",
    ],
  );
  const resolvedContext = cloneUpdateAuthorizationContext(resolved);
  if (
    !updateAuthorizationContextsEqual(context, resolvedContext)
    || resolved.sourceAuthorized !== true
    || resolved.targetAuthorized !== true
    || authorizationRevision(
      resolved.currentHostAuthorizationRevision,
    ) !== prepared.manifest.hostAuthorizationRevision
    || !(resolved.currentHeadCommitterSigningPublicKey
      instanceof Uint8Array)
    || resolved.currentHeadCommitterSigningPublicKey.length
      !== V2_LIMITS.signingPublicKeyBytes
    || !(resolved.nextHeadCommitterSigningPublicKey
      instanceof Uint8Array)
    || resolved.nextHeadCommitterSigningPublicKey.length
      !== V2_LIMITS.signingPublicKeyBytes
    || !crypto.verify(
      resolved.currentHeadCommitterSigningPublicKey,
      objectAccessManifestSigningBytesV2(expectedManifest),
      expectedManifest.signature,
    )
    || !crypto.verify(
      resolved.nextHeadCommitterSigningPublicKey,
      objectAccessManifestSigningBytesV2(prepared.manifest),
      prepared.manifest.signature,
    )
  ) {
    return "stale";
  }
  let status: ObjectAccessStateCasStatusV2;
  try {
    status = await storage.compareAndSwapObjectAccessState(
      authorizeObjectAccessWriteV2({
        expected: expectedHead,
        intended,
        authorization: {
          kind: "update",
          context,
          currentManifestHostAuthorizationRevision:
            expectedManifest.hostAuthorizationRevision,
          currentHostAuthorizationRevision:
            resolved.currentHostAuthorizationRevision,
          currentCommitterSigningPublicKeyHash: crypto.hash(
            resolved.currentHeadCommitterSigningPublicKey,
          ),
          nextCommitterSigningPublicKeyHash: crypto.hash(
            resolved.nextHeadCommitterSigningPublicKey,
          ),
        },
      }),
    );
  } catch (cause) {
    throw new ObjectAccessPersistenceOutcomeUnknownV2(cause);
  }
  return validatedObjectAccessStateCasStatus(status);
}

export async function persistPreparedObjectAccessManifestGenesisV2(input: {
  readonly crypto: LatticeCrypto;
  readonly storage: ObjectAccessStateCasStorageV2;
  readonly prepared: PreparedObjectAccessManifestGenesisV2;
  readonly resolveCurrentAuthorization:
    ResolveCurrentObjectAccessGenesisAuthorizationV2;
}): Promise<ObjectAccessStateCasStatusV2> {
  assertAuthenticPreparedObjectAccessManifestGenesisV2(input.prepared);
  if (typeof input.resolveCurrentAuthorization !== "function") {
    throw new TypeError(
      "Current object access genesis authorization resolver is required",
    );
  }
  const intended = objectAccessStorageStateV2(
    input.crypto,
    input.prepared.manifestBytes,
    input.prepared.envelopeBytes,
  );
  const manifest = decodeObjectAccessManifestV2(
    intended.head.manifestBytes,
  );
  if (
    !equalBytes(
      encodeObjectAccessManifestV2(input.prepared.manifest),
      input.prepared.manifestBytes,
    )
  ) {
    throw new Error(
      "prepared object access genesis does not match its canonical manifest",
    );
  }
  const envelopeContexts = envelopeAuthorizationContexts(
    input.crypto,
    input.prepared.envelopeBytes,
  );
  const authorizationContext = cloneGenesisAuthorizationContext({
    purpose: "persist-object-access-genesis" as const,
    objectId: manifest.objectId,
    // The context cloner below performs the single ownership boundary copy.
    payloadHash: manifest.payloadHash,
    envelopes: envelopeContexts,
    committerDeviceId: manifest.committerDeviceId,
    hostAuthorizationRevision: manifest.hostAuthorizationRevision,
  });
  const persistedObject = await input.storage.getObject(manifest.objectId);
  const validatedObject = persistedObject === null
    ? null
    : validatedObjectWireRecordV2(persistedObject);
  if (
    validatedObject === null
    || !equalBytes(
      input.crypto.hash(validatedObject.payloadBytes),
      manifest.payloadHash,
    )
  ) {
    return "stale";
  }
  const resolved = await input.resolveCurrentAuthorization(
    cloneGenesisAuthorizationContext(authorizationContext),
  );
  if (resolved === null) return "stale";
  assertExactFields(
    "object access genesis persistence authorization",
    resolved,
    [
      "purpose",
      "objectId",
      "payloadHash",
      "envelopes",
      "committerDeviceId",
      "hostAuthorizationRevision",
      "sourceAuthorized",
      "targetAuthorized",
      "currentHostAuthorizationRevision",
      "committerSigningPublicKey",
    ],
  );
  if (!Array.isArray(resolved.envelopes as unknown)) {
    throw new TypeError(
      "object access genesis authorized envelopes must be an array",
    );
  }
  const resolvedContext = cloneGenesisAuthorizationContext(resolved);
  if (
    !genesisAuthorizationContextsEqual(
      authorizationContext,
      resolvedContext,
    )
    || resolved.sourceAuthorized !== true
    || resolved.targetAuthorized !== true
    || authorizationRevision(
      resolved.currentHostAuthorizationRevision,
    ) !== manifest.hostAuthorizationRevision
    || !(resolved.committerSigningPublicKey instanceof Uint8Array)
    || resolved.committerSigningPublicKey.length
      !== V2_LIMITS.signingPublicKeyBytes
    || !input.crypto.verify(
      resolved.committerSigningPublicKey,
      objectAccessManifestSigningBytesV2(manifest),
      manifest.signature,
    )
  ) {
    return "stale";
  }
  let status: ObjectAccessStateCasStatusV2;
  try {
    status = await input.storage.compareAndSwapObjectAccessState(
      authorizeObjectAccessWriteV2({
        expected: null,
        intended,
        authorization: {
          kind: "genesis",
          context: authorizationContext,
          currentHostAuthorizationRevision:
            resolved.currentHostAuthorizationRevision,
          committerSigningPublicKeyHash: input.crypto.hash(
            resolved.committerSigningPublicKey,
          ),
        },
      }),
    );
  } catch (cause) {
    throw new ObjectAccessPersistenceOutcomeUnknownV2(cause);
  }
  return validatedObjectAccessStateCasStatus(status);
}

/** Persist one Human-signed common-v5 genesis without widening legacy v2. */
export async function persistPreparedHumanObjectAccessManifestGenesisSetV1(
  input: Readonly<{
    readonly crypto: LatticeCrypto;
    readonly storage: ObjectAccessStateCasStorageV2;
    readonly prepared: PreparedHumanObjectAccessManifestGenesisSetV1;
    readonly resolveCurrentAuthorization:
      ResolveCurrentHumanObjectAccessGenesisAuthorizationV5;
  }>,
): Promise<ObjectAccessStateCasStatusV2> {
  assertAuthenticPreparedHumanObjectAccessManifestGenesisSetV1(input.prepared);
  if (typeof input.resolveCurrentAuthorization !== "function") {
    throw new TypeError(
      "Current Human v5 object access genesis authorization resolver is required",
    );
  }
  const intended = objectAccessStorageStateV2(
    input.crypto,
    input.prepared.manifestBytes,
    input.prepared.envelopeBytes,
  );
  const manifest = decodeObjectAccessManifestV5(intended.head.manifestBytes);
  if (
    manifest.signer.kind !== "human_device"
    || manifest.accessRevision !== 0
    || manifest.previousManifestHash !== null
    || !equalBytes(
      encodeObjectAccessManifestV5(input.prepared.manifest),
      input.prepared.manifestBytes,
    )
  ) throw new Error(
    "prepared Human v5 object access genesis is not canonical",
  );
  const authorizationContext = cloneHumanGenesisAuthorizationContext({
    purpose: "persist-human-object-access-genesis-v5",
    objectId: manifest.objectId,
    payloadHash: manifest.payloadHash,
    envelopes: envelopeAuthorizationContexts(
      input.crypto,
      input.prepared.envelopeBytes,
    ),
    subjectHumanId: manifest.signer.subjectHumanId,
    committerDeviceId: manifest.signer.committerDeviceId,
    hostAuthorizationRevision: manifest.hostAuthorizationRevision,
  });
  if (authorizationContext.envelopes.some((entry) => entry.keyClass !== "ai")) {
    throw new TypeError("Human v5 object access genesis requires AI envelopes");
  }
  const persistedObject = await input.storage.getObject(manifest.objectId);
  const validatedObject = persistedObject === null
    ? null
    : validatedObjectWireRecordV2(persistedObject);
  if (
    validatedObject === null
    || !equalBytes(
      input.crypto.hash(validatedObject.payloadBytes),
      manifest.payloadHash,
    )
  ) return "stale";
  const resolved = await input.resolveCurrentAuthorization(
    cloneHumanGenesisAuthorizationContext(authorizationContext),
  );
  if (resolved === null) return "stale";
  assertExactFields(
    "Human v5 object access genesis persistence authorization",
    resolved,
    [
      "purpose",
      "objectId",
      "payloadHash",
      "envelopes",
      "subjectHumanId",
      "committerDeviceId",
      "hostAuthorizationRevision",
      "sourceAuthorized",
      "targetAuthorized",
      "currentHostAuthorizationRevision",
      "committerSigningPublicKey",
    ],
  );
  if (!Array.isArray(resolved.envelopes as unknown)) {
    throw new TypeError(
      "Human v5 object access genesis authorized envelopes must be an array",
    );
  }
  const resolvedContext = cloneHumanGenesisAuthorizationContext(resolved);
  if (
    !humanGenesisAuthorizationContextsEqual(
      authorizationContext,
      resolvedContext,
    )
    || resolved.sourceAuthorized !== true
    || resolved.targetAuthorized !== true
    || authorizationRevision(resolved.currentHostAuthorizationRevision)
      !== manifest.hostAuthorizationRevision
    || !(resolved.committerSigningPublicKey instanceof Uint8Array)
    || resolved.committerSigningPublicKey.length
      !== V2_LIMITS.signingPublicKeyBytes
    || !input.crypto.verify(
      resolved.committerSigningPublicKey,
      objectAccessManifestSigningBytesV5({
        objectId: manifest.objectId,
        payloadHash: manifest.payloadHash,
        accessRevision: manifest.accessRevision,
        previousManifestHash: manifest.previousManifestHash,
        envelopeHashes: manifest.envelopeHashes,
        signer: manifest.signer,
        signerAuthorizationHash: manifest.signerAuthorizationHash,
        hostAuthorizationRevision: manifest.hostAuthorizationRevision,
      }),
      manifest.signature,
    )
  ) return "stale";
  let status: ObjectAccessStateCasStatusV2;
  try {
    status = await input.storage.compareAndSwapObjectAccessState(
      authorizeObjectAccessWriteV2({
        expected: null,
        intended,
        authorization: {
          kind: "human-v5-genesis",
          context: authorizationContext,
          currentHostAuthorizationRevision:
            resolved.currentHostAuthorizationRevision,
          committerSigningPublicKeyHash: input.crypto.hash(
            resolved.committerSigningPublicKey,
          ),
        },
      }),
    );
  } catch (cause) {
    throw new ObjectAccessPersistenceOutcomeUnknownV2(cause);
  }
  return validatedObjectAccessStateCasStatus(status);
}
