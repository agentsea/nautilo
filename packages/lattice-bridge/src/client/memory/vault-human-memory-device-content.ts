import {
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  createCommonHumanObjectAccessManifest,
  decryptObjectThroughNamespace,
  humanId,
  namespaceId,
  objectId,
  openObjectDekForNamespace,
  prepareHumanMemoryContentEmbeddingRequest,
  prepareHumanMemoryExactAccessRequest,
  unixTimestamp,
  wrapObjectDekForNamespace,
  verifyCommonObjectAccessManifestChain,
  type LatticeCrypto,
  type TrustedMinimumObjectAccessHead,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV5,
  decodeLiveShadowMessagePlanV4,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
  encodeObjectAccessManifestV5,
  encodeLiveShadowMessagePlanV4,
} from "@nautilo/lattice-crypto/wire";

import {
  type OpenedClientDeviceProfileV2,
} from "../../client-vault/profile-v2.ts";
import {
  authenticateClientDeviceProfileV4,
  destroyOpenedClientDeviceProfileV4,
  withClientObjectAccessSignerResolversV4,
  type ClientObjectAccessSignerResolversV4,
  type OpenedClientDeviceProfileV4,
} from "../../client-vault/profile-v4.ts";
import type {
  ClientProfileCoordinates,
  ClientProfileVault,
} from "../../client-vault/types.ts";
import { ingestObjectAccessSignerEvidenceV4 } from
  "../../client-vault/ingest-object-access-signer-evidence-v4.ts";
import type {
  NamespaceAuthorityClient,
  NamespaceGenerationAuthority,
  OpenedNamespaceGeneration,
} from
  "../message/namespace-authority-client.ts";
import {
  deriveMemoryCryptoObjectIdV1,
  MEMORY_OBJECT_TYPE,
} from "../../memory/memory-repository.ts";
import { prepareHumanMemoryCiphertext } from "./prepare-human-memory-ciphertext.ts";
import { prepareHumanMemoryRepairRequest } from "./prepare-human-memory-repair.ts";
import { protectedMemoryOrdinaryFallbackCreatePlanV1Schema,
  protectedMemoryRepairPlanV1Schema } from "@nautilo/api-client/browser";
import { sha256 } from "@noble/hashes/sha2.js";
import { AuthorizedHumanMemoryUnavailableError } from "./authorized-human-memory-client.ts";
import { prepareHumanMemoryOrdinaryFallbackRequestV1 } from
  "../../memory/human-memory-ordinary-fallback-request.ts";
import type {
  AuthorizedHumanMemoryDeviceContentPort,
  AuthorizedHumanMemoryWriteIntentV1,
} from "./authorized-human-memory-client.ts";
import type {
  DeviceAdmissionStatus,
  ProtectedMemoryPreparedAccessRequestV1,
  ProtectedMemoryAccessPlanResponseV1,
} from "@nautilo/api-client/browser";

type ProtectedMemoryDtoV1 = Parameters<
  AuthorizedHumanMemoryDeviceContentPort["openExact"]
>[0];
type ProtectedMemoryCreatePlanSlotResponseV1 = Parameters<
  AuthorizedHumanMemoryDeviceContentPort["prepareCreate"]
>[0]["plan"];
type ProtectedMemoryPreparedCreateRequestV1 = Awaited<ReturnType<
  AuthorizedHumanMemoryDeviceContentPort["prepareCreate"]
>>;
type ProtectedMemoryPreparedUpdateRequestV1 = Awaited<ReturnType<
  AuthorizedHumanMemoryDeviceContentPort["prepareUpdate"]
>>;
type OrdinaryFallbackCreateInput = Parameters<NonNullable<
  AuthorizedHumanMemoryDeviceContentPort["prepareOrdinaryFallbackCreate"]
>>[0];
type OrdinaryFallbackUpdateInput = Parameters<NonNullable<
  AuthorizedHumanMemoryDeviceContentPort["prepareOrdinaryFallbackUpdate"]
>>[0];
type ProtectedMemoryNamespaceAuthorityV1 =
  ProtectedMemoryDtoV1["projection"]["readAuthorities"][number];

const SIGNED_REQUEST_TTL_MS = 30_000;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

export interface VaultHumanMemoryDeviceContentInput {
  readonly crypto: LatticeCrypto;
  readonly vault: ClientProfileVault;
  readonly coordinates: ClientProfileCoordinates;
  readonly subjectHumanId: string;
  readonly now: () => number;
  readonly createOperationId: () => string;
  readonly createProfileStageId: () => string;
  readonly accessAnchors: HumanMemoryObjectAccessAnchorPort;
  readonly namespaceAuthority: NamespaceAuthorityClient;
  readonly resolveDeviceAdmissionStatus: () => Promise<DeviceAdmissionStatus>;
}

type HumanSignerEvidence = Extract<
  ProtectedMemoryDtoV1["protectedPayload"],
  { status: "encrypted" }
>["accessSignerEvidence"][number] & { kind: "human_device" };
type EvidenceIssuer = Extract<
  ProtectedMemoryDtoV1["protectedPayload"],
  { status: "encrypted" }
>["accessSignerEvidence"][number] & {
  kind: "evidence_issuer_human_device";
};
type ForegroundAgentEvidence = Extract<
  ProtectedMemoryDtoV1["protectedPayload"],
  { status: "encrypted" }
>["accessSignerEvidence"][number] & {
  kind: "foreground_agent_accepted_execution";
};

function foregroundSignerKey(input: Readonly<{
  agentId: string;
  runtimeGeneration: number;
  signerKeyId: string;
}>): string {
  return `${input.agentId}\0${input.runtimeGeneration}\0${input.signerKeyId}`;
}

function wipeForegroundPlan(
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

function wipeDecodedManifest(
  manifest: ReturnType<typeof decodeObjectAccessManifestV5>,
): void {
  manifest.payloadHash.fill(0);
  manifest.previousManifestHash?.fill(0);
  manifest.envelopeHashes.forEach((hash) => hash.fill(0));
  manifest.signerAuthorizationHash?.fill(0);
  manifest.signature.fill(0);
}

function exactForegroundAgentSignerKeys(
  crypto: LatticeCrypto,
  dto: ProtectedMemoryDtoV1,
  chain: readonly Uint8Array[],
): Map<string, Uint8Array> {
  const keys = new Map<string, Uint8Array>();
  if (dto.protectedPayload.status !== "encrypted") return keys;
  try {
    for (const entry of dto.protectedPayload.accessSignerEvidence) {
      if (entry.kind !== "foreground_agent_accepted_execution") continue;
      const planBytes = fromBase64url(
        "Protected Human Memory accepted Agent plan",
        entry.planBytesBase64url,
      );
      const planDigest = fromBase64url(
        "Protected Human Memory accepted Agent plan digest",
        entry.planDigestBase64url,
      );
      let plan: ReturnType<typeof decodeLiveShadowMessagePlanV4> | undefined;
      try {
        plan = decodeLiveShadowMessagePlanV4(planBytes);
        if (
          planDigest.length !== 32
          || !equalBytes(crypto.hash(planBytes), planDigest)
          || !equalBytes(encodeLiveShadowMessagePlanV4(plan), planBytes)
        ) throw new TypeError("Protected Human Memory accepted Agent plan is invalid");
        const key = foregroundSignerKey({
          agentId: plan.recipientAgentId,
          runtimeGeneration: plan.agentRuntimeGeneration,
          signerKeyId: plan.agentSignerKeyId,
        });
        if (keys.has(key)) throw new TypeError(
          "Protected Human Memory accepted Agent signer evidence collided",
        );
        keys.set(key, plan.agentSignerPublicKey.slice());
      } finally {
        planBytes.fill(0);
        planDigest.fill(0);
        if (plan !== undefined) wipeForegroundPlan(plan);
      }
    }
    const required = new Set<string>();
    for (const bytes of chain) {
      const manifest = decodeObjectAccessManifestV5(bytes);
      try {
        if (manifest.signer.kind === "agent_runtime") required.add(
          foregroundSignerKey({
            agentId: manifest.signer.agentId,
            runtimeGeneration: manifest.signer.runtimeGeneration,
            signerKeyId: manifest.signer.signerKeyId,
          }),
        );
      } finally {
        wipeDecodedManifest(manifest);
      }
    }
    if ([...keys.keys()].some((key) => !required.has(key))) {
      throw new TypeError("Protected Human Memory accepted Agent evidence is extraneous");
    }
    return keys;
  } catch (error) {
    keys.forEach((key) => key.fill(0));
    throw error;
  }
}

function humanSignerEvidenceKey(input: Readonly<{
  subjectHumanId: string;
  committerDeviceId: string;
  hostAuthorizationRevision: number;
}>): string {
  return `${input.subjectHumanId}\0${input.committerDeviceId}\0${input.hostAuthorizationRevision}`;
}

function exactHumanSignerKeys(
  dto: ProtectedMemoryDtoV1,
  chain: readonly Uint8Array[],
): Map<string, Uint8Array> {
  if (dto.protectedPayload.status !== "encrypted") {
    throw new Error("Protected Human Memory ciphertext is unavailable");
  }
  const evidence = dto.protectedPayload.accessSignerEvidence.filter(
    (entry): entry is HumanSignerEvidence => entry.kind === "human_device",
  );
  const keys = new Map<string, Uint8Array>();
  try {
    for (const entry of evidence) {
      const key = fromBase64url(
        "Protected Human Memory Human signer key",
        entry.signingPublicKeyBase64url,
      );
      if (key.length !== 32) {
        key.fill(0);
        throw new TypeError("Protected Human Memory Human signer key is invalid");
      }
      const identity = humanSignerEvidenceKey(entry);
      if (keys.has(identity)) {
        key.fill(0);
        throw new TypeError("Protected Human Memory signer evidence collided");
      }
      keys.set(identity, key);
    }
    const required = new Set<string>();
    for (const bytes of chain) {
      const manifest = decodeObjectAccessManifestV5(bytes);
      try {
      if (manifest.signer.kind === "human_device") {
        required.add(humanSignerEvidenceKey({
          subjectHumanId: manifest.signer.subjectHumanId,
          committerDeviceId: manifest.signer.committerDeviceId,
          hostAuthorizationRevision: manifest.hostAuthorizationRevision,
        }));
      }
      } finally {
        wipeDecodedManifest(manifest);
      }
    }
    if (
      required.size !== keys.size
      || [...required].some((key) => !keys.has(key))
    ) throw new Error("Protected Human Memory signer evidence is unavailable");
    return keys;
  } catch (error) {
    keys.forEach((key) => key.fill(0));
    throw error;
  }
}

export interface HumanMemoryObjectAccessAnchorPort {
  load(objectId: string): Promise<TrustedMinimumObjectAccessHead | null>;
  advance(input: Readonly<{
    expected: TrustedMinimumObjectAccessHead | null;
    next: TrustedMinimumObjectAccessHead;
  }>): Promise<boolean>;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function exactFields(
  label: string,
  value: object,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const fields = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((field) => !fields.includes(field))
    || fields.some((field) => !allowed.has(field))
  ) throw new TypeError(`${label} fields are inexact`);
}

function exactCreatePlan(
  plan: ProtectedMemoryCreatePlanSlotResponseV1,
): ProtectedMemoryCreatePlanSlotResponseV1 {
  exactFields("Protected Human Memory create plan", plan, [
    "deadlineAt",
    "dtoVersion",
    "expectedContentRevision",
    "memoryId",
    "nextContentRevision",
    "operationId",
    "productAuthority",
    "requiredNamespaceIds",
    "targetAuthorities",
  ], ["issuedAt", "ordinaryFallbackAuthorization"]);
  if (
    plan.dtoVersion !== 1
    || plan.expectedContentRevision !== 0
    || plan.nextContentRevision !== 1
    || plan.requiredNamespaceIds.length < 1
    || new Set(plan.requiredNamespaceIds).size !== plan.requiredNamespaceIds.length
    || [...plan.requiredNamespaceIds].sort().some((value, index) =>
      value !== plan.requiredNamespaceIds[index]
    )
    || !Number.isSafeInteger(plan.deadlineAt)
  ) throw new TypeError("Protected Human Memory create plan is invalid");
  if (plan.ordinaryFallbackAuthorization !== undefined) {
    exactFields("Protected Human Memory fallback authorization",
      plan.ordinaryFallbackAuthorization, ["policyRevision"]);
    if (!Number.isSafeInteger(plan.ordinaryFallbackAuthorization.policyRevision)
      || plan.ordinaryFallbackAuthorization.policyRevision < 1
      || !Number.isSafeInteger(plan.issuedAt)
      || plan.issuedAt! < 0) {
      throw new TypeError("Protected Human Memory fallback authorization is invalid");
    }
  }
  if (plan.productAuthority.mode === "namespace") {
    exactFields("Protected Human Memory Namespace authority", plan.productAuthority, [
      "mode",
    ]);
  } else {
    exactFields("Protected Human Memory scope authority", plan.productAuthority, [
      "mode",
      "originWritableNamespaceId",
      "scopeId",
    ]);
    if (
      plan.productAuthority.originWritableNamespaceId
        !== plan.requiredNamespaceIds[0]
    ) throw new TypeError("Protected Human Memory scope origin disagrees");
  }
  return plan;
}

function fromBase64url(label: string, value: string): Uint8Array {
  if (
    typeof value !== "string"
    || value.length < 1
    || !BASE64URL.test(value)
    || value.length % 4 === 1
  ) throw new TypeError(`${label} is not canonical base64url`);
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4);
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function decodedAuthority(
  authority: ProtectedMemoryNamespaceAuthorityV1,
): NamespaceGenerationAuthority {
  return Object.freeze({
    namespaceId: authority.namespaceId,
    retainedGenerations: Object.freeze(authority.retainedGenerations.map(
      (entry) => Object.freeze({
        generation: entry.generation,
        accessRevision: entry.accessRevision,
        headDigest: fromBase64url("Namespace authority head", entry.headDigestBase64url),
        publicationDigest: fromBase64url(
          "Namespace authority publication", entry.publicationDigestBase64url,
        ),
        publicationSetDigest: fromBase64url(
          "Namespace authority publication set", entry.publicationSetDigestBase64url,
        ),
        audienceFingerprint: fromBase64url(
          "Namespace authority audience", entry.audienceFingerprintBase64url,
        ),
      })
    )),
  });
}

function wipeAuthority(authority: NamespaceGenerationAuthority): void {
  for (const entry of authority.retainedGenerations) {
    entry.headDigest.fill(0);
    entry.publicationDigest.fill(0);
    entry.publicationSetDigest.fill(0);
    entry.audienceFingerprint.fill(0);
  }
}

class NamespaceAuthorityUnavailableError extends Error {
  constructor(readonly authorityReason: string, message =
    "Protected Human Memory Namespace authority is unavailable") {
    super(message);
  }
}

async function withNamespaceAuthority<Value>(input: Readonly<{
  dependencies: VaultHumanMemoryDeviceContentInput;
  authority: ProtectedMemoryNamespaceAuthorityV1;
  generation?: number;
  operation: (entries: readonly OpenedNamespaceGeneration[]) => Promise<Value> | Value;
}>): Promise<Value> {
  if (input.dependencies.namespaceAuthority.withOpenedGenerations === undefined) {
    throw new Error("Protected Human Memory authority is unavailable");
  }
  const admission = await input.dependencies.resolveDeviceAdmissionStatus();
  if (
    admission.status !== "admitted"
    || admission.deviceId !== input.dependencies.coordinates.deviceId
  ) throw new NamespaceAuthorityUnavailableError("device_admission_unavailable",
    "Protected Human Memory device admission is unavailable");
  const retainedGenerations = input.generation === undefined ? input.authority.retainedGenerations
    : input.authority.retainedGenerations.filter((entry) => entry.generation === input.generation);
  if (retainedGenerations.length === 0) {
    throw new AuthorizedHumanMemoryUnavailableError("integrity_failure");
  }
  const authority = decodedAuthority({ ...input.authority, retainedGenerations });
  try {
    const opened = await input.dependencies.namespaceAuthority.withOpenedGenerations({
      sourceRoomId: input.authority.sourceRoomId,
      subjectHumanId: input.dependencies.subjectHumanId,
      deviceSigningKeyGeneration: admission.deviceGeneration,
      keyClass: "ai",
      authority: [authority],
    }, input.operation);
    if (opened.status !== "opened") {
      throw new NamespaceAuthorityUnavailableError(opened.reason);
    }
    return opened.value;
  } finally {
    wipeAuthority(authority);
  }
}

function toBase64url(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function parseExactEncryptedAccess(dto: ProtectedMemoryDtoV1): Readonly<{
  payloadBytes: Uint8Array;
  manifestBytes: Uint8Array;
  proofBytes: readonly Uint8Array[];
  envelopes: readonly Readonly<{ namespaceId: string; bytes: Uint8Array }>[];
}> {
  exactFields("Protected Human Memory DTO", dto, [
    "dtoVersion",
    "projection",
    "protectedPayload",
  ], ["ordinaryFallback", "shadowComparison", "readObservationAdmission"]);
  exactFields("Protected Human Memory projection", dto.projection, [
    "contentRevision",
    "createdAt",
    "cryptoAccessRevision",
    "importance",
    "memoryId",
    "namespaceIds",
    "readAuthorities",
    "requiredNamespaceIds",
    "tier",
    "updatedAt",
  ], ["accessList", "demotedAt", "demotedFrom", "mutationAuthorities", "scopeOrigin", "representationRepair"]);
  if (dto.dtoVersion !== 1) {
    throw new TypeError("Protected Human Memory DTO version is invalid");
  }
  const parsed = dto;
  if (
    parsed.protectedPayload.status !== "encrypted"
    || parsed.protectedPayload.namespaceEnvelopes.length
      !== parsed.projection.requiredNamespaceIds.length
  ) throw new Error("Protected Human Memory does not have an exact audience");
  const requiredNamespaceIds = parsed.projection.requiredNamespaceIds;
  const envelopeNamespaceIds = parsed.protectedPayload.namespaceEnvelopes.map(
    ({ namespaceId: exactNamespaceId }) => exactNamespaceId,
  );
  if (
    new Set(requiredNamespaceIds).size !== requiredNamespaceIds.length
    || [...requiredNamespaceIds].sort().some((value, index) =>
      value !== requiredNamespaceIds[index]
    )
    || envelopeNamespaceIds.some((value, index) =>
      value !== requiredNamespaceIds[index]
    )
  ) throw new Error("Protected Human Memory exact audience is noncanonical");
  exactFields("Protected Human Memory encrypted payload", parsed.protectedPayload, [
    "accessManifestBytesBase64url",
    "accessSignerEvidence",
    "cryptoObjectId",
    "encryptedPayloadBytesBase64url",
    "namespaceEnvelopes",
    "payloadVersion",
    "status",
  ], ["accessManifestProofBytesBase64url"]);
  for (const envelope of parsed.protectedPayload.namespaceEnvelopes) {
    exactFields("Protected Human Memory Namespace envelope", envelope,
      ["envelopeBytesBase64url", "namespaceId"]);
  }
  return Object.freeze({
    payloadBytes: fromBase64url(
      "Protected Human Memory payload",
      parsed.protectedPayload.encryptedPayloadBytesBase64url,
    ),
    manifestBytes: fromBase64url(
      "Protected Human Memory access manifest",
      parsed.protectedPayload.accessManifestBytesBase64url,
    ),
    proofBytes: Object.freeze(
      (parsed.protectedPayload.accessManifestProofBytesBase64url ?? []).map(
        (bytes) => fromBase64url("Protected Human Memory access proof", bytes),
      ),
    ),
    envelopes: Object.freeze(parsed.protectedPayload.namespaceEnvelopes.map(
      (envelope) => Object.freeze({
        namespaceId: envelope.namespaceId,
        bytes: fromBase64url("Protected Human Memory Namespace envelope",
          envelope.envelopeBytesBase64url),
      }),
    )),
  });
}

function exactEncryptedAccess(dto: ProtectedMemoryDtoV1): ReturnType<
  typeof parseExactEncryptedAccess
> {
  try {
    return parseExactEncryptedAccess(dto);
  } catch {
    // This boundary consumes only the server DTO's closed wire shape/bytes.
    throw new AuthorizedHumanMemoryUnavailableError("corrupt");
  }
}

function wipeExact(value: ReturnType<typeof exactEncryptedAccess>): void {
  value.payloadBytes.fill(0);
  value.manifestBytes.fill(0);
  value.proofBytes.forEach((bytes) => bytes.fill(0));
  value.envelopes.forEach(({ bytes }) => bytes.fill(0));
}

async function ensureProfileAvailable(
  input: VaultHumanMemoryDeviceContentInput,
): Promise<void> {
  let availability = await input.vault.availability();
  if (availability.status === "locked") {
    availability = await input.vault.unlock();
  }
  if (availability.status !== "available") {
    const reason = availability.status === "unsupported"
      ? "unsupported_version"
      : availability.status === "storage_lost"
        ? "lost_key_material"
        : availability.status === "corrupt"
          ? "corrupt"
          : "authorization_required";
    throw new AuthorizedHumanMemoryUnavailableError(reason);
  }
}

async function withProfile<Value>(
  input: VaultHumanMemoryDeviceContentInput,
  operation: (
    profile: OpenedClientDeviceProfileV2,
    profileV4: OpenedClientDeviceProfileV4,
  ) => Promise<Value>,
): Promise<Value> {
  await ensureProfileAvailable(input);
  const profileV4 = await input.vault.withOpenProfile(
    input.coordinates,
    (profileBytes) => authenticateClientDeviceProfileV4({
      crypto: input.crypto,
      profileBytes,
      expectedDeviceId: input.coordinates.deviceId,
    }),
  );
  try {
    return await operation(profileV4.baseProfile.baseProfile, profileV4);
  } finally {
    destroyOpenedClientDeviceProfileV4(profileV4);
  }
}

async function prepareOrdinaryFallback(
  input: VaultHumanMemoryDeviceContentInput,
  source: Readonly<{
    purpose: "memory.ordinary_fallback.create" | "memory.ordinary_fallback.update";
    operationId: string; memoryId: string; expectedContentRevision: number;
    nextContentRevision: number; expectedCryptoAccessRevision: number;
    requiredNamespaceIds: readonly string[]; policyRevision: number;
    planIssuedAt: number | null; planDeadlineAt: number | null;
    issuedAt: number; deadlineAt: number; intent: AuthorizedHumanMemoryWriteIntentV1;
  }>,
) {
  return withProfile(input, async (profile) => {
    const admission = await input.resolveDeviceAdmissionStatus();
    if (admission.status !== "admitted"
      || admission.deviceId !== input.coordinates.deviceId) {
      throw new AuthorizedHumanMemoryUnavailableError("authorization_required");
    }
    const prepared = prepareHumanMemoryOrdinaryFallbackRequestV1(input.crypto, {
      formatVersion: 1, purpose: source.purpose,
      reason: "target_encryption_not_ready", operationId: source.operationId,
      memoryId: source.memoryId,
      expectedContentRevision: source.expectedContentRevision,
      nextContentRevision: source.nextContentRevision,
      expectedCryptoAccessRevision: source.expectedCryptoAccessRevision,
      requiredNamespaceIds: [...source.requiredNamespaceIds].sort(),
      type: source.intent.payload.type, content: source.intent.payload.content,
      ...(source.intent.importance === undefined ? {} : {
        importance: source.intent.importance,
      }),
      requestedProvider: source.intent.requestedProvider,
      requestedModel: source.intent.requestedModel,
      dimensions: 1536, processorContractVersion: 1,
      policyRevision: source.policyRevision, subjectHumanId: input.subjectHumanId,
      committerDeviceId: profile.deviceId,
      committerDeviceSigningKeyGeneration: admission.deviceGeneration,
      hostAuthorizationRevision: profile.trustedHostAuthorizationRevision,
      planIssuedAt: source.planIssuedAt, planDeadlineAt: source.planDeadlineAt,
      issuedAt: source.issuedAt, deadlineAt: source.deadlineAt,
      signingPrivateKey: profile.signingPrivateKey,
    });
    try { return toBase64url(prepared.bytes); }
    finally {
      prepared.bytes.fill(0);
      prepared.request.signature.fill(0);
    }
  });
}

async function authenticateAndOpen(
  input: VaultHumanMemoryDeviceContentInput,
  profileV4: OpenedClientDeviceProfileV4,
  dto: ProtectedMemoryDtoV1,
  retained: TrustedMinimumObjectAccessHead | null,
): Promise<Readonly<{
  plaintext: Uint8Array;
  exact: ReturnType<typeof exactEncryptedAccess>;
  nextAnchor: TrustedMinimumObjectAccessHead;
  verifiedProof: readonly Uint8Array[];
}>> {
  const exact = exactEncryptedAccess(dto);
  let canonicalPayload: Uint8Array | undefined;
  let canonicalManifest: Uint8Array | undefined;
  try {
    let payload: ReturnType<typeof decodeEncryptedPayloadV2>;
    let manifest: ReturnType<typeof decodeObjectAccessManifestV5>;
    try {
      payload = decodeEncryptedPayloadV2(exact.payloadBytes);
      manifest = decodeObjectAccessManifestV5(exact.manifestBytes);
    } catch {
      throw new AuthorizedHumanMemoryUnavailableError("corrupt");
    }
    canonicalPayload = encodeEncryptedPayloadV2(payload);
    canonicalManifest = encodeObjectAccessManifestV5(manifest);
    if (
      !equalBytes(canonicalPayload, exact.payloadBytes)
      || !equalBytes(canonicalManifest, exact.manifestBytes)
      || payload.context.objectId !== manifest.objectId
    ) throw new AuthorizedHumanMemoryUnavailableError("integrity_failure");
    if (
      dto.protectedPayload.status !== "encrypted"
      || payload.context.objectId !== dto.protectedPayload.cryptoObjectId
      || payload.context.keyClass !== "ai"
      || payload.context.objectType !== MEMORY_OBJECT_TYPE
      || manifest.accessRevision !== dto.projection.cryptoAccessRevision
      || !equalBytes(manifest.payloadHash, input.crypto.hash(exact.payloadBytes))
    ) throw new AuthorizedHumanMemoryUnavailableError("integrity_failure");
    const proof = [...exact.proofBytes];
    let anchor: TrustedMinimumObjectAccessHead;
    if (retained === null) {
      const genesisBytes = manifest.accessRevision === 0
        ? exact.manifestBytes
        : proof.shift();
      if (genesisBytes === undefined) {
        throw new AuthorizedHumanMemoryUnavailableError("integrity_failure");
      }
      let genesis: ReturnType<typeof decodeObjectAccessManifestV5>;
      try { genesis = decodeObjectAccessManifestV5(genesisBytes); }
      catch { throw new AuthorizedHumanMemoryUnavailableError("corrupt"); }
      if (
        genesis.accessRevision !== 0
        || genesis.previousManifestHash !== null
        || genesis.objectId !== manifest.objectId
        || !equalBytes(genesis.payloadHash, manifest.payloadHash)
      ) throw new AuthorizedHumanMemoryUnavailableError("integrity_failure");
      anchor = {
        objectId: objectId(genesis.objectId),
        payloadHash: genesis.payloadHash,
        accessRevision: accessRevision(0),
        manifestHash: input.crypto.hash(genesisBytes),
      };
    } else {
      anchor = retained;
      if (manifest.accessRevision > retained.accessRevision) {
        const anchorIndex = proof.findIndex((bytes) => {
          let candidate: ReturnType<typeof decodeObjectAccessManifestV5>;
          try { candidate = decodeObjectAccessManifestV5(bytes); }
          catch { throw new AuthorizedHumanMemoryUnavailableError("corrupt"); }
          return candidate.accessRevision === retained.accessRevision
            && equalBytes(input.crypto.hash(bytes), retained.manifestHash);
        });
        if (anchorIndex < 0) {
          throw new AuthorizedHumanMemoryUnavailableError("integrity_failure");
        }
        proof.splice(0, anchorIndex + 1);
      } else {
        proof.length = 0;
      }
    }
    let publicKeys: Map<string, Uint8Array>;
    let foregroundKeys: Map<string, Uint8Array>;
    try {
      publicKeys = exactHumanSignerKeys(dto,
        [...exact.proofBytes, exact.manifestBytes]);
      foregroundKeys = exactForegroundAgentSignerKeys(input.crypto, dto,
        [...exact.proofBytes, exact.manifestBytes]);
    } catch {
      throw new AuthorizedHumanMemoryUnavailableError("integrity_failure");
    }
    try {
      const verify = (signerResolvers: ClientObjectAccessSignerResolversV4) =>
        verifyCommonObjectAccessManifestChain(input.crypto, {
          manifestBytes: exact.manifestBytes,
          proof,
          trustedMinimumHead: anchor,
          resolveHistoricalHumanDeviceSigningPublicKey: (context) =>
            publicKeys.get(humanSignerEvidenceKey({
              subjectHumanId: context.subjectHumanId,
              committerDeviceId: context.committerDeviceId,
              hostAuthorizationRevision: context.hostAuthorizationRevision,
            })) ?? null,
          resolveAgentRuntimeSignerPublicKey:
            (principal) => foregroundKeys.get(foregroundSignerKey(principal))
              ?.slice()
              ?? signerResolvers.resolveAgentRuntimeSignerPublicKey(principal),
          resolveProcessorSignerAuthorizationBytes:
            signerResolvers.resolveProcessorSignerAuthorizationBytes,
          resolveHistoricalProcessorIssuingDevicePublicKey:
            signerResolvers.resolveHistoricalProcessorIssuingDevicePublicKey,
        });
      let verified: ReturnType<typeof verify>;
      try {
        verified = withClientObjectAccessSignerResolversV4({
          crypto: input.crypto, profile: profileV4, operation: verify,
        });
      } catch {
        throw new AuthorizedHumanMemoryUnavailableError("integrity_failure");
      }
      const exactEnvelopeHashes = exact.envelopes.map(({ bytes }) =>
        input.crypto.hash(bytes)
      );
      try {
        if (
          verified.manifest.envelopeHashes.length !== exactEnvelopeHashes.length
          || verified.manifest.envelopeHashes.some((expectedHash) =>
            !exactEnvelopeHashes.some((actualHash) =>
              equalBytes(expectedHash, actualHash)
            )
          )
        ) throw new AuthorizedHumanMemoryUnavailableError("integrity_failure");
      } finally {
        exactEnvelopeHashes.forEach((hash) => hash.fill(0));
      }
      for (const envelope of exact.envelopes) {
        let decoded: ReturnType<typeof decodeNamespaceObjectEnvelopeV2>;
        try { decoded = decodeNamespaceObjectEnvelopeV2(envelope.bytes); }
        catch { throw new AuthorizedHumanMemoryUnavailableError("corrupt"); }
        if (
          decoded.context.objectId !== payload.context.objectId
          || decoded.context.namespaceId !== envelope.namespaceId
          || decoded.context.keyClass !== "ai"
        ) throw new AuthorizedHumanMemoryUnavailableError("integrity_failure");
        const hash = input.crypto.hash(envelope.bytes);
        const authorized = verified.manifest.envelopeHashes.some((candidate) =>
          equalBytes(candidate, hash)
        );
        hash.fill(0);
        if (!authorized) {
          throw new AuthorizedHumanMemoryUnavailableError("integrity_failure");
        }
      }
    } finally {
      publicKeys.forEach((key) => key.fill(0));
      foregroundKeys.forEach((key) => key.fill(0));
    }
    let plaintext: Uint8Array | undefined;
    for (const authority of dto.projection.readAuthorities) {
      const exactEnvelope = exact.envelopes.find((entry) =>
        entry.namespaceId === authority.namespaceId
      );
      if (exactEnvelope === undefined) {
        throw new AuthorizedHumanMemoryUnavailableError("integrity_failure");
      }
      let envelope: ReturnType<typeof decodeNamespaceObjectEnvelopeV2>;
      try { envelope = decodeNamespaceObjectEnvelopeV2(exactEnvelope.bytes); }
      catch { throw new AuthorizedHumanMemoryUnavailableError("corrupt"); }
      try {
        plaintext = await withNamespaceAuthority({
          dependencies: input,
          authority,
          generation: envelope.context.keyGeneration,
          operation: (keyring) => {
            const generation = keyring.find((entry) =>
              entry.namespaceId === envelope.context.namespaceId
              && entry.accessRevision === envelope.context.bindingRevisionAtWrap
              && entry.generation === envelope.context.keyGeneration
            );
            if (generation === undefined) return null;
            return decryptObjectThroughNamespace(
              input.crypto,
              generation.generationKey,
              envelope,
              payload,
            );
          },
        }) ?? undefined;
      } catch (error) {
        if (!(error instanceof NamespaceAuthorityUnavailableError)) throw error;
      }
      if (plaintext !== undefined) break;
    }
    if (plaintext === undefined) {
      throw new AuthorizedHumanMemoryUnavailableError("encryption_pending");
    }
    if (dto.shadowComparison !== undefined) {
      try {
        exactFields("Memory Shadow comparison", dto.shadowComparison, ["algorithm", "digestBase64url"]);
        if (dto.shadowComparison.algorithm !== "sha256-memory-payload-v1") {
          throw new TypeError("Unsupported Memory comparison");
        }
        const expected = fromBase64url("Memory Shadow comparison", dto.shadowComparison.digestBase64url);
        const actual = sha256(plaintext);
        try {
          if (toBase64url(expected) !== dto.shadowComparison.digestBase64url
            || !equalBytes(expected, actual)) throw new TypeError("Memory Shadow siblings disagree");
        } finally {
          expected.fill(0);
          actual.fill(0);
        }
      } catch {
        plaintext.fill(0);
        throw new AuthorizedHumanMemoryUnavailableError("integrity_failure");
      }
    }
    const nextAnchor: TrustedMinimumObjectAccessHead = {
      objectId: objectId(manifest.objectId),
      payloadHash: manifest.payloadHash,
      accessRevision: accessRevision(manifest.accessRevision),
      manifestHash: input.crypto.hash(exact.manifestBytes),
    };
    return Object.freeze({ plaintext, exact, nextAnchor,
      verifiedProof: Object.freeze(proof.map((bytes) => bytes.slice())) });
  } catch (error) {
    wipeExact(exact);
    throw error;
  } finally {
    canonicalPayload?.fill(0);
    canonicalManifest?.fill(0);
  }
}

async function wrapCurrentMemoryNamespaceDek(input: Readonly<{
  dependencies: VaultHumanMemoryDeviceContentInput;
  authority: ProtectedMemoryNamespaceAuthorityV1;
  cryptoObjectId: string;
  dek: Uint8Array;
}>): Promise<Uint8Array> {
  return withNamespaceAuthority({ dependencies: input.dependencies, authority: input.authority,
    generation: input.authority.currentGeneration,
    operation: (keyring) => {
      const current = keyring.find((entry) => entry.generation === input.authority.currentGeneration);
      if (current === undefined) {
        throw new NamespaceAuthorityUnavailableError(
          "current_generation_unavailable",
        );
      }
      return encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespace(input.dependencies.crypto,
        current.generationKey, { objectId: objectId(input.cryptoObjectId), namespaceId: namespaceId(input.authority.namespaceId),
          keyClass: "ai", keyGeneration: current.generation, bindingRevisionAtWrap: current.accessRevision }, input.dek));
    },
  });
}

async function prepareContentRevision(input: Readonly<{
  dependencies: VaultHumanMemoryDeviceContentInput;
  profile: OpenedClientDeviceProfileV2;
  memoryId: string;
  operationId: string;
  expectedContentRevision: number;
  nextContentRevision: number;
  namespaceIds: readonly string[];
  authorities: readonly ProtectedMemoryNamespaceAuthorityV1[];
  deadlineAt: number;
  intent: AuthorizedHumanMemoryWriteIntentV1;
}>): Promise<Readonly<{
  cryptoObjectId: string;
  payloadBytes: Uint8Array;
  manifestBytes: Uint8Array;
  envelopeBytes: readonly Uint8Array[];
  signedRequestBytes: Uint8Array;
}>> {
  const now = input.dependencies.now();
  if (
    !Number.isSafeInteger(now)
    || now < 0
    || !Number.isSafeInteger(input.deadlineAt)
    || input.deadlineAt <= now
  ) throw new Error("Protected Human Memory preparation deadline is invalid");
  if (
    input.namespaceIds.length < 1
    || new Set(input.namespaceIds).size !== input.namespaceIds.length
    || [...input.namespaceIds].sort().some((value, index) =>
      value !== input.namespaceIds[index]
    )
  ) {
    throw new Error("Protected Human Memory exact Namespace set is invalid");
  }
  if (!equalStrings(input.authorities.map((entry) => entry.namespaceId), input.namespaceIds)) {
    throw new Error("Protected Human Memory mutation authority is unavailable");
  }
      const cryptoObjectId = deriveMemoryCryptoObjectIdV1({
        memoryId: input.memoryId,
        contentRevision: input.nextContentRevision,
      });
      let payloadBytes: Uint8Array | undefined;
      let envelopeBytes: readonly Uint8Array[] = [];
      let manifestBytes: Uint8Array | undefined;
      let signedRequestBytes: Uint8Array | undefined;
      try {
        const sealed = await prepareHumanMemoryCiphertext({
          crypto: input.dependencies.crypto,
          memoryId: input.memoryId, contentRevision: input.nextContentRevision,
          createdAt: now, payload: input.intent.payload,
          namespaceIds: input.namespaceIds,
          subjectHumanId: input.dependencies.subjectHumanId,
          deviceId: input.profile.deviceId,
          hostAuthorizationRevision: input.profile.trustedHostAuthorizationRevision,
          signingPublicKey: input.profile.signingPublicKey,
          signingPrivateKey: input.profile.signingPrivateKey,
          wrapNamespace: ({ namespaceId: targetNamespaceId, dek }) => wrapCurrentMemoryNamespaceDek({
            dependencies: input.dependencies,
            authority: input.authorities.find((entry) => entry.namespaceId === targetNamespaceId)!,
            cryptoObjectId, dek,
          }),
        });
        payloadBytes = sealed.payloadBytes;
        envelopeBytes = sealed.envelopeBytes;
        manifestBytes = sealed.manifestBytes;
        const signedRequest = prepareHumanMemoryContentEmbeddingRequest(
          input.dependencies.crypto,
          {
            subjectHumanId: humanId(input.dependencies.subjectHumanId),
            requestId: input.operationId,
            memoryId: input.memoryId,
            expectedProductRevision: input.expectedContentRevision,
            nextProductRevision: input.nextContentRevision,
            cryptoObjectId: objectId(cryptoObjectId),
            ciphertextPayloadHash: input.dependencies.crypto.hash(payloadBytes),
            genesisManifestHash: input.dependencies.crypto.hash(manifestBytes),
            namespaceEnvelopes: [...input.namespaceIds].sort().map(
              (targetNamespaceId, index) => ({
                namespaceId: namespaceId(targetNamespaceId),
                envelopeHash: input.dependencies.crypto.hash(envelopeBytes[index]!),
              }),
            ),
            type: input.intent.payload.type,
            content: input.intent.payload.content,
            ...(input.intent.importance === undefined
              ? {} : { importance: input.intent.importance }),
            requestedProvider: input.intent.requestedProvider,
            requestedModel: input.intent.requestedModel,
            dimensions: 1536,
            processorContractVersion: 1,
            issuedAt: unixTimestamp(now),
            deadlineAt: unixTimestamp(Math.min(
              input.deadlineAt,
              now + SIGNED_REQUEST_TTL_MS,
            )),
            committerDeviceId: cryptoDeviceId(input.profile.deviceId),
            hostAuthorizationRevision: authorizationRevision(
              input.profile.trustedHostAuthorizationRevision,
            ),
            committerSigningPublicKey: input.profile.signingPublicKey,
            committerSigningPrivateKey: input.profile.signingPrivateKey,
          },
        );
        signedRequestBytes = signedRequest.bytes;
        return Object.freeze({
          cryptoObjectId,
          payloadBytes,
          manifestBytes,
          envelopeBytes,
          signedRequestBytes,
        });
      } catch (error) {
        payloadBytes?.fill(0);
        envelopeBytes.forEach((bytes) => bytes.fill(0));
        manifestBytes?.fill(0);
        signedRequestBytes?.fill(0);
        if (error instanceof NamespaceAuthorityUnavailableError
          && error.authorityReason !== "device_admission_unavailable") {
          throw new AuthorizedHumanMemoryUnavailableError(
            "target_encryption_not_ready",
          );
        }
        throw error;
      }
}

function nativeGenerationDigests(
  authority: ProtectedMemoryDtoV1["projection"]["readAuthorities"][number],
  generation: number,
  accessRevisionValue: number,
) {
  const retained = authority.retainedGenerations.find((entry) =>
    entry.generation === generation && entry.accessRevision === accessRevisionValue);
  if (retained === undefined) {
    throw new Error("Protected Human Memory native Namespace authority is stale");
  }
  return Object.freeze({
    headDigest: fromBase64url("Protected Human Memory head digest",
      retained.headDigestBase64url),
    publicationDigest: fromBase64url("Protected Human Memory publication digest",
      retained.publicationDigestBase64url),
    publicationSetDigest: fromBase64url("Protected Human Memory publication-set digest",
      retained.publicationSetDigestBase64url),
    audienceFingerprint: fromBase64url("Protected Human Memory audience fingerprint",
      retained.audienceFingerprintBase64url),
  });
}

async function prepareAccessUpdate(input: Readonly<{
  dependencies: VaultHumanMemoryDeviceContentInput;
  profile: OpenedClientDeviceProfileV2;
  profileV4: OpenedClientDeviceProfileV4;
  current: ProtectedMemoryDtoV1;
  plan: Extract<ProtectedMemoryAccessPlanResponseV1, { status: "planned" }>;
  retainedAnchor: TrustedMinimumObjectAccessHead | null;
}>): Promise<Readonly<{
  request: ProtectedMemoryPreparedAccessRequestV1;
  nextAnchor: TrustedMinimumObjectAccessHead;
}>> {
  if (
    !equalStrings(
      input.plan.addedNamespaceIds,
      input.plan.targetNamespaceIds.filter((exactNamespaceId) =>
        !input.plan.currentNamespaceIds.includes(exactNamespaceId)
      ),
    )
    || !equalStrings(
      input.plan.removedNamespaceIds,
      input.plan.currentNamespaceIds.filter((exactNamespaceId) =>
        !input.plan.targetNamespaceIds.includes(exactNamespaceId)
      ),
    )
    || !equalStrings(
      input.plan.currentAuthorities.map((entry) => entry.namespaceId),
      input.plan.currentNamespaceIds,
    )
    || !equalStrings(
      input.plan.targetAuthorities.map((entry) => entry.namespaceId),
      input.plan.targetNamespaceIds,
    )
  ) throw new Error("Protected Human Memory access plan inventories disagree");
  const opened = await authenticateAndOpen(
    input.dependencies,
    input.profileV4,
    input.current,
    input.retainedAnchor,
  );
  let dek: Uint8Array | undefined;
  const added = new Set(input.plan.addedNamespaceIds);
  const currentByNamespace = new Map(opened.exact.envelopes.map((entry) =>
    [entry.namespaceId, entry.bytes] as const
  ));
  const targetEnvelopeBytes: Uint8Array[] = [];
  const publicKeys = new Map<string, Uint8Array>();
  try {
    if (added.size > 0) {
      for (const authority of input.plan.currentAuthorities) {
        const exactEnvelope = opened.exact.envelopes.find((entry) =>
          entry.namespaceId === authority.namespaceId
        );
        if (exactEnvelope === undefined) throw new Error(
          "Protected Human Memory current authority is outside its inventory",
        );
        const envelope = decodeNamespaceObjectEnvelopeV2(exactEnvelope.bytes);
        try {
          dek = await withNamespaceAuthority({
            dependencies: input.dependencies,
            authority,
            generation: envelope.context.keyGeneration,
            operation: (keyring) => {
              const generation = keyring.find((entry) =>
                entry.namespaceId === envelope.context.namespaceId
                && entry.accessRevision === envelope.context.bindingRevisionAtWrap
                && entry.generation === envelope.context.keyGeneration
              );
              return generation === undefined ? null : openObjectDekForNamespace(
                input.dependencies.crypto,
                generation.generationKey,
                envelope,
              );
            },
          }) ?? undefined;
        } catch (error) {
          if (!(error instanceof Error) || !/unavailable/u.test(error.message)) {
            throw error;
          }
        }
        if (dek !== undefined) break;
      }
      if (dek === undefined) {
        throw new Error("Protected Human Memory DEK is unavailable for access update");
      }
    }
    for (const authority of input.plan.targetAuthorities) {
      const retained = currentByNamespace.get(authority.namespaceId);
      if (retained !== undefined) {
        targetEnvelopeBytes.push(retained.slice());
        continue;
      }
      if (!added.has(authority.namespaceId) || dek === undefined) {
        throw new Error("Protected Human Memory target envelope set is inexact");
      }
      const bytes = await withNamespaceAuthority({
        dependencies: input.dependencies,
        authority,
        generation: authority.currentGeneration,
        operation: (keyring) => {
          const generation = keyring.at(-1);
          if (generation === undefined) {
            throw new Error("Protected Human Memory target generation is unavailable");
          }
          return encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespace(
            input.dependencies.crypto,
            generation.generationKey,
            {
              objectId: objectId(input.plan.cryptoObjectId),
              namespaceId: namespaceId(authority.namespaceId),
              keyClass: "ai",
              keyGeneration: generation.generation,
              bindingRevisionAtWrap: accessRevision(generation.accessRevision),
            },
            dek!,
          ));
        },
      });
      targetEnvelopeBytes.push(bytes);
    }
    const anchor = input.retainedAnchor;
    if (anchor === null) {
      throw new Error("Protected Human Memory access rollback anchor is unavailable");
    }
    const humanKeys = exactHumanSignerKeys(
      input.current,
      [...opened.exact.proofBytes, opened.exact.manifestBytes],
    );
    humanKeys.forEach((key, coordinate) => publicKeys.set(coordinate, key));
    const currentManifest = decodeObjectAccessManifestV5(opened.exact.manifestBytes);
    const prepared = createCommonHumanObjectAccessManifest(input.dependencies.crypto, {
      objectId: currentManifest.objectId,
      payloadHash: currentManifest.payloadHash,
      accessRevision: accessRevision(currentManifest.accessRevision + 1),
      previousManifestHash: input.dependencies.crypto.hash(opened.exact.manifestBytes),
      envelopeHashes: targetEnvelopeBytes.map((bytes) => input.dependencies.crypto.hash(bytes)),
      signer: { kind: "human_device", subjectHumanId: humanId(input.dependencies.subjectHumanId),
        committerDeviceId: cryptoDeviceId(input.profile.deviceId) },
      signerAuthorizationHash: null,
      hostAuthorizationRevision: authorizationRevision(
        input.profile.trustedHostAuthorizationRevision),
    }, input.profile.signingPrivateKey);
    const toSignedEntry = (
      authority: typeof input.plan.currentAuthorities[number],
      envelopeBytes: Uint8Array,
    ) => {
      const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
      return Object.freeze({
        namespaceId: namespaceId(authority.namespaceId),
        keyGeneration: envelope.context.keyGeneration,
        namespaceAccessRevision: envelope.context.bindingRevisionAtWrap,
        ...nativeGenerationDigests(authority, envelope.context.keyGeneration,
          envelope.context.bindingRevisionAtWrap),
        envelopeHash: input.dependencies.crypto.hash(envelopeBytes),
      });
    };
    const toAuthorityEntry = (
      authority: typeof input.plan.currentAuthorities[number],
    ) => Object.freeze({
      namespaceId: namespaceId(authority.namespaceId),
      keyGeneration: authority.currentGeneration,
      namespaceAccessRevision: authority.retainedGenerations.find((entry) =>
        entry.generation === authority.currentGeneration)!.accessRevision,
      ...nativeGenerationDigests(authority, authority.currentGeneration,
        authority.retainedGenerations.find((entry) =>
          entry.generation === authority.currentGeneration)!.accessRevision),
    });
    const now = input.dependencies.now();
    const signed = prepareHumanMemoryExactAccessRequest(
      input.dependencies.crypto,
      {
        subjectHumanId: humanId(input.dependencies.subjectHumanId),
        operationId: input.plan.operationId,
        memoryId: input.plan.memoryId,
        cryptoObjectId: objectId(input.plan.cryptoObjectId),
        payloadHash: opened.nextAnchor.payloadHash,
        expectedContentRevision: input.plan.expectedContentRevision,
        expectedAccessRevision: input.plan.expectedCryptoAccessRevision,
        nextAccessRevision: input.plan.expectedCryptoAccessRevision + 1,
        currentManifestHash: input.dependencies.crypto.hash(
          opened.exact.manifestBytes,
        ),
        nextManifestHash: prepared.hash,
        currentEntries: input.plan.currentAuthorities.map((authority) => {
          const envelope = opened.exact.envelopes.find((entry) =>
            entry.namespaceId === authority.namespaceId
          );
          if (envelope === undefined) throw new Error(
            "Protected Human Memory current signed entry is incomplete",
          );
          return toSignedEntry(authority, envelope.bytes);
        }),
        targetEntries: input.plan.targetAuthorities.map((authority) => {
          const envelope = targetEnvelopeBytes.find((bytes) =>
            decodeNamespaceObjectEnvelopeV2(bytes).context.namespaceId
              === authority.namespaceId
          );
          if (envelope === undefined) throw new Error(
            "Protected Human Memory target signed entry is incomplete",
          );
          return toSignedEntry(authority, envelope);
        }),
        currentAuthorityEntries: input.plan.currentAuthorities.map(toAuthorityEntry),
        targetAuthorityEntries: input.plan.targetAuthorities.map(toAuthorityEntry),
        issuedAt: unixTimestamp(now),
        deadlineAt: unixTimestamp(Math.min(
          input.plan.deadlineAt,
          now + SIGNED_REQUEST_TTL_MS,
        )),
        committerDeviceId: cryptoDeviceId(input.profile.deviceId),
        hostAuthorizationRevision: authorizationRevision(
          input.profile.trustedHostAuthorizationRevision,
        ),
        committerSigningPublicKey: input.profile.signingPublicKey,
        committerSigningPrivateKey: input.profile.signingPrivateKey,
      },
    );
    const signedAccessRequestBytesBase64url = toBase64url(signed.bytes);
    signed.bytes.fill(0);
    const request = Object.freeze({
      requestVersion: 1,
      operationId: input.plan.operationId,
      memoryId: input.plan.memoryId,
      expectedContentRevision: input.plan.expectedContentRevision,
      expectedCryptoAccessRevision: input.plan.expectedCryptoAccessRevision,
      nextCryptoAccessRevision: input.plan.expectedCryptoAccessRevision + 1,
      cryptoObjectId: input.plan.cryptoObjectId,
      currentNamespaceIds: [...input.plan.currentNamespaceIds],
      targetNamespaceIds: [...input.plan.targetNamespaceIds],
      accessManifestBytesBase64url: toBase64url(prepared.bytes),
      signedAccessRequestBytesBase64url,
      namespaceEnvelopes: input.plan.targetNamespaceIds.map((namespaceId, index) => ({
        namespaceId,
        envelopeBytesBase64url: toBase64url(targetEnvelopeBytes[index]!),
      })),
    });
    return Object.freeze({ request, nextAnchor: opened.nextAnchor });
  } finally {
    opened.plaintext.fill(0);
    wipeExact(opened.exact);
    opened.verifiedProof.forEach((bytes) => bytes.fill(0));
    dek?.fill(0);
    targetEnvelopeBytes.forEach((bytes) => bytes.fill(0));
    publicKeys.forEach((key) => key.fill(0));
  }
}

/**
 * Real vault-backed device content boundary for the exact M:N common-v5 Human
 * Memory client. Device keys and Human Namespace generations remain callback-local
 * to the active ClientProfileVault profile.
 */
export function createVaultAuthorizedHumanMemoryDeviceContentPort(
  dependencies: VaultHumanMemoryDeviceContentInput,
): AuthorizedHumanMemoryDeviceContentPort {
  const retainSignerEvidence = (dto: ProtectedMemoryDtoV1) => {
    if (dto.protectedPayload.status !== "encrypted") return Promise.resolve();
    const generalEvidence = dto.protectedPayload.accessSignerEvidence.filter(
      (entry): entry is Exclude<typeof entry,
        HumanSignerEvidence | EvidenceIssuer | ForegroundAgentEvidence> =>
        entry.kind !== "human_device"
        && entry.kind !== "evidence_issuer_human_device"
        && entry.kind !== "foreground_agent_accepted_execution",
    );
    const issuerEvidence = dto.protectedPayload.accessSignerEvidence.filter(
      (entry): entry is EvidenceIssuer =>
        entry.kind === "evidence_issuer_human_device",
    );
    return ingestObjectAccessSignerEvidenceV4({
      crypto: dependencies.crypto,
      vault: dependencies.vault,
      coordinates: dependencies.coordinates,
      evidence: generalEvidence,
      resolveTrustedIssuingDevicePublicKey: ({
        deviceId,
        hostAuthorizationRevision,
      }) => {
        const matches = issuerEvidence.filter((entry) =>
          entry.deviceId === deviceId
          && entry.hostAuthorizationRevision === hostAuthorizationRevision
        );
        if (matches.length !== 1) return Promise.resolve(null);
        const key = fromBase64url(
          "Protected Human Memory evidence issuer key",
          matches[0]!.signingPublicKeyBase64url,
        );
        return Promise.resolve(key.length === 32 ? key : null);
      },
      createStageId: dependencies.createProfileStageId,
    });
  };
  const port: AuthorizedHumanMemoryDeviceContentPort = {
    prepareRepair: async (rawPlan) => {
      const plan = protectedMemoryRepairPlanV1Schema.parse(rawPlan);
      const openedReversePayload = plan.direction === "protected_to_ordinary"
        ? await port.openExact(plan.repairInput) : undefined;
      try {
        return await withProfile(dependencies, async (profile) => {
          const admission = await dependencies.resolveDeviceAdmissionStatus();
          if (admission.status !== "admitted" || admission.deviceId !== profile.deviceId) {
            throw new Error("Protected Human Memory repair device admission is unavailable");
          }
          return prepareHumanMemoryRepairRequest({
            crypto: dependencies.crypto, plan, now: dependencies.now(),
            subjectHumanId: dependencies.subjectHumanId, deviceId: profile.deviceId,
            deviceSigningKeyGeneration: admission.deviceGeneration,
            hostAuthorizationRevision: profile.trustedHostAuthorizationRevision,
            signingPublicKey: profile.signingPublicKey, signingPrivateKey: profile.signingPrivateKey,
            ...(openedReversePayload === undefined ? {} : { openedReversePayload }),
            wrapNamespace: ({ namespaceId: targetNamespaceId, cryptoObjectId, dek }) => {
              const authority = plan.targetAuthorities.find((entry) => entry.namespaceId === targetNamespaceId);
              if (authority === undefined) throw new Error("Protected Human Memory repair audience is unavailable");
              return wrapCurrentMemoryNamespaceDek({ dependencies, authority, cryptoObjectId, dek });
            },
          });
        });
      } finally { openedReversePayload?.fill(0); }
    },
    openExact: async (dto: ProtectedMemoryDtoV1) => {
      if (dto.protectedPayload.status !== "encrypted") {
        throw new Error("Protected Human Memory ciphertext is unavailable");
      }
      await ensureProfileAvailable(dependencies);
      await retainSignerEvidence(dto);
      const retained = await dependencies.accessAnchors.load(
        dto.protectedPayload.cryptoObjectId,
      );
      const result = await withProfile(dependencies, async (_profile, profileV4) => {
        const opened = await authenticateAndOpen(
          dependencies, profileV4, dto, retained,
        );
        wipeExact(opened.exact);
        opened.verifiedProof.forEach((bytes) => bytes.fill(0));
        return Object.freeze({ plaintext: opened.plaintext,
          nextAnchor: opened.nextAnchor });
      });
      if (!await dependencies.accessAnchors.advance({
        expected: retained,
        next: result.nextAnchor,
      })) {
        result.plaintext.fill(0);
        throw new Error("Protected Human Memory rollback anchor changed concurrently");
      }
      return result.plaintext;
    },
    prepareCreate: ({ plan: rawPlan, intent }: Readonly<{
      plan: ProtectedMemoryCreatePlanSlotResponseV1;
      intent: AuthorizedHumanMemoryWriteIntentV1;
    }>) =>
      withProfile(dependencies, async (profile) => {
        const plan = exactCreatePlan(rawPlan);
        const prepared = await prepareContentRevision({
          dependencies,
          profile,
          memoryId: plan.memoryId,
          operationId: plan.operationId,
          expectedContentRevision: 0,
          nextContentRevision: 1,
          namespaceIds: plan.requiredNamespaceIds,
          authorities: plan.targetAuthorities,
          deadlineAt: plan.deadlineAt,
          intent,
        });
        try {
          return Object.freeze({
            requestVersion: 1,
            memoryId: plan.memoryId,
            operationId: plan.operationId,
            expectedContentRevision: 0,
            nextContentRevision: 1,
            cryptoObjectId: prepared.cryptoObjectId,
            payloadVersion: 1,
            encryptedPayloadBytesBase64url: toBase64url(prepared.payloadBytes),
            accessManifestBytesBase64url: toBase64url(prepared.manifestBytes),
            requiredNamespaceIds: [...plan.requiredNamespaceIds].sort(),
            namespaceEnvelopes: [...plan.requiredNamespaceIds].sort().map(
              (namespaceId, index) => ({
                namespaceId,
                envelopeBytesBase64url: toBase64url(prepared.envelopeBytes[index]!),
              }),
            ),
            signedContentEmbeddingRequestBytesBase64url: toBase64url(
              prepared.signedRequestBytes,
            ),
          }) satisfies ProtectedMemoryPreparedCreateRequestV1;
        } finally {
          prepared.payloadBytes.fill(0);
          prepared.manifestBytes.fill(0);
          prepared.envelopeBytes.forEach((bytes) => bytes.fill(0));
          prepared.signedRequestBytes.fill(0);
        }
      }),
    prepareOrdinaryFallbackCreate: async ({ plan, intent }:
    OrdinaryFallbackCreateInput) => {
      const exactPlan = "status" in plan
        ? protectedMemoryOrdinaryFallbackCreatePlanV1Schema.parse(plan)
        : exactCreatePlan(plan);
      const authorization = exactPlan.ordinaryFallbackAuthorization;
      if (authorization === undefined || exactPlan.issuedAt === undefined) {
        throw new AuthorizedHumanMemoryUnavailableError(
          "target_encryption_not_ready",
        );
      }
      const signed = await prepareOrdinaryFallback(dependencies, {
        purpose: "memory.ordinary_fallback.create",
        operationId: exactPlan.operationId, memoryId: exactPlan.memoryId,
        expectedContentRevision: 0, nextContentRevision: 1,
        expectedCryptoAccessRevision: 0,
        requiredNamespaceIds: exactPlan.requiredNamespaceIds,
        policyRevision: authorization.policyRevision,
        planIssuedAt: exactPlan.issuedAt, planDeadlineAt: exactPlan.deadlineAt,
        issuedAt: exactPlan.issuedAt, deadlineAt: exactPlan.deadlineAt, intent,
      });
      return Object.freeze({ requestVersion: 1,
        publicationKind: "ordinary_fallback" as const,
        reason: "target_encryption_not_ready" as const,
        memoryId: exactPlan.memoryId, operationId: exactPlan.operationId,
        expectedContentRevision: 0 as const, nextContentRevision: 1 as const,
        expectedCryptoAccessRevision: 0 as const,
        requiredNamespaceIds: [...exactPlan.requiredNamespaceIds].sort(),
        signedOrdinaryFallbackRequestBytesBase64url: signed });
    },
    prepareUpdate: async ({ current, intent }: Readonly<{
      current: ProtectedMemoryDtoV1;
      intent: AuthorizedHumanMemoryWriteIntentV1;
    }>) => {
      if (current.protectedPayload.status !== "encrypted") {
        throw new Error("Protected Human Memory ciphertext is unavailable");
      }
      await ensureProfileAvailable(dependencies);
      await retainSignerEvidence(current);
      const retained = await dependencies.accessAnchors.load(
        current.protectedPayload.cryptoObjectId,
      );
      const result = await withProfile(dependencies, async (profile, profileV4) => {
        const parsedCurrent = current;
        const opened = await authenticateAndOpen(
          dependencies,
          profileV4,
          parsedCurrent,
          retained,
        );
        try {
          const operationId = dependencies.createOperationId();
          const nextContentRevision =
            parsedCurrent.projection.contentRevision + 1;
          const prepared = await prepareContentRevision({
            dependencies,
            profile,
            memoryId: parsedCurrent.projection.memoryId,
            operationId,
            expectedContentRevision: parsedCurrent.projection.contentRevision,
            nextContentRevision,
            namespaceIds: parsedCurrent.projection.requiredNamespaceIds,
            authorities: parsedCurrent.projection.mutationAuthorities ?? [],
            deadlineAt: dependencies.now() + SIGNED_REQUEST_TTL_MS,
            intent,
          });
          try {
            const request = Object.freeze({
              requestVersion: 1,
              operationId,
              expectedContentRevision: parsedCurrent.projection.contentRevision,
              nextContentRevision,
              cryptoObjectId: prepared.cryptoObjectId,
              payloadVersion: 1,
              encryptedPayloadBytesBase64url: toBase64url(prepared.payloadBytes),
              accessManifestBytesBase64url: toBase64url(prepared.manifestBytes),
              requiredNamespaceIds: [...parsedCurrent.projection.requiredNamespaceIds].sort(),
              namespaceEnvelopes: [...parsedCurrent.projection.requiredNamespaceIds]
                .sort().map((namespaceId, index) => ({
                  namespaceId,
                  envelopeBytesBase64url: toBase64url(prepared.envelopeBytes[index]!),
                })),
              signedContentEmbeddingRequestBytesBase64url: toBase64url(
                prepared.signedRequestBytes,
              ),
            }) satisfies ProtectedMemoryPreparedUpdateRequestV1;
            return Object.freeze({ request, nextAnchor: opened.nextAnchor });
          } finally {
            prepared.payloadBytes.fill(0);
            prepared.manifestBytes.fill(0);
            prepared.envelopeBytes.forEach((bytes) => bytes.fill(0));
            prepared.signedRequestBytes.fill(0);
          }
        } finally {
          opened.plaintext.fill(0);
          wipeExact(opened.exact);
          opened.verifiedProof.forEach((bytes) => bytes.fill(0));
        }
      });
      if (!await dependencies.accessAnchors.advance({
        expected: retained,
        next: result.nextAnchor,
      })) throw new Error("Protected Human Memory rollback anchor changed concurrently");
      return result.request;
    },
    prepareOrdinaryFallbackUpdate: async ({ current, policyRevision, intent }:
    OrdinaryFallbackUpdateInput) => {
      const issuedAt = dependencies.now();
      const operationId = dependencies.createOperationId();
      const signed = await prepareOrdinaryFallback(dependencies, {
        purpose: "memory.ordinary_fallback.update", operationId,
        memoryId: current.projection.memoryId,
        expectedContentRevision: current.projection.contentRevision,
        nextContentRevision: current.projection.contentRevision + 1,
        expectedCryptoAccessRevision: current.projection.cryptoAccessRevision,
        requiredNamespaceIds: current.projection.requiredNamespaceIds,
        policyRevision, planIssuedAt: null, planDeadlineAt: null,
        issuedAt, deadlineAt: issuedAt + SIGNED_REQUEST_TTL_MS, intent,
      });
      return Object.freeze({ requestVersion: 1,
        publicationKind: "ordinary_fallback" as const,
        reason: "target_encryption_not_ready" as const,
        memoryId: current.projection.memoryId, operationId,
        expectedContentRevision: current.projection.contentRevision,
        nextContentRevision: current.projection.contentRevision + 1,
        expectedCryptoAccessRevision: current.projection.cryptoAccessRevision,
        requiredNamespaceIds: [...current.projection.requiredNamespaceIds].sort(),
        signedOrdinaryFallbackRequestBytesBase64url: signed });
    },
    prepareAccess: async ({ current, plan }: Readonly<{
      current: ProtectedMemoryDtoV1;
      plan: Extract<ProtectedMemoryAccessPlanResponseV1, { status: "planned" }>;
    }>) => {
      await ensureProfileAvailable(dependencies);
      await retainSignerEvidence(current);
      const retained = await dependencies.accessAnchors.load(plan.cryptoObjectId);
      const result = await withProfile(dependencies, (profile, profileV4) => prepareAccessUpdate({
        dependencies, profile, profileV4, current, plan, retainedAnchor: retained,
      }));
      if (!await dependencies.accessAnchors.advance({
        expected: retained,
        next: result.nextAnchor,
      })) throw new Error("Protected Human Memory rollback anchor changed concurrently");
      return result.request;
    },
    prepareAccessReadiness: async ({ current, sourceRoomId, requiredNamespaceIds }) => {
      if (!current.projection.readAuthorities.some((entry) =>
        entry.sourceRoomId === sourceRoomId
      ) || requiredNamespaceIds.some((namespaceId) =>
        current.projection.requiredNamespaceIds.includes(namespaceId)
      )) throw new Error("Protected Human Memory readiness target is not authenticated");
      for (const namespaceId of requiredNamespaceIds) {
        const ready = await dependencies.namespaceAuthority.ensure({
          sourceRoomId,
          namespaceId,
          keyClass: "ai",
          operationId: dependencies.createOperationId(),
          idempotencyKey: dependencies.createOperationId(),
        });
        if (ready.status !== "ready") {
          throw new AuthorizedHumanMemoryUnavailableError(
            "target_encryption_not_ready",
          );
        }
      }
    },
  };
  return Object.freeze(port);
}
