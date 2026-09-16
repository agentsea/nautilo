import {
  LATTICE_LIMITS,
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
  BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V2,
  MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V2,
  backgroundWorkDescriptorDigestV2,
  createAgentBackgroundGrantResponseV2,
  decodeBackgroundAgentWorkDescriptorV2,
  serializeGrantV2,
  type BackgroundDomainRequirementV2,
  type BackgroundNamespaceRequirementV2,
  type BackgroundAgentWorkDescriptorV2,
  type CreatedAgentBackgroundGrantResponseV2,
  type GrantV2,
} from "@nautilo/lattice-crypto/wire";

import {
  BACKGROUND_AUTHORIZATION_DEVICE_CREDENTIAL_TTL_MS,
  BACKGROUND_AUTHORIZATION_DEVICE_MAX_CIPHERTEXT_BYTES,
  BACKGROUND_AUTHORIZATION_DEVICE_MAX_INPUT_OBJECTS,
  BACKGROUND_AUTHORIZATION_DEVICE_MAX_OUTPUT_OBJECTS,
  BACKGROUND_AUTHORIZATION_DEVICE_MAX_PLAINTEXT_BYTES,
  BackgroundAuthorizationDeviceResponderError,
} from "./background-authorization-responder.ts";

const HASH_BYTES = 32;

export const AGENT_BACKGROUND_AUTHORIZATION_DEVICE_REQUEST_FORMAT_VERSION_V2 =
  2 as const;
export const AGENT_BACKGROUND_AUTHORIZATION_DEVICE_FULFILLMENT_FORMAT_VERSION_V2 =
  2 as const;

export interface AgentBackgroundAuthorizationDeviceRequestV2 {
  readonly formatVersion:
    typeof AGENT_BACKGROUND_AUTHORIZATION_DEVICE_REQUEST_FORMAT_VERSION_V2;
  readonly descriptorBytes: Uint8Array;
  readonly descriptorHash: Uint8Array;
}

/**
 * A current product-policy decision for one exact Namespace requirement.
 * The injected resolver owns public/cosmos and private subset semantics; this
 * browser-safe layer refuses to approximate those policies from participant
 * arrays.
 */
export interface AgentBackgroundAuthorizationNamespaceAuthorityV2 {
  readonly namespaceId: NamespaceId;
  readonly domainId: CryptoDomainId;
  readonly namespaceState: "active" | "deleted";
  readonly issuingHumanAccess: "authorized" | "removed" | "denied";
  readonly grantScopeAccess: "authorized" | "denied";
  readonly authorizedOperations:
    readonly BackgroundNamespaceRequirementV2["operations"][number][];
  readonly namespaceAccessRevision: AccessRevision;
  readonly policyRevision: AuthorizationRevision;
}

export interface AgentBackgroundAuthorizationDomainPublicAuthorityV2 {
  readonly domainId: CryptoDomainId;
  readonly domainState: "active" | "retired";
  readonly domainEpoch: DomainEpoch;
  readonly agentAuthorizationRevision: AuthorizationRevision;
}

export interface AgentBackgroundAuthorizationDomainAuthorityV2
  extends AgentBackgroundAuthorizationDomainPublicAuthorityV2 {
  readonly aiRoot: Uint8Array;
}

export interface AgentBackgroundAuthorizationDevicePublicAuthorityV2 {
  readonly humanId: HumanId;
  readonly humanState: "active" | "removed";
  readonly deviceId: CryptoDeviceId;
  readonly deviceHumanId: HumanId;
  readonly deviceState: "active" | "revoked";
  readonly deviceAuthorizationRevision: AuthorizationRevision;
  readonly deviceSigningPublicKey: Uint8Array;
  readonly agentId: AgentId;
  readonly agentState: "active" | "disabled" | "deleted";
  readonly runtimeGeneration: AgentRuntimeGeneration;
  readonly agentAuthorizationRevision: AuthorizationRevision;
  readonly namespaces:
    readonly AgentBackgroundAuthorizationNamespaceAuthorityV2[];
  readonly domains:
    readonly AgentBackgroundAuthorizationDomainPublicAuthorityV2[];
}

export type AgentBackgroundAuthorizationDeviceAuthorityV2 = Readonly<
  Omit<AgentBackgroundAuthorizationDevicePublicAuthorityV2, "domains">
  & {
    readonly deviceSigningPrivateKey: Uint8Array;
    readonly domains:
      readonly AgentBackgroundAuthorizationDomainAuthorityV2[];
  }
>;

export interface AgentBackgroundAuthorizationDeviceAuthorityContextV2 {
  readonly purpose: "fulfill-current-agent-background-authorization-v2";
  readonly requestId: string;
  readonly recipientGeneration: number;
  readonly descriptorHash: Uint8Array;
  readonly workKind: BackgroundAgentWorkDescriptorV2["workKind"];
  readonly workId: string;
  readonly grantScope: readonly HumanId[];
  readonly agentId: AgentId;
  readonly runtimeGeneration: AgentRuntimeGeneration;
  readonly agentAuthorizationRevision: AuthorizationRevision;
  readonly namespaceRequirements:
    readonly BackgroundNamespaceRequirementV2[];
  readonly domainRequirements: readonly BackgroundDomainRequirementV2[];
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
}

export type ResolveCurrentAgentBackgroundAuthorizationDeviceAuthorityV2 = (
  context: AgentBackgroundAuthorizationDeviceAuthorityContextV2,
) =>
  | AgentBackgroundAuthorizationDeviceAuthorityV2
  | null
  | Promise<AgentBackgroundAuthorizationDeviceAuthorityV2 | null>;

export interface AgentBackgroundAuthorizationDeviceFulfillmentV2 {
  readonly formatVersion:
    typeof AGENT_BACKGROUND_AUTHORIZATION_DEVICE_FULFILLMENT_FORMAT_VERSION_V2;
  readonly requestId: string;
  readonly recipientGeneration: number;
  readonly expiresAt: number;
  readonly responseBytes: Uint8Array;
  readonly responseHash: Uint8Array;
  readonly grantHash: Uint8Array;
}

type ParsedRequestV2 = Readonly<{
  descriptor: BackgroundAgentWorkDescriptorV2;
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

function destroyDescriptor(descriptor: BackgroundAgentWorkDescriptorV2): void {
  descriptor.recipientPublicKey.fill(0);
  if (descriptor.source.kind === "synthetic_payload") {
    descriptor.source.fingerprint.fill(0);
  }
}

function destroyGrant(grant: GrantV2 | undefined): void {
  if (grant === undefined) return;
  grant.encryptedSecret.fill(0);
  grant.signature.fill(0);
}

function destroyResponse(
  response: CreatedAgentBackgroundGrantResponseV2 | undefined,
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
): asserts request is AgentBackgroundAuthorizationDeviceRequestV2 {
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
): ParsedRequestV2 {
  assertExactRequest(request);
  if (
    request.formatVersion
      !== AGENT_BACKGROUND_AUTHORIZATION_DEVICE_REQUEST_FORMAT_VERSION_V2
    || !(request.descriptorBytes instanceof Uint8Array)
    || request.descriptorBytes.length < 1
    || request.descriptorBytes.length
      > MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V2
  ) {
    throw new BackgroundAuthorizationDeviceResponderError(
      "malformed_request",
    );
  }
  const descriptorBytes = Uint8Array.from(request.descriptorBytes);
  let descriptorHash: Uint8Array | undefined;
  let descriptor: BackgroundAgentWorkDescriptorV2 | undefined;
  try {
    descriptorHash = exactBytes(
      request.descriptorHash,
      HASH_BYTES,
      "malformed_request",
    );
    descriptor = decodeBackgroundAgentWorkDescriptorV2(descriptorBytes);
    if (
      descriptor.formatVersion !== BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V2
    ) {
      throw new BackgroundAuthorizationDeviceResponderError(
        "unsupported_request",
      );
    }
    const actualHash = backgroundWorkDescriptorDigestV2(crypto, descriptor);
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
  descriptor: BackgroundAgentWorkDescriptorV2,
  now: number,
): void {
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

function sameOperations(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((operation, index) => operation === right[index]);
}

function assertExactNamespaces(
  requirements: readonly BackgroundNamespaceRequirementV2[],
  authorities:
    readonly AgentBackgroundAuthorizationNamespaceAuthorityV2[],
): void {
  if (requirements.length !== authorities.length) {
    throw new BackgroundAuthorizationDeviceResponderError("stale_authority");
  }
  for (let index = 0; index < requirements.length; index += 1) {
    const requirement = requirements[index]!;
    const authority = authorities[index]!;
    if (authority.namespaceState !== "active") {
      throw new BackgroundAuthorizationDeviceResponderError(
        "namespace_unavailable",
      );
    }
    if (authority.issuingHumanAccess === "removed") {
      throw new BackgroundAuthorizationDeviceResponderError(
        "membership_removed",
      );
    }
    if (
      authority.issuingHumanAccess !== "authorized"
      || authority.grantScopeAccess !== "authorized"
      || authority.namespaceId !== requirement.namespaceId
      || authority.domainId !== requirement.domainId
      || authority.namespaceAccessRevision
        !== requirement.expectedAccessRevision
      || authority.policyRevision !== requirement.expectedPolicyRevision
      || !sameOperations(
        authority.authorizedOperations,
        requirement.operations,
      )
    ) {
      throw new BackgroundAuthorizationDeviceResponderError(
        "stale_authority",
      );
    }
  }
}

function assertExactDomains(
  requirements: readonly BackgroundDomainRequirementV2[],
  authorities:
    readonly AgentBackgroundAuthorizationDomainPublicAuthorityV2[],
): void {
  if (requirements.length !== authorities.length) {
    throw new BackgroundAuthorizationDeviceResponderError("stale_authority");
  }
  for (let index = 0; index < requirements.length; index += 1) {
    const requirement = requirements[index]!;
    const authority = authorities[index]!;
    if (authority.domainState !== "active") {
      throw new BackgroundAuthorizationDeviceResponderError(
        "domain_unavailable",
      );
    }
    if (
      authority.domainId !== requirement.domainId
      || authority.domainEpoch !== requirement.expectedEpoch
      || authority.agentAuthorizationRevision
        !== requirement.expectedAgentAuthorizationRevision
    ) {
      throw new BackgroundAuthorizationDeviceResponderError(
        "stale_authority",
      );
    }
  }
}

export function assertCurrentAgentBackgroundAuthorizationPublicAuthorityV2(
  expected: Readonly<{
    readonly grantScope: readonly HumanId[];
    readonly agentId: AgentId;
    readonly runtimeGeneration: AgentRuntimeGeneration;
    readonly agentAuthorizationRevision: AuthorizationRevision;
    readonly namespaceRequirements:
      readonly BackgroundNamespaceRequirementV2[];
    readonly domainRequirements: readonly BackgroundDomainRequirementV2[];
    readonly issuingHumanId?: HumanId;
    readonly issuingDeviceId?: CryptoDeviceId;
    readonly issuingDeviceAuthorizationRevision?: AuthorizationRevision;
  }>,
  authority: AgentBackgroundAuthorizationDevicePublicAuthorityV2,
): void {
  if (authority.humanState !== "active") {
    throw new BackgroundAuthorizationDeviceResponderError("human_removed");
  }
  if (authority.deviceState !== "active") {
    throw new BackgroundAuthorizationDeviceResponderError("device_revoked");
  }
  if (authority.agentState !== "active") {
    throw new BackgroundAuthorizationDeviceResponderError(
      "agent_unavailable",
    );
  }
  if (
    authority.deviceHumanId !== authority.humanId
    || !expected.grantScope.includes(authority.humanId)
    || authority.agentId !== expected.agentId
    || authority.runtimeGeneration !== expected.runtimeGeneration
    || authority.agentAuthorizationRevision
      !== expected.agentAuthorizationRevision
    || (expected.issuingHumanId !== undefined
      && authority.humanId !== expected.issuingHumanId)
    || (expected.issuingDeviceId !== undefined
      && authority.deviceId !== expected.issuingDeviceId)
    || (expected.issuingDeviceAuthorizationRevision !== undefined
      && authority.deviceAuthorizationRevision
        !== expected.issuingDeviceAuthorizationRevision)
  ) {
    throw new BackgroundAuthorizationDeviceResponderError("stale_authority");
  }
  assertExactNamespaces(
    expected.namespaceRequirements,
    authority.namespaces,
  );
  assertExactDomains(expected.domainRequirements, authority.domains);
}

function copyNamespaceRequirements(
  requirements: readonly BackgroundNamespaceRequirementV2[],
): readonly BackgroundNamespaceRequirementV2[] {
  return Object.freeze(requirements.map((entry) => Object.freeze({
    ...entry,
    operations: Object.freeze([...entry.operations]),
  })));
}

function copyDomainRequirements(
  requirements: readonly BackgroundDomainRequirementV2[],
): readonly BackgroundDomainRequirementV2[] {
  return Object.freeze(requirements.map((entry) => Object.freeze({
    ...entry,
  })));
}

function hex(bytes: Uint8Array): string {
  return Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Browser-safe fulfillment for one complete Agent v2 authority set. The
 * resolver is invoked once and must return every required root from the same
 * current device; missing and extra entries fail closed rather than being
 * combined across devices.
 */
export async function fulfillAgentBackgroundAuthorizationRequestV2(
  input: Readonly<{
    readonly crypto: LatticeCrypto;
    readonly request: unknown;
    readonly resolveCurrentAuthority:
      ResolveCurrentAgentBackgroundAuthorizationDeviceAuthorityV2;
  }>,
): Promise<AgentBackgroundAuthorizationDeviceFulfillmentV2> {
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
  const roots: Uint8Array[] = [];
  let grant: GrantV2 | undefined;
  let grantBytes: Uint8Array | undefined;
  let response: CreatedAgentBackgroundGrantResponseV2 | undefined;
  try {
    const now = input.crypto.clock.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new BackgroundAuthorizationDeviceResponderError(
        "malformed_request",
      );
    }
    assertSupported(descriptor, now);
    contextHash = Uint8Array.from(parsed.descriptorHash);
    let authority: AgentBackgroundAuthorizationDeviceAuthorityV2 | null;
    try {
      authority = await input.resolveCurrentAuthority(Object.freeze({
        purpose: "fulfill-current-agent-background-authorization-v2",
        requestId: descriptor.requestId,
        recipientGeneration: descriptor.recipientGeneration,
        descriptorHash: contextHash,
        workKind: descriptor.workKind,
        workId: descriptor.workId,
        grantScope: Object.freeze([...descriptor.grantScope]),
        agentId: descriptor.subject.agentId,
        runtimeGeneration: descriptor.subject.runtimeGeneration,
        agentAuthorizationRevision:
          descriptor.subject.authorizationRevision,
        namespaceRequirements: copyNamespaceRequirements(
          descriptor.namespaceRequirements,
        ),
        domainRequirements: copyDomainRequirements(
          descriptor.domainRequirements,
        ),
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
    assertCurrentAgentBackgroundAuthorizationPublicAuthorityV2({
      grantScope: descriptor.grantScope,
      agentId: descriptor.subject.agentId,
      runtimeGeneration: descriptor.subject.runtimeGeneration,
      agentAuthorizationRevision: descriptor.subject.authorizationRevision,
      namespaceRequirements: descriptor.namespaceRequirements,
      domainRequirements: descriptor.domainRequirements,
    }, authority);

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
    for (const domain of authority.domains) {
      roots.push(exactBytes(domain.aiRoot, 32, "authority_unavailable"));
    }
    grant = await mintGrant(input.crypto, {
      id: grantId(`background-agent-v2-grant-${hex(parsed.descriptorHash)}`),
      issuingDeviceId: authority.deviceId,
      issuingHumanId: authority.humanId,
      issuingDeviceSigningPrivateKey: issuerPrivateKey,
      recipientAgentId: descriptor.subject.agentId,
      recipientKeyId: descriptor.recipientKeyId,
      recipientEncryptionPublicKey: descriptor.recipientPublicKey,
      scope: descriptor.grantScope,
      operations: descriptor.operations,
      issuedAt: descriptor.issuedAt,
      expiresAt: descriptor.expiresAt,
      coveredDomains: descriptor.domainRequirements.map((entry, index) => ({
        domainId: entry.domainId,
        domainEpoch: entry.expectedEpoch,
        agentAuthorizationRevision:
          entry.expectedAgentAuthorizationRevision,
        aiRoot: roots[index]!,
      })),
      singleUse: true,
    });
    grantBytes = serializeGrantV2(grant);
    response = createAgentBackgroundGrantResponseV2(input.crypto, {
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
        AGENT_BACKGROUND_AUTHORIZATION_DEVICE_FULFILLMENT_FORMAT_VERSION_V2,
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
    roots.forEach((root) => root.fill(0));
    contextHash?.fill(0);
    destroyDescriptor(descriptor);
    parsed.descriptorBytes.fill(0);
    parsed.descriptorHash.fill(0);
  }
}
