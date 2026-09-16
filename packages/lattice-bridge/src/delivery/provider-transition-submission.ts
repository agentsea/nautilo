import {
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  decodeProviderRosterV2,
  providerPublicTransitionDigestV2,
  validateProviderPublicTransitionV2,
  type ProviderPublicHeadV2,
  type ProviderPublicTransitionV2,
  type ProviderRosterEntryV2,
} from "@nautilo/lattice-crypto/wire";

export const PROVIDER_TRANSITION_SUBMISSION_FORMAT_VERSION = 1 as const;
export const PROVIDER_TRANSITION_SUBMISSION_MAX_BYTES = 67_108_864;

export interface ProviderTransitionSubmission {
  readonly formatVersion:
    typeof PROVIDER_TRANSITION_SUBMISSION_FORMAT_VERSION;
  readonly operationId: string;
  readonly committerDeviceId: string;
  readonly expectedAuthorizationRevision: number;
  readonly expectedParticipantDigest: Uint8Array;
  readonly transitionDigest: Uint8Array;
  readonly transition: ProviderPublicTransitionV2;
  readonly signature: Uint8Array;
}

export interface ProviderTransitionExpectation {
  readonly operationId: string;
  readonly operationKind:
    | "device_add"
    | "device_recovery"
    | "device_revoke"
    | "human_add";
  readonly domainId: string;
  readonly targetHumanId: string;
  readonly targetDeviceId: string;
  readonly expectedEpoch: number;
  readonly targetEpoch: number;
  readonly expectedAuthorizationRevision: number;
  readonly expectedParticipantDigest: Uint8Array;
  readonly committerDeviceId: string;
}

export interface ProviderTransitionCurrentState {
  readonly head: ProviderPublicHeadV2;
  readonly rosterBytes: Uint8Array;
}

export interface VerifiedProviderTransitionSubmission {
  readonly operationId: string;
  readonly committerDeviceId: string;
  readonly expectedAuthorizationRevision: number;
  readonly expectedParticipantDigest: Uint8Array;
  readonly transitionDigest: Uint8Array;
  readonly transition: ProviderPublicTransitionV2;
  readonly previousRoster: readonly ProviderRosterEntryV2[];
  readonly nextRoster: readonly ProviderRosterEntryV2[];
  readonly targetLeafIndex: number;
}

export type ResolveActiveTransitionCommitter = (
  deviceId: string,
) => {
  readonly state: "active";
  readonly humanId: string;
  readonly signingPublicKey: Uint8Array;
} | null;

const SUBMISSION_FIELDS = Object.freeze([
  "formatVersion",
  "operationId",
  "committerDeviceId",
  "expectedAuthorizationRevision",
  "expectedParticipantDigest",
  "transitionDigest",
  "transition",
  "signature",
].sort());

class SubmissionReader {
  #offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  u32(): number {
    if (this.#offset + 4 > this.bytes.length) {
      throw new RangeError("Provider transition submission is truncated");
    }
    const value = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.byteLength,
    ).getUint32(this.#offset);
    this.#offset += 4;
    return value;
  }

  u64(): number {
    if (this.#offset + 8 > this.bytes.length) {
      throw new RangeError("Provider transition submission is truncated");
    }
    const value = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.byteLength,
    ).getBigUint64(this.#offset);
    this.#offset += 8;
    const normalized = Number(value);
    if (!Number.isSafeInteger(normalized)) {
      throw new RangeError("Provider transition submission counter is unsafe");
    }
    return normalized;
  }

  frame(maximum: number): Uint8Array {
    const length = this.u32();
    if (length > maximum || this.#offset + length > this.bytes.length) {
      throw new RangeError(
        "Provider transition submission frame is out of bounds",
      );
    }
    const value = this.bytes.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return value;
  }

  text(maximum = 128): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      this.frame(maximum),
    );
  }

  finish(): void {
    if (this.#offset !== this.bytes.length) {
      throw new RangeError(
        "Provider transition submission has trailing bytes",
      );
    }
  }
}

function u32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("Provider transition counter is invalid");
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function u64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Provider transition counter is unsafe");
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}

function frame(bytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(4 + bytes.length);
  output.set(u32(bytes.length));
  output.set(bytes, 4);
  return output;
}

function text(value: string): Uint8Array {
  return frame(new TextEncoder().encode(value));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function equalHeads(
  left: ProviderPublicHeadV2,
  right: ProviderPublicHeadV2,
): boolean {
  return left.providerId === right.providerId
    && left.domainId === right.domainId
    && left.epoch === right.epoch
    && equalBytes(left.stateHash, right.stateHash);
}

function hash(label: string, value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new RangeError(`${label} must be exactly 32 bytes`);
  }
}

function portable(label: string, value: string): void {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)
  ) {
    throw new TypeError(`${label} must be a portable identifier`);
  }
}

function assertExpectation(
  expectation: ProviderTransitionExpectation,
): void {
  portable("Provider transition operation id", expectation.operationId);
  cryptoDomainId(expectation.domainId);
  humanId(expectation.targetHumanId);
  cryptoDeviceId(expectation.targetDeviceId);
  cryptoDeviceId(expectation.committerDeviceId);
  if (
    expectation.operationKind !== "device_add"
    && expectation.operationKind !== "device_recovery"
    && expectation.operationKind !== "device_revoke"
    && expectation.operationKind !== "human_add"
  ) {
    throw new TypeError("Provider transition operation kind is invalid");
  }
  for (const value of [
    expectation.expectedEpoch,
    expectation.targetEpoch,
    expectation.expectedAuthorizationRevision,
  ]) {
    u64(value);
  }
  if (expectation.targetEpoch !== expectation.expectedEpoch + 1) {
    throw new RangeError("Provider transition target epoch is invalid");
  }
  hash(
    "Provider transition participant digest",
    expectation.expectedParticipantDigest,
  );
}

export function providerTransitionSubmissionSigningBytes(
  submission: Omit<
    ProviderTransitionSubmission,
    "signature" | "transition"
  >,
): Uint8Array {
  portable("Provider transition operation id", submission.operationId);
  cryptoDeviceId(submission.committerDeviceId);
  hash(
    "Provider transition participant digest",
    submission.expectedParticipantDigest,
  );
  hash("Provider transition digest", submission.transitionDigest);
  return concat([
    text("nautilo/lattice-bridge/provider-transition-submission/v1"),
    u32(submission.formatVersion),
    text(submission.operationId),
    text(submission.committerDeviceId),
    u64(submission.expectedAuthorizationRevision),
    frame(submission.expectedParticipantDigest),
    frame(submission.transitionDigest),
  ]);
}

export function createProviderTransitionSubmission(input: {
  readonly crypto: LatticeCrypto;
  readonly transition: ProviderPublicTransitionV2;
  readonly operationId: string;
  readonly committerDeviceId: string;
  readonly expectedAuthorizationRevision: number;
  readonly expectedParticipantDigest: Uint8Array;
  readonly signingPrivateKey: Uint8Array;
}): ProviderTransitionSubmission {
  const transition = validateProviderPublicTransitionV2(input.transition);
  const unsigned = Object.freeze({
    formatVersion: PROVIDER_TRANSITION_SUBMISSION_FORMAT_VERSION,
    operationId: input.operationId,
    committerDeviceId: input.committerDeviceId,
    expectedAuthorizationRevision: input.expectedAuthorizationRevision,
    expectedParticipantDigest: Uint8Array.from(
      input.expectedParticipantDigest,
    ),
    transitionDigest: providerPublicTransitionDigestV2(
      input.crypto,
      transition,
    ),
  });
  return Object.freeze({
    ...unsigned,
    transition,
    signature: input.crypto.sign(
      input.signingPrivateKey,
      providerTransitionSubmissionSigningBytes(unsigned),
    ),
  });
}

function encodeProviderHead(head: ProviderPublicHeadV2): Uint8Array {
  return concat([
    text(head.providerId),
    text(head.domainId),
    u64(head.epoch),
    frame(head.stateHash),
  ]);
}

function decodeProviderHead(
  reader: SubmissionReader,
): ProviderPublicHeadV2 {
  return Object.freeze({
    providerId: reader.text(),
    domainId: cryptoDomainId(reader.text()),
    epoch: domainEpoch(reader.u64()),
    stateHash: reader.frame(32),
  });
}

export function serializeProviderTransitionSubmission(
  submission: ProviderTransitionSubmission,
): Uint8Array {
  const transition = validateProviderPublicTransitionV2(
    submission.transition,
  );
  hash(
    "Provider transition participant digest",
    submission.expectedParticipantDigest,
  );
  hash("Provider transition digest", submission.transitionDigest);
  if (
    submission.formatVersion
      !== PROVIDER_TRANSITION_SUBMISSION_FORMAT_VERSION
    || !(submission.signature instanceof Uint8Array)
    || submission.signature.length !== 64
  ) {
    throw new TypeError("Provider transition submission is malformed");
  }
  providerTransitionSubmissionSigningBytes(submission);
  const bytes = concat([
    text("nautilo/lattice-bridge/provider-transition-submission/v1"),
    u32(submission.formatVersion),
    text(submission.operationId),
    text(submission.committerDeviceId),
    u64(submission.expectedAuthorizationRevision),
    frame(submission.expectedParticipantDigest),
    frame(submission.transitionDigest),
    frame(submission.signature),
    u32(transition.formatVersion),
    text(transition.providerId),
    text(transition.domainId),
    text(transition.operation),
    text(transition.targetHumanId),
    text(transition.targetDeviceId),
    encodeProviderHead(transition.expectedHead),
    encodeProviderHead(transition.nextHead),
    frame(transition.commitBytes),
    frame(transition.welcomeHash),
    frame(transition.welcomeBytes),
    frame(transition.rosterBytes),
  ]);
  if (bytes.length > PROVIDER_TRANSITION_SUBMISSION_MAX_BYTES) {
    throw new RangeError("Provider transition submission exceeds its limit");
  }
  return bytes;
}

export function decodeProviderTransitionSubmission(
  bytes: Uint8Array,
): ProviderTransitionSubmission {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length < 1
    || bytes.length > PROVIDER_TRANSITION_SUBMISSION_MAX_BYTES
  ) {
    throw new RangeError("Provider transition submission bytes are invalid");
  }
  const reader = new SubmissionReader(bytes);
  if (
    reader.text()
      !== "nautilo/lattice-bridge/provider-transition-submission/v1"
  ) {
    throw new TypeError("Provider transition submission domain is invalid");
  }
  const formatVersion = reader.u32();
  const operationId = reader.text();
  const committerDeviceId = reader.text();
  const expectedAuthorizationRevision = reader.u64();
  const expectedParticipantDigest = reader.frame(32);
  const transitionDigest = reader.frame(32);
  const signature = reader.frame(64);
  const transition = validateProviderPublicTransitionV2({
    formatVersion: reader.u32(),
    providerId: reader.text(),
    domainId: reader.text(),
    operation: reader.text(),
    targetHumanId: reader.text(),
    targetDeviceId: reader.text(),
    expectedHead: decodeProviderHead(reader),
    nextHead: decodeProviderHead(reader),
    commitBytes: reader.frame(PROVIDER_TRANSITION_SUBMISSION_MAX_BYTES),
    welcomeHash: reader.frame(32),
    welcomeBytes: reader.frame(PROVIDER_TRANSITION_SUBMISSION_MAX_BYTES),
    rosterBytes: reader.frame(PROVIDER_TRANSITION_SUBMISSION_MAX_BYTES),
  });
  reader.finish();
  const submission = Object.freeze({
    formatVersion,
    operationId,
    committerDeviceId,
    expectedAuthorizationRevision,
    expectedParticipantDigest,
    transitionDigest,
    transition,
    signature,
  }) as ProviderTransitionSubmission;
  if (
    submission.formatVersion
      !== PROVIDER_TRANSITION_SUBMISSION_FORMAT_VERSION
    || submission.expectedParticipantDigest.length !== 32
    || submission.transitionDigest.length !== 32
    || submission.signature.length !== 64
  ) {
    throw new TypeError("Provider transition submission is malformed");
  }
  providerTransitionSubmissionSigningBytes(submission);
  return submission;
}

export function verifyProviderTransitionSubmission(input: {
  readonly crypto: LatticeCrypto;
  readonly submission: ProviderTransitionSubmission;
  readonly expectation: ProviderTransitionExpectation;
  readonly currentProviderState: ProviderTransitionCurrentState;
  readonly resolveActiveCommitter: ResolveActiveTransitionCommitter;
  /**
   * Omit for server admission, which requires the complete target Welcome.
   * Recipient devices set this to enforce target-full/existing-redacted
   * delivery without weakening the admission boundary.
   */
  readonly recipientDeviceId?: string;
}): VerifiedProviderTransitionSubmission {
  assertExpectation(input.expectation);
  const submission = input.submission;
  if (
    typeof submission !== "object"
    || submission === null
    || Object.keys(submission).length !== SUBMISSION_FIELDS.length
    || Object.keys(submission).sort().some(
      (field, index) => field !== SUBMISSION_FIELDS[index],
    )
    || submission.formatVersion
      !== PROVIDER_TRANSITION_SUBMISSION_FORMAT_VERSION
    || !(submission.signature instanceof Uint8Array)
    || submission.signature.length !== 64
  ) {
    throw new TypeError("Provider transition submission fields are malformed");
  }
  const transition = validateProviderPublicTransitionV2(
    submission.transition,
  );
  const transitionDigest = providerPublicTransitionDigestV2(
    input.crypto,
    transition,
  );
  hash("Provider transition digest", submission.transitionDigest);
  const expectsWelcome = input.expectation.operationKind !== "device_revoke"
    && (
      input.recipientDeviceId === undefined
      || input.recipientDeviceId === transition.targetDeviceId
    );
  if (
    !equalBytes(transitionDigest, submission.transitionDigest)
    || (
      expectsWelcome
        ? transition.welcomeBytes.length < 1
          || !equalBytes(
            input.crypto.hash(transition.welcomeBytes),
            transition.welcomeHash,
          )
        : transition.welcomeBytes.length !== 0
          || (
            input.expectation.operationKind === "device_revoke"
            && !equalBytes(
              input.crypto.hash(new Uint8Array()),
              transition.welcomeHash,
            )
          )
    )
  ) {
    throw new Error("Provider transition digest does not match its bytes");
  }
  const expectation = input.expectation;
  if (
    submission.operationId !== expectation.operationId
    || submission.committerDeviceId !== expectation.committerDeviceId
    || submission.expectedAuthorizationRevision
      !== expectation.expectedAuthorizationRevision
    || !equalBytes(
      submission.expectedParticipantDigest,
      expectation.expectedParticipantDigest,
    )
    || transition.operation !== (
      expectation.operationKind === "device_revoke" ? "remove" : "add"
    )
    || transition.domainId !== expectation.domainId
    || transition.targetHumanId !== expectation.targetHumanId
    || transition.targetDeviceId !== expectation.targetDeviceId
    || transition.expectedHead.epoch !== expectation.expectedEpoch
    || transition.nextHead.epoch !== expectation.targetEpoch
  ) {
    throw new Error(
      "Provider transition submission does not match its operation",
    );
  }
  if (
    !equalHeads(
      input.currentProviderState.head,
      transition.expectedHead,
    )
  ) {
    throw new Error("Provider transition expected head is stale");
  }
  const committer = input.resolveActiveCommitter(
    submission.committerDeviceId,
  );
  if (
    committer === null
    || committer.state !== "active"
    || !(committer.signingPublicKey instanceof Uint8Array)
    || committer.signingPublicKey.length !== 32
    || !input.crypto.verify(
      committer.signingPublicKey,
      providerTransitionSubmissionSigningBytes(submission),
      submission.signature,
    )
  ) {
    throw new Error("Provider transition committer is not authorized");
  }
  const previousRoster = decodeProviderRosterV2(
    transition.providerId,
    input.currentProviderState.rosterBytes,
  );
  const nextRoster = decodeProviderRosterV2(
    transition.providerId,
    transition.rosterBytes,
  );
  const committerEntry = previousRoster.find(
    (entry) => entry.deviceId === submission.committerDeviceId,
  );
  if (
    committerEntry === undefined
    || committerEntry.humanId !== committer.humanId
  ) {
    throw new Error(
      "Provider transition committer is absent from the current roster",
    );
  }
  const isRevocation = expectation.operationKind === "device_revoke";
  const target = (isRevocation ? previousRoster : nextRoster).find(
    (entry) => entry.deviceId === expectation.targetDeviceId,
  );
  const retainedExactly = (isRevocation ? previousRoster : nextRoster)
    .filter((entry) => entry.deviceId !== expectation.targetDeviceId)
    .every((entry) =>
      (isRevocation ? nextRoster : previousRoster).some((candidate) =>
        candidate.deviceId === entry.deviceId
        && candidate.humanId === entry.humanId
        && candidate.leafIndex === entry.leafIndex
      )
    );
  const exactDelta = isRevocation
    ? nextRoster.length === previousRoster.length - 1
      && !nextRoster.some(
        (entry) => entry.deviceId === expectation.targetDeviceId,
      )
    : nextRoster.length === previousRoster.length + 1
      && !previousRoster.some(
        (entry) => entry.deviceId === expectation.targetDeviceId,
      );
  if (
    !exactDelta
    || !retainedExactly
    || target === undefined
    || target.humanId !== expectation.targetHumanId
  ) {
    throw new Error(
      `Provider transition roster is not one exact target-device ${
        isRevocation ? "removal" : "addition"
      }`,
    );
  }
  return Object.freeze({
    operationId: submission.operationId,
    committerDeviceId: submission.committerDeviceId,
    expectedAuthorizationRevision:
      submission.expectedAuthorizationRevision,
    expectedParticipantDigest: Uint8Array.from(
      submission.expectedParticipantDigest,
    ),
    transitionDigest,
    transition,
    previousRoster,
    nextRoster,
    targetLeafIndex: target.leafIndex,
  });
}
