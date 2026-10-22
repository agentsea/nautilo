import {
  acquireEncryptionConsumptionFence, and, asc, backgroundCryptoAuthorizationRequests,
  eq, humanCryptoCustodies, humanCryptoDeviceGroupHeads, humanCryptoDevices, inArray,
  jobs, protectedTaskDefinitionSupportsPolicy, protectedTaskRunWakeJobId, taskRuns, tasks,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import type { TaskContentAuthorityV1 } from "../../task/task-content-authority-v1.ts";
import { assertTaskContentCoordinateV1, type TaskContentCoordinateV1, type TaskContentRevisionStateV1 } from "../../task/task-content-repository.ts";
import { PostgresDeviceAdmissionRepository, type DeviceAdmissionStatus } from "../device/postgres-device-admission-repository.ts";
import { PostgresNamespaceProductAuthority } from "../delivery/postgres-namespace-product-authority.ts";
import { PostgresDomainKeyAuthorityRepository } from "../delivery/postgres-domain-key-authority.ts";
import { verifyConversationProductPostgresHandle, type ConversationProductCanonicalTransactionRunner } from "../message/postgres-conversation-product-store.ts";
import { cryptoTypedDb, executeTypedCryptoQuery, verifyCryptoPostgresHandle, type CryptoPostgresHandle } from "../storage/postgres-lattice-storage.ts";
import { PostgresTaskContentProductStore } from "./postgres-task-content-product-store.ts";

export type HumanTaskMappedContentAuthorityInput = Readonly<{
  runner: ConversationProductCanonicalTransactionRunner;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverScope: string;
  coordinate: TaskContentCoordinateV1;
  sourceRoomId: string;
  expectedPolicyRevision: number;
  subject: Readonly<{ userId: string; humanActorId: string;
    admission: Extract<DeviceAdmissionStatus, { status: "admitted" }> }>;
  now?: () => number;
}>;
export type HeldHumanTaskMappedContentAuthority = Readonly<{
  state: TaskContentRevisionStateV1;
  currentAuthority: TaskContentAuthorityV1;
  expectedAgentId: string;
  namespaceKeyGeneration: number;
  handle: CryptoPostgresHandle;
  store: PostgresTaskContentProductStore;
  product: PostgresJsBridgeConnection;
  transaction: CanonicalTranscriptTx;
  assertCurrent(): void;
}>;
function borrow(executor: Pick<PostgresJsBridgeConnection, "query">): PostgresJsBridgeConnection {
  return { query: executor.query.bind(executor), transaction: use => use(executor), transactionOnce: use => use(executor) };
}
function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
function wipe(value: object): void {
  for (const bytes of Object.values(value)) if (bytes instanceof Uint8Array) bytes.fill(0);
}

/** No decryption: current Human metadata access held through an exact mapped-head repair. */
export async function withCurrentHumanTaskMappedContentAuthority<Value>(
  supplied: HumanTaskMappedContentAuthorityInput & Readonly<{
    use(context: HeldHumanTaskMappedContentAuthority): Promise<Value>;
  }>,
): Promise<Value | null> {
  const input = { ...supplied, coordinate: Object.freeze({ ...supplied.coordinate }),
    subject: { ...supplied.subject, admission: { ...supplied.subject.admission,
      headDigest: Uint8Array.from(supplied.subject.admission.headDigest) } } };
  assertTaskContentCoordinateV1(input.coordinate);
  const now = input.now ?? Date.now;
  const { subject, coordinate } = input;
  if (subject.admission.expiresAt <= now()) return null;
  try {
    return await input.runner.transaction(async (transaction, executor) => {
      const policy = await acquireEncryptionConsumptionFence(transaction);
      if (policy.mode === "plaintext_only" || policy.revision !== input.expectedPolicyRevision) return null;
      const [task] = await transaction.select({ id: tasks.id, ownerId: tasks.ownerId, requestorId: tasks.requestorId, agentId: tasks.agentId,
        contentNamespaceId: tasks.contentNamespaceId, contentRepresentation: tasks.contentRepresentation, cryptoMappingState: tasks.cryptoMappingState,
        fireLockId: tasks.fireLockId, status: tasks.status }).from(tasks).where(eq(tasks.id, coordinate.taskId)).for("update");
      if (task === undefined || task.ownerId !== subject.userId || task.requestorId !== subject.userId
        || task.contentNamespaceId === null || task.cryptoMappingState !== "verified"
        || !protectedTaskDefinitionSupportsPolicy(task.contentRepresentation, policy.mode)
        || task.fireLockId !== null || task.status === "running") return null;
      const runs = await transaction.select({ id: taskRuns.id, jobId: taskRuns.jobId, status: taskRuns.status })
        .from(taskRuns).where(eq(taskRuns.taskId, task.id)).orderBy(asc(taskRuns.id)).for("update");
      if (runs.some(run => run.status === "running")) return null;
      const jobIds = runs.flatMap(run => run.jobId === null ? [] : [run.jobId]);
      if (jobIds.length !== 0) {
        const currentJobs = await transaction.select({ status: jobs.status }).from(jobs)
          .where(inArray(jobs.id, jobIds)).orderBy(asc(jobs.id)).for("share");
        if (currentJobs.some(job => job.status === "queued" || job.status === "running")) return null;
      }
      const product = borrow(executor);
      return new PostgresNamespaceProductAuthority(product).withCurrentPrivateRoom({
        subjectUserId: subject.userId, subjectHumanId: subject.humanActorId,
        roomId: input.sourceRoomId, namespaceId: task.contentNamespaceId,
        use: async namespaceAuthority => {
          return input.restricted.transactionOnce(async cryptoTransaction => {
            const deviceRows = await executeTypedCryptoQuery(cryptoTransaction, cryptoTypedDb.select({ device_id: humanCryptoDevices.deviceId })
              .from(humanCryptoDevices).innerJoin(humanCryptoCustodies, eq(humanCryptoCustodies.humanId, humanCryptoDevices.humanId))
              .innerJoin(humanCryptoDeviceGroupHeads, eq(humanCryptoDeviceGroupHeads.humanId, humanCryptoDevices.humanId))
              .where(and(eq(humanCryptoDevices.deviceId, subject.admission.deviceId), eq(humanCryptoDevices.userId, subject.userId),
                eq(humanCryptoDevices.humanId, subject.humanActorId), eq(humanCryptoDevices.humanActorId, subject.humanActorId),
                eq(humanCryptoDevices.state, "active"), eq(humanCryptoCustodies.state, "active")))
              .for("share", { of: [humanCryptoDevices, humanCryptoCustodies, humanCryptoDeviceGroupHeads] }));
            if (deviceRows.length !== 1) return null;
            const restricted = borrow(cryptoTransaction);
            const handle = await verifyCryptoPostgresHandle(restricted);
            const device = await new PostgresDeviceAdmissionRepository(handle, input.crypto).currentAuthorityForDelegation({
              userId: subject.userId, humanActorId: subject.humanActorId, deviceId: subject.admission.deviceId });
            if (device === null) return null;
            try {
              const admitted = subject.admission;
              if (admitted.expiresAt <= now() || admitted.deviceGeneration !== device.deviceGeneration
                || admitted.serverInstanceId !== device.serverInstanceId || admitted.lineageGeneration !== device.lineageGeneration
                || admitted.epoch !== device.epoch || admitted.securityRevision !== device.securityRevision
                || !same(admitted.headDigest, device.headDigest)) return null;
              const repository = new PostgresDomainKeyAuthorityRepository(restricted, input.crypto, input.serverScope);
              const read = await repository.inspectMessageReadAuthority({ authority: namespaceAuthority,
                deviceId: device.deviceId, keyClass: "ai" });
              if (read.status !== "ready") return null;
              try {
                const namespace = await repository.inspectForegroundNamespaceAuthority({ namespaceId: task.contentNamespaceId!, keyClass: "ai" });
                if (namespace.status !== "ready") return null;
                try {
                  if (read.subjectHumanId !== subject.humanActorId || read.committerDeviceId !== device.deviceId
                    || read.committerDeviceSigningKeyGeneration !== device.deviceGeneration
                    || !same(read.committerDeviceSigningPublicKey, device.signingPublicKey)
                    || read.namespaceId !== namespace.namespaceId || read.namespaceAccessRevision !== namespace.namespaceAccessRevision
                    || read.namespaceKeyGeneration !== namespace.namespaceKeyGeneration
                    || !same(read.namespaceHeadDigest, namespace.namespaceHeadDigest)) return null;
                  const workIds = runs.flatMap(run => [run.id, protectedTaskRunWakeJobId(run.id)]);
                  if (workIds.length !== 0) {
                    const requests = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({
                      request_id: backgroundCryptoAuthorizationRequests.requestId,
                      state: backgroundCryptoAuthorizationRequests.state,
                    }).from(backgroundCryptoAuthorizationRequests)
                      .where(inArray(backgroundCryptoAuthorizationRequests.workId, workIds))
                      .orderBy(asc(backgroundCryptoAuthorizationRequests.requestId)).for("share"));
                    // Lock waiting rows too: accepting a grant must not cross a head repair.
                    if (requests.some(request => ["grant_ready", "claimed", "running", "publication_reconciliation", "provider_outcome_unknown"]
                      .includes(String(request.state)))) return null;
                  }
                  let active = true;
                  const assertCurrent = () => { if (!active || admitted.expiresAt <= now()) throw new TypeError("Human Task mapped authority is closed or expired"); };
                  const currentAuthority: TaskContentAuthorityV1 = Object.freeze({ authorityVersion: 1,
                    kind: "requester_private_namespace", keyClass: "ai", requesterHumanId: subject.humanActorId,
                    namespaceId: namespace.namespaceId, domainId: namespace.domainId,
                    expectedAccessRevision: namespace.namespaceAccessRevision, expectedPolicyRevision: policy.revision });
                  const store = new PostgresTaskContentProductStore(await verifyConversationProductPostgresHandle(product), expected => {
                    assertCurrent(); return expected.requesterHumanId === currentAuthority.requesterHumanId
                      && expected.namespaceId === currentAuthority.namespaceId ? currentAuthority : null;
                  });
                  try {
                    const state = await store.getRevision(coordinate);
                    if (state === null) return null;
                    const value = await input.use({ state, currentAuthority, expectedAgentId: task.agentId, namespaceKeyGeneration: namespace.namespaceKeyGeneration,
                      handle, store, product, transaction, assertCurrent });
                    assertCurrent(); return value;
                  } finally { active = false; }
                } finally { wipe(namespace); }
              } finally { wipe(read); }
            } finally { wipe(device); }
          }, { isolationLevel: "read committed" });
        },
      });
    }, { isolationLevel: "read committed" });
  } finally { subject.admission.headDigest.fill(0); }
}
