import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { assertBolterRestoreDumpAllowed, BOLTER_RESTORE_AUTHORITY_TABLES } from "../../src/lib/bolter-restore-authority";
import { restoreFromGzip } from "../../src/lib/docker-db";

function withDump(text: string, run: (path: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "bolter-restore-"));
  const path = join(directory, "database.sql.gz");
  writeFileSync(path, gzipSync(text));
  return run(path).finally(() => rmSync(directory, { recursive: true, force: true }));
}

for (const format of ["legacy", "full"] as const) {
  describe(`${format} Bolter restore authority`, () => {
    const prefix = format === "full" ? "CREATE SCHEMA public;\nCREATE TABLE public.bolter_connections (id uuid);\n" : "";
    for (const table of BOLTER_RESTORE_AUTHORITY_TABLES) {
      test(`rejects populated ${table} before database or environment access`, async () => {
        await withDump(`${prefix}COPY ${table} (id) FROM stdin;\n00000000-0000-4000-8000-000000000001\n\\.\n`, async path => {
          // Invokes the real restore entry. Rejection precedes credentials,
          // Docker, migrations, drop/create and either format's import branch.
          await Promise.resolve(expect(restoreFromGzip(path, () => { throw new Error("Restore already began"); },
            format === "full" ? { fullArchive: { expectedMigrationLineage: [] } } : {}))
            .rejects.toThrow("Restore of populated Bolter"));
        });
      });
    }
    test("admits empty bridge tables without changing ordinary restore checks", async () => {
      const text = prefix + BOLTER_RESTORE_AUTHORITY_TABLES.map(table => `COPY ${table} (id) FROM stdin;\n\\.\n`).join("");
      await withDump(text, async path => { await assertBolterRestoreDumpAllowed(path); });
    });
    test("admits older snapshots with unrelated rows", async () => {
      await withDump(`${prefix}COPY public.users (id) FROM stdin;\nsynthetic-owner\n\\.\n`, async path => { await assertBolterRestoreDumpAllowed(path); });
    });
    test("admits inert control evidence without admitting replay authority", async () => {
      const archive = `${prefix}COPY public.external_operator_control_archive (message_id, user_id, evidence) FROM stdin;\n1\tsynthetic-owner\t{"message":{"content":"synthetic audit evidence"}}\n\\.\n`;
      await withDump(archive, async path => { await assertBolterRestoreDumpAllowed(path); });
      await withDump(archive + "COPY public.bolter_inbox_receipts (id) FROM stdin;\nsynthetic-receipt\n\\.\n", async path => {
        await Promise.resolve(expect(assertBolterRestoreDumpAllowed(path)).rejects.toThrow("Restore of populated Bolter"));
      });
    });
  });
}

test("restore admission precedes autosave and target mutation at both entry points", () => {
  const command = readFileSync(new URL("../../src/commands/restore.ts", import.meta.url), "utf8");
  const admission = command.indexOf("await assertBolterRestoreDumpAllowed(dbPath)");
  expect(admission).toBeGreaterThan(0);
  for (const operation of ["await save(", "restoreLogtoFromGzip(", "await clearHomeForRestore(", "await restoreFromGzip("]) {
    const offset = command.indexOf(operation);
    expect(offset).toBeGreaterThan(admission);
  }
  const database = readFileSync(new URL("../../src/lib/docker-db.ts", import.meta.url), "utf8");
  const start = database.indexOf("export async function restoreFromGzip(");
  const body = database.slice(start);
  expect(body.indexOf("await assertBolterRestoreDumpAllowed(gzipPath)")).toBeLessThan(body.indexOf("dropAndCreateDb()"));
  expect(body.indexOf("await assertBolterRestoreDumpAllowed(gzipPath)")).toBeLessThan(body.indexOf("if (options.fullArchive)"));
});

for (const table of ['public."bolter_connections"', '"public"."bolter_connections"', 'PUBLIC.BOLTER_CONNECTIONS']) {
  test(`rejects quoted COPY authority ${table} without trailing newline`, async () => {
    await withDump(`COPY ${table} (id) FROM stdin;\nsynthetic-row\n\\.`, async path => {
      await Promise.resolve(expect(assertBolterRestoreDumpAllowed(path)).rejects.toThrow("Restore of populated Bolter"));
    });
  });
}
test("rejects INSERT-format dumps instead of treating them as empty", async () => {
  for (const header of ['INSERT INTO public.bolter_connections', 'INSERT\nINTO "public"."bolter_connections"']) {
    await withDump(`${header} (id) VALUES ('synthetic-row');`, async path => {
      await Promise.resolve(expect(assertBolterRestoreDumpAllowed(path)).rejects.toThrow("INSERT-format dumps are unsupported"));
    });
  }
});
test("rejects unterminated COPY and malformed gzip without admitting an empty backup", async () => {
  await withDump("COPY public.bolter_connections (id) FROM stdin;\nsynthetic-row", async path => {
    await Promise.resolve(expect(assertBolterRestoreDumpAllowed(path)).rejects.toThrow("unterminated COPY"));
  });
  await withDump("", async path => {
    writeFileSync(path, "not gzip");
    await Promise.resolve(expect(assertBolterRestoreDumpAllowed(path)).rejects.toThrow());
  });
});
test("does not interpret a different schema's COPY payload as SQL", async () => {
  await withDump("COPY other.entries (body) FROM stdin;\nINSERT INTO public.bolter_connections\n\\.\n", async path => {
    await assertBolterRestoreDumpAllowed(path);
  });
});

test("full archive schema function bodies do not masquerade as table data", async () => {
  const schema = "CREATE FUNCTION public.example() RETURNS void LANGUAGE plpgsql AS $function$\nBEGIN\nINSERT INTO public.bolter_connections VALUES ('synthetic');\nEND;\n$function$;\n";
  await withDump(schema + "COPY public.bolter_connections (id) FROM stdin;\n\\.\n", async path => {
    await assertBolterRestoreDumpAllowed(path);
  });
  await withDump(schema + "COPY public.bolter_connections (id) FROM stdin;\nsynthetic-row\n\\.\n", async path => {
    await Promise.resolve(expect(assertBolterRestoreDumpAllowed(path)).rejects.toThrow("Restore of populated Bolter"));
  });
});
test("quoted identifier case remains distinct from canonical table names", async () => {
  await withDump('COPY "PUBLIC"."BOLTER_CONNECTIONS" (id) FROM stdin;\nsynthetic-row\n\\.\n', async path => {
    await assertBolterRestoreDumpAllowed(path);
  });
});
test("rejects a truncated schema body before it can hide subsequent data", async () => {
  await withDump("CREATE FUNCTION public.example() RETURNS void LANGUAGE plpgsql AS $function$\nCOPY public.bolter_connections (id) FROM stdin;\nsynthetic-row\n\\.\n", async path => {
    await Promise.resolve(expect(restoreFromGzip(path, () => { throw new Error("Restore already began"); },
      { fullArchive: { expectedMigrationLineage: [] } })).rejects.toThrow("unterminated function body"));
  });
});
