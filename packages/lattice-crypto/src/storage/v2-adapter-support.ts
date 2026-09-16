/**
 * Narrow, versioned support for trusted durable-storage adapters.
 *
 * This is deliberately one frozen facade instead of a loose export of the
 * internal storage policy. It lets an adapter consume the core's nominal,
 * single-use write capabilities and reuse canonical record validation without
 * exposing capability minting or generic opaque-byte construction.
 */

import { sha256 } from "@noble/hashes/sha2.js";

import {
  consumeAuthorizedAgentRuntimeInitializationWriteV2,
} from "../agent-runtime/initialization-authorized-write.ts";
import {
  consumeAuthorizedAgentRuntimeAuthorizationTransitionWriteV2,
  consumeAuthorizedAgentRuntimeChallengeReservationWriteV2,
  consumeAuthorizedAgentRuntimeRotationWriteV2,
} from "../agent-runtime/storage-authorized-write.ts";
import {
  canonicalizeParticipants,
  participantDigest,
} from "../domain/participants.ts";
import {
  consumeAuthorizedNamespaceBindingWriteV2,
} from "../namespace/authorized-write.ts";
import {
  consumeAuthorizedObjectAccessWriteV2,
  type ObjectAccessAuthorizationExpectationV2,
} from "../object/authorized-write.ts";
import {
  consumeAuthorizedProviderHeadWriteV2,
} from "../transition/provider-authorized-write.ts";
import { decodeObjectAccessStorageManifest } from
  "../format/object-access-manifest.ts";
import { decodeNamespaceObjectEnvelopeV2 } from "../format/object-v2.ts";
import {
  accessRevision,
  authorizationRevision,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceId,
  assertU64Counter,
} from "../v2-types/ids.ts";
import {
  assertOpaqueBytes,
  opaqueBytes,
} from "../v2-types/opaque.ts";
import type {
  AgentRuntimeAtomicStorageStateV2,
  AgentRuntimeAtomicStorageWireV2,
  AgentRuntimeChallengeReservationExpectationV2,
  AgentRuntimeRotationStorageExpectationV2,
  CryptoDomainPublicRecordV2,
  DomainProviderPublicStateV2,
  EncryptedObjectWireRecordV2,
  GrantWireRecordV2,
  NamespaceBindingRecordV2,
  NamespaceBindingWireRecordV2,
  NamespaceHeadV2,
  ObjectAccessManifestStorageHeadV2,
  ObjectAccessStorageStateV2,
  ObjectAccessStorageWireStateV2,
  OpaqueEncryptedObjectRecordV2,
  OpaqueGrantRecordV2,
  OpaqueRecoveryPackageRecordV2,
  RecoveryArchiveWireRecordV2,
  RecoveryArchiveStorageExpectationV2,
} from "./v2-records.ts";
import {
  assertAgentRuntimeAtomicState,
  assertAgentRuntimeChallengeReservationExpectation,
  assertAgentRuntimeRotationExpectation,
  assertCanonicalNamespaceBindingRecord,
  assertCanonicalRecoveryArchiveRecord,
  assertExactFields,
  assertHash,
  assertObjectAccessAuthorizationExpectation,
  assertObjectAccessHead,
  assertObjectAccessState,
  assertProviderHead,
  assertRosterBytes,
  bindingWireRecord,
  cloneBytes,
  cloneDomain,
  cloneHead,
  cloneProviderState,
  cloneRuntimeExpectation,
  encryptedObjectWriteRecordV2,
  equalBytes,
  equalStrings,
  grantWireRecord,
  grantWriteRecordV2,
  namespaceBindingWriteRecordV2,
  objectAccessWireState,
  objectWireRecord,
  recoveryArchiveWriteRecordV2,
  recoveryWireRecord,
  runtimeWireState,
} from "./v2-record-policy.ts";

function validateDomain(
  domain: CryptoDomainPublicRecordV2,
): CryptoDomainPublicRecordV2 {
  assertExactFields("Crypto Domain record", domain, [
    "id",
    "participantDigest",
    "participants",
    "epoch",
    "authorizationRevision",
    "rosterBytes",
  ]);
  cryptoDomainId(domain.id);
  domainEpoch(domain.epoch);
  authorizationRevision(domain.authorizationRevision);
  if (!Array.isArray(domain.participants as unknown)) {
    throw new TypeError("Crypto Domain participants must be an array");
  }
  const canonicalParticipants = canonicalizeParticipants(
    domain.participants.map(humanId),
  );
  if (!equalStrings(canonicalParticipants, domain.participants)) {
    throw new RangeError(
      "Crypto Domain participants must be in canonical unsigned UTF-8 order",
    );
  }
  assertHash("Crypto Domain participant digest", domain.participantDigest);
  assertRosterBytes("Crypto Domain roster bytes", domain.rosterBytes);
  if (
    !equalBytes(
      participantDigest(canonicalParticipants),
      domain.participantDigest,
    )
  ) {
    throw new Error(
      "Crypto Domain participant digest does not match canonical participants",
    );
  }
  return cloneDomain(domain);
}

function validateProviderState(
  state: DomainProviderPublicStateV2,
): DomainProviderPublicStateV2 {
  assertExactFields("Domain provider public state", state, [
    "head",
    "rosterBytes",
  ]);
  assertProviderHead("Domain provider head", state.head);
  assertRosterBytes("Domain provider roster bytes", state.rosterBytes);
  return cloneProviderState(state);
}

function validateNamespaceBinding(
  record: NamespaceBindingRecordV2 | NamespaceBindingWireRecordV2,
): NamespaceBindingWireRecordV2 {
  if ("humanKeyringEnvelopeBytes" in record) {
    assertExactFields("Namespace binding wire record", record, [
      "namespaceId",
      "revision",
      "bindingHash",
      "previousBindingHash",
      "signedBindingBytes",
      "humanKeyringEnvelopeBytes",
      "aiKeyringEnvelopeBytes",
    ]);
    const hydrated = namespaceBindingWriteRecordV2({
      signedBindingBytes: record.signedBindingBytes,
      humanKeyringEnvelopeBytes: record.humanKeyringEnvelopeBytes,
      aiKeyringEnvelopeBytes: record.aiKeyringEnvelopeBytes,
    });
    const canonical = bindingWireRecord(hydrated);
    if (
      record.namespaceId !== canonical.namespaceId
      || record.revision !== canonical.revision
      || !equalBytes(record.bindingHash, canonical.bindingHash)
      || (
        record.previousBindingHash === null
          ? canonical.previousBindingHash !== null
          : canonical.previousBindingHash === null
            || !equalBytes(
              record.previousBindingHash,
              canonical.previousBindingHash,
            )
      )
    ) {
      throw new Error(
        "Namespace binding durable coordinates do not match canonical wire bytes",
      );
    }
    return canonical;
  }
  assertCanonicalNamespaceBindingRecord(record);
  return bindingWireRecord(record);
}

function validateNamespaceHead(head: NamespaceHeadV2): NamespaceHeadV2 {
  assertExactFields("Namespace head", head, [
    "namespaceId",
    "accessRevision",
    "bindingHash",
    "domainId",
    "domainEpoch",
  ]);
  namespaceId(head.namespaceId);
  accessRevision(head.accessRevision);
  assertHash("Namespace head binding hash", head.bindingHash);
  cryptoDomainId(head.domainId);
  domainEpoch(head.domainEpoch);
  return cloneHead(head);
}

function validateEncryptedObject(
  record: OpaqueEncryptedObjectRecordV2 | EncryptedObjectWireRecordV2,
): EncryptedObjectWireRecordV2 {
  assertExactFields("Encrypted object record", record, [
    "objectId",
    "payloadBytes",
  ]);
  if (record.payloadBytes instanceof Uint8Array) {
    const canonical = objectWireRecord(
      encryptedObjectWriteRecordV2(record.payloadBytes),
    );
    if (record.objectId !== canonical.objectId) {
      throw new Error(
        "Encrypted object id does not match canonical payload bytes",
      );
    }
    return canonical;
  }
  assertOpaqueBytes(
    "Encrypted object payload",
    record.payloadBytes,
    "encrypted-payload",
  );
  const canonical = objectWireRecord(
    encryptedObjectWriteRecordV2(record.payloadBytes.ciphertext),
  );
  if (record.objectId !== canonical.objectId) {
    throw new Error(
      "Encrypted object id does not match canonical payload bytes",
    );
  }
  return canonical;
}

function objectAccessStateFromWire(
  state: ObjectAccessStorageWireStateV2,
): ObjectAccessStorageStateV2 {
  assertExactFields("Object access wire state", state, [
    "head",
    "namespaceEnvelopes",
  ]);
  return {
    head: state.head,
    namespaceEnvelopes: state.namespaceEnvelopes.map((envelope) => {
      assertExactFields("Namespace object envelope wire record", envelope, [
        "namespaceId",
        "envelopeHash",
        "envelopeBytes",
      ]);
      return {
        namespaceId: envelope.namespaceId,
        envelopeHash: envelope.envelopeHash,
        envelopeBytes: opaqueBytes(
          "namespace-object-envelope",
          envelope.envelopeBytes,
        ),
      };
    }),
  };
}

function validateObjectAccessState(
  state: ObjectAccessStorageStateV2 | ObjectAccessStorageWireStateV2,
): ObjectAccessStorageWireStateV2 {
  if (!Array.isArray(state.namespaceEnvelopes as unknown)) {
    throw new TypeError("Object access Namespace envelopes must be an array");
  }
  const opaque = state.namespaceEnvelopes.some(
    (envelope) => envelope.envelopeBytes instanceof Uint8Array,
  )
    ? objectAccessStateFromWire(state as ObjectAccessStorageWireStateV2)
    : state as ObjectAccessStorageStateV2;
  assertObjectAccessState(opaque);
  return objectAccessWireState(opaque);
}

function validateObjectAccessHead(
  head: ObjectAccessManifestStorageHeadV2,
): ObjectAccessManifestStorageHeadV2 {
  assertObjectAccessHead("Object access head", head);
  return {
    objectId: head.objectId,
    accessRevision: head.accessRevision,
    manifestHash: cloneBytes(head.manifestHash),
    manifestBytes: cloneBytes(head.manifestBytes),
  };
}

function validateObjectAccessAuthorizationExpectation(
  expectation: ObjectAccessAuthorizationExpectationV2,
): ObjectAccessAuthorizationExpectationV2 {
  assertObjectAccessAuthorizationExpectation(expectation);
  return structuredClone(expectation);
}

function humanV5GenesisAuthorizationMatchesState(
  expectation: ObjectAccessAuthorizationExpectationV2,
  state: ObjectAccessStorageStateV2 | ObjectAccessStorageWireStateV2,
): boolean {
  const authorization = validateObjectAccessAuthorizationExpectation(
    expectation,
  );
  if (authorization.kind !== "human-v5-genesis") return false;
  const intended = validateObjectAccessState(state);
  const manifest = decodeObjectAccessStorageManifest(
    intended.head.manifestBytes,
  );
  const expected = authorization.context.envelopes;
  const expectedByNamespace = new Map(
    expected.map((context) => [context.namespaceId, context] as const),
  );
  return manifest.formatVersion === 5
    && intended.namespaceEnvelopes.length === expected.length
    && manifest.envelopeHashes.length === expected.length
    && intended.namespaceEnvelopes.every((record, index) => {
      const context = expectedByNamespace.get(record.namespaceId);
      if (context === undefined) return false;
      const decoded = decodeNamespaceObjectEnvelopeV2(record.envelopeBytes);
      return record.namespaceId === context.namespaceId
        && decoded.context.objectId === context.objectId
        && decoded.context.namespaceId === context.namespaceId
        && decoded.context.keyClass === context.keyClass
        && decoded.context.keyGeneration === context.keyGeneration
        && decoded.context.bindingRevisionAtWrap
          === context.bindingRevisionAtWrap
        && equalBytes(record.envelopeHash, context.envelopeHash)
        && equalBytes(sha256(record.envelopeBytes), context.envelopeHash)
        && equalBytes(manifest.envelopeHashes[index]!, context.envelopeHash);
    });
}

function runtimeStateFromWire(
  state: AgentRuntimeAtomicStorageWireV2,
): AgentRuntimeAtomicStorageStateV2 {
  assertExactFields("Agent Runtime atomic wire state", state, [
    "runtime",
    "configInventory",
    "configObjects",
    "domainEnvelopes",
    "challengeConsumptions",
  ]);
  return {
    runtime: state.runtime,
    configInventory: state.configInventory,
    configObjects: state.configObjects.map((object) => {
      assertExactFields("Agent Runtime config wire record", object, [
        "agentId",
        "objectId",
        "configRevision",
        "runtimeGeneration",
        "wrappedDekHash",
        "wrappedDekBytes",
      ]);
      return {
        agentId: object.agentId,
        objectId: object.objectId,
        configRevision: object.configRevision,
        runtimeGeneration: object.runtimeGeneration,
        wrappedDekHash: object.wrappedDekHash,
        wrappedDek: opaqueBytes(
          "agent-runtime-config-dek",
          object.wrappedDekBytes,
        ),
      };
    }),
    domainEnvelopes: state.domainEnvelopes.map((envelope) => {
      assertExactFields("Agent Runtime Domain envelope wire record", envelope, [
        "agentId",
        "domainId",
        "domainEpoch",
        "agentAuthorizationRevision",
        "runtimeGeneration",
        "committerDeviceId",
        "envelopeHash",
        "envelopeBytes",
      ]);
      return {
        agentId: envelope.agentId,
        domainId: envelope.domainId,
        domainEpoch: envelope.domainEpoch,
        agentAuthorizationRevision: envelope.agentAuthorizationRevision,
        runtimeGeneration: envelope.runtimeGeneration,
        committerDeviceId: envelope.committerDeviceId,
        envelopeHash: envelope.envelopeHash,
        envelopeBytes: opaqueBytes(
          "agent-runtime-domain-envelope",
          envelope.envelopeBytes,
        ),
      };
    }),
    challengeConsumptions: state.challengeConsumptions,
  };
}

function validateAgentRuntimeAtomicState(
  state: AgentRuntimeAtomicStorageStateV2 | AgentRuntimeAtomicStorageWireV2,
): AgentRuntimeAtomicStorageWireV2 {
  if (
    !Array.isArray(state.configObjects as unknown)
    || !Array.isArray(state.domainEnvelopes as unknown)
    || !Array.isArray(state.challengeConsumptions as unknown)
  ) {
    throw new TypeError("Agent Runtime durable collections must be arrays");
  }
  const isWire = state.configObjects.some(
    (object) => object !== null && "wrappedDekBytes" in object,
  ) || state.domainEnvelopes.some(
    (envelope) =>
      envelope !== null && envelope.envelopeBytes instanceof Uint8Array,
  );
  const opaque = isWire
    ? runtimeStateFromWire(state as AgentRuntimeAtomicStorageWireV2)
    : state as AgentRuntimeAtomicStorageStateV2;
  assertAgentRuntimeAtomicState(opaque);
  return runtimeWireState(opaque);
}

function validateAgentRuntimeChallengeReservationExpectation(
  expectation: AgentRuntimeChallengeReservationExpectationV2,
): AgentRuntimeChallengeReservationExpectationV2 {
  assertAgentRuntimeChallengeReservationExpectation(expectation);
  return {
    runtime: { ...expectation.runtime },
    challengeConsumptions: expectation.challengeConsumptions.map(
      (challenge) => ({
        challengeHash: cloneBytes(challenge.challengeHash),
        consumed: challenge.consumed,
      }),
    ),
  };
}

function validateAgentRuntimeRotationExpectation(
  expectation: AgentRuntimeRotationStorageExpectationV2,
): AgentRuntimeRotationStorageExpectationV2 {
  assertAgentRuntimeRotationExpectation(expectation);
  return {
    ...cloneRuntimeExpectation(expectation),
    configObjects: expectation.configObjects.map((object) => ({
      ...object,
      wrappedDekHash: cloneBytes(object.wrappedDekHash),
    })),
  };
}

function validateGrant(
  record: OpaqueGrantRecordV2 | GrantWireRecordV2,
): GrantWireRecordV2 {
  assertExactFields("Grant record", record, [
    "grantId",
    "grantBytes",
    "consumed",
  ]);
  if (typeof record.consumed !== "boolean") {
    throw new TypeError("Grant consumed state must be boolean");
  }
  const grantBytes = record.grantBytes instanceof Uint8Array
    ? record.grantBytes
    : (() => {
        assertOpaqueBytes("Grant", record.grantBytes, "grant");
        return record.grantBytes.ciphertext;
      })();
  const canonical = grantWireRecord(grantWriteRecordV2(grantBytes));
  if (canonical.grantId !== record.grantId) {
    throw new Error("Grant id does not match canonical Grant wire bytes");
  }
  return {
    ...canonical,
    consumed: record.consumed,
  };
}

function validateRecoveryArchive(
  record: OpaqueRecoveryPackageRecordV2 | RecoveryArchiveWireRecordV2,
): RecoveryArchiveWireRecordV2 {
  assertExactFields("Recovery archive record", record, [
    "humanId",
    "recoveryKeyGeneration",
    "archiveBytes",
  ]);
  if (record.archiveBytes instanceof Uint8Array) {
    const canonical = recoveryWireRecord(
      recoveryArchiveWriteRecordV2(record.archiveBytes),
    );
    if (
      record.humanId !== canonical.humanId
      || record.recoveryKeyGeneration !== canonical.recoveryKeyGeneration
    ) {
      throw new Error(
        "Recovery archive durable coordinates do not match canonical wire bytes",
      );
    }
    return canonical;
  }
  const opaqueRecord = record as OpaqueRecoveryPackageRecordV2;
  assertCanonicalRecoveryArchiveRecord(opaqueRecord);
  return recoveryWireRecord(opaqueRecord);
}

function validateRecoveryArchiveExpectation(
  expectation: RecoveryArchiveStorageExpectationV2,
): RecoveryArchiveStorageExpectationV2 {
  assertExactFields("Recovery archive expectation", expectation, [
    "humanId",
    "recoveryKeyGeneration",
    "archiveHash",
  ]);
  humanId(expectation.humanId);
  assertU64Counter(
    "Expected recovery key generation",
    expectation.recoveryKeyGeneration,
  );
  assertHash("Expected recovery archive hash", expectation.archiveHash);
  return {
    humanId: expectation.humanId,
    recoveryKeyGeneration: expectation.recoveryKeyGeneration,
    archiveHash: cloneBytes(expectation.archiveHash),
  };
}

export const storageAdapterSupportV2 = Object.freeze({
  consumeProviderHeadWrite: consumeAuthorizedProviderHeadWriteV2,
  consumeNamespaceBindingWrite: consumeAuthorizedNamespaceBindingWriteV2,
  consumeObjectAccessWrite: consumeAuthorizedObjectAccessWriteV2,
  consumeAgentRuntimeInitializationWrite:
    consumeAuthorizedAgentRuntimeInitializationWriteV2,
  consumeAgentRuntimeChallengeReservationWrite:
    consumeAuthorizedAgentRuntimeChallengeReservationWriteV2,
  consumeAgentRuntimeRotationWrite:
    consumeAuthorizedAgentRuntimeRotationWriteV2,
  consumeAgentRuntimeAuthorizationTransitionWrite:
    consumeAuthorizedAgentRuntimeAuthorizationTransitionWriteV2,
  validateDomain,
  validateProviderState,
  validateNamespaceBinding,
  validateNamespaceHead,
  validateEncryptedObject,
  validateObjectAccessHead,
  validateObjectAccessAuthorizationExpectation,
  humanV5GenesisAuthorizationMatchesState,
  validateObjectAccessState,
  validateAgentRuntimeAtomicState,
  validateAgentRuntimeChallengeReservationExpectation,
  validateAgentRuntimeRotationExpectation,
  validateGrant,
  validateRecoveryArchive,
  validateRecoveryArchiveExpectation,
});

export type StorageAdapterSupportV2 = typeof storageAdapterSupportV2;
