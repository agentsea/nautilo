import { assertFixtureDbMutationAllowed } from "@nautilo/db/testing";
import { installForegroundProjectionProductRollback } from "./foreground-projection-product-rollback-fixture";
import {
  installConnectedDelegatedLocalExecution,
  installSyntheticPersonalOpenRouter,
  type ConnectedDelegatedLocalExecutionFixture,
} from "./protected-task-caller-local-execution-fixture";
import { createHash, randomUUID } from "node:crypto";
import { rejects } from "node:assert/strict";

import { beforeEach, describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { Annotation, Command, END, START, StateGraph } from "@langchain/langgraph";
import { AcpSemanticRelay } from "@nautilo/acp-host";
import { validateAcpInitializeCapabilityTruth } from
  "../../../acp-host/src/capability-truth";
import { resolveModelRole, protectedMemoryAuthorityFromEnvelope, assertProtectedTaskAdditionalAuthorityResumeAcknowledgementV1,
  lockAtomicProjectionDestinationAuthority, fingerprintProjectionAudience,
  protectedTaskInterruptCoordinates, createProtectedTaskAdditionalAuthorityResumeMapV1,
  invokeChatModelWithFallback, deepResearchTaskMetadata, admittedDeepResearchTaskMetadata,
  type ProtectedTaskMemoryAccessHandoff,
} from "@nautilo/agent";
import { createLiveShadowCheckpointSaver } from
  "../../../runtime/src/conversation/live-shadow-checkpoint-saver";
import { disposeProtectedCheckpointSaver } from
  "../../../runtime/src/conversation/protected-checkpoint-saver-disposal";
import { sealProtectedTaskWakeCheckpointManifest } from
  "../../../runtime/src/tasks/protected-task-wake-checkpoint-manifest";
import { getCurrentProtectedTaskWakeExecutionCustody } from
  "../../../runtime/src/tasks/protected-task-wake-foreground-context";
import { protectedTaskWakeParked, isProtectedTaskWakeParked } from
  "../../../runtime/src/tasks/protected-task-wake-execution-candidate";
import {
  PROTECTED_TASK_CANCELLED_RESULT,
  actors,
  agentCryptoRuntimeChallenges,
  agentCryptoRuntimeConfigObjects,
  agentCryptoRuntimeDomainEnvelopes,
  agentCryptoRuntimeSigners,
  agentCryptoRuntimeStates,
  agentScopes,
  agents,
  backgroundCryptoAuthorizationDomainRequirements,
  backgroundCryptoAuthorizationNamespaceRequirements,
  backgroundCryptoAuthorizationRequests,
  acquireEncryptionConsumptionFence,
  createDirectDb,
  createPostgresJsBridgeConnection,
  cryptoDomains,
  cryptoObjects,
  codexAccountProfiles,
  codexUserPreferences,
  foregroundMemoryCryptoPublicationReceipts,
  discoverTaskContentBackfill,
  claimTaskContentBackfill,
  releaseTaskContentBackfillLease,
  discoverParkedProtectedTaskCheckpointContinuation,
  discoverParkedProtectedTaskAdditionalAuthority,
  domainKeyEnvelopeAcknowledgements,
  domainKeyHeads,
  domainKeyPublicationOperations,
  domainKeyRecipientEnvelopes,
  domainKeyRecipientRequests,
  encryptionTransitionPolicy,
  eq,
  getEncryptionTransitionPolicy,
  getProtectedTaskMutationSourceById,
  getTaskByIdWithMutationVersion,
  getSharedDirectCryptoDb,
  getSharedDirectAgentDb,
  getSharedDirectDb,
  groupMembers,
  groups,
  humanCryptoCustodies,
  humanCryptoDeviceGroupAcknowledgements,
  humanCryptoDeviceGroupCommits,
  humanCryptoDeviceGroupHeads,
  humanCryptoDeviceGroupJoinRequests,
  humanCryptoDeviceGroupWelcomes,
  humanCryptoDeviceKeyPackages,
  humanCryptoDevices,
  humanCryptoRecoveryKeys,
  and,
  inArray,
  listProtectedTaskCancellationOutputCandidates,
  llmUsageEvents,
  or,
  jobs,
  memories,
  memoryCryptoRevisions,
  memoryNamespaces,
  memoryScopes,
  namespaceDomainKeyBindings,
  namespaceDomainKeyHeads,
  namespaces,
  objectCryptoAccessHeads,
  objectCryptoAccessManifests,
  objectCryptoNamespaceEnvelopes,
  PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY,
  PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY,
  protectedTaskContinuationReceipts,
  protectedTaskExecutionSegmentReceipts,
  protectedTaskRunOutputBindings,
  protectedTaskRunWakeJobId,
  protectedTaskRunWakeOperationId,
  protectedTaskSemanticAuthorityRequirementsDigest,
  resolveAppDatabaseConnectionString,
  roomMembers,
  rooms,
  sessionMessageCryptoRevisions,
  sessionMessages,
  sessions,
  serverAdmission,
  sql,
  taskDefinitionCryptoRevisions,
  taskCancellationCryptoStagingReceipts,
  taskRunMessageAssociations,
  taskRunResultCryptoRevisions,
  taskRuns,
  taskTerminalMessageCryptoStagingReceipts,
  tasks,
  transitionTaskLifecycleTerminal,
  users,
  type PostgresJsBridgeConnection,
  type PostgresJsBridgeExecutor,
  type PostgresJsBridgeRow,
  type PostgresJsBridgeScalar,
  type DirectDatabase,
} from "@nautilo/db";
import {
  persistJobWithDatabase,
  startProtectedTaskJobWithDatabase,
  settleProtectedTaskJobTerminalWithDatabase,
  updateJobStatusWithDatabase,
} from "../../../db/src/queries/jobs.ts";
import { withCurrentTaskContentBackfillDevice } from "../../src/routes/task-content-backfill-authority";
import { readTaskContentBackfillSource } from "../../src/routes/task-content-backfill-source";
import { createHumanProductTransactionContext } from "../../src/routes/human-message-product-store";
import { createProtectedTaskDefinitionForegroundAuthorizationResolver } from
  "../../src/routes/protected-task-runtime-access-lineage";
import { createTaskContentBackfillPublication } from "../../src/routes/task-content-backfill-publication";
import { createTaskContentBackfillScanService } from "../../src/routes/task-content-backfill-scan";
import { readHistoricalTaskDefinitionSummaryProofs } from "../../src/routes/task-historical-definition-summary";
import { toTaskContentSummaryV1 } from "../../src/routes/tasks";
import { createProtectedTaskNativeResultPublication } from
  "../../src/routes/protected-task-native-result-publication";
import {
  DeviceProviderStateVault,
  HumanDeviceOpenMlsGroup,
  LatticeCrypto,
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  createDomainForegroundAuthorizationPlan,
  cryptoDeviceId,
  cryptoDomainId,
  decryptObjectThroughNamespace,
  domainEpoch,
  domainNamespaceGenerationHeadDigest,
  domainNamespaceRetainedAuthoritySetDigest,
  encodeHumanDeviceGroupHead,
  encryptedObjectWriteRecord,
  encryptObjectPayload,
  generateDomainKey,
  humanId,
  mintDomainForegroundAuthorization,
  namespaceGeneration,
  namespaceId,
  objectId,
  persistAgentRuntimeInitialization,
  prepareAgentRuntimeInitialization,
  prepareDomainKeyHead,
  prepareDomainKeyRecipientAuthorization,
  prepareDomainKeyRecipientEnvelope,
  prepareDomainNamespaceBundle,
  prepareHumanExistingTaskRepresentationPublicationRequest,
  prepareHumanObjectAccessManifestGenesisSet,
  prepareHumanTaskPublicationRequest,
  TaskRuntimeRecipientRegistry,
  unixTimestamp,
  wrapObjectDekForNamespace,
  type DomainForegroundSecretEntry,
  type TaskRuntimeExecutionEvidence,
} from "@nautilo/lattice-crypto";
import {
  createTaskRuntimeSignerAuthorization,
  decodeTaskRuntimeBackgroundAuthorizationRequestBase,
  decodeTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
  createTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationResponseV2,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
  isTaskRuntimeBackgroundAuthorizationRequestV2Carrier,
  isTaskRuntimeBackgroundAuthorizationRequestV3Carrier,
} from "@nautilo/lattice-crypto/background";
import {
  destroyDomainForegroundAuthorizationV2,
  destroyDomainForegroundAuthorizationPlanV2,
  destroyDomainKeyHeadV2,
  destroyDomainKeyRecipientAuthorizationV2,
  destroyDomainKeyRecipientEnvelopeV2,
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
  parseDomainForegroundAuthorizationPlanV2,
  serializeDomainForegroundAuthorizationV2,
  verifyDomainForegroundAuthorizationV2,
} from "@nautilo/lattice-crypto/wire";
import {
  authenticatePreparedHistoricalTaskContentCryptoRevisionV1,
  bindEncryptionDataOperationOwner,
  createDormantTaskContentShadowRepository,
  createPreparedHumanTaskContentCryptoRevisionV1,
  deriveMemoryCryptoObjectIdV1,
  deriveLiveShadowMessageCryptoObjectIdV1,
  deriveTaskContentCryptoObjectIdV1,
  deriveTaskHistoricalContentCryptoObjectIdV1,
  digestHumanTaskOrdinaryFallbackRequestV1,
  encodeTaskDefinitionContent,
  encodeMemoryPayloadV1,
  encodeTaskPayloadV1,
  decodeTaskDefinitionContent,
  fingerprintHumanTaskOrdinaryFallbackContentV1,
  fingerprintHumanTaskOrdinaryFallbackPlanV1,
  fingerprintTaskDualPublicationFieldsV1,
  fingerprintTaskOperationalFieldsV1,
  fingerprintRequiredMemoryNamespaces,
  MEMORY_OBJECT_TYPE,
  prepareHumanTaskOrdinaryFallbackRequestV1,
  prepareTaskRuntimeAgentObject,
  TASK_CONTENT_RECONCILE_MAX_ATTEMPTS,
  taskContentObjectTypeV1,
  type ForegroundMemoryRepairSelection,
  type ProtectedAgentMemoryRepository,
  type ProtectedAgentMemoryProjectionPort,
  type ProtectedMemoryAuthority,
  type TaskRuntimeAgentObjectNamespaceMaterial,
} from "@nautilo/lattice-bridge";
import {
  PostgresDeviceAdmissionRepository,
  PostgresDomainKeyAuthorityRepository,
  PostgresHumanDeviceGroupRepository,
  PostgresHumanDeviceSignerHistory,
  PostgresLatticeStorage,
  PostgresTaskContentProductStore,
  bindDurableTaskContentRepositoryV1,
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  createPostgresTaskContentCryptoCompletion,
  createPostgresTaskContentRepositoryV1,
  PostgresNamespaceProductAuthority,
  inspectInitialTaskRuntimeNamespaceAuthority,
  inspectTaskContentNamespaceAuthority,
  stageHistoricalTaskContentPublication,
  verifyCryptoPostgresHandle,
  withTaskContentNamespaceAuthority,
  withNativeProtectedTaskDefinitionV1,
  withNativeProtectedTaskRunResultMessageSourceV1,
  type ConversationProductCanonicalTransactionRunner,
  type ConversationProductPostgresHandle,
  type CryptoPostgresHandle,
  type TaskScopeMemoryBinding,
} from "@nautilo/lattice-bridge/server";
import type {
  BackgroundAuthorizationTaskRuntimeRecordV3,
  JobExecutor,
  ProtectedTaskJobReferenceV1,
  ProtectedTaskRunningOccurrence,
} from "@nautilo/runtime";
import {
  InMemoryLaneLock,
  JobManager,
  TaskObserver,
  TASK_RUNTIME_AUTHORIZATION_ABSOLUTE_LIMIT_MS,
  createTaskRuntimeDomainMemoryCryptoSession,
  getCurrentLiveShadowTurnContext, getCurrentAcceptedInvocationAuthority, eventBus,
  pauseTask,
  unpauseTask,
  withNativeProtectedTaskCheckpointManifest,
} from "@nautilo/runtime";
import {
  ACP_RELAY_PROTOCOL_VERSION,
  CODEX_RELAY_PROTOCOL_VERSION,
  OPENCODE_ACP_RELAY_PROTOCOL_VERSION,
  type AcpExecutionScope,
  type AcpProcessScope,
  type RelayAcpSemanticEvent,
  type RelayAcpTerminalEvent,
} from "@nautilo/relay";
import {
  PersonalPolicyResolver,
  findActorByOwnerId, assertAcceptedInvocationAuthoritySubject, getAcceptedInvocationAuthorityOrigin,
} from "@nautilo/trust";
import { createProtectedTaskNativeTranscriptPublisher } from "../../src/routes/protected-task-native-transcript-composition";
import { createProtectedTaskDeepResearchExecution } from "../../src/routes/protected-task-deep-research-execution";
import { createProtectedTaskHermesExecution } from
  "../../src/routes/protected-task-hermes-execution";
import { createProtectedTaskOpenCodeExecution } from
  "../../src/routes/protected-task-opencode-execution";
import { createProtectedTaskCodexExecution } from
  "../../src/routes/protected-task-codex-execution";
import { CodexExecutionAdmissionFactory } from
  "../../src/codex/admission-factory";
import { createCodexTaskBindingLookup } from
  "../../src/codex/binding-session";
import { createCodexCanonicalFactsReader } from
  "../../src/codex/canonical-facts";
import { assertCodexExecutionAdmission } from
  "../../src/codex/execution-admission";
import { CodexHarnessPreferenceStore } from
  "../../src/codex/harness-admission";
import { CodexPersistenceAdapter } from
  "../../src/codex/persistence";
import { createProductionProtectedTaskNativeExecutionContext } from "../../src/routes/protected-task-native-execution-context";
import {
  classifyProtectedTaskMetadataV1,
  parseProtectedTaskOperationalMetadataProjectionV1,
} from "@nautilo/types";
import type { LocalExecutionDelegation } from "@nautilo/types";
import {
  withTaskRuntimeExecutionEvidenceV1,
  type TaskRuntimeExecutionEvidenceInputV1,
} from "../../../lattice-crypto/src/background/task-runtime-execution-evidence-v1.ts";
import {
  attachBackgroundAuthorizationRecipient,
  claimBackgroundAuthorizationRequest,
  createBackgroundAuthorizationTaskRuntimeRequestV3,
  markBackgroundAuthorizationRunning,
} from "../../../runtime/src/protected-execution/background-authorization/lifecycle.ts";
import { PostgresBackgroundAuthorizationRepository } from "../../../runtime/src/protected-execution/background-authorization/postgres-repository.ts";
import {
  taskRuntimeStableIdempotencyKey,
} from "../../../runtime/src/protected-execution/background-authorization/task-runtime-grant-claim.ts";
import {
  createForegroundProductTransactionContext,
} from "../../src/routes/foreground-message-product-store.ts";
import {
  withProtectedTaskNativeMemoryRepository,
} from "../../src/routes/protected-task-native-memory-repository.ts";
import {
  adoptProtectedTaskScopeMemoryOrigin,
  assertHeldProtectedTaskContentAccessNamespace,
  attachProtectedTaskScopeMemoryRepair,
  requireHeldProtectedTaskMemoryWriterAuthority,
  reserveProtectedTaskScopeMemoryRepair,
  findProtectedTaskContentAccessNamespace,
  resolveProtectedTaskContentAccessNamespace,
  withCurrentProtectedTaskMemoryAuthority,
  type HeldProtectedTaskMemoryAuthority,
} from "../../src/routes/current-protected-task-memory-authority.ts";
import {
  persistProtectedTaskMemoryObject,
  persistProtectedTaskMemoryObjectUnderHeld,
  type ProtectedTaskMemoryObjectWrite,
  type ProtectedTaskMemoryObjectWriterInput,
} from "../../src/routes/protected-task-memory-object-writer.ts";
import {
  createProductionBackgroundAuthorizationComposition,
} from "../../src/routes/background-authorization-composition.ts";
import {
  createProtectedTaskNativeFixedMemorySegment,
} from "../../src/routes/protected-task-native-fixed-memory-segment.ts";
import {
  createProductionProtectedTaskNativeExecution,
} from "../../src/routes/protected-task-native-execution-composition.ts";
import {
  createProductionProtectedTaskRuntimeInitialComposition,
  loadInitialProtectedTaskOccurrence,
} from "../../src/routes/protected-task-runtime-initial-composition.ts";
import { createTaskOccurrencePolicyPorts } from
  "../../src/routes/task-occurrence-policy.ts";
import {
  createProtectedTaskRequesterPrivateRoomResolver,
} from "../../src/routes/protected-task-requester-private-room.ts";
import { createProtectedTaskCancellationAuthorityPort } from
  "../../src/routes/protected-task-cancellation-authority.ts";
import { createProtectedTaskCancellationClaim } from
  "../../src/routes/protected-task-cancellation-claim.ts";
import { createProtectedTaskCancellationPreparation } from
  "../../src/routes/protected-task-cancellation-preparation.ts";
import { createProtectedTaskCancellationPublication } from
  "../../src/routes/protected-task-cancellation-publication.ts";
import { createProtectedTaskCancellationPublicationRecovery } from
  "../../src/routes/protected-task-cancellation-publication-recovery.ts";
import { createProtectedTaskCancellationSettlement } from
  "../../src/routes/protected-task-cancellation-settlement.ts";
import { createProtectedTaskTerminalMessageComposition } from
  "../../src/routes/protected-task-terminal-message-composition.ts";
import { createProtectedTaskOutputReadComposition } from
  "../../src/routes/protected-task-output-read-composition.ts";
import { createProtectedTaskOutputReadClaim } from
  "../../src/routes/protected-task-output-read-claim.ts";
import { createProtectedTaskRunResultMessagePublication } from
  "../../src/routes/protected-task-run-result-message-publication.ts";
import { createProtectedTaskRunResultMessageRecovery } from
  "../../src/routes/protected-task-run-result-message-recovery.ts";
import { acceptedTaskRuntimeRecord, destroyAcceptedTaskRuntimeRecord } from
  "../../src/routes/task-runtime-current-authority.ts";
import { createProtectedTaskTerminalMessageAuthorityPort } from
  "../../src/routes/protected-task-terminal-message-authority.ts";
import { createProtectedTaskTerminalMessageClaim } from
  "../../src/routes/protected-task-terminal-message-claim.ts";
import { createProtectedTaskTerminalMessagePreparation } from
  "../../src/routes/protected-task-terminal-message-preparation.ts";
import { createProtectedTaskTerminalMessagePublication } from
  "../../src/routes/protected-task-terminal-message-publication.ts";
import {
  createProductionProtectedTaskComposition,
  type ProtectedTaskRouteAuthority,
} from "../../src/routes/task-protected-composition.ts";
import {
  createTaskOrdinaryFallbackPorts,
} from "../../src/routes/task-ordinary-fallback-composition.ts";

const ENABLE_ENV = "NAUTILO_PROTECTED_TASK_MEMORY_WRITER_INTEGRATION";
// The caller must first verify ownership of the disposable clone, then bind
// both its instance identity and PostgreSQL endpoint explicitly for this run.
const EXPECTED_INSTANCE_ENV = "NAUTILO_PROTECTED_TASK_QA_INSTANCE";
const EXPECTED_POSTGRES_PORT_ENV = "NAUTILO_PROTECTED_TASK_QA_POSTGRES_PORT";
const FIXED_NOW = Date.parse("2042-07-08T09:00:00.000Z");
let NOW = FIXED_NOW;
let EXPIRES_AT = FIXED_NOW + 60_000;
const SERVER_SCOPE = "https://task-memory.integration.test";
const CALLER_LOCAL_MODEL_ID = "openrouter:moonshotai/kimi-k3";

class CrashAfterTaskResultCryptoStore extends PostgresTaskContentProductStore {
  override async compareAndSwapCryptoMapping(
    _input: Parameters<
      PostgresTaskContentProductStore["compareAndSwapCryptoMapping"]
    >[0],
  ): ReturnType<PostgresTaskContentProductStore["compareAndSwapCryptoMapping"]> {
    throw new Error("synthetic loss after result crypto storage");
  }
}

function createCrashAfterTaskResultCryptoRepository<ProductResult>(
  input: Parameters<
    typeof createPostgresTaskContentRepositoryV1<ProductResult>
  >[0],
): ReturnType<typeof createPostgresTaskContentRepositoryV1<ProductResult>> {
  return bindDurableTaskContentRepositoryV1({
    protectedRepository: createDormantTaskContentShadowRepository({
      product: new CrashAfterTaskResultCryptoStore(
        input.product.handle,
        input.product.resolveCurrentAuthority,
      ),
      crypto: createPostgresTaskContentCryptoCompletion(input.crypto),
    }),
    content: input.content,
  });
}

function createMissingTaskResultCiphertextRepository<ProductResult>(
  input: Parameters<
    typeof createPostgresTaskContentRepositoryV1<ProductResult>
  >[0],
): ReturnType<typeof createPostgresTaskContentRepositoryV1<ProductResult>> {
  const crypto = createPostgresTaskContentCryptoCompletion(input.crypto);
  return bindDurableTaskContentRepositoryV1({
    protectedRepository: createDormantTaskContentShadowRepository({
      product: new PostgresTaskContentProductStore(
        input.product.handle,
        input.product.resolveCurrentAuthority,
      ),
      crypto: {
        complete: () => Promise.reject(
          new Error("synthetic loss before result crypto storage"),
        ),
        verify: reference => crypto.verify(reference),
      },
    }),
    content: input.content,
  });
}

function assertExactTarget(): void {
  if (process.env[ENABLE_ENV] !== "1") return;
  const expectedInstanceId = process.env[EXPECTED_INSTANCE_ENV];
  const expectedPostgresPort = process.env[EXPECTED_POSTGRES_PORT_ENV];
  if (
    !expectedInstanceId
    || !/^qa-[a-z0-9-]+$/.test(expectedInstanceId)
    || process.env["NAUTILO_INSTANCE_ID"] !== expectedInstanceId
    || !expectedPostgresPort
  ) {
    throw new Error(
      `${ENABLE_ENV}=1 requires an explicitly bound disposable QA instance and PostgreSQL port`,
    );
  }
  assertFixtureDbMutationAllowed();
  const product = new URL(resolveAppDatabaseConnectionString());
  const cryptoRaw = process.env["DB_CRYPTO_CONNECTION_STRING"];
  if (!cryptoRaw) throw new Error("DB_CRYPTO_CONNECTION_STRING is required");
  const crypto = new URL(cryptoRaw);
  for (const [url, user] of [[product, "nautilo"], [crypto, "nautilo_crypto"]] as const) {
    if (
      !["postgres:", "postgresql:"].includes(url.protocol)
      || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
      || url.port !== expectedPostgresPort
      || url.username !== user
      || url.password.length === 0
      || url.pathname !== "/nautilo"
    ) {
      throw new Error(
        "Protected Task Memory writer integration requires the exact local QA product and crypto roles",
      );
    }
  }
}

assertExactTarget();
const describePostgres = process.env[ENABLE_ENV] === "1"
  ? describe.serial
  : describe.skip;

beforeEach(() => {
  NOW = FIXED_NOW;
  EXPIRES_AT = FIXED_NOW + 60_000;
});

function digest(label: string): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(label).digest());
}

function hexDigest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

type Deferred = Readonly<{
  promise: Promise<void>;
  resolve(): void;
}>;

function deferred(): Deferred {
  let resolve!: () => void;
  return Object.freeze({
    promise: new Promise<void>((complete) => {
      resolve = complete;
    }),
    resolve,
  });
}

function gatedRestrictedConnection(base: PostgresJsBridgeConnection): Readonly<{
  connection: PostgresJsBridgeConnection;
  entered: Promise<void>;
  release(): void;
}> {
  const entered = deferred();
  const release = deferred();
  let admitted = false;
  const transactionOnce: PostgresJsBridgeConnection["transactionOnce"] =
    async (use, options) => {
      if (!admitted) {
        admitted = true;
        entered.resolve();
        await release.promise;
      }
      return base.transactionOnce(use, options);
    };
  return Object.freeze({
    entered: entered.promise,
    release: release.resolve,
    connection: Object.freeze({
      query: base.query.bind(base),
      transaction: base.transaction.bind(base),
      transactionOnce,
    }),
  });
}

function observeRestrictedConnection(
  base: PostgresJsBridgeConnection,
  afterQuery: (
    statement: string,
    parameters: readonly PostgresJsBridgeScalar[] | undefined,
  ) => void,
): PostgresJsBridgeConnection {
  const wrap = (
    executor: Pick<PostgresJsBridgeConnection, "query">,
  ): PostgresJsBridgeConnection => ({
    query: async <Row extends PostgresJsBridgeRow = PostgresJsBridgeRow>(
      statement: string,
      parameters?: readonly PostgresJsBridgeScalar[],
    ): Promise<readonly Row[]> => {
      const rows = await executor.query<Row>(statement, parameters);
      afterQuery(statement, parameters);
      return rows;
    },
    transaction: (use) => use(wrap(executor)),
    transactionOnce: (use) => use(wrap(executor)),
  });
  return {
    query: wrap(base).query,
    transaction: (use, options) => base.transaction(
      (executor) => use(wrap(executor)),
      options,
    ),
    transactionOnce: (use, options) => base.transactionOnce(
      (executor) => use(wrap(executor)),
      options,
    ),
  };
}

function observeCanonicalRunner(
  base: ConversationProductCanonicalTransactionRunner,
  wrapExecutor: (
    executor: PostgresJsBridgeExecutor,
  ) => PostgresJsBridgeExecutor = executor => executor,
): Readonly<{
  runner: ConversationProductCanonicalTransactionRunner;
  pid: Promise<number>;
  transactionCalls(): number;
}> {
  const backend = Promise.withResolvers<number>();
  let transactionCalls = 0;
  return Object.freeze({
    pid: backend.promise,
    transactionCalls: () => transactionCalls,
    runner: Object.freeze({
      ...base,
      transaction: <Result>(
        callback: Parameters<
          ConversationProductCanonicalTransactionRunner["transaction"]
        >[0],
        options: Parameters<
          ConversationProductCanonicalTransactionRunner["transaction"]
        >[1],
      ): Promise<Result> => {
        transactionCalls += 1;
        return base.transaction(async (tx, executor) => {
        try {
          const rows = await executor.query<{ pid: number }>(
            "SELECT pg_backend_pid()::integer AS pid",
          );
          const pid = rows[0]?.pid;
          if (typeof pid !== "number" || !Number.isSafeInteger(pid)) {
            throw new Error("Task Memory writer has no product backend PID");
          }
          backend.resolve(pid);
          return await callback(tx, wrapExecutor(executor)) as Result;
        } catch (error) {
          backend.reject(error);
          throw error;
        }
        }, options);
      },
    }),
  });
}

function gateCanonicalRunnerAfterScopeOriginUpdate(
  base: ConversationProductCanonicalTransactionRunner,
): Readonly<{
  runner: ConversationProductCanonicalTransactionRunner;
  entered: Promise<void>;
  pid: Promise<number>;
  release(): void;
}> {
  const entered = deferred();
  const release = deferred();
  let gated = false;
  const observed = observeCanonicalRunner(base, executor => ({
    query: async <Row extends PostgresJsBridgeRow = PostgresJsBridgeRow>(
      statement: string,
      parameters?: readonly PostgresJsBridgeScalar[],
    ): Promise<readonly Row[]> => {
      const result = await executor.query<Row>(statement, parameters);
      if (!gated && /^\s*update\s+"memories"\s+set/iu.test(statement)
        && statement.includes("scope_origin_namespace_id")) {
        gated = true;
        entered.resolve();
        await release.promise;
      }
      return result;
    },
  }));
  return Object.freeze({
    entered: entered.promise,
    pid: observed.pid,
    release: release.resolve,
    runner: observed.runner,
  });
}

function gateProtectedTaskCancellationAuthority(
  targetCall: 1 | 2,
): Readonly<{
  withAuthority: typeof withTaskContentNamespaceAuthority;
  entered: Promise<void>;
  pid: Promise<number>;
  release(): void;
}> {
  const entered = deferred();
  const release = deferred();
  const backend = Promise.withResolvers<number>();
  let calls = 0;
  const withAuthority: typeof withTaskContentNamespaceAuthority = async operation => {
    const call = ++calls;
    const observed = observeCanonicalRunner(operation.runner);
    if (call === targetCall) {
      observed.pid.then(backend.resolve, backend.reject);
    }
    return withTaskContentNamespaceAuthority({
      ...operation,
      runner: observed.runner,
      use: async (authority, product, transaction, restricted) => {
        if (call === targetCall) {
          entered.resolve();
          await release.promise;
        }
        return operation.use(authority, product, transaction, restricted);
      },
    });
  };
  return Object.freeze({
    entered: entered.promise,
    pid: backend.promise,
    release: release.resolve,
    withAuthority,
  });
}

function failProtectedTaskCancellationAuthorityAfterCallback(
  targetCall: 2,
): typeof withTaskContentNamespaceAuthority {
  let calls = 0;
  return async operation => {
    const call = ++calls;
    if (call !== targetCall) return withTaskContentNamespaceAuthority(operation);
    const runner: ConversationProductCanonicalTransactionRunner = Object.freeze({
      ...operation.runner,
      transaction: <Result>(
        callback: Parameters<
          ConversationProductCanonicalTransactionRunner["transaction"]
        >[0],
        options: Parameters<
          ConversationProductCanonicalTransactionRunner["transaction"]
        >[1],
      ): Promise<Result> => operation.runner.transaction(
        async (transaction, executor): Promise<Result> => {
          await callback(transaction, executor);
          throw new Error("synthetic loss before cancellation product commit");
        },
        options,
      ),
    });
    return withTaskContentNamespaceAuthority({ ...operation, runner });
  };
}

function canonicalProductConnection(
  runner: ConversationProductCanonicalTransactionRunner,
): PostgresJsBridgeConnection {
  const transaction: PostgresJsBridgeConnection["transaction"] =
    (use, options) => runner.transaction(
      (_tx, executor) => use(executor),
      options ?? { isolationLevel: "read committed" },
    );
  const query: PostgresJsBridgeConnection["query"] =
    <Row extends PostgresJsBridgeRow = PostgresJsBridgeRow>(
      statement: string,
      parameters?: readonly PostgresJsBridgeScalar[],
    ): Promise<readonly Row[]> => transaction(
      (executor) => executor.query<Row>(statement, parameters),
    );
  return Object.freeze({
    query,
    transaction,
    transactionOnce: transaction,
  });
}

type BaseFixture = Awaited<ReturnType<typeof createBaseFixture>>;

async function waitForBlockedContender(
  base: BaseFixture,
  blockerPid: number,
  failure = "Task cancellation did not reach the writer's product lock",
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [activity] = await base.admin.execute<{ blocked: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
          FROM pg_stat_activity
         WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))
           AND state = 'active'
           AND wait_event_type = 'Lock'
      ) AS blocked
    `);
    if (activity?.blocked === true) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(failure);
}

async function createBaseFixture(
  options: Readonly<{ connectedExecution?: boolean; cryptoNow?: () => number }> = {},
) {
  const admin = createDirectDb(5);
  const productDb = getSharedDirectDb();
  const cryptoDb = getSharedDirectCryptoDb();
  const restricted = createPostgresJsBridgeConnection(cryptoDb);
  const cryptoHandle = await verifyCryptoPostgresHandle(restricted);
  const crypto = new LatticeCrypto(undefined, { now: options.cryptoNow ?? (() => NOW) });
  const userId = randomUUID();
  const humanActorId = randomUUID();
  const agentActorId = randomUUID();
  const productAgentId = randomUUID();
  const namespaceValue = randomUUID();
  const seedNamespaceValue = randomUUID();
  const roomId = randomUUID();
  const seedRoomId = randomUUID();
  const deviceId = `task-memory-device-${randomUUID()}`;
  const signing = crypto.generateSigningKeyPair();
  const encryption = await crypto.generateEncryptionKeyPair();
  const recovery = await crypto.generateEncryptionKeyPair();
  const managerVault = DeviceProviderStateVault.fromKey(
    crypto,
    cryptoDeviceId(deviceId),
    crypto.randomBytes(32),
  );
  let namespaceKey: Uint8Array | null = null;
  let seedNamespaceKey: Uint8Array | null = null;
  let domainKey: Uint8Array | null = null;
  let domainIdValue: string | null = null;
  let runtime: Awaited<ReturnType<typeof prepareAgentRuntimeInitialization>> | null = null;
  const objectIds = new Set<string>();
  const memoryIds = new Set<string>();
  const requestIds = new Set<string>();
  const taskIds = new Set<string>();
  const jobIds = new Set<string>();
  const scopeIds = new Set<string>();
  const fixtureRoomIds = new Set([roomId, seedRoomId]);
  const fixtureNamespaceIds = new Set([namespaceValue, seedNamespaceValue]);
  const additionalNamespaceKeys = new Set<Uint8Array>();
  const sessionThreadIds = new Set<string>();

  const [originalPolicy] = await admin.select().from(encryptionTransitionPolicy)
    .where(eq(encryptionTransitionPolicy.id, "server"));
  if (originalPolicy === undefined) throw new Error("Missing encryption policy");
  const policyRevision = originalPolicy.revision + 1;

  const cleanup = async (): Promise<void> => {
    const attachedObjects = await admin.select({
      objectId: objectCryptoNamespaceEnvelopes.objectId,
    }).from(objectCryptoNamespaceEnvelopes).where(eq(
      objectCryptoNamespaceEnvelopes.namespaceId,
      namespaceValue,
    ));
    const writtenObjectIds = [...new Set([
      ...objectIds,
      ...attachedObjects.map(row => row.objectId),
    ])];
    const attachedMemories = await admin.select({
      memoryId: memoryNamespaces.memoryId,
    }).from(memoryNamespaces).where(eq(
      memoryNamespaces.namespaceId,
      namespaceValue,
    ));
    const writtenMemoryIds = [...new Set([
      ...memoryIds,
      ...attachedMemories.map(row => row.memoryId),
    ])];
    const createdTaskIds = [...taskIds];
    if (createdTaskIds.length > 0) {
      const createdScopes = await admin.select({ scopeId: tasks.scopeId }).from(tasks)
        .where(inArray(tasks.id, createdTaskIds));
      for (const row of createdScopes) if (row.scopeId !== null) scopeIds.add(row.scopeId);
    }
    const taskJobRows = createdTaskIds.length === 0 ? [] : await admin.select({
      jobId: taskRuns.jobId,
    }).from(taskRuns).where(inArray(taskRuns.taskId, createdTaskIds));
    const createdJobIds = [...new Set([
      ...jobIds,
      ...taskJobRows.flatMap(row => row.jobId === null ? [] : [row.jobId]),
    ])];
    const createdRequestIds = [...requestIds];
    try {
      const createdSessions = await admin.select({ id: sessions.id })
        .from(sessions).where(or(
          sessionThreadIds.size === 0 ? undefined : inArray(sessions.threadId, [...sessionThreadIds]),
          inArray(sessions.roomId, [...fixtureRoomIds]),
        ));
      const createdSessionIds = createdSessions.map(row => row.id);
      if (createdSessionIds.length > 0) {
        await admin.delete(sessionMessages).where(inArray(
          sessionMessages.sessionId,
          createdSessionIds,
        ));
        await admin.delete(sessions).where(inArray(
          sessions.id,
          createdSessionIds,
        ));
      }
      if (createdRequestIds.length > 0 || writtenObjectIds.length > 0) {
        await admin.delete(taskCancellationCryptoStagingReceipts).where(or(
          createdRequestIds.length === 0 ? undefined : inArray(
            taskCancellationCryptoStagingReceipts.requestId,
            createdRequestIds,
          ),
          writtenObjectIds.length === 0 ? undefined : inArray(
            taskCancellationCryptoStagingReceipts.cryptoObjectId,
            writtenObjectIds,
          ),
        ));
      }
      if (writtenObjectIds.length > 0) {
        await admin.delete(objectCryptoAccessHeads).where(
          inArray(objectCryptoAccessHeads.objectId, writtenObjectIds),
        );
        await admin.delete(objectCryptoNamespaceEnvelopes).where(
          inArray(objectCryptoNamespaceEnvelopes.objectId, writtenObjectIds),
        );
        await admin.delete(objectCryptoAccessManifests).where(
          inArray(objectCryptoAccessManifests.objectId, writtenObjectIds),
        );
      }
      await admin.delete(agentCryptoRuntimeChallenges).where(
        eq(agentCryptoRuntimeChallenges.agentId, productAgentId),
      );
      await admin.delete(agentCryptoRuntimeDomainEnvelopes).where(
        eq(agentCryptoRuntimeDomainEnvelopes.agentId, productAgentId),
      );
      await admin.delete(agentCryptoRuntimeConfigObjects).where(
        eq(agentCryptoRuntimeConfigObjects.agentId, productAgentId),
      );
      await admin.delete(agentCryptoRuntimeSigners).where(
        eq(agentCryptoRuntimeSigners.agentId, productAgentId),
      );
      await admin.delete(agentCryptoRuntimeStates).where(
        eq(agentCryptoRuntimeStates.agentId, productAgentId),
      );
      if (createdRequestIds.length > 0) {
        await admin.delete(backgroundCryptoAuthorizationNamespaceRequirements)
          .where(inArray(
            backgroundCryptoAuthorizationNamespaceRequirements.requestId,
            createdRequestIds,
          ));
        await admin.delete(backgroundCryptoAuthorizationDomainRequirements)
          .where(inArray(
            backgroundCryptoAuthorizationDomainRequirements.requestId,
            createdRequestIds,
          ));
        await admin.delete(backgroundCryptoAuthorizationRequests).where(
          inArray(backgroundCryptoAuthorizationRequests.requestId, createdRequestIds),
        );
      }
      await admin.delete(namespaceDomainKeyHeads).where(inArray(
        namespaceDomainKeyHeads.namespaceId,
        [...fixtureNamespaceIds],
      ));
      await admin.delete(namespaceDomainKeyBindings).where(inArray(
        namespaceDomainKeyBindings.namespaceId,
        [...fixtureNamespaceIds],
      ));
      await admin.delete(domainKeyEnvelopeAcknowledgements).where(
        eq(domainKeyEnvelopeAcknowledgements.recipientDeviceId, deviceId),
      );
      await admin.delete(domainKeyRecipientEnvelopes).where(
        eq(domainKeyRecipientEnvelopes.recipientHumanId, humanActorId),
      );
      await admin.delete(domainKeyRecipientRequests).where(
        eq(domainKeyRecipientRequests.recipientHumanId, humanActorId),
      );
      await admin.delete(domainKeyHeads).where(
        eq(domainKeyHeads.issuerHumanId, humanActorId),
      );
      await admin.delete(domainKeyPublicationOperations).where(
        eq(domainKeyPublicationOperations.issuerHumanId, humanActorId),
      );
      if (domainIdValue !== null) {
        await admin.delete(cryptoDomains).where(eq(cryptoDomains.id, domainIdValue));
      }
      await admin.delete(humanCryptoDeviceGroupAcknowledgements).where(
        eq(humanCryptoDeviceGroupAcknowledgements.humanId, humanActorId),
      );
      await admin.delete(humanCryptoDeviceGroupWelcomes).where(
        eq(humanCryptoDeviceGroupWelcomes.humanId, humanActorId),
      );
      await admin.delete(humanCryptoDeviceGroupCommits).where(
        eq(humanCryptoDeviceGroupCommits.humanId, humanActorId),
      );
      await admin.delete(humanCryptoDeviceGroupJoinRequests).where(
        eq(humanCryptoDeviceGroupJoinRequests.humanId, humanActorId),
      );
      await admin.delete(humanCryptoDeviceGroupHeads).where(
        eq(humanCryptoDeviceGroupHeads.humanId, humanActorId),
      );
      await admin.delete(humanCryptoDeviceKeyPackages).where(
        eq(humanCryptoDeviceKeyPackages.deviceId, deviceId),
      );
      await admin.delete(humanCryptoRecoveryKeys).where(
        eq(humanCryptoRecoveryKeys.humanId, humanActorId),
      );
      await admin.delete(humanCryptoDevices).where(
        eq(humanCryptoDevices.humanId, humanActorId),
      );
      await admin.delete(humanCryptoCustodies).where(
        eq(humanCryptoCustodies.humanId, humanActorId),
      );
      if (createdTaskIds.length > 0) {
        await admin.delete(tasks).where(inArray(tasks.id, createdTaskIds));
        await admin.delete(taskRunResultCryptoRevisions).where(inArray(
          taskRunResultCryptoRevisions.taskId,
          createdTaskIds,
        ));
        await admin.delete(taskDefinitionCryptoRevisions).where(
          inArray(taskDefinitionCryptoRevisions.taskId, createdTaskIds),
        );
      }
      if (createdJobIds.length > 0) {
        await admin.delete(jobs).where(inArray(jobs.id, createdJobIds));
      }
      if (writtenMemoryIds.length > 0) {
        await admin.delete(memoryScopes).where(
          inArray(memoryScopes.memoryId, writtenMemoryIds),
        );
        await admin.delete(memories).where(
          inArray(memories.id, writtenMemoryIds),
        );
      }
      if (scopeIds.size > 0) {
        await admin.delete(agentScopes).where(inArray(
          agentScopes.id,
          [...scopeIds],
        ));
      }
      if (writtenObjectIds.length > 0) {
        // The FK cascade executes as the parent table owner, whose SELECT/DELETE
        // privileges on the append-only staging table is deliberately revoked.
        // Keep this operator-only cleanup grant invisible outside this
        // transaction and restore it before committing exact fixture deletion.
        await admin.transaction(async tx => {
          await tx.select({ objectId: cryptoObjects.objectId }).from(cryptoObjects)
            .where(inArray(cryptoObjects.objectId, writtenObjectIds)).for("update");
          const children = await tx.select({ requestId: taskCancellationCryptoStagingReceipts.requestId })
            .from(taskCancellationCryptoStagingReceipts)
            .where(inArray(taskCancellationCryptoStagingReceipts.cryptoObjectId, writtenObjectIds)).limit(1);
          if (children.length !== 0) throw new Error("Fixture staging cleanup is incomplete");
          const [original] = await tx.execute<{ parent_owner: string; allowed: boolean; can_select: boolean }>(sql`
            select pg_get_userbyid(relowner) as parent_owner,
              has_table_privilege('nautilo', 'public.task_cancellation_crypto_staging_receipts', 'DELETE') as allowed,
              has_table_privilege('nautilo', 'public.task_cancellation_crypto_staging_receipts', 'SELECT') as can_select
            from pg_class where oid = 'public.crypto_objects'::regclass
          `);
          if (original?.parent_owner !== "nautilo") throw new Error("Fixture crypto owner is unexpected");
          if (!original.allowed) {
            await tx.execute(sql`grant delete on public.task_cancellation_crypto_staging_receipts to nautilo`);
          }
          if (!original.can_select) {
            await tx.execute(sql`grant select on public.task_cancellation_crypto_staging_receipts to nautilo`);
          }
          await tx.delete(cryptoObjects).where(inArray(cryptoObjects.objectId, writtenObjectIds));
          if (!original.allowed) {
            await tx.execute(sql`revoke delete on public.task_cancellation_crypto_staging_receipts from nautilo`);
          }
          if (!original.can_select) {
            await tx.execute(sql`revoke select on public.task_cancellation_crypto_staging_receipts from nautilo`);
          }
          const [restored] = await tx.execute<{ allowed: boolean; can_select: boolean }>(sql`
            select has_table_privilege('nautilo', 'public.task_cancellation_crypto_staging_receipts', 'DELETE') as allowed,
              has_table_privilege('nautilo', 'public.task_cancellation_crypto_staging_receipts', 'SELECT') as can_select
          `);
          if (restored?.allowed !== original.allowed || restored.can_select !== original.can_select) {
            throw new Error("Fixture staging privileges were not restored");
          }
          const remaining = await tx.select({ objectId: cryptoObjects.objectId }).from(cryptoObjects)
            .where(inArray(cryptoObjects.objectId, writtenObjectIds)).limit(1);
          if (remaining.length !== 0) throw new Error("Fixture crypto cleanup is incomplete");
        });
      }
      await admin.delete(roomMembers).where(inArray(
        roomMembers.roomId,
        [...fixtureRoomIds],
      ));
      await admin.delete(rooms).where(inArray(
        rooms.id,
        [...fixtureRoomIds],
      ));
      await admin.delete(namespaces).where(inArray(
        namespaces.id,
        [...fixtureNamespaceIds],
      ));
      await admin.delete(groupMembers).where(eq(groupMembers.userId, userId));
      await admin.delete(actors).where(eq(actors.ownerId, userId));
      await admin.delete(agents).where(eq(agents.id, productAgentId));
      await admin.delete(serverAdmission).where(eq(serverAdmission.userId, userId));
      await admin.delete(codexUserPreferences).where(eq(
        codexUserPreferences.userId,
        userId,
      ));
      await admin.delete(codexAccountProfiles).where(eq(
        codexAccountProfiles.userId,
        userId,
      ));
      await admin.delete(users).where(eq(users.id, userId));
    } finally {
      try {
        await admin.update(encryptionTransitionPolicy).set({
          mode: originalPolicy.mode,
          shadowBehavior: originalPolicy.shadowBehavior,
          revision: originalPolicy.revision,
          shadowEncryptionStartedAt: originalPolicy.shadowEncryptionStartedAt,
          updatedAt: originalPolicy.updatedAt,
        }).where(eq(encryptionTransitionPolicy.id, "server"));
      } finally {
        namespaceKey?.fill(0);
        seedNamespaceKey?.fill(0);
        for (const key of additionalNamespaceKeys) key.fill(0);
        domainKey?.fill(0);
        runtime?.runtime.key.fill(0);
        signing.privateKey.fill(0);
        encryption.privateKey.fill(0);
        recovery.privateKey.fill(0);
        managerVault.destroy();
        await admin.end();
      }
    }
  };

  try {
    await admin.transaction(async (tx) => {
      await tx.insert(users).values({ id: userId, name: "Task Memory writer" });
      await tx.insert(serverAdmission).values({ userId, admitted: true });
      await tx.insert(agents).values({
        id: productAgentId,
        handle: `task-memory-writer-${productAgentId}`,
      });
      await tx.insert(actors).values([
        {
          id: humanActorId,
          ownerId: userId,
          displayName: "Task Memory writer",
          trustState: "verified",
          kind: "user",
        },
        {
          id: agentActorId,
          ownerId: userId,
          displayName: "Task Memory writer Agent",
          trustState: "verified",
          kind: "agent",
          agentId: productAgentId,
        },
      ]);
      if (options.connectedExecution === true) {
        const [ownersGroup] = await tx.select({ id: groups.id }).from(groups)
          .where(eq(groups.type, "owners")).limit(2);
        if (ownersGroup === undefined) {
          throw new Error("Missing canonical owners Group");
        }
        await tx.insert(groupMembers).values({
          groupId: ownersGroup.id,
          userId,
          grantedBy: humanActorId,
        });
      }
      await tx.insert(namespaces).values([
        {
          id: namespaceValue,
          scope: "room",
          label: "Task Memory writer Namespace",
        },
        {
          id: seedNamespaceValue,
          scope: "room",
          label: "Task Memory seed Namespace",
        },
      ]);
      await tx.insert(rooms).values([
        {
          id: roomId,
          ownerId: userId,
          type: "private",
          label: "Task Memory writer private Room",
          graphThreadId: `task-memory-writer:${roomId}`,
          namespaceId: namespaceValue,
          humanActorIds: [humanActorId],
          kind: "private",
        },
        {
          id: seedRoomId,
          ownerId: userId,
          type: "group",
          label: "Task Memory seed Room",
          graphThreadId: `task-memory-seed:${seedRoomId}`,
          namespaceId: seedNamespaceValue,
          humanActorIds: [humanActorId],
          kind: "group",
        },
      ]);
      await tx.insert(roomMembers).values([
        { roomId, actorId: humanActorId, roomRole: "admin" },
        {
          roomId,
          actorId: agentActorId,
          roomRole: "member",
          agentResponseMode: "active",
        },
        { roomId: seedRoomId, actorId: humanActorId, roomRole: "admin" },
        {
          roomId: seedRoomId,
          actorId: agentActorId,
          roomRole: "member",
          agentResponseMode: "active",
        },
      ]);
      await tx.insert(humanCryptoCustodies).values({
        humanId: humanActorId,
        userId,
        humanActorId,
        initialInstallationLineageDigest: digest("installation-lineage"),
        state: "active",
        everInitializedAt: new Date(NOW),
        firstDeviceId: deviceId,
        currentRecoveryGeneration: 1,
        currentRecoveryPublicKeyDigest: crypto.hash(recovery.publicKey),
        revision: 1,
        createdAt: new Date(NOW),
        updatedAt: new Date(NOW),
      });
      await tx.insert(humanCryptoDevices).values({
        deviceId,
        humanId: humanActorId,
        userId,
        humanActorId,
        clientKind: "electron",
        installationLineageDigest: digest("installation-lineage"),
        deviceGeneration: 1,
        signingPublicKey: signing.publicKey,
        encryptionPublicKey: encryption.publicKey,
        publicFingerprint: crypto.hash(signing.publicKey),
        state: "active",
        authorizationKind: "first_bootstrap",
        recoveryGeneration: 1,
        authorizationEvidenceDigest: digest("device-authorization"),
        keyPackageGeneration: 1,
        keyPackageCount: 0,
        revision: 1,
        createdAt: new Date(NOW),
        activatedAt: new Date(NOW),
      });
      await tx.insert(humanCryptoRecoveryKeys).values({
        humanId: humanActorId,
        generation: 1,
        recoveryKeyId: `task-memory-recovery-${randomUUID()}`,
        formatVersion: 1,
        publicKey: recovery.publicKey,
        publicKeyDigest: crypto.hash(recovery.publicKey),
        archiveHash: digest("recovery-archive"),
        issuerDeviceId: deviceId,
        state: "current",
        activatedAt: new Date(NOW),
        revision: 1,
      });
      await tx.update(encryptionTransitionPolicy).set({
        mode: "encrypted_only",
        shadowBehavior: "strict",
        revision: policyRevision,
        shadowEncryptionStartedAt: new Date(NOW),
        updatedAt: new Date(NOW),
      }).where(eq(encryptionTransitionPolicy.id, "server"));
    });

    const [instance] = await admin.query.nautiloInstanceIdentity.findMany({
      where: (table, operators) => operators.eq(table.id, "self"),
      limit: 1,
    });
    if (instance === undefined) throw new Error("Missing QA instance identity");
    const membershipCoordinates = Object.freeze({
      serverInstanceId: instance.serverInstanceId,
      humanId: humanId(humanActorId),
      lineageGeneration: 1,
    });
    const group = new HumanDeviceOpenMlsGroup(crypto, managerVault, {
      coordinates: membershipCoordinates,
      ownCredential: {
        formatVersion: 1,
        ...membershipCoordinates,
        deviceId: cryptoDeviceId(deviceId),
        installationLineageDigest: digest("installation-lineage"),
        deviceKeyGeneration: 1,
      },
    });
    await group.initialize();
    const initialMembership = await group.createInitialState();
    const membershipRepository = new PostgresHumanDeviceGroupRepository(
      cryptoHandle,
      crypto,
    );
    expect(await membershipRepository.establishInitial({
      userId,
      humanId: humanActorId,
      deviceId,
      headBytes: encodeHumanDeviceGroupHead(initialMembership.head),
      rosterBytes: initialMembership.rosterBytes,
      now: NOW,
    })).toBe("created");

    const subject = Object.freeze({ userId, humanActorId, deviceId });
    const currentDevice = await new PostgresDeviceAdmissionRepository(
      cryptoHandle,
      crypto,
    ).currentAuthorityForDelegation(subject);
    if (currentDevice === null) throw new Error("Current device authority missing");
    const product = await createForegroundProductTransactionContext(
      { userId, agentId: productAgentId },
      productDb,
    );
    const agentProduct = await createForegroundProductTransactionContext(
      { userId, agentId: productAgentId },
      getSharedDirectAgentDb(),
    );
    const productAuthority = new PostgresNamespaceProductAuthority(
      canonicalProductConnection(product.canonicalRunner),
    );
    const domainRepository = new PostgresDomainKeyAuthorityRepository(
      restricted,
      crypto,
      SERVER_SCOPE,
    );
    const headPlan = await productAuthority.withCurrentPrivateRoom({
      subjectUserId: userId,
      subjectHumanId: humanActorId,
      roomId,
      namespaceId: namespaceValue,
      use: (authority) => domainRepository.planHead({
        authority,
        keyClass: "ai",
        clientDeviceId: deviceId,
        now: NOW + 1,
      }),
    });
    if (headPlan?.status !== "create_required") {
      throw new Error(
        `Task Memory Domain head plan was unavailable: ${
          headPlan === null ? "product_authority" : headPlan.status
        }`,
      );
    }
    domainIdValue = headPlan.domainId;
    domainKey = generateDomainKey(crypto);
    const head = prepareDomainKeyHead(crypto, {
      serverId: SERVER_SCOPE,
      cryptoDomainId: cryptoDomainId(headPlan.domainId),
      participantDigest: headPlan.participantDigest,
      participantCount: headPlan.participantCount,
      keyClass: headPlan.keyClass,
      domainKeyGeneration: headPlan.domainKeyGeneration,
      authorizationRevision: authorizationRevision(headPlan.authorizationRevision),
      previousHeadDigest: headPlan.previousHeadDigest,
      publicationOperationId: `task-memory-domain-head:${randomUUID()}`,
      issuerHumanId: humanId(headPlan.issuerHumanId),
      issuerDeviceId: cryptoDeviceId(headPlan.issuerDeviceId),
      issuerDeviceSigningGeneration: headPlan.issuerDeviceSigningGeneration,
      issuedAt: headPlan.issuedAt,
      deadlineAt: headPlan.deadlineAt,
      issuerSigningPublicKey: signing.publicKey,
      issuerSigningPrivateKey: signing.privateKey,
    });
    const deviceEnvelope = await prepareDomainKeyRecipientEnvelope(crypto, {
      head: head.head,
      headDigest: head.digest,
      recipient: {
        recipientHumanId: humanId(headPlan.issuerHumanId),
        recipientKind: "device",
        recipientKeyId: headPlan.issuerDeviceId,
        recipientKeyGeneration: headPlan.issuerDeviceSigningGeneration,
        recipientPublicKey: headPlan.recipientEncryptionPublicKey,
        recipientPublicKeyDigest: headPlan.recipientPublicKeyDigest,
      },
      domainKey,
      issuerHumanId: humanId(headPlan.issuerHumanId),
      issuerDeviceId: cryptoDeviceId(headPlan.issuerDeviceId),
      issuerDeviceSigningGeneration: headPlan.issuerDeviceSigningGeneration,
      issuerSigningPublicKey: signing.publicKey,
      issuerSigningPrivateKey: signing.privateKey,
    });
    const recoveryEnvelope = await prepareDomainKeyRecipientEnvelope(crypto, {
      head: head.head,
      headDigest: head.digest,
      recipient: {
        recipientHumanId: humanId(headPlan.issuerHumanId),
        recipientKind: "recovery",
        recipientKeyId: headPlan.recoveryKeyId,
        recipientKeyGeneration: headPlan.recoveryKeyGeneration,
        recipientPublicKey: headPlan.recoveryPublicKey,
        recipientPublicKeyDigest: headPlan.recoveryPublicKeyDigest,
      },
      domainKey,
      issuerHumanId: humanId(headPlan.issuerHumanId),
      issuerDeviceId: cryptoDeviceId(headPlan.issuerDeviceId),
      issuerDeviceSigningGeneration: headPlan.issuerDeviceSigningGeneration,
      issuerSigningPublicKey: signing.publicKey,
      issuerSigningPrivateKey: signing.privateKey,
    });
    const authorizeEnvelope = (
      envelope: typeof deviceEnvelope,
    ) => prepareDomainKeyRecipientAuthorization(crypto, {
      authorizationOperationId: head.head.publicationOperationId,
      reason: "head_establishment",
      requestDigest: null,
      envelopeBytes: envelope.bytes,
      envelopeDigest: envelope.digest,
      issuerHumanId: humanId(headPlan.issuerHumanId),
      issuerDeviceId: cryptoDeviceId(headPlan.issuerDeviceId),
      issuerDeviceSigningGeneration: headPlan.issuerDeviceSigningGeneration,
      issuedAt: headPlan.issuedAt,
      deadlineAt: headPlan.deadlineAt,
      issuerSigningPublicKey: signing.publicKey,
      issuerSigningPrivateKey: signing.privateKey,
    });
    const deviceAuthorization = authorizeEnvelope(deviceEnvelope);
    const recoveryAuthorization = authorizeEnvelope(recoveryEnvelope);
    expect((await productAuthority.withCurrentPrivateRoom({
      subjectUserId: userId,
      subjectHumanId: humanActorId,
      roomId,
      namespaceId: namespaceValue,
      use: (authority) => domainRepository.publishHead({
        authority,
        keyClass: "ai",
        clientDeviceId: deviceId,
        operationId: head.head.publicationOperationId,
        idempotencyKey: `task-memory-domain-head-request:${randomUUID()}`,
        headBytes: head.bytes,
        envelopeBytes: deviceEnvelope.bytes,
        authorizationBytes: deviceAuthorization.bytes,
        recoveryEnvelopeBytes: recoveryEnvelope.bytes,
        recoveryAuthorizationBytes: recoveryAuthorization.bytes,
        now: NOW + 2,
      }),
    }))?.status).toBe("published");

    const currentDomainKey = domainKey;
    const publishNamespaceBundle = async (
      targetRoomId: string,
      targetNamespaceId: string,
    ) => {
      const bundlePlan = await productAuthority.withCurrentHumanAiReadableRoom({
        subjectUserId: userId,
        subjectHumanId: humanActorId,
        roomId: targetRoomId,
        namespaceId: targetNamespaceId,
        use: (authority) => domainRepository.planNamespaceBundle({
          authority,
          keyClass: "ai",
          clientDeviceId: deviceId,
        }),
      });
      if (bundlePlan?.status !== "create_required") {
        throw new Error("Task Memory Namespace bundle plan was unavailable");
      }
      const key = crypto.randomBytes(32);
      const namespaceHeadDigest = domainNamespaceGenerationHeadDigest(crypto, {
        serverId: SERVER_SCOPE,
        namespaceId: namespaceId(bundlePlan.namespaceId),
        keyClass: bundlePlan.keyClass,
        accessRevision: accessRevision(bundlePlan.namespaceAccessRevision),
        generation: namespaceGeneration(0),
        previousHeadDigest: null,
        generationKey: key,
      });
      const retained = [Object.freeze({
        generation: namespaceGeneration(0),
        accessRevision: accessRevision(bundlePlan.namespaceAccessRevision),
        headDigest: namespaceHeadDigest,
        generationKey: key,
      })];
      const retainedDigest = domainNamespaceRetainedAuthoritySetDigest(
        crypto,
        retained,
      );
      const bundle = prepareDomainNamespaceBundle(crypto, {
        operationId: `task-memory-domain-bundle:${randomUUID()}`,
        bundle: {
          formatVersion: 2,
          purpose: "domain_key.namespace_bundle",
          serverId: SERVER_SCOPE,
          cryptoDomainId: cryptoDomainId(bundlePlan.domainId),
          participantDigest: bundlePlan.participantDigest,
          participantCount: bundlePlan.participantCount,
          keyClass: bundlePlan.keyClass,
          domainKeyGeneration: bundlePlan.domainKeyGeneration,
          domainAuthorizationRevision: authorizationRevision(
            bundlePlan.domainAuthorizationRevision,
          ),
          domainHeadDigest: bundlePlan.domainHeadDigest,
          namespaceId: namespaceId(bundlePlan.namespaceId),
          namespaceAccessRevision: accessRevision(
            bundlePlan.namespaceAccessRevision,
          ),
          namespaceCurrentGeneration: namespaceGeneration(0),
          bundleRevision: bundlePlan.bundleRevision,
          retainedGenerationCount: retained.length,
          retainedAuthoritySetDigest: retainedDigest,
          retainedGenerations: retained,
        },
        previousBindingDigest: bundlePlan.previousBindingDigest,
        issuerHumanId: humanId(bundlePlan.issuerHumanId),
        issuerDeviceId: cryptoDeviceId(bundlePlan.issuerDeviceId),
        issuerDeviceSigningGeneration: bundlePlan.issuerDeviceSigningGeneration,
        issuerSigningPrivateKey: signing.privateKey,
        issuerSigningPublicKey: signing.publicKey,
        domainKey: currentDomainKey,
        issuedAt: NOW + 3,
      });
      expect((await productAuthority.withCurrentHumanAiReadableRoom({
        subjectUserId: userId,
        subjectHumanId: humanActorId,
        roomId: targetRoomId,
        namespaceId: targetNamespaceId,
        use: (authority) => domainRepository.publishNamespaceBundle({
          authority,
          keyClass: "ai",
          clientDeviceId: deviceId,
          operationId: bundle.binding.operationId,
          idempotencyKey: `task-memory-domain-bundle-request:${randomUUID()}`,
          bindingBytes: bundle.bytes,
          now: NOW + 4,
        }),
      }))?.status).toBe("published");
      return Object.freeze({
        namespaceId: targetNamespaceId,
        accessRevision: accessRevision(bundlePlan.namespaceAccessRevision),
        keyGeneration: namespaceGeneration(0),
        domainId: bundlePlan.domainId,
        domainKeyGeneration: bundlePlan.domainKeyGeneration,
        domainAuthorizationRevision: authorizationRevision(
          bundlePlan.domainAuthorizationRevision,
        ),
        domainHeadDigest: bundlePlan.domainHeadDigest.slice(),
        headDigest: retainedDigest.slice(),
        publicationDigest: retainedDigest.slice(),
        publicationSetDigest: retainedDigest.slice(),
        audienceFingerprint: retainedDigest.slice(),
        key,
      });
    };
    const originNamespace = await publishNamespaceBundle(
      roomId,
      namespaceValue,
    );
    namespaceKey = originNamespace.key;
    const seedNamespace = await publishNamespaceBundle(
      seedRoomId,
      seedNamespaceValue,
    );
    seedNamespaceKey = seedNamespace.key;
    const domainAuthority = await domainRepository.inspectForegroundAuthority({
      namespaceIds: [namespaceValue],
      keyClass: "ai",
      subjectHumanId: humanActorId,
      deviceId,
    });
    if (domainAuthority.status !== "ready") {
      throw new Error(`Task Memory Domain authority unavailable: ${domainAuthority.reason}`);
    }

    runtime = await prepareAgentRuntimeInitialization({
      crypto,
      operationId: `task-memory-runtime:${randomUUID()}`,
      agentId: agentId(productAgentId),
      authorizationRevision: authorizationRevision(7),
      configObjects: [{
        objectId: `task-memory-config:${randomUUID()}`,
        configRevision: authorizationRevision(1),
        plaintextDek: digest("task-memory-config-dek"),
      }],
      domains: options.connectedExecution === true ? [{
          domainId: cryptoDomainId(domainAuthority.domains[0]!.domainId),
          domainEpoch: domainEpoch(
            domainAuthority.domains[0]!.domainKeyGeneration,
          ),
          agentAuthorizationRevision: authorizationRevision(7),
          committerDeviceId: cryptoDeviceId(deviceId),
          domainRoot: domainKey,
          committerSigningPrivateKey: signing.privateKey,
        }] : [],
      resolveCurrentDomainCommitterAuthority: () =>
        options.connectedExecution === true ? signing.publicKey : null,
      manager: {
        managerHumanId: humanId(humanActorId),
        managerAuthorizationRevision: authorizationRevision(
          currentDevice.securityRevision,
        ),
        managerDeviceId: cryptoDeviceId(deviceId),
      },
      managerSigningPrivateKey: signing.privateKey,
      resolveCurrentManagerAuthority: () => signing.publicKey,
    });
    expect(await persistAgentRuntimeInitialization({
      crypto,
      storage: new PostgresLatticeStorage(cryptoHandle),
      prepared: runtime,
      resolveCurrentAuthorization: () => ({
        currentState: {
          agentId: agentId(productAgentId),
          authorizationRevision: authorizationRevision(7),
          runtimeGeneration: agentRuntimeGeneration(0),
        },
        currentManager: {
          managerHumanId: humanId(humanActorId),
          managerAuthorizationRevision: authorizationRevision(
            currentDevice.securityRevision,
          ),
          managerDeviceId: cryptoDeviceId(deviceId),
        },
        currentManagerSigningPublicKey: signing.publicKey,
        domains: options.connectedExecution === true ? [{
            domainId: cryptoDomainId(domainAuthority.domains[0]!.domainId),
            domainEpoch: domainEpoch(
              domainAuthority.domains[0]!.domainKeyGeneration,
            ),
            agentAuthorizationRevision: authorizationRevision(7),
            committerDeviceId: cryptoDeviceId(deviceId),
            committerSigningPublicKey: signing.publicKey,
          }] : [],
      }),
    })).toBe("inserted");
    destroyDomainKeyRecipientAuthorizationV2(recoveryAuthorization.authorization);
    destroyDomainKeyRecipientAuthorizationV2(deviceAuthorization.authorization);
    destroyDomainKeyRecipientEnvelopeV2(recoveryEnvelope.envelope);
    destroyDomainKeyRecipientEnvelopeV2(deviceEnvelope.envelope);
    destroyDomainKeyHeadV2(head.head);
    for (const value of [
      recoveryAuthorization.bytes,
      recoveryAuthorization.digest,
      deviceAuthorization.bytes,
      deviceAuthorization.digest,
      recoveryEnvelope.bytes,
      recoveryEnvelope.digest,
      deviceEnvelope.bytes,
      deviceEnvelope.digest,
      head.bytes,
      head.digest,
    ]) value.fill(0);

    return {
      admin,
      productDb,
      restricted,
      cryptoHandle,
      crypto,
      userId,
      humanActorId,
      productAgentId,
      namespaceValue,
      seedNamespaceValue,
      roomId,
      seedRoomId,
      deviceId,
      signingPrivateKey: signing.privateKey,
      subject,
      currentDevice,
      policyRevision,
      product,
      agentProduct,
      domainAuthority,
      domainSecret: Object.freeze({
        ...domainAuthority.domains[0]!,
        participantDigest: domainAuthority.domains[0]!.participantDigest.slice(),
        headDigest: domainAuthority.domains[0]!.headDigest.slice(),
        activeNamespaceBindingSetDigest:
          domainAuthority.domains[0]!.activeNamespaceBindingSetDigest.slice(),
        domainKey: domainKey.slice(),
      }) satisfies DomainForegroundSecretEntry,
      namespace: Object.freeze({
        ...originNamespace,
        domainHeadDigest: originNamespace.domainHeadDigest.slice(),
        headDigest: originNamespace.headDigest.slice(),
        publicationDigest: originNamespace.publicationDigest.slice(),
        publicationSetDigest: originNamespace.publicationSetDigest.slice(),
        audienceFingerprint: originNamespace.audienceFingerprint.slice(),
        key: originNamespace.key.slice(),
      }),
      seedNamespace,
      runtime,
      objectIds,
      memoryIds,
      requestIds,
      taskIds,
      jobIds,
      scopeIds,
      sessionThreadIds,
      fixtureRoomIds,
      fixtureNamespaceIds,
      publishAdditionalNamespaceBundle: async (roomId: string, namespaceId: string) => {
        const value = await publishNamespaceBundle(roomId, namespaceId);
        additionalNamespaceKeys.add(value.key);
        return value;
      },
      cleanup,
    };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Task Memory fixture setup and cleanup both failed",
      );
    }
    throw error;
  }
}

type ScenarioOptions = Readonly<{
  contentRepresentation?: "protected" | "dual";
  namespaceIds?: readonly string[];
  scopeMemory?: Readonly<{
    binding: TaskScopeMemoryBinding;
    targetRoomId: string;
    targetNamespace: TaskRuntimeAgentObjectNamespaceMaterial;
  }>;
}>;

async function createScenario(
  base: BaseFixture,
  options: ScenarioOptions = {},
) {
  const scopeMemory = options.scopeMemory;
  if (scopeMemory !== undefined && options.namespaceIds !== undefined) {
    throw new TypeError("Task Memory scenario authority is ambiguous");
  }
  const contentRepresentation = options.contentRepresentation ?? "protected";
  const targetRoomId = scopeMemory?.targetRoomId ?? base.roomId;
  const targetNamespace = scopeMemory?.targetNamespace ?? base.namespace;
  const taskId = randomUUID();
  const taskRunId = randomUUID();
  const jobId = randomUUID();
  const memoryId = randomUUID();
  const requestId = `task-run-authorization:${taskRunId}`;
  const inputObjectId = deriveTaskContentCryptoObjectIdV1({
    kind: "definition",
    taskId,
    contentRevision: 1,
  });
  const resultObjectId = deriveTaskContentCryptoObjectIdV1({
    kind: "run_result",
    taskId,
    taskRunId,
    contentRevision: 1,
  });
  const memoryObjectId = deriveMemoryCryptoObjectIdV1({
    memoryId,
    contentRevision: 1,
  });
  const requiredFingerprint = fingerprintRequiredMemoryNamespaces([
    base.namespaceValue,
  ]);
  const startedAt = new Date(NOW - 1_000);
  const reference: ProtectedTaskJobReferenceV1 = Object.freeze({
    kind: "protected_task_run_v1",
    taskId,
    taskRunId,
    inputObjectId,
    resultObjectId,
    authorizationRequestId: requestId,
    policyRevision: base.policyRevision,
    executionSegment: 1,
  });
  await base.admin.transaction(async (tx) => {
    await tx.insert(cryptoObjects).values({
      objectId: inputObjectId,
      payloadHash: digest(`task-payload:${taskId}`),
      payloadBytes: Uint8Array.of(1),
    });
    await tx.insert(tasks).values({
      id: taskId,
      ownerId: base.userId,
      requestorId: base.userId,
      agentId: base.productAgentId,
      prompt: "",
      scheduleKind: "now",
      callingRoomId: base.roomId,
      targetChat: targetRoomId === base.roomId
        ? "orphan"
        : "last_in_namespace",
      targetRoomId,
      targetUserIds: [base.userId],
      status: "running",
      useScope: scopeMemory !== undefined,
      scopeId: scopeMemory?.binding.scopeId ?? null,
    });
    await tx.insert(taskDefinitionCryptoRevisions).values({
      taskId,
      contentNamespaceId: base.namespaceValue,
      contentRevision: 1,
      operationId: `task-memory-definition:${randomUUID()}`,
      requestDigest: digest(`task-request:${taskId}`),
      authorityFingerprint: digest(`task-authority:${taskId}`),
      requesterHumanId: base.humanActorId,
      anchorNamespaceId: base.namespaceValue,
      cryptoObjectId: inputObjectId,
      representation: contentRepresentation,
      requiredNamespaceFingerprint: requiredFingerprint,
      completion: "complete",
      disposition: "mapped",
      cryptoCompletedAt: new Date(NOW),
    });
    await tx.update(tasks).set({
      contentRepresentation,
      contentNamespaceId: base.namespaceValue,
      contentRevision: 1,
      cryptoObjectId: inputObjectId,
      cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: requiredFingerprint,
      cryptoMappingState: "verified",
    }).where(eq(tasks.id, taskId));
    await tx.insert(jobs).values({
      id: jobId,
      ownerId: base.userId,
      requestorId: base.userId,
      laneKey: `task:${taskId}`,
      roomId: targetRoomId,
      type: "foreground",
      status: "running",
      input: reference,
      startedAt,
    });
    await tx.insert(taskRuns).values({
      id: taskRunId,
      taskId,
      jobId,
      graphThreadId: `task:${taskId}:${taskRunId}`,
      status: "running",
      startedAt,
    });
  });
  base.taskIds.add(taskId);
  base.jobIds.add(jobId);
  base.objectIds.add(inputObjectId);
  base.objectIds.add(memoryObjectId);
  base.requestIds.add(requestId);

  const occurrence: ProtectedTaskRunningOccurrence = Object.freeze({
    task: Object.freeze({
      id: taskId,
      ownerId: base.userId,
      requestorId: base.userId,
      agentId: base.productAgentId,
      callingRoomId: base.roomId,
      scheduleKind: "now",
      contentRepresentation,
      contentNamespaceId: base.namespaceValue,
      contentRevision: 1,
      cryptoObjectId: inputObjectId,
      cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: requiredFingerprint.slice(),
    }),
    run: Object.freeze({
      id: taskRunId,
      taskId,
      jobId,
      graphThreadId: `task:${taskId}:${taskRunId}`,
      status: "running",
      startedAt,
    }),
  });
  const availableNamespaces = new Map<
    string,
    TaskRuntimeAgentObjectNamespaceMaterial
  >([
    [base.namespace.namespaceId, base.namespace],
    [base.seedNamespace.namespaceId, base.seedNamespace],
  ]);
  const requiredNamespaceIds = scopeMemory === undefined
    ? [...(options.namespaceIds ?? [base.namespaceValue])]
    : [...scopeMemory.binding.readableNamespaceIds];
  const namespaceRequirements = Object.freeze(requiredNamespaceIds
    .sort()
    .map((requiredNamespaceId, ordinal) => {
      const namespace = availableNamespaces.get(requiredNamespaceId);
      if (namespace === undefined) {
        throw new Error("Task Memory scenario Namespace is unavailable");
      }
      return Object.freeze({
        ordinal,
        namespaceId: requiredNamespaceId,
        domainId: namespace.domainId,
        operations: scopeMemory === undefined
            || requiredNamespaceId === base.namespaceValue
            || requiredNamespaceId === targetNamespace.namespaceId
          ? Object.freeze(["decrypt", "encrypt"] as const)
          : Object.freeze(["decrypt"] as const),
        expectedAccessRevision: namespace.accessRevision,
        expectedPolicyRevision: base.policyRevision,
      });
    }));
  const scenarioDomainAuthority = scopeMemory === undefined
      && requiredNamespaceIds.length === 1
      && requiredNamespaceIds[0] === base.namespaceValue
    ? base.domainAuthority
    : await new PostgresDomainKeyAuthorityRepository(
      base.restricted,
      base.crypto,
      SERVER_SCOPE,
    ).inspectForegroundAuthority({
      namespaceIds: [...requiredNamespaceIds],
      keyClass: "ai",
      subjectHumanId: base.humanActorId,
      deviceId: base.deviceId,
    });
  if (scenarioDomainAuthority.status !== "ready"
    || scenarioDomainAuthority.domains.length !== 1) {
    throw new Error("Task Memory scenario Domain authority is unavailable");
  }
  const scenarioDomain = scenarioDomainAuthority.domains[0]!;
  const scenarioDomainSecret = Object.freeze({
    ...scenarioDomain,
    participantDigest: scenarioDomain.participantDigest.slice(),
    headDigest: scenarioDomain.headDigest.slice(),
    activeNamespaceBindingSetDigest:
      scenarioDomain.activeNamespaceBindingSetDigest.slice(),
    domainKey: base.domainSecret.domainKey,
  }) satisfies DomainForegroundSecretEntry;
  const domainRequirements = Object.freeze([Object.freeze({
    ordinal: 0,
    domainId: scenarioDomain.domainId,
    expectedEpoch: scenarioDomain.domainKeyGeneration,
    expectedAuthorizationRevision: scenarioDomain.authorizationRevision,
  })]);
  const stableIdentity = Object.freeze({
    taskId,
    taskRunId,
    executionSegment: 1,
    resumeContinuationFingerprint: null,
    ownerId: base.userId,
    requestorId: base.userId,
    agentId: base.productAgentId,
    callingRoomId: base.roomId,
    scheduleKind: "now" as const,
    graphThreadId: occurrence.run.graphThreadId,
    startedAt: startedAt.getTime(),
    sourceRoomId: base.roomId,
    targetRoomId,
    targetUserIds: [base.userId],
    outputRoomId: targetRoomId,
    outputNamespaceId: base.namespaceValue,
    memoryMode: scopeMemory === undefined ? "namespace" as const : "scope" as const,
    scopeId: scopeMemory?.binding.scopeId ?? null,
    contentRepresentation,
    contentNamespaceId: base.namespaceValue,
    contentRevision: 1,
    contentObjectId: inputObjectId,
    contentAccessRevision: 0,
    requiredNamespaceFingerprint: Buffer.from(requiredFingerprint).toString(
      "base64url",
    ),
  });
  const scopeWorkIdentity = scopeMemory === undefined ? null : JSON.stringify({
    taskId,
    taskRunId,
    targetRoomId,
    scopeMemory: scopeMemory.binding,
  });
  const initialSnapshot = createBackgroundAuthorizationTaskRuntimeRequestV3({
    requestId,
    workId: taskRunId,
    namespaceId: base.namespaceValue,
    now: NOW,
  });
  const idempotencyKey = taskRuntimeStableIdempotencyKey(stableIdentity);
  const initial: BackgroundAuthorizationTaskRuntimeRecordV3 = {
    snapshot: initialSnapshot,
    workIdentityHash: base.crypto.hash(new TextEncoder().encode(
      scopeWorkIdentity ?? idempotencyKey,
    )),
    idempotencyKey,
    workKind: "task.execute",
    purpose: "task.execute",
    domainId: base.domainSecret.domainId,
    processorAuthorizationRevision: null,
    expectedDomainEpoch: base.domainSecret.domainKeyGeneration,
    expectedNamespaceAccessRevision: base.namespace.accessRevision,
    expectedPolicyRevision: base.policyRevision,
    descriptorBytes: null,
    acceptedMaterial: null,
    finishedAt: null,
    authoritySet: { namespaceRequirements, domainRequirements },
  };
  const recipient = await base.crypto.generateEncryptionKeyPair();
  const recipientKeyId = `task-memory-recipient:${randomUUID()}`;
  const plan = createDomainForegroundAuthorizationPlan(base.crypto, {
    authorizationId: requestId,
    policyRevision: base.policyRevision,
    sessionId: `task-run:${taskRunId}`,
    roomId: base.roomId,
    subjectHumanId: humanId(base.humanActorId),
    committerDeviceId: cryptoDeviceId(base.deviceId),
    committerDeviceSigningGeneration: base.currentDevice.deviceGeneration,
    hostAuthorizationRevision: authorizationRevision(
      base.currentDevice.securityRevision,
    ),
    recipientKind: "runtime",
    recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: initial.snapshot.recipientGeneration,
    recipientKeyId,
    operations: ["decrypt", "encrypt"],
    issuedAt: NOW,
    deadlineAt: EXPIRES_AT,
    maximumSecretBytes: 2_048,
    domains: scenarioDomainAuthority.domains,
  });
  const request = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId,
    workId: taskRunId,
    workKind: "task.execute",
    workPurpose: "task.execute",
    recipientGeneration: initial.snapshot.recipientGeneration,
    episodeId: plan.sessionId,
    sourceRoomId: plan.roomId,
    recipientKeyId,
    recipientPublicKey: recipient.publicKey,
    authorizationPlan: plan,
    issuedAt: plan.issuedAt,
    deadlineAt: plan.deadlineAt,
  });
  const descriptorBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(
    request,
  );
  const attached: BackgroundAuthorizationTaskRuntimeRecordV3 = {
    ...initial,
    snapshot: attachBackgroundAuthorizationRecipient(initial.snapshot, {
      descriptorDigest: hexDigest(descriptorBytes),
      recipientKeyId,
      recipientPublicKey: Buffer.from(recipient.publicKey).toString("base64url"),
      expiresAt: EXPIRES_AT,
      now: NOW + 1,
    }) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
    descriptorBytes,
  };
  const repository = new PostgresBackgroundAuthorizationRepository(
    base.cryptoHandle,
  );
  expect((await repository.create(initial)).status).toBe("created");
  const attachedResult = await repository.compareAndSwap({
    expectedRequestRevision: initial.snapshot.requestRevision,
    next: attached,
  });
  if (attachedResult.status !== "updated") {
    throw new Error("Task Memory recipient attachment lost its CAS");
  }
    const authorization = await mintDomainForegroundAuthorization(base.crypto, {
    plan,
    domains: [Object.freeze({
      ...base.domainSecret,
      sourceNamespaceId: scenarioDomain.sourceNamespaceId,
    })],
    committerDeviceSigningPrivateKey: base.signingPrivateKey,
    recipientEncryptionPublicKey: recipient.publicKey,
  });
  const responseBytes = serializeDomainForegroundAuthorizationV2(authorization);
  const responseHash = base.crypto.hash(responseBytes);
  const issuerSigningPublicKeyHash = base.crypto.hash(
    base.currentDevice.signingPublicKey,
  );
  try {
    const verified = verifyDomainForegroundAuthorizationV2(base.crypto, {
      authorizationBytes: responseBytes,
      now: NOW + 2,
      current: {
        authorizationId: plan.authorizationId,
        policyRevision: plan.policyRevision,
        sessionId: plan.sessionId,
        roomId: plan.roomId,
        subjectHumanId: plan.subjectHumanId,
        committerDeviceId: plan.committerDeviceId,
        committerDeviceSigningGeneration:
          plan.committerDeviceSigningGeneration,
        committerDeviceSigningPublicKey:
          base.currentDevice.signingPublicKey,
        committerDeviceActive: true,
        hostAuthorizationRevision: plan.hostAuthorizationRevision,
        recipientKind: plan.recipientKind,
        recipientPrincipalId: plan.recipientPrincipalId,
        recipientAuthorizationRevision: plan.recipientAuthorizationRevision,
        recipientRuntimeGeneration: plan.recipientRuntimeGeneration,
        recipientKeyId: plan.recipientKeyId,
        recipientAuthorized: true,
        domains: scenarioDomainAuthority.domains,
      },
    });
    if (verified.status !== "verified") {
      throw new Error("Task Memory signed authorization did not verify");
    }
    const accepted = await repository.acceptVerifiedResponse({
      response: {
        formatVersion: 3,
        kind: "runtime",
        requestId,
        descriptorHash: base.crypto.hash(descriptorBytes),
        descriptorBytes: descriptorBytes.slice(),
        recipientGeneration: initial.snapshot.recipientGeneration,
        recipientKeyId,
        recipientPublicKey: recipient.publicKey.slice(),
        workId: taskRunId,
        workKind: initial.workKind,
        purpose: initial.purpose,
        authoritySet: initial.authoritySet,
        responseBytes: responseBytes.slice(),
        responseHash: responseHash.slice(),
        authorizationId: plan.authorizationId,
        authorizationHash: responseHash.slice(),
        issuingHumanId: base.humanActorId,
        issuingDeviceId: base.deviceId,
        issuingDeviceAuthorizationRevision:
          base.currentDevice.securityRevision,
        issuerSigningPublicKeyHash: issuerSigningPublicKeyHash.slice(),
        issuedAt: plan.issuedAt,
        expiresAt: plan.deadlineAt,
      },
      acceptedAt: NOW + 2,
    });
    if (accepted.status !== "accepted") {
      throw new Error("Task Memory authorization response was not accepted");
    }
    const acceptedRecord = accepted.record as
      BackgroundAuthorizationTaskRuntimeRecordV3;
    const claimed: BackgroundAuthorizationTaskRuntimeRecordV3 = {
      ...acceptedRecord,
      snapshot: claimBackgroundAuthorizationRequest(
        acceptedRecord.snapshot,
        `task-memory-claim:${randomUUID()}`,
        NOW + 3,
        EXPIRES_AT,
      ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
    };
    const claimedResult = await repository.compareAndSwap({
      expectedRequestRevision: acceptedRecord.snapshot.requestRevision,
      next: claimed,
    });
    if (claimedResult.status !== "updated") {
      throw new Error("Task Memory claim lost its CAS");
    }
    const storedClaimed = claimedResult.record as
      BackgroundAuthorizationTaskRuntimeRecordV3;
    const running: BackgroundAuthorizationTaskRuntimeRecordV3 = {
      ...storedClaimed,
      snapshot: markBackgroundAuthorizationRunning(
        storedClaimed.snapshot,
        NOW + 4,
      ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
    };
    const runningResult = await repository.compareAndSwap({
      expectedRequestRevision: storedClaimed.snapshot.requestRevision,
      next: running,
    });
    if (runningResult.status !== "updated") {
      throw new Error("Task Memory running claim lost its CAS");
    }
    const record = runningResult.record as
      BackgroundAuthorizationTaskRuntimeRecordV3;
    const evidenceInput: TaskRuntimeExecutionEvidenceInputV1 = {
      requestId,
      workId: taskRunId,
      claimId: record.snapshot.claimId!,
      claimExpiresAt: record.snapshot.claimExpiresAt!,
      recipientExpiresAt: record.snapshot.recipient!.expiresAt,
      expiresAt: EXPIRES_AT,
      recipientGeneration: record.snapshot.recipientGeneration,
      recipientKeyId,
      authorizationDigest: responseHash.slice(),
      policyRevision: base.policyRevision,
      episodeId: plan.sessionId,
      sourceRoomId: base.roomId,
      hostAuthorizationRevision: base.currentDevice.securityRevision,
      recipientAuthorizationRevision: 0,
      result: {
        taskId,
        taskRunId,
        contentRevision: 1,
        objectId: resultObjectId,
        signerAgentId: base.productAgentId,
        namespace: {
          namespaceId: base.namespace.namespaceId,
          domainId: base.namespace.domainId,
          operations: ["encrypt"],
          expectedAccessRevision: base.namespace.accessRevision,
          expectedPolicyRevision: base.policyRevision,
        },
      },
      domainRequirements: scenarioDomainAuthority.domains,
      namespaceRequirements,
    };
    const writerInput = (
      evidence: TaskRuntimeExecutionEvidence,
      now: () => number,
      restricted = base.restricted,
      runner = base.product.canonicalRunner,
    ): ProtectedTaskMemoryObjectWriterInput => ({
      runner,
      restricted,
      crypto: base.crypto,
      serverScope: SERVER_SCOPE,
      subject: base.subject,
      occurrence,
      record,
      request,
      evidence,
      jobId,
      executionRoomId: targetRoomId,
      ...(scopeMemory === undefined ? {} : {
        scopeMemory: Object.freeze({
          binding: scopeMemory.binding,
          targetRoomId: scopeMemory.targetRoomId,
          workIdentity: scopeWorkIdentity!,
        }),
      }),
      reference,
      now,
      signal: new AbortController().signal,
    });
    const withAuthority = <Value>(
      now: () => number,
      use: (input: Readonly<{
        evidence: TaskRuntimeExecutionEvidence;
        writer: ProtectedTaskMemoryObjectWriterInput;
      }>) => Promise<Value>,
      restricted = base.restricted,
      runner = base.product.canonicalRunner,
    ) => withTaskRuntimeExecutionEvidenceV1({
      evidence: evidenceInput,
      signal: new AbortController().signal,
      now: () => NOW + 5,
      execute: (evidence) => use(Object.freeze({
        evidence,
        writer: writerInput(evidence, now, restricted, runner),
      })),
    });
    const withPreparedWrite = <Value>(
      now: () => number,
      use: (input: Readonly<{
        evidence: TaskRuntimeExecutionEvidence;
        writer: ProtectedTaskMemoryObjectWriterInput;
        write: ProtectedTaskMemoryObjectWrite;
      }>) => Promise<Value>,
      restricted = base.restricted,
      runner = base.product.canonicalRunner,
    ) => withAuthority(now, async ({ evidence, writer }) => {
        const plaintextBytes = encodeMemoryPayloadV1({
          formatVersion: 1,
          type: "fact",
          content: `sealed Task Memory ${memoryId}`,
        });
        try {
          return await use(Object.freeze({
            evidence,
            writer,
            write: Object.freeze({
              memoryId,
              contentRevision: 1,
              operationId: `task-memory-object-write:${memoryId}`,
              prepared: prepareTaskRuntimeAgentObject({
                crypto: base.crypto,
                evidence,
                objectId: memoryObjectId,
                objectType: MEMORY_OBJECT_TYPE,
                plaintextBytes,
                createdAt: NOW + 5,
                namespaceSet: [targetNamespace],
                operationId: `task-memory-object-write:${memoryId}`,
                runtime: base.runtime.runtime,
                signerPublication: base.runtime.signerPublication,
                resolveHistoricalSignerPublicationManager: () =>
                  base.currentDevice.signingPublicKey,
                agentAuthorizationRevision: 7,
              }),
            }),
          }));
        } finally {
          plaintextBytes.fill(0);
        }
      }, restricted, runner);
    const execute = (
      now: () => number,
      restricted = base.restricted,
      runner = base.product.canonicalRunner,
    ) => withPreparedWrite(
      now,
      ({ writer, write }) => persistProtectedTaskMemoryObject(writer, write),
      restricted,
      runner,
    );
    return Object.freeze({
      taskId,
      taskRunId,
      jobId,
      memoryId,
      memoryObjectId,
      requestId,
      domainSecret: scenarioDomainSecret,
      execute,
      withAuthority,
      withPreparedWrite,
    });
  } finally {
    recipient.privateKey.fill(0);
    responseBytes.fill(0);
    responseHash.fill(0);
    issuerSigningPublicKeyHash.fill(0);
    destroyDomainForegroundAuthorizationV2(authorization);
    destroyDomainForegroundAuthorizationPlanV2(plan);
  }
}

type FallbackPrepareRequest = Parameters<
  ReturnType<typeof createTaskRuntimeDomainMemoryCryptoSession>["session"]["prepare"]
>[0];

function createUnavailableMemorySession(
  onPrepare: (request: FallbackPrepareRequest) => Promise<void> =
    () => Promise.resolve(),
): typeof createTaskRuntimeDomainMemoryCryptoSession {
  return input => {
    const current = createTaskRuntimeDomainMemoryCryptoSession(input);
    return Object.freeze({
      ...current,
      session: Object.freeze({
        ...current.session,
        prepare: async (request: FallbackPrepareRequest) => {
          await onPrepare(request);
          return Object.freeze({
            status: "unavailable" as const,
            reason: "encryption_pending" as const,
          });
        },
      }),
    });
  };
}

function withShadowFallbackRepository<Value>(input: Readonly<{
  base: BaseFixture;
  scenario: Awaited<ReturnType<typeof createScenario>>;
  writer: ProtectedTaskMemoryObjectWriterInput;
  authority: ProtectedMemoryAuthority;
  vector: readonly number[];
  execute(repository: ProtectedAgentMemoryRepository): Promise<Value>;
  onPrepare?: (request: FallbackPrepareRequest) => Promise<void>;
}>): Promise<Value> {
  return withProtectedTaskNativeMemoryRepository({
    authority: input.authority,
    policy: Object.freeze({
      mode: "shadow_encryption" as const,
      shadowBehavior: "fallback" as const,
      revision: input.base.policyRevision,
    }),
    current: input.writer,
    domains: Object.freeze([input.scenario.domainSecret]),
    signer: Object.freeze({
      agentAuthorizationRevision: 7,
      runtime: input.base.runtime.runtime,
      signerPublication: input.base.runtime.signerPublication,
    }),
    resolveHistoricalSignerPublicationManager: () =>
      input.base.currentDevice.signingPublicKey,
    product: input.base.product,
    agentProduct: input.base.agentProduct,
    owner: bindEncryptionDataOperationOwner({
      policy: {
        resolve: async () => Object.freeze({
          policy: Object.freeze({
            mode: "shadow_encryption" as const,
            shadowBehavior: "fallback" as const,
          }),
          revalidationToken: input.base.policyRevision,
        }),
        revalidate: async token => {
          if (token !== input.base.policyRevision) {
            throw new TypeError("Task Memory policy token changed");
          }
        },
      },
    }),
    embedding: Object.freeze({
      embed: async () => Object.freeze({
        status: "success" as const,
        value: Object.freeze({
          vector: Object.freeze([...input.vector]),
          provider: "openai" as const,
          canonicalModel: "text-embedding-3-small",
          dimensions: 1536 as const,
          contractVersion: 1,
        }),
      }),
    }),
    execute: input.execute,
  }, {
    createSession: createUnavailableMemorySession(input.onPrepare),
  });
}

async function objectRowCounts(
  base: BaseFixture,
  objectId: string,
): Promise<Readonly<{
  payload: number;
  head: number;
  manifest: number;
  envelope: number;
}>> {
  const [payload, head, manifest, envelope] = await Promise.all([
    base.admin.select({ objectId: cryptoObjects.objectId }).from(cryptoObjects)
      .where(eq(cryptoObjects.objectId, objectId)),
    base.admin.select({ objectId: objectCryptoAccessHeads.objectId })
      .from(objectCryptoAccessHeads)
      .where(eq(objectCryptoAccessHeads.objectId, objectId)),
    base.admin.select({ objectId: objectCryptoAccessManifests.objectId })
      .from(objectCryptoAccessManifests)
      .where(eq(objectCryptoAccessManifests.objectId, objectId)),
    base.admin.select({ objectId: objectCryptoNamespaceEnvelopes.objectId })
      .from(objectCryptoNamespaceEnvelopes)
      .where(eq(objectCryptoNamespaceEnvelopes.objectId, objectId)),
  ]);
  return Object.freeze({
    payload: payload.length,
    head: head.length,
    manifest: manifest.length,
    envelope: envelope.length,
  });
}

async function repairHistoricalTaskDefinition(base: BaseFixture, taskId: string,
  repairOptions: Readonly<{ expireAfterStage?: boolean; legacyReceipt?: boolean; legacyUploadWithoutReceipt?: boolean; now?: () => number; afterStage?: () => void; expectedRetainedHistoricalError?: string | null }> = {},
): Promise<string> {
  const discovery = await discoverTaskContentBackfill(base.admin, {
    humanActorId: base.humanActorId, deviceId: base.deviceId, now: new Date(NOW),
    pageLimit: 64, resumeAt: new Date(NOW + 60_000),
  });
  if (discovery.status !== "candidate") throw new Error(`Missing historical candidate: ${discovery.status}`);
  expect(discovery.candidate.taskId).toBe(taskId);
  const claimed = await claimTaskContentBackfill(base.admin, {
    humanActorId: base.humanActorId, requesterUserId: base.userId,
    deviceId: base.deviceId, claimId: randomUUID(), policyRevision: base.policyRevision,
    candidate: discovery.candidate, now: new Date(NOW), expiresAt: new Date(NOW + 30_000),
  });
  if (claimed.status !== "claimed") throw new Error(`Historical claim failed: ${claimed.status}`);
  const subject = Object.freeze({ userId: base.userId, humanActorId: base.humanActorId,
    admission: Object.freeze({ ...base.currentDevice, headDigest: base.currentDevice.headDigest.slice(),
      expiresAt: NOW + 20_000 }),
  });
  expect(await withCurrentTaskContentBackfillDevice({ restricted: base.restricted,
    crypto: base.crypto, subject, now: () => NOW,
    use: () => Promise.resolve(true),
  })).toBe(true);
  const context = await createHumanProductTransactionContext(base.userId, base.productDb);
  const legacySourceDigest = await context.canonicalRunner.transaction(async tx => {
    const historicalSource = await readTaskContentBackfillSource(tx, claimed.claim);
    expect(historicalSource?.classification.status).toBe("supported");
    if (historicalSource?.classification.status !== "supported") {
      throw new Error("Historical source classification was unavailable");
    }
    return historicalSource.classification.legacySourceDigest;
  }, { isolationLevel: "read committed" });
  const stageConnection: PostgresJsBridgeConnection = {
    query: base.restricted.query.bind(base.restricted),
    transaction: async (use, options) => {
      let insertedReceipt = false;
      const value = await base.restricted.transaction(async tx => use({
        query: async <Row extends PostgresJsBridgeRow = PostgresJsBridgeRow>(statement: string, parameters?: readonly PostgresJsBridgeScalar[]) => {
          const rows = await tx.query<Row>(statement, parameters);
          if (statement.replaceAll('"', "").toLowerCase()
            .includes("insert into task_historical_content_crypto_staging_receipts")) insertedReceipt = true;
          return rows;
        },
      }), options);
      if (repairOptions.expireAfterStage === true && insertedReceipt) repairOptions.afterStage?.();
      return value;
    },
    transactionOnce: async (use, options) => stageConnection.transaction(use, options),
  };
  const publication = createTaskContentBackfillPublication({
    db: base.productDb, restricted: stageConnection, crypto: base.crypto,
    serverScope: SERVER_SCOPE, now: repairOptions.now ?? (() => NOW),
    owner: bindEncryptionDataOperationOwner({ policy: {
      resolve: async () => ({ policy: { mode: "shadow_encryption", shadowBehavior: "strict" },
        revalidationToken: base.policyRevision }),
      revalidate: async () => {},
    } }),
  });
  const source = await publication.source(subject, claimed.claim.claimId);
  if (source?.status !== "source" || !("plan" in source)) throw new Error("Historical source was unavailable");
  const currentPlan = source.plan;
  const legacyObjectId = deriveTaskHistoricalContentCryptoObjectIdV1({
    coordinate: currentPlan.coordinate,
    sourceDigest: legacySourceDigest,
    namespaceId: currentPlan.namespaceId,
  });
  const legacyUnsigned = {
    ...currentPlan,
    objectId: legacyObjectId,
    operationId: `task-historical-publish:${legacyObjectId.split(":").at(-1)!}`,
    sourceDigestBase64url: Buffer.from(legacySourceDigest).toString("base64url"),
  };
  const { expiresAt: _legacyExpiry, planDigestBase64url: _legacyPlanDigest,
    ...legacyDigestCoordinates } = legacyUnsigned;
  const plan = repairOptions.legacyReceipt === true
    || repairOptions.legacyUploadWithoutReceipt === true ? Object.freeze({
    ...legacyUnsigned,
    planDigestBase64url: createHash("sha256")
      .update("nautilo/task-content-backfill-publication-plan/v1\n")
      .update(JSON.stringify(legacyDigestCoordinates)).digest("base64url"),
  }) : currentPlan;
  const renewedSubject = Object.freeze({ ...subject,
    admission: Object.freeze({ ...subject.admission, expiresAt: NOW + 60_000 }),
  });
  const renewedSource = await publication.source(renewedSubject, claimed.claim.claimId);
  if (renewedSource?.status !== "source") throw new Error("Renewed device source was unavailable");
  expect(renewedSource.plan.expiresAt).toBeGreaterThan(currentPlan.expiresAt);
  expect(renewedSource.plan.planDigestBase64url).toBe(currentPlan.planDigestBase64url);
  base.objectIds.add(plan.objectId);
  const plaintext = Buffer.from(source.payloadBytesBase64url, "base64url");
  expect(decodeTaskDefinitionContent(plaintext).retainedHistoricalError)
    .toBe(repairOptions.expectedRetainedHistoricalError ?? null);
  const encrypted = encryptObjectPayload(base.crypto, {
    objectId: objectId(plan.objectId), keyClass: "ai", objectType: "nautilo-task-definition-v1",
    createdAt: unixTimestamp(NOW),
  }, plaintext);
  plaintext.fill(0);
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  const envelopeBytes = encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespace(
    base.crypto, base.namespace.key, {
      objectId: objectId(plan.objectId), namespaceId: namespaceId(plan.namespaceId),
      keyClass: "ai", keyGeneration: namespaceGeneration(plan.keyGeneration),
      bindingRevisionAtWrap: accessRevision(plan.expectedAccessRevision),
    }, encrypted.dek,
  ));
  encrypted.dek.fill(0);
  const access = prepareHumanObjectAccessManifestGenesisSet(base.crypto, {
    objectId: plan.objectId, payloadHash: base.crypto.hash(payloadBytes), envelopeBytes: [envelopeBytes],
    sourceAuthorized: true, targetAuthorized: true, subjectHumanId: base.humanActorId,
    committerDeviceId: base.deviceId, hostAuthorizationRevision: plan.hostAuthorizationRevision,
    committerSigningPublicKey: base.currentDevice.signingPublicKey,
    committerSigningPrivateKey: base.signingPrivateKey,
  });
  const signed = prepareHumanExistingTaskRepresentationPublicationRequest(base.crypto, {
    kind: "definition", entityId: taskId, taskId, claimId: plan.claimId, operationId: plan.operationId,
    cryptoObjectId: plan.objectId, sourceDigest: Buffer.from(plan.sourceDigestBase64url, "base64url"),
    sourcePayloadHash: Buffer.from(plan.sourcePayloadHashBase64url, "base64url"),
    planDigest: Buffer.from(plan.planDigestBase64url, "base64url"),
    operationalFieldsDigest: Buffer.from(plan.operationalFieldsDigestBase64url, "base64url"),
    expectedContentRevision: 0, nextContentRevision: 1, expectedCryptoAccessRevision: 0,
    resultCryptoAccessRevision: 0, subjectHumanId: plan.requesterHumanId,
    committerDeviceId: plan.deviceId, hostAuthorizationRevision: plan.hostAuthorizationRevision,
    namespaceId: plan.namespaceId, domainId: plan.domainId,
    expectedNamespaceAccessRevision: plan.expectedAccessRevision,
    expectedPolicyRevision: plan.expectedPolicyRevision,
    bindingHash: Buffer.from(plan.bindingHashBase64url, "base64url"), keyGeneration: plan.keyGeneration,
    payloadHash: base.crypto.hash(payloadBytes), manifestHash: base.crypto.hash(access.manifestBytes),
    envelopeHash: base.crypto.hash(envelopeBytes), issuedAt: NOW, deadlineAt: plan.expiresAt,
    committerSigningPublicKey: base.currentDevice.signingPublicKey,
    committerSigningPrivateKey: base.signingPrivateKey,
  });
  const upload = { payloadBytes, manifestBytes: access.manifestBytes,
    envelopeBytes, signedPublicationRequestBytes: signed.bytes };
  if (repairOptions.legacyReceipt === true) {
    const authority = Object.freeze({
      authorityVersion: 1 as const,
      kind: "requester_private_namespace" as const,
      keyClass: "ai" as const,
      requesterHumanId: plan.requesterHumanId,
      namespaceId: plan.namespaceId,
      domainId: plan.domainId,
      expectedAccessRevision: plan.expectedAccessRevision,
      expectedPolicyRevision: plan.expectedPolicyRevision,
    });
    const prepared = await authenticatePreparedHistoricalTaskContentCryptoRevisionV1({
      ...upload,
      crypto: base.crypto,
      now: NOW,
      operationId: plan.operationId,
      claimId: plan.claimId,
      coordinate: plan.coordinate,
      authority,
      sourceDigest: legacySourceDigest,
      sourcePayloadHash: Buffer.from(plan.sourcePayloadHashBase64url, "base64url"),
      operationalFieldsDigest: Buffer.from(plan.operationalFieldsDigestBase64url, "base64url"),
      planDigest: Buffer.from(plan.planDigestBase64url, "base64url"),
      resolveCurrentAuthority: () => Promise.resolve(
        base.currentDevice.signingPublicKey.slice(),
      ),
    });
    const handle = await verifyCryptoPostgresHandle(stageConnection);
    await stageHistoricalTaskContentPublication({
      handle,
      crypto: base.crypto,
      prepared,
      currentAuthority: authority,
      assertCurrent: () => {},
      resolveHistoricalAgentSignerAuthority: () => null,
      resolveHistoricalHumanDeviceSigningPublicKey: () => Promise.resolve(
        base.currentDevice.signingPublicKey.slice(),
      ),
    });
    expect(await publication.recover(renewedSubject, plan.claimId)).toBe(true);
  } else if (repairOptions.legacyUploadWithoutReceipt === true) {
    let failure: unknown;
    try {
      await publication.publish(renewedSubject, plan.claimId, upload);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(await objectRowCounts(base, plan.objectId)).toEqual({
      payload: 0, head: 0, manifest: 0, envelope: 0,
    });
  } else if (repairOptions.expireAfterStage === true) {
    // Expiry after independent crypto commit must roll back only product
    // mapping. A fresh admitted device session can reuse the durable copy.
    let failure: unknown;
    try { await publication.publish(subject, plan.claimId, upload); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(repairOptions.now?.()).toBe(NOW + 25_000);
    expect(await base.admin.select({ representation: tasks.contentRepresentation,
      revision: tasks.contentRevision }).from(tasks).where(eq(tasks.id, taskId)))
      .toEqual([{ representation: "ordinary", revision: 0 }]);
    expect(await base.admin.select({ taskId: taskDefinitionCryptoRevisions.taskId })
      .from(taskDefinitionCryptoRevisions).where(eq(taskDefinitionCryptoRevisions.taskId, taskId)))
      .toHaveLength(0);
    expect(await base.admin.select({ objectId: cryptoObjects.objectId }).from(cryptoObjects)
      .where(eq(cryptoObjects.objectId, plan.objectId))).toHaveLength(1);
    expect(await publication.recover(renewedSubject, plan.claimId)).toBe(true);
  } else {
    expect(await publication.publish(renewedSubject, plan.claimId, upload)).toBe(true);
  }
  return plan.objectId;
}

async function createConnectedHistoricalTask(base: BaseFixture, retainedHistoricalError: string | null = null) {
  const taskId = randomUUID();
  const taskRunId = randomUUID();
  const graphThreadId = `subagent:task:${taskId}:${taskRunId}`;
  const requestedModelId = resolveModelRole("chat");
  base.taskIds.add(taskId);
  base.requestIds.add(`task-run-authorization:${taskRunId}`);
  base.requestIds.add(`task-run-delivery-result-authorization:${taskRunId}`);
  base.sessionThreadIds.add(graphThreadId);
  await base.admin.insert(tasks).values({
    id: taskId, ownerId: base.userId, requestorId: base.userId, agentId: base.productAgentId,
    prompt: "Complete the connected protected Task", expectedOutput: null,
    preset: "task", scheduleKind: "now", callingRoomId: base.roomId,
    resultDelivery: "wake", targetChat: "last_in_namespace", targetRoomId: base.roomId,
    targetUserIds: [base.userId], useScope: false, toolsMode: "none",
    fundingMode: "legacy_server", requestedModelId, status: "pending", metadata: {}, lastError: retainedHistoricalError,
  });
  const inputObjectId = await repairHistoricalTaskDefinition(base, taskId, { expectedRetainedHistoricalError: retainedHistoricalError });
  expect(inputObjectId).toMatch(/^task-historical:v1:[0-9a-f]{64}$/u);
  const [mapped] = await base.admin.select({ objectId: tasks.cryptoObjectId,
    revision: tasks.contentRevision, representation: tasks.contentRepresentation,
    prompt: tasks.prompt, status: tasks.status }).from(tasks).where(eq(tasks.id, taskId));
  expect(mapped).toEqual({ objectId: inputObjectId, revision: 1, representation: "dual",
    prompt: "Complete the connected protected Task", status: "pending" });
  const startedAt = new Date(NOW);
  await base.admin.transaction(async tx => {
    // A new occurrence resets the operational error independently of the
    // immutable historical snapshot retained in its encrypted definition.
    await tx.update(tasks).set({ status: "awaiting", lastError: null }).where(eq(tasks.id, taskId));
    await tx.insert(taskRuns).values({ id: taskRunId, taskId, graphThreadId, status: "awaiting", startedAt });
  });
  return Object.freeze({ taskId, taskRunId, graphThreadId, startedAt, inputObjectId,
    resultObjectId: deriveTaskContentCryptoObjectIdV1({ kind: "run_result", taskId, taskRunId, contentRevision: 1 }),
    requestedModelId });
}

async function createConnectedProtectedTask(
  base: BaseFixture,
  options: Readonly<{
    noDelivery?: boolean;
    resultDelivery?: "wake" | "raw" | "raw_and_wake";
    representation?: "protected" | "dual";
    useScope?: boolean;
    fundingMode?: "legacy_server" | "caller";
    requestedModelId?: string;
    tools?: readonly string[];
    metadata?: Readonly<Record<string, unknown>>;
    createLocalExecutionDelegation?(input: Readonly<{
      taskId: string;
      taskRunId: string;
      roomId: string;
      roomGraphThreadId: string;
    }>): Promise<LocalExecutionDelegation>;
  }> = {},
) {
  const representation = options.representation ?? "protected";
  const taskId = randomUUID();
  const taskRunId = randomUUID();
  const graphThreadId = `subagent:task:${taskId}:${taskRunId}`;
  const roomGraphThreadId = `task-memory-writer:${base.roomId}`;
  const localExecutionDelegation =
    await options.createLocalExecutionDelegation?.({
      taskId,
      taskRunId,
      roomId: base.roomId,
      roomGraphThreadId,
    }) ?? null;
  const coordinate = Object.freeze({
    kind: "definition" as const,
    taskId,
    contentRevision: 1,
  });
  const cryptoObjectId = deriveTaskContentCryptoObjectIdV1(coordinate);
  const authority = Object.freeze({
    authorityVersion: 1 as const,
    kind: "requester_private_namespace" as const,
    keyClass: "ai" as const,
    requesterHumanId: base.humanActorId,
    namespaceId: base.namespaceValue,
    domainId: base.domainSecret.domainId,
    expectedAccessRevision: base.namespace.accessRevision,
    expectedPolicyRevision: base.policyRevision,
  });
  const classified = classifyProtectedTaskMetadataV1(options.metadata ?? {});
  if (classified.status !== "supported") {
    throw new Error("Connected protected Task metadata was not supported");
  }
  const encrypted = encryptObjectPayload(base.crypto, {
    objectId: objectId(cryptoObjectId),
    keyClass: "ai",
    objectType: taskContentObjectTypeV1(coordinate),
    createdAt: unixTimestamp(NOW + 10),
  }, encodeTaskPayloadV1({
    formatVersion: 1,
    prompt: "Complete the connected protected Task",
    expectedOutput: null,
    protectedMetadata: classified.protectedContent,
  }));
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  const envelopeBytes = encodeNamespaceObjectEnvelopeV2(
    wrapObjectDekForNamespace(base.crypto, base.namespace.key, {
      objectId: objectId(cryptoObjectId),
      namespaceId: namespaceId(base.namespaceValue),
      keyClass: "ai",
      keyGeneration: base.namespace.keyGeneration,
      bindingRevisionAtWrap: base.namespace.accessRevision,
    }, encrypted.dek),
  );
  encrypted.dek.fill(0);
  const access = prepareHumanObjectAccessManifestGenesisSet(base.crypto, {
    objectId: cryptoObjectId,
    payloadHash: base.crypto.hash(payloadBytes),
    envelopeBytes: [envelopeBytes],
    sourceAuthorized: true,
    targetAuthorized: true,
    subjectHumanId: humanId(base.humanActorId),
    committerDeviceId: cryptoDeviceId(base.deviceId),
    hostAuthorizationRevision: authorizationRevision(
      base.currentDevice.securityRevision,
    ),
    committerSigningPublicKey: base.currentDevice.signingPublicKey,
    committerSigningPrivateKey: base.signingPrivateKey,
  });
  const prepared = createPreparedHumanTaskContentCryptoRevisionV1({
    signerKind: "human_device",
    coordinate,
    authority,
    object: encryptedObjectWriteRecord(payloadBytes),
    access,
  });
  const repository = createDormantTaskContentShadowRepository({
    product: new PostgresTaskContentProductStore(
      base.product.handle,
      () => authority,
    ),
    crypto: createPostgresTaskContentCryptoCompletion({
      handle: base.cryptoHandle,
      crypto: base.crypto,
      resolveCurrentAuthority: () => Promise.resolve(authority),
      resolveHistoricalAgentSignerAuthority: () => null,
      resolveHistoricalHumanDeviceSigningPublicKey: () =>
        Promise.resolve(base.currentDevice.signingPublicKey.slice()),
    }),
  });
  // This fixture exercises protected execution and publication, not the
  // process-global server default. Persist one exact, currently runnable
  // selection so an asynchronous server-config cache refresh from an earlier
  // case cannot change this Task's model between admission and execution.
  const requestedModelId = options.requestedModelId ?? resolveModelRole("chat");
  base.taskIds.add(taskId);
  base.objectIds.add(cryptoObjectId);
  base.requestIds.add(`task-run-authorization:${taskRunId}`);
  base.requestIds.add(`task-run-delivery-result-authorization:${taskRunId}`);
  base.sessionThreadIds.add(graphThreadId);
  expect(await repository.reserveRevision({
    operationId: `connected-task-definition:${taskId}`,
    requestDigest: base.crypto.hash(new TextEncoder().encode(
      `connected-task-definition:${taskId}`,
    )),
    representation,
    authority,
    prepared,
    operationalMetadata: classified.operational,
  })).toMatchObject({ status: "reserved" });
  await base.admin.insert(tasks).values({
    id: taskId,
    ownerId: base.userId,
    requestorId: base.userId,
    agentId: base.productAgentId,
    prompt: representation === "dual" ? "Complete the connected protected Task" : "",
    preset: "in_background",
    scheduleKind: "now",
    callingRoomId: options.noDelivery === true ? null : base.roomId,
    resultDelivery: options.resultDelivery ?? "wake",
    targetChat: "last_in_namespace",
    targetRoomId: base.roomId,
    targetUserIds: [base.userId],
    useScope: options.useScope ?? false,
    toolsMode: options.tools === undefined ? "none" : "whitelist",
    toolsWhitelist: [...(options.tools ?? [])],
    fundingMode: options.fundingMode ?? "legacy_server",
    requestedModelId,
    localExecutionDelegation,
    status: "pending",
    metadata: representation === "dual" ? options.metadata ?? {} : classified.operational,
  });
  expect(await repository.completeRevision({ coordinate, prepared }))
    .toMatchObject({ status: "mapped" });
  const startedAt = new Date(NOW);
  await base.admin.transaction(async tx => {
    await tx.update(tasks).set({ status: "awaiting" })
      .where(eq(tasks.id, taskId));
    await tx.insert(taskRuns).values({
      id: taskRunId,
      taskId,
      graphThreadId,
      status: "awaiting",
      startedAt,
    });
  });
  return Object.freeze({
    taskId,
    taskRunId,
    graphThreadId,
    startedAt,
    inputObjectId: cryptoObjectId,
    resultObjectId: deriveTaskContentCryptoObjectIdV1({
      kind: "run_result",
      taskId,
      taskRunId,
      contentRevision: 1,
    }),
    requestedModelId,
  });
}

async function waitForConnectedCompletion(
  base: BaseFixture,
  taskRunId: string,
  terminalStatus: Promise<void>,
  expectedExecutionSegment?: number,
): Promise<Readonly<{
  run: typeof taskRuns.$inferSelect;
  job: typeof jobs.$inferSelect;
}>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Real crypto and database work has no ten-second product SLA. Wait for
    // the test's durable status sink rather than continuously polling the DB.
    await Promise.race([
      terminalStatus,
      new Promise<void>(resolve => { timer = setTimeout(resolve, 30_000); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const deadline = Date.now() + 10_000;
  let run: typeof taskRuns.$inferSelect | undefined;
  let job: typeof jobs.$inferSelect | undefined;
  while (Date.now() < deadline) {
    [run] = await base.admin.select().from(taskRuns)
      .where(eq(taskRuns.id, taskRunId));
    [job] = run?.jobId ? await base.admin.select().from(jobs)
      .where(eq(jobs.id, run.jobId)) : [];
    const reference = job?.input as Partial<ProtectedTaskJobReferenceV1>
      | undefined;
    if (run !== undefined && job !== undefined
      && ["completed", "failed", "cancelled", "timed_out"].includes(job.status)
      && (expectedExecutionSegment === undefined
        || reference?.executionSegment === expectedExecutionSegment
          && run.completedAt !== null)) {
      return Object.freeze({ run, job });
    }
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Connected protected Task did not settle: ${JSON.stringify({
    runStatus: run?.status, resultRevision: run?.resultRevision,
    resultMapping: run?.resultCryptoMappingState, jobStatus: job?.status,
    jobStarted: job?.startedAt !== null && job?.startedAt !== undefined,
  })}`);
}

async function waitForConnectedRelease(
  base: BaseFixture,
  requestId: string,
  recipients: TaskRuntimeRecipientRegistry,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [request] = await base.admin.select({
      state: backgroundCryptoAuthorizationRequests.state,
    }).from(backgroundCryptoAuthorizationRequests).where(eq(
      backgroundCryptoAuthorizationRequests.requestId,
      requestId,
    ));
    if (request?.state === "completed" && recipients.size === 0) return;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Connected protected Task did not release grant custody");
}

async function loadConnectedDomainSecrets(
  base: BaseFixture,
  requestId: string,
): Promise<readonly DomainForegroundSecretEntry[]> {
  const requirements = await base.admin.select({
    ordinal: backgroundCryptoAuthorizationNamespaceRequirements.ordinal,
    namespaceId:
      backgroundCryptoAuthorizationNamespaceRequirements.namespaceId,
  }).from(backgroundCryptoAuthorizationNamespaceRequirements).where(eq(
    backgroundCryptoAuthorizationNamespaceRequirements.requestId,
    requestId,
  ));
  requirements.sort((left, right) => left.ordinal - right.ordinal);
  const authority = await new PostgresDomainKeyAuthorityRepository(
    base.restricted,
    base.crypto,
    SERVER_SCOPE,
  ).inspectForegroundAuthority({
    namespaceIds: requirements.map(requirement => requirement.namespaceId),
    keyClass: "ai",
    subjectHumanId: base.humanActorId,
    deviceId: base.deviceId,
  });
  if (authority.status !== "ready") {
    throw new Error(
      `Connected protected Task Domain authority unavailable: ${authority.reason}`,
    );
  }
  return Object.freeze(authority.domains.map(domain => {
    if (domain.domainId !== base.domainSecret.domainId) {
      throw new Error("Connected protected Task Domain key is unavailable");
    }
    return Object.freeze({
      domainId: domain.domainId,
      sourceNamespaceId: domain.sourceNamespaceId,
      participantDigest: domain.participantDigest.slice(),
      participantCount: domain.participantCount,
      keyClass: domain.keyClass,
      domainKeyGeneration: domain.domainKeyGeneration,
      authorizationRevision: domain.authorizationRevision,
      headDigest: domain.headDigest.slice(),
      domainKey: base.domainSecret.domainKey.slice(),
    });
  }));
}

function destroyConnectedDomainSecrets(
  domains: readonly DomainForegroundSecretEntry[],
): void {
  for (const domain of domains) {
    domain.participantDigest.fill(0);
    domain.headDigest.fill(0);
    domain.domainKey.fill(0);
  }
}

describePostgres("sealed protected Task Memory object writer", () => {
  test("foreground Task authority binds Device revision independently of MLS security revision", async () => {
    const base = await createBaseFixture();
    const { loadTaskDefinitionAuthority } = await import(
      "../../src/routes/live-shadow-message-composition"
    );
    const request = {
      userId: base.userId,
      humanId: base.humanActorId,
      deviceId: base.deviceId,
      clientActionSessionId: randomUUID(),
      roomId: base.seedRoomId,
      agentId: base.productAgentId,
    };
    const context = {
      crypto: base.crypto,
      serverId: SERVER_SCOPE,
      loadRuntimePolicy: () => Promise.resolve({
        mode: "encrypted_only" as const,
        shadowBehavior: "strict" as const,
        revision: base.policyRevision,
      }),
    };
    const hostRevision = base.currentDevice.securityRevision + 1;
    try {
      await base.admin.update(humanCryptoDevices).set({ revision: hostRevision })
        .where(eq(humanCryptoDevices.deviceId, base.deviceId));
      const current = await new PostgresDeviceAdmissionRepository(
        base.cryptoHandle, base.crypto,
      ).currentAuthorityForDelegation(base.subject);
      expect(current?.securityRevision).toBe(base.currentDevice.securityRevision);
      current?.signingPublicKey.fill(0);
      current?.headDigest.fill(0);
      const snapshot = await loadTaskDefinitionAuthority(request, context);
      try {
        expect(snapshot).not.toBeNull();
        expect(snapshot?.hostAuthorizationRevision).toBe(hostRevision);
        expect(snapshot?.deviceGeneration).toBe(base.currentDevice.deviceGeneration);
        expect(snapshot?.privateRoomId).toBe(base.roomId);
        expect(snapshot?.namespace.namespaceId).toBe(base.namespaceValue);
        expect(snapshot?.namespace.domainId).toBe(base.domainAuthority.domains[0]!.domainId);
        expect(snapshot?.deviceSigningPublicKey).toEqual(base.currentDevice.signingPublicKey);
      } finally {
        snapshot?.deviceSigningPublicKey.fill(0);
        for (const value of Object.values(snapshot?.namespace ?? {})) {
          if (value instanceof Uint8Array) value.fill(0);
        }
        for (const domain of snapshot?.domains ?? []) {
          domain.participantDigest.fill(0);
          domain.headDigest.fill(0);
          domain.activeNamespaceBindingSetDigest.fill(0);
        }
      }
      expect(await loadTaskDefinitionAuthority(request, {
        ...context,
        loadRuntimePolicy: () => Promise.resolve({
          mode: "plaintext_only", shadowBehavior: "fallback", revision: base.policyRevision,
        }),
      })).toBeNull();
      await base.admin.update(humanCryptoDevices).set({ state: "revoked", revokedAt: new Date(NOW) })
        .where(eq(humanCryptoDevices.deviceId, base.deviceId));
      expect(await loadTaskDefinitionAuthority(request, context)).toBeNull();
    } finally {
      await base.cleanup();
    }
  });

  test("foreground Task revalidation borrows the product transaction holding private authority", async () => {
    const base = await createBaseFixture();
    const { loadTaskDefinitionAuthority } = await import(
      "../../src/routes/live-shadow-message-composition"
    );
    type Snapshot = Awaited<ReturnType<typeof loadTaskDefinitionAuthority>>;
    let pending: Promise<Snapshot> | undefined;
    let contender: Promise<boolean | null> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const wipe = (snapshot: Snapshot) => {
      snapshot?.deviceSigningPublicKey.fill(0);
      for (const value of Object.values(snapshot?.namespace ?? {})) {
        if (value instanceof Uint8Array) value.fill(0);
      }
      for (const domain of snapshot?.domains ?? []) {
        domain.participantDigest.fill(0);
        domain.headDigest.fill(0);
        domain.activeNamespaceBindingSetDigest.fill(0);
      }
    };
    try {
      const loaded = await base.product.canonicalRunner.transaction(async (transaction, executor) => {
        const product: PostgresJsBridgeConnection = {
          query: executor.query.bind(executor),
          transaction: use => use(executor),
          transactionOnce: use => use(executor),
        };
        return new PostgresNamespaceProductAuthority(product).withCurrentPrivateRoom({
          subjectUserId: base.userId, subjectHumanId: base.humanActorId,
          roomId: base.roomId, namespaceId: base.namespaceValue,
          use: async () => {
            const [backend] = await transaction.select({ pid: sql<number>`pg_backend_pid()` })
              .from(rooms).where(eq(rooms.id, base.roomId)).limit(1);
            if (backend === undefined) throw new Error("Missing held product transaction");
            contender = new PostgresNamespaceProductAuthority(
              canonicalProductConnection(base.product.canonicalRunner),
            ).withCurrentPrivateRoom({
              subjectUserId: base.userId, subjectHumanId: base.humanActorId,
              roomId: base.roomId, namespaceId: base.namespaceValue,
              use: () => Promise.resolve(true),
            });
            await waitForBlockedContender(base, backend.pid,
              "Separate Task authority transaction did not contend on the held Room/Human lock");
            pending = loadTaskDefinitionAuthority({
              userId: base.userId, humanId: base.humanActorId,
              deviceId: base.deviceId, clientActionSessionId: randomUUID(),
              roomId: base.seedRoomId, agentId: base.productAgentId,
            }, {
              crypto: base.crypto, serverId: SERVER_SCOPE,
              loadRuntimePolicy: () => getEncryptionTransitionPolicy(transaction),
              currentProduct: { transaction, product },
            });
            return Promise.race([pending, new Promise<never>((_, reject) => {
              timeout = setTimeout(() => reject(new Error("Task authority opened a nested product transaction")), 5_000);
            })]);
          },
        });
      }, { isolationLevel: "read committed" });
      expect(loaded).not.toBeNull();
      expect(loaded?.privateRoomId).toBe(base.roomId);
      expect(loaded?.namespace.namespaceId).toBe(base.namespaceValue);
      expect(await contender).toBe(true);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      await contender?.catch(() => null);
      if (pending !== undefined) wipe(await pending.catch(() => null));
      await base.cleanup();
    }
  });

  test("mapped Task proof resolution borrows the held product transaction and closes with its owner", async () => {
    const base = await createBaseFixture();
    type Resolver = NonNullable<Awaited<ReturnType<
      typeof createProtectedTaskDefinitionForegroundAuthorizationResolver
    >>>;
    let retainedResolver: Resolver | undefined;
    let current = true;
    let nestedCheckouts = 0;
    const product = {
      ...base.product,
      canonicalRunner: {
        ...base.product.canonicalRunner,
        transaction: () => {
          nestedCheckouts += 1;
          return Promise.reject(new Error("Nested product checkout"));
        },
      },
    };
    const taskId = randomUUID();
    const input = {
      product, handle: base.cryptoHandle, crypto: base.crypto,
      requesterHumanId: base.humanActorId,
      task: {
        id: taskId, ownerId: base.userId, agentId: base.productAgentId,
        contentNamespaceId: base.namespaceValue,
        cryptoObjectId: `task-definition:v1:${taskId}`, contentRevision: 1,
      },
    };
    try {
      await base.product.canonicalRunner.transaction(async (transaction, executor) => {
        const heldProduct: PostgresJsBridgeConnection = {
          query: executor.query.bind(executor),
          transaction: use => use(executor),
          transactionOnce: use => use(executor),
        };
        await new PostgresNamespaceProductAuthority(heldProduct).withCurrentPrivateRoom({
          subjectUserId: base.userId, subjectHumanId: base.humanActorId,
          roomId: base.roomId, namespaceId: base.namespaceValue,
          use: async () => {
            const resolver = await createProtectedTaskDefinitionForegroundAuthorizationResolver({
              ...input,
              currentProduct: {
                transaction, product: heldProduct,
                assertCurrent: () => {
                  if (!current) throw new TypeError("Mapped Task owner is closed");
                },
              },
            });
            expect(resolver).not.toBeNull();
            if (resolver === null) throw new Error("Missing retained Task resolver");
            retainedResolver = resolver;
          },
        });
      }, { isolationLevel: "read committed" });
      current = false;
      expect(nestedCheckouts).toBe(0);
      if (retainedResolver === undefined) throw new Error("Task resolver was not retained");
      // The owner must reject before parsing or reading any retained proof.
      await rejects(retainedResolver({} as Parameters<Resolver>[0]),
        /Mapped Task owner is closed/);
      // Detached callers still use their existing canonical transaction owner.
      await rejects(createProtectedTaskDefinitionForegroundAuthorizationResolver(input),
        /Nested product checkout/);
      expect(nestedCheckouts).toBe(1);
    } finally {
      current = false;
      await base.cleanup();
    }
  });

  test("held Task authority permits usage attribution while excluding Task mutation", async () => {
    const base = await createBaseFixture();
    const rollback = new Error("Rollback lock compatibility probe");
    type ProbeTx = Parameters<Parameters<typeof base.admin.transaction>[0]>[0];
    const probe = async (use: (tx: ProbeTx) => Promise<unknown>) => {
      try {
        await base.admin.transaction(async tx => {
          await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
          await use(tx);
          throw rollback;
        });
      } catch (error) {
        if (error === rollback) return "applied";
        let cause: unknown = error;
        for (let depth = 0; depth < 4 && cause instanceof Error; depth += 1) {
          const code = (cause as { code?: unknown }).code;
          if (typeof code === "string") return code;
          cause = cause.cause;
        }
        throw error;
      }
      throw new Error("Lock compatibility probe did not roll back");
    };
    try {
      const scenario = await createScenario(base);
      expect(await scenario.withAuthority(() => NOW + 5, ({ writer }) =>
        withCurrentProtectedTaskMemoryAuthority(writer, async () => {
          // Real FK checks take KEY SHARE on Room and Task. Neither this insert
          // nor a blocked mutation may escape its rollback-only transaction.
          expect(await probe(async tx => tx.insert(llmUsageEvents).values({
            userId: base.userId, roomId: base.seedRoomId, taskId: scenario.taskId,
            provider: "lock-probe", model: "lock-probe", callType: "subagent",
          }))).toBe("applied");
          expect(await probe(async tx => tx.update(tasks).set({ status: "paused" })
            .where(eq(tasks.id, scenario.taskId)))).toBe("55P03");
          expect(await probe(async tx => tx.delete(tasks)
            .where(eq(tasks.id, scenario.taskId)))).toBe("55P03");
          return true;
        }),
      )).toBe(true);
      expect(await base.admin.select({ id: llmUsageEvents.id }).from(llmUsageEvents)
        .where(eq(llmUsageEvents.taskId, scenario.taskId))).toEqual([]);
    } finally {
      await base.cleanup();
    }
  });

  test("transcript admission locks Task before a Session can retain its Room", async () => {
    const base = await createBaseFixture();
    const reachedCryptoAdmission = new Error("Transcript admission reached crypto verification");
    type TranscriptSegment = Parameters<ReturnType<
      typeof createProtectedTaskNativeTranscriptPublisher
    >>[0];
    let contender: Promise<unknown> | undefined;
    try {
      const scenario = await createScenario(base);
      const createTranscript = createProtectedTaskNativeTranscriptPublisher({
        product: base.product,
      }, {
        verifyCryptoHandle: () => Promise.reject(reachedCryptoAdmission),
      });
      await base.product.canonicalRunner.transaction(async tx => {
        await acquireEncryptionConsumptionFence(tx);
        const [heldTask] = await tx.select({
          id: tasks.id,
          pid: sql<number>`pg_backend_pid()`,
        }).from(tasks).where(eq(tasks.id, scenario.taskId))
          .limit(1).for("no key update");
        if (heldTask === undefined) throw new Error("Task lock fixture is unavailable");
        contender = scenario.withAuthority(() => NOW + 5, ({ writer }) =>
          Promise.resolve(createTranscript(Object.freeze({
            occurrence: writer.occurrence,
            record: writer.record,
            request: writer.request,
            current: writer,
            policy: Object.freeze({
              mode: "encrypted_only" as const,
              shadowBehavior: "strict" as const,
              revision: base.policyRevision,
            }),
            humanTurnId: `task-segment-turn:${scenario.taskRunId}:1`,
            assertCurrentTaskAuthority: () => Promise.resolve(),
            domains: Object.freeze([]),
            signer: Object.freeze({}),
            resolveHistoricalSignerPublicationManager: () => Promise.resolve(null),
          }) as unknown as TranscriptSegment)));
        void contender.catch(() => undefined);
        await waitForBlockedContender(base, heldTask.pid,
          "Transcript admission did not wait for the held Task");
        const [heldRoom] = await tx.select({ id: rooms.id }).from(rooms)
          .where(eq(rooms.id, base.roomId)).limit(1)
          .for("update", { noWait: true });
        expect(heldRoom?.id).toBe(base.roomId);
      }, { isolationLevel: "read committed" });
      if (contender === undefined) throw new Error("Transcript contender was not started");
      await rejects(contender, cause => cause === reachedCryptoAdmission);
    } finally {
      await contender?.catch(() => undefined);
      await base.cleanup();
    }
  });

  test("concurrent protected projections retain shared Agent identity without lock upgrade", async () => {
    const base = await createBaseFixture({ connectedExecution: true });
    const peerUserId = randomUUID();
    const peerActorId = randomUUID();
    try {
      await base.admin.insert(users).values({ id: peerUserId, name: "Projection lock peer" });
      await base.admin.insert(actors).values({ id: peerActorId, ownerId: peerUserId,
        kind: "user", trustState: "verified", displayName: "Projection lock peer" });
      const [owners] = await base.admin.select({ id: groups.id }).from(groups)
        .where(eq(groups.type, "owners")).limit(1);
      if (owners === undefined) throw new Error("Missing owners Group");
      await base.admin.insert(groupMembers).values({ groupId: owners.id,
        userId: peerUserId, grantedBy: base.humanActorId });
      await base.admin.delete(roomMembers).where(and(
        eq(roomMembers.roomId, base.seedRoomId), eq(roomMembers.actorId, base.humanActorId),
      ));
      await base.admin.insert(roomMembers).values({ roomId: base.seedRoomId,
        actorId: peerActorId, roomRole: "admin" });
      const [sharedAgent] = await base.admin.select({ id: actors.id }).from(actors)
        .where(eq(actors.agentId, base.productAgentId)).limit(1);
      if (sharedAgent === undefined) throw new Error("Missing fixture Agent Actor");
      const barrier = deferred();
      let entered = 0;
      const project = async (roomId: string, requesterActorId: string, userId: string) => {
        const [room] = await base.admin.select().from(rooms).where(eq(rooms.id, roomId));
        if (room === undefined) throw new Error("Missing fixture Room");
        const members = await base.admin.select({ actorId: actors.id, kind: actors.kind,
          ownerId: actors.ownerId }).from(roomMembers)
          .innerJoin(actors, eq(actors.id, roomMembers.actorId))
          .where(eq(roomMembers.roomId, roomId)).orderBy(actors.kind, actors.ownerId, actors.id);
        const audienceFingerprint = fingerprintProjectionAudience(roomId, members
          .map(member => `${member.kind}:${member.ownerId}:${member.actorId}`).join("\n"));
        return base.admin.transaction(async transaction => {
          await transaction.execute(sql`SET LOCAL lock_timeout = '3s'`);
          await transaction.select().from(actors).where(eq(actors.id, sharedAgent.id)).for("share");
          entered += 1;
          if (entered === 2) barrier.resolve();
          await barrier.promise;
          return lockAtomicProjectionDestinationAuthority(transaction, {
            roomId, namespaceId: room.namespaceId, roomLabel: room.label,
            roomKind: room.kind, requesterActorId, userId, audienceFingerprint,
          }, { actorIdentityLock: "share" });
        });
      };
      expect(await Promise.all([
        project(base.roomId, base.humanActorId, base.userId),
        project(base.seedRoomId, peerActorId, peerUserId),
      ])).toEqual([null, null]);
    } finally {
      await base.admin.delete(roomMembers).where(eq(roomMembers.actorId, peerActorId));
      await base.admin.delete(groupMembers).where(eq(groupMembers.userId, peerUserId));
      await base.admin.delete(actors).where(eq(actors.id, peerActorId));
      await base.admin.delete(users).where(eq(users.id, peerUserId));
      await base.cleanup();
    }
  });

  test.each([
    { label: "Full mapped source", mode: "encrypted_only", shadowBehavior: "strict", ordinary: false },
    { label: "Full ordinary source rejected", mode: "encrypted_only", shadowBehavior: "strict", ordinary: true },
    { label: "Strict Shadow repaired source", mode: "shadow_encryption", shadowBehavior: "strict", ordinary: true },
    { label: "Fallback Shadow repaired source", mode: "shadow_encryption", shadowBehavior: "fallback", ordinary: true },
  ] as const)("reserves an empty exact access destination under current Task authority: $label", async policyCase => {
    const base = await createBaseFixture();
    const recipientUserId = randomUUID();
    const recipientActorId = randomUUID();
    const recipientHandle = `task-access-${recipientUserId}`;
    const createdDestinations: Array<{ roomId: string; namespaceId: string }> = [];
    try {
      await base.admin.insert(users).values({
        id: recipientUserId, name: "Task sharing recipient", handle: recipientHandle,
      });
      await base.admin.insert(actors).values({
        id: recipientActorId, ownerId: recipientUserId, kind: "user",
        trustState: "verified", displayName: "Task sharing recipient",
      });
      const policy = { mode: policyCase.mode, shadowBehavior: policyCase.shadowBehavior };
      if (policy.mode === "shadow_encryption") {
        await base.admin.update(encryptionTransitionPolicy).set({
          ...policy, revision: base.policyRevision,
          shadowEncryptionStartedAt: new Date(NOW), updatedAt: new Date(NOW + 1),
        }).where(eq(encryptionTransitionPolicy.id, "server"));
      }
      const scenario = await createScenario(base, {
        contentRepresentation: policy.mode === "shadow_encryption" ? "dual" : "protected",
      });
      const authority: ProtectedMemoryAuthority = Object.freeze({
        mode: "namespace", subjectUserId: base.userId, agentId: base.productAgentId,
        readableNamespaceIds: [base.namespaceValue],
        mutableNamespaceIds: [base.namespaceValue],
        writableNamespaceId: base.namespaceValue,
      });
      const withRepository = <Value>(execute: (
        repository: ProtectedAgentMemoryRepository,
        access: ProtectedTaskMemoryAccessHandoff,
      ) => Promise<Value>) => scenario.withAuthority(() => NOW + 5,
        ({ writer }) => withProtectedTaskNativeMemoryRepository({
          authority,
          policy: { ...policy, revision: base.policyRevision },
          current: writer,
          domains: [scenario.domainSecret],
          signer: { agentAuthorizationRevision: 7, runtime: base.runtime.runtime,
            signerPublication: base.runtime.signerPublication },
          resolveHistoricalSignerPublicationManager: () => base.currentDevice.signingPublicKey,
          product: base.product,
          agentProduct: base.agentProduct,
          owner: bindEncryptionDataOperationOwner({ policy: {
            resolve: async () => ({ policy, revalidationToken: base.policyRevision }),
            revalidate: async token => {
              if (token !== base.policyRevision) throw new Error("Task policy changed");
            },
          } }),
          embedding: { embed: async () => ({ status: "success" as const, value: {
            vector: new Array<number>(1536).fill(0.25), provider: "openai" as const,
            canonicalModel: "text-embedding-3-small", dimensions: 1536 as const,
            contractVersion: 1,
          } }) },
          execute: (repository, _projection, access) => execute(repository, access),
        }));
      const sourceContent = `Task access private content ${randomUUID()}`;
      const ordinaryMemoryId = randomUUID();
      if (policyCase.ordinary) {
        base.memoryIds.add(ordinaryMemoryId);
        await base.admin.insert(memories).values({
          id: ordinaryMemoryId, type: "fact", content: sourceContent,
          importance: 0.8, tier: 1, embedding: new Array<number>(1536).fill(0.25),
          embeddingRevision: 0, embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small", embeddingDimensions: 1536,
          embeddingContractVersion: 1,
        });
        await base.admin.insert(memoryNamespaces).values({
          memoryId: ordinaryMemoryId, namespaceId: base.namespaceValue,
        });
      }
      const saved = policyCase.ordinary
        ? { status: "success" as const, value: { id: ordinaryMemoryId } }
        : await withRepository(repository => repository.save({
            operationId: `task-access-source:${randomUUID()}`, authority,
            type: "fact", content: sourceContent, importance: 0.8,
          }));
      if (saved.status !== "success") throw new Error("Task access source save failed");
      base.memoryIds.add(saved.value.id);
      base.objectIds.add(deriveMemoryCryptoObjectIdV1({
        memoryId: saved.value.id, contentRevision: 1,
      }));
      const request = { operationId: `task-access-share:${randomUUID()}`,
        toolCallId: `share:${randomUUID()}`, authority, memoryId: saved.value.id,
        action: { kind: "grant_user" as const, userHandle: recipientHandle } };
      const prepared = await withRepository((_repository, access) => access.prepareApproval(request));
      const [sourceMapping] = await base.admin.select({
        revision: memories.contentRevision, mapping: memories.cryptoMappingState,
        objectId: memories.cryptoObjectId, content: memories.content,
      }).from(memories).where(eq(memories.id, saved.value.id));
      if (policyCase.ordinary && policy.mode === "encrypted_only") {
        expect(prepared.status).toBe("unavailable");
        expect(sourceMapping).toEqual({ revision: 0, mapping: "unmapped",
          objectId: null, content: sourceContent });
        return;
      }
      expect(sourceMapping).toMatchObject({ revision: 1, mapping: "verified",
        objectId: deriveMemoryCryptoObjectIdV1({ memoryId: saved.value.id, contentRevision: 1 }) });
      if (policyCase.ordinary) expect(sourceMapping?.content).toBe(sourceContent);
      if (prepared.status !== "success") {
        throw new Error(`Task access approval failed: ${prepared.reason}`);
      }
      expect(prepared.value.preview).toEqual({ type: "fact", content: sourceContent });
      expect(prepared.value.reference.taskContinuation?.sealedPreparation)
        .not.toContain(sourceContent);
      const reference = JSON.parse(JSON.stringify(prepared.value.reference)) as
        typeof prepared.value.reference;
      const restored = await withRepository((_repository, access) => access.restoreApproval({
        authority, reference, memoryId: request.memoryId, action: request.action,
      }));
      expect(restored).toEqual({ status: "success", value: prepared.value.preview });
      expect((await withRepository((_repository, access) => access.restoreApproval({
        authority, reference, memoryId: request.memoryId,
        action: { kind: "grant_user", userHandle: "substituted-recipient" },
      }))).status).toBe("unavailable");
      const audience = Object.freeze({
        requesterUserId: base.userId,
        requesterActorId: base.humanActorId,
        humanActorIds: Object.freeze([base.humanActorId, recipientActorId]),
      });
      const reserve = (now: number, requested = audience) => scenario.withAuthority(
        () => now,
        ({ writer }) => resolveProtectedTaskContentAccessNamespace(writer, requested),
      );
      const find = () => scenario.withAuthority(() => NOW + 5,
        ({ writer }) => findProtectedTaskContentAccessNamespace(writer, audience));
      expect(await find()).toBeNull();
      expect(await reserve(NOW + 5, {
        ...audience, requesterUserId: recipientUserId,
      })).toBeNull();
      const expired = await reserve(EXPIRES_AT).then(
        value => value === null,
        () => true,
      );
      expect(expired).toBe(true);
      const destination = await reserve(NOW + 5);
      if (destination === null) throw new Error("Current Task access reservation failed");
      createdDestinations.push(destination);
      expect(destination.minted).toBe(true);
      expect(await reserve(NOW + 5)).toEqual({ ...destination, minted: false });
      expect(await find()).toEqual({
        roomId: destination.roomId, namespaceId: destination.namespaceId,
      });
      const planned = await withRepository((_repository, access) => access.planChange({
        ...request, approvalReference: reference,
      }));
      expect(planned.status).toBe("success");
      if (planned.status === "success") {
        expect(planned.value.kind).toBe("additional_authority_v1");
        expect(planned.value.semanticAuthorityRequirements).toContainEqual({
          namespaceId: destination.namespaceId, operations: ["encrypt"],
        });
      }
      const [room] = await base.admin.select({
        kind: rooms.kind, humanActorIds: rooms.humanActorIds,
      }).from(rooms).where(eq(rooms.id, destination.roomId));
      expect(room).toEqual({
        kind: "access", humanActorIds: [...audience.humanActorIds].sort(),
      });
      const members = await base.admin.select({ actorId: roomMembers.actorId })
        .from(roomMembers).where(eq(roomMembers.roomId, destination.roomId));
      expect(members.map(member => member.actorId).sort())
        .toEqual([...audience.humanActorIds].sort());
      expect(await base.admin.select({ id: memoryNamespaces.memoryId })
        .from(memoryNamespaces).where(eq(memoryNamespaces.namespaceId,
          destination.namespaceId))).toEqual([]);
      expect(await base.admin.select({ id: objectCryptoNamespaceEnvelopes.objectId })
        .from(objectCryptoNamespaceEnvelopes).where(eq(
          objectCryptoNamespaceEnvelopes.namespaceId, destination.namespaceId,
        ))).toEqual([]);
      const heldAudience = await scenario.withAuthority(() => NOW + 5,
        ({ writer }) => withCurrentProtectedTaskMemoryAuthority(writer, async held => {
          expect(await assertHeldProtectedTaskContentAccessNamespace(
            held, audience, destination,
          )).toBe(true);
          const lockError = await base.admin.select({ id: users.id }).from(users)
            .where(eq(users.id, recipientUserId)).for("update", { noWait: true })
            .then(() => null, (error: unknown) => {
              const cause = error instanceof Error && error.cause !== undefined
                ? error.cause : error;
              return typeof cause === "object" && cause !== null && "code" in cause
                ? cause.code : null;
            });
          expect(lockError).toBe("55P03");
          return true;
        }));
      expect(heldAudience).toBe(true);
      await base.admin.update(users).set({ disabledAt: new Date(NOW) })
        .where(eq(users.id, recipientUserId));
      const disabled = await reserve(NOW + 5).then(
        value => value === null,
        () => true,
      );
      expect(disabled).toBe(true);
    } finally {
      try {
        for (const destination of createdDestinations) {
          await base.admin.delete(roomMembers).where(eq(roomMembers.roomId, destination.roomId));
          await base.admin.delete(rooms).where(eq(rooms.id, destination.roomId));
          await base.admin.delete(namespaces).where(eq(namespaces.id, destination.namespaceId));
        }
        await base.admin.delete(actors).where(eq(actors.id, recipientActorId));
        await base.admin.delete(users).where(eq(users.id, recipientUserId));
      } finally {
        await base.cleanup();
      }
    }
  });

  test("serializes protected Job terminal writers and start against cancellation", async () => {
    const base = await createBaseFixture({ connectedExecution: true });
    try {
      const connected = await createConnectedProtectedTask(base);
      const reference = {
        kind: "protected_task_run_v1" as const,
        taskId: connected.taskId,
        taskRunId: connected.taskRunId,
        inputObjectId: connected.inputObjectId,
        resultObjectId: connected.resultObjectId,
        authorizationRequestId: `task-run-authorization:${connected.taskRunId}`,
        policyRevision: base.policyRevision,
        executionSegment: 1,
      };
      const publicationPolicy = {
        expectedRevision: base.policyRevision,
        representation: "protected_only" as const,
      };
      const persist = async () => {
        const jobId = await persistJobWithDatabase(base.productDb, {
          ownerId: base.userId,
          requestorId: base.userId,
          laneKey: `task:${connected.taskId}`,
          type: "foreground",
          input: reference,
          publicationPolicy,
        });
        base.jobIds.add(jobId);
        // Model the canonical Task start commit before crossing the Job fence.
        // A merely queued, unattached Job is deliberately not executable.
        await base.admin.update(tasks).set({ status: "running" })
          .where(eq(tasks.id, connected.taskId));
        await base.admin.update(taskRuns).set({ status: "running", jobId })
          .where(and(eq(taskRuns.id, connected.taskRunId),
            eq(taskRuns.taskId, connected.taskId)));
        return jobId;
      };
      const runningId = await persist();
      expect(await startProtectedTaskJobWithDatabase(
        base.productDb, runningId, reference, publicationPolicy,
      )).toBe("started");
      const outcomes = await Promise.all(
        (["completed", "failed", "cancelled"] as const).map(requested =>
          settleProtectedTaskJobTerminalWithDatabase(
            base.productDb, runningId, reference, requested, publicationPolicy,
          )),
      );
      const winners = outcomes.filter(outcome => outcome.kind === "transitioned");
      expect(winners).toHaveLength(1);
      const winner = winners[0]!;
      if (winner.kind !== "transitioned") throw new Error("Missing terminal winner");
      expect(outcomes.filter(outcome => outcome.kind === "existing_terminal"))
        .toEqual([
          { kind: "existing_terminal", status: winner.status },
          { kind: "existing_terminal", status: winner.status },
        ]);
      const [durable] = await base.admin.select({
        status: jobs.status, result: jobs.result, message: jobs.message,
        startedAt: jobs.startedAt, completedAt: jobs.completedAt,
      }).from(jobs).where(eq(jobs.id, runningId));
      expect(durable).toMatchObject({ status: winner.status, result: null, message: null });
      expect(durable?.startedAt).toBeInstanceOf(Date);
      expect(durable?.completedAt).toBeInstanceOf(Date);

      const queuedId = await persist();
      const [start, cancel] = await Promise.all([
        startProtectedTaskJobWithDatabase(
          base.productDb, queuedId, reference, publicationPolicy,
        ),
        settleProtectedTaskJobTerminalWithDatabase(
          base.productDb, queuedId, reference, "cancelled", publicationPolicy,
        ),
      ]);
      expect(["started", "rejected"]).toContain(start);
      expect(cancel).toEqual({ kind: "transitioned", status: "cancelled" });
      expect(await startProtectedTaskJobWithDatabase(
        base.productDb, queuedId, reference, publicationPolicy,
      )).toBe("rejected");
      const [cancelled] = await base.admin.select({
        status: jobs.status, startedAt: jobs.startedAt,
        completedAt: jobs.completedAt, result: jobs.result, message: jobs.message,
      }).from(jobs).where(eq(jobs.id, queuedId));
      expect(cancelled).toMatchObject({ status: "cancelled", result: null, message: null });
      expect(cancelled?.completedAt).toBeInstanceOf(Date);
      if (start === "started") expect(cancelled?.startedAt).toBeInstanceOf(Date);
      else expect(cancelled?.startedAt).toBeNull();
    } finally {
      await base.cleanup();
    }
  }, 60_000);

  const genuineRoleScenarios = ["result", "Deep Research Full", "Deep Research Shadow", "Deep Research v2 Full", "Deep Research v2 Shadow", "Codex Full", "Codex Shadow", "Hermes Full", "Hermes Shadow", "OpenCode Full", "OpenCode Shadow", "historical repaired definition", "historical repaired definition Full", "historical repaired error definition", "historical repaired error definition Full", "historical checkpoint pause resume", "scoped result", "caller funded delegated local", "fresh result read", "fresh raw Message publication", "recurring encrypted occurrences", "raw staging compatible-policy restart", "wake foreground full", "wake foreground shadow", "wake projection grant resume", "wake projection rollback recovery", "parked continuation", "checkpoint pause resume", "checkpoint policy refresh resume", "grant refresh resume", "attachment recovery", "publication recovery", "unmapped recovery", "unmapped expired grant recovery", "missing ciphertext recovery", "pre-execution recovery", "abandoned running recovery", "cancellation recovery", "cancellation terminal message", "cancellation terminal message shadow", "cancellation publication archive serialization", "cancellation settlement archive serialization", "cancellation settlement product rollback recovery", "cancellation archive-first denial", "linked cancellation"] as const;
  const executeGenuineRoleScenario = async (
    scenario: (typeof genuineRoleScenarios)[number],
  ) => {
    const historicalDefinitionError = scenario === "historical repaired error definition"
      || scenario === "historical repaired error definition Full";
    const historicalDefinitionFull = scenario === "historical repaired definition Full"
      || scenario === "historical repaired error definition Full";
    const historicalCheckpointPauseResume = scenario ===
      "historical checkpoint pause resume";
    const historicalDefinition = scenario === "historical repaired definition"
      || historicalDefinitionFull || historicalCheckpointPauseResume || historicalDefinitionError;
    const deepResearchV2 = scenario === "Deep Research v2 Full" || scenario === "Deep Research v2 Shadow";
    const deepResearchShadow = scenario === "Deep Research Shadow" || scenario === "Deep Research v2 Shadow";
    const deepResearch = scenario === "Deep Research Full" || deepResearchShadow || deepResearchV2;
    const protectedCodex = scenario === "Codex Full" || scenario === "Codex Shadow";
    const protectedCodexShadow = scenario === "Codex Shadow";
    const protectedAcpProvider = scenario.startsWith("Hermes ")
      ? "hermes" as const
      : scenario.startsWith("OpenCode ")
        ? "opencode" as const
        : null;
    const protectedAcpShadow = scenario === "Hermes Shadow"
      || scenario === "OpenCode Shadow";
    const protectedExternal = protectedCodex || protectedAcpProvider !== null;
    const protectedExternalResultText = protectedCodex
      ? "Connected protected Codex result"
      : protectedAcpProvider === null
        ? "Connected protected result"
      : `Connected protected ${protectedAcpProvider === "hermes" ? "Hermes" : "OpenCode"} result`;
    const researchModel = resolveModelRole("chat");
    const researchModelPlan = Object.freeze({ version: 1 as const,
      supervisorModel: researchModel, researchModel, summarizationModel: researchModel,
      compressionModel: researchModel, finalReportModel: researchModel });
    const researchLaneFunding = Object.freeze({ kind: "server" as const, providerRoute: "openrouter" });
    const researchOperational = { modelPlan: researchModelPlan, invokingModelId: researchModel };
    const researchV2Funding = {
      preferenceRevisions: { supervisor: 2, research: 3, summarization: 4, compression: 5, finalReport: 6 },
      modelFunding: { supervisor: researchLaneFunding, research: researchLaneFunding,
        summarization: researchLaneFunding, compression: researchLaneFunding, finalReport: researchLaneFunding },
      tavilyFunding: { kind: "server" as const, providerRoute: "tavily" },
    };
    const researchMetadata = deepResearchV2
      ? admittedDeepResearchTaskMetadata({ reportLanguage: "Portuguese", ...researchOperational, ...researchV2Funding })
      : deepResearchTaskMetadata({ reportLanguage: "Portuguese", ...researchOperational });
    const researchStreamCalls: unknown[][] = [];
    const researchEvents: unknown[] = [];
    const onResearchEvent: Parameters<typeof eventBus.on>[0] = event => { researchEvents.push(event); };
    const scopedResult = scenario === "scoped result";
    const callerLocalExecution = scenario === "caller funded delegated local";
    const unmappedRecovery = scenario === "unmapped recovery"
      || scenario === "unmapped expired grant recovery";
    const missingCiphertextRecovery = scenario === "missing ciphertext recovery";
    const cancellationArchivePhase = scenario ===
        "cancellation publication archive serialization"
      ? "publication" as const
      : scenario === "cancellation settlement archive serialization"
        ? "settlement" as const
        : null;
    const cancellationProductRollback = scenario ===
      "cancellation settlement product rollback recovery";
    const cancellationTerminalShadow = scenario ===
      "cancellation terminal message shadow";
    const cancellationTerminalMessage = scenario ===
      "cancellation terminal message" || cancellationTerminalShadow;
    const freshResultRead = scenario === "fresh result read";
    const checkpointPolicyRefreshResume = scenario ===
      "checkpoint policy refresh resume";
    const checkpointPauseResume = scenario === "checkpoint pause resume"
      || checkpointPolicyRefreshResume || historicalCheckpointPauseResume;
    const grantRefreshResume = scenario === "grant refresh resume";
    const checkpointContinuationScenario = checkpointPauseResume
      || grantRefreshResume;
    const continuedExecution = scenario === "parked continuation"
      || checkpointContinuationScenario;
    const rawStagingCompatiblePolicyRestart = scenario ===
      "raw staging compatible-policy restart";
    const recurringEncryptedOccurrences = scenario ===
      "recurring encrypted occurrences";
    const wakeForegroundShadow = scenario === "wake foreground shadow";
    const wakeProjectionRollback = scenario === "wake projection rollback recovery";
    const wakeProjectionContinuation = scenario === "wake projection grant resume" || wakeProjectionRollback;
    const wakeForegroundScenario = scenario === "wake foreground full"
      || wakeForegroundShadow || wakeProjectionContinuation;
    const freshRawMessagePublication = scenario ===
      "fresh raw Message publication" || rawStagingCompatiblePolicyRestart
      || wakeForegroundScenario || recurringEncryptedOccurrences;
    const freshOutputRead = freshResultRead || freshRawMessagePublication
      || protectedExternal;
    const liveOutputClock = cancellationTerminalMessage || freshOutputRead
      || wakeForegroundScenario;
    const cancellationArchiveScenario = cancellationArchivePhase !== null
      || cancellationProductRollback
      || cancellationTerminalMessage
      || scenario === "cancellation archive-first denial";
    if (cancellationArchiveScenario || freshOutputRead) {
      NOW = Date.now();
      EXPIRES_AT = NOW + 60_000;
    }
    let recoveryNow = NOW;
    const base = await createBaseFixture({ connectedExecution: true,
      ...(liveOutputClock ? { cryptoNow: Date.now }
        : grantRefreshResume ? { cryptoNow: () => recoveryNow } : {}),
    });
    const recipients = new TaskRuntimeRecipientRegistry(base.crypto, {
      now: liveOutputClock ? Date.now
        : grantRefreshResume ? () => recoveryNow : () => NOW,
    });
    const cancellationGate = cancellationArchivePhase === null
      ? null
      : gateProtectedTaskCancellationAuthority(
          cancellationArchivePhase === "publication" ? 1 : 2,
        );
    const cancellationRollbackAuthority = cancellationProductRollback
      ? failProtectedTaskCancellationAuthorityAfterCallback(2)
      : null;
    let testError: unknown;
    let cleanupError: unknown;
    let connected: Awaited<ReturnType<
      typeof createConnectedProtectedTask
    >> | null = null;
    let connectedJobId: string | null = null;
    let parkedPriorJobId: string | null = null;
    let jobManager: JobManager | null = null;
    const recurringObserver: { current: TaskObserver | null } = {
      current: null,
    };
    let closeComposition: (() => Promise<void>) | null = null;
    let callerFunding: Awaited<ReturnType<
      typeof installSyntheticPersonalOpenRouter
    >> | null = null;
    const delegatedLocal: {
      current: ConnectedDelegatedLocalExecutionFixture | null;
    } = { current: null };
    const projectionRollback: { current: ReturnType<typeof installForegroundProjectionProductRollback> | null } = { current: null };
    const projectionCiphertextHash: { current: Uint8Array | null } = { current: null };
    let projectionRollbackRecovered = false;
    const wakeProjectionRoomLabel = `Task wake projection ${base.roomId}`;
    const codexProfileId = randomUUID();
    const codexModelId = "gpt-5";
    const codexReadiness = protectedCodex ? Object.freeze({
      relayId: `protected-codex-relay-${codexProfileId}`,
      pairingGenerationRef: `protected-codex-pairing-${codexProfileId}`,
      capabilityRevision: 3,
    }) : null;
    const codexMetadata = codexReadiness === null ? null : Object.freeze({
        execution: Object.freeze({
          version: 1,
          harnessId: "codex",
          source: "genie",
          collaborationMode: "work",
          harnessModelId: codexModelId,
          readiness: codexReadiness,
        }),
      });
    const codexCalls: string[] = [];
    const codexBindingIds: string[] = [];
    const codexPartitionIdentities: Array<Readonly<{
      relayId: string;
      bindingId: string;
      bindingGeneration: number;
      taskId: string;
      jobId: string;
    }>> = [];
    const acpReadiness = protectedAcpProvider === null ? null : Object.freeze({
      relayId: `protected-${protectedAcpProvider}-relay`,
      relaySessionId: `protected-${protectedAcpProvider}-socket`,
      pairingGenerationRef: `protected-${protectedAcpProvider}-pairing`,
      desktopSessionId: `protected-${protectedAcpProvider}-desktop`,
      selectedProtocolVersion: protectedAcpProvider === "hermes"
        ? ACP_RELAY_PROTOCOL_VERSION
        : OPENCODE_ACP_RELAY_PROTOCOL_VERSION,
      capabilityRevision: 3,
    });
    const acpMetadata: Readonly<Record<string, unknown>> | null =
      protectedAcpProvider === null || acpReadiness === null
        ? null
        : Object.freeze({
            execution: Object.freeze({
              version: 1,
              harnessId: protectedAcpProvider === "hermes"
                ? "hermes-acp"
                : "opencode-acp",
              source: "genie",
              ...(protectedAcpProvider === "opencode"
                ? { executionProfile: "autonomous" as const }
                : {}),
              readiness: acpReadiness,
            }),
          });
    const acpProcess: AcpProcessScope = Object.freeze({
      connectionId: `protected-${protectedAcpProvider ?? "unused"}-connection`,
      processGeneration: 1,
      acpSessionId: `protected-${protectedAcpProvider ?? "unused"}-session`,
      turnGeneration: 1,
      turnRef: `protected-${protectedAcpProvider ?? "unused"}-turn`,
    });
    const acpCalls: string[] = [];
    const acpPrompts: string[] = [];
    const acpScopes: AcpExecutionScope[] = [];
    const acpAcknowledgements: Array<Readonly<{
      eventId: string;
      eventSequence: number;
    }>> = [];
    let acpCloseCalls = 0;
    let acpContainCalls = 0;
    let acpMinted = 0;
    let acpEvents: Array<RelayAcpSemanticEvent | RelayAcpTerminalEvent> = [];
    let acpCursor = 0;
    const produceAcpEvents = async (
      registrationId: "hermes-acp" | "opencode-acp",
      scope: AcpExecutionScope,
    ): Promise<void> => {
      let sequence = 1;
      const capabilities = { requests: "unsupported" as const };
      const truth = validateAcpInitializeCapabilityTruth({
        protocolVersion: 1,
        agentCapabilities: {},
      });
      const producer = new AcpSemanticRelay({
        scope: Object.freeze({
          ...scope.socket,
          ...scope.binding,
          ...scope.workspace,
        }),
        process: acpProcess,
        roomId: null,
        capabilities: truth,
        mintRequestId: () => "protected-acp-request",
        emit: frame => {
          const payload = frame.payload;
          const identity = Object.freeze({
            registrationId,
            scope,
            process: acpProcess,
            eventId: `protected-${registrationId}-event-${++sequence}`,
            eventSequence: sequence,
          });
          if (payload.kind === "terminal") {
            acpEvents.push(Object.freeze({
              ...identity,
              type: "relay:acp-terminal" as const,
              status: payload.status,
              ...(payload.code === undefined ? {} : { code: payload.code }),
            }));
          } else if (payload.kind === "output_delta"
            || payload.kind === "assistant_completed") {
            acpEvents.push(Object.freeze({
              ...identity,
              type: "relay:acp-semantic" as const,
              capabilities,
              payload: Object.freeze({
                kind: payload.kind,
                vendorItemId: payload.attribution.vendorItemId,
                text: payload.text,
              }),
            }));
          } else {
            throw new Error("Unexpected protected ACP semantic event");
          }
        },
      });
      await producer.project({
        kind: "agent_text_chunk",
        sessionId: acpProcess.acpSessionId,
        messageId: "protected-acp-answer",
        text: protectedExternalResultText,
      });
      await producer.complete({
        sessionId: acpProcess.acpSessionId,
        stopReason: "end_turn",
      });
    };
    type HermesRelay = Parameters<
      typeof createProtectedTaskHermesExecution
    >[0]["relay"];
    type OpenCodeRelay = Parameters<
      typeof createProtectedTaskOpenCodeExecution
    >[0]["relay"];
    const acpWorkspace = Object.freeze({
      workspaceReceiptId: "protected-acp-workspace",
      workspaceRevision: "1",
      workspaceFingerprint: "protected-acp-workspace-fingerprint",
      workspaceExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    const hermesRelay: HermesRelay | null = acpReadiness === null
      ? null
      : Object.freeze({
          listConnected: async () => {
            acpCalls.push("list-connected");
            return [acpReadiness.relayId];
          },
          getAcpSession: (relayId, userId) => {
            acpCalls.push("session");
            return relayId === acpReadiness.relayId
              && (userId === undefined || userId === base.userId)
              ? Object.freeze({ ...acpReadiness, userId: base.userId })
              : null;
          },
          requestAcpReadiness: async input => {
            acpCalls.push("readiness");
            expect(input.registrationId).toBe("hermes-acp");
            expect(input.userId).toBe(base.userId);
            return "ready" as const;
          },
          requestAcpPrepare: async input => {
            acpCalls.push("prepare");
            expect(input.userId).toBe(base.userId);
            expect(input.binding.ownerId).toBe(base.userId);
            return acpWorkspace;
          },
          requestAcpStart: async input => {
            acpCalls.push("start");
            acpPrompts.push(input.prompt);
            acpScopes.push(input.scope);
            acpEvents = [];
            acpCursor = 0;
            await produceAcpEvents("hermes-acp", input.scope);
            return Object.freeze({
              type: "relay:acp-started" as const,
              registrationId: "hermes-acp" as const,
              scope: input.scope,
              process: acpProcess,
              capabilities: { requests: "unsupported" as const },
              eventId: "protected-hermes-started",
              eventSequence: 1,
            });
          },
          subscribeAcpExecution: (scope, process) => {
            acpCalls.push("subscribe");
            const [startedScope] = acpScopes;
            if (startedScope === undefined) {
              throw new Error("Protected Hermes start scope is unavailable");
            }
            expect(scope).toEqual(startedScope);
            expect(process).toEqual(acpProcess);
            return Object.freeze({
              next: async () => acpEvents[acpCursor++] ?? null,
              acknowledge: (eventId, eventSequence) => {
                acpAcknowledgements.push({ eventId, eventSequence });
              },
              close: () => { acpCloseCalls += 1; },
            });
          },
          containAcpExecution: () => {
            acpContainCalls += 1;
            return true;
          },
        });
    const openCodeRelay: OpenCodeRelay | null = acpReadiness === null
      ? null
      : Object.freeze({
          listConnected: async () => {
            acpCalls.push("list-connected");
            return [acpReadiness.relayId];
          },
          getAcpSessionForRegistration: (relayId, userId, registrationId) => {
            acpCalls.push("session");
            expect(registrationId).toBe("opencode-acp");
            return relayId === acpReadiness.relayId && userId === base.userId
              ? Object.freeze({ ...acpReadiness, userId: base.userId })
              : null;
          },
          requestAcpReadiness: async input => {
            acpCalls.push("readiness");
            expect(input.registrationId).toBe("opencode-acp");
            expect(input.userId).toBe(base.userId);
            return "ready" as const;
          },
          requestAcpPrepare: async input => {
            acpCalls.push("prepare");
            expect(input.registrationId).toBe("opencode-acp");
            expect(input.binding.ownerId).toBe(base.userId);
            return acpWorkspace;
          },
          requestAcpStart: async input => {
            acpCalls.push("start");
            expect(input.registrationId).toBe("opencode-acp");
            expect(input.executionProfile).toBe("autonomous");
            acpPrompts.push(input.prompt);
            acpScopes.push(input.scope);
            acpEvents = [];
            acpCursor = 0;
            await produceAcpEvents("opencode-acp", input.scope);
            return Object.freeze({
              type: "relay:acp-started" as const,
              registrationId: "opencode-acp" as const,
              scope: input.scope,
              process: acpProcess,
              capabilities: { requests: "unsupported" as const },
              eventId: "protected-opencode-started",
              eventSequence: 1,
            });
          },
          subscribeAcpExecution: (scope, process, registrationId) => {
            acpCalls.push("subscribe");
            expect(registrationId).toBe("opencode-acp");
            const [startedScope] = acpScopes;
            if (startedScope === undefined) {
              throw new Error("Protected OpenCode start scope is unavailable");
            }
            expect(scope).toEqual(startedScope);
            expect(process).toEqual(acpProcess);
            return Object.freeze({
              next: async () => acpEvents[acpCursor++] ?? null,
              acknowledge: (eventId, eventSequence) => {
                acpAcknowledgements.push({ eventId, eventSequence });
              },
              close: () => { acpCloseCalls += 1; },
            });
          },
          containAcpExecution: (_scope, _process, registrationId) => {
            expect(registrationId).toBe("opencode-acp");
            acpContainCalls += 1;
            return true;
          },
        });
    try {
      if (codexReadiness !== null) {
        await base.admin.insert(codexAccountProfiles).values({
          id: codexProfileId,
          userId: base.userId,
          relayId: codexReadiness.relayId,
          homeHandle: `protected-codex-home-${codexProfileId}`,
          label: "Protected Codex fixture",
          profileGeneration: 2,
          accountGeneration: 3,
          registrationState: "registered",
          authState: "signed_in",
          removalState: "active",
        });
        await base.admin.insert(codexUserPreferences).values({
          userId: base.userId,
          enabled: true,
          accountProfileId: codexProfileId,
          defaultPosture: "codex_default",
        });
      }
      if (wakeForegroundScenario) {
        await base.admin.update(rooms).set({ label: wakeProjectionRoomLabel })
          .where(eq(rooms.id, base.roomId));
      }
      if (cancellationTerminalShadow || wakeForegroundShadow || deepResearchShadow
        || protectedCodexShadow || protectedAcpShadow
        || historicalDefinition || recurringEncryptedOccurrences) {
        await base.admin.update(encryptionTransitionPolicy).set({
          mode: "shadow_encryption", shadowBehavior: "strict",
          shadowEncryptionStartedAt: new Date(NOW), updatedAt: new Date(NOW),
        }).where(eq(encryptionTransitionPolicy.id, "server"));
      }
      if (callerLocalExecution) {
        // Caller-funded native Tasks are intentionally restricted to the
        // requester's canonical private Genie Room. The broad crypto fixture
        // normally labels this Namespace as a shared Room Namespace, so make
        // this one scenario model the real private-room product shape.
        expect(await base.admin.update(namespaces).set({ scope: "private" })
          .where(eq(namespaces.id, base.namespaceValue))
          .returning({ scope: namespaces.scope }))
          .toEqual([{ scope: "private" }]);
        callerFunding = await installSyntheticPersonalOpenRouter({
          database: base.admin,
          userId: base.userId,
          responseText: "Synthetic caller-funded protected response.",
        });
      }
      connected = historicalDefinition ? await createConnectedHistoricalTask(base,
        historicalDefinitionError ? "Earlier private provider failure retained after repair." : null) : await createConnectedProtectedTask(base, {
        useScope: scopedResult,
        ...(deepResearch ? { metadata: researchMetadata } : {}),
        ...(codexMetadata === null ? {} : { metadata: codexMetadata }),
        ...(acpMetadata === null ? {} : { metadata: acpMetadata }),
        noDelivery: scenario === "publication recovery"
          || unmappedRecovery || missingCiphertextRecovery,
        ...(liveOutputClock ? { resultDelivery: wakeForegroundScenario
          ? "raw_and_wake" as const : "raw" as const } : {}),
        ...(cancellationTerminalShadow || wakeForegroundShadow || deepResearchShadow
          || protectedCodexShadow || protectedAcpShadow
          || historicalDefinition || recurringEncryptedOccurrences
          ? { representation: "dual" as const } : {}),
        ...(callerLocalExecution ? {
          fundingMode: "caller" as const,
          requestedModelId: CALLER_LOCAL_MODEL_ID,
          tools: ["exec_command", "write_stdin"],
          createLocalExecutionDelegation: async coordinates => {
            delegatedLocal.current =
              await installConnectedDelegatedLocalExecution({
              humanUserId: base.userId,
              agentId: base.productAgentId,
              ...coordinates,
            });
            return delegatedLocal.current.delegation;
          },
        } : {}),
      });
      if (historicalDefinitionFull) {
        const [transitionedPolicy] = await base.admin
          .update(encryptionTransitionPolicy).set({
          mode: "encrypted_only",
          shadowBehavior: "strict",
          revision: base.policyRevision + 1,
          updatedAt: new Date(NOW + 1),
        }).where(and(
          eq(encryptionTransitionPolicy.id, "server"),
          eq(encryptionTransitionPolicy.revision, base.policyRevision),
        )).returning({ revision: encryptionTransitionPolicy.revision });
        if (transitionedPolicy?.revision !== base.policyRevision + 1) {
          throw new Error("Historical Task Full policy transition lost its CAS");
        }
        base.policyRevision = transitionedPolicy.revision;
      }
      let wakeProjectionModelCalls = 0;
      let wakeProjectionGraphCalls = 0;
      let wakeProjectionStage = "not_started";
      let wakeProjectionRotationPending = false;
      const additionalProjectionRoom: { current: { roomId: string; namespaceId: string; label: string } | null } = { current: null };
      const activeConnected = connected;
      if (wakeForegroundScenario) {
        const wakeJobId = protectedTaskRunWakeJobId(activeConnected.taskRunId);
        base.jobIds.add(wakeJobId);
        base.requestIds.add(`task-wake-authorization:${wakeJobId}`);
      }
      let wakeMemorySelection: ForegroundMemoryRepairSelection | null = null;
      if (wakeForegroundScenario) {
        const memoryScenario = await createScenario(base, {
          ...(wakeForegroundShadow
            ? { contentRepresentation: "dual" as const }
            : {}),
        });
        const memoryAuthority = Object.freeze({
          mode: "namespace" as const,
          subjectUserId: base.userId,
          agentId: base.productAgentId,
          readableNamespaceIds: Object.freeze([base.namespaceValue]),
          mutableNamespaceIds: Object.freeze([base.namespaceValue]),
          writableNamespaceId: base.namespaceValue,
        });
        const wakeMemory = await memoryScenario.withAuthority(
          () => NOW + 5,
          async ({ writer }) => withProtectedTaskNativeMemoryRepository({
            authority: memoryAuthority,
            policy: Object.freeze({
              mode: wakeForegroundShadow
                ? "shadow_encryption" as const
                : "encrypted_only" as const,
              shadowBehavior: "strict" as const,
              revision: base.policyRevision,
            }),
            current: writer,
            domains: Object.freeze([memoryScenario.domainSecret]),
            signer: Object.freeze({
              agentAuthorizationRevision: 7,
              runtime: base.runtime.runtime,
              signerPublication: base.runtime.signerPublication,
            }),
            resolveHistoricalSignerPublicationManager: () =>
              base.currentDevice.signingPublicKey,
            product: base.product,
            agentProduct: base.agentProduct,
            owner: bindEncryptionDataOperationOwner({
              policy: {
                resolve: async () => Object.freeze({
                  policy: Object.freeze({
                    mode: wakeForegroundShadow
                      ? "shadow_encryption" as const
                      : "encrypted_only" as const,
                    shadowBehavior: "strict" as const,
                  }),
                  revalidationToken: base.policyRevision,
                }),
                revalidate: async token => {
                  if (token !== base.policyRevision) {
                    throw new TypeError("Task Memory policy token changed");
                  }
                },
              },
            }),
            embedding: Object.freeze({
              embed: async () => Object.freeze({
                status: "success" as const,
                value: Object.freeze({
                  vector: Object.freeze(new Array<number>(1536).fill(0.25)),
                  provider: "openai",
                  canonicalModel: "text-embedding-3-small",
                  dimensions: 1536 as const,
                  contractVersion: 1,
                }),
              }),
            }),
            execute: async repository => {
              const saved = await repository.save({
                operationId: `wake-task-memory-save:${randomUUID()}`,
                authority: memoryAuthority,
                type: "fact",
                content: "Protected wake Memory context",
                importance: 0.8,
              });
              if (saved.status !== "success") {
                throw new Error(
                  `Protected wake Memory save failed: ${saved.reason}`,
                );
              }
              return saved.value;
            },
          }),
        );
        base.memoryIds.add(wakeMemory.id);
        base.objectIds.add(deriveMemoryCryptoObjectIdV1({
          memoryId: wakeMemory.id,
          contentRevision: 1,
        }));
        const completedAt = new Date(NOW + 6);
        await base.admin.transaction(async tx => {
          await tx.update(tasks).set({
            status: "completed",
          }).where(eq(tasks.id, memoryScenario.taskId));
          await tx.update(taskRuns).set({
            status: "completed",
            completedAt,
          }).where(eq(taskRuns.id, memoryScenario.taskRunId));
          await tx.update(jobs).set({
            status: "completed",
            completedAt,
          }).where(eq(jobs.id, memoryScenario.jobId));
        });
        const [memory] = await base.admin.select({
          id: memories.id,
          type: memories.type,
          content: memories.content,
          importance: memories.importance,
          tier: memories.tier,
          createdAt: memories.createdAt,
          contentRevision: memories.contentRevision,
          cryptoObjectId: memories.cryptoObjectId,
          cryptoMappingState: memories.cryptoMappingState,
        }).from(memories).where(eq(memories.id, wakeMemory.id));
        if (memory === undefined || memory.cryptoObjectId === null
          || memory.cryptoMappingState !== "verified") {
          throw new Error("Protected wake Memory source was unavailable");
        }
        wakeMemorySelection = memory.content === null || memory.type === null
          ? Object.freeze({
              representation: "structural" as const,
              id: memory.id,
              type: memory.type,
              importance: memory.importance,
              tier: memory.tier,
              createdAt: memory.createdAt,
            })
          : Object.freeze({
              id: memory.id,
              type: memory.type,
              content: memory.content,
              importance: memory.importance,
              tier: memory.tier,
              createdAt: memory.createdAt,
            });
      }
      const segmentCalls: Array<Readonly<{
        taskId: string;
        taskRunId: string;
        graphThreadId: string;
      }>> = [];
      const segmentContinuationModes: boolean[] = [];
      const firstCheckpointSegmentEntered = deferred();
      let checkpointContinuationAuthorizationRequestId: string | null = null;
      let refreshAuthorizationExpiresAt: number | null = null;
      let controlledEffectExecutions = 0;
      const continuationAuthorizationRequestId =
        `task-run-authorization:${activeConnected.taskRunId}:segment:2`;
      const continuationRequirements = Object.freeze([Object.freeze({
        namespaceId: base.namespaceValue,
        operations: Object.freeze(["decrypt" as const, "encrypt" as const]),
      })]);
      const nativeErrors: Array<Readonly<{
        stage:
          | "prepare"
          | "open"
          | "definition"
          | "context"
          | "transcript"
          | "memory"
          | "checkpoint"
          | "execute"
          | "publish_result";
        name: string;
        message: string;
      }>> = [];
      const recordNativeError = (
        stage:
          | "prepare"
          | "open"
          | "definition"
          | "context"
          | "transcript"
          | "memory"
          | "checkpoint"
          | "execute"
          | "publish_result",
        error: unknown,
      ): void => {
        nativeErrors.push(Object.freeze({
          stage,
          name: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error
            ? error.message
            : "Non-Error failure",
        }));
      };
      const traceNative = async <Value>(
        stage:
          | "definition"
          | "context"
          | "transcript"
          | "memory"
          | "checkpoint",
        operation: () => Value | Promise<Value>,
      ): Promise<Value> => {
        try {
          return await operation();
        } catch (error) {
          recordNativeError(stage, error);
          throw error;
        }
      };
      let notifyTerminal!: () => void;
      const terminalStatus = new Promise<void>(resolve => { notifyTerminal = resolve; });
      jobManager = new JobManager({
        laneLock: new InMemoryLaneLock(),
        persist: async payload => {
          const jobId = await persistJobWithDatabase(base.productDb, payload);
          connectedJobId = jobId;
          base.jobIds.add(jobId);
          return jobId;
        },
        startProtectedTaskJob: async (
          jobId,
          expectedReference,
          publicationPolicy,
        ) => {
          connectedJobId = jobId;
          base.jobIds.add(jobId);
          if (scenario === "linked cancellation") {
            expect(await transitionTaskLifecycleTerminal(base.productDb, {
              taskId: expectedReference.taskId,
              taskStatus: "cancelled",
              taskPatch: { cancelledAt: new Date(NOW) },
              runStatus: "cancelled",
            })).toMatchObject({ transitioned: true,
              task: undefined, run: undefined,
              protectedTask: { status: "cancelled" },
              protectedRun: { status: "cancelled", jobId } });
          }
          return startProtectedTaskJobWithDatabase(
            base.productDb, jobId, expectedReference, publicationPolicy,
          );
        },
        updateStatus: (jobId, status, fields, publicationPolicy) =>
          updateJobStatusWithDatabase(
            base.productDb, jobId, status, fields, publicationPolicy,
          ),
        settleProtectedTaskJobTerminal: async (jobId, reference, requested, policy) => {
          const result = await settleProtectedTaskJobTerminalWithDatabase(
            base.productDb, jobId, reference, requested, policy,
          );
          if (jobId === connectedJobId && result.kind !== "rejected"
            && (scenario !== "parked continuation"
              && !checkpointContinuationScenario
              || reference.executionSegment === 2)) notifyTerminal();
          return result;
        },
      });
      const wakeHistoryMessageIds: number[] = [];
      let wakeExecutions = 0;

      let wakePublishedMessageId: number | null = null;
      const wakeExecutor: JobExecutor = async function* (
        transient,
        jobId,
        laneKey,
        signal,
      ) {
        try {
        if (!wakeForegroundScenario) {
          throw new Error("Unexpected protected wake execution");
        }
        expect(jobId).toBe(protectedTaskRunWakeJobId(activeConnected.taskRunId));
        expect(laneKey).toBe(`room:${base.roomId}`);
        expect(transient["message"]).toBe("");
        const turn = getCurrentLiveShadowTurnContext();
        const wake = turn?.taskWake;
        const session = turn?.session;
        if (wake === undefined || session === null || session === undefined
          || wakeMemorySelection === null
          || session.protectForegroundHistory === undefined
          || session.protectForegroundMemories === undefined) {
          throw new Error("Protected wake foreground context was unavailable");
        }
        expect(wake.result).toEqual({
          formatVersion: 1,
          resultText: "Connected protected result",
          lastError: null,
        });
        expect(wake.scheduling.taskId).toBe(activeConnected.taskId);
        expect(wake.scheduling.taskRunId).toBe(activeConnected.taskRunId);
        const history = await session.protectForegroundHistory({
          messageIds: wakeHistoryMessageIds,
          signal,
        });
        expect(history).toMatchObject({ status: "verified" });
        if (history.status === "verified") {
          expect(history.messages.map(message => message.payload.content))
            .toEqual(["Connected protected result"]);
        }
        const memory = await session.protectForegroundMemories({
          memories: [wakeMemorySelection],
          signal,
        });
        expect(memory).toMatchObject({ status: "verified" });
        if (memory.status === "verified") {
          expect(memory.memories).toHaveLength(1);
          expect(memory.memories[0]?.id).toBe(wakeMemorySelection.id);
        }
        if (wakeProjectionContinuation) {
          if (additionalProjectionRoom.current === null) {
            const roomId = randomUUID();
            const namespaceId = randomUUID();
            const label = `Wake additional projection ${roomId}`;
            base.fixtureRoomIds.add(roomId);
            base.fixtureNamespaceIds.add(namespaceId);
            await base.admin.insert(namespaces).values({ id: namespaceId, scope: "room", label });
            await base.admin.insert(rooms).values({ id: roomId, ownerId: base.userId,
              type: "group", kind: "group", namespaceId, label,
              humanActorIds: [base.humanActorId], graphThreadId: `wake-additional:${roomId}` });
            const [actor] = await base.admin.select({ id: actors.id }).from(actors)
              .where(eq(actors.agentId, base.productAgentId)).limit(1);
            if (actor === undefined) throw new Error("Fixture Agent Actor is unavailable");
            await base.admin.insert(roomMembers).values([
              { roomId, actorId: base.humanActorId, roomRole: "admin" },
              { roomId, actorId: actor.id, roomRole: "member" },
            ]);
            additionalProjectionRoom.current = { roomId, namespaceId, label };
          }
          const destination = additionalProjectionRoom.current;
          if (session.checkpoint === undefined
            || session.createForegroundMemoryProjectionPort === undefined) {
            throw new Error("Wake projection continuation fixture is unavailable");
          }
          const authority = protectedMemoryAuthorityFromEnvelope(wake.memoryAccessEnvelope);
          if (authority === null) throw new Error("Wake projection source authority is unavailable");
          expect(authority.mode).toBe("namespace");
          if (authority.mode !== "namespace") throw new Error("Unexpected Scope source");
          expect(authority.readableNamespaceIds).not.toContain(destination.namespaceId);
          let projection = await session.createForegroundMemoryProjectionPort(wake.memoryAccessEnvelope);
          type Reference = Parameters<ProtectedAgentMemoryProjectionPort["publish"]>[0]["reference"];
          const State = Annotation.Root({
            reference: Annotation<Reference | null>({ reducer: (_old, next) => next, default: () => null }),
            memoryId: Annotation<string | null>({ reducer: (_old, next) => next, default: () => null }),
          });
          const checkpointThreadId = `protected-task-wake:${jobId}`;
          let saver = createLiveShadowCheckpointSaver({ logicalThreadId: checkpointThreadId,
            checkpoint: session.checkpoint });
          let primaryErrorPresent = false;
          try {
            const buildGraph = (currentSaver: typeof saver) => new StateGraph(State)
              .addNode("prepare", async () => {
                wakeProjectionModelCalls += 1;
                const prepared = await projection.prepare({
                  operationId: `memory:v1:wake-additional:${activeConnected.taskRunId}`,
                  toolCallId: `wake-additional:${activeConnected.taskRunId}`,
                  authority, requesterActorId: base.humanActorId,
                  sourceMemoryIds: [wakeMemorySelection.id],
                  proposedContent: "Protected wake shared with a newly available Room",
                  targetRoomName: destination.label,
                });
                if (prepared.status !== "success" || prepared.value.kind !== "prepared") {
                  throw new Error("Wake additional projection preparation failed");
                }
                return { reference: prepared.value.reference };
              })
              .addNode("publish", async state => {
                wakeProjectionStage = "projection_publish";
                if (state.reference === null) throw new Error("Wake projection reference is missing");
                if (wakeProjectionRollback && wake.continuation !== undefined && projectionRollback.current === null) {
                  projectionRollback.current = installForegroundProjectionProductRollback({
                    database: getSharedDirectAgentDb(),
                    operationId: `memory:v1:wake-additional:${activeConnected.taskRunId}`,
                  });
                }
                const published = await projection.publish({ authority, reference: state.reference });
                wakeProjectionStage = "projection_publish_returned";
                if (published.status !== "success") throw new Error(`Wake additional projection failed: ${published.reason}`);
                return { memoryId: published.value.memoryId };
              })
              .addEdge(START, "prepare").addEdge("prepare", "publish").addEdge("publish", END)
              .compile({ checkpointer: currentSaver });
            let graph = buildGraph(saver);
            const config = { configurable: { thread_id: checkpointThreadId } };
            wakeProjectionGraphCalls += 1;
            let completed: Awaited<ReturnType<typeof graph.invoke>>;
            try {
              completed = await graph.invoke(wake.continuation === undefined
                ? { reference: null, memoryId: null }
                : new Command({ resume: createProtectedTaskAdditionalAuthorityResumeMapV1(wake.continuation.resume) }), config);
            } catch (error) {
              if (!wakeProjectionRollback || projectionRollback.current?.observed() !== true
                || wake.continuation === undefined) throw error;
              projectionRollback.current.restore();
              const [receipt] = await base.admin.select({
                memoryId: foregroundMemoryCryptoPublicationReceipts.memoryId,
                objectId: foregroundMemoryCryptoPublicationReceipts.cryptoObjectId,
              }).from(foregroundMemoryCryptoPublicationReceipts).where(eq(
                foregroundMemoryCryptoPublicationReceipts.operationId,
                `memory:v1:wake-additional:${activeConnected.taskRunId}`,
              ));
              if (receipt === undefined) throw new Error("Interrupted projection ciphertext receipt is missing");
              base.memoryIds.add(receipt.memoryId);
              base.objectIds.add(receipt.objectId);
              expect(await base.admin.select({ id: memories.id }).from(memories)
                .where(eq(memories.id, receipt.memoryId))).toEqual([]);
              expect(await base.admin.select({ id: memoryNamespaces.memoryId }).from(memoryNamespaces)
                .where(eq(memoryNamespaces.memoryId, receipt.memoryId))).toEqual([]);
              const [ciphertext] = await base.admin.select({ hash: cryptoObjects.payloadHash }).from(cryptoObjects)
                .where(eq(cryptoObjects.objectId, receipt.objectId));
              if (ciphertext === undefined) throw new Error("Interrupted projection ciphertext is missing");
              projectionCiphertextHash.current = Uint8Array.from(ciphertext.hash);
              expect(projectionCiphertextHash.current.byteLength).toBe(32);
              await disposeProtectedCheckpointSaver({ saver, primaryErrorPresent: true });
              // Drop the failed publication/session custody. The next adapter
              // must prove the durable receipt, never reuse a prepared token.
              projection = await session.createForegroundMemoryProjectionPort(wake.memoryAccessEnvelope);
              saver = createLiveShadowCheckpointSaver({ logicalThreadId: checkpointThreadId,
                checkpoint: session.checkpoint });
              graph = buildGraph(saver);
              wakeProjectionGraphCalls += 1;
              completed = await graph.invoke(new Command({
                resume: createProtectedTaskAdditionalAuthorityResumeMapV1(wake.continuation.resume),
              }), config);
              projectionRollbackRecovered = true;
            }
            wakeProjectionStage = "graph_invoke_returned";
            const state = await graph.getState(config);
            wakeProjectionStage = "graph_state_read";
            const interrupts = protectedTaskInterruptCoordinates(state as never);
            if (interrupts.length > 0) {
              expect(interrupts).toHaveLength(1);
              const coordinate = interrupts[0]!;
              expect(coordinate.kind).toBe("additional_authority");
              if (coordinate.kind !== "additional_authority") throw new Error("Wrong wake interrupt kind");
              const custody = getCurrentProtectedTaskWakeExecutionCustody();
              if (custody === undefined) throw new Error("Wake park custody missing");
              const checkpoint = await sealProtectedTaskWakeCheckpointManifest({ saver, checkpointThreadId });
              const parked = await custody.park({
                interruptId: coordinate.id, additionalAuthorizationRequestId: coordinate.requestId,
                effectDisposition: coordinate.effectDisposition, operationId: coordinate.operationId,
                requestDigest: coordinate.requestDigest, requiredAuthorityDigest: coordinate.requiredAuthorityDigest,
                semanticAuthorityRequirements: coordinate.semanticAuthorityRequirements,
                checkpointBinding: wake.checkpointBinding, checkpointThreadId, checkpoint,
              });
              expect(parked.status).toBe("parked");
              throw protectedTaskWakeParked();
            }
            expect(wakeProjectionModelCalls).toBe(1);
            wakeProjectionStage = "memory_receipt_verification";
            expect(wakeProjectionGraphCalls).toBe(wakeProjectionRollback ? 3 : 2);
            if (completed.memoryId === null) throw new Error("Wake projection result is missing");
            base.memoryIds.add(completed.memoryId);
            const [stored] = await base.admin.select({ content: memories.content,
              objectId: memories.cryptoObjectId }).from(memories).where(eq(memories.id, completed.memoryId));
            expect(stored?.content).toBeNull();
            if (stored?.objectId === null || stored?.objectId === undefined) throw new Error("Wake projection ciphertext is missing");
            base.objectIds.add(stored.objectId);
            const receipts = await base.admin.select({
              operationId: foregroundMemoryCryptoPublicationReceipts.operationId,
              memoryId: foregroundMemoryCryptoPublicationReceipts.memoryId,
              contentRevision: foregroundMemoryCryptoPublicationReceipts.contentRevision,
              agentId: foregroundMemoryCryptoPublicationReceipts.agentId,
              reservationDigest: foregroundMemoryCryptoPublicationReceipts.reservationDigest,
              namespaceFingerprint: foregroundMemoryCryptoPublicationReceipts.requiredNamespaceFingerprint,
              genesisHash: foregroundMemoryCryptoPublicationReceipts.genesisManifestHash,
            }).from(foregroundMemoryCryptoPublicationReceipts)
              .where(eq(foregroundMemoryCryptoPublicationReceipts.cryptoObjectId, stored.objectId));
            expect(receipts).toHaveLength(1);
            expect(receipts[0]).toMatchObject({
              operationId: `memory:v1:wake-additional:${activeConnected.taskRunId}`,
              memoryId: completed.memoryId, contentRevision: 1, agentId: base.productAgentId,
            });
            expect(receipts[0]?.reservationDigest.byteLength).toBe(32);
            expect(receipts[0]?.namespaceFingerprint.byteLength).toBe(32);
            expect(receipts[0]?.genesisHash.byteLength).toBe(32);
            if (wakeProjectionRollback) {
              expect(projectionRollbackRecovered).toBeTrue();
              expect(projectionRollback.current?.observed()).toBeTrue();
              const [ciphertext] = await base.admin.select({ hash: cryptoObjects.payloadHash }).from(cryptoObjects)
                .where(eq(cryptoObjects.objectId, stored.objectId));
              if (projectionCiphertextHash.current === null) throw new Error("Interrupted projection ciphertext hash is missing");
              expect(ciphertext?.hash).toEqual(projectionCiphertextHash.current);
              expect(await objectRowCounts(base, stored.objectId)).toEqual({
                payload: 1, head: 1, manifest: 1, envelope: 1,
              });
            }
            expect(await base.admin.select({ namespaceId: memoryNamespaces.namespaceId })
              .from(memoryNamespaces).where(eq(memoryNamespaces.memoryId, completed.memoryId)))
              .toEqual([{ namespaceId: destination.namespaceId }]);
            wakeProjectionStage = "transcript_publication";
            const published = await session.publishMessage({ payload: { role: "assistant",
              content: "The protected Task result is ready." }, stage: "assistant_message", createdAt: Date.now() });
            wakeProjectionStage = "message_published";
            if (published.status !== "protected") throw new Error("Wake resumed transcript failed");
            wakePublishedMessageId = published.value.reservation.messageId;
            wakeExecutions += 1;
            return;
          } catch (error) {
            primaryErrorPresent = true;
            throw error;
          } finally {
            await disposeProtectedCheckpointSaver({ saver, primaryErrorPresent });
          }
        }
        if (session.createForegroundMemoryRepository === undefined) {
          throw new Error("Protected wake Memory repository was unavailable");
        }
        const repository = await session.createForegroundMemoryRepository(wake.memoryAccessEnvelope);
        const memoryAuthority = protectedMemoryAuthorityFromEnvelope(wake.memoryAccessEnvelope);
        if (memoryAuthority === null) throw new Error("Wake Memory authority is unavailable");
        const saved = await repository.save({
          operationId: `wake-foreground-memory:${activeConnected.taskRunId}`,
          authority: memoryAuthority,
          type: "fact", content: "Protected wake created Memory", importance: 0.8,
        });
        expect(saved.status).toBe("success");
        if (saved.status !== "success") throw new Error(`Wake Memory write failed: ${saved.reason}`);
        base.memoryIds.add(saved.value.id);
        const [storedMemory] = await base.admin.select({ content: memories.content,
          objectId: memories.cryptoObjectId, contentRevision: memories.contentRevision })
          .from(memories).where(eq(memories.id, saved.value.id));
        expect(storedMemory).toBeDefined();
        if (storedMemory === undefined) throw new Error("Saved wake Memory was not persisted");
        const savedObjectId = deriveMemoryCryptoObjectIdV1({ memoryId: saved.value.id,
          contentRevision: storedMemory.contentRevision });
        base.objectIds.add(savedObjectId);
        expect(storedMemory.contentRevision).toBeGreaterThan(0);
        expect({ content: storedMemory.content, objectId: storedMemory.objectId })
          .toEqual({ content: wakeForegroundShadow ? "Protected wake created Memory" : null,
          objectId: savedObjectId });
        if (session.createForegroundMemoryProjectionPort === undefined) {
          throw new Error("Protected wake Memory projection port was unavailable");
        }
        const projection = await session.createForegroundMemoryProjectionPort(wake.memoryAccessEnvelope);
        const preparedProjection = await projection.prepare({
          operationId: `memory:v1:wake-projection:${activeConnected.taskRunId}`,
          toolCallId: `wake-projection:${activeConnected.taskRunId}`,
          authority: memoryAuthority,
          requesterActorId: base.humanActorId,
          sourceMemoryIds: [saved.value.id],
          proposedContent: "Protected wake projected Memory",
          targetRoomName: wakeProjectionRoomLabel,
        });
        expect(preparedProjection.status).toBe("success");
        if (preparedProjection.status !== "success"
          || preparedProjection.value.kind !== "prepared") {
          throw new Error("Protected wake Memory projection preparation failed");
        }
        const projected = await projection.publish({ authority: memoryAuthority,
          reference: preparedProjection.value.reference });
        expect(projected.status).toBe("success");
        if (projected.status !== "success") {
          throw new Error(`Protected wake Memory projection failed: ${projected.reason}`);
        }
        base.memoryIds.add(projected.value.memoryId);
        const [projectedMemory] = await base.admin.select({ content: memories.content,
          objectId: memories.cryptoObjectId, contentRevision: memories.contentRevision })
          .from(memories).where(eq(memories.id, projected.value.memoryId));
        expect(projectedMemory).toBeDefined();
        if (projectedMemory === undefined) throw new Error("Projected wake Memory was not persisted");
        const projectedObjectId = deriveMemoryCryptoObjectIdV1({
          memoryId: projected.value.memoryId, contentRevision: projectedMemory.contentRevision });
        base.objectIds.add(projectedObjectId);
        expect(projected.value).toEqual({ status: "created", memoryId: projected.value.memoryId,
          roomLabel: wakeProjectionRoomLabel });
        expect({ content: projectedMemory.content, objectId: projectedMemory.objectId })
          .toEqual({ content: wakeForegroundShadow ? "Protected wake projected Memory" : null,
            objectId: projectedObjectId });
        expect(await projection.publish({ authority: memoryAuthority,
          reference: preparedProjection.value.reference })).toEqual({ status: "success",
          value: { status: "replayed", memoryId: projected.value.memoryId,
            roomLabel: wakeProjectionRoomLabel } });
        const published = await session.publishMessage({
          payload: {
            role: "assistant",
            content: "The protected Task result is ready.",
          },
          stage: "assistant_message",
          createdAt: Date.now(),
        });
        expect(published).toMatchObject({ status: "protected" });
        if (published.status !== "protected") {
          throw new Error("Protected wake transcript publication failed");
        }
        wakePublishedMessageId = published.value.reservation.messageId;
        wakeExecutions += 1;
        yield {
          type: "message.tokens",
          laneKey: `room:${base.roomId}`,
          content: "The protected Task result is ready.",
          chunkSequence: 1,
          done: true,
        };
        } catch (error) {
          if (isProtectedTaskWakeParked(error)) throw error;
          recordNativeError("execute", error); throw error;
        }
      };
      const owner = bindEncryptionDataOperationOwner({
        policy: {
          resolve: () => Promise.resolve({
            policy: {
              mode: cancellationTerminalShadow || wakeForegroundShadow || deepResearchShadow
                || protectedCodexShadow || protectedAcpShadow
                || recurringEncryptedOccurrences
                || historicalDefinition && !historicalDefinitionFull
                ? "shadow_encryption" as const
                : "encrypted_only" as const,
              shadowBehavior: "strict" as const,
            },
            revalidationToken: base.policyRevision,
          }),
          revalidate: token => {
            if (token !== base.policyRevision) {
              throw new Error("Protected Task policy changed");
            }
            return Promise.resolve();
          },
        },
      });
      if (deepResearch || protectedExternal) {
        eventBus.on(onResearchEvent);
      }
      let kicks = 0;
      const composition = await createProductionProtectedTaskRuntimeInitialComposition({
        db: base.productDb,
        resolver: new PersonalPolicyResolver(
          base.userId,
          base.productAgentId,
        ),
        convergeCreatedRoomCatalog: async () => undefined,
        owner,
        recipients,
        jobManager,
        kick: () => {
          kicks += 1;
        },
        restricted: base.restricted,
        crypto: base.crypto,
        serverScope: SERVER_SCOPE,
        now: liveOutputClock ? Date.now : () => recoveryNow,
        ...(deepResearch ? { prepareExternalExecution: {
          deepResearch: async (selection, preparation) => {
            expect(selection).toEqual({ deepResearch: deepResearchV2
              ? { version: 2, ...researchOperational, ...researchV2Funding }
              : { version: 1, ...researchOperational } });
            expect(JSON.stringify(selection)).not.toContain("Portuguese");
            const context = createProductionProtectedTaskNativeExecutionContext({ db: base.productDb });
            const prepare = createProtectedTaskDeepResearchExecution({
              db: base.productDb, restricted: base.restricted, crypto: base.crypto,
              serverScope: SERVER_SCOPE, owner, now: () => recoveryNow,
              executionContext: contextInput => traceNative("context", () => context(contextInput)),
              requests: { register: async () => { throw new Error("Research must not install provider questions"); } },
              stream: async function* (...args) {
                researchStreamCalls.push([...args]);
                const [request, executionId, signal, requesterId, attribution, options] = args;
                expect(request).toEqual({ research_brief: "Complete the connected protected Task",
                  report_language: "Portuguese", deep_research_model_plan: researchModelPlan,
                  ...(deepResearchV2 ? { deep_research_funding: { version: 2, reportLanguage: "Portuguese",
                    ...researchOperational, ...researchV2Funding } } : {}) });
                expect(executionId).toBe(activeConnected.taskRunId);
                expect(requesterId).toBe(base.userId);
                expect(attribution).toEqual({ roomId: base.roomId, taskId: activeConnected.taskId,
                  taskRunId: activeConnected.taskRunId, agentId: base.productAgentId });
                expect(options).toEqual({ confidential: true });
                signal?.throwIfAborted();
                const invocation = getCurrentAcceptedInvocationAuthority();
                if (invocation === undefined) throw new Error("Research invocation authority missing");
                assertAcceptedInvocationAuthoritySubject(invocation, base.userId);
                expect(getAcceptedInvocationAuthorityOrigin(invocation)).toEqual({ originTaskId: activeConnected.taskId });
                yield { phase: "private_research_progress_canary" };
                signal?.throwIfAborted();
                return "Connected protected result";
              },
            }, {
              definition: definitionInput => traceNative("definition", () => withNativeProtectedTaskDefinitionV1(definitionInput)),
              transcript: transcriptInput => {
                const factory = createProtectedTaskNativeTranscriptPublisher(transcriptInput);
                return async segment => {
                  const publish = await traceNative("transcript", () => factory(segment));
                  return request => traceNative("transcript", () => publish(request));
                };
              },
            })(selection);
            let prepared: Awaited<ReturnType<typeof prepare>>;
            try { prepared = await prepare(preparation); }
            catch (error) { recordNativeError("prepare", error); throw error; }
            const executor: typeof prepared.executor = async function* (...args) {
              try { yield* prepared.executor(...args); }
              catch (error) { recordNativeError("execute", error); throw error; }
            };
            const openTransientInput: typeof prepared.openTransientInput = async grant => {
              try { return await prepared.openTransientInput(grant); }
              catch (error) { recordNativeError("open", error); throw error; }
            };
            return { ...prepared, executor, openTransientInput };
          },
        } } : {}),
        ...(protectedCodex ? {
          prepareExternalExecution: {
            codex: async (selection, preparation) => {
              if (codexReadiness === null || codexMetadata === null) {
                throw new Error("Protected Codex readiness receipt is unavailable");
              }
              expect(selection).toEqual(codexMetadata);
              const relaySessionId = `protected-codex-socket-${codexProfileId}`;
              const desktopSessionId = `protected-codex-desktop-${codexProfileId}`;
              const workspace = Object.freeze({
                workspaceRef: `protected-codex-workspace-${codexProfileId}`,
                revision: 7,
                fingerprint: `protected-codex-workspace-fingerprint-${codexProfileId}`,
                issuedAt: new Date(Date.now() - 60_000).toISOString(),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              });
              const session = Object.freeze({
                relayId: codexReadiness.relayId,
                userId: base.userId,
                relaySessionId,
                pairingGenerationRef: codexReadiness.pairingGenerationRef,
                desktopSessionId,
                selectedProtocolVersion: CODEX_RELAY_PROTOCOL_VERSION,
                capability: Object.freeze({ version: 1, hostKind: "electron" }),
                capabilityRevision: codexReadiness.capabilityRevision,
                currentCapabilityRevision: codexReadiness.capabilityRevision,
                currentRuntimeGeneration: 5,
                statusCorrelation: Object.freeze({
                  relayId: codexReadiness.relayId,
                  relaySessionId,
                  desktopSessionId,
                  pairingGenerationRef: codexReadiness.pairingGenerationRef,
                  selectedProtocolVersion: CODEX_RELAY_PROTOCOL_VERSION,
                  capabilityRevision: codexReadiness.capabilityRevision,
                }),
                status: Object.freeze({
                  state: "ready" as const,
                  compatibility: "certified" as const,
                  features: Object.freeze({
                    stableConversation: true,
                    explicitSteer: true,
                    codexApprovals: true,
                    requestUserInput: true,
                    collaborationMode: true,
                  }),
                  runtimeGeneration: 5,
                  profiles: Object.freeze([Object.freeze({
                    profileHandle: codexProfileId,
                    profileGeneration: 2,
                    accountGeneration: 3,
                    childGeneration: 6,
                    state: "signed_in" as const,
                  })]),
                  workspace: Object.freeze({ state: "bound" as const, receipt: workspace }),
                }),
              });
              const bindings = createCodexTaskBindingLookup(base.admin);
              const preferences = new CodexHarnessPreferenceStore(base.admin);
              const mutations = new CodexPersistenceAdapter(base.admin);
              const prepare = createProtectedTaskCodexExecution({
                db: base.productDb,
                restricted: base.restricted,
                crypto: base.crypto,
                serverScope: SERVER_SCOPE,
                owner,
                now: Date.now,
                preferences,
                preflight: {
                  prepare: async profile => {
                    codexCalls.push("preflight");
                    expect(profile).toMatchObject({
                      id: codexProfileId,
                      userId: base.userId,
                      relayId: codexReadiness.relayId,
                    });
                  },
                },
                models: {
                  list: async profile => {
                    codexCalls.push("models");
                    expect(profile.id).toBe(codexProfileId);
                    return { models: [{ id: codexModelId, model: codexModelId }] };
                  },
                },
                limits: {
                  resolve: async modelId => {
                    codexCalls.push("limits");
                    expect(modelId).toBe(`openai:${codexModelId}`);
                    return { modelId, catalogVersion: "protected-codex-catalog-1",
                      contextTokens: 128_000, maxOutputTokens: 16_384 };
                  },
                },
                canonicalReader: createCodexCanonicalFactsReader(base.admin),
                sessions: {
                  getCodexSession: (relayId, userId) => {
                    codexCalls.push("session");
                    return relayId === codexReadiness.relayId && userId === base.userId
                      ? session
                      : null;
                  },
                },
                mutations,
                admissionFactory: new CodexExecutionAdmissionFactory({
                  bindings,
                  mintId: () => {
                    const id = randomUUID();
                    codexBindingIds.push(id);
                    return id;
                  },
                }),
                execution: {
                  async *start(admission) {
                    assertCodexExecutionAdmission(admission);
                    codexCalls.push("start");
                    expect(admission).toMatchObject({
                      taskId: activeConnected.taskId,
                      taskRunId: activeConnected.taskRunId,
                      ownerId: base.userId,
                      requesterId: base.userId,
                      roomId: base.roomId,
                      prompt: "Complete the connected protected Task",
                      codex: {
                        selectedModel: codexModelId,
                        collaborationMode: "work",
                        workingDirectory: null,
                        bindingKind: "task",
                      },
                    });
                    const attribution = Object.freeze({
                      taskId: admission.taskId,
                      roomId: admission.roomId,
                      bindingId: admission.binding.id,
                      bindingGeneration: admission.binding.generation,
                      vendorSessionId: "protected-codex-session",
                      vendorTurnId: "protected-codex-turn",
                      vendorItemId: "protected-codex-item",
                    });
                    yield Object.freeze({ kind: "assistant_completed" as const,
                      attribution, text: protectedExternalResultText });
                    yield Object.freeze({ kind: "terminal" as const,
                      attribution, status: "completed" as const });
                  },
                  respond: async () => {
                    throw new Error("Codex must not receive provider questions");
                  },
                },
                requestBroker: { hasLiveRequest: () => false },
                requestPartition: {
                  protect: identity => {
                    codexCalls.push("protect");
                    expect(identity.taskId).toBe(activeConnected.taskId);
                    expect(identity.jobId).toMatch(
                      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
                    );
                    expect(identity.bindingGeneration).toBe(0);
                    codexPartitionIdentities.push(Object.freeze({ ...identity }));
                    let closed = false;
                    return Object.freeze({
                      close() {
                        if (closed) throw new Error("Codex request partition closed twice");
                        closed = true;
                        codexCalls.push("retire");
                      },
                    });
                  },
                },
                requests: {
                  register: async () => {
                    throw new Error("Codex must not install provider questions");
                  },
                },
              })(selection);
              try {
                return await prepare(preparation);
              } catch (error) {
                recordNativeError("prepare", error);
                throw error;
              }
            },
          },
        } : {}),
        ...(protectedAcpProvider === "hermes" ? {
          prepareExternalExecution: {
            hermes: async (selection, preparation) => {
              if (hermesRelay === null || acpReadiness === null) {
                throw new Error("Protected Hermes relay fixture is unavailable");
              }
              expect(selection).toEqual({
                execution: {
                  version: 1,
                  harnessId: "hermes-acp",
                  source: "genie",
                  readiness: acpReadiness,
                },
              });
              return createProtectedTaskHermesExecution({
                db: base.productDb,
                restricted: base.restricted,
                crypto: base.crypto,
                serverScope: SERVER_SCOPE,
                owner,
                now: Date.now,
                relay: hermesRelay,
                mintId: () => `protected-hermes-opaque-${++acpMinted}`,
                requests: {
                  register: async () => {
                    throw new Error("Hermes must not install provider questions");
                  },
                },
              })(selection)(preparation);
            },
          },
        } : protectedAcpProvider === "opencode" ? {
          prepareExternalExecution: {
            opencode: async (selection, preparation) => {
              if (openCodeRelay === null || acpReadiness === null) {
                throw new Error("Protected OpenCode relay fixture is unavailable");
              }
              expect(selection).toEqual({
                execution: {
                  version: 1,
                  harnessId: "opencode-acp",
                  source: "genie",
                  executionProfile: "autonomous",
                  readiness: acpReadiness,
                },
              });
              return createProtectedTaskOpenCodeExecution({
                db: base.productDb,
                restricted: base.restricted,
                crypto: base.crypto,
                serverScope: SERVER_SCOPE,
                owner,
                now: Date.now,
                relay: openCodeRelay,
                mintId: () => `protected-opencode-opaque-${++acpMinted}`,
                requests: {
                  register: async () => {
                    throw new Error("OpenCode must not install provider questions");
                  },
                },
              })(selection)(preparation);
            },
          },
        } : {}),
        ...(wakeForegroundScenario || scopedResult ? {
          embedding: { embed: async () => ({ status: "success" as const,
            value: { vector: new Array<number>(1536).fill(0.25), provider: "openai",
              canonicalModel: "text-embedding-3-small", dimensions: 1536 as const, contractVersion: 1 } }) },
          ...(wakeForegroundScenario ? { wakeForeground: {
            onDiagnostic: (_stage, error) => {
              const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
              if (wakeProjectionContinuation && cause instanceof Error
                && cause.message === "Task wake park authorization rotation is pending") {
                // The new Room has no crypto bundle yet. This diagnostic is
                // emitted after the old grant callback has unwound.
                wakeProjectionRotationPending = true;
                return;
              }
              recordNativeError("transcript", cause);
            },
            jobManager,
            executor: wakeExecutor,
            wakeEffectRecovery: () => undefined,
          } } : {}),
        } : {}),
      }, {
        nativeExecution: input => {
          const native = createProductionProtectedTaskNativeExecution(input, {
            result: resultInput => createProtectedTaskNativeResultPublication(
              resultInput,
              {
                ...(scenario === "attachment recovery" ? {
                  recordAttached: async () => {
                    throw new Error("synthetic loss before result attachment");
                  },
                } : {}),
                ...(unmappedRecovery ? {
                  createRepository:
                    createCrashAfterTaskResultCryptoRepository,
                } : {}),
                ...(missingCiphertextRecovery ? {
                  createRepository:
                    createMissingTaskResultCiphertextRepository,
                } : {}),
              },
            ),
            segment: (segmentInput, _segmentOverrides, segmentOptions) => createProtectedTaskNativeFixedMemorySegment({
              ...segmentInput,
              resolveExecutionContext: context => traceNative(
                "context",
                () => segmentInput.resolveExecutionContext(context),
              ),
              createTranscriptPublisher: publisher => traceNative(
                "transcript",
                () => segmentInput.createTranscriptPublisher(publisher),
              ),
            },
              {
                openDefinition: definition => traceNative(
                  "definition",
                  () => withNativeProtectedTaskDefinitionV1(definition),
                ),
                withMemoryRepository: memory => traceNative(
                  "memory",
                  () => withProtectedTaskNativeMemoryRepository(memory),
                ),
                withCheckpointSaver: checkpoint => traceNative(
                  "checkpoint",
                  () => withNativeProtectedTaskCheckpointManifest(checkpoint),
                ),
                runSegment: async segment => {
                  segment.signal.throwIfAborted();
                  expect(segment.execution.brief)
                    .toBe("Complete the connected protected Task");
                  segmentCalls.push(Object.freeze({
                    taskId: segment.taskId,
                    taskRunId: segment.taskRunId,
                    graphThreadId: segment.graphThreadId,
                  }));
                  segmentContinuationModes.push(
                    segment.execution.resume !== undefined
                      || segment.execution.continueFromCheckpoint === true,
                  );
                  if (scopedResult) {
                    const authority = protectedMemoryAuthorityFromEnvelope(segment.execution.subEnvelope);
                    if (authority === null || authority.mode !== "scope") {
                      throw new Error("Protected scoped occurrence lost its Scope authority");
                    }
                    base.scopeIds.add(authority.scopeId);
                    const [scope] = await base.admin.select({ parentAgentId: agentScopes.parentAgentId,
                      speakerUserId: agentScopes.speakerUserId, name: agentScopes.name })
                      .from(agentScopes).where(eq(agentScopes.id, authority.scopeId));
                    expect(scope).toEqual({ parentAgentId: base.productAgentId,
                      speakerUserId: base.userId, name: `task:${activeConnected.taskId}` });
                    const saved = await segment.memoryHandoff.repository.save({
                      operationId: `connected-scope-save:${activeConnected.taskRunId}`,
                      authority, type: "fact", content: "Memory from one protected Scope occurrence", importance: 0.8,
                    });
                    if (saved.status !== "success") throw new Error(`Protected scoped save failed: ${saved.reason}`);
                    base.memoryIds.add(saved.value.id);
                    const [stored] = await base.admin.select({ content: memories.content, objectId: memories.cryptoObjectId })
                      .from(memories).where(eq(memories.id, saved.value.id));
                    expect(stored?.content).toBeNull();
                    if (stored?.objectId === null || stored?.objectId === undefined) throw new Error("Scoped Memory ciphertext missing");
                    base.objectIds.add(stored.objectId);
                    expect(await base.admin.select({ scopeId: memoryScopes.scopeId }).from(memoryScopes)
                      .where(eq(memoryScopes.memoryId, saved.value.id))).toEqual([{ scopeId: authority.scopeId }]);
                  }
                  if (checkpointContinuationScenario
                    && segment.execution.continueFromCheckpoint !== true) {
                    firstCheckpointSegmentEntered.resolve();
                    const expectedReason = grantRefreshResume
                      ? "grant_refresh" as const
                      : "manual_pause" as const;
                    if (grantRefreshResume) {
                      if (refreshAuthorizationExpiresAt === null) {
                        throw new Error(
                          "Protected Task refresh deadline was unavailable",
                        );
                      }
                      // The production scheduler already armed against the
                      // authentic grant. Move its injected clock across that
                      // grant's pause threshold while the real timer remains
                      // responsible for requesting the checkpoint.
                      recoveryNow = refreshAuthorizationExpiresAt - 999;
                    }
                    const deadline = Date.now() + 10_000;
                    while (segment.protectedTaskCheckpointPauseController
                      ?.currentRequestedReason() !== expectedReason
                      && Date.now() < deadline) {
                      segment.signal.throwIfAborted();
                      await new Promise<void>(resolve => setTimeout(resolve, 10));
                    }
                    expect(segment.protectedTaskCheckpointPauseController
                      ?.currentRequestedReason()).toBe(expectedReason);
                    expect(segment.execution.resume).toBeUndefined();
                    expect(segment.execution.protectedTaskHumanResume)
                      .toBeUndefined();
                    await segment.checkpointSaver.put({
                      configurable: {
                        thread_id: segment.graphThreadId,
                        checkpoint_ns: "",
                      },
                    }, {
                      v: 4,
                      id: randomUUID(),
                      ts: new Date(NOW).toISOString(),
                      channel_values: {
                        protected_task_state: {
                          phase: expectedReason,
                        },
                      },
                      channel_versions: { protected_task_state: 1 },
                      versions_seen: {},
                    }, {
                      source: "loop",
                      step: 1,
                      parents: {},
                    }, { protected_task_state: 1 });
                    return Object.freeze({
                      status: "checkpoint_paused" as const,
                      threadId: segment.graphThreadId,
                      reason: expectedReason,
                    });
                  }
                  if (checkpointContinuationScenario) {
                    expect(segment.execution.continueFromCheckpoint).toBe(true);
                    expect(segment.execution.resume).toBeUndefined();
                    expect(segment.execution.protectedTaskHumanResume)
                      .toBeUndefined();
                  }
                  if (scenario === "parked continuation"
                    && segment.execution.resume === undefined) {
                    await segment.checkpointSaver.put({
                      configurable: {
                        thread_id: segment.graphThreadId,
                        checkpoint_ns: "",
                      },
                    }, {
                      v: 4,
                      id: randomUUID(),
                      ts: new Date(NOW).toISOString(),
                      channel_values: {
                        protected_task_state: {
                          phase: "awaiting_additional_authority",
                        },
                      },
                      channel_versions: { protected_task_state: 1 },
                      versions_seen: {},
                    }, {
                      source: "loop",
                      step: 1,
                      parents: {},
                    }, { protected_task_state: 1 });
                    const requiredAuthorityDigest =
                      protectedTaskSemanticAuthorityRequirementsDigest(
                        continuationRequirements,
                      );
                    return Object.freeze({
                      status: "interrupted" as const,
                      threadId: segment.graphThreadId,
                      interruptCoordinates: Object.freeze([Object.freeze({
                        id: "additional-authority-1",
                        kind: "additional_authority" as const,
                        requestId: continuationAuthorizationRequestId,
                      })]),
                      additionalAuthority: Object.freeze({
                        kind: "pre_effect_interrupt_v1" as const,
                        reason: "additional_authority" as const,
                        effectDisposition: "not_started_v1" as const,
                        interruptId: "additional-authority-1",
                        operationId: "connected-protected-memory-operation-1",
                        requestDigest: digest(
                          `connected-protected-memory-operation:${activeConnected.taskRunId}`,
                        ),
                        requiredAuthorityDigest,
                        semanticAuthorityRequirements: continuationRequirements,
                      }),
                    });
                  }
                  if (scenario === "parked continuation") {
                    expect(segment.execution.continueFromCheckpoint).toBeUndefined();
                    const resume = segment.execution.resume as Record<string, unknown>;
                    expect(Object.keys(resume)).toEqual(["additional-authority-1"]);
                    assertProtectedTaskAdditionalAuthorityResumeAcknowledgementV1(
                      resume["additional-authority-1"], {
                        authorizationRequestId: continuationAuthorizationRequestId,
                        effectDisposition: "not_started_v1",
                        operationId: "connected-protected-memory-operation-1",
                        requestDigest: digest(
                          `connected-protected-memory-operation:${activeConnected.taskRunId}`,
                        ),
                        requiredAuthorityDigest:
                          protectedTaskSemanticAuthorityRequirementsDigest(continuationRequirements),
                      },
                    );
                    controlledEffectExecutions += 1;
                  }
                  if (callerLocalExecution) {
                    const funding =
                      segment.execution.foregroundChatFundingSession;
                    const local = delegatedLocal.current;
                    const localPort =
                      segment.execution.delegatedLocalExecutionPort;
                    if (funding === undefined || local === null
                      || localPort === undefined || callerFunding === null) {
                      throw new Error(
                        "Caller-funded delegated Task execution was unavailable",
                      );
                    }
                    expect(segment.execution.modelId).toBe(
                      CALLER_LOCAL_MODEL_ID,
                    );
                    expect(funding).toMatchObject({
                      kind: "personal",
                      capabilityFunding: {
                        humanUserId: base.userId,
                        parentFundingKind: "personal",
                      },
                    });
                    const model = await invokeChatModelWithFallback(
                      [new HumanMessage(
                        "Return the deterministic protected fixture response.",
                      )],
                      [],
                      segment.execution.modelId,
                      base.userId,
                      base.productAgentId,
                      null,
                      undefined,
                      {
                        fundingHumanUserId: base.userId,
                        fundingSession: funding,
                        modelFallbackMode: "none",
                        sameModelRetryMode: "none",
                      },
                    );
                    const responseText = model.response.content;
                    expect(responseText).toBe(
                      "Synthetic caller-funded protected response.",
                    );
                    if (typeof responseText !== "string") {
                      throw new Error(
                        "Synthetic caller-funded response was not textual",
                      );
                    }
                    await local.invoke(localPort, funding);
                    return Object.freeze({
                      formatVersion: 1 as const,
                      resultText: responseText,
                      lastError: null,
                    });
                  }
                  return Object.freeze({
                    formatVersion: 1 as const,
                    resultText: "Connected protected result",
                    lastError: null,
                  });
                },
              },
              segmentOptions,
            ),
          });
          const prepare = async (
            preparation: Parameters<typeof native.prepareExecution>[0],
            repoDocsSelection?: Parameters<
              typeof native.prepareRepoDocsExecution
            >[0],
          ) => {
            let prepared: Awaited<ReturnType<typeof native.prepareExecution>>;
            try {
              prepared = repoDocsSelection === undefined
                ? await native.prepareExecution(preparation)
                : await native.prepareRepoDocsExecution(
                    repoDocsSelection,
                    preparation,
                  );
            } catch (error) {
              recordNativeError("prepare", error);
              throw error;
            }
            const executor: typeof prepared.executor = async function* (
              ...args: Parameters<typeof prepared.executor>
            ) {
              try {
                yield* prepared.executor(...args);
              } catch (error) {
                recordNativeError("execute", error);
                throw error;
              }
            };
            const openTransientInput: typeof prepared.openTransientInput =
              async grant => {
                try {
                  if (scenario === "pre-execution recovery") {
                    throw new Error("synthetic protected setup failure");
                  }
                  return await prepared.openTransientInput(grant);
                } catch (error) {
                  recordNativeError("open", error);
                  throw error;
                }
              };
            return Object.freeze({
              executor,
              openTransientInput,
              ...(prepared.requestCheckpointPause === undefined
                ? {}
                : {
                    requestCheckpointPause:
                      prepared.requestCheckpointPause,
                  }),
            });
          };
          return Object.freeze({
            prepareExecution: preparation => prepare(preparation),
            prepareRepoDocsExecution: (selection, preparation) =>
              prepare(preparation, selection),
            publishResult: async publication => {
              try {
                if (scenario === "abandoned running recovery") {
                  throw new Error(
                    "synthetic provider loss before protected result publication",
                  );
                }
                await native.publishResult(publication);
                if (scenario === "publication recovery") {
                  throw new Error("synthetic loss after result attachment");
                }
              } catch (error) {
                recordNativeError("publish_result", error);
                throw error;
              }
            },
          });
        },
      });
      closeComposition = composition.close;
      const occurrence = await loadInitialProtectedTaskOccurrence(
        base.productDb,
        {
          taskRunId: connected.taskRunId,
          authorizationRequestId:
            `task-run-authorization:${connected.taskRunId}`,
        },
      );
      if (occurrence === null) {
        throw new Error("Connected protected Task occurrence was unavailable");
      }
      if (historicalDefinition) {
        expect(occurrence.task.cryptoObjectId).toBe(connected.inputObjectId);
        expect(occurrence.task.definitionHistoricalRepair).toMatchObject({ version: 2 });
        expect(occurrence.task.cryptoAccessRevision).toBe(0);
      }
      const [currentPolicy, requesterHuman, requesterPrivateRoom] =
        await Promise.all([
          getEncryptionTransitionPolicy(base.productDb),
          findActorByOwnerId(base.userId),
          createProtectedTaskRequesterPrivateRoomResolver(base.productDb)(
            base.userId,
            base.productAgentId,
            base.namespaceValue,
          ),
        ]);
      expect(currentPolicy).toMatchObject({
        mode: cancellationTerminalShadow || wakeForegroundShadow || deepResearchShadow
          || protectedCodexShadow || protectedAcpShadow
          || recurringEncryptedOccurrences
          || historicalDefinition && !historicalDefinitionFull
          ? "shadow_encryption"
          : "encrypted_only",
        shadowBehavior: "strict",
        revision: base.policyRevision,
      });
      expect(requesterHuman?.id).toBe(base.humanActorId);
      expect(requesterPrivateRoom).toEqual({
        roomId: base.roomId,
        namespaceId: base.namespaceValue,
      });
      if (callerLocalExecution) {
        if (delegatedLocal.current === null || callerFunding === null) {
          throw new Error("Caller/local protected Task fixture was unavailable");
        }
        await delegatedLocal.current.disconnect();
        await composition.coordinator.observeProtectedTaskOccurrence(occurrence);
        expect(await base.admin.select({ id: jobs.id }).from(jobs).where(eq(
          jobs.laneKey,
          `task:${connected.taskId}`,
        ))).toHaveLength(0);
        expect(await base.admin.select({
          requestId: backgroundCryptoAuthorizationRequests.requestId,
        }).from(backgroundCryptoAuthorizationRequests).where(eq(
          backgroundCryptoAuthorizationRequests.requestId,
          `task-run-authorization:${connected.taskRunId}`,
        ))).toHaveLength(0);
        expect(recipients.size).toBe(0);
        expect(callerFunding.requests).toHaveLength(0);
        expect(delegatedLocal.current.messages).toHaveLength(0);
        await delegatedLocal.current.connect();
      }
      await composition.coordinator.observeProtectedTaskOccurrence(occurrence);
      expect(recipients.size).toBe(0);

      const deviceService = createProductionBackgroundAuthorizationComposition({
        crypto: base.crypto,
        serverScope: SERVER_SCOPE,
        now: liveOutputClock ? Date.now
          : grantRefreshResume ? () => recoveryNow : () => NOW,
        restricted: () => base.restricted,
        bindTaskRecipient: composition.bindTaskRecipient,
        withTaskAuthority: composition.withTaskAuthority,
        isTaskRecipientActive: composition.isTaskRecipientActive,
        wakeProtectedTask: composition.wakeProtectedTask,
      });
      const subject = Object.freeze({
        ...base.subject,
        admission: Object.freeze({
          deviceId: base.currentDevice.deviceId,
          deviceGeneration: base.currentDevice.deviceGeneration,
          serverInstanceId: base.currentDevice.serverInstanceId,
          lineageGeneration: base.currentDevice.lineageGeneration,
          epoch: base.currentDevice.epoch,
          securityRevision: base.currentDevice.securityRevision,
          headDigest: base.currentDevice.headDigest.slice(),
          expiresAt: NOW + (grantRefreshResume
            ? 2 * TASK_RUNTIME_AUTHORIZATION_ABSOLUTE_LIMIT_MS
            : wakeProjectionContinuation || recurringEncryptedOccurrences
              ? 180_000
              : 60_000),
        }),
      });
      const grantRequest = async (
        service: ReturnType<
          typeof createProductionBackgroundAuthorizationComposition
        >,
        expectedRequestId: string,
      ): Promise<void> => {
        const page = await service.list(subject, {});
        let selected: ReturnType<
          typeof decodeTaskRuntimeBackgroundAuthorizationRequestBase
        > = null;
        let selectedBytes: Uint8Array | null = null;
        for (const candidate of page.requests) {
          const decoded = decodeTaskRuntimeBackgroundAuthorizationRequestBase(
            base.crypto,
            candidate.requestBytes,
          );
          if (decoded?.requestId === expectedRequestId) {
            selected = decoded;
            selectedBytes = candidate.requestBytes;
            break;
          }
          if (decoded !== null) {
            destroyTaskRuntimeBackgroundAuthorizationRequestV1(decoded);
          }
        }
        if (selected === null || selectedBytes === null) {
          throw new Error(
            "Connected protected Task device request was unavailable",
          );
        }
        const plan = parseDomainForegroundAuthorizationPlanV2(
          selected.authorizationPlanBytes,
        );
        if (plan === null) {
          destroyTaskRuntimeBackgroundAuthorizationRequestV1(selected);
          throw new Error(
            "Connected protected Task authorization plan was invalid",
          );
        }
        let responseBytes: Uint8Array | null = null;
        const domains = await loadConnectedDomainSecrets(
          base,
          selected.requestId,
        );
        try {
          const authorization = await mintDomainForegroundAuthorization(
            base.crypto,
            {
              plan,
              domains,
              committerDeviceSigningPrivateKey: base.signingPrivateKey,
              recipientEncryptionPublicKey: selected.recipientPublicKey,
            },
          );
          try {
            const authorizationBytes = serializeDomainForegroundAuthorizationV2(
              authorization,
            );
            if (isTaskRuntimeBackgroundAuthorizationRequestV2Carrier(selectedBytes)
              || isTaskRuntimeBackgroundAuthorizationRequestV3Carrier(selectedBytes)) {
              let authorizationHash: Uint8Array | undefined;
              let certificateBytes: Uint8Array | undefined;
              try {
                authorizationHash = base.crypto.hash(authorizationBytes);
                certificateBytes = createTaskRuntimeSignerAuthorization(base.crypto, {
                  requestBytes: selectedBytes, authorizationBytes,
                  expectedAuthorizationPlanBytes: selected.authorizationPlanBytes,
                  expectedAuthorizationHash: authorizationHash,
                  issuerSigningPrivateKey: base.signingPrivateKey,
                });
                responseBytes = encodeTaskRuntimeBackgroundAuthorizationResponseV2({
                  authorizationBytes, certificateBytes,
                });
              } finally {
                authorizationBytes.fill(0);
                authorizationHash?.fill(0);
                certificateBytes?.fill(0);
              }
            } else {
              responseBytes = authorizationBytes;
            }
            expect(await service.respond(subject, { responseBytes })).toEqual({ status: "accepted" });
          } finally {
            destroyDomainForegroundAuthorizationV2(authorization);
          }
        } finally {
          responseBytes?.fill(0);
          selectedBytes.fill(0);
          destroyConnectedDomainSecrets(domains);
          destroyDomainForegroundAuthorizationPlanV2(plan);
          destroyTaskRuntimeBackgroundAuthorizationRequestV1(selected);
        }
      };
      const grantConnectedRequest = (expectedRequestId: string) =>
        grantRequest(deviceService, expectedRequestId);
      await grantConnectedRequest(
        `task-run-authorization:${connected.taskRunId}`,
      );
      expect(recipients.size).toBe(1);
      expect(kicks).toBe(1);
      if (grantRefreshResume) {
        const [authorization] = await base.admin.select({
          expiresAt:
            backgroundCryptoAuthorizationRequests.authorizationExpiresAt,
        }).from(backgroundCryptoAuthorizationRequests).where(eq(
          backgroundCryptoAuthorizationRequests.requestId,
          `task-run-authorization:${connected.taskRunId}`,
        ));
        if (!(authorization?.expiresAt instanceof Date)) {
          throw new Error("Protected Task refresh grant expiry was unavailable");
        }
        refreshAuthorizationExpiresAt = authorization.expiresAt.getTime();
        recoveryNow = refreshAuthorizationExpiresAt - 4_000;
      }

      if (cancellationArchiveScenario) {
        const initialRequestId = `task-run-authorization:${connected.taskRunId}`;
        const cancellationRequestId =
          `task-run-cancellation-result-authorization:${connected.taskRunId}`;
        const cancellationObjectId = deriveTaskContentCryptoObjectIdV1({
          kind: "run_result",
          taskId: connected.taskId,
          taskRunId: connected.taskRunId,
          contentRevision: 2,
        });
        base.requestIds.add(cancellationRequestId);
        base.objectIds.add(cancellationObjectId);
        const cancellationStoppedAt = new Date(liveOutputClock ? Date.now() : NOW);
        expect(await transitionTaskLifecycleTerminal(base.productDb, {
          taskId: connected.taskId,
          taskStatus: "cancelled",
          taskPatch: { cancelledAt: cancellationStoppedAt },
          runId: connected.taskRunId,
          runStatus: "cancelled",
        })).toMatchObject({
          transitioned: true,
          task: undefined, run: undefined,
          protectedTask: { status: "cancelled" },
          protectedRun: { status: "cancelled", jobId: null },
        });
        const cancellationCandidates = await listProtectedTaskCancellationOutputCandidates(
          base.productDb,
          { limit: 2, throughTime: new Date(liveOutputClock ? Date.now() : recoveryNow) },
        );
        expect(cancellationCandidates.candidates.map(candidate => ({
          taskId: candidate.taskId,
          taskRunId: candidate.taskRunId,
          resultState: candidate.resultState,
        }))).toEqual([{
          taskId: connected.taskId,
          taskRunId: connected.taskRunId,
          resultState: "unmapped",
        }]);
        await composition.coordinator.recoverBeforeObservation(100);
        expect(recipients.size).toBe(0);
        const [settledExecution, awaitingCancellation] = await Promise.all([
          base.admin.select({
            state: backgroundCryptoAuthorizationRequests.state,
            reason: backgroundCryptoAuthorizationRequests.terminalReason,
          }).from(backgroundCryptoAuthorizationRequests).where(eq(
            backgroundCryptoAuthorizationRequests.requestId,
            initialRequestId,
          )).then(rows => rows[0]),
          base.admin.select({
            state: backgroundCryptoAuthorizationRequests.state,
          }).from(backgroundCryptoAuthorizationRequests).where(eq(
            backgroundCryptoAuthorizationRequests.requestId,
            cancellationRequestId,
          )).then(rows => rows[0]),
        ]);
        expect(settledExecution).toEqual({
          state: "cancelled",
          reason: "cancelled",
        });
        expect(awaitingCancellation).toEqual({ state: "awaiting_recipient" });
        await grantConnectedRequest(cancellationRequestId);
        expect(recipients.size).toBe(1);

        const cancellationRepository = new PostgresBackgroundAuthorizationRepository(
          base.cryptoHandle,
        );
        const cancellationAuthority = createProtectedTaskCancellationAuthorityPort({
          db: base.productDb,
          restricted: () => base.restricted,
          crypto: base.crypto,
          serverScope: SERVER_SCOPE,
          now: liveOutputClock ? Date.now : () => recoveryNow,
        });
        const cancellationPreparation = createProtectedTaskCancellationPreparation({
          db: base.productDb,
          restricted: () => base.restricted,
          crypto: base.crypto,
          serverScope: SERVER_SCOPE,
          recipients,
          recipientTtlMs: TASK_RUNTIME_AUTHORIZATION_ABSOLUTE_LIMIT_MS,
          now: liveOutputClock ? Date.now : () => recoveryNow,
        });
        const granted = await cancellationRepository.get(cancellationRequestId);
        if (granted?.snapshot.formatVersion !== 3
          || granted.snapshot.credentialSubject.kind !== "runtime"
          || granted.snapshot.credentialSubject.runtimeKind !== "task"
          || granted.snapshot.credentialSubject.runtimeVersion !== 1
          || granted.workKind !== "task.cancel_result"
          || granted.purpose !== "task.cancel_result") {
          throw new Error("Cancellation authorization was not grant-ready");
        }
        const grantedCancellation = granted as BackgroundAuthorizationTaskRuntimeRecordV3;
        const cancellationPlan = await cancellationPreparation.resolvePlan(grantedCancellation);
        if (cancellationPlan === null) {
          throw new Error("Cancellation authorization plan was unavailable");
        }
        const stageOnlyPublication = createProtectedTaskCancellationPublication({
          db: base.productDb,
          restricted: base.restricted,
          crypto: base.crypto,
          owner,
          serverScope: SERVER_SCOPE,
          authority: cancellationAuthority,
          now: liveOutputClock ? Date.now : () => recoveryNow,
        }, {
          recover: () => {
            throw new Error("synthetic loss after cancellation stage");
          },
        });
        const stageOnlyClaim = createProtectedTaskCancellationClaim({
          authority: cancellationAuthority,
          recipients,
          repository: async connection => new PostgresBackgroundAuthorizationRepository(
            await verifyCryptoPostgresHandle(connection),
          ),
          publish: stageOnlyPublication,
          now: liveOutputClock ? Date.now : () => recoveryNow,
        });
        let stageError: unknown;
        try {
          await stageOnlyClaim({
            plan: cancellationPlan,
            record: grantedCancellation,
            restricted: base.restricted,
            signal: new AbortController().signal,
          });
        } catch (error) {
          if (!(error instanceof Error)
            || error.message !== "synthetic loss after cancellation stage") {
            throw error;
          }
          stageError = error;
        }
        expect(stageError).toBeInstanceOf(Error);
        expect((stageError as Error).message).toBe(
          "synthetic loss after cancellation stage",
        );
        // Opening a grant is one-shot custody even when publication crashes.
        expect(recipients.size).toBe(0);
        expect(await base.admin.select({
          requestId: taskCancellationCryptoStagingReceipts.requestId,
          objectId: taskCancellationCryptoStagingReceipts.cryptoObjectId,
        }).from(taskCancellationCryptoStagingReceipts).where(eq(
          taskCancellationCryptoStagingReceipts.requestId,
          cancellationRequestId,
        ))).toEqual([{
          requestId: cancellationRequestId,
          objectId: cancellationObjectId,
        }]);
        expect(await objectRowCounts(base, cancellationObjectId)).toEqual({
          payload: 1,
          head: 1,
          manifest: 1,
          envelope: 1,
        });
        expect(await base.admin.select({
          revision: taskRunResultCryptoRevisions.resultRevision,
        }).from(taskRunResultCryptoRevisions).where(and(
          eq(taskRunResultCryptoRevisions.taskId, connected.taskId),
          eq(taskRunResultCryptoRevisions.taskRunId, connected.taskRunId),
          eq(taskRunResultCryptoRevisions.resultRevision, 2),
        ))).toEqual([]);
        let settlementReleaseCalls = 0;
        const settlementRecipients = Object.freeze({
          delete: (...args: Parameters<TaskRuntimeRecipientRegistry["delete"]>) => {
            settlementReleaseCalls += 1;
            return recipients.delete(...args);
          },
        });
        const createSettlement = async (
          context: Parameters<Parameters<
            typeof createProtectedTaskCancellationPublicationRecovery
          >[0]["settle"]>[2],
        ) => createProtectedTaskCancellationSettlement({
          db: context.db,
          repository: new PostgresBackgroundAuthorizationRepository(
            await verifyCryptoPostgresHandle(context.restricted),
          ),
          recipients: settlementRecipients,
          now: liveOutputClock ? Date.now : () => recoveryNow,
          deferRecipientCleanup: context.deferRecipientCleanup,
        });
        const cancellationRecovery = createProtectedTaskCancellationPublicationRecovery({
          db: base.productDb,
          restricted: base.restricted,
          crypto: base.crypto,
          serverScope: SERVER_SCOPE,
          // Product reconciliation leases use PostgreSQL wall-clock time.
          // The signed fixture grant keeps its independent deterministic clock.
          now: Date.now,
          settle: async (coordinates, verifyStaged, context) =>
            (await createSettlement(context))(coordinates, verifyStaged),
        }, cancellationGate !== null ? {
          withAuthority: cancellationGate.withAuthority,
        } : cancellationRollbackAuthority !== null ? {
          withAuthority: cancellationRollbackAuthority,
        } : {});
        const archiveRoom = () => base.productDb.update(rooms).set({
          archivedAt: new Date(NOW + 1),
          updatedAt: new Date(NOW + 1),
        }).where(eq(rooms.id, base.roomId)).execute();
        if (scenario === "cancellation archive-first denial") {
          await archiveRoom();
          expect(await cancellationRecovery({
            taskId: connected.taskId,
            taskRunId: connected.taskRunId,
          })).toBe("pending");
          expect(await base.admin.select({
            requestId: taskCancellationCryptoStagingReceipts.requestId,
            objectId: taskCancellationCryptoStagingReceipts.cryptoObjectId,
          }).from(taskCancellationCryptoStagingReceipts).where(eq(
            taskCancellationCryptoStagingReceipts.requestId,
            cancellationRequestId,
          ))).toEqual([{
            requestId: cancellationRequestId,
            objectId: cancellationObjectId,
          }]);
          expect(await objectRowCounts(base, cancellationObjectId)).toEqual({
            payload: 1,
            head: 1,
            manifest: 1,
            envelope: 1,
          });
          expect(await base.admin.select({
            revision: taskRunResultCryptoRevisions.resultRevision,
          }).from(taskRunResultCryptoRevisions).where(and(
            eq(taskRunResultCryptoRevisions.taskId, connected.taskId),
            eq(taskRunResultCryptoRevisions.taskRunId, connected.taskRunId),
            eq(taskRunResultCryptoRevisions.resultRevision, 2),
          ))).toEqual([]);
          const [run] = await base.admin.select({
            revision: taskRuns.resultRevision,
            mapping: taskRuns.resultCryptoMappingState,
          }).from(taskRuns).where(eq(taskRuns.id, connected.taskRunId));
          expect(run).toEqual({ revision: 0, mapping: "unmapped" });
          const [request] = await base.admin.select({
            state: backgroundCryptoAuthorizationRequests.state,
          }).from(backgroundCryptoAuthorizationRequests).where(eq(
            backgroundCryptoAuthorizationRequests.requestId,
            cancellationRequestId,
          ));
          expect(request).toEqual({ state: "running" });
          expect(settlementReleaseCalls).toBe(0);
          expect(segmentCalls).toEqual([]);
        } else if (cancellationProductRollback) {
          let rollbackError: unknown;
          try {
            await cancellationRecovery({
              taskId: connected.taskId,
              taskRunId: connected.taskRunId,
            });
          } catch (error) {
            rollbackError = error;
          }
          expect(rollbackError).toBeInstanceOf(Error);
          expect((rollbackError as Error).message).toBe(
            "synthetic loss before cancellation product commit",
          );
          const [mappedRun, unattached, completedRequest] = await Promise.all([
            base.admin.select({
              revision: taskRuns.resultRevision,
              mapping: taskRuns.resultCryptoMappingState,
            }).from(taskRuns).where(eq(taskRuns.id, connected.taskRunId))
              .then(rows => rows[0]),
            base.admin.select({
              attachedAt: protectedTaskRunOutputBindings.resultAttachedAt,
            }).from(protectedTaskRunOutputBindings).where(eq(
              protectedTaskRunOutputBindings.taskRunId,
              connected.taskRunId,
            )).then(rows => rows[0]),
            base.admin.select({
              state: backgroundCryptoAuthorizationRequests.state,
            }).from(backgroundCryptoAuthorizationRequests).where(eq(
              backgroundCryptoAuthorizationRequests.requestId,
              cancellationRequestId,
            )).then(rows => rows[0]),
          ]);
          expect(mappedRun).toEqual({ revision: 2, mapping: "verified" });
          expect(unattached?.attachedAt).toBeNull();
          expect(completedRequest).toEqual({ state: "completed" });
          expect(settlementReleaseCalls).toBe(0);
          expect(await cancellationRecovery({
            taskId: connected.taskId,
            taskRunId: connected.taskRunId,
          })).toBe("mapped");
          const [attached] = await base.admin.select({
            attachedAt: protectedTaskRunOutputBindings.resultAttachedAt,
          }).from(protectedTaskRunOutputBindings).where(eq(
            protectedTaskRunOutputBindings.taskRunId,
            connected.taskRunId,
          ));
          expect(attached?.attachedAt).toEqual(cancellationStoppedAt);
          expect(settlementReleaseCalls).toBe(1);
          expect(segmentCalls).toEqual([]);
        } else if (cancellationTerminalMessage) {
          const cancellationRecovered = await cancellationRecovery({
            taskId: connected.taskId,
            taskRunId: connected.taskRunId,
          });
          if (cancellationRecovered !== "mapped") {
            const [ledger, run, binding, authorization] = await Promise.all([
              base.admin.select({ completion: taskRunResultCryptoRevisions.completion,
                disposition: taskRunResultCryptoRevisions.disposition,
              }).from(taskRunResultCryptoRevisions).where(and(
                eq(taskRunResultCryptoRevisions.taskRunId, connected.taskRunId),
                eq(taskRunResultCryptoRevisions.resultRevision, 2),
              )),
              base.admin.select({ revision: taskRuns.resultRevision,
                mapping: taskRuns.resultCryptoMappingState,
              }).from(taskRuns).where(eq(taskRuns.id, connected.taskRunId)),
              base.admin.select({ attachedAt: protectedTaskRunOutputBindings.resultAttachedAt,
                completedAt: protectedTaskRunOutputBindings.completedAt,
              }).from(protectedTaskRunOutputBindings).where(eq(
                protectedTaskRunOutputBindings.taskRunId, connected.taskRunId,
              )),
              base.admin.select({ state: backgroundCryptoAuthorizationRequests.state,
                finishedAt: backgroundCryptoAuthorizationRequests.finishedAt,
              }).from(backgroundCryptoAuthorizationRequests).where(eq(
                backgroundCryptoAuthorizationRequests.requestId, cancellationRequestId,
              )),
            ]);
            console.error("Cancellation recovery state", {
              outcome: cancellationRecovered, ledger, run, binding, authorization,
            });
          }
          expect(cancellationRecovered).toBe("mapped");
          const deliveryRequestId =
            `task-run-delivery-message-authorization:${connected.taskRunId}`;
          base.requestIds.add(deliveryRequestId);
          const terminalMessages = createProtectedTaskTerminalMessageComposition({
            db: base.productDb,
            restricted: base.restricted,
            crypto: base.crypto,
            owner,
            serverScope: SERVER_SCOPE,
            recipients,
            recipientTtlMs: TASK_RUNTIME_AUTHORIZATION_ABSOLUTE_LIMIT_MS,
            now: Date.now,
          });
          const terminalDevice = createProductionBackgroundAuthorizationComposition({
            crypto: base.crypto,
            serverScope: SERVER_SCOPE,
            now: Date.now,
            restricted: () => base.restricted,
            bindTaskRecipient: terminalMessages.bindTaskRecipient,
            withTaskAuthority: terminalMessages.withTaskAuthority,
            isTaskRecipientActive: terminalMessages.isTaskRecipientActive,
            wakeProtectedTask: () => undefined,
          });
          expect(await terminalMessages.recoverPage({ limit: 10 }))
            .toMatchObject({ attempted: 1, published: 0, pending: 1,
              failures: 0 });
          const [awaitingDelivery] = await base.admin.select({
            state: backgroundCryptoAuthorizationRequests.state,
          }).from(backgroundCryptoAuthorizationRequests).where(eq(
            backgroundCryptoAuthorizationRequests.requestId,
            deliveryRequestId,
          ));
          expect(awaitingDelivery).toEqual({ state: "awaiting_recipient" });
          if (!cancellationTerminalShadow) {
            await base.admin.update(encryptionTransitionPolicy).set({
              mode: "shadow_encryption",
              shadowBehavior: "strict",
              shadowEncryptionStartedAt: new Date(recoveryNow),
              updatedAt: new Date(recoveryNow),
            }).where(eq(encryptionTransitionPolicy.id, "server"));
            expect(await terminalMessages.recoverPage({ limit: 10 }))
              .toMatchObject({ attempted: 1, published: 0, pending: 1,
                failures: 0 });
            expect(await base.admin.select({
              requestId: taskTerminalMessageCryptoStagingReceipts.requestId,
            }).from(taskTerminalMessageCryptoStagingReceipts).where(eq(
              taskTerminalMessageCryptoStagingReceipts.requestId,
              deliveryRequestId,
            ))).toHaveLength(0);
            await base.admin.update(encryptionTransitionPolicy).set({
              mode: "encrypted_only",
              shadowBehavior: "strict",
              shadowEncryptionStartedAt: new Date(NOW),
              updatedAt: new Date(recoveryNow),
            }).where(eq(encryptionTransitionPolicy.id, "server"));
          }
          await grantRequest(terminalDevice, deliveryRequestId);
          expect(recipients.size).toBe(1);

          if (!cancellationTerminalShadow) {
            const terminalRepository = new PostgresBackgroundAuthorizationRepository(
              base.cryptoHandle,
            );
            const terminalAuthority = createProtectedTaskTerminalMessageAuthorityPort({
              db: base.productDb,
              restricted: () => base.restricted,
              crypto: base.crypto,
              serverScope: SERVER_SCOPE,
              now: Date.now,
            });
            const terminalPreparation = createProtectedTaskTerminalMessagePreparation({
              db: base.productDb,
              restricted: () => base.restricted,
              crypto: base.crypto,
              owner,
              serverScope: SERVER_SCOPE,
              recipients,
              recipientTtlMs: TASK_RUNTIME_AUTHORIZATION_ABSOLUTE_LIMIT_MS,
              now: Date.now,
            });
            const granted = await terminalRepository.get(deliveryRequestId);
            if (granted?.snapshot.formatVersion !== 3
              || granted.snapshot.credentialSubject.kind !== "runtime"
              || granted.snapshot.credentialSubject.runtimeKind !== "task"
              || granted.snapshot.credentialSubject.runtimeVersion !== 1
              || granted.workKind !== "task.deliver_message"
              || granted.purpose !== "task.deliver_message"
              || granted.snapshot.state !== "grant_ready") {
              throw new Error("Terminal Message authorization was not grant-ready");
            }
            const grantedTerminal = granted as BackgroundAuthorizationTaskRuntimeRecordV3;
            const terminalPlan = await terminalPreparation.resolvePlan(grantedTerminal);
            if (terminalPlan === null) {
              throw new Error("Terminal Message authorization plan was unavailable");
            }
            const stageOnlyPublication = createProtectedTaskTerminalMessagePublication({
              restricted: base.restricted,
              crypto: base.crypto,
              owner,
              serverScope: SERVER_SCOPE,
              authority: terminalAuthority,
              recover: () => {
                throw new Error("synthetic loss after terminal Message stage");
              },
            });
            const stageOnlyClaim = createProtectedTaskTerminalMessageClaim({
              crypto: base.crypto,
              authority: terminalAuthority,
              recipients,
              repository: async connection =>
                new PostgresBackgroundAuthorizationRepository(
                  await verifyCryptoPostgresHandle(connection),
                ),
              publish: stageOnlyPublication,
              now: Date.now,
            });
            let stageError: unknown;
            try {
              await stageOnlyClaim({
                plan: terminalPlan,
                record: grantedTerminal,
                restricted: base.restricted,
                signal: new AbortController().signal,
              });
            } catch (error) {
              if (!(error instanceof Error)
                || error.message !== "synthetic loss after terminal Message stage") {
                throw error;
              }
              stageError = error;
            }
            expect(stageError).toBeInstanceOf(Error);
            expect(recipients.size).toBe(0);
            expect(await base.admin.select({
              requestId: taskTerminalMessageCryptoStagingReceipts.requestId,
            }).from(taskTerminalMessageCryptoStagingReceipts).where(eq(
              taskTerminalMessageCryptoStagingReceipts.requestId,
              deliveryRequestId,
            ))).toEqual([{ requestId: deliveryRequestId }]);
            await base.admin.delete(
              backgroundCryptoAuthorizationNamespaceRequirements,
            ).where(eq(
              backgroundCryptoAuthorizationNamespaceRequirements.requestId,
              deliveryRequestId,
            ));
            await base.admin.delete(
              backgroundCryptoAuthorizationDomainRequirements,
            ).where(eq(
              backgroundCryptoAuthorizationDomainRequirements.requestId,
              deliveryRequestId,
            ));
            await base.admin.delete(backgroundCryptoAuthorizationRequests)
              .where(eq(
                backgroundCryptoAuthorizationRequests.requestId,
                deliveryRequestId,
              ));
          }
          expect(await terminalMessages.recoverPage({ limit: 10 }))
            .toMatchObject({ attempted: 1, published: 1, pending: 0,
              failures: 0 });

          const [binding] = await base.admin.select().from(
            protectedTaskRunOutputBindings,
          ).where(eq(
            protectedTaskRunOutputBindings.taskRunId,
            connected.taskRunId,
          ));
          expect(binding).toMatchObject({
            deliveryMode: "raw",
            resultRevision: 2,
            destinationRoomId: base.roomId,
          });
          expect(binding?.resultAttachedAt).toEqual(cancellationStoppedAt);
          expect(binding?.messageId).toBeNumber();
          expect(binding?.messagePublishedAt).toBeInstanceOf(Date);
          expect(binding?.completedAt).toEqual(binding?.messagePublishedAt);
          const sessionRows = await base.admin.select({
            id: sessions.id,
            threadId: sessions.threadId,
            roomId: sessions.roomId,
            ownerId: sessions.ownerId,
          }).from(sessions).where(eq(sessions.roomId, base.roomId));
          const publishedSession = sessionRows.find(row =>
            row.id !== undefined && row.ownerId === base.userId);
          expect(publishedSession).toBeDefined();
          if (typeof binding?.messageId !== "number"
            || publishedSession === undefined) {
            throw new Error("Terminal Message allocation was unavailable");
          }
          base.sessionThreadIds.add(publishedSession.threadId);
          const publishedMessageId = binding.messageId;
          const [message] = await base.admin.select({
            id: sessionMessages.id,
            sessionId: sessionMessages.sessionId,
            role: sessionMessages.role,
            content: sessionMessages.content,
            objectId: sessionMessages.cryptoObjectId,
          }).from(sessionMessages).where(and(
            eq(sessionMessages.id, publishedMessageId),
            eq(sessionMessages.sessionId, publishedSession.id),
          ));
          expect(message).toMatchObject({
            role: "assistant",
            content: cancellationTerminalShadow
              ? PROTECTED_TASK_CANCELLED_RESULT
              : null,
          });
          if (typeof message?.objectId !== "string"
            || typeof binding?.messageOperationId !== "string") {
            throw new Error("Mapped terminal Message identity was unavailable");
          }
          const messageObjectId = message.objectId;
          const messageOperationId = binding.messageOperationId;
          expect(messageObjectId).toMatch(/^message:v2:[0-9a-f]{64}$/u);
          const [revision, association, receipt, authorization] =
            await Promise.all([
              base.admin.select({
                completion: sessionMessageCryptoRevisions.completion,
                disposition: sessionMessageCryptoRevisions.disposition,
                objectId: sessionMessageCryptoRevisions.cryptoObjectId,
              }).from(sessionMessageCryptoRevisions).where(and(
                eq(sessionMessageCryptoRevisions.sessionId,
                  publishedSession.id),
                eq(sessionMessageCryptoRevisions.messageId,
                  publishedMessageId),
              )).then(rows => rows[0]),
              base.admin.select({
                kind: taskRunMessageAssociations.kind,
                publicationKey: taskRunMessageAssociations.publicationKey,
              }).from(taskRunMessageAssociations).where(eq(
                taskRunMessageAssociations.taskRunId,
                connected.taskRunId,
              )).then(rows => rows[0]),
              base.admin.select({
                requestId: taskTerminalMessageCryptoStagingReceipts.requestId,
                objectId:
                  taskTerminalMessageCryptoStagingReceipts.cryptoObjectId,
              }).from(taskTerminalMessageCryptoStagingReceipts).where(eq(
                taskTerminalMessageCryptoStagingReceipts.requestId,
                deliveryRequestId,
              )).then(rows => rows[0]),
              base.admin.select({
                state: backgroundCryptoAuthorizationRequests.state,
              }).from(backgroundCryptoAuthorizationRequests).where(eq(
                backgroundCryptoAuthorizationRequests.requestId,
                deliveryRequestId,
              )).then(rows => rows[0]),
            ]);
          expect(revision).toEqual({
            completion: "complete",
            disposition: "mapped",
            objectId: messageObjectId,
          });
          expect(association).toEqual({
            kind: "raw_delivery",
            publicationKey: messageOperationId,
          });
          expect(receipt).toEqual({
            requestId: deliveryRequestId,
            objectId: messageObjectId,
          });
          expect(authorization).toEqual(cancellationTerminalShadow
            ? { state: "completed" }
            : undefined);
          expect(recipients.size).toBe(0);
          expect(await terminalMessages.recoverPage({ limit: 10 }))
            .toMatchObject({ attempted: 0, published: 0, pending: 0,
              failures: 0 });
          expect(segmentCalls).toEqual([]);
        } else {
          if (cancellationGate === null) {
            throw new Error("Cancellation archive gate was unavailable");
          }
          const recovery = cancellationRecovery({
            taskId: connected.taskId,
            taskRunId: connected.taskRunId,
          });
          try {
            await Promise.race([
              cancellationGate.entered,
              recovery.then(result => {
                throw new Error(
                  `Cancellation recovery finished before its ${cancellationArchivePhase} authority phase: ${result}`,
                );
              }),
            ]);
          } catch (error) {
            cancellationGate.release();
            await Promise.allSettled([recovery]);
            throw error;
          }
          const archive = archiveRoom();
          try {
            await waitForBlockedContender(
              base,
              await cancellationGate.pid,
              `Room archive did not wait for cancellation ${cancellationArchivePhase}`,
            );
            cancellationGate.release();
            const [recoveryResult] = await Promise.all([recovery, archive]);
            expect(recoveryResult).toBe(
              cancellationArchivePhase === "publication" ? "pending" : "mapped",
            );
          } catch (error) {
            cancellationGate.release();
            await Promise.allSettled([recovery, archive]);
            throw error;
          }
          const [room, run, binding, request] = await Promise.all([
            base.admin.select({ archivedAt: rooms.archivedAt }).from(rooms)
              .where(eq(rooms.id, base.roomId)).then(rows => rows[0]),
            base.admin.select({
              revision: taskRuns.resultRevision,
              objectId: taskRuns.resultCryptoObjectId,
              mapping: taskRuns.resultCryptoMappingState,
            }).from(taskRuns).where(eq(taskRuns.id, connected.taskRunId))
              .then(rows => rows[0]),
            base.admin.select({
              attachedAt: protectedTaskRunOutputBindings.resultAttachedAt,
              completedAt: protectedTaskRunOutputBindings.completedAt,
            }).from(protectedTaskRunOutputBindings).where(eq(
              protectedTaskRunOutputBindings.taskRunId,
              connected.taskRunId,
            )).then(rows => rows[0]),
            base.admin.select({
              state: backgroundCryptoAuthorizationRequests.state,
            }).from(backgroundCryptoAuthorizationRequests).where(eq(
              backgroundCryptoAuthorizationRequests.requestId,
              cancellationRequestId,
            )).then(rows => rows[0]),
          ]);
          expect(room?.archivedAt).toEqual(new Date(NOW + 1));
          expect(run).toEqual({
            revision: 2,
            objectId: cancellationObjectId,
            mapping: "verified",
          });
          expect(await objectRowCounts(base, cancellationObjectId)).toEqual({
            payload: 1,
            head: 1,
            manifest: 1,
            envelope: 1,
          });
          if (cancellationArchivePhase === "publication") {
            expect(binding?.attachedAt).toBeNull();
            expect(request?.state).not.toBe("completed");
            expect(settlementReleaseCalls).toBe(0);
            // The queued archive wins before the fresh settlement phase. A
            // retry must preserve the mapped result without releasing custody.
            expect(await cancellationRecovery({
              taskId: connected.taskId,
              taskRunId: connected.taskRunId,
            })).toBe("pending");
            const [unchanged] = await base.admin.select({
              attachedAt: protectedTaskRunOutputBindings.resultAttachedAt,
            }).from(protectedTaskRunOutputBindings).where(eq(
              protectedTaskRunOutputBindings.taskRunId,
              connected.taskRunId,
            ));
            expect(unchanged?.attachedAt).toBeNull();
            expect(settlementReleaseCalls).toBe(0);
          } else {
            expect(binding?.attachedAt).toEqual(cancellationStoppedAt);
            expect(request).toEqual({ state: "completed" });
            expect(settlementReleaseCalls).toBe(1);
          }
          expect(binding?.completedAt).toBeNull();
          expect(segmentCalls).toEqual([]);
        }
      } else if (scenario === "cancellation recovery") {
        const requestId = `task-run-authorization:${connected.taskRunId}`;
        const persistOrphan = async () => {
          const jobId = await persistJobWithDatabase(base.productDb, {
            ownerId: base.userId,
            requestorId: base.userId,
            laneKey: `task:${connected!.taskId}`,
            type: "foreground",
            input: {
              kind: "protected_task_run_v1",
              taskId: connected!.taskId,
              taskRunId: connected!.taskRunId,
              inputObjectId: connected!.inputObjectId,
              resultObjectId: connected!.resultObjectId,
              authorizationRequestId: requestId,
              policyRevision: base.policyRevision,
              executionSegment: 1,
            },
            publicationPolicy: {
              expectedRevision: base.policyRevision,
              representation: "protected_only",
            },
          });
          base.jobIds.add(jobId);
          return jobId;
        };
        // Simulate process loss after persistence but before attaching the Job.
        const orphanIds = [await persistOrphan(), await persistOrphan()];
        expect(await transitionTaskLifecycleTerminal(base.productDb, {
          taskId: connected.taskId,
          taskStatus: "cancelled",
          taskPatch: { cancelledAt: new Date(NOW) },
          runStatus: "cancelled",
        })).toMatchObject({ transitioned: true,
          task: undefined, run: undefined,
          protectedTask: { status: "cancelled" }, protectedRun: { status: "cancelled", jobId: null } });
        await composition.coordinator.recoverBeforeObservation(100);
        expect(recipients.size).toBe(0);
        const [grant] = await base.admin.select({
          state: backgroundCryptoAuthorizationRequests.state,
          reason: backgroundCryptoAuthorizationRequests.terminalReason,
          finishedAt: backgroundCryptoAuthorizationRequests.finishedAt,
        }).from(backgroundCryptoAuthorizationRequests).where(eq(
          backgroundCryptoAuthorizationRequests.requestId, requestId,
        ));
        expect(grant).toMatchObject({ state: "cancelled", reason: "cancelled" });
        expect(grant?.finishedAt).not.toBeNull();
        // A persistence transaction already in flight can arrive after revocation.
        orphanIds.push(await persistOrphan());
        await composition.coordinator.recoverBeforeObservation(100);
        const orphanRows = await base.admin.select({
          status: jobs.status, startedAt: jobs.startedAt,
          completedAt: jobs.completedAt, result: jobs.result, message: jobs.message,
        }).from(jobs).where(inArray(jobs.id, orphanIds));
        expect(orphanRows).toHaveLength(3);
        for (const job of orphanRows) {
          expect(job).toMatchObject({ status: "cancelled", startedAt: null,
            result: null, message: null });
          expect(job.completedAt).not.toBeNull();
        }
        expect(segmentCalls).toEqual([]);
        expect(await loadInitialProtectedTaskOccurrence(base.productDb, {
          taskRunId: connected.taskRunId, authorizationRequestId: requestId,
        })).toBeNull();
      } else {
      const claimable = await loadInitialProtectedTaskOccurrence(
        base.productDb,
        {
          taskRunId: connected.taskRunId,
          authorizationRequestId:
            `task-run-authorization:${connected.taskRunId}`,
        },
      );
      if (claimable === null) {
        throw new Error("Accepted protected Task occurrence was unavailable");
      }
      await composition.coordinator.observeProtectedTaskOccurrence(claimable);
      if (checkpointPauseResume) {
        const parkedPolicyRevision = base.policyRevision;
        const entered = await Promise.race([
          firstCheckpointSegmentEntered.promise.then(() => true),
          new Promise<false>(resolve => setTimeout(() => resolve(false), 10_000)),
        ]);
        if (!entered || connectedJobId === null) {
          throw new Error("Connected protected Task did not enter its first segment");
        }
        parkedPriorJobId = connectedJobId;
        expect(await pauseTask({
          db: base.productDb,
          jobManager,
          observer: { kick: () => { kicks += 1; } },
        }, connected.taskId)).toEqual({
          ok: true,
          status: "paused",
          message: "Task paused.",
        });
        const [[pausedTask], [pausedRun], [parkedJob], segmentReceipts,
          continuationReceipts] = await Promise.all([
          base.admin.select({
            status: tasks.status,
            pauseRequestId: tasks.pauseRequestId,
            pauseRequestedAt: tasks.pauseRequestedAt,
            pauseReason: tasks.pauseReason,
          }).from(tasks).where(eq(tasks.id, connected.taskId)),
          base.admin.select({
            status: taskRuns.status,
            jobId: taskRuns.jobId,
            graphThreadId: taskRuns.graphThreadId,
            resultText: taskRuns.resultText,
            lastError: taskRuns.lastError,
            resultRevision: taskRuns.resultRevision,
          }).from(taskRuns).where(eq(taskRuns.id, connected.taskRunId)),
          base.admin.select({
            status: jobs.status,
            result: jobs.result,
            message: jobs.message,
            metadata: jobs.metadata,
            input: jobs.input,
            completedAt: jobs.completedAt,
          }).from(jobs).where(eq(jobs.id, parkedPriorJobId)),
          base.admin.select().from(protectedTaskExecutionSegmentReceipts)
            .where(and(
              eq(protectedTaskExecutionSegmentReceipts.taskRunId,
                connected.taskRunId),
              eq(protectedTaskExecutionSegmentReceipts.executionSegment, 1),
            )),
          base.admin.select().from(protectedTaskContinuationReceipts)
            .where(and(
              eq(protectedTaskContinuationReceipts.taskRunId,
                connected.taskRunId),
              eq(protectedTaskContinuationReceipts.executionSegment, 1),
            )),
        ]);
        expect(pausedTask).toMatchObject({
          status: "paused",
          pauseReason: "manual_pause",
        });
        expect(pausedTask?.pauseRequestId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        );
        expect(pausedTask?.pauseRequestedAt).toBeInstanceOf(Date);
        expect(pausedRun).toEqual({
          status: "awaiting",
          jobId: parkedPriorJobId,
          graphThreadId: connected.graphThreadId,
          resultText: null,
          lastError: null,
          resultRevision: 0,
        });
        expect(parkedJob).toMatchObject({
          status: "completed",
          result: null,
          message: null,
          input: {
            kind: "protected_task_run_v1",
            taskId: connected.taskId,
            taskRunId: connected.taskRunId,
            policyRevision: parkedPolicyRevision,
            executionSegment: 1,
          },
        });
        expect(parkedJob?.completedAt).toBeInstanceOf(Date);
        expect(parkedJob?.metadata).toMatchObject({
          [PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY]: {
            version: 1,
            taskId: connected.taskId,
            taskRunId: connected.taskRunId,
            jobId: parkedPriorJobId,
            graphThreadId: connected.graphThreadId,
            executionSegment: 1,
            interrupts: [],
          },
        });
        expect(segmentReceipts).toHaveLength(1);
        expect(segmentReceipts[0]).toMatchObject({
          jobId: parkedPriorJobId,
          route: "native_langgraph_v1",
          checkpointContract: "encrypted_langgraph_v1",
          expectedCheckpointCount: 1,
        });
        expect(segmentReceipts[0]?.checkpointDigest).toBeInstanceOf(Uint8Array);
        expect(continuationReceipts).toHaveLength(1);
        expect(continuationReceipts[0]).toMatchObject({
          jobId: parkedPriorJobId,
          kind: "checkpoint_safe_v1",
          reason: "manual_pause",
          effectDisposition: "none_v1",
        });
        expect(segmentContinuationModes).toEqual([false]);

        if (checkpointPolicyRefreshResume) {
          const [transitionedPolicy] = await base.admin
            .update(encryptionTransitionPolicy).set({
              revision: parkedPolicyRevision + 1,
              updatedAt: new Date(NOW + 1),
            }).where(and(
              eq(encryptionTransitionPolicy.id, "server"),
              eq(encryptionTransitionPolicy.mode, "encrypted_only"),
              eq(encryptionTransitionPolicy.revision, parkedPolicyRevision),
            )).returning({
              mode: encryptionTransitionPolicy.mode,
              revision: encryptionTransitionPolicy.revision,
            });
          expect(transitionedPolicy).toEqual({
            mode: "encrypted_only",
            revision: parkedPolicyRevision + 1,
          });
          if (transitionedPolicy === undefined) throw new Error("Checkpoint policy CAS failed");
          base.policyRevision = transitionedPolicy.revision;
        }

        const kicksBeforeResume = kicks;
        expect(await unpauseTask({
          db: base.productDb,
          jobManager,
          observer: { kick: () => { kicks += 1; } },
        }, connected.taskId)).toEqual({
          ok: true,
          status: "awaiting",
          message: "Task resumed.",
        });
        expect(kicks).toBe(kicksBeforeResume + 1);
        const [resumedTask] = await base.admin.select({
          status: tasks.status,
          pauseRequestId: tasks.pauseRequestId,
          pauseRequestedAt: tasks.pauseRequestedAt,
          pauseReason: tasks.pauseReason,
        }).from(tasks).where(eq(tasks.id, connected.taskId));
        expect(resumedTask).toEqual({
          status: "awaiting",
          pauseRequestId: null,
          pauseRequestedAt: null,
          pauseReason: null,
        });

        const parked = await discoverParkedProtectedTaskCheckpointContinuation(
          base.productDb,
          { taskRunId: connected.taskRunId },
        );
        if (parked === null) {
          throw new Error("Protected checkpoint continuation was unavailable");
        }
        checkpointContinuationAuthorizationRequestId =
          parked.authorizationRequestId;
        base.requestIds.add(parked.authorizationRequestId);
        expect(parked.occurrence.run.id).toBe(connected.taskRunId);
        expect(parked.occurrence.run.graphThreadId)
          .toBe(connected.graphThreadId);
        expect(parked.nextExecutionSegment).toBe(2);
        expect(parked.proof.continuation).toMatchObject({
          kind: "checkpoint_safe_v1",
          reason: "manual_pause",
          effectDisposition: "none_v1",
        });
        expect(parked.priorJob.reference.policyRevision)
          .toBe(parkedPolicyRevision);
        expect(parked.priorJob.checkpointAadBinding).toMatchObject({
          policyRevision: parkedPolicyRevision,
        });
        await composition.coordinator.observeProtectedTaskOccurrence(
          parked.occurrence,
        );
        await grantConnectedRequest(parked.authorizationRequestId);
        const continuationGrant = await new PostgresBackgroundAuthorizationRepository(
          base.cryptoHandle,
        ).get(parked.authorizationRequestId);
        expect(continuationGrant?.expectedPolicyRevision)
          .toBe(base.policyRevision);
        expect(continuationGrant?.authoritySet?.namespaceRequirements.every(
          requirement => requirement.expectedPolicyRevision === base.policyRevision,
        )).toBeTrue();
        expect(recipients.size).toBe(1);
        await composition.coordinator.observeProtectedTaskOccurrence(
          parked.occurrence,
        );
      } else if (grantRefreshResume) {
        const entered = await Promise.race([
          firstCheckpointSegmentEntered.promise.then(() => true),
          new Promise<false>(resolve => setTimeout(() => resolve(false), 10_000)),
        ]);
        if (!entered) {
          throw new Error("Protected Task refresh segment did not start");
        }
        const deadline = Date.now() + 10_000;
        let parked = null as Awaited<ReturnType<
          typeof discoverParkedProtectedTaskCheckpointContinuation
        >>;
        while (Date.now() < deadline) {
          parked = await discoverParkedProtectedTaskCheckpointContinuation(
            base.productDb,
            { taskRunId: connected.taskRunId },
          );
          if (parked !== null && connectedJobId !== null) break;
          await new Promise<void>(resolve => setTimeout(resolve, 10));
        }
        if (parked === null || connectedJobId === null) {
          throw new Error("Protected Task refresh did not durably park");
        }
        parkedPriorJobId = connectedJobId;
        const [[awaitingTask], [awaitingRun], [parkedJob], continuationRows] =
          await Promise.all([
            base.admin.select({
              status: tasks.status,
              pauseRequestId: tasks.pauseRequestId,
              pauseRequestedAt: tasks.pauseRequestedAt,
              pauseReason: tasks.pauseReason,
            }).from(tasks).where(eq(tasks.id, connected.taskId)),
            base.admin.select({
              status: taskRuns.status,
              jobId: taskRuns.jobId,
              graphThreadId: taskRuns.graphThreadId,
              resultText: taskRuns.resultText,
              lastError: taskRuns.lastError,
              resultRevision: taskRuns.resultRevision,
            }).from(taskRuns).where(eq(taskRuns.id, connected.taskRunId)),
            base.admin.select({
              status: jobs.status,
              result: jobs.result,
              message: jobs.message,
              metadata: jobs.metadata,
            }).from(jobs).where(eq(jobs.id, parkedPriorJobId)),
            base.admin.select().from(protectedTaskContinuationReceipts)
              .where(and(
                eq(protectedTaskContinuationReceipts.taskRunId,
                  connected.taskRunId),
                eq(protectedTaskContinuationReceipts.executionSegment, 1),
              )),
          ]);
        expect(awaitingTask).toEqual({
          status: "awaiting",
          pauseRequestId: null,
          pauseRequestedAt: null,
          pauseReason: null,
        });
        expect(awaitingRun).toEqual({
          status: "awaiting",
          jobId: parkedPriorJobId,
          graphThreadId: connected.graphThreadId,
          resultText: null,
          lastError: null,
          resultRevision: 0,
        });
        expect(parkedJob).toMatchObject({
          status: "completed",
          result: null,
          message: null,
          metadata: {
            [PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY]: {
              version: 1,
              taskId: connected.taskId,
              taskRunId: connected.taskRunId,
              jobId: parkedPriorJobId,
              graphThreadId: connected.graphThreadId,
              executionSegment: 1,
              interrupts: [],
            },
          },
        });
        expect(continuationRows).toHaveLength(1);
        expect(continuationRows[0]).toMatchObject({
          jobId: parkedPriorJobId,
          kind: "checkpoint_safe_v1",
          reason: "grant_refresh",
          effectDisposition: "none_v1",
        });
        expect(parked.occurrence.run.id).toBe(connected.taskRunId);
        expect(parked.occurrence.run.graphThreadId)
          .toBe(connected.graphThreadId);
        expect(parked.nextExecutionSegment).toBe(2);
        expect(parked.proof.continuation.reason).toBe("grant_refresh");
        checkpointContinuationAuthorizationRequestId =
          parked.authorizationRequestId;
        base.requestIds.add(parked.authorizationRequestId);
        await composition.coordinator.observeProtectedTaskOccurrence(
          parked.occurrence,
        );
        await grantConnectedRequest(parked.authorizationRequestId);
        expect(recipients.size).toBe(1);
        // No Human lifecycle call is involved: accepted fresh authority alone
        // wakes the exact parked continuation.
        await composition.coordinator.observeProtectedTaskOccurrence(
          parked.occurrence,
        );
      } else if (scenario === "parked continuation") {
        const deadline = Date.now() + 10_000;
        let parked = null as Awaited<ReturnType<
          typeof discoverParkedProtectedTaskAdditionalAuthority
        >>;
        let parkedReady = false;
        while (Date.now() < deadline) {
          parked = await discoverParkedProtectedTaskAdditionalAuthority(
            base.productDb,
            { taskRunId: connected.taskRunId },
          );
          if (parked !== null && connectedJobId !== null) {
            const [priorJob] = await base.admin.select({
              status: jobs.status,
              startedAt: jobs.startedAt,
              completedAt: jobs.completedAt,
            }).from(jobs).where(eq(jobs.id, connectedJobId));
            if (priorJob?.status === "completed"
              && priorJob.startedAt !== null
              && priorJob.completedAt !== null) {
              parkedReady = true;
              break;
            }
          }
          await new Promise<void>(resolve => setTimeout(resolve, 10));
        }
        if (!parkedReady || parked === null || connectedJobId === null) {
          throw new Error("Connected protected Task did not durably park");
        }
        parkedPriorJobId = connectedJobId;
        expect(parked.authorizationRequestId)
          .toBe(continuationAuthorizationRequestId);
        expect(parked.occurrence.run.id).toBe(connected.taskRunId);
        expect(parked.occurrence.run.graphThreadId)
          .toBe(connected.graphThreadId);
        expect(parked.proof.segment.expectedCheckpointCount)
          .toBeGreaterThanOrEqual(1);
        expect(controlledEffectExecutions).toBe(0);
        expect(segmentContinuationModes).toEqual([false]);

        await composition.coordinator.observeProtectedTaskOccurrence(
          parked.occurrence,
        );
        await grantConnectedRequest(continuationAuthorizationRequestId);
        expect(kicks).toBe(2);
        const preparedContinuation =
          await discoverParkedProtectedTaskAdditionalAuthority(
            base.productDb,
            { taskRunId: connected.taskRunId },
          );
        if (preparedContinuation === null) {
          throw new Error("Connected protected Task continuation disappeared");
        }
        await composition.coordinator.observeProtectedTaskOccurrence(
          preparedContinuation.occurrence,
        );
      }
      if (scenario === "linked cancellation") {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const [run] = await base.admin.select({ status: taskRuns.status })
            .from(taskRuns).where(eq(taskRuns.id, connected.taskRunId));
          if (run?.status === "cancelled" && connectedJobId !== null
            && jobManager.getJob(connectedJobId) === undefined) break;
          await new Promise<void>(resolve => setTimeout(resolve, 10));
        }
        await composition.coordinator.recoverBeforeObservation(100);
        const [run] = await base.admin.select({ status: taskRuns.status,
          jobId: taskRuns.jobId }).from(taskRuns)
          .where(eq(taskRuns.id, connected.taskRunId));
        expect(connectedJobId).not.toBeNull();
        expect(run).toEqual({ status: "cancelled", jobId: connectedJobId });
        const [job] = await base.admin.select({ status: jobs.status,
          startedAt: jobs.startedAt, result: jobs.result, message: jobs.message })
          .from(jobs).where(eq(jobs.id, connectedJobId!));
        expect(job).toEqual({ status: "cancelled", startedAt: null,
          result: null, message: null });
        const [grant] = await base.admin.select({
          state: backgroundCryptoAuthorizationRequests.state,
          reason: backgroundCryptoAuthorizationRequests.terminalReason,
        }).from(backgroundCryptoAuthorizationRequests).where(eq(
          backgroundCryptoAuthorizationRequests.requestId,
          `task-run-authorization:${connected.taskRunId}`,
        ));
        expect(grant).toEqual({ state: "cancelled", reason: "cancelled" });
        expect(recipients.size).toBe(0);
        expect(segmentCalls).toEqual([]);
      } else if (scenario === "pre-execution recovery") {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const [run] = await base.admin.select().from(taskRuns)
            .where(eq(taskRuns.id, connected.taskRunId));
          if (connectedJobId !== null && run?.status === "awaiting"
            && run.jobId === null && jobManager.getJob(connectedJobId) === undefined) break;
          await new Promise<void>(resolve => setTimeout(resolve, 10));
        }
        const [run] = await base.admin.select().from(taskRuns)
          .where(eq(taskRuns.id, connected.taskRunId));
        expect(run).toMatchObject({ status: "awaiting", jobId: null,
          modelId: null, resultText: null, lastError: null, resultRevision: 0 });
        const [task] = await base.admin.select({ status: tasks.status })
          .from(tasks).where(eq(tasks.id, connected.taskId));
        expect(task?.status).toBe("awaiting");
        expect(connectedJobId).not.toBeNull();
        const [job] = await base.admin.select().from(jobs)
          .where(eq(jobs.id, connectedJobId!));
        expect(job).toMatchObject({ status: "cancelled", startedAt: null,
          result: null, message: null });
        expect(job?.completedAt).not.toBeNull();
        const [grant] = await base.admin.select({
          state: backgroundCryptoAuthorizationRequests.state,
          retryCount: backgroundCryptoAuthorizationRequests.retryCount,
          claimId: backgroundCryptoAuthorizationRequests.claimId,
          lastRetryReason: backgroundCryptoAuthorizationRequests.lastRetryReason,
        }).from(backgroundCryptoAuthorizationRequests).where(eq(
          backgroundCryptoAuthorizationRequests.requestId,
          `task-run-authorization:${connected.taskRunId}`,
        ));
        expect(grant).toEqual({ state: "awaiting_recipient", retryCount: 0,
          claimId: null, lastRetryReason: "stale_authority" });
        expect(recipients.size).toBe(0);
        expect(segmentCalls).toEqual([]);
        // The normal observer/device flow can offer a fresh grant automatically.
        await composition.coordinator.observeProtectedTaskOccurrence(occurrence);
        const refreshed = await deviceService.list(subject, {});
        let freshGeneration: number | undefined;
        for (const request of refreshed.requests) {
          const decoded = decodeTaskRuntimeBackgroundAuthorizationRequestV1(request.requestBytes);
          if (decoded !== null) {
            if (decoded.workId === connected.taskRunId) freshGeneration = decoded.recipientGeneration;
            destroyTaskRuntimeBackgroundAuthorizationRequestV1(decoded);
          }
          request.requestBytes.fill(0);
        }
        expect(freshGeneration).toBe(1);
      } else if (scenario === "abandoned running recovery") {
        const before = await waitForConnectedCompletion(
          base,
          connected.taskRunId,
          terminalStatus,
        );
        expect(before.job).toMatchObject({
          status: "failed",
          result: null,
          message: null,
        });
        expect(before.job.startedAt).toBeInstanceOf(Date);
        expect(before.job.completedAt).toBeInstanceOf(Date);
        expect(before.run).toMatchObject({
          status: "running",
          jobId: before.job.id,
          completedAt: null,
          resultText: null,
          lastError: null,
          resultRepresentation: "ordinary",
          resultContentNamespaceId: null,
          resultRevision: 0,
          resultCryptoObjectId: null,
          resultCryptoAccessRevision: 0,
          resultCryptoRequiredNamespaceFingerprint: null,
          resultCryptoMappingState: "unmapped",
        });
        expect(nativeErrors).toEqual([{
          stage: "publish_result",
          name: "Error",
          message: "synthetic provider loss before protected result publication",
        }, {
          stage: "execute",
          name: "Error",
          message: "synthetic provider loss before protected result publication",
        }]);
        const requestId = `task-run-authorization:${connected.taskRunId}`;
        const [runningGrant] = await base.admin.select({
          state: backgroundCryptoAuthorizationRequests.state,
          terminalReason: backgroundCryptoAuthorizationRequests.terminalReason,
          finishedAt: backgroundCryptoAuthorizationRequests.finishedAt,
        }).from(backgroundCryptoAuthorizationRequests).where(eq(
          backgroundCryptoAuthorizationRequests.requestId,
          requestId,
        ));
        expect(runningGrant).toEqual({
          state: "running",
          terminalReason: null,
          finishedAt: null,
        });
        expect(await base.admin.select({
          sequence: taskRunResultCryptoRevisions.sequence,
        }).from(taskRunResultCryptoRevisions).where(and(
          eq(taskRunResultCryptoRevisions.taskId, connected.taskId),
          eq(taskRunResultCryptoRevisions.taskRunId, connected.taskRunId),
          eq(taskRunResultCryptoRevisions.resultRevision, 1),
        ))).toEqual([]);

        await composition.coordinator.recoverBeforeObservation(100);
        const [settledTask] = await base.admin.select({
          status: tasks.status,
          prompt: tasks.prompt,
          expectedOutput: tasks.expectedOutput,
          lastError: tasks.lastError,
        }).from(tasks).where(eq(tasks.id, connected.taskId));
        const [settledRun] = await base.admin.select().from(taskRuns)
          .where(eq(taskRuns.id, connected.taskRunId));
        const [settledJob] = await base.admin.select().from(jobs)
          .where(eq(jobs.id, before.job.id));
        const [settledGrant] = await base.admin.select({
          state: backgroundCryptoAuthorizationRequests.state,
          terminalReason: backgroundCryptoAuthorizationRequests.terminalReason,
          finishedAt: backgroundCryptoAuthorizationRequests.finishedAt,
          updatedAt: backgroundCryptoAuthorizationRequests.updatedAt,
        }).from(backgroundCryptoAuthorizationRequests).where(eq(
          backgroundCryptoAuthorizationRequests.requestId,
          requestId,
        ));
        expect(settledTask).toEqual({
          status: "errored",
          prompt: "",
          expectedOutput: null,
          lastError: null,
        });
        expect(settledRun).toMatchObject({
          id: connected.taskRunId,
          taskId: connected.taskId,
          jobId: before.job.id,
          status: "errored",
          resultText: null,
          lastError: null,
          resultRepresentation: "ordinary",
          resultContentNamespaceId: null,
          resultRevision: 0,
          resultCryptoObjectId: null,
          resultCryptoAccessRevision: 0,
          resultCryptoRequiredNamespaceFingerprint: null,
          resultCryptoMappingState: "unmapped",
        });
        expect(settledRun?.completedAt).toBeInstanceOf(Date);
        expect(settledJob).toMatchObject({
          id: before.job.id,
          status: "failed",
          result: null,
          message: null,
          metadata: {
            [PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY]: {
              version: 1,
              taskId: connected.taskId,
              taskRunId: connected.taskRunId,
              authorizationRequestId: requestId,
              executionSegment: 1,
              reason: "provider_outcome_unknown",
              parentTaskTerminalized: true,
            },
          },
        });
        expect(settledGrant).toMatchObject({
          state: "terminal_failure",
          terminalReason: "provider_outcome_unknown",
        });
        expect(settledGrant?.finishedAt).toBeInstanceOf(Date);
        expect(settledGrant?.finishedAt).toEqual(settledGrant?.updatedAt);
        expect(await base.admin.select({
          sequence: taskRunResultCryptoRevisions.sequence,
        }).from(taskRunResultCryptoRevisions).where(and(
          eq(taskRunResultCryptoRevisions.taskId, connected.taskId),
          eq(taskRunResultCryptoRevisions.taskRunId, connected.taskRunId),
          eq(taskRunResultCryptoRevisions.resultRevision, 1),
        ))).toEqual([]);
        expect(await objectRowCounts(base, connected.resultObjectId)).toEqual({
          payload: 0,
          head: 0,
          manifest: 0,
          envelope: 0,
        });
        expect(await base.admin.select({ id: taskRuns.id })
          .from(taskRuns).where(eq(taskRuns.taskId, connected.taskId)))
          .toEqual([{ id: connected.taskRunId }]);
        expect(await base.admin.select({ id: jobs.id })
          .from(jobs).where(eq(jobs.laneKey, `task:${connected.taskId}`)))
          .toEqual([{ id: before.job.id }]);
        expect(segmentCalls).toEqual([{
          taskId: connected.taskId,
          taskRunId: connected.taskRunId,
          graphThreadId: connected.graphThreadId,
        }]);
        expect(recipients.size).toBe(0);

        await composition.coordinator.recoverBeforeObservation(100);
        expect(segmentCalls).toHaveLength(1);
        expect(recipients.size).toBe(0);
      } else {
      let terminal = await waitForConnectedCompletion(
        base,
        connected.taskRunId,
        terminalStatus,
        continuedExecution ? 2 : undefined,
      );
      if (missingCiphertextRecovery) {
        expect(terminal.job.status).toBe("failed");
        expect(terminal.run).toMatchObject({
          status: "completed",
          resultRepresentation: "ordinary",
          resultContentNamespaceId: null,
          resultRevision: 0,
          resultCryptoObjectId: null,
          resultCryptoAccessRevision: 0,
          resultCryptoRequiredNamespaceFingerprint: null,
          resultCryptoMappingState: "unmapped",
        });
        expect(await objectRowCounts(base, connected.resultObjectId)).toEqual({
          payload: 0,
          head: 0,
          manifest: 0,
          envelope: 0,
        });
        const [initialLifecycle] = await base.admin.select({
          completion: taskRunResultCryptoRevisions.completion,
          disposition: taskRunResultCryptoRevisions.disposition,
          attemptCount: taskRunResultCryptoRevisions.attemptCount,
          nextAttemptAt: taskRunResultCryptoRevisions.nextAttemptAt,
          failureCode: taskRunResultCryptoRevisions.failureCode,
          cryptoCompletedAt: taskRunResultCryptoRevisions.cryptoCompletedAt,
        }).from(taskRunResultCryptoRevisions).where(and(
          eq(taskRunResultCryptoRevisions.taskId, connected.taskId),
          eq(taskRunResultCryptoRevisions.taskRunId, connected.taskRunId),
          eq(taskRunResultCryptoRevisions.resultRevision, 1),
        ));
        expect(initialLifecycle).toMatchObject({
          completion: "pending",
          disposition: "active",
          attemptCount: 0,
          failureCode: null,
          cryptoCompletedAt: null,
        });
        expect(initialLifecycle?.nextAttemptAt).toBeInstanceOf(Date);
        const [initialBinding] = await base.admin.select({
          terminalAt: protectedTaskRunOutputBindings.resultTerminalAt,
          attachedAt: protectedTaskRunOutputBindings.resultAttachedAt,
          completedAt: protectedTaskRunOutputBindings.completedAt,
        }).from(protectedTaskRunOutputBindings).where(eq(
          protectedTaskRunOutputBindings.taskRunId,
          connected.taskRunId,
        ));
        expect(initialBinding).toMatchObject({
          attachedAt: null,
          completedAt: null,
        });
        expect(initialBinding?.terminalAt).toEqual(terminal.run.completedAt);

        for (
          let attempt = 1;
          attempt <= TASK_CONTENT_RECONCILE_MAX_ATTEMPTS;
          attempt += 1
        ) {
          await composition.coordinator.recoverBeforeObservation(100);
          const [lifecycle] = await base.admin.select({
            completion: taskRunResultCryptoRevisions.completion,
            disposition: taskRunResultCryptoRevisions.disposition,
            attemptCount: taskRunResultCryptoRevisions.attemptCount,
            nextAttemptAt: taskRunResultCryptoRevisions.nextAttemptAt,
            failureCode: taskRunResultCryptoRevisions.failureCode,
            cryptoCompletedAt: taskRunResultCryptoRevisions.cryptoCompletedAt,
          }).from(taskRunResultCryptoRevisions).where(and(
            eq(taskRunResultCryptoRevisions.taskId, connected.taskId),
            eq(taskRunResultCryptoRevisions.taskRunId, connected.taskRunId),
            eq(taskRunResultCryptoRevisions.resultRevision, 1),
          ));
          expect(lifecycle?.attemptCount).toBe(attempt);
          expect(lifecycle?.completion).toBe("pending");
          expect(lifecycle?.cryptoCompletedAt).toBeNull();
          if (attempt === TASK_CONTENT_RECONCILE_MAX_ATTEMPTS) {
            expect(lifecycle).toMatchObject({
              disposition: "quarantined",
              failureCode: "retry_exhausted",
              nextAttemptAt: null,
            });
          } else {
            expect(lifecycle?.disposition).toBe("active");
            expect(lifecycle?.failureCode).toBeNull();
            expect(lifecycle?.nextAttemptAt).toBeInstanceOf(Date);
            const [deferred] = await base.admin
              .update(taskRunResultCryptoRevisions).set({
                nextAttemptAt: new Date(0),
              }).where(and(
                eq(taskRunResultCryptoRevisions.taskId, connected.taskId),
                eq(taskRunResultCryptoRevisions.taskRunId, connected.taskRunId),
                eq(taskRunResultCryptoRevisions.resultRevision, 1),
                eq(taskRunResultCryptoRevisions.attemptCount, attempt),
                eq(taskRunResultCryptoRevisions.disposition, "active"),
              )).returning({
                nextAttemptAt: taskRunResultCryptoRevisions.nextAttemptAt,
              });
            expect(deferred?.nextAttemptAt).toEqual(new Date(0));
          }
        }

        terminal = await waitForConnectedCompletion(
          base,
          connected.taskRunId,
          terminalStatus,
        );
        expect(terminal.job.status).toBe("failed");
        expect(terminal.run).toMatchObject({
          status: "completed",
          resultRepresentation: "ordinary",
          resultRevision: 0,
          resultCryptoMappingState: "unmapped",
        });
        const [authorization] = await base.admin.select({
          state: backgroundCryptoAuthorizationRequests.state,
          terminalReason: backgroundCryptoAuthorizationRequests.terminalReason,
        }).from(backgroundCryptoAuthorizationRequests).where(eq(
          backgroundCryptoAuthorizationRequests.requestId,
          `task-run-authorization:${connected.taskRunId}`,
        ));
        expect(authorization).toEqual({
          state: "terminal_failure",
          terminalReason: "integrity_failure",
        });
        const [settledBinding] = await base.admin.select({
          terminalAt: protectedTaskRunOutputBindings.resultTerminalAt,
          attachedAt: protectedTaskRunOutputBindings.resultAttachedAt,
          completedAt: protectedTaskRunOutputBindings.completedAt,
        }).from(protectedTaskRunOutputBindings).where(eq(
          protectedTaskRunOutputBindings.taskRunId,
          connected.taskRunId,
        ));
        expect(settledBinding).toMatchObject({
          attachedAt: null,
          completedAt: null,
        });
        expect(settledBinding?.terminalAt).toEqual(terminal.run.completedAt);
        expect(await objectRowCounts(base, connected.resultObjectId)).toEqual({
          payload: 0,
          head: 0,
          manifest: 0,
          envelope: 0,
        });
        expect(recipients.size).toBe(0);

        await composition.coordinator.recoverBeforeObservation(100);
        const [unchangedLifecycle] = await base.admin.select({
          disposition: taskRunResultCryptoRevisions.disposition,
          attemptCount: taskRunResultCryptoRevisions.attemptCount,
          failureCode: taskRunResultCryptoRevisions.failureCode,
        }).from(taskRunResultCryptoRevisions).where(and(
          eq(taskRunResultCryptoRevisions.taskId, connected.taskId),
          eq(taskRunResultCryptoRevisions.taskRunId, connected.taskRunId),
          eq(taskRunResultCryptoRevisions.resultRevision, 1),
        ));
        expect(unchangedLifecycle).toEqual({
          disposition: "quarantined",
          attemptCount: TASK_CONTENT_RECONCILE_MAX_ATTEMPTS,
          failureCode: "retry_exhausted",
        });
        expect(segmentCalls).toEqual([{
          taskId: connected.taskId,
          taskRunId: connected.taskRunId,
          graphThreadId: connected.graphThreadId,
        }]);
        expect(await base.admin.select({ id: jobs.id }).from(jobs).where(eq(
          jobs.laneKey,
          `task:${connected.taskId}`,
        ))).toEqual([{ id: terminal.job.id }]);
      }
      if (!missingCiphertextRecovery) {
        if (scenario === "attachment recovery"
          || scenario === "publication recovery"
          || unmappedRecovery) {
          expect(terminal.job.status).toBe("failed");
          if (unmappedRecovery) {
            expect(terminal.run).toMatchObject({
              status: "completed",
              resultRepresentation: "ordinary",
              resultContentNamespaceId: null,
              resultRevision: 0,
              resultCryptoObjectId: null,
              resultCryptoAccessRevision: 0,
              resultCryptoRequiredNamespaceFingerprint: null,
              resultCryptoMappingState: "unmapped",
            });
            const [lifecycle] = await base.admin.select({
              completion: taskRunResultCryptoRevisions.completion,
              disposition: taskRunResultCryptoRevisions.disposition,
              cryptoObjectId: taskRunResultCryptoRevisions.cryptoObjectId,
            }).from(taskRunResultCryptoRevisions).where(and(
              eq(taskRunResultCryptoRevisions.taskId, connected.taskId),
              eq(taskRunResultCryptoRevisions.taskRunId, connected.taskRunId),
              eq(taskRunResultCryptoRevisions.resultRevision, 1),
            ));
            expect(lifecycle).toEqual({
              completion: "complete",
              disposition: "active",
              cryptoObjectId: connected.resultObjectId,
            });
            expect(await objectRowCounts(base, connected.resultObjectId)).toEqual({
              payload: 1,
              head: 1,
              manifest: 1,
              envelope: 1,
            });
          } else {
            expect(terminal.run.resultCryptoMappingState).toBe("verified");
          }
          const [before] = await base.admin.select({
            attachedAt: protectedTaskRunOutputBindings.resultAttachedAt,
            completedAt: protectedTaskRunOutputBindings.completedAt,
          }).from(protectedTaskRunOutputBindings).where(eq(
            protectedTaskRunOutputBindings.taskRunId, connected.taskRunId,
          ));
          expect(before?.completedAt).toBeNull();
          if (scenario === "attachment recovery" || unmappedRecovery) {
            expect(before?.attachedAt).toBeNull();
          } else {
            expect(before?.attachedAt).toBeInstanceOf(Date);
          }
          if (scenario === "unmapped expired grant recovery") {
            const [grant] = await base.admin.select({
              authorizationExpiresAt:
                backgroundCryptoAuthorizationRequests.authorizationExpiresAt,
            }).from(backgroundCryptoAuthorizationRequests).where(eq(
              backgroundCryptoAuthorizationRequests.requestId,
              `task-run-authorization:${connected.taskRunId}`,
            ));
            expect(grant?.authorizationExpiresAt).toBeInstanceOf(Date);
            recoveryNow = grant!.authorizationExpiresAt!.getTime() + 1;
          }
        }
        // The existing observer repairs final publication without invoking the
        // model or allocating another TaskRun/Job.
        await composition.coordinator.recoverBeforeObservation(100);
        terminal = await waitForConnectedCompletion(base, connected.taskRunId, terminalStatus);
        if (terminal.job.status !== "completed") {
          const [authorization] = await base.admin.select({
            state: backgroundCryptoAuthorizationRequests.state,
          }).from(backgroundCryptoAuthorizationRequests).where(eq(
            backgroundCryptoAuthorizationRequests.requestId,
            `task-run-authorization:${connected.taskRunId}`,
          ));
          throw new Error(`Connected protected Task Job failed: ${JSON.stringify({
            jobStatus: terminal.job.status,
            runStatus: terminal.run.status,
            authorizationState: authorization?.state ?? "missing",
            segmentCalls,
            nativeErrors,
            ...(protectedCodex ? { codexCalls } : {}),
          })}`);
        }
        await waitForConnectedRelease(
          base,
          scenario === "parked continuation"
            ? continuationAuthorizationRequestId
            : checkpointContinuationScenario
              ? checkpointContinuationAuthorizationRequestId!
            : `task-run-authorization:${connected.taskRunId}`,
          recipients,
        );
        const [settledBinding] = await base.admin.select({
          deliveryMode: protectedTaskRunOutputBindings.deliveryMode,
          attachedAt: protectedTaskRunOutputBindings.resultAttachedAt,
          completedAt: protectedTaskRunOutputBindings.completedAt,
        }).from(protectedTaskRunOutputBindings).where(eq(
          protectedTaskRunOutputBindings.taskRunId, connected.taskRunId,
        ));
        expect(settledBinding?.attachedAt).toEqual(terminal.run.completedAt);
        if (scenario === "publication recovery" || unmappedRecovery) {
          expect(settledBinding?.deliveryMode).toBe("none");
          expect(settledBinding?.completedAt).toEqual(terminal.run.completedAt);
        } else {
          // Message/wake delivery is a separate unfinished owner.
          expect(settledBinding?.completedAt).toBeNull();
        }
        const terminalReference = terminal.job.input as
          ProtectedTaskJobReferenceV1;
        expect(terminalReference).toMatchObject({
          kind: "protected_task_run_v1",
          taskId: connected.taskId,
          taskRunId: connected.taskRunId,
          inputObjectId: connected.inputObjectId,
          resultObjectId: connected.resultObjectId,
          authorizationRequestId: scenario === "parked continuation"
            ? continuationAuthorizationRequestId
            : checkpointContinuationScenario
              ? checkpointContinuationAuthorizationRequestId
            : `task-run-authorization:${connected.taskRunId}`,
          policyRevision: base.policyRevision,
          executionSegment: continuedExecution ? 2 : 1,
        });
        if (continuedExecution) {
          expect("resumeContinuationFingerprint" in terminalReference)
            .toBe(true);
        } else {
          expect(terminalReference).toEqual({
            kind: "protected_task_run_v1",
            taskId: connected.taskId,
            taskRunId: connected.taskRunId,
            inputObjectId: connected.inputObjectId,
            resultObjectId: connected.resultObjectId,
            authorizationRequestId:
              `task-run-authorization:${connected.taskRunId}`,
            policyRevision: base.policyRevision,
            executionSegment: 1,
          });
        }
        expect(terminal.job.message).toBeNull();
        expect(terminal.job.result).toBeNull();
        // A delayed process cannot overwrite the completed durable result.
        const expectedReference = terminalReference;
        for (const requested of ["failed", "cancelled"] as const) {
          expect(await settleProtectedTaskJobTerminalWithDatabase(
            base.productDb, terminal.job.id, expectedReference, requested,
            { expectedRevision: base.policyRevision, representation: "protected_only" },
          )).toEqual({ kind: "existing_terminal", status: "completed" });
        }
        expect((await base.admin.select({ status: jobs.status }).from(jobs)
          .where(eq(jobs.id, terminal.job.id)))[0]?.status).toBe("completed");
        if (terminal.run.status !== "completed") {
          throw new Error(`Connected Task execution did not succeed: ${JSON.stringify({
            scenario, segmentCalls, nativeErrors,
          })}`);
        }
        expect(terminal.run).toMatchObject({
          id: connected.taskRunId,
          taskId: connected.taskId,
          jobId: terminal.job.id,
          status: "completed",
          resultRepresentation: wakeForegroundShadow || deepResearchShadow
            || protectedCodexShadow || protectedAcpShadow
            || recurringEncryptedOccurrences
            || historicalDefinition && !historicalDefinitionFull
            ? "dual"
            : "protected",
          resultContentNamespaceId: base.namespaceValue,
          resultRevision: 1,
          resultCryptoObjectId: connected.resultObjectId,
          resultCryptoAccessRevision: 0,
          resultCryptoMappingState: "verified",
          resultText: wakeForegroundShadow || deepResearchShadow
            || protectedCodexShadow || protectedAcpShadow
            || recurringEncryptedOccurrences
            || historicalDefinition && !historicalDefinitionFull
            ? protectedExternalResultText
            : null,
          lastError: null,
          modelId: protectedExternal ? null : connected.requestedModelId,
          ...(callerLocalExecution && callerFunding !== null ? {
            fundingBinding: {
              kind: "personal",
              providerRoute: "openrouter",
              credentialId: callerFunding.credentialId,
              credentialRevision: callerFunding.credentialRevision,
            },
          } : {}),
        });
        if (protectedExternal) {
          expect(terminal.run.graphThreadId).toBe(connected.graphThreadId);
          expect(terminal.run.startedAt).toEqual(connected.startedAt);
          expect(terminal.run.completedAt).toBeInstanceOf(Date);
          expect(terminal.run.fundingBinding).toBeNull();
          expect(terminal.run.fundingPredecessorRunId).toBeNull();
          expect(Buffer.from(
            terminal.run.resultCryptoRequiredNamespaceFingerprint ?? [],
          )).toEqual(Buffer.from(
            occurrence.task.cryptoRequiredNamespaceFingerprint,
          ));
        }
        if (freshOutputRead) {
          const output = createProtectedTaskOutputReadComposition({ db: base.productDb,
            restricted: base.restricted, crypto: base.crypto, owner, serverScope: SERVER_SCOPE,
            recipients, recipientTtlMs: TASK_RUNTIME_AUTHORIZATION_ABSOLUTE_LIMIT_MS, now: Date.now });
          const prepared = await output.preparation.prepare({ taskId: connected.taskId,
            taskRunId: connected.taskRunId, kind: "raw" });
          expect(prepared.status).toBe("exact_replay");
          const outputRequestId = `task-run-delivery-result-authorization:${connected.taskRunId}`;
          const outputDevice = createProductionBackgroundAuthorizationComposition({ crypto: base.crypto,
            serverScope: SERVER_SCOPE, now: Date.now, restricted: () => base.restricted,
            bindTaskRecipient: output.bindTaskRecipient, withTaskAuthority: output.withTaskAuthority,
            isTaskRecipientActive: output.isTaskRecipientActive, wakeProtectedTask: () => undefined });
          await grantRequest(outputDevice, outputRequestId);
          const readRecord = await new PostgresBackgroundAuthorizationRepository(base.cryptoHandle).get(outputRequestId);
          expect(readRecord?.snapshot.state).toBe("grant_ready");
          expect(readRecord?.workKind).toBe("task.deliver_result");
          expect(readRecord?.authoritySet?.namespaceRequirements).toHaveLength(1);
          expect(readRecord?.authoritySet?.namespaceRequirements[0]?.operations).toEqual(["decrypt", "encrypt"]);
          expect(recipients.size).toBe(1);
          expect(segmentCalls).toHaveLength(
            protectedExternal ? 0 : 1,
          );
          if (prepared.status !== "created" && prepared.status !== "exact_replay"
            || readRecord?.snapshot.formatVersion !== 3) throw new Error("Fresh read grant not ready");
          let openedResultCalls = 0;
          const recoverResultMessage = createProtectedTaskRunResultMessageRecovery({
            db: base.productDb,
            restricted: base.restricted,
            crypto: base.crypto,
            owner,
            serverScope: SERVER_SCOPE,
          });
          const publishResultMessage = createProtectedTaskRunResultMessagePublication({
            restricted: base.restricted,
            crypto: base.crypto,
            owner,
            serverScope: SERVER_SCOPE,
            authority: output.authority,
            recover: rawStagingCompatiblePolicyRestart
              ? async () => "pending"
              : async coordinates =>
                  await recoverResultMessage(coordinates) === "mapped"
                    ? "mapped"
                    : "pending",
          });
          const claimRead = createProtectedTaskOutputReadClaim({ workKind: "task.deliver_result",
            authority: output.authority, recipients, now: Date.now,
            repository: async connection => new PostgresBackgroundAuthorizationRepository(await verifyCryptoPostgresHandle(connection)),
            publish: freshRawMessagePublication ? publishResultMessage : async publication => {
              const accepted = acceptedTaskRuntimeRecord(publication.record);
              if (accepted === null) throw new Error("Fresh result-read authorization absent");
              try {
                const history = new PostgresHumanDeviceSignerHistory({ handle: base.cryptoHandle, crypto: base.crypto });
                const source = await withNativeProtectedTaskRunResultMessageSourceV1({ restricted: base.restricted,
                  crypto: base.crypto, serverScope: SERVER_SCOPE, evidence: publication.evidence,
                  domains: publication.partitions.resultDomains, signal: publication.signal,
                  resolveHistoricalAgentSignerAuthority: history.resolveAgentRuntimeSignerManager,
                  loadCurrentResult: () => output.authority.withAccepted({ intent: publication.plan.intent,
                    accepted, restricted: base.restricted, signal: publication.signal,
                    subject: { userId: base.userId, humanActorId: accepted.issuingHumanId, deviceId: accepted.issuingDeviceId },
                    validateBeforeCommit: publication.assertCurrentClaim,
                    use: current => current.occurrence }),
                  execute: async (messageSource, assertCurrentSource) => {
                    await assertCurrentSource(); await publication.assertCurrentClaim();
                    expect(messageSource.payload.role).toBe("assistant");
                    expect(messageSource.payload.content).toBe(
                      protectedExternalResultText,
                    );
                    openedResultCalls += 1;
                  } });
                expect(source.status).toBe("available");
              } finally { destroyAcceptedTaskRuntimeRecord(accepted); }
            } });
          const claimInput = { plan: prepared.plan,
            record: readRecord as BackgroundAuthorizationTaskRuntimeRecordV3,
            restricted: base.restricted, signal: new AbortController().signal };
          if (rawStagingCompatiblePolicyRestart) {
            let claimError: unknown;
            try { await claimRead(claimInput); } catch (error) { claimError = error; }
            expect(claimError).toBeInstanceOf(Error);
            expect((claimError as Error).message).toBe(
              "Task result Message requires publication reconciliation",
            );
          } else {
            expect((await claimRead(claimInput))?.snapshot.state).toBe("completed");
          }
          expect(openedResultCalls).toBe(freshRawMessagePublication ? 0 : 1);
          if (!rawStagingCompatiblePolicyRestart) expect(recipients.size).toBe(0);
          if (freshRawMessagePublication) {
            const sessionId = prepared.plan.intent.invocation.sessionId;
            const [binding] = await base.admin.select().from(
              protectedTaskRunOutputBindings,
            ).where(eq(
              protectedTaskRunOutputBindings.taskRunId,
              connected.taskRunId,
            ));
            expect(binding).toMatchObject({
              deliveryMode: wakeForegroundScenario
                ? "raw_and_wake"
                : "raw",
              destinationRoomId: base.roomId,
              destinationNamespaceId: base.namespaceValue,
              resultRevision: 1,
            });
            expect(binding?.resultAttachedAt).toEqual(terminal.run.completedAt);
            if (typeof binding?.messageOperationId !== "string") {
              throw new Error("Fresh Task result Message operation was unavailable");
            }
            const allocatedMessages = await base.admin.select({
              id: sessionMessages.id,
              sessionId: sessionMessages.sessionId,
              role: sessionMessages.role,
              content: sessionMessages.content,
              toolCalls: sessionMessages.toolCalls,
              toolName: sessionMessages.toolName,
              fingerprint: sessionMessages.fingerprint,
              humanTurnId: sessionMessages.humanTurnId,
              objectId: sessionMessages.cryptoObjectId,
            }).from(sessionMessages).where(eq(
              sessionMessages.sessionId,
              sessionId,
            ));
            expect(allocatedMessages).toHaveLength(1);
            const message = allocatedMessages[0];
            if (message === undefined) {
              throw new Error("Fresh Task result Message allocation was unavailable");
            }
            const messageId = message.id;
            if (wakeForegroundScenario) {
              wakeHistoryMessageIds.push(messageId);
            }
            const [revision, association, receipt] = await Promise.all([
              base.admin.select({
                completion: sessionMessageCryptoRevisions.completion,
                disposition: sessionMessageCryptoRevisions.disposition,
                parityStatus: sessionMessageCryptoRevisions.parityStatus,
                objectId: sessionMessageCryptoRevisions.cryptoObjectId,
              }).from(sessionMessageCryptoRevisions).where(and(
                eq(sessionMessageCryptoRevisions.sessionId, sessionId),
                eq(sessionMessageCryptoRevisions.messageId,
                  messageId),
              )).then(rows => rows[0]),
              base.admin.select({
                kind: taskRunMessageAssociations.kind,
                publicationKey: taskRunMessageAssociations.publicationKey,
              }).from(taskRunMessageAssociations).where(eq(
                taskRunMessageAssociations.taskRunId,
                connected.taskRunId,
              )).then(rows => rows[0]),
              base.admin.select({
                requestId: taskTerminalMessageCryptoStagingReceipts.requestId,
                objectId: taskTerminalMessageCryptoStagingReceipts.cryptoObjectId,
                acceptedPolicyRevision:
                  taskTerminalMessageCryptoStagingReceipts.acceptedPolicyRevision,
                publicationPolicyRevision:
                  taskTerminalMessageCryptoStagingReceipts.publicationPolicyRevision,
                genesisManifestHash:
                  taskTerminalMessageCryptoStagingReceipts.genesisManifestHash,
                retainedIntent:
                  taskTerminalMessageCryptoStagingReceipts.rawResultMessageIntent,
              }).from(taskTerminalMessageCryptoStagingReceipts).where(eq(
                taskTerminalMessageCryptoStagingReceipts.requestId,
                outputRequestId,
              )).then(rows => rows[0]),
            ]);
            if (receipt === undefined || typeof receipt.objectId !== "string") {
              throw new Error("Fresh Task result Message receipt was unavailable");
            }
            const messageObjectId = receipt.objectId;
            expect(message.objectId).toBe(
              rawStagingCompatiblePolicyRestart ? null : messageObjectId,
            );
            expect(message).toMatchObject({
              id: messageId,
              sessionId,
              role: "assistant",
              content: wakeForegroundShadow || recurringEncryptedOccurrences
                ? "Connected protected result"
                : null,
              toolCalls: null,
              toolName: null,
              fingerprint: null,
              humanTurnId: null,
            });
            expect(messageObjectId).toMatch(/^message:v2:[0-9a-f]{64}$/u);
            expect(receipt).toMatchObject({
              requestId: outputRequestId,
              objectId: messageObjectId,
              acceptedPolicyRevision: base.policyRevision,
              publicationPolicyRevision: base.policyRevision,
            });
            expect(receipt?.retainedIntent).not.toBeNull();
            expect(await objectRowCounts(base, messageObjectId)).toEqual({
              payload: 1,
              head: 1,
              manifest: 1,
              envelope: 1,
            });
            if (rawStagingCompatiblePolicyRestart) {
              expect(binding).toMatchObject({
                messageId: null,
                messagePublishedAt: null,
                completedAt: null,
              });
              expect(revision).toEqual({
                completion: "pending",
                disposition: "active",
                parityStatus: "pending",
                objectId: messageObjectId,
              });
              expect(association).toBeUndefined();
              expect(recipients.size).toBe(0);
            }

            await base.admin.delete(
              backgroundCryptoAuthorizationNamespaceRequirements,
            ).where(eq(
              backgroundCryptoAuthorizationNamespaceRequirements.requestId,
              outputRequestId,
            ));
            await base.admin.delete(
              backgroundCryptoAuthorizationDomainRequirements,
            ).where(eq(
              backgroundCryptoAuthorizationDomainRequirements.requestId,
              outputRequestId,
            ));
            await base.admin.delete(backgroundCryptoAuthorizationRequests)
              .where(eq(
                backgroundCryptoAuthorizationRequests.requestId,
                outputRequestId,
              ));
            expect(await new PostgresBackgroundAuthorizationRepository(
              base.cryptoHandle,
            ).get(outputRequestId)).toBeNull();
            if (rawStagingCompatiblePolicyRestart) {
              const beforePolicy = await getEncryptionTransitionPolicy(base.productDb);
              expect(beforePolicy).toMatchObject({
                mode: "encrypted_only",
                revision: base.policyRevision,
              });
              await base.admin.update(encryptionTransitionPolicy).set({
                revision: base.policyRevision + 1,
                updatedAt: new Date(Date.now()),
              }).where(eq(encryptionTransitionPolicy.id, "server"));
              expect(await getEncryptionTransitionPolicy(base.productDb)).toMatchObject({
                mode: "encrypted_only",
                revision: base.policyRevision + 1,
              });
            }
            expect(await recoverResultMessage({ taskId: connected.taskId,
              taskRunId: connected.taskRunId })).toBe("mapped");
            expect(await recoverResultMessage({ taskId: connected.taskId,
              taskRunId: connected.taskRunId })).toBe("mapped");
            const [mappedBinding, mappedRevision, mappedAssociation, retainedReceipt] = await Promise.all([
              base.admin.select({
                messageId: protectedTaskRunOutputBindings.messageId,
                messagePublishedAt: protectedTaskRunOutputBindings.messagePublishedAt,
                completedAt: protectedTaskRunOutputBindings.completedAt,
              }).from(protectedTaskRunOutputBindings).where(eq(
                protectedTaskRunOutputBindings.taskRunId,
                connected.taskRunId,
              )).then(rows => rows[0]),
              base.admin.select({
                completion: sessionMessageCryptoRevisions.completion,
                disposition: sessionMessageCryptoRevisions.disposition,
                objectId: sessionMessageCryptoRevisions.cryptoObjectId,
              }).from(sessionMessageCryptoRevisions).where(and(
                eq(sessionMessageCryptoRevisions.sessionId, sessionId),
                eq(sessionMessageCryptoRevisions.messageId, messageId),
              )).then(rows => rows[0]),
              base.admin.select({
                kind: taskRunMessageAssociations.kind,
                publicationKey: taskRunMessageAssociations.publicationKey,
              }).from(taskRunMessageAssociations).where(eq(
                taskRunMessageAssociations.taskRunId,
                connected.taskRunId,
              )).then(rows => rows[0]),
              base.admin.select({
                requestId: taskTerminalMessageCryptoStagingReceipts.requestId,
                objectId: taskTerminalMessageCryptoStagingReceipts.cryptoObjectId,
                acceptedPolicyRevision:
                  taskTerminalMessageCryptoStagingReceipts.acceptedPolicyRevision,
                publicationPolicyRevision:
                  taskTerminalMessageCryptoStagingReceipts.publicationPolicyRevision,
                genesisManifestHash:
                  taskTerminalMessageCryptoStagingReceipts.genesisManifestHash,
                retainedIntent:
                  taskTerminalMessageCryptoStagingReceipts.rawResultMessageIntent,
              }).from(taskTerminalMessageCryptoStagingReceipts).where(eq(
                taskTerminalMessageCryptoStagingReceipts.requestId,
                outputRequestId,
              )).then(rows => rows[0]),
            ]);
            expect(mappedBinding?.messageId).toBe(messageId);
            expect(mappedBinding?.messagePublishedAt).toBeInstanceOf(Date);
            if (wakeForegroundScenario) {
              if (mappedBinding === undefined) throw new Error("Mapped wake binding is missing");
              // The independent recovery tick may already have queued the
              // exact wake. Completion of the delivery binding means queued
              // custody, not execution of that wake.
              if (mappedBinding.completedAt !== null) {
                const [queuedWake] = await base.admin.select({
                  id: jobs.id, status: jobs.status, createdAt: jobs.createdAt,
                  startedAt: jobs.startedAt, completedAt: jobs.completedAt,
                  ownerId: jobs.ownerId, roomId: jobs.roomId,
                }).from(jobs).where(eq(jobs.id, protectedTaskRunWakeJobId(connected.taskRunId)));
                expect(queuedWake).toEqual({
                  id: protectedTaskRunWakeJobId(connected.taskRunId), status: "queued",
                  createdAt: mappedBinding.completedAt, startedAt: null, completedAt: null,
                  ownerId: base.userId, roomId: base.roomId,
                });
                expect(wakeExecutions).toBe(0);
              }
            } else {
              expect(mappedBinding?.completedAt).toEqual(
                mappedBinding?.messagePublishedAt,
              );
            }
            expect(mappedRevision).toEqual({
              completion: "complete",
              disposition: "mapped",
              objectId: messageObjectId,
            });
            expect(mappedAssociation).toEqual({
              kind: "raw_delivery",
              publicationKey: binding.messageOperationId,
            });
            expect(retainedReceipt).toEqual(receipt);
            expect(await base.admin.select({ id: sessionMessages.id })
              .from(sessionMessages).where(eq(
                sessionMessages.sessionId,
                sessionId,
              ))).toEqual([{ id: messageId }]);
          }
        }
        if (wakeForegroundScenario) {
          const wakeJobId = protectedTaskRunWakeJobId(connected.taskRunId);
          const wakeRequestId = `task-wake-authorization:${wakeJobId}`;
          base.jobIds.add(wakeJobId);
          base.requestIds.add(wakeRequestId);

          // Recovery advances bounded pages per observer tick. A populated
          // clone may require further ticks before this exact wake is reached.
          await composition.coordinator.recoverBeforeObservation(100);
          await composition.coordinator.recoverBeforeObservation(100);
          const authorizationRepository =
            new PostgresBackgroundAuthorizationRepository(base.cryptoHandle);
          let awaitingWake = await authorizationRepository.get(wakeRequestId);
          const preparationDeadline = Date.now() + 10_000;
          while (awaitingWake === null && Date.now() < preparationDeadline) {
            await composition.coordinator.recoverBeforeObservation(100);
            await new Promise<void>(resolve => setTimeout(resolve, 10));
            awaitingWake = await authorizationRepository.get(wakeRequestId);
          }
          expect(awaitingWake?.snapshot.state).toBe("awaiting_recipient");
          expect(awaitingWake?.workKind).toBe("task.delivery_wake");
          expect(wakeExecutions).toBe(0);
          expect(await base.admin.select({
            status: jobs.status,
            startedAt: jobs.startedAt,
            completedAt: jobs.completedAt,
          }).from(jobs).where(eq(jobs.id, wakeJobId))).toEqual([{
            status: "queued",
            startedAt: null,
            completedAt: null,
          }]);

          await grantConnectedRequest(wakeRequestId);
          const initialWakeGrant = await authorizationRepository.get(wakeRequestId);
          const initialWakeGeneration = initialWakeGrant?.snapshot.recipientGeneration;
          if (initialWakeGeneration === undefined) throw new Error("Wake initial grant missing");
          const exactWakeDeadline = (
            record: NonNullable<typeof initialWakeGrant>,
            expectedGeneration: number,
          ): number => {
            const recipientExpiresAt = record.snapshot.recipient?.expiresAt;
            const authorizationExpiresAt =
              record.acceptedMaterial?.authorizationExpiresAt;
            const claimExpiresAt = record.snapshot.claimExpiresAt;
            // Recipient expiry is the exact signed request deadline. Once
            // claimed, the durable claim adds the final execution bound.
            const deadlines = [
              recipientExpiresAt,
              authorizationExpiresAt,
              ...(claimExpiresAt === null ? [] : [claimExpiresAt]),
            ];
            if (record.workKind !== "task.delivery_wake"
              || record.snapshot.recipientGeneration !== expectedGeneration
              || deadlines.length < 2
              || deadlines.some(deadline => !Number.isSafeInteger(deadline))) {
              throw new Error("Wake grant deadline was unavailable");
            }
            return Math.min(...deadlines as number[]);
          };
          if (initialWakeGrant === null) throw new Error("Wake initial grant missing");
          let wakeDeadline = exactWakeDeadline(
            initialWakeGrant,
            initialWakeGeneration,
          );
          let additionalWakeGrantIssued = false;
          let additionalNamespacePublished = false;
          // This fixture owns the production coordinator but replaces the
          // outer TaskObserver with a kick counter. Pump the next real pass
          // which the running observer performs after device grant acceptance.
          await composition.coordinator.recoverBeforeObservation(100);
          const claimedWakeGrant = await authorizationRepository.get(wakeRequestId);
          if (claimedWakeGrant === null) throw new Error("Wake claimed grant missing");
          wakeDeadline = exactWakeDeadline(
            claimedWakeGrant,
            initialWakeGeneration,
          );
          let [settledWake] = await base.admin.select({
            status: jobs.status,
            startedAt: jobs.startedAt,
            completedAt: jobs.completedAt,
          }).from(jobs).where(eq(jobs.id, wakeJobId));
          while (settledWake?.status !== "completed"
            && settledWake?.status !== "failed"
            && Date.now() < wakeDeadline) {
            await new Promise<void>(resolve => setTimeout(resolve, 100));
            if (settledWake?.status === "queued") {
              await composition.coordinator.recoverBeforeObservation(100);
              if (wakeProjectionContinuation && !additionalWakeGrantIssued) {
                if (wakeProjectionRotationPending && !additionalNamespacePublished) {
                  const destination = additionalProjectionRoom.current;
                  if (destination === null) throw new Error("Wake destination missing");
                  expect(wakeProjectionModelCalls).toBe(1);
                  expect(wakeExecutions).toBe(0);
                  expect(await base.admin.select({ memoryId: memoryNamespaces.memoryId })
                    .from(memoryNamespaces).where(eq(memoryNamespaces.namespaceId, destination.namespaceId))).toEqual([]);
                  await base.publishAdditionalNamespaceBundle(destination.roomId, destination.namespaceId);
                  additionalNamespacePublished = true;
                  await composition.coordinator.recoverBeforeObservation(100);
                }
                const parked = await authorizationRepository.get(wakeRequestId);
                if (parked?.snapshot.state === "awaiting_recipient"
                  && parked.snapshot.recipientGeneration > initialWakeGeneration) {
                  const destination = additionalProjectionRoom.current;
                  if (destination === null) throw new Error("Wake destination missing");
                  expect(await base.admin.select({ memoryId: memoryNamespaces.memoryId })
                    .from(memoryNamespaces).where(eq(memoryNamespaces.namespaceId, destination.namespaceId)))
                    .toEqual([]);
                  expect(wakeProjectionModelCalls).toBe(1);
                  expect(wakeExecutions).toBe(0);
                  expect(additionalNamespacePublished).toBeTrue();
                  // A new graph/saver/session is constructed on the next
                  // adopted Job; only the encrypted durable state survives.
                  await grantConnectedRequest(wakeRequestId);
                  additionalWakeGrantIssued = true;
                  await composition.coordinator.recoverBeforeObservation(100);
                  const refreshedWakeGrant =
                    await authorizationRepository.get(wakeRequestId);
                  if (refreshedWakeGrant === null) {
                    throw new Error("Wake refreshed grant missing");
                  }
                  wakeDeadline = exactWakeDeadline(
                    refreshedWakeGrant,
                    parked.snapshot.recipientGeneration,
                  );
                }
              }
            }
            [settledWake] = await base.admin.select({
              status: jobs.status,
              startedAt: jobs.startedAt,
              completedAt: jobs.completedAt,
            }).from(jobs).where(eq(jobs.id, wakeJobId));
          }
          if (settledWake?.status !== "completed") {
            const databaseWaits = await base.admin.execute<{ pid: number; state: string;
              wait_event_type: string | null; wait_event: string | null; blockers: number[] }>(sql`
              select pid, state, wait_event_type, wait_event, pg_blocking_pids(pid) as blockers
              from pg_stat_activity where datname = current_database()
                and pid <> pg_backend_pid() and state <> 'idle'
            `);
            const finalWakeAuthorization =
              await authorizationRepository.get(wakeRequestId);
            throw new Error(`Protected wake did not complete: ${JSON.stringify({
              job: settledWake ?? null,
              authorizationState:
                finalWakeAuthorization?.snapshot.state ?? "missing",
              recipientGeneration:
                finalWakeAuthorization?.snapshot.recipientGeneration ?? null,
              initialWakeGeneration,
              wakeProjectionRotationPending,
              additionalNamespacePublished,
              additionalWakeGrantIssued,
              additionalRoomPrepared: additionalProjectionRoom.current !== null,
              wakeProjectionModelCalls,
              wakeProjectionGraphCalls,
              ...(wakeProjectionContinuation ? { wakeProjectionStage } : {}),
              wakeDeadline,
              authorizationExpiresAt:
                finalWakeAuthorization?.acceptedMaterial
                  ?.authorizationExpiresAt ?? null,
              recipientExpiresAt:
                finalWakeAuthorization?.snapshot.recipient?.expiresAt ?? null,
              claimExpiresAt:
                finalWakeAuthorization?.snapshot.claimExpiresAt ?? null,
              databaseWaits,
              wakeExecutions,
              recipientCount: recipients.size,
              nativeErrors,
            })}`);
          }
          expect(settledWake?.status).toBe("completed");
          expect(settledWake?.startedAt).toBeInstanceOf(Date);
          expect(settledWake?.completedAt).toBeInstanceOf(Date);
          expect(wakeExecutions).toBe(1);
          if (wakeProjectionContinuation) {
            expect(additionalWakeGrantIssued).toBeTrue();
            expect(wakeProjectionModelCalls).toBe(1);
            expect(wakeProjectionGraphCalls).toBe(wakeProjectionRollback ? 3 : 2);
          }
          expect(wakePublishedMessageId).not.toBeNull();
          if (wakePublishedMessageId === null) {
            throw new Error("Protected wake transcript Message was unavailable");
          }
          const wakeMessageId = wakePublishedMessageId;
          const [wakeMessage] = await base.admin.select({
            id: sessionMessages.id,
            sessionId: sessionMessages.sessionId,
            role: sessionMessages.role,
            content: sessionMessages.content,
            objectId: sessionMessages.cryptoObjectId,
          }).from(sessionMessages).where(eq(
            sessionMessages.id,
            wakeMessageId,
          ));
          expect(wakeMessage).toMatchObject({
            id: wakeMessageId,
            role: "assistant",
            content: wakeForegroundShadow
              ? "The protected Task result is ready."
              : null,
          });
          expect(wakeMessage?.objectId).toBe(deriveLiveShadowMessageCryptoObjectIdV1({
            operationId: protectedTaskRunWakeOperationId(connected.taskRunId),
            sessionId: wakeMessage!.sessionId, messageId: wakeMessageId,
            revision: 0, transcriptOrdinal: 2, authorRole: "assistant",
          }));
          if (typeof wakeMessage?.objectId !== "string") {
            throw new Error("Protected wake transcript object was unavailable");
          }
          const wakeMessageObjectId = wakeMessage.objectId;
          const [wakeRevision] = await base.admin.select({
            completion: sessionMessageCryptoRevisions.completion,
            disposition: sessionMessageCryptoRevisions.disposition,
            objectId: sessionMessageCryptoRevisions.cryptoObjectId,
          }).from(sessionMessageCryptoRevisions).where(and(
            eq(sessionMessageCryptoRevisions.sessionId,
              wakeMessage.sessionId),
            eq(sessionMessageCryptoRevisions.messageId,
              wakeMessageId),
          ));
          expect(wakeRevision).toEqual({
            completion: "complete",
            disposition: "mapped",
            objectId: wakeMessageObjectId,
          });
          // Job settlement commits before the grant callback finishes wiping
          // its opened keys and completing the authorization claim.
          const wakeSettlementDeadline = Date.now() + 10_000;
          let settledAuthorization = await authorizationRepository.get(wakeRequestId);
          while (settledAuthorization?.snapshot.state === "running"
            && Date.now() < wakeSettlementDeadline && nativeErrors.length === 0) {
            await new Promise<void>(resolve => setTimeout(resolve, 10));
            settledAuthorization = await authorizationRepository.get(wakeRequestId);
          }
          if (nativeErrors.length > 0) {
            throw new Error(`Protected wake completion failed: ${JSON.stringify(nativeErrors)}`);
          }
          expect(settledAuthorization?.snapshot).toMatchObject({ state: "completed" });
          expect(recipients.size).toBe(0);

          await composition.coordinator.recoverBeforeObservation(100);
          await composition.coordinator.recoverBeforeObservation(100);
          expect(wakeExecutions).toBe(1);
          expect(await base.admin.select({
            requestId: backgroundCryptoAuthorizationRequests.requestId,
          }).from(backgroundCryptoAuthorizationRequests).where(eq(
            backgroundCryptoAuthorizationRequests.requestId,
            wakeRequestId,
          ))).toEqual([{ requestId: wakeRequestId }]);
        }
        const recurringProofs: Array<Readonly<{
          taskRunId: string;
          graphThreadId: string;
          jobId: string;
          requestId: string;
          resultObjectId: string;
          messageId: number;
          messageObjectId: string;
          nextFireAt: Date;
        }>> = [];
        if (recurringEncryptedOccurrences) {
          let observerNow = new Date(Date.now() + 1_000);
          const [armed] = await base.admin.update(tasks).set({
            scheduleKind: "cron",
            cron: "* * * * *",
            timezone: "UTC",
            status: "pending",
            nextFireAt: observerNow,
            lastFiredAt: null,
            fireLockId: null,
            fireLockedAt: null,
          }).where(eq(tasks.id, activeConnected.taskId)).returning({
            taskId: tasks.id,
            definitionObjectId: tasks.cryptoObjectId,
            definitionRevision: tasks.contentRevision,
            representation: tasks.contentRepresentation,
            nextFireAt: tasks.nextFireAt,
          });
          expect(armed).toEqual({
            taskId: activeConnected.taskId,
            definitionObjectId: activeConnected.inputObjectId,
            definitionRevision: 1,
            representation: "dual",
            nextFireAt: observerNow,
          });
          const dueProtectedRows = await base.admin.select({
            taskId: tasks.id,
            status: tasks.status,
            pauseRequestId: tasks.pauseRequestId,
            representation: tasks.contentRepresentation,
            mappingState: tasks.cryptoMappingState,
            nextFireAt: tasks.nextFireAt,
            fireLockId: tasks.fireLockId,
          }).from(tasks);
          expect(dueProtectedRows.filter(row =>
            row.status === "pending"
              && row.pauseRequestId === null
              && (row.representation === "dual"
                || row.representation === "protected")
              && row.mappingState === "verified"
              && row.nextFireAt !== null
              && row.nextFireAt.getTime() <= observerNow.getTime()
              && row.fireLockId === null,
          ).map(row => row.taskId)).toEqual([activeConnected.taskId]);

          const occurrencePorts = createTaskOccurrencePolicyPorts(
            owner,
            async () => composition.coordinator,
          );
          const observer = new TaskObserver({
            db: base.productDb,
            jobManager,
            batch: 20,
            now: () => new Date(observerNow.getTime()),
            maintenanceGate: {
              assertAcceptingNewWork: () => Promise.resolve(),
              isAcceptingWork: () => Promise.resolve(true),
            },
            ordinaryOccurrencePort: occurrencePorts.ordinary,
            protectedOccurrencePort: occurrencePorts.protected,
            protectedOccurrenceRecoveryPort: occurrencePorts.protected,
          });
          recurringObserver.current = observer;

          const publishRecurringMessage = async (
            taskRunId: string,
            completedAt: Date,
          ): Promise<Readonly<{
            messageId: number;
            messageObjectId: string;
          }>> => {
            const output = createProtectedTaskOutputReadComposition({
              db: base.productDb,
              restricted: base.restricted,
              crypto: base.crypto,
              owner,
              serverScope: SERVER_SCOPE,
              recipients,
              recipientTtlMs: TASK_RUNTIME_AUTHORIZATION_ABSOLUTE_LIMIT_MS,
              now: Date.now,
            });
            const prepared = await output.preparation.prepare({
              taskId: activeConnected.taskId,
              taskRunId,
              kind: "raw",
            });
            if (prepared.status !== "created"
              && prepared.status !== "exact_replay") {
              throw new Error(
                `Recurring Task result read was unavailable: ${prepared.status}`,
              );
            }
            const requestId =
              `task-run-delivery-result-authorization:${taskRunId}`;
            base.requestIds.add(requestId);
            const outputDevice = createProductionBackgroundAuthorizationComposition({
              crypto: base.crypto,
              serverScope: SERVER_SCOPE,
              now: Date.now,
              restricted: () => base.restricted,
              bindTaskRecipient: output.bindTaskRecipient,
              withTaskAuthority: output.withTaskAuthority,
              isTaskRecipientActive: output.isTaskRecipientActive,
              wakeProtectedTask: () => undefined,
            });
            await grantRequest(outputDevice, requestId);
            const repository = new PostgresBackgroundAuthorizationRepository(
              base.cryptoHandle,
            );
            const record = await repository.get(requestId);
            if (record?.snapshot.formatVersion !== 3) {
              throw new Error("Recurring Task result grant was unavailable");
            }
            expect(record).toMatchObject({
              workKind: "task.deliver_result",
              snapshot: { state: "grant_ready" },
            });
            const recover = createProtectedTaskRunResultMessageRecovery({
              db: base.productDb,
              restricted: base.restricted,
              crypto: base.crypto,
              owner,
              serverScope: SERVER_SCOPE,
            });
            const publish = createProtectedTaskRunResultMessagePublication({
              restricted: base.restricted,
              crypto: base.crypto,
              owner,
              serverScope: SERVER_SCOPE,
              authority: output.authority,
              recover: async coordinates =>
                await recover(coordinates) === "mapped"
                  ? "mapped"
                  : "pending",
            });
            const claim = createProtectedTaskOutputReadClaim({
              workKind: "task.deliver_result",
              authority: output.authority,
              recipients,
              now: Date.now,
              repository: async connection =>
                new PostgresBackgroundAuthorizationRepository(
                  await verifyCryptoPostgresHandle(connection),
                ),
              publish,
            });
            const readyRecord = record as
              BackgroundAuthorizationTaskRuntimeRecordV3;
            expect((await claim({
              plan: prepared.plan,
              record: readyRecord,
              restricted: base.restricted,
              signal: new AbortController().signal,
            }))?.snapshot.state).toBe("completed");
            expect(recipients.size).toBe(0);

            const [binding, association, receipt] = await Promise.all([
              base.admin.select({
                resultObjectId: protectedTaskRunOutputBindings.resultObjectId,
                resultAttachedAt:
                  protectedTaskRunOutputBindings.resultAttachedAt,
                messageOperationId:
                  protectedTaskRunOutputBindings.messageOperationId,
                messageId: protectedTaskRunOutputBindings.messageId,
                messagePublishedAt:
                  protectedTaskRunOutputBindings.messagePublishedAt,
                completedAt: protectedTaskRunOutputBindings.completedAt,
              }).from(protectedTaskRunOutputBindings).where(eq(
                protectedTaskRunOutputBindings.taskRunId,
                taskRunId,
              )).then(rows => rows[0]),
              base.admin.select({
                sessionId: taskRunMessageAssociations.sessionId,
                messageId: taskRunMessageAssociations.messageId,
                kind: taskRunMessageAssociations.kind,
                publicationKey: taskRunMessageAssociations.publicationKey,
              }).from(taskRunMessageAssociations).where(eq(
                taskRunMessageAssociations.taskRunId,
                taskRunId,
              )).then(rows => rows[0]),
              base.admin.select({
                objectId:
                  taskTerminalMessageCryptoStagingReceipts.cryptoObjectId,
              }).from(taskTerminalMessageCryptoStagingReceipts).where(eq(
                taskTerminalMessageCryptoStagingReceipts.requestId,
                requestId,
              )).then(rows => rows[0]),
            ]);
            if (binding?.messageId === null
              || binding?.messageId === undefined
              || association === undefined
              || receipt === undefined) {
              throw new Error("Recurring Task Message receipt was unavailable");
            }
            expect(binding).toMatchObject({
              resultAttachedAt: completedAt,
              messageId: association.messageId,
              completedAt: binding.messagePublishedAt,
            });
            expect(binding.messagePublishedAt).toBeInstanceOf(Date);
            expect(association).toMatchObject({
              messageId: binding.messageId,
              kind: "raw_delivery",
              publicationKey: binding.messageOperationId,
            });
            const [message, revision] = await Promise.all([
              base.admin.select({
                role: sessionMessages.role,
                content: sessionMessages.content,
                objectId: sessionMessages.cryptoObjectId,
              }).from(sessionMessages).where(and(
                eq(sessionMessages.sessionId, association.sessionId),
                eq(sessionMessages.id, association.messageId),
              )).then(rows => rows[0]),
              base.admin.select({
                completion: sessionMessageCryptoRevisions.completion,
                disposition: sessionMessageCryptoRevisions.disposition,
                objectId: sessionMessageCryptoRevisions.cryptoObjectId,
              }).from(sessionMessageCryptoRevisions).where(and(
                eq(sessionMessageCryptoRevisions.sessionId,
                  association.sessionId),
                eq(sessionMessageCryptoRevisions.messageId,
                  association.messageId),
              )).then(rows => rows[0]),
            ]);
            expect(message).toEqual({
              role: "assistant",
              content: "Connected protected result",
              objectId: receipt.objectId,
            });
            expect(revision).toEqual({
              completion: "complete",
              disposition: "mapped",
              objectId: receipt.objectId,
            });
            expect(receipt.objectId).toMatch(/^message:v2:[0-9a-f]{64}$/u);
            base.objectIds.add(receipt.objectId);
            return Object.freeze({
              messageId: association.messageId,
              messageObjectId: receipt.objectId,
            });
          };

          const seenRunIds = new Set<string>([activeConnected.taskRunId]);
          for (let occurrenceIndex = 0; occurrenceIndex < 2;
            occurrenceIndex += 1) {
            const scheduledFor = new Date(observerNow.getTime());
            await observer.tick();
            const allRuns = await base.admin.select({
              id: taskRuns.id,
              graphThreadId: taskRuns.graphThreadId,
              status: taskRuns.status,
              jobId: taskRuns.jobId,
            }).from(taskRuns).where(eq(taskRuns.taskId, activeConnected.taskId));
            const createdRuns = allRuns.filter(run => !seenRunIds.has(run.id));
            expect(createdRuns).toHaveLength(1);
            const createdRun = createdRuns[0];
            if (createdRun === undefined) {
              throw new Error("Recurring protected TaskRun was unavailable");
            }
            expect(createdRun).toMatchObject({
              status: "awaiting",
              jobId: null,
            });
            seenRunIds.add(createdRun.id);
            base.sessionThreadIds.add(createdRun.graphThreadId);
            const executionRequestId =
              `task-run-authorization:${createdRun.id}`;
            base.requestIds.add(executionRequestId);
            base.requestIds.add(
              `task-run-delivery-result-authorization:${createdRun.id}`,
            );
            await grantConnectedRequest(executionRequestId);
            await observer.tick();

            const completionDeadline = Date.now() + 45_000;
            let completedRun: typeof taskRuns.$inferSelect | undefined;
            let completedJob: typeof jobs.$inferSelect | undefined;
            while (Date.now() < completionDeadline) {
              [completedRun] = await base.admin.select().from(taskRuns)
                .where(eq(taskRuns.id, createdRun.id));
              if (completedRun?.jobId !== null
                && completedRun?.jobId !== undefined) {
                [completedJob] = await base.admin.select().from(jobs)
                  .where(eq(jobs.id, completedRun.jobId));
              }
              if (completedRun?.status === "completed"
                && completedJob?.status === "completed") break;
              if (nativeErrors.length > 0) {
                throw new Error(
                  `Recurring protected Task failed: ${JSON.stringify(nativeErrors)}`,
                );
              }
              await new Promise<void>(resolve => setTimeout(resolve, 20));
            }
            if (completedRun?.status !== "completed"
              || completedRun.jobId === null
              || !(completedRun.completedAt instanceof Date)
              || completedJob?.status !== "completed"
              || !(completedJob.completedAt instanceof Date)) {
              throw new Error("Recurring protected Task did not complete");
            }
            base.jobIds.add(completedRun.jobId);
            const resultObjectId = deriveTaskContentCryptoObjectIdV1({
              kind: "run_result",
              taskId: activeConnected.taskId,
              taskRunId: createdRun.id,
              contentRevision: 1,
            });
            base.objectIds.add(resultObjectId);
            expect(completedRun).toMatchObject({
              taskId: activeConnected.taskId,
              graphThreadId: createdRun.graphThreadId,
              resultRepresentation: "dual",
              resultRevision: 1,
              resultCryptoObjectId: resultObjectId,
              resultCryptoMappingState: "verified",
              resultText: "Connected protected result",
              lastError: null,
            });
            expect(completedJob).toMatchObject({
              result: null,
              message: null,
            });
            expect(completedJob.input).toMatchObject({
              kind: "protected_task_run_v1",
              taskId: activeConnected.taskId,
              taskRunId: createdRun.id,
              inputObjectId: activeConnected.inputObjectId,
              resultObjectId,
              authorizationRequestId: executionRequestId,
              executionSegment: 1,
            });
            await waitForConnectedRelease(
              base,
              executionRequestId,
              recipients,
            );
            const [executionAuthorization] = await base.admin.select({
              state: backgroundCryptoAuthorizationRequests.state,
              workId: backgroundCryptoAuthorizationRequests.workId,
            }).from(backgroundCryptoAuthorizationRequests).where(eq(
              backgroundCryptoAuthorizationRequests.requestId,
              executionRequestId,
            ));
            expect(executionAuthorization).toEqual({
              state: "completed",
              workId: createdRun.id,
            });
            const message = await publishRecurringMessage(
              createdRun.id,
              completedRun.completedAt,
            );
            expect(await objectRowCounts(base, resultObjectId)).toEqual({
              payload: 1,
              head: 1,
              manifest: 1,
              envelope: 1,
            });
            const [scheduled] = await base.admin.select({
              status: tasks.status,
              definitionObjectId: tasks.cryptoObjectId,
              definitionRevision: tasks.contentRevision,
              lastFiredAt: tasks.lastFiredAt,
              nextFireAt: tasks.nextFireAt,
              fireLockId: tasks.fireLockId,
            }).from(tasks).where(eq(tasks.id, activeConnected.taskId));
            expect(scheduled).toMatchObject({
              status: "pending",
              definitionObjectId: activeConnected.inputObjectId,
              definitionRevision: 1,
              lastFiredAt: scheduledFor,
              fireLockId: null,
            });
            if (!(scheduled?.nextFireAt instanceof Date)
              || scheduled.nextFireAt.getTime() <= observerNow.getTime()) {
              throw new Error("Recurring protected Task did not advance");
            }
            recurringProofs.push(Object.freeze({
              taskRunId: createdRun.id,
              graphThreadId: createdRun.graphThreadId,
              jobId: completedRun.jobId,
              requestId: executionRequestId,
              resultObjectId,
              messageId: message.messageId,
              messageObjectId: message.messageObjectId,
              nextFireAt: scheduled.nextFireAt,
            }));

            await observer.tick();
            expect(await base.admin.select({ id: taskRuns.id })
              .from(taskRuns).where(eq(taskRuns.taskId, activeConnected.taskId)))
              .toHaveLength(seenRunIds.size);
            observerNow = new Date(scheduled.nextFireAt.getTime());
          }
          await observer.stop();
          recurringObserver.current = null;
          expect(new Set(recurringProofs.map(proof => proof.taskRunId)).size)
            .toBe(2);
          expect(new Set(recurringProofs.map(proof => proof.graphThreadId)).size)
            .toBe(2);
          expect(new Set(recurringProofs.map(proof => proof.jobId)).size)
            .toBe(2);
          expect(new Set(recurringProofs.map(proof => proof.requestId)).size)
            .toBe(2);
          expect(new Set(recurringProofs.map(proof => proof.resultObjectId)).size)
            .toBe(2);
          expect(new Set(recurringProofs.map(proof => proof.messageId)).size)
            .toBe(2);
          expect(new Set(recurringProofs.map(proof => proof.messageObjectId)).size)
            .toBe(2);
          expect(recurringProofs[1]!.nextFireAt.getTime())
            .toBeGreaterThan(recurringProofs[0]!.nextFireAt.getTime());
        }
        const exactRuns = await base.admin.select({ id: taskRuns.id })
          .from(taskRuns).where(eq(taskRuns.taskId, connected.taskId));
        const exactJobs = await base.admin.select({ id: jobs.id })
          .from(jobs).where(eq(jobs.laneKey, `task:${connected.taskId}`));
        if (recurringEncryptedOccurrences) {
          expect(new Set(exactRuns.map(run => run.id))).toEqual(new Set([
            connected.taskRunId,
            ...recurringProofs.map(proof => proof.taskRunId),
          ]));
          expect(new Set(exactJobs.map(job => job.id))).toEqual(new Set([
            terminal.job.id,
            ...recurringProofs.map(proof => proof.jobId),
          ]));
        } else {
          expect(exactRuns).toEqual([{ id: connected.taskRunId }]);
        }
        if (continuedExecution) {
          expect(parkedPriorJobId).not.toBeNull();
          expect(terminal.job.id).not.toBe(parkedPriorJobId);
          expect(exactJobs.map(job => job.id).sort()).toEqual([
            parkedPriorJobId!,
            terminal.job.id,
          ].sort());
          expect(controlledEffectExecutions)
            .toBe(scenario === "parked continuation" ? 1 : 0);
          expect(segmentContinuationModes).toEqual([false, true]);
          if (checkpointContinuationScenario) {
            const checkpointRequestId =
              checkpointContinuationAuthorizationRequestId;
            if (checkpointRequestId === null) {
              throw new Error("Checkpoint continuation grant was unavailable");
            }
            expect(checkpointRequestId)
              .not.toBe(`task-run-authorization:${connected.taskRunId}`);
            const authorizationRows = await base.admin.select({
              requestId: backgroundCryptoAuthorizationRequests.requestId,
              state: backgroundCryptoAuthorizationRequests.state,
              workId: backgroundCryptoAuthorizationRequests.workId,
            }).from(backgroundCryptoAuthorizationRequests).where(inArray(
              backgroundCryptoAuthorizationRequests.requestId,
              [
                `task-run-authorization:${connected.taskRunId}`,
                checkpointRequestId,
              ],
            ));
            expect(authorizationRows.sort((left, right) =>
              left.requestId.localeCompare(right.requestId))).toEqual([
              {
                requestId:
                  `task-run-authorization:${connected.taskRunId}`,
                state: "completed",
                workId: connected.taskRunId,
              },
              {
                requestId: checkpointRequestId,
                state: "completed",
                workId: connected.taskRunId,
              },
            ].sort((left, right) =>
              left.requestId.localeCompare(right.requestId)));
          }
        } else if (!recurringEncryptedOccurrences) {
          expect(exactJobs).toEqual([{ id: terminal.job.id }]);
        }
        const [terminalTask] = await base.admin.select({
          status: tasks.status,
          prompt: tasks.prompt,
          expectedOutput: tasks.expectedOutput,
          lastError: tasks.lastError,
        }).from(tasks).where(eq(tasks.id, connected.taskId));
        expect(terminalTask).toEqual({
          status: recurringEncryptedOccurrences ? "pending" : "completed",
          prompt: wakeForegroundShadow || deepResearchShadow
            || protectedCodexShadow || protectedAcpShadow || historicalDefinition
            || recurringEncryptedOccurrences
            ? "Complete the connected protected Task"
            : "",
          expectedOutput: null,
          lastError: null,
        });
        if (historicalDefinition) {
          const [retained] = await base.admin.select({
            objectId: taskDefinitionCryptoRevisions.cryptoObjectId,
            provenance: taskDefinitionCryptoRevisions.historicalRepair,
            requestDigest: taskDefinitionCryptoRevisions.requestDigest,
            completion: taskDefinitionCryptoRevisions.completion,
            disposition: taskDefinitionCryptoRevisions.disposition,
          }).from(taskDefinitionCryptoRevisions).where(eq(taskDefinitionCryptoRevisions.taskId, connected.taskId));
          expect(retained).toMatchObject({ objectId: connected.inputObjectId,
            provenance: occurrence.task.definitionHistoricalRepair,
            completion: "complete", disposition: "mapped" });
          const retainedSignedRequestDigest =
            occurrence.task.definitionHistoricalRepair
              ?.["signedRequestDigest"];
          if (typeof retainedSignedRequestDigest !== "string") {
            throw new Error(
              "Historical Task definition signed request digest was unavailable",
            );
          }
          expect(Buffer.from(retained!.requestDigest).toString("hex"))
            .toBe(retainedSignedRequestDigest);
          expect(await objectRowCounts(base, connected.inputObjectId))
            .toEqual({ payload: 1, head: 1, manifest: 1, envelope: 1 });
        }
        if (recurringEncryptedOccurrences) {
          expect(segmentCalls).toEqual([
            {
              taskId: activeConnected.taskId,
              taskRunId: activeConnected.taskRunId,
              graphThreadId: activeConnected.graphThreadId,
            },
            ...recurringProofs.map(proof => ({
              taskId: activeConnected.taskId,
              taskRunId: proof.taskRunId,
              graphThreadId: proof.graphThreadId,
            })),
          ]);
          expect(segmentContinuationModes).toEqual([false, false, false]);
        } else {
          expect(segmentCalls).toEqual(Array.from(
            { length: deepResearch || protectedExternal
              ? 0
              : continuedExecution ? 2 : 1 },
            () => ({
              taskId: activeConnected.taskId,
              taskRunId: activeConnected.taskRunId,
              graphThreadId: activeConnected.graphThreadId,
            }),
          ));
        }
        if (callerLocalExecution) {
          if (callerFunding === null || delegatedLocal.current === null) {
            throw new Error("Caller/local protected Task fixture was unavailable");
          }
          expect(callerFunding.requests).toHaveLength(1);
          expect(callerFunding.requests[0]).toMatchObject({
            authorization: `Bearer ${callerFunding.apiKey}`,
            url: "https://openrouter.ai/api/v1/chat/completions",
          });
          expect(callerFunding.requests[0]?.body)
            .not.toContain(callerFunding.apiKey);
          const dispatches = delegatedLocal.current.messages.filter(
            message => message.type === "relay:dispatch",
          );
          expect(dispatches).toHaveLength(1);
          expect(dispatches[0]).toMatchObject({
            type: "relay:dispatch",
            toolName: "exec_command",
            args: { cmd: "printf protected-task-local" },
            localExecutionBinding: {
              version: 4,
              operation: "start",
              authority: {
                kind: "delegated",
                taskId: activeConnected.taskId,
                taskRunId: activeConnected.taskRunId,
                roomId: base.roomId,
                delegation: {
                  target: {
                    pairingGeneration:
                      delegatedLocal.current.delegation.target
                        .pairingGeneration,
                  },
                },
              },
            },
          });
          expect(JSON.stringify(dispatches)).not.toContain(callerFunding.apiKey);
        }
        expect(await objectRowCounts(base, connected.resultObjectId)).toEqual({
          payload: 1,
          head: 1,
          manifest: 1,
          envelope: 1,
        });
        const sessionRows = await base.admin.select({
          id: sessions.id,
          ownerId: sessions.ownerId,
          agentId: sessions.agentId,
          roomId: sessions.roomId,
        }).from(sessions).where(eq(
          sessions.threadId,
          connected.graphThreadId,
        ));
        expect(sessionRows).toHaveLength(1);
        expect(sessionRows[0]).toMatchObject({
          ownerId: base.userId,
          agentId: base.productAgentId,
          roomId: base.roomId,
        });
        const transcriptRows = await base.admin.select({ id: sessionMessages.id,
          role: sessionMessages.role, content: sessionMessages.content,
          objectId: sessionMessages.cryptoObjectId })
          .from(sessionMessages).where(eq(sessionMessages.sessionId, sessionRows[0]!.id));
        expect(transcriptRows).toHaveLength(
          deepResearch || protectedExternal ? 1 : 0,
        );
        if (deepResearch || protectedExternal) {
          if (deepResearch) expect(researchStreamCalls).toHaveLength(1);
          expect(transcriptRows[0]).toMatchObject({ role: "assistant",
            content: deepResearchShadow || protectedCodexShadow || protectedAcpShadow
              ? protectedExternalResultText
              : null });
          const objectId = transcriptRows[0]?.objectId;
          if (!objectId) throw new Error("External protected transcript object missing");
          base.objectIds.add(objectId);
          expect(await objectRowCounts(base, objectId)).toEqual({ payload: 1, head: 1, manifest: 1, envelope: 1 });
          expect(await base.admin.select({ completion: sessionMessageCryptoRevisions.completion,
            disposition: sessionMessageCryptoRevisions.disposition, objectId: sessionMessageCryptoRevisions.cryptoObjectId })
            .from(sessionMessageCryptoRevisions).where(eq(sessionMessageCryptoRevisions.messageId, transcriptRows[0]!.id)))
            .toEqual([{ completion: "complete", disposition: "mapped", objectId }]);
          if (deepResearch) {
            expect(JSON.stringify(researchEvents)).not.toContain("private_research_progress_canary");
            expect(JSON.stringify(researchEvents)).not.toContain("Complete the connected protected Task");
            expect(JSON.stringify(researchEvents)).not.toContain("Connected protected result");
            expect(researchEvents.filter(event => event !== null && typeof event === "object"
              && Reflect.get(event, "type") === "task.progress")).toEqual([]);
          }
        }
        if (protectedCodex) {
          if (codexReadiness === null) {
            throw new Error("Protected Codex readiness receipt disappeared");
          }
          expect(codexBindingIds).toHaveLength(1);
          const [codexBindingId] = codexBindingIds;
          if (codexBindingId === undefined) {
            throw new Error("Protected Codex binding identity disappeared");
          }
          expect(codexPartitionIdentities).toEqual([{
            relayId: codexReadiness.relayId,
            bindingId: codexBindingId,
            bindingGeneration: 0,
            taskId: activeConnected.taskId,
            jobId: terminal.job.id,
          }]);
          expect(codexCalls.filter(call => call === "start")).toHaveLength(1);
          expect(codexCalls.filter(call => call === "protect")).toHaveLength(1);
          expect(codexCalls.filter(call => call === "retire")).toHaveLength(1);
          expect(codexCalls.filter(call => call === "preflight")).toHaveLength(3);
          expect(codexCalls.filter(call => call === "models")).toHaveLength(3);
          expect(codexCalls.filter(call => call === "limits")).toHaveLength(3);
          expect(codexCalls.indexOf("protect")).toBeLessThan(
            codexCalls.indexOf("start"),
          );
          expect(codexCalls.indexOf("retire")).toBeGreaterThan(
            codexCalls.indexOf("start"),
          );
          expect(JSON.stringify(terminal.job)).not.toContain(
            protectedExternalResultText,
          );
          expect(JSON.stringify(terminal.job)).not.toContain(
            "Complete the connected protected Task",
          );
          expect(JSON.stringify(researchEvents)).not.toContain(
            protectedExternalResultText,
          );
          expect(researchEvents.filter(event => event !== null
            && typeof event === "object"
            && Reflect.get(event, "type") === "task.progress")).toEqual([]);
        }
        if (protectedAcpProvider !== null) {
          if (acpReadiness === null) {
            throw new Error("Protected ACP readiness receipt is unavailable");
          }
          expect(acpPrompts).toEqual(["Complete the connected protected Task"]);
          expect(acpScopes).toHaveLength(1);
          expect(acpScopes[0]?.binding).toMatchObject({
            ownerId: base.userId,
            taskId: activeConnected.taskId,
            taskRunId: activeConnected.taskRunId,
            jobId: terminal.job.id,
          });
          expect(acpScopes[0]?.socket).toEqual(acpReadiness);
          expect(acpCalls.filter(call => call === "start")).toHaveLength(1);
          expect(acpCalls.filter(call => call === "subscribe")).toHaveLength(1);
          expect(acpCalls.filter(call => call === "readiness")).toHaveLength(1);
          expect(acpCalls.filter(call => call === "prepare")).toHaveLength(1);
          expect(acpAcknowledgements).toHaveLength(3);
          expect(acpAcknowledgements.map(value => value.eventSequence))
            .toEqual([2, 3, 4]);
          expect(acpCloseCalls).toBe(1);
          expect(acpContainCalls).toBe(0);
          expect(JSON.stringify(terminal.job)).not.toContain(
            protectedExternalResultText,
          );
          expect(JSON.stringify(terminal.job)).not.toContain(
            "Complete the connected protected Task",
          );
          expect(JSON.stringify(researchEvents)).not.toContain(
            protectedExternalResultText,
          );
          expect(JSON.stringify(researchEvents)).not.toContain(
            "Complete the connected protected Task",
          );
          expect(researchEvents.filter(event => event !== null
            && typeof event === "object"
            && Reflect.get(event, "type") === "task.progress")).toEqual([]);
        }
        expect(recipients.size).toBe(0);
      }
      }
      }
    } catch (error) {
      testError = error;
    }
    if (deepResearch || protectedExternal) {
      eventBus.off(onResearchEvent);
    }
    projectionRollback.current?.restore();
    if (recurringObserver.current !== null) {
      try {
        await recurringObserver.current.stop();
      } catch (error) {
        cleanupError = error;
      }
    }
    if (closeComposition !== null) {
      try {
        await closeComposition();
      } catch (error) {
        cleanupError = error;
      }
    }
    if (connected !== null && connectedJobId !== null && jobManager !== null) {
      try {
        await jobManager.abortProtectedTaskRunAndWait({
          taskId: connected.taskId,
          taskRunId: connected.taskRunId,
          jobId: connectedJobId,
        });
      } catch (error) {
        cleanupError = error;
      }
    }
    if (delegatedLocal.current !== null) {
      try {
        await delegatedLocal.current.restore();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (callerFunding !== null) {
      try {
        await callerFunding.restore();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    try {
      recipients.close();
      await base.cleanup();
    } catch (error) {
      cleanupError ??= error;
    }
    projectionCiphertextHash.current?.fill(0);
    if (testError !== undefined && cleanupError !== undefined) {
      throw new AggregateError(
        [testError, cleanupError],
        "Connected protected Task test and cleanup both failed",
      );
    }
    if (testError !== undefined) {
      throw testError instanceof Error
        ? testError
        : new Error("Connected protected Task test threw a non-Error value", {
          cause: testError,
        });
    }
    if (cleanupError !== undefined) {
      throw cleanupError instanceof Error
        ? cleanupError
        : new Error(
          "Connected protected Task cleanup threw a non-Error value",
          { cause: cleanupError },
        );
    }
  };
  for (const scenario of genuineRoleScenarios) {
    const wakeScenario = scenario === "wake foreground full"
      || scenario === "wake foreground shadow"
      || scenario === "wake projection grant resume"
      || scenario === "wake projection rollback recovery";
    test(`executes one genuine-role protected Task through ${scenario}`,
      () => executeGenuineRoleScenario(scenario),
      wakeScenario ? 2 * TASK_RUNTIME_AUTHORIZATION_ABSOLUTE_LIMIT_MS : 120_000);
  }

  test("commits under genuine authority and serializes cancellation and expiry", async () => {
    const base = await createBaseFixture();
    let testError: unknown;
    try {
      const scopeId = randomUUID();
      const scopeTaskId = randomUUID();
      const scopeTaskObjectId = deriveTaskContentCryptoObjectIdV1({
        kind: "definition",
        taskId: scopeTaskId,
        contentRevision: 1,
      });
      const scopeTaskFingerprint = fingerprintRequiredMemoryNamespaces([
        base.namespaceValue,
      ]);
      const seedMemoryId = randomUUID();
      base.scopeIds.add(scopeId);
      base.taskIds.add(scopeTaskId);
      base.objectIds.add(scopeTaskObjectId);
      base.memoryIds.add(seedMemoryId);
      try {
        await base.admin.transaction(async (tx) => {
          await tx.insert(agentScopes).values({
            id: scopeId,
            parentAgentId: base.productAgentId,
            speakerUserId: base.userId,
            name: `task-memory-scope-${scopeId}`,
          });
          await tx.insert(cryptoObjects).values({
            objectId: scopeTaskObjectId,
            payloadHash: digest(`task-scope-payload:${scopeTaskId}`),
            payloadBytes: Uint8Array.of(1),
          });
          await tx.insert(tasks).values({
            id: scopeTaskId,
            ownerId: base.userId,
            requestorId: base.userId,
            agentId: base.productAgentId,
            prompt: "",
            scheduleKind: "now",
            callingRoomId: base.roomId,
            targetRoomId: base.roomId,
            targetUserIds: [base.userId],
            status: "pending",
            useScope: true,
            scopeId,
          });
          await tx.insert(taskDefinitionCryptoRevisions).values({
            taskId: scopeTaskId,
            contentNamespaceId: base.namespaceValue,
            contentRevision: 1,
            operationId: `task-scope-definition:${randomUUID()}`,
            requestDigest: digest(`task-scope-request:${scopeTaskId}`),
            authorityFingerprint: digest(`task-scope-authority:${scopeTaskId}`),
            requesterHumanId: base.humanActorId,
            anchorNamespaceId: base.namespaceValue,
            cryptoObjectId: scopeTaskObjectId,
            representation: "protected",
            requiredNamespaceFingerprint: scopeTaskFingerprint,
            completion: "complete",
            disposition: "mapped",
            cryptoCompletedAt: new Date(NOW),
          });
          await tx.update(tasks).set({
            contentRepresentation: "protected",
            contentNamespaceId: base.namespaceValue,
            contentRevision: 1,
            cryptoObjectId: scopeTaskObjectId,
            cryptoAccessRevision: 0,
            cryptoRequiredNamespaceFingerprint: scopeTaskFingerprint,
            cryptoMappingState: "verified",
          }).where(eq(tasks.id, scopeTaskId));
          await tx.insert(memories).values({
            id: seedMemoryId,
            type: "fact",
            content: "Unattached Scope seed Memory",
            importance: 0.7,
            tier: 1,
            createdAt: new Date(NOW),
          });
          await tx.insert(memoryNamespaces).values({
            memoryId: seedMemoryId,
            namespaceId: base.seedNamespaceValue,
          });
        });
      } finally {
        scopeTaskFingerprint.fill(0);
      }

      const originReadableIds = Object.freeze([base.namespaceValue]);
      const expandedReadableIds = Object.freeze([
        base.namespaceValue,
        base.seedNamespaceValue,
      ].sort());
      const scopeBinding = Object.freeze({
        scopeId,
        memoryRoomId: base.roomId,
        originWritableNamespaceId: base.namespaceValue,
        readableNamespaceIds: originReadableIds,
      }) satisfies TaskScopeMemoryBinding;
      const scopeAuthorityInput = (
        restricted: PostgresJsBridgeConnection,
        runner: ConversationProductCanonicalTransactionRunner,
        scopeMemory: TaskScopeMemoryBinding | undefined,
        namespaceIds: readonly string[],
      ) => ({
        runner,
        restricted,
        crypto: base.crypto,
        serverScope: SERVER_SCOPE,
        taskId: scopeTaskId,
        requesterUserId: base.userId,
        requesterHumanId: base.humanActorId,
        agentId: base.productAgentId,
        contentNamespaceId: base.namespaceValue,
        sourceRoomId: base.roomId,
        targetRoomId: base.roomId,
        namespaceIds,
        ...(scopeMemory === undefined ? {} : { scopeMemory }),
        expectedPolicyRevision: base.policyRevision,
      });
      const initialScopeAuthority = await inspectInitialTaskRuntimeNamespaceAuthority(
        scopeAuthorityInput(
          base.restricted,
          base.product.canonicalRunner,
          scopeBinding,
          originReadableIds,
        ),
      );
      expect(initialScopeAuthority).toMatchObject({
        sourceRoomId: base.roomId,
        sourceNamespaceId: base.namespaceValue,
        facts: [{
          namespaceId: base.namespaceValue,
          expectedPolicyRevision: base.policyRevision,
        }],
      });
      const contentAuthority = await inspectTaskContentNamespaceAuthority({
        runner: base.product.canonicalRunner,
        restricted: base.restricted,
        crypto: base.crypto,
        serverScope: SERVER_SCOPE,
        taskId: scopeTaskId,
        requesterUserId: base.userId,
        requesterHumanId: base.humanActorId,
        agentId: base.productAgentId,
        contentNamespaceId: base.namespaceValue,
        sourceRoomId: base.roomId,
        expectedPolicyRevision: base.policyRevision,
      });
      expect(contentAuthority?.sourceRoomId).toBe(base.roomId);
      expect(contentAuthority?.sourceNamespaceId).toBe(base.namespaceValue);
      expect(contentAuthority?.facts).toHaveLength(1);
      expect(contentAuthority?.facts[0]).toEqual({
        namespaceId: base.namespaceValue,
        domainId: base.namespace.domainId,
        expectedAccessRevision: base.namespace.accessRevision,
        expectedPolicyRevision: base.policyRevision,
        expectedDomainEpoch: base.namespace.domainKeyGeneration,
        expectedAuthorizationRevision:
          base.namespace.domainAuthorizationRevision,
      });
      expect(await inspectInitialTaskRuntimeNamespaceAuthority(
        scopeAuthorityInput(
          base.restricted,
          base.product.canonicalRunner,
          undefined,
          originReadableIds,
        ),
      )).toBeNull();
      expect(await inspectInitialTaskRuntimeNamespaceAuthority(
        scopeAuthorityInput(
          base.restricted,
          base.product.canonicalRunner,
          Object.freeze({ ...scopeBinding, scopeId: randomUUID() }),
          originReadableIds,
        ),
      )).toBeNull();
      expect(await inspectInitialTaskRuntimeNamespaceAuthority(
        scopeAuthorityInput(
          base.restricted,
          base.product.canonicalRunner,
          Object.freeze({ ...scopeBinding, memoryRoomId: base.seedRoomId }),
          originReadableIds,
        ),
      )).toBeNull();
      expect(await inspectInitialTaskRuntimeNamespaceAuthority(
        scopeAuthorityInput(
          base.restricted,
          base.product.canonicalRunner,
          Object.freeze({
            ...scopeBinding,
            readableNamespaceIds: expandedReadableIds,
          }),
          expandedReadableIds,
        ),
      )).toBeNull();

      // This is the canonical Scope mutation lock contract: take Scope UPDATE
      // before inserting a seed edge. The authority reader's Scope SHARE fence
      // must hold the empty inventory stable until its restricted proof ends.
      const scopeGate = gatedRestrictedConnection(base.restricted);
      const observedScopeReader = observeCanonicalRunner(
        base.product.canonicalRunner,
      );
      let lockedScopeAuthority: ReturnType<
        typeof inspectInitialTaskRuntimeNamespaceAuthority
      > | null = null;
      let attachSeed: Promise<readonly string[]> | null = null;
      try {
        lockedScopeAuthority = inspectInitialTaskRuntimeNamespaceAuthority(
          scopeAuthorityInput(
            scopeGate.connection,
            observedScopeReader.runner,
            scopeBinding,
            originReadableIds,
          ),
        );
        const admission = await Promise.race([
          scopeGate.entered.then(() => "entered" as const),
          lockedScopeAuthority.then(() => "completed" as const),
        ]);
        if (admission !== "entered") {
          throw new Error(
            "Initial Scope authority ended before restricted admission",
          );
        }
        attachSeed = base.agentProduct.canonicalRunner.transaction(
          async (tx) => {
            const currentScopes = await tx.select({
              id: agentScopes.id,
              parentAgentId: agentScopes.parentAgentId,
              speakerUserId: agentScopes.speakerUserId,
              lifecycleState: agentScopes.lifecycleState,
            }).from(agentScopes).where(eq(agentScopes.id, scopeId))
              .limit(2).for("update");
            const currentScope = currentScopes[0];
            if (currentScopes.length !== 1 || currentScope === undefined
              || currentScope.id !== scopeId
              || currentScope.parentAgentId !== base.productAgentId
              || currentScope.speakerUserId !== base.userId
              || currentScope.lifecycleState !== "open") {
              throw new Error("Scope seed attach authority changed");
            }
            const inserted = await tx.insert(memoryScopes).values({
              memoryId: seedMemoryId,
              scopeId,
              origin: "seed",
            }).returning({ memoryId: memoryScopes.memoryId });
            return Object.freeze(inserted.map(row => row.memoryId));
          }, { isolationLevel: "serializable" });
        await waitForBlockedContender(base, await observedScopeReader.pid);
        scopeGate.release();
        const [lockedAuthority, attachedIds] = await Promise.all([
          lockedScopeAuthority,
          attachSeed,
        ]);
        expect(lockedAuthority).toMatchObject({
          facts: [{ namespaceId: base.namespaceValue }],
        });
        expect(attachedIds).toEqual([seedMemoryId]);
      } catch (error) {
        scopeGate.release();
        await Promise.allSettled([
          ...(lockedScopeAuthority === null ? [] : [lockedScopeAuthority]),
          ...(attachSeed === null ? [] : [attachSeed]),
        ]);
        throw error;
      }
      expect(await inspectInitialTaskRuntimeNamespaceAuthority(
        scopeAuthorityInput(
          base.restricted,
          base.product.canonicalRunner,
          scopeBinding,
          originReadableIds,
        ),
      )).toBeNull();
      const expandedScopeBinding = Object.freeze({
        ...scopeBinding,
        readableNamespaceIds: expandedReadableIds,
      }) satisfies TaskScopeMemoryBinding;
      const expandedScopeAuthority =
        await inspectInitialTaskRuntimeNamespaceAuthority(scopeAuthorityInput(
          base.restricted,
          base.product.canonicalRunner,
          expandedScopeBinding,
          expandedReadableIds,
        ));
      expect(expandedScopeAuthority?.facts.map(fact => fact.namespaceId)).toEqual(
        [...expandedReadableIds],
      );

      const successful = await createScenario(base);
      const successfulStatus = await successful.execute(() => NOW + 5);
      if (successfulStatus !== "created") {
        throw new Error(
          `Task Memory success path returned ${successfulStatus}`,
        );
      }
      expect(await objectRowCounts(base, successful.memoryObjectId)).toEqual({
        payload: 1,
        head: 1,
        manifest: 1,
        envelope: 1,
      });

      // Full is the first qualified native vertical. Shadow remains NOT
      // QUALIFIED by this integration receipt.
      const nativeMemory = await createScenario(base);
      const nativeContent = `native Task Memory ${randomUUID()}`;
      const nativeResult = await nativeMemory.withPreparedWrite(
        () => NOW + 5,
        async ({ writer }) => withProtectedTaskNativeMemoryRepository({
          authority: Object.freeze({
            mode: "namespace",
            subjectUserId: base.userId,
            agentId: base.productAgentId,
            readableNamespaceIds: Object.freeze([base.namespaceValue]),
            mutableNamespaceIds: Object.freeze([base.namespaceValue]),
            writableNamespaceId: base.namespaceValue,
          }),
          policy: Object.freeze({
            mode: "encrypted_only",
            shadowBehavior: "strict",
            revision: base.policyRevision,
          }),
          current: writer,
          domains: Object.freeze([base.domainSecret]),
          signer: Object.freeze({
            agentAuthorizationRevision: 7,
            runtime: base.runtime.runtime,
            signerPublication: base.runtime.signerPublication,
          }),
          resolveHistoricalSignerPublicationManager: () =>
            base.currentDevice.signingPublicKey,
          product: base.product,
          agentProduct: base.agentProduct,
          owner: bindEncryptionDataOperationOwner({
            policy: {
              resolve: async () => Object.freeze({
                policy: Object.freeze({
                  mode: "encrypted_only" as const,
                  shadowBehavior: "strict" as const,
                }),
                revalidationToken: base.policyRevision,
              }),
              revalidate: async token => {
                if (token !== base.policyRevision) {
                  throw new TypeError("Task Memory policy token changed");
                }
              },
            },
          }),
          embedding: Object.freeze({
            embed: async () => Object.freeze({
              status: "success" as const,
              value: Object.freeze({
                vector: Object.freeze(new Array<number>(1536).fill(0.25)),
                provider: "openai",
                canonicalModel: "text-embedding-3-small",
                dimensions: 1536 as const,
                contractVersion: 1,
              }),
            }),
          }),
          execute: async repository => {
            const saved = await repository.save({
              operationId: `native-task-memory-save:${randomUUID()}`,
              authority: Object.freeze({
                mode: "namespace",
                subjectUserId: base.userId,
                agentId: base.productAgentId,
                readableNamespaceIds: Object.freeze([base.namespaceValue]),
                mutableNamespaceIds: Object.freeze([base.namespaceValue]),
                writableNamespaceId: base.namespaceValue,
              }),
              type: "fact",
              content: nativeContent,
              importance: 0.8,
            });
            if (saved.status !== "success") {
              throw new Error(`Native Task Memory save failed: ${saved.reason}`);
            }
            base.memoryIds.add(saved.value.id);
            base.objectIds.add(deriveMemoryCryptoObjectIdV1({
              memoryId: saved.value.id,
              contentRevision: 1,
            }));
            const searched = await repository.search({
              authority: Object.freeze({
                mode: "namespace",
                subjectUserId: base.userId,
                agentId: base.productAgentId,
                readableNamespaceIds: Object.freeze([base.namespaceValue]),
                mutableNamespaceIds: Object.freeze([base.namespaceValue]),
                writableNamespaceId: base.namespaceValue,
              }),
              query: nativeContent,
              limit: 5,
              includeArchive: false,
              mode: "vector",
            });
            return Object.freeze({ saved, searched });
          },
        }),
      );
      expect(nativeResult.saved.value).toMatchObject({ action: "created" });
      const nativeObjectId = deriveMemoryCryptoObjectIdV1({
        memoryId: nativeResult.saved.value.id,
        contentRevision: 1,
      });
      const [nativeMemoryAtRest] = await base.admin.select({
        content: memories.content,
        type: memories.type,
        contentRevision: memories.contentRevision,
        cryptoAccessRevision: memories.cryptoAccessRevision,
        cryptoObjectId: memories.cryptoObjectId,
        cryptoMappingState: memories.cryptoMappingState,
      }).from(memories).where(eq(
        memories.id,
        nativeResult.saved.value.id,
      ));
      expect(nativeMemoryAtRest).toEqual({
        content: null,
        type: null,
        contentRevision: 1,
        cryptoAccessRevision: 0,
        cryptoObjectId: nativeObjectId,
        cryptoMappingState: "verified",
      });
      const [nativeCiphertextAtRest] = await base.admin.select({
        objectId: cryptoObjects.objectId,
        payloadBytes: cryptoObjects.payloadBytes,
        payloadHash: cryptoObjects.payloadHash,
      }).from(cryptoObjects).where(eq(
        cryptoObjects.objectId,
        nativeObjectId,
      ));
      expect(nativeCiphertextAtRest?.objectId).toBe(nativeObjectId);
      expect(nativeCiphertextAtRest?.payloadBytes.byteLength).toBeGreaterThan(0);
      expect(nativeCiphertextAtRest?.payloadHash.byteLength).toBe(32);
      expect(nativeResult.searched).toMatchObject({
        status: "success",
        value: [expect.objectContaining({
          id: nativeResult.saved.value.id,
          type: "fact",
          content: nativeContent,
        })],
      });

      const heldSuccess = await createScenario(base);
      const heldSuccessRunner = observeCanonicalRunner(
        base.product.canonicalRunner,
      );
      let escapedHeld: HeldProtectedTaskMemoryAuthority | null = null;
      let escapedAssertCurrent: (() => Promise<void>) | null = null;
      let escapedRestricted: PostgresJsBridgeConnection | null = null;
      let escapedRestrictedHandle: CryptoPostgresHandle | null = null;
      let escapedProductHandle: ConversationProductPostgresHandle | null = null;
      let restrictedQueryCalls = 0;
      const observedRestricted = observeRestrictedConnection(
        base.restricted,
        () => {
          restrictedQueryCalls += 1;
        },
      );
      const heldSuccessStatus = await heldSuccess.withPreparedWrite(
        () => NOW + 5,
        async ({ evidence, writer, write }) => {
          const result = await withCurrentProtectedTaskMemoryAuthority(
            writer,
            async held => {
              escapedHeld = held;
              const binding = requireHeldProtectedTaskMemoryWriterAuthority(
                held,
              );
              expect(binding.evidence).toBe(evidence);
              await binding.assertCurrent();
              escapedAssertCurrent = binding.assertCurrent;
              escapedRestricted = binding.restricted;
              escapedRestrictedHandle = binding.restrictedHandle;
              escapedProductHandle = binding.productHandle;
              return persistProtectedTaskMemoryObjectUnderHeld(held, write);
            },
          );
          expect(result).toBe("created");
          const closedHeld = escapedHeld;
          const closedAssertCurrent = escapedAssertCurrent as
            (() => Promise<void>) | null;
          if (closedHeld === null || closedAssertCurrent === null) {
            throw new Error("Held Task Memory authority was not observed");
          }
          const closedRestricted = escapedRestricted;
          const closedRestrictedHandle = escapedRestrictedHandle;
          const closedProductHandle = escapedProductHandle;
          if (closedRestricted === null || closedRestrictedHandle === null
            || closedProductHandle === null) {
            throw new Error("Held Task Memory restricted authority was not observed");
          }
          const queriesBeforeClosedUse = restrictedQueryCalls;
          expect(() => requireHeldProtectedTaskMemoryWriterAuthority(
            closedHeld,
          )).toThrow("Task Memory authority is not active");
          for (const assertCurrent of [
            closedHeld.assertCurrent,
            closedAssertCurrent,
          ]) {
            let rejection: unknown;
            try {
              await assertCurrent();
            } catch (error) {
              rejection = error;
            }
            expect(rejection).toBeInstanceOf(TypeError);
            expect((rejection as Error).message).toBe(
              "Task Memory authority is not active",
            );
          }
          let restrictedRejection: unknown;
          try {
            await closedRestricted.query(
              "SELECT pg_backend_pid()::integer AS pid",
            );
          } catch (error) {
            restrictedRejection = error;
          }
          expect(restrictedRejection).toBeInstanceOf(TypeError);
          expect((restrictedRejection as Error).message).toBe(
            "Task Memory authority is not active",
          );
          let repositoryRejection: unknown;
          try {
            await new PostgresLatticeStorage(closedRestrictedHandle).getGrant(
              "closed-task-memory-held-authority",
            );
          } catch (error) {
            repositoryRejection = error;
          }
          expect(repositoryRejection).toBeInstanceOf(TypeError);
          expect((repositoryRejection as Error).message).toBe(
            "Task Memory authority is not active",
          );
          expect(restrictedQueryCalls).toBe(queriesBeforeClosedUse);
          await Promise.resolve(expect(executeTypedConversationProductQuery(
            closedProductHandle,
            conversationProductTypedDb.select({ id: memories.id })
              .from(memories).limit(1),
          )).rejects.toThrow("Task Memory authority is not active"));
          return result;
        },
        observedRestricted,
        heldSuccessRunner.runner,
      );
      expect(heldSuccessStatus).toBe("created");
      expect(heldSuccessRunner.transactionCalls()).toBe(1);
      expect(await objectRowCounts(base, heldSuccess.memoryObjectId)).toEqual({
        payload: 1,
        head: 1,
        manifest: 1,
        envelope: 1,
      });

      const callbackFailure = await createScenario(base);
      const callbackFailureRunner = observeCanonicalRunner(
        base.product.canonicalRunner,
      );
      const intendedFailure = new Error("held callback failed after CAS");
      let observedFailure: unknown;
      try {
        await callbackFailure.withPreparedWrite(
          () => NOW + 5,
          async ({ writer, write }) => {
            await withCurrentProtectedTaskMemoryAuthority(
              writer,
              async held => {
                expect(await persistProtectedTaskMemoryObjectUnderHeld(
                  held,
                  write,
                )).toBe("created");
                throw intendedFailure;
              },
            );
          },
          base.restricted,
          callbackFailureRunner.runner,
        );
      } catch (error) {
        observedFailure = error;
      }
      expect(observedFailure).toBe(intendedFailure);
      expect(callbackFailureRunner.transactionCalls()).toBe(1);
      expect(await objectRowCounts(
        base,
        callbackFailure.memoryObjectId,
      )).toEqual({ payload: 0, head: 0, manifest: 0, envelope: 0 });

      // The writer has already taken policy -> Task -> Run -> Job when the
      // restricted gate opens. A canonical Stop submitted at that point must
      // wait, so the complete payload + access CAS wins before cancellation.
      const writerFirst = await createScenario(base);
      const gate = gatedRestrictedConnection(base.restricted);
      const observedWriter = observeCanonicalRunner(
        base.product.canonicalRunner,
      );
      const writer = writerFirst.execute(
        () => NOW + 5,
        gate.connection,
        observedWriter.runner,
      );
      await gate.entered;
      const cancellation = transitionTaskLifecycleTerminal(base.productDb, {
        taskId: writerFirst.taskId,
        taskStatus: "cancelled",
        taskPatch: { cancelledAt: new Date(NOW + 6) },
        runId: writerFirst.taskRunId,
        runStatus: "cancelled",
      });
      let writeStatus: Awaited<typeof writer>;
      let cancelled: Awaited<typeof cancellation>;
      try {
        await waitForBlockedContender(base, await observedWriter.pid);
        gate.release();
        [writeStatus, cancelled] = await Promise.all([writer, cancellation]);
      } catch (error) {
        gate.release();
        await Promise.allSettled([writer, cancellation]);
        throw error;
      }
      expect(writeStatus).toBe("created");
      expect(cancelled).toMatchObject({
        transitioned: true,
        outcome: "transitioned",
        task: undefined,
        run: undefined,
        protectedTask: { status: "cancelled" },
        protectedRun: { status: "cancelled" },
      });
      expect(await objectRowCounts(base, writerFirst.memoryObjectId)).toEqual({
        payload: 1,
        head: 1,
        manifest: 1,
        envelope: 1,
      });

      const cancellationFirst = await createScenario(base);
      expect(await transitionTaskLifecycleTerminal(base.productDb, {
        taskId: cancellationFirst.taskId,
        taskStatus: "cancelled",
        taskPatch: { cancelledAt: new Date(NOW + 6) },
        runId: cancellationFirst.taskRunId,
        runStatus: "cancelled",
      })).toMatchObject({ transitioned: true, outcome: "transitioned" });
      expect(await cancellationFirst.execute(() => NOW + 5)).toBe("stale");
      expect(await objectRowCounts(
        base,
        cancellationFirst.memoryObjectId,
      )).toEqual({ payload: 0, head: 0, manifest: 0, envelope: 0 });

      const expiry = await createScenario(base);
      let accessHeadCasCompleted = false;
      const expiryRestricted = observeRestrictedConnection(
        base.restricted,
        (statement, parameters) => {
          if (
            /^\s*insert into\s+"object_crypto_access_heads"/i.test(statement)
            && parameters?.includes(expiry.memoryObjectId) === true
          ) {
            accessHeadCasCompleted = true;
          }
        },
      );
      expect(await expiry.execute(
        () => accessHeadCasCompleted ? EXPIRES_AT : NOW + 5,
        expiryRestricted,
      )).toBe("stale");
      expect(accessHeadCasCompleted).toBe(true);
      expect(await objectRowCounts(base, expiry.memoryObjectId)).toEqual({
        payload: 0,
        head: 0,
        manifest: 0,
        envelope: 0,
      });
      const [currentClaim] = await base.admin.select({
        state: backgroundCryptoAuthorizationRequests.state,
        claimId: backgroundCryptoAuthorizationRequests.claimId,
      }).from(backgroundCryptoAuthorizationRequests).where(eq(
        backgroundCryptoAuthorizationRequests.requestId,
        expiry.requestId,
      ));
      expect(currentClaim).toMatchObject({
        state: "running",
      });
      expect(typeof currentClaim?.claimId).toBe("string");
    } catch (error) {
      testError = error;
    }
    let cleanupError: unknown;
    try {
      await base.cleanup();
    } catch (error) {
      cleanupError = error;
    }
    if (testError !== undefined && cleanupError !== undefined) {
      throw new AggregateError(
        [testError, cleanupError],
        "Task Memory writer test and cleanup both failed",
      );
    }
    if (testError !== undefined) {
      throw testError instanceof Error
        ? testError
        : new Error("Task Memory writer test threw a non-Error value", {
          cause: testError,
        });
    }
    if (cleanupError !== undefined) {
      throw cleanupError instanceof Error
        ? cleanupError
        : new Error("Task Memory writer cleanup threw a non-Error value", {
          cause: cleanupError,
        });
    }
  });

  test("publishes genuine Shadow ordinary fallback with exact Namespace and Scope audiences", async () => {
    const base = await createBaseFixture();
    let testError: unknown;
    try {
      await base.admin.update(encryptionTransitionPolicy).set({
        mode: "shadow_encryption",
        shadowBehavior: "fallback",
        revision: base.policyRevision,
        shadowEncryptionStartedAt: new Date(NOW),
        updatedAt: new Date(NOW + 1),
      }).where(eq(encryptionTransitionPolicy.id, "server"));

      const vector = Object.freeze(new Array<number>(1536).fill(0.35));
      const namespaceIds = Object.freeze([
        base.namespaceValue,
        base.seedNamespaceValue,
      ].sort());
      const namespaceAuthority: ProtectedMemoryAuthority = Object.freeze({
        mode: "namespace",
        subjectUserId: base.userId,
        agentId: base.productAgentId,
        readableNamespaceIds: namespaceIds,
        mutableNamespaceIds: namespaceIds,
        writableNamespaceId: base.namespaceValue,
      });
      const namespaceScenario = await createScenario(base, {
        contentRepresentation: "dual",
        namespaceIds,
      });
      const saveNamespace = (
        content: string,
        onPrepare?: (request: FallbackPrepareRequest) => Promise<void>,
      ) => namespaceScenario.withAuthority(
        () => NOW + 5,
        ({ writer }) => withShadowFallbackRepository({
          base,
          scenario: namespaceScenario,
          writer,
          authority: namespaceAuthority,
          vector,
          ...(onPrepare === undefined ? {} : { onPrepare }),
          execute: repository => repository.save({
            operationId: `native-task-memory-fallback:${randomUUID()}`,
            authority: namespaceAuthority,
            type: "fact",
            content,
            importance: 0.8,
          }),
        }),
      );

      const initialContent = `Namespace fallback ${randomUUID()}`;
      const initial = await saveNamespace(initialContent);
      if (initial.status !== "success") {
        throw new Error(`Namespace fallback create failed: ${initial.reason}`);
      }
      base.memoryIds.add(initial.value.id);
      expect(initial).toMatchObject({
        value: { action: "created" },
        fallbackReason: "encryption_pending",
      });
      expect(await base.admin.select({
        content: memories.content,
        contentRevision: memories.contentRevision,
        cryptoObjectId: memories.cryptoObjectId,
        cryptoMappingState: memories.cryptoMappingState,
      }).from(memories).where(eq(memories.id, initial.value.id))).toEqual([{
        content: initialContent,
        contentRevision: 1,
        cryptoObjectId: null,
        cryptoMappingState: "unmapped",
      }]);
      expect(await base.admin.select({
        namespaceId: memoryNamespaces.namespaceId,
      }).from(memoryNamespaces).where(eq(
        memoryNamespaces.memoryId,
        initial.value.id,
      )).orderBy(memoryNamespaces.namespaceId)).toEqual([
        { namespaceId: base.namespaceValue },
      ]);

      await base.admin.insert(memoryNamespaces).values({
        memoryId: initial.value.id,
        namespaceId: base.seedNamespaceValue,
      });
      const wideContent = `${initialContent} Wide`;
      const wide = await saveNamespace(wideContent);
      if (wide.status !== "success") {
        throw new Error(`Wide fallback update failed: ${wide.reason}`);
      }
      expect(wide).toMatchObject({
        value: { id: initial.value.id, action: "updated" },
        fallbackReason: "encryption_pending",
      });
      const [wideBeforeRace] = await base.admin.select({
        content: memories.content,
        contentRevision: memories.contentRevision,
        cryptoObjectId: memories.cryptoObjectId,
        cryptoMappingState: memories.cryptoMappingState,
      }).from(memories).where(eq(memories.id, initial.value.id));
      expect(wideBeforeRace).toMatchObject({
        content: wideContent,
        cryptoObjectId: null,
        cryptoMappingState: "unmapped",
      });
      expect(await base.admin.select({
        namespaceId: memoryNamespaces.namespaceId,
      }).from(memoryNamespaces).where(eq(
        memoryNamespaces.memoryId,
        initial.value.id,
      )).orderBy(memoryNamespaces.namespaceId)).toEqual(
        namespaceIds.map(namespaceIdValue => ({
          namespaceId: namespaceIdValue,
        })),
      );

      let raced = false;
      const stale = await saveNamespace(
        `${wideContent} stale`,
        async request => {
          if (raced) return;
          raced = true;
          expect(request.plan.memoryId).toBe(initial.value.id);
          await base.admin.delete(memoryNamespaces).where(and(
            eq(memoryNamespaces.memoryId, initial.value.id),
            eq(memoryNamespaces.namespaceId, base.seedNamespaceValue),
          ));
        },
      );
      expect(raced).toBe(true);
      expect(stale).toEqual({
        status: "unavailable",
        reason: "stale_revision",
      });
      const [wideAfterRace] = await base.admin.select({
        content: memories.content,
        contentRevision: memories.contentRevision,
        cryptoObjectId: memories.cryptoObjectId,
        cryptoMappingState: memories.cryptoMappingState,
      }).from(memories).where(eq(memories.id, initial.value.id));
      expect(wideAfterRace).toMatchObject({
        content: wideContent,
        cryptoMappingState: "stale",
      });
      expect(wideAfterRace!.contentRevision).toBeGreaterThan(
        wideBeforeRace!.contentRevision,
      );
      expect(wideAfterRace?.cryptoObjectId).not.toBeNull();
      const activeRepair = await base.admin.select({
        completion: memoryCryptoRevisions.completion,
        disposition: memoryCryptoRevisions.disposition,
      }).from(memoryCryptoRevisions).where(and(
        eq(memoryCryptoRevisions.memoryId, initial.value.id),
        eq(memoryCryptoRevisions.disposition, "active"),
      ));
      expect(activeRepair).toContainEqual({
        completion: "pending",
        disposition: "active",
      });

      const scopeId = randomUUID();
      base.scopeIds.add(scopeId);
      await base.admin.insert(agentScopes).values({
        id: scopeId,
        parentAgentId: base.productAgentId,
        speakerUserId: base.userId,
        name: `task-memory-fallback-${scopeId}`,
      });
      const scopeAuthority: ProtectedMemoryAuthority = Object.freeze({
        mode: "scope",
        subjectUserId: base.userId,
        agentId: base.productAgentId,
        scopeId,
        originWritableNamespaceId: base.namespaceValue,
      });
      const scopeScenario = await createScenario(base, {
        contentRepresentation: "dual",
        scopeMemory: {
          binding: Object.freeze({
            scopeId,
            memoryRoomId: base.roomId,
            originWritableNamespaceId: base.namespaceValue,
            readableNamespaceIds: Object.freeze([base.namespaceValue]),
          }),
          targetRoomId: base.roomId,
          targetNamespace: base.namespace,
        },
      });
      const saveScope = (content: string) => scopeScenario.withAuthority(
        () => NOW + 5,
        ({ writer }) => withShadowFallbackRepository({
          base,
          scenario: scopeScenario,
          writer,
          authority: scopeAuthority,
          vector,
          execute: repository => repository.save({
            operationId: `native-task-scope-memory-fallback:${randomUUID()}`,
            authority: scopeAuthority,
            type: "fact",
            content,
            importance: 0.7,
          }),
        }),
      );
      const scopeInitialContent = `Scope fallback ${randomUUID()}`;
      const scopeInitial = await saveScope(scopeInitialContent);
      if (scopeInitial.status !== "success") {
        throw new Error(`Scope fallback create failed: ${scopeInitial.reason}`);
      }
      base.memoryIds.add(scopeInitial.value.id);
      expect(scopeInitial).toMatchObject({
        value: { action: "created" },
        fallbackReason: "encryption_pending",
      });
      const scopeUpdatedContent = `${scopeInitialContent} updated`;
      const scopeUpdated = await saveScope(scopeUpdatedContent);
      if (scopeUpdated.status !== "success") {
        throw new Error(`Scope fallback update failed: ${scopeUpdated.reason}`);
      }
      expect(scopeUpdated).toMatchObject({
        value: { id: scopeInitial.value.id, action: "updated" },
        fallbackReason: "encryption_pending",
      });
      expect(await base.admin.select({
        content: memories.content,
        contentRevision: memories.contentRevision,
        cryptoObjectId: memories.cryptoObjectId,
        cryptoMappingState: memories.cryptoMappingState,
        scopeOriginNamespaceId: memories.scopeOriginNamespaceId,
      }).from(memories).where(eq(
        memories.id,
        scopeInitial.value.id,
      ))).toEqual([{
        content: scopeUpdatedContent,
        contentRevision: 3,
        cryptoObjectId: null,
        cryptoMappingState: "unmapped",
        scopeOriginNamespaceId: base.namespaceValue,
      }]);
      expect(await base.admin.select({
        scopeId: memoryScopes.scopeId,
        origin: memoryScopes.origin,
      }).from(memoryScopes).where(eq(
        memoryScopes.memoryId,
        scopeInitial.value.id,
      ))).toEqual([{ scopeId, origin: "scope" }]);
      expect(await base.admin.select({
        namespaceId: memoryNamespaces.namespaceId,
      }).from(memoryNamespaces).where(eq(
        memoryNamespaces.memoryId,
        scopeInitial.value.id,
      ))).toEqual([]);
    } catch (error) {
      testError = error;
    }
    let cleanupError: unknown;
    try {
      await base.cleanup();
    } catch (error) {
      cleanupError = error;
    }
    if (testError !== undefined && cleanupError !== undefined) {
      throw new AggregateError(
        [testError, cleanupError],
        "Task Memory fallback test and cleanup both failed",
      );
    }
    if (testError !== undefined) {
      throw testError instanceof Error ? testError : new Error("Task Memory fallback test failed", { cause: testError });
    }
    if (cleanupError !== undefined) {
      throw cleanupError instanceof Error ? cleanupError : new Error("Task Memory fallback cleanup failed", { cause: cleanupError });
    }
  });

  test("adopts one immutable Scope Memory origin under genuine competing Task authority", async () => {
    const base = await createBaseFixture();
    let testError: unknown;
    try {
      const scopeId = randomUUID();
      const candidateMemoryId = randomUUID();
      const existingOriginMemoryId = randomUUID();
      const seedMemoryId = randomUUID();
      const mappedMemoryId = randomUUID();
      const targetMismatchMemoryId = randomUUID();
      const identityMismatchMemoryId = randomUUID();
      const expiryMemoryId = randomUUID();
      const plainMemoryId = randomUUID();
      const cancelledMemoryId = randomUUID();
      const mappedObjectId = deriveMemoryCryptoObjectIdV1({
        memoryId: mappedMemoryId,
        contentRevision: 1,
      });
      base.scopeIds.add(scopeId);
      base.objectIds.add(mappedObjectId);
      for (const memoryId of [
        candidateMemoryId,
        existingOriginMemoryId,
        seedMemoryId,
        mappedMemoryId,
        targetMismatchMemoryId,
        identityMismatchMemoryId,
        expiryMemoryId,
        plainMemoryId,
        cancelledMemoryId,
      ]) base.memoryIds.add(memoryId);

      const ordinaryMemory = (id: string) => ({
        id,
        type: "fact",
        content: `legacy Scope Memory ${id}`,
        importance: 0.7,
        tier: 1,
        createdAt: new Date(NOW),
      });
      const mappedFingerprint = fingerprintRequiredMemoryNamespaces([
        base.namespaceValue,
      ]);
      try {
        await base.admin.transaction(async (tx) => {
          await tx.insert(agentScopes).values({
            id: scopeId,
            parentAgentId: base.productAgentId,
            speakerUserId: base.userId,
            name: `task-memory-origin-adoption-${scopeId}`,
          });
          await tx.insert(cryptoObjects).values({
            objectId: mappedObjectId,
            payloadHash: digest(`mapped-memory:${mappedMemoryId}`),
            payloadBytes: Uint8Array.of(1),
          });
          await tx.insert(memories).values([
            ordinaryMemory(candidateMemoryId),
            {
              ...ordinaryMemory(existingOriginMemoryId),
              scopeOriginNamespaceId: base.namespaceValue,
            },
            ordinaryMemory(seedMemoryId),
            {
              ...ordinaryMemory(mappedMemoryId),
              cryptoObjectId: mappedObjectId,
              contentRevision: 1,
              cryptoMappingState: "verified",
              cryptoRequiredNamespaceFingerprint: mappedFingerprint,
            },
            ordinaryMemory(targetMismatchMemoryId),
            ordinaryMemory(identityMismatchMemoryId),
            ordinaryMemory(expiryMemoryId),
            ordinaryMemory(plainMemoryId),
            ordinaryMemory(cancelledMemoryId),
          ]);
          await tx.insert(memoryScopes).values([
            { memoryId: candidateMemoryId, scopeId, origin: "scope" },
            { memoryId: existingOriginMemoryId, scopeId, origin: "scope" },
            { memoryId: seedMemoryId, scopeId, origin: "seed" },
            { memoryId: mappedMemoryId, scopeId, origin: "scope" },
            { memoryId: targetMismatchMemoryId, scopeId, origin: "scope" },
            { memoryId: identityMismatchMemoryId, scopeId, origin: "scope" },
            { memoryId: expiryMemoryId, scopeId, origin: "scope" },
            { memoryId: plainMemoryId, scopeId, origin: "scope" },
            { memoryId: cancelledMemoryId, scopeId, origin: "scope" },
          ]);
          await tx.insert(memoryNamespaces).values({
            memoryId: seedMemoryId,
            namespaceId: base.seedNamespaceValue,
          });
        });
      } finally {
        mappedFingerprint.fill(0);
      }

      const readableNamespaceIds = Object.freeze([
        base.namespaceValue,
        base.seedNamespaceValue,
      ].sort());
      const primaryBinding = Object.freeze({
        scopeId,
        memoryRoomId: base.roomId,
        originWritableNamespaceId: base.namespaceValue,
        readableNamespaceIds,
      }) satisfies TaskScopeMemoryBinding;
      const seedBinding = Object.freeze({
        scopeId,
        memoryRoomId: base.seedRoomId,
        originWritableNamespaceId: base.seedNamespaceValue,
        readableNamespaceIds,
      }) satisfies TaskScopeMemoryBinding;
      const primary = await createScenario(base, {
        scopeMemory: {
          binding: primaryBinding,
          targetRoomId: base.roomId,
          targetNamespace: base.namespace,
        },
      });
      const seed = await createScenario(base, {
        scopeMemory: {
          binding: seedBinding,
          targetRoomId: base.seedRoomId,
          targetNamespace: base.seedNamespace,
        },
      });
      const adopt = (
        scenario: typeof primary,
        memoryId: string,
        runner = base.product.canonicalRunner,
        now: () => number = () => NOW + 5,
      ) => scenario.withAuthority(
        now,
        ({ writer }) => adoptProtectedTaskScopeMemoryOrigin(writer, memoryId),
        base.restricted,
        runner,
      );

      expect(await primary.withAuthority(
        () => NOW + 5,
        ({ writer }) => withCurrentProtectedTaskMemoryAuthority(
          writer,
          async () => true,
        ),
      )).toBe(true);
      expect(await seed.withAuthority(
        () => NOW + 5,
        ({ writer }) => withCurrentProtectedTaskMemoryAuthority(
          writer,
          async () => true,
        ),
      )).toBe(true);

      const gate = gateCanonicalRunnerAfterScopeOriginUpdate(
        base.product.canonicalRunner,
      );
      const primaryAdoption = adopt(primary, candidateMemoryId, gate.runner);
      let seedAdoption: ReturnType<typeof adopt> | null = null;
      let primaryRace: Awaited<typeof primaryAdoption>;
      let seedRace: Awaited<ReturnType<typeof adopt>>;
      try {
        const admission = await Promise.race([
          gate.entered.then(() => "entered" as const),
          primaryAdoption.then(() => "completed" as const),
        ]);
        if (admission !== "entered") {
          throw new Error("Scope Memory adoption ended before its origin CAS");
        }
        seedAdoption = adopt(seed, candidateMemoryId);
        await waitForBlockedContender(base, await gate.pid);
        gate.release();
        [primaryRace, seedRace] = await Promise.all([
          primaryAdoption,
          seedAdoption,
        ]);
      } catch (error) {
        gate.release();
        await Promise.allSettled([
          primaryAdoption,
          ...(seedAdoption === null ? [] : [seedAdoption]),
        ]);
        throw error;
      }
      expect(primaryRace).toBe("adopted");
      expect(seedRace).toBe("stale");
      const winner = primary;
      const loser = seed;
      const winnerNamespaceId = base.namespaceValue;
      expect(await adopt(winner, candidateMemoryId)).toBe("replayed");
      expect(await adopt(loser, candidateMemoryId)).toBe("stale");

      const [adopted] = await base.admin.select({
        type: memories.type,
        content: memories.content,
        contentRevision: memories.contentRevision,
        cryptoAccessRevision: memories.cryptoAccessRevision,
        cryptoObjectId: memories.cryptoObjectId,
        cryptoMappingState: memories.cryptoMappingState,
        cryptoRequiredNamespaceFingerprint:
          memories.cryptoRequiredNamespaceFingerprint,
        scopeOriginNamespaceId: memories.scopeOriginNamespaceId,
      }).from(memories).where(eq(memories.id, candidateMemoryId));
      expect(adopted).toEqual({
        type: "fact",
        content: `legacy Scope Memory ${candidateMemoryId}`,
        contentRevision: 0,
        cryptoAccessRevision: 0,
        cryptoObjectId: null,
        cryptoMappingState: "unmapped",
        cryptoRequiredNamespaceFingerprint: null,
        scopeOriginNamespaceId: winnerNamespaceId,
      });
      expect(await base.admin.select({
        namespaceId: memoryNamespaces.namespaceId,
      }).from(memoryNamespaces).where(eq(
        memoryNamespaces.memoryId,
        candidateMemoryId,
      ))).toEqual([]);

      expect(await adopt(primary, existingOriginMemoryId)).toBe("replayed");
      expect(await adopt(seed, existingOriginMemoryId)).toBe("stale");
      expect(await adopt(primary, seedMemoryId)).toBe("stale");
      expect(await adopt(primary, mappedMemoryId)).toBe("stale");

      const mismatchedTarget = await primary.withAuthority(
        () => NOW + 5,
        ({ writer }) => adoptProtectedTaskScopeMemoryOrigin(Object.freeze({
          ...writer,
          scopeMemory: Object.freeze({
            ...writer.scopeMemory!,
            targetRoomId: base.seedRoomId,
          }),
        }), targetMismatchMemoryId),
      );
      expect(mismatchedTarget).toBe("stale");
      const mismatchedIdentity = await primary.withAuthority(
        () => NOW + 5,
        ({ writer }) => adoptProtectedTaskScopeMemoryOrigin(Object.freeze({
          ...writer,
          scopeMemory: Object.freeze({
            ...writer.scopeMemory!,
            workIdentity: `${writer.scopeMemory!.workIdentity} `,
          }),
        }), identityMismatchMemoryId),
      );
      expect(mismatchedIdentity).toBe("stale");

      const expiryGate = gateCanonicalRunnerAfterScopeOriginUpdate(
        base.product.canonicalRunner,
      );
      let expired = false;
      const expiryAdoption = adopt(
        primary,
        expiryMemoryId,
        expiryGate.runner,
        () => expired ? EXPIRES_AT : NOW + 5,
      );
      try {
        const admission = await Promise.race([
          expiryGate.entered.then(() => "entered" as const),
          expiryAdoption.then(() => "completed" as const),
        ]);
        if (admission !== "entered") {
          throw new Error("Expiring Scope Memory adoption missed its CAS");
        }
        expired = true;
        expiryGate.release();
        expect(await expiryAdoption).toBe("stale");
      } catch (error) {
        expiryGate.release();
        await Promise.allSettled([expiryAdoption]);
        throw error;
      }

      try {
        await base.admin.update(encryptionTransitionPolicy).set({
          mode: "plaintext_only",
          shadowBehavior: "fallback",
          revision: base.policyRevision,
          shadowEncryptionStartedAt: null,
          updatedAt: new Date(NOW + 10),
        }).where(eq(encryptionTransitionPolicy.id, "server"));
        expect(await adopt(primary, plainMemoryId)).toBe("stale");
      } finally {
        await base.admin.update(encryptionTransitionPolicy).set({
          mode: "encrypted_only",
          shadowBehavior: "strict",
          revision: base.policyRevision,
          shadowEncryptionStartedAt: new Date(NOW),
          updatedAt: new Date(NOW + 11),
        }).where(eq(encryptionTransitionPolicy.id, "server"));
      }

      expect(await transitionTaskLifecycleTerminal(base.productDb, {
        taskId: seed.taskId,
        taskStatus: "cancelled",
        taskPatch: { cancelledAt: new Date(NOW + 12) },
        runId: seed.taskRunId,
        runStatus: "cancelled",
      })).toMatchObject({ transitioned: true, outcome: "transitioned" });
      expect(await adopt(seed, cancelledMemoryId)).toBe("stale");

      const untouched = await base.admin.select({
        id: memories.id,
        scopeOriginNamespaceId: memories.scopeOriginNamespaceId,
      }).from(memories).where(inArray(memories.id, [
        seedMemoryId,
        mappedMemoryId,
        targetMismatchMemoryId,
        identityMismatchMemoryId,
        expiryMemoryId,
        plainMemoryId,
        cancelledMemoryId,
      ]));
      expect(untouched).toHaveLength(7);
      expect(untouched.every(memory =>
        memory.scopeOriginNamespaceId === null)).toBe(true);
    } catch (error) {
      testError = error;
    }
    let cleanupError: unknown;
    try {
      await base.cleanup();
    } catch (error) {
      cleanupError = error;
    }
    if (testError !== undefined && cleanupError !== undefined) {
      throw new AggregateError(
        [testError, cleanupError],
        "Task Memory origin adoption test and cleanup both failed",
      );
    }
    if (testError !== undefined) {
      throw testError instanceof Error
        ? testError
        : new Error("Task Memory origin adoption threw a non-Error value", {
          cause: testError,
        });
    }
    if (cleanupError !== undefined) {
      throw cleanupError instanceof Error
        ? cleanupError
        : new Error("Task Memory origin adoption cleanup threw a non-Error value", {
          cause: cleanupError,
        });
    }
  });

  test("repairs and updates one legacy Scope Memory through a genuine Shadow Task", async () => {
    const base = await createBaseFixture();
    let testError: unknown;
    try {
      await base.admin.update(encryptionTransitionPolicy).set({
        mode: "shadow_encryption",
        shadowBehavior: "strict",
        revision: base.policyRevision,
        shadowEncryptionStartedAt: new Date(NOW),
        updatedAt: new Date(NOW + 1),
      }).where(eq(encryptionTransitionPolicy.id, "server"));

      const scopeId = randomUUID();
      const legacyMemoryId = randomUUID();
      const audienceRaceMemoryId = randomUUID();
      const seedMemoryId = randomUUID();
      const foreignOriginMemoryId = randomUUID();
      const legacyContent = `legacy Scope Memory ${legacyMemoryId}`;
      const audienceRaceContent =
        `legacy Scope Memory audience race ${audienceRaceMemoryId}`;
      const savedContent = `${legacyContent} updated`;
      const selectedVector = new Array<number>(1536).fill(0.25);
      const seedVector = Array.from(
        { length: 1536 },
        (_, index) => index % 2 === 0 ? 0.25 : -0.25,
      );
      const foreignVector = new Array<number>(1536).fill(-0.25);
      const repairObjectId = deriveMemoryCryptoObjectIdV1({
        memoryId: legacyMemoryId,
        contentRevision: 1,
      });
      const savedObjectId = deriveMemoryCryptoObjectIdV1({
        memoryId: legacyMemoryId,
        contentRevision: 2,
      });
      const audienceRaceObjectId = deriveMemoryCryptoObjectIdV1({
        memoryId: audienceRaceMemoryId,
        contentRevision: 1,
      });
      base.scopeIds.add(scopeId);
      base.memoryIds.add(legacyMemoryId);
      base.memoryIds.add(audienceRaceMemoryId);
      base.memoryIds.add(seedMemoryId);
      base.memoryIds.add(foreignOriginMemoryId);
      base.objectIds.add(repairObjectId);
      base.objectIds.add(savedObjectId);
      base.objectIds.add(audienceRaceObjectId);

      const ordinaryMemory = (
        id: string,
        content: string,
        vector: number[],
        scopeOriginNamespaceId: string | null = null,
      ) => ({
        id,
        type: "fact",
        content,
        importance: 0.7,
        tier: 1,
        embedding: vector,
        embeddingRevision: 0,
        embeddingProvider: "openai" as const,
        embeddingModel: "text-embedding-3-small",
        embeddingDimensions: 1536,
        embeddingContractVersion: 1,
        scopeOriginNamespaceId,
        createdAt: new Date(NOW),
      });
      await base.admin.transaction(async tx => {
        await tx.insert(agentScopes).values({
          id: scopeId,
          parentAgentId: base.productAgentId,
          speakerUserId: base.userId,
          name: `task-memory-shadow-repair-${scopeId}`,
        });
        await tx.insert(memories).values([
          ordinaryMemory(legacyMemoryId, legacyContent, selectedVector),
          ordinaryMemory(
            audienceRaceMemoryId,
            audienceRaceContent,
            foreignVector,
            base.namespaceValue,
          ),
          ordinaryMemory(
            seedMemoryId,
            `unmodified Scope seed ${seedMemoryId}`,
            seedVector,
          ),
          ordinaryMemory(
            foreignOriginMemoryId,
            `unmodified foreign origin ${foreignOriginMemoryId}`,
            foreignVector,
            base.seedNamespaceValue,
          ),
        ]);
        await tx.insert(memoryScopes).values([
          { memoryId: legacyMemoryId, scopeId, origin: "scope" },
          { memoryId: audienceRaceMemoryId, scopeId, origin: "scope" },
          { memoryId: seedMemoryId, scopeId, origin: "seed" },
          { memoryId: foreignOriginMemoryId, scopeId, origin: "scope" },
        ]);
        await tx.insert(memoryNamespaces).values({
          memoryId: seedMemoryId,
          namespaceId: base.seedNamespaceValue,
        });
      });

      const untouchedBefore = await base.admin.select({
        id: memories.id,
        type: memories.type,
        content: memories.content,
        contentRevision: memories.contentRevision,
        embeddingRevision: memories.embeddingRevision,
        cryptoObjectId: memories.cryptoObjectId,
        cryptoMappingState: memories.cryptoMappingState,
        cryptoRequiredNamespaceFingerprint:
          memories.cryptoRequiredNamespaceFingerprint,
        scopeOriginNamespaceId: memories.scopeOriginNamespaceId,
      }).from(memories).where(inArray(memories.id, [
        seedMemoryId,
        foreignOriginMemoryId,
      ]));
      const readableNamespaceIds = Object.freeze([
        base.namespaceValue,
        base.seedNamespaceValue,
      ].sort());
      const authority = Object.freeze({
        mode: "scope" as const,
        subjectUserId: base.userId,
        agentId: base.productAgentId,
        scopeId,
        originWritableNamespaceId: base.namespaceValue,
      });
      const scenario = await createScenario(base, {
        contentRepresentation: "dual",
        scopeMemory: {
          binding: Object.freeze({
            scopeId,
            memoryRoomId: base.roomId,
            originWritableNamespaceId: base.namespaceValue,
            readableNamespaceIds,
          }),
          targetRoomId: base.roomId,
          targetNamespace: base.namespace,
        },
      });
      let fallbackCalls = 0;
      const result = await scenario.withAuthority(
        () => NOW + 5,
        ({ writer }) => withProtectedTaskNativeMemoryRepository({
          authority,
          policy: Object.freeze({
            mode: "shadow_encryption" as const,
            shadowBehavior: "strict" as const,
            revision: base.policyRevision,
          }),
          current: writer,
          domains: Object.freeze([scenario.domainSecret]),
          signer: Object.freeze({
            agentAuthorizationRevision: 7,
            runtime: base.runtime.runtime,
            signerPublication: base.runtime.signerPublication,
          }),
          resolveHistoricalSignerPublicationManager: () =>
            base.currentDevice.signingPublicKey,
          product: base.product,
          agentProduct: base.agentProduct,
          owner: bindEncryptionDataOperationOwner({
            policy: {
              resolve: async () => Object.freeze({
                policy: Object.freeze({
                  mode: "shadow_encryption" as const,
                  shadowBehavior: "strict" as const,
                }),
                revalidationToken: base.policyRevision,
              }),
              revalidate: async token => {
                if (token !== base.policyRevision) {
                  throw new TypeError("Task Memory policy token changed");
                }
              },
            },
          }),
          embedding: Object.freeze({
            embed: async () => Object.freeze({
              status: "success" as const,
              value: Object.freeze({
                vector: Object.freeze([...selectedVector]),
                provider: "openai" as const,
                canonicalModel: "text-embedding-3-small",
                dimensions: 1536 as const,
                contractVersion: 1,
              }),
            }),
          }),
          execute: repository => repository.save({
            operationId: `native-task-memory-shadow-save:${randomUUID()}`,
            authority,
            type: "fact",
            content: savedContent,
            importance: 0.8,
          }),
        }, {
          createFallback: () => {
            fallbackCalls += 1;
            throw new Error("Strict Shadow must not construct ordinary-only fallback");
          },
        }),
      );
      if (result.status !== "success") {
        throw new Error(`Shadow Task Memory save failed: ${result.reason}`);
      }
      expect(result.value).toMatchObject({
        id: legacyMemoryId,
        action: "updated",
      });
      expect(fallbackCalls).toBe(0);

      const [saved] = await base.admin.select({
        type: memories.type,
        content: memories.content,
        importance: memories.importance,
        contentRevision: memories.contentRevision,
        embeddingRevision: memories.embeddingRevision,
        cryptoAccessRevision: memories.cryptoAccessRevision,
        cryptoObjectId: memories.cryptoObjectId,
        cryptoMappingState: memories.cryptoMappingState,
        cryptoRequiredNamespaceFingerprint:
          memories.cryptoRequiredNamespaceFingerprint,
        scopeOriginNamespaceId: memories.scopeOriginNamespaceId,
      }).from(memories).where(eq(memories.id, legacyMemoryId));
      expect(saved).toEqual({
        type: "fact",
        content: savedContent,
        importance: 0.8,
        contentRevision: 2,
        embeddingRevision: 2,
        cryptoAccessRevision: 0,
        cryptoObjectId: savedObjectId,
        cryptoMappingState: "verified",
        cryptoRequiredNamespaceFingerprint:
          fingerprintRequiredMemoryNamespaces([base.namespaceValue]),
        scopeOriginNamespaceId: base.namespaceValue,
      });
      expect(await base.admin.select({
        namespaceId: memoryNamespaces.namespaceId,
      }).from(memoryNamespaces).where(eq(
        memoryNamespaces.memoryId,
        legacyMemoryId,
      ))).toEqual([]);
      expect(await base.admin.select({
        namespaceId: objectCryptoNamespaceEnvelopes.namespaceId,
      }).from(objectCryptoNamespaceEnvelopes).where(inArray(
        objectCryptoNamespaceEnvelopes.objectId,
        [repairObjectId, savedObjectId],
      ))).toEqual([
        { namespaceId: base.namespaceValue },
        { namespaceId: base.namespaceValue },
      ]);

      const revisions = await base.admin.select({
        contentRevision: memoryCryptoRevisions.contentRevision,
        cryptoObjectId: memoryCryptoRevisions.cryptoObjectId,
        completion: memoryCryptoRevisions.completion,
        disposition: memoryCryptoRevisions.disposition,
        requiredNamespaceFingerprint:
          memoryCryptoRevisions.requiredNamespaceFingerprint,
      }).from(memoryCryptoRevisions).where(eq(
        memoryCryptoRevisions.memoryId,
        legacyMemoryId,
      ));
      expect(revisions).toHaveLength(2);
      expect(revisions.find(row => row.contentRevision === 1)).toMatchObject({
        cryptoObjectId: repairObjectId,
        completion: "complete",
        disposition: "superseded",
        requiredNamespaceFingerprint:
          fingerprintRequiredMemoryNamespaces([base.namespaceValue]),
      });
      expect(revisions.find(row => row.contentRevision === 2)).toMatchObject({
        cryptoObjectId: savedObjectId,
        completion: "complete",
        disposition: "mapped",
        requiredNamespaceFingerprint:
          fingerprintRequiredMemoryNamespaces([base.namespaceValue]),
      });
      expect(await objectRowCounts(base, repairObjectId)).toEqual({
        payload: 1,
        head: 1,
        manifest: 1,
        envelope: 1,
      });
      expect(await objectRowCounts(base, savedObjectId)).toEqual({
        payload: 1,
        head: 1,
        manifest: 1,
        envelope: 1,
      });

      const audienceRace = await scenario.withAuthority(
        () => NOW + 5,
        async ({ evidence, writer }) => {
          const source = await reserveProtectedTaskScopeMemoryRepair(writer, {
            memoryId: audienceRaceMemoryId,
            contentRevision: 0,
            score: 1,
            repairRequired: true,
            repair: Object.freeze({
              id: audienceRaceMemoryId,
              type: null,
              importance: 0.7,
              tier: 1,
              createdAt: new Date(NOW),
              score: 1,
              representation: "structural" as const,
            }),
          });
          if (source === null || source.source.plaintextBytes === null) {
            throw new Error("Task Scope Memory repair source was unavailable");
          }
          let edgeInsert: Promise<"inserted"> | null = null;
          let attachment: Promise<
            "attached" | "replayed" | "conflict" | null
          > | null = null;
          const edgeInserted = deferred();
          const releaseEdge = deferred();
          const observedEdge = observeCanonicalRunner(
            base.agentProduct.canonicalRunner,
          );
          try {
            const operationId =
              `task-memory-audience-race:${audienceRaceMemoryId}`;
            const prepared = prepareTaskRuntimeAgentObject({
              crypto: base.crypto,
              evidence,
              objectId: audienceRaceObjectId,
              objectType: MEMORY_OBJECT_TYPE,
              plaintextBytes: source.source.plaintextBytes,
              createdAt: NOW + 5,
              namespaceSet: [base.namespace],
              operationId,
              runtime: base.runtime.runtime,
              signerPublication: base.runtime.signerPublication,
              resolveHistoricalSignerPublicationManager: () =>
                base.currentDevice.signingPublicKey,
              agentAuthorizationRevision: 7,
            });
            expect(await persistProtectedTaskMemoryObject(writer, {
              memoryId: audienceRaceMemoryId,
              contentRevision: 1,
              operationId,
              prepared,
            })).toBe("created");

            edgeInsert = observedEdge.runner.transaction(
              async (tx) => {
                await tx.insert(memoryNamespaces).values({
                  memoryId: audienceRaceMemoryId,
                  namespaceId: base.seedNamespaceValue,
                });
                edgeInserted.resolve();
                await releaseEdge.promise;
                return "inserted" as const;
              },
              { isolationLevel: "read committed" },
            );
            const edgeAdmission = await Promise.race([
              edgeInserted.promise.then(() => "entered" as const),
              edgeInsert.then(() => "completed" as const),
            ]);
            if (edgeAdmission !== "entered") {
              throw new Error("Scope audience edge transaction ended before its gate");
            }
            attachment = attachProtectedTaskScopeMemoryRepair(
              writer,
              source,
              audienceRaceObjectId,
            );
            await waitForBlockedContender(
              base,
              await observedEdge.pid,
              "Task Scope repair attachment did not block behind its audience insert",
            );
            releaseEdge.resolve();
            const [edgeResult, attachmentResult] = await Promise.all([
              edgeInsert,
              attachment,
            ]);
            return Object.freeze({ edgeResult, attachmentResult });
          } catch (error) {
            releaseEdge.resolve();
            await Promise.allSettled([
              ...(edgeInsert === null ? [] : [edgeInsert]),
              ...(attachment === null ? [] : [attachment]),
            ]);
            throw error;
          } finally {
            source.source.plaintextBytes.fill(0);
            source.source.requestCommitment.fill(0);
          }
        },
      );
      expect(audienceRace).toEqual({
        edgeResult: "inserted",
        attachmentResult: "conflict",
      });
      expect(await base.admin.select({
        namespaceId: memoryNamespaces.namespaceId,
      }).from(memoryNamespaces).where(eq(
        memoryNamespaces.memoryId,
        audienceRaceMemoryId,
      ))).toEqual([{ namespaceId: base.seedNamespaceValue }]);
      expect(await base.admin.select({
        contentRevision: memories.contentRevision,
        embeddingRevision: memories.embeddingRevision,
        cryptoObjectId: memories.cryptoObjectId,
        cryptoMappingState: memories.cryptoMappingState,
        cryptoRequiredNamespaceFingerprint:
          memories.cryptoRequiredNamespaceFingerprint,
      }).from(memories).where(eq(
        memories.id,
        audienceRaceMemoryId,
      ))).toEqual([{
        contentRevision: 0,
        embeddingRevision: 0,
        cryptoObjectId: null,
        cryptoMappingState: "unmapped",
        cryptoRequiredNamespaceFingerprint: null,
      }]);
      expect(await base.admin.select({
        completion: memoryCryptoRevisions.completion,
        disposition: memoryCryptoRevisions.disposition,
      }).from(memoryCryptoRevisions).where(eq(
        memoryCryptoRevisions.memoryId,
        audienceRaceMemoryId,
      ))).toEqual([{
        completion: "pending",
        disposition: "active",
      }]);
      expect(await objectRowCounts(base, audienceRaceObjectId)).toEqual({
        payload: 1,
        head: 1,
        manifest: 1,
        envelope: 1,
      });

      const untouchedAfter = await base.admin.select({
        id: memories.id,
        type: memories.type,
        content: memories.content,
        contentRevision: memories.contentRevision,
        embeddingRevision: memories.embeddingRevision,
        cryptoObjectId: memories.cryptoObjectId,
        cryptoMappingState: memories.cryptoMappingState,
        cryptoRequiredNamespaceFingerprint:
          memories.cryptoRequiredNamespaceFingerprint,
        scopeOriginNamespaceId: memories.scopeOriginNamespaceId,
      }).from(memories).where(inArray(memories.id, [
        seedMemoryId,
        foreignOriginMemoryId,
      ]));
      expect(untouchedAfter).toEqual(untouchedBefore);
    } catch (error) {
      testError = error;
    }
    let cleanupError: unknown;
    try {
      await base.cleanup();
    } catch (error) {
      cleanupError = error;
    }
    if (testError !== undefined && cleanupError !== undefined) {
      throw new AggregateError(
        [testError, cleanupError],
        "Shadow Task Memory repair test and cleanup both failed",
      );
    }
    if (testError !== undefined) {
      throw testError instanceof Error
        ? testError
        : new Error("Shadow Task Memory repair threw a non-Error value", {
          cause: testError,
        });
    }
    if (cleanupError !== undefined) {
      throw cleanupError instanceof Error
        ? cleanupError
        : new Error("Shadow Task Memory repair cleanup threw a non-Error value", {
          cause: cleanupError,
        });
    }
  });
});

describePostgres("historical Task repair and ordinary fallback", () => {

type ProtectedTaskPublicationPlan = Awaited<ReturnType<
  ReturnType<typeof createProductionProtectedTaskComposition>["ports"]["plan"]
>>;

function fallbackRouteAuthority(base: BaseFixture): ProtectedTaskRouteAuthority {
  return Object.freeze({
    userId: base.userId,
    subjectHumanId: base.humanActorId,
    actorId: base.humanActorId,
    agentId: base.productAgentId,
    deviceId: base.deviceId,
    deviceGeneration: base.currentDevice.deviceGeneration,
    admission: Object.freeze({
      ...base.currentDevice,
      headDigest: base.currentDevice.headDigest.slice(),
      expiresAt: NOW + 120_000,
    }),
  });
}

function shadowFallbackOwner(policyRevision: number) {
  return bindEncryptionDataOperationOwner({ policy: {
    resolve: async () => ({ policy: {
      mode: "shadow_encryption" as const,
      shadowBehavior: "fallback" as const,
    }, revalidationToken: policyRevision }),
    revalidate: async token => {
      if (token !== policyRevision) throw new Error("Task fallback policy changed");
    },
  } });
}

async function prepareSignedDualTaskUpdate(
  base: BaseFixture,
  plan: ProtectedTaskPublicationPlan,
  payload: Parameters<typeof encodeTaskDefinitionContent>[0],
) {
  const [device] = await base.admin.select({
    revision: humanCryptoDevices.revision,
  }).from(humanCryptoDevices).where(and(
    eq(humanCryptoDevices.humanId, base.humanActorId),
    eq(humanCryptoDevices.deviceId, base.deviceId),
  ));
  if (device === undefined) throw new Error("Current Task signing device is missing");
  const task = Object.freeze({});
  const coordinate = Object.freeze({
    kind: "definition" as const,
    taskId: plan.taskId,
    contentRevision: plan.nextContentRevision,
  });
  const cryptoObjectId = deriveTaskContentCryptoObjectIdV1(coordinate);
  const authority = Object.freeze({
    authorityVersion: 1 as const,
    kind: "requester_private_namespace" as const,
    keyClass: "ai" as const,
    requesterHumanId: plan.authority.requesterHumanId,
    namespaceId: plan.authority.namespaceId,
    domainId: plan.authority.domainId,
    expectedAccessRevision: plan.authority.expectedAccessRevision,
    expectedPolicyRevision: plan.authority.expectedPolicyRevision,
  });
  const plaintext = encodeTaskDefinitionContent(payload);
  const encrypted = encryptObjectPayload(base.crypto, {
    objectId: objectId(cryptoObjectId),
    keyClass: "ai",
    objectType: taskContentObjectTypeV1(coordinate),
    createdAt: unixTimestamp(NOW),
  }, plaintext);
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  const envelopeBytes = encodeNamespaceObjectEnvelopeV2(
    wrapObjectDekForNamespace(base.crypto, base.namespace.key, {
      objectId: objectId(cryptoObjectId),
      namespaceId: namespaceId(plan.authority.namespaceId),
      keyClass: "ai",
      keyGeneration: namespaceGeneration(plan.authority.keyGeneration),
      bindingRevisionAtWrap: accessRevision(
        plan.authority.expectedAccessRevision,
      ),
    }, encrypted.dek),
  );
  encrypted.dek.fill(0);
  const access = prepareHumanObjectAccessManifestGenesisSet(base.crypto, {
    objectId: cryptoObjectId,
    payloadHash: base.crypto.hash(payloadBytes),
    envelopeBytes: [envelopeBytes],
    sourceAuthorized: true,
    targetAuthorized: true,
    subjectHumanId: humanId(base.humanActorId),
    committerDeviceId: cryptoDeviceId(base.deviceId),
    hostAuthorizationRevision: authorizationRevision(
      device.revision,
    ),
    committerSigningPublicKey: base.currentDevice.signingPublicKey,
    committerSigningPrivateKey: base.signingPrivateKey,
  });
  const opaque = createPreparedHumanTaskContentCryptoRevisionV1({
    signerKind: "human_device",
    coordinate,
    authority,
    object: encryptedObjectWriteRecord(payloadBytes),
    access,
  });
  const planDigest = new Uint8Array(Buffer.from(
    plan.planDigestBase64url,
    "base64url",
  ));
  const bindingHash = new Uint8Array(Buffer.from(
    plan.authority.bindingHashBase64url,
    "base64url",
  ));
  const operationalFieldsDigest = fingerprintTaskDualPublicationFieldsV1(
    "update",
    task,
    plaintext,
  );
  const signed = prepareHumanTaskPublicationRequest(base.crypto, {
    operation: "update",
    operationId: plan.operationId,
    taskId: plan.taskId,
    cryptoObjectId,
    expectedContentRevision: plan.expectedContentRevision,
    nextContentRevision: plan.nextContentRevision,
    expectedCryptoAccessRevision: plan.expectedCryptoAccessRevision,
    resultCryptoAccessRevision: 0,
    planDigest,
    operationalFieldsDigest,
    subjectHumanId: plan.authority.requesterHumanId,
    committerDeviceId: base.deviceId,
    hostAuthorizationRevision: device.revision,
    namespaceId: plan.authority.namespaceId,
    domainId: plan.authority.domainId,
    expectedNamespaceAccessRevision: plan.authority.expectedAccessRevision,
    expectedPolicyRevision: plan.authority.expectedPolicyRevision,
    bindingHash,
    keyGeneration: plan.authority.keyGeneration,
    payloadHash: base.crypto.hash(payloadBytes),
    manifestHash: base.crypto.hash(access.manifestBytes),
    envelopeHash: base.crypto.hash(envelopeBytes),
    issuedAt: NOW,
    deadlineAt: NOW + 30_000,
    committerSigningPublicKey: base.currentDevice.signingPublicKey,
    committerSigningPrivateKey: base.signingPrivateKey,
  });
  const prepared = Object.freeze({
    requestVersion: 1 as const,
    operation: "update" as const,
    operationId: plan.operationId,
    planDigestBase64url: plan.planDigestBase64url,
    taskId: plan.taskId,
    expectedContentRevision: plan.expectedContentRevision,
    nextContentRevision: plan.nextContentRevision,
    expectedCryptoAccessRevision: plan.expectedCryptoAccessRevision,
    resultCryptoAccessRevision: 0 as const,
    cryptoObjectId,
    payloadVersion: 1 as const,
    requiredNamespaceIds: [plan.authority.namespaceId] as [string],
    encryptedPayloadBytesBase64url: Buffer.from(payloadBytes).toString("base64url"),
    accessManifestBytesBase64url:
      Buffer.from(access.manifestBytes).toString("base64url"),
    namespaceEnvelopes: [{
      namespaceId: plan.authority.namespaceId,
      envelopeBytesBase64url: Buffer.from(envelopeBytes).toString("base64url"),
    }] as [{ namespaceId: string; envelopeBytesBase64url: string }],
    signedPublicationRequestBytesBase64url:
      Buffer.from(signed.bytes).toString("base64url"),
    task,
    representation: "dual" as const,
    ordinaryPayloadBytesBase64url: Buffer.from(plaintext).toString("base64url"),
  });
  planDigest.fill(0);
  bindingHash.fill(0);
  operationalFieldsDigest.fill(0);
  signed.bytes.fill(0);
  plaintext.fill(0);
  return Object.freeze({ prepared, opaque, authority, coordinate, cryptoObjectId });
}

async function prepareSignedFallbackTaskUpdate(
  base: BaseFixture,
  ports: ReturnType<typeof createTaskOrdinaryFallbackPorts>,
  authority: ProtectedTaskRouteAuthority,
  taskId: string,
  payload: Parameters<typeof encodeTaskDefinitionContent>[0],
) {
  const task = Object.freeze({});
  const operationId = `task:fallback:update:${randomUUID()}`;
  const plan = await ports.planUpdate({ authority, taskId, request: {
    requestVersion: 1,
    operationId,
    task,
  } });
  const binaryPlan = Object.freeze({
    formatVersion: plan.formatVersion,
    purpose: plan.purpose,
    reason: plan.reason,
    operationId: plan.operationId,
    taskId: plan.taskId,
    sourceDigest: new Uint8Array(Buffer.from(
      plan.sourceDigestBase64url,
      "base64url",
    )),
    operationalFieldsDigest: new Uint8Array(Buffer.from(
      plan.operationalFieldsDigestBase64url,
      "base64url",
    )),
    expectedContentRevision: plan.expectedContentRevision,
    expectedCryptoAccessRevision: plan.expectedCryptoAccessRevision,
    expectedUpdatedAt: plan.expectedUpdatedAt,
    policyRevision: plan.policyRevision,
    subjectHumanId: plan.subjectHumanId,
    committerDeviceId: plan.committerDeviceId,
    committerDeviceSigningKeyGeneration:
      plan.committerDeviceSigningKeyGeneration,
    hostAuthorizationRevision: plan.hostAuthorizationRevision,
    planIssuedAt: plan.planIssuedAt,
    planDeadlineAt: plan.planDeadlineAt,
  });
  const content = encodeTaskDefinitionContent(payload);
  const signed = prepareHumanTaskOrdinaryFallbackRequestV1(base.crypto, {
    ...binaryPlan,
    planDigest: fingerprintHumanTaskOrdinaryFallbackPlanV1(binaryPlan),
    taskDefinitionContentDigest:
      fingerprintHumanTaskOrdinaryFallbackContentV1(content),
    issuedAt: NOW,
    deadlineAt: plan.planDeadlineAt,
    signingPrivateKey: base.signingPrivateKey,
  });
  const prepared = Object.freeze({
    requestVersion: 1 as const,
    representation: "ordinary_fallback" as const,
    operationId,
    taskId,
    authenticatedRequestDigestBase64url: Buffer.from(
      digestHumanTaskOrdinaryFallbackRequestV1(signed.bytes),
    ).toString("base64url"),
    ordinaryPayloadBytesBase64url: Buffer.from(content).toString("base64url"),
    signedOrdinaryFallbackRequestBytesBase64url:
      Buffer.from(signed.bytes).toString("base64url"),
    task,
  });
  content.fill(0);
  signed.bytes.fill(0);
  binaryPlan.sourceDigest.fill(0);
  binaryPlan.operationalFieldsDigest.fill(0);
  return Object.freeze({ plan, prepared });
}

async function prepareReceiptBoundStaleDualRepair(
  base: BaseFixture,
  taskId: string,
  label: string,
) {
  await base.admin.update(encryptionTransitionPolicy).set({
    mode: "shadow_encryption",
    shadowBehavior: "strict",
    revision: base.policyRevision,
    shadowEncryptionStartedAt: new Date(NOW),
    updatedAt: new Date(NOW),
  }).where(eq(encryptionTransitionPolicy.id, "server"));
  await base.admin.insert(tasks).values({
    id: taskId,
    ownerId: base.userId,
    requestorId: base.userId,
    agentId: base.productAgentId,
    prompt: `${label} historical source`,
    expectedOutput: `${label} historical output`,
    scheduleKind: "now",
    status: "paused",
    callingRoomId: base.roomId,
    targetChat: "orphan",
    useScope: false,
    scopeId: null,
    metadata: {
      target: "file:///private/repository",
      mode: "update",
      publish: "branch",
      instructions: `${label} historical instructions`,
    },
  });
  await repairHistoricalTaskDefinition(base, taskId);
  await base.admin.update(encryptionTransitionPolicy).set({
    mode: "shadow_encryption",
    shadowBehavior: "fallback",
    revision: base.policyRevision,
    updatedAt: new Date(NOW + 1),
  }).where(eq(encryptionTransitionPolicy.id, "server"));
  const owner = shadowFallbackOwner(base.policyRevision);
  const authority = fallbackRouteAuthority(base);
  const fallbackPorts = createTaskOrdinaryFallbackPorts({
    db: base.productDb,
    restricted: base.restricted,
    crypto: base.crypto,
    owner,
    observer: { kick() {} },
    now: () => NOW,
  });
  const fallback = await prepareSignedFallbackTaskUpdate(
    base,
    fallbackPorts,
    authority,
    taskId,
    {
      formatVersion: 1,
      prompt: `${label} fallback source`,
      expectedOutput: `${label} fallback output`,
      protectedMetadata: {
        target: "file:///private/repository",
        instructions: `${label} fallback instructions`,
      },
    },
  );
  await fallbackPorts.publishUpdate({
    authority,
    taskId,
    prepared: fallback.prepared,
  });
  const protectedComposition = createProductionProtectedTaskComposition({
    db: base.productDb,
    restricted: base.restricted,
    crypto: base.crypto,
    serverScope: SERVER_SCOPE,
    owner,
    observer: { kick() {} },
    now: () => NOW,
  });
  const plan = await protectedComposition.ports.plan({
    authority,
    taskId,
    request: {
      requestVersion: 1,
      operation: "update",
      operationId: `task:protected:update:${randomUUID()}`,
      task: {},
    },
  });
  const repair = await prepareSignedDualTaskUpdate(base, plan, {
    formatVersion: 1,
    prompt: `${label} protected repair`,
    expectedOutput: `${label} repaired output`,
    protectedMetadata: {
      target: "file:///private/repository",
      instructions: `${label} repaired instructions`,
    },
  });
  base.objectIds.add(repair.cryptoObjectId);
  return Object.freeze({
    authority,
    fallback,
    fallbackPorts,
    protectedComposition,
    repair,
  });
}

test("signed Task ordinary fallback serializes exact create replay and rejects stale or disabled admission", async () => {
  let observedNow = NOW;
  const base = await createBaseFixture({
    connectedExecution: true,
    cryptoNow: () => observedNow,
  });
  try {
    await base.admin.update(encryptionTransitionPolicy).set({
      mode: "shadow_encryption", shadowBehavior: "fallback",
      revision: base.policyRevision, shadowEncryptionStartedAt: new Date(NOW),
      updatedAt: new Date(NOW),
    }).where(eq(encryptionTransitionPolicy.id, "server"));
    const owner = bindEncryptionDataOperationOwner({ policy: {
      resolve: async () => ({ policy: {
        mode: "shadow_encryption" as const, shadowBehavior: "fallback" as const,
      }, revalidationToken: base.policyRevision }),
      revalidate: async token => {
        if (token !== base.policyRevision) throw new Error("Task fallback policy changed");
      },
    } });
    const ports = createTaskOrdinaryFallbackPorts({
      db: base.productDb, restricted: base.restricted, crypto: base.crypto,
      owner, observer: { kick() {} }, now: () => observedNow,
    });
    const authority: ProtectedTaskRouteAuthority = Object.freeze({
      userId: base.userId,
      subjectHumanId: base.humanActorId,
      actorId: base.humanActorId,
      agentId: base.productAgentId,
      deviceId: base.deviceId,
      deviceGeneration: base.currentDevice.deviceGeneration,
      admission: Object.freeze({
        ...base.currentDevice,
        headDigest: base.currentDevice.headDigest.slice(),
        expiresAt: NOW + 120_000,
      }),
    });
    const task = Object.freeze({});
    const operationId = `task:fallback:${randomUUID()}`;
    const plan = await ports.planCreate({ authority, request: {
      requestVersion: 1, operationId, task,
    } });
    base.taskIds.add(plan.taskId);
    const binaryPlan = Object.freeze({
      formatVersion: plan.formatVersion,
      purpose: plan.purpose,
      reason: plan.reason,
      operationId: plan.operationId,
      taskId: plan.taskId,
      sourceDigest: new Uint8Array(Buffer.from(plan.sourceDigestBase64url, "base64url")),
      operationalFieldsDigest: new Uint8Array(Buffer.from(
        plan.operationalFieldsDigestBase64url,
        "base64url",
      )),
      expectedContentRevision: plan.expectedContentRevision,
      expectedCryptoAccessRevision: plan.expectedCryptoAccessRevision,
      expectedUpdatedAt: plan.expectedUpdatedAt,
      policyRevision: plan.policyRevision,
      subjectHumanId: plan.subjectHumanId,
      committerDeviceId: plan.committerDeviceId,
      committerDeviceSigningKeyGeneration: plan.committerDeviceSigningKeyGeneration,
      hostAuthorizationRevision: plan.hostAuthorizationRevision,
      planIssuedAt: plan.planIssuedAt,
      planDeadlineAt: plan.planDeadlineAt,
    });
    const expectedOperationalFieldsDigest =
      fingerprintTaskOperationalFieldsV1("create", task);
    try {
      expect(Buffer.from(binaryPlan.operationalFieldsDigest).toString("hex"))
        .toBe(Buffer.from(expectedOperationalFieldsDigest).toString("hex"));
    } finally {
      expectedOperationalFieldsDigest.fill(0);
    }
    expect(fingerprintHumanTaskOrdinaryFallbackPlanV1(binaryPlan)).toEqual(
      new Uint8Array(Buffer.from(plan.planDigestBase64url, "base64url")),
    );
    const prepare = (prompt: string) => {
      const content = encodeTaskPayloadV1({
        formatVersion: 1, prompt, expectedOutput: null, protectedMetadata: {},
      });
      const signed = prepareHumanTaskOrdinaryFallbackRequestV1(base.crypto, {
        ...binaryPlan,
        planDigest: fingerprintHumanTaskOrdinaryFallbackPlanV1(binaryPlan),
        taskDefinitionContentDigest:
          fingerprintHumanTaskOrdinaryFallbackContentV1(content),
        issuedAt: NOW,
        deadlineAt: plan.planDeadlineAt,
        signingPrivateKey: base.signingPrivateKey,
      });
      return Object.freeze({
        requestVersion: 1 as const,
        representation: "ordinary_fallback" as const,
        operationId,
        taskId: plan.taskId,
        authenticatedRequestDigestBase64url: Buffer.from(
          digestHumanTaskOrdinaryFallbackRequestV1(signed.bytes),
        ).toString("base64url"),
        ordinaryPayloadBytesBase64url: Buffer.from(content).toString("base64url"),
        signedOrdinaryFallbackRequestBytesBase64url:
          Buffer.from(signed.bytes).toString("base64url"),
        task,
      });
    };
    const prepared = prepare("Concurrent signed fallback");
    const [first, second] = await Promise.all([
      ports.publishCreate({ authority, prepared }),
      ports.publishCreate({ authority, prepared }),
    ]);
    expect(first).toEqual(second);
    expect(first.taskId).toBe(plan.taskId);
    const rows = await base.admin.select({
      id: tasks.id,
      operationId: tasks.ordinaryFallbackOperationId,
      requestDigest: tasks.ordinaryFallbackRequestDigest,
      reason: tasks.ordinaryFallbackReason,
      policyRevision: tasks.ordinaryFallbackPolicyRevision,
      completedAt: tasks.ordinaryFallbackCompletedAt,
    }).from(tasks).where(eq(tasks.id, plan.taskId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: plan.taskId,
      operationId,
      reason: "target_encryption_not_ready",
      policyRevision: base.policyRevision,
    });
    expect(rows[0]?.requestDigest).toHaveLength(32);
    expect(rows[0]?.completedAt).toBeInstanceOf(Date);

    observedNow = plan.planDeadlineAt + 1;
    expect(await ports.publishCreate({ authority, prepared })).toEqual(first);
    const staleError = await ports.publishCreate({
      authority,
      prepared: prepare("Different signed fallback"),
    }).catch((error: unknown) => error);
    expect(staleError).toMatchObject({
      statusCode: 409,
      code: "task_fallback_request_invalid",
    });

    for (const [offset, policy] of [
      [1, { mode: "shadow_encryption" as const, shadowBehavior: "strict" as const }],
      [2, { mode: "encrypted_only" as const, shadowBehavior: "strict" as const }],
    ] as const) {
      await base.admin.update(encryptionTransitionPolicy).set({
        ...policy,
        revision: base.policyRevision + offset,
        updatedAt: new Date(NOW + offset),
      }).where(eq(encryptionTransitionPolicy.id, "server"));
      const disabledError = await ports.publishCreate({ authority, prepared })
        .catch((error: unknown) => error);
      expect(disabledError).toMatchObject({
        statusCode: 409,
        code: "task_ordinary_fallback_unavailable",
      });
    }
  } finally {
    await base.cleanup();
  }
});

test("protected Task mutation source excludes private columns and preserves current operational overlays", async () => {
  const base = await createBaseFixture();
  const canary = "private-task-source-must-not-leave-the-projected-query";
  const execution = {
    version: 1,
    harnessId: "codex",
    source: "genie",
    collaborationMode: "work",
    harnessModelId: "codex-model",
    readiness: {
      relayId: "relay",
      pairingGenerationRef: "pairing",
      capabilityRevision: 3,
    },
  };
  const preparation = {
    stage: "using_tools",
    researchWork: { role: "investigator" },
    taskRunId: "run-current-overlay",
    updatedAt: "2026-10-20T09:00:00.000Z",
  };
  const interruption = {
    code: "no_progress",
    cause: "repeated_tool_failure",
    stoppedBy: "no_progress_guard",
    outcome: "errored",
    observedAt: "2026-10-20T09:00:00.000Z",
    taskRunId: "run-current-overlay",
    graphThreadId: "thread-current-overlay",
    checkpointId: null,
    resumeRequiresValidation: true,
  };
  const researchLanes = ["supervisor", "research", "summarization", "compression", "finalReport"];
  const research = {
    version: 2,
    modelPlan: {
      version: 1,
      supervisorModel: "model",
      researchModel: "model",
      summarizationModel: "model",
      compressionModel: "model",
      finalReportModel: "model",
    },
    invokingModelId: null,
    preferenceRevisions: Object.fromEntries(researchLanes.map((lane) => [lane, 3])),
    modelFunding: Object.fromEntries(researchLanes.map((lane) => [lane, {
      kind: "personal", providerRoute: "openai", credentialId: base.userId, credentialRevision: 2,
    }])),
    tavilyFunding: { kind: "server", providerRoute: "tavily" },
  };
  try {
    const context = await createHumanProductTransactionContext(base.userId, base.productDb);
    for (const metadataCase of [
      {
        source: { target: canary, instructions: canary, mode: "update", publish: "branch" },
        projected: { mode: "update", publish: "branch" },
      },
      {
        source: {
          execution: {
            ...execution,
            workingDirectory: canary,
          },
          preparation: {
            ...preparation,
            researchWork: { ...preparation.researchWork, subject: canary },
          },
          lastInterruption: {
            ...interruption, toolName: "private_tool", operation: "read",
          },
        },
        projected: { execution, preparation, lastInterruption: interruption },
      },
      {
        source: { deepResearch: { ...research, reportLanguage: canary } },
        projected: { deepResearch: research },
      },
    ]) {
      const taskId = randomUUID();
      base.taskIds.add(taskId);
      await base.admin.insert(tasks).values({
        id: taskId,
        ownerId: base.userId,
        requestorId: base.userId,
        agentId: base.productAgentId,
        prompt: canary,
        expectedOutput: canary,
        lastError: canary,
        status: "paused",
        scheduleKind: "now",
        callingRoomId: base.roomId,
        targetChat: "orphan",
        useScope: false,
        metadata: metadataCase.source,
        ordinaryFallbackOperationId: randomUUID(),
        ordinaryFallbackRequestDigest: base.crypto.hash(new TextEncoder().encode(taskId)),
        ordinaryFallbackReason: "target_encryption_not_ready",
        ordinaryFallbackPolicyRevision: base.policyRevision,
        ordinaryFallbackCompletedAt: new Date(NOW),
      });
      await context.canonicalRunner.transaction(async (tx) => {
        const transactionDb = tx as unknown as DirectDatabase;
        const ordinary = await getTaskByIdWithMutationVersion(transactionDb, taskId);
        const projected = await getProtectedTaskMutationSourceById(transactionDb, taskId, base.userId);
        if (ordinary === undefined || projected === undefined) throw new Error("Task fixture disappeared");
        expect(projected).toEqual({
          ...ordinary,
          prompt: "",
          expectedOutput: null,
          lastError: null,
          metadata: metadataCase.projected,
        });
        expect(JSON.stringify(projected)).not.toContain(canary);
        expect<unknown>(parseProtectedTaskOperationalMetadataProjectionV1(projected.metadata))
          .toEqual(metadataCase.projected);
        expect(ordinary).toMatchObject({
          prompt: canary,
          expectedOutput: canary,
          lastError: canary,
          metadata: metadataCase.source,
        });
        expect(await getProtectedTaskMutationSourceById(transactionDb, taskId, randomUUID())).toBeUndefined();
      }, { isolationLevel: "read committed" });
      for (const malformedMetadata of [
        { execution: { ...execution, harnessModelId: { unknownPrivate: canary } } },
        { execution: { ...execution, readiness: { ...execution.readiness, unknownPrivate: canary } } },
        { execution: { ...execution, unknownPrivate: canary } },
        { preparation: { ...preparation, researchWork: { ...preparation.researchWork, unknownPrivate: canary } } },
        { lastInterruption: { ...interruption, unknownPrivate: canary } },
        { unknownPrivate: canary },
      ]) {
        await base.admin.update(tasks).set({ metadata: malformedMetadata }).where(eq(tasks.id, taskId));
        await context.canonicalRunner.transaction(async (tx) => {
          const malformed = await getProtectedTaskMutationSourceById(tx as unknown as DirectDatabase, taskId, base.userId);
          expect(malformed).toBeDefined();
          expect(JSON.stringify(malformed)).not.toContain(canary);
          expect(parseProtectedTaskOperationalMetadataProjectionV1(malformed?.metadata)).toBeNull();
        }, { isolationLevel: "read committed" });
      }
      await base.admin.update(tasks).set({ metadata: {} }).where(eq(tasks.id, taskId));
      await context.canonicalRunner.transaction(async (tx) => {
        const absent = await getProtectedTaskMutationSourceById(tx as unknown as DirectDatabase, taskId, base.userId);
        expect(absent?.metadata).toEqual({});
        expect<unknown>(parseProtectedTaskOperationalMetadataProjectionV1(absent?.metadata)).toEqual({});
      }, { isolationLevel: "read committed" });
    }
  } finally {
    await base.cleanup();
  }
});

test("receipt-bound stale dual appends one signed protected revision without replacing history", async () => {
  const base = await createBaseFixture();
  const taskId = randomUUID();
  base.taskIds.add(taskId);
  try {
    await base.admin.update(encryptionTransitionPolicy).set({
      mode: "shadow_encryption",
      shadowBehavior: "strict",
      revision: base.policyRevision,
      shadowEncryptionStartedAt: new Date(NOW),
      updatedAt: new Date(NOW),
    }).where(eq(encryptionTransitionPolicy.id, "server"));
    await base.admin.insert(tasks).values({
      id: taskId,
      ownerId: base.userId,
      requestorId: base.userId,
      agentId: base.productAgentId,
      prompt: "Historical private Task",
      expectedOutput: "Preserve this output",
      scheduleKind: "now",
      status: "paused",
      callingRoomId: base.roomId,
      targetChat: "orphan",
      useScope: false,
      scopeId: null,
      metadata: {
        target: "file:///private/repository",
        mode: "update",
        publish: "branch",
        instructions: "Keep the original private instructions.",
      },
      lastError: "Earlier private Task failure.",
    });
    const oldObjectId = await repairHistoricalTaskDefinition(base, taskId, {
      expectedRetainedHistoricalError: "Earlier private Task failure.",
    });
    const [oldTask] = await base.admin.select({
      contentRevision: tasks.contentRevision,
      contentNamespaceId: tasks.contentNamespaceId,
      cryptoObjectId: tasks.cryptoObjectId,
      cryptoAccessRevision: tasks.cryptoAccessRevision,
      cryptoRequiredNamespaceFingerprint:
        tasks.cryptoRequiredNamespaceFingerprint,
    }).from(tasks).where(eq(tasks.id, taskId));
    const [oldLedger] = await base.admin.select({
      taskId: taskDefinitionCryptoRevisions.taskId,
      contentNamespaceId: taskDefinitionCryptoRevisions.contentNamespaceId,
      contentRevision: taskDefinitionCryptoRevisions.contentRevision,
      operationId: taskDefinitionCryptoRevisions.operationId,
      requestDigest: taskDefinitionCryptoRevisions.requestDigest,
      cryptoObjectId: taskDefinitionCryptoRevisions.cryptoObjectId,
      requiredNamespaceFingerprint:
        taskDefinitionCryptoRevisions.requiredNamespaceFingerprint,
      completion: taskDefinitionCryptoRevisions.completion,
      disposition: taskDefinitionCryptoRevisions.disposition,
      historicalRepair: taskDefinitionCryptoRevisions.historicalRepair,
    }).from(taskDefinitionCryptoRevisions).where(and(
      eq(taskDefinitionCryptoRevisions.taskId, taskId),
      eq(taskDefinitionCryptoRevisions.contentRevision, 1),
    ));
    if (oldTask === undefined || oldLedger === undefined) {
      throw new Error("Historical Task predecessor is missing");
    }
    expect(oldTask).toMatchObject({
      contentRevision: 1,
      contentNamespaceId: base.namespaceValue,
      cryptoObjectId: oldObjectId,
      cryptoAccessRevision: 0,
    });
    expect(oldLedger).toMatchObject({
      contentRevision: 1,
      cryptoObjectId: oldObjectId,
      completion: "complete",
      disposition: "mapped",
      historicalRepair: { version: 2 },
    });

    await base.admin.update(encryptionTransitionPolicy).set({
      mode: "shadow_encryption",
      shadowBehavior: "fallback",
      revision: base.policyRevision,
      updatedAt: new Date(NOW + 1),
    }).where(eq(encryptionTransitionPolicy.id, "server"));
    const owner = shadowFallbackOwner(base.policyRevision);
    const fallbackPorts = createTaskOrdinaryFallbackPorts({
      db: base.productDb,
      restricted: base.restricted,
      crypto: base.crypto,
      owner,
      observer: { kick() {} },
      now: () => NOW,
    });
    const authority = fallbackRouteAuthority(base);
    const fallback = await prepareSignedFallbackTaskUpdate(
      base,
      fallbackPorts,
      authority,
      taskId,
      {
        formatVersion: 2,
        prompt: "Fallback-edited private Task",
        expectedOutput: "Preserve the fallback output",
        protectedMetadata: {
          target: "file:///private/repository",
          instructions: "Keep the fallback private instructions.",
        },
        retainedHistoricalError: "Earlier private Task failure.",
      },
    );
    await fallbackPorts.publishUpdate({
      authority,
      taskId,
      prepared: fallback.prepared,
    });
    const [stale] = await base.admin.select({
      prompt: tasks.prompt,
      expectedOutput: tasks.expectedOutput,
      metadata: tasks.metadata,
      lastError: tasks.lastError,
      representation: tasks.contentRepresentation,
      contentRevision: tasks.contentRevision,
      contentNamespaceId: tasks.contentNamespaceId,
      cryptoObjectId: tasks.cryptoObjectId,
      cryptoAccessRevision: tasks.cryptoAccessRevision,
      requiredNamespaceFingerprint: tasks.cryptoRequiredNamespaceFingerprint,
      mapping: tasks.cryptoMappingState,
      fallbackOperationId: tasks.ordinaryFallbackOperationId,
      fallbackRequestDigest: tasks.ordinaryFallbackRequestDigest,
      fallbackReason: tasks.ordinaryFallbackReason,
      fallbackPolicyRevision: tasks.ordinaryFallbackPolicyRevision,
      fallbackCompletedAt: tasks.ordinaryFallbackCompletedAt,
    }).from(tasks).where(eq(tasks.id, taskId));
    if (stale === undefined) throw new Error("Fallback Task source is missing");
    expect(stale).toMatchObject({
      prompt: "Fallback-edited private Task",
      expectedOutput: "Preserve the fallback output",
      metadata: {
        target: "file:///private/repository",
        mode: "update",
        publish: "branch",
        instructions: "Keep the fallback private instructions.",
      },
      lastError: "Earlier private Task failure.",
      representation: "dual",
      contentRevision: 1,
      contentNamespaceId: oldTask?.contentNamespaceId,
      cryptoObjectId: oldObjectId,
      cryptoAccessRevision: oldTask?.cryptoAccessRevision,
      requiredNamespaceFingerprint: oldTask?.cryptoRequiredNamespaceFingerprint,
      mapping: "stale",
      fallbackOperationId: fallback.plan.operationId,
      fallbackReason: "target_encryption_not_ready",
      fallbackPolicyRevision: base.policyRevision,
    });
    expect(stale?.fallbackRequestDigest).toHaveLength(32);
    expect(stale?.fallbackCompletedAt).toBeInstanceOf(Date);
    for (const incomplete of [
      { ordinaryFallbackOperationId: null },
      { ordinaryFallbackRequestDigest: null },
      { ordinaryFallbackReason: null },
      { ordinaryFallbackPolicyRevision: null },
      { ordinaryFallbackCompletedAt: null },
    ]) {
      const rejectedReceipt = await base.admin.update(tasks).set(incomplete)
        .where(eq(tasks.id, taskId)).then(() => null, (error: unknown) => error);
      expect(rejectedReceipt).toMatchObject({ cause: {
        code: "23514", constraint_name: "tasks_ordinary_fallback_receipt_coherent",
      } });
    }
    expect(await base.admin.select({
      taskId: taskDefinitionCryptoRevisions.taskId,
      contentNamespaceId: taskDefinitionCryptoRevisions.contentNamespaceId,
      contentRevision: taskDefinitionCryptoRevisions.contentRevision,
      operationId: taskDefinitionCryptoRevisions.operationId,
      requestDigest: taskDefinitionCryptoRevisions.requestDigest,
      cryptoObjectId: taskDefinitionCryptoRevisions.cryptoObjectId,
      requiredNamespaceFingerprint:
        taskDefinitionCryptoRevisions.requiredNamespaceFingerprint,
      completion: taskDefinitionCryptoRevisions.completion,
      disposition: taskDefinitionCryptoRevisions.disposition,
      historicalRepair: taskDefinitionCryptoRevisions.historicalRepair,
    }).from(taskDefinitionCryptoRevisions).where(and(
      eq(taskDefinitionCryptoRevisions.taskId, taskId),
      eq(taskDefinitionCryptoRevisions.contentRevision, 1),
    ))).toEqual([oldLedger]);

    const protectedComposition = createProductionProtectedTaskComposition({
      db: base.productDb,
      restricted: base.restricted,
      crypto: base.crypto,
      serverScope: SERVER_SCOPE,
      owner,
      observer: { kick() {} },
      now: () => NOW,
    });
    const updatePlan = await protectedComposition.ports.plan({
      authority,
      taskId,
      request: {
        requestVersion: 1,
        operation: "update",
        operationId: `task:protected:update:${randomUUID()}`,
        task: {},
      },
    });
    expect(updatePlan).toMatchObject({
      taskId,
      expectedContentRevision: 1,
      nextContentRevision: 2,
      expectedCryptoAccessRevision: 0,
    });
    if (updatePlan.ordinaryRepairPayloadBase64url === undefined) {
      throw new Error("Shadow repair plan omitted its complete source");
    }
    const repairSourceBytes = new Uint8Array(Buffer.from(
      updatePlan.ordinaryRepairPayloadBase64url, "base64url",
    ));
    try {
      expect(decodeTaskDefinitionContent(repairSourceBytes)).toEqual({
        payload: {
          formatVersion: 1,
          prompt: "Fallback-edited private Task",
          expectedOutput: "Preserve the fallback output",
          protectedMetadata: {
            target: "file:///private/repository",
            instructions: "Keep the fallback private instructions.",
          },
        },
        retainedHistoricalError: "Earlier private Task failure.",
      });
    } finally {
      repairSourceBytes.fill(0);
    }
    // The same receipt-backed row may expose repair source bytes only through
    // the shared owner's Shadow port, never through Full or Plain.
    for (const policy of [
      { mode: "shadow_encryption", shadowBehavior: "strict" },
      { mode: "encrypted_only", shadowBehavior: "fallback" },
      { mode: "plaintext_only", shadowBehavior: "fallback" },
    ] as const) {
      await base.admin.update(encryptionTransitionPolicy).set({
        ...policy,
        shadowEncryptionStartedAt: policy.mode === "plaintext_only" ? null : new Date(NOW),
        updatedAt: new Date(NOW + 2),
      }).where(eq(encryptionTransitionPolicy.id, "server"));
      const modePorts = createProductionProtectedTaskComposition({
        db: base.productDb, restricted: base.restricted, crypto: base.crypto,
        serverScope: SERVER_SCOPE,
        owner: bindEncryptionDataOperationOwner({ policy: {
          resolve: async () => ({ policy, revalidationToken: base.policyRevision }),
          revalidate: async () => {},
        } }),
        observer: { kick() {} }, now: () => NOW,
      }).ports;
      const modePlan = modePorts.plan({ authority, taskId, request: {
        requestVersion: 1, operation: "update",
        operationId: updatePlan.operationId, task: {},
      } });
      if (policy.mode === "plaintext_only") {
        expect(await modePlan.then(() => null, (error: unknown) => error))
          .toMatchObject({ statusCode: 409, code: "protected_task_policy_unavailable" });
      } else {
        const selected = await modePlan;
        expect(selected.ordinaryRepairPayloadBase64url).toBe(
          policy.mode === "shadow_encryption"
            ? updatePlan.ordinaryRepairPayloadBase64url : undefined,
        );
        if (policy.mode === "shadow_encryption") {
          expect(selected.planDigestBase64url).toBe(updatePlan.planDigestBase64url);
        } else {
          expect(selected.planDigestBase64url).not.toBe(updatePlan.planDigestBase64url);
        }
      }
    }
    await base.admin.update(encryptionTransitionPolicy).set({
      mode: "shadow_encryption", shadowBehavior: "fallback",
      shadowEncryptionStartedAt: new Date(NOW),
      updatedAt: new Date(NOW + 1),
    }).where(eq(encryptionTransitionPolicy.id, "server"));
    const next = await prepareSignedDualTaskUpdate(base, updatePlan, {
      formatVersion: 2,
      prompt: "Repaired protected Task",
      expectedOutput: "Preserve the repaired output",
      protectedMetadata: {
        target: "file:///private/repository",
        instructions: "Keep the repaired private instructions.",
      },
      retainedHistoricalError: "Earlier private Task failure.",
    });
    base.objectIds.add(next.cryptoObjectId);
    const firstPublication = await protectedComposition.ports.publishUpdate({
      authority,
      taskId,
      prepared: next.prepared,
    });
    const [repaired] = await base.admin.select({
      prompt: tasks.prompt,
      expectedOutput: tasks.expectedOutput,
      metadata: tasks.metadata,
      lastError: tasks.lastError,
      representation: tasks.contentRepresentation,
      contentRevision: tasks.contentRevision,
      cryptoObjectId: tasks.cryptoObjectId,
      cryptoAccessRevision: tasks.cryptoAccessRevision,
      mapping: tasks.cryptoMappingState,
      fallbackOperationId: tasks.ordinaryFallbackOperationId,
      fallbackRequestDigest: tasks.ordinaryFallbackRequestDigest,
      fallbackReason: tasks.ordinaryFallbackReason,
      fallbackPolicyRevision: tasks.ordinaryFallbackPolicyRevision,
      fallbackCompletedAt: tasks.ordinaryFallbackCompletedAt,
    }).from(tasks).where(eq(tasks.id, taskId));
    if (repaired === undefined) throw new Error("Repaired Task is missing");
    expect(repaired).toEqual({
      prompt: "Repaired protected Task",
      expectedOutput: "Preserve the repaired output",
      metadata: {
        target: "file:///private/repository",
        mode: "update",
        publish: "branch",
        instructions: "Keep the repaired private instructions.",
      },
      lastError: "Earlier private Task failure.",
      representation: "dual",
      contentRevision: 2,
      cryptoObjectId: next.cryptoObjectId,
      cryptoAccessRevision: 0,
      mapping: "verified",
      fallbackOperationId: stale.fallbackOperationId,
      fallbackRequestDigest: stale.fallbackRequestDigest,
      fallbackReason: stale.fallbackReason,
      fallbackPolicyRevision: stale.fallbackPolicyRevision,
      fallbackCompletedAt: stale.fallbackCompletedAt,
    });
    const ledgers = await base.admin.select({
      contentRevision: taskDefinitionCryptoRevisions.contentRevision,
      operationId: taskDefinitionCryptoRevisions.operationId,
      requestDigest: taskDefinitionCryptoRevisions.requestDigest,
      cryptoObjectId: taskDefinitionCryptoRevisions.cryptoObjectId,
      requiredNamespaceFingerprint:
        taskDefinitionCryptoRevisions.requiredNamespaceFingerprint,
      completion: taskDefinitionCryptoRevisions.completion,
      disposition: taskDefinitionCryptoRevisions.disposition,
      historicalRepair: taskDefinitionCryptoRevisions.historicalRepair,
    }).from(taskDefinitionCryptoRevisions).where(
      eq(taskDefinitionCryptoRevisions.taskId, taskId),
    );
    expect(ledgers).toHaveLength(2);
    expect(ledgers.find(row => row.contentRevision === 1)).toMatchObject({
      cryptoObjectId: oldObjectId,
      completion: "complete",
      disposition: "mapped",
      historicalRepair: { version: 2 },
    });
    expect(ledgers.find(row => row.contentRevision === 2)).toMatchObject({
      contentRevision: 2,
      cryptoObjectId: next.cryptoObjectId,
      completion: "complete",
      disposition: "mapped",
      historicalRepair: null,
    });

    const replayedPublication = await protectedComposition.ports.publishUpdate({
      authority,
      taskId,
      prepared: next.prepared,
    });
    expect(replayedPublication).toEqual(firstPublication);
    expect(await base.admin.select({
      prompt: tasks.prompt,
      expectedOutput: tasks.expectedOutput,
      metadata: tasks.metadata,
      lastError: tasks.lastError,
      representation: tasks.contentRepresentation,
      contentRevision: tasks.contentRevision,
      cryptoObjectId: tasks.cryptoObjectId,
      cryptoAccessRevision: tasks.cryptoAccessRevision,
      mapping: tasks.cryptoMappingState,
      fallbackOperationId: tasks.ordinaryFallbackOperationId,
      fallbackRequestDigest: tasks.ordinaryFallbackRequestDigest,
      fallbackReason: tasks.ordinaryFallbackReason,
      fallbackPolicyRevision: tasks.ordinaryFallbackPolicyRevision,
      fallbackCompletedAt: tasks.ordinaryFallbackCompletedAt,
    }).from(tasks).where(eq(tasks.id, taskId))).toEqual([repaired]);
    expect(await base.admin.select({
      contentRevision: taskDefinitionCryptoRevisions.contentRevision,
      operationId: taskDefinitionCryptoRevisions.operationId,
      requestDigest: taskDefinitionCryptoRevisions.requestDigest,
      cryptoObjectId: taskDefinitionCryptoRevisions.cryptoObjectId,
      requiredNamespaceFingerprint:
        taskDefinitionCryptoRevisions.requiredNamespaceFingerprint,
      completion: taskDefinitionCryptoRevisions.completion,
      disposition: taskDefinitionCryptoRevisions.disposition,
      historicalRepair: taskDefinitionCryptoRevisions.historicalRepair,
    }).from(taskDefinitionCryptoRevisions).where(
      eq(taskDefinitionCryptoRevisions.taskId, taskId),
    )).toEqual(ledgers);

    const storage = new PostgresLatticeStorage(base.cryptoHandle);
    const oldObject = await storage.getObject(oldObjectId);
    const oldAccess = await storage.getObjectAccessState(oldObjectId);
    const oldEnvelope = oldAccess?.namespaceEnvelopes.find(
      entry => entry.namespaceId === base.namespaceValue,
    );
    if (oldObject === null || oldAccess === null || oldEnvelope === undefined) {
      throw new Error("Retained historical Task object is incomplete");
    }
    const decrypted = decryptObjectThroughNamespace(
      base.crypto,
      base.namespace.key,
      decodeNamespaceObjectEnvelopeV2(oldEnvelope.envelopeBytes),
      decodeEncryptedPayloadV2(oldObject.payloadBytes),
    );
    if (decrypted === null) throw new Error("Retained historical Task object cannot be opened");
    try {
      expect(decodeTaskDefinitionContent(decrypted)).toEqual({
        payload: {
          formatVersion: 1,
          prompt: "Historical private Task",
          expectedOutput: "Preserve this output",
          protectedMetadata: {
            target: "file:///private/repository",
            instructions: "Keep the original private instructions.",
          },
        },
        retainedHistoricalError: "Earlier private Task failure.",
      });
    } finally {
      decrypted.fill(0);
      oldObject.payloadBytes.fill(0);
      oldEnvelope.envelopeBytes.fill(0);
    }
  } finally {
    await base.cleanup();
  }
});

test("signed stale-dual repair rejects a replaced fallback receipt", async () => {
  const base = await createBaseFixture();
  const taskId = randomUUID();
  base.taskIds.add(taskId);
  try {
    const prepared = await prepareReceiptBoundStaleDualRepair(
      base,
      taskId,
      "Receipt replacement race",
    );
    const replacement = await prepareSignedFallbackTaskUpdate(
      base,
      prepared.fallbackPorts,
      prepared.authority,
      taskId,
      {
        formatVersion: 1,
        prompt: "Replacement fallback source",
        expectedOutput: "Replacement fallback output",
        protectedMetadata: {
          target: "file:///private/repository",
          instructions: "Replacement fallback instructions",
        },
      },
    );
    await prepared.fallbackPorts.publishUpdate({
      authority: prepared.authority,
      taskId,
      prepared: replacement.prepared,
    });

    const rejected = await prepared.protectedComposition.ports.publishUpdate({
      authority: prepared.authority,
      taskId,
      prepared: prepared.repair.prepared,
    }).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(TypeError);
    expect(rejected).toMatchObject({
      message: "Expired Task publication is not an exact durable replay",
    });
    const replacementRows = await base.admin.select({
      prompt: tasks.prompt,
      representation: tasks.contentRepresentation,
      contentRevision: tasks.contentRevision,
      mapping: tasks.cryptoMappingState,
      fallbackOperationId: tasks.ordinaryFallbackOperationId,
      fallbackRequestDigest: tasks.ordinaryFallbackRequestDigest,
      fallbackReason: tasks.ordinaryFallbackReason,
      fallbackPolicyRevision: tasks.ordinaryFallbackPolicyRevision,
      fallbackCompletedAt: tasks.ordinaryFallbackCompletedAt,
    }).from(tasks).where(eq(tasks.id, taskId));
    expect(replacementRows).toHaveLength(1);
    expect(replacementRows[0]).toMatchObject({
      prompt: "Replacement fallback source",
      representation: "dual",
      contentRevision: 1,
      mapping: "stale",
      fallbackOperationId: replacement.plan.operationId,
      fallbackReason: "target_encryption_not_ready",
      fallbackPolicyRevision: base.policyRevision,
    });
    expect(replacementRows[0]?.fallbackRequestDigest).toEqual(
      new Uint8Array(Buffer.from(
        replacement.prepared.authenticatedRequestDigestBase64url,
        "base64url",
      )),
    );
    expect(replacementRows[0]?.fallbackCompletedAt).toBeInstanceOf(Date);
    expect(await base.admin.select({
      contentRevision: taskDefinitionCryptoRevisions.contentRevision,
    }).from(taskDefinitionCryptoRevisions).where(and(
      eq(taskDefinitionCryptoRevisions.taskId, taskId),
      eq(taskDefinitionCryptoRevisions.contentRevision, 2),
    ))).toEqual([]);
    expect(await objectRowCounts(base, prepared.repair.cryptoObjectId)).toEqual({
      payload: 0,
      head: 0,
      manifest: 0,
      envelope: 0,
    });
  } finally {
    await base.cleanup();
  }
});

test("signed stale-dual repair rejects publication policy revision drift", async () => {
  const base = await createBaseFixture();
  const taskId = randomUUID();
  base.taskIds.add(taskId);
  try {
    const prepared = await prepareReceiptBoundStaleDualRepair(
      base,
      taskId,
      "Policy revision race",
    );
    await base.admin.update(encryptionTransitionPolicy).set({
      mode: "shadow_encryption",
      shadowBehavior: "strict",
      revision: base.policyRevision + 1,
      updatedAt: new Date(NOW + 2),
    }).where(eq(encryptionTransitionPolicy.id, "server"));

    const rejected = await prepared.protectedComposition.ports.publishUpdate({
      authority: prepared.authority,
      taskId,
      prepared: prepared.repair.prepared,
    }).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(TypeError);
    expect(rejected).toMatchObject({
      name: "TypeError",
      message: "Expired Task publication is not an exact durable replay",
    });
    expect(await base.admin.select({
      prompt: tasks.prompt,
      representation: tasks.contentRepresentation,
      contentRevision: tasks.contentRevision,
      mapping: tasks.cryptoMappingState,
      fallbackOperationId: tasks.ordinaryFallbackOperationId,
    }).from(tasks).where(eq(tasks.id, taskId))).toEqual([{
      prompt: "Policy revision race fallback source",
      representation: "dual",
      contentRevision: 1,
      mapping: "stale",
      fallbackOperationId: prepared.fallback.plan.operationId,
    }]);
    expect(await base.admin.select({
      contentRevision: taskDefinitionCryptoRevisions.contentRevision,
    }).from(taskDefinitionCryptoRevisions).where(and(
      eq(taskDefinitionCryptoRevisions.taskId, taskId),
      eq(taskDefinitionCryptoRevisions.contentRevision, 2),
    ))).toEqual([]);
    expect(await objectRowCounts(base, prepared.repair.cryptoObjectId)).toEqual({
      payload: 0,
      head: 0,
      manifest: 0,
      envelope: 0,
    });
  } finally {
    await base.cleanup();
  }
});

test("preexisting protected successor reservation blocks signed ordinary fallback", async () => {
  const base = await createBaseFixture();
  const taskId = randomUUID();
  base.taskIds.add(taskId);
  try {
    await base.admin.update(encryptionTransitionPolicy).set({
      mode: "shadow_encryption",
      shadowBehavior: "strict",
      revision: base.policyRevision,
      shadowEncryptionStartedAt: new Date(NOW),
      updatedAt: new Date(NOW),
    }).where(eq(encryptionTransitionPolicy.id, "server"));
    await base.admin.insert(tasks).values({
      id: taskId,
      ownerId: base.userId,
      requestorId: base.userId,
      agentId: base.productAgentId,
      prompt: "Reserved successor source",
      scheduleKind: "now",
      status: "paused",
      callingRoomId: base.roomId,
      targetChat: "orphan",
      useScope: false,
      scopeId: null,
    });
    await repairHistoricalTaskDefinition(base, taskId);
    await base.admin.update(encryptionTransitionPolicy).set({
      mode: "shadow_encryption",
      shadowBehavior: "fallback",
      revision: base.policyRevision,
      updatedAt: new Date(NOW + 1),
    }).where(eq(encryptionTransitionPolicy.id, "server"));
    const owner = shadowFallbackOwner(base.policyRevision);
    const authority = fallbackRouteAuthority(base);
    const fallbackPorts = createTaskOrdinaryFallbackPorts({
      db: base.productDb,
      restricted: base.restricted,
      crypto: base.crypto,
      owner,
      observer: { kick() {} },
      now: () => NOW,
    });
    const fallback = await prepareSignedFallbackTaskUpdate(
      base,
      fallbackPorts,
      authority,
      taskId,
      {
        formatVersion: 1,
        prompt: "Fallback must lose the reservation race",
        expectedOutput: null,
        protectedMetadata: {},
      },
    );
    const protectedComposition = createProductionProtectedTaskComposition({
      db: base.productDb,
      restricted: base.restricted,
      crypto: base.crypto,
      serverScope: SERVER_SCOPE,
      owner,
      observer: { kick() {} },
      now: () => NOW,
    });
    const successorPlan = await protectedComposition.ports.plan({
      authority,
      taskId,
      request: {
        requestVersion: 1,
        operation: "update",
        operationId: `task:protected:reserved:${randomUUID()}`,
        task: {},
      },
    });
    const successor = await prepareSignedDualTaskUpdate(base, successorPlan, {
      formatVersion: 1,
      prompt: "Reserved protected successor",
      expectedOutput: null,
      protectedMetadata: {},
    });
    const classified = classifyProtectedTaskMetadataV1({});
    if (classified.status !== "supported") {
      throw new Error("Reserved successor metadata is unsupported");
    }
    const repository = createDormantTaskContentShadowRepository({
      product: new PostgresTaskContentProductStore(
        base.product.handle,
        () => successor.authority,
      ),
      crypto: createPostgresTaskContentCryptoCompletion({
        handle: base.cryptoHandle,
        crypto: base.crypto,
        resolveCurrentAuthority: () => Promise.resolve(successor.authority),
        resolveHistoricalAgentSignerAuthority: () => null,
        resolveHistoricalHumanDeviceSigningPublicKey: () =>
          Promise.resolve(base.currentDevice.signingPublicKey.slice()),
      }),
    });
    expect(await repository.reserveRevision({
      operationId: successorPlan.operationId,
      requestDigest: base.crypto.hash(new TextEncoder().encode(
        successorPlan.operationId,
      )),
      representation: "dual",
      authority: successor.authority,
      prepared: successor.opaque,
      operationalMetadata: classified.operational,
    })).toMatchObject({
      status: "reserved",
      coordinate: { taskId, contentRevision: 2 },
    });

    const blocked = await fallbackPorts.publishUpdate({
      authority,
      taskId,
      prepared: fallback.prepared,
    }).catch((error: unknown) => error);
    expect(blocked).toMatchObject({
      statusCode: 409,
      code: "task_ordinary_fallback_unavailable",
    });
    expect(await base.admin.select({
      contentRevision: tasks.contentRevision,
      mapping: tasks.cryptoMappingState,
      fallbackOperationId: tasks.ordinaryFallbackOperationId,
      fallbackRequestDigest: tasks.ordinaryFallbackRequestDigest,
      fallbackReason: tasks.ordinaryFallbackReason,
      fallbackPolicyRevision: tasks.ordinaryFallbackPolicyRevision,
      fallbackCompletedAt: tasks.ordinaryFallbackCompletedAt,
    }).from(tasks).where(eq(tasks.id, taskId))).toEqual([{
      contentRevision: 1,
      mapping: "verified",
      fallbackOperationId: null,
      fallbackRequestDigest: null,
      fallbackReason: null,
      fallbackPolicyRevision: null,
      fallbackCompletedAt: null,
    }]);
    expect(await base.admin.select({
      contentRevision: taskDefinitionCryptoRevisions.contentRevision,
      completion: taskDefinitionCryptoRevisions.completion,
      disposition: taskDefinitionCryptoRevisions.disposition,
      historicalRepair: taskDefinitionCryptoRevisions.historicalRepair,
    }).from(taskDefinitionCryptoRevisions).where(and(
      eq(taskDefinitionCryptoRevisions.taskId, taskId),
      eq(taskDefinitionCryptoRevisions.contentRevision, 2),
    ))).toEqual([{
      contentRevision: 2,
      completion: "pending",
      disposition: "active",
      historicalRepair: null,
    }]);
  } finally {
    await base.cleanup();
  }
});


test.each([
  { expireAfterStage: false, retainedHistoricalError: null },
  { expireAfterStage: true, retainedHistoricalError: null },
  { expireAfterStage: false, retainedHistoricalError: "Earlier private Task failure." },
  { expireAfterStage: true, retainedHistoricalError: "Earlier private Task failure." },
])("historical Task repair stages and maps atomically %j", async ({ expireAfterStage, retainedHistoricalError }) => {
  let currentNow = NOW;
  const base = await createBaseFixture({ cryptoNow: () => currentNow });
  const taskId = randomUUID();
  base.taskIds.add(taskId);
  try {
    await base.admin.update(encryptionTransitionPolicy).set({
      mode: "shadow_encryption", shadowBehavior: "strict", revision: base.policyRevision,
      shadowEncryptionStartedAt: new Date(NOW), updatedAt: new Date(NOW),
    }).where(eq(encryptionTransitionPolicy.id, "server"));
    await base.admin.insert(tasks).values({
      id: taskId, ownerId: base.userId, requestorId: base.userId,
      agentId: base.productAgentId, prompt: "Historical private Task",
      expectedOutput: "Preserve this output", scheduleKind: "now",
      status: "paused", callingRoomId: base.roomId, targetChat: "orphan",
      useScope: false, scopeId: null, lastError: retainedHistoricalError,
    });
    const historicalObjectId = await repairHistoricalTaskDefinition(base, taskId, {
      expectedRetainedHistoricalError: retainedHistoricalError, expireAfterStage, now: () => currentNow, afterStage: () => { currentNow = NOW + 25_000; },
    });
    const [mapped] = await base.admin.select({ prompt: tasks.prompt, expectedOutput: tasks.expectedOutput,
      status: tasks.status, representation: tasks.contentRepresentation,
      revision: tasks.contentRevision, objectId: tasks.cryptoObjectId, mapping: tasks.cryptoMappingState,
    }).from(tasks).where(eq(tasks.id, taskId));
    expect(mapped).toEqual({ prompt: "Historical private Task", expectedOutput: "Preserve this output",
      status: "paused", representation: "dual", revision: 1, objectId: historicalObjectId, mapping: "verified" });
    const [ledger] = await base.admin.select({ completion: taskDefinitionCryptoRevisions.completion,
      disposition: taskDefinitionCryptoRevisions.disposition,
      historicalRepair: taskDefinitionCryptoRevisions.historicalRepair,
    }).from(taskDefinitionCryptoRevisions).where(eq(taskDefinitionCryptoRevisions.taskId, taskId));
    expect(ledger).toMatchObject({ completion: "complete", disposition: "mapped", historicalRepair: { version: 2 } });
    const [current] = await base.admin.select().from(tasks).where(eq(tasks.id, taskId));
    if (current === undefined) throw new Error("Mapped historical Task is missing");
    const proofs = await readHistoricalTaskDefinitionSummaryProofs(base.productDb, base.userId, [current]);
    const historicalDefinitionProof = proofs.get(taskId);
    if (historicalDefinitionProof === undefined) throw new Error("Mapped historical Task proof is missing");
    const summary = toTaskContentSummaryV1(current, { agentName: null, lastModelId: null,
      historicalDefinitionProof });
    expect(summary.content).toMatchObject({ status: "protected", objectId: historicalObjectId, contentRevision: 1 });
    expect(JSON.stringify(summary)).not.toContain("Historical private Task");
    expect(JSON.stringify(summary)).not.toContain("Earlier private Task failure");
  } finally { await base.cleanup(); }
});


test("historical Task repair recovers an exact accepted legacy receipt", async () => {
  const base = await createBaseFixture();
  const taskId = randomUUID();
  base.taskIds.add(taskId);
  try {
    await base.admin.update(encryptionTransitionPolicy).set({
      mode: "shadow_encryption", shadowBehavior: "strict", revision: base.policyRevision,
      shadowEncryptionStartedAt: new Date(NOW), updatedAt: new Date(NOW),
    }).where(eq(encryptionTransitionPolicy.id, "server"));
    await base.admin.insert(tasks).values({
      id: taskId, ownerId: base.userId, requestorId: base.userId,
      agentId: base.productAgentId, prompt: "Historical receipt compatibility",
      expectedOutput: "Preserve this output", scheduleKind: "now",
      status: "paused", callingRoomId: base.roomId, targetChat: "orphan",
      useScope: false, scopeId: null,
    });
    const objectId = await repairHistoricalTaskDefinition(base, taskId, {
      legacyReceipt: true,
    });
    const [mapped] = await base.admin.select({
      representation: tasks.contentRepresentation,
      revision: tasks.contentRevision,
      objectId: tasks.cryptoObjectId,
      mapping: tasks.cryptoMappingState,
    }).from(tasks).where(eq(tasks.id, taskId));
    expect(mapped).toEqual({
      representation: "dual", revision: 1, objectId, mapping: "verified",
    });
  } finally {
    await base.cleanup();
  }
});

test("historical Task repair never stages a legacy upload without its receipt", async () => {
  const base = await createBaseFixture();
  const taskId = randomUUID();
  base.taskIds.add(taskId);
  try {
    await base.admin.update(encryptionTransitionPolicy).set({
      mode: "shadow_encryption", shadowBehavior: "strict", revision: base.policyRevision,
      shadowEncryptionStartedAt: new Date(NOW), updatedAt: new Date(NOW),
    }).where(eq(encryptionTransitionPolicy.id, "server"));
    await base.admin.insert(tasks).values({
      id: taskId, ownerId: base.userId, requestorId: base.userId,
      agentId: base.productAgentId, prompt: "Unaccepted historical upload",
      status: "paused", callingRoomId: base.roomId, targetChat: "orphan",
      useScope: false, scopeId: null,
    });
    await repairHistoricalTaskDefinition(base, taskId, {
      legacyUploadWithoutReceipt: true,
    });
    const [unchanged] = await base.admin.select({
      representation: tasks.contentRepresentation,
      revision: tasks.contentRevision,
      mapping: tasks.cryptoMappingState,
    }).from(tasks).where(eq(tasks.id, taskId));
    expect(unchanged).toEqual({
      representation: "ordinary", revision: 0, mapping: "unmapped",
    });
  } finally {
    await base.cleanup();
  }
});

test("historical scan defers an unavailable first Room, reaches later work, and retries it next sweep", async () => {
  const base = await createBaseFixture();
  const unavailableAgent = randomUUID();
  try {
    await base.admin.update(encryptionTransitionPolicy).set({ mode: "shadow_encryption",
      shadowBehavior: "strict", revision: base.policyRevision, shadowEncryptionStartedAt: new Date(NOW),
      updatedAt: new Date(NOW) }).where(eq(encryptionTransitionPolicy.id, "server"));
    await base.admin.insert(agents).values({ id: unavailableAgent, handle: `unavailable-task-agent-${unavailableAgent}` });
    await base.admin.insert(actors).values({ id: randomUUID(), ownerId: base.userId,
      displayName: "Unavailable Task Agent", trustState: "verified", kind: "agent", agentId: unavailableAgent });
    const first = randomUUID(); const second = randomUUID();
    for (const [index, id] of [first, second].entries()) {
      base.taskIds.add(id);
      await base.admin.insert(tasks).values({ id, ownerId: base.userId, requestorId: base.userId,
        agentId: index === 0 ? unavailableAgent : base.productAgentId,
        prompt: "Historical repair source must remain private", status: "paused",
        createdAt: new Date(NOW - 2_000 + index), updatedAt: new Date(NOW - 1_000) });
    }
    let observedAt = NOW;
    const service = createTaskContentBackfillScanService({ db: base.productDb, restricted: base.restricted,
      crypto: base.crypto, serverScope: SERVER_SCOPE, pageLimit: 1, leaseDurationMs: 30_000,
      sweepIntervalMs: 60_000, now: () => observedAt,
      owner: bindEncryptionDataOperationOwner({ policy: {
        resolve: async () => ({ policy: { mode: "shadow_encryption", shadowBehavior: "strict" }, revalidationToken: base.policyRevision }),
        revalidate: async () => {},
      } }),
    });
    const subject = { userId: base.userId, humanActorId: base.humanActorId,
      admission: { ...base.currentDevice, headDigest: base.currentDevice.headDigest.slice(), expiresAt: NOW + 120_000 } };
    const discover = async () => {
      const found = await service.discover(subject);
      if (found.status !== "ready" || found.value.status !== "candidate") throw new Error("Historical candidate not ready");
      return found.value;
    };
    const unavailable = await discover();
    expect(unavailable.candidate.taskId).toBe(first);
    expect(await service.claim(subject, unavailable)).toEqual({ status: "ready", value: { status: "deferred" } });
    const available = await discover();
    expect(available.candidate.taskId).toBe(second);
    const claimed = await service.claim(subject, available);
    expect(claimed).toMatchObject({ status: "ready", value: { status: "claimed" } });
    if (claimed.status !== "ready" || claimed.value.status !== "claimed") throw new Error("Later candidate not claimed");
    expect(await service.release(subject, claimed.value.claim.claimId, true)).toEqual({ status: "ready", value: true });
    expect(await service.discover(subject)).toMatchObject({ status: "ready", value: { status: "swept" } });
    observedAt += 60_001;
    expect((await discover()).candidate.taskId).toBe(first);
  } finally {
    try {
      await base.admin.delete(tasks).where(eq(tasks.agentId, unavailableAgent));
      await base.admin.delete(actors).where(eq(actors.agentId, unavailableAgent));
      await base.admin.delete(agents).where(eq(agents.id, unavailableAgent));
    } finally { await base.cleanup(); }
  }
});

test.each(["definition", "result"] as const)("historical %s scan orders fractional timestamps by its durable cursor", async kind => {
  const base = await createBaseFixture();
  try {
    await base.admin.update(encryptionTransitionPolicy).set({
      mode: "shadow_encryption", shadowBehavior: "strict", revision: base.policyRevision,
      shadowEncryptionStartedAt: new Date(NOW), updatedAt: new Date(NOW),
    }).where(eq(encryptionTransitionPolicy.id, "server"));
    const ids = [randomUUID(), randomUUID()].sort();
    let parentTaskId: string | null = null;
    if (kind === "result") {
      const parent = await createScenario(base, { contentRepresentation: "dual" });
      parentTaskId = parent.taskId;
      await base.admin.update(tasks).set({ status: "completed" }).where(eq(tasks.id, parent.taskId));
    }
    for (const [index, id] of ids.entries()) {
      // Deliberately reverse the microseconds against the ID order in one
      // millisecond; cursor JSON retains only milliseconds.
      const fractional = index === 0
        ? sql`'2026-10-11T09:00:00.123999Z'::timestamptz`
        : sql`'2026-10-11T09:00:00.123111Z'::timestamptz`;
      if (kind === "definition") {
        base.taskIds.add(id);
        await base.admin.insert(tasks).values({ id, ownerId: base.userId, requestorId: base.userId,
          agentId: base.productAgentId, prompt: "Historical scan fixture", status: "paused",
          createdAt: fractional, updatedAt: new Date(NOW), callingRoomId: base.roomId,
        });
      } else {
        await base.admin.insert(taskRuns).values({ id, taskId: parentTaskId!, status: "completed",
          graphThreadId: `historical-scan:${id}`,
          startedAt: new Date("2026-10-11T08:00:00Z"), completedAt: fractional, resultText: "Historical scan result",
        });
      }
    }
    const found: string[] = [];
    for (const id of ids) {
      const next = await discoverTaskContentBackfill(base.admin, {
        humanActorId: base.humanActorId, deviceId: base.deviceId, now: new Date(NOW),
        pageLimit: 1, resumeAt: new Date(NOW + 60_000),
      });
      if (next.status !== "candidate") throw new Error(`Historical scan unexpectedly ${next.status}`);
      found.push(next.candidate.kind === "definition" ? next.candidate.taskId : next.candidate.taskRunId);
      expect(found.at(-1)).toBe(id);
      const installed = await claimTaskContentBackfill(base.admin, {
        humanActorId: base.humanActorId, requesterUserId: base.userId, deviceId: base.deviceId,
        claimId: randomUUID(), policyRevision: base.policyRevision, candidate: next.candidate,
        now: new Date(NOW), expiresAt: new Date(NOW + 30_000),
      });
      if (installed.status !== "claimed") throw new Error(`Historical scan claim ${installed.status}`);
      expect(await releaseTaskContentBackfillLease(base.admin, {
        claim: installed.claim, now: new Date(NOW), advance: true,
      })).toBe(true);
    }
    expect(found).toEqual(ids);
    expect(await discoverTaskContentBackfill(base.admin, {
      humanActorId: base.humanActorId, deviceId: base.deviceId, now: new Date(NOW),
      pageLimit: 1, resumeAt: new Date(NOW + 60_000),
    })).toMatchObject({ status: "swept" });
  } finally { await base.cleanup(); }
});

});
