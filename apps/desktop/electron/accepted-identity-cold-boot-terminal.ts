/** D514 — exact human acceptance of a changed identity during cold boot. */
import {
  ACCEPTED_IDENTITY_REPLACEMENT_GATE_CONTEXT,
  runCandidateColdBootGates,
  type CandidateProfileFact,
} from "./candidate-cold-boot-gates";
import type { ColdBootAcceptanceProof } from "./cold-boot-observation";
import type { ColdBootPublicState } from "./cold-boot-connection-controller";
import type { AcceptedIdentityRuntimePorts } from "./cold-boot-terminal-runtime";
import type { ActiveAuthority, PendingConnection, PendingConnectionPostCommitCheckpoint } from "./pending-connection";
import type { PreparedServerSwitchHandle, PromotePreparedServerSwitchHooks } from "./server-sessions/registry";
import { setupStatusResponseSchema, type SetupStatusResponse } from "@nautilo/api-client";

export type AcceptedIdentityDisplayedMismatch = Readonly<{
  serverUrl: string;
  generation: number;
  observedFingerprint: string;
}>;

type AcceptedFacts = Readonly<{
  health: Readonly<{
    body: Record<string, unknown>;
    fingerprint: string;
    logtoConfig: Readonly<{ endpoint: string; appId: string; resource: string }>;
  }>;
  setupStatus: SetupStatusResponse | null;
  profile: CandidateProfileFact;
}>;

export interface AcceptedIdentityColdBootTerminalPorts extends AcceptedIdentityRuntimePorts {
  releaseCandidate(input: Readonly<{ routingServerUrl: string; handle: PreparedServerSwitchHandle; facts: AcceptedFacts }>): void;
  finishReleased(input: Readonly<{ routingServerUrl: string; handle: PreparedServerSwitchHandle; facts: AcceptedFacts }>): Promise<void>;
  onState(state: ColdBootPublicState): void;
}

export interface AcceptedIdentityColdBootTerminal {
  readonly routingServerUrl: string;
  snapshot(): ColdBootPublicState;
  /** `precommit-failed` is the only result that permits proof rollback. */
  launch(): Promise<"released" | "recoverable-forward" | "precommit-failed">;
  retry(): Promise<"released" | "recoverable-forward" | "precommit-failed">;
}

export type AcceptedIdentityColdBootTerminalInput = Readonly<{
  displayed: AcceptedIdentityDisplayedMismatch;
  proof: ColdBootAcceptanceProof;
  /** Exact A route slot retained only for durable identity retirement. */
  priorRoutingServerUrl: string;
  tupleBinding: string;
}>;

function sameAuthority(left: ActiveAuthority, right: ActiveAuthority): boolean {
  return left.scope === right.scope && left.revision === right.revision &&
    left.connectionAttemptId === right.connectionAttemptId && left.serverFingerprint === right.serverFingerprint;
}

function endpoint(route: string, suffix: string): string {
  return `${route.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

function validRoute(value: string, origin: string): boolean {
  try {
    const parsed = new URL(value);
    return value.length <= 2048 && parsed.origin === origin && !parsed.username && !parsed.password &&
      !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

function pendingAt(
  pending: PendingConnection,
  checkpoint: PendingConnectionPostCommitCheckpoint,
): PendingConnection {
  return { ...pending, lastProgressPhase: "promotion", handoffCheckpoint: "active-committed", postCommitCheckpoint: checkpoint };
}

/**
 * The proof is created by the observation authority immediately before this
 * terminal is constructed. This terminal consumes its health body and receipt;
 * it never probes `/health` a second time or lets a later identity stand in.
 */
export function prepareAcceptedIdentityColdBootTerminal(
  ports: AcceptedIdentityColdBootTerminalPorts,
  input: AcceptedIdentityColdBootTerminalInput,
): AcceptedIdentityColdBootTerminal | null {
  let origin: string;
  try { origin = new URL(input.proof.serverUrl).origin; } catch { return null; }
  if (input.displayed.serverUrl !== input.proof.serverUrl ||
      input.displayed.generation !== input.proof.displayedGeneration ||
      input.displayed.observedFingerprint !== input.proof.observedFingerprint ||
      input.proof.receipt.attemptId !== input.proof.attemptId || input.proof.receipt.generation !== input.proof.generation ||
      input.proof.receipt.origin !== origin ||
      !validRoute(input.proof.serverUrl, origin) || !validRoute(input.priorRoutingServerUrl, origin)) return null;
  const prior = ports.currentAuthority();
  const priorScope = ports.currentRegistryScope();
  if (prior.scope !== origin || prior.revision === null || prior.connectionAttemptId === null ||
      prior.serverFingerprint === null || priorScope === null) return null;
  const transition: PendingConnection["identityTransition"] = {
    kind: "accepted-identity-replacement",
    priorConnectionAttemptId: prior.connectionAttemptId,
    priorServerFingerprint: prior.serverFingerprint,
    priorRoutingServerUrl: input.priorRoutingServerUrl,
  };
  const pending: PendingConnection = {
    version: 2,
    tupleBinding: input.tupleBinding,
    attemptId: input.proof.attemptId,
    context: "cold-boot",
    generation: input.proof.generation,
    enteredTarget: input.proof.serverUrl,
    candidateOrigin: origin,
    activeScopeGuard: prior.scope,
    activeRevisionGuard: prior.revision,
    identityTransition: transition,
    lastProgressPhase: "promotion",
    handoffCheckpoint: "candidate",
    postCommitCheckpoint: null,
  };
  let state: ColdBootPublicState = { phase: "connecting", canRetry: false };
  let handle: PreparedServerSwitchHandle | null = null;
  let facts: AcceptedFacts | null = null;
  let frozenB: ActiveAuthority | null = null;
  let stage: "initial" | "unknown" | "committed-metadata" | "promote" | "gates" | "resume" | "finalize" | "failed" = "initial";
  let released = false;
  let finalized = false;
  let running: Promise<"released" | "recoverable-forward" | "precommit-failed"> | null = null;
  const publish = (phase: ColdBootPublicState["phase"], canRetry: boolean) => {
    state = { phase, canRetry };
    ports.onState(state);
  };
  const precommitFailure = (): "precommit-failed" => {
    try { if (handle) ports.cancelPrepared(handle.attemptId, handle.generation); } catch { /* best-effort B cleanup */ }
    try { ports.clearPending(); } catch { /* failed candidate journal never becomes B authority */ }
    handle = null;
    stage = "failed";
    publish("recoverable", true);
    return "precommit-failed";
  };
  const forwardFailure = (): "recoverable-forward" => {
    publish("recoverable", true);
    return "recoverable-forward";
  };
  const healthFacts = async (signal: AbortSignal): Promise<AcceptedFacts | null> => {
    const body = input.proof.healthBody;
    const fingerprint = ports.fingerprintFromHealthBody(body);
    const endpointValue = body["logtoEndpoint"];
    const appId = body["logtoDesktopAppId"];
    const resource = body["logtoResource"];
    if (signal.aborted || fingerprint !== input.proof.observedFingerprint || body["status"] !== "ok" ||
        typeof endpointValue !== "string" || !endpointValue || typeof appId !== "string" || !appId ||
        typeof resource !== "string" || !resource) return null;
    const get = async (suffix: string): Promise<Record<string, unknown> | null> => {
      const response = await ports.fetch(endpoint(input.proof.serverUrl, suffix), { signal, headers: { Accept: "application/json" } });
      if (!response.ok || new URL(response.url).origin !== origin) return null;
      const raw: unknown = await response.json();
      return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    };
    let setup: SetupStatusResponse | null;
    try {
      const parsed = setupStatusResponseSchema.safeParse(await get("/api/setup/status"));
      if (!parsed.success) return null;
      setup = parsed.data;
    } catch { return null; }
    // Do not make an optional profile outage an identity assertion; a redirect,
    // however, is a different authority and fails this acceptance closed.
    let profile: CandidateProfileFact = { kind: "unavailable" };
    try {
      const response = await ports.fetch(endpoint(input.proof.serverUrl, "/api/profile/status"), { signal, headers: { Accept: "application/json" } });
      try { if (new URL(response.url).origin !== origin) return null; } catch { return null; }
      const raw: unknown = response.ok ? await response.json() : null;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const value = raw as Record<string, unknown>;
        if (typeof value["exists"] === "boolean" && typeof value["onboardingCompleted"] === "boolean") {
          profile = { kind: "observed", exists: value["exists"], onboardingCompleted: value["onboardingCompleted"] };
        }
      }
    } catch { if (signal.aborted) return null; }
    return signal.aborted ? null : { health: { body, fingerprint, logtoConfig: { endpoint: endpointValue, appId, resource } }, setupStatus: setup, profile };
  };
  const hooks = (): PromotePreparedServerSwitchHooks => ({
    commitActiveAuthority: () => {
      const committed = ports.commitAcceptedConfig({ routingServerUrl: input.proof.serverUrl,
        attemptId: input.proof.attemptId, serverFingerprint: input.proof.observedFingerprint, priorAuthorityGuard: prior });
      if (!committed) return Promise.resolve({ committed: false });
      ports.savePending(pendingAt(pending, "metadata"));
      return Promise.resolve({ committed: true });
    },
    persistMetadata: async (session) => { if (!facts) throw new Error("accepted facts unavailable"); await ports.persistMetadata(session, facts.health); },
    stopOldCodex: (session) => ports.stopOldCodex(session),
    stopOldRelay: (session) => ports.stopOldRelay(session),
    deactivateOldProfile: (session) => ports.deactivateOldProfile(session),
    retireOldIdentity: async (retirement) => {
      if (!facts) throw new Error("accepted facts unavailable");
      ports.createTokenStore({ routingServerUrl: retirement.priorRoutingServerUrl,
        logtoEndpoint: facts.health.logtoConfig.endpoint, clientAppId: facts.health.logtoConfig.appId }).retireExact();
      await ports.retireOldIdentity(retirement);
    },
    startTargetRelay: (session) => ports.startTargetRelay(session),
    shouldStartTargetRelay: false,
    pauseBeforeRendererAuthority: true,
    persistNextCheckpoint: (checkpoint) => { ports.savePending(pendingAt(pending, checkpoint)); return Promise.resolve(); },
    clearPending: () => { ports.clearPending(); return Promise.resolve(); },
  });
  const continueForward = async (signal: AbortSignal): Promise<"released" | "recoverable-forward" | "precommit-failed"> => {
    if (!handle || !facts) return forwardFailure();
    if (stage === "unknown") {
      const outcome = ports.resolveUnknownCommitOutcome(handle, ports.currentAuthority());
      if (outcome.outcome === "not-committed") return precommitFailure();
      if (outcome.outcome !== "committed-handoff") return forwardFailure();
      handle = outcome.handle;
      // Resolution has now proved B durably committed. Name that state before
      // another await; if this write fails, retry must not re-resolve a handle
      // the registry has already advanced beyond its unknown state.
      stage = "committed-metadata";
    }
    if (stage === "committed-metadata") {
      ports.savePending(pendingAt(pending, "metadata"));
      stage = "promote";
    }
    if (stage === "promote") {
      const promoted = await ports.promote(handle, hooks());
      if (!promoted.ok) {
        if (promoted.reason === "commit-failed") return precommitFailure();
        stage = promoted.reason === "commit-outcome-unknown" ? "unknown" : "promote";
        return forwardFailure();
      }
      if (!promoted.paused) return forwardFailure();
      handle = promoted.handle;
      const authority = ports.currentAuthority();
      if (authority.scope !== origin || authority.connectionAttemptId !== input.proof.attemptId ||
          authority.serverFingerprint !== input.proof.observedFingerprint || authority.revision === null) return forwardFailure();
      frozenB = authority;
      stage = "gates";
    }
    if (stage === "gates") {
      if (!frozenB || !sameAuthority(ports.currentAuthority(), frozenB)) return forwardFailure();
      publish("gated", false);
      handle.session.logtoConfig = { ...facts.health.logtoConfig };
      handle.session.connection = "live";
      const tokenStore = ports.createTokenStore({ routingServerUrl: input.proof.serverUrl,
        logtoEndpoint: facts.health.logtoConfig.endpoint, clientAppId: facts.health.logtoConfig.appId });
      const gates = await runCandidateColdBootGates({
        context: ACCEPTED_IDENTITY_REPLACEMENT_GATE_CONTEXT,
        candidate: { routingServerUrl: input.proof.serverUrl, canonicalOrigin: origin,
          registryScope: handle.targetRegistryScope, partition: handle.session.partition },
        logto: facts.health.logtoConfig, setupStatus: facts.setupStatus, profile: facts.profile,
        forceOnboarding: ports.forceOnboarding, signal,
      }, {
        fetch: ports.fetch,
        loadTokensFor: () => { throw new Error("accepted replacement must not load existing tokens"); },
        saveTokensFor: (url, bundle) => { if (url !== input.proof.serverUrl) throw new Error("candidate token scope changed"); tokenStore.save(bundle); },
        clearTokensFor: (url) => { if (url !== input.proof.serverUrl) throw new Error("candidate token scope changed"); tokenStore.clear(); },
        ...ports.candidateUi,
      });
      if (!gates.ok || signal.aborted || !sameAuthority(ports.currentAuthority(), frozenB)) return forwardFailure();
      handle.session.signedIn = gates.signedIn;
      ports.observeRelayContract(facts.health);
      stage = "resume";
    }
    if (stage === "resume") {
      if (!frozenB || !sameAuthority(ports.currentAuthority(), frozenB)) return forwardFailure();
      ports.installActiveAuthDescriptor();
      const resumed = await ports.promote(handle, { ...hooks(), pauseBeforeRendererAuthority: false,
        shouldStartTargetRelay: handle.session.signedIn });
      if (!resumed.ok || resumed.paused) return forwardFailure();
      stage = "finalize";
    }
    if (stage === "finalize") {
      try {
        if (!released) { ports.releaseCandidate({ routingServerUrl: input.proof.serverUrl, handle, facts }); released = true; }
        await ports.finishReleased({ routingServerUrl: input.proof.serverUrl, handle, facts });
        finalized = true;
        publish("released", false);
        return "released";
      } catch { return forwardFailure(); }
    }
    return finalized ? "released" : forwardFailure();
  };
  const run = async (): Promise<"released" | "recoverable-forward" | "precommit-failed"> => {
    try {
      const signal = new AbortController().signal;
      publish("connecting", false);
      if (stage === "failed") return "precommit-failed";
      if (stage === "initial") {
        facts = await healthFacts(signal);
        if (!facts) return precommitFailure();
        ports.savePending(pending);
        const prepared = await ports.prepare({ attemptId: input.proof.attemptId, generation: input.proof.generation,
        canonicalOrigin: origin, navigationUrl: input.proof.serverUrl, priorRegistryScope: priorScope,
        priorAuthorityGuard: prior, candidateServerFingerprint: input.proof.observedFingerprint,
        acceptedIdentityReplacementReceipt: input.proof.receipt, identityTransition: transition, signal });
        if (!prepared.ok) return precommitFailure();
        handle = prepared.handle;
        if (handle.attemptId !== input.proof.attemptId || handle.generation !== input.proof.generation ||
          handle.canonicalOrigin !== origin || handle.targetRegistryScope !== priorScope ||
          handle.priorRegistryScope !== priorScope || handle.session.scope !== priorScope ||
          handle.session.serverUrl !== input.proof.serverUrl || handle.session.view !== handle.view || !handle.newlyCreatedView ||
          handle.session.partition !== `server-candidate-${handle.targetRegistryScope}-${input.proof.attemptId}-${input.proof.generation}` ||
          prepared.navigationReceipt.attemptId !== input.proof.attemptId ||
          prepared.navigationReceipt.generation !== input.proof.generation || prepared.navigationReceipt.origin !== origin ||
          handle.navigationReceipt?.attemptId !== prepared.navigationReceipt.attemptId ||
          handle.navigationReceipt.generation !== prepared.navigationReceipt.generation ||
          handle.navigationReceipt.origin !== prepared.navigationReceipt.origin ||
          handle.navigationReceipt.observedAtMs !== prepared.navigationReceipt.observedAtMs ||
          handle.navigationReceipt.attemptId !== input.proof.attemptId ||
          handle.navigationReceipt.generation !== input.proof.generation || handle.navigationReceipt.origin !== origin ||
          handle.expectedServerFingerprint !== input.proof.observedFingerprint || handle.checkpoint !== "metadata" ||
          handle.status !== "prepared" || handle.priorAuthorityGuard?.scope !== prior.scope ||
          handle.priorAuthorityGuard.revision !== prior.revision ||
          handle.priorAuthorityGuard.connectionAttemptId !== prior.connectionAttemptId ||
          handle.priorAuthorityGuard.serverFingerprint !== prior.serverFingerprint ||
          handle.identityTransition.kind !== "accepted-identity-replacement" ||
          handle.identityTransition.priorConnectionAttemptId !== transition.priorConnectionAttemptId ||
          handle.identityTransition.priorServerFingerprint !== transition.priorServerFingerprint ||
          handle.identityTransition.priorRoutingServerUrl !== transition.priorRoutingServerUrl ||
          !sameAuthority(ports.currentAuthority(), prior)) return precommitFailure();
        stage = "promote";
      }
      return await continueForward(signal);
    } catch {
      return stage === "initial" || stage === "failed" ? precommitFailure() : forwardFailure();
    }
  };
  const invoke = () => {
    if (!running) running = Promise.resolve().then(run).finally(() => { running = null; });
    return running;
  };
  return { routingServerUrl: input.proof.serverUrl, snapshot: () => state, launch: invoke, retry: invoke };
}
