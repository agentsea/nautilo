import {
  accessRevision,
  agentId,
  agentRuntimeSignerPublicationMatchesRuntime,
  decryptObjectThroughNamespace,
  namespaceId,
  withGrantAuthoritySetExecutionEvidenceSubset,
  type HistoricalCommitterResolver,
  type LatticeCrypto,
  type LatticeStorage,
  type OpenedGrantAuthoritySet,
} from "@nautilo/lattice-crypto";
import {
  backgroundWorkDescriptorDigestV2,
  decodeBackgroundAgentWorkDescriptorV2,
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  type BackgroundAgentWorkDescriptorV2,
  type HistoricalAgentRuntimeCommitterResolverV1,
} from "@nautilo/lattice-crypto/wire";

import {
  withProtectedAgentRuntimeGeneration,
} from "../invocation/protected-agent-runtime.ts";
import {
  destroyProtectedInvocationCapability,
  executeProtectedGrantAuthoritySetCapabilityOperationV2,
  inspectProtectedInvocationCapability,
  protectedInvocationCapabilityMatchesWorkDescriptor,
  type ProtectedGrantAuthoritySetFactsV2,
  type ProtectedGrantAuthoritySetPortV2,
  type ProtectedGrantOperationResult,
  type ProtectedInvocationCapability,
  type ProtectedInvocationCapabilityDescription,
} from "../invocation/protected-grant-invocation.ts";
import {
  withProtectedCurrentNamespaceKeyringSet,
  type ProtectedNamespaceKeyringSetEntryMaterial,
  type ProtectedNamespaceKeyringSetMaterial,
} from "../invocation/protected-namespace-keyring.ts";
import {
  CONVERSATION_MESSAGE_OBJECT_TYPE,
} from "../message/conversation-repository.ts";
import {
  decodeMessagePayloadV2,
  type MessagePayloadV2,
} from "../message/message-payload-v2.ts";
import type {
  ProtectedAgentBackgroundMemoryRevisionReader,
  ProtectedAgentBackgroundMessageRevisionReader,
} from "./agent-background-revision-reader.ts";
import type {
  AgentMemoryEmbedding,
  ProtectedMemoryMutationPlan,
} from "./active-memory-composition.ts";
import type {
  ProtectedMemoryAuthority,
  ProtectedMemoryResult,
} from "./active-memory-repository.ts";
import {
  prepareAgentMemoryCryptoRevision,
} from "./agent-memory-crypto.ts";
import {
  decodeMemoryPayloadV1,
  encodeMemoryPayloadV1,
  type MemoryPayloadV1,
} from "./memory-payload-v1.ts";
import {
  readPreparedMemoryCryptoRevisionSnapshot,
} from "./memory-prepared-revision.ts";
import {
  deriveMemoryCryptoObjectIdV1,
  MEMORY_OBJECT_TYPE,
  type PreparedMemoryCryptoRevision,
} from "./memory-repository.ts";

const HASH_BYTES = 32;

export type ProtectedAgentBackgroundMemoryWorkInput =
  | Readonly<{
    readonly productKind: "memory";
    readonly productId: string;
    readonly productRevision: number;
    readonly cryptoAccessRevision: number;
    readonly accessKind: "namespace" | "scope_seed" | "scope_origin";
    readonly importance: number;
    readonly tier: 1 | 2 | 3;
    readonly createdAt: number;
    readonly embedding: AgentMemoryEmbedding;
    readonly objectId: string;
    readonly namespaceId: string;
    readonly payload: MemoryPayloadV1;
  }>
  | Readonly<{
    readonly productKind: "message";
    readonly productId: string;
    readonly productRevision: number;
    readonly objectId: string;
    readonly namespaceId: string;
    readonly payload: MessagePayloadV2;
  }>;

export type ProtectedAgentBackgroundMemoryContentRevisionOutput = Readonly<{
  readonly kind: "content_revision";
  readonly publicationIdempotencyId: string;
  readonly memoryId: string;
  readonly payload: MemoryPayloadV1;
  readonly embedding: AgentMemoryEmbedding;
  readonly importance: number;
}>;

export type ProtectedAgentBackgroundMemoryTierTransitionOutput = Readonly<{
  readonly kind: "tier_transition";
  readonly operationIdempotencyId: string;
  readonly memoryId: string;
  readonly action: "promote" | "demote";
}>;

export type ProtectedAgentBackgroundMemoryWorkOutput =
  | ProtectedAgentBackgroundMemoryContentRevisionOutput
  | ProtectedAgentBackgroundMemoryTierTransitionOutput;

export type ProtectedAgentBackgroundMemoryTierPlan = Readonly<{
  operationIdempotencyId: string;
  descriptorHash: Uint8Array;
  authority: ProtectedMemoryAuthority;
  memoryId: string;
  contentRevision: number;
  cryptoAccessRevision: number;
  cryptoObjectId: string;
  action: "promote" | "demote";
  expectedTier: 1 | 2;
  nextTier: 1 | 2 | 3;
  requiredNamespaceIds: readonly string[];
}>;

export type ProtectedAgentBackgroundMemoryPublicationOutcome = Readonly<{
  readonly kind: "content_revision" | "tier_transition";
  readonly operationIdempotencyId: string;
  readonly memoryId: string;
  readonly status: "published" | "replayed" | "pending" | "stale" | "deleted";
}>;

export type ProtectedAgentBackgroundMemoryWorkResult =
  | Readonly<{
    readonly status: "completed" | "publication_pending" | "publication_failed";
    readonly publications:
      readonly ProtectedAgentBackgroundMemoryPublicationOutcome[];
  }>
  | Readonly<{
    readonly status: "unavailable";
    readonly reason:
      | "descriptor_invalid"
      | "authorization_unavailable"
      | "content_unavailable"
      | "content_invalid"
      | "transform_unavailable"
      | "transform_invalid"
      | "output_plan_unavailable"
      | "target_encryption_not_ready";
  }>;

export interface ProtectedAgentBackgroundMemoryProductPort {
  planBackgroundOutput(input: Readonly<{
    action: "create" | "replace";
    publicationIdempotencyId: string;
    descriptorHash: Uint8Array;
    authority: ProtectedMemoryAuthority;
    memoryId: string;
    expectedContentRevision: number;
    expectedCryptoAccessRevision: number;
    nextContentRevision: number;
    cryptoObjectId: string;
    requiredNamespaceIds: readonly string[];
    createdAt: number;
    embedding: AgentMemoryEmbedding;
    importance: number;
    signal?: AbortSignal;
  }>): Promise<ProtectedMemoryResult<ProtectedMemoryMutationPlan>>;
  publishPrepared(input: Readonly<{
    authority: ProtectedMemoryAuthority;
    plan: ProtectedMemoryMutationPlan;
    prepared: PreparedMemoryCryptoRevision;
    embedding: AgentMemoryEmbedding;
    signal?: AbortSignal;
  }>): Promise<"published" | "replayed" | "stale" | "deleted">;
  planBackgroundTier(
    input: ProtectedAgentBackgroundMemoryTierPlan,
  ): Promise<ProtectedMemoryResult<ProtectedAgentBackgroundMemoryTierPlan>>;
  commitBackgroundTier(input: Readonly<{
    plan: ProtectedAgentBackgroundMemoryTierPlan;
    signal?: AbortSignal;
  }>): Promise<"applied" | "replayed" | "stale" | "deleted">;
}

export interface ProtectedAgentBackgroundMemoryWorkPort {
  execute(input: Readonly<{
    capability: ProtectedInvocationCapability;
    descriptorBytes: Uint8Array;
    descriptorHash: Uint8Array;
    signal?: AbortSignal;
    transform: (
      inputs: readonly ProtectedAgentBackgroundMemoryWorkInput[],
    ) => Promise<readonly ProtectedAgentBackgroundMemoryWorkOutput[]>
      | readonly ProtectedAgentBackgroundMemoryWorkOutput[];
  }>): Promise<ProtectedGrantOperationResult<
    ProtectedAgentBackgroundMemoryWorkResult
  >>;
}

type PreparedContentOutput = Readonly<{
  kind: "content_revision";
  embedding: AgentMemoryEmbedding;
  plan: ProtectedMemoryMutationPlan;
  prepared: PreparedMemoryCryptoRevision;
}>;

type PreparedTierOutput = Readonly<{
  kind: "tier_transition";
  plan: ProtectedAgentBackgroundMemoryTierPlan;
}>;

type PreparedOutput = PreparedContentOutput | PreparedTierOutput;

type SelectedOutput = Readonly<{
  output: ProtectedAgentBackgroundMemoryWorkOutput;
  sourceIndex: number;
  requiredNamespaceIds: readonly string[];
}>;

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function equalStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((entry, index) => entry === right[index]);
}

function equalMemoryAuthority(
  left: ProtectedMemoryAuthority,
  right: ProtectedMemoryAuthority,
): boolean {
  if (
    left.mode !== right.mode
    || left.subjectUserId !== right.subjectUserId
    || left.agentId !== right.agentId
  ) return false;
  return left.mode === "scope" && right.mode === "scope"
    ? left.scopeId === right.scopeId
      && left.originWritableNamespaceId === right.originWritableNamespaceId
    : left.mode === "namespace" && right.mode === "namespace"
      && left.writableNamespaceId === right.writableNamespaceId
      && equalStrings(left.readableNamespaceIds, right.readableNamespaceIds)
      && equalStrings(left.mutableNamespaceIds, right.mutableNamespaceIds);
}

function canonicalStrings(value: readonly string[]): readonly string[] | null {
  if (value.length < 1 || new Set(value).size !== value.length) return null;
  const sorted = [...value].sort();
  return equalStrings(value, sorted) ? Object.freeze(sorted) : null;
}

function destroyDescriptor(descriptor: BackgroundAgentWorkDescriptorV2): void {
  descriptor.recipientPublicKey.fill(0);
  if (descriptor.source.kind === "synthetic_payload") {
    descriptor.source.fingerprint.fill(0);
  }
}

function unavailable(
  reason: Extract<
    ProtectedAgentBackgroundMemoryWorkResult,
    { status: "unavailable" }
  >["reason"],
): ProtectedAgentBackgroundMemoryWorkResult {
  return Object.freeze({ status: "unavailable", reason });
}

function outerUnavailable(): ProtectedGrantOperationResult<never> {
  return Object.freeze({
    status: "unavailable",
    reason: "authorization_unavailable",
  });
}

function requirementOperations(
  descriptor: BackgroundAgentWorkDescriptorV2,
): Map<string, readonly ("decrypt" | "encrypt")[]> {
  const operations = new Map<string, Set<"decrypt" | "encrypt">>();
  for (const binding of descriptor.inputBindings) {
    const current = operations.get(binding.namespaceId) ?? new Set();
    current.add("decrypt");
    operations.set(binding.namespaceId, current);
  }
  for (const slot of descriptor.outputSlots) {
    for (const targetNamespaceId of slot.namespaceIds) {
      const current = operations.get(targetNamespaceId) ?? new Set();
      current.add("encrypt");
      operations.set(targetNamespaceId, current);
    }
  }
  if (descriptor.source.kind === "protected_memory_work") {
    for (const mutation of descriptor.source.tierMutations) {
      for (const targetNamespaceId of mutation.requiredNamespaceIds) {
        const current = operations.get(targetNamespaceId) ?? new Set();
        current.add("encrypt");
        operations.set(targetNamespaceId, current);
      }
    }
  }
  return new Map([...operations].map(([key, value]) => [
    key,
    Object.freeze([...value].sort()),
  ]));
}

function exactDescriptorInventory(descriptor: BackgroundAgentWorkDescriptorV2): boolean {
  if (
    descriptor.source.kind !== "protected_memory_work"
    || descriptor.source.sourceVersion !== 1
    || descriptor.source.inputRevisions.length
      !== descriptor.inputBindings.length
    || descriptor.source.outputRevisions.length
      !== descriptor.outputSlots.length
    || descriptor.source.inputRevisions.length
      > descriptor.maximumInputObjectCount
    || descriptor.source.outputRevisions.length
      > descriptor.maximumOutputObjectCount
    || descriptor.source.tierMutations.length
      > descriptor.maximumOutputObjectCount
  ) return false;
  const inputObjectIds = descriptor.source.inputRevisions.map((entry) =>
    entry.objectId
  );
  const outputObjectIds = descriptor.source.outputRevisions.map((entry) =>
    entry.objectId
  );
  if (
    descriptor.source.inputRevisions.some((entry, index) =>
      entry.objectId !== descriptor.inputBindings[index]?.objectId
      || (entry.productKind === "memory" && entry.objectId
        !== deriveMemoryCryptoObjectIdV1({
          memoryId: entry.productId,
          contentRevision: entry.productRevision,
        }))
    )
    || descriptor.source.outputRevisions.some((entry, index) => {
      const slot = descriptor.outputSlots[index];
      return slot === undefined
        || entry.objectId !== slot.objectId
        || slot.objectType !== "memory.revision"
        || entry.objectId !== deriveMemoryCryptoObjectIdV1({
          memoryId: entry.memoryId,
          contentRevision: entry.nextContentRevision,
        });
    })
    || new Set(inputObjectIds).size !== inputObjectIds.length
    || new Set(outputObjectIds).size !== outputObjectIds.length
    || outputObjectIds.some((entry) => inputObjectIds.includes(entry))
    || new Set(descriptor.source.outputRevisions.map((entry) =>
      entry.publicationIdempotencyId
    )).size !== descriptor.source.outputRevisions.length
  ) return false;
  const expectedOperations = requirementOperations(descriptor);
  const expectedNamespaceIds = [...expectedOperations.keys()].sort();
  const actualNamespaceIds = descriptor.namespaceRequirements.map((entry) =>
    entry.namespaceId
  );
  if (
    !equalStrings(expectedNamespaceIds, actualNamespaceIds)
    || descriptor.namespaceRequirements.some((entry) =>
      !equalStrings(
        entry.operations,
        expectedOperations.get(entry.namespaceId) ?? [],
      )
    )
  ) return false;
  const expectedWorkOperations = [
    ...new Set([...expectedOperations.values()].flat()),
  ].sort();
  if (!equalStrings(descriptor.operations, expectedWorkOperations)) return false;
  const expectedDomainIds = [...new Set(
    descriptor.namespaceRequirements.map((entry) => entry.domainId),
  )].sort();
  return equalStrings(
    descriptor.domainRequirements.map((entry) => entry.domainId),
    expectedDomainIds,
  );
}

function capabilityMatchesDescriptor(
  capability: ProtectedInvocationCapabilityDescription,
  descriptor: BackgroundAgentWorkDescriptorV2,
): boolean {
  return capability.recipientAgentId === descriptor.subject.agentId
    && capability.recipientKeyId === descriptor.recipientKeyId
    && capability.issuingHumanId !== ""
    && descriptor.grantScope.some((entry) => entry === capability.issuingHumanId)
    && capability.issuedAt === descriptor.issuedAt
    && capability.expiresAt === descriptor.expiresAt
    && equalStrings(
      capability.namespaceIds,
      descriptor.namespaceRequirements.map((entry) => entry.namespaceId),
    )
    && equalStrings(
      capability.domainIds,
      descriptor.domainRequirements.map((entry) => entry.domainId),
    );
}

function descriptorMatchesFacts(
  descriptor: BackgroundAgentWorkDescriptorV2,
  facts: ProtectedGrantAuthoritySetFactsV2,
): boolean {
  return facts.recipientAgentId === descriptor.subject.agentId
    && facts.recipientKeyId === descriptor.recipientKeyId
    && equalStrings(facts.grantScope, descriptor.grantScope)
    && facts.namespaceRequirements.length
      === descriptor.namespaceRequirements.length
    && facts.domainRequirements.length === descriptor.domainRequirements.length
    && facts.namespaceRequirements.every((actual, index) => {
      const expected = descriptor.namespaceRequirements[index];
      return expected !== undefined
        && actual.namespaceId === expected.namespaceId
        && actual.domainId === expected.domainId
        && equalStrings(actual.operations, expected.operations)
        && actual.expectedAccessRevision === expected.expectedAccessRevision
        && actual.expectedPolicyRevision === expected.expectedPolicyRevision;
    })
    && facts.domainRequirements.every((actual, index) => {
      const expected = descriptor.domainRequirements[index];
      return expected !== undefined
        && actual.domainId === expected.domainId
        && actual.expectedEpoch === expected.expectedEpoch
        && actual.expectedAgentAuthorizationRevision
          === expected.expectedAgentAuthorizationRevision;
    });
}

function materialFor(
  material: ProtectedNamespaceKeyringSetMaterial,
  targetNamespaceId: string,
): ProtectedNamespaceKeyringSetEntryMaterial | null {
  const matches = material.namespaces.filter((entry) =>
    entry.namespaceId === targetNamespaceId
  );
  return matches.length === 1 ? matches[0]! : null;
}

async function decryptPayload(input: Readonly<{
  crypto: LatticeCrypto;
  objectId: string;
  objectType: string;
  namespaceId: string;
  payloadBytes: Uint8Array;
  envelopeBytes: Uint8Array;
  material: ProtectedNamespaceKeyringSetEntryMaterial;
  assertCurrentAuthority: () => Promise<void>;
}>): Promise<Readonly<{ plaintext: Uint8Array; ciphertextBytes: number }>> {
  let payload: ReturnType<typeof decodeEncryptedPayloadV2> | null = null;
  let envelope: ReturnType<typeof decodeNamespaceObjectEnvelopeV2> | null =
    null;
  try {
    payload = decodeEncryptedPayloadV2(input.payloadBytes);
    envelope = decodeNamespaceObjectEnvelopeV2(input.envelopeBytes);
    if (
      payload.context.objectId !== input.objectId
      || payload.context.objectType !== input.objectType
      || payload.context.keyClass !== "ai"
      || envelope.context.objectId !== input.objectId
      || envelope.context.namespaceId !== input.namespaceId
      || envelope.context.keyClass !== "ai"
      || envelope.context.bindingRevisionAtWrap !== input.material.accessRevision
    ) throw new TypeError("Background encrypted input coordinates disagree");
    const keys = input.material.generations.filter((entry) =>
      entry.generation === envelope!.context.keyGeneration
    );
    if (keys.length !== 1) {
      throw new TypeError("Background encrypted input generation is missing");
    }
    await input.assertCurrentAuthority();
    const plaintext = decryptObjectThroughNamespace(
      input.crypto,
      keys[0]!.key,
      envelope,
      payload,
    );
    if (plaintext === null) throw new TypeError("Background input is corrupt");
    return Object.freeze({
      plaintext,
      ciphertextBytes: input.payloadBytes.length + input.envelopeBytes.length,
    });
  } finally {
    payload?.ciphertext.fill(0);
    envelope?.wrappedDek.fill(0);
  }
}

function runtimeDomain(
  opened: OpenedGrantAuthoritySet,
  material: ProtectedNamespaceKeyringSetMaterial,
) {
  const namespace = material.namespaces[0];
  if (namespace === undefined) return null;
  const domain = opened.domains.find((entry) =>
    entry.domainId === namespace.domainId
  );
  return domain === undefined ? null : Object.freeze({
    grantId: opened.grantId,
    namespaceId: namespaceId(namespace.namespaceId),
    namespaceAccessRevision: accessRevision(namespace.accessRevision),
    domainId: domain.domainId,
    domainEpoch: domain.expectedEpoch,
    agentAuthorizationRevision: domain.expectedAgentAuthorizationRevision,
    aiRoot: domain.aiRoot,
  });
}

function snapshotOutput(
  value: ProtectedAgentBackgroundMemoryWorkOutput,
): ProtectedAgentBackgroundMemoryWorkOutput {
  if (value.kind === "tier_transition") {
    return Object.freeze({
      kind: value.kind,
      operationIdempotencyId: value.operationIdempotencyId,
      memoryId: value.memoryId,
      action: value.action,
    });
  }
  return Object.freeze({
    kind: value.kind,
    publicationIdempotencyId: value.publicationIdempotencyId,
    memoryId: value.memoryId,
    payload: Object.freeze({ ...value.payload }),
    embedding: Object.freeze({
      ...value.embedding,
      vector: Object.freeze([...value.embedding.vector]),
    }),
    importance: value.importance,
  });
}

function preparedCiphertextBytes(prepared: PreparedMemoryCryptoRevision): number {
  const snapshot = readPreparedMemoryCryptoRevisionSnapshot(prepared);
  return snapshot.object.payloadBytes.ciphertext.length
    + snapshot.access.manifestBytes.length
    + snapshot.access.envelopeBytes.reduce(
      (total, bytes) => total + bytes.length,
      0,
    );
}

export function createProtectedAgentBackgroundMemoryWorkPort(input: Readonly<{
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
  memoryReader: ProtectedAgentBackgroundMemoryRevisionReader;
  messageReader: ProtectedAgentBackgroundMessageRevisionReader;
  product: ProtectedAgentBackgroundMemoryProductPort;
}>): ProtectedAgentBackgroundMemoryWorkPort {
  return Object.freeze({
    async execute(request: Readonly<{
      capability: ProtectedInvocationCapability;
      descriptorBytes: Uint8Array;
      descriptorHash: Uint8Array;
      signal?: AbortSignal;
      transform: (
        inputs: readonly ProtectedAgentBackgroundMemoryWorkInput[],
      ) => Promise<readonly ProtectedAgentBackgroundMemoryWorkOutput[]>
        | readonly ProtectedAgentBackgroundMemoryWorkOutput[];
    }>): Promise<ProtectedGrantOperationResult<
      ProtectedAgentBackgroundMemoryWorkResult
    >> {
      let descriptor: BackgroundAgentWorkDescriptorV2 | null = null;
      let calculatedHash: Uint8Array | null = null;
      let descriptorHash: Uint8Array | null = null;
      try {
        if (
          !(request.descriptorBytes instanceof Uint8Array)
          || !(request.descriptorHash instanceof Uint8Array)
          || request.descriptorHash.length !== HASH_BYTES
          || request.signal?.aborted === true
          || typeof request.transform !== "function"
        ) throw new TypeError("Background Memory request is malformed");
        descriptorHash = Uint8Array.from(request.descriptorHash);
        descriptor = decodeBackgroundAgentWorkDescriptorV2(
          Uint8Array.from(request.descriptorBytes),
        );
        calculatedHash = backgroundWorkDescriptorDigestV2(
          input.crypto,
          descriptor,
        );
        const capability = inspectProtectedInvocationCapability(
          request.capability,
        );
        if (
          !equalBytes(calculatedHash, descriptorHash)
          || !protectedInvocationCapabilityMatchesWorkDescriptor(
            request.capability,
            descriptorHash,
          )
          || !exactDescriptorInventory(descriptor)
          || capability === null
          || !capabilityMatchesDescriptor(capability, descriptor)
        ) throw new TypeError("Background Memory descriptor is invalid");

        const exactDescriptor = descriptor;
        const exactCapability = capability;
        const exactHash = descriptorHash;
        const protectedSource = exactDescriptor.source;
        if (protectedSource.kind !== "protected_memory_work") {
          throw new TypeError("Background Memory source is invalid");
        }
        const authority: ProtectedGrantAuthoritySetPortV2 = Object.freeze({
          resolvePreflightFacts: async (factsRequest) => {
            const facts = await input.authority.resolvePreflightFacts(
              factsRequest,
            );
            return facts !== null
                && descriptorMatchesFacts(exactDescriptor, facts)
              ? facts
              : null;
          },
          resolveCurrentAuthorization: input.authority.resolveCurrentAuthorization,
        });
        const granted = await executeProtectedGrantAuthoritySetCapabilityOperationV2({
          capability: request.capability,
          crypto: input.crypto,
          storage: input.storage,
          authority,
          execute: async (opened, evidence) => {
            const source = protectedSource;
            const decryptNamespaceIds = [
              ...new Set(exactDescriptor.inputBindings.map((entry) =>
                entry.namespaceId
              )),
            ].sort();

            const publicationAuthority: ProtectedMemoryAuthority =
              source.productAuthority.mode === "scope"
                ? Object.freeze({
                    mode: "scope" as const,
                    subjectUserId: exactCapability.issuingHumanId,
                    agentId: exactDescriptor.subject.agentId,
                    scopeId: source.productAuthority.scopeId,
                    originWritableNamespaceId:
                      source.productAuthority.originWritableNamespaceId,
                  })
                : Object.freeze({
                    mode: "namespace" as const,
                    subjectUserId: exactCapability.issuingHumanId,
                    agentId: exactDescriptor.subject.agentId,
                    readableNamespaceIds: Object.freeze(
                      exactDescriptor.namespaceRequirements.map((entry) =>
                        entry.namespaceId
                      ),
                    ),
                    mutableNamespaceIds: Object.freeze([
                      ...new Set([
                        ...exactDescriptor.outputSlots.flatMap((slot) =>
                          slot.namespaceIds
                        ),
                        ...source.tierMutations.flatMap((mutation) =>
                          mutation.requiredNamespaceIds
                        ),
                      ]),
                    ].sort()),
                    writableNamespaceId: null,
                  });

            const withEncryptSet = async <Value>(
              namespaceIds: readonly string[],
              execute: () => Value | PromiseLike<Value>,
            ): Promise<ProtectedGrantOperationResult<Value>> => {
              const keyring = await withProtectedCurrentNamespaceKeyringSet({
                crypto: input.crypto,
                storage: input.storage,
                authority,
                resolveHistoricalCommitter:
                  input.resolveHistoricalNamespaceCommitter,
                capability: exactCapability,
                opened,
                operation: "encrypt",
                requestedNamespaceIds: namespaceIds,
                viewDomainIds: exactCapability.domainIds,
                expectedRuntimeAuthorizationRevision:
                  exactDescriptor.subject.authorizationRevision,
                ...(request.signal === undefined
                  ? {}
                  : { signal: request.signal }),
                execute: async (_material, assertCurrentAuthority) =>
                  withGrantAuthoritySetExecutionEvidenceSubset({
                    evidence,
                    namespaceIds,
                    requiredOperations: ["encrypt"],
                    execute: async () => {
                      await assertCurrentAuthority();
                      const value = await execute();
                      await assertCurrentAuthority();
                      return value;
                    },
                  }),
              });
              return keyring.status === "executed"
                ? Object.freeze({ status: "executed" as const, value: keyring.value })
                : Object.freeze({
                    status: "unavailable" as const,
                    reason: "authorization_unavailable" as const,
                  });
            };

            const runTransform = async (
              openedInputs: readonly ProtectedAgentBackgroundMemoryWorkInput[],
              plaintextBytes: number,
              ciphertextBytes: number,
              assertCurrentAuthority: () => Promise<void>,
            ): Promise<ProtectedAgentBackgroundMemoryWorkResult> => {
              await assertCurrentAuthority();
              let transformed: Awaited<ReturnType<typeof request.transform>>;
              try {
                transformed = await request.transform(Object.freeze(openedInputs));
              } catch {
                return unavailable("transform_unavailable");
              }
              const maximumResults = source.outputRevisions.length
                + source.tierMutations.length;
              if (!Array.isArray(transformed) || transformed.length > maximumResults) {
                return unavailable("transform_invalid");
              }
              let outputs: readonly ProtectedAgentBackgroundMemoryWorkOutput[];
              try {
                outputs = Object.freeze(transformed.map(snapshotOutput));
              } catch {
                return unavailable("transform_invalid");
              }

              const contentById = new Map(source.outputRevisions.map(
                (entry, index) => [entry.publicationIdempotencyId, {
                  entry,
                  index,
                  slot: exactDescriptor.outputSlots[index]!,
                }] as const,
              ));
              const tierOffset = source.outputRevisions.length;
              const tierById = new Map(source.tierMutations.map(
                (entry, index) => [entry.operationIdempotencyId, {
                  entry,
                  index: tierOffset + index,
                }] as const,
              ));
              if (
                contentById.size !== source.outputRevisions.length
                || tierById.size !== source.tierMutations.length
                || [...contentById.keys()].some((key) => tierById.has(key))
              ) return unavailable("descriptor_invalid");
              const selectedOutputs: SelectedOutput[] = [];
              const selectedMemoryIds = new Set<string>();
              let previousSourceIndex = -1;
              for (const output of outputs) {
                const selected = output.kind === "content_revision"
                  ? contentById.get(output.publicationIdempotencyId)
                  : tierById.get(output.operationIdempotencyId);
                if (
                  selected === undefined
                  || selected.index <= previousSourceIndex
                  || output.memoryId !== selected.entry.memoryId
                  || selectedMemoryIds.has(output.memoryId)
                  || (output.kind === "tier_transition"
                    && output.action !== selected.entry.action)
                ) return unavailable("transform_invalid");
                previousSourceIndex = selected.index;
                selectedMemoryIds.add(output.memoryId);
                selectedOutputs.push(Object.freeze({
                  output,
                  sourceIndex: selected.index,
                  requiredNamespaceIds: output.kind === "content_revision"
                    ? (selected as NonNullable<ReturnType<typeof contentById.get>>)
                      .slot.namespaceIds
                    : (selected as NonNullable<ReturnType<typeof tierById.get>>)
                      .entry.requiredNamespaceIds,
                }));
              }
              let outputPlaintextBytes = 0;
              for (const output of outputs) {
                if (output.kind !== "content_revision") continue;
                let encoded: Uint8Array | null = null;
                try {
                  encoded = encodeMemoryPayloadV1(output.payload);
                  outputPlaintextBytes += encoded.length;
                } catch {
                  return unavailable("transform_invalid");
                } finally {
                  encoded?.fill(0);
                }
              }
              if (
                plaintextBytes + outputPlaintextBytes
                  > exactDescriptor.maximumPlaintextBytes
              ) return unavailable("transform_invalid");

              const preparedOutputs: PreparedOutput[] = [];
              let outputCiphertextBytes = 0;
              for (const selected of selectedOutputs) {
                if (selected.output.kind === "tier_transition") {
                  const revision = source.tierMutations[
                    selected.sourceIndex - tierOffset
                  ];
                  if (revision === undefined) {
                    return unavailable("descriptor_invalid");
                  }
                  let planned;
                  try {
                    planned = await input.product.planBackgroundTier({
                      operationIdempotencyId: revision.operationIdempotencyId,
                      descriptorHash: exactHash,
                      authority: publicationAuthority,
                      memoryId: revision.memoryId,
                      contentRevision: revision.contentRevision,
                      cryptoAccessRevision: revision.cryptoAccessRevision,
                      cryptoObjectId: revision.objectId,
                      action: revision.action,
                      expectedTier: revision.expectedTier,
                      nextTier: revision.nextTier,
                      requiredNamespaceIds: revision.requiredNamespaceIds,
                    });
                  } catch {
                    return unavailable("output_plan_unavailable");
                  }
                  if (planned.status === "unavailable") {
                    return unavailable("output_plan_unavailable");
                  }
                  if (
                    planned.value.operationIdempotencyId
                      !== revision.operationIdempotencyId
                    || !equalBytes(planned.value.descriptorHash, exactHash)
                    || !equalMemoryAuthority(
                      planned.value.authority,
                      publicationAuthority,
                    )
                    || planned.value.memoryId !== revision.memoryId
                    || planned.value.contentRevision !== revision.contentRevision
                    || planned.value.cryptoAccessRevision
                      !== revision.cryptoAccessRevision
                    || planned.value.cryptoObjectId !== revision.objectId
                    || planned.value.action !== revision.action
                    || planned.value.expectedTier !== revision.expectedTier
                    || planned.value.nextTier !== revision.nextTier
                    || !equalStrings(
                      planned.value.requiredNamespaceIds,
                      revision.requiredNamespaceIds,
                    )
                  ) return unavailable("output_plan_unavailable");
                  preparedOutputs.push(Object.freeze({
                    kind: "tier_transition" as const,
                    plan: planned.value,
                  }));
                  continue;
                }

                const contentOutput = selected.output;
                const revision = source.outputRevisions[selected.sourceIndex];
                const slot = exactDescriptor.outputSlots[selected.sourceIndex];
                if (revision === undefined || slot === undefined) {
                  return unavailable("descriptor_invalid");
                }
                let planned: ProtectedMemoryResult<ProtectedMemoryMutationPlan>;
                try {
                  planned = await input.product.planBackgroundOutput({
                    action: revision.action,
                    publicationIdempotencyId:
                      revision.publicationIdempotencyId,
                    descriptorHash: exactHash,
                    authority: publicationAuthority,
                    memoryId: revision.memoryId,
                    expectedContentRevision: revision.expectedContentRevision,
                    expectedCryptoAccessRevision:
                      revision.expectedCryptoAccessRevision,
                    nextContentRevision: revision.nextContentRevision,
                    cryptoObjectId: revision.objectId,
                    requiredNamespaceIds: slot.namespaceIds,
                    createdAt: slot.createdAt,
                    embedding: contentOutput.embedding,
                    importance: contentOutput.importance,
                    ...(request.signal === undefined
                      ? {}
                      : { signal: request.signal }),
                  });
                } catch {
                  return unavailable("output_plan_unavailable");
                }
                if (
                  planned.status === "unavailable"
                  || planned.value.operationId
                    !== revision.publicationIdempotencyId
                  || planned.value.memoryId !== revision.memoryId
                  || planned.value.contentRevision !== revision.nextContentRevision
                  || planned.value.cryptoObjectId !== revision.objectId
                  || !equalStrings(
                    planned.value.requiredNamespaceIds,
                    slot.namespaceIds,
                  )
                ) return unavailable("output_plan_unavailable");

                let preparedResult: ProtectedGrantOperationResult<
                  PreparedMemoryCryptoRevision
                >;
                try {
                  const keyring = await withProtectedCurrentNamespaceKeyringSet({
                    crypto: input.crypto,
                    storage: input.storage,
                    authority,
                    resolveHistoricalCommitter:
                      input.resolveHistoricalNamespaceCommitter,
                    capability: exactCapability,
                    opened,
                    operation: "encrypt",
                    requestedNamespaceIds: slot.namespaceIds,
                    viewDomainIds: exactCapability.domainIds,
                    expectedRuntimeAuthorizationRevision:
                      exactDescriptor.subject.authorizationRevision,
                    ...(request.signal === undefined
                      ? {}
                      : { signal: request.signal }),
                    execute: (namespaceSet, assertOutputAuthority) =>
                      withGrantAuthoritySetExecutionEvidenceSubset({
                        evidence,
                        namespaceIds: slot.namespaceIds,
                        requiredOperations: ["encrypt"],
                        execute: async (subsetEvidence) => {
                          const openedRuntime = runtimeDomain(opened, namespaceSet);
                          if (openedRuntime === null) {
                            throw new Error("Background Runtime Domain is absent");
                          }
                          await assertOutputAuthority();
                          const runtimeResult =
                            await withProtectedAgentRuntimeGeneration({
                              crypto: input.crypto,
                              storage: input.storage,
                              opened: openedRuntime,
                              agentId: agentId(exactDescriptor.subject.agentId),
                              resolveHistoricalCommitter:
                                input.resolveHistoricalRuntimeCommitter,
                              execute: async (runtime) => {
                                if (
                                  runtime.generation
                                    !== exactDescriptor.subject.runtimeGeneration
                                ) throw new Error("Background Runtime generation is stale");
                                const publication = await input.storage
                                  .getAgentRuntimeSignerPublication(
                                    exactDescriptor.subject.agentId,
                                    runtime.generation,
                                  );
                                if (
                                  publication === null
                                  || publication.authorizationRevision
                                    !== exactDescriptor.subject.authorizationRevision
                                  || !agentRuntimeSignerPublicationMatchesRuntime(
                                    input.crypto,
                                    runtime,
                                    publication,
                                  )
                                ) throw new Error("Background Runtime signer is stale");
                                await assertOutputAuthority();
                                return prepareAgentMemoryCryptoRevision({
                                  crypto: input.crypto,
                                  memoryId: planned.value.memoryId,
                                  contentRevision: planned.value.contentRevision,
                                  payload: contentOutput.payload,
                                  createdAt: planned.value.createdAt,
                                  namespaceSet,
                                  authoritySet: subsetEvidence,
                                  runtime,
                                  signerPublication: publication,
                                });
                              },
                            });
                          if (runtimeResult.status !== "executed") {
                            throw new Error("Background Runtime is unavailable");
                          }
                          return runtimeResult.value;
                        },
                      }),
                  });
                  preparedResult = keyring.status === "executed"
                    ? Object.freeze({
                        status: "executed" as const,
                        value: keyring.value,
                      })
                    : Object.freeze({
                        status: "unavailable" as const,
                        reason: "authorization_unavailable" as const,
                      });
                } catch {
                  return unavailable("target_encryption_not_ready");
                }
                if (preparedResult.status !== "executed") {
                  return unavailable("target_encryption_not_ready");
                }
                outputCiphertextBytes += preparedCiphertextBytes(
                  preparedResult.value,
                );
                if (
                  ciphertextBytes + outputCiphertextBytes
                    > exactDescriptor.maximumCiphertextBytes
                ) return unavailable("transform_invalid");
                preparedOutputs.push(Object.freeze({
                  kind: "content_revision" as const,
                  embedding: contentOutput.embedding,
                  plan: planned.value,
                  prepared: preparedResult.value,
                }));
              }

              // Every selected operation is durably planned before the first
              // commit. Cross-role atomicity is intentionally not claimed:
              // each outcome is independently replayable after partial work.
              const publications: ProtectedAgentBackgroundMemoryPublicationOutcome[] = [];
              for (const prepared of preparedOutputs) {
                let status: ProtectedAgentBackgroundMemoryPublicationOutcome["status"];
                const requiredNamespaceIds = prepared.kind === "content_revision"
                  ? prepared.plan.requiredNamespaceIds
                  : prepared.plan.requiredNamespaceIds;
                try {
                  const committed = await withEncryptSet(
                    requiredNamespaceIds,
                    () => prepared.kind === "content_revision"
                      ? input.product.publishPrepared({
                          authority: publicationAuthority,
                          plan: prepared.plan,
                          prepared: prepared.prepared,
                          embedding: prepared.embedding,
                          ...(request.signal === undefined
                            ? {}
                            : { signal: request.signal }),
                        })
                      : input.product.commitBackgroundTier({
                          plan: prepared.plan,
                          ...(request.signal === undefined
                            ? {}
                            : { signal: request.signal }),
                        }),
                  );
                  if (committed.status !== "executed") {
                    status = "pending";
                  } else {
                    status = committed.value === "applied"
                      ? "published"
                      : committed.value;
                  }
                } catch {
                  status = "pending";
                }
                publications.push(Object.freeze({
                  kind: prepared.kind,
                  operationIdempotencyId: prepared.kind === "content_revision"
                    ? prepared.plan.operationId
                    : prepared.plan.operationIdempotencyId,
                  memoryId: prepared.plan.memoryId,
                  status,
                }));
              }
              const hasFailed = publications.some((entry) =>
                entry.status === "stale" || entry.status === "deleted"
              );
              const hasPending = publications.some((entry) =>
                entry.status === "pending"
              );
              return Object.freeze({
                status: hasFailed
                  ? "publication_failed" as const
                  : hasPending
                    ? "publication_pending" as const
                    : "completed" as const,
                publications: Object.freeze(publications),
              });
            };

            const openInputs = async (
              material: ProtectedNamespaceKeyringSetMaterial,
              assertCurrentAuthority: () => Promise<void>,
            ): Promise<ProtectedAgentBackgroundMemoryWorkResult> => {
              const openedInputs: ProtectedAgentBackgroundMemoryWorkInput[] = [];
              let plaintextBytes = 0;
              let ciphertextBytes = 0;
              for (const [index, inputRevision] of
                source.inputRevisions.entries()) {
                  const binding = exactDescriptor.inputBindings[index];
                  if (binding === undefined) {
                    return unavailable("descriptor_invalid");
                  }
                  const namespaceMaterial = materialFor(
                    material,
                    binding.namespaceId,
                  );
                  if (namespaceMaterial === null) {
                    return unavailable("authorization_unavailable");
                  }
                  let opaquePayload: Uint8Array | null = null;
                  let opaqueEnvelope: Uint8Array | null = null;
                  let plaintext: Uint8Array | null = null;
                  let memoryEnvelopeBytes: readonly Uint8Array[] = [];
                  let memoryAccessManifestBytes: Uint8Array | null = null;
                  let memoryAccessManifestHash: Uint8Array | null = null;
                  let memoryAccessManifestSignerPublicKey: Uint8Array | null = null;
                  try {
                    if (inputRevision.productKind === "memory") {
                      const verified = await input.memoryReader.read({
                        subjectUserId: exactCapability.issuingHumanId,
                        agentId: exactDescriptor.subject.agentId,
                        memoryId: inputRevision.productId,
                        contentRevision: inputRevision.productRevision,
                        cryptoAccessRevision:
                          inputRevision.cryptoAccessRevision,
                        accessKind: inputRevision.accessKind,
                        productAuthority: source.productAuthority,
                        objectId: inputRevision.objectId,
                        selectedNamespaceId: binding.namespaceId,
                      });
                      if (verified === null) {
                        return unavailable("content_unavailable");
                      }
                      opaquePayload = verified.payloadBytes;
                      memoryAccessManifestBytes = verified.accessManifestBytes;
                      memoryAccessManifestHash = verified.accessManifestHash;
                      memoryAccessManifestSignerPublicKey =
                        verified.accessManifestSignerPublicKey;
                      memoryEnvelopeBytes = verified.namespaceEnvelopes.map(
                        (entry) => entry.envelopeBytes,
                      );
                      const requiredNamespaceIds = canonicalStrings(
                        verified.requiredNamespaceIds,
                      );
                      const envelopeNamespaceIds = canonicalStrings(
                        verified.namespaceEnvelopes.map((entry) =>
                          entry.namespaceId
                        ),
                      );
                      if (
                        verified.memoryId !== inputRevision.productId
                        || verified.contentRevision !== inputRevision.productRevision
                        || verified.objectId !== inputRevision.objectId
                        || verified.accessRevision
                          !== inputRevision.cryptoAccessRevision
                        || requiredNamespaceIds === null
                        || envelopeNamespaceIds === null
                        || !equalStrings(
                          requiredNamespaceIds,
                          envelopeNamespaceIds,
                        )
                        || !requiredNamespaceIds.includes(binding.namespaceId)
                      ) return unavailable("content_invalid");
                      const selected = verified.namespaceEnvelopes.filter((entry) =>
                        entry.namespaceId === binding.namespaceId
                      );
                      if (selected.length !== 1) {
                        return unavailable("content_invalid");
                      }
                      opaqueEnvelope = selected[0]!.envelopeBytes;
                      const openedPayload = await decryptPayload({
                        crypto: input.crypto,
                        objectId: inputRevision.objectId,
                        objectType: MEMORY_OBJECT_TYPE,
                        namespaceId: binding.namespaceId,
                        payloadBytes: opaquePayload,
                        envelopeBytes: opaqueEnvelope,
                        material: namespaceMaterial,
                        assertCurrentAuthority,
                      });
                      plaintext = openedPayload.plaintext;
                      plaintextBytes += plaintext.length;
                      ciphertextBytes += openedPayload.ciphertextBytes;
                      openedInputs.push(Object.freeze({
                        productKind: "memory" as const,
                        productId: inputRevision.productId,
                        productRevision: inputRevision.productRevision,
                        cryptoAccessRevision:
                          inputRevision.cryptoAccessRevision,
                        accessKind: inputRevision.accessKind,
                        importance: verified.importance,
                        tier: verified.tier,
                        createdAt: verified.createdAt,
                        embedding: verified.embedding,
                        objectId: inputRevision.objectId,
                        namespaceId: binding.namespaceId,
                        payload: decodeMemoryPayloadV1(plaintext),
                      }));
                    } else {
                      const verified = await input.messageReader.read({
                        subjectUserId: exactCapability.issuingHumanId,
                        agentId: exactDescriptor.subject.agentId,
                        productId: inputRevision.productId,
                        productRevision: inputRevision.productRevision,
                        objectId: inputRevision.objectId,
                        selectedNamespaceId: binding.namespaceId,
                      });
                      if (verified === null) {
                        return unavailable("content_unavailable");
                      }
                      opaquePayload = verified.payloadBytes;
                      opaqueEnvelope = verified.namespaceEnvelopeBytes;
                      if (
                        verified.productId !== inputRevision.productId
                        || verified.productRevision !== inputRevision.productRevision
                        || verified.objectId !== inputRevision.objectId
                        || verified.namespaceId !== binding.namespaceId
                      ) return unavailable("content_invalid");
                      const openedPayload = await decryptPayload({
                        crypto: input.crypto,
                        objectId: inputRevision.objectId,
                        objectType: CONVERSATION_MESSAGE_OBJECT_TYPE,
                        namespaceId: binding.namespaceId,
                        payloadBytes: opaquePayload,
                        envelopeBytes: opaqueEnvelope,
                        material: namespaceMaterial,
                        assertCurrentAuthority,
                      });
                      plaintext = openedPayload.plaintext;
                      plaintextBytes += plaintext.length;
                      ciphertextBytes += openedPayload.ciphertextBytes;
                      const payload = decodeMessagePayloadV2(plaintext);
                      if (payload.role !== verified.role) {
                        return unavailable("content_invalid");
                      }
                      openedInputs.push(Object.freeze({
                        productKind: "message" as const,
                        productId: inputRevision.productId,
                        productRevision: inputRevision.productRevision,
                        objectId: inputRevision.objectId,
                        namespaceId: binding.namespaceId,
                        payload,
                      }));
                    }
                  } catch {
                    return unavailable("content_invalid");
                  } finally {
                    plaintext?.fill(0);
                    opaquePayload?.fill(0);
                    opaqueEnvelope?.fill(0);
                    memoryEnvelopeBytes.forEach((bytes) => bytes.fill(0));
                    memoryAccessManifestBytes?.fill(0);
                    memoryAccessManifestHash?.fill(0);
                    memoryAccessManifestSignerPublicKey?.fill(0);
                  }
                  if (
                    plaintextBytes > exactDescriptor.maximumPlaintextBytes
                    || ciphertextBytes > exactDescriptor.maximumCiphertextBytes
                  ) return unavailable("content_invalid");
                }
              return runTransform(
                Object.freeze(openedInputs),
                plaintextBytes,
                ciphertextBytes,
                assertCurrentAuthority,
              );
            };

            if (decryptNamespaceIds.length === 0) {
              return runTransform(Object.freeze([]), 0, 0, async () => {});
            }
            const exactDecryptNamespaceIds = canonicalStrings(
              decryptNamespaceIds,
            );
            if (exactDecryptNamespaceIds === null) {
              return unavailable("descriptor_invalid");
            }
            const decrypted = await withProtectedCurrentNamespaceKeyringSet({
              crypto: input.crypto,
              storage: input.storage,
              authority,
              resolveHistoricalCommitter:
                input.resolveHistoricalNamespaceCommitter,
              capability: exactCapability,
              opened,
              operation: "decrypt",
              requestedNamespaceIds: exactDecryptNamespaceIds,
              viewDomainIds: exactCapability.domainIds,
              expectedRuntimeAuthorizationRevision:
                exactDescriptor.subject.authorizationRevision,
              ...(request.signal === undefined
                ? {}
                : { signal: request.signal }),
              execute: openInputs,
            });
            return decrypted.status === "executed"
              ? decrypted.value
              : unavailable(
                  decrypted.reason === "namespace_invalid"
                    ? "content_invalid"
                    : "authorization_unavailable",
                );
          },
        });
        return granted;
      } catch {
        destroyProtectedInvocationCapability(request.capability);
        return outerUnavailable();
      } finally {
        calculatedHash?.fill(0);
        descriptorHash?.fill(0);
        if (descriptor !== null) destroyDescriptor(descriptor);
      }
    },
  });
}
