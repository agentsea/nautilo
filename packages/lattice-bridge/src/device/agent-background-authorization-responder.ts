import {
  LATTICE_LIMITS,
  canonicalizeParticipants,
  grantId,
  mintGrant,
  type AccessRevision,
  type AgentId,
  type AgentRuntimeGeneration,
  type AuthorizationRevision,
  type CryptoDeviceId,
  type CryptoDomainId,
  type DomainEpoch,
  type HumanId,
  type LatticeCrypto,
  type NamespaceId,
} from "@nautilo/lattice-crypto";
import {
  MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V1,
  backgroundWorkDescriptorDigestV1,
  createAgentBackgroundGrantResponseV1,
  decodeBackgroundWorkDescriptorV1,
  serializeGrantV2,
  type BackgroundWorkDescriptorV1,
  type CreatedAgentBackgroundGrantResponseV1,
  type GrantV2,
} from "@nautilo/lattice-crypto/wire";

import {
  BACKGROUND_AUTHORIZATION_DEVICE_CREDENTIAL_TTL_MS,
  BACKGROUND_AUTHORIZATION_DEVICE_FULFILLMENT_FORMAT_VERSION,
  BACKGROUND_AUTHORIZATION_DEVICE_MAX_CIPHERTEXT_BYTES,
  BACKGROUND_AUTHORIZATION_DEVICE_MAX_INPUT_OBJECTS,
  BACKGROUND_AUTHORIZATION_DEVICE_MAX_OUTPUT_OBJECTS,
  BACKGROUND_AUTHORIZATION_DEVICE_MAX_PLAINTEXT_BYTES,
  BACKGROUND_AUTHORIZATION_DEVICE_REQUEST_FORMAT_VERSION,
  BackgroundAuthorizationDeviceResponderError,
  type BackgroundAuthorizationDeviceRequest,
} from "./background-authorization-responder.ts";

const HASH_BYTES = 32;

export interface AgentBackgroundAuthorizationDeviceAuthority {
  readonly humanId: HumanId;
  readonly humanState: "active" | "removed";
  readonly deviceId: CryptoDeviceId;
  readonly deviceHumanId: HumanId;
  readonly deviceState: "active" | "revoked";
  readonly deviceAuthorizationRevision: AuthorizationRevision;
  readonly deviceSigningPublicKey: Uint8Array;
  readonly deviceSigningPrivateKey: Uint8Array;
  readonly namespaceId: NamespaceId;
  readonly namespaceState: "active" | "deleted";
  readonly membershipHumanId: HumanId;
  readonly membershipState: "active" | "removed";
  readonly namespaceParticipants: readonly HumanId[];
  readonly namespaceAccessRevision: AccessRevision;
  readonly policyRevision: AuthorizationRevision;
  readonly domainId: CryptoDomainId;
  readonly domainState: "active" | "retired";
  readonly domainEpoch: DomainEpoch;
  readonly agentId: AgentId;
  readonly agentState: "active" | "disabled" | "deleted";
  readonly runtimeGeneration: AgentRuntimeGeneration;
  readonly agentAuthorizationRevision: AuthorizationRevision;
  readonly aiRoot: Uint8Array;
}

export interface AgentBackgroundAuthorizationDeviceAuthorityContext {
  readonly purpose: "fulfill-current-agent-background-authorization";
  readonly requestId: string;
  readonly recipientGeneration: number;
  readonly descriptorHash: Uint8Array;
  readonly workKind: BackgroundWorkDescriptorV1["workKind"];
  readonly workId: string;
  readonly agentId: AgentId;
  readonly runtimeGeneration: AgentRuntimeGeneration;
  readonly agentAuthorizationRevision: AuthorizationRevision;
  readonly namespaceId: NamespaceId;
  readonly domainId: CryptoDomainId;
  readonly expectedDomainEpoch: DomainEpoch;
  readonly expectedNamespaceAccessRevision: AccessRevision;
  readonly expectedPolicyRevision: AuthorizationRevision;
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
}

export type ResolveCurrentAgentBackgroundAuthorizationDeviceAuthority = (
  context: AgentBackgroundAuthorizationDeviceAuthorityContext,
) =>
  | AgentBackgroundAuthorizationDeviceAuthority
  | null
  | Promise<AgentBackgroundAuthorizationDeviceAuthority | null>;

export interface AgentBackgroundAuthorizationDeviceFulfillment {
  readonly formatVersion:
    typeof BACKGROUND_AUTHORIZATION_DEVICE_FULFILLMENT_FORMAT_VERSION;
  readonly requestId: string;
  readonly recipientGeneration: number;
  readonly expiresAt: number;
  readonly responseBytes: Uint8Array;
  readonly responseHash: Uint8Array;
  readonly grantHash: Uint8Array;
}

type ParsedRequest = Readonly<{
  descriptor: BackgroundWorkDescriptorV1;
  descriptorBytes: Uint8Array;
  descriptorHash: Uint8Array;
}>;

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function exactBytes(
  value: unknown,
  length: number,
  code: "malformed_request" | "authority_unavailable",
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new BackgroundAuthorizationDeviceResponderError(code);
  }
  return Uint8Array.from(value);
}

function destroyDescriptor(descriptor: BackgroundWorkDescriptorV1): void {
  descriptor.recipientPublicKey.fill(0);
  descriptor.source.fingerprint.fill(0);
}

function destroyGrant(grant: GrantV2 | undefined): void {
  if (grant === undefined) return;
  grant.encryptedSecret.fill(0);
  grant.signature.fill(0);
}

function destroyResponse(
  response: CreatedAgentBackgroundGrantResponseV1 | undefined,
): void {
  if (response === undefined) return;
  response.response.workDescriptorBytes.fill(0);
  response.response.workDescriptorHash.fill(0);
  response.response.grantBytes.fill(0);
  response.response.grantHash.fill(0);
  response.response.issuerSigningPublicKeyHash.fill(0);
  response.response.signature.fill(0);
  response.bytes.fill(0);
  response.hash.fill(0);
}

function assertExactRequest(
  request: unknown,
): asserts request is BackgroundAuthorizationDeviceRequest {
  if (
    typeof request !== "object"
    || request === null
    || Array.isArray(request)
    || Object.keys(request).sort().join(",")
      !== "descriptorBytes,descriptorHash,formatVersion"
  ) {
    throw new BackgroundAuthorizationDeviceResponderError(
      "malformed_request",
    );
  }
}

function parseRequest(
  crypto: LatticeCrypto,
  request: unknown,
): ParsedRequest {
  assertExactRequest(request);
  if (
    request.formatVersion
      !== BACKGROUND_AUTHORIZATION_DEVICE_REQUEST_FORMAT_VERSION
    || !(request.descriptorBytes instanceof Uint8Array)
    || request.descriptorBytes.length < 1
    || request.descriptorBytes.length
      > MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V1
  ) {
    throw new BackgroundAuthorizationDeviceResponderError(
      "malformed_request",
    );
  }
  const descriptorBytes = Uint8Array.from(request.descriptorBytes);
  let descriptorHash: Uint8Array | undefined;
  let descriptor: BackgroundWorkDescriptorV1 | undefined;
  try {
    descriptorHash = exactBytes(
      request.descriptorHash,
      HASH_BYTES,
      "malformed_request",
    );
    descriptor = decodeBackgroundWorkDescriptorV1(descriptorBytes);
    const actualHash =
      backgroundWorkDescriptorDigestV1(crypto, descriptor);
    try {
      if (!equalBytes(actualHash, descriptorHash)) {
        throw new BackgroundAuthorizationDeviceResponderError(
          "malformed_request",
        );
      }
    } finally {
      actualHash.fill(0);
    }
    const parsed = Object.freeze({
      descriptor,
      descriptorBytes,
      descriptorHash,
    });
    descriptor = undefined;
    descriptorHash = undefined;
    return parsed;
  } catch (error) {
    if (error instanceof BackgroundAuthorizationDeviceResponderError) {
      throw error;
    }
    throw new BackgroundAuthorizationDeviceResponderError(
      "malformed_request",
    );
  } finally {
    if (descriptor !== undefined) destroyDescriptor(descriptor);
    descriptorHash?.fill(0);
    if (descriptor !== undefined || descriptorHash !== undefined) {
      descriptorBytes.fill(0);
    }
  }
}

function assertSupported(
  descriptor: BackgroundWorkDescriptorV1,
  now: number,
): asserts descriptor is BackgroundWorkDescriptorV1 & {
  readonly subject: Extract<
    BackgroundWorkDescriptorV1["subject"],
    { readonly kind: "agent" }
  >;
} {
  if (
    descriptor.subject.kind !== "agent"
    || descriptor.workKind.startsWith("stenographer.")
  ) {
    throw new BackgroundAuthorizationDeviceResponderError(
      "unsupported_request",
    );
  }
  if (
    descriptor.maximumInputObjectCount
      > BACKGROUND_AUTHORIZATION_DEVICE_MAX_INPUT_OBJECTS
    || descriptor.maximumOutputObjectCount
      > BACKGROUND_AUTHORIZATION_DEVICE_MAX_OUTPUT_OBJECTS
    || descriptor.maximumPlaintextBytes
      > BACKGROUND_AUTHORIZATION_DEVICE_MAX_PLAINTEXT_BYTES
    || descriptor.maximumCiphertextBytes
      > BACKGROUND_AUTHORIZATION_DEVICE_MAX_CIPHERTEXT_BYTES
    || descriptor.expiresAt - descriptor.issuedAt
      > BACKGROUND_AUTHORIZATION_DEVICE_CREDENTIAL_TTL_MS
  ) {
    throw new BackgroundAuthorizationDeviceResponderError(
      "excessive_scope",
    );
  }
  if (now < descriptor.notBefore) {
    throw new BackgroundAuthorizationDeviceResponderError("not_yet_valid");
  }
  if (now >= descriptor.expiresAt) {
    throw new BackgroundAuthorizationDeviceResponderError("expired");
  }
}

function currentParticipants(
  authority: AgentBackgroundAuthorizationDeviceAuthority,
): readonly HumanId[] {
  if (
    !Array.isArray(authority.namespaceParticipants)
    || authority.namespaceParticipants.length < 1
    || authority.namespaceParticipants.length
      > LATTICE_LIMITS.grantScopeHumans
  ) {
    throw new BackgroundAuthorizationDeviceResponderError("excessive_scope");
  }
  let canonical: readonly HumanId[];
  try {
    canonical = canonicalizeParticipants(
      authority.namespaceParticipants,
    );
  } catch {
    throw new BackgroundAuthorizationDeviceResponderError("stale_authority");
  }
  if (
    canonical.length !== authority.namespaceParticipants.length
    || canonical.some(
      (participant, index) =>
        participant !== authority.namespaceParticipants[index],
    )
    || !canonical.includes(authority.humanId)
  ) {
    throw new BackgroundAuthorizationDeviceResponderError("stale_authority");
  }
  return canonical;
}

function assertCurrentAuthority(
  descriptor: BackgroundWorkDescriptorV1 & {
    readonly subject: Extract<
      BackgroundWorkDescriptorV1["subject"],
      { readonly kind: "agent" }
    >;
  },
  authority: AgentBackgroundAuthorizationDeviceAuthority,
): readonly HumanId[] {
  if (authority.humanState !== "active") {
    throw new BackgroundAuthorizationDeviceResponderError("human_removed");
  }
  if (authority.deviceState !== "active") {
    throw new BackgroundAuthorizationDeviceResponderError("device_revoked");
  }
  if (authority.namespaceState !== "active") {
    throw new BackgroundAuthorizationDeviceResponderError(
      "namespace_unavailable",
    );
  }
  if (authority.membershipState !== "active") {
    throw new BackgroundAuthorizationDeviceResponderError(
      "membership_removed",
    );
  }
  if (authority.domainState !== "active") {
    throw new BackgroundAuthorizationDeviceResponderError(
      "domain_unavailable",
    );
  }
  if (authority.agentState !== "active") {
    throw new BackgroundAuthorizationDeviceResponderError(
      "agent_unavailable",
    );
  }
  if (
    authority.deviceHumanId !== authority.humanId
    || authority.membershipHumanId !== authority.humanId
    || authority.namespaceId !== descriptor.namespaceId
    || authority.domainId !== descriptor.domainId
    || authority.domainEpoch !== descriptor.expectedDomainEpoch
    || authority.namespaceAccessRevision
      !== descriptor.expectedNamespaceAccessRevision
    || authority.policyRevision !== descriptor.expectedPolicyRevision
    || authority.agentId !== descriptor.subject.agentId
    || authority.runtimeGeneration
      !== descriptor.subject.runtimeGeneration
    || authority.agentAuthorizationRevision
      !== descriptor.subject.authorizationRevision
    || authority.policyRevision
      !== descriptor.subject.authorizationRevision
  ) {
    throw new BackgroundAuthorizationDeviceResponderError("stale_authority");
  }
  return currentParticipants(authority);
}

function hex(bytes: Uint8Array): string {
  return Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Pure browser-safe Agent-family fulfillment. It reuses GrantV2 unchanged,
 * while the signed response binds that grant to one exact background request
 * and recipient generation.
 */
export async function fulfillAgentBackgroundAuthorizationRequest(
  input: Readonly<{
    readonly crypto: LatticeCrypto;
    readonly request: unknown;
    readonly resolveCurrentAuthority:
      ResolveCurrentAgentBackgroundAuthorizationDeviceAuthority;
  }>,
): Promise<AgentBackgroundAuthorizationDeviceFulfillment> {
  if (
    typeof input.crypto !== "object"
    || input.crypto === null
    || typeof input.resolveCurrentAuthority !== "function"
  ) {
    throw new BackgroundAuthorizationDeviceResponderError(
      "malformed_request",
    );
  }
  const parsed = parseRequest(input.crypto, input.request);
  const { descriptor } = parsed;
  let contextHash: Uint8Array | undefined;
  let issuerPublicKey: Uint8Array | undefined;
  let issuerPrivateKey: Uint8Array | undefined;
  let aiRoot: Uint8Array | undefined;
  let grant: GrantV2 | undefined;
  let grantBytes: Uint8Array | undefined;
  let response: CreatedAgentBackgroundGrantResponseV1 | undefined;
  try {
    const now = input.crypto.clock.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new BackgroundAuthorizationDeviceResponderError(
        "malformed_request",
      );
    }
    assertSupported(descriptor, now);
    contextHash = Uint8Array.from(parsed.descriptorHash);
    let authority: AgentBackgroundAuthorizationDeviceAuthority | null;
    try {
      authority = await input.resolveCurrentAuthority(Object.freeze({
        purpose: "fulfill-current-agent-background-authorization",
        requestId: descriptor.requestId,
        recipientGeneration: descriptor.recipientGeneration,
        descriptorHash: contextHash,
        workKind: descriptor.workKind,
        workId: descriptor.workId,
        agentId: descriptor.subject.agentId,
        runtimeGeneration: descriptor.subject.runtimeGeneration,
        agentAuthorizationRevision:
          descriptor.subject.authorizationRevision,
        namespaceId: descriptor.namespaceId,
        domainId: descriptor.domainId,
        expectedDomainEpoch: descriptor.expectedDomainEpoch,
        expectedNamespaceAccessRevision:
          descriptor.expectedNamespaceAccessRevision,
        expectedPolicyRevision: descriptor.expectedPolicyRevision,
        issuedAt: descriptor.issuedAt,
        notBefore: descriptor.notBefore,
        expiresAt: descriptor.expiresAt,
      }));
    } catch {
      throw new BackgroundAuthorizationDeviceResponderError(
        "authority_unavailable",
      );
    }
    if (authority === null) {
      throw new BackgroundAuthorizationDeviceResponderError(
        "authority_unavailable",
      );
    }
    const participants = assertCurrentAuthority(descriptor, authority);
    issuerPublicKey = exactBytes(
      authority.deviceSigningPublicKey,
      LATTICE_LIMITS.signingPublicKeyBytes,
      "authority_unavailable",
    );
    issuerPrivateKey = exactBytes(
      authority.deviceSigningPrivateKey,
      LATTICE_LIMITS.signingPrivateKeyBytes,
      "authority_unavailable",
    );
    aiRoot = exactBytes(
      authority.aiRoot,
      32,
      "authority_unavailable",
    );
    grant = await mintGrant(input.crypto, {
      id: grantId(`background-agent-grant-${hex(parsed.descriptorHash)}`),
      issuingDeviceId: authority.deviceId,
      issuingHumanId: authority.humanId,
      issuingDeviceSigningPrivateKey: issuerPrivateKey,
      recipientAgentId: descriptor.subject.agentId,
      recipientKeyId: descriptor.recipientKeyId,
      recipientEncryptionPublicKey: descriptor.recipientPublicKey,
      scope: participants,
      operations: descriptor.operations,
      issuedAt: descriptor.issuedAt,
      expiresAt: descriptor.expiresAt,
      coveredDomains: [{
        domainId: descriptor.domainId,
        domainEpoch: descriptor.expectedDomainEpoch,
        agentAuthorizationRevision:
          descriptor.subject.authorizationRevision,
        aiRoot,
      }],
      singleUse: true,
    });
    grantBytes = serializeGrantV2(grant);
    response = createAgentBackgroundGrantResponseV1(input.crypto, {
      workDescriptorBytes: parsed.descriptorBytes,
      grantBytes,
      issuingHumanId: authority.humanId,
      issuingDeviceAuthorizationRevision:
        authority.deviceAuthorizationRevision,
      issuingDeviceSigningPublicKey: issuerPublicKey,
      issuingDeviceSigningPrivateKey: issuerPrivateKey,
    });
    return Object.freeze({
      formatVersion:
        BACKGROUND_AUTHORIZATION_DEVICE_FULFILLMENT_FORMAT_VERSION,
      requestId: descriptor.requestId,
      recipientGeneration: descriptor.recipientGeneration,
      expiresAt: descriptor.expiresAt,
      responseBytes: Uint8Array.from(response.bytes),
      responseHash: Uint8Array.from(response.hash),
      grantHash: Uint8Array.from(response.response.grantHash),
    });
  } catch (error) {
    if (error instanceof BackgroundAuthorizationDeviceResponderError) {
      throw error;
    }
    throw new BackgroundAuthorizationDeviceResponderError(
      "authority_unavailable",
    );
  } finally {
    destroyResponse(response);
    grantBytes?.fill(0);
    destroyGrant(grant);
    issuerPublicKey?.fill(0);
    issuerPrivateKey?.fill(0);
    aiRoot?.fill(0);
    contextHash?.fill(0);
    destroyDescriptor(descriptor);
    parsed.descriptorBytes.fill(0);
    parsed.descriptorHash.fill(0);
  }
}
