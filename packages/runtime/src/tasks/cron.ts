import { CronExpressionParser } from "cron-parser";

/**
 * M142 — thin `cron-parser` wrapper. Returns the next occurrence of a
 * 5-field cron expression in the given IANA timezone, strictly AFTER `after`.
 *
 * This is the recurrence helper consumed by the `TaskObserver` (reschedule)
 * and `createTask` (initial `next_fire_at` for `cron` tasks). It is NOT the
 * structured-recurrence → cron compiler (that is Phase 4); it only advances
 * an already-authored cron string.
 *
 * `cron-parser` v5 dropped the v4 default export / `parseExpression` and the
 * `utc` flag — pass `tz: "UTC"` instead. `.next()` returns a `CronDate`;
 * `.toDate()` yields the absolute UTC `Date`.
 */
export function nextCronOccurrence(
  cron: string,
  timezone: string,
  after: Date,
): Date {
  const it = CronExpressionParser.parse(cron, {
    currentDate: after,
    tz: timezone,
  });
  return it.next().toDate();
}
