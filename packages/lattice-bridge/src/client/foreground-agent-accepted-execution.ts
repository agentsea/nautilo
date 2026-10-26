import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  decodeLiveShadowMessagePlanV4,
  decodeObjectAccessManifestV5,
  encodeLiveShadowMessagePlanV4,
} from "@nautilo/lattice-crypto/wire";

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

export type ForegroundAgentSignerPrincipalV1 = Readonly<{
  agentId: string;
  runtimeGeneration: number;
  signerKeyId: string;
}>;

export type ForegroundAgentAcceptedExecutionEvidenceTransportV1 = Readonly<{
  kind: "foreground_agent_accepted_execution";
  planBytesBase64url: string;
  planDigestBase64url: string;
}>;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function fromBase64url(label: string, value: string): Uint8Array {
  if (!BASE64URL.test(value) || value.length % 4 === 1) {
    throw new TypeError(`${label} is not canonical base64url`);
  }
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  let roundTrip = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    roundTrip += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  if (btoa(roundTrip).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "") !== value) {
    bytes.fill(0);
    throw new TypeError(`${label} is not canonical base64url`);
  }
  return bytes;
}

function wipePlan(
  plan: ReturnType<typeof decodeLiveShadowMessagePlanV4>,
): void {
  plan.agentSignerPublicKey.fill(0);
  plan.namespaceHeadDigest.fill(0);
  plan.namespacePublicationDigest.fill(0);
  plan.namespacePublicationSetDigest.fill(0);
  plan.namespaceAudienceFingerprint.fill(0);
  plan.grantDomainParticipantDigest.fill(0);
  plan.grantDomainHeadDigest.fill(0);
  plan.grantDomainPublicationDigest.fill(0);
  plan.namespaceBundleDigest.fill(0);
  if (plan.authorization.disposition === "authorization_required") {
    plan.authorization.authorizationPlanBytes.fill(0);
    plan.authorization.authorizationPlanDigest.fill(0);
    plan.authorization.recipientPublicKey.fill(0);
  } else {
    plan.authorization.authorizationDigest.fill(0);
  }
}

function wipeManifest(
  manifest: ReturnType<typeof decodeObjectAccessManifestV5>,
): void {
  manifest.payloadHash.fill(0);
  manifest.previousManifestHash?.fill(0);
  manifest.envelopeHashes.forEach(hash => hash.fill(0));
  manifest.signerAuthorizationHash?.fill(0);
  manifest.signature.fill(0);
}

export function foregroundAgentSignerPrincipalKeyV1(
  input: ForegroundAgentSignerPrincipalV1,
): string {
  return `${input.agentId}\0${input.runtimeGeneration}\0${input.signerKeyId}`;
}

/**
 * Authenticates server-retained accepted foreground execution plans as public
 * signer evidence for an exact manifest chain. This proves only the historical
 * Agent signer; Namespace access remains independently device-custodied.
 */
export function exactForegroundAgentSignerKeysV1(input: Readonly<{
  crypto: LatticeCrypto;
  evidence: readonly unknown[];
  manifestBytes: readonly Uint8Array[];
  expectedAgentId?: string;
  expectedDefinitionAuthorHumanId?: string;
}>): Map<string, Uint8Array> {
  const keys = new Map<string, Uint8Array>();
  try {
    for (const candidate of input.evidence) {
      if (typeof candidate !== "object" || candidate === null
        || Array.isArray(candidate)
        || (candidate as { kind?: unknown }).kind
          !== "foreground_agent_accepted_execution") continue;
      const fields = Object.keys(candidate).sort();
      if (fields.length !== 3
        || fields[0] !== "kind"
        || fields[1] !== "planBytesBase64url"
        || fields[2] !== "planDigestBase64url") {
        throw new TypeError("Accepted foreground Agent evidence fields are inexact");
      }
      const evidence = candidate as
        ForegroundAgentAcceptedExecutionEvidenceTransportV1;
      if (typeof evidence.planBytesBase64url !== "string"
        || typeof evidence.planDigestBase64url !== "string") {
        throw new TypeError("Accepted foreground Agent evidence is malformed");
      }
      const planBytes = fromBase64url(
        "Accepted foreground Agent plan",
        evidence.planBytesBase64url,
      );
      const planDigest = fromBase64url(
        "Accepted foreground Agent plan digest",
        evidence.planDigestBase64url,
      );
      let actualDigest: Uint8Array | undefined;
      let canonical: Uint8Array | undefined;
      let plan: ReturnType<typeof decodeLiveShadowMessagePlanV4> | undefined;
      try {
        plan = decodeLiveShadowMessagePlanV4(planBytes);
        actualDigest = input.crypto.hash(planBytes);
        canonical = encodeLiveShadowMessagePlanV4(plan);
        const expectedWriterMatches =
          input.expectedDefinitionAuthorHumanId !== undefined
            ? plan.recipientAgentId === input.expectedAgentId
            : input.expectedAgentId === undefined
              || plan.recipientAgentId === input.expectedAgentId;
        if (planDigest.length !== 32
          || !sameBytes(actualDigest, planDigest)
          || !sameBytes(canonical, planBytes)
          || !expectedWriterMatches) {
          throw new TypeError("Accepted foreground Agent plan is invalid");
        }
        const key = foregroundAgentSignerPrincipalKeyV1({
          agentId: plan.recipientAgentId,
          runtimeGeneration: plan.agentRuntimeGeneration,
          signerKeyId: plan.agentSignerKeyId,
        });
        if (keys.has(key)) {
          throw new TypeError("Accepted foreground Agent signer evidence collided");
        }
        keys.set(key, Uint8Array.from(plan.agentSignerPublicKey));
      } finally {
        planBytes.fill(0);
        planDigest.fill(0);
        actualDigest?.fill(0);
        canonical?.fill(0);
        if (plan !== undefined) wipePlan(plan);
      }
    }

    const required = new Set<string>();
    for (const bytes of input.manifestBytes) {
      const manifest = decodeObjectAccessManifestV5(bytes);
      try {
        if (manifest.signer.kind !== "agent_runtime") continue;
        if (input.expectedDefinitionAuthorHumanId === undefined
          && input.expectedAgentId !== undefined
          && manifest.signer.agentId !== input.expectedAgentId) {
          throw new TypeError("Accepted foreground Agent belongs to another Agent");
        }
        required.add(foregroundAgentSignerPrincipalKeyV1({
          agentId: manifest.signer.agentId,
          runtimeGeneration: manifest.signer.runtimeGeneration,
          signerKeyId: manifest.signer.signerKeyId,
        }));
      } finally {
        wipeManifest(manifest);
      }
    }
    if ([...keys.keys()].some(key => !required.has(key))) {
      throw new TypeError("Accepted foreground Agent evidence is extraneous");
    }
    return keys;
  } catch (error) {
    keys.forEach(key => key.fill(0));
    throw error;
  }
}
