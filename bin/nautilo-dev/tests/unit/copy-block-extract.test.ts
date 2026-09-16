import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { inspectSnapshotTables } from "../../src/lib/snapshots";

/**
 * Regression test for extractCopyBlock false-positive matching.
 *
 * A naive `indexOf("COPY public.foo (")` will also match that literal
 * substring embedded inside another table's row data. pg_dump escapes
 * real newlines in content as `\n` (two chars), so `COPY public.foo (`
 * can appear mid-line in a row's content without triggering a new
 * COPY block — only a LINE-ANCHORED match should count.
 *
 * This test exercises inspectSnapshotTables (which uses the same
 * line-anchored streaming parser as extractCopyBlock) with a dump
 * whose session_messages body contains the literal text
 * "COPY public.users (" embedded in a row value. The real users
 * table comes later. The parser must still find BOTH tables' rows
 * correctly.
 */
describe("COPY-block extraction — line-anchored, not substring", () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "nautilo-copyblock-test-"));
  const envBeforeHome = process.env["HOME"];
  const envBeforeInstance = process.env["NAUTILO_INSTANCE_ID"];

  try {
    process.env["HOME"] = tmpRoot;
    delete process.env["NAUTILO_HOME"];
    delete process.env["NAUTILO_INSTANCE_ID"];

    const snapDir = join(tmpRoot, ".nautilo", "dev-snapshots", "copy-block-regression");
    mkdirSync(snapDir, { recursive: true });

    // session_messages has a row whose `content` column embeds the
    // literal text `COPY public.users (` mid-line. The users table
    // comes AFTER. A naive indexOf would latch onto the fake "header"
    // first and break.
    const dumpText = [
      "SET client_encoding = 'UTF8';",
      "",
      "COPY public.session_messages (id, content) FROM stdin;",
      "msg-1\tI was reading the dev-tool source which had COPY public.users (id, name) FROM stdin in it",
      "msg-2\tsecond message",
      "\\.",
      "",
      "COPY public.users (id, name) FROM stdin;",
      "user-1\tAlice",
      "user-2\tBob",
      "\\.",
      "",
    ].join("\n");

    writeFileSync(join(snapDir, "database.sql.gz"), gzipSync(Buffer.from(dumpText, "utf8")));
    writeFileSync(
      join(snapDir, "meta.json"),
      JSON.stringify({ name: "copy-block-regression" }),
    );

    test("inspectSnapshotTables only recognises line-start COPY headers", async () => {
      const tables = await inspectSnapshotTables("copy-block-regression");
      const names = tables.map((t) => t.table);
      expect(names).toContain("session_messages");
      expect(names).toContain("users");

      const session = tables.find((t) => t.table === "session_messages");
      expect(session!.rowCount).toBe(2);

      const users = tables.find((t) => t.table === "users");
      expect(users!.rowCount).toBe(2);
    });
  } finally {
    // afterAll-style cleanup outside bun test hooks:
    process.on("exit", () => {
      if (envBeforeHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = envBeforeHome;
      if (envBeforeInstance === undefined) delete process.env["NAUTILO_INSTANCE_ID"];
      else process.env["NAUTILO_INSTANCE_ID"] = envBeforeInstance;
      rmSync(tmpRoot, { recursive: true, force: true });
    });
  }
});
