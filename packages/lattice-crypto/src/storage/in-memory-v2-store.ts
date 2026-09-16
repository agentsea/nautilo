/** Detached reference implementation of the v2 durable storage contract. */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  canonicalizeParticipants,
  participantDigest,
} from "../domain/participants.ts";
import { decodeObjectAccessManifestV2 } from "../format/object-access-manifest-v2.ts";
import {
  decodeObjectAccessStorageManifest,
} from "../format/object-access-manifest.ts";
import { decodeEncryptedPayloadV2 } from "../format/object-v2.ts";
import { parseGrantV2 } from "../format/grant-v2.ts";
import {
  type ProviderPublicHeadV2,
  providerHeadsEqualV2,
} from "../transition/provider-candidate.ts";
import {
  consumeAuthorizedAgentRuntimeInitializationWriteV2,
  type AuthorizedAgentRuntimeInitializationWriteV2,
} from "../agent-runtime/initialization-authorized-write.ts";
import {
  consumeAuthorizedAgentRuntimeAuthorizationTransitionWriteV2,
  consumeAuthorizedAgentRuntimeChallengeReservationWriteV2,
  consumeAuthorizedAgentRuntimeRotationWriteV2,
  type AuthorizedAgentRuntimeAuthorizationTransitionWriteV2,
  type AuthorizedAgentRuntimeChallengeReservationWriteV2,
  type AuthorizedAgentRuntimeRotationWriteV2,
} from "../agent-runtime/storage-authorized-write.ts";
import {
  decodeAgentRuntimeSignerPublicationV1,
  encodeAgentRuntimeSignerPublicationV1,
  type AgentRuntimeSignerPublicationV1,
} from "../agent-runtime/signer-publication-v1.ts";
import {
  consumeAuthorizedNamespaceBindingWriteV2,
  type AuthorizedNamespaceBindingWriteV2,
} from "../namespace/authorized-write.ts";
import {
  consumeAuthorizedProviderHeadWriteV2,
  type AuthorizedProviderHeadWriteV2,
} from "../transition/provider-authorized-write.ts";
import {
  consumeAuthorizedObjectAccessWriteV2,
  type AuthorizedObjectAccessWriteV2,
} from "../object/authorized-write.ts";
import {
  accessRevision,
  agentId,
  authorizationRevision,
  cryptoDomainId,
  domainEpoch,
  grantId,
  humanId,
  namespaceId,
  objectId,
  assertU64Counter,
} from "../v2-types/ids.ts";
import { assertV2Limit, V2_LIMITS } from "../v2-types/limits.ts";
import { assertOpaqueBytes } from "../v2-types/opaque.ts";
import type { V2Storage } from "./v2-storage-contract.ts";
import { storageAdapterSupportV2 } from "./v2-adapter-support.ts";
import type {
  CryptoDomainPublicRecordV2,
  NamespaceBindingRecordV2,
  NamespaceBindingWireRecordV2,
  NamespaceHeadV2,
  OpaqueEncryptedObjectRecordV2,
  EncryptedObjectWireRecordV2,
  ObjectAccessStorageStateV2,
  ObjectAccessStorageWireStateV2,
  ObjectAccessStateCasStatusV2,
  AgentRuntimeAtomicStorageStateV2,
  AgentRuntimeRotationCasStatusV2,
  AgentRuntimeAuthorizationTransitionCasStatusV2,
  AgentRuntimeChallengeReservationCasStatusV2,
  OpaqueGrantRecordV2,
  GrantWireRecordV2,
  OpaqueRecoveryPackageRecordV2,
  RecoveryArchiveWireRecordV2,
  AgentRuntimeAtomicStorageWireV2,
  RecoveryArchiveStorageExpectationV2,
  RecoveryArchiveCasStatusV2,
  CreateDomainResultV2,
  DomainProviderPublicStateV2,
  DomainProviderHeadCasStatusV2,
  NamespaceBindingHeadCasStatusV2,
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
  cloneAtomicRuntimeState,
  cloneBinding,
  cloneBytes,
  cloneDomain,
  cloneGrant,
  cloneHead,
  cloneObject,
  cloneObjectAccessState,
  cloneProviderState,
  cloneRecovery,
  cloneRuntimeExpectation,
  compareBytes,
  equalAtomicRuntimeStates,
  equalBindings,
  equalBytes,
  equalObjectAccessHeads,
  equalObjectAccessStates,
  equalStrings,
  grantWireRecord,
  objectAccessWireState,
  objectWireRecord,
  recoveryWireRecord,
  runtimeWireState,
} from "./v2-record-policy.ts";

function rejected(error: unknown): Promise<never> {
  return Promise.reject(
    error instanceof Error ? error : new Error(String(error)),
  );
}

const portableTextEncoder = new TextEncoder();

function comparePortableText(left: string, right: string): number {
  return compareBytes(
    portableTextEncoder.encode(left),
    portableTextEncoder.encode(right),
  );
}

function runtimeSignerPublicationKey(
  agentIdValue: string,
  runtimeGenerationValue: number,
): string {
  return `${agentIdValue}\0${String(runtimeGenerationValue)}`;
}

function cloneSignerPublication(
  publication: AgentRuntimeSignerPublicationV1,
): AgentRuntimeSignerPublicationV1 {
  return decodeAgentRuntimeSignerPublicationV1(
    encodeAgentRuntimeSignerPublicationV1(publication),
  );
}

function equalSignerPublications(
  left: AgentRuntimeSignerPublicationV1,
  right: AgentRuntimeSignerPublicationV1,
): boolean {
  return equalBytes(
    encodeAgentRuntimeSignerPublicationV1(left),
    encodeAgentRuntimeSignerPublicationV1(right),
  );
}

/**
 * Detached reference implementation for tests and the later bridge contract.
 * Every method completes its decision synchronously before returning a
 * Promise, so create-if-absent and compare-and-swap are atomic in this store.
 */
export class InMemoryV2Store implements V2Storage {
  private readonly domainsByDigest = new Map<
    string,
    CryptoDomainPublicRecordV2[]
  >();
  private readonly domainsById = new Map<string, CryptoDomainPublicRecordV2>();
  private readonly domainProviderStates = new Map<
    string,
    DomainProviderPublicStateV2
  >();
  private readonly bindings = new Map<
    string,
    Map<number, NamespaceBindingRecordV2>
  >();
  private readonly namespaceHeads = new Map<string, NamespaceHeadV2>();
  private readonly objects = new Map<string, OpaqueEncryptedObjectRecordV2>();
  private readonly objectAccessStates = new Map<
    string,
    ObjectAccessStorageStateV2
  >();
  private readonly atomicRuntimeStates = new Map<
    string,
    AgentRuntimeAtomicStorageStateV2
  >();
  private readonly agentRuntimeSignerPublications = new Map<
    string,
    AgentRuntimeSignerPublicationV1
  >();
  private readonly grants = new Map<string, OpaqueGrantRecordV2>();
  private readonly recoveryArchives = new Map<
    string,
    OpaqueRecoveryPackageRecordV2
  >();

  findDomain(
    inputDigest: Uint8Array,
    exactParticipants: readonly string[],
  ): Promise<CryptoDomainPublicRecordV2 | null> {
    try {
      assertHash("Crypto Domain lookup digest", inputDigest);
      if (!Array.isArray(exactParticipants as unknown)) {
        throw new TypeError(
          "Crypto Domain lookup participants must be an array",
        );
      }
      const canonicalParticipants = canonicalizeParticipants(
        exactParticipants.map(humanId),
      );
      if (!equalStrings(canonicalParticipants, exactParticipants)) {
        throw new RangeError(
          "Crypto Domain lookup participants must be in canonical unsigned UTF-8 order",
        );
      }
      const expectedDigest = participantDigest(canonicalParticipants);
      if (!equalBytes(expectedDigest, inputDigest)) {
        throw new Error(
          "Crypto Domain lookup digest does not match canonical participants",
        );
      }
      const candidates =
        this.domainsByDigest.get(bytesToHex(expectedDigest)) ?? [];
      const match = candidates.find((candidate) =>
        equalStrings(candidate.participants, canonicalParticipants)
      );
      return Promise.resolve(match ? cloneDomain(match) : null);
    } catch (error) {
      return rejected(error);
    }
  }

  createDomainIfAbsent(
    domain: CryptoDomainPublicRecordV2,
  ): Promise<CreateDomainResultV2> {
    try {
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
      assertHash(
        "Crypto Domain participant digest",
        domain.participantDigest,
      );
      assertRosterBytes("Crypto Domain roster bytes", domain.rosterBytes);
      const expectedDigest = participantDigest(canonicalParticipants);
      if (!equalBytes(expectedDigest, domain.participantDigest)) {
        throw new Error(
          "Crypto Domain participant digest does not match canonical participants",
        );
      }
      const domainWithSameId = this.domainsById.get(domain.id);
      if (
        domainWithSameId
        && (
          !equalBytes(
            domainWithSameId.participantDigest,
            domain.participantDigest,
          )
          || !equalStrings(
            domainWithSameId.participants,
            domain.participants,
          )
        )
      ) {
        throw new Error(
          "Domain id is already bound to another participant set",
        );
      }
      const digest = bytesToHex(expectedDigest);
      const candidates = this.domainsByDigest.get(digest) ?? [];
      const existing = candidates.find((candidate) =>
        equalStrings(candidate.participants, domain.participants)
      );
      if (existing) {
        return Promise.resolve({
          status: "existing",
          domain: cloneDomain(existing),
        });
      }
      const stored = cloneDomain(domain);
      candidates.push(stored);
      this.domainsByDigest.set(digest, candidates);
      this.domainsById.set(stored.id, stored);
      return Promise.resolve({
        status: "created",
        domain: cloneDomain(stored),
      });
    } catch (error) {
      return rejected(error);
    }
  }

  listDomains(): Promise<CryptoDomainPublicRecordV2[]> {
    return Promise.resolve(
      [...this.domainsByDigest.values()].flat().map(cloneDomain),
    );
  }

  putDomainProviderHeadIfAbsent(
    head: ProviderPublicHeadV2,
    rosterBytes: Uint8Array,
  ): Promise<"inserted" | "existing"> {
    try {
      assertProviderHead("Domain provider head", head);
      assertRosterBytes("Domain provider roster bytes", rosterBytes);
      const domain = this.domainsById.get(head.domainId);
      if (!domain) {
        throw new Error("Domain provider head requires an existing Domain");
      }
      if (
        domain.epoch !== head.epoch
        || !equalBytes(domain.rosterBytes, rosterBytes)
      ) {
        throw new Error(
          "Domain provider head does not match the current Domain public state",
        );
      }
      const existing = this.domainProviderStates.get(head.domainId);
      if (existing) {
        if (
          !providerHeadsEqualV2(existing.head, head)
          || !equalBytes(existing.rosterBytes, rosterBytes)
        ) {
          throw new Error(
            "Domain provider head is already initialized with different public state",
          );
        }
        return Promise.resolve("existing");
      }
      this.domainProviderStates.set(
        head.domainId,
        cloneProviderState({ head, rosterBytes }),
      );
      return Promise.resolve("inserted");
    } catch (error) {
      return rejected(error);
    }
  }

  getDomainProviderHead(
    domainId: string,
  ): Promise<ProviderPublicHeadV2 | null> {
    try {
      cryptoDomainId(domainId);
      const state = this.domainProviderStates.get(domainId);
      return Promise.resolve(
        state ? cloneProviderState(state).head : null,
      );
    } catch (error) {
      return rejected(error);
    }
  }

  compareAndSwapDomainProviderHead(
    authorized: AuthorizedProviderHeadWriteV2,
  ): Promise<DomainProviderHeadCasStatusV2> {
    try {
      const {
        expected,
        next,
        nextRosterBytes,
        authorization,
      } = consumeAuthorizedProviderHeadWriteV2(authorized);
      assertProviderHead("Expected Domain provider head", expected);
      assertProviderHead("Next Domain provider head", next);
      assertRosterBytes(
        "Next Domain provider roster bytes",
        nextRosterBytes,
      );
      if (
        expected.providerId !== next.providerId
        || expected.domainId !== next.domainId
        || Number(next.epoch) !== Number(expected.epoch) + 1
      ) {
        throw new Error(
          "Domain provider CAS requires one exact same-provider epoch advance",
        );
      }

      const current = this.domainProviderStates.get(expected.domainId);
      const domain = this.domainsById.get(expected.domainId);
      if (!current || !domain) return Promise.resolve("stale");
      if (
        domain.authorizationRevision
          !== authorization.authorizationRevision
      ) {
        return Promise.resolve("stale");
      }
      if (providerHeadsEqualV2(current.head, next)) {
        return Promise.resolve(
          equalBytes(current.rosterBytes, nextRosterBytes)
            ? "duplicate"
            : "stale",
        );
      }
      if (
        !providerHeadsEqualV2(current.head, expected)
        || !equalBytes(domain.rosterBytes, current.rosterBytes)
      ) {
        return Promise.resolve("stale");
      }

      const nextState = cloneProviderState({
        head: next,
        rosterBytes: nextRosterBytes,
      });
      const nextDomain = cloneDomain({
        ...domain,
        epoch: Number(next.epoch),
        rosterBytes: nextRosterBytes,
      });
      const digest = bytesToHex(domain.participantDigest);
      const domains = this.domainsByDigest.get(digest)!;
      const domainIndex = domains.findIndex(
        (candidate) => candidate.id === domain.id,
      );
      if (domainIndex < 0) {
        return Promise.resolve("stale");
      }

      // All checks and detached allocations finish before either public map
      // changes. The reference store then publishes both records in one
      // synchronous decision.
      domains[domainIndex] = nextDomain;
      this.domainsById.set(nextDomain.id, nextDomain);
      this.domainProviderStates.set(next.domainId, nextState);
      return Promise.resolve("applied");
    } catch (error) {
      return rejected(error);
    }
  }

  getBinding(
    namespaceId: string,
    revision: number,
  ): Promise<NamespaceBindingWireRecordV2 | null> {
    const binding = this.bindings.get(namespaceId)?.get(revision);
    return Promise.resolve(binding ? bindingWireRecord(binding) : null);
  }

  getNamespaceHead(namespaceId: string): Promise<NamespaceHeadV2 | null> {
    const head = this.namespaceHeads.get(namespaceId);
    return Promise.resolve(head ? cloneHead(head) : null);
  }

  compareAndSwapNamespaceBindingAndHead(
    authorized: AuthorizedNamespaceBindingWriteV2,
  ): Promise<NamespaceBindingHeadCasStatusV2> {
    try {
      const { expected, binding, next } =
        consumeAuthorizedNamespaceBindingWriteV2(authorized);
      const signed = assertCanonicalNamespaceBindingRecord(binding);
      assertExactFields("Next Namespace head", next, [
        "namespaceId",
        "accessRevision",
        "bindingHash",
        "domainId",
        "domainEpoch",
      ]);
      namespaceId(next.namespaceId);
      accessRevision(next.accessRevision);
      cryptoDomainId(next.domainId);
      domainEpoch(next.domainEpoch);
      assertHash("Next Namespace binding hash", next.bindingHash);
      if (expected !== null) {
        assertExactFields("Expected Namespace head", expected, [
          "namespaceId",
          "accessRevision",
          "bindingHash",
        ]);
        namespaceId(expected.namespaceId);
        accessRevision(expected.accessRevision);
        assertHash(
          "Expected Namespace binding hash",
          expected.bindingHash,
        );
      }
      if (
        binding.namespaceId !== next.namespaceId
        || binding.revision !== next.accessRevision
        || !equalBytes(binding.bindingHash, next.bindingHash)
        || signed.domainId !== next.domainId
        || signed.domainEpoch !== next.domainEpoch
      ) {
        throw new Error(
          "Namespace atomic CAS binding and head coordinates differ",
        );
      }

      const current = this.namespaceHeads.get(next.namespaceId);
      const revisions = this.bindings.get(next.namespaceId)
        ?? new Map<number, NamespaceBindingRecordV2>();
      const existing = revisions.get(next.accessRevision);
      if (
        current !== undefined
        && equalBytes(current.bindingHash, next.bindingHash)
      ) {
        if (existing === undefined) return Promise.resolve("stale");
        if (equalBindings(existing, binding)) {
          return Promise.resolve("duplicate");
        }
      }
      if (expected === null) {
        if (
          current !== undefined
          || next.accessRevision !== 0
        ) {
          return Promise.resolve("stale");
        }
      } else if (
        expected.namespaceId !== next.namespaceId
        || current === undefined
        || current.accessRevision !== expected.accessRevision
        || !equalBytes(current.bindingHash, expected.bindingHash)
        || next.accessRevision !== expected.accessRevision + 1
        || !equalBytes(
          binding.previousBindingHash!,
          expected.bindingHash,
        )
      ) {
        return Promise.resolve("stale");
      }

      const detachedBinding = cloneBinding(binding);
      const detachedHead = cloneHead(next);
      revisions.set(detachedBinding.revision, detachedBinding);
      this.bindings.set(detachedBinding.namespaceId, revisions);
      this.namespaceHeads.set(detachedHead.namespaceId, detachedHead);
      return Promise.resolve("applied");
    } catch (error) {
      return rejected(error);
    }
  }

  putObject(object: OpaqueEncryptedObjectRecordV2): Promise<void> {
    try {
      assertExactFields("Encrypted object record", object, [
        "objectId",
        "payloadBytes",
      ]);
      objectId(object.objectId);
      assertOpaqueBytes(
        "Object payload",
        object.payloadBytes,
        "encrypted-payload",
      );
      assertV2Limit(
        "Encrypted payload bytes",
        object.payloadBytes.ciphertext.length,
        V2_LIMITS.ciphertextBytes,
      );
      const payload = decodeEncryptedPayloadV2(
        object.payloadBytes.ciphertext,
      );
      if (payload.context.objectId !== object.objectId) {
        throw new Error(
          "Encrypted object id does not match its canonical payload",
        );
      }
      const existing = this.objects.get(object.objectId);
      if (existing) {
        if (
          !equalBytes(
            existing.payloadBytes.ciphertext,
            object.payloadBytes.ciphertext,
          )
        ) {
          throw new Error(
            "Encrypted object is already initialized with different payload bytes",
          );
        }
        return Promise.resolve();
      }
    } catch (error) {
      return rejected(error);
    }
    this.objects.set(object.objectId, cloneObject(object));
    return Promise.resolve();
  }

  getObject(
    objectId: string,
  ): Promise<EncryptedObjectWireRecordV2 | null> {
    const object = this.objects.get(objectId);
    return Promise.resolve(object ? objectWireRecord(object) : null);
  }

  getObjectAccessState(
    objectId: string,
  ): Promise<ObjectAccessStorageWireStateV2 | null> {
    const state = this.objectAccessStates.get(objectId);
    return Promise.resolve(state ? objectAccessWireState(state) : null);
  }

  compareAndSwapObjectAccessState(
    authorized: AuthorizedObjectAccessWriteV2,
  ): Promise<ObjectAccessStateCasStatusV2> {
    try {
      const {
        expected,
        intended,
        authorization,
      } = consumeAuthorizedObjectAccessWriteV2(authorized);
      if (expected !== null) {
        assertObjectAccessHead("Expected object access head", expected);
        if (expected.objectId !== intended.head.objectId) {
          throw new Error(
            "Object access CAS expected and intended object ids differ",
          );
        }
      }
      assertObjectAccessState(intended);
      assertObjectAccessAuthorizationExpectation(authorization);
      const intendedManifest = decodeObjectAccessStorageManifest(
        intended.head.manifestBytes,
      );
      const payload = this.objects.get(intended.head.objectId);
      if (
        payload === undefined
        || !equalBytes(
          sha256(payload.payloadBytes.ciphertext),
          intendedManifest.payloadHash,
        )
      ) {
        return Promise.resolve("stale");
      }
      const current = this.objectAccessStates.get(intended.head.objectId);
      if (expected === null) {
        if (authorization.kind === "agent-genesis") {
          const context = authorization.context;
          const grant = this.grants.get(context.grantId);
          const parsedGrant = grant === undefined
            ? null
            : parseGrantV2(grant.grantBytes.ciphertext);
          const namespaceHead =
            this.namespaceHeads.get(context.namespaceId);
          const domain = this.domainsById.get(context.domainId);
          const runtime = this.atomicRuntimeStates.get(context.agentId);
          const signer = this.agentRuntimeSignerPublications.get(
            runtimeSignerPublicationKey(
              context.agentId,
              context.runtimeGeneration,
            ),
          );
          const matchingRuntimeDomains =
            runtime?.domainEnvelopes.filter((record) =>
              record.agentId === context.agentId
              && record.domainId === context.domainId
              && record.domainEpoch === context.domainEpoch
              && record.agentAuthorizationRevision
                === context.agentAuthorizationRevision
              && record.runtimeGeneration === context.runtimeGeneration
            ) ?? [];
          if (
            intendedManifest.formatVersion !== 3
            || intendedManifest.accessRevision !== 0
            || intendedManifest.objectId !== context.objectId
            || !equalBytes(
              intendedManifest.payloadHash,
              context.payloadHash,
            )
            || intendedManifest.hostAuthorizationRevision
              !== context.agentAuthorizationRevision
            || intendedManifest.signer.agentId !== context.agentId
            || intendedManifest.signer.runtimeGeneration
              !== context.runtimeGeneration
            || intendedManifest.signer.signerKeyId
              !== context.signerKeyId
            || context.envelope.objectId !== context.objectId
            || context.envelope.namespaceId !== context.namespaceId
            || context.envelope.keyClass !== "ai"
            || context.envelope.bindingRevisionAtWrap
              !== context.namespaceAccessRevision
            || grant === undefined
            || parsedGrant === null
            || parsedGrant.id !== context.grantId
            || !equalBytes(
              sha256(grant.grantBytes.ciphertext),
              context.grantHash,
            )
            || parsedGrant.recipientAgentId !== context.agentId
            || !parsedGrant.operations.includes("encrypt")
            || !parsedGrant.coveredDomains.some((covered) =>
              covered.domainId === context.domainId
              && covered.domainEpoch === context.domainEpoch
              && covered.agentAuthorizationRevision
                === context.agentAuthorizationRevision
            )
            || (
              context.grantUseStatus === "reusable"
                ? parsedGrant.singleUse || grant.consumed
                : !parsedGrant.singleUse || !grant.consumed
            )
            || namespaceHead === undefined
            || namespaceHead.namespaceId !== context.namespaceId
            || namespaceHead.accessRevision
              !== context.namespaceAccessRevision
            || !equalBytes(
              namespaceHead.bindingHash,
              context.namespaceBindingHash,
            )
            || namespaceHead.domainId !== context.domainId
            || namespaceHead.domainEpoch !== context.domainEpoch
            || domain === undefined
            || domain.id !== context.domainId
            || domain.epoch !== context.domainEpoch
            || runtime === undefined
            || runtime.runtime.agentId !== context.agentId
            || runtime.runtime.authorizationRevision
              !== context.agentAuthorizationRevision
            || runtime.runtime.runtimeGeneration
              !== context.runtimeGeneration
            || matchingRuntimeDomains.length !== 1
            || signer === undefined
            || !equalSignerPublications(
              signer,
              authorization.signerPublication,
            )
          ) return Promise.resolve("stale");
        } else if (
          authorization.kind
            === "device-wrapped-live-shadow-agent-genesis-set"
        ) {
          const context = authorization.context;
          if (
            intendedManifest.formatVersion !== 5
            || intendedManifest.accessRevision !== 0
            || intendedManifest.previousManifestHash !== null
            || intendedManifest.objectId !== context.objectId
            || !equalBytes(intendedManifest.payloadHash, context.payloadHash)
            || intendedManifest.hostAuthorizationRevision
              !== context.agentAuthorizationRevision
            || intendedManifest.signer.kind !== "agent_runtime"
            || intendedManifest.signer.agentId !== context.agentId
            || intendedManifest.signer.runtimeGeneration
              !== context.runtimeGeneration
            || intendedManifest.signer.signerKeyId !== context.signerKeyId
            || context.envelopes.length !== context.namespaces.length
            || context.envelopes.some((envelope, index) => {
              const namespace = context.namespaces[index]!;
              return envelope.objectId !== context.objectId
                || envelope.namespaceId !== namespace.namespaceId
                || envelope.keyClass !== "ai"
                || envelope.keyGeneration !== namespace.keyGeneration
                || envelope.bindingRevisionAtWrap !== namespace.accessRevision;
            })
          ) return Promise.resolve("stale");
        } else if (
          authorization.kind
            === "device-wrapped-live-shadow-agent-genesis"
        ) {
          const context = authorization.context;
          if (
            intendedManifest.formatVersion !== 3
            || intendedManifest.accessRevision !== 0
            || intendedManifest.objectId !== context.objectId
            || !equalBytes(intendedManifest.payloadHash, context.payloadHash)
            || intendedManifest.hostAuthorizationRevision
              !== context.agentAuthorizationRevision
            || intendedManifest.signer.agentId !== context.agentId
            || intendedManifest.signer.runtimeGeneration
              !== context.runtimeGeneration
            || intendedManifest.signer.signerKeyId !== context.signerKeyId
            || context.envelope.objectId !== context.objectId
            || context.envelope.namespaceId !== context.namespaceId
            || context.envelope.keyClass !== "ai"
            || context.envelope.keyGeneration < 0
            || context.envelope.bindingRevisionAtWrap
              !== context.namespaceAccessRevision
          ) return Promise.resolve("stale");
        } else if (authorization.kind === "human-v5-genesis") {
          const context = authorization.context;
          if (
            intendedManifest.formatVersion !== 5
            || intendedManifest.signer.kind !== "human_device"
            || intendedManifest.accessRevision !== 0
            || intendedManifest.previousManifestHash !== null
            || intendedManifest.objectId !== context.objectId
            || !equalBytes(intendedManifest.payloadHash, context.payloadHash)
            || intendedManifest.signer.subjectHumanId
              !== context.subjectHumanId
            || intendedManifest.signer.committerDeviceId
              !== context.committerDeviceId
            || intendedManifest.hostAuthorizationRevision
              !== authorization.currentHostAuthorizationRevision
            || context.hostAuthorizationRevision
              !== authorization.currentHostAuthorizationRevision
            || !storageAdapterSupportV2
              .humanV5GenesisAuthorizationMatchesState(
                authorization,
                intended,
              )
          ) return Promise.resolve("stale");
        } else if (
          authorization.kind !== "genesis"
          || intendedManifest.formatVersion !== 2
          || authorization.context.objectId !== intended.head.objectId
          || !equalBytes(
            authorization.context.payloadHash,
            intendedManifest.payloadHash,
          )
          || authorization.context.hostAuthorizationRevision
            !== authorization.currentHostAuthorizationRevision
          || intendedManifest.hostAuthorizationRevision
            !== authorization.currentHostAuthorizationRevision
          || intended.head.accessRevision !== 0
        ) return Promise.resolve("stale");
      } else {
        if (intendedManifest.formatVersion !== 2) {
          return Promise.resolve("stale");
        }
        const expectedManifest = decodeObjectAccessManifestV2(
          expected.manifestBytes,
        );
        // Keep the discriminant guard explicit so every wrong-mode call
        // returns the CAS contract's stale result rather than falling through
        // into update-only context fields.
        if (authorization.kind !== "update") {
          return Promise.resolve("stale");
        }
        if (
          authorization.context.objectId !== intended.head.objectId
          || !equalObjectAccessHeads(
            authorization.context.currentHead,
            expected,
          )
          || !equalObjectAccessHeads(
            authorization.context.nextHead,
            intended.head,
          )
          || !equalBytes(
            authorization.context.payloadHash,
            intendedManifest.payloadHash,
          )
          || authorization.context
            .currentManifestHostAuthorizationRevision
            !== authorization.currentManifestHostAuthorizationRevision
          || authorization.context.hostAuthorizationRevision
            !== authorization.currentHostAuthorizationRevision
          || expectedManifest.hostAuthorizationRevision
            !== authorization.currentManifestHostAuthorizationRevision
          || intendedManifest.hostAuthorizationRevision
            !== authorization.currentHostAuthorizationRevision
          || intended.head.accessRevision !== expected.accessRevision + 1
        ) {
          return Promise.resolve("stale");
        }
        if (
          !equalBytes(
            intendedManifest.previousManifestHash!,
            expected.manifestHash,
          )
        ) {
          return Promise.resolve("stale");
        }
      }
      if (current && equalObjectAccessStates(current, intended)) {
        return Promise.resolve("duplicate");
      }
      if (
        expected === null
          ? current !== undefined
          : current === undefined
            || !equalObjectAccessHeads(current.head, expected)
      ) {
        return Promise.resolve("stale");
      }
      const detached = cloneObjectAccessState(intended);
      this.objectAccessStates.set(detached.head.objectId, detached);
      return Promise.resolve("applied");
    } catch (error) {
      return rejected(error);
    }
  }

  putAgentRuntimeAtomicStateIfAbsent(
    authorized: AuthorizedAgentRuntimeInitializationWriteV2,
  ): Promise<"inserted" | "existing" | "stale"> {
    try {
      const { state, signerPublication } =
        consumeAuthorizedAgentRuntimeInitializationWriteV2(authorized);
      assertAgentRuntimeAtomicState(state);
      if (
        signerPublication.agentId !== state.runtime.agentId
        || signerPublication.runtimeGeneration
          !== state.runtime.runtimeGeneration
        || signerPublication.authorizationRevision
          !== state.runtime.authorizationRevision
      ) {
        throw new Error(
          "Agent Runtime initialization signer publication does not match its state",
        );
      }
      const existing = this.atomicRuntimeStates.get(state.runtime.agentId);
      if (existing) {
        if (!equalAtomicRuntimeStates(existing, state)) {
          throw new Error(
            "Agent Runtime atomic state is already initialized with different bytes",
          );
        }
        const existingPublication = this.agentRuntimeSignerPublications.get(
          runtimeSignerPublicationKey(
            state.runtime.agentId,
            state.runtime.runtimeGeneration,
          ),
        );
        if (
          existingPublication === undefined
          || !equalSignerPublications(
            existingPublication,
            signerPublication,
          )
        ) {
          throw new Error(
            "Agent Runtime signer publication history does not match initialized state",
          );
        }
        return Promise.resolve("existing");
      }
      this.atomicRuntimeStates.set(
        state.runtime.agentId,
        cloneAtomicRuntimeState(state),
      );
      this.agentRuntimeSignerPublications.set(
        runtimeSignerPublicationKey(
          state.runtime.agentId,
          state.runtime.runtimeGeneration,
        ),
        cloneSignerPublication(signerPublication),
      );
      return Promise.resolve("inserted");
    } catch (error) {
      return rejected(error);
    }
  }

  getAgentRuntimeAtomicState(
    agentIdValue: string,
  ): Promise<AgentRuntimeAtomicStorageWireV2 | null> {
    try {
      const id = agentId(agentIdValue);
      const state = this.atomicRuntimeStates.get(id);
      return Promise.resolve(
        state ? runtimeWireState(state) : null,
      );
    } catch (error) {
      return rejected(error);
    }
  }

  getAgentRuntimeSignerPublication(
    agentIdValue: string,
    runtimeGenerationValue: number,
  ): Promise<AgentRuntimeSignerPublicationV1 | null> {
    try {
      const id = agentId(agentIdValue);
      assertU64Counter(
        "Agent Runtime signer generation",
        runtimeGenerationValue,
      );
      const publication = this.agentRuntimeSignerPublications.get(
        runtimeSignerPublicationKey(id, runtimeGenerationValue),
      );
      return Promise.resolve(
        publication === undefined ? null : cloneSignerPublication(publication),
      );
    } catch (error) {
      return rejected(error);
    }
  }

  compareAndSwapAgentRuntimeChallengeReservations(
    authorized: AuthorizedAgentRuntimeChallengeReservationWriteV2,
  ): Promise<AgentRuntimeChallengeReservationCasStatusV2> {
    try {
      const { expected, additions } =
        consumeAuthorizedAgentRuntimeChallengeReservationWriteV2(
          authorized,
        );
      assertAgentRuntimeChallengeReservationExpectation(expected);
      if (!Array.isArray(additions as unknown)) {
        throw new TypeError(
          "Agent Runtime challenge reservation additions must be an array",
        );
      }
      assertV2Limit(
        "Agent Runtime challenge reservation addition count",
        additions.length,
        V2_LIMITS.agentGrantDomains,
      );
      let prior: Uint8Array | undefined;
      const detachedAdditions = additions.map((addition) => {
        assertExactFields("Agent Runtime challenge reservation addition", addition, [
          "challengeHash",
          "consumed",
        ]);
        assertHash(
          "Agent Runtime challenge reservation addition hash",
          addition.challengeHash,
        );
        if (addition.consumed !== false) {
          throw new Error(
            "A new Agent Runtime challenge reservation must be unconsumed",
          );
        }
        if (
          prior !== undefined
          && compareBytes(prior, addition.challengeHash) >= 0
        ) {
          throw new Error(
            "Agent Runtime challenge reservation additions must be sorted and unique",
          );
        }
        prior = addition.challengeHash;
        return {
          challengeHash: cloneBytes(addition.challengeHash),
          consumed: false,
        };
      });
      const detachedExpected = {
        runtime: {
          agentId: expected.runtime.agentId,
          authorizationRevision: expected.runtime.authorizationRevision,
          runtimeGeneration: expected.runtime.runtimeGeneration,
        },
        challengeConsumptions: expected.challengeConsumptions.map(
          (challenge) => ({
            challengeHash: cloneBytes(challenge.challengeHash),
            consumed: challenge.consumed,
          }),
        ),
      };
      const current = this.atomicRuntimeStates.get(
        detachedExpected.runtime.agentId,
      );
      if (
        current === undefined
        || current.runtime.authorizationRevision
          !== detachedExpected.runtime.authorizationRevision
        || current.runtime.runtimeGeneration
          !== detachedExpected.runtime.runtimeGeneration
      ) {
        return Promise.resolve("stale");
      }
      if (
        detachedAdditions.length > 0
        && detachedAdditions.every((addition) =>
          current.challengeConsumptions.some((challenge) =>
            !challenge.consumed
            && equalBytes(challenge.challengeHash, addition.challengeHash)
          )
        )
      ) {
        return Promise.resolve("duplicate");
      }
      if (
        current.challengeConsumptions.length
          !== detachedExpected.challengeConsumptions.length
        || current.challengeConsumptions.some((challenge, index) => {
          const expectedChallenge =
            detachedExpected.challengeConsumptions[index]!;
          return (
            challenge.consumed !== expectedChallenge.consumed
            || !equalBytes(
              challenge.challengeHash,
              expectedChallenge.challengeHash,
            )
          );
        })
        || detachedAdditions.some((addition) =>
          current.challengeConsumptions.some((challenge) =>
            equalBytes(challenge.challengeHash, addition.challengeHash)
          )
        )
      ) {
        return Promise.resolve("stale");
      }
      const pending = current.challengeConsumptions
        .filter((challenge) => !challenge.consumed)
        .map((challenge) => ({
          challengeHash: cloneBytes(challenge.challengeHash),
          consumed: false,
        }));
      const merged = [...pending, ...detachedAdditions]
        .sort((left, right) =>
          compareBytes(left.challengeHash, right.challengeHash)
        );
      assertV2Limit(
        "Agent Runtime pending challenge reservation count",
        merged.length,
        V2_LIMITS.agentGrantDomains,
      );
      const next: AgentRuntimeAtomicStorageStateV2 = {
        ...cloneAtomicRuntimeState(current),
        challengeConsumptions: merged,
      };
      this.atomicRuntimeStates.set(
        detachedExpected.runtime.agentId,
        next,
      );
      return Promise.resolve("applied");
    } catch (error) {
      return rejected(error);
    }
  }

  compareAndSwapAgentRuntimeRotation(
    authorized: AuthorizedAgentRuntimeRotationWriteV2,
  ): Promise<AgentRuntimeRotationCasStatusV2> {
    try {
      const { expected, intended, signerPublication } =
        consumeAuthorizedAgentRuntimeRotationWriteV2(authorized);
      // Validate and detach both complete write sets before consulting or
      // mutating the active map. No record can become visible partially.
      assertAgentRuntimeRotationExpectation(expected);
      assertAgentRuntimeAtomicState(intended);
      if (
        expected.runtime.agentId !== intended.runtime.agentId
        || intended.runtime.authorizationRevision
          !== expected.runtime.authorizationRevision + 1
        || intended.runtime.runtimeGeneration
          !== expected.runtime.runtimeGeneration + 1
      ) {
        throw new Error(
          "Agent Runtime CAS requires one exact authorization and generation advance",
        );
      }
      if (
        signerPublication.transitionKind !== "rotation"
        || signerPublication.agentId !== intended.runtime.agentId
        || signerPublication.authorizationRevision
          !== intended.runtime.authorizationRevision
        || signerPublication.runtimeGeneration
          !== intended.runtime.runtimeGeneration
      ) {
        throw new Error(
          "Agent Runtime rotation signer publication does not match its state",
        );
      }
      if (expected.configObjects.length !== intended.configObjects.length) {
        throw new Error(
          "Agent Runtime CAS write set does not exactly rewrap config",
        );
      }
      for (let index = 0; index < expected.configObjects.length; index += 1) {
        const object = expected.configObjects[index]!;
        const next = intended.configObjects[index]!;
        if (
          object.objectId !== next.objectId
          || object.configRevision !== next.configRevision
        ) {
          throw new Error(
            "Agent Runtime CAS write set does not exactly rewrap config",
          );
        }
      }
      const detachedExpected = cloneRuntimeExpectation(expected);
      const detachedIntended = cloneAtomicRuntimeState(intended);
      const current = this.atomicRuntimeStates.get(
        detachedExpected.runtime.agentId,
      );
      if (
        current
        && equalAtomicRuntimeStates(current, detachedIntended)
      ) {
        const existingPublication = this.agentRuntimeSignerPublications.get(
          runtimeSignerPublicationKey(
            detachedIntended.runtime.agentId,
            detachedIntended.runtime.runtimeGeneration,
          ),
        );
        return Promise.resolve(
          existingPublication !== undefined
            && equalSignerPublications(existingPublication, signerPublication)
            ? "duplicate"
            : "stale",
        );
      }
      if (
        detachedExpected.challengeConsumptions.length
          !== detachedIntended.challengeConsumptions.length
        || detachedIntended.domainEnvelopes.length
          !== detachedExpected.challengeConsumptions.reduce(
            (count, challenge, index) =>
              count
              + (
                  !challenge.consumed
                  && detachedIntended.challengeConsumptions[index]!.consumed
                ? 1
                : 0
              ),
            0,
          )
        || detachedExpected.challengeConsumptions.some((challenge, index) => {
          const next = detachedIntended.challengeConsumptions[index]!;
          return (
            !equalBytes(challenge.challengeHash, next.challengeHash)
            || (challenge.consumed && !next.consumed)
          );
        })
      ) {
        throw new Error(
          "Agent Runtime CAS write set does not consume exactly its challenges",
        );
      }
      if (
        !current
        || current.runtime.authorizationRevision
          !== detachedExpected.runtime.authorizationRevision
        || current.runtime.runtimeGeneration
          !== detachedExpected.runtime.runtimeGeneration
        || !equalBytes(
          current.configInventory.digest,
          detachedExpected.configInventory.digest,
        )
        || current.challengeConsumptions.length
          !== detachedExpected.challengeConsumptions.length
        || current.challengeConsumptions.some((challenge, index) => {
          const expectedChallenge =
            detachedExpected.challengeConsumptions[index]!;
          return (
            challenge.consumed !== expectedChallenge.consumed
            || !equalBytes(
              challenge.challengeHash,
              expectedChallenge.challengeHash,
            )
          );
        })
      ) {
        return Promise.resolve("stale");
      }
      this.atomicRuntimeStates.set(
        detachedIntended.runtime.agentId,
        detachedIntended,
      );
      this.agentRuntimeSignerPublications.set(
        runtimeSignerPublicationKey(
          detachedIntended.runtime.agentId,
          detachedIntended.runtime.runtimeGeneration,
        ),
        cloneSignerPublication(signerPublication),
      );
      return Promise.resolve("applied");
    } catch (error) {
      return rejected(error);
    }
  }

  compareAndSwapAgentRuntimeAuthorizationTransition(
    authorized: AuthorizedAgentRuntimeAuthorizationTransitionWriteV2,
  ): Promise<AgentRuntimeAuthorizationTransitionCasStatusV2> {
    try {
      const { expected, intended, authorization, signerPublication } =
        consumeAuthorizedAgentRuntimeAuthorizationTransitionWriteV2(
          authorized,
        );
      assertAgentRuntimeAtomicState(expected);
      assertAgentRuntimeAtomicState(intended);
      if (
        expected.runtime.agentId !== intended.runtime.agentId
        || intended.runtime.authorizationRevision
          !== expected.runtime.authorizationRevision + 1
        || intended.runtime.runtimeGeneration
          !== expected.runtime.runtimeGeneration
      ) {
        throw new Error(
          "Agent Runtime authorization transition requires one exact authorization advance and no generation change",
        );
      }
      if (
        signerPublication.agentId !== expected.runtime.agentId
        || signerPublication.runtimeGeneration
          !== expected.runtime.runtimeGeneration
        || signerPublication.runtimeGeneration
          !== intended.runtime.runtimeGeneration
      ) {
        throw new Error(
          "Agent Runtime authorization transition must preserve its exact signer publication",
        );
      }
      if (
        expected.configInventory.objectCount
          !== intended.configInventory.objectCount
        || !equalBytes(
          expected.configInventory.digest,
          intended.configInventory.digest,
        )
        || expected.configObjects.length !== intended.configObjects.length
        || expected.configObjects.some((object, index) => {
          const next = intended.configObjects[index];
          return next === undefined
            || object.agentId !== next.agentId
            || object.objectId !== next.objectId
            || object.configRevision !== next.configRevision
            || object.runtimeGeneration !== next.runtimeGeneration
            || !equalBytes(object.wrappedDekHash, next.wrappedDekHash)
            || !equalBytes(
              object.wrappedDek.ciphertext,
              next.wrappedDek.ciphertext,
            );
        })
      ) {
        throw new Error(
          "Agent Runtime authorization transition must preserve exact config",
        );
      }
      const refreshed = new Set(authorization.refreshedDomainIds);
      if (
        refreshed.size !== authorization.refreshedDomainIds.length
        || authorization.refreshedDomainIds.some((domainId, index) =>
          index > 0
          && comparePortableText(
            authorization.refreshedDomainIds[index - 1]!,
            domainId,
          ) >= 0
        )
      ) {
        throw new Error(
          "Agent Runtime refreshed Domains must be sorted and unique",
        );
      }
      const expectedByDomain = new Map(
        expected.domainEnvelopes.map((entry) => [entry.domainId, entry]),
      );
      if (
        intended.domainEnvelopes.some((entry) => {
          const prior = expectedByDomain.get(entry.domainId);
          const changed = prior === undefined
            || prior.domainEpoch !== entry.domainEpoch
            || prior.agentAuthorizationRevision
              !== entry.agentAuthorizationRevision
            || prior.committerDeviceId !== entry.committerDeviceId
            || prior.runtimeGeneration !== entry.runtimeGeneration
            || !equalBytes(prior.envelopeHash, entry.envelopeHash)
            || !equalBytes(
              prior.envelopeBytes.ciphertext,
              entry.envelopeBytes.ciphertext,
            );
          return changed !== refreshed.has(entry.domainId);
        })
        || authorization.refreshedDomainIds.some((domainId) =>
          !intended.domainEnvelopes.some((entry) =>
            entry.domainId === domainId
          )
        )
      ) {
        throw new Error(
          "Agent Runtime authorization transition refresh set is not exact",
        );
      }
      const newlyConsumed =
        expected.challengeConsumptions.reduce((count, challenge, index) => {
          const next = intended.challengeConsumptions[index];
          return count + (
              next !== undefined
              && !challenge.consumed
              && next.consumed
            ? 1
            : 0
          );
        }, 0);
      if (
        expected.challengeConsumptions.length
          !== intended.challengeConsumptions.length
        || newlyConsumed !== authorization.refreshedDomainIds.length
        || expected.challengeConsumptions.some((challenge, index) => {
          const next = intended.challengeConsumptions[index]!;
          return !equalBytes(challenge.challengeHash, next.challengeHash)
            || (challenge.consumed && !next.consumed);
        })
      ) {
        throw new Error(
          "Agent Runtime authorization transition challenge set is not exact",
        );
      }
      const detachedExpected = cloneAtomicRuntimeState(expected);
      const detachedIntended = cloneAtomicRuntimeState(intended);
      const current = this.atomicRuntimeStates.get(
        detachedExpected.runtime.agentId,
      );
      const currentSignerPublication =
        this.agentRuntimeSignerPublications.get(
          runtimeSignerPublicationKey(
            detachedExpected.runtime.agentId,
            detachedExpected.runtime.runtimeGeneration,
          ),
        );
      if (
        currentSignerPublication === undefined
        || !equalSignerPublications(
          currentSignerPublication,
          signerPublication,
        )
      ) {
        return Promise.resolve("stale");
      }
      if (
        !current
        || current.runtime.agentId !== authorization.currentState.agentId
        || current.runtime.authorizationRevision
          !== authorization.currentState.authorizationRevision
        || current.runtime.runtimeGeneration
          !== authorization.currentState.runtimeGeneration
      ) {
        return Promise.resolve("stale");
      }
      if (equalAtomicRuntimeStates(current, detachedIntended)) {
        return Promise.resolve("duplicate");
      }
      if (
        !current
        || !equalAtomicRuntimeStates(current, detachedExpected)
      ) {
        return Promise.resolve("stale");
      }
      this.atomicRuntimeStates.set(
        detachedIntended.runtime.agentId,
        detachedIntended,
      );
      return Promise.resolve("applied");
    } catch (error) {
      return rejected(error);
    }
  }

  putGrant(grant: OpaqueGrantRecordV2): Promise<void> {
    try {
      assertExactFields("Grant record", grant, [
        "grantId",
        "grantBytes",
        "consumed",
      ]);
      grantId(grant.grantId);
      assertOpaqueBytes("Grant", grant.grantBytes, "grant");
      assertV2Limit(
        "Grant wire bytes",
        grant.grantBytes.ciphertext.length,
        V2_LIMITS.agentGrantWireBytes,
      );
      const parsed = parseGrantV2(grant.grantBytes.ciphertext);
      if (parsed === null || parsed.id !== grant.grantId) {
        throw new Error(
          "Grant record does not contain canonical matching Grant wire bytes",
        );
      }
      if (grant.consumed !== false) {
        throw new Error("A newly persisted Grant must be unconsumed");
      }
      const existing = this.grants.get(grant.grantId);
      if (existing) {
        if (
          existing.consumed
          || !equalBytes(
            existing.grantBytes.ciphertext,
            grant.grantBytes.ciphertext,
          )
        ) {
          throw new Error(
            "Grant record is already initialized with different or consumed state",
          );
        }
        return Promise.resolve();
      }
    } catch (error) {
      return rejected(error);
    }
    this.grants.set(grant.grantId, cloneGrant(grant));
    return Promise.resolve();
  }

  getGrant(grantId: string): Promise<GrantWireRecordV2 | null> {
    const grant = this.grants.get(grantId);
    return Promise.resolve(grant ? grantWireRecord(grant) : null);
  }

  consumeGrant(grantId: string): Promise<GrantWireRecordV2 | null> {
    const grant = this.grants.get(grantId);
    if (!grant || grant.consumed) return Promise.resolve(null);
    const consumed = { ...grant, consumed: true };
    this.grants.set(grantId, cloneGrant(consumed));
    return Promise.resolve(grantWireRecord(consumed));
  }

  compareAndSwapRecoveryArchive(
    expected: RecoveryArchiveStorageExpectationV2 | null,
    intended: OpaqueRecoveryPackageRecordV2,
  ): Promise<RecoveryArchiveCasStatusV2> {
    try {
      assertCanonicalRecoveryArchiveRecord(intended);
      if (expected !== null) {
        assertExactFields("Recovery archive expectation", expected, [
          "humanId",
          "recoveryKeyGeneration",
          "archiveHash",
        ]);
        humanId(expected.humanId);
        assertU64Counter(
          "Expected recovery key generation",
          expected.recoveryKeyGeneration,
        );
        assertHash(
          "Expected recovery archive hash",
          expected.archiveHash,
        );
      }
      const current = this.recoveryArchives.get(intended.humanId);
      if (
        current !== undefined
        && equalBytes(
          current.archiveBytes.ciphertext,
          intended.archiveBytes.ciphertext,
        )
      ) {
        return Promise.resolve("duplicate");
      }
      if (expected === null) {
        if (current !== undefined) return Promise.resolve("stale");
      } else if (
        expected.humanId !== intended.humanId
        || current === undefined
        || current.recoveryKeyGeneration
          !== expected.recoveryKeyGeneration
        || !equalBytes(
          sha256(current.archiveBytes.ciphertext),
          expected.archiveHash,
        )
        || intended.recoveryKeyGeneration
          !== expected.recoveryKeyGeneration + 1
      ) {
        return Promise.resolve("stale");
      }
      this.recoveryArchives.set(
        intended.humanId,
        cloneRecovery(intended),
      );
      return Promise.resolve("applied");
    } catch (error) {
      return rejected(error);
    }
  }

  getRecoveryArchive(
    humanId: string,
  ): Promise<RecoveryArchiveWireRecordV2 | null> {
    const archive = this.recoveryArchives.get(humanId);
    return Promise.resolve(archive ? recoveryWireRecord(archive) : null);
  }

  snapshot(): {
    readonly domains: CryptoDomainPublicRecordV2[];
    readonly domainProviderStates: DomainProviderPublicStateV2[];
    readonly bindings: NamespaceBindingRecordV2[];
    readonly namespaceHeads: NamespaceHeadV2[];
    readonly objects: OpaqueEncryptedObjectRecordV2[];
    readonly objectAccessStates: ObjectAccessStorageStateV2[];
    readonly atomicRuntimeStates: AgentRuntimeAtomicStorageStateV2[];
    readonly grants: OpaqueGrantRecordV2[];
    readonly recoveryArchives: OpaqueRecoveryPackageRecordV2[];
  } {
    return {
      domains: [...this.domainsByDigest.values()].flat().map(cloneDomain),
      domainProviderStates: [...this.domainProviderStates.values()]
        .map(cloneProviderState),
      bindings: [...this.bindings.values()]
        .flatMap((revisions) => [...revisions.values()])
        .map(cloneBinding),
      namespaceHeads: [...this.namespaceHeads.values()].map(cloneHead),
      objects: [...this.objects.values()].map(cloneObject),
      objectAccessStates: [...this.objectAccessStates.values()]
        .map(cloneObjectAccessState),
      atomicRuntimeStates: [...this.atomicRuntimeStates.values()]
        .map(cloneAtomicRuntimeState),
      grants: [...this.grants.values()].map(cloneGrant),
      recoveryArchives: [...this.recoveryArchives.values()].map(cloneRecovery),
    };
  }
}
