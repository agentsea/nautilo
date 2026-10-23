import { parseProtectedTaskCodexSelection } from "./protected-task-codex-selection";
import { parseProtectedTaskHermesSelection } from "./protected-task-hermes-selection";
import { parseProtectedTaskOpenCodeSelection } from "./protected-task-opencode-selection";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  acquireEncryptionPublicationFence, getEncryptionTransitionPolicy,
  lockProtectedTaskForegroundCreationIdentity, eq, rooms,
  type PostgresJsBridgeConnection, type PostgresJsBridgeRow, type PostgresJsBridgeScalar,
} from "@nautilo/db";
import { ClassifiedDataOperationError, type RequesterPrivateNamespaceFactV1,
  type TaskContentAuthorityV1 } from "@nautilo/lattice-bridge";
import { PostgresDomainKeyAuthorityRepository, PostgresNamespaceProductAuthority,
  type DomainKeyV2LiveShadowCurrentAuthority } from "@nautilo/lattice-bridge/server";
import { createProtectedTaskCreationAdmissionV1, type ProtectedTaskCreationResolutionInputV1 } from "@nautilo/runtime";
import { createProtectedTaskRequesterPrivateRoomResolver } from "./protected-task-requester-private-room";
import { createProtectedTaskForegroundCreationPublication } from "./protected-task-foreground-creation-publication";
import { createProtectedTaskForegroundUpdatePublication } from "./protected-task-foreground-update-publication";
import type { ProtectedTaskForegroundCreationContext } from "./protected-task-foreground-creation-context";
import type { ForegroundAgentEntityCryptoInvocation } from "@nautilo/lattice-bridge";
import type { ResolveCurrentDeviceWrappedAgentObjectAccessGenesisSetAuthorization } from "@nautilo/lattice-crypto";
import { parseClaudeTaskExecutionMetadata } from "../claude/task-execution-route";

type Publication = Parameters<typeof createProtectedTaskForegroundCreationPublication>[0];
type ProductLoan = Parameters<ProtectedTaskForegroundCreationContext["withProduct"]>[0];
export type TaskDefinitionProductLoan = Readonly<{
  transaction: ProductLoan["transaction"];
  product: PostgresJsBridgeConnection;
  assertCurrent(): Promise<void>;
  resolveCurrentForegroundEntityObjectWrite:
    ResolveCurrentDeviceWrappedAgentObjectAccessGenesisSetAuthorization;
}>;
type TaskDefinitionAuthorization = Readonly<{
  authority: TaskContentAuthorityV1;
  entities: ForegroundAgentEntityCryptoInvocation;
  publication: Readonly<{
    operationId: string;
    grantId: string;
    grantDigest: Uint8Array;
    recipientKeyId: string;
    taskDefinitionForegroundAuthorizationBytes?: Uint8Array | undefined;
  }>;
  resolveCurrentForegroundDefinitionAuthorization:
    ResolveCurrentDeviceWrappedAgentObjectAccessGenesisSetAuthorization;
  assertCurrent(): Promise<void>;
}>;

function unavailable(): never {
  throw new ClassifiedDataOperationError("authority", "Protected Task creation foreground authority is unavailable");
}

/** The foreground's real grant owns creation. Every tool call borrows the
 * caller's existing canonical product transaction, including return binding. */
export function createProtectedTaskForegroundCreationOwner(input: Omit<Publication, "withCurrentProduct"> & Readonly<{
  serverScope: string;
  restricted: PostgresJsBridgeConnection;
  representation: "dual" | "protected";
  subject: Readonly<{ userId: string; humanId: string; agentId: string; roomId: string;
    policyRevision: number; namespaceIds: readonly string[] }>;
  assertCurrentForeground(): Promise<void>;
  createCurrentAuthority(product: PostgresJsBridgeConnection): Promise<DomainKeyV2LiveShadowCurrentAuthority | null>;
  authorizeTaskDefinition?<Value>(input: Readonly<{
    taskId: string;
    taskExecutorAgentId: string;
    operation: "create" | "update";
    targetContentRevision: number;
    operationId: string;
    workDescriptorDigest: Uint8Array;
    withCurrentProduct<Value>(
      use: (current: TaskDefinitionProductLoan | null) => Promise<Value>,
    ): Promise<Value>;
    use(authorization: TaskDefinitionAuthorization): Promise<Value>;
  }>): Promise<Value>;
}>) {
  type Loan = Readonly<{ taskId: string; transaction: ProductLoan["transaction"]; executor: ProductLoan["executor"];
    product: PostgresJsBridgeConnection; authority: DomainKeyV2LiveShadowCurrentAuthority;
    assertCurrent(): Promise<void>;
    readPolicy(): ReturnType<typeof getEncryptionTransitionPolicy> }>;
  const loans = new AsyncLocalStorage<Loan>();
  const taskAuthorizations = new AsyncLocalStorage<TaskDefinitionAuthorization>();
  let disposed = false;
  const assertLive = () => {
    input.entities.signal.throwIfAborted();
    if (disposed) unavailable();
  };
  const current = (): Loan => {
    assertLive();
    const loan = loans.getStore();
    if (loan === undefined) unavailable();
    return loan;
  };
  const currentTaskAuthorization = (): TaskDefinitionAuthorization | null =>
    taskAuthorizations.getStore() ?? null;
  const assertCurrent = async () => {
    assertLive();
    const loan = loans.getStore();
    if (loan === undefined) await input.assertCurrentForeground();
    else await loan.assertCurrent();
    await currentTaskAuthorization()?.assertCurrent();
    assertLive();
  };
  const privateFact = async (request: Pick<ProtectedTaskCreationResolutionInputV1, "requestorId" | "agentId">,
    expectedNamespaceId?: string, taskExecutorAgentId = request.agentId): Promise<RequesterPrivateNamespaceFactV1> => {
    const loan = current();
    if (request.requestorId !== input.subject.userId || request.agentId !== input.subject.agentId) unavailable();
    await loan.assertCurrent();
    const room = await createProtectedTaskRequesterPrivateRoomResolver(loan.transaction)(
      request.requestorId, taskExecutorAgentId, expectedNamespaceId);
    const taskAuthorization = currentTaskAuthorization();
    if (room === null || (!input.subject.namespaceIds.includes(room.namespaceId)
      && taskAuthorization?.authority.namespaceId !== room.namespaceId)) {
      return { status: "unavailable", reason: "requester_private_namespace_unauthorized" };
    }
    if (taskAuthorization !== null) {
      await taskAuthorization.assertCurrent();
      const authority = taskAuthorization.authority;
      if (authority.requesterHumanId !== input.subject.humanId
        || authority.namespaceId !== room.namespaceId) {
        return { status: "unavailable", reason: "requester_private_namespace_unauthorized" };
      }
      return Object.freeze({ status: "authorized" as const,
        subjectHumanId: authority.requesterHumanId,
        namespaceId: authority.namespaceId,
        domainId: authority.domainId,
        accessRevision: authority.expectedAccessRevision,
        policyRevision: authority.expectedPolicyRevision });
    }
    const fact = await new PostgresNamespaceProductAuthority(loan.product).withCurrentPrivateRoom({
      subjectUserId: input.subject.userId, subjectHumanId: input.subject.humanId,
      roomId: room.roomId, namespaceId: room.namespaceId,
      use: async () => {
        const domain = await new PostgresDomainKeyAuthorityRepository(input.restricted,
          input.crypto, input.serverScope).inspectForegroundNamespaceAuthority({ namespaceId: room.namespaceId, keyClass: "ai" });
        if (domain.status !== "ready") return null;
        return Object.freeze({ status: "authorized" as const, subjectHumanId: input.subject.humanId,
          namespaceId: room.namespaceId, domainId: domain.domainId,
          accessRevision: domain.namespaceAccessRevision, policyRevision: input.subject.policyRevision });
      },
    });
    await loan.assertCurrent();
    return fact ?? { status: "unavailable", reason: "authority_stale" };
  };
  const admission = createProtectedTaskCreationAdmissionV1({
    resolveRequesterPrivateNamespace: privateFact,
    resolveExecutionShape: async request => {
      const loan = current();
      await loan.assertCurrent();
      if (request.requestorId !== input.subject.userId || request.agentId !== input.subject.agentId
        || request.callingRoomId !== input.subject.roomId) unavailable();
      const roomId = request.targetRoomId ?? request.callingRoomId;
      const [room] = roomId === null ? [] : await loan.transaction.select({ type: rooms.type, namespaceId: rooms.namespaceId })
        .from(rooms).where(eq(rooms.id, roomId)).limit(1);
      if (roomId !== null && (room === undefined || !input.subject.namespaceIds.includes(room.namespaceId))) {
        return { status: "unavailable", reason: "execution_namespace_unavailable" };
      }
      const conversation = request.targetChat === "orphan" ? "orphan" : room?.type;
      if (conversation === undefined || !["orphan", "private", "group", "public", "open", "dm"].includes(conversation)) {
        return { status: "unavailable", reason: "task_shape_unsupported" };
      }
      const execution = request.operationalMetadata["execution"];
      const executor = execution === undefined ? "native" as const
        : (parseClaudeTaskExecutionMetadata({ execution }) !== null
          || parseProtectedTaskCodexSelection({ execution }) !== null
          || parseProtectedTaskHermesSelection({ execution }) !== null
          || parseProtectedTaskOpenCodeSelection({ execution }) !== null) ? "external_harness" as const : null;
      if (executor === null) return { status: "unavailable", reason: "task_shape_unsupported" };
      return { status: "resolved", shape: {
        conversation: conversation as "orphan" | "private" | "group" | "public" | "open" | "dm",
        memory: request.useScope ? "scope" : request.preset === "in_private_namespace" ? "private_wide" : "namespace",
        executor,
      } };
    },
  });
  const useEntity: ForegroundAgentEntityCryptoInvocation["use"] = request =>
    (currentTaskAuthorization()?.entities ?? input.entities).use(request);
  const useCurrentEntitySet: ForegroundAgentEntityCryptoInvocation["useCurrentSet"] = request =>
    (currentTaskAuthorization()?.entities ?? input.entities).useCurrentSet(request);
  const entities: ForegroundAgentEntityCryptoInvocation = Object.freeze({
    get signal() {
      return currentTaskAuthorization()?.entities.signal ?? input.entities.signal;
    },
    use: useEntity,
    useCurrentSet: useCurrentEntitySet,
  });
  const publicationCoordinates = Object.freeze({
    get operationId() {
      return currentTaskAuthorization()?.publication.operationId
        ?? input.publication.operationId;
    },
    policyRevision: input.publication.policyRevision,
    get grantId() {
      return currentTaskAuthorization()?.publication.grantId
        ?? input.publication.grantId;
    },
    get grantDigest() {
      return currentTaskAuthorization()?.publication.grantDigest
        ?? input.publication.grantDigest;
    },
    get recipientKeyId() {
      return currentTaskAuthorization()?.publication.recipientKeyId
        ?? input.publication.recipientKeyId;
    },
    get taskDefinitionForegroundAuthorizationBytes() {
      return currentTaskAuthorization()?.publication
        .taskDefinitionForegroundAuthorizationBytes;
    },
    agentAuthorizationRevision: input.publication.agentAuthorizationRevision,
    signerKeyId: input.publication.signerKeyId,
    signerPublicKey: input.publication.signerPublicKey,
    runtime: input.publication.runtime,
  });
  const publication = createProtectedTaskForegroundCreationPublication({ ...input,
    entities, publication: publicationCoordinates,
    withCurrentProduct: async request => {
      const loan = current();
      const fact = await privateFact(request.candidate, request.plan.authority.namespaceId);
      if (fact.status !== "authorized") return null;
      const authority: TaskContentAuthorityV1 = { authorityVersion: 1, kind: "requester_private_namespace",
        keyClass: "ai", requesterHumanId: fact.subjectHumanId, namespaceId: fact.namespaceId,
        domainId: fact.domainId, expectedAccessRevision: fact.accessRevision, expectedPolicyRevision: fact.policyRevision };
      return request.use({ transaction: loan.transaction, product: loan.product, restricted: input.restricted,
        authority, resolveCurrentForegroundDefinitionAuthorization:
          currentTaskAuthorization()?.resolveCurrentForegroundDefinitionAuthorization
            ?? loan.authority.resolveCurrentForegroundEntityObjectWrite,
        assertCurrent: loan.assertCurrent });
    },
  });
  const updatePublication = createProtectedTaskForegroundUpdatePublication({
    owner: input.owner,
    crypto: input.crypto,
    entities,
    publication: publicationCoordinates,
    withCurrentProduct: async (request, use) => {
      const loan = current();
      if (request.taskId !== loan.taskId
        || request.ownerId !== input.subject.userId
        || request.requestorId !== input.subject.userId
        || request.agentId !== input.subject.agentId
        || request.callingRoomId !== input.subject.roomId) unavailable();
      return use({
        transaction: loan.transaction,
        product: loan.product,
        restricted: input.restricted,
        resolveCurrentForegroundDefinitionAuthorization:
          currentTaskAuthorization()?.resolveCurrentForegroundDefinitionAuthorization
            ?? loan.authority.resolveCurrentForegroundEntityObjectWrite,
        resolveAuthority: async (namespaceId, taskExecutorAgentId) => {
          const fact = await privateFact(request, namespaceId, taskExecutorAgentId);
          if (fact.status !== "authorized") return null;
          return {
            authorityVersion: 1,
            kind: "requester_private_namespace",
            keyClass: "ai",
            requesterHumanId: fact.subjectHumanId,
            namespaceId: fact.namespaceId,
            domainId: fact.domainId,
            expectedAccessRevision: fact.accessRevision,
            expectedPolicyRevision: fact.policyRevision,
          };
        },
        assertCurrent: loan.assertCurrent,
      });
    },
  });
  const context: ProtectedTaskForegroundCreationContext = {
    admission, assertCurrent,
    readHeldPolicy: async () => {
      assertLive();
      const loan = loans.getStore();
      if (loan === undefined) return null;
      return loan.readPolicy();
    },
    withTaskDefinitionAuthorization: async request => {
      if (taskAuthorizations.getStore() !== undefined) {
        throw new TypeError("Protected Task definition authorization cannot nest");
      }
      if (input.authorizeTaskDefinition === undefined) return request.use();
      return input.authorizeTaskDefinition({ ...request,
        withCurrentProduct: async use => {
          assertLive();
          const loan = loans.getStore();
          const value = await use(loan === undefined ? null : Object.freeze({
            transaction: loan.transaction,
            product: loan.product,
            assertCurrent: loan.assertCurrent,
            resolveCurrentForegroundEntityObjectWrite: async context => {
              await loan.assertCurrent();
              const decision = await loan.authority
                .resolveCurrentForegroundEntityObjectWrite(context);
              await loan.assertCurrent();
              return decision;
            },
          }));
          assertLive();
          return value;
        },
        use: authorization => taskAuthorizations.run(authorization, request.use) });
    },
    publishProtected: async request => {
      const loan = current();
      if (request.candidate.id !== loan.taskId || request.transaction !== loan.transaction || request.executor !== loan.executor) unavailable();
      return publication.publish(request);
    },
    preflightProtectedTaskUpdate: request => updatePublication.preflight(request),
    updateProtectedTask: request => updatePublication.publish(request),
    withProduct: async request => {
      assertLive();
      if (loans.getStore() !== undefined) throw new TypeError("Protected Task product creation cannot nest");
      await acquireEncryptionPublicationFence(request.transaction, {
        expectedRevision: input.subject.policyRevision,
        representation: input.representation === "protected" ? "protected_only" : "ordinary_and_protected",
      });
      // Dispatch already holds Task before Room. A committed tool retry must
      // follow that same order before its foreground Room proof is retained.
      await lockProtectedTaskForegroundCreationIdentity(request.transaction, request.taskId);
      let active = true;
      const guard = () => { assertLive(); if (!active) unavailable(); };
      const product: PostgresJsBridgeConnection = {
        query: async <Row extends PostgresJsBridgeRow>(statement: string, parameters?: readonly PostgresJsBridgeScalar[]) => {
          guard(); const rows = await request.executor.query<Row>(statement, parameters); guard(); return rows;
        },
        transaction: async use => { guard(); const value = await use(product); guard(); return value; },
        transactionOnce: async use => { guard(); const value = await use(product); guard(); return value; },
      };
      let authority: DomainKeyV2LiveShadowCurrentAuthority | null = null;
      try {
        authority = await input.createCurrentAuthority(product);
        if (authority === null) unavailable();
        const scoped = authority;
        const revalidate = async () => { guard(); if (!await scoped.verifyCurrentPlan()) unavailable(); guard(); };
        const readPolicy = async () => {
          guard();
          const policy = await getEncryptionTransitionPolicy(request.transaction);
          guard();
          return policy;
        };
        await revalidate();
        return await loans.run({ taskId: request.taskId, transaction: request.transaction, executor: request.executor,
          product, authority, assertCurrent: revalidate, readPolicy }, async () => {
          const value = await request.use(); await revalidate(); return value;
        });
      } finally { active = false; authority?.destroy(); }
    },
  };
  return Object.freeze({ context, dispose() {
    if (disposed) return;
    disposed = true;
    publication.dispose();
    updatePublication.dispose();
  } });
}
