import type {
  AgentRuntimeAtomicStorageStateV2,
  AgentRuntimeChallengeConsumptionRecordV2,
  AgentRuntimeChallengeReservationExpectationV2,
  AgentRuntimeRotationStorageExpectationV2,
} from "../storage/v2-records.ts";
import {
  cloneOpaqueBytes,
  copyOwnedBytesV2,
  type OpaqueByteKind,
  type OpaqueBytes,
} from "../v2-types/opaque.ts";
import type {
  AgentRuntimeChallengeReservationAuthorizationContextV2,
  AgentRuntimeRotationCasAuthorizationV2,
} from "./storage-coordinator.ts";
import {
  assertAgentRuntimeStorageOpaqueFields,
} from "./storage-opaque-fields.ts";
import {
  decodeAgentRuntimeSignerPublicationV1,
  encodeAgentRuntimeSignerPublicationV1,
  type AgentRuntimeSignerPublicationV1,
} from "./signer-publication-v1.ts";

declare const authorizedRuntimeReservationBrand: unique symbol;
declare const authorizedRuntimeRotationBrand: unique symbol;
declare const authorizedRuntimeAuthorizationTransitionBrand: unique symbol;

export type AuthorizedAgentRuntimeChallengeReservationWriteV2 = Readonly<{
  readonly expected: AgentRuntimeChallengeReservationExpectationV2;
  readonly additions: readonly AgentRuntimeChallengeConsumptionRecordV2[];
  readonly authorization:
    AgentRuntimeChallengeReservationAuthorizationContextV2;
  readonly [authorizedRuntimeReservationBrand]: true;
}>;

export type AuthorizedAgentRuntimeRotationWriteV2 = Readonly<{
  readonly expected: AgentRuntimeRotationStorageExpectationV2;
  readonly intended: AgentRuntimeAtomicStorageStateV2;
  readonly authorization: AgentRuntimeRotationCasAuthorizationV2;
  readonly signerPublication: AgentRuntimeSignerPublicationV1;
  readonly [authorizedRuntimeRotationBrand]: true;
}>;

export interface AgentRuntimeAuthorizationTransitionWriteAuthorizationV2 {
  readonly purpose: "persist-agent-runtime-authorization-transition";
  readonly operationId: string;
  readonly currentState: AgentRuntimeRotationStorageExpectationV2["runtime"];
  readonly nextState: AgentRuntimeRotationStorageExpectationV2["runtime"];
  readonly remainingDomains: readonly Readonly<{
    readonly domainId: string;
    readonly domainEpoch: number;
    readonly agentAuthorizationRevision: number;
    readonly committerDeviceId: string;
  }>[];
  readonly refreshedDomainIds: readonly string[];
}

export type AuthorizedAgentRuntimeAuthorizationTransitionWriteV2 = Readonly<{
  readonly expected: AgentRuntimeAtomicStorageStateV2;
  readonly intended: AgentRuntimeAtomicStorageStateV2;
  readonly authorization:
    AgentRuntimeAuthorizationTransitionWriteAuthorizationV2;
  readonly signerPublication: AgentRuntimeSignerPublicationV1;
  readonly [authorizedRuntimeAuthorizationTransitionBrand]: true;
}>;

interface ReservationSnapshot {
  readonly expected: AgentRuntimeChallengeReservationExpectationV2;
  readonly additions: readonly AgentRuntimeChallengeConsumptionRecordV2[];
  readonly authorization:
    AgentRuntimeChallengeReservationAuthorizationContextV2;
  readonly fingerprint: string;
}

interface RotationSnapshot {
  readonly expected: AgentRuntimeRotationStorageExpectationV2;
  readonly intended: AgentRuntimeAtomicStorageStateV2;
  readonly authorization: AgentRuntimeRotationCasAuthorizationV2;
  readonly signerPublication: AgentRuntimeSignerPublicationV1;
  readonly fingerprint: string;
}

interface AuthorizationTransitionSnapshot {
  readonly expected: AgentRuntimeAtomicStorageStateV2;
  readonly intended: AgentRuntimeAtomicStorageStateV2;
  readonly authorization:
    AgentRuntimeAuthorizationTransitionWriteAuthorizationV2;
  readonly signerPublication: AgentRuntimeSignerPublicationV1;
  readonly fingerprint: string;
}

const reservations = new WeakMap<object, ReservationSnapshot>();
const rotations = new WeakMap<object, RotationSnapshot>();
const authorizationTransitions =
  new WeakMap<object, AuthorizationTransitionSnapshot>();

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

function fingerprint(value: unknown): string {
  const encoded = JSON.stringify(plain(value));
  if (encoded === undefined) {
    throw new TypeError("Agent Runtime storage write cannot be fingerprinted");
  }
  return encoded;
}

function exactFields(
  value: object,
  expected: readonly string[],
): boolean {
  return Object.keys(value).sort().join("\0")
    === [...expected].sort().join("\0");
}

function cloneValue<T>(value: T): T {
  if (value instanceof Uint8Array) return copyOwnedBytesV2(value) as T;
  if (Array.isArray(value)) {
    const entries = value as readonly unknown[];
    return entries.map((entry) => cloneValue<unknown>(entry)) as T;
  }
  if (typeof value !== "object" || value === null) return value;
  const candidate = value as Record<string, unknown>;
  if (
    candidate["classification"] === "opaque-ciphertext"
    && typeof candidate["kind"] === "string"
    && candidate["ciphertext"] instanceof Uint8Array
  ) {
    return cloneOpaqueBytes(
      value as unknown as OpaqueBytes<OpaqueByteKind>,
    ) as T;
  }
  return Object.fromEntries(
    Object.entries(candidate).map(([key, child]) => [
      key,
      cloneValue(child),
    ]),
  ) as T;
}

function cloneReservation(
  input: Readonly<{
    readonly expected: AgentRuntimeChallengeReservationExpectationV2;
    readonly additions: readonly AgentRuntimeChallengeConsumptionRecordV2[];
    readonly authorization:
      AgentRuntimeChallengeReservationAuthorizationContextV2;
  }>,
): Omit<ReservationSnapshot, "fingerprint"> {
  return cloneValue(input);
}

function cloneRotation(
  input: Readonly<{
    readonly expected: AgentRuntimeRotationStorageExpectationV2;
    readonly intended: AgentRuntimeAtomicStorageStateV2;
    readonly authorization: AgentRuntimeRotationCasAuthorizationV2;
    readonly signerPublication: AgentRuntimeSignerPublicationV1;
  }>,
): Omit<RotationSnapshot, "fingerprint"> {
  return cloneValue(input);
}

function cloneAuthorizationTransition(
  input: Readonly<{
    readonly expected: AgentRuntimeAtomicStorageStateV2;
    readonly intended: AgentRuntimeAtomicStorageStateV2;
    readonly authorization:
      AgentRuntimeAuthorizationTransitionWriteAuthorizationV2;
    readonly signerPublication: AgentRuntimeSignerPublicationV1;
  }>,
): Omit<AuthorizationTransitionSnapshot, "fingerprint"> {
  return cloneValue(input);
}

export function authorizeAgentRuntimeChallengeReservationWriteV2(input: {
  readonly expected: AgentRuntimeChallengeReservationExpectationV2;
  readonly additions: readonly AgentRuntimeChallengeConsumptionRecordV2[];
  readonly authorization:
    AgentRuntimeChallengeReservationAuthorizationContextV2;
}): AuthorizedAgentRuntimeChallengeReservationWriteV2 {
  if (typeof input.expected !== "object" || input.expected === null) {
    throw new TypeError(
      "Agent Runtime challenge reservation expectation must be an object",
    );
  }
  if (!Array.isArray(input.additions as unknown)) {
    throw new TypeError(
      "Agent Runtime challenge reservation additions must be an array",
    );
  }
  if (
    fingerprint(input.expected.runtime)
      !== fingerprint(input.authorization.expectedState)
    || fingerprint(input.additions.map((entry) => entry.challengeHash))
      !== fingerprint(input.authorization.challengeHashes)
    || input.authorization.remainingDomains.length
      !== input.additions.length
  ) {
    throw new TypeError(
      "Agent Runtime challenge authorization does not match its write set",
    );
  }
  const privateSnapshot = cloneReservation(input);
  const authorized = Object.freeze(
    cloneReservation(privateSnapshot),
  ) as AuthorizedAgentRuntimeChallengeReservationWriteV2;
  reservations.set(authorized, Object.freeze({
    ...privateSnapshot,
    fingerprint: fingerprint(authorized),
  }));
  return authorized;
}

export function consumeAuthorizedAgentRuntimeChallengeReservationWriteV2(
  value: AuthorizedAgentRuntimeChallengeReservationWriteV2,
): Readonly<{
  expected: AgentRuntimeChallengeReservationExpectationV2;
  additions: readonly AgentRuntimeChallengeConsumptionRecordV2[];
  authorization: AgentRuntimeChallengeReservationAuthorizationContextV2;
}> {
  const capability = typeof value === "object" && value !== null
    ? value as object
    : null;
  const snapshot = capability === null
    ? undefined
    : reservations.get(capability);
  if (capability !== null) reservations.delete(capability);
  if (
    snapshot === undefined
    || typeof value !== "object"
    || value === null
    || Object.keys(value).length !== 3
    || !Object.hasOwn(value, "expected")
    || !Object.hasOwn(value, "additions")
    || !Object.hasOwn(value, "authorization")
    || fingerprint(value) !== snapshot.fingerprint
  ) {
    throw new TypeError(
      "Agent Runtime challenge reservation CAS requires an authorized write capability",
    );
  }
  return Object.freeze(cloneReservation(snapshot));
}

export function authorizeAgentRuntimeRotationWriteV2(input: {
  readonly expected: AgentRuntimeRotationStorageExpectationV2;
  readonly intended: AgentRuntimeAtomicStorageStateV2;
  readonly authorization: AgentRuntimeRotationCasAuthorizationV2;
  readonly signerPublication: AgentRuntimeSignerPublicationV1;
}): AuthorizedAgentRuntimeRotationWriteV2 {
  if (typeof input.expected !== "object" || input.expected === null) {
    throw new TypeError("Agent Runtime rotation expectation must be an object");
  }
  if (typeof input.intended !== "object" || input.intended === null) {
    throw new TypeError("Agent Runtime atomic state must be an object");
  }
  assertAgentRuntimeStorageOpaqueFields(input.intended);
  decodeAgentRuntimeSignerPublicationV1(
    encodeAgentRuntimeSignerPublicationV1(input.signerPublication),
  );
  const authorizedDomains = input.authorization.remainingDomains.map(
    (domain) => ({
      domainId: domain.domainId,
      domainEpoch: domain.domainEpoch,
      agentAuthorizationRevision: domain.agentAuthorizationRevision,
      committerDeviceId: domain.committerDeviceId,
    }),
  );
  const intendedDomains = input.intended.domainEnvelopes.map((domain) => ({
    domainId: domain.domainId,
    domainEpoch: domain.domainEpoch,
    agentAuthorizationRevision: domain.agentAuthorizationRevision,
    committerDeviceId: domain.committerDeviceId,
  }));
  const liveState = input.authorization.currentState;
  if (
    fingerprint(input.expected.runtime)
      !== fingerprint(input.authorization.context.expectedState)
    || fingerprint(input.intended.runtime)
      !== fingerprint(input.authorization.context.nextState)
    || (
      fingerprint(liveState) !== fingerprint(input.expected.runtime)
      && fingerprint(liveState) !== fingerprint(input.intended.runtime)
    )
    || fingerprint(input.authorization.currentManager)
      !== fingerprint(input.authorization.context.expectedManager)
    || fingerprint(authorizedDomains) !== fingerprint(intendedDomains)
  ) {
    throw new TypeError(
      "Agent Runtime rotation authorization does not match its write set",
    );
  }
  const privateSnapshot = cloneRotation(input);
  const authorized = Object.freeze(
    cloneRotation(privateSnapshot),
  ) as AuthorizedAgentRuntimeRotationWriteV2;
  rotations.set(authorized, Object.freeze({
    ...privateSnapshot,
    fingerprint: fingerprint(authorized),
  }));
  return authorized;
}

export function consumeAuthorizedAgentRuntimeRotationWriteV2(
  value: AuthorizedAgentRuntimeRotationWriteV2,
): Readonly<{
  expected: AgentRuntimeRotationStorageExpectationV2;
  intended: AgentRuntimeAtomicStorageStateV2;
  authorization: AgentRuntimeRotationCasAuthorizationV2;
  signerPublication: AgentRuntimeSignerPublicationV1;
}> {
  const capability = typeof value === "object" && value !== null
    ? value as object
    : null;
  const snapshot = capability === null
    ? undefined
    : rotations.get(capability);
  if (capability !== null) rotations.delete(capability);
  if (
    snapshot === undefined
    || typeof value !== "object"
    || value === null
    || Object.keys(value).length !== 4
    || !Object.hasOwn(value, "expected")
    || !Object.hasOwn(value, "intended")
    || !Object.hasOwn(value, "authorization")
    || !Object.hasOwn(value, "signerPublication")
    || fingerprint(value) !== snapshot.fingerprint
  ) {
    throw new TypeError(
      "Agent Runtime rotation CAS requires an authorized write capability",
    );
  }
  return Object.freeze(cloneRotation(snapshot));
}

export function authorizeAgentRuntimeAuthorizationTransitionWriteV2(input: {
  readonly expected: AgentRuntimeAtomicStorageStateV2;
  readonly intended: AgentRuntimeAtomicStorageStateV2;
  readonly authorization:
    AgentRuntimeAuthorizationTransitionWriteAuthorizationV2;
  readonly signerPublication: AgentRuntimeSignerPublicationV1;
}): AuthorizedAgentRuntimeAuthorizationTransitionWriteV2 {
  if (typeof input.expected !== "object" || input.expected === null) {
    throw new TypeError(
      "Agent Runtime authorization transition expectation must be an object",
    );
  }
  if (typeof input.intended !== "object" || input.intended === null) {
    throw new TypeError(
      "Agent Runtime authorization transition state must be an object",
    );
  }
  if (
    typeof input.authorization !== "object"
    || input.authorization === null
    || !exactFields(input.authorization, [
      "purpose",
      "operationId",
      "currentState",
      "nextState",
      "remainingDomains",
      "refreshedDomainIds",
    ])
    || !Array.isArray(input.authorization.remainingDomains)
    || !Array.isArray(input.authorization.refreshedDomainIds)
  ) {
    throw new TypeError(
      "Agent Runtime authorization transition authority is invalid",
    );
  }
  assertAgentRuntimeStorageOpaqueFields(input.expected);
  assertAgentRuntimeStorageOpaqueFields(input.intended);
  decodeAgentRuntimeSignerPublicationV1(
    encodeAgentRuntimeSignerPublicationV1(input.signerPublication),
  );
  const intendedDomains = input.intended.domainEnvelopes.map((domain) => ({
    domainId: domain.domainId,
    domainEpoch: domain.domainEpoch,
    agentAuthorizationRevision: domain.agentAuthorizationRevision,
    committerDeviceId: domain.committerDeviceId,
  }));
  const liveState = input.authorization.currentState;
  if (
    input.authorization.purpose
      !== "persist-agent-runtime-authorization-transition"
    || (
      fingerprint(liveState) !== fingerprint(input.expected.runtime)
      && fingerprint(liveState) !== fingerprint(input.intended.runtime)
    )
    || fingerprint(input.intended.runtime)
      !== fingerprint(input.authorization.nextState)
    || fingerprint(intendedDomains)
      !== fingerprint(input.authorization.remainingDomains)
  ) {
    throw new TypeError(
      "Agent Runtime authorization transition authority does not match its write set",
    );
  }
  const privateSnapshot = cloneAuthorizationTransition(input);
  const authorized = Object.freeze(
    cloneAuthorizationTransition(privateSnapshot),
  ) as AuthorizedAgentRuntimeAuthorizationTransitionWriteV2;
  authorizationTransitions.set(authorized, Object.freeze({
    ...privateSnapshot,
    fingerprint: fingerprint(authorized),
  }));
  return authorized;
}

export function consumeAuthorizedAgentRuntimeAuthorizationTransitionWriteV2(
  value: AuthorizedAgentRuntimeAuthorizationTransitionWriteV2,
): Readonly<{
  expected: AgentRuntimeAtomicStorageStateV2;
  intended: AgentRuntimeAtomicStorageStateV2;
  authorization: AgentRuntimeAuthorizationTransitionWriteAuthorizationV2;
  signerPublication: AgentRuntimeSignerPublicationV1;
}> {
  const capability = typeof value === "object" && value !== null
    ? value as object
    : null;
  const snapshot = capability === null
    ? undefined
    : authorizationTransitions.get(capability);
  if (capability !== null) authorizationTransitions.delete(capability);
  if (
    snapshot === undefined
    || typeof value !== "object"
    || value === null
    || Object.keys(value).length !== 4
    || !Object.hasOwn(value, "expected")
    || !Object.hasOwn(value, "intended")
    || !Object.hasOwn(value, "authorization")
    || !Object.hasOwn(value, "signerPublication")
    || fingerprint(value) !== snapshot.fingerprint
  ) {
    throw new TypeError(
      "Agent Runtime authorization transition CAS requires an authorized write capability",
    );
  }
  return Object.freeze(cloneAuthorizationTransition(snapshot));
}
