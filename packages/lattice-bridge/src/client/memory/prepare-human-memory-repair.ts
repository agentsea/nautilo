import {
  protectedMemoryRepairPlanV1Schema,
  type ProtectedMemoryRepairPlanV1,
  type ProtectedMemoryPreparedRepairRequestV1,
} from "@nautilo/api-client/browser";
import { namespaceId, type LatticeCrypto } from "@nautilo/lattice-crypto";
import { decodeNamespaceObjectEnvelopeV2 } from "@nautilo/lattice-crypto/wire";
import {
  encodeHumanMemoryRepairAttestationV1,
  humanMemoryRepairPayloadDigestV1,
  prepareHumanMemoryRepairAttestationV1,
} from "../../memory/human-memory-repair-attestation.ts";
import { decodeMemoryPayloadV1 } from "../../memory/memory-payload-v1.ts";
import { deriveMemoryCryptoObjectIdV1, fingerprintRequiredMemoryNamespaces } from "../../memory/memory-repository.ts";
import { prepareHumanMemoryCiphertext } from "./prepare-human-memory-ciphertext.ts";

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
function decode(value: string): Uint8Array {
  const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
  if (encode(bytes) !== value) throw new TypeError("Repair bytes are not canonical");
  return bytes;
}

/** Device-only repair construction. Reverse bytes must have been opened by
 * this device's normal authenticated reader. Neither path allocates a Memory,
 * edits its payload, or acquires an embedding/Agent grant. */
export async function prepareHumanMemoryRepairRequest(input: Readonly<{
  crypto: LatticeCrypto;
  plan: ProtectedMemoryRepairPlanV1;
  now: number;
  subjectHumanId: string;
  deviceId: string;
  deviceSigningKeyGeneration: number;
  hostAuthorizationRevision: number;
  signingPublicKey: Uint8Array;
  signingPrivateKey: Uint8Array;
  openedReversePayload?: Uint8Array;
  wrapNamespace: Parameters<typeof prepareHumanMemoryCiphertext>[0]["wrapNamespace"];
}>): Promise<ProtectedMemoryPreparedRepairRequestV1> {
  const plan = protectedMemoryRepairPlanV1Schema.parse(input.plan);
  if (!Number.isSafeInteger(input.now) || input.now < 0 || input.now >= plan.deadlineAt) {
    throw new TypeError("Human Memory repair plan expired");
  }
  const cryptoObjectId = deriveMemoryCryptoObjectIdV1({ memoryId: plan.memoryId, contentRevision: plan.targetContentRevision });
  const fingerprint = fingerprintRequiredMemoryNamespaces(plan.requiredNamespaceIds);
  if (cryptoObjectId !== plan.cryptoObjectId || encode(fingerprint) !== plan.requiredNamespaceFingerprintBase64url) {
    fingerprint.fill(0);
    throw new TypeError("Human Memory repair coordinates were substituted");
  }
  let payloadBytes: Uint8Array | undefined;
  let manifestBytes: Uint8Array | undefined;
  let envelopes: readonly Uint8Array[] = [];
  let signedBytes: Uint8Array | undefined;
  try {
    const payload = plan.direction === "ordinary_to_protected"
      ? plan.repairInput
      : input.openedReversePayload === undefined
      ? null : decodeMemoryPayloadV1(input.openedReversePayload);
    if (payload === null) throw new TypeError("Reverse repair requires device-authenticated plaintext");
    if (plan.direction === "ordinary_to_protected") {
      const sealed = await prepareHumanMemoryCiphertext({ ...input, payload,
        memoryId: plan.memoryId, contentRevision: plan.targetContentRevision,
        createdAt: plan.createdAt, namespaceIds: plan.requiredNamespaceIds });
      payloadBytes = sealed.payloadBytes;
      manifestBytes = sealed.manifestBytes;
      envelopes = sealed.envelopeBytes;
    } else {
      const protectedPayload = plan.repairInput.protectedPayload;
      if (protectedPayload.status !== "encrypted") throw new TypeError("Reverse repair source is not protected");
      payloadBytes = decode(protectedPayload.encryptedPayloadBytesBase64url);
      manifestBytes = decode(protectedPayload.accessManifestBytesBase64url);
      envelopes = protectedPayload.namespaceEnvelopes.map((entry) => decode(entry.envelopeBytesBase64url));
    }
    const namespaces = envelopes.map((bytes, index) => {
      const envelope = decodeNamespaceObjectEnvelopeV2(bytes);
      const namespaceId = plan.requiredNamespaceIds[index];
      if (envelope.context.namespaceId !== namespaceId || envelope.context.objectId !== cryptoObjectId
        || envelope.context.keyClass !== "ai") throw new TypeError("Repair envelope targets another source");
      const native = plan.targetAuthorities[index]?.retainedGenerations.find((entry) =>
        entry.generation === envelope.context.keyGeneration && entry.accessRevision === envelope.context.bindingRevisionAtWrap);
      if (native === undefined) throw new TypeError("Repair lacks the exact native Namespace generation");
      return { namespaceId, namespaceAccessRevision: native.accessRevision,
        namespaceKeyGeneration: native.generation,
        headDigest: decode(native.headDigestBase64url), publicationDigest: decode(native.publicationDigestBase64url),
        publicationSetDigest: decode(native.publicationSetDigestBase64url), audienceFingerprint: decode(native.audienceFingerprintBase64url),
        envelopeHash: input.crypto.hash(bytes) };
    });
    const attestation = prepareHumanMemoryRepairAttestationV1(input.crypto, {
      version: 1, purpose: "human_memory_representation_repair", direction: plan.direction,
      operationId: plan.operationId, policyRevision: plan.policyRevision,
      subjectHumanId: input.subjectHumanId, deviceId: input.deviceId,
      deviceSigningKeyGeneration: input.deviceSigningKeyGeneration,
      hostAuthorizationRevision: input.hostAuthorizationRevision,
      memoryId: plan.memoryId, expectedContentRevision: plan.expectedContentRevision,
      targetContentRevision: plan.targetContentRevision, expectedCryptoAccessRevision: plan.expectedCryptoAccessRevision,
      cryptoObjectId, requiredNamespaceFingerprint: fingerprint, namespaces,
      currentAuthorityEntries: plan.targetAuthorities.map((authority) => {
        const current = authority.retainedGenerations.find((entry) => entry.generation === authority.currentGeneration);
        if (current === undefined) throw new TypeError("Repair current Namespace head is unavailable");
        return { namespaceId: namespaceId(authority.namespaceId), keyGeneration: current.generation,
          namespaceAccessRevision: current.accessRevision, headDigest: decode(current.headDigestBase64url),
          publicationDigest: decode(current.publicationDigestBase64url),
          publicationSetDigest: decode(current.publicationSetDigestBase64url),
          audienceFingerprint: decode(current.audienceFingerprintBase64url) };
      }),
      payloadHash: input.crypto.hash(payloadBytes), accessManifestHash: input.crypto.hash(manifestBytes),
      authoredPayloadDigest: humanMemoryRepairPayloadDigestV1(payload),
      issuedAt: input.now, deadlineAt: plan.deadlineAt,
      signingPublicKey: input.signingPublicKey, signingPrivateKey: input.signingPrivateKey,
    });
    signedBytes = encodeHumanMemoryRepairAttestationV1(attestation);
    const common = { requestVersion: 1 as const, memoryId: plan.memoryId, operationId: plan.operationId,
      signedRepairAttestationBytesBase64url: encode(signedBytes) };
    return plan.direction === "ordinary_to_protected"
      ? { ...common, direction: plan.direction, encryptedPayloadBytesBase64url: encode(payloadBytes),
        accessManifestBytesBase64url: encode(manifestBytes), namespaceEnvelopes: envelopes.map((bytes, index) => ({
          namespaceId: plan.requiredNamespaceIds[index]!, envelopeBytesBase64url: encode(bytes) })) }
      : { ...common, direction: plan.direction, payload };
  } finally {
    fingerprint.fill(0);
    payloadBytes?.fill(0);
    manifestBytes?.fill(0);
    envelopes.forEach((bytes) => bytes.fill(0));
    signedBytes?.fill(0);
  }
}
