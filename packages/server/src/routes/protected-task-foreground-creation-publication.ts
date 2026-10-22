import { parseProtectedTaskCodexSelection } from "./protected-task-codex-selection";
import { parseProtectedTaskHermesSelection } from "./protected-task-hermes-selection";
import { parseProtectedTaskOpenCodeSelection } from "./protected-task-opencode-selection";
import { createProtectedTaskHistoricalForegroundAuthorizationDeviceSigningKeyResolver,
  createProtectedTaskHistoricalHumanDeviceSigningKeyResolver } from "./protected-task-historical-human-device-signing-key";
import { createTaskDefinitionForegroundAuthorizationResolver } from "./task-definition-foreground-authorization";
import { createProtectedTaskRequesterPrivateRoomResolver } from "./protected-task-requester-private-room";
import { withVerifiedForegroundTaskDefinitionPublication, publishVerifiedForegroundTaskDefinition } from "@nautilo/lattice-bridge/server";
import { isDeepStrictEqual } from "node:util";
import { eq, tasks, type NewTask, type PostgresJsBridgeConnection } from "@nautilo/db";
import { ClassifiedDataOperationError, createDormantTaskContentShadowRepository,
  encodeTaskPayloadV1, deriveTaskContentCryptoObjectIdV1, readPreparedTaskContentCryptoRevisionSnapshotV1,
  type EncryptionDataOperationOwner, type PreparedTaskContentCryptoRevisionV1,
  type TaskContentAuthorityV1 } from "@nautilo/lattice-bridge";
import { createPostgresTaskContentCryptoCompletion,
  createPostgresForegroundAgentAcceptedExecutionEvidenceResolver,
  PostgresHumanDeviceSignerHistory, PostgresTaskContentProductStore, TaskContentCryptoCompletionConflictError,
  prepareNativeTaskDefinitionCryptoRevision, verifyConversationProductPostgresHandle,
  verifyCryptoPostgresHandle, type PrepareNativeTaskDefinitionCryptoRevisionInput } from "@nautilo/lattice-bridge/server";
import type { LatticeCrypto, ResolveCurrentDeviceWrappedAgentObjectAccessGenesisSetAuthorization } from "@nautilo/lattice-crypto";
import type { ProtectedTaskCreateCandidate, ProtectedTaskCreationPlanV1, TaskCreationResult } from "@nautilo/runtime";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import { classifyProtectedTaskMetadataV1 } from "@nautilo/types";
import { prepareProtectedTaskScope } from "./protected-task-scope-creation";
import { parseClaudeTaskExecutionMetadata } from "../claude/task-execution-route";

type Creation = Readonly<{ operationId: string; prepared: ProtectedTaskCreationPlanV1; candidate: ProtectedTaskCreateCandidate }>;
export type ProtectedTaskForegroundCreationProductContext = Readonly<{
  transaction: CanonicalTranscriptTx;
  product: PostgresJsBridgeConnection;
  /** Independent crypto commits must finish before the outer product commit. */
  restricted: PostgresJsBridgeConnection;
  authority: TaskContentAuthorityV1;
  resolveCurrentForegroundDefinitionAuthorization: ResolveCurrentDeviceWrappedAgentObjectAccessGenesisSetAuthorization;
  assertCurrent(): Promise<void>;
}>;
export type WithProtectedTaskForegroundCreationProduct = <Value>(input: Readonly<{
  plan: ProtectedTaskCreationPlanV1;
  candidate: ProtectedTaskCreateCandidate;
  use(context: ProtectedTaskForegroundCreationProductContext): Promise<Value>;
}>) => Promise<Value | null>;

type Dependencies = Readonly<{
  prepare: typeof prepareNativeTaskDefinitionCryptoRevision;
  repository: typeof createDormantTaskContentShadowRepository;
  inspect: typeof withVerifiedForegroundTaskDefinitionPublication;
  publishVerified: typeof publishVerifiedForegroundTaskDefinition;
}>;
function unavailable(message: string): never {
  throw new ClassifiedDataOperationError("recoverable_availability", message);
}
function invalid(message: string): never {
  throw new ClassifiedDataOperationError("integrity", message);
}
function sameAuthority(left: TaskContentAuthorityV1, right: TaskContentAuthorityV1): boolean {
  return isDeepStrictEqual(left, right);
}
function snapshotCreation(input: Creation) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(input.operationId)) invalid("Foreground Task operation identity is invalid");
  const candidate = structuredClone(input.candidate);
  const classification = classifyProtectedTaskMetadataV1(candidate.metadata ?? {});
  if (classification.status !== "supported"
    || candidate.ownerId !== input.prepared.canonicalTaskIdentity.ownerId
    || candidate.requestorId !== input.prepared.canonicalTaskIdentity.requestorId
    || candidate.agentId !== input.prepared.canonicalTaskIdentity.agentId
    || candidate.parentTaskId != null || (candidate.depth ?? 0) !== 0
    || candidate.status !== "pending" || candidate.lastError != null
    || (input.prepared.shape.executor === "native"
      ? classification.operational["execution"] !== undefined
      : input.prepared.shape.executor !== "external_harness"
        || (parseClaudeTaskExecutionMetadata({ execution: classification.operational["execution"] }) === null
          && parseProtectedTaskCodexSelection({ execution: classification.operational["execution"] }) === null
          && parseProtectedTaskHermesSelection({ execution: classification.operational["execution"] }) === null
          && parseProtectedTaskOpenCodeSelection({ execution: classification.operational["execution"] }) === null))
    || !isDeepStrictEqual(classification.operational, input.prepared.operationalMetadata)
    || !isDeepStrictEqual({ formatVersion: 1, prompt: candidate.prompt,
      expectedOutput: candidate.expectedOutput ?? null, protectedMetadata: classification.protectedContent }, input.prepared.payload)
    || ["artifactRefs", "artifactOperationId", "artifactId"].some(key => Object.hasOwn(classification.protectedContent, key))) {
    invalid("Foreground Task creation no longer matches its admitted definition");
  }
  const bytes = encodeTaskPayloadV1(input.prepared.payload);
  bytes.fill(0);
  return { operationId: input.operationId, candidate, prepared: { ...structuredClone(input.prepared), operationalMetadata: classification.operational } };
}
function valuesFor(input: Creation, representation: "protected" | "dual"): NewTask {
  const c = input.candidate;
  return {
    id: c.id, ownerId: c.ownerId, requestorId: c.requestorId, agentId: c.agentId,
    prompt: representation === "protected" ? "" : input.prepared.payload.prompt,
    expectedOutput: representation === "protected" ? null : input.prepared.payload.expectedOutput,
    metadata: representation === "protected" ? input.prepared.operationalMetadata : c.metadata ?? {},
    preset: c.preset ?? "task", scheduleKind: c.scheduleKind ?? "now", runAt: c.runAt ?? null,
    cron: c.cron ?? null, timezone: c.timezone ?? "UTC", catchup: c.catchup ?? "run_once",
    callingRoomId: c.callingRoomId ?? null, targetChat: c.targetChat ?? "orphan",
    targetChatHandle: c.targetChatHandle ?? null, targetRoomId: c.targetRoomId ?? null,
    resultDelivery: c.resultDelivery ?? "wake", targetUserIds: c.targetUserIds ?? [],
    useScope: c.useScope ?? false, scopeId: c.scopeId ?? null,
    toolsMode: c.toolsMode ?? "auto", toolsWhitelist: c.toolsWhitelist ?? [],
    awaitResponse: c.awaitResponse ?? false, selectionProfile: c.selectionProfile ?? "balanced",
    selectionSpec: c.selectionSpec ?? null, requestedModelId: c.requestedModelId ?? null,
    fundingMode: c.fundingMode, timeLimitSeconds: c.timeLimitSeconds ?? null,
    parentTaskId: null, depth: 0, status: "paused", nextFireAt: c.nextFireAt,
    localExecutionDelegation: c.localExecutionDelegation,
    contentRepresentation: "ordinary", contentNamespaceId: null, contentRevision: 0,
    cryptoObjectId: null, cryptoAccessRevision: 0, cryptoRequiredNamespaceFingerprint: null,
    cryptoMappingState: "unmapped", lastError: null,
  };
}
function wipePrepared(prepared: PreparedTaskContentCryptoRevisionV1): void {
  const snapshot = readPreparedTaskContentCryptoRevisionSnapshotV1(prepared);
  const visit = (value: unknown): void => {
    if (value instanceof Uint8Array) value.fill(0);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(snapshot); visit(prepared);
}

/** One live foreground owns this cache. It is not a restart-adoption authority. */
export function createProtectedTaskForegroundCreationPublication(input: Readonly<{
  owner: EncryptionDataOperationOwner;
  crypto: LatticeCrypto;
  entities: PrepareNativeTaskDefinitionCryptoRevisionInput["entities"];
  publication: PrepareNativeTaskDefinitionCryptoRevisionInput["publication"];
  withCurrentProduct: WithProtectedTaskForegroundCreationProduct;
  now?: () => number;
}>, overrides: Partial<Dependencies> = {}) {
  const dependencies = { prepare: prepareNativeTaskDefinitionCryptoRevision,
    repository: createDormantTaskContentShadowRepository, inspect: withVerifiedForegroundTaskDefinitionPublication,
    publishVerified: publishVerifiedForegroundTaskDefinition, ...overrides };
  type Entry = { creation: ReturnType<typeof snapshotCreation>; prepared?: PreparedTaskContentCryptoRevisionV1;
    inFlight?: Promise<TaskCreationResult> };
  const entries = new Map<string, Entry>();
  let disposed = false;
  const assertLive = () => {
    input.entities.signal.throwIfAborted();
    if (disposed) unavailable("Foreground Task creation callback is closed");
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    input.entities.signal.removeEventListener("abort", dispose);
    for (const entry of entries.values()) {
      if (entry.inFlight === undefined && entry.prepared !== undefined) wipePrepared(entry.prepared);
    }
    // In-flight owners retain their entry until rollback and wipe in finally.
    entries.clear();
  };
  input.entities.signal.addEventListener("abort", dispose, { once: true });
  const publish = (request: Creation): Promise<TaskCreationResult> => {
    assertLive();
    const creation = snapshotCreation(request);
    let entry = entries.get(creation.candidate.id);
    if (entry !== undefined && !isDeepStrictEqual(entry.creation, creation)) {
      invalid("Foreground Task retry changed its admitted candidate");
    }
    if (entry?.inFlight !== undefined) return entry.inFlight;
    entry ??= { creation };
    entries.set(creation.candidate.id, entry);
    const currentEntry = entry;
    const perform = async (representation: "protected" | "dual"): Promise<TaskCreationResult> => {
      assertLive();
      const result = await input.withCurrentProduct({ plan: creation.prepared,
        candidate: creation.candidate, use: async context => {
          let active = true;
          const assertCurrent = async () => {
            assertLive();
            if (!active) unavailable("Foreground Task product callback is closed");
            if (!sameAuthority(context.authority, creation.prepared.authority)) unavailable("Foreground Task private authority changed");
            await context.assertCurrent(); assertLive();
          };
          try {
            await assertCurrent();
            const product = await verifyConversationProductPostgresHandle(context.product);
            const crypto = await verifyCryptoPostgresHandle(context.restricted);
            const values = valuesFor(creation, representation);
            const rows = await context.transaction.select().from(tasks)
              .where(eq(tasks.id, creation.candidate.id)).for("update").limit(2);
            if (rows.length > 1) invalid("Foreground Task identity is not unique");
            const existing = rows[0];
            if (creation.candidate.useScope === true) {
              values.scopeId = await prepareProtectedTaskScope(context.transaction, {
                taskId: creation.candidate.id, requesterUserId: creation.candidate.requestorId,
                agentId: creation.candidate.agentId, scopeId: creation.candidate.scopeId ?? null,
              });
            }
            if (existing !== undefined) {
              const operational = { ...values };
              for (const key of ["status", "nextFireAt", "lastError", "contentRepresentation", "contentNamespaceId", "contentRevision",
                "cryptoObjectId", "cryptoAccessRevision", "cryptoRequiredNamespaceFingerprint", "cryptoMappingState"] as const) delete operational[key];
              if (!Object.entries(operational).every(([key, value]) =>
                isDeepStrictEqual(existing[key as keyof typeof existing], value))) {
                invalid("Foreground Task identity conflicts with another definition");
              }
            }
            const history = new PostgresHumanDeviceSignerHistory({ handle: crypto, crypto: input.crypto });
            const resolveForegroundAgentAcceptedExecutionEvidence =
              createPostgresForegroundAgentAcceptedExecutionEvidenceResolver({
                product, crypto: input.crypto, rejectInvalidSelectedEvidence: true,
              });
            const privateRoom = await createProtectedTaskRequesterPrivateRoomResolver(
              context.transaction,
            )(creation.candidate.ownerId, creation.candidate.agentId,
              context.authority.namespaceId);
            if (privateRoom === null) invalid("Foreground Task private Room is unavailable");
            const objectId = deriveTaskContentCryptoObjectIdV1({
              kind: "definition", taskId: creation.candidate.id, contentRevision: 1,
            });
            const resolveTaskDefinitionForegroundAuthorization =
              createTaskDefinitionForegroundAuthorizationResolver({
                crypto: input.crypto,
                expectedObjectId: objectId,
                taskId: creation.candidate.id,
                operation: "create",
                targetContentRevision: 1,
                privateRoomId: privateRoom.roomId,
                humanId: context.authority.requesterHumanId,
                namespaceId: context.authority.namespaceId,
                domainId: context.authority.domainId,
                resolveAcceptedExecutionEvidence:
                  resolveForegroundAgentAcceptedExecutionEvidence,
                resolveHistoricalDeviceSigningPublicKey:
                  createProtectedTaskHistoricalForegroundAuthorizationDeviceSigningKeyResolver(
                    crypto,
                  ),
              });
            const productStore = new PostgresTaskContentProductStore(product, async expected => {
                await assertCurrent();
                return expected.requesterHumanId === context.authority.requesterHumanId
                  && expected.namespaceId === context.authority.namespaceId ? context.authority : null;
              }, assertCurrent);
            const repository = dependencies.repository({
              product: productStore,
              crypto: createPostgresTaskContentCryptoCompletion({ handle: crypto, crypto: input.crypto,
                resolveForegroundAgentAcceptedExecutionEvidence,
                resolveCurrentAuthority: async coordinate => {
                  await assertCurrent();
                  return coordinate.kind === "definition" && coordinate.taskId === creation.candidate.id
                    && coordinate.contentRevision === 1 ? context.authority : null;
                }, resolveCurrentForegroundDefinitionAuthorization: async ctx => {
                  await assertCurrent();
                  return context.resolveCurrentForegroundDefinitionAuthorization(ctx);
                }, resolveHistoricalAgentSignerAuthority: history.resolveAgentRuntimeSignerManager,
                resolveHistoricalHumanDeviceSigningPublicKey: () => Promise.resolve(null),
                resolveTaskDefinitionForegroundAuthorization }),
            });
            const inspected = await dependencies.inspect({ handle: crypto, crypto: input.crypto,
                resolveForegroundAgentAcceptedExecutionEvidence,
                taskId: creation.candidate.id, expectedAgentId: creation.candidate.agentId,
                payload: creation.prepared.payload, currentAuthority: context.authority, entities: input.entities,
                resolveHistoricalAgentSignerAuthority: history.resolveAgentRuntimeSignerManager,
                resolveHistoricalHumanDeviceSigningPublicKey: createProtectedTaskHistoricalHumanDeviceSigningKeyResolver(crypto),
                resolveTaskDefinitionForegroundAuthorization,
                assertCurrent, use: async proof => {
                  if (existing === undefined) await context.transaction.insert(tasks).values(values);
                  await dependencies.publishVerified({ proof, product: productStore, operationId: creation.operationId,
                    representation, operationalMetadata: creation.prepared.operationalMetadata });
                  return true;
                } });
            if (inspected.status === "unavailable" || inspected.status === "missing" && existing !== undefined) {
              unavailable("Foreground Task ciphertext awaits current-authority recovery");
            }
            if (inspected.status === "missing") {
              if (currentEntry.prepared === undefined) {
                const prepared = await dependencies.prepare({ crypto: input.crypto,
                  taskId: creation.candidate.id, payload: creation.prepared.payload,
                  authority: context.authority, entities: input.entities, publication: input.publication,
                  createdAt: (input.now ?? Date.now)() });
                if (prepared === null) unavailable("Foreground Task private Namespace needs fresh authorization");
                currentEntry.prepared = prepared;
              }
              await assertCurrent();
              if (existing === undefined) await context.transaction.insert(tasks).values(values);
              const snapshot = readPreparedTaskContentCryptoRevisionSnapshotV1(currentEntry.prepared);
              const reserved = await repository.reserveRevision({ operationId: creation.operationId,
                requestDigest: input.crypto.hash(snapshot.access.manifestBytes), representation,
                authority: context.authority, prepared: currentEntry.prepared,
                operationalMetadata: creation.prepared.operationalMetadata });
              if (reserved.status !== "reserved" && reserved.status !== "replayed") unavailable("Foreground Task reservation changed");
              let completed;
              try {
                completed = await repository.completeRevision({ coordinate: currentEntry.prepared.coordinate,
                  prepared: currentEntry.prepared });
              } catch (cause) {
                if (cause instanceof TaskContentCryptoCompletionConflictError) {
                  unavailable("Foreground Task ciphertext awaits exact current-authority recovery");
                }
                throw cause;
              }
              if (completed.status !== "mapped" && completed.status !== "replayed") unavailable("Foreground Task mapping is pending");
            }
            const mapped = await context.transaction.select().from(tasks)
              .where(eq(tasks.id, creation.candidate.id)).limit(2);
            const row = mapped[0];
            if (mapped.length !== 1 || row === undefined || row.contentRevision !== 1
              || row.cryptoMappingState !== "verified" || row.contentRepresentation !== representation
              || row.contentNamespaceId !== context.authority.namespaceId
              || row.cryptoObjectId !== objectId
              || (existing === undefined && row.status !== "pending")) {
              invalid("Foreground Task definition did not map atomically");
            }
            await assertCurrent();
            return { taskId: row.id, status: row.status, nextFireAt: row.nextFireAt ?? undefined,
              publicationDisposition: existing === undefined ? "created" as const : "replayed" as const };
          } finally { active = false; }
        } });
      assertLive();
      if (result === null) unavailable("Foreground Task creation authority is unavailable");
      return result;
    };
    const promise = input.owner.runMutation({ protected: () => perform("protected"), dual: () => perform("dual") });
    currentEntry.inFlight = promise;
    void promise.finally(() => {
      delete currentEntry.inFlight;
      if (disposed && currentEntry.prepared !== undefined) wipePrepared(currentEntry.prepared);
    }).catch(() => {});
    return promise;
  };
  return Object.freeze({ publish, dispose });
}
