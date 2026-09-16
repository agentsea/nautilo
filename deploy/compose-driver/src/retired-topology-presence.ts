import { shellQuote } from "./remote-exec.ts";
import { RETIRED_TOPOLOGY_SERVICES } from "./direct-transport-baseline.ts";

/** Exit code from {@link buildRetiredTopologyPresenceInspectScript} when containers remain. */
export const RETIRED_TOPOLOGY_PRESENCE_EXIT = 47;

/** Exit code from {@link buildRetiredTopologyPresenceQueryScript} when none remain. */
export const RETIRED_TOPOLOGY_PRESENCE_QUERY_ABSENT = 0;

/** Exit code from {@link buildRetiredTopologyPresenceQueryScript} when containers remain. */
export const RETIRED_TOPOLOGY_PRESENCE_QUERY_PRESENT = 46;

export const RETIRED_TOPOLOGY_PRESENCE_REFUSAL =
  "nautilo upgrade refused: project-labelled neon-proxy/db-host containers remain from the pre-M215 topology. " +
  "Run `nautilo upgrade --full` once to retire them safely, then routine server-only upgrades may continue.";

const RETIRED_TOPOLOGY_SERVICE_LOOP = RETIRED_TOPOLOGY_SERVICES.map(shellQuote).join(" ");

/**
 * Shared read-only loop over stopped/running containers with exact Compose
 * project + retired service labels. `onMatch` is shell executed when any ids
 * match (typically `exit …` or `refuse …`).
 */
function buildRetiredTopologyLabelledContainerLoop(onMatch: string): string {
  return [
    `for service in ${RETIRED_TOPOLOGY_SERVICE_LOOP}; do`,
    '  ids="$(docker ps -aq --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$service")"',
    '  if [ -n "$ids" ]; then',
    `    ${onMatch}`,
    "  fi",
    "done",
  ].join("\n");
}

/**
 * M215 — read-only preflight for server-only upgrade/release paths. When any
 * stopped or running container carries both the validated Compose project label
 * and a retired service label (`neon-proxy`, `db-host`), refuse before stop/
 * backup/mutation with guidance to run `nautilo upgrade --full`.
 */
export function buildRetiredTopologyPresenceInspectScript(projectName: string): string {
  const project = shellQuote(projectName.trim());
  return [
    "set -eu",
    `project=${project}`,
    `refuse() { printf "%s\\n" "$1" >&2; exit ${RETIRED_TOPOLOGY_PRESENCE_EXIT}; }`,
    `refusal=${shellQuote(RETIRED_TOPOLOGY_PRESENCE_REFUSAL)}`,
    buildRetiredTopologyLabelledContainerLoop('refuse "$refusal"'),
    "exit 0",
  ].join("\n");
}

/**
 * M215 — read-only boolean presence query for deploy/cleanup paths. Exit
 * {@link RETIRED_TOPOLOGY_PRESENCE_QUERY_PRESENT} when any project-labelled
 * retired service container exists (stopped or running); exit
 * {@link RETIRED_TOPOLOGY_PRESENCE_QUERY_ABSENT} when none remain (exit 0).
 */
export function buildRetiredTopologyPresenceQueryScript(projectName: string): string {
  const project = shellQuote(projectName.trim());
  return [
    "set -eu",
    `project=${project}`,
    buildRetiredTopologyLabelledContainerLoop(`exit ${RETIRED_TOPOLOGY_PRESENCE_QUERY_PRESENT}`),
    `exit ${RETIRED_TOPOLOGY_PRESENCE_QUERY_ABSENT}`,
  ].join("\n");
}
