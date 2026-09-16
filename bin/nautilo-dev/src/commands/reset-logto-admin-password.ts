/**
 * M059 follow-up — `nautilo-dev reset-logto-admin-password`.
 *
 * Existing M051 dev installs that pre-date M059 don't have
 * `~/.nautilo/logto-admin.txt`. The bootstrap idempotency probe
 * (`sign_in_mode='SignIn'`) fires on re-run and the script returns
 * before reaching M059's credential writer — by design (we don't
 * have the original plaintext password, Logto stores it
 * Argon2-hashed). This command closes that gap by ROTATING the
 * admin password to a freshly generated one and writing the file.
 *
 * Algorithm:
 *   1. Read the seeded `m-admin` M2M secret directly from Postgres
 *      (same trick `bootstrap-logto.ts` uses on first install).
 *   2. Mint a Management API token at the admin-tenant `/oidc/token`
 *      with `resource=https://admin.logto.app/api`.
 *   3. Look up the `nautilo_admin` user via
 *      `GET /api/users?search=nautilo_admin`.
 *   4. Generate a fresh 24-byte hex password.
 *   5. PATCH `/api/users/{id}/password` (M053 path —
 *      `POST /api/users/{id}/password-reset` does NOT exist on
 *      Logto OSS).
 *   6. Write `~/.nautilo/logto-admin.txt` with chmod 600,
 *      OVERWRITING any existing file (rotation IS the point).
 *
 * Pure runner takes injectable deps so tests cover every branch
 * without docker / Postgres / Logto / disk.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveInstance, resolveNautiloRootDir } from "@nautilo/config";
import { resolveLogtoContainer } from "../lib/logto-db";

export interface ResetAdminPasswordArgs {
  /** Override `LOGTO_ENDPOINT` (defaults to env / resolved Logto core URL). */
  endpoint?: string | undefined;
  /** Override admin-tenant endpoint (defaults to env / resolved admin port). */
  adminEndpoint?: string | undefined;
  /** Override Logto compose Postgres container (defaults to `resolveLogtoContainer()`). */
  container?: string | undefined;
  /** Override the target file path. */
  outputPath?: string | undefined;
}

export interface ResetAdminPasswordDeps {
  /**
   * Reads the plaintext `m-admin` M2M secret from
   * `applications` in `logto_nautilo`. Real impl shells `docker exec
   * <logto-postgres-container> psql ...` (mirrors `lib/logto-db.ts`'s
   * pattern); tests inject a literal string.
   */
  readMAdminSecret: () => Promise<string>;
  /**
   * Mints a `resource=https://admin.logto.app/api` token at the
   * admin-tenant `/oidc/token`. Real impl uses `globalThis.fetch`.
   */
  mintAdminToken: (
    adminEndpoint: string,
    secret: string,
  ) => Promise<string>;
  /**
   * GETs `/api/users?search=nautilo_admin` and returns the user id.
   * Returns null if the user doesn't exist (caller surfaces a clean
   * error — `bootstrap-logto` should run first).
   */
  findAdminUserId: (
    adminEndpoint: string,
    token: string,
  ) => Promise<string | null>;
  /**
   * PATCHes `/api/users/{id}/password` with `{ password }`. Throws on
   * non-2xx.
   */
  setUserPassword: (
    adminEndpoint: string,
    token: string,
    userId: string,
    password: string,
  ) => Promise<void>;
  /** Generates the new password. Default: 24 random hex bytes. */
  generatePassword?: () => string;
  /** Writes the credential file. Default: chmod-600 atomic writer. */
  writeCredentialFile?: (path: string, contents: string) => void;
  /** Logger; default `console.log`. */
  log?: (msg: string) => void;
  /** ISO timestamp for the file's `Created:` header. */
  isoStamp?: () => string;
}

const ADMIN_USERNAME = "nautilo_admin";
const ADMIN_RESOURCE = "https://admin.logto.app/api";
const M_ADMIN_CLIENT_ID = "m-admin";
const CREDENTIAL_FILENAME = "logto-admin.txt";

/**
 * File body shape — mirrors the `formatLogtoAdminCredentialFile`
 * helper in `bin/nautilo-local/src/bootstrap-logto.ts`. Kept in
 * sync via the unit test in `tests/unit/reset-logto-admin-password.test.ts`
 * which asserts byte-for-byte parity (drift would silently break
 * the docs that reference this format).
 *
 * Exported so the test can consume it without re-implementing.
 */
export function formatCredentialFile(input: {
  username: string;
  password: string;
  adminUrl: string;
  isoStamp: string;
}): string {
  return [
    "# Logto admin console credential",
    `# Console: ${input.adminUrl}`,
    `# Created: ${input.isoStamp}`,
    `username: ${input.username}`,
    `password: ${input.password}`,
    "",
    "# Rotate after first login via the console.",
    "# Safe to delete once you've changed the password.",
    "",
  ].join("\n");
}

/** Pure runner — exit code only. */
export async function runResetLogtoAdminPassword(
  args: ResetAdminPasswordArgs,
  deps: ResetAdminPasswordDeps,
): Promise<number> {
  const log = deps.log ?? console.log;
  const generatePassword =
    deps.generatePassword ?? (() => randomBytes(24).toString("hex"));
  const writeCredentialFile = deps.writeCredentialFile ?? defaultAtomicWriter;
  const isoStamp = deps.isoStamp ?? (() => new Date().toISOString());

  const endpoint =
    args.endpoint ??
    process.env["LOGTO_ENDPOINT"] ??
    "http://localhost:3301";
  const adminEndpoint =
    args.adminEndpoint ??
    process.env["LOGTO_ADMIN_ENDPOINT"] ??
    endpoint.replace(":3301", ":3302");
  const outputPath =
    args.outputPath?.trim() ||
    join(resolveNautiloRootDir(), CREDENTIAL_FILENAME);

  log("[reset-logto-admin-password] reading m-admin secret from Postgres...");
  let mAdminSecret: string;
  try {
    mAdminSecret = await deps.readMAdminSecret();
  } catch (err) {
    log(
      `[reset-logto-admin-password] could not read m-admin secret: ${err instanceof Error ? err.message : String(err)}`,
    );
    log(
      "[reset-logto-admin-password] hint: is the compose stack running? `bun run infra:start`",
    );
    return 1;
  }

  log("[reset-logto-admin-password] minting admin Management API token...");
  let token: string;
  try {
    token = await deps.mintAdminToken(adminEndpoint, mAdminSecret);
  } catch (err) {
    log(
      `[reset-logto-admin-password] token mint failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  log(`[reset-logto-admin-password] looking up ${ADMIN_USERNAME}...`);
  let adminId: string | null;
  try {
    adminId = await deps.findAdminUserId(adminEndpoint, token);
  } catch (err) {
    log(
      `[reset-logto-admin-password] user lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  if (!adminId) {
    log(
      `[reset-logto-admin-password] ${ADMIN_USERNAME} not found in Logto.`,
    );
    log(
      "[reset-logto-admin-password] hint: run `bun run infra:start` to provision the admin user, then re-run this command.",
    );
    return 1;
  }

  const newPassword = generatePassword();
  log("[reset-logto-admin-password] rotating password...");
  try {
    await deps.setUserPassword(adminEndpoint, token, adminId, newPassword);
  } catch (err) {
    log(
      `[reset-logto-admin-password] password rotation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  const contents = formatCredentialFile({
    username: ADMIN_USERNAME,
    password: newPassword,
    adminUrl: adminEndpoint,
    isoStamp: isoStamp(),
  });
  try {
    writeCredentialFile(outputPath, contents);
  } catch (err) {
    log(
      `[reset-logto-admin-password] file write failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    log(
      `[reset-logto-admin-password] new password (write it down NOW): ${newPassword}`,
    );
    return 1;
  }

  log("");
  log(`[reset-logto-admin-password] OK — new password written to ${outputPath} (chmod 600)`);
  log(`[reset-logto-admin-password] admin console: ${adminEndpoint}`);
  log(`[reset-logto-admin-password] username:      ${ADMIN_USERNAME}`);
  return 0;
}

function defaultAtomicWriter(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, contents, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

// ---------------------------------------------------------------------------
// Production entry — wires real `docker exec psql` + `fetch` deps.
// ---------------------------------------------------------------------------

export async function resetLogtoAdminPassword(
  args: ResetAdminPasswordArgs,
): Promise<number> {
  const { execSync } = await import("node:child_process");
  const inst = resolveInstance();
  const container = args.container?.trim() || resolveLogtoContainer();

  return runResetLogtoAdminPassword(
    {
      ...args,
      endpoint:
        args.endpoint ??
        process.env["LOGTO_ENDPOINT"] ??
        `http://localhost:${inst.logto.corePort}`,
      adminEndpoint:
        args.adminEndpoint ??
        process.env["LOGTO_ADMIN_ENDPOINT"] ??
        `http://localhost:${inst.logto.adminPort}`,
    },
    {
    readMAdminSecret: () => {
      // Mirrors `bootstrap-logto.ts:probePostgres` step 2 but via
      // `docker exec psql` instead of the `postgres` driver — keeps
      // the dev-tools package's dependency footprint minimal (no
      // Postgres client driver needed just for one row read). The
      // wrapper is sync internally; we return Promise.resolve() so
      // the dep contract (`Promise<string>`) stays uniform with
      // tests that DO mock async work.
      const out = execSync(
        `docker exec ${container} psql -U postgres -t -A -c "SELECT secret FROM applications WHERE id='${M_ADMIN_CLIENT_ID}'" logto_nautilo`,
        { stdio: ["ignore", "pipe", "pipe"] },
      )
        .toString()
        .trim();
      if (!out) {
        return Promise.reject(
          new Error(
            `m-admin secret not found in logto_nautilo.applications — has logto-seed run?`,
          ),
        );
      }
      return Promise.resolve(out);
    },
    mintAdminToken: async (adminEndpoint, secret) => {
      const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: M_ADMIN_CLIENT_ID,
        client_secret: secret,
        resource: ADMIN_RESOURCE,
        scope: "all",
      });
      const res = await fetch(`${adminEndpoint}/oidc/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!res.ok) {
        throw new Error(
          `M2M token mint failed: HTTP ${res.status} ${await res.text()}`,
        );
      }
      const json = (await res.json()) as { access_token: string };
      return json.access_token;
    },
    findAdminUserId: async (adminEndpoint, token) => {
      const res = await fetch(
        `${adminEndpoint}/api/users?search=${encodeURIComponent(ADMIN_USERNAME)}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        throw new Error(`GET /api/users → HTTP ${res.status} ${await res.text()}`);
      }
      const users = (await res.json()) as Array<{ id: string; username?: string }>;
      const match = users.find((u) => u.username === ADMIN_USERNAME);
      return match?.id ?? null;
    },
    setUserPassword: async (adminEndpoint, token, userId, password) => {
      const res = await fetch(`${adminEndpoint}/api/users/${userId}/password`, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        throw new Error(
          `PATCH /api/users/${userId}/password → HTTP ${res.status} ${await res.text()}`,
        );
      }
    },
  });
}
