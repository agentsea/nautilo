import {
  assertPortableId,
  MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V1,
  MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V1,
  MAX_PROCESSOR_SIGNER_AUTHORIZATION_WIRE_BYTES_V1,
  V2_LIMITS,
  decodeBackgroundAuthorizationResponseV1,
  decodeBackgroundWorkDescriptorV1,
  decodeProcessorSignerAuthorizationV1,
  encodeBackgroundWorkDescriptorV1,
  type BackgroundAuthorizationResponseV1,
  type LatticeCrypto,
  type ProcessorSignerAuthorizationV1,
} from "@nautilo/lattice-crypto/background";

import type {
  BackgroundAuthorizationDeviceFulfillment,
  BackgroundAuthorizationDeviceRequest,
  BackgroundAuthorizationDeviceResponderErrorCode,
} from "./background-authorization-responder.ts";

export const BACKGROUND_AUTHORIZATION_TRANSPORT_FORMAT_VERSION_V1 = 1 as const;

const HASH_BYTES = 32;
const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function maximumBase64urlCharacters(bytes: number): number {
  return Math.ceil(bytes * 4 / 3);
}

const BACKGROUND_AUTHORIZATION_REQUEST_DTO_FIXED_BYTES_V1 = JSON.stringify({
    formatVersion: 1,
    requestId: "A".repeat(V2_LIMITS.idBytes),
    recipientGeneration: Number.MAX_SAFE_INTEGER,
    descriptorBytesBase64url: "",
    descriptorHashBase64url: "",
  } satisfies BackgroundAuthorizationDeviceRequestDtoV1).length;
export const MAX_BACKGROUND_AUTHORIZATION_REQUEST_DTO_BYTES_V1 =
  BACKGROUND_AUTHORIZATION_REQUEST_DTO_FIXED_BYTES_V1
  + maximumBase64urlCharacters(MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V1)
  + maximumBase64urlCharacters(HASH_BYTES);

const BACKGROUND_AUTHORIZATION_RESPONSE_DTO_FIXED_BYTES_V1 = JSON.stringify({
    formatVersion: 1,
    status: "fulfilled",
    requestId: "A".repeat(V2_LIMITS.idBytes),
    recipientGeneration: Number.MAX_SAFE_INTEGER,
    expiresAt: Number.MAX_SAFE_INTEGER,
    responseBytesBase64url: "",
    responseHashBase64url: "",
    credentialHashBase64url: "",
    signerAuthorizationBytesBase64url: "",
    signerAuthorizationHashBase64url: "",
  } satisfies BackgroundAuthorizationDeviceFulfillmentDtoV1).length;
export const MAX_BACKGROUND_AUTHORIZATION_RESPONSE_DTO_BYTES_V1 =
  BACKGROUND_AUTHORIZATION_RESPONSE_DTO_FIXED_BYTES_V1
  + maximumBase64urlCharacters(
    MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V1,
  )
  + maximumBase64urlCharacters(
    MAX_PROCESSOR_SIGNER_AUTHORIZATION_WIRE_BYTES_V1,
  )
  + 3 * maximumBase64urlCharacters(HASH_BYTES);

export interface BackgroundAuthorizationDeviceRequestDtoV1 {
  readonly formatVersion:
    typeof BACKGROUND_AUTHORIZATION_TRANSPORT_FORMAT_VERSION_V1;
  readonly requestId: string;
  readonly recipientGeneration: number;
  readonly descriptorBytesBase64url: string;
  readonly descriptorHashBase64url: string;
}

export interface BackgroundAuthorizationDeviceFulfillmentDtoV1 {
  readonly formatVersion:
    typeof BACKGROUND_AUTHORIZATION_TRANSPORT_FORMAT_VERSION_V1;
  readonly status: "fulfilled";
  readonly requestId: string;
  readonly recipientGeneration: number;
  readonly expiresAt: number;
  readonly responseBytesBase64url: string;
  readonly responseHashBase64url: string;
  readonly credentialHashBase64url: string;
  readonly signerAuthorizationBytesBase64url: string;
  readonly signerAuthorizationHashBase64url: string;
}

export interface BackgroundAuthorizationDeviceRefusal {
  readonly formatVersion:
    typeof BACKGROUND_AUTHORIZATION_TRANSPORT_FORMAT_VERSION_V1;
  readonly requestId: string;
  readonly recipientGeneration: number;
  readonly code: BackgroundAuthorizationDeviceResponderErrorCode;
}

export interface BackgroundAuthorizationDeviceRefusalDtoV1
  extends BackgroundAuthorizationDeviceRefusal {
  readonly status: "refused";
}

export type BackgroundAuthorizationDeviceResponse =
  | BackgroundAuthorizationDeviceFulfillment
  | BackgroundAuthorizationDeviceRefusal;

export type BackgroundAuthorizationDeviceResponseDtoV1 =
  | BackgroundAuthorizationDeviceFulfillmentDtoV1
  | BackgroundAuthorizationDeviceRefusalDtoV1;

export type BackgroundAuthorizationTransportErrorCode =
  | "malformed"
  | "noncanonical"
  | "oversized"
  | "unsupported_version"
  | "stale_coordinates";

export class BackgroundAuthorizationTransportError extends Error {
  override readonly name = "BackgroundAuthorizationTransportError";

  constructor(readonly code: BackgroundAuthorizationTransportErrorCode) {
    super(`Background authorization transport failed (${code})`);
  }
}

const REFUSAL_CODES = new Set<BackgroundAuthorizationDeviceResponderErrorCode>([
  "malformed_request",
  "unsupported_request",
  "excessive_scope",
  "not_yet_valid",
  "expired",
  "authority_unavailable",
  "human_removed",
  "device_revoked",
  "namespace_unavailable",
  "membership_removed",
  "domain_unavailable",
  "processor_unavailable",
  "agent_unavailable",
  "stale_authority",
]);

function fail(code: BackgroundAuthorizationTransportErrorCode): never {
  throw new BackgroundAuthorizationTransportError(code);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function encodeBase64url(bytes: Uint8Array): string {
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += BASE64URL_ALPHABET[first >>> 2]!;
    encoded += BASE64URL_ALPHABET[((first & 3) << 4) | ((second ?? 0) >>> 4)]!;
    if (second !== undefined) {
      encoded += BASE64URL_ALPHABET[((second & 15) << 2) | ((third ?? 0) >>> 6)]!;
    }
    if (third !== undefined) encoded += BASE64URL_ALPHABET[third & 63]!;
  }
  return encoded;
}

function decodeBase64url(
  value: unknown,
  maximumBytes: number,
  exactLength?: number,
): Uint8Array {
  if (typeof value !== "string" || value.length === 0
    || value.length % 4 === 1
    || value.length > maximumBase64urlCharacters(maximumBytes)) {
    fail("noncanonical");
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) fail("noncanonical");
  const outputLength = Math.floor(value.length * 6 / 8);
  if (outputLength > maximumBytes
    || (exactLength !== undefined && outputLength !== exactLength)) {
    fail("oversized");
  }
  const output = new Uint8Array(outputLength);
  let accumulator = 0;
  let bits = 0;
  let offset = 0;
  for (const character of value) {
    const digit = BASE64URL_ALPHABET.indexOf(character);
    if (digit < 0) fail("noncanonical");
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[offset++] = (accumulator >>> bits) & 0xff;
    }
  }
  if (offset !== output.length || encodeBase64url(output) !== value) {
    output.fill(0);
    fail("noncanonical");
  }
  return output;
}

/** Portable canonical codec shared with the current device discovery sweep. */
export {
  decodeBase64url as decodeBackgroundAuthorizationBase64url,
  encodeBase64url as encodeBackgroundAuthorizationBase64url,
};

function exactFields(value: unknown, expected: readonly string[]):
  asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("malformed");
  }
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length
    || actual.some((field, index) => field !== sortedExpected[index])) {
    fail("malformed");
  }
}

function safeCoordinate(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail("malformed");
  return value as number;
}

function requestId(value: unknown): string {
  try {
    assertPortableId("Background authorization request ID", value);
    return value;
  } catch {
    fail("malformed");
  }
}

function parseCanonicalJson(
  bytes: Uint8Array,
  maximum: number,
): Record<string, unknown> {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) fail("malformed");
  if (bytes.length > maximum) fail("oversized");
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    parsed = JSON.parse(text) as unknown;
  } catch {
    fail("malformed");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("malformed");
  }
  if ((parsed as Record<string, unknown>)["formatVersion"] !== 1) {
    fail("unsupported_version");
  }
  if (JSON.stringify(parsed) !== text) fail("noncanonical");
  return parsed as Record<string, unknown>;
}

function canonicalJson(value: object, maximum: number): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.length > maximum) fail("oversized");
  return bytes;
}

function hash32(crypto: Pick<LatticeCrypto, "hash">, bytes: Uint8Array): Uint8Array {
  const hash = crypto.hash(bytes);
  if (!(hash instanceof Uint8Array) || hash.length !== HASH_BYTES) {
    if (hash instanceof Uint8Array) hash.fill(0);
    fail("malformed");
  }
  return hash;
}

function assertCanonicalDescriptor(
  crypto: Pick<LatticeCrypto, "hash">,
  request: BackgroundAuthorizationDeviceRequest,
): Readonly<{ requestId: string; recipientGeneration: number }> {
  if (!(request.descriptorBytes instanceof Uint8Array)
    || request.descriptorBytes.length === 0
    || request.descriptorBytes.length > MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V1
    || !(request.descriptorHash instanceof Uint8Array)
    || request.descriptorHash.length !== HASH_BYTES) fail("malformed");
  try {
    const descriptor = decodeBackgroundWorkDescriptorV1(request.descriptorBytes);
    let canonical: Uint8Array | undefined;
    let computed: Uint8Array | undefined;
    try {
      canonical = encodeBackgroundWorkDescriptorV1(descriptor);
      computed = hash32(crypto, request.descriptorBytes);
      if (!equalBytes(canonical, request.descriptorBytes)
        || !equalBytes(computed, request.descriptorHash)) fail("noncanonical");
      return {
        requestId: descriptor.requestId,
        recipientGeneration: descriptor.recipientGeneration,
      };
    } finally {
      canonical?.fill(0);
      computed?.fill(0);
      descriptor.recipientPublicKey.fill(0);
      descriptor.source.fingerprint.fill(0);
    }
  } catch (error) {
    if (error instanceof BackgroundAuthorizationTransportError) throw error;
    fail("malformed");
  }
}

export function encodeBackgroundAuthorizationDeviceRequestDtoV1(
  crypto: Pick<LatticeCrypto, "hash">,
  request: BackgroundAuthorizationDeviceRequest,
): Uint8Array {
  const coordinates = assertCanonicalDescriptor(crypto, request);
  return canonicalJson({
    formatVersion: BACKGROUND_AUTHORIZATION_TRANSPORT_FORMAT_VERSION_V1,
    requestId: coordinates.requestId,
    recipientGeneration: coordinates.recipientGeneration,
    descriptorBytesBase64url: encodeBase64url(request.descriptorBytes),
    descriptorHashBase64url: encodeBase64url(request.descriptorHash),
  } satisfies BackgroundAuthorizationDeviceRequestDtoV1,
  MAX_BACKGROUND_AUTHORIZATION_REQUEST_DTO_BYTES_V1);
}

export function decodeBackgroundAuthorizationDeviceRequestDtoV1(
  crypto: Pick<LatticeCrypto, "hash">,
  bytes: Uint8Array,
): BackgroundAuthorizationDeviceRequest {
  const value = parseCanonicalJson(
    bytes,
    MAX_BACKGROUND_AUTHORIZATION_REQUEST_DTO_BYTES_V1,
  );
  exactFields(value, ["formatVersion", "requestId", "recipientGeneration",
    "descriptorBytesBase64url", "descriptorHashBase64url"]);
  const outerRequestId = requestId(value["requestId"]);
  const outerGeneration = safeCoordinate(value["recipientGeneration"]);
  let descriptorBytes: Uint8Array | undefined;
  let descriptorHash: Uint8Array | undefined;
  try {
    descriptorBytes = decodeBase64url(value["descriptorBytesBase64url"],
      MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V1);
    descriptorHash = decodeBase64url(value["descriptorHashBase64url"],
      HASH_BYTES, HASH_BYTES);
    const request: BackgroundAuthorizationDeviceRequest = {
      formatVersion: 1,
      descriptorBytes,
      descriptorHash,
    };
    const coordinates = assertCanonicalDescriptor(crypto, request);
    if (coordinates.requestId !== outerRequestId
      || coordinates.recipientGeneration !== outerGeneration) {
      fail("stale_coordinates");
    }
    descriptorBytes = undefined;
    descriptorHash = undefined;
    return Object.freeze(request);
  } catch (error) {
    descriptorBytes?.fill(0);
    descriptorHash?.fill(0);
    throw error;
  }
}

function refusalDto(value: BackgroundAuthorizationDeviceRefusal):
  BackgroundAuthorizationDeviceRefusalDtoV1 {
  if (value.formatVersion !== 1 || !REFUSAL_CODES.has(value.code)) {
    fail("malformed");
  }
  return {
    formatVersion: 1,
    status: "refused",
    requestId: requestId(value.requestId),
    recipientGeneration: safeCoordinate(value.recipientGeneration),
    code: value.code,
  };
}

function fulfillmentDto(
  crypto: Pick<LatticeCrypto, "hash">,
  value: BackgroundAuthorizationDeviceFulfillment,
): BackgroundAuthorizationDeviceFulfillmentDtoV1 {
  let responseHash: Uint8Array | undefined;
  let signerHash: Uint8Array | undefined;
  let response: BackgroundAuthorizationResponseV1 | undefined;
  let signer: ProcessorSignerAuthorizationV1 | undefined;
  try {
    if (value.formatVersion !== 1 || !Number.isSafeInteger(value.expiresAt)
      || value.expiresAt < 0) fail("malformed");
    const outerRequestId = requestId(value.requestId);
    const outerGeneration = safeCoordinate(value.recipientGeneration);
    response = decodeBackgroundAuthorizationResponseV1(
      value.responseBytes,
    );
    signer = decodeProcessorSignerAuthorizationV1(
      value.signerAuthorizationBytes,
    );
    responseHash = hash32(crypto, value.responseBytes);
    signerHash = hash32(crypto, value.signerAuthorizationBytes);
    if (!(value.responseHash instanceof Uint8Array)
      || value.responseHash.length !== HASH_BYTES
      || !(value.credentialHash instanceof Uint8Array)
      || value.credentialHash.length !== HASH_BYTES
      || !(value.signerAuthorizationHash instanceof Uint8Array)
      || value.signerAuthorizationHash.length !== HASH_BYTES
      || !equalBytes(value.responseHash, responseHash)
      || !equalBytes(value.credentialHash, response.credentialHash)
      || !equalBytes(value.signerAuthorizationHash, signerHash)
      || !equalBytes(signer.credentialHash, response.credentialHash)
      || !equalBytes(signer.workDescriptorHash, response.workDescriptorHash)) {
      fail("noncanonical");
    }
    if (outerRequestId !== response.requestId
      || outerGeneration !== response.recipientGeneration
      || value.expiresAt !== response.expiresAt) fail("stale_coordinates");
    return {
      formatVersion: 1,
      status: "fulfilled",
      requestId: outerRequestId,
      recipientGeneration: outerGeneration,
      expiresAt: value.expiresAt,
      responseBytesBase64url: encodeBase64url(value.responseBytes),
      responseHashBase64url: encodeBase64url(value.responseHash),
      credentialHashBase64url: encodeBase64url(value.credentialHash),
      signerAuthorizationBytesBase64url:
        encodeBase64url(value.signerAuthorizationBytes),
      signerAuthorizationHashBase64url:
        encodeBase64url(value.signerAuthorizationHash),
    };
  } catch (error) {
    if (error instanceof BackgroundAuthorizationTransportError) throw error;
    fail("malformed");
  } finally {
    responseHash?.fill(0);
    signerHash?.fill(0);
    if (response !== undefined) {
      response.recipientPublicKey.fill(0);
      response.credentialBytes.fill(0);
      response.credentialHash.fill(0);
      response.issuerSigningPublicKeyHash.fill(0);
      response.workDescriptorHash.fill(0);
      response.signature.fill(0);
    }
    if (signer !== undefined) {
      signer.issuerSigningPublicKeyHash.fill(0);
      signer.signer.workDescriptorHash.fill(0);
      signer.signerPublicKey.fill(0);
      signer.workDescriptorHash.fill(0);
      signer.credentialHash.fill(0);
      signer.signature.fill(0);
    }
  }
  return fail("malformed");
}

export function encodeBackgroundAuthorizationDeviceResponseDtoV1(
  crypto: Pick<LatticeCrypto, "hash">,
  response: BackgroundAuthorizationDeviceResponse,
): Uint8Array {
  const dto = "code" in response
    ? refusalDto(response)
    : fulfillmentDto(crypto, response);
  return canonicalJson(dto, MAX_BACKGROUND_AUTHORIZATION_RESPONSE_DTO_BYTES_V1);
}

export function decodeBackgroundAuthorizationDeviceResponseDtoV1(
  crypto: Pick<LatticeCrypto, "hash">,
  bytes: Uint8Array,
): BackgroundAuthorizationDeviceResponse {
  const value = parseCanonicalJson(
    bytes,
    MAX_BACKGROUND_AUTHORIZATION_RESPONSE_DTO_BYTES_V1,
  );
  if (value["status"] === "refused") {
    exactFields(value, ["formatVersion", "status", "requestId",
      "recipientGeneration", "code"]);
    const refusal = refusalDto({
      formatVersion: 1,
      requestId: value["requestId"] as string,
      recipientGeneration: value["recipientGeneration"] as number,
      code: value["code"] as BackgroundAuthorizationDeviceResponderErrorCode,
    });
    return Object.freeze({
      formatVersion: refusal.formatVersion,
      requestId: refusal.requestId,
      recipientGeneration: refusal.recipientGeneration,
      code: refusal.code,
    });
  }
  if (value["status"] !== "fulfilled") fail("malformed");
  exactFields(value, ["formatVersion", "status", "requestId",
    "recipientGeneration", "expiresAt", "responseBytesBase64url",
    "responseHashBase64url", "credentialHashBase64url",
    "signerAuthorizationBytesBase64url", "signerAuthorizationHashBase64url"]);
  const owned: Uint8Array[] = [];
  try {
    const decodeOwned = (encoded: unknown, maximum: number, exact?: number) => {
      const decoded = decodeBase64url(encoded, maximum, exact);
      owned.push(decoded);
      return decoded;
    };
    const response: BackgroundAuthorizationDeviceFulfillment = {
      formatVersion: 1,
      requestId: value["requestId"] as string,
      recipientGeneration: value["recipientGeneration"] as number,
      expiresAt: value["expiresAt"] as number,
      responseBytes: decodeOwned(value["responseBytesBase64url"],
        MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V1),
      responseHash: decodeOwned(value["responseHashBase64url"],
        HASH_BYTES, HASH_BYTES),
      credentialHash: decodeOwned(value["credentialHashBase64url"],
        HASH_BYTES, HASH_BYTES),
      signerAuthorizationBytes: decodeOwned(
        value["signerAuthorizationBytesBase64url"],
        MAX_PROCESSOR_SIGNER_AUTHORIZATION_WIRE_BYTES_V1,
      ),
      signerAuthorizationHash: decodeOwned(
        value["signerAuthorizationHashBase64url"], HASH_BYTES, HASH_BYTES),
    };
    fulfillmentDto(crypto, response);
    owned.length = 0;
    return Object.freeze(response);
  } catch (error) {
    for (const bytesToWipe of owned) bytesToWipe.fill(0);
    throw error;
  }
}
