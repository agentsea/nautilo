import type {
  SealedProviderStateV2,
} from "../device/v2-state-vault.ts";
import type {
  V2GroupKeyProvider,
} from "../group/v2-provider.ts";
import type {
  V2Storage,
} from "../storage/v2-storage-contract.ts";
import {
  cloneProviderHeadV2,
  cloneProviderPublicTransitionV2,
  type LocalProviderCandidateV2,
  type PreparedProviderCommitV2,
  type ProviderPublicHeadV2,
  type ProviderPublicTransitionV2,
  type ProviderTransitionOperationV2,
  providerHeadsEqualV2,
} from "./provider-candidate.ts";
import {
  assertPortableId,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  type AuthorizationRevision,
  type CryptoDeviceId,
  type CryptoDomainId,
  type HumanId,
} from "../v2-types/ids.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import {
  authorizeProviderHeadWriteV2,
} from "./provider-authorized-write.ts";

const HASH_BYTES = 32;

export type ProviderTransitionActorStatusV2 =
  | "active"
  | "pending"
  | "suspended"
  | "revoked";

export interface ProviderTransitionAuthorizationContextV2 {
  readonly providerId: string;
  readonly domainId: CryptoDomainId;
  readonly authorizationRevision: AuthorizationRevision;
  readonly actorDeviceId: CryptoDeviceId;
  readonly operation: ProviderTransitionOperationV2;
  readonly targetHumanId: HumanId;
  readonly targetDeviceId: CryptoDeviceId;
  readonly currentHead: ProviderPublicHeadV2;
  readonly nextHead: ProviderPublicHeadV2;
  readonly candidateId: string;
  readonly publicTransitionDigest: Uint8Array;
}

export interface ProviderTransitionAuthorizationDecisionV2
  extends ProviderTransitionAuthorizationContextV2 {
  readonly authorized: boolean;
  readonly actorStatus: ProviderTransitionActorStatusV2;
}

export type ResolveCurrentProviderTransitionAuthorizationV2 = (
  context: ProviderTransitionAuthorizationContextV2,
) =>
  | ProviderTransitionAuthorizationDecisionV2
  | null
  | Promise<ProviderTransitionAuthorizationDecisionV2 | null>;

export interface ProviderTransitionPersistenceAuthorizationV2 {
  readonly authorizationRevision: AuthorizationRevision;
  readonly resolveCurrentAuthorization:
    ResolveCurrentProviderTransitionAuthorizationV2;
}

export type ProviderTransitionCoordinationStatusV2 =
  | "applied"
  | "duplicate"
  | "stale"
  | "aborted";

export interface ProviderTransitionCoordinationResultV2 {
  readonly status: ProviderTransitionCoordinationStatusV2;
  readonly active: SealedProviderStateV2;
}

export class ProviderTransitionOutcomeUnknownV2 extends Error {
  override readonly name = "ProviderTransitionOutcomeUnknownV2";

  constructor(cause: unknown) {
    super(
      "Provider transition storage outcome is ambiguous; retry must be explicit",
      { cause },
    );
  }
}

function cloneSealedProviderState(
  state: SealedProviderStateV2,
): SealedProviderStateV2 {
  return Object.freeze({
    classification: state.classification,
    formatVersion: state.formatVersion,
    providerId: state.providerId,
    domainId: state.domainId,
    deviceId: state.deviceId,
    revision: state.revision,
    snapshotKind: state.snapshotKind,
    ciphertext: copyOwnedBytesV2(state.ciphertext),
  }) as SealedProviderStateV2;
}

function cloneCandidate(
  candidate: LocalProviderCandidateV2,
): LocalProviderCandidateV2 {
  return Object.freeze({
    candidateId: candidate.candidateId,
    providerId: candidate.providerId,
    domainId: candidate.domainId,
    deviceId: candidate.deviceId,
    expectedHead: cloneProviderHeadV2(candidate.expectedHead),
    nextHead: cloneProviderHeadV2(candidate.nextHead),
    publicTransitionDigest:
      copyOwnedBytesV2(candidate.publicTransitionDigest),
    snapshot: cloneSealedProviderState(candidate.snapshot),
  });
}

function clonePublicTransition(
  transition: ProviderPublicTransitionV2,
): ProviderPublicTransitionV2 {
  return cloneProviderPublicTransitionV2(transition);
}

function assertExactFields(
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

function exactHash(label: string, value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== HASH_BYTES) {
    throw new TypeError(`${label} must be exactly ${HASH_BYTES} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function exactHead(
  label: string,
  head: ProviderPublicHeadV2,
): ProviderPublicHeadV2 {
  assertExactFields(label, head, [
    "providerId",
    "domainId",
    "epoch",
    "stateHash",
  ]);
  assertPortableId(`${label} provider id`, head.providerId);
  return Object.freeze({
    providerId: head.providerId,
    domainId: cryptoDomainId(head.domainId),
    epoch: domainEpoch(head.epoch),
    stateHash: exactHash(`${label} state hash`, head.stateHash),
  });
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  // Both digests passed exactHash and therefore have the same fixed length.
  return left.every((byte, index) => byte === right[index]);
}

function cloneAuthorizationContext(
  context: ProviderTransitionAuthorizationContextV2,
): ProviderTransitionAuthorizationContextV2 {
  return Object.freeze({
    providerId: context.providerId,
    domainId: context.domainId,
    authorizationRevision: context.authorizationRevision,
    actorDeviceId: context.actorDeviceId,
    operation: context.operation,
    targetHumanId: context.targetHumanId,
    targetDeviceId: context.targetDeviceId,
    currentHead: exactHead("Current provider head", context.currentHead),
    nextHead: exactHead("Next provider head", context.nextHead),
    candidateId: context.candidateId,
    publicTransitionDigest: exactHash(
      "Provider public transition digest",
      context.publicTransitionDigest,
    ),
  });
}

function authorizationContext(
  authorization: ProviderTransitionPersistenceAuthorizationV2,
  candidate: LocalProviderCandidateV2,
  transition: ProviderPublicTransitionV2,
): ProviderTransitionAuthorizationContextV2 {
  assertPortableId("Provider id", transition.providerId);
  assertPortableId(
    "Provider candidate id",
    candidate.candidateId,
  );
  if (
    transition.operation !== "add"
    && transition.operation !== "remove"
    && transition.operation !== "update"
  ) {
    throw new TypeError("Provider transition operation is invalid");
  }
  const context = {
    providerId: transition.providerId,
    domainId: cryptoDomainId(transition.domainId),
    authorizationRevision: authorizationRevision(
      authorization.authorizationRevision,
    ),
    actorDeviceId: cryptoDeviceId(candidate.deviceId),
    operation: transition.operation,
    targetHumanId: humanId(transition.targetHumanId),
    targetDeviceId: cryptoDeviceId(transition.targetDeviceId),
    currentHead: exactHead(
      "Current provider head",
      transition.expectedHead,
    ),
    nextHead: exactHead("Next provider head", transition.nextHead),
    candidateId: candidate.candidateId,
    publicTransitionDigest: exactHash(
      "Provider public transition digest",
      candidate.publicTransitionDigest,
    ),
  };
  return cloneAuthorizationContext(context);
}

function exactPersistenceAuthorization(
  authorization: ProviderTransitionPersistenceAuthorizationV2,
): ProviderTransitionPersistenceAuthorizationV2 {
  assertExactFields("Provider transition persistence authorization", authorization, [
    "authorizationRevision",
    "resolveCurrentAuthorization",
  ]);
  if (typeof authorization.resolveCurrentAuthorization !== "function") {
    throw new TypeError(
      "Current provider transition authorization resolver is required",
    );
  }
  return Object.freeze({
    authorizationRevision: authorizationRevision(
      authorization.authorizationRevision,
    ),
    resolveCurrentAuthorization: authorization.resolveCurrentAuthorization,
  });
}

function exactDecision(
  value: ProviderTransitionAuthorizationDecisionV2 | null,
): ProviderTransitionAuthorizationDecisionV2 {
  assertExactFields("Current provider transition authorization decision", value, [
    "providerId",
    "domainId",
    "authorizationRevision",
    "actorDeviceId",
    "operation",
    "targetHumanId",
    "targetDeviceId",
    "currentHead",
    "nextHead",
    "candidateId",
    "publicTransitionDigest",
    "authorized",
    "actorStatus",
  ]);
  if (
    typeof value.authorized !== "boolean"
    || (
      value.actorStatus !== "active"
      && value.actorStatus !== "pending"
      && value.actorStatus !== "suspended"
      && value.actorStatus !== "revoked"
    )
  ) {
    throw new TypeError(
      "Current provider transition authorization decision is invalid",
    );
  }
  return Object.freeze({
    ...cloneAuthorizationContext(value),
    authorized: value.authorized,
    actorStatus: value.actorStatus,
  });
}

function decisionsMatch(
  expected: ProviderTransitionAuthorizationContextV2,
  actual: ProviderTransitionAuthorizationDecisionV2,
): boolean {
  return expected.providerId === actual.providerId
    && expected.domainId === actual.domainId
    && expected.authorizationRevision === actual.authorizationRevision
    && expected.actorDeviceId === actual.actorDeviceId
    && expected.operation === actual.operation
    && expected.targetHumanId === actual.targetHumanId
    && expected.targetDeviceId === actual.targetDeviceId
    && providerHeadsEqualV2(expected.currentHead, actual.currentHead)
    && providerHeadsEqualV2(expected.nextHead, actual.nextHead)
    && expected.candidateId === actual.candidateId
    && equalBytes(
      expected.publicTransitionDigest,
      actual.publicTransitionDigest,
    );
}

async function requireFreshAuthorization(
  authorization: ProviderTransitionPersistenceAuthorizationV2,
  context: ProviderTransitionAuthorizationContextV2,
): Promise<void> {
  const pristine = cloneAuthorizationContext(context);
  const decision = exactDecision(
    await authorization.resolveCurrentAuthorization(
      cloneAuthorizationContext(pristine),
    ),
  );
  if (
    decision.authorized !== true
    || decision.actorStatus !== "active"
    || !decisionsMatch(pristine, decision)
  ) {
    throw new Error(
      "Provider transition persistence requires fresh exact host authorization",
    );
  }
}

function publishCandidateLifecycle(
  target: LocalProviderCandidateV2,
  source: LocalProviderCandidateV2,
): void {
  try {
    target.snapshot.ciphertext.set(source.snapshot.ciphertext);
  } catch {
    // This is only a caller-visible lifecycle mirror. The private candidate
    // and returned active state remain authoritative, so detached or hostile
    // caller storage must never turn a completed CAS into a second failure.
  }
}

function assertPreparedCoordinates(
  provider: V2GroupKeyProvider,
  prepared: PreparedProviderCommitV2,
): void {
  const { publicResult, localCandidate } = prepared;
  if (
    publicResult.formatVersion !== 2
    || publicResult.providerId !== provider.id
    || publicResult.domainId !== localCandidate.domainId
    || localCandidate.providerId !== provider.id
    || !providerHeadsEqualV2(
      publicResult.expectedHead,
      localCandidate.expectedHead,
    )
    || !providerHeadsEqualV2(
      publicResult.nextHead,
      localCandidate.nextHead,
    )
  ) {
    throw new Error(
      "Prepared provider transition public and device-local coordinates differ",
    );
  }
}

/**
 * Reference two-boundary coordinator for one prepared provider transition.
 *
 * The server CAS receives public heads, state hashes, and public roster bytes
 * only. A detached local candidate is fully opened and applied as a preflight
 * before that CAS, so malformed device-local state cannot partially advance
 * the server head. The preflight result is never returned or persisted.
 */
export async function coordinateProviderTransitionV2(input: {
  readonly storage: Pick<
    V2Storage,
    "compareAndSwapDomainProviderHead"
  >;
  readonly provider: V2GroupKeyProvider;
  readonly active: SealedProviderStateV2;
  readonly prepared: PreparedProviderCommitV2;
  readonly authorization: ProviderTransitionPersistenceAuthorizationV2;
}): Promise<ProviderTransitionCoordinationResultV2> {
  assertPreparedCoordinates(input.provider, input.prepared);
  const persistenceAuthorization = exactPersistenceAuthorization(
    input.authorization,
  );

  const active = cloneSealedProviderState(input.active);
  const publicResult = clonePublicTransition(input.prepared.publicResult);
  const workingCandidate = cloneCandidate(input.prepared.localCandidate);
  const preflightCandidate = cloneCandidate(workingCandidate);
  const preflight = input.provider.applyCandidate({
    active: cloneSealedProviderState(active),
    candidate: preflightCandidate,
  });
  if (preflight.status === "aborted") {
    return Object.freeze({
      status: "aborted",
      active,
    });
  }
  if (preflight.status === "stale") {
    input.provider.abortCandidate(workingCandidate);
    publishCandidateLifecycle(input.prepared.localCandidate, workingCandidate);
    return Object.freeze({
      status: "stale",
      active,
    });
  }
  const preflightActive = cloneSealedProviderState(preflight.active);
  if (
    !providerHeadsEqualV2(
      input.provider.publicHead(preflightActive),
      publicResult.nextHead,
    )
  ) {
    throw new Error(
      "Provider candidate preflight did not produce the intended public head",
    );
  }

  // The preparing member cannot process its own MLS message. Providers
  // instead open the sealed candidate, derive its public state, and
  // independently bind commit/Welcome/roster bytes to the intended head.
  await input.provider.validatePreparedCandidate({
    active: cloneSealedProviderState(active),
    prepared: Object.freeze({
      publicResult: clonePublicTransition(publicResult),
      localCandidate: cloneCandidate(workingCandidate),
    }),
  });

  const currentAuthorizationContext = authorizationContext(
    persistenceAuthorization,
    workingCandidate,
    publicResult,
  );
  await requireFreshAuthorization(
    persistenceAuthorization,
    currentAuthorizationContext,
  );

  let cas: Awaited<
    ReturnType<V2Storage["compareAndSwapDomainProviderHead"]>
  >;
  try {
    cas = await input.storage.compareAndSwapDomainProviderHead(
      authorizeProviderHeadWriteV2({
        expected: publicResult.expectedHead,
        next: publicResult.nextHead,
        nextRosterBytes: publicResult.rosterBytes,
        authorization: currentAuthorizationContext,
      }),
    );
  } catch (cause) {
    throw new ProviderTransitionOutcomeUnknownV2(cause);
  }
  if (
    cas !== "applied"
    && cas !== "duplicate"
    && cas !== "stale"
  ) {
    throw new TypeError(
      "Provider transition storage returned an invalid CAS status",
    );
  }
  if (cas === "stale") {
    input.provider.abortCandidate(workingCandidate);
    publishCandidateLifecycle(input.prepared.localCandidate, workingCandidate);
    return Object.freeze({
      status: "stale",
      active,
    });
  }

  const applied = input.provider.applyCandidate({
    active: cloneSealedProviderState(active),
    candidate: workingCandidate,
  });
  const appliedActive = cloneSealedProviderState(applied.active);
  if (
    (applied.status !== "applied" && applied.status !== "duplicate")
    || !providerHeadsEqualV2(
      input.provider.publicHead(appliedActive),
      publicResult.nextHead,
    )
  ) {
    throw new Error(
      "Provider candidate changed after successful public-head CAS",
    );
  }
  publishCandidateLifecycle(input.prepared.localCandidate, workingCandidate);

  return Object.freeze({
    status: cas,
    active: appliedActive,
  });
}
