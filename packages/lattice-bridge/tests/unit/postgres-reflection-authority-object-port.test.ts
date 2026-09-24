import { describe, expect, test } from "bun:test";
import type {PostgresJsBridgeRow, PostgresJsBridgeScalar} from "@nautilo/db";
import {
  LatticeCrypto,
  ProcessorTransformRecipientRegistry,
  accessRevision,
  authorizationRevision,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
  createCurrentCommonProcessorObjectAccessManifest, createCommonHumanObjectAccessManifest, createCommonAgentObjectAccessManifest,
  agentId, agentRuntimeGeneration, humanId, cryptoDeviceId, deriveAgentRuntimeObjectSignerPublic,
} from "@nautilo/lattice-crypto";
import {encodeMessagePayloadV2} from "../../src/message/message-payload-v2.ts";
import { encodeRecordPayloadV1 } from "@nautilo/reflection/payload";
import { seededRng } from "@nautilo/lattice-crypto/testing";
import {
  createBackgroundAuthorizationResponseV2,
  decodeBackgroundAuthorizationResponseV2,
  encodeBackgroundWorkDescriptorV2,
  reflectionAuthorityReconciliationFingerprintV2,
  verifyHistoricalProcessorSignerAuthorizationV2,
  withOpenedReflectionBackgroundAuthorizationV2,
  type ReflectionAuthorityReconciliationBindingV2,
  type BackgroundReflectionWorkDescriptorV2,
} from "@nautilo/lattice-crypto/background";
import {
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV5,
} from "@nautilo/lattice-crypto/wire";
import {
  encryptObjectPayload,
  wrapObjectDekForNamespace,
} from "@nautilo/lattice-crypto";

import {readPostgresReflectionAuthoritySavedOutput, validatePostgresReflectionAuthorityRecovery} from "../../src/server/reflection/postgres-authority-recovery.ts";
import { createPostgresReflectionAuthorityObjectPort, createPostgresReflectionSemanticObjectPort } from "../../src/server/reflection/postgres-authority-object-port.ts";
import { PostgresJournalCryptoTombstoneRepository } from "../../src/server/journal/postgres-journal-crypto-tombstone.ts";
import { readVerifiedDeviceWrappedAgentObject } from "../../src/server/memory/postgres-memory-crypto-completion.ts";
import {
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
  type CryptoPostgresExecutor,
} from "../../src/server/storage/postgres-lattice-storage.ts";
import type {
  DatabaseRow,
  DatabaseScalar,
} from "../../src/server/storage/postgres-record-codecs.ts";

const NOW = 1_700_000_000_001;
const EXPIRES = 1_700_000_300_000;

async function rejects(work: Promise<unknown>, message: string): Promise<void> {
  const error = await work.then(() => null, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  if (error instanceof Error) expect(error.message).toContain(message);
}

type StoredObject = {
  object_id: string;
  payload_hash: Uint8Array;
  payload_bytes: Uint8Array;
};
type StoredManifest = {
  object_id: string;
  access_revision: number;
  manifest_hash: Uint8Array;
  previous_manifest_hash: Uint8Array | null;
  payload_hash: Uint8Array;
  manifest_bytes: Uint8Array;
};
type StoredEnvelope = {
  namespace_id: string;
  ordinal: number;
  envelope_hash: Uint8Array;
  envelope_bytes: Uint8Array;
};

async function fixture(sharedDomain: boolean, singleOutput = false) {
  const crypto = new LatticeCrypto(seededRng(sharedDomain ? 32_701 : 32_702));
  const device = crypto.generateSigningKeyPair();
  const registry = new ProcessorTransformRecipientRegistry({
    crypto,
    now: () => NOW,
  });
  const created = await registry.createAttempt({
    requestId: "request-1",
    workId: "work-1",
    namespaceId: "namespace-1",
    recipientGeneration: 0,
    recipientKeyId: "recipient-1",
    expiresAt: EXPIRES,
  });
  if (created.status !== "created") throw new Error("recipient unavailable");
  const namespaceKeys = new Map([
    ["namespace-1", crypto.randomBytes(32)],
    ["namespace-2", crypto.randomBytes(32)],
  ]);
  const authority = (index: number) => ({
    serverId: "server-1",
    roomId: `room-${index}`,
    namespaceId: `namespace-${index}`,
    namespaceAccessRevision: index + 1,
    namespaceKeyGeneration: index,
    namespaceHeadDigest: new Uint8Array(32).fill(10 + index),
    domainId: sharedDomain ? "domain-1" : `domain-${index}`,
    domainKeyGeneration: 3,
    domainAuthorizationRevision: 4,
    domainHeadDigest: new Uint8Array(32).fill(20 + (sharedDomain ? 1 : index)),
    bundleRevision: 5 + index,
    bundleDigest: new Uint8Array(32).fill(30 + index),
  });
  const descriptor: BackgroundReflectionWorkDescriptorV2 = {
    formatVersion: 2,
    requestId: "request-1",
    recipientGeneration: 0,
    workKind: "reflection.authority_reproject",
    workId: "work-1",
    anchorNamespaceId: "namespace-1",
    anchorDomainId: "domain-1",
    subject: {
      kind: "processor",
      processorKind: "reflection",
      processorVersion: 1,
    },
    operations: ["decrypt", "encrypt"],
    purpose: "record.reproject",
    source: {
      kind: "reflection_authority",
      recordRef: "record-1",
      sourceChangeGeneration: 4,
      projectionGeneration: 5,
      expectedRepresentationGeneration: 1,
      targetRepresentationGeneration: 2,
      fingerprint: new Uint8Array(32).fill(40),
    },
    namespaceRequirements: [
      { authority: authority(1), operations: singleOutput ? ["decrypt"] : ["decrypt", "encrypt"] },
      { authority: authority(2), operations: ["encrypt"] },
    ],
    policyRevision: 6,
    inputBindings: [{ objectId: "old-object", namespaceId: "namespace-1" }],
    outputSlots: [{
      objectId: "new-object",
      objectType: "nautilo.reflection.record.v1",
      createdAt: NOW - 1,
      namespaceIds: singleOutput ? ["namespace-2"] : ["namespace-1", "namespace-2"],
    }],
    maximumPlaintextBytes: 512_000,
    maximumCiphertextBytes: 1_024_000,
    recipientKeyId: "recipient-1",
    recipientPublicKey: created.attempt.recipientPublicKey,
    issuedAt: NOW - 1,
    notBefore: NOW - 1,
    expiresAt: EXPIRES,
    idempotencyId: "idempotency-1",
  };
  const issuer = {
    humanId: "human-1",
    deviceId: "device-1",
    deviceGeneration: 2,
    serverInstanceId: "instance-1",
    lineageGeneration: 3,
    epoch: 4,
    securityRevision: 57,
    headDigest: new Uint8Array(32).fill(50),
    signingPublicKeyHash: crypto.hash(device.publicKey),
  };
  const domainKeys = [...new Set(descriptor.namespaceRequirements.map(
    (entry) => entry.authority.domainId,
  ))].map((domainId) => ({ domainId, key: crypto.randomBytes(32) }));
  let descriptorBytes = encodeBackgroundWorkDescriptorV2(descriptor);
  let responseBytes = await createBackgroundAuthorizationResponseV2(crypto, {
    credentialId: "credential-1",
    descriptorBytes,
    issuer,
    issuerSigningPrivateKey: device.privateKey,
    domainKeys,
  });
  let response = decodeBackgroundAuthorizationResponseV2(responseBytes);
  let authorization = verifyHistoricalProcessorSignerAuthorizationV2(crypto, {
    authorizationBytes: response.signerAuthorizationBytes,
    resolveHistoricalIssuer: () => device.publicKey,
  });
  let certificate = authorization.certificate;
  const evidence: Record<string, DatabaseScalar> = {
    authorization_id: certificate.credentialId,
    format_version: 2,
    request_id: descriptor.requestId,
    recipient_generation: 0,
    processor_kind: "reflection",
    processor_version: 1,
    work_id: descriptor.workId,
    namespace_id: descriptor.anchorNamespaceId,
    domain_id: descriptor.anchorDomainId,
    domain_epoch: null,
    namespace_access_revision: 2,
    policy_revision: descriptor.policyRevision,
    processor_authorization_revision: null,
    issuing_human_id: issuer.humanId,
    issuing_device_id: issuer.deviceId,
    issuing_device_authorization_revision: issuer.securityRevision,
    issuer_signing_public_key_hash: issuer.signingPublicKeyHash,
    signer_key_id: certificate.signer.signerKeyId,
    signer_public_key: certificate.signerPublicKey,
    work_descriptor_hash: certificate.descriptorHash,
    work_descriptor_bytes: certificate.descriptorBytes,
    authorization_hash: authorization.authorizationHash,
    credential_hash: certificate.credentialHash,
    authorization_bytes: response.signerAuthorizationBytes,
    issued_at: new Date(descriptor.issuedAt),
    expires_at: new Date(descriptor.expiresAt),
    created_at: new Date(NOW),
  };
  const request: Record<string, DatabaseScalar> = {
    format_version: 2,
    state: "running",
    request_id: descriptor.requestId,
    idempotency_key: descriptor.idempotencyId,
    claim_id: "claim-1",
    recipient_generation: 0,
    work_id: descriptor.workId,
    work_kind: descriptor.workKind,
    purpose: descriptor.purpose,
    namespace_id: descriptor.anchorNamespaceId,
    domain_id: descriptor.anchorDomainId,
    credential_subject_kind: "processor",
    processor_kind: "reflection",
    processor_version: 1,
    processor_authorization_revision: null,
    expected_domain_epoch: null,
    agent_id: null,
    agent_runtime_generation: null,
    agent_authorization_revision: null,
    expected_namespace_access_revision: 2,
    expected_policy_revision: descriptor.policyRevision,
    descriptor_hash: certificate.descriptorHash,
    descriptor_bytes: certificate.descriptorBytes,
    accepted_response_hash: crypto.hash(responseBytes),
    accepted_response_kind: "processor",
    accepted_response_bytes: responseBytes,
    credential_id: certificate.credentialId,
    credential_hash: certificate.credentialHash,
    recipient_key_id: descriptor.recipientKeyId,
    recipient_public_key: descriptor.recipientPublicKey,
    recipient_expires_at: new Date(EXPIRES),
    issuing_human_id: issuer.humanId,
    issuing_device_id: issuer.deviceId,
    issuing_device_authorization_revision: issuer.securityRevision,
    issuer_signing_public_key_hash: issuer.signingPublicKeyHash,
    authorization_expires_at: new Date(EXPIRES),
    claim_expires_at: new Date(NOW + 60_000),
    transform_commit_claim_id: null,
    transform_commit_descriptor_hash: null,
    transform_commit_recipient_generation: null,
    transform_commit_output_count: null,
    transform_committed_at: null,
  };

  const plaintext = encodeRecordPayloadV1({
    formatVersion: 1,
    posture: "derived",
    observedContentFingerprint: "sha256:record-1",
    sourceOwnedKind: "journal_event:decision",
    observedLogicalObjectRef: "record-1",
    observedRevision: "revision-1",
    statement: "Same canonical Record bytes.",
    sourceDependencies: [],
    anchors: [{ kind: "room", anchorRef: "room-1", role: "origin" }],
    childRecordIds: [],
    producer: { producerRef: "organizer", policyVersion: "policy-1" },
    terminalAuthorityLeafHandles: ["leaf-1"],
  });
  const oldRecipient = await crypto.generateEncryptionKeyPair();
  const oldDescriptor = {
    ...descriptor,
    namespaceRequirements: [{authority: authority(1), operations: ["decrypt", "encrypt"] as const}, {authority: authority(2), operations: ["encrypt"] as const}],
    requestId: "old-request",
    workId: "old-work",
    recipientKeyId: "old-recipient",
    recipientPublicKey: oldRecipient.publicKey,
    inputBindings: [{ objectId: "seed-object", namespaceId: "namespace-1" }],
    outputSlots: [{
      objectId: "old-object",
      objectType: "nautilo.reflection.record.v1" as const,
      createdAt: NOW - 1,
      namespaceIds: ["namespace-1", "namespace-2"],
    }],
  };
  const oldDescriptorBytes = encodeBackgroundWorkDescriptorV2(oldDescriptor);
  const oldResponseBytes = await createBackgroundAuthorizationResponseV2(crypto, {
    credentialId: "old-credential",
    descriptorBytes: oldDescriptorBytes,
    issuer,
    issuerSigningPrivateKey: device.privateKey,
    domainKeys,
  });
  const oldResponse = decodeBackgroundAuthorizationResponseV2(oldResponseBytes);
  const oldAuthorization = verifyHistoricalProcessorSignerAuthorizationV2(crypto, {
    authorizationBytes: oldResponse.signerAuthorizationBytes,
    resolveHistoricalIssuer: () => device.publicKey,
  });
  const oldCertificate = oldAuthorization.certificate;
  const oldEvidence: Record<string, DatabaseScalar> = {
    ...evidence,
    authorization_id: oldCertificate.credentialId,
    request_id: oldDescriptor.requestId,
    work_id: oldDescriptor.workId,
    signer_key_id: oldCertificate.signer.signerKeyId,
    signer_public_key: oldCertificate.signerPublicKey,
    work_descriptor_hash: oldCertificate.descriptorHash,
    work_descriptor_bytes: oldCertificate.descriptorBytes,
    authorization_hash: oldAuthorization.authorizationHash,
    credential_hash: oldCertificate.credentialHash,
    authorization_bytes: oldResponse.signerAuthorizationBytes,
  };
  const evidenceRows = [evidence, oldEvidence];
  const old = await withOpenedReflectionBackgroundAuthorizationV2(crypto, {
    responseBytes: oldResponseBytes,
    recipientPrivateKey: oldRecipient.privateKey,
    now: () => NOW,
    resolveCurrentIssuer: () => device.publicKey,
    use: ({ verified, signerPrivateKey }) => {
      const encrypted = encryptObjectPayload(crypto, {
        objectId: objectId("old-object"),
        keyClass: "ai",
        objectType: "nautilo.reflection.record.v1",
        createdAt: unixTimestamp(NOW - 1),
      }, plaintext);
      const envelope = wrapObjectDekForNamespace(
        crypto,
        namespaceKeys.get("namespace-1")!,
        {
          objectId: objectId("old-object"),
          namespaceId: namespaceId("namespace-1"),
          keyClass: "ai",
          keyGeneration: namespaceGeneration(1),
          bindingRevisionAtWrap: accessRevision(2),
        },
        encrypted.dek,
      );
      encrypted.dek.fill(0);
      const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
      const envelopeBytes = encodeNamespaceObjectEnvelopeV2(envelope);
      const manifest = createCurrentCommonProcessorObjectAccessManifest(crypto, {
        objectId: objectId("old-object"),
        payloadHash: crypto.hash(payloadBytes),
        accessRevision: accessRevision(0),
        previousManifestHash: null,
        envelopeHashes: [crypto.hash(envelopeBytes)],
        signer: verified.signer,
        signerAuthorizationHash: verified.signerAuthorizationHash,
        hostAuthorizationRevision: authorizationRevision(issuer.securityRevision),
      }, {
        signerPrivateKey,
        signerAuthorizationBytes: oldResponse.signerAuthorizationBytes,
        issuerSigningPublicKey: device.publicKey,
        now: NOW,
      });
      return { payloadBytes, envelopeBytes, manifestBytes: manifest.bytes };
    },
  });

  if (singleOutput) {
    Object.assign(descriptor, {source: {...descriptor.source, fingerprint: crypto.hash(new TextEncoder().encode(JSON.stringify([
      "nautilo/reflection/authority-source/v2", "record-1", 4, 5, 1, 2, "old-object", "namespace-1",
      Array.from(crypto.hash(old.manifestBytes)), ["namespace-1"], ["namespace-2"],
      [["namespace-1", "room-1", "access", ["human-1"]], ["namespace-2", "room-2", "access", ["human-1"]]],
    ])))}});
    descriptorBytes = encodeBackgroundWorkDescriptorV2(descriptor);
    responseBytes = await createBackgroundAuthorizationResponseV2(crypto, {credentialId: "credential-1", descriptorBytes,
      issuer, issuerSigningPrivateKey: device.privateKey, domainKeys});
    response = decodeBackgroundAuthorizationResponseV2(responseBytes);
    authorization = verifyHistoricalProcessorSignerAuthorizationV2(crypto, {authorizationBytes: response.signerAuthorizationBytes,
      resolveHistoricalIssuer: () => device.publicKey});
    certificate = authorization.certificate;
    Object.assign(evidence, {work_descriptor_hash: certificate.descriptorHash, work_descriptor_bytes: certificate.descriptorBytes,
      authorization_hash: authorization.authorizationHash, authorization_bytes: response.signerAuthorizationBytes,
      credential_hash: certificate.credentialHash, signer_key_id: certificate.signer.signerKeyId, signer_public_key: certificate.signerPublicKey});
    Object.assign(request, {descriptor_hash: certificate.descriptorHash, descriptor_bytes: certificate.descriptorBytes,
      accepted_response_hash: crypto.hash(responseBytes), accepted_response_bytes: responseBytes, credential_hash: certificate.credentialHash});
  }

  const objects = new Map<string, StoredObject>();
  const manifests = new Map<string, StoredManifest>();
  const envelopes = new Map<string, StoredEnvelope[]>();
  const heads = new Map<string, { object_id: string; access_revision: number; manifest_hash: Uint8Array }>();
  objects.set("old-object", {
    object_id: "old-object",
    payload_hash: crypto.hash(old.payloadBytes),
    payload_bytes: old.payloadBytes,
  });
  manifests.set("old-object:0", {
    object_id: "old-object",
    access_revision: 0,
    manifest_hash: crypto.hash(old.manifestBytes),
    previous_manifest_hash: null,
    payload_hash: crypto.hash(old.payloadBytes),
    manifest_bytes: old.manifestBytes,
  });
  envelopes.set("old-object:0", [{
    namespace_id: "namespace-1",
    ordinal: 0,
    envelope_hash: crypto.hash(old.envelopeBytes),
    envelope_bytes: old.envelopeBytes,
  }]);
  heads.set("old-object", {
    object_id: "old-object",
    access_revision: 0,
    manifest_hash: crypto.hash(old.manifestBytes),
  });

  const query = async <Row extends DatabaseRow>(
    sql: string,
    parameters: readonly DatabaseScalar[] = [],
  ): Promise<readonly Row[]> => {
    const normalized = sql.replaceAll('"', "").toLowerCase();
    const id = parameters[0] as string | undefined;
    if (normalized.includes("current_user::text")) {
      return [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }] as unknown as Row[];
    }
    if (normalized.includes("from processor_crypto_signer_authorizations")) {
      const wanted = parameters[0];
      const selected = evidenceRows.find((row) => {
        const hash = row["authorization_hash"];
        return (normalized.includes("join background_crypto_authorization_requests") && wanted === row["request_id"])
          || wanted === row["authorization_id"]
          || (wanted instanceof Uint8Array && hash instanceof Uint8Array
            && Buffer.from(wanted).equals(Buffer.from(hash)));
      });
      return structuredClone(selected === undefined ? [] : [selected]) as Row[];
    }
    if (normalized.includes("from human_crypto_devices")) {
      return structuredClone([{
        device_id: issuer.deviceId,
        human_id: issuer.humanId,
        device_generation: issuer.deviceGeneration,
        signing_public_key: device.publicKey,
        state: "revoked",
        revision: 1,
      }]) as unknown as Row[];
    }
    if (normalized.includes("from background_crypto_authorization_requests")) {
      return structuredClone([request]) as Row[];
    }
    if (normalized.includes("set transaction isolation level serializable")) {
      return [];
    }
    if (normalized.includes("pg_advisory_xact_lock")) return [];
    if (normalized.includes("from crypto_objects as object")
      && normalized.includes("for update of head")) {
      const object = objects.get(id!);
      const head = heads.get(id!);
      const genesis = manifests.get(`${id}:0`);
      const tombstone = manifests.get(`${id}:1`);
      if (object === undefined || head === undefined
        || genesis === undefined || tombstone === undefined) return [];
      return structuredClone([{
        object_id: object.object_id,
        object_payload_hash: object.payload_hash,
        head_access_revision: head.access_revision,
        head_manifest_hash: head.manifest_hash,
        genesis_manifest_hash: genesis.manifest_hash,
        genesis_payload_hash: genesis.payload_hash,
        genesis_manifest_bytes: genesis.manifest_bytes,
        tombstone_manifest_hash: tombstone.manifest_hash,
        tombstone_previous_hash: tombstone.previous_manifest_hash,
        tombstone_payload_hash: tombstone.payload_hash,
        tombstone_manifest_bytes: tombstone.manifest_bytes,
      }]) as unknown as Row[];
    }
    if (normalized.includes("join object_crypto_access_manifests")) {
      const head = heads.get(id!);
      const row = head === undefined
        ? undefined
        : manifests.get(`${id}:${head.access_revision}`);
      return structuredClone(row === undefined ? [] : [row]) as unknown as Row[];
    }
    if (normalized.includes("from crypto_objects")) {
      const row = objects.get(id!);
      return structuredClone(row === undefined ? [] : [row]) as unknown as Row[];
    }
    if (normalized.includes("from object_crypto_access_heads") && normalized.includes("join object_crypto_namespace_envelopes")) {
      return structuredClone([...(envelopes.get(`${id}:${heads.get(id!)?.access_revision ?? 0}`) ?? [])]
        .sort((a, b) => a.namespace_id.localeCompare(b.namespace_id)).map(entry => ({...entry, manifest_hash: heads.get(id!)?.manifest_hash}))) as unknown as Row[];
    }
    if (normalized.includes("from object_crypto_access_heads")) {
      const row = heads.get(id!);
      return structuredClone(row === undefined ? [] : [row]) as unknown as Row[];
    }
    if (normalized.includes("from object_crypto_namespace_envelopes")) {
      const revision = !normalized.includes("join object_crypto_access_heads")
        && typeof parameters[1] === "number"
        ? parameters[1]
        : heads.get(id!)?.access_revision ?? 0;
      return structuredClone(envelopes.get(`${id}:${revision}`) ?? []) as unknown as Row[];
    }
    if (normalized.includes("from object_crypto_access_manifests")) {
      const revision = typeof parameters[1] === "number"
        ? parameters[1]
        : heads.get(id!)?.access_revision ?? 0;
      const row = manifests.get(`${id}:${revision}`);
      return structuredClone(row === undefined ? [] : [row]) as unknown as Row[];
    }
    if (normalized.startsWith("insert into crypto_objects")) {
      objects.set(parameters[0] as string, {
        object_id: parameters[0] as string,
        payload_hash: structuredClone(parameters[1]) as Uint8Array,
        payload_bytes: structuredClone(parameters[2]) as Uint8Array,
      });
      return [];
    }
    if (normalized.startsWith("insert into object_crypto_access_manifests")) {
      const row: StoredManifest = {
        object_id: parameters[0] as string,
        access_revision: Number(parameters[1]),
        manifest_hash: structuredClone(parameters[2]) as Uint8Array,
        previous_manifest_hash: structuredClone(parameters[3]) as Uint8Array | null,
        payload_hash: structuredClone(parameters[4]) as Uint8Array,
        manifest_bytes: structuredClone(parameters[5]) as Uint8Array,
      };
      manifests.set(`${row.object_id}:${row.access_revision}`, row);
      return [];
    }
    if (normalized.startsWith("insert into object_crypto_namespace_envelopes")) {
      const rows: StoredEnvelope[] = [];
      for (let offset = 0; offset < parameters.length; offset += 6) {
        rows.push({
          namespace_id: parameters[offset + 2] as string,
          ordinal: Number(parameters[offset + 3]),
          envelope_hash: structuredClone(parameters[offset + 4]) as Uint8Array,
          envelope_bytes: structuredClone(parameters[offset + 5]) as Uint8Array,
        });
      }
      envelopes.set(
        `${String(parameters[0])}:${String(parameters[1])}`,
        rows,
      );
      return [];
    }
    if (normalized.startsWith("insert into object_crypto_access_heads")) {
      heads.set(parameters[0] as string, {
        object_id: parameters[0] as string,
        access_revision: Number(parameters[1]),
        manifest_hash: structuredClone(parameters[2]) as Uint8Array,
      });
      return [];
    }
    if (normalized.startsWith("update background_crypto_authorization_requests")) {
      Object.assign(request, {
        transform_commit_claim_id: request["claim_id"],
        transform_commit_descriptor_hash: request["descriptor_hash"],
        transform_commit_recipient_generation: request["recipient_generation"],
        transform_commit_output_count: parameters[Number(/transform_commit_output_count = \$(\d+)/u.exec(normalized)![1]) - 1],
        transform_committed_at: new Date(NOW + 2),
      });
      return [{ request_id: descriptor.requestId }] as unknown as Row[];
    }
    if (normalized.startsWith("update object_crypto_access_heads")) {
      const objectId = parameters.find((value) => value === "new-object");
      if (typeof objectId !== "string") return [];
      const tombstone = manifests.get(`${objectId}:1`)!;
      heads.set(objectId, {
        object_id: objectId,
        access_revision: 1,
        manifest_hash: tombstone.manifest_hash.slice(),
      });
      return [{ object_id: objectId }] as unknown as Row[];
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  const connection: CryptoPostgresConnection = {
    query,
    transaction: (use) => use({ query }),
  };
  const handle = await verifyCryptoPostgresHandle(connection);
  let denied = false;
  let authorityCalls = 0;
  const executor: CryptoPostgresExecutor = { query };
  const withCurrentAuthority = async <Value>({ use }: {
    use(held: { executor: CryptoPostgresExecutor; issuerSigningPublicKey: Uint8Array }): Promise<Value>;
  }): Promise<Value | null> => {
    authorityCalls += 1;
    if (denied) return null;
    // Postgres may return Buffer views. Authority owns and wipes this lease;
    // callers that retain a public key must make an independent byte copy.
    const leasedKey = Buffer.from(device.publicKey);
    try { return await use({ executor, issuerSigningPublicKey: leasedKey }); }
    finally { leasedKey.fill(0); }
  };
  const providerCalls: string[] = [];
  const snapshots = new Map(descriptor.namespaceRequirements.map(({ authority: value }) => [
    value.namespaceId,
    {
      status: "ready" as const,
      ...structuredClone(value),
      namespacePublicationDigest: new Uint8Array(32).fill(60),
      namespacePublicationSetDigest: new Uint8Array(32).fill(61),
      namespaceAudienceFingerprint: new Uint8Array(32).fill(62),
    },
  ]));
  const productAttachments: string[] = [];
  let skipAttachmentPermit = false;
  const domainKeyPort: Parameters<
    typeof createPostgresReflectionAuthorityObjectPort
  >[0]["domainKeys"] = {
    inspectForegroundNamespaceAuthority: async ({ namespaceId: selected }) => {
      providerCalls.push(`inspect:${selected}`);
      return structuredClone(snapshots.get(selected)!);
    },
    withOpenedForegroundNamespaceKey: async ({ authority: selected, use }) => {
      providerCalls.push(`open-key:${selected.namespaceId}`);
      return await use(namespaceKeys.get(selected.namespaceId)!);
    },
  };
  const attach = async ({ objectId: selected, authorizeCommit }: {
    objectId: string;
    authorizeCommit(): Promise<number>;
  }) => {
    providerCalls.push("attach");
    if (skipAttachmentPermit) return;
    await authorizeCommit();
    productAttachments.push(selected);
  };
  const adapter = createPostgresReflectionAuthorityObjectPort({
    handle,
    crypto,
    responseBytes,
    claimId: "claim-1",
    withCurrentAuthority,
    domainKeys: domainKeyPort,
    attach,
  });
  return {
    crypto,
    descriptor,
    responseBytes,
    response,
    request,
    evidence,
    device,
    plaintext,
    adapter,
    registry,
    providerCalls,
    productAttachments,
    authorityCalls: () => authorityCalls,
    deny: () => { denied = true; },
    skipAttachmentPermit: () => { skipAttachmentPermit = true; },
    resumeAttachmentPermit: () => { skipAttachmentPermit = false; },
    substituteNamespace: (selected: string) => {
      const current = snapshots.get(selected)!;
      snapshots.set(selected, { ...current, namespaceAccessRevision: 999 });
    },
    objects,
    manifests,
    envelopes,
    heads,
    handle,
    withCurrentAuthority,
    domainKeyPort,
    attach,
    issuer,
    domainKeys, namespaceKeys,
    installAttempt: (
      next: BackgroundReflectionWorkDescriptorV2,
      bytes: Uint8Array,
    ) => {
      const decoded = decodeBackgroundAuthorizationResponseV2(bytes);
      const verified = verifyHistoricalProcessorSignerAuthorizationV2(crypto, {
        authorizationBytes: decoded.signerAuthorizationBytes,
        resolveHistoricalIssuer: () => device.publicKey,
      });
      const nextCertificate = verified.certificate;
      evidenceRows.push({ ...evidence,
        authorization_id: nextCertificate.credentialId,
        request_id: next.requestId,
        recipient_generation: next.recipientGeneration,
        work_id: next.workId,
        work_descriptor_hash: nextCertificate.descriptorHash,
        work_descriptor_bytes: nextCertificate.descriptorBytes,
        signer_key_id: nextCertificate.signer.signerKeyId,
        signer_public_key: nextCertificate.signerPublicKey,
        authorization_hash: verified.authorizationHash,
        credential_hash: nextCertificate.credentialHash,
        authorization_bytes: decoded.signerAuthorizationBytes,
      });
      Object.assign(request, {
        request_id: next.requestId,
        idempotency_key: next.idempotencyId,
        claim_id: "claim-2",
        recipient_generation: next.recipientGeneration,
        work_id: next.workId,
        work_kind: next.workKind,
        purpose: next.purpose,
        descriptor_hash: nextCertificate.descriptorHash,
        descriptor_bytes: nextCertificate.descriptorBytes,
        accepted_response_hash: crypto.hash(bytes),
        accepted_response_bytes: bytes,
        credential_id: nextCertificate.credentialId,
        credential_hash: nextCertificate.credentialHash,
        recipient_key_id: next.recipientKeyId,
        recipient_public_key: next.recipientPublicKey,
        transform_commit_claim_id: null,
        transform_commit_descriptor_hash: null,
        transform_commit_recipient_generation: null,
        transform_commit_output_count: null,
        transform_committed_at: null,
      });
    },
  };
}

function runReflection(f: Awaited<ReturnType<typeof fixture>>) {
  return f.registry.runCurrentReflectionAuthority({
    requestId: f.descriptor.requestId,
    recipientGeneration: 0,
    recipientKeyId: f.descriptor.recipientKeyId,
    claimId: "claim-1",
    responseBytes: f.responseBytes,
    reflectionObjects: {
      ...f.adapter.objects,
      publishOutput: async (request) => {
        const manifest = decodeObjectAccessManifestV5(request.manifestBytes);
        const tombstone = decodeObjectAccessManifestV5(
          request.tombstoneManifestBytes,
        );
        expect(manifest.payloadHash).toEqual(f.crypto.hash(request.payloadBytes));
        expect(manifest.envelopeHashes.map((hash) => Buffer.from(hash).toString("hex")).sort())
          .toEqual(request.namespaceEnvelopes.map(
            (entry) => Buffer.from(f.crypto.hash(entry.envelopeBytes)).toString("hex"),
          ).sort());
        expect(tombstone.previousManifestHash).toEqual(
          f.crypto.hash(request.manifestBytes),
        );
        return f.adapter.objects.publishOutput(request);
      },
    },
    resolveCurrentIssuer: f.adapter.resolveCurrentIssuer,
    claims: { claimExactCredential: async () => "claimed" },
    signal: new AbortController().signal,
  });
}

describe("PostgreSQL Reflection authority object port", () => {
  test.each([true, false])(
    "publishes and reopens one verified ciphertext across shared Domains=%s",
    async (sharedDomain) => {
      const f = await fixture(sharedDomain);
      try {
        expect(await runReflection(f)).toEqual({ status: "executed" });
        expect(f.descriptor.namespaceRequirements).toHaveLength(2);
        expect(new Set(f.descriptor.namespaceRequirements.map(
          (entry) => entry.authority.domainId,
        )).size).toBe(sharedDomain ? 1 : 2);
        expect(f.objects.has("new-object")).toBe(true);
        const storedEnvelopes = f.envelopes.get("new-object:0")!;
        expect(storedEnvelopes.map(
          (entry) => entry.namespace_id,
        )).toEqual(["namespace-2", "namespace-1"]);
        expect(storedEnvelopes.map((entry) =>
          Buffer.from(entry.envelope_hash).toString("hex")))
          .toEqual(storedEnvelopes.map((entry) =>
            Buffer.from(entry.envelope_hash).toString("hex")).sort());
        expect(f.productAttachments).toEqual(["new-object"]);
      } finally {
        f.adapter.dispose();
        f.registry.close();
      }
    },
  );

  test("denied current authority never reaches Namespace or product callbacks", async () => {
    const f = await fixture(false);
    try {
      f.deny();
      expect(await f.adapter.resolveCurrentIssuer({
        descriptor: f.descriptor,
        descriptorHash: f.crypto.hash(encodeBackgroundWorkDescriptorV2(f.descriptor)),
        issuer: {
          humanId: "human-1",
          deviceId: "device-1",
          deviceGeneration: 2,
          serverInstanceId: "instance-1",
          lineageGeneration: 3,
          epoch: 4,
          securityRevision: 57,
          headDigest: new Uint8Array(32).fill(50),
          signingPublicKeyHash: f.crypto.hash(f.device.publicKey),
        },
      })).toBeNull();
      expect(f.authorityCalls()).toBe(1);
      expect(f.providerCalls).toEqual([]);
      expect(f.productAttachments).toEqual([]);
    } finally {
      f.registry.close();
    }
  });

  test("rejects current claim and retained signer evidence substitution before storage writes", async () => {
    for (const mutate of [
      (f: Awaited<ReturnType<typeof fixture>>) => {
        f.request["claim_id"] = "substituted";
      },
      (f: Awaited<ReturnType<typeof fixture>>) => {
        f.evidence["credential_hash"] = new Uint8Array(32);
      },
    ]) {
      const f = await fixture(false);
      try {
        mutate(f);
        await rejects(runReflection(f), "Current processor");
        expect(f.objects.has("new-object")).toBe(false);
        expect(f.providerCalls).toEqual([]);
        expect(f.productAttachments).toEqual([]);
      } finally {
        f.adapter.dispose();
        f.registry.close();
      }
    }
  });

  test("rejects a substituted Namespace snapshot before publication", async () => {
    const f = await fixture(false);
    try {
      f.substituteNamespace("namespace-2");
      await rejects(runReflection(f), "Namespace bundle stale");
      expect(f.objects.has("new-object")).toBe(false);
      expect(f.productAttachments).toEqual([]);
    } finally {
      f.adapter.dispose();
      f.registry.close();
    }
  });

  test("recovers a committed ciphertext after product attachment loses its permit", async () => {
    const f = await fixture(false);
    try {
      f.skipAttachmentPermit();
      await rejects(runReflection(f), "skipped current authorization");
      expect(f.objects.has("new-object")).toBe(true);
      expect(f.envelopes.get("new-object:0")).toHaveLength(2);
      expect(f.request["transform_commit_claim_id"]).toBe("claim-1");
      expect(f.productAttachments).toEqual([]);

      const storedEnvelopes = [...f.envelopes.get("new-object:0")!]
        .sort((left, right) => left.namespace_id.localeCompare(right.namespace_id));
      const binding: ReflectionAuthorityReconciliationBindingV2 = {
        publicationId: "publication-1",
        recordRef: "record-1",
        sourceChangeGeneration: 4,
        expectedProjectionGeneration: 5,
        previousRepresentationGeneration: 1,
        representationGeneration: 2,
        previousObjectId: "old-object",
        attachmentPlanHash: new Uint8Array(32).fill(70),
        objectId: "new-object",
        objectType: "nautilo.reflection.record.v1",
        createdAt: NOW - 1,
        payloadHash: f.objects.get("new-object")!.payload_hash,
        namespaceEnvelopes: storedEnvelopes.map((entry) => ({
          namespaceId: entry.namespace_id,
          envelopeHash: entry.envelope_hash,
        })),
      };
      const recoveryRecipient = await f.registry.createAttempt({
        requestId: "request-2",
        workId: "work-2",
        namespaceId: "namespace-1",
        recipientGeneration: 0,
        recipientKeyId: "recipient-2",
        expiresAt: EXPIRES,
      });
      if (recoveryRecipient.status !== "created") {
        throw new Error("recovery recipient unavailable");
      }
      const recoveryDescriptor: BackgroundReflectionWorkDescriptorV2 = {
        ...f.descriptor,
        requestId: "request-2",
        workId: "work-2",
        workKind: "reflection.publication_reconcile",
        purpose: "record.reconcile",
        operations: ["decrypt"],
        source: {
          kind: "reflection_publication",
          publicationId: binding.publicationId,
          recordRef: binding.recordRef,
          representationGeneration: binding.representationGeneration,
          fingerprint: reflectionAuthorityReconciliationFingerprintV2(
            f.crypto,
            binding,
          ),
        },
        namespaceRequirements: f.descriptor.namespaceRequirements.map(
          (entry) => ({ ...entry, operations: ["decrypt"] }),
        ),
        inputBindings: binding.namespaceEnvelopes.map((entry) => ({
          objectId: binding.objectId,
          namespaceId: entry.namespaceId,
        })),
        outputSlots: [],
        recipientKeyId: "recipient-2",
        recipientPublicKey: recoveryRecipient.attempt.recipientPublicKey,
        idempotencyId: "recovery-idempotency",
      };
      const recoveryBytes = await createBackgroundAuthorizationResponseV2(
        f.crypto,
        {
          credentialId: "credential-2",
          descriptorBytes: encodeBackgroundWorkDescriptorV2(
            recoveryDescriptor,
          ),
          issuer: f.issuer,
          issuerSigningPrivateKey: f.device.privateKey,
          domainKeys: f.domainKeys,
        },
      );
      f.installAttempt(recoveryDescriptor, recoveryBytes);
      f.adapter.dispose();
      f.resumeAttachmentPermit();
      const recoveryAdapter = createPostgresReflectionAuthorityObjectPort({
        handle: f.handle,
        crypto: f.crypto,
        responseBytes: recoveryBytes,
        claimId: "claim-2",
        domainKeys: f.domainKeyPort,
        withCurrentAuthority: f.withCurrentAuthority,
        attach: f.attach,
      });
      expect(await f.registry.runCurrentReflectionAuthority({
        requestId: recoveryDescriptor.requestId,
        recipientGeneration: 0,
        recipientKeyId: recoveryDescriptor.recipientKeyId,
        claimId: "claim-2",
        responseBytes: recoveryBytes,
        reflectionObjects: recoveryAdapter.objects,
        resolveCurrentIssuer: recoveryAdapter.resolveCurrentIssuer,
        reconciliationBinding: binding,
        claims: { claimExactCredential: async () => "claimed" },
        signal: new AbortController().signal,
      })).toEqual({ status: "executed" });
      expect(f.productAttachments).toEqual(["new-object"]);
      recoveryAdapter.dispose();
    } finally {
      f.adapter.dispose();
      f.registry.close();
    }
  });

  test.each([true, false])(
    "retires a multi-Namespace Reflection object after shared Domains=%s while retaining signed history",
    async (sharedDomain) => {
      const f = await fixture(sharedDomain);
      try {
        expect(await runReflection(f)).toEqual({ status: "executed" });
        f.adapter.dispose();

        f.request["state"] = "completed";
        f.request["authorization_expires_at"] = new Date(NOW - 1);
        const repository = new PostgresJournalCryptoTombstoneRepository({
          handle: f.handle,
          crypto: f.crypto,
        });
        const signal = new AbortController().signal;
        expect(await repository.tombstoneObjects({
          objectIds: ["new-object"],
          signal,
        })).toEqual({
          status: "tombstoned",
          advancedCount: 1,
          alreadyTombstonedCount: 0,
        });

        expect(f.objects.has("new-object")).toBe(true);
        expect(f.manifests.has("new-object:0")).toBe(true);
        expect(f.manifests.has("new-object:1")).toBe(true);
        expect(f.envelopes.get("new-object:0")).toHaveLength(2);
        expect(f.envelopes.has("new-object:1")).toBe(false);
        expect(f.heads.get("new-object")?.access_revision).toBe(1);
        expect(await readVerifiedDeviceWrappedAgentObject({
          handle: f.handle,
          crypto: f.crypto,
          objectId: "new-object",
          expectedObjectType: "nautilo.reflection.record.v1",
          expectedNamespaceIds: ["namespace-1", "namespace-2"],
          resolveHistoricalAgentSignerAuthority: () => null,
        })).toBeNull();
        expect(await repository.tombstoneObjects({
          objectIds: ["new-object"],
          signal,
        })).toEqual({
          status: "tombstoned",
          advancedCount: 0,
          alreadyTombstonedCount: 1,
        });
      } finally {
        f.adapter.dispose();
        f.registry.close();
      }
    },
  );

  test("dispose closes authority reuse while preserving caller-owned response bytes", async () => {
    const f = await fixture(false);
    const responseCopy = f.responseBytes.slice();
    f.adapter.dispose();
    await rejects(Promise.resolve(f.adapter.resolveCurrentIssuer({
      descriptor: f.descriptor,
      descriptorHash: f.crypto.hash(encodeBackgroundWorkDescriptorV2(f.descriptor)),
      issuer: {
        humanId: "human-1",
        deviceId: "device-1",
        deviceGeneration: 2,
        serverInstanceId: "instance-1",
        lineageGeneration: 3,
        epoch: 4,
        securityRevision: 57,
        headDigest: new Uint8Array(32).fill(50),
        signingPublicKeyHash: f.crypto.hash(f.device.publicKey),
      },
    })), "disposed");
    expect(f.responseBytes).toEqual(responseCopy);
    f.registry.close();
  });
});


describe("signed Reflection saved-output recovery", () => {
  function recoveryDescriptor(f: Awaited<ReturnType<typeof fixture>>, binding: ReflectionAuthorityReconciliationBindingV2): Extract<BackgroundReflectionWorkDescriptorV2, {workKind: "reflection.publication_reconcile"}> {
    return {...f.descriptor, requestId: "recovery-request", workKind: "reflection.publication_reconcile", purpose: "record.reconcile",
      operations: ["decrypt"], source: {kind: "reflection_publication", publicationId: binding.publicationId, recordRef: binding.recordRef,
        representationGeneration: binding.representationGeneration, fingerprint: reflectionAuthorityReconciliationFingerprintV2(f.crypto, binding)},
      anchorNamespaceId: binding.namespaceEnvelopes[0]!.namespaceId,
      anchorDomainId: f.descriptor.namespaceRequirements.find(entry => entry.authority.namespaceId === binding.namespaceEnvelopes[0]!.namespaceId)!.authority.domainId,
      namespaceRequirements: f.descriptor.namespaceRequirements.filter(entry => binding.namespaceEnvelopes.some(value => value.namespaceId === entry.authority.namespaceId))
        .map(entry => ({authority: {...entry.authority}, operations: ["decrypt"]})),
      inputBindings: binding.namespaceEnvelopes.map(entry => ({objectId: binding.objectId, namespaceId: entry.namespaceId})), outputSlots: []};
  }
  test("reconstructs original fixed attachment metadata after crypto commit and product failure, without opening keys", async () => {
    const f = await fixture(false);
    try {
      f.skipAttachmentPermit(); await rejects(runReflection(f), "skipped current authorization");
      const calls = [...f.providerCalls];
      const saved = await readPostgresReflectionAuthoritySavedOutput({handle: f.handle, crypto: f.crypto, objectId: "new-object"});
      expect(saved).not.toBeNull();
      expect(saved!.binding).toMatchObject({publicationId: "request-1", recordRef: "record-1", sourceChangeGeneration: 4,
        expectedProjectionGeneration: 5, previousRepresentationGeneration: 1, representationGeneration: 2, previousObjectId: "old-object", objectId: "new-object"});
      expect(saved!.binding.attachmentPlanHash).toEqual(f.crypto.hash(encodeBackgroundWorkDescriptorV2(f.descriptor)));
      expect(saved!.binding.namespaceEnvelopes.map(entry => entry.namespaceId)).toEqual(["namespace-1", "namespace-2"]);
      expect(encodeBackgroundWorkDescriptorV2(saved!.originalDescriptor)).toEqual(encodeBackgroundWorkDescriptorV2(f.descriptor));
      expect(f.providerCalls).toEqual(calls); expect(f.productAttachments).toEqual([]);
      saved!.binding.payloadHash.fill(0); saved!.originalDescriptor.source.fingerprint.fill(0);
      expect(f.objects.get("new-object")!.payload_hash.some(byte => byte !== 0)).toBe(true);
      expect(f.descriptor.source.fingerprint.some(byte => byte !== 0)).toBe(true);
    } finally {f.adapter.dispose(); f.registry.close();}
  });
  test("rejects absent or substituted atomic markers despite a valid historical signed output", async () => {
    const f = await fixture(false);
    try {
      await runReflection(f);
      const original = structuredClone(f.request);
      for (const mutation of [
        {transform_committed_at: null}, {transform_commit_descriptor_hash: new Uint8Array(32)},
        {transform_commit_recipient_generation: 99}, {transform_commit_output_count: 2},
        {transform_committed_at: new Date(EXPIRES)}, {descriptor_bytes: new Uint8Array(1)},
      ]) {
        Object.assign(f.request, original, mutation);
        await rejects(readPostgresReflectionAuthoritySavedOutput({handle: f.handle, crypto: f.crypto, objectId: "new-object"}), "atomic transform marker");
      }
      Object.assign(f.request, original);
      f.evidence["work_descriptor_hash"] = new Uint8Array(32);
      await rejects(readPostgresReflectionAuthoritySavedOutput({handle: f.handle, crypto: f.crypto, objectId: "new-object"}), "conflicting durable anchors");
    } finally {f.adapter.dispose(); f.registry.close();}
  });
  test("validates fresh read-only B with product Room locks before crypto heads and rejects substituted recovery metadata", async () => {
    const f = await fixture(false, true);
    try {
      f.skipAttachmentPermit(); await rejects(runReflection(f), "skipped current authorization");
      const saved = await readPostgresReflectionAuthoritySavedOutput({handle: f.handle, crypto: f.crypto, objectId: "new-object"});
      expect(saved).not.toBeNull();
      const descriptorB = recoveryDescriptor(f, saved!.binding);
      const order: string[] = [];
      let blocked = false;
      const product = {query<Row extends PostgresJsBridgeRow>(statement: string): Promise<readonly Row[]> {
        const normalized = statement.replaceAll('"', "").toLowerCase(); order.push(normalized);
        const rows = normalized.includes("from reflection_record_authority_projections")
          ? [{projection_generation: 5, source_change_generation: 4, processing_state: "dirty", disposition: "available"}]
          : normalized.includes("from reflection_record_authority_closure") ? [{terminal_leaf_handle: "namespace-1"}]
          : normalized.includes("from reflection_record_authority_blocks") ? blocked ? [{block_id: "blocked"}] : []
          : normalized.includes("from reflection_record_payload_representations") ? [{crypto_object_id: "old-object", current_representation_generation: 1}]
          : normalized.includes("from rooms") ? [1, 2].map(index => ({id: `room-${index}`, namespace_id: `namespace-${index}`, kind: "access", human_actor_ids: ["human-1"], effective_human_actor_ids: ["human-1"], archived_at: null}))
          : [];
        return Promise.resolve(rows as unknown as readonly Row[]);
      }};
      const restricted = {query<Row extends PostgresJsBridgeRow>(statement: string, parameters?: readonly PostgresJsBridgeScalar[]) {
        order.push(statement.replaceAll('"', "").toLowerCase()); return f.handle.query(statement, parameters as readonly DatabaseScalar[]) as unknown as Promise<readonly Row[]>;
      }};
      expect(await validatePostgresReflectionAuthorityRecovery({product, restricted, crypto: f.crypto, descriptorB})).toBe(true);
      const roomLock = order.findIndex(sql => sql.includes("from rooms") && sql.includes("for update"));
      const cryptoHeadLock = order.findIndex(sql => sql.includes("from object_crypto_access_heads") && sql.includes("for update"));
      expect(roomLock).toBeGreaterThanOrEqual(0); expect(cryptoHeadLock).toBeGreaterThan(roomLock);
      for (const changed of [
        {...descriptorB, source: {...descriptorB.source, fingerprint: new Uint8Array(32)}},
        {...descriptorB, namespaceRequirements: descriptorB.namespaceRequirements.map(entry => ({...entry, authority: {...entry.authority, roomId: "foreign-room"}}))},
      ]) expect(await validatePostgresReflectionAuthorityRecovery({product, restricted, crypto: f.crypto, descriptorB: changed})).toBe(false);
      blocked = true; order.length = 0;
      expect(await validatePostgresReflectionAuthorityRecovery({product, restricted, crypto: f.crypto, descriptorB})).toBe(false);
      expect(order.some(sql => sql.includes("from object_crypto_access_heads") && sql.includes("for update"))).toBe(false);
    } finally {f.adapter.dispose(); f.registry.close();}
  });
});

async function semanticFixture(kind: "organization" | "search_projection" = "organization") {
  const f = await fixture(false);
  f.adapter.dispose(); f.registry.delete(f.descriptor.requestId, f.descriptor.recipientGeneration);
  const created = await f.registry.createAttempt({requestId: "semantic-request", workId: "semantic-work", namespaceId: "namespace-1", recipientGeneration: 0, recipientKeyId: "semantic-recipient", expiresAt: EXPIRES});
  if (created.status !== "created") throw new Error("No semantic recipient");
  const descriptor: BackgroundReflectionWorkDescriptorV2 = {...f.descriptor,
    requestId: "semantic-request", workId: "semantic-work", recipientKeyId: "semantic-recipient", recipientPublicKey: created.attempt.recipientPublicKey,
    workKind: kind === "organization" ? "reflection.organization" : "reflection.search_projection",
    purpose: kind === "organization" ? "record.organize" : "record.search_projection",
    source: {kind: "reflection_semantic", recordRef: "record-1", claimGeneration: 4, fingerprint: new Uint8Array(32).fill(7)},
    inputBindings: [{objectId: "old-object", namespaceId: "namespace-1", objectType: "nautilo.reflection.record.v1"}],
    ...(kind === "search_projection" ? {operations: ["decrypt"], outputSlots: [], namespaceRequirements: [{authority: f.descriptor.namespaceRequirements[0]!.authority, operations: ["decrypt"]}]} : {}),
  } as BackgroundReflectionWorkDescriptorV2;
  const responseBytes = await createBackgroundAuthorizationResponseV2(f.crypto, {credentialId: "semantic-credential", descriptorBytes: encodeBackgroundWorkDescriptorV2(descriptor), issuer: f.issuer,
    issuerSigningPrivateKey: f.device.privateKey, domainKeys: kind === "search_projection" ? f.domainKeys.slice(0,1) : f.domainKeys});
  f.installAttempt(descriptor, responseBytes);
  const outputPlaintext = new TextEncoder().encode('{"generatedRecordId":"different-from-source"}');
  const attached: (string | null)[] = [];
  let skip = false, fail = false, revoke = false;
  let savedPermit: (() => Promise<number>) | undefined;
  const adapter = createPostgresReflectionSemanticObjectPort({handle: f.handle, crypto: f.crypto, responseBytes, claimId: "claim-2", domainKeys: f.domainKeyPort, withCurrentAuthority: f.withCurrentAuthority,
    validateInput: async request => {expect(request.objectType).toBe("nautilo.reflection.record.v1"); expect(request.plaintext).toEqual(f.plaintext);},
    validateOutput: async request => {expect(request.objectId).toBe("new-object"); expect(request.plaintext).toEqual(outputPlaintext);},
    attach: async request => {
      expect(request.held.executor).toBeDefined(); savedPermit = request.authorizeCommit;
      if (skip) return;
      if (revoke) f.deny();
      await request.authorizeCommit();
      if (fail) throw new Error("product commit failed");
      attached.push(request.output === null ? null : new TextDecoder().decode(request.output.plaintext));
    },
  });
  const run = () => f.registry.runCurrentReflectionSemantic({requestId: descriptor.requestId, recipientGeneration: 0, recipientKeyId: descriptor.recipientKeyId, claimId: "claim-2", responseBytes,
    semanticObjects: adapter.objects, resolveCurrentIssuer: adapter.resolveCurrentIssuer, claims: {claimExactCredential: async () => "claimed"},
    execute: async inputs => {expect(inputs).toHaveLength(1); expect(inputs[0]!.plaintext).toEqual(f.plaintext); return kind === "search_projection" ? null : {objectId: "new-object", plaintext: outputPlaintext.slice()};},
  });
  return {...f, descriptor, responseBytes, adapter, run, attached, skip: () => {skip = true;}, fail: () => {fail = true;}, revoke: () => {revoke = true;}, savedPermit: () => savedPermit};
}

describe("PostgreSQL Reflection semantic object port", () => {
  test("retirement-only saved proof authenticates a tombstoned semantic output while recovery stays closed", async () => {
    const f = await semanticFixture();
    try {
      await f.run();
      const input = {handle: f.handle, crypto: f.crypto, objectId: "new-object",
        semanticRecordRef: "generated-record", semanticRequestCommitment: new Uint8Array(32).fill(9)};
      expect(await readPostgresReflectionAuthoritySavedOutput(input)).not.toBeNull();
      const repository = new PostgresJournalCryptoTombstoneRepository({handle: f.handle, crypto: f.crypto});
      await repository.tombstoneObjects({objectIds: ["new-object"], signal: new AbortController().signal});
      await rejects(readPostgresReflectionAuthoritySavedOutput(input), "retired or changed");
      const calls = [...f.providerCalls];
      const saved = await readPostgresReflectionAuthoritySavedOutput({...input, allowRetired: true});
      expect(saved).toMatchObject({retired: true, binding: {objectId: "new-object"}});
      expect(saved!.originalDescriptor.source.recordRef).toBe("record-1");
      expect(f.providerCalls).toEqual(calls);
      f.request["transform_commit_output_count"] = 0;
      await rejects(readPostgresReflectionAuthoritySavedOutput({...input, allowRetired: true}), "atomic transform marker");
    } finally {f.adapter.dispose(); f.registry.close();}
  });
  test("publishes the generated Record under exact signed output authority and held product transaction", async () => {
    const f = await semanticFixture();
    try {
      expect(await f.run()).toEqual({status: "executed"});
      expect(f.attached).toEqual(['{"generatedRecordId":"different-from-source"}']);
      expect(f.request["transform_commit_output_count"]).toBe(1);
      expect(f.request["transform_commit_claim_id"]).toBe("claim-2");
      expect(f.request["transform_commit_descriptor_hash"]).toEqual(f.crypto.hash(encodeBackgroundWorkDescriptorV2(f.descriptor)));
      expect(f.objects.has("new-object")).toBe(true);
      await rejects(f.savedPermit()!(), "reused");
    } finally {f.adapter.dispose(); f.registry.close();}
  });
  test("read-only search records a no-object product marker bound to its exact attempt", async () => {
    const f = await semanticFixture("search_projection");
    try {
      expect(await f.run()).toEqual({status: "executed"});
      expect(f.attached).toEqual([null]); expect(f.objects.has("new-object")).toBe(false);
      expect(f.request["transform_commit_output_count"]).toBe(0);
      expect(f.request["transform_commit_claim_id"]).toBe("claim-2");
      expect(f.request["transform_commit_recipient_generation"]).toBe(0);
      expect(f.request["transform_commit_descriptor_hash"]).toEqual(f.crypto.hash(encodeBackgroundWorkDescriptorV2(f.descriptor)));
    } finally {f.adapter.dispose(); f.registry.close();}
  });
  test("skipped authorization and failed product transactions never mark no-change completed", async () => {
    for (const mode of ["skip", "fail"] as const) {
      const f = await semanticFixture("search_projection");
      try {
        f[mode](); await rejects(f.run(), mode === "skip" ? "skipped" : "product commit failed");
        expect(f.request["transform_committed_at"]).toBeNull(); expect(f.attached).toHaveLength(0);
      } finally {f.adapter.dispose(); f.registry.close();}
    }
  });
  test("named constructors reject mixed purpose and inventory widening before any key use", async () => {
    const f = await semanticFixture("search_projection");
    try {
      expect(() => createPostgresReflectionAuthorityObjectPort({handle: f.handle, crypto: f.crypto, responseBytes: f.responseBytes, claimId: "claim-2", domainKeys: f.domainKeyPort, withCurrentAuthority: f.withCurrentAuthority, attach: f.attach})).toThrow("named object port");
      await rejects(f.adapter.objects.openObject({objectId: "undeclared", namespaceId: "namespace-1", signal: new AbortController().signal}), "outside declared inventory");
      expect(f.providerCalls).toHaveLength(0);
    } finally {f.adapter.dispose(); f.registry.close();}
  });
});


describe("Reflection Message publication signer verification", () => {
  async function messageFixture(kind: "human" | "agent", evidence: "valid" | "wrong" | "missing") {
    const f = await semanticFixture(); f.adapter.dispose();
    const messageId = objectId("message-object");
    const plaintext = encodeMessagePayloadV2({role: kind === "human" ? "user" : "assistant", content: "Exact original Message support"});
    const encrypted = encryptObjectPayload(f.crypto, {objectId: messageId, keyClass: "ai", objectType: "nautilo-message-v2", createdAt: unixTimestamp(NOW - 1)}, plaintext);
    const envelope = wrapObjectDekForNamespace(f.crypto, f.namespaceKeys.get("namespace-1")!, {objectId: messageId,
      namespaceId: namespaceId("namespace-1"), keyClass: "ai", keyGeneration: namespaceGeneration(1), bindingRevisionAtWrap: accessRevision(2)}, encrypted.dek);
    encrypted.dek.fill(0);
    const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload), envelopeBytes = encodeNamespaceObjectEnvelopeV2(envelope);
    const payloadHash = f.crypto.hash(payloadBytes), envelopeHash = f.crypto.hash(envelopeBytes);
    const runtime = {agentId: agentId("original-message-agent"), keyClass: "runtime" as const, generation: agentRuntimeGeneration(0), key: new Uint8Array(32).fill(61)};
    const signer = deriveAgentRuntimeObjectSignerPublic(f.crypto, runtime);
    const unsigned = {objectId: messageId, payloadHash, accessRevision: accessRevision(0), previousManifestHash: null,
      envelopeHashes: [envelopeHash], signerAuthorizationHash: null, hostAuthorizationRevision: authorizationRevision(0)};
    const manifest = kind === "human" ? createCommonHumanObjectAccessManifest(f.crypto, {...unsigned,
      signer: {kind: "human_device", subjectHumanId: humanId(f.issuer.humanId),
        committerDeviceId: cryptoDeviceId(evidence === "missing" ? "absent-original-device" : f.issuer.deviceId)}},
      evidence === "wrong" ? f.crypto.generateSigningKeyPair().privateKey : f.device.privateKey)
      : createCommonAgentObjectAccessManifest(f.crypto, {...unsigned, signer: signer.principal}, runtime);
    runtime.key.fill(0);
    f.objects.set(messageId, {object_id: messageId, payload_hash: payloadHash, payload_bytes: payloadBytes});
    f.manifests.set(`${messageId}:0`, {object_id: messageId, access_revision: 0, manifest_hash: manifest.hash,
      previous_manifest_hash: null, payload_hash: payloadHash, manifest_bytes: manifest.bytes});
    f.envelopes.set(`${messageId}:0`, [{namespace_id: "namespace-1", ordinal: 0, envelope_hash: envelopeHash, envelope_bytes: envelopeBytes}]);
    f.heads.set(messageId, {object_id: messageId, access_revision: 0, manifest_hash: manifest.hash});
    const descriptor: BackgroundReflectionWorkDescriptorV2 = {...f.descriptor, workKind: "reflection.dependency_rewrite", purpose: "record.dependency_rewrite",
      inputBindings: [{objectId: messageId, namespaceId: "namespace-1", objectType: "nautilo-message-v2"},
        {objectId: "old-object", namespaceId: "namespace-1", objectType: "nautilo.reflection.record.v1"}]} as BackgroundReflectionWorkDescriptorV2;
    const responseBytes = await createBackgroundAuthorizationResponseV2(f.crypto, {credentialId: "message-credential", descriptorBytes: encodeBackgroundWorkDescriptorV2(descriptor),
      issuer: f.issuer, issuerSigningPrivateKey: f.device.privateKey, domainKeys: f.domainKeys});
    f.installAttempt(descriptor, responseBytes);
    let executions = 0, foregroundLookups = 0;
    const adapter = createPostgresReflectionSemanticObjectPort({handle: f.handle, crypto: f.crypto, responseBytes, claimId: "claim-2",
      domainKeys: f.domainKeyPort, withCurrentAuthority: f.withCurrentAuthority,
      resolveLiveShadowAgentSigner: principal => {
        foregroundLookups++; expect(principal).toEqual({agentId: runtime.agentId, runtimeGeneration: runtime.generation, signerKeyId: signer.principal.signerKeyId});
        return evidence === "missing" ? null : evidence === "wrong" ? new Uint8Array(32).fill(3) : signer.publicKey.slice();
      },
      validateInput: async value => {expect(value.plaintext).toEqual(value.objectType === "nautilo-message-v2" ? plaintext : f.plaintext);},
      validateOutput: async () => {throw new Error("Unexpected output");}, attach: async value => {expect(value.output).toBeNull(); await value.authorizeCommit();}});
    const run = () => f.registry.runCurrentReflectionSemantic({requestId: descriptor.requestId, recipientGeneration: 0, recipientKeyId: descriptor.recipientKeyId,
      claimId: "claim-2", responseBytes, semanticObjects: adapter.objects, resolveCurrentIssuer: adapter.resolveCurrentIssuer,
      claims: {claimExactCredential: async () => "claimed"}, execute: async inputs => {executions++; expect(inputs).toHaveLength(2); return null;}});
    return {run, executions: () => executions, foregroundLookups: () => foregroundLookups,
      close: () => {adapter.dispose(); f.registry.close(); plaintext.fill(0);}};
  }
  test.each(["human", "agent"] as const)("opens a verified %s Message only inside the exact Reflection grant", async kind => {
    const f = await messageFixture(kind, "valid");
    try {expect(await f.run()).toEqual({status: "executed"}); expect(f.executions()).toBe(1);
      expect(f.foregroundLookups() > 0).toBe(kind === "agent");} finally {f.close();}
  });
  for (const kind of ["human", "agent"] as const) test.each(["wrong", "missing"] as const)(`${kind} Message rejects %s original signer evidence before execution`, async evidence => {
    const f = await messageFixture(kind, evidence);
    try {expect(await f.run().then(() => null, (error: unknown) => error)).toBeInstanceOf(Error); expect(f.executions()).toBe(0);}
    finally {f.close();}
  });
});
