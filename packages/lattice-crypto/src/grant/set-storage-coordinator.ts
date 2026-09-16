import { bytesToHex } from "@noble/hashes/utils.js";
import type { LatticeCrypto } from "../crypto/index.ts";
import {
  parseGrantV2,
  serializeGrantV2,
  type GrantOperationV2,
  type GrantV2,
} from "../format/grant-v2.ts";
import type { GrantWireRecordV2 } from "../storage/v2-records.ts";
import type { V2Storage } from "../storage/v2-storage-contract.ts";
import {
  grantId,
  type GrantId,
} from "../v2-types/ids.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import {
  GrantClaimOutcomeUnknownV2,
  type GrantUseExecutionResultV2,
  type GrantUseSingleUseStatusV2,
} from "./storage-coordinator.ts";
import {
  openGrantV2ForAuthoritySet,
  snapshotGrantAuthoritySetAuthorizationV2,
  type GrantAuthoritySetAuthorizationV2,
  type OpenedGrantAuthoritySetV2,
} from "./set-authorization.ts";

declare const grantAuthoritySetPreflightBrand: unique symbol;
declare const grantAuthoritySetExecutionEvidenceBrand: unique symbol;

export type GrantAuthoritySetExecutionUseStatusV2 =
  | "claimed-by-preflight"
  | "reusable";

export type GrantAuthoritySetExecutionEvidenceV2 = Readonly<{
  readonly grantId: GrantId;
  readonly grantHash: Uint8Array;
  readonly grantUseStatus: GrantAuthoritySetExecutionUseStatusV2;
  readonly recipientAgentId: string;
  readonly recipientKeyId: string;
  readonly grantScope: readonly string[];
  readonly operations: readonly GrantOperationV2[];
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly namespaceRequirements:
    GrantAuthoritySetUseAuthorizationContextV2["requestedNamespaces"];
  readonly domainRequirements:
    GrantAuthoritySetUseAuthorizationContextV2["requestedDomains"];
  readonly [grantAuthoritySetExecutionEvidenceBrand]: true;
}>;

export interface GrantAuthoritySetUseAuthorizationContextV2 {
  readonly purpose: "authorize-grant-authority-set-use";
  readonly preflightId: string;
  readonly phase: "before-claim" | "before-execute";
  readonly grantId: GrantId;
  readonly grantHash: Uint8Array;
  readonly grantBytes: Uint8Array;
  readonly issuingDeviceId: string;
  readonly issuingDeviceHumanId: string;
  readonly issuingDeviceSigningPublicKeyHash: Uint8Array;
  readonly recipientAgentId: string;
  readonly recipientKeyId: string;
  readonly grantScope: readonly string[];
  readonly operations: readonly GrantOperationV2[];
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly preflightTime: number;
  readonly requestedNamespaces: readonly Readonly<{
    readonly namespaceId: string;
    readonly domainId: string;
    readonly operations: readonly GrantOperationV2[];
    readonly namespaceParticipants: readonly string[];
    readonly expectedAccessRevision: number;
    readonly expectedPolicyRevision: number;
  }>[];
  readonly requestedDomains: readonly Readonly<{
    readonly domainId: string;
    readonly expectedEpoch: number;
    readonly expectedAgentAuthorizationRevision: number;
  }>[];
  readonly singleUseStatus: GrantUseSingleUseStatusV2;
}

export interface GrantAuthoritySetUseAuthorizationDecisionV2 {
  readonly context: GrantAuthoritySetUseAuthorizationContextV2;
  readonly currentTime: number;
  readonly issuingDeviceActive: boolean;
  readonly recipientAgentAuthorized: boolean;
  readonly requestedNamespacesAuthorized: boolean;
  readonly requestedDomainsAuthorized: boolean;
  readonly hostAllowsOperation: boolean;
  readonly currentSingleUseStatus: GrantUseSingleUseStatusV2;
}

export type ResolveCurrentGrantAuthoritySetUseAuthorizationV2 = (
  context: GrantAuthoritySetUseAuthorizationContextV2,
) =>
  | GrantAuthoritySetUseAuthorizationDecisionV2
  | null
  | Promise<GrantAuthoritySetUseAuthorizationDecisionV2 | null>;

export type GrantAuthoritySetUsePreflightV2 = Readonly<{
  readonly grantId: GrantId;
  readonly preflightId: string;
  readonly singleUse: boolean;
  readonly [grantAuthoritySetPreflightBrand]: true;
}>;

interface GrantAuthoritySetUseSecretState {
  used: boolean;
  readonly opened: OpenedGrantAuthoritySetV2;
  readonly grantWireBytes: Uint8Array;
  readonly baseContext: Omit<
    GrantAuthoritySetUseAuthorizationContextV2,
    "phase" | "singleUseStatus"
  >;
  readonly singleUse: boolean;
}

type GrantAuthoritySetPublicFactsV2 = Omit<
  GrantAuthoritySetAuthorizationV2,
  "recipientEncryptionPrivateKey"
>;

const authoritySetSecrets = new WeakMap<
  object,
  GrantAuthoritySetUseSecretState
>();
const executionEvidenceSnapshots = new WeakMap<
  object,
  Readonly<{
    readonly snapshot: GrantAuthoritySetExecutionEvidenceV2;
    readonly parent?: GrantAuthoritySetExecutionEvidenceV2;
  }>
>();

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return bytesToHex(left) === bytesToHex(right);
}

function snapshotPublicFacts(
  value: GrantAuthoritySetAuthorizationV2,
): GrantAuthoritySetPublicFactsV2 {
  if (
    !Array.isArray(value.grantScope as unknown)
    || !Array.isArray(value.namespaceRequirements as unknown)
    || !Array.isArray(value.domainRequirements as unknown)
  ) throw new TypeError("Grant authority-set public facts are invalid");
  return Object.freeze({
    now: value.now,
    expectedIssuingDeviceId: value.expectedIssuingDeviceId,
    issuingDeviceHumanId: value.issuingDeviceHumanId,
    issuingDeviceSigningPublicKey:
      copyOwnedBytesV2(value.issuingDeviceSigningPublicKey),
    issuingDeviceActive: value.issuingDeviceActive,
    recipientAgentId: value.recipientAgentId,
    recipientKeyId: value.recipientKeyId,
    singleUseAvailable: value.singleUseAvailable,
    grantScope: Object.freeze([...value.grantScope]),
    namespaceRequirements: Object.freeze(
      value.namespaceRequirements.map((entry) => {
        if (
          !Array.isArray(entry.operations as unknown)
          || !Array.isArray(entry.namespaceParticipants as unknown)
        ) throw new TypeError("Grant Namespace public facts are invalid");
        return Object.freeze({
          ...entry,
          operations: Object.freeze([...entry.operations]),
          namespaceParticipants:
            Object.freeze([...entry.namespaceParticipants]),
        });
      }),
    ),
    domainRequirements: Object.freeze(
      value.domainRequirements.map((entry) => Object.freeze({ ...entry })),
    ),
    hostAllowsOperation: value.hostAllowsOperation,
  });
}

function wipeState(state: GrantAuthoritySetUseSecretState): void {
  state.opened.domains.forEach((entry) => entry.aiRoot.fill(0));
  state.grantWireBytes.fill(0);
}

function exactClaimMatches(
  state: GrantAuthoritySetUseSecretState,
  claimed: GrantWireRecordV2,
): boolean {
  if (
    typeof claimed !== "object"
    || Object.keys(claimed).some((field) =>
      !["grantId", "grantBytes", "consumed"].includes(field)
    )
    || typeof claimed.grantId !== "string"
    || !(claimed.grantBytes instanceof Uint8Array)
    || typeof claimed.consumed !== "boolean"
  ) {
    throw new TypeError("Claimed Grant wire record is malformed");
  }
  const parsed = parseGrantV2(claimed.grantBytes);
  if (parsed === null || parsed.id !== claimed.grantId) {
    throw new Error("Claimed Grant wire record is noncanonical");
  }
  return claimed.consumed && equalBytes(claimed.grantBytes, state.grantWireBytes);
}

function cloneContext(
  context: GrantAuthoritySetUseAuthorizationContextV2,
): GrantAuthoritySetUseAuthorizationContextV2 {
  return Object.freeze({
    ...context,
    grantHash: copyOwnedBytesV2(context.grantHash),
    grantBytes: copyOwnedBytesV2(context.grantBytes),
    issuingDeviceSigningPublicKeyHash:
      copyOwnedBytesV2(context.issuingDeviceSigningPublicKeyHash),
    grantScope: Object.freeze([...context.grantScope]),
    operations: Object.freeze([...context.operations]),
    requestedNamespaces: Object.freeze(
      context.requestedNamespaces.map((entry) => Object.freeze({
        ...entry,
        operations: Object.freeze([...entry.operations]),
        namespaceParticipants:
          Object.freeze([...entry.namespaceParticipants]),
      })),
    ),
    requestedDomains: Object.freeze(
      context.requestedDomains.map((entry) => Object.freeze({ ...entry })),
    ),
  });
}

function cloneExecutionEvidence(
  evidence: GrantAuthoritySetExecutionEvidenceV2,
): GrantAuthoritySetExecutionEvidenceV2 {
  return Object.freeze({
    grantId: evidence.grantId,
    grantHash: copyOwnedBytesV2(evidence.grantHash),
    grantUseStatus: evidence.grantUseStatus,
    recipientAgentId: evidence.recipientAgentId,
    recipientKeyId: evidence.recipientKeyId,
    grantScope: Object.freeze([...evidence.grantScope]),
    operations: Object.freeze([...evidence.operations]),
    issuedAt: evidence.issuedAt,
    expiresAt: evidence.expiresAt,
    namespaceRequirements: Object.freeze(
      evidence.namespaceRequirements.map((entry) => Object.freeze({
        ...entry,
        operations: Object.freeze([...entry.operations]),
        namespaceParticipants:
          Object.freeze([...entry.namespaceParticipants]),
      })),
    ),
    domainRequirements: Object.freeze(
      evidence.domainRequirements.map((entry) => Object.freeze({ ...entry })),
    ),
  }) as GrantAuthoritySetExecutionEvidenceV2;
}

function evidenceFingerprint(
  evidence: GrantAuthoritySetExecutionEvidenceV2,
): string {
  return JSON.stringify({
    ...evidence,
    grantHash: bytesToHex(evidence.grantHash),
  });
}

function createExecutionEvidence(
  state: GrantAuthoritySetUseSecretState,
  grantUseStatus: GrantAuthoritySetExecutionUseStatusV2,
): GrantAuthoritySetExecutionEvidenceV2 {
  const context = state.baseContext;
  const evidence = cloneExecutionEvidence(Object.freeze({
    grantId: context.grantId,
    grantHash: copyOwnedBytesV2(context.grantHash),
    grantUseStatus,
    recipientAgentId: context.recipientAgentId,
    recipientKeyId: context.recipientKeyId,
    grantScope: context.grantScope,
    operations: context.operations,
    issuedAt: context.issuedAt,
    expiresAt: context.expiresAt,
    namespaceRequirements: context.requestedNamespaces,
    domainRequirements: context.requestedDomains,
  }) as GrantAuthoritySetExecutionEvidenceV2);
  executionEvidenceSnapshots.set(evidence, Object.freeze({
    snapshot: cloneExecutionEvidence(evidence),
  }));
  return evidence;
}

export function assertAuthenticGrantAuthoritySetExecutionEvidenceV2(
  evidence: GrantAuthoritySetExecutionEvidenceV2,
): void {
  assertActiveExecutionEvidence(evidence, new Set());
}

function assertActiveExecutionEvidence(
  evidence: GrantAuthoritySetExecutionEvidenceV2,
  visited: Set<object>,
): void {
  const evidenceObject = evidence as object;
  if (visited.has(evidenceObject)) {
    throw new TypeError("Grant authority-set execution evidence is not active");
  }
  visited.add(evidenceObject);
  const state = executionEvidenceSnapshots.get(evidenceObject);
  if (
    state === undefined
    || evidenceFingerprint(state.snapshot) !== evidenceFingerprint(evidence)
  ) {
    throw new TypeError("Grant authority-set execution evidence is not active");
  }
  if (state.parent !== undefined) {
    assertActiveExecutionEvidence(state.parent, visited);
  }
}

function exactCanonicalSubset<T extends string>(
  value: readonly T[],
  canonicalSource: readonly T[],
): readonly T[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const requested = new Set(value);
  if (requested.size !== value.length) return null;
  const canonical = canonicalSource.filter((entry) => requested.has(entry));
  return canonical.length === value.length
      && canonical.every((entry, index) => entry === value[index])
    ? Object.freeze(canonical)
    : null;
}

/**
 * Narrow one active authority-set evidence object for a single callback. The
 * derived evidence contains only public coordinates and remains authentic
 * only while both this callback and its parent evidence are active.
 */
export async function withGrantAuthoritySetExecutionEvidenceSubsetV2<Value>(
  input: Readonly<{
    readonly evidence: GrantAuthoritySetExecutionEvidenceV2;
    readonly namespaceIds: readonly string[];
    readonly requiredOperations: readonly GrantOperationV2[];
    readonly execute: (
      evidence: GrantAuthoritySetExecutionEvidenceV2,
    ) => Value | PromiseLike<Value>;
  }>,
): Promise<Value> {
  assertAuthenticGrantAuthoritySetExecutionEvidenceV2(input.evidence);
  if (typeof input.execute !== "function") {
    throw new TypeError("Grant authority-set subset callback is required");
  }
  const namespaceIds = exactCanonicalSubset(
    input.namespaceIds,
    input.evidence.namespaceRequirements.map((entry) => entry.namespaceId),
  );
  const requiredOperations = exactCanonicalSubset(
    input.requiredOperations,
    input.evidence.operations,
  );
  if (namespaceIds === null || requiredOperations === null) {
    throw new TypeError(
      "Grant authority-set evidence subset must be canonical and authorized",
    );
  }
  const selectedNamespaceIds = new Set(namespaceIds);
  const namespaceRequirements = input.evidence.namespaceRequirements
    .filter((entry) => selectedNamespaceIds.has(entry.namespaceId));
  if (
    namespaceRequirements.length !== namespaceIds.length
    || namespaceRequirements.some((entry) =>
      requiredOperations.some((operation) =>
        !entry.operations.includes(operation)
      )
    )
  ) {
    throw new TypeError(
      "Grant authority-set evidence subset lacks required operations",
    );
  }
  const selectedDomainIds = new Set(
    namespaceRequirements.map((entry) => entry.domainId),
  );
  const domainRequirements = input.evidence.domainRequirements.filter(
    (entry) => selectedDomainIds.has(entry.domainId),
  );
  if (
    domainRequirements.length !== selectedDomainIds.size
    || domainRequirements.some((entry) => !selectedDomainIds.has(entry.domainId))
    || namespaceRequirements.some((entry) =>
      !domainRequirements.some((domain) => domain.domainId === entry.domainId)
    )
  ) {
    throw new TypeError(
      "Grant authority-set evidence subset has incomplete Domain coverage",
    );
  }
  const subset = cloneExecutionEvidence(Object.freeze({
    ...input.evidence,
    operations: requiredOperations,
    namespaceRequirements: Object.freeze(namespaceRequirements.map((entry) =>
      Object.freeze({
        ...entry,
        operations: requiredOperations,
        namespaceParticipants: Object.freeze([...entry.namespaceParticipants]),
      })
    )),
    domainRequirements: Object.freeze(domainRequirements.map((entry) =>
      Object.freeze({ ...entry })
    )),
  }) as GrantAuthoritySetExecutionEvidenceV2);
  executionEvidenceSnapshots.set(subset, Object.freeze({
    snapshot: cloneExecutionEvidence(subset),
    parent: input.evidence,
  }));
  try {
    return await input.execute(subset);
  } finally {
    executionEvidenceSnapshots.delete(subset);
  }
}

/**
 * Narrow active authority-set evidence to an exact, per-Namespace operation
 * set for one callback. This permits a mixed delta such as decrypt on removed
 * Namespaces and encrypt on added Namespaces without retaining unrelated roots
 * or widening either Namespace's authority.
 */
export async function withGrantAuthoritySetExecutionEvidenceNamespaceSubsetV2<
  Value,
>(input: Readonly<{
  readonly evidence: GrantAuthoritySetExecutionEvidenceV2;
  readonly namespaceRequirements: readonly Readonly<{
    readonly namespaceId: string;
    readonly requiredOperations: readonly GrantOperationV2[];
  }>[];
  readonly execute: (
    evidence: GrantAuthoritySetExecutionEvidenceV2,
  ) => Value | PromiseLike<Value>;
}>): Promise<Value> {
  assertAuthenticGrantAuthoritySetExecutionEvidenceV2(input.evidence);
  if (
    typeof input.execute !== "function"
    || !Array.isArray(input.namespaceRequirements as unknown)
    || input.namespaceRequirements.length === 0
  ) throw new TypeError(
    "Grant authority-set per-Namespace subset is invalid",
  );
  const requestedByNamespace = new Map<
    string,
    readonly GrantOperationV2[]
  >();
  for (const requested of input.namespaceRequirements) {
    if (
      typeof requested !== "object"
      || requested === null
      || Object.keys(requested).sort().join(",")
        !== "namespaceId,requiredOperations"
    ) throw new TypeError(
      "Grant authority-set per-Namespace subset fields are invalid",
    );
    const parent = input.evidence.namespaceRequirements.find((entry) =>
      entry.namespaceId === requested.namespaceId
    );
    const requiredOperations = parent === undefined
      ? null
      : exactCanonicalSubset(
        requested.requiredOperations,
        parent.operations,
      );
    if (
      requiredOperations === null
      || requestedByNamespace.has(requested.namespaceId)
    ) throw new TypeError(
      "Grant authority-set per-Namespace subset widens authority",
    );
    requestedByNamespace.set(requested.namespaceId, requiredOperations);
  }
  const namespaceRequirements = input.evidence.namespaceRequirements
    .filter((entry) => requestedByNamespace.has(entry.namespaceId));
  if (
    namespaceRequirements.length !== input.namespaceRequirements.length
    || namespaceRequirements.some((entry, index) =>
      entry.namespaceId !== input.namespaceRequirements[index]!.namespaceId
    )
  ) throw new TypeError(
    "Grant authority-set per-Namespace subset must be canonical",
  );
  const operationSet = new Set(
    [...requestedByNamespace.values()].flat(),
  );
  const operations = input.evidence.operations.filter((operation) =>
    operationSet.has(operation)
  );
  const selectedDomainIds = new Set(
    namespaceRequirements.map((entry) => entry.domainId),
  );
  const domainRequirements = input.evidence.domainRequirements.filter(
    (entry) => selectedDomainIds.has(entry.domainId),
  );
  if (
    domainRequirements.length !== selectedDomainIds.size
    || namespaceRequirements.some((entry) =>
      !domainRequirements.some((domain) => domain.domainId === entry.domainId)
    )
  ) throw new TypeError(
    "Grant authority-set per-Namespace subset has incomplete Domain coverage",
  );
  const subset = cloneExecutionEvidence(Object.freeze({
    ...input.evidence,
    operations: Object.freeze(operations),
    namespaceRequirements: Object.freeze(namespaceRequirements.map((entry) =>
      Object.freeze({
        ...entry,
        operations: requestedByNamespace.get(entry.namespaceId)!,
        namespaceParticipants: Object.freeze([...entry.namespaceParticipants]),
      })
    )),
    domainRequirements: Object.freeze(domainRequirements.map((entry) =>
      Object.freeze({ ...entry })
    )),
  }) as GrantAuthoritySetExecutionEvidenceV2);
  executionEvidenceSnapshots.set(subset, Object.freeze({
    snapshot: cloneExecutionEvidence(subset),
    parent: input.evidence,
  }));
  try {
    return await input.execute(subset);
  } finally {
    executionEvidenceSnapshots.delete(subset);
  }
}

function contextFingerprint(
  context: GrantAuthoritySetUseAuthorizationContextV2,
): string {
  return JSON.stringify({
    ...context,
    grantHash: bytesToHex(context.grantHash),
    grantBytes: bytesToHex(context.grantBytes),
    issuingDeviceSigningPublicKeyHash:
      bytesToHex(context.issuingDeviceSigningPublicKeyHash),
  });
}

function exactDecision(
  value: GrantAuthoritySetUseAuthorizationDecisionV2,
): GrantAuthoritySetUseAuthorizationDecisionV2 {
  const fields = Object.keys(value).sort();
  const expected = [
    "context",
    "currentSingleUseStatus",
    "currentTime",
    "hostAllowsOperation",
    "issuingDeviceActive",
    "recipientAgentAuthorized",
    "requestedDomainsAuthorized",
    "requestedNamespacesAuthorized",
  ];
  if (
    fields.length !== expected.length
    || !fields.every((field, index) => field === expected[index])
    || !Number.isSafeInteger(value.currentTime)
    || typeof value.issuingDeviceActive !== "boolean"
    || typeof value.recipientAgentAuthorized !== "boolean"
    || typeof value.requestedNamespacesAuthorized !== "boolean"
    || typeof value.requestedDomainsAuthorized !== "boolean"
    || typeof value.hostAllowsOperation !== "boolean"
    || !["available", "claimed-by-preflight", "reusable"].includes(
      value.currentSingleUseStatus,
    )
  ) {
    throw new TypeError("Grant authority-set decision is invalid");
  }
  return Object.freeze({ ...value, context: cloneContext(value.context) });
}

async function hasFreshAuthorization(
  state: GrantAuthoritySetUseSecretState,
  resolve: ResolveCurrentGrantAuthoritySetUseAuthorizationV2,
  phase: GrantAuthoritySetUseAuthorizationContextV2["phase"],
  singleUseStatus: GrantUseSingleUseStatusV2,
): Promise<boolean> {
  const pristine = cloneContext(Object.freeze({
    ...state.baseContext,
    phase,
    singleUseStatus,
  }));
  const raw = await resolve(cloneContext(pristine));
  if (raw === null) return false;
  const decision = exactDecision(raw);
  return contextFingerprint(decision.context) === contextFingerprint(pristine)
    && decision.currentTime >= pristine.preflightTime
    && decision.currentTime < pristine.expiresAt
    && decision.issuingDeviceActive
    && decision.recipientAgentAuthorized
    && decision.requestedNamespacesAuthorized
    && decision.requestedDomainsAuthorized
    && decision.hostAllowsOperation
    && decision.currentSingleUseStatus === pristine.singleUseStatus;
}

function baseContext(
  crypto: LatticeCrypto,
  grant: GrantV2,
  grantWireBytes: Uint8Array,
  authorization: GrantAuthoritySetPublicFactsV2,
  opened: OpenedGrantAuthoritySetV2,
  preflightId: string,
): GrantAuthoritySetUseSecretState["baseContext"] {
  return Object.freeze({
    purpose: "authorize-grant-authority-set-use" as const,
    preflightId,
    grantId: grantId(grant.id),
    grantHash: copyOwnedBytesV2(crypto.hash(grantWireBytes)),
    grantBytes: grantWireBytes,
    issuingDeviceId: grant.issuingDeviceId,
    issuingDeviceHumanId: authorization.issuingDeviceHumanId,
    issuingDeviceSigningPublicKeyHash:
      copyOwnedBytesV2(crypto.hash(authorization.issuingDeviceSigningPublicKey)),
    recipientAgentId: grant.recipientAgentId,
    recipientKeyId: grant.recipientKeyId,
    grantScope: Object.freeze([...grant.scope]),
    operations: Object.freeze([...grant.operations]),
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    preflightTime: authorization.now,
    requestedNamespaces: Object.freeze(
      authorization.namespaceRequirements.map((entry) => Object.freeze({
        namespaceId: entry.namespaceId,
        domainId: entry.domainId,
        operations: Object.freeze([...entry.operations]),
        namespaceParticipants:
          Object.freeze([...entry.namespaceParticipants]),
        expectedAccessRevision: entry.expectedAccessRevision,
        expectedPolicyRevision: entry.expectedPolicyRevision,
      })),
    ),
    requestedDomains: Object.freeze(opened.domains.map((entry) =>
      Object.freeze({
        domainId: entry.domainId,
        expectedEpoch: entry.expectedEpoch,
        expectedAgentAuthorizationRevision:
          entry.expectedAgentAuthorizationRevision,
      })
    )),
  });
}

export async function preflightGrantAuthoritySetUseV2(
  crypto: LatticeCrypto,
  grant: GrantV2,
  authorization: GrantAuthoritySetAuthorizationV2,
): Promise<GrantAuthoritySetUsePreflightV2 | null> {
  let grantWireBytes: Uint8Array | null = null;
  let opened: OpenedGrantAuthoritySetV2 | null = null;
  let publicFacts: GrantAuthoritySetPublicFactsV2 | null = null;
  let authorizationSnapshot: GrantAuthoritySetAuthorizationV2 | null = null;
  try {
    grantWireBytes = serializeGrantV2(grant);
    const grantSnapshot = parseGrantV2(grantWireBytes);
    if (grantSnapshot === null) return null;
    const randomId = crypto.randomBytes(16);
    const preflightId = `grant-set-use-${bytesToHex(randomId)}`;
    authorizationSnapshot = snapshotGrantAuthoritySetAuthorizationV2(
      authorization,
    );
    publicFacts = snapshotPublicFacts(authorizationSnapshot);
    opened = await openGrantV2ForAuthoritySet(
      crypto,
      grantSnapshot,
      authorizationSnapshot,
    );
    if (opened === null) return null;
    const context = baseContext(
      crypto,
      grantSnapshot,
      grantWireBytes,
      publicFacts,
      opened,
      preflightId,
    );
    const capability = Object.freeze({
      grantId: opened.grantId,
      preflightId,
      singleUse: grantSnapshot.singleUse,
    }) as GrantAuthoritySetUsePreflightV2;
    authoritySetSecrets.set(capability, {
      used: false,
      opened,
      grantWireBytes,
      baseContext: context,
      singleUse: grantSnapshot.singleUse,
    });
    opened = null;
    grantWireBytes = null;
    return capability;
  } catch {
    return null;
  } finally {
    opened?.domains.forEach((entry) => entry.aiRoot.fill(0));
    grantWireBytes?.fill(0);
    publicFacts?.issuingDeviceSigningPublicKey.fill(0);
    authorizationSnapshot?.issuingDeviceSigningPublicKey.fill(0);
    authorizationSnapshot?.recipientEncryptionPrivateKey.fill(0);
  }
}

export function abortGrantAuthoritySetUseV2(
  preflight: GrantAuthoritySetUsePreflightV2,
): void {
  const state = authoritySetSecrets.get(preflight);
  if (state === undefined) throw new Error("Grant set preflight is untrusted");
  if (state.used) throw new Error("Grant set preflight was already used");
  state.used = true;
  wipeState(state);
}

export async function coordinateGrantAuthoritySetUseV2<Value>(input: {
  readonly preflight: GrantAuthoritySetUsePreflightV2;
  readonly storage: Pick<V2Storage, "consumeGrant">;
  readonly resolveCurrentAuthorization:
    ResolveCurrentGrantAuthoritySetUseAuthorizationV2;
  readonly execute: (
    opened: OpenedGrantAuthoritySetV2,
    evidence: GrantAuthoritySetExecutionEvidenceV2,
  ) => Value | PromiseLike<Value>;
}): Promise<GrantUseExecutionResultV2<Value>> {
  const state = authoritySetSecrets.get(input.preflight);
  if (state === undefined) throw new Error("Grant set preflight is untrusted");
  if (state.used) throw new Error("Grant set preflight was already used");
  state.used = true;
  try {
    if (typeof input.resolveCurrentAuthorization !== "function") {
      throw new TypeError("Current Grant set authorization resolver is required");
    }
    if (state.singleUse) {
      if (!await hasFreshAuthorization(
        state,
        input.resolveCurrentAuthorization,
        "before-claim",
        "available",
      )) return Object.freeze({ status: "unavailable" as const });
      let claimed: GrantWireRecordV2 | null;
      try {
        claimed = await input.storage.consumeGrant(state.opened.grantId);
      } catch (cause) {
        throw new GrantClaimOutcomeUnknownV2(cause);
      }
      if (claimed === null) return Object.freeze({ status: "unavailable" as const });
      if (!exactClaimMatches(state, claimed)) {
        throw new Error("Claimed Grant record does not match set preflight");
      }
      if (!await hasFreshAuthorization(
        state,
        input.resolveCurrentAuthorization,
        "before-execute",
        "claimed-by-preflight",
      )) return Object.freeze({ status: "unavailable" as const });
    } else if (!await hasFreshAuthorization(
      state,
      input.resolveCurrentAuthorization,
      "before-execute",
      "reusable",
    )) return Object.freeze({ status: "unavailable" as const });
    const grantUseStatus = state.singleUse
      ? "claimed-by-preflight" as const
      : "reusable" as const;
    const evidence = createExecutionEvidence(state, grantUseStatus);
    try {
      return Object.freeze({
        status: "executed" as const,
        value: await input.execute(state.opened, evidence),
      });
    } finally {
      executionEvidenceSnapshots.delete(evidence);
    }
  } finally {
    wipeState(state);
  }
}
