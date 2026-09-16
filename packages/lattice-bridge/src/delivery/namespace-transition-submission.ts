import {
  cryptoDeviceId,
  cryptoDomainId,
  namespaceId,
  type LatticeCrypto,
  type PreparedDomainEpochAdvance,
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
import {
  MAX_NAMESPACES_PER_DOMAIN_TRANSITION,
  type DeviceFanoutDomainPlan,
} from "./device-fanout.ts";
import type {
  ResolveActiveTransitionCommitter,
} from "./provider-transition-submission.ts";

export const NAMESPACE_TRANSITION_SUBMISSION_FORMAT_VERSION = 1 as const;
export const NAMESPACE_TRANSITION_SUBMISSION_MAX_BYTES = 67_108_864;

export interface NamespaceTransitionExpectedHead {
  readonly namespaceId: string;
  readonly accessRevision: number;
  readonly bindingHash: Uint8Array;
}

export interface NamespaceTransitionCandidate {
  readonly expectedHead: NamespaceTransitionExpectedHead;
  readonly nextHead: NamespaceHeadV2;
  readonly binding: NamespaceBindingWireRecordV2;
}

export interface NamespaceTransitionSubmission {
  readonly formatVersion:
    typeof NAMESPACE_TRANSITION_SUBMISSION_FORMAT_VERSION;
  readonly operationId: string;
  readonly domainId: string;
  readonly committerDeviceId: string;
  readonly providerTransitionDigest: Uint8Array;
  readonly candidatesDigest: Uint8Array;
  readonly candidates: readonly NamespaceTransitionCandidate[];
  readonly signature: Uint8Array;
}

export interface VerifiedNamespaceTransitionSubmission {
  readonly operationId: string;
  readonly domainId: string;
  readonly committerDeviceId: string;
  readonly providerTransitionDigest: Uint8Array;
  readonly candidatesDigest: Uint8Array;
  readonly candidates: readonly NamespaceTransitionCandidate[];
}

const SUBMISSION_FIELDS = Object.freeze([
  "formatVersion",
  "operationId",
  "domainId",
  "committerDeviceId",
  "providerTransitionDigest",
  "candidatesDigest",
  "candidates",
  "signature",
].sort());
const CANDIDATE_FIELDS = Object.freeze([
  "expectedHead",
  "nextHead",
  "binding",
].sort());
const EXPECTED_HEAD_FIELDS = Object.freeze([
  "namespaceId",
  "accessRevision",
  "bindingHash",
].sort());

class SubmissionReader {
  #offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  u32(): number {
    if (this.#offset + 4 > this.bytes.length) {
      throw new RangeError("Namespace transition submission is truncated");
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
      throw new RangeError("Namespace transition submission is truncated");
    }
    const value = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.byteLength,
    ).getBigUint64(this.#offset);
    this.#offset += 8;
    const normalized = Number(value);
    if (!Number.isSafeInteger(normalized)) {
      throw new RangeError("Namespace transition counter is unsafe");
    }
    return normalized;
  }

  frame(maximum: number): Uint8Array {
    const length = this.u32();
    if (length > maximum || this.#offset + length > this.bytes.length) {
      throw new RangeError(
        "Namespace transition submission frame is out of bounds",
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
        "Namespace transition submission has trailing bytes",
      );
    }
  }
}

function u32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("Namespace transition counter is invalid");
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function u64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Namespace transition counter is unsafe");
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

function compareUtf8(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index++) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function optionalHash(value: Uint8Array | null): Uint8Array {
  return value === null
    ? u32(0)
    : concat([u32(1), frame(value)]);
}

function encodeExpectedHead(
  head: NamespaceTransitionExpectedHead,
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
  candidate: NamespaceTransitionCandidate,
): Uint8Array {
  return concat([
    encodeExpectedHead(candidate.expectedHead),
    encodeNextHead(candidate.nextHead),
    encodeBinding(candidate.binding),
  ]);
}

function canonicalCandidate(
  candidate: NamespaceTransitionCandidate,
): NamespaceTransitionCandidate {
  if (
    typeof candidate !== "object"
    || candidate === null
  ) {
    throw new TypeError("Namespace transition candidate is malformed");
  }
  exactFields("Namespace transition candidate", candidate, CANDIDATE_FIELDS);
  exactFields(
    "Namespace transition expected head",
    candidate.expectedHead,
    EXPECTED_HEAD_FIELDS,
  );
  const expectedNamespaceId = namespaceId(
    candidate.expectedHead.namespaceId,
  );
  u64(candidate.expectedHead.accessRevision);
  hash(
    "Namespace transition expected binding hash",
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
  ) {
    throw new Error(
      "Namespace transition candidate coordinates are inconsistent",
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

function canonicalCandidates(
  candidates: readonly NamespaceTransitionCandidate[],
): readonly NamespaceTransitionCandidate[] {
  if (
    !Array.isArray(candidates)
    || candidates.length > MAX_NAMESPACES_PER_DOMAIN_TRANSITION
  ) {
    throw new RangeError("Namespace transition candidate count is invalid");
  }
  const canonical = candidates.map(canonicalCandidate);
  for (let index = 1; index < canonical.length; index++) {
    if (
      compareUtf8(
        canonical[index - 1]!.nextHead.namespaceId,
        canonical[index]!.nextHead.namespaceId,
      ) >= 0
    ) {
      throw new Error(
        "Namespace transition candidates must be unique and canonically ordered",
      );
    }
  }
  return Object.freeze(canonical);
}

function candidateDigestBytes(
  candidates: readonly NamespaceTransitionCandidate[],
): Uint8Array {
  return concat([
    text("nautilo/lattice-bridge/namespace-transition-candidates/v1"),
    u32(candidates.length),
    ...candidates.map(encodeCandidate),
  ]);
}

export function namespaceTransitionCandidatesDigest(
  crypto: LatticeCrypto,
  candidates: readonly NamespaceTransitionCandidate[],
): Uint8Array {
  return crypto.hash(candidateDigestBytes(canonicalCandidates(candidates)));
}

export function namespaceTransitionSubmissionSigningBytes(
  submission: Omit<
    NamespaceTransitionSubmission,
    "signature" | "candidates"
  >,
): Uint8Array {
  portable("Namespace transition operation id", submission.operationId);
  cryptoDomainId(submission.domainId);
  cryptoDeviceId(submission.committerDeviceId);
  hash(
    "Namespace transition provider transition digest",
    submission.providerTransitionDigest,
  );
  hash(
    "Namespace transition candidates digest",
    submission.candidatesDigest,
  );
  return concat([
    text("nautilo/lattice-bridge/namespace-transition-submission/v1"),
    u32(submission.formatVersion),
    text(submission.operationId),
    text(submission.domainId),
    text(submission.committerDeviceId),
    frame(submission.providerTransitionDigest),
    frame(submission.candidatesDigest),
  ]);
}

export function createNamespaceTransitionSubmission(input: {
  readonly crypto: LatticeCrypto;
  readonly operationId: string;
  readonly committerDeviceId: string;
  readonly providerTransitionDigest: Uint8Array;
  readonly prepared: PreparedDomainEpochAdvance;
  readonly signingPrivateKey: Uint8Array;
}): NamespaceTransitionSubmission {
  const domainId = cryptoDomainId(input.prepared.domainId);
  const candidates = canonicalCandidates(
    input.prepared.namespaces.map((candidate) => ({
      expectedHead: candidate.expectedHead,
      nextHead: candidate.nextHead,
      binding: storageAdapterSupportV2.validateNamespaceBinding(
        candidate.bindingRecord,
      ),
    })),
  );
  const unsigned = Object.freeze({
    formatVersion: NAMESPACE_TRANSITION_SUBMISSION_FORMAT_VERSION,
    operationId: input.operationId,
    domainId,
    committerDeviceId: input.committerDeviceId,
    providerTransitionDigest: Uint8Array.from(
      input.providerTransitionDigest,
    ),
    candidatesDigest: input.crypto.hash(
      candidateDigestBytes(candidates),
    ),
  });
  return Object.freeze({
    ...unsigned,
    candidates,
    signature: input.crypto.sign(
      input.signingPrivateKey,
      namespaceTransitionSubmissionSigningBytes(unsigned),
    ),
  });
}

export function serializeNamespaceTransitionSubmission(
  submission: NamespaceTransitionSubmission,
): Uint8Array {
  const candidates = canonicalCandidates(submission.candidates);
  if (
    submission.formatVersion
      !== NAMESPACE_TRANSITION_SUBMISSION_FORMAT_VERSION
    || !(submission.signature instanceof Uint8Array)
    || submission.signature.length !== 64
  ) {
    throw new TypeError("Namespace transition submission is malformed");
  }
  namespaceTransitionSubmissionSigningBytes(submission);
  const bytes = concat([
    text("nautilo/lattice-bridge/namespace-transition-submission/v1"),
    u32(submission.formatVersion),
    text(submission.operationId),
    text(submission.domainId),
    text(submission.committerDeviceId),
    frame(submission.providerTransitionDigest),
    frame(submission.candidatesDigest),
    frame(submission.signature),
    u32(candidates.length),
    ...candidates.map(encodeCandidate),
  ]);
  if (bytes.length > NAMESPACE_TRANSITION_SUBMISSION_MAX_BYTES) {
    throw new RangeError("Namespace transition submission exceeds its limit");
  }
  return bytes;
}

function decodeExpectedHead(
  reader: SubmissionReader,
): NamespaceTransitionExpectedHead {
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
    throw new TypeError("Namespace transition optional hash is malformed");
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
      NAMESPACE_TRANSITION_SUBMISSION_MAX_BYTES,
    ),
    humanKeyringEnvelopeBytes: reader.frame(
      NAMESPACE_TRANSITION_SUBMISSION_MAX_BYTES,
    ),
    aiKeyringEnvelopeBytes: reader.frame(
      NAMESPACE_TRANSITION_SUBMISSION_MAX_BYTES,
    ),
  });
}

export function decodeNamespaceTransitionSubmission(
  bytes: Uint8Array,
): NamespaceTransitionSubmission {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length < 1
    || bytes.length > NAMESPACE_TRANSITION_SUBMISSION_MAX_BYTES
  ) {
    throw new RangeError("Namespace transition submission bytes are invalid");
  }
  const reader = new SubmissionReader(bytes);
  if (
    reader.text()
      !== "nautilo/lattice-bridge/namespace-transition-submission/v1"
  ) {
    throw new TypeError("Namespace transition submission domain is invalid");
  }
  const formatVersion = reader.u32();
  const operationId = reader.text();
  const domainId = reader.text();
  const committerDeviceId = reader.text();
  const providerTransitionDigest = reader.frame(32);
  const candidatesDigest = reader.frame(32);
  const signature = reader.frame(64);
  const candidateCount = reader.u32();
  if (candidateCount > MAX_NAMESPACES_PER_DOMAIN_TRANSITION) {
    throw new RangeError("Namespace transition candidate count is invalid");
  }
  const candidates = Array.from(
    { length: candidateCount },
    () =>
      canonicalCandidate({
        expectedHead: decodeExpectedHead(reader),
        nextHead: decodeNextHead(reader),
        binding: decodeBinding(reader),
      }),
  );
  reader.finish();
  const submission = Object.freeze({
    formatVersion,
    operationId,
    domainId,
    committerDeviceId,
    providerTransitionDigest,
    candidatesDigest,
    candidates: Object.freeze(candidates),
    signature,
  }) as NamespaceTransitionSubmission;
  if (
    submission.formatVersion
      !== NAMESPACE_TRANSITION_SUBMISSION_FORMAT_VERSION
    || submission.providerTransitionDigest.length !== 32
    || submission.candidatesDigest.length !== 32
    || submission.signature.length !== 64
  ) {
    throw new TypeError("Namespace transition submission is malformed");
  }
  namespaceTransitionSubmissionSigningBytes(submission);
  canonicalCandidates(submission.candidates);
  return submission;
}

export function verifyNamespaceTransitionSubmission(input: {
  readonly crypto: LatticeCrypto;
  readonly submission: NamespaceTransitionSubmission;
  readonly operationId: string;
  readonly domainPlan: DeviceFanoutDomainPlan;
  readonly providerTransitionDigest: Uint8Array;
  readonly resolveActiveCommitter: ResolveActiveTransitionCommitter;
}): VerifiedNamespaceTransitionSubmission {
  const submission = input.submission;
  if (
    typeof submission !== "object"
    || submission === null
    || Object.keys(submission).length !== SUBMISSION_FIELDS.length
    || Object.keys(submission).sort().some(
      (field, index) => field !== SUBMISSION_FIELDS[index],
    )
    || submission.formatVersion
      !== NAMESPACE_TRANSITION_SUBMISSION_FORMAT_VERSION
    || !(submission.signature instanceof Uint8Array)
    || submission.signature.length !== 64
  ) {
    throw new TypeError("Namespace transition submission fields are malformed");
  }
  portable("Namespace transition operation id", input.operationId);
  const plan = input.domainPlan;
  cryptoDomainId(plan.domainId);
  if (
    plan.committerDeviceId === null
    || submission.operationId !== input.operationId
    || submission.domainId !== plan.domainId
    || submission.committerDeviceId !== plan.committerDeviceId
    || plan.targetEpoch !== plan.expectedEpoch + 1
    || !equalBytes(
      submission.providerTransitionDigest,
      input.providerTransitionDigest,
    )
  ) {
    throw new Error(
      "Namespace transition does not match its provider transition",
    );
  }
  const candidates = canonicalCandidates(submission.candidates);
  const candidatesDigest = input.crypto.hash(
    candidateDigestBytes(candidates),
  );
  if (!equalBytes(candidatesDigest, submission.candidatesDigest)) {
    throw new Error("Namespace transition candidates digest is invalid");
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
      namespaceTransitionSubmissionSigningBytes(submission),
      submission.signature,
    )
  ) {
    throw new Error("Namespace transition committer is not authorized");
  }
  if (candidates.length !== plan.namespaces.length) {
    throw new Error("Namespace transition does not match its Namespace plan");
  }
  for (const [index, candidate] of candidates.entries()) {
    const expected = plan.namespaces[index];
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
      expected === undefined
      || candidate.expectedHead.namespaceId !== expected.namespaceId
      || candidate.expectedHead.accessRevision
        !== expected.expectedAccessRevision
      || !equalBytes(
        candidate.expectedHead.bindingHash,
        expected.expectedBindingHash,
      )
      || candidate.nextHead.domainId !== plan.domainId
      || candidate.nextHead.domainEpoch !== plan.targetEpoch
      || binding.committerDeviceId !== submission.committerDeviceId
      || humanEnvelope.committerDeviceId !== submission.committerDeviceId
      || aiEnvelope.committerDeviceId !== submission.committerDeviceId
      || !input.crypto.verify(
        committer.signingPublicKey,
        namespaceBindingSigningBytesV2(binding),
        binding.signature,
      )
      || !input.crypto.verify(
        committer.signingPublicKey,
        namespaceKeyringEnvelopeSigningBytesV2(humanEnvelope),
        humanEnvelope.signature,
      )
      || !input.crypto.verify(
        committer.signingPublicKey,
        namespaceKeyringEnvelopeSigningBytesV2(aiEnvelope),
        aiEnvelope.signature,
      )
    ) {
      throw new Error(
        "Namespace transition candidate does not match its plan or committer",
      );
    }
  }
  return Object.freeze({
    operationId: submission.operationId,
    domainId: submission.domainId,
    committerDeviceId: submission.committerDeviceId,
    providerTransitionDigest: Uint8Array.from(
      submission.providerTransitionDigest,
    ),
    candidatesDigest,
    candidates,
  });
}
