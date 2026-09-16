/**
 * Posture sidecar read + atomic-write. D060 ship-plan G4.
 *
 * `nautilo.config.ts` holds the base server posture (the defaults
 * shipped with the install). `PUT /api/security/posture` mutations
 * write HERE — a sidecar JSON file at `~/.nautilo/posture.json` —
 * so a change survives restart without rewriting the TypeScript
 * config module (which would require AST surgery, touching imports,
 * etc.).
 *
 * Boot-time ordering (see `bin/nautilo-server/src/index.ts`):
 *   1. `nautilo.config.ts` → flat runtime config via
 *      `normalizeUserConfig` + `setConfigOverrides`.
 *   2. `readPostureSidecar(path)` → if present, override the two
 *      posture fields via `setConfigOverrides` again. Sidecar wins.
 *
 * PUT-time ordering (see `lib/posture-mutator.ts`):
 *   1. JSONL audit row (forensic, append-only).
 *   2. `writePostureSidecar` (atomic; survives restart).
 *   3. `setConfigOverrides` (current session).
 *   4. `policy.changed` broadcast (live clients).
 *
 * Atomic-write pattern: write to `<path>.tmp-<pid>`, fsync, then
 * `rename()` to the final path. POSIX rename is atomic for files
 * on the same filesystem, so a reader either sees the old content
 * OR the new — never partial. Mode 0o600 since posture is
 * security-sensitive (a household user reading it could plan an
 * attack around the current security_level).
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  DeploymentModeSchema,
  NetworkPolicySchema,
  SecurityLevelSchema,
  defaultNetworkPolicyForDeploymentMode,
  type ServerPosture,
} from "@nautilo/config";
import { warn } from "@nautilo/logger";
import { z } from "zod";

/**
 * On-disk shape — includes a version number so future migrations
 * can fail-closed on unknown versions rather than silently
 * misinterpreting fields. v1 is the current shape.
 */
const SidecarV1Schema = z.object({
  version: z.literal(1),
  deploymentMode: DeploymentModeSchema,
  securityLevel: SecurityLevelSchema,
});

const SidecarV2Schema = z.object({
  version: z.literal(2),
  deploymentMode: DeploymentModeSchema,
  securityLevel: SecurityLevelSchema,
  networkPolicy: NetworkPolicySchema,
});

const SidecarV3Schema = z.object({
  version: z.literal(3),
  deploymentMode: DeploymentModeSchema,
  securityLevel: SecurityLevelSchema,
  networkPolicy: NetworkPolicySchema,
  // D538 — false for every existing sidecar/upgrade unless an Owner or Admin
  // explicitly changes the existing security-posture setting.
  allowUncontainedHostCommands: z.boolean(),
});

const SidecarSchema = z.union([SidecarV1Schema, SidecarV2Schema, SidecarV3Schema]);

/** The persisted security posture, including D538's default-off policy. */
export type PersistedPosture = ServerPosture & {
  readonly allowUncontainedHostCommands: boolean;
};

/**
 * Read the posture sidecar. Returns `null` if the file is absent
 * (first boot, never mutated), or if its contents are malformed —
 * either way the caller falls back to the config-file defaults.
 *
 * Malformed-file handling: we LOG a warning but do NOT throw. A
 * corrupt sidecar shouldn\u0027t prevent the server from booting —
 * the operator can re-apply the intended posture via the Settings
 * UI. Erroring out loudly here would turn a minor disk issue into
 * a full outage.
 */
export function readPostureSidecar(path: string): PersistedPosture | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    warn(
      `[posture-sidecar] read ${path} failed: ${String(err)}. ` +
        `Falling back to caller-supplied defaults (entry-point or operator hint).`,
    );
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const validated = SidecarSchema.parse(parsed);
    return {
      deploymentMode: validated.deploymentMode,
      securityLevel: validated.securityLevel,
      networkPolicy:
        validated.version === 2 || validated.version === 3
          ? validated.networkPolicy
          : defaultNetworkPolicyForDeploymentMode(validated.deploymentMode),
      allowUncontainedHostCommands:
        validated.version === 3
          ? validated.allowUncontainedHostCommands
          : false,
    };
  } catch (err) {
    warn(
      `[posture-sidecar] invalid sidecar at ${path}: ${String(err)}. ` +
        `Falling back to caller-supplied defaults. Delete the file ` +
        `or re-apply via PUT /api/security/posture to fix.`,
    );
    return null;
  }
}

/**
 * First-boot provisioner — D060 ship-plan G4. Reads the sidecar; if
 * absent, writes `defaults` atomically and returns them. The intent
 * is that each entry-point (headless `bin/nautilo-server`, embedded
 * Electron `apps/desktop`) owns its OWN platform-appropriate
 * defaults and calls this helper before any other posture read:
 *
 *   - Headless server     → ("server",            "paranoid")
 *   - Electron-embedded   → ("desktop-permissive", "cautious")
 *
 * The first caller wins. Electron's `boot()` runs `ensurePostureSidecar`
 * BEFORE `startServer()` spawns the headless binary, so a desktop
 * install boots with the desktop defaults; the server\u0027s subsequent
 * `ensurePostureSidecar` call sees the sidecar already present and
 * is a no-op. A pure-headless install never runs Electron, so the
 * server-bin\u0027s call is the one that lands on first boot.
 *
 * Malformed-sidecar handling: if the file exists but parses as
 * malformed (`readPostureSidecar` returns null), we DO NOT overwrite
 * it — that would mask operator misconfiguration. Caller falls back
 * to `defaults` for the current process; operator sees the
 * `[posture-sidecar] invalid sidecar at ...` warn line and re-applies
 * via PUT /api/security/posture.
 */
export function ensurePostureSidecar(
  path: string,
  defaults: ServerPosture,
): PersistedPosture {
  if (existsSync(path)) {
    const existing = readPostureSidecar(path);
    if (existing !== null) return existing;
    // File exists but malformed — DO NOT overwrite. Use defaults for
    // this process; preserve the bad file for operator triage.
    return { ...defaults, allowUncontainedHostCommands: false };
  }
  writePostureSidecar(path, defaults);
  return { ...defaults, allowUncontainedHostCommands: false };
}

/**
 * Atomically write the posture sidecar. Throws on failure — the
 * caller (posture-mutator) treats an audit-log-then-write failure
 * as a reason to abort the mutation chain without broadcasting
 * policy.changed or updating in-memory config, preserving
 * consistency.
 */
export function writePostureSidecar(
  path: string,
  posture: ServerPosture & {
    readonly allowUncontainedHostCommands?: boolean;
  },
): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });

  const tmpPath = `${path}.tmp-${process.pid}`;
  const line = `${JSON.stringify({
    version: 3,
    deploymentMode: posture.deploymentMode,
    securityLevel: posture.securityLevel,
    networkPolicy:
      posture.networkPolicy ??
      defaultNetworkPolicyForDeploymentMode(posture.deploymentMode),
    allowUncontainedHostCommands:
      posture.allowUncontainedHostCommands ?? false,
  })}\n`;

  const fd = openSync(tmpPath, "w", 0o600);
  try {
    writeSync(fd, line, null, "utf-8");
    fsyncSync(fd);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // swallow — tmp-file close failure doesn\u0027t affect the
      // eventual rename; keep going and let rename's error surface
      // if the tmp is truly broken.
    }
  }

  try {
    renameSync(tmpPath, path);
  } catch (err) {
    // Try to clean up the tmp file so the directory doesn\u0027t
    // accumulate *.tmp-<pid> leftovers.
    try {
      unlinkSync(tmpPath);
    } catch {
      // best effort
    }
    throw err;
  }
}
