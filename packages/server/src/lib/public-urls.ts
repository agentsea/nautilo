type InstanceUrls = {
  server: { url: string };
  workbench: { url: string };
};

/**
 * Public URLs are what Nautilo advertises to browsers, Electron, setup
 * surfaces, and invite links. They are deliberately separate from
 * `resolveInstance().server.{host,port}` because the server may bind on
 * `0.0.0.0:3001` behind Caddy while its public origin is
 * `https://<domain>`.
 */
function readPublicBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const publicBase = env["NAUTILO_PUBLIC_BASE_URL"]?.trim();
  if (publicBase) return publicBase.replace(/\/$/, "");
  return null;
}

export function resolvePublicServerUrl(
  instance: InstanceUrls,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return readPublicBaseUrl(env) ?? instance.server.url.replace(/\/$/, "");
}

export function resolvePublicWorkbenchUrl(
  instance: InstanceUrls,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const publicBase = readPublicBaseUrl(env);
  if (publicBase) return publicBase;
  return instance.workbench.url.replace(/\/$/, "");
}
