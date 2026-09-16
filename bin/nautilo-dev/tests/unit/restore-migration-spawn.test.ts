import { describe, expect, mock, test } from "bun:test";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRestoreMigrationEnv,
  runRestoreMigrations,
  type RestoreMigrationSpawnFn,
} from "../../src/lib/docker-db";

/**
 * Regression test for the named-instance restore migration bug.
 *
 * Bug: `restoreFromGzip` ran `bun run db:migrate` from the repo root,
 * which routes through `turbo run db:migrate`. Turbo has no env
 * passthrough for `DB_CONNECTION_STRING` (turbo.json `db:migrate` only
 * sets `cache: false`), so drizzle.config.ts fell back to its hardcoded
 * default (port 5434 = the default instance). On a named instance like
 * `d425-source` (different postgres host port), migrations landed on
 * the WRONG database, leaving the target DB with zero public tables;
 * restore then failed at `COPY public.users`.
 *
 * Fix: `runRestoreMigrations` spawns `bun run db:migrate` with cwd
 * pinned to `packages/db` with M212's explicit direct/admin connection env,
 * bypassing the root Turbo wrapper entirely.
 */

const src = readFileSync(
  join(import.meta.dir, "..", "..", "src", "lib", "docker-db.ts"),
  "utf8",
);

function isolatedEnv(): NodeJS.ProcessEnv {
  return { ...process.env, HOME: mkdtempSync(join(tmpdir(), "restore-spawn-")), NAUTILO_INSTANCE_ID: "restore-fixture" };
}

describe("runRestoreMigrations — spawns packages/db migration directly (regression)", () => {
  test("invokes `bun run db:migrate` with cwd pinned to packages/db (not repo root / Turbo)", () => {
    const calls: Array<{ cmd: string; args: readonly string[]; opts: { cwd: string; env: NodeJS.ProcessEnv } }> = [];
    const spawnMock = mock(
      ((cmd: string, args: readonly string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => {
        calls.push({ cmd, args, opts: { cwd: opts.cwd, env: opts.env } });
        return { status: 0, stdout: "", stderr: "" };
      }) as unknown as RestoreMigrationSpawnFn,
    );

    runRestoreMigrations(() => {}, spawnMock, isolatedEnv());

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const call = calls[0]!;
    expect(call.cmd).toBe("bun");
    // Script name is exactly the packages/db script, NOT `turbo run db:migrate`.
    expect(call.args).toEqual(["run", "db:migrate"]);
    // cwd MUST be packages/db — the thing that actually runs drizzle-kit
    // migrate with the env we pass. Root cwd is the bug.
    expect(call.opts.cwd).toBe(join(process.cwd(), "packages", "db"));
  });

  test("forwards M212's direct Postgres migration connection in the spawned env", () => {
    const calls: Array<{ env: NodeJS.ProcessEnv }> = [];
    const spawnMock = mock(
      ((_cmd: string, _args: readonly string[], opts: { env: NodeJS.ProcessEnv }) => {
        calls.push({ env: opts.env });
        return { status: 0, stdout: "", stderr: "" };
      }) as unknown as RestoreMigrationSpawnFn,
    );

    // A runtime URL must be replaced with the instance's direct Postgres
    // connection: migrations must create extensions and cannot use the
    // restricted `nautilo` application role.
    const namedParentEnv = {
      ...isolatedEnv(),
      NAUTILO_INSTANCE_ID: "d425-source",
      NAUTILO_DB_PASSWORD: "secret",
    };
    const expected = buildRestoreMigrationEnv(namedParentEnv);
    runRestoreMigrations(() => {}, spawnMock, namedParentEnv);

    expect(calls[0]!.env["DB_CONNECTION_STRING"]).toBe(expected["DB_CONNECTION_STRING"]);
    expect(calls[0]!.env["DB_DIRECT_CONNECTION"]).toBe(expected["DB_DIRECT_CONNECTION"]);
    expect(calls[0]!.env["DB_CONNECTION_STRING"]).toContain("nautilo:secret@");
  });

  test("throws on non-zero migration exit (never silently continues to COPY)", () => {
    const spawnMock = mock(
      (() => ({ status: 1, stdout: "", stderr: "drizzle: relation already exists" }) as unknown as ReturnType<
        RestoreMigrationSpawnFn
      >) as unknown as RestoreMigrationSpawnFn,
    );

    expect(() =>
      runRestoreMigrations(() => {}, spawnMock, isolatedEnv()),
    ).toThrow(/Schema migration failed/);
  });
});

describe("restoreFromGzip — no root-Turbo migration path (source guard)", () => {
  test("does NOT shell out to root `bun run db:migrate` via `cd ${process.cwd()}`", () => {
    // The bug was `cd "${process.cwd()}" && bun run db:migrate` at repo
    // root, which goes through Turbo and drops DB_CONNECTION_STRING.
    // The fix routes through runRestoreMigrations (packages/db direct).
    expect(src).not.toContain('cd "${process.cwd()}" && bun run db:migrate');
  });

  test("does NOT invoke `turbo run db:migrate` directly either", () => {
    expect(src).not.toMatch(/turbo run db:migrate/);
  });

  test("restoreFromGzip delegates migrations to runRestoreMigrations", () => {
    expect(src).toContain("runRestoreMigrations(log, undefined, migrationEnv)");
    expect(src.indexOf("const migrationEnv = buildRestoreMigrationEnv()")).toBeLessThan(src.indexOf("  dropAndCreateDb();"));
    expect(src.indexOf("  repairOwnershipAndGrants(legacyPostgresContainer(), log);")).toBeLessThan(src.indexOf("  runRestoreMigrations(log, undefined, migrationEnv);"));
  });

  test("runRestoreMigrations pins cwd to packages/db and forwards M212 connection env", () => {
    expect(src).toContain('join(process.cwd(), "packages", "db")');
    expect(src).toContain("env: buildRestoreMigrationEnv(parentEnv)");
    expect(src).toContain("resolveNautiloOwnerConnectionString");
  });

  test("restore rebinds the database marker to the selected target instance", () => {
    expect(src).toContain("rebindRestoredInstanceIdentity(log)");
    expect(src).toContain("ON CONFLICT (id) DO UPDATE SET instance_id = EXCLUDED.instance_id");
    expect(src).toContain("resolveInstance().instanceId");
  });
});
