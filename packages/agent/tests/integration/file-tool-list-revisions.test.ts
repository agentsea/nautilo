/**
 * D087 Phase 3 §3.4 — `file.list_revisions` integration tests.
 *
 * Covers the filter matrix + the truncation signal + cross-agent
 * isolation (agent A's revisions are invisible to agent B, and the
 * response shape carries no cross-agent existence oracle — see
 * PR-018 MINOR #5, H-033). Pure SELECT means no filesystem or
 * staging state to teardown — just agent + user fixtures.
 */

import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
loadEnv({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDirectDb,
  sql,
  users,
  agents,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  createStorageZones,
  ensureDirectoryTree,
  fromRuntimeConfig,
  resolveNautiloRuntimePaths,
} from "@nautilo/config";
import {
  recordRevision,
  setBackupStorage,
  resetBackupStorage,
} from "../../src/tools/file/backups";
import { handleListRevisions } from "../../src/tools/file/commands/list-revisions";
import type { DispatchContext } from "../../src/tools/file/dispatch";


let db: ReturnType<typeof createDirectDb>;
let ownerId: string;
let agentId: string;
let otherAgentId: string;
let tmpRoot: string;
let nautiloRuntimeRoot: string;

beforeAll(async () => {
  bootstrapTestDbInstance();
  db = createDirectDb(1);
  const [user] = await db
    .insert(users)
    .values({ name: "list-rev-e2e", email: `list-rev-${Date.now()}@test.local` })
    .returning({ id: users.id });
  if (!user) throw new Error("user seed");
  ownerId = user.id;

  const [agent] = await db
    .insert(agents)
    .values({ handle: `list-rev-${Date.now()}` })
    .returning({ id: agents.id });
  if (!agent) throw new Error("agent seed");
  agentId = agent.id;

  const [other] = await db
    .insert(agents)
    .values({ handle: `list-rev-other-${Date.now()}` })
    .returning({ id: agents.id });
  if (!other) throw new Error("other seed");
  otherAgentId = other.id;

  tmpRoot = join(tmpdir(), `d087-list-rev-${Date.now()}`);
  mkdirSync(tmpRoot, { recursive: true });
  const paths = resolveNautiloRuntimePaths({
    config: fromRuntimeConfig({}),
    env: {},
    userHomeDir: tmpRoot,
  });
  nautiloRuntimeRoot = paths.rootDir;
  await ensureDirectoryTree(paths);
  setBackupStorage(createStorageZones(paths));
});

afterAll(async () => {
  resetBackupStorage();
  if (db && ownerId) {
    await db.execute(sql`DELETE FROM users WHERE id = ${ownerId}`);
    await db.end();
  }
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

function makeCtx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    zoneCtx: { workspaceRoot: "", currentFolder: null },
    ownerId,
    agentId,
    turnId: "list-rev-turn",
    ...overrides,
  };
}

async function seedFileWithEdits(opts: {
  agentId?: string;
  fileName: string;
  edits: Array<{ pre: string; post: string; turnId?: string }>;
}): Promise<string> {
  const path = join(nautiloRuntimeRoot, opts.fileName);
  writeFileSync(path, opts.edits[0]?.pre ?? "");
  for (const e of opts.edits) {
    writeFileSync(path, e.post);
    const r = await recordRevision({
      preBytes: Buffer.from(e.pre),
      postBytes: Buffer.from(e.post),
      absolutePath: path,
      operation: "str_replace",
      ownerId,
      agentId: opts.agentId ?? agentId,
      turnId: e.turnId ?? `turn-${Math.random().toString(36).slice(2)}`,
    });
    if (!r.ok) throw new Error("seed failed");
  }
  return path;
}

function parseResult(json: string): {
  revisions: Array<{
    revisionId: string;
    turnId: string;
    path: string;
    operation: string;
    kind: string;
    pinned: boolean;
    createdAt: string;
  }>;
  truncated: boolean;
} {
  return JSON.parse(json) as ReturnType<typeof parseResult>;
}

describe("file.list_revisions — filters", () => {
  test("no filters → returns all agent's revisions across files", async () => {
    const p1 = await seedFileWithEdits({
      fileName: "lr-1.md",
      edits: [{ pre: "a\n", post: "b\n" }, { pre: "b\n", post: "c\n" }],
    });
    const p2 = await seedFileWithEdits({
      fileName: "lr-2.md",
      edits: [{ pre: "x\n", post: "y\n" }],
    });

    const res = await handleListRevisions({ command: "list_revisions" }, makeCtx());
    const parsed = parseResult(res);
    const paths = new Set(parsed.revisions.map((r) => r.path));
    expect(paths.has(p1)).toBe(true);
    expect(paths.has(p2)).toBe(true);
    expect(parsed.revisions.length).toBeGreaterThanOrEqual(3);
    // Ordered newest-first.
    for (let i = 1; i < parsed.revisions.length; i++) {
      const prev = Date.parse(parsed.revisions[i - 1]!.createdAt);
      const curr = Date.parse(parsed.revisions[i]!.createdAt);
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });

  test("path filter → only revisions for that path", async () => {
    const p = await seedFileWithEdits({
      fileName: "lr-path.md",
      edits: [
        { pre: "1\n", post: "2\n" },
        { pre: "2\n", post: "3\n" },
        { pre: "3\n", post: "4\n" },
      ],
    });
    const res = await handleListRevisions(
      { command: "list_revisions", path: p },
      makeCtx(),
    );
    const parsed = parseResult(res);
    expect(parsed.revisions.length).toBe(3);
    for (const r of parsed.revisions) {
      expect(r.path).toBe(p);
    }
  });

  test("revisionTurnId filter → only rows from that turn", async () => {
    const turnA = `lr-turn-A-${Date.now()}`;
    const turnB = `lr-turn-B-${Date.now()}`;
    await seedFileWithEdits({
      fileName: "lr-turnfilt.md",
      edits: [
        { pre: "1\n", post: "2\n", turnId: turnA },
        { pre: "2\n", post: "3\n", turnId: turnB },
      ],
    });
    const res = await handleListRevisions(
      { command: "list_revisions", revisionTurnId: turnA },
      makeCtx(),
    );
    const parsed = parseResult(res);
    expect(parsed.revisions.length).toBeGreaterThanOrEqual(1);
    // Every returned row is from turnA.
    for (const r of parsed.revisions) {
      expect(r.turnId).toBe(turnA);
    }
  });

  test("limit + truncated detection works correctly", async () => {
    // Seed 4 revisions on a fresh file. Request limit=2 → get 2
    // rows, truncated=true.
    const p = await seedFileWithEdits({
      fileName: "lr-limit.md",
      edits: [
        { pre: "1\n", post: "2\n" },
        { pre: "2\n", post: "3\n" },
        { pre: "3\n", post: "4\n" },
        { pre: "4\n", post: "5\n" },
      ],
    });
    const resLimited = await handleListRevisions(
      { command: "list_revisions", path: p, limit: 2 },
      makeCtx(),
    );
    const parsedLimited = parseResult(resLimited);
    expect(parsedLimited.revisions.length).toBe(2);
    expect(parsedLimited.truncated).toBe(true);

    const resAll = await handleListRevisions(
      { command: "list_revisions", path: p, limit: 10 },
      makeCtx(),
    );
    const parsedAll = parseResult(resAll);
    expect(parsedAll.revisions.length).toBe(4);
    expect(parsedAll.truncated).toBe(false);
  });

  test("PR-018 MINOR #5 — cross-agent revisions invisible in results AND response has no cross-agent existence oracle", async () => {
    // Seed 1 revision by our agent + 2 revisions by a DIFFERENT
    // agent on the SAME path. The enumeration-defense invariant
    // (H-033): our agent's response must include only our 1
    // revision AND must NOT include any field that would reveal
    // another agent has touched the path (no `crossAgentCount`,
    // no `otherAgents`, no `sharedPath`, etc.).
    //
    // Previously this handler returned `crossAgentCount: 2` as a
    // "transparency field" — that was asymmetric with pin/unpin's
    // enumeration defense (MAJOR #2) and is removed.
    const p = await seedFileWithEdits({
      fileName: "lr-crossagent.md",
      edits: [{ pre: "my-pre\n", post: "my-post\n" }],
    });
    await seedFileWithEdits({
      agentId: otherAgentId,
      fileName: "lr-crossagent.md", // same file, same path
      edits: [
        { pre: "their-1\n", post: "their-2\n" },
        { pre: "their-2\n", post: "their-3\n" },
      ],
    });
    const res = await handleListRevisions(
      { command: "list_revisions", path: p },
      makeCtx(),
    );
    const parsed = parseResult(res);
    // Our agent sees only our 1 revision.
    expect(parsed.revisions.length).toBe(1);
    // Enumeration-defense: response shape has EXACTLY these keys.
    // Any future "transparency field" that leaks cross-agent
    // existence (count, flag, or hint) MUST fail here.
    const rawParsed = JSON.parse(res) as Record<string, unknown>;
    expect(Object.keys(rawParsed).sort()).toEqual(["revisions", "truncated"]);
  });

  test("no path filter → response shape unchanged (still only revisions + truncated)", async () => {
    const res = await handleListRevisions(
      { command: "list_revisions" },
      makeCtx(),
    );
    const rawParsed = JSON.parse(res) as Record<string, unknown>;
    expect(Object.keys(rawParsed).sort()).toEqual(["revisions", "truncated"]);
  });
});

describe("file.list_revisions — input validation", () => {
  test("logical path filter without Workspace zone → error", async () => {
    const res = await handleListRevisions(
      { command: "list_revisions", path: "relative/path.md" },
      makeCtx(),
    );
    expect(res.startsWith("Error:")).toBe(true);
    expect(res).toContain("zone 'workspace'");
  });

  test("invalid since → error (ISO-8601 check)", async () => {
    const res = await handleListRevisions(
      { command: "list_revisions", since: "not a date" },
      makeCtx(),
    );
    expect(res.startsWith("Error:")).toBe(true);
    expect(res).toContain("ISO-8601");
  });

  test("since > until → error", async () => {
    const res = await handleListRevisions(
      {
        command: "list_revisions",
        since: "2026-05-01T00:00:00Z",
        until: "2026-04-01T00:00:00Z",
      },
      makeCtx(),
    );
    expect(res.startsWith("Error:")).toBe(true);
    expect(res).toContain("<=");
  });

  test("missing ctx.agentId → error", async () => {
    const ctx: DispatchContext = {
      zoneCtx: { workspaceRoot: "", currentFolder: null },
      ownerId,
      turnId: "t",
    };
    const res = await handleListRevisions({ command: "list_revisions" }, ctx);
    expect(res.startsWith("Error:")).toBe(true);
    expect(res).toContain("agent context");
  });
});
