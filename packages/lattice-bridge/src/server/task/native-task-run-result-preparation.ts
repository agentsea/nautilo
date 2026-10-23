import {
  PROTECTED_TASK_CANCELLED_RESULT, and, domainKeyHeads, eq, humanCryptoDevices, namespaceDomainKeyBindings, namespaceDomainKeyHeads,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import {
  accessRevision, assertAuthenticTaskRuntimeExecutionEvidence, authorizationRevision,
  assertAuthenticTaskRuntimeCancellationResultEvidence, prepareNativeTaskRuntimeCancellationResultObject,
  assertAuthenticTaskRuntimeTerminalMessageEvidence,
  assertAuthenticTaskRuntimeRunResultReadEvidence,
  type TaskRuntimeRunResultReadEvidence,
  type TaskRuntimeCancellationResultEvidence,
  type TaskRuntimeTerminalMessageEvidence,
  cryptoDomainId, namespaceGeneration, namespaceId, prepareNativeTaskRuntimeResultObject,
  type DomainForegroundSecretEntry,
} from "@nautilo/lattice-crypto";
import { createPreparedTaskRuntimeResultContentCryptoRevisionV1 } from "../../task/task-content-prepared-revision.ts";
import {
  deriveTaskContentCryptoObjectIdV1, TASK_RUN_RESULT_OBJECT_TYPE_V1,
  type PreparedTaskContentCryptoRevisionV1,
} from "../../task/task-content-repository.ts";
import { encodeTaskRunResultPayloadV1 } from "../../task/task-payload-v1.ts";
import type { PrepareTaskRuntimeRunResultInput } from "../../task/task-run-result-preparation.ts";
import type { NativeTaskNamespaceSource } from
  "./native-task-message-preparation.ts";
import {
  PostgresDomainKeyAuthorityRepository,
  type DomainForegroundNamespaceAuthorityInspectionV2,
} from "../delivery/postgres-domain-key-authority.ts";
import {
  cryptoTypedDb, executeTypedCryptoQuery,
  readCryptoStorageInteger, verifyCryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";

export type PrepareNativeTaskRuntimeRunResultInput =
  Omit<PrepareTaskRuntimeRunResultInput, "namespace"> & Readonly<{
    restricted: PostgresJsBridgeConnection;
    serverScope: string;
    domains: readonly DomainForegroundSecretEntry[];
    signal: AbortSignal;
    /** Reprove current Task/TaskRun, requester-private Namespace and policy in a short product transaction. */
    assertCurrentTaskAuthority(): Promise<void>;
  }>;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function destroyAuthority(authority: DomainForegroundNamespaceAuthorityInspectionV2): void {
  for (const bytes of [authority.namespaceHeadDigest, authority.namespacePublicationDigest,
    authority.namespacePublicationSetDigest, authority.namespaceAudienceFingerprint,
    authority.domainHeadDigest, authority.bundleDigest]) bytes.fill(0);
}

function copyNamespaceAuthority(value: DomainForegroundNamespaceAuthorityInspectionV2): DomainForegroundNamespaceAuthorityInspectionV2 {
  return { ...value,
    namespaceHeadDigest: Uint8Array.from(value.namespaceHeadDigest),
    namespacePublicationDigest: Uint8Array.from(value.namespacePublicationDigest),
    namespacePublicationSetDigest: Uint8Array.from(value.namespacePublicationSetDigest),
    namespaceAudienceFingerprint: Uint8Array.from(value.namespaceAudienceFingerprint),
    domainHeadDigest: Uint8Array.from(value.domainHeadDigest),
    bundleDigest: Uint8Array.from(value.bundleDigest),
  };
}

function sameAuthority(left: DomainForegroundNamespaceAuthorityInspectionV2, right: DomainForegroundNamespaceAuthorityInspectionV2): boolean {
  return left.namespaceId === right.namespaceId
    && left.namespaceAccessRevision === right.namespaceAccessRevision
    && left.namespaceKeyGeneration === right.namespaceKeyGeneration
    && left.domainId === right.domainId
    && left.domainKeyGeneration === right.domainKeyGeneration
    && left.domainAuthorizationRevision === right.domainAuthorizationRevision
    && left.bundleRevision === right.bundleRevision
    && sameBytes(left.namespaceHeadDigest, right.namespaceHeadDigest)
    && sameBytes(left.domainHeadDigest, right.domainHeadDigest)
    && sameBytes(left.bundleDigest, right.bundleDigest);
}

export type NativeTaskNamespaceSourceInput = Readonly<{
  restricted: PostgresJsBridgeConnection;
  crypto: PrepareNativeTaskRuntimeRunResultInput["crypto"];
  serverScope: string;
  evidence: PrepareNativeTaskRuntimeRunResultInput["evidence"];
  domains: readonly DomainForegroundSecretEntry[];
  namespaceId: string;
  requiredOperations: readonly ("decrypt" | "encrypt")[];
  signal: AbortSignal;
  assertCurrentTaskAuthority(): Promise<void>;
}>;

type ResultEvidence = PrepareNativeTaskRuntimeRunResultInput["evidence"]
  | TaskRuntimeCancellationResultEvidence;
type NamespaceEvidence = ResultEvidence | TaskRuntimeTerminalMessageEvidence
  | TaskRuntimeRunResultReadEvidence;

function assertNamespaceEvidence(evidence: NamespaceEvidence): void {
  if (evidence.purpose === "task.runtime.cancellation_result") {
    assertAuthenticTaskRuntimeCancellationResultEvidence(evidence);
  } else if (evidence.purpose === "task.runtime.terminal_message") {
    assertAuthenticTaskRuntimeTerminalMessageEvidence(evidence);
  } else if (evidence.purpose === "task.runtime.run_result_read") {
    assertAuthenticTaskRuntimeRunResultReadEvidence(evidence);
  } else {
    assertAuthenticTaskRuntimeExecutionEvidence(evidence);
  }
}

function assertResultEvidence(evidence: ResultEvidence): void {
  assertNamespaceEvidence(evidence);
}

/** Hold one exact live Task Namespace bundle only for the supplied callback. */
export async function withNativeTaskNamespaceSource<Value>(
  input: NativeTaskNamespaceSourceInput,
  use: (source: NativeTaskNamespaceSource) => Promise<Value>,
): Promise<Value> {
  assertAuthenticTaskRuntimeExecutionEvidence(input.evidence);
  return withNativeResultNamespaceSource(input, use);
}

export type NativeTaskTerminalMessageNamespaceSourceInput = Omit<
  NativeTaskNamespaceSourceInput,
  "evidence" | "namespaceId" | "requiredOperations"
> & Readonly<{ evidence: TaskRuntimeTerminalMessageEvidence }>;

/** Hold only the destination Namespace named by authentic terminal evidence. */
export async function withNativeTaskTerminalMessageNamespaceSource<Value>(
  input: NativeTaskTerminalMessageNamespaceSourceInput,
  use: (source: NativeTaskNamespaceSource) => Promise<Value>,
): Promise<Value> {
  assertAuthenticTaskRuntimeTerminalMessageEvidence(input.evidence);
  return withNativeResultNamespaceSource({
    ...input,
    namespaceId: input.evidence.message.namespaceId,
    requiredOperations: ["encrypt"],
  }, use);
}

export type NativeTaskRunResultMessageNamespaceSourceInput = Omit<
  NativeTaskNamespaceSourceInput, "evidence" | "namespaceId" | "requiredOperations"
> & Readonly<{ evidence: TaskRuntimeRunResultReadEvidence }>;

/** Only the independently granted raw Message write partition can open this bundle. */
export async function withNativeTaskRunResultMessageNamespaceSource<Value>(
  input: NativeTaskRunResultMessageNamespaceSourceInput,
  use: (source: NativeTaskNamespaceSource) => Promise<Value>,
): Promise<Value> {
  assertAuthenticTaskRuntimeRunResultReadEvidence(input.evidence);
  const write = input.evidence.messageWrite;
  if (write === undefined || write === null) throw new TypeError("Task result read has no Message write authority");
  return withNativeResultNamespaceSource({ ...input,
    namespaceId: write.namespace.namespaceId, requiredOperations: ["encrypt"],
  }, use);
}

async function withNativeResultNamespaceSource<Value>(
  input: Omit<NativeTaskNamespaceSourceInput, "evidence"> & Readonly<{ evidence: NamespaceEvidence }>,
  use: (source: NativeTaskNamespaceSource) => Promise<Value>,
): Promise<Value> {
  if (input.evidence.purpose === "task.runtime.cancellation_result"
    && (input.requiredOperations.length !== 1 || input.requiredOperations[0] !== "encrypt"
      || input.namespaceId !== input.evidence.result.namespace.namespaceId)) {
    throw new TypeError("Cancellation custody can only publish its result Namespace");
  }
  if (input.evidence.purpose === "task.runtime.terminal_message"
    && (input.requiredOperations.length !== 1
      || input.requiredOperations[0] !== "encrypt"
      || input.namespaceId !== input.evidence.message.namespaceId)) {
    throw new TypeError("Terminal Message custody can only publish its destination Namespace");
  }
  const assertActive = (): void => {
    input.signal.throwIfAborted();
    assertNamespaceEvidence(input.evidence);
  };
  assertActive();
  const write = input.evidence.purpose === "task.runtime.run_result_read"
    ? input.evidence.messageWrite : undefined;
  if (input.evidence.purpose === "task.runtime.run_result_read"
    && (write === undefined || write === null || input.namespaceId !== write.namespace.namespaceId
      || input.requiredOperations.length !== 1 || input.requiredOperations[0] !== "encrypt")) {
    throw new TypeError("Task result read custody can only publish its independently granted Message Namespace");
  }
  const namespaceRequirements = input.evidence.purpose === "task.runtime.run_result_read"
    ? [write!.namespace] : input.evidence.namespaceRequirements;
  const requirements = namespaceRequirements.filter(entry =>
    entry.namespaceId === input.namespaceId);
  const requirement = requirements[0];
  if (requirements.length !== 1 || requirement === undefined
    || input.requiredOperations.some(operation =>
      !requirement.operations.some(granted => granted === operation))) {
    throw new TypeError("Native Task Namespace grant is unavailable");
  }
  const grantedDomains = input.evidence.purpose === "task.runtime.run_result_read"
    ? [write!.domain] : input.evidence.domainRequirements;
  const domainRequirements = grantedDomains.filter(entry =>
    entry.domainId === requirement.domainId);
  const domainRequirement = domainRequirements[0];
  const domains = input.domains.filter(entry =>
    entry.domainId === requirement.domainId);
  const domain = domains[0];
  if (domainRequirements.length !== 1 || domainRequirement === undefined
    || domains.length !== 1 || domain === undefined
    || domain.sourceNamespaceId !== domainRequirement.sourceNamespaceId
    || domain.keyClass !== "ai"
    || domain.domainKeyGeneration !== domainRequirement.domainKeyGeneration
    || domain.authorizationRevision !== domainRequirement.authorizationRevision
    || domain.participantCount !== domainRequirement.participantCount
    || !sameBytes(domain.participantDigest, domainRequirement.participantDigest)
    || !sameBytes(domain.headDigest, domainRequirement.headDigest)) {
    throw new TypeError("Native Task Namespace Domain grant is unavailable");
  }
  let namespace: DomainForegroundNamespaceAuthorityInspectionV2 | undefined;
  const owned: Uint8Array[] = [];
  try {
    await input.assertCurrentTaskAuthority();
    assertActive();
    const handle = await verifyCryptoPostgresHandle(input.restricted);
    const repository = new PostgresDomainKeyAuthorityRepository(
      input.restricted,
      input.crypto,
      input.serverScope,
    );
    const inspected = await repository.inspectForegroundNamespaceAuthority({
      namespaceId: input.namespaceId,
      keyClass: "ai",
    });
    if (inspected.status !== "ready") {
      throw new TypeError("Native Task Namespace is unavailable");
    }
    namespace = copyNamespaceAuthority(inspected);
    if (namespace.namespaceId !== input.namespaceId
      || namespace.namespaceAccessRevision
        !== requirement.expectedAccessRevision
      || namespace.domainId !== domain.domainId
      || namespace.domainKeyGeneration !== domain.domainKeyGeneration
      || namespace.domainAuthorizationRevision !== domain.authorizationRevision
      || !sameBytes(namespace.domainHeadDigest, domain.headDigest)) {
      throw new TypeError("Native Task Namespace authority changed");
    }
    const assertCurrentDomain = async (): Promise<void> => {
      const rows = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({
        domain_id: domainKeyHeads.domainId,
        domain_key_generation: domainKeyHeads.domainKeyGeneration,
        authorization_revision: domainKeyHeads.authorizationRevision,
        head_digest: domainKeyHeads.headDigest,
        participant_digest: domainKeyHeads.participantDigest,
        participant_count: domainKeyHeads.participantCount,
      }).from(domainKeyHeads).where(and(
        eq(domainKeyHeads.domainId, domain.domainId),
        eq(domainKeyHeads.keyClass, "ai"),
      )).limit(2));
      const head = rows[0];
      assertActive();
      if (rows.length !== 1 || head === undefined
        || head.domain_id !== domain.domainId
        || readCryptoStorageInteger(head, "domain_key_generation")
          !== domain.domainKeyGeneration
        || readCryptoStorageInteger(head, "authorization_revision")
          !== domain.authorizationRevision
        || readCryptoStorageInteger(head, "participant_count")
          !== domain.participantCount
        || !(head.head_digest instanceof Uint8Array)
        || !sameBytes(head.head_digest, domain.headDigest)
        || !(head.participant_digest instanceof Uint8Array)
        || !sameBytes(head.participant_digest, domain.participantDigest)) {
        throw new TypeError("Native Task Namespace Domain authority changed");
      }
    };
    await assertCurrentDomain();
    const rows = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({
      binding_bytes: namespaceDomainKeyBindings.bindingBytes,
      binding_digest: namespaceDomainKeyBindings.bindingDigest,
      signing_public_key: humanCryptoDevices.signingPublicKey,
    }).from(namespaceDomainKeyHeads).innerJoin(namespaceDomainKeyBindings,
      eq(namespaceDomainKeyBindings.operationId,
        namespaceDomainKeyHeads.bindingOperationId))
      .innerJoin(humanCryptoDevices, and(
        eq(humanCryptoDevices.deviceId, namespaceDomainKeyBindings.issuerDeviceId),
        eq(humanCryptoDevices.humanId, namespaceDomainKeyBindings.issuerHumanId),
        eq(humanCryptoDevices.deviceGeneration,
          namespaceDomainKeyBindings.issuerDeviceSigningGeneration),
      )).where(and(
        eq(namespaceDomainKeyHeads.namespaceId, namespace.namespaceId),
        eq(namespaceDomainKeyHeads.keyClass, "ai"),
        eq(namespaceDomainKeyHeads.bindingDigest, namespace.bundleDigest),
        eq(namespaceDomainKeyHeads.domainId, domain.domainId),
        eq(namespaceDomainKeyHeads.domainKeyGeneration,
          domain.domainKeyGeneration),
        eq(namespaceDomainKeyHeads.domainAuthorizationRevision,
          domain.authorizationRevision),
      )).limit(2));
    const row = rows[0];
    if (rows.length !== 1 || row === undefined
      || !(row.binding_bytes instanceof Uint8Array)
      || !(row.binding_digest instanceof Uint8Array)
      || !(row.signing_public_key instanceof Uint8Array)
      || !sameBytes(row.binding_digest, namespace.bundleDigest)) {
      throw new TypeError("Native Task Namespace binding is unavailable");
    }
    const bindingBytes = Uint8Array.from(row.binding_bytes);
    const signingKey = Uint8Array.from(row.signing_public_key);
    owned.push(bindingBytes, signingKey);
    const source: NativeTaskNamespaceSource = {
      bindingBytes,
      expectedBindingDigest: namespace.bundleDigest,
      issuerSigningPublicKey: signingKey,
      domainKey: domain.domainKey,
      current: {
        serverId: input.serverScope,
        cryptoDomainId: cryptoDomainId(domain.domainId),
        participantDigest: domain.participantDigest,
        participantCount: domain.participantCount,
        keyClass: "ai",
        domainKeyGeneration: domain.domainKeyGeneration,
        domainAuthorizationRevision:
          authorizationRevision(domain.authorizationRevision),
        domainHeadDigest: domain.headDigest,
        namespaceId: namespaceId(namespace.namespaceId),
        namespaceAccessRevision:
          accessRevision(namespace.namespaceAccessRevision),
        namespaceCurrentGeneration:
          namespaceGeneration(namespace.namespaceKeyGeneration),
        bundleRevision: namespace.bundleRevision,
        retainedAuthoritySetDigest: namespace.namespaceHeadDigest,
      },
    };
    assertActive();
    const value = await use(source);
    await input.assertCurrentTaskAuthority();
    assertActive();
    const reinspection = await repository.inspectForegroundNamespaceAuthority({
      namespaceId: input.namespaceId,
      keyClass: "ai",
    });
    if (reinspection.status !== "ready") {
      throw new TypeError("Native Task Namespace is unavailable");
    }
    const current = copyNamespaceAuthority(reinspection);
    try {
      if (!sameAuthority(namespace, current)) {
        throw new TypeError("Native Task Namespace authority changed");
      }
    } finally {
      destroyAuthority(current);
    }
    await assertCurrentDomain();
    assertActive();
    return value;
  } finally {
    owned.forEach(bytes => bytes.fill(0));
    if (namespace !== undefined) destroyAuthority(namespace);
  }
}

/** Prepare a native, Agent-signed Task result without storing plaintext or publishing it. */
export async function prepareNativeTaskRuntimeRunResult(
  input: PrepareNativeTaskRuntimeRunResultInput,
): Promise<PreparedTaskContentCryptoRevisionV1> {
  assertAuthenticTaskRuntimeExecutionEvidence(input.evidence);
  return prepareNativeResult(input);
}

export type PrepareNativeTaskRuntimeCancelledRunResultInput =
  Omit<PrepareNativeTaskRuntimeRunResultInput, "evidence" | "payload"> & Readonly<{
    evidence: TaskRuntimeCancellationResultEvidence;
  }>;

/** Prepare the fixed cancellation receipt without opening the Task definition. */
export async function prepareNativeTaskRuntimeCancelledRunResult(
  input: PrepareNativeTaskRuntimeCancelledRunResultInput,
): Promise<PreparedTaskContentCryptoRevisionV1> {
  assertAuthenticTaskRuntimeCancellationResultEvidence(input.evidence);
  return prepareNativeResult({ ...input,
    payload: { formatVersion: 1, resultText: PROTECTED_TASK_CANCELLED_RESULT, lastError: null },
  });
}

async function prepareNativeResult(
  input: Omit<PrepareNativeTaskRuntimeRunResultInput, "evidence"> & Readonly<{ evidence: ResultEvidence }>,
): Promise<PreparedTaskContentCryptoRevisionV1> {
  const assertActive = (): void => {
    input.signal.throwIfAborted();
    assertResultEvidence(input.evidence);
  };
  assertActive();
  const evidence = input.evidence;
  const result = evidence.result;
  const target = result.namespace;
  const coordinate = Object.freeze({ kind: "run_result" as const,
    taskId: result.taskId, taskRunId: result.taskRunId, contentRevision: result.contentRevision });
  const authority = Object.freeze({ ...input.authority });
  const domains = input.domains.filter((entry) => entry.domainId === target.domainId);
  const required = evidence.domainRequirements.filter((entry) => entry.domainId === target.domainId);
  const domain = domains[0];
  const requirement = required[0];
  if (deriveTaskContentCryptoObjectIdV1(coordinate) !== result.objectId
    || result.taskRunId !== evidence.workId
    || authority.keyClass !== "ai"
    || authority.namespaceId !== target.namespaceId || authority.domainId !== target.domainId
    || authority.expectedAccessRevision !== target.expectedAccessRevision
    || authority.expectedPolicyRevision !== target.expectedPolicyRevision
    || evidence.policyRevision !== target.expectedPolicyRevision
    || domains.length !== 1 || domain === undefined || required.length !== 1 || requirement === undefined
    || domain.sourceNamespaceId !== requirement.sourceNamespaceId || domain.keyClass !== "ai"
    || domain.domainKeyGeneration !== requirement.domainKeyGeneration
    || domain.authorizationRevision !== requirement.authorizationRevision
    || domain.participantCount !== requirement.participantCount
    || !sameBytes(domain.participantDigest, requirement.participantDigest)
    || !sameBytes(domain.headDigest, requirement.headDigest)) {
    throw new TypeError("Native Task result coordinate or authority disagrees");
  }
  // Canonicalize and own the output before the first asynchronous boundary.
  const plaintext = encodeTaskRunResultPayloadV1(input.payload);
  try {
    return await withNativeResultNamespaceSource({
      restricted: input.restricted,
      crypto: input.crypto,
      serverScope: input.serverScope,
      evidence,
      domains: input.domains,
      namespaceId: target.namespaceId,
      requiredOperations: ["encrypt"],
      signal: input.signal,
      assertCurrentTaskAuthority: input.assertCurrentTaskAuthority,
    }, async namespace => {
      assertActive();
      const common = {
          plaintext,
          objectType: TASK_RUN_RESULT_OBJECT_TYPE_V1,
          createdAt: input.createdAt,
          agentAuthorizationRevision: input.agentAuthorizationRevision,
          runtime: input.runtime,
          signerPublication: input.signerPublication,
          ...(input.temporarySigner === undefined ? {} : {
            temporarySigner: input.temporarySigner,
          }),
          resolveHistoricalSignerPublicationManager:
            input.resolveHistoricalSignerPublicationManager,
          namespace,
      };
      const prepared = evidence.purpose === "task.runtime.cancellation_result"
        ? await prepareNativeTaskRuntimeCancellationResultObject(input.crypto, { ...common, evidence })
        : await prepareNativeTaskRuntimeResultObject(input.crypto, { ...common, evidence });
      return createPreparedTaskRuntimeResultContentCryptoRevisionV1({
        coordinate,
        authority,
        prepared,
      });
    });
  } finally {
    plaintext.fill(0);
  }
}
