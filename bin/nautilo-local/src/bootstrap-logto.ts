/**
 * M051 (Logto cluster): one-shot bootstrap script.
 *
 * Runs once on first boot when `--with-logto` is passed and the Logto
 * Postgres database has just been seeded by `logto-seed`. Owns the
 * whole "make Logto admin-console-ready without a browser wizard" flow.
 *
 * Algorithm (canonical: `research/logto-integration-v1.md` §7.6;
 * issue M051 Phase 5b):
 *
 *  1. Wait until ${LOGTO_ENDPOINT}/oidc/.well-known/openid-configuration
 *     returns 200.
 *  2. Connect to Postgres via the LOGTO_DB credentials and read the
 *     m-admin Machine-to-Machine app's plaintext secret. This is the
 *     ONE step that bypasses Logto's HTTP API.
 *  3. Detect already-bootstrapped state via
 *     `SELECT sign_in_mode FROM sign_in_experiences WHERE tenant_id='admin'`.
 *     If 'SignIn' → exit 0 with "already bootstrapped" log. Idempotent.
 *  4. PATCH /api/sign-in-exp on both tenants disabling pwned-password
 *     check (offline-mode safety, see §7.6.1).
 *  4b. D104 Phase 5 — default tenant: reconcile hosted sign-in branding
 *      (Nautilo colors + self-hosted recovery copy in customCss) via
 *      GET/PATCH /api/sign-in-exp; idempotent; preserves operator CSS
 *      outside Nautilo sentinels. Canonical tokens: @nautilo/config.
 *  5. Mint M2M token for `resource=https://admin.logto.app/api`.
 *  6-9. Create admin-console user, add to t-default org with admin
 *       role, assign every system user role.
 * 10. PATCH /api/sign-in-exp (admin) to flip `signInMode` to "SignIn"
 *     so subsequent admin-console hits get a sign-in page, not the
 *     welcome wizard. After this point, step 3's idempotency check
 *     fires on re-runs.
 * 11. Mint M2M token for `resource=https://default.logto.app/api`.
 * 12. In the default tenant: create the SPA + Native + M2M apps,
 *     register the API resource (no scopes), seed RBAC org roles.
 * 13. Write the resulting LOGTO_* block to ~/.nautilo/instance.env via
 *     config-guard's transactional writer.
 * 14. Print a one-time boxed banner with admin URL + username +
 *     password. Exit 0.
 *
 * Per-object idempotency: every POST /api/applications,
 * /api/resources, and /api/organization-roles is preceded by a search
 * to avoid duplicates if the script crashes mid-flight (between steps
 * 6 and 13, before step 10 flips sign_in_mode).
 *
 * Reference implementation: appthrust/logto-admin-creator (steps 1-10).
 * Steps 11-14 are Nautilo-specific.
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import postgresImport from "postgres";
import {
  resolveInstance,
  resolveInstanceUncached,
  resolveNautiloRootDir,
  type ResolvedInstance,
} from "@nautilo/config";
import { isLoopbackHostname } from "@nautilo/config/loopback-origin";
import { resolveDotenvPath, transaction as transactionImport } from "@nautilo/config-guard";
import { log, warn } from "@nautilo/logger";
import { computeLogtoHostedBrandingReconcilePatch } from "./logto-hosted-auth-branding";
import {
  computeForgotPasswordRelayPlan,
  type LogtoConnectorRow,
} from "./logto-forgot-password-relay";

// ---------------------------------------------------------------------
// Pure helpers — no I/O, exhaustively unit-testable.
// ---------------------------------------------------------------------

export interface LogtoConfig {
  endpoint: string;
  workbenchAppId: string;
  tuiAppId: string;
  /** M102 — legacy-named Native app used by CLI loopback PKCE. */
  tuiLoopbackAppId: string;
  /** M055: Native app for Electron loopback PKCE (RFC 8252 §7.3). */
  desktopAppId: string;
  /** M199: Native app for the mobile (Expo) client — custom-scheme PKCE (nautilo://callback), public client, no secret. */
  mobileAppId: string;
  /** D515: SPA app for Mobile Web — exact current-origin /mobile/callback, public client, no secret. */
  mobileWebAppId: string;
  m2mAppId: string;
  m2mAppSecret: string;
  /** API resource indicator. Used as the OIDC `audience` claim. */
  resource: string;
}

export const OSS_RELAY_FORGOT_PASSWORD_CUSTOM_PHRASES_EN = {
  description: {
    verify_email: "Enter verification code",
    enter_passcode: "Enter the verification code shown in Nautilo for {{target}}.",
  },
} as const;

/**
 * M064 — body for `PATCH /api/account-center` on the Logto default tenant
 * (enables Account Center password self-service for retained clients).
 */
export const ACCOUNT_CENTER_ENABLE_PATCH_BODY = {
  enabled: true,
  fields: { password: "Edit" as const },
} as const;

/**
 * M107 Phase 1b — canonical `PATCH /api/sign-in-exp` body that flips the
 * default tenant to username-based sign-in / sign-up. Sent unconditionally
 * on every bootstrap so:
 *   - fresh installs land in username-mode out of the gate (no email
 *     prompt the user has no way to satisfy on a local single-household
 *     install with no SMTP);
 *   - upgrade installs that pre-date M107 are auto-flipped on next boot.
 *
 * Shape verified against Logto OSS 1.38.0 in Phase 0 — see
 * `playbook/logto-operations.md` "M107 Phase 0" addendum. Unrelated SIE
 * fields (`color`, `branding`, `customCss`, `passwordPolicy`, …) are
 * preserved by Logto's per-key merge on PATCH.
 *
 * The same constant is consumed by `bin/nautilo-dev migrate-to-username-identity
 * --apply` so the migration path and the boot path always send identical
 * bodies.
 */
export const SIGN_IN_EXP_USERNAME_PATCH_BODY = {
  signIn: {
    methods: [
      {
        identifier: "username",
        password: true,
        verificationCode: false,
        isPasswordPrimary: true,
      },
    ],
  },
  signUp: {
    identifiers: ["username"],
    password: true,
    verify: false,
  },
} as const;

/** Names of the Logto values bootstrap persists to the instance environment. */
export const LOGTO_ENV_KEY_NAMES = [
  "LOGTO_ENDPOINT",
  "LOGTO_ISSUER",
  "LOGTO_JWKS_URI",
  "LOGTO_RESOURCE",
  "LOGTO_WORKBENCH_APP_ID",
  "LOGTO_TUI_APP_ID",
  "LOGTO_TUI_LOOPBACK_APP_ID",
  "LOGTO_DESKTOP_APP_ID",
  "LOGTO_MOBILE_APP_ID",
  "LOGTO_MOBILE_WEB_APP_ID",
  "LOGTO_M2M_APP_ID",
  "LOGTO_M2M_APP_SECRET",
] as const;

/**
 * Build config-guard `set` operations for the `LOGTO_*` keys handed to
 * `transaction()`. Pulled out so a unit test can confirm the key set without
 * standing up Logto.
 *
 * M055 added LOGTO_DESKTOP_APP_ID for the Electron Native app. M102 adds
 * LOGTO_TUI_LOOPBACK_APP_ID (legacy-named CLI loopback PKCE sibling to device-flow
 * LOGTO_TUI_APP_ID). M072 removed the legacy auth-mode config-guard set-op —
 * that registry entry is gone post-rip and config-guard rejects unknown keys.
 */
export function buildLogtoEnvOperations(
  cfg: LogtoConfig,
): Array<{ type: "set"; key: string; value: string }> {
  return [
    { type: "set", key: LOGTO_ENV_KEY_NAMES[0], value: cfg.endpoint },
    { type: "set", key: LOGTO_ENV_KEY_NAMES[1], value: `${cfg.endpoint}/oidc` },
    { type: "set", key: LOGTO_ENV_KEY_NAMES[2], value: `${cfg.endpoint}/oidc/jwks` },
    { type: "set", key: LOGTO_ENV_KEY_NAMES[3], value: cfg.resource },
    { type: "set", key: LOGTO_ENV_KEY_NAMES[4], value: cfg.workbenchAppId },
    { type: "set", key: LOGTO_ENV_KEY_NAMES[5], value: cfg.tuiAppId },
    { type: "set", key: LOGTO_ENV_KEY_NAMES[6], value: cfg.tuiLoopbackAppId },
    { type: "set", key: LOGTO_ENV_KEY_NAMES[7], value: cfg.desktopAppId },
    { type: "set", key: LOGTO_ENV_KEY_NAMES[8], value: cfg.mobileAppId },
    { type: "set", key: LOGTO_ENV_KEY_NAMES[9], value: cfg.mobileWebAppId },
    { type: "set", key: LOGTO_ENV_KEY_NAMES[10], value: cfg.m2mAppId },
    { type: "set", key: LOGTO_ENV_KEY_NAMES[11], value: cfg.m2mAppSecret },
  ];
}

/** Public SPA ids may be newly projected while preserving copied Logto state. */
export function buildPreservedProjectionEnvOperations(input: {
  readonly workbenchAppId: string;
  readonly mobileWebAppId: string;
}): Array<{ type: "set"; key: string; value: string }> {
  return [
    { type: "set", key: "LOGTO_WORKBENCH_APP_ID", value: input.workbenchAppId },
    { type: "set", key: "LOGTO_MOBILE_WEB_APP_ID", value: input.mobileWebAppId },
  ];
}

type ConfigGuardTransaction = (input: {
  operations: ReturnType<typeof buildLogtoEnvOperations>;
  healthCheck: "none";
  overwrite: boolean;
  reason: string;
  actor: "cli";
}) => Promise<{ success: boolean; error?: string | null }>;

const runConfigTransaction =
  transactionImport as unknown as ConfigGuardTransaction;

export interface BootstrapBannerInput {
  adminUrl: string;
  username: string;
  envPath: string;
  passwordPolicyDisabled: boolean;
}

/**
 * Boxed banner the script prints once, at exit. The admin password is stored
 * only in the mode-0600 credential file, never echoed into terminal logs.
 */
export function formatBootstrapBanner(input: BootstrapBannerInput): string {
  const width = 64;
  const hr = "=".repeat(width);
  const lines: string[] = [
    "",
    hr,
    "Logto bootstrap complete",
    hr,
    "",
    `  Admin console : ${input.adminUrl}`,
    `  Username      : ${input.username}`,
    `  Credential    : ${join(dirname(input.envPath), LOGTO_ADMIN_CREDENTIAL_FILENAME)}`,
    "                  (mode 0600; contains the generated admin password)",
    "",
    `  instance.env  : ${input.envPath}`,
    "                  (LOGTO_* keys written via config-guard)",
    "",
  ];
  if (input.passwordPolicyDisabled) {
    lines.push(
      "  NOTE: pwned-password check disabled on this Logto instance",
    );
    lines.push("        (offline safety). Re-enable from the admin console");
    lines.push("        if this box is internet-connected.");
    lines.push("");
  }
  lines.push(
    "  NOTE: compose containers stay running on Ctrl+C. Stop them",
  );
  lines.push("        explicitly with `docker compose down`.");
  lines.push("");
  lines.push(hr);
  lines.push("");
  return lines.join("\n");
}

/**
 * M059 — admin-console credential file.
 *
 * Written ONCE during first-time bootstrap (the same branch that mints
 * the admin password) so the operator has a known location to retrieve
 * the password when they need to log into `:3302/console` later (un-
 * suspend a user, send password reset, rotate keys, review devices).
 *
 * Idempotency: the helper SKIPS the write if the target file already
 * exists. This is deliberate — a re-bootstrap that hits the
 * `runFirstTimeAdminProvisioning` branch (e.g. operator deleted Logto's
 * postgres volume) DOES generate a fresh password, but if the file is
 * already on disk we assume the operator may have rotated the password
 * post-bootstrap and we don't want to overwrite their record. Operators
 * who genuinely want a fresh write should delete the file first.
 *
 * Mode 0600: temp file created with `mode: 0o600`, `renameSync` into
 * place, then `chmodSync` (defense-in-depth after replace-on-rename).
 *
 * Pure helper for unit tests — consumers inject their own writer.
 */
export const LOGTO_ADMIN_CREDENTIAL_FILENAME = "logto-admin.txt";

export interface LogtoAdminCredentialDeps {
  /** Returns the absolute target path. Default: `<resolved instance root>/logto-admin.txt`. */
  resolvePath?: () => string;
  /** Existence probe; default `existsSync`. */
  exists?: (path: string) => boolean;
  /** Atomic writer; default temp+rename with mode 0o600 + chmod. */
  writeFile?: (path: string, contents: string) => void;
  /** ISO timestamp for the `Created:` header line. Default: `new Date().toISOString()`. */
  isoStamp?: () => string;
  /** Logger; default `log` from `@nautilo/logger`. */
  log?: (msg: string) => void;
}

export interface LogtoAdminCredentialInput {
  username: string;
  password: string;
  /** Admin console URL (admin tenant, port 3302 in dev). */
  adminUrl: string;
}

/**
 * Returns the formatted file body. Pure — exported so unit tests can
 * assert on the operator-facing format without spying on the writer.
 */
export function formatLogtoAdminCredentialFile(
  input: LogtoAdminCredentialInput,
  isoStamp: string,
): string {
  return [
    "# Logto admin console credential",
    `# Console: ${input.adminUrl}`,
    `# Created: ${isoStamp}`,
    `username: ${input.username}`,
    `password: ${input.password}`,
    "",
    "# Rotate after first login via the console.",
    "# Safe to delete once you've changed the password.",
    "",
  ].join("\n");
}

/**
 * Idempotent writer. Returns true if a NEW file was written, false if
 * an existing file was preserved (idempotency probe hit).
 */
export function ensureLogtoAdminCredentialFile(
  input: LogtoAdminCredentialInput,
  deps: LogtoAdminCredentialDeps = {},
): boolean {
  const resolvePath =
    deps.resolvePath ??
    (() => join(resolveNautiloRootDir(), LOGTO_ADMIN_CREDENTIAL_FILENAME));
  const exists = deps.exists ?? ((p) => existsSync(p));
  const writeFile = deps.writeFile ?? defaultAtomicWriter;
  const isoStamp = deps.isoStamp ?? (() => new Date().toISOString());
  const logger = deps.log ?? log;

  const target = resolvePath();
  if (exists(target)) {
    logger(
      `[bootstrap-logto] ${target} already exists; preserving (delete first if you want a fresh write).`,
    );
    return false;
  }
  const contents = formatLogtoAdminCredentialFile(input, isoStamp());
  writeFile(target, contents);
  logger(`[bootstrap-logto] admin credential written to ${target} (chmod 600)`);
  return true;
}

function defaultAtomicWriter(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, contents, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
  // Belt-and-suspenders: some FS ignore mode when replacing via rename.
  chmodSync(path, 0o600);
}

/** Generated default-tenant object names. Fixed strings, exported for tests. */
export const APP_NAMES = {
  workbench: "Nautilo Workbench",
  tui: "Nautilo TUI",
  /** M102 — legacy-named loopback PKCE Native app; device-flow stays on `tui`. */
  tuiLoopback: "Nautilo TUI (loopback)",
  m2m: "Nautilo Server",
  /**
   * M055 — separate Native app for Electron's loopback PKCE flow.
   * Logto OSS only honours RFC 8252 §7.3 port-flex on `127.0.0.1`
   * for `type: "Native"` apps; the Workbench SPA app rejects
   * port-specific URIs even when the bare `http://127.0.0.1/callback`
   * is registered. So Electron gets its own Native app id.
   */
  desktop: "Nautilo Desktop",
  /**
   * M199 — Native app for the mobile (Expo / React Native) client's
   * custom-scheme PKCE flow. A phone can't host a loopback HTTP server
   * like Electron (RFC 8252 §7.3), so mobile uses a custom URL scheme
   * (`nautilo://callback`) instead of `http://127.0.0.1/callback`.
   */
  mobile: "Nautilo Mobile",
  /** D515 — browser SPA kept separate from native and Workbench custody. */
  mobileWeb: "Nautilo Mobile Web",
} as const;

export const ORG_ROLES_TO_SEED = [
  "owner",
  "household",
  "teammate",
  "guest",
] as const;

/** Fixed display name for the instance-specific Logto API resource. */
export const LOGTO_RESOURCE_NAME = "Nautilo API";

const BROWSER_LOOPBACK_REDIRECT_HOSTS = [
  "localhost",
  "127.0.0.1",
  "[::1]",
] as const;

/** Paths registered for each instance-derived Workbench browser origin. */
export const WORKBENCH_OIDC_REDIRECT_PATHS = [
  "/auth/callback",
  "/settings/security",
] as const;

/** Paths registered for each instance-derived Workbench logout origin. */
export const WORKBENCH_POST_LOGOUT_REDIRECT_PATHS = ["", "/logout", "/claim"] as const;

export const MOBILE_WEB_OIDC_REDIRECT_PATH = "/mobile/callback";
export const MOBILE_WEB_POST_LOGOUT_PATH = "/mobile";

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function browserLoopbackAliasOrigins(rawOrigin: string): string[] {
  const origin = new URL(rawOrigin).origin;
  const parsed = new URL(origin);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !isLoopbackHostname(parsed.hostname)
  ) {
    return [origin];
  }

  return BROWSER_LOOPBACK_REDIRECT_HOSTS.map((host) => {
    const port = parsed.port ? `:${parsed.port}` : "";
    return `${parsed.protocol}//${host}${port}`;
  });
}

function deriveWorkbenchBrowserOrigins(instance: ResolvedInstance): string[] {
  return uniqueStrings([
    ...browserLoopbackAliasOrigins(instance.server.url),
    ...browserLoopbackAliasOrigins(instance.workbench.url),
  ]);
}

/**
 * M071 / 1D.1 — Workbench SPA `redirectUris` derived from `resolveInstance()`.
 * Covers Bun server + Vite dev server (`bun run gui`) callback URLs.
 * D152 smoke follow-up also registers the settings step-up target used by
 * the recovery-code re-auth flow.
 *
 * D230 — local browser SPA redirects are still exact registrations, but
 * the default instance may be reached as localhost, 127.0.0.1, or [::1].
 * Register each concrete loopback alias; do not use wildcards or pattern
 * matching.
 */
export function deriveWorkbenchOidcRedirectUris(
  instance: ResolvedInstance,
): readonly string[] {
  return deriveWorkbenchBrowserOrigins(instance).flatMap((origin) =>
    WORKBENCH_OIDC_REDIRECT_PATHS.map((path) => new URL(path, origin).href),
  );
}

/**
 * M071 / 1D.1 — Workbench SPA `postLogoutRedirectUris` from server + workbench origins.
 */
export function deriveWorkbenchPostLogoutRedirectUris(
  instance: ResolvedInstance,
): readonly string[] {
  return deriveWorkbenchBrowserOrigins(instance).flatMap((origin) =>
    WORKBENCH_POST_LOGOUT_REDIRECT_PATHS.map((path) =>
      path === "" ? origin : `${origin}${path}`,
    ),
  );
}

/** Exact server-origin registrations for the separately identified Mobile Web SPA. */
export function deriveMobileWebOidcRedirectUris(
  instance: ResolvedInstance,
): readonly string[] {
  return browserLoopbackAliasOrigins(instance.server.url).map((origin) =>
    new URL(MOBILE_WEB_OIDC_REDIRECT_PATH, origin).href,
  );
}

export function deriveMobileWebPostLogoutRedirectUris(
  instance: ResolvedInstance,
): readonly string[] {
  return browserLoopbackAliasOrigins(instance.server.url).map((origin) =>
    new URL(MOBILE_WEB_POST_LOGOUT_PATH, origin).href,
  );
}

/**
 * M071 / 1D.2 — Pure additive merge for Logto `oidcClientMetadata` redirect lists.
 * Matches the set-union shape `ensureApp` PATCHes when an application already exists.
 */
export function computeOidcUriUnionPatch(
  currentRedirectUris: readonly string[],
  currentPostLogoutRedirectUris: readonly string[],
  desiredRedirectUris: readonly string[],
  desiredPostLogoutRedirectUris: readonly string[],
): {
  missingRedirects: string[];
  missingPostLogout: string[];
  mergedRedirectUris: string[];
  mergedPostLogoutRedirectUris: string[];
} {
  const missingRedirects = desiredRedirectUris.filter(
    (u) => !currentRedirectUris.includes(u),
  );
  const missingPostLogout = desiredPostLogoutRedirectUris.filter(
    (u) => !currentPostLogoutRedirectUris.includes(u),
  );
  return {
    missingRedirects,
    missingPostLogout,
    mergedRedirectUris: [...currentRedirectUris, ...missingRedirects],
    mergedPostLogoutRedirectUris: [
      ...currentPostLogoutRedirectUris,
      ...missingPostLogout,
    ],
  };
}

export function computeOidcUriRebindPatch(
  currentRedirectUris: readonly string[],
  currentPostLogoutRedirectUris: readonly string[],
  desiredRedirectUris: readonly string[],
  desiredPostLogoutRedirectUris: readonly string[],
  removedRedirectUris: readonly string[],
  removedPostLogoutRedirectUris: readonly string[],
): ReturnType<typeof computeOidcUriUnionPatch> & {
  removedRedirects: string[];
  removedPostLogout: string[];
} {
  const desiredRedirectSet = new Set(desiredRedirectUris);
  const desiredPostLogoutSet = new Set(desiredPostLogoutRedirectUris);
  const removeRedirectSet = new Set(removedRedirectUris);
  const removePostLogoutSet = new Set(removedPostLogoutRedirectUris);
  const removedRedirects = currentRedirectUris.filter(
    (uri) => removeRedirectSet.has(uri) && !desiredRedirectSet.has(uri),
  );
  const removedPostLogout = currentPostLogoutRedirectUris.filter(
    (uri) => removePostLogoutSet.has(uri) && !desiredPostLogoutSet.has(uri),
  );
  const retainedRedirects = currentRedirectUris.filter(
    (uri) => !removedRedirects.includes(uri),
  );
  const retainedPostLogout = currentPostLogoutRedirectUris.filter(
    (uri) => !removedPostLogout.includes(uri),
  );
  return {
    ...computeOidcUriUnionPatch(
      retainedRedirects,
      retainedPostLogout,
      desiredRedirectUris,
      desiredPostLogoutRedirectUris,
    ),
    removedRedirects,
    removedPostLogout,
  };
}

/**
 * M055 — Electron Native app's redirect URI. Logto OSS honours RFC
 * 8252 §7.3 port-flex on `127.0.0.1` for Native apps, so the
 * port-less form covers every per-launch loopback port the desktop
 * spins up.
 */
export const DESKTOP_REDIRECT_URIS = [
  "http://127.0.0.1/callback",
] as const;

/**
 * M102 — Native app redirect URI for CLI loopback PKCE.
 * The legacy-named device-flow app (`Nautilo TUI`) cannot host this grant because
 * `customClientMetadata.isDeviceFlow=true` makes it device-flow-only —
 * Logto OSS sets `response_types=[]` on those clients. So the M102 CLI
 * loopback path needs a second Native app, exactly mirroring the Electron
 * Desktop pattern.
 */
export const TUI_LOOPBACK_REDIRECT_URIS = [
  "http://127.0.0.1/callback",
] as const;

/**
 * M057 + M102 — redirect URIs for the legacy-named **device-flow** Native app only.
 *
 * Device flow (RFC 8628) does not use a browser redirect, but Logto OSS
 * validates `redirect_uris.length >= 1` before issuing a device code.
 * The placeholder satisfies that structural check (M057).
 *
 * M102 CLI loopback PKCE uses a **separate** legacy-named app (`Nautilo TUI (loopback)` +
 * `TUI_LOOPBACK_REDIRECT_URIS`) — never register `http://127.0.0.1/callback`
 * on the device-flow client: Logto rejects `response_type=code` there.
 *
 * Reconciliation note: older bootstraps may have merged
 * `http://127.0.0.1/callback` onto this app before M102 split that URI out.
 * Leaving that orphan registered is harmless (unused); do not add a stripper.
 */
export const TUI_REDIRECT_URIS = [
  "http://127.0.0.1/tui-device-flow-placeholder",
] as const;

export const DESKTOP_POST_LOGOUT_REDIRECT_URIS = [
  "http://127.0.0.1/logout",
  "http://127.0.0.1",
] as const;

/**
 * M199 — Mobile (Expo) Native app redirect URI. A native app has no
 * origin; the OS routes a custom URL scheme back to the app (the mobile
 * equivalent of desktop's loopback redirect). Static across every Nautilo
 * server so the bootstrap seed registers it without per-server knowledge.
 * Must match the redirect `expo-auth-session` produces in D369.
 */
export const MOBILE_REDIRECT_URIS = ["nautilo://callback"] as const;

export const MOBILE_POST_LOGOUT_REDIRECT_URIS = [
  "nautilo://sign-out",
] as const;

// M060 — `customClientMetadata.alwaysIssueRefreshToken` was the
// initial Phase 2 candidate for re-enabling refresh-token issuance,
// but Logto core source `oidc/init.ts:212-221` reveals it ONLY applies
// to `applicationType === 'web'` (i.e. Traditional). For our Native
// Native (Desktop and legacy-named CLI clients) and SPA (Workbench) apps the flag is a no-op.
//
// The actual Phase 2 fix lives in the CLIENT layer:
// `apps/desktop/electron/auth/sign-in.ts` and
// The CLI device-flow client sets `prompt=consent` on the
// authorize / device-auth requests. Without it, Logto's first-party
// auto-consent path drops `offline_access` from the authorization
// code's granted scopes and `code.scopes.has('offline_access')` is
// false, so `issueRefreshToken` returns false. `@logto/client` (used
// by `@logto/react` in the browser) already defaults `prompt` to
// `Consent`, so the workbench path needs no change.
//
// PATCH semantics for `customClientMetadata` are still REPLACE-style
// (sending `{a:1}` overwrites and drops sibling keys), so the
// `mergeCustomClientMetadata` helper below stays useful for any future
// non-web flag (e.g. `rotateRefreshToken: false` for testing).

// ---------------------------------------------------------------------
// HTTP + Postgres I/O.
// ---------------------------------------------------------------------

export interface BootstrapOptions {
  /** Logto core URL. Defaults to env LOGTO_ENDPOINT or http://localhost:3301. */
  endpoint?: string;
  /** Admin-tenant API URL; remote compose supplies its SSH-forwarded loopback port. */
  adminEndpoint?: string;
  /** Default-tenant API URL; remote compose supplies its SSH-forwarded core port. */
  defaultTenantEndpoint?: string;
  /** API resource indicator. Defaults to env LOGTO_RESOURCE. */
  resource?: string;
  /** Postgres connection URL for the logto_nautilo DB. */
  postgresUrl?: string;
  /**
   * Where the LOGTO_* keys end up. Set via config-guard's transactional
   * writer; the path is determined by `resolveDotenvPath()`. Surfaced
   * for the boxed banner.
   */
  envPath?: string;
  /** Override discovery-poll deadline. Default 60s. */
  discoveryTimeoutMs?: number;
  /**
   * M117 — extra `redirectUris` to register on the Workbench SPA app
   * (set-union with `deriveWorkbenchOidcRedirectUris(instance)`).
   *
   * For `https=letsencrypt` deploys, the public URL is the LE domain
   * (e.g. `https://nautilo.example.test/auth/callback`) and is unknown to
   * `resolveInstance()` (which only carries operator-side LAN URLs).
   * The compose-driver wrapper (`bootstrapLogtoForProfile`) computes
   * these from `profile.domain` and passes them in.
   *
   * The `ensureApp` reconciler does set-union PATCH, so re-deploys
   * pick up new URIs additively without disturbing existing ones.
   */
  extraWorkbenchRedirectUris?: readonly string[];
  /** M117 — extra `postLogoutRedirectUris` for the Workbench SPA app. */
  extraWorkbenchPostLogoutUris?: readonly string[];
  /** D515 — exact public server-origin Mobile Web callback registrations. */
  extraMobileWebRedirectUris?: readonly string[];
  /** D515 — exact public server-origin Mobile Web logout registrations. */
  extraMobileWebPostLogoutUris?: readonly string[];
  /**
   * Restore-only, request-memory authority for replacing Nautilo-managed
   * Workbench origins. It never removes unrelated operator-managed URIs.
   */
  managedWorkbenchOriginReplacement?: ManagedWorkbenchOriginReplacement;
  /**
   * M120 — when set, configure Logto's `http-email` connector to deliver the
   * native ForgotPassword email code to Nautilo's webhook, and enable the
   * `EmailVerificationCode` forgot-password method. `webhookEndpoint` is the
   * URL Logto POSTs to (compose deploys use container DNS,
   * `http://nautilo-server:3001/api/internal/logto/email-webhook`);
   * `webhookSecret` is sent verbatim as `Authorization: Bearer <secret>` and
   * must match the server's `NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET`.
   * Omitted → the relay is left unconfigured (M120 disabled for this deploy).
   */
  forgotPasswordRelay?: {
    webhookEndpoint: string;
    webhookSecret: string;
  };
  /**
   * M120 / deploy-mode hosted reset: where Logto should send direct hosted UI
   * hits / unknown sessions. Compose-deployed Workbench is served by the
   * Nautilo server, so callers should pass `resolveInstance().server.url`.
   * Omitted keeps the historical local-dev Vite target.
   */
  unknownSessionRedirectUrl?: string;
  /**
   * A full development clone already contains provisioned Logto state.
   * Reconcile only the target-owned Workbench redirect projections and leave
   * sign-in experience, branding, connectors, resources, and roles untouched.
   */
  preserveProvisionedState?: boolean;
  /**
   * Hosted drivers receive the reconciled configuration in memory instead of
   * writing an operator-local instance.env. The callback must not log it.
   */
  persistConfig?: (config: LogtoConfig) => Promise<void>;
  /** Hosted bootstrap has no durable operator filesystem for this credential. */
  persistAdminCredential?: boolean;
}

export interface ManagedWorkbenchOriginReplacement {
  readonly sourceOrigin: string;
  readonly targetOrigin: string;
}

export class ManagedWorkbenchOriginReplacementError extends Error {
  constructor() {
    super("Managed Workbench origin replacement is invalid");
    this.name = "ManagedWorkbenchOriginReplacementError";
  }
}

function canonicalHttpsOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 || value.trim() !== value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.search === "" && url.hash === ""
      && url.hostname.length > 0 && url.pathname === "/" && value === url.origin ? value : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeManagedWorkbenchOriginReplacement(
  value: ManagedWorkbenchOriginReplacement,
): ManagedWorkbenchOriginReplacement {
  const sourceOrigin = canonicalHttpsOrigin(value.sourceOrigin);
  const targetOrigin = canonicalHttpsOrigin(value.targetOrigin);
  if (sourceOrigin === undefined || targetOrigin === undefined || sourceOrigin === targetOrigin) {
    throw new ManagedWorkbenchOriginReplacementError();
  }
  return Object.freeze({ sourceOrigin, targetOrigin });
}

export function deriveManagedWorkbenchOriginUris(origin: string): {
  readonly redirectUris: readonly string[];
  readonly postLogoutRedirectUris: readonly string[];
} {
  const canonical = canonicalHttpsOrigin(origin);
  if (canonical === undefined) throw new ManagedWorkbenchOriginReplacementError();
  return Object.freeze({
    redirectUris: Object.freeze(
      WORKBENCH_OIDC_REDIRECT_PATHS.map((path) => `${canonical}${path}`),
    ),
    postLogoutRedirectUris: Object.freeze(
      WORKBENCH_POST_LOGOUT_REDIRECT_PATHS.map((path) => `${canonical}${path}`),
    ),
  });
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

async function waitForOidcDiscovery(
  endpoint: string,
  timeoutMs: number,
): Promise<void> {
  const url = `${endpoint}/oidc/.well-known/openid-configuration`;
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, DEFAULT_POLL_INTERVAL_MS));
  }
  throw new Error(
    `Logto discovery doc never returned 200 within ${timeoutMs}ms: ${String(lastErr)}`,
  );
}

interface SeededM2mCredentials {
  /** Plaintext secret of the seeded `m-admin` app (manages admin tenant). */
  mAdminSecret: string;
  /**
   * Plaintext secret of the seeded `m-default` app. Logto OSS seeds BOTH
   * m-admin (admin-tenant Mgmt API) AND m-default (default-tenant Mgmt
   * API) — that's how programmatic default-tenant setup works without an
   * operator-mediated welcome wizard. m-default lives in the admin
   * tenant but mints tokens with `aud=https://default.logto.app/api`,
   * which the core port (:3301) accepts and routes to default-tenant
   * Management API.
   */
  mDefaultSecret: string;
}

interface ProbeResult {
  alreadyBootstrapped: boolean;
  credentials: SeededM2mCredentials;
}

type SqlClient = {
  <T extends readonly Record<string, unknown>[]>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
  end(options?: { timeout?: number }): Promise<void>;
};

const createSqlClient = postgresImport as unknown as (
  postgresUrl: string,
  options: { max: number; idle_timeout: number; connect_timeout?: number },
) => SqlClient;

async function probeAdminSignInMode(
  postgresUrl: string,
): Promise<string | undefined> {
  const sql = createSqlClient(postgresUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 5,
  });
  try {
    await sql`SET statement_timeout = 5000`;
    const modeRows = await sql<Array<{ sign_in_mode: string }>>`
      SELECT sign_in_mode FROM sign_in_experiences WHERE tenant_id = 'admin'
    `;
    return modeRows[0]?.sign_in_mode;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function probePostgres(postgresUrl: string): Promise<ProbeResult> {
  const sql = createSqlClient(postgresUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 5,
  });
  try {
    await sql`SET statement_timeout = 5000`;
    // Step 2: read both seeded M2M secrets (plaintext in `applications`).
    const secretRows = await sql<Array<{ id: string; secret: string }>>`
      SELECT id, secret FROM applications WHERE id IN ('m-admin', 'm-default')
    `;
    const byId = new Map(secretRows.map((r) => [r.id, r.secret]));
    const mAdminSecret = byId.get("m-admin");
    const mDefaultSecret = byId.get("m-default");
    if (!mAdminSecret || !mDefaultSecret) {
      throw new Error(
        `seeded M2M apps missing — m-admin: ${Boolean(mAdminSecret)}, m-default: ${Boolean(mDefaultSecret)}; logto-seed may not have run`,
      );
    }
    // Step 3: idempotency probe.
    const modeRows = await sql<Array<{ sign_in_mode: string }>>`
      SELECT sign_in_mode FROM sign_in_experiences WHERE tenant_id = 'admin'
    `;
    const mode = modeRows[0]?.sign_in_mode;
    return {
      alreadyBootstrapped: mode === "SignIn",
      credentials: { mAdminSecret, mDefaultSecret },
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

/** Max attempts + backoff ceiling for the transient-tolerant token mint. */
export const TOKEN_MINT_MAX_ATTEMPTS = 6;
const TOKEN_MINT_BACKOFF_CEILING_MS = 8_000;
const TOKEN_MINT_REQUEST_TIMEOUT_MS = 10_000;

export async function mintM2mToken(
  endpoint: string,
  clientId: string,
  clientSecret: string,
  resource: string,
  // Injectable backoff sleep — defaults to real timers; tests pass a no-op
  // so the retry path can be exercised without wall-clock delays.
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    resource,
    scope: "all",
  });
  // Bounded retry/backoff. Right after the stack (re)starts, Logto can
  // transiently close the socket or return 5xx while it re-establishes its
  // DB connection — e.g. when `logto-postgres` is recreated under a still-
  // running `logto` container during a deploy. The core discovery poll may
  // already be green while the admin-tenant token path (DB-backed) is not.
  // A single blip should not abort the whole bootstrap, so retry network
  // errors + HTTP >= 500 with exponential backoff. 4xx is NOT retried — it
  // signals a real credential/config problem.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= TOKEN_MINT_MAX_ATTEMPTS; attempt++) {
    let res: Response | undefined;
    try {
      res = await fetch(`${endpoint}/oidc/token`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
        signal: AbortSignal.timeout(TOKEN_MINT_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      lastErr = err; // network error / timeout — retryable
    }
    if (res !== undefined) {
      if (res.ok) {
        const json = (await res.json()) as TokenResponse;
        return json.access_token;
      }
      const detail = `M2M token mint failed (client=${clientId}, resource=${resource}): HTTP ${res.status} ${await res.text()}`;
      if (res.status < 500) {
        throw new Error(detail); // 4xx — not retryable
      }
      lastErr = new Error(detail); // 5xx — retryable
    }
    if (attempt < TOKEN_MINT_MAX_ATTEMPTS) {
      const backoffMs = Math.min(
        500 * 2 ** (attempt - 1),
        TOKEN_MINT_BACKOFF_CEILING_MS,
      );
      const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
      log(
        `[bootstrap-logto] token mint attempt ${attempt}/${TOKEN_MINT_MAX_ATTEMPTS} for ${clientId} failed (${reason}); retrying in ${backoffMs}ms...`,
      );
      await sleep(backoffMs);
    }
  }
  const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(
    `M2M token mint failed after ${TOKEN_MINT_MAX_ATTEMPTS} attempts (client=${clientId}, resource=${resource}): ${reason}`,
  );
}

interface ApiClientOptions {
  /** Tenant API base URL (e.g. `${adminEndpoint}` for admin tenant). */
  base: string;
  token: string;
}

export const MANAGEMENT_API_REQUEST_TIMEOUT_MS = 15_000;

async function api<T = unknown>(
  opts: ApiClientOptions,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.token}`,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  const url = `${opts.base}${path}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    // A half-open Logto management request must not strand the transient
    // hosted bootstrap forever. Callers either fail closed or, for optional
    // reconciliation such as branding, deliberately catch and continue.
    signal: AbortSignal.timeout(MANAGEMENT_API_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(
      `${method} ${url} → HTTP ${res.status}: ${await res.text()}`,
    );
  }
  // 204 No Content paths return empty. Some 201 paths return the literal
  // string "Created" (e.g. POST /api/organizations/{id}/users) — tolerate
  // non-JSON bodies as `undefined` since callers that need the response
  // explicitly type T as the JSON shape and check fields, while callers
  // that ignore the response don't care.
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as T;
  }
}

/** M064 — Account Center API (`PATCH /api/account-center`). */
async function ensureAccountCenterEnabled(client: ApiClientOptions): Promise<void> {
  await api(client, "PATCH", "/api/account-center", {
    enabled: ACCOUNT_CENTER_ENABLE_PATCH_BODY.enabled,
    fields: { password: ACCOUNT_CENTER_ENABLE_PATCH_BODY.fields.password },
  });
}

export interface LogtoApp {
  id: string;
  name: string;
  type: "SPA" | "Native" | "MachineToMachine";
  secret?: string;
}

/**
 * Restore handoff must never try to repair a partially provisioned tenant.
 * Keep this error deliberately non-diagnostic: the hosted entrypoint turns it
 * into a stable redacted failure code, and no application id or secret is
 * useful to an operator who cannot safely continue.
 */
export class ProvisionedLogtoIdentityError extends Error {
  constructor() {
    super("Provisioned Logto identities are unavailable");
    this.name = "ProvisionedLogtoIdentityError";
  }
}

const MAX_PROVISIONED_LOGTO_ID_BYTES = 512;
const MAX_PROVISIONED_LOGTO_SECRET_BYTES = 4096;

function boundedProvisionedString(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && !Array.prototype.some.call(value, (character: string) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
    && Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function selectExactProvisionedApplication(
  applications: readonly LogtoApp[],
  name: string,
  type: LogtoApp["type"],
): LogtoApp {
  const matches = applications.filter((application) => application.name === name);
  if (
    matches.length !== 1
    || matches[0]?.type !== type
    || !boundedProvisionedString(matches[0]?.id, MAX_PROVISIONED_LOGTO_ID_BYTES)
  ) {
    throw new ProvisionedLogtoIdentityError();
  }
  return matches[0];
}

/**
 * Idempotent app upsert: GETs by name first, POSTs only if not found.
 * If the app DOES exist, reconciles the desired `redirectUris` /
 * `postLogoutRedirectUris` via a set-union PATCH so subsequent
 * bootstraps pick up new entries we added (e.g. M054 port-3000 dev
 * redirect) without blowing away admin-console-added URIs.
 *
 * Returns the existing-or-just-created app row.
 *
 * `LogtoAppWithMetadata` widens `LogtoApp` with the `oidcClientMetadata`
 * shape Logto returns on GET — we don't need it elsewhere so it stays
 * local to this helper.
 */
interface LogtoAppWithMetadata extends LogtoApp {
  oidcClientMetadata?: {
    redirectUris?: string[];
    postLogoutRedirectUris?: string[];
  };
  customClientMetadata?: Record<string, unknown>;
}

export function selectManagedWorkbenchApplication<T extends { readonly id: string; readonly name: string; readonly type: string }>(
  applications: readonly T[],
  expectedName: string,
): T {
  const matches = applications.filter(({ name }) => name === expectedName);
  if (matches.length !== 1 || matches[0]?.type !== "SPA" || matches[0].id.length === 0) {
    throw new ManagedWorkbenchOriginReplacementError();
  }
  return matches[0];
}

/**
 * M060 — set-union merge for `customClientMetadata`.
 *
 * Logto OSS replaces (not merges) `customClientMetadata` on PATCH —
 * sending `{alwaysIssueRefreshToken:true}` alone overwrites the object
 * and drops sibling keys like `isDeviceFlow`. The merge here mirrors
 * the redirect-URI set-union used elsewhere: read existing, overlay
 * desired, return both the merged object AND a flag so the caller can
 * skip the PATCH entirely when nothing changed.
 *
 * Exported for unit tests.
 */
export function mergeCustomClientMetadata(
  current: Record<string, unknown> | undefined,
  desired: Record<string, unknown>,
): { merged: Record<string, unknown>; changed: boolean } {
  const cur = current ?? {};
  const merged: Record<string, unknown> = { ...cur };
  let changed = false;
  for (const [k, v] of Object.entries(desired)) {
    if (!(k in cur) || cur[k] !== v) {
      merged[k] = v;
      changed = true;
    }
  }
  return { merged, changed };
}

/**
 * M057 — legacy-named CLI device-flow app upsert.
 *
 * Differs from `ensureApp` in two ways:
 *   1. POSTs include `customClientMetadata.isDeviceFlow: true`.
 *   2. If an app with this name already exists but DOESN'T have
 *      `isDeviceFlow=true`, DELETE + re-POST. Logto OSS rejects
 *      PATCHes that flip the flag (`device_flow_not_changeable`), so
 *      a one-shot rebuild is the only path forward for pre-M057 dev
 *      installs.
 */
async function ensureDeviceFlowTuiApp(
  client: ApiClientOptions,
  payload: {
    name: string;
    type: "Native";
    oidcClientMetadata: {
      redirectUris: readonly string[];
      postLogoutRedirectUris: readonly string[];
    };
    customClientMetadata: { isDeviceFlow: true };
  },
): Promise<LogtoApp> {
  const search = encodeURIComponent(payload.name);
  const existing = await api<LogtoAppWithMetadata[]>(
    client,
    "GET",
    `/api/applications?search=${search}`,
  );
  const match = existing.find((a) => a.name === payload.name);

  if (!match) {
    return api<LogtoApp>(client, "POST", "/api/applications", payload);
  }

  if (match.customClientMetadata?.["isDeviceFlow"] === true) {
    // Already a device-flow app. Reconcile the redirect URI set AND
    // the customClientMetadata so refresh-token issuance flips on for
    // pre-M060 dev installs without a destructive recreate.
    const current = match.oidcClientMetadata ?? {};
    const desired = payload.oidcClientMetadata;
    const currentRedirects = current.redirectUris ?? [];
    const currentPostLogout = current.postLogoutRedirectUris ?? [];
    const uriUnion = computeOidcUriUnionPatch(
      currentRedirects,
      currentPostLogout,
      desired.redirectUris,
      desired.postLogoutRedirectUris,
    );
    const { missingRedirects } = uriUnion;

    const { merged: mergedCustom, changed: customChanged } =
      mergeCustomClientMetadata(
        match.customClientMetadata,
        payload.customClientMetadata as unknown as Record<string, unknown>,
      );

    if (missingRedirects.length === 0 && !customChanged) {
      return match;
    }

    const patchBody: Record<string, unknown> = {};
    if (missingRedirects.length > 0 || uriUnion.missingPostLogout.length > 0) {
      patchBody["oidcClientMetadata"] = {
        redirectUris: uriUnion.mergedRedirectUris,
        postLogoutRedirectUris: uriUnion.mergedPostLogoutRedirectUris,
      };
    }
    if (customChanged) {
      patchBody["customClientMetadata"] = mergedCustom;
    }
    log(
      `[bootstrap-logto] reconciling ${payload.name}: +${missingRedirects.length} redirect, customChanged=${customChanged}`,
    );
    await api(client, "PATCH", `/api/applications/${match.id}`, patchBody);
    return match;
  }

  // Pre-M057 install: the legacy-named app exists as a regular Native app. Delete
  // and recreate as a device-flow app. The new app will have a fresh
  // ID; the env-writer step below picks it up automatically.
  log(
    `[bootstrap-logto] migrating "${payload.name}" to device-flow ` +
      `(deleting old app id=${match.id})...`,
  );
  await api(client, "DELETE", `/api/applications/${match.id}`);
  return api<LogtoApp>(client, "POST", "/api/applications", payload);
}

async function reconcileDefaultTenantHostedAuthBranding(
  client: ApiClientOptions,
  options: {
    unknownSessionRedirectUrl?: string;
    includePasswordPolicy?: boolean;
  } = {},
): Promise<void> {
  try {
    const current = await api<Record<string, unknown>>(
      client,
      "GET",
      "/api/sign-in-exp",
    );
    // M105 Phase B follow-up — point Logto's "unknown session" landing at
    // the workbench root so direct hits on /sign-in (no OAuth flow) don't
    // dead-end on Logto's 404.
    const workbenchUrl =
      options.unknownSessionRedirectUrl ?? resolveInstance().workbench.url;
    const { patch, changed } = computeLogtoHostedBrandingReconcilePatch(current, {
      unknownSessionRedirectUrl: workbenchUrl,
      ...(options.includePasswordPolicy === false
        ? { includePasswordPolicy: false }
        : {}),
    });
    if (!changed) {
      log("[bootstrap-logto] hosted sign-in branding already matches Nautilo defaults");
      return;
    }
    log("[bootstrap-logto] patching default-tenant hosted sign-in branding (D104 Phase 5)...");
    await api(client, "PATCH", "/api/sign-in-exp", patch);
  } catch (e) {
    warn(
      `[bootstrap-logto] hosted sign-in branding reconcile skipped: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function mergeOssRelayForgotPasswordPhrases(
  current: Record<string, unknown>,
): Record<string, unknown> {
  const currentDescription = isRecord(current["description"])
    ? current["description"]
    : {};
  return {
    ...current,
    description: {
      ...currentDescription,
      ...OSS_RELAY_FORGOT_PASSWORD_CUSTOM_PHRASES_EN.description,
    },
  };
}

export async function reconcileOssRelayForgotPasswordPhrases(
  client: ApiClientOptions,
): Promise<void> {
  let currentTranslation: Record<string, unknown> = {};
  try {
    const current = await api<{ translation?: unknown }>(
      client,
      "GET",
      "/api/custom-phrases/en",
    );
    if (isRecord(current.translation)) {
      currentTranslation = current.translation;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!message.includes("HTTP 404")) {
      throw e;
    }
  }

  const merged = mergeOssRelayForgotPasswordPhrases(currentTranslation);
  if (JSON.stringify(merged) === JSON.stringify(currentTranslation)) {
    log("[bootstrap-logto] M120: OSS relay custom phrases already configured");
    return;
  }

  log("[bootstrap-logto] M120: patching OSS relay custom phrases...");
  await api(client, "PUT", "/api/custom-phrases/en", merged);
}

export async function reconcileOssRelayForgotPasswordPhrasesInLogtoDb(
  postgresUrl: string,
): Promise<void> {
  const sql = createSqlClient(postgresUrl, { max: 1, idle_timeout: 5 });
  try {
    await sql`
      INSERT INTO custom_phrases (tenant_id, id, language_tag, translation)
      VALUES (
        'default',
        'nautilo-oss-relay-en',
        'en',
        jsonb_build_object(
          'description',
          jsonb_build_object(
            'verify_email',
            ${OSS_RELAY_FORGOT_PASSWORD_CUSTOM_PHRASES_EN.description.verify_email}::text,
            'enter_passcode',
            ${OSS_RELAY_FORGOT_PASSWORD_CUSTOM_PHRASES_EN.description.enter_passcode}::text
          )
        )
      )
      ON CONFLICT (tenant_id, language_tag) DO UPDATE
      SET translation = jsonb_set(
        jsonb_set(
          coalesce(custom_phrases.translation, '{}'::jsonb),
          '{description,verify_email}',
          to_jsonb(${OSS_RELAY_FORGOT_PASSWORD_CUSTOM_PHRASES_EN.description.verify_email}::text),
          true
        ),
        '{description,enter_passcode}',
        to_jsonb(${OSS_RELAY_FORGOT_PASSWORD_CUSTOM_PHRASES_EN.description.enter_passcode}::text),
        true
      )
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * M120 — configure Logto so the native ForgotPassword email-code flow
 * delivers its code to Nautilo's HTTP Email webhook (no SMTP), and enable the
 * `EmailVerificationCode` forgot-password method. Idempotent. Throws if a
 * different (operator-owned) email connector is already configured — POSTing
 * a new email connector would make Logto silently delete it.
 */
export async function reconcileForgotPasswordRelay(
  client: ApiClientOptions,
  relay: { webhookEndpoint: string; webhookSecret: string },
): Promise<void> {
  const rawConnectors = await api<
    Array<{ id?: unknown; connectorId?: unknown; type?: unknown; config?: unknown }>
  >(client, "GET", "/api/connectors");
  const connectors: LogtoConnectorRow[] = rawConnectors.map((c) => ({
    id: typeof c.id === "string" ? c.id : "",
    connectorId: typeof c.connectorId === "string" ? c.connectorId : "",
    type: typeof c.type === "string" ? c.type : undefined,
    config:
      c.config && typeof c.config === "object"
        ? (c.config as Record<string, unknown>)
        : undefined,
  }));

  const sie = await api<{ forgotPasswordMethods?: unknown }>(
    client,
    "GET",
    "/api/sign-in-exp",
  );
  const currentForgotPasswordMethods = Array.isArray(sie.forgotPasswordMethods)
    ? sie.forgotPasswordMethods.filter((m): m is string => typeof m === "string")
    : null;

  const plan = computeForgotPasswordRelayPlan({
    connectors,
    currentForgotPasswordMethods,
    webhookEndpoint: relay.webhookEndpoint,
    webhookSecret: relay.webhookSecret,
  });

  if (plan.connector === "conflict") {
    throw new Error(
      `[bootstrap-logto] M120: an operator-owned email connector ` +
        `(${plan.conflictConnectorId}) is already configured. Refusing to ` +
        `replace it (POSTing one makes Logto delete existing email ` +
        `connectors). Remove that connector or use a deployment profile that ` +
        `does not configure the OSS M120 relay.`,
    );
  }

  if (plan.connector === "create" && plan.connectorBody) {
    log("[bootstrap-logto] M120: configuring http-email connector → Nautilo webhook...");
    await api(client, "POST", "/api/connectors", plan.connectorBody);
  } else {
    log("[bootstrap-logto] M120: http-email connector already configured");
  }

  if (plan.forgotPasswordMethods) {
    log("[bootstrap-logto] M120: enabling EmailVerificationCode forgot-password method...");
    await api(client, "PATCH", "/api/sign-in-exp", {
      forgotPasswordMethods: plan.forgotPasswordMethods,
    });
  } else {
    log("[bootstrap-logto] M120: EmailVerificationCode forgot-password method already enabled");
  }
}

async function ensureApp(
  client: ApiClientOptions,
  payload: {
    name: string;
    type: "SPA" | "Native" | "MachineToMachine";
    oidcClientMetadata?: {
      redirectUris?: readonly string[];
      postLogoutRedirectUris?: readonly string[];
    };
    removeOidcClientMetadata?: {
      redirectUris: readonly string[];
      postLogoutRedirectUris: readonly string[];
    };
    requireManagedWorkbenchIdentity?: true;
    /**
     * M060 — opt-in customClientMetadata. M2M apps don't need it; SPA
     * + Native apps that drive interactive sign-ins do (refresh-token
     * issuance is gated on `alwaysIssueRefreshToken`). Set-union
     * merged into existing customClientMetadata so we never drop
     * sibling keys (Logto OSS PATCH is REPLACE-style for this field).
     */
    customClientMetadata?: Record<string, unknown>;
    description?: string;
  },
): Promise<LogtoApp> {
  const search = encodeURIComponent(payload.name);
  const existing = await api<LogtoAppWithMetadata[]>(
    client,
    "GET",
    `/api/applications?search=${search}`,
  );
  const match = payload.requireManagedWorkbenchIdentity
    ? selectManagedWorkbenchApplication(existing, payload.name)
    : existing.find((a) => a.name === payload.name);
  if (!match) {
    return api<LogtoApp>(client, "POST", "/api/applications", payload);
  }

  // Reconcile redirect URIs if the desired set isn't a subset of the
  // existing one. Set-union — additive only.
  const desired = payload.oidcClientMetadata;

  const current = match.oidcClientMetadata ?? {};
  const currentRedirects = current.redirectUris ?? [];
  const currentPostLogout = current.postLogoutRedirectUris ?? [];
  const desiredRedirects = desired?.redirectUris ?? [];
  const desiredPostLogout = desired?.postLogoutRedirectUris ?? [];

  const uriUnion = payload.removeOidcClientMetadata
    ? computeOidcUriRebindPatch(
        currentRedirects,
        currentPostLogout,
        desiredRedirects,
        desiredPostLogout,
        payload.removeOidcClientMetadata.redirectUris,
        payload.removeOidcClientMetadata.postLogoutRedirectUris,
      )
    : {
        ...computeOidcUriUnionPatch(
          currentRedirects,
          currentPostLogout,
          desiredRedirects,
          desiredPostLogout,
        ),
        removedRedirects: [],
        removedPostLogout: [],
      };
  const { missingRedirects, missingPostLogout } = uriUnion;

  // M060 — customClientMetadata reconciliation. PATCH semantics on
  // this field are REPLACE, not merge, so we read-merge-write the
  // full object via mergeCustomClientMetadata.
  const customMerge = payload.customClientMetadata
    ? mergeCustomClientMetadata(
        match.customClientMetadata,
        payload.customClientMetadata,
      )
    : { merged: match.customClientMetadata ?? {}, changed: false };

  if (
    missingRedirects.length === 0 &&
    missingPostLogout.length === 0 &&
    uriUnion.removedRedirects.length === 0 &&
    uriUnion.removedPostLogout.length === 0 &&
    !customMerge.changed
  ) {
    return match;
  }

  const patchBody: Record<string, unknown> = {};
  if (
    missingRedirects.length > 0 ||
    missingPostLogout.length > 0 ||
    uriUnion.removedRedirects.length > 0 ||
    uriUnion.removedPostLogout.length > 0
  ) {
    patchBody["oidcClientMetadata"] = {
      redirectUris: uriUnion.mergedRedirectUris,
      postLogoutRedirectUris: uriUnion.mergedPostLogoutRedirectUris,
    };
  }
  if (customMerge.changed) {
    patchBody["customClientMetadata"] = customMerge.merged;
  }

  log(
    `[bootstrap-logto] reconciling ${payload.name}: +${missingRedirects.length}/-${uriUnion.removedRedirects.length} redirect, +${missingPostLogout.length}/-${uriUnion.removedPostLogout.length} postLogout, customChanged=${customMerge.changed}`,
  );
  await api(client, "PATCH", `/api/applications/${match.id}`, patchBody);
  return match;
}

export interface LogtoResource {
  id: string;
  indicator: string;
  name: string;
}

export const PROVISIONED_LOGTO_APPLICATION_IDENTITIES: ReadonlyArray<
  readonly [string, LogtoApp["type"]]
> = Object.freeze([
  [APP_NAMES.workbench, "SPA"],
  [APP_NAMES.tui, "Native"],
  [APP_NAMES.tuiLoopback, "Native"],
  [APP_NAMES.desktop, "Native"],
  [APP_NAMES.mobile, "Native"],
  [APP_NAMES.mobileWeb, "SPA"],
  [APP_NAMES.m2m, "MachineToMachine"],
]);

/**
 * Select the complete, already-provisioned default-tenant identity set for a
 * hosted restore. This is intentionally a read-only verifier rather than an
 * upsert: a populated restore must fail closed if any identity is absent,
 * duplicated, the wrong kind, or has lost its M2M secret.
 */
export function selectProvisionedLogtoConfig(input: {
  readonly endpoint: string;
  readonly resource: string;
  readonly applications: readonly LogtoApp[];
  readonly resources: readonly LogtoResource[];
  readonly m2mSecret: unknown;
}): LogtoConfig {
  if (!boundedProvisionedString(input.endpoint, MAX_PROVISIONED_LOGTO_ID_BYTES)
    || !boundedProvisionedString(input.resource, MAX_PROVISIONED_LOGTO_ID_BYTES)
    || !boundedProvisionedString(input.m2mSecret, MAX_PROVISIONED_LOGTO_SECRET_BYTES)) {
    throw new ProvisionedLogtoIdentityError();
  }
  const resourceMatches = input.resources.filter((candidate) => candidate.indicator === input.resource);
  if (
    resourceMatches.length !== 1
    || !boundedProvisionedString(resourceMatches[0]?.id, MAX_PROVISIONED_LOGTO_ID_BYTES)
  ) {
    throw new ProvisionedLogtoIdentityError();
  }
  return Object.freeze({
    endpoint: input.endpoint,
    workbenchAppId: selectExactProvisionedApplication(input.applications, APP_NAMES.workbench, "SPA").id,
    tuiAppId: selectExactProvisionedApplication(input.applications, APP_NAMES.tui, "Native").id,
    tuiLoopbackAppId: selectExactProvisionedApplication(input.applications, APP_NAMES.tuiLoopback, "Native").id,
    desktopAppId: selectExactProvisionedApplication(input.applications, APP_NAMES.desktop, "Native").id,
    mobileAppId: selectExactProvisionedApplication(input.applications, APP_NAMES.mobile, "Native").id,
    mobileWebAppId: selectExactProvisionedApplication(input.applications, APP_NAMES.mobileWeb, "SPA").id,
    m2mAppId: selectExactProvisionedApplication(input.applications, APP_NAMES.m2m, "MachineToMachine").id,
    m2mAppSecret: input.m2mSecret,
    resource: input.resource,
  });
}

async function readProvisionedLogtoConfig(
  client: ApiClientOptions,
  endpoint: string,
  resource: string,
): Promise<LogtoConfig> {
  try {
    // Do not depend on an unfiltered collection being complete: Logto may
    // paginate it. Each exact Nautilo name is searched independently, then
    // validated for uniqueness and type below.
    const applications = await Promise.all(PROVISIONED_LOGTO_APPLICATION_IDENTITIES.map(async ([name, type]) => {
      const matches = await api<LogtoApp[]>(
        client,
        "GET",
        `/api/applications?search=${encodeURIComponent(name)}`,
      );
      return selectExactProvisionedApplication(matches, name, type);
    }));
    const m2m = selectExactProvisionedApplication(applications, APP_NAMES.m2m, "MachineToMachine");
    const m2mDetails = await api<LogtoApp>(
      client,
      "GET",
      `/api/applications/${encodeURIComponent(m2m.id)}`,
    );
    if (
      m2mDetails.id !== m2m.id
      || m2mDetails.name !== APP_NAMES.m2m
      || m2mDetails.type !== "MachineToMachine"
    ) {
      throw new ProvisionedLogtoIdentityError();
    }
    const resources = await api<LogtoResource[]>(client, "GET", "/api/resources");
    return selectProvisionedLogtoConfig({
      endpoint,
      resource,
      applications,
      resources,
      m2mSecret: m2mDetails.secret,
    });
  } catch (error) {
    if (error instanceof ProvisionedLogtoIdentityError) throw error;
    throw new ProvisionedLogtoIdentityError();
  }
}

async function ensureResource(
  client: ApiClientOptions,
  payload: { indicator: string; name: string },
): Promise<LogtoResource> {
  const all = await api<LogtoResource[]>(client, "GET", "/api/resources");
  const match = all.find((r) => r.indicator === payload.indicator);
  if (match) return match;
  return api<LogtoResource>(client, "POST", "/api/resources", payload);
}

interface LogtoOrgRole {
  id: string;
  name: string;
}

async function ensureOrgRole(
  client: ApiClientOptions,
  name: string,
): Promise<LogtoOrgRole> {
  const all = await api<LogtoOrgRole[]>(
    client,
    "GET",
    "/api/organization-roles",
  );
  const match = all.find((r) => r.name === name);
  if (match) return match;
  return api<LogtoOrgRole>(client, "POST", "/api/organization-roles", { name });
}

/**
 * M055 — extracted from the original `runBootstrap` body. Steps 4-10
 * of the bootstrap algorithm: relax pwned-password check, create the
 * admin user, add to the t-default org with admin role, assign system
 * user roles, flip admin tenant signInMode → SignIn. Only runs on the
 * first-bootstrap path (`!probe.alreadyBootstrapped`). After the
 * sign-in-mode flip succeeds, future runs hit the upgrade-path branch
 * in `runBootstrap` and skip this function entirely.
 */
async function runFirstTimeAdminProvisioning(
  adminClient: ApiClientOptions,
  postgresUrl: string,
): Promise<{ adminUsername: string; adminPassword: string }> {
  // Step 4: relax password policy (pwned-check) on the admin tenant
  // BEFORE creating the admin user so step 6's password isn't checked
  // against haveibeenpwned.com (which hangs offline; logto-io/logto
  // #8548). The default-tenant policy is patched in the unconditional
  // section below so it applies on upgrade boots too.
  log("[bootstrap-logto] disabling pwned-password check on admin tenant...");
  await api(adminClient, "PATCH", "/api/sign-in-exp", {
    passwordPolicy: { rejects: { pwned: false } },
  });

  // Step 6: create admin-console user. Username fixed; password generated.
  // Underscore (not dash) to match Logto's username regex `[A-Za-z0-9_]+`
  // — POSTing `nautilo-admin` returns 400 with a Zod regex validation
  // error. Empirically verified on Logto v1.38.
  const adminUsername = "nautilo_admin";
  const adminPassword = randomBytes(24).toString("hex");

  log(`[bootstrap-logto] creating admin user "${adminUsername}"...`);
  // GET /api/users?search=<username>; Logto's user search matches
  // username/email/name fuzzy, so we filter exact-username after.
  // Recovery: if we find a leftover user from a partial-failure run
  // (sign_in_mode hasn't flipped yet, by definition of being here),
  // delete and recreate so the printed password matches a real one.
  const existingUsers = await api<{ id: string; username?: string }[]>(
    adminClient,
    "GET",
    `/api/users?search=${encodeURIComponent(adminUsername)}`,
  );
  const existing = existingUsers.find((u) => u.username === adminUsername);
  if (existing) {
    warn(
      `[bootstrap-logto] found leftover admin user from a previous interrupted bootstrap; deleting and recreating with a fresh password.`,
    );
    await api(adminClient, "DELETE", `/api/users/${existing.id}`);
  }
  const newUser = await api<{ id: string }>(
    adminClient,
    "POST",
    "/api/users",
    { username: adminUsername, password: adminPassword },
  );
  const adminUserId = newUser.id;

  // Step 7-8: add to t-default org + assign admin org-role.
  await api(adminClient, "POST", "/api/organizations/t-default/users", {
    userIds: [adminUserId],
  });
  const adminOrgRoles = await api<{ id: string; name: string }[]>(
    adminClient,
    "GET",
    "/api/organization-roles",
  );
  const adminOrgRole = adminOrgRoles.find((r) => r.name === "admin");
  if (!adminOrgRole) {
    throw new Error(
      "admin organization role not found in admin tenant — was logto-seed run?",
    );
  }
  await api(
    adminClient,
    "POST",
    "/api/organizations/t-default/users/roles",
    { userIds: [adminUserId], organizationRoleIds: [adminOrgRole.id] },
  );

  // Step 9: assign every system user role.
  const systemUserRoles = await api<{ id: string }[]>(
    adminClient,
    "GET",
    "/api/roles?type=User",
  );
  if (systemUserRoles.length > 0) {
    await api(adminClient, "POST", `/api/users/${adminUserId}/roles`, {
      roleIds: systemUserRoles.map((r) => r.id),
    });
  }

  // Step 10: flip admin tenant's sign-in-mode. AFTER this, the probe
  // in future runs short-circuits past this function.
  log("[bootstrap-logto] flipping admin tenant signInMode → SignIn...");
  try {
    await api(adminClient, "PATCH", "/api/sign-in-exp", {
      signInMode: "SignIn",
    });
  } catch (err) {
    // Remote deploy hairpin: Logto may commit the mode flip but return
    // auth.unauthorized/TimeoutError when ADMIN_ENDPOINT pointed at the
    // droplet's public IP. Treat a committed SignIn row as success.
    const mode = await probeAdminSignInMode(postgresUrl);
    if (mode === "SignIn") {
      warn(
        `[bootstrap-logto] signInMode PATCH errored but DB is already SignIn; continuing (${err instanceof Error ? err.message : String(err)})`,
      );
    } else {
      throw err;
    }
  }

  return { adminUsername, adminPassword };
}

async function reconcileWorkbenchApplication(
  defaultClient: ApiClientOptions,
  options: BootstrapOptions,
  managedOriginReplacement?: ManagedWorkbenchOriginReplacement,
): Promise<LogtoApp> {
  const instance = resolveInstance();
  const dedupe = (xs: readonly string[]): string[] =>
    Array.from(new Set(xs));
  const workbenchRedirectUris = dedupe([
    ...deriveWorkbenchOidcRedirectUris(instance),
    ...(options.extraWorkbenchRedirectUris ?? []),
    ...(managedOriginReplacement === undefined
      ? []
      : deriveManagedWorkbenchOriginUris(managedOriginReplacement.targetOrigin).redirectUris),
  ]);
  const workbenchPostLogoutUris = dedupe([
    ...deriveWorkbenchPostLogoutRedirectUris(instance),
    ...(options.extraWorkbenchPostLogoutUris ?? []),
    ...(managedOriginReplacement === undefined
      ? []
      : deriveManagedWorkbenchOriginUris(managedOriginReplacement.targetOrigin).postLogoutRedirectUris),
  ]);
  const rebindFromId =
    process.env["NAUTILO_LOGTO_REBIND_FROM_INSTANCE_ID"]?.trim();
  const rebindFrom =
    rebindFromId && rebindFromId !== instance.instanceId
      ? resolveInstanceUncached(
          {
            HOME: process.env["HOME"],
            USERPROFILE: process.env["USERPROFILE"],
            NAUTILO_INSTANCE_ID: rebindFromId,
          },
          { skipUserConfigOverlay: true },
        )
      : null;
  const managedRemoval = managedOriginReplacement === undefined
    ? undefined
    : deriveManagedWorkbenchOriginUris(managedOriginReplacement.sourceOrigin);
  const removedRedirectUris = [
    ...(rebindFrom ? deriveWorkbenchOidcRedirectUris(rebindFrom) : []),
    ...(managedRemoval?.redirectUris ?? []),
  ];
  const removedPostLogoutRedirectUris = [
    ...(rebindFrom ? deriveWorkbenchPostLogoutRedirectUris(rebindFrom) : []),
    ...(managedRemoval?.postLogoutRedirectUris ?? []),
  ];

  return ensureApp(defaultClient, {
    name: APP_NAMES.workbench,
    type: "SPA",
    oidcClientMetadata: {
      redirectUris: workbenchRedirectUris,
      postLogoutRedirectUris: workbenchPostLogoutUris,
    },
    ...(removedRedirectUris.length > 0 || removedPostLogoutRedirectUris.length > 0
      ? {
          removeOidcClientMetadata: {
            redirectUris: removedRedirectUris,
            postLogoutRedirectUris: removedPostLogoutRedirectUris,
          },
        }
      : {}),
    ...(managedOriginReplacement === undefined ? {} : { requireManagedWorkbenchIdentity: true as const }),
  });
}

async function reconcileMobileWebApplication(
  defaultClient: ApiClientOptions,
  options: BootstrapOptions,
): Promise<LogtoApp> {
  const instance = resolveInstance();
  const redirectUris = Array.from(new Set([
    ...deriveMobileWebOidcRedirectUris(instance),
    ...(options.extraMobileWebRedirectUris ?? []),
  ]));
  const postLogoutRedirectUris = Array.from(new Set([
    ...deriveMobileWebPostLogoutRedirectUris(instance),
    ...(options.extraMobileWebPostLogoutUris ?? []),
  ]));
  return ensureApp(defaultClient, {
    name: APP_NAMES.mobileWeb,
    type: "SPA",
    oidcClientMetadata: { redirectUris, postLogoutRedirectUris },
    description:
      "Nautilo Mobile Web — exact-origin /mobile PKCE SPA. Public client, no secret (D515).",
  });
}

/**
 * Public entry. Run from `bin/nautilo-local` when `--with-logto` is set
 * (after compose stack is up). Logs progress to stderr via the
 * structured logger; prints the final banner to stdout.
 *
 * Throws on hard failure; idempotent on re-run.
 */
export async function runBootstrap(
  options: BootstrapOptions = {},
): Promise<LogtoConfig | undefined> {
  const managedOriginReplacement = options.managedWorkbenchOriginReplacement === undefined
    ? undefined
    : normalizeManagedWorkbenchOriginReplacement({ ...options.managedWorkbenchOriginReplacement });
  const inst = resolveInstance();
  const endpoint =
    options.endpoint ??
    process.env["LOGTO_ENDPOINT"] ??
    `http://localhost:${inst.logto.corePort}`;
  // Logto OSS serves the admin tenant on a separate port (ADMIN_PORT).
  // The m-admin Management API client and every admin-tenant route
  // (`/api/users`, `/api/organizations/...`, `/api/sign-in-exp`,
  //  `/oidc/token` for resource=https://admin.logto.app/api) live there.
  // Default tenant's API + OIDC stay on the core port.
  const adminEndpoint =
    options.adminEndpoint ??
    process.env["LOGTO_ADMIN_ENDPOINT"] ??
    `http://localhost:${inst.logto.adminPort}`;
  const resource =
    options.resource ??
    process.env["LOGTO_RESOURCE"] ??
    "https://api.nautilo.local";
  const dbPassword = process.env["LOGTO_DB_PASSWORD"] ?? "logto";
  const postgresUrl =
    options.postgresUrl ??
    `postgres://logto:${encodeURIComponent(dbPassword)}@localhost:${inst.logto.dbPort}/logto_nautilo`;
  const discoveryTimeoutMs =
    options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;

  log("[bootstrap-logto] waiting for Logto discovery doc...");
  await waitForOidcDiscovery(endpoint, discoveryTimeoutMs);

  log("[bootstrap-logto] probing Logto PostgreSQL bootstrap state...");
  let probe: ProbeResult;
  try {
    probe = await probePostgres(postgresUrl);
  } catch (error) {
    throw new Error(
      "Logto PostgreSQL bootstrap probe failed before any auth mutation: " +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // M055: split the idempotency model. Previously a single
  // `alreadyBootstrapped` short-circuit returned at this point and
  // skipped EVERYTHING below — including app provisioning. That meant
  // existing M051 dev installs would never see new app specs added in
  // later cluster issues (M055's `Nautilo Desktop` app, future M0XX
  // additions, etc.). The probe still gates user creation + sign-in-
  // mode flip, but app + resource + role + config-env writes run
  // unconditionally. `ensureApp` is set-union over redirect URIs and
  // `transaction()` is idempotent on equal-value writes, so re-runs are
  // cheap and never destructive.

  // Step 4 + 5: mint two M2M tokens. m-admin manages the admin tenant
  // (admin user creation + sign-in-mode flip); m-default manages the
  // default tenant (Nautilo apps + resource + org roles + default-tenant
  // sign-in-exp). Both tokens are minted at the ADMIN OIDC endpoint
  // (:3302) — that's where both clients live in OSS — but they use
  // different `resource` audiences, which routes them to different APIs.
  //
  // Crucially: m-default's default-tenant Management API calls route through
  // the ADMIN port with the `/m/default` tenant prefix. Sending that token to
  // the unprefixed core `/api/...` surface returns 403 (or a misleading JWKS
  // error through a public proxy) because it is not the admin tenant API.
  // The admin endpoint plus tenant prefix is the OSS multi-tenant route.
  log("[bootstrap-logto] minting admin + default Management API tokens...");
  const adminToken = await mintM2mToken(
    adminEndpoint,
    "m-admin",
    probe.credentials.mAdminSecret,
    "https://admin.logto.app/api",
  );
  const defaultToken = await mintM2mToken(
    adminEndpoint,
    "m-default",
    probe.credentials.mDefaultSecret,
    "https://default.logto.app/api",
  );

  const adminClient: ApiClientOptions = {
    base: adminEndpoint,
    token: adminToken,
  };
  const defaultClient: ApiClientOptions = {
    base: options.defaultTenantEndpoint ?? endpoint,
    token: defaultToken,
  };

  if (options.preserveProvisionedState) {
    if (!probe.alreadyBootstrapped) {
      throw new Error(
        "Cannot preserve provisioned Logto state before initial bootstrap",
      );
    }
    log(
      "[bootstrap-logto] preserving provisioned state; reconciling Workbench and Nautilo-owned auth projections only",
    );
    const workbenchApp = await reconcileWorkbenchApplication(defaultClient, options, managedOriginReplacement);
    const mobileWebApp = await reconcileMobileWebApplication(defaultClient, options);
    await reconcileDefaultTenantHostedAuthBranding(defaultClient, {
      unknownSessionRedirectUrl: resolveInstance().workbench.url,
      includePasswordPolicy: false,
    });
    // A populated hosted restore has already restored every Nautilo app and
    // resource. Read those exact identities after the narrowly-owned origin
    // reconciliation rather than invoking any of the normal ensure*/seed
    // paths below. The in-memory callback is the only handoff channel.
    if (managedOriginReplacement !== undefined) {
      const config = await readProvisionedLogtoConfig(defaultClient, endpoint, resource);
      if (options.persistConfig !== undefined) await options.persistConfig(config);
      return config;
    }
    // A local populated clone preserves the copied tenant but still needs its
    // browser application ids projected into this instance's public config.
    const txn = await runConfigTransaction({
      operations: buildPreservedProjectionEnvOperations({
        workbenchAppId: workbenchApp.id,
        mobileWebAppId: mobileWebApp.id,
      }),
      healthCheck: "none",
      overwrite: true,
      reason: "clone-owned Logto projection rebind",
      actor: "cli",
    });
    if (!txn.success) {
      throw new Error(
        `config-guard rejected cloned Logto projection write: ${txn.error ?? "unknown"}`,
      );
    }
    return;
  }

  // M055: stages 4-10 (password policy, admin user, org membership,
  // sign-in-mode flip) only run on first bootstrap. App provisioning
  // (stage 12) runs unconditionally — see comment above.
  let adminUsername = "";
  let adminPassword = "";

  if (!probe.alreadyBootstrapped) {
    ({ adminUsername, adminPassword } = await runFirstTimeAdminProvisioning(
      adminClient,
      postgresUrl,
    ));
  } else {
    log(
      "[bootstrap-logto] admin tenant already provisioned; skipping user creation + signInMode flip",
    );
  }

  // Default-tenant pwned-password policy relaxation runs every boot —
  // PATCH is idempotent, and an upgrade-path bootstrap that lands on a
  // tenant that doesn't have it set yet (older M051 install) shouldn't
  // be silently left in a state where new-user creation hangs offline.
  await api(defaultClient, "PATCH", "/api/sign-in-exp", {
    passwordPolicy: { rejects: { pwned: false } },
  });

  // M107 Phase 1b — flip the default tenant to username-based sign-in.
  // Idempotent (Logto returns 200 with no diff when the body matches
  // the existing record). Runs unconditionally so upgrades that pre-date
  // M107 catch up on the next boot without operator action. See the
  // doc-block on SIGN_IN_EXP_USERNAME_PATCH_BODY for the Phase 0 probe
  // notes that locked this shape.
  log("[bootstrap-logto] ensuring default-tenant SIE is username-based (M107)...");
  await api(
    defaultClient,
    "PATCH",
    "/api/sign-in-exp",
    SIGN_IN_EXP_USERNAME_PATCH_BODY,
  );

  await reconcileDefaultTenantHostedAuthBranding(defaultClient, {
    ...(options.unknownSessionRedirectUrl
      ? { unknownSessionRedirectUrl: options.unknownSessionRedirectUrl }
      : {}),
  });

  // M120 — configure the ForgotPassword email relay (http-email connector +
  // EmailVerificationCode method) when the deploy supplied a webhook target.
  // Runs unconditionally on every boot (idempotent) so upgrades pick it up.
  if (options.forgotPasswordRelay) {
    await reconcileForgotPasswordRelay(defaultClient, options.forgotPasswordRelay);
    await reconcileOssRelayForgotPasswordPhrasesInLogtoDb(postgresUrl);
  }

  // Step 12: default-tenant Nautilo objects. Runs unconditionally so
  // app spec changes (e.g. M055 added the "Nautilo Desktop" Native
  // app) land on existing M051 dev installs without an operator flag.
  log("[bootstrap-logto] creating Nautilo applications + resource + roles...");

  // M117 — set-union LAN-derived URIs with any extras supplied by the
  // caller (compose-driver passes `https://<domain>/auth/callback` etc
  // for `https=letsencrypt` deploys). `ensureApp`'s reconciler also
  // does set-union PATCH so re-deploys converge regardless.
  // POST /api/applications schema requires both redirectUris AND
  // postLogoutRedirectUris when oidcClientMetadata is present (Logto's
  // Zod validator rejects partial metadata even though Cloud's docs
  // imply the second field is optional). M055 populates the SPA's
  // postLogoutRedirectUris so the M054 browser sign-out lands on the
  // workbench origin.
  const workbenchApp = await reconcileWorkbenchApplication(
    defaultClient,
    options,
    managedOriginReplacement,
  );

  // M057 — RFC 8628 device-flow Native app. Logto OSS gates the
  // `urn:ietf:params:oauth:grant-type:device_code` on
  // `customClientMetadata.isDeviceFlow=true` (see Logto schemas
  // `CustomClientMetadataKey.IsDeviceFlow`). Without it, Native apps
  // only get `authorization_code` + `refresh_token` and the
  // device-authorization endpoint 400's with
  // "device_code is not allowed for this client".
  //
  // Crucially, Logto refuses to PATCH `isDeviceFlow` after creation
  // (`application.device_flow_not_changeable`), so we can only set it
  // on POST. The pre-M057 bootstrap created the legacy-named app without this
  // flag → existing dev installs need a one-shot rebuild. Detect via
  // the `customClientMetadata.isDeviceFlow` field on the GET, and
  // DELETE + re-POST if missing. App ID changes — the env writer
  // below picks up the new value.
  //
  // The placeholder `redirectUris` satisfies Logto's structural
  // validator; see `TUI_REDIRECT_URIS` for the rationale.
  const tuiPayload = {
    name: APP_NAMES.tui,
    type: "Native" as const,
    oidcClientMetadata: {
      redirectUris: TUI_REDIRECT_URIS,
      postLogoutRedirectUris: [] as readonly string[],
    },
    customClientMetadata: { isDeviceFlow: true as const },
  };
  const tuiApp = await ensureDeviceFlowTuiApp(defaultClient, tuiPayload);

  // D112 Phase 6 — loopback claim redeem mints a PAT then exchanges it for
  // API access tokens. Logto requires `allowTokenExchange` on the client app.
  try {
    const curTui = await api<{
      id: string;
      customClientMetadata?: Record<string, unknown>;
    }>(defaultClient, "GET", `/api/applications/${tuiApp.id}`);
    const { merged, changed } = mergeCustomClientMetadata(
      curTui.customClientMetadata,
      { allowTokenExchange: true },
    );
    if (changed) {
      await api(defaultClient, "PATCH", `/api/applications/${tuiApp.id}`, {
        customClientMetadata: merged,
      });
      log(
        "[bootstrap-logto] enabled customClientMetadata.allowTokenExchange on legacy CLI device-flow app (D112 claim handoff)",
      );
    }
  } catch (err) {
    warn(
      `[bootstrap-logto] could not reconcile legacy CLI device-flow allowTokenExchange: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // M055 — fourth app: Native Electron loopback PKCE (RFC 8252 §7.3).
  // Distinct from the SPA Workbench app because Logto OSS only honours
  // port-flex on `127.0.0.1` for Native apps. Probed 2026-04-28.
  const desktopApp = await ensureApp(defaultClient, {
    name: APP_NAMES.desktop,
    type: "Native",
    oidcClientMetadata: {
      redirectUris: DESKTOP_REDIRECT_URIS,
      postLogoutRedirectUris: DESKTOP_POST_LOGOUT_REDIRECT_URIS,
    },
    description:
      "Nautilo Electron desktop app — loopback PKCE per RFC 8252 §7.3.",
  });

  // M102 — legacy-named CLI loopback PKCE Native app. The device-flow app cannot
  // host authorization_code because Logto OSS gates response_types=[]
  // when customClientMetadata.isDeviceFlow=true. Mirror the Electron
  // Desktop pattern: a second Native app for the M102 CLI laptop path.
  const tuiLoopbackApp = await ensureApp(defaultClient, {
    name: APP_NAMES.tuiLoopback,
    type: "Native",
    oidcClientMetadata: {
      redirectUris: TUI_LOOPBACK_REDIRECT_URIS,
      postLogoutRedirectUris: [],
    },
    description:
      "CLI loopback PKCE — RFC 8252 §7.3 (M102). Uses the legacy Nautilo TUI loopback registration; its sibling is device-flow-only.",
  });

  // M199 — Native app for the mobile (Expo) client's custom-scheme PKCE
  // flow. Mobile has no origin and can't host a loopback server like
  // Electron, so it uses `nautilo://callback` instead of
  // `http://127.0.0.1/callback`. Same public-client PKCE shape as the
  // Desktop Native app, no secret. Seeded by bootstrap so every federated
  // Nautilo server provisions it automatically.
  const mobileApp = await ensureApp(defaultClient, {
    name: APP_NAMES.mobile,
    type: "Native",
    oidcClientMetadata: {
      redirectUris: MOBILE_REDIRECT_URIS,
      postLogoutRedirectUris: MOBILE_POST_LOGOUT_REDIRECT_URIS,
    },
    description:
      "Nautilo mobile app (Expo / React Native) — custom-scheme PKCE (nautilo://callback). Public client, no secret (M199).",
  });

  const mobileWebApp = await reconcileMobileWebApplication(defaultClient, options);

  const m2mApp = await ensureApp(defaultClient, {
    name: APP_NAMES.m2m,
    type: "MachineToMachine",
  });

  // Best-effort: assign Logto Management API access role to the M2M app
  // so it can later invite users / assign roles from server code (M052+).
  try {
    const allRoles = await api<{ id: string; name: string }[]>(
      defaultClient,
      "GET",
      "/api/roles",
    );
    const mgmtRole = allRoles.find(
      (r) => r.name === "Logto Management API access",
    );
    if (mgmtRole) {
      await api(
        defaultClient,
        "POST",
        `/api/applications/${m2mApp.id}/roles`,
        { roleIds: [mgmtRole.id] },
      );
    }
  } catch (err) {
    warn(
      `[bootstrap-logto] could not assign Management API role to M2M app: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  await ensureResource(defaultClient, {
    indicator: resource,
    name: LOGTO_RESOURCE_NAME,
  });

  for (const roleName of ORG_ROLES_TO_SEED) {
    await ensureOrgRole(defaultClient, roleName);
  }

  // M064 — default-tenant Account Center (password edit). Uses the same
  // `defaultClient` minted with resource=https://default.logto.app/api
  // (m-default M2M token against core :3301 — not the admin port).
  await ensureAccountCenterEnabled(defaultClient);

  // m2mApp's secret is only present on the create response. If we hit
  // the idempotent path (existing app), fetch it explicitly.
  let m2mSecret = m2mApp.secret;
  if (!m2mSecret) {
    const fresh = await api<LogtoApp>(
      defaultClient,
      "GET",
      `/api/applications/${m2mApp.id}`,
    );
    m2mSecret = fresh.secret;
  }
  if (!m2mSecret) {
    throw new Error(
      `Could not retrieve secret for M2M app ${m2mApp.id}; bootstrap incomplete.`,
    );
  }

  // Step 13: persist via config-guard. Idempotent on equal-value
  // writes; the only dirty events are when an app id rotated (full
  // re-bootstrap) or when a new key landed (e.g. M055's
  // LOGTO_DESKTOP_APP_ID on upgrade boots).
  const cfg: LogtoConfig = {
    endpoint,
    workbenchAppId: workbenchApp.id,
    tuiAppId: tuiApp.id,
    tuiLoopbackAppId: tuiLoopbackApp.id,
    desktopAppId: desktopApp.id,
    mobileAppId: mobileApp.id,
    mobileWebAppId: mobileWebApp.id,
    m2mAppId: m2mApp.id,
    m2mAppSecret: m2mSecret,
    resource,
  };
  log(options.persistConfig
    ? "[bootstrap-logto] handing reconciled LOGTO configuration to hosted output sink..."
    : "[bootstrap-logto] writing LOGTO_* to instance.env...");
  // M120 — persist the ForgotPassword webhook secret in the SAME
  // transaction as the LOGTO_* keys. config-guard's crossKeyInvariants
  // rejects a partial Logto key-set, so writing the secret on its own
  // (before these keys land) fails; bundling it here satisfies the
  // invariant and keeps the connector secret in sync with the host server.
  if (options.persistConfig) {
    await options.persistConfig(cfg);
  } else {
    const operations = [...buildLogtoEnvOperations(cfg)];
    if (options.forgotPasswordRelay) {
      operations.push({
        type: "set",
        key: FORGOT_PASSWORD_WEBHOOK_SECRET_KEY,
        value: options.forgotPasswordRelay.webhookSecret,
      });
    }
    const txn = await runConfigTransaction({
      operations,
      healthCheck: "none",
      overwrite: true,
      reason: "M051 logto bootstrap",
      actor: "cli",
    });
    if (!txn.success) {
      throw new Error(
        `config-guard rejected LOGTO_* write: ${txn.error ?? "unknown"}`,
      );
    }
  }

  // Step 14: persist the generated password before reporting the credential
  // location. Never print it to stdout: deploy output is routinely captured.
  if (probe.alreadyBootstrapped) {
    log("[bootstrap-logto] upgrade-path: app provisioning + env write complete");
    return cfg;
  }
  if (options.persistAdminCredential !== false) {
    ensureLogtoAdminCredentialFile({
      adminUrl: adminEndpoint,
      username: adminUsername,
      password: adminPassword,
    });
    const banner = formatBootstrapBanner({
      adminUrl: adminEndpoint,
      username: adminUsername,
      envPath: options.envPath ?? resolveDotenvPath(),
      passwordPolicyDisabled: true,
    });
    process.stdout.write(banner);
  }
  return cfg;
}

// ---------------------------------------------------------------------
// M120 — host-run dev server ForgotPassword relay.
//
// The compose-driver (`nautilo deploy`) runs `nautilo-server` as a
// container and reconciles the Logto `http-email` connector against
// container DNS (`http://nautilo-server:3001/...`) via
// `bootstrapLogtoForProfile`. The dev flow (`infra:start` + host-run
// `bun run server`, and `bin/nautilo-local --with-logto`) instead runs
// the server ON THE HOST, so the Logto container must reach it via
// `host.docker.internal:<serverPort>`. Without this wiring the dev path
// never enables `forgotPasswordMethods: ["EmailVerificationCode"]`, and
// Logto silently degrades `first_screen=reset_password` to the sign-in
// screen.
// ---------------------------------------------------------------------

export const FORGOT_PASSWORD_WEBHOOK_SECRET_KEY =
  "NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET";

/**
 * The webhook URL the Logto container POSTs ForgotPassword codes to when
 * the Nautilo server runs on the host (dev flow). `host.docker.internal`
 * resolves to the host from inside the container (built-in on Docker
 * Desktop; provided via `extra_hosts: host-gateway` on Linux — see
 * `infra/compose/nautilo.yml`).
 */
export function buildHostDevWebhookEndpoint(serverPort: number): string {
  return `http://host.docker.internal:${serverPort}/api/internal/logto/email-webhook`;
}

/** Parse a single dotenv `KEY=value` (quote-tolerant). Pure. */
export function parseDotenvSecret(
  raw: string,
  key: string,
): string | undefined {
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    if (t.slice(0, eq).trim() !== key) continue;
    let value = t.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value.trim().length > 0 ? value : undefined;
  }
  return undefined;
}

export interface HostDevRelaySecretDeps {
  /** Reads the instance.env file contents (returns "" if missing). */
  readInstanceEnv: () => string;
  /** Random secret generator. */
  randomSecret: () => string;
}

/**
 * Read-or-generate the shared webhook secret. Reuses an already-persisted
 * value from instance.env (idempotent re-runs) or mints a fresh one. This
 * function is deliberately WRITE-FREE: the secret is persisted atomically
 * with the `LOGTO_*` keys inside `runBootstrap` step 13, because
 * config-guard's `crossKeyInvariants` rejects any transaction that leaves
 * the Logto key-set partially populated (a standalone secret write on a
 * pre-bootstrap instance.env trips "every LOGTO_* key must be set").
 */
export function resolveHostDevWebhookSecret(
  deps: HostDevRelaySecretDeps,
): string {
  const existing = parseDotenvSecret(
    deps.readInstanceEnv(),
    FORGOT_PASSWORD_WEBHOOK_SECRET_KEY,
  );
  return existing ?? deps.randomSecret();
}

function defaultHostDevRelaySecretDeps(): HostDevRelaySecretDeps {
  return {
    readInstanceEnv: () => {
      try {
        return readFileSync(resolveDotenvPath(), "utf8");
      } catch {
        return "";
      }
    },
    randomSecret: () => randomBytes(24).toString("hex"),
  };
}

/**
 * Build the `forgotPasswordRelay` option for the host-run dev server
 * topology: a `host.docker.internal:<serverPort>` webhook target plus a
 * read-or-generated shared secret. `runBootstrap` persists the secret to
 * instance.env alongside the `LOGTO_*` keys.
 */
export function resolveHostDevForgotPasswordRelay(
  deps: HostDevRelaySecretDeps = defaultHostDevRelaySecretDeps(),
): { webhookEndpoint: string; webhookSecret: string } {
  const inst = resolveInstance();
  return {
    webhookEndpoint: buildHostDevWebhookEndpoint(inst.server.port),
    webhookSecret: resolveHostDevWebhookSecret(deps),
  };
}

// CLI runner: `bun bin/nautilo-local/src/bootstrap-logto.ts` runs the
// bootstrap directly (used by `infra:start`, `bin/nautilo-local
// --with-logto`, and as an operator escape hatch). All of these run the
// server on the host, so wire the M120 ForgotPassword relay for the
// host-dev topology.
if (import.meta.main) {
  (async () => {
    const preserveProvisionedState = process.argv.includes(
      "--preserve-provisioned-state",
    );
    const forgotPasswordRelay = preserveProvisionedState
      ? undefined
      : resolveHostDevForgotPasswordRelay();
    await runBootstrap({
      preserveProvisionedState,
      ...(forgotPasswordRelay ? { forgotPasswordRelay } : {}),
    });
  })().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[bootstrap-logto] fatal: ${msg}`);
    process.exit(1);
  });
}
