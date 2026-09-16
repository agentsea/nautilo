import { shellQuote } from "./remote-exec.ts";
import {
  getValueFromEntries,
  parseEnvFile,
  serializeEnvFile,
} from "@nautilo/config-guard";

export interface RemoteAuthRuntimePorts {
  logtoCoreContainer: number;
  logtoCore: number;
  logtoAdmin: number;
  logtoDb: number;
}

/**
 * Copy only bootstrap-managed values into the latest canonical environment.
 *
 * The remote reconcile bootstrap runs against a bounded local snapshot. The
 * remote file may receive unrelated operator changes while bootstrap is
 * running, so publishing the entire snapshot would lose those changes. This
 * line-oriented merge preserves every unrelated byte/line and updates only
 * the last effective occurrence of each managed key.
 */
export function mergeManagedRemoteEnv(
  current: string,
  reconciled: string,
  managedKeys: readonly string[],
): string {
  const reconciledEntries = parseEnvFile(reconciled);
  const managedValues = new Map<string, string>();
  for (const key of managedKeys) {
    const value = getValueFromEntries(reconciledEntries, key);
    if (value === undefined) {
      throw new Error(`reconciled environment is missing managed key ${key}`);
    }
    managedValues.set(key, value);
  }

  const newline = current.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = current.endsWith("\n");
  const lines = current.split(/\r?\n/);
  if (hadTrailingNewline) lines.pop();

  for (const [key, value] of managedValues) {
    let lastIndex = -1;
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index]?.startsWith(`${key}=`)) {
        lastIndex = index;
      }
    }
    const serialized = serializeEnvFile([
      { type: "pair", key, value, raw: "" },
    ]).slice(0, -1);
    if (lastIndex >= 0) {
      lines[lastIndex] = serialized;
    } else {
      lines.push(serialized);
    }
  }

  return `${lines.join(newline)}${hadTrailingNewline ? newline : ""}`;
}

function parsePort(value: string | undefined, key: string): number {
  if (value === undefined || !/^[0-9]+$/.test(value)) {
    throw new Error(`missing or invalid ${key}`);
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`missing or invalid ${key}`);
  }
  return port;
}

/**
 * Parse the intentionally secret-free key/value output emitted by
 * {@link buildRemoteAuthRuntimeInspectScript}.
 */
export function parseRemoteAuthRuntimePorts(
  output: string,
): RemoteAuthRuntimePorts {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return {
    logtoCoreContainer: parsePort(
      values.get("logto_core_container"),
      "logto_core_container",
    ),
    logtoCore: parsePort(values.get("logto_core"), "logto_core"),
    logtoAdmin: parsePort(values.get("logto_admin"), "logto_admin"),
    logtoDb: parsePort(values.get("logto_db"), "logto_db"),
  };
}

/**
 * Inspect only Compose labels, Logto's non-secret PORT/ADMIN_PORT variables,
 * and Docker host bindings. The script never prints the container's full
 * environment or any credential value.
 */
export function buildRemoteAuthRuntimeInspectScript(
  composeProjectName: string,
): string {
  const project = shellQuote(composeProjectName);
  return [
    "set -eu",
    `project=${project}`,
    "find_one() {",
    '  service="$1"',
    '  ids="$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$service")"',
    '  count="$(printf "%s\\n" "$ids" | awk \'NF { count++ } END { print count + 0 }\')"',
    '  [ "$count" = 1 ] || { printf "service %s has %s running containers\\n" "$service" "$count" >&2; exit 41; }',
    '  printf "%s\\n" "$ids"',
    "}",
    "published_port() {",
    '  container="$1"',
    '  container_port="$2"',
    '  bindings="$(docker port "$container" "$container_port/tcp" 2>/dev/null || true)"',
    '  host_port="$(printf "%s\\n" "$bindings" | awk -F: \'NF { print $NF; exit }\')"',
    '  case "$host_port" in ""|*[!0-9]*) printf "port %s/tcp is not published\\n" "$container_port" >&2; exit 42;; esac',
    '  printf "%s\\n" "$host_port"',
    "}",
    'logto="$(find_one logto)"',
    'logto_db="$(find_one logto-postgres)"',
    'logto_ports="$(docker inspect --format \'{{range .Config.Env}}{{println .}}{{end}}\' "$logto")"',
    'core_container_port="$(printf "%s\\n" "$logto_ports" | sed -n \'s/^PORT=//p\' | tail -n1)"',
    'admin_container_port="$(printf "%s\\n" "$logto_ports" | sed -n \'s/^ADMIN_PORT=//p\' | tail -n1)"',
    'case "$core_container_port" in ""|*[!0-9]*) printf "Logto PORT is missing or invalid\\n" >&2; exit 43;; esac',
    'case "$admin_container_port" in ""|*[!0-9]*) printf "Logto ADMIN_PORT is missing or invalid\\n" >&2; exit 43;; esac',
    'printf "logto_core_container=%s\\n" "$core_container_port"',
    'printf "logto_core=%s\\n" "$(published_port "$logto" "$core_container_port")"',
    'printf "logto_admin=%s\\n" "$(published_port "$logto" "$admin_container_port")"',
    'printf "logto_db=%s\\n" "$(published_port "$logto_db" 5432)"',
  ].join("\n");
}
