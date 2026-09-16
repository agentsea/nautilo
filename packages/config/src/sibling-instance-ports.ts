import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, normalize } from "node:path";
import { warn } from "@nautilo/logger";
import {
  DEFAULT_PORTS,
  INSTANCE_GENERATED_HOST_PORT_BASES,
  INSTANCE_PORT_BUNDLE_STRIDE,
} from "./instance-defaults";
import { validateNautiloInstanceIdValue } from "./instance-id";
import { bundlePassesHostTcpBindProbeSync } from "./host-port-liveness";
import { InstanceJsonParseSchema } from "./resolve-instance-schema";
import { warnRetiredNeonProxyConfig } from "./retired-neon-proxy";

/** Host-side ports from `instance.json` that must not collide across stacks. */
export type PortBundle = {
  workbench: number;
  server: number;
  dbPostgres: number;
  logtoDb: number;
  logtoCore: number;
  logtoAdmin: number;
};

export type PickNonCollidingPortBundleOptions = {
  /**
   * When true, skip the OS bind probe (sibling collision logic only).
   * Used by unit tests that do not need host realism.
   */
  skipHostBindProbe?: boolean;
};

const MAX_TCP_PORT = 65535;

/**
 * Inclusive stride bound for the complete generated host-port topology.
 * Derived child-env ports participate even though only the persisted bundle is
 * reserved in `instance.json`.
 */
export const MAX_PORT_BUNDLE_STRIDE = Math.floor(
  (MAX_TCP_PORT - Math.max(...INSTANCE_GENERATED_HOST_PORT_BASES)) /
    INSTANCE_PORT_BUNDLE_STRIDE,
);

function generatedHostPortsForStride(stride: number): number[] {
  const offset = stride * INSTANCE_PORT_BUNDLE_STRIDE;
  return INSTANCE_GENERATED_HOST_PORT_BASES.map((base) => base + offset);
}

/**
 * Discover `~/.nautilo` and `~/.nautilo-<id>/` layout roots (valid `<id>` only).
 */
export function discoverNautiloLayoutRoots(userHomeDir: string): string[] {
  const home = normalize(userHomeDir);
  const roots: string[] = [];
  let entries;
  try {
    entries = readdirSync(home, { withFileTypes: true });
  } catch {
    return roots;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const name = ent.name;
    if (name === ".nautilo") {
      roots.push(join(home, name));
      continue;
    }
    if (!name.startsWith(".nautilo-")) continue;
    const id = name.slice(".nautilo-".length);
    if (id === "" || validateNautiloInstanceIdValue(id) !== null) continue;
    roots.push(join(home, name));
  }
  return roots;
}

/**
 * Union of host ports claimed in sibling `instance.json` files (excludes
 * `currentRootDir`). Malformed sibling files log a warning and are skipped.
 */
export function collectClaimedPortsFromSiblingInstances(
  userHomeDir: string,
  currentRootDir: string,
): Set<number> {
  const taken = new Set<number>();
  const current = normalize(currentRootDir);
  const roots = discoverNautiloLayoutRoots(userHomeDir);
  for (const root of roots) {
    if (normalize(root) === current) continue;
    const path = join(root, "instance.json");
    let raw: unknown;
    try {
      if (!existsSync(path)) continue;
      raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch (e) {
      warn(
        `[resolveInstance] skipping malformed sibling instance.json at ${path}: ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }
    const parsed = InstanceJsonParseSchema.safeParse(raw);
    if (!parsed.success) {
      warn(
        `[resolveInstance] skipping invalid sibling instance.json at ${path}: ${parsed.error.message}`,
      );
      continue;
    }
    const j = parsed.data;
    if (j.db.neonProxyPort !== undefined) {
      warnRetiredNeonProxyConfig("instance.json db.neonProxyPort");
    }
    taken.add(j.server.port);
    taken.add(j.workbench.port);
    taken.add(j.db.postgresHostPort);
    taken.add(j.logto.dbPort);
    taken.add(j.logto.corePort);
    taken.add(j.logto.adminPort);
  }
  return taken;
}

/**
 * First host port bundle (stride-shifted from {@link DEFAULT_PORTS}) whose
 * six ports are unique, in range, not present in `taken`, and (unless
 * {@link PickNonCollidingPortBundleOptions.skipHostBindProbe} is set) each
 * passes a localhost TCP bind probe on the host.
 */
export function pickFirstNonCollidingPortBundle(
  taken: Set<number>,
  options: PickNonCollidingPortBundleOptions = {},
): PortBundle {
  const skipProbe = options.skipHostBindProbe === true;
  const d = DEFAULT_PORTS;
  for (let k = 0; k <= MAX_PORT_BUNDLE_STRIDE; k++) {
    const o = k * INSTANCE_PORT_BUNDLE_STRIDE;
    const bundle: PortBundle = {
      workbench: d.workbench + o,
      server: d.server + o,
      dbPostgres: d.dbPostgres + o,
      logtoDb: d.logtoDb + o,
      logtoCore: d.logtoCore + o,
      logtoAdmin: d.logtoAdmin + o,
    };
    const values = [
      bundle.workbench,
      bundle.server,
      bundle.dbPostgres,
      bundle.logtoDb,
      bundle.logtoCore,
      bundle.logtoAdmin,
    ];
    const generatedPorts = generatedHostPortsForStride(k);
    if (generatedPorts.some((p) => !Number.isInteger(p) || p < 1 || p > MAX_TCP_PORT)) {
      continue;
    }
    if (new Set(values).size !== 6) continue;
    if (values.some((p) => taken.has(p))) continue;
    if (!skipProbe && !bundlePassesHostTcpBindProbeSync(values)) continue;
    return bundle;
  }
  throw new Error(
    `Could not allocate a usable port bundle for this Nautilo instance after evaluating the complete derived candidate space ` +
      `(${MAX_PORT_BUNDLE_STRIDE + 1} candidates; strides 0 through ${MAX_PORT_BUNDLE_STRIDE}). ` +
      "Another stack may claim overlapping ports in sibling ~/.nautilo layout roots, " +
      "or non-Nautilo processes may already be listening on the host. " +
      "Free the conflicting ports or remove stale sibling instance.json files.",
  );
}
