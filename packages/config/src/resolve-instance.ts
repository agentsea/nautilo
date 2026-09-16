import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fromRuntimeConfig } from "./config";
import {
  DEFAULT_COMPOSE_PROJECT_NAME,
  DEFAULT_HOSTNAMES,
  DEFAULT_PORTS,
  DEFAULT_SERVER_HOST,
  INSTANCE_JSON_SCHEMA_VERSION,
  defaultDirectDbConnection,
  defaultServerUrl,
  defaultWorkbenchUrl,
  hostnamesForNamedInstance,
  type InstanceDeploymentMode,
  INSTANCE_DEPLOYMENT_MODES,
} from "./instance-defaults";
import { deriveComposeContainerBundle } from "./compose-container-names";
import type { ComposeContainerBundle } from "./compose-container-names";
import {
  InstanceJsonParseSchema,
  stripRetiredNeonProxyFields,
  type InstanceJson,
  type InstanceJsonParse,
} from "./resolve-instance-schema";
import { resolveNautiloRootDir, userHomeDirFromEnv } from "./runtime-paths";
import {
  collectClaimedPortsFromSiblingInstances,
  pickFirstNonCollidingPortBundle,
  type PickNonCollidingPortBundleOptions,
  type PortBundle,
} from "./sibling-instance-ports";
import {
  warnIfRetiredNeonProxyEnvPresent,
  warnRetiredNeonProxyConfig,
} from "./retired-neon-proxy";
import {
  withInstanceAllocationLockSync,
  type InstanceAllocationLockOptions,
} from "./instance-allocation-lock";

export type { InstanceJson };

export type ResolvedInstance = Omit<InstanceJson, "compose"> & {
  compose: InstanceJson["compose"] & { containers: ComposeContainerBundle };
};

let cached: ResolvedInstance | null = null;

function hydrateComposeContainers(data: InstanceJson): ResolvedInstance {
  const containers = deriveComposeContainerBundle(data.compose.projectName);
  return {
    ...data,
    compose: { ...data.compose, containers },
  };
}

function readIntEnv(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

function readStringEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key]?.trim();
  return v === undefined || v === "" ? undefined : v;
}

function defaultDeploymentModeForInstanceId(instanceId: string): InstanceDeploymentMode {
  return instanceId.trim() === "" ? "local-self-host" : "dev-multi-instance";
}

function withDefaultDeploymentMode(data: InstanceJsonParse): InstanceJsonParse {
  if (data.deploymentMode !== undefined) {
    return data;
  }
  return { ...data, deploymentMode: defaultDeploymentModeForInstanceId(data.instanceId) };
}

function buildDefaultInstanceJson(instanceId: string, ports: PortBundle): InstanceJson {
  const id = instanceId.trim();
  const h = id === "" ? DEFAULT_HOSTNAMES : hostnamesForNamedInstance(instanceId);
  const serverPort = ports.server;
  const workbenchPort = ports.workbench;
  const projectName =
    id === "" ? DEFAULT_COMPOSE_PROJECT_NAME : `nautilo-${id}`;
  return {
    schemaVersion: INSTANCE_JSON_SCHEMA_VERSION,
    instanceId,
    server: {
      host: DEFAULT_SERVER_HOST,
      port: serverPort,
      url: defaultServerUrl(serverPort),
    },
    workbench: {
      port: workbenchPort,
      url: defaultWorkbenchUrl(workbenchPort),
    },
    db: {
      directConnection: defaultDirectDbConnection(ports.dbPostgres),
      postgresHostPort: ports.dbPostgres,
    },
    logto: {
      dbPort: ports.logtoDb,
      corePort: ports.logtoCore,
      adminPort: ports.logtoAdmin,
    },
    compose: {
      projectName,
      containers: deriveComposeContainerBundle(projectName),
    },
    hostname: {
      federated: h.federated,
      mdns: h.mdns,
      tlsSan: h.tlsSan,
      caddyAuthHost: h.caddyAuthHost,
      caddyAuthAdminHost: h.caddyAuthAdminHost,
    },
    deploymentMode: defaultDeploymentModeForInstanceId(id),
  };
}

function readInstanceJsonPath(rootDir: string): string {
  return join(rootDir, "instance.json");
}

/** Atomically write validated `instance.json` under `rootDir`. */
export function writeInstanceJson(rootDir: string, data: InstanceJson): void {
  writeInstanceJsonAtomic(rootDir, data);
}

function writeInstanceJsonAtomic(rootDir: string, data: InstanceJsonParse): void {
  mkdirSync(rootDir, { recursive: true });
  const target = readInstanceJsonPath(rootDir);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmp, target);
}

/**
 * Stamp `instance.json.deployConfigConsumedAt` once (first ISO timestamp wins).
 * Requires a valid existing `instance.json`; does not create the file.
 */
export function markDeployConfigConsumed(rootDir: string, opts?: { now?: Date }): void {
  const path = readInstanceJsonPath(rootDir);
  if (!existsSync(path)) {
    throw new Error(
      `Cannot stamp deployConfigConsumedAt: missing instance.json at ${path}`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error(`Cannot stamp deployConfigConsumedAt: invalid JSON at ${path}`);
  }

  const parsed = InstanceJsonParseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Cannot stamp deployConfigConsumedAt: ${parsed.error.message}`,
    );
  }

  if (
    parsed.data.deployConfigConsumedAt !== undefined &&
    parsed.data.deployConfigConsumedAt.trim() !== ""
  ) {
    return;
  }

  const next: InstanceJsonParse = {
    ...parsed.data,
    deployConfigConsumedAt: (opts?.now ?? new Date()).toISOString(),
  };
  writeInstanceJsonAtomic(rootDir, next);
}

/** ISO timestamp from `instance.json` when present; otherwise `null`. */
export function readDeployConfigConsumedAt(rootDir: string): string | null {
  const path = readInstanceJsonPath(rootDir);
  if (!existsSync(path)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }

  const parsed = InstanceJsonParseSchema.safeParse(raw);
  if (!parsed.success) return null;

  const v = parsed.data.deployConfigConsumedAt?.trim();
  return v !== undefined && v !== "" ? v : null;
}

function defaultPortBundle(): PortBundle {
  const p = DEFAULT_PORTS;
  return {
    workbench: p.workbench,
    server: p.server,
    dbPostgres: p.dbPostgres,
    logtoDb: p.logtoDb,
    logtoCore: p.logtoCore,
    logtoAdmin: p.logtoAdmin,
  };
}

function addDefaultPortsToTaken(taken: Set<number>): void {
  const d = defaultPortBundle();
  taken.add(d.workbench);
  taken.add(d.server);
  taken.add(d.dbPostgres);
  taken.add(d.logtoDb);
  taken.add(d.logtoCore);
  taken.add(d.logtoAdmin);
}

function loadOrInitInstanceJson(
  rootDir: string,
  instanceId: string,
  userHomeForSiblingScan: string,
  pickOpts: PickNonCollidingPortBundleOptions = {},
  allocationLockOptions: InstanceAllocationLockOptions = {},
  additionalClaimedPorts?: () => ReadonlySet<number>,
): InstanceJsonParse {
  const path = readInstanceJsonPath(rootDir);
  if (!existsSync(path)) {
    const id = instanceId.trim();
    if (id === "") {
      const created = buildDefaultInstanceJson(instanceId, defaultPortBundle());
      writeInstanceJsonAtomic(rootDir, created);
      return created;
    }
    return withInstanceAllocationLockSync(userHomeForSiblingScan, () => {
      // A concurrent creator may have published this exact target while this
      // process waited. Re-enter the ordinary validated read path in that case.
      if (existsSync(path)) {
        return loadOrInitInstanceJson(
          rootDir,
          instanceId,
          userHomeForSiblingScan,
          pickOpts,
          allocationLockOptions,
          additionalClaimedPorts,
        );
      }
      const taken = collectClaimedPortsFromSiblingInstances(userHomeForSiblingScan, rootDir);
      // Lifecycle callers may contribute another read-only authority (for
      // example Docker-published ports). Invoke it exactly once while the
      // allocator lock is held, before the instance.json reservation write.
      const additional = additionalClaimedPorts?.() ?? new Set<number>();
      for (const port of additional) {
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error("Additional claimed port provider returned an invalid port");
        }
        taken.add(port);
      }
      // Reserve the default bundle even if ~/.nautilo/instance.json has not
      // been materialized yet. Otherwise a named instance created first can
      // claim default ports and make the later default instance collide.
      addDefaultPortsToTaken(taken);
      const ports = pickFirstNonCollidingPortBundle(taken, pickOpts);
      const created = buildDefaultInstanceJson(instanceId, ports);
      writeInstanceJsonAtomic(rootDir, created);
      return created;
    }, allocationLockOptions);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error(
      `Malformed instance.json at ${path}: not valid JSON. Fix or remove the file before starting Nautilo.`,
    );
  }

  const parsed = InstanceJsonParseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Malformed instance.json at ${path}: ${parsed.error.message}. Fix or remove the file before starting Nautilo.`,
    );
  }

  const selectedId = instanceId.trim();
  if (parsed.data.instanceId !== selectedId) {
    throw new Error(
      `Malformed instance.json at ${path}: instanceId "${parsed.data.instanceId}" does not match selected instance "${selectedId}". Fix or remove the file before starting Nautilo.`,
    );
  }

  if (parsed.data.db.neonProxyPort !== undefined) {
    warnRetiredNeonProxyConfig("instance.json db.neonProxyPort");
  }

  return withDefaultDeploymentMode(parsed.data);
}

function applyUserConfigOverlay(base: InstanceJsonParse): InstanceJsonParse {
  const cfg = fromRuntimeConfig();
  const net = cfg.nautilo_instance_network;
  const host = cfg.nautilo_instance_hostname;
  if (!net && !host) return base;

  const next: InstanceJsonParse = structuredClone(base);

  if (net?.serverPort !== undefined) {
    next.server.port = net.serverPort;
    next.server.url = defaultServerUrl(net.serverPort);
  }
  if (net?.workbenchPort !== undefined) {
    next.workbench.port = net.workbenchPort;
    next.workbench.url = defaultWorkbenchUrl(net.workbenchPort);
  }
  if (net?.dbPostgresHostPort !== undefined) {
    next.db.postgresHostPort = net.dbPostgresHostPort;
    next.db.directConnection = defaultDirectDbConnection(net.dbPostgresHostPort);
  }
  if (net?.neonProxyPort !== undefined) {
    warnRetiredNeonProxyConfig("nautilo.config.ts network.neonProxyPort");
  }
  if (net?.logtoDbPort !== undefined) next.logto.dbPort = net.logtoDbPort;
  if (net?.logtoCorePort !== undefined) next.logto.corePort = net.logtoCorePort;
  if (net?.logtoAdminPort !== undefined) next.logto.adminPort = net.logtoAdminPort;
  if (net?.composeProjectName !== undefined) next.compose.projectName = net.composeProjectName;

  if (host?.federated !== undefined) next.hostname.federated = host.federated;
  if (host?.mdns !== undefined) next.hostname.mdns = host.mdns;
  if (host?.tlsSan !== undefined) next.hostname.tlsSan = host.tlsSan;
  if (host?.caddyAuthHost !== undefined) next.hostname.caddyAuthHost = host.caddyAuthHost;
  if (host?.caddyAuthAdminHost !== undefined) {
    next.hostname.caddyAuthAdminHost = host.caddyAuthAdminHost;
  }

  return next;
}

function applyEnvOverlay(base: InstanceJsonParse, env: NodeJS.ProcessEnv): InstanceJsonParse {
  const next: InstanceJsonParse = structuredClone(base);

  const serverPort = readIntEnv(env, "NAUTILO_PORT");
  if (serverPort !== undefined) {
    next.server.port = serverPort;
    next.server.url = defaultServerUrl(serverPort);
  }
  const serverHost = readStringEnv(env, "NAUTILO_HOST");
  if (serverHost !== undefined) {
    next.server.host = serverHost;
  }

  const serverUrlOverride = readStringEnv(env, "NAUTILO_SERVER_URL");
  if (serverUrlOverride !== undefined) {
    const trimmed = serverUrlOverride.replace(/\/$/, "");
    next.server.url = trimmed;
    try {
      const u = new URL(trimmed);
      if (u.port) {
        const p = Number.parseInt(u.port, 10);
        if (Number.isFinite(p) && p >= 1 && p <= 65535) {
          next.server.port = p;
        }
      } else if (u.protocol === "https:") {
        next.server.port = 443;
      } else if (u.protocol === "http:") {
        next.server.port = 80;
      }
    } catch {
      /* keep server.port from NAUTILO_PORT / defaults */
    }
  }

  const workbenchPort = readIntEnv(env, "NAUTILO_WORKBENCH_PORT");
  if (workbenchPort !== undefined) {
    next.workbench.port = workbenchPort;
    next.workbench.url = defaultWorkbenchUrl(workbenchPort);
  }

  const dbPort = readIntEnv(env, "NAUTILO_DB_PORT");
  if (dbPort !== undefined) {
    next.db.postgresHostPort = dbPort;
    next.db.directConnection = defaultDirectDbConnection(dbPort);
  }
  warnIfRetiredNeonProxyEnvPresent(env);

  const logtoDb = readIntEnv(env, "NAUTILO_LOGTO_DB_PORT");
  if (logtoDb !== undefined) next.logto.dbPort = logtoDb;
  const logtoCore = readIntEnv(env, "NAUTILO_LOGTO_PORT");
  if (logtoCore !== undefined) next.logto.corePort = logtoCore;
  const logtoAdmin = readIntEnv(env, "NAUTILO_LOGTO_ADMIN_PORT");
  if (logtoAdmin !== undefined) next.logto.adminPort = logtoAdmin;

  const project = readStringEnv(env, "COMPOSE_PROJECT_NAME");
  if (project !== undefined) next.compose.projectName = project;

  const federated =
    readStringEnv(env, "NAUTILO_FEDERATED_HOSTNAME") ?? readStringEnv(env, "NAUTILO_HOSTNAME");
  if (federated !== undefined) next.hostname.federated = federated;

  const mdns = readStringEnv(env, "NAUTILO_MDNS_HOSTNAME");
  if (mdns !== undefined) next.hostname.mdns = mdns;

  const tlsSan = readStringEnv(env, "NAUTILO_TLS_SAN");
  if (tlsSan !== undefined) next.hostname.tlsSan = tlsSan;

  const caddyAuth = readStringEnv(env, "NAUTILO_CADDY_AUTH_HOST");
  if (caddyAuth !== undefined) next.hostname.caddyAuthHost = caddyAuth;

  const caddyAdmin = readStringEnv(env, "NAUTILO_CADDY_AUTH_ADMIN_HOST");
  if (caddyAdmin !== undefined) next.hostname.caddyAuthAdminHost = caddyAdmin;

  const deploymentMode = readStringEnv(env, "NAUTILO_DEPLOYMENT_MODE");
  if (deploymentMode !== undefined) {
    if (!(INSTANCE_DEPLOYMENT_MODES as readonly string[]).includes(deploymentMode)) {
      throw new Error(
        `Invalid NAUTILO_DEPLOYMENT_MODE "${deploymentMode}". Expected one of: ${INSTANCE_DEPLOYMENT_MODES.join(", ")}.`,
      );
    }
    next.deploymentMode = deploymentMode as InstanceDeploymentMode;
  }

  const directConn = readStringEnv(env, "DB_DIRECT_CONNECTION");
  if (directConn !== undefined) {
    next.db.directConnection = directConn;
  }

  return next;
}

export type ResolveInstanceOptions = {
  /** When set, used as the user home for `~/.nautilo` resolution (tests / isolated homes). */
  userHomeDir?: string;
  /**
   * When true, skip the localhost TCP bind probe when picking a named-instance
   * port bundle. **Tests only** — keeps unit tests deterministic when the dev
   * machine already has Nautilo (or other) listeners on stride ports.
   */
  skipHostBindProbe?: boolean;
  /**
   * Lifecycle-tool seam: use the selected instance's disk topology without
   * applying the process-wide user config overlay. This prevents a global
   * dev override from aliasing an explicitly selected source/target pair.
   */
  skipUserConfigOverlay?: boolean;
  /** Test-only notifications for deterministic multi-process allocator tests. */
  allocationLock?: InstanceAllocationLockOptions;
  /**
   * Lifecycle-tool seam for an additional read-only port authority. Called
   * exactly once under the named-instance allocation lock before publication.
   */
  additionalClaimedPorts?: () => ReadonlySet<number>;
};

/**
 * Resolve the local instance bundle (ports, URLs, compose project, hostnames).
 *
 * Precedence for overlapping fields: **env > `nautilo.config.ts` (`fromRuntimeConfig`) >
 * `instance.json` on disk > built-in defaults**.
 *
 * On first access, missing `instance.json` is created: the default instance uses
 * the built-in literal port bundle; **named** instances pick the first bundle that
 * avoids sibling `instance.json` ports under each `~/.nautilo` and `~/.nautilo-<id>`
 * root and passes a localhost TCP bind probe before write (see host-port-liveness).
 */
export function resolveInstance(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveInstanceOptions = {},
): ResolvedInstance {
  if (cached) return cached;
  cached = resolveInstanceUncached(env, options);
  return cached;
}

/**
 * Resolve one explicit instance without reading or populating the process-wide
 * singleton. Lifecycle tools use this when source and target must coexist in
 * one process; ordinary product callers should continue to use
 * {@link resolveInstance}.
 */
export function resolveInstanceUncached(
  env: NodeJS.ProcessEnv,
  options: ResolveInstanceOptions = {},
): ResolvedInstance {
  const userHomeFromOptions = options.userHomeDir?.trim();
  const userHomeFromEnv = env["HOME"]?.trim() || env["USERPROFILE"]?.trim();
  const userHomeForRoot =
    userHomeFromOptions && userHomeFromOptions !== ""
      ? userHomeFromOptions
      : userHomeFromEnv && userHomeFromEnv !== ""
        ? userHomeFromEnv
        : undefined;

  const rootDir = resolveNautiloRootDir(
    userHomeForRoot ? { env, userHomeDir: userHomeForRoot } : { env },
  );

  const userHomeForSiblings = userHomeForRoot ?? userHomeDirFromEnv(env);

  const instanceId = (env["NAUTILO_INSTANCE_ID"] ?? "").trim();
  const disk = loadOrInitInstanceJson(
    rootDir,
    instanceId,
    userHomeForSiblings,
    options.skipHostBindProbe === true ? { skipHostBindProbe: true } : {},
    options.allocationLock ?? {},
    options.additionalClaimedPorts,
  );
  const withUser =
    options.skipUserConfigOverlay === true ? disk : applyUserConfigOverlay(disk);
  const merged = stripRetiredNeonProxyFields(applyEnvOverlay(withUser, env));

  return hydrateComposeContainers(merged);
}

/** Test-only: clear the module-level resolveInstance() cache. */
export function __resetResolvedInstanceForTests(): void {
  cached = null;
}
