import type { ResolvedInstance } from "@nautilo/config";
import { httpsMode } from "./https-mode.ts";
import type { ComposeDriverProfile } from "./types.ts";

/**
 * Public server base URL for a remote compose profile.
 * Precedence matches deploy: LetsEncrypt domain → explicit base_url → ssh.host:port.
 * `serverPort` is required only for the http://ssh.host:port fallback.
 */
function resolveRemoteComposePublicBaseUrl(
  profile: ComposeDriverProfile,
  serverPort?: number,
): string {
  if (profile.transport !== "remote") {
    throw new Error(
      `resolveRemoteComposePublicBaseUrl: expected transport=remote, got '${profile.transport}'`,
    );
  }
  if (
    httpsMode(profile) === "letsencrypt" &&
    profile.domain !== undefined &&
    profile.domain.trim().length > 0
  ) {
    return `https://${profile.domain.trim()}`;
  }
  const explicit = profile.base_url?.trim();
  if (explicit && explicit.length > 0) {
    return explicit.replace(/\/$/, "");
  }
  if (profile.ssh?.host === undefined) {
    throw new Error(
      `resolveRemoteComposePublicBaseUrl: remote profile '${profile.name}' has neither base_url nor ssh.host`,
    );
  }
  if (serverPort === undefined) {
    throw new Error(
      `resolveRemoteComposePublicBaseUrl: remote profile '${profile.name}' needs server.port from instance.json for http://${profile.ssh.host}:<port>`,
    );
  }
  return `http://${profile.ssh.host}:${serverPort}`;
}

/**
 * Public base URL of the nautilo-server for a given profile.
 * - Local: http://localhost:<inst.server.port>
 * - Remote: profile.base_url (trailing / stripped) OR http://<ssh.host>:<inst.server.port>
 */
export function resolveServerBaseUrl(
  profile: ComposeDriverProfile,
  inst: ResolvedInstance,
): string {
  if (profile.transport === "remote") {
    return resolveRemoteComposePublicBaseUrl(profile, inst.server.port);
  }
  return `http://localhost:${inst.server.port}`;
}

/**
 * Public Logto core URL (host-facing) for a given profile.
 * - Local: http://localhost:<inst.logto.corePort>
 * - Remote: http://<ssh.host>:<inst.logto.corePort>
 */
export function resolveLogtoPublicUrl(
  profile: ComposeDriverProfile,
  inst: ResolvedInstance,
): string {
  const corePort = inst.logto.corePort;
  if (profile.transport === "remote") {
    if (
      httpsMode(profile) === "letsencrypt" &&
      profile.domain !== undefined &&
      profile.domain.trim().length > 0
    ) {
      return `https://auth.${profile.domain}`;
    }
    if (profile.ssh?.host === undefined) {
      throw new Error(
        `resolveLogtoPublicUrl: remote profile '${profile.name}' missing ssh.host`,
      );
    }
    return `http://${profile.ssh.host}:${corePort}`;
  }
  return `http://localhost:${corePort}`;
}

/**
 * Public Logto admin URL — same pattern.
 */
export function resolveLogtoAdminPublicUrl(
  profile: ComposeDriverProfile,
  inst: ResolvedInstance,
): string {
  const adminPort = inst.logto.adminPort;
  if (profile.transport === "remote") {
    if (profile.ssh?.host === undefined) {
      throw new Error(
        `resolveLogtoAdminPublicUrl: remote profile '${profile.name}' missing ssh.host`,
      );
    }
    return `http://${profile.ssh.host}:${adminPort}`;
  }
  return `http://localhost:${adminPort}`;
}

/**
 * Loopback URL wired into the Logto container's `ADMIN_ENDPOINT`.
 *
 * Logto OSS makes internal HTTP/OIDC calls against this value while
 * handling Management API requests. On a remote droplet, pointing it
 * at the public IP causes hairpin timeouts (~10s → auth.unauthorized
 * TimeoutError) during bootstrap's admin `signInMode` flip. The
 * operator-facing public admin URL stays in `LOGTO_ADMIN_ENDPOINT`;
 * bootstrap reaches the admin port via SSH tunnel to localhost.
 */
export function resolveLogtoAdminContainerEndpoint(
  inst: ResolvedInstance,
): string {
  return `http://127.0.0.1:${inst.logto.adminPort}`;
}
