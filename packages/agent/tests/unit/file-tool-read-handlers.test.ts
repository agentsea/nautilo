/**
 * D079 Phase 4 / G3 commit 6 — read-family handler tests (list,
 * read, stat). Native glob/grep have dedicated D446 runner/host tests.
 *
 * These hit the real fs (via a scoped temp dir) rather than
 * mocking fs/promises. Rationale: the handlers are thin wrappers
 * around `fsp.*` calls; mocking fsp would basically test the
 * mocking library. Real fs in a temp dir tests the actual shape
 * of the calls + error paths (ENOENT, ENOTDIR, EISDIR, EACCES).
 *
 * Cleanup: each suite creates a tmp dir in `setup` and rm-rf's in
 * `cleanup` (matches bun test's beforeAll/afterAll pattern).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { TextWindow } from "@nautilo/relay";
import { createFileTool } from "../../src/tools/file/file-tool";
import { handleList } from "../../src/tools/file/commands/list";
import { handleRead } from "../../src/tools/file/commands/read";
import { handleStat } from "../../src/tools/file/commands/stat";

// Narrow JSON-parse helpers so the test bodies don't fight
// eslint's no-unsafe-member-access rule on bare `any`.
interface StatOutput {
  type: string;
  size?: number;
  modified: string;
}
interface ListOutput {
  entries: Array<{ name: string; path: string; type: string; size?: number }>;
  truncated?: boolean;
  limit?: number;
}
function parseJson<T>(s: unknown): T {
  if (typeof s !== "string") throw new Error("expected JSON text");
  return JSON.parse(s) as T;
}

let TMP_ROOT: string;

const FAKE_CTX = { zoneCtx: { workspaceRoot: "", currentFolder: null }, ownerId: "test-owner" };

beforeAll(async () => {
  TMP_ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), "nautilo-file-tool-test-"));
  // Create the test tree:
  //   TMP_ROOT/
  //     hello.txt           (small text)
  //     empty.txt           (zero bytes)
  //     subdir/
  //       inner.md          (contains "TODO: finish this")
  //       binary.bin        (contains null byte)
  //     big.txt             (2500 lines)
  //     codebase/
  //       src/
  //         app.ts          (contains "export function main()")
  //         app.test.ts     (contains "describe('main')")
  //       node_modules/     (used by recursive-list filtering fixtures)
  //         ignored.ts
  await fsp.writeFile(path.join(TMP_ROOT, "hello.txt"), "Hello, world!\n");
  await fsp.writeFile(path.join(TMP_ROOT, "empty.txt"), "");
  await fsp.mkdir(path.join(TMP_ROOT, "subdir"), { recursive: true });
  await fsp.writeFile(path.join(TMP_ROOT, "subdir/inner.md"), "# Inner\n\nTODO: finish this\n");
  // Binary file — 128 bytes with a null in the middle.
  const bin = Buffer.concat([Buffer.from("header"), Buffer.from([0, 1, 2]), Buffer.alloc(119)]);
  await fsp.writeFile(path.join(TMP_ROOT, "subdir/binary.bin"), bin);
  // Big file — 2500 lines for truncation tests
  const bigLines = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`);
  await fsp.writeFile(path.join(TMP_ROOT, "big.txt"), bigLines.join("\n"));
  // Grep tree
  await fsp.mkdir(path.join(TMP_ROOT, "codebase/src"), { recursive: true });
  await fsp.writeFile(
    path.join(TMP_ROOT, "codebase/src/app.ts"),
    "export function main() {\n  return 42;\n}\n",
  );
  await fsp.writeFile(
    path.join(TMP_ROOT, "codebase/src/app.test.ts"),
    "describe('main', () => {\n  test('returns 42', () => {});\n});\n",
  );
  await fsp.mkdir(path.join(TMP_ROOT, "codebase/node_modules"), { recursive: true });
  await fsp.writeFile(
    path.join(TMP_ROOT, "codebase/node_modules/ignored.ts"),
    "export function main() { /* should be skipped */ }\n",
  );
});

afterAll(async () => {
  if (TMP_ROOT) await fsp.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("handleStat", () => {
  test("returns metadata for a file", async () => {
    const out = await handleStat(
      { command: "stat", path: "hello.txt", zone: "absolute" },
      { resolved: path.join(TMP_ROOT, "hello.txt"), resolvedZone: "absolute" },
      FAKE_CTX,
    );
    const parsed = parseJson<StatOutput>(out);
    expect(parsed.type).toBe("file");
    expect(parsed.size).toBe(14); // "Hello, world!\n"
    expect(parsed.modified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("returns metadata for a directory", async () => {
    const out = await handleStat(
      { command: "stat", path: "subdir", zone: "absolute" },
      { resolved: path.join(TMP_ROOT, "subdir"), resolvedZone: "absolute" },
      FAKE_CTX,
    );
    const parsed = parseJson<StatOutput>(out);
    expect(parsed.type).toBe("directory");
  });

  test("missing file → ENOENT error", async () => {
    const out = await handleStat(
      { command: "stat", path: "nope.txt", zone: "absolute" },
      { resolved: path.join(TMP_ROOT, "nope.txt"), resolvedZone: "absolute" },
      FAKE_CTX,
    );
    expect(out).toMatch(/file not found/);
  });
});

describe("handleList", () => {
  test("flat listing returns directory entries", async () => {
    const out = await handleList(
      { command: "list", path: ".", zone: "absolute" },
      { resolved: TMP_ROOT, resolvedZone: "absolute" },
      FAKE_CTX,
    );
    const parsed = parseJson<ListOutput>(out);
    const names = parsed.entries.map((e: { name: string }) => e.name);
    expect(names).toContain("hello.txt");
    expect(names).toContain("empty.txt");
    expect(names).toContain("subdir");
    expect(names).toContain("big.txt");
    expect(names).toContain("codebase");
  });

  test("directories sort first (alpha within type)", async () => {
    const out = await handleList(
      { command: "list", path: ".", zone: "absolute" },
      { resolved: TMP_ROOT, resolvedZone: "absolute" },
      FAKE_CTX,
    );
    const parsed = parseJson<ListOutput>(out);
    const types = parsed.entries.map((e: { type: string }) => e.type);
    // Find first 'file' index — everything before must be 'directory'.
    const firstFileIdx = types.indexOf("file");
    for (let i = 0; i < firstFileIdx; i++) {
      expect(types[i]).toBe("directory");
    }
  });

  test("recursive listing includes nested content", async () => {
    const out = await handleList(
      { command: "list", path: ".", zone: "absolute", recursive: true },
      { resolved: TMP_ROOT, resolvedZone: "absolute" },
      FAKE_CTX,
    );
    const parsed = parseJson<ListOutput>(out);
    const names = parsed.entries.map((e: { name: string }) => e.name);
    expect(names).toContain("inner.md");
    expect(names).toContain("app.ts");
  });

  test("glob filter narrows results", async () => {
    const out = await handleList(
      { command: "list", path: ".", zone: "absolute", recursive: true, glob: "*.md" },
      { resolved: TMP_ROOT, resolvedZone: "absolute" },
      FAKE_CTX,
    );
    const parsed = parseJson<ListOutput>(out);
    for (const e of parsed.entries) {
      expect(e.name).toMatch(/\.md$/);
    }
  });

  test("glob during walk finds matches beyond the old pre-filter entry cap (D272)", async () => {
    const globDir = path.join(TMP_ROOT, "glob-cap-test");
    await fsp.mkdir(globDir, { recursive: true });
    // Fill past the old 1000-entry walk cap with non-matching files.
    for (let i = 0; i < 1001; i++) {
      await fsp.writeFile(path.join(globDir, `filler-${String(i).padStart(4, "0")}.txt`), "x\n");
    }
    await fsp.writeFile(path.join(globDir, "target-match.md"), "# match\n");

    const out = await handleList(
      {
        command: "list",
        path: ".",
        zone: "absolute",
        recursive: true,
        glob: "*.md",
        limit: 20000,
      },
      { resolved: globDir, resolvedZone: "absolute" },
      FAKE_CTX,
    );
    const parsed = parseJson<ListOutput>(out);
    const names = parsed.entries.map((e) => e.name);
    expect(names).toContain("target-match.md");
    expect(parsed.truncated).toBe(false);
  });

  test("limit caps results and sets truncated (D272)", async () => {
    const limitDir = path.join(TMP_ROOT, "limit-test");
    await fsp.mkdir(limitDir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      await fsp.writeFile(path.join(limitDir, `item-${i}.txt`), "x\n");
    }

    const out = await handleList(
      { command: "list", path: ".", zone: "absolute", limit: 2 },
      { resolved: limitDir, resolvedZone: "absolute" },
      FAKE_CTX,
    );
    const parsed = parseJson<ListOutput>(out);
    expect(parsed.entries.length).toBe(2);
    expect(parsed.limit).toBe(2);
    expect(parsed.truncated).toBe(true);
  });

  test("missing directory → ENOENT error", async () => {
    const out = await handleList(
      { command: "list", path: "nope", zone: "absolute" },
      { resolved: path.join(TMP_ROOT, "nope"), resolvedZone: "absolute" },
      FAKE_CTX,
    );
    expect(out).toMatch(/directory not found/);
  });

  test("listing a file → ENOTDIR error", async () => {
    const out = await handleList(
      { command: "list", path: "hello.txt", zone: "absolute" },
      { resolved: path.join(TMP_ROOT, "hello.txt"), resolvedZone: "absolute" },
      FAKE_CTX,
    );
    expect(out).toMatch(/not a directory/);
  });
});

describe("handleRead", () => {
  test("reads small file fully", async () => {
    const out = await handleRead(
      { command: "read", path: "hello.txt", zone: "absolute" },
      { resolved: path.join(TMP_ROOT, "hello.txt"), resolvedZone: "absolute" },
      FAKE_CTX,
    );
    expect(out).toContain("Hello, world!");
    expect(parseJson<TextWindow>(out)).toMatchObject({ content: "Hello, world!\n", startByte: 0, endByte: 14, startLine: 1, endLine: 1, nextCursor: null, nextLineOffset: null });
  });

  test("empty file returns an empty byte window", async () => {
    const out = await handleRead(
      { command: "read", path: "empty.txt", zone: "absolute" },
      { resolved: path.join(TMP_ROOT, "empty.txt"), resolvedZone: "absolute" },
      FAKE_CTX,
    );
    expect(parseJson<TextWindow>(out)).toMatchObject({ content: "", startByte: 0, endByte: 0, endLine: 0, nextCursor: null });
  });

  test("default line window includes an explicit next line offset", async () => {
    const out = await handleRead(
      { command: "read", path: "big.txt", zone: "absolute" },
      { resolved: path.join(TMP_ROOT, "big.txt"), resolvedZone: "absolute" },
      FAKE_CTX,
    );
    expect(parseJson<TextWindow>(out)).toMatchObject({ startLine: 1, endLine: 2000, nextCursor: null, nextLineOffset: 2001 });
  });

  test("offset + limit returns a specific window", async () => {
    const out = await handleRead(
      { command: "read", path: "big.txt", zone: "absolute", offset: 500, limit: 3 },
      { resolved: path.join(TMP_ROOT, "big.txt"), resolvedZone: "absolute" },
      FAKE_CTX,
    );
    expect(out).toContain("line 500");
    expect(out).toContain("line 501");
    expect(out).toContain("line 502");
    expect(parseJson<TextWindow>(out)).toMatchObject({ content: "line 500\nline 501\nline 502\n", startLine: 500, endLine: 502, nextLineOffset: 503 });
  });

  test("inclusive lineRange takes precedence over provider offset and limit drift", async () => {
    const out = await handleRead(
      {
        command: "read",
        path: "big.txt",
        zone: "absolute",
        offset: 1,
        limit: 1,
        lineRange: { from: 200, to: 230 },
      },
      { resolved: path.join(TMP_ROOT, "big.txt"), resolvedZone: "absolute" },
      FAKE_CTX,
    );
    expect(out).toContain("line 200");
    expect(out).toContain("line 230");
    expect(out).not.toContain("line 199");
    expect(parseJson<TextWindow>(out)).toMatchObject({ startLine: 200, endLine: 230, nextLineOffset: 231 });
  });

  test("binary file returns a clear error (no garbled UTF-8)", async () => {
    const out = await handleRead(
      { command: "read", path: "subdir/binary.bin", zone: "absolute" },
      { resolved: path.join(TMP_ROOT, "subdir/binary.bin"), resolvedZone: "absolute" },
      FAKE_CTX,
    );
    expect(out).toMatch(/appears to be a binary file/);
  });

  test("closed Office binary points to OfficeCLI text view", async () => {
    const out = await handleRead(
      { command: "read", path: "report.docx", zone: "workspace" },
      { resolved: path.join(TMP_ROOT, "subdir/binary.bin"), resolvedZone: "workspace" },
      FAKE_CTX,
    );
    expect(out).toContain("officecli");
    expect(out).toContain("command='view'");
    expect(out).toContain("mode='text'");
  });

  test("directory read returns EISDIR", async () => {
    const out = await handleRead(
      { command: "read", path: "subdir", zone: "absolute" },
      { resolved: path.join(TMP_ROOT, "subdir"), resolvedZone: "absolute" },
      FAKE_CTX,
    );
    expect(out).toMatch(/is a directory/);
  });

  test("missing file returns ENOENT error", async () => {
    const out = await handleRead(
      { command: "read", path: "nope.txt", zone: "absolute" },
      { resolved: path.join(TMP_ROOT, "nope.txt"), resolvedZone: "absolute" },
      FAKE_CTX,
    );
    expect(out).toMatch(/file not found/);
  });
});

describe("file tool description — native search boundary", () => {
  test("glob/grep are Desktop-local and Workspace guidance uses artifact commands", () => {
    const tool = createFileTool();
    const desc = tool.description;
    expect(desc).toMatch(/list:.*limit/);
    expect(desc).toMatch(/truncated/);
    expect(desc).toMatch(/glob:.*native ripgrep/i);
    expect(desc).toMatch(/grep:.*native ripgrep/i);
    expect(desc).toContain("Workspace returns unsupported_zone");
    expect(desc).toContain("file.list");
    expect(desc).toContain("file.read");
    expect(desc).toContain("Workspace full-text search is unavailable");
    expect(desc).toMatch(/read.*offset\/limit/);
    expect(desc).toContain("omit path to list the Workspace root");
    expect(desc).toContain("never pass an empty string");
    expect(desc).toContain("use officecli view");
  });
});

describe("D580 directory discovery continuation", () => {
  test("pages unchanged directories and rejects a changed inventory", async () => {
    const dir = await fsp.mkdtemp(path.join(TMP_ROOT, "pages-"));
    for (const name of ["a.ts", "b.ts", "c.ts"]) await fsp.writeFile(path.join(dir, name), "source");
    const args = { command: "list" as const, path: ".", zone: "absolute" as const, limit: 1 };
    const resolution = { resolved: dir, resolvedZone: "absolute" as const };
    type Page = { entries: Array<{ name: string }>; nextCursor: string | null; complete: boolean; totalCount: number };
    const first = parseJson<Page>(await handleList(args, resolution, FAKE_CTX));
    expect(first).toMatchObject({ entries: [{ name: "a.ts" }], complete: false, totalCount: 3 });
    const second = parseJson<Page>(await handleList({ ...args, discoveryCursor: first.nextCursor! }, resolution, FAKE_CTX));
    expect(second.entries.map((entry) => entry.name)).toEqual(["b.ts"]);
    const last = parseJson<Page>(await handleList({ ...args, discoveryCursor: second.nextCursor! }, resolution, FAKE_CTX));
    expect(last).toMatchObject({ entries: [{ name: "c.ts" }], nextCursor: null, complete: true });
    await fsp.writeFile(path.join(dir, "d.ts"), "new");
    expect(await handleList({ ...args, discoveryCursor: first.nextCursor! }, resolution, FAKE_CTX)).toContain("Discovery results changed");
  });

  test("explicit depth and symlink omissions are recoverable entries, not exhaustive results", async () => {
    const dir = await fsp.mkdtemp(path.join(TMP_ROOT, "depth-"));
    await fsp.mkdir(path.join(dir, "nested"));
    await fsp.writeFile(path.join(dir, "nested", "source.ts"), "source");
    await fsp.symlink(path.join(dir, "nested"), path.join(dir, "link"));
    const result = parseJson<Record<string, unknown>>(await handleList({ command: "list", path: ".", zone: "absolute", recursive: true, depth: 0 }, { resolved: dir, resolvedZone: "absolute" }, FAKE_CTX));
    expect(result).toMatchObject({ complete: false, nextCursor: null,
      entries: [{ name: "link", descendants: "symlink" }, { name: "nested", descendants: "depth_limit" }],
      incompleteReasons: [{ reason: "depth_limit", count: 1 }, { reason: "symlink", count: 1 }] });
  });
});
