import {
  agentId,
  agentRuntimeSignerPublicationMatchesRuntime,
  assertAuthenticTaskRuntimeCancellationResultEvidence,
  assertAuthenticTaskRuntimeExecutionEvidence,
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

type ResultSignerEvidence = TaskRuntimeExecutionEvidence
  | TaskRuntimeCancellationResultEvidence;

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
    agentId: agentId(input.evidence.result.signerAgentId),
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
      authority: ProtectedTaskResultSignerAuthority,
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
  return withAuthenticatedProtectedTaskResultSigner({
    ...input,
    assertAuthenticEvidence: () =>
      assertAuthenticTaskRuntimeCancellationResultEvidence(input.evidence),
  });
}
