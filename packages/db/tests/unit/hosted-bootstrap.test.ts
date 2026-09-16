import { describe, expect, test } from "bun:test";
import {
  readHostedBootstrapConfig,
  runHostedBootstrap,
  type ClosableHostedClusterAdminAdapter,
  type HostedBootstrapAdapterFactory,
} from "../../src/hosted-bootstrap/index";
import { main } from "../../src/hosted-bootstrap/cli";
import {
  PostgresHostedClusterAdminAdapter,
  type HostedBootstrapSqlClientFactory,
} from "../../src/hosted-bootstrap/postgres-adapter";
import type {
  HostedCredentialValidation,
  HostedDatabaseCreation,
  HostedDatabaseSecret,
  HostedRequiredExtension,
  HostedRoleAttributes,
  HostedRoleCreation,
  HostedRoleName,
  HostedSqlOperation,
} from "../../src/utils/hosted-cluster-reconcile";
import {
  createHostedDatabaseSecret,
  withHostedDatabaseSecret,
} from "../../src/utils/hosted-cluster-reconcile";

const marker = ["bootstrap", "secret", "marker"].join("-");

function environment(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    APP_POSTGRES_ADMIN_URL: "postgres://admin:admin-password@app-postgres:5432/postgres",
    APP_NAUTILO_DB_PASSWORD: marker,
    APP_NAUTILO_AGENT_DB_PASSWORD: "agent-password",
    APP_NAUTILO_CRYPTO_DB_PASSWORD: "crypto-password",
    LOGTO_POSTGRES_ADMIN_URL: "postgres://admin:admin-password@logto-postgres:5432/postgres",
    LOGTO_DB_PASSWORD: "logto-password",
    ...overrides,
  };
}

class RecordingAdapter implements ClosableHostedClusterAdminAdapter {
  readonly roles = new Set<HostedRoleName>();
  readonly databases = new Set<"nautilo" | "logto_nautilo">();
  readonly validated: HostedCredentialValidation[] = [];
  closeCount = 0;
  vectorAvailable = true;
  invalidRole: HostedRoleName | undefined;

  async roleExists(role: HostedRoleName): Promise<boolean> {
    return this.roles.has(role);
  }

  async createRole(input: HostedRoleCreation): Promise<void> {
    this.roles.add(input.role);
  }

  async reconcileRoleAttributes(): Promise<void> {}

  async databaseExists(database: "nautilo" | "logto_nautilo"): Promise<boolean> {
    return this.databases.has(database);
  }

  async createDatabase(input: HostedDatabaseCreation): Promise<void> {
    expect(input.transaction).toBe("forbidden");
    this.databases.add(input.database);
  }

  async executeSql(_input: HostedSqlOperation): Promise<void> {}

  async ensureRequiredExtension(_input: HostedRequiredExtension): Promise<boolean> {
    return this.vectorAvailable;
  }

  async validateCredential(input: HostedCredentialValidation): Promise<boolean> {
    this.validated.push(input);
    return input.role !== this.invalidRole;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

function hostileSecret(): HostedDatabaseSecret {
  // Quotes, backslashes, semicolon, and a NUL-like byte must remain a bound
  // value until PostgreSQL itself produces a correctly quoted DDL statement.
  return createHostedDatabaseSecret(`'\\; ${marker} \0 DROP ROLE nautilo; --`);
}

describe("D488 hosted bootstrap executable", () => {
  test("rejects incomplete or malformed named environment input without exposing values", () => {
    expect(() => readHostedBootstrapConfig(environment({ APP_NAUTILO_DB_PASSWORD: "" }))).toThrow(
      "missing-app-nautilo-db-password",
    );
    expect(() => readHostedBootstrapConfig(environment({ LOGTO_POSTGRES_ADMIN_URL: "https://example.test" }))).toThrow(
      "invalid-logto-postgres-admin-url",
    );
  });

  test("preserves every role-password byte while trimming only administrative URLs", async () => {
    const config = readHostedBootstrapConfig(environment({
      APP_POSTGRES_ADMIN_URL: "  postgres://admin:admin-password@app-postgres:5432/postgres?sslmode=require  ",
      APP_NAUTILO_DB_PASSWORD: "  leading and trailing spaces  ",
    }));
    let observedPassword: string | undefined;
    await withHostedDatabaseSecret(config.app.credentials.nautilo, (password) => {
      observedPassword = password;
    });

    expect(config.app.adminConnectionUrl).toBe(
      "postgres://admin:admin-password@app-postgres:5432/postgres?sslmode=require",
    );
    expect(observedPassword).toBe("  leading and trailing spaces  ");
  });

  test("orchestrates app then Logto and always closes both admin adapters", async () => {
    const adapters: RecordingAdapter[] = [];
    const urls: string[] = [];
    const factory: HostedBootstrapAdapterFactory = (adminConnectionUrl) => {
      urls.push(adminConnectionUrl);
      const adapter = new RecordingAdapter();
      adapters.push(adapter);
      return adapter;
    };

    const result = await runHostedBootstrap(readHostedBootstrapConfig(environment()), factory);

    expect(result.status).toBe("succeeded");
    expect(urls).toEqual([
      "postgres://admin:admin-password@app-postgres:5432/postgres",
      "postgres://admin:admin-password@logto-postgres:5432/postgres",
    ]);
    expect(adapters.map((adapter) => adapter.closeCount)).toEqual([1, 1]);
    expect(adapters[0]?.validated.map((input) => input.role)).toEqual([
      "nautilo",
      "nautilo_agent",
      "nautilo_crypto",
    ]);
    expect(adapters[1]?.validated.map((input) => input.role)).toEqual(["logto"]);
  });

  test("returns a typed, redacted credential failure and closes the failed adapter", async () => {
    const adapter = new RecordingAdapter();
    adapter.invalidRole = "nautilo_agent";
    const result = await runHostedBootstrap(
      readHostedBootstrapConfig(environment()),
      () => adapter,
    );

    expect(result).toMatchObject({
      status: "failed",
      failure: { kind: "reconciliation-failed", cluster: "app" },
      clusters: [{ status: "failed", failure: { kind: "credential-mismatch" } }],
    });
    expect(adapter.closeCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(JSON.stringify(result)).not.toContain("admin-password");
  });

  test("CLI prints only one safe JSON failure object and a nonzero result", async () => {
    const lines: string[] = [];
    const exitCode = await main(
      environment({ APP_NAUTILO_DB_PASSWORD: undefined }),
      (line) => lines.push(line),
    );

    expect(exitCode).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"status":"failed"');
    expect(lines[0]).toContain("missing-app-nautilo-db-password");
    expect(lines[0]).not.toContain(marker);
    expect(lines[0]).not.toContain("admin-password");
  });

  test("uses server-side parameterized format for hostile role passwords", async () => {
    const calls: Array<{ query: string; parameters: readonly string[] | undefined }> = [];
    const connectionUrls: string[] = [];
    let closeCount = 0;
    const createClient: HostedBootstrapSqlClientFactory = (connectionUrl) => {
      connectionUrls.push(connectionUrl);
      return {
      unsafe: async (query, parameters) => {
        calls.push({ query, parameters });
        if (query.startsWith("SELECT format(")) {
          // The real server, not the client, produces this string with %I/%L.
          return [{ statement: "CREATE ROLE \"nautilo\" LOGIN PASSWORD 'redacted'" }];
        }
        return [];
      },
      end: async () => { closeCount += 1; },
      };
    };
    const adapter = new PostgresHostedClusterAdminAdapter(
      "postgres://admin:admin-password@app-postgres:5432/postgres?sslmode=require&application_name=nautilo-bootstrap",
      createClient,
    );
    const attributes: HostedRoleAttributes = {
      login: true,
      superuser: false,
      createDatabase: false,
      createRole: false,
      inherit: true,
      replication: false,
      bypassRls: false,
    };

    await adapter.createRole({ role: "nautilo", password: hostileSecret(), attributes });
    await adapter.validateCredential({
      database: "nautilo",
      role: "nautilo",
      password: createHostedDatabaseSecret("role-password"),
    });
    await adapter.close();

    expect(calls[0]).toEqual({
      query: "SELECT format($1::text, $2::text, $3::text) AS statement",
      parameters: [
        "CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L",
        "nautilo",
        `'\\; ${marker} \0 DROP ROLE nautilo; --`,
      ],
    });
    expect(calls.slice(1).every((call) => !call.query.includes(marker))).toBe(true);
    expect(calls.slice(1).every((call) => !call.query.includes("DROP ROLE"))).toBe(true);
    expect(new URL(connectionUrls[0] ?? "").search).toBe(
      "?sslmode=require&application_name=nautilo-bootstrap",
    );
    expect(new URL(connectionUrls[1] ?? "").search).toBe(
      "?sslmode=require&application_name=nautilo-bootstrap",
    );
    expect(new URL(connectionUrls[1] ?? "").pathname).toBe("/nautilo");
    // One validation connection plus the cached admin client close exactly once.
    expect(closeCount).toBe(2);
  });

  test("redacts adapter construction and reconciliation exceptions while closing constructed clients", async () => {
    class ThrowingAdapter extends RecordingAdapter {
      override async roleExists(): Promise<boolean> {
        throw new Error(`raw database failure ${marker}`);
      }
    }

    const constructed = new ThrowingAdapter();
    const reconciliationFailure = await runHostedBootstrap(
      readHostedBootstrapConfig(environment()),
      () => constructed,
    );
    expect(reconciliationFailure).toMatchObject({
      status: "failed",
      failure: { kind: "reconciliation-failed", cluster: "app" },
    });
    expect(constructed.closeCount).toBe(1);
    expect(JSON.stringify(reconciliationFailure)).not.toContain(marker);

    const constructionFailure = await runHostedBootstrap(
      readHostedBootstrapConfig(environment()),
      () => { throw new Error(`raw construction failure ${marker}`); },
    );
    expect(constructionFailure).toMatchObject({
      status: "failed",
      failure: { kind: "adapter-construction-failed", cluster: "app" },
    });
    expect(JSON.stringify(constructionFailure)).not.toContain(marker);
  });
});
