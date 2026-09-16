type ServerUrlInput = {
  server: {
    host: string;
    port: number;
  };
};

export function isLanServerHost(host: string): boolean {
  return host !== "127.0.0.1" && host !== "localhost";
}

/**
 * M092 — opt-out of the LAN-host TLS branch. When set to a truthy
 * value, the server skips its self-signed cert path and serves plain
 * HTTP even when bound on `0.0.0.0`. Used by the containerized deploy
 * stack where the host port-forward IS the trust boundary
 * (`localhost:<port>` from the operator's machine) and a self-signed
 * cert inside the container has nowhere safe to surface to the host
 * (CLI + Electron + workbench cannot trust a CA that lives at
 * `/root/.nautilo/certs/ca.crt` inside the server container without
 * extra plumbing). Real LAN/cloud TLS lands in D120 A7 via Caddy.
 */
function tlsDisabledByEnv(env: NodeJS.ProcessEnv | undefined): boolean {
  const raw = env?.["NAUTILO_DISABLE_TLS"]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return false;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function effectiveServerScheme(
  host: string,
  env: NodeJS.ProcessEnv | undefined = typeof process !== "undefined"
    ? process.env
    : undefined,
): "http" | "https" {
  if (tlsDisabledByEnv(env)) return "http";
  return isLanServerHost(host) ? "https" : "http";
}

export function effectiveServerDisplayHost(host: string): string {
  if (host === "0.0.0.0" || host === "::" || host === "localhost") {
    return "127.0.0.1";
  }
  return host;
}

export function resolveEffectiveServerUrl(
  instance: ServerUrlInput,
  options: { port?: number; env?: NodeJS.ProcessEnv } = {},
): string {
  const host = instance.server.host;
  const port = options.port ?? instance.server.port;
  const scheme = effectiveServerScheme(host, options.env);
  const displayHost = effectiveServerDisplayHost(host);
  return `${scheme}://${displayHost}:${port}`;
}
