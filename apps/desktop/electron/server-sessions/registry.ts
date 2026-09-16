/**
 * M161 Phase 1 — ServerSessionRegistry.
 *
 * Replaces the module-level `mainWindow` / `resolvedServerUrl` /
 * `logtoConfig` / `isSignedIn` singletons with a registry that today
 * holds one entry (the booted server) and later (Phases 2–3) holds N
 * per-server sessions, each backed by its own `WebContentsView` on a
 * shared `BaseWindow` host.
 *
 * Phase 1 scope is deliberately narrow:
 *   - `ensure` creates registry entries while only the first one becomes
 *     active automatically. Full view creation/switching lands in Phase 3.
 *   - Every session canonicalizes its URL once, then derives its 16-character
 *     scope with the same `serverUrlScope` helper used by auth filenames.
 *   - `getBySender` returns `null` for unknown `webContentsId` — this is
 *     a security boundary (issue §"Common pitfalls" #1). The Phase 1 boot
 *     path binds the initial view; Phase 2 uses the same mapping for
 *     sender-scoped auth.
 *
 * No `WebContentsView` is constructed here directly. The `view` slot is
 * filled by the host wiring injected through `configure()` (main.ts,
 * Phase 1.3/1.4); it stays `null` until then, so this module remains
 * unit-testable without a live Electron renderer.
 *
 * M161 Phase 3 — `switchTo` / `add` / `close` now perform real
 * in-process orchestration (lazy view creation, visibility handoff,
 * Logto resolution, silent token refresh, stop-before-start relay
 * handoff) through injected hooks, plus `onChange` subscription and
 * `listEnriched` (merge recents + live, enrich from public
 * `/api/setup/status` + icon URL). The registry stays pure-ish: every
 * Electron/relay/network side-effect goes through a hook so the new
 * `server-session-switch.test.ts` can assert ordering with mocks.
 */

import type { WebContentsView } from "electron";
import { connectionAttemptId, type ObservationReceipt } from "../connection-attempt";
import {
  isConnectionAttemptId,
  isOpaqueActiveRevision,
  isServerFingerprint,
} from "../config-schema";
import { serverUrlScope } from "../auth/token-store";
import type { TokenBundle } from "../auth/token-store";
import type { PendingConnection } from "../pending-connection";
import { isLoopbackHostname } from "@nautilo/config/loopback-origin";
import { canonicalServerScope, loopbackDedupeKey } from "../url-canonical";
import type { RecentServerEntry } from "../recent-servers-schema";
import {
  NOTIFICATION_SUMMARY_FRESH_MS,
  aggregatePublicSummaries,
  publicSummaryState,
  validateNotificationSummaryInput,
  type NotificationAggregate,
  type NotificationSummaryInput,
  type PublicNotificationSummary,
  type StoredNotificationSummary,
} from "../notification-summary";

export type ServerSessionConnection =
  | "connecting"
  | "live"
  | "offline"
  | "incompatible";

/**
 * Logto OIDC config resolved from the server's `/health` payload.
 * Mirrors the shape of the former module-level `logtoConfig` global.
 */
export type ServerSessionLogtoConfig = {
  endpoint: string;
  appId: string;
  resource: string;
};

export interface ServerSessionProfile {
  name?: string;
  description?: string;
  iconUrl: string;
}

/** Canonical `AvatarRef` shape returned by public `/api/setup/status`. */
export type ServerIconRef =
  | { kind: "preset"; id: string }
  | { kind: "uploaded"; blobId: string }
  | { kind: "generated"; blobId: string };

export interface ServerSession {
  /** `sha256(canonicalUrl).slice(0, 16)` — the map key. */
  scope: string;
  /** The server URL the session was created from (canonical form). */
  serverUrl: string;
  /** `persist:server-<scope>` — derived from the same canonical value. */
  partition: string;
  /**
   * The `WebContentsView` hosting this session's renderer. `null` until
   * the host wiring in main.ts attaches one (Phase 1.3/1.4).
   */
  view: WebContentsView | null;
  logtoConfig: ServerSessionLogtoConfig | null;
  signedIn: boolean;
  relayActive: boolean;
  profile: ServerSessionProfile | null;
  connection: ServerSessionConnection;
}

/**
 * Public, renderer-safe shape — no `view`, no `partition`, no auth
 * secrets. Returned by `list()` and (Phase 3) the `servers:list` IPC.
 */
export interface ServerListEntry {
  url: string;
  name?: string;
  description?: string;
  iconUrl: string;
  connection: ServerSessionConnection;
}

/**
 * M161 Phase 3 — enriched entry returned by `listEnriched()` and the
 * `servers:list` IPC. Adds `active` / `signedIn` (merged from the live
 * session) and `fingerprint` (Phase 3.2, copied from the matching
 * recent-servers entry when present).
 */
export interface EnrichedServerListEntry extends ServerListEntry {
  active: boolean;
  signedIn: boolean;
  fingerprint?: string;
  notificationSummary: PublicNotificationSummary;
}

export interface EnrichedServerListResult {
  servers: EnrichedServerListEntry[];
  aggregate: NotificationAggregate;
}

export type PublishNotificationSummaryResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "unregistered-sender"
        | "invalid-payload"
        | "stale-generation"
        | "handoff-pending";
    };

/**
 * M161 Phase 3 alpha/current `/api/setup/status.serverProfile` contract.
 * Name and canonical icon are required; description remains optional.
 */
export interface ServerSetupStatusSummary {
  name: string;
  description?: string | null;
  icon: ServerIconRef;
}

/** Build the canonical cache-versioned public server icon URL. */
export function buildVersionedServerIconUrl(
  serverUrl: string,
  status: ServerSetupStatusSummary | null,
): string {
  const base = serverUrl.replace(/\/$/, "");
  if (!status) return `${base}/api/server/icon`;
  const version = status.icon.kind === "preset"
    ? status.icon.id
    : status.icon.blobId;
  return `${base}/api/server/icon?v=${encodeURIComponent(version)}`;
}

/**
 * Parse the alpha/current public setup-status profile projection.
 * Missing/invalid required name or icon returns null (typed as
 * `incompatible` by the network adapter). `server-default` remains a
 * valid preset id during rolling updates.
 */
export function parseServerSetupStatusSummary(
  raw: unknown,
): ServerSetupStatusSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const rawProfile = body["serverProfile"];
  const profile =
    rawProfile && typeof rawProfile === "object" && !Array.isArray(rawProfile)
      ? rawProfile as Record<string, unknown>
      : null;
  if (!profile) return null;
  const name = profile["name"];
  if (typeof name !== "string" || name.length === 0) return null;
  const icon = parseServerIconRef(profile["icon"]);
  if (!icon) return null;
  const summary: ServerSetupStatusSummary = { name, icon };
  if (typeof profile["description"] === "string") {
    summary.description = profile["description"];
  }
  return summary;
}

function parseServerIconRef(raw: unknown): ServerIconRef | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const icon = raw as Record<string, unknown>;
  if (
    icon["kind"] === "preset" &&
    typeof icon["id"] === "string" &&
    icon["id"].length > 0
  ) {
    return { kind: "preset", id: icon["id"] };
  }
  if (
    (icon["kind"] === "uploaded" || icon["kind"] === "generated") &&
    typeof icon["blobId"] === "string" &&
    icon["blobId"].length > 0
  ) {
    return { kind: icon["kind"], blobId: icon["blobId"] };
  }
  return null;
}

/** Fail-closed result from the target server's public `/health` probe. */
export type ServerFingerprintProbeResult =
  | { ok: true; fingerprint: string }
  | { ok: false; reason: "offline" };

/** Network + contract classification for public setup status. */
export type ServerSetupStatusProbeResult =
  | { kind: "live"; profile: ServerSetupStatusSummary }
  | { kind: "offline" }
  | { kind: "incompatible" };

/** Typed switch result consumed by the desktop preload and Servers panel. */
export type ServerSwitchResult =
  | { ok: true }
  | { ok: false; reason: "unknown-server" }
  | { ok: false; reason: "offline" }
  | { ok: false; reason: "incompatible" }
  | { ok: false; reason: "fingerprint-storage-failed" }
  | { ok: false; reason: "handoff-pending" }
  | {
      ok: false;
      reason: "wrong-server";
      expectedFingerprint: string;
      foundFingerprint: string;
    };

/** Typed outcome from an explicit destructive Forget action. */
export type ServerForgetResult =
  | { ok: true; fallbackFailed: boolean; landedEmpty: boolean }
  | { ok: false; reason: "unknown-server" | "handoff-pending" };

export type ServerFallbackActivationResult =
  | { kind: "activated" }
  | { kind: "indeterminate" }
  | { kind: "not-activated"; result: Exclude<ServerSwitchResult, { ok: true } | { ok: false; reason: "handoff-pending" }> };

const PARTITION_PREFIX = "persist:server-";

/**
 * M161 Phase 3 — host-injected hooks for the in-process switch/add/close
 * orchestration. Every Electron, relay, token-store, and network
 * side-effect goes through a hook so the registry stays unit-testable
 * (the `server-session-switch.test.ts` mocks these to assert ordering).
 * All hooks optional; when absent, the registry degrades to Phase 1
 * bookkeeping (active-scope flip only) so the no-arg constructor stays
 * valid for existing tests.
 */
export interface ServerSessionRegistryHooks {
  /** The sole production fallback path; its transaction owns config + registry authority. */
  activateFallback?(serverUrl: string): Promise<ServerFallbackActivationResult>;
  /**
   * Create + attach a `WebContentsView` for a session that has none.
   * Main attaches the sender, adds the view to the host `BaseWindow`,
   * and sets initial bounds here. MUST NOT load a URL — the registry
   * drives the initial `${serverUrl}/` navigation via `navigateView`
   * so the test can observe it. Returns the created view.
   */
  createView?(session: ServerSession): WebContentsView;
  /** Create an unattached D514 candidate. It must not be added to the host. */
  createCandidateView?(session: ServerSession): WebContentsView;
  /**
   * Idempotently attach a prepared candidate at the visibility checkpoint.
   * A failed checkpoint barrier may replay this effect after restart.
   */
  attachCandidateView?(session: ServerSession, view: WebContentsView): void;
  /** Idempotently bind the detached renderer sender after durable commit. */
  bindCandidateSender?(
    previous: ServerSession | null,
    candidate: ServerSession,
    view: WebContentsView,
  ): void;
  /** Destroy an unattached candidate without assuming host membership. */
  destroyCandidateView?(view: WebContentsView): void;
  /** Show a previously-hidden view (active handoff). */
  showView?(view: WebContentsView): void;
  /** Hide a view without destroying it (preserves the background session). */
  hideView?(view: WebContentsView): void;
  /**
   * Deliver the renderer-safe active-session lifecycle state. This is separate
   * from view visibility: hidden session renderers remain alive, but must stop
   * issuing privileged active-only IPC while inactive.
   */
  setRendererActive?(view: WebContentsView, active: boolean): void;
  /** Navigate a view's renderer to a URL (initial `/` load on creation). */
  navigateView?(view: WebContentsView, url: string): void;
  /**
   * Ask an already-live target renderer to route to Home without
   * reloading its WebContents. Phase 4 owns the Workbench router listener.
   */
  navigateHome?(view: WebContentsView): void;
  /** Destroy + detach a view (on close). */
  destroyView?(view: WebContentsView): void;
  /**
   * Clear browser data for one server partition. Electron lives behind this
   * hook so partition cleanup is unit-testable without a raw Electron call.
   */
  clearPersistentPartition?(partition: string): Promise<void>;
  /**
   * Reduce authority when an active server is forgotten without a usable
   * fallback. Main must stop the relay before deactivating the workstation
   * profile, mirroring explicit sign-out.
   */
  teardownForgottenActive?(): Promise<void>;
  /**
   * Stop-before-start relay handoff to the target session. Main
   * implements this via `setActiveRelay(registry, session, opts)`,
   * which awaits `stopRelay()` before `startRelay(...)`.
   */
  handoffRelay?(session: ServerSession): Promise<void>;
  /** Resolve + cache the target session's Logto config from `/health`. */
  resolveLogtoConfig?(serverUrl: string): Promise<boolean>;
  /** Load persisted tokens for a server URL (decides re-auth vs. refresh). */
  loadTokens?(serverUrl: string): TokenBundle | null;
  /** Silently refresh tokens for a server URL; resolves false on failure. */
  refreshTokens?(serverUrl: string): Promise<boolean>;
  /**
   * Fetch the target's fingerprint from `/health`. Runs before view
   * creation, activation, visibility changes, auth, or relay handoff.
   */
  probeFingerprint?(serverUrl: string): Promise<ServerFingerprintProbeResult>;
  /** Persist a learned first-connect fingerprint on the matching recent entry. */
  storeFingerprint?(serverUrl: string, fingerprint: string): boolean;
  // --- listEnriched hooks ---
  /** Return recent-server entries (Phase 3.2 source for fingerprint). */
  listRecents?(): RecentServerEntry[];
  /** Bounded diagnostic used only by listEnriched; it grants no authority. */
  fetchListSetupStatus?(serverUrl: string): Promise<ServerSetupStatusProbeResult>;
  /** Build the icon URL for a server from its setup status (preset vs. blob). */
  iconUrlFor?(serverUrl: string, status: ServerSetupStatusSummary | null): string;
}

/**
 * D514 switch transaction input. `canonicalOrigin` is the network identity;
 * `priorRegistryScope` is the hash-derived registry identity and is used only
 * as an optimistic guard. They are deliberately not interchangeable.
 */
export interface PrepareServerSwitchInput {
  attemptId: string;
  generation: number;
  canonicalOrigin: string;
  routingServerUrl: string;
  priorRegistryScope: string | null;
  /** Exact prior config marker, when available, for indeterminate-commit resolution. */
  priorAuthorityGuard: PriorActiveAuthorityGuard;
  identityTransition: PendingConnection["identityTransition"];
  /** Explicit same-origin accepted-identity replacement; never inferred. */
  forceDetachedReplacement?: boolean;
  acceptedIdentityReplacementReceipt?: ObservationReceipt;
  candidateServerFingerprint: string;
  /**
   * Await main's exact-origin navigation observation. For an existing view
   * this hook must observe its current document without navigating/reloading
   * it, preserving the background SPA.
   */
  awaitNavigationReceipt(input: {
    attemptId: ObservationReceipt["attemptId"];
    generation: number;
    session: ServerSession;
    view: WebContentsView;
    newlyCreatedView: boolean;
    expectedOrigin: string;
  }): Promise<ObservationReceipt>;
}

export type PreparedServerSwitchCheckpoint =
  | "metadata"
  | "old-codex"
  | "old-relay"
  | "old-profile"
  | "old-identity"
  | "renderer-authority"
  | "visibility"
  | "target-relay"
  | "pending-clear"
  | "complete";
export type IncompletePreparedServerSwitchCheckpoint = Exclude<
  PreparedServerSwitchCheckpoint,
  "complete"
>;

export interface PreparedServerSwitchHandle {
  readonly attemptId: string;
  readonly generation: number;
  readonly canonicalOrigin: string;
  readonly targetRegistryScope: string;
  readonly priorRegistryScope: string | null;
  readonly priorAuthorityGuard: PriorActiveAuthorityGuard | null;
  readonly session: ServerSession;
  /** Detached candidate renderer; never sender-bound before durable authority transfer. */
  readonly view: WebContentsView;
  readonly newlyCreatedView: boolean;
  readonly navigationReceipt: ObservationReceipt | null;
  readonly expectedServerFingerprint: string;
  readonly identityTransition: PendingConnection["identityTransition"];
  readonly status:
    | "preparing"
    | "prepared"
    | "committing"
    | "commit-outcome-unknown"
    | "awaiting-revalidation"
    | "committed-handoff"
    | "committed-paused"
    | "handing-off"
    | "complete"
    | "invalid";
  readonly checkpoint: PreparedServerSwitchCheckpoint;
}

export type PrepareServerSwitchResult =
  | {
      ok: true;
      handle: PreparedServerSwitchHandle;
      navigationReceipt: ObservationReceipt;
    }
  | {
      ok: false;
      reason:
        | "invalid-attempt"
        | "invalid-origin"
        | "invalid-receipt"
        | "stale-prior"
        | "view-unavailable"
        | "navigation-failed"
        | "cross-origin"
        | "superseded"
        | "committed-handoff-pending";
    };

export interface PromotePreparedServerSwitchHooks {
  /** Durable linearization point: atomically commit URL + revision + attempt. */
  commitActiveAuthority(input: {
    canonicalOrigin: string;
    targetRegistryScope: string;
    priorRegistryScope: string | null;
    attemptId: string;
    generation: number;
    serverFingerprint: string;
  }): Promise<
    | { committed: false }
    | {
        committed: true;
        /** Optional failure after the atomic commit; resume starts here. */
        followupFailure?: "metadata";
      }
  >;
  persistMetadata(session: ServerSession): Promise<void>;
  stopOldCodex(session: ServerSession): Promise<void>;
  stopOldRelay(session: ServerSession): Promise<void>;
  deactivateOldProfile(session: ServerSession): Promise<void>;
  retireOldIdentity?(input: Readonly<{ priorRoutingServerUrl: string; targetRegistryScope: string }>): Promise<void>;
  startTargetRelay?(session: ServerSession): Promise<void>;
  /** Caller decides from verified/authenticated state; false still tears A down. */
  shouldStartTargetRelay?: boolean;
  /** Deliberately pause committed truth before local renderer authority transfer. */
  pauseBeforeRendererAuthority?: boolean;
  /** Durably name the next incomplete effect before that effect may run. */
  persistNextCheckpoint(
    checkpoint: IncompletePreparedServerSwitchCheckpoint,
  ): Promise<void>;
  clearPending(): Promise<void>;
}

export interface ResumeCommittedServerSwitchInput {
  attemptId: string;
  generation: number;
  canonicalOrigin: string;
  /** Validated navigation/metadata URL; authority receipts remain origin-bound. */
  routingServerUrl: string;
  identityTransition: PendingConnection["identityTransition"];
  targetRegistryScope: string;
  priorRegistryScope: string | null;
  /** The next incomplete post-commit step persisted in the pending journal. */
  nextCheckpoint: IncompletePreparedServerSwitchCheckpoint;
  requiresEphemeralFactReconstructionAndRevalidation: true;
  priorRecoveryGuard: RecoveryPriorAuthorityGuard;
  /** Exact config authority reread before any ephemeral network work begins. */
  currentActiveAuthority: ObservedActiveAuthority;
}

export type RecoveryPriorAuthorityGuard = Readonly<{
  scope: string | null;
  revision: string | null;
}>;

export type CompleteCommittedHandoffRevalidationResult =
  | { ok: true; handle: PreparedServerSwitchHandle }
  | { ok: false; reason: "stale-handle" | "invalid-receipt" };

export type ObservedActiveAuthority = Readonly<{
  scope: string | null;
  revision: string | null;
  connectionAttemptId: string | null;
  serverFingerprint: string | null;
}>;

export type PriorActiveAuthorityGuard = Readonly<{
  /** Canonical active origin from config, never the hash-derived registry key. */
  scope: string | null;
  revision: string | null;
  connectionAttemptId: string | null;
  serverFingerprint: string | null;
}>;

export type CommittedHandoffRevalidationProof = Readonly<{
  navigationReceipt: ObservationReceipt;
  serverFingerprint: string;
}>;

export type ResolveUnknownCommitOutcomeResult =
  | { outcome: "not-committed" }
  | { outcome: "committed-handoff"; handle: PreparedServerSwitchHandle }
  | { outcome: "unresolved" }
  | { outcome: "stale-handle" };

export type ResumeCommittedServerSwitchResult =
  | { ok: true; handle: PreparedServerSwitchHandle }
  | {
      ok: false;
      reason: "invalid-record" | "target-not-active" | "view-unavailable" | "handoff-pending";
    };

export type PromotePreparedServerSwitchResult =
  | {
      ok: true;
      paused?: false;
      receipt: {
        attemptId: string;
        generation: number;
        canonicalOrigin: string;
        targetRegistryScope: string;
      };
    }
  | {
      ok: true;
      paused: true;
      handle: PreparedServerSwitchHandle;
      checkpoint: "renderer-authority";
    }
  | {
      ok: false;
      reason: "stale-handle" | "commit-failed" | "commit-outcome-unknown";
      handle?: PreparedServerSwitchHandle;
    }
  | {
      ok: false;
      reason: "postcommit-failed";
      handle: PreparedServerSwitchHandle;
      checkpoint: PreparedServerSwitchCheckpoint;
    };

type MutablePreparedServerSwitchHandle = {
  -readonly [K in keyof PreparedServerSwitchHandle]: PreparedServerSwitchHandle[K];
} & {
  view: WebContentsView;
  priorSession: ServerSession | null;
  /** Session whose renderer is being atomically replaced (may differ from cleanup A). */
  replacementPriorSession: ServerSession | null;
  priorView: WebContentsView | null;
  replacesActiveView: boolean;
  priorViewRetired: boolean;
  targetSessionWasCreated: boolean;
  nextPostCommitStep: number;
  requiresRendererRevalidation: boolean;
};

export class ServerSessionRegistry {
  private readonly sessions = new Map<string, ServerSession>();
  private readonly senderToScope = new Map<number, string>();
  private readonly notificationSummaries = new Map<
    string,
    StoredNotificationSummary
  >();
  /**
   * Process-lifetime presentation ranks for the currently visible canonical
   * candidates. Session materialization changes the source map's insertion
   * order, so listEnriched must not derive panel order from it after the
   * first projection.
   */
  private readonly enrichedDisplayOrder = new Map<string, number>();
  private nextEnrichedDisplayOrder = 0;
  private activeScope: string | null = null;
  private hooks: ServerSessionRegistryHooks = {};
  private readonly changeListeners = new Set<() => void>();
  private notificationExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private preparedSwitch: MutablePreparedServerSwitchHandle | null = null;
  /** Fail-closed gap between durable commit and renderer-authority checkpoint. */
  private privilegeHandoffPendingScope: string | null = null;

  constructor(
    private readonly notificationNowMs: () => number = () =>
      globalThis.performance.now(),
  ) {}

  /** Public, renderer-safe view of all known sessions. */
  list(): ServerListEntry[] {
    return [...this.sessions.values()].map(sessionToListEntry);
  }

  /** The active session, or `null` if none has been ensured yet. */
  get active(): ServerSession | null {
    if (this.activeScope === null) return null;
    return this.sessions.get(this.activeScope) ?? null;
  }

  /**
   * Resolve the session that owns a given `webContentsId`. Returns
   * `null` for unknown senders — callers MUST treat `null` as a
   * rejection (issue §"Common pitfalls" #1: sender mapping is a
   * security boundary). `assertMainWindowSender` is built on this method;
   * Phase 2 reuses it for sender-scoped auth.
   */
  getBySender(webContentsId: number): ServerSession | null {
    const scope = this.senderToScope.get(webContentsId);
    if (scope === undefined) return null;
    return this.sessions.get(scope) ?? null;
  }

  /**
   * M240 — accept a content-free authoritative snapshot from the sender's own
   * registered session. Background senders are allowed; popup IPC keeps its
   * separate active-only authority.
   */
  publishNotificationSummary(
    webContentsId: number,
    input: NotificationSummaryInput,
  ): PublishNotificationSummaryResult {
    if (this.hasCommittedHandoffPending()) {
      return { ok: false, reason: "handoff-pending" };
    }
    const session = this.getBySender(webContentsId);
    if (!session) return { ok: false, reason: "unregistered-sender" };
    const validated = validateNotificationSummaryInput(input);
    if (!validated) return { ok: false, reason: "invalid-payload" };

    const previous = this.notificationSummaries.get(session.scope);
    if (
      previous &&
      (
        (previous.epoch === validated.epoch &&
          validated.generation <= previous.generation) ||
        (previous.epoch !== validated.epoch && validated.generation !== 1)
      )
    ) {
      return { ok: false, reason: "stale-generation" };
    }

    this.notificationSummaries.set(session.scope, {
      ...validated,
      receivedAtMs: this.notificationNowMs(),
    });
    this.scheduleNotificationExpiry();
    this.notifyChange();
    return { ok: true };
  }

  clearNotificationSummaryForScope(scope: string): void {
    if (this.hasCommittedHandoffPending()) return;
    if (!this.notificationSummaries.delete(scope)) return;
    this.scheduleNotificationExpiry();
    this.notifyChange();
  }

  /**
   * M161 Phase 2 — resolve the active session for a privileged IPC
   * sender. Returns the active session when `webContentsId` is bound to
   * it; throws for unknown senders and for known-but-non-active senders
   * (fail closed). The renderer never supplies a server URL for auth
   * scope; main derives the server identity from this mapping. This is
   * the security boundary from issue §"Common pitfalls" #1.
   */
  resolveActiveFromSenderOrThrow(webContentsId: number): ServerSession {
    const session = this.getBySender(webContentsId);
    if (!session) {
      throw new Error("ipc-denied: sender is not registered");
    }
    if (this.preparedSwitch?.status === "commit-outcome-unknown") {
      throw new Error("ipc-denied: active authority commit outcome is unknown");
    }
    if (this.preparedSwitch?.status === "awaiting-revalidation") {
      throw new Error("ipc-denied: committed handoff revalidation is incomplete");
    }
    if (session !== this.active) {
      throw new Error("ipc-denied: sender is not the active session");
    }
    if (session.scope === this.privilegeHandoffPendingScope) {
      throw new Error("ipc-denied: active session handoff is incomplete");
    }
    return session;
  }

  /**
   * M161 Phase 2 — look up a session by its server URL (canonicalized
   * through the same single-source helper the registry uses on
   * `ensure`). Used by the boot/relay path to resolve the
   * `ServerSession` for a `serverUrl` without a sender id (e.g. before
   * the view is attached). Returns `null` for an unknown URL.
   */
  getByServerUrl(serverUrl: string): ServerSession | null {
    const canonicalUrl = canonicalServerScope(serverUrl);
    const scope = serverUrlScope(canonicalUrl);
    return this.sessions.get(scope) ?? null;
  }

  /**
   * M161 Phase 6.6 (Stack 198) — find the recent entry that belongs to the
   * same trusted-fingerprint identity group as `canonicalUrl`: the exact
   * match when present, otherwise the most-recent same-protocol+port
   * loopback alias. Non-loopback URLs and cross-port/protocol aliases never
   * match through the fallback (only the exact match is returned). Used by
   * `switchTo` preflight and `findSessionByTrustedFingerprint` so a loopback
   * alias represented only by a live session still resolves the trusted
   * fingerprint stored on its matching loopback recent entry.
   */
  private findRecentForCanonicalUrl(
    canonicalUrl: string,
    recents: readonly RecentServerEntry[],
  ): RecentServerEntry | undefined {
    let exact: RecentServerEntry | undefined;
    const aliases: RecentServerEntry[] = [];
    const loopbackKey = loopbackAliasKey(canonicalUrl);
    for (const entry of recents) {
      let entryCanonical: string;
      try {
        entryCanonical = canonicalServerScope(entry.url);
      } catch {
        continue;
      }
      if (entryCanonical === canonicalUrl) {
        exact = entry;
        break;
      }
      if (loopbackKey !== null && loopbackAliasKey(entry.url) === loopbackKey) {
        aliases.push(entry);
      }
    }
    if (exact) return exact;
    if (aliases.length === 0) return undefined;
    aliases.sort((a, b) => {
      const at = Date.parse(a.lastUsedAt);
      const bt = Date.parse(b.lastUsedAt);
      if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
      if (Number.isNaN(at)) return 1;
      if (Number.isNaN(bt)) return -1;
      return bt - at;
    });
    return aliases[0];
  }

  /**
   * M161 Phase 6.4 — find an existing live session whose trusted
   * fingerprint (copied from the recent entry matching its canonical
   * URL) equals `fingerprint`. Used by `switchTo` preflight to reuse an
   * existing session instead of creating a duplicate alias session for
   * the same trusted server. Returns `null` when no session's recent
   * carries a matching nonempty fingerprint.
   *
   * M161 Phase 6.6 (Stack 198) — the recent lookup now uses the loopback
   * identity group, so a live session whose trusted fingerprint lives on
   * a same-protocol+port loopback alias recent is still recognized.
   */
  private findSessionByTrustedFingerprint(fingerprint: string): ServerSession | null {
    if (typeof fingerprint !== "string" || fingerprint.length === 0) return null;
    const recents = this.hooks.listRecents?.() ?? [];
    for (const session of this.sessions.values()) {
      const recent = this.findRecentForCanonicalUrl(session.serverUrl, recents);
      if (recent?.fingerprint && recent.fingerprint === fingerprint) {
        return session;
      }
    }
    return null;
  }

  /**
   * M161 Phase 2 — mark exactly one session as the active relay owner.
   * Sets `relayActive = true` on the named scope's session and `false`
   * on every other session, so a relay handoff can never leave two
   * relay owners. No-op for an unknown scope (every session stays
   * `false`).
   */
  setRelayActiveFor(scope: string): void {
    if (this.hasCommittedHandoffPending()) return;
    for (const [s, session] of this.sessions) {
      session.relayActive = s === scope;
    }
  }

  /**
   * Bind a `webContentsId` to a known scope. Unknown scopes and attempts
   * to rebind an already-privileged sender to a different session fail
   * closed. Same-scope calls are idempotent.
   */
  attachSender(webContentsId: number, scope: string): boolean {
    if (!this.sessions.has(scope)) return false;
    const existing = this.senderToScope.get(webContentsId);
    if (existing !== undefined && existing !== scope) return false;
    if (existing === scope) return true;

    let replaced = false;
    for (const [senderId, senderScope] of this.senderToScope) {
      if (senderScope !== scope) continue;
      this.senderToScope.delete(senderId);
      replaced = true;
    }
    this.senderToScope.set(webContentsId, scope);
    if (replaced) {
      this.notificationSummaries.delete(scope);
      this.scheduleNotificationExpiry();
      this.notifyChange();
    }
    return true;
  }

  /** Remove a destroyed renderer's authority and its user-private summary. */
  detachSender(webContentsId: number): void {
    const scope = this.senderToScope.get(webContentsId);
    if (scope === undefined) return;
    this.senderToScope.delete(webContentsId);
    this.notificationSummaries.delete(scope);
    this.scheduleNotificationExpiry();
    this.notifyChange();
  }

  /**
   * Ensure a session exists for `serverUrl`. The first session becomes
   * active; later entries do not replace it until `switchTo` is called.
   * Canonical URL and hash scope are derived once and then reused.
   */
  ensure(serverUrl: string): ServerSession {
    if (this.hasCommittedHandoffPending()) {
      throw new Error("server-session-handoff-pending");
    }
    const canonicalUrl = canonicalServerScope(serverUrl);
    const scope = serverUrlScope(canonicalUrl);
    const existing = this.sessions.get(scope);
    if (existing) return existing;
    const session: ServerSession = {
      scope,
      serverUrl: canonicalUrl,
      partition: `${PARTITION_PREFIX}${scope}`,
      view: null,
      logtoConfig: null,
      signedIn: false,
      relayActive: false,
      profile: null,
      connection: "connecting",
    };
    this.sessions.set(scope, session);
    // Phase 1: only the first session becomes active. Subsequent
    // `ensure` calls create the entry but leave the active session
    // untouched — `switchTo` (Phase 3) is the only path that changes
    // active for an already-existing session.
    if (this.activeScope === null) {
      this.activeScope = scope;
    }
    return session;
  }

  /**
   * M161 Phase 3 — inject host hooks for switch/add/close/list
   * orchestration. Main calls this once during boot before any
   * `switchTo` / `add` / `close` can fire. Calling with no args (or
   * before boot) leaves the registry in Phase 1 bookkeeping mode so
   * the no-arg constructor + existing tests stay valid.
   */
  configure(hooks: ServerSessionRegistryHooks): void {
    this.hooks = hooks;
  }

  /**
   * D514 — materialize and prove a switch candidate without transferring any
   * active authority. This method never probes or fetches; main supplies the
   * already-observed navigation receipt.
   */
  async prepareSwitch(
    input: PrepareServerSwitchInput,
  ): Promise<PrepareServerSwitchResult> {
    if (
      !isConnectionAttemptId(input.attemptId) ||
      !Number.isSafeInteger(input.generation) ||
      input.generation <= 0 ||
      !isServerFingerprint(input.candidateServerFingerprint)
    ) {
      return { ok: false, reason: "invalid-attempt" };
    }
    let canonicalOrigin: string;
    try {
      canonicalOrigin = canonicalServerScope(input.canonicalOrigin);
      const parsed = new URL(canonicalOrigin);
      if (canonicalOrigin !== parsed.origin || input.canonicalOrigin !== canonicalOrigin) {
        return { ok: false, reason: "invalid-origin" };
      }
    } catch {
      return { ok: false, reason: "invalid-origin" };
    }
    const routingServerUrl = input.routingServerUrl;
    const identityTransition = input.identityTransition;
    if (!validRoutingServerUrl(routingServerUrl, canonicalOrigin) ||
        !identityTransition || !validIdentityTransition(identityTransition, canonicalOrigin, input.priorAuthorityGuard)) {
      return { ok: false, reason: "invalid-origin" };
    }
    if (identityTransition.kind === "accepted-identity-replacement" &&
        identityTransition.priorConnectionAttemptId === input.attemptId) {
      return { ok: false, reason: "invalid-origin" };
    }
    if (this.privilegeHandoffPendingScope !== null) {
      return { ok: false, reason: "committed-handoff-pending" };
    }
    if (input.priorRegistryScope !== this.activeScope) {
      return { ok: false, reason: "stale-prior" };
    }
    const priorSession = this.active;
    const priorCanonicalOrigin = priorSession === null
      ? null
      : new URL(priorSession.serverUrl).origin;
    if (
      !validObservedActiveAuthority(input.priorAuthorityGuard) ||
      input.priorAuthorityGuard.scope !== priorCanonicalOrigin
    ) {
      return { ok: false, reason: "stale-prior" };
    }
    const targetRegistryScope = serverUrlScope(canonicalOrigin);
    const replacesActiveView = input.forceDetachedReplacement === true;
    const acceptedReplacement = identityTransition.kind === "accepted-identity-replacement";
    if (acceptedReplacement !== replacesActiveView ||
        acceptedReplacement !== (input.acceptedIdentityReplacementReceipt !== undefined)) {
      return { ok: false, reason: "invalid-receipt" };
    }
    // An accepted identity can replace the server behind the same canonical
    // URL.  That is the one same-scope case which must still create a fresh,
    // detached B: the receipt binds it to this exact Human acceptance while
    // `active` proves the mapped A session still owns the current scope.
    const sameScopeReplacement = replacesActiveView &&
      targetRegistryScope === this.activeScope;
    const activeTargetSession = sameScopeReplacement
      ? this.sessions.get(targetRegistryScope) ?? null
      : null;
    if (
      replacesActiveView
        ? (
            !validNavigationReceipt(
              input.acceptedIdentityReplacementReceipt,
              input.attemptId,
              input.generation,
              canonicalOrigin,
            ) ||
            (sameScopeReplacement && (activeTargetSession === null || this.active !== activeTargetSession))
          )
        : input.acceptedIdentityReplacementReceipt !== undefined
    ) {
      return { ok: false, reason: "invalid-receipt" };
    }

    let inFlight = this.preparedSwitch;
    if (inFlight?.status === "complete") {
      this.preparedSwitch = null;
      inFlight = null;
    }
    if (
      inFlight &&
      (
        inFlight.status === "committing" ||
        inFlight.status === "commit-outcome-unknown" ||
        inFlight.status === "awaiting-revalidation" ||
        inFlight.status === "committed-handoff" ||
        inFlight.status === "committed-paused" ||
        inFlight.status === "handing-off"
      )
    ) {
      return { ok: false, reason: "committed-handoff-pending" };
    }
    if (inFlight) this.invalidatePreparedSwitch(inFlight);

    let session = this.sessions.get(targetRegistryScope);
    const targetSessionWasCreated = session === undefined;
    if (!session) {
      session = {
        scope: targetRegistryScope,
        serverUrl: canonicalOrigin,
        partition: `${PARTITION_PREFIX}${targetRegistryScope}`,
        view: null,
        logtoConfig: null,
        signedIn: false,
        relayActive: false,
        profile: null,
        connection: "connecting",
      };
      this.sessions.set(targetRegistryScope, session);
    }

    const targetSession: ServerSession = replacesActiveView
      ? {
          scope: targetRegistryScope,
          serverUrl: routingServerUrl,
          partition: candidatePartition(targetRegistryScope, input.attemptId, input.generation),
          view: null,
          logtoConfig: null,
          signedIn: false,
          relayActive: false,
          profile: null,
          connection: "connecting",
        }
      : session;

    const priorView = replacesActiveView ? session.view : null;
    const newlyCreatedView = targetSession.view === null;
    let candidateView: WebContentsView | null = null;
    if (newlyCreatedView) {
      if (
        !this.hooks.createCandidateView ||
        !this.hooks.attachCandidateView ||
        !this.hooks.bindCandidateSender ||
        !this.hooks.destroyCandidateView ||
        (replacesActiveView && !this.hooks.destroyView)
      ) {
        if (targetSessionWasCreated) this.sessions.delete(targetRegistryScope);
        return { ok: false, reason: "view-unavailable" };
      }
      try {
        candidateView = this.hooks.createCandidateView(targetSession);
        targetSession.view = candidateView;
      } catch {
        if (targetSessionWasCreated) this.sessions.delete(targetRegistryScope);
        return { ok: false, reason: "view-unavailable" };
      }
    }
    const view = newlyCreatedView ? candidateView : targetSession.view;
    if (!view) {
      if (targetSessionWasCreated) this.sessions.delete(targetRegistryScope);
      return { ok: false, reason: "view-unavailable" };
    }

    const handle: MutablePreparedServerSwitchHandle = {
      attemptId: input.attemptId,
      generation: input.generation,
      canonicalOrigin,
      targetRegistryScope,
      priorRegistryScope: input.priorRegistryScope,
      priorAuthorityGuard: input.priorAuthorityGuard,
      session: targetSession,
      view,
      priorSession,
      replacementPriorSession: replacesActiveView ? session : null,
      priorView,
      replacesActiveView,
      priorViewRetired: false,
      newlyCreatedView,
      navigationReceipt: null,
      expectedServerFingerprint: input.candidateServerFingerprint,
      identityTransition,
      targetSessionWasCreated,
      status: "preparing",
      checkpoint: "metadata",
      nextPostCommitStep: 0,
      requiresRendererRevalidation: false,
    };
    this.preparedSwitch = handle;

    let rawReceipt: unknown;
    try {
      rawReceipt = await input.awaitNavigationReceipt({
        attemptId: connectionAttemptId(input.attemptId),
        generation: input.generation,
        session: targetSession,
        view,
        newlyCreatedView,
        expectedOrigin: canonicalOrigin,
      });
    } catch {
      if (this.preparedSwitch !== handle || handle.status === "invalid") {
        return { ok: false, reason: "superseded" };
      }
      this.invalidatePreparedSwitch(handle);
      return { ok: false, reason: "navigation-failed" };
    }
    if (this.preparedSwitch !== handle || handle.status === "invalid") {
      return { ok: false, reason: "superseded" };
    }
    if (!validNavigationReceipt(rawReceipt, input.attemptId, input.generation, canonicalOrigin)) {
      this.invalidatePreparedSwitch(handle);
      return {
        ok: false,
        reason:
          rawReceipt && typeof rawReceipt === "object" &&
            "origin" in rawReceipt && rawReceipt.origin !== canonicalOrigin
            ? "cross-origin"
            : "invalid-receipt",
      };
    }
    const receipt = rawReceipt;
    handle.navigationReceipt = receipt;
    handle.status = "prepared";
    return { ok: true, handle, navigationReceipt: receipt };
  }

  /** Cancel only a still-precommit candidate; durable handoffs recover forward. */
  cancelPreparedSwitch(attemptId: string, generation: number): boolean {
    const handle = this.preparedSwitch;
    if (!handle || handle.attemptId !== attemptId || handle.generation !== generation) return false;
    if (handle.status !== "preparing" && handle.status !== "prepared") return false;
    this.invalidatePreparedSwitch(handle);
    return true;
  }

  /** Install committed recovery authority and fence IPC before any network work. */
  beginCommittedHandoffRecovery(
    input: ResumeCommittedServerSwitchInput,
  ): ResumeCommittedServerSwitchResult {
    let canonicalOrigin: string;
    try {
      canonicalOrigin = canonicalServerScope(input.canonicalOrigin);
      if (
        canonicalOrigin !== input.canonicalOrigin ||
        canonicalOrigin !== new URL(canonicalOrigin).origin ||
        !validRoutingServerUrl(input.routingServerUrl, canonicalOrigin) ||
        !validRecoveryIdentityTransition(input.identityTransition, canonicalOrigin, input.priorRecoveryGuard, input.currentActiveAuthority) ||
        !isConnectionAttemptId(input.attemptId) ||
        !Number.isSafeInteger(input.generation) ||
        input.generation <= 0 ||
        serverUrlScope(input.routingServerUrl) !== input.targetRegistryScope ||
        !validRegistryScopeOrNull(input.priorRegistryScope) ||
        postCommitCheckpointIndex(input.nextCheckpoint) < 0 ||
        input.requiresEphemeralFactReconstructionAndRevalidation !== true ||
        !validRecoveryPriorAuthorityGuard(input.priorRecoveryGuard) ||
        (
          input.priorRegistryScope !== null &&
          (
            input.priorRecoveryGuard.scope === null ||
            serverUrlScope(input.priorRecoveryGuard.scope) !== input.priorRegistryScope
          )
        ) ||
        !validObservedActiveAuthority(input.currentActiveAuthority) ||
        input.currentActiveAuthority.scope !== canonicalOrigin ||
        input.currentActiveAuthority.connectionAttemptId !== input.attemptId ||
        !isServerFingerprint(input.currentActiveAuthority.serverFingerprint)
      ) {
        return { ok: false, reason: "invalid-record" };
      }
    } catch {
      return { ok: false, reason: "invalid-record" };
    }
    if (this.preparedSwitch !== null) {
      return { ok: false, reason: "handoff-pending" };
    }
    if (this.activeScope !== input.targetRegistryScope) {
      return { ok: false, reason: "target-not-active" };
    }
    // Config already says B is durable truth. Fence its bootstrap renderer
    // before every fallible process-local recovery step and retain the fence
    // if candidate construction must be retried.
    this.privilegeHandoffPendingScope = input.targetRegistryScope;
    const bootstrapSession = this.sessions.get(input.targetRegistryScope);
    if (
      !bootstrapSession ||
      bootstrapSession.serverUrl !== input.routingServerUrl ||
      !bootstrapSession.view
    ) {
      return { ok: false, reason: bootstrapSession?.view ? "target-not-active" : "view-unavailable" };
    }
    if (
      !this.hooks.createCandidateView ||
      !this.hooks.attachCandidateView ||
      !this.hooks.bindCandidateSender ||
      !this.hooks.destroyCandidateView ||
      !this.hooks.destroyView
    ) {
      return { ok: false, reason: "view-unavailable" };
    }
    const candidateSession: ServerSession = {
      scope: input.targetRegistryScope,
      serverUrl: input.routingServerUrl,
      partition: candidatePartition(
        input.targetRegistryScope,
        input.attemptId,
        input.generation,
      ),
      view: null,
      logtoConfig: null,
      signedIn: false,
      relayActive: false,
      profile: null,
      connection: "connecting",
    };
    let candidateView: WebContentsView;
    try {
      candidateView = this.hooks.createCandidateView(candidateSession);
      candidateSession.view = candidateView;
    } catch {
      return { ok: false, reason: "view-unavailable" };
    }
    const persistedNextStep = postCommitCheckpointIndex(input.nextCheckpoint);
    const rendererStep = postCommitCheckpointIndex("renderer-authority");
    const handle: MutablePreparedServerSwitchHandle = {
      attemptId: input.attemptId,
      generation: input.generation,
      canonicalOrigin,
      targetRegistryScope: input.targetRegistryScope,
      priorRegistryScope: input.priorRegistryScope,
      priorAuthorityGuard: null,
      session: candidateSession,
      view: candidateView,
      priorSession: input.priorRegistryScope === null
        ? null
        : this.sessions.get(input.priorRegistryScope) ?? null,
      replacementPriorSession: bootstrapSession,
      priorView: bootstrapSession.view,
      replacesActiveView: true,
      priorViewRetired: false,
      newlyCreatedView: true,
      navigationReceipt: null,
      expectedServerFingerprint: input.currentActiveAuthority.serverFingerprint,
      identityTransition: input.identityTransition,
      targetSessionWasCreated: false,
      status: "awaiting-revalidation",
      checkpoint: input.nextCheckpoint,
      nextPostCommitStep: persistedNextStep,
      requiresRendererRevalidation: persistedNextStep > rendererStep,
    };
    this.preparedSwitch = handle;
    this.privilegeHandoffPendingScope = input.targetRegistryScope;
    return { ok: true, handle };
  }

  /** Attach freshly reconstructed ephemeral proof to an already-fenced recovery. */
  completeCommittedHandoffRevalidation(
    publicHandle: PreparedServerSwitchHandle,
    proof: CommittedHandoffRevalidationProof,
  ): CompleteCommittedHandoffRevalidationResult {
    const handle = this.preparedSwitch;
    if (
      !handle ||
      handle !== publicHandle ||
      handle.status !== "awaiting-revalidation"
    ) return { ok: false, reason: "stale-handle" };
    if (!validNavigationReceipt(
      proof.navigationReceipt,
      handle.attemptId,
      handle.generation,
      handle.canonicalOrigin,
    ) || proof.serverFingerprint !== handle.expectedServerFingerprint ||
      !isServerFingerprint(proof.serverFingerprint)) {
      return { ok: false, reason: "invalid-receipt" };
    }
    handle.navigationReceipt = proof.navigationReceipt;
    handle.status = "committed-handoff";
    return { ok: true, handle };
  }

  /**
   * Resolve an indeterminate atomic-write outcome from a fresh authoritative
   * config read. No URL-derived or in-memory guess may cross this boundary.
   */
  resolveUnknownCommitOutcome(
    publicHandle: PreparedServerSwitchHandle,
    authority: ObservedActiveAuthority,
  ): ResolveUnknownCommitOutcomeResult {
    const handle = this.preparedSwitch;
    if (
      !handle ||
      handle !== publicHandle ||
      handle.status !== "commit-outcome-unknown"
    ) {
      return { outcome: "stale-handle" };
    }
    if (!validObservedActiveAuthority(authority)) {
      return { outcome: "unresolved" };
    }

    if (
      authority.scope === handle.canonicalOrigin &&
      authority.connectionAttemptId === handle.attemptId &&
      authority.serverFingerprint === handle.expectedServerFingerprint &&
      isServerFingerprint(authority.serverFingerprint)
    ) {
      this.activeScope = handle.targetRegistryScope;
      this.privilegeHandoffPendingScope = handle.targetRegistryScope;
      handle.status = "committed-handoff";
      handle.checkpoint = "metadata";
      handle.nextPostCommitStep = postCommitCheckpointIndex("metadata");
      return { outcome: "committed-handoff", handle };
    }

    const prior = handle.priorAuthorityGuard;
    if (
      prior !== null &&
      authority.scope === prior.scope &&
      authority.revision === prior.revision &&
      authority.connectionAttemptId === prior.connectionAttemptId &&
      authority.serverFingerprint === prior.serverFingerprint
    ) {
      handle.status = "prepared";
      this.invalidatePreparedSwitch(handle);
      return { outcome: "not-committed" };
    }
    return { outcome: "unresolved" };
  }

  /**
   * D514 — commit authority once, then resume an ordered, idempotent handoff.
   * A post-commit failure is not a failed switch: the returned handle is the
   * only legal recovery path and skips both the commit and completed steps.
   */
  async promotePrepared(
    publicHandle: PreparedServerSwitchHandle,
    hooks: PromotePreparedServerSwitchHooks,
  ): Promise<PromotePreparedServerSwitchResult> {
    const handle = this.preparedSwitch;
    if (!handle || handle !== publicHandle || handle.status === "invalid") {
      return { ok: false, reason: "stale-handle" };
    }
    if (handle.status === "preparing") {
      return { ok: false, reason: "stale-handle" };
    }
    if (
      handle.status === "committing" ||
      handle.status === "commit-outcome-unknown" ||
      handle.status === "awaiting-revalidation" ||
      handle.status === "handing-off"
    ) {
      return { ok: false, reason: "stale-handle" };
    }
    if (handle.status === "complete") {
      return { ok: true, receipt: promotedSwitchReceipt(handle) };
    }

    const oldSession = handle.priorSession;

    if (handle.status === "prepared") {
      // Recheck the optimistic guard immediately before the durable write.
      if (this.activeScope !== handle.priorRegistryScope) {
        this.invalidatePreparedSwitch(handle);
        return { ok: false, reason: "stale-handle" };
      }
      handle.status = "committing";
      let commitResult:
        | { committed: false }
        | { committed: true; followupFailure?: "metadata" };
      try {
        const rawCommitResult = await hooks.commitActiveAuthority({
          canonicalOrigin: handle.canonicalOrigin,
          targetRegistryScope: handle.targetRegistryScope,
          priorRegistryScope: handle.priorRegistryScope,
          attemptId: handle.attemptId,
          generation: handle.generation,
          serverFingerprint: handle.expectedServerFingerprint,
        });
        if (
          !rawCommitResult ||
          typeof rawCommitResult !== "object" ||
          typeof rawCommitResult.committed !== "boolean" ||
          (
            rawCommitResult.committed &&
            rawCommitResult.followupFailure !== undefined &&
            rawCommitResult.followupFailure !== "metadata"
          )
        ) {
          throw new Error("invalid commit result");
        }
        commitResult = rawCommitResult;
      } catch {
        // Never guess across the durable linearization boundary. Until main
        // rereads active authority, neither A nor B may issue privileged IPC.
        handle.status = "commit-outcome-unknown";
        return {
          ok: false,
          reason: "commit-outcome-unknown",
          handle,
        };
      }
      if (!commitResult.committed) {
        handle.status = "prepared";
        this.invalidatePreparedSwitch(handle);
        return { ok: false, reason: "commit-failed" };
      }
      // The durable config is now truth. Never roll this back because a later
      // UI/relay/profile checkpoint failed.
      this.activeScope = handle.targetRegistryScope;
      this.privilegeHandoffPendingScope = handle.targetRegistryScope;
      handle.status = "committed-handoff";
      if (commitResult.followupFailure) {
        handle.nextPostCommitStep = postCommitCheckpointIndex("metadata");
        handle.checkpoint = commitResult.followupFailure;
        return {
          ok: false,
          reason: "postcommit-failed",
          handle,
          checkpoint: commitResult.followupFailure,
        };
      }
    }

    const steps: Array<{
      checkpoint: PreparedServerSwitchCheckpoint;
      run: () => Promise<void>;
    }> = [
      {
        checkpoint: "metadata",
        run: async () => { await hooks.persistMetadata(handle.session); },
      },
      {
        checkpoint: "old-codex",
        run: async () => {
          if (oldSession && (oldSession !== handle.session || handle.replacesActiveView)) {
            await hooks.stopOldCodex(oldSession);
          }
        },
      },
      {
        checkpoint: "old-relay",
        run: async () => {
          if (oldSession && (oldSession !== handle.session || handle.replacesActiveView)) {
            await hooks.stopOldRelay(oldSession);
            oldSession.relayActive = false;
          }
        },
      },
      {
        checkpoint: "old-profile",
        run: async () => {
          if (oldSession && (oldSession !== handle.session || handle.replacesActiveView)) {
            await hooks.deactivateOldProfile(oldSession);
          }
        },
      },
      {
        checkpoint: "old-identity",
        run: async () => {
          const transition = handle.identityTransition;
          if (transition.kind !== "accepted-identity-replacement") return;
          if (!hooks.retireOldIdentity) throw new Error("old identity retirement unavailable");
          await hooks.retireOldIdentity({ priorRoutingServerUrl: transition.priorRoutingServerUrl,
            targetRegistryScope: handle.targetRegistryScope });
        },
      },
      {
        checkpoint: "renderer-authority",
        run: () => {
          const oldAuthorityView = handle.replacesActiveView
            ? handle.priorView
            : oldSession?.view ?? null;
          if (oldAuthorityView && oldAuthorityView !== handle.view) {
            this.hooks.setRendererActive?.(oldAuthorityView, false);
          }
          if (handle.replacesActiveView) {
            handle.session.view = handle.view;
            this.sessions.set(handle.targetRegistryScope, handle.session);
          }
          if (handle.newlyCreatedView) {
            this.hooks.bindCandidateSender?.(
              handle.replacementPriorSession ?? oldSession,
              handle.session,
              handle.view,
            );
          }
          this.hooks.setRendererActive?.(handle.view, true);
          this.privilegeHandoffPendingScope = null;
          return Promise.resolve();
        },
      },
      {
        checkpoint: "visibility",
        run: () => {
          if (handle.newlyCreatedView) {
            this.hooks.attachCandidateView?.(handle.session, handle.view);
          }
          if (handle.replacesActiveView) handle.session.view = handle.view;
          this.hooks.showView?.(handle.view);
          const oldAuthorityView = handle.replacesActiveView
            ? handle.priorView
            : oldSession?.view ?? null;
          if (oldAuthorityView && oldAuthorityView !== handle.view) {
            this.hooks.hideView?.(oldAuthorityView);
            if (handle.replacesActiveView && !handle.priorViewRetired) {
              this.hooks.destroyView?.(oldAuthorityView);
              handle.priorViewRetired = true;
            }
          }
          return Promise.resolve();
        },
      },
      {
        checkpoint: "target-relay",
        run: async () => {
          if (hooks.shouldStartTargetRelay) {
            await hooks.startTargetRelay?.(handle.session);
            handle.session.relayActive = true;
          } else {
            handle.session.relayActive = false;
          }
        },
      },
      { checkpoint: "pending-clear", run: () => hooks.clearPending() },
    ];

    handle.status = "handing-off";
    const rendererStepIndex = postCommitCheckpointIndex("renderer-authority");
    if (
      hooks.pauseBeforeRendererAuthority === true &&
      handle.requiresRendererRevalidation
    ) {
      handle.status = "committed-paused";
      handle.checkpoint = "renderer-authority";
      return { ok: true, paused: true, handle, checkpoint: "renderer-authority" };
    }
    if (handle.requiresRendererRevalidation) {
      try {
        const oldAuthorityView = handle.replacesActiveView
          ? handle.priorView
          : oldSession?.view ?? null;
        if (oldAuthorityView && oldAuthorityView !== handle.view) {
          this.hooks.setRendererActive?.(oldAuthorityView, false);
        }
        if (handle.replacesActiveView) {
          handle.session.view = handle.view;
          this.sessions.set(handle.targetRegistryScope, handle.session);
        }
        if (handle.newlyCreatedView) {
          this.hooks.bindCandidateSender?.(
            handle.replacementPriorSession ?? oldSession,
            handle.session,
            handle.view,
          );
        }
        this.hooks.setRendererActive?.(handle.view, true);
        this.privilegeHandoffPendingScope = null;
        // A fresh process has only the bootstrap presentation view even when
        // the durable journal has advanced beyond visibility. Reconstruct the
        // process-local cutover before resuming the durable checkpoint.
        if (handle.newlyCreatedView) {
          this.hooks.attachCandidateView?.(handle.session, handle.view);
        }
        this.hooks.showView?.(handle.view);
        if (oldAuthorityView && oldAuthorityView !== handle.view) {
          this.hooks.hideView?.(oldAuthorityView);
          if (handle.replacesActiveView && !handle.priorViewRetired) {
            this.hooks.destroyView?.(oldAuthorityView);
            handle.priorViewRetired = true;
          }
        }
        handle.requiresRendererRevalidation = false;
      } catch {
        handle.status = "committed-handoff";
        return {
          ok: false,
          reason: "postcommit-failed",
          handle,
          checkpoint: "renderer-authority",
        };
      }
    }
    while (handle.nextPostCommitStep < steps.length) {
      const step = steps[handle.nextPostCommitStep]!;
      handle.checkpoint = step.checkpoint;
      if (
        hooks.pauseBeforeRendererAuthority === true &&
        handle.nextPostCommitStep === rendererStepIndex
      ) {
        handle.status = "committed-paused";
        return { ok: true, paused: true, handle, checkpoint: "renderer-authority" };
      }
      try {
        await step.run();
      } catch {
        handle.status = "committed-handoff";
        return {
          ok: false,
          reason: "postcommit-failed",
          handle,
          checkpoint: step.checkpoint,
        };
      }
      if (step.checkpoint !== "pending-clear") {
        const nextIndex = handle.nextPostCommitStep + 1;
        const next = steps[nextIndex];
        if (!next || next.checkpoint === "complete") {
          throw new Error("invalid postcommit checkpoint sequence");
        }
        try {
          await hooks.persistNextCheckpoint(
            next.checkpoint as IncompletePreparedServerSwitchCheckpoint,
          );
        } catch {
          handle.status = "committed-handoff";
          return {
            ok: false,
            reason: "postcommit-failed",
            handle,
            checkpoint: next.checkpoint,
          };
        }
        handle.nextPostCommitStep = nextIndex;
        handle.checkpoint = next.checkpoint;
        continue;
      }
      handle.nextPostCommitStep += 1;
    }
    handle.checkpoint = "complete";
    handle.status = "complete";
    this.scheduleNotificationExpiry();
    this.notifyChange();
    return { ok: true, receipt: promotedSwitchReceipt(handle) };
  }

  private invalidatePreparedSwitch(handle: MutablePreparedServerSwitchHandle): void {
    if (handle.status === "invalid") return;
    // Durable truth can only be recovered forward, never superseded/cleaned.
    if (
      handle.status === "committing" ||
      handle.status === "commit-outcome-unknown" ||
      handle.status === "awaiting-revalidation" ||
      handle.status === "committed-handoff" ||
      handle.status === "committed-paused" ||
      handle.status === "handing-off" ||
      handle.status === "complete"
    ) return;
    handle.status = "invalid";
    if (this.preparedSwitch === handle) this.preparedSwitch = null;
    if (handle.newlyCreatedView) {
      try {
        this.hooks.destroyCandidateView?.(handle.view);
      } catch {
        /* candidate cleanup is best-effort; it never affects active A */
      }
      if (handle.session.view === handle.view) handle.session.view = null;
    }
    if (
      handle.targetSessionWasCreated &&
      this.sessions.get(handle.targetRegistryScope) === handle.session
    ) {
      this.sessions.delete(handle.targetRegistryScope);
    }
  }

  /**
   * Re-deliver the current active state to every attached renderer. Main calls
   * this after an initial sender attachment; the preload subscription also
   * obtains the same state synchronously from main to cover a renderer that
   * loads after its first lifecycle event.
   */
  syncRendererActiveStates(): void {
    if (this.hasCommittedHandoffPending()) return;
    for (const session of this.sessions.values()) {
      if (session.view) {
        this.hooks.setRendererActive?.(session.view, session === this.active);
      }
    }
  }

  /**
   * M161 Phase 3 — subscribe to switch/add/close/profile/connection
   * changes. Returns an unsubscribe fn; safe to call after the
   * subscriber's renderer is gone (the fn is a no-op once the
   * listener set has dropped it). Listeners are plain fns so main can
   * bridge to `webContents.send("servers:changed")` with a destroyed
   * sender check inside the callback.
   */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /**
   * M161 Phase 3 — fire every `onChange` listener. Called internally
   * after switch/add/close and by `updateSession` for external
   * profile/connection mutations. Listener throws are swallowed so one
   * dead subscriber never blocks the rest.
   */
  notifyChange(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch {
        /* a dead subscriber must not silence the others */
      }
    }
  }

  private notificationCandidateGroups(): EnrichedAliasCandidate[][] {
    const recents = this.hooks.listRecents?.() ?? [];
    const byUrl = new Map<
      string,
      { live?: ServerSession; recent?: RecentServerEntry }
    >();
    for (const session of this.sessions.values()) {
      byUrl.set(session.serverUrl, { live: session });
    }
    for (const recent of recents) {
      let canonical: string;
      try {
        canonical = canonicalServerScope(recent.url);
      } catch {
        continue;
      }
      const existing = byUrl.get(canonical);
      if (existing) existing.recent = recent;
      else byUrl.set(canonical, { recent });
    }
    return collapseAliasCandidates(
      [...byUrl.values()].map((candidate) => ({
        live: candidate.live,
        recent: candidate.recent,
        url:
          candidate.live?.serverUrl ??
          canonicalServerScope(candidate.recent!.url),
        fingerprint: candidate.recent?.fingerprint,
        loopbackKey: loopbackAliasKey(
          candidate.live?.serverUrl ?? candidate.recent!.url,
        ),
      })),
    );
  }

  private notificationStateForGroup(
    group: readonly EnrichedAliasCandidate[],
    nowMs: number,
  ): PublicNotificationSummary {
    const candidates = group
      .map((candidate) => candidate.live)
      .filter((session): session is ServerSession => session !== undefined)
      .map((session) => ({
        session,
        summary: this.notificationSummaries.get(session.scope) ?? null,
      }))
      .filter(
        (
          candidate,
        ): candidate is {
          session: ServerSession;
          summary: StoredNotificationSummary;
        } => candidate.summary !== null,
      );

    const fresh = candidates
      .filter(
        ({ session, summary }) =>
          session.signedIn &&
          session.connection === "live" &&
          publicSummaryState({
            summary,
            eligible: true,
            nowMs,
          }).state === "fresh",
      )
      .sort((a, b) => b.summary.receivedAtMs - a.summary.receivedAtMs)[0];
    if (fresh) {
      return publicSummaryState({
        summary: fresh.summary,
        eligible: true,
        nowMs,
      });
    }

    const lastKnown = candidates.sort(
      (a, b) => b.summary.receivedAtMs - a.summary.receivedAtMs,
    )[0];
    return publicSummaryState({
      summary: lastKnown?.summary ?? null,
      eligible: false,
      nowMs,
    });
  }

  getNotificationAggregate(
    nowMs = this.notificationNowMs(),
  ): NotificationAggregate {
    return aggregatePublicSummaries(
      this.notificationCandidateGroups().map((group) =>
        this.notificationStateForGroup(group, nowMs)
      ),
    );
  }

  private scheduleNotificationExpiry(): void {
    if (this.notificationExpiryTimer !== null) {
      clearTimeout(this.notificationExpiryTimer);
      this.notificationExpiryTimer = null;
    }
    const nowMs = this.notificationNowMs();
    let nextDelayMs = Number.POSITIVE_INFINITY;
    for (const [scope, summary] of this.notificationSummaries) {
      const session = this.sessions.get(scope);
      if (
        !session ||
        !session.signedIn ||
        session.connection !== "live"
      ) {
        continue;
      }
      const delayMs =
        summary.receivedAtMs + NOTIFICATION_SUMMARY_FRESH_MS - nowMs;
      if (delayMs > 0) nextDelayMs = Math.min(nextDelayMs, delayMs);
    }
    if (!Number.isFinite(nextDelayMs)) return;
    this.notificationExpiryTimer = setTimeout(() => {
      this.notificationExpiryTimer = null;
      this.notifyChange();
      this.scheduleNotificationExpiry();
    }, Math.max(1, Math.ceil(nextDelayMs)));
    this.notificationExpiryTimer.unref?.();
  }

  /**
   * M161 Phase 3 — real in-process switch. Selects the target session's
   * view (creating it lazily through `hooks.createView`), preserves the
   * previous view alive + hidden, navigates the freshly-created target
   * renderer to `${serverUrl}/` without relaunch, resolves the target
   * Logto config, restores/silently refreshes target tokens (re-auth
   * only when absent/expired/unrefreshable — never clearing valid
   * tokens on an ordinary switch), then runs the stop-before-start
   * relay handoff. `onChanged` fires once the active scope flips.
   *
   * Returns a typed success/failure result. Without hooks, degrades to
   * the Phase 1 active-scope flip so the no-arg constructor stays valid.
   */
  async switchTo(serverUrl: string): Promise<ServerSwitchResult> {
    if (this.hasCommittedHandoffPending()) {
      return { ok: false, reason: "handoff-pending" };
    }
    let canonicalUrl = canonicalServerScope(serverUrl);
    let scope = serverUrlScope(canonicalUrl);
    const previous = this.active;
    let target = this.sessions.get(scope);
    const recents = this.hooks.listRecents?.() ?? [];
    // M161 Phase 6.6 (Stack 198) — the recent lookup uses the loopback
    // identity group so a loopback alias represented only by a live
    // session still resolves the trusted fingerprint stored on its
    // matching loopback recent entry. Non-loopback URLs and cross-port/
    // protocol aliases never match through the fallback.
    const recent = this.findRecentForCanonicalUrl(canonicalUrl, recents);
    // A session may be materialized lazily only from the persisted
    // recent-server allowlist. Arbitrary renderer-supplied URLs remain
    // unknown and cannot trigger a network probe or view creation.
    if (!target && !recent) {
      return { ok: false, reason: "unknown-server" };
    }

    // M161 Phase 3.2 — fail-closed fingerprint enforcement. Probe and
    // compare BEFORE ensuring/creating/showing/activating the target. On a
    // mismatch or offline probe the current session remains untouched.
    if (this.hooks.probeFingerprint) {
      const probe = await this.hooks.probeFingerprint(canonicalUrl);
      if (!probe.ok) return probe;
      const expected = recent?.fingerprint;
      if (expected && expected !== probe.fingerprint) {
        return {
          ok: false,
          reason: "wrong-server",
          expectedFingerprint: expected,
          foundFingerprint: probe.fingerprint,
        };
      }
      if (!expected) {
        // First connect: trust the successfully probed target once and
        // persist its identity before activating the view.
        const stored = this.hooks.storeFingerprint?.(
          canonicalUrl,
          probe.fingerprint,
        );
        if (stored === false) {
          return { ok: false, reason: "fingerprint-storage-failed" };
        }
      }

      // M161 Phase 6.4 — prevent duplicate alias sessions after
      // preflight. If the probed fingerprint matches an existing live
      // session's trusted fingerprint, reuse that session's scope
      // instead of creating a duplicate alias session (which would spin
      // up a second `persist:server-<scope>` partition for the same
      // trusted server). Falls back to post-connection collapse in
      // `listEnriched()` when no trusted match exists (e.g. first
      // connect, or fingerprint not yet trusted on any recent). This
      // does NOT alter legacy persisted token/partition forms — the
      // reused session keeps its existing scope/partition/filenames.
      // The deeper on-disk canonical migration remains TRACKED to
      // D133 (out of scope here).
      if (this.hooks.listRecents) {
        const reuse = this.findSessionByTrustedFingerprint(probe.fingerprint);
        if (reuse && reuse.scope !== scope) {
          canonicalUrl = reuse.serverUrl;
          scope = reuse.scope;
          target = reuse;
        }
      }
    }

    // The URL is either already live or was verified against recents and
    // fingerprint-preflighted. Only now may a recent-only target become
    // a registry session.
    target ??= this.ensure(canonicalUrl);

    // Lazy view creation FIRST so a createView failure (e.g. sender-bind
    // rejection) leaves the active scope unchanged — the user keeps
    // looking at the previous server rather than a viewless active.
    const existingView = target.view;
    if (!target.view && this.hooks.createView) {
      target.view = this.hooks.createView(target);
    }
    const view = target.view;
    this.activeScope = scope;
    // Security ordering: the old renderer is explicitly deactivated before
    // the target receives authority. Never leave two live renderers active.
    if (previous && previous !== target && previous.view) {
      this.hooks.setRendererActive?.(previous.view, false);
    }
    if (view) this.hooks.setRendererActive?.(view, true);

    // Fresh views load `${serverUrl}/`. Existing views are never
    // reloaded; they receive the narrow Home-routing event instead.
    if (view && !existingView && this.hooks.navigateView) {
      this.hooks.navigateView(view, `${target.serverUrl}/`);
    } else if (view && existingView) {
      // Locked behavior: an explicit switch always lands on Home, but an
      // already-live background view must retain its renderer/session.
      this.hooks.navigateHome?.(view);
    }

    // Visibility handoff: show target, hide previous (kept alive).
    if (view && this.hooks.showView) this.hooks.showView(view);
    if (previous && previous !== target && previous.view && this.hooks.hideView) {
      this.hooks.hideView(previous.view);
    }

    // Resolve Logto config for the target if not yet known.
    if (!target.logtoConfig && this.hooks.resolveLogtoConfig) {
      try {
        await this.hooks.resolveLogtoConfig(target.serverUrl);
      } catch {
        /* leave config unresolved; renderer re-probes via auth:reprobe-server */
      }
    }

    // Token restore / silent refresh. Re-auth ONLY when credentials are
    // absent or unrefreshable — never clear valid tokens on switch.
    if (this.hooks.loadTokens) {
      const tokens = this.hooks.loadTokens(target.serverUrl);
      if (tokens) {
        target.signedIn = true;
        if (this.hooks.refreshTokens) {
          try {
            const refreshed = await this.hooks.refreshTokens(target.serverUrl);
            if (refreshed === false) {
              // Main only attempts refresh for an expiring bundle, so
              // false means credentials are unrefreshable and re-auth is
              // required. A non-expiring valid bundle returns true
              // without mutation.
              target.signedIn = false;
            }
          } catch {
            /* silent refresh is best-effort; never clear on failure */
          }
        }
      } else {
        target.signedIn = false;
      }
    }
    if (!target.signedIn) {
      this.notificationSummaries.delete(target.scope);
    }

    // Stop-before-start relay handoff last, so the active view + auth
    // are ready before the relay binds to the new session.
    if (this.hooks.handoffRelay) {
      try {
        await this.hooks.handoffRelay(target);
      } catch (err) {
        // Relay failure does not roll back the view switch — the user
        // is already looking at the target server. Relay will retry on
        // its own auth-state-change path. Swallowed (no logger import:
        // the registry stays pure-ish for unit tests).
        void err;
      }
    }

    this.scheduleNotificationExpiry();
    this.notifyChange();
    return { ok: true };
  }

  /**
   * M161 Phase 3 — ensure + switch. Used by the `servers:add` IPC after
   * the picker commits a new URL. The view is created lazily inside
   * `switchTo` on first activation.
   */
  async add(serverUrl: string): Promise<ServerSwitchResult> {
    if (this.hasCommittedHandoffPending()) {
      return { ok: false, reason: "handoff-pending" };
    }
    this.ensure(serverUrl);
    return this.switchTo(serverUrl);
  }

  /**
   * M161 Phase 3 — destroy the target session's view, drop the session
   * and its sender mappings. If it is active, first perform a complete
   * switch to a remaining session; a failed fallback leaves the current
   * session untouched. Does NOT remove recents or token files.
   */
  async close(serverUrl: string): Promise<ServerSwitchResult> {
    if (this.hasCommittedHandoffPending()) {
      return { ok: false, reason: "handoff-pending" };
    }
    const canonicalUrl = canonicalServerScope(serverUrl);
    const scope = serverUrlScope(canonicalUrl);
    const session = this.sessions.get(scope);
    if (!session) return { ok: false, reason: "unknown-server" };

    // Closing the active session first performs a full switch to a
    // remaining session (fingerprint preflight, view visibility, auth,
    // relay handoff). If that fails, keep the current session untouched.
    if (this.activeScope === scope) {
      const guardedActiveScope = this.activeScope;
      const next = [...this.sessions.values()].find(
        (candidate) => candidate.scope !== scope,
      );
      if (next) {
        let activation: ServerFallbackActivationResult;
        try {
          activation = this.hooks.activateFallback
            ? await this.hooks.activateFallback(next.serverUrl)
            : { kind: "indeterminate" };
        } catch {
          activation = { kind: "indeterminate" };
        }
        if (activation.kind === "indeterminate" ||
            (activation.kind === "activated" && (this.active?.scope !== next.scope ||
              this.hasCommittedHandoffPending() ||
              (this.preparedSwitch !== null && this.preparedSwitch.status !== "complete")))) {
          return { ok: false, reason: "handoff-pending" };
        }
        if (activation.kind === "not-activated") {
          if (this.activeScope !== guardedActiveScope || this.hasCommittedHandoffPending() ||
              (this.preparedSwitch !== null && this.preparedSwitch.status !== "complete")) {
            return { ok: false, reason: "handoff-pending" };
          }
          return activation.result;
        }
      }
    }

    if (session.view && this.hooks.destroyView) {
      this.hooks.setRendererActive?.(session.view, false);
      try {
        this.hooks.destroyView(session.view);
      } catch {
        /* best-effort teardown */
      }
      session.view = null;
    }
    for (const [senderId, s] of this.senderToScope) {
      if (s === scope) this.senderToScope.delete(senderId);
    }
    this.notificationSummaries.delete(scope);
    this.sessions.delete(scope);
    if (this.activeScope === scope) {
      this.activeScope = null;
    }
    this.scheduleNotificationExpiry();
    this.notifyChange();
    return { ok: true };
  }

  /**
   * M161 Phase 6.5 — remove live views for an explicit Forget operation.
   * Recents/tokens/partitions are handled by main after it enumerates aliases;
   * this method owns the stateful view/active-relay transition.
   *
   * A fallback is attempted first for an active target. Its failure does not
   * cancel Forget: the explicit destructive intent wins, so authority is
   * reduced and the shell lands empty instead.
   */
  async forget(
    serverUrl: string,
    aliases: readonly string[],
    fallbackUrl?: string,
  ): Promise<ServerForgetResult> {
    if (this.hasCommittedHandoffPending()) {
      return { ok: false, reason: "handoff-pending" };
    }
    const targets = new Set<string>();
    for (const url of [serverUrl, ...aliases]) {
      try {
        targets.add(canonicalServerScope(url));
      } catch {
        // Input was validated by the IPC before reaching this boundary.
      }
    }
    const matching = [...this.sessions.values()].filter((session) =>
      targets.has(session.serverUrl),
    );
    const activeIsTarget = this.active !== null && targets.has(this.active.serverUrl);
    const guardedActiveScope = this.activeScope;
    let fallbackFailed = false;

    if (activeIsTarget && fallbackUrl) {
      let activation: ServerFallbackActivationResult;
      try {
        activation = this.hooks.activateFallback
          ? await this.hooks.activateFallback(fallbackUrl)
          : { kind: "indeterminate" };
      } catch {
        activation = { kind: "indeterminate" };
      }
      if (activation.kind === "indeterminate") {
        return { ok: false, reason: "handoff-pending" };
      }
      if (activation.kind === "activated") {
        let fallbackScope: string;
        try { fallbackScope = serverUrlScope(canonicalServerScope(fallbackUrl)); } catch {
          return { ok: false, reason: "handoff-pending" };
        }
        if (this.active?.scope !== fallbackScope || this.hasCommittedHandoffPending() ||
            (this.preparedSwitch !== null && this.preparedSwitch.status !== "complete")) {
          return { ok: false, reason: "handoff-pending" };
        }
      } else {
        if (this.activeScope !== guardedActiveScope || this.hasCommittedHandoffPending() ||
            (this.preparedSwitch !== null && this.preparedSwitch.status !== "complete")) {
          return { ok: false, reason: "handoff-pending" };
        }
        fallbackFailed = true;
      }
    }

    if (activeIsTarget && (fallbackFailed || !fallbackUrl)) {
      await this.hooks.teardownForgottenActive?.();
    }

    for (const session of matching) {
      if (session.view && this.hooks.destroyView) {
        this.hooks.setRendererActive?.(session.view, false);
        try {
          this.hooks.destroyView(session.view);
        } catch {
          /* best-effort view teardown */
        }
        session.view = null;
      }
      for (const [senderId, scope] of this.senderToScope) {
        if (scope === session.scope) this.senderToScope.delete(senderId);
      }
      this.notificationSummaries.delete(session.scope);
      this.sessions.delete(session.scope);
    }
    if (activeIsTarget && (fallbackFailed || !fallbackUrl)) this.activeScope = null;
    if (matching.length > 0 || activeIsTarget) {
      this.scheduleNotificationExpiry();
      this.notifyChange();
    }
    return {
      ok: true,
      fallbackFailed,
      landedEmpty: activeIsTarget && (fallbackFailed || !fallbackUrl),
    };
  }

  /**
   * Clears every alias partition through the injected hook. Keeping Electron
   * session access out of this registry makes the destructive sweep testable.
   */
  async clearPersistentPartitionsFor(serverUrls: readonly string[]): Promise<void> {
    if (this.hasCommittedHandoffPending()) {
      throw new Error("server-session-handoff-pending");
    }
    if (!this.hooks.clearPersistentPartition) {
      throw new Error("partition-clear-unavailable");
    }
    const partitions = new Set<string>();
    for (const url of serverUrls) {
      const canonical = canonicalServerScope(url);
      partitions.add(`${PARTITION_PREFIX}${serverUrlScope(canonical)}`);
    }
    for (const partition of partitions) {
      await this.hooks.clearPersistentPartition(partition);
    }
  }

  /**
   * M161 Phase 3 — merge recent + live sessions and enrich each entry
   * from public `/api/setup/status` + icon URL. Live sessions contribute
   * `signedIn` / `connection`; recent-only entries classify as live,
   * offline, or incompatible. Reachable servers missing the alpha/current
   * required profile contract remain visible as incompatible rather than
   * being mislabeled offline. `fingerprint` is copied from recents.
   *
   * M161 Phase 6.4 — collapses duplicate alias rows that point at the
   * same trusted server. Collapse rules:
   *   - Two candidates with matching nonempty trusted fingerprints
   *     collapse to one row (even across different URL strings).
   *   - Two candidates with distinct nonempty fingerprints NEVER collapse.
   *   - When one or both fingerprints are absent, collapse only by the
   *     loopback dedupe key (`localhost` / `127.0.0.1` / `[::1]` with the
   *     same protocol + port); port/protocol variants and distinct
   *     non-loopback hosts remain separate.
   * When merging, the active/live session wins; otherwise the most-recent
   * recent wins. The trusted fingerprint and strongest connection /
   * signed-in state are preserved. `list()` never silently learns or
   * writes fingerprints — it only reads trusted fingerprints already on
   * recent entries.
   *
   * Without hooks, degrades to the basic live `list()` (no recents, no
   * enrichment, no collapse) so the no-arg constructor stays valid.
   */
  async listEnriched(
    nowMs = this.notificationNowMs(),
  ): Promise<EnrichedServerListEntry[]> {
    const allowLiveStateMutation = !this.hasCommittedHandoffPending();
    const active = this.active;
    const activeUrl = active?.serverUrl ?? null;
    const recents = this.hooks.listRecents ? this.hooks.listRecents() : [];

    // Build the candidate set: one per live session, one per recent
    // entry, merged when they share the same canonical URL. Each
    // candidate carries its trusted fingerprint (recents only) and its
    // loopback alias key, if applicable.
    const byUrl = new Map<string, { live?: ServerSession; recent?: RecentServerEntry }>();
    for (const session of this.sessions.values()) {
      byUrl.set(session.serverUrl, { live: session });
    }
    for (const recent of recents) {
      let canonical: string;
      try {
        canonical = canonicalServerScope(recent.url);
      } catch {
        continue;
      }
      const existing = byUrl.get(canonical);
      if (existing) {
        existing.recent = recent;
      } else {
        byUrl.set(canonical, { recent });
      }
    }

    const candidates: EnrichedAliasCandidate[] = [...byUrl.values()].map((c) => ({
      live: c.live,
      recent: c.recent,
      url: c.live?.serverUrl ?? canonicalServerScope(c.recent!.url),
      fingerprint: c.recent?.fingerprint,
      loopbackKey: loopbackAliasKey(c.live?.serverUrl ?? c.recent!.url),
    }));

    const groups = this.orderEnrichedGroups(collapseAliasCandidates(candidates));

    let liveStateChanged = false;
    // Promise.all preserves the candidate-group order established before any
    // network work starts. Do not append entries as probes settle: probe
    // completion order is nondeterministic and must never become panel order.
    const entries = await Promise.all(
      [...groups.values()].map(async (group) => {
        // Merge: active/live session wins; otherwise most-recent recent
        // wins. Preserve trusted fingerprint and strongest connection /
        // signed-in state across the whole group.
        const winner = pickGroupAnchor(group, activeUrl);
        const liveSessions = group
          .map((c) => c.live)
          .filter((s): s is ServerSession => s !== undefined);
        const anySignedIn = liveSessions.some((s) => s.signedIn);
        const trustedFingerprint = group
          .map((c) => c.fingerprint)
          .find((fp): fp is string => typeof fp === "string" && fp.length > 0);

        const url = winner.url;
        let status: ServerSetupStatusSummary | null = null;
        let probedConnection: Exclude<ServerSessionConnection, "connecting"> | null = null;
        if (this.hooks.fetchListSetupStatus) {
          try {
            const probe = await this.hooks.fetchListSetupStatus(url);
            probedConnection = probe.kind;
            if (probe.kind === "live") status = probe.profile;
          } catch {
            probedConnection = "offline";
          }
        }
        const iconUrl = status && this.hooks.iconUrlFor
          ? this.hooks.iconUrlFor(url, status)
          : (probedConnection === "incompatible"
              ? undefined
              : winner.live?.profile?.iconUrl) ??
            this.hooks.iconUrlFor?.(url, null) ??
            "";

        // Repeated list() calls are the explicit Phase 4 refresh seam:
        // every call re-fetches setup status. Update live session state
        // only when profile/connection actually changed, then emit one
        // batched onChanged after all probes complete. This prevents
        // list → changed → list loops on identical responses. Every live
        // session in the collapsed group is refreshed (they all point
        // at the same trusted server), so an alias session's
        // profile/connection stays in sync with the anchor.
        for (const live of allowLiveStateMutation ? liveSessions : []) {
          const nextConnection = probedConnection ?? live.connection;
          const nextProfile: ServerSessionProfile | null =
            probedConnection === "live" && status
              ? {
                ...(status.name ? { name: status.name } : {}),
                ...(status.description ? { description: status.description } : {}),
                iconUrl,
              }
              : probedConnection === "incompatible"
                ? null
                : live.profile;
          if (
            live.connection !== nextConnection ||
            !serverProfilesEqual(live.profile, nextProfile)
          ) {
            live.connection = nextConnection;
            live.profile = nextProfile;
            liveStateChanged = true;
          }
        }

        const anchorLive = winner.live;
        const entry: EnrichedServerListEntry = {
          url,
          iconUrl,
          connection: anchorLive
            ? anchorLive.connection
            : probedConnection ?? "offline",
          active: group.some((c) => c.live?.serverUrl === activeUrl),
          signedIn: anchorLive ? anchorLive.signedIn || anySignedIn : false,
          notificationSummary: this.notificationStateForGroup(group, nowMs),
        };
        if (anchorLive?.profile?.name !== undefined) entry.name = anchorLive.profile.name;
        else if (status?.name) entry.name = status.name;
        if (anchorLive?.profile?.description !== undefined) entry.description = anchorLive.profile.description;
        else if (status?.description) entry.description = status.description;
        if (trustedFingerprint) entry.fingerprint = trustedFingerprint;
        return entry;
      }),
    );
    if (liveStateChanged) {
      this.scheduleNotificationExpiry();
      this.notifyChange();
    }
    return entries;
  }

  /**
   * Establish a deterministic first-list order from durable recency, then
   * preserve it for the lifetime of each visible canonical candidate. This
   * deliberately ignores active state and later recents writes: either can
   * change while the Servers panel is open and must not move a row under the
   * pointer. Newly discovered groups append in the same recency/URL order;
   * ranks for no-longer-visible candidates are discarded.
   */
  private orderEnrichedGroups(
    groups: EnrichedAliasCandidate[][],
  ): EnrichedAliasCandidate[][] {
    const visibleUrls = new Set(groups.flatMap((group) =>
      group.map((candidate) => candidate.url),
    ));
    for (const url of this.enrichedDisplayOrder.keys()) {
      if (!visibleUrls.has(url)) this.enrichedDisplayOrder.delete(url);
    }

    const metadata = groups.map((group) => {
      const urls = [...new Set(group.map((candidate) => candidate.url))];
      const knownRanks = urls
        .map((url) => this.enrichedDisplayOrder.get(url))
        .filter((rank): rank is number => rank !== undefined);
      const recentTimes = group
        .map((candidate) => Date.parse(candidate.recent?.lastUsedAt ?? ""))
        .filter((time) => !Number.isNaN(time));
      return {
        group,
        urls,
        hasRank: knownRanks.length > 0,
        mostRecentMs: recentTimes.length > 0 ? Math.max(...recentTimes) : null,
        canonicalUrl: [...urls].sort()[0]!,
      };
    });
    const byInitialOrder = (a: (typeof metadata)[number], b: (typeof metadata)[number]) => {
      if (a.mostRecentMs !== b.mostRecentMs) {
        if (a.mostRecentMs === null) return 1;
        if (b.mostRecentMs === null) return -1;
        return b.mostRecentMs - a.mostRecentMs;
      }
      if (a.canonicalUrl < b.canonicalUrl) return -1;
      if (a.canonicalUrl > b.canonicalUrl) return 1;
      return 0;
    };
    const newGroups = metadata
      .filter((item) => !item.hasRank)
      .sort(byInitialOrder);
    for (const item of newGroups) {
      for (const url of [...item.urls].sort()) {
        this.enrichedDisplayOrder.set(url, this.nextEnrichedDisplayOrder++);
      }
    }
    // A newly discovered alias can join an existing collapsed row. Give it
    // its own latent rank now, rather than copying the row's rank: if trusted
    // metadata later splits the aliases into separate rows, each row still
    // has a unique frozen rank and recency cannot reshuffle them.
    for (const item of metadata) {
      for (const url of item.urls) {
        if (!this.enrichedDisplayOrder.has(url)) {
          this.enrichedDisplayOrder.set(url, this.nextEnrichedDisplayOrder++);
        }
      }
    }
    return metadata
      .sort((a, b) => {
        const aRank = Math.min(...a.urls.map((url) =>
          this.enrichedDisplayOrder.get(url)!,
        ));
        const bRank = Math.min(...b.urls.map((url) =>
          this.enrichedDisplayOrder.get(url)!,
        ));
        return aRank - bRank;
      })
      .map((item) => item.group);
  }

  async listEnrichedResult(): Promise<EnrichedServerListResult> {
    const nowMs = this.notificationNowMs();
    const servers = await this.listEnriched(nowMs);
    return {
      servers,
      aggregate: aggregatePublicSummaries(
        servers.map((server) => server.notificationSummary),
      ),
    };
  }

  /**
   * M161 Phase 3 — main-side mutator for profile/connection state
   * observed outside a switch (e.g. /health resolved, relay connected,
   * /api/setup/status fetched). Mutates the session and fires
   * `onChange` so `servers:onChanged` subscribers re-fetch the list.
   */
  updateSession(
    serverUrl: string,
    patch: Partial<Pick<ServerSession, "profile" | "connection" | "signedIn" | "logtoConfig">>,
  ): void {
    if (this.hasCommittedHandoffPending()) return;
    const session = this.getByServerUrl(serverUrl);
    if (!session) return;
    let changed = false;
    if (patch.profile !== undefined && !serverProfilesEqual(session.profile, patch.profile)) {
      session.profile = patch.profile;
      changed = true;
    }
    if (patch.connection !== undefined && session.connection !== patch.connection) {
      session.connection = patch.connection;
      changed = true;
    }
    if (patch.signedIn !== undefined && session.signedIn !== patch.signedIn) {
      session.signedIn = patch.signedIn;
      if (!patch.signedIn) this.notificationSummaries.delete(session.scope);
      changed = true;
    }
    if (patch.logtoConfig !== undefined && session.logtoConfig !== patch.logtoConfig) {
      session.logtoConfig = patch.logtoConfig;
      changed = true;
    }
    if (changed) {
      this.scheduleNotificationExpiry();
      this.notifyChange();
    }
  }

  private hasCommittedHandoffPending(): boolean {
    if (this.privilegeHandoffPendingScope !== null) return true;
    const status = this.preparedSwitch?.status;
    return status === "committing" ||
      status === "commit-outcome-unknown" ||
      status === "awaiting-revalidation" ||
      status === "committed-handoff" ||
      status === "committed-paused" ||
      status === "handing-off";
  }
}

function serverProfilesEqual(
  a: ServerSessionProfile | null,
  b: ServerSessionProfile | null,
): boolean {
  return (
    a?.name === b?.name &&
    a?.description === b?.description &&
    a?.iconUrl === b?.iconUrl
  );
}

function promotedSwitchReceipt(handle: PreparedServerSwitchHandle): {
  attemptId: string;
  generation: number;
  canonicalOrigin: string;
  targetRegistryScope: string;
} {
  return {
    attemptId: handle.attemptId,
    generation: handle.generation,
    canonicalOrigin: handle.canonicalOrigin,
    targetRegistryScope: handle.targetRegistryScope,
  };
}

function validNavigationReceipt(
  receipt: unknown,
  attemptId: string,
  generation: number,
  canonicalOrigin: string,
): receipt is ObservationReceipt {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const candidate = receipt as Record<string, unknown>;
  return candidate["attemptId"] === attemptId &&
    candidate["generation"] === generation &&
    candidate["origin"] === canonicalOrigin &&
    typeof candidate["observedAtMs"] === "number" &&
    Number.isFinite(candidate["observedAtMs"]) &&
    candidate["observedAtMs"] >= 0;
}

function validObservedActiveAuthority(
  authority: unknown,
): authority is ObservedActiveAuthority {
  if (!authority || typeof authority !== "object" || Array.isArray(authority)) return false;
  const candidate = authority as Record<string, unknown>;
  const scope = candidate["scope"];
  const revision = candidate["revision"];
  const connectionAttemptIdValue = candidate["connectionAttemptId"];
  const serverFingerprint = candidate["serverFingerprint"];
  if (
    scope === null ||
    revision === null ||
    connectionAttemptIdValue === null
  ) {
    return scope === null && revision === null &&
      connectionAttemptIdValue === null && serverFingerprint === null;
  }
  if (
    typeof scope !== "string" ||
    !isOpaqueActiveRevision(revision) ||
    !isConnectionAttemptId(connectionAttemptIdValue) ||
    (serverFingerprint !== null && !isServerFingerprint(serverFingerprint))
  ) return false;
  try {
    return canonicalServerScope(scope) === scope && new URL(scope).origin === scope;
  } catch {
    return false;
  }
}

function validRegistryScopeOrNull(scope: unknown): scope is string | null {
  return scope === null || (typeof scope === "string" && /^[a-f0-9]{16}$/.test(scope));
}

function validRoutingServerUrl(value: unknown, canonicalOrigin: string): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    if (
      parsed.origin !== canonicalOrigin ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) return false;
    const normalized = parsed.pathname === "/"
      ? parsed.origin
      : `${parsed.origin}${parsed.pathname}`;
    return value === normalized;
  } catch {
    return false;
  }
}

function validIdentityTransition(
  transition: PendingConnection["identityTransition"],
  origin: string,
  prior: PriorActiveAuthorityGuard,
): boolean {
  if (transition.kind === "ordinary") return Object.keys(transition).length === 1;
  try {
    return Object.keys(transition).length === 4 && prior.scope === origin && prior.revision !== null &&
      prior.connectionAttemptId === transition.priorConnectionAttemptId &&
      prior.serverFingerprint === transition.priorServerFingerprint &&
      validRoutingServerUrl(transition.priorRoutingServerUrl, origin);
  } catch { return false; }
}

function validRecoveryIdentityTransition(
  transition: PendingConnection["identityTransition"],
  origin: string,
  prior: RecoveryPriorAuthorityGuard,
  current: ObservedActiveAuthority,
): boolean {
  if (transition.kind === "ordinary") return Object.keys(transition).length === 1;
  try {
    return Object.keys(transition).length === 4 && prior.scope === origin && prior.revision !== null &&
      transition.priorConnectionAttemptId !== current.connectionAttemptId &&
      prior.revision !== current.revision && current.serverFingerprint !== null &&
      transition.priorServerFingerprint !== current.serverFingerprint &&
      validRoutingServerUrl(transition.priorRoutingServerUrl, origin);
  } catch { return false; }
}

/** Electron partitions without the `persist:` prefix are process-ephemeral. */
function candidatePartition(
  targetRegistryScope: string,
  attemptId: string,
  generation: number,
): string {
  return `server-candidate-${targetRegistryScope}-${attemptId}-${generation}`;
}

function validRecoveryPriorAuthorityGuard(
  guard: unknown,
): guard is RecoveryPriorAuthorityGuard {
  if (!guard || typeof guard !== "object" || Array.isArray(guard)) return false;
  const value = guard as Record<string, unknown>;
  if (value["scope"] === null || value["revision"] === null) {
    return value["scope"] === null && value["revision"] === null;
  }
  return typeof value["scope"] === "string" &&
    canonicalServerScope(value["scope"]) === value["scope"] &&
    new URL(value["scope"]).origin === value["scope"] &&
    isOpaqueActiveRevision(value["revision"]);
}

function postCommitCheckpointIndex(checkpoint: PreparedServerSwitchCheckpoint): number {
  const ordered: readonly PreparedServerSwitchCheckpoint[] = [
    "metadata",
    "old-codex",
    "old-relay",
    "old-profile",
    "old-identity",
    "renderer-authority",
    "visibility",
    "target-relay",
    "pending-clear",
    "complete",
  ];
  return ordered.indexOf(checkpoint);
}

type EnrichedAliasCandidate = {
  live: ServerSession | undefined;
  recent: RecentServerEntry | undefined;
  url: string;
  fingerprint: string | undefined;
  /** `null` for non-loopback URLs; otherwise protocol+port-preserving key. */
  loopbackKey: string | null;
};

/**
 * Return the dedupe-only loopback key, or `null` for a non-loopback URL.
 * Non-loopback URLs are deliberately excluded from the absent-fingerprint
 * fallback: matching profile data is not server identity.
 */
function loopbackAliasKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    return isLoopbackHostname(parsed.hostname) ? loopbackDedupeKey(url) : null;
  } catch {
    return null;
  }
}

/**
 * M161 Phase 6.4 — group candidates without allowing an unfingerprinted
 * loopback alias to bridge two distinct trusted fingerprints.
 *
 * 1. Nonempty fingerprints form groups by fingerprint, regardless of URL.
 * 2. An unfingerprinted candidate joins a fingerprint group only when its
 *    loopback protocol/port key matches exactly one such group.
 * 3. Remaining unfingerprinted loopback aliases group by that key;
 *    non-loopback candidates remain individual rows.
 *
 * This grouping is in-memory only. It never changes persisted token scopes,
 * partition identities, or recent-server URLs; `canonicalServerScope`
 * remains the persisted identity authority. The deeper on-disk canonical
 * migration remains TRACKED to D133.
 */
function collapseAliasCandidates(
  candidates: EnrichedAliasCandidate[],
): EnrichedAliasCandidate[][] {
  const fingerprintGroups = new Map<string, EnrichedAliasCandidate[]>();
  const unfingerprinted: EnrichedAliasCandidate[] = [];

  for (const candidate of candidates) {
    if (candidate.fingerprint) {
      const group = fingerprintGroups.get(candidate.fingerprint);
      if (group) group.push(candidate);
      else fingerprintGroups.set(candidate.fingerprint, [candidate]);
    } else {
      unfingerprinted.push(candidate);
    }
  }

  const groups = [...fingerprintGroups.values()];
  const remaining: EnrichedAliasCandidate[] = [];
  for (const candidate of unfingerprinted) {
    if (candidate.loopbackKey === null) {
      remaining.push(candidate);
      continue;
    }
    const compatible = groups.filter((group) =>
      group.some((member) => member.loopbackKey === candidate.loopbackKey),
    );
    // A missing fingerprint may collapse only with one unambiguous trusted
    // loopback group. Do not let it bridge distinct fingerprints.
    if (compatible.length === 1) compatible[0]!.push(candidate);
    else remaining.push(candidate);
  }

  const fallbackGroups = new Map<string, EnrichedAliasCandidate[]>();
  for (const candidate of remaining) {
    // Distinct non-loopback servers cannot collapse through this fallback.
    const key = candidate.loopbackKey === null
      ? `url:${candidate.url}`
      : `loopback:${candidate.loopbackKey}`;
    const group = fallbackGroups.get(key);
    if (group) group.push(candidate);
    else fallbackGroups.set(key, [candidate]);
  }
  return [...groups, ...fallbackGroups.values()];
}

/**
 * M161 Phase 6.4 — pick the anchor candidate for a collapsed group.
 * The active live session wins; otherwise any live session wins;
 * otherwise the most-recent recent wins. `activeUrl` is the canonical
 * URL of the registry's current active session (null when none).
 */
function pickGroupAnchor<T extends {
  live?: { serverUrl: string } | undefined;
  recent?: { lastUsedAt: string } | undefined;
  url: string;
}>(
  group: T[],
  activeUrl: string | null,
): T {
  if (activeUrl !== null) {
    const activeLive = group.find((c) => c.live?.serverUrl === activeUrl);
    if (activeLive) return activeLive;
  }
  const anyLive = group.find((c) => c.live !== undefined);
  if (anyLive) return anyLive;
  const sorted = [...group].sort((a, b) => {
    const at = Date.parse(a.recent?.lastUsedAt ?? "");
    const bt = Date.parse(b.recent?.lastUsedAt ?? "");
    if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
    if (Number.isNaN(at)) return 1;
    if (Number.isNaN(bt)) return -1;
    return bt - at;
  });
  return sorted[0] ?? group[0]!;
}

function sessionToListEntry(session: ServerSession): ServerListEntry {
  const entry: ServerListEntry = {
    url: session.serverUrl,
    iconUrl: session.profile?.iconUrl ?? "",
    connection: session.connection,
  };
  if (session.profile?.name !== undefined) {
    entry.name = session.profile.name;
  }
  if (session.profile?.description !== undefined) {
    entry.description = session.profile.description;
  }
  return entry;
}
