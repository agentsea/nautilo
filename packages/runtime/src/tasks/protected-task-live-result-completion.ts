import {
  ClassifiedDataOperationError,
  withProtectedTaskResultNamespaceSource,
  withProtectedTaskResultSigner,
  type TaskContentAuthorityV1,
} from "@nautilo/lattice-bridge";
import type {
  DomainForegroundSecretEntry,
  HistoricalCommitterResolver,
  LatticeStorage,
} from "@nautilo/lattice-crypto";
import type { HistoricalAgentRuntimeCommitterResolverV1 } from
  "@nautilo/lattice-crypto/wire";

import {
  completeProtectedTaskRunResult,
  type CompleteProtectedTaskRunResultInput,
} from "./protected-task-result-completion";

type CurrentResultAuthority = Readonly<{
  content: TaskContentAuthorityV1;
  agentAuthorizationRevision: number;
}>;

export type CompleteProtectedTaskRunResultWithLiveAuthorityInput = Readonly<
  Omit<CompleteProtectedTaskRunResultInput,
    | "authority"
    | "namespace"
    | "agentAuthorizationRevision"
    | "runtime"
    | "signerPublication"
  > & {
    storage: Pick<LatticeStorage,
      | "getNamespaceHead"
      | "getBinding"
      | "getAgentRuntimeAtomicState"
      | "getAgentRuntimeSignerPublication"
    >;
    domains: readonly DomainForegroundSecretEntry[];
    resolveHistoricalCommitter: HistoricalCommitterResolver;
    resolveHistoricalRuntimeCommitter:
      HistoricalAgentRuntimeCommitterResolverV1;
    loadCurrentAuthority(): Promise<CurrentResultAuthority | null>;
  }
>;

type LiveResultDependencies = Readonly<{
  withNamespaceSource: typeof withProtectedTaskResultNamespaceSource;
  withSigner: typeof withProtectedTaskResultSigner;
  complete: typeof completeProtectedTaskRunResult;
}>;

const productionDependencies: LiveResultDependencies = Object.freeze({
  withNamespaceSource: withProtectedTaskResultNamespaceSource,
  withSigner: withProtectedTaskResultSigner,
  complete: completeProtectedTaskRunResult,
});

function sameContentAuthority(
  left: TaskContentAuthorityV1,
  right: TaskContentAuthorityV1,
): boolean {
  return left.authorityVersion === right.authorityVersion
    && left.kind === right.kind
    && left.keyClass === right.keyClass
    && left.requesterHumanId === right.requesterHumanId
    && left.namespaceId === right.namespaceId
    && left.domainId === right.domainId
    && left.expectedAccessRevision === right.expectedAccessRevision
    && left.expectedPolicyRevision === right.expectedPolicyRevision;
}

/**
 * Complete one TaskRun result while its Task, Namespace and Agent Runtime
 * authority remain current. The Domain root and Runtime signer stay inside the
 * grant callback; the repository makes the final policy/product CAS.
 */
export async function completeProtectedTaskRunResultWithLiveAuthority(
  input: CompleteProtectedTaskRunResultWithLiveAuthorityInput,
  dependencies: LiveResultDependencies = productionDependencies,
): Promise<Awaited<ReturnType<typeof completeProtectedTaskRunResult>>> {
  input.signal.throwIfAborted();
  const initial = await input.loadCurrentAuthority();
  if (
    initial === null
    || initial.content.namespaceId !== input.evidence.result.namespace.namespaceId
    || initial.content.domainId !== input.evidence.result.namespace.domainId
    || initial.content.expectedAccessRevision
      !== input.evidence.result.namespace.expectedAccessRevision
    || initial.content.expectedPolicyRevision !== input.evidence.policyRevision
    || !Number.isSafeInteger(initial.agentAuthorizationRevision)
    || initial.agentAuthorizationRevision < 1
  ) {
    throw new ClassifiedDataOperationError(
      "authority",
      "Protected Task result authority is unavailable",
    );
  }

  const assertCurrentAuthority = async (): Promise<void> => {
    input.signal.throwIfAborted();
    const current = await input.loadCurrentAuthority();
    if (
      current === null
      || !sameContentAuthority(current.content, initial.content)
      || current.agentAuthorizationRevision
        !== initial.agentAuthorizationRevision
    ) {
      throw new ClassifiedDataOperationError(
        "stale",
        "Protected Task result authority changed",
      );
    }
  };

  return dependencies.withNamespaceSource({
    crypto: input.crypto,
    storage: input.storage,
    evidence: input.evidence,
    domains: input.domains,
    signal: input.signal,
    resolveHistoricalCommitter: input.resolveHistoricalCommitter,
    assertCurrentTaskAuthority: assertCurrentAuthority,
    execute: async (namespace) => {
      await assertCurrentAuthority();
      const matchingDomains = input.domains.filter((domain) =>
        domain.domainId === initial.content.domainId
      );
      const domain = matchingDomains[0];
      if (matchingDomains.length !== 1 || domain === undefined) {
        throw new ClassifiedDataOperationError(
          "authority",
          "Protected Task result Domain is unavailable",
        );
      }
      const signed = await dependencies.withSigner({
        crypto: input.crypto,
        storage: input.storage,
        evidence: input.evidence,
        domain,
        expectedAgentAuthorizationRevision:
          initial.agentAuthorizationRevision,
        resolveHistoricalRuntimeCommitter:
          input.resolveHistoricalRuntimeCommitter,
        resolveHistoricalSignerPublicationManager:
          input.resolveHistoricalSignerPublicationManager,
        execute: async (signer) => {
          await assertCurrentAuthority();
          return dependencies.complete({
            ...input,
            authority: initial.content,
            namespace,
            agentAuthorizationRevision:
              signer.agentAuthorizationRevision,
            runtime: signer.runtime,
            signerPublication: signer.signerPublication,
          });
        },
      });
      if (signed.status !== "executed") {
        throw new ClassifiedDataOperationError(
          "authority",
          "Protected Task result signer is unavailable",
        );
      }
      return signed.value;
    },
  });
}
