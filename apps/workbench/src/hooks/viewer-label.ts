import type { ViewerRole } from "@nautilo/types";

/**
 * M129 — derive the viewer's display label from whoami. This is the
 * human's NAME (account menu, footer actor, typing indicator, "You"
 * fallback, room views all read `viewer.label`). It must never be the
 * Group label — that produced a "Members" identity pill beside a
 * "Members" group chip with the real name missing. Structurally takes
 * only name/handle/role, so a Group label can't leak back in.
 *
 * Lives in its own module (not in `use-auth.ts`) on purpose: dedicated
 * unit tests can import it without crossing into `use-auth.ts`, which
 * pulls `@logto/react` and gets `mock.module`-replaced by sibling test
 * files. A partial use-auth mock that omitted this export would
 * otherwise trip Bun's Linux-CI "Export named X not found" loader ghost
 * and cascade into unrelated suites. Same rationale as
 * `use-auth-stale-detection.ts`.
 */
export function deriveViewerLabel(
  data: { displayName?: string | null; handle?: string | null },
  role: ViewerRole,
): string {
  return data.displayName ?? data.handle ?? (role === "guest" ? "Guest" : role);
}
