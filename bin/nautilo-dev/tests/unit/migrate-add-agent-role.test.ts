/**
 * Unit tests for `migrate-add-agent-role` — D129 P3 part 2 (Stack 11.5)
 * + M212 app-role ownership repair.
 *
 * Uses the `ClusterExec` dependency injection to drive the command
 * without docker. No live Postgres required.
 */
import { describe, expect, test } from "bun:test";
import { LANGCHAIN_CHECKPOINT_TABLES, NAUTILO_ESSENTIAL_SELECT_TABLE } from "@nautilo/db";
import {
  migrateAddAgentRole,
  probeAgentRoleState,
  type ClusterExec,
} from "../../src/commands/migrate-add-agent-role";

interface QueryCall {
  sql: string;
  db: string;
}

function isEssentialSelectProbe(sql: string): boolean {
  return sql.includes("THEN 'skip'") && sql.includes(NAUTILO_ESSENTIAL_SELECT_TABLE);
}

function isOwnershipProbe(sql: string): boolean {
  return sql.includes("pg_get_userbyid(c.relowner)");
}

function makeExec(opts: {
  running?: boolean;
  responses?: Record<string, string>;
  /** When false, ownership/essential-select probes report repair needed. */
  appRoleOk?: boolean;
}): { exec: ClusterExec; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const responses = opts.responses ?? {};
  const appRoleOk = opts.appRoleOk !== false;
  const exec: ClusterExec = {
    query: (sql, { db }) => {
      calls.push({ sql, db: db ?? "postgres" });
      if (isOwnershipProbe(sql)) {
        return appRoleOk ? "0" : "2";
      }
      if (isEssentialSelectProbe(sql)) {
        return appRoleOk ? "ok" : "missing";
      }
      for (const [substr, response] of Object.entries(responses)) {
        if (sql.includes(substr)) return response;
      }
      return "";
    },
    containerRunning: () => opts.running !== false,
  };
  return { exec, calls };
}

describe("probeAgentRoleState", () => {
  test("reports no-container when docker container is not running", () => {
    const { exec } = makeExec({ running: false });
    const result = probeAgentRoleState(
      { container: "nautilo-postgres-1", superuser: "postgres" },
      exec,
    );
    expect(result.status).toBe("no-container");
    expect(result.containerRunning).toBe(false);
    expect(result.rolePresent).toBe(false);
  });

  test("reports needs-fix when public objects are not owned by nautilo", () => {
    const { exec } = makeExec({
      appRoleOk: false,
      responses: {
        "pg_roles WHERE rolname": "1",
        users_public: "1",
        "public.profiles": "t",
        "public.sessions": "t",
        "public.session_messages": "t",
        has_table_privilege: "f",
      },
    });
    const result = probeAgentRoleState(
      { container: "nautilo-postgres-1", superuser: "postgres" },
      exec,
    );
    expect(result.status).toBe("needs-fix");
    expect(result.appRoleOwnershipOk).toBe(false);
    expect(result.rolePresent).toBe(true);
  });

  test("reports needs-fix when nautilo lacks essential SELECT despite ownership", () => {
    const { exec } = makeExec({
      responses: {
        "pg_roles WHERE rolname": "1",
        users_public: "1",
        "public.profiles": "t",
        "public.sessions": "t",
        "public.session_messages": "t",
        has_table_privilege: "f",
      },
    });
    const execWithMissingSelect: ClusterExec = {
      query: (sql, opts) => {
        if (isOwnershipProbe(sql)) return "0";
        if (isEssentialSelectProbe(sql)) return "missing";
        return exec.query(sql, opts);
      },
      containerRunning: exec.containerRunning,
    };
    const result = probeAgentRoleState(
      { container: "nautilo-postgres-1", superuser: "postgres" },
      execWithMissingSelect,
    );
    expect(result.status).toBe("needs-fix");
    expect(result.appRoleOwnershipOk).toBe(true);
    expect(result.nautiloEssentialSelectOk).toBe(false);
  });

  test("reports missing-role when nautilo_agent does not exist", () => {
    const { exec } = makeExec({ responses: { "pg_roles WHERE rolname": "" } });
    const result = probeAgentRoleState(
      { container: "nautilo-postgres-1", superuser: "postgres" },
      exec,
    );
    expect(result.status).toBe("missing-role");
    expect(result.rolePresent).toBe(false);
  });

  test("reports missing-view when role exists but users_public view does not", () => {
    const { exec } = makeExec({
      responses: {
        "pg_roles WHERE rolname": "1",
        users_public: "",
        "public.profiles": "t",
        "public.sessions": "t",
        "public.session_messages": "t",
        has_table_privilege: "f",
      },
    });
    const result = probeAgentRoleState(
      { container: "nautilo-postgres-1", superuser: "postgres" },
      exec,
    );
    expect(result.status).toBe("missing-view");
    expect(result.rolePresent).toBe(true);
    expect(result.usersPublicViewPresent).toBe(false);
  });

  test("reports missing-grants when role + view exist but credentials grants linger", () => {
    const { exec } = makeExec({
      responses: {
        "pg_roles WHERE rolname": "1",
        users_public: "1",
        "public.profiles": "t",
        "public.sessions": "t",
        "public.session_messages": "t",
        has_table_privilege: "t",
      },
    });
    const result = probeAgentRoleState(
      { container: "nautilo-postgres-1", superuser: "postgres" },
      exec,
    );
    expect(result.status).toBe("missing-grants");
    expect(result.sensitiveTablesRevoked.every((r) => !r)).toBe(true);
  });

  test("reports missing-grants when positive grants are missing despite view + revokes", () => {
    const { exec } = makeExec({
      responses: {
        "pg_roles WHERE rolname": "1",
        users_public: "1",
        "public.profiles": "f",
        "public.sessions": "f",
        "public.session_messages": "f",
        has_table_privilege: "f",
      },
    });
    const result = probeAgentRoleState(
      { container: "nautilo-postgres-1", superuser: "postgres" },
      exec,
    );
    expect(result.status).toBe("missing-grants");
    expect(result.requiredTablesGranted.every((r) => !r)).toBe(true);
    expect(result.sensitiveTablesRevoked.every((r) => r)).toBe(true);
  });

  test("reports ok when app role, agent role, view, and revokes are all in place", () => {
    const { exec } = makeExec({
      responses: {
        "pg_roles WHERE rolname": "1",
        users_public: "1",
        "public.profiles": "t",
        "public.sessions": "t",
        "public.session_messages": "t",
        has_table_privilege: "f",
      },
    });
    const result = probeAgentRoleState(
      { container: "nautilo-postgres-1", superuser: "postgres" },
      exec,
    );
    expect(result.status).toBe("ok");
    expect(result.appRoleOwnershipOk).toBe(true);
    expect(result.nautiloEssentialSelectOk).toBe(true);
    expect(result.sensitiveTablesRevoked.every((r) => r)).toBe(true);
  });
});

describe("migrateAddAgentRole (command entrypoint)", () => {
  test("dry-run on an already-ok cluster exits 0 without mutation", async () => {
    const { exec, calls } = makeExec({
      responses: {
        "pg_roles WHERE rolname": "1",
        users_public: "1",
        "public.profiles": "t",
        "public.sessions": "t",
        "public.session_messages": "t",
        has_table_privilege: "f",
      },
    });
    const code = await migrateAddAgentRole(
      { container: "nautilo-postgres-1" },
      exec,
    );
    expect(code).toBe(0);
    expect(calls.every((c) => !c.sql.includes("CREATE ROLE"))).toBe(true);
    expect(calls.every((c) => !c.sql.includes("CREATE OR REPLACE VIEW"))).toBe(true);
    expect(calls.every((c) => !c.sql.includes("ALTER TABLE public.%I OWNER TO nautilo"))).toBe(
      true,
    );
  });

  test("dry-run on a missing-role cluster exits 0 but DOES NOT apply", async () => {
    const { exec, calls } = makeExec({
      responses: { "pg_roles WHERE rolname": "" },
    });
    const code = await migrateAddAgentRole(
      { container: "nautilo-postgres-1" },
      exec,
    );
    expect(code).toBe(0);
    expect(calls.every((c) => !c.sql.includes("CREATE ROLE"))).toBe(true);
  });

  test("dry-run on needs-fix ownership exits 0 without applying repair SQL", async () => {
    const { exec, calls } = makeExec({
      appRoleOk: false,
      responses: {
        "pg_roles WHERE rolname": "1",
        users_public: "1",
        "public.profiles": "t",
        "public.sessions": "t",
        "public.session_messages": "t",
        has_table_privilege: "f",
      },
    });
    const code = await migrateAddAgentRole({ container: "nautilo-postgres-1" }, exec);
    expect(code).toBe(0);
    expect(calls.every((c) => !c.sql.includes("ALTER TABLE public.%I OWNER TO nautilo"))).toBe(
      true,
    );
  });

  test("--apply on a missing-role cluster runs the full repair SQL and re-probes ok", async () => {
    let probeCount = 0;
    const calls: QueryCall[] = [];
    const exec: ClusterExec = {
      query: (sql, { db }) => {
        calls.push({ sql, db: db ?? "postgres" });
        if (isOwnershipProbe(sql)) return "0";
        if (isEssentialSelectProbe(sql)) return "ok";
        if (sql.includes("pg_roles WHERE rolname")) {
          probeCount += 1;
          return probeCount === 1 ? "" : "1";
        }
        if (sql.includes("users_public")) return "1";
        if (sql.includes("public.profiles")) return "t";
        if (sql.includes("public.sessions")) return "t";
        if (sql.includes("public.session_messages")) return "t";
        if (sql.includes("has_table_privilege")) return "f";
        return "";
      },
      containerRunning: () => true,
    };

    const code = await migrateAddAgentRole(
      { container: "nautilo-postgres-1", apply: true, iKnowWhatIAmDoing: true },
      exec,
    );
    expect(code).toBe(0);
    expect(
      calls.some((c) => c.sql.includes("CREATE ROLE") && c.db === "postgres"),
    ).toBe(true);
    expect(
      calls.some(
        (c) =>
          c.sql.includes("ALTER TABLE public.%I OWNER TO nautilo") && c.db === "nautilo",
      ),
    ).toBe(true);
    expect(
      calls.some(
        (c) =>
          c.sql.includes("CREATE OR REPLACE VIEW public.users_public") &&
          c.db === "nautilo",
      ),
    ).toBe(true);
    expect(
      calls.some(
        (c) =>
          c.sql.includes("REVOKE ALL ON TABLE public.%I FROM nautilo_agent") &&
          c.db === "nautilo",
      ),
    ).toBe(true);
  });

  test("--apply on needs-fix ownership runs app-role repair before agent contract", async () => {
    let probeCount = 0;
    const calls: QueryCall[] = [];
    const exec: ClusterExec = {
      query: (sql, { db }) => {
        calls.push({ sql, db: db ?? "postgres" });
        if (isOwnershipProbe(sql)) {
          probeCount += 1;
          return probeCount <= 1 ? "4" : "0";
        }
        if (isEssentialSelectProbe(sql)) {
          return probeCount <= 1 ? "missing" : "ok";
        }
        if (sql.includes("pg_roles WHERE rolname")) return "1";
        if (sql.includes("users_public")) return "1";
        if (sql.includes("public.profiles")) return "t";
        if (sql.includes("public.sessions")) return "t";
        if (sql.includes("public.session_messages")) return "t";
        if (sql.includes("has_table_privilege")) return "f";
        return "";
      },
      containerRunning: () => true,
    };

    const code = await migrateAddAgentRole(
      { container: "nautilo-postgres-1", apply: true, iKnowWhatIAmDoing: true },
      exec,
    );
    expect(code).toBe(0);
    const nautiloApply = calls.find(
      (c) => c.db === "nautilo" && c.sql.includes("ALTER TABLE public.%I OWNER TO nautilo"),
    );
    expect(nautiloApply).toBeDefined();
    expect(nautiloApply!.sql.indexOf("ALTER TABLE public.%I OWNER TO nautilo")).toBeLessThan(
      nautiloApply!.sql.indexOf("GRANT USAGE ON SCHEMA public TO nautilo_agent"),
    );
  });

  test("--apply on no-container exits 1 and applies nothing", async () => {
    const { exec, calls } = makeExec({ running: false });
    const code = await migrateAddAgentRole(
      { container: "nautilo-postgres-1", apply: true, iKnowWhatIAmDoing: true },
      exec,
    );
    expect(code).toBe(1);
    expect(calls.length).toBe(0);
  });

  test("rejects passwords containing characters unsafe for JS-built SQL string assembly", async () => {
    const execMissing: ClusterExec = {
      query: (sql) => {
        if (isOwnershipProbe(sql)) return "0";
        if (isEssentialSelectProbe(sql)) return "ok";
        if (sql.includes("pg_roles WHERE rolname")) return "";
        return "";
      },
      containerRunning: () => true,
    };
    const unsafePasswords = ["bad'password", "bad\\password", "bad$password"];
    for (const pw of unsafePasswords) {
      let caught: unknown = null;
      try {
        await migrateAddAgentRole(
          {
            container: "nautilo-postgres-1",
            apply: true,
            agentPassword: pw,
            iKnowWhatIAmDoing: true,
          },
          execMissing,
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeTruthy();
      expect(String((caught as Error).message)).toMatch(/unsafe for SQL string assembly/);
    }
    let safeExitedCleanly = false;
    try {
      const code = await migrateAddAgentRole(
        {
          container: "nautilo-postgres-1",
          apply: true,
          agentPassword: "safeP@ss-w0rd_123!",
          iKnowWhatIAmDoing: true,
        },
        execMissing,
      );
      safeExitedCleanly = typeof code === "number";
    } catch {
      safeExitedCleanly = false;
    }
    expect(safeExitedCleanly).toBe(true);
  });

  test("agent password comes from NAUTILO_AGENT_DB_PASSWORD when not passed as option", async () => {
    let capturedSql = "";
    const exec: ClusterExec = {
      query: (sql, { db }) => {
        if (sql.includes("CREATE ROLE") || sql.includes("DO $$\nBEGIN\n  IF NOT EXISTS")) {
          if (db === "postgres") capturedSql = sql;
        }
        if (isOwnershipProbe(sql)) return "0";
        if (isEssentialSelectProbe(sql)) return "ok";
        if (sql.includes("pg_roles WHERE rolname")) return "";
        if (sql.includes("users_public")) return "1";
        if (sql.includes("public.profiles")) return "t";
        if (sql.includes("public.sessions")) return "t";
        if (sql.includes("public.session_messages")) return "t";
        if (sql.includes("has_table_privilege")) return "f";
        return "";
      },
      containerRunning: () => true,
    };
    process.env["NAUTILO_AGENT_DB_PASSWORD"] = "super-secret-pw-from-env";
    try {
      await migrateAddAgentRole(
        { container: "nautilo-postgres-1", apply: true, iKnowWhatIAmDoing: true },
        exec,
      );
      expect(capturedSql).toContain("super-secret-pw-from-env");
    } finally {
      delete process.env["NAUTILO_AGENT_DB_PASSWORD"];
    }
  });
});

/**
 * Stack 193 — password synchronization. `--apply` must rotate the existing
 * nautilo_agent password to the configured value even when the
 * grants/view/ownership probe is already healthy; dry-run stays non-mutating;
 * the password must never reach console output.
 */
describe("migrate-add-agent-role (Stack 193 password synchronization)", () => {
  function makeHealthyExec(): { exec: ClusterExec; calls: QueryCall[] } {
    const calls: QueryCall[] = [];
    const exec: ClusterExec = {
      query: (sql, { db }) => {
        calls.push({ sql, db: db ?? "postgres" });
        if (isOwnershipProbe(sql)) return "0";
        if (isEssentialSelectProbe(sql)) return "ok";
        if (sql.includes("pg_roles WHERE rolname")) return "1";
        if (sql.includes("users_public")) return "1";
        if (sql.includes("public.profiles")) return "t";
        if (sql.includes("public.sessions")) return "t";
        if (sql.includes("public.session_messages")) return "t";
        if (sql.includes("has_table_privilege")) return "f";
        return "";
      },
      containerRunning: () => true,
    };
    return { exec, calls };
  }

  async function withConsoleCaptured<T>(
    fn: () => Promise<T>,
  ): Promise<{ logs: string[]; errs: string[]; result: T }> {
    const logs: string[] = [];
    const errs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    };
    console.error = (...args: unknown[]) => {
      errs.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    };
    try {
      const result = await fn();
      return { logs, errs, result };
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  }

  test("--apply on a healthy cluster still synchronizes the existing role password", async () => {
    const { exec, calls } = makeHealthyExec();
    const code = await migrateAddAgentRole(
      {
        container: "nautilo-postgres-1",
        apply: true,
        agentPassword: "configured-agent-pw",
        iKnowWhatIAmDoing: true,
      },
      exec,
    );
    expect(code).toBe(0);
    const onPostgresApply = calls.find(
      (c) =>
        c.db === "postgres" &&
        c.sql.includes("ALTER ROLE") &&
        c.sql.includes("PASSWORD %L"),
    );
    expect(onPostgresApply).toBeDefined();
    expect(onPostgresApply!.sql).toContain("configured-agent-pw");
  });

  test("dry-run on a healthy cluster remains a no-op (no password sync, no CREATE ROLE)", async () => {
    const { exec, calls } = makeHealthyExec();
    const code = await migrateAddAgentRole(
      { container: "nautilo-postgres-1", apply: false, agentPassword: "configured-agent-pw" },
      exec,
    );
    expect(code).toBe(0);
    expect(calls.every((c) => !c.sql.includes("ALTER ROLE"))).toBe(true);
    expect(calls.every((c) => !c.sql.includes("CREATE ROLE"))).toBe(true);
  });

  test("missing-role path uses configured password in CREATE ROLE", async () => {
    const calls: QueryCall[] = [];
    let probeCount = 0;
    const exec: ClusterExec = {
      query: (sql, { db }) => {
        calls.push({ sql, db: db ?? "postgres" });
        if (isOwnershipProbe(sql)) return "0";
        if (isEssentialSelectProbe(sql)) return "ok";
        if (sql.includes("pg_roles WHERE rolname")) {
          probeCount += 1;
          return probeCount === 1 ? "" : "1";
        }
        if (sql.includes("users_public")) return "1";
        if (sql.includes("public.profiles")) return "t";
        if (sql.includes("public.sessions")) return "t";
        if (sql.includes("public.session_messages")) return "t";
        if (sql.includes("has_table_privilege")) return "f";
        return "";
      },
      containerRunning: () => true,
    };
    const code = await migrateAddAgentRole(
      {
        container: "nautilo-postgres-1",
        apply: true,
        agentPassword: "configured-agent-pw",
        iKnowWhatIAmDoing: true,
      },
      exec,
    );
    expect(code).toBe(0);
    const onPostgresApply = calls.find(
      (c) => c.db === "postgres" && c.sql.includes("CREATE ROLE"),
    );
    expect(onPostgresApply).toBeDefined();
    expect(onPostgresApply!.sql).toContain("configured-agent-pw");
  });

  test("agent password is never written to console logs or errors", async () => {
    const { exec } = makeHealthyExec();
    const secret = "super-secret-agent-pw-193";
    const { logs, errs, result } = await withConsoleCaptured(() =>
      migrateAddAgentRole(
        {
          container: "nautilo-postgres-1",
          apply: true,
          agentPassword: secret,
          iKnowWhatIAmDoing: true,
        },
        exec,
      ),
    );
    expect(result).toBe(0);
    for (const line of logs) expect(line).not.toContain(secret);
    for (const line of errs) expect(line).not.toContain(secret);
  });
});

/**
 * Stack 198 — langchain (LangGraph PostgresSaver) checkpoint grant probe.
 * Runtime integration fails `permission denied for schema langchain` when
 * nautilo_agent lacks USAGE + DML on the checkpoint tables. The probe must
 * report langchain grant health so `--apply` can repair it.
 */
describe("migrate-add-agent-role (Stack 198 langchain checkpoint probe)", () => {
  function baseHealthyResponses(): Record<string, string> {
    return {
      "pg_roles WHERE rolname": "1",
      users_public: "1",
      "public.profiles": "t",
      "public.sessions": "t",
      "public.session_messages": "t",
      has_table_privilege: "f",
    };
  }

  test("langchain schema absent → trivially OK, status stays ok", () => {
    const { exec } = makeExec({ responses: baseHealthyResponses() });
    const result = probeAgentRoleState(
      { container: "nautilo-postgres-1", superuser: "postgres" },
      exec,
    );
    expect(result.langchainSchemaPresent).toBe(false);
    expect(result.langchainCheckpointTablesGranted.every((r) => r)).toBe(true);
    expect(result.status).toBe("ok");
  });

  test("langchain schema present + all checkpoint tables granted → status ok", () => {
    const responses = baseHealthyResponses();
    // Schema present. Insert langchain-specific responses BEFORE the
    // shared `has_table_privilege` key so they match first (the mock
    // returns the first matching substring).
    delete responses["has_table_privilege"];
    responses["pg_namespace WHERE nspname = 'langchain'"] = "1";
    for (const tbl of LANGCHAIN_CHECKPOINT_TABLES) {
      responses[`langchain.${tbl}`] = "t";
    }
    // Public sensitive-table revoke probe still needs `has_table_privilege` → "f".
    responses["has_table_privilege"] = "f";
    const { exec } = makeExec({ responses });
    const result = probeAgentRoleState(
      { container: "nautilo-postgres-1", superuser: "postgres" },
      exec,
    );
    expect(result.langchainSchemaPresent).toBe(true);
    expect(result.langchainCheckpointTablesGranted.every((r) => r)).toBe(true);
    expect(result.status).toBe("ok");
  });

  test("langchain schema present + a checkpoint table missing DML → status missing-grants", () => {
    const responses: Record<string, string> = {
      "pg_roles WHERE rolname": "1",
      users_public: "1",
      "public.profiles": "t",
      "public.sessions": "t",
      "public.session_messages": "t",
      "pg_namespace WHERE nspname = 'langchain'": "1",
      // checkpoints granted, but checkpoint_blobs is NOT (returns "f").
      "langchain.checkpoints": "t",
      "langchain.checkpoint_blobs": "f",
      "langchain.checkpoint_writes": "t",
      // Public sensitive-table revoke probe → revoked.
      "public.credentials": "f",
    };
    const { exec } = makeExec({ responses });
    const result = probeAgentRoleState(
      { container: "nautilo-postgres-1", superuser: "postgres" },
      exec,
    );
    expect(result.langchainSchemaPresent).toBe(true);
    const granted = result.langchainCheckpointTablesGranted;
    expect(granted[LANGCHAIN_CHECKPOINT_TABLES.indexOf("checkpoints")]).toBe(true);
    expect(granted[LANGCHAIN_CHECKPOINT_TABLES.indexOf("checkpoint_blobs")]).toBe(false);
    expect(granted[LANGCHAIN_CHECKPOINT_TABLES.indexOf("checkpoint_writes")]).toBe(true);
    expect(result.status).toBe("missing-grants");
  });

  test("langchain schema present + checkpoint table absent → trivially granted, status ok", () => {
    const responses: Record<string, string> = {
      "pg_roles WHERE rolname": "1",
      users_public: "1",
      "public.profiles": "t",
      "public.sessions": "t",
      "public.session_messages": "t",
      "pg_namespace WHERE nspname = 'langchain'": "1",
      // All langchain has_table_privilege probes return "" (table absent)
      // because no response substring matches `langchain.<tbl>` — but
      // `has_table_privilege` would match the public revoke probe. Use a
      // guard so the public sensitive probe still returns "f".
      "public.credentials": "f",
    };
    // The shared `has_table_privilege` substring is NOT set, so langchain
    // per-table probes (which contain `has_table_privilege`) fall through
    // to the default "" → table-absent → trivially granted. The public
    // sensitive-table probe also contains `has_table_privilege` and would
    // also return "" → interpreted as "revoked" (trivially). To keep the
    // sensitive revoke probe meaningful, set a public-specific match.
    responses["public.credentials"] = "f";
    const { exec } = makeExec({ responses });
    const result = probeAgentRoleState(
      { container: "nautilo-postgres-1", superuser: "postgres" },
      exec,
    );
    expect(result.langchainSchemaPresent).toBe(true);
    expect(result.langchainCheckpointTablesGranted.every((r) => r)).toBe(true);
    expect(result.status).toBe("ok");
  });

  test("--apply on healthy cluster emits langchain grant SQL in the nautilo apply block", async () => {
    const { exec, calls } = makeExec({ responses: baseHealthyResponses() });
    const code = await migrateAddAgentRole(
      { container: "nautilo-postgres-1", apply: true, iKnowWhatIAmDoing: true },
      exec,
    );
    expect(code).toBe(0);
    const nautiloApply = calls.find((c) => c.db === "nautilo" && c.sql.includes("GRANT USAGE ON SCHEMA langchain TO nautilo_agent"));
    expect(nautiloApply).toBeDefined();
    expect(nautiloApply!.sql).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE langchain.%I TO nautilo_agent");
    for (const tbl of LANGCHAIN_CHECKPOINT_TABLES) {
      expect(nautiloApply!.sql).toContain(`'${tbl}'`);
    }
  });
});
