import {
  cryptoDeviceId,
  cryptoDomainId,
  namespaceId,
  verifyBindingEnvelopePair,
  type LatticeCrypto,
  type PreparedHumanNamespaceRebind,
} from "@nautilo/lattice-crypto";
import {
  namespaceBindingSigningBytesV2,
  namespaceKeyringEnvelopeSigningBytesV2,
  parseNamespaceBindingV2,
  parseNamespaceKeyringEnvelopeV2,
  storageAdapterSupportV2,
  type NamespaceBindingWireRecordV2,
  type NamespaceHeadV2,
} from "@nautilo/lattice-crypto/wire";

export const HUMAN_MEMBERSHIP_REBIND_SUBMISSION_FORMAT_VERSION = 1 as const;
export const HUMAN_MEMBERSHIP_REBIND_SUBMISSION_MAX_BYTES = 67_108_864;

export type HumanMembershipRebindKind = "human_add" | "human_remove";

export interface HumanMembershipRebindExpectedHead {
  readonly namespaceId: string;
  readonly accessRevision: number;
  readonly bindingHash: Uint8Array;
}

export interface HumanMembershipRebindCandidate {
  readonly expectedHead: HumanMembershipRebindExpectedHead;
  readonly nextHead: NamespaceHeadV2;
  readonly binding: NamespaceBindingWireRecordV2;
}

export interface HumanMembershipRebindSubmission {
  readonly formatVersion:
    typeof HUMAN_MEMBERSHIP_REBIND_SUBMISSION_FORMAT_VERSION;
  readonly operationId: string;
  readonly kind: HumanMembershipRebindKind;
  readonly sourceDomainId: string;
  readonly targetDomainId: string;
  readonly oldParticipantDigest: Uint8Array;
  readonly newParticipantDigest: Uint8Array;
  readonly committerDeviceId: string;
  readonly committerHumanId: string;
  readonly candidateDigest: Uint8Array;
  readonly candidate: HumanMembershipRebindCandidate;
  readonly signature: Uint8Array;
}

declare const verifiedHumanMembershipRebindBrand: unique symbol;

export interface VerifiedHumanMembershipRebindSubmission
  extends HumanMembershipRebindSubmission {
  readonly [verifiedHumanMembershipRebindBrand]: true;
}

export interface HumanMembershipRebindCommitter {
  readonly state: "active" | "pending" | "revoked" | "rejected";
  readonly deviceId: string;
  readonly humanId: string;
  readonly signingPublicKey: Uint8Array;
}

export interface HumanMembershipRebindCommitterContext {
  readonly domainId: string;
  readonly deviceId: string;
  readonly humanId: string;
}

export type ResolveHumanMembershipRebindCommitter = (
  context: HumanMembershipRebindCommitterContext,
) => HumanMembershipRebindCommitter | null;

export interface VerifyHumanMembershipRebindExpected {
  readonly operationId: string;
  readonly kind: HumanMembershipRebindKind;
  readonly sourceDomainId: string;
  readonly targetDomainId: string;
  readonly oldParticipantDigest: Uint8Array;
  readonly newParticipantDigest: Uint8Array;
  readonly expectedHead: HumanMembershipRebindExpectedHead;
}

const SUBMISSION_DOMAIN =
  "nautilo/lattice-bridge/human-membership-rebind-submission/v1";
const CANDIDATE_DOMAIN =
  "nautilo/lattice-bridge/human-membership-rebind-candidate/v1";
const SUBMISSION_FIELDS = Object.freeze([
  "candidate",
  "candidateDigest",
  "committerDeviceId",
  "committerHumanId",
  "formatVersion",
  "kind",
  "newParticipantDigest",
  "oldParticipantDigest",
  "operationId",
  "signature",
  "sourceDomainId",
  "targetDomainId",
].sort());
const CANDIDATE_FIELDS = Object.freeze([
  "binding",
  "expectedHead",
  "nextHead",
].sort());
const EXPECTED_HEAD_FIELDS = Object.freeze([
  "accessRevision",
  "bindingHash",
  "namespaceId",
].sort());
const canonicalSubmissions = new WeakMap<object, Uint8Array>();
const verifiedSubmissions = new WeakMap<object, Uint8Array>();

class SubmissionReader {
  #offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  u32(): number {
    if (this.#offset + 4 > this.bytes.length) {
      throw new RangeError("Human membership rebind submission is truncated");
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
      throw new RangeError("Human membership rebind submission is truncated");
    }
    const value = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.byteLength,
    ).getBigUint64(this.#offset);
    this.#offset += 8;
    const normalized = Number(value);
    if (!Number.isSafeInteger(normalized)) {
      throw new RangeError("Human membership rebind counter is unsafe");
    }
    return normalized;
  }

  frame(maximum: number): Uint8Array {
    const length = this.u32();
    if (length > maximum || this.#offset + length > this.bytes.length) {
      throw new RangeError(
        "Human membership rebind submission frame is out of bounds",
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
        "Human membership rebind submission has trailing bytes",
      );
    }
  }
}

function u32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("Human membership rebind counter is invalid");
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function u64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Human membership rebind counter is unsafe");
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

function exactFields(
  label: string,
  value: object,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])
  ) {
    throw new TypeError(`${label} fields are malformed`);
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

function hash(label: string, value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new RangeError(`${label} must be exactly 32 bytes`);
  }
}

function kindTag(kind: HumanMembershipRebindKind): number {
  if (kind === "human_add") return 1;
  if (kind === "human_remove") return 2;
  throw new TypeError("Human membership rebind kind is invalid");
}

function kindFromTag(tag: number): HumanMembershipRebindKind {
  if (tag === 1) return "human_add";
  if (tag === 2) return "human_remove";
  throw new TypeError("Human membership rebind kind is invalid");
}

function optionalHash(value: Uint8Array | null): Uint8Array {
  return value === null
    ? u32(0)
    : concat([u32(1), frame(value)]);
}

function encodeExpectedHead(
  head: HumanMembershipRebindExpectedHead,
): Uint8Array {
  return concat([
    text(head.namespaceId),
    u64(head.accessRevision),
    frame(head.bindingHash),
  ]);
}

function encodeNextHead(head: NamespaceHeadV2): Uint8Array {
  return concat([
    text(head.namespaceId),
    u64(head.accessRevision),
    frame(head.bindingHash),
    text(head.domainId),
    u64(head.domainEpoch),
  ]);
}

function encodeBinding(
  binding: NamespaceBindingWireRecordV2,
): Uint8Array {
  return concat([
    text(binding.namespaceId),
    u64(binding.revision),
    frame(binding.bindingHash),
    optionalHash(binding.previousBindingHash),
    frame(binding.signedBindingBytes),
    frame(binding.humanKeyringEnvelopeBytes),
    frame(binding.aiKeyringEnvelopeBytes),
  ]);
}

function encodeCandidate(
  candidate: HumanMembershipRebindCandidate,
): Uint8Array {
  return concat([
    encodeExpectedHead(candidate.expectedHead),
    encodeNextHead(candidate.nextHead),
    encodeBinding(candidate.binding),
  ]);
}

function canonicalCandidate(
  candidate: HumanMembershipRebindCandidate,
): HumanMembershipRebindCandidate {
  if (typeof candidate !== "object" || candidate === null) {
    throw new TypeError("Human membership rebind candidate is malformed");
  }
  exactFields(
    "Human membership rebind candidate",
    candidate,
    CANDIDATE_FIELDS,
  );
  exactFields(
    "Human membership rebind expected head",
    candidate.expectedHead,
    EXPECTED_HEAD_FIELDS,
  );
  const expectedNamespaceId = namespaceId(
    candidate.expectedHead.namespaceId,
  );
  u64(candidate.expectedHead.accessRevision);
  hash(
    "Human membership rebind expected binding hash",
    candidate.expectedHead.bindingHash,
  );
  const nextHead = storageAdapterSupportV2.validateNamespaceHead(
    candidate.nextHead,
  );
  const binding = storageAdapterSupportV2.validateNamespaceBinding(
    candidate.binding,
  );
  const signed = parseNamespaceBindingV2(binding.signedBindingBytes);
  const humanEnvelope = parseNamespaceKeyringEnvelopeV2(
    binding.humanKeyringEnvelopeBytes,
  );
  const aiEnvelope = parseNamespaceKeyringEnvelopeV2(
    binding.aiKeyringEnvelopeBytes,
  );
  if (
    nextHead.namespaceId !== expectedNamespaceId
    || binding.namespaceId !== expectedNamespaceId
    || signed.namespaceId !== expectedNamespaceId
    || nextHead.accessRevision !== candidate.expectedHead.accessRevision + 1
    || binding.revision !== nextHead.accessRevision
    || !equalBytes(binding.bindingHash, nextHead.bindingHash)
    || binding.previousBindingHash === null
    || !equalBytes(
      binding.previousBindingHash,
      candidate.expectedHead.bindingHash,
    )
    || signed.domainId !== nextHead.domainId
    || signed.domainEpoch !== nextHead.domainEpoch
    || humanEnvelope.committerDeviceId !== signed.committerDeviceId
    || aiEnvelope.committerDeviceId !== signed.committerDeviceId
    || !verifyBindingEnvelopePair(signed, humanEnvelope, aiEnvelope)
  ) {
    throw new Error(
      "Human membership rebind candidate coordinates are inconsistent",
    );
  }
  return Object.freeze({
    expectedHead: Object.freeze({
      namespaceId: expectedNamespaceId,
      accessRevision: candidate.expectedHead.accessRevision,
      bindingHash: Uint8Array.from(candidate.expectedHead.bindingHash),
    }),
    nextHead,
    binding,
  });
}

function candidateDigestBytes(
  candidate: HumanMembershipRebindCandidate,
): Uint8Array {
  return concat([text(CANDIDATE_DOMAIN), encodeCandidate(candidate)]);
}

export function humanMembershipRebindCandidateDigest(
  crypto: LatticeCrypto,
  candidate: HumanMembershipRebindCandidate,
): Uint8Array {
  return crypto.hash(candidateDigestBytes(canonicalCandidate(candidate)));
}

export function humanMembershipRebindSubmissionSigningBytes(
  submission: Omit<
    HumanMembershipRebindSubmission,
    "candidate" | "signature"
  >,
): Uint8Array {
  portable("Human membership rebind operation id", submission.operationId);
  kindTag(submission.kind);
  cryptoDomainId(submission.sourceDomainId);
  cryptoDomainId(submission.targetDomainId);
  cryptoDeviceId(submission.committerDeviceId);
  portable(
    "Human membership rebind committer Human id",
    submission.committerHumanId,
  );
  hash(
    "Human membership rebind old participant digest",
    submission.oldParticipantDigest,
  );
  hash(
    "Human membership rebind new participant digest",
    submission.newParticipantDigest,
  );
  hash(
    "Human membership rebind candidate digest",
    submission.candidateDigest,
  );
  if (
    submission.formatVersion
      !== HUMAN_MEMBERSHIP_REBIND_SUBMISSION_FORMAT_VERSION
  ) {
    throw new TypeError("Human membership rebind submission version is invalid");
  }
  return concat([
    text(SUBMISSION_DOMAIN),
    u32(submission.formatVersion),
    text(submission.operationId),
    u32(kindTag(submission.kind)),
    text(submission.sourceDomainId),
    text(submission.targetDomainId),
    frame(submission.oldParticipantDigest),
    frame(submission.newParticipantDigest),
    text(submission.committerDeviceId),
    text(submission.committerHumanId),
    frame(submission.candidateDigest),
  ]);
}

export function createHumanMembershipRebindSubmission(input: {
  readonly crypto: LatticeCrypto;
  readonly operationId: string;
  readonly sourceDomainId: string;
  readonly oldParticipantDigest: Uint8Array;
  readonly newParticipantDigest: Uint8Array;
  readonly prepared: PreparedHumanNamespaceRebind;
  readonly committer: {
    readonly deviceId: string;
    readonly humanId: string;
    readonly signingPrivateKey: Uint8Array;
  };
}): HumanMembershipRebindSubmission {
  const candidate = canonicalCandidate({
    expectedHead: input.prepared.expectedHead,
    nextHead: input.prepared.nextHead,
    binding: storageAdapterSupportV2.validateNamespaceBinding(
      input.prepared.bindingRecord,
    ),
  });
  const signedBinding = parseNamespaceBindingV2(
    candidate.binding.signedBindingBytes,
  );
  const sourceDomainId = cryptoDomainId(input.sourceDomainId);
  const targetDomainId = cryptoDomainId(candidate.nextHead.domainId);
  const committerDeviceId = cryptoDeviceId(input.committer.deviceId);
  if (
    sourceDomainId === targetDomainId
    || input.prepared.reason !== "human_add"
      && input.prepared.reason !== "human_remove"
    || signedBinding.committerDeviceId !== committerDeviceId
    || equalBytes(
      input.oldParticipantDigest,
      input.newParticipantDigest,
    )
  ) {
    throw new Error(
      "Human membership rebind prepared transition is inconsistent",
    );
  }
  const unsigned = Object.freeze({
    formatVersion: HUMAN_MEMBERSHIP_REBIND_SUBMISSION_FORMAT_VERSION,
    operationId: input.operationId,
    kind: input.prepared.reason,
    sourceDomainId,
    targetDomainId,
    oldParticipantDigest: Uint8Array.from(input.oldParticipantDigest),
    newParticipantDigest: Uint8Array.from(input.newParticipantDigest),
    committerDeviceId,
    committerHumanId: input.committer.humanId,
    candidateDigest: humanMembershipRebindCandidateDigest(
      input.crypto,
      candidate,
    ),
  });
  const submission = Object.freeze({
    ...unsigned,
    candidate,
    signature: input.crypto.sign(
      input.committer.signingPrivateKey,
      humanMembershipRebindSubmissionSigningBytes(unsigned),
    ),
  });
  canonicalSubmissions.set(
    submission,
    serializeHumanMembershipRebindSubmission(submission),
  );
  return submission;
}

export function serializeHumanMembershipRebindSubmission(
  submission: HumanMembershipRebindSubmission,
): Uint8Array {
  const candidate = canonicalCandidate(submission.candidate);
  if (
    submission.formatVersion
      !== HUMAN_MEMBERSHIP_REBIND_SUBMISSION_FORMAT_VERSION
    || !(submission.signature instanceof Uint8Array)
    || submission.signature.length !== 64
  ) {
    throw new TypeError("Human membership rebind submission is malformed");
  }
  humanMembershipRebindSubmissionSigningBytes(submission);
  const bytes = concat([
    text(SUBMISSION_DOMAIN),
    u32(submission.formatVersion),
    text(submission.operationId),
    u32(kindTag(submission.kind)),
    text(submission.sourceDomainId),
    text(submission.targetDomainId),
    frame(submission.oldParticipantDigest),
    frame(submission.newParticipantDigest),
    text(submission.committerDeviceId),
    text(submission.committerHumanId),
    frame(submission.candidateDigest),
    frame(submission.signature),
    encodeCandidate(candidate),
  ]);
  if (bytes.length > HUMAN_MEMBERSHIP_REBIND_SUBMISSION_MAX_BYTES) {
    throw new RangeError(
      "Human membership rebind submission exceeds its limit",
    );
  }
  return bytes;
}

function decodeExpectedHead(
  reader: SubmissionReader,
): HumanMembershipRebindExpectedHead {
  return Object.freeze({
    namespaceId: reader.text(),
    accessRevision: reader.u64(),
    bindingHash: reader.frame(32),
  });
}

function decodeNextHead(reader: SubmissionReader): NamespaceHeadV2 {
  return Object.freeze({
    namespaceId: reader.text(),
    accessRevision: reader.u64(),
    bindingHash: reader.frame(32),
    domainId: reader.text(),
    domainEpoch: reader.u64(),
  });
}

function decodeOptionalHash(reader: SubmissionReader): Uint8Array | null {
  const present = reader.u32();
  if (present === 0) return null;
  if (present !== 1) {
    throw new TypeError(
      "Human membership rebind optional hash is malformed",
    );
  }
  return reader.frame(32);
}

function decodeBinding(
  reader: SubmissionReader,
): NamespaceBindingWireRecordV2 {
  return Object.freeze({
    namespaceId: reader.text(),
    revision: reader.u64(),
    bindingHash: reader.frame(32),
    previousBindingHash: decodeOptionalHash(reader),
    signedBindingBytes: reader.frame(
      HUMAN_MEMBERSHIP_REBIND_SUBMISSION_MAX_BYTES,
    ),
    humanKeyringEnvelopeBytes: reader.frame(
      HUMAN_MEMBERSHIP_REBIND_SUBMISSION_MAX_BYTES,
    ),
    aiKeyringEnvelopeBytes: reader.frame(
      HUMAN_MEMBERSHIP_REBIND_SUBMISSION_MAX_BYTES,
    ),
  });
}

export function decodeHumanMembershipRebindSubmission(
  bytes: Uint8Array,
): HumanMembershipRebindSubmission {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length < 1
    || bytes.length > HUMAN_MEMBERSHIP_REBIND_SUBMISSION_MAX_BYTES
  ) {
    throw new RangeError(
      "Human membership rebind submission bytes exceed their limit",
    );
  }
  const reader = new SubmissionReader(bytes);
  if (reader.text() !== SUBMISSION_DOMAIN) {
    throw new TypeError("Human membership rebind submission domain is invalid");
  }
  const formatVersion = reader.u32();
  const operationId = reader.text();
  const kind = kindFromTag(reader.u32());
  const sourceDomainId = reader.text();
  const targetDomainId = reader.text();
  const oldParticipantDigest = reader.frame(32);
  const newParticipantDigest = reader.frame(32);
  const committerDeviceId = reader.text();
  const committerHumanId = reader.text();
  const candidateDigest = reader.frame(32);
  const signature = reader.frame(64);
  const candidate = canonicalCandidate({
    expectedHead: decodeExpectedHead(reader),
    nextHead: decodeNextHead(reader),
    binding: decodeBinding(reader),
  });
  reader.finish();
  const submission = Object.freeze({
    formatVersion,
    operationId,
    kind,
    sourceDomainId,
    targetDomainId,
    oldParticipantDigest,
    newParticipantDigest,
    committerDeviceId,
    committerHumanId,
    candidateDigest,
    candidate,
    signature,
  }) as HumanMembershipRebindSubmission;
  if (
    submission.formatVersion
      !== HUMAN_MEMBERSHIP_REBIND_SUBMISSION_FORMAT_VERSION
    || submission.signature.length !== 64
  ) {
    throw new TypeError("Human membership rebind submission is malformed");
  }
  humanMembershipRebindSubmissionSigningBytes(submission);
  canonicalSubmissions.set(
    submission,
    serializeHumanMembershipRebindSubmission(submission),
  );
  return submission;
}

export function assertCanonicalHumanMembershipRebindSubmission(
  submission: HumanMembershipRebindSubmission,
): void {
  const snapshot = canonicalSubmissions.get(submission);
  if (
    snapshot === undefined
    || !equalBytes(
      snapshot,
      serializeHumanMembershipRebindSubmission(submission),
    )
  ) {
    throw new TypeError(
      "Human membership rebind submission requires an unchanged canonical creator or decoder",
    );
  }
}

function matchesExpectedHead(
  actual: HumanMembershipRebindExpectedHead,
  expected: HumanMembershipRebindExpectedHead,
): boolean {
  return actual.namespaceId === expected.namespaceId
    && actual.accessRevision === expected.accessRevision
    && equalBytes(actual.bindingHash, expected.bindingHash);
}

function resolveSameActiveCommitter(input: {
  readonly submission: HumanMembershipRebindSubmission;
  readonly resolveSourceCommitter: ResolveHumanMembershipRebindCommitter;
  readonly resolveTargetCommitter: ResolveHumanMembershipRebindCommitter;
}): Uint8Array {
  const context = {
    deviceId: input.submission.committerDeviceId,
    humanId: input.submission.committerHumanId,
  };
  const source = input.resolveSourceCommitter({
    ...context,
    domainId: input.submission.sourceDomainId,
  });
  const target = input.resolveTargetCommitter({
    ...context,
    domainId: input.submission.targetDomainId,
  });
  if (
    source === null
    || target === null
    || source.state !== "active"
    || target.state !== "active"
    || source.deviceId !== context.deviceId
    || target.deviceId !== context.deviceId
    || source.humanId !== context.humanId
    || target.humanId !== context.humanId
    || !(source.signingPublicKey instanceof Uint8Array)
    || !(target.signingPublicKey instanceof Uint8Array)
    || source.signingPublicKey.length !== 32
    || target.signingPublicKey.length !== 32
    || !equalBytes(source.signingPublicKey, target.signingPublicKey)
  ) {
    throw new Error(
      "Human membership rebind requires the same active committer key and Human in both Domains",
    );
  }
  return source.signingPublicKey;
}

export function verifyHumanMembershipRebindSubmission(input: {
  readonly crypto: LatticeCrypto;
  readonly submission: HumanMembershipRebindSubmission;
  readonly expected: VerifyHumanMembershipRebindExpected;
  readonly resolveSourceCommitter: ResolveHumanMembershipRebindCommitter;
  readonly resolveTargetCommitter: ResolveHumanMembershipRebindCommitter;
}): VerifiedHumanMembershipRebindSubmission {
  const submission = input.submission;
  if (
    typeof submission !== "object"
    || submission === null
    || !canonicalSubmissions.has(submission)
  ) {
    throw new TypeError(
      "Human membership rebind submission requires a canonical creator or decoder",
    );
  }
  assertCanonicalHumanMembershipRebindSubmission(submission);
  exactFields(
    "Human membership rebind submission",
    submission,
    SUBMISSION_FIELDS,
  );
  if (
    submission.formatVersion
      !== HUMAN_MEMBERSHIP_REBIND_SUBMISSION_FORMAT_VERSION
    || !(submission.signature instanceof Uint8Array)
    || submission.signature.length !== 64
  ) {
    throw new TypeError("Human membership rebind submission is malformed");
  }
  const candidate = canonicalCandidate(submission.candidate);
  const candidateDigest = humanMembershipRebindCandidateDigest(
    input.crypto,
    candidate,
  );
  if (!equalBytes(candidateDigest, submission.candidateDigest)) {
    throw new Error("Human membership rebind candidate digest is invalid");
  }
  portable("Human membership rebind operation id", input.expected.operationId);
  cryptoDomainId(input.expected.sourceDomainId);
  cryptoDomainId(input.expected.targetDomainId);
  hash(
    "Expected old participant digest",
    input.expected.oldParticipantDigest,
  );
  hash(
    "Expected new participant digest",
    input.expected.newParticipantDigest,
  );
  if (
    submission.operationId !== input.expected.operationId
    || submission.kind !== input.expected.kind
    || submission.sourceDomainId !== input.expected.sourceDomainId
    || submission.targetDomainId !== input.expected.targetDomainId
    || submission.sourceDomainId === submission.targetDomainId
    || candidate.nextHead.domainId !== submission.targetDomainId
    || !equalBytes(
      submission.oldParticipantDigest,
      input.expected.oldParticipantDigest,
    )
    || !equalBytes(
      submission.newParticipantDigest,
      input.expected.newParticipantDigest,
    )
    || equalBytes(
      submission.oldParticipantDigest,
      submission.newParticipantDigest,
    )
    || !matchesExpectedHead(
      candidate.expectedHead,
      input.expected.expectedHead,
    )
  ) {
    throw new Error(
      "Human membership rebind does not match its authoritative transition",
    );
  }
  const committerKey = resolveSameActiveCommitter({
    submission,
    resolveSourceCommitter: input.resolveSourceCommitter,
    resolveTargetCommitter: input.resolveTargetCommitter,
  });
  if (
    !input.crypto.verify(
      committerKey,
      humanMembershipRebindSubmissionSigningBytes(submission),
      submission.signature,
    )
  ) {
    throw new Error("Human membership rebind outer signature is invalid");
  }
  const binding = parseNamespaceBindingV2(
    candidate.binding.signedBindingBytes,
  );
  const humanEnvelope = parseNamespaceKeyringEnvelopeV2(
    candidate.binding.humanKeyringEnvelopeBytes,
  );
  const aiEnvelope = parseNamespaceKeyringEnvelopeV2(
    candidate.binding.aiKeyringEnvelopeBytes,
  );
  if (
    binding.committerDeviceId !== submission.committerDeviceId
    || !input.crypto.verify(
      committerKey,
      namespaceBindingSigningBytesV2(binding),
      binding.signature,
    )
  ) {
    throw new Error("Human membership rebind binding signature is invalid");
  }
  if (
    humanEnvelope.committerDeviceId !== submission.committerDeviceId
    || !input.crypto.verify(
      committerKey,
      namespaceKeyringEnvelopeSigningBytesV2(humanEnvelope),
      humanEnvelope.signature,
    )
  ) {
    throw new Error(
      "Human membership rebind Human keyring envelope signature is invalid",
    );
  }
  if (
    aiEnvelope.committerDeviceId !== submission.committerDeviceId
    || !input.crypto.verify(
      committerKey,
      namespaceKeyringEnvelopeSigningBytesV2(aiEnvelope),
      aiEnvelope.signature,
    )
  ) {
    throw new Error(
      "Human membership rebind AI keyring envelope signature is invalid",
    );
  }
  const verified = Object.freeze({
    ...submission,
    oldParticipantDigest: Uint8Array.from(submission.oldParticipantDigest),
    newParticipantDigest: Uint8Array.from(submission.newParticipantDigest),
    candidateDigest,
    candidate,
    signature: Uint8Array.from(submission.signature),
  }) as VerifiedHumanMembershipRebindSubmission;
  verifiedSubmissions.set(
    verified,
    serializeHumanMembershipRebindSubmission(verified),
  );
  return verified;
}

export function assertVerifiedHumanMembershipRebindSubmission(
  submission: VerifiedHumanMembershipRebindSubmission,
): void {
  const snapshot = verifiedSubmissions.get(submission);
  if (
    snapshot === undefined
    || !equalBytes(
      snapshot,
      serializeHumanMembershipRebindSubmission(submission),
    )
  ) {
    throw new TypeError(
      "Human membership rebind submission is not cryptographically verified",
    );
  }
}
