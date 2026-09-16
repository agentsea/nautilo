import { shellQuote } from "./remote-exec.ts";
import { RETIRED_TOPOLOGY_SERVICES } from "./direct-transport-baseline.ts";

/** Exit code from {@link buildRetiredTopologyCleanupScript} when cleanup fails. */
export const RETIRED_TOPOLOGY_CLEANUP_EXIT = 49;

export const RETIRED_TOPOLOGY_CLEANUP_FAILURE =
  "retired topology cleanup failed: project-labelled neon-proxy/db-host containers remain after removal";

/**
 * M215 — stop and remove ONLY containers carrying both the exact Compose
 * project label and a retired service label (`neon-proxy`, `db-host`).
 * Does not use `down -v`, prune, name matching, or `--remove-orphans`.
 * Fails closed when removal or post-removal assertion fails.
 */
export function buildRetiredTopologyCleanupScript(projectName: string): string {
  const project = shellQuote(projectName.trim());
  const serviceLoop = RETIRED_TOPOLOGY_SERVICES.map(shellQuote).join(" ");
  return [
    "set -eu",
    `project=${project}`,
    `for service in ${serviceLoop}; do`,
    '  ids="$(docker ps -aq --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$service")"',
    '  if [ -z "$ids" ]; then continue; fi',
    '  for id in $ids; do',
    '    docker rm -f "$id"',
    "  done",
    "done",
    `for service in ${serviceLoop}; do`,
    '  remaining="$(docker ps -aq --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$service")"',
    '  if [ -n "$remaining" ]; then',
    `    printf "%s (service=%s)\\n" ${shellQuote(RETIRED_TOPOLOGY_CLEANUP_FAILURE)} "$service" >&2`,
    `    exit ${RETIRED_TOPOLOGY_CLEANUP_EXIT}`,
    "  fi",
    "done",
  ].join("\n");
}
