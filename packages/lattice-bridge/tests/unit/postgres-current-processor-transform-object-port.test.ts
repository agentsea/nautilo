import {describe, expect, test} from "bun:test";
import {createCurrentCommonProcessorObjectAccessManifest, LatticeCrypto, accessRevision, authorizationRevision, objectId} from "@nautilo/lattice-crypto";
import {
  createBackgroundAuthorizationResponseV2, decodeBackgroundAuthorizationResponseV2,
  decodeBackgroundProcessorWorkDescriptorV2,
  encodeBackgroundWorkDescriptorV2, inspectBackgroundAuthorizationResponseV2,
  verifyHistoricalProcessorSignerAuthorizationV2, withOpenedBackgroundAuthorizationV2,
  publicationReconciliationFingerprintV2, type ProcessorPublicationReconciliationBindingV2,
  type BackgroundProcessorWorkDescriptorV2,
} from "@nautilo/lattice-crypto/background";
import {signProcessorObjectBytesV1, createCurrentProcessorObjectAccessManifestV4, encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2, encodeObjectAccessManifestV5, objectAccessManifestSigningBytesV5, decodeObjectAccessManifestV5} from "@nautilo/lattice-crypto/wire";
import {encryptObjectPayload, wrapObjectDekForNamespace, namespaceId, namespaceGeneration, unixTimestamp} from "@nautilo/lattice-crypto";
import {createPostgresProcessorTransformObjectPort} from "../../src/server/storage/postgres-processor-transform-object-port.ts";
import {createPostgresCurrentProcessorTransformObjectPort, type WithCurrentProcessorPublicationAuthority} from "../../src/server/storage/postgres-current-processor-transform-object-port.ts";
import {loadVerifiedCurrentProcessorSignerAuthorization, destroyVerifiedCurrentProcessorSignerEvidence} from "../../src/server/storage/postgres-current-processor-signer-authorization.ts";
import {verifyCryptoPostgresHandle, type CryptoPostgresConnection, type CryptoPostgresExecutor} from "../../src/server/storage/postgres-lattice-storage.ts";
import type {DatabaseRow, DatabaseScalar} from "../../src/server/storage/postgres-record-codecs.ts";

async function rejects(work: Promise<unknown>, message: string): Promise<void> {
  const error: unknown = await work.then(() => null, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  if (error instanceof Error) expect(error.message).toContain(message);
}

async function fixture() {
  const crypto = new LatticeCrypto();
  const device = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const namespaceKey = crypto.randomBytes(32);
  const descriptor: BackgroundProcessorWorkDescriptorV2 = {
    formatVersion: 2, requestId: "request-1", recipientGeneration: 0, workKind: "stenographer.extraction", workId: "work-1",
    anchorNamespaceId: "namespace-1", anchorDomainId: "domain-1",
    subject: {kind: "processor", processorKind: "stenographer", processorVersion: 1},
    operations: ["decrypt", "encrypt"], purpose: "journal.extract",
    authority: {serverId: "server-scope", roomId: "room-1", namespaceId: "namespace-1", namespaceAccessRevision: 2,
      namespaceKeyGeneration: 1, namespaceHeadDigest: new Uint8Array(32).fill(1), domainId: "domain-1",
      domainKeyGeneration: 3, domainAuthorizationRevision: 4, domainHeadDigest: new Uint8Array(32).fill(2),
      bundleRevision: 5, bundleDigest: new Uint8Array(32).fill(3)},
    policyRevision: 6, source: {kind: "stenographer_work", startSequence: 10, endSequence: 12, rebuildGeneration: 0, fingerprint: new Uint8Array(32).fill(4)},
    inputBindings: [{objectId: "input-1", namespaceId: "namespace-1"}],
    outputSlots: [{objectId: "record-1", objectType: "nautilo.reflection.record.v1", createdAt: 1000,
      namespaceIds: ["namespace-1"]}],
    maximumPlaintextBytes: 512_000, maximumCiphertextBytes: 1_024_000,
    recipientKeyId: "recipient-1", recipientPublicKey: recipient.publicKey, issuedAt: 1000, notBefore: 1000,
    expiresAt: 301_000, idempotencyId: "idempotency-1",
  };
  const issuer = {humanId: "human-1", deviceId: "device-1", deviceGeneration: 2, serverInstanceId: "instance-uuid",
    lineageGeneration: 3, epoch: 4, securityRevision: 57, headDigest: new Uint8Array(32).fill(7), signingPublicKeyHash: crypto.hash(device.publicKey)};
  const responseBytes = await createBackgroundAuthorizationResponseV2(crypto, {credentialId: "credential-1",
    descriptorBytes: encodeBackgroundWorkDescriptorV2(descriptor), issuer, issuerSigningPrivateKey: device.privateKey, domainKey: crypto.randomBytes(32)});
  const response = decodeBackgroundAuthorizationResponseV2(responseBytes);
  const cert = verifyHistoricalProcessorSignerAuthorizationV2(crypto, {authorizationBytes: response.signerAuthorizationBytes, resolveHistoricalIssuer: () => device.publicKey});
  const c = cert.certificate;
  const evidence: Record<string, DatabaseScalar> = {
    authorization_id: c.credentialId, format_version: 2, request_id: descriptor.requestId, recipient_generation: 0,
    processor_kind: "stenographer", processor_version: 1, work_id: descriptor.workId, namespace_id: descriptor.authority.namespaceId,
    domain_id: descriptor.authority.domainId, domain_epoch: null, namespace_access_revision: 2, policy_revision: 6,
    processor_authorization_revision: null, issuing_human_id: issuer.humanId, issuing_device_id: issuer.deviceId,
    issuing_device_authorization_revision: issuer.securityRevision, issuer_signing_public_key_hash: issuer.signingPublicKeyHash,
    signer_key_id: c.signer.signerKeyId, signer_public_key: c.signerPublicKey, work_descriptor_hash: c.descriptorHash,
    work_descriptor_bytes: c.descriptorBytes, authorization_hash: cert.authorizationHash, credential_hash: c.credentialHash,
    authorization_bytes: response.signerAuthorizationBytes, issued_at: new Date(1000), expires_at: new Date(301_000), created_at: new Date(1001),
  };
  const deviceRow: Record<string, DatabaseScalar> = {device_id: issuer.deviceId, human_id: issuer.humanId, device_generation: 2,
    signing_public_key: Buffer.from(device.publicKey), state: "revoked", revision: 1};
  const request: Record<string, DatabaseScalar> = {
    format_version: 2, state: "running", request_id: descriptor.requestId, idempotency_key: descriptor.idempotencyId, claim_id: "claim-1",
    recipient_generation: 0, work_id: descriptor.workId, work_kind: descriptor.workKind, purpose: descriptor.purpose,
    namespace_id: descriptor.authority.namespaceId, domain_id: descriptor.authority.domainId, credential_subject_kind: "processor",
    processor_kind: "stenographer", processor_version: 1, processor_authorization_revision: null, expected_domain_epoch: null,
    agent_id: null, agent_runtime_generation: null, agent_authorization_revision: null,
    expected_namespace_access_revision: 2, expected_policy_revision: 6, descriptor_hash: c.descriptorHash, descriptor_bytes: c.descriptorBytes,
    accepted_response_hash: crypto.hash(responseBytes), accepted_response_kind: "processor", accepted_response_bytes: responseBytes,
    credential_id: c.credentialId, credential_hash: c.credentialHash, recipient_key_id: descriptor.recipientKeyId,
    recipient_public_key: recipient.publicKey, recipient_expires_at: new Date(descriptor.expiresAt),
    issuing_human_id: issuer.humanId, issuing_device_id: issuer.deviceId, issuing_device_authorization_revision: issuer.securityRevision,
    issuer_signing_public_key_hash: issuer.signingPublicKeyHash, authorization_expires_at: new Date(descriptor.expiresAt), claim_expires_at: new Date(20_000),
    transform_commit_claim_id: null, transform_commit_descriptor_hash: null, transform_commit_recipient_generation: null,
    transform_commit_output_count: null, transform_committed_at: null,
  };
  const queries: string[] = [];
  let committed: readonly {sql: string; parameters: readonly DatabaseScalar[]}[] = [];
  let failInsert = false;
  let storedInput: 4 | 5 | undefined;
  const query = async <Row extends DatabaseRow>(sql: string): Promise<readonly Row[]> => {
    queries.push(sql);
    const normalized = sql.replaceAll('"', "").toLowerCase();
    if (normalized.includes("current_user::text")) return [{current_user: "nautilo_crypto", session_user: "nautilo_crypto"}] as unknown as Row[];
    if (normalized.includes("pg_advisory_xact_lock")) return [];
    if (normalized.includes("from processor_crypto_signer_authorizations")) return [evidence] as Row[];
    if (normalized.includes("from human_crypto_devices")) return [deviceRow] as Row[];
    if (normalized.includes("from background_crypto_authorization_requests")) return [request] as Row[];
    if (storedInput !== undefined) {
      const manifestBytes = storedInput === 4 ? output.v4 : output.v5;
      if (normalized.includes("from crypto_objects")) return [{object_id: output.objectId, payload_hash: crypto.hash(output.payloadBytes), payload_bytes: output.payloadBytes}] as unknown as Row[];
      if (normalized.includes("from object_crypto_access_heads")) return [{object_id: output.objectId, access_revision: 0,
        manifest_hash: crypto.hash(manifestBytes), previous_manifest_hash: null, payload_hash: crypto.hash(output.payloadBytes), manifest_bytes: manifestBytes}] as unknown as Row[];
      if (normalized.includes("from object_crypto_namespace_envelopes")) return [{namespace_id: "namespace-1", ordinal: 0,
        envelope_hash: crypto.hash(output.envelopeBytes), envelope_bytes: output.envelopeBytes}] as unknown as Row[];
    }
    if (normalized.includes("from crypto_objects") || normalized.includes("from object_crypto_")) return [];
    throw new Error(`Unexpected query: ${sql}`);
  };
  const connection: CryptoPostgresConnection = {query, transaction: async (use) => use({query})};
  const handle = await verifyCryptoPostgresHandle(connection);
  let authorityCalls = 0;
  let held = false;
  const withCurrentAuthority: WithCurrentProcessorPublicationAuthority = async ({use}) => {
    if (held) throw new Error("Nested current authority transaction");
    held = true; authorityCalls++;
    const writes: {sql: string; parameters: readonly DatabaseScalar[]}[] = [];
    const executor: CryptoPostgresExecutor = {query: async <Row extends DatabaseRow>(sql: string, parameters: readonly DatabaseScalar[] = []) => {
      const normalized = sql.replaceAll('"', "").toLowerCase();
      if (normalized.startsWith("insert into") || normalized.startsWith("update ")) {
        if (failInsert) throw new Error("injected persistence failure");
        writes.push({sql, parameters: structuredClone(parameters)});
        return (normalized.startsWith("update ") ? [{request_id: descriptor.requestId}] : []) as unknown as Row[];
      }
      return query<Row>(sql);
    }};
    try {const result = await use({executor, issuerSigningPublicKey: device.publicKey}); committed = [...committed, ...writes]; return result;}
    finally {held = false;}
  };
  const domainKeys: Parameters<typeof createPostgresCurrentProcessorTransformObjectPort>[0]["domainKeys"] = {
    inspectForegroundNamespaceAuthority: async () => {throw new Error("not used");},
    withOpenedForegroundNamespaceKey: async () => {throw new Error("not used");},
  };
  const port = createPostgresCurrentProcessorTransformObjectPort({handle, crypto, responseBytes, domainKeys, withCurrentAuthority});
  const output = await withOpenedBackgroundAuthorizationV2(crypto, {responseBytes, recipientPrivateKey: recipient.privateKey,
    now: () => 1002, resolveCurrentIssuer: () => device.publicKey, use: ({verified, signerPrivateKey}) => {
      const encrypted = encryptObjectPayload(crypto, {objectId: objectId("record-1"), keyClass: "ai",
        objectType: "nautilo.reflection.record.v1", createdAt: unixTimestamp(1000)}, new TextEncoder().encode("reflection"));
      const envelope = wrapObjectDekForNamespace(crypto, namespaceKey, {objectId: objectId("record-1"), namespaceId: namespaceId("namespace-1"),
        keyClass: "ai", keyGeneration: namespaceGeneration(1), bindingRevisionAtWrap: accessRevision(2)}, encrypted.dek);
      encrypted.dek.fill(0);
      const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
      const envelopeBytes = encodeNamespaceObjectEnvelopeV2(envelope);
      const unsigned = {objectId: objectId("record-1"), payloadHash: crypto.hash(payloadBytes), accessRevision: accessRevision(0), previousManifestHash: null,
        envelopeHashes: [crypto.hash(envelopeBytes)], signer: verified.signer, signerAuthorizationHash: verified.signerAuthorizationHash,
        hostAuthorizationRevision: authorizationRevision(issuer.securityRevision)};
      const signing = {signerPrivateKey, signerAuthorizationBytes: response.signerAuthorizationBytes, issuerSigningPublicKey: device.publicKey, now: 1002};
      const legacy = createCurrentProcessorObjectAccessManifestV4(crypto, unsigned, signing);
      const manifest = createCurrentCommonProcessorObjectAccessManifest(crypto, unsigned, signing);
      const tombstone = createCurrentCommonProcessorObjectAccessManifest(crypto, {...unsigned, accessRevision: accessRevision(1), previousManifestHash: manifest.hash, envelopeHashes: []}, signing);
      const v5 = encodeObjectAccessManifestV5({...unsigned, formatVersion: 5, signature: signProcessorObjectBytesV1(crypto, {
        principal: verified.signer, signerPrivateKey, message: objectAccessManifestSigningBytesV5(unsigned)})});
      return {v5, v4: legacy.bytes, objectId: "record-1", payloadBytes, envelopeBytes, manifestBytes: manifest.bytes, tombstoneManifestBytes: tombstone.bytes,
        signerAuthorizationBytes: response.signerAuthorizationBytes};
    }});
  const inspectedContext = inspectBackgroundAuthorizationResponseV2(responseBytes);
  const context = {
    ...inspectedContext,
    descriptor: decodeBackgroundProcessorWorkDescriptorV2(c.descriptorBytes),
  };
  const publish = (outputs: Parameters<typeof port.objects.publishOutputs>[0]["outputs"] = [output], authorizeCommit = async () => {
    expect(await port.resolveCurrentIssuer(context)).toEqual(device.publicKey);
    return 1003;
  }) => port.objects.publishOutputs({idempotencyId: descriptor.idempotencyId, claimId: "claim-1", authorityCheckedAt: 1002,
    signal: new AbortController().signal, outputs, authorizeCommit});
  return {crypto, evidence, deviceRow, request, response, responseBytes, device, context, port, publish, output, queries, handle, domainKeys, withCurrentAuthority,
    storeInput: (version: 4 | 5) => {storedInput = version;},
    executor: {query} satisfies CryptoPostgresExecutor, authorityCalls: () => authorityCalls, committed: () => committed,
    failInsert: () => {failInsert = true;}};
}

describe("retained current processor certificate", () => {
  test("survives request pruning and device revocation without comparing unrelated revisions", async () => {
    const f = await fixture();
    const value = await loadVerifiedCurrentProcessorSignerAuthorization(f.executor, f.crypto, Buffer.from(f.response.signerAuthorizationBytes));
    expect(value.certificate.issuer.securityRevision).toBe(57);
    expect(value.certificate.issuer.deviceGeneration).toBe(2);
    expect(f.queries.some((sql) => sql.includes("background_crypto_authorization_requests"))).toBe(false);
    destroyVerifiedCurrentProcessorSignerEvidence(value);
    expect(value.issuerPublicKey.every((byte) => byte === 0)).toBe(true);
    expect(f.deviceRow["signing_public_key"]).toEqual(Buffer.from(f.device.publicKey));
    expect(f.response.signerAuthorizationBytes.some((byte) => byte !== 0)).toBe(true);
  });
  test("rejects substituted durable anchors, immutable key identity, and acceptance outside the grant", async () => {
    for (const [table, field, value] of [
      ["evidence", "work_id", "other"], ["evidence", "domain_epoch", 1], ["evidence", "processor_authorization_revision", 57],
      ["evidence", "issuing_device_authorization_revision", 1], ["evidence", "created_at", new Date(301_000)],
      ["evidence", "credential_hash", new Uint8Array(32)], ["deviceRow", "device_generation", 3],
      ["deviceRow", "signing_public_key", new Uint8Array(32)],
    ] as const) {
      const f = await fixture(); f[table][field] = value;
      await rejects(loadVerifiedCurrentProcessorSignerAuthorization(f.executor, f.crypto, f.response.signerAuthorizationBytes), "");
      expect(f.response.signerAuthorizationBytes.some((byte) => byte !== 0)).toBe(true);
    }
  });
});

describe("current PostgreSQL processor publication", () => {
  test("publishes with PostgreSQL textual request deadlines and retained signer timestamps", async () => {
    const f = await fixture();
    for (const row of [f.request, f.evidence]) {
      for (const [field, value] of Object.entries(row)) {
        if (value instanceof Date) row[field] = value.toISOString().replace("T", " ").replace("Z", "+00");
      }
    }
    await f.publish();
    expect(f.committed()).toHaveLength(6);
    expect(f.authorityCalls()).toBe(1);
  });
  test("textual timestamps preserve exact certificate and deadline checks", async () => {
    for (const [table, field, value] of [
      ["request", "claim_expires_at", "1970-01-01 00:00:01.003+00"],
      ["request", "recipient_expires_at", "1970-01-01 00:05:02+00"],
      ["request", "authorization_expires_at", "1970-01-01 00:05:02+00"],
      ["evidence", "issued_at", "1970-01-01 00:00:02+00"],
      ["evidence", "expires_at", "1970-01-01 00:05:02+00"],
      ["evidence", "created_at", "1970-01-01 00:05:01+00"],
    ] as const) {
      const f = await fixture(); f[table][field] = value;
      await rejects(f.publish(), "");
      expect(f.committed()).toHaveLength(0);
    }
  });
  test("rejects missing, invalid, and numeric durable timestamps before publication", async () => {
    for (const [table, fields] of [["request", ["recipient_expires_at", "authorization_expires_at", "claim_expires_at"]],
      ["evidence", ["issued_at", "expires_at", "created_at"]]] as const) {
      for (const field of fields) for (const value of [null, "not-a-timestamp", 1001]) {
        const f = await fixture(); f[table][field] = value;
        await rejects(f.publish(), "");
        expect(f.committed()).toHaveLength(0);
      }
    }
  });
  test("stores exact bytes, both signed manifests, and one marker under held authority without nested lookup", async () => {
    const f = await fixture();
    await f.publish();
    expect(f.authorityCalls()).toBe(1);
    expect(f.committed()).toHaveLength(6);
    expect(f.committed().filter((write) => write.sql.includes("transform_committed_at"))).toHaveLength(1);
    expect(f.committed()[0]!.parameters).toContainEqual(f.output.payloadBytes);
    expect(f.output.payloadBytes.some((byte) => byte !== 0)).toBe(true);
    await rejects(f.publish(), "unavailable");
  });
  test("empty output prefixes still verify accepted evidence and durably mark completion", async () => {
    const f = await fixture(); await f.publish([]);
    expect(f.committed()).toHaveLength(1);
    expect(f.committed()[0]!.parameters[3]).toBe(0);
  });
  test("rejects request/certificate/claim substitution before any write", async () => {
    for (const [field, value] of [["claim_id", "other"], ["accepted_response_bytes", new Uint8Array([1])],
      ["credential_id", "other"], ["expected_domain_epoch", 3], ["recipient_generation", 1], ["claim_expires_at", new Date(1003)]] as const) {
      const f = await fixture(); f.request[field] = value;
      await rejects(f.publish(), ""); expect(f.committed()).toHaveLength(0);
    }
  });
  test("rejects output widening and modified signed bytes before any write", async () => {
    for (const output of ["objectId", "manifestBytes", "tombstoneManifestBytes", "signerAuthorizationBytes"] as const) {
      const f = await fixture();
      const changed = {...f.output, [output]: output === "objectId" ? "other" : new Uint8Array([1])};
      await rejects(f.publish([changed]), ""); expect(f.committed()).toHaveLength(0);
    }
  });
  test("commit reauthorization failure and persistence failure roll back all publication writes", async () => {
    const f = await fixture();
    await rejects(f.publish([f.output], async () => {throw new Error("revoked");}), "revoked");
    expect(f.committed()).toHaveLength(0);
    f.failInsert(); await rejects(f.publish(), "persistence"); expect(f.committed()).toHaveLength(0);
  });
  test("abort during commit authorization leaves no durable writes", async () => {
    const f = await fixture(); const controller = new AbortController();
    await rejects(f.port.objects.publishOutputs({idempotencyId: "idempotency-1", claimId: "claim-1", authorityCheckedAt: 1002,
      signal: controller.signal, outputs: [f.output], authorizeCommit: async () => {
        expect(await f.port.resolveCurrentIssuer(f.context)).toEqual(f.device.publicKey);
        controller.abort(new Error("cancelled")); return 1003;
      }}), "cancelled");
    expect(f.committed()).toHaveLength(0);
  });
  test("partial or conflicting durable completion markers never authorize another commit", async () => {
    for (const marker of [{transform_commit_claim_id: "claim-1"}, {
      transform_commit_claim_id: "claim-1", transform_commit_descriptor_hash: new Uint8Array(32),
      transform_commit_recipient_generation: 0, transform_commit_output_count: 1, transform_committed_at: new Date(1003),
    }]) {
      const f = await fixture(); Object.assign(f.request, marker);
      let authorized = false;
      await rejects(f.publish([f.output], () => {authorized = true; return Promise.resolve(1003);}), "marker conflicts");
      expect(authorized).toBe(false); expect(f.committed()).toHaveLength(0);
    }
  });
  test("scoped commit permit cannot be reused or borrowed for another signed context", async () => {
    const f = await fixture();
    await f.publish([f.output], async () => {
      expect(await f.port.resolveCurrentIssuer({...f.context, issuer: {...f.context.issuer, securityRevision: 58}})).toBeNull();
      expect(await f.port.resolveCurrentIssuer(f.context)).toEqual(f.device.publicKey);
      await rejects(Promise.resolve(f.port.resolveCurrentIssuer(f.context)), "unavailable");
      return 1003;
    });
    expect(f.authorityCalls()).toBe(1);
  });
});


describe("current processor input authority dispatch", () => {
  test("reads a current V2 certificate behind a V4 historical input after device revocation", async () => {
    const f = await fixture(); f.storeInput(4);
    const port = createPostgresProcessorTransformObjectPort({handle: f.handle, crypto: f.crypto});
    const opened = await port.openInput({objectId: "record-1", signal: new AbortController().signal});
    expect(opened.payload.context.objectId).toBe(objectId("record-1"));
    expect(opened.envelope.context.namespaceId).toBe(namespaceId("namespace-1"));
  });
  test("V5 requires the existing stored-chain owner and verifies its exact returned head", async () => {
    const f = await fixture(); f.storeInput(5);
    const plain = createPostgresProcessorTransformObjectPort({handle: f.handle, crypto: f.crypto});
    const request = {objectId: "record-1", signal: new AbortController().signal};
    await rejects(plain.openInput(request), "V5 processor input verification is unavailable");
    let substitute = false;
    let borrowed: Uint8Array | undefined;
    const port = createPostgresProcessorTransformObjectPort({handle: f.handle, crypto: f.crypto,
      verifyV5Input: (input) => {
        expect(input.objectId).toBe("record-1"); expect(input.headAccessRevision).toBe(0);
        expect(input.expectedPayloadHash).toEqual(f.crypto.hash(f.output.payloadBytes));
        expect(input.expectedHeadManifestHash).toEqual(f.crypto.hash(f.output.v5));
        borrowed = new Uint8Array(f.output.v5);
        return Promise.resolve({objectId: substitute ? "other" : "record-1", payloadHash: f.crypto.hash(f.output.payloadBytes),
          headManifest: decodeObjectAccessManifestV5(f.output.v5), headManifestBytes: borrowed,
          headManifestHash: f.crypto.hash(f.output.v5), genesisHumanId: null,
          headSignerPublicKey: new Uint8Array(32), signerEvidence: []});
      }});
    expect((await port.openInput(request)).payload.context.objectId).toBe(objectId("record-1"));
    expect(borrowed?.every((byte) => byte === 0)).toBe(true);
    substitute = true; await rejects(port.openInput(request), "substituted head");
    expect(borrowed?.every((byte) => byte === 0)).toBe(true);
  });
  test("an abort while loading the Namespace snapshot wipes the late snapshot without opening a key", async () => {
    const f = await fixture(); const controller = new AbortController();
    const authority = f.context.descriptor.authority;
    const snapshot = {...structuredClone(authority), status: "ready" as const,
      namespacePublicationDigest: new Uint8Array(32).fill(8), namespacePublicationSetDigest: new Uint8Array(32).fill(9),
      namespaceAudienceFingerprint: new Uint8Array(32).fill(10)};
    const port = createPostgresCurrentProcessorTransformObjectPort({handle: f.handle, crypto: f.crypto,
      responseBytes: f.responseBytes, withCurrentAuthority: f.withCurrentAuthority, domainKeys: {
        inspectForegroundNamespaceAuthority: () => {controller.abort(new Error("cancelled")); return Promise.resolve(snapshot);},
        withOpenedForegroundNamespaceKey: () => {throw new Error("key must not open");},
      }});
    await rejects(port.objects.withNamespaceKey({authority, domainKey: new Uint8Array(32), keyClass: "ai",
      generation: 0, accessRevision: 1, signal: controller.signal}, () => "must not use"), "cancelled");
    expect(snapshot.bundleDigest.every((byte) => byte === 0)).toBe(true);
    expect(snapshot.namespacePublicationDigest.every((byte) => byte === 0)).toBe(true);
    expect(f.authorityCalls()).toBe(0);
  });
  test("Namespace opening delegates retained generation selection outside publication authority locks", async () => {
    const f = await fixture();
    const authority = f.context.descriptor.authority;
    const snapshot = {...structuredClone(authority), status: "ready" as const,
      namespacePublicationDigest: new Uint8Array(32).fill(8), namespacePublicationSetDigest: new Uint8Array(32).fill(9),
      namespaceAudienceFingerprint: new Uint8Array(32).fill(10)};
    const key = f.crypto.randomBytes(32);
    const port = createPostgresCurrentProcessorTransformObjectPort({handle: f.handle, crypto: f.crypto,
      responseBytes: f.responseBytes, withCurrentAuthority: f.withCurrentAuthority, domainKeys: {
        inspectForegroundNamespaceAuthority: () => Promise.resolve(snapshot),
        withOpenedForegroundNamespaceKey: async (request) => {
          expect(request.keyGeneration).toBe(0); expect(request.accessRevision).toBe(1);
          expect(request.authority.namespacePublicationSetDigest).toEqual(new Uint8Array(32).fill(9));
          return request.use(key);
        },
      }});
    const result = await port.objects.withNamespaceKey({authority, domainKey: new Uint8Array(32), keyClass: "ai",
      generation: 0, accessRevision: 1, signal: new AbortController().signal}, async (opened) => {
        expect(opened).toBe(key);
        expect(await port.resolveCurrentIssuer(f.context)).toEqual(f.device.publicKey);
        return "opened";
      });
    expect(result).toBe("opened"); expect(f.authorityCalls()).toBe(1);
    expect(snapshot.bundleDigest.every((byte) => byte === 0)).toBe(true);
    expect(key.some((byte) => byte !== 0)).toBe(true);
  });
});

describe("current committed-output storage boundary", () => {
  test("reopens only actually committed IDs using historical verification and allows fresh postcommit authority checks", async () => {
    const f = await fixture();
    const request = {objectId: "record-1", signal: new AbortController().signal};
    await rejects(f.port.objects.openPublishedOutput(request), "outside its committed prefix");
    await f.publish(); f.storeInput(4);
    const loaded = await f.port.objects.openPublishedOutput(request);
    expect(loaded.payload.context.objectId).toBe(objectId("record-1"));
    expect(loaded.envelope.context.namespaceId).toBe(namespaceId("namespace-1"));
    expect(await f.port.resolveCurrentIssuer(f.context)).toEqual(f.device.publicKey);
    expect(f.authorityCalls()).toBe(2);
    await rejects(f.port.objects.openPublishedOutput({...request, objectId: "input-1"}), "outside its committed prefix");
    await rejects(f.port.objects.openInput({...request, objectId: "input-1"}), "outside its attempt");
    await rejects(f.publish(), "unavailable");
  });
  test("an empty committed prefix cannot open an otherwise authorized unused output slot", async () => {
    const f = await fixture(); await f.publish([]); f.storeInput(4);
    await rejects(f.port.objects.openPublishedOutput({objectId: "record-1", signal: new AbortController().signal}), "outside its committed prefix");
    expect(f.committed()).toHaveLength(1);
  });
  test("postcommit reads reject storage corruption and cancelled reads", async () => {
    const f = await fixture(); await f.publish(); f.storeInput(4);
    f.output.payloadBytes[f.output.payloadBytes.length - 1]! ^= 1;
    await rejects(f.port.objects.openPublishedOutput({objectId: "record-1", signal: new AbortController().signal}), "durable hashes");
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    await rejects(f.port.objects.openPublishedOutput({objectId: "record-1", signal: controller.signal}), "cancelled");
  });
});


async function reconciliationFixture() {
  const f = await fixture();
  const binding: ProcessorPublicationReconciliationBindingV2 = {originalRequestId: f.context.descriptor.requestId,
    originalWorkId: f.context.descriptor.workId, originalRecipientGeneration: 0,
    originalDescriptorHash: f.context.descriptorHash, attachmentPlanHash: new Uint8Array(32).fill(9),
    outputs: [{objectId: f.output.objectId, objectType: "nautilo.reflection.record.v1", createdAt: 1000,
      payloadHash: f.crypto.hash(f.output.payloadBytes), envelopeHash: f.crypto.hash(f.output.envelopeBytes)}]};
  const descriptor: BackgroundProcessorWorkDescriptorV2 = {...f.context.descriptor,
    requestId: "fresh-reconciliation", workId: "reconcile:request-1", idempotencyId: "reconcile-idempotency",
    workKind: "stenographer.publication_reconcile", purpose: "journal.reconcile",
    source: {...f.context.descriptor.source, fingerprint: publicationReconciliationFingerprintV2(f.crypto, binding)},
    operations: ["decrypt"],
    inputBindings: [{objectId: f.output.objectId, namespaceId: f.context.descriptor.anchorNamespaceId}], outputSlots: []};
  const descriptorBytes = encodeBackgroundWorkDescriptorV2(descriptor);
  const responseBytes = await createBackgroundAuthorizationResponseV2(f.crypto, {credentialId: "fresh-credential",
    descriptorBytes, issuer: f.context.issuer, issuerSigningPrivateKey: f.device.privateKey, domainKey: f.crypto.randomBytes(32)});
  const decoded = decodeBackgroundAuthorizationResponseV2(responseBytes);
  Object.assign(f.request, {request_id: descriptor.requestId, work_id: descriptor.workId, idempotency_key: descriptor.idempotencyId,
    work_kind: descriptor.workKind, purpose: descriptor.purpose, descriptor_bytes: descriptorBytes, descriptor_hash: f.crypto.hash(descriptorBytes),
    accepted_response_hash: f.crypto.hash(responseBytes), accepted_response_bytes: responseBytes,
    credential_hash: f.crypto.hash(decoded.credentialBytes), credential_id: "fresh-credential"});
  let attached = 0;
  const port = createPostgresCurrentProcessorTransformObjectPort({handle: f.handle, crypto: f.crypto, responseBytes,
    domainKeys: f.domainKeys, withCurrentAuthority: f.withCurrentAuthority,
    reconciliation: {binding, attach: async ({outputs, held, authorizedAt}) => {
      expect(outputs.map(output => output.objectId)).toEqual([f.output.objectId]);
      expect(held.issuerSigningPublicKey).toEqual(f.device.publicKey);
      expect(authorizedAt).toBe(1003);
      attached++;
    }}});
  const inspectedContext = inspectBackgroundAuthorizationResponseV2(responseBytes);
  const context = {
    ...inspectedContext,
    descriptor: decodeBackgroundProcessorWorkDescriptorV2(descriptorBytes),
  };
  const outputs = [{objectId: f.output.objectId, plaintext: new Uint8Array([1, 2, 3])}];
  const attach = (claimId = "claim-1") => port.reconciliationObjects!.attach({outputs, claimId,
    signal: new AbortController().signal, authorizeCommit: async () => {
      expect(await port.resolveCurrentIssuer(context)).toEqual(f.device.publicKey);
      return 1003;
    }});
  return {f, port, binding, outputs, attach, attached: () => attached};
}

describe("current reconciliation attachment storage fence", () => {
  test("uses the held exact fresh authority once and never inserts encrypted outputs or a transform marker", async () => {
    const t = await reconciliationFixture();
    await t.attach();
    expect(t.attached()).toBe(1);
    expect(t.f.authorityCalls()).toBe(1);
    expect(t.f.committed()).toEqual([]);
    await rejects(t.attach(), "unavailable");
    expect(t.attached()).toBe(1);
  });

  test.each(["claim_id", "work_id", "accepted_response_hash", "transform_commit_output_count"])(
    "refuses substituted %s before product attachment", async field => {
      const t = await reconciliationFixture();
      t.f.request[field] = field === "accepted_response_hash" ? new Uint8Array(32)
        : field === "transform_commit_output_count" ? 0 : "substituted";
      await rejects(t.attach(), "");
      expect(t.attached()).toBe(0);
      expect(t.f.committed()).toEqual([]);
    });

  test("claim expiry and changed output inventory cannot borrow attachment authority", async () => {
    const expired = await reconciliationFixture();
    expired.f.request["claim_expires_at"] = new Date(1003);
    await rejects(expired.attach(), "expired");
    expect(expired.attached()).toBe(0);
    const changed = await reconciliationFixture();
    changed.outputs[0]!.objectId = "other-output";
    await rejects(changed.attach(), "unavailable");
    expect(changed.f.authorityCalls()).toBe(0);
  });

  test("reconciliation has no encrypted-output publication path", async () => {
    const t = await reconciliationFixture();
    await rejects(t.port.objects.publishOutputs({idempotencyId: "reconcile-idempotency", claimId: "claim-1",
      outputs: [], authorityCheckedAt: 1002, authorizeCommit: async () => 1003, signal: new AbortController().signal}), "unavailable");
    expect(t.f.authorityCalls()).toBe(0);
  });
});
