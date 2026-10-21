import type { PostgresJsBridgeConnection } from "@nautilo/db";
import { ClassifiedDataOperationError, withProtectedTaskResultSigner,
  withProtectedTaskTemporaryResultSigner,
  type ProtectedTaskExecutionSignerAuthority } from "@nautilo/lattice-bridge";
import { PostgresLatticeStorage, verifyCryptoPostgresHandle } from "@nautilo/lattice-bridge/server";
import { assertAuthenticTaskRuntimeExecutionEvidence, hasTaskRuntimeTemporarySigner,
  type DomainForegroundSecretEntry,
  type LatticeCrypto, type TaskRuntimeExecutionEvidence } from "@nautilo/lattice-crypto";
import { withProtectedTaskResultSignerHistory } from "./protected-task-result-signer-history";

type ProtectedTaskHistoricalSignerPublicationResolver = Parameters<Parameters<typeof withProtectedTaskResultSignerHistory>[0]["use"]>[0]["resolveHistoricalSignerPublicationManager"];

function wipeNested(value: unknown): void {
  if (value instanceof Uint8Array) value.fill(0);
  else if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) wipeNested(nested);
  }
}

export async function withProtectedTaskRuntimeSigner<Value>(input: Readonly<{
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  evidence: TaskRuntimeExecutionEvidence;
  domains: readonly DomainForegroundSecretEntry[];
  use(
    signer: ProtectedTaskExecutionSignerAuthority,
    resolveHistoricalSignerPublicationManager:
      ProtectedTaskHistoricalSignerPublicationResolver,
  ): Promise<Value>;
}>): Promise<Value> {
  assertAuthenticTaskRuntimeExecutionEvidence(input.evidence);
  const domains = input.domains.filter(domain =>
    domain.domainId === input.evidence.result.namespace.domainId
  );
  const domain = domains[0];
  if (domains.length !== 1 || domain === undefined || domain.keyClass !== "ai") {
    throw new ClassifiedDataOperationError(
      "authority",
      "Protected Task Memory result Domain is unavailable",
    );
  }
  if (hasTaskRuntimeTemporarySigner(input.evidence)) {
    return withProtectedTaskTemporaryResultSigner({
      evidence: input.evidence,
      domain,
      execute: async signer => {
        const value = await input.use(signer, () => null);
        assertAuthenticTaskRuntimeExecutionEvidence(input.evidence);
        return value;
      },
    });
  }
  const handle = await verifyCryptoPostgresHandle(input.restricted);
  const storage = new PostgresLatticeStorage(handle);
  const state = await storage.getAgentRuntimeAtomicState(
    input.evidence.result.signerAgentId,
  );
  let authorizationRevision: number;
  let runtimeGeneration: number;
  try {
    if (state === null
      || state.runtime.agentId !== input.evidence.result.signerAgentId) {
      throw new ClassifiedDataOperationError(
        "authority",
        "Protected Task Memory Runtime signer is unavailable",
      );
    }
    authorizationRevision = state.runtime.authorizationRevision;
    runtimeGeneration = state.runtime.runtimeGeneration;
  } finally {
    wipeNested(state);
  }
  return withProtectedTaskResultSignerHistory({
    handle,
    crypto: input.crypto,
    agentId: input.evidence.result.signerAgentId,
    domainId: domain.domainId,
    domainEpoch: domain.domainKeyGeneration,
    expectedAgentAuthorizationRevision: authorizationRevision,
    expectedRuntimeGeneration: runtimeGeneration,
    use: async history => {
      const opened = await withProtectedTaskResultSigner({
        crypto: input.crypto,
        storage,
        evidence: input.evidence,
        domain,
        expectedAgentAuthorizationRevision: authorizationRevision,
        resolveHistoricalRuntimeCommitter:
          history.resolveHistoricalRuntimeCommitter,
        resolveHistoricalSignerPublicationManager:
          history.resolveHistoricalSignerPublicationManager,
        execute: signer => input.use(
          signer,
          history.resolveHistoricalSignerPublicationManager,
        ),
      });
      if (opened.status !== "executed") {
        throw new ClassifiedDataOperationError(
          "authority",
          "Protected Task Memory Runtime signer is unavailable",
        );
      }
      return opened.value;
    },
  });
}
