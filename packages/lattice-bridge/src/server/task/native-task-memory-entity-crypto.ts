import {
  and,
  domainKeyHeads,
  eq,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import {
  assertAuthenticTaskRuntimeExecutionEvidence,
  type DomainForegroundSecretEntry,
  type LatticeCrypto,
  type TaskRuntimeExecutionEvidence,
} from "@nautilo/lattice-crypto";

import type {
  AgentEntityCryptoInvocation,
  AgentEntityCryptoOperation,
  AgentEntityCryptoResult,
  AgentEntityNamespaceAuthority,
} from "../../object/agent-entity-crypto.ts";
import {
  PostgresDomainKeyAuthorityRepository,
  type DomainForegroundNamespaceAuthorityInspectionV2,
} from "../delivery/postgres-domain-key-authority.ts";
import {
  cryptoTypedDb,
  executeTypedCryptoQuery,
  readCryptoStorageInteger,
  verifyCryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";

type NamespaceKeys = Pick<
  PostgresDomainKeyAuthorityRepository,
  "inspectForegroundNamespaceAuthority" | "withOpenedForegroundNamespaceKey"
>;

type ReadyNamespaceAuthority =
  DomainForegroundNamespaceAuthorityInspectionV2;

type BorrowedDomain = Readonly<{
  domainId: string;
  sourceNamespaceId: string;
  participantDigest: Uint8Array;
  participantCount: number;
  keyClass: "ai";
  domainKeyGeneration: number;
  authorizationRevision: number;
  headDigest: Uint8Array;
  /** Borrowed from the parent Task grant and never destroyed here. */
  domainKey: Uint8Array;
}>;

type InspectedNamespace = Readonly<{
  authority: ReadyNamespaceAuthority;
  callbackAuthority: AgentEntityNamespaceAuthority;
  domain: BorrowedDomain;
}>;

type OpenedNamespace = Readonly<{
  namespaceKey: Uint8Array;
  authority: AgentEntityNamespaceAuthority;
}>;

class TaskMemoryAuthorityUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskMemoryAuthorityUnavailable";
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function wipeAuthority(authority: ReadyNamespaceAuthority): void {
  for (const bytes of [
    authority.namespaceHeadDigest,
    authority.namespacePublicationDigest,
    authority.namespacePublicationSetDigest,
    authority.namespaceAudienceFingerprint,
    authority.domainHeadDigest,
    authority.bundleDigest,
  ]) bytes.fill(0);
}

function callbackAuthority(
  authority: ReadyNamespaceAuthority,
): AgentEntityNamespaceAuthority {
  return Object.freeze({
    namespaceId: authority.namespaceId,
    namespaceAccessRevision: authority.namespaceAccessRevision,
    namespaceKeyGeneration: authority.namespaceKeyGeneration,
    domainId: authority.domainId,
    domainKeyGeneration: authority.domainKeyGeneration,
    domainAuthorizationRevision: authority.domainAuthorizationRevision,
    domainHeadDigest: authority.domainHeadDigest.slice(),
    namespaceHeadDigest: authority.namespaceHeadDigest.slice(),
    namespacePublicationDigest: authority.namespacePublicationDigest.slice(),
    namespacePublicationSetDigest:
      authority.namespacePublicationSetDigest.slice(),
    namespaceAudienceFingerprint:
      authority.namespaceAudienceFingerprint.slice(),
  });
}

function wipeCallbackAuthority(
  authority: AgentEntityNamespaceAuthority,
): void {
  for (const bytes of [
    authority.domainHeadDigest,
    authority.namespaceHeadDigest,
    authority.namespacePublicationDigest,
    authority.namespacePublicationSetDigest,
    authority.namespaceAudienceFingerprint,
  ]) bytes.fill(0);
}

function sameAuthority(
  left: ReadyNamespaceAuthority,
  right: ReadyNamespaceAuthority,
): boolean {
  return left.namespaceId === right.namespaceId
    && left.namespaceAccessRevision === right.namespaceAccessRevision
    && left.namespaceKeyGeneration === right.namespaceKeyGeneration
    && left.domainId === right.domainId
    && left.domainKeyGeneration === right.domainKeyGeneration
    && left.domainAuthorizationRevision === right.domainAuthorizationRevision
    && left.bundleRevision === right.bundleRevision
    && sameBytes(left.namespaceHeadDigest, right.namespaceHeadDigest)
    && sameBytes(
      left.namespacePublicationDigest,
      right.namespacePublicationDigest,
    )
    && sameBytes(
      left.namespacePublicationSetDigest,
      right.namespacePublicationSetDigest,
    )
    && sameBytes(
      left.namespaceAudienceFingerprint,
      right.namespaceAudienceFingerprint,
    )
    && sameBytes(left.domainHeadDigest, right.domainHeadDigest)
    && sameBytes(left.bundleDigest, right.bundleDigest);
}

function operationsAreCanonical(
  operations: readonly AgentEntityCryptoOperation[],
): boolean {
  return operations.length > 0
    && !operations.some((operation, index) =>
      (operation !== "decrypt" && operation !== "encrypt")
      || (index > 0 && operations[index - 1]! >= operation)
    );
}

function unavailable<Value>(
  reason: "authorization_unavailable" | "content_unavailable",
): AgentEntityCryptoResult<Value> {
  return Object.freeze({ status: "unavailable", reason });
}

function authorityFailure(error: unknown): TaskMemoryAuthorityUnavailable {
  return error instanceof TaskMemoryAuthorityUnavailable
    ? error
    : new TaskMemoryAuthorityUnavailable("Task Memory authority is unavailable");
}

export type NativeTaskMemoryEntityCryptoInput<Value> = Readonly<{
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverScope: string;
  evidence: TaskRuntimeExecutionEvidence;
  domains: readonly DomainForegroundSecretEntry[];
  signal: AbortSignal;
  /** Reprove the exact active TaskRun and its complete grant authority. */
  assertCurrentTaskAuthority(): Promise<void>;
  execute(entities: AgentEntityCryptoInvocation): Promise<Value>;
}>;

/**
 * Namespace-key custody for one active native Task execution.
 *
 * Domain secrets remain owned by the parent grant. This invocation owns only
 * public coordinate snapshots and the local cancellation/drain boundary.
 */
export async function withNativeTaskMemoryEntityCrypto<Value>(
  input: NativeTaskMemoryEntityCryptoInput<Value>,
  namespaceKeys?: NamespaceKeys,
): Promise<Value> {
  if (
    !(input.signal instanceof AbortSignal)
    || typeof input.assertCurrentTaskAuthority !== "function"
    || typeof input.execute !== "function"
  ) throw new TypeError("Native Task Memory invocation is invalid");

  const evidence = input.evidence;
  assertAuthenticTaskRuntimeExecutionEvidence(evidence);

  const ownedPublicSnapshots: Uint8Array[] = [];
  const domains = new Map<string, BorrowedDomain>();
  const expectedDomains = new Map(
    evidence.domainRequirements.map((domain) => [domain.domainId, domain]),
  );
  if (
    expectedDomains.size !== evidence.domainRequirements.length
    || input.domains.length !== evidence.domainRequirements.length
  ) throw new TypeError("Task Memory Domain custody is incomplete");

  try {
    for (const source of input.domains) {
      const expected = expectedDomains.get(source.domainId);
      if (
        expected === undefined
        || domains.has(source.domainId)
        || source.keyClass !== "ai"
        || source.sourceNamespaceId !== expected.sourceNamespaceId
        || source.domainKeyGeneration !== expected.domainKeyGeneration
        || source.authorizationRevision !== expected.authorizationRevision
        || source.participantCount !== expected.participantCount
        || !(source.participantDigest instanceof Uint8Array)
        || !(source.headDigest instanceof Uint8Array)
        || !(source.domainKey instanceof Uint8Array)
        || source.domainKey.length !== 32
        || !sameBytes(source.participantDigest, expected.participantDigest)
        || !sameBytes(source.headDigest, expected.headDigest)
      ) {
        throw new TypeError(
          "Task Memory Domain custody disagrees with execution evidence",
        );
      }
      const participantDigest = source.participantDigest.slice();
      const headDigest = source.headDigest.slice();
      ownedPublicSnapshots.push(participantDigest, headDigest);
      domains.set(source.domainId, Object.freeze({
        domainId: source.domainId,
        sourceNamespaceId: source.sourceNamespaceId,
        participantDigest,
        participantCount: source.participantCount,
        keyClass: "ai" as const,
        domainKeyGeneration: source.domainKeyGeneration,
        authorizationRevision: source.authorizationRevision,
        headDigest,
        domainKey: source.domainKey,
      }));
    }
  } catch (error) {
    ownedPublicSnapshots.forEach((bytes) => bytes.fill(0));
    throw error;
  }

  const namespaceRequirements = new Map(
    evidence.namespaceRequirements.map((requirement) => [
      requirement.namespaceId,
      requirement,
    ]),
  );
  if (
    namespaceRequirements.size !== evidence.namespaceRequirements.length
    || evidence.namespaceRequirements.some((requirement) =>
      requirement.expectedPolicyRevision !== evidence.policyRevision
      || !domains.has(requirement.domainId)
    )
  ) {
    ownedPublicSnapshots.forEach((bytes) => bytes.fill(0));
    throw new TypeError("Task Memory Namespace custody is invalid");
  }

  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort(input.signal.reason);
  if (input.signal.aborted) forwardAbort();
  else input.signal.addEventListener("abort", forwardAbort, { once: true });
  let accepting = true;

  const assertActive = (): void => {
    if (!accepting) {
      throw new TaskMemoryAuthorityUnavailable(
        "Native Task Memory invocation is closed",
      );
    }
    try {
      controller.signal.throwIfAborted();
      assertAuthenticTaskRuntimeExecutionEvidence(evidence);
    } catch (error) {
      throw authorityFailure(error);
    }
  };

  let handle: Awaited<ReturnType<typeof verifyCryptoPostgresHandle>>;
  try {
    assertActive();
    handle = await verifyCryptoPostgresHandle(input.restricted);
    assertActive();
  } catch (error) {
    controller.abort(error);
    input.signal.removeEventListener("abort", forwardAbort);
    ownedPublicSnapshots.forEach((bytes) => bytes.fill(0));
    throw error;
  }

  const keys = namespaceKeys ?? new PostgresDomainKeyAuthorityRepository(
    input.restricted,
    input.crypto,
    input.serverScope,
  );

  const allowedRequirement = (
    namespaceId: string,
    operations: readonly AgentEntityCryptoOperation[],
  ) => {
    const requirement = namespaceRequirements.get(namespaceId);
    return requirement !== undefined
      && operationsAreCanonical(operations)
      && operations.every((operation) =>
        requirement.operations.includes(operation)
      )
      ? requirement
      : null;
  };

  const assertCurrentTask = async (): Promise<void> => {
    assertActive();
    try {
      await input.assertCurrentTaskAuthority();
    } catch (error) {
      throw authorityFailure(error);
    }
    assertActive();
  };

  const reproveDomain = async (domain: BorrowedDomain): Promise<void> => {
    assertActive();
    let rows: readonly Readonly<{
      domain_id: string;
      domain_key_generation: number;
      authorization_revision: number;
      head_digest: Uint8Array;
      participant_digest: Uint8Array;
      participant_count: number;
    }>[];
    try {
      rows = await executeTypedCryptoQuery(
        handle,
        cryptoTypedDb
          .select({
            domain_id: domainKeyHeads.domainId,
            domain_key_generation: domainKeyHeads.domainKeyGeneration,
            authorization_revision: domainKeyHeads.authorizationRevision,
            head_digest: domainKeyHeads.headDigest,
            participant_digest: domainKeyHeads.participantDigest,
            participant_count: domainKeyHeads.participantCount,
          })
          .from(domainKeyHeads)
          .where(and(
            eq(domainKeyHeads.domainId, domain.domainId),
            eq(domainKeyHeads.keyClass, "ai"),
          ))
          .limit(2),
      );
    } catch (error) {
      throw authorityFailure(error);
    }
    assertActive();
    const row = rows[0];
    if (
      rows.length !== 1
      || row === undefined
      || row.domain_id !== domain.domainId
      || readCryptoStorageInteger(row, "domain_key_generation")
        !== domain.domainKeyGeneration
      || readCryptoStorageInteger(row, "authorization_revision")
        !== domain.authorizationRevision
      || readCryptoStorageInteger(row, "participant_count")
        !== domain.participantCount
      || !(row.head_digest instanceof Uint8Array)
      || !sameBytes(row.head_digest, domain.headDigest)
      || !(row.participant_digest instanceof Uint8Array)
      || !sameBytes(row.participant_digest, domain.participantDigest)
    ) throw new TaskMemoryAuthorityUnavailable(
      "Task Memory Domain authority changed",
    );
  };

  const inspect = async (
    namespaceId: string,
    operations: readonly AgentEntityCryptoOperation[],
  ): Promise<InspectedNamespace | null> => {
    assertActive();
    const requirement = allowedRequirement(namespaceId, operations);
    if (requirement === null) return null;
    await assertCurrentTask();
    let authority: Awaited<
      ReturnType<NamespaceKeys["inspectForegroundNamespaceAuthority"]>
    >;
    try {
      authority = await keys.inspectForegroundNamespaceAuthority({
        namespaceId,
        keyClass: "ai",
      });
    } catch (error) {
      throw authorityFailure(error);
    }
    if (authority.status !== "ready") {
      assertActive();
      return null;
    }
    const domain = domains.get(requirement.domainId);
    try {
      assertActive();
      if (
        authority.namespaceId !== namespaceId
        || authority.namespaceAccessRevision
          !== requirement.expectedAccessRevision
        || requirement.expectedPolicyRevision !== evidence.policyRevision
        || domain === undefined
        || authority.domainId !== domain.domainId
        || authority.domainKeyGeneration !== domain.domainKeyGeneration
        || authority.domainAuthorizationRevision
          !== domain.authorizationRevision
        || !sameBytes(authority.domainHeadDigest, domain.headDigest)
      ) {
        wipeAuthority(authority);
        return null;
      }
      return Object.freeze({
        authority,
        callbackAuthority: callbackAuthority(authority),
        domain,
      });
    } catch (error) {
      wipeAuthority(authority);
      throw error;
    }
  };

  const reprove = async (
    inspected: readonly InspectedNamespace[],
  ): Promise<void> => {
    await assertCurrentTask();
    for (const initial of inspected) {
      let current: Awaited<
        ReturnType<NamespaceKeys["inspectForegroundNamespaceAuthority"]>
      >;
      try {
        current = await keys.inspectForegroundNamespaceAuthority({
          namespaceId: initial.authority.namespaceId,
          keyClass: "ai",
        });
      } catch (error) {
        throw authorityFailure(error);
      }
      if (current.status !== "ready") {
        assertActive();
        throw new TaskMemoryAuthorityUnavailable(
          "Task Memory Namespace authority is unavailable",
        );
      }
      try {
        assertActive();
        if (!sameAuthority(initial.authority, current)) {
          throw new TaskMemoryAuthorityUnavailable(
            "Task Memory Namespace authority changed",
          );
        }
      } finally {
        wipeAuthority(current);
      }
    }
    const uniqueDomains = new Map(
      inspected.map((entry) => [entry.domain.domainId, entry.domain]),
    );
    for (const domain of uniqueDomains.values()) await reproveDomain(domain);
    assertActive();
  };

  const executeWithReproof = async <Result>(
    inspected: readonly InspectedNamespace[],
    execute: () => Promise<Result> | Result,
  ): Promise<Result> => {
    await reprove(inspected);
    let value: Result | undefined;
    let callbackError: unknown;
    let callbackFailed = false;
    try {
      value = await execute();
    } catch (error) {
      callbackFailed = true;
      callbackError = error;
    }
    try {
      await reprove(inspected);
    } catch (error) {
      if (!callbackFailed) throw error;
    }
    if (callbackFailed) throw callbackError;
    return value as Result;
  };

  const use = async <Result>(request: Readonly<{
    operations: readonly AgentEntityCryptoOperation[];
    entity: Readonly<{
      namespaceId: string;
      keyGeneration: number;
      accessRevision: number;
    }>;
    execute(context: OpenedNamespace): Promise<Result> | Result;
  }>): Promise<AgentEntityCryptoResult<Result>> => {
    let current: InspectedNamespace | null;
    try {
      current = await inspect(request.entity.namespaceId, request.operations);
    } catch {
      return unavailable("authorization_unavailable");
    }
    if (current === null) return unavailable("content_unavailable");
    const { authority, domain } = current;
    try {
      if (
        request.operations.includes("encrypt")
        && (
          request.entity.keyGeneration !== authority.namespaceKeyGeneration
          || request.entity.accessRevision !== authority.namespaceAccessRevision
        )
      ) return unavailable("content_unavailable");
      let opened: AgentEntityCryptoResult<Result> | null;
      try {
        opened = await keys.withOpenedForegroundNamespaceKey({
          authority,
          domainKey: domain.domainKey,
          keyGeneration: request.entity.keyGeneration,
          accessRevision: request.entity.accessRevision,
          use: (namespaceKey) => executeWithReproof([current], async () =>
            Object.freeze({
              status: "executed" as const,
              value: await request.execute(Object.freeze({
                namespaceKey,
                authority: current.callbackAuthority,
              })),
            })
          ),
        });
      } catch (error) {
        if (error instanceof TaskMemoryAuthorityUnavailable) {
          return unavailable("authorization_unavailable");
        }
        throw error;
      }
      return opened ?? unavailable("content_unavailable");
    } finally {
      wipeAuthority(authority);
      wipeCallbackAuthority(current.callbackAuthority);
    }
  };

  const useCurrentSet = async <Result>(request: Readonly<{
    operations: readonly AgentEntityCryptoOperation[];
    namespaceIds: readonly string[];
    execute(items: readonly OpenedNamespace[]): Promise<Result> | Result;
  }>): Promise<AgentEntityCryptoResult<Result>> => {
    if (
      request.namespaceIds.length < 1
      || request.namespaceIds.some((namespaceId, index) =>
        allowedRequirement(namespaceId, request.operations) === null
        || (index > 0 && request.namespaceIds[index - 1]! >= namespaceId)
      )
    ) return unavailable("content_unavailable");

    const inspected: InspectedNamespace[] = [];
    const opened: OpenedNamespace[] = [];
    try {
      try {
        for (const namespaceId of request.namespaceIds) {
          const current = await inspect(namespaceId, request.operations);
          if (current === null) return unavailable("content_unavailable");
          inspected.push(current);
        }
      } catch {
        return unavailable("authorization_unavailable");
      }

      const next = async (
        index: number,
      ): Promise<AgentEntityCryptoResult<Result>> => {
        assertActive();
        if (index === inspected.length) {
          const value = await executeWithReproof(inspected, () =>
            request.execute(Object.freeze([...opened]))
          );
          return Object.freeze({ status: "executed" as const, value });
        }
        const current = inspected[index]!;
        const result = await keys.withOpenedForegroundNamespaceKey({
          authority: current.authority,
          domainKey: current.domain.domainKey,
          keyGeneration: current.authority.namespaceKeyGeneration,
          accessRevision: current.authority.namespaceAccessRevision,
          use: async (namespaceKey) => {
            opened.push(Object.freeze({
              namespaceKey,
              authority: current.callbackAuthority,
            }));
            try {
              return await next(index + 1);
            } finally {
              opened.pop();
            }
          },
        });
        return result ?? unavailable("content_unavailable");
      };

      try {
        return await next(0);
      } catch (error) {
        if (error instanceof TaskMemoryAuthorityUnavailable) {
          return unavailable("authorization_unavailable");
        }
        throw error;
      }
    } finally {
      inspected.forEach(({ authority, callbackAuthority: exposed }) => {
        wipeAuthority(authority);
        wipeCallbackAuthority(exposed);
      });
    }
  };

  const inFlight = new Set<Promise<AgentEntityCryptoResult<unknown>>>();
  const admit = <Result>(
    operation: () => Promise<AgentEntityCryptoResult<Result>>,
  ): Promise<AgentEntityCryptoResult<Result>> => {
    if (!accepting) {
      return Promise.reject(new TypeError(
        "Native Task Memory invocation is closed",
      ));
    }
    const pending = operation();
    inFlight.add(pending);
    void pending.then(
      () => inFlight.delete(pending),
      () => inFlight.delete(pending),
    );
    return pending;
  };

  const entities: AgentEntityCryptoInvocation = Object.freeze({
    signal: controller.signal,
    use: <Result>(request: Readonly<{
      operations: readonly AgentEntityCryptoOperation[];
      entity: Readonly<{
        namespaceId: string;
        keyGeneration: number;
        accessRevision: number;
      }>;
      execute(context: OpenedNamespace): Promise<Result> | Result;
    }>) => admit(() => use(request)),
    useCurrentSet: <Result>(
      request: Readonly<{
        operations: readonly AgentEntityCryptoOperation[];
        namespaceIds: readonly string[];
        execute(items: readonly OpenedNamespace[]): Promise<Result> | Result;
      }>,
    ) => admit(() => useCurrentSet(request)),
  });

  let value: Value | undefined;
  let executeError: unknown;
  let executeFailed = false;
  let unfinished = false;
  try {
    await assertCurrentTask();
    value = await input.execute(entities);
    await assertCurrentTask();
  } catch (error) {
    executeFailed = true;
    executeError = error;
  } finally {
    accepting = false;
    controller.abort(new TypeError("Native Task Memory invocation is closed"));
    input.signal.removeEventListener("abort", forwardAbort);
    const pending = [...inFlight];
    unfinished = pending.length > 0;
    await Promise.allSettled(pending);
    ownedPublicSnapshots.forEach((bytes) => bytes.fill(0));
  }
  if (executeFailed) throw executeError;
  if (unfinished) {
    throw new TypeError(
      "Native Task Memory invocation ended with unfinished key use",
    );
  }
  return value as Value;
}
