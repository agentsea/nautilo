import type { ComposeDriverProfile } from "./types.ts";

/**
 * Pure helper. Mirrors `DEFAULT_COMPOSE_PROJECT_NAME` (`"nautilo"`)
 * from `@nautilo/config/instance-defaults` for the empty-id default
 * instance, and `nautilo-${id}` for named instances. Profile must
 * already be schema-validated; we only inspect `instance_id`.
 */
export function composeProjectName(profile: ComposeDriverProfile): string {
  const id = (profile.instance_id ?? "").trim();
  if (id === "") return "nautilo";
  return `nautilo-${id}`;
}
