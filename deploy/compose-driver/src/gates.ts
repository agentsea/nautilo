import type { ComposeDriverProfile } from "./types.ts";

/**
 * Runtime gates the ComposeDriver enforces over schema-validated
 * profiles. The M113 schema is intentionally permissive
 * (`apps/cli/src/lib/profile-schema.ts`); these gates are M092's
 * scope-limit veto.
 *
 * Throws with the stable messages the issue acceptance pins.
 */
export function gates(profile: ComposeDriverProfile): void {
  if (profile.lifecycle !== "compose") {
    throw new Error(
      "M092 ComposeDriver only operates on lifecycle=compose profiles. For external lifecycle use `bun run server` directly.",
    );
  }
  if (profile.transport !== "local" && profile.transport !== "remote") {
    throw new Error(
      "M092 ComposeDriver does not support this transport (expected local or remote).",
    );
  }
  // D420: profiles describe deployment location, not artifact strategy.
  // `from_source` is an invocation-scoped compatibility bridge set by
  // deploy/upgrade strategy selection; persisted location-only profiles omit
  // it. Artifact validation belongs to the command that selects an artifact,
  // never to generic lifecycle verbs such as status.
}
