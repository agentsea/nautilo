import {createBackgroundAuthorizationResponseV2, encodeBackgroundWorkDescriptorV2, publicationReconciliationFingerprintV2,
  type ProcessorPublicationReconciliationBindingV2} from "@nautilo/lattice-crypto/background";
import {describe, expect, test} from "bun:test";
import {
  LatticeCrypto, ProcessorTransformRecipientRegistry, accessRevision, authorizationRevision, cryptoDeviceId, humanId,
  createCommonHumanObjectAccessManifest, encryptObjectPayload, wrapObjectDekForNamespace,
  namespaceId, namespaceGeneration, objectId, unixTimestamp, decryptObjectThroughNamespace,
} from "@nautilo/lattice-crypto";
import {decodeEncryptedPayloadV2, decodeNamespaceObjectEnvelopeV2,
  encodeEncryptedPayloadV2, encodeNamespaceObjectEnvelopeV2} from "@nautilo/lattice-crypto/wire";
import {createPostgresCurrentProcessorReconciliationObjectVerifier} from "../../src/server/storage/postgres-current-processor-reconciliation-input.ts";
import {PostgresProtectedJournalProcessorObjectVerifier} from "../../src/server/journal/postgres-protected-journal-processor-object-verifier.ts";
import {verifyStoredObjectAccessManifestChainV5} from "../../src/server/storage/postgres-object-access-manifest-v5.ts";
import {verifyCryptoPostgresHandle, type CryptoPostgresConnection} from "../../src/server/storage/postgres-lattice-storage.ts";
import type {VerifyProcessorTransformV5Input} from "../../src/server/storage/postgres-processor-transform-object-port.ts";
import type {DatabaseRow, DatabaseScalar} from "../../src/server/storage/postgres-record-codecs.ts";
import {currentProcessorCertificateFixtureV2} from "../helpers/current-processor-certificate-v2.ts";

const OBJECT = objectId("journal-current-v5-rewrap");
const NAMESPACE = namespaceId("namespace-current-certificate-v3");
const TIME = 1_800_000_000_000;
const BODY = new TextEncoder().encode("one retained canonical model result");
const normalize = (statement: string) => statement.replaceAll('"', "").replaceAll(/\s+/gu, " ").toLowerCase();

async function fixture(workKind: "stenographer.historical" | "stenographer.output_repair" = "stenographer.historical") {
  const crypto = new LatticeCrypto();
  const newKey = crypto.randomBytes(32);
  const encrypted = encryptObjectPayload(crypto, {objectId: OBJECT, objectType: "nautilo.reflection.record.v1",
    keyClass: "ai", createdAt: unixTimestamp(TIME)}, BODY);
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  const envelope = (key: Uint8Array, generation: number, revision: number) => encodeNamespaceObjectEnvelopeV2(
    wrapObjectDekForNamespace(crypto, key, {objectId: OBJECT, namespaceId: NAMESPACE, keyClass: "ai",
      keyGeneration: namespaceGeneration(generation), bindingRevisionAtWrap: accessRevision(revision)}, encrypted.dek));
  const originalEnvelope = envelope(crypto.randomBytes(32), 3, 8);
  const currentEnvelope = envelope(newKey, 4, 9);
  encrypted.dek.fill(0);
  const current = await currentProcessorCertificateFixtureV2({now: TIME, workKind, objects: [{objectId: OBJECT,
    payloadHash: crypto.hash(payloadBytes), envelopeHash: crypto.hash(originalEnvelope), createdAt: TIME}]});
  const genesis = current.manifests[0]!;
  const human = crypto.generateSigningKeyPair();
  const successor = createCommonHumanObjectAccessManifest(crypto, {objectId: OBJECT, payloadHash: crypto.hash(payloadBytes),
    accessRevision: accessRevision(1), previousManifestHash: genesis.v5Hash, envelopeHashes: [crypto.hash(currentEnvelope)],
    signer: {kind: "human_device", subjectHumanId: humanId(current.issuer.humanId), committerDeviceId: cryptoDeviceId("rewrap-device")},
    signerAuthorizationHash: null, hostAuthorizationRevision: authorizationRevision(12)}, human.privateKey);
  human.privateKey.fill(0);
  const chain: Record<string, DatabaseScalar>[] = [
    {object_id: OBJECT, access_revision: 0, manifest_hash: genesis.v5Hash, previous_manifest_hash: null,
      payload_hash: crypto.hash(payloadBytes), manifest_bytes: genesis.v5Bytes},
    {object_id: OBJECT, access_revision: 1, manifest_hash: successor.hash, previous_manifest_hash: genesis.v5Hash,
      payload_hash: crypto.hash(payloadBytes), manifest_bytes: successor.bytes},
  ];
  const statements: string[] = [];
  const connection: CryptoPostgresConnection = {
    query: <Row extends DatabaseRow>(statement: string) => {
      statements.push(statement);
      const sql = normalize(statement);
      let rows: readonly DatabaseRow[];
      if (sql.includes("current_user::text")) rows = [{current_user: "nautilo_crypto", session_user: "nautilo_crypto"}];
      else if (sql.includes("set transaction")) rows = [];
      else if (sql.includes("from crypto_objects") && sql.includes("left join object_crypto_access")) {
        const head = sql.includes("left join object_crypto_access_heads") ? chain[1]! : chain[0]!;
        rows = [{object_id: OBJECT, object_payload_hash: crypto.hash(payloadBytes), payload_hash: crypto.hash(payloadBytes), payload_bytes: payloadBytes,
          head_access_revision: head["access_revision"]!, head_manifest_hash: head["manifest_hash"]!,
          manifest_object_id: OBJECT, manifest_access_revision: head["access_revision"]!, manifest_payload_hash: crypto.hash(payloadBytes),
          manifest_hash: head["manifest_hash"]!, previous_manifest_hash: head["previous_manifest_hash"]!, manifest_bytes: head["manifest_bytes"]!}];
      } else if (sql.includes("from crypto_objects")) rows = [{object_id: OBJECT, payload_hash: crypto.hash(payloadBytes), payload_bytes: payloadBytes}];
      else if (sql.includes("from object_crypto_access_heads")) rows = [chain[1]!];
      else if (sql.includes("from object_crypto_access_manifests")) rows = chain;
      else if (sql.includes("from object_crypto_namespace_envelopes")) rows = [{namespace_id: NAMESPACE, ordinal: 0,
        envelope_hash: crypto.hash(currentEnvelope), envelope_bytes: currentEnvelope}];
      else if (sql.includes("from processor_crypto_signer_authorizations")) rows = [current.authorizationRow];
      else if (sql.includes("from human_crypto_devices")) rows = [current.deviceRow];
      else throw new Error(`Unexpected V5 chain SQL: ${statement}`);
      return Promise.resolve(rows as readonly Row[]);
    },
    transaction: use => use(connection),
  };
  const handle = await verifyCryptoPostgresHandle(connection);
  const verifyV5Input: VerifyProcessorTransformV5Input = request => verifyStoredObjectAccessManifestChainV5({...request,
    resolveHistoricalAgentManagerAuthority: () => null,
    resolveHistoricalHumanDeviceSigningPublicKey: async context => context.subjectHumanId === current.issuer.humanId
      && context.committerDeviceId === "rewrap-device" && context.hostAuthorizationRevision === 12 ? human.publicKey : null});
  const original = {requestId: current.descriptor.requestId, recipientGeneration: current.descriptor.recipientGeneration,
    descriptorHash: crypto.hash(current.authorizationRow.work_descriptor_bytes)};
  const read = () => createPostgresCurrentProcessorReconciliationObjectVerifier({handle, crypto, original, verifyV5Input})
    .verify({objectId: OBJECT, signal: new AbortController().signal});
  return {crypto, handle, current, chain, original, verifyV5Input, read, payloadBytes, currentEnvelope, newKey, statements};
}

async function rejected(work: Promise<unknown>) {
  const result = await work.then(() => null, (cause: unknown) => cause);
  expect(result).toBeInstanceOf(Error);
}

describe("current Journal common-V5 genesis and key rewrap", () => {
  test("real historical chain authenticates current genesis plus Human rewrap and retains original publication provenance", async () => {
    const f = await fixture();
    const result = await f.read();
    expect(result).not.toBeNull();
    expect(result?.workId).toBe(f.current.descriptor.workId);
    expect(result?.publisherNamespaceAccessRevision).toBe(8);
    expect(result?.payloadBytes).toEqual(f.payloadBytes);
    expect(result?.namespaceEnvelopeBytes).toEqual(f.currentEnvelope);
    expect(f.current.deviceRow.state).toBe("revoked");
    expect(f.statements.some(statement => statement.includes("background_crypto_authorization_requests"))).toBe(false);
    const payload = decodeEncryptedPayloadV2(result!.payloadBytes);
    const envelope = decodeNamespaceObjectEnvelopeV2(result!.namespaceEnvelopeBytes);
    expect(envelope.context.keyGeneration).toBe(namespaceGeneration(4));
    expect(envelope.context.bindingRevisionAtWrap).toBe(accessRevision(9));
    const plaintext = decryptObjectThroughNamespace(f.crypto, f.newKey, envelope, payload);
    expect(plaintext).toEqual(BODY);
    plaintext?.fill(0); result!.payloadBytes.fill(0); result!.namespaceEnvelopeBytes.fill(0);
    expect(f.payloadBytes.some(byte => byte !== 0)).toBe(true);
  });
  test.each(["stenographer.historical", "stenographer.output_repair"] as const)("general Journal reader authenticates %s through the real common chain", async workKind => {
    const f = await fixture(workKind);
    const result = await new PostgresProtectedJournalProcessorObjectVerifier(f.crypto, f.handle, f.verifyV5Input)
      .verify({objectId: OBJECT, signal: new AbortController().signal});
    expect(result?.workId).toBe(f.current.descriptor.workId);
    expect(result?.outputOrdinal).toBe(0);
    expect(result?.authorizedOutputObjectIds).toEqual([OBJECT]);
    expect(result?.namespaceEnvelopeBytes).toEqual(f.currentEnvelope);
    result?.payloadBytes.fill(0); result?.namespaceEnvelopeBytes.fill(0);
  });
  test("a fresh post-expiry grant opens the rewrapped retained result with no model or encrypted publication", async () => {
    const f = await fixture();
    const retained = await f.read();
    if (retained === null) throw new Error("Expected retained result");
    const binding: ProcessorPublicationReconciliationBindingV2 = {originalRequestId: f.original.requestId,
      originalWorkId: retained.workId, originalRecipientGeneration: f.original.recipientGeneration,
      originalDescriptorHash: f.original.descriptorHash, attachmentPlanHash: new Uint8Array(32).fill(9), outputs: [{
        objectId: OBJECT, objectType: "nautilo.reflection.record.v1", createdAt: TIME,
        payloadHash: f.crypto.hash(retained.payloadBytes), envelopeHash: f.crypto.hash(retained.namespaceEnvelopeBytes)}]};
    retained.payloadBytes.fill(0); retained.namespaceEnvelopeBytes.fill(0);
    const now = TIME + 600_000; // The original private grant is no longer usable.
    const registry = new ProcessorTransformRecipientRegistry({crypto: f.crypto, now: () => now});
    const recipient = await registry.createAttempt({requestId: "fresh-rewrap-request", workId: "reconcile:old-publication",
      namespaceId: NAMESPACE, recipientGeneration: 0, recipientKeyId: "fresh-rewrap-key", expiresAt: now + 300_000});
    if (recipient.status !== "created") throw new Error("Expected recipient");
    const device = f.crypto.generateSigningKeyPair();
    const descriptor = {...f.current.descriptor, requestId: "fresh-rewrap-request", workId: "reconcile:old-publication",
      workKind: "stenographer.publication_reconcile" as const, purpose: "journal.reconcile" as const,
      authority: {...f.current.descriptor.authority, namespaceKeyGeneration: 4, namespaceAccessRevision: 9},
      source: {...f.current.descriptor.source, fingerprint: publicationReconciliationFingerprintV2(f.crypto, binding)},
      operations: ["decrypt"] as const,
      inputBindings: [{objectId: OBJECT, namespaceId: f.current.descriptor.anchorNamespaceId}], outputSlots: [],
      issuedAt: now, notBefore: now, expiresAt: now + 300_000,
      recipientGeneration: 0, recipientKeyId: recipient.attempt.recipientKeyId,
      recipientPublicKey: recipient.attempt.recipientPublicKey, idempotencyId: "fresh-rewrap-idempotency"};
    const responseBytes = await createBackgroundAuthorizationResponseV2(f.crypto, {credentialId: "fresh-rewrap-credential",
      descriptorBytes: encodeBackgroundWorkDescriptorV2(descriptor), issuer: {...f.current.issuer,
        signingPublicKeyHash: f.crypto.hash(device.publicKey)}, issuerSigningPrivateKey: device.privateKey,
      domainKey: new Uint8Array(32).fill(6)});
    let claims = 0; let attachments = 0; let borrowed: Uint8Array | undefined;
    try {
      const result = await registry.runCurrentReconciliation({requestId: descriptor.requestId, recipientGeneration: 0,
        recipientKeyId: descriptor.recipientKeyId, claimId: "fresh-rewrap-claim", responseBytes, binding,
        resolveCurrentIssuer: () => device.publicKey, claims: {claimExactCredential: async () => {claims++; return "claimed";}},
        objects: {openInput: async () => {
          const current = await f.read(); if (current === null) throw new Error("Missing committed output");
          try {return {payload: decodeEncryptedPayloadV2(current.payloadBytes), envelope: decodeNamespaceObjectEnvelopeV2(current.namespaceEnvelopeBytes)};}
          finally {current.payloadBytes.fill(0); current.namespaceEnvelopeBytes.fill(0);}
        }, withNamespaceKey: async ({generation, accessRevision}, use) => {
          expect(claims).toBe(1); expect(generation).toBe(4); expect(accessRevision).toBe(9);
          return use(f.newKey);
        }, attach: async ({outputs, authorizeCommit}) => {
          borrowed = outputs[0]!.plaintext; expect(borrowed).toEqual(BODY);
          await authorizeCommit(); attachments++;
        }}});
      expect(result.status).toBe("executed"); expect(claims).toBe(1); expect(attachments).toBe(1);
      expect(borrowed?.every(byte => byte === 0)).toBe(true);
      // The reconciliation port exposes neither executeWork nor publishOutputs.
    } finally {registry.close(); device.privateKey.fill(0); f.newKey.fill(0);}
  });
  test.each(["original binding", "successor signature", "mixed genesis", "missing chain owner"] as const)("refuses %s", async kind => {
    const f = await fixture();
    if (kind === "original binding") f.original.requestId = "different-original-request";
    if (kind === "successor signature") {
      const bytes = Uint8Array.from(f.chain[1]!["manifest_bytes"] as Uint8Array); bytes[bytes.length - 1]! ^= 1;
      f.chain[1]!["manifest_bytes"] = bytes; f.chain[1]!["manifest_hash"] = f.crypto.hash(bytes);
    }
    if (kind === "mixed genesis") {
      f.chain[0]!["manifest_bytes"] = f.current.manifests[0]!.v4Bytes;
      f.chain[0]!["manifest_hash"] = f.current.manifests[0]!.v4Hash;
    }
    if (kind === "missing chain owner") await rejected(createPostgresCurrentProcessorReconciliationObjectVerifier({
      handle: f.handle, crypto: f.crypto, original: f.original}).verify({objectId: OBJECT, signal: new AbortController().signal}));
    else await rejected(f.read());
  });
});
