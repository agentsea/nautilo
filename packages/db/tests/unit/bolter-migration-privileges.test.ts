import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { repairBolterMigration, readMigrationFilesWithPrivilegeCompat } from "../../src/utils/migration-privilege-compat";

const directory = new URL("../../src/migrations/", import.meta.url);
const cases = [
  ["0341_bent_dust.sql", "a8ec1bf41169f027549ad0381bb61387b7a4e5c413499b2ecb53922cfd671989", ["bolter_connections", "bolter_room_bindings", "bolter_inbox_receipts", "bolter_outbox"]],
  ["0344_mysterious_runaways.sql", "e80e583c0ab40db13668a6e98fea9bd838d227ac2286ac3d8dd8371cdb15936a", ["bolter_outbox"]],
  ["0350_gigantic_whistler.sql", "70cdb08e7b09df2d4f6789c51e779c00da5a8df2a5e5adc3b6e56b53c36c7ec7", ["bolter_explicit_shares"]],
] as const;

describe("Bolter least-privilege migration compatibility", () => {
  for (const [file, hash, tables] of cases) {
    test(`${file} grants TRIGGER only around each affected guard creation`, () => {
      const source = readFileSync(new URL(file, directory), "utf8");
      expect(createHash("sha256").update(source).digest("hex")).toBe(hash);
      const corrected = repairBolterMigration(file, source);
      let restored = corrected;
      for (const table of tables) {
        const grant = `GRANT TRIGGER ON TABLE public.${table} TO nautilo;`;
        const revoke = `REVOKE TRIGGER ON TABLE public.${table} FROM nautilo;`;
        expect(corrected.split(grant)).toHaveLength(2);
        expect(corrected.split(revoke)).toHaveLength(2);
        const start = corrected.indexOf(grant);
        const end = corrected.indexOf(revoke);
        const scope = corrected.slice(start, end);
        expect(scope).toMatch(new RegExp(`CREATE TRIGGER [a-z_]+ BEFORE [\\s\\S]+ ON public\\.${table}\\nFOR EACH ROW EXECUTE FUNCTION`));
        expect(scope.match(/CREATE TRIGGER/g)).toHaveLength(1);
        restored = restored.replace(`${grant}\n--> statement-breakpoint\n`, "")
          .replace(`\n--> statement-breakpoint\n${revoke}`, "");
      }
      if (file === "0344_mysterious_runaways.sql") {
        const signature = "public.bolter_assert_current_binding(uuid,uuid,integer,integer)";
        const grant = `GRANT EXECUTE ON FUNCTION ${signature} TO nautilo;`;
        const revoke = `REVOKE EXECUTE ON FUNCTION ${signature} FROM nautilo;`;
        expect(corrected.split(grant)).toHaveLength(2);
        expect(corrected.split(revoke)).toHaveLength(2);
        expect(corrected.indexOf(grant)).toBeLessThan(corrected.indexOf("CREATE OR REPLACE FUNCTION public.bolter_assert_current_binding"));
        expect(corrected.indexOf(revoke)).toBeGreaterThan(corrected.indexOf("CREATE OR REPLACE FUNCTION public.bolter_assert_current_binding"));
        restored = restored.replace(`${grant}\n--> statement-breakpoint\n`, "")
          .replace(`\n--> statement-breakpoint\n${revoke}`, "");
      }
      if (file === "0350_gigantic_whistler.sql") {
        const target = "REFERENCES (user_id,id) ON TABLE public.bolter_room_bindings";
        const grant = `GRANT ${target} TO nautilo;`;
        const revoke = `REVOKE ${target} FROM nautilo;`;
        expect(corrected.split(grant)).toHaveLength(2);
        expect(corrected.split(revoke)).toHaveLength(2);
        const constraint = corrected.indexOf('ADD CONSTRAINT "bolter_shares_binding_owner"');
        expect(corrected.indexOf(grant)).toBeLessThan(constraint);
        expect(corrected.indexOf(revoke)).toBeGreaterThan(constraint);
        restored = restored.replace(`${grant}\n--> statement-breakpoint\n`, "")
          .replace(`\n--> statement-breakpoint\n${revoke}`, "");
      }
      expect(restored).toBe(source);
      expect(() => repairBolterMigration(file, `${source}\n-- changed`)).toThrow("Refusing unknown");
      expect(readFileSync(new URL(file, directory), "utf8")).toBe(source);
    });
  }

  test("corrected metadata retains canonical hashes and unrelated statements", () => {
    const config = { migrationsFolder: fileURLToPath(directory) };
    const canonical = readMigrationFiles(config);
    const corrected = readMigrationFilesWithPrivilegeCompat(config);
    const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", directory), "utf8")) as {
      entries: { tag: string }[];
    };
    for (const [file] of cases) {
      const index = journal.entries.findIndex(({ tag }) => `${tag}.sql` === file);
      expect(index).toBeGreaterThan(-1);
      expect(corrected[index]!.hash).toBe(canonical[index]!.hash);
      expect(corrected[index]!.folderMillis).toBe(canonical[index]!.folderMillis);
      expect(corrected[index]!.bps).toBe(canonical[index]!.bps);
      expect(corrected[index]!.sql.join("--> statement-breakpoint"))
        .toBe(repairBolterMigration(file, readFileSync(new URL(file, directory), "utf8")));
    }
    const unrelated = journal.entries.findIndex(({ tag }) => tag === "0342_stale_vermin");
    expect(corrected[unrelated]).toEqual(canonical[unrelated]);
    expect(() => repairBolterMigration("unknown.sql", "SELECT 1;")).toThrow("Unknown migration");
  });
});
