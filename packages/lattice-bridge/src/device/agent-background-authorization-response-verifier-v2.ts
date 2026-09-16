import {
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  type AuthorizationRevision,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  verifyCurrentAgentBackgroundGrantResponseV2,
  type AgentBackgroundGrantIssuerContextV2,
  type BackgroundDomainRequirementV2,
  type BackgroundInputObjectBindingV2,
  type BackgroundNamespaceRequirementV2,
  type BackgroundOutputObjectSlotV2,
  type VerifiedAgentBackgroundGrantResponseV2,
} from "@nautilo/lattice-crypto/wire";

import {
  BACKGROUND_AUTHORIZATION_DEVICE_CREDENTIAL_TTL_MS,
  BackgroundAuthorizationDeviceResponderError,
} from "./background-authorization-responder.ts";
import {
  AGENT_BACKGROUND_AUTHORIZATION_DEVICE_FULFILLMENT_FORMAT_VERSION_V2,
  assertCurrentAgentBackgroundAuthorizationPublicAuthorityV2,
  type AgentBackgroundAuthorizationDevicePublicAuthorityV2,
} from "./agent-background-authorization-responder-v2.ts";

export interface ExpectedAgentBackgroundAuthorizationResponseV2 {
  readonly requestId: string;
  readonly recipientGeneration: number;
  readonly descriptorHash: Uint8Array;
  readonly recipientKeyId: string;
  readonly recipientPublicKey: Uint8Array;
}

export type ResolveCurrentAgentBackgroundAuthorizationDevicePublicAuthorityV2 =
  (
    context: AgentBackgroundGrantIssuerContextV2,
  ) =>
    | AgentBackgroundAuthorizationDevicePublicAuthorityV2
    | null
    | Promise<AgentBackgroundAuthorizationDevicePublicAuthorityV2 | null>;

export interface VerifyCurrentAgentBackgroundAuthorizationDeviceResponseInputV2 {
  readonly crypto: LatticeCrypto;
  readonly expected: ExpectedAgentBackgroundAuthorizationResponseV2;
  readonly responseBytes: Uint8Array;
  readonly now: number;
  readonly resolveCurrentAuthority:
    ResolveCurrentAgentBackgroundAuthorizationDevicePublicAuthorityV2;
}

export interface VerifiedAgentBackgroundAuthorizationDeviceResponseV2 {
  readonly formatVersion:
    typeof AGENT_BACKGROUND_AUTHORIZATION_DEVICE_FULFILLMENT_FORMAT_VERSION_V2;
  readonly kind: "agent";
  readonly requestId: string;
  readonly recipientGeneration: number;
  readonly recipientKeyId: string;
  readonly recipientPublicKey: Uint8Array;
  readonly descriptorHash: Uint8Array;
  readonly workId: string;
  readonly workKind: string;
  readonly purpose: string;
  readonly responseHash: Uint8Array;
  readonly responseBytes: Uint8Array;
  readonly credentialId: string;
  readonly credentialHash: Uint8Array;
  readonly issuingHumanId: string;
  readonly issuingDeviceId: string;
  readonly issuingDeviceAuthorizationRevision: AuthorizationRevision;
  readonly issuerSigningPublicKeyHash: Uint8Array;
  readonly anchorNamespaceId: string;
  readonly anchorDomainId: string;
  readonly grantScope: readonly string[];
  readonly inputBindings: readonly BackgroundInputObjectBindingV2[];
  readonly outputSlots: readonly BackgroundOutputObjectSlotV2[];
  readonly namespaceRequirements:
    readonly BackgroundNamespaceRequirementV2[];
  readonly domainRequirements: readonly BackgroundDomainRequirementV2[];
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
  readonly subject: Readonly<{
    readonly kind: "agent";
    readonly agentId: string;
    readonly runtimeGeneration: number;
    readonly authorizationRevision: number;
  }>;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function assertExactDurableRequest(
  expected: ExpectedAgentBackgroundAuthorizationResponseV2,
  actual: Readonly<{
    requestId: string;
    recipientGeneration: number;
    descriptorHash: Uint8Array;
    recipientKeyId: string;
    recipientPublicKey: Uint8Array;
  }>,
): void {
  if (
    actual.requestId !== expected.requestId
    || actual.recipientGeneration !== expected.recipientGeneration
    || actual.recipientKeyId !== expected.recipientKeyId
    || !equalBytes(actual.descriptorHash, expected.descriptorHash)
    || !equalBytes(actual.recipientPublicKey, expected.recipientPublicKey)
  ) {
    throw new TypeError(
      "Agent v2 background authorization response does not match durable request",
    );
  }
}

function assertProductCredentialLifetime(
  issuedAt: number,
  expiresAt: number,
): void {
  if (
    expiresAt <= issuedAt
    || expiresAt - issuedAt
      > BACKGROUND_AUTHORIZATION_DEVICE_CREDENTIAL_TTL_MS
  ) {
    throw new TypeError(
      "Agent v2 background authorization response exceeds product lifetime",
    );
  }
}

function destroyVerified(
  verified: VerifiedAgentBackgroundGrantResponseV2,
): void {
  verified.response.workDescriptorBytes.fill(0);
  verified.response.workDescriptorHash.fill(0);
  verified.response.grantBytes.fill(0);
  verified.response.grantHash.fill(0);
  verified.response.issuerSigningPublicKeyHash.fill(0);
  verified.response.signature.fill(0);
  verified.responseBytes.fill(0);
  verified.responseHash.fill(0);
  verified.workDescriptor.recipientPublicKey.fill(0);
  if (verified.workDescriptor.source.kind === "synthetic_payload") {
    verified.workDescriptor.source.fingerprint.fill(0);
  }
  verified.grant.encryptedSecret.fill(0);
  verified.grant.signature.fill(0);
  verified.grantBytes.fill(0);
}

function copyInputBindings(
  bindings: readonly BackgroundInputObjectBindingV2[],
): readonly BackgroundInputObjectBindingV2[] {
  return Object.freeze(bindings.map((entry) => Object.freeze({ ...entry })));
}

function copyOutputSlots(
  slots: readonly BackgroundOutputObjectSlotV2[],
): readonly BackgroundOutputObjectSlotV2[] {
  return Object.freeze(slots.map((entry) => Object.freeze({
    ...entry,
    namespaceIds: Object.freeze([...entry.namespaceIds]),
  })));
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

/**
 * Verifies one Agent v2 response against both its signed wire and the complete
 * current public authority set. Roots and private keys are neither requested
 * nor returned by this server-side boundary.
 */
export async function verifyCurrentAgentBackgroundAuthorizationDeviceResponseV2(
  input: VerifyCurrentAgentBackgroundAuthorizationDeviceResponseInputV2,
): Promise<VerifiedAgentBackgroundAuthorizationDeviceResponseV2> {
  if (typeof input.resolveCurrentAuthority !== "function") {
    throw new TypeError(
      "Agent v2 background current authority resolver is required",
    );
  }
  let resolvedPublicKey: Uint8Array | undefined;
  let verified: VerifiedAgentBackgroundGrantResponseV2 | undefined;
  try {
    verified = await verifyCurrentAgentBackgroundGrantResponseV2(
      input.crypto,
      {
        responseBytes: input.responseBytes,
        now: input.now,
        resolveCurrentIssuingDevicePublicKey: async (context) => {
          let authority: AgentBackgroundAuthorizationDevicePublicAuthorityV2
            | null;
          try {
            authority = await input.resolveCurrentAuthority(context);
          } catch (cause) {
            throw new TypeError(
              "Agent v2 background response current authority is unavailable",
              { cause },
            );
          }
          if (authority === null) {
            throw new TypeError(
              "Agent v2 background response current authority is unavailable",
            );
          }
          if (
            "deviceSigningPrivateKey" in authority
            || authority.domains.some((domain) => "aiRoot" in domain)
          ) {
            throw new TypeError(
              "Agent v2 background response current authority contains secret material",
            );
          }
          try {
            assertCurrentAgentBackgroundAuthorizationPublicAuthorityV2({
              grantScope: context.grantScope,
              agentId: agentId(context.agentId),
              runtimeGeneration: agentRuntimeGeneration(
                context.runtimeGeneration,
              ),
              agentAuthorizationRevision: authorizationRevision(
                context.agentAuthorizationRevision,
              ),
              namespaceRequirements: context.namespaceRequirements,
              domainRequirements: context.domainRequirements,
              issuingHumanId: context.issuingHumanId,
              issuingDeviceId: cryptoDeviceId(context.issuingDeviceId),
              issuingDeviceAuthorizationRevision:
                context.issuingDeviceAuthorizationRevision,
            }, authority);
          } catch (cause) {
            if (
              cause instanceof BackgroundAuthorizationDeviceResponderError
            ) {
              throw new TypeError(
                "Agent v2 background response current authority is stale",
                { cause },
              );
            }
            throw cause;
          }
          resolvedPublicKey?.fill(0);
          resolvedPublicKey = Uint8Array.from(
            authority.deviceSigningPublicKey,
          );
          return resolvedPublicKey;
        },
      },
    );
    const descriptor = verified.workDescriptor;
    assertExactDurableRequest(input.expected, {
      requestId: descriptor.requestId,
      recipientGeneration: descriptor.recipientGeneration,
      descriptorHash: verified.response.workDescriptorHash,
      recipientKeyId: descriptor.recipientKeyId,
      recipientPublicKey: descriptor.recipientPublicKey,
    });
    assertProductCredentialLifetime(
      verified.response.issuedAt,
      verified.response.expiresAt,
    );
    return Object.freeze({
      formatVersion:
        AGENT_BACKGROUND_AUTHORIZATION_DEVICE_FULFILLMENT_FORMAT_VERSION_V2,
      kind: "agent",
      requestId: descriptor.requestId,
      recipientGeneration: descriptor.recipientGeneration,
      recipientKeyId: descriptor.recipientKeyId,
      recipientPublicKey: Uint8Array.from(descriptor.recipientPublicKey),
      descriptorHash: Uint8Array.from(
        verified.response.workDescriptorHash,
      ),
      workId: descriptor.workId,
      workKind: descriptor.workKind,
      purpose: descriptor.purpose,
      responseHash: Uint8Array.from(verified.responseHash),
      responseBytes: Uint8Array.from(verified.responseBytes),
      credentialId: verified.grant.id,
      credentialHash: Uint8Array.from(verified.response.grantHash),
      issuingHumanId: verified.response.issuingHumanId,
      issuingDeviceId: verified.grant.issuingDeviceId,
      issuingDeviceAuthorizationRevision:
        verified.response.issuingDeviceAuthorizationRevision,
      issuerSigningPublicKeyHash: Uint8Array.from(
        verified.response.issuerSigningPublicKeyHash,
      ),
      anchorNamespaceId: descriptor.anchorNamespaceId,
      anchorDomainId: descriptor.anchorDomainId,
      grantScope: Object.freeze([...descriptor.grantScope]),
      inputBindings: copyInputBindings(descriptor.inputBindings),
      outputSlots: copyOutputSlots(descriptor.outputSlots),
      namespaceRequirements: copyNamespaceRequirements(
        descriptor.namespaceRequirements,
      ),
      domainRequirements: copyDomainRequirements(
        descriptor.domainRequirements,
      ),
      issuedAt: verified.response.issuedAt,
      notBefore: verified.response.notBefore,
      expiresAt: verified.response.expiresAt,
      subject: Object.freeze({
        kind: "agent",
        agentId: descriptor.subject.agentId,
        runtimeGeneration: descriptor.subject.runtimeGeneration,
        authorizationRevision: descriptor.subject.authorizationRevision,
      }),
    });
  } finally {
    resolvedPublicKey?.fill(0);
    if (verified !== undefined) destroyVerified(verified);
  }
}
