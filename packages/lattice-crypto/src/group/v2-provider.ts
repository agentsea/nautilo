import type { SealedProviderStateV2 } from "../device/v2-state-vault.ts";
import type {
  LocalProviderCandidateV2,
  PreparedProviderCommitV2,
  ProviderAbortResultV2,
  ProviderApplyResultV2,
  ProviderPublicHeadV2,
  ProviderPublicTransitionV2,
} from "../transition/provider-candidate.ts";
import type {
  CryptoDomainId,
  DomainEpoch,
} from "../v2-types/ids.ts";

export interface DomainRootsV2 {
  readonly human: Uint8Array;
  readonly ai: Uint8Array;
}

/**
 * Per-device v2 Domain group seam. Implementations never own a fleet-wide map:
 * every operation begins from one sealed active device snapshot and pure
 * preparation yields one separately sealed local candidate.
 */
export interface V2GroupKeyProvider {
  readonly id: string;

  publicHead(active: SealedProviderStateV2): ProviderPublicHeadV2;
  publicRoster(active: SealedProviderStateV2): Uint8Array;

  exportDomainRoots(
    active: SealedProviderStateV2,
  ): Promise<DomainRootsV2>;

  prepareCommit(input: {
    readonly active: SealedProviderStateV2;
  }): Promise<PreparedProviderCommitV2>;

  prepareIncoming(input: {
    readonly active: SealedProviderStateV2;
    readonly publicResult: ProviderPublicTransitionV2;
  }): Promise<LocalProviderCandidateV2>;

  validatePreparedCandidate(input: {
    readonly active: SealedProviderStateV2;
    readonly prepared: PreparedProviderCommitV2;
  }): Promise<void>;

  applyCandidate(input: {
    readonly active: SealedProviderStateV2;
    readonly candidate: LocalProviderCandidateV2;
  }): ProviderApplyResultV2;

  abortCandidate(
    candidate: LocalProviderCandidateV2,
  ): ProviderAbortResultV2;
}

/**
 * Dummy-only bootstrap input. Production MLS providers create/import their own
 * group state and must not expose exporter secrets through this shape.
 */
export interface DummyProviderBootstrapV2 {
  readonly domainId: CryptoDomainId;
  readonly epoch: DomainEpoch;
  readonly exporterSecret: Uint8Array;
}

export class V2ProviderStateError extends Error {
  override readonly name = "V2ProviderStateError";
}
