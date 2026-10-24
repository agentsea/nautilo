import {
  agentId,
  agentRuntimeSignerPublicationMatchesRuntime,
  assertAuthenticTaskRuntimeCancellationResultEvidence,
  assertAuthenticTaskRuntimeExecutionEvidence,
  assertAuthenticTaskRuntimeRunResultReadEvidence,
  assertAuthenticTaskRuntimeTerminalMessageEvidence,
  assertAuthenticTaskRuntimeWakeForegroundEvidence,
  authorizationRevision,
  cryptoDomainId,
  domainEpoch,
  verifyHistoricalAgentRuntimeSignerPublication,
  type AgentRuntimeKeyGeneration,
  type AgentRuntimeSignerPublication,
  type DomainForegroundSecretEntry,
  type LatticeCrypto,
  type LatticeStorage,
  type ResolveHistoricalAgentRuntimeSignerPublicationManager,
  type TaskRuntimeCancellationResultEvidence,
  type TaskRuntimeExecutionEvidence,
  type TaskRuntimeRunResultReadEvidence,
  type TaskRuntimeTerminalMessageEvidence,
  type TaskRuntimeWakeForegroundEvidence,
  type TaskRuntimeTemporarySigner,
  hasTaskRuntimeTemporarySigner,
  withTaskRuntimeTemporarySigner,
} from "@nautilo/lattice-crypto";
import type {
  HistoricalAgentRuntimeCommitterResolverV1,
} from "@nautilo/lattice-crypto/wire";

import {
  openProtectedAgentRuntimeFromDomainRoot,
} from "../invocation/protected-agent-runtime-domain-root.ts";

export type ProtectedTaskResultSignerAuthority = Readonly<{
  agentAuthorizationRevision: number;
  runtime: AgentRuntimeKeyGeneration;
  signerPublication: AgentRuntimeSignerPublication;
}>;

/** Initial native execution may borrow the Device-certified, in-memory signer. */
export type ProtectedTaskExecutionSignerAuthority =
  | (ProtectedTaskResultSignerAuthority & Readonly<{ temporarySigner?: never }>)
  | Readonly<{
    agentAuthorizationRevision: 0;
    runtime: AgentRuntimeKeyGeneration;
    signerPublication: null;
    temporarySigner: TaskRuntimeTemporarySigner;
  }>;

/** Publication reuses the same bounded signer loan and retained public proof. */
export type ProtectedTaskPublicationSignerAuthority = ProtectedTaskExecutionSignerAuthority;

/** Borrow only through the same exact execution/result Domain boundary. */
export async function withProtectedTaskTemporaryResultSigner<Value>(input: Readonly<{
  evidence: TaskRuntimeExecutionEvidence;
  domain: DomainForegroundSecretEntry;
  execute(signer: Extract<ProtectedTaskExecutionSignerAuthority,
    { signerPublication: null }>): Value | PromiseLike<Value>;
}>): Promise<Value> {
  assertAuthenticTaskRuntimeExecutionEvidence(input.evidence);
  if (!executionResultAuthorityMatches(input.evidence, input.domain)
    || !hasTaskRuntimeTemporarySigner(input.evidence)) {
    throw new TypeError("Temporary Task result signer Domain authority is unavailable");
  }
  return withTaskRuntimeTemporarySigner(input.evidence, temporarySigner =>
    input.execute(Object.freeze({
      agentAuthorizationRevision: 0,
      runtime: temporarySigner.runtime,
      signerPublication: null,
      temporarySigner,
    })));
}

export type ProtectedTaskResultSignerResult<Value> =
  | Readonly<{ status: "executed"; value: Value }>
  | Readonly<{
    status: "unavailable";
    reason:
      | "authority_unavailable"
      | "runtime_unavailable"
      | "signer_unavailable";
  }>;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function executionResultAuthorityMatches(
  evidence: TaskRuntimeExecutionEvidence,
  domain: DomainForegroundSecretEntry,
): boolean {
  const result = evidence.result;
  const namespaceRequirements = evidence.namespaceRequirements.filter(
    (requirement) => requirement.namespaceId === result.namespace.namespaceId,
  );
  const domainRequirements = evidence.domainRequirements.filter(
    (requirement) => requirement.domainId === result.namespace.domainId,
  );
  const namespaceRequirement = namespaceRequirements[0];
  const domainRequirement = domainRequirements[0];
  return evidence.purpose === "task.runtime.execution"
    && result.taskRunId === evidence.workId
    && result.namespace.operations.length === 1
    && result.namespace.operations[0] === "encrypt"
    && result.namespace.expectedPolicyRevision === evidence.policyRevision
    && namespaceRequirements.length === 1
    && namespaceRequirement !== undefined
    && namespaceRequirement.domainId === result.namespace.domainId
    && namespaceRequirement.expectedAccessRevision
      === result.namespace.expectedAccessRevision
    && namespaceRequirement.expectedPolicyRevision
      === result.namespace.expectedPolicyRevision
    && namespaceRequirement.operations.length === 2
    && namespaceRequirement.operations[0] === "decrypt"
    && namespaceRequirement.operations[1] === "encrypt"
    && domainRequirements.length === 1
    && domainRequirement !== undefined
    && domain.domainId === result.namespace.domainId
    && domain.domainId === domainRequirement.domainId
    && domain.sourceNamespaceId === domainRequirement.sourceNamespaceId
    && domain.keyClass === "ai"
    && domainRequirement.keyClass === "ai"
    && domain.domainKeyGeneration === domainRequirement.domainKeyGeneration
    && domain.authorizationRevision === domainRequirement.authorizationRevision
    && domain.participantCount === domainRequirement.participantCount
    && sameBytes(domain.participantDigest, domainRequirement.participantDigest)
    && sameBytes(domain.headDigest, domainRequirement.headDigest);
}

function cancellationResultAuthorityMatches(
  evidence: TaskRuntimeCancellationResultEvidence,
  domain: DomainForegroundSecretEntry,
): boolean {
  const result = evidence.result;
  const namespaceRequirement = evidence.namespaceRequirements[0];
  const domainRequirement = evidence.domainRequirements[0];
  return evidence.purpose === "task.runtime.cancellation_result"
    && evidence.operations.length === 1
    && evidence.operations[0] === "encrypt"
    && result.taskRunId === evidence.workId
    && result.contentRevision === 2
    && result.namespace.operations.length === 1
    && result.namespace.operations[0] === "encrypt"
    && result.namespace.expectedPolicyRevision === evidence.policyRevision
    && evidence.namespaceRequirements.length === 1
    && namespaceRequirement !== undefined
    && namespaceRequirement.ordinal === 0
    && namespaceRequirement.namespaceId === result.namespace.namespaceId
    && namespaceRequirement.domainId === result.namespace.domainId
    && namespaceRequirement.expectedAccessRevision
      === result.namespace.expectedAccessRevision
    && namespaceRequirement.expectedPolicyRevision
      === result.namespace.expectedPolicyRevision
    && namespaceRequirement.operations.length === 1
    && namespaceRequirement.operations[0] === "encrypt"
    && evidence.domainRequirements.length === 1
    && domainRequirement !== undefined
    && domainRequirement.domainId === result.namespace.domainId
    && domainRequirement.sourceNamespaceId === result.namespace.namespaceId
    && domain.domainId === domainRequirement.domainId
    && domain.sourceNamespaceId === domainRequirement.sourceNamespaceId
    && domain.keyClass === "ai"
    && domainRequirement.keyClass === "ai"
    && domain.domainKeyGeneration === domainRequirement.domainKeyGeneration
    && domain.authorizationRevision === domainRequirement.authorizationRevision
    && domain.participantCount === domainRequirement.participantCount
    && sameBytes(domain.participantDigest, domainRequirement.participantDigest)
    && sameBytes(domain.headDigest, domainRequirement.headDigest);
}

function terminalMessageAuthorityMatches(
  evidence: TaskRuntimeTerminalMessageEvidence,
  domain: DomainForegroundSecretEntry,
): boolean {
  const message = evidence.message;
  const namespaceRequirement = evidence.namespaceRequirements[0];
  const domainRequirement = evidence.domainRequirements[0];
  return evidence.purpose === "task.runtime.terminal_message"
    && evidence.workKind === "task.deliver_message"
    && evidence.operations.length === 1
    && evidence.operations[0] === "encrypt"
    && message.taskRunId === evidence.workId
    && message.roomId === evidence.sourceRoomId
    && message.publicationPolicyRevision === evidence.policyRevision
    && message.acceptedPolicyRevision <= evidence.policyRevision
    && evidence.namespaceRequirements.length === 1
    && namespaceRequirement !== undefined
    && namespaceRequirement.ordinal === 0
    && namespaceRequirement.namespaceId === message.namespaceId
    && namespaceRequirement.domainId === message.domainId
    && namespaceRequirement.expectedPolicyRevision === evidence.policyRevision
    && namespaceRequirement.operations.length === 1
    && namespaceRequirement.operations[0] === "encrypt"
    && evidence.domainRequirements.length === 1
    && domainRequirement !== undefined
    && domainRequirement.domainId === message.domainId
    && domainRequirement.sourceNamespaceId === message.namespaceId
    && domain.domainId === domainRequirement.domainId
    && domain.sourceNamespaceId === domainRequirement.sourceNamespaceId
    && domain.keyClass === "ai"
    && domainRequirement.keyClass === "ai"
    && domain.domainKeyGeneration === domainRequirement.domainKeyGeneration
    && domain.authorizationRevision === domainRequirement.authorizationRevision
    && domain.participantCount === domainRequirement.participantCount
    && sameBytes(domain.participantDigest, domainRequirement.participantDigest)
    && sameBytes(domain.headDigest, domainRequirement.headDigest);
}

function runResultMessageAuthorityMatches(
  evidence: TaskRuntimeRunResultReadEvidence,
  domain: DomainForegroundSecretEntry,
): boolean {
  const result = evidence.result;
  const invocation = evidence.invocation;
  const write = evidence.messageWrite;
  if (evidence.purpose !== "task.runtime.run_result_read"
    || evidence.workKind !== "task.deliver_result"
    || result.contentRevision !== 1
    || (result.terminalStatus !== "completed" && result.terminalStatus !== "errored")
    || invocation.kind !== "raw"
    || write === null) return false;
  const namespace = write.namespace;
  const current = write.domain;
  return write.taskId === result.taskId
    && write.taskRunId === result.taskRunId
    && write.bindingId === invocation.bindingId
    && write.messageOperationId === invocation.operationId
    && write.roomId === invocation.roomId
    && write.sessionId === invocation.sessionId
    && write.signerAgentId === result.signerAgentId
    && namespace.operations.length === 1
    && namespace.operations[0] === "encrypt"
    && namespace.expectedPolicyRevision === evidence.policyRevision
    && current.domainId === namespace.domainId
    && current.keyClass === "ai"
    && domain.domainId === current.domainId
    && domain.sourceNamespaceId === current.sourceNamespaceId
    && domain.keyClass === "ai"
    && domain.domainKeyGeneration === current.domainKeyGeneration
    && domain.authorizationRevision === current.authorizationRevision
    && domain.participantCount === current.participantCount
    && sameBytes(domain.participantDigest, current.participantDigest)
    && sameBytes(domain.headDigest, current.headDigest);
}

type ResultSignerEvidence = TaskRuntimeExecutionEvidence
  | TaskRuntimeCancellationResultEvidence
  | TaskRuntimeTerminalMessageEvidence
  | TaskRuntimeRunResultReadEvidence
  | TaskRuntimeWakeForegroundEvidence;

function signerAgentId(evidence: ResultSignerEvidence): string {
  if (evidence.purpose === "task.runtime.wake_foreground") return evidence.signerAgentId;
  return evidence.purpose === "task.runtime.terminal_message"
    ? evidence.message.signerAgentId
    : evidence.result.signerAgentId;
}

type ProtectedTaskResultSignerInput<Value> = Readonly<{
  crypto: LatticeCrypto;
  storage: Pick<
    LatticeStorage,
    "getAgentRuntimeAtomicState" | "getAgentRuntimeSignerPublication"
  >;
  evidence: ResultSignerEvidence;
  domain: DomainForegroundSecretEntry;
  expectedAgentAuthorizationRevision: number;
  resolveHistoricalRuntimeCommitter:
    HistoricalAgentRuntimeCommitterResolverV1;
  resolveHistoricalSignerPublicationManager:
    ResolveHistoricalAgentRuntimeSignerPublicationManager;
  assertAuthenticEvidence(): void;
  execute(
    authority: ProtectedTaskResultSignerAuthority,
  ): Value | PromiseLike<Value>;
}>;

async function withAuthenticatedProtectedTaskResultSigner<Value>(
  input: ProtectedTaskResultSignerInput<Value>,
): Promise<ProtectedTaskResultSignerResult<Value>> {
  input.assertAuthenticEvidence();
  const expectedAgentAuthorizationRevision = authorizationRevision(
    input.expectedAgentAuthorizationRevision,
  );
  const opened = await openProtectedAgentRuntimeFromDomainRoot({
    crypto: input.crypto,
    storage: input.storage,
    domain: {
      domainId: cryptoDomainId(input.domain.domainId),
      domainEpoch: domainEpoch(input.domain.domainKeyGeneration),
      agentAuthorizationRevision: expectedAgentAuthorizationRevision,
      domainRoot: input.domain.domainKey,
    },
    expectedRuntimeAuthorizationRevision: expectedAgentAuthorizationRevision,
    agentId: agentId(signerAgentId(input.evidence)),
    resolveHistoricalCommitter: input.resolveHistoricalRuntimeCommitter,
  });
  if (opened === null) {
    input.assertAuthenticEvidence();
    return Object.freeze({
      status: "unavailable" as const,
      reason: "runtime_unavailable" as const,
    });
  }
  try {
    input.assertAuthenticEvidence();
    let publication: AgentRuntimeSignerPublication | null;
    try {
      publication = await input.storage.getAgentRuntimeSignerPublication(
        opened.runtime.agentId,
        opened.runtime.generation,
      );
    } catch {
      publication = null;
    }
    input.assertAuthenticEvidence();
    let signerIsCurrent = false;
    try {
      signerIsCurrent = publication !== null
        && publication.agentId === opened.runtime.agentId
        && publication.runtimeGeneration === opened.runtime.generation
        && publication.authorizationRevision
          === expectedAgentAuthorizationRevision
        && agentRuntimeSignerPublicationMatchesRuntime(
          input.crypto,
          opened.runtime,
          publication,
        )
        && verifyHistoricalAgentRuntimeSignerPublication({
          crypto: input.crypto,
          publication,
          resolveHistoricalManagerAuthority:
            input.resolveHistoricalSignerPublicationManager,
        });
    } catch {
      signerIsCurrent = false;
    }
    if (publication === null || !signerIsCurrent) {
      return Object.freeze({
        status: "unavailable" as const,
        reason: "signer_unavailable" as const,
      });
    }
    input.assertAuthenticEvidence();
    const value = await input.execute(Object.freeze({
      agentAuthorizationRevision: expectedAgentAuthorizationRevision,
      runtime: opened.runtime,
      signerPublication: publication,
    }));
    input.assertAuthenticEvidence();
    return Object.freeze({ status: "executed" as const, value });
  } finally {
    opened.runtime.key.fill(0);
  }
}

async function withAuthenticatedPublicationSigner<Value>(
  input: Omit<ProtectedTaskResultSignerInput<Value>, "execute"> & Readonly<{
    execute(authority: ProtectedTaskPublicationSignerAuthority): Value | PromiseLike<Value>;
  }>,
): Promise<ProtectedTaskResultSignerResult<Value>> {
  input.assertAuthenticEvidence();
  if (!hasTaskRuntimeTemporarySigner(input.evidence)) {
    return withAuthenticatedProtectedTaskResultSigner(input);
  }
  return withTaskRuntimeTemporarySigner(input.evidence, async temporarySigner => {
    input.assertAuthenticEvidence();
    if (temporarySigner.runtime.agentId !== signerAgentId(input.evidence)) {
      throw new TypeError("Temporary Task publication signer attribution disagrees");
    }
    const value = await input.execute(Object.freeze({
      agentAuthorizationRevision: 0,
      runtime: temporarySigner.runtime,
      signerPublication: null,
      temporarySigner,
    }));
    input.assertAuthenticEvidence();
    return Object.freeze({ status: "executed" as const, value });
  });
}

/**
 * Lend the current, historically authorized Agent Runtime signer only while an
 * authenticated Task execution holds the exact result Domain secret.
 */
export async function withProtectedTaskResultSigner<Value>(input: Readonly<{
  crypto: LatticeCrypto;
  storage: Pick<
    LatticeStorage,
    "getAgentRuntimeAtomicState" | "getAgentRuntimeSignerPublication"
  >;
  evidence: TaskRuntimeExecutionEvidence;
  domain: DomainForegroundSecretEntry;
  expectedAgentAuthorizationRevision: number;
  resolveHistoricalRuntimeCommitter:
    HistoricalAgentRuntimeCommitterResolverV1;
  resolveHistoricalSignerPublicationManager:
    ResolveHistoricalAgentRuntimeSignerPublicationManager;
  execute(
    authority: ProtectedTaskResultSignerAuthority,
  ): Value | PromiseLike<Value>;
}>): Promise<ProtectedTaskResultSignerResult<Value>> {
  assertAuthenticTaskRuntimeExecutionEvidence(input.evidence);
  if (!executionResultAuthorityMatches(input.evidence, input.domain)) {
    return Object.freeze({
      status: "unavailable" as const,
      reason: "authority_unavailable" as const,
    });
  }
  return withAuthenticatedProtectedTaskResultSigner({
    ...input,
    assertAuthenticEvidence: () =>
      assertAuthenticTaskRuntimeExecutionEvidence(input.evidence),
  });
}

/**
 * Lend the current, historically authorized Agent Runtime signer only while an
 * authenticated Task cancellation holds its exact encrypt-only result Domain.
 */
export async function withProtectedTaskCancellationResultSigner<Value>(
  input: Readonly<{
    crypto: LatticeCrypto;
    storage: Pick<
      LatticeStorage,
      "getAgentRuntimeAtomicState" | "getAgentRuntimeSignerPublication"
    >;
    evidence: TaskRuntimeCancellationResultEvidence;
    domain: DomainForegroundSecretEntry;
    expectedAgentAuthorizationRevision: number;
    resolveHistoricalRuntimeCommitter:
      HistoricalAgentRuntimeCommitterResolverV1;
    resolveHistoricalSignerPublicationManager:
      ResolveHistoricalAgentRuntimeSignerPublicationManager;
    execute(
      authority: ProtectedTaskPublicationSignerAuthority,
    ): Value | PromiseLike<Value>;
  }>,
): Promise<ProtectedTaskResultSignerResult<Value>> {
  assertAuthenticTaskRuntimeCancellationResultEvidence(input.evidence);
  if (!cancellationResultAuthorityMatches(input.evidence, input.domain)) {
    return Object.freeze({
      status: "unavailable" as const,
      reason: "authority_unavailable" as const,
    });
  }
  return withAuthenticatedPublicationSigner({
    ...input,
    assertAuthenticEvidence: () =>
      assertAuthenticTaskRuntimeCancellationResultEvidence(input.evidence),
  });
}

/**
 * Lend the current HIVE Runtime signer only for the destination Domain named
 * by authentic, callback-scoped terminal Message evidence.
 */
export async function withProtectedTaskTerminalMessageSigner<Value>(
  input: Readonly<{
    crypto: LatticeCrypto;
    storage: Pick<
      LatticeStorage,
      "getAgentRuntimeAtomicState" | "getAgentRuntimeSignerPublication"
    >;
    evidence: TaskRuntimeTerminalMessageEvidence;
    domain: DomainForegroundSecretEntry;
    expectedAgentAuthorizationRevision: number;
    resolveHistoricalRuntimeCommitter:
      HistoricalAgentRuntimeCommitterResolverV1;
    resolveHistoricalSignerPublicationManager:
      ResolveHistoricalAgentRuntimeSignerPublicationManager;
    execute(
      authority: ProtectedTaskPublicationSignerAuthority,
    ): Value | PromiseLike<Value>;
  }>,
): Promise<ProtectedTaskResultSignerResult<Value>> {
  assertAuthenticTaskRuntimeTerminalMessageEvidence(input.evidence);
  if (!terminalMessageAuthorityMatches(input.evidence, input.domain)) {
    return Object.freeze({
      status: "unavailable" as const,
      reason: "authority_unavailable" as const,
    });
  }
  return withAuthenticatedPublicationSigner({
    ...input,
    assertAuthenticEvidence: () =>
      assertAuthenticTaskRuntimeTerminalMessageEvidence(input.evidence),
  });
}

/**
 * Lend the current HIVE Runtime signer for the independently admitted raw
 * result Message destination while its result-read proof remains live.
 */
export async function withProtectedTaskRunResultMessageSigner<Value>(
  input: Readonly<{
    crypto: LatticeCrypto;
    storage: Pick<
      LatticeStorage,
      "getAgentRuntimeAtomicState" | "getAgentRuntimeSignerPublication"
    >;
    evidence: TaskRuntimeRunResultReadEvidence;
    domain: DomainForegroundSecretEntry;
    expectedAgentAuthorizationRevision: number;
    resolveHistoricalRuntimeCommitter:
      HistoricalAgentRuntimeCommitterResolverV1;
    resolveHistoricalSignerPublicationManager:
      ResolveHistoricalAgentRuntimeSignerPublicationManager;
    execute(
      authority: ProtectedTaskPublicationSignerAuthority,
    ): Value | PromiseLike<Value>;
  }>,
): Promise<ProtectedTaskResultSignerResult<Value>> {
  assertAuthenticTaskRuntimeRunResultReadEvidence(input.evidence);
  if (!runResultMessageAuthorityMatches(input.evidence, input.domain)) {
    return Object.freeze({
      status: "unavailable" as const,
      reason: "authority_unavailable" as const,
    });
  }
  return withAuthenticatedPublicationSigner({
    ...input,
    assertAuthenticEvidence: () =>
      assertAuthenticTaskRuntimeRunResultReadEvidence(input.evidence),
  });
}

/** Lend a HIVE signer through an independently admitted wake foreground Namespace. */
export async function withProtectedTaskWakeForegroundSigner<Value>(
  input: Omit<ProtectedTaskResultSignerInput<Value>, "evidence" | "assertAuthenticEvidence" | "execute"> & Readonly<{
    evidence: TaskRuntimeWakeForegroundEvidence;
    namespaceId: string;
    execute(authority: ProtectedTaskPublicationSignerAuthority): Value | PromiseLike<Value>;
  }>,
): Promise<ProtectedTaskResultSignerResult<Value>> {
  const evidence = input.evidence;
  const assertAuthority = (): void => {
    assertAuthenticTaskRuntimeWakeForegroundEvidence(evidence);
    const namespace = evidence.namespaceRequirements.find(n => n.namespaceId === input.namespaceId);
    const domain = evidence.domainRequirements.find(d => d.domainId === namespace?.domainId);
    if (namespace === undefined || domain === undefined
      || !namespace.operations.includes("encrypt")
      || namespace.expectedPolicyRevision !== evidence.policyRevision
      || input.domain.domainId !== domain.domainId
      || input.domain.sourceNamespaceId !== domain.sourceNamespaceId
      || input.domain.keyClass !== "ai"
      || input.domain.domainKeyGeneration !== domain.domainKeyGeneration
      || input.domain.authorizationRevision !== domain.authorizationRevision
      || input.domain.participantCount !== domain.participantCount
      || !sameBytes(input.domain.participantDigest, domain.participantDigest)
      || !sameBytes(input.domain.headDigest, domain.headDigest)) {
      throw new TypeError("Task wake foreground signer authority is unavailable");
    }
  };
  assertAuthenticTaskRuntimeWakeForegroundEvidence(evidence);
  try { assertAuthority(); } catch {
    return Object.freeze({ status: "unavailable", reason: "authority_unavailable" });
  }
  return withAuthenticatedPublicationSigner({
    ...input, assertAuthenticEvidence: assertAuthority,
  });
}
