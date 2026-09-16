/**
 * D087 Phase 3 §3.5 — `file.pin_revision` / `file.unpin_revision`
 * integration tests.
 *
 * Covers the happy path, idempotency, cross-agent isolation, and
 * the GC interaction (pin survives the per-file cap sweep).
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
  fileRevisions,
  eq,
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
import {
  handlePinRevision,
  handleUnpinRevision,
} from "../../src/tools/file/commands/pin-revision";
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
    .values({ name: "pin-e2e", email: `pin-${Date.now()}@test.local` })
    .returning({ id: users.id });
  if (!user) throw new Error("user seed");
  ownerId = user.id;
  const [agent] = await db
    .insert(agents)
    .values({ handle: `pin-${Date.now()}` })
    .returning({ id: agents.id });
  if (!agent) throw new Error("agent seed");
  agentId = agent.id;
  const [other] = await db
    .insert(agents)
    .values({ handle: `pin-other-${Date.now()}` })
    .returning({ id: agents.id });
  if (!other) throw new Error("other seed");
  otherAgentId = other.id;

  tmpRoot = join(tmpdir(), `d087-pin-${Date.now()}`);
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
    turnId: "pin-turn",
    ...overrides,
  };
}

async function seedOneRevision(opts: {
  agentId?: string;
  fileName: string;
}): Promise<string> {
  const path = join(nautiloRuntimeRoot, opts.fileName);
  writeFileSync(path, "pre\n");
  const r = await recordRevision({
    preBytes: Buffer.from("pre\n"),
    postBytes: Buffer.from("post\n"),
    absolutePath: path,
    operation: "str_replace",
    ownerId,
    agentId: opts.agentId ?? agentId,
    turnId: `pin-seed-${Math.random().toString(36).slice(2)}`,
  });
  if (!r.ok) throw new Error("seed failed");
  writeFileSync(path, "post\n");
  return r.revisionId;
}

describe("file.pin_revision — happy path", () => {
  test("legacy pin is explicitly read-only and leaves the stable row unchanged", async () => {
    const revId = await seedOneRevision({ fileName: "pin-happy.md" });
    const res = await handlePinRevision(
      { command: "pin_revision", revisionId: revId },
      makeCtx(),
    );
    const parsed = JSON.parse(res) as Record<string, unknown>;
    expect(parsed["error"]).toBe("legacy_history_read_only");
    const [row] = await db
      .select()
      .from(fileRevisions)
      .where(eq(fileRevisions.id, revId))
      .limit(1);
    expect(row?.pinned).toBe(false);
  });

  test("legacy unpin is explicitly read-only", async () => {
    const revId = await seedOneRevision({ fileName: "unpin-happy.md" });
    const res = await handleUnpinRevision(
      { command: "unpin_revision", revisionId: revId },
      makeCtx(),
    );
    const parsed = JSON.parse(res) as Record<string, unknown>;
    expect(parsed["error"]).toBe("legacy_history_read_only");
  });

  test("repeated legacy pin attempts remain read-only", async () => {
    const revId = await seedOneRevision({ fileName: "pin-idempotent.md" });
    const r1 = await handlePinRevision(
      { command: "pin_revision", revisionId: revId },
      makeCtx(),
    );
    const r2 = await handlePinRevision(
      { command: "pin_revision", revisionId: revId },
      makeCtx(),
    );
    const p1 = JSON.parse(r1) as Record<string, unknown>;
    const p2 = JSON.parse(r2) as Record<string, unknown>;
    expect(p1["error"]).toBe("legacy_history_read_only");
    expect(p2["error"]).toBe("legacy_history_read_only");
  });
});

describe("file.pin_revision — error paths", () => {
  test("unknown revisionId → revision_not_found", async () => {
    const res = await handlePinRevision(
      {
        command: "pin_revision",
        revisionId: "00000000-0000-0000-0000-000000000000",
      },
      makeCtx(),
    );
    const parsed = JSON.parse(res) as Record<string, unknown>;
    expect(parsed["error"]).toBe("revision_not_found");
  });

  test("cross-agent pin → revision_not_found (PR-018 MAJOR #2 enumeration-defense)", async () => {
    // PR-018 MAJOR #2 (H-033): cross-agent lookup must be
    // indistinguishable from "unknown id" at the caller's output
    // surface — otherwise an attacker with a leaked revision id
    // from agent B can probe pin_revision to confirm its existence.
    // The canonical history reader collapses both cases into
    // `revision_not_found`; pin/unpin apply the same collapse.
    //
    // This test asserts the COLLAPSED shape. Any future refactor
    // that reintroduces a distinguishable `revision_not_owned_by_agent`
    // error body will fail here — deliberately, because that
    // distinction IS the enumeration oracle.
    const revId = await seedOneRevision({
      agentId: otherAgentId,
      fileName: "pin-crossagent.md",
    });
    // Our agent tries to pin it.
    const res = await handlePinRevision(
      { command: "pin_revision", revisionId: revId },
      makeCtx(),
    );
    const parsed = JSON.parse(res) as Record<string, unknown>;
    expect(parsed["error"]).toBe("revision_not_found");
    // Make the enumeration-defense invariant explicit: the response
    // body does not include any field that would distinguish
    // "cross-agent" from "unknown id" (e.g. no `owner_hint`,
    // `exists_globally`, `agentId` echo, etc.). Only `error` +
    // `revisionId` + `hint` — the same shape as the unknown-id case.
    expect(Object.keys(parsed).sort()).toEqual(["error", "hint", "revisionId"]);
    // Verify the other agent's row is STILL unpinned (pin did not
    // somehow mutate across the agent boundary).
    const [row] = await db
      .select()
      .from(fileRevisions)
      .where(eq(fileRevisions.id, revId))
      .limit(1);
    expect(row?.pinned).toBe(false);
  });

  test("cross-agent unpin → revision_not_found (same enumeration-defense)", async () => {
    // Seed a revision on the other agent, flip it to pinned, then
    // our agent tries to unpin it. Must receive the collapsed shape.
    const revId = await seedOneRevision({
      agentId: otherAgentId,
      fileName: "unpin-crossagent.md",
    });
    await db
      .update(fileRevisions)
      .set({ pinned: true })
      .where(eq(fileRevisions.id, revId));
    const res = await handleUnpinRevision(
      { command: "unpin_revision", revisionId: revId },
      makeCtx(),
    );
    const parsed = JSON.parse(res) as Record<string, unknown>;
    expect(parsed["error"]).toBe("revision_not_found");
    expect(Object.keys(parsed).sort()).toEqual(["error", "hint", "revisionId"]);
    // Other agent's row is STILL pinned.
    const [row] = await db
      .select()
      .from(fileRevisions)
      .where(eq(fileRevisions.id, revId))
      .limit(1);
    expect(row?.pinned).toBe(true);
  });

  test("missing revisionId → clean error", async () => {
    const res = await handlePinRevision(
      // @ts-expect-error — intentional invalid shape
      { command: "pin_revision" },
      makeCtx(),
    );
    expect(res.startsWith("Error:")).toBe(true);
    expect(res).toContain("revisionId");
  });

  test("missing ctx.agentId → clean error", async () => {
    const revId = await seedOneRevision({ fileName: "pin-noagent.md" });
    const ctx: DispatchContext = {
      zoneCtx: { workspaceRoot: "", currentFolder: null },
      ownerId,
      turnId: "t",
    };
    const res = await handlePinRevision(
      { command: "pin_revision", revisionId: revId },
      ctx,
    );
    expect(res.startsWith("Error:")).toBe(true);
    expect(res).toContain("agent context");
  });
});
