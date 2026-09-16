/**
 * M087 — IANA timezone validation. The chat ingress validates the client-
 * supplied `userTimezone` against the runtime's `Intl.supportedValuesOf`
 * set. Invalid values are dropped (logged, never 400'd) and never persisted
 * to `users.timezone`.
 */

let supported: Set<string> | null = null;

function getSupported(): Set<string> {
  if (!supported) {
    supported = new Set(Intl.supportedValuesOf("timeZone"));
  }
  return supported;
}

/**
 * Returns the canonical IANA timezone string if `value` is a supported
 * timezone name, else `null`. Rejects non-strings, empty strings, and
 * strings longer than 64 chars before consulting the supported set.
 */
export function validateIanaTimezone(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    return null;
  }
  return getSupported().has(value) ? value : null;
}
