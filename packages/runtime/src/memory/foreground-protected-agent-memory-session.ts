import {
  createInvocationBoundProtectedAgentMemoryRepository,
  type AgentMemoryExactAccessPlan,
  type ForegroundAgentMemoryNativeExactAccessPlan,
  type ForegroundAgentMemoryNativeExactAccessPublication,
  type PreparedAgentMemoryExactAccess,
  type ProtectedAgentMemoryEmbeddingPort,
  type ProtectedAgentMemoryCryptoSessionPort,
  type ProtectedAgentMemoryProductPort,
  type ProtectedAgentMemoryExactAccessContentPort,
  type ProtectedAgentMemoryRepository,
  type ProtectedAgentMemorySessionContentPort,
  type ProtectedMemoryAuthority,
  type ProtectedMemoryResult,
} from "@nautilo/lattice-bridge";
import type {
  ProtectedAgentMemoryAccessPort,
  ProtectedAgentMemoryProjectionPort,
  ProtectedAgentMemoryScopeLifecyclePort,
} from "@nautilo/agent";
import type { PostgresProtectedScopeCloseSaga } from "@nautilo/trust";
import type { PreparedForegroundDomainMemoryExactAccess } from "./foreground-domain-memory-exact-access.ts";

import {
  type ForegroundAuthorizationExecutionReason,
  type ForegroundAuthorizationExecutionResult,
  type ForegroundAuthorizationOperationLease,
  ForegroundAuthorizationSessionRegistry,
  type ForegroundAuthorizationView,
  type ForegroundAuthorizationNamespaceSetPort,
} from "../protected-execution/foreground-authorization-session.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function unavailable<Value>(
  reason:
    | "authorization_required"
    | "incomplete_access_set"
    | "integrity_failure"
    | "stale_revision"
    | "target_encryption_not_ready",
): ProtectedMemoryResult<Value> {
  return Object.freeze({ status: "unavailable", reason });
}

function canonicalNamespaceIds(
  value: readonly string[],
): readonly string[] | null {
  if (
    value.length < 1 ||
    value.length > 256 ||
    value.some((entry) => !UUID.test(entry)) ||
    value.some((entry, index) => index > 0 && value[index - 1]! >= entry)
  )
    return null;
  return Object.freeze([...value]);
}

function canonicalUnion(
  values: readonly (readonly string[])[],
): readonly string[] | null {
  if (values.length < 1) return null;
  for (const value of values) {
    if (canonicalNamespaceIds(value) === null) return null;
  }
  const union = [...new Set(values.flat())].sort();
  return canonicalNamespaceIds(union);
}

function authorityAllows(
  authority: ProtectedMemoryAuthority,
  namespaceIds: readonly string[],
  operation: "decrypt" | "encrypt",
): boolean {
  if (authority.mode === "scope") {
    return operation === "decrypt"
      ? true
      : namespaceIds.length === 1 &&
          namespaceIds[0] === authority.originWritableNamespaceId;
  }
  const allowed =
    operation === "decrypt"
      ? authority.readableNamespaceIds
      : authority.mutableNamespaceIds;
  return namespaceIds.every((namespaceId) => allowed.includes(namespaceId));
}

function mapExecutionFailure(
  reason: ForegroundAuthorizationExecutionReason,
):
  | "authorization_required"
  | "integrity_failure"
  | "target_encryption_not_ready" {
  if (reason === "content_invalid" || reason === "execution_failed") {
    return "integrity_failure";
  }
  if (reason === "content_unavailable") {
    return "target_encryption_not_ready";
  }
  return "authorization_required";
}

export function createForegroundProtectedAgentMemoryCryptoSession(
  input: Readonly<{
    registry: ForegroundAuthorizationSessionRegistry;
    view: ForegroundAuthorizationView;
    contentPort: ProtectedAgentMemorySessionContentPort;
  }>,
): ProtectedAgentMemoryCryptoSessionPort {
  async function execute<Value>(
    request: Readonly<{
      entrypointId: Parameters<
        ProtectedAgentMemoryCryptoSessionPort["openMany"]
      >[0]["entrypointId"];
      operation: "decrypt" | "encrypt";
      namespaceIds: readonly string[];
      signal?: AbortSignal;
      run: (
        lease: ForegroundAuthorizationOperationLease,
      ) => Promise<
        ForegroundAuthorizationExecutionResult<ProtectedMemoryResult<Value>>
      >;
    }>,
  ): Promise<ProtectedMemoryResult<Value>> {
    const namespaceIds = canonicalNamespaceIds(request.namespaceIds);
    if (namespaceIds === null) return unavailable("incomplete_access_set");
    const leased = input.registry.leaseNamespaceSetOperation({
      view: input.view,
      entrypointId: request.entrypointId,
      operation: request.operation,
      namespaceIds,
    });
    if (leased.status === "unavailable") {
      return unavailable(
        leased.reason === "operation_scope_widened"
          ? "incomplete_access_set"
          : "authorization_required",
      );
    }
    const executed = await request.run(leased.lease);
    return executed.status === "unavailable"
      ? unavailable(mapExecutionFailure(executed.reason))
      : executed.value;
  }

  const session: ProtectedAgentMemoryCryptoSessionPort = {
    async openMany(request) {
      const namespaceIds = canonicalUnion(
        request.candidates.map((candidate) => [candidate.readNamespaceId]),
      );
      if (
        namespaceIds === null ||
        request.candidates.some(
          (candidate) =>
            canonicalNamespaceIds(candidate.requiredNamespaceIds) === null ||
            !candidate.requiredNamespaceIds.includes(candidate.readNamespaceId),
        ) ||
        !authorityAllows(request.authority, namespaceIds, "decrypt")
      )
        return unavailable("incomplete_access_set");
      return execute({
        entrypointId: request.entrypointId,
        operation: "decrypt",
        namespaceIds,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        run: (lease) =>
          input.registry.executeAgentMemoryOpen(lease, {
            contentPort: input.contentPort,
            agentId: request.agentId,
            authority: request.authority,
            candidates: request.candidates,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          }),
      });
    },

    async prepare(request) {
      const replacementIds =
        request.content.kind === "replacement"
          ? canonicalNamespaceIds(request.content.previous.requiredNamespaceIds)
          : null;
      const planIds = canonicalNamespaceIds(request.plan.requiredNamespaceIds);
      if (
        planIds === null ||
        (request.content.kind === "complete"
          ? !authorityAllows(request.authority, planIds, "encrypt")
          : replacementIds === null ||
            replacementIds.length !== planIds.length ||
            replacementIds.some((entry, index) => entry !== planIds[index]) ||
            (request.authority.mode === "namespace" &&
              (!authorityAllows(request.authority, replacementIds, "decrypt") ||
                !authorityAllows(request.authority, planIds, "encrypt"))))
      )
        return unavailable("incomplete_access_set");
      return execute({
        entrypointId: request.entrypointId,
        operation: "encrypt",
        namespaceIds: planIds,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        run: (lease) =>
          input.registry.executeAgentMemoryPrepare(lease, {
            contentPort: input.contentPort,
            agentId: request.agentId,
            authority: request.authority,
            plan: request.plan,
            content: request.content,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          }),
      });
    },

    async authorizeCommit(request) {
      const namespaceIds = canonicalNamespaceIds(
        request.target.requiredNamespaceIds,
      );
      if (
        namespaceIds === null ||
        !authorityAllows(request.authority, namespaceIds, "encrypt")
      )
        return unavailable("incomplete_access_set");
      return execute({
        entrypointId: request.entrypointId,
        operation: "encrypt",
        namespaceIds,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        run: (lease) =>
          input.registry.executeAgentMemoryCommit(lease, {
            contentPort: input.contentPort,
            agentId: request.agentId,
            authority: request.authority,
            target: request.target,
            memoryOperation: request.operation,
            commit: request.commit,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          }),
      });
    },
  };
  return Object.freeze(session);
}

/**
 * Bind the complete foreground Memory repository to one authenticated
 * authorization view. This is the only composition helper callers need:
 * neither the opaque capability nor bridge-owned crypto material is exposed.
 */
export function createForegroundProtectedAgentMemoryRepository(
  input: Readonly<{
    registry: ForegroundAuthorizationSessionRegistry;
    view: ForegroundAuthorizationView;
    contentPort: ProtectedAgentMemorySessionContentPort;
    subjectUserId: string;
    agentId: string;
    entrypointId: Parameters<
      ProtectedAgentMemoryCryptoSessionPort["openMany"]
    >[0]["entrypointId"];
    embedding: ProtectedAgentMemoryEmbeddingPort;
    product: ProtectedAgentMemoryProductPort;
    owner: Parameters<
      typeof createInvocationBoundProtectedAgentMemoryRepository
    >[0]["owner"];
    loadExactOrdinary?: Parameters<
      typeof createInvocationBoundProtectedAgentMemoryRepository
    >[0]["loadExactOrdinary"];
    repairExactCandidate: Parameters<
      typeof createInvocationBoundProtectedAgentMemoryRepository
    >[0]["repairExactCandidate"];
    fallbackOrdinary: Parameters<
      typeof createInvocationBoundProtectedAgentMemoryRepository
    >[0]["fallbackOrdinary"];
    signal?: AbortSignal;
  }>,
): ProtectedAgentMemoryRepository {
  const crypto = createForegroundProtectedAgentMemoryCryptoSession({
    registry: input.registry,
    view: input.view,
    contentPort: input.contentPort,
  });
  return createInvocationBoundProtectedAgentMemoryRepository({
    owner: input.owner,
    subjectUserId: input.subjectUserId,
    agentId: input.agentId,
    entrypointId: input.entrypointId,
    embedding: input.embedding,
    product: input.product,
    crypto,
    repairExactCandidate: input.repairExactCandidate,
    fallbackOrdinary: input.fallbackOrdinary,
    ...(input.loadExactOrdinary === undefined
      ? {}
      : {
          loadExactOrdinary: input.loadExactOrdinary,
        }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

export interface ForegroundProtectedAgentMemoryToolRevalidator {
  run<Value>(
    input: Readonly<{
      operation: "decrypt" | "encrypt";
      namespaceIds: readonly string[];
      executionDeadline?: number;
      execute(): Promise<ProtectedMemoryResult<Value>>;
    }>,
  ): Promise<ProtectedMemoryResult<Value>>;
}

type ForegroundProtectedAgentMemoryToolPortBase = Readonly<{
  registry: ForegroundAuthorizationSessionRegistry;
  view: ForegroundAuthorizationView;
  entrypointId: Parameters<
    ForegroundAuthorizationSessionRegistry["leaseNamespaceSetOperation"]
  >[0]["entrypointId"];
  contentPort: ForegroundAuthorizationNamespaceSetPort;
  signal?: AbortSignal;
}>;

/**
 * Gives injected product callbacks one exact, short-lived revalidation seam.
 * The callback owns semantic planning and chooses its required Namespace set;
 * runtime only verifies that the live foreground grant still permits it.
 */
export function createForegroundProtectedAgentMemoryToolRevalidator(
  input: ForegroundProtectedAgentMemoryToolPortBase,
): ForegroundProtectedAgentMemoryToolRevalidator {
  return Object.freeze({
    async run<Value>(
      request: Readonly<{
        operation: "decrypt" | "encrypt";
        namespaceIds: readonly string[];
        executionDeadline?: number;
        execute(): Promise<ProtectedMemoryResult<Value>>;
      }>,
    ): Promise<ProtectedMemoryResult<Value>> {
      const namespaceIds = canonicalNamespaceIds(request.namespaceIds);
      if (namespaceIds === null) return unavailable("incomplete_access_set");
      const leased = input.registry.leaseNamespaceSetOperation({
        view: input.view,
        entrypointId: input.entrypointId,
        operation: request.operation,
        namespaceIds,
        ...(request.executionDeadline === undefined
          ? {}
          : { executionDeadline: request.executionDeadline }),
      });
      if (leased.status === "unavailable") {
        return unavailable(
          leased.reason === "operation_scope_widened"
            ? "incomplete_access_set"
            : "authorization_required",
        );
      }
      const executed = await input.registry.executeNamespaceSet(leased.lease, {
        contentPort: input.contentPort,
        execute: request.execute,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      return executed.status === "unavailable"
        ? unavailable(mapExecutionFailure(executed.reason))
        : executed.value;
    },
  });
}

export function createForegroundProtectedAgentMemoryAccessPort(
  input: ForegroundProtectedAgentMemoryToolPortBase &
    Readonly<{
      prepareApproval(
        request: Parameters<
          NonNullable<ProtectedAgentMemoryAccessPort["prepareApproval"]>
        >[0],
        revalidate: ForegroundProtectedAgentMemoryToolRevalidator,
      ): ReturnType<
        NonNullable<ProtectedAgentMemoryAccessPort["prepareApproval"]>
      >;
      change(
        request: Parameters<ProtectedAgentMemoryAccessPort["change"]>[0],
        revalidate: ForegroundProtectedAgentMemoryToolRevalidator,
      ): ReturnType<ProtectedAgentMemoryAccessPort["change"]>;
    }>,
): ProtectedAgentMemoryAccessPort {
  const revalidate = createForegroundProtectedAgentMemoryToolRevalidator(input);
  let approved:
    | Readonly<{
        authority: ProtectedMemoryAuthority;
        memoryId: string;
        action: Parameters<
          ProtectedAgentMemoryAccessPort["change"]
        >[0]["action"];
        reference: NonNullable<
          Parameters<
            ProtectedAgentMemoryAccessPort["change"]
          >[0]["approvalReference"]
        >;
      }>
    | undefined;
  return Object.freeze({
    async prepareApproval(
      request: Parameters<
        NonNullable<ProtectedAgentMemoryAccessPort["prepareApproval"]>
      >[0],
    ): ReturnType<
      NonNullable<ProtectedAgentMemoryAccessPort["prepareApproval"]>
    > {
      const prepared = await input.prepareApproval(request, revalidate);
      if (prepared.status === "unavailable") return prepared;
      if (
        prepared.value.reference.toolCallId !== request.toolCallId ||
        prepared.value.reference.requesterUserId !==
          request.authority.subjectUserId ||
        prepared.value.reference.agentId !== request.authority.agentId
      )
        return unavailable("integrity_failure");
      approved = Object.freeze({
        authority: request.authority,
        memoryId: request.memoryId,
        action: request.action,
        reference: prepared.value.reference,
      });
      return prepared;
    },
    change: (
      request: Parameters<ProtectedAgentMemoryAccessPort["change"]>[0],
    ): ReturnType<ProtectedAgentMemoryAccessPort["change"]> => {
      const retained = approved;
      if (
        retained === undefined ||
        retained.memoryId !== request.memoryId ||
        retained.authority.subjectUserId !== request.authority.subjectUserId ||
        retained.authority.agentId !== request.authority.agentId ||
        retained.action.kind !== request.action.kind ||
        retained.action.userHandle !== request.action.userHandle ||
        (request.approvalReference !== undefined &&
          request.approvalReference.referenceId !==
            retained.reference.referenceId)
      )
        return Promise.resolve(
          unavailable<
            Readonly<{
              status: "updated" | "replayed" | "unchanged";
              memoryId: string;
            }>
          >("authorization_required"),
        );
      return input.change(
        Object.freeze({
          ...request,
          approvalReference: retained.reference,
        }),
        revalidate,
      );
    },
  });
}

export type ForegroundProtectedAgentMemoryExactAccessPlan =
  | Readonly<{
      status: "unchanged";
      memoryId: string;
    }>
  | Readonly<{
      status: "prepared";
      sourceNamespaceId: string | null;
      plan: AgentMemoryExactAccessPlan;
    }>;

/** Current-Domain exact-access path. Approval/source binding is supplied by
 * createForegroundProtectedAgentMemoryAccessPort; this function owns only the
 * authenticated product plan, native preparation, and transaction-fenced
 * publication. */
export function createForegroundProtectedAgentMemoryNativeExactAccessChange(
  input: Readonly<{
    crypto: Readonly<{
      prepare(
        request: Readonly<{
          objectId: string;
          expectedAccessRevision: number;
          currentNamespaceIds: readonly string[];
          targetNamespaceIds: readonly string[];
        }>,
      ): Promise<PreparedForegroundDomainMemoryExactAccess | null>;
      authorizeCommit<Value>(
        request: Readonly<{
          prepared: PreparedForegroundDomainMemoryExactAccess;
          commit(
            publication: ForegroundAgentMemoryNativeExactAccessPublication,
          ): Promise<Value> | Value;
        }>,
      ): Promise<Value>;
    }>;
    product: Readonly<{
      planNativeChange(
        request: Parameters<ProtectedAgentMemoryAccessPort["change"]>[0],
      ): Promise<
        ProtectedMemoryResult<
          | Readonly<{ status: "unchanged"; memoryId: string }>
          | Readonly<{
              status: "prepared";
              sourceNamespaceId: string;
              plan: ForegroundAgentMemoryNativeExactAccessPlan;
            }>
        >
      >;
      commitNativePrepared(
        request: Readonly<{
          authority: ProtectedMemoryAuthority;
          plan: ForegroundAgentMemoryNativeExactAccessPlan;
          publication: ForegroundAgentMemoryNativeExactAccessPublication;
          persist(): Promise<"created" | "duplicate" | "stale">;
        }>,
      ): ReturnType<ProtectedAgentMemoryAccessPort["change"]>;
    }>;
    persist(
      publication: ForegroundAgentMemoryNativeExactAccessPublication,
    ): Promise<"created" | "duplicate" | "stale">;
  }>,
) {
  return async (
    request: Parameters<ProtectedAgentMemoryAccessPort["change"]>[0],
  ): ReturnType<ProtectedAgentMemoryAccessPort["change"]> => {
    const planned = await input.product.planNativeChange(request);
    if (planned.status === "unavailable") return planned;
    if (planned.value.status === "unchanged")
      return Object.freeze({
        status: "success" as const,
        value: Object.freeze({
          status: "unchanged" as const,
          memoryId: planned.value.memoryId,
        }),
      });
    const plan = planned.value.plan;
    const prepared = await input.crypto.prepare({
      objectId: plan.cryptoObjectId,
      expectedAccessRevision: plan.expectedCryptoAccessRevision,
      currentNamespaceIds: plan.currentNamespaceIds,
      targetNamespaceIds: plan.targetNamespaceIds,
    });
    if (prepared === null) return unavailable("target_encryption_not_ready");
    return input.crypto.authorizeCommit({
      prepared,
      commit: (publication) =>
        input.product.commitNativePrepared({
          authority: request.authority,
          plan,
          publication,
          persist: () => input.persist(publication),
        }),
    });
  };
}

/**
 * Full dormant Agent sharing composition. Product planning stays content-free;
 * both preparation and durable commit independently lease the exact mixed
 * decrypt/remove + encrypt/add Namespace requirements from the live view.
 */
export function createForegroundProtectedAgentMemoryExactAccessPort(
  input: ForegroundProtectedAgentMemoryToolPortBase &
    Readonly<{
      exactAccessContentPort: ProtectedAgentMemoryExactAccessContentPort;
      agentId: string;
      plan(
        request: Parameters<ProtectedAgentMemoryAccessPort["change"]>[0],
      ): Promise<
        ProtectedMemoryResult<ForegroundProtectedAgentMemoryExactAccessPlan>
      >;
      commit(
        input: Readonly<{
          request: Parameters<ProtectedAgentMemoryAccessPort["change"]>[0];
          plan: AgentMemoryExactAccessPlan;
          prepared: PreparedAgentMemoryExactAccess;
        }>,
      ): Promise<
        ProtectedMemoryResult<
          Readonly<{
            status: "updated" | "replayed";
            memoryId: string;
          }>
        >
      >;
    }>,
): ProtectedAgentMemoryAccessPort {
  const requirementsFor = (
    plan: AgentMemoryExactAccessPlan,
    sourceNamespaceId: string | null,
  ) =>
    Object.freeze(
      [
        ...plan.removedNamespaceIds.map((namespaceId) =>
          Object.freeze({
            namespaceId,
            operation: "decrypt" as const,
          }),
        ),
        ...(plan.addedNamespaceIds.length > 0 &&
        sourceNamespaceId !== null &&
        !plan.removedNamespaceIds.includes(sourceNamespaceId)
          ? [
              Object.freeze({
                namespaceId: sourceNamespaceId,
                operation: "decrypt" as const,
              }),
            ]
          : []),
        ...plan.addedNamespaceIds.map((namespaceId) =>
          Object.freeze({
            namespaceId,
            operation: "encrypt" as const,
          }),
        ),
      ].sort((left, right) =>
        left.namespaceId.localeCompare(right.namespaceId),
      ),
    );

  const lease = (
    plan: AgentMemoryExactAccessPlan,
    sourceNamespaceId: string | null,
  ) =>
    input.registry.leaseNamespaceRequirementsOperation({
      view: input.view,
      entrypointId: input.entrypointId,
      requirements: requirementsFor(plan, sourceNamespaceId),
    });

  return Object.freeze({
    async change(
      request: Parameters<ProtectedAgentMemoryAccessPort["change"]>[0],
    ): ReturnType<ProtectedAgentMemoryAccessPort["change"]> {
      if (request.authority.agentId !== input.agentId) {
        return unavailable("authorization_required");
      }
      const planned = await input.plan(request);
      if (planned.status === "unavailable") return planned;
      if (planned.value.status === "unchanged") {
        return Object.freeze({
          status: "success" as const,
          value: Object.freeze({
            status: "unchanged" as const,
            memoryId: planned.value.memoryId,
          }),
        });
      }
      const { plan, sourceNamespaceId } = planned.value;
      const prepareLease = lease(plan, sourceNamespaceId);
      if (prepareLease.status === "unavailable") {
        return unavailable(
          prepareLease.reason === "operation_scope_widened"
            ? "incomplete_access_set"
            : "authorization_required",
        );
      }
      const prepared =
        await input.registry.executeAgentMemoryExactAccessPrepare(
          prepareLease.lease,
          {
            contentPort: input.exactAccessContentPort,
            agentId: input.agentId,
            authority: request.authority,
            sourceNamespaceId,
            plan,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          },
        );
      if (prepared.status === "unavailable") {
        return unavailable(mapExecutionFailure(prepared.reason));
      }
      if (prepared.value.status === "unavailable") return prepared.value;
      const preparedHandle = prepared.value.value;
      const commitLease = lease(plan, sourceNamespaceId);
      if (commitLease.status === "unavailable") {
        return unavailable(
          commitLease.reason === "operation_scope_widened"
            ? "incomplete_access_set"
            : "authorization_required",
        );
      }
      const committed =
        await input.registry.executeAgentMemoryExactAccessCommit<
          Readonly<{
            status: "updated" | "replayed";
            memoryId: string;
          }>
        >(commitLease.lease, {
          contentPort: input.exactAccessContentPort,
          agentId: input.agentId,
          authority: request.authority,
          sourceNamespaceId,
          plan,
          prepared: preparedHandle,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          commit: () =>
            input.commit({
              request,
              plan,
              prepared: preparedHandle,
            }),
        });
      if (committed.status === "unavailable") {
        return unavailable(mapExecutionFailure(committed.reason));
      }
      if (committed.value.status === "unavailable") return committed.value;
      return committed.value;
    },
  });
}

export function createForegroundProtectedAgentMemoryProjectionPort(
  input: ForegroundProtectedAgentMemoryToolPortBase &
    Readonly<{
      prepare(
        request: Parameters<ProtectedAgentMemoryProjectionPort["prepare"]>[0],
        revalidate: ForegroundProtectedAgentMemoryToolRevalidator,
      ): ReturnType<ProtectedAgentMemoryProjectionPort["prepare"]>;
      publish(
        request: Parameters<ProtectedAgentMemoryProjectionPort["publish"]>[0],
        revalidate: ForegroundProtectedAgentMemoryToolRevalidator,
      ): ReturnType<ProtectedAgentMemoryProjectionPort["publish"]>;
    }>,
): ProtectedAgentMemoryProjectionPort {
  const revalidate = createForegroundProtectedAgentMemoryToolRevalidator(input);
  return Object.freeze({
    prepare: (
      request: Parameters<ProtectedAgentMemoryProjectionPort["prepare"]>[0],
    ) => input.prepare(request, revalidate),
    publish: (
      request: Parameters<ProtectedAgentMemoryProjectionPort["publish"]>[0],
    ) => input.publish(request, revalidate),
  });
}

export function createForegroundProtectedAgentMemoryScopeLifecyclePort(
  input: ForegroundProtectedAgentMemoryToolPortBase &
    Readonly<{
      create(
        request: Parameters<
          ProtectedAgentMemoryScopeLifecyclePort["create"]
        >[0],
        revalidate: ForegroundProtectedAgentMemoryToolRevalidator,
      ): ReturnType<ProtectedAgentMemoryScopeLifecyclePort["create"]>;
      attachSeed(
        request: Parameters<
          ProtectedAgentMemoryScopeLifecyclePort["attachSeed"]
        >[0],
        revalidate: ForegroundProtectedAgentMemoryToolRevalidator,
      ): ReturnType<ProtectedAgentMemoryScopeLifecyclePort["attachSeed"]>;
      close(
        request: Parameters<ProtectedAgentMemoryScopeLifecyclePort["close"]>[0],
        revalidate: ForegroundProtectedAgentMemoryToolRevalidator,
      ): ReturnType<ProtectedAgentMemoryScopeLifecyclePort["close"]>;
    }>,
): ProtectedAgentMemoryScopeLifecyclePort {
  const revalidate = createForegroundProtectedAgentMemoryToolRevalidator(input);
  return Object.freeze({
    create: (
      request: Parameters<ProtectedAgentMemoryScopeLifecyclePort["create"]>[0],
    ) => input.create(request, revalidate),
    attachSeed: (
      request: Parameters<
        ProtectedAgentMemoryScopeLifecyclePort["attachSeed"]
      >[0],
    ) => input.attachSeed(request, revalidate),
    close: (
      request: Parameters<ProtectedAgentMemoryScopeLifecyclePort["close"]>[0],
    ) => input.close(request, revalidate),
  });
}

type ProtectedScopeCloseRequest = Parameters<
  ProtectedAgentMemoryScopeLifecyclePort["close"]
>[0];

/**
 * Canonical dormant adapter from the foreground scope tool to the durable
 * close saga. Exact completed/active replay is read from the content-free
 * operation before asking for a new live lease; a new close is started only
 * inside the current foreground authorization callback.
 */
export function createProtectedAgentScopeCloseLifecycleHandler(
  input: Readonly<{
    saga: Pick<
      PostgresProtectedScopeCloseSaga,
      "assertOpenForProtectedMutation" | "begin" | "observe"
    >;
  }>,
): (
  request: ProtectedScopeCloseRequest,
  revalidate: ForegroundProtectedAgentMemoryToolRevalidator,
) => ReturnType<ProtectedAgentMemoryScopeLifecyclePort["close"]> {
  return async (request, revalidate) => {
    if (request.authority.mode !== "namespace") {
      return unavailable("authorization_required");
    }
    const authority = request.authority;
    const existing = await input.saga.observe({
      operationId: request.operationId,
      parentAgentId: authority.agentId,
      speakerUserId: authority.subjectUserId,
    });
    if (existing !== null) {
      if (existing.scopeId !== request.scopeId) {
        return unavailable("integrity_failure");
      }
      if (existing.state === "quarantined") {
        return unavailable("integrity_failure");
      }
      return Object.freeze({
        status: "success" as const,
        value: Object.freeze({
          status:
            existing.state === "complete"
              ? ("replayed" as const)
              : ("closing" as const),
          scopeId: existing.scopeId,
          transitionCount: existing.capturedItemCount,
        }),
      });
    }
    const targetNamespaceId = authority.writableNamespaceId;
    const namespaceIds =
      targetNamespaceId === null
        ? authority.readableNamespaceIds
        : Object.freeze([targetNamespaceId]);
    return revalidate.run({
      operation: targetNamespaceId === null ? "decrypt" : "encrypt",
      namespaceIds,
      execute: async () => {
        const admission = await input.saga.assertOpenForProtectedMutation({
          scopeId: request.scopeId,
          parentAgentId: authority.agentId,
          speakerUserId: authority.subjectUserId,
        });
        if (admission.status !== "open") {
          const replay = await input.saga.observe({
            operationId: request.operationId,
            parentAgentId: authority.agentId,
            speakerUserId: authority.subjectUserId,
          });
          if (
            replay !== null &&
            replay.scopeId === request.scopeId &&
            replay.state !== "quarantined"
          ) {
            return Object.freeze({
              status: "success" as const,
              value: Object.freeze({
                status:
                  replay.state === "complete"
                    ? ("replayed" as const)
                    : ("closing" as const),
                scopeId: replay.scopeId,
                transitionCount: replay.capturedItemCount,
              }),
            });
          }
          return unavailable(
            admission.status === "not_found"
              ? "authorization_required"
              : "stale_revision",
          );
        }
        const begun = await input.saga.begin({
          operationId: request.operationId,
          scopeId: request.scopeId,
          parentAgentId: authority.agentId,
          speakerUserId: authority.subjectUserId,
          expectedScopeRevision: admission.scopeRevision,
          targetNamespaceId,
        });
        if (begun.status === "started" || begun.status === "replayed") {
          return Object.freeze({
            status: "success" as const,
            value: Object.freeze({
              status:
                begun.status === "started"
                  ? ("closing" as const)
                  : ("replayed" as const),
              scopeId: begun.scopeId,
              transitionCount: begun.capturedItemCount,
            }),
          });
        }
        return unavailable(
          begun.status === "target_required"
            ? "target_encryption_not_ready"
            : begun.status === "protected_mapping_unavailable" ||
                begun.status === "too_many_items"
              ? "integrity_failure"
              : begun.status === "not_found"
                ? "authorization_required"
                : "stale_revision",
        );
      },
    });
  };
}
