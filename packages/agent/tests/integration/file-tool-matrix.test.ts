/**
 * M067D Phase 3.1 — table-driven happy-path coverage for the ten D079
 * `file` commands through `dispatchFileCommand` (same entry as production).
 * No Postgres; tmpdir + in-memory staged-patch store only.
 */

// Post-M088B, zone: "workspace" requires a real MemoryAccessEnvelope and
// artifact DB rows — not a tmpdir root. These tests preserve their original
// filesystem intent (D079 command matrix) by using zone: "absolute" against
// the same workspace tmpdir. Workspace-artifact dispatch is covered separately
// by file-tool-workspace-artifact.integration.test.ts.

import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dispatchFileCommand, type DispatchContext } from "../../src/tools/file/dispatch";
import { expectDispatchString } from "../helpers/dispatch-string";
import type { FileToolRawArgs } from "../../src/tools/file/schema";
import { FILE_TOOL_MATRIX_COVERED_COMMANDS } from "../file-tool-matrix-fixture";

let base: string;
let workspace: string;
let current: string;

function ctxForTurn(turnId: string): DispatchContext {
  return {
    zoneCtx: { workspaceRoot: workspace, currentFolder: current },
    ownerId: "file-matrix-owner",
    turnId,
  };
}

interface MatrixCase {
  name: string;
  args: () => FileToolRawArgs;
  setup?: () => Promise<void>;
  assert: (out: string) => Promise<void>;
}

async function assertLocalRelayRequired(out: string): Promise<void> {
  expect(JSON.parse(out)).toMatchObject({
    error: "local_relay_required",
    code: "local_relay_required",
  });
}

const MATRIX_CASES: MatrixCase[] = [
  {
    name: "list workspace top-level",
    setup: async () => {
      await fsp.writeFile(join(workspace, "matrix-list-a.txt"), "a", "utf-8");
    },
    args: () => ({ command: "list", path: workspace, zone: "absolute" }),
    assert: async (out) => {
      const parsed = JSON.parse(out) as { entries: Array<{ name: string }> };
      expect(parsed.entries.some((e) => e.name === "matrix-list-a.txt")).toBe(true);
    },
  },
  {
    name: "list current with glob filter",
    setup: async () => {
      await fsp.writeFile(join(current, "matrix-glob-only.txt"), "x", "utf-8");
      await fsp.writeFile(join(current, "other.txt"), "y", "utf-8");
    },
    args: () => ({ command: "list", path: ".", zone: "current", glob: "matrix-glob-*.txt" }),
    assert: async (out) => {
      const parsed = JSON.parse(out) as { entries: Array<{ name: string }>; count: number };
      expect(parsed.count).toBe(1);
      expect(parsed.entries[0]?.name).toBe("matrix-glob-only.txt");
    },
  },
  {
    name: "read utf8 from workspace",
    setup: async () => {
      await fsp.writeFile(join(workspace, "matrix-read.txt"), "line1\nline2\n", "utf-8");
    },
    args: () => ({ command: "read", path: join(workspace, "matrix-read.txt"), zone: "absolute" }),
    assert: async (out) => {
      expect(JSON.parse(out)).toMatchObject({
        command: "read",
        content: "line1\nline2\n",
      });
    },
  },
  {
    name: "read rejects binary with stat hint",
    setup: async () => {
      await fsp.writeFile(join(workspace, "matrix-bin.dat"), Buffer.from([0x00, 0xff, 0x42]));
    },
    args: () => ({ command: "read", path: join(workspace, "matrix-bin.dat"), zone: "absolute" }),
    assert: async (out) => {
      expect(out).toContain("binary file");
      expect(out).toContain("stat");
    },
  },
  {
    name: "stat file metadata",
    setup: async () => {
      await fsp.writeFile(join(workspace, "matrix-stat.txt"), "zzz", "utf-8");
    },
    args: () => ({ command: "stat", path: join(workspace, "matrix-stat.txt"), zone: "absolute" }),
    assert: async (out) => {
      const meta = JSON.parse(out) as { type: string; size: number };
      expect(meta.type).toBe("file");
      expect(meta.size).toBe(3);
    },
  },
  {
    name: "direct absolute write requires the local relay",
    args: () => ({
      command: "write",
      path: join(workspace, "matrix-new-write.txt"),
      zone: "absolute",
      content: "fresh bytes",
    }),
    assert: assertLocalRelayRequired,
  },
  {
    name: "direct absolute insert requires the local relay",
    setup: async () => {
      await fsp.writeFile(join(workspace, "matrix-insert.txt"), "A\nB\nC\n", "utf-8");
    },
    args: () => ({
      command: "insert",
      path: join(workspace, "matrix-insert.txt"),
      zone: "absolute",
      lineNumber: 2,
      content: "IN",
    }),
    assert: assertLocalRelayRequired,
  },
  {
    name: "direct absolute str_replace requires the local relay",
    setup: async () => {
      await fsp.writeFile(join(workspace, "matrix-sr.txt"), "hello world\n", "utf-8");
    },
    args: () => ({
      command: "str_replace",
      path: join(workspace, "matrix-sr.txt"),
      zone: "absolute",
      oldString: "world",
      newString: "nautilo",
    }),
    assert: assertLocalRelayRequired,
  },
  {
    name: "direct absolute move requires the local relay",
    setup: async () => {
      await fsp.writeFile(join(workspace, "matrix-move-src.txt"), "mv", "utf-8");
    },
    args: () => ({
      command: "move",
      path: join(workspace, "matrix-move-src.txt"),
      zone: "absolute",
      destinationPath: join(workspace, "matrix-move-dest.txt"),
      destinationZone: "absolute",
    }),
    assert: assertLocalRelayRequired,
  },
  {
    name: "direct absolute copy requires the local relay",
    setup: async () => {
      await fsp.writeFile(join(workspace, "matrix-copy-src.txt"), "cp", "utf-8");
    },
    args: () => ({
      command: "copy",
      path: join(workspace, "matrix-copy-src.txt"),
      zone: "absolute",
      destinationPath: join(workspace, "matrix-copy-dest.txt"),
      destinationZone: "absolute",
    }),
    assert: assertLocalRelayRequired,
  },
  {
    name: "direct absolute delete requires the local relay",
    setup: async () => {
      await fsp.writeFile(join(workspace, "matrix-del.txt"), "bye", "utf-8");
    },
    args: () => ({ command: "delete", path: join(workspace, "matrix-del.txt"), zone: "absolute" }),
    assert: assertLocalRelayRequired,
  },
];

beforeAll(async () => {
  base = await fsp.mkdtemp(join(tmpdir(), "nautilo-file-matrix-"));
  workspace = join(base, "ws");
  current = join(workspace, "task");
  await fsp.mkdir(workspace, { recursive: true });
  await fsp.mkdir(current, { recursive: true });
});

afterAll(async () => {
  await fsp.rm(base, { recursive: true, force: true });
});

describe("file tool dispatch matrix (M067D)", () => {
  test("matrix lists every covered command exactly once", () => {
    const cmds = new Set(MATRIX_CASES.map((c) => c.args().command));
    expect(cmds.size).toBe(FILE_TOOL_MATRIX_COVERED_COMMANDS.length);
    for (const required of FILE_TOOL_MATRIX_COVERED_COMMANDS) {
      expect(cmds.has(required)).toBe(true);
    }
  });

  test("read via absolute zone", async () => {
    const p = join(workspace, "abs-target.txt");
    await fsp.writeFile(p, "absolute ok", "utf-8");
    const turnId = randomUUID();
    const out = expectDispatchString(
      await dispatchFileCommand({ command: "read", path: p, zone: "absolute" }, ctxForTurn(turnId)),
    );
    expect(JSON.parse(out)).toMatchObject({
      command: "read",
      content: "absolute ok",
    });
  });

  for (const row of MATRIX_CASES) {
    test(row.name, async () => {
      if (row.setup) await row.setup();
      const turnId = randomUUID();
      const out = expectDispatchString(await dispatchFileCommand(row.args(), ctxForTurn(turnId)));
      await row.assert(out);
    });
  }
});
