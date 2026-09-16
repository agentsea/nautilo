import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import type { MaintenanceState } from "@nautilo/types";
import { check, getModeReport } from "@nautilo/config-guard";
import { getPasswordRecoveryDriver, resolveInstance } from "@nautilo/config";
import { requestAllowsLoopbackTrust, requestAllowsOwnerOrLoopback } from "../lib/request-trust";
import type { PinChallengeProvider } from "@nautilo/trust";
import { getUserCapabilities } from "@nautilo/trust";
import { resolvePublicServerUrl, resolvePublicWorkbenchUrl } from "../lib/public-urls";
import { managedProviderCredentialRouteIsBlocked } from "../managed-provider-route-inventory";

export interface HealthRouteDeps {
  pinProvider?: PinChallengeProvider | undefined;
  /**
   * M043: the PIN-subject identifier is a `users.id` now, not an
   * `actors.id`. `credentials.user_id` is what `isEnrolled` queries.
   * Pre-M043 this field was `ownerActorId`; the rename here is the
   * real fix, not cosmetic — keying on the actor id would always
   * miss post-migration and `/health` would report `enrolled: false`
   * for a user with a valid PIN.
   */
  ownerId?: string | undefined;
  /**
   * D112 — when provided with `pinProvider` + `ownerId`, replaces the legacy
   * `pinProvider.isEnrolled(ownerId)` value for `/health.enrolled` with the
   * canonical setup-state bridge (`hasAdminUser && !hasUnredeemedClaimInvite`).
   */
  canonicalEnrolled?: (() => Promise<boolean>) | undefined;
  /** Immutable deployment fingerprint embedded in the server image. */
  deploymentIdentity?: string | undefined;
  /**
   * D420 — public, payload-free maintenance state. This is intentionally a
   * state-only read: it lets a returning Workbench distinguish a completed
   * upgrade from a merely live server without exposing operator work counts.
   */
  getMaintenanceState?: (() => Promise<MaintenanceState> | MaintenanceState) | undefined;
}

/**
 * D445 Phase 1 — Provider-management or owner capability gates
 * remote provider-key inspection/validation (permission-model.md §5).
 * Loopback callers bypass this in the route handlers; remote callers
 * must hold it on top of a verified session.
 */
async function viewerCanManageProviderKeys(userId: string): Promise<boolean> {
  try {
    const caps = await getUserCapabilities(userId);
    return caps.includes("manage_connection_providers") || caps.includes("manage_server_settings");
  } catch {
    return false;
  }
}

/**
 * Production builds embed an immutable source revision as
 * `NAUTILO_DEPLOYMENT_ID`. It changes for every published server image and
 * lets reconnecting clients distinguish a routine server upgrade from a
 * transient disconnect. The auth-contract hash remains the compatibility
 * fallback for images built before the deployment-id build argument existed.
 *
 * Dev/source runs intentionally report no identity: a Workbench must not
 * mistake a mutable local tree for a deployed image upgrade.
 */
function resolveDeploymentIdentity(): string {
  const embedded = process.env["NAUTILO_DEPLOYMENT_ID"]?.trim();
  if (embedded) return embedded;
  try {
    const contract = JSON.parse(
      readFileSync("/srv/contracts/auth-contract.json", "utf8"),
    ) as { hash?: unknown };
    return typeof contract.hash === "string" ? contract.hash : "";
  } catch {
    return "";
  }
}

/**
 * Readiness state shared across the process.
 *
 * Each component sets its own flag to `true` when it finishes initializing.
 * `/health/ready` returns 200 only when every flag is `true`; otherwise 503.
 *
 * D059 Phase 1.3 — readiness is distinct from liveness (process is up) so
 * infra tooling and our own launcher (`bin/nautilo-local`) can gate traffic
 * on "the server can actually serve" instead of "the port is bound".
 *
 * Scope: this state is a one-way **startup gate**. Flags are set as
 * components initialize; they do not currently flip back on runtime failure
 * (e.g., DB disconnect). Runtime liveness of individual components is a
 * future concern — see `/health/status` for point-in-time diagnostics.
 *
 * Tests: because this state is module-level, calling `createApp()` multiple
 * times in-process leaves `eventBridge` / `relay` flags `true` after the
 * first successful start. The server bin is the only production caller, so
 * this doesn't matter outside tests. Test suites that care should call
 * `resetReadyState()` in `beforeEach`.
 *
 * Pattern reference: Spacebot separates `/health` (liveness) from `/idle`
 * (drain-gate for rolling updates) in `src/api/system.rs:19-77`. k8s
 * convention: liveness = restart-gate, readiness = traffic-gate.
 */
export interface ReadyState {
  db: boolean;
  catalog: boolean;
  policy: boolean;
  eventBridge: boolean;
  listening: boolean;
}

export const readyState: ReadyState = {
  db: false,
  catalog: false,
  policy: false,
  eventBridge: false,
  listening: false,
};

export function markReady<K extends keyof ReadyState>(component: K): void {
  readyState[component] = true;
}

export function resetReadyState(): void {
  (Object.keys(readyState) as (keyof ReadyState)[]).forEach((k) => {
    readyState[k] = false;
  });
}

function isFullyReady(): boolean {
  return (Object.values(readyState) as boolean[]).every(Boolean);
}

const PROCESS_START_MS = Date.now();

export function healthRoutes(app: FastifyInstance, deps?: HealthRouteDeps) {
  const {
    pinProvider,
    ownerId,
    canonicalEnrolled,
    deploymentIdentity = resolveDeploymentIdentity(),
  } = deps ?? {};

  // M051 (Logto cluster): the response carries `logto*` discovery fields
  // read from `process.env`. Clients (Workbench, Electron, CLI) call this
  // BEFORE auth to wire up the Logto SDK / flow.
  app.get("/health", async () => {
    const instance = resolveInstance();
    const serverUrl = resolvePublicServerUrl(instance);
    const workbenchUrl = resolvePublicWorkbenchUrl(instance);
    let maintenanceState: MaintenanceState | undefined;
    if (deps?.getMaintenanceState) {
      try {
        maintenanceState = await deps.getMaintenanceState();
      } catch {
        // A failed durable-state read must not fabricate `normal` or make the
        // public discovery endpoint unavailable during a server replacement.
      }
    }
    const logtoFields = {
      logtoEndpoint: process.env["LOGTO_ENDPOINT"] ?? "",
      logtoWorkbenchAppId: process.env["LOGTO_WORKBENCH_APP_ID"] ?? "",
      logtoTuiAppId: process.env["LOGTO_TUI_APP_ID"] ?? "",
      logtoTuiLoopbackAppId: process.env["LOGTO_TUI_LOOPBACK_APP_ID"] ?? "",
      // M055: separate Native app for Electron loopback PKCE.
      // RFC 8252 §7.3 port-flex on `127.0.0.1` is honoured by Logto OSS
      // only for `type: "Native"` apps, so the workbench SPA app id
      // can't be reused.
      logtoDesktopAppId: process.env["LOGTO_DESKTOP_APP_ID"] ?? "",
      // M199: separate Native app for the mobile (Expo) client's
      // custom-scheme PKCE flow (`nautilo://callback`). Mobile has no
      // origin and can't host a loopback server, so it gets its own
      // Native app id, discovered per-server via /health.
      logtoMobileAppId: process.env["LOGTO_MOBILE_APP_ID"] ?? "",
      // D515: separate SPA client for the zero-install Mobile Web surface.
      // It cannot share native custom-scheme transactions or Workbench's
      // callback/session namespace even though both browser products use the
      // same serving origin.
      logtoMobileWebAppId: process.env["LOGTO_MOBILE_WEB_APP_ID"] ?? "",
      // M054: workbench needs the access-token audience so it can
      // request the right token via @logto/react's getAccessToken.
      logtoResource: process.env["LOGTO_RESOURCE"] ?? "",
      // D480 — additive pairing-contract discovery. Electron only rotates a
      // cached pre-grouping relay token after the server advertises support,
      // preventing old servers from causing a re-pair loop.
      relayPairingContractVersion: 2,
      // D152 smoke follow-up: Workbench's browser auth flow must emit
      // redirect URIs using the same loopback hostname Logto bootstrap
      // registered. `window.location.origin` alone drifts between
      // localhost and 127.0.0.1, which OIDC treats as different URIs.
      serverUrl,
      workbenchUrl,
      passwordRecoveryDriver: getPasswordRecoveryDriver(),
      deploymentIdentity,
      ...(maintenanceState ? { maintenanceState } : {}),
    };

    if (!pinProvider || !ownerId) {
      return {
        status: "ok",
        authRequired: false,
        enrolled: false,
        ...logtoFields,
      };
    }

    // M043: credentials FK to users.id; enrolled bridges D112 canonical
    // admin census when configured, else legacy PIN enrollment on ownerId.
    const enrolled = canonicalEnrolled
      ? await canonicalEnrolled()
      : await pinProvider.isEnrolled(ownerId);
    return { status: "ok", authRequired: true, enrolled, ...logtoFields };
  });

  // Zero-dep liveness — doesn't touch the PIN provider or anything async.
  // Safe to probe at high frequency by infra tooling.
  app.get("/health/live", () => ({
    status: "alive",
    uptime: process.uptime(),
    uptimeMs: Date.now() - PROCESS_START_MS,
  }));

  // Readiness — 503 until every component has initialized, 200 afterwards.
  // The component map is returned in both cases so the caller can see what's
  // still pending during bootstrap.
  app.get("/health/ready", (_request, reply) => {
    const ready = isFullyReady();
    reply.code(ready ? 200 : 503);
    return {
      status: ready ? "ready" : "starting",
      components: { ...readyState },
    };
  });

  // Diagnostic — rich runtime state for ops + debugging. Not a probe; the
  // shape may evolve without breaking liveness/readiness contracts.
  app.get("/health/status", () => {
    const mem = process.memoryUsage();
    return {
      status: isFullyReady() ? "ready" : "starting",
      uptimeMs: Date.now() - PROCESS_START_MS,
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      memory: {
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      },
      components: { ...readyState },
    };
  });

  // Key inspection + validation are no longer in the trust-bypass list
  // (D445 Phase 1), so the trust preHandler resolves the caller's bearer
  // into `sessionUserId` / `policyContext` before these handlers run.
  //
  // Authorization:
  //   - loopback / unix-socket callers (preserve the dev + CLI path), OR
  //   - an authenticated provider manager or owner.
  //
  // Remote callers without a session fail closed with 401; an authenticated
  // session that lacks the capability gets 403. Reads leak only the masked
  // value + status (config-guard does the masking), but they still expose
  // *which* providers are configured — useful reconnaissance — so the gate
  // stays admin-only. Validate also amplifies a DoS surface by triggering
  // outbound provider calls, so it can't be public either.
  //
  // Flagged in PR-007 review of PR #59; promoted here because the settings
  // page made the endpoints a single-click target from any remote browser
  // hitting a connect/cloud-mode server.
  app.get("/api/health/keys", async (request, reply) => {
    if (managedProviderCredentialRouteIsBlocked("/api/health/keys")) {
      return reply.code(403).send({ error: "managed_credentials_control_plane_owned" });
    }
    if (requestAllowsLoopbackTrust(request)) {
      // loopback fast-path: preserve dev/CLI behavior unchanged
    } else {
      const sessionUserId = request.sessionUserId;
      if (!sessionUserId) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (!(await viewerCanManageProviderKeys(sessionUserId))) {
        return reply.code(403).send({ error: "admin only" });
      }
    }
    const result = await check();
    return reply.send(result.keys);
  });

  app.post("/api/health/keys/validate", async (request, reply) => {
    if (managedProviderCredentialRouteIsBlocked("/api/health/keys/validate")) {
      return reply.code(403).send({ error: "managed_credentials_control_plane_owned" });
    }
    if (requestAllowsLoopbackTrust(request)) {
      // loopback fast-path
    } else {
      const sessionUserId = request.sessionUserId;
      if (!sessionUserId) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (!(await viewerCanManageProviderKeys(sessionUserId))) {
        return reply.code(403).send({ error: "admin only" });
      }
    }
    const result = await check({ validate: true });
    return reply.send({
      keys: result.keys,
      summary: result.summary,
    });
  });

  // M051: redaction-aware view of MODE_REGISTRY (LOGTO_* keys).
  // Sibling of /api/health/keys; same localhost-only treatment because
  // it leaks which auth mode is configured + presence/absence of every
  // LOGTO_* knob, which is reconnaissance for a remote attacker. The
  // M2M secret is masked in the response regardless of who calls it
  // (config-guard does the masking via `redact: true`).
  app.get("/api/health/modes", async (request, reply) => {
    if (!requestAllowsOwnerOrLoopback(request)) {
      return reply.code(403).send({ error: "Owner identity or localhost required" });
    }
    return reply.send(getModeReport());
  });
}
