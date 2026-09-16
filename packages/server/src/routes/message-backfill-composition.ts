import { randomUUID } from "node:crypto";
import {
  createPostgresJsBridgeConnection, getSharedDirectCryptoDb, getEncryptionTransitionPolicy,
  messageBackfillScans, eq,
} from "@nautilo/db";
import {
  messageBackfillClaimSchema,
  type MessageBackfillClaim, type MessageBackfillCoordinate, type MessageBackfillUrgentSelection, type MessageBackfillNextResponse,
  type MessageBackfillSourceResponse, type MessageBackfillPublishRequest,
  type MessageBackfillPublishResponse, type MessageBackfillAckRequest,
  type MessageBackfillAckResponse, type MessageBackfillProgress,
} from "@nautilo/api-client";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import { HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_MAX_TTL_MS_V1 } from "@nautilo/lattice-crypto/wire";
import {
  admitHumanExistingMessageRepresentation, decodeMessagePayloadV2,
  deriveMessageCryptoObjectIdV2, conversationExistingRepresentationRepairIdentityDigest,
  createDormantConversationShadowRepository, messageBackfillAcknowledgementDigest,
  messageBackfillClaimDigest, classifyMessageBackfillState, bindEncryptionDataOperationOwner,
} from "@nautilo/lattice-bridge";
import {
  PostgresMessageBackfillScan, readMessageBackfillCandidates,
  readMessageBackfillProgressAggregate,
  activeMessageBackfillToolContext, activateMessageBackfillToolContext, discardMessageBackfillToolContext,
  readMessageBackfillOrdinarySource, withMessageBackfillAuthority, recoverReservedMessageBackfillPublication,
  createPostgresConversationCryptoCompletion, verifyCryptoPostgresHandle, PostgresLatticeStorage,
  type MessageBackfillCandidate, type MessageBackfillAuthority,
} from "@nautilo/lattice-bridge/server";
import type { CurrentDeviceAdmission } from "../auth/device-admission-gate";
import { getServerDirectDb } from "../lib/server-direct-db";
import { decodeCanonicalBase64url } from "../lib/canonical-base64url";
import { createHumanProductTransactionContext } from "./human-message-product-store";
import { createProductionRoomHistoryShadowReadComposition } from "./room-history-shadow-read-composition";

export interface MessageBackfillSubject {
  readonly userId: string; readonly humanActorId: string; readonly deviceId: string;
  readonly admission: CurrentDeviceAdmission;
}
const encode = (value: Uint8Array) => Buffer.from(value).toString("base64url");
function decode(value: string, length?: number): Uint8Array {
  const result = decodeCanonicalBase64url(value, length);
  if (result === null) throw new TypeError("Invalid Message repair encoding");
  return result;
}
function coordinate(row: MessageBackfillCandidate): MessageBackfillCoordinate {
  return {sessionId: row.sessionId, messageId: row.messageId, revision: row.revision,
    roomId: row.sourceRoomId, namespaceId: row.namespaceId, role: row.role, logicalMessageKey: row.logicalMessageKey};
}
function matchesUrgentRoom(row: MessageBackfillCandidate, urgent: MessageBackfillUrgentSelection): boolean {
  // Parent Session history intentionally includes its Subthread rows. The
  // visible scope may be the parent; crypto claims keep the exact child scope.
  return urgent.messageId === row.messageId && urgent.revision === row.revision
    && (urgent.roomId === row.sourceRoomId || urgent.roomId === row.sessionRoomId);
}
function exact(claim: MessageBackfillClaim, row: MessageBackfillCandidate): boolean {
  return claim.sourceRevision === (row.role === "tool" ? row.messageSourceRevision : null)
    && JSON.stringify(coordinate(row)) === JSON.stringify(claim.coordinate)
    && row.createdAt.getTime() === claim.createdAt && row.humanTurnId === claim.authorHumanTurnId
    && row.sessionAgentId === claim.sessionAgentId
    && (row.cryptoObjectId === null || row.cryptoObjectId === claim.cryptoObjectId);
}
function admitted(subject: MessageBackfillSubject, current: MessageBackfillAuthority): boolean {
  const a = subject.admission, d = current.device;
  return a.expiresAt > Date.now() && a.deviceId === d.deviceId && a.deviceGeneration === d.deviceGeneration
    && a.serverInstanceId === d.serverInstanceId && a.lineageGeneration === d.lineageGeneration
    && a.epoch === d.epoch && a.securityRevision === d.securityRevision
    && encode(a.headDigest) === encode(d.headDigest);
}

type ScanPort = Pick<PostgresMessageBackfillScan, "select" | "install" | "defer" | "current" | "advance">;
async function productionContext(subject: Pick<MessageBackfillSubject, "userId">) {
  const c = await createHumanProductTransactionContext(subject.userId);
  return {...c, scan: new PostgresMessageBackfillScan(c.canonicalRunner) as ScanPort};
}
async function productionManifest(connection: ReturnType<typeof createPostgresJsBridgeConnection>, objectId: string) {
  const storage = new PostgresLatticeStorage(await verifyCryptoPostgresHandle(connection));
  return (await storage.getObjectAccessState(objectId))?.head.manifestBytes ?? null;
}
type CompletionOptions = Omit<Parameters<typeof createPostgresConversationCryptoCompletion>[0], "handle">;
async function productionCompletion(connection: ReturnType<typeof createPostgresJsBridgeConnection>, options: CompletionOptions) {
  return createPostgresConversationCryptoCompletion({...options, handle: await verifyCryptoPostgresHandle(connection)});
}
/** Internal transaction/transport seams keep protocol tests independent of PostgreSQL. */
export function createProductionMessageBackfillComposition(dependencies: Partial<{
  getPolicy: () => ReturnType<typeof getEncryptionTransitionPolicy>;
  context: typeof productionContext;
  restricted: () => ReturnType<typeof createPostgresJsBridgeConnection>;
  withAuthority: typeof withMessageBackfillAuthority;
  readCandidates: typeof readMessageBackfillCandidates;
  readProgress: typeof readMessageBackfillProgressAggregate;
  readSource: typeof readMessageBackfillOrdinarySource;
  activeToolContext: typeof activeMessageBackfillToolContext;
  prepareToolContext: typeof activateMessageBackfillToolContext;
  discardToolContext: typeof discardMessageBackfillToolContext;
  readManifest: typeof productionManifest;
  completion: typeof productionCompletion;
  recover: typeof recoverReservedMessageBackfillPublication;
  scan: (runner: ConstructorParameters<typeof PostgresMessageBackfillScan>[0]) => ScanPort;
}> = {}) {
  const crypto = new LatticeCrypto();
  const history = createProductionRoomHistoryShadowReadComposition();
  const serverId = process.env["NAUTILO_PUBLIC_BASE_URL"]?.trim() || "http://localhost:3001";
  // The existing signed publication protocol owns this operating lease. It never bounds corpus size.
  const leaseMs = HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_MAX_TTL_MS_V1;
  const readPolicy = dependencies.getPolicy ?? (() => getEncryptionTransitionPolicy(getServerDirectDb()));
  const owner = bindEncryptionDataOperationOwner({policy: {
    resolve: async () => {const policy = await readPolicy(); return {policy, revalidationToken: policy.revision};},
    revalidate: async (revision) => {if ((await readPolicy()).revision !== revision) throw new Error("Message repair policy changed");},
  }});
  const restricted = dependencies.restricted ?? (() => createPostgresJsBridgeConnection(getSharedDirectCryptoDb()));
  const context = dependencies.context ?? productionContext;
  const withAuthority = dependencies.withAuthority ?? withMessageBackfillAuthority;
  const readCandidates = dependencies.readCandidates ?? readMessageBackfillCandidates;
  const readProgress = dependencies.readProgress ?? readMessageBackfillProgressAggregate;
  const readSource = dependencies.readSource ?? readMessageBackfillOrdinarySource;
  const activeToolContext = dependencies.activeToolContext ?? activeMessageBackfillToolContext;
  const prepareToolContext = dependencies.prepareToolContext ?? activateMessageBackfillToolContext;
  const discardToolContext = dependencies.discardToolContext ?? discardMessageBackfillToolContext;
  const readManifest = dependencies.readManifest ?? productionManifest;
  const makeCompletion = dependencies.completion ?? productionCompletion;
  const recover = dependencies.recover ?? recoverReservedMessageBackfillPublication;
  const scanFromRunner = dependencies.scan ?? ((runner) => new PostgresMessageBackfillScan(runner));
  const candidate = async (subject: MessageBackfillSubject, messageId: number) => {
    const c = await context(subject);
    return c.canonicalRunner.transaction(async (_tx, executor) => {
      const rows = await readCandidates(executor, {subjectHumanId: subject.humanActorId,
        afterMessageId: messageId - 1, throughMessageId: messageId});
      return rows[0] ?? null;
    }, {isolationLevel: "read committed"});
  };

  const currentClaim = async (subject: MessageBackfillSubject, claimId: string) => {
    const c = await context(subject);
    const claim = await c.scan.current(subject.humanActorId, subject.deviceId, claimId, Date.now());
    if (claim === null) return null;
    const row = await candidate(subject, claim.coordinate.messageId);
    return row === null || !exact(claim, row) ? null : {...c, claim, row};
  };

  const progress = async (subject: Pick<MessageBackfillSubject, "userId" | "humanActorId">): Promise<MessageBackfillProgress> => owner.metadata(async () => {
    const c = await context(subject);
    return c.canonicalRunner.transaction(async (tx, executor) => {
      const policy = await readPolicy();
      const snapshotAt = Date.now();
      const [scan] = await tx.select().from(messageBackfillScans).where(eq(messageBackfillScans.humanActorId, subject.humanActorId));
      const activeLease = policy.mode === "shadow_encryption"
        && scan?.leaseExpiresAt !== null && scan?.leaseExpiresAt !== undefined
        && scan.leaseExpiresAt.getTime() > snapshotAt;
      const parsedClaim = activeLease
        ? messageBackfillClaimSchema.safeParse(scan?.claim)
        : null;
      const currentClaim = parsedClaim?.success === true
        && parsedClaim.data.subjectHumanId === subject.humanActorId
        && parsedClaim.data.policyRevision === policy.revision
        && parsedClaim.data.claimId === scan?.leaseToken
        && parsedClaim.data.deviceId === scan?.leaseDeviceId
        && parsedClaim.data.expiresAt > snapshotAt
        ? parsedClaim.data
        : null;
      const aggregate = await readProgress(executor, {
        subjectHumanId: subject.humanActorId,
        policyRevision: policy.revision,
        ...(currentClaim === null ? {} : {claimed: {
          action: currentClaim.action,
          sourceRevision: currentClaim.sourceRevision,
          messageId: currentClaim.coordinate.messageId,
          sessionId: currentClaim.coordinate.sessionId,
          revision: currentClaim.coordinate.revision,
          sourceRoomId: currentClaim.coordinate.roomId,
          namespaceId: currentClaim.coordinate.namespaceId,
          role: currentClaim.coordinate.role,
          cryptoObjectId: currentClaim.cryptoObjectId,
        }}),
      });
      const unresolvedWaiting = Math.max(0, aggregate.pending
        - aggregate.unsupported - aggregate.failed - aggregate.claimedRepairing);
      return {
        status: policy.mode !== "shadow_encryption" ? "disabled"
          : aggregate.pending === 0 ? "caught_up"
          : aggregate.failed > 0 || aggregate.unsupported > 0 ? "failed"
          : aggregate.claimedRepairing > 0 ? "active" : "waiting",
        snapshotAt,
        snapshotComplete: true,
        caughtUp: aggregate.pending === 0,
        lastSweepAt: scan?.lastSweepAt?.getTime() ?? null,
        activeLease,
        counts: {
          eligible: aggregate.eligible,
          alreadyAuthenticated: aggregate.alreadyAuthenticated,
          independentlyParityVerified: aggregate.independentlyParityVerified,
          claimedRepairing: aggregate.claimedRepairing,
          repairedAndVerified: aggregate.repairedAndVerified,
          unsupported: aggregate.unsupported,
          failed: aggregate.failed,
        },
        waiting: unresolvedWaiting === 0
          ? {authorizedDevice: 0, authority: 0}
          : {authorizedDevice: null, authority: null},
      };
    }, {isolationLevel: "serializable"});
  });

  const next = async (subject: MessageBackfillSubject, urgent?: MessageBackfillUrgentSelection): Promise<MessageBackfillNextResponse> => {
    const disabled = (): Promise<MessageBackfillNextResponse> => Promise.resolve({status: "disabled", resumeAt: null, snapshotAt: Date.now(), complete: false});
    return owner.runMutation({ordinary: disabled, protected: disabled, dual: async () => {
      const c = await context(subject);
      if (urgent !== undefined) {
        const row = await candidate(subject, urgent.messageId);
        if (!row || !matchesUrgentRoom(row, urgent)) urgent = undefined;
      }
      // One bounded parser activation precedes the independent corpus sweep. Pending
      // Tool context never consumes the ordinary cursor or blocks unrelated candidates.
      let active = await activeToolContext(c.canonicalRunner, subject.humanActorId);
      let prepared: {messageId: number; status: "more" | "ready" | "invalid" | null;
        becameTerminal: boolean} | null = null;
      let continuationPriority: MessageBackfillUrgentSelection | undefined;
      let pendingAuthorityRow: MessageBackfillCandidate | null = null;
      const prepareAuthority = (row: MessageBackfillCandidate): MessageBackfillNextResponse => ({
        status: "prepare_authority", coordinate: coordinate(row),
        keyClass: row.lifecycle?.keyClass ?? row.targetKeyClass, resumeAt: Date.now() + leaseMs});
      const prepare = (row: MessageBackfillCandidate) => withAuthority({runner: c.canonicalRunner,
        restricted: restricted(), crypto, serverId, subject, candidate: row,
        use: async (a, _product, _executor, runner) => admitted(subject, a)
          ? prepareToolContext(runner, {humanActorId: subject.humanActorId, sessionId: row.sessionId,
            messageId: row.messageId, revision: row.revision, createdAt: row.createdAt}) : null});
      if (active !== null) {
        const row = await candidate(subject, active.messageId);
        const action = row === null ? "none" : classifyMessageBackfillState({message: {...row, roomId: row.sourceRoomId},
          lifecycle: row.lifecycle, supportedTopology: row.supportedTopology,
          ordinaryRestorationAccepted: row.ordinaryRestorationAccepted}).action;
        if (row === null || row.sessionId !== active.sessionId || row.revision !== active.revision
          || row.role !== "tool" || !row.ordinaryPresent || action === "none" || action === "failed"
          || action === "unsupported" || active.failureMessageId !== null) {
          if (await discardToolContext(c.canonicalRunner, subject.humanActorId)) active = null;
        } else {
          const activation = await prepare(row);
          prepared = {messageId: row.messageId, status: activation?.status ?? null,
            becameTerminal: activation?.becameTerminal ?? false};
          if (activation === null) {
            pendingAuthorityRow = row;
            // A continuation whose retained Room authority is unavailable must
            // not own the Human's sole parser slot forever. Cleanup is bounded;
            // ordinary scanning continues while it drains, then another Tool
            // candidate may claim the released slot on a later activation.
            if (await discardToolContext(c.canonicalRunner, subject.humanActorId)) {
              active = null;
              prepared = null;
            }
          }
          if (prepared?.becameTerminal === true) continuationPriority = {
            roomId: row.sourceRoomId, messageId: row.messageId, revision: row.revision};
        }
      }
      const hasContinuationWork = active !== null && (prepared === null || prepared.status === "more");
      const selectedPriority = urgent ?? continuationPriority;
      const selected = await c.scan.select({humanId: subject.humanActorId, deviceId: subject.deviceId,
        now: Date.now(), resumeAt: Date.now() + leaseMs,
        ...(selectedPriority === undefined ? {} : {urgentMessageId: selectedPriority.messageId})});
      if (selected.status === "priority_resolved") {
        const row = selected.candidate;
        // The durable lane may predate this request or originate in Tool
        // continuation. Report its exact resolved row, never the caller's
        // latest (possibly unrelated) visible priority.
        const resolved = await withAuthority({runner: c.canonicalRunner, restricted: restricted(),
          crypto, serverId, subject, candidate: row, use: (a): Promise<MessageBackfillUrgentSelection | false> => Promise.resolve(admitted(subject, a)
            && a.candidate.sourceRoomId === row.sourceRoomId && a.candidate.messageId === row.messageId
            && a.candidate.revision === row.revision && classifyMessageBackfillState({
              message: {...a.candidate, roomId: a.candidate.sourceRoomId}, lifecycle: a.candidate.lifecycle,
              supportedTopology: a.candidate.supportedTopology,
              ordinaryRestorationAccepted: a.candidate.ordinaryRestorationAccepted,
            }).action === "none"
            ? {roomId: a.candidate.sourceRoomId, messageId: a.candidate.messageId, revision: a.candidate.revision}
            : false)});
        if (resolved === null) return prepareAuthority(row);
        return {status: "more", resumeAt: Date.now(), snapshotAt: Date.now(), complete: false,
          ...(resolved ? {resolvedSelection: resolved} : {})};
      }
      if (selected.status === "claimed") return selected;
      if (selected.status === "disabled") return disabled();
      if (selected.status === "swept") {
        if (pendingAuthorityRow !== null) return prepareAuthority(pendingAuthorityRow);
        if (hasContinuationWork) return {status: "more", resumeAt: Date.now(), snapshotAt: Date.now(), complete: false};
        const state = await progress(subject);
        return {status: state.caughtUp ? "caught_up" : "waiting", resumeAt: selected.resumeAt,
          snapshotAt: state.snapshotAt, complete: state.caughtUp};
      }
      if (selected.status !== "candidate" && pendingAuthorityRow !== null) return prepareAuthority(pendingAuthorityRow);
      if (selected.status !== "candidate" && hasContinuationWork) return {
        status: "more", resumeAt: Date.now(), snapshotAt: Date.now(), complete: false};
      if (selected.status !== "candidate") return {status: selected.status,
        resumeAt: selected.status === "waiting" ? selected.resumeAt : Date.now(), snapshotAt: Date.now(), complete: false};
      const row = selected.candidate;
      if (row.role === "tool" && row.ordinaryPresent) {
        const activeIsDifferentAndNonterminal = active !== null && active.messageId !== row.messageId
          && (prepared === null || prepared.status === null || prepared.status === "more");
        const status = activeIsDifferentAndNonterminal ? "more"
          : prepared?.messageId === row.messageId ? prepared.status : (await prepare(row))?.status ?? null;
        if (status !== "ready" && status !== "invalid") {
          await c.scan.defer({humanId: subject.humanActorId, cursor: selected.cursor,
            messageId: row.messageId, urgent: selected.urgent, now: Date.now()});
          if (status === null) return prepareAuthority(row);
          if (pendingAuthorityRow !== null) return prepareAuthority(pendingAuthorityRow);
          return {status: "more", resumeAt: Date.now(), snapshotAt: Date.now(), complete: false};
        }
      }
      const claim = await withAuthority({runner: c.canonicalRunner, restricted: restricted(), crypto,
        serverId, subject, candidate: row, use: (a) => {
          if (!admitted(subject, a)) return Promise.resolve(null);
          const digest = conversationExistingRepresentationRepairIdentityDigest({
            sessionId: row.sessionId, messageId: row.messageId, revision: row.revision,
            namespaceId: row.namespaceId, authorRole: row.role, keyClass: a.keyClass,
            authorityFingerprint: a.namespace.namespaceHeadDigest, policyRevision: a.policyRevision,
          });
          try {
            const repairDigest = encode(digest), now = Date.now();
            return Promise.resolve(messageBackfillClaimSchema.parse({version: 1, claimId: randomUUID(),
              operationId: `foreground-repair:${row.messageId}:${row.revision}:${repairDigest}`,
              coordinate: coordinate(row), sourceRevision: row.role === "tool" ? a.candidate.messageSourceRevision : null,
              action: selected.action, subjectHumanId: subject.humanActorId,
              deviceId: subject.deviceId, serverInstanceId: a.device.serverInstanceId,
              deviceGeneration: a.device.deviceGeneration, lineageGeneration: a.device.lineageGeneration,
              membershipEpoch: a.device.epoch, membershipSecurityRevision: a.device.securityRevision,
              membershipHeadDigestBase64url: encode(a.device.headDigest), hostAuthorizationRevision: a.writer.committerDeviceRevision,
              policyRevision: a.policyRevision, keyClass: a.keyClass,
              namespaceAccessRevision: a.namespace.namespaceAccessRevision, namespaceKeyGeneration: a.namespace.namespaceKeyGeneration,
              namespaceHeadDigestBase64url: encode(a.namespace.namespaceHeadDigest), domainId: a.namespace.domainId,
              domainGeneration: a.namespace.domainKeyGeneration, domainAuthorizationRevision: a.namespace.domainAuthorizationRevision,
              domainHeadDigestBase64url: encode(a.namespace.domainHeadDigest), namespaceBundleRevision: a.namespace.bundleRevision,
              namespaceBundleDigestBase64url: encode(a.namespace.bundleDigest), repairIdentityDigestBase64url: repairDigest,
              createdAt: row.createdAt.getTime(), authorHumanTurnId: row.humanTurnId, sessionAgentId: row.sessionAgentId,
              cryptoObjectId: row.cryptoObjectId ?? deriveMessageCryptoObjectIdV2({sessionId: row.sessionId, messageId: row.messageId, revision: row.revision}),
              issuedAt: now, expiresAt: Math.min(now + leaseMs, subject.admission.expiresAt),
            }));
          } finally {digest.fill(0);}
        }});
      if (claim === null) {
        await c.scan.defer({humanId: subject.humanActorId, cursor: selected.cursor, messageId: row.messageId,
          urgent: selected.urgent, now: Date.now()});
        return {status: "prepare_authority", coordinate: coordinate(row),
          keyClass: row.lifecycle?.keyClass ?? row.targetKeyClass, resumeAt: Date.now() + leaseMs};
      }
      return await c.scan.install({claim, cursor: selected.cursor, urgent: selected.urgent, now: Date.now()})
        ? {status: "claimed", claim}
        : {status: "more", resumeAt: Date.now(), snapshotAt: Date.now(), complete: false};
    }});
  };

  const source = async (subject: MessageBackfillSubject, claimId: string): Promise<MessageBackfillSourceResponse> => {
    const stale = (): Promise<MessageBackfillSourceResponse> => Promise.resolve({status: "stale", resumeAt: Date.now()});
    return owner.runMutation({ordinary: stale, protected: stale, dual: async () => {
      const current = await currentClaim(subject, claimId);
      if (!current) return stale();
      const {claim, row} = current;
      const opened = await withAuthority({runner: current.canonicalRunner, restricted: restricted(),
        crypto, serverId, subject, candidate: row, claim, use: async (a, product, executor, _runner, authorityConnection) => {
          if (!admitted(subject, a)) return null;
          let bytes: Uint8Array | null;
          try {bytes = await readSource(executor, {
            humanActorId: subject.humanActorId, sessionId: row.sessionId, messageId: row.messageId, revision: row.revision});
          } catch (error) {
            if (!(error instanceof TypeError || error instanceof SyntaxError || error instanceof RangeError)) throw error;
            return {cryptoObjectId: null, bytes: null, digest: null};
          }
          if (a.candidate.ordinaryPresent && bytes === null) return null;
          let cryptoObjectId = a.candidate.cryptoObjectId;
          const sourceDigest = bytes === null ? null : crypto.hash(bytes);
          try {
            if (cryptoObjectId === null && a.candidate.lifecycle !== null && sourceDigest !== null) {
              const recovered = await recover({product, productExecutor: executor, restricted: authorityConnection,
                crypto, serverId, authority: a, claim, sourceDigest});
              if (recovered === "conflict") return null;
              if (recovered === "replayed") cryptoObjectId = claim.cryptoObjectId;
            }
            return {cryptoObjectId, bytes: bytes === null ? null : encode(bytes), digest: sourceDigest === null ? null : encode(sourceDigest)};
          } finally {bytes?.fill(0); sourceDigest?.fill(0);}
        }});
      if (opened === null) return {status: "waiting_for_authority", resumeAt: Date.now() + leaseMs};
      if (opened.cryptoObjectId === null) {
        if (opened.bytes === null || opened.digest === null) return {status: "integrity_failure", resumeAt: Date.now() + leaseMs};
        return {status: "ordinary", claim, payloadBytesBase64url: opened.bytes, sourceDigestBase64url: opened.digest};
      }
      const sidecar = await history.project({authority: subject, roomId: row.sourceRoomId,
        readerDeviceId: subject.deviceId, clientRequestKey: claim.claimId, now: Date.now(),
        selectedCoordinates: [{sessionId: row.sessionId, messageId: row.messageId,
          editRevision: row.revision, role: row.role, logicalMessageKey: row.logicalMessageKey}]});
      const rechecked = await withAuthority({runner: current.canonicalRunner, restricted: restricted(),
        crypto, serverId, subject, candidate: row, claim, use: (a) => Promise.resolve(admitted(subject, a) && exact(claim, a.candidate)
          && a.candidate.cryptoObjectId === opened.cryptoObjectId)});
      if (!rechecked) return stale();
      return {status: "protected", claim, history: sidecar,
        ordinaryPayloadBytesBase64url: opened.bytes, sourceDigestBase64url: opened.digest};
    }});
  };

  const publish = async (subject: MessageBackfillSubject, request: MessageBackfillPublishRequest): Promise<MessageBackfillPublishResponse> => {
    const stale = (): Promise<MessageBackfillPublishResponse> => Promise.resolve({status: "stale"});
    return owner.runMutation({ordinary: stale, protected: stale, dual: async () => {
      const current = await currentClaim(subject, request.claimId);
      if (current === null || current.claim.action !== "encrypt") return stale();
      const {claim, row} = current;
      const attempt = async (stage: "reserve" | "publish"): Promise<MessageBackfillPublishResponse | {status: "reserved"}> => await withAuthority({runner: current.canonicalRunner, restricted: restricted(),
        crypto, serverId, subject, candidate: row, claim, use: async (a, product, executor, _runner, authorityConnection): Promise<MessageBackfillPublishResponse | {status: "reserved"}> => {
          if (!admitted(subject, a) || !exact(claim, a.candidate)) return stale();
          const owned: Uint8Array[] = [];
          const keep = (value: Uint8Array) => {owned.push(value); return value;};
          try {
            const plaintext = await readSource(executor, {
              humanActorId: subject.humanActorId, sessionId: row.sessionId, messageId: row.messageId, revision: row.revision});
            if (plaintext === null) return stale();
            keep(plaintext);
            const payloadBytes = keep(decode(request.payloadBytesBase64url));
            const manifestBytes = keep(decode(request.manifestBytesBase64url));
            const envelopeBytes = keep(decode(request.envelopeBytesBase64url));
            const admittedRequest = await admitHumanExistingMessageRepresentation({crypto,
              productPlan: {subjectHumanId: subject.humanActorId, operationId: claim.operationId,
                sessionId: row.sessionId, roomId: row.sourceRoomId, messageId: row.messageId, revision: row.revision,
                createdAt: row.createdAt.getTime(), objectId: claim.cryptoObjectId, namespaceId: row.namespaceId,
                namespaceBindingHash: a.namespace.namespaceHeadDigest,
                namespaceAccessRevision: claim.namespaceAccessRevision, namespaceKeyGeneration: claim.namespaceKeyGeneration,
                bindingRevisionAtWrap: claim.namespaceAccessRevision, keyClass: claim.keyClass,
                authorRole: row.role, authorHumanTurnId: row.humanTurnId, sessionAgentId: row.sessionAgentId},
              authoritativePlaintext: decodeMessagePayloadV2(plaintext), requestBytes: keep(decode(request.requestBytesBase64url)),
              payloadBytes, manifestBytes, envelopeBytes: [envelopeBytes], now: Date.now(),
              resolveCurrentHumanAuthority: context => context.subjectHumanId === subject.humanActorId
                && context.operationId === claim.operationId && context.committerDeviceId === subject.deviceId
                && context.hostAuthorizationRevision === claim.hostAuthorizationRevision
                && admitted(subject, a) && claim.expiresAt > Date.now() ? a.device.signingPublicKey.slice() : null,
            });
            keep(admittedRequest.allocationRequestDigest);
            if (!admitted(subject, a) || claim.expiresAt <= Date.now()) return stale();
            const sourceDigest = keep(crypto.hash(plaintext));
            if (a.candidate.lifecycle !== null) {
              // A previous reservation may belong to an older Tool-source
              // generation. Give canonical recovery the first chance to replay
              // its stored winner or refresh a proved-unpublished reservation
              // before immutable allocation replay compares source digests.
              const recovered = await recover({product, productExecutor: executor, restricted: authorityConnection,
                crypto, serverId, authority: a, claim, sourceDigest});
              if (recovered === "replayed") return {status: "replayed"};
              if (recovered === "conflict") return {status: "integrity_failure"};
            }
            const allocation = await product.allocateExistingRepresentation({
              publisher: {kind: "human_device", humanActorId: subject.humanActorId},
              sessionId: row.sessionId, messageId: row.messageId, revision: row.revision,
              operationId: claim.operationId, expectedNamespaceId: row.namespaceId, expectedKeyClass: claim.keyClass,
              expectedAuthorRole: row.role, expectedAuthorHumanTurnId: row.humanTurnId, expectedSessionAgentId: row.sessionAgentId,
              requestDigest: keep(crypto.hash(plaintext)), repairIdentityDigest: keep(decode(claim.repairIdentityDigestBase64url, 32)),
            });
            if (allocation.status !== "allocated" && allocation.status !== "replayed") return stale();
            if (allocation.lifecycle.completion === "complete" && allocation.lifecycle.disposition === "mapped") {
              return {status: "replayed"};
            }
            const manifestDigest = keep(crypto.hash(manifestBytes));
            const recovered = await recover({product, productExecutor: executor, restricted: authorityConnection,
              crypto, serverId, authority: a, claim, sourceDigest});
            if (recovered === "replayed") return {status: "replayed"};
            if (recovered === "conflict") return {status: "integrity_failure"};
            const repairPublication = {publisherKind: "human_device" as const, publisherId: subject.deviceId,
              publisherHumanId: subject.humanActorId, attestationDigest: manifestDigest};
            const publicationPolicy = {expectedRevision: claim.policyRevision, representation: "ordinary_and_protected" as const};
            if (stage === "reserve") {
              const reserved = await product.reserveExistingRepresentationPublication({
                sessionId: row.sessionId, messageId: row.messageId, revision: row.revision, cryptoObjectId: claim.cryptoObjectId,
                sourceDigest, repairPublication, publicationPolicy});
              return {status: reserved === "reserved" ? "reserved" : "stale"};
            }
            if (allocation.lifecycle.repairPublisherKind !== "human_device"
              || allocation.lifecycle.repairPublisherId !== subject.deviceId
              || allocation.lifecycle.repairPublisherHumanId !== subject.humanActorId
              || allocation.lifecycle.repairAttestationDigest === null
              || encode(allocation.lifecycle.repairAttestationDigest) !== encode(manifestDigest)) return stale();
            const payloadHash = keep(crypto.hash(payloadBytes)), envelopeHash = keep(crypto.hash(envelopeBytes));
            const exactGenesis = (context: {objectId: string; payloadHash: Uint8Array; committerDeviceId: string;
              hostAuthorizationRevision: number; envelopes: readonly {objectId: string; namespaceId: string; keyClass: string;
                keyGeneration: number; bindingRevisionAtWrap: number; envelopeHash: Uint8Array}[]}) => {
              const envelope = context.envelopes[0];
              return admitted(subject, a) && claim.expiresAt > Date.now()
                && context.objectId === claim.cryptoObjectId && encode(context.payloadHash) === encode(payloadHash)
                && context.committerDeviceId === subject.deviceId && context.hostAuthorizationRevision === claim.hostAuthorizationRevision
                && context.envelopes.length === 1 && envelope !== undefined
                && envelope.objectId === claim.cryptoObjectId && envelope.namespaceId === claim.coordinate.namespaceId
                && envelope.keyClass === claim.keyClass && envelope.keyGeneration === claim.namespaceKeyGeneration
                && envelope.bindingRevisionAtWrap === claim.namespaceAccessRevision && encode(envelope.envelopeHash) === encode(envelopeHash);
            };
            const completion = await makeCompletion(restricted(), {crypto,
              resolveCurrentWriteAuthorization: context => exactGenesis(context) ? {...context,
                sourceAuthorized: true, targetAuthorized: true, currentHostAuthorizationRevision: claim.hostAuthorizationRevision,
                committerSigningPublicKey: a.device.signingPublicKey.slice()} : null,
              resolveHistoricalSigner: context => exactGenesis(context) ? {...context,
                committerSigningPublicKey: a.device.signingPublicKey.slice()} : null,
            });
            const result = await createDormantConversationShadowRepository({product, crypto: completion}).completeRevision({
              messageId: row.messageId, expectedRevision: row.revision, parityStatus: "client_authenticated",
              prepared: admittedRequest.prepared,
              publicationPolicy, repairPublication,
            });
            return {status: result.status === "mapped" ? "published" : result.status === "replayed" ? "replayed" : "stale"};
          } catch (error) {
            if (error instanceof TypeError || error instanceof RangeError
              || (error instanceof Error && error.name === "CanonicalDecodingError")) {
              return {status: admitted(subject, a) && claim.expiresAt > Date.now() ? "integrity_failure" : "stale"};
            }
            throw error;
          } finally {owned.forEach(value => value.fill(0));}
        }}) ?? {status: "waiting_for_authority"};
      const reserved = await attempt("reserve");
      if (reserved.status !== "reserved") return reserved;
      const published = await attempt("publish");
      return published.status === "reserved" ? {status: "stale"} : published;
    }});
  };

  const ack = async (subject: MessageBackfillSubject, request: MessageBackfillAckRequest): Promise<MessageBackfillAckResponse> => {
    const stale = (): Promise<MessageBackfillAckResponse> => Promise.resolve({status: "stale", resumeAt: Date.now()});
    return owner.runMutation({ordinary: stale, protected: stale, dual: async () => {
      const current = await currentClaim(subject, request.claimId);
      if (current === null) return stale();
      const {claim, row} = current;
      return await withAuthority({runner: current.canonicalRunner, restricted: restricted(), crypto,
        serverId, subject, candidate: row, claim, use: async (a, product, executor, runner, authorityConnection): Promise<MessageBackfillAckResponse> => {
          if (!admitted(subject, a) || !exact(claim, a.candidate)) return stale();
          const digest = messageBackfillClaimDigest(claim);
          const {signatureBase64url, ...unsigned} = request;
          const proof = messageBackfillAcknowledgementDigest(unsigned), signature = decode(signatureBase64url, 64);
          try {
            if (encode(digest) !== request.claimDigestBase64url || !crypto.verify(a.device.signingPublicKey, proof, signature)) return stale();
          } finally {digest.fill(0); proof.fill(0); signature.fill(0);}
          if (request.outcome === "reconciled") {
            const currentRow = a.candidate, lifecycle = currentRow.lifecycle;
            if (currentRow.cryptoObjectId !== claim.cryptoObjectId || lifecycle?.cryptoObjectId !== claim.cryptoObjectId
              || lifecycle.completion !== "complete" || lifecycle.disposition !== "mapped" || lifecycle.keyClass !== claim.keyClass) return stale();
            if (request.sourceDigestBase64url === null || request.manifestDigestBase64url === null) {
              if (request.sourceDigestBase64url !== null || request.manifestDigestBase64url !== null || !currentRow.ordinaryPresent
                || (!currentRow.ordinaryRestorationAccepted && lifecycle.parityStatus !== "client_verified"
                  && lifecycle.parityStatus !== "server_verified")) return stale();
            } else {
              if (currentRow.ordinaryRestorationAccepted) return stale();
              const sourceBytes = await readSource(executor, {
                humanActorId: subject.humanActorId, sessionId: row.sessionId, messageId: row.messageId, revision: row.revision});
              if (sourceBytes === null) return stale();
              const sourceDigest = crypto.hash(sourceBytes);
              try {if (encode(sourceDigest) !== request.sourceDigestBase64url) return stale();}
              finally {sourceBytes.fill(0); sourceDigest.fill(0);}
              const manifest = await readManifest(authorityConnection, claim.cryptoObjectId);
              if (manifest === null) return stale();
              const manifestDigest = crypto.hash(manifest);
              try {if (encode(manifestDigest) !== request.manifestDigestBase64url) return stale();}
              finally {manifestDigest.fill(0); manifest.fill(0);}
              if (!admitted(subject, a) || claim.expiresAt <= Date.now()) return stale();
              const parity = await product.acceptIndependentMessageParity({
                sessionId: row.sessionId, messageId: row.messageId, revision: row.revision, cryptoObjectId: claim.cryptoObjectId,
                expectedNamespaceId: row.namespaceId, expectedNamespaceAccessRevision: claim.namespaceAccessRevision,
                expectedKeyClass: claim.keyClass, authorityActorId: subject.humanActorId,
                publicationPolicy: {expectedRevision: claim.policyRevision, representation: "ordinary_and_protected"},
              });
              if (parity !== "applied" && parity !== "replayed") return stale();
            }
          } else if (request.sourceDigestBase64url !== null || request.manifestDigestBase64url !== null) return stale();
          if (!admitted(subject, a) || claim.expiresAt <= Date.now()) return stale();
          const failure = request.outcome === "integrity_failure" || request.outcome === "parity_mismatch"
            || request.outcome === "unsupported" ? request.outcome : undefined;
          const accepted = await scanFromRunner(runner).advance({claim, now: Date.now(),
            ...(failure === undefined ? {} : {failure})});
          return accepted ? {status: "more", resumeAt: Date.now()} : stale();
        }}) ?? await stale();
    }});
  };

  return {next, source, publish, ack, progress};
}
