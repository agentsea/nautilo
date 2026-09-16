import { db } from "@nautilo/db";

/**
 * Deliberate ESLint violation fixture for ISSUE-D129 Phase 4.
 * `no-restricted-imports` must flag `db` from `@nautilo/db` in agent tools.
 * Do not copy this pattern into production tool code.
 */
export function deliberateFullPrivilegeImportProbe(): unknown {
  return db;
}
