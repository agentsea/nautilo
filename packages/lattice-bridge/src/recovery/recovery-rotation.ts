import {
  humanId,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  decodeHumanRecoveryArchiveV2,
  humanRecoveryArchiveSigningBytesV2,
  recoveryPublicKeyDigestV2,
  serializeHumanRecoveryArchiveV2,
  type HumanRecoveryArchiveV2,
} from "@nautilo/lattice-crypto/wire";

export const RECOVERY_ROTATION_SUBMISSION_FORMAT_VERSION = 1 as const;

export interface RecoveryRotationSubmission {
  readonly formatVersion:
    typeof RECOVERY_ROTATION_SUBMISSION_FORMAT_VERSION;
  readonly expectedCustodyRevision: number;
  readonly expectedRecoveryGeneration: number;
  readonly expectedIssuerDeviceRevision: number;
  readonly expectedInventoryRevision: number | null;
  readonly expectedInventoryCount: number | null;
  readonly expectedInventoryDigest: Uint8Array | null;
  readonly recoveryPublicKey: Uint8Array;
  readonly archiveBytes: Uint8Array;
  readonly signature: Uint8Array;
}

export interface VerifiedRecoveryRotationSubmission {
  readonly humanId: string;
  readonly expectedCustodyRevision: number;
  readonly expectedRecoveryGeneration: number;
  readonly expectedIssuerDeviceRevision: number;
  readonly expectedInventoryRevision: number | null;
  readonly expectedInventoryCount: number | null;
  readonly expectedInventoryDigest: Uint8Array | null;
  readonly recoveryGeneration: number;
  readonly recoveryKeyId: string;
  readonly recoveryPublicKey: Uint8Array;
  readonly recoveryPublicKeyDigest: Uint8Array;
  readonly archive: HumanRecoveryArchiveV2;
  readonly archiveBytes: Uint8Array;
  readonly archiveHash: Uint8Array;
  readonly issuerDeviceId: string;
  readonly createdAt: number;
}

export type ResolveActiveRecoveryRotationIssuer = (
  deviceId: string,
) => {
  readonly state: "active";
  readonly humanId: string;
  readonly revision: number;
  readonly signingPublicKey: Uint8Array;
} | null;

const SUBMISSION_FIELDS = Object.freeze([
  "formatVersion",
  "expectedCustodyRevision",
  "expectedRecoveryGeneration",
  "expectedIssuerDeviceRevision",
  "expectedInventoryRevision",
  "expectedInventoryCount",
  "expectedInventoryDigest",
  "recoveryPublicKey",
  "archiveBytes",
  "signature",
].sort());

const textEncoder = new TextEncoder();

function u32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("Recovery rotation counter is invalid");
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function u64(value: number): Uint8Array {
  safeCounter("Recovery rotation counter", value);
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

function text(value: string): Uint8Array {
  return frame(textEncoder.encode(value));
}

function safeCounter(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a nonnegative safe integer`);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function canonicalInventory(
  revision: number | null,
  count: number | null,
  digest: Uint8Array | null,
): {
  readonly revision: number | null;
  readonly count: number | null;
  readonly digest: Uint8Array | null;
} {
  if (revision === null && count === null && digest === null) {
    return { revision: null, count: null, digest: null };
  }
  if (
    revision === null
    || count === null
    || digest === null
    || !(digest instanceof Uint8Array)
    || digest.length !== 32
  ) {
    throw new TypeError(
      "Recovery rotation inventory coordinates must be all null or complete",
    );
  }
  safeCounter("Expected inventory revision", revision);
  safeCounter("Expected inventory count", count);
  if (count < 1 || count > 4_096) {
    throw new RangeError(
      "Expected recovery rotation inventory count is out of range",
    );
  }
  return {
    revision,
    count,
    digest: Uint8Array.from(digest),
  };
}

function canonicalSubmission(
  submission: RecoveryRotationSubmission,
): {
  readonly submission: RecoveryRotationSubmission;
  readonly archive: HumanRecoveryArchiveV2;
} {
  if (
    typeof submission !== "object"
    || submission === null
    || Object.keys(submission).length !== SUBMISSION_FIELDS.length
    || Object.keys(submission).sort().some(
      (field, index) => field !== SUBMISSION_FIELDS[index],
    )
    || submission.formatVersion
      !== RECOVERY_ROTATION_SUBMISSION_FORMAT_VERSION
    || !(submission.recoveryPublicKey instanceof Uint8Array)
    || !(submission.archiveBytes instanceof Uint8Array)
    || !(submission.signature instanceof Uint8Array)
    || submission.signature.length !== 64
  ) {
    throw new TypeError("Recovery rotation submission fields are malformed");
  }
  safeCounter(
    "Expected custody revision",
    submission.expectedCustodyRevision,
  );
  safeCounter(
    "Expected recovery generation",
    submission.expectedRecoveryGeneration,
  );
  if (
    submission.expectedCustodyRevision === Number.MAX_SAFE_INTEGER
    || submission.expectedRecoveryGeneration === Number.MAX_SAFE_INTEGER
  ) {
    throw new RangeError(
      "Recovery rotation cannot advance an exhausted revision counter",
    );
  }
  safeCounter(
    "Expected issuer-device revision",
    submission.expectedIssuerDeviceRevision,
  );
  const inventory = canonicalInventory(
    submission.expectedInventoryRevision,
    submission.expectedInventoryCount,
    submission.expectedInventoryDigest,
  );
  recoveryPublicKeyDigestV2(submission.recoveryPublicKey);
  const archive = decodeHumanRecoveryArchiveV2(submission.archiveBytes);
  const canonicalBytes = serializeHumanRecoveryArchiveV2(archive);
  if (!equalBytes(canonicalBytes, submission.archiveBytes)) {
    throw new Error("Recovery rotation archive is not canonical");
  }
  if ((inventory.count ?? 0) !== archive.packages.length) {
    throw new Error(
      "Recovery rotation archive does not match its inventory count",
    );
  }
  return {
    submission: Object.freeze({
      formatVersion: RECOVERY_ROTATION_SUBMISSION_FORMAT_VERSION,
      expectedCustodyRevision: submission.expectedCustodyRevision,
      expectedRecoveryGeneration: submission.expectedRecoveryGeneration,
      expectedIssuerDeviceRevision:
        submission.expectedIssuerDeviceRevision,
      expectedInventoryRevision: inventory.revision,
      expectedInventoryCount: inventory.count,
      expectedInventoryDigest: inventory.digest,
      recoveryPublicKey: Uint8Array.from(submission.recoveryPublicKey),
      archiveBytes: Uint8Array.from(canonicalBytes),
      signature: Uint8Array.from(submission.signature),
    }),
    archive,
  };
}

export function recoveryRotationSubmissionSigningBytes(
  crypto: Pick<LatticeCrypto, "hash">,
  submission: Omit<RecoveryRotationSubmission, "signature">,
): Uint8Array {
  safeCounter(
    "Expected custody revision",
    submission.expectedCustodyRevision,
  );
  safeCounter(
    "Expected recovery generation",
    submission.expectedRecoveryGeneration,
  );
  safeCounter(
    "Expected issuer-device revision",
    submission.expectedIssuerDeviceRevision,
  );
  const inventory = canonicalInventory(
    submission.expectedInventoryRevision,
    submission.expectedInventoryCount,
    submission.expectedInventoryDigest,
  );
  const inventoryParts = inventory.revision === null
    ? [u32(0)]
    : [
      u32(1),
      u64(inventory.revision),
      u32(inventory.count!),
      frame(inventory.digest!),
    ];
  return concat([
    text("nautilo/lattice-bridge/recovery-rotation/v1"),
    u32(submission.formatVersion),
    u64(submission.expectedCustodyRevision),
    u64(submission.expectedRecoveryGeneration),
    u64(submission.expectedIssuerDeviceRevision),
    ...inventoryParts,
    frame(recoveryPublicKeyDigestV2(submission.recoveryPublicKey)),
    frame(crypto.hash(submission.archiveBytes)),
  ]);
}

export function createRecoveryRotationSubmission(input: {
  readonly crypto: LatticeCrypto;
  readonly expectedCustodyRevision: number;
  readonly expectedRecoveryGeneration: number;
  readonly expectedIssuerDeviceRevision: number;
  readonly expectedInventoryRevision: number | null;
  readonly expectedInventoryCount: number | null;
  readonly expectedInventoryDigest: Uint8Array | null;
  readonly recoveryPublicKey: Uint8Array;
  readonly archiveBytes: Uint8Array;
  readonly issuerSigningPrivateKey: Uint8Array;
}): RecoveryRotationSubmission {
  const unsigned = {
    formatVersion: RECOVERY_ROTATION_SUBMISSION_FORMAT_VERSION,
    expectedCustodyRevision: input.expectedCustodyRevision,
    expectedRecoveryGeneration: input.expectedRecoveryGeneration,
    expectedIssuerDeviceRevision: input.expectedIssuerDeviceRevision,
    expectedInventoryRevision: input.expectedInventoryRevision,
    expectedInventoryCount: input.expectedInventoryCount,
    expectedInventoryDigest: input.expectedInventoryDigest,
    recoveryPublicKey: input.recoveryPublicKey,
    archiveBytes: input.archiveBytes,
  } as const;
  const { submission } = canonicalSubmission({
    ...unsigned,
    signature: input.crypto.sign(
      input.issuerSigningPrivateKey,
      recoveryRotationSubmissionSigningBytes(input.crypto, unsigned),
    ),
  });
  return submission;
}

export function normalizeRecoveryRotationSubmission(
  submission: RecoveryRotationSubmission,
): RecoveryRotationSubmission {
  return canonicalSubmission(submission).submission;
}

export function verifyRecoveryRotationSubmission(input: {
  readonly crypto: LatticeCrypto;
  readonly submission: RecoveryRotationSubmission;
  readonly expectedHumanId: string;
  readonly currentCustodyRevision: number;
  readonly currentRecoveryGeneration: number;
  readonly resolveActiveIssuer: ResolveActiveRecoveryRotationIssuer;
}): VerifiedRecoveryRotationSubmission {
  const { submission, archive } = canonicalSubmission(input.submission);
  const expectedHumanId = humanId(input.expectedHumanId);
  safeCounter("Current custody revision", input.currentCustodyRevision);
  safeCounter("Current recovery generation", input.currentRecoveryGeneration);
  const publicKeyDigest = recoveryPublicKeyDigestV2(
    submission.recoveryPublicKey,
  );
  if (
    submission.expectedCustodyRevision !== input.currentCustodyRevision
    || submission.expectedRecoveryGeneration
      !== input.currentRecoveryGeneration
    || archive.humanId !== expectedHumanId
    || archive.recoveryGeneration !== input.currentRecoveryGeneration + 1
  ) {
    throw new Error(
      "Recovery rotation generation or custody revision is stale",
    );
  }
  if (!equalBytes(archive.recoveryPublicKeyDigest, publicKeyDigest)) {
    throw new Error(
      "Recovery rotation public key does not match its signed archive",
    );
  }
  const issuer = input.resolveActiveIssuer(archive.issuerDeviceId);
  const {
    signature: _signature,
    ...unsignedSubmission
  } = submission;
  if (
    issuer === null
    || issuer.state !== "active"
    || issuer.humanId !== expectedHumanId
    || issuer.revision !== submission.expectedIssuerDeviceRevision
    || !(issuer.signingPublicKey instanceof Uint8Array)
    || issuer.signingPublicKey.length !== 32
    || !input.crypto.verify(
      issuer.signingPublicKey,
      recoveryRotationSubmissionSigningBytes(
        input.crypto,
        unsignedSubmission,
      ),
      submission.signature,
    )
    || !input.crypto.verify(
      issuer.signingPublicKey,
      humanRecoveryArchiveSigningBytesV2(archive),
      archive.signature,
    )
  ) {
    throw new Error(
      "Recovery rotation issuer is not currently authorized",
    );
  }
  return Object.freeze({
    humanId: expectedHumanId,
    expectedCustodyRevision: submission.expectedCustodyRevision,
    expectedRecoveryGeneration: submission.expectedRecoveryGeneration,
    expectedIssuerDeviceRevision: submission.expectedIssuerDeviceRevision,
    expectedInventoryRevision: submission.expectedInventoryRevision,
    expectedInventoryCount: submission.expectedInventoryCount,
    expectedInventoryDigest: submission.expectedInventoryDigest === null
      ? null
      : Uint8Array.from(submission.expectedInventoryDigest),
    recoveryGeneration: archive.recoveryGeneration,
    recoveryKeyId: archive.recoveryKeyId,
    recoveryPublicKey: Uint8Array.from(submission.recoveryPublicKey),
    recoveryPublicKeyDigest: Uint8Array.from(publicKeyDigest),
    archive,
    archiveBytes: Uint8Array.from(submission.archiveBytes),
    archiveHash: input.crypto.hash(submission.archiveBytes),
    issuerDeviceId: archive.issuerDeviceId,
    createdAt: archive.createdAt,
  });
}
