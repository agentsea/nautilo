import {
  type HistoricalCommitterResolver,
  type LatticeCrypto,
  type LatticeStorage,
  type OpenedGrantAuthoritySet,
  type OpenedGrantDomain,
  namespaceBindingHash,
  openNamespaceKeyring,
  verifyBindingEnvelopePair,
  verifyNamespaceBinding,
} from "@nautilo/lattice-crypto";
import {
  parseNamespaceBindingV2,
  parseNamespaceKeyringEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import type {
  ProtectedGrantAuthorityPort,
  ProtectedGrantAuthoritySetFactsV2,
  ProtectedGrantAuthoritySetPortV2,
  ProtectedGrantOperation,
  ProtectedInvocationCapabilityDescription,
} from "./protected-grant-invocation.ts";

export type ProtectedNamespaceKeyringMaterial = Readonly<{
  namespaceId: string;
  domainId: string;
  domainEpoch: number;
  accessRevision: number;
  agentAuthorizationRevision: number;
  bindingHash: Uint8Array;
  currentGeneration: number;
  generations: readonly Readonly<{
    generation: number;
    key: Uint8Array;
  }>[];
}>;

export type ProtectedNamespaceKeyringSetEntryMaterial = Readonly<{
  namespaceId: string;
  domainId: string;
  domainEpoch: number;
  accessRevision: number;
  policyRevision: number;
  domainAgentAuthorizationRevision: number;
  bindingHash: Uint8Array;
  currentGeneration: number;
  generations: readonly Readonly<{
    generation: number;
    key: Uint8Array;
  }>[];
}>;

export type ProtectedNamespaceKeyringSetMaterial = Readonly<{
  recipientAgentId: string;
  runtimeAuthorizationRevision: number;
  namespaces: readonly ProtectedNamespaceKeyringSetEntryMaterial[];
}>;

export type ProtectedNamespaceKeyringUnavailableReason =
  | "authorization_unavailable"
  | "namespace_unavailable"
  | "namespace_invalid";

export type ProtectedNamespaceKeyringResult<Value> =
  | Readonly<{ status: "executed"; value: Value }>
  | Readonly<{
      status: "unavailable";
      reason: ProtectedNamespaceKeyringUnavailableReason;
    }>;

class ProtectedNamespaceKeyringError extends Error {
  constructor(
    readonly code: "authorization_unavailable" | "content_unavailable",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProtectedNamespaceKeyringError";
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function equalStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function canonicalPortableIds(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > 256
    || value.some((item) =>
      typeof item !== "string"
      || item.length === 0
      || new TextEncoder().encode(item).length > 256
    )
    || value.some((item, index) =>
      index > 0 && String(value[index - 1]) >= String(item)
    )
  ) return null;
  return Object.freeze(Array.from(
    value,
    (item: unknown) => String(item),
  ));
}

function isSubset(
  subset: readonly string[],
  superset: readonly string[],
): boolean {
  const allowed = new Set(superset);
  return subset.every((value) => allowed.has(value));
}

function equalOperations(
  left: readonly ProtectedGrantOperation[],
  right: readonly ProtectedGrantOperation[],
): boolean {
  return equalStrings(left, right);
}

function authorityFactsMatchOpenedSet(
  facts: ProtectedGrantAuthoritySetFactsV2,
  capability: ProtectedInvocationCapabilityDescription,
  opened: OpenedGrantAuthoritySet,
): boolean {
  return facts.expectedIssuingDeviceId === capability.issuingDeviceId
    && facts.issuingDeviceHumanId === capability.issuingHumanId
    && facts.issuingDeviceActive
    && facts.recipientAgentId === capability.recipientAgentId
    && facts.recipientKeyId === capability.recipientKeyId
    && facts.hostAllowsOperation
    && facts.namespaceRequirements.length
      === opened.namespaceRequirements.length
    && facts.namespaceRequirements.every((entry, index) => {
      const expected = opened.namespaceRequirements[index];
      return expected !== undefined
        && entry.namespaceId === expected.namespaceId
        && entry.domainId === expected.domainId
        && equalOperations(entry.operations, expected.operations)
        && entry.expectedAccessRevision === expected.expectedAccessRevision
        && entry.expectedPolicyRevision === expected.expectedPolicyRevision;
    })
    && facts.domainRequirements.length === opened.domains.length
    && facts.domainRequirements.every((entry, index) => {
      const expected = opened.domains[index];
      return expected !== undefined
        && entry.domainId === expected.domainId
        && entry.expectedEpoch === expected.expectedEpoch
        && entry.expectedAgentAuthorizationRevision
          === expected.expectedAgentAuthorizationRevision;
    });
}

function authorityFactsRemainExact(
  baseline: ProtectedGrantAuthoritySetFactsV2,
  fresh: ProtectedGrantAuthoritySetFactsV2,
): boolean {
  return baseline.expectedIssuingDeviceId === fresh.expectedIssuingDeviceId
    && baseline.issuingDeviceHumanId === fresh.issuingDeviceHumanId
    && equalBytes(
      baseline.issuingDeviceSigningPublicKey,
      fresh.issuingDeviceSigningPublicKey,
    )
    && baseline.issuingDeviceActive === fresh.issuingDeviceActive
    && baseline.recipientAgentId === fresh.recipientAgentId
    && baseline.recipientKeyId === fresh.recipientKeyId
    && baseline.singleUseAvailable === fresh.singleUseAvailable
    && equalStrings(baseline.grantScope, fresh.grantScope)
    && baseline.hostAllowsOperation === fresh.hostAllowsOperation
    && baseline.namespaceRequirements.length
      === fresh.namespaceRequirements.length
    && baseline.namespaceRequirements.every((entry, index) => {
      const current = fresh.namespaceRequirements[index];
      return current !== undefined
        && entry.namespaceId === current.namespaceId
        && entry.domainId === current.domainId
        && equalOperations(entry.operations, current.operations)
        && equalStrings(
          entry.namespaceParticipants,
          current.namespaceParticipants,
        )
        && entry.expectedAccessRevision === current.expectedAccessRevision
        && entry.expectedPolicyRevision === current.expectedPolicyRevision;
    })
    && baseline.domainRequirements.length === fresh.domainRequirements.length
    && baseline.domainRequirements.every((entry, index) => {
      const current = fresh.domainRequirements[index];
      return current !== undefined
        && entry.domainId === current.domainId
        && entry.expectedEpoch === current.expectedEpoch
        && entry.expectedAgentAuthorizationRevision
          === current.expectedAgentAuthorizationRevision;
    });
}

function sameHead(
  left: NonNullable<Awaited<ReturnType<LatticeStorage["getNamespaceHead"]>>>,
  right: NonNullable<Awaited<ReturnType<LatticeStorage["getNamespaceHead"]>>>,
): boolean {
  return left.namespaceId === right.namespaceId
    && left.accessRevision === right.accessRevision
    && left.domainId === right.domainId
    && left.domainEpoch === right.domainEpoch
    && equalBytes(left.bindingHash, right.bindingHash);
}

function sameBindingRecord(
  left: NonNullable<Awaited<ReturnType<LatticeStorage["getBinding"]>>>,
  right: NonNullable<Awaited<ReturnType<LatticeStorage["getBinding"]>>>,
): boolean {
  return left.namespaceId === right.namespaceId
    && left.revision === right.revision
    && equalBytes(left.bindingHash, right.bindingHash)
    && (
      left.previousBindingHash === null
        ? right.previousBindingHash === null
        : right.previousBindingHash !== null
          && equalBytes(left.previousBindingHash, right.previousBindingHash)
    )
    && equalBytes(left.signedBindingBytes, right.signedBindingBytes)
    && equalBytes(
      left.humanKeyringEnvelopeBytes,
      right.humanKeyringEnvelopeBytes,
    )
    && equalBytes(left.aiKeyringEnvelopeBytes, right.aiKeyringEnvelopeBytes);
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function unavailable<Value>(
  reason: ProtectedNamespaceKeyringUnavailableReason,
): ProtectedNamespaceKeyringResult<Value> {
  return Object.freeze({ status: "unavailable", reason });
}

/**
 * Open one authenticated current AI Namespace keyring inside an already
 * authorized Grant operation. The Grant coordinator owns the Domain root;
 * this helper owns and wipes every opened Namespace generation.
 */
export async function withProtectedCurrentNamespaceKeyring<Value>(
  input: Readonly<{
    crypto: LatticeCrypto;
    storage: Pick<LatticeStorage, "getNamespaceHead" | "getBinding">;
    authority: ProtectedGrantAuthorityPort;
    resolveHistoricalCommitter: HistoricalCommitterResolver;
    capability: ProtectedInvocationCapabilityDescription;
    opened: OpenedGrantDomain;
    operation: ProtectedGrantOperation;
    namespaceId: string;
    domainId: string;
    expectedAccessRevision: number;
    expectedPolicyRevision: number;
    signal?: AbortSignal;
    execute(
      material: ProtectedNamespaceKeyringMaterial,
      assertCurrentAuthority: () => Promise<void>,
    ): Value | PromiseLike<Value>;
  }>,
): Promise<ProtectedNamespaceKeyringResult<Value>> {
  if (
    input.opened.namespaceId !== input.namespaceId
    || input.opened.domainId !== input.domainId
    || input.opened.namespaceAccessRevision
      !== input.expectedAccessRevision
    || input.opened.agentAuthorizationRevision
      !== input.expectedPolicyRevision
    || signalIsAborted(input.signal)
  ) {
    return unavailable("authorization_unavailable");
  }

  let head: Awaited<ReturnType<LatticeStorage["getNamespaceHead"]>>;
  let bindingRecord: Awaited<ReturnType<LatticeStorage["getBinding"]>>;
  try {
    [head, bindingRecord] = await Promise.all([
      input.storage.getNamespaceHead(input.namespaceId),
      input.storage.getBinding(
        input.namespaceId,
        input.expectedAccessRevision,
      ),
    ]);
  } catch {
    return unavailable("namespace_unavailable");
  }
  if (head === null || bindingRecord === null) {
    return unavailable("namespace_unavailable");
  }

  let keyring: ReturnType<typeof openNamespaceKeyring> | null = null;
  let executingCallback = false;
  try {
    const binding = parseNamespaceBindingV2(
      bindingRecord.signedBindingBytes,
    );
    const humanEnvelope = parseNamespaceKeyringEnvelopeV2(
      bindingRecord.humanKeyringEnvelopeBytes,
    );
    const aiEnvelope = parseNamespaceKeyringEnvelopeV2(
      bindingRecord.aiKeyringEnvelopeBytes,
    );
    const bindingHash = namespaceBindingHash(binding);
    if (
      head.namespaceId !== input.namespaceId
      || head.accessRevision !== input.expectedAccessRevision
      || head.domainId !== input.domainId
      || head.domainEpoch !== input.opened.domainEpoch
      || binding.namespaceId !== head.namespaceId
      || binding.accessRevision !== head.accessRevision
      || binding.domainId !== head.domainId
      || binding.domainEpoch !== head.domainEpoch
      || !equalBytes(bindingHash, head.bindingHash)
      || !equalBytes(bindingHash, bindingRecord.bindingHash)
      || !verifyBindingEnvelopePair(
        binding,
        humanEnvelope,
        aiEnvelope,
      )
    ) {
      return unavailable("namespace_invalid");
    }
    verifyNamespaceBinding({
      crypto: input.crypto,
      binding,
      resolveHistoricalCommitter: input.resolveHistoricalCommitter,
    });
    keyring = openNamespaceKeyring({
      crypto: input.crypto,
      domainRoot: input.opened.aiRoot,
      envelope: aiEnvelope,
      resolveHistoricalCommitter: input.resolveHistoricalCommitter,
    });
    if (
      keyring.namespaceId !== input.namespaceId
      || keyring.keyClass !== "ai"
      || keyring.accessRevision !== input.expectedAccessRevision
      || signalIsAborted(input.signal)
    ) {
      return unavailable("namespace_invalid");
    }
    const material: ProtectedNamespaceKeyringMaterial = Object.freeze({
      namespaceId: input.namespaceId,
      domainId: input.domainId,
      domainEpoch: head.domainEpoch,
      accessRevision: input.expectedAccessRevision,
      agentAuthorizationRevision: input.expectedPolicyRevision,
      bindingHash: head.bindingHash.slice(),
      currentGeneration: keyring.currentGeneration,
      generations: Object.freeze(
        keyring.generations.map((entry) =>
          Object.freeze({
            generation: entry.generation,
            key: entry.key,
          })
        ),
      ),
    });
    const assertCurrentAuthority = async (): Promise<void> => {
      if (signalIsAborted(input.signal)) {
        throw new ProtectedNamespaceKeyringError(
          "authorization_unavailable",
          "protected Namespace authority was cancelled",
        );
      }
      let freshFacts: Awaited<ReturnType<
        ProtectedGrantAuthorityPort["resolvePreflightFacts"]
      >>;
      let freshHead: Awaited<
        ReturnType<LatticeStorage["getNamespaceHead"]>
      >;
      try {
        [freshFacts, freshHead] = await Promise.all([
          input.authority.resolvePreflightFacts({
            phase: "preflight",
            coordinates: input.capability,
            operation: input.operation,
          }),
          input.storage.getNamespaceHead(input.namespaceId),
        ]);
      } catch (cause) {
        throw new ProtectedNamespaceKeyringError(
          "content_unavailable",
          cause instanceof Error
            ? `protected Namespace authority storage failed: ${cause.message}`
            : "protected Namespace authority storage failed",
          { cause },
        );
      }
      if (
        freshFacts === null
        || freshFacts.expectedIssuingDeviceId
          !== input.capability.issuingDeviceId
        || freshFacts.issuingDeviceHumanId
          !== input.capability.issuingHumanId
        || !freshFacts.issuingDeviceActive
        || freshFacts.recipientAgentId
          !== input.capability.recipientAgentId
        || freshFacts.recipientKeyId
          !== input.capability.recipientKeyId
        || freshFacts.operation !== input.operation
        || freshFacts.namespaceId !== input.namespaceId
        || freshFacts.domainId !== input.domainId
        || freshFacts.namespaceAccessRevision
          !== input.expectedAccessRevision
        || freshFacts.agentAuthorizationRevision
          !== input.expectedPolicyRevision
        || freshFacts.domainEpoch !== input.opened.domainEpoch
        || !freshFacts.hostAllowsOperation
        || freshHead === null
        || freshHead.namespaceId !== head.namespaceId
        || freshHead.accessRevision !== head.accessRevision
        || freshHead.domainId !== head.domainId
        || freshHead.domainEpoch !== head.domainEpoch
        || !equalBytes(freshHead.bindingHash, head.bindingHash)
      ) {
        throw new ProtectedNamespaceKeyringError(
          "authorization_unavailable",
          "protected Namespace authority changed",
        );
      }
    };
    executingCallback = true;
    const value = await input.execute(material, assertCurrentAuthority);
    executingCallback = false;
    try {
      await assertCurrentAuthority();
    } catch (error) {
      if (
        error instanceof ProtectedNamespaceKeyringError
        && error.code === "content_unavailable"
      ) {
        return unavailable("namespace_unavailable");
      }
      return unavailable("authorization_unavailable");
    }
    return Object.freeze({ status: "executed" as const, value });
  } catch (error) {
    if (executingCallback) throw error;
    return unavailable("namespace_invalid");
  } finally {
    if (keyring !== null) {
      for (const generation of keyring.generations) {
        generation.key.fill(0);
      }
    }
  }
}

/**
 * Open an exact canonical subset of current AI Namespace keyrings inside one
 * already-authorized reusable Grant authority-set callback. Domain roots stay
 * with the Grant coordinator; this helper owns and wipes every opened
 * Namespace generation and revalidates the full authority set, selected
 * bindings, and global Runtime authorization after the callback.
 */
export async function withProtectedCurrentNamespaceKeyringSet<Value>(
  input: Readonly<{
    crypto: LatticeCrypto;
    storage: Pick<
      LatticeStorage,
      "getNamespaceHead" | "getBinding" | "getAgentRuntimeAtomicState"
    >;
    authority: ProtectedGrantAuthoritySetPortV2;
    resolveHistoricalCommitter: HistoricalCommitterResolver;
    capability: ProtectedInvocationCapabilityDescription;
    opened: OpenedGrantAuthoritySet;
    operation: ProtectedGrantOperation;
    requestedNamespaceIds: readonly string[];
    viewDomainIds: readonly string[];
    expectedRuntimeAuthorizationRevision: number;
    signal?: AbortSignal;
    execute(
      material: ProtectedNamespaceKeyringSetMaterial,
      assertCurrentAuthority: () => Promise<void>,
    ): Value | PromiseLike<Value>;
  }>,
): Promise<ProtectedNamespaceKeyringResult<Value>> {
  const requestedNamespaceIds = canonicalPortableIds(
    input.requestedNamespaceIds,
  );
  const viewDomainIds = canonicalPortableIds(input.viewDomainIds);
  const capabilityNamespaceIds = canonicalPortableIds(
    input.capability.namespaceIds,
  );
  const capabilityDomainIds = canonicalPortableIds(
    input.capability.domainIds,
  );
  const openedNamespaceIds = canonicalPortableIds(
    input.opened.namespaceRequirements.map((entry) => entry.namespaceId),
  );
  const openedDomainIds = canonicalPortableIds(
    input.opened.domains.map((entry) => entry.domainId),
  );
  if (
    requestedNamespaceIds === null
    || viewDomainIds === null
    || capabilityNamespaceIds === null
    || capabilityDomainIds === null
    || openedNamespaceIds === null
    || openedDomainIds === null
    || input.opened.grantId !== input.capability.grantId
    || !equalStrings(openedNamespaceIds, capabilityNamespaceIds)
    || !equalStrings(openedDomainIds, capabilityDomainIds)
    || !isSubset(requestedNamespaceIds, capabilityNamespaceIds)
    || !isSubset(viewDomainIds, capabilityDomainIds)
    || !Number.isSafeInteger(input.expectedRuntimeAuthorizationRevision)
    || input.expectedRuntimeAuthorizationRevision < 0
    || signalIsAborted(input.signal)
  ) {
    return unavailable("authorization_unavailable");
  }

  const domainById = new Map(
    input.opened.domains.map((entry) => [entry.domainId, entry] as const),
  );
  if (
    input.opened.namespaceRequirements.some((entry) =>
      !domainById.has(entry.domainId)
    )
  ) return unavailable("authorization_unavailable");
  const requirementById = new Map<
    string,
    OpenedGrantAuthoritySet["namespaceRequirements"][number]
  >(
    input.opened.namespaceRequirements.map((entry) =>
      [entry.namespaceId, entry] as const
    ),
  );
  const selected = requestedNamespaceIds.map((currentNamespaceId) => {
    const requirement = requirementById.get(currentNamespaceId);
    if (
      requirement === undefined
      || !requirement.operations.includes(input.operation)
      || !viewDomainIds.includes(requirement.domainId)
    ) return null;
    const domain = domainById.get(requirement.domainId);
    return domain === undefined ? null : Object.freeze({ requirement, domain });
  });
  if (selected.some((entry) => entry === null)) {
    return unavailable("authorization_unavailable");
  }
  const exactSelected = selected as readonly Readonly<{
    requirement: OpenedGrantAuthoritySet["namespaceRequirements"][number];
    domain: OpenedGrantAuthoritySet["domains"][number];
  }>[];

  let baselineFacts: Awaited<ReturnType<
    ProtectedGrantAuthoritySetPortV2["resolvePreflightFacts"]
  >>;
  let runtimeState: Awaited<
    ReturnType<LatticeStorage["getAgentRuntimeAtomicState"]>
  >;
  let loaded: readonly Readonly<{
    requirement: OpenedGrantAuthoritySet["namespaceRequirements"][number];
    domain: OpenedGrantAuthoritySet["domains"][number];
    head: NonNullable<Awaited<
      ReturnType<LatticeStorage["getNamespaceHead"]>
    >> | null;
    bindingRecord: NonNullable<Awaited<
      ReturnType<LatticeStorage["getBinding"]>
    >> | null;
  }>[];
  try {
    [baselineFacts, runtimeState, loaded] = await Promise.all([
      input.authority.resolvePreflightFacts({
        phase: "preflight",
        coordinates: input.capability,
      }),
      input.storage.getAgentRuntimeAtomicState(
        input.capability.recipientAgentId,
      ),
      Promise.all(exactSelected.map(async ({ requirement, domain }) => {
        const [head, bindingRecord] = await Promise.all([
          input.storage.getNamespaceHead(requirement.namespaceId),
          input.storage.getBinding(
            requirement.namespaceId,
            requirement.expectedAccessRevision,
          ),
        ]);
        return Object.freeze({ requirement, domain, head, bindingRecord });
      })),
    ]);
  } catch {
    return unavailable("namespace_unavailable");
  }
  if (
    baselineFacts === null
    || !authorityFactsMatchOpenedSet(
      baselineFacts,
      input.capability,
      input.opened,
    )
    || runtimeState === null
    || runtimeState.runtime.agentId !== input.capability.recipientAgentId
    || runtimeState.runtime.authorizationRevision
      !== input.expectedRuntimeAuthorizationRevision
  ) {
    return unavailable("authorization_unavailable");
  }
  if (loaded.some((entry) =>
    entry.head === null || entry.bindingRecord === null
  )) return unavailable("namespace_unavailable");
  const exactLoaded = loaded as readonly Readonly<{
    requirement: OpenedGrantAuthoritySet["namespaceRequirements"][number];
    domain: OpenedGrantAuthoritySet["domains"][number];
    head: NonNullable<Awaited<
      ReturnType<LatticeStorage["getNamespaceHead"]>
    >>;
    bindingRecord: NonNullable<Awaited<
      ReturnType<LatticeStorage["getBinding"]>
    >>;
  }>[];

  const openedKeyrings: ReturnType<typeof openNamespaceKeyring>[] = [];
  let executingCallback = false;
  try {
    const materials: ProtectedNamespaceKeyringSetEntryMaterial[] = [];
    for (const entry of exactLoaded) {
      const { requirement, domain, head, bindingRecord } = entry;
      const binding = parseNamespaceBindingV2(
        bindingRecord.signedBindingBytes,
      );
      const humanEnvelope = parseNamespaceKeyringEnvelopeV2(
        bindingRecord.humanKeyringEnvelopeBytes,
      );
      const aiEnvelope = parseNamespaceKeyringEnvelopeV2(
        bindingRecord.aiKeyringEnvelopeBytes,
      );
      const bindingHash = namespaceBindingHash(binding);
      if (
        head.namespaceId !== requirement.namespaceId
        || head.accessRevision !== requirement.expectedAccessRevision
        || head.domainId !== requirement.domainId
        || head.domainEpoch !== domain.expectedEpoch
        || bindingRecord.namespaceId !== head.namespaceId
        || bindingRecord.revision !== head.accessRevision
        || binding.namespaceId !== head.namespaceId
        || binding.accessRevision !== head.accessRevision
        || binding.domainId !== head.domainId
        || binding.domainEpoch !== head.domainEpoch
        || !equalBytes(bindingHash, head.bindingHash)
        || !equalBytes(bindingHash, bindingRecord.bindingHash)
        || !verifyBindingEnvelopePair(binding, humanEnvelope, aiEnvelope)
      ) return unavailable("namespace_invalid");
      verifyNamespaceBinding({
        crypto: input.crypto,
        binding,
        resolveHistoricalCommitter: input.resolveHistoricalCommitter,
      });
      const keyring = openNamespaceKeyring({
        crypto: input.crypto,
        domainRoot: domain.aiRoot,
        envelope: aiEnvelope,
        resolveHistoricalCommitter: input.resolveHistoricalCommitter,
      });
      openedKeyrings.push(keyring);
      if (
        keyring.namespaceId !== requirement.namespaceId
        || keyring.keyClass !== "ai"
        || keyring.accessRevision !== requirement.expectedAccessRevision
        || signalIsAborted(input.signal)
      ) return unavailable("namespace_invalid");
      materials.push(Object.freeze({
        namespaceId: requirement.namespaceId,
        domainId: requirement.domainId,
        domainEpoch: domain.expectedEpoch,
        accessRevision: requirement.expectedAccessRevision,
        policyRevision: requirement.expectedPolicyRevision,
        domainAgentAuthorizationRevision:
          domain.expectedAgentAuthorizationRevision,
        bindingHash: head.bindingHash.slice(),
        currentGeneration: keyring.currentGeneration,
        generations: Object.freeze(keyring.generations.map((generation) =>
          Object.freeze({
            generation: generation.generation,
            key: generation.key,
          })
        )),
      }));
    }

    const assertCurrentAuthority = async (): Promise<void> => {
      if (signalIsAborted(input.signal)) {
        throw new ProtectedNamespaceKeyringError(
          "authorization_unavailable",
          "protected Namespace-set authority was cancelled",
        );
      }
      let freshFacts: Awaited<ReturnType<
        ProtectedGrantAuthoritySetPortV2["resolvePreflightFacts"]
      >>;
      let freshRuntime: Awaited<
        ReturnType<LatticeStorage["getAgentRuntimeAtomicState"]>
      >;
      let freshLoaded: readonly Readonly<{
        head: Awaited<ReturnType<LatticeStorage["getNamespaceHead"]>>;
        bindingRecord: Awaited<ReturnType<LatticeStorage["getBinding"]>>;
      }>[];
      try {
        [freshFacts, freshRuntime, freshLoaded] = await Promise.all([
          input.authority.resolvePreflightFacts({
            phase: "preflight",
            coordinates: input.capability,
          }),
          input.storage.getAgentRuntimeAtomicState(
            input.capability.recipientAgentId,
          ),
          Promise.all(exactLoaded.map(async (entry) => {
            const [head, bindingRecord] = await Promise.all([
              input.storage.getNamespaceHead(entry.requirement.namespaceId),
              input.storage.getBinding(
                entry.requirement.namespaceId,
                entry.requirement.expectedAccessRevision,
              ),
            ]);
            return Object.freeze({ head, bindingRecord });
          })),
        ]);
      } catch (cause) {
        throw new ProtectedNamespaceKeyringError(
          "content_unavailable",
          "protected Namespace-set authority storage failed",
          { cause },
        );
      }
      if (
        freshFacts === null
        || !authorityFactsMatchOpenedSet(
          freshFacts,
          input.capability,
          input.opened,
        )
        || !authorityFactsRemainExact(baselineFacts, freshFacts)
        || freshRuntime === null
        || freshRuntime.runtime.agentId
          !== input.capability.recipientAgentId
        || freshRuntime.runtime.authorizationRevision
          !== input.expectedRuntimeAuthorizationRevision
        || freshLoaded.length !== exactLoaded.length
        || freshLoaded.some((fresh, index) => {
          const baseline = exactLoaded[index];
          return baseline === undefined
            || fresh.head === null
            || fresh.bindingRecord === null
            || !sameHead(baseline.head, fresh.head)
            || !sameBindingRecord(
              baseline.bindingRecord,
              fresh.bindingRecord,
            );
        })
      ) {
        throw new ProtectedNamespaceKeyringError(
          "authorization_unavailable",
          "protected Namespace-set authority changed",
        );
      }
    };
    const material: ProtectedNamespaceKeyringSetMaterial = Object.freeze({
      recipientAgentId: input.capability.recipientAgentId,
      runtimeAuthorizationRevision:
        input.expectedRuntimeAuthorizationRevision,
      namespaces: Object.freeze(materials),
    });
    executingCallback = true;
    const value = await input.execute(material, assertCurrentAuthority);
    executingCallback = false;
    try {
      await assertCurrentAuthority();
    } catch (error) {
      if (
        error instanceof ProtectedNamespaceKeyringError
        && error.code === "content_unavailable"
      ) return unavailable("namespace_unavailable");
      return unavailable("authorization_unavailable");
    }
    return Object.freeze({ status: "executed" as const, value });
  } catch (error) {
    if (executingCallback) throw error;
    return unavailable("namespace_invalid");
  } finally {
    for (const keyring of openedKeyrings) {
      for (const generation of keyring.generations) {
        generation.key.fill(0);
      }
    }
  }
}
