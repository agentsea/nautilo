import type { PostgresJsBridgeConnection } from "@nautilo/db";
import {
  selectLiveEncryptionRepresentationPolicy,
  type MemoryPayloadV1,
  type PreparedMemoryCryptoRevision,
  type ProtectedMemoryAuthority,
} from "@nautilo/lattice-bridge";
import {
  bindConversationProductCanonicalTransactionRunner,
  copyTaskScopeMemoryBinding,
  verifyConversationProductPostgresHandle,
  type AgentMemoryPublicationBoundary,
  type ConversationProductCanonicalTransactionRunner,
  type ConversationProductPostgresHandle,
  type TaskMemoryReadBoundary,
} from "@nautilo/lattice-bridge/server";

import {
  withCurrentProtectedTaskMemoryAuthority,
  type CurrentProtectedTaskMemoryPolicy,
  type HeldProtectedTaskMemoryAuthority,
  type ProtectedTaskMemoryAuthorityInput,
} from "./current-protected-task-memory-authority";

type CanonicalTransaction = Parameters<
  Parameters<ConversationProductCanonicalTransactionRunner["transaction"]>[0]
>[0];
type CanonicalExecutor = Parameters<
  Parameters<ConversationProductCanonicalTransactionRunner["transaction"]>[0]
>[1];

export type ProtectedTaskMemoryBoundaries = Readonly<{
  authority: ProtectedMemoryAuthority;
  policy: CurrentProtectedTaskMemoryPolicy;
  publication: AgentMemoryPublicationBoundary;
  read: TaskMemoryReadBoundary;
}>;

type InputPolicy = Readonly<{
  mode: "plaintext_only" | "shadow_encryption" | "encrypted_only";
  shadowBehavior: "fallback" | "strict";
  revision: number;
}>;

export type ProtectedTaskMemoryBoundariesInput = Readonly<{
  authority: ProtectedMemoryAuthority;
  policy: InputPolicy;
  current: ProtectedTaskMemoryAuthorityInput;
  readPreparedPayload?(
    revision: PreparedMemoryCryptoRevision,
  ): MemoryPayloadV1;
}>;

type WithCurrentAuthority = typeof withCurrentProtectedTaskMemoryAuthority;

type Dependencies = Readonly<{
  withCurrentAuthority: WithCurrentAuthority;
  verifyProductHandle(
    connection: PostgresJsBridgeConnection,
  ): Promise<ConversationProductPostgresHandle>;
  bindProductRunner(
    handle: ConversationProductPostgresHandle,
    runner: Readonly<{
      transaction<Value>(
        use: (
          transaction: CanonicalTransaction,
          executor: CanonicalExecutor,
        ) => Promise<Value>,
      ): Promise<Value>;
    }>,
  ): ConversationProductCanonicalTransactionRunner;
}>;

const productionDependencies: Dependencies = Object.freeze({
  withCurrentAuthority: withCurrentProtectedTaskMemoryAuthority,
  verifyProductHandle: verifyConversationProductPostgresHandle,
  bindProductRunner: bindConversationProductCanonicalTransactionRunner,
});

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function canonicalIds(
  values: readonly string[],
  allowEmpty: boolean,
): readonly string[] | null {
  if (!Array.isArray(values as unknown)) return null;
  const entries: readonly unknown[] = values;
  if (!allowEmpty && entries.length === 0) return null;
  const canonical: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || !UUID.test(entry)
      || (canonical.length > 0 && canonical.at(-1)! >= entry)) return null;
    canonical.push(entry);
  }
  return Object.freeze(canonical);
}

function snapshotAuthority(
  value: ProtectedMemoryAuthority,
): ProtectedMemoryAuthority | null {
  if (!UUID.test(value.subjectUserId)
    || !UUID.test(value.agentId)) return null;
  if (value.mode === "scope") {
    return UUID.test(value.scopeId) && UUID.test(value.originWritableNamespaceId)
      ? Object.freeze({ ...value }) : null;
  }
  const readableNamespaceIds = canonicalIds(
    value.readableNamespaceIds,
    false,
  );
  const mutableNamespaceIds = canonicalIds(
    value.mutableNamespaceIds,
    true,
  );
  if (readableNamespaceIds === null
    || mutableNamespaceIds === null
    || !mutableNamespaceIds.every(id => readableNamespaceIds.includes(id))
    || (value.writableNamespaceId !== null
      && (!UUID.test(value.writableNamespaceId)
        || !mutableNamespaceIds.includes(value.writableNamespaceId)))) {
    return null;
  }
  return Object.freeze({
    mode: "namespace",
    subjectUserId: value.subjectUserId,
    agentId: value.agentId,
    readableNamespaceIds,
    mutableNamespaceIds,
    writableNamespaceId: value.writableNamespaceId,
  });
}

function sameIds(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((entry, index) => entry === right[index]);
}

function sameAuthority(
  value: ProtectedMemoryAuthority,
  expected: ProtectedMemoryAuthority,
): boolean {
  if (value.mode === "scope" || expected.mode === "scope") {
    return value.mode === "scope" && expected.mode === "scope"
      && value.subjectUserId === expected.subjectUserId
      && value.agentId === expected.agentId
      && value.scopeId === expected.scopeId
      && value.originWritableNamespaceId === expected.originWritableNamespaceId;
  }
  return value.mode === "namespace"
    && value.subjectUserId === expected.subjectUserId
    && value.agentId === expected.agentId
    && value.writableNamespaceId === expected.writableNamespaceId
    && sameIds(value.readableNamespaceIds, expected.readableNamespaceIds)
    && sameIds(value.mutableNamespaceIds, expected.mutableNamespaceIds);
}

function policyMatches(
  value: CurrentProtectedTaskMemoryPolicy,
  expected: CurrentProtectedTaskMemoryPolicy,
): boolean {
  return value.mode === expected.mode
    && value.shadowBehavior === expected.shadowBehavior
    && value.revision === expected.revision;
}

function authorityHasGrant(
  authority: ProtectedMemoryAuthority,
  current: ProtectedTaskMemoryAuthorityInput,
): boolean {
  const requirements = new Map<string, readonly ("decrypt" | "encrypt")[]>();
  for (const requirement of current.evidence.namespaceRequirements) {
    if (requirements.has(requirement.namespaceId)) return false;
    requirements.set(requirement.namespaceId, requirement.operations);
  }
  const has = (namespaceId: string, operation: "decrypt" | "encrypt") =>
    requirements.get(namespaceId)?.includes(operation) === true;
  if (authority.mode === "scope") {
    const scope = current.scopeMemory?.binding;
    return scope !== undefined && scope.scopeId === authority.scopeId
      && scope.originWritableNamespaceId === authority.originWritableNamespaceId
      && scope.readableNamespaceIds.every(id => has(id, "decrypt"))
      && has(authority.originWritableNamespaceId, "encrypt");
  }
  if (current.scopeMemory !== undefined) return false;
  return authority.readableNamespaceIds.every(id => has(id, "decrypt"))
    && authority.mutableNamespaceIds.every(id =>
      has(id, "decrypt") && has(id, "encrypt"))
    && (authority.writableNamespaceId === null
      || has(authority.writableNamespaceId, "encrypt"));
}

function connection(
  executor: Pick<PostgresJsBridgeConnection, "query">,
): PostgresJsBridgeConnection {
  return {
    query: executor.query.bind(executor),
    transaction: use => use(executor),
    transactionOnce: use => use(executor),
  };
}

function unavailable(): TypeError {
  return new TypeError("Protected Task Memory authority is unavailable");
}

function assertHeld(
  held: HeldProtectedTaskMemoryAuthority,
  policy: CurrentProtectedTaskMemoryPolicy,
): void {
  if (!policyMatches(held.policy, policy)) throw unavailable();
}

/**
 * Bind semantic Memory publication and reads to one exact protected Task grant.
 * Provider work, entity sessions and crypto preparation must finish before a
 * boundary callback begins; only transaction-local SQL/read/CAS belongs inside.
 */
export function createProtectedTaskMemoryBoundaries(
  input: ProtectedTaskMemoryBoundariesInput,
  overrides: Partial<Dependencies> = {},
): ProtectedTaskMemoryBoundaries {
  const dependencies = Object.freeze({
    ...productionDependencies,
    ...overrides,
  });
  // Preserve branded evidence/request identity while preventing the caller
  // from substituting the outer authority input after this factory returns.
  const current = Object.freeze({ ...input.current,
    ...(input.current.scopeMemory === undefined ? {} : {
      scopeMemory: Object.freeze({
        binding: copyTaskScopeMemoryBinding(input.current.scopeMemory.binding),
        targetRoomId: input.current.scopeMemory.targetRoomId,
        workIdentity: input.current.scopeMemory.workIdentity,
      }),
    }),
  });
  const authority = snapshotAuthority(input.authority);
  if (authority === null
    || authority.subjectUserId !== current.subject.userId
    || authority.agentId !== current.occurrence.task.agentId
    || authority.agentId !== current.evidence.result.signerAgentId
    || !authorityHasGrant(authority, current)) throw unavailable();

  if ((input.policy.mode !== "plaintext_only"
      && input.policy.mode !== "shadow_encryption"
      && input.policy.mode !== "encrypted_only")
    || (input.policy.shadowBehavior !== "fallback"
      && input.policy.shadowBehavior !== "strict")
    || !Number.isSafeInteger(input.policy.revision)
    || input.policy.revision < 0
    || input.policy.revision !== current.evidence.policyRevision) {
    throw unavailable();
  }
  const representation = selectLiveEncryptionRepresentationPolicy(
    input.policy,
  );
  if (representation.write === "ordinary_only"
    || (current.occurrence.task.contentRepresentation === "dual"
      ? input.policy.mode !== "shadow_encryption"
      : current.occurrence.task.contentRepresentation === "protected"
        ? input.policy.mode !== "encrypted_only"
        : true)) throw unavailable();
  const policy: CurrentProtectedTaskMemoryPolicy = Object.freeze({
    mode: input.policy.mode,
    shadowBehavior: input.policy.shadowBehavior,
    revision: input.policy.revision,
  }) as CurrentProtectedTaskMemoryPolicy;

  const exactRequestedAuthority = (requested: ProtectedMemoryAuthority) => {
    if (!sameAuthority(requested, authority)) throw unavailable();
  };
  const assertHeldCurrent = async (
    held: HeldProtectedTaskMemoryAuthority,
    requested?: ProtectedMemoryAuthority,
  ): Promise<void> => {
    if (requested !== undefined) exactRequestedAuthority(requested);
    assertHeld(held, policy);
    await held.assertCurrent();
    if (requested !== undefined) exactRequestedAuthority(requested);
  };

  const withCurrentPublication: Exclude<
    AgentMemoryPublicationBoundary["withCurrentPublication"],
    undefined
  > = async request => {
    exactRequestedAuthority(request.authority);
    let completedReceipt: Awaited<ReturnType<typeof request.use>> | null = null;
    try {
      const result = await dependencies.withCurrentAuthority(
        current,
        async held => {
          await assertHeldCurrent(held, request.authority);
          const receipt = await request.use(
            () => assertHeldCurrent(held, request.authority),
          );
          // `use` resolves only after the Agent transaction has settled. From
          // here this receipt reports an observed semantic outcome; it grants
          // no authority for further work or replay.
          completedReceipt = receipt;
          await assertHeldCurrent(held, request.authority);
          return receipt;
        },
      );
      if (result === null) {
        if (request.mutation && completedReceipt !== null) {
          return completedReceipt;
        }
        throw unavailable();
      }
      return result;
    } catch (error) {
      if (request.mutation && completedReceipt !== null) {
        return completedReceipt;
      }
      throw error;
    }
  };

  let publication: AgentMemoryPublicationBoundary;
  if (representation.write === "ordinary_and_protected") {
    if (typeof input.readPreparedPayload !== "function") {
      throw new TypeError(
        "Shadow Task Memory publication requires its prepared payload reader",
      );
    }
    publication = Object.freeze({
      representation: "ordinary_and_protected" as const,
      withCurrentPublication,
      readPreparedPayload: input.readPreparedPayload,
    });
  } else {
    if (input.readPreparedPayload !== undefined) {
      throw new TypeError(
        "Full Task Memory publication cannot expose an ordinary payload reader",
      );
    }
    publication = Object.freeze({
      representation: "protected_only" as const,
      withCurrentPublication,
    });
  }

  const read: TaskMemoryReadBoundary = Object.freeze({
    async withCurrentRead(request) {
      exactRequestedAuthority(request.authority);
      const product = connection(request.executor);
      const handle = await dependencies.verifyProductHandle(product);
      if (handle.role !== "nautilo") throw unavailable();
      const runner = dependencies.bindProductRunner(handle, {
        transaction: use => use(request.transaction, request.executor),
      });
      const result = await dependencies.withCurrentAuthority(
        Object.freeze({ ...current, runner }),
        async held => {
          await assertHeldCurrent(held, request.authority);
          const receipt = await request.use();
          await assertHeldCurrent(held, request.authority);
          return receipt;
        },
      );
      if (result === null) throw unavailable();
      return result;
    },
  });

  return Object.freeze({
    authority,
    policy,
    publication,
    read,
  });
}
