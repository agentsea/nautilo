/** D514 — the dedicated terminal branch for a durably committed cold handoff. */
import {
  ColdBootConnectionController,
  type ColdBootPublicState,
} from "./cold-boot-connection-controller";
import {
  CANDIDATE_COLD_BOOT_GATE_CONTEXT,
  runCandidateColdBootGates,
  type CandidateColdBootGatePorts,
  type CandidateProfileFact,
} from "./candidate-cold-boot-gates";
import type { TokenBundle } from "./auth/token-store";
import type { ObservationReceipt } from "./connection-attempt";
import type {
  ActiveAuthority,
  CommittedHandoffPendingConnectionRecovery,
  PendingConnection,
  PendingConnectionLoadResult,
  PendingConnectionPostCommitCheckpoint,
} from "./pending-connection";
import type {
  IncompletePreparedServerSwitchCheckpoint,
  PreparedServerSwitchHandle,
  PromotePreparedServerSwitchHooks,
  PromotePreparedServerSwitchResult,
  ServerSession,
} from "./server-sessions/registry";
import { setupStatusResponseSchema, type SetupStatusResponse } from "@nautilo/api-client";

export type CommittedColdBootHealth = Readonly<{
  body: Readonly<Record<string, unknown>>;
  fingerprint: string;
  logtoConfig: Readonly<{ endpoint: string; appId: string; resource: string }>;
}>;

export type CommittedColdBootFacts = Readonly<{
  health: CommittedColdBootHealth;
  setupStatus: SetupStatusResponse | null;
  profile: CandidateProfileFact;
}>;

export type CommittedColdBootProof = Readonly<{
  navigationReceipt: ObservationReceipt;
  serverFingerprint: string;
}>;

export type IdentityBoundTokenStore = Readonly<{
  load(): TokenBundle | null;
  save(bundle: TokenBundle): void;
  clear(): void;
  retireExact(): void;
}>;

export interface CommittedColdBootTerminalPorts {
  initiateLocalShell(): void;
  configureRegistry(): void;
  loadPending(): PendingConnectionLoadResult;
  projectCommitted(loaded: Extract<PendingConnectionLoadResult, { disposition: "committed-handoff" }>): CommittedHandoffPendingConnectionRecovery;
  currentAuthority(): ActiveAuthority;
  beginCommitted(recovery: CommittedHandoffPendingConnectionRecovery): Readonly<{
    handle: PreparedServerSwitchHandle;
    activeAuthorityGuard: ActiveAuthority;
  }> | null;
  fetch: typeof globalThis.fetch;
  fingerprintFromHealthBody(body: Record<string, unknown>): string | null;
  navigateCandidate(input: Readonly<{
    handle: PreparedServerSwitchHandle;
    navigationUrl: string;
    expectedOrigin: string;
    attemptId: string;
    generation: number;
    signal: AbortSignal;
  }>): Promise<ObservationReceipt>;
  completeCommitted(handle: PreparedServerSwitchHandle, proof: CommittedColdBootProof): boolean;
  promote(
    handle: PreparedServerSwitchHandle,
    hooks: PromotePreparedServerSwitchHooks,
  ): Promise<PromotePreparedServerSwitchResult>;
  savePending(pending: PendingConnection): void;
  clearPending(): void;
  persistMetadata(session: ServerSession, health: CommittedColdBootHealth): Promise<void>;
  stopOldCodex(session: ServerSession): Promise<void>;
  stopOldRelay(session: ServerSession): Promise<void>;
  deactivateOldProfile(session: ServerSession): Promise<void>;
  retireOldIdentity(input: Readonly<{ priorRoutingServerUrl: string; targetRegistryScope: string }>): Promise<void>;
  startTargetRelay(session: ServerSession): Promise<void>;
  createTokenStore(identity: Readonly<{
    routingServerUrl: string;
    logtoEndpoint: string;
    clientAppId: string;
  }>): IdentityBoundTokenStore;
  observeRelayContract(health: CommittedColdBootHealth): void;
  candidateUi: Pick<CandidateColdBootGatePorts, "startLoopback" | "openAuthSurface" | "showOnboarding">;
  forceOnboarding: boolean;
  installActiveAuthDescriptor(): void;
  releaseCandidate(input: Readonly<{
    recovery: CommittedHandoffPendingConnectionRecovery;
    handle: PreparedServerSwitchHandle;
    facts: CommittedColdBootFacts;
  }>): void;
  finishReleased(input: Readonly<{
    recovery: CommittedHandoffPendingConnectionRecovery;
    handle: PreparedServerSwitchHandle;
    facts: CommittedColdBootFacts;
  }>): Promise<void>;
  onState(state: ColdBootPublicState): void;
}

export interface CommittedColdBootTerminal {
  readonly routingServerUrl: string;
  snapshot(): ColdBootPublicState;
  launch(): Promise<void>;
  retry(): Promise<void>;
}

export function routedServerEndpoint(routingServerUrl: string, suffix: string): string {
  return `${routingServerUrl.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

function responseMatches(response: Response, canonicalOrigin: string): boolean {
  try {
    return response.ok && new URL(response.url).origin === canonicalOrigin;
  } catch {
    return false;
  }
}

function sameAuthority(left: ActiveAuthority, right: ActiveAuthority): boolean {
  return left.scope === right.scope && left.revision === right.revision &&
    left.connectionAttemptId === right.connectionAttemptId &&
    left.serverFingerprint === right.serverFingerprint;
}

async function reconstruct(
  ports: CommittedColdBootTerminalPorts,
  recovery: CommittedHandoffPendingConnectionRecovery,
  handle: PreparedServerSwitchHandle,
  frozenAuthority: ActiveAuthority,
  signal: AbortSignal,
): Promise<Readonly<{ proof: CommittedColdBootProof; facts: CommittedColdBootFacts }> | null> {
  const expectedFingerprint = frozenAuthority.serverFingerprint;
  if (frozenAuthority.scope !== recovery.candidateOrigin ||
      frozenAuthority.connectionAttemptId !== recovery.attemptId ||
      typeof expectedFingerprint !== "string" ||
      !sameAuthority(ports.currentAuthority(), frozenAuthority)) return null;
  const get = async (suffix: string): Promise<Record<string, unknown> | null> => {
    const response = await ports.fetch(routedServerEndpoint(recovery.routingServerUrl, suffix), {
      signal,
      headers: { Accept: "application/json" },
    });
    if (!responseMatches(response, recovery.candidateOrigin)) return null;
    const body: unknown = await response.json();
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  };
  const ready = await get("/health/ready");
  if (ready?.["status"] !== "ready" || signal.aborted) return null;
  const healthBody = await get("/health");
  const fingerprint = healthBody ? ports.fingerprintFromHealthBody(healthBody) : null;
  const endpoint = healthBody?.["logtoEndpoint"];
  const appId = healthBody?.["logtoDesktopAppId"];
  const resource = healthBody?.["logtoResource"];
  if (healthBody?.["status"] !== "ok" || fingerprint !== expectedFingerprint ||
      typeof endpoint !== "string" || !endpoint || typeof appId !== "string" || !appId ||
      typeof resource !== "string" || !resource || signal.aborted) return null;
  const setup = setupStatusResponseSchema.safeParse(await get("/api/setup/status"));
  if (!setup.success || signal.aborted) return null;
  let profile: CandidateProfileFact = { kind: "unavailable" };
  try {
    const profileResponse = await ports.fetch(
      routedServerEndpoint(recovery.routingServerUrl, "/api/profile/status"),
      { signal, headers: { Accept: "application/json" } },
    );
    try {
      if (new URL(profileResponse.url).origin !== recovery.candidateOrigin) return null;
    } catch {
      return null;
    }
    const raw: unknown = profileResponse.ok ? await profileResponse.json() : null;
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      const body = raw as Record<string, unknown>;
      if (typeof body["exists"] === "boolean" && typeof body["onboardingCompleted"] === "boolean") {
        profile = { kind: "observed", exists: body["exists"], onboardingCompleted: body["onboardingCompleted"] };
      }
    }
  } catch {
    if (signal.aborted) return null;
  }
  if (signal.aborted) return null;
  const navigationReceipt = await ports.navigateCandidate({
    handle,
    navigationUrl: `${recovery.routingServerUrl.replace(/\/+$/, "")}/`,
    expectedOrigin: recovery.candidateOrigin,
    attemptId: recovery.attemptId,
    generation: recovery.generation,
    signal,
  });
  if (signal.aborted || !sameAuthority(ports.currentAuthority(), frozenAuthority) ||
      navigationReceipt.origin !== recovery.candidateOrigin ||
      navigationReceipt.attemptId !== recovery.attemptId ||
      navigationReceipt.generation !== recovery.generation) return null;
  return {
    proof: { navigationReceipt, serverFingerprint: expectedFingerprint },
    facts: {
      health: {
        body: healthBody,
        fingerprint: expectedFingerprint,
        logtoConfig: { endpoint, appId, resource },
      },
      setupStatus: setup.data,
      profile,
    },
  };
}

function pendingAt(pending: PendingConnection, checkpoint: IncompletePreparedServerSwitchCheckpoint): PendingConnection {
  return {
    ...pending,
    lastProgressPhase: "promotion",
    handoffCheckpoint: "active-committed",
    postCommitCheckpoint: checkpoint as PendingConnectionPostCommitCheckpoint,
  };
}

function promotionHooks(
  ports: CommittedColdBootTerminalPorts,
  pending: PendingConnection,
  facts: CommittedColdBootFacts,
  pause: boolean,
  signedIn: boolean,
): PromotePreparedServerSwitchHooks {
  return {
    // A committed recovery can never re-enter the config linearization path.
    commitActiveAuthority: () => Promise.resolve({ committed: false }),
    persistMetadata: (session) => ports.persistMetadata(session, facts.health),
    stopOldCodex: (session) => ports.stopOldCodex(session),
    stopOldRelay: (session) => ports.stopOldRelay(session),
    deactivateOldProfile: (session) => ports.deactivateOldProfile(session),
    retireOldIdentity: async (input) => {
      if (pending.identityTransition.kind !== "accepted-identity-replacement") return;
      ports.createTokenStore({ routingServerUrl: input.priorRoutingServerUrl,
        logtoEndpoint: facts.health.logtoConfig.endpoint, clientAppId: facts.health.logtoConfig.appId }).retireExact();
      await ports.retireOldIdentity(input);
    },
    startTargetRelay: (session) => ports.startTargetRelay(session),
    shouldStartTargetRelay: signedIn,
    pauseBeforeRendererAuthority: pause,
    persistNextCheckpoint: (checkpoint) => {
      ports.savePending(pendingAt(pending, checkpoint));
      return Promise.resolve();
    },
    clearPending: () => { ports.clearPending(); return Promise.resolve(); },
  };
}

export function prepareCommittedColdBootTerminal(
  ports: CommittedColdBootTerminalPorts,
): CommittedColdBootTerminal | null {
  // These are intentionally synchronous and ordered before the first network
  // promise: paint local, install registry hooks, then classify the journal.
  ports.initiateLocalShell();
  ports.configureRegistry();
  const loaded = ports.loadPending();
  if (loaded.disposition !== "committed-handoff") return null;
  const recovery = ports.projectCommitted(loaded);
  const pending = loaded.pending;
  const begun = ports.beginCommitted(recovery);
  const begunHandle = begun?.handle ?? null;
  const frozenAuthority = begun?.activeAuthorityGuard ?? ports.currentAuthority();
  const validBegunHandle = begunHandle !== null &&
    begunHandle.attemptId === recovery.attemptId &&
    begunHandle.generation === recovery.generation &&
    begunHandle.canonicalOrigin === recovery.candidateOrigin &&
    begunHandle.session.serverUrl === recovery.routingServerUrl &&
    begunHandle.targetRegistryScope === begunHandle.session.scope &&
    begunHandle.priorRegistryScope === recovery.priorRegistryScope &&
    begunHandle.newlyCreatedView === true &&
    begunHandle.navigationReceipt === null &&
    begunHandle.checkpoint === recovery.nextPostCommitCheckpoint &&
    begunHandle.session.partition ===
      `server-candidate-${begunHandle.targetRegistryScope}-${recovery.attemptId}-${recovery.generation}` &&
    begunHandle.status === "awaiting-revalidation" &&
    begunHandle.expectedServerFingerprint === frozenAuthority.serverFingerprint;
  let releasedHandle: PreparedServerSwitchHandle | null = null;
  let releasedFacts: CommittedColdBootFacts | null = null;
  let candidateReleased = false;
  let finalized = false;
  let state: ColdBootPublicState = { phase: "connecting", canRetry: false };
  const publish = (next: ColdBootPublicState) => {
    state = next;
    ports.onState(next);
  };
  const controller = new ColdBootConnectionController<
    PreparedServerSwitchHandle,
    CommittedColdBootProof,
    CommittedColdBootFacts
  >({
    initiateLocalShell: () => {},
    configureRegistry: () => {},
    loadPending: () => recovery,
    freshColdBoot: () => Promise.reject(new Error("committed terminal cannot run fresh boot")),
    restartPrecommit: () => Promise.reject(new Error("committed terminal cannot run precommit")),
    beginCommitted: () => validBegunHandle && begunHandle ? begunHandle : null,
    reconstructCommitted: async (record, handle, signal) => {
      const reconstructed = await reconstruct(ports, record, handle, frozenAuthority, signal);
      releasedFacts = reconstructed?.facts ?? null;
      return reconstructed;
    },
    completeCommitted: (handle, proof) => ports.completeCommitted(handle, proof),
    promoteCommitted: async (handle) => {
      if (!releasedFacts) throw new Error("committed facts unavailable");
      const result = await ports.promote(handle, promotionHooks(ports, pending, releasedFacts, true, false));
      return result.ok && result.paused
        ? { ok: true, paused: true, handle: result.handle }
        : { ok: false };
    },
    runCandidateGates: async (handle, facts, signal) => {
      releasedFacts = facts;
      ports.observeRelayContract(facts.health);
      handle.session.logtoConfig = { ...facts.health.logtoConfig };
      handle.session.connection = "live";
      const tokenStore = ports.createTokenStore({
        routingServerUrl: recovery.routingServerUrl,
        logtoEndpoint: facts.health.logtoConfig.endpoint,
        clientAppId: facts.health.logtoConfig.appId,
      });
      const result = await runCandidateColdBootGates({
        context: CANDIDATE_COLD_BOOT_GATE_CONTEXT,
        candidate: {
          routingServerUrl: recovery.routingServerUrl,
          canonicalOrigin: recovery.candidateOrigin,
          registryScope: handle.targetRegistryScope,
          partition: handle.session.partition,
        },
        logto: facts.health.logtoConfig,
        setupStatus: facts.setupStatus,
        profile: facts.profile,
        forceOnboarding: ports.forceOnboarding,
        signal,
      }, {
        fetch: ports.fetch,
        loadTokensFor: (url) => url === recovery.routingServerUrl ? tokenStore.load() : null,
        saveTokensFor: (url, bundle) => {
          if (url !== recovery.routingServerUrl) throw new Error("candidate token scope changed");
          tokenStore.save(bundle);
        },
        clearTokensFor: (url) => {
          if (url !== recovery.routingServerUrl) throw new Error("candidate token scope changed");
          tokenStore.clear();
        },
        ...ports.candidateUi,
      });
      handle.session.signedIn = result.signedIn;
      return result.ok;
    },
    resumePresentation: async (handle) => {
      if (!releasedFacts || !sameAuthority(ports.currentAuthority(), frozenAuthority)) {
        return { ok: false };
      }
      ports.installActiveAuthDescriptor();
      const result = await ports.promote(
        handle,
        promotionHooks(ports, pending, releasedFacts, false, handle.session.signedIn),
      );
      if (!result.ok || result.paused) return { ok: false };
      releasedHandle = handle;
      return { ok: true, paused: false, handle };
    },
    onState: publish,
  });

  const finish = async () => {
    if (controller.snapshot().phase !== "released" || finalized) return;
    if (!releasedHandle || !releasedFacts) {
      publish({ phase: "recoverable", canRetry: true });
      return;
    }
    try {
      const input = { recovery, handle: releasedHandle, facts: releasedFacts };
      if (!candidateReleased) {
        ports.releaseCandidate(input);
        candidateReleased = true;
      }
      await ports.finishReleased(input);
      finalized = true;
    } catch {
      publish({ phase: "recoverable", canRetry: true });
    }
  };
  return {
    routingServerUrl: recovery.routingServerUrl,
    snapshot: () => state,
    launch: async () => { await controller.launch(); await finish(); },
    retry: async () => {
      if (controller.snapshot().phase !== "released") await controller.retry();
      await finish();
    },
  };
}
