/**
 * M196 — pure helpers for Google OAuth server status + local client config.
 *
 * Kept Electron-free so unit tests can mock fetch/fs/exec without booting the app.
 */

export const GOOGLE_OAUTH_CLIENT_FILENAME = "google-oauth-client.json";

export const GOOGLE_AUTH_REQUIRED_ERROR_CODE = "google_auth_required";

const GOOGLE_AUTH_REQUIRED_MESSAGE =
  "Google Workspace is not connected on this device (or the login expired). " +
  "Ask the user to connect via the Connect Google Workspace button, then retry.";

const GOG_AUTH_SERVICES = [
  "drive",
  "docs",
  "gmail",
  "calendar",
  "sheets",
  "slides",
  "forms",
  "appscript",
  "contacts",
  "tasks",
] as const;

const GOG_AUTH_FAILURE_PATTERN =
  /\b(oauth|auth|login|credentials?|token|refresh|expired|unauthorized)\b/i;

export function isValidConnectEmail(email: string): boolean {
  const trimmed = email.trim();
  return trimmed.length > 0 && trimmed.includes("@");
}

export function isLikelyGogAuthFailure(detail: string): boolean {
  return GOG_AUTH_FAILURE_PATTERN.test(detail);
}

export function googleAuthRequiredDispatchResult(): {
  status: "error";
  errorCode: typeof GOOGLE_AUTH_REQUIRED_ERROR_CODE;
  error: string;
} {
  return {
    status: "error",
    errorCode: GOOGLE_AUTH_REQUIRED_ERROR_CODE,
    error: GOOGLE_AUTH_REQUIRED_MESSAGE,
  };
}

function extractEmailFromAuthEntry(entry: unknown): string[] {
  if (typeof entry === "string" && entry.includes("@")) return [entry];
  if (!entry || typeof entry !== "object") return [];
  const obj = entry as Record<string, unknown>;
  for (const key of ["email", "account", "id", "name"]) {
    const value = obj[key];
    if (typeof value === "string" && value.includes("@")) return [value];
  }
  return [];
}

/** Best-effort parse of `gog auth list --json` stdout. */
export function parseGogAuthListAccounts(stdout: string): string[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return [...new Set(parsed.flatMap(extractEmailFromAuthEntry))];
    }
    if (parsed && typeof parsed === "object") {
      const accounts = (parsed as Record<string, unknown>)["accounts"];
      if (Array.isArray(accounts)) {
        return [...new Set(accounts.flatMap(extractEmailFromAuthEntry))];
      }
      const single = extractEmailFromAuthEntry(parsed);
      if (single.length > 0) return single;
    }
  } catch {
    // fall through to regex extraction
  }
  const matches = trimmed.match(/[\w.+-]+@[\w.-]+\.\w+/g);
  return matches ? [...new Set(matches)] : [];
}

/**
 * `gog auth list --check --json --no-input` can exit successfully while its
 * listed accounts report a failed token refresh. Treat the JSON validity bit
 * as the authority signal; textual/legacy output cannot prove a usable
 * session and must fail closed.
 */
export function hasHealthyGogAuthAccount(stdout: string): boolean {
  try {
    const parsed: unknown = JSON.parse(stdout);
    let accounts: unknown[] = [];
    if (Array.isArray(parsed)) {
      accounts = parsed;
    } else if (parsed && typeof parsed === "object") {
      const nestedAccounts = (parsed as Record<string, unknown>)["accounts"];
      if (Array.isArray(nestedAccounts)) accounts = nestedAccounts;
    }
    return accounts.some(
      (account) =>
        account !== null &&
        typeof account === "object" &&
        (account as Record<string, unknown>)["valid"] === true,
    );
  } catch {
    return false;
  }
}

export async function queryGoogleOAuthConfigured(
  serverUrl: string,
  token: string | undefined,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  const base = serverUrl.replace(/\/$/, "");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  try {
    const res = await fetchImpl(`${base}/api/integrations/google/status`, { headers });
    if (res.status === 401 || res.status === 403 || res.status === 404) return false;
    if (!res.ok) return false;
    const body = (await res.json()) as { configured?: unknown };
    return body.configured === true;
  } catch {
    return false;
  }
}

/**
 * Google Workspace is a local gog capability. A server-managed OAuth client
 * can make gog usable for a newly connected account, while an existing healthy
 * local gog session is already usable without one. In both cases the relay
 * must still be runnable; server policy continues to decide whether the
 * resulting capability is granted to the actor.
 */
export function canAdvertiseGoogleWorkspaceCapability(args: {
  gogRunnable: boolean;
  serverOAuthConfigured: boolean;
  localGogAuthHealthy: boolean;
}): boolean {
  return args.gogRunnable && (args.serverOAuthConfigured || args.localGogAuthHealthy);
}

type GogExecFileAsync = (
  file: string,
  args: readonly string[],
  opts?: { timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

export type GogKeyringBackend = "file" | "keychain" | "auto";

/**
 * M196 — which keyring backend gog should use.
 *
 * Default is `file`: gog is Developer-ID signed, but it rewrites the
 * short-lived access-token keychain item on every operation (delete+add),
 * so macOS re-prompts even after "Always Allow" (the grant is tied to the
 * specific item that keeps getting recreated). A chmod-600 file keyring
 * removes the OS prompt entirely (plaintext-at-rest tradeoff). Override with
 * `NAUTILO_GOG_KEYRING=keychain` (or `auto` to leave gog's own default).
 */
export function resolveGogKeyringBackend(
  env: NodeJS.ProcessEnv = process.env,
): GogKeyringBackend {
  const raw = env["NAUTILO_GOG_KEYRING"]?.trim().toLowerCase();
  if (raw === "keychain" || raw === "auto") return raw;
  return "file";
}

/** Best-effort: pin gog's keyring backend before any token read/write. */
export async function ensureGogKeyringBackend(
  bin: string,
  execFileAsync: GogExecFileAsync,
): Promise<void> {
  const backend = resolveGogKeyringBackend();
  if (backend === "auto") return;
  try {
    await execFileAsync(bin, ["auth", "keyring", "set", backend], {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    // Best-effort — never block the connect/dispatch flow on backend setup.
  }
}

export const GOG_KEYRING_PASSWORD_FILENAME = "gog-keyring-password";

export interface GogKeyringPasswordDeps {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string) => string;
  writeFileSync: (path: string, data: string, opts: { mode: number }) => void;
  randomPassword: () => string;
}

/**
 * M196 — the `file` keyring backend is ENCRYPTED and, in a non-interactive
 * context (relay-spawned gog has no TTY), requires `GOG_KEYRING_PASSWORD`.
 * Without it `gog auth credentials` / `auth add` / `auth list` fail.
 *
 * Persist a random password in a chmod-600 file so the encrypted keyring can
 * be read back across runs, and export it into `process.env` so every
 * relay-spawned gog child inherits it. No-op when the backend isn't `file` or
 * when an operator already provided the env var.
 */
export function ensureGogKeyringPasswordEnv(
  passwordPath: string,
  deps: GogKeyringPasswordDeps,
): void {
  if (resolveGogKeyringBackend() !== "file") return;
  const existing = process.env["GOG_KEYRING_PASSWORD"];
  if (existing && existing.length > 0) return;

  let password = "";
  try {
    if (deps.existsSync(passwordPath)) {
      password = deps.readFileSync(passwordPath).trim();
    }
  } catch {
    password = "";
  }
  if (!password) {
    password = deps.randomPassword();
    try {
      deps.writeFileSync(passwordPath, `${password}\n`, { mode: 0o600 });
    } catch {
      // Best-effort persistence; still export for this process lifetime.
    }
  }
  process.env["GOG_KEYRING_PASSWORD"] = password;
}

export interface EnsureGoogleOAuthClientDeps {
  fetchImpl: typeof fetch;
  existsSync: (path: string) => boolean;
  writeFile: (path: string, data: string, opts: { mode: number }) => Promise<void>;
  execFileAsync: GogExecFileAsync;
  resolveGogBin: () => string | null;
  oauthClientPath: string;
}

export async function ensureGoogleOAuthClientConfig(
  serverUrl: string,
  token: string,
  deps: EnsureGoogleOAuthClientDeps,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!deps.existsSync(deps.oauthClientPath)) {
    const base = serverUrl.replace(/\/$/, "");
    let res: Response;
    try {
      res = await deps.fetchImpl(`${base}/api/integrations/google/oauth-client`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
    } catch {
      return { ok: false, reason: "fetch_failed" };
    }

    if (res.status === 401) return { ok: false, reason: "not_signed_in" };
    if (res.status === 403) return { ok: false, reason: "capability_missing" };
    if (res.status === 404) return { ok: false, reason: "not_configured_on_server" };
    if (!res.ok) return { ok: false, reason: "fetch_failed" };

    const jsonText = await res.text();
    await deps.writeFile(deps.oauthClientPath, jsonText, { mode: 0o600 });
  }

  const bin = deps.resolveGogBin();
  if (!bin) return { ok: false, reason: "gog_missing" };

  // Pin the keyring backend BEFORE writing credentials/tokens so connect
  // (auth add) and dispatch (auth list --check) share one backend.
  await ensureGogKeyringBackend(bin, deps.execFileAsync);

  try {
    await deps.execFileAsync(bin, ["auth", "credentials", deps.oauthClientPath], {
      timeout: 45_000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    return { ok: false, reason: "gog_credentials_set_failed" };
  }

  return { ok: true };
}

const GOG_AUTH_TIMEOUT_MS = 45_000;

export interface GoogleWorkspaceAuthStatus {
  clientConfigOnServer: boolean;
  clientConfigLocal: boolean;
  connectedAccounts: string[];
  healthy: boolean;
  reason?: string;
}

export interface GoogleWorkspaceAuthStatusArgs {
  serverUrl: string;
  token?: string | undefined;
}

export interface GoogleWorkspaceConnectArgs {
  serverUrl: string;
  token?: string | undefined;
  email: string;
  refreshRelay: () => Promise<void>;
}

export interface GoogleWorkspaceDisconnectArgs {
  email: string;
  refreshRelay: () => Promise<void>;
}

export interface GoogleWorkspaceAuthDeps {
  fetchImpl: typeof fetch;
  writeFile: (filePath: string, data: string, opts: { mode: number }) => Promise<void>;
  execFileAsync: (
    file: string,
    args: readonly string[],
    opts?: { timeout?: number; maxBuffer?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  existsSync: (path: string) => boolean;
  resolveGogBin: () => string | null;
  isGogAuthHealthy: (bin: string) => Promise<boolean>;
  authorizeGogAccount: (args: {
    bin: string;
    email: string;
    services: string;
    onAuthorized: () => Promise<void>;
  }) => Promise<
    | { ok: true }
    | {
        ok: false;
        reason:
          | "google_auth_cancelled"
          | "google_auth_timed_out"
          | "gog_auth_add_failed";
      }
  >;
  oauthClientPath: string;
}

function ensureClientDeps(deps: GoogleWorkspaceAuthDeps): EnsureGoogleOAuthClientDeps {
  return {
    fetchImpl: deps.fetchImpl,
    existsSync: deps.existsSync,
    writeFile: deps.writeFile,
    execFileAsync: deps.execFileAsync,
    resolveGogBin: deps.resolveGogBin,
    oauthClientPath: deps.oauthClientPath,
  };
}

export async function googleWorkspaceAuthStatus(
  args: GoogleWorkspaceAuthStatusArgs,
  deps: GoogleWorkspaceAuthDeps,
): Promise<GoogleWorkspaceAuthStatus> {
  const clientConfigOnServer = await queryGoogleOAuthConfigured(
    args.serverUrl,
    args.token,
    deps.fetchImpl,
  );
  const clientConfigLocal = deps.existsSync(deps.oauthClientPath);

  const bin = deps.resolveGogBin();
  if (!bin) {
    return {
      clientConfigOnServer,
      clientConfigLocal,
      connectedAccounts: [],
      healthy: false,
      reason: "gog_missing",
    };
  }

  // Read status against the same backend connect/dispatch use.
  await ensureGogKeyringBackend(bin, deps.execFileAsync);

  try {
    const { stdout } = await deps.execFileAsync(
      bin,
      ["auth", "list", "--check", "--json", "--no-input"],
      { timeout: GOG_AUTH_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    const connectedAccounts = parseGogAuthListAccounts(stdout);
    const healthy = await deps.isGogAuthHealthy(bin);
    return {
      clientConfigOnServer,
      clientConfigLocal,
      connectedAccounts,
      healthy,
      ...(healthy ? {} : { reason: "auth_unhealthy" }),
    };
  } catch {
    return {
      clientConfigOnServer,
      clientConfigLocal,
      connectedAccounts: [],
      healthy: false,
      reason: "auth_check_failed",
    };
  }
}

export async function googleWorkspaceConnect(
  args: GoogleWorkspaceConnectArgs,
  deps: GoogleWorkspaceAuthDeps,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isValidConnectEmail(args.email)) {
    return { ok: false, reason: "invalid_email" };
  }
  if (!args.token) {
    return { ok: false, reason: "not_signed_in" };
  }

  const ensured = await ensureGoogleOAuthClientConfig(
    args.serverUrl,
    args.token,
    ensureClientDeps(deps),
  );
  if (!ensured.ok) return ensured;

  const bin = deps.resolveGogBin();
  if (!bin) return { ok: false, reason: "gog_missing" };

  const email = args.email.trim();
  const services = GOG_AUTH_SERVICES.join(",");
  return deps.authorizeGogAccount({
    bin,
    email,
    services,
    onAuthorized: async () => {
      if (!(await deps.isGogAuthHealthy(bin))) {
        throw new Error("gog_auth_unhealthy");
      }
      await args.refreshRelay();
    },
  });
}

export async function googleWorkspaceDisconnect(
  args: GoogleWorkspaceDisconnectArgs,
  deps: GoogleWorkspaceAuthDeps,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const email = args.email.trim();
  if (!isValidConnectEmail(email)) {
    return { ok: false, reason: "invalid_email" };
  }

  const bin = deps.resolveGogBin();
  if (!bin) return { ok: false, reason: "gog_missing" };

  try {
    await deps.execFileAsync(bin, ["auth", "remove", email], {
      timeout: GOG_AUTH_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    return { ok: false, reason: "gog_auth_remove_failed" };
  }

  await args.refreshRelay();
  return { ok: true };
}
