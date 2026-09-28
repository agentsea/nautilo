import {
  and,
  eq,
  humanCryptoDevices,
  inArray,
  type DirectDatabase,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import {
  ClassifiedDataOperationError,
  withProtectedTaskResultSigner,
  type EncryptionDataOperationOwner,
  type TaskContentAuthorityV1,
} from "@nautilo/lattice-bridge";
import {
  PostgresHumanDeviceSignerHistory,
  PostgresLatticeStorage,
  createPostgresTaskContentRepositoryV1,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  prepareNativeTaskRuntimeRunResult,
  verifyCryptoPostgresHandle,
  type ConversationProductCanonicalTransactionRunner,
  type ConversationProductPostgresHandle,
  type CryptoPostgresHandle,
} from "@nautilo/lattice-bridge/server";
import {
  type DomainForegroundSecretEntry,
  type LatticeCrypto,
  type LatticeStorage,
} from "@nautilo/lattice-crypto";
import {
  decodeTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import {
  BACKGROUND_AUTHORIZATION_MAX_IDENTIFIER_BYTES,
  publishPreparedProtectedTaskRunResult,
  type TaskRuntimeGrantClaimPlan,
} from "@nautilo/runtime";

import {
  createProtectedTaskResultPhaseAuthorityResolver,
} from "./protected-task-result-phase-authority";
import {
  withProtectedTaskResultSignerHistory,
} from "./protected-task-result-signer-history";
import {
  createProtectedTaskRunTerminalPorts,
} from "./protected-task-run-terminal";

type ProductContext = Readonly<{
  handle: ConversationProductPostgresHandle;
  canonicalRunner: ConversationProductCanonicalTransactionRunner;
}>;

type ProtectedTaskJobReferenceV1 = TaskRuntimeGrantClaimPlan["reference"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TASK_DEFINITION_OBJECT_ID = /^task-definition:v1:[0-9a-f]{64}$/u;
const TASK_RUN_RESULT_OBJECT_ID = /^task-run-result:v1:[0-9a-f]{64}$/u;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const encoder = new TextEncoder();

export type ProtectedTaskNativeResultPublicationInput = Readonly<{
  reference: ProtectedTaskJobReferenceV1;
  db: DirectDatabase;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  owner: EncryptionDataOperationOwner;
  serverScope: string;
  product: ProductContext;
  now?: () => number;
}>;

type Dependencies = Readonly<{
  decodeRequest: typeof decodeTaskRuntimeBackgroundAuthorizationRequestV1;
  destroyRequest: typeof destroyTaskRuntimeBackgroundAuthorizationRequestV1;
  verifyCryptoHandle: typeof verifyCryptoPostgresHandle;
  createRepository: typeof createPostgresTaskContentRepositoryV1;
  createTerminalPorts: typeof createProtectedTaskRunTerminalPorts;
  createPhaseAuthority: typeof createProtectedTaskResultPhaseAuthorityResolver;
  withSignerHistory: typeof withProtectedTaskResultSignerHistory;
  withSigner: typeof withProtectedTaskResultSigner;
  prepare: typeof prepareNativeTaskRuntimeRunResult;
  publish: typeof publishPreparedProtectedTaskRunResult;
  createHumanSignerHistory(
    handle: CryptoPostgresHandle,
    crypto: LatticeCrypto,
  ): Pick<
    PostgresHumanDeviceSignerHistory,
    "resolveAgentRuntimeSignerManager"
  >;
  createStorage(handle: CryptoPostgresHandle): Pick<
    LatticeStorage,
    "getAgentRuntimeAtomicState" | "getAgentRuntimeSignerPublication"
  >;
}>;

const productionDependencies: Dependencies = Object.freeze({
  decodeRequest: decodeTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyRequest: destroyTaskRuntimeBackgroundAuthorizationRequestV1,
  verifyCryptoHandle: verifyCryptoPostgresHandle,
  createRepository: createPostgresTaskContentRepositoryV1,
  createTerminalPorts: createProtectedTaskRunTerminalPorts,
  createPhaseAuthority: createProtectedTaskResultPhaseAuthorityResolver,
  withSignerHistory: withProtectedTaskResultSignerHistory,
  withSigner: withProtectedTaskResultSigner,
  prepare: prepareNativeTaskRuntimeRunResult,
  publish: publishPreparedProtectedTaskRunResult,
  createHumanSignerHistory: (handle, crypto) =>
    new PostgresHumanDeviceSignerHistory({ handle, crypto }),
  createStorage: (handle) => new PostgresLatticeStorage(handle),
});

function sameAuthority(
  left: TaskContentAuthorityV1,
  right: TaskContentAuthorityV1,
): boolean {
  return left.authorityVersion === right.authorityVersion
    && left.kind === right.kind
    && left.keyClass === right.keyClass
    && left.requesterHumanId === right.requesterHumanId
    && left.namespaceId === right.namespaceId
    && left.domainId === right.domainId
    && left.expectedAccessRevision === right.expectedAccessRevision
    && left.expectedPolicyRevision === right.expectedPolicyRevision;
}

function assertExactReference(reference: ProtectedTaskJobReferenceV1): void {
  const resumed = Number.isSafeInteger(reference.executionSegment)
    && reference.executionSegment > 1;
  if (
    Object.keys(reference).sort().join(",")
      !== (resumed
        ? "authorizationRequestId,executionSegment,inputObjectId,kind,policyRevision,resultObjectId,resumeAcceptanceId,taskId,taskRunId"
        : "authorizationRequestId,executionSegment,inputObjectId,kind,policyRevision,resultObjectId,taskId,taskRunId")
    || reference.kind !== "protected_task_run_v1"
    || !UUID.test(reference.taskId)
    || !UUID.test(reference.taskRunId)
    || !TASK_DEFINITION_OBJECT_ID.test(reference.inputObjectId)
    || !TASK_RUN_RESULT_OBJECT_ID.test(reference.resultObjectId)
    || !PORTABLE_ID.test(reference.authorizationRequestId)
    || encoder.encode(reference.authorizationRequestId).length
      > BACKGROUND_AUTHORIZATION_MAX_IDENTIFIER_BYTES
    || !Number.isSafeInteger(reference.policyRevision)
    || reference.policyRevision < 1
    || !Number.isSafeInteger(reference.executionSegment)
    || reference.executionSegment < 1
    || (resumed && (
      typeof reference.resumeAcceptanceId !== "string"
      || !PORTABLE_ID.test(reference.resumeAcceptanceId)
      || encoder.encode(reference.resumeAcceptanceId).length
        > BACKGROUND_AUTHORIZATION_MAX_IDENTIFIER_BYTES
    ))
  ) throw new TypeError("Protected Task result reference is invalid");
}

function destroyDetachedBytes(value: unknown): void {
  if (value instanceof Uint8Array) value.fill(0);
  else if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) destroyDetachedBytes(nested);
  }
}

function matchingResultDomain(input: Readonly<{
  domains: readonly DomainForegroundSecretEntry[];
  domainId: string;
}>): DomainForegroundSecretEntry {
  const matches = input.domains.filter((domain) =>
    domain.domainId === input.domainId
  );
  const domain = matches[0];
  if (matches.length !== 1 || domain === undefined || domain.keyClass !== "ai") {
    throw new ClassifiedDataOperationError(
      "authority",
      "Protected Task result Domain is unavailable",
    );
  }
  return domain;
}

function humanDeviceSigningKeyResolver(handle: CryptoPostgresHandle) {
  return async (context: Readonly<{
    subjectHumanId: string;
    committerDeviceId: string;
    hostAuthorizationRevision: number;
  }>): Promise<Uint8Array | null> => {
    const rows = await executeTypedCryptoQuery(
      handle,
      cryptoTypedDb.select({
        human_id: humanCryptoDevices.humanId,
        signing_public_key: humanCryptoDevices.signingPublicKey,
        revision: humanCryptoDevices.revision,
      }).from(humanCryptoDevices).where(and(
        eq(humanCryptoDevices.deviceId, context.committerDeviceId),
        eq(humanCryptoDevices.humanId, context.subjectHumanId),
        inArray(humanCryptoDevices.state, ["active", "revoked"]),
      )).limit(2),
    );
    const row = rows[0];
    return rows.length === 1
        && row !== undefined
        && row.revision >= context.hostAuthorizationRevision
        && row.signing_public_key instanceof Uint8Array
      ? row.signing_public_key.slice()
      : null;
  };
}

/**
 * Build one dark, native result publisher for an exact protected Task grant.
 * The Runtime signer exists only through preparation; durable publication runs
 * after signer history has completed its final current-generation recheck.
 */
export function createProtectedTaskNativeResultPublication(
  input: ProtectedTaskNativeResultPublicationInput,
  overrides: Partial<Dependencies> = {},
): TaskRuntimeGrantClaimPlan["publishResult"] {
  assertExactReference(input.reference);
  if (input.serverScope.length === 0) {
    throw new TypeError("Protected Task result server scope is unavailable");
  }
  const dependencies = Object.freeze({ ...productionDependencies, ...overrides });
  const now = input.now ?? Date.now;

  return async publication => {
    publication.signal.throwIfAborted();
    const { occurrence, record, evidence } = publication;
    const accepted = record.snapshot.acceptedResponse;
    const descriptorBytes = record.descriptorBytes;
    const target = evidence.result.namespace;
    if (
      occurrence.task.id !== input.reference.taskId
      || occurrence.run.id !== input.reference.taskRunId
      || occurrence.run.taskId !== occurrence.task.id
      || occurrence.task.agentId !== evidence.result.signerAgentId
      || occurrence.task.contentNamespaceId !== target.namespaceId
      || occurrence.task.cryptoObjectId !== input.reference.inputObjectId
      || record.snapshot.state !== "running"
      || record.snapshot.requestId !== input.reference.authorizationRequestId
      || record.snapshot.workId !== occurrence.run.id
      || record.expectedPolicyRevision !== input.reference.policyRevision
      || evidence.requestId !== input.reference.authorizationRequestId
      || evidence.workId !== occurrence.run.id
      || evidence.policyRevision !== input.reference.policyRevision
      || evidence.result.taskId !== occurrence.task.id
      || evidence.result.taskRunId !== occurrence.run.id
      || evidence.result.contentRevision !== 1
      || evidence.result.objectId !== input.reference.resultObjectId
      || accepted === null
      || accepted.kind !== "runtime"
      || descriptorBytes === null
    ) {
      throw new TypeError("Protected Task result publication coordinates disagree");
    }
    const request = dependencies.decodeRequest(
      descriptorBytes,
    );
    if (request === null) {
      throw new TypeError("Protected Task result request is unavailable");
    }
    try {
      const currentTime = now();
      if (!Number.isSafeInteger(currentTime) || currentTime < 0) {
        throw new TypeError("Protected Task result clock is invalid");
      }
      const handle = await dependencies.verifyCryptoHandle(input.restricted);
      const storage = dependencies.createStorage(handle);
      const subject = Object.freeze({
        userId: occurrence.task.requestorId,
        humanActorId: accepted.issuingHumanId,
        deviceId: accepted.issuingDeviceId,
      });
      const coordinate = Object.freeze({
        kind: "run_result" as const,
        taskId: occurrence.task.id,
        taskRunId: occurrence.run.id,
        contentRevision: 1 as const,
      });
      const resolveAuthority = dependencies.createPhaseAuthority({
        occurrence,
        record,
        request,
        subject,
        runner: input.product.canonicalRunner,
        restricted: input.restricted,
        crypto: input.crypto,
        serverScope: input.serverScope,
        coordinate,
        now,
        signal: publication.signal,
      });
      const expected = Object.freeze({
        requesterHumanId: subject.humanActorId,
        namespaceId: target.namespaceId,
      });
      const authority = await resolveAuthority(expected);
      if (authority === null) {
        throw new ClassifiedDataOperationError(
          "authority",
          "Protected Task result authority is unavailable",
        );
      }
      const assertCurrentTaskAuthority = async (): Promise<void> => {
        publication.signal.throwIfAborted();
        const current = await resolveAuthority(expected);
        if (current === null || !sameAuthority(current, authority)) {
          throw new ClassifiedDataOperationError(
            "stale",
            "Protected Task result authority changed",
          );
        }
      };
      const domain = matchingResultDomain({
        domains: publication.domains,
        domainId: target.domainId,
      });
      const runtime = await storage.getAgentRuntimeAtomicState(
        occurrence.task.agentId,
      );
      let agentAuthorizationRevision: number;
      let runtimeGeneration: number;
      try {
        if (runtime === null
          || runtime.runtime.agentId !== occurrence.task.agentId) {
          throw new ClassifiedDataOperationError(
            "authority",
            "Protected Task Runtime signer is unavailable",
          );
        }
        agentAuthorizationRevision = runtime.runtime.authorizationRevision;
        runtimeGeneration = runtime.runtime.runtimeGeneration;
      } finally {
        destroyDetachedBytes(runtime);
      }
      const prepared = await dependencies.withSignerHistory({
        handle,
        crypto: input.crypto,
        agentId: occurrence.task.agentId,
        domainId: domain.domainId,
        domainEpoch: domain.domainKeyGeneration,
        expectedAgentAuthorizationRevision:
          agentAuthorizationRevision,
        expectedRuntimeGeneration: runtimeGeneration,
        use: async history => {
          const signed = await dependencies.withSigner({
            crypto: input.crypto,
            storage,
            evidence,
            domain,
            expectedAgentAuthorizationRevision:
              agentAuthorizationRevision,
            resolveHistoricalRuntimeCommitter:
              history.resolveHistoricalRuntimeCommitter,
            resolveHistoricalSignerPublicationManager:
              history.resolveHistoricalSignerPublicationManager,
            execute: signer => dependencies.prepare({
              restricted: input.restricted,
              serverScope: input.serverScope,
              domains: publication.domains,
              signal: publication.signal,
              assertCurrentTaskAuthority,
              crypto: input.crypto,
              evidence,
              payload: publication.payload,
              authority,
              createdAt: currentTime,
              agentAuthorizationRevision:
                signer.agentAuthorizationRevision,
              runtime: signer.runtime,
              signerPublication: signer.signerPublication,
              resolveHistoricalSignerPublicationManager:
                history.resolveHistoricalSignerPublicationManager,
            }),
          });
          if (signed.status !== "executed") {
            throw new ClassifiedDataOperationError(
              "authority",
              "Protected Task Runtime signer is unavailable",
            );
          }
          return signed.value;
        },
      });

      // Runtime secrets and their historical-key callbacks are gone before any
      // product terminal CAS. Only the opaque signed preparation crosses here.
      publication.signal.throwIfAborted();
      const history = dependencies.createHumanSignerHistory(
        handle,
        input.crypto,
      );
      const repository = dependencies.createRepository({
        product: {
          handle: input.product.handle,
          resolveCurrentAuthority: resolveAuthority,
        },
        crypto: {
          handle,
          crypto: input.crypto,
          resolveCurrentAuthority: async currentCoordinate =>
            currentCoordinate.kind === "run_result"
              && currentCoordinate.taskId === coordinate.taskId
              && currentCoordinate.taskRunId === coordinate.taskRunId
              && currentCoordinate.contentRevision === coordinate.contentRevision
              ? resolveAuthority(expected)
              : null,
          resolveHistoricalAgentSignerAuthority:
            history.resolveAgentRuntimeSignerManager,
          resolveHistoricalHumanDeviceSigningPublicKey:
            humanDeviceSigningKeyResolver(handle),
        },
        content: {
          prepareProtected: () => Promise.reject(new ClassifiedDataOperationError(
            "unsupported",
            "Unprepared protected Task result publication is unsupported",
          )),
          publishProduct: () => Promise.reject(new ClassifiedDataOperationError(
            "unsupported",
            "Unprepared protected Task product publication is unsupported",
          )),
          readOrdinary: () => Promise.reject(new ClassifiedDataOperationError(
            "unsupported",
            "Ordinary Task result reads are outside protected publication",
          )),
          readProtected: () => Promise.reject(new ClassifiedDataOperationError(
            "unsupported",
            "Protected Task result plaintext is unavailable to the server",
          )),
        },
      });
      const terminal = dependencies.createTerminalPorts(input.db);
      await dependencies.publish({
        repository,
        terminal: terminal.terminal,
        dualTerminal: terminal.dualTerminal,
        owner: input.owner,
        reference: input.reference,
        authority,
        prepared,
        evidence,
        signal: publication.signal,
        scheduleKind: occurrence.task.scheduleKind,
        completedAt: new Date(currentTime),
        ordinaryContent: Object.freeze({
          coordinate,
          payload: publication.payload,
        }),
      });
    } finally {
      dependencies.destroyRequest(request);
    }
  };
}
