/**
 * M087 — single source of truth for time formatting. Consumed by BOTH the
 * `## Current time` system-prompt block (`templates.ts`) and the
 * `get_current_time` agent tool, so their rendered local-time strings are
 * byte-identical at the same instant.
 */

/**
 * Format an instant as a user-local string like:
 *   "Saturday, 2026-05-09 18:58 (Europe/Athens, UTC+03:00)"
 *
 * `tz` MUST be a valid IANA timezone name. Uses two `Intl.DateTimeFormat`
 * passes: one for weekday + Y-M-D + 24h HH:mm in the target zone, one to
 * extract the long GMT offset which is rewritten "GMT" -> "UTC".
 */
export function formatLocal(d: Date, tz: string): string {
  const dateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const part = (type: string): string =>
    dateParts.find((p) => p.type === type)?.value ?? "";

  const weekday = part("weekday");
  const year = part("year");
  const month = part("month");
  const day = part("day");
  let hour = part("hour");
  // Intl can emit "24" for midnight in some runtimes; normalize to "00".
  if (hour === "24") hour = "00";
  const minute = part("minute");

  const offset = formatUtcOffset(d, tz);

  return `${weekday}, ${year}-${month}-${day} ${hour}:${minute} (${tz}, ${offset})`;
}

/**
 * Returns the UTC offset for `d` in `tz` as "UTC+03:00" / "UTC-05:00" /
 * "UTC+00:00". Derived from the `longOffset` time-zone name ("GMT+03:00")
 * with "GMT" rewritten to "UTC". Falls back to "UTC+00:00" if the runtime
 * does not surface an offset token.
 */
export function formatUtcOffset(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "longOffset",
    hour: "2-digit",
  }).formatToParts(d);
  const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  // raw looks like "GMT+03:00", "GMT-05:00", or just "GMT" (== UTC).
  if (raw === "GMT" || raw === "UTC") return "UTC+00:00";
  const m = raw.match(/^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!m) return "UTC+00:00";
  const sign = m[1];
  const hh = m[2]!.padStart(2, "0");
  const mm = (m[3] ?? "00").padStart(2, "0");
  return `UTC${sign}${hh}:${mm}`;
}

/**
 * Bucket an elapsed duration (ms) into a coarse human label. Intentionally
 * pluralization-naive for v1 ("1 minutes"). Negative deltas clamp to
 * "just now".
 */
export function relativeBucket(deltaMs: number): string {
  if (deltaMs < 60_000) return "just now";
  if (deltaMs < 3_600_000) return `${Math.floor(deltaMs / 60_000)} minutes`;
  if (deltaMs < 86_400_000) return `${Math.floor(deltaMs / 3_600_000)} hours`;
  return `${Math.floor(deltaMs / 86_400_000)} days`;
}
