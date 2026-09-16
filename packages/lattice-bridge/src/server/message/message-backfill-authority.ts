import { acquireEncryptionConsumptionFence, and, eq, sessions, sessionMessages, messageBackfillScans,
  type PostgresJsBridgeConnection } from "@nautilo/db";
import { LatticeCrypto, type LatticeStorage } from "@nautilo/lattice-crypto";
import { decodeEncryptedPayloadV2, decodeObjectAccessManifestV2OrV3 } from "@nautilo/lattice-crypto/wire";
import { PostgresLatticeStorage } from "../storage/postgres-lattice-storage.ts";
import { readVerifiedStoredConversationCryptoRevision } from "../storage/postgres-conversation-crypto-completion.ts";
import { createPostgresForegroundAgentSignerResolver } from "./postgres-foreground-agent-signer.ts";
import { messageBackfillClaimSchema, type MessageBackfillClaim } from "@nautilo/api-client/browser";
import { PostgresNamespaceProductAuthority } from "../delivery/postgres-namespace-product-authority.ts";
import { PostgresDomainKeyAuthorityRepository } from "../delivery/postgres-domain-key-authority.ts";
import { PostgresDeviceAdmissionRepository, type CurrentDeviceAdmissionAuthority } from "../device/postgres-device-admission-repository.ts";
import { verifyCryptoPostgresHandle } from "../storage/postgres-lattice-storage.ts";
import { bindConversationProductCanonicalTransactionRunner, PostgresConversationProductStore,
  verifyConversationProductPostgresHandle, type ConversationProductCanonicalTransactionRunner } from "./postgres-conversation-product-store.ts";
import type { MessageBackfillCandidate } from "./postgres-message-backfill-scan.ts";
import { readMessageBackfillCandidates } from "./postgres-message-backfill-discovery.ts";
import { messageBackfillClaimDigest } from "../../message/message-backfill-ack.ts";

export function transactionConnection(
  executor: Pick<PostgresJsBridgeConnection, "query">,
): PostgresJsBridgeConnection {
  return {query: executor.query.bind(executor),
    transaction: (callback) => callback(executor),
    transactionOnce: (callback) => callback(executor)};
}

type CurrentNamespace = Extract<Awaited<ReturnType<PostgresDomainKeyAuthorityRepository["inspectForegroundNamespaceAuthority"]>>, {status: "ready"}>;
type CurrentWriter = Extract<Awaited<ReturnType<PostgresDomainKeyAuthorityRepository["inspectSharedAgentWriteAuthority"]>>, {status: "ready"}>;
export interface MessageBackfillAuthority {
  readonly candidate: MessageBackfillCandidate;
  readonly device: CurrentDeviceAdmissionAuthority;
  readonly namespace: CurrentNamespace;
  readonly writer: CurrentWriter;
  readonly policyRevision: number;
  readonly keyClass: "human" | "ai";
}

function base64url(bytes: Uint8Array) { return Buffer.from(bytes).toString("base64url"); }
export function matchesMessageBackfillAuthority(claim: MessageBackfillClaim, authority: MessageBackfillAuthority): boolean {
  const {device: d, namespace: n, writer: w} = authority;
  return claim.sourceRevision === (authority.candidate.role === "tool" ? authority.candidate.messageSourceRevision : null)
    && claim.coordinate.namespaceId === n.namespaceId
    && claim.subjectHumanId === d.humanActorId && claim.deviceId === d.deviceId
    && claim.serverInstanceId === d.serverInstanceId && claim.deviceGeneration === d.deviceGeneration
    && claim.lineageGeneration === d.lineageGeneration && claim.membershipEpoch === d.epoch
    && claim.membershipSecurityRevision === d.securityRevision
    && claim.membershipHeadDigestBase64url === base64url(d.headDigest)
    && claim.hostAuthorizationRevision === w.committerDeviceRevision
    && claim.policyRevision === authority.policyRevision && claim.keyClass === authority.keyClass
    && claim.namespaceAccessRevision === n.namespaceAccessRevision
    && claim.namespaceKeyGeneration === n.namespaceKeyGeneration
    && claim.namespaceHeadDigestBase64url === base64url(n.namespaceHeadDigest)
    && claim.domainId === n.domainId && claim.domainGeneration === n.domainKeyGeneration
    && claim.domainAuthorizationRevision === n.domainAuthorizationRevision
    && claim.domainHeadDigestBase64url === base64url(n.domainHeadDigest)
    && claim.namespaceBundleRevision === n.bundleRevision
    && claim.namespaceBundleDigestBase64url === base64url(n.bundleDigest);
}

/** Product -> restricted authority lock order, one owned product transaction.
 * Callers must reuse `runner` for canonical CAS; never open another product connection inside use.
 */
export async function withMessageBackfillAuthority<Value>(input: Readonly<{
  runner: ConversationProductCanonicalTransactionRunner;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverId: string;
  subject: Readonly<{userId: string; humanActorId: string; deviceId: string}>;
  candidate: MessageBackfillCandidate;
  claim?: MessageBackfillClaim;
  use(authority: MessageBackfillAuthority,
    product: PostgresConversationProductStore,
    executor: Parameters<Parameters<ConversationProductCanonicalTransactionRunner["transaction"]>[0]>[1],
    runner: ConversationProductCanonicalTransactionRunner,
    restricted: PostgresJsBridgeConnection,
  ): Promise<Value>;
}>): Promise<Value | null> {
  return input.runner.transaction(async (tx, executor) => {
    const policy = await acquireEncryptionConsumptionFence(tx);
    if (policy.mode !== "shadow_encryption") return null;
    if (input.claim !== undefined) {
      const now = Date.now();
      if (input.claim.subjectHumanId !== input.subject.humanActorId || input.claim.deviceId !== input.subject.deviceId
        || input.claim.issuedAt > now || input.claim.expiresAt <= now) return null;
      const [lease] = await tx.select({claimId: messageBackfillScans.leaseToken,
        expiresAt: messageBackfillScans.leaseExpiresAt, claim: messageBackfillScans.claim}).from(messageBackfillScans).where(and(
        eq(messageBackfillScans.humanActorId, input.subject.humanActorId),
        eq(messageBackfillScans.leaseDeviceId, input.subject.deviceId),
        eq(messageBackfillScans.leaseToken, input.claim.claimId),
      )).for("update");
      if (!lease?.expiresAt || lease.expiresAt.getTime() <= now
        || lease.expiresAt.getTime() !== input.claim.expiresAt) return null;
      const retained = messageBackfillClaimSchema.safeParse(lease.claim);
      if (!retained.success) return null;
      const expected = messageBackfillClaimDigest(input.claim);
      const actual = messageBackfillClaimDigest(retained.data);
      try { if (base64url(expected) !== base64url(actual)) return null; }
      finally { expected.fill(0); actual.fill(0); }
    }
    const product = new PostgresNamespaceProductAuthority(transactionConnection(executor));
    return product.withCurrentMessageRepairRoom({
      subjectUserId: input.subject.userId, subjectHumanId: input.subject.humanActorId,
      roomId: input.candidate.sourceRoomId, namespaceId: input.candidate.namespaceId,
      use: async (snapshot, targetKeyClass) => {
        const [message] = await tx.select({id: sessionMessages.id}).from(sessionMessages).where(and(
          eq(sessionMessages.id, input.candidate.messageId),
          eq(sessionMessages.sessionId, input.candidate.sessionId),
          eq(sessionMessages.editRevision, input.candidate.revision),
        )).for("update");
        if (message === undefined) return null;
        // Tool correlation depends on predecessor rows. Hold its generation
        // after Room/Message locks and before re-reading the candidate or source.
        if (input.candidate.role === "tool") {
          const [session] = await tx.select({revision: sessions.messageSourceRevision})
            .from(sessions).where(eq(sessions.id, input.candidate.sessionId)).for("share");
          if (session === undefined || (input.claim !== undefined
            && input.claim.sourceRevision !== session.revision)) return null;
        }
        const [candidate] = await readMessageBackfillCandidates(executor, {
          subjectHumanId: input.subject.humanActorId, afterMessageId: input.candidate.messageId - 1,
          throughMessageId: input.candidate.messageId,
        });
        if (candidate === undefined || candidate.sessionId !== input.candidate.sessionId
          || candidate.revision !== input.candidate.revision || candidate.sourceRoomId !== input.candidate.sourceRoomId
          || candidate.namespaceId !== input.candidate.namespaceId || candidate.role !== input.candidate.role
          || candidate.humanTurnId !== input.candidate.humanTurnId || candidate.sessionAgentId !== input.candidate.sessionAgentId
          || candidate.createdAt.getTime() !== input.candidate.createdAt.getTime() || !candidate.supportedTopology) return null;
        return input.restricted.transactionOnce(async (restrictedTx) => {
          const connection = transactionConnection(restrictedTx);
          const domains = new PostgresDomainKeyAuthorityRepository(connection, input.crypto, input.serverId);
          const keyClass = candidate.lifecycle?.keyClass ?? targetKeyClass;
          const owned: Uint8Array[] = [];
          const retain = (value: object) => {
            for (const field of Object.values(value)) if (field instanceof Uint8Array) owned.push(field);
          };
          try {
            const writer = await domains.inspectSharedAgentWriteAuthority({authority: snapshot, deviceId: input.subject.deviceId, keyClass});
            if (writer.status !== "ready") return null;
            retain(writer);
            const namespace = await domains.inspectForegroundNamespaceAuthority({namespaceId: candidate.namespaceId, keyClass});
            if (namespace.status !== "ready") return null;
            retain(namespace);
            const device = await new PostgresDeviceAdmissionRepository(
              await verifyCryptoPostgresHandle(connection), input.crypto,
            ).currentAuthorityForDelegation(input.subject);
            if (device === null) return null;
            retain(device);
            if (writer.subjectHumanId !== input.subject.humanActorId || writer.committerDeviceId !== input.subject.deviceId
              || writer.namespaceId !== candidate.namespaceId || namespace.namespaceId !== candidate.namespaceId
              || writer.namespaceAccessRevision !== namespace.namespaceAccessRevision
              || namespace.namespaceAccessRevision !== candidate.namespaceAccessRevision
              || writer.namespaceKeyGeneration !== namespace.namespaceKeyGeneration
              || base64url(writer.namespaceHeadDigest) !== base64url(namespace.namespaceHeadDigest)
              || writer.committerDeviceSigningKeyGeneration !== device.deviceGeneration
              || base64url(writer.committerDeviceSigningPublicKey) !== base64url(device.signingPublicKey)) return null;
            const authority = {candidate, device, namespace, writer, keyClass, policyRevision: policy.revision};
            if (input.claim !== undefined && (!matchesMessageBackfillAuthority(input.claim, authority)
              || input.claim.expiresAt <= Date.now())) return null;
            const handle = await verifyConversationProductPostgresHandle(transactionConnection(executor));
            const runner = bindConversationProductCanonicalTransactionRunner(handle, {transaction: callback => callback(tx, executor)});
            return await input.use(authority, new PostgresConversationProductStore(handle, runner), executor, runner, connection);
          } finally { owned.forEach(value => value.fill(0)); }
        }, {isolationLevel: "read committed"});
      },
    });
  }, {isolationLevel: "read committed"});
}

/** Resume only a crypto winner linked to an admitted, committed source/manifest
 * reservation. Current readers need no current authority for the original publisher. */
export async function recoverReservedMessageBackfillPublication(input: Readonly<{
  product: PostgresConversationProductStore;
  productExecutor: Pick<PostgresJsBridgeConnection, "query">;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverId: string;
  authority: MessageBackfillAuthority;
  claim: MessageBackfillClaim;
  sourceDigest: Uint8Array;
  storage?: LatticeStorage;
  resolveHistoricalSigner?: Parameters<typeof readVerifiedStoredConversationCryptoRevision>[0]["resolveHistoricalSigner"];
  resolveLiveShadowAgentSigner?: Parameters<typeof readVerifiedStoredConversationCryptoRevision>[0]["resolveLiveShadowAgentSigner"];
}>): Promise<"absent" | "replayed" | "conflict"> {
  const {claim, authority} = input;
  const state = await input.product.getRevision(claim.coordinate.messageId, claim.coordinate.revision);
  if (state === null) return "conflict";
  const lifecycle = state.lifecycle;
  if (lifecycle.cryptoObjectId !== claim.cryptoObjectId || lifecycle.keyClass !== claim.keyClass
    || lifecycle.namespaceIdAtAllocation !== claim.coordinate.namespaceId || lifecycle.repairIdentityDigest === null) return "conflict";
  const storage = input.storage ?? new PostgresLatticeStorage(await verifyCryptoPostgresHandle(input.restricted));
  const object = await storage.getObject(claim.cryptoObjectId);
  const sameSource = base64url(lifecycle.repairSourceDigest ?? lifecycle.allocationRequestDigest) === base64url(input.sourceDigest);
  if (object === null) {
    if (sameSource) return "absent";
    if (claim.coordinate.role !== "tool" || claim.sourceRevision === null) return "conflict";
    return await input.product.refreshPendingToolRepairSource({
      sessionId: claim.coordinate.sessionId, messageId: claim.coordinate.messageId, revision: claim.coordinate.revision,
      cryptoObjectId: claim.cryptoObjectId, sourceRevision: claim.sourceRevision, sourceDigest: input.sourceDigest,
    }) === "refreshed" ? "absent" : "conflict";
  }
  object.payloadBytes.fill(0);
  if (!sameSource) return "conflict";
  if (lifecycle.repairPublisherKind === null || lifecycle.repairPublisherId === null
    || lifecycle.repairAttestationDigest === null) return "conflict";
  const domains = new PostgresDomainKeyAuthorityRepository(input.restricted, input.crypto, input.serverId);
  const foregroundSigner = input.resolveLiveShadowAgentSigner ?? (lifecycle.repairPublisherKind === "foreground_runtime"
    ? createPostgresForegroundAgentSignerResolver({
      product: await verifyConversationProductPostgresHandle(transactionConnection(input.productExecutor)), crypto: input.crypto,
    }) : undefined);
  const stored = await readVerifiedStoredConversationCryptoRevision({
    crypto: input.crypto, storage, objectId: claim.cryptoObjectId,
    resolveLiveShadowAgentSigner: foregroundSigner,
    resolveHistoricalSigner: input.resolveHistoricalSigner ?? (async (context) => {
      const envelope = context.envelopes[0];
      if (lifecycle.repairPublisherKind !== "human_device" || typeof lifecycle.repairPublisherHumanId !== "string"
        || context.committerDeviceId !== lifecycle.repairPublisherId || context.envelopes.length !== 1 || envelope === undefined
        || envelope.namespaceId !== claim.coordinate.namespaceId || envelope.keyClass !== claim.keyClass) return null;
      const retained = await domains.inspectRetainedNamespaceGenerationAuthority({
        namespaceId: envelope.namespaceId, keyClass: envelope.keyClass, generation: envelope.keyGeneration,
        accessRevision: envelope.bindingRevisionAtWrap, subjectHumanId: authority.device.humanActorId,
        readerDeviceId: authority.device.deviceId, committerHumanId: lifecycle.repairPublisherHumanId,
        committerDeviceId: context.committerDeviceId, committerHostAuthorizationRevision: context.hostAuthorizationRevision,
      });
      if (retained.status !== "ready") return null;
      retained.headDigest.fill(0);
      return {...context, committerSigningPublicKey: retained.committerDeviceSigningPublicKey};
    }),
  });
  if (stored === null) return "conflict";
  try {
    const hash = input.crypto.hash(stored.objectAccessManifestBytes);
    const payload = decodeEncryptedPayloadV2(stored.payloadBytes);
    try {
      const manifest = decodeObjectAccessManifestV2OrV3(stored.objectAccessManifestBytes);
      const publisherMatches = lifecycle.repairPublisherKind === "human_device"
        ? manifest.formatVersion === 2 && manifest.committerDeviceId === lifecycle.repairPublisherId
        : manifest.formatVersion === 3 && manifest.signer.signerKeyId === lifecycle.repairPublisherId;
      if (!publisherMatches || base64url(hash) !== base64url(lifecycle.repairAttestationDigest)
        || stored.revision.keyClass !== claim.keyClass || stored.revision.namespaceId !== claim.coordinate.namespaceId
        || payload.context.createdAt !== claim.createdAt || claim.expiresAt <= Date.now()) return "conflict";
    } finally {hash.fill(0); payload.ciphertext.fill(0);}
    const repairPublication = lifecycle.repairPublisherKind === "human_device"
      ? {publisherKind: "human_device" as const, publisherId: lifecycle.repairPublisherId,
        publisherHumanId: lifecycle.repairPublisherHumanId!, attestationDigest: lifecycle.repairAttestationDigest}
      : {publisherKind: "foreground_runtime" as const, publisherId: lifecycle.repairPublisherId,
        attestationDigest: lifecycle.repairAttestationDigest};
    const publicationPolicy = {expectedRevision: claim.policyRevision, representation: "ordinary_and_protected" as const};
    const marked = await input.product.markCryptoComplete({sessionId: claim.coordinate.sessionId,
      messageId: claim.coordinate.messageId, revision: claim.coordinate.revision, cryptoObjectId: claim.cryptoObjectId,
      parityStatus: lifecycle.completion === "complete" ? lifecycle.parityStatus : "client_authenticated",
      leaseToken: null, repairPublication, publicationPolicy});
    if (marked !== "applied" && marked !== "duplicate") return "conflict";
    const mapped = await input.product.compareAndSwapCryptoMapping({sessionId: claim.coordinate.sessionId,
      messageId: claim.coordinate.messageId, revision: claim.coordinate.revision, cryptoObjectId: claim.cryptoObjectId,
      expectedNamespaceId: claim.coordinate.namespaceId, leaseToken: null, publicationPolicy});
    return mapped === "applied" || mapped === "duplicate" ? "replayed" : "conflict";
  } finally {
    stored.payloadBytes.fill(0); stored.objectAccessManifestBytes.fill(0); stored.namespaceEnvelopeBytes.fill(0);
  }
}
