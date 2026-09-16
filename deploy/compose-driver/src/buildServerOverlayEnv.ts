import {
  getPasswordRecoveryDriver,
  type PasswordRecoveryDriver,
  type ResolvedInstance,
} from "@nautilo/config";

/**
 * The post-bootstrap `LOGTO_*` keys read off `~/.nautilo${suffix}/instance.env`.
 * Only the keys the server actually needs are typed here; extra keys
 * are tolerated and passed through.
 */
export interface InstanceLogtoEnv {
  LOGTO_ENDPOINT?: string;
  LOGTO_ISSUER?: string;
  LOGTO_JWKS_URI?: string;
  LOGTO_RESOURCE?: string;
  LOGTO_WORKBENCH_APP_ID?: string;
  LOGTO_TUI_APP_ID?: string;
  LOGTO_TUI_LOOPBACK_APP_ID?: string;
  LOGTO_DESKTOP_APP_ID?: string;
  LOGTO_MOBILE_APP_ID?: string;
  LOGTO_MOBILE_WEB_APP_ID?: string;
  LOGTO_M2M_APP_ID?: string;
  LOGTO_M2M_APP_SECRET?: string;
}

/**
 * Pure helper. Builds the env overlay handed to `nautilo-server`
 * after `bootstrap-logto` has provisioned the deploy-stack Logto
 * instance.
 *
 * `LOGTO_ENDPOINT` (kept host-facing) serves two CLIENT-FACING uses:
 *   - reported via `GET /health` → workbench / desktop read it
 *   - workbench SPA uses it to build the OIDC sign-in redirect URL
 *     the operator's BROWSER follows; browser can't resolve docker
 *     DNS, so the URL must stay `http://localhost:<corePort>`.
 *
 * For three SERVER-FETCH paths the server reaches Logto over the
 * deploy-net docker network — `localhost:<corePort>` inside the
 * container is the server itself, not Logto — so we expose container
 * DNS via dedicated env vars the consumers prefer when set:
 *
 *   - `LOGTO_ENDPOINT_INTERNAL`  ← container-DNS `http://logto:<corePort>`
 *     consumed by `packages/trust/src/logto-admin.ts` (Management API
 *     M2M token mint on the redeem hot path), `logto-clock-skew.ts`,
 *     and `server/lib/logto-bearer-session-after-trusted-auth.ts`.
 *     All three fall back to `LOGTO_ENDPOINT` when unset, so
 *     `bun run server` (no overlay) keeps the single-URL world.
 *   - `LOGTO_JWKS_URI` is rewritten in place (no client-facing reader)
 *     — used by `jose.createRemoteJWKSet` for JWT verification.
 *
 * `LOGTO_ISSUER` is NEVER rewritten: Logto sets `iss` on issued JWTs
 * to its `ENDPOINT` env (host-facing) and `jose.jwtVerify` must
 * string-match that exact value. The server only compares; it does
 * not fetch the issuer URL.
 *
 * Bootstrap writes the host-facing forms into `instance.env` so
 * Bun-on-host clients (`bun run server`, workbench dev) keep working
 * untouched. The overlay only changes the container's runtime env.
 */
export interface BuildServerOverlayEnvOptions {
  /**
   * Override the Logto core port used for Docker-internal server fetches.
   *
   * Adopted remote deployments can retain operator-local ports in
   * `instance.json` that differ from the running remote Compose stack. Remote
   * callers must pass the inspected live port so the generated `logto` DNS
   * URLs address the actual container listener.
   */
  containerCorePort?: number | undefined;
  /**
   * M120 — the Logto http-email webhook secret. When set, exposed to the
   * server container so its `/api/internal/logto/email-webhook` receiver
   * authenticates the connector's `Authorization: Bearer <secret>`. Threaded
   * explicitly (not re-read from instance.env) so it always matches the value
   * the bootstrap configured on the Logto connector.
   */
  forgotPasswordWebhookSecret?: string | undefined;
  /** D458 — stable HMAC pepper for remote-controller pairing challenges. */
  remotePairingPepper?: string | undefined;
  /** D468 — per-instance AES-256 key for protected Expo push tokens. */
  pushTokenEncryptionKey?: string | undefined;
  passwordRecoveryDriver?: PasswordRecoveryDriver | undefined;
}

export function buildServerOverlayEnv(
  inst: ResolvedInstance,
  instanceEnv: InstanceLogtoEnv,
  options: BuildServerOverlayEnvOptions = {},
): Record<string, string> {
  const corePort = options.containerCorePort ?? inst.logto.corePort;
  const out: Record<string, string> = {};
  out["NAUTILO_INSTANCE_ID"] = inst.instanceId;
  out["NAUTILO_PUBLIC_BASE_URL"] = inst.server.url;
  out["NAUTILO_PASSWORD_RECOVERY_DRIVER"] =
    options.passwordRecoveryDriver ?? getPasswordRecoveryDriver();

  if (
    options.forgotPasswordWebhookSecret !== undefined &&
    options.forgotPasswordWebhookSecret.trim().length > 0
  ) {
    out["NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET"] =
      options.forgotPasswordWebhookSecret;
  }

  const remotePairingPepper = options.remotePairingPepper;
  if (remotePairingPepper !== undefined && remotePairingPepper.trim().length > 0) {
    out["NAUTILO_REMOTE_PAIRING_PEPPER"] = remotePairingPepper;
  }

  const pushTokenEncryptionKey = options.pushTokenEncryptionKey;
  if (pushTokenEncryptionKey !== undefined && pushTokenEncryptionKey.trim().length > 0) {
    out["NAUTILO_PUSH_TOKEN_ENCRYPTION_KEY"] = pushTokenEncryptionKey;
  }

  const localhostOrigin = `http://localhost:${corePort}`;
  const containerOrigin = `http://logto:${corePort}`;
  const localhostJwks = `${localhostOrigin}/oidc/jwks`;
  const containerJwks = `${containerOrigin}/oidc/jwks`;

  const endpoint = instanceEnv.LOGTO_ENDPOINT;
  const hostFacingComposeEndpoint =
    endpoint !== undefined &&
    (endpoint === localhostOrigin || isHttpCorePortEndpoint(endpoint, corePort));

  if (endpoint !== undefined) {
    // Pass through unchanged — workbench / desktop / health route
    // consume this and run in the operator's browser.
    out["LOGTO_ENDPOINT"] = endpoint;
    // Compose deploy (local localhost OR remote public IP:port): the
    // server container reaches Logto via deploy-net DNS, not the
    // host-facing URL written by bootstrap into instance.env.
    if (hostFacingComposeEndpoint) {
      out["LOGTO_ENDPOINT_INTERNAL"] = containerOrigin;
    }
  }
  if (instanceEnv.LOGTO_ISSUER !== undefined) {
    out["LOGTO_ISSUER"] = instanceEnv.LOGTO_ISSUER;
  }
  if (instanceEnv.LOGTO_RESOURCE !== undefined) {
    out["LOGTO_RESOURCE"] = instanceEnv.LOGTO_RESOURCE;
  }

  const sourceJwks = instanceEnv.LOGTO_JWKS_URI;
  if (sourceJwks !== undefined) {
    const hostFacingJwks =
      endpoint !== undefined ? `${endpoint.replace(/\/$/, "")}/oidc/jwks` : undefined;
    out["LOGTO_JWKS_URI"] =
      sourceJwks === localhostJwks ||
      (hostFacingJwks !== undefined && sourceJwks === hostFacingJwks)
        ? containerJwks
        : sourceJwks;
  }

  for (const k of [
    "LOGTO_WORKBENCH_APP_ID",
    "LOGTO_TUI_APP_ID",
    "LOGTO_TUI_LOOPBACK_APP_ID",
    "LOGTO_DESKTOP_APP_ID",
    "LOGTO_MOBILE_APP_ID",
    "LOGTO_MOBILE_WEB_APP_ID",
    "LOGTO_M2M_APP_ID",
    "LOGTO_M2M_APP_SECRET",
  ] as const) {
    const v = instanceEnv[k];
    if (v !== undefined) out[k] = v;
  }

  return out;
}

/** Local compose + remote droplet URLs bootstrap writes as `http://<host>:<corePort>`. */
function isHttpCorePortEndpoint(endpoint: string, corePort: number): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === "http:" && u.port === String(corePort);
  } catch {
    return false;
  }
}
