import {
  LATTICE_LIMITS,
  coordinateGrantUse,
  portableIdIsValid,
  preflightGrantUse,
  type AgentId,
  type GrantOperationAuthorization,
  type GrantUseAuthorizationContext,
  type GrantUseAuthorizationDecision,
  type LatticeCrypto,
  type LatticeStorage,
  type OpenedGrantDomain,
  type ResolveCurrentGrantUseAuthorization,
} from "@nautilo/lattice-crypto";
import {
  parseGrantV2,
  type GrantOperationV2,
  type GrantV2,
} from "@nautilo/lattice-crypto/wire";
import {
  coordinateGrantAuthoritySetUse,
  preflightGrantAuthoritySetUse,
  type GrantAuthoritySetAuthorization,
  type GrantAuthoritySetExecutionEvidence,
  type OpenedGrantAuthoritySet,
  type ResolveCurrentGrantAuthoritySetUseAuthorization,
} from "@nautilo/lattice-crypto";

declare const protectedInvocationRecipientBrand: unique symbol;
declare const foregroundRuntimeRecipientBrand: unique symbol;
declare const protectedInvocationCapabilityBrand: unique symbol;
declare const protectedInvocationLeaseBrand: unique symbol;

export type ProtectedInvocationRecipient = Readonly<{
  readonly recipientAgentId: AgentId;
  readonly recipientKeyId: string;
  readonly [protectedInvocationRecipientBrand]: true;
}>;

/**
 * Ephemeral HPKE recipient for one bounded Nautilo foreground Runtime.
 *
 * Unlike the historical ProtectedInvocationRecipient, this object is not an
 * Agent persona.  Product Agent identity is bound later by the execution work
 * descriptor; this recipient owns only process-local content-key custody.
 */
export type ForegroundRuntimeRecipient = Readonly<{
  readonly recipientKind: "nautilo_foreground_runtime";
  readonly recipientKeyId: string;
  readonly [foregroundRuntimeRecipientBrand]: true;
}>;

export type EphemeralForegroundRecipient =
  | ProtectedInvocationRecipient
  | ForegroundRuntimeRecipient;

type ProtectedInvocationRecipientSecret = {
  readonly privateKey: Uint8Array;
};

const recipientSecrets =
  new WeakMap<object, ProtectedInvocationRecipientSecret>();

export type ProtectedInvocationCapability = Readonly<{
  readonly invocationId: string;
  readonly expiresAt: number;
  readonly [protectedInvocationCapabilityBrand]: true;
}>;

export type ProtectedInvocationLease = Readonly<{
  readonly invocationId: string;
  readonly leaseId: string;
  readonly [protectedInvocationLeaseBrand]: true;
}>;

export type ProtectedInvocationCoordinates = Readonly<{
  readonly invocationId: string;
  readonly grantId: string;
  readonly issuingHumanId: string;
  readonly recipientAgentId: string;
  readonly recipientKeyId: string;
  readonly issuingDeviceId: string;
  readonly namespaceIds: readonly string[];
  readonly domainIds: readonly string[];
  readonly issuedAt: number;
  readonly expiresAt: number;
}>;

export type ProtectedInvocationCapabilityDescription = Readonly<{
  readonly invocationId: string;
  readonly grantId: string;
  readonly expiresAt: number;
  readonly issuedAt: number;
  readonly issuingHumanId: string;
  readonly issuingDeviceId: string;
  readonly recipientAgentId: string;
  readonly recipientKeyId: string;
  readonly namespaceIds: readonly string[];
  readonly domainIds: readonly string[];
}>;

type ProtectedInvocationCapabilityState = {
  readonly coordinates: ProtectedInvocationCoordinates;
  readonly recipient: ProtectedInvocationRecipient;
  readonly description: ProtectedInvocationCapabilityDescription;
  readonly workDescriptorHash: Uint8Array | null;
};

const capabilityStates =
  new WeakMap<object, ProtectedInvocationCapabilityState>();
const boundRecipients = new WeakSet<object>();

export type ProtectedGrantOperationFacts = Omit<
  GrantOperationAuthorization,
  "recipientEncryptionPrivateKey"
>;

export type ProtectedGrantAuthorityPort = Readonly<{
  readonly resolvePreflightFacts: (request: Readonly<{
    readonly phase: "preflight";
    readonly coordinates: ProtectedInvocationCoordinates;
    readonly operation: GrantOperationV2;
  }>) =>
    | ProtectedGrantOperationFacts
    | null
    | Promise<ProtectedGrantOperationFacts | null>;
  readonly resolveCurrentAuthorization:
    ResolveCurrentGrantUseAuthorization;
}>;

export type ProtectedGrantAuthoritySetFactsV2 = Omit<
  GrantAuthoritySetAuthorization,
  "recipientEncryptionPrivateKey"
>;

export type ProtectedGrantAuthoritySetPortV2 = Readonly<{
  readonly resolvePreflightFacts: (request: Readonly<{
    readonly phase: "preflight";
    readonly coordinates: ProtectedInvocationCoordinates;
  }>) =>
    | ProtectedGrantAuthoritySetFactsV2
    | null
    | Promise<ProtectedGrantAuthoritySetFactsV2 | null>;
  readonly resolveCurrentAuthorization:
    ResolveCurrentGrantAuthoritySetUseAuthorization;
}>;

export type ProtectedGrantUnavailableReason =
  | "coordinates_invalid"
  | "grant_missing"
  | "grant_consumed"
  | "grant_invalid"
  | "grant_not_reusable"
  | "recipient_unavailable"
  | "authorization_unavailable";

export type ProtectedGrantOperationResult<Value> =
  | Readonly<{
    readonly status: "executed";
    readonly value: Value;
  }>
  | Readonly<{
    readonly status: "unavailable";
    readonly reason: ProtectedGrantUnavailableReason;
  }>;

function unavailable(
  reason: ProtectedGrantUnavailableReason,
): ProtectedGrantOperationResult<never> {
  return Object.freeze({ status: "unavailable", reason });
}

function isPortableText(value: unknown): value is string {
  return portableIdIsValid(value);
}

function canonicalIds(
  values: readonly string[],
  maximum: number,
): readonly string[] | null {
  if (!Array.isArray(values) || values.length === 0 || values.length > maximum) {
    return null;
  }
  if (!values.every(isPortableText)) return null;
  const canonical = [...new Set(values)].sort();
  if (
    canonical.length !== values.length
    || canonical.some((value, index) => value !== values[index])
  ) {
    return null;
  }
  return Object.freeze(canonical);
}

function snapshotCoordinates(
  value: ProtectedInvocationCoordinates,
): ProtectedInvocationCoordinates | null {
  if (
    typeof value !== "object"
    || value === null
    || !isPortableText(value.invocationId)
    || !isPortableText(value.grantId)
    || !isPortableText(value.issuingHumanId)
    || !isPortableText(value.recipientAgentId)
    || !isPortableText(value.recipientKeyId)
    || !isPortableText(value.issuingDeviceId)
    || !Number.isSafeInteger(value.issuedAt)
    || !Number.isSafeInteger(value.expiresAt)
    || value.issuedAt < 0
    || value.expiresAt <= value.issuedAt
  ) {
    return null;
  }
  const namespaceIds = canonicalIds(
    value.namespaceIds,
    LATTICE_LIMITS.agentGrantDomains,
  );
  const domainIds = canonicalIds(
    value.domainIds,
    LATTICE_LIMITS.agentGrantDomains,
  );
  if (namespaceIds === null || domainIds === null) return null;

  return Object.freeze({
    invocationId: value.invocationId,
    grantId: value.grantId,
    issuingHumanId: value.issuingHumanId,
    recipientAgentId: value.recipientAgentId,
    recipientKeyId: value.recipientKeyId,
    issuingDeviceId: value.issuingDeviceId,
    namespaceIds,
    domainIds,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  });
}

function grantMatchesCoordinates(
  grant: GrantV2,
  coordinates: ProtectedInvocationCoordinates,
  operation: GrantOperationV2,
): boolean {
  const coveredDomainIds = new Set<string>(
    grant.coveredDomains.map((domain) => domain.domainId),
  );
  return (
    grant.id === coordinates.grantId
    && grant.recipientAgentId === coordinates.recipientAgentId
    && grant.recipientKeyId === coordinates.recipientKeyId
    && grant.issuingDeviceId === coordinates.issuingDeviceId
    && grant.issuedAt === coordinates.issuedAt
    && grant.expiresAt === coordinates.expiresAt
    && grant.operations.includes(operation)
    && coordinates.domainIds.every((domainId) =>
      coveredDomainIds.has(domainId)
    )
  );
}

function factsMatchRequest(
  facts: ProtectedGrantOperationFacts,
  coordinates: ProtectedInvocationCoordinates,
  operation: GrantOperationV2,
  exactTarget?: Readonly<{
    readonly namespaceId: string;
    readonly domainId: string;
  }>,
): boolean {
  return (
    facts.expectedIssuingDeviceId === coordinates.issuingDeviceId
    && facts.issuingDeviceHumanId === coordinates.issuingHumanId
    && facts.recipientAgentId === coordinates.recipientAgentId
    && facts.recipientKeyId === coordinates.recipientKeyId
    && facts.operation === operation
    && coordinates.namespaceIds.includes(facts.namespaceId)
    && coordinates.domainIds.includes(facts.domainId)
    && (
      exactTarget === undefined
      || (
        facts.namespaceId === exactTarget.namespaceId
        && facts.domainId === exactTarget.domainId
      )
    )
  );
}

export async function createProtectedInvocationRecipient(input: Readonly<{
  readonly crypto: LatticeCrypto;
  readonly recipientAgentId: AgentId;
  readonly recipientKeyId: string;
}>): Promise<Readonly<{
  readonly recipient: ProtectedInvocationRecipient;
  readonly publicKey: Uint8Array;
}>> {
  if (!isPortableText(input.recipientAgentId)) {
    throw new TypeError("Protected invocation recipient Agent id is invalid");
  }
  if (!isPortableText(input.recipientKeyId)) {
    throw new TypeError("Protected invocation recipient key id is invalid");
  }
  const keyPair = await input.crypto.generateEncryptionKeyPair();
  const privateKey = keyPair.privateKey.slice();
  keyPair.privateKey.fill(0);
  const recipient = Object.freeze({
    recipientAgentId: input.recipientAgentId,
    recipientKeyId: input.recipientKeyId,
  }) as ProtectedInvocationRecipient;
  recipientSecrets.set(recipient, { privateKey });
  return Object.freeze({
    recipient,
    publicKey: keyPair.publicKey.slice(),
  });
}

/**
 * Admit an externally generated ephemeral HPKE pair into the same opaque
 * recipient boundary. A self-seal/open proof rejects substituted or malformed
 * pairs before the private scalar enters process-local custody.
 */
export async function authenticateProtectedInvocationRecipientKeyPair(input: Readonly<{
  readonly crypto: LatticeCrypto;
  readonly recipientAgentId: AgentId;
  readonly recipientKeyId: string;
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}>): Promise<ProtectedInvocationRecipient> {
  if (!isPortableText(input.recipientAgentId)) {
    throw new TypeError("Protected invocation recipient Agent id is invalid");
  }
  if (!isPortableText(input.recipientKeyId)) {
    throw new TypeError("Protected invocation recipient key id is invalid");
  }
  const challenge = input.crypto.randomBytes(32);
  let sealed: Uint8Array | undefined;
  let opened: Uint8Array | null | undefined;
  try {
    sealed = await input.crypto.sealTo(input.publicKey, challenge);
    opened = await input.crypto.openSealed(input.privateKey, sealed);
    if (
      opened === null
      || opened.length !== challenge.length
      || opened.some((byte, index) => byte !== challenge[index])
    ) throw new TypeError("Protected invocation recipient key pair is invalid");
    const recipient = Object.freeze({
      recipientAgentId: input.recipientAgentId,
      recipientKeyId: input.recipientKeyId,
    }) as ProtectedInvocationRecipient;
    recipientSecrets.set(recipient, { privateKey: input.privateKey.slice() });
    return recipient;
  } finally {
    challenge.fill(0);
    sealed?.fill(0);
    opened?.fill(0);
  }
}

/** Admit a fresh externally generated Runtime HPKE pair into opaque custody. */
export async function authenticateForegroundRuntimeRecipientKeyPair(input: Readonly<{
  readonly crypto: LatticeCrypto;
  readonly recipientKind: "nautilo_foreground_runtime";
  readonly recipientKeyId: string;
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}>): Promise<ForegroundRuntimeRecipient> {
  if (input.recipientKind !== "nautilo_foreground_runtime") {
    throw new TypeError("Foreground Runtime recipient kind is invalid");
  }
  if (!isPortableText(input.recipientKeyId)) {
    throw new TypeError("Foreground Runtime recipient key id is invalid");
  }
  const challenge = input.crypto.randomBytes(32);
  let sealed: Uint8Array | undefined;
  let opened: Uint8Array | null | undefined;
  try {
    sealed = await input.crypto.sealTo(input.publicKey, challenge);
    opened = await input.crypto.openSealed(input.privateKey, sealed);
    if (
      opened === null
      || opened.length !== challenge.length
      || opened.some((byte, index) => byte !== challenge[index])
    ) throw new TypeError("Foreground Runtime recipient key pair is invalid");
    const recipient = Object.freeze({
      recipientKind: input.recipientKind,
      recipientKeyId: input.recipientKeyId,
    }) as ForegroundRuntimeRecipient;
    recipientSecrets.set(recipient, { privateKey: input.privateKey.slice() });
    return recipient;
  } finally {
    challenge.fill(0);
    sealed?.fill(0);
    opened?.fill(0);
  }
}

export function destroyProtectedInvocationRecipient(
  recipient: EphemeralForegroundRecipient,
): void {
  const secret = recipientSecrets.get(recipient);
  if (secret === undefined) return;
  secret.privateKey.fill(0);
  recipientSecrets.delete(recipient);
}

/**
 * Lend an authenticated process-local HPKE private key to one callback. This
 * is the narrow adapter used by current foreground Domain authorization;
 * callers never receive the stored key itself and every callback copy is
 * wiped on exit.
 */
export async function withProtectedInvocationRecipientPrivateKey<Value>(
  recipient: EphemeralForegroundRecipient,
  use: (privateKey: Uint8Array) => Promise<Value> | Value,
): Promise<Value | null> {
  const secret = recipientSecrets.get(recipient);
  if (secret === undefined || boundRecipients.has(recipient)) return null;
  const privateKey = secret.privateKey.slice();
  try {
    return await use(privateKey);
  } finally {
    privateKey.fill(0);
  }
}

export function createProtectedInvocationCapability(input: Readonly<{
  readonly coordinates: ProtectedInvocationCoordinates;
  readonly recipient: ProtectedInvocationRecipient;
  /**
   * Verified background descriptor hash. Foreground/v1 capabilities omit it;
   * terminal background ports fail closed when it is absent.
   */
  readonly workDescriptorHash?: Uint8Array;
}>): ProtectedInvocationCapability {
  const coordinates = snapshotCoordinates(input.coordinates);
  if (coordinates === null) {
    throw new TypeError("Protected invocation coordinates are invalid");
  }
  if (
    !recipientSecrets.has(input.recipient)
    || input.recipient.recipientAgentId !== coordinates.recipientAgentId
    || input.recipient.recipientKeyId !== coordinates.recipientKeyId
  ) {
    throw new TypeError("Protected invocation recipient is unavailable");
  }
  if (boundRecipients.has(input.recipient)) {
    throw new TypeError("Protected invocation recipient is already bound");
  }
  if (
    input.workDescriptorHash !== undefined
    && (!(input.workDescriptorHash instanceof Uint8Array)
      || input.workDescriptorHash.length !== 32)
  ) throw new TypeError("Protected work descriptor hash is invalid");
  const workDescriptorHash = input.workDescriptorHash === undefined
    ? null
    : Uint8Array.from(input.workDescriptorHash);

  const capability = Object.freeze({
    invocationId: coordinates.invocationId,
    expiresAt: coordinates.expiresAt,
  }) as ProtectedInvocationCapability;
  const description = Object.freeze({
    invocationId: coordinates.invocationId,
    grantId: coordinates.grantId,
    expiresAt: coordinates.expiresAt,
    issuedAt: coordinates.issuedAt,
    issuingHumanId: coordinates.issuingHumanId,
    issuingDeviceId: coordinates.issuingDeviceId,
    recipientAgentId: coordinates.recipientAgentId,
    recipientKeyId: coordinates.recipientKeyId,
    namespaceIds: coordinates.namespaceIds,
    domainIds: coordinates.domainIds,
  });
  capabilityStates.set(capability, {
    coordinates,
    recipient: input.recipient,
    description,
    workDescriptorHash,
  });
  boundRecipients.add(input.recipient);
  return capability;
}

export function inspectProtectedInvocationCapability(
  capability: ProtectedInvocationCapability,
): ProtectedInvocationCapabilityDescription | null {
  const state = capabilityStates.get(capability);
  if (
    state === undefined
    || !recipientSecrets.has(state.recipient)
  ) {
    return null;
  }
  return state.description;
}

/** Check a terminal capability against its device-verified descriptor. */
export function protectedInvocationCapabilityMatchesWorkDescriptor(
  capability: ProtectedInvocationCapability,
  descriptorHash: Uint8Array,
): boolean {
  const expected = capabilityStates.get(capability)?.workDescriptorHash;
  if (
    expected === undefined
    || expected === null
    || !(descriptorHash instanceof Uint8Array)
    || descriptorHash.length !== expected.length
  ) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected[index]! ^ descriptorHash[index]!;
  }
  return difference === 0;
}

export function destroyProtectedInvocationCapability(
  capability: ProtectedInvocationCapability,
): void {
  const state = capabilityStates.get(capability);
  if (state === undefined) return;
  capabilityStates.delete(capability);
  state.workDescriptorHash?.fill(0);
  destroyProtectedInvocationRecipient(state.recipient);
}

function authorizationWithRecipient(
  facts: ProtectedGrantOperationFacts,
  privateKey: Uint8Array,
): GrantOperationAuthorization {
  return Object.freeze({
    ...facts,
    recipientEncryptionPrivateKey: privateKey,
  });
}

function authoritySetAuthorizationWithRecipient(
  facts: ProtectedGrantAuthoritySetFactsV2,
  privateKey: Uint8Array,
): GrantAuthoritySetAuthorization {
  return Object.freeze({
    ...facts,
    recipientEncryptionPrivateKey: privateKey,
  });
}

function grantMatchesAuthoritySetCoordinates(
  grant: GrantV2,
  coordinates: ProtectedInvocationCoordinates,
): boolean {
  return grant.id === coordinates.grantId
    && grant.recipientAgentId === coordinates.recipientAgentId
    && grant.recipientKeyId === coordinates.recipientKeyId
    && grant.issuingDeviceId === coordinates.issuingDeviceId
    && grant.issuedAt === coordinates.issuedAt
    && grant.expiresAt === coordinates.expiresAt
    && JSON.stringify(grant.coveredDomains.map((entry) => entry.domainId))
      === JSON.stringify(coordinates.domainIds);
}

function authoritySetFactsMatchCoordinates(
  facts: ProtectedGrantAuthoritySetFactsV2,
  coordinates: ProtectedInvocationCoordinates,
): boolean {
  return facts.expectedIssuingDeviceId === coordinates.issuingDeviceId
    && facts.issuingDeviceHumanId === coordinates.issuingHumanId
    && facts.recipientAgentId === coordinates.recipientAgentId
    && facts.recipientKeyId === coordinates.recipientKeyId
    && JSON.stringify(
      facts.namespaceRequirements.map((entry) => entry.namespaceId),
    ) === JSON.stringify(coordinates.namespaceIds)
    && JSON.stringify(
      facts.domainRequirements.map((entry) => entry.domainId),
    ) === JSON.stringify(coordinates.domainIds);
}

function loadCanonicalGrant(
  record: Awaited<ReturnType<LatticeStorage["getGrant"]>>,
): GrantV2 | null {
  if (record === null) return null;
  const parsed = parseGrantV2(record.grantBytes);
  if (parsed === null || parsed.id !== record.grantId) return null;
  return parsed;
}

type ProtectedGrantOperationInput<Value> = Readonly<{
  readonly crypto: LatticeCrypto;
  readonly storage: Pick<LatticeStorage, "getGrant" | "consumeGrant">;
  readonly coordinates: ProtectedInvocationCoordinates;
  readonly recipient: ProtectedInvocationRecipient;
  readonly operation: GrantOperationV2;
  readonly authority: ProtectedGrantAuthorityPort;
  readonly exactTarget?: Readonly<{
    readonly namespaceId: string;
    readonly domainId: string;
  }>;
  readonly execute: (
    opened: OpenedGrantDomain,
  ) => Value | PromiseLike<Value>;
}>;

async function executeProtectedGrantOperationInternal<Value>(
  input: ProtectedGrantOperationInput<Value>,
  requireReusable: boolean,
): Promise<ProtectedGrantOperationResult<Value>> {
  const coordinates = snapshotCoordinates(input.coordinates);
  if (coordinates === null) return unavailable("coordinates_invalid");

  const recipientSecret = recipientSecrets.get(input.recipient);
  if (
    recipientSecret === undefined
    || input.recipient.recipientAgentId !== coordinates.recipientAgentId
    || input.recipient.recipientKeyId !== coordinates.recipientKeyId
  ) {
    return unavailable("recipient_unavailable");
  }

  const record = await input.storage.getGrant(coordinates.grantId);
  if (record === null) return unavailable("grant_missing");
  if (record.consumed) return unavailable("grant_consumed");
  const grant = loadCanonicalGrant(record);
  if (
    grant === null
    || !grantMatchesCoordinates(grant, coordinates, input.operation)
  ) {
    return unavailable("grant_invalid");
  }
  if (requireReusable && grant.singleUse) {
    return unavailable("grant_not_reusable");
  }

  const facts = await input.authority.resolvePreflightFacts({
    phase: "preflight",
    coordinates,
    operation: input.operation,
  });
  if (
    facts === null
    || !factsMatchRequest(
      facts,
      coordinates,
      input.operation,
      input.exactTarget,
    )
  ) {
    return unavailable("authorization_unavailable");
  }

  const preflight = await preflightGrantUse(
    input.crypto,
    grant,
    authorizationWithRecipient(facts, recipientSecret.privateKey),
  );
  if (preflight === null) {
    return unavailable("authorization_unavailable");
  }

  const result = await coordinateGrantUse({
    preflight,
    storage: input.storage,
    resolveCurrentAuthorization:
      input.authority.resolveCurrentAuthorization,
    execute: input.execute,
  });
  if (result.status === "unavailable") {
    return unavailable("authorization_unavailable");
  }
  return Object.freeze({
    status: "executed",
    value: result.value,
  });
}

export function executeProtectedGrantOperation<Value>(
  input: ProtectedGrantOperationInput<Value>,
): Promise<ProtectedGrantOperationResult<Value>> {
  return executeProtectedGrantOperationInternal(input, false);
}

/**
 * Execute one complete multi-Domain background authority set through a
 * single-use invocation capability. The set is preflighted and claimed once;
 * every opened root remains inside this bridge callback and is wiped by the
 * lattice coordinator on every exit path.
 */
export async function executeProtectedGrantAuthoritySetCapabilityOperationV2<
  Value,
>(input: Readonly<{
  readonly capability: ProtectedInvocationCapability;
  readonly crypto: LatticeCrypto;
  readonly storage: Pick<LatticeStorage, "getGrant" | "consumeGrant">;
  readonly authority: ProtectedGrantAuthoritySetPortV2;
  readonly execute: (
    opened: OpenedGrantAuthoritySet,
    evidence: GrantAuthoritySetExecutionEvidence,
  ) => Value | PromiseLike<Value>;
}>): Promise<ProtectedGrantOperationResult<Value>> {
  const state = capabilityStates.get(input.capability);
  if (state === undefined) return unavailable("recipient_unavailable");
  try {
    const recipientSecret = recipientSecrets.get(state.recipient);
    if (recipientSecret === undefined) {
      return unavailable("recipient_unavailable");
    }
    const record = await input.storage.getGrant(state.coordinates.grantId);
    if (record === null) return unavailable("grant_missing");
    if (record.consumed) return unavailable("grant_consumed");
    const grant = loadCanonicalGrant(record);
    if (
      grant === null
      || !grantMatchesAuthoritySetCoordinates(grant, state.coordinates)
    ) return unavailable("grant_invalid");
    const facts = await input.authority.resolvePreflightFacts({
      phase: "preflight",
      coordinates: state.coordinates,
    });
    if (
      facts === null
      || !authoritySetFactsMatchCoordinates(facts, state.coordinates)
    ) return unavailable("authorization_unavailable");
    const preflight = await preflightGrantAuthoritySetUse(
      input.crypto,
      grant,
      authoritySetAuthorizationWithRecipient(
        facts,
        recipientSecret.privateKey,
      ),
    );
    if (preflight === null) return unavailable("authorization_unavailable");
    const result = await coordinateGrantAuthoritySetUse({
      preflight,
      storage: input.storage,
      resolveCurrentAuthorization:
        input.authority.resolveCurrentAuthorization,
      execute: input.execute,
    });
    return result.status === "unavailable"
      ? unavailable("authorization_unavailable")
      : Object.freeze({ status: "executed", value: result.value });
  } finally {
    destroyProtectedInvocationCapability(input.capability);
  }
}

/**
 * Execute one complete multi-Domain authority set through a reusable
 * foreground-session capability. Every call repeats exact Grant preflight and
 * current-authorization resolution. The core coordinator owns and wipes all
 * opened Domain roots; this function deliberately leaves the recipient
 * capability alive for its owning foreground-session registry to terminate.
 */
export async function executeProtectedGrantSessionAuthoritySetCapabilityOperationV2<
  Value,
>(input: Readonly<{
  readonly capability: ProtectedInvocationCapability;
  readonly crypto: LatticeCrypto;
  readonly storage: Pick<LatticeStorage, "getGrant" | "consumeGrant">;
  readonly authority: ProtectedGrantAuthoritySetPortV2;
  readonly execute: (
    opened: OpenedGrantAuthoritySet,
    evidence: GrantAuthoritySetExecutionEvidence,
  ) => Value | PromiseLike<Value>;
}>): Promise<ProtectedGrantOperationResult<Value>> {
  const state = capabilityStates.get(input.capability);
  if (state === undefined) return unavailable("recipient_unavailable");
  const recipientSecret = recipientSecrets.get(state.recipient);
  if (recipientSecret === undefined) {
    return unavailable("recipient_unavailable");
  }
  const record = await input.storage.getGrant(state.coordinates.grantId);
  if (record === null) return unavailable("grant_missing");
  if (record.consumed) return unavailable("grant_consumed");
  const grant = loadCanonicalGrant(record);
  if (
    grant === null
    || !grantMatchesAuthoritySetCoordinates(grant, state.coordinates)
  ) return unavailable("grant_invalid");
  if (grant.singleUse) return unavailable("grant_not_reusable");
  const facts = await input.authority.resolvePreflightFacts({
    phase: "preflight",
    coordinates: state.coordinates,
  });
  if (
    facts === null
    || !authoritySetFactsMatchCoordinates(facts, state.coordinates)
  ) return unavailable("authorization_unavailable");
  const preflight = await preflightGrantAuthoritySetUse(
    input.crypto,
    grant,
    authoritySetAuthorizationWithRecipient(
      facts,
      recipientSecret.privateKey,
    ),
  );
  if (preflight === null) return unavailable("authorization_unavailable");
  const result = await coordinateGrantAuthoritySetUse({
    preflight,
    storage: input.storage,
    resolveCurrentAuthorization:
      input.authority.resolveCurrentAuthorization,
    execute: input.execute,
  });
  return result.status === "unavailable"
    ? unavailable("authorization_unavailable")
    : Object.freeze({ status: "executed", value: result.value });
}

export async function executeProtectedGrantCapabilityOperation<Value>(
  input: Readonly<{
    readonly capability: ProtectedInvocationCapability;
    readonly crypto: LatticeCrypto;
    readonly storage: Pick<LatticeStorage, "getGrant" | "consumeGrant">;
    readonly operation: GrantOperationV2;
    readonly authority: ProtectedGrantAuthorityPort;
    readonly execute: (
      opened: OpenedGrantDomain,
    ) => Value | PromiseLike<Value>;
  }>,
): Promise<ProtectedGrantOperationResult<Value>> {
  const state = capabilityStates.get(input.capability);
  if (state === undefined) return unavailable("recipient_unavailable");
  try {
    return await executeProtectedGrantOperation({
      crypto: input.crypto,
      storage: input.storage,
      coordinates: state.coordinates,
      recipient: state.recipient,
      operation: input.operation,
      authority: input.authority,
      execute: input.execute,
    });
  } finally {
    destroyProtectedInvocationCapability(input.capability);
  }
}

/**
 * Execute one operation through a reusable, process-local recipient
 * capability. The signed Grant must explicitly be reusable. Only recipient
 * custody survives between calls: every call repeats Grant preflight and
 * current-authorization resolution, while the core coordinator wipes the
 * opened Domain root on callback exit.
 *
 * The owning foreground-session registry must destroy the capability on
 * expiry, revocation, cancellation, process shutdown, or abandonment.
 */
export async function executeProtectedGrantSessionCapabilityOperation<Value>(
  input: Readonly<{
    readonly capability: ProtectedInvocationCapability;
    readonly crypto: LatticeCrypto;
    readonly storage: Pick<LatticeStorage, "getGrant" | "consumeGrant">;
    readonly operation: GrantOperationV2;
    readonly namespaceId: string;
    readonly domainId: string;
    readonly authority: ProtectedGrantAuthorityPort;
    readonly execute: (
      opened: OpenedGrantDomain,
    ) => Value | PromiseLike<Value>;
  }>,
): Promise<ProtectedGrantOperationResult<Value>> {
  const state = capabilityStates.get(input.capability);
  if (state === undefined) return unavailable("recipient_unavailable");
  return executeProtectedGrantOperationInternal({
    crypto: input.crypto,
    storage: input.storage,
    coordinates: state.coordinates,
    recipient: state.recipient,
    operation: input.operation,
    exactTarget: Object.freeze({
      namespaceId: input.namespaceId,
      domainId: input.domainId,
    }),
    authority: input.authority,
    execute: input.execute,
  }, true);
}

export type {
  GrantOperationV2 as ProtectedGrantOperation,
  GrantUseAuthorizationContext,
  GrantUseAuthorizationDecision,
};
