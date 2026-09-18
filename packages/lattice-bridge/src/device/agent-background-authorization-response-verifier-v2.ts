import type { AuthorizationRevision } from "@nautilo/lattice-crypto";
import type {
  BackgroundDomainRequirementV2,
  BackgroundInputObjectBindingV2,
  BackgroundNamespaceRequirementV2,
  BackgroundOutputObjectSlotV2,
} from "@nautilo/lattice-crypto/wire";

/**
 * Historical verified-response shape retained for persisted authorization
 * records. No verifier or Agent-addressed grant issuer is exposed here.
 */
export interface VerifiedAgentBackgroundAuthorizationDeviceResponseV2 {
  readonly formatVersion: 2;
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
