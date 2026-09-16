/**
 * Relative timestamp for approval rows (e.g. "3 days ago").
 * `now` is injectable for tests.
 */
export function formatRelativeTime(isoDate: string, nowMs: number = Date.now()): string {
  const thenMs = new Date(isoDate).getTime();
  if (Number.isNaN(thenMs)) return isoDate;

  const diffSec = Math.round((thenMs - nowMs) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const absSec = Math.abs(diffSec);

  if (absSec < 60) return rtf.format(diffSec, "second");

  const diffMin = Math.round(diffSec / 60);
  if (Math.abs(diffMin) < 60) return rtf.format(diffMin, "minute");

  const diffHr = Math.round(diffSec / 3600);
  if (Math.abs(diffHr) < 24) return rtf.format(diffHr, "hour");

  const diffDay = Math.round(diffSec / 86400);
  return rtf.format(diffDay, "day");
}
