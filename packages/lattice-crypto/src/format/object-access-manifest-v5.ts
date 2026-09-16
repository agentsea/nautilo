import { bytesToHex } from "@noble/hashes/utils.js";

import {
  agentRuntimeObjectSignerKeyIdV1,
  normalizeAgentRuntimeObjectSignerPrincipalV1,
  signAgentRuntimeObjectBytesV1,
  type AgentRuntimeObjectSignerPrincipalV1,
} from "../agent-runtime/object-signer-v1.ts";
import type { AgentRuntimeGenerationV2 } from "../agent-runtime/types.ts";
import {
  normalizeProcessorObjectSignerPrincipalV1,
  signProcessorObjectBytesV1,
  verifyProcessorObjectBytesV1,
  type ProcessorObjectSignerPrincipalV1,
} from "../background/processor-object-signer-v1.ts";
import {
  verifyCurrentProcessorSignerAuthorizationV1,
  verifyHistoricalProcessorSignerAuthorizationV1,
  type ProcessorSignerAuthorizationAuthorityContextV1,
  type ResolveCurrentProcessorSignerIssuingDevicePublicKeyV1,
  type VerifiedProcessorSignerAuthorizationV1,
} from "../background/processor-signer-authorization-v1.ts";
import type { LatticeCrypto } from "../crypto/index.ts";
import {
  destroyVerifiedProcessorSignerAuthorizationV2,
  readProcessorSignerAuthorizationVersion,
  verifyHistoricalProcessorSignerAuthorizationV2,
  verifyProcessorSignerAuthorizationV2,
  type ResolveHistoricalBackgroundAuthorizationIssuerV2,
  type VerifiedProcessorSignerAuthorizationV2,
} from "../background/processor-authorization-v2.ts";
import { assertCurrentProcessorAuthorizationBoundaryV4 } from "./object-access-manifest-v4.ts";
import { compareUnsignedUtf8 } from "../domain/participants.ts";
import {
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  objectId,
  type AccessRevision,
  type AuthorizationRevision,
  type CryptoDeviceId,
  type HumanId,
  type ObjectId,
} from "../v2-types/ids.ts";
import { V2_LIMITS, assertV2Limit } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import {
  CanonicalDecodingError,
  StrictDecoder,
  concatV2,
  encodeU32,
  encodeU64,
  frame,
  frameText,
  utf8V2,
} from "./v2-primitives.ts";

export const OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V5 = 5 as const;
export const OBJECT_ACCESS_MANIFEST_DOMAIN_V5 =
  "nautilo/lattice-crypto/object-access-manifest/v5";

const HASH_BYTES = 32;
const HUMAN_DEVICE_SIGNER_KIND = "human_device";
const AGENT_RUNTIME_SIGNER_KIND = "agent_runtime";
const PROCESSOR_INVOCATION_SIGNER_KIND = "processor_invocation";
const PROCESSOR_KIND = "stenographer";
const FRAME_LENGTH_BYTES = 4;

export interface HumanDeviceObjectSignerPrincipalV5 {
  readonly kind: "human_device";
  readonly subjectHumanId: HumanId;
  readonly committerDeviceId: CryptoDeviceId;
}

export type ObjectAccessManifestSignerV5 =
  | HumanDeviceObjectSignerPrincipalV5
  | AgentRuntimeObjectSignerPrincipalV1
  | ProcessorObjectSignerPrincipalV1;

const MAX_SIGNER_WIRE_BYTES = Math.max(
  FRAME_LENGTH_BYTES + utf8V2(HUMAN_DEVICE_SIGNER_KIND).length
    + FRAME_LENGTH_BYTES + V2_LIMITS.idBytes
    + FRAME_LENGTH_BYTES + V2_LIMITS.idBytes,
  FRAME_LENGTH_BYTES + utf8V2(AGENT_RUNTIME_SIGNER_KIND).length
    + FRAME_LENGTH_BYTES + V2_LIMITS.idBytes
    + 8
    + FRAME_LENGTH_BYTES + V2_LIMITS.idBytes,
  FRAME_LENGTH_BYTES + utf8V2(PROCESSOR_INVOCATION_SIGNER_KIND).length
    + FRAME_LENGTH_BYTES + utf8V2(PROCESSOR_KIND).length
    + 4
    + FRAME_LENGTH_BYTES + V2_LIMITS.idBytes
    + FRAME_LENGTH_BYTES + HASH_BYTES
    + FRAME_LENGTH_BYTES + V2_LIMITS.idBytes,
);

export const MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5 =
  FRAME_LENGTH_BYTES + utf8V2(OBJECT_ACCESS_MANIFEST_DOMAIN_V5).length
  + 4
  + FRAME_LENGTH_BYTES + V2_LIMITS.idBytes
  + FRAME_LENGTH_BYTES + HASH_BYTES
  + 8
  + 4
  + FRAME_LENGTH_BYTES + HASH_BYTES
  + 4
  + V2_LIMITS.namespaceEnvelopesPerManifest
    * (FRAME_LENGTH_BYTES + HASH_BYTES)
  + MAX_SIGNER_WIRE_BYTES
  + 4
  + FRAME_LENGTH_BYTES + HASH_BYTES
  + 8
  + FRAME_LENGTH_BYTES + V2_LIMITS.signatureBytes;

export interface ObjectAccessManifestUnsignedV5 {
  readonly objectId: ObjectId;
  readonly payloadHash: Uint8Array;
  readonly accessRevision: AccessRevision;
  readonly previousManifestHash: Uint8Array | null;
  readonly envelopeHashes: readonly Uint8Array[];
  readonly signer: ObjectAccessManifestSignerV5;
  readonly signerAuthorizationHash: Uint8Array | null;
  readonly hostAuthorizationRevision: AuthorizationRevision;
}

export interface ObjectAccessManifestV5
  extends ObjectAccessManifestUnsignedV5 {
  readonly formatVersion: typeof OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V5;
  readonly signature: Uint8Array;
}

export interface CreatedObjectAccessManifestV5 {
  readonly manifest: ObjectAccessManifestV5;
  readonly bytes: Uint8Array;
  readonly hash: Uint8Array;
}

export interface HumanDeviceSignerAuthorityContextV5 {
  readonly subjectHumanId: HumanId;
  readonly committerDeviceId: CryptoDeviceId;
  readonly hostAuthorizationRevision: AuthorizationRevision;
}

export type ResolveHistoricalHumanDeviceSigningPublicKeyV5 = (
  context: HumanDeviceSignerAuthorityContextV5,
) => Uint8Array | null;

export type ResolveAgentRuntimeSignerPublicKeyV5 = (
  principal: AgentRuntimeObjectSignerPrincipalV1,
) => Uint8Array | null;

export interface ProcessorSignerAuthorizationEvidenceV5 {
  readonly authorizationId: string;
  readonly authorizationHash: Uint8Array;
  readonly signer: ProcessorObjectSignerPrincipalV1;
  readonly objectId: ObjectId;
}

export type ResolveProcessorSignerAuthorizationBytesV5 = (
  evidence: ProcessorSignerAuthorizationEvidenceV5,
) => Uint8Array | null;

export type ResolveHistoricalProcessorIssuingDevicePublicKeyV5 = (
  context: ProcessorSignerAuthorizationAuthorityContextV1,
) => Uint8Array | null;

export interface VerifyObjectAccessManifestV5Input {
  readonly manifestBytes: Uint8Array;
  readonly resolveHistoricalHumanDeviceSigningPublicKey:
    ResolveHistoricalHumanDeviceSigningPublicKeyV5;
  readonly resolveAgentRuntimeSignerPublicKey:
    ResolveAgentRuntimeSignerPublicKeyV5;
  readonly resolveProcessorSignerAuthorizationBytes:
    ResolveProcessorSignerAuthorizationBytesV5;
  readonly resolveHistoricalProcessorIssuingDevicePublicKey:
    ResolveHistoricalProcessorIssuingDevicePublicKeyV5;
  readonly resolveHistoricalCurrentIssuer?: ResolveHistoricalBackgroundAuthorizationIssuerV2;
}

export interface VerifiedObjectAccessManifestV5 {
  readonly manifest: ObjectAccessManifestV5;
  readonly manifestBytes: Uint8Array;
  readonly manifestHash: Uint8Array;
  readonly signerAuthorization: VerifiedProcessorSignerAuthorizationV1 | null;
  readonly currentSignerAuthorization: VerifiedProcessorSignerAuthorizationV2 | null;
}

export interface TrustedMinimumObjectAccessHeadV5 {
  readonly objectId: ObjectId;
  readonly payloadHash: Uint8Array;
  readonly accessRevision: AccessRevision;
  readonly manifestHash: Uint8Array;
}

export interface VerifyObjectAccessManifestChainV5Input
  extends Omit<VerifyObjectAccessManifestV5Input, "manifestBytes"> {
  readonly manifestBytes: Uint8Array;
  readonly proof: readonly Uint8Array[];
  readonly trustedMinimumHead: TrustedMinimumObjectAccessHeadV5;
}

const UNSIGNED_FIELDS = Object.freeze([
  "objectId",
  "payloadHash",
  "accessRevision",
  "previousManifestHash",
  "envelopeHashes",
  "signer",
  "signerAuthorizationHash",
  "hostAuthorizationRevision",
] as const);
const SIGNED_FIELDS = Object.freeze([
  "formatVersion",
  ...UNSIGNED_FIELDS,
  "signature",
] as const);

function assertObject(label: string, value: unknown): asserts value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertExactFields(
  label: string,
  value: object,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort(compareUnsignedUtf8);
  const canonical = [...expected].sort(compareUnsignedUtf8);
  if (
    actual.length !== canonical.length
    || actual.some((field, index) => field !== canonical[index])
  ) throw new TypeError(`${label} has an invalid field set`);
}

function exactBytes(label: string, value: unknown, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new TypeError(`${label} must be exactly ${length} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  return compareUnsignedUtf8(bytesToHex(left), bytesToHex(right));
}

function canonicalEnvelopeHashes(
  hashes: readonly Uint8Array[],
): readonly Uint8Array[] {
  if (!Array.isArray(hashes as unknown)) {
    throw new TypeError("manifest envelope hashes must be an array");
  }
  assertV2Limit(
    "manifest envelope count",
    hashes.length,
    V2_LIMITS.namespaceEnvelopesPerManifest,
  );
  const canonical = hashes
    .map((hash) => exactBytes("envelope hash", hash, HASH_BYTES))
    .sort(compareBytes);
  for (let index = 1; index < canonical.length; index += 1) {
    if (equalBytes(canonical[index - 1]!, canonical[index]!)) {
      throw new TypeError("manifest contains a duplicate envelope hash");
    }
  }
  return Object.freeze(canonical);
}

function normalizeHumanSigner(
  value: HumanDeviceObjectSignerPrincipalV5,
): HumanDeviceObjectSignerPrincipalV5 {
  assertExactFields("Human device object signer", value, [
    "kind",
    "subjectHumanId",
    "committerDeviceId",
  ]);
  return Object.freeze({
    kind: HUMAN_DEVICE_SIGNER_KIND,
    subjectHumanId: humanId(value.subjectHumanId),
    committerDeviceId: cryptoDeviceId(value.committerDeviceId),
  });
}

function normalizeSigner(
  value: ObjectAccessManifestSignerV5,
): ObjectAccessManifestSignerV5 {
  assertObject("object access manifest signer", value);
  const kind = (value as { readonly kind?: unknown }).kind;
  if (kind === HUMAN_DEVICE_SIGNER_KIND) {
    return normalizeHumanSigner(value as HumanDeviceObjectSignerPrincipalV5);
  }
  if (kind === AGENT_RUNTIME_SIGNER_KIND) {
    return normalizeAgentRuntimeObjectSignerPrincipalV1(
      value as AgentRuntimeObjectSignerPrincipalV1,
    );
  }
  if (kind === PROCESSOR_INVOCATION_SIGNER_KIND) {
    return normalizeProcessorObjectSignerPrincipalV1(
      value as ProcessorObjectSignerPrincipalV1,
    );
  }
  throw new TypeError("object access manifest signer kind is unsupported");
}

function normalizeUnsigned(
  value: ObjectAccessManifestUnsignedV5,
): ObjectAccessManifestUnsignedV5 {
  assertObject("object access manifest", value);
  assertExactFields("object access manifest", value, UNSIGNED_FIELDS);
  const signer = normalizeSigner(value.signer);
  let signerAuthorizationHash: Uint8Array | null = null;
  if (signer.kind === PROCESSOR_INVOCATION_SIGNER_KIND) {
    if (value.signerAuthorizationHash === null) {
      throw new TypeError(
        "Processor signer requires a signer authorization hash",
      );
    }
    signerAuthorizationHash = exactBytes(
      "Processor signer authorization hash",
      value.signerAuthorizationHash,
      HASH_BYTES,
    );
  } else if (value.signerAuthorizationHash !== null) {
    throw new TypeError(
      "Human and Agent signers forbid a signer authorization hash",
    );
  }
  const normalized = Object.freeze({
    objectId: objectId(value.objectId),
    payloadHash: exactBytes("payload hash", value.payloadHash, HASH_BYTES),
    accessRevision: accessRevision(value.accessRevision),
    previousManifestHash: value.previousManifestHash === null
      ? null
      : exactBytes(
        "previous manifest hash",
        value.previousManifestHash,
        HASH_BYTES,
      ),
    envelopeHashes: canonicalEnvelopeHashes(value.envelopeHashes),
    signer,
    signerAuthorizationHash,
    hostAuthorizationRevision: authorizationRevision(
      value.hostAuthorizationRevision,
    ),
  });
  if (
    (normalized.accessRevision === 0)
    !== (normalized.previousManifestHash === null)
  ) {
    throw new TypeError(
      "revision zero requires no previous manifest hash; later revisions require one",
    );
  }
  return normalized;
}

function unsignedFromSigned(
  manifest: ObjectAccessManifestV5,
): ObjectAccessManifestUnsignedV5 {
  return {
    objectId: manifest.objectId,
    payloadHash: manifest.payloadHash,
    accessRevision: manifest.accessRevision,
    previousManifestHash: manifest.previousManifestHash,
    envelopeHashes: manifest.envelopeHashes,
    signer: manifest.signer,
    signerAuthorizationHash: manifest.signerAuthorizationHash,
    hostAuthorizationRevision: manifest.hostAuthorizationRevision,
  };
}

function encodeSigner(signer: ObjectAccessManifestSignerV5): Uint8Array {
  if (signer.kind === HUMAN_DEVICE_SIGNER_KIND) {
    return concatV2(
      frameText(signer.kind),
      frameText(signer.subjectHumanId),
      frameText(signer.committerDeviceId),
    );
  }
  if (signer.kind === AGENT_RUNTIME_SIGNER_KIND) {
    return concatV2(
      frameText(signer.kind),
      frameText(signer.agentId),
      encodeU64(signer.runtimeGeneration),
      frameText(signer.signerKeyId),
    );
  }
  return concatV2(
    frameText(signer.kind),
    frameText(signer.processorKind),
    encodeU32(signer.processorVersion),
    frameText(signer.signerAuthorizationId),
    frame(signer.workDescriptorHash),
    frameText(signer.signerKeyId),
  );
}

function signingBytesFromNormalized(
  manifest: ObjectAccessManifestUnsignedV5,
): Uint8Array {
  return concatV2(
    frameText(OBJECT_ACCESS_MANIFEST_DOMAIN_V5),
    encodeU32(OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V5),
    frameText(manifest.objectId),
    frame(manifest.payloadHash),
    encodeU64(manifest.accessRevision),
    encodeU32(manifest.previousManifestHash === null ? 0 : 1),
    ...(manifest.previousManifestHash === null
      ? []
      : [frame(manifest.previousManifestHash)]),
    encodeU32(manifest.envelopeHashes.length),
    ...manifest.envelopeHashes.map(frame),
    encodeSigner(manifest.signer),
    encodeU32(manifest.signerAuthorizationHash === null ? 0 : 1),
    ...(manifest.signerAuthorizationHash === null
      ? []
      : [frame(manifest.signerAuthorizationHash)]),
    encodeU64(manifest.hostAuthorizationRevision),
  );
}

export function objectAccessManifestSigningBytesV5(
  manifest: ObjectAccessManifestUnsignedV5,
): Uint8Array {
  return signingBytesFromNormalized(normalizeUnsigned(manifest));
}

function normalizeSigned(manifest: ObjectAccessManifestV5): ObjectAccessManifestV5 {
  assertObject("object access manifest", manifest);
  assertExactFields("object access manifest", manifest, SIGNED_FIELDS);
  if (manifest.formatVersion !== OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V5) {
    throw new TypeError("unsupported object access manifest version");
  }
  const unsigned = normalizeUnsigned(unsignedFromSigned(manifest));
  return Object.freeze({
    formatVersion: OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V5,
    ...unsigned,
    signature: exactBytes(
      "manifest signature",
      manifest.signature,
      V2_LIMITS.signatureBytes,
    ),
  });
}

export function encodeObjectAccessManifestV5(
  manifest: ObjectAccessManifestV5,
): Uint8Array {
  const normalized = normalizeSigned(manifest);
  return concatV2(
    signingBytesFromNormalized(normalized),
    frame(normalized.signature),
  );
}

function decodeSigner(reader: StrictDecoder): ObjectAccessManifestSignerV5 {
  const kind = reader.readText(
    utf8V2(PROCESSOR_INVOCATION_SIGNER_KIND).length,
  );
  if (kind === HUMAN_DEVICE_SIGNER_KIND) {
    return normalizeHumanSigner({
      kind,
      subjectHumanId: humanId(reader.readText(V2_LIMITS.idBytes)),
      committerDeviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
    });
  }
  if (kind === AGENT_RUNTIME_SIGNER_KIND) {
    return normalizeAgentRuntimeObjectSignerPrincipalV1({
      kind,
      agentId: agentId(reader.readText(V2_LIMITS.idBytes)),
      runtimeGeneration: agentRuntimeGeneration(reader.readU64()),
      signerKeyId: reader.readText(V2_LIMITS.idBytes),
    });
  }
  if (kind === PROCESSOR_INVOCATION_SIGNER_KIND) {
    const processorKind = reader.readText(utf8V2(PROCESSOR_KIND).length);
    if (processorKind !== PROCESSOR_KIND && processorKind !== "reflection") {
      throw new CanonicalDecodingError(
        "processor object signer kind is unsupported",
      );
    }
    return normalizeProcessorObjectSignerPrincipalV1({
      kind,
      processorKind,
      processorVersion: reader.readVersion(1) as 1,
      signerAuthorizationId: reader.readText(V2_LIMITS.idBytes),
      workDescriptorHash: reader.readFrame(HASH_BYTES),
      signerKeyId: reader.readText(V2_LIMITS.idBytes),
    });
  }
  throw new CanonicalDecodingError(
    "object access manifest signer kind is unsupported",
  );
}

export function decodeObjectAccessManifestV5(
  bytes: Uint8Array,
): ObjectAccessManifestV5 {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("object access manifest bytes must be Uint8Array");
  }
  if (bytes.length > MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5) {
    throw new RangeError("object access manifest exceeds its wire limit");
  }
  const reader = new StrictDecoder(bytes);
  try {
    const domain = reader.readText(
      utf8V2(OBJECT_ACCESS_MANIFEST_DOMAIN_V5).length,
    );
    if (domain !== OBJECT_ACCESS_MANIFEST_DOMAIN_V5) {
      throw new CanonicalDecodingError("object access manifest domain mismatch");
    }
    const formatVersion = reader.readVersion(
      OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V5,
    ) as typeof OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V5;
    const decodedObjectId = objectId(reader.readText(V2_LIMITS.idBytes));
    const payloadHash = reader.readFrame(HASH_BYTES);
    const decodedAccessRevision = accessRevision(reader.readU64());
    const previousPresence = reader.readU32();
    if (previousPresence !== 0 && previousPresence !== 1) {
      throw new CanonicalDecodingError(
        "previous manifest hash presence must be 0 or 1",
      );
    }
    const previousManifestHash = previousPresence === 0
      ? null
      : reader.readFrame(HASH_BYTES);
    const count = reader.readCount(V2_LIMITS.namespaceEnvelopesPerManifest);
    const envelopeHashes = Array.from(
      { length: count },
      () => reader.readFrame(HASH_BYTES),
    );
    const signer = decodeSigner(reader);
    const authorizationPresence = reader.readU32();
    if (authorizationPresence !== 0 && authorizationPresence !== 1) {
      throw new CanonicalDecodingError(
        "signer authorization hash presence must be 0 or 1",
      );
    }
    const signerAuthorizationHash = authorizationPresence === 0
      ? null
      : reader.readFrame(HASH_BYTES);
    const hostAuthorizationRevision =
      authorizationRevision(reader.readU64());
    const signature = reader.readFrame(V2_LIMITS.signatureBytes);
    reader.assertFinished();
    const normalized = normalizeUnsigned({
      objectId: decodedObjectId,
      payloadHash,
      accessRevision: decodedAccessRevision,
      previousManifestHash,
      envelopeHashes,
      signer,
      signerAuthorizationHash,
      hostAuthorizationRevision,
    });
    for (let index = 0; index < envelopeHashes.length; index += 1) {
      if (!equalBytes(envelopeHashes[index]!, normalized.envelopeHashes[index]!)) {
        throw new CanonicalDecodingError(
          "manifest envelope hashes use noncanonical ordering",
        );
      }
    }
    return Object.freeze({
      formatVersion,
      ...normalized,
      signature: exactBytes(
        "manifest signature",
        signature,
        V2_LIMITS.signatureBytes,
      ),
    });
  } finally {
    reader.destroy(true);
  }
}

function createManifest(
  crypto: LatticeCrypto,
  unsigned: ObjectAccessManifestUnsignedV5,
  sign: (normalized: ObjectAccessManifestUnsignedV5) => Uint8Array,
): CreatedObjectAccessManifestV5 {
  const normalized = normalizeUnsigned(unsigned);
  let signature: Uint8Array | undefined;
  try {
    signature = exactBytes(
      "manifest signature",
      sign(normalized),
      V2_LIMITS.signatureBytes,
    );
    const manifest = normalizeSigned({
      formatVersion: OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V5,
      ...normalized,
      signature,
    });
    const bytes = encodeObjectAccessManifestV5(manifest);
    return Object.freeze({
      manifest,
      bytes,
      hash: exactBytes("manifest hash", crypto.hash(bytes), HASH_BYTES),
    });
  } finally {
    signature?.fill(0);
  }
}

export function createHumanObjectAccessManifestV5(
  crypto: LatticeCrypto,
  unsigned: ObjectAccessManifestUnsignedV5,
  signingPrivateKey: Uint8Array,
): CreatedObjectAccessManifestV5 {
  return createManifest(crypto, unsigned, (normalized) => {
    if (normalized.signer.kind !== HUMAN_DEVICE_SIGNER_KIND) {
      throw new TypeError("Human manifest creation requires a Human device signer");
    }
    const privateKey = exactBytes(
      "Human device signing private key",
      signingPrivateKey,
      V2_LIMITS.signingPrivateKeyBytes,
    );
    const signingBytes = signingBytesFromNormalized(normalized);
    try {
      return crypto.sign(privateKey, signingBytes);
    } finally {
      privateKey.fill(0);
      signingBytes.fill(0);
    }
  });
}

export function createAgentObjectAccessManifestV5(
  crypto: LatticeCrypto,
  unsigned: ObjectAccessManifestUnsignedV5,
  runtime: AgentRuntimeGenerationV2,
): CreatedObjectAccessManifestV5 {
  return createManifest(crypto, unsigned, (normalized) => {
    if (normalized.signer.kind !== AGENT_RUNTIME_SIGNER_KIND) {
      throw new TypeError("Agent manifest creation requires an Agent Runtime signer");
    }
    const signingBytes = signingBytesFromNormalized(normalized);
    try {
      return signAgentRuntimeObjectBytesV1(crypto, {
        runtime,
        signer: normalized.signer,
        message: signingBytes,
      });
    } finally {
      signingBytes.fill(0);
    }
  });
}

function assertProcessorAuthorizationBoundary(
  manifest: ObjectAccessManifestUnsignedV5,
  verified: VerifiedProcessorSignerAuthorizationV1,
): void {
  if (
    manifest.signer.kind !== PROCESSOR_INVOCATION_SIGNER_KIND
    || manifest.signerAuthorizationHash === null
  ) throw new TypeError(
    "Processor manifest requires processor signer authorization evidence",
  );
  const authorization = verified.authorization;
  if (
    !equalBytes(manifest.signerAuthorizationHash, verified.authorizationHash)
    || authorization.id !== manifest.signer.signerAuthorizationId
    || authorization.signer.kind !== manifest.signer.kind
    || authorization.signer.processorKind !== manifest.signer.processorKind
    || authorization.signer.processorVersion !== manifest.signer.processorVersion
    || authorization.signer.signerAuthorizationId
      !== manifest.signer.signerAuthorizationId
    || authorization.signer.signerKeyId !== manifest.signer.signerKeyId
    || !equalBytes(
      authorization.signer.workDescriptorHash,
      manifest.signer.workDescriptorHash,
    )
  ) throw new TypeError(
    "Processor manifest signer does not match its authorization",
  );
  if (!authorization.outputObjectIds.includes(manifest.objectId)) {
    throw new TypeError(
      "Processor manifest object is outside its authorization output boundary",
    );
  }
  if (
    authorization.processorAuthorizationRevision
      !== manifest.hostAuthorizationRevision
  ) throw new TypeError(
    "Processor manifest authorization revision does not match",
  );
}

function destroyVerifiedProcessorSignerAuthorization(
  value: VerifiedProcessorSignerAuthorizationV1,
): void {
  value.authorization.issuerSigningPublicKeyHash.fill(0);
  value.authorization.signer.workDescriptorHash.fill(0);
  value.authorization.signerPublicKey.fill(0);
  value.authorization.workDescriptorHash.fill(0);
  value.authorization.credentialHash.fill(0);
  value.authorization.signature.fill(0);
  value.authorizationBytes.fill(0);
  value.authorizationHash.fill(0);
}

export function createProcessorObjectAccessManifestV5(
  crypto: LatticeCrypto,
  unsigned: ObjectAccessManifestUnsignedV5,
  input: Readonly<{
    readonly signerPrivateKey: Uint8Array;
    readonly signerAuthorizationBytes: Uint8Array;
    readonly now: number;
    readonly resolveCurrentIssuingDevicePublicKey:
      ResolveCurrentProcessorSignerIssuingDevicePublicKeyV1;
  }>,
): CreatedObjectAccessManifestV5 {
  const normalized = normalizeUnsigned(unsigned);
  if (normalized.signer.kind !== PROCESSOR_INVOCATION_SIGNER_KIND) {
    throw new TypeError("Processor manifest creation requires a processor signer");
  }
  const verified = verifyCurrentProcessorSignerAuthorizationV1(crypto, {
    authorizationBytes: input.signerAuthorizationBytes,
    now: input.now,
    resolveCurrentIssuingDevicePublicKey:
      input.resolveCurrentIssuingDevicePublicKey,
  });
  try {
    assertProcessorAuthorizationBoundary(normalized, verified);
    return createManifest(crypto, normalized, (manifest) => {
      if (manifest.signer.kind !== PROCESSOR_INVOCATION_SIGNER_KIND) {
        throw new TypeError(
          "Processor manifest creation requires a processor signer",
        );
      }
      const signingBytes = signingBytesFromNormalized(manifest);
      try {
        return signProcessorObjectBytesV1(crypto, {
          principal: manifest.signer,
          signerPrivateKey: input.signerPrivateKey,
          message: signingBytes,
        });
      } finally {
        signingBytes.fill(0);
      }
    });
  } finally {
    destroyVerifiedProcessorSignerAuthorization(verified);
  }
}

/** Current Domain-custodied processor output, using the common manifest chain. */
export function createCurrentProcessorObjectAccessManifestV5(
  crypto: LatticeCrypto,
  unsigned: ObjectAccessManifestUnsignedV5,
  input: Readonly<{
    signerPrivateKey: Uint8Array;
    signerAuthorizationBytes: Uint8Array;
    issuerSigningPublicKey: Uint8Array;
    now: number;
  }>,
): CreatedObjectAccessManifestV5 {
  const normalized = normalizeUnsigned(unsigned);
  if (normalized.signer.kind !== PROCESSOR_INVOCATION_SIGNER_KIND) throw new TypeError("Processor signer required");
  const authorizationBytes = copyOwnedBytesV2(input.signerAuthorizationBytes);
  let verified: VerifiedProcessorSignerAuthorizationV2 | undefined;
  try {
    const certificate = verifyProcessorSignerAuthorizationV2(crypto, {
      authorizationBytes, issuerSigningPublicKey: input.issuerSigningPublicKey, now: input.now,
    });
    verified = {certificate, authorizationBytes, authorizationHash: crypto.hash(authorizationBytes)};
    assertCurrentProcessorAuthorizationBoundaryV4({...normalized, signer: normalized.signer}, verified);
    return createManifest(crypto, normalized, manifest => {
      if (manifest.signer.kind !== PROCESSOR_INVOCATION_SIGNER_KIND) throw new TypeError("Processor signer required");
      const bytes = signingBytesFromNormalized(manifest);
      try {return signProcessorObjectBytesV1(crypto, {principal: manifest.signer,
        signerPrivateKey: input.signerPrivateKey, message: bytes});}
      finally {bytes.fill(0);}
    });
  } finally {
    if (verified) destroyVerifiedProcessorSignerAuthorizationV2(verified);
    else authorizationBytes.fill(0);
  }
}

function verifyHumanSignature(
  crypto: LatticeCrypto,
  manifest: ObjectAccessManifestV5,
  signingBytes: Uint8Array,
  resolve: ResolveHistoricalHumanDeviceSigningPublicKeyV5,
): void {
  if (manifest.signer.kind !== HUMAN_DEVICE_SIGNER_KIND) {
    throw new TypeError("Human manifest requires a Human device signer");
  }
  const resolved = resolve(Object.freeze({
    subjectHumanId: manifest.signer.subjectHumanId,
    committerDeviceId: manifest.signer.committerDeviceId,
    hostAuthorizationRevision: manifest.hostAuthorizationRevision,
  }));
  const publicKey = exactBytes(
    "Human device signing public key",
    resolved,
    V2_LIMITS.signingPublicKeyBytes,
  );
  try {
    if (!crypto.verify(publicKey, signingBytes, manifest.signature)) {
      throw new TypeError("Human object access manifest signature is invalid");
    }
  } finally {
    publicKey.fill(0);
  }
}

function verifyAgentSignature(
  crypto: LatticeCrypto,
  manifest: ObjectAccessManifestV5,
  signingBytes: Uint8Array,
  resolve: ResolveAgentRuntimeSignerPublicKeyV5,
): void {
  if (manifest.signer.kind !== AGENT_RUNTIME_SIGNER_KIND) {
    throw new TypeError("Agent manifest requires an Agent Runtime signer");
  }
  const resolved = resolve(manifest.signer);
  const publicKey = exactBytes(
    "Agent Runtime object signer public key",
    resolved,
    V2_LIMITS.signingPublicKeyBytes,
  );
  try {
    if (
      agentRuntimeObjectSignerKeyIdV1(crypto, publicKey)
        !== manifest.signer.signerKeyId
    ) throw new TypeError(
      "Agent Runtime object signer key id does not match the public key",
    );
    if (!crypto.verify(publicKey, signingBytes, manifest.signature)) {
      throw new TypeError("Agent object access manifest signature is invalid");
    }
  } finally {
    publicKey.fill(0);
  }
}

export function verifyObjectAccessManifestV5(
  crypto: LatticeCrypto,
  input: VerifyObjectAccessManifestV5Input,
): VerifiedObjectAccessManifestV5 {
  if (!(input.manifestBytes instanceof Uint8Array)) {
    throw new TypeError("object access manifest bytes must be Uint8Array");
  }
  if (input.manifestBytes.length > MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5) {
    throw new RangeError("object access manifest exceeds its wire limit");
  }
  const manifestBytes = copyOwnedBytesV2(input.manifestBytes);
  let signingBytes: Uint8Array | undefined;
  let signerAuthorization: VerifiedProcessorSignerAuthorizationV1 | null = null;
  let currentSignerAuthorization: VerifiedProcessorSignerAuthorizationV2 | null = null;
  let verified = false;
  try {
    const manifest = decodeObjectAccessManifestV5(manifestBytes);
    signingBytes = signingBytesFromNormalized(unsignedFromSigned(manifest));
    if (manifest.signer.kind === HUMAN_DEVICE_SIGNER_KIND) {
      verifyHumanSignature(
        crypto,
        manifest,
        signingBytes,
        input.resolveHistoricalHumanDeviceSigningPublicKey,
      );
    } else if (manifest.signer.kind === AGENT_RUNTIME_SIGNER_KIND) {
      verifyAgentSignature(
        crypto,
        manifest,
        signingBytes,
        input.resolveAgentRuntimeSignerPublicKey,
      );
    } else {
      if (manifest.signerAuthorizationHash === null) {
        throw new TypeError(
          "Processor manifest requires signer authorization evidence",
        );
      }
      const evidence = Object.freeze({
        authorizationId: manifest.signer.signerAuthorizationId,
        authorizationHash: copyOwnedBytesV2(
          manifest.signerAuthorizationHash,
        ),
        signer: manifest.signer,
        objectId: manifest.objectId,
      });
      const authorizationBytes =
        input.resolveProcessorSignerAuthorizationBytes(evidence);
      evidence.authorizationHash.fill(0);
      if (!(authorizationBytes instanceof Uint8Array)) {
        throw new TypeError(
          "Processor signer authorization evidence is unavailable",
        );
      }
      let signerPublicKey: Uint8Array;
      if (readProcessorSignerAuthorizationVersion(authorizationBytes) === 2) {
        if (input.resolveHistoricalCurrentIssuer === undefined) {
          throw new TypeError("Current processor historical authority resolver is required");
        }
        currentSignerAuthorization = verifyHistoricalProcessorSignerAuthorizationV2(crypto, {
          authorizationBytes, resolveHistoricalIssuer: input.resolveHistoricalCurrentIssuer,
        });
        assertCurrentProcessorAuthorizationBoundaryV4({...manifest, signer: manifest.signer}, currentSignerAuthorization);
        signerPublicKey = currentSignerAuthorization.certificate.signerPublicKey;
      } else {
        signerAuthorization = verifyHistoricalProcessorSignerAuthorizationV1(crypto, {
          authorizationBytes,
          resolveHistoricalIssuingDevicePublicKey:
            input.resolveHistoricalProcessorIssuingDevicePublicKey,
        });
        assertProcessorAuthorizationBoundary(manifest, signerAuthorization);
        signerPublicKey = signerAuthorization.authorization.signerPublicKey;
      }
      if (!verifyProcessorObjectBytesV1(crypto, {
        principal: manifest.signer,
        signerPublicKey,
        message: signingBytes,
        signature: manifest.signature,
      })) throw new TypeError(
        "Processor object access manifest signature is invalid",
      );
    }
    const result = Object.freeze({
      manifest,
      manifestBytes,
      manifestHash: exactBytes("manifest hash", crypto.hash(manifestBytes), HASH_BYTES),
      signerAuthorization,
      currentSignerAuthorization,
    });
    verified = true;
    return result;
  } finally {
    if (!verified) manifestBytes.fill(0);
    if (!verified && signerAuthorization !== null) {
      destroyVerifiedProcessorSignerAuthorization(signerAuthorization);
    }
    if (!verified && currentSignerAuthorization !== null) destroyVerifiedProcessorSignerAuthorizationV2(currentSignerAuthorization);
    signingBytes?.fill(0);
  }
}

function normalizeTrustedMinimumHead(
  value: TrustedMinimumObjectAccessHeadV5,
): TrustedMinimumObjectAccessHeadV5 {
  assertObject("trusted minimum object access head", value);
  assertExactFields("trusted minimum object access head", value, [
    "objectId",
    "payloadHash",
    "accessRevision",
    "manifestHash",
  ]);
  return Object.freeze({
    objectId: objectId(value.objectId),
    payloadHash: exactBytes("trusted payload hash", value.payloadHash, HASH_BYTES),
    accessRevision: accessRevision(value.accessRevision),
    manifestHash: exactBytes("trusted manifest hash", value.manifestHash, HASH_BYTES),
  });
}

function assertManifestIdentity(
  manifest: ObjectAccessManifestV5,
  anchor: TrustedMinimumObjectAccessHeadV5,
): void {
  if (manifest.objectId !== anchor.objectId) {
    throw new TypeError("object access manifest object mismatch");
  }
  if (!equalBytes(manifest.payloadHash, anchor.payloadHash)) {
    throw new TypeError("object access manifest payload mismatch");
  }
}

export function verifyObjectAccessManifestChainV5(
  crypto: LatticeCrypto,
  input: VerifyObjectAccessManifestChainV5Input,
): VerifiedObjectAccessManifestV5 {
  if (!Array.isArray(input.proof as unknown)) {
    throw new TypeError("object access proof must be an array");
  }
  assertV2Limit(
    "object access proof entries",
    input.proof.length,
    V2_LIMITS.proofEntriesPerSegment,
  );
  const anchor = normalizeTrustedMinimumHead(input.trustedMinimumHead);
  const target = decodeObjectAccessManifestV5(input.manifestBytes);
  const targetHash = exactBytes(
    "target manifest hash",
    crypto.hash(input.manifestBytes),
    HASH_BYTES,
  );
  try {
    assertManifestIdentity(target, anchor);
    if (target.accessRevision < anchor.accessRevision) {
      throw new TypeError("object access manifest rollback below trusted minimum");
    }
    if (target.accessRevision === anchor.accessRevision) {
      if (input.proof.length !== 0) {
        throw new TypeError("same-revision object access proof must be empty");
      }
      if (!equalBytes(targetHash, anchor.manifestHash)) {
        throw new TypeError("object access manifest changed at the same revision");
      }
      return verifyObjectAccessManifestV5(crypto, input);
    }
    const segment = [...input.proof, input.manifestBytes];
    let previousRevision = anchor.accessRevision;
    let previousHash = anchor.manifestHash;
    let finalVerified: VerifiedObjectAccessManifestV5 | undefined;
    try {
      for (let index = 0; index < segment.length; index += 1) {
        const manifestBytes = segment[index]!;
        const verified = verifyObjectAccessManifestV5(crypto, {
          ...input,
          manifestBytes,
        });
        let retained = false;
        try {
          assertManifestIdentity(verified.manifest, anchor);
          if (
            verified.manifest.accessRevision !== previousRevision + 1
            || verified.manifest.previousManifestHash === null
            || !equalBytes(verified.manifest.previousManifestHash, previousHash)
          ) {
            throw new TypeError("object access manifest fork or broken hash chain");
          }
          previousRevision = verified.manifest.accessRevision;
          const nextPreviousHash = copyOwnedBytesV2(verified.manifestHash);
          previousHash.fill(0);
          previousHash = nextPreviousHash;
          if (index === segment.length - 1) {
            finalVerified = verified;
            retained = true;
          }
        } finally {
          if (!retained) {
            verified.manifestBytes.fill(0);
            verified.manifestHash.fill(0);
            if (verified.signerAuthorization !== null) {
              destroyVerifiedProcessorSignerAuthorization(verified.signerAuthorization);
            }
            if (verified.currentSignerAuthorization !== null) {
              destroyVerifiedProcessorSignerAuthorizationV2(verified.currentSignerAuthorization);
            }
          }
        }
      }
      if (finalVerified === undefined) {
        throw new TypeError("object access manifest proof is incomplete");
      }
      return finalVerified;
    } catch (error) {
      finalVerified?.manifestBytes.fill(0);
      finalVerified?.manifestHash.fill(0);
      if (
        finalVerified !== undefined
        && finalVerified.signerAuthorization !== null
      ) {
        destroyVerifiedProcessorSignerAuthorization(
          finalVerified.signerAuthorization,
        );
      }
      if (finalVerified?.currentSignerAuthorization) {
        destroyVerifiedProcessorSignerAuthorizationV2(finalVerified.currentSignerAuthorization);
      }
      throw error;
    }
  } finally {
    anchor.payloadHash.fill(0);
    anchor.manifestHash.fill(0);
    targetHash.fill(0);
  }
}
