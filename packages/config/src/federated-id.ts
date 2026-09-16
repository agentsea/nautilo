import { resolveInstance, type ResolveInstanceOptions } from "./resolve-instance";

export { composeFederatedId, parseFederatedId } from "./federated-id-pure";

/**
 * Federated-identity helpers (M042C).
 *
 * Canonical home for pure helpers around `@handle@server` identities:
 * compose, parse, normalize, validate, slugify, plus
 * {@link getServerHostname} (resolved federated host via `resolveInstance`).
 *
 * These live in `@nautilo/config` rather than `@nautilo/trust` because
 * `@nautilo/db` (specifically the seed code under `packages/db/src/utils/`)
 * needs them too, and db cannot depend on trust (trust already depends on
 * db — that would be a cycle). `@nautilo/config` is downstream of
 * `@nautilo/logger` only; both db and trust can safely depend on it.
 *
 * Browser-only consumers should import compose/parse from
 * `@nautilo/config/federated-id-pure` instead of this module.
 *
 * `@nautilo/trust` re-exports these symbols for callers that already
 * import from trust.
 */

/**
 * Normalize a user-supplied handle before validating/storing it.
 * Trims whitespace and lowercases ASCII. Does NOT strip invalid
 * characters — those still fail `validateHandle`, with an explanatory
 * reason for the UI to render.
 */
export function normalizeHandle(raw: string): string {
  return raw.trim().toLowerCase();
}

export type HandleValidation =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Validate a normalized handle. Rules:
 * - ASCII lowercase a–z, digits, `-`, `_`
 * - 3–32 chars total
 * - cannot start or end with a separator
 */
export function validateHandle(handle: string): HandleValidation {
  if (handle.length < 3) {
    return { ok: false, reason: "Handle must be at least 3 characters." };
  }
  if (handle.length > 32) {
    return { ok: false, reason: "Handle must be 32 characters or fewer." };
  }
  if (!/^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?$/.test(handle)) {
    return {
      ok: false,
      reason:
        "Handle may only contain lowercase letters, digits, '-', and '_', and cannot start or end with a separator.",
    };
  }
  return { ok: true };
}

/**
 * Best-effort slugify of a display name into a handle. Used by
 * `seedDefaultOwner` to auto-derive a handle for existing installs
 * where `users.handle` is NULL. Returns `null` if the slug fails
 * validation (empty input, pure-symbol input, etc.); callers should
 * fall back to a literal like `"owner"` in that case.
 */
export function slugifyToHandle(name: string): string | null {
  const ascii = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // combining marks
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .replace(/([-_])\1+/g, "$1")
    .slice(0, 32);
  return validateHandle(ascii).ok ? ascii : null;
}

/**
 * Current server hostname used as the right-hand side of federated ids.
 *
 * Source: **`resolveInstance().hostname.federated`** (instance.json +
 * `nautilo.config.ts` + env overlays such as `NAUTILO_FEDERATED_HOSTNAME` /
 * `NAUTILO_HOSTNAME`). Matches TLS identity / WebFinger / mDNS policy
 * (mDNS uses `resolveInstance().hostname.mdns` separately).
 */
export function getServerHostname(
  env: NodeJS.ProcessEnv = process.env,
  options?: ResolveInstanceOptions,
): string {
  return resolveInstance(env, options ?? {}).hostname.federated;
}
