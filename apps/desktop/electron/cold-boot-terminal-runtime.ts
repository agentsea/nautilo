/** D514 — closed main-process bridge shared by cold-boot terminal adapters. */
import type {
  CommittedColdBootTerminalPorts,
  CommittedColdBootProof,
} from "./committed-cold-boot-terminal";
import type {
  ActiveAuthority,
  CommittedHandoffPendingConnectionRecovery,
  PendingConnection,
  PendingConnectionLoadResult,
} from "./pending-connection";
import type {
  PreparedServerSwitchHandle,
  PromotePreparedServerSwitchHooks,
  PromotePreparedServerSwitchResult,
  ServerSessionRegistry,
} from "./server-sessions/registry";

type CommittedReleasePorts = Pick<
  CommittedColdBootTerminalPorts,
  "initiateLocalShell" | "releaseCandidate" | "finishReleased" | "onState"
>;

export type AcceptedIdentityConfigCas = (input: Readonly<{
  routingServerUrl: string;
  attemptId: string;
  serverFingerprint: string;
  priorAuthorityGuard: ActiveAuthority;
}>) => boolean;

export interface AcceptedIdentityRuntimePorts {
  currentAuthority(): ActiveAuthority;
  currentRegistryScope(): string | null;
  fetch: typeof globalThis.fetch;
  fingerprintFromHealthBody(body: Record<string, unknown>): string | null;
  savePending(pending: PendingConnection): void;
  clearPending(): void;
  prepare(input: Readonly<{
    attemptId: string;
    generation: number;
    canonicalOrigin: string;
    navigationUrl: string;
    priorRegistryScope: string | null;
    priorAuthorityGuard: ActiveAuthority;
    candidateServerFingerprint: string;
    acceptedIdentityReplacementReceipt: NonNullable<Parameters<ServerSessionRegistry["prepareSwitch"]>[0]["acceptedIdentityReplacementReceipt"]>;
    identityTransition: PendingConnection["identityTransition"];
    signal: AbortSignal;
  }>): ReturnType<ServerSessionRegistry["prepareSwitch"]>;
  cancelPrepared(attemptId: string, generation: number): boolean;
  promote(handle: PreparedServerSwitchHandle, hooks: PromotePreparedServerSwitchHooks): Promise<PromotePreparedServerSwitchResult>;
  resolveUnknownCommitOutcome: ServerSessionRegistry["resolveUnknownCommitOutcome"];
  commitAcceptedConfig: AcceptedIdentityConfigCas;
  persistMetadata: CommittedColdBootTerminalPorts["persistMetadata"];
  stopOldCodex: CommittedColdBootTerminalPorts["stopOldCodex"];
  stopOldRelay: CommittedColdBootTerminalPorts["stopOldRelay"];
  deactivateOldProfile: CommittedColdBootTerminalPorts["deactivateOldProfile"];
  retireOldIdentity: CommittedColdBootTerminalPorts["retireOldIdentity"];
  startTargetRelay: CommittedColdBootTerminalPorts["startTargetRelay"];
  createTokenStore: CommittedColdBootTerminalPorts["createTokenStore"];
  observeRelayContract: CommittedColdBootTerminalPorts["observeRelayContract"];
  candidateUi: CommittedColdBootTerminalPorts["candidateUi"];
  forceOnboarding: boolean;
  installActiveAuthDescriptor(): void;
}

type CandidateNavigationInput = Readonly<{
  attemptId: string;
  generation: number;
  view: PreparedServerSwitchHandle["view"];
  newlyCreatedView: boolean;
  expectedOrigin: string;
  navigationUrl?: string;
}>;

/** No config writer is accepted here: terminal authority remains explicit. */
export interface ColdBootTerminalRuntimeDependencies {
  configureRegistry(): void;
  loadPending(): PendingConnectionLoadResult;
  projectCommitted(
    loaded: Extract<PendingConnectionLoadResult, { disposition: "committed-handoff" }>,
  ): CommittedHandoffPendingConnectionRecovery;
  currentAuthority(): ActiveAuthority;
  currentRegistryScope(): string | null;
  registry: Pick<ServerSessionRegistry,
    "beginCommittedHandoffRecovery" | "completeCommittedHandoffRevalidation" | "promotePrepared" |
    "prepareSwitch" | "cancelPreparedSwitch" | "resolveUnknownCommitOutcome"
  >;
  fetch: typeof globalThis.fetch;
  fingerprintFromHealthBody(body: Record<string, unknown>): string | null;
  navigateCandidate(input: CandidateNavigationInput, signal: AbortSignal): Promise<ReturnType<CommittedColdBootTerminalPorts["navigateCandidate"]> extends Promise<infer Receipt> ? Receipt : never>;
  savePending(pending: PendingConnection): void;
  clearPending(): void;
  persistMetadata: CommittedColdBootTerminalPorts["persistMetadata"];
  stopOldCodex: CommittedColdBootTerminalPorts["stopOldCodex"];
  stopOldRelay: CommittedColdBootTerminalPorts["stopOldRelay"];
  deactivateOldProfile: CommittedColdBootTerminalPorts["deactivateOldProfile"];
  retireOldIdentity: CommittedColdBootTerminalPorts["retireOldIdentity"];
  startTargetRelay: CommittedColdBootTerminalPorts["startTargetRelay"];
  createTokenStore: CommittedColdBootTerminalPorts["createTokenStore"];
  observeRelayContract: CommittedColdBootTerminalPorts["observeRelayContract"];
  candidateUi: CommittedColdBootTerminalPorts["candidateUi"];
  forceOnboarding: boolean;
  installActiveAuthDescriptor(): void;
}

/**
 * This factory deliberately returns ports rather than a terminal. The caller
 * still chooses the terminal and owns its proof, authority, and release policy.
 */
export function createColdBootTerminalRuntime(deps: ColdBootTerminalRuntimeDependencies): Readonly<{
  committedPorts(input: Readonly<{
    targetRegistryScope: string;
  }> & CommittedReleasePorts): CommittedColdBootTerminalPorts;
  acceptedPorts(input: Readonly<{ commitAcceptedConfig: AcceptedIdentityConfigCas }>): AcceptedIdentityRuntimePorts;
}> {
  return {
    committedPorts: (input) => ({
      initiateLocalShell: input.initiateLocalShell,
      configureRegistry: () => deps.configureRegistry(),
      loadPending: () => deps.loadPending(),
      projectCommitted: (loaded) => deps.projectCommitted(loaded),
      currentAuthority: () => deps.currentAuthority(),
      beginCommitted: (recovery) => {
        const activeAuthorityGuard = deps.currentAuthority();
        const begun = deps.registry.beginCommittedHandoffRecovery({
          attemptId: recovery.attemptId,
          generation: recovery.generation,
          canonicalOrigin: recovery.candidateOrigin,
          routingServerUrl: recovery.routingServerUrl,
          identityTransition: recovery.identityTransition,
          targetRegistryScope: input.targetRegistryScope,
          priorRegistryScope: recovery.priorRegistryScope,
          nextCheckpoint: recovery.nextPostCommitCheckpoint,
          requiresEphemeralFactReconstructionAndRevalidation: true,
          priorRecoveryGuard: recovery.priorRecoveryGuard,
          currentActiveAuthority: activeAuthorityGuard,
        });
        return begun.ok ? { handle: begun.handle, activeAuthorityGuard } : null;
      },
      fetch: (input, init) => deps.fetch(input, init),
      fingerprintFromHealthBody: (body) => deps.fingerprintFromHealthBody(body),
      navigateCandidate: ({ handle, navigationUrl, expectedOrigin, attemptId, generation, signal }) =>
        deps.navigateCandidate({ attemptId, generation, view: handle.view,
          newlyCreatedView: handle.newlyCreatedView, expectedOrigin, navigationUrl }, signal),
      completeCommitted: (handle: PreparedServerSwitchHandle, proof: CommittedColdBootProof) =>
        deps.registry.completeCommittedHandoffRevalidation(handle, proof).ok,
      promote: (handle: PreparedServerSwitchHandle, hooks: PromotePreparedServerSwitchHooks): Promise<PromotePreparedServerSwitchResult> =>
        deps.registry.promotePrepared(handle, hooks),
      savePending: (pending) => deps.savePending(pending),
      clearPending: () => deps.clearPending(),
      persistMetadata: deps.persistMetadata,
      stopOldCodex: deps.stopOldCodex,
      stopOldRelay: deps.stopOldRelay,
      deactivateOldProfile: deps.deactivateOldProfile,
      retireOldIdentity: deps.retireOldIdentity,
      startTargetRelay: deps.startTargetRelay,
      createTokenStore: deps.createTokenStore,
      observeRelayContract: deps.observeRelayContract,
      candidateUi: deps.candidateUi,
      forceOnboarding: deps.forceOnboarding,
      installActiveAuthDescriptor: () => deps.installActiveAuthDescriptor(),
      releaseCandidate: input.releaseCandidate,
      finishReleased: input.finishReleased,
      onState: input.onState,
    }),
    acceptedPorts: (input) => ({
      currentAuthority: () => deps.currentAuthority(),
      currentRegistryScope: () => deps.currentRegistryScope(),
      fetch: (resource, init) => deps.fetch(resource, init),
      fingerprintFromHealthBody: (body) => deps.fingerprintFromHealthBody(body),
      savePending: (pending) => deps.savePending(pending),
      clearPending: () => deps.clearPending(),
      prepare: (candidate) => deps.registry.prepareSwitch({
        attemptId: candidate.attemptId,
        generation: candidate.generation,
        canonicalOrigin: candidate.canonicalOrigin,
        routingServerUrl: candidate.navigationUrl,
        identityTransition: candidate.identityTransition,
        priorRegistryScope: candidate.priorRegistryScope,
        priorAuthorityGuard: candidate.priorAuthorityGuard,
        forceDetachedReplacement: true,
        acceptedIdentityReplacementReceipt: candidate.acceptedIdentityReplacementReceipt,
        candidateServerFingerprint: candidate.candidateServerFingerprint,
        awaitNavigationReceipt: (navigation) => deps.navigateCandidate({
          attemptId: navigation.attemptId,
          generation: navigation.generation,
          view: navigation.view,
          newlyCreatedView: navigation.newlyCreatedView,
          expectedOrigin: navigation.expectedOrigin,
          navigationUrl: candidate.navigationUrl,
        }, candidate.signal),
      }),
      cancelPrepared: (attemptId, generation) => deps.registry.cancelPreparedSwitch(attemptId, generation),
      promote: (handle, hooks) => deps.registry.promotePrepared(handle, hooks),
      resolveUnknownCommitOutcome: (handle, authority) => deps.registry.resolveUnknownCommitOutcome(handle, authority),
      commitAcceptedConfig: input.commitAcceptedConfig,
      persistMetadata: deps.persistMetadata,
      stopOldCodex: deps.stopOldCodex,
      stopOldRelay: deps.stopOldRelay,
      deactivateOldProfile: deps.deactivateOldProfile,
      retireOldIdentity: deps.retireOldIdentity,
      startTargetRelay: deps.startTargetRelay,
      createTokenStore: deps.createTokenStore,
      observeRelayContract: deps.observeRelayContract,
      candidateUi: deps.candidateUi,
      forceOnboarding: deps.forceOnboarding,
      installActiveAuthDescriptor: () => deps.installActiveAuthDescriptor(),
    }),
  };
}
