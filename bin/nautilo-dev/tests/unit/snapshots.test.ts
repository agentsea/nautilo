import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { gzipSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectSnapshotTables,
  summarizeSnapshot,
  listSnapshots,
  parsePgDumpIdentifier,
} from "../../src/lib/snapshots";
import { formatBytes } from "../../src/lib/format-bytes";

/**
 * Create a fake `~/.nautilo/dev-snapshots/` under a tmp `$HOME`, and
 * verify the streaming COPY-block parser yields the row counts we expect.
 */

describe("snapshots — inspect and list", () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "nautilo-snapshots-test-"));
  const envBeforeHome = process.env["HOME"];
  const envBeforeInstance = process.env["NAUTILO_INSTANCE_ID"];

  beforeAll(() => {
    process.env["HOME"] = tmpRoot;
    delete process.env["NAUTILO_HOME"];
    delete process.env["NAUTILO_INSTANCE_ID"];

    const dumpText = [
      "-- sample dump",
      "SET client_encoding = 'UTF8';",
      "",
      "COPY public.users (id, name) FROM stdin;",
      "user-1\tAlice",
      "user-2\tBob",
      "user-3\tCarol",
      "\\.",
      "",
      "COPY public.memories (id, content) FROM stdin;",
      "mem-1\tHello",
      "\\.",
      "",
    ].join("\n");

    const snapDir = join(tmpRoot, ".nautilo", "dev-snapshots", "sample");
    mkdirSync(snapDir, { recursive: true });
    writeFileSync(join(snapDir, "database.sql.gz"), gzipSync(Buffer.from(dumpText, "utf8")));
    writeFileSync(
      join(snapDir, "meta.json"),
      JSON.stringify({
        name: "sample",
        createdAt: "2026-04-24T10:00:00.000Z",
        dbSizeBytes: 1024,
        envKeyCount: 14,
      }),
    );
    writeFileSync(join(snapDir, "dot-env"), "KEY=value\n");
    writeFileSync(join(snapDir, "nautilo-home.tar.gz"), gzipSync(Buffer.from("fake-tar", "utf8")));

    const basebackupDir = join(tmpRoot, ".nautilo", "dev-snapshots", "physical");
    mkdirSync(basebackupDir, { recursive: true });
    writeFileSync(join(basebackupDir, "basebackup.tar.gz"), gzipSync(Buffer.from("fake-basebackup", "utf8")));
    writeFileSync(
      join(basebackupDir, "meta.json"),
      JSON.stringify({
        name: "physical",
        createdAt: "2026-04-25T10:00:00.000Z",
        backupMode: "basebackup",
        dbSizeBytes: 2048,
        envKeyCount: 14,
      }),
    );

    // Also create a safety backup (should be ignored by listSnapshots)
    writeFileSync(join(tmpRoot, ".nautilo", "dev-snapshots", "_env-safety-backup"), "# safety\n");
  });

  afterAll(() => {
    if (envBeforeHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = envBeforeHome;
    if (envBeforeInstance === undefined) delete process.env["NAUTILO_INSTANCE_ID"];
    else process.env["NAUTILO_INSTANCE_ID"] = envBeforeInstance;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("summarizeSnapshot reads meta + db size", async () => {
    const s = await summarizeSnapshot("sample");
    expect(s).not.toBeNull();
    expect(s!.name).toBe("sample");
    expect(s!.createdAt).toBe("2026-04-24T10:00:00.000Z");
    expect(s!.envKeyCount).toBe(14);
    expect(s!.dbSizeBytes).toBeGreaterThan(0);
  });

  test("summarizeSnapshot reads physical basebackup metadata", async () => {
    const s = await summarizeSnapshot("physical");
    expect(s).not.toBeNull();
    expect(s!.backupMode).toBe("basebackup");
    expect(s!.dbSizeBytes).toBeGreaterThan(0);
  });

  test("summarizeSnapshot returns null for unknown name", async () => {
    const s = await summarizeSnapshot("does-not-exist");
    expect(s).toBeNull();
  });

  test("inspectSnapshotTables streams COPY blocks and counts rows", async () => {
    const tables = await inspectSnapshotTables("sample");
    expect(tables).toHaveLength(2);

    const users = tables.find((t) => t.table === "users");
    expect(users).toBeDefined();
    expect(users!.rowCount).toBe(3);
    expect(users!.columns).toEqual(["id", "name"]);

    const memories = tables.find((t) => t.table === "memories");
    expect(memories).toBeDefined();
    expect(memories!.rowCount).toBe(1);
  });

  test("listSnapshots ignores _-prefixed safety-backup files", async () => {
    const list = await listSnapshots();
    const names = list.map((s) => s.name);
    expect(names).toContain("sample");
    expect(names).toContain("physical");
    expect(names).not.toContain("_env-safety-backup");
  });
});

describe("formatBytes", () => {
  test("does not render small gzipped DB dumps as 0.0 MB", () => {
    expect(formatBytes(45 * 1024)).toBe("45 KB");
  });

  test("uses MB for large dumps", () => {
    expect(formatBytes(Math.round(1.5 * 1024 * 1024))).toBe("1.5 MB");
  });
});

describe("parsePgDumpIdentifier", () => {
  test("normalizes reserved and escaped quoted identifiers", () => {
    expect(parsePgDumpIdentifier(' "position" ')).toBe("position");
    expect(parsePgDumpIdentifier('"a""b"')).toBe('a"b');
    expect(parsePgDumpIdentifier("ordinary_column")).toBe("ordinary_column");
  });
});
