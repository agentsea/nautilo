import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrations = resolve(import.meta.dirname, "../../src/migrations");
const migrationTag = "0157_m246_community_capability_substrate";
const migration = readFileSync(
  resolve(migrations, `${migrationTag}.sql`),
  "utf8",
);
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as {
  entries: readonly { idx: number; when: number; tag: string }[];
};

describe("M246 community Capability data migration", () => {
  test("is generator-registered after the previous immutable migration", () => {
    const entry = journal.entries.find((item) => item.idx === 157);
    const previous = journal.entries.find((item) => item.idx === 156);

    expect(entry).toMatchObject({ idx: 157, tag: migrationTag });
    expect(entry!.when).toBeGreaterThan(previous!.when);
    expect(entry!.when).toBeLessThanOrEqual(Date.now());
    expect(
      Bun.file(resolve(migrations, "meta/0157_snapshot.json")).size,
    ).toBeGreaterThan(0);
  });

  test("inserts the exact additive catalogue rows without replacement", () => {
    expect(migration).toContain("'invoke_agents'");
    expect(migration).toContain("'write_artifacts'");
    expect(migration).toContain(
      "'Start or resume Agent execution through chat, Jobs, Tasks, and schedules.'",
    );
    expect(migration).toContain(
      "'Create or mutate Workspace Artifacts, documents, and mini-app state.'",
    );
    expect(migration).toContain("'agents'");
    expect(migration).toContain("'artifacts'");
    expect(migration).toContain('ON CONFLICT ("slug") DO NOTHING');
  });

  test("grants existing custom and non-Guest canonical Roles only", () => {
    expect(migration).toContain('"roles"."is_system" = false');
    expect(migration).toContain('"roles"."slug" <> \'guest\'');
    for (const role of [
      "owner",
      "admin",
      "superuser",
      "member",
      "contributor",
    ]) {
      expect(migration).toContain(`'${role}'`);
    }
    expect(migration).toContain(
      'ON CONFLICT ("role_id", "capability_id") DO NOTHING',
    );
  });

  test("contains no destructive or replacement statement", () => {
    expect(migration).not.toMatch(
      /^\s*(?:DELETE|UPDATE|DROP|TRUNCATE|ALTER)\b/im,
    );
    expect(migration).not.toMatch(/ON\s+CONFLICT[\s\S]*DO\s+UPDATE/i);
  });
});
