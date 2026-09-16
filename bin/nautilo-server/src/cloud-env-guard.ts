/**
 * D120 A3 — assert every secret + config env var that nautilo-server
 * itself reads at boot is present in cloud mode. Cloud-mode boots
 * without these would either crash mid-request (silent footgun) or
 * silently downgrade to wrong behavior; fail-fast at boot with a
 * clear message that surfaces in container logs.
 *
 * Local mode (NAUTILO_HOSTING_MODE != "cloud") is exempt — local devs
 * may legitimately boot without provider keys for non-LLM smoke
 * testing.
 *
 * Same shape as `assertProductionBuildPolicy` / `assertTestModeCoupling`.
 *
 * SCOPE — what this guard validates and what it does NOT
 * ----------------------------------------------------------
 * It validates the env that THIS process (nautilo-server) reads.
 * It deliberately does NOT validate:
 *   - LOGTO_ADMIN_PASSWORD: read by the Logto container, not by
 *     nautilo-server. Compose-side concern; surfaced in
 *     `playbook/operator/env-vars.md` and `.env.example` for the
 *     operator, but a missing value here doesn't break the server's
 *     boot path — it would surface as Logto rejecting admin requests
 *     downstream, which the operator would see in the Logto container
 *     logs, not the server's.
 *   - NAUTILO_SESSION_JWT_SECRET: not currently consumed anywhere in
 *     this codebase. The session-store path (D112) uses a different
 *     mechanism. Tracked as a forward-looking placeholder in the
 *     `.env.example` only — not enforced here until a real reader
 *     lands.
 *
 * NAUTILO_BOOTSTRAP_TOKEN is enforced even though A5 (the privileged-
 * setup helper that consumes it via `requestAllowsPrivilegedSetup`)
 * lands in the same omnibus PR — by the time this code ships, A5's
 * reader is live. If the token is unset, remote CLI claim is
 * impossible (the only point of cloud mode for milestone A), so
 * fail-fast is correct.
 */

import { isCloudMode } from "@nautilo/config";
const REQUIRED_IN_CLOUD = ["NAUTILO_BOOTSTRAP_TOKEN"] as const;

export function assertRequiredCloudEnv(
  env: NodeJS.ProcessEnv,
): { ok: true } | { ok: false; message: string } {
  if (!isCloudMode(env)) return { ok: true };

  const missing: string[] = [];

  for (const key of REQUIRED_IN_CLOUD) {
    const v = env[key];
    if (!v || v.trim() === "") missing.push(key);
  }

  // Model-provider credentials are intentionally not a boot requirement.
  // A new cloud owner must be able to reach authenticated server setup before
  // adding provider credentials there. Hosting pre-mutation evaluates missing
  // core capabilities separately and requires explicit degraded-mode consent;
  // this guard is limited to authority required for the server to start safely.

  // The DB layer (`packages/db/src/config/database.ts:15-18`) requires
  // `DB_CONNECTION_STRING` and throws if missing. `DB_DIRECT_CONNECTION`
  // is optional override (falls back to `resolveInstance().db.directConnection`).
  // The compose entrypoint is responsible for assembling POSTGRES_*
  // → DB_CONNECTION_STRING before exec'ing the server; we only check
  // what the server itself reads.
  const hasDbUrl = env["DB_CONNECTION_STRING"]?.trim();
  if (!hasDbUrl) {
    missing.push(
      "DB_CONNECTION_STRING (the compose entrypoint should derive this from POSTGRES_HOST/USER/PASSWORD/DB)",
    );
  }

  if (missing.length === 0) return { ok: true };

  return {
    ok: false,
    message:
      "Cloud-mode boot missing required env vars:\n" +
      missing.map((m) => `  - ${m}`).join("\n") +
      "\nSee playbook/operator/env-vars.md for the full contract.",
  };
}
