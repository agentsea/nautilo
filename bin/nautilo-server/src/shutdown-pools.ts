import { closeRegisteredPools } from "@nautilo/db";

export const DB_POOL_CLOSE_TIMEOUT_MS = 1000;

export type CloseRegisteredPoolsFn = typeof closeRegisteredPools;

export function remainingShutdownDeadlineMs(
  deadlineAtMs: number,
  nowMs = Date.now(),
): number {
  return Math.max(0, deadlineAtMs - nowMs);
}

/**
 * Close every pool registered for process shutdown within a bounded timeout.
 * Failures are logged with stable pool labels only — no DSN or raw errors.
 */
export async function closeRegisteredDbPoolsOnShutdown(options: {
  totalDeadlineMs: number;
  closePools?: CloseRegisteredPoolsFn;
  warn?: (message: string) => void;
}): Promise<void> {
  const warn = options.warn ?? (() => {});
  const closePools = options.closePools ?? closeRegisteredPools;
  const timeoutMs = Math.min(
    DB_POOL_CLOSE_TIMEOUT_MS,
    Math.max(1, options.totalDeadlineMs),
  );

  await closePools({
    timeoutMs,
    onError: (name) => {
      warn(`[server] db pool close failed pool=${name}`);
    },
  });
}
