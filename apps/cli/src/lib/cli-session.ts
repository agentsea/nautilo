/**
 * D112 Phase 11 — re-export canonical CLI session I/O (M108: via
 * `@nautilo/cli-auth`, which wraps `@nautilo/api-client`). Spec path:
 * `apps/cli/src/lib/cli-session.ts`.
 */
export {
  CliSessionMissingError,
  CliSessionExpiredError,
  loadCliSessionForActiveProfile,
  dropCliSessionForActiveProfile,
  requireSessionForActiveProfile,
  setActiveProfileResolver,
  type ActiveProfileResolver,
} from "@nautilo/cli-auth";
