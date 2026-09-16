import {
  assertPortableId,
  cryptoDeviceId,
  cryptoDomainId,
  humanId,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  decodeProviderRosterV2,
  type ProviderPublicHeadV2,
  type ProviderRosterEntryV2,
} from "@nautilo/lattice-crypto/wire";
import {
  deviceJoinPackageSigningBytes,
  verifyDeviceJoinPackage,
  type DeviceJoinPackageEnvelope,
} from "./device-join-package.ts";
import {
  providerTransitionSubmissionSigningBytes,
  verifyProviderTransitionSubmission,
  type ProviderTransitionSubmission,
  type VerifiedProviderTransitionSubmission,
} from "./provider-transition-submission.ts";

export const HUMAN_MEMBERSHIP_TARGET_DOMAIN_FORMAT_VERSION = 1 as const;
export const HUMAN_MEMBERSHIP_TARGET_DOMAIN_MAX_DEVICES = 256;

export interface HumanMembershipTargetDomainAddition {
  readonly joinPackage: DeviceJoinPackageEnvelope;
  readonly providerSubmission: ProviderTransitionSubmission;
}

export interface HumanMembershipTargetDomainSubmission {
  readonly formatVersion:
    typeof HUMAN_MEMBERSHIP_TARGET_DOMAIN_FORMAT_VERSION;
  readonly operationId: string;
  readonly targetDomainId: string;
  readonly participants: readonly string[];
  readonly participantDigest: Uint8Array;
  readonly committerDeviceId: string;
  readonly committerHumanId: string;
  readonly initialProviderHead: ProviderPublicHeadV2;
  readonly initialRosterBytes: Uint8Array;
  readonly additions: readonly HumanMembershipTargetDomainAddition[];
  readonly chainDigest: Uint8Array;
  readonly signature: Uint8Array;
}

export interface VerifiedHumanMembershipTargetDomain {
  readonly submission: HumanMembershipTargetDomainSubmission;
  readonly initialRoster: readonly ProviderRosterEntryV2[];
  readonly additions: readonly {
    readonly joinPackage: DeviceJoinPackageEnvelope;
    readonly providerSubmission: ProviderTransitionSubmission;
    readonly provider: VerifiedProviderTransitionSubmission;
  }[];
  readonly finalHead: ProviderPublicHeadV2;
  readonly finalRoster: readonly ProviderRosterEntryV2[];
}

export interface HumanMembershipTargetDomainExpectedDevice {
  readonly deviceId: string;
  readonly humanId: string;
  readonly generation: number;
  readonly signingPublicKey: Uint8Array;
}

function u32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("Target Domain counter is invalid");
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function u64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Target Domain counter is unsafe");
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
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameRoster(
  left: readonly ProviderRosterEntryV2[],
  right: readonly HumanMembershipTargetDomainExpectedDevice[],
): boolean {
  if (left.length !== right.length) return false;
  const expected = new Map(right.map((device) => [
    device.deviceId,
    device.humanId,
  ]));
  return left.every((entry) =>
    expected.get(entry.deviceId) === entry.humanId
  );
}

function assertHash(label: string, value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new RangeError(`${label} must be exactly 32 bytes`);
  }
}

function assertSubmissionCoordinates(
  submission: HumanMembershipTargetDomainSubmission,
): void {
  if (
    submission.formatVersion
      !== HUMAN_MEMBERSHIP_TARGET_DOMAIN_FORMAT_VERSION
  ) {
    throw new TypeError("Target Domain submission version is unsupported");
  }
  assertPortableId(
    "Target Domain operation id",
    submission.operationId,
  );
  cryptoDomainId(submission.targetDomainId);
  cryptoDeviceId(submission.committerDeviceId);
  humanId(submission.committerHumanId);
  assertPortableId(
    "Target Domain provider id",
    submission.initialProviderHead.providerId,
  );
  cryptoDomainId(submission.initialProviderHead.domainId);
  submission.participants.forEach((participant) => humanId(participant));
  assertHash("Target Domain participant digest", submission.participantDigest);
  assertHash("Target Domain chain digest", submission.chainDigest);
  assertHash(
    "Target Domain initial provider state hash",
    submission.initialProviderHead.stateHash,
  );
  if (
    !(submission.signature instanceof Uint8Array)
    || submission.signature.length !== 64
    || !(submission.initialRosterBytes instanceof Uint8Array)
    || submission.initialRosterBytes.length < 1
    || submission.participants.length < 1
    || submission.additions.length
      >= HUMAN_MEMBERSHIP_TARGET_DOMAIN_MAX_DEVICES
  ) {
    throw new TypeError("Target Domain submission is malformed");
  }
}

export function humanMembershipTargetDomainChainDigest(input: {
  readonly crypto: Pick<LatticeCrypto, "hash">;
  readonly initialProviderHead: ProviderPublicHeadV2;
  readonly initialRosterBytes: Uint8Array;
  readonly additions: readonly HumanMembershipTargetDomainAddition[];
}): Uint8Array {
  const parts: Uint8Array[] = [
    text("nautilo/lattice-bridge/human-membership-target-domain-chain/v1"),
    text(input.initialProviderHead.providerId),
    text(input.initialProviderHead.domainId),
    u64(input.initialProviderHead.epoch),
    frame(input.initialProviderHead.stateHash),
    frame(input.crypto.hash(input.initialRosterBytes)),
    u32(input.additions.length),
  ];
  for (const addition of input.additions) {
    parts.push(
      frame(input.crypto.hash(
        deviceJoinPackageSigningBytes(addition.joinPackage),
      )),
      frame(addition.joinPackage.signature),
      frame(input.crypto.hash(
        providerTransitionSubmissionSigningBytes(
          addition.providerSubmission,
        ),
      )),
      frame(addition.providerSubmission.signature),
      frame(addition.providerSubmission.transitionDigest),
    );
  }
  return input.crypto.hash(concat(parts));
}

export function humanMembershipTargetDomainSigningBytes(
  submission: Omit<HumanMembershipTargetDomainSubmission, "signature">,
): Uint8Array {
  return concat([
    text("nautilo/lattice-bridge/human-membership-target-domain/v1"),
    u32(submission.formatVersion),
    text(submission.operationId),
    text(submission.targetDomainId),
    u32(submission.participants.length),
    ...submission.participants.map(text),
    frame(submission.participantDigest),
    text(submission.committerDeviceId),
    text(submission.committerHumanId),
    frame(submission.chainDigest),
  ]);
}

/** Digest of the complete signed submission for an exact durable receipt. */
export function humanMembershipTargetDomainSubmissionDigest(input: {
  readonly crypto: Pick<LatticeCrypto, "hash">;
  readonly submission: HumanMembershipTargetDomainSubmission;
}): Uint8Array {
  assertSubmissionCoordinates(input.submission);
  const signingBytes = humanMembershipTargetDomainSigningBytes(
    input.submission,
  );
  const signedBytes = concat([
    frame(signingBytes),
    frame(input.submission.signature),
  ]);
  try {
    return input.crypto.hash(signedBytes);
  } finally {
    signingBytes.fill(0);
    signedBytes.fill(0);
  }
}

export function createHumanMembershipTargetDomainSubmission(input: {
  readonly crypto: LatticeCrypto;
  readonly operationId: string;
  readonly targetDomainId: string;
  readonly participants: readonly string[];
  readonly participantDigest: Uint8Array;
  readonly committerDeviceId: string;
  readonly committerHumanId: string;
  readonly initialProviderHead: ProviderPublicHeadV2;
  readonly initialRosterBytes: Uint8Array;
  readonly additions: readonly HumanMembershipTargetDomainAddition[];
  readonly signingPrivateKey: Uint8Array;
}): HumanMembershipTargetDomainSubmission {
  const additions = Object.freeze(input.additions.map((addition) =>
    Object.freeze({ ...addition })
  ));
  const unsigned = Object.freeze({
    formatVersion: HUMAN_MEMBERSHIP_TARGET_DOMAIN_FORMAT_VERSION,
    operationId: input.operationId,
    targetDomainId: input.targetDomainId,
    participants: Object.freeze([...input.participants]),
    participantDigest: Uint8Array.from(input.participantDigest),
    committerDeviceId: input.committerDeviceId,
    committerHumanId: input.committerHumanId,
    initialProviderHead: Object.freeze({
      ...input.initialProviderHead,
      stateHash: Uint8Array.from(input.initialProviderHead.stateHash),
    }),
    initialRosterBytes: Uint8Array.from(input.initialRosterBytes),
    additions,
    chainDigest: humanMembershipTargetDomainChainDigest({
      crypto: input.crypto,
      initialProviderHead: input.initialProviderHead,
      initialRosterBytes: input.initialRosterBytes,
      additions,
    }),
  });
  const submission = Object.freeze({
    ...unsigned,
    signature: input.crypto.sign(
      input.signingPrivateKey,
      humanMembershipTargetDomainSigningBytes(unsigned),
    ),
  });
  assertSubmissionCoordinates(submission);
  return submission;
}

export function verifyHumanMembershipTargetDomainSubmission(input: {
  readonly crypto: LatticeCrypto;
  readonly submission: HumanMembershipTargetDomainSubmission;
  readonly expected: {
    readonly operationId: string;
    readonly targetDomainId: string;
    readonly participants: readonly string[];
    readonly participantDigest: Uint8Array;
    readonly committerDeviceId: string;
    readonly committerHumanId: string;
    readonly activeDevices:
      readonly HumanMembershipTargetDomainExpectedDevice[];
  };
  readonly now: number;
}): VerifiedHumanMembershipTargetDomain {
  const submission = input.submission;
  assertSubmissionCoordinates(submission);
  const expected = input.expected;
  if (
    submission.operationId !== expected.operationId
    || submission.targetDomainId !== expected.targetDomainId
    || submission.committerDeviceId !== expected.committerDeviceId
    || submission.committerHumanId !== expected.committerHumanId
    || !sameStrings(submission.participants, expected.participants)
    || !equalBytes(submission.participantDigest, expected.participantDigest)
    || submission.initialProviderHead.domainId !== submission.targetDomainId
    || submission.initialProviderHead.epoch !== 0
  ) {
    throw new Error("Target Domain submission coordinates are stale");
  }
  const committer = expected.activeDevices.find(
    (device) => device.deviceId === submission.committerDeviceId,
  );
  if (
    committer === undefined
    || committer.humanId !== submission.committerHumanId
    || committer.signingPublicKey.length !== 32
    || !input.crypto.verify(
      committer.signingPublicKey,
      humanMembershipTargetDomainSigningBytes(submission),
      submission.signature,
    )
  ) {
    throw new Error("Target Domain committer is not authorized");
  }
  const chainDigest = humanMembershipTargetDomainChainDigest({
    crypto: input.crypto,
    initialProviderHead: submission.initialProviderHead,
    initialRosterBytes: submission.initialRosterBytes,
    additions: submission.additions,
  });
  if (!equalBytes(chainDigest, submission.chainDigest)) {
    throw new Error("Target Domain provider chain digest is invalid");
  }
  const initialRoster = decodeProviderRosterV2(
    submission.initialProviderHead.providerId,
    submission.initialRosterBytes,
  );
  if (
    initialRoster.length !== 1
    || initialRoster[0]?.deviceId !== submission.committerDeviceId
    || initialRoster[0]?.humanId !== submission.committerHumanId
  ) {
    throw new Error("Target Domain genesis must contain only the committer");
  }
  let currentHead = submission.initialProviderHead;
  let currentRosterBytes = submission.initialRosterBytes;
  const additions: {
    joinPackage: DeviceJoinPackageEnvelope;
    providerSubmission: ProviderTransitionSubmission;
    provider: VerifiedProviderTransitionSubmission;
  }[] = [];
  const addedDevices = new Set([submission.committerDeviceId]);
  for (const addition of submission.additions) {
    const device = expected.activeDevices.find(
      (candidate) => candidate.deviceId === addition.joinPackage.deviceId,
    );
    if (device === undefined || addedDevices.has(device.deviceId)) {
      throw new Error("Target Domain chain has an unexpected device");
    }
    const joinPackage = verifyDeviceJoinPackage({
      crypto: input.crypto,
      envelope: addition.joinPackage,
      now: input.now,
      resolveDevice: (deviceId) => deviceId === device.deviceId
        ? {
          state: "active",
          humanId: device.humanId,
          generation: device.generation,
          signingPublicKey: device.signingPublicKey,
        }
        : null,
      resolveProviderHead: (domainId) =>
        domainId === submission.targetDomainId ? currentHead : null,
    });
    const provider = verifyProviderTransitionSubmission({
      crypto: input.crypto,
      submission: addition.providerSubmission,
      expectation: {
        operationId: submission.operationId,
        operationKind: "human_add",
        domainId: submission.targetDomainId,
        targetHumanId: device.humanId,
        targetDeviceId: device.deviceId,
        expectedEpoch: currentHead.epoch,
        targetEpoch: currentHead.epoch + 1,
        expectedAuthorizationRevision: 0,
        expectedParticipantDigest: submission.participantDigest,
        committerDeviceId: submission.committerDeviceId,
      },
      currentProviderState: {
        head: currentHead,
        rosterBytes: currentRosterBytes,
      },
      resolveActiveCommitter: (deviceId) =>
        deviceId === committer.deviceId
          ? {
            state: "active",
            humanId: committer.humanId,
            signingPublicKey: committer.signingPublicKey,
          }
          : null,
    });
    if (
      joinPackage.domainId !== provider.transition.domainId
      || joinPackage.humanId !== provider.transition.targetHumanId
      || joinPackage.deviceId !== provider.transition.targetDeviceId
      || joinPackage.providerId !== provider.transition.expectedHead.providerId
      || joinPackage.expectedEpoch !== provider.transition.expectedHead.epoch
      || !equalBytes(
        joinPackage.expectedProviderHeadHash,
        provider.transition.expectedHead.stateHash,
      )
    ) {
      throw new Error("Target Domain join package and transition disagree");
    }
    addedDevices.add(device.deviceId);
    additions.push({
      joinPackage,
      providerSubmission: addition.providerSubmission,
      provider,
    });
    currentHead = provider.transition.nextHead;
    currentRosterBytes = provider.transition.rosterBytes;
  }
  const finalRoster = decodeProviderRosterV2(
    currentHead.providerId,
    currentRosterBytes,
  );
  if (
    !sameRoster(finalRoster, expected.activeDevices)
    || addedDevices.size !== expected.activeDevices.length
  ) {
    throw new Error("Target Domain final roster is not the active inventory");
  }
  return Object.freeze({
    submission,
    initialRoster,
    additions: Object.freeze(additions),
    finalHead: currentHead,
    finalRoster,
  });
}
