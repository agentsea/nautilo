import {
  parseEnvFile,
  serializeEnvFile,
  setValueInEntries,
  writeFileAtomic,
} from "@nautilo/config-guard";
import {
  resolvedInstanceChildEnv,
  type ResolvedInstance,
} from "@nautilo/config";

const TOPOLOGY_KEYS = [
  "NAUTILO_INSTANCE_ID",
  "COMPOSE_PROJECT_NAME",
  "NAUTILO_PORT",
  "NAUTILO_WORKBENCH_PORT",
  "NAUTILO_DB_PORT",
  "NAUTILO_LOGTO_DB_PORT",
  "NAUTILO_LOGTO_PORT",
  "NAUTILO_LOGTO_ADMIN_PORT",
  "LOGTO_DB_PORT",
  "LOGTO_ENDPOINT",
  "LOGTO_ENDPOINT_INTERNAL",
  "LOGTO_ISSUER",
  "LOGTO_JWKS_URI",
  "LOGTO_ADMIN_ENDPOINT",
  "NAUTILO_SERVER_URL",
  "NAUTILO_PUBLIC_BASE_URL",
  "NAUTILO_HOST",
  "DB_DIRECT_CONNECTION",
  "DB_CONNECTION_STRING",
  "DB_AGENT_CONNECTION_STRING",
  "DB_AGENT_DIRECT_CONNECTION",
  "NAUTILO_FEDERATED_HOSTNAME",
  "NAUTILO_MDNS_HOSTNAME",
  "NAUTILO_TLS_SAN",
  "NAUTILO_CADDY_AUTH_HOST",
  "NAUTILO_CADDY_AUTH_ADMIN_HOST",
] as const;

function envPairs(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const entry of parseEnvFile(raw)) {
    if (entry.type === "pair") values[entry.key] = entry.value;
  }
  return values;
}

export function rebindCloneEnvContent(input: {
  sourceRaw: string;
  sourceRoot: string;
  targetRoot: string;
  target: ResolvedInstance;
}): string {
  const sourceValues = envPairs(input.sourceRaw);
  const child = resolvedInstanceChildEnv(input.target, {
    ...sourceValues,
    NAUTILO_INSTANCE_ID: input.target.instanceId,
  });
  const targetValues: Record<string, string> = {
    ...child,
    // Host-mode server processes prefer the internal endpoint when it is
    // present. A clone must therefore rebind this source-owned value too;
    // retaining default's localhost port silently routes clone authentication
    // back through default Logto (or hangs while default is stopped).
    LOGTO_ENDPOINT_INTERNAL: `http://localhost:${input.target.logto.corePort}`,
    LOGTO_ISSUER: `${child["LOGTO_ENDPOINT"]}/oidc`,
    LOGTO_JWKS_URI: `${child["LOGTO_ENDPOINT"]}/oidc/jwks`,
    LOGTO_ADMIN_ENDPOINT: `http://localhost:${input.target.logto.adminPort}`,
    NAUTILO_PUBLIC_BASE_URL: input.target.server.url,
  };

  let entries = parseEnvFile(input.sourceRaw).map((entry) => {
    if (
      entry.type === "pair" &&
      (entry.value === input.sourceRoot ||
        entry.value.startsWith(`${input.sourceRoot}/`))
    ) {
      const value = `${input.targetRoot}${entry.value.slice(input.sourceRoot.length)}`;
      return { ...entry, value, raw: `${entry.key}=${value}` };
    }
    return entry;
  });
  for (const key of TOPOLOGY_KEYS) {
    const value = targetValues[key];
    if (value !== undefined) entries = setValueInEntries(entries, key, value);
  }
  return serializeEnvFile(entries);
}

export async function writeReboundCloneEnv(
  path: string,
  content: string,
): Promise<void> {
  await writeFileAtomic(path, content);
}
