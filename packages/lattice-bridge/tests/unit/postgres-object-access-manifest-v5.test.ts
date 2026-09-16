import { describe, expect, test } from "bun:test";

import {
  LatticeCrypto,
  createCommonAgentObjectAccessManifest,
  createCommonHumanObjectAccessManifest,
  createCommonProcessorObjectAccessManifest,
  deriveAgentRuntimeObjectSignerPublic,
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceId,
  objectId,
} from "@nautilo/lattice-crypto";
import { seededRng } from "@nautilo/lattice-crypto/testing";
import {
  AGENT_RUNTIME_SIGNER_PUBLICATION_FORMAT_VERSION_V1,
  PROCESSOR_SIGNER_AUTHORIZATION_FORMAT_VERSION_V1,
  agentRuntimeSignerPublicationSigningBytesV1,
  createProcessorObjectSignerPublicV1,
  createProcessorSignerAuthorizationV1,
  encodeAgentRuntimeSignerPublicationV1,
  type AgentRuntimeSignerPublicationUnsignedV1,
} from "@nautilo/lattice-crypto/wire";

import {
  verifyStoredObjectAccessManifestChainV5,
} from "../../src/server/storage/postgres-object-access-manifest-v5.ts";
import type {
  CryptoPostgresExecutor,
} from "../../src/server/storage/postgres-lattice-storage.ts";
import type {
  DatabaseRow,
  DatabaseScalar,
} from "../../src/server/storage/postgres-record-codecs.ts";

function hash(marker: number): Uint8Array {
  return new Uint8Array(32).fill(marker);
}

function normalizedSql(statement: string): string {
  return statement.replaceAll('"', "").replaceAll(/\s+/gu, " ").trim()
    .toLowerCase();
}

describe("stored common-v5 object access history", () => {
  for (const resolution of ["exact", "unknown", "wrong-key"] as const) {
    test(`foreground signer resolution: ${resolution}`, async () => {
      const crypto = new LatticeCrypto(seededRng(2_630_503));
      const runtime = {
        agentId: agentId("agent-foreground-object"),
        keyClass: "runtime" as const,
        generation: agentRuntimeGeneration(0),
        key: hash(0x61),
      };
      const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
      const targetObjectId = objectId("memory:v1:" + "c".repeat(64));
      const payloadHash = hash(0x62);
      const genesis = createCommonAgentObjectAccessManifest(crypto, {
        objectId: targetObjectId,
        payloadHash,
        accessRevision: accessRevision(0),
        previousManifestHash: null,
        envelopeHashes: [hash(0x63)],
        signer: signer.principal,
        signerAuthorizationHash: null,
        hostAuthorizationRevision: authorizationRevision(0),
      }, runtime);
      let legacyLookups = 0;
      const executor: CryptoPostgresExecutor = {
        query: <Row extends DatabaseRow = DatabaseRow>(statement: string) => {
          const sql = normalizedSql(statement);
          if (sql.includes("from object_crypto_access_manifests")) {
            return Promise.resolve([{
              object_id: targetObjectId,
              access_revision: 0,
              manifest_hash: genesis.hash,
              previous_manifest_hash: null,
              payload_hash: payloadHash,
              manifest_bytes: genesis.bytes,
            }] as unknown as readonly Row[]);
          }
          if (sql.includes("from agent_crypto_runtime_signers")) {
            legacyLookups += 1;
            return Promise.resolve([] as readonly Row[]);
          }
          throw new Error(`Unexpected foreground signer SQL: ${statement}`);
        },
      };
      const result = verifyStoredObjectAccessManifestChainV5({
        executor,
        crypto,
        objectId: targetObjectId,
        headAccessRevision: 0,
        expectedPayloadHash: payloadHash,
        expectedHeadManifestHash: genesis.hash,
        resolveHistoricalAgentManagerAuthority: () => null,
        resolveLiveShadowAgentSigner: async (principal) => {
          expect(principal).toEqual({
            agentId: runtime.agentId,
            runtimeGeneration: runtime.generation,
            signerKeyId: signer.principal.signerKeyId,
          });
          if (resolution === "unknown") return null;
          return resolution === "wrong-key"
            ? crypto.generateSigningKeyPair().publicKey
            : signer.publicKey.slice();
        },
      });
      if (resolution === "exact") {
        const verified = await result;
        expect(verified.headSignerPublicKey).toEqual(signer.publicKey);
        expect(verified.headManifestBytes).toEqual(genesis.bytes);
        // A live key is not fabricated durable Runtime-publication evidence.
        expect(verified.signerEvidence).toEqual([]);
        expect(legacyLookups).toBe(0);
      } else {
        let rejected = false;
        try {
          await result;
        } catch {
          rejected = true;
        }
        expect(rejected).toBe(true);
        expect(legacyLookups).toBe(resolution === "unknown" ? 1 : 0);
      }
    });
  }

  test("authenticates Human -> Agent -> processor -> Human after restart", async () => {
    const crypto = new LatticeCrypto(seededRng(2_630_501));
    const firstHuman = crypto.generateSigningKeyPair();
    const finalHuman = crypto.generateSigningKeyPair();
    const manager = crypto.generateSigningKeyPair();
    const processorIssuer = crypto.generateSigningKeyPair();
    const processorSigner = crypto.generateSigningKeyPair();
    const runtime = {
      agentId: agentId("agent-common-server"),
      keyClass: "runtime" as const,
      generation: agentRuntimeGeneration(0),
      key: hash(0x21),
    };
    const runtimeSigner = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
    const publicationUnsigned: AgentRuntimeSignerPublicationUnsignedV1 = {
      formatVersion: AGENT_RUNTIME_SIGNER_PUBLICATION_FORMAT_VERSION_V1,
      transitionKind: "initialization",
      operationId: "agent-common-server-init",
      agentId: runtime.agentId,
      authorizationRevision: authorizationRevision(7),
      runtimeGeneration: runtime.generation,
      signerKeyId: runtimeSigner.principal.signerKeyId,
      signerPublicKey: runtimeSigner.publicKey,
      transitionCommitment: hash(0x22),
      managerHumanId: humanId("human-manager"),
      managerAuthorizationRevision: authorizationRevision(4),
      managerDeviceId: cryptoDeviceId("device-manager"),
      managerSigningPublicKeyHash: crypto.hash(manager.publicKey),
    };
    const publicationSigningBytes =
      agentRuntimeSignerPublicationSigningBytesV1(publicationUnsigned);
    const publication = {
      ...publicationUnsigned,
      signature: crypto.sign(manager.privateKey, publicationSigningBytes),
    };
    publicationSigningBytes.fill(0);
    const publicationBytes = encodeAgentRuntimeSignerPublicationV1(publication);

    const artifactObjectId = objectId("artifact:v1:" + "a".repeat(64));
    const payloadHash = hash(0x31);
    const envelopeHashes = [hash(0x32)];
    const genesis = createCommonHumanObjectAccessManifest(crypto, {
      objectId: artifactObjectId,
      payloadHash,
      accessRevision: accessRevision(0),
      previousManifestHash: null,
      envelopeHashes,
      signer: {
        kind: "human_device",
        subjectHumanId: humanId("human-owner"),
        committerDeviceId: cryptoDeviceId("device-owner-1"),
      },
      signerAuthorizationHash: null,
      hostAuthorizationRevision: authorizationRevision(2),
    }, firstHuman.privateKey);
    const agentUpdate = createCommonAgentObjectAccessManifest(crypto, {
      objectId: artifactObjectId,
      payloadHash,
      accessRevision: accessRevision(1),
      previousManifestHash: genesis.hash,
      envelopeHashes,
      signer: runtimeSigner.principal,
      signerAuthorizationHash: null,
      hostAuthorizationRevision: authorizationRevision(7),
    }, runtime);

    const workDescriptorBytes = new TextEncoder().encode(
      "common-v5-processor-work",
    );
    const processorPrincipal = createProcessorObjectSignerPublicV1(crypto, {
      processorKind: "stenographer",
      processorVersion: 1,
      signerAuthorizationId: "processor-common-server-auth",
      workDescriptorHash: crypto.hash(workDescriptorBytes),
      signerPrivateKey: processorSigner.privateKey,
    }).principal;
    const processorAuthorization = createProcessorSignerAuthorizationV1(
      crypto,
      {
        formatVersion: PROCESSOR_SIGNER_AUTHORIZATION_FORMAT_VERSION_V1,
        id: "processor-common-server-auth",
        processorKind: "stenographer",
        processorVersion: 1,
        workId: "processor-common-server-work",
        namespaceId: namespaceId("namespace-common-server"),
        domainId: cryptoDomainId("domain-common-server"),
        domainEpoch: domainEpoch(3),
        namespaceAccessRevision: accessRevision(5),
        policyRevision: authorizationRevision(6),
        processorAuthorizationRevision: authorizationRevision(8),
        issuingHumanId: humanId("human-processor-issuer"),
        issuingDeviceId: cryptoDeviceId("device-processor-issuer"),
        issuingDeviceAuthorizationRevision: authorizationRevision(9),
        issuerSigningPublicKeyHash: crypto.hash(processorIssuer.publicKey),
        signer: processorPrincipal,
        signerPublicKey: processorSigner.publicKey,
        workDescriptorHash: crypto.hash(workDescriptorBytes),
        credentialHash: hash(0x41),
        outputObjectIds: [artifactObjectId],
        maxOutputObjects: 1,
        maxOutputPlaintextBytes: 4_096,
        maxOutputCiphertextBytes: 8_192,
        issuedAt: 1_000,
        expiresAt: 10_000,
      },
      processorIssuer.privateKey,
    );
    const processorUpdate = createCommonProcessorObjectAccessManifest(crypto, {
      objectId: artifactObjectId,
      payloadHash,
      accessRevision: accessRevision(2),
      previousManifestHash: agentUpdate.hash,
      envelopeHashes,
      signer: processorPrincipal,
      signerAuthorizationHash: processorAuthorization.hash,
      hostAuthorizationRevision: authorizationRevision(8),
    }, {
      signerPrivateKey: processorSigner.privateKey,
      signerAuthorizationBytes: processorAuthorization.bytes,
      now: 2_000,
      resolveCurrentIssuingDevicePublicKey: () => processorIssuer.publicKey,
    });
    const finalUpdate = createCommonHumanObjectAccessManifest(crypto, {
      objectId: artifactObjectId,
      payloadHash,
      accessRevision: accessRevision(3),
      previousManifestHash: processorUpdate.hash,
      envelopeHashes,
      signer: {
        kind: "human_device",
        subjectHumanId: humanId("human-owner"),
        committerDeviceId: cryptoDeviceId("device-owner-2"),
      },
      signerAuthorizationHash: null,
      hostAuthorizationRevision: authorizationRevision(3),
    }, finalHuman.privateKey);

    const manifests = [genesis, agentUpdate, processorUpdate, finalUpdate]
      .map((entry, revision): DatabaseRow => ({
        object_id: artifactObjectId,
        access_revision: revision,
        // postgres returns bytea as Buffer. Buffer#slice aliases its source,
        // so this fixture guards the verifier's owned-copy/wiping boundary.
        manifest_hash: Buffer.from(entry.hash),
        previous_manifest_hash: revision === 0
          ? null
          : Buffer.from(
            [genesis, agentUpdate, processorUpdate][revision - 1]!.hash,
          ),
        payload_hash: Buffer.from(payloadHash),
        manifest_bytes: Buffer.from(entry.bytes),
      }));
    const authorizationRow: DatabaseRow = {
      authorization_id: processorAuthorization.authorization.id,
      request_id: "processor-request-1",
      recipient_generation: 1,
      processor_kind: processorAuthorization.authorization.processorKind,
      processor_version: processorAuthorization.authorization.processorVersion,
      authorization_hash: processorAuthorization.hash,
      authorization_bytes: processorAuthorization.bytes,
      issuing_human_id: processorAuthorization.authorization.issuingHumanId,
      issuing_device_id: processorAuthorization.authorization.issuingDeviceId,
      issuing_device_authorization_revision:
        processorAuthorization.authorization.issuingDeviceAuthorizationRevision,
      issuer_signing_public_key_hash:
        processorAuthorization.authorization.issuerSigningPublicKeyHash,
      signer_key_id: processorAuthorization.authorization.signer.signerKeyId,
      signer_public_key: processorAuthorization.authorization.signerPublicKey,
      work_descriptor_hash:
        processorAuthorization.authorization.workDescriptorHash,
      work_descriptor_bytes: workDescriptorBytes,
      work_id: processorAuthorization.authorization.workId,
      namespace_id: processorAuthorization.authorization.namespaceId,
      domain_id: processorAuthorization.authorization.domainId,
      domain_epoch: processorAuthorization.authorization.domainEpoch,
      namespace_access_revision:
        processorAuthorization.authorization.namespaceAccessRevision,
      policy_revision: processorAuthorization.authorization.policyRevision,
      processor_authorization_revision:
        processorAuthorization.authorization.processorAuthorizationRevision,
      credential_hash: processorAuthorization.authorization.credentialHash,
    };
    const executor: CryptoPostgresExecutor = {
      query: <Row extends DatabaseRow = DatabaseRow>(
        statement: string,
        _parameters?: readonly DatabaseScalar[],
      ) => {
        let rows: readonly DatabaseRow[];
        const sql = normalizedSql(statement);
        if (sql.includes("from object_crypto_access_manifests")) {
          rows = manifests;
        } else if (sql.includes("from agent_crypto_runtime_signers")) {
          rows = [{
            agent_id: publication.agentId,
            runtime_generation: publication.runtimeGeneration,
            authorization_revision: publication.authorizationRevision,
            transition_kind: publication.transitionKind,
            operation_id: publication.operationId,
            signer_key_id: publication.signerKeyId,
            signer_public_key: publication.signerPublicKey,
            publication_bytes: publicationBytes,
          }];
        } else if (
          sql.includes("from processor_crypto_signer_authorizations")
        ) {
          rows = [authorizationRow];
        } else if (sql.includes("from human_crypto_devices")) {
          rows = [{
            device_id: processorAuthorization.authorization.issuingDeviceId,
            human_id: processorAuthorization.authorization.issuingHumanId,
            signing_public_key: processorIssuer.publicKey,
            state: "revoked",
            revision: 9,
          }];
        } else {
          throw new Error(`Unexpected common-v5 SQL: ${statement}`);
        }
        return Promise.resolve(rows as readonly Row[]);
      },
    };

    const verified = await verifyStoredObjectAccessManifestChainV5({
      executor,
      crypto,
      objectId: artifactObjectId,
      headAccessRevision: 3,
      expectedPayloadHash: payloadHash,
      expectedHeadManifestHash: finalUpdate.hash,
      resolveHistoricalAgentManagerAuthority: (context) => ({
        ...context,
        managerSigningPublicKey: manager.publicKey.slice(),
      }),
      resolveHistoricalHumanDeviceSigningPublicKey: (context) =>
        Promise.resolve(
          context.committerDeviceId === "device-owner-1"
            ? firstHuman.publicKey.slice()
            : context.committerDeviceId === "device-owner-2"
            ? finalHuman.publicKey.slice()
            : null,
        ),
    });

    expect(verified.headManifest.signer.kind).toBe("human_device");
    expect(verified.genesisHumanId).toBe("human-owner");
    expect(verified.signerEvidence.map(({ kind }) => kind)).toEqual([
      "agent_runtime_publication",
      "processor_authorization",
    ]);
    expect(verified.signerEvidence.every(({ evidenceBytes }) =>
      evidenceBytes.length > 0
    )).toBe(true);
    expect(verified.signerEvidence.find((entry) =>
      entry.kind === "processor_authorization"
    )?.issuer).toMatchObject({
      subjectHumanId: processorAuthorization.authorization.issuingHumanId,
      deviceId: processorAuthorization.authorization.issuingDeviceId,
      hostAuthorizationRevision: processorAuthorization.authorization
        .issuingDeviceAuthorizationRevision,
    });

    const substituted = finalUpdate.hash.slice();
    substituted[0] = substituted[0]! ^ 1;
    expect(verifyStoredObjectAccessManifestChainV5({
      executor,
      crypto,
      objectId: artifactObjectId,
      headAccessRevision: 3,
      expectedPayloadHash: payloadHash,
      expectedHeadManifestHash: substituted,
      resolveHistoricalAgentManagerAuthority: (context) => ({
        ...context,
        managerSigningPublicKey: manager.publicKey.slice(),
      }),
      resolveHistoricalHumanDeviceSigningPublicKey: (context) =>
        Promise.resolve(context.committerDeviceId === "device-owner-1"
          ? firstHuman.publicKey.slice() : finalHuman.publicKey.slice()),
    })).rejects.toThrow("head hash is substituted");
  });

  test("pages and verifies an arbitrary retained v5 chain beyond one page", async () => {
    const crypto = new LatticeCrypto(seededRng(2_630_502));
    const device = crypto.generateSigningKeyPair();
    const targetObjectId = objectId("memory:v1:" + "b".repeat(64));
    const payloadHash = hash(0x51);
    const rows: DatabaseRow[] = [];
    let previousHash: Uint8Array | null = null;
    for (let revision = 0; revision < 130; revision += 1) {
      const created = createCommonHumanObjectAccessManifest(crypto, {
        objectId: targetObjectId,
        payloadHash,
        accessRevision: accessRevision(revision),
        previousManifestHash: previousHash,
        envelopeHashes: [],
        signer: {
          kind: "human_device",
          subjectHumanId: humanId("human-long-chain"),
          committerDeviceId: cryptoDeviceId("device-long-chain"),
        },
        signerAuthorizationHash: null,
        hostAuthorizationRevision: authorizationRevision(3),
      }, device.privateKey);
      rows.push({
        object_id: targetObjectId,
        access_revision: revision,
        manifest_hash: created.hash,
        previous_manifest_hash: previousHash,
        payload_hash: payloadHash,
        manifest_bytes: created.bytes,
      });
      previousHash = created.hash;
    }
    let pages = 0;
    const executor: CryptoPostgresExecutor = {
      query: <Row extends DatabaseRow = DatabaseRow>(
        statement: string,
        parameters?: readonly DatabaseScalar[],
      ) => {
        if (!normalizedSql(statement).includes(
          "from object_crypto_access_manifests",
        )) {
          throw new Error(`Unexpected long-chain SQL: ${statement}`);
        }
        pages += 1;
        const start = Number(parameters?.[1]);
        const end = Number(parameters?.[2]);
        const limit = Number(parameters?.[3]);
        return Promise.resolve(rows.filter((row) =>
          Number(row["access_revision"]) >= start
          && Number(row["access_revision"]) <= end
        ).slice(0, limit) as unknown as readonly Row[]);
      },
    };
    const verified = await verifyStoredObjectAccessManifestChainV5({
      executor,
      crypto,
      objectId: targetObjectId,
      headAccessRevision: 129,
      expectedPayloadHash: payloadHash,
      expectedHeadManifestHash: rows[129]!["manifest_hash"] as Uint8Array,
      resolveHistoricalAgentManagerAuthority: () => null,
      resolveHistoricalHumanDeviceSigningPublicKey: () =>
        Promise.resolve(device.publicKey.slice()),
    });
    expect(verified.headManifest.accessRevision).toBe(accessRevision(129));
    expect(verified.signerEvidence).toEqual([]);
    expect(pages).toBe(2);
  });
});
