import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BackendStat, BackendWriteOptions, FileBackend } from "../../src/tools/file/backend";
import * as backups from "../../src/tools/file/backups";
import { applyEphemeralPatch } from "../../src/tools/file/commands/apply-core";
import { handleInsert } from "../../src/tools/file/commands/insert";
import { handleStrReplace } from "../../src/tools/file/commands/str-replace";
import { handleWrite } from "../../src/tools/file/commands/write";
import { findFragmentRange, findOldStringMatches } from "../../src/tools/file/matching";
import { constructPatch, sha256Hex } from "../../src/tools/file/staged-patches";

let TMP_ROOT: string;
const restores: Array<() => void> = [];

const FAKE_CTX = {
  zoneCtx: { workspaceRoot: "", currentFolder: null },
  ownerId: "test-owner",
  agentId: "agent-1",
  turnId: "test-turn",
};

function absResolution(filePath: string) {
  return { resolved: filePath, resolvedZone: "absolute" as const };
}

function currentResolution(filePath: string) {
  return { resolved: filePath, resolvedZone: "current" as const };
}

function parseApplied(result: string) {
  const parsed = JSON.parse(result) as {
    applied?: boolean;
    revisionId?: string;
    path: string;
    command: string;
    summary: string;
    unifiedDiff: string;
    stats: { additions: number; deletions: number };
  };
  if (parsed.applied !== true) throw new Error(`expected applied envelope, got: ${result}`);
  return parsed;
}

beforeAll(async () => {
  TMP_ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), "nautilo-write-handlers-test-"));
});

afterAll(async () => {
  if (TMP_ROOT) await fsp.rm(TMP_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  let i = 0;
  const sp = spyOn(backups, "recordRevision").mockImplementation(async (input) => ({
    ok: true,
    lane: "hot",
    revisionId: `rev-${input.operation}-${++i}`,
    diffBytes: 1,
  }));
  restores.push(() => sp.mockRestore());
});

afterEach(() => {
  while (restores.length) restores.pop()!();
});

describe("handleWrite", () => {
  test("new file applies immediately, returns revisionId, and records create", async () => {
    const targetPath = path.join(TMP_ROOT, `write-${Date.now()}-${Math.random()}.txt`);
    const out = await handleWrite(
      { command: "write", path: "x", zone: "absolute", content: "hello" },
      absResolution(targetPath),
      FAKE_CTX,
    );
    const env = parseApplied(out);
    expect(env.command).toBe("write");
    expect(env.revisionId).toBe("rev-create-1");
    expect(env.summary).toMatch(/Applied write/);
    expect(await fsp.readFile(targetPath, "utf-8")).toBe("hello");
  });

  test("existing empty file records write, not create, and undo target remains a file", async () => {
    const targetPath = path.join(TMP_ROOT, `empty-${Date.now()}-${Math.random()}.txt`);
    await fsp.writeFile(targetPath, "");
    const out = await handleWrite(
      { command: "write", path: "x", zone: "absolute", content: "now non-empty" },
      absResolution(targetPath),
      FAKE_CTX,
    );
    const env = parseApplied(out);
    expect(env.revisionId).toBe("rev-write-1");
    expect(await fsp.readFile(targetPath, "utf-8")).toBe("now non-empty");
  });

  test("append and prepend apply against current bytes", async () => {
    const targetPath = path.join(TMP_ROOT, `append-${Date.now()}-${Math.random()}.txt`);
    await fsp.writeFile(targetPath, "middle\n");
    await handleWrite(
      { command: "write", path: "x", zone: "absolute", content: "end\n", mode: "append" },
      absResolution(targetPath),
      FAKE_CTX,
    );
    await handleWrite(
      { command: "write", path: "x", zone: "absolute", content: "start\n", mode: "prepend" },
      absResolution(targetPath),
      FAKE_CTX,
    );
    expect(await fsp.readFile(targetPath, "utf-8")).toBe("start\nmiddle\nend\n");
  });

  test("external-change guard returns drift error and leaves file unchanged", async () => {
    const targetPath = path.join(TMP_ROOT, `drift-${Date.now()}-${Math.random()}.txt`);
    const originalBytes = Buffer.from("original\n");
    await fsp.writeFile(targetPath, originalBytes);
    const patch = constructPatch({
      turnId: FAKE_CTX.turnId,
      ownerId: FAKE_CTX.ownerId,
      path: targetPath,
      zone: "absolute",
      zoneCtx: FAKE_CTX.zoneCtx,
      originalBytes,
      originalSha256: sha256Hex(originalBytes),
      newBytes: Buffer.from("agent\n"),
      unifiedDiff: "drift diff\n",
      metadata: { command: "write", args: { path: "x", zone: "absolute" } },
    });
    await fsp.writeFile(targetPath, "user\n");
    const result = await applyEphemeralPatch(patch, FAKE_CTX);
    expect(result.text).toMatch(/file changed on disk/);
    expect(await fsp.readFile(targetPath, "utf-8")).toBe("user\n");
  });

  test("current-zone overwrite derives an anchored edit and rebases over non-overlap drift", async () => {
    const targetPath = path.join(TMP_ROOT, "current-rebase.txt");
    const base = Buffer.from("alpha\nbeta\ngamma\n");
    const drifted = Buffer.from("alpha\nbeta\ngamma\ndelta\n");
    let readCount = 0;
    let written = "";
    let writeOpts: BackendWriteOptions | undefined;
    const statDate = new Date();
    const fileStat = {
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      size: base.byteLength,
      mtime: statDate,
      birthtime: statDate,
      mode: 0o644,
    } satisfies BackendStat;
    const backend: FileBackend = {
      readFile: async () => (readCount++ < 2 ? base : drifted),
      writeFileAtomic: async (_p, data, opts) => {
        written = data.toString("utf8");
        writeOpts = opts;
      },
      readdir: async () => [],
      stat: async () => fileStat,
      lstat: async () => fileStat,
      mkdir: async () => {},
      rename: async () => {},
      unlink: async () => {},
      rm: async () => {},
      cp: async () => {},
      realpath: async (p) => p,
    };

    const out = await handleWrite(
      { command: "write", path: "x", zone: "current", content: "alpha\nBETA\ngamma\n" },
      currentResolution(targetPath),
      {
        ...FAKE_CTX,
        backend,
        zoneCtx: { ...FAKE_CTX.zoneCtx, currentFolder: TMP_ROOT },
      },
    );
    const env = parseApplied(out);

    expect(env.command).toBe("write");
    expect(written).toBe("alpha\nBETA\ngamma\ndelta\n");
    expect(writeOpts?.changeEvent?.changedPath).toBe(targetPath);
    expect(writeOpts?.changeEvent?.patchEvent?.target.kind).toBe("currentFile");
    expect(writeOpts?.changeEvent?.patchEvent?.patch.oldString).toContain("beta");
    expect(writeOpts?.changeEvent?.patchEvent?.rebased).toBe(true);
  });
});

describe("handleInsert and handleStrReplace", () => {
  test("insert applies immediately", async () => {
    const targetPath = path.join(TMP_ROOT, `insert-${Date.now()}-${Math.random()}.txt`);
    await fsp.writeFile(targetPath, "line1\nline3\n");
    const out = await handleInsert(
      { command: "insert", path: "x", zone: "absolute", lineNumber: 2, content: "line2" },
      absResolution(targetPath),
      FAKE_CTX,
    );
    const env = parseApplied(out);
    expect(env.command).toBe("insert");
    expect(await fsp.readFile(targetPath, "utf-8")).toBe("line1\nline2\nline3\n");
  });

  test("str_replace applies immediately and diff matches disk change", async () => {
    const targetPath = path.join(TMP_ROOT, `replace-${Date.now()}-${Math.random()}.txt`);
    await fsp.writeFile(targetPath, "hello world\n");
    const out = await handleStrReplace(
      { command: "str_replace", path: "x", zone: "absolute", oldString: "world", newString: "there" },
      absResolution(targetPath),
      FAKE_CTX,
    );
    const env = parseApplied(out);
    expect(env.unifiedDiff).toContain("-hello world");
    expect(env.unifiedDiff).toContain("+hello there");
    expect(await fsp.readFile(targetPath, "utf-8")).toBe("hello there\n");
  });

  test("validation errors remain clear", async () => {
    const targetPath = path.join(TMP_ROOT, `validation-${Date.now()}-${Math.random()}.txt`);
    await fsp.writeFile(targetPath, "foo foo\n");
    const out = await handleStrReplace(
      { command: "str_replace", path: "x", zone: "absolute", oldString: "foo", newString: "bar" },
      absResolution(targetPath),
      FAKE_CTX,
    );
    expect(out).toMatch(/oldString not unique/);
  });
});

describe("matching helpers", () => {
  test("findOldStringMatches counts scoped matches", () => {
    const r = findOldStringMatches("foo bar foo", "foo", 4, 11);
    expect(r.count).toBe(1);
    expect(r.firstOffset).toBe(8);
  });

  test("findFragmentRange handles exact bookends", () => {
    const r = findFragmentRange({ haystack: "foo bar baz", startFragment: "foo", endFragment: "baz", normalize: "safe" });
    expect(r.ok).toBe(true);
  });
});
