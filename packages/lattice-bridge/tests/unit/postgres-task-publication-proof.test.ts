import { expect, test } from "bun:test";
import { withPublicationSigner, PUBLICATION_NAMESPACE, PUBLICATION_NOW, publicationBytes } from "../../../lattice-crypto/tests/fixtures/task-publication-signer.ts";
import { accessRevision, namespaceGeneration, namespaceId, objectId, authorizationRevision, unixTimestamp, encryptObjectPayload,
  prepareDeviceWrappedLiveShadowAgentObjectAccessManifestGenesis, prepareDeviceWrappedAgentObjectAccessManifestGenesisSet,
  persistPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesis, persistPreparedDeviceWrappedAgentObjectAccessManifestGenesisSet,
  wrapObjectDekForNamespace } from "@nautilo/lattice-crypto";
import { encodeEncryptedPayloadV2, encodeNamespaceObjectEnvelopeV2, agentRuntimeObjectSignerKeyIdV1 } from "@nautilo/lattice-crypto/wire";
import { PostgresLatticeStorage, verifyCryptoPostgresHandle, type CryptoPostgresConnection } from "@nautilo/lattice-bridge/server";

for (const set of [false, true]) test(`certified wake ${set ? "entity set" : "transcript"} CAS inserts public proof atomically`, async () => {
  await withPublicationSigner(async ({ crypto, signer, evidence, domain }) => {
    const target = objectId("object:publication-storage");
    const encrypted = encryptObjectPayload(crypto, { objectId: target, keyClass: "ai", objectType: "test-record", createdAt: unixTimestamp(PUBLICATION_NOW) }, publicationBytes(0x41));
    const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
    const envelopeBytes = encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespace(crypto, publicationBytes(0x42), {
      objectId: target, namespaceId: namespaceId(PUBLICATION_NAMESPACE), keyClass: "ai", keyGeneration: namespaceGeneration(3), bindingRevisionAtWrap: accessRevision(4),
    }, encrypted.dek));
    encrypted.dek.fill(0);
    const namespace = { namespaceId: PUBLICATION_NAMESPACE, accessRevision: 4, keyGeneration: 3,
      domainId: domain.domainId, domainKeyGeneration: domain.domainKeyGeneration, domainAuthorizationRevision: domain.authorizationRevision,
      domainHeadDigest: domain.headDigest, headDigest: publicationBytes(0x44), publicationDigest: publicationBytes(0x44),
      publicationSetDigest: publicationBytes(0x44), audienceFingerprint: publicationBytes(0x44) };
    const input = { objectId: target, payloadHash: crypto.hash(payloadBytes), envelopeBytes: [envelopeBytes] as const,
      operationId: evidence.invocation.operationId,
      grant: { grantId: evidence.requestId, grantHash: evidence.authorizationDigest, recipientKeyId: evidence.recipientKeyId },
      runtime: signer.runtime, signerKeyId: agentRuntimeObjectSignerKeyIdV1(crypto, signer.signerPublicKey), signerPublicKey: signer.signerPublicKey,
      agentAuthorizationRevision: 0, taskRuntimeSigner: { evidence, signer } };
    const single = prepareDeviceWrappedLiveShadowAgentObjectAccessManifestGenesis(crypto, { ...input, namespace });
    const multiple = prepareDeviceWrappedAgentObjectAccessManifestGenesisSet(crypto, { ...input, namespaces: [namespace] });
    const inserts: Readonly<{ sql: string; parameters: readonly unknown[] }>[] = [];
    let transactions = 0;
    let drift = false;
    const query: CryptoPostgresConnection["query"] = <Row>(sql: string, parameters: readonly unknown[] = []) => {
      const normalized = sql.replaceAll('"', "").toLowerCase();
      let rows: unknown[];
      if (normalized.includes("current_user::text")) rows = [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }];
      else if (normalized.includes("pg_advisory_xact_lock")) rows = [];
      else if (normalized.includes("from crypto_objects")) rows = [{ object_id: target, payload_bytes: payloadBytes, payload_hash: crypto.hash(payloadBytes) }];
      else if (normalized.includes("from object_crypto_access_heads")) rows = [];
      else if (normalized.includes("from namespace_domain_key_heads")) rows = [{ domain_id: domain.domainId,
        domain_key_generation: domain.domainKeyGeneration, domain_authorization_revision: domain.authorizationRevision,
        domain_head_digest: domain.headDigest, namespace_current_generation: 3, namespace_access_revision: drift ? 5 : 4,
        retained_authority_set_digest: namespace.headDigest, state: "active" }];
      else if (normalized.startsWith("insert into")) {
        if (normalized.includes("object_crypto_access_manifests")) inserts.push({ sql, parameters });
        rows = [];
      } else throw new Error(`Unexpected crypto query: ${normalized}`);
      return Promise.resolve(rows as Row[]);
    };
    const connection: CryptoPostgresConnection = { query, transaction: async use => { transactions++; return use(connection); } };
    const storage = new PostgresLatticeStorage(await verifyCryptoPostgresHandle(connection));
    const decision = { grantAuthorized: true, agentAuthorized: true, hostAllowsOperation: true,
      signerPublicKey: signer.signerPublicKey,
      currentRuntime: { agentId: signer.runtime.agentId, runtimeGeneration: signer.runtime.generation, authorizationRevision: authorizationRevision(0) } };
    const persist = () => set ? persistPreparedDeviceWrappedAgentObjectAccessManifestGenesisSet({ crypto, storage, prepared: multiple,
      resolveCurrentAuthorization: context => ({ ...decision, context, namespacesAuthorized: true }) })
      : persistPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesis({ crypto, storage, prepared: single,
        resolveCurrentAuthorization: context => ({ ...decision, context, namespaceAuthorized: true }) });
    expect(await persist()).toBe("applied");
    expect(transactions).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.sql).toContain('"signer_evidence_bytes"');
    expect(inserts[0]!.parameters.some(value => value instanceof Uint8Array && value.length === signer.certificateBytes.length
      && value.every((byte, index) => byte === signer.certificateBytes[index]))).toBe(true);
    drift = true;
    expect(await persist()).toBe("stale");
    expect(inserts).toHaveLength(1);
  });
});
