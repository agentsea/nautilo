import { shellQuote } from "./remote-exec.ts";

/** Compose service names retired by M215 (topology cleanup targets). */
export const RETIRED_TOPOLOGY_SERVICES = ["neon-proxy", "db-host"] as const;

/**
 * M215 — whether a server runtime DB URL satisfies the M212+ direct-transport
 * baseline (standard postgres/postgresql wire protocol to app-postgres, not
 * db.localtest.me / Neon proxy routing).
 */
export function isDirectTransportConnectionString(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.length === 0) return false;
  if (/db\.localtest\.me/i.test(trimmed)) return false;
  if (/(^|[/@])neon-proxy([:/]|$)/i.test(trimmed)) return false;
  if (/(^|[/@])db-host([:/]|$)/i.test(trimmed)) return false;
  if (/:4444(\/|$|:)/.test(trimmed)) return false;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return false;
  }
  if (parsed.hostname !== "app-postgres") {
    return false;
  }
  if (parsed.port === "4444") {
    return false;
  }
  return true;
}

export const DIRECT_TRANSPORT_BASELINE_REFUSAL =
  "upgrade refused: deployment has not reached the M212 direct-PostgreSQL transport baseline " +
  "(nautilo-server DB_CONNECTION_STRING and DB_AGENT_CONNECTION_STRING must use postgres:// or " +
  "postgresql:// against app-postgres, not db.localtest.me or the Neon proxy). " +
  "Upgrade the deployment to M212 first, then re-run this M215 topology retirement upgrade.";

export const STALE_TOPOLOGY_WITHOUT_SERVER_REFUSAL =
  DIRECT_TRANSPORT_BASELINE_REFUSAL +
  " (retired neon-proxy/db-host containers remain but no project-labelled nautilo-server was found — not a fresh deploy).";

export const AMBIGUOUS_SERVER_REFUSAL =
  DIRECT_TRANSPORT_BASELINE_REFUSAL +
  " (multiple project-labelled nautilo-server containers; cannot determine baseline target).";

/** Exit code from {@link buildDirectTransportBaselineInspectScript} when baseline fails. */
export const DIRECT_TRANSPORT_BASELINE_EXIT = 48;

/**
 * Shell script that inspects the project-labelled `nautilo-server` container
 * (stopped or running) and refuses (exit 48) when DB URLs are not on the M212
 * direct baseline. Exit 0 only when no server and no retired containers exist
 * (fresh deploy) or a single server has direct-transport URLs.
 */
export function buildDirectTransportBaselineInspectScript(projectName: string): string {
  const project = shellQuote(projectName.trim());
  const retiredServiceLoop = RETIRED_TOPOLOGY_SERVICES.map(shellQuote).join(" ");
  return [
    "set -eu",
    `project=${project}`,
    `refuse() { printf "%s\\n" "$1" >&2; exit ${DIRECT_TRANSPORT_BASELINE_EXIT}; }`,
    `refusal=${shellQuote(DIRECT_TRANSPORT_BASELINE_REFUSAL)}`,
    `stale_refusal=${shellQuote(STALE_TOPOLOGY_WITHOUT_SERVER_REFUSAL)}`,
    `ambiguous_refusal=${shellQuote(AMBIGUOUS_SERVER_REFUSAL)}`,
    'db_url_host() { printf "%s" "$1" | awk -F@ \'{print $NF}\' | awk -F/ \'{print $1}\' | awk -F: \'{print $1}\'; }',
    'db_url_port() { printf "%s" "$1" | awk -F@ \'{print $NF}\' | awk -F/ \'{print $1}\' | awk -F: \'{if (NF >= 2) print $2; else print ""}\'; }',
    "validate_db_url() {",
    '  url="$1"',
    '  case "$url" in postgres://*|postgresql://*) ;; *) refuse "$refusal"; return ;; esac',
    '  case "$url" in *db.localtest.me*|*neon-proxy*|*db-host*) refuse "$refusal"; return ;; esac',
    '  host="$(db_url_host "$url")"',
    '  if [ "$host" != "app-postgres" ]; then refuse "$refusal"; fi',
    '  port="$(db_url_port "$url")"',
    '  if [ "$port" = "4444" ]; then refuse "$refusal"; fi',
    '  case "$url" in *:4444/*|*:4444) refuse "$refusal" ;; esac',
    "}",
    "count_retired() {",
    "  local service count=0 ids n",
    `  for service in ${retiredServiceLoop}; do`,
    '    ids="$(docker ps -aq --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$service")"',
    '    if [ -n "$ids" ]; then',
    '      n="$(printf "%s\\n" "$ids" | sed "/^$/d" | wc -l | tr -d " ")"',
    "      count=$((count + n))",
    "    fi",
    "  done",
    '  printf "%s" "$count"',
    "}",
    'server_ids="$(docker ps -aq --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=nautilo-server")"',
    "server_count=0",
    'if [ -n "$server_ids" ]; then',
    '  server_count="$(printf "%s\\n" "$server_ids" | sed "/^$/d" | wc -l | tr -d " ")"',
    "fi",
    'if [ "$server_count" -gt 1 ]; then refuse "$ambiguous_refusal"; fi',
    'if [ "$server_count" -eq 0 ]; then',
    '  retired_count="$(count_retired)"',
    '  if [ "$retired_count" -gt 0 ]; then refuse "$stale_refusal"; fi',
    "  exit 0",
    "fi",
    'server_id="$(printf "%s\\n" "$server_ids" | sed "/^$/d" | head -n1)"',
    'env_raw="$(docker inspect --format \'{{range .Config.Env}}{{println .}}{{end}}\' "$server_id")"',
    'read_env() { printf "%s\\n" "$env_raw" | awk -F= -v key="$1" \'$1 == key { print substr($0, index($0, "=") + 1); exit }\'; }',
    'db_url="$(read_env DB_CONNECTION_STRING)"',
    'agent_url="$(read_env DB_AGENT_CONNECTION_STRING)"',
    'if [ -z "$db_url" ] || [ -z "$agent_url" ]; then',
    `  refuse ${shellQuote(DIRECT_TRANSPORT_BASELINE_REFUSAL + " (missing DB_CONNECTION_STRING or DB_AGENT_CONNECTION_STRING on project-labelled nautilo-server).")};`,
    "fi",
    'validate_db_url "$db_url"',
    'validate_db_url "$agent_url"',
    "exit 0",
  ].join("\n");
}
