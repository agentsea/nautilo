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
import type { LatticeCrypto } from "../crypto/index.ts";
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
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
  utf8V2,
} from "./v2-primitives.ts";

export const OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V3 = 3 as const;
export const OBJECT_ACCESS_MANIFEST_DOMAIN_V3 =
  "nautilo/lattice-crypto/object-access-manifest/v3";

const HASH_BYTES = 32;
const AGENT_RUNTIME_SIGNER_KIND = "agent_runtime";
const FRAME_LENGTH_BYTES = 4;
export const MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V3 =
  FRAME_LENGTH_BYTES + utf8V2(OBJECT_ACCESS_MANIFEST_DOMAIN_V3).length
  + 4
  + FRAME_LENGTH_BYTES + V2_LIMITS.idBytes
  + FRAME_LENGTH_BYTES + HASH_BYTES
  + 8
  + 4
  + FRAME_LENGTH_BYTES + HASH_BYTES
  + 4
  + V2_LIMITS.namespaceEnvelopesPerManifest
    * (FRAME_LENGTH_BYTES + HASH_BYTES)
  + FRAME_LENGTH_BYTES + utf8V2(AGENT_RUNTIME_SIGNER_KIND).length
  + FRAME_LENGTH_BYTES + V2_LIMITS.idBytes
  + 8
  + FRAME_LENGTH_BYTES + V2_LIMITS.idBytes
  + 8
  + FRAME_LENGTH_BYTES + V2_LIMITS.signatureBytes;

export interface ObjectAccessManifestUnsignedV3 {
  readonly objectId: ObjectId;
  readonly payloadHash: Uint8Array;
  readonly accessRevision: AccessRevision;
  /** Hash of the previous access manifest; null only at access revision zero. */
  readonly previousManifestHash: Uint8Array | null;
  readonly envelopeHashes: readonly Uint8Array[];
  readonly signer: AgentRuntimeObjectSignerPrincipalV1;
  readonly hostAuthorizationRevision: AuthorizationRevision;
}

export interface ObjectAccessManifestV3
  extends ObjectAccessManifestUnsignedV3 {
  readonly formatVersion: typeof OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V3;
  readonly signature: Uint8Array;
}

export interface CreatedAgentObjectAccessManifestV3 {
  readonly manifest: ObjectAccessManifestV3;
  readonly bytes: Uint8Array;
  /** Canonical access-manifest hash used by the next revision/storage head. */
  readonly hash: Uint8Array;
}

export type ResolveAgentRuntimeSignerPublicKeyV3 = (
  principal: AgentRuntimeObjectSignerPrincipalV1,
) => Uint8Array | null;

export interface VerifiedAgentObjectAccessManifestV3 {
  readonly manifest: ObjectAccessManifestV3;
  readonly manifestBytes: Uint8Array;
  readonly manifestHash: Uint8Array;
}

const UNSIGNED_FIELDS = Object.freeze([
  "objectId",
  "payloadHash",
  "accessRevision",
  "previousManifestHash",
  "envelopeHashes",
  "signer",
  "hostAuthorizationRevision",
] as const);
const SIGNED_FIELDS = Object.freeze([
  "formatVersion",
  ...UNSIGNED_FIELDS,
  "signature",
] as const);

function assertExactFields(
  label: string,
  value: object,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  for (const field of Object.keys(value)) {
    if (!allowedSet.has(field)) {
      throw new TypeError(`${label} contains unknown field ${field}`);
    }
  }
}

function assertFixedBytes(
  label: string,
  value: unknown,
  length: number,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new TypeError(`${label} must be exactly ${length} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  return compareUnsignedUtf8(bytesToHex(left), bytesToHex(right));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return compareBytes(left, right) === 0;
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
      assertFixedBytes("envelope hash", hashValue, HASH_BYTES))
    .sort(compareBytes);
  for (let index = 1; index < canonical.length; index++) {
    if (equalBytes(canonical[index - 1]!, canonical[index]!)) {
      throw new TypeError("manifest contains a duplicate envelope hash");
    }
  }
  return Object.freeze(canonical);
}

function normalizeUnsigned(
  value: ObjectAccessManifestUnsignedV3,
): ObjectAccessManifestUnsignedV3 {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("object access manifest must be an object");
  }
  assertExactFields("object access manifest", value, UNSIGNED_FIELDS);
  const normalized = Object.freeze({
    objectId: objectId(value.objectId),
    payloadHash: assertFixedBytes(
      "payload hash",
      value.payloadHash,
      HASH_BYTES,
    ),
    accessRevision: accessRevision(value.accessRevision),
    previousManifestHash: value.previousManifestHash === null
      ? null
      : assertFixedBytes(
        "previous manifest hash",
        value.previousManifestHash,
        HASH_BYTES,
      ),
    envelopeHashes: canonicalEnvelopeHashes(value.envelopeHashes),
    signer: normalizeAgentRuntimeObjectSignerPrincipalV1(value.signer),
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
  manifest: ObjectAccessManifestV3,
): ObjectAccessManifestUnsignedV3 {
  return {
    objectId: manifest.objectId,
    payloadHash: manifest.payloadHash,
    accessRevision: manifest.accessRevision,
    previousManifestHash: manifest.previousManifestHash,
    envelopeHashes: manifest.envelopeHashes,
    signer: manifest.signer,
    hostAuthorizationRevision: manifest.hostAuthorizationRevision,
  };
}

function signingBytesFromNormalized(
  manifest: ObjectAccessManifestUnsignedV3,
): Uint8Array {
  return concatV2(
    frameText(OBJECT_ACCESS_MANIFEST_DOMAIN_V3),
    encodeU32(OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V3),
    frameText(manifest.objectId),
    frame(manifest.payloadHash),
    encodeU64(manifest.accessRevision),
    encodeU32(manifest.previousManifestHash === null ? 0 : 1),
    ...(manifest.previousManifestHash === null
      ? []
      : [frame(manifest.previousManifestHash)]),
    encodeU32(manifest.envelopeHashes.length),
    ...manifest.envelopeHashes.map(frame),
    frameText(manifest.signer.kind),
    frameText(manifest.signer.agentId),
    encodeU64(manifest.signer.runtimeGeneration),
    frameText(manifest.signer.signerKeyId),
    encodeU64(manifest.hostAuthorizationRevision),
  );
}

export function objectAccessManifestSigningBytesV3(
  manifest: ObjectAccessManifestUnsignedV3,
): Uint8Array {
  return signingBytesFromNormalized(normalizeUnsigned(manifest));
}

function normalizeSigned(
  manifest: ObjectAccessManifestV3,
): ObjectAccessManifestV3 {
  if (typeof manifest !== "object" || manifest === null) {
    throw new TypeError("object access manifest must be an object");
  }
  assertExactFields("object access manifest", manifest, SIGNED_FIELDS);
  if (manifest.formatVersion !== OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V3) {
    throw new TypeError("unsupported object access manifest version");
  }
  const normalized = normalizeUnsigned(unsignedFromSigned(manifest));
  return Object.freeze({
    formatVersion: OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V3,
    ...normalized,
    signature: assertFixedBytes(
      "manifest signature",
      manifest.signature,
      V2_LIMITS.signatureBytes,
    ),
  });
}

export function encodeObjectAccessManifestV3(
  manifest: ObjectAccessManifestV3,
): Uint8Array {
  const normalized = normalizeSigned(manifest);
  return concatV2(
    signingBytesFromNormalized(normalized),
    frame(normalized.signature),
  );
}

function decodeHash(reader: StrictDecoder): Uint8Array {
  return reader.readFrame(HASH_BYTES);
}

export function decodeObjectAccessManifestV3(
  bytes: Uint8Array,
): ObjectAccessManifestV3 {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("object access manifest bytes must be Uint8Array");
  }
  if (bytes.length > MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V3) {
    throw new RangeError("object access manifest exceeds its wire limit");
  }
  return decodeExact(bytes, (reader) => {
    const domain = reader.readText(utf8V2(OBJECT_ACCESS_MANIFEST_DOMAIN_V3).length);
    if (domain !== OBJECT_ACCESS_MANIFEST_DOMAIN_V3) {
      throw new TypeError("object access manifest domain mismatch");
    }
    const formatVersion = reader.readVersion(
      OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V3,
    ) as typeof OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V3;
    const decodedObjectId = objectId(reader.readText(V2_LIMITS.idBytes));
    const payloadHash = decodeHash(reader);
    const decodedAccessRevision = accessRevision(reader.readU64());
    const previousPresence = reader.readU32();
    if (previousPresence !== 0 && previousPresence !== 1) {
      throw new TypeError("previous manifest hash presence must be 0 or 1");
    }
    const previousManifestHash = previousPresence === 0
      ? null
      : decodeHash(reader);
    const count = reader.readCount(V2_LIMITS.namespaceEnvelopesPerManifest);
    const envelopeHashes = Array.from(
      { length: count },
      () => decodeHash(reader),
    );
    const signerKind = reader.readText(utf8V2(AGENT_RUNTIME_SIGNER_KIND).length);
    if (signerKind !== AGENT_RUNTIME_SIGNER_KIND) {
      throw new CanonicalDecodingError(
        "object access manifest signer kind is unsupported",
      );
    }
    const signer = normalizeAgentRuntimeObjectSignerPrincipalV1({
      kind: "agent_runtime",
      agentId: reader.readText(V2_LIMITS.idBytes) as never,
      runtimeGeneration: reader.readU64() as never,
      signerKeyId: reader.readText(V2_LIMITS.idBytes),
    });
    const hostAuthorizationRevision = authorizationRevision(reader.readU64());
    const signature = reader.readFrame(V2_LIMITS.signatureBytes);
    if (signature.length !== V2_LIMITS.signatureBytes) {
      throw new TypeError(
        `manifest signature must be exactly ${V2_LIMITS.signatureBytes} bytes`,
      );
    }
    const normalized = normalizeUnsigned({
      objectId: decodedObjectId,
      payloadHash,
      accessRevision: decodedAccessRevision,
      previousManifestHash,
      envelopeHashes,
      signer,
      hostAuthorizationRevision,
    });
    for (let index = 0; index < envelopeHashes.length; index++) {
      if (
        !equalBytes(
          envelopeHashes[index]!,
          normalized.envelopeHashes[index]!,
        )
      ) {
        throw new TypeError(
          "manifest envelope hashes use noncanonical ordering",
        );
      }
    }
    return Object.freeze({
      formatVersion,
      ...normalized,
      signature,
    });
  });
}

function manifestHash(
  crypto: LatticeCrypto,
  bytes: Uint8Array,
): Uint8Array {
  return assertFixedBytes(
    "object access manifest hash",
    crypto.hash(bytes),
    HASH_BYTES,
  );
}

export function createAgentObjectAccessManifestV3(
  crypto: LatticeCrypto,
  unsigned: ObjectAccessManifestUnsignedV3,
  runtime: AgentRuntimeGenerationV2,
): CreatedAgentObjectAccessManifestV3 {
  const normalized = normalizeUnsigned(unsigned);
  const signingBytes = signingBytesFromNormalized(normalized);
  let signature: Uint8Array | undefined;
  try {
    signature = signAgentRuntimeObjectBytesV1(crypto, {
      runtime,
      signer: normalized.signer,
      message: signingBytes,
    });
    const manifest = Object.freeze({
      formatVersion: OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V3,
      ...normalized,
      signature: assertFixedBytes(
        "manifest signature",
        signature,
        V2_LIMITS.signatureBytes,
      ),
    });
    const bytes = encodeObjectAccessManifestV3(manifest);
    return Object.freeze({
      manifest,
      bytes,
      hash: manifestHash(crypto, bytes),
    });
  } finally {
    signingBytes.fill(0);
    signature?.fill(0);
  }
}

export function verifyAgentObjectAccessManifestV3(
  crypto: LatticeCrypto,
  input: Readonly<{
    readonly manifestBytes: Uint8Array;
    readonly resolveSignerPublicKey: ResolveAgentRuntimeSignerPublicKeyV3;
  }>,
): VerifiedAgentObjectAccessManifestV3 {
  if (!(input.manifestBytes instanceof Uint8Array)) {
    throw new TypeError("object access manifest bytes must be Uint8Array");
  }
  if (
    input.manifestBytes.length > MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V3
  ) {
    throw new RangeError("object access manifest exceeds its wire limit");
  }
  const manifestBytes = copyOwnedBytesV2(input.manifestBytes);
  let publicKey: Uint8Array | undefined;
  let signingBytes: Uint8Array | undefined;
  let verified = false;
  try {
    const manifest = decodeObjectAccessManifestV3(manifestBytes);
    const resolved = input.resolveSignerPublicKey(manifest.signer);
    if (!(resolved instanceof Uint8Array)) {
      throw new Error(
        "no trusted Agent Runtime signing key for object access manifest",
      );
    }
    publicKey = assertFixedBytes(
      "Agent Runtime object signer public key",
      resolved,
      V2_LIMITS.signingPublicKeyBytes,
    );
    signingBytes = signingBytesFromNormalized(
      unsignedFromSigned(manifest),
    );
    if (
      agentRuntimeObjectSignerKeyIdV1(crypto, publicKey)
        !== manifest.signer.signerKeyId
    ) {
      throw new Error(
        "Agent Runtime object signer key id does not match the public key",
      );
    }
    if (!crypto.verify(publicKey, signingBytes, manifest.signature)) {
      throw new Error("Agent object access manifest signature is invalid");
    }
    const result = Object.freeze({
      manifest,
      manifestBytes,
      manifestHash: manifestHash(crypto, manifestBytes),
    });
    verified = true;
    return result;
  } finally {
    if (!verified) {
      manifestBytes.fill(0);
    }
    publicKey?.fill(0);
    signingBytes?.fill(0);
  }
}
