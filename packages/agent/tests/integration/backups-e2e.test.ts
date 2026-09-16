/**
 * D087 Phase 2A §12.4 — backup subsystem integration tests.
 *
 * Runs end-to-end against a live Postgres (docker nautilo-postgres)
 * and a real `LocalStorageProvider` pointed at a tmp directory.
 * Exercises the routing, DB inserts, blob writes, dedup, and per-file +
 * hourly GC — every retained surface
 * that isn't a pure function covered by `backups-pure.test.ts`.
 *
 * Fixtures: one test user + one test agent, created in `beforeAll`
 * and cleaned up in `afterAll` (ON DELETE CASCADE on `file_revisions`
 * sweeps the rows with the user).
 *
 * Requires: live Postgres (test-cruft instance via bootstrapTestDbInstance). Skipped otherwise.
 */

import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
loadEnv({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDirectDb,
  eq,
  sql,
  users,
  agents,
  fileRevisions,
  FILE_REVISION_AUTHOR,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  createStorageZones,
  ensureDirectoryTree,
  fromRuntimeConfig,
  resolveNautiloRuntimePaths,
  type StorageZones,
} from "@nautilo/config";
import {
  recordRevision,
  setBackupStorage,
  resetBackupStorage,
  sweepPerFileCap,
  sweepHourly,
  blobRelPathFor,
  BACKUP_ROUTING,
} from "../../src/index";


let db: ReturnType<typeof createDirectDb>;
let ownerId: string;
let agentId: string;
let root: string;
let zones: StorageZones;

beforeAll(async () => {
  bootstrapTestDbInstance();
  db = createDirectDb(1);

  const [user] = await db
    .insert(users)
    .values({
      name: "backup-e2e",
      email: `backup-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("Failed to create test user");
  ownerId = user.id;

  // M045: `agents.owner_id` was dropped — insert payload is handle +
  // displayName only.
  const [agent] = await db
    .insert(agents)
    .values({
      handle: `backup-e2e-${Date.now()}`,
    })
    .returning({ id: agents.id });
  if (!agent) throw new Error("Failed to create test agent");
  agentId = agent.id;

  // Temp storage root + zones (same shape the server boot uses).
  root = join(tmpdir(), `d087-backup-e2e-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const paths = resolveNautiloRuntimePaths({
    config: fromRuntimeConfig({}),
    env: {},
    userHomeDir: root,
  });
  await ensureDirectoryTree(paths);
  zones = createStorageZones(paths);
  setBackupStorage(zones);
});

afterAll(async () => {
  if (db && ownerId) {
    // M045: `agents.owner_id` was dropped, so `DELETE FROM users` no
    // longer cascades to `agents`. `file_revisions.user_id` still
    // cascades via the user delete. Delete the agent row explicitly
    // first — its cascade cleans up the mirror `actors.agent_id` row
    // and any other agent-FK tables (file_revisions.agent_id is
    // nullable and gets nulled).
    if (agentId) {
      await db.execute(sql`DELETE FROM agents WHERE id = ${agentId}`);
    }
    await db.execute(sql`DELETE FROM users WHERE id = ${ownerId}`);
    await db.end();
  }
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
  resetBackupStorage();
});

// Helper — deterministic ctx for the record path.
function ctx(overrides: Partial<Parameters<typeof recordRevision>[0]> = {}) {
  return {
    ownerId,
    agentId,
    turnId: `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    absolutePath: "/tmp/unused.md",
    operation: "write" as const,
    preBytes: Buffer.from("pre\n"),
    postBytes: Buffer.from("post\n"),
    ...overrides,
  };
}

/**
 * Helper: a realistic-sized text body where the reverse-diff will
 * actually compress below preBytes.byteLength (i.e. the hot-lane
 * routing path is exercised). A few KB of prose with one modified
 * line is representative of median agent edits. Tiny inputs (~tens
 * of bytes) always inflate because the unified-diff header alone is
 * ~100 bytes — those deliberately route cold-lane.
 */
function makeHotLaneSample(): { pre: Buffer; post: Buffer } {
  const base = Array.from(
    { length: 50 },
    (_, i) =>
      `Line ${i + 1}: lorem ipsum dolor sit amet, consectetur adipiscing elit.`,
  ).join("\n");
  const pre = `${base}\n`;
  const post = pre.replace(
    "Line 25: lorem",
    "Line 25: CHANGED WORD here;",
  );
  return { pre: Buffer.from(pre), post: Buffer.from(post) };
}

// ---------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------

describe("recordRevision routing", () => {
  test("small text edit → hot lane (kind='diff')", async () => {
    const { pre, post } = makeHotLaneSample();
    const input = ctx({
      absolutePath: "/tmp/route-hot-1.md",
      preBytes: pre,
      postBytes: post,
    });
    const result = await recordRevision(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lane).toBe("hot");

    // Verify the row landed with the expected shape.
    const [row] = await db
      .select()
      .from(fileRevisions)
      .where(eq(fileRevisions.id, result.revisionId));
    expect(row).toBeDefined();
    expect(row?.kind).toBe("diff");
    expect(row?.diffText).toBeTruthy();
    expect(row?.blobRef).toBeNull();
  });

  test("binary content (null byte) → cold lane (kind='blob')", async () => {
    const binary = Buffer.concat([
      Buffer.from("header"),
      Buffer.from([0x00, 0x01, 0x02, 0x03]),
      Buffer.from("payload"),
    ]);
    const result = await recordRevision(
      ctx({
        absolutePath: "/tmp/route-bin.png",
        preBytes: binary,
        postBytes: binary, // same bytes → trivial dedup
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lane).toBe("cold");
    if (result.lane !== "cold") return;
    expect(result.kind).toBe("blob");
    expect(result.blobRef).toContain("backups/blobs/sha256/");
  });

  test("large text (> COLD_LANE_PRE_SIZE_THRESHOLD) → cold lane", async () => {
    const big = Buffer.alloc(BACKUP_ROUTING.COLD_LANE_PRE_SIZE_THRESHOLD + 100, 0x41); // "A"*N
    const result = await recordRevision(
      ctx({
        absolutePath: "/tmp/route-big.md",
        preBytes: big,
        postBytes: big,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lane).toBe("cold");
  });

  test("delete with non-empty pre-bytes → cold-lane tombstone", async () => {
    const result = await recordRevision(
      ctx({
        absolutePath: "/tmp/route-delete.md",
        preBytes: Buffer.from("will be deleted\n"),
        postBytes: Buffer.alloc(0),
        operation: "delete",
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lane).toBe("cold");
    if (result.lane !== "cold") return;
    expect(result.kind).toBe("tombstone");
  });

  test("delete with empty pre-bytes → skipped (recursive-dir-delete)", async () => {
    const result = await recordRevision(
      ctx({
        absolutePath: "/tmp/route-dirdelete",
        preBytes: Buffer.alloc(0),
        postBytes: Buffer.alloc(0),
        operation: "delete",
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.skipped).toBe("recursive-dir-delete");
  });
});

// ---------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------

// Shared helper: capture a rejection synchronously. Bun's jest-shim
// doesn't implement `await expect(promise).rejects.*` cleanly under
// the @typescript-eslint/await-thenable rule, so we hand-roll the
// reject-capture via try/catch.
async function captureReject(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  return null;
}

describe("recordRevision input validation", () => {
  test("missing agentId throws loudly", async () => {
    const err = await captureReject(recordRevision(ctx({ agentId: "" })));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/agentId is required/);
  });

  test("missing ownerId throws loudly", async () => {
    const err = await captureReject(recordRevision(ctx({ ownerId: "" })));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/ownerId is required/);
  });

  test("missing turnId throws loudly", async () => {
    const err = await captureReject(recordRevision(ctx({ turnId: "" })));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/turnId is required/);
  });
});

// ---------------------------------------------------------------------
// Cold-lane dedup
// ---------------------------------------------------------------------

describe("cold-lane blob dedup", () => {
  test("two revisions with identical pre-bytes share one blob", async () => {
    const bytes = Buffer.concat([Buffer.from([0x00]), Buffer.from("dedup-target")]);
    const r1 = await recordRevision(
      ctx({
        absolutePath: "/tmp/dedup-1.png",
        preBytes: bytes,
        postBytes: bytes,
      }),
    );
    const r2 = await recordRevision(
      ctx({
        absolutePath: "/tmp/dedup-2.png",
        preBytes: bytes,
        postBytes: bytes,
      }),
    );

    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok || r1.lane !== "cold" || r2.lane !== "cold") return;

    // Same content-addressed key; different revision row ids.
    expect(r1.blobRef).toBe(r2.blobRef);
    expect(r1.revisionId).not.toBe(r2.revisionId);

    // First write was new; second was a dedup hit.
    expect(r1.blobWasNew).toBe(true);
    expect(r2.blobWasNew).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Per-file cap (sweepPerFileCap)
// ---------------------------------------------------------------------

describe("sweepPerFileCap retention", () => {
  test("past the cap, oldest unpinned rows evict", async () => {
    // A dedicated path so the running count is deterministic.
    const path_ = `/tmp/percap-${Date.now()}.md`;
    const cap = 3;

    // Plant 5 revisions (oldest-first insertion order).
    for (let i = 0; i < 5; i++) {
      await recordRevision(
        ctx({
          absolutePath: path_,
          preBytes: Buffer.from(`v${i}`),
          postBytes: Buffer.from(`v${i + 1}`),
        }),
      );
      // Microsecond gap so createdAt ordering is deterministic.
      await new Promise((r) => setTimeout(r, 2));
    }

    const result = await sweepPerFileCap(agentId, path_, {
      perFileCap: cap,
      totalSizeCapBytes: 0, // irrelevant for this sweep
    });

    expect(result.evicted).toBe(5 - cap);

    // Verify only `cap` rows remain for this path.
    const rows = await db
      .select({ id: fileRevisions.id })
      .from(fileRevisions)
      .where(
        eq(fileRevisions.agentId, agentId),
      );
    const remainingForPath = await db
      .select({ id: fileRevisions.id })
      .from(fileRevisions)
      .where(eq(fileRevisions.absolutePath, path_));
    expect(remainingForPath.length).toBe(cap);
    expect(rows.length).toBeGreaterThanOrEqual(cap);
  });

  test("pinned rows are exempt from count-cap eviction", async () => {
    const path_ = `/tmp/pinned-${Date.now()}.md`;
    const cap = 2;

    const firstResult = await recordRevision(
      ctx({
        absolutePath: path_,
        preBytes: Buffer.from("v0"),
        postBytes: Buffer.from("v1"),
      }),
    );
    if (!firstResult.ok) throw new Error("first record failed");

    // Pin the first revision.
    await db
      .update(fileRevisions)
      .set({ pinned: true })
      .where(eq(fileRevisions.id, firstResult.revisionId));

    // Add 3 more unpinned revisions → total 4 (1 pinned + 3 unpinned).
    for (let i = 0; i < 3; i++) {
      await recordRevision(
        ctx({
          absolutePath: path_,
          preBytes: Buffer.from(`v${i + 1}`),
          postBytes: Buffer.from(`v${i + 2}`),
        }),
      );
      await new Promise((r) => setTimeout(r, 2));
    }

    const result = await sweepPerFileCap(agentId, path_, {
      perFileCap: cap,
      totalSizeCapBytes: 0,
    });

    // 3 unpinned, cap 2 → 1 eviction (the oldest unpinned).
    expect(result.evicted).toBe(1);

    // Verify the pinned first row is still there.
    const [stillThere] = await db
      .select()
      .from(fileRevisions)
      .where(eq(fileRevisions.id, firstResult.revisionId));
    expect(stillThere).toBeDefined();
    expect(stillThere?.pinned).toBe(true);
  });
});

// ---------------------------------------------------------------------
// Hourly sweep — size-cap LRU + orphan blob cleanup
// ---------------------------------------------------------------------

describe("sweepHourly size-cap + orphan GC", () => {
  test("under cap → no eviction", async () => {
    const before = await sweepHourly({
      perFileCap: 50,
      totalSizeCapBytes: 1024 * 1024 * 1024, // 1 GB — well above any test data
    });
    expect(before.rowsEvictedForSize).toBe(0);
  });

  test("with a tiny cap → oldest unpinned rows evict until under", async () => {
    // Plant a couple of distinctly-sized revisions so the sweep has
    // measurable data to evict against.
    for (let i = 0; i < 3; i++) {
      await recordRevision(
        ctx({
          absolutePath: `/tmp/hourly-${Date.now()}-${i}.md`,
          preBytes: Buffer.from(`pre ${i} `.repeat(100)),
          postBytes: Buffer.from(`post ${i} `.repeat(100)),
        }),
      );
    }

    // Set cap WAY below current usage so eviction is forced.
    const result = await sweepHourly({
      perFileCap: 50,
      totalSizeCapBytes: 1, // 1 byte → everything unpinned must go
    });
    expect(result.rowsEvictedForSize).toBeGreaterThan(0);
    expect(result.totalBytesAfter).toBeLessThanOrEqual(result.totalBytesBefore);
  });

  test("orphan blob sweep unlinks unreferenced blobs", async () => {
    // Plant a blob NOT referenced by any revision row (simulate the
    // FS-write-succeeded-but-DB-insert-failed case).
    const stray = Buffer.from("orphan payload");
    const straySha =
      "feedface" + "0123456789abcdef".repeat(3) + "0123456789abcdef";
    // Compose a 64-char lowercase hex that starts with "fe" for fan-bucket.
    // (We need a real sha-looking path so the GC's isSha256Hex filter passes.)
    const realSha =
      "fefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefe";
    void stray;
    void straySha;
    const blobRef = blobRelPathFor(realSha);
    await zones.data.write(blobRef, new Uint8Array(Buffer.from("unreferenced")));

    // Verify the blob is there.
    expect(await zones.data.exists(blobRef)).toBe(true);

    // Run the sweep.
    const result = await sweepHourly({
      perFileCap: 50,
      totalSizeCapBytes: 10 * 1024 * 1024 * 1024, // high — don't trigger size eviction
    });
    expect(result.blobsUnlinked).toBeGreaterThanOrEqual(1);

    // And it should be gone.
    expect(await zones.data.exists(blobRef)).toBe(false);
  });

  test("non-hex debris in the blobs dir is skipped (not deleted, not counted)", async () => {
    // `.DS_Store` in the blobs/sha256 root — the sweep should skip it
    // because `isHex2(".DS_Store")` is false.
    await zones.data.write(
      "backups/blobs/sha256/.DS_Store",
      new Uint8Array(Buffer.from("mac noise")),
    );

    const result = await sweepHourly({
      perFileCap: 50,
      totalSizeCapBytes: 10 * 1024 * 1024 * 1024,
    });

    // Should still exist (unlinked counter reflects only real blobs).
    expect(await zones.data.exists("backups/blobs/sha256/.DS_Store")).toBe(
      true,
    );
    expect(result.blobsUnlinked).toBe(0);

    // Clean up the test debris manually.
    await zones.data.delete("backups/blobs/sha256/.DS_Store");
  });
});

// ---------------------------------------------------------------------
// M180 — revision provenance (authoredBy / userId)
// ---------------------------------------------------------------------

describe("recordRevision provenance (M180)", () => {
  test("omitted authoredBy defaults to agent on hot lane", async () => {
    const { pre, post } = makeHotLaneSample();
    const result = await recordRevision(
      ctx({
        absolutePath: "/tmp/provenance-default-agent.md",
        preBytes: pre,
        postBytes: post,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [row] = await db
      .select()
      .from(fileRevisions)
      .where(eq(fileRevisions.id, result.revisionId));
    expect(row?.authoredBy).toBe(FILE_REVISION_AUTHOR.AGENT);
    expect(row?.userId).toBeNull();
  });

  test("authoredBy user + userId reaches hot lane row", async () => {
    const { pre, post } = makeHotLaneSample();
    const result = await recordRevision(
      ctx({
        absolutePath: "/tmp/provenance-user-hot.md",
        preBytes: pre,
        postBytes: post,
        authoredBy: FILE_REVISION_AUTHOR.USER,
        userId: ownerId,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lane).toBe("hot");

    const [row] = await db
      .select()
      .from(fileRevisions)
      .where(eq(fileRevisions.id, result.revisionId));
    expect(row?.authoredBy).toBe(FILE_REVISION_AUTHOR.USER);
    expect(row?.userId).toBe(ownerId);
  });

  test("authoredBy user + userId reaches cold lane row", async () => {
    const binary = Buffer.concat([
      Buffer.from("header"),
      Buffer.from([0x00, 0x01, 0x02, 0x03]),
      Buffer.from("payload"),
    ]);
    const result = await recordRevision(
      ctx({
        absolutePath: "/tmp/provenance-user-cold.bin",
        preBytes: binary,
        postBytes: binary,
        authoredBy: FILE_REVISION_AUTHOR.USER,
        userId: ownerId,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lane).toBe("cold");

    const [row] = await db
      .select()
      .from(fileRevisions)
      .where(eq(fileRevisions.id, result.revisionId));
    expect(row?.authoredBy).toBe(FILE_REVISION_AUTHOR.USER);
    expect(row?.userId).toBe(ownerId);
  });
});
