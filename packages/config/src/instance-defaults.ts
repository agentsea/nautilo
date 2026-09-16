/**
 * Built-in defaults for `instance.json` / `resolveInstance()` (default instance).
 * Values match pre-M071 literals so default behavior is unchanged.
 */

import * as path from "node:path";
import { resolveNautiloRootDir } from "./runtime-paths";

export const INSTANCE_JSON_SCHEMA_VERSION = 1 as const;

/** D112 — how this Nautilo instance is deployed (distinct from security `DeploymentMode` in `config.ts`). */
export const INSTANCE_DEPLOYMENT_MODES = [
  "local-self-host",
  "lan-self-host",
  "cloud-managed",
  "dev-multi-instance",
] as const;

export type InstanceDeploymentMode = (typeof INSTANCE_DEPLOYMENT_MODES)[number];

/** Default server bind host (matches `bin/nautilo-server` bind when unset). */
export const DEFAULT_SERVER_HOST = "127.0.0.1" as const;

export const DEFAULT_PORTS = {
  workbench: 3000,
  server: 3001,
  /** Host port published for legacy `nautilo-postgres` compose. */
  dbPostgres: 5434,
  logtoDb: 5432,
  logtoCore: 3301,
  logtoAdmin: 3302,
} as const;

/** Offset applied to every host port for a named-instance allocation candidate. */
export const INSTANCE_PORT_BUNDLE_STRIDE = 100 as const;

/** Host ports derived from a selected instance stride, rather than persisted in `instance.json`. */
export const DERIVED_INSTANCE_HOST_PORT_BASES = {
  office: 2003,
  collabora: 9980,
  /** Local OpenConnector sidecar; deliberately distinct from Workbench 3000. */
  openConnector: 3010,
} as const;

/**
 * Every host-port base generated from an instance stride. Keep this together so
 * allocation bounds cover both the persisted reservation and child-env ports.
 */
export const INSTANCE_GENERATED_HOST_PORT_BASES = [
  DEFAULT_PORTS.workbench,
  DEFAULT_PORTS.server,
  DEFAULT_PORTS.dbPostgres,
  DEFAULT_PORTS.logtoDb,
  DEFAULT_PORTS.logtoCore,
  DEFAULT_PORTS.logtoAdmin,
  DERIVED_INSTANCE_HOST_PORT_BASES.office,
  DERIVED_INSTANCE_HOST_PORT_BASES.collabora,
  DERIVED_INSTANCE_HOST_PORT_BASES.openConnector,
] as const;

export const DEFAULT_HOSTNAMES = {
  /** Federated-id RHS and TLS identity for local dev. */
  federated: "nautilo.local",
  /** mDNS / Bonjour advertisement name (aligned with federated host today). */
  mdns: "nautilo.local",
  /** Comma-separated SAN list placeholder; empty means “derive from federated”. */
  tlsSan: "",
  caddyAuthHost: "auth.nautilo.local",
  caddyAuthAdminHost: "auth-admin.nautilo.local",
} as const;

export function defaultServerUrl(port: number): string {
  return `http://localhost:${port}`;
}

export function defaultWorkbenchUrl(port: number): string {
  return `http://localhost:${port}`;
}

export function defaultDirectDbConnection(postgresHostPort: number): string {
  return `postgresql://postgres:postgres@localhost:${postgresHostPort}/nautilo`;
}

export const DEFAULT_COMPOSE_PROJECT_NAME = "nautilo" as const;

/** Deterministic hostname bundle for a named instance (`NAUTILO_INSTANCE_ID` non-empty). */
export function hostnamesForNamedInstance(instanceId: string): {
  federated: string;
  mdns: string;
  tlsSan: string;
  caddyAuthHost: string;
  caddyAuthAdminHost: string;
} {
  const id = instanceId.trim();
  return {
    federated: `${id}.local`,
    mdns: `${id}.local`,
    tlsSan: "",
    caddyAuthHost: `auth.${id}.local`,
    caddyAuthAdminHost: `auth-admin.${id}.local`,
  };
}

/**
 * M088B — server-owned artifact byte storage root.
 *
 * Resolves the absolute directory under which `<artifactsRoot>/<uuid>`
 * physical files for the `file` tool's `workspace` zone (and
 * `generate_image`) land. Decoupled from any client-supplied
 * `workspacePath` so a Droplet / packaged-server deployment can mount
 * a persistent volume there without leaking the client's local
 * filesystem layout into the server.
 *
 * Precedence:
 *   1. `process.env.NAUTILO_ARTIFACTS_ROOT` if set + absolute.
 *   2. `<resolveNautiloRootDir()>/artifacts` (instance-suffixed home per
 *      `NAUTILO_INSTANCE_ID`; default `~/.nautilo/artifacts`).
 *
 * Forward-compat note: when M042+ multi-user lands the layout flips to
 * `<artifactsRoot>/<userId>/<uuid>`. Until then the layout is flat —
 * single operator per Server. The migrator in `bin/nautilo-dev/`
 * relocates pre-M088B byte locations into this root.
 *
 * No directory side-effect at import time. Callers that need to write
 * here `mkdir -p` on first use.
 */
export function getArtifactsRoot(): string {
  const fromEnv = process.env["NAUTILO_ARTIFACTS_ROOT"]?.trim();
  if (fromEnv && path.isAbsolute(fromEnv)) return fromEnv;
  return path.join(resolveNautiloRootDir({ env: process.env }), "artifacts");
}

/**
 * M182 — server-installed mini-app source folders root.
 *
 * Sibling of the artifacts root: `<dirname(getArtifactsRoot())>/apps`.
 * No `NAUTILO_APPS_ROOT` env override in PR 1.
 */
export function getAppsRoot(): string {
  return path.join(path.dirname(getArtifactsRoot()), "apps");
}

/**
 * D136-P2 — explicit boot-time validator for `NAUTILO_ARTIFACTS_ROOT`.
 *
 * `getArtifactsRoot()` above silently falls back to the default when
 * the env var is set to a malformed value (blank, relative, contains
 * `..`). That's the right behavior for the byte-storage call path —
 * a misconfigured env var should not crash the server. But operators
 * setting the env var on purpose deserve a loud, explicit complaint
 * at boot time so they don't end up unknowingly writing to
 * `~/.nautilo/artifacts/` when they meant `/mnt/data/artifacts/`.
 *
 * Call this from server boot (or `bin/nautilo-dev`) to surface
 * misconfiguration; don't gate `getArtifactsRoot()` itself.
 *
 * Returns the resolved root on success (which always succeeds — see
 * fallback above) and a structured rejection on malformed env values.
 */
export type ArtifactsRootValidation =
  | { ok: true; source: "env" | "default"; root: string }
  | { ok: false; reason: string };

/**
 * Durable media byte storage root (profile avatars + server icon).
 *
 * Precedence:
 *   1. `process.env.NAUTILO_MEDIA_ROOT` if set + absolute.
 *   2. `<resolveNautiloRootDir()>` (instance-suffixed home per
 *      `NAUTILO_INSTANCE_ID`; default `~/.nautilo`).
 *
 * Sub-paths:
 *   - `getProfileAvatarsRoot()` → `<mediaRoot>/profile-avatars`
 *   - `getServerIconRoot()` → `<mediaRoot>/server-icon`
 *
 * No directory side-effect at import time. Callers that need to write
 * here `mkdir -p` on first use.
 */
export function getMediaStorageRoot(): string {
  const fromEnv = process.env["NAUTILO_MEDIA_ROOT"]?.trim();
  if (fromEnv && path.isAbsolute(fromEnv)) return fromEnv;
  return resolveNautiloRootDir({ env: process.env });
}

export function getProfileAvatarsRoot(): string {
  return path.join(getMediaStorageRoot(), "profile-avatars");
}

export function getServerIconRoot(): string {
  return path.join(getMediaStorageRoot(), "server-icon");
}

export type MediaStorageRootValidation =
  | { ok: true; source: "env" | "default"; root: string }
  | { ok: false; reason: string };

export function validateMediaStorageRootEnv(
  envValue: string | undefined = process.env["NAUTILO_MEDIA_ROOT"],
): MediaStorageRootValidation {
  if (envValue === undefined) {
    return { ok: true, source: "default", root: getMediaStorageRoot() };
  }
  const trimmed = envValue.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      reason: "NAUTILO_MEDIA_ROOT is set but empty/blank; unset it or set an absolute path",
    };
  }
  if (!path.isAbsolute(trimmed)) {
    return {
      ok: false,
      reason: `NAUTILO_MEDIA_ROOT must be an absolute path (got "${trimmed}")`,
    };
  }
  const segments = trimmed.split(path.sep);
  if (segments.some((s) => s === "..")) {
    return {
      ok: false,
      reason: `NAUTILO_MEDIA_ROOT must not contain ".." segments (got "${trimmed}")`,
    };
  }
  return { ok: true, source: "env", root: trimmed };
}

export function validateArtifactsRootEnv(
  envValue: string | undefined = process.env["NAUTILO_ARTIFACTS_ROOT"],
): ArtifactsRootValidation {
  if (envValue === undefined) {
    return { ok: true, source: "default", root: getArtifactsRoot() };
  }
  const trimmed = envValue.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      reason: "NAUTILO_ARTIFACTS_ROOT is set but empty/blank; unset it or set an absolute path",
    };
  }
  if (!path.isAbsolute(trimmed)) {
    return {
      ok: false,
      reason: `NAUTILO_ARTIFACTS_ROOT must be an absolute path (got "${trimmed}")`,
    };
  }
  // Reject `..` segments anywhere in the path. An absolute path that
  // contains `..` is technically resolvable, but it's a strong signal
  // the operator copy-pasted from a relative context and meant
  // something else. Fail closed.
  const segments = trimmed.split(path.sep);
  if (segments.some((s) => s === "..")) {
    return {
      ok: false,
      reason: `NAUTILO_ARTIFACTS_ROOT must not contain ".." segments (got "${trimmed}")`,
    };
  }
  return { ok: true, source: "env", root: trimmed };
}
