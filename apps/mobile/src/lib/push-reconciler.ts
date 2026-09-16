/**
 * D468 — headless, per-server Mobile push binding reconciliation.
 *
 * This deliberately does not know which server is visible.  Every operation
 * starts from the full ordinary registry, uses that server's SecureStore
 * session, and constructs a new shared API client for that server only.
 */
import Constants from "expo-constants";
import { Platform } from "react-native";

import { NautiloApiClient } from "@nautilo/api-client/browser";
import type {
  MobilePushInstallationDisableRequest,
  MobilePushInstallationBadgePreferenceRequest,
  MobilePushInstallationProofRevokeRequest,
  MobilePushInstallationRegisterRequest,
} from "@nautilo/types";

import { ensureValidToken } from "./auth";
import {
  acknowledgePushBinding,
  drainPushRevokeTombstones,
  loadOrCreatePushBinding,
  loadPushBinding,
  type PushBinding,
  type PushBindingStore,
  type PushRevokeTombstone,
} from "./push-binding-store";
import {
  refreshPushInstallation,
  subscribeToPushTokenRotations,
  type PushInstallationState,
  type PushTokenRotationSubscription,
} from "./push-installation";
import { loadPushBadgePreference } from "./push-permission-policy";
import {
  isServerRegistrationCurrent,
  loadRegistry,
  loadServerRegistrationSnapshot,
  loadTokenSnapshot,
  type ServerRecord,
  type ServerRegistrationSnapshot,
} from "./server-store";

const MAX_CONCURRENT_SERVER_RECONCILIATIONS = 2;

/**
 * A lifecycle reconciliation must never leave Settings in an unbounded
 * "connecting" state. This bounds one complete pass (native state, registry,
 * proof cleanup, and all server bindings); a later lifecycle signal or an
 * explicit retry starts a fresh pass. The timeout is deliberately owned here
 * rather than using AbortSignal.timeout(), which is not uniformly available in
 * the React Native runtime we support.
 */
const MOBILE_PUSH_RECONCILIATION_DEADLINE_MS = 15_000;

type PushClient = Pick<
  NautiloApiClient,
  | "setTokenProvider"
  | "registerPushInstallation"
  | "disablePushInstallation"
  | "setPushInstallationBadgePreference"
  | "revokePushInstallationWithProof"
>;

export type PushReconcileServerResult =
  | "registered"
  | "disabled"
  | "unchanged"
  | "signed_out"
  | "identity_unverified"
  | "identity_mismatch"
  | "native_unavailable"
  | "removed"
  | "unavailable"
  | "cancelled";

export interface PushReconcileSummary {
  readonly tombstones: { attempted: number; cleared: number; retained: number };
  /** Native token acquisition is separate from every server binding. */
  readonly native: "ready" | "unavailable";
  readonly servers: ReadonlyMap<string, PushReconcileServerResult>;
}

interface PushReconcilerDeps {
  readonly loadRegistry: typeof loadRegistry;
  readonly loadServerRegistrationSnapshot: typeof loadServerRegistrationSnapshot;
  readonly isServerRegistrationCurrent: typeof isServerRegistrationCurrent;
  readonly ensureValidToken: typeof ensureValidToken;
  readonly loadTokenSnapshot: typeof loadTokenSnapshot;
  readonly createClient: (serverUrl: string) => PushClient;
  readonly refreshInstallation: () => Promise<PushInstallationState>;
  readonly loadBadgePreference: () => Promise<boolean>;
  readonly loadBinding: (serverId: string) => Promise<PushBinding | null>;
  readonly loadOrCreateBinding: (serverId: string, ownerUserId: string) => Promise<PushBinding>;
  readonly acknowledgeBinding: PushBindingStore["acknowledgeBinding"];
  readonly drainTombstones: PushBindingStore["drainRevokeTombstones"];
  readonly subscribeTokenRotations: (
    onState: (state: PushInstallationState) => void,
    onError: (error: unknown) => void,
  ) => PushTokenRotationSubscription;
  readonly platform: "ios" | "android";
  readonly appVersion: () => string;
  readonly maxConcurrency: number;
  /** Test seam for the named, finite reconciliation deadline. */
  readonly reconciliationDeadlineMs: number;
  readonly scheduleRunDeadline: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearRunDeadline: (handle: ReturnType<typeof setTimeout>) => void;
}

function defaultAppVersion(): string {
  const config: unknown = Constants.expoConfig;
  const configuredVersion = config && typeof config === "object" && "version" in config
    ? (config as { version?: unknown }).version
    : undefined;
  const nativeVersion: unknown = Constants.nativeAppVersion;
  const candidate = configuredVersion ?? nativeVersion;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : "0.1.0";
}

const defaultDeps: PushReconcilerDeps = {
  loadRegistry,
  loadServerRegistrationSnapshot,
  isServerRegistrationCurrent,
  ensureValidToken,
  loadTokenSnapshot,
  createClient: (serverUrl) => new NautiloApiClient(serverUrl),
  refreshInstallation: () => refreshPushInstallation(),
  loadBadgePreference: loadPushBadgePreference,
  loadBinding: loadPushBinding,
  loadOrCreateBinding: loadOrCreatePushBinding,
  acknowledgeBinding: acknowledgePushBinding,
  drainTombstones: drainPushRevokeTombstones,
  subscribeTokenRotations: subscribeToPushTokenRotations,
  platform: Platform.OS === "android" ? "android" : "ios",
  appVersion: defaultAppVersion,
  maxConcurrency: MAX_CONCURRENT_SERVER_RECONCILIATIONS,
  reconciliationDeadlineMs: MOBILE_PUSH_RECONCILIATION_DEADLINE_MS,
  scheduleRunDeadline: (callback, delayMs) => setTimeout(callback, delayMs),
  clearRunDeadline: (handle) => clearTimeout(handle),
};

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

type ReconciliationAbortReason = "deadline" | "stopped";

interface ReconciliationRun {
  readonly controller: AbortController;
  readonly cancelled: Promise<ReconciliationAbortReason>;
  abort(reason: ReconciliationAbortReason): void;
  complete(): void;
  reason(): ReconciliationAbortReason | null;
}

function abortError(): Error {
  const error = new Error("Mobile push reconciliation was cancelled");
  error.name = "AbortError";
  return error;
}

function terminalProofRevokeError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "push_installation_revoked" || code === "push_revoke_proof_invalid";
}

function hasAcknowledged(
  binding: PushBinding,
  native: PushInstallationState,
): boolean {
  const acknowledged = binding.lastAcknowledged;
  return acknowledged !== null
    && acknowledged.tokenGeneration === native.tokenGeneration
    && acknowledged.permission === native.permission;
}

function hasNewerAcknowledgement(
  binding: PushBinding,
  native: PushInstallationState,
): boolean {
  return (binding.lastAcknowledged?.tokenGeneration ?? 0) > native.tokenGeneration;
}

function isVerifiedOwnerUserId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 180;
}

function registerInput(
  native: PushInstallationState,
  binding: PushBinding,
  appVersion: string,
  platform: "ios" | "android",
): MobilePushInstallationRegisterRequest {
  if (native.permission !== "granted" || native.expoPushToken === null || native.tokenGeneration < 1) {
    throw new Error("cannot register Mobile push without a granted native token");
  }
  return {
    version: 1,
    installationId: native.installationId,
    bindingId: binding.bindingId,
    platform,
    expoPushToken: native.expoPushToken,
    enabled: true,
    tokenGeneration: native.tokenGeneration,
    appVersion,
    permission: "granted",
    revokeProof: binding.revokeProof,
  };
}

function disableInput(
  native: PushInstallationState,
  binding: PushBinding,
): MobilePushInstallationDisableRequest {
  return {
    version: 1,
    installationId: native.installationId,
    bindingId: binding.bindingId,
    enabled: false,
    // A binding only exists after a successful granted registration, which
    // starts at generation 1. The max is defensive against native corruption.
    tokenGeneration: Math.max(1, native.tokenGeneration),
    permission: native.permission,
  };
}

function badgePreferenceInput(
  binding: PushBinding,
  native: PushInstallationState,
  enabled: boolean,
): MobilePushInstallationBadgePreferenceRequest {
  return {
    version: 1,
    bindingId: binding.bindingId,
    tokenGeneration: native.tokenGeneration,
    enabled,
  };
}

function endpointUnsupported(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && "status" in error
    && (error as { status?: unknown }).status === 404;
}

async function mapConcurrent<T>(
  values: readonly T[],
  maxConcurrency: number,
  run: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, maxConcurrency), values.length) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= values.length) return;
        const value = values[index];
        if (value === undefined) return;
        await run(value);
      }
    },
  );
  await Promise.all(workers);
}

/**
 * Races every asynchronous capability operation against the run boundary.
 * Expo/native and fetch implementations may finish after aborting their
 * supplied signal; the race lets the coordinator finish promptly while the
 * continuation that could register or acknowledge is never reached.
 */
async function awaitWithinRun<T>(
  run: ReconciliationRun,
  operation: () => Promise<T>,
): Promise<T> {
  if (run.reason() !== null) throw abortError();
  const completed = Promise.resolve()
    .then(() => {
      if (run.reason() !== null) throw abortError();
      return operation();
    })
    .then(
      (value) => ({ kind: "value" as const, value }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
  const outcome = await Promise.race([
    completed,
    run.cancelled.then((reason) => ({ kind: "cancelled" as const, reason })),
  ]);
  if (outcome.kind === "value") return outcome.value;
  throw outcome.kind === "error" ? outcome.error : abortError();
}

function interruptedServerResult(run: ReconciliationRun): PushReconcileServerResult {
  return run.reason() === "deadline" ? "unavailable" : "cancelled";
}

export interface MobilePushReconciler {
  /** Explicit background/lifecycle entry point; calls coalesce. */
  trigger(): Promise<PushReconcileSummary>;
  /** Installs only the Expo token-rotation subscription, never a root listener. */
  start(): void;
  /** Cancels local work and removes the rotation subscription. Idempotent. */
  stop(): void;
}

export function createMobilePushReconciler(
  supplied: Partial<PushReconcilerDeps> = {},
): MobilePushReconciler {
  const deps: PushReconcilerDeps = { ...defaultDeps, ...supplied };
  let running: Promise<PushReconcileSummary> | null = null;
  let rerunRequested = false;
  let currentRun: ReconciliationRun | null = null;
  let rotationSubscription: PushTokenRotationSubscription | null = null;
  let stopped = false;

  function createRun(): ReconciliationRun {
    const signalController = new AbortController();
    let cancelled = false;
    let abortReason: ReconciliationAbortReason | null = null;
    let resolveCancellation: ((reason: ReconciliationAbortReason) => void) | null = null;
    const cancellation = new Promise<ReconciliationAbortReason>((resolve) => {
      resolveCancellation = resolve;
    });
    let deadline: ReturnType<typeof setTimeout> | null = null;

    const abort = (reason: ReconciliationAbortReason): void => {
      if (cancelled) return;
      cancelled = true;
      abortReason = reason;
      if (deadline !== null) {
        deps.clearRunDeadline(deadline);
        deadline = null;
      }
      signalController.abort();
      resolveCancellation?.(reason);
    };

    // A bad test seam must not silently restore an unbounded production path.
    const deadlineMs = Number.isFinite(deps.reconciliationDeadlineMs)
      && deps.reconciliationDeadlineMs > 0
      ? deps.reconciliationDeadlineMs
      : MOBILE_PUSH_RECONCILIATION_DEADLINE_MS;
    deadline = deps.scheduleRunDeadline(() => abort("deadline"), deadlineMs);

    return {
      controller: signalController,
      cancelled: cancellation,
      abort,
      complete: () => {
        if (deadline !== null) {
          deps.clearRunDeadline(deadline);
          deadline = null;
        }
      },
      reason: () => abortReason,
    };
  }

  async function drainTombstones(run: ReconciliationRun): Promise<{ attempted: number; cleared: number; retained: number }> {
    return awaitWithinRun(run, () => deps.drainTombstones(async (tombstone: PushRevokeTombstone) => {
      if (run.reason() !== null) throw abortError();
      try {
        const client = deps.createClient(tombstone.serverUrl);
        const input: MobilePushInstallationProofRevokeRequest = {
          version: 1,
          bindingId: tombstone.bindingId,
          revokeProof: tombstone.revokeProof,
        };
        await awaitWithinRun(run, () => client.revokePushInstallationWithProof(input));
        if (run.reason() !== null) throw abortError();
        return "success";
      } catch (error) {
        if (isAbort(error)) throw error;
        return terminalProofRevokeError(error) ? "terminal" : "retry";
      }
    }));
  }

  async function stillCurrent(
    snapshot: ServerRegistrationSnapshot,
    run: ReconciliationRun,
  ): Promise<boolean> {
    return awaitWithinRun(run, () => deps.isServerRegistrationCurrent(snapshot));
  }

  async function reconcileServer(
    original: ServerRecord,
    native: PushInstallationState,
    badgeEnabled: boolean | null,
    run: ReconciliationRun,
  ): Promise<PushReconcileServerResult> {
    if (run.reason() !== null) return interruptedServerResult(run);
    try {
      const snapshot = await awaitWithinRun(run, () => deps.loadServerRegistrationSnapshot(original.id));
      if (!snapshot || snapshot.server.serverUrl !== original.serverUrl) return "removed";
      // This is deliberately per registry row, not per active UI server. A
      // stale session stays local to its server and can never redirect/logout
      // the visible server.
      if (!(await awaitWithinRun(run, () => deps.ensureValidToken(snapshot.server.id, snapshot.server.serverUrl)))) {
        return "signed_out";
      }
      if (!(await stillCurrent(snapshot, run))) return "removed";

      // The auth bundle receives this only after AuthProvider verified `whoami`.
      // Never infer a Human from an opaque bearer or allow a binding created by
      // an earlier Human on this server to cross that identity boundary.
      const ownerUserId = (await awaitWithinRun(run, () => deps.loadTokenSnapshot(snapshot.server.id))).tokens?.userId;
      if (!isVerifiedOwnerUserId(ownerUserId)) return "identity_unverified";
      if (!(await stillCurrent(snapshot, run))) return "removed";

      const binding = await awaitWithinRun(run, () => deps.loadBinding(snapshot.server.id));
      if (binding && binding.ownerUserId !== ownerUserId) return "identity_mismatch";
      if (binding && hasNewerAcknowledgement(binding, native)) return "unchanged";
      if (native.permission !== "granted") {
        // Do not create a capability on a device that has never granted push.
        if (!binding) return "unchanged";
        if (hasAcknowledged(binding, native)) return "unchanged";
        const client = deps.createClient(snapshot.server.serverUrl);
        client.setTokenProvider(() => deps.ensureValidToken(snapshot.server.id, snapshot.server.serverUrl));
        await awaitWithinRun(run, () => client.disablePushInstallation(disableInput(native, binding), {
          signal: run.controller.signal,
        }));
        if (!(await stillCurrent(snapshot, run))) return "removed";
        return (await awaitWithinRun(run, () => deps.acknowledgeBinding({
          serverId: snapshot.server.id,
          ownerUserId,
          bindingId: binding.bindingId,
          acknowledgement: { tokenGeneration: Math.max(1, native.tokenGeneration), permission: native.permission },
        }))) ? "disabled" : "removed";
      }

      if (native.expoPushToken === null || native.tokenGeneration < 1) return "native_unavailable";

      const currentBinding = binding ?? await awaitWithinRun(
        run,
        () => deps.loadOrCreateBinding(snapshot.server.id, ownerUserId),
      );
      const client = deps.createClient(snapshot.server.serverUrl);
      client.setTokenProvider(() => deps.ensureValidToken(snapshot.server.id, snapshot.server.serverUrl));
      const syncBadgePreference = async (): Promise<void> => {
        if (badgeEnabled === null) return;
        try {
          await awaitWithinRun(run, () => client.setPushInstallationBadgePreference(
            badgePreferenceInput(currentBinding, native, badgeEnabled),
            { signal: run.controller.signal },
          ));
        } catch (error) {
          // This endpoint was added after the v1 registration contract. An
          // older server must keep ordinary push working until it is upgraded.
          if (!endpointUnsupported(error)) throw error;
        }
      };
      if (hasAcknowledged(currentBinding, native)) {
        await syncBadgePreference();
        return "unchanged";
      }
      await awaitWithinRun(run, () => client.registerPushInstallation(
        registerInput(native, currentBinding, deps.appVersion(), deps.platform),
        { signal: run.controller.signal },
      ));
      if (!(await stillCurrent(snapshot, run))) return "removed";
      const acknowledged = await awaitWithinRun(run, () => deps.acknowledgeBinding({
        serverId: snapshot.server.id,
        ownerUserId,
        bindingId: currentBinding.bindingId,
        acknowledgement: { tokenGeneration: native.tokenGeneration, permission: native.permission },
      }));
      if (!acknowledged) return "removed";
      await syncBadgePreference();
      return "registered";
    } catch (error) {
      return isAbort(error) ? interruptedServerResult(run) : "unavailable";
    }
  }

  async function runOnce(): Promise<PushReconcileSummary> {
    const run = createRun();
    currentRun = run;
    let tombstones = { attempted: 0, cleared: 0, retained: 0 };
    try {
      try {
        tombstones = await drainTombstones(run);
      } catch (error) {
        if (isAbort(error)) return { tombstones, native: "unavailable", servers: new Map() };
        // Proof cleanup is opportunistic. It must not keep ordinary current
        // server registration from reaching an actionable result.
      }

      let native: PushInstallationState;
      try {
        native = await awaitWithinRun(run, () => deps.refreshInstallation());
      } catch {
        return { tombstones, native: "unavailable", servers: new Map() };
      }

      let registry: Awaited<ReturnType<typeof deps.loadRegistry>>;
      try {
        registry = await awaitWithinRun(run, () => deps.loadRegistry());
      } catch {
        return { tombstones, native: "unavailable", servers: new Map() };
      }

      let badgeEnabled: boolean | null = null;
      try {
        badgeEnabled = await awaitWithinRun(run, () => deps.loadBadgePreference());
      } catch {
        // Never guess "on" when local policy cannot be read. Normal push
        // registration remains useful and a later activation retries sync.
      }

      // Each server can only know its own unread total. With more than one
      // registered server, a background push must not replace Mobile's exact
      // aggregate badge with one server's partial count. The active lifecycle
      // badge reconciler remains enabled locally and owns that aggregate.
      const backgroundBadgeEnabled = badgeEnabled === null
        ? null
        : badgeEnabled && registry.servers.length === 1;

      const servers = new Map<string, PushReconcileServerResult>();
      await mapConcurrent(registry.servers, deps.maxConcurrency, async (server) => {
        const result = await reconcileServer(server, native, backgroundBadgeEnabled, run);
        servers.set(server.id, result);
      });
      return { tombstones, native: "ready", servers };
    } finally {
      run.complete();
      if (currentRun === run) currentRun = null;
    }
  }

  async function run(): Promise<PushReconcileSummary> {
    let result: PushReconcileSummary;
    do {
      rerunRequested = false;
      result = await runOnce();
    } while (rerunRequested && !stopped);
    return result!;
  }

  function trigger(): Promise<PushReconcileSummary> {
    if (stopped) {
      return Promise.resolve({
        tombstones: { attempted: 0, cleared: 0, retained: 0 },
        native: "unavailable",
        servers: new Map(),
      });
    }
    if (running) {
      rerunRequested = true;
      return running;
    }
    const next = run();
    running = next;
    const clearRunning = () => {
      if (running === next) {
        running = null;
      }
    };
    void next.then(clearRunning, clearRunning);
    return next;
  }

  function start(): void {
    if (rotationSubscription) return;
    stopped = false;
    rotationSubscription = deps.subscribeTokenRotations(
      () => { void trigger().catch(() => {}); },
      // Later UI owns display/retry state. The headless coordinator keeps
      // rotation errors local rather than leaking capability material.
      () => {},
    );
    void trigger().catch(() => {});
  }

  function stop(): void {
    rotationSubscription?.remove();
    rotationSubscription = null;
    stopped = true;
    rerunRequested = false;
    // The current run owns all post-await continuation fences. It returns
    // cancelled promptly even when a native or network implementation ignores
    // AbortSignal, and those late completions cannot reach registration/ack.
    currentRun?.abort("stopped");
  }

  return { trigger, start, stop };
}
