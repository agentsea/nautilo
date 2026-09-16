import { join, normalize } from "node:path";

/**
 * Named-instance id (M071 Phase 2A). Lowercase host-label style; safe for
 * `~/.nautilo-${id}` directory names (no path separators).
 *
 * @see phase-2a-named-instance-port-scan.md
 */
export const NAUTILO_INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]?$/;

/**
 * Case-insensitive aliases that mean "the default (unnamed) instance".
 * Operators occasionally pass `--instance default` (or the dev-stack-printed
 * `(default)` label) expecting it to map to the unnamed `~/.nautilo/` root
 * rather than `~/.nautilo-default/`. Treat both as `""`.
 *
 * Mirrors `bin/nautilo-dev/src/lib/instance-id.ts`.
 */
export const DEFAULT_INSTANCE_ALIASES: ReadonlySet<string> = new Set([
  "default",
  "(default)",
]);

/**
 * Returns `true` when `raw` (trimmed, case-insensitive) is one of the
 * documented "default instance" aliases.
 */
export function isDefaultInstanceAlias(raw: string): boolean {
  return DEFAULT_INSTANCE_ALIASES.has(raw.trim().toLowerCase());
}

/**
 * Validate `NAUTILO_INSTANCE_ID` when set via config-guard. Empty / whitespace
 * means the default instance and is accepted.
 */
export function validateNautiloInstanceIdValue(raw: string): string | null {
  const t = raw.trim();
  if (t === "") return null;
  if (!NAUTILO_INSTANCE_ID_PATTERN.test(t)) {
    return (
      "must be lowercase, use only a–z, 0–9, hyphen, underscore, " +
      "at most 32 characters, and match ^[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]?$"
    );
  }
  return null;
}

/**
 * Returns `true` when `value` is an exact canonical instance id: the default
 * instance as `""`, or a named id that passes {@link validateNautiloInstanceIdValue}
 * without trimming. Rejects surrounding whitespace, whitespace-only strings,
 * invalid patterns, and non-strings.
 */
export function isCanonicalNautiloInstanceId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value !== value.trim()) return false;
  return validateNautiloInstanceIdValue(value) === null;
}

/**
 * Resolve the storage root: `~/.nautilo` (default) or `~/.nautilo-${id}` for a
 * valid named id. Throws with an actionable message if `id` is non-empty but invalid.
 */
export function resolveNautiloStorageRoot(
  userHomeDir: string,
  instanceId: string,
): string {
  const id = instanceId.trim();
  if (id === "") {
    return normalize(join(userHomeDir, ".nautilo"));
  }
  const err = validateNautiloInstanceIdValue(id);
  if (err !== null) {
    throw new Error(`NAUTILO_INSTANCE_ID="${id}": ${err}`);
  }
  return normalize(join(userHomeDir, `.nautilo-${id}`));
}
