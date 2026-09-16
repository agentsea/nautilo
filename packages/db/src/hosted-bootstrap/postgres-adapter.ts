import postgres from "postgres";
import {
  withHostedDatabaseSecret,
  type HostedClusterAdminAdapter,
  type HostedCredentialValidation,
  type HostedDatabaseCreation,
  type HostedRequiredExtension,
  type HostedRoleCreation,
  type HostedRoleName,
  type HostedSqlOperation,
} from "../utils/hosted-cluster-reconcile";

type BootstrapDatabase = "postgres" | "nautilo" | "logto_nautilo";
type BootstrapSqlRow = Readonly<Record<string, unknown>>;

/** Narrow query seam keeps hostile-secret tests network-free. */
export interface HostedBootstrapSqlClient {
  unsafe(
    query: string,
    parameters?: readonly string[],
    options?: { readonly prepare?: boolean },
  ): Promise<readonly BootstrapSqlRow[]>;
  end(options?: { readonly timeout?: number }): Promise<void>;
}

export type HostedBootstrapSqlClientFactory = (
  connectionUrl: string,
) => HostedBootstrapSqlClient;

function roleAttributes(input: HostedRoleCreation["attributes"]): string {
  return [
    input.login ? "LOGIN" : "NOLOGIN",
    input.superuser ? "SUPERUSER" : "NOSUPERUSER",
    input.createDatabase ? "CREATEDB" : "NOCREATEDB",
    input.createRole ? "CREATEROLE" : "NOCREATEROLE",
    input.inherit ? "INHERIT" : "NOINHERIT",
    input.replication ? "REPLICATION" : "NOREPLICATION",
    input.bypassRls ? "BYPASSRLS" : "NOBYPASSRLS",
  ].join(" ");
}

function connectionForDatabase(connectionUrl: string, database: BootstrapDatabase): string {
  const parsed = new URL(connectionUrl);
  parsed.pathname = `/${database}`;
  parsed.hash = "";
  return parsed.toString();
}

function connectionForCredential(
  connectionUrl: string,
  database: BootstrapDatabase,
  role: HostedRoleName,
  password: string,
): string {
  const parsed = new URL(connectionForDatabase(connectionUrl, database));
  parsed.username = role;
  parsed.password = password;
  return parsed.toString();
}

function postgresErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function isCredentialFailure(error: unknown): boolean {
  const code = postgresErrorCode(error);
  return code === "28P01" || code === "28000";
}

function isVectorUnavailable(error: unknown): boolean {
  const code = postgresErrorCode(error);
  return code === "0A000" || code === "42704";
}

function createPostgresClient(connectionUrl: string): HostedBootstrapSqlClient {
  const client = postgres(connectionUrl, {
    max: 1,
    prepare: false,
    onnotice: () => undefined,
  });
  return {
    unsafe: async (query, parameters, options) => client.unsafe<BootstrapSqlRow[]>(
      query,
      parameters === undefined ? undefined : [...parameters],
      options,
    ),
    end: (options) => client.end(options),
  };
}

/**
 * Concrete postgres.js adapter used by the short-lived hosted bootstrap job.
 * It deliberately has no transaction wrapper: CREATE DATABASE is a top-level
 * PostgreSQL operation and the reconciler marks it transaction-forbidden.
 */
export class PostgresHostedClusterAdminAdapter implements HostedClusterAdminAdapter {
  private readonly clients = new Map<BootstrapDatabase, HostedBootstrapSqlClient>();

  constructor(
    private readonly adminConnectionUrl: string,
    private readonly createClient: HostedBootstrapSqlClientFactory = createPostgresClient,
  ) {}

  private client(database: BootstrapDatabase): HostedBootstrapSqlClient {
    const existing = this.clients.get(database);
    if (existing) return existing;
    const client = this.createClient(connectionForDatabase(this.adminConnectionUrl, database));
    this.clients.set(database, client);
    return client;
  }

  /**
   * Generate DDL on the server with PostgreSQL's %I/%L quoting, never by
   * interpolating an identifier or password in this process. The returned
   * statement is executed immediately and is never logged or included in a
   * reconciliation result.
   */
  private async serverFormat(
    database: BootstrapDatabase,
    template: string,
    values: readonly string[],
  ): Promise<string> {
    const argumentsSql = values.map((_, index) => `$${index + 2}::text`).join(", ");
    const query = `SELECT format($1::text, ${argumentsSql}) AS statement`;
    const rows = await this.client(database).unsafe(
      query,
      [template, ...values],
      { prepare: true },
    );
    const statement = rows[0]?.["statement"];
    if (typeof statement !== "string") throw new Error("database DDL format failed");
    return statement;
  }

  async roleExists(role: HostedRoleName): Promise<boolean> {
    const rows = await this.client("postgres").unsafe(
      "SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = $1::text) AS exists",
      [role],
      { prepare: true },
    );
    return rows[0]?.["exists"] === true;
  }

  async createRole(input: HostedRoleCreation): Promise<void> {
    await withHostedDatabaseSecret(input.password, async (password) => {
      const statement = await this.serverFormat(
        "postgres",
        `CREATE ROLE %I ${roleAttributes(input.attributes)} PASSWORD %L`,
        [input.role, password],
      );
      await this.client("postgres").unsafe(statement);
    });
  }

  async reconcileRoleAttributes(input: {
    role: HostedRoleName;
    attributes: HostedRoleCreation["attributes"];
  }): Promise<void> {
    const statement = await this.serverFormat(
      "postgres",
      `ALTER ROLE %I ${roleAttributes(input.attributes)}`,
      [input.role],
    );
    await this.client("postgres").unsafe(statement);
  }

  async databaseExists(database: Exclude<BootstrapDatabase, "postgres">): Promise<boolean> {
    const rows = await this.client("postgres").unsafe(
      "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1::text) AS exists",
      [database],
      { prepare: true },
    );
    return rows[0]?.["exists"] === true;
  }

  async createDatabase(input: HostedDatabaseCreation): Promise<void> {
    if (input.transaction !== "forbidden") throw new Error("database creation must not use a transaction");
    const statement = await this.serverFormat(
      "postgres",
      "CREATE DATABASE %I OWNER %I",
      [input.database, input.owner],
    );
    await this.client("postgres").unsafe(statement);
  }

  async executeSql(input: HostedSqlOperation): Promise<void> {
    await this.client(input.database).unsafe(input.sql);
  }

  async ensureRequiredExtension(input: HostedRequiredExtension): Promise<boolean> {
    try {
      await this.client(input.database).unsafe(input.sql);
      return true;
    } catch (error) {
      if (isVectorUnavailable(error)) return false;
      throw error;
    }
  }

  async validateCredential(input: HostedCredentialValidation): Promise<boolean> {
    let client: HostedBootstrapSqlClient | undefined;
    let credentialMismatch = false;
    try {
      await withHostedDatabaseSecret(input.password, async (password) => {
        client = this.createClient(
          connectionForCredential(
            this.adminConnectionUrl,
            input.database,
            input.role,
            password,
          ),
        );
        try {
          await client.unsafe("SELECT 1");
        } catch (error) {
          // Preserve only the semantic mismatch inside the secret callback.
          // Letting the driver error escape would correctly redact it, but
          // would also lose the distinction between mismatch and outage.
          if (isCredentialFailure(error)) {
            credentialMismatch = true;
            return;
          }
          throw error;
        }
      });
      return !credentialMismatch;
    } finally {
      await client?.end({ timeout: 5 }).catch(() => undefined);
    }
  }

  /** Close every lazy admin/database connection, even after a failed stage. */
  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.clients.values()].map((client) => client.end({ timeout: 5 })),
    );
    this.clients.clear();
  }
}

export function createPostgresHostedClusterAdminAdapter(
  adminConnectionUrl: string,
): PostgresHostedClusterAdminAdapter {
  return new PostgresHostedClusterAdminAdapter(adminConnectionUrl);
}
