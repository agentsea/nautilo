/**
 * ISSUE-D202 — shared test-DB instance guard.
 *
 * Single source of truth for the rule "tests must never mutate the
 * operator's protected `(default)` instance". Lives in `@nautilo/db`
 * (the universal dependency for every live-DB test) and is consumed
 * across packages via the `@nautilo/db/testing` subpath export.
 *
 * Two responsibilities:
 *
 * 1. `assertFixtureDbMutationAllowed()` — throws when the resolved
 *    instance is the protected `(default)` and no explicit opt-in
 *    (`ALLOW_DEFAULT_DB_TESTS=1`) or CI environment is present.
 * 2. `bootstrapTestDbInstance()` — the routing half: defaults
 *    `NAUTILO_INSTANCE_ID` to the disposable `test-cruft` scratch
 *    instance when unset, THEN asserts. Call it before
 *    `ensureDatabase()` / `createDirectDb()` so writes are routed to a
 *    throwaway DB regardless of cwd / bunfig preload firing.
 *
 * Why both halves: `createDirectDb()` resolves its connection from
 * `resolveInstance()` (i.e. `NAUTILO_INSTANCE_ID`), NOT from a
 * hardcoded `DB_CONNECTION_STRING`. Ad-hoc `bun test <file>` from the
 * monorepo root does not pick up a package `bunfig.toml` preload, so
 * `NAUTILO_INSTANCE_ID` stays unset and writes silently land in
 * `(default)`. `bootstrapTestDbInstance()` closes that hole at the
 * call site; the assert is the belt-and-suspenders backstop.
 */
import {
  __resetResolvedInstanceForTests,
  parseNautiloInstanceId,
} from "@nautilo/config";
import { clearDbConnectionOverrides } from "../utils/db-identity-guard";

/** Disposable scratch instance every test defaults to. */
export const RECOMMENDED_SCRATCH_INSTANCE = "test-cruft";

/** Escape hatch for intentional fixture work against operator dogfood DB. */
export const ALLOW_DEFAULT_DB_TESTS_ENV = "ALLOW_DEFAULT_DB_TESTS";

/**
 * Opt-in flag (set by `bootstrapTestDbInstance`) that tells
 * `ensureDatabase()` it is running under a test harness and may
 * auto-heal a corrupted *scratch* DB (conflicting/partial migration or
 * manual schema drift) by dropping + re-migrating it. Never enables
 * destructive behavior against `(default)` or any named instance — the
 * heal is additionally gated on the resolved instance being the scratch
 * instance.
 */
export const TEST_DB_AUTOHEAL_ENV = "NAUTILO_TEST_DB_AUTOHEAL";

export const DEFAULT_DB_FIXTURE_REFUSAL_MESSAGE =
  "Refusing to create DB fixtures in (default). Set NAUTILO_INSTANCE_ID=test-cruft or ALLOW_DEFAULT_DB_TESTS=1.";

const DEFAULT_INSTANCE_ALIASES = new Set(["default", "(default)"]);

function formatEffectiveInstanceLabel(instanceId: string): string {
  return instanceId === "" ? "(default)" : instanceId;
}

function isDefaultInstanceIdForDb(instanceId: string): boolean {
  const trimmed = instanceId.trim();
  if (trimmed === "") return true;
  return DEFAULT_INSTANCE_ALIASES.has(trimmed.toLowerCase());
}

export function resolveEffectiveDbInstanceId(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = parseNautiloInstanceId(env);
  if (DEFAULT_INSTANCE_ALIASES.has(raw.toLowerCase())) return "";
  return raw;
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function truthyEnvFlag(env: NodeJS.ProcessEnv, key: string): boolean {
  const trimmed = envValue(env, key);
  if (trimmed === undefined) return false;
  return trimmed === "1" || trimmed.toLowerCase() === "true" || trimmed.toLowerCase() === "yes";
}

/** GitHub Actions and other CI runners use an ephemeral home, not operator dogfood. */
export function isCiTestEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    truthyEnvFlag(env, "CI") ||
    truthyEnvFlag(env, "GITHUB_ACTIONS") ||
    truthyEnvFlag(env, "CONTINUOUS_INTEGRATION")
  );
}

function allowDefaultDbFixtureTestsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return truthyEnvFlag(env, ALLOW_DEFAULT_DB_TESTS_ENV);
}

export type FixtureDbMutationGuardDecision =
  | { allowed: true; effectiveInstanceLabel: string; isDefaultInstance: boolean }
  | {
      allowed: false;
      effectiveInstanceLabel: string;
      isDefaultInstance: true;
      message: string;
    };

export function evaluateFixtureDbMutationGuard(
  env: NodeJS.ProcessEnv = process.env,
): FixtureDbMutationGuardDecision {
  const instanceId = resolveEffectiveDbInstanceId(env);
  const effectiveInstanceLabel = formatEffectiveInstanceLabel(instanceId);
  const isDefault = isDefaultInstanceIdForDb(instanceId);

  if (!isDefault) {
    return { allowed: true, effectiveInstanceLabel, isDefaultInstance: false };
  }

  if (allowDefaultDbFixtureTestsFromEnv(env) || isCiTestEnvironment(env)) {
    return { allowed: true, effectiveInstanceLabel, isDefaultInstance: true };
  }

  return {
    allowed: false,
    effectiveInstanceLabel,
    isDefaultInstance: true,
    message: DEFAULT_DB_FIXTURE_REFUSAL_MESSAGE,
  };
}

/**
 * Throws when fixture helpers would target protected `(default)` without
 * opt-in. Call before `ensureDatabase()` / `createDirectDb()` / inserts.
 */
export function assertFixtureDbMutationAllowed(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const decision = evaluateFixtureDbMutationGuard(env);
  if (!decision.allowed) {
    throw new Error(decision.message);
  }
}

/**
 * Route a live-DB test at the disposable scratch instance and refuse the
 * protected `(default)`.
 *
 * - When `NAUTILO_INSTANCE_ID` is unset/empty, defaults it to
 *   `test-cruft` so `createDirectDb()` / `ensureDatabase()` write to the
 *   throwaway DB even on ad-hoc `bun test <file>` runs from the repo root
 *   (where the package `bunfig.toml` preload does not fire).
 * - An explicit `NAUTILO_INSTANCE_ID` (e.g. `alpha`) is left untouched.
 * - Then asserts the resolved instance is not protected `(default)`,
 *   throwing the standard refusal message otherwise.
 *
 * Call as the FIRST statement of `beforeAll` (or at module scope, before
 * any top-level `createDirectDb()`), before touching the DB.
 *
 * @returns the effective instance label the test is routed at.
 */
export function bootstrapTestDbInstance(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!env["NAUTILO_INSTANCE_ID"]?.trim()) {
    env["NAUTILO_INSTANCE_ID"] = RECOMMENDED_SCRATCH_INSTANCE;
  }
  if (resolveEffectiveDbInstanceId(env) === RECOMMENDED_SCRATCH_INSTANCE) {
    clearDbConnectionOverrides(env);
  }
  // `resolveInstance()` is process-cached. A root-level `bun test <path>` can
  // import application modules (and resolve `(default)`) before this fixture
  // bootstrap runs because the package-local bunfig preload is not active.
  // Merely changing NAUTILO_INSTANCE_ID / clearing DB overrides then leaves
  // createDirectDb() pointed at the already-cached default connection. Reset
  // after routing is canonicalized so every pool opened below resolves the
  // current scratch/named instance instead of stale operator dogfood state.
  __resetResolvedInstanceForTests();
  assertFixtureDbMutationAllowed(env);
  // Opt this process into ensureDatabase()'s scratch auto-heal. Safe even
  // for a named instance: the heal itself re-checks that the resolved
  // instance is the disposable scratch before doing anything destructive.
  env[TEST_DB_AUTOHEAL_ENV] = "1";
  return formatEffectiveInstanceLabel(resolveEffectiveDbInstanceId(env));
}
