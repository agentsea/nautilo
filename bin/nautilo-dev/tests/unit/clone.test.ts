import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedInstance } from "@nautilo/config";
import { buildEventFeedReaderRoleSql } from "../../../../packages/db/src/utils/event-feed-role";
import type {
  CanonicalDefaultCloneAdmission,
  CloneMaterializationRequest,
} from "../../src/commands/clone";
import {
  LOGTO_RESTORE_ROLE_TOPOLOGY_SQL,
  CANONICAL_DATABASE_IDENTITY_RELATION_SQL,
  CANONICAL_DATABASE_IDENTITY_VALUE_SQL,
  CANONICAL_DEFAULT_SOURCE_EVIDENCE_FAILURE_CODES,
  CLONE_ACCEPTANCE_FAILURE_CODES,
  CLONE_DATABASES_STARTED_FAILURE_CODES,
  CLONE_COMPOSE_FAILURE_CATEGORIES,
  canonicalDatabaseIdentityEvidence,
  assertCloneComposeEnvAuthority,
  assertCloneLogtoApplicationProjection,
  classifyCloneComposeFailure,
  captureCanonicalDatabaseIdentityEvidence,
  canonicalDefaultSourceEvidenceFailureCode,
  cloneDatabasesStartedFailureCode,
  cloneDatabasesStartedComposeCategory,
  cloneAcceptanceFailureCode,
  cloneAcceptanceVerifyFailureId,
  clonePortInventoryWarningSink,
  CloneDatabasesStartedError,
  CloneAcceptanceError,
  CloneVerifyCommandError,
  CanonicalDefaultSourceEvidenceError,
  captureCanonicalDefaultSourceEvidence,
  assertCanonicalDefaultSourceEvidenceEqual,
  assertCloneResourceIsolation,
  assertSourceEvidenceEqual,
  buildCloneSourceCaptureCommand,
  buildCloneStagePlan,
  buildCloneDatabaseRecreateSql,
  buildCloneFileUriRebindSql,
  buildCloneServerIdentityRebindSql,
  buildCloneWorkbenchIdentityRebindSql,
  rebindCloneFileUriValue,
  formatCloneFailure,
  formatCloneReady,
  cloneDevInstance,
  materializeClone,
  migrationSchemaAnchorsSatisfied,
  isCloneWorkbenchIndexHtml,
  resolveCloneWorkbenchIndex,
  restoreCloneNautiloDatabase,
  runCloneDatabasesStartedSteps,
  runCloneAcceptanceSteps,
  waitForPostgresSqlReadiness,
  validateCanonicalDefaultCloneAdmission,
  validateCloneArgs,
} from "../../src/commands/clone";
import { rebindCloneEnvContent } from "../../src/lib/clone-config-rebind";
import { assertCloneTargetAbsent } from "../../src/lib/clone-preflight";
import {
  CLONE_STAGES,
  deriveCloneOperationNextStage,
  runCloneStages,
  type CloneOperationRecord,
  type CloneStage,
} from "../../src/lib/clone-operation";

const roots: string[] = [];

const target: ResolvedInstance = {
  schemaVersion: 1,
  instanceId: "tau",
  server: { host: "127.0.0.1", port: 3011, url: "http://localhost:3011" },
  workbench: { port: 3010, url: "http://localhost:3010" },
  db: {
    directConnection: "postgresql://postgres:postgres@localhost:5444/nautilo",
    postgresHostPort: 5444,
  },
  logto: { dbPort: 5442, corePort: 3311, adminPort: 3312 },
  compose: {
    projectName: "nautilo-tau",
    containers: {
      legacyPostgres: "nautilo-tau-postgres",
      logtoPostgres: "nautilo-tau-postgres-1",
      logtoCore: "nautilo-tau-logto-1",
      logtoSeed: "nautilo-tau-logto-seed-1",
    },
  },
  hostname: {
    federated: "tau.local",
    mdns: "tau.local",
    tlsSan: "",
    caddyAuthHost: "auth.tau.local",
    caddyAuthAdminHost: "auth-admin.tau.local",
  },
  deploymentMode: "dev-multi-instance",
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("development clone guards", () => {
  test("does not skip the real M327 constraint-replacement migration by existing names", async () => {
    const migration = await readFile(join(
      import.meta.dir,
      "../../../../packages/db/src/migrations/0285_ambitious_squadron_sinister.sql",
    ), "utf8");
    let queryCalls = 0;

    expect(migrationSchemaAnchorsSatisfied("nautilo-test-postgres", migration, () => {
      queryCalls += 1;
      return "true";
    })).toBe(false);
    expect(queryCalls).toBe(0);
  });

  test("does not use a retained constraint name as proof of a replacement definition", () => {
    const replacement = `
      ALTER TABLE "example" DROP CONSTRAINT "example_value_check";
      ALTER TABLE "example" ADD CONSTRAINT "example_value_check"
        CHECK ("example"."value" in ('old', 'new'));
    `;
    let queryCalls = 0;

    expect(migrationSchemaAnchorsSatisfied("nautilo-test-postgres", replacement, () => {
      queryCalls += 1;
      return "true";
    })).toBe(false);
    expect(queryCalls).toBe(0);
  });

  test("still accepts additive migrations whose schema anchors already exist", () => {
    const queries: string[] = [];
    const additive = `
      CREATE TABLE "example" ("id" text PRIMARY KEY);
      ALTER TABLE "example" ADD COLUMN "value" text;
      ALTER TABLE "example" ADD CONSTRAINT "example_value_check"
        CHECK ("example"."value" = 'ready');
      CREATE INDEX "example_value_idx" ON "example" ("value");
    `;

    expect(migrationSchemaAnchorsSatisfied("nautilo-test-postgres", additive, (input) => {
      queries.push(input.sql);
      return "true";
    })).toBe(true);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("example_value_check");
  });

  test("admits only the exact persisted Mobile Web application projection", () => {
    const historical = [
      { id: "workbench", name: "Nautilo Workbench", type: "SPA" },
      { id: "desktop", name: "Nautilo Desktop", type: "Native" },
    ] as const;
    const mobileWeb = {
      id: "mobile-web",
      name: "Nautilo Mobile Web",
      type: "SPA",
    } as const;

    expect(() => assertCloneLogtoApplicationProjection({
      historical: [...historical, mobileWeb],
      current: [...historical, mobileWeb],
      mobileWebAppId: mobileWeb.id,
    })).not.toThrow();
    expect(() => assertCloneLogtoApplicationProjection({
      historical,
      current: [...historical, mobileWeb],
      mobileWebAppId: mobileWeb.id,
    })).not.toThrow();

    for (const current of [
      [historical[0]],
      [{ ...historical[0], name: "Changed" }, historical[1]],
      [...historical, { ...mobileWeb, id: "wrong" }],
      [...historical, mobileWeb, { id: "extra", name: "Extra", type: "SPA" }],
      [...historical, { ...mobileWeb, name: "Not Nautilo Mobile Web" }],
      [...historical, { ...mobileWeb, type: "Native" }],
    ]) {
      expect(() => assertCloneLogtoApplicationProjection({
        historical,
        current,
        mobileWebAppId: mobileWeb.id,
      })).toThrow("Clone Logto");
    }
    expect(() => assertCloneLogtoApplicationProjection({
      historical,
      current: [...historical, mobileWeb],
    })).toThrow("Mobile Web application projection is unavailable");
  });

  test("uses the effective clone workbench dist and requires a real HTML index", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-clone-workbench-"));
    roots.push(root);
    const indexPath = join(root, "index.html");
    await Bun.write(indexPath, "clone-default test dist");
    expect(resolveCloneWorkbenchIndex({ NAUTILO_WORKBENCH_DIST: root })).toEqual({
      indexPath,
      explicit: true,
    });
    expect(isCloneWorkbenchIndexHtml(indexPath)).toBe(false);
    await Bun.write(indexPath, "<!doctype html><html><body>isolated</body></html>");
    expect(isCloneWorkbenchIndexHtml(indexPath)).toBe(true);
    expect(resolveCloneWorkbenchIndex({})).toMatchObject({ explicit: false });
  });

  test("rebinds only delimiter-safe physical file URI prefixes", () => {
    expect(rebindCloneFileUriValue(
      "file:///private/source/.nautilo",
      "/private/source/.nautilo",
      "/private/target/.nautilo-tau",
    )).toBe("file:///private/target/.nautilo-tau");
    expect(rebindCloneFileUriValue(
      "file:///private/source/.nautilo/artifacts/a",
      "/private/source/.nautilo",
      "/private/target/.nautilo-tau",
    )).toBe("file:///private/target/.nautilo-tau/artifacts/a");
    expect(rebindCloneFileUriValue(
      "file:///private/source/.nautilo-other/artifacts/a",
      "/private/source/.nautilo",
      "/private/target/.nautilo-tau",
    )).toBe("file:///private/source/.nautilo-other/artifacts/a");
    expect(rebindCloneFileUriValue(
      "s3://bucket/artifact",
      "/private/source/.nautilo",
      "/private/target/.nautilo-tau",
    )).toBe("s3://bucket/artifact");
    const sql = buildCloneFileUriRebindSql(
      "/private/source's-root/.nautilo",
      "/private/target/.nautilo-tau",
    );
    for (const [table, column] of [
      ["artifacts", "storage_uri"],
      ["message_attachments", "storage_uri"],
      ["workspace_document_mutation_entries", "before_storage_uri"],
      ["workspace_document_mutation_entries", "after_storage_uri"],
      ["workspace_document_mutation_entries", "destination_before_storage_uri"],
    ]) {
      expect(sql.updateSql).toContain(`UPDATE public."${table}"`);
      expect(sql.updateSql).toContain(`SET "${column}" =`);
      expect(sql.verifySql).toContain(`FROM public."${table}"`);
    }
    expect(sql.updateSql).toContain("file:///private/source''s-root/.nautilo");
    expect(sql.updateSql).toContain("file:///private/target/.nautilo-tau");
    expect(sql.updateSql).toContain('"storage_uri" = \'file:///private/source\'\'s-root/.nautilo\' OR');
    expect(sql.updateSql).toContain("substr(\"storage_uri\", char_length(");
    expect(sql.updateSql).toContain("+ 1, 1) = '/'");
    expect(sql.updateSql).not.toMatch(/SET\s+"?path"?\s*=/i);
    expect(sql.verifySql).toContain("cloned_physical_uris");
    expect(sql.verifySql).toContain("left(uri, char_length('file://')) = 'file://'");
    expect(sql.verifySql).toContain("uri = 'file:///private/target/.nautilo-tau' OR");
    expect(sql.updateSql).not.toContain("file:///private/source''s-root/.nautilo-other");
    for (const roots of [
      ["relative", "/private/target"],
      ["/", "/private/target"],
      ["/private/same", "/private/same"],
      ["/private/source\nunsafe", "/private/target"],
    ] as const) {
      expect(() => buildCloneFileUriRebindSql(roots[0], roots[1])).toThrow();
    }
  });

  test("rebinds local Workbench identities to the clone hostname", () => {
    const sql = buildCloneWorkbenchIdentityRebindSql("Tau.Local");
    expect(sql.updateSql).toContain("ci.channel = 'workbench'");
    expect(sql.updateSql).toContain("u.server IS NULL");
    expect(sql.updateSql).toContain("'@' || u.handle || '@' || 'tau.local'");
    expect(sql.verifySql).toContain("ci.external_id IS DISTINCT FROM");
    expect(sql.verifySql).toContain("INNER JOIN public.users AS u");
    for (const hostname of ["", ".tau.local", "tau..local", "tau.local\nunsafe"]) {
      expect(() => buildCloneWorkbenchIdentityRebindSql(hostname)).toThrow(
        "Unsafe clone federated hostname",
      );
    }
  });

  test("projects a clone-specific durable server identity and presentation", () => {
    const serverInstanceId = "1bd9ec3b-d51a-4ac3-8df1-76b2370f00f2";
    const sql = buildCloneServerIdentityRebindSql({
      instanceId: "agent-lab-350-a1b2",
      serverInstanceId,
    });

    expect(sql.profileName).toBe("Nautilo Clone — agent-lab-350-a1b2");
    expect(sql.updateSql).toContain("BEGIN;");
    expect(sql.updateSql).toContain("COMMIT;");
    expect(sql.updateSql).toContain("DELETE FROM public.ordinary_request_admissions");
    expect(sql.updateSql).toContain("DELETE FROM public.remote_controller_bindings");
    expect(sql.updateSql).toContain("DELETE FROM public.remote_pairing_challenges");
    expect(sql.updateSql).toContain("DELETE FROM public.remote_controller_installations");
    expect(sql.updateSql).toContain("DELETE FROM public.member_rollouts");
    for (const table of [
      "owned_photo_entries",
      "agent_photo_selection_revisions",
      "photo_library_operations",
    ]) {
      expect(sql.updateSql).toContain(`UPDATE public.${table}`);
      expect(sql.verifySql).toContain(`FROM public.${table}`);
    }
    for (const trigger of [
      "owned_photo_entries_identity_immutable",
      "agent_photo_selection_revisions_append_only_update",
      "photo_library_operations_identity_immutable",
    ]) {
      expect(sql.updateSql).toContain(`DISABLE TRIGGER ${trigger}`);
      expect(sql.updateSql).toContain(`ENABLE TRIGGER ${trigger}`);
    }
    expect(sql.updateSql).toContain(`'${serverInstanceId}'::uuid`);
    expect(sql.updateSql).toContain("server_binding_generation = EXCLUDED.server_binding_generation");
    expect(sql.updateSql).toContain("Nautilo Clone — agent-lab-350-a1b2");
    expect(sql.verifySql).toContain("'copiedAuthorityRows'");

    for (const invalid of [
      { instanceId: "", serverInstanceId },
      { instanceId: "default", serverInstanceId: "not-a-uuid" },
    ]) {
      expect(() => buildCloneServerIdentityRebindSql(invalid)).toThrow("Unsafe clone");
    }
  });

  test("suppresses Docker inventory fallback warnings for quiet composition", () => {
    const messages: string[] = [];
    expect(clonePortInventoryWarningSink(true, (message) => messages.push(message))).toBeUndefined();
    const sink = clonePortInventoryWarningSink(false, (message) => messages.push(message));
    sink?.("fixed fallback warning");
    expect(messages).toEqual(["fixed fallback warning"]);
  });

  test("classifies only known Compose errors and collapses secrets to unknown", () => {
    const samples = new Map([
      ["Bind for 0.0.0.0:5434 failed: port is already allocated", "port-conflict"],
      ["Conflict. The container name /nautilo-postgres is already in use", "container-name-conflict"],
      ["No such image: pgvector/pgvector:pg17 (pull policy never)", "missing-image"],
      ["compose config interpolation failed: variable PORT is not set", "compose-config"],
      ["Cannot connect to the Docker daemon. Is the docker daemon running?", "daemon-unavailable"],
      ["unable to get image pgvector: Cannot connect to the Docker daemon", "daemon-unavailable"],
      ["password=secret-provider token=secret", "unknown"],
    ] as const);
    for (const [message, category] of samples) {
      expect(classifyCloneComposeFailure(new Error(message))).toBe(category);
    }
    expect([...CLONE_COMPOSE_FAILURE_CATEGORIES]).toContain("unknown");
  });

  test("requires exact target Compose env and port authority", () => {
    const root = "/private/d489/.nautilo-tau";
    const env = {
      NAUTILO_INSTANCE_ID: target.instanceId,
      NAUTILO_INSTANCE_ROOT: root,
      COMPOSE_PROJECT_NAME: target.compose.projectName,
      NAUTILO_DB_PORT: String(target.db.postgresHostPort),
      NAUTILO_LOGTO_DB_PORT: String(target.logto.dbPort),
      NAUTILO_OPENCONNECTOR_ENCRYPTION_KEY_PATH: join(
        root,
        "runtime-secrets/openconnector-encryption.key",
      ),
      NAUTILO_OPENCONNECTOR_DATA_DIR: join(root, "openconnector-data"),
    };
    expect(() => assertCloneComposeEnvAuthority(target, root, env)).not.toThrow();
    for (const key of Object.keys(env)) {
      expect(() => assertCloneComposeEnvAuthority(target, root, { ...env, [key]: "wrong" })).toThrow(
        "Clone Compose config authority mismatch",
      );
    }
  });

  test("wraps every database startup step with only its fixed code", async () => {
    for (const failureCode of CLONE_DATABASES_STARTED_FAILURE_CODES) {
      const calls: string[] = [];
      const steps = Object.fromEntries(CLONE_DATABASES_STARTED_FAILURE_CODES.map((code) => [
        code,
        async () => {
          calls.push(code);
          if (code === failureCode) throw new Error("password=must-not-persist");
        },
      ])) as Record<typeof CLONE_DATABASES_STARTED_FAILURE_CODES[number], () => Promise<void>>;
      const failure = await runCloneDatabasesStartedSteps(steps).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CloneDatabasesStartedError);
      expect(cloneDatabasesStartedFailureCode(failure)).toBe(failureCode);
      expect(cloneDatabasesStartedComposeCategory(failure)).toBe(
        failureCode.endsWith("compose") ? "unknown" : null,
      );
      expect((failure as Error).message).toBe(`Clone database startup failed at ${failureCode}`);
      expect((failure as Error).message).not.toContain("password");
      expect(calls).toEqual(CLONE_DATABASES_STARTED_FAILURE_CODES.slice(0, calls.length));
    }
    expect(cloneDatabasesStartedFailureCode(new Error("raw secret"))).toBeNull();
  });

  test("waits for the version SQL query after pg_isready succeeds", async () => {
    let pgReadyCalls = 0;
    let versionCalls = 0;
    let sleeps = 0;
    expect(await waitForPostgresSqlReadiness({
      isPgReady: () => {
        pgReadyCalls += 1;
        return true;
      },
      readMajorVersion: () => {
        versionCalls += 1;
        if (versionCalls === 1) throw new Error("database is still starting");
        return 17;
      },
      sleep: async () => {
        sleeps += 1;
      },
    }, 2)).toBe(17);
    expect({ pgReadyCalls, versionCalls, sleeps }).toEqual({
      pgReadyCalls: 2,
      versionCalls: 2,
      sleeps: 1,
    });
  });

  test("bounds SQL-readiness failures without exposing database output", async () => {
    const failure = await waitForPostgresSqlReadiness({
      isPgReady: () => true,
      readMajorVersion: () => {
        throw new Error("password=must-not-persist");
      },
      sleep: async () => undefined,
    }, 2).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("PostgreSQL did not become SQL-ready");
    expect((failure as Error).message).not.toContain("password");
  });

  test("wraps every full-clone acceptance boundary with only its fixed code", async () => {
    for (const failureCode of CLONE_ACCEPTANCE_FAILURE_CODES) {
      const calls: string[] = [];
      const steps = Object.fromEntries(CLONE_ACCEPTANCE_FAILURE_CODES.map((code) => [
        code,
        async () => {
          calls.push(code);
          if (code === failureCode) throw new Error("password=must-not-persist");
        },
      ])) as Record<typeof CLONE_ACCEPTANCE_FAILURE_CODES[number], () => Promise<void>>;
      const failure = await runCloneAcceptanceSteps(steps).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CloneAcceptanceError);
      expect(cloneAcceptanceFailureCode(failure)).toBe(failureCode);
      expect((failure as Error).message).toBe(`Clone acceptance failed at ${failureCode}`);
      expect((failure as Error).message).not.toContain("password");
      expect(calls).toEqual(CLONE_ACCEPTANCE_FAILURE_CODES.slice(0, calls.length));
    }
    expect(cloneAcceptanceFailureCode(new Error("raw secret"))).toBeNull();
    const verifyFailure = new CloneAcceptanceError(
      "verify-command",
      new CloneVerifyCommandError("runtime-role", new Error("password=must-not-persist")),
    );
    expect(cloneAcceptanceVerifyFailureId(verifyFailure)).toBe("runtime-role");
    expect(cloneAcceptanceVerifyFailureId(new CloneAcceptanceError("lineage"))).toBeNull();
    expect(verifyFailure.message).not.toContain("password");
  });

  test("exposes only stable typed canonical-source evidence failures", async () => {
    const selectorFailure = await captureCanonicalDefaultSourceEvidence({
      kind: "named",
      instanceId: "default",
      root: "/private/untrusted",
    }).catch((error: unknown) => error);
    expect(selectorFailure).toBeInstanceOf(CanonicalDefaultSourceEvidenceError);
    expect(canonicalDefaultSourceEvidenceFailureCode(selectorFailure)).toBe("source-selector");
    expect(canonicalDefaultSourceEvidenceFailureCode(new Error("password=secret"))).toBeNull();
    for (const code of CANONICAL_DEFAULT_SOURCE_EVIDENCE_FAILURE_CODES) {
      const error = new CanonicalDefaultSourceEvidenceError(code);
      expect(error.message).toBe(`Canonical default source evidence failed at ${code}`);
      expect(canonicalDefaultSourceEvidenceFailureCode(error)).toBe(code);
    }
  });

  test("restricts the disposable migration runner seam to the isolated D489 worker", () => {
    const previous = process.env["NAUTILO_D489_LIVE_CHILD"];
    delete process.env["NAUTILO_D489_LIVE_CHILD"];
    try {
      expect(materializeClone({} as never, undefined, {
        disposableMigrationAcceptance: {
          checkoutLineage: [],
          run: async () => undefined,
        },
      })).rejects.toThrow(/restricted to the isolated D489 worker/);
    } finally {
      if (previous === undefined) delete process.env["NAUTILO_D489_LIVE_CHILD"];
      else process.env["NAUTILO_D489_LIVE_CHILD"] = previous;
    }
  });

  test("recreates clone databases with first-boot isolation grants", () => {
    const nautilo = buildCloneDatabaseRecreateSql("nautilo", "nautilo");
    expect(nautilo).toContain("DROP DATABASE IF EXISTS nautilo WITH (FORCE)");
    expect(nautilo).toContain("REVOKE ALL ON DATABASE nautilo FROM PUBLIC");
    expect(nautilo).toContain(
      "GRANT CONNECT ON DATABASE nautilo TO nautilo_agent",
    );
    // pg_dump includes feed policies/grants, but omits cluster-wide roles.
    expect(nautilo).toContain("CREATE ROLE nautilo_feed_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS");
    expect(nautilo).toContain("GRANT nautilo_feed_reader TO nautilo WITH INHERIT FALSE");
    expect(nautilo).toContain("Only the product role may assume nautilo_feed_reader");

    const logto = buildCloneDatabaseRecreateSql("logto_nautilo", "logto");
    expect(logto).not.toContain("nautilo_feed_reader");
    expect(logto).toContain(
      "REVOKE ALL ON DATABASE logto_nautilo FROM nautilo",
    );
    expect(logto).toContain(
      "GRANT ALL ON DATABASE logto_nautilo TO logto",
    );
    expect(() =>
      buildCloneDatabaseRecreateSql("other", "postgres"),
    ).toThrow("Unsupported");
  });

  test("provisions the canonical restricted feed reader before importing Nautilo", async () => {
    const calls: string[] = [];
    const queries: Array<{ container: string; database: string; sql: string }> = [];
    await restoreCloneNautiloDatabase({
      container: "nautilo-tau-postgres",
      inputPath: "/verified/nautilo.sql.gz",
    }, {
      query: (input) => {
        calls.push("recreate-with-feed-reader");
        queries.push(input);
        return "";
      },
      importDatabase: (input) => {
        calls.push("import");
        expect(input).toEqual({
          container: "nautilo-tau-postgres",
          database: "nautilo",
          inputPath: "/verified/nautilo.sql.gz",
        });
        return Promise.resolve();
      },
    });

    expect(calls).toEqual(["recreate-with-feed-reader", "import"]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toEqual({
      container: "nautilo-tau-postgres",
      database: "postgres",
      sql: buildCloneDatabaseRecreateSql("nautilo", "nautilo"),
    });
    expect(queries[0]?.sql).toContain(buildEventFeedReaderRoleSql());
    expect(queries[0]?.sql).toContain(
      "nautilo_feed_reader must be a restricted non-login role",
    );
    expect(queries[0]?.sql).toContain(
      "Only the product role may assume nautilo_feed_reader",
    );
    expect(queries[0]?.sql).not.toContain("CREATE ROLE %I");

    let queryCount = 0;
    let importCalled = false;
    const roleFailure = await restoreCloneNautiloDatabase({
      container: "nautilo-tau-postgres",
      inputPath: "/verified/nautilo.sql.gz",
    }, {
      query: () => {
        queryCount += 1;
        throw new Error("restricted role is unsafe");
      },
      importDatabase: () => {
        importCalled = true;
        return Promise.resolve();
      },
    }).catch((error: unknown) => error);
    expect(roleFailure).toMatchObject({ message: "restricted role is unsafe" });
    expect(queryCount).toBe(1);
    expect(importCalled).toBe(false);
  });

  test("reconstructs Logto tenant memberships omitted by database dumps", () => {
    expect(LOGTO_RESTORE_ROLE_TOPOLOGY_SQL).toContain(
      "FROM public.tenants",
    );
    expect(LOGTO_RESTORE_ROLE_TOPOLOGY_SQL).toContain(
      "CREATE ROLE %I NOLOGIN",
    );
    expect(LOGTO_RESTORE_ROLE_TOPOLOGY_SQL).toContain(
      "GRANT %I TO logto WITH ADMIN OPTION",
    );
    expect(LOGTO_RESTORE_ROLE_TOPOLOGY_SQL).toContain(
      "unexpected Logto tenant database role",
    );
  });

  test("requires distinct valid named IDs", () => {
    expect(() => validateCloneArgs({ from: "", to: "tau" })).toThrow(
      "--from",
    );
    expect(() => validateCloneArgs({ from: "qa-source", to: "qa-source" }))
      .toThrow("differ");
    expect(() => validateCloneArgs({ from: "qa-source", to: "tau" }))
      .not.toThrow();
  });

  test("dev:clone consumes the injectable named materializer seam", async () => {
    let request: CloneMaterializationRequest | undefined;
    const exitCode = await cloneDevInstance(
      { from: "default", to: "tau" },
      async (input) => {
        request = input;
        return 17;
      },
    );

    expect(exitCode).toBe(17);
    expect(request).toEqual({
      source: {
        kind: "named",
        instanceId: "default",
        root: join(process.env["HOME"]?.trim() || homedir(), ".nautilo-default"),
      },
      target: {
        instanceId: "tau",
        root: join(process.env["HOME"]?.trim() || homedir(), ".nautilo-tau"),
        projectName: "nautilo-tau",
      },
    });
  });

  test("refuses materializer requests whose selected roots do not match their IDs", async () => {
    const home = process.env["HOME"]?.trim() || homedir();
    const validTarget = {
      instanceId: "tau",
      root: join(home, ".nautilo-tau"),
      projectName: "nautilo-tau",
    };
    const sourceMismatch = await materializeClone({
      source: {
        kind: "named",
        instanceId: "qa-source",
        root: "/tmp/not-nautilo-qa-source",
      },
      target: validTarget,
    }).catch((error: unknown) => error);
    expect(sourceMismatch).toMatchObject({
      message: "Resolved source root is not the expected named dev instance root",
    });
    const targetMismatch = await materializeClone({
      source: {
        kind: "named",
        instanceId: "qa-source",
        root: join(home, ".nautilo-qa-source"),
      },
      target: { ...validTarget, root: "/tmp/not-nautilo-tau" },
    }).catch((error: unknown) => error);
    expect(targetMismatch).toMatchObject({
      message: "Resolved target root is not the expected named dev instance root",
    });
  });

  test("captures a fresh backup from the named source, never the target", () => {
    const command = buildCloneSourceCaptureCommand("auto-clone-fixed", "qa-source");
    expect(command.slice(-4)).toEqual([
      "save",
      "auto-clone-fixed",
      "--instance",
      "qa-source",
    ]);
    expect(command).not.toContain("tau");
  });

  test("rejects every target-state collision surface", () => {
    for (const state of [
      { root: true, containers: [], networks: [], volumes: [] },
      { root: false, containers: ["nautilo-tau-postgres"], networks: [], volumes: [] },
      { root: false, containers: [], networks: ["nautilo-tau_default"], volumes: [] },
      { root: false, containers: [], networks: [], volumes: ["nautilo-tau_pgdata"] },
    ]) {
      expect(() => assertCloneTargetAbsent(state)).toThrow("not wholly absent");
    }
    expect(() =>
      assertCloneTargetAbsent({
        root: false,
        containers: [],
        networks: [],
        volumes: [],
      }),
    ).not.toThrow();
  });

  test("proves source and target Docker identities remain disjoint", () => {
    const input = {
      sourceObjects: { containers: ["nautilo-qa-source-postgres"], networks: ["nautilo-qa-source_default"] },
      targetObjects: { containers: ["nautilo-tau-postgres"], networks: ["nautilo-tau_default"] },
      sourceVolumes: ["nautilo-epsilon_pgdata"],
      targetVolumes: ["nautilo-tau_pgdata"],
    };
    expect(() => assertCloneResourceIsolation(input)).not.toThrow();
    expect(() => assertCloneResourceIsolation({
      ...input,
      targetVolumes: input.sourceVolumes,
    })).toThrow("Source/target isolation proof failed");
  });

  test("fails acceptance if source config or row anchors changed", () => {
    const sourceEvidence = {
      instanceJsonHash: "instance-before",
      instanceEnvHash: "env-before",
      volumeState: "volume-before",
      projectObjects: { containers: ["nautilo-qa-source-postgres"], networks: ["nautilo-qa-source_default"] },
      writersRunning: true,
      databaseLedger: [],
      rowAnchors: { "nautilo.users": 7 },
    };
    expect(() => assertSourceEvidenceEqual(sourceEvidence, { ...sourceEvidence })).not.toThrow();
    expect(() => assertSourceEvidenceEqual(sourceEvidence, {
      ...sourceEvidence,
      instanceEnvHash: "env-after",
    })).toThrow("source state changed during clone");
    expect(() => assertSourceEvidenceEqual(sourceEvidence, {
      ...sourceEvidence,
      rowAnchors: { "nautilo.users": 8 },
    })).toThrow("source state changed during clone");
  });

  test("fails canonical source proof when writer restoration or database identity changes", () => {
    const evidence = {
      instanceJsonHash: "instance",
      instanceEnvHash: "env",
      volumeState: "volumes",
      projectObjects: { containers: [], networks: [] },
      writersRunning: true,
      databaseLedger: [],
      serverListenerState: "recognized:123" as const,
      logtoCoreState: "true|false" as const,
      databaseIdentity: "",
    };
    expect(() => assertCanonicalDefaultSourceEvidenceEqual(evidence, { ...evidence })).not.toThrow();
    expect(() => assertCanonicalDefaultSourceEvidenceEqual(evidence, {
      ...evidence,
      logtoCoreState: "absent",
    })).toThrow("canonical writer or identity");
    expect(() => assertCanonicalDefaultSourceEvidenceEqual(evidence, {
      ...evidence,
      serverListenerState: "absent",
    })).toThrow("canonical writer or identity");
    expect(() => assertCanonicalDefaultSourceEvidenceEqual(evidence, {
      ...evidence,
      databaseIdentity: "unexpected",
    })).toThrow("canonical writer or identity");
  });

  test("validates canonical admission without touching filesystem or source services", () => {
    expect(() => validateCanonicalDefaultCloneAdmission(undefined)).toThrow("admitted published");
    const failed = {
      seed: { operation: { status: "failed", source: { authority: "canonical-default" } } },
    } as unknown as CanonicalDefaultCloneAdmission;
    expect(() => validateCanonicalDefaultCloneAdmission(failed)).toThrow("admitted published");
    const wrongAuthority = {
      seed: { operation: { status: "published", source: { authority: "named" } } },
    } as unknown as CanonicalDefaultCloneAdmission;
    expect(() => validateCanonicalDefaultCloneAdmission(wrongAuthority)).toThrow("wrong source authority");
  });

  test("labels only an explicitly absent identity relation as unavailable", () => {
    expect(CANONICAL_DATABASE_IDENTITY_RELATION_SQL).toContain("to_regclass");
    expect(CANONICAL_DATABASE_IDENTITY_RELATION_SQL).not.toContain("FROM public.nautilo_instance_identity");
    expect(CANONICAL_DATABASE_IDENTITY_VALUE_SQL).toContain("FROM public.nautilo_instance_identity");
    expect(CANONICAL_DATABASE_IDENTITY_RELATION_SQL).not.toMatch(/query_to_xml|xpath/i);
    expect(canonicalDatabaseIdentityEvidence("__nautilo_identity_relation_absent__")).toBe("unavailable");
    expect(canonicalDatabaseIdentityEvidence("actual-default")).toBe("actual-default");
    expect(canonicalDatabaseIdentityEvidence("")).toBe("missing");
  });

  test("probes identity relation before reading its row and fails closed", () => {
    const absentQueries: string[] = [];
    expect(captureCanonicalDatabaseIdentityEvidence((sql) => {
      absentQueries.push(sql);
      return "f";
    })).toBe("unavailable");
    expect(absentQueries).toEqual([CANONICAL_DATABASE_IDENTITY_RELATION_SQL]);

    const presentQueries: string[] = [];
    expect(captureCanonicalDatabaseIdentityEvidence((sql) => {
      presentQueries.push(sql);
      return sql === CANONICAL_DATABASE_IDENTITY_RELATION_SQL ? "t" : "actual-default";
    })).toBe("actual-default");
    expect(presentQueries).toEqual([
      CANONICAL_DATABASE_IDENTITY_RELATION_SQL,
      CANONICAL_DATABASE_IDENTITY_VALUE_SQL,
    ]);

    expect(captureCanonicalDatabaseIdentityEvidence((sql) =>
      sql === CANONICAL_DATABASE_IDENTITY_RELATION_SQL ? "t" : "",
    )).toBe("missing");
    for (const query of [
      () => "unknown",
      () => { throw new Error("permission detail"); },
      (sql: string) => {
        if (sql === CANONICAL_DATABASE_IDENTITY_RELATION_SQL) return "t";
        throw new Error("relation disappeared");
      },
    ]) {
      const failure = (() => captureCanonicalDatabaseIdentityEvidence(query)) as () => string;
      expect(failure).toThrow(CanonicalDefaultSourceEvidenceError);
      try { failure(); } catch (error) {
        expect(canonicalDefaultSourceEvidenceFailureCode(error)).toBe("source-database-identity");
      }
    }
  });

  test("rewrites topology and source-root paths while preserving credentials", () => {
    const result = rebindCloneEnvContent({
      sourceRaw: [
        "OPENAI_API_KEY=secret-provider",
        "LOGTO_DB_PASSWORD=secret-logto",
        "LOGTO_ENDPOINT=http://localhost:3301",
        "LOGTO_ENDPOINT_INTERNAL=http://localhost:3301",
        "NAUTILO_ARTIFACTS_ROOT=/home/me/.nautilo-qa-source/artifacts",
        "NAUTILO_WORKBENCH_DIST=/home/me/.nautilo-qa-source/workbench-dist",
      ].join("\n"),
      sourceRoot: "/home/me/.nautilo-qa-source",
      targetRoot: "/home/me/.nautilo-tau",
      target,
    });
    expect(result).toContain("OPENAI_API_KEY=secret-provider");
    expect(result).toContain("LOGTO_DB_PASSWORD=secret-logto");
    expect(result).toContain("LOGTO_ENDPOINT=http://localhost:3311");
    expect(result).toContain("LOGTO_ENDPOINT_INTERNAL=http://localhost:3311");
    expect(result).toContain("COMPOSE_PROJECT_NAME=nautilo-tau");
    expect(result).toContain(
      "NAUTILO_ARTIFACTS_ROOT=/home/me/.nautilo-tau/artifacts",
    );
    expect(result).toContain(
      "NAUTILO_WORKBENCH_DIST=/home/me/.nautilo-tau/workbench-dist",
    );
    expect(result).not.toContain(".nautilo-qa-source");
  });

  test("journals stage order and preserves failure evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-clone-operation-"));
    roots.push(root);
    const path = join(root, "clone-operation.json");
    const record: CloneOperationRecord = {
      formatVersion: 1,
      sourceInstanceId: "qa-source",
      targetInstanceId: "tau",
      backupName: "backup",
      startedAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
      status: "running",
      completedStages: [],
    };
    const events: string[] = [];
    expect(
      runCloneStages({
        record,
        operationPath: path,
        stages: [
          { name: CLONE_STAGES[0], run: () => { events.push("topology"); return Promise.resolve(); } },
          { name: CLONE_STAGES[1], run: () => { throw new Error("import failed"); } },
        ],
      }),
    ).rejects.toThrow("import failed");
    expect(events).toEqual(["topology"]);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      status: "failed",
      completedStages: ["topology-created"],
      failure: "import failed",
    });
  });

  test("derives only the next fixed clone stage from a strict progress prefix", () => {
    for (let completed = 0; completed < CLONE_STAGES.length; completed++) {
      expect(deriveCloneOperationNextStage({
        status: "failed",
        completedStages: CLONE_STAGES.slice(0, completed),
        failure: "password=must-never-be-read",
      })).toBe(CLONE_STAGES[completed]!);
    }
    expect(deriveCloneOperationNextStage({
      status: "complete",
      completedStages: [...CLONE_STAGES],
    })).toBe("complete");
    expect(deriveCloneOperationNextStage({
      status: "complete",
      mode: "provision",
      completedStages: CLONE_STAGES.slice(0, CLONE_STAGES.indexOf("services-started")),
    })).toBe("complete");
    for (const invalid of [
      null,
      { status: "secret", completedStages: [] },
      { status: "failed", mode: "secret", completedStages: [] },
      { status: "failed", completedStages: [CLONE_STAGES[1]] },
      { status: "failed", completedStages: [...CLONE_STAGES, "extra"] },
      { status: "complete", completedStages: CLONE_STAGES.slice(0, -1) },
      { status: "failed", completedStages: [...CLONE_STAGES] },
      {
        status: "failed",
        mode: "provision",
        completedStages: CLONE_STAGES.slice(0, CLONE_STAGES.indexOf("services-started")),
      },
    ]) {
      expect(() => deriveCloneOperationNextStage(invalid)).toThrow();
    }
  });

  test("pins capture/import/rebind/migrate/start/accept stage order and post-target failure evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-clone-contract-"));
    roots.push(root);
    const operationPath = join(root, "clone-operation.json");
    const calls: CloneStage[] = [];
    const failureStage: CloneStage = "historical-databases-imported";
    const actions = Object.fromEntries(CLONE_STAGES.map((stage) => [
      stage,
      async () => {
        calls.push(stage);
        if (stage === failureStage) throw new Error("import failed");
      },
    ])) as Record<CloneStage, () => Promise<void>>;
    const stages = buildCloneStagePlan(actions);
    expect(stages.map((stage) => stage.name)).toEqual([...CLONE_STAGES]);

    const record: CloneOperationRecord = {
      formatVersion: 1,
      sourceInstanceId: "qa-source",
      targetInstanceId: "tau",
      backupName: "auto-clone-fixed",
      startedAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
      status: "running",
      completedStages: [],
    };
    expect(runCloneStages({ record, operationPath, stages })).rejects.toThrow("import failed");
    expect(calls).toEqual([...CLONE_STAGES.slice(0, 4)]);
    expect(JSON.parse(await readFile(operationPath, "utf8"))).toMatchObject({
      status: "failed",
      completedStages: CLONE_STAGES.slice(0, 3),
      failure: "import failed",
    });
  });

  test("keeps pre-target argument failures free of clone-operation evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-clone-pre-target-"));
    roots.push(root);
    const operationPath = join(root, "clone-operation.json");
    expect(() => validateCloneArgs({ from: "qa-source", to: "qa-source" })).toThrow("differ");
    expect(readFile(operationPath, "utf8")).rejects.toThrow();
  });

  test("pins named clone help plus completion and recovery output", async () => {
    const cli = await readFile(new URL("../../src/index.ts", import.meta.url), "utf8");
    expect(cli).toContain("clone [flags]                     Clone a complete backup of one named dev instance");
    expect(cli).toContain("flags: --from <id> --to <id>");
    expect(cli).toContain('console.error("clone: --from and --to are both required")');
    expect(formatCloneFailure("/tmp/.nautilo-tau/clone-operation.json", "tau")).toBe(
      "[dev:clone] failed; evidence preserved at /tmp/.nautilo-tau/clone-operation.json. " +
      "Cleanup explicitly with: bun run dev:delete-instance tau --yes",
    );
    expect(formatCloneReady({
      targetId: "tau",
      targetUrl: "http://localhost:3011",
      appliedMigrationCount: 2,
    })).toBe(
      "[dev:clone] tau is ready at http://localhost:3011; 2 Nautilo migration(s) applied.",
    );
  });
});
