import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type { LatticeCrypto } from "../crypto/index.ts";
import {
  concatV2,
  encodeU32,
  frame,
  frameText,
} from "../format/v2-primitives.ts";
import { assertPortableId } from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

export const PROCESSOR_OBJECT_SIGNER_DOMAIN_V1 =
  "nautilo/lattice-crypto/processor-object-signer/v1";
export const PROCESSOR_OBJECT_SIGNER_FORMAT_VERSION_V1 = 1 as const;
export const PROCESSOR_OBJECT_SIGNER_KEY_ID_PREFIX_V1 =
  "processor_invocation_signer_";

const PROCESSOR_OBJECT_SIGNER_KEY_ID_PATTERN =
  /^processor_invocation_signer_[0-9a-f]{64}$/u;
const HASH_BYTES = 32;

export interface ProcessorObjectSignerPrincipalV1 {
  readonly kind: "processor_invocation";
  readonly processorKind: "stenographer" | "reflection";
  readonly processorVersion: 1;
  readonly signerAuthorizationId: string;
  readonly workDescriptorHash: Uint8Array;
  readonly signerKeyId: string;
}

export interface ProcessorObjectSignerPublicV1 {
  readonly principal: ProcessorObjectSignerPrincipalV1;
  readonly publicKey: Uint8Array;
}

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

export function processorObjectSignerKeyIdV1(
  crypto: LatticeCrypto,
  publicKey: Uint8Array,
): string {
  const ownedPublicKey = exactBytes(
    "Processor object signer public key",
    publicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  let digest: Uint8Array | undefined;
  try {
    digest = exactBytes(
      "Processor object signer public key digest",
      crypto.hash(ownedPublicKey),
      HASH_BYTES,
    );
    const keyId = `${PROCESSOR_OBJECT_SIGNER_KEY_ID_PREFIX_V1}${
      bytesToHex(digest)
    }`;
    assertPortableId("Processor object signer key id", keyId);
    return keyId;
  } finally {
    digest?.fill(0);
    ownedPublicKey.fill(0);
  }
}

export function normalizeProcessorObjectSignerPrincipalV1(
  value: ProcessorObjectSignerPrincipalV1,
): ProcessorObjectSignerPrincipalV1 {
  assertObject("Processor object signer principal", value);
  assertExactFields("Processor object signer principal", value, [
    "kind",
    "processorKind",
    "processorVersion",
    "signerAuthorizationId",
    "workDescriptorHash",
    "signerKeyId",
  ]);
  if (value.kind !== "processor_invocation") {
    throw new TypeError("Processor object signer principal kind is invalid");
  }
  if (
    (value.processorKind !== "stenographer" && value.processorKind !== "reflection")
    || value.processorVersion !== 1
  ) {
    throw new TypeError("Processor object signer processor is invalid");
  }
  assertPortableId(
    "Processor signer authorization id",
    value.signerAuthorizationId,
  );
  const workDescriptorHash = exactBytes(
    "Processor object signer work descriptor hash",
    value.workDescriptorHash,
    HASH_BYTES,
  );
  try {
    assertPortableId("Processor object signer key id", value.signerKeyId);
    if (!PROCESSOR_OBJECT_SIGNER_KEY_ID_PATTERN.test(value.signerKeyId)) {
      throw new TypeError("Processor object signer key id is invalid");
    }
    return Object.freeze({
      kind: "processor_invocation",
      processorKind: value.processorKind,
      processorVersion: 1,
      signerAuthorizationId: value.signerAuthorizationId,
      workDescriptorHash,
      signerKeyId: value.signerKeyId,
    });
  } catch (error) {
    workDescriptorHash.fill(0);
    throw error;
  }
}

function copyProcessorObjectSignerPrivateKey(
  value: unknown,
): Uint8Array {
  return exactBytes(
    "Processor object signer private key",
    value,
    V2_LIMITS.signingPrivateKeyBytes,
  );
}

function copyProcessorObjectSignerPublicKey(
  value: unknown,
): Uint8Array {
  return exactBytes(
    "Processor object signer public key",
    value,
    V2_LIMITS.signingPublicKeyBytes,
  );
}

export function createProcessorObjectSignerPublicV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    readonly processorKind: "stenographer" | "reflection";
    readonly processorVersion: 1;
    readonly signerAuthorizationId: string;
    readonly workDescriptorHash: Uint8Array;
    readonly signerPrivateKey: Uint8Array;
  }>,
): ProcessorObjectSignerPublicV1 {
  const signerPrivateKey = copyProcessorObjectSignerPrivateKey(
    input.signerPrivateKey,
  );
  let publicKey: Uint8Array | undefined;
  try {
    publicKey = copyProcessorObjectSignerPublicKey(
      ed25519.getPublicKey(signerPrivateKey),
    );
    const principal = normalizeProcessorObjectSignerPrincipalV1({
      kind: "processor_invocation",
      processorKind: input.processorKind,
      processorVersion: input.processorVersion,
      signerAuthorizationId: input.signerAuthorizationId,
      workDescriptorHash: input.workDescriptorHash,
      signerKeyId: processorObjectSignerKeyIdV1(crypto, publicKey),
    });
    return Object.freeze({
      principal,
      publicKey: copyOwnedBytesV2(publicKey),
    });
  } finally {
    publicKey?.fill(0);
    signerPrivateKey.fill(0);
  }
}

export function processorObjectSignerSigningBytesV1(
  principal: ProcessorObjectSignerPrincipalV1,
  message: Uint8Array,
): Uint8Array {
  const normalized = normalizeProcessorObjectSignerPrincipalV1(principal);
  const ownedMessage = copyOwnedBytesV2(message);
  try {
    return concatV2(
      frameText(PROCESSOR_OBJECT_SIGNER_DOMAIN_V1),
      encodeU32(PROCESSOR_OBJECT_SIGNER_FORMAT_VERSION_V1),
      frameText(normalized.kind),
      frameText(normalized.processorKind),
      encodeU32(normalized.processorVersion),
      frameText(normalized.signerAuthorizationId),
      frame(normalized.workDescriptorHash),
      frameText(normalized.signerKeyId),
      frame(ownedMessage),
    );
  } finally {
    normalized.workDescriptorHash.fill(0);
    ownedMessage.fill(0);
  }
}

export function signProcessorObjectBytesV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    readonly principal: ProcessorObjectSignerPrincipalV1;
    readonly signerPrivateKey: Uint8Array;
    readonly message: Uint8Array;
  }>,
): Uint8Array {
  const signerPrivateKey = copyProcessorObjectSignerPrivateKey(
    input.signerPrivateKey,
  );
  let publicKey: Uint8Array | undefined;
  let signingBytes: Uint8Array | undefined;
  try {
    publicKey = copyProcessorObjectSignerPublicKey(
      ed25519.getPublicKey(signerPrivateKey),
    );
    const principal = normalizeProcessorObjectSignerPrincipalV1(
      input.principal,
    );
    if (
      processorObjectSignerKeyIdV1(crypto, publicKey)
      !== principal.signerKeyId
    ) {
      throw new TypeError(
        "Processor object signer key id does not match the private key",
      );
    }
    signingBytes = processorObjectSignerSigningBytesV1(
      principal,
      input.message,
    );
    return exactBytes(
      "Processor object signature",
      crypto.sign(signerPrivateKey, signingBytes),
      V2_LIMITS.signatureBytes,
    );
  } finally {
    signingBytes?.fill(0);
    publicKey?.fill(0);
    signerPrivateKey.fill(0);
  }
}

export function verifyProcessorObjectBytesV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    readonly principal: ProcessorObjectSignerPrincipalV1;
    readonly signerPublicKey: Uint8Array;
    readonly message: Uint8Array;
    readonly signature: Uint8Array;
  }>,
): boolean {
  let signerPublicKey: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  let signingBytes: Uint8Array | undefined;
  try {
    const principal = normalizeProcessorObjectSignerPrincipalV1(
      input.principal,
    );
    signerPublicKey = exactBytes(
      "Processor object signer public key",
      input.signerPublicKey,
      V2_LIMITS.signingPublicKeyBytes,
    );
    signature = exactBytes(
      "Processor object signature",
      input.signature,
      V2_LIMITS.signatureBytes,
    );
    if (
      processorObjectSignerKeyIdV1(crypto, signerPublicKey)
      !== principal.signerKeyId
    ) {
      return false;
    }
    signingBytes = processorObjectSignerSigningBytesV1(
      principal,
      input.message,
    );
    return crypto.verify(signerPublicKey, signingBytes, signature);
  } catch {
    return false;
  } finally {
    signingBytes?.fill(0);
    signature?.fill(0);
    signerPublicKey?.fill(0);
  }
}
