import {
  accessRevision,
  agentId,
  agentRuntimeSignerPublicationMatchesRuntime,
  decryptObjectThroughNamespace,
  withGrantAuthoritySetExecutionEvidenceSubset,
  type AgentRuntimeSignerPublication,
  type GrantAuthoritySetExecutionEvidence,
  type HistoricalCommitterResolver,
  type LatticeCrypto,
  type LatticeStorage,
  type OpenedGrantAuthoritySet,
  namespaceId,
} from "@nautilo/lattice-crypto";
import {
  MAX_AGENT_RUNTIME_SIGNER_PUBLICATION_WIRE_BYTES_V1,
  MAX_PROCESSOR_SIGNER_AUTHORIZATION_WIRE_BYTES_V1,
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  type HistoricalAgentRuntimeCommitterResolverV1,
} from "@nautilo/lattice-crypto/wire";

import {
  PROTECTED_AGENT_RUNTIME_FOREGROUND_ENTRYPOINT_IDS,
  withProtectedAgentRuntimeGeneration,
  type ProtectedAgentRuntimeForegroundEntrypointId,
} from "../invocation/protected-agent-runtime.ts";
import {
  executeProtectedGrantSessionAuthoritySetCapabilityOperationV2,
  inspectProtectedInvocationCapability,
  type ProtectedGrantAuthoritySetPortV2,
  type ProtectedInvocationCapability,
  type ProtectedInvocationCapabilityDescription,
} from "../invocation/protected-grant-invocation.ts";
import {
  withProtectedCurrentNamespaceKeyringSet,
  type ProtectedNamespaceKeyringSetMaterial,
} from "../invocation/protected-namespace-keyring.ts";
import type {
  ProtectedMemoryAuthority,
  ProtectedMemoryResult,
  ProtectedMemoryUnavailableReason,
} from "./active-memory-repository.ts";
import type {
  ProtectedMemoryCandidate,
  ProtectedMemoryMutationPlan,
  ProtectedMemoryMutationTarget,
  ProtectedMemorySessionOpenedItem,
} from "./active-memory-composition.ts";
import {
  prepareAgentMemoryCryptoRevision,
} from "./agent-memory-crypto.ts";
import {
  decodeMemoryPayloadV1,
  type MemoryPayloadV1,
} from "./memory-payload-v1.ts";
import {
  MEMORY_OBJECT_TYPE,
  deriveMemoryCryptoObjectIdV1,
  fingerprintRequiredMemoryNamespaces,
  type MemoryCryptoRevisionReference,
  type PreparedMemoryCryptoRevision,
} from "./memory-repository.ts";

const MAXIMUM_MEMORY_READ_BATCH = 64;
const MAXIMUM_MEMORY_SIGNER_EVIDENCE_ENTRIES = 2;
const protectedForegroundEntrypoints = new Set<string>(
  PROTECTED_AGENT_RUNTIME_FOREGROUND_ENTRYPOINT_IDS,
);

export type VerifiedAgentMemoryNamespaceEnvelope = Readonly<{
  readonly namespaceId: string;
  readonly envelopeBytes: Uint8Array;
}>;

/**
 * Authenticated durable Memory bytes. The reader proves the common v5 chain,
 * historical signer evidence, payload hash, and complete envelope inventory.
 * Ownership of every returned byte array transfers to the caller for wiping.
 */
export type VerifiedAgentMemoryCryptoRevisionContent = Readonly<{
  readonly memoryId: string;
  readonly contentRevision: number;
  readonly objectId: string;
  readonly accessRevision: number;
  readonly accessManifestBytes: Uint8Array;
  readonly accessManifestHash: Uint8Array;
  /** Authenticated historical Runtime signer public key for this manifest. */
  readonly accessManifestSignerPublicKey: Uint8Array;
  /** Processor-only signed authorization bytes for the current v5 signer. */
  readonly accessManifestSignerAuthorizationBytes?: Uint8Array;
  /** Processor-only historical issuing Human-device public key. */
  readonly accessManifestSignerIssuingPublicKey?: Uint8Array;
  readonly requiredNamespaceIds: readonly string[];
  readonly accessSignerEvidence?: readonly Readonly<{
    kind: "agent_runtime_publication" | "processor_authorization";
    evidenceBytes: Uint8Array;
  }>[];
  readonly payloadBytes: Uint8Array;
  readonly namespaceEnvelopes:
    readonly VerifiedAgentMemoryNamespaceEnvelope[];
}>;

export interface VerifiedAgentMemoryCryptoRevisionReader {
  read(
    reference: MemoryCryptoRevisionReference,
  ): Promise<VerifiedAgentMemoryCryptoRevisionContent | null>;
}

export type ProtectedAgentMemorySessionContentUnavailableReason =
  | "authorization_unavailable"
  | "content_unavailable"
  | "content_invalid";

export type ProtectedAgentMemorySessionContentResult<Value> =
  | Readonly<{ readonly status: "executed"; readonly value: Value }>
  | Readonly<{
    readonly status: "unavailable";
    readonly reason: ProtectedAgentMemorySessionContentUnavailableReason;
  }>;

type SessionRequest = Readonly<{
  readonly capability: ProtectedInvocationCapability;
  readonly entrypointId: ProtectedAgentRuntimeForegroundEntrypointId;
  readonly requestedNamespaceIds: readonly string[];
  readonly allowedDomainIds: readonly string[];
  readonly agentId: string;
  readonly authority: ProtectedMemoryAuthority;
  readonly signal?: AbortSignal;
}>;

export type ProtectedAgentMemoryOpenManyInput = SessionRequest & Readonly<{
  readonly operation: "decrypt";
  readonly candidates: readonly ProtectedMemoryCandidate[];
}>;

export type ProtectedAgentMemoryPrepareInput = SessionRequest & Readonly<{
  readonly operation: "encrypt";
  readonly plan: ProtectedMemoryMutationPlan;
  readonly content:
    | Readonly<{ readonly kind: "complete"; readonly payload: MemoryPayloadV1 }>
    | Readonly<{
      readonly kind: "replacement";
      readonly previous: ProtectedMemoryMutationTarget;
      readonly content: string;
    }>;
}>;

export type ProtectedAgentMemoryAuthorizeCommitInput<Value> =
  SessionRequest & Readonly<{
    readonly operation: "encrypt";
    readonly target: ProtectedMemoryMutationTarget;
    readonly memoryOperation: "publish" | "replace" | "set-tier";
    readonly commit: () => Value | PromiseLike<Value>;
  }>;

/**
 * Bridge-owned direct dispatch surface for Runtime foreground leases. Each
 * method independently consumes the opaque capability and exact leased view;
 * no ambient authority or key-bearing callback context is retained.
 */
export interface ProtectedAgentMemorySessionContentPort {
  openMany(
    input: ProtectedAgentMemoryOpenManyInput,
  ): Promise<ProtectedAgentMemorySessionContentResult<
    ProtectedMemoryResult<readonly ProtectedMemorySessionOpenedItem[]>
  >>;
  prepare(
    input: ProtectedAgentMemoryPrepareInput,
  ): Promise<ProtectedAgentMemorySessionContentResult<
    ProtectedMemoryResult<PreparedMemoryCryptoRevision>
  >>;
  authorizeCommit<Value>(
    input: ProtectedAgentMemoryAuthorizeCommitInput<Value>,
  ): Promise<ProtectedAgentMemorySessionContentResult<
    ProtectedMemoryResult<Value>
  >>;
}

type AuthorizedSession = Readonly<{
  capability: ProtectedInvocationCapabilityDescription;
  requestedNamespaceIds: readonly string[];
  opened: OpenedGrantAuthoritySet;
  evidence: GrantAuthoritySetExecutionEvidence;
  material: ProtectedNamespaceKeyringSetMaterial;
  assertCurrentAuthority: () => Promise<void>;
}>;

function unavailable(
  reason: ProtectedMemoryUnavailableReason,
): Readonly<{
  readonly status: "unavailable";
  readonly reason: ProtectedMemoryUnavailableReason;
}> {
  return Object.freeze({ status: "unavailable", reason });
}

function sessionUnavailable<Value>(
  reason: ProtectedAgentMemorySessionContentUnavailableReason,
): ProtectedAgentMemorySessionContentResult<Value> {
  return Object.freeze({ status: "unavailable", reason });
}

function equalStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((entry, index) => entry === right[index]);
}

function canonicalIds(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > 256
    || value.some((entry) =>
      typeof entry !== "string"
      || entry.length < 1
      || new TextEncoder().encode(entry).length > 256
    )
    || value.some((entry, index) =>
      index > 0 && String(value[index - 1]) >= String(entry)
    )
  ) return null;
  return Object.freeze(value.map(String));
}

function authorityMatches(
  authority: ProtectedMemoryAuthority,
  capability: ProtectedInvocationCapabilityDescription,
  agent: string,
): boolean {
  return agent === capability.recipientAgentId
    && authority.agentId === capability.recipientAgentId
    && authority.subjectUserId === capability.issuingHumanId;
}

function authorityAllowsExistingMutationSet(
  authority: ProtectedMemoryAuthority,
  namespaceIds: readonly string[],
): boolean {
  return authority.mode === "scope"
    ? namespaceIds.length === 1
      && namespaceIds[0] === authority.originWritableNamespaceId
    : namespaceIds.every((entry) =>
      authority.mutableNamespaceIds.includes(entry)
    );
}

function authorityAllowsNewMutationSet(
  authority: ProtectedMemoryAuthority,
  namespaceIds: readonly string[],
): boolean {
  return authority.mode === "scope"
    ? namespaceIds.length === 1
      && namespaceIds[0] === authority.originWritableNamespaceId
    : authorityAllowsExistingMutationSet(authority, namespaceIds);
}

function authorityAllowsCommitSet(
  authority: ProtectedMemoryAuthority,
  namespaceIds: readonly string[],
  operation: "publish" | "replace" | "set-tier",
): boolean {
  return operation === "publish"
    ? authorityAllowsNewMutationSet(authority, namespaceIds)
    : authorityAllowsExistingMutationSet(authority, namespaceIds);
}

function validMemoryCoordinate(input: Readonly<{
  memoryId: string;
  contentRevision: number;
  cryptoObjectId: string;
  requiredNamespaceIds: readonly string[];
}>): boolean {
  if (canonicalIds(input.requiredNamespaceIds) === null) return false;
  try {
    return input.cryptoObjectId === deriveMemoryCryptoObjectIdV1({
      memoryId: input.memoryId,
      contentRevision: input.contentRevision,
    });
  } catch {
    return false;
  }
}

function referenceFor(input: Readonly<{
  memoryId: string;
  contentRevision: number;
  cryptoAccessRevision: number;
  cryptoObjectId: string;
  requiredNamespaceIds: readonly string[];
}>): MemoryCryptoRevisionReference {
  return Object.freeze({
    memoryId: input.memoryId,
    contentRevision: input.contentRevision,
    objectId: input.cryptoObjectId,
    expectedAccessRevision: input.cryptoAccessRevision,
    expectedActiveNamespaceFingerprint:
      fingerprintRequiredMemoryNamespaces(input.requiredNamespaceIds),
  });
}

function exactVerifiedCoordinates(
  verified: VerifiedAgentMemoryCryptoRevisionContent,
  expected: Readonly<{
    memoryId: string;
    contentRevision: number;
    cryptoAccessRevision: number;
    cryptoObjectId: string;
    requiredNamespaceIds: readonly string[];
  }>,
): boolean {
  const envelopeNamespaceIds = verified.namespaceEnvelopes
    .map((entry) => entry.namespaceId)
    .sort();
  const signerEvidence = verified.accessSignerEvidence;
  const signerEvidenceIsExact = signerEvidence === undefined
    || (
      Array.isArray(signerEvidence as unknown)
      && signerEvidence.length <= MAXIMUM_MEMORY_SIGNER_EVIDENCE_ENTRIES
      && new Set(signerEvidence.map((entry) => entry.kind)).size
        === signerEvidence.length
      && signerEvidence.every((entry) => {
        if (typeof entry !== "object" || entry === null) return false;
        const fields = Object.keys(entry).sort();
        return fields.length === 2
          && fields[0] === "evidenceBytes"
          && fields[1] === "kind"
          && (entry.kind === "agent_runtime_publication"
            || entry.kind === "processor_authorization")
          && entry.evidenceBytes instanceof Uint8Array
          && entry.evidenceBytes.length > 0
          && entry.evidenceBytes.length <= (entry.kind
              === "agent_runtime_publication"
            ? MAX_AGENT_RUNTIME_SIGNER_PUBLICATION_WIRE_BYTES_V1
            : MAX_PROCESSOR_SIGNER_AUTHORIZATION_WIRE_BYTES_V1);
      })
    );
  const processorAuthorizationIsExact =
    (verified.accessManifestSignerAuthorizationBytes === undefined)
      === (verified.accessManifestSignerIssuingPublicKey === undefined);
  return verified.memoryId === expected.memoryId
    && verified.contentRevision === expected.contentRevision
    && verified.objectId === expected.cryptoObjectId
    && verified.accessRevision === expected.cryptoAccessRevision
    && equalStrings(
      verified.requiredNamespaceIds,
      expected.requiredNamespaceIds,
    )
    && equalStrings(envelopeNamespaceIds, expected.requiredNamespaceIds)
    && new Set(envelopeNamespaceIds).size === envelopeNamespaceIds.length
    && verified.payloadBytes instanceof Uint8Array
    && verified.accessManifestBytes instanceof Uint8Array
    && verified.accessManifestHash instanceof Uint8Array
    && verified.accessManifestHash.length === 32
    && verified.accessManifestSignerPublicKey instanceof Uint8Array
    && verified.accessManifestSignerPublicKey.length === 32
    && (
      verified.accessManifestSignerAuthorizationBytes === undefined
      || (verified.accessManifestSignerAuthorizationBytes instanceof Uint8Array
        && verified.accessManifestSignerAuthorizationBytes.length > 0
        && verified.accessManifestSignerAuthorizationBytes.length
          <= MAX_PROCESSOR_SIGNER_AUTHORIZATION_WIRE_BYTES_V1)
    )
    && (
      verified.accessManifestSignerIssuingPublicKey === undefined
      || (verified.accessManifestSignerIssuingPublicKey instanceof Uint8Array
        && verified.accessManifestSignerIssuingPublicKey.length === 32)
    )
    && verified.namespaceEnvelopes.every((entry) =>
      entry.envelopeBytes instanceof Uint8Array
    )
    && processorAuthorizationIsExact
    && signerEvidenceIsExact;
}

function wipeVerified(
  verified: VerifiedAgentMemoryCryptoRevisionContent | null,
): void {
  verified?.payloadBytes.fill(0);
  verified?.accessManifestBytes.fill(0);
  verified?.accessManifestHash.fill(0);
  verified?.accessManifestSignerPublicKey.fill(0);
  verified?.accessManifestSignerAuthorizationBytes?.fill(0);
  verified?.accessManifestSignerIssuingPublicKey?.fill(0);
  verified?.accessSignerEvidence?.forEach((entry) => entry.evidenceBytes.fill(0));
  verified?.namespaceEnvelopes.forEach((entry) =>
    entry.envelopeBytes.fill(0)
  );
}

function namespaceMaterial(
  session: AuthorizedSession,
  targetNamespaceId: string,
) {
  const matches = session.material.namespaces.filter((entry) =>
    entry.namespaceId === targetNamespaceId
  );
  return matches.length === 1 ? matches[0]! : null;
}

function requirementsAllow(
  session: AuthorizedSession,
  namespaceIds: readonly string[],
  operation: "decrypt" | "encrypt",
): boolean {
  return namespaceIds.every((targetNamespaceId) => {
    const matches = session.evidence.namespaceRequirements.filter((entry) =>
      entry.namespaceId === targetNamespaceId
    );
    return matches.length === 1 && matches[0]!.operations.includes(operation);
  });
}

async function openRevision(
  crypto: LatticeCrypto,
  reader: VerifiedAgentMemoryCryptoRevisionReader,
  session: AuthorizedSession,
  expected: Readonly<{
    memoryId: string;
    contentRevision: number;
    cryptoAccessRevision: number;
    cryptoObjectId: string;
    requiredNamespaceIds: readonly string[];
  }>,
  readNamespaceId: string,
): Promise<
  | Readonly<{ readonly status: "opened"; readonly payload: MemoryPayloadV1 }>
  | Readonly<{
    readonly status: "unavailable";
    readonly reason: ProtectedMemoryUnavailableReason;
  }>
> {
  if (
    !validMemoryCoordinate(expected)
    || !expected.requiredNamespaceIds.includes(readNamespaceId)
  ) return unavailable("integrity_failure");
  const material = namespaceMaterial(session, readNamespaceId);
  if (material === null) return unavailable("incomplete_access_set");

  let verified: VerifiedAgentMemoryCryptoRevisionContent | null = null;
  let payload: ReturnType<typeof decodeEncryptedPayloadV2> | null = null;
  let envelope: ReturnType<typeof decodeNamespaceObjectEnvelopeV2> | null =
    null;
  let plaintext: Uint8Array | null = null;
  try {
    try {
      verified = await reader.read(referenceFor(expected));
    } catch {
      return unavailable("missing_mapping");
    }
    if (verified === null) return unavailable("missing_mapping");
    if (!exactVerifiedCoordinates(verified, expected)) {
      return unavailable("integrity_failure");
    }
    const selected = verified.namespaceEnvelopes.filter((entry) =>
      entry.namespaceId === readNamespaceId
    );
    if (selected.length !== 1) return unavailable("integrity_failure");
    try {
      payload = decodeEncryptedPayloadV2(verified.payloadBytes);
      envelope = decodeNamespaceObjectEnvelopeV2(
        selected[0]!.envelopeBytes,
      );
    } catch {
      return unavailable("integrity_failure");
    }
    if (
      payload.context.objectId !== expected.cryptoObjectId
      || payload.context.objectType !== MEMORY_OBJECT_TYPE
      || payload.context.keyClass !== "ai"
      || envelope.context.objectId !== expected.cryptoObjectId
      || envelope.context.namespaceId !== readNamespaceId
      || envelope.context.keyClass !== "ai"
      // Retained object envelopes remain valid across later Namespace-head
      // revisions; the live keyring must still carry their exact generation.
      || envelope.context.bindingRevisionAtWrap > material.accessRevision
    ) return unavailable("integrity_failure");
    const keys = material.generations.filter((entry) =>
      entry.generation === envelope!.context.keyGeneration
    );
    if (keys.length !== 1) return unavailable("incomplete_access_set");
    await session.assertCurrentAuthority();
    try {
      plaintext = decryptObjectThroughNamespace(
        crypto,
        keys[0]!.key,
        envelope,
        payload,
      );
    } catch {
      return unavailable("integrity_failure");
    }
    if (plaintext === null) return unavailable("integrity_failure");
    try {
      return Object.freeze({
        status: "opened" as const,
        payload: decodeMemoryPayloadV1(plaintext),
      });
    } catch {
      return unavailable("integrity_failure");
    }
  } finally {
    plaintext?.fill(0);
    payload?.ciphertext.fill(0);
    envelope?.wrappedDek.fill(0);
    wipeVerified(verified);
  }
}

function runtimeDomain(session: AuthorizedSession) {
  const namespace = session.material.namespaces[0];
  if (namespace === undefined) return null;
  const domain = session.opened.domains.find((entry) =>
    entry.domainId === namespace.domainId
  );
  if (domain === undefined) return null;
  return Object.freeze({
    grantId: session.opened.grantId,
    namespaceId: namespaceId(namespace.namespaceId),
    namespaceAccessRevision: accessRevision(namespace.accessRevision),
    domainId: domain.domainId,
    domainEpoch: domain.expectedEpoch,
    agentAuthorizationRevision:
      domain.expectedAgentAuthorizationRevision,
    aiRoot: domain.aiRoot,
  });
}

export function createProtectedAgentMemorySessionContentPort(input: Readonly<{
  readonly crypto: LatticeCrypto;
  readonly storage: Pick<
    LatticeStorage,
    | "getGrant"
    | "consumeGrant"
    | "getNamespaceHead"
    | "getBinding"
    | "getAgentRuntimeAtomicState"
    | "getAgentRuntimeSignerPublication"
  >;
  readonly authority: ProtectedGrantAuthoritySetPortV2;
  readonly resolveHistoricalNamespaceCommitter: HistoricalCommitterResolver;
  readonly resolveHistoricalRuntimeCommitter:
    HistoricalAgentRuntimeCommitterResolverV1;
  readonly revisionReader: VerifiedAgentMemoryCryptoRevisionReader;
}>): ProtectedAgentMemorySessionContentPort {
  async function executeAuthorized<Value>(
    request: SessionRequest & Readonly<{
      operation: "decrypt" | "encrypt";
    }>,
    execute: (
      session: AuthorizedSession,
    ) => Promise<ProtectedMemoryResult<Value>>,
  ): Promise<ProtectedAgentMemorySessionContentResult<
    ProtectedMemoryResult<Value>
  >> {
    if (
      request.signal?.aborted === true
      || !protectedForegroundEntrypoints.has(request.entrypointId)
      || canonicalIds(request.requestedNamespaceIds) === null
      || canonicalIds(request.allowedDomainIds) === null
    ) return sessionUnavailable("authorization_unavailable");
    const capability = inspectProtectedInvocationCapability(
      request.capability,
    );
    if (
      capability === null
      || !authorityMatches(request.authority, capability, request.agentId)
    ) return sessionUnavailable("authorization_unavailable");

    let runtimeState: Awaited<
      ReturnType<LatticeStorage["getAgentRuntimeAtomicState"]>
    >;
    try {
      runtimeState = await input.storage.getAgentRuntimeAtomicState(
        capability.recipientAgentId,
      );
    } catch {
      return sessionUnavailable("content_unavailable");
    }
    if (
      runtimeState === null
      || runtimeState.runtime.agentId !== capability.recipientAgentId
    ) return sessionUnavailable("authorization_unavailable");

    try {
      const granted =
        await executeProtectedGrantSessionAuthoritySetCapabilityOperationV2({
          capability: request.capability,
          crypto: input.crypto,
          storage: input.storage,
          authority: input.authority,
          execute: (opened, evidence) =>
            withProtectedCurrentNamespaceKeyringSet({
              crypto: input.crypto,
              storage: input.storage,
              authority: input.authority,
              resolveHistoricalCommitter:
                input.resolveHistoricalNamespaceCommitter,
              capability,
              opened,
              operation: request.operation,
              requestedNamespaceIds: request.requestedNamespaceIds,
              viewDomainIds: request.allowedDomainIds,
              expectedRuntimeAuthorizationRevision:
                runtimeState.runtime.authorizationRevision,
              ...(request.signal === undefined
                ? {}
                : { signal: request.signal }),
              execute: (material, assertCurrentAuthority) => execute({
                capability,
                requestedNamespaceIds: request.requestedNamespaceIds,
                opened,
                evidence,
                material,
                assertCurrentAuthority,
              }),
            }),
        });
      if (granted.status === "unavailable") {
        return sessionUnavailable("authorization_unavailable");
      }
      if (granted.value.status === "unavailable") {
        return sessionUnavailable(
          granted.value.reason === "namespace_invalid"
            ? "content_invalid"
            : granted.value.reason === "namespace_unavailable"
              ? "content_unavailable"
              : "authorization_unavailable",
        );
      }
      return Object.freeze({
        status: "executed" as const,
        value: granted.value.value,
      });
    } catch {
      return sessionUnavailable("authorization_unavailable");
    }
  }

  const port: ProtectedAgentMemorySessionContentPort = {
    openMany: (request: ProtectedAgentMemoryOpenManyInput) =>
      executeAuthorized<readonly ProtectedMemorySessionOpenedItem[]>(
      request,
      async (session) => {
        if (
          !Array.isArray(request.candidates as unknown)
          || request.candidates.length < 1
          || request.candidates.length > MAXIMUM_MEMORY_READ_BATCH
        ) return unavailable("integrity_failure");
        const seedNamespaceIds = Object.freeze([
          ...new Set(request.candidates.map((entry) =>
            entry.readNamespaceId
          )),
        ].sort());
        if (!equalStrings(seedNamespaceIds, request.requestedNamespaceIds)) {
          return unavailable("incomplete_access_set");
        }
        const readableNamespaceIds = request.authority.mode === "namespace"
          ? request.authority.readableNamespaceIds
          : null;
        if (
          readableNamespaceIds !== null
          && seedNamespaceIds.some((entry) =>
            !readableNamespaceIds.includes(entry)
          )
        ) return unavailable("authorization_required");
        const opened: ProtectedMemorySessionOpenedItem[] = [];
        for (const candidate of request.candidates) {
          if (
            !validMemoryCoordinate(candidate)
            || !candidate.requiredNamespaceIds.includes(
              candidate.readNamespaceId,
            )
            || !requirementsAllow(
              session,
              [candidate.readNamespaceId],
              "decrypt",
            )
          ) return unavailable("integrity_failure");
          const result = await openRevision(
            input.crypto,
            input.revisionReader,
            session,
            candidate,
            candidate.readNamespaceId,
          );
          if (result.status === "unavailable") return result;
          opened.push(Object.freeze({
            memoryId: candidate.memoryId,
            contentRevision: candidate.contentRevision,
            type: result.payload.type,
            content: result.payload.content,
          }));
        }
        await session.assertCurrentAuthority();
        return Object.freeze({
          status: "success" as const,
          value: Object.freeze(opened),
        });
      },
    ),

    prepare: (request: ProtectedAgentMemoryPrepareInput) =>
      executeAuthorized<PreparedMemoryCryptoRevision>(
      request,
      async (session) => {
        if (
          !validMemoryCoordinate(request.plan)
          || !equalStrings(
            request.requestedNamespaceIds,
            request.plan.requiredNamespaceIds,
          )
          || !equalStrings(
            session.material.namespaces.map((entry) => entry.namespaceId),
            request.plan.requiredNamespaceIds,
          )
          || !requirementsAllow(
            session,
            request.plan.requiredNamespaceIds,
            "encrypt",
          )
          || !(request.plan.action === "created"
            ? authorityAllowsNewMutationSet(
              request.authority,
              request.plan.requiredNamespaceIds,
            )
            : authorityAllowsExistingMutationSet(
              request.authority,
              request.plan.requiredNamespaceIds,
            ))
        ) return unavailable("incomplete_access_set");

        let payload: MemoryPayloadV1;
        if (request.content.kind === "complete") {
          payload = request.content.payload;
        } else {
          if (
            !validMemoryCoordinate(request.content.previous)
            || !equalStrings(
              request.content.previous.requiredNamespaceIds,
              request.plan.requiredNamespaceIds,
            )
            || request.content.previous.memoryId !== request.plan.memoryId
            || request.content.previous.contentRevision + 1
              !== request.plan.contentRevision
            || !requirementsAllow(
              session,
              request.content.previous.requiredNamespaceIds,
              "decrypt",
            )
          ) return unavailable("stale_revision");
          const opened = await openRevision(
            input.crypto,
            input.revisionReader,
            session,
            request.content.previous,
            request.content.previous.requiredNamespaceIds[0]!,
          );
          if (opened.status === "unavailable") return opened;
          payload = Object.freeze({
            formatVersion: 1,
            type: opened.payload.type,
            content: request.content.content,
          });
        }

        const openedRuntime = runtimeDomain(session);
        if (openedRuntime === null) {
          return unavailable("target_encryption_not_ready");
        }
        await session.assertCurrentAuthority();
        const result = await withProtectedAgentRuntimeGeneration({
          crypto: input.crypto,
          storage: input.storage,
          opened: openedRuntime,
          agentId: agentId(request.agentId),
          resolveHistoricalCommitter:
            input.resolveHistoricalRuntimeCommitter,
          execute: async (runtime) => {
            let publication: AgentRuntimeSignerPublication | null;
            try {
              publication =
                await input.storage.getAgentRuntimeSignerPublication(
                  request.agentId,
                  runtime.generation,
                );
            } catch {
              return unavailable(
                "target_encryption_not_ready",
              );
            }
            let signerMatches = false;
            try {
              signerMatches = publication !== null
                && publication.authorizationRevision
                  === session.material.runtimeAuthorizationRevision
                && agentRuntimeSignerPublicationMatchesRuntime(
                  input.crypto,
                  runtime,
                  publication,
                );
            } catch {
              signerMatches = false;
            }
            if (publication === null || !signerMatches) {
              return unavailable(
                "target_encryption_not_ready",
              );
            }
            await session.assertCurrentAuthority();
            try {
              return withGrantAuthoritySetExecutionEvidenceSubset({
                evidence: session.evidence,
                namespaceIds: request.plan.requiredNamespaceIds,
                requiredOperations: ["encrypt"],
                execute: (authoritySet) => Object.freeze({
                  status: "success" as const,
                  value: prepareAgentMemoryCryptoRevision({
                    crypto: input.crypto,
                    memoryId: request.plan.memoryId,
                    contentRevision: request.plan.contentRevision,
                    payload,
                    createdAt: request.plan.createdAt,
                    namespaceSet: session.material,
                    authoritySet,
                    runtime,
                    signerPublication: publication,
                  }),
                }),
              });
            } catch {
              return unavailable(
                "integrity_failure",
              );
            }
          },
        });
        return result.status === "unavailable"
          ? unavailable("target_encryption_not_ready")
          : result.value;
      },
    ),

    authorizeCommit: <Value>(
      request: ProtectedAgentMemoryAuthorizeCommitInput<Value>,
    ) => executeAuthorized<Value>(request, async (session) => {
        if (
          !validMemoryCoordinate(request.target)
          || !equalStrings(
            request.requestedNamespaceIds,
            request.target.requiredNamespaceIds,
          )
          || !equalStrings(
            session.material.namespaces.map((entry) => entry.namespaceId),
            request.target.requiredNamespaceIds,
          )
          || !requirementsAllow(
            session,
            request.target.requiredNamespaceIds,
            "encrypt",
          )
          || !authorityAllowsCommitSet(
            request.authority,
            request.target.requiredNamespaceIds,
            request.memoryOperation,
          )
        ) return unavailable("incomplete_access_set");
        await session.assertCurrentAuthority();
        const value = await request.commit();
        await session.assertCurrentAuthority();
        return Object.freeze({ status: "success" as const, value });
      }),
  };
  return Object.freeze(port);
}
