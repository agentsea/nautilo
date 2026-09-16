import { describe, expect, test } from "bun:test";
import {
  buildServiceRoleReconcileScript,
  reconcileCryptoServiceRole,
  reconcileCryptoStoragePrivileges,
  reconcileServiceRoles,
} from "../../src/lib/service-role-reconcile";

describe("D475 service-role reconciliation", () => {
  test("builds an idempotent repair for a drifted persisted Logto role", async () => {
    const calls: Array<{ container: string; database: string; script: string }> = [];

    await reconcileServiceRoles(
      {
        container: "nautilo-postgres-1",
        roles: [{ name: "logto", password: "canonical-'secret" }],
      },
      async (args) => {
        calls.push(args);
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.container).toBe("nautilo-postgres-1");
    expect(calls[0]?.database).toBe("postgres");
    expect(calls[0]?.script).toContain("ALTER ROLE %I WITH LOGIN PASSWORD %L");
    expect(calls[0]?.script).toContain("\\bind 'canonical-''secret'");
    expect(calls[0]?.script).toContain("required internal service role");
    expect(calls[0]?.script).not.toContain("CREATE ROLE");
  });

  test("repairs both application roles in one fail-closed transaction stream", async () => {
    let script = "";
    await reconcileServiceRoles(
      {
        container: "nautilo-postgres",
        roles: [
          { name: "nautilo", password: "full" },
          { name: "nautilo_agent", password: "agent" },
        ],
      },
      async (args) => {
        script = args.script;
      },
    );

    expect(script).toContain("'nautilo'");
    expect(script).toContain("'nautilo_agent'");
  });

  test("uses protocol parameters so credentials are absent from SQL statements", () => {
    const secret = "not-for-server-statement-logs";
    const script = buildServiceRoleReconcileScript([
      { name: "nautilo", password: secret },
    ]);
    const sqlStatements = script
      .split("\n")
      .filter((line) => !line.startsWith("\\bind "));
    expect(sqlStatements.join("\n")).not.toContain(secret);
    expect(sqlStatements.join("\n")).toContain("$1");
  });

  test("redacts a transport failure even if the underlying error contains the secret", async () => {
    const secret = "must-never-escape";
    let thrown = "";
    try {
      await reconcileServiceRoles(
        {
          container: "nautilo-postgres",
          roles: [{ name: "nautilo", password: secret }],
        },
        async () => {
          throw new Error(`database echoed ${secret}`);
        },
      );
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown).toContain("credential values were redacted");
    expect(thrown).not.toContain(secret);
  });

  test("creates and verifies nautilo_crypto through the shared password-safe contract", async () => {
    let captured:
      | { container: string; database: string; script: string }
      | undefined;
    await reconcileCryptoServiceRole("nautilo-postgres", async (args) => {
      captured = args;
    });
    expect(captured?.container).toBe("nautilo-postgres");
    expect(captured?.database).toBe("postgres");
    expect(captured?.script).toContain("CREATE ROLE nautilo_crypto");
    expect(captured?.script).toContain(
      "\\getenv crypto_password NAUTILO_CRYPTO_DB_PASSWORD",
    );
  });

  test("reapplies exact post-migration grants in the application database", async () => {
    let captured:
      | { container: string; database: string; script: string }
      | undefined;
    await reconcileCryptoStoragePrivileges("nautilo-postgres", async (args) => {
      captured = args;
    });
    expect(captured?.database).toBe("nautilo");
    expect(captured?.script).toContain(
      "REVOKE ALL ON TABLE public.crypto_domains FROM PUBLIC, nautilo_agent",
    );
    expect(captured?.script).not.toContain("ALL TABLES IN SCHEMA");
  });
});
