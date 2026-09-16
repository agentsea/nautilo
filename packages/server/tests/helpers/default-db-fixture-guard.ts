/**
 * ISSUE-D202 — server-test re-export of the shared DB instance guard.
 *
 * The canonical implementation now lives in `@nautilo/db/testing` so it
 * can be shared by every package's live-DB tests (not just server). This
 * module is a thin re-export to keep existing server importers
 * (`integration/helpers/app-fixture.ts`, `resolve-bearer.test.ts`, and the
 * guard unit test) stable.
 */
export {
  ALLOW_DEFAULT_DB_TESTS_ENV,
  DEFAULT_DB_FIXTURE_REFUSAL_MESSAGE,
  RECOMMENDED_SCRATCH_INSTANCE,
  assertFixtureDbMutationAllowed,
  evaluateFixtureDbMutationGuard,
  isCiTestEnvironment,
  resolveEffectiveDbInstanceId,
} from "@nautilo/db/testing";
export type { FixtureDbMutationGuardDecision } from "@nautilo/db/testing";
