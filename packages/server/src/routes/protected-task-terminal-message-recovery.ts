import {
  and, backgroundCryptoAuthorizationRequests, eq, getEncryptionTransitionPolicy,
  PROTECTED_TASK_CANCELLED_RESULT, recordProtectedTaskRunMessagePublished,
  sessionMessages, sessionMessageCryptoRevisions, taskRunMessageAssociations,
  type DirectDatabase, type PostgresJsBridgeConnection,
} from "@nautilo/db";
import {
  encodeMessagePayloadV2,
  type EncryptionDataOperationOwner,
} from "@nautilo/lattice-bridge";
import {
  assertVerifiedStagedTaskTerminalMessagePublication, cryptoTypedDb,
  executeTypedCryptoQuery, hasTaskTerminalMessageCryptoPublication,
  inspectStagedTaskTerminalMessagePublication,
  readStagedTaskTerminalMessagePublicationPolicy, readCryptoStorageInteger,
  NativeTaskMessageCryptoCompletionConflictError, PostgresHumanDeviceSignerHistory,
  verifyCryptoPostgresHandle, withTaskDeliveryNamespaceAuthority,
  type CryptoPostgresHandle, type NativeTaskTerminalMessageCurrentAuthority,
  type NativeTaskTerminalMessageIntent, type VerifiedStagedTaskTerminalMessagePublication,
} from "@nautilo/lattice-bridge/server";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import { findActorByOwnerId, type CanonicalTranscriptTx } from "@nautilo/trust";
import { createHumanProductTransactionContext } from "./human-message-product-store";
import {
  protectedTaskTerminalMessageRequestId, type ProtectedTaskTerminalMessagePlan,
} from "./protected-task-terminal-message-plan";
import {
  readProtectedTaskTerminalMessageIntent, resolveProtectedTaskTerminalMessageDestination,
  sameProtectedTaskTerminalMessageIntent, type ProtectedTaskTerminalMessageIntent,
} from "./protected-task-terminal-message-product";
import { lockExactProtectedTaskTerminalMessageAllocation } from "./protected-task-terminal-message-allocation";
import { withProtectedTaskTerminalMessageProductStore } from "./protected-task-terminal-message-store";
import { createProtectedTaskRequesterPrivateRoomResolver,
  type ProtectedTaskRequesterPrivateRoomResolver } from "./protected-task-requester-private-room";

type Coordinates = Readonly<{ taskId: string; taskRunId: string }>;
type Outcome = "missing" | "pending" | "mapped" | "quarantined";
type Allocation = Readonly<{
  sessionId: string; messageId: number; revision: 0; objectId: string;
  createdAt: number; publicationPolicyRevision: number | null;
}>;
type RequestMetadata = Readonly<{
  requestId: string; workId: string; kind: string; purpose: string;
  namespaceId: string; domainId: string | null; policyRevision: number;
  accessRevision: number;
}>;

export type TerminalMessageRecoverySettlementInput = Readonly<{
  intent: ProtectedTaskTerminalMessageIntent;
  proof: VerifiedStagedTaskTerminalMessagePublication;
  currentAuthority: NativeTaskTerminalMessageCurrentAuthority;
  requesterHumanId: string;
  transaction: CanonicalTranscriptTx;
  restricted: PostgresJsBridgeConnection;
  deferRecipientCleanup(release: () => void): void;
}>;

export type ProtectedTaskTerminalMessageRecoveryDependencies = Readonly<{
  readIntent: typeof readProtectedTaskTerminalMessageIntent;
  readAllocation(transaction: CanonicalTranscriptTx, intent: ProtectedTaskTerminalMessageIntent, sessionId: string): Promise<Allocation | null>;
  readRequest(handle: CryptoPostgresHandle, requestId: string): Promise<RequestMetadata | null>;
  readStagedPolicy: typeof readStagedTaskTerminalMessagePublicationPolicy;
  mappedAssociation(transaction: CanonicalTranscriptTx, intent: ProtectedTaskTerminalMessageIntent,
    allocation: Allocation): Promise<boolean>;
  readPolicy: typeof getEncryptionTransitionPolicy;
  resolveHuman: typeof findActorByOwnerId;
  resolveRoom: ProtectedTaskRequesterPrivateRoomResolver;
  productContext: typeof createHumanProductTransactionContext;
  withAuthority: typeof withTaskDeliveryNamespaceAuthority;
  resolveDestination: typeof resolveProtectedTaskTerminalMessageDestination;
  cryptoHandle: typeof verifyCryptoPostgresHandle;
  inspect: typeof inspectStagedTaskTerminalMessagePublication;
  assertStaged: typeof assertVerifiedStagedTaskTerminalMessagePublication;
  hasPublication: typeof hasTaskTerminalMessageCryptoPublication;
  withStore: typeof withProtectedTaskTerminalMessageProductStore;
  recordPublished: typeof recordProtectedTaskRunMessagePublished;
}>;

class RecoveryConflict extends Error {}

/** Use the same exact allocation proof as preparation and publication. */
async function readAllocation(transaction: CanonicalTranscriptTx,
  intent: ProtectedTaskTerminalMessageIntent, sessionId: string,
  crypto: LatticeCrypto): Promise<Allocation | null> {
  const encoded = encodeMessagePayloadV2({ role: "assistant", content: PROTECTED_TASK_CANCELLED_RESULT });
  const digest = crypto.hash(encoded);
  try {
    const allocation = await lockExactProtectedTaskTerminalMessageAllocation({
      transaction, intent, sessionId, expectedPayloadDigest: digest,
      phase: "staged_or_mapped",
    });
    if (allocation === null) return null;
    return Object.freeze({ sessionId,
      messageId: allocation.lifecycle.messageId, revision: 0,
      objectId: allocation.lifecycle.cryptoObjectId, createdAt: allocation.createdAt,
      publicationPolicyRevision: allocation.lifecycle.publicationPolicyRevision });
  } catch (error: unknown) {
    if (error instanceof TypeError) throw new RecoveryConflict(error.message);
    throw error;
  } finally { encoded.fill(0); digest.fill(0); }
}

async function readRequest(handle: CryptoPostgresHandle, requestId: string): Promise<RequestMetadata | null> {
  const table = backgroundCryptoAuthorizationRequests;
  const rows = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({
    request_id: table.requestId, work_id: table.workId, work_kind: table.workKind,
    purpose: table.purpose, namespace_id: table.namespaceId, domain_id: table.domainId,
    expected_policy_revision: table.expectedPolicyRevision,
    expected_namespace_access_revision: table.expectedNamespaceAccessRevision,
  }).from(table).where(eq(table.requestId, requestId)).limit(2));
  const row = rows[0];
  if (rows.length === 0) return null;
  if (rows.length !== 1 || row === undefined) throw new RecoveryConflict("Terminal Message request is ambiguous");
  return { requestId: row.request_id, workId: row.work_id, kind: row.work_kind,
    purpose: row.purpose, namespaceId: row.namespace_id, domainId: row.domain_id,
    policyRevision: readCryptoStorageInteger(row, "expected_policy_revision"),
    accessRevision: readCryptoStorageInteger(row, "expected_namespace_access_revision") };
}

async function mappedAssociation(transaction: CanonicalTranscriptTx,
  intent: ProtectedTaskTerminalMessageIntent, allocation: Allocation): Promise<boolean> {
  const rows = await transaction.select({ messageId: sessionMessages.id })
    .from(sessionMessages).innerJoin(sessionMessageCryptoRevisions, and(
      eq(sessionMessageCryptoRevisions.sessionId, sessionMessages.sessionId),
      eq(sessionMessageCryptoRevisions.messageId, sessionMessages.id),
      eq(sessionMessageCryptoRevisions.editRevision, sessionMessages.editRevision),
    )).innerJoin(taskRunMessageAssociations, and(
      eq(taskRunMessageAssociations.sessionId, sessionMessages.sessionId),
      eq(taskRunMessageAssociations.messageId, sessionMessages.id),
      eq(taskRunMessageAssociations.publishedRevision, sessionMessages.editRevision),
    )).where(and(eq(sessionMessages.id, allocation.messageId),
      eq(sessionMessages.sessionId, allocation.sessionId), eq(sessionMessages.editRevision, 0),
      eq(sessionMessages.cryptoObjectId, allocation.objectId),
      eq(sessionMessageCryptoRevisions.cryptoObjectId, allocation.objectId),
      eq(sessionMessageCryptoRevisions.completion, "complete"),
      eq(sessionMessageCryptoRevisions.disposition, "mapped"),
      eq(taskRunMessageAssociations.taskRunId, intent.taskRunId),
      eq(taskRunMessageAssociations.kind, "raw_delivery"),
      eq(taskRunMessageAssociations.publicationKey, intent.messageOperationId),
    )).limit(2);
  return rows.length === 1;
}

function sameStage(left: VerifiedStagedTaskTerminalMessagePublication,
  right: VerifiedStagedTaskTerminalMessagePublication): boolean {
  const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
  return JSON.stringify(left.intent) === JSON.stringify(right.intent)
    && left.requestId === right.requestId && left.claimId === right.claimId
    && left.recipientGeneration === right.recipientGeneration
    && equal(left.authorizationDigest, right.authorizationDigest)
    && equal(left.genesisManifestHash, right.genesisManifestHash)
    && equal(left.authorityFingerprint, right.authorityFingerprint);
}

/** Replays only a retained terminal receipt; never opens a grant or prepares bytes. */
export function createProtectedTaskTerminalMessageRecovery(input: Readonly<{
  db: DirectDatabase; restricted: PostgresJsBridgeConnection; crypto: LatticeCrypto;
  owner: EncryptionDataOperationOwner; serverScope: string; now?: () => number;
  settle?(input: TerminalMessageRecoverySettlementInput): Promise<boolean>;
  dependencies?: Partial<ProtectedTaskTerminalMessageRecoveryDependencies>;
}>) {
  const overrides = input.dependencies ?? {};
  const dependencies: ProtectedTaskTerminalMessageRecoveryDependencies = {
    readIntent: (tx, coordinates) => readProtectedTaskTerminalMessageIntent(tx, coordinates, { allowPublished: true }),
    readAllocation: (tx, intent, sessionId) => readAllocation(tx, intent, sessionId, input.crypto),
    readRequest, mappedAssociation,
    readStagedPolicy: readStagedTaskTerminalMessagePublicationPolicy,
    readPolicy: getEncryptionTransitionPolicy, resolveHuman: findActorByOwnerId,
    resolveRoom: createProtectedTaskRequesterPrivateRoomResolver(input.db),
    productContext: createHumanProductTransactionContext, withAuthority: withTaskDeliveryNamespaceAuthority,
    resolveDestination: resolveProtectedTaskTerminalMessageDestination,
    cryptoHandle: verifyCryptoPostgresHandle, inspect: inspectStagedTaskTerminalMessagePublication,
    assertStaged: assertVerifiedStagedTaskTerminalMessagePublication,
    hasPublication: hasTaskTerminalMessageCryptoPublication,
    withStore: withProtectedTaskTerminalMessageProductStore,
    recordPublished: recordProtectedTaskRunMessagePublished, ...overrides,
  };
  const now = input.now ?? Date.now;

  async function recoverCoordinates(coordinates: Coordinates, settleAbandoned: boolean): Promise<Outcome> {
    try {
      const intent = await input.db.transaction(tx => dependencies.readIntent(tx, coordinates));
      if (intent === null) return "missing";
      const run = async (representation: "protected" | "dual"): Promise<Outcome> => {
        if (intent.representation !== representation) return "pending";
        const policy = await dependencies.readPolicy(input.db);
        if (policy.mode !== (representation === "protected" ? "encrypted_only" : "shadow_encryption")
          || policy.revision < intent.acceptedPolicyRevision) return "pending";
        const [human, room] = await Promise.all([
          dependencies.resolveHuman(intent.requesterUserId),
          dependencies.resolveRoom(intent.requesterUserId, intent.agentId, intent.contentNamespaceId),
        ]);
        if (human === null || room?.namespaceId !== intent.contentNamespaceId) return "pending";
        const context = await dependencies.productContext(intent.requesterUserId, input.db);
        let deferredCleanup: (() => void)[] = [];
        const result = await dependencies.withAuthority({
          runner: context.canonicalRunner, restricted: input.restricted, crypto: input.crypto,
          serverScope: input.serverScope, taskId: intent.taskId, requesterUserId: intent.requesterUserId,
          requesterHumanId: human.id, agentId: intent.agentId, contentNamespaceId: intent.contentNamespaceId,
          sourceRoomId: room.roomId, destinationRoomId: intent.destinationRoomId,
          destinationNamespaceId: intent.destinationNamespaceId, expectedPolicyRevision: policy.revision,
          validateCurrentTaskRun: async (_product, tx) => {
            const fresh = await dependencies.readIntent(tx, coordinates);
            return fresh !== null && sameProtectedTaskTerminalMessageIntent(intent, fresh);
          },
          use: async (authority, product, transaction, restricted): Promise<Outcome> => {
            // A canonical transaction retry must discard the failed attempt's cleanup.
            deferredCleanup = [];
            const fact = authority.facts[0];
            if (authority.facts.length !== 1 || fact === undefined
              || fact.namespaceId !== intent.destinationNamespaceId || fact.expectedPolicyRevision !== policy.revision
              || authority.sourceRoomId !== intent.destinationRoomId
              || authority.sourceNamespaceId !== intent.contentNamespaceId) return "pending";
            const destination = await dependencies.resolveDestination(transaction, intent);
            if (destination === null) return "pending";
            const allocation = await dependencies.readAllocation(transaction, intent, destination.sessionId);
            if (allocation === null) return "missing";
            if (allocation.sessionId !== destination.sessionId || !Number.isSafeInteger(allocation.createdAt)
              || allocation.createdAt > now()) return "pending";
            const handle = await dependencies.cryptoHandle(restricted);
            const requestId = protectedTaskTerminalMessageRequestId(intent.taskRunId);
            // No immutable publication exists yet: let the preparation owner
            // repair an interrupted policy/request refresh before minting a grant.
            if (!await dependencies.hasPublication(handle, { requestId, objectId: allocation.objectId })) return "missing";
            const record = await dependencies.readRequest(handle, requestId);
            const retainedPolicy = await dependencies.readStagedPolicy(handle, {
              requestId, objectId: allocation.objectId,
              acceptedPolicyRevision: intent.acceptedPolicyRevision,
            });
            const savedPolicy = allocation.publicationPolicyRevision ?? retainedPolicy ?? record?.policyRevision;
            if (savedPolicy === undefined || !Number.isSafeInteger(savedPolicy)
              || savedPolicy < intent.acceptedPolicyRevision || savedPolicy > policy.revision) return "pending";
            if (retainedPolicy !== null && retainedPolicy !== savedPolicy) {
              throw new RecoveryConflict("Terminal Message retained policy changed");
            }
            if (record !== null && (record.requestId !== requestId || record.workId !== intent.taskRunId
              || record.kind !== "task.deliver_message" || record.purpose !== "task.deliver_message"
              || record.namespaceId !== fact.namespaceId || record.domainId !== fact.domainId
              || record.accessRevision !== fact.expectedAccessRevision || record.policyRevision !== savedPolicy)) return "pending";
            const encoded = encodeMessagePayloadV2({ role: "assistant", content: PROTECTED_TASK_CANCELLED_RESULT });
            const digest = input.crypto.hash(encoded);
            let native: NativeTaskTerminalMessageIntent;
            try {
              native = Object.freeze({ taskId: intent.taskId, taskRunId: intent.taskRunId,
                bindingId: intent.bindingId, messageOperationId: intent.messageOperationId,
                ...allocation, namespaceId: fact.namespaceId, domainId: fact.domainId,
                roomId: intent.destinationRoomId, mode: representation === "protected" ? "encrypted_only" : "shadow_encryption",
                acceptedPolicyRevision: intent.acceptedPolicyRevision, publicationPolicyRevision: savedPolicy,
                signerAgentId: intent.agentId, role: "assistant", requestId,
                payloadDigest: Array.from(digest, value => value.toString(16).padStart(2, "0")).join("") });
            } finally { encoded.fill(0); digest.fill(0); }
            const current: NativeTaskTerminalMessageCurrentAuthority = Object.freeze({
              taskId: native.taskId, taskRunId: native.taskRunId, bindingId: native.bindingId,
              messageOperationId: native.messageOperationId, sessionId: native.sessionId,
              messageId: native.messageId, revision: native.revision, objectId: native.objectId,
              roomId: native.roomId, namespaceId: native.namespaceId, domainId: native.domainId,
              mode: native.mode, acceptedPolicyRevision: native.acceptedPolicyRevision,
              currentPolicyRevision: policy.revision, namespaceAccessRevision: fact.expectedAccessRevision,
            });
            const history = new PostgresHumanDeviceSignerHistory({ handle, crypto: input.crypto });
            const inspect = () => dependencies.inspect({ handle, crypto: input.crypto, intent: native,
              currentAuthority: current, resolveHistoricalAgentSignerAuthority: history.resolveAgentRuntimeSignerManager });
            const staged = await inspect();
            if (staged === null) return await dependencies.hasPublication(handle, { requestId, objectId: native.objectId })
              ? "quarantined" : "missing";
            dependencies.assertStaged(staged, current);
            const assertCurrent = async () => {
              dependencies.assertStaged(staged, current);
              const fresh = await dependencies.readIntent(transaction, coordinates);
              const allocationNow = await dependencies.readAllocation(transaction, intent, destination.sessionId);
              if (fresh === null || !sameProtectedTaskTerminalMessageIntent(intent, fresh)
                || JSON.stringify(allocationNow) !== JSON.stringify(allocation)) throw new RecoveryConflict("Terminal Message product authority changed");
              const verified = await inspect();
              if (verified === null) throw new RecoveryConflict("Terminal Message receipt disappeared");
              dependencies.assertStaged(verified, current);
              if (!sameStage(staged, verified)) throw new RecoveryConflict("Terminal Message receipt changed");
            };
            await assertCurrent();
            const recordPublished = async (): Promise<"mapped"> => {
              const borrowed: Pick<DirectDatabase, "transaction"> = {
                transaction: async callback => callback(transaction),
              };
              const receipt = await dependencies.recordPublished(borrowed, { ...coordinates, messageId: native.messageId });
              if (receipt.status !== "recorded" && receipt.status !== "exact_replay") throw new Error("Terminal Message binding receipt is pending");
              if (settleAbandoned && input.settle !== undefined) {
                await assertCurrent();
                let active = true;
                try {
                  const settled = await input.settle({ intent, proof: staged, currentAuthority: current,
                    requesterHumanId: human.id, transaction, restricted,
                    deferRecipientCleanup: release => {
                      if (!active) throw new Error("Terminal Message settlement authority is closed");
                      deferredCleanup.push(release);
                    },
                  });
                  if (!settled) throw new Error("Terminal Message authorization settlement is pending");
                  await assertCurrent();
                } finally { active = false; }
              }
              return "mapped";
            };
            if (await dependencies.mappedAssociation(transaction, intent, allocation)) {
              return recordPublished();
            }
            return dependencies.withStore({ product, transaction, intent, destination,
              publicationPolicyRevision: savedPolicy,
              use: async store => {
                const publicationPolicy = { expectedRevision: policy.revision,
                  representation: representation === "protected" ? "protected_only" as const : "ordinary_and_protected" as const };
                const coordinate = { sessionId: native.sessionId, messageId: native.messageId,
                  revision: native.revision, cryptoObjectId: native.objectId, leaseToken: null };
                const completed = await store.markCryptoComplete({ ...coordinate, publicationPolicy, parityStatus: representation === "protected" ? "server_authenticated" : "server_verified" });
                if (completed !== "applied" && completed !== "duplicate") throw new Error("Terminal Message completion is pending");
                await assertCurrent();
                const mapped = await store.compareAndSwapCryptoMapping({ ...coordinate, publicationPolicy,
                  expectedNamespaceId: native.namespaceId });
                if (mapped !== "applied" && mapped !== "duplicate") throw new Error("Terminal Message mapping is pending");
                await assertCurrent();
                return recordPublished();
              },
            });
          },
        });
        if (result === "mapped") for (const release of deferredCleanup) release();
        return result ?? "pending";
      };
      return await input.owner.runMutation({ protected: () => run("protected"), dual: () => run("dual") });
    } catch (error: unknown) {
      return error instanceof RecoveryConflict || error instanceof NativeTaskMessageCryptoCompletionConflictError
        ? "quarantined" : "pending";
    }
  }
  return Object.freeze({ recoverCoordinates: (coordinates: Coordinates) => recoverCoordinates(coordinates, true),
    recover: async (plan: ProtectedTaskTerminalMessagePlan): Promise<"mapped" | "pending"> =>
      await recoverCoordinates(plan.intent, false) === "mapped" ? "mapped" : "pending" });
}
