import { bytesToHex } from "@noble/hashes/utils.js";

import {
  agentRuntimeObjectSignerKeyIdV1,
  normalizeAgentRuntimeObjectSignerPrincipalV1,
  signAgentRuntimeObjectBytesV1,
  type AgentRuntimeObjectSignerPrincipalV1,
} from "../agent-runtime/object-signer-v1.ts";
import type {
  AgentRuntimeGenerationV2,
} from "../agent-runtime/types.ts";
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
import { compareUnsignedUtf8 } from "../domain/participants.ts";
import {
  accessRevision,
  authorizationRevision,
  objectId,
  type AccessRevision,
  type AuthorizationRevision,
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

export const OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V4 = 4 as const;
export const OBJECT_ACCESS_MANIFEST_DOMAIN_V4 =
  "nautilo/lattice-crypto/object-access-manifest/v4";

const HASH_BYTES = 32;
const AGENT_RUNTIME_SIGNER_KIND = "agent_runtime";
const PROCESSOR_INVOCATION_SIGNER_KIND = "processor_invocation";
const PROCESSOR_KIND = "stenographer";
const FRAME_LENGTH_BYTES = 4;
const MAX_SIGNER_WIRE_BYTES = Math.max(
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

export const MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V4 =
  FRAME_LENGTH_BYTES + utf8V2(OBJECT_ACCESS_MANIFEST_DOMAIN_V4).length
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

export type ObjectAccessManifestSignerV4 =
  | AgentRuntimeObjectSignerPrincipalV1
  | ProcessorObjectSignerPrincipalV1;

export interface ObjectAccessManifestUnsignedV4 {
  readonly objectId: ObjectId;
  readonly payloadHash: Uint8Array;
  readonly accessRevision: AccessRevision;
  /** Hash of the previous access manifest; null only at access revision zero. */
  readonly previousManifestHash: Uint8Array | null;
  readonly envelopeHashes: readonly Uint8Array[];
  readonly signer: ObjectAccessManifestSignerV4;
  /**
   * Null for Agent Runtime signers. Processor signers must bind the exact
   * append-only public signer-authorization certificate by canonical hash.
   */
  readonly signerAuthorizationHash: Uint8Array | null;
  readonly hostAuthorizationRevision: AuthorizationRevision;
}

export interface ObjectAccessManifestV4
  extends ObjectAccessManifestUnsignedV4 {
  readonly formatVersion: typeof OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V4;
  readonly signature: Uint8Array;
}

export interface CreatedObjectAccessManifestV4 {
  readonly manifest: ObjectAccessManifestV4;
  readonly bytes: Uint8Array;
  readonly hash: Uint8Array;
}

export interface ProcessorSignerAuthorizationEvidenceV4 {
  readonly authorizationId: string;
  readonly authorizationHash: Uint8Array;
  readonly signer: ProcessorObjectSignerPrincipalV1;
  readonly objectId: ObjectId;
}

export type ResolveProcessorSignerAuthorizationBytesV4 = (
  evidence: ProcessorSignerAuthorizationEvidenceV4,
) => Uint8Array | null;

export type ResolveAgentRuntimeSignerPublicKeyV4 = (
  principal: AgentRuntimeObjectSignerPrincipalV1,
) => Uint8Array | null;

export type ResolveHistoricalProcessorIssuingDevicePublicKeyV4 = (
  context: ProcessorSignerAuthorizationAuthorityContextV1,
) => Uint8Array | null;

export interface VerifiedObjectAccessManifestV4 {
  readonly manifest: ObjectAccessManifestV4;
  readonly manifestBytes: Uint8Array;
  readonly manifestHash: Uint8Array;
  readonly signerAuthorization:
    | VerifiedProcessorSignerAuthorizationV1
    | null;
  /** Distinct current Domain-key certificate; never projected into the V1 shape. */
  readonly currentSignerAuthorization: VerifiedProcessorSignerAuthorizationV2 | null;
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
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length
    || actual.some((field, index) => field !== canonical[index])
  ) {
    throw new TypeError(`${label} has an invalid field set`);
  }
}

function exactBytes(
  label: string,
  value: unknown,
  length: number,
): Uint8Array {
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
    .map((hashValue) =>
      exactBytes("envelope hash", hashValue, HASH_BYTES))
    .sort(compareBytes);
  for (let index = 1; index < canonical.length; index += 1) {
    if (equalBytes(canonical[index - 1]!, canonical[index]!)) {
      throw new TypeError("manifest contains a duplicate envelope hash");
    }
  }
  return Object.freeze(canonical);
}

function normalizeSigner(
  value: ObjectAccessManifestSignerV4,
): ObjectAccessManifestSignerV4 {
  assertObject("object access manifest signer", value);
  const kind = (value as { readonly kind?: unknown }).kind;
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
  value: ObjectAccessManifestUnsignedV4,
): ObjectAccessManifestUnsignedV4 {
  assertObject("object access manifest", value);
  assertExactFields("object access manifest", value, UNSIGNED_FIELDS);
  const signer = normalizeSigner(value.signer);
  let signerAuthorizationHash: Uint8Array | null = null;
  if (signer.kind === AGENT_RUNTIME_SIGNER_KIND) {
    if (value.signerAuthorizationHash !== null) {
      throw new TypeError(
        "Agent Runtime signer forbids a processor signer authorization hash",
      );
    }
  } else {
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
  }
  const normalized = Object.freeze({
    objectId: objectId(value.objectId),
    payloadHash: exactBytes(
      "payload hash",
      value.payloadHash,
      HASH_BYTES,
    ),
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
  manifest: ObjectAccessManifestV4,
): ObjectAccessManifestUnsignedV4 {
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

function encodeSigner(signer: ObjectAccessManifestSignerV4): Uint8Array {
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
  manifest: ObjectAccessManifestUnsignedV4,
): Uint8Array {
  return concatV2(
    frameText(OBJECT_ACCESS_MANIFEST_DOMAIN_V4),
    encodeU32(OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V4),
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

export function objectAccessManifestSigningBytesV4(
  manifest: ObjectAccessManifestUnsignedV4,
): Uint8Array {
  return signingBytesFromNormalized(normalizeUnsigned(manifest));
}

function normalizeSigned(
  manifest: ObjectAccessManifestV4,
): ObjectAccessManifestV4 {
  assertObject("object access manifest", manifest);
  assertExactFields("object access manifest", manifest, SIGNED_FIELDS);
  if (manifest.formatVersion !== OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V4) {
    throw new TypeError("unsupported object access manifest version");
  }
  const unsigned = normalizeUnsigned(unsignedFromSigned(manifest));
  return Object.freeze({
    formatVersion: OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V4,
    ...unsigned,
    signature: exactBytes(
      "manifest signature",
      manifest.signature,
      V2_LIMITS.signatureBytes,
    ),
  });
}

export function encodeObjectAccessManifestV4(
  manifest: ObjectAccessManifestV4,
): Uint8Array {
  const normalized = normalizeSigned(manifest);
  return concatV2(
    signingBytesFromNormalized(normalized),
    frame(normalized.signature),
  );
}

function decodeSigner(reader: StrictDecoder): ObjectAccessManifestSignerV4 {
  const kind = reader.readText(
    utf8V2(PROCESSOR_INVOCATION_SIGNER_KIND).length,
  );
  if (kind === AGENT_RUNTIME_SIGNER_KIND) {
    return normalizeAgentRuntimeObjectSignerPrincipalV1({
      kind,
      agentId: reader.readText(V2_LIMITS.idBytes) as never,
      runtimeGeneration: reader.readU64() as never,
      signerKeyId: reader.readText(V2_LIMITS.idBytes),
    });
  }
  if (kind === PROCESSOR_INVOCATION_SIGNER_KIND) {
    return normalizeProcessorObjectSignerPrincipalV1({
      kind,
      processorKind: reader.readText(
        utf8V2(PROCESSOR_KIND).length,
      ) as "stenographer",
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

export function decodeObjectAccessManifestV4(
  bytes: Uint8Array,
): ObjectAccessManifestV4 {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("object access manifest bytes must be Uint8Array");
  }
  if (bytes.length > MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V4) {
    throw new RangeError("object access manifest exceeds its wire limit");
  }
  const reader = new StrictDecoder(bytes);
  try {
    const domain = reader.readText(
      utf8V2(OBJECT_ACCESS_MANIFEST_DOMAIN_V4).length,
    );
    if (domain !== OBJECT_ACCESS_MANIFEST_DOMAIN_V4) {
      throw new CanonicalDecodingError(
        "object access manifest domain mismatch",
      );
    }
    const formatVersion = reader.readVersion(
      OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V4,
    ) as typeof OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V4;
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
      if (
        !equalBytes(
          envelopeHashes[index]!,
          normalized.envelopeHashes[index]!,
        )
      ) {
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

function manifestHash(
  crypto: LatticeCrypto,
  bytes: Uint8Array,
): Uint8Array {
  return exactBytes(
    "object access manifest hash",
    crypto.hash(bytes),
    HASH_BYTES,
  );
}

function createManifest(
  crypto: LatticeCrypto,
  unsigned: ObjectAccessManifestUnsignedV4,
  sign: (normalized: ObjectAccessManifestUnsignedV4) => Uint8Array,
): CreatedObjectAccessManifestV4 {
  const normalized = normalizeUnsigned(unsigned);
  let signature: Uint8Array | undefined;
  try {
    signature = exactBytes(
      "manifest signature",
      sign(normalized),
      V2_LIMITS.signatureBytes,
    );
    const manifest = normalizeSigned({
      formatVersion: OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V4,
      ...normalized,
      signature,
    });
    const bytes = encodeObjectAccessManifestV4(manifest);
    return Object.freeze({
      manifest,
      bytes,
      hash: manifestHash(crypto, bytes),
    });
  } finally {
    signature?.fill(0);
  }
}

export function createAgentObjectAccessManifestV4(
  crypto: LatticeCrypto,
  unsigned: ObjectAccessManifestUnsignedV4,
  runtime: AgentRuntimeGenerationV2,
): CreatedObjectAccessManifestV4 {
  return createManifest(crypto, unsigned, (normalized) => {
    if (normalized.signer.kind !== AGENT_RUNTIME_SIGNER_KIND) {
      throw new TypeError(
        "Agent manifest creation requires an Agent Runtime signer",
      );
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
  manifest: ObjectAccessManifestUnsignedV4,
  verified: VerifiedProcessorSignerAuthorizationV1,
): void {
  if (
    manifest.signer.kind !== PROCESSOR_INVOCATION_SIGNER_KIND
    || manifest.signerAuthorizationHash === null
  ) {
    throw new TypeError(
      "Processor manifest requires processor signer authorization evidence",
    );
  }
  if (
    !equalBytes(
      manifest.signerAuthorizationHash,
      verified.authorizationHash,
    )
  ) {
    throw new TypeError(
      "Processor manifest signer authorization hash does not match",
    );
  }
  const authorization = verified.authorization;
  if (
    authorization.id !== manifest.signer.signerAuthorizationId
    || authorization.signer.kind !== manifest.signer.kind
    || authorization.signer.processorKind
      !== manifest.signer.processorKind
    || authorization.signer.processorVersion
      !== manifest.signer.processorVersion
    || authorization.signer.signerAuthorizationId
      !== manifest.signer.signerAuthorizationId
    || authorization.signer.signerKeyId !== manifest.signer.signerKeyId
    || !equalBytes(
      authorization.signer.workDescriptorHash,
      manifest.signer.workDescriptorHash,
    )
  ) {
    throw new TypeError(
      "Processor manifest signer does not match its authorization",
    );
  }
  if (!authorization.outputObjectIds.includes(manifest.objectId)) {
    throw new TypeError(
      "Processor manifest object is outside its authorization output boundary",
    );
  }
  if (
    authorization.processorAuthorizationRevision
      !== manifest.hostAuthorizationRevision
  ) {
    throw new TypeError(
      "Processor manifest authorization revision does not match",
    );
  }
}

export function createProcessorObjectAccessManifestV4(
  crypto: LatticeCrypto,
  unsigned: ObjectAccessManifestUnsignedV4,
  input: Readonly<{
    readonly signerPrivateKey: Uint8Array;
    readonly signerAuthorizationBytes: Uint8Array;
    readonly now: number;
    readonly resolveCurrentIssuingDevicePublicKey:
      ResolveCurrentProcessorSignerIssuingDevicePublicKeyV1;
  }>,
): CreatedObjectAccessManifestV4 {
  const normalized = normalizeUnsigned(unsigned);
  if (normalized.signer.kind !== PROCESSOR_INVOCATION_SIGNER_KIND) {
    throw new TypeError(
      "Processor manifest creation requires a processor signer",
    );
  }
  const verified = verifyCurrentProcessorSignerAuthorizationV1(
    crypto,
    {
      authorizationBytes: input.signerAuthorizationBytes,
      now: input.now,
      resolveCurrentIssuingDevicePublicKey:
        input.resolveCurrentIssuingDevicePublicKey,
    },
  );
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
}

/**
 * Current Stenographer certificate creation. The closed gate resolves current
 * device authority before calling this synchronous signature boundary.
 * hostAuthorizationRevision is the issuing M303 security revision; it is not
 * the retired processor-authorization revision used by V1 certificates.
 */
export function createCurrentProcessorObjectAccessManifestV4(
  crypto: LatticeCrypto,
  unsigned: ObjectAccessManifestUnsignedV4,
  input: Readonly<{
    signerPrivateKey: Uint8Array;
    signerAuthorizationBytes: Uint8Array;
    issuerSigningPublicKey: Uint8Array;
    now: number;
  }>,
): CreatedObjectAccessManifestV4 {
  const certificate = verifyProcessorSignerAuthorizationV2(crypto, {
    authorizationBytes: input.signerAuthorizationBytes,
    issuerSigningPublicKey: input.issuerSigningPublicKey,
    now: input.now,
  });
  return createManifest(crypto, unsigned, (manifest) => {
    assertCurrentProcessorAuthorizationBoundaryV4(manifest, {
      certificate, authorizationBytes: input.signerAuthorizationBytes,
      authorizationHash: crypto.hash(input.signerAuthorizationBytes),
    });
    if (manifest.signer.kind !== PROCESSOR_INVOCATION_SIGNER_KIND) throw new TypeError("Processor signer required");
    const bytes = signingBytesFromNormalized(manifest);
    try {
      return signProcessorObjectBytesV1(crypto, {
        principal: manifest.signer, signerPrivateKey: input.signerPrivateKey, message: bytes,
      });
    } finally {
      bytes.fill(0);
    }
  });
}

/** Shared V4/V5 certificate boundary; manifests retain their own wire formats. */
export function assertCurrentProcessorAuthorizationBoundaryV4(
  manifest: ObjectAccessManifestUnsignedV4,
  verified: VerifiedProcessorSignerAuthorizationV2,
): void {
  const {certificate} = verified;
  const signer = manifest.signer;
  if (signer.kind !== PROCESSOR_INVOCATION_SIGNER_KIND
    || signer.signerAuthorizationId !== certificate.credentialId
    || signer.processorKind !== certificate.signer.processorKind
    || signer.processorVersion !== certificate.signer.processorVersion
    || signer.signerKeyId !== certificate.signer.signerKeyId
    || !equalBytes(signer.workDescriptorHash, certificate.descriptorHash)
    || manifest.signerAuthorizationHash === null
    || !equalBytes(manifest.signerAuthorizationHash, verified.authorizationHash)
    || manifest.hostAuthorizationRevision !== certificate.issuer.securityRevision
    || !certificate.descriptor.outputSlots.some((slot) => slot.objectId === manifest.objectId)) {
    throw new TypeError("Current processor manifest exceeds its certificate boundary");
  }
}

function verifyAgentSignature(
  crypto: LatticeCrypto,
  manifest: ObjectAccessManifestV4,
  signingBytes: Uint8Array,
  resolve: ResolveAgentRuntimeSignerPublicKeyV4,
): void {
  if (manifest.signer.kind !== AGENT_RUNTIME_SIGNER_KIND) {
    throw new TypeError("Agent manifest requires an Agent Runtime signer");
  }
  const resolved = resolve(manifest.signer);
  if (!(resolved instanceof Uint8Array)) {
    throw new TypeError(
      "no trusted Agent Runtime signing key for object access manifest",
    );
  }
  const publicKey = exactBytes(
    "Agent Runtime object signer public key",
    resolved,
    V2_LIMITS.signingPublicKeyBytes,
  );
  try {
    if (
      agentRuntimeObjectSignerKeyIdV1(crypto, publicKey)
        !== manifest.signer.signerKeyId
    ) {
      throw new TypeError(
        "Agent Runtime object signer key id does not match the public key",
      );
    }
    if (!crypto.verify(publicKey, signingBytes, manifest.signature)) {
      throw new TypeError("Agent object access manifest signature is invalid");
    }
  } finally {
    publicKey.fill(0);
  }
}

export function verifyObjectAccessManifestV4(
  crypto: LatticeCrypto,
  input: Readonly<{
    readonly manifestBytes: Uint8Array;
    readonly resolveAgentRuntimeSignerPublicKey:
      ResolveAgentRuntimeSignerPublicKeyV4;
    readonly resolveProcessorSignerAuthorizationBytes:
      ResolveProcessorSignerAuthorizationBytesV4;
    readonly resolveHistoricalIssuingDevicePublicKey:
      ResolveHistoricalProcessorIssuingDevicePublicKeyV4;
    readonly resolveHistoricalCurrentIssuer?: ResolveHistoricalBackgroundAuthorizationIssuerV2;
  }>,
): VerifiedObjectAccessManifestV4 {
  if (!(input.manifestBytes instanceof Uint8Array)) {
    throw new TypeError("object access manifest bytes must be Uint8Array");
  }
  if (
    input.manifestBytes.length > MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V4
  ) {
    throw new RangeError("object access manifest exceeds its wire limit");
  }
  const manifestBytes = copyOwnedBytesV2(input.manifestBytes);
  let signingBytes: Uint8Array | undefined;
  let signerAuthorization:
    | VerifiedProcessorSignerAuthorizationV1
    | null = null;
  let currentSignerAuthorization: VerifiedProcessorSignerAuthorizationV2 | null = null;
  let verified = false;
  try {
    const manifest = decodeObjectAccessManifestV4(manifestBytes);
    signingBytes = signingBytesFromNormalized(
      unsignedFromSigned(manifest),
    );
    if (manifest.signer.kind === AGENT_RUNTIME_SIGNER_KIND) {
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
        assertCurrentProcessorAuthorizationBoundaryV4(manifest, currentSignerAuthorization);
        signerPublicKey = currentSignerAuthorization.certificate.signerPublicKey;
      } else {
        signerAuthorization = verifyHistoricalProcessorSignerAuthorizationV1(crypto, {
          authorizationBytes,
          resolveHistoricalIssuingDevicePublicKey:
            input.resolveHistoricalIssuingDevicePublicKey,
        });
        assertProcessorAuthorizationBoundary(manifest, signerAuthorization);
        signerPublicKey = signerAuthorization.authorization.signerPublicKey;
      }
      if (
        !verifyProcessorObjectBytesV1(crypto, {
          principal: manifest.signer,
          signerPublicKey,
          message: signingBytes,
          signature: manifest.signature,
        })
      ) {
        throw new TypeError(
          "Processor object access manifest signature is invalid",
        );
      }
    }
    const result = Object.freeze({
      manifest,
      manifestBytes,
      manifestHash: manifestHash(crypto, manifestBytes),
      signerAuthorization,
      currentSignerAuthorization,
    });
    verified = true;
    return result;
  } finally {
    if (!verified) manifestBytes.fill(0);
    if (!verified && currentSignerAuthorization !== null) destroyVerifiedProcessorSignerAuthorizationV2(currentSignerAuthorization);
    signingBytes?.fill(0);
  }
}
