import type {
  AgentId,
  AgentRuntimeGeneration,
  AuthorizationRevision,
  CryptoDeviceId,
  CryptoDomainId,
  DomainEpoch,
} from "../v2-types/ids.ts";

export const AGENT_RUNTIME_KEY_BYTES = 32;

export interface AgentRuntimeGenerationV2 {
  readonly agentId: AgentId;
  readonly keyClass: "runtime";
  readonly generation: AgentRuntimeGeneration;
  readonly key: Uint8Array;
}

export interface AgentRuntimeDomainTargetV1 {
  readonly domainId: CryptoDomainId;
  readonly domainEpoch: DomainEpoch;
  readonly agentAuthorizationRevision: AuthorizationRevision;
}

export interface AgentRuntimeDomainCommitterContextV1
  extends AgentRuntimeDomainTargetV1 {
  readonly purpose: "agent-runtime-domain-envelope";
  readonly agentId: AgentId;
  readonly runtimeGeneration: AgentRuntimeGeneration;
  readonly committerDeviceId: CryptoDeviceId;
}

export interface AgentRuntimeDomainSealContextV1
  extends AgentRuntimeDomainTargetV1 {
  readonly committerDeviceId: CryptoDeviceId;
}

export interface AgentRuntimeDomainExpectedContextV1
  extends AgentRuntimeDomainSealContextV1 {
  readonly agentId: AgentId;
  readonly runtimeGeneration: AgentRuntimeGeneration;
}

export interface AgentRuntimeDomainEnvelopeV1
  extends AgentRuntimeDomainExpectedContextV1 {
  readonly formatVersion: 1;
  readonly ciphertext: Uint8Array;
  readonly signature: Uint8Array;
}

export type CurrentAgentRuntimeCommitterAuthorizationV1 = (
  context: AgentRuntimeDomainCommitterContextV1,
) => boolean;

export type HistoricalAgentRuntimeCommitterResolverV1 = (
  context: AgentRuntimeDomainCommitterContextV1,
) => Uint8Array | null;
