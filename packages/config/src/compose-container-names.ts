/**
 * Derives Docker container names from the compose project name.
 *
 * Legacy DB stack (`packages/db/docker/docker-compose.yml`) uses explicit
 * `container_name: ${COMPOSE_PROJECT_NAME}-postgres`.
 *
 * Logto stack (`infra/compose/nautilo.yml`) omits `container_name`, so
 * Compose v2 assigns `{project}-{service}-{replica}` (replica is typically `1`).
 */
export type ComposeContainerBundle = {
  legacyPostgres: string;
  logtoPostgres: string;
  logtoCore: string;
  logtoSeed: string;
};

export function deriveComposeContainerBundle(projectName: string): ComposeContainerBundle {
  const pn = projectName.trim() !== "" ? projectName.trim() : "nautilo";
  return {
    legacyPostgres: `${pn}-postgres`,
    logtoPostgres: `${pn}-postgres-1`,
    logtoCore: `${pn}-logto-1`,
    logtoSeed: `${pn}-logto-seed-1`,
  };
}
