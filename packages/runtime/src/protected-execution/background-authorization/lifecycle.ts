const BACKGROUND_AUTHORIZATION_FORMAT_VERSION_V1 = 1 as const;
export const BACKGROUND_AUTHORIZATION_FORMAT_VERSION_V2 = 2 as const;
export const BACKGROUND_AUTHORIZATION_FORMAT_VERSION_V3 = 3 as const;
/** Compatibility name retained for the shipped Wave 10 lifecycle. */
export const BACKGROUND_AUTHORIZATION_FORMAT_VERSION =
  BACKGROUND_AUTHORIZATION_FORMAT_VERSION_V1;
export const BACKGROUND_AUTHORIZATION_MAX_IDENTIFIER_BYTES = 128;
export const BACKGROUND_AUTHORIZATION_MAX_GENERATION = 0xffff_ffff;
export const BACKGROUND_AUTHORIZATION_MAX_RETRY_COUNT = 8;
export const BACKGROUND_AUTHORIZATION_MAX_TIMESTAMP_MS =
  8_640_000_000_000_000;
export const BACKGROUND_AUTHORIZATION_RECIPIENT_PUBLIC_KEY_BYTES = 65;
export const BACKGROUND_AUTHORIZATION_MAX_TTL_MS = 10 * 60 * 1_000;
export const BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS = 2 * 60 * 1_000;

export const BACKGROUND_AUTHORIZATION_STATES = Object.freeze([
  "awaiting_recipient",
  "awaiting_device",
  "grant_ready",
  "claimed",
  "running",
  "publication_reconciliation",
  "completed",
  "cancelled",
  "terminal_failure",
] as const);

export type BackgroundAuthorizationState =
  (typeof BACKGROUND_AUTHORIZATION_STATES)[number];

export const BACKGROUND_AUTHORIZATION_RETRY_REASONS = Object.freeze([
  "attempt_expired",
  "claim_expired",
  "recipient_lost",
  "stale_authority",
  "key_unavailable",
  "provider_transient_failure",
  "publication_pending",
] as const);

export type BackgroundAuthorizationRetryReason =
  (typeof BACKGROUND_AUTHORIZATION_RETRY_REASONS)[number];

export const BACKGROUND_AUTHORIZATION_TERMINAL_REASONS = Object.freeze([
  "malformed_request",
  "integrity_failure",
  "provider_outcome_unknown",
  "policy_rejected",
  "unsupported_subject",
  "retry_limit_exhausted",
  "recipient_generation_exhausted",
  "cancelled",
  "superseded",
] as const);

export type BackgroundAuthorizationTerminalReason =
  (typeof BACKGROUND_AUTHORIZATION_TERMINAL_REASONS)[number];

export type BackgroundAuthorizationProcessorSubject = Readonly<{
  readonly kind: "processor";
  readonly processorKind: "stenographer";
  readonly processorVersion: 1;
  readonly authorizationRevision: number;
}>;

/** Current built-in processor identity. Room policy remains the authority. */
export type BackgroundAuthorizationProcessorSubjectV2 = Readonly<{
  readonly kind: "processor";
  readonly processorKind: "stenographer" | "reflection";
  readonly processorVersion: 1;
}>;

export type BackgroundAuthorizationAgentSubject = Readonly<{
  readonly kind: "agent";
  readonly agentId: string;
  readonly runtimeGeneration: number;
  readonly authorizationRevision: number;
}>;

export type BackgroundAuthorizationTaskRuntimeSubject = Readonly<{
  readonly kind: "runtime";
  readonly runtimeKind: "task";
  readonly runtimeVersion: 1;
}>;

export type BackgroundAuthorizationCredentialSubject =
  | BackgroundAuthorizationProcessorSubject
  | BackgroundAuthorizationAgentSubject;

type BackgroundAuthorizationAnyCredentialSubject =
  | BackgroundAuthorizationCredentialSubject
  | BackgroundAuthorizationProcessorSubjectV2
  | BackgroundAuthorizationTaskRuntimeSubject;

export type BackgroundAuthorizationAcceptedResponse = Readonly<{
  readonly kind: "processor" | "agent" | "runtime";
  readonly responseDigest: string;
  readonly credentialDigest: string;
  readonly issuingHumanId: string;
  readonly issuingDeviceId: string;
  readonly recipientGeneration: number;
  readonly acceptedAt: number;
}>;

/**
 * Public facts extracted from a cryptographically verified response. The
 * lifecycle compares every request/recipient coordinate before accepting the
 * response; credential-family adapters construct this DTO only after their
 * family-specific verification succeeds.
 */
export type BackgroundAuthorizationVerifiedResponse = Readonly<{
  readonly kind: "processor" | "agent" | "runtime";
  readonly requestId: string;
  readonly descriptorDigest: string;
  readonly recipientKeyId: string;
  readonly recipientPublicKey: string;
  readonly expiresAt: number;
  readonly responseDigest: string;
  readonly credentialDigest: string;
  readonly issuingHumanId: string;
  readonly issuingDeviceId: string;
  readonly recipientGeneration: number;
  readonly now: number;
}>;

export type BackgroundAuthorizationRecipient = Readonly<{
  readonly recipientKeyId: string;
  /** Canonical unpadded base64url public-key bytes. */
  readonly recipientPublicKey: string;
  readonly expiresAt: number;
}>;

type BackgroundAuthorizationRequestSnapshotFields = Readonly<{
  readonly requestId: string;
  readonly workId: string;
  readonly namespaceId: string;
  /**
   * Canonical lowercase hexadecimal encoding of an exact 32-byte digest.
   * Null only while no recipient-bound descriptor exists.
   */
  readonly descriptorDigest: string | null;
  readonly credentialSubject: BackgroundAuthorizationAnyCredentialSubject;
  readonly recipientGeneration: number;
  readonly recipient: BackgroundAuthorizationRecipient | null;
  readonly acceptedResponse: BackgroundAuthorizationAcceptedResponse | null;
  readonly state: BackgroundAuthorizationState;
  readonly claimId: string | null;
  readonly claimExpiresAt: number | null;
  readonly requestRevision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly retryCount: number;
  readonly lastRetryReason: BackgroundAuthorizationRetryReason | null;
  readonly nextAttemptAt: number | null;
  readonly terminalReason: BackgroundAuthorizationTerminalReason | null;
}>;

export type BackgroundAuthorizationRequestSnapshotV1 = Readonly<
  Omit<BackgroundAuthorizationRequestSnapshotFields, "credentialSubject"> & {
    readonly formatVersion: typeof BACKGROUND_AUTHORIZATION_FORMAT_VERSION_V1;
    readonly credentialSubject: BackgroundAuthorizationCredentialSubject;
  }
>;

export type BackgroundAuthorizationAgentRequestSnapshotV2 = Readonly<
  Omit<BackgroundAuthorizationRequestSnapshotFields, "credentialSubject"> & {
    readonly formatVersion: typeof BACKGROUND_AUTHORIZATION_FORMAT_VERSION_V2;
    readonly credentialSubject: BackgroundAuthorizationAgentSubject;
  }
>;

export type BackgroundAuthorizationProcessorRequestSnapshotV2 = Readonly<
  Omit<BackgroundAuthorizationRequestSnapshotFields, "credentialSubject"> & {
    readonly formatVersion: typeof BACKGROUND_AUTHORIZATION_FORMAT_VERSION_V2;
    readonly credentialSubject: BackgroundAuthorizationProcessorSubjectV2;
  }
>;

export type BackgroundAuthorizationRequestSnapshotV2 =
  | BackgroundAuthorizationAgentRequestSnapshotV2
  | BackgroundAuthorizationProcessorRequestSnapshotV2;

export type BackgroundAuthorizationProcessorRequestSnapshotV3 = Readonly<
  Omit<BackgroundAuthorizationRequestSnapshotFields, "credentialSubject"> & {
    readonly formatVersion: typeof BACKGROUND_AUTHORIZATION_FORMAT_VERSION_V3;
    readonly credentialSubject: BackgroundAuthorizationProcessorSubjectV2;
  }
>;

export type BackgroundAuthorizationTaskRuntimeRequestSnapshotV3 = Readonly<
  Omit<BackgroundAuthorizationRequestSnapshotFields, "credentialSubject"> & {
    readonly formatVersion: typeof BACKGROUND_AUTHORIZATION_FORMAT_VERSION_V3;
    readonly credentialSubject: BackgroundAuthorizationTaskRuntimeSubject;
  }
>;

export type BackgroundAuthorizationRequestSnapshotV3 =
  | BackgroundAuthorizationProcessorRequestSnapshotV3
  | BackgroundAuthorizationTaskRuntimeRequestSnapshotV3;

export type BackgroundAuthorizationRequestSnapshot =
  | BackgroundAuthorizationRequestSnapshotV1
  | BackgroundAuthorizationRequestSnapshotV2
  | BackgroundAuthorizationRequestSnapshotV3;

export type BackgroundAuthorizationTransitionErrorReason =
  | "attempt_not_expired"
  | "claim_expired"
  | "claim_not_expired"
  | "counter_exhausted"
  | "illegal_transition"
  | "recipient_not_due"
  | "stale_generation"
  | "terminal_state"
  | "timestamp_regression";

export class BackgroundAuthorizationTransitionError extends Error {
  readonly reason: BackgroundAuthorizationTransitionErrorReason;

  constructor(reason: BackgroundAuthorizationTransitionErrorReason) {
    super(reason);
    this.name = "BackgroundAuthorizationTransitionError";
    this.reason = reason;
  }
}

const STATE_SET = new Set<string>(BACKGROUND_AUTHORIZATION_STATES);
const RETRY_REASON_SET = new Set<string>(
  BACKGROUND_AUTHORIZATION_RETRY_REASONS,
);
const TERMINAL_REASON_SET = new Set<string>(
  BACKGROUND_AUTHORIZATION_TERMINAL_REASONS,
);
const REQUEST_FIELDS = Object.freeze([
  "acceptedResponse",
  "claimExpiresAt",
  "claimId",
  "createdAt",
  "credentialSubject",
  "descriptorDigest",
  "formatVersion",
  "lastRetryReason",
  "namespaceId",
  "nextAttemptAt",
  "recipient",
  "recipientGeneration",
  "requestId",
  "requestRevision",
  "retryCount",
  "state",
  "terminalReason",
  "updatedAt",
  "workId",
] as const);
const ACCEPTED_RESPONSE_FIELDS = Object.freeze([
  "acceptedAt",
  "credentialDigest",
  "issuingDeviceId",
  "issuingHumanId",
  "kind",
  "recipientGeneration",
  "responseDigest",
] as const);
const PROCESSOR_SUBJECT_FIELDS = Object.freeze([
  "authorizationRevision",
  "kind",
  "processorKind",
  "processorVersion",
] as const);
const PROCESSOR_SUBJECT_FIELDS_V2 = Object.freeze([
  "kind",
  "processorKind",
  "processorVersion",
] as const);
const AGENT_SUBJECT_FIELDS = Object.freeze([
  "agentId",
  "authorizationRevision",
  "kind",
  "runtimeGeneration",
] as const);
const RUNTIME_SUBJECT_FIELDS = Object.freeze([
  "kind",
  "runtimeKind",
  "runtimeVersion",
] as const);
const RECIPIENT_FIELDS = Object.freeze([
  "expiresAt",
  "recipientKeyId",
  "recipientPublicKey",
] as const);
const PORTABLE_IDENTIFIER_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

type UnknownSubjectFields = Record<string, unknown> & {
  kind?: unknown;
  processorKind?: unknown;
  processorVersion?: unknown;
  authorizationRevision?: unknown;
  agentId?: unknown;
  runtimeGeneration?: unknown;
  runtimeKind?: unknown;
  runtimeVersion?: unknown;
};

type UnknownRecipientFields = Record<string, unknown> & {
  expiresAt?: unknown;
  recipientKeyId?: unknown;
  recipientPublicKey?: unknown;
};

type UnknownRequestFields = Record<string, unknown> & {
  acceptedResponse?: unknown;
  claimExpiresAt?: unknown;
  claimId?: unknown;
  createdAt?: unknown;
  credentialSubject?: unknown;
  descriptorDigest?: unknown;
  formatVersion?: unknown;
  lastRetryReason?: unknown;
  namespaceId?: unknown;
  nextAttemptAt?: unknown;
  recipient?: unknown;
  recipientGeneration?: unknown;
  requestId?: unknown;
  requestRevision?: unknown;
  retryCount?: unknown;
  state?: unknown;
  terminalReason?: unknown;
  updatedAt?: unknown;
  workId?: unknown;
};

type UnknownAcceptedResponseFields = Record<string, unknown> & {
  acceptedAt?: unknown;
  credentialDigest?: unknown;
  issuingDeviceId?: unknown;
  issuingHumanId?: unknown;
  kind?: unknown;
  recipientGeneration?: unknown;
  responseDigest?: unknown;
};

function exactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === fields.length
    && actual.every((field, index) => field === fields[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= BACKGROUND_AUTHORIZATION_MAX_IDENTIFIER_BYTES
    && PORTABLE_IDENTIFIER_PATTERN.test(value);
}

function isBoundedCounter(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= 0
    && (value as number) <= maximum;
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= 0
    && (value as number) <= BACKGROUND_AUTHORIZATION_MAX_TIMESTAMP_MS;
}

function isDescriptorDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isCanonicalPublicKey(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 87
    || !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return false;
  }
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length ===
        BACKGROUND_AUTHORIZATION_RECIPIENT_PUBLIC_KEY_BYTES
      && decoded.toString("base64url") === value;
  } catch {
    return false;
  }
}

function parseSubject(
  value: unknown,
  formatVersion: 1 | 2 | 3,
): BackgroundAuthorizationAnyCredentialSubject {
  if (!isRecord(value)) {
    throw new TypeError("Invalid background authorization subject");
  }
  const subject = value as UnknownSubjectFields;
  if (typeof subject.kind !== "string") {
    throw new TypeError("Invalid background authorization subject");
  }
  if (subject.kind === "processor") {
    if (formatVersion !== BACKGROUND_AUTHORIZATION_FORMAT_VERSION_V1) {
      if (
        !exactFields(subject, PROCESSOR_SUBJECT_FIELDS_V2)
        || (subject.processorKind !== "stenographer" && subject.processorKind !== "reflection")
        || subject.processorVersion !== 1
      ) {
        throw new TypeError("Invalid background authorization processor subject");
      }
      return Object.freeze({
        kind: "processor",
        processorKind: subject.processorKind,
        processorVersion: 1,
      });
    }
    if (
      !exactFields(subject, PROCESSOR_SUBJECT_FIELDS)
      || subject.processorKind !== "stenographer"
      || subject.processorVersion !== 1
      || !isBoundedCounter(
        subject.authorizationRevision,
        BACKGROUND_AUTHORIZATION_MAX_GENERATION,
      )
    ) {
      throw new TypeError("Invalid background authorization processor subject");
    }
    return Object.freeze({
      kind: "processor",
      processorKind: "stenographer",
      processorVersion: 1,
      authorizationRevision: subject.authorizationRevision,
    });
  }
  if (subject.kind === "agent") {
    if (
      formatVersion === BACKGROUND_AUTHORIZATION_FORMAT_VERSION_V3
      || !exactFields(subject, AGENT_SUBJECT_FIELDS)
      || !isIdentifier(subject.agentId)
      || !isBoundedCounter(
        subject.runtimeGeneration,
        BACKGROUND_AUTHORIZATION_MAX_GENERATION,
      )
      || !isBoundedCounter(
        subject.authorizationRevision,
        BACKGROUND_AUTHORIZATION_MAX_GENERATION,
      )
    ) {
      throw new TypeError("Invalid background authorization Agent subject");
    }
    return Object.freeze({
      kind: "agent",
      agentId: subject.agentId,
      runtimeGeneration: subject.runtimeGeneration,
      authorizationRevision: subject.authorizationRevision,
    });
  }
  if (subject.kind === "runtime") {
    if (
      formatVersion !== BACKGROUND_AUTHORIZATION_FORMAT_VERSION_V3
      || !exactFields(subject, RUNTIME_SUBJECT_FIELDS)
      || subject.runtimeKind !== "task"
      || subject.runtimeVersion !== 1
    ) {
      throw new TypeError("Invalid background authorization Runtime subject");
    }
    return Object.freeze({
      kind: "runtime",
      runtimeKind: "task",
      runtimeVersion: 1,
    });
  }
  throw new TypeError("Unknown background authorization subject");
}

function parseRecipient(
  value: unknown,
): BackgroundAuthorizationRecipient | null {
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new TypeError("Invalid background authorization recipient");
  }
  const recipient = value as UnknownRecipientFields;
  if (
    !exactFields(recipient, RECIPIENT_FIELDS)
    || !isIdentifier(recipient.recipientKeyId)
    || !isCanonicalPublicKey(recipient.recipientPublicKey)
    || !isTimestamp(recipient.expiresAt)
  ) {
    throw new TypeError("Invalid background authorization recipient");
  }
  return Object.freeze({
    recipientKeyId: recipient.recipientKeyId,
    recipientPublicKey: recipient.recipientPublicKey,
    expiresAt: recipient.expiresAt,
  });
}

function parseAcceptedResponse(
  value: unknown,
): BackgroundAuthorizationAcceptedResponse | null {
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new TypeError("Invalid background authorization accepted response");
  }
  const response = value as UnknownAcceptedResponseFields;
  if (
    !exactFields(response, ACCEPTED_RESPONSE_FIELDS)
    || (
      response.kind !== "processor"
      && response.kind !== "agent"
      && response.kind !== "runtime"
    )
    || !isDescriptorDigest(response.responseDigest)
    || !isDescriptorDigest(response.credentialDigest)
    || !isIdentifier(response.issuingHumanId)
    || !isIdentifier(response.issuingDeviceId)
    || !isBoundedCounter(
      response.recipientGeneration,
      BACKGROUND_AUTHORIZATION_MAX_GENERATION,
    )
    || !isTimestamp(response.acceptedAt)
  ) {
    throw new TypeError("Invalid background authorization accepted response");
  }
  return Object.freeze({
    kind: response.kind,
    responseDigest: response.responseDigest,
    credentialDigest: response.credentialDigest,
    issuingHumanId: response.issuingHumanId,
    issuingDeviceId: response.issuingDeviceId,
    recipientGeneration: response.recipientGeneration,
    acceptedAt: response.acceptedAt,
  });
}

function assertStateConsistency(
  value: Readonly<{
    credentialSubject: BackgroundAuthorizationAnyCredentialSubject;
    state: BackgroundAuthorizationState;
    recipient: BackgroundAuthorizationRecipient | null;
    acceptedResponse: BackgroundAuthorizationAcceptedResponse | null;
    claimId: string | null;
    claimExpiresAt: number | null;
    descriptorDigest: string | null;
    recipientGeneration: number;
    retryCount: number;
    lastRetryReason: BackgroundAuthorizationRetryReason | null;
    nextAttemptAt: number | null;
    terminalReason: BackgroundAuthorizationTerminalReason | null;
    updatedAt: number;
  }>,
): void {
  const recipientRequired = value.state === "awaiting_device"
    || value.state === "grant_ready"
    || value.state === "claimed"
    || value.state === "running";
  if (recipientRequired !== (value.recipient !== null)) {
    throw new TypeError("Background authorization recipient/state mismatch");
  }
  if (
    (value.state === "awaiting_recipient" && value.descriptorDigest !== null)
    || (recipientRequired && value.descriptorDigest === null)
    || (value.state === "completed" && value.descriptorDigest === null)
  ) {
    throw new TypeError("Background authorization descriptor/state mismatch");
  }

  const acceptedResponseRequired = value.state === "grant_ready"
    || value.state === "claimed"
    || value.state === "running"
    || value.state === "publication_reconciliation"
    || value.state === "completed";
  if (
    (acceptedResponseRequired && value.acceptedResponse === null)
    || (
      (
        value.state === "awaiting_recipient"
        || value.state === "awaiting_device"
      )
      && value.acceptedResponse !== null
    )
    || (
      value.acceptedResponse !== null
      && (
        value.acceptedResponse.kind !== value.credentialSubject.kind
        || value.acceptedResponse.recipientGeneration
          !== value.recipientGeneration
        || value.acceptedResponse.acceptedAt > value.updatedAt
      )
    )
  ) {
    throw new TypeError(
      "Background authorization accepted response/state mismatch",
    );
  }
  if (
    value.recipient !== null
    && value.recipient.expiresAt <= value.updatedAt
  ) {
    throw new TypeError("Background authorization recipient is expired");
  }

  const claimRequired = value.state === "claimed"
    || value.state === "running";
  if (
    claimRequired !== (value.claimId !== null)
    || claimRequired !== (value.claimExpiresAt !== null)
  ) {
    throw new TypeError("Background authorization claim/state mismatch");
  }
  if (
    value.claimExpiresAt !== null
    && value.claimExpiresAt <= value.updatedAt
  ) {
    throw new TypeError("Background authorization claim is expired");
  }

  if (
    value.nextAttemptAt !== null
    && value.state !== "awaiting_recipient"
    && value.state !== "publication_reconciliation"
  ) {
    throw new TypeError("Background authorization retry/state mismatch");
  }
  if (
    (value.retryCount > 0 && value.lastRetryReason === null)
    || (
      value.state === "awaiting_recipient"
      && value.lastRetryReason !== null
      && value.nextAttemptAt === null
    )
    || (
      value.nextAttemptAt !== null
      && value.nextAttemptAt < value.updatedAt
    )
  ) {
    throw new TypeError("Background authorization retry history mismatch");
  }

  if (value.state === "terminal_failure") {
    if (
      value.terminalReason === null
      || value.terminalReason === "cancelled"
      || value.terminalReason === "superseded"
    ) {
      throw new TypeError("Background authorization terminal reason mismatch");
    }
  } else if (value.state === "cancelled") {
    if (
      value.terminalReason !== "cancelled"
      && value.terminalReason !== "superseded"
    ) {
      throw new TypeError("Background authorization cancellation mismatch");
    }
  } else if (value.terminalReason !== null) {
    throw new TypeError("Background authorization active state is terminal");
  }
}

export function parseBackgroundAuthorizationRequestSnapshot(
  value: unknown,
): BackgroundAuthorizationRequestSnapshot {
  if (!isRecord(value)) {
    throw new TypeError("Invalid background authorization request snapshot");
  }
  const request = value as UnknownRequestFields;
  if (
    !exactFields(request, REQUEST_FIELDS)
    || (
      request.formatVersion !== BACKGROUND_AUTHORIZATION_FORMAT_VERSION_V1
      && request.formatVersion !== BACKGROUND_AUTHORIZATION_FORMAT_VERSION_V2
      && request.formatVersion !== BACKGROUND_AUTHORIZATION_FORMAT_VERSION_V3
    )
    || !isIdentifier(request.requestId)
    || !isIdentifier(request.workId)
    || !isIdentifier(request.namespaceId)
    || (
      request.descriptorDigest !== null
      && !isDescriptorDigest(request.descriptorDigest)
    )
    || !isBoundedCounter(
      request.recipientGeneration,
      BACKGROUND_AUTHORIZATION_MAX_GENERATION,
    )
    || typeof request.state !== "string"
    || !STATE_SET.has(request.state)
    || (request.claimId !== null && !isIdentifier(request.claimId))
    || (
      request.claimExpiresAt !== null
      && !isTimestamp(request.claimExpiresAt)
    )
    || !isBoundedCounter(
      request.requestRevision,
      BACKGROUND_AUTHORIZATION_MAX_GENERATION,
    )
    || !isTimestamp(request.createdAt)
    || !isTimestamp(request.updatedAt)
    || request.updatedAt < request.createdAt
    || !isBoundedCounter(
      request.retryCount,
      BACKGROUND_AUTHORIZATION_MAX_RETRY_COUNT,
    )
    || (
      request.lastRetryReason !== null
      && (
        typeof request.lastRetryReason !== "string"
        || !RETRY_REASON_SET.has(request.lastRetryReason)
      )
    )
    || (
      request.nextAttemptAt !== null
      && !isTimestamp(request.nextAttemptAt)
    )
    || (
      request.terminalReason !== null
      && (
        typeof request.terminalReason !== "string"
        || !TERMINAL_REASON_SET.has(request.terminalReason)
      )
    )
  ) {
    throw new TypeError("Invalid background authorization request snapshot");
  }

  const credentialSubject = parseSubject(
    request.credentialSubject,
    request.formatVersion,
  );
  const recipient = parseRecipient(request.recipient);
  const acceptedResponse = parseAcceptedResponse(request.acceptedResponse);
  const snapshotFields = {
    requestId: request.requestId,
    workId: request.workId,
    namespaceId: request.namespaceId,
    descriptorDigest: request.descriptorDigest,
    credentialSubject,
    recipientGeneration: request.recipientGeneration,
    recipient,
    acceptedResponse,
    state: request.state as BackgroundAuthorizationState,
    claimId: request.claimId,
    claimExpiresAt: request.claimExpiresAt,
    requestRevision: request.requestRevision,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    retryCount: request.retryCount,
    lastRetryReason:
      request.lastRetryReason as BackgroundAuthorizationRetryReason | null,
    nextAttemptAt: request.nextAttemptAt,
    terminalReason:
      request.terminalReason as BackgroundAuthorizationTerminalReason | null,
  };
  const snapshot: BackgroundAuthorizationRequestSnapshot =
    request.formatVersion === BACKGROUND_AUTHORIZATION_FORMAT_VERSION_V3
      ? Object.freeze({
        ...snapshotFields,
        formatVersion: BACKGROUND_AUTHORIZATION_FORMAT_VERSION_V3,
        credentialSubject,
      }) as BackgroundAuthorizationRequestSnapshotV3
      : request.formatVersion === BACKGROUND_AUTHORIZATION_FORMAT_VERSION_V2
      ? Object.freeze({
        ...snapshotFields,
        formatVersion: BACKGROUND_AUTHORIZATION_FORMAT_VERSION_V2,
        credentialSubject,
      }) as BackgroundAuthorizationRequestSnapshotV2
      : Object.freeze({
        ...snapshotFields,
        formatVersion: BACKGROUND_AUTHORIZATION_FORMAT_VERSION_V1,
        credentialSubject:
          credentialSubject as BackgroundAuthorizationCredentialSubject,
      });
  assertStateConsistency(snapshot);
  return snapshot;
}

function update(
  value: BackgroundAuthorizationRequestSnapshot,
  fields: Partial<BackgroundAuthorizationRequestSnapshot>,
): BackgroundAuthorizationRequestSnapshot {
  if (
    value.requestRevision >= BACKGROUND_AUTHORIZATION_MAX_GENERATION
  ) {
    throw new BackgroundAuthorizationTransitionError("counter_exhausted");
  }
  return parseBackgroundAuthorizationRequestSnapshot({
    ...value,
    ...fields,
    requestRevision: value.requestRevision + 1,
  });
}

function assertActive(
  value: BackgroundAuthorizationRequestSnapshot,
): void {
  if (
    value.state === "completed"
    || value.state === "cancelled"
    || value.state === "terminal_failure"
  ) {
    throw new BackgroundAuthorizationTransitionError("terminal_state");
  }
}

function assertTime(
  value: BackgroundAuthorizationRequestSnapshot,
  now: number,
): void {
  if (!isTimestamp(now)) {
    throw new TypeError("Invalid background authorization timestamp");
  }
  if (now < value.updatedAt) {
    throw new BackgroundAuthorizationTransitionError("timestamp_regression");
  }
}

function assertState(
  value: BackgroundAuthorizationRequestSnapshot,
  expected: BackgroundAuthorizationState | readonly BackgroundAuthorizationState[],
): void {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(value.state)) {
    throw new BackgroundAuthorizationTransitionError("illegal_transition");
  }
}

export function createBackgroundAuthorizationRequest(
  input: Readonly<{
    readonly requestId: string;
    readonly workId: string;
    readonly namespaceId: string;
    readonly credentialSubject: BackgroundAuthorizationCredentialSubject;
    readonly now: number;
  }>,
): BackgroundAuthorizationRequestSnapshot {
  return parseBackgroundAuthorizationRequestSnapshot({
    formatVersion: BACKGROUND_AUTHORIZATION_FORMAT_VERSION,
    requestId: input.requestId,
    workId: input.workId,
    namespaceId: input.namespaceId,
    descriptorDigest: null,
    credentialSubject: input.credentialSubject,
    recipientGeneration: 0,
    recipient: null,
    acceptedResponse: null,
    state: "awaiting_recipient",
    claimId: null,
    claimExpiresAt: null,
    requestRevision: 0,
    createdAt: input.now,
    updatedAt: input.now,
    retryCount: 0,
    lastRetryReason: null,
    nextAttemptAt: null,
    terminalReason: null,
  });
}

export function createBackgroundAuthorizationRequestV2(
  input: Readonly<{
    readonly requestId: string;
    readonly workId: string;
    readonly namespaceId: string;
    readonly credentialSubject: BackgroundAuthorizationAgentSubject;
    readonly now: number;
  }>,
): BackgroundAuthorizationAgentRequestSnapshotV2;
export function createBackgroundAuthorizationRequestV2(
  input: Readonly<{
    readonly requestId: string;
    readonly workId: string;
    readonly namespaceId: string;
    readonly credentialSubject: BackgroundAuthorizationProcessorSubjectV2;
    readonly now: number;
  }>,
): BackgroundAuthorizationProcessorRequestSnapshotV2;
export function createBackgroundAuthorizationRequestV2(
  input: Readonly<{
    readonly requestId: string;
    readonly workId: string;
    readonly namespaceId: string;
    readonly credentialSubject:
      | BackgroundAuthorizationAgentSubject
      | BackgroundAuthorizationProcessorSubjectV2;
    readonly now: number;
  }>,
): BackgroundAuthorizationRequestSnapshotV2 {
  return parseBackgroundAuthorizationRequestSnapshot({
    formatVersion: BACKGROUND_AUTHORIZATION_FORMAT_VERSION_V2,
    requestId: input.requestId,
    workId: input.workId,
    namespaceId: input.namespaceId,
    descriptorDigest: null,
    credentialSubject: input.credentialSubject,
    recipientGeneration: 0,
    recipient: null,
    acceptedResponse: null,
    state: "awaiting_recipient",
    claimId: null,
    claimExpiresAt: null,
    requestRevision: 0,
    createdAt: input.now,
    updatedAt: input.now,
    retryCount: 0,
    lastRetryReason: null,
    nextAttemptAt: null,
    terminalReason: null,
  }) as BackgroundAuthorizationRequestSnapshotV2;
}

export function createBackgroundAuthorizationTaskRuntimeRequestV3(
  input: Readonly<{
    readonly requestId: string;
    /** Exact TaskRun id for this durable occurrence. */
    readonly workId: string;
    readonly namespaceId: string;
    readonly now: number;
  }>,
): BackgroundAuthorizationTaskRuntimeRequestSnapshotV3 {
  return parseBackgroundAuthorizationRequestSnapshot({
    formatVersion: BACKGROUND_AUTHORIZATION_FORMAT_VERSION_V3,
    requestId: input.requestId,
    workId: input.workId,
    namespaceId: input.namespaceId,
    descriptorDigest: null,
    credentialSubject: {
      kind: "runtime",
      runtimeKind: "task",
      runtimeVersion: 1,
    },
    recipientGeneration: 0,
    recipient: null,
    acceptedResponse: null,
    state: "awaiting_recipient",
    claimId: null,
    claimExpiresAt: null,
    requestRevision: 0,
    createdAt: input.now,
    updatedAt: input.now,
    retryCount: 0,
    lastRetryReason: null,
    nextAttemptAt: null,
    terminalReason: null,
  }) as BackgroundAuthorizationTaskRuntimeRequestSnapshotV3;
}

export function attachBackgroundAuthorizationRecipient(
  value: BackgroundAuthorizationRequestSnapshot,
  input: Readonly<{
    readonly recipientGeneration?: number;
    readonly descriptorDigest: string;
    readonly recipientKeyId: string;
    readonly recipientPublicKey: string;
    readonly expiresAt: number;
    readonly now: number;
  }>,
): BackgroundAuthorizationRequestSnapshot {
  assertActive(value);
  assertState(value, "awaiting_recipient");
  assertTime(value, input.now);
  if (
    input.recipientGeneration !== undefined
    && input.recipientGeneration !== value.recipientGeneration
  ) {
    throw new BackgroundAuthorizationTransitionError("stale_generation");
  }
  if (
    value.nextAttemptAt !== null
    && input.now < value.nextAttemptAt
  ) {
    throw new BackgroundAuthorizationTransitionError("recipient_not_due");
  }
  if (
    !isTimestamp(input.expiresAt)
    || input.expiresAt <= input.now
    || input.expiresAt - input.now > BACKGROUND_AUTHORIZATION_MAX_TTL_MS
  ) {
    throw new TypeError("Invalid background authorization recipient expiry");
  }
  return update(value, {
    recipient: {
      recipientKeyId: input.recipientKeyId,
      recipientPublicKey: input.recipientPublicKey,
      expiresAt: input.expiresAt,
    },
    descriptorDigest: input.descriptorDigest,
    state: "awaiting_device",
    updatedAt: input.now,
    nextAttemptAt: null,
  });
}

export function markBackgroundAuthorizationGrantReady(
  value: BackgroundAuthorizationRequestSnapshot,
  input: BackgroundAuthorizationVerifiedResponse,
): BackgroundAuthorizationRequestSnapshot {
  assertActive(value);
  assertState(value, "awaiting_device");
  assertTime(value, input.now);
  if (input.recipientGeneration !== value.recipientGeneration) {
    throw new BackgroundAuthorizationTransitionError("stale_generation");
  }
  if (input.kind !== value.credentialSubject.kind) {
    throw new TypeError(
      "Background authorization response credential family mismatch",
    );
  }
  if (
    value.descriptorDigest === null
    || value.recipient === null
    || input.requestId !== value.requestId
    || input.descriptorDigest !== value.descriptorDigest
    || input.recipientKeyId !== value.recipient.recipientKeyId
    || input.recipientPublicKey !== value.recipient.recipientPublicKey
    || input.expiresAt !== value.recipient.expiresAt
  ) {
    throw new TypeError(
      "Background authorization response does not match the exact request",
    );
  }
  return update(value, {
    acceptedResponse: {
      kind: input.kind,
      responseDigest: input.responseDigest,
      credentialDigest: input.credentialDigest,
      issuingHumanId: input.issuingHumanId,
      issuingDeviceId: input.issuingDeviceId,
      recipientGeneration: input.recipientGeneration,
      acceptedAt: input.now,
    },
    state: "grant_ready",
    updatedAt: input.now,
  });
}

export function claimBackgroundAuthorizationRequest(
  value: BackgroundAuthorizationRequestSnapshot,
  claimId: string,
  now: number,
  claimExpiresAt: number,
): BackgroundAuthorizationRequestSnapshot {
  assertActive(value);
  assertState(value, "grant_ready");
  assertTime(value, now);
  if (
    !isTimestamp(claimExpiresAt)
    || claimExpiresAt <= now
    || claimExpiresAt - now > BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS
  ) {
    throw new TypeError("Invalid background authorization claim expiry");
  }
  return update(value, {
    state: "claimed",
    claimId,
    claimExpiresAt,
    updatedAt: now,
  });
}

export function markBackgroundAuthorizationRunning(
  value: BackgroundAuthorizationRequestSnapshot,
  now: number,
): BackgroundAuthorizationRequestSnapshot {
  assertActive(value);
  assertState(value, "claimed");
  assertTime(value, now);
  if (value.claimExpiresAt === null || now >= value.claimExpiresAt) {
    throw new BackgroundAuthorizationTransitionError("claim_expired");
  }
  return update(value, { state: "running", updatedAt: now });
}

export function markBackgroundAuthorizationPublicationReconciliation(
  value: BackgroundAuthorizationRequestSnapshot,
  now: number,
): BackgroundAuthorizationRequestSnapshot {
  assertActive(value);
  assertState(value, "running");
  assertTime(value, now);
  return update(value, {
    state: "publication_reconciliation",
    recipient: null,
    claimId: null,
    claimExpiresAt: null,
    updatedAt: now,
  });
}

export function completeBackgroundAuthorizationRequest(
  value: BackgroundAuthorizationRequestSnapshot,
  now: number,
): BackgroundAuthorizationRequestSnapshot {
  assertActive(value);
  assertState(value, ["running", "publication_reconciliation"]);
  assertTime(value, now);
  return update(value, {
    state: "completed",
    recipient: null,
    claimId: null,
    claimExpiresAt: null,
    nextAttemptAt: null,
    terminalReason: null,
    updatedAt: now,
  });
}

export function advanceBackgroundAuthorizationGeneration(
  value: BackgroundAuthorizationRequestSnapshot,
  input: Readonly<{
    readonly reason: BackgroundAuthorizationRetryReason;
    readonly now: number;
    readonly nextAttemptAt: number;
  }>,
): BackgroundAuthorizationRequestSnapshot {
  assertActive(value);
  assertState(value, [
    "awaiting_device",
    "grant_ready",
    "claimed",
    "running",
  ]);
  assertTime(value, input.now);
  if (
    input.reason === "attempt_expired"
    && (
      value.recipient === null
      || input.now < value.recipient.expiresAt
    )
  ) {
    throw new BackgroundAuthorizationTransitionError("attempt_not_expired");
  }
  if (
    input.reason === "claim_expired"
    && (
      value.claimExpiresAt === null
      || input.now < value.claimExpiresAt
    )
  ) {
    throw new BackgroundAuthorizationTransitionError("claim_not_expired");
  }
  if (
    !RETRY_REASON_SET.has(input.reason)
    || input.reason === "publication_pending"
    || !isTimestamp(input.nextAttemptAt)
    || input.nextAttemptAt < input.now
  ) {
    throw new TypeError("Invalid background authorization retry");
  }
  // A recipient can expire repeatedly while every eligible device is offline.
  // No credential was consumed before `running`; rotating that recipient must
  // fence old responses without spending the execution-failure budget. An
  // explicitly reported provider failure still spends that budget.
  const consumesExecutionRetry = value.state === "running"
    || input.reason === "provider_transient_failure";
  if (
    value.recipientGeneration >= BACKGROUND_AUTHORIZATION_MAX_GENERATION
    || (consumesExecutionRetry
      && value.retryCount >= BACKGROUND_AUTHORIZATION_MAX_RETRY_COUNT)
  ) {
    throw new BackgroundAuthorizationTransitionError("counter_exhausted");
  }
  return update(value, {
    recipientGeneration: value.recipientGeneration + 1,
    descriptorDigest: null,
    recipient: null,
    acceptedResponse: null,
    state: "awaiting_recipient",
    claimId: null,
    claimExpiresAt: null,
    updatedAt: input.now,
    retryCount: value.retryCount + (consumesExecutionRetry ? 1 : 0),
    lastRetryReason: input.reason,
    nextAttemptAt: input.nextAttemptAt,
  });
}

export function scheduleBackgroundAuthorizationPublicationRetry(
  value: BackgroundAuthorizationRequestSnapshot,
  input: Readonly<{
    readonly now: number;
    readonly nextAttemptAt: number;
  }>,
): BackgroundAuthorizationRequestSnapshot {
  assertActive(value);
  assertState(value, "publication_reconciliation");
  assertTime(value, input.now);
  if (
    !isTimestamp(input.nextAttemptAt)
    || input.nextAttemptAt < input.now
  ) {
    throw new TypeError(
      "Invalid background authorization publication retry",
    );
  }
  const isProcessorV2 = value.formatVersion === 2
    && value.credentialSubject.kind === "processor";
  if (!isProcessorV2 && value.retryCount >= BACKGROUND_AUTHORIZATION_MAX_RETRY_COUNT) {
    throw new BackgroundAuthorizationTransitionError("counter_exhausted");
  }
  return update(value, {
    updatedAt: input.now,
    // Waiting for a fresh device grant is not a failed model execution.
    retryCount: isProcessorV2 ? value.retryCount : value.retryCount + 1,
    lastRetryReason: "publication_pending",
    nextAttemptAt: input.nextAttemptAt,
  });
}

export function restartBackgroundAuthorizationAfterUncommittedPublication(
  value: BackgroundAuthorizationRequestSnapshot,
  input: Readonly<{
    readonly now: number;
    readonly nextAttemptAt: number;
  }>,
): BackgroundAuthorizationRequestSnapshot {
  assertActive(value);
  assertState(value, "publication_reconciliation");
  assertTime(value, input.now);
  if (
    !isTimestamp(input.nextAttemptAt)
    || input.nextAttemptAt < input.now
  ) {
    throw new TypeError(
      "Invalid uncommitted publication restart",
    );
  }
  if (
    value.recipientGeneration >= BACKGROUND_AUTHORIZATION_MAX_GENERATION
    || value.retryCount >= BACKGROUND_AUTHORIZATION_MAX_RETRY_COUNT
  ) {
    throw new BackgroundAuthorizationTransitionError("counter_exhausted");
  }
  return update(value, {
    recipientGeneration: value.recipientGeneration + 1,
    descriptorDigest: null,
    recipient: null,
    acceptedResponse: null,
    state: "awaiting_recipient",
    claimId: null,
    claimExpiresAt: null,
    updatedAt: input.now,
    retryCount: value.retryCount + 1,
    lastRetryReason: "claim_expired",
    nextAttemptAt: input.nextAttemptAt,
  });
}

export function cancelBackgroundAuthorizationRequest(
  value: BackgroundAuthorizationRequestSnapshot,
  reason: Extract<
    BackgroundAuthorizationTerminalReason,
    "cancelled" | "superseded"
  >,
  now: number,
): BackgroundAuthorizationRequestSnapshot {
  assertActive(value);
  assertTime(value, now);
  return update(value, {
    state: "cancelled",
    recipient: null,
    claimId: null,
    claimExpiresAt: null,
    nextAttemptAt: null,
    terminalReason: reason,
    updatedAt: now,
  });
}

export function failBackgroundAuthorizationRequest(
  value: BackgroundAuthorizationRequestSnapshot,
  reason: Exclude<
    BackgroundAuthorizationTerminalReason,
    "cancelled" | "superseded"
  >,
  now: number,
): BackgroundAuthorizationRequestSnapshot {
  assertActive(value);
  assertTime(value, now);
  return update(value, {
    state: "terminal_failure",
    recipient: null,
    claimId: null,
    claimExpiresAt: null,
    nextAttemptAt: null,
    terminalReason: reason,
    updatedAt: now,
  });
}
