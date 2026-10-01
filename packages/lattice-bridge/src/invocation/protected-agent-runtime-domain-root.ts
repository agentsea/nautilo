import {
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  openAgentRuntimeFromDomain,
  type AgentId,
  type AgentRuntimeKeyGeneration,
  type AuthorizationRevision,
  type CryptoDomainId,
  type DomainEpoch,
  type LatticeCrypto,
  type LatticeStorage,
} from "@nautilo/lattice-crypto";
import {
  parseAgentRuntimeDomainEnvelopeV1,
  type HistoricalAgentRuntimeCommitterResolverV1,
} from "@nautilo/lattice-crypto/wire";

export type ProtectedAgentRuntimeDomainRoot = Readonly<{
  domainId: CryptoDomainId;
  domainEpoch: DomainEpoch;
  agentAuthorizationRevision: AuthorizationRevision;
  domainRoot: Uint8Array;
}>;

export type OpenedProtectedAgentRuntime = Readonly<{
  runtime: AgentRuntimeKeyGeneration;
  stored: NonNullable<Awaited<
    ReturnType<LatticeStorage["getAgentRuntimeAtomicState"]>
  >>;
}>;

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/** @internal Open only from one exact, already-authorized Domain root. */
export async function openProtectedAgentRuntimeFromDomainRoot(input: Readonly<{
  crypto: LatticeCrypto;
  storage: Pick<LatticeStorage, "getAgentRuntimeAtomicState">;
  domain: ProtectedAgentRuntimeDomainRoot;
  agentId: AgentId;
  resolveHistoricalCommitter: HistoricalAgentRuntimeCommitterResolverV1;
}>): Promise<OpenedProtectedAgentRuntime | null> {
  let stored: Awaited<
    ReturnType<LatticeStorage["getAgentRuntimeAtomicState"]>
  >;
  try {
    stored = await input.storage.getAgentRuntimeAtomicState(input.agentId);
  } catch {
    return null;
  }
  if (
    stored === null
    || stored.runtime.agentId !== input.agentId
    || stored.runtime.authorizationRevision
      !== input.domain.agentAuthorizationRevision
  ) return null;
  const envelopeRecords = stored.domainEnvelopes.filter((record) =>
    record.agentId === input.agentId
    && record.domainId === input.domain.domainId
    && record.domainEpoch === input.domain.domainEpoch
    && record.agentAuthorizationRevision
      === input.domain.agentAuthorizationRevision
    && record.runtimeGeneration === stored.runtime.runtimeGeneration
  );
  if (envelopeRecords.length !== 1) return null;
  const envelopeRecord = envelopeRecords[0]!;
  if (
    !equalBytes(
      input.crypto.hash(envelopeRecord.envelopeBytes),
      envelopeRecord.envelopeHash,
    )
  ) return null;
  try {
    const envelope = parseAgentRuntimeDomainEnvelopeV1(
      envelopeRecord.envelopeBytes,
    );
    return Object.freeze({
      runtime: openAgentRuntimeFromDomain({
        crypto: input.crypto,
        domainRoot: input.domain.domainRoot,
        envelope,
        expected: {
          agentId: agentId(envelopeRecord.agentId),
          domainId: cryptoDomainId(envelopeRecord.domainId),
          domainEpoch: domainEpoch(envelopeRecord.domainEpoch),
          agentAuthorizationRevision:
            authorizationRevision(
              envelopeRecord.agentAuthorizationRevision,
            ),
          runtimeGeneration:
            agentRuntimeGeneration(envelopeRecord.runtimeGeneration),
          committerDeviceId:
            cryptoDeviceId(envelopeRecord.committerDeviceId),
        },
        resolveHistoricalCommitter: input.resolveHistoricalCommitter,
      }),
      stored,
    });
  } catch {
    return null;
  }
}
