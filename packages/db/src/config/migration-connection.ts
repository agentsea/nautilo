/** Non-routable placeholder used only by Drizzle operations that never connect. */
export const OFFLINE_DRIZZLE_CONNECTION_URL =
  "postgresql://offline:offline@127.0.0.1:1/nautilo_offline";

export const MISSING_MIGRATION_CONNECTION_MESSAGE =
  "Refusing Drizzle database access without an explicit target. Set DB_DIRECT_CONNECTION (preferred) or DB_CONNECTION_STRING. NAUTILO_INSTANCE_ID alone is not a database connection.";

/**
 * Connection URL for drizzle-kit migrations and other admin DDL.
 *
 * Precedence (M212 D5): nonblank **`DB_DIRECT_CONNECTION`** → nonblank legacy
 * **`DB_CONNECTION_STRING`**. Connecting Drizzle commands fail closed when
 * neither is supplied; they must never silently target the protected default
 * instance. Schema-only commands opt into a non-routable placeholder with
 * `NAUTILO_DRIZZLE_OFFLINE=1`.
 */
export function resolveMigrationConnectionUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const direct = env["DB_DIRECT_CONNECTION"]?.trim();
  if (direct) return direct;

  const legacy = env["DB_CONNECTION_STRING"]?.trim();
  if (legacy) return legacy;

  if (env["NAUTILO_DRIZZLE_OFFLINE"]?.trim() === "1") {
    return OFFLINE_DRIZZLE_CONNECTION_URL;
  }

  throw new Error(MISSING_MIGRATION_CONNECTION_MESSAGE);
}
