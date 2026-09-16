import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { extractCopyBlocksStreaming } from "../../src/lib/docker-db";

/**
 * Regression for the multi-GB restore OOM: a full dogfood dump
 * decompresses past V8/Bun's ~2.1 GB max string length (the
 * `langchain`-schema checkpoint blobs dominate), so the old
 * `gunzip().toString()` threw before extracting anything.
 *
 * extractCopyBlocksStreaming reads line-by-line off the decompression
 * stream and buffers ONLY the requested `public.*` blocks. This test
 * proves it: (a) captures wanted tables with correct row content,
 * (b) ignores non-wanted + non-public tables, and (c) is not fooled by a
 * literal "COPY public.users (" embedded inside another table's row.
 */
describe("extractCopyBlocksStreaming", () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "nautilo-stream-test-"));

  const dumpText = [
    "SET client_encoding = 'UTF8';",
    "",
    // A wanted table whose row body embeds a fake header mid-line.
    "COPY public.session_messages (id, content) FROM stdin;",
    "m1\tI read COPY public.users (id, name) FROM stdin in the source",
    "m2\tsecond message",
    "\\.",
    "",
    // A NON-wanted public table — must be skipped.
    "COPY public.audit_log (id, blob) FROM stdin;",
    "x1\tnoise",
    "\\.",
    "",
    // A non-public schema (LangGraph) — must be skipped (this is the GB hog).
    "COPY langchain.checkpoints (id, state) FROM stdin;",
    "c1\thuge-blob",
    "\\.",
    "",
    // A wanted table after the noise.
    "COPY public.users (id, name) FROM stdin;",
    "u1\tAlice",
    "u2\tBob",
    "\\.",
    "",
  ].join("\n");

  const gzPath = join(tmpRoot, "database.sql.gz");
  writeFileSync(gzPath, gzipSync(Buffer.from(dumpText, "utf8")));

  test("captures only the requested public tables, line-anchored", async () => {
    const want = new Set(["public.session_messages", "public.users"]);
    const blocks = await extractCopyBlocksStreaming(gzPath, want);

    expect([...blocks.keys()].sort()).toEqual([
      "public.session_messages",
      "public.users",
    ]);

    // Fake embedded header did NOT split the session_messages block.
    const sm = blocks.get("public.session_messages")!;
    expect(sm).toBe(
      "COPY public.session_messages (id, content) FROM stdin;\n" +
        "m1\tI read COPY public.users (id, name) FROM stdin in the source\n" +
        "m2\tsecond message\n" +
        "\\.\n",
    );

    const users = blocks.get("public.users")!;
    expect(users).toBe(
      "COPY public.users (id, name) FROM stdin;\nu1\tAlice\nu2\tBob\n\\.\n",
    );
  });

  test("returns nothing when no requested table is present", async () => {
    const blocks = await extractCopyBlocksStreaming(
      gzPath,
      new Set(["public.does_not_exist"]),
    );
    expect(blocks.size).toBe(0);
  });

  process.on("exit", () => rmSync(tmpRoot, { recursive: true, force: true }));
});
