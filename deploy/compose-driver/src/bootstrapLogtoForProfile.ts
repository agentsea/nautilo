import {
  __resetResolvedInstanceForTests,
  resolveInstance,
} from "@nautilo/config";
import { resolveDotenvPath } from "@nautilo/config-guard";
import { runBootstrap as defaultRunBootstrap } from "@nautilo/local/bootstrap-logto";
import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  buildAppliedAuthContract,
  serializeAppliedAuthContract,
  type AppliedAuthContract,
} from "../../contracts/applied-auth-contract.ts";
import type { DbPasswords } from "./ensureDbPasswords.ts";
import { httpsMode } from "./https-mode.ts";
import { resolveLogtoPublicUrl } from "./instance-urls.ts";
import type { ComposeDriverProfile } from "./types.ts";

/**
 * Loose, structural type for the `runBootstrap` injection seam. Tests
 * pass a fake whose actual type may not exactly match the production
 * signature (e.g. closed-over variants). Production wiring uses the
 * real export.
 */
export type RunBootstrapFn = (options?: {
  endpoint?: string;
  adminEndpoint?: string;
  defaultTenantEndpoint?: string;
  resource?: string;
  postgresUrl?: string;
  envPath?: string;
  discoveryTimeoutMs?: number;
  /** M117 — see BootstrapOptions in bin/nautilo-local/src/bootstrap-logto.ts */
  extraWorkbenchRedirectUris?: readonly string[];
  /** M117 — see BootstrapOptions in bin/nautilo-local/src/bootstrap-logto.ts */
  extraWorkbenchPostLogoutUris?: readonly string[];
  /** M120 — see BootstrapOptions in bin/nautilo-local/src/bootstrap-logto.ts */
  forgotPasswordRelay?: {
    webhookEndpoint: string;
    webhookSecret: string;
  };
  unknownSessionRedirectUrl?: string;
}) => Promise<unknown>;

export interface BootstrapLogtoForProfileDeps {
  /** Injection seam for tests; defaults to the real `runBootstrap`. */
  runBootstrap?: RunBootstrapFn;
  /**
   * Injection seam for the resolveInstance() cache reset. Default
   * calls the test-named export from `@nautilo/config` — see comment
   * below; renaming that export is a post-M092 cleanup.
   */
  resetResolvedInstanceCache?: () => void;
  /** Injection seam; default `resolveDotenvPath()` from config-guard. */
  resolveDotenvPath?: () => string;
  /** Injection seam; default `resolveInstance()` from `@nautilo/config`. */
  resolveInstance?: typeof resolveInstance;
  /**
   * M116 — explicit per-instance DB passwords from `ensureDbPasswords`.
   * The `logto` field is used to build the `postgres://logto:<pw>@...`
   * URL bootstrap connects to. Default falls back to the legacy literal
   * `"logto"` for back-compat with callers that haven't migrated yet
   * (and for unit tests that don't exercise the password path).
   */
  dbPasswords?: Pick<DbPasswords, "logto"> & Partial<DbPasswords>;
  /**
   * M120 — the Logto http-email webhook secret (from
   * `ensureForgotPasswordWebhookSecret`). When set, the wrapper configures
   * Logto's `http-email` connector to deliver ForgotPassword codes to the
   * server container's webhook (`http://nautilo-server:3001/...` over
   * deploy-net) with `Authorization: Bearer <secret>`, and enables the
   * `EmailVerificationCode` forgot-password method. Omitted → M120 relay is
   * left unconfigured for this deploy.
   */
  forgotPasswordWebhookSecret?: string;
  /**
   * Operator-local tunnel ports for a remote target. HTTP ports intentionally
   * match the target's published ports so Logto receives the same authority
   * (including port) it uses for tenant routing.
   */
  remoteTunnelPorts?: {
    core: number;
    admin: number;
    db: number;
  };
  /**
   * Persists the secret-free applied contract after bootstrap succeeds.
   * Remote deployments keep this state in their deployment manifest, so the
   * driver supplies a remote writer there instead of creating a local stamp.
   */
  writeAppliedAuthContract?: (
    stamp: AppliedAuthContract,
    instanceRootDir: string,
  ) => Promise<void>;
}

/**
 * The server container's name + port on `deploy-net`. Logto (same network)
 * reaches the webhook receiver here — container DNS, not the public URL — so
 * the relay works identically for local and remote profiles and never round-
 * trips through Caddy/the internet.
 */
const SERVER_WEBHOOK_ENDPOINT =
  "http://nautilo-server:3001/api/internal/logto/email-webhook";
const APPLIED_AUTH_CONTRACT_FILE = "auth-contract-applied.json";

async function writeAppliedAuthContractAtomically(
  stamp: AppliedAuthContract,
  instanceRootDir: string,
): Promise<void> {
  const target = join(instanceRootDir, APPLIED_AUTH_CONTRACT_FILE);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, serializeAppliedAuthContract(stamp), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
}

/**
 * Host-side wrapper around `bin/nautilo-local/src/bootstrap-logto.ts`.
 * The wrapper is what makes Logto bootstrap multi-instance-aware:
 *
 * 1. Save and set `NAUTILO_INSTANCE_ID` to the profile's id (empty
 *    string for the shared default instance) so that downstream
 *    `resolveInstance()` + `resolveDotenvPath()` calls land under the
 *    correct `~/.nautilo${suffix}/` root.
 * 2. Reset the resolveInstance() cache. The CLI process may have
 *    called `resolveInstance()` already with a different (or empty)
 *    instance id; without the reset, the cached value sticks.
 *
 *    NOTE: `__resetResolvedInstanceForTests` is the only exported
 *    cache-reset entry today. Reusing it from production code is
 *    deliberate: the cache and the env-var precedence model are the
 *    same in tests and production. TODO: rename the export to
 *    something less test-flavored post-M092.
 * 3. Compute explicit `endpoint` + `postgresUrl` overrides from the
 *    profile's resolved instance and call `runBootstrap` with them
 *    so the deploy-stack ports (e.g. `corePort: 4301`,
 *    `logto.dbPort: 6432` in M114 territory) are used regardless of
 *    operator env state.
 * 4. Always restore the prior `NAUTILO_INSTANCE_ID` env value.
 */
export async function bootstrapLogtoForProfile(
  profile: ComposeDriverProfile,
  deps: BootstrapLogtoForProfileDeps = {},
): Promise<void> {
  const runBootstrap: RunBootstrapFn =
    deps.runBootstrap ?? (defaultRunBootstrap as unknown as RunBootstrapFn);
  const resetCache =
    deps.resetResolvedInstanceCache ?? __resetResolvedInstanceForTests;
  const resolveEnvPath = deps.resolveDotenvPath ?? resolveDotenvPath;
  const resolveInst = deps.resolveInstance ?? resolveInstance;

  const id = (profile.instance_id ?? "").trim();
  const prev = process.env["NAUTILO_INSTANCE_ID"];
  const prevHadKey = "NAUTILO_INSTANCE_ID" in process.env;
  const prevDotenvPath = process.env["NAUTILO_DOTENV_PATH"];
  const prevHadDotenvPath = "NAUTILO_DOTENV_PATH" in process.env;
  process.env["NAUTILO_INSTANCE_ID"] = id;
  resetCache();

  try {
    const inst = resolveInst();
    const corePort =
      deps.remoteTunnelPorts?.core ?? inst.logto.corePort;
    const adminPort =
      deps.remoteTunnelPorts?.admin ?? inst.logto.adminPort;
    const logtoDbPort =
      deps.remoteTunnelPorts?.db ?? inst.logto.dbPort;
    // M116 — `LOGTO_DB_PASSWORD` is per-instance random. Take it from
    // `deps.dbPasswords.logto` when provided (production path —
    // ComposeDriver.deploy passes the resolved passwords). Fall back to
    // the legacy literal `"logto"` only for the M114 / dev-smoke path
    // and tests that don't exercise random passwords.
    const dbPassword = deps.dbPasswords?.logto ?? "logto";
    // For remote profiles the endpoint MUST be the public URL — it ends
    // up in operator's instance.env as `LOGTO_ENDPOINT`, which the
    // server reports via /health and the CLI's `nautilo login` opens
    // in the browser. Using `localhost:<corePort>` only works during
    // the SSH tunnel scope; after the tunnel closes, the URL is dead.
    // (The tunnel still covers the postgres port on `localhost:<dbPort>`
    // because we don't want to require the DB port to be publicly
    // reachable — Logto bootstrap connects to postgres directly.)
    const endpoint =
      profile.transport === "remote"
        ? resolveLogtoPublicUrl(profile, inst)
        : `http://localhost:${corePort}`;
    const postgresUrl = `postgres://logto:${encodeURIComponent(dbPassword)}@localhost:${logtoDbPort}/logto_nautilo`;
    const envPath = resolveEnvPath();
    // config-guard's transaction resolves its target from process state.
    // Pin it to the same explicit path passed to runBootstrap so remote
    // reconciliation can use a bounded temporary copy of the target's
    // canonical instance.env rather than mutating unrelated operator state.
    process.env["NAUTILO_DOTENV_PATH"] = envPath;
    // M117 — in https=letsencrypt mode, the workbench is served from
    // `https://<domain>` and its SPA OIDC client emits a redirect_uri
    // of `https://<domain>/auth/callback`. `deriveWorkbenchOidcRedirectUris`
    // inside runBootstrap only knows about operator-side LAN URLs
    // (localhost:<server>/auth/callback etc.), so without this the
    // workbench sign-in fails with oidc.invalid_redirect_uri. Pass
    // the LE URIs through; runBootstrap set-unions them with the LAN
    // set, and the ensureApp reconciler does set-union PATCH on every
    // re-deploy.
    let extraWorkbenchRedirectUris: string[] | undefined;
    let extraWorkbenchPostLogoutUris: string[] | undefined;
    let extraMobileWebRedirectUris: string[] | undefined;
    let extraMobileWebPostLogoutUris: string[] | undefined;
    if (
      httpsMode(profile) === "letsencrypt" &&
      typeof profile.domain === "string" &&
      profile.domain.trim().length > 0
    ) {
      const origin = `https://${profile.domain.trim()}`;
      extraWorkbenchRedirectUris = [`${origin}/auth/callback`];
      extraWorkbenchPostLogoutUris = [origin, `${origin}/logout`];
      extraMobileWebRedirectUris = [`${origin}/mobile/callback`];
      extraMobileWebPostLogoutUris = [`${origin}/mobile`];
    }
    await runBootstrap({
      endpoint,
      ...(profile.transport === "remote"
        ? {
            adminEndpoint: `http://127.0.0.1:${adminPort}`,
            defaultTenantEndpoint: `http://127.0.0.1:${corePort}`,
          }
        : {}),
      postgresUrl,
      envPath,
      ...(extraWorkbenchRedirectUris
        ? { extraWorkbenchRedirectUris }
        : {}),
      ...(extraWorkbenchPostLogoutUris
        ? { extraWorkbenchPostLogoutUris }
        : {}),
      ...(extraMobileWebRedirectUris
        ? { extraMobileWebRedirectUris }
        : {}),
      ...(extraMobileWebPostLogoutUris
        ? { extraMobileWebPostLogoutUris }
        : {}),
      ...(deps.forgotPasswordWebhookSecret
        ? {
            forgotPasswordRelay: {
              webhookEndpoint: SERVER_WEBHOOK_ENDPOINT,
              webhookSecret: deps.forgotPasswordWebhookSecret,
            },
          }
        : {}),
      unknownSessionRedirectUrl: inst.server.url,
    });
    if (profile.transport !== "remote") {
      const stamp = buildAppliedAuthContract(new Date().toISOString());
      await (deps.writeAppliedAuthContract ?? writeAppliedAuthContractAtomically)(
        stamp,
        dirname(envPath),
      );
    }
  } finally {
    if (prevHadKey) {
      process.env["NAUTILO_INSTANCE_ID"] = prev;
    } else {
      delete process.env["NAUTILO_INSTANCE_ID"];
    }
    if (prevHadDotenvPath) {
      process.env["NAUTILO_DOTENV_PATH"] = prevDotenvPath;
    } else {
      delete process.env["NAUTILO_DOTENV_PATH"];
    }
    resetCache();
  }
}
