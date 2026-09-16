/** Canonical validation, cloning, comparison, and durable-wire hydration. */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  decodeObjectAccessStorageManifest,
} from "../format/object-access-manifest.ts";
import {
  decodeAgentRuntimeSignerPublicationV1,
  encodeAgentRuntimeSignerPublicationV1,
} from "../agent-runtime/signer-publication-v1.ts";
import {
  parseAgentRuntimeDomainEnvelope,
  serializeAgentRuntimeDomainEnvelope,
} from "../format/agent-runtime-v2.ts";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "../format/object-v2.ts";
import { parseGrantV2, serializeGrantV2 } from "../format/grant-v2.ts";
import { compareUnsignedUtf8 } from "../domain/participants.ts";
import {
  decodeHumanRecoveryArchive,
  serializeHumanRecoveryArchive,
} from "../format/recovery-v2.ts";
import {
  parseNamespaceBinding,
  serializeNamespaceBinding,
} from "../format/namespace-binding-v2.ts";
import {
  parseNamespaceKeyringEnvelope,
  serializeNamespaceKeyringEnvelope,
} from "../format/namespace-keyring-v2.ts";
import {
  concatV2,
  encodeU32,
  encodeU64,
  frame,
  frameText,
} from "../format/v2-primitives.ts";
import type { ProviderPublicHeadV2 } from "../transition/provider-candidate.ts";
import {
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  assertPortableId,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  grantId,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  assertU64Counter,
} from "../v2-types/ids.ts";
import type {
  ObjectAccessAuthorizationExpectationV2,
} from "../object/authorized-write.ts";
import type {
  DeviceWrappedAgentEnvelopeAuthorityV1,
  DeviceWrappedAgentNamespaceAuthorityV1,
  DeviceWrappedAgentObjectAccessGenesisSetAuthorityContextV1,
} from "../object/device-wrapped-agent-access-manifest-set-v1.ts";
import { assertV2Limit, V2_LIMITS } from "../v2-types/limits.ts";
import {
  assertOpaqueBytes,
  cloneOpaqueBytes,
  copyOwnedBytesV2,
  opaqueBytes,
  type OpaqueBytes,
} from "../v2-types/opaque.ts";
import type {
  CryptoDomainPublicRecordV2,
  NamespaceBindingRecordV2,
  NamespaceBindingWireRecordV2,
  NamespaceHeadV2,
  OpaqueEncryptedObjectRecordV2,
  EncryptedObjectWireRecordV2,
  ObjectAccessManifestStorageHeadV2,
  OpaqueNamespaceObjectEnvelopeRecordV2,
  ObjectAccessStorageStateV2,
  ObjectAccessStorageWireStateV2,
  AgentRuntimeAtomicStorageStateV2,
  AgentRuntimeChallengeReservationExpectationV2,
  AgentRuntimeRotationStorageExpectationV2,
  OpaqueGrantRecordV2,
  GrantWireRecordV2,
  OpaqueRecoveryPackageRecordV2,
  RecoveryArchiveWireRecordV2,
  AgentRuntimeAtomicStorageWireV2,
  DomainProviderPublicStateV2,
} from "./v2-records.ts";

export function cloneBytes(bytes: Uint8Array): Uint8Array {
  return copyOwnedBytesV2(bytes);
}

export function assertExactFields(
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

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

export function equalStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length
    && left.every((value, index) => value === right[index])
  );
}

export function assertProviderHead(
  label: string,
  head: ProviderPublicHeadV2,
): void {
  assertExactFields(label, head, [
    "providerId",
    "domainId",
    "epoch",
    "stateHash",
  ]);
  assertPortableId(`${label} provider id`, head.providerId);
  cryptoDomainId(head.domainId);
  domainEpoch(head.epoch);
  if (
    !(head.stateHash instanceof Uint8Array)
    || head.stateHash.length !== 32
  ) {
    throw new RangeError(`${label} state hash must be exactly 32 bytes`);
  }
}

export function assertRosterBytes(label: string, rosterBytes: Uint8Array): void {
  if (!(rosterBytes instanceof Uint8Array)) {
    throw new TypeError(`${label} must be encoded bytes`);
  }
  assertV2Limit(
    label,
    rosterBytes.length,
    V2_LIMITS.ciphertextBytes,
  );
}

export function cloneProviderState(
  state: DomainProviderPublicStateV2,
): DomainProviderPublicStateV2 {
  return {
    head: {
      providerId: state.head.providerId,
      domainId: state.head.domainId,
      epoch: state.head.epoch,
      stateHash: cloneBytes(state.head.stateHash),
    },
    rosterBytes: cloneBytes(state.rosterBytes),
  };
}

export function cloneDomain(
  domain: CryptoDomainPublicRecordV2,
): CryptoDomainPublicRecordV2 {
  return {
    id: domain.id,
    participantDigest: cloneBytes(domain.participantDigest),
    participants: [...domain.participants],
    epoch: domain.epoch,
    authorizationRevision: domain.authorizationRevision,
    rosterBytes: cloneBytes(domain.rosterBytes),
  };
}

export function cloneBinding(
  binding: NamespaceBindingRecordV2,
): NamespaceBindingRecordV2 {
  return {
    namespaceId: binding.namespaceId,
    revision: binding.revision,
    bindingHash: cloneBytes(binding.bindingHash),
    previousBindingHash: binding.previousBindingHash
      ? cloneBytes(binding.previousBindingHash)
      : null,
    signedBindingBytes: cloneBytes(binding.signedBindingBytes),
    humanKeyringEnvelope: cloneOpaqueBytes(binding.humanKeyringEnvelope),
    aiKeyringEnvelope: cloneOpaqueBytes(binding.aiKeyringEnvelope),
  };
}

export function bindingWireRecord(
  binding: NamespaceBindingRecordV2,
): NamespaceBindingWireRecordV2 {
  return {
    namespaceId: binding.namespaceId,
    revision: binding.revision,
    bindingHash: cloneBytes(binding.bindingHash),
    previousBindingHash: binding.previousBindingHash === null
      ? null
      : copyOwnedBytesV2(binding.previousBindingHash),
    signedBindingBytes: cloneBytes(binding.signedBindingBytes),
    humanKeyringEnvelopeBytes:
      cloneBytes(binding.humanKeyringEnvelope.ciphertext),
    aiKeyringEnvelopeBytes:
      cloneBytes(binding.aiKeyringEnvelope.ciphertext),
  };
}

export function equalBindings(
  left: NamespaceBindingRecordV2,
  right: NamespaceBindingRecordV2,
): boolean {
  return (
    equalBytes(left.bindingHash, right.bindingHash)
    && (
      left.previousBindingHash === null
        ? right.previousBindingHash === null
        : right.previousBindingHash !== null
          && equalBytes(left.previousBindingHash, right.previousBindingHash)
    )
    && equalBytes(left.signedBindingBytes, right.signedBindingBytes)
    && equalBytes(
      left.humanKeyringEnvelope.ciphertext,
      right.humanKeyringEnvelope.ciphertext,
    )
    && equalBytes(
      left.aiKeyringEnvelope.ciphertext,
      right.aiKeyringEnvelope.ciphertext,
    )
  );
}

export function assertCanonicalNamespaceBindingRecord(
  binding: NamespaceBindingRecordV2,
): ReturnType<typeof parseNamespaceBinding> {
  assertExactFields("Namespace binding record", binding, [
    "namespaceId",
    "revision",
    "bindingHash",
    "previousBindingHash",
    "signedBindingBytes",
    "humanKeyringEnvelope",
    "aiKeyringEnvelope",
  ]);
  namespaceId(binding.namespaceId);
  accessRevision(binding.revision);
  assertOpaqueBytes(
    "Human keyring envelope",
    binding.humanKeyringEnvelope,
    "human-keyring-envelope",
  );
  assertOpaqueBytes(
    "AI keyring envelope",
    binding.aiKeyringEnvelope,
    "ai-keyring-envelope",
  );
  assertV2Limit(
    "Human keyring envelope bytes",
    binding.humanKeyringEnvelope.ciphertext.length,
    V2_LIMITS.namespaceKeyringBytes,
  );
  assertV2Limit(
    "AI keyring envelope bytes",
    binding.aiKeyringEnvelope.ciphertext.length,
    V2_LIMITS.namespaceKeyringBytes,
  );
  const signed = parseNamespaceBinding(binding.signedBindingBytes);
  const humanEnvelope = parseNamespaceKeyringEnvelope(
    binding.humanKeyringEnvelope.ciphertext,
  );
  const aiEnvelope = parseNamespaceKeyringEnvelope(
    binding.aiKeyringEnvelope.ciphertext,
  );
  const sameBytesOrNull = (
    left: Uint8Array | null,
    right: Uint8Array | null,
  ) => left === null
    ? right === null
    : right !== null && equalBytes(left, right);
  if (
    signed.namespaceId !== binding.namespaceId
    || signed.accessRevision !== binding.revision
    || !equalBytes(
      sha256(binding.signedBindingBytes),
      binding.bindingHash,
    )
    || !sameBytesOrNull(
      signed.previousBindingHash,
      binding.previousBindingHash,
    )
    || !equalBytes(
      sha256(binding.humanKeyringEnvelope.ciphertext),
      signed.humanKeyringEnvelopeHash,
    )
    || !equalBytes(
      sha256(binding.aiKeyringEnvelope.ciphertext),
      signed.aiKeyringEnvelopeHash,
    )
    || humanEnvelope.namespaceId !== signed.namespaceId
    || humanEnvelope.keyClass !== "human"
    || humanEnvelope.domainId !== signed.domainId
    || humanEnvelope.domainEpoch !== signed.domainEpoch
    || humanEnvelope.accessRevision !== signed.accessRevision
    || humanEnvelope.currentGeneration !== signed.humanCurrentGeneration
    || !sameBytesOrNull(
      humanEnvelope.previousBindingHash,
      signed.previousBindingHash,
    )
    || aiEnvelope.namespaceId !== signed.namespaceId
    || aiEnvelope.keyClass !== "ai"
    || aiEnvelope.domainId !== signed.domainId
    || aiEnvelope.domainEpoch !== signed.domainEpoch
    || aiEnvelope.accessRevision !== signed.accessRevision
    || aiEnvelope.currentGeneration !== signed.aiCurrentGeneration
    || !sameBytesOrNull(
      aiEnvelope.previousBindingHash,
      signed.previousBindingHash,
    )
  ) {
    throw new Error(
      "Namespace binding record does not match its canonical binding and keyring envelopes",
    );
  }
  return signed;
}

export function cloneHead(head: NamespaceHeadV2): NamespaceHeadV2 {
  return {
    namespaceId: head.namespaceId,
    accessRevision: head.accessRevision,
    bindingHash: cloneBytes(head.bindingHash),
    domainId: head.domainId,
    domainEpoch: head.domainEpoch,
  };
}

export function cloneObject(
  object: OpaqueEncryptedObjectRecordV2,
): OpaqueEncryptedObjectRecordV2 {
  return {
    objectId: object.objectId,
    payloadBytes: cloneOpaqueBytes(object.payloadBytes),
  };
}

export function objectWireRecord(
  object: OpaqueEncryptedObjectRecordV2,
): EncryptedObjectWireRecordV2 {
  return {
    objectId: object.objectId,
    payloadBytes: cloneBytes(object.payloadBytes.ciphertext),
  };
}

function cloneObjectAccessHead(
  head: ObjectAccessManifestStorageHeadV2,
): ObjectAccessManifestStorageHeadV2 {
  return {
    objectId: head.objectId,
    accessRevision: head.accessRevision,
    manifestHash: cloneBytes(head.manifestHash),
    manifestBytes: cloneBytes(head.manifestBytes),
  };
}

export function cloneObjectAccessState(
  state: ObjectAccessStorageStateV2,
): ObjectAccessStorageStateV2 {
  return {
    head: cloneObjectAccessHead(state.head),
    namespaceEnvelopes: state.namespaceEnvelopes.map((envelope) => ({
      namespaceId: envelope.namespaceId,
      envelopeHash: cloneBytes(envelope.envelopeHash),
      envelopeBytes: cloneOpaqueBytes(envelope.envelopeBytes),
    })),
  };
}

export function objectAccessWireState(
  state: ObjectAccessStorageStateV2,
): ObjectAccessStorageWireStateV2 {
  return {
    head: cloneObjectAccessHead(state.head),
    namespaceEnvelopes: state.namespaceEnvelopes.map((envelope) => ({
      namespaceId: envelope.namespaceId,
      envelopeHash: cloneBytes(envelope.envelopeHash),
      envelopeBytes: cloneBytes(envelope.envelopeBytes.ciphertext),
    })),
  };
}

export function equalObjectAccessHeads(
  left: ObjectAccessManifestStorageHeadV2,
  right: ObjectAccessManifestStorageHeadV2,
): boolean {
  // Both heads pass canonical manifest validation before comparison, so the
  // wire bytes already bind object id, revision, and manifest hash.
  return equalBytes(left.manifestBytes, right.manifestBytes);
}

export function equalObjectAccessStates(
  left: ObjectAccessStorageStateV2,
  right: ObjectAccessStorageStateV2,
): boolean {
  // Canonical manifest bytes authenticate the complete sorted envelope-hash
  // inventory; each validated state has already bound those hashes to its
  // canonical envelope bytes.
  return equalObjectAccessHeads(left.head, right.head);
}

export function compareBytes(left: Uint8Array, right: Uint8Array): number {
  // validates both operands as fixed 32-byte challenge hashes.
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  // have equal lengths, so this tie-breaker is unreachable in production.
  return left.length - right.length;
}

export function assertHash(label: string, value: unknown): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new TypeError(`${label} must be exactly 32 bytes`);
  }
}

function runtimeConfigInventoryDigest(
  objects: readonly Readonly<{
    readonly agentId: string;
    readonly objectId: string;
    readonly configRevision: number;
    readonly runtimeGeneration: number;
    readonly wrappedDekHash: Uint8Array;
  }>[],
): Uint8Array {
  return sha256(concatV2(
    frameText("nautilo/lattice-crypto/agent-runtime-config-inventory/v1"),
    encodeU32(1),
    encodeU32(objects.length),
    ...objects.map((object) =>
      concatV2(
        frameText(object.agentId),
        frameText(object.objectId),
        encodeU64(object.configRevision),
        encodeU64(object.runtimeGeneration),
        frame(object.wrappedDekHash),
      )
    ),
  ));
}

export function assertObjectAccessHead(
  label: string,
  head: ObjectAccessManifestStorageHeadV2,
): void {
  assertExactFields(label, head, [
    "objectId",
    "accessRevision",
    "manifestHash",
    "manifestBytes",
  ]);
  objectId(head.objectId);
  accessRevision(head.accessRevision);
  assertHash(`${label} hash`, head.manifestHash);
  if (!(head.manifestBytes instanceof Uint8Array)) {
    throw new TypeError(`${label} bytes must be Uint8Array`);
  }
  assertV2Limit(
    `${label} bytes`,
    head.manifestBytes.length,
    V2_LIMITS.ciphertextBytes,
  );
  const manifest = decodeObjectAccessStorageManifest(head.manifestBytes);
  if (
    manifest.objectId !== head.objectId
    || manifest.accessRevision !== head.accessRevision
    || !equalBytes(sha256(head.manifestBytes), head.manifestHash)
  ) {
    throw new Error(`${label} metadata does not match its manifest`);
  }
}

export function assertObjectAccessState(state: ObjectAccessStorageStateV2): void {
  assertExactFields("Object access state", state, [
    "head",
    "namespaceEnvelopes",
  ]);
  assertObjectAccessHead("Object access head", state.head);
  if (!Array.isArray(state.namespaceEnvelopes as unknown)) {
    throw new TypeError("Object access Namespace envelopes must be an array");
  }
  assertV2Limit(
    "Object access Namespace envelope count",
    state.namespaceEnvelopes.length,
    V2_LIMITS.namespaceEnvelopesPerManifest,
  );
  let aggregateBytes = 0;
  const manifest = decodeObjectAccessStorageManifest(
    state.head.manifestBytes,
  );
  if (manifest.envelopeHashes.length !== state.namespaceEnvelopes.length) {
    throw new Error(
      "Object access Namespace envelope inventory does not match manifest",
    );
  }
  for (let index = 0; index < state.namespaceEnvelopes.length; index += 1) {
    const envelope: OpaqueNamespaceObjectEnvelopeRecordV2 =
      state.namespaceEnvelopes[index]!;
    assertExactFields("Namespace object envelope record", envelope, [
      "namespaceId",
      "envelopeHash",
      "envelopeBytes",
    ]);
    namespaceId(envelope.namespaceId);
    assertHash("Namespace object envelope hash", envelope.envelopeHash);
    assertOpaqueBytes(
      "Namespace object envelope",
      envelope.envelopeBytes,
      "namespace-object-envelope",
    );
    aggregateBytes += envelope.envelopeBytes.ciphertext.length;
    assertV2Limit(
      "Object access Namespace envelope bytes",
      aggregateBytes,
      V2_LIMITS.manifestEnvelopeBytes,
    );
    const decoded = decodeNamespaceObjectEnvelopeV2(
      envelope.envelopeBytes.ciphertext,
    );
    if (
      decoded.context.objectId !== state.head.objectId
      || decoded.context.namespaceId !== envelope.namespaceId
      || !equalBytes(
        encodeNamespaceObjectEnvelopeV2(decoded),
        envelope.envelopeBytes.ciphertext,
      )
      || !equalBytes(
        sha256(envelope.envelopeBytes.ciphertext),
        envelope.envelopeHash,
      )
      || !equalBytes(manifest.envelopeHashes[index]!, envelope.envelopeHash)
    ) {
      throw new Error(
        "Namespace object envelope record does not match canonical manifest inventory",
      );
    }
  }
}

export function assertObjectAccessAuthorizationExpectation(
  expectation: ObjectAccessAuthorizationExpectationV2,
): void {
  if (expectation.kind === "human-v5-genesis") {
    assertExactFields(
      "Human v5 object access genesis authorization expectation",
      expectation,
      [
        "kind",
        "context",
        "currentHostAuthorizationRevision",
        "committerSigningPublicKeyHash",
      ],
    );
    const context = expectation.context;
    assertExactFields(
      "Human v5 object access genesis authorization context",
      context,
      [
        "purpose",
        "objectId",
        "payloadHash",
        "envelopes",
        "subjectHumanId",
        "committerDeviceId",
        "hostAuthorizationRevision",
      ],
    );
    if (context.purpose !== "persist-human-object-access-genesis-v5") {
      throw new TypeError(
        "Human v5 object access genesis authorization purpose is invalid",
      );
    }
    objectId(context.objectId);
    humanId(context.subjectHumanId);
    cryptoDeviceId(context.committerDeviceId);
    authorizationRevision(context.hostAuthorizationRevision);
    authorizationRevision(expectation.currentHostAuthorizationRevision);
    assertHash(
      "Human v5 object access genesis payload hash",
      context.payloadHash,
    );
    assertHash(
      "Human v5 object access genesis signing key hash",
      expectation.committerSigningPublicKeyHash,
    );
    if (!Array.isArray(context.envelopes as unknown)) {
      throw new TypeError("Human v5 object access envelopes must be an array");
    }
    assertV2Limit(
      "Human v5 object access envelope count",
      context.envelopes.length,
      V2_LIMITS.namespaceEnvelopesPerManifest,
    );
    for (const [index, envelope] of context.envelopes.entries()) {
      assertExactFields("Human v5 object access envelope", envelope, [
        "objectId",
        "namespaceId",
        "keyClass",
        "keyGeneration",
        "bindingRevisionAtWrap",
        "envelopeHash",
      ]);
      objectId(envelope.objectId);
      namespaceId(envelope.namespaceId);
      namespaceGeneration(envelope.keyGeneration);
      accessRevision(envelope.bindingRevisionAtWrap);
      assertHash("Human v5 object access envelope hash", envelope.envelopeHash);
      if (envelope.keyClass !== "ai") {
        throw new TypeError("Human v5 object access requires AI envelopes");
      }
      if (envelope.objectId !== context.objectId) {
        throw new TypeError("Human v5 object access envelope object is invalid");
      }
      if (
        index > 0
        && compareUnsignedUtf8(
          context.envelopes[index - 1]!.namespaceId,
          envelope.namespaceId,
        ) >= 0
      ) {
        throw new TypeError(
          "Human v5 object access envelopes must be canonical and unique",
        );
      }
    }
    return;
  }
  if (expectation.kind === "genesis") {
    assertExactFields("Object access genesis authorization expectation", expectation, [
      "kind",
      "context",
      "currentHostAuthorizationRevision",
      "committerSigningPublicKeyHash",
    ]);
    authorizationRevision(expectation.currentHostAuthorizationRevision);
    assertHash(
      "Object access genesis committer signing public key hash",
      expectation.committerSigningPublicKeyHash,
    );
    return;
  }
  if (expectation.kind === "agent-genesis") {
    assertExactFields(
      "Agent object access genesis authorization expectation",
      expectation,
      [
        "kind",
        "context",
        "signerPublication",
        "signerPublicationHash",
        "signerPublicKeyHash",
        "managerSigningPublicKeyHash",
      ],
    );
    const context = expectation.context;
    assertExactFields(
      "Agent object access genesis authorization context",
      context,
      [
        "purpose",
        "objectId",
        "payloadHash",
        "envelope",
        "grantId",
        "grantHash",
        "grantUseStatus",
        "namespaceId",
        "namespaceAccessRevision",
        "namespaceBindingHash",
        "domainId",
        "domainEpoch",
        "agentAuthorizationRevision",
        "agentId",
        "runtimeGeneration",
        "signerKeyId",
      ],
    );
    if (
      context.purpose !== "persist-agent-object-access-genesis"
      || (
        context.grantUseStatus !== "reusable"
        && context.grantUseStatus !== "claimed-by-preflight"
      )
    ) {
      throw new TypeError(
        "Agent object access genesis authorization context is invalid",
      );
    }
    objectId(context.objectId);
    grantId(context.grantId);
    namespaceId(context.namespaceId);
    accessRevision(context.namespaceAccessRevision);
    cryptoDomainId(context.domainId);
    domainEpoch(context.domainEpoch);
    authorizationRevision(context.agentAuthorizationRevision);
    agentId(context.agentId);
    agentRuntimeGeneration(context.runtimeGeneration);
    assertPortableId(
      "Agent object access signer key id",
      context.signerKeyId,
    );
    assertHash("Agent object access payload hash", context.payloadHash);
    assertHash("Agent object access Grant hash", context.grantHash);
    assertHash(
      "Agent object access Namespace binding hash",
      context.namespaceBindingHash,
    );
    assertExactFields(
      "Agent object access genesis envelope context",
      context.envelope,
      [
        "objectId",
        "namespaceId",
        "keyClass",
        "keyGeneration",
        "bindingRevisionAtWrap",
        "envelopeHash",
      ],
    );
    objectId(context.envelope.objectId);
    namespaceId(context.envelope.namespaceId);
    if (
      context.envelope.keyClass !== "ai"
      || context.envelope.objectId !== context.objectId
      || context.envelope.namespaceId !== context.namespaceId
    ) {
      throw new TypeError(
        "Agent object access genesis envelope context is invalid",
      );
    }
    assertU64Counter(
      "Agent object access Namespace key generation",
      context.envelope.keyGeneration,
    );
    accessRevision(context.envelope.bindingRevisionAtWrap);
    assertHash(
      "Agent object access Namespace envelope hash",
      context.envelope.envelopeHash,
    );
    const publication = decodeAgentRuntimeSignerPublicationV1(
      encodeAgentRuntimeSignerPublicationV1(
        expectation.signerPublication,
      ),
    );
    assertHash(
      "Agent object access signer publication hash",
      expectation.signerPublicationHash,
    );
    assertHash(
      "Agent object access signer public key hash",
      expectation.signerPublicKeyHash,
    );
    assertHash(
      "Agent object access manager signing public key hash",
      expectation.managerSigningPublicKeyHash,
    );
    if (
      publication.agentId !== context.agentId
      || publication.authorizationRevision
        !== context.agentAuthorizationRevision
      || publication.runtimeGeneration !== context.runtimeGeneration
      || publication.signerKeyId !== context.signerKeyId
      || !equalBytes(
        sha256(encodeAgentRuntimeSignerPublicationV1(publication)),
        expectation.signerPublicationHash,
      )
      || !equalBytes(
        sha256(publication.signerPublicKey),
        expectation.signerPublicKeyHash,
      )
      || !equalBytes(
        publication.managerSigningPublicKeyHash,
        expectation.managerSigningPublicKeyHash,
      )
    ) {
      throw new Error(
        "Agent object access signer publication expectation is inconsistent",
      );
    }
    return;
  }
  if (expectation.kind === "device-wrapped-live-shadow-agent-genesis-set") {
    assertExactFields(
      "Device-wrapped Agent object access set authorization expectation",
      expectation,
      ["kind", "context", "signerPublicKey", "signerPublicKeyHash"],
    );
    const context = expectation.context;
    assertExactFields(
      "Device-wrapped Agent object access set authorization context",
      context,
      [
        "purpose",
        "objectId",
        "payloadHash",
        "envelopes",
        "operationId",
        "grantId",
        "grantHash",
        "recipientKeyId",
        "namespaces",
        "agentAuthorizationRevision",
        "agentId",
        "runtimeGeneration",
        "signerKeyId",
      ],
    );
    if (
      context.purpose
        !== "persist-device-wrapped-live-shadow-agent-object-access-genesis-set"
      || !Array.isArray(context.envelopes)
      || !Array.isArray(context.namespaces)
      || context.envelopes.length < 1
      || context.envelopes.length > V2_LIMITS.namespaceEnvelopesPerManifest
      || context.envelopes.length !== context.namespaces.length
    ) throw new TypeError("Device-wrapped Agent object access set is invalid");
    const setContext = context as unknown as
      DeviceWrappedAgentObjectAccessGenesisSetAuthorityContextV1;
    objectId(context.objectId);
    assertPortableId("Device-wrapped Agent operation ID", context.operationId);
    grantId(context.grantId);
    assertPortableId(
      "Device-wrapped Agent recipient key ID",
      context.recipientKeyId,
    );
    authorizationRevision(context.agentAuthorizationRevision);
    agentId(context.agentId);
    agentRuntimeGeneration(context.runtimeGeneration);
    assertPortableId(
      "Device-wrapped Agent signer key ID",
      context.signerKeyId,
    );
    assertHash("Device-wrapped Agent payload hash", context.payloadHash);
    assertHash("Device-wrapped Agent Grant hash", context.grantHash);
    for (const [index, namespace] of setContext.namespaces.entries()) {
      assertExactFields("Device-wrapped Agent Namespace authority", namespace, [
        "namespaceId",
        "accessRevision",
        "keyGeneration",
        "domainId",
        "domainKeyGeneration",
        "domainAuthorizationRevision",
        "domainHeadDigest",
        "headDigest",
        "publicationDigest",
        "publicationSetDigest",
        "audienceFingerprint",
      ]);
      namespaceId(namespace["namespaceId"]);
      accessRevision(namespace["accessRevision"]);
      assertU64Counter(
        "Device-wrapped Namespace key generation",
        namespace["keyGeneration"],
      );
      cryptoDomainId(namespace["domainId"]);
      assertU64Counter(
        "Device-wrapped Domain key generation",
        namespace["domainKeyGeneration"],
      );
      authorizationRevision(namespace["domainAuthorizationRevision"]);
      assertHash(
        "Device-wrapped Domain head digest",
        namespace["domainHeadDigest"],
      );
      assertHash(
        "Device-wrapped Namespace head digest",
        namespace["headDigest"],
      );
      assertHash(
        "Device-wrapped Namespace publication digest",
        namespace["publicationDigest"],
      );
      assertHash(
        "Device-wrapped Namespace publication-set digest",
        namespace["publicationSetDigest"],
      );
      assertHash(
        "Device-wrapped Namespace audience fingerprint",
        namespace["audienceFingerprint"],
      );
      const namespaceAuthority = namespace as unknown as
        DeviceWrappedAgentNamespaceAuthorityV1;
      if (
        index > 0
        && setContext.namespaces[index - 1]!.namespaceId
          >= namespaceAuthority.namespaceId
      ) {
        throw new TypeError(
          "Device-wrapped Agent Namespace authority is not canonical",
        );
      }
    }
    for (const [index, envelope] of setContext.envelopes.entries()) {
      assertExactFields(
        "Device-wrapped Agent object envelope context",
        envelope,
        [
          "objectId",
          "namespaceId",
          "keyClass",
          "keyGeneration",
          "bindingRevisionAtWrap",
          "envelopeHash",
        ],
      );
      const envelopeAuthority = envelope as unknown as
        DeviceWrappedAgentEnvelopeAuthorityV1;
      const namespace = setContext.namespaces[index]!;
      objectId(envelope["objectId"]);
      namespaceId(envelope["namespaceId"]);
      accessRevision(envelope["bindingRevisionAtWrap"]);
      assertU64Counter(
        "Device-wrapped Namespace key generation",
        envelope["keyGeneration"],
      );
      assertHash(
        "Device-wrapped Agent object envelope hash",
        envelope["envelopeHash"],
      );
      if (
        envelopeAuthority.objectId !== context.objectId
        || envelopeAuthority.namespaceId !== namespace.namespaceId
        || envelopeAuthority.keyClass !== "ai"
        || envelopeAuthority.keyGeneration !== namespace.keyGeneration
        || envelopeAuthority.bindingRevisionAtWrap !== namespace.accessRevision
      ) {
        throw new TypeError(
          "Device-wrapped Agent object envelope coordinates are invalid",
        );
      }
    }
    if (
      !(expectation.signerPublicKey instanceof Uint8Array)
      || expectation.signerPublicKey.length !== V2_LIMITS.signingPublicKeyBytes
    ) throw new TypeError("Device-wrapped Agent signer public key is invalid");
    assertHash(
      "Device-wrapped Agent signer public key hash",
      expectation.signerPublicKeyHash,
    );
    if (
      !equalBytes(
        sha256(expectation.signerPublicKey),
        expectation.signerPublicKeyHash,
      )
    ) {
      throw new Error(
        "Device-wrapped Agent signer public key expectation is inconsistent",
      );
    }
    return;
  }
  if (expectation.kind === "device-wrapped-live-shadow-agent-genesis") {
    assertExactFields(
      "Device-wrapped Agent object access authorization expectation",
      expectation,
      ["kind", "context", "signerPublicKey", "signerPublicKeyHash"],
    );
    const context = expectation.context;
    assertExactFields(
      "Device-wrapped Agent object access authorization context",
      context,
      [
        "purpose",
        "objectId",
        "payloadHash",
        "envelope",
        "operationId",
        "grantId",
        "grantHash",
        "recipientKeyId",
        "namespaceId",
        "namespaceAccessRevision",
        "namespaceHeadDigest",
        "namespacePublicationDigest",
        "namespacePublicationSetDigest",
        "namespaceAudienceFingerprint",
        "agentAuthorizationRevision",
        "agentId",
        "runtimeGeneration",
        "signerKeyId",
      ],
    );
    if (
      context.purpose
        !== "persist-device-wrapped-live-shadow-agent-object-access-genesis"
    ) {
      throw new TypeError(
        "Device-wrapped Agent object access purpose is invalid",
      );
    }
    objectId(context.objectId);
    assertPortableId("Device-wrapped Agent operation ID", context.operationId);
    grantId(context.grantId);
    assertPortableId(
      "Device-wrapped Agent recipient key ID",
      context.recipientKeyId,
    );
    namespaceId(context.namespaceId);
    accessRevision(context.namespaceAccessRevision);
    authorizationRevision(context.agentAuthorizationRevision);
    agentId(context.agentId);
    agentRuntimeGeneration(context.runtimeGeneration);
    assertPortableId(
      "Device-wrapped Agent signer key ID",
      context.signerKeyId,
    );
    assertHash("Device-wrapped Agent payload hash", context.payloadHash);
    assertHash("Device-wrapped Agent Grant hash", context.grantHash);
    assertHash(
      "Device-wrapped Namespace head digest",
      context.namespaceHeadDigest,
    );
    assertHash(
      "Device-wrapped Namespace publication digest",
      context.namespacePublicationDigest,
    );
    assertHash(
      "Device-wrapped Namespace publication-set digest",
      context.namespacePublicationSetDigest,
    );
    assertHash(
      "Device-wrapped Namespace audience fingerprint",
      context.namespaceAudienceFingerprint,
    );
    assertExactFields(
      "Device-wrapped Agent object envelope context",
      context.envelope,
      [
        "objectId",
        "namespaceId",
        "keyClass",
        "keyGeneration",
        "bindingRevisionAtWrap",
        "envelopeHash",
      ],
    );
    objectId(context.envelope.objectId);
    namespaceId(context.envelope.namespaceId);
    if (
      context.envelope.objectId !== context.objectId
      || context.envelope.namespaceId !== context.namespaceId
      || context.envelope.keyClass !== "ai"
    ) {
      throw new TypeError(
        "Device-wrapped Agent object envelope coordinates are invalid",
      );
    }
    assertU64Counter(
      "Device-wrapped Namespace key generation",
      context.envelope.keyGeneration,
    );
    accessRevision(context.envelope.bindingRevisionAtWrap);
    assertHash(
      "Device-wrapped Agent object envelope hash",
      context.envelope.envelopeHash,
    );
    if (
      !(expectation.signerPublicKey instanceof Uint8Array)
      || expectation.signerPublicKey.length !== V2_LIMITS.signingPublicKeyBytes
    ) {
      throw new TypeError("Device-wrapped Agent signer public key is invalid");
    }
    assertHash(
      "Device-wrapped Agent signer public key hash",
      expectation.signerPublicKeyHash,
    );
    if (
      !equalBytes(
        sha256(expectation.signerPublicKey),
        expectation.signerPublicKeyHash,
      )
    ) {
      throw new Error(
        "Device-wrapped Agent signer public key expectation is inconsistent",
      );
    }
    return;
  }
  assertExactFields("Object access update authorization expectation", expectation, [
    "kind",
    "context",
    "currentManifestHostAuthorizationRevision",
    "currentHostAuthorizationRevision",
    "currentCommitterSigningPublicKeyHash",
    "nextCommitterSigningPublicKeyHash",
  ]);
  if (expectation.kind !== "update") {
    throw new TypeError("Object access authorization expectation kind is invalid");
  }
  authorizationRevision(
    expectation.currentManifestHostAuthorizationRevision,
  );
  authorizationRevision(expectation.currentHostAuthorizationRevision);
  assertHash(
    "Object access current committer signing public key hash",
    expectation.currentCommitterSigningPublicKeyHash,
  );
  assertHash(
    "Object access next committer signing public key hash",
    expectation.nextCommitterSigningPublicKeyHash,
  );
}

export function cloneAtomicRuntimeState(
  state: AgentRuntimeAtomicStorageStateV2,
): AgentRuntimeAtomicStorageStateV2 {
  return {
    runtime: {
      agentId: state.runtime.agentId,
      authorizationRevision: state.runtime.authorizationRevision,
      runtimeGeneration: state.runtime.runtimeGeneration,
    },
    configInventory: {
      objectCount: state.configInventory.objectCount,
      digest: cloneBytes(state.configInventory.digest),
    },
    configObjects: state.configObjects.map((object) => ({
      agentId: object.agentId,
      objectId: object.objectId,
      configRevision: object.configRevision,
      runtimeGeneration: object.runtimeGeneration,
      wrappedDekHash: cloneBytes(object.wrappedDekHash),
      wrappedDek: cloneOpaqueBytes(object.wrappedDek),
    })),
    domainEnvelopes: state.domainEnvelopes.map((envelope) => ({
      agentId: envelope.agentId,
      domainId: envelope.domainId,
      domainEpoch: envelope.domainEpoch,
      agentAuthorizationRevision: envelope.agentAuthorizationRevision,
      runtimeGeneration: envelope.runtimeGeneration,
      committerDeviceId: envelope.committerDeviceId,
      envelopeHash: cloneBytes(envelope.envelopeHash),
      envelopeBytes: cloneOpaqueBytes(envelope.envelopeBytes),
    })),
    challengeConsumptions: state.challengeConsumptions.map((challenge) => ({
      challengeHash: cloneBytes(challenge.challengeHash),
      consumed: challenge.consumed,
    })),
  };
}

export function runtimeWireState(
  state: AgentRuntimeAtomicStorageStateV2,
): AgentRuntimeAtomicStorageWireV2 {
  return {
    runtime: {
      agentId: state.runtime.agentId,
      authorizationRevision: state.runtime.authorizationRevision,
      runtimeGeneration: state.runtime.runtimeGeneration,
    },
    configInventory: {
      objectCount: state.configInventory.objectCount,
      digest: cloneBytes(state.configInventory.digest),
    },
    configObjects: state.configObjects.map((object) => ({
      agentId: object.agentId,
      objectId: object.objectId,
      configRevision: object.configRevision,
      runtimeGeneration: object.runtimeGeneration,
      wrappedDekHash: cloneBytes(object.wrappedDekHash),
      wrappedDekBytes: cloneBytes(object.wrappedDek.ciphertext),
    })),
    domainEnvelopes: state.domainEnvelopes.map((envelope) => ({
      agentId: envelope.agentId,
      domainId: envelope.domainId,
      domainEpoch: envelope.domainEpoch,
      agentAuthorizationRevision: envelope.agentAuthorizationRevision,
      runtimeGeneration: envelope.runtimeGeneration,
      committerDeviceId: envelope.committerDeviceId,
      envelopeHash: cloneBytes(envelope.envelopeHash),
      envelopeBytes: cloneBytes(envelope.envelopeBytes.ciphertext),
    })),
    challengeConsumptions: state.challengeConsumptions.map((challenge) => ({
      challengeHash: cloneBytes(challenge.challengeHash),
      consumed: challenge.consumed,
    })),
  };
}

export function cloneRuntimeExpectation(
  expected: AgentRuntimeRotationStorageExpectationV2,
): Omit<AgentRuntimeRotationStorageExpectationV2, "configObjects"> {
  return {
    runtime: {
      agentId: expected.runtime.agentId,
      authorizationRevision: expected.runtime.authorizationRevision,
      runtimeGeneration: expected.runtime.runtimeGeneration,
    },
    configInventory: {
      objectCount: expected.configInventory.objectCount,
      digest: cloneBytes(expected.configInventory.digest),
    },
    challengeConsumptions: expected.challengeConsumptions.map((challenge) => ({
      challengeHash: cloneBytes(challenge.challengeHash),
      consumed: challenge.consumed,
    })),
  };
}

export function equalAtomicRuntimeStates(
  left: AgentRuntimeAtomicStorageStateV2,
  right: AgentRuntimeAtomicStorageStateV2,
): boolean {
  const fingerprint = (state: AgentRuntimeAtomicStorageStateV2) =>
    JSON.stringify([
      state.runtime.agentId,
      state.runtime.authorizationRevision,
      state.runtime.runtimeGeneration,
      // Validation binds the sorted config coordinates and each ciphertext
      // hash into this inventory digest, so repeating the ciphertext list here
      // would be an unobservable duplicate comparison.
      bytesToHex(state.configInventory.digest),
      state.domainEnvelopes.map((envelope) =>
        bytesToHex(envelope.envelopeBytes.ciphertext)
      ),
      state.challengeConsumptions.map((challenge) => [
        bytesToHex(challenge.challengeHash),
        challenge.consumed,
      ]),
    ]);
  return fingerprint(left) === fingerprint(right);
}

function assertOpaqueRuntimeConfigDek(
  label: string,
  value: unknown,
): asserts value is OpaqueBytes<"agent-runtime-config-dek"> {
  assertOpaqueBytes(label, value, "agent-runtime-config-dek");
  const candidate = value;
  assertV2Limit(
    `${label} bytes`,
    candidate.ciphertext.length,
    V2_LIMITS.wrappedDekBytes,
  );
  if (candidate.ciphertext.length < 40) {
    throw new RangeError(`${label} ciphertext is too short`);
  }
}

export function assertAgentRuntimeAtomicState(
  state: AgentRuntimeAtomicStorageStateV2,
): void {
  assertExactFields("Agent Runtime atomic state", state, [
    "runtime",
    "configInventory",
    "configObjects",
    "domainEnvelopes",
    "challengeConsumptions",
  ]);
  assertExactFields("Agent Runtime public state", state.runtime, [
    "agentId",
    "authorizationRevision",
    "runtimeGeneration",
  ]);
  const expectedAgentId = agentId(state.runtime.agentId);
  authorizationRevision(state.runtime.authorizationRevision);
  agentRuntimeGeneration(state.runtime.runtimeGeneration);
  assertExactFields(
    "Agent Runtime config inventory commitment",
    state.configInventory,
    ["objectCount", "digest"],
  );
  assertV2Limit(
    "Agent Runtime config inventory count",
    state.configInventory.objectCount,
    V2_LIMITS.batchItems,
  );
  assertHash(
    "Agent Runtime config inventory digest",
    state.configInventory.digest,
  );
  if (!Array.isArray(state.configObjects as unknown)) {
    throw new TypeError("Agent Runtime config objects must be an array");
  }
  assertV2Limit(
    "Agent Runtime config object count",
    state.configObjects.length,
    V2_LIMITS.batchItems,
  );
  if (state.configInventory.objectCount !== state.configObjects.length) {
    throw new Error(
      "Agent Runtime config object count does not match its inventory commitment",
    );
  }
  let priorObjectId: string | undefined;
  for (const object of state.configObjects) {
    assertExactFields("Agent Runtime config object", object, [
      "agentId",
      "objectId",
      "configRevision",
      "runtimeGeneration",
      "wrappedDekHash",
      "wrappedDek",
    ]);
    if (agentId(object.agentId) !== expectedAgentId) {
      throw new Error("Agent Runtime config object has the wrong Agent");
    }
    objectId(object.objectId);
    authorizationRevision(object.configRevision);
    if (
      agentRuntimeGeneration(object.runtimeGeneration)
        !== state.runtime.runtimeGeneration
    ) {
      throw new Error(
        "Agent Runtime config object has the wrong Runtime generation",
      );
    }
    assertHash("Agent Runtime wrapped-DEK hash", object.wrappedDekHash);
    assertOpaqueRuntimeConfigDek(
      "Agent Runtime config wrapped DEK",
      object.wrappedDek,
    );
    if (
      !equalBytes(sha256(object.wrappedDek.ciphertext), object.wrappedDekHash)
    ) {
      throw new Error("Agent Runtime config wrapped-DEK hash is invalid");
    }
    if (
      priorObjectId !== undefined
      && !(priorObjectId < object.objectId)
    ) {
      throw new Error(
        "Agent Runtime config objects must be sorted and unique",
      );
    }
    priorObjectId = object.objectId;
  }
  if (
    !equalBytes(
      runtimeConfigInventoryDigest(state.configObjects),
      state.configInventory.digest,
    )
  ) {
    throw new Error(
      "Agent Runtime config inventory digest does not match config objects",
    );
  }
  if (!Array.isArray(state.domainEnvelopes as unknown)) {
    throw new TypeError("Agent Runtime Domain envelopes must be an array");
  }
  assertV2Limit(
    "Agent Runtime Domain envelope count",
    state.domainEnvelopes.length,
    V2_LIMITS.agentGrantDomains,
  );
  let priorDomainId: string | undefined;
  let envelopeBytes = 0;
  for (const envelope of state.domainEnvelopes) {
    assertExactFields("Agent Runtime Domain envelope record", envelope, [
      "agentId",
      "domainId",
      "domainEpoch",
      "agentAuthorizationRevision",
      "runtimeGeneration",
      "committerDeviceId",
      "envelopeHash",
      "envelopeBytes",
    ]);
    if (agentId(envelope.agentId) !== expectedAgentId) {
      throw new Error("Agent Runtime Domain envelope has the wrong Agent");
    }
    cryptoDomainId(envelope.domainId);
    domainEpoch(envelope.domainEpoch);
    authorizationRevision(envelope.agentAuthorizationRevision);
    cryptoDeviceId(envelope.committerDeviceId);
    if (
      agentRuntimeGeneration(envelope.runtimeGeneration)
        !== state.runtime.runtimeGeneration
    ) {
      throw new Error(
        "Agent Runtime Domain envelope has the wrong Runtime generation",
      );
    }
    assertHash("Agent Runtime Domain envelope hash", envelope.envelopeHash);
    assertOpaqueBytes(
      "Agent Runtime Domain envelope",
      envelope.envelopeBytes,
      "agent-runtime-domain-envelope",
    );
    const decodedEnvelope = parseAgentRuntimeDomainEnvelope(
      envelope.envelopeBytes.ciphertext,
    );
    if (
      !equalBytes(
        sha256(envelope.envelopeBytes.ciphertext),
        envelope.envelopeHash,
      )
      || !equalBytes(
        serializeAgentRuntimeDomainEnvelope(decodedEnvelope),
        envelope.envelopeBytes.ciphertext,
      )
      || decodedEnvelope.agentId !== envelope.agentId
      || decodedEnvelope.domainId !== envelope.domainId
      || decodedEnvelope.domainEpoch !== envelope.domainEpoch
      || decodedEnvelope.agentAuthorizationRevision
        !== envelope.agentAuthorizationRevision
      || decodedEnvelope.runtimeGeneration !== envelope.runtimeGeneration
      || decodedEnvelope.committerDeviceId !== envelope.committerDeviceId
    ) {
      throw new Error(
        "Agent Runtime Domain envelope record is noncanonical or inconsistent",
      );
    }
    envelopeBytes += envelope.envelopeBytes.ciphertext.length;
    assertV2Limit(
      "Agent Runtime Domain aggregate envelope bytes",
      envelopeBytes,
      V2_LIMITS.manifestEnvelopeBytes,
    );
    if (
      priorDomainId !== undefined
      && !(priorDomainId < envelope.domainId)
    ) {
      throw new Error(
        "Agent Runtime Domain envelopes must be sorted and unique",
      );
    }
    priorDomainId = envelope.domainId;
  }
  if (!Array.isArray(state.challengeConsumptions as unknown)) {
    throw new TypeError(
      "Agent Runtime challenge consumptions must be an array",
    );
  }
  assertV2Limit(
    "Agent Runtime challenge consumption count",
    state.challengeConsumptions.length,
    V2_LIMITS.agentGrantDomains,
  );
  let priorChallenge: Uint8Array | undefined;
  for (const challenge of state.challengeConsumptions) {
    assertExactFields("Agent Runtime challenge consumption", challenge, [
      "challengeHash",
      "consumed",
    ]);
    assertHash(
      "Agent Runtime challenge consumption hash",
      challenge.challengeHash,
    );
    if (typeof challenge.consumed !== "boolean") {
      throw new TypeError(
        "Agent Runtime challenge consumed state must be boolean",
      );
    }
    if (
      priorChallenge !== undefined
      && compareBytes(priorChallenge, challenge.challengeHash) >= 0
    ) {
      throw new Error(
        "Agent Runtime challenge consumptions must be sorted and unique",
      );
    }
    priorChallenge = challenge.challengeHash;
  }
}

export function assertAgentRuntimeRotationExpectation(
  expected: AgentRuntimeRotationStorageExpectationV2,
): void {
  assertExactFields("Agent Runtime rotation expectation", expected, [
    "runtime",
    "configInventory",
    "configObjects",
    "challengeConsumptions",
  ]);
  assertExactFields("Expected Agent Runtime public state", expected.runtime, [
    "agentId",
    "authorizationRevision",
    "runtimeGeneration",
  ]);
  const expectedAgentId = agentId(expected.runtime.agentId);
  authorizationRevision(expected.runtime.authorizationRevision);
  agentRuntimeGeneration(expected.runtime.runtimeGeneration);
  assertExactFields(
    "Expected Agent Runtime config inventory commitment",
    expected.configInventory,
    ["objectCount", "digest"],
  );
  assertV2Limit(
    "Expected Agent Runtime config count",
    expected.configInventory.objectCount,
    V2_LIMITS.batchItems,
  );
  assertHash(
    "Expected Agent Runtime config inventory digest",
    expected.configInventory.digest,
  );
  if (!Array.isArray(expected.configObjects as unknown)) {
    throw new TypeError(
      "Expected Agent Runtime config objects must be an array",
    );
  }
  if (expected.configInventory.objectCount !== expected.configObjects.length) {
    throw new Error(
      "Expected Agent Runtime config coverage is incomplete",
    );
  }
  let priorObjectId: string | undefined;
  for (const object of expected.configObjects) {
    assertExactFields("Expected Agent Runtime config object", object, [
      "agentId",
      "objectId",
      "configRevision",
      "runtimeGeneration",
      "wrappedDekHash",
    ]);
    if (
      agentId(object.agentId) !== expectedAgentId
      || agentRuntimeGeneration(object.runtimeGeneration)
        !== expected.runtime.runtimeGeneration
    ) {
      throw new Error(
        "Expected Agent Runtime config coordinates are inconsistent",
      );
    }
    objectId(object.objectId);
    authorizationRevision(object.configRevision);
    assertHash("Expected Agent Runtime wrapped-DEK hash", object.wrappedDekHash);
    if (
      priorObjectId !== undefined
      && !(priorObjectId < object.objectId)
    ) {
      throw new Error(
        "Expected Agent Runtime config objects must be sorted and unique",
      );
    }
    priorObjectId = object.objectId;
  }
  if (
    !equalBytes(
      runtimeConfigInventoryDigest(expected.configObjects),
      expected.configInventory.digest,
    )
  ) {
    throw new Error(
      "Expected Agent Runtime config inventory digest does not match config objects",
    );
  }
  if (!Array.isArray(expected.challengeConsumptions as unknown)) {
    throw new TypeError(
      "Expected Agent Runtime challenge consumptions must be an array",
    );
  }
  assertV2Limit(
    "Expected Agent Runtime challenge consumption count",
    expected.challengeConsumptions.length,
    V2_LIMITS.agentGrantDomains,
  );
  let priorChallenge: Uint8Array | undefined;
  for (const challenge of expected.challengeConsumptions) {
    assertExactFields("Expected Agent Runtime challenge consumption", challenge, [
      "challengeHash",
      "consumed",
    ]);
    assertHash(
      "Expected Agent Runtime challenge hash",
      challenge.challengeHash,
    );
    if (typeof challenge.consumed !== "boolean") {
      throw new TypeError(
        "Expected Agent Runtime challenge consumed state must be boolean",
      );
    }
    if (
      priorChallenge !== undefined
      && compareBytes(priorChallenge, challenge.challengeHash) >= 0
    ) {
      throw new Error(
        "Expected Agent Runtime challenges must be sorted and unique",
      );
    }
    priorChallenge = challenge.challengeHash;
  }
}

export function assertAgentRuntimeChallengeReservationExpectation(
  expected: AgentRuntimeChallengeReservationExpectationV2,
): void {
  assertExactFields("Agent Runtime challenge reservation expectation", expected, [
    "runtime",
    "challengeConsumptions",
  ]);
  assertExactFields(
    "Agent Runtime challenge reservation public state",
    expected.runtime,
    ["agentId", "authorizationRevision", "runtimeGeneration"],
  );
  agentId(expected.runtime.agentId);
  authorizationRevision(expected.runtime.authorizationRevision);
  agentRuntimeGeneration(expected.runtime.runtimeGeneration);
  if (!Array.isArray(expected.challengeConsumptions as unknown)) {
    throw new TypeError(
      "Expected Agent Runtime challenge reservations must be an array",
    );
  }
  assertV2Limit(
    "Expected Agent Runtime challenge reservation count",
    expected.challengeConsumptions.length,
    V2_LIMITS.agentGrantDomains,
  );
  let prior: Uint8Array | undefined;
  for (const challenge of expected.challengeConsumptions) {
    assertExactFields("Agent Runtime challenge reservation", challenge, [
      "challengeHash",
      "consumed",
    ]);
    assertHash("Agent Runtime challenge reservation hash", challenge.challengeHash);
    if (typeof challenge.consumed !== "boolean") {
      throw new TypeError(
        "Agent Runtime challenge reservation consumed state must be boolean",
      );
    }
    if (
      prior !== undefined
      && compareBytes(prior, challenge.challengeHash) >= 0
    ) {
      throw new Error(
        "Agent Runtime challenge reservations must be sorted and unique",
      );
    }
    prior = challenge.challengeHash;
  }
}

export function cloneGrant(grant: OpaqueGrantRecordV2): OpaqueGrantRecordV2 {
  return {
    grantId: grant.grantId,
    grantBytes: cloneOpaqueBytes(grant.grantBytes),
    consumed: grant.consumed,
  };
}

export function grantWireRecord(grant: OpaqueGrantRecordV2): GrantWireRecordV2 {
  return {
    grantId: grant.grantId,
    grantBytes: cloneBytes(grant.grantBytes.ciphertext),
    consumed: grant.consumed,
  };
}

export function cloneRecovery(
  archive: OpaqueRecoveryPackageRecordV2,
): OpaqueRecoveryPackageRecordV2 {
  return {
    humanId: archive.humanId,
    recoveryKeyGeneration: archive.recoveryKeyGeneration,
    archiveBytes: cloneOpaqueBytes(archive.archiveBytes),
  };
}

export function recoveryWireRecord(
  archive: OpaqueRecoveryPackageRecordV2,
): RecoveryArchiveWireRecordV2 {
  return {
    humanId: archive.humanId,
    recoveryKeyGeneration: archive.recoveryKeyGeneration,
    archiveBytes: cloneBytes(archive.archiveBytes.ciphertext),
  };
}

export function assertCanonicalRecoveryArchiveRecord(
  archive: OpaqueRecoveryPackageRecordV2,
): void {
  assertExactFields("Recovery archive record", archive, [
    "humanId",
    "recoveryKeyGeneration",
    "archiveBytes",
  ]);
  humanId(archive.humanId);
  assertU64Counter(
    "Recovery key generation",
    archive.recoveryKeyGeneration,
  );
  assertOpaqueBytes(
    "Recovery archive",
    archive.archiveBytes,
    "recovery-archive",
  );
  assertV2Limit(
    "Recovery archive bytes",
    archive.archiveBytes.ciphertext.length,
    V2_LIMITS.recoveryArchiveBytes,
  );
  const parsed = decodeHumanRecoveryArchive(
    archive.archiveBytes.ciphertext,
  );
  if (
    parsed.humanId !== archive.humanId
    || parsed.recoveryGeneration !== archive.recoveryKeyGeneration
  ) {
    throw new Error(
      "Recovery archive coordinates do not match canonical archive wire bytes",
    );
  }
}

function assertWireBytes(
  label: string,
  value: unknown,
  maximum: number,
): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${label} must be Uint8Array`);
  }
  assertV2Limit(label, value.length, maximum);
}

function assertCanonicalReencoding(
  label: string,
  original: Uint8Array,
  canonical: Uint8Array,
): void {
  if (!equalBytes(original, canonical)) {
    throw new Error(`${label} must use canonical wire encoding`);
  }
}

/**
 * Re-authenticate one durable Namespace binding row after process restart.
 * Signature authorization remains the responsibility of the Namespace
 * persistence coordinator; this boundary proves canonical encoding and binds
 * every public coordinate and envelope hash before restoring opaque records.
 */
export function namespaceBindingWriteRecordV2(input: Readonly<{
  readonly signedBindingBytes: Uint8Array;
  readonly humanKeyringEnvelopeBytes: Uint8Array;
  readonly aiKeyringEnvelopeBytes: Uint8Array;
}>): NamespaceBindingRecordV2 {
  assertExactFields("Durable Namespace binding record", input, [
    "signedBindingBytes",
    "humanKeyringEnvelopeBytes",
    "aiKeyringEnvelopeBytes",
  ]);
  assertWireBytes(
    "Signed Namespace binding bytes",
    input.signedBindingBytes,
    V2_LIMITS.ciphertextBytes,
  );
  assertWireBytes(
    "Human keyring envelope bytes",
    input.humanKeyringEnvelopeBytes,
    V2_LIMITS.namespaceKeyringBytes,
  );
  assertWireBytes(
    "AI keyring envelope bytes",
    input.aiKeyringEnvelopeBytes,
    V2_LIMITS.namespaceKeyringBytes,
  );
  const signed = parseNamespaceBinding(input.signedBindingBytes);
  const human = parseNamespaceKeyringEnvelope(
    input.humanKeyringEnvelopeBytes,
  );
  const ai = parseNamespaceKeyringEnvelope(input.aiKeyringEnvelopeBytes);
  assertCanonicalReencoding(
    "Signed Namespace binding",
    input.signedBindingBytes,
    serializeNamespaceBinding(signed),
  );
  assertCanonicalReencoding(
    "Human keyring envelope",
    input.humanKeyringEnvelopeBytes,
    serializeNamespaceKeyringEnvelope(human),
  );
  assertCanonicalReencoding(
    "AI keyring envelope",
    input.aiKeyringEnvelopeBytes,
    serializeNamespaceKeyringEnvelope(ai),
  );
  const record: NamespaceBindingRecordV2 = {
    namespaceId: signed.namespaceId,
    revision: signed.accessRevision,
    bindingHash: sha256(input.signedBindingBytes),
    previousBindingHash: signed.previousBindingHash,
    signedBindingBytes: input.signedBindingBytes,
    humanKeyringEnvelope: opaqueBytes(
      "human-keyring-envelope",
      input.humanKeyringEnvelopeBytes,
    ),
    aiKeyringEnvelope: opaqueBytes(
      "ai-keyring-envelope",
      input.aiKeyringEnvelopeBytes,
    ),
  };
  assertCanonicalNamespaceBindingRecord(record);
  return cloneBinding(record);
}

/** Restore one canonical encrypted-object row from durable wire bytes. */
export function encryptedObjectWriteRecordV2(
  payloadBytes: Uint8Array,
): OpaqueEncryptedObjectRecordV2 {
  assertWireBytes(
    "Encrypted payload bytes",
    payloadBytes,
    V2_LIMITS.ciphertextBytes,
  );
  const payload = decodeEncryptedPayloadV2(payloadBytes);
  assertCanonicalReencoding(
    "Encrypted payload",
    payloadBytes,
    encodeEncryptedPayloadV2(payload),
  );
  return cloneObject({
    objectId: payload.context.objectId,
    payloadBytes: opaqueBytes("encrypted-payload", payloadBytes),
  });
}

/** Construct one immutable, initially unconsumed Grant write record. */
export function grantWriteRecordV2(
  grantBytes: Uint8Array,
): OpaqueGrantRecordV2 {
  assertWireBytes(
    "Grant wire bytes",
    grantBytes,
    V2_LIMITS.agentGrantWireBytes,
  );
  const parsed = parseGrantV2(grantBytes);
  if (parsed === null) {
    throw new Error("Durable Grant bytes are not a canonical Grant");
  }
  // Consumption is mutable storage state and is deliberately absent from the
  // signed wire format; parsing canonical Grant bytes always restores false.
  assertCanonicalReencoding(
    "Grant",
    grantBytes,
    serializeGrantV2(parsed),
  );
  return cloneGrant({
    grantId: parsed.id,
    grantBytes: opaqueBytes("grant", grantBytes),
    consumed: false,
  });
}

/** Restore one canonical Human recovery archive row. */
export function recoveryArchiveWriteRecordV2(
  archiveBytes: Uint8Array,
): OpaqueRecoveryPackageRecordV2 {
  assertWireBytes(
    "Recovery archive bytes",
    archiveBytes,
    V2_LIMITS.recoveryArchiveBytes,
  );
  const parsed = decodeHumanRecoveryArchive(archiveBytes);
  assertCanonicalReencoding(
    "Recovery archive",
    archiveBytes,
    serializeHumanRecoveryArchive(parsed),
  );
  const record: OpaqueRecoveryPackageRecordV2 = {
    humanId: parsed.humanId,
    recoveryKeyGeneration: parsed.recoveryGeneration,
    archiveBytes: opaqueBytes("recovery-archive", archiveBytes),
  };
  assertCanonicalRecoveryArchiveRecord(record);
  return cloneRecovery(record);
}
