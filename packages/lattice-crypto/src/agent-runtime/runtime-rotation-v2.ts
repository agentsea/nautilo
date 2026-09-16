import type { LatticeCrypto } from "../crypto/index.ts";
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
  objectId,
  type AgentId,
  type AgentRuntimeGeneration,
  type AuthorizationRevision,
  type CryptoDeviceId,
  type CryptoDomainId,
  type DomainEpoch,
  type HumanId,
  type ObjectId,
} from "../v2-types/ids.ts";
import { V2_LIMITS, assertV2Limit } from "../v2-types/limits.ts";
import {
  copyOwnedBytesV2,
  type OpaqueBytes,
} from "../v2-types/opaque.ts";
import {
  agentRuntimeManagerHandoffPlansEqualV1,
  agentRuntimeManagerHandoffRuntimeCommitmentV1,
  verifyPreparedAgentRuntimeManagerHandoffTarget,
  type AgentRuntimeManagerHandoffPlanV1,
  type PreparedAgentRuntimeManagerHandoffTargetV1,
  type ResolveCurrentAgentRuntimeManagerHandoffTargetV1,
} from "./runtime-handoff-v2.ts";
import type { AgentRuntimeGenerationV2 } from "./types.ts";
import {
  agentRuntimeRotationSignerPublicationMatchesManifestV1,
  createAgentRuntimeRotationSignerPublicationV1,
  decodeAgentRuntimeSignerPublicationV1,
  encodeAgentRuntimeSignerPublicationV1,
  verifyHistoricalAgentRuntimeSignerPublicationV1,
  type AgentRuntimeSignerPublicationV1,
} from "./signer-publication-v1.ts";

const RUNTIME_KEY_BYTES = 32;
const DEK_BYTES = 32;
const CONFIG_DEK_DOMAIN =
  "nautilo/lattice-crypto/agent-runtime-config-dek/v1";
const CONFIG_DEK_PURPOSE = "agent-runtime-config-dek";
export const AGENT_RUNTIME_ROTATION_MANAGER_SOURCE_PROOF_V2 =
  "nautilo/lattice-crypto/agent-runtime-rotation-manager-source/v1";
const CONFIG_INVENTORY_DOMAIN =
  "nautilo/lattice-crypto/agent-runtime-config-inventory/v1";
const ROTATION_MANIFEST_DOMAIN =
  "nautilo/lattice-crypto/agent-runtime-rotation-manifest/v1";

const activeSourceLocals = new WeakSet<object>();

export interface AgentRuntimeRotationStateV2 {
  readonly agentId: AgentId;
  readonly authorizationRevision: AuthorizationRevision;
  readonly runtimeGeneration: AgentRuntimeGeneration;
}

export interface AgentRuntimeAuthorizationDomainV2 {
  readonly domainId: CryptoDomainId;
  readonly domainEpoch: DomainEpoch;
  readonly agentAuthorizationRevision: AuthorizationRevision;
  readonly committerDeviceId: CryptoDeviceId;
}

export interface AgentRuntimeRotationManagerV2 {
  readonly managerHumanId: HumanId;
  readonly managerAuthorizationRevision: AuthorizationRevision;
  readonly managerDeviceId: CryptoDeviceId;
}

export interface AgentRuntimeAuthorizationPlanV2 {
  readonly operationId: string;
  readonly agentId: AgentId;
  readonly oldAuthorizationRevision: AuthorizationRevision;
  readonly newAuthorizationRevision: AuthorizationRevision;
  readonly currentRuntimeGeneration: AgentRuntimeGeneration;
  readonly runtimeRotationRequired: boolean;
  readonly currentManager: AgentRuntimeRotationManagerV2 | null;
  readonly activeConfigInventory: AgentRuntimeConfigInventoryCommitmentV2;
  readonly remainingDomains: readonly AgentRuntimeAuthorizationDomainV2[];
}

export interface AgentRuntimeConfigInventoryCommitmentV2 {
  readonly objectCount: number;
  readonly digest: Uint8Array;
}

export interface AgentRuntimeConfigDekContextV2 {
  readonly agentId: AgentId;
  readonly objectId: ObjectId;
  readonly configRevision: AuthorizationRevision;
  readonly runtimeGeneration: AgentRuntimeGeneration;
}

export interface AgentRuntimeConfigObjectV2
  extends AgentRuntimeConfigDekContextV2 {
  readonly wrappedDek: Uint8Array;
}

export interface AgentRuntimeManagerAuthorityContextV2
  extends AgentRuntimeRotationManagerV2 {
  readonly purpose: "agent-runtime-rotation-source";
  readonly operationId: string;
  readonly agentId: AgentId;
  readonly oldAuthorizationRevision: AuthorizationRevision;
  readonly newAuthorizationRevision: AuthorizationRevision;
  readonly currentRuntimeGeneration: AgentRuntimeGeneration;
  readonly nextRuntimeGeneration: AgentRuntimeGeneration;
}

export type ResolveCurrentAgentRuntimeManagerAuthorityV2 = (
  context: AgentRuntimeManagerAuthorityContextV2,
) => Uint8Array | null;

export interface OpaqueAgentRuntimeConfigDekV2 {
  readonly classification: "opaque-ciphertext";
  readonly kind: "agent-runtime-config-dek";
  readonly ciphertext: Uint8Array;
}

export interface PreparedAgentRuntimeConfigRewrapV2 {
  readonly expected: Readonly<AgentRuntimeConfigDekContextV2 & {
    readonly wrappedDekHash: Uint8Array;
  }>;
  readonly nextWrappedDek: OpaqueAgentRuntimeConfigDekV2;
}

export type TrustedAgentRuntimeAuthorizationPlanV2 =
  AgentRuntimeAuthorizationPlanV2;

export interface AgentRuntimeRotationSourceLocalV2 {
  readonly runtime: AgentRuntimeGenerationV2;
}

export interface AgentRuntimeRotationPublicCandidateV2 {
  readonly plan: TrustedAgentRuntimeAuthorizationPlanV2;
  readonly expectedState: AgentRuntimeRotationStateV2;
  readonly nextState: AgentRuntimeRotationStateV2;
  readonly configRewraps: readonly PreparedAgentRuntimeConfigRewrapV2[];
  readonly targetIntents: readonly AgentRuntimeManagerHandoffPlanV1[];
  readonly runtimeCommitment: Uint8Array;
  readonly manifestHash: Uint8Array;
  readonly managerSignature: Uint8Array;
  readonly signerPublication: AgentRuntimeSignerPublicationV1;
}

export type PreparedAgentRuntimeRotationSourceV2 =
  | Readonly<{
    readonly kind: "unchanged";
    readonly plan: TrustedAgentRuntimeAuthorizationPlanV2;
    readonly expectedState: AgentRuntimeRotationStateV2;
    readonly nextAuthorizationRevision: AuthorizationRevision;
  }>
  | Readonly<{
    readonly kind: "rotated";
    readonly sourceLocal: AgentRuntimeRotationSourceLocalV2;
    readonly publicCandidate: AgentRuntimeRotationPublicCandidateV2;
  }>;

export interface AtomicAgentRuntimeRotationCandidateV2 {
  readonly publicCandidate: AgentRuntimeRotationPublicCandidateV2;
  readonly completedTargets:
    readonly PreparedAgentRuntimeManagerHandoffTargetV1[];
  readonly operationId: string;
  readonly currentManager: AgentRuntimeRotationManagerV2;
  readonly expectedState: AgentRuntimeRotationStateV2;
  readonly nextState: AgentRuntimeRotationStateV2;
  readonly expectedConfigInventory: AgentRuntimeConfigInventoryCommitmentV2;
  readonly configRewraps: readonly PreparedAgentRuntimeConfigRewrapV2[];
  readonly domainEnvelopes: readonly Readonly<{
    readonly expectedDomain: AgentRuntimeAuthorizationDomainV2;
    readonly envelopeBytes:
      OpaqueBytes<"agent-runtime-domain-envelope">;
    readonly challengeConsumption: Readonly<{
      readonly challengeHash: Uint8Array;
      readonly expectedConsumed: false;
      readonly intendedConsumed: true;
    }>;
  }>[];
}

interface ValidatedObject {
  readonly context: AgentRuntimeConfigDekContextV2;
  readonly wrappedDek: Uint8Array;
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
  const actualFields = Object.keys(value).sort().join("\u0000");
  const expectedFields = [...expected].sort().join("\u0000");
  if (actualFields !== expectedFields) {
    throw new TypeError(`${label} has an invalid field set`);
  }
}

function exactBytes(
  label: string,
  value: unknown,
  length: number,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new RangeError(`${label} must contain exactly ${length} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function cloneSignerPublication(
  value: AgentRuntimeSignerPublicationV1,
): AgentRuntimeSignerPublicationV1 {
  const encoded = encodeAgentRuntimeSignerPublicationV1(value);
  try {
    return decodeAgentRuntimeSignerPublicationV1(encoded);
  } finally {
    encoded.fill(0);
  }
}

function assertExactBytes(
  label: string,
  value: unknown,
  length: number,
): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new RangeError(`${label} must contain exactly ${length} bytes`);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length
    && left.every((byte, index) => byte === right[index])
  );
}

function comparePortableIds(left: string, right: string): number {
  const leftBytes = utf8V2(left);
  const rightBytes = utf8V2(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  const differingIndex = leftBytes
    .subarray(0, sharedLength)
    .findIndex((byte, index) => byte !== rightBytes[index]);
  return differingIndex === -1
    ? leftBytes.length - rightBytes.length
    : leftBytes[differingIndex]! - rightBytes[differingIndex]!;
}

function cloneState(
  state: AgentRuntimeRotationStateV2,
): AgentRuntimeRotationStateV2 {
  assertObject("Current Agent Runtime state", state);
  assertExactFields("Current Agent Runtime state", state, [
    "agentId",
    "authorizationRevision",
    "runtimeGeneration",
  ]);
  return Object.freeze({
    agentId: agentId(state.agentId),
    authorizationRevision: authorizationRevision(
      state.authorizationRevision,
    ),
    runtimeGeneration: agentRuntimeGeneration(state.runtimeGeneration),
  });
}

function validateManager(
  value: AgentRuntimeRotationManagerV2 | null,
): AgentRuntimeRotationManagerV2 | null {
  if (value === null) return null;
  assertObject("Current Agent Runtime manager result", value);
  assertExactFields("Current Agent Runtime manager result", value, [
    "managerHumanId",
    "managerAuthorizationRevision",
    "managerDeviceId",
  ]);
  return Object.freeze({
    managerHumanId: humanId(value.managerHumanId),
    managerAuthorizationRevision: authorizationRevision(
      value.managerAuthorizationRevision,
    ),
    managerDeviceId: cryptoDeviceId(value.managerDeviceId),
  });
}

function validateInventoryCommitment(
  value: AgentRuntimeConfigInventoryCommitmentV2,
): AgentRuntimeConfigInventoryCommitmentV2 {
  assertObject("Active Runtime config inventory commitment", value);
  assertExactFields("Active Runtime config inventory commitment", value, [
    "objectCount",
    "digest",
  ]);
  assertV2Limit(
    "Active Runtime config inventory object count",
    value.objectCount,
    V2_LIMITS.batchItems,
  );
  return Object.freeze({
    objectCount: value.objectCount,
    digest: exactBytes(
      "Active Runtime config inventory digest",
      value.digest,
      32,
    ),
  });
}

function validateDomains(
  values: readonly AgentRuntimeAuthorizationDomainV2[],
): readonly AgentRuntimeAuthorizationDomainV2[] {
  if (!Array.isArray(values)) {
    throw new TypeError("Remaining Agent Runtime Domains must be an array");
  }
  assertV2Limit(
    "Remaining Agent Runtime Domain count",
    values.length,
    V2_LIMITS.agentGrantDomains,
  );
  const result: AgentRuntimeAuthorizationDomainV2[] = [];
  for (const raw of values) {
    assertObject("Remaining Agent Runtime Domain", raw);
    assertExactFields("Remaining Agent Runtime Domain", raw, [
      "domainId",
      "domainEpoch",
      "agentAuthorizationRevision",
      "committerDeviceId",
    ]);
    const value =
      raw as unknown as AgentRuntimeAuthorizationDomainV2;
    const domainId = cryptoDomainId(value.domainId);
    result.push(Object.freeze({
      domainId,
      domainEpoch: domainEpoch(value.domainEpoch),
      agentAuthorizationRevision: authorizationRevision(
        value.agentAuthorizationRevision,
      ),
      committerDeviceId: cryptoDeviceId(value.committerDeviceId),
    }));
    if (result.length > 1) {
      const order = comparePortableIds(
        result[result.length - 2]!.domainId,
        domainId,
      );
      if (order >= 0) {
        throw new Error(
          order === 0
            ? "Remaining Agent Runtime Domains contain a duplicate"
            : "Remaining Agent Runtime Domains must be unsigned-byte sorted",
        );
      }
    }
  }
  return Object.freeze(result);
}

function validatePlan(input: {
  readonly currentState: AgentRuntimeRotationStateV2;
  readonly plan: AgentRuntimeAuthorizationPlanV2;
}): Readonly<{
  plan: TrustedAgentRuntimeAuthorizationPlanV2;
  current: AgentRuntimeRotationStateV2;
  nextGeneration: AgentRuntimeGeneration;
}> {
  const current = cloneState(input.currentState);
  assertObject("Agent Runtime authorization plan", input.plan);
  assertExactFields("Agent Runtime authorization plan", input.plan, [
    "operationId",
    "agentId",
    "oldAuthorizationRevision",
    "newAuthorizationRevision",
    "currentRuntimeGeneration",
    "runtimeRotationRequired",
    "currentManager",
    "activeConfigInventory",
    "remainingDomains",
  ]);
  assertPortableId(
    "Agent Runtime rotation operation id",
    input.plan.operationId,
  );
  const checked = Object.freeze({
    operationId: input.plan.operationId,
    agentId: agentId(input.plan.agentId),
    oldAuthorizationRevision: authorizationRevision(
      input.plan.oldAuthorizationRevision,
    ),
    newAuthorizationRevision: authorizationRevision(
      input.plan.newAuthorizationRevision,
    ),
    currentRuntimeGeneration: agentRuntimeGeneration(
      input.plan.currentRuntimeGeneration,
    ),
    runtimeRotationRequired: input.plan.runtimeRotationRequired,
    currentManager: validateManager(input.plan.currentManager),
    activeConfigInventory: validateInventoryCommitment(
      input.plan.activeConfigInventory,
    ),
    remainingDomains: validateDomains(input.plan.remainingDomains),
  });
  if (typeof checked.runtimeRotationRequired !== "boolean") {
    throw new TypeError("Runtime rotation requirement must be boolean");
  }
  if (
    checked.agentId !== current.agentId
    || checked.oldAuthorizationRevision !== current.authorizationRevision
    || checked.currentRuntimeGeneration !== current.runtimeGeneration
  ) {
    throw new Error("Agent Runtime rotation plan is stale or mismatched");
  }
  if (
    checked.newAuthorizationRevision
      !== checked.oldAuthorizationRevision + 1
  ) {
    throw new Error(
      "Agent Runtime rotation plan must advance exactly one authorization revision",
    );
  }
  if (checked.runtimeRotationRequired && checked.currentManager === null) {
    throw new Error(
      "Agent Runtime rotation requires a current manager source",
    );
  }
  const nextGeneration = checked.runtimeRotationRequired
    ? agentRuntimeGeneration(checked.currentRuntimeGeneration + 1)
    : checked.currentRuntimeGeneration;
  return Object.freeze({
    plan: checked,
    current,
    nextGeneration,
  });
}

function validateObjects(
  values: readonly AgentRuntimeConfigObjectV2[],
  plan: Pick<
    TrustedAgentRuntimeAuthorizationPlanV2,
    "agentId" | "currentRuntimeGeneration"
  >,
): readonly ValidatedObject[] {
  if (!Array.isArray(values)) {
    throw new TypeError("Active Runtime config objects must be an array");
  }
  assertV2Limit(
    "Active Runtime config object count",
    values.length,
    V2_LIMITS.batchItems,
  );
  const result: ValidatedObject[] = [];
  for (const raw of values) {
    assertObject("Active Runtime config object", raw);
    assertExactFields("Active Runtime config object", raw, [
      "agentId",
      "objectId",
      "configRevision",
      "runtimeGeneration",
      "wrappedDek",
    ]);
    const value = raw as unknown as AgentRuntimeConfigObjectV2;
    const context = Object.freeze({
      agentId: agentId(value.agentId),
      objectId: objectId(value.objectId),
      configRevision: authorizationRevision(value.configRevision),
      runtimeGeneration: agentRuntimeGeneration(value.runtimeGeneration),
    });
    if (
      context.agentId !== plan.agentId
      || context.runtimeGeneration !== plan.currentRuntimeGeneration
    ) {
      throw new Error(
        "Active Runtime config object has stale Agent or generation metadata",
      );
    }
    if (
      !(value.wrappedDek instanceof Uint8Array)
      || value.wrappedDek.length < 40
      || value.wrappedDek.length > V2_LIMITS.wrappedDekBytes
    ) {
      throw new RangeError("Wrapped Runtime config DEK is malformed");
    }
    result.push(Object.freeze({
      context,
      wrappedDek: copyOwnedBytesV2(value.wrappedDek),
    }));
    if (result.length > 1) {
      const order = comparePortableIds(
        result[result.length - 2]!.context.objectId,
        context.objectId,
      );
      if (order >= 0) {
        throw new Error(
          order === 0
            ? "Active Runtime config objects contain a duplicate"
            : "Active Runtime config objects must be unsigned-byte sorted",
        );
      }
    }
  }
  return Object.freeze(result);
}

function configInventoryEntryBytes(input: {
  readonly agentId: AgentId;
  readonly objectId: ObjectId;
  readonly configRevision: AuthorizationRevision;
  readonly runtimeGeneration: AgentRuntimeGeneration;
  readonly wrappedDekHash: Uint8Array;
}): Uint8Array {
  return concatV2(
    frameText(input.agentId),
    frameText(input.objectId),
    encodeU64(input.configRevision),
    encodeU64(input.runtimeGeneration),
    frame(input.wrappedDekHash),
  );
}

function configInventoryDigest(
  crypto: LatticeCrypto,
  entries: readonly Readonly<{
    readonly agentId: AgentId;
    readonly objectId: ObjectId;
    readonly configRevision: AuthorizationRevision;
    readonly runtimeGeneration: AgentRuntimeGeneration;
    readonly wrappedDekHash: Uint8Array;
  }>[],
): Uint8Array {
  const encoded = concatV2(
    frameText(CONFIG_INVENTORY_DOMAIN),
    encodeU32(1),
    encodeU32(entries.length),
    ...entries.map(configInventoryEntryBytes),
  );
  return copyOwnedBytesV2(crypto.hash(encoded));
}

function commitmentFromValidatedObjects(
  crypto: LatticeCrypto,
  objects: readonly ValidatedObject[],
): AgentRuntimeConfigInventoryCommitmentV2 {
  const entries = objects.map((object) =>
    Object.freeze({
      ...object.context,
      wrappedDekHash: copyOwnedBytesV2(
        crypto.hash(object.wrappedDek),
      ),
    })
  );
  return Object.freeze({
    objectCount: entries.length,
    digest: configInventoryDigest(crypto, entries),
  });
}

export function agentRuntimeConfigInventoryCommitmentV2(input: {
  readonly crypto: LatticeCrypto;
  readonly agentId: AgentId;
  readonly runtimeGeneration: AgentRuntimeGeneration;
  readonly activeConfigObjects: readonly AgentRuntimeConfigObjectV2[];
}): AgentRuntimeConfigInventoryCommitmentV2 {
  const expectedAgentId = agentId(input.agentId);
  const expectedGeneration = agentRuntimeGeneration(input.runtimeGeneration);
  const objects = validateObjects(input.activeConfigObjects, {
    agentId: expectedAgentId,
    currentRuntimeGeneration: expectedGeneration,
  });
  return commitmentFromValidatedObjects(input.crypto, objects);
}

export function agentRuntimeConfigDekAadV2(
  context: AgentRuntimeConfigDekContextV2,
): Uint8Array {
  assertObject("Agent Runtime config DEK context", context);
  assertExactFields("Agent Runtime config DEK context", context, [
    "agentId",
    "objectId",
    "configRevision",
    "runtimeGeneration",
  ]);
  return concatV2(
    frameText(CONFIG_DEK_DOMAIN),
    frameText(CONFIG_DEK_PURPOSE),
    encodeU32(1),
    frameText(agentId(context.agentId)),
    frameText(objectId(context.objectId)),
    encodeU64(authorizationRevision(context.configRevision)),
    encodeU64(agentRuntimeGeneration(context.runtimeGeneration)),
  );
}

function planProofBytes(
  plan: TrustedAgentRuntimeAuthorizationPlanV2,
  nextGeneration: AgentRuntimeGeneration,
): Uint8Array {
  const manager = plan.currentManager!;
  return concatV2(
    frameText(AGENT_RUNTIME_ROTATION_MANAGER_SOURCE_PROOF_V2),
    frameText(plan.operationId),
    frameText(plan.agentId),
    encodeU64(plan.oldAuthorizationRevision),
    encodeU64(plan.newAuthorizationRevision),
    encodeU64(plan.currentRuntimeGeneration),
    encodeU64(nextGeneration),
    frameText(manager.managerHumanId),
    encodeU64(manager.managerAuthorizationRevision),
    frameText(manager.managerDeviceId),
  );
}

function managerContext(
  plan: TrustedAgentRuntimeAuthorizationPlanV2,
  nextGeneration: AgentRuntimeGeneration,
): AgentRuntimeManagerAuthorityContextV2 {
  const manager = plan.currentManager!;
  return Object.freeze({
    purpose: "agent-runtime-rotation-source",
    operationId: plan.operationId,
    agentId: plan.agentId,
    oldAuthorizationRevision: plan.oldAuthorizationRevision,
    newAuthorizationRevision: plan.newAuthorizationRevision,
    currentRuntimeGeneration: plan.currentRuntimeGeneration,
    nextRuntimeGeneration: nextGeneration,
    ...manager,
  });
}

function assertManagerSource(
  crypto: LatticeCrypto,
  plan: TrustedAgentRuntimeAuthorizationPlanV2,
  nextGeneration: AgentRuntimeGeneration,
  resolve: ResolveCurrentAgentRuntimeManagerAuthorityV2,
  signingPrivateKey: Uint8Array,
): Uint8Array {
  const publicKey = resolve(managerContext(plan, nextGeneration));
  if (publicKey === null) {
    throw new Error("Agent Runtime rotation manager is not currently authorized");
  }
  const checkedPublic = exactBytes(
    "Current manager signing public key",
    publicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  const proof = planProofBytes(plan, nextGeneration);
  let signature: Uint8Array | null = null;
  try {
    signature = crypto.sign(signingPrivateKey, proof);
    if (!crypto.verify(checkedPublic, proof, signature)) {
      throw new Error(
        "Agent Runtime rotation manager private key does not match current authority",
      );
    }
    return checkedPublic;
  } catch (error) {
    checkedPublic.fill(0);
    throw error;
  } finally {
    proof.fill(0);
    signature?.fill(0);
  }
}

function opaqueConfigDek(ciphertext: Uint8Array): OpaqueAgentRuntimeConfigDekV2 {
  return Object.freeze({
    classification: "opaque-ciphertext",
    kind: "agent-runtime-config-dek",
    ciphertext: copyOwnedBytesV2(ciphertext),
  });
}

function authorizationDomainBytes(
  value: AgentRuntimeAuthorizationDomainV2,
): Uint8Array {
  return concatV2(
    frameText(value.domainId),
    encodeU64(value.domainEpoch),
    encodeU64(value.agentAuthorizationRevision),
    frameText(value.committerDeviceId),
  );
}

function authorizationPlanBytes(
  plan: TrustedAgentRuntimeAuthorizationPlanV2,
): Uint8Array {
  const manager = plan.currentManager!;
  return concatV2(
    frameText(plan.operationId),
    frameText(plan.agentId),
    encodeU64(plan.oldAuthorizationRevision),
    encodeU64(plan.newAuthorizationRevision),
    encodeU64(plan.currentRuntimeGeneration),
    Uint8Array.of(plan.runtimeRotationRequired ? 1 : 0),
    Uint8Array.of(1),
    frameText(manager.managerHumanId),
    encodeU64(manager.managerAuthorizationRevision),
    frameText(manager.managerDeviceId),
    encodeU32(plan.activeConfigInventory.objectCount),
    frame(plan.activeConfigInventory.digest),
    encodeU32(plan.remainingDomains.length),
    ...plan.remainingDomains.map(authorizationDomainBytes),
  );
}

function rotationStateBytes(value: AgentRuntimeRotationStateV2): Uint8Array {
  return concatV2(
    frameText(value.agentId),
    encodeU64(value.authorizationRevision),
    encodeU64(value.runtimeGeneration),
  );
}

function configRewrapBytes(
  value: PreparedAgentRuntimeConfigRewrapV2,
): Uint8Array {
  return concatV2(
    configInventoryEntryBytes(value.expected),
    frame(value.nextWrappedDek.ciphertext),
  );
}

function rotationManifestBytes(input: {
  readonly plan: TrustedAgentRuntimeAuthorizationPlanV2;
  readonly expectedState: AgentRuntimeRotationStateV2;
  readonly nextState: AgentRuntimeRotationStateV2;
  readonly configRewraps: readonly PreparedAgentRuntimeConfigRewrapV2[];
  readonly runtimeCommitment: Uint8Array;
}): Uint8Array {
  return concatV2(
    frameText(ROTATION_MANIFEST_DOMAIN),
    encodeU32(1),
    authorizationPlanBytes(input.plan),
    rotationStateBytes(input.expectedState),
    rotationStateBytes(input.nextState),
    frame(input.runtimeCommitment),
    encodeU32(input.configRewraps.length),
    ...input.configRewraps.map(configRewrapBytes),
  );
}

function rotationManifestSigningBytes(manifestHash: Uint8Array): Uint8Array {
  return concatV2(
    frameText(ROTATION_MANIFEST_DOMAIN),
    frameText("manager-signature"),
    encodeU32(1),
    frame(manifestHash),
  );
}

function targetIntents(
  plan: TrustedAgentRuntimeAuthorizationPlanV2,
  nextGeneration: AgentRuntimeGeneration,
  manifestHash: Uint8Array,
  runtimeCommitment: Uint8Array,
): readonly AgentRuntimeManagerHandoffPlanV1[] {
  const manager = plan.currentManager!;
  return Object.freeze(plan.remainingDomains.map((target) =>
    Object.freeze({
      operationId: plan.operationId,
      agentId: plan.agentId,
      runtimeGeneration: nextGeneration,
      rotationManifestHash: copyOwnedBytesV2(manifestHash),
      runtimeCommitment: copyOwnedBytesV2(runtimeCommitment),
      source: Object.freeze({ ...manager }),
      target: Object.freeze({ ...target }),
    })
  ));
}

export function prepareAgentRuntimeRotationSourceV2(input: {
  readonly crypto: LatticeCrypto;
  readonly currentState: AgentRuntimeRotationStateV2;
  readonly currentRuntime?: AgentRuntimeGenerationV2;
  readonly plan: AgentRuntimeAuthorizationPlanV2;
  readonly activeConfigObjects?: readonly AgentRuntimeConfigObjectV2[];
  readonly resolveCurrentManagerAuthority?:
    ResolveCurrentAgentRuntimeManagerAuthorityV2;
  readonly managerSigningPrivateKey?: Uint8Array;
}): PreparedAgentRuntimeRotationSourceV2 {
  const checked = validatePlan(input);
  if (!checked.plan.runtimeRotationRequired) {
    if (
      input.activeConfigObjects !== undefined
      || input.resolveCurrentManagerAuthority !== undefined
      || input.managerSigningPrivateKey !== undefined
      || input.currentRuntime !== undefined
    ) {
      throw new Error(
        "A no-rotation plan must not include Runtime, config, or manager secrets",
      );
    }
    return Object.freeze({
      kind: "unchanged",
      plan: checked.plan,
      expectedState: checked.current,
      nextAuthorizationRevision: checked.plan.newAuthorizationRevision,
    });
  }
  if (input.currentRuntime === undefined) {
    throw new TypeError("Current Agent Runtime is required for rotation");
  }
  assertObject("Current Agent Runtime", input.currentRuntime);
  assertExactFields("Current Agent Runtime", input.currentRuntime, [
    "agentId",
    "keyClass",
    "generation",
    "key",
  ]);
  if (
    input.currentRuntime.agentId !== checked.plan.agentId
    || input.currentRuntime.keyClass !== "runtime"
    || input.currentRuntime.generation
      !== checked.plan.currentRuntimeGeneration
  ) {
    throw new Error("Current Agent Runtime does not match the rotation plan");
  }
  assertExactBytes(
    "Current Agent Runtime key",
    input.currentRuntime.key,
    RUNTIME_KEY_BYTES,
  );
  assertExactBytes(
    "Manager signing private key",
    input.managerSigningPrivateKey,
    V2_LIMITS.signingPrivateKeyBytes,
  );
  if (typeof input.resolveCurrentManagerAuthority !== "function") {
    throw new TypeError("Current manager authority resolver is required");
  }
  if (input.activeConfigObjects === undefined) {
    throw new TypeError(
      "Active Runtime config inventory is required for rotation",
    );
  }
  const objects = validateObjects(
    input.activeConfigObjects,
    checked.plan,
  );
  const actualInventory = commitmentFromValidatedObjects(
    input.crypto,
    objects,
  );
  if (
    actualInventory.objectCount
      !== checked.plan.activeConfigInventory.objectCount
    || !equalBytes(
      actualInventory.digest,
      checked.plan.activeConfigInventory.digest,
    )
  ) {
    throw new Error(
      "Active Runtime config inventory does not match its commitment",
    );
  }
  const oldKey = copyOwnedBytesV2(input.currentRuntime.key);
  let managerPrivate: Uint8Array | null = null;
  let managerPublic: Uint8Array | null = null;
  let newKey: Uint8Array | null = null;
  const partialCiphertexts: Uint8Array[] = [];
  try {
    managerPrivate = copyOwnedBytesV2(
      input.managerSigningPrivateKey,
    );
    managerPublic = assertManagerSource(
      input.crypto,
      checked.plan,
      checked.nextGeneration,
      input.resolveCurrentManagerAuthority,
      managerPrivate,
    );
    const generatedKey = input.crypto.randomBytes(RUNTIME_KEY_BYTES);
    try {
      if (generatedKey.length !== RUNTIME_KEY_BYTES) {
        throw new RangeError("Fresh Agent Runtime key must contain 32 bytes");
      }
      newKey = copyOwnedBytesV2(generatedKey);
    } finally {
      generatedKey.fill(0);
    }
    const runtime = Object.freeze({
      agentId: checked.plan.agentId,
      keyClass: "runtime" as const,
      generation: checked.nextGeneration,
      key: newKey,
    });
    const rewraps: PreparedAgentRuntimeConfigRewrapV2[] = [];
    for (const object of objects) {
      const dek = input.crypto.aeadOpen(
        oldKey,
        object.wrappedDek,
        agentRuntimeConfigDekAadV2(object.context),
      );
      if (dek === null || dek.length !== DEK_BYTES) {
        dek?.fill(0);
        throw new Error("Active Runtime config DEK failed to decrypt");
      }
      try {
        const nextContext = {
          ...object.context,
          runtimeGeneration: checked.nextGeneration,
        };
        const wrapped = input.crypto.aeadSeal(
          newKey,
          dek,
          agentRuntimeConfigDekAadV2(nextContext),
        );
        partialCiphertexts.push(wrapped);
        rewraps.push(Object.freeze({
          expected: Object.freeze({
            ...object.context,
            wrappedDekHash: copyOwnedBytesV2(
              input.crypto.hash(object.wrappedDek),
            ),
          }),
          nextWrappedDek: opaqueConfigDek(wrapped),
        }));
      } finally {
        dek.fill(0);
      }
    }
    const sourceLocal = Object.freeze({ runtime });
    activeSourceLocals.add(sourceLocal);
    const nextState = Object.freeze({
      agentId: checked.plan.agentId,
      authorizationRevision: checked.plan.newAuthorizationRevision,
      runtimeGeneration: checked.nextGeneration,
    });
    const runtimeCommitment =
      agentRuntimeManagerHandoffRuntimeCommitmentV1({
        crypto: input.crypto,
        operationId: checked.plan.operationId,
        agentId: checked.plan.agentId,
        runtimeGeneration: checked.nextGeneration,
        runtimeKey: newKey,
      });
    const manifestHash = input.crypto.hash(rotationManifestBytes({
      plan: checked.plan,
      expectedState: checked.current,
      nextState,
      configRewraps: rewraps,
      runtimeCommitment,
    }));
    const managerSignature = input.crypto.sign(
      managerPrivate,
      rotationManifestSigningBytes(manifestHash),
    );
    const signerPublication =
      createAgentRuntimeRotationSignerPublicationV1({
        crypto: input.crypto,
        operationId: checked.plan.operationId,
        authorizationRevision: checked.plan.newAuthorizationRevision,
        validatedRotationManifestHash: manifestHash,
        runtime,
        manager: checked.plan.currentManager!,
        managerSigningPrivateKey: managerPrivate,
        resolveCurrentManagerAuthority: () => managerPublic,
      });
    const publicCandidate = Object.freeze({
      plan: checked.plan,
      expectedState: checked.current,
      nextState,
      configRewraps: Object.freeze(rewraps),
      targetIntents: targetIntents(
        checked.plan,
        checked.nextGeneration,
        manifestHash,
        runtimeCommitment,
      ),
      runtimeCommitment,
      manifestHash: copyOwnedBytesV2(manifestHash),
      managerSignature: copyOwnedBytesV2(managerSignature),
      signerPublication,
    });
    newKey = null;
    return Object.freeze({
      kind: "rotated",
      sourceLocal,
      publicCandidate,
    });
  } catch (error) {
    newKey?.fill(0);
    for (const ciphertext of partialCiphertexts) ciphertext.fill(0);
    throw error;
  } finally {
    oldKey.fill(0);
    managerPrivate?.fill(0);
    managerPublic?.fill(0);
  }
}

export function assertAgentRuntimeRotationSourceLocalV2(
  value: AgentRuntimeRotationSourceLocalV2,
): void {
  if (!activeSourceLocals.has(value)) {
    throw new Error(
      "Agent Runtime rotation source-local key is absent or destroyed",
    );
  }
}

export function destroyAgentRuntimeRotationSourceLocalV2(
  value: AgentRuntimeRotationSourceLocalV2,
): void {
  if (!activeSourceLocals.has(value)) {
    throw new Error("Agent Runtime rotation source-local value is untrusted");
  }
  value.runtime.key.fill(0);
  activeSourceLocals.delete(value);
}

function cloneConfigRewrap(
  value: PreparedAgentRuntimeConfigRewrapV2,
): PreparedAgentRuntimeConfigRewrapV2 {
  return Object.freeze({
    expected: Object.freeze({
      agentId: value.expected.agentId,
      objectId: value.expected.objectId,
      configRevision: value.expected.configRevision,
      runtimeGeneration: value.expected.runtimeGeneration,
      wrappedDekHash: copyOwnedBytesV2(
        value.expected.wrappedDekHash,
      ),
    }),
    nextWrappedDek: opaqueConfigDek(value.nextWrappedDek.ciphertext),
  });
}

function validatePublicCandidateInventories(
  candidate: AgentRuntimeRotationPublicCandidateV2,
  checked: ReturnType<typeof validatePlan>,
): Readonly<{
  readonly configRewraps: readonly PreparedAgentRuntimeConfigRewrapV2[];
  readonly targetIntents: readonly AgentRuntimeManagerHandoffPlanV1[];
}> {
  if (
    !Array.isArray(candidate.configRewraps as unknown)
    || !Array.isArray(candidate.targetIntents as unknown)
  ) {
    throw new TypeError(
      "Agent Runtime rotation public inventories must be arrays",
    );
  }
  assertV2Limit(
    "Agent Runtime config rewrap count",
    candidate.configRewraps.length,
    V2_LIMITS.batchItems,
  );
  const configRewraps: PreparedAgentRuntimeConfigRewrapV2[] = [];
  for (const rewrap of candidate.configRewraps) {
    assertObject("Agent Runtime config rewrap", rewrap);
    assertExactFields("Agent Runtime config rewrap", rewrap, [
      "expected",
      "nextWrappedDek",
    ]);
    const expected = rewrap.expected;
    assertObject("Agent Runtime config rewrap expectation", expected);
    assertExactFields("Agent Runtime config rewrap expectation", expected, [
      "agentId",
      "objectId",
      "configRevision",
      "runtimeGeneration",
      "wrappedDekHash",
    ]);
    assertObject(
      "Agent Runtime config rewrap opaque ciphertext",
      rewrap.nextWrappedDek,
    );
    assertExactFields(
      "Agent Runtime config rewrap opaque ciphertext",
      rewrap.nextWrappedDek,
      ["classification", "kind", "ciphertext"],
    );
    const id = objectId(expected.objectId);
    if (
      agentId(expected.agentId) !== checked.plan.agentId
      || agentRuntimeGeneration(expected.runtimeGeneration)
        !== checked.plan.currentRuntimeGeneration
      || !(expected.wrappedDekHash instanceof Uint8Array)
      || expected.wrappedDekHash.length !== 32
      || rewrap.nextWrappedDek.classification !== "opaque-ciphertext"
      || rewrap.nextWrappedDek.kind !== "agent-runtime-config-dek"
      || !(rewrap.nextWrappedDek.ciphertext instanceof Uint8Array)
      || rewrap.nextWrappedDek.ciphertext.length < 40
      || rewrap.nextWrappedDek.ciphertext.length > V2_LIMITS.wrappedDekBytes
    ) {
      throw new Error("Agent Runtime config rewrap inventory is invalid");
    }
    authorizationRevision(expected.configRevision);
    configRewraps.push(cloneConfigRewrap(rewrap));
    if (configRewraps.length > 1) {
      const priorId =
        configRewraps[configRewraps.length - 2]!.expected.objectId;
      const order = comparePortableIds(priorId, id);
      if (order >= 0) {
        throw new Error(
          "Agent Runtime config rewrap inventory is duplicate or unordered",
        );
      }
    }
  }
  if (
    candidate.targetIntents.length
      !== checked.plan.remainingDomains.length
  ) {
    throw new Error("Agent Runtime target intent coverage is incomplete");
  }
  for (
    let index = 0;
    index < checked.plan.remainingDomains.length;
    index += 1
  ) {
    const intent = candidate.targetIntents[index]!;
    assertObject("Agent Runtime target intent", intent);
    assertExactFields("Agent Runtime target intent", intent, [
      "operationId",
      "agentId",
      "runtimeGeneration",
      "rotationManifestHash",
      "runtimeCommitment",
      "source",
      "target",
    ]);
    assertObject("Agent Runtime target intent source", intent.source);
    assertExactFields("Agent Runtime target intent source", intent.source, [
      "managerHumanId",
      "managerAuthorizationRevision",
      "managerDeviceId",
    ]);
    assertObject("Agent Runtime target intent Domain", intent.target);
    assertExactFields("Agent Runtime target intent Domain", intent.target, [
      "domainId",
      "domainEpoch",
      "agentAuthorizationRevision",
      "committerDeviceId",
    ]);
    const target = checked.plan.remainingDomains[index]!;
    const manager = checked.plan.currentManager!;
    if (
      !(intent.rotationManifestHash instanceof Uint8Array)
      || !(intent.runtimeCommitment instanceof Uint8Array)
      || intent.operationId !== checked.plan.operationId
      || intent.agentId !== checked.plan.agentId
      || intent.runtimeGeneration !== checked.nextGeneration
      || !equalBytes(intent.rotationManifestHash, candidate.manifestHash)
      || !equalBytes(intent.runtimeCommitment, candidate.runtimeCommitment)
      || intent.source.managerHumanId !== manager.managerHumanId
      || intent.source.managerAuthorizationRevision
        !== manager.managerAuthorizationRevision
      || intent.source.managerDeviceId !== manager.managerDeviceId
      || intent.target.domainId !== target.domainId
      || intent.target.domainEpoch !== target.domainEpoch
      || intent.target.agentAuthorizationRevision
        !== target.agentAuthorizationRevision
      || intent.target.committerDeviceId !== target.committerDeviceId
    ) {
      throw new Error("Agent Runtime target intent coordinates are invalid");
    }
  }
  return Object.freeze({
    configRewraps: Object.freeze(configRewraps),
    targetIntents: Object.freeze(candidate.targetIntents.map((intent, index) =>
      Object.freeze({
        operationId: intent.operationId,
        agentId: intent.agentId,
        runtimeGeneration: intent.runtimeGeneration,
        rotationManifestHash: copyOwnedBytesV2(
          intent.rotationManifestHash,
        ),
        runtimeCommitment: copyOwnedBytesV2(intent.runtimeCommitment),
        source: Object.freeze({
          managerHumanId: intent.source.managerHumanId,
          managerAuthorizationRevision:
            intent.source.managerAuthorizationRevision,
          managerDeviceId: intent.source.managerDeviceId,
        }),
        target: checked.plan.remainingDomains[index]!,
      })
    )),
  });
}

export function aggregateAgentRuntimeRotationV2(input: {
  readonly crypto: LatticeCrypto;
  readonly publicCandidate: AgentRuntimeRotationPublicCandidateV2;
  readonly completedTargets:
    readonly PreparedAgentRuntimeManagerHandoffTargetV1[];
  readonly resolveCurrentManagerAuthority:
    ResolveCurrentAgentRuntimeManagerAuthorityV2;
  readonly resolveCurrentTargetCommitter:
    ResolveCurrentAgentRuntimeManagerHandoffTargetV1;
}): AtomicAgentRuntimeRotationCandidateV2 {
  assertObject("Agent Runtime rotation public candidate", input.publicCandidate);
  assertExactFields(
    "Agent Runtime rotation public candidate",
    input.publicCandidate,
    [
      "plan",
      "expectedState",
      "nextState",
      "configRewraps",
      "targetIntents",
      "runtimeCommitment",
      "manifestHash",
      "managerSignature",
      "signerPublication",
    ],
  );
  const checked = validatePlan({
    currentState: input.publicCandidate.expectedState,
    plan: input.publicCandidate.plan,
  });
  const nextState = cloneState(input.publicCandidate.nextState);
  if (
    !checked.plan.runtimeRotationRequired
    || nextState.agentId !== checked.plan.agentId
    || nextState.authorizationRevision
      !== checked.plan.newAuthorizationRevision
    || nextState.runtimeGeneration
      !== checked.nextGeneration
  ) {
    throw new Error("Agent Runtime rotation public candidate is inconsistent");
  }
  const runtimeCommitment = exactBytes(
    "Agent Runtime rotation Runtime commitment",
    input.publicCandidate.runtimeCommitment,
    32,
  );
  const manifestHash = exactBytes(
    "Agent Runtime rotation manifest hash",
    input.publicCandidate.manifestHash,
    32,
  );
  const managerSignature = exactBytes(
    "Agent Runtime rotation manager signature",
    input.publicCandidate.managerSignature,
    V2_LIMITS.signatureBytes,
  );
  const inventories = validatePublicCandidateInventories(
    input.publicCandidate,
    checked,
  );
  const inventoryFromCandidate = Object.freeze({
    objectCount: inventories.configRewraps.length,
    digest: configInventoryDigest(
      input.crypto,
      inventories.configRewraps.map((rewrap) => rewrap.expected),
    ),
  });
  if (
    inventoryFromCandidate.objectCount
      !== checked.plan.activeConfigInventory.objectCount
    || !equalBytes(
      inventoryFromCandidate.digest,
      checked.plan.activeConfigInventory.digest,
    )
  ) {
    throw new Error(
      "Agent Runtime config rewrap coverage does not match the committed inventory",
    );
  }
  const reconstructedManifestHash = input.crypto.hash(rotationManifestBytes({
    plan: checked.plan,
    expectedState: checked.current,
    nextState,
    configRewraps: inventories.configRewraps,
    runtimeCommitment,
  }));
  if (!equalBytes(reconstructedManifestHash, manifestHash)) {
    throw new Error("Agent Runtime rotation manifest hash is invalid");
  }
  const managerPublicKey = input.resolveCurrentManagerAuthority(
    managerContext(checked.plan, checked.nextGeneration),
  );
  if (managerPublicKey === null) {
    throw new Error("Agent Runtime rotation manager is not currently authorized");
  }
  const checkedManagerPublicKey = exactBytes(
    "Current manager signing public key",
    managerPublicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  if (
    !input.crypto.verify(
      checkedManagerPublicKey,
      rotationManifestSigningBytes(manifestHash),
      managerSignature,
    )
  ) {
    throw new Error("Agent Runtime rotation manager manifest signature is invalid");
  }
  if (
    !agentRuntimeRotationSignerPublicationMatchesManifestV1(
      input.publicCandidate.signerPublication,
      {
        operationId: checked.plan.operationId,
        agentId: checked.plan.agentId,
        authorizationRevision: checked.plan.newAuthorizationRevision,
        runtimeGeneration: checked.nextGeneration,
        validatedRotationManifestHash: manifestHash,
      },
    )
    || !verifyHistoricalAgentRuntimeSignerPublicationV1({
      crypto: input.crypto,
      publication: input.publicCandidate.signerPublication,
      resolveHistoricalManagerAuthority: (context) =>
        context.managerHumanId
            === checked.plan.currentManager!.managerHumanId
          && context.managerAuthorizationRevision
            === checked.plan.currentManager!.managerAuthorizationRevision
          && context.managerDeviceId
            === checked.plan.currentManager!.managerDeviceId
          ? checkedManagerPublicKey
          : null,
    })
  ) {
    throw new Error(
      "Agent Runtime rotation signer publication is invalid",
    );
  }
  if (!Array.isArray(input.completedTargets as unknown)) {
    throw new TypeError("Completed Runtime targets must be an array");
  }
  const expected = input.publicCandidate.plan.remainingDomains;
  if (input.completedTargets.length !== expected.length) {
    throw new Error("Completed Runtime target coverage is incomplete");
  }
  const verifiedTargets: PreparedAgentRuntimeManagerHandoffTargetV1[] = [];
  const envelopes = input.completedTargets.map((completion, index) => {
    const verifiedCompletion =
      verifyPreparedAgentRuntimeManagerHandoffTarget({
        crypto: input.crypto,
        value: completion,
        resolveCurrentTargetCommitter:
          input.resolveCurrentTargetCommitter,
      });
    verifiedTargets.push(verifiedCompletion);
    const target = expected[index]!;
    const intent = inventories.targetIntents[index]!;
    if (
      !agentRuntimeManagerHandoffPlansEqualV1(
        verifiedCompletion.plan,
        intent,
      )
    ) {
      const duplicate = input.completedTargets
        .slice(0, index)
        .some((prior) =>
          prior.plan.target.domainId
            === verifiedCompletion.plan.target.domainId
        );
      throw new Error(
        duplicate
          ? "Completed Runtime targets contain a duplicate"
          : "Completed Runtime target order or coordinates are invalid",
      );
    }
    return Object.freeze({
      expectedDomain: Object.freeze({ ...target }),
      envelopeBytes: Object.freeze({
        classification: "opaque-ciphertext" as const,
        kind: "agent-runtime-domain-envelope" as const,
        ciphertext: copyOwnedBytesV2(
          verifiedCompletion.envelopeBytes.ciphertext,
        ),
      }) as OpaqueBytes<"agent-runtime-domain-envelope">,
      challengeConsumption: Object.freeze({
        challengeHash:
          verifiedCompletion.challengeConsumption.challengeHash,
        expectedConsumed: false as const,
        intendedConsumed: true as const,
      }),
    });
  });
  const verifiedPublicCandidate = Object.freeze({
    plan: checked.plan,
    expectedState: checked.current,
    nextState,
    configRewraps: inventories.configRewraps,
    targetIntents: inventories.targetIntents,
    runtimeCommitment,
    manifestHash,
    managerSignature,
    signerPublication: cloneSignerPublication(
      input.publicCandidate.signerPublication,
    ),
  });
  const atomicCandidate = Object.freeze({
    publicCandidate: verifiedPublicCandidate,
    completedTargets: Object.freeze(verifiedTargets),
    operationId: checked.plan.operationId,
    currentManager: checked.plan.currentManager!,
    expectedState: checked.current,
    nextState,
    expectedConfigInventory: validateInventoryCommitment(
      checked.plan.activeConfigInventory,
    ),
    configRewraps: inventories.configRewraps,
    domainEnvelopes: Object.freeze(envelopes),
  });
  return atomicCandidate;
}
