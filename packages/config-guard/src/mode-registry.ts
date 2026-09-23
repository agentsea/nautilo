/**
 * M051: registry for non-key configuration knobs (modes, URLs, IDs, secrets
 * that don't fit the API-key shape in `key-registry.ts`).
 *
 * `KEY_REGISTRY` entries describe LLM/voice/search API keys with a
 * `formatCheck: (v) => boolean` per-key shape check. Logto's vars don't fit:
 * the four `LOGTO_*_URI/ENDPOINT/ISSUER/RESOURCE` vars are URLs, and the four
 * app-id/secret vars are opaque strings whose presence is the only thing we
 * can validate without calling Logto. Rather than bolt a `kind:` discriminator
 * onto `KEY_REGISTRY`, we keep a parallel registry with a richer per-entry
 * validator.
 *
 * Cross-key invariants (every `LOGTO_*` key must be set in the merged env)
 * live in `validator.ts` `crossKeyInvariants()`, not here — entries in
 * MODE_REGISTRY validate themselves in isolation.
 *
 * Canonical design: `research/logto-integration-v1.md` §7.4.
 * M071 adds instance/network/compose knobs validated here and merged by
 * `resolveInstance()` in `@nautilo/config`.
 */

import { validateNautiloInstanceIdValue } from "@nautilo/config/instance-id";
import {
  GOOGLE_OAUTH_CLIENT_JSON_ENV,
  validateGoogleOAuthClientJsonBase64Env,
} from "./google-oauth-client-json";
import { normalizeManagedGatewayBaseUrl } from "./managed-gateway";

export interface ModeDefinition {
  /** Short id matching the env-var name (single registry-wide identifier). */
  id: string;
  /** The `process.env` key. */
  envVar: string;
  /** Human-readable description for doctor / UI / docs. */
  description: string;
  /** Returns null for valid input, an error message string otherwise. */
  validator: (value: string) => string | null;
  /** Default value used when computing the cross-key invariant view. */
  default?: string;
  /**
   * When true, `getModeReport()` returns the value masked via `maskValue`
   * from `key-registry.ts`. The audit-log records keys without values and
   * the snapshot store keeps full plaintext for rollback — neither needs
   * redaction; this flag exists solely for UI/CLI surfaces.
   */
  redact?: boolean;
  /**
   * When true, surfaces in `getModeReport()` for UI deprecation affordances.
   */
  deprecated?: boolean;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Decimal TCP port 1–65535 (string must equal parseInt stringification). */
function validateTcpPort(value: string): string | null {
  const t = value.trim();
  const n = Number.parseInt(t, 10);
  if (Number.isNaN(n) || String(n) !== t) {
    return "must be a decimal port number (1–65535) with no extra characters";
  }
  if (n < 1 || n > 65535) return "must be between 1 and 65535";
  return null;
}

/** Hostname / bind host / TLS SAN label segment. */
function validateHostLabel(value: string): string | null {
  const t = value.trim();
  if (t.length === 0) return "must not be empty";
  if (t.length > 253) return "must be 253 characters or fewer";
  if (/\s/.test(t)) return "must not contain whitespace";
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if ((c >= 0 && c < 32) || c === 127) {
      return "must not contain control characters";
    }
  }
  return null;
}

function validateCommaSeparatedHosts(value: string): string | null {
  const t = value.trim();
  if (t === "") return null;
  for (const part of t.split(",")) {
    const err = validateHostLabel(part);
    if (err !== null) return err;
  }
  return null;
}

function validateNautiloServerUrl(value: string): string | null {
  return isHttpUrl(value.trim()) ? null : "must be an http(s) URL";
}

function validateComposeProjectName(value: string): string | null {
  const t = value.trim();
  if (t.length === 0) return "must not be empty";
  if (t.length > 128) return "must be 128 characters or fewer";
  if (t !== t.toLowerCase()) {
    return "must be lowercase (docker compose project naming)";
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(t)) {
    return "compose project name: start with a letter; only a–z, 0–9, hyphen, underscore";
  }
  return null;
}

function validateHexPassword(value: string): string | null {
  const t = value.trim();
  if (t.length === 0) return "must not be empty";
  // 48-char hex is the canonical M116 shape (crypto.randomBytes(24).toString("hex"));
  // accept any non-empty string (operator may rotate to a different shape later).
  if (!/^[A-Za-z0-9!#%&()*+,\-./:;<=>?@[\]^_{|}~]+$/.test(t)) {
    return "contains characters unsafe for SQL string assembly";
  }
  return null;
}

function validateIso8601Timestamp(value: string): string | null {
  const t = value.trim();
  if (t.length === 0) return "must not be empty";
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return "must be a valid ISO-8601 timestamp";
  return null;
}

export const MODE_REGISTRY: ModeDefinition[] = [
  {
    id: "LOGTO_ENDPOINT",
    envVar: "LOGTO_ENDPOINT",
    description: "Public URL of the Logto core (OIDC) server.",
    validator: (v) => (isHttpUrl(v) ? null : "must be an http(s) URL"),
  },
  {
    id: "LOGTO_ISSUER",
    envVar: "LOGTO_ISSUER",
    description: "OIDC issuer claim — usually `${LOGTO_ENDPOINT}/oidc`.",
    validator: (v) => (isHttpUrl(v) ? null : "must be an http(s) URL"),
  },
  {
    id: "LOGTO_JWKS_URI",
    envVar: "LOGTO_JWKS_URI",
    description: "JWKS endpoint — usually `${LOGTO_ENDPOINT}/oidc/jwks`.",
    validator: (v) => (isHttpUrl(v) ? null : "must be an http(s) URL"),
  },
  {
    id: "LOGTO_RESOURCE",
    envVar: "LOGTO_RESOURCE",
    description: "API resource indicator (audience claim).",
    validator: (v) => (isHttpUrl(v) ? null : "must be an http(s) URL"),
  },
  {
    id: "LOGTO_WORKBENCH_APP_ID",
    envVar: "LOGTO_WORKBENCH_APP_ID",
    description: "Logto SPA application id (workbench).",
    validator: (v) => (v.length > 0 ? null : "required"),
  },
  {
    id: "LOGTO_TUI_APP_ID",
    envVar: "LOGTO_TUI_APP_ID",
    description: "Legacy-named Logto Native application id used by CLI device flow.",
    validator: (v) => (v.length > 0 ? null : "required"),
  },
  {
    id: "LOGTO_TUI_LOOPBACK_APP_ID",
    envVar: "LOGTO_TUI_LOOPBACK_APP_ID",
    description:
      "Legacy-named Logto Native application id used by CLI loopback PKCE (M102; sibling to the device-flow-only LOGTO_TUI_APP_ID).",
    validator: (v) => (v.length > 0 ? null : "required"),
  },
  {
    id: "LOGTO_DESKTOP_APP_ID",
    envVar: "LOGTO_DESKTOP_APP_ID",
    description:
      "Logto Native application id (Electron desktop, M055 loopback PKCE).",
    validator: (v) => (v.length > 0 ? null : "required"),
  },
  {
    id: "LOGTO_MOBILE_APP_ID",
    envVar: "LOGTO_MOBILE_APP_ID",
    description:
      "Logto Native application id (mobile Expo client, M199 custom-scheme PKCE).",
    validator: (v) => (v.length > 0 ? null : "required"),
  },
  {
    id: "LOGTO_MOBILE_WEB_APP_ID",
    envVar: "LOGTO_MOBILE_WEB_APP_ID",
    description:
      "Logto SPA application id (Mobile Web, D515 exact-origin PKCE).",
    validator: (v) => (v.length > 0 ? null : "required"),
  },
  {
    id: "LOGTO_M2M_APP_ID",
    envVar: "LOGTO_M2M_APP_ID",
    description: "Logto M2M application id (Nautilo server admin path).",
    validator: (v) => (v.length > 0 ? null : "required"),
  },
  {
    id: "LOGTO_M2M_APP_SECRET",
    envVar: "LOGTO_M2M_APP_SECRET",
    description: "Logto M2M application secret (Nautilo server admin path).",
    validator: (v) => (v.length > 0 ? null : "required"),
    redact: true,
  },
  {
    id: "NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET",
    envVar: "NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET",
    description:
      "Bearer secret accepted by the Nautilo endpoint used by Logto's HTTP Email connector (M120 Phase 0).",
    validator: (v) => (v.trim().length >= 24 ? null : "must be at least 24 characters"),
    redact: true,
  },
  {
    id: "NAUTILO_REMOTE_PAIRING_PEPPER",
    envVar: "NAUTILO_REMOTE_PAIRING_PEPPER",
    description:
      "Per-instance HMAC pepper for remote-controller pairing challenges (D458 Wave 7).",
    validator: (v) =>
      /^[a-f0-9]{64,}$/i.test(v) && v.length % 2 === 0
        ? null
        : "must be an even-length hexadecimal value encoding at least 32 bytes",
    redact: true,
  },
  {
    id: "NAUTILO_PUSH_TOKEN_ENCRYPTION_KEY",
    envVar: "NAUTILO_PUSH_TOKEN_ENCRYPTION_KEY",
    description:
      "Per-instance AES-256 key for encrypting registered Expo push tokens at rest (D468).",
    validator: (v) =>
      /^[a-f0-9]{64}$/i.test(v)
        ? null
        : "must be a 32-byte hexadecimal value",
    redact: true,
  },
  {
    id: "NAUTILO_PASSWORD_RECOVERY_DRIVER",
    envVar: "NAUTILO_PASSWORD_RECOVERY_DRIVER",
    description:
      "Password recovery mode: oss_relay (self-host no-email), logto_native (real email/passkey/social), or disabled.",
    validator: (v) =>
      ["oss_relay", "logto_native", "disabled"].includes(v.trim().toLowerCase())
        ? null
        : "must be one of: oss_relay, logto_native, disabled",
  },
  {
    id: "NAUTILO_MANAGED_GATEWAY_BASE_URL",
    envVar: "NAUTILO_MANAGED_GATEWAY_BASE_URL",
    description: "Nautilo Gateway API root ending in /v1.",
    validator: (v) => normalizeManagedGatewayBaseUrl(v)
      ? null
      : "must be an HTTPS API root ending in /v1 (HTTP is allowed only for localhost QA)",
  },
  {
    id: "NAUTILO_GATEWAY_BASE_URL",
    envVar: "NAUTILO_GATEWAY_BASE_URL",
    description: "Base URL for a generic OpenAI-compatible chat gateway.",
    validator: (v) => (isHttpUrl(v) ? null : "must be an http(s) URL"),
  },
  {
    id: "NAUTILO_GATEWAY_LABEL",
    envVar: "NAUTILO_GATEWAY_LABEL",
    description: "Display label for the configured OpenAI-compatible gateway.",
    validator: (v) => (v.trim().length > 0 ? null : "required"),
  },
  {
    id: "NAUTILO_SEARCH_PROVIDER",
    envVar: "NAUTILO_SEARCH_PROVIDER",
    description: "Web research provider policy (Tavily-first automatic or keyless DuckDuckGo HTML).",
    validator: (v) => ["auto", "tavily", "duckduckgo_html"].includes(v.trim())
      ? null
      : "must be auto, tavily, or duckduckgo_html",
    default: "auto",
  },
  {
    id: "OPENROUTER_HTTP_REFERER",
    envVar: "OPENROUTER_HTTP_REFERER",
    description:
      "Optional HTTP-Referer header sent to OpenRouter for app attribution (public rankings).",
    validator: (v) => {
      if (/[\r\n]/.test(v)) return "must not contain line breaks";
      const t = v.trim();
      if (t.length === 0) return "must be non-empty when set";
      return isHttpUrl(t) ? null : "must be an http(s) URL";
    },
  },
  {
    id: "OPENROUTER_TITLE",
    envVar: "OPENROUTER_TITLE",
    description:
      "Optional X-OpenRouter-Title header sent to OpenRouter for app attribution (public rankings).",
    validator: (v) => {
      if (/[\r\n]/.test(v)) return "must not contain line breaks";
      return v.trim().length > 0 ? null : "must be non-empty when set";
    },
  },
  // -------------------------------------------------------------------------
  // M071 — default-instance network / compose overrides (see resolveInstance).
  // -------------------------------------------------------------------------
  {
    id: "NAUTILO_INSTANCE_ID",
    envVar: "NAUTILO_INSTANCE_ID",
    description:
      "Named-instance selector: empty = ~/.nautilo; otherwise ~/.nautilo-${id} (lowercase id, see M071 Phase 2A).",
    validator: validateNautiloInstanceIdValue,
  },
  {
    id: "NAUTILO_PORT",
    envVar: "NAUTILO_PORT",
    description: "HTTP server listen port (host-published).",
    validator: validateTcpPort,
  },
  {
    id: "NAUTILO_HOST",
    envVar: "NAUTILO_HOST",
    description: "HTTP server bind address (passed to Fastify listen).",
    validator: validateHostLabel,
  },
  {
    id: "NAUTILO_SERVER_URL",
    envVar: "NAUTILO_SERVER_URL",
    description:
      "Low-level server topology URL override; not the desktop connect target or server advertised-origin setting.",
    validator: validateNautiloServerUrl,
  },
  {
    id: "NAUTILO_WORKBENCH_PORT",
    envVar: "NAUTILO_WORKBENCH_PORT",
    description: "Workbench (Vite) dev server port.",
    validator: validateTcpPort,
  },
  {
    id: "NAUTILO_DB_PORT",
    envVar: "NAUTILO_DB_PORT",
    description: "Host-published Postgres port for local docker compose.",
    validator: validateTcpPort,
  },
  {
    id: "NAUTILO_LOGTO_DB_PORT",
    envVar: "NAUTILO_LOGTO_DB_PORT",
    description: "Host-published Logto Postgres port.",
    validator: validateTcpPort,
  },
  {
    id: "NAUTILO_LOGTO_PORT",
    envVar: "NAUTILO_LOGTO_PORT",
    description: "Host-published Logto core (OIDC) HTTP port.",
    validator: validateTcpPort,
  },
  {
    id: "NAUTILO_LOGTO_ADMIN_PORT",
    envVar: "NAUTILO_LOGTO_ADMIN_PORT",
    description: "Host-published Logto admin console HTTP port.",
    validator: validateTcpPort,
  },
  {
    id: "NAUTILO_FEDERATED_HOSTNAME",
    envVar: "NAUTILO_FEDERATED_HOSTNAME",
    description:
      "RHS hostname for federated ids (`@handle@<this>`), TLS identity, WebFinger.",
    validator: validateHostLabel,
  },
  {
    id: "NAUTILO_MDNS_HOSTNAME",
    envVar: "NAUTILO_MDNS_HOSTNAME",
    description: "mDNS / Bonjour advertisement hostname for LAN discovery.",
    validator: validateHostLabel,
  },
  {
    id: "NAUTILO_TLS_SAN",
    envVar: "NAUTILO_TLS_SAN",
    description:
      "Optional comma-separated TLS subjectAlternativeName hostnames for local dev certs.",
    validator: validateCommaSeparatedHosts,
  },
  {
    id: "NAUTILO_CADDY_AUTH_HOST",
    envVar: "NAUTILO_CADDY_AUTH_HOST",
    description: "Auth stack hostname rendered into local Caddy config.",
    validator: validateHostLabel,
  },
  {
    id: "NAUTILO_CADDY_AUTH_ADMIN_HOST",
    envVar: "NAUTILO_CADDY_AUTH_ADMIN_HOST",
    description: "Logto admin hostname rendered into local Caddy config.",
    validator: validateHostLabel,
  },
  {
    id: "NAUTILO_HOSTNAME",
    envVar: "NAUTILO_HOSTNAME",
    deprecated: true,
    description:
      "Deprecated: use NAUTILO_FEDERATED_HOSTNAME. When set without NAUTILO_FEDERATED_HOSTNAME, merged as the federated hostname (resolveInstance).",
    validator: validateHostLabel,
  },
  {
    id: "NAUTILO_DEPLOYMENT_MODE",
    envVar: "NAUTILO_DEPLOYMENT_MODE",
    description:
      "D112 OSS instance deployment mode (local-self-host, lan-self-host, cloud-managed, dev-multi-instance). Overrides `instance.json` via resolveInstance.",
    validator: (v) => {
      const t = v.trim();
      const allowed = [
        "local-self-host",
        "lan-self-host",
        "cloud-managed",
        "dev-multi-instance",
      ] as const;
      return (allowed as readonly string[]).includes(t)
        ? null
        : `must be one of: ${allowed.join(", ")}`;
    },
  },
  {
    id: "COMPOSE_PROJECT_NAME",
    envVar: "COMPOSE_PROJECT_NAME",
    description:
      "Docker Compose project name (container prefix). Lowercase a–z start; letters, digits, hyphen, underscore.",
    validator: validateComposeProjectName,
  },
  // M116 — deploy-path DB role passwords (random per-instance, see ensureDbPasswords).
  {
    id: "APP_DB_PASSWORD",
    envVar: "APP_DB_PASSWORD",
    description: "Deploy app-postgres superuser password (M116).",
    validator: validateHexPassword,
    redact: true,
  },
  {
    id: "POSTGRES_PASSWORD",
    envVar: "POSTGRES_PASSWORD",
    description: "Deploy logto-postgres superuser password (M116).",
    validator: validateHexPassword,
    redact: true,
  },
  {
    id: "NAUTILO_DB_PASSWORD",
    envVar: "NAUTILO_DB_PASSWORD",
    description: "Deploy nautilo (DB owner) role password (M116).",
    validator: validateHexPassword,
    redact: true,
  },
  {
    id: "LOGTO_DB_PASSWORD",
    envVar: "LOGTO_DB_PASSWORD",
    description: "Deploy logto role password (M116).",
    validator: validateHexPassword,
    redact: true,
  },
  {
    id: "NAUTILO_AGENT_DB_PASSWORD",
    envVar: "NAUTILO_AGENT_DB_PASSWORD",
    description: "Deploy nautilo_agent (RLS-scoped runtime) role password (M116).",
    validator: validateHexPassword,
    redact: true,
  },
  {
    id: "NAUTILO_M116_DB_PASSWORDS_GENERATED_AT",
    envVar: "NAUTILO_M116_DB_PASSWORDS_GENERATED_AT",
    description:
      "M116 sentinel: ISO-8601 timestamp of first random-password generation.",
    validator: validateIso8601Timestamp,
  },
  {
    id: "CLOUDCONVERT_SANDBOX",
    envVar: "CLOUDCONVERT_SANDBOX",
    description:
      "When true, CloudConvert jobs run in sandbox mode (no credit burn). Empty defaults to false.",
    validator: (v) => {
      const t = v.trim();
      if (t.length === 0) return null;
      return t === "true" || t === "false"
        ? null
        : 'must be "true", "false", or empty';
    },
  },
  {
    id: "CLOUDCONVERT_REGION",
    envVar: "CLOUDCONVERT_REGION",
    description:
      "CloudConvert API region pin (us-east or eu-central). Empty lets the SDK auto-select.",
    validator: (v) => {
      const t = v.trim();
      if (t.length === 0) return null;
      return t === "us-east" || t === "eu-central"
        ? null
        : "must be one of: us-east, eu-central, or empty (auto)";
    },
  },
  {
    id: GOOGLE_OAUTH_CLIENT_JSON_ENV,
    envVar: GOOGLE_OAUTH_CLIENT_JSON_ENV,
    description:
      "Base64-encoded Google OAuth client JSON (installed or web credentials) for Workspace integration (M196).",
    validator: validateGoogleOAuthClientJsonBase64Env,
    redact: true,
  },
  // D120 A1.P1 — NAUTILO_DEFAULT_AGENT_ID and NAUTILO_OWNER_ID
  // entries removed. These keys were the D112 Phase 18/19 env-var
  // bridge between `redeem-invite.ts` and the next server boot. D120
  // retires the bridge entirely: the DB is the source of truth
  // (queried via `findClaimedOwnerId` / `findDefaultAgentForOwner` at
  // boot), the bootstrap-state-cache is the runtime read, and the
  // red-team-env-var.sh sweep treats either var appearing in source
  // OR in a per-instance `config.env` as a hard failure. Operators
  // should never set these; config-guard correspondingly stops
  // recognizing them as a managed mode.
];

export function getModeByEnvVar(envVar: string): ModeDefinition | undefined {
  return MODE_REGISTRY.find((m) => m.envVar === envVar);
}

export function getModeById(id: string): ModeDefinition | undefined {
  return MODE_REGISTRY.find((m) => m.id === id);
}

/**
 * Names of every LOGTO_* key in `MODE_REGISTRY` that participates in the
 * cross-key invariant (every Logto OIDC identity key must be set in the
 * merged env). Derived once from the registry to stay in lock-step.
 *
 * **M116 carve-out:** `LOGTO_DB_PASSWORD` is registered in the registry as
 * a deploy-path DB credential, NOT part of the Logto OIDC identity
 * contract. It must NOT participate in `crossKeyInvariants` (instance.env
 * for dev installs has no reason to carry it; only `nautilo deploy`
 * persists it). Excluded explicitly here.
 */
const LOGTO_KEYS_NOT_IN_OIDC_INVARIANT: ReadonlySet<string> = new Set([
  "LOGTO_DB_PASSWORD",
  // D515 is additive during rolling upgrades: old servers remain valid, while
  // Mobile Web fails closed until the next idempotent Logto reconciliation
  // provisions this dedicated SPA id.
  "LOGTO_MOBILE_WEB_APP_ID",
]);

export const LOGTO_REQUIRED_KEYS: readonly string[] = MODE_REGISTRY
  .filter(
    (m) =>
      m.envVar.startsWith("LOGTO_") &&
      !LOGTO_KEYS_NOT_IN_OIDC_INVARIANT.has(m.envVar),
  )
  .map((m) => m.envVar);

/**
 * M091 Phase 4 — keys that must NEVER appear in instance.env (formerly config.env).
 *
 * Two categories:
 *   1. Setup-time-only keys that belong in `~/.nautilo${suffix}/.bootstrap/`
 *      after Phase 5, or in `~/.config/nautilo/deploy.toml`'s `[admin]` block.
 *      Matched by prefix.
 *   2. Retired keys that older installs may still carry on disk.
 *      Matched exactly. The read-side strip writes a `.bak-m091-stale-keys-<ts>`
 *      backup before removing them.
 *
 * The set is the single source of truth for the writer-guard
 * (`validateOperations`) and the read-side strip
 * (`stripRetiredIdentityEnvVars` extended in Phase 4).
 */
export const FORBIDDEN_IN_INSTANCE_ENV_PREFIXES: readonly string[] = [
  "NAUTILO_BOOTSTRAP_",
  "NAUTILO_CLAIM_INVITE_",
  "NAUTILO_ADMIN_",
];

export const FORBIDDEN_IN_INSTANCE_ENV_EXACT: ReadonlySet<string> = new Set([
  "AUTH_MODE",
  "NAUTILO_OWNER_ID",
  "NAUTILO_DEFAULT_AGENT_ID",
  "NAUTILO_OWNER_ACTOR_ID",
  "NAUTILO_CRYPTO_DB_PASSWORD",
]);

/** Carve-out: NAUTILO_BOOTSTRAP_TOKEN is a runtime substrate bearer (D120 A5),
 * NOT one of the per-instance bootstrap-row prefixes. It legitimately lives in
 * instance.env in cloud mode. The prefix `NAUTILO_BOOTSTRAP_` would match it,
 * so allow this exact name through.
 */
const FORBIDDEN_PREFIX_CARVE_OUTS: ReadonlySet<string> = new Set([
  "NAUTILO_BOOTSTRAP_TOKEN",
]);

export interface ForbiddenInstanceEnvReason {
  category: "setup-time-only" | "retired";
  remediation: string;
}

export function classifyForbiddenInInstanceEnv(
  key: string,
): ForbiddenInstanceEnvReason | null {
  if (FORBIDDEN_PREFIX_CARVE_OUTS.has(key)) return null;

  for (const prefix of FORBIDDEN_IN_INSTANCE_ENV_PREFIXES) {
    if (key.startsWith(prefix)) {
      return {
        category: "setup-time-only",
        remediation:
          "write to ~/.nautilo${suffix}/.bootstrap/ (Phase 5) or ~/.config/nautilo/deploy.toml [admin] (Phase 3) instead",
      };
    }
  }

  if (FORBIDDEN_IN_INSTANCE_ENV_EXACT.has(key)) {
    if (key === "NAUTILO_CRYPTO_DB_PASSWORD") {
      return {
        category: "setup-time-only",
        remediation:
          "persist it in the role-only .bootstrap credential authority; never mount it into the Nautilo server",
      };
    }
    return {
      category: "retired",
      remediation:
        "this key was retired by a prior milestone (M072 / D120) and must not appear in instance.env",
    };
  }

  return null;
}

export function isForbiddenInInstanceEnv(key: string): boolean {
  return classifyForbiddenInInstanceEnv(key) !== null;
}
