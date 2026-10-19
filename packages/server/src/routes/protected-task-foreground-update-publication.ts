import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validateTaskModelSelectionForCreate, type TaskToolRuntime } from "@nautilo/agent";
import {
  getTaskById,
  getTaskByIdWithMutationVersion,
  updateTaskIfCurrent,
  type DirectDatabase,
  type NewTask,
  type PostgresJsBridgeConnection,
  type Task,
} from "@nautilo/db";
import {
  ClassifiedDataOperationError,
  createDormantTaskContentShadowRepository,
  deriveTaskContentCryptoObjectIdV1,
  readPreparedTaskContentCryptoRevisionSnapshotV1,
  type EncryptionDataOperationOwner,
  type PreparedTaskContentCryptoRevisionV1,
  type TaskDefinitionContent,
  type TaskContentAuthorityV1,
  type TaskContentProductStorePort,
  type TaskContentRepository,
} from "@nautilo/lattice-bridge";
import {
  classifyProtectedTaskMetadataV1,
  reconstructProtectedTaskMetadataV1,
  type ProtectedTaskOperationalMetadataProjectionV1,
} from "@nautilo/types";
import {
  createPostgresForegroundAgentAcceptedExecutionEvidenceResolver,
  createPostgresTaskContentCryptoCompletion,
  PostgresHumanDeviceSignerHistory,
  PostgresTaskContentProductStore,
  prepareNativeTaskDefinitionCryptoRevision,
  publishVerifiedForegroundTaskDefinition,
  TaskContentCryptoCompletionConflictError,
  verifyConversationProductPostgresHandle,
  verifyCryptoPostgresHandle,
  withOpenForegroundTaskDefinition,
  withVerifiedForegroundTaskDefinitionPublication,
  type PrepareNativeTaskDefinitionCryptoRevisionInput,
} from "@nautilo/lattice-bridge/server";
import type { LatticeCrypto, ResolveCurrentDeviceWrappedAgentObjectAccessGenesisSetAuthorization } from "@nautilo/lattice-crypto";
import { computeNextFireAt } from "@nautilo/runtime";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import { createProtectedTaskHistoricalForegroundAuthorizationDeviceSigningKeyResolver,
  createProtectedTaskHistoricalHumanDeviceSigningKeyResolver } from "./protected-task-historical-human-device-signing-key";
import { createProtectedTaskRequesterPrivateRoomResolver } from "./protected-task-requester-private-room";
import { createTaskDefinitionForegroundAuthorizationResolver } from "./task-definition-foreground-authorization";

type UpdateInput = Parameters<NonNullable<TaskToolRuntime["updateProtectedTask"]>>[0];
type UpdateResult = Awaited<ReturnType<NonNullable<TaskToolRuntime["updateProtectedTask"]>>>;
type PreflightInput = Readonly<{ operationId: string; request: UpdateInput }>;
export type ProtectedTaskForegroundUpdatePreflight = Readonly<{
  operationId: string;
  requestFingerprint: string;
  scheduleReferenceTime: number;
  representation: "protected" | "dual";
  source: Task & Readonly<{ mutationVersion: string }>;
  patch: Readonly<Partial<NewTask>>;
}>;
type PublishInput = PreflightInput & Readonly<{ preflight: ProtectedTaskForegroundUpdatePreflight }>;

export type ProtectedTaskForegroundUpdateProductContext = Readonly<{
  transaction: CanonicalTranscriptTx;
  product: PostgresJsBridgeConnection;
  restricted: PostgresJsBridgeConnection;
  resolveCurrentForegroundDefinitionAuthorization: ResolveCurrentDeviceWrappedAgentObjectAccessGenesisSetAuthorization;
  resolveAuthority(namespaceId: string, taskExecutorAgentId: string): Promise<TaskContentAuthorityV1 | null>;
  assertCurrent(): Promise<void>;
}>;

type Dependencies = Readonly<{
  owner: EncryptionDataOperationOwner;
  crypto: LatticeCrypto;
  entities: PrepareNativeTaskDefinitionCryptoRevisionInput["entities"];
  publication: PrepareNativeTaskDefinitionCryptoRevisionInput["publication"];
  withCurrentProduct<Value>(request: UpdateInput, use: (context: ProtectedTaskForegroundUpdateProductContext) => Promise<Value>): Promise<Value>;
  now?: () => number;
}>;
type Overrides = Readonly<{
  verifyProduct?: typeof verifyConversationProductPostgresHandle;
  verifyCrypto?: typeof verifyCryptoPostgresHandle;
  productStore?(input: Readonly<{ product: Awaited<ReturnType<typeof verifyConversationProductPostgresHandle>>;
    authority: TaskContentAuthorityV1;
    assertCurrent(): Promise<void> }>): TaskContentProductStorePort;
  open?: typeof withOpenForegroundTaskDefinition;
  inspectPrepared?: typeof withVerifiedForegroundTaskDefinitionPublication;
  publishVerified?: typeof publishVerifiedForegroundTaskDefinition;
  prepare?: typeof prepareNativeTaskDefinitionCryptoRevision;
  resolveForegroundAgentAcceptedExecutionEvidence?: Parameters<typeof withOpenForegroundTaskDefinition>[0]["resolveForegroundAgentAcceptedExecutionEvidence"];
  resolveHistoricalAgentSignerAuthority?: Parameters<typeof withOpenForegroundTaskDefinition>[0]["resolveHistoricalAgentSignerAuthority"];
  repository?(input: Readonly<{ product: TaskContentProductStorePort }>): TaskContentRepository;
}>;

function unavailable(message: string): never {
  throw new ClassifiedDataOperationError("recoverable_availability", message);
}
function invalid(message: string): never {
  throw new ClassifiedDataOperationError("integrity", message);
}
function sameBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  return left !== null && right !== null && left.length === right.length
    && left.every((value, index) => value === right[index]);
}
function wipePrepared(prepared: PreparedTaskContentCryptoRevisionV1): void {
  const snapshot = readPreparedTaskContentCryptoRevisionSnapshotV1(prepared);
  const visit = (value: unknown): void => {
    if (value instanceof Uint8Array) value.fill(0);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(snapshot);
  visit(prepared);
}
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)]),
  );
  return value;
}
function fingerprintRequest(request: UpdateInput): string {
  return createHash("sha256").update("nautilo/task-foreground-update-request/v1\0")
    .update(JSON.stringify(canonical(request))).digest("hex");
}
function safeResult(task: Pick<Task, "id" | "ownerId" | "status" | "scheduleKind" | "targetChat" | "nextFireAt" | "resultDelivery">): UpdateResult {
  return { id: task.id, ownerId: task.ownerId, status: task.status, scheduleKind: task.scheduleKind,
    targetChat: task.targetChat, nextFireAt: task.nextFireAt, resultDelivery: task.resultDelivery };
}
function scheduleReferenceDate(value: number): Date {
  const date = new Date(value);
  if (!Number.isFinite(value) || Number.isNaN(date.getTime())) {
    invalid("Foreground Task update time is invalid");
  }
  return date;
}
function operationalPatch(request: UpdateInput, current: Task, now: Date): Partial<NewTask> {
  const patch: Partial<NewTask> = {};
  if (request.scheduleKind !== undefined) patch.scheduleKind = request.scheduleKind;
  if (request.runAt !== undefined) patch.runAt = request.runAt;
  if (request.cron !== undefined) patch.cron = request.cron;
  if (request.timezone !== undefined) patch.timezone = request.timezone;
  if (request.targetChat !== undefined) {
    patch.targetChat = request.targetChat;
    if (request.targetChat !== current.targetChat) patch.targetRoomId = null;
  }
  if (request.resultDelivery !== undefined) patch.resultDelivery = request.resultDelivery;
  if (request.toolsMode !== undefined) patch.toolsMode = request.toolsMode;
  if (request.toolsWhitelist !== undefined) patch.toolsWhitelist = [...request.toolsWhitelist];
  if (request.timeLimitSeconds !== undefined) patch.timeLimitSeconds = request.timeLimitSeconds;
  if (request.selectionProfile !== undefined) patch.selectionProfile = request.selectionProfile;
  if (request.selectionSpec !== undefined) patch.selectionSpec = request.selectionSpec;
  if (request.requestedModelId !== undefined) patch.requestedModelId = request.requestedModelId;
  if (request.scheduleKind !== undefined || request.runAt !== undefined
    || request.cron !== undefined || request.timezone !== undefined) {
    patch.nextFireAt = computeNextFireAt(request.scheduleKind ?? current.scheduleKind,
      request.runAt ?? current.runAt ?? undefined, request.cron ?? current.cron,
      request.timezone ?? current.timezone, now);
  }
  return patch;
}
const MUTABLE_RUNTIME_METADATA_KEYS = new Set(["preparation", "lastInterruption"]);
function withoutMutableRuntimeMetadata(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input)
    .filter(([key]) => !MUTABLE_RUNTIME_METADATA_KEYS.has(key)));
}
function mutableRuntimeMetadata(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input)
    .filter(([key]) => MUTABLE_RUNTIME_METADATA_KEYS.has(key)));
}
function reconcileCurrentRuntimeMetadata(
  current: Task["metadata"],
  definition: Task["metadata"],
  representation: "protected" | "dual",
): Readonly<{ metadata: Task["metadata"];
  operational: ProtectedTaskOperationalMetadataProjectionV1;
  revisionOperational: ProtectedTaskOperationalMetadataProjectionV1 }> {
  const definitionParts = classifyProtectedTaskMetadataV1(definition);
  if (definitionParts.status !== "supported") {
    invalid("Foreground Task definition metadata cannot be classified");
  }
  const currentDefinition = representation === "protected"
    ? reconstructProtectedTaskMetadataV1(current, definitionParts.protectedContent)
    : null;
  if (currentDefinition?.status === "unsupported") {
    invalid("Foreground Task protected projection cannot be reconstructed");
  }
  const currentParts = classifyProtectedTaskMetadataV1(
    currentDefinition?.status === "supported" ? currentDefinition.metadata : current);
  if (currentParts.status !== "supported"
    || !isDeepStrictEqual(withoutMutableRuntimeMetadata(currentParts.operational),
      withoutMutableRuntimeMetadata(definitionParts.operational))
    || representation === "dual"
      && !isDeepStrictEqual(withoutMutableRuntimeMetadata(currentParts.protectedContent),
        withoutMutableRuntimeMetadata(definitionParts.protectedContent))
    || representation === "protected" && !isDeepStrictEqual(current, currentParts.operational)) {
    invalid("Foreground Task metadata changed outside mutable runtime diagnostics");
  }
  const operational = {
    ...withoutMutableRuntimeMetadata(definitionParts.operational),
    ...mutableRuntimeMetadata(currentParts.operational),
  };
  const protectedContent = {
    ...withoutMutableRuntimeMetadata(definitionParts.protectedContent),
    ...mutableRuntimeMetadata(representation === "dual"
      ? currentParts.protectedContent : definitionParts.protectedContent),
  };
  const reconciled = reconstructProtectedTaskMetadataV1(operational, protectedContent);
  if (reconciled.status !== "supported") {
    invalid("Foreground Task mutable runtime diagnostics cannot be reconciled");
  }
  const classified = classifyProtectedTaskMetadataV1(reconciled.metadata);
  if (classified.status !== "supported") invalid("Foreground Task metadata cannot be classified");
  return Object.freeze({ metadata: reconciled.metadata, operational: classified.operational,
    revisionOperational: definitionParts.operational });
}

/** The foreground grant opens, validates, transforms and reseals one current
 * definition. No plaintext content survives its callback. */
export function createProtectedTaskForegroundUpdatePublication(input: Dependencies, overrides: Overrides = {}) {
  type Entry = Readonly<{ fingerprint: string }> & {
    prepared?: PreparedTaskContentCryptoRevisionV1;
    inFlight?: Promise<UpdateResult>;
    baseRevision?: number;
    targetRevision?: number;
  };
  const entries = new Map<string, Entry>();
  let disposed = false;
  const assertLive = () => {
    input.entities.signal.throwIfAborted();
    if (disposed) unavailable("Foreground Task update callback is closed");
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    input.entities.signal.removeEventListener("abort", dispose);
    for (const entry of entries.values()) {
      if (entry.inFlight === undefined && entry.prepared !== undefined) wipePrepared(entry.prepared);
    }
    entries.clear();
  };
  input.entities.signal.addEventListener("abort", dispose, { once: true });

  const inspect = (raw: PreflightInput): Promise<ProtectedTaskForegroundUpdatePreflight> => {
    assertLive();
    const request = structuredClone(raw.request);
    const requestFingerprint = fingerprintRequest(request);
    const scheduleReferenceTime = (input.now ?? Date.now)();
    const scheduleReference = scheduleReferenceDate(scheduleReferenceTime);
    const perform = async (representation: "protected" | "dual") =>
      input.withCurrentProduct(request, async context => {
        const assertCurrent = async () => { assertLive(); await context.assertCurrent(); assertLive(); };
        await assertCurrent();
        if (request.ownerId !== request.requestorId) invalid("Foreground Task update identity is invalid");
        const db = context.transaction as unknown as DirectDatabase;
        const current = await getTaskByIdWithMutationVersion(db, request.taskId, {
          lifecycleOnly: true, ownerId: request.ownerId,
        });
        if (current === undefined || current.ownerId !== request.requestorId
          || current.requestorId !== request.requestorId
          || current.parentTaskId !== null || current.depth !== 0
          || (current.status !== "pending" && current.status !== "paused") || current.fireLockId !== null
          || current.contentRepresentation !== representation || current.contentNamespaceId === null
          || current.contentRevision < 1 || current.cryptoMappingState !== "verified"
          || current.cryptoObjectId === null) invalid("Foreground Task update target changed");
        const authority = await context.resolveAuthority(current.contentNamespaceId, current.agentId);
        if (authority === null) unavailable("Foreground Task private authority is unavailable");
        const product = await (overrides.verifyProduct ?? verifyConversationProductPostgresHandle)(context.product);
        const productStore = overrides.productStore?.({ product, authority, assertCurrent })
          ?? new PostgresTaskContentProductStore(product, async expected => {
            await assertCurrent();
            return expected.requesterHumanId === authority.requesterHumanId
              && expected.namespaceId === authority.namespaceId ? authority : null;
          }, assertCurrent);
        const state = await productStore.getRevision({ kind: "definition", taskId: request.taskId,
          contentRevision: current.contentRevision });
        if (state === null || state.lifecycle.completion !== "complete" || state.lifecycle.disposition !== "mapped"
          || state.lifecycle.historicalRepair != null || state.product === null
          || Object.hasOwn(state.lifecycle.operationalMetadata ?? {}, "execution")
          || state.product.cryptoObjectId !== current.cryptoObjectId
          || state.product.namespaceId !== current.contentNamespaceId
          || state.product.representation !== representation
          || state.product.cryptoAccessRevision !== current.cryptoAccessRevision
          || !sameBytes(state.product.cryptoRequiredNamespaceFingerprint, current.cryptoRequiredNamespaceFingerprint)
          || state.product.cryptoMappingState !== "verified") invalid("Foreground Task mapped definition changed");
        const source = Object.freeze({ ...current, prompt: "", expectedOutput: null,
          metadata: state.lifecycle.operationalMetadata ?? {} });
        const patch = Object.freeze(operationalPatch(request, source, scheduleReference));
        await assertCurrent();
        return Object.freeze({ operationId: raw.operationId, requestFingerprint, scheduleReferenceTime,
          representation, source, patch });
      });
    return input.owner.runMutation({ protected: () => perform("protected"), dual: () => perform("dual") });
  };

  const publish = (raw: PublishInput): Promise<UpdateResult> => {
    assertLive();
    const request = structuredClone(raw.request);
    const fingerprint = fingerprintRequest(request);
    if (raw.preflight.operationId !== raw.operationId
      || raw.preflight.requestFingerprint !== fingerprint
      || !Number.isFinite(raw.preflight.scheduleReferenceTime)) {
      invalid("Foreground Task funding preflight changed");
    }
    let entry = entries.get(raw.operationId);
    if (entry !== undefined && entry.fingerprint !== fingerprint) {
      invalid("Foreground Task retry changed its requested update");
    }
    if (entry?.inFlight !== undefined) return entry.inFlight;
    entry ??= { fingerprint };
    entries.set(raw.operationId, entry);
    const currentEntry = entry;

    const perform = async (representation: "protected" | "dual"): Promise<UpdateResult> =>
      input.withCurrentProduct(request, async context => {
        let active = true;
        const assertCurrent = async () => {
          assertLive();
          if (!active) unavailable("Foreground Task product callback is closed");
          await context.assertCurrent();
          assertLive();
        };
        try {
          await assertCurrent();
          if (request.ownerId !== request.requestorId) invalid("Foreground Task update identity is invalid");
          const db = context.transaction as unknown as DirectDatabase;
          const safe = await getTaskByIdWithMutationVersion(db, request.taskId, {
            lifecycleOnly: true,
            ownerId: request.ownerId,
          });
          if (safe === undefined) invalid("Foreground Task update target is unavailable");
          if (safe.ownerId !== request.requestorId || safe.requestorId !== request.requestorId
            || safe.parentTaskId !== null || safe.depth !== 0
            || (safe.status !== "pending" && safe.status !== "paused")
            || safe.fireLockId !== null || safe.contentRepresentation !== representation
            || safe.contentNamespaceId === null || safe.contentRevision < 1
            || safe.cryptoMappingState !== "verified" || safe.cryptoObjectId === null) {
            invalid("Foreground Task update target changed");
          }
          const authority = await context.resolveAuthority(safe.contentNamespaceId, safe.agentId);
          if (authority === null) unavailable("Foreground Task private authority is unavailable");
          const product = await (overrides.verifyProduct ?? verifyConversationProductPostgresHandle)(context.product);
          const crypto = await (overrides.verifyCrypto ?? verifyCryptoPostgresHandle)(context.restricted);
          const history = overrides.resolveHistoricalAgentSignerAuthority === undefined
            ? new PostgresHumanDeviceSignerHistory({ handle: crypto, crypto: input.crypto })
            : null;
          const resolveForegroundAgentAcceptedExecutionEvidence =
            overrides.resolveForegroundAgentAcceptedExecutionEvidence
            ?? createPostgresForegroundAgentAcceptedExecutionEvidenceResolver({
              product, crypto: input.crypto, rejectInvalidSelectedEvidence: true,
            });
          const resolveHistoricalAgentSignerAuthority = overrides.resolveHistoricalAgentSignerAuthority
            ?? history!.resolveAgentRuntimeSignerManager;
          const productStore = overrides.productStore?.({ product, authority, assertCurrent })
            ?? new PostgresTaskContentProductStore(product, async expected => {
            await assertCurrent();
            return expected.requesterHumanId === authority.requesterHumanId
              && expected.namespaceId === authority.namespaceId ? authority : null;
            }, assertCurrent);
          const currentCoordinate = { kind: "definition" as const,
            taskId: request.taskId, contentRevision: safe.contentRevision };
          const currentState = await productStore.getRevision(currentCoordinate);
          if (currentState === null || currentState.lifecycle.completion !== "complete"
            || currentState.lifecycle.disposition !== "mapped" || currentState.product === null
            || currentState.product.coordinate.contentRevision !== safe.contentRevision
            || currentState.product.cryptoObjectId !== safe.cryptoObjectId
            || currentState.product.namespaceId !== safe.contentNamespaceId
            || currentState.product.representation !== representation
            || currentState.product.cryptoAccessRevision !== safe.cryptoAccessRevision
            || !sameBytes(currentState.product.cryptoRequiredNamespaceFingerprint,
              safe.cryptoRequiredNamespaceFingerprint)
            || currentState.product.cryptoMappingState !== "verified") {
            invalid("Foreground Task mapped definition changed");
          }
          if (currentState.lifecycle.historicalRepair != null) {
            invalid("Foreground Task historical definition update requires supported repair");
          }
          if (raw.preflight.representation !== representation
            || safe.mutationVersion !== raw.preflight.source.mutationVersion
            || !isDeepStrictEqual({ ...safe, prompt: "", expectedOutput: null,
              metadata: currentState.lifecycle.operationalMetadata ?? {} },
              raw.preflight.source)
            || !isDeepStrictEqual(operationalPatch(request, raw.preflight.source,
              scheduleReferenceDate(raw.preflight.scheduleReferenceTime)), raw.preflight.patch)) {
            invalid("Foreground Task changed after funding preflight");
          }
          const nextRevision = safe.contentRevision + 1;
          if (!Number.isSafeInteger(nextRevision)) invalid("Foreground Task content revision is exhausted");
          const privateRoom = await createProtectedTaskRequesterPrivateRoomResolver(
            context.transaction,
          )(safe.ownerId, safe.agentId, authority.namespaceId);
          if (privateRoom === null) invalid("Foreground Task private Room is unavailable");
          const resolveTaskAuthorization = (contentRevision: number) =>
            createTaskDefinitionForegroundAuthorizationResolver({
              crypto: input.crypto,
              expectedObjectId: deriveTaskContentCryptoObjectIdV1({
                kind: "definition", taskId: request.taskId, contentRevision,
              }),
              taskId: request.taskId,
              operation: contentRevision === 1 ? "create" : "update",
              targetContentRevision: contentRevision,
              privateRoomId: privateRoom.roomId,
              humanId: authority.requesterHumanId,
              namespaceId: authority.namespaceId,
              domainId: authority.domainId,
              resolveAcceptedExecutionEvidence:
                resolveForegroundAgentAcceptedExecutionEvidence,
              resolveHistoricalDeviceSigningPublicKey:
                createProtectedTaskHistoricalForegroundAuthorizationDeviceSigningKeyResolver(
                  crypto,
                ),
            });
          const resolveCurrentTaskDefinitionForegroundAuthorization =
            resolveTaskAuthorization(safe.contentRevision);
          const resolveNextTaskDefinitionForegroundAuthorization =
            resolveTaskAuthorization(nextRevision);
          const operation = await productStore.getRevisionByOperation({ operationId: raw.operationId });
          if (operation.status === "authority_unavailable") unavailable("Foreground Task retry authority is unavailable");
          if (operation.status === "conflict") invalid("Foreground Task retry publication is ambiguous");
          if (operation.status === "found") {
            const state = operation.state;
            const coordinate = state.lifecycle.coordinate;
            if (state.lifecycle.operationId !== raw.operationId || coordinate.kind !== "definition"
              || coordinate.taskId !== request.taskId || state.lifecycle.representation !== representation
              || !sameBytes(state.lifecycle.requestDigest, Uint8Array.from(Buffer.from(fingerprint, "hex")))) {
              invalid("Foreground Task retry publication changed");
            }
            if (state.lifecycle.disposition === "mapped" && state.lifecycle.completion === "complete"
              && state.product !== null && coordinate.contentRevision === safe.contentRevision
              && state.product.coordinate.contentRevision === safe.contentRevision
              && state.product.cryptoObjectId === safe.cryptoObjectId
              && state.product.namespaceId === safe.contentNamespaceId
              && state.product.representation === representation
              && state.product.cryptoAccessRevision === safe.cryptoAccessRevision
              && sameBytes(state.product.cryptoRequiredNamespaceFingerprint, safe.cryptoRequiredNamespaceFingerprint)
              && state.product.cryptoMappingState === "verified") {
              await assertCurrent();
              return safeResult(safe);
            }
            if (state.lifecycle.disposition !== "active" || coordinate.contentRevision !== nextRevision
              || (currentEntry.baseRevision !== undefined && currentEntry.baseRevision !== safe.contentRevision)
              || (currentEntry.targetRevision !== undefined && currentEntry.targetRevision !== coordinate.contentRevision)) {
              invalid("Foreground Task retry no longer owns the current revision");
            }
          } else if (currentEntry.targetRevision !== undefined
            && (currentEntry.baseRevision !== safe.contentRevision || currentEntry.targetRevision !== nextRevision)) {
            invalid("Foreground Task retry no longer owns the current revision");
          }
          currentEntry.baseRevision ??= safe.contentRevision;
          currentEntry.targetRevision ??= nextRevision;
          let recoveredPreparedPublication = false;
          let revisionOperationalMetadata: ProtectedTaskOperationalMetadataProjectionV1 | undefined;
          const opened = await (overrides.open ?? withOpenForegroundTaskDefinition)({
            handle: crypto,
            crypto: input.crypto,
            taskId: request.taskId,
            contentRevision: safe.contentRevision,
            expectedAgentId: safe.agentId,
            currentAuthority: authority,
            entities: input.entities,
            resolveForegroundAgentAcceptedExecutionEvidence,
            resolveHistoricalAgentSignerAuthority,
            resolveHistoricalHumanDeviceSigningPublicKey: createProtectedTaskHistoricalHumanDeviceSigningKeyResolver(crypto),
            resolveTaskDefinitionForegroundAuthorization:
              resolveCurrentTaskDefinitionForegroundAuthorization,
            assertCurrent,
            use: async opened => {
              const payload = opened.payload;
              const current = await getTaskByIdWithMutationVersion(db, request.taskId);
              if (current === undefined || current.status !== safe.status
                || current.contentRevision !== safe.contentRevision
                || current.contentRepresentation !== representation
                || current.cryptoObjectId !== safe.cryptoObjectId
                || current.fireLockId !== null) invalid("Foreground Task changed during validation");
              const reconstructed = reconstructProtectedTaskMetadataV1(
                currentState.lifecycle.operationalMetadata ?? {}, payload.protectedMetadata);
              if (reconstructed.status !== "supported") invalid("Foreground Task metadata cannot be reconstructed");
              if (Object.hasOwn(currentState.lifecycle.operationalMetadata ?? {}, "execution")) {
                invalid("Foreground Task update supports native Tasks only");
              }
              const reconciledMetadata = reconcileCurrentRuntimeMetadata(
                current.metadata, reconstructed.metadata, representation);
              revisionOperationalMetadata = reconciledMetadata.revisionOperational;
              if (representation === "dual" && (current.prompt !== payload.prompt
                || current.expectedOutput !== payload.expectedOutput
                )) {
                invalid("Foreground Task dual definition parity changed");
              }
              if (representation === "protected" && (current.prompt !== ""
                || current.expectedOutput !== null)) {
                invalid("Foreground Task protected projection changed");
              }
              const nextPayload = Object.freeze({
                formatVersion: 1 as const,
                prompt: request.prompt ?? payload.prompt,
                expectedOutput: request.expectedOutput ?? payload.expectedOutput,
                protectedMetadata: payload.protectedMetadata,
              });
              const nextContent: TaskDefinitionContent = opened.retainedHistoricalError === null
                ? nextPayload
                : Object.freeze({
                  formatVersion: 2 as const,
                  prompt: nextPayload.prompt,
                  expectedOutput: nextPayload.expectedOutput,
                  protectedMetadata: nextPayload.protectedMetadata,
                  retainedHistoricalError: opened.retainedHistoricalError,
                });
              const patch: Partial<NewTask> = {
                ...raw.preflight.patch,
                metadata: representation === "dual"
                  ? reconciledMetadata.metadata
                  : reconciledMetadata.operational,
                ...(representation === "dual" ? {
                  prompt: nextPayload.prompt,
                  expectedOutput: nextPayload.expectedOutput,
                } : {}),
              };
              const prospective = { ...current, ...patch,
                metadata: currentState.lifecycle.operationalMetadata ?? {} } as Task;
              if (current.fundingMode !== "caller" && (request.toolsMode !== undefined
                || request.toolsWhitelist !== undefined || request.requestedModelId !== undefined
                || request.selectionProfile !== undefined || request.selectionSpec !== undefined)) {
                const selectionError = validateTaskModelSelectionForCreate({
                  requestedModelId: prospective.requestedModelId,
                  profile: prospective.selectionProfile,
                  spec: prospective.selectionSpec,
                  toolsMode: prospective.toolsMode,
                  toolsWhitelist: prospective.toolsWhitelist,
                });
                if (selectionError !== null) throw new TypeError(selectionError);
              }
              if (currentEntry.prepared === undefined) {
                const inspected = await (overrides.inspectPrepared
                  ?? withVerifiedForegroundTaskDefinitionPublication)({
                  handle: crypto,
                  crypto: input.crypto,
                  taskId: request.taskId,
                  contentRevision: nextRevision,
                  expectedAgentId: request.agentId,
                  expectedRequestDigest: Uint8Array.from(Buffer.from(fingerprint, "hex")),
                  payload: nextContent,
                  currentAuthority: authority,
                  entities: input.entities,
                  resolveForegroundAgentAcceptedExecutionEvidence,
                  resolveHistoricalAgentSignerAuthority,
                  resolveHistoricalHumanDeviceSigningPublicKey: createProtectedTaskHistoricalHumanDeviceSigningKeyResolver(crypto),
                  resolveTaskDefinitionForegroundAuthorization:
                    resolveNextTaskDefinitionForegroundAuthorization,
                  assertCurrent,
                  use: async proof => {
                    const updated = await updateTaskIfCurrent(db, {
                      id: current.id,
                      ownerId: current.ownerId,
                      expectedStatus: current.status as "pending" | "paused",
                      expectedMutationVersion: current.mutationVersion,
                      expectedContentRevision: current.contentRevision,
                    }, patch);
                    if (updated === undefined) invalid("Foreground Task changed during validation");
                    await (overrides.publishVerified ?? publishVerifiedForegroundTaskDefinition)({
                      proof, product: productStore, operationId: raw.operationId,
                      representation, operationalMetadata: reconciledMetadata.revisionOperational,
                    });
                    recoveredPreparedPublication = true;
                  },
                });
                if (inspected.status === "unavailable") {
                  unavailable("Foreground Task ciphertext awaits exact current-authority recovery");
                }
                if (inspected.status === "verified") return true;
              }
              if (currentEntry.prepared === undefined) {
                const prepared = await (overrides.prepare ?? prepareNativeTaskDefinitionCryptoRevision)({
                  crypto: input.crypto,
                  taskId: current.id,
                  contentRevision: nextRevision,
                  payload: nextContent,
                  authority,
                  entities: input.entities,
                  publication: input.publication,
                  createdAt: (input.now ?? Date.now)(),
                });
                if (prepared === null) unavailable("Foreground Task private Namespace needs fresh authorization");
                currentEntry.prepared = prepared;
              }
              const updated = await updateTaskIfCurrent(db, {
                id: current.id,
                ownerId: current.ownerId,
                expectedStatus: current.status as "pending" | "paused",
                expectedMutationVersion: current.mutationVersion,
                expectedContentRevision: current.contentRevision,
              }, patch);
              if (updated === undefined) invalid("Foreground Task changed during validation");
              return true;
            },
          });
          if (opened.status !== "opened") unavailable("Foreground Task current definition is unavailable");
          if (!recoveredPreparedPublication && currentEntry.prepared === undefined) {
            invalid("Foreground Task update was not prepared");
          }
          if (!recoveredPreparedPublication) {
          const prepared = currentEntry.prepared;
          if (prepared === undefined) invalid("Foreground Task update was not prepared");
          if (revisionOperationalMetadata === undefined) {
            invalid("Foreground Task update metadata was not classified");
          }
          const repository = overrides.repository?.({ product: productStore })
            ?? createDormantTaskContentShadowRepository({
            product: productStore,
            crypto: createPostgresTaskContentCryptoCompletion({
              handle: crypto,
              crypto: input.crypto,
              resolveForegroundAgentAcceptedExecutionEvidence,
              resolveCurrentAuthority: async coordinate => {
                await assertCurrent();
                return coordinate.kind === "definition" && coordinate.taskId === request.taskId
                  && coordinate.contentRevision === nextRevision ? authority : null;
              },
              resolveCurrentForegroundDefinitionAuthorization: async value => {
                await assertCurrent();
                return context.resolveCurrentForegroundDefinitionAuthorization(value);
              },
              resolveHistoricalAgentSignerAuthority,
              resolveHistoricalHumanDeviceSigningPublicKey: () => Promise.resolve(null),
              resolveTaskDefinitionForegroundAuthorization:
                resolveNextTaskDefinitionForegroundAuthorization,
            }),
          });
          // The durable request digest binds both private-definition and
          // operational edits. Ciphertext bytes are independently authenticated
          // by the prepared revision and must not stand in for request identity.
          const requestDigest = Uint8Array.from(Buffer.from(fingerprint, "hex"));
          const reserved = await repository.reserveRevision({
            operationId: raw.operationId,
            requestDigest,
            representation,
            authority,
            prepared,
            operationalMetadata: revisionOperationalMetadata,
          });
          if (reserved.status !== "reserved" && reserved.status !== "replayed") {
            invalid("Foreground Task update reservation changed");
          }
          let completed;
          try {
            completed = await repository.completeRevision({
              coordinate: prepared.coordinate,
              prepared,
            });
          } catch (cause) {
            if (cause instanceof TaskContentCryptoCompletionConflictError) {
              unavailable("Foreground Task ciphertext awaits exact current-authority recovery");
            }
            throw cause;
          }
          if (completed.status !== "mapped" && completed.status !== "replayed") {
            unavailable("Foreground Task mapping is pending");
          }
          }
          const mapped = await getTaskById(db, request.taskId, {
            lifecycleOnly: true,
            ownerId: request.ownerId,
          });
          const expectedObjectId = deriveTaskContentCryptoObjectIdV1({
            kind: "definition", taskId: request.taskId, contentRevision: nextRevision,
          });
          if (mapped === undefined || mapped.contentRevision !== nextRevision
            || mapped.cryptoMappingState !== "verified" || mapped.contentRepresentation !== representation
            || mapped.contentNamespaceId !== authority.namespaceId
            || mapped.cryptoObjectId !== expectedObjectId) invalid("Foreground Task update did not map atomically");
          await assertCurrent();
          return safeResult(mapped);
        } finally { active = false; }
      });

    const promise = input.owner.runMutation({
      protected: () => perform("protected"),
      dual: () => perform("dual"),
    });
    currentEntry.inFlight = promise;
    void promise.finally(() => {
      delete currentEntry.inFlight;
      if (disposed && currentEntry.prepared !== undefined) wipePrepared(currentEntry.prepared);
    }).catch(() => {});
    return promise;
  };

  return Object.freeze({ preflight: inspect, publish, dispose });
}
