import { createMediaGenerationCredentialRefresh } from "./media-generation-refresh";
import "./instance-argv-bootstrap.ts";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { config as loadDotenv } from "dotenv";
import {
  setConfigOverrides,
  normalizeUserConfig,
  resolveNautiloRuntimePaths,
  resolveDefaultWorkbenchDist,
  resolveInstance,
  resolveEffectiveServerUrl,
  resolveNautiloRootDir,
  applyInstanceArgFromArgv,
  isCloudMode,
  effectiveServerScheme,
} from "@nautilo/config";
import { resolveDotenvPath, subscribeEnvReload } from "@nautilo/config-guard";
import { setLogOutput, setLogLevel, log, debug, error } from "@nautilo/logger";

// Apply --instance before resolving instance.env, otherwise a named launch
// reads `(default)`'s dotenv file and can overwrite its own DB endpoints.
applyInstanceArgFromArgv(process.argv, process.env);
// An explicit direct connection from server-start is already bound to this
// instance. Keep it authoritative over a restored source instance.env while
// still loading all missing configuration keys from that file.
const dotenvPath = resolveDotenvPath();
loadDotenv({
  path: dotenvPath,
  // An explicit cloud file on the persistent Nautilo volume is the
  // administrator-owned provider override and must beat stale platform values
  // after an add/change and across container replacement.
  override: isCloudMode() || !process.env["DB_DIRECT_CONNECTION"]?.trim(),
});
log(`[boot] hosting mode: ${isCloudMode() ? "cloud" : "local"}`);

const wantDaemon = process.argv.includes("--daemon");
if (wantDaemon && !process.env["NAUTILO_DAEMON_CHILD"]) {
  const child = spawn(process.execPath, process.argv.slice(1).filter((a) => a !== "--daemon"), {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, NAUTILO_DAEMON_CHILD: "1" },
  });
  child.unref();
  console.log(`[daemon] started, pid=${child.pid}`);
  process.exit(0);
}

// D060 Sprint 1 G5.6 (ship plan v3 §5.6) — production-build policy
// check. FAIL-FAST before any config / sidecar / DB work: in a
// release build (`NODE_ENV=production`) the test-mode env vars are
// illegal; the panic exits with code 2 and an instructive log line
// that surfaces in systemd/docker. Must run EARLIER than the
// `assertTestModeCoupling` check at boot so the outer policy
// violation fires first with the clearer message; must run BEFORE
// the sidecar / config application so there\u0027s no window where a
// compromised deploy does work before being rejected.
import {
  assertProductionBuildPolicy,
  assertTestModeCoupling,
} from "./test-mode-guard";
import { assertRequiredCloudEnv } from "./cloud-env-guard";
const productionPolicyCheck = assertProductionBuildPolicy(process.env);
if (!productionPolicyCheck.ok) {
   
  console.error(productionPolicyCheck.message);
  process.exit(2);
}

// Load nautilo.config.ts — the user-facing config file.
//
// D060 ship-plan G4 — posture is OWNED by the sidecar
// `~/.nautilo/posture.json`. The sidecar wins unconditionally; the
// nautilo.config.ts [security] block (if set) is IGNORED for
// posture fields after Sprint 2 G4. Rationale:
//
//   - First-boot provisioner (`ensurePostureSidecar` below) writes
//     entry-point-appropriate defaults — `server`/`paranoid` for
//     this headless binary, `desktop-permissive`/`cautious` when
//     Electron pre-writes the sidecar before spawning the server.
//     A single nautilo.config.ts can\u0027t express two different
//     defaults, so entry-point ownership is the only correct
//     mechanism.
//   - Operators change posture via the Settings UI (PUT
//     /api/security/posture) which writes the sidecar atomically.
//     config.ts edits would be silently overridden by the sidecar
//     on next boot — and if we let config.ts win, operator
//     changes via the UI would be reverted on restart. Sidecar-
//     wins is the only consistent rule.
//
// Boot ordering (atomic merge into runtime config):
//   1. normalizeUserConfig(userConfig)            — port, models, ...
//   2. ensurePostureSidecar(...)                  — posture (G4)
//   3. setConfigOverrides({...normalized, ...sidecar posture overrides})
import userConfig from "../../../nautilo.config";
import http from "node:http";
import https from "node:https";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ensurePostureSidecar } from "@nautilo/server";
const _normalized = normalizeUserConfig(userConfig);
// G4 (D060 Sprint 2 Friday) — first-boot provisioner. The headless
// `bin/nautilo-server` defaults to (server, paranoid). When this
// binary is spawned by the Electron desktop client, `apps/desktop`'s
// `boot()` has ALREADY called `ensurePostureSidecar(...,
// {desktop-permissive, cautious})` so the sidecar exists with desktop
// defaults; this call is a no-op and we read those values back. When
// run standalone (production headless install, CI, smoke VM),
// nothing wrote the sidecar yet so the server-defaults land here.
//
// Subsequent boots ALWAYS read whatever is on disk — operator
// changes via PUT /api/security/posture write the sidecar; this
// helper never overwrites an existing file.
const _sidecarPosture = ensurePostureSidecar(
  join(resolveNautiloRootDir(), "posture.json"),
  {
    deploymentMode: "server",
    securityLevel: "paranoid",
    networkPolicy: { mode: "isolated" },
  },
);
setConfigOverrides({
  ..._normalized,
  nautilo_deployment_mode: _sidecarPosture.deploymentMode,
  nautilo_security_level: _sidecarPosture.securityLevel,
  nautilo_network_policy: _sidecarPosture.networkPolicy,
});

import {
  ensureDatabase,
  seedDefaultOwner,
  seedTrustPersonal,
  seedDefaultAgent,
  seedDefaultRoom,
  findDefaultAgentForOwner,
} from "@nautilo/db";
import {
  createApp,
  findAvailablePort,
  ensureCerts,
  startMdns,
  stopMdns,
  markReady,
  hydrateBootstrapOwnerState,
  installProductionMediaGenerationRuntime,
  installProductionMediaGenerationWorker,
  resetProductionMediaGenerationRuntime,
  stopProductionMediaGenerationWorker,
} from "@nautilo/server";
import {
  closeRegisteredDbPoolsOnShutdown,
  remainingShutdownDeadlineMs,
} from "./shutdown-pools";
import {
  configureRuntimeComputerUseContractCatalogue,
  hydrateModelCapabilitiesCache,
  hydrateRuntimeComputerUseContractCatalogue,
  hydrateRuntimeModelCatalog,
  reconcileComputerUseHostTools,
  registerAllTools,
  setupCheckpointSaver,
  startRuntimeComputerUseContractCatalogueRefreshLoop,
  startRuntimeModelCatalogRefreshLoop,
  stopRuntimeComputerUseContractCatalogueRefreshLoop,
} from "@nautilo/agent";
import {
  PersonalPolicyResolver,
  initPolicyResolver,
  setBootstrapOwnerActorId,
  setBootstrapDefaultAgentId,
  getBootstrapOwnerId,
} from "@nautilo/trust";
import { ToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { jobManager } from "@nautilo/runtime";
import { warn } from "@nautilo/logger";
type AppInstance = Awaited<ReturnType<typeof createApp>>;

function defaultMdnsServiceName(instanceId: string): string {
  const id = instanceId.trim();
  return id.length > 0 ? `Nautilo ${id}` : "Nautilo";
}

/**
 * Bounded graceful shutdown.
 *
 * D059 Phase 1.1 — every signal handler in the codebase should converge on
 * this pattern: attempt a clean close with a hard deadline, force-exit if the
 * deadline is missed, and force-exit immediately on a second signal. No more
 * zombies on Ctrl+C.
 *
 * Reference: OpenCode's TUI worker uses the same "try graceful → force
 * terminate" shape (EXTERNAL/opencode/packages/opencode/src/cli/cmd/tui/thread.ts:157-170).
 * Spacebot's main.rs (EXTERNAL/spacebot/src/main.rs:2578) calls
 * std::process::exit(0) at the end of its ordered teardown because detached
 * tasks can keep the runtime alive — same principle here for Fastify's
 * WebSocket drain.
 */
const SHUTDOWN_TIMEOUT_MS = 2_000;
let stopMediaEnvSubscription: (() => void) | undefined;
let shuttingDown = false;
let pidFileWrittenPath: string | null = null;

function setupSignalHandlers(app: AppInstance): void {
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      warn(`[server] Second ${signal} received — force-exit`);
      process.exit(130);
    }
    shuttingDown = true;
    stopRuntimeComputerUseContractCatalogueRefreshLoop();
    // Stop fresh paid admissions before draining any in-flight server work.
    stopMediaEnvSubscription?.();
    resetProductionMediaGenerationRuntime();
    // Stop scheduling fresh reconciliation passes; any active pass remains
    // fenced by its durable DB lease and is safe to resume after restart.
    stopProductionMediaGenerationWorker();
    log(`[server] ${signal} received — shutting down (${SHUTDOWN_TIMEOUT_MS}ms deadline)`);
    const shutdownDeadlineAtMs = Date.now() + SHUTDOWN_TIMEOUT_MS;

    const forceExit = setTimeout(() => {
      warn(`[server] shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms — force-exit`);
      process.exit(130);
    }, SHUTDOWN_TIMEOUT_MS);
    // Don't let the force-exit timer keep the event loop alive on its own —
    // if app.close() resolves first we want the process to exit naturally.
    forceExit.unref();

    // mDNS is synchronous stop; do it first so LAN clients get a clean
    // SRV withdrawal regardless of whether app.close() hangs.
    try {
      stopMdns();
    } catch (err) {
      warn(`[server] stopMdns error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    // Force-close WebSocket / keep-alive connections so Fastify's close()
    // doesn't hang waiting for them. Node http.Server.closeAllConnections
    // is available since Node 18.2.
    try {
      app.server.closeAllConnections();
    } catch (err) {
      debug(`[server] closeAllConnections failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Persist a terminal planned-shutdown outcome before releasing the process.
    // Queued/coalesced foreground intent is dropped intentionally: foreground
    // job resume is not safe without an explicit replay policy.
    void jobManager
      .cancelForegroundJobsForPlannedShutdown()
      .then(() => {
        log("[server] Foreground jobs terminalized for planned shutdown");
      })
      .catch((err: unknown) => {
        warn(
          `[server] foreground shutdown terminalization error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      })
      .finally(() => {
        app.close()
          .then(async () => {
            try {
              await closeRegisteredDbPoolsOnShutdown({
                totalDeadlineMs: remainingShutdownDeadlineMs(shutdownDeadlineAtMs),
                warn,
              });
            } catch {
              // closeRegisteredDbPoolsOnShutdown reports per-pool failures via warn.
            }
            if (pidFileWrittenPath) {
              try {
                unlinkSync(pidFileWrittenPath);
              } catch (err) {
                warn(
                  `[server] pid file unlink error (non-fatal): ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
              }
            }
            clearTimeout(forceExit);
            log(`[server] Shutdown clean`);
            process.exit(0);
          })
          .catch((err: unknown) => {
            clearTimeout(forceExit);
            warn(`[server] app.close() error: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
          });
      });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

const LOG_DIR = join(resolveNautiloRootDir(), "logs");
setLogOutput("file", join(LOG_DIR, "nautilo-server.log"));
setLogLevel("info");

// D120 A5.3 (review fix) — the PID file used to be written here, before
// cloud-env validation and before `app.listen()`. That meant any early-boot
// abort (`assertTestModeCoupling`, `assertRequiredCloudEnv`,
// `start()` rejection, port-bind failure, …) would `process.exit()`
// without unlinking, leaving a stale PID that confused `nautilo stop`
// and `pgrep`-driven restart scripts. The write now happens inside
// `start()` AFTER `app.listen()` resolves (search this file for the
// "PID write deferred" anchor) and the catch handler / exit hook below
// guarantees cleanup on any exit path.
const isInDocker = existsSync("/.dockerenv");
const pidPath = join(resolveNautiloRootDir(), "server.pid");

// Final-stage safety net: unlink on any process exit if we wrote the file.
// Signal-driven shutdowns go through setupSignalHandlers() which already
// unlinks; this `exit` listener catches every remaining path (start()
// catch, normal exit(0), etc.).
process.on("exit", () => {
  if (pidFileWrittenPath) {
    try {
      unlinkSync(pidFileWrittenPath);
    } catch {
      /* best effort */
    }
  }
});

/**
 * D060 Phase 1 (via D063 Phase 6 follow-up) — minimal boot mode for
 * in-VM smoke tests. When `NAUTILO_TEST_MODE_ONLY=1` is set, the
 * server skips DB bootstrap + identity seeding + policy resolver +
 * checkpoint saver. The separate app composition registers health,
 * authenticated test routes (`/api/test/*`), and the authenticated Relay
 * websocket. Production route owners and background workers are not built.
 *
 * The motivating use case: the Lima/Tart VMs used by the D063
 * SANDBOX-* matrix need a running nautilo-server to exercise
 * `/api/test/tool-invoke`, but they don't need Postgres, Docker,
 * the Neon proxy, or any user-facing routes. `TEST_MODE_ONLY=1`
 * boots the server in ~0.5s (no DB migration waits), with a
 * footprint that fits cleanly in a cloud-init-provisioned VM.
 *
 * Anything requiring DB (auth, chat, approval, memory, sessions,
 * trust-envelope) returns 404 / 503 / "not available in test-mode"
 * when this flag is set. Production deployments never set this.
 *
 * The explicit `createApp({ testModeOnly: true })` composition also checks
 * both test-mode flags and rejects NODE_ENV=production. Its Relay websocket
 * retains ordinary credential validation; test mode never admits an unpaired Relay.
 *
 * COUPLING — `NAUTILO_TEST_MODE_ONLY=1` alone is NOT a valid
 * configuration. The flag only makes sense as an optimization on
 * top of the normal test-mode surface (`NAUTILO_TEST_MODE=1` +
 * bearer token). Without `NAUTILO_TEST_MODE=1`:
 *   - DB / seed / policy / checkpoint are skipped (this flag)
 *   - `resolveTestToken()` returns null (see
 *     packages/server/src/routes/test-mode.ts:228)
 *   - `testModeRoutes({ enabled: false })` early-returns with zero
 *     routes registered
 * Net result: a running server bound to a port serving /health +
 * static assets but no functional API routes. A footgun that
 * looks like a wiring bug in downstream code.
 *
 * PR-014 MAJOR #3 — the boot path refuses `TEST_MODE_ONLY=1` unless
 * `TEST_MODE=1` is also set. Systemd journal / docker logs /
 * ad-hoc shell invocations all surface the real cause on exit
 * rather than hiding it behind a silent degradation.
 */
// Test-mode coupling check. `assertProductionBuildPolicy` already
// ran at the top of this file (before config / sidecar work).
// Coupling is the narrower test-mode-only-without-test-mode footgun
// catch — runs here in source order so the error message can
// mention the resolved config paths if we ever extend it to that.
const couplingCheck = assertTestModeCoupling(process.env);
if (!couplingCheck.ok) {
   
  console.error(`[server] ABORT — ${couplingCheck.message}`);
  process.exit(2);
}

const cloudEnvCheck = assertRequiredCloudEnv(process.env);
if (!cloudEnvCheck.ok) {
  console.error(`[server] ABORT — ${cloudEnvCheck.message}`);
  process.exit(2);
}

const TEST_MODE_ONLY = process.env["NAUTILO_TEST_MODE_ONLY"] === "1";

async function start() {
  // Install server-owned exact-quote admission before registering live-gated
  // media tools. Environment reloads refresh admission and reconciliation.
  const mediaGenerationAvailable = !TEST_MODE_ONLY && installProductionMediaGenerationRuntime();

  configureRuntimeComputerUseContractCatalogue({
    lkgPath: join(resolveNautiloRootDir(), "cache", "computer-use-contract-catalogue-lkg.json"),
  });
  const computerUseCatalogue = await hydrateRuntimeComputerUseContractCatalogue();
  log(
    `[server] Computer Use contract catalogue source=${computerUseCatalogue.source} version=${computerUseCatalogue.catalogueVersion} sha256=${computerUseCatalogue.artifactSha256} stale=${computerUseCatalogue.stale}: ${computerUseCatalogue.reason}`,
  );

  // Initialize the ToolCatalog — one register() per tool with metadata +
  // factory. Available process-wide via getToolCatalog(). Required in
  // test-mode-only too because `/api/test/tool-invoke` consumes the
  // catalog's file-tool factory.
  const catalog = new ToolCatalog();
  registerAllTools(catalog);
  initToolCatalog(catalog);
  markReady("catalog");
  log(`[server] ToolCatalog initialized: ${catalog.size} tools`);
  startRuntimeComputerUseContractCatalogueRefreshLoop(({ result, contractsChanged }) => {
    log(
      `[server] Computer Use contract catalogue refresh source=${result.source} version=${result.catalogueVersion} sha256=${result.artifactSha256} stale=${result.stale} contractsChanged=${contractsChanged}: ${result.reason}`,
    );
    if (contractsChanged) {
      try {
        reconcileComputerUseHostTools(catalog);
      } catch (err) {
        warn(
          `[server] Computer Use contract catalogue reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
    }
  });
  log(`[server] Venice media generation ${mediaGenerationAvailable ? "available" : "unavailable"}`);

  await hydrateModelCapabilitiesCache();
  log("[server] Model capability catalog hydrated");

  // D429 Phase 7 — hydrate the signed remote model catalog (bounded, non-fatal
  // on failure: the checked-in fallback remains active). Hot reads use the
  // atomic in-memory snapshot; a non-blocking background loop keeps the
  // snapshot fresh so newly published supported rows appear without a restart.
  const catalogProvenance = await hydrateRuntimeModelCatalog();
  log(
    `[server] Model catalog hydrated — source=${catalogProvenance.source} version=${catalogProvenance.catalogVersion ?? "fallback"}`,
  );
  startRuntimeModelCatalogRefreshLoop();

  // ----------------------------------------------------------------
  // DB + seed + policy + checkpoint — SKIPPED in test-mode-only.
  // ----------------------------------------------------------------
  let policyResolver: PersonalPolicyResolver | null = null;
  let ownerId: string = "";
  let ownerActorId: string = "";

  if (!TEST_MODE_ONLY) {
    await ensureDatabase((msg: string) => debug(`[db] ${msg}`));
    markReady("db");

    // D120 A1.P1 — DB-as-source-of-truth for ownership. Pre-D120 the
    // server reconciled NAUTILO_OWNER_ID from a config.env round-trip
    // (promote-default-owner.ts wrote it post-claim, loadDotenv re-read
    // it at boot). That whole bridge is gone; the DB is the persistent
    // source of truth, the bootstrap-state-cache is the runtime read.
    //
    // Boot priority (audit Finding 1 — claimed-first-then-seed):
    //   1. seedDefaultOwner runs unconditionally (idempotent — needed
    //      for fresh DBs; downstream seedTrustPersonal / seedDefaultRoom
    //      depend on a users row existing).
    //   2. findClaimedOwnerId queries for the real claimer (any user
    //      with an associated credentials row — see find-claimed-owner.ts
    //      for the predicate rationale). Returns null pre-claim.
    //   3. Cache + ownerId variable take the claimed user when present,
    //      else fall back to the seeded dummy. Pre-claim, every request
    //      resolves to `stranger` via the policy resolver's user-binding
    //      lookup anyway, so the dummy-id placeholder is benign.
    const seededOwnerId = await seedDefaultOwner((msg: string) =>
      debug(`[db] ${msg}`),
    );
    const hydratedOwner = await hydrateBootstrapOwnerState({ seededOwnerId });
    const claimedOwnerId = hydratedOwner.claimedOwnerId;
    ownerId = hydratedOwner.ownerId;
    // D140: on healthy post-D140 instances, the Logto/local-claim
    // redeem path UPDATEs the bootstrap-seed user row in place (see
    // `claimBootstrapSeedUserInTx`), so `claimedOwnerId === seededOwnerId`
    // and the divergent branch below is silent on healthy state. The
    // warn-branch survives only as a doctor signal for pre-D140
    // already-broken instances that have not yet run
    // `nautilo-dev repair-orphan-default-agent --keep-user-id <claimed> --apply`.
    if (claimedOwnerId && claimedOwnerId !== seededOwnerId) {
      warn(
        `[server] D140 stale-state warning: claimed owner ${claimedOwnerId} differs from bootstrap-seed user ${seededOwnerId}. This is the pre-D140 "INSERT new + retire old" shape. Run \`nautilo-dev repair-orphan-default-agent --keep-user-id ${claimedOwnerId} --apply\` to merge the orphan, then restart.`,
      );
    } else if (claimedOwnerId) {
      log(`[server] default owner resolved: id=${claimedOwnerId}`);
    }

    // M044: seedTrustPersonal's return shape collapses to { actorId }
    // — it no longer mints Namespaces (those are born with the Room in
    // seedDefaultRoom now, per REL-NSP-RMS).
    //
    // D112 Phase 19 — pass `seededOwnerId` (NOT the possibly-promoted
    // `ownerId`). Same logic as the seedDefaultRoom call below: these
    // seeders mint the bootstrap dummy's actor / room rows. Calling them with a
    // promoted claimer's user id on a restart would silently mint
    // parallel rows under the wrong user.
    const { actorId: seededActorId } = await seedTrustPersonal(
      seededOwnerId,
      "user",
      (msg: string) => debug(`[trust] ${msg}`),
    );
    ownerActorId = seededActorId;
    // D120 A1.P1 (was M042D): publish the owner-actor UUID through the
    // bootstrap-state-cache instead of process.env so every lazy reader
    // (authRoutes, verify_identity factory, resumeGraphWithIdentity,
    // routeApproval bootstrap fallback) sees it before createApp runs
    // — without an env-var round-trip that breaks under cloud-mode
    // ephemeral filesystems.
    setBootstrapOwnerActorId(ownerActorId);

    // D120 A1.P1b — DB-as-source-of-truth twin for the default-agent
    // pointer. Same shape as P1's owner cache:
    //   1. seedDefaultAgent runs unconditionally (idempotent — required
    //      for memory/session backfills on a fresh DB).
    //   2. If a real claimer exists, query for that claimer's per-user
    //      Agent (minted inside redeem-invite.ts's transaction by
    //      seedPersonalAgentForInviteeInTx and joined to the owner via
    //      an `agent_ownership` Group). Post-claim, this is the agent
    //      that should drive PersonalPolicyResolver's defaultAgentId
    //      fallback — using the seed Agent here regresses claimer→
    //      stranger after restart (F-1 shape on the agent side).
    //   3. Pre-claim, the seed Agent is the right placeholder.
    const seededAgentId = await seedDefaultAgent(
      seededOwnerId,
      (msg: string) => debug(`[db] ${msg}`),
    );
    const claimedAgentId = claimedOwnerId
      ? await findDefaultAgentForOwner(claimedOwnerId)
      : null;
    const defaultAgentId = claimedAgentId ?? seededAgentId;
    setBootstrapDefaultAgentId(defaultAgentId);
    // D140: same pattern as the owner side above. On healthy post-D140
    // instances the redeem path UPDATEs the bootstrap-seed agent row
    // in place (`claimBootstrapSeedAgentInTx`), so claimed agent id
    // matches seeded. Divergence is a stale-state doctor signal.
    if (claimedAgentId && claimedAgentId !== seededAgentId) {
      warn(
        `[server] D140 stale-state warning: claimed agent ${claimedAgentId} differs from bootstrap-seed agent ${seededAgentId}. Run \`nautilo-dev repair-orphan-default-agent --keep-agent-id ${claimedAgentId} --orphan-agent-id ${seededAgentId} --apply\` to merge the orphan, then restart.`,
      );
    } else if (claimedAgentId) {
      log(`[server] default agent for owner resolved: id=${claimedAgentId}`);
    }

    // M128: seedAgentOwnershipGroup retired — Groups are now
    // server-wide (`owners`/`admins`/.../`guests`), seeded once by
    // seedTrustPersonal above. The default room for the bootstrap
    // dummy owner is still seeded here so pre-claim sessions have a
    // landing room; the claimer's Personal room is minted inside the
    // redeem tx via seedPersonalPrivateRoomInTx.
    const defaultRoom = await seedDefaultRoom(
      seededOwnerId,
      ownerActorId,
      seededAgentId,
      (msg: string) => debug(`[db] ${msg}`),
    );
    debug(
      `[db] default room ${defaultRoom.roomId} (NS: ${defaultRoom.namespaceId}) ready`,
    );

    // M042D: resolver no longer takes ownerActorId — the ownership-group
    // lookup supersedes the hardcoded owner-actor equality check.
    //
    // D120 A1.P1: callback reads from the bootstrap-state-cache instead
    // of process.env. The cache is set above at boot from the
    // claimed-first-then-seed query and refreshed in-process from
    // redeem-invite.ts after a successful kind=claim, so the resolver
    // sees the current owner on every request without an env-var
    // round-trip — and without breaking under cloud-mode ephemeral
    // filesystems where the pre-D120 config.env round-trip would lose
    // state on container restart.
    policyResolver = new PersonalPolicyResolver(
      () => getBootstrapOwnerId(),
      defaultAgentId,
    );
    initPolicyResolver(policyResolver);
    markReady("policy");

    // Stack 198 — least-privilege checkpoint provisioning. setupCheckpointSaver()
    // runs PostgresSaver.setup() + the narrow langchain grant block over a
    // short-lived canonical privileged direct pool, closes it, then
    // constructs the long-lived saver on the nautilo_agent runtime role and
    // caches it. The executor's later createCheckpointSaver() call returns
    // that cached saver; the setup pool is not registered for shutdown.
    await setupCheckpointSaver();
  } else {
    log(
      "[server] TEST_MODE_ONLY=1 — skipping DB + seed + policy + checkpoint. Test-mode routes only.",
    );
    // markReady() fires for the wait-for-boot harnesses. In test-mode
    // the DB/policy gates never fulfill, so we mark them as "done"
    // explicitly to avoid blocking on them.
    markReady("db");
    markReady("policy");
  }

  // D049: the Fastify app itself (createApp) runs ensureDirectoryTree
  // at boot, so we only need the resolved paths here for pre-createApp
  // concerns (NAUTILO_OWNER_ID file, TLS cert discovery, etc.).
  // M167 — foreground single-origin: when NAUTILO_WORKBENCH_DIST is unset and a
  // built workbench exists at repo-root, serve it at `/`. Container + dev-stack
  // set the env explicitly, so this only fires for bare `bun run server`.
  if (!(process.env["NAUTILO_WORKBENCH_DIST"] ?? "").trim()) {
    const defaultDist = resolveDefaultWorkbenchDist();
    if (defaultDist) {
      process.env["NAUTILO_WORKBENCH_DIST"] = defaultDist;
      log(`[server] M167 - auto-set NAUTILO_WORKBENCH_DIST=${defaultDist}`);
    }
  }
  const paths = resolveNautiloRuntimePaths();
  const inst = resolveInstance();

  // TLS — HTTPS activates only when bound to a network interface (0.0.0.0).
  // Localhost (127.0.0.1) stays HTTP — no cert warnings for local setup.
  // Certs are always generated (ready for when LAN mode is enabled).
  //
  // D060 Sprint 1 (security ship plan v3, G5.6): the `NAUTILO_TLS=false`
  // LAN-disable env var has been DELETED. It was a policy-affecting
  // bypass surface — a prompt-injected agent could socially-engineer
  // the user into unsetting TLS for a LAN deployment, leaving
  // credentials traveling in plaintext. Disabling TLS on LAN is now
  // a server-config mutation gated on the `manage_server_security`
  // Capability (landing via G5.3 in Sprint 1 Day 4). Until then, LAN
  // mode ALWAYS requires TLS — no escape hatch.
  //
  // M071 — bind host / ports / hostname bundle come from `resolveInstance()`
  // (env > nautilo.config overlay > instance.json > defaults). Env keys
  // such as NAUTILO_PORT / NAUTILO_HOST / NAUTILO_HOSTNAME are merged there.
  const host = inst.server.host;
  // Single source of truth for the HTTPS decision — same predicate used by
  // resolveEffectiveServerUrl below so the printed sentinel and the actual
  // listener can never drift. See packages/config/src/effective-server-url.ts.
  const useHttps = effectiveServerScheme(host) === "https";
  const tlsIdentityHost = inst.hostname.federated;
  let httpsOpts: { key: Buffer; cert: Buffer } | undefined;

  // Always generate certs so they're ready when the user enables LAN
  try {
    const tls = ensureCerts(paths.certsDir, tlsIdentityHost);
    if (useHttps) {
      httpsOpts = { key: tls.serverKey, cert: tls.serverCert };
      log(`[server] TLS enabled (LAN mode) — cert fingerprint: ${tls.fingerprint}`);
    } else {
      log(`[server] Localhost mode — HTTP (certs ready at ${paths.certsDir})`);
    }
  } catch (err) {
    if (useHttps) {
      throw err; // TLS is required for LAN — fail hard
    }
    warn(`[server] Cert generation failed (not required for localhost): ${err instanceof Error ? err.message : String(err)}`);
  }

  const preferredPort = inst.server.port;
  const port = await findAvailablePort(preferredPort);
  const serverUrl = resolveEffectiveServerUrl(inst, { port });

  // The guarded DB-less harness selects a separate minimal app composition.
  // Ordinary boots still construct every production route and authority.
  const app = await createApp({
    silent: true,
    enableClaudeCodeTasks: !TEST_MODE_ONLY && process.env["NAUTILO_CLAUDE_CODE_TASKS"] === "1",
    // Stack 198 — real server boots own this write-once persistence step.
    // The explicit DB-less test-mode-only harness is the sole exception.
    materializeServerProfileAtBoot: !TEST_MODE_ONLY,
    backfillOwnedPhotoLibraryAtBoot: !TEST_MODE_ONLY,
    testModeOnly: TEST_MODE_ONLY,
    ...(policyResolver !== null ? { policyResolver } : {}),
    ...(ownerActorId !== "" ? { ownerActorId } : {}),
    ...(ownerId !== "" ? { ownerId } : {}),
    https: httpsOpts,
    certsDir: paths.certsDir,
    hostname: tlsIdentityHost,
    port,
  });
  await app.listen({ port, host });
  markReady("listening");
  const mediaGenerationWorkerAvailable = !TEST_MODE_ONLY && installProductionMediaGenerationWorker();
  log(`[server] Venice media reconciliation ${mediaGenerationWorkerAvailable ? "running" : "unavailable"}`);
  if (!TEST_MODE_ONLY) {
    const refreshMediaCredentials = createMediaGenerationCredentialRefresh({
      resolveKey: () => process.env["VENICE_API_KEY"] ?? null,
      installRuntime: () => installProductionMediaGenerationRuntime(),
      installWorker: () => installProductionMediaGenerationWorker(),
    });
    stopMediaEnvSubscription = subscribeEnvReload(() => {
      try {
        refreshMediaCredentials();
      } catch {
        resetProductionMediaGenerationRuntime();
        stopProductionMediaGenerationWorker();
        warn("[server] Media clients could not refresh; generation is unavailable until configuration reload succeeds.");
      }
    });
  }


  // PID write deferred (D120 A5.3 review fix) — only emit `server.pid`
  // after the HTTP listener is bound. Earlier aborts (cloud-env-guard,
  // test-mode coupling, createApp throw, port-bind EADDRINUSE) now exit
  // without ever touching the PID file. The `process.on("exit")` hook
  // at the top of this file is the unconditional cleanup leg.
  if (!isInDocker) {
    writeFileSync(pidPath, String(process.pid), { mode: 0o644 });
    pidFileWrittenPath = pidPath;
    log(`[boot] pid file: ${pidPath}`);
  }

  // -----------------------------------------------------------------
  // D120 A5.2 — Unix domain socket at ~/.nautilo/server.sock (0o600).
  // Node does not allow a second listen() on the same http.Server as
  // Fastify's TCP listener, so we use a tiny dedicated HTTP server on the
  // socket that forwards to 127.0.0.1:<port>. Limitation: WebSocket upgrade
  // and other hop-by-hop features are not proxied; use TCP for those.
  // Skip entirely when NAUTILO_DISABLE_UNIX_SOCKET is set (any value).
  // -----------------------------------------------------------------
  const socketEnabled = !process.env["NAUTILO_DISABLE_UNIX_SOCKET"];
  // resolveNautiloRootDir() honors NAUTILO_INSTANCE_ID so two instances on
  // the same host get distinct socket paths (~/.nautilo<inst>/server.sock).
  // Same helper sub-a uses for the PID file -- keep them collocated.
  const socketDir = resolveNautiloRootDir();
  const socketPath = join(socketDir, "server.sock");
  if (socketEnabled) {
    try {
      await mkdir(socketDir, { recursive: true, mode: 0o700 });
      try {
        await unlink(socketPath);
      } catch {
        /* stale socket file — ignore ENOENT */
      }

      const addr = app.server.address();
      const boundPort =
        typeof addr === "object" && addr !== null && "port" in addr
          ? (addr as { port: number }).port
          : port;
      const forwardTls = Boolean(httpsOpts);

      const forwarder = http.createServer((req, res) => {
        const headers = { ...req.headers, host: `127.0.0.1:${boundPort}` };
        const onIncoming = (upstream: http.IncomingMessage) => {
          res.writeHead(upstream.statusCode ?? 502, upstream.headers);
          upstream.pipe(res);
        };
        const onError = (e: Error) => {
          if (!res.headersSent) {
            res.statusCode = 502;
          }
          res.end(e.message);
        };

        if (forwardTls) {
          const upstreamReq = https.request(
            {
              hostname: "127.0.0.1",
              port: boundPort,
              path: req.url ?? "/",
              method: req.method,
              headers,
              // Loopback-only forwarding within the same process -- the
              // upstream cert may be self-signed (dev) or scoped to the
              // operator's domain (prod), neither of which validates as
              // "127.0.0.1". No MITM is reachable on this hop because
              // both endpoints live in the same Node process.
              rejectUnauthorized: false,
            },
            onIncoming,
          );
          upstreamReq.on("error", onError);
          req.pipe(upstreamReq);
        } else {
          const upstreamReq = http.request(
            {
              hostname: "127.0.0.1",
              port: boundPort,
              path: req.url ?? "/",
              method: req.method,
              headers,
            },
            onIncoming,
          );
          upstreamReq.on("error", onError);
          req.pipe(upstreamReq);
        }
      });

      await new Promise<void>((resolve, reject) => {
        forwarder.listen({ path: socketPath }, () => resolve());
        forwarder.once("error", reject);
      });
      await chmod(socketPath, 0o600);
      log(
        `[boot] unix socket forwarder: ${socketPath} → http${forwardTls ? "s" : ""}://127.0.0.1:${boundPort}`,
      );

      process.on("exit", () => {
        try {
          forwarder.close();
        } catch {
          /* best effort */
        }
        try {
          unlinkSync(socketPath);
        } catch {
          /* best effort */
        }
      });
    } catch (err) {
      warn(
        `[boot] unix socket unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // mDNS announcement — lets LAN clients find the server automatically.
  // Skipped in test-mode-only (the VM doesn't advertise on the host's LAN).
  const mdnsDisabled = process.env["NAUTILO_MDNS"] === "false" || TEST_MODE_ONLY;
  if (!mdnsDisabled) {
    try {
      const instanceName =
        process.env["NAUTILO_INSTANCE_NAME"] ?? defaultMdnsServiceName(inst.instanceId);
      startMdns({ port, instanceName, hostname: inst.hostname.mdns, version: "0.1.0" });
      log(`[server] mDNS announced: ${inst.hostname.mdns} (${instanceName})`);
    } catch (err) {
      warn(`[server] mDNS announcement failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  setupSignalHandlers(app);

  // Machine-parseable sentinel for Desktop and development orchestration.
  console.log(`NAUTILO_SERVER_READY ${serverUrl}`);
  log(`[server] Listening on ${serverUrl}`);
}

start().catch((err: unknown) => {
  stopRuntimeComputerUseContractCatalogueRefreshLoop();
  stopMediaEnvSubscription?.();
  resetProductionMediaGenerationRuntime();
  stopProductionMediaGenerationWorker();
  // Print the raw error to stderr so we see stack/message even if
  // the logger's JSON.stringify collapses Error objects to `{}`.
   
  console.error("[server] Failed to start (raw):", err);
  error("[server] Failed to start:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
