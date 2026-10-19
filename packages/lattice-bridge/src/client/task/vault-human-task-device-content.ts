import type {
  DeviceAdmissionStatus,
  DualTaskPreparedCreateRequestV1,
  DualTaskPreparedUpdateRequestV1,
  ProtectedTaskPreparedCreateRequestV1,
  ProtectedTaskPreparedUpdateRequestV1,
} from "@nautilo/api-client/browser";
import {
  LatticeCrypto,
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  decryptObjectThroughNamespace,
  encryptObjectPayload,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  prepareHumanObjectAccessManifestGenesisSet,
  prepareHumanTaskPublicationRequest,
  unixTimestamp,
  verifyCommonObjectAccessManifestChain,
  wrapObjectDekForNamespace,
  type TrustedMinimumObjectAccessHead,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV5,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
  encodeObjectAccessManifestV5,
} from "@nautilo/lattice-crypto/wire";

import {
  authenticateClientDeviceProfileV4,
  destroyOpenedClientDeviceProfileV4,
  withClientObjectAccessSignerResolversV4,
} from "../../client-vault/profile-v4.ts";
import {
  ingestObjectAccessSignerEvidenceV4,
  type ObjectAccessSignerEvidenceTransportV1,
  type ResolveTrustedObjectAccessEvidenceIssuerV4,
} from "../../client-vault/ingest-object-access-signer-evidence-v4.ts";
import type {
  ClientProfileCoordinates,
  ClientProfileVault,
} from "../../client-vault/types.ts";
import { withClientNamespaceKeyring } from
  "../../device/client-namespace-keyring.ts";
import {
  deriveTaskContentCryptoObjectIdV1,
  TASK_DEFINITION_OBJECT_TYPE_V1,
} from "../../task/task-content-repository.ts";
import { deriveTaskHistoricalContentCryptoObjectIdV1 } from
  "../../task/task-historical-content-identity.ts";
import { encodeTaskDefinitionContent } from "../../task/task-payload-v1.ts";
import { parseTaskHistoricalRepairProvenanceV1 } from
  "../../task/task-historical-repair-provenance.ts";
import {
  fingerprintTaskDualPublicationFieldsV1,
  fingerprintTaskOperationalFieldsV1,
} from
  "../../task/task-operational-fields-digest-v1.ts";
import {
  ClassifiedDataOperationError,
} from "../../transition/encryption-data-operation-owner.ts";
import type {
  HumanTaskDeviceContentPortV1,
} from "./authorized-human-task-client.ts";
import type {
  NamespaceAuthorityClient,
  NamespaceGenerationAuthority,
} from "../message/namespace-authority-client.ts";
import {
  exactForegroundAgentSignerKeysV1,
  foregroundAgentSignerPrincipalKeyV1,
} from "../foreground-agent-accepted-execution.ts";
import {
  destroyPreparedTaskAccessManifestChain,
  assertTaskAccessRewrapSigners,
  exactTaskHumanSignerKeys,
  prepareTaskAccessManifestChain,
  taskHumanSignerCoordinate,
} from "./task-access-manifest-read.ts";

const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const SIGNED_REQUEST_TTL_MS = 30_000;

export interface VaultHumanTaskDeviceContentInputV1 {
  readonly crypto: LatticeCrypto;
  readonly vault: ClientProfileVault;
  readonly coordinates: ClientProfileCoordinates;
  readonly subjectHumanId: string;
  readonly now: () => number;
  readonly resolveDeviceAdmissionStatus: () => Promise<DeviceAdmissionStatus>;
  readonly resolveTrustedIssuingDevicePublicKey?:
    ResolveTrustedObjectAccessEvidenceIssuerV4;
  readonly accessAnchors: Readonly<{
    load(objectId: string): Promise<TrustedMinimumObjectAccessHead | null>;
    advance(input: Readonly<{
      expected: TrustedMinimumObjectAccessHead | null;
      next: TrustedMinimumObjectAccessHead;
    }>): Promise<boolean>;
  }>;
  readonly namespaceAuthority: NamespaceAuthorityClient;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function toBase64url(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function fromBase64url(label: string, value: string): Uint8Array {
  if (!BASE64URL.test(value) || value.length % 4 === 1) {
    throw new TypeError(`${label} is not canonical base64url`);
  }
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (toBase64url(bytes) !== value) {
    bytes.fill(0);
    throw new TypeError(`${label} is not canonical base64url`);
  }
  return bytes;
}

type TaskReadAuthorityV1 =
  import("@nautilo/api-client/browser").ProtectedTaskDefinitionReadReadyEnvelopeV1[
    "readAuthority"
  ];

function wipeNamespaceAuthority(authority: NamespaceGenerationAuthority): void {
  for (const entry of authority.retainedGenerations) {
    entry.headDigest.fill(0);
    entry.publicationDigest.fill(0);
    entry.publicationSetDigest.fill(0);
    entry.audienceFingerprint.fill(0);
  }
}

/**
 * Opens an exact Task Namespace generation through canonical Domain V2
 * authority. The complete retained set fences today's authority while the
 * callback selects the historical generation named by the object envelope.
 */
export async function withVaultHumanTaskReadAuthorityV1<Value>(input: Readonly<{
  dependencies: Pick<VaultHumanTaskDeviceContentInputV1,
    | "coordinates"
    | "namespaceAuthority"
    | "resolveDeviceAdmissionStatus"
    | "subjectHumanId"
  >;
  authority: TaskReadAuthorityV1;
  namespaceId: string;
  generation: number;
  accessRevision: number;
  operation(generationKey: Uint8Array): Promise<Value> | Value;
}>): Promise<Value> {
  const authority = input.authority;
  if (
    authority.namespaceId !== input.namespaceId
    || authority.sourceRoomId.length === 0
    || authority.retainedGenerations.length === 0
    || authority.retainedGenerations.at(-1)?.generation
      !== authority.currentGeneration
    || authority.retainedGenerations.some((entry, index, entries) =>
      entry.generation < 0
      || entry.accessRevision < 0
      || index > 0 && entries[index - 1]!.generation >= entry.generation
    )
  ) throw new ClassifiedDataOperationError(
    "integrity", "Protected Task Namespace read authority is invalid",
  );
  const selected = authority.retainedGenerations.find((entry) =>
    entry.generation === input.generation
    && entry.accessRevision === input.accessRevision
  );
  if (selected === undefined) throw new ClassifiedDataOperationError(
    "integrity", "Protected Task Namespace read authority was substituted",
  );
  const decodedEntries: Array<
    NamespaceGenerationAuthority["retainedGenerations"][number]
  > = [];
  try {
    for (const entry of authority.retainedGenerations) {
      const headDigest = fromBase64url(
        "Protected Task Namespace head", entry.headDigestBase64url,
      );
      const publicationDigest = fromBase64url(
        "Protected Task Namespace publication", entry.publicationDigestBase64url,
      );
      const publicationSetDigest = fromBase64url(
        "Protected Task Namespace publication set",
        entry.publicationSetDigestBase64url,
      );
      const audienceFingerprint = fromBase64url(
        "Protected Task Namespace audience", entry.audienceFingerprintBase64url,
      );
      if ([headDigest, publicationDigest, publicationSetDigest, audienceFingerprint]
        .some((digest) => digest.length !== 32)) {
        headDigest.fill(0);
        publicationDigest.fill(0);
        publicationSetDigest.fill(0);
        audienceFingerprint.fill(0);
        throw new TypeError("Protected Task Namespace authority digest is invalid");
      }
      decodedEntries.push(Object.freeze({
        generation: entry.generation,
        accessRevision: entry.accessRevision,
        headDigest,
        publicationDigest,
        publicationSetDigest,
        audienceFingerprint,
      }));
    }
  } catch (cause) {
    for (const entry of decodedEntries) {
      entry.headDigest.fill(0);
      entry.publicationDigest.fill(0);
      entry.publicationSetDigest.fill(0);
      entry.audienceFingerprint.fill(0);
    }
    throw new ClassifiedDataOperationError(
      "integrity", "Protected Task Namespace read authority is invalid", { cause },
    );
  }
  const decoded: NamespaceGenerationAuthority = Object.freeze({
    namespaceId: authority.namespaceId,
    retainedGenerations: Object.freeze(decodedEntries),
  });
  try {
    const admission = await input.dependencies.resolveDeviceAdmissionStatus();
    if (
      admission.status !== "admitted"
      || admission.deviceId !== input.dependencies.coordinates.deviceId
    ) throw new ClassifiedDataOperationError(
      "key_waiting", "Protected Task device admission is unavailable",
    );
    if (input.dependencies.namespaceAuthority.withOpenedGenerations === undefined) {
      throw new ClassifiedDataOperationError(
      "key_waiting", "Protected Task Namespace authority is unavailable",
      );
    }
    type Selected = Readonly<{ status: "missing" }>
      | Readonly<{ status: "selected"; value: Value }>;
    const opened = await input.dependencies.namespaceAuthority
      .withOpenedGenerations<Selected>({
      sourceRoomId: authority.sourceRoomId,
      subjectHumanId: input.dependencies.subjectHumanId,
      deviceSigningKeyGeneration: admission.deviceGeneration,
      keyClass: "ai",
      authority: [decoded],
    }, async (entries) => {
      const exact = entries.find((entry) =>
        entry.namespaceId === input.namespaceId
        && entry.keyClass === "ai"
        && entry.generation === input.generation
        && entry.accessRevision === input.accessRevision
      );
      return exact === undefined
        ? Object.freeze({ status: "missing" as const })
        : Object.freeze({
            status: "selected" as const,
            value: await input.operation(exact.generationKey),
          });
    });
    if (opened.status !== "opened" || opened.value.status === "missing") {
      throw new ClassifiedDataOperationError(
        "key_waiting", "Protected Task Namespace key is unavailable",
      );
    }
    return opened.value.value;
  } catch (cause) {
    if (cause instanceof ClassifiedDataOperationError) throw cause;
    if (cause instanceof TypeError) throw new ClassifiedDataOperationError(
      "integrity", "Protected Task Namespace authority is invalid", { cause },
    );
    throw cause;
  } finally {
    wipeNamespaceAuthority(decoded);
  }
}

async function withProfile<Value>(
  input: VaultHumanTaskDeviceContentInputV1,
  operation: (
    profile: Awaited<ReturnType<typeof authenticateClientDeviceProfileV4>>,
    admission: Extract<DeviceAdmissionStatus, { status: "admitted" }>,
  ) => Promise<Value> | Value,
): Promise<Value> {
  await ensureVaultAvailable(input);
  const admission = await input.resolveDeviceAdmissionStatus();
  if (
    admission.status !== "admitted"
    || admission.deviceId !== input.coordinates.deviceId
    || admission.expiresAt <= input.now()
  ) {
    throw new ClassifiedDataOperationError(
      "key_waiting",
      "Protected Task device admission is unavailable",
    );
  }
  return input.vault.withOpenProfile(input.coordinates, async (profileBytes) => {
    const profile = await authenticateClientDeviceProfileV4({
      crypto: input.crypto,
      profileBytes,
      expectedDeviceId: input.coordinates.deviceId,
    });
    try {
      return await operation(profile, admission);
    } finally {
      destroyOpenedClientDeviceProfileV4(profile);
    }
  });
}

async function ensureVaultAvailable(
  input: VaultHumanTaskDeviceContentInputV1,
): Promise<void> {
  let availability = await input.vault.availability();
  if (availability.status === "locked") availability = await input.vault.unlock();
  if (availability.status !== "available") {
    throw new ClassifiedDataOperationError(
      "key_waiting",
      `Protected Task device custody is unavailable (${availability.status})`,
    );
  }
}

/** Vault-backed Task content preparation/opening shared by Browser and Electron. */
export function createVaultHumanTaskDeviceContentPortV1(
  dependencies: VaultHumanTaskDeviceContentInputV1,
): HumanTaskDeviceContentPortV1 {
  const prepare = async (
    operation: "create" | "update",
    input: Parameters<HumanTaskDeviceContentPortV1["prepareCreate"]>[0]
      | Parameters<HumanTaskDeviceContentPortV1["prepareUpdate"]>[0],
    representation: "protected" | "dual",
  ): Promise<ProtectedTaskPreparedCreateRequestV1
    | ProtectedTaskPreparedUpdateRequestV1
    | DualTaskPreparedCreateRequestV1
    | DualTaskPreparedUpdateRequestV1> => withProfile(
      dependencies,
      async (profileV4) => {
    const profile = profileV4.baseProfile.baseProfile;
    const { plan } = input;
    const now = dependencies.now();
    if (plan.authority.requesterHumanId !== dependencies.subjectHumanId) {
      throw new ClassifiedDataOperationError(
        "authority",
        "Protected Task publication authority belongs to another Human",
      );
    }
    const cryptoObjectId = deriveTaskContentCryptoObjectIdV1({
      kind: "definition",
      taskId: plan.taskId,
      contentRevision: plan.nextContentRevision,
    });
    let plaintext: Uint8Array | undefined;
    let dek: Uint8Array | undefined;
    let payloadBytes: Uint8Array | undefined;
    let envelopeBytes: Uint8Array | undefined;
    let manifestBytes: Uint8Array | undefined;
    let signedBytes: Uint8Array | undefined;
    let planDigest: Uint8Array | undefined;
    let bindingHash: Uint8Array | undefined;
    let operationalFieldsDigest: Uint8Array | undefined;
    try {
      plaintext = encodeTaskDefinitionContent(input.payload);
      const encrypted = encryptObjectPayload(dependencies.crypto, {
        objectId: objectId(cryptoObjectId),
        keyClass: "ai",
        objectType: TASK_DEFINITION_OBJECT_TYPE_V1,
        createdAt: unixTimestamp(now),
      }, plaintext);
      dek = encrypted.dek;
      payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
      bindingHash = fromBase64url(
        "Protected Task Namespace binding hash",
        plan.authority.bindingHashBase64url,
      );
      envelopeBytes = await withClientNamespaceKeyring({
        profile,
        namespaceId: plan.authority.namespaceId,
        keyClass: "ai",
        requiredAccessRevision: plan.authority.expectedAccessRevision,
        requiredGeneration: plan.authority.keyGeneration,
        operation: (keyring) => {
          if (
            keyring.domainId !== plan.authority.domainId
            || keyring.accessRevision !== plan.authority.expectedAccessRevision
            || keyring.currentGeneration !== plan.authority.keyGeneration
            || !equalBytes(keyring.bindingHash, bindingHash!)
          ) throw new ClassifiedDataOperationError(
            "stale",
            "Protected Task Namespace authority changed",
          );
          const generation = keyring.generations.find((entry) =>
            entry.generation === plan.authority.keyGeneration
          );
          if (generation === undefined) throw new ClassifiedDataOperationError(
            "key_waiting",
            "Protected Task Namespace key is unavailable",
          );
          return encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespace(
            dependencies.crypto,
            generation.key,
            {
              objectId: objectId(cryptoObjectId),
              namespaceId: namespaceId(plan.authority.namespaceId),
              keyClass: "ai",
              keyGeneration: namespaceGeneration(generation.generation),
              bindingRevisionAtWrap: accessRevision(keyring.accessRevision),
            },
            dek!,
          ));
        },
      });
      const access = prepareHumanObjectAccessManifestGenesisSet(
        dependencies.crypto,
        {
          objectId: objectId(cryptoObjectId),
          payloadHash: dependencies.crypto.hash(payloadBytes),
          envelopeBytes: [envelopeBytes],
          sourceAuthorized: true,
          targetAuthorized: true,
          subjectHumanId: humanId(dependencies.subjectHumanId),
          committerDeviceId: cryptoDeviceId(profile.deviceId),
          hostAuthorizationRevision: authorizationRevision(
            profile.trustedHostAuthorizationRevision,
          ),
          committerSigningPublicKey: profile.signingPublicKey,
          committerSigningPrivateKey: profile.signingPrivateKey,
        },
      );
      manifestBytes = access.manifestBytes;
      planDigest = fromBase64url("Protected Task plan digest", plan.planDigestBase64url);
      operationalFieldsDigest = representation === "dual"
        ? fingerprintTaskDualPublicationFieldsV1(
            operation,
            input.task,
            plaintext,
          )
        : fingerprintTaskOperationalFieldsV1(operation, input.task);
      const signed = prepareHumanTaskPublicationRequest(dependencies.crypto, {
        operation,
        operationId: plan.operationId,
        taskId: plan.taskId,
        cryptoObjectId,
        expectedContentRevision: plan.expectedContentRevision,
        nextContentRevision: plan.nextContentRevision,
        expectedCryptoAccessRevision: plan.expectedCryptoAccessRevision,
        resultCryptoAccessRevision: 0,
        planDigest,
        operationalFieldsDigest,
        subjectHumanId: plan.authority.requesterHumanId,
        committerDeviceId: profile.deviceId,
        hostAuthorizationRevision: profile.trustedHostAuthorizationRevision,
        namespaceId: plan.authority.namespaceId,
        domainId: plan.authority.domainId,
        expectedNamespaceAccessRevision: plan.authority.expectedAccessRevision,
        expectedPolicyRevision: plan.authority.expectedPolicyRevision,
        bindingHash,
        keyGeneration: plan.authority.keyGeneration,
        payloadHash: dependencies.crypto.hash(payloadBytes),
        manifestHash: dependencies.crypto.hash(manifestBytes),
        envelopeHash: dependencies.crypto.hash(envelopeBytes),
        issuedAt: unixTimestamp(now),
        deadlineAt: unixTimestamp(now + SIGNED_REQUEST_TTL_MS),
        committerSigningPublicKey: profile.signingPublicKey,
        committerSigningPrivateKey: profile.signingPrivateKey,
      });
      signedBytes = signed.bytes;
      const prepared = {
        requestVersion: 1 as const,
        operation,
        operationId: plan.operationId,
        planDigestBase64url: plan.planDigestBase64url,
        taskId: plan.taskId,
        expectedContentRevision: plan.expectedContentRevision,
        nextContentRevision: plan.nextContentRevision,
        expectedCryptoAccessRevision: plan.expectedCryptoAccessRevision,
        resultCryptoAccessRevision: 0 as const,
        cryptoObjectId,
        payloadVersion: 1 as const,
        requiredNamespaceIds: [plan.authority.namespaceId] as [string],
        encryptedPayloadBytesBase64url: toBase64url(payloadBytes),
        accessManifestBytesBase64url: toBase64url(manifestBytes),
        namespaceEnvelopes: [{
          namespaceId: plan.authority.namespaceId,
          envelopeBytesBase64url: toBase64url(envelopeBytes),
        }] as [{ namespaceId: string; envelopeBytesBase64url: string }],
        signedPublicationRequestBytesBase64url: toBase64url(signedBytes),
        task: input.task,
      };
      return Object.freeze(representation === "dual"
        ? {
            ...prepared,
            representation: "dual" as const,
            ordinaryPayloadBytesBase64url: toBase64url(plaintext),
          }
        : prepared) as ProtectedTaskPreparedCreateRequestV1
          | ProtectedTaskPreparedUpdateRequestV1
          | DualTaskPreparedCreateRequestV1
          | DualTaskPreparedUpdateRequestV1;
    } finally {
      plaintext?.fill(0);
      dek?.fill(0);
      payloadBytes?.fill(0);
      envelopeBytes?.fill(0);
      manifestBytes?.fill(0);
      signedBytes?.fill(0);
      planDigest?.fill(0);
      bindingHash?.fill(0);
      operationalFieldsDigest?.fill(0);
    }
    },
  );

  return Object.freeze({
    prepareCreate: async (
      input: Parameters<HumanTaskDeviceContentPortV1["prepareCreate"]>[0],
    ) => prepare("create", input, "protected") as Promise<ProtectedTaskPreparedCreateRequestV1>,
    prepareUpdate: async (
      input: Parameters<HumanTaskDeviceContentPortV1["prepareUpdate"]>[0],
    ) => prepare("update", input, "protected") as Promise<ProtectedTaskPreparedUpdateRequestV1>,
    prepareDualCreate: async (
      input: Parameters<HumanTaskDeviceContentPortV1["prepareDualCreate"]>[0],
    ) => prepare("create", input, "dual") as Promise<DualTaskPreparedCreateRequestV1>,
    prepareDualUpdate: async (
      input: Parameters<HumanTaskDeviceContentPortV1["prepareDualUpdate"]>[0],
    ) => prepare("update", input, "dual") as Promise<DualTaskPreparedUpdateRequestV1>,
    openExact: async (input: Parameters<HumanTaskDeviceContentPortV1["openExact"]>[0]) => {
      const envelope = input.envelope;
      let historicalRepair = envelope.historicalRepair;
      if (historicalRepair !== undefined) {
        try {
          const parsed = parseTaskHistoricalRepairProvenanceV1(historicalRepair);
          if (parsed.version !== 2) throw new TypeError("unsupported version");
          historicalRepair = parsed;
          const historicalSourceDigest = Uint8Array.from(
            parsed.sourceDigest.match(/../gu)!,
            byte => Number.parseInt(byte, 16),
          );
          try {
            if (deriveTaskHistoricalContentCryptoObjectIdV1({
              coordinate: {
                kind: "definition",
                taskId: envelope.taskId,
                contentRevision: envelope.contentRevision,
              },
              namespaceId: envelope.namespaceId,
              sourceDigest: historicalSourceDigest,
            }) !== input.reference.objectId) {
              throw new TypeError("historical object substitution");
            }
          } finally {
            historicalSourceDigest.fill(0);
          }
        } catch (cause) {
          throw new ClassifiedDataOperationError(
            "integrity", "Protected Task historical definition metadata is invalid",
            { cause },
          );
        }
      }
      if (envelope.accessManifestProofBytes.length
        !== input.reference.cryptoAccessRevision) {
        throw new ClassifiedDataOperationError(
          "integrity", "Protected Task access history is incomplete",
        );
      }
      await ensureVaultAvailable(dependencies);
      let foregroundKeys: Map<string, Uint8Array> | undefined;
      const publications = envelope.signerEvidence.filter(
        (entry): entry is ObjectAccessSignerEvidenceTransportV1 =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry)
          && (entry as { kind?: unknown }).kind === "agent_runtime_publication",
      );
      if (publications.length > 0) {
        try {
          await ingestObjectAccessSignerEvidenceV4({
            crypto: dependencies.crypto,
            vault: dependencies.vault,
            coordinates: dependencies.coordinates,
            evidence: publications,
            ...(dependencies.resolveTrustedIssuingDevicePublicKey === undefined
              ? {}
              : { resolveTrustedIssuingDevicePublicKey:
                  dependencies.resolveTrustedIssuingDevicePublicKey }),
            createStageId: () => `task-definition-signer:${input.reference.objectId}:${input.reference.cryptoAccessRevision}`,
          });
        } catch (cause) {
          throw new ClassifiedDataOperationError(
            "key_waiting",
            "Protected Task Agent signer authority is unavailable",
            { cause },
          );
        }
      }
      let retainedAnchor: TrustedMinimumObjectAccessHead | null;
      let result: Readonly<{
        nextAnchor: TrustedMinimumObjectAccessHead;
      }>;
      try {
      retainedAnchor = await dependencies.accessAnchors.load(
        input.reference.objectId,
      );
      result = await withProfile(dependencies, (profileV4) => {
      let canonicalPayload: Uint8Array | undefined;
      let canonicalManifest: Uint8Array | undefined;
      let canonicalEnvelope: Uint8Array | undefined;
      let payloadHash: Uint8Array | undefined;
      let envelopeHash: Uint8Array | undefined;
      let humanKeys: Map<string, Uint8Array> | undefined;
      let prepared: ReturnType<typeof prepareTaskAccessManifestChain> | undefined;
      let crossAgentGenesisPrincipal: string | undefined;
      try {
        const payload = decodeEncryptedPayloadV2(envelope.encryptedPayloadBytes);
        const manifest = decodeObjectAccessManifestV5(envelope.accessManifestBytes);
        const namespaceEnvelope = decodeNamespaceObjectEnvelopeV2(
          envelope.namespaceEnvelopeBytes,
        );
        canonicalPayload = encodeEncryptedPayloadV2(payload);
        canonicalManifest = encodeObjectAccessManifestV5(manifest);
        canonicalEnvelope = encodeNamespaceObjectEnvelopeV2(namespaceEnvelope);
        payloadHash = dependencies.crypto.hash(envelope.encryptedPayloadBytes);
        envelopeHash = dependencies.crypto.hash(envelope.namespaceEnvelopeBytes);
        if (
          !equalBytes(canonicalPayload, envelope.encryptedPayloadBytes)
          || !equalBytes(canonicalManifest, envelope.accessManifestBytes)
          || !equalBytes(canonicalEnvelope, envelope.namespaceEnvelopeBytes)
          || payload.context.objectId !== input.reference.objectId
          || payload.context.objectType !== TASK_DEFINITION_OBJECT_TYPE_V1
          || payload.context.keyClass !== "ai"
          || manifest.objectId !== input.reference.objectId
          || manifest.accessRevision !== input.reference.cryptoAccessRevision
          || !equalBytes(manifest.payloadHash, payloadHash)
          || namespaceEnvelope.context.objectId !== input.reference.objectId
          || namespaceEnvelope.context.namespaceId !== envelope.namespaceId
          || namespaceEnvelope.context.keyClass !== "ai"
          || manifest.envelopeHashes.length !== 1
          || !equalBytes(manifest.envelopeHashes[0]!, envelopeHash)
        ) throw new ClassifiedDataOperationError(
          "integrity",
          "Protected Task ciphertext coordinates are invalid",
        );
        const own = profileV4.baseProfile.baseProfile;
        prepared = prepareTaskAccessManifestChain({
          crypto: dependencies.crypto,
          objectId: input.reference.objectId,
          payloadHash,
          headManifestBytes: envelope.accessManifestBytes,
          proofManifestBytes: envelope.accessManifestProofBytes,
          retained: retainedAnchor,
        });
        const genesis = decodeObjectAccessManifestV5(prepared.genesisManifestBytes);
        try {
          if (historicalRepair !== undefined) {
            const actual = dependencies.crypto.hash(prepared.genesisManifestBytes);
            const expected = Uint8Array.from(
              historicalRepair.genesisManifestHash.match(/../gu)!,
              byte => Number.parseInt(byte, 16),
            );
            try {
              if (genesis.signer.kind !== "human_device"
                || genesis.signer.subjectHumanId !== dependencies.subjectHumanId
                || genesis.signer.committerDeviceId
                  !== historicalRepair.publisherDeviceId
                || !equalBytes(actual, expected)) {
                throw new TypeError("Task definition historical genesis was substituted");
              }
            } finally {
              actual.fill(0);
              expected.fill(0);
            }
          } else if (genesis.signer.kind === "agent_runtime") {
            if (input.expectedAgentId === undefined) {
              throw new TypeError("Task definition Agent genesis was substituted");
            }
            if (genesis.signer.agentId !== input.expectedAgentId) {
              crossAgentGenesisPrincipal = foregroundAgentSignerPrincipalKeyV1(
                genesis.signer,
              );
            }
          } else if (genesis.signer.kind !== "human_device"
            || genesis.signer.subjectHumanId !== dependencies.subjectHumanId) {
            throw new TypeError("Task definition Human genesis was substituted");
          }
        } finally {
          genesis.payloadHash.fill(0);
          genesis.previousManifestHash?.fill(0);
          genesis.envelopeHashes.forEach(hash => hash.fill(0));
          genesis.signerAuthorizationHash?.fill(0);
          genesis.signature.fill(0);
        }
        assertTaskAccessRewrapSigners(
          prepared.fullChain,
          dependencies.subjectHumanId,
        );
        foregroundKeys = exactForegroundAgentSignerKeysV1({
          crypto: dependencies.crypto,
          evidence: envelope.signerEvidence,
          manifestBytes: prepared.fullChain,
          ...(input.expectedAgentId === undefined
            ? {} : { expectedAgentId: input.expectedAgentId }),
          expectedDefinitionAuthorHumanId: dependencies.subjectHumanId,
        });
        if (crossAgentGenesisPrincipal !== undefined
          && !foregroundKeys.has(crossAgentGenesisPrincipal)) {
          throw new TypeError("Task definition Agent genesis was substituted");
        }
        humanKeys = exactTaskHumanSignerKeys({
          evidence: envelope.signerEvidence,
          chain: prepared.fullChain,
          expectedHumanId: dependencies.subjectHumanId,
        });
        withClientObjectAccessSignerResolversV4({
          crypto: dependencies.crypto,
          profile: profileV4,
          operation: resolvers => verifyCommonObjectAccessManifestChain(
            dependencies.crypto,
            {
              manifestBytes: envelope.accessManifestBytes,
              proof: prepared!.proof,
              trustedMinimumHead: prepared!.trustedMinimumHead,
              resolveHistoricalHumanDeviceSigningPublicKey: context => {
                const evidenceKey = humanKeys!.get(taskHumanSignerCoordinate({
                  subjectHumanId: context.subjectHumanId,
                  committerDeviceId: context.committerDeviceId,
                  hostAuthorizationRevision: context.hostAuthorizationRevision,
                }));
                if (evidenceKey === undefined) return null;
                const trusted = context.committerDeviceId === own.deviceId
                  && context.subjectHumanId === dependencies.subjectHumanId
                  && context.hostAuthorizationRevision
                    <= own.trustedHostAuthorizationRevision
                  ? own.signingPublicKey
                  : resolvers.resolveHistoricalHumanDeviceSigningPublicKey({
                      humanId: context.subjectHumanId,
                      deviceId: context.committerDeviceId,
                    });
                if (trusted === null || trusted === undefined) {
                  throw new ClassifiedDataOperationError(
                    "key_waiting", "Protected Task signer history is unavailable",
                  );
                }
                if (!equalBytes(trusted, evidenceKey)) {
                  throw new TypeError("Protected Task Human signer evidence is untrusted");
                }
                return evidenceKey;
              },
              resolveAgentRuntimeSignerPublicKey: principal =>
                foregroundKeys!.get(foregroundAgentSignerPrincipalKeyV1(principal))
                ?? resolvers.resolveAgentRuntimeSignerPublicKey(principal),
              resolveProcessorSignerAuthorizationBytes: () => null,
              resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
            },
          ),
        });
        return Object.freeze({ nextAnchor: Object.freeze({
          ...prepared.nextAnchor,
          payloadHash: Uint8Array.from(prepared.nextAnchor.payloadHash),
          manifestHash: Uint8Array.from(prepared.nextAnchor.manifestHash),
        }) });
      } catch (error) {
        if (error instanceof ClassifiedDataOperationError) throw error;
        throw new ClassifiedDataOperationError(
          "integrity",
          "Protected Task content could not be authenticated",
          { cause: error },
        );
      } finally {
        canonicalPayload?.fill(0);
        canonicalManifest?.fill(0);
        canonicalEnvelope?.fill(0);
        payloadHash?.fill(0);
        envelopeHash?.fill(0);
        humanKeys?.forEach(key => key.fill(0));
        if (prepared !== undefined) {
          destroyPreparedTaskAccessManifestChain(prepared, retainedAnchor);
        }
      }
      });
      } finally {
        foregroundKeys?.forEach(key => key.fill(0));
      }
      let payload: ReturnType<typeof decodeEncryptedPayloadV2> | undefined;
      let namespaceEnvelope: ReturnType<typeof decodeNamespaceObjectEnvelopeV2>
        | undefined;
      let plaintext: Uint8Array;
      try {
        payload = decodeEncryptedPayloadV2(envelope.encryptedPayloadBytes);
        namespaceEnvelope = decodeNamespaceObjectEnvelopeV2(
          envelope.namespaceEnvelopeBytes,
        );
        plaintext = await withVaultHumanTaskReadAuthorityV1({
          dependencies,
          authority: envelope.readAuthority,
          namespaceId: envelope.namespaceId,
          generation: namespaceEnvelope.context.keyGeneration,
          accessRevision: namespaceEnvelope.context.bindingRevisionAtWrap,
          operation: (generationKey) => {
            const opened = decryptObjectThroughNamespace(
              dependencies.crypto,
              generationKey,
              namespaceEnvelope!,
              payload!,
            );
            if (opened === null) throw new TypeError(
              "Protected Task ciphertext authentication failed",
            );
            return opened;
          },
        });
      } catch (error) {
        result.nextAnchor.payloadHash.fill(0);
        result.nextAnchor.manifestHash.fill(0);
        if (error instanceof ClassifiedDataOperationError) throw error;
        throw new ClassifiedDataOperationError(
          "integrity", "Protected Task content could not be decrypted", { cause: error },
        );
      } finally {
        payload?.ciphertext.fill(0);
        namespaceEnvelope?.wrappedDek.fill(0);
      }
      let currentAnchor: TrustedMinimumObjectAccessHead | null = null;
      try {
        const advanced = await dependencies.accessAnchors.advance({
          expected: retainedAnchor,
          next: result.nextAnchor,
        });
        if (!advanced) {
          currentAnchor = await dependencies.accessAnchors.load(
            result.nextAnchor.objectId,
          );
          if (
            currentAnchor === null
            || currentAnchor.objectId !== result.nextAnchor.objectId
            || currentAnchor.accessRevision !== result.nextAnchor.accessRevision
            || !equalBytes(
              currentAnchor.payloadHash,
              result.nextAnchor.payloadHash,
            )
            || !equalBytes(
              currentAnchor.manifestHash,
              result.nextAnchor.manifestHash,
            )
          ) {
            throw new ClassifiedDataOperationError(
              "stale",
              "Protected Task trusted access anchor changed concurrently",
            );
          }
        }
        return plaintext;
      } catch (error) {
        plaintext.fill(0);
        throw error;
      } finally {
        currentAnchor?.payloadHash.fill(0);
        currentAnchor?.manifestHash.fill(0);
        result.nextAnchor.payloadHash.fill(0);
        result.nextAnchor.manifestHash.fill(0);
      }
    },
  });
}
