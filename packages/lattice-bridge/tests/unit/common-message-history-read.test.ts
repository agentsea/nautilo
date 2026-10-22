import { expect, test } from "bun:test";
import {
  LatticeCrypto, InMemoryLatticeStore, agentId, humanId, cryptoDeviceId, authorizationRevision,
  prepareAgentRuntimeInitialization, createCommonHumanObjectAccessManifest, accessRevision,
  objectId, openObjectDekForNamespace, wrapObjectDekForNamespace,
} from "@nautilo/lattice-crypto";
import { decodeNamespaceObjectEnvelopeV2, encodeNamespaceObjectEnvelopeV2, encodeAgentRuntimeSignerPublicationV1 } from "@nautilo/lattice-crypto/wire";
import type { PostgresJsBridgeConnection, PostgresJsBridgeRow } from "@nautilo/db";
import { prepareDeviceWrappedAgentObject, readPreparedDeviceWrappedAgentObjectSnapshot } from "../../src/object/device-wrapped-agent-object-crypto.ts";
import { verifyCryptoPostgresHandle } from "../../src/server/storage/postgres-lattice-storage.ts";
import { createForegroundMessageHistoryRepairer } from "../../src/server/message/foreground-message-history-repair.ts";
import { readVerifiedStoredConversationCryptoRevision } from "../../src/server/storage/postgres-conversation-crypto-completion.ts";
import { deriveMessageCryptoObjectIdV2, CONVERSATION_MESSAGE_OBJECT_TYPE } from "../../src/message/conversation-repository.ts";
import { encodeMessagePayloadV2 } from "../../src/message/message-payload-v2.ts";

const AGENT = "10000000-0000-4000-8000-000000000001";
const HUMAN = "10000000-0000-4000-8000-000000000002";
const NS = "10000000-0000-4000-8000-000000000003";
const ROOM = "10000000-0000-4000-8000-000000000004";
const SESSION = "10000000-0000-4000-8000-000000000005";
const DOMAIN = "10000000-0000-4000-8000-000000000006";
const bytes = (n: number) => new Uint8Array(32).fill(n);

async function fixture(rewrap = false) {
  const crypto = new LatticeCrypto();
  const manager = crypto.generateSigningKeyPair();
  const human = crypto.generateSigningKeyPair();
  const initialized = await prepareAgentRuntimeInitialization({ crypto, operationId: "message-history-runtime",
    agentId: agentId(AGENT), authorizationRevision: authorizationRevision(5),
    configObjects: [{ objectId: "message-history-config", configRevision: authorizationRevision(1), plaintextDek: bytes(1) }],
    domains: [], resolveCurrentDomainCommitterAuthority: () => null,
    manager: { managerHumanId: humanId(HUMAN), managerAuthorizationRevision: authorizationRevision(7), managerDeviceId: cryptoDeviceId("manager") },
    managerSigningPrivateKey: manager.privateKey, resolveCurrentManagerAuthority: () => manager.publicKey });
  const publication = initialized.signerPublication;
  const id = deriveMessageCryptoObjectIdV2({ sessionId: SESSION, messageId: 41, revision: 0 });
  const payload = { role: "assistant" as const, content: "Closed Task result" };
  const key = bytes(31);
  const prepared = prepareDeviceWrappedAgentObject({ crypto, objectId: id, objectType: CONVERSATION_MESSAGE_OBJECT_TYPE,
    plaintextBytes: encodeMessagePayloadV2(payload), createdAt: 1_900_000_000_000, operationId: "task-delivery",
    grant: { grantId: "closed-grant", grantHash: bytes(3), recipientKeyId: "recipient" }, runtime: initialized.runtime,
    signerKeyId: publication.signerKeyId, signerPublicKey: publication.signerPublicKey,
    agentAuthorizationRevision: publication.authorizationRevision,
    namespaceSet: [{ namespaceId: NS, domainId: DOMAIN, accessRevision: 0, keyGeneration: 0,
      domainKeyGeneration: 1, domainAuthorizationRevision: 2, domainHeadDigest: bytes(4), headDigest: bytes(5),
      publicationDigest: bytes(6), publicationSetDigest: bytes(7), audienceFingerprint: bytes(8), key }] });
  const snapshot = readPreparedDeviceWrappedAgentObjectSnapshot(prepared);
  const payloadBytes = Uint8Array.from(snapshot.object.payloadBytes.ciphertext);
  const genesis = { object_id: id, access_revision: 0, manifest_hash: snapshot.access.manifestHash,
    previous_manifest_hash: null as Uint8Array | null, payload_hash: crypto.hash(payloadBytes), manifest_bytes: snapshot.access.manifestBytes };
  let envelopeBytes: Uint8Array = Uint8Array.from(snapshot.access.envelopeBytes[0]!);
  let head = genesis;
  if (rewrap) {
    const old = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
    const dek = openObjectDekForNamespace(crypto, key, old);
    if (dek === null) throw new Error("Fixture envelope is invalid");
    envelopeBytes = encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespace(crypto, key, old.context, dek));
    dek.fill(0);
    const updated = createCommonHumanObjectAccessManifest(crypto, { objectId: objectId(id), accessRevision: accessRevision(1),
      payloadHash: genesis.payload_hash, previousManifestHash: genesis.manifest_hash, envelopeHashes: [crypto.hash(envelopeBytes)],
      signer: { kind: "human_device", subjectHumanId: humanId(HUMAN), committerDeviceId: cryptoDeviceId("retained-human") },
      signerAuthorizationHash: null, hostAuthorizationRevision: authorizationRevision(9) }, human.privateKey);
    head = { ...genesis, access_revision: 1, previous_manifest_hash: genesis.manifest_hash,
      manifest_hash: updated.hash, manifest_bytes: updated.bytes };
  }
  let corrupt = false;
  let history = true;
  const connection: PostgresJsBridgeConnection = {
    query: async <Row extends PostgresJsBridgeRow>(statement: string): Promise<readonly Row[]> => {
      let rows: readonly PostgresJsBridgeRow[];
      if (statement.includes("SELECT current_user::text")) rows = [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }];
      else if (statement.includes('from "object_crypto_access_manifests"')) rows = statement.startsWith('select "manifest_bytes"')
        ? [genesis] : rewrap ? [genesis, head] : [genesis];
      else if (statement.includes('from "agent_crypto_runtime_signers"')) rows = history ? [{ agent_id: publication.agentId,
        runtime_generation: publication.runtimeGeneration, authorization_revision: publication.authorizationRevision,
        transition_kind: publication.transitionKind, operation_id: publication.operationId, signer_key_id: publication.signerKeyId,
        signer_public_key: publication.signerPublicKey, publication_bytes: encodeAgentRuntimeSignerPublicationV1(publication) }] : [];
      else if (statement.includes('from "human_crypto_devices"')) rows = [{ device_id: "retained-human", human_id: HUMAN,
        signing_public_key: human.publicKey, state: "revoked", revision: 9 }];
      else throw new Error(`Unexpected common Message query: ${statement}`);
      return rows as readonly Row[];
    }, transaction: async use => use(connection), transactionOnce: async use => use(connection),
  };
  class Storage extends InMemoryLatticeStore {
    override getObject() { return Promise.resolve({ objectId: id, payloadBytes: corrupt ? bytes(99) : Uint8Array.from(payloadBytes) }); }
    override getObjectAccessState() { return Promise.resolve({
      head: { objectId: id, accessRevision: head.access_revision, manifestHash: Uint8Array.from(head.manifest_hash), manifestBytes: Uint8Array.from(head.manifest_bytes) },
      namespaceEnvelopes: [{ namespaceId: NS, envelopeHash: crypto.hash(envelopeBytes), envelopeBytes: Uint8Array.from(envelopeBytes) }],
    }); }
  }
  const handle = await verifyCryptoPostgresHandle(connection);
  const storage = new Storage();
  const resolveHistoricalAgentSignerAuthority: Parameters<typeof readVerifiedStoredConversationCryptoRevision>[0]["resolveHistoricalAgentSignerAuthority"] = context =>
    history ? { ...context, managerSigningPublicKey: manager.publicKey.slice() } : null;
  const read = (expectedAgentId = AGENT) => readVerifiedStoredConversationCryptoRevision({ crypto, storage, objectId: id,
    commonManifest: { handle, expectedAgentId }, resolveHistoricalSigner: () => null, resolveHistoricalAgentSignerAuthority });
  let uses = 0;
  let mapping = true;
  let allowed = true;
  const source = { messageId: 41, sessionId: SESSION, roomId: ROOM, namespaceId: NS, revision: 0,
    createdAt: 1_900_000_000_000, authorRole: "assistant" as const, authorHumanTurnId: null, sessionAgentId: AGENT,
    mappedCryptoObjectId: id, payload: null };
  const serviceInput: Parameters<typeof createForegroundMessageHistoryRepairer>[0] = {
    crypto, storage, commonManifestHandle: handle, entities: {
      use: async request => { uses++; return allowed ? { status: "executed", value: await request.execute({ namespaceKey: key,
        authority: { namespaceId: NS, namespaceAccessRevision: 0, namespaceKeyGeneration: 0, domainId: DOMAIN,
          domainKeyGeneration: 1, domainAuthorizationRevision: 2, domainHeadDigest: bytes(4), namespaceHeadDigest: bytes(5),
          namespacePublicationDigest: bytes(6), namespacePublicationSetDigest: bytes(7), namespaceAudienceFingerprint: bytes(8) } }) }
        : { status: "unavailable", reason: "authorization_unavailable" }; },
      useCurrentSet: async () => { throw new Error("History read cannot encrypt"); },
    },
    product: { getRevisionMapping: async () => mapping ? ({ lifecycle: { disposition: "mapped", completion: "complete", cryptoObjectId: id },
      message: { messageId: 41, sessionId: SESSION, revision: 0, authorRole: "assistant", cryptoObjectId: id } }) : null,
      getRevision: async () => mapping ? ({ lifecycle: { disposition: "mapped", completion: "complete", cryptoObjectId: id }, message: { cryptoObjectId: id } }) : null,
    } as never,
    conversation: {} as never, cryptoCompletion: {} as never, contextNamespaceId: NS, sourceRepresentationMode: "protected-only",
    publication: { operationId: "fresh-foreground", policyRevision: 2, grantId: "fresh-grant", grantDigest: bytes(11), recipientKeyId: "fresh-recipient",
      agentAuthorizationRevision: 5, signerKeyId: "different-current-signer", signerPublicKey: bytes(12), runtime: initialized.runtime,
      withCurrentPublication: async () => { throw new Error("History read cannot publish"); } },
    resolveHistoricalHumanSigner: () => null, resolveHistoricalAgentSignerAuthority,
    loadSources: async () => [source],
  };
  return { read, serviceInput, source, payload, uses: () => uses,
    forgeSignature: () => {
      head.manifest_bytes = Uint8Array.from(head.manifest_bytes);
      head.manifest_bytes[head.manifest_bytes.length - 1]! ^= 1;
      head.manifest_hash = crypto.hash(head.manifest_bytes);
    },
    corrupt: () => { corrupt = true; }, revokeHistory: () => { history = false; },
    changeMapping: () => { mapping = false; }, deny: () => { allowed = false; } };
}

for (const rewrap of [false, true]) test(`common-v5 Task Message opens through current entity loan after historical chain ${rewrap}`, async () => {
  const f = await fixture(rewrap);
  const result = await createForegroundMessageHistoryRepairer(f.serviceInput).protect({ messageIds: [41] });
  expect(result).toMatchObject({ status: "verified", messages: [{ payload: f.payload, provenance: "existing" }] });
  expect(f.uses()).toBe(1);
  const shadow = createForegroundMessageHistoryRepairer({ ...f.serviceInput, sourceRepresentationMode: "ordinary-and-protected",
    loadSources: async () => [{ ...f.source, payload: f.payload }] });
  expect((await shadow.protect({ messageIds: [41] })).status).toBe("verified");
});

test("common-v5 Agent identity/history and corruption cannot fall back to a live signer", async () => {
  const f = await fixture(true);
  expect(f.read(HUMAN)).rejects.toThrow(/Session Agent/);
  f.revokeHistory(); expect(f.read()).rejects.toThrow();
  expect(f.uses()).toBe(0);
  const corrupt = await fixture(); corrupt.corrupt(); expect(corrupt.read()).rejects.toThrow();
  const forged = await fixture(true); forged.forgeSignature(); expect(forged.read()).rejects.toThrow();
});

test("common-v5 history denies wrong Namespace, role, Shadow parity and stale mapped identity", async () => {
  for (const patch of [{ namespaceId: ROOM }, { authorRole: "tool" as const }, { payload: { role: "assistant" as const, content: "wrong" } }]) {
    const f = await fixture();
    const service = createForegroundMessageHistoryRepairer({ ...f.serviceInput, sourceRepresentationMode: "ordinary-and-protected",
      loadSources: async () => [{ ...f.source, ...patch }] });
    expect((await service.protect({ messageIds: [41] })).status).not.toBe("verified");
  }
  const f = await fixture(); f.changeMapping();
  expect((await createForegroundMessageHistoryRepairer(f.serviceInput).protect({ messageIds: [41] })).status).toBe("waiting_for_authority");
  const denied = await fixture(); denied.deny();
  expect((await createForegroundMessageHistoryRepairer(denied.serviceInput).protect({ messageIds: [41] })).status).toBe("waiting_for_authority");
  const missing = await fixture(); const { commonManifestHandle: _handle, ...legacy } = missing.serviceInput;
  expect((await createForegroundMessageHistoryRepairer(legacy).protect({ messageIds: [41] })).status).toBe("failed");
  expect(missing.uses()).toBe(0);
});
