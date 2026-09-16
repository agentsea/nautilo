import { describe, expect, test } from "bun:test";
import {
  createHostedDatabaseSecret,
  getHostedClusterContractSql,
  getHostedClusterRoleAttributes,
  reconcileHostedCluster,
  withHostedDatabaseSecret,
  type HostedClusterAdminAdapter,
  type HostedClusterRequest,
  type HostedCredentialValidation,
  type HostedDatabaseCreation,
  type HostedDatabaseSecret,
  type HostedRequiredExtension,
  type HostedRoleCreation,
  type HostedRoleName,
  type HostedSqlOperation,
} from "@nautilo/db";

function testSecret(): HostedDatabaseSecret {
  // Deliberately assembled so this suite never stores a literal credential.
  return createHostedDatabaseSecret(Array.from({ length: 24 }, () => "x").join(""));
}

function appRequest(): Extract<HostedClusterRequest, { cluster: "app" }> {
  return {
    cluster: "app",
    credentials: {
      nautilo: testSecret(),
      nautiloAgent: testSecret(),
      nautiloCrypto: testSecret(),
    },
  };
}

function logtoRequest(): Extract<HostedClusterRequest, { cluster: "logto" }> {
  return { cluster: "logto", credentials: { logto: testSecret() } };
}

class MemoryAdminAdapter implements HostedClusterAdminAdapter {
  readonly roles = new Set<HostedRoleName>();
  readonly databases = new Set<"nautilo" | "logto_nautilo">();
  readonly createdRoles: HostedRoleName[] = [];
  readonly createdDatabases: HostedDatabaseCreation[] = [];
  readonly reconciledRoles: HostedRoleName[] = [];
  readonly sqlOperations: Array<Pick<HostedSqlOperation, "database" | "stage">> = [];
  readonly validations: Array<Pick<HostedCredentialValidation, "database" | "role">> = [];
  readonly extensionRequests: Array<Pick<HostedRequiredExtension, "database" | "extension" | "stage">> = [];
  readonly invalidRoles = new Set<HostedRoleName>();
  vectorAvailable = true;
  failOnOperation: number | undefined;
  throwAfterCreateRole: HostedRoleName | undefined;
  throwAfterCreateDatabase = false;
  private operation = 0;

  private mayFail(): void {
    this.operation += 1;
    if (this.failOnOperation === this.operation) throw new Error("injected");
  }

  async roleExists(role: HostedRoleName): Promise<boolean> {
    this.mayFail();
    return this.roles.has(role);
  }

  async createRole(input: HostedRoleCreation): Promise<void> {
    this.mayFail();
    this.roles.add(input.role);
    this.createdRoles.push(input.role);
    if (this.throwAfterCreateRole === input.role) throw new Error("injected-after-create");
  }

  async reconcileRoleAttributes(input: { role: HostedRoleName }): Promise<void> {
    this.mayFail();
    this.reconciledRoles.push(input.role);
  }

  async databaseExists(database: "nautilo" | "logto_nautilo"): Promise<boolean> {
    this.mayFail();
    return this.databases.has(database);
  }

  async createDatabase(input: HostedDatabaseCreation): Promise<void> {
    this.mayFail();
    this.databases.add(input.database);
    this.createdDatabases.push(input);
    if (this.throwAfterCreateDatabase) throw new Error("injected-after-create");
  }

  async executeSql(input: HostedSqlOperation): Promise<void> {
    this.mayFail();
    this.sqlOperations.push({ database: input.database, stage: input.stage });
  }

  async ensureRequiredExtension(input: HostedRequiredExtension): Promise<boolean> {
    this.mayFail();
    this.extensionRequests.push({
      database: input.database,
      extension: input.extension,
      stage: input.stage,
    });
    return this.vectorAvailable;
  }

  async validateCredential(input: HostedCredentialValidation): Promise<boolean> {
    this.mayFail();
    this.validations.push({ database: input.database, role: input.role });
    return !this.invalidRoles.has(input.role);
  }
}

describe("D488 hosted-cluster reconciliation", () => {
  test("creates and validates the app-only cluster contract", async () => {
    const adapter = new MemoryAdminAdapter();
    const result = await reconcileHostedCluster(adapter, appRequest());

    expect(result.status).toBe("succeeded");
    expect(adapter.createdRoles).toEqual([
      "nautilo",
      "nautilo_agent",
      "nautilo_crypto",
    ]);
    expect(adapter.createdDatabases).toEqual([
      { database: "nautilo", owner: "nautilo", transaction: "forbidden" },
    ]);
    expect(adapter.extensionRequests).toEqual([
      { database: "nautilo", extension: "vector", stage: "require-vector" },
    ]);
    expect(adapter.sqlOperations).toEqual([
      { database: "postgres", stage: "reconcile-database-access" },
      { database: "nautilo", stage: "reconcile-app-contract" },
    ]);
    expect(adapter.validations).toEqual([
      { database: "nautilo", role: "nautilo" },
      { database: "nautilo", role: "nautilo_agent" },
      { database: "nautilo", role: "nautilo_crypto" },
    ]);
  });

  test("creates the minimal, separate Logto cluster without vector or app roles", async () => {
    const adapter = new MemoryAdminAdapter();
    const result = await reconcileHostedCluster(adapter, logtoRequest());

    expect(result.status).toBe("succeeded");
    expect(adapter.createdRoles).toEqual(["logto"]);
    expect(adapter.createdDatabases).toEqual([
      { database: "logto_nautilo", owner: "logto", transaction: "forbidden" },
    ]);
    expect(adapter.extensionRequests).toEqual([]);
    expect(adapter.sqlOperations).toEqual([
      { database: "postgres", stage: "reconcile-database-access" },
    ]);
    expect(adapter.validations).toEqual([{ database: "logto_nautilo", role: "logto" }]);
    expect(getHostedClusterRoleAttributes("logto")).toMatchObject({
      login: true,
      createRole: true,
      bypassRls: false,
    });
  });

  test("reapplies safe attributes and grants without recreating existing roles or databases", async () => {
    const adapter = new MemoryAdminAdapter();
    adapter.roles.add("nautilo");
    adapter.roles.add("nautilo_agent");
    adapter.roles.add("nautilo_crypto");
    adapter.databases.add("nautilo");

    const result = await reconcileHostedCluster(adapter, appRequest());

    expect(result.status).toBe("succeeded");
    expect(adapter.createdRoles).toEqual([]);
    expect(adapter.createdDatabases).toEqual([]);
    expect(adapter.reconciledRoles).toEqual([
      "nautilo",
      "nautilo_agent",
      "nautilo_crypto",
    ]);
    expect(adapter.sqlOperations.map((operation) => operation.stage)).toEqual([
      "reconcile-database-access",
      "reconcile-app-contract",
    ]);
  });

  test("returns a typed no-rotation credential mismatch for an existing role", async () => {
    const adapter = new MemoryAdminAdapter();
    adapter.roles.add("nautilo");
    adapter.roles.add("nautilo_agent");
    adapter.roles.add("nautilo_crypto");
    adapter.databases.add("nautilo");
    adapter.invalidRoles.add("nautilo");

    const result = await reconcileHostedCluster(adapter, appRequest());

    expect(result).toMatchObject({
      status: "failed",
      failure: {
        kind: "credential-mismatch",
        stage: "validate-primary-credential",
        retryable: false,
      },
    });
    expect(adapter.createdRoles).toEqual([]);
  });

  test("fails with a typed vector-unavailable result only on the app contract", async () => {
    const adapter = new MemoryAdminAdapter();
    adapter.vectorAvailable = false;

    const result = await reconcileHostedCluster(adapter, appRequest());

    expect(result).toMatchObject({
      status: "failed",
      failure: { kind: "vector-unavailable", stage: "require-vector", retryable: true },
    });
    expect(adapter.sqlOperations.some((operation) => operation.stage === "reconcile-app-contract")).toBe(false);
  });

  test("retries after every injected adapter failure without duplicate create attempts", async () => {
    for (let operation = 1; operation <= 17; operation += 1) {
      const adapter = new MemoryAdminAdapter();
      adapter.failOnOperation = operation;
      const first = await reconcileHostedCluster(adapter, appRequest());
      expect(first.status).toBe("failed");

      adapter.failOnOperation = undefined;
      const retry = await reconcileHostedCluster(adapter, appRequest());
      expect(retry.status).toBe("succeeded");
      expect(adapter.createdRoles.filter((role) => role === "nautilo")).toHaveLength(1);
      expect(adapter.createdRoles.filter((role) => role === "nautilo_agent")).toHaveLength(1);
      expect(adapter.createdRoles.filter((role) => role === "nautilo_crypto")).toHaveLength(1);
      expect(adapter.createdDatabases).toHaveLength(1);
    }
  });

  test("converges when a provider fails after it already created a role or database", async () => {
    const roleAdapter = new MemoryAdminAdapter();
    roleAdapter.throwAfterCreateRole = "nautilo";
    expect((await reconcileHostedCluster(roleAdapter, appRequest())).status).toBe("failed");
    roleAdapter.throwAfterCreateRole = undefined;
    expect((await reconcileHostedCluster(roleAdapter, appRequest())).status).toBe("succeeded");
    expect(roleAdapter.createdRoles.filter((role) => role === "nautilo")).toHaveLength(1);

    const databaseAdapter = new MemoryAdminAdapter();
    databaseAdapter.throwAfterCreateDatabase = true;
    expect((await reconcileHostedCluster(databaseAdapter, appRequest())).status).toBe("failed");
    databaseAdapter.throwAfterCreateDatabase = false;
    expect((await reconcileHostedCluster(databaseAdapter, appRequest())).status).toBe("succeeded");
    expect(databaseAdapter.createdDatabases).toHaveLength(1);
  });

  test("never places a credential in results, checkpoints, or operation descriptors", async () => {
    const marker = ["redaction", "marker", "only"].join("-");
    const request = {
      cluster: "logto" as const,
      credentials: { logto: createHostedDatabaseSecret(marker) },
    };
    const adapter = new MemoryAdminAdapter();
    const result = await reconcileHostedCluster(adapter, request);
    const rendered = JSON.stringify({ result, sql: adapter.sqlOperations, extension: adapter.extensionRequests });

    expect(rendered).not.toContain(marker);
    expect(rendered).not.toContain("password");
  });

  test("exposes a password only inside an adapter callback and keeps JSON/log payloads redacted", async () => {
    const secret = testSecret();
    const observed: { callbackRan: boolean; consumedLength: number } = {
      callbackRan: false,
      consumedLength: 0,
    };

    await withHostedDatabaseSecret(secret, async (value) => {
      observed.callbackRan = true;
      // A real adapter passes this straight to postgres.js here. The test
      // records only metadata, never the credential itself.
      observed.consumedLength = value.length;
    });

    expect(observed).toEqual({ callbackRan: true, consumedLength: 24 });
    const receiptOrLogPayload = JSON.stringify({ secret, observed });
    expect(receiptOrLogPayload).toBe('{"secret":{},"observed":{"callbackRan":true,"consumedLength":24}}');
  });

  test("redacts an adapter callback exception", async () => {
    const marker = ["never", "surface", "this"].join("-");
    let caught: unknown;
    try {
      await withHostedDatabaseSecret(testSecret(), () => {
        throw new Error(marker);
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("hosted database secret consumer failed");
  });

  test("reuses the canonical app grant/repair builders without copying their SQL", () => {
    const app = getHostedClusterContractSql("app");
    const logto = getHostedClusterContractSql("logto");

    expect(app.schemaContract).toContain("users_public");
    expect(app.schemaContract).toContain("ALTER DEFAULT PRIVILEGES FOR ROLE nautilo");
    expect(app.schemaContract).toContain("REVOKE ALL ON TABLE public");
    expect(app.databaseAccess).toContain("nautilo_crypto");
    expect(logto.schemaContract).toBeUndefined();
    expect(logto.databaseAccess).not.toContain("nautilo_agent");
    expect(getHostedClusterRoleAttributes("nautilo")).toMatchObject({ bypassRls: true });
    expect(getHostedClusterRoleAttributes("nautilo_crypto")).toMatchObject({
      inherit: false,
      createRole: false,
    });
  });
});
