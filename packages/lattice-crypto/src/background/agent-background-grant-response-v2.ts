import { sha256 } from "@noble/hashes/sha2.js";

import type { LatticeCrypto } from "../crypto/index.ts";
import { compareUnsignedUtf8 } from "../domain/participants.ts";
import {
  grantV2SigningBytes,
  parseGrantV2,
  type GrantOperationV2,
  type GrantV2,
} from "../format/grant-v2.ts";
import {
  CanonicalDecodingError,
  concatV2,
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
  utf8V2,
} from "../format/v2-primitives.ts";
import {
  authorizationRevision,
  humanId,
  type AuthorizationRevision,
  type HumanId,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import {
  MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V2,
  decodeBackgroundAgentWorkDescriptorV2,
  type BackgroundDomainRequirementV2,
  type BackgroundNamespaceRequirementV2,
  type BackgroundAgentWorkDescriptorV2,
} from "./work-descriptor-v2.ts";

export const AGENT_BACKGROUND_GRANT_RESPONSE_FORMAT_VERSION_V2 = 2 as const;
export const AGENT_BACKGROUND_GRANT_RESPONSE_DOMAIN_V2 =
  "nautilo/lattice-crypto/agent-background-grant-response/v2";
export const AGENT_BACKGROUND_GRANT_RESPONSE_MAX_TTL_MS_V2 =
  10 * 60 * 1_000;
export const MAX_AGENT_BACKGROUND_GRANT_RESPONSE_WIRE_BYTES_V2 =
  V2_LIMITS.agentGrantWireBytes
  + MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V2
  + 4 * 1_024;

const HASH_BYTES = 32;

export interface AgentBackgroundGrantResponseUnsignedV2 {
  readonly formatVersion:
    typeof AGENT_BACKGROUND_GRANT_RESPONSE_FORMAT_VERSION_V2;
  readonly workDescriptorBytes: Uint8Array;
  readonly workDescriptorHash: Uint8Array;
  readonly grantBytes: Uint8Array;
  readonly grantHash: Uint8Array;
  readonly issuingHumanId: HumanId;
  readonly issuingDeviceAuthorizationRevision: AuthorizationRevision;
  readonly issuerSigningPublicKeyHash: Uint8Array;
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
}

export interface AgentBackgroundGrantResponseV2
  extends AgentBackgroundGrantResponseUnsignedV2 {
  readonly signature: Uint8Array;
}

export interface CreatedAgentBackgroundGrantResponseV2 {
  readonly response: AgentBackgroundGrantResponseV2;
  readonly bytes: Uint8Array;
  readonly hash: Uint8Array;
}

export interface AgentBackgroundGrantIssuerContextV2 {
  readonly purpose:
    | "verify-current-agent-background-grant-response-v2"
    | "verify-historical-agent-background-grant-response-v2";
  readonly requestId: string;
  readonly recipientGeneration: number;
  readonly recipientKeyId: string;
  readonly recipientPublicKey: Uint8Array;
  readonly workDescriptorHash: Uint8Array;
  readonly grantId: string;
  readonly grantHash: Uint8Array;
  readonly grantScope: readonly HumanId[];
  readonly operations: readonly GrantOperationV2[];
  readonly agentId: string;
  readonly runtimeGeneration: number;
  /** Global Agent Runtime-state authorization revision. */
  readonly agentAuthorizationRevision: number;
  readonly anchorNamespaceId: string;
  readonly anchorDomainId: string;
  readonly namespaceRequirements:
    readonly BackgroundNamespaceRequirementV2[];
  readonly domainRequirements: readonly BackgroundDomainRequirementV2[];
  readonly issuingHumanId: HumanId;
  readonly issuingDeviceId: string;
  readonly issuingDeviceAuthorizationRevision: AuthorizationRevision;
  readonly issuerSigningPublicKeyHash: Uint8Array;
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
}

export type ResolveAgentBackgroundGrantIssuerPublicKeyV2 = (
  context: AgentBackgroundGrantIssuerContextV2,
) => Uint8Array | null | Promise<Uint8Array | null>;

export interface VerifiedAgentBackgroundGrantResponseV2 {
  readonly response: AgentBackgroundGrantResponseV2;
  readonly responseBytes: Uint8Array;
  readonly responseHash: Uint8Array;
  readonly workDescriptor: BackgroundAgentWorkDescriptorV2;
  readonly grant: GrantV2;
  readonly grantBytes: Uint8Array;
}

const UNSIGNED_FIELDS = Object.freeze([
  "expiresAt",
  "formatVersion",
  "grantBytes",
  "grantHash",
  "issuedAt",
  "issuerSigningPublicKeyHash",
  "issuingDeviceAuthorizationRevision",
  "issuingHumanId",
  "notBefore",
  "workDescriptorBytes",
  "workDescriptorHash",
] as const);
const SIGNED_FIELDS = Object.freeze([...UNSIGNED_FIELDS, "signature"]);

function assertRecord(
  label: string,
  value: unknown,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertExactFields(
  label: string,
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort(compareUnsignedUtf8);
  const canonical = [...expected].sort(compareUnsignedUtf8);
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

function boundedBytes(
  label: string,
  value: unknown,
  maximum: number,
): Uint8Array {
  if (
    !(value instanceof Uint8Array)
    || value.length < 1
    || value.length > maximum
  ) {
    throw new TypeError(`${label} must contain 1-${maximum} bytes`);
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

function equalStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function destroyDescriptor(descriptor: BackgroundAgentWorkDescriptorV2): void {
  descriptor.recipientPublicKey.fill(0);
  if (descriptor.source.kind === "synthetic_payload") {
    descriptor.source.fingerprint.fill(0);
  }
}

function destroyGrant(grant: GrantV2): void {
  grant.encryptedSecret.fill(0);
  grant.signature.fill(0);
}

function destroyUnsigned(
  response: AgentBackgroundGrantResponseUnsignedV2,
): void {
  response.workDescriptorBytes.fill(0);
  response.workDescriptorHash.fill(0);
  response.grantBytes.fill(0);
  response.grantHash.fill(0);
  response.issuerSigningPublicKeyHash.fill(0);
}

function destroyResponse(response: AgentBackgroundGrantResponseV2): void {
  destroyUnsigned(response);
  response.signature.fill(0);
}

export function assertBoundAgentGrantV2(
  descriptor: BackgroundAgentWorkDescriptorV2,
  grant: GrantV2,
): void {
  if (
    grant.consumed
    || !grant.singleUse
    || grant.recipientAgentId !== descriptor.subject.agentId
    || grant.recipientKeyId !== descriptor.recipientKeyId
    || grant.issuingDeviceId.length === 0
    || grant.issuedAt !== descriptor.issuedAt
    || grant.expiresAt !== descriptor.expiresAt
    || !equalStrings(grant.scope, descriptor.grantScope)
    || !equalStrings(grant.operations, descriptor.operations)
    || grant.coveredDomains.length !== descriptor.domainRequirements.length
    || grant.coveredDomains.some((covered, index) => {
      const requirement = descriptor.domainRequirements[index];
      return requirement === undefined
        || covered.domainId !== requirement.domainId
        || covered.domainEpoch !== requirement.expectedEpoch
        || covered.agentAuthorizationRevision
          !== requirement.expectedAgentAuthorizationRevision;
    })
  ) {
    throw new TypeError(
      "Agent GrantV2 does not match the exact background work descriptor v2",
    );
  }
}

function normalizeUnsigned(
  value: AgentBackgroundGrantResponseUnsignedV2,
): AgentBackgroundGrantResponseUnsignedV2 {
  assertRecord("Agent background grant response v2", value);
  assertExactFields(
    "Agent background grant response v2",
    value,
    UNSIGNED_FIELDS,
  );
  if (
    value["formatVersion"]
      !== AGENT_BACKGROUND_GRANT_RESPONSE_FORMAT_VERSION_V2
  ) {
    throw new TypeError(
      "Agent background grant response v2 format version is invalid",
    );
  }
  let workDescriptorBytes: Uint8Array | undefined;
  let workDescriptorHash: Uint8Array | undefined;
  let grantBytes: Uint8Array | undefined;
  let grantHash: Uint8Array | undefined;
  let issuerSigningPublicKeyHash: Uint8Array | undefined;
  let descriptor: BackgroundAgentWorkDescriptorV2 | undefined;
  let grant: GrantV2 | null = null;
  try {
    workDescriptorBytes = boundedBytes(
      "Agent background work descriptor v2",
      value["workDescriptorBytes"],
      MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V2,
    );
    workDescriptorHash = exactBytes(
      "Agent background work descriptor v2 hash",
      value["workDescriptorHash"],
      HASH_BYTES,
    );
    if (!equalBytes(sha256(workDescriptorBytes), workDescriptorHash)) {
      throw new TypeError(
        "Agent background work descriptor v2 hash does not match",
      );
    }
    descriptor = decodeBackgroundAgentWorkDescriptorV2(workDescriptorBytes);
    grantBytes = boundedBytes(
      "Agent background GrantV2",
      value["grantBytes"],
      V2_LIMITS.agentGrantWireBytes,
    );
    grantHash = exactBytes(
      "Agent background GrantV2 hash",
      value["grantHash"],
      HASH_BYTES,
    );
    if (!equalBytes(sha256(grantBytes), grantHash)) {
      throw new TypeError("Agent background GrantV2 hash does not match");
    }
    grant = parseGrantV2(grantBytes);
    if (grant === null) {
      throw new TypeError("Agent background GrantV2 is invalid");
    }
    assertBoundAgentGrantV2(descriptor, grant);
    const issuingHumanId = humanId(value["issuingHumanId"]);
    const issuingDeviceAuthorizationRevision = authorizationRevision(
      value["issuingDeviceAuthorizationRevision"],
    );
    if (!descriptor.grantScope.includes(issuingHumanId)) {
      throw new TypeError(
        "Agent background grant scope excludes its issuing Human",
      );
    }
    issuerSigningPublicKeyHash = exactBytes(
      "Agent background issuer signing public key hash",
      value["issuerSigningPublicKeyHash"],
      HASH_BYTES,
    );
    if (
      !Number.isSafeInteger(value["issuedAt"])
      || !Number.isSafeInteger(value["notBefore"])
      || !Number.isSafeInteger(value["expiresAt"])
      || value["issuedAt"] < 0
      || value["issuedAt"] > value["notBefore"]
      || value["notBefore"] >= value["expiresAt"]
      || value["expiresAt"] - value["issuedAt"]
        > AGENT_BACKGROUND_GRANT_RESPONSE_MAX_TTL_MS_V2
      || value["issuedAt"] !== descriptor.issuedAt
      || value["notBefore"] !== descriptor.notBefore
      || value["expiresAt"] !== descriptor.expiresAt
    ) {
      throw new RangeError(
        "Agent background grant response v2 timestamps are invalid",
      );
    }
    return Object.freeze({
      formatVersion: AGENT_BACKGROUND_GRANT_RESPONSE_FORMAT_VERSION_V2,
      workDescriptorBytes,
      workDescriptorHash,
      grantBytes,
      grantHash,
      issuingHumanId,
      issuingDeviceAuthorizationRevision,
      issuerSigningPublicKeyHash,
      issuedAt: value["issuedAt"],
      notBefore: value["notBefore"],
      expiresAt: value["expiresAt"],
    });
  } catch (error) {
    workDescriptorBytes?.fill(0);
    workDescriptorHash?.fill(0);
    grantBytes?.fill(0);
    grantHash?.fill(0);
    issuerSigningPublicKeyHash?.fill(0);
    throw error;
  } finally {
    if (descriptor !== undefined) destroyDescriptor(descriptor);
    if (grant !== null) destroyGrant(grant);
  }
}

function normalizeResponse(
  value: AgentBackgroundGrantResponseV2,
): AgentBackgroundGrantResponseV2 {
  assertRecord("Agent background grant response v2", value);
  assertExactFields(
    "Agent background grant response v2",
    value,
    SIGNED_FIELDS,
  );
  const { signature: rawSignature, ...rawUnsigned } = value;
  const unsigned = normalizeUnsigned(rawUnsigned);
  try {
    const signature = exactBytes(
      "Agent background grant response v2 signature",
      rawSignature,
      V2_LIMITS.signatureBytes,
    );
    return Object.freeze({ ...unsigned, signature });
  } catch (error) {
    destroyUnsigned(unsigned);
    throw error;
  }
}

function signingBytesFromNormalized(
  value: AgentBackgroundGrantResponseUnsignedV2,
): Uint8Array {
  return concatV2(
    frameText(AGENT_BACKGROUND_GRANT_RESPONSE_DOMAIN_V2),
    encodeU32(AGENT_BACKGROUND_GRANT_RESPONSE_FORMAT_VERSION_V2),
    frame(value.workDescriptorBytes),
    frame(value.workDescriptorHash),
    frame(value.grantBytes),
    frame(value.grantHash),
    frameText(value.issuingHumanId),
    encodeU64(value.issuingDeviceAuthorizationRevision),
    frame(value.issuerSigningPublicKeyHash),
    encodeU64(value.issuedAt),
    encodeU64(value.notBefore),
    encodeU64(value.expiresAt),
  );
}

export function agentBackgroundGrantResponseSigningBytesV2(
  value: AgentBackgroundGrantResponseUnsignedV2,
): Uint8Array {
  const normalized = normalizeUnsigned(value);
  try {
    return signingBytesFromNormalized(normalized);
  } finally {
    destroyUnsigned(normalized);
  }
}

export function encodeAgentBackgroundGrantResponseV2(
  value: AgentBackgroundGrantResponseV2,
): Uint8Array {
  const normalized = normalizeResponse(value);
  try {
    const bytes = concatV2(
      signingBytesFromNormalized(normalized),
      frame(normalized.signature),
    );
    if (bytes.length > MAX_AGENT_BACKGROUND_GRANT_RESPONSE_WIRE_BYTES_V2) {
      bytes.fill(0);
      throw new RangeError(
        "Agent background grant response v2 exceeds its wire limit",
      );
    }
    return bytes;
  } finally {
    destroyResponse(normalized);
  }
}

export function decodeAgentBackgroundGrantResponseV2(
  bytes: Uint8Array,
): AgentBackgroundGrantResponseV2 {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError(
      "Agent background grant response v2 bytes must be Uint8Array",
    );
  }
  if (bytes.length > MAX_AGENT_BACKGROUND_GRANT_RESPONSE_WIRE_BYTES_V2) {
    throw new RangeError(
      "Agent background grant response v2 exceeds its wire limit",
    );
  }
  const raw = decodeExact(bytes, (reader): AgentBackgroundGrantResponseV2 => {
    const domain = reader.readText(
      utf8V2(AGENT_BACKGROUND_GRANT_RESPONSE_DOMAIN_V2).length,
    );
    if (domain !== AGENT_BACKGROUND_GRANT_RESPONSE_DOMAIN_V2) {
      throw new CanonicalDecodingError(
        "Agent background grant response v2 domain mismatch",
      );
    }
    return {
      formatVersion: reader.readVersion(
        AGENT_BACKGROUND_GRANT_RESPONSE_FORMAT_VERSION_V2,
      ) as typeof AGENT_BACKGROUND_GRANT_RESPONSE_FORMAT_VERSION_V2,
      workDescriptorBytes: reader.readFrame(
        MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V2,
      ),
      workDescriptorHash: reader.readFrame(HASH_BYTES),
      grantBytes: reader.readFrame(V2_LIMITS.agentGrantWireBytes),
      grantHash: reader.readFrame(HASH_BYTES),
      issuingHumanId: humanId(reader.readText(V2_LIMITS.idBytes)),
      issuingDeviceAuthorizationRevision: authorizationRevision(
        reader.readU64(),
      ),
      issuerSigningPublicKeyHash: reader.readFrame(HASH_BYTES),
      issuedAt: reader.readU64(),
      notBefore: reader.readU64(),
      expiresAt: reader.readU64(),
      signature: reader.readFrame(V2_LIMITS.signatureBytes),
    };
  });
  let normalized: AgentBackgroundGrantResponseV2 | undefined;
  let canonical: Uint8Array | undefined;
  try {
    normalized = normalizeResponse(raw);
    canonical = encodeAgentBackgroundGrantResponseV2(normalized);
    if (!equalBytes(canonical, bytes)) {
      throw new CanonicalDecodingError(
        "Agent background grant response v2 is noncanonical",
      );
    }
    const result = normalized;
    normalized = undefined;
    return result;
  } finally {
    destroyResponse(raw);
    if (normalized !== undefined) destroyResponse(normalized);
    canonical?.fill(0);
  }
}

export function createAgentBackgroundGrantResponseV2(
  crypto: LatticeCrypto,
  input: Readonly<{
    readonly workDescriptorBytes: Uint8Array;
    readonly grantBytes: Uint8Array;
    readonly issuingHumanId: HumanId;
    readonly issuingDeviceAuthorizationRevision: AuthorizationRevision;
    readonly issuingDeviceSigningPublicKey: Uint8Array;
    readonly issuingDeviceSigningPrivateKey: Uint8Array;
  }>,
): CreatedAgentBackgroundGrantResponseV2 {
  const descriptorBytes = boundedBytes(
    "Agent background work descriptor v2",
    input.workDescriptorBytes,
    MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V2,
  );
  const exactGrantBytes = boundedBytes(
    "Agent background GrantV2",
    input.grantBytes,
    V2_LIMITS.agentGrantWireBytes,
  );
  let descriptor: BackgroundAgentWorkDescriptorV2 | undefined;
  let grant: GrantV2 | null = null;
  let publicKey: Uint8Array | undefined;
  let privateKey: Uint8Array | undefined;
  let signingBytes: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  try {
    descriptor = decodeBackgroundAgentWorkDescriptorV2(descriptorBytes);
    grant = parseGrantV2(exactGrantBytes);
    if (grant === null) {
      throw new TypeError("Agent background GrantV2 is invalid");
    }
    assertBoundAgentGrantV2(descriptor, grant);
    const issuerHuman = humanId(input.issuingHumanId);
    if (!descriptor.grantScope.includes(issuerHuman)) {
      throw new TypeError(
        "Agent background grant scope excludes its issuing Human",
      );
    }
    publicKey = exactBytes(
      "Agent background issuer signing public key",
      input.issuingDeviceSigningPublicKey,
      V2_LIMITS.signingPublicKeyBytes,
    );
    privateKey = exactBytes(
      "Agent background issuer signing private key",
      input.issuingDeviceSigningPrivateKey,
      V2_LIMITS.signingPrivateKeyBytes,
    );
    const grantSigningBytes = grantV2SigningBytes(grant);
    try {
      if (!crypto.verify(publicKey, grantSigningBytes, grant.signature)) {
        throw new TypeError(
          "Agent background GrantV2 issuer signature is invalid",
        );
      }
    } finally {
      grantSigningBytes.fill(0);
    }
    const unsigned = normalizeUnsigned({
      formatVersion: AGENT_BACKGROUND_GRANT_RESPONSE_FORMAT_VERSION_V2,
      workDescriptorBytes: descriptorBytes,
      workDescriptorHash: crypto.hash(descriptorBytes),
      grantBytes: exactGrantBytes,
      grantHash: crypto.hash(exactGrantBytes),
      issuingHumanId: issuerHuman,
      issuingDeviceAuthorizationRevision: authorizationRevision(
        input.issuingDeviceAuthorizationRevision,
      ),
      issuerSigningPublicKeyHash: crypto.hash(publicKey),
      issuedAt: descriptor.issuedAt,
      notBefore: descriptor.notBefore,
      expiresAt: descriptor.expiresAt,
    });
    try {
      signingBytes = signingBytesFromNormalized(unsigned);
      signature = exactBytes(
        "Agent background grant response v2 signature",
        crypto.sign(privateKey, signingBytes),
        V2_LIMITS.signatureBytes,
      );
      if (!crypto.verify(publicKey, signingBytes, signature)) {
        throw new TypeError(
          "Agent background grant response v2 issuer keys do not match",
        );
      }
      const bytes = encodeAgentBackgroundGrantResponseV2({
        ...unsigned,
        signature,
      });
      return Object.freeze({
        response: decodeAgentBackgroundGrantResponseV2(bytes),
        bytes,
        hash: exactBytes(
          "Agent background grant response v2 hash",
          crypto.hash(bytes),
          HASH_BYTES,
        ),
      });
    } finally {
      destroyUnsigned(unsigned);
    }
  } finally {
    descriptorBytes.fill(0);
    exactGrantBytes.fill(0);
    if (descriptor !== undefined) destroyDescriptor(descriptor);
    if (grant !== null) destroyGrant(grant);
    publicKey?.fill(0);
    privateKey?.fill(0);
    signingBytes?.fill(0);
    signature?.fill(0);
  }
}

function issuerContext(
  purpose: AgentBackgroundGrantIssuerContextV2["purpose"],
  response: AgentBackgroundGrantResponseV2,
  descriptor: BackgroundAgentWorkDescriptorV2,
  grant: GrantV2,
): AgentBackgroundGrantIssuerContextV2 {
  return Object.freeze({
    purpose,
    requestId: descriptor.requestId,
    recipientGeneration: descriptor.recipientGeneration,
    recipientKeyId: descriptor.recipientKeyId,
    recipientPublicKey: copyOwnedBytesV2(descriptor.recipientPublicKey),
    workDescriptorHash: copyOwnedBytesV2(response.workDescriptorHash),
    grantId: grant.id,
    grantHash: copyOwnedBytesV2(response.grantHash),
    grantScope: Object.freeze([...descriptor.grantScope]),
    operations: Object.freeze([...descriptor.operations]),
    agentId: descriptor.subject.agentId,
    runtimeGeneration: descriptor.subject.runtimeGeneration,
    agentAuthorizationRevision: descriptor.subject.authorizationRevision,
    anchorNamespaceId: descriptor.anchorNamespaceId,
    anchorDomainId: descriptor.anchorDomainId,
    namespaceRequirements: descriptor.namespaceRequirements,
    domainRequirements: descriptor.domainRequirements,
    issuingHumanId: response.issuingHumanId,
    issuingDeviceId: grant.issuingDeviceId,
    issuingDeviceAuthorizationRevision:
      response.issuingDeviceAuthorizationRevision,
    issuerSigningPublicKeyHash:
      copyOwnedBytesV2(response.issuerSigningPublicKeyHash),
    issuedAt: response.issuedAt,
    notBefore: response.notBefore,
    expiresAt: response.expiresAt,
  });
}

function destroyIssuerContext(
  context: AgentBackgroundGrantIssuerContextV2,
): void {
  context.recipientPublicKey.fill(0);
  context.workDescriptorHash.fill(0);
  context.grantHash.fill(0);
  context.issuerSigningPublicKeyHash.fill(0);
}

async function verifyWithResolver(
  crypto: LatticeCrypto,
  input: Readonly<{
    readonly responseBytes: Uint8Array;
    readonly purpose: AgentBackgroundGrantIssuerContextV2["purpose"];
    readonly now?: number;
    readonly resolveIssuingDevicePublicKey:
      ResolveAgentBackgroundGrantIssuerPublicKeyV2;
  }>,
): Promise<VerifiedAgentBackgroundGrantResponseV2> {
  if (typeof input.resolveIssuingDevicePublicKey !== "function") {
    throw new TypeError(
      "Agent background grant issuer resolver v2 is required",
    );
  }
  if (
    input.now !== undefined
    && (!Number.isSafeInteger(input.now) || input.now < 0)
  ) {
    throw new TypeError(
      "Agent background grant verification time is invalid",
    );
  }
  const responseBytes = boundedBytes(
    "Agent background grant response v2 wire",
    input.responseBytes,
    MAX_AGENT_BACKGROUND_GRANT_RESPONSE_WIRE_BYTES_V2,
  );
  let response: AgentBackgroundGrantResponseV2 | undefined;
  let descriptor: BackgroundAgentWorkDescriptorV2 | undefined;
  let grant: GrantV2 | null = null;
  let context: AgentBackgroundGrantIssuerContextV2 | undefined;
  let issuerPublicKey: Uint8Array | undefined;
  try {
    response = decodeAgentBackgroundGrantResponseV2(responseBytes);
    if (
      input.now !== undefined
      && (input.now < response.notBefore || input.now >= response.expiresAt)
    ) {
      throw new TypeError(
        "Agent background grant response v2 is not currently valid",
      );
    }
    descriptor = decodeBackgroundAgentWorkDescriptorV2(
      response.workDescriptorBytes,
    );
    grant = parseGrantV2(response.grantBytes);
    if (grant === null) {
      throw new TypeError("Agent background GrantV2 is invalid");
    }
    assertBoundAgentGrantV2(descriptor, grant);
    context = issuerContext(input.purpose, response, descriptor, grant);
    const resolved = await input.resolveIssuingDevicePublicKey(context);
    if (resolved === null) {
      throw new TypeError(
        "Agent background grant issuer v2 is not currently authorized",
      );
    }
    issuerPublicKey = exactBytes(
      "Agent background resolved issuer public key",
      resolved,
      V2_LIMITS.signingPublicKeyBytes,
    );
    if (
      !equalBytes(
        crypto.hash(issuerPublicKey),
        response.issuerSigningPublicKeyHash,
      )
    ) {
      throw new TypeError(
        "Agent background issuer public key does not match",
      );
    }
    const grantSigningBytes = grantV2SigningBytes(grant);
    const responseSigningBytes = signingBytesFromNormalized(response);
    try {
      if (
        !crypto.verify(issuerPublicKey, grantSigningBytes, grant.signature)
        || !crypto.verify(
          issuerPublicKey,
          responseSigningBytes,
          response.signature,
        )
      ) {
        throw new TypeError(
          "Agent background grant response v2 signature is invalid",
        );
      }
    } finally {
      grantSigningBytes.fill(0);
      responseSigningBytes.fill(0);
    }
    const result = Object.freeze({
      response,
      responseBytes,
      responseHash: exactBytes(
        "Agent background grant response v2 hash",
        crypto.hash(responseBytes),
        HASH_BYTES,
      ),
      workDescriptor: descriptor,
      grant,
      grantBytes: copyOwnedBytesV2(response.grantBytes),
    });
    response = undefined;
    descriptor = undefined;
    grant = null;
    return result;
  } finally {
    if (response !== undefined) destroyResponse(response);
    if (descriptor !== undefined) destroyDescriptor(descriptor);
    if (grant !== null) destroyGrant(grant);
    if (context !== undefined) destroyIssuerContext(context);
    issuerPublicKey?.fill(0);
  }
}

export function verifyCurrentAgentBackgroundGrantResponseV2(
  crypto: LatticeCrypto,
  input: Readonly<{
    readonly responseBytes: Uint8Array;
    readonly now: number;
    readonly resolveCurrentIssuingDevicePublicKey:
      ResolveAgentBackgroundGrantIssuerPublicKeyV2;
  }>,
): Promise<VerifiedAgentBackgroundGrantResponseV2> {
  return verifyWithResolver(crypto, {
    responseBytes: input.responseBytes,
    purpose: "verify-current-agent-background-grant-response-v2",
    now: input.now,
    resolveIssuingDevicePublicKey:
      input.resolveCurrentIssuingDevicePublicKey,
  });
}

export function verifyHistoricalAgentBackgroundGrantResponseV2(
  crypto: LatticeCrypto,
  input: Readonly<{
    readonly responseBytes: Uint8Array;
    readonly resolveHistoricalIssuingDevicePublicKey:
      ResolveAgentBackgroundGrantIssuerPublicKeyV2;
  }>,
): Promise<VerifiedAgentBackgroundGrantResponseV2> {
  return verifyWithResolver(crypto, {
    responseBytes: input.responseBytes,
    purpose: "verify-historical-agent-background-grant-response-v2",
    resolveIssuingDevicePublicKey:
      input.resolveHistoricalIssuingDevicePublicKey,
  });
}
