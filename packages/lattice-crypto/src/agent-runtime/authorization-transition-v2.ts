import type { LatticeCrypto } from "../crypto/index.ts";
import {
  agentRuntimeDomainEnvelopeSigningBytes,
  assertAgentRuntimeGeneration,
  parseAgentRuntimeDomainEnvelope,
} from "../format/agent-runtime-v2.ts";
import {
  concatV2,
  encodeU32,
  encodeU64,
  frame,
  frameText,
  utf8V2,
} from "../format/v2-primitives.ts";
import {
  agentId,
  agentRuntimeGeneration,
  assertPortableId,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  type AgentId,
  type AgentRuntimeGeneration,
  type AuthorizationRevision,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import {
  authenticatedAgentRuntimeConfigDekV2,
  copyOwnedBytesV2,
  opaqueBytes,
} from "../v2-types/opaque.ts";
import {
  cloneAtomicRuntimeState,
  equalAtomicRuntimeStates,
  assertAgentRuntimeAtomicState,
  runtimeWireState,
} from "../storage/v2-record-policy.ts";
import type {
  AgentRuntimeAtomicStorageStateV2,
  AgentRuntimeAtomicStorageWireV2,
  AgentRuntimeAuthorizationTransitionCasStatusV2,
  OpaqueAgentRuntimeDomainEnvelopeRecordV2,
} from "../storage/v2-records.ts";
import {
  authorizeAgentRuntimeAuthorizationTransitionWriteV2,
  type AuthorizedAgentRuntimeAuthorizationTransitionWriteV2,
} from "./storage-authorized-write.ts";
import type {
  AgentRuntimeSignerPublicationV1,
} from "./signer-publication-v1.ts";
import {
  agentRuntimeManagerHandoffPlansEqualV1,
  agentRuntimeManagerHandoffRuntimeCommitmentV1,
  verifyPreparedAgentRuntimeManagerHandoffTarget,
  type AgentRuntimeManagerHandoffPlanV1,
  type PreparedAgentRuntimeManagerHandoffTargetV1,
  type ResolveCurrentAgentRuntimeManagerHandoffTargetV1,
} from "./runtime-handoff-v2.ts";
import type { AgentRuntimeGenerationV2 } from "./types.ts";
import type {
  AgentRuntimeAuthorizationDomainV2,
  AgentRuntimeConfigInventoryCommitmentV2,
  AgentRuntimeRotationManagerV2,
  AgentRuntimeRotationStateV2,
} from "./runtime-rotation-v2.ts";

const HASH_BYTES = 32;
const TRANSITION_MANIFEST_DOMAIN =
  "nautilo/lattice-crypto/agent-runtime-authorization-transition/v1";
const activeSourceLocals = new WeakSet<object>();

export interface AgentRuntimeAuthorizationTransitionPlanV2 {
  readonly operationId: string;
  readonly agentId: AgentId;
  readonly oldAuthorizationRevision: AuthorizationRevision;
  readonly newAuthorizationRevision: AuthorizationRevision;
  readonly currentRuntimeGeneration: AgentRuntimeGeneration;
  readonly currentManager: AgentRuntimeRotationManagerV2;
  readonly activeConfigInventory: AgentRuntimeConfigInventoryCommitmentV2;
  readonly currentDomains: readonly AgentRuntimeAuthorizationDomainV2[];
  readonly remainingDomains: readonly AgentRuntimeAuthorizationDomainV2[];
  readonly refreshedDomainIds: readonly string[];
}

export interface AgentRuntimeAuthorizationTransitionManagerContextV2
  extends AgentRuntimeRotationManagerV2 {
  readonly purpose: "agent-runtime-authorization-transition-source";
  readonly operationId: string;
  readonly agentId: AgentId;
  readonly oldAuthorizationRevision: AuthorizationRevision;
  readonly newAuthorizationRevision: AuthorizationRevision;
  readonly runtimeGeneration: AgentRuntimeGeneration;
}

export type ResolveCurrentAgentRuntimeAuthorizationTransitionManagerV2 = (
  context: AgentRuntimeAuthorizationTransitionManagerContextV2,
) => Uint8Array | null;

export interface AgentRuntimeAuthorizationTransitionEnvelopeContextV2
  extends AgentRuntimeAuthorizationDomainV2 {
  readonly purpose: "agent-runtime-authorization-transition-envelope";
  readonly operationId: string;
  readonly agentId: AgentId;
  readonly runtimeGeneration: AgentRuntimeGeneration;
}

export type ResolveCurrentAgentRuntimeAuthorizationTransitionEnvelopeV2 = (
  context: AgentRuntimeAuthorizationTransitionEnvelopeContextV2,
) => Uint8Array | null;

export interface AgentRuntimeAuthorizationTransitionPublicCandidateV2 {
  readonly plan: AgentRuntimeAuthorizationTransitionPlanV2;
  readonly expectedState: AgentRuntimeRotationStateV2;
  readonly nextState: AgentRuntimeRotationStateV2;
  readonly targetIntents: readonly AgentRuntimeManagerHandoffPlanV1[];
  readonly runtimeCommitment: Uint8Array;
  readonly manifestHash: Uint8Array;
  readonly managerSignature: Uint8Array;
}

export interface AgentRuntimeAuthorizationTransitionSourceLocalV2 {
  readonly runtime: AgentRuntimeGenerationV2;
}

export interface PreparedAgentRuntimeAuthorizationTransitionSourceV2 {
  readonly publicCandidate:
    AgentRuntimeAuthorizationTransitionPublicCandidateV2;
  readonly sourceLocal:
    AgentRuntimeAuthorizationTransitionSourceLocalV2;
}

export interface AtomicAgentRuntimeAuthorizationTransitionCandidateV2 {
  readonly publicCandidate:
    AgentRuntimeAuthorizationTransitionPublicCandidateV2;
  readonly completedTargets:
    readonly PreparedAgentRuntimeManagerHandoffTargetV1[];
  readonly expected: AgentRuntimeAtomicStorageStateV2;
  readonly intended: AgentRuntimeAtomicStorageStateV2;
}

export interface AgentRuntimeAuthorizationTransitionStorageV2 {
  getAgentRuntimeAtomicState(
    agentId: string,
  ): Promise<AgentRuntimeAtomicStorageWireV2 | null>;
  getAgentRuntimeSignerPublication(
    agentId: string,
    runtimeGeneration: number,
  ): Promise<AgentRuntimeSignerPublicationV1 | null>;
  compareAndSwapAgentRuntimeAuthorizationTransition(
    authorized: AuthorizedAgentRuntimeAuthorizationTransitionWriteV2,
  ): Promise<AgentRuntimeAuthorizationTransitionCasStatusV2>;
}

export interface AgentRuntimeAuthorizationTransitionPersistenceContextV2 {
  readonly purpose: "persist-agent-runtime-authorization-transition";
  readonly operationId: string;
  readonly expectedState: AgentRuntimeRotationStateV2;
  readonly nextState: AgentRuntimeRotationStateV2;
  readonly currentManager: AgentRuntimeRotationManagerV2;
  readonly currentDomains: readonly AgentRuntimeAuthorizationDomainV2[];
  readonly remainingDomains: readonly AgentRuntimeAuthorizationDomainV2[];
  readonly refreshedDomainIds: readonly string[];
}

export interface AgentRuntimeAuthorizationTransitionAuthorizedDomainV2
  extends AgentRuntimeAuthorizationDomainV2 {
  readonly committerSigningPublicKey: Uint8Array;
}

export interface AgentRuntimeAuthorizationTransitionPersistenceAuthorizationV2 {
  readonly currentState: AgentRuntimeRotationStateV2;
  readonly currentManager: AgentRuntimeRotationManagerV2;
  readonly managerSigningPublicKey: Uint8Array;
  readonly currentDomains:
    readonly AgentRuntimeAuthorizationTransitionAuthorizedDomainV2[];
  readonly remainingDomains:
    readonly AgentRuntimeAuthorizationTransitionAuthorizedDomainV2[];
}

export type ResolveCurrentAgentRuntimeAuthorizationTransitionPersistenceV2 = (
  context: AgentRuntimeAuthorizationTransitionPersistenceContextV2,
) => Promise<
  AgentRuntimeAuthorizationTransitionPersistenceAuthorizationV2 | null
> | AgentRuntimeAuthorizationTransitionPersistenceAuthorizationV2 | null;

export class AgentRuntimeAuthorizationTransitionOutcomeUnknownV2
  extends Error {
  override readonly name =
    "AgentRuntimeAuthorizationTransitionOutcomeUnknownV2";

  constructor(override readonly cause: unknown) {
    super(
      "Agent Runtime authorization transition storage outcome is unknown",
    );
  }
}

function assertObject(
  label: string,
  value: unknown,
): asserts value is object {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertExactFields(
  label: string,
  value: object,
  expected: readonly string[],
): void {
  if (
    Object.keys(value).sort().join("\0")
      !== [...expected].sort().join("\0")
  ) {
    throw new TypeError(`${label} has an invalid field set`);
  }
}

function exactBytes(
  label: string,
  value: unknown,
  size: number,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== size) {
    throw new RangeError(`${label} must contain exactly ${size} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function comparePortable(left: string, right: string): number {
  const leftBytes = utf8V2(left);
  const rightBytes = utf8V2(right);
  const width = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < width; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function cloneDomain(
  value: AgentRuntimeAuthorizationDomainV2,
): AgentRuntimeAuthorizationDomainV2 {
  return Object.freeze({
    domainId: cryptoDomainId(value.domainId),
    domainEpoch: domainEpoch(value.domainEpoch),
    agentAuthorizationRevision:
      authorizationRevision(value.agentAuthorizationRevision),
    committerDeviceId: cryptoDeviceId(value.committerDeviceId),
  });
}

function cloneRuntimeState(
  label: string,
  value: AgentRuntimeRotationStateV2,
): AgentRuntimeRotationStateV2 {
  assertObject(label, value);
  assertExactFields(label, value, [
    "agentId",
    "authorizationRevision",
    "runtimeGeneration",
  ]);
  return Object.freeze({
    agentId: agentId(value.agentId),
    authorizationRevision:
      authorizationRevision(value.authorizationRevision),
    runtimeGeneration:
      agentRuntimeGeneration(value.runtimeGeneration),
  });
}

function canonicalDomains(
  label: string,
  values: unknown,
): readonly AgentRuntimeAuthorizationDomainV2[] {
  if (
    !Array.isArray(values)
    || values.length > V2_LIMITS.agentGrantDomains
  ) {
    throw new RangeError(`${label} must be a bounded array`);
  }
  const domains = values.map((value) => {
    assertObject(`${label} entry`, value);
    assertExactFields(`${label} entry`, value, [
      "domainId",
      "domainEpoch",
      "agentAuthorizationRevision",
      "committerDeviceId",
    ]);
    return cloneDomain(value as AgentRuntimeAuthorizationDomainV2);
  });
  if (
    domains.some((value, index) =>
      index > 0
      && comparePortable(domains[index - 1]!.domainId, value.domainId) >= 0
    )
  ) {
    throw new TypeError(`${label} must be sorted and unique`);
  }
  return Object.freeze(domains);
}

function equalDomain(
  left: AgentRuntimeAuthorizationDomainV2,
  right: AgentRuntimeAuthorizationDomainV2,
): boolean {
  return left.domainId === right.domainId
    && left.domainEpoch === right.domainEpoch
    && left.agentAuthorizationRevision === right.agentAuthorizationRevision
    && left.committerDeviceId === right.committerDeviceId;
}

function canonicalRefreshIds(
  values: unknown,
): readonly string[] {
  if (
    !Array.isArray(values)
    || values.length > V2_LIMITS.agentGrantDomains
  ) {
    throw new RangeError("Refreshed Runtime Domains must be bounded");
  }
  const result = values.map((value) => cryptoDomainId(value));
  if (
    result.some((value, index) =>
      index > 0 && comparePortable(result[index - 1]!, value) >= 0
    )
  ) {
    throw new TypeError(
      "Refreshed Runtime Domains must be sorted and unique",
    );
  }
  return Object.freeze(result);
}

function cloneInventory(
  value: AgentRuntimeConfigInventoryCommitmentV2,
): AgentRuntimeConfigInventoryCommitmentV2 {
  assertObject("Agent Runtime config inventory", value);
  assertExactFields("Agent Runtime config inventory", value, [
    "objectCount",
    "digest",
  ]);
  if (
    !Number.isSafeInteger(value.objectCount)
    || value.objectCount < 0
    || value.objectCount > V2_LIMITS.batchItems
  ) {
    throw new RangeError("Agent Runtime config inventory count is invalid");
  }
  return Object.freeze({
    objectCount: value.objectCount,
    digest: exactBytes(
      "Agent Runtime config inventory digest",
      value.digest,
      HASH_BYTES,
    ),
  });
}

function managerContext(
  plan: AgentRuntimeAuthorizationTransitionPlanV2,
): AgentRuntimeAuthorizationTransitionManagerContextV2 {
  return Object.freeze({
    purpose: "agent-runtime-authorization-transition-source",
    operationId: plan.operationId,
    agentId: plan.agentId,
    oldAuthorizationRevision: plan.oldAuthorizationRevision,
    newAuthorizationRevision: plan.newAuthorizationRevision,
    runtimeGeneration: plan.currentRuntimeGeneration,
    ...plan.currentManager,
  });
}

function domainBytes(value: AgentRuntimeAuthorizationDomainV2): Uint8Array {
  return concatV2(
    frameText(value.domainId),
    encodeU64(value.domainEpoch),
    encodeU64(value.agentAuthorizationRevision),
    frameText(value.committerDeviceId),
  );
}

function transitionManifestBytes(input: {
  readonly plan: AgentRuntimeAuthorizationTransitionPlanV2;
  readonly expectedState: AgentRuntimeRotationStateV2;
  readonly nextState: AgentRuntimeRotationStateV2;
  readonly runtimeCommitment: Uint8Array;
}): Uint8Array {
  const plan = input.plan;
  return concatV2(
    frameText(TRANSITION_MANIFEST_DOMAIN),
    encodeU32(1),
    frameText(plan.operationId),
    frameText(plan.agentId),
    encodeU64(plan.oldAuthorizationRevision),
    encodeU64(plan.newAuthorizationRevision),
    encodeU64(plan.currentRuntimeGeneration),
    frameText(plan.currentManager.managerHumanId),
    encodeU64(plan.currentManager.managerAuthorizationRevision),
    frameText(plan.currentManager.managerDeviceId),
    encodeU32(plan.activeConfigInventory.objectCount),
    frame(plan.activeConfigInventory.digest),
    encodeU32(plan.currentDomains.length),
    ...plan.currentDomains.map(domainBytes),
    encodeU32(plan.remainingDomains.length),
    ...plan.remainingDomains.map(domainBytes),
    encodeU32(plan.refreshedDomainIds.length),
    ...plan.refreshedDomainIds.map(frameText),
    encodeU64(input.expectedState.authorizationRevision),
    encodeU64(input.expectedState.runtimeGeneration),
    encodeU64(input.nextState.authorizationRevision),
    encodeU64(input.nextState.runtimeGeneration),
    frame(input.runtimeCommitment),
  );
}

function managerSigningBytes(manifestHash: Uint8Array): Uint8Array {
  return concatV2(
    frameText(TRANSITION_MANIFEST_DOMAIN),
    frameText("manager-signature"),
    encodeU32(1),
    frame(manifestHash),
  );
}

function validatePlan(
  value: AgentRuntimeAuthorizationTransitionPlanV2,
  expectedState: AgentRuntimeRotationStateV2,
): AgentRuntimeAuthorizationTransitionPlanV2 {
  assertObject("Agent Runtime authorization transition plan", value);
  assertExactFields("Agent Runtime authorization transition plan", value, [
    "operationId",
    "agentId",
    "oldAuthorizationRevision",
    "newAuthorizationRevision",
    "currentRuntimeGeneration",
    "currentManager",
    "activeConfigInventory",
    "currentDomains",
    "remainingDomains",
    "refreshedDomainIds",
  ]);
  assertPortableId(
    "Agent Runtime authorization transition operation id",
    value.operationId,
  );
  const operationId = value.operationId;
  const targetAgent = agentId(value.agentId);
  const oldRevision = authorizationRevision(value.oldAuthorizationRevision);
  const newRevision = authorizationRevision(value.newAuthorizationRevision);
  const generation = agentRuntimeGeneration(value.currentRuntimeGeneration);
  if (newRevision !== oldRevision + 1) {
    throw new Error(
      "Agent Runtime authorization transition must advance exactly once",
    );
  }
  assertObject("Agent Runtime authorization transition manager", value.currentManager);
  assertExactFields(
    "Agent Runtime authorization transition manager",
    value.currentManager,
    [
      "managerHumanId",
      "managerAuthorizationRevision",
      "managerDeviceId",
    ],
  );
  const manager = Object.freeze({
    managerHumanId: humanId(value.currentManager.managerHumanId),
    managerAuthorizationRevision:
      authorizationRevision(
        value.currentManager.managerAuthorizationRevision,
      ),
    managerDeviceId: cryptoDeviceId(value.currentManager.managerDeviceId),
  });
  const currentDomains =
    canonicalDomains("Current Runtime Domains", value.currentDomains);
  const remainingDomains =
    canonicalDomains("Remaining Runtime Domains", value.remainingDomains);
  const refreshedDomainIds = canonicalRefreshIds(value.refreshedDomainIds);
  const currentById = new Map(
    currentDomains.map((domain) => [domain.domainId, domain]),
  );
  const exactRefresh = remainingDomains
    .filter((domain) => {
      const current = currentById.get(domain.domainId);
      return current === undefined || !equalDomain(current, domain);
    })
    .map((domain) => domain.domainId);
  if (
    exactRefresh.length !== refreshedDomainIds.length
    || exactRefresh.some((domainId, index) =>
      domainId !== refreshedDomainIds[index]
    )
  ) {
    throw new Error(
      "Agent Runtime authorization transition refresh set is not exact",
    );
  }
  const currentState = cloneRuntimeState(
    "Agent Runtime authorization transition expected state",
    expectedState,
  );
  if (
    currentState.agentId !== targetAgent
    || currentState.authorizationRevision !== oldRevision
    || currentState.runtimeGeneration !== generation
  ) {
    throw new Error(
      "Agent Runtime authorization transition state does not match its plan",
    );
  }
  return Object.freeze({
    operationId,
    agentId: targetAgent,
    oldAuthorizationRevision: oldRevision,
    newAuthorizationRevision: newRevision,
    currentRuntimeGeneration: generation,
    currentManager: manager,
    activeConfigInventory: cloneInventory(value.activeConfigInventory),
    currentDomains,
    remainingDomains,
    refreshedDomainIds,
  });
}

function targetIntents(
  plan: AgentRuntimeAuthorizationTransitionPlanV2,
  manifestHash: Uint8Array,
  runtimeCommitment: Uint8Array,
): readonly AgentRuntimeManagerHandoffPlanV1[] {
  const targets = plan.remainingDomains.filter((domain) =>
    plan.refreshedDomainIds.includes(domain.domainId)
  );
  return Object.freeze(targets.map((target) => Object.freeze({
    operationId: plan.operationId,
    agentId: plan.agentId,
    runtimeGeneration: plan.currentRuntimeGeneration,
    rotationManifestHash: copyOwnedBytesV2(manifestHash),
    runtimeCommitment: copyOwnedBytesV2(runtimeCommitment),
    source: Object.freeze({ ...plan.currentManager }),
    target: Object.freeze({ ...target }),
  })));
}

function sourceProofBytes(
  plan: AgentRuntimeAuthorizationTransitionPlanV2,
): Uint8Array {
  return concatV2(
    frameText(TRANSITION_MANIFEST_DOMAIN),
    frameText("manager-source-proof"),
    encodeU32(1),
    frameText(plan.operationId),
    frameText(plan.agentId),
    encodeU64(plan.oldAuthorizationRevision),
    encodeU64(plan.newAuthorizationRevision),
    encodeU64(plan.currentRuntimeGeneration),
  );
}

export function prepareAgentRuntimeAuthorizationTransitionSourceV2(input: {
  readonly crypto: LatticeCrypto;
  readonly currentState: AgentRuntimeRotationStateV2;
  readonly currentRuntime: AgentRuntimeGenerationV2;
  readonly plan: AgentRuntimeAuthorizationTransitionPlanV2;
  readonly resolveCurrentManagerAuthority:
    ResolveCurrentAgentRuntimeAuthorizationTransitionManagerV2;
  readonly managerSigningPrivateKey: Uint8Array;
}): PreparedAgentRuntimeAuthorizationTransitionSourceV2 {
  assertAgentRuntimeGeneration(input.currentRuntime);
  const plan = validatePlan(input.plan, input.currentState);
  if (
    input.currentRuntime.agentId !== plan.agentId
    || input.currentRuntime.generation !== plan.currentRuntimeGeneration
  ) {
    throw new Error(
      "Current Agent Runtime does not match the authorization transition",
    );
  }
  const privateKey = exactBytes(
    "Agent Runtime transition manager signing private key",
    input.managerSigningPrivateKey,
    V2_LIMITS.signingPrivateKeyBytes,
  );
  try {
    const managerPublic = input.resolveCurrentManagerAuthority(
      managerContext(plan),
    );
    if (managerPublic === null) {
      throw new Error(
        "Agent Runtime transition manager is not currently authorized",
      );
    }
    const publicKey = exactBytes(
      "Agent Runtime transition manager signing public key",
      managerPublic,
      V2_LIMITS.signingPublicKeyBytes,
    );
    const sourceProof = sourceProofBytes(plan);
    const sourceSignature = input.crypto.sign(privateKey, sourceProof);
    if (!input.crypto.verify(publicKey, sourceProof, sourceSignature)) {
      throw new Error(
        "Agent Runtime transition manager key does not match current authority",
      );
    }
    const runtimeCommitment =
      agentRuntimeManagerHandoffRuntimeCommitmentV1({
        crypto: input.crypto,
        operationId: plan.operationId,
        agentId: plan.agentId,
        runtimeGeneration: plan.currentRuntimeGeneration,
        runtimeKey: input.currentRuntime.key,
      });
    const expectedState = Object.freeze({
      agentId: plan.agentId,
      authorizationRevision: plan.oldAuthorizationRevision,
      runtimeGeneration: plan.currentRuntimeGeneration,
    });
    const nextState = Object.freeze({
      agentId: plan.agentId,
      authorizationRevision: plan.newAuthorizationRevision,
      runtimeGeneration: plan.currentRuntimeGeneration,
    });
    const manifestHash = input.crypto.hash(transitionManifestBytes({
      plan,
      expectedState,
      nextState,
      runtimeCommitment,
    }));
    const managerSignature = input.crypto.sign(
      privateKey,
      managerSigningBytes(manifestHash),
    );
    const publicCandidate = Object.freeze({
      plan,
      expectedState,
      nextState,
      targetIntents: targetIntents(plan, manifestHash, runtimeCommitment),
      runtimeCommitment: copyOwnedBytesV2(runtimeCommitment),
      manifestHash: copyOwnedBytesV2(manifestHash),
      managerSignature: copyOwnedBytesV2(managerSignature),
    });
    const sourceLocal = Object.freeze({
      runtime: Object.freeze({
        ...input.currentRuntime,
        key: copyOwnedBytesV2(input.currentRuntime.key),
      }),
    });
    activeSourceLocals.add(sourceLocal);
    return Object.freeze({ publicCandidate, sourceLocal });
  } finally {
    privateKey.fill(0);
  }
}

export function destroyAgentRuntimeAuthorizationTransitionSourceLocalV2(
  value: AgentRuntimeAuthorizationTransitionSourceLocalV2,
): void {
  if (!activeSourceLocals.delete(value)) return;
  value.runtime.key.fill(0);
}

function validatePublicCandidate(input: {
  readonly crypto: LatticeCrypto;
  readonly candidate:
    AgentRuntimeAuthorizationTransitionPublicCandidateV2;
  readonly resolveCurrentManagerAuthority:
    ResolveCurrentAgentRuntimeAuthorizationTransitionManagerV2;
}): AgentRuntimeAuthorizationTransitionPublicCandidateV2 {
  const value = input.candidate;
  assertObject("Agent Runtime authorization transition candidate", value);
  assertExactFields("Agent Runtime authorization transition candidate", value, [
    "plan",
    "expectedState",
    "nextState",
    "targetIntents",
    "runtimeCommitment",
    "manifestHash",
    "managerSignature",
  ]);
  const plan = validatePlan(value.plan, value.expectedState);
  const nextState = cloneRuntimeState(
    "Agent Runtime authorization transition next state",
    value.nextState,
  );
  if (
    nextState.agentId !== plan.agentId
    || nextState.authorizationRevision !== plan.newAuthorizationRevision
    || nextState.runtimeGeneration !== plan.currentRuntimeGeneration
  ) {
    throw new Error(
      "Agent Runtime authorization transition next state is invalid",
    );
  }
  const runtimeCommitment = exactBytes(
    "Agent Runtime authorization transition commitment",
    value.runtimeCommitment,
    HASH_BYTES,
  );
  const manifestHash = exactBytes(
    "Agent Runtime authorization transition manifest hash",
    value.manifestHash,
    HASH_BYTES,
  );
  const reconstructedHash = input.crypto.hash(transitionManifestBytes({
    plan,
    expectedState: value.expectedState,
    nextState,
    runtimeCommitment,
  }));
  if (!equalBytes(reconstructedHash, manifestHash)) {
    throw new Error(
      "Agent Runtime authorization transition manifest hash is invalid",
    );
  }
  const managerPublic = input.resolveCurrentManagerAuthority(
    managerContext(plan),
  );
  if (
    managerPublic === null
    || !input.crypto.verify(
      exactBytes(
        "Agent Runtime transition manager signing public key",
        managerPublic,
        V2_LIMITS.signingPublicKeyBytes,
      ),
      managerSigningBytes(manifestHash),
      exactBytes(
        "Agent Runtime transition manager signature",
        value.managerSignature,
        V2_LIMITS.signatureBytes,
      ),
    )
  ) {
    throw new Error(
      "Agent Runtime authorization transition manager signature is invalid",
    );
  }
  const intents = targetIntents(plan, manifestHash, runtimeCommitment);
  const rawCandidateIntents: unknown = value.targetIntents;
  if (
    !Array.isArray(rawCandidateIntents)
    || rawCandidateIntents.length !== intents.length
  ) {
    throw new Error(
      "Agent Runtime authorization transition target intents are invalid",
    );
  }
  const candidateIntents =
    rawCandidateIntents as readonly AgentRuntimeManagerHandoffPlanV1[];
  if (
    candidateIntents.some((intent, index) =>
      !agentRuntimeManagerHandoffPlansEqualV1(intent, intents[index]!)
    )
  ) {
    throw new Error(
      "Agent Runtime authorization transition target intents are invalid",
    );
  }
  return Object.freeze({
    plan,
    expectedState: cloneRuntimeState(
      "Agent Runtime authorization transition expected state",
      value.expectedState,
    ),
    nextState,
    targetIntents: intents,
    runtimeCommitment,
    manifestHash,
    managerSignature: copyOwnedBytesV2(value.managerSignature),
  });
}

function domainRecordMatches(
  record: OpaqueAgentRuntimeDomainEnvelopeRecordV2,
  expected: AgentRuntimeAuthorizationDomainV2,
  state: AgentRuntimeRotationStateV2,
): boolean {
  return record.agentId === state.agentId
    && record.domainId === expected.domainId
    && record.domainEpoch === expected.domainEpoch
    && record.agentAuthorizationRevision
      === expected.agentAuthorizationRevision
    && record.runtimeGeneration === state.runtimeGeneration
    && record.committerDeviceId === expected.committerDeviceId;
}

function verifyReusedEnvelope(input: {
  readonly crypto: LatticeCrypto;
  readonly record: OpaqueAgentRuntimeDomainEnvelopeRecordV2;
  readonly expected: AgentRuntimeAuthorizationDomainV2;
  readonly state: AgentRuntimeRotationStateV2;
  readonly operationId: string;
  readonly resolveCurrentEnvelopeCommitter:
    ResolveCurrentAgentRuntimeAuthorizationTransitionEnvelopeV2;
}): OpaqueAgentRuntimeDomainEnvelopeRecordV2 {
  if (!domainRecordMatches(input.record, input.expected, input.state)) {
    throw new Error(
      "Reused Agent Runtime Domain envelope coordinates are stale",
    );
  }
  const bytes = input.record.envelopeBytes.ciphertext;
  const envelope = parseAgentRuntimeDomainEnvelope(bytes);
  const publicKey = input.resolveCurrentEnvelopeCommitter(Object.freeze({
    purpose: "agent-runtime-authorization-transition-envelope",
    operationId: input.operationId,
    agentId: input.state.agentId,
    runtimeGeneration: input.state.runtimeGeneration,
    ...input.expected,
  }));
  if (
    publicKey === null
    || !input.crypto.verify(
      exactBytes(
        "Agent Runtime Domain committer public key",
        publicKey,
        V2_LIMITS.signingPublicKeyBytes,
      ),
      agentRuntimeDomainEnvelopeSigningBytes(envelope),
      envelope.signature,
    )
    || !equalBytes(input.crypto.hash(bytes), input.record.envelopeHash)
  ) {
    throw new Error(
      "Reused Agent Runtime Domain envelope proof is invalid",
    );
  }
  return Object.freeze({
    ...input.record,
    envelopeHash: copyOwnedBytesV2(input.record.envelopeHash),
    envelopeBytes: opaqueBytes(
      "agent-runtime-domain-envelope",
      bytes,
    ),
  });
}

export function aggregateAgentRuntimeAuthorizationTransitionV2(input: {
  readonly crypto: LatticeCrypto;
  readonly publicCandidate:
    AgentRuntimeAuthorizationTransitionPublicCandidateV2;
  readonly completedTargets:
    readonly PreparedAgentRuntimeManagerHandoffTargetV1[];
  readonly currentStorageState: AgentRuntimeAtomicStorageStateV2;
  readonly resolveCurrentManagerAuthority:
    ResolveCurrentAgentRuntimeAuthorizationTransitionManagerV2;
  readonly resolveCurrentTargetCommitter:
    ResolveCurrentAgentRuntimeManagerHandoffTargetV1;
  readonly resolveCurrentEnvelopeCommitter:
    ResolveCurrentAgentRuntimeAuthorizationTransitionEnvelopeV2;
}): AtomicAgentRuntimeAuthorizationTransitionCandidateV2 {
  assertAgentRuntimeAtomicState(input.currentStorageState);
  const publicCandidate = validatePublicCandidate({
    crypto: input.crypto,
    candidate: input.publicCandidate,
    resolveCurrentManagerAuthority: input.resolveCurrentManagerAuthority,
  });
  const plan = publicCandidate.plan;
  const expected = cloneAtomicRuntimeState(input.currentStorageState);
  if (
    expected.runtime.agentId !== plan.agentId
    || expected.runtime.authorizationRevision
      !== plan.oldAuthorizationRevision
    || expected.runtime.runtimeGeneration
      !== plan.currentRuntimeGeneration
    || expected.configInventory.objectCount
      !== plan.activeConfigInventory.objectCount
    || !equalBytes(
      expected.configInventory.digest,
      plan.activeConfigInventory.digest,
    )
    || expected.domainEnvelopes.length !== plan.currentDomains.length
    || expected.domainEnvelopes.some((record, index) =>
      !domainRecordMatches(
        record,
        plan.currentDomains[index]!,
        expected.runtime,
      )
    )
  ) {
    throw new Error(
      "Current Agent Runtime storage does not match the transition plan",
    );
  }
  if (
    !Array.isArray(input.completedTargets)
    || input.completedTargets.length
      !== publicCandidate.targetIntents.length
  ) {
    throw new Error(
      "Agent Runtime authorization transition target coverage is incomplete",
    );
  }
  const completedByDomain =
    new Map<string, PreparedAgentRuntimeManagerHandoffTargetV1>();
  const completedTargets:
    readonly PreparedAgentRuntimeManagerHandoffTargetV1[] =
      input.completedTargets;
  const verifiedTargets: PreparedAgentRuntimeManagerHandoffTargetV1[] = [];
  for (let index = 0; index < completedTargets.length; index += 1) {
    const completion = verifyPreparedAgentRuntimeManagerHandoffTarget({
      crypto: input.crypto,
      value: completedTargets[index]!,
      resolveCurrentTargetCommitter: input.resolveCurrentTargetCommitter,
    });
    const intent = publicCandidate.targetIntents[index]!;
    if (
      !agentRuntimeManagerHandoffPlansEqualV1(completion.plan, intent)
      || completedByDomain.has(completion.plan.target.domainId)
    ) {
      throw new Error(
        "Agent Runtime authorization transition target order is invalid",
      );
    }
    completedByDomain.set(completion.plan.target.domainId, completion);
    verifiedTargets.push(completion);
  }
  const expectedByDomain = new Map(
    expected.domainEnvelopes.map((record) => [record.domainId, record]),
  );
  const challengeHashes: Uint8Array[] = [];
  const domainEnvelopes =
    plan.remainingDomains.map((domain) => {
      const completion = completedByDomain.get(domain.domainId);
      if (completion !== undefined) {
        const bytes = completion.envelopeBytes.ciphertext;
        challengeHashes.push(
          copyOwnedBytesV2(
            completion.challengeConsumption.challengeHash,
          ),
        );
        return Object.freeze({
          agentId: plan.agentId,
          domainId: domain.domainId,
          domainEpoch: domain.domainEpoch,
          agentAuthorizationRevision: domain.agentAuthorizationRevision,
          runtimeGeneration: plan.currentRuntimeGeneration,
          committerDeviceId: domain.committerDeviceId,
          envelopeHash: copyOwnedBytesV2(input.crypto.hash(bytes)),
          envelopeBytes: opaqueBytes(
            "agent-runtime-domain-envelope",
            bytes,
          ),
        });
      }
      const current = expectedByDomain.get(domain.domainId);
      if (current === undefined) {
        throw new Error(
          "Agent Runtime authorization transition omitted a refreshed Domain",
        );
      }
      return verifyReusedEnvelope({
        crypto: input.crypto,
        record: current,
        expected: domain,
        state: expected.runtime,
        operationId: plan.operationId,
        resolveCurrentEnvelopeCommitter:
          input.resolveCurrentEnvelopeCommitter,
      });
    });
  const intendedChallenges = expected.challengeConsumptions.map((entry) =>
    Object.freeze({
      challengeHash: copyOwnedBytesV2(entry.challengeHash),
      consumed: challengeHashes.some((hash) =>
        equalBytes(hash, entry.challengeHash)
      )
        ? true
        : entry.consumed,
    })
  );
  if (
    challengeHashes.some((hash) =>
      !expected.challengeConsumptions.some((entry) =>
        !entry.consumed && equalBytes(entry.challengeHash, hash)
      )
    )
  ) {
    throw new Error(
      "Agent Runtime authorization transition challenge is not reserved",
    );
  }
  const intended = cloneAtomicRuntimeState({
    ...expected,
    runtime: publicCandidate.nextState,
    domainEnvelopes: Object.freeze(domainEnvelopes),
    challengeConsumptions: Object.freeze(intendedChallenges),
  });
  return Object.freeze({
    publicCandidate,
    completedTargets: Object.freeze(verifiedTargets),
    expected,
    intended,
  });
}

function agentRuntimeAuthorizationTransitionCandidatesEqualV2(
  left: AtomicAgentRuntimeAuthorizationTransitionCandidateV2,
  right: AtomicAgentRuntimeAuthorizationTransitionCandidateV2,
): boolean {
  return equalAtomicRuntimeStates(left.expected, right.expected)
    && equalAtomicRuntimeStates(left.intended, right.intended)
    && equalBytes(
      left.publicCandidate.manifestHash,
      right.publicCandidate.manifestHash,
    )
    && equalBytes(
      left.publicCandidate.managerSignature,
      right.publicCandidate.managerSignature,
    )
    && left.publicCandidate.targetIntents.length
      === right.publicCandidate.targetIntents.length
    && left.publicCandidate.targetIntents.every((intent, index) =>
      agentRuntimeManagerHandoffPlansEqualV1(
        intent,
        right.publicCandidate.targetIntents[index]!,
      )
    );
}

function plain(value: unknown): unknown {
  if (value instanceof Uint8Array) return ["bytes", ...value];
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [
      key,
      plain((value as Record<string, unknown>)[key]),
    ]),
  );
}

function exactStructuredEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(plain(left)) === JSON.stringify(plain(right));
}

function authorizedDomainsMatch(
  authorized:
    readonly AgentRuntimeAuthorizationTransitionAuthorizedDomainV2[],
  expected: readonly AgentRuntimeAuthorizationDomainV2[],
): boolean {
  return authorized.length === expected.length
    && authorized.every((domain, index) => {
      const target = expected[index]!;
      return equalDomain(domain, target)
        && domain.committerSigningPublicKey instanceof Uint8Array
        && domain.committerSigningPublicKey.length
          === V2_LIMITS.signingPublicKeyBytes;
    });
}

function validatePersistenceAuthorization(
  value: AgentRuntimeAuthorizationTransitionPersistenceAuthorizationV2,
): AgentRuntimeAuthorizationTransitionPersistenceAuthorizationV2 {
  assertObject(
    "Agent Runtime authorization transition persistence authorization",
    value,
  );
  assertExactFields(
    "Agent Runtime authorization transition persistence authorization",
    value,
    [
      "currentState",
      "currentManager",
      "managerSigningPublicKey",
      "currentDomains",
      "remainingDomains",
    ],
  );
  assertObject(
    "Agent Runtime authorization transition persistence manager",
    value.currentManager,
  );
  assertExactFields(
    "Agent Runtime authorization transition persistence manager",
    value.currentManager,
    [
      "managerHumanId",
      "managerAuthorizationRevision",
      "managerDeviceId",
    ],
  );
  const cloneAuthorizedDomains = (
    label: string,
    domains:
      readonly AgentRuntimeAuthorizationTransitionAuthorizedDomainV2[],
  ): readonly AgentRuntimeAuthorizationTransitionAuthorizedDomainV2[] => {
    if (
      !Array.isArray(domains)
      || domains.length > V2_LIMITS.agentGrantDomains
    ) {
      throw new RangeError(`${label} must be a bounded array`);
    }
    const result = domains.map((rawDomain) => {
      assertObject(`${label} entry`, rawDomain);
      assertExactFields(`${label} entry`, rawDomain, [
        "domainId",
        "domainEpoch",
        "agentAuthorizationRevision",
        "committerDeviceId",
        "committerSigningPublicKey",
      ]);
      const domain =
        rawDomain as AgentRuntimeAuthorizationTransitionAuthorizedDomainV2;
      return Object.freeze({
        ...cloneDomain(domain),
        committerSigningPublicKey: exactBytes(
          `${label} committer signing public key`,
          domain.committerSigningPublicKey,
          V2_LIMITS.signingPublicKeyBytes,
        ),
      });
    });
    if (
      result.some((domain, index) =>
        index > 0
        && comparePortable(result[index - 1]!.domainId, domain.domainId)
          >= 0
      )
    ) {
      throw new TypeError(`${label} must be sorted and unique`);
    }
    return Object.freeze(result);
  };
  return Object.freeze({
    currentState: cloneRuntimeState(
      "Agent Runtime authorization transition persistence current state",
      value.currentState,
    ),
    currentManager: Object.freeze({
      managerHumanId: humanId(value.currentManager.managerHumanId),
      managerAuthorizationRevision:
        authorizationRevision(
          value.currentManager.managerAuthorizationRevision,
        ),
      managerDeviceId:
        cryptoDeviceId(value.currentManager.managerDeviceId),
    }),
    managerSigningPublicKey: exactBytes(
      "Agent Runtime authorization transition manager signing public key",
      value.managerSigningPublicKey,
      V2_LIMITS.signingPublicKeyBytes,
    ),
    currentDomains: cloneAuthorizedDomains(
      "Current authorized Runtime Domains",
      value.currentDomains,
    ),
    remainingDomains: cloneAuthorizedDomains(
      "Remaining authorized Runtime Domains",
      value.remainingDomains,
    ),
  });
}

export async function persistAgentRuntimeAuthorizationTransitionV2(input: {
  readonly crypto: LatticeCrypto;
  readonly storage: AgentRuntimeAuthorizationTransitionStorageV2;
  readonly candidate:
    AtomicAgentRuntimeAuthorizationTransitionCandidateV2;
  readonly resolveCurrentAuthorization:
    ResolveCurrentAgentRuntimeAuthorizationTransitionPersistenceV2;
}): Promise<AgentRuntimeAuthorizationTransitionCasStatusV2> {
  assertObject(
    "Agent Runtime authorization transition persistence input",
    input,
  );
  assertExactFields(
    "Agent Runtime authorization transition persistence input",
    input,
    [
      "crypto",
      "storage",
      "candidate",
      "resolveCurrentAuthorization",
    ],
  );
  const candidate = input.candidate;
  assertAgentRuntimeAtomicState(candidate.expected);
  assertAgentRuntimeAtomicState(candidate.intended);
  const publicCandidate = candidate.publicCandidate;
  const context = Object.freeze({
    purpose:
      "persist-agent-runtime-authorization-transition" as const,
    operationId: publicCandidate.plan.operationId,
    expectedState: Object.freeze({ ...publicCandidate.expectedState }),
    nextState: Object.freeze({ ...publicCandidate.nextState }),
    currentManager:
      Object.freeze({ ...publicCandidate.plan.currentManager }),
    currentDomains: Object.freeze(
      publicCandidate.plan.currentDomains.map(cloneDomain),
    ),
    remainingDomains: Object.freeze(
      publicCandidate.plan.remainingDomains.map(cloneDomain),
    ),
    refreshedDomainIds:
      Object.freeze([...publicCandidate.plan.refreshedDomainIds]),
  });
  const stored = await input.storage.getAgentRuntimeAtomicState(
    publicCandidate.plan.agentId,
  );
  if (stored === null) return "stale";
  const expectedWire = runtimeWireState(candidate.expected);
  const intendedWire = runtimeWireState(candidate.intended);
  const duplicate = exactStructuredEqual(stored, intendedWire);
  if (!duplicate && !exactStructuredEqual(stored, expectedWire)) {
    return "stale";
  }
  const signerPublication =
    await input.storage.getAgentRuntimeSignerPublication(
      publicCandidate.plan.agentId,
      publicCandidate.plan.currentRuntimeGeneration,
    );
  if (signerPublication === null) return "stale";
  const resolvedAuthorization =
    await input.resolveCurrentAuthorization(context);
  if (resolvedAuthorization === null) return "stale";
  const authorization =
    validatePersistenceAuthorization(resolvedAuthorization);
  if (
    !exactStructuredEqual(
      authorization.currentState,
      duplicate ? context.nextState : context.expectedState,
    )
    || !exactStructuredEqual(
      authorization.currentManager,
      context.currentManager,
    )
    || !authorizedDomainsMatch(
      authorization.currentDomains,
      context.currentDomains,
    )
    || !authorizedDomainsMatch(
      authorization.remainingDomains,
      context.remainingDomains,
    )
  ) {
    return "stale";
  }
  const reconstructed =
    aggregateAgentRuntimeAuthorizationTransitionV2({
      crypto: input.crypto,
      publicCandidate,
      completedTargets: candidate.completedTargets,
      currentStorageState: candidate.expected,
      resolveCurrentManagerAuthority: () =>
        authorization.managerSigningPublicKey,
      resolveCurrentTargetCommitter: ({ target }) =>
        authorization.remainingDomains.find((domain) =>
          equalDomain(domain, target)
        )?.committerSigningPublicKey ?? null,
      resolveCurrentEnvelopeCommitter: (envelope) =>
        authorization.currentDomains.find((domain) =>
          equalDomain(domain, envelope)
        )?.committerSigningPublicKey ?? null,
    });
  if (
    !agentRuntimeAuthorizationTransitionCandidatesEqualV2(
      candidate,
      reconstructed,
    )
  ) {
    throw new Error(
      "Agent Runtime authorization transition proof does not match its write set",
    );
  }
  let status: AgentRuntimeAuthorizationTransitionCasStatusV2;
  try {
    status =
      await input.storage.compareAndSwapAgentRuntimeAuthorizationTransition(
        authorizeAgentRuntimeAuthorizationTransitionWriteV2({
          expected: reconstructed.expected,
          intended: reconstructed.intended,
          authorization: {
            purpose: context.purpose,
            operationId: context.operationId,
            currentState: authorization.currentState,
            nextState: context.nextState,
            remainingDomains: context.remainingDomains,
            refreshedDomainIds: context.refreshedDomainIds,
          },
          signerPublication,
        }),
      );
  } catch (cause) {
    throw new AgentRuntimeAuthorizationTransitionOutcomeUnknownV2(cause);
  }
  if (
    status !== "applied"
    && status !== "duplicate"
    && status !== "stale"
  ) {
    throw new TypeError(
      "Agent Runtime authorization transition storage returned an invalid CAS status",
    );
  }
  return status;
}

function atomicStateFromWire(
  value: AgentRuntimeAtomicStorageWireV2,
): AgentRuntimeAtomicStorageStateV2 {
  const state: AgentRuntimeAtomicStorageStateV2 = {
    runtime: Object.freeze({ ...value.runtime }),
    configInventory: Object.freeze({
      objectCount: value.configInventory.objectCount,
      digest: copyOwnedBytesV2(value.configInventory.digest),
    }),
    configObjects: Object.freeze(value.configObjects.map((entry) =>
      Object.freeze({
        agentId: entry.agentId,
        objectId: entry.objectId,
        configRevision: entry.configRevision,
        runtimeGeneration: entry.runtimeGeneration,
        wrappedDekHash: copyOwnedBytesV2(entry.wrappedDekHash),
        wrappedDek:
          authenticatedAgentRuntimeConfigDekV2(entry.wrappedDekBytes),
      })
    )),
    domainEnvelopes: Object.freeze(value.domainEnvelopes.map((entry) =>
      Object.freeze({
        agentId: entry.agentId,
        domainId: entry.domainId,
        domainEpoch: entry.domainEpoch,
        agentAuthorizationRevision: entry.agentAuthorizationRevision,
        runtimeGeneration: entry.runtimeGeneration,
        committerDeviceId: entry.committerDeviceId,
        envelopeHash: copyOwnedBytesV2(entry.envelopeHash),
        envelopeBytes: opaqueBytes(
          "agent-runtime-domain-envelope",
          entry.envelopeBytes,
        ),
      })
    )),
    challengeConsumptions:
      Object.freeze(value.challengeConsumptions.map((entry) =>
        Object.freeze({
          challengeHash: copyOwnedBytesV2(entry.challengeHash),
          consumed: entry.consumed,
        })
      )),
  };
  assertAgentRuntimeAtomicState(state);
  return state;
}

/**
 * Complete server-safe authorization-only transition. The core reads the
 * detached opaque state, reconstructs the signed candidate, and retries only
 * the exact same candidate after an ambiguous storage acknowledgement.
 */
export async function coordinateAgentRuntimeAuthorizationTransitionV2(input: {
  readonly crypto: LatticeCrypto;
  readonly storage: AgentRuntimeAuthorizationTransitionStorageV2;
  readonly publicCandidate:
    AgentRuntimeAuthorizationTransitionPublicCandidateV2;
  readonly completedTargets:
    readonly PreparedAgentRuntimeManagerHandoffTargetV1[];
  readonly resolveCurrentAuthorization:
    ResolveCurrentAgentRuntimeAuthorizationTransitionPersistenceV2;
}): Promise<AgentRuntimeAuthorizationTransitionCasStatusV2> {
  const rawPlan = input.publicCandidate.plan;
  const plan = validatePlan(rawPlan, input.publicCandidate.expectedState);
  const context: AgentRuntimeAuthorizationTransitionPersistenceContextV2 =
    Object.freeze({
      purpose: "persist-agent-runtime-authorization-transition",
      operationId: plan.operationId,
      expectedState: Object.freeze({
        ...input.publicCandidate.expectedState,
      }),
      nextState: Object.freeze({ ...input.publicCandidate.nextState }),
      currentManager: Object.freeze({ ...plan.currentManager }),
      currentDomains: plan.currentDomains,
      remainingDomains: plan.remainingDomains,
      refreshedDomainIds: plan.refreshedDomainIds,
    });
  const wire = await input.storage.getAgentRuntimeAtomicState(plan.agentId);
  if (wire === null) return "stale";
  const resolvedAuthorization =
    await input.resolveCurrentAuthorization(context);
  if (resolvedAuthorization === null) return "stale";
  const authorization =
    validatePersistenceAuthorization(resolvedAuthorization);
  if (
    !exactStructuredEqual(
      authorization.currentState,
      context.expectedState,
    )
    || !exactStructuredEqual(
      authorization.currentManager,
      context.currentManager,
    )
    || !authorizedDomainsMatch(
      authorization.currentDomains,
      context.currentDomains,
    )
    || !authorizedDomainsMatch(
      authorization.remainingDomains,
      context.remainingDomains,
    )
  ) {
    return "stale";
  }
  const candidate =
    aggregateAgentRuntimeAuthorizationTransitionV2({
      crypto: input.crypto,
      publicCandidate: input.publicCandidate,
      completedTargets: input.completedTargets,
      currentStorageState: atomicStateFromWire(wire),
      resolveCurrentManagerAuthority: () =>
        authorization.managerSigningPublicKey,
      resolveCurrentTargetCommitter: ({ target }) =>
        authorization.remainingDomains.find((domain) =>
          equalDomain(domain, target)
        )?.committerSigningPublicKey ?? null,
      resolveCurrentEnvelopeCommitter: (envelope) =>
        authorization.currentDomains.find((domain) =>
          equalDomain(domain, envelope)
        )?.committerSigningPublicKey ?? null,
    });
  const persistenceInput = {
    crypto: input.crypto,
    storage: input.storage,
    candidate,
    resolveCurrentAuthorization: input.resolveCurrentAuthorization,
  } as const;
  try {
    return await persistAgentRuntimeAuthorizationTransitionV2(
      persistenceInput,
    );
  } catch (error) {
    if (
      !(error instanceof
        AgentRuntimeAuthorizationTransitionOutcomeUnknownV2)
    ) {
      throw error;
    }
    return persistAgentRuntimeAuthorizationTransitionV2(
      persistenceInput,
    );
  }
}
