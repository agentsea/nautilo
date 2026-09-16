/**
 * Canonical early live-test DB routing for package-local and root Bun tests.
 * Runs before test modules can resolve `(default)` or create shared DB pools.
 */
export const ROOT_TEST_SCRATCH_INSTANCE = "test-cruft";

const CONNECTION_OVERRIDE_KEYS = [
  "DB_DIRECT_CONNECTION",
  "DB_CONNECTION_STRING",
  "DB_AGENT_DIRECT_CONNECTION",
  "DB_AGENT_CONNECTION_STRING",
  "NAUTILO_DB_PASSWORD",
  "NAUTILO_AGENT_DB_PASSWORD",
  "NAUTILO_DB_PORT",
] as const;

const DEFAULT_INSTANCE_ALIASES = new Set(["default", "(default)"]);

function targetsProtectedDefault(env: NodeJS.ProcessEnv): boolean {
  if (env["NAUTILO_DB_PORT"]?.trim() === "5434") return true;
  for (const key of ["DB_DIRECT_CONNECTION", "DB_CONNECTION_STRING"] as const) {
    const raw = env[key]?.trim();
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if (
        ["localhost", "127.0.0.1", "db.localtest.me"].includes(url.hostname)
        && url.port === "5434"
        && url.pathname === "/nautilo"
      ) return true;
    } catch {
      // Connection parsing belongs to the DB client; this guard only rejects
      // the canonical protected-default identity when it can prove a match.
    }
  }
  return false;
}

function truthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isCi(env: NodeJS.ProcessEnv): boolean {
  return truthy(env["CI"])
    || truthy(env["GITHUB_ACTIONS"])
    || truthy(env["CONTINUOUS_INTEGRATION"]);
}

export function routeRootTestProcessToScratch(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const requested = env["NAUTILO_INSTANCE_ID"]?.trim();
  if (!requested) {
    env["NAUTILO_INSTANCE_ID"] = ROOT_TEST_SCRATCH_INSTANCE;
  }

  const effective = env["NAUTILO_INSTANCE_ID"]?.trim() ?? "";
  if (effective === ROOT_TEST_SCRATCH_INSTANCE) {
    for (const key of CONNECTION_OVERRIDE_KEYS) delete env[key];
    return;
  }

  if (!DEFAULT_INSTANCE_ALIASES.has(effective.toLowerCase()) && targetsProtectedDefault(env)) {
    throw new Error(
      `Refusing root-level tests: named instance ${effective} carries a protected-default database override.`,
    );
  }

  if (
    (effective === "" || DEFAULT_INSTANCE_ALIASES.has(effective.toLowerCase()))
    && !truthy(env["ALLOW_DEFAULT_DB_TESTS"])
    && !isCi(env)
  ) {
    throw new Error(
      "Refusing root-level tests against (default). Use NAUTILO_INSTANCE_ID=test-cruft or set ALLOW_DEFAULT_DB_TESTS=1 explicitly.",
    );
  }
}

routeRootTestProcessToScratch();
