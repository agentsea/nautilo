/**
 * D468 — authoritative, multi-server app-badge reconciliation.
 *
 * A native badge is only a projection of freshly fetched server truth.  This
 * worker deliberately has no access to the active API singleton or React auth
 * state: each registry row gets its own client and SecureStore-backed token
 * provider.  If any registered server is unavailable, we leave the existing
 * OS badge alone rather than incorrectly clearing another server's activity.
 */
import * as Notifications from "expo-notifications";

import { NautiloApiClient } from "@nautilo/api-client/browser";
import type { NotificationStateResponse } from "@nautilo/types";

import { ensureValidToken } from "@/lib/auth";
import { createPushPermissionPolicy } from "@/lib/push-permission-policy";
import {
  isServerRegistrationCurrent,
  loadRegistry,
  loadServerRegistrationSnapshot,
  loadTokenSnapshot,
  type ServerRecord,
} from "@/lib/server-store";

const MOBILE_NOTIFICATION_STATE_MAX_CONCURRENCY = 2;

type BadgeClient = Pick<NautiloApiClient, "setToken" | "setTokenProvider" | "getNotificationState">;

export type BadgePresentation = "clear" | "ambient" | "important";

export interface PushBadgeSummary {
  readonly kind: "updated" | "unchanged" | "unavailable" | "disabled";
  readonly presentation?: BadgePresentation;
  readonly badgeCount?: number;
  readonly unavailableServerIds: readonly string[];
}

export interface MobileNotificationStateLoaderDeps {
  readonly loadServerRegistrationSnapshot: typeof loadServerRegistrationSnapshot;
  readonly isServerRegistrationCurrent: typeof isServerRegistrationCurrent;
  readonly loadTokenSnapshot: typeof loadTokenSnapshot;
  readonly ensureValidToken: typeof ensureValidToken;
  readonly createClient: (serverUrl: string) => BadgeClient;
}

interface BadgeReconcilerDeps extends MobileNotificationStateLoaderDeps {
  readonly loadRegistry: typeof loadRegistry;
  readonly loadServerRegistrationSnapshot: typeof loadServerRegistrationSnapshot;
  readonly isServerRegistrationCurrent: typeof isServerRegistrationCurrent;
  readonly loadTokenSnapshot: typeof loadTokenSnapshot;
  readonly ensureValidToken: typeof ensureValidToken;
  readonly createClient: (serverUrl: string) => BadgeClient;
  readonly setBadgeCount: (count: number) => Promise<boolean>;
  /** Observes native permission/preference only; it never asks the OS. */
  readonly isBadgeEnabled: () => Promise<boolean>;
  readonly maxConcurrency: number;
}

const defaultDeps: BadgeReconcilerDeps = {
  loadRegistry,
  loadServerRegistrationSnapshot,
  isServerRegistrationCurrent,
  loadTokenSnapshot,
  ensureValidToken,
  createClient: (serverUrl) => new NautiloApiClient(serverUrl),
  setBadgeCount: (count) => Notifications.setBadgeCountAsync(count),
  isBadgeEnabled: async () => (await createPushPermissionPolicy().refresh()).badge === "enabled",
  maxConcurrency: MOBILE_NOTIFICATION_STATE_MAX_CONCURRENCY,
};

function validCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function totalsFrom(state: NotificationStateResponse): { unread: number; important: number } | null {
  const unread = validCount(state.totals?.unreadCount);
  const important = validCount(state.totals?.importantUnreadCount);
  if (unread === null || important === null || important > unread) return null;
  return { unread, important };
}

/** The native badge is the exact aggregate unread count across fresh servers. */
export function badgeProjection(totals: { unread: number; important: number }): {
  readonly presentation: BadgePresentation;
  readonly badgeCount: number;
} {
  if (totals.important > 0) return { presentation: "important", badgeCount: totals.unread };
  if (totals.unread > 0) return { presentation: "ambient", badgeCount: totals.unread };
  return { presentation: "clear", badgeCount: 0 };
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
        const index = cursor++;
        const value = values[index];
        if (value === undefined) return;
        await run(value);
      }
    },
  );
  await Promise.all(workers);
}

export type MobileNotificationStateLoadResult =
  | { readonly kind: "fresh"; readonly snapshot: NotificationStateResponse }
  | { readonly kind: "signed_out" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "removed" };

export interface MobileNotificationStateLoader {
  load(server: ServerRecord): Promise<MobileNotificationStateLoadResult>;
}

/** Bounded shared batch operation for every inactive-server projection. */
export async function loadMobileNotificationStateBatch(
  servers: readonly ServerRecord[],
  loader: MobileNotificationStateLoader,
  maxConcurrency = MOBILE_NOTIFICATION_STATE_MAX_CONCURRENCY,
): Promise<ReadonlyMap<string, MobileNotificationStateLoadResult>> {
  const results = new Map<string, MobileNotificationStateLoadResult>();
  await mapConcurrent(servers, maxConcurrency, async (server) => {
    try {
      results.set(server.id, await loader.load(server));
    } catch {
      results.set(server.id, { kind: "unavailable" });
    }
  });
  return results;
}

/**
 * The one headless inactive-server notification fetch spine. It deliberately
 * never reaches the active API singleton, so a stale server cannot rebind or
 * sign out the visible session. Both native-badge and in-app attention reuse
 * this exact authenticated source of truth.
 */
export function createMobileNotificationStateLoader(
  supplied: Partial<MobileNotificationStateLoaderDeps> = {},
): MobileNotificationStateLoader {
  const deps: MobileNotificationStateLoaderDeps = { ...defaultDeps, ...supplied };

  return {
    async load(server) {
      let snapshot: Awaited<ReturnType<typeof loadServerRegistrationSnapshot>> = null;
      try {
        snapshot = await deps.loadServerRegistrationSnapshot(server.id);
        if (!snapshot || snapshot.server.serverUrl !== server.serverUrl) return { kind: "removed" };
        // Explicit local sign-out is known zero reachability, unlike a failed
        // refresh or network operation, which remains unavailable/last-known.
        const before = await deps.loadTokenSnapshot(snapshot.server.id);
        if (!before.tokens) return { kind: "signed_out" };
        const token = await deps.ensureValidToken(snapshot.server.id, snapshot.server.serverUrl);
        if (!token || !(await deps.isServerRegistrationCurrent(snapshot))) {
          return (await deps.isServerRegistrationCurrent(snapshot)) ? { kind: "unavailable" } : { kind: "removed" };
        }
        const currentSnapshot = snapshot;
        const client = deps.createClient(currentSnapshot.server.serverUrl);
        // Notification state uses the client's already-latched session token;
        // the provider remains available for any later refresh-aware request.
        client.setToken(token);
        client.setTokenProvider(() => deps.ensureValidToken(
          currentSnapshot.server.id,
          currentSnapshot.server.serverUrl,
        ));
        const state = await client.getNotificationState();
        if (!(await deps.isServerRegistrationCurrent(snapshot))) return { kind: "removed" };
        return totalsFrom(state) ? { kind: "fresh", snapshot: state } : { kind: "unavailable" };
      } catch {
        if (!snapshot) return { kind: "unavailable" };
        try {
          return (await deps.isServerRegistrationCurrent(snapshot)) ? { kind: "unavailable" } : { kind: "removed" };
        } catch {
          return { kind: "unavailable" };
        }
      }
    },
  };
}

export interface MobilePushBadgeReconciler {
  /** Coalesces repeated lifecycle, registry, and auth invalidations. */
  trigger(): Promise<PushBadgeSummary>;
  /** Reserved for the lifecycle contract; invalidations are owned by React. */
  start(): void;
  stop(): void;
}

export function createMobilePushBadgeReconciler(
  supplied: Partial<BadgeReconcilerDeps> = {},
): MobilePushBadgeReconciler {
  const deps: BadgeReconcilerDeps = { ...defaultDeps, ...supplied };
  let running: Promise<PushBadgeSummary> | null = null;
  let rerunRequested = false;
  let stopped = false;
  const loader = createMobileNotificationStateLoader(deps);

  async function runOnce(): Promise<PushBadgeSummary> {
    if (stopped || !(await deps.isBadgeEnabled())) {
      return { kind: "disabled", unavailableServerIds: [] };
    }
    const registry = await deps.loadRegistry();
    let unread = 0;
    let important = 0;
    const unavailableServerIds: string[] = [];
    await mapConcurrent(registry.servers, deps.maxConcurrency, async (server) => {
      const result = await loader.load(server);
      if (result.kind === "fresh") {
        unread += result.snapshot.totals.unreadCount;
        important += result.snapshot.totals.importantUnreadCount;
      } else if (result.kind === "unavailable") {
        unavailableServerIds.push(server.id);
      }
    });

    // Never turn an offline, stale, or otherwise unknown server into an
    // apparent zero. Leaving the native projection untouched is the only
    // honest operation. Explicitly signed-out rows were excluded above.
    if (unavailableServerIds.length > 0 || stopped) {
      return { kind: "unchanged", unavailableServerIds };
    }
    const projected = badgeProjection({ unread, important });
    try {
      const applied = await deps.setBadgeCount(projected.badgeCount);
      return applied
        ? { kind: "updated", ...projected, unavailableServerIds: [] }
        : { kind: "unavailable", unavailableServerIds: [] };
    } catch {
      return { kind: "unavailable", unavailableServerIds: [] };
    }
  }

  async function run(): Promise<PushBadgeSummary> {
    let result: PushBadgeSummary;
    do {
      rerunRequested = false;
      result = await runOnce();
    } while (rerunRequested && !stopped);
    return result!;
  }

  return {
    trigger() {
      if (running) {
        rerunRequested = true;
        return running;
      }
      const next = run();
      running = next;
      const clearRunning = () => {
        if (running === next) running = null;
      };
      // `finally()` creates a second promise that rejects with `next`; floating
      // that child surfaced duplicate unhandled rejections for offline saved
      // servers even when the caller handled the original request.
      void next.then(clearRunning, clearRunning);
      return next;
    },
    start() {
      stopped = false;
      void this.trigger().catch(() => {});
    },
    stop() { stopped = true; rerunRequested = false; },
  };
}
