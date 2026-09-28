import {
  and, domainKeyHeads, eq, humanCryptoDevices, namespaceDomainKeyBindings, namespaceDomainKeyHeads,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import {
  accessRevision, assertAuthenticTaskRuntimeExecutionEvidence, authorizationRevision,
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
import {
  PostgresDomainKeyAuthorityRepository,
  type DomainForegroundNamespaceAuthorityInspectionV2,
} from "../delivery/postgres-domain-key-authority.ts";
import { cryptoTypedDb, executeTypedCryptoQuery, verifyCryptoPostgresHandle } from "../storage/postgres-lattice-storage.ts";

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

/** Prepare a native, Agent-signed Task result without storing plaintext or publishing it. */
export async function prepareNativeTaskRuntimeRunResult(
  input: PrepareNativeTaskRuntimeRunResultInput,
): Promise<PreparedTaskContentCryptoRevisionV1> {
  const assertActive = (): void => {
    input.signal.throwIfAborted();
    assertAuthenticTaskRuntimeExecutionEvidence(input.evidence);
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
  const owned: Uint8Array[] = [];
  let namespace: DomainForegroundNamespaceAuthorityInspectionV2 | undefined;
  try {
    await input.assertCurrentTaskAuthority();
    assertActive();
    const handle = await verifyCryptoPostgresHandle(input.restricted);
    const repository = new PostgresDomainKeyAuthorityRepository(input.restricted, input.crypto, input.serverScope);
    const inspected = await repository.inspectForegroundNamespaceAuthority({ namespaceId: target.namespaceId, keyClass: "ai" });
    if (inspected.status !== "ready") throw new TypeError("Native Task result Namespace is unavailable");
    namespace = inspected;
    if (namespace.namespaceId !== target.namespaceId
      || namespace.namespaceAccessRevision !== target.expectedAccessRevision
      || namespace.domainId !== domain.domainId
      || namespace.domainKeyGeneration !== domain.domainKeyGeneration
      || namespace.domainAuthorizationRevision !== domain.authorizationRevision
      || !sameBytes(namespace.domainHeadDigest, domain.headDigest)) {
      throw new TypeError("Native Task result Namespace authority changed");
    }
    const assertCurrentDomain = async (): Promise<void> => {
      const rows = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({
        domain_id: domainKeyHeads.domainId, domain_key_generation: domainKeyHeads.domainKeyGeneration,
        authorization_revision: domainKeyHeads.authorizationRevision, head_digest: domainKeyHeads.headDigest,
        participant_digest: domainKeyHeads.participantDigest, participant_count: domainKeyHeads.participantCount,
      }).from(domainKeyHeads).where(and(eq(domainKeyHeads.domainId, domain.domainId), eq(domainKeyHeads.keyClass, "ai"))).limit(2));
      const head = rows[0];
      assertActive();
      if (rows.length !== 1 || head === undefined || head.domain_id !== domain.domainId
        || head.domain_key_generation !== domain.domainKeyGeneration
        || head.authorization_revision !== domain.authorizationRevision
        || head.participant_count !== domain.participantCount
        || !(head.head_digest instanceof Uint8Array) || !sameBytes(head.head_digest, domain.headDigest)
        || !(head.participant_digest instanceof Uint8Array) || !sameBytes(head.participant_digest, domain.participantDigest)) {
        throw new TypeError("Native Task result Domain authority changed");
      }
    };
    await assertCurrentDomain();
    const rows = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({
      binding_bytes: namespaceDomainKeyBindings.bindingBytes,
      binding_digest: namespaceDomainKeyBindings.bindingDigest,
      signing_public_key: humanCryptoDevices.signingPublicKey,
    }).from(namespaceDomainKeyHeads).innerJoin(namespaceDomainKeyBindings,
      eq(namespaceDomainKeyBindings.operationId, namespaceDomainKeyHeads.bindingOperationId))
      .innerJoin(humanCryptoDevices, and(
        eq(humanCryptoDevices.deviceId, namespaceDomainKeyBindings.issuerDeviceId),
        eq(humanCryptoDevices.humanId, namespaceDomainKeyBindings.issuerHumanId),
        eq(humanCryptoDevices.deviceGeneration, namespaceDomainKeyBindings.issuerDeviceSigningGeneration),
      )).where(and(
        eq(namespaceDomainKeyHeads.namespaceId, namespace.namespaceId), eq(namespaceDomainKeyHeads.keyClass, "ai"),
        eq(namespaceDomainKeyHeads.bindingDigest, namespace.bundleDigest),
        eq(namespaceDomainKeyHeads.domainId, domain.domainId),
        eq(namespaceDomainKeyHeads.domainKeyGeneration, domain.domainKeyGeneration),
        eq(namespaceDomainKeyHeads.domainAuthorizationRevision, domain.authorizationRevision),
      )).limit(2));
    const row = rows[0];
    if (rows.length !== 1 || row === undefined || !(row.binding_bytes instanceof Uint8Array)
      || !(row.binding_digest instanceof Uint8Array) || !(row.signing_public_key instanceof Uint8Array)
      || !sameBytes(row.binding_digest, namespace.bundleDigest)) {
      throw new TypeError("Native Task result binding is unavailable");
    }
    const bindingBytes = row.binding_bytes.slice();
    const signingKey = row.signing_public_key.slice();
    owned.push(bindingBytes, signingKey);
    assertActive();
    const prepared = await prepareNativeTaskRuntimeResultObject(input.crypto, {
      evidence, plaintext, objectType: TASK_RUN_RESULT_OBJECT_TYPE_V1, createdAt: input.createdAt,
      agentAuthorizationRevision: input.agentAuthorizationRevision, runtime: input.runtime,
      signerPublication: input.signerPublication,
      resolveHistoricalSignerPublicationManager: input.resolveHistoricalSignerPublicationManager,
      namespace: { bindingBytes, expectedBindingDigest: namespace.bundleDigest,
        issuerSigningPublicKey: signingKey, domainKey: domain.domainKey,
        current: { serverId: input.serverScope, cryptoDomainId: cryptoDomainId(domain.domainId),
          participantDigest: domain.participantDigest, participantCount: domain.participantCount, keyClass: "ai",
          domainKeyGeneration: domain.domainKeyGeneration, domainAuthorizationRevision: authorizationRevision(domain.authorizationRevision),
          domainHeadDigest: domain.headDigest, namespaceId: namespaceId(namespace.namespaceId),
          namespaceAccessRevision: accessRevision(namespace.namespaceAccessRevision),
          namespaceCurrentGeneration: namespaceGeneration(namespace.namespaceKeyGeneration),
          bundleRevision: namespace.bundleRevision, retainedAuthoritySetDigest: namespace.namespaceHeadDigest } },
    });
    await input.assertCurrentTaskAuthority();
    assertActive();
    const current = await repository.inspectForegroundNamespaceAuthority({ namespaceId: target.namespaceId, keyClass: "ai" });
    if (current.status !== "ready") throw new TypeError("Native Task result Namespace is unavailable");
    try {
      if (!sameAuthority(namespace, current)) throw new TypeError("Native Task result Namespace authority changed");
    } finally { destroyAuthority(current); }
    await assertCurrentDomain();
    assertActive();
    return createPreparedTaskRuntimeResultContentCryptoRevisionV1({ coordinate, authority, prepared });
  } finally {
    plaintext.fill(0);
    owned.forEach((bytes) => bytes.fill(0));
    if (namespace !== undefined) destroyAuthority(namespace);
  }
}
