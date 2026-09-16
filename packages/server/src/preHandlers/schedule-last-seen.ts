import { bumpLastSeen } from "@nautilo/trust";

const lastScheduledBumpMs = new Map<string, number>();
const COALESCE_MS = 30_000;

/**
 * D124 — schedule a best-effort `users.last_seen_at` bump after auth
 * has resolved `sessionUserId`. Call from the HTTP trust preHandler
 * success path only.
 *
 * Coalesces to at most one scheduled bump per user per ~30s process
 * window so polling (`whoami`, room lists) does not amplify writes.
 */
export function scheduleLastSeenBump(sessionUserId: string | null | undefined): void {
  if (!sessionUserId) return;
  const now = Date.now();
  const prev = lastScheduledBumpMs.get(sessionUserId);
  if (prev !== undefined && now - prev < COALESCE_MS) return;
  lastScheduledBumpMs.set(sessionUserId, now);
  queueMicrotask(() => {
    void bumpLastSeen(sessionUserId).catch(() => {
      /* swallow — stale last_seen is tolerable */
    });
  });
}
