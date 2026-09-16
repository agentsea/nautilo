import {
  accessRevision,
  agentId,
  agentRuntimeSignerPublicationMatchesRuntime,
  assertAuthenticPreparedAgentObjectAccessManifestUpdateSet,
  namespaceId,
  namespaceGeneration,
  objectId,
  openObjectDekForNamespace,
  prepareAgentObjectAccessManifestUpdateSet,
  withGrantAuthoritySetExecutionEvidenceNamespaceSubset,
  wrapObjectDekForNamespace,
  type AgentObjectAccessSetNamespaceBinding,
  type AgentRuntimeSignerPublication,
  type HistoricalCommitterResolver,
  type LatticeCrypto,
  type LatticeStorage,
  type PreparedAgentObjectAccessManifestUpdateSet,
} from "@nautilo/lattice-crypto";
import {
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV5,
  encodeNamespaceObjectEnvelopeV2,
  type HistoricalAgentRuntimeCommitterResolverV1,
} from "@nautilo/lattice-crypto/wire";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  withProtectedAgentRuntimeGeneration,
  type ProtectedAgentRuntimeForegroundEntrypointId,
} from "../invocation/protected-agent-runtime.ts";
import {
  executeProtectedGrantSessionAuthoritySetCapabilityOperationV2,
  inspectProtectedInvocationCapability,
  type ProtectedGrantAuthoritySetPortV2,
  type ProtectedInvocationCapability,
} from "../invocation/protected-grant-invocation.ts";
import {
  withProtectedCurrentNamespaceKeyringSet,
  type ProtectedNamespaceKeyringSetMaterial,
} from "../invocation/protected-namespace-keyring.ts";
import type {
  ProtectedMemoryAuthority,
  ProtectedMemoryResult,
} from "./active-memory-repository.ts";
import type {
  ProtectedAgentMemorySessionContentResult,
  VerifiedAgentMemoryCryptoRevisionContent,
  VerifiedAgentMemoryCryptoRevisionReader,
} from "./agent-memory-session-content.ts";
import {
  fingerprintRequiredMemoryNamespaces,
  type MemoryCryptoRevisionReference,
} from "./memory-repository.ts";

const MAX_NAMESPACES = 256;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

export type AgentMemoryExactAccessBindingFact = Readonly<{
  namespaceId: string;
  domainId: string;
  expectedAccessRevision: number;
  expectedPolicyRevision: number;
  bindingHash: Uint8Array;
}>;

/** Native Domain-V2 ciphertext-head replacement prepared by one foreground
 * Agent invocation. Actor signing remains Agent-specific; Namespace facts use
 * the shared Memory descriptor. */
export type ForegroundAgentMemoryNativeExactAccessPublication = Readonly<{
  objectId: string;
  expectedAccessRevision: number;
  nextAccessRevision: number;
  currentEntries: readonly import("@nautilo/lattice-crypto/wire").MemoryNativeNamespaceAccessEntryV1[];
  targetEntries: readonly import("@nautilo/lattice-crypto/wire").MemoryNativeNamespaceAccessEntryV1[];
  payloadHash: Uint8Array;
  currentManifestHash: Uint8Array;
  nextManifestHash: Uint8Array;
  nextManifestBytes: Uint8Array;
  targetEnvelopeBytes: readonly Uint8Array[];
}>;

export type AgentMemoryExactAccessPlan = Readonly<{
  operationId: string;
  memoryId: string;
  cryptoObjectId: string;
  expectedContentRevision: number;
  expectedCryptoAccessRevision: number;
  nextCryptoAccessRevision: number;
  anchorNamespaceId: string;
  currentNamespaceIds: readonly string[];
  targetNamespaceIds: readonly string[];
  addedNamespaceIds: readonly string[];
  removedNamespaceIds: readonly string[];
  currentRequiredNamespaceFingerprint: Uint8Array;
  targetRequiredNamespaceFingerprint: Uint8Array;
  currentBindings: readonly AgentMemoryExactAccessBindingFact[];
  targetBindings: readonly AgentMemoryExactAccessBindingFact[];
  productMutation:
    | Readonly<{ kind: "replace_exact" }>
    | Readonly<{ kind: "grant_namespace"; namespaceId: string }>
    | Readonly<{
        kind: "promote_scope_origin";
        scopeId: string;
        sourceOriginNamespaceId: string;
        targetNamespaceId: string;
      }>;
}>;

export type ForegroundAgentMemoryNativeExactAccessPlan = Omit<
  AgentMemoryExactAccessPlan,
  "currentBindings" | "targetBindings"
>;

export type AgentMemoryExactAccessCryptoReceipt = Readonly<{
  operationId: string;
  memoryId: string;
  objectId: string;
  expectedContentRevision: number;
  expectedAccessRevision: number;
  resultAccessRevision: number;
  currentManifestHash: Uint8Array;
  resultManifestHash: Uint8Array;
  targetRequiredNamespaceFingerprint: Uint8Array;
  requestDigest: Uint8Array;
  currentNamespaceIds: readonly string[];
  targetNamespaceIds: readonly string[];
  status: "applied" | "duplicate";
}>;

export type AgentMemoryExactAccessCryptoObservation =
  | Readonly<{ status: "absent" }>
  | Readonly<{
      status: "active";
      objectId: string;
      accessRevision: number;
      manifestHash: Uint8Array;
      namespaceIds: readonly string[];
    }>;

export interface AgentMemoryExactAccessCryptoCompletionPort {
  complete(
    prepared: PreparedAgentMemoryExactAccess,
  ): Promise<AgentMemoryExactAccessCryptoReceipt>;

  /**
   * Returns only authenticated, content-free active-head coordinates. This is
   * the restart seam for a crypto-first commit whose process-local prepared
   * handle was lost before the ordinary product CAS completed.
   */
  observe(objectId: string): Promise<AgentMemoryExactAccessCryptoObservation>;
}

declare const preparedBrand: unique symbol;
export type PreparedAgentMemoryExactAccess = Readonly<{
  [preparedBrand]: true;
}>;

type PreparedSnapshot = Readonly<{
  plan: AgentMemoryExactAccessPlan;
  prepared: PreparedAgentObjectAccessManifestUpdateSet;
}>;

const preparedSnapshots = new WeakMap<object, PreparedSnapshot>();

export function readPreparedAgentMemoryExactAccessSnapshot(
  prepared: PreparedAgentMemoryExactAccess,
): PreparedSnapshot {
  const snapshot = preparedSnapshots.get(prepared as object);
  if (snapshot === undefined) {
    throw new TypeError("Agent Memory exact access was not prepared by the bridge");
  }
  assertAuthenticPreparedAgentObjectAccessManifestUpdateSet(snapshot.prepared);
  return snapshot;
}

const digestEncoder = new TextEncoder();

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function foregroundAgentMemoryNativeExactAccessDigest(
  plan: ForegroundAgentMemoryNativeExactAccessPlan,
  publication: ForegroundAgentMemoryNativeExactAccessPublication,
): Uint8Array {
  const entries = (values: ForegroundAgentMemoryNativeExactAccessPublication[
    "currentEntries"
  ]) => values.map((value) => ({
    ...value,
    headDigest: hex(value.headDigest),
    publicationDigest: hex(value.publicationDigest),
    publicationSetDigest: hex(value.publicationSetDigest),
    audienceFingerprint: hex(value.audienceFingerprint),
    envelopeHash: hex(value.envelopeHash),
  }));
  return sha256(digestEncoder.encode(JSON.stringify({
    domain: "nautilo/foreground-agent-memory-native-exact-access/v1",
    plan: {
      ...plan,
      currentRequiredNamespaceFingerprint:
        hex(plan.currentRequiredNamespaceFingerprint),
      targetRequiredNamespaceFingerprint:
        hex(plan.targetRequiredNamespaceFingerprint),
    },
    publication: {
      ...publication,
      payloadHash: hex(publication.payloadHash),
      currentManifestHash: hex(publication.currentManifestHash),
      nextManifestHash: hex(publication.nextManifestHash),
      nextManifestBytes: hex(publication.nextManifestBytes),
      targetEnvelopeBytes: publication.targetEnvelopeBytes.map(hex),
      currentEntries: entries(publication.currentEntries),
      targetEntries: entries(publication.targetEntries),
    },
  })));
}

/**
 * Durable idempotency binding for one already-authenticated Agent access
 * preparation. It contains only public coordinates and hashes, never roots,
 * keys, DEKs, payload bytes, or live Grant evidence.
 */
export function agentMemoryExactAccessRequestDigest(
  prepared: PreparedAgentMemoryExactAccess,
): Uint8Array {
  const snapshot = readPreparedAgentMemoryExactAccessSnapshot(prepared);
  const authority = snapshot.prepared.authority;
  return sha256(digestEncoder.encode(JSON.stringify({
    domain: "nautilo/agent-memory-exact-access-request/v1",
    plan: {
      operationId: snapshot.plan.operationId,
      memoryId: snapshot.plan.memoryId,
      cryptoObjectId: snapshot.plan.cryptoObjectId,
      expectedContentRevision: snapshot.plan.expectedContentRevision,
      expectedCryptoAccessRevision:
        snapshot.plan.expectedCryptoAccessRevision,
      nextCryptoAccessRevision: snapshot.plan.nextCryptoAccessRevision,
      anchorNamespaceId: snapshot.plan.anchorNamespaceId,
      currentNamespaceIds: snapshot.plan.currentNamespaceIds,
      targetNamespaceIds: snapshot.plan.targetNamespaceIds,
      currentRequiredNamespaceFingerprint:
        hex(snapshot.plan.currentRequiredNamespaceFingerprint),
      targetRequiredNamespaceFingerprint:
        hex(snapshot.plan.targetRequiredNamespaceFingerprint),
      currentBindings: snapshot.plan.currentBindings.map((entry) => ({
        ...entry,
        bindingHash: hex(entry.bindingHash),
      })),
      targetBindings: snapshot.plan.targetBindings.map((entry) => ({
        ...entry,
        bindingHash: hex(entry.bindingHash),
      })),
      productMutation: snapshot.plan.productMutation,
    },
    access: {
      manifestHash: hex(snapshot.prepared.manifestHash),
      currentManifestHash: hex(snapshot.prepared.manifest.previousManifestHash!),
      payloadHash: hex(snapshot.prepared.manifest.payloadHash),
      currentEnvelopeHashes: authority.currentEnvelopes.map((entry) =>
        hex(entry.envelopeHash)
      ),
      targetEnvelopeHashes: authority.targetEnvelopes.map((entry) =>
        hex(entry.envelopeHash)
      ),
      agentId: authority.agentId,
      runtimeGeneration: authority.runtimeGeneration,
      agentAuthorizationRevision: authority.agentAuthorizationRevision,
      signerKeyId: authority.signerKeyId,
      grantId: authority.grantId,
      grantHash: hex(authority.grantHash),
      grantUseStatus: authority.grantUseStatus,
    },
  })));
}

type PrepareRequest = Readonly<{
  capability: ProtectedInvocationCapability;
  entrypointId: ProtectedAgentRuntimeForegroundEntrypointId;
  agentId: string;
  authority: ProtectedMemoryAuthority;
  requestedNamespaceIds: readonly string[];
  allowedDomainIds: readonly string[];
  sourceNamespaceId: string | null;
  plan: AgentMemoryExactAccessPlan;
  signal?: AbortSignal;
}>;

export interface ProtectedAgentMemoryExactAccessContentPort {
  prepare(
    input: PrepareRequest,
  ): Promise<ProtectedAgentMemorySessionContentResult<
    ProtectedMemoryResult<PreparedAgentMemoryExactAccess>
  >>;

  authorizeCommit<Value>(
    input: PrepareRequest & Readonly<{
      prepared: PreparedAgentMemoryExactAccess;
      commit(): ProtectedMemoryResult<Value> | PromiseLike<ProtectedMemoryResult<Value>>;
    }>,
  ): Promise<ProtectedAgentMemorySessionContentResult<
    ProtectedMemoryResult<Value>
  >>;
}

function unavailable<Value>(reason: "authorization_required" | "stale_revision" | "incomplete_access_set" | "integrity_failure" | "target_encryption_not_ready"):
  ProtectedMemoryResult<Value> {
  return Object.freeze({ status: "unavailable", reason });
}

function sessionUnavailable<Value>(reason: "authorization_unavailable" | "content_unavailable" | "content_invalid"):
  ProtectedAgentMemorySessionContentResult<Value> {
  return Object.freeze({ status: "unavailable", reason });
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function exactIds(value: unknown, allowEmpty = false): readonly string[] | null {
  if (
    !Array.isArray(value)
    || value.length > MAX_NAMESPACES
    || (!allowEmpty && value.length === 0)
    || value.some((entry) => typeof entry !== "string" || !UUID.test(entry))
    || value.some((entry, index) =>
      index > 0 && String(value[index - 1]) >= String(entry)
    )
  ) return null;
  return Object.freeze(value.map(String));
}

function exactPortableIds(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > MAX_NAMESPACES
    || value.some((entry) =>
      typeof entry !== "string" || !PORTABLE_ID.test(entry)
    )
    || value.some((entry, index) =>
      index > 0 && String(value[index - 1]) >= String(entry)
    )
  ) return null;
  return Object.freeze(value.map(String));
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function cloneBindings(
  bindings: readonly AgentMemoryExactAccessBindingFact[],
): readonly AgentObjectAccessSetNamespaceBinding[] {
  return Object.freeze(bindings.map((binding) => Object.freeze({
    ...binding,
    bindingHash: binding.bindingHash.slice(),
  })));
}

function planIsExact(plan: AgentMemoryExactAccessPlan): boolean {
  const current = exactIds(plan.currentNamespaceIds);
  const target = exactIds(plan.targetNamespaceIds, true);
  const added = exactIds(plan.addedNamespaceIds, true);
  const removed = exactIds(plan.removedNamespaceIds, true);
  const currentSet = new Set(current ?? []);
  const targetSet = new Set(target ?? []);
  return PORTABLE_ID.test(plan.operationId)
    && UUID.test(plan.memoryId)
    && PORTABLE_ID.test(plan.cryptoObjectId)
    && Number.isSafeInteger(plan.expectedContentRevision)
    && plan.expectedContentRevision > 0
    && Number.isSafeInteger(plan.expectedCryptoAccessRevision)
    && plan.expectedCryptoAccessRevision >= 0
    && plan.nextCryptoAccessRevision === plan.expectedCryptoAccessRevision + 1
    && current !== null
    && target !== null
    && added !== null
    && removed !== null
    && UUID.test(plan.anchorNamespaceId)
    && current.includes(plan.anchorNamespaceId)
    && sameIds(added, target.filter((id) => !currentSet.has(id)))
    && sameIds(removed, current.filter((id) => !targetSet.has(id)))
    && added.length + removed.length > 0
    && plan.currentBindings.length === current.length
    && plan.targetBindings.length === target.length
    && plan.currentBindings.every((entry, index) =>
      entry.namespaceId === current[index]
      && PORTABLE_ID.test(entry.domainId)
      && Number.isSafeInteger(entry.expectedAccessRevision)
      && entry.expectedAccessRevision >= 0
      && Number.isSafeInteger(entry.expectedPolicyRevision)
      && entry.expectedPolicyRevision >= 0
      && entry.bindingHash.length === 32
    )
    && plan.targetBindings.every((entry, index) =>
      entry.namespaceId === target[index]
      && PORTABLE_ID.test(entry.domainId)
      && Number.isSafeInteger(entry.expectedAccessRevision)
      && entry.expectedAccessRevision >= 0
      && Number.isSafeInteger(entry.expectedPolicyRevision)
      && entry.expectedPolicyRevision >= 0
      && entry.bindingHash.length === 32
    )
    && plan.currentRequiredNamespaceFingerprint.length === 32
    && plan.targetRequiredNamespaceFingerprint.length === 32
    && bytesEqual(
      plan.currentRequiredNamespaceFingerprint,
      fingerprintRequiredMemoryNamespaces(current),
    )
    && (target.length === 0 || bytesEqual(
      plan.targetRequiredNamespaceFingerprint,
      fingerprintRequiredMemoryNamespaces(target),
    ))
    && (plan.productMutation.kind === "replace_exact"
      ? true
      : plan.productMutation.kind === "grant_namespace"
      ? UUID.test(plan.productMutation.namespaceId)
        && added.length === 1
        && added[0] === plan.productMutation.namespaceId
        && removed.length === 0
      : UUID.test(plan.productMutation.scopeId)
        && UUID.test(plan.productMutation.sourceOriginNamespaceId)
        && UUID.test(plan.productMutation.targetNamespaceId)
        && removed.length === 1
        && removed[0] === plan.productMutation.sourceOriginNamespaceId
        && added.length === 1
        && added[0] === plan.productMutation.targetNamespaceId);
}

function materialFor(
  material: ProtectedNamespaceKeyringSetMaterial,
  namespaceId: string,
) {
  const matches = material.namespaces.filter((entry) =>
    entry.namespaceId === namespaceId
  );
  return matches.length === 1 ? matches[0]! : null;
}

function wipeVerified(value: VerifiedAgentMemoryCryptoRevisionContent | null): void {
  value?.payloadBytes.fill(0);
  value?.accessManifestBytes.fill(0);
  value?.accessManifestHash.fill(0);
  value?.accessManifestSignerPublicKey.fill(0);
  value?.accessManifestSignerAuthorizationBytes?.fill(0);
  value?.accessManifestSignerIssuingPublicKey?.fill(0);
  value?.accessSignerEvidence?.forEach((entry) => entry.evidenceBytes.fill(0));
  value?.namespaceEnvelopes.forEach((entry) => entry.envelopeBytes.fill(0));
}

function wipeBytes(value: Uint8Array | null): void {
  if (value !== null) value.fill(0);
}

function exactDeltaRequirements(plan: AgentMemoryExactAccessPlan) {
  return [
    ...plan.removedNamespaceIds.map((namespaceId) => Object.freeze({
      namespaceId,
      requiredOperations: ["decrypt"] as const,
    })),
    ...plan.addedNamespaceIds.map((namespaceId) => Object.freeze({
      namespaceId,
      requiredOperations: ["encrypt"] as const,
    })),
  ].sort((left, right) => left.namespaceId.localeCompare(right.namespaceId));
}

function namespaceAuthorityAllowsPlan(request: PrepareRequest): boolean {
  if (request.authority.mode !== "namespace") return false;
  const authority = request.authority;
  return (request.plan.addedNamespaceIds.length === 0
      || (request.sourceNamespaceId !== null
        && request.plan.currentNamespaceIds.includes(request.sourceNamespaceId)
        && authority.readableNamespaceIds.includes(request.sourceNamespaceId)))
    && request.plan.removedNamespaceIds.every((id) =>
    authority.mutableNamespaceIds.includes(id)
  ) && request.plan.addedNamespaceIds.every((id) =>
    authority.writableNamespaceId === id
    || authority.mutableNamespaceIds.includes(id)
  );
}

export function createProtectedAgentMemoryExactAccessContentPort(input: Readonly<{
  crypto: LatticeCrypto;
  storage: Pick<
    LatticeStorage,
    | "getGrant"
    | "consumeGrant"
    | "getNamespaceHead"
    | "getBinding"
    | "getAgentRuntimeAtomicState"
    | "getAgentRuntimeSignerPublication"
  >;
  authority: ProtectedGrantAuthoritySetPortV2;
  resolveHistoricalNamespaceCommitter: HistoricalCommitterResolver;
  resolveHistoricalRuntimeCommitter:
    HistoricalAgentRuntimeCommitterResolverV1;
  revisionReader: VerifiedAgentMemoryCryptoRevisionReader;
}>): ProtectedAgentMemoryExactAccessContentPort {
  return Object.freeze({
    async prepare(
      request: PrepareRequest,
    ): ReturnType<ProtectedAgentMemoryExactAccessContentPort["prepare"]> {
      const capability = inspectProtectedInvocationCapability(request.capability);
      if (
        capability === null
        || request.signal?.aborted === true
        || capability.recipientAgentId !== request.agentId
        || capability.issuingHumanId !== request.authority.subjectUserId
        || request.authority.agentId !== request.agentId
        || !planIsExact(request.plan)
        || exactIds(request.requestedNamespaceIds) === null
        || exactPortableIds(request.allowedDomainIds) === null
        || !sameIds(request.requestedNamespaceIds, capability.namespaceIds)
        || !sameIds(request.allowedDomainIds, capability.domainIds)
      ) return sessionUnavailable("authorization_unavailable");
      if (!namespaceAuthorityAllowsPlan(request)) return Object.freeze({
        status: "executed" as const,
        value: unavailable<PreparedAgentMemoryExactAccess>(
          "authorization_required",
        ),
      });

      const runtimeState = await input.storage.getAgentRuntimeAtomicState(
        request.agentId,
      );
      if (runtimeState === null) return sessionUnavailable("authorization_unavailable");
      try {
        const granted =
          await executeProtectedGrantSessionAuthoritySetCapabilityOperationV2<
            ProtectedMemoryResult<PreparedAgentMemoryExactAccess>
          >({
            capability: request.capability,
            crypto: input.crypto,
            storage: input.storage,
            authority: input.authority,
            execute: async (opened, evidence) => {
              const requirementById = new Map<string,
                typeof opened.namespaceRequirements[number]
              >(opened.namespaceRequirements.map(
                (entry) => [String(entry.namespaceId), entry] as const,
              ));
              const deltaRequirements = exactDeltaRequirements(request.plan);
              if (deltaRequirements.some(({ namespaceId, requiredOperations }) => {
                const requirement = requirementById.get(namespaceId);
                return requirement === undefined
                  || requiredOperations.some((operation) =>
                    !requirement.operations.includes(operation)
                  );
              })) return unavailable<PreparedAgentMemoryExactAccess>("authorization_required");
              const verified = await input.revisionReader.read(Object.freeze({
                memoryId: request.plan.memoryId,
                contentRevision: request.plan.expectedContentRevision,
                objectId: request.plan.cryptoObjectId,
                expectedAccessRevision: request.plan.expectedCryptoAccessRevision,
                expectedActiveNamespaceFingerprint:
                  request.plan.currentRequiredNamespaceFingerprint,
              } satisfies MemoryCryptoRevisionReference));
              if (verified === null) return unavailable<PreparedAgentMemoryExactAccess>("stale_revision");
              let dek: Uint8Array | null = null;
              let targetEnvelopeBytes: Uint8Array[] = [];
              try {
                if (
                  verified.memoryId !== request.plan.memoryId
                  || verified.contentRevision !== request.plan.expectedContentRevision
                  || verified.objectId !== request.plan.cryptoObjectId
                  || verified.accessRevision
                    !== request.plan.expectedCryptoAccessRevision
                  || !sameIds(
                    verified.requiredNamespaceIds,
                    request.plan.currentNamespaceIds,
                  )
                ) return unavailable<PreparedAgentMemoryExactAccess>("integrity_failure");
                const currentEnvelopeById = new Map(
                  verified.namespaceEnvelopes.map((entry) =>
                    [entry.namespaceId, entry.envelopeBytes] as const
                  ),
                );
                if (currentEnvelopeById.size !== request.plan.currentNamespaceIds.length) {
                  return unavailable<PreparedAgentMemoryExactAccess>("integrity_failure");
                }
                const buildTarget = (
                  sourceMaterial: ProtectedNamespaceKeyringSetMaterial | null,
                  addedMaterial: ProtectedNamespaceKeyringSetMaterial | null,
                ): ProtectedMemoryResult<readonly Uint8Array[]> => {
                  if (request.plan.addedNamespaceIds.length > 0) {
                    if (request.sourceNamespaceId === null || sourceMaterial === null) {
                      return unavailable("incomplete_access_set");
                    }
                    const source = materialFor(sourceMaterial, request.sourceNamespaceId);
                    const sourceEnvelopeBytes = currentEnvelopeById.get(
                      request.sourceNamespaceId,
                    );
                    if (source === null || sourceEnvelopeBytes === undefined) {
                      return unavailable("incomplete_access_set");
                    }
                    const sourceEnvelope = decodeNamespaceObjectEnvelopeV2(
                      sourceEnvelopeBytes,
                    );
                    const generation = source.generations.find((entry) =>
                      entry.generation === sourceEnvelope.context.keyGeneration
                    );
                    if (generation === undefined) {
                      sourceEnvelope.wrappedDek.fill(0);
                      return unavailable("incomplete_access_set");
                    }
                    dek = openObjectDekForNamespace(
                      input.crypto,
                      generation.key,
                      sourceEnvelope,
                    );
                    sourceEnvelope.wrappedDek.fill(0);
                    if (dek === null) {
                      return unavailable<readonly Uint8Array[]>(
                        "integrity_failure",
                      );
                    }
                  }
                  const next: Uint8Array[] = [];
                  for (const binding of request.plan.targetBindings) {
                    const retained = currentEnvelopeById.get(binding.namespaceId);
                    if (retained !== undefined) {
                      next.push(retained.slice());
                      continue;
                    }
                    if (addedMaterial === null || dek === null) {
                      next.forEach((bytes) => bytes.fill(0));
                      return unavailable("incomplete_access_set");
                    }
                    const target = materialFor(addedMaterial, binding.namespaceId);
                    if (
                      target === null
                      || target.accessRevision !== binding.expectedAccessRevision
                      || target.policyRevision !== binding.expectedPolicyRevision
                      || !bytesEqual(target.bindingHash, binding.bindingHash)
                    ) {
                      next.forEach((bytes) => bytes.fill(0));
                      return unavailable("target_encryption_not_ready");
                    }
                    const generation = target.generations.find((entry) =>
                      entry.generation === target.currentGeneration
                    );
                    if (generation === undefined) {
                      next.forEach((bytes) => bytes.fill(0));
                      return unavailable("target_encryption_not_ready");
                    }
                    next.push(encodeNamespaceObjectEnvelopeV2(
                      wrapObjectDekForNamespace(input.crypto, generation.key, {
                        objectId: objectId(request.plan.cryptoObjectId),
                        namespaceId: namespaceId(binding.namespaceId),
                        keyClass: "ai",
                        keyGeneration: namespaceGeneration(
                          generation.generation,
                        ),
                        bindingRevisionAtWrap: accessRevision(
                          binding.expectedAccessRevision,
                        ),
                      }, dek),
                    ));
                  }
                  return Object.freeze({
                    status: "success" as const,
                    value: Object.freeze(next),
                  });
                };

                let built: ProtectedMemoryResult<readonly Uint8Array[]>;
                if (request.plan.addedNamespaceIds.length === 0) {
                  built = buildTarget(null, null);
                } else {
                  if (
                    request.sourceNamespaceId === null
                    || !request.plan.currentNamespaceIds.includes(
                      request.sourceNamespaceId,
                    )
                    || !requirementById.get(request.sourceNamespaceId)
                      ?.operations.includes("decrypt")
                  ) return unavailable<PreparedAgentMemoryExactAccess>("authorization_required");
                  const source = await withProtectedCurrentNamespaceKeyringSet<
                    ProtectedMemoryResult<readonly Uint8Array[]>
                  >({
                    crypto: input.crypto,
                    storage: input.storage,
                    authority: input.authority,
                    resolveHistoricalCommitter:
                      input.resolveHistoricalNamespaceCommitter,
                    capability,
                    opened,
                    operation: "decrypt",
                    requestedNamespaceIds: [request.sourceNamespaceId],
                    viewDomainIds: request.allowedDomainIds,
                    expectedRuntimeAuthorizationRevision:
                      runtimeState.runtime.authorizationRevision,
                    ...(request.signal === undefined ? {} : { signal: request.signal }),
                    execute: async (sourceMaterial, assertSourceCurrent) => {
                      const added = await withProtectedCurrentNamespaceKeyringSet<
                        ProtectedMemoryResult<readonly Uint8Array[]>
                      >({
                        crypto: input.crypto,
                        storage: input.storage,
                        authority: input.authority,
                        resolveHistoricalCommitter:
                          input.resolveHistoricalNamespaceCommitter,
                        capability,
                        opened,
                        operation: "encrypt",
                        requestedNamespaceIds: request.plan.addedNamespaceIds,
                        viewDomainIds: request.allowedDomainIds,
                        expectedRuntimeAuthorizationRevision:
                          runtimeState.runtime.authorizationRevision,
                        ...(request.signal === undefined ? {} : { signal: request.signal }),
                        execute: async (addedMaterial, assertAddedCurrent) => {
                          await assertSourceCurrent();
                          await assertAddedCurrent();
                          return buildTarget(sourceMaterial, addedMaterial);
                        },
                      });
                      return added.status === "executed"
                        ? added.value
                        : unavailable("target_encryption_not_ready");
                    },
                  });
                  built = source.status === "executed"
                    ? source.value
                    : unavailable<readonly Uint8Array[]>(
                        "authorization_required",
                      );
                }
                if (built.status === "unavailable") return built;
                targetEnvelopeBytes = built.value.map((bytes) => bytes.slice());
                const runtimeRequirement = requirementById.get(
                  request.sourceNamespaceId
                    ?? request.plan.removedNamespaceIds[0]
                    ?? request.plan.addedNamespaceIds[0]!,
                );
                const domain = opened.domains.find((entry) =>
                  entry.domainId === runtimeRequirement?.domainId
                );
                if (runtimeRequirement === undefined || domain === undefined) {
                  return unavailable<PreparedAgentMemoryExactAccess>("authorization_required");
                }
                const runtimeResult = await withProtectedAgentRuntimeGeneration({
                  crypto: input.crypto,
                  storage: input.storage,
                  opened: {
                    grantId: opened.grantId,
                    namespaceId: namespaceId(runtimeRequirement.namespaceId),
                    namespaceAccessRevision: accessRevision(
                      runtimeRequirement.expectedAccessRevision,
                    ),
                    domainId: domain.domainId,
                    domainEpoch: domain.expectedEpoch,
                    agentAuthorizationRevision:
                      domain.expectedAgentAuthorizationRevision,
                    aiRoot: domain.aiRoot,
                  },
                  agentId: agentId(request.agentId),
                  resolveHistoricalCommitter:
                    input.resolveHistoricalRuntimeCommitter,
                  execute: async (runtime) => {
                    const publication: AgentRuntimeSignerPublication | null =
                      await input.storage.getAgentRuntimeSignerPublication(
                        request.agentId,
                        runtime.generation,
                      );
                    if (
                      publication === null
                      || publication.authorizationRevision
                        !== runtimeState.runtime.authorizationRevision
                      || !agentRuntimeSignerPublicationMatchesRuntime(
                        input.crypto,
                        runtime,
                        publication,
                      )
                    ) return unavailable<PreparedAgentMemoryExactAccess>("authorization_required");
                    return withGrantAuthoritySetExecutionEvidenceNamespaceSubset({
                      evidence,
                      namespaceRequirements: deltaRequirements,
                      execute: (deltaEvidence) => {
                        const currentManifest = decodeObjectAccessManifestV5(
                          verified.accessManifestBytes,
                        );
                        const prepared = prepareAgentObjectAccessManifestUpdateSet(
                          input.crypto,
                          {
                            currentManifestBytes: verified.accessManifestBytes,
                            currentEnvelopeBytes: verified.namespaceEnvelopes.map(
                              (entry) => entry.envelopeBytes,
                            ),
                            targetEnvelopeBytes,
                            authoritySet: deltaEvidence,
                            currentNamespaceBindings:
                              cloneBindings(request.plan.currentBindings),
                            targetNamespaceBindings:
                              cloneBindings(request.plan.targetBindings),
                            trustedMinimumHead: {
                              objectId: currentManifest.objectId,
                              payloadHash: currentManifest.payloadHash,
                              accessRevision: currentManifest.accessRevision,
                              manifestHash: verified.accessManifestHash,
                            },
                            proof: [],
                            resolveHistoricalHumanDeviceSigningPublicKey:
                              (context) =>
                                currentManifest.signer.kind === "human_device"
                                  && context.subjectHumanId
                                    === currentManifest.signer.subjectHumanId
                                  && context.committerDeviceId
                                    === currentManifest.signer.committerDeviceId
                                  ? verified.accessManifestSignerPublicKey
                                  : null,
                            resolveAgentRuntimeSignerPublicKey: (principal) =>
                              currentManifest.signer.kind === "agent_runtime"
                                && principal.agentId
                                  === currentManifest.signer.agentId
                                && principal.runtimeGeneration
                                  === currentManifest.signer.runtimeGeneration
                                && principal.signerKeyId
                                  === currentManifest.signer.signerKeyId
                                ? verified.accessManifestSignerPublicKey
                                : null,
                            resolveProcessorSignerAuthorizationBytes:
                              (evidence) =>
                                currentManifest.signer.kind
                                    === "processor_invocation"
                                  && evidence.authorizationId
                                    === currentManifest.signer
                                      .signerAuthorizationId
                                  ? verified
                                    .accessManifestSignerAuthorizationBytes
                                      ?? null
                                  : null,
                            resolveHistoricalProcessorIssuingDevicePublicKey:
                              () => verified
                                .accessManifestSignerIssuingPublicKey ?? null,
                            agentAuthorizationRevision:
                              runtimeState.runtime.authorizationRevision,
                            runtime,
                            signerPublication: publication,
                          },
                        );
                        const handle = Object.freeze({}) as PreparedAgentMemoryExactAccess;
                        preparedSnapshots.set(handle as object, Object.freeze({
                          plan: request.plan,
                          prepared,
                        }));
                        return Object.freeze({
                          status: "success" as const,
                          value: handle,
                        });
                      },
                    });
                  },
                });
                return runtimeResult.status === "executed"
                  ? runtimeResult.value
                  : unavailable<PreparedAgentMemoryExactAccess>("authorization_required");
              } finally {
                wipeBytes(dek);
                targetEnvelopeBytes.forEach((bytes) => bytes.fill(0));
                wipeVerified(verified);
              }
            },
          });
        if (granted.status === "unavailable") {
          return sessionUnavailable("authorization_unavailable");
        }
        return Object.freeze({
          status: "executed" as const,
          value: granted.value,
        });
      } catch {
        return sessionUnavailable("content_invalid");
      }
    },

    async authorizeCommit<Value>(
      request: PrepareRequest & Readonly<{
        prepared: PreparedAgentMemoryExactAccess;
        commit(): ProtectedMemoryResult<Value> | PromiseLike<ProtectedMemoryResult<Value>>;
      }>,
    ): Promise<ProtectedAgentMemorySessionContentResult<
      ProtectedMemoryResult<Value>
    >> {
      const capability = inspectProtectedInvocationCapability(
        request.capability,
      );
      const snapshot = preparedSnapshots.get(request.prepared as object);
      if (
        capability === null
        || request.signal?.aborted === true
        || capability.recipientAgentId !== request.agentId
        || capability.issuingHumanId !== request.authority.subjectUserId
        || request.authority.agentId !== request.agentId
        || snapshot === undefined
        || snapshot.plan !== request.plan
        || !planIsExact(request.plan)
        || exactIds(request.requestedNamespaceIds) === null
        || exactPortableIds(request.allowedDomainIds) === null
        || !sameIds(request.requestedNamespaceIds, capability.namespaceIds)
        || !sameIds(request.allowedDomainIds, capability.domainIds)
      ) return sessionUnavailable("authorization_unavailable");
      if (!namespaceAuthorityAllowsPlan(request)) {
        return Object.freeze({
          status: "executed" as const,
          value: unavailable<Value>("authorization_required"),
        });
      }
      try {
        assertAuthenticPreparedAgentObjectAccessManifestUpdateSet(
          snapshot.prepared,
        );
        const runtimeState = await input.storage.getAgentRuntimeAtomicState(
          request.agentId,
        );
        if (runtimeState === null) {
          return sessionUnavailable("authorization_unavailable");
        }
        const granted =
          await executeProtectedGrantSessionAuthoritySetCapabilityOperationV2<
            ProtectedMemoryResult<Value>
          >({
            capability: request.capability,
            crypto: input.crypto,
            storage: input.storage,
            authority: input.authority,
            execute: async (opened, evidence) => {
              const requirements = exactDeltaRequirements(request.plan);
              const requirementById = new Map(
                opened.namespaceRequirements.map((entry) =>
                  [String(entry.namespaceId), entry] as const
                ),
              );
              if (requirements.some(({ namespaceId, requiredOperations }) => {
                const current = requirementById.get(namespaceId);
                return current === undefined
                  || !current.operations.includes(requiredOperations[0]);
              })) return unavailable<Value>("authorization_required");
              const runtimeRequirement = requirementById.get(
                request.sourceNamespaceId
                  ?? request.plan.removedNamespaceIds[0]
                  ?? request.plan.addedNamespaceIds[0]!,
              );
              const domain = opened.domains.find((entry) =>
                entry.domainId === runtimeRequirement?.domainId
              );
              if (runtimeRequirement === undefined || domain === undefined) {
                return unavailable<Value>("authorization_required");
              }
              return withProtectedAgentRuntimeGeneration({
                crypto: input.crypto,
                storage: input.storage,
                opened: {
                  grantId: opened.grantId,
                  namespaceId: namespaceId(runtimeRequirement.namespaceId),
                  namespaceAccessRevision: accessRevision(
                    runtimeRequirement.expectedAccessRevision,
                  ),
                  domainId: domain.domainId,
                  domainEpoch: domain.expectedEpoch,
                  agentAuthorizationRevision:
                    domain.expectedAgentAuthorizationRevision,
                  aiRoot: domain.aiRoot,
                },
                agentId: agentId(request.agentId),
                resolveHistoricalCommitter:
                  input.resolveHistoricalRuntimeCommitter,
                execute: async (runtime) => {
                  const publication =
                    await input.storage.getAgentRuntimeSignerPublication(
                      request.agentId,
                      runtime.generation,
                    );
                  if (
                    publication === null
                    || publication.authorizationRevision
                      !== runtimeState.runtime.authorizationRevision
                    || !agentRuntimeSignerPublicationMatchesRuntime(
                      input.crypto,
                      runtime,
                      publication,
                    )
                  ) return unavailable<Value>("authorization_required");
                  return withGrantAuthoritySetExecutionEvidenceNamespaceSubset({
                    evidence,
                    namespaceRequirements: requirements,
                    execute: async (deltaEvidence) => {
                      const authority = snapshot.prepared.authority;
                      if (
                        authority.agentId !== request.agentId
                        || authority.runtimeGeneration !== runtime.generation
                        || authority.agentAuthorizationRevision
                          !== runtimeState.runtime.authorizationRevision
                        || authority.grantId !== deltaEvidence.grantId
                        || authority.grantUseStatus
                          !== deltaEvidence.grantUseStatus
                      ) return unavailable<Value>("authorization_required");
                      return request.commit();
                    },
                  });
                },
              }).then((result) =>
                result.status === "executed"
                  ? result.value
                  : unavailable<Value>("authorization_required")
              );
            },
          });
        return granted.status === "executed"
          ? Object.freeze({ status: "executed" as const, value: granted.value })
          : sessionUnavailable("authorization_unavailable");
      } catch {
        return sessionUnavailable("content_invalid");
      }
    },
  });
}
