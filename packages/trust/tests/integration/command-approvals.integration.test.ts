/**
 * M037 — command-approval engine integration tests (trust + Postgres).
 *
 * Covers issue scenarios #2,3,4,17,19 + idempotency + revoke:
 *  - server-scope rule matches in any room (and with no room).
 *  - non-matching signature → null.
 *  - room-scope rule matches only in its room; room wins over server.
 *  - per-user isolation (security-critical): user B never matches A's rule.
 *  - createCommandApproval idempotent (incl. server-scope NULL room_id).
 *  - revoke flips active=false → subsequent match → null.
 *
 * Requires the M037 migration applied (scope/room_id/signature/signature_key
 * columns + lookup index). Run against an instance whose DB is migrated.
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createDirectDb,
  ensureDatabase,
  users,
  actors,
  namespaces,
  rooms,
  standingApprovals,
  eq,
  inArray,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  classifyCall,
  createCommandApproval,
  matchCommandApproval,
  revokeCommandApproval,
  listCommandApprovals,
  createCapabilityApproval,
  matchCapabilityApproval,
  APPROVAL_KIND_CAPABILITY,
} from "../../src/command-approvals";

let db: ReturnType<typeof createDirectDb>;
let userAId = "";
let userBId = "";
let roomAId = "";
let roomBId = "";
const nsIds: string[] = [];

async function seedRoom(label: string): Promise<string> {
  const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "room", label: `m037-ns-${ts}` })
    .returning({ id: namespaces.id });
  if (!ns) throw new Error("namespace");
  nsIds.push(ns.id);
  const [rm] = await db
    .insert(rooms)
    .values({
      ownerId: userAId,
      type: "private",
      label,
      graphThreadId: `room:m037:${ts}`,
      namespaceId: ns.id,
      humanActorIds: [],
    })
    .returning({ id: rooms.id });
  if (!rm) throw new Error("room");
  return rm.id;
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);
  const ts = Date.now().toString(36);

  const [ua] = await db
    .insert(users)
    .values({ name: "m037-a", email: `m037a-${ts}@test.local`, handle: `m037a${ts.slice(-6)}` })
    .returning({ id: users.id });
  const [ub] = await db
    .insert(users)
    .values({ name: "m037-b", email: `m037b-${ts}@test.local`, handle: `m037b${ts.slice(-6)}` })
    .returning({ id: users.id });
  if (!ua || !ub) throw new Error("users");
  userAId = ua.id;
  userBId = ub.id;

  roomAId = await seedRoom("M037 room A");
  roomBId = await seedRoom("M037 room B");
});

afterAll(async () => {
  if (!db) return;
  try {
    const ids = [userAId, userBId].filter(Boolean);
    if (ids.length > 0) {
      await db.delete(standingApprovals).where(inArray(standingApprovals.createdBy, ids));
    }
    if (roomAId) await db.delete(rooms).where(eq(rooms.id, roomAId));
    if (roomBId) await db.delete(rooms).where(eq(rooms.id, roomBId));
    if (nsIds.length > 0) {
      await db.delete(namespaces).where(inArray(namespaces.id, nsIds));
    }
    for (const id of ids) {
      await db.delete(actors).where(eq(actors.ownerId, id));
      await db.delete(users).where(eq(users.id, id));
    }
  } finally {
    await db.end();
  }
});

const SHELL = { command: "ls /proj/a/src" };

describe("matchCommandApproval — server scope (#4)", () => {
  test("server rule matches in any room and with no room; non-match → null", async () => {
    const c = classifyCall("run_shell", SHELL);
    await createCommandApproval({
      userId: userAId,
      scope: "server",
      roomId: null,
      toolName: "run_shell",
      signature: c.signature,
      signatureKey: c.signatureKey,
    });

    const inA = await matchCommandApproval({ userId: userAId, roomId: roomAId, toolName: "run_shell", args: SHELL });
    expect(inA?.scope).toBe("server");
    const inB = await matchCommandApproval({ userId: userAId, roomId: roomBId, toolName: "run_shell", args: SHELL });
    expect(inB?.scope).toBe("server");
    const noRoom = await matchCommandApproval({ userId: userAId, roomId: null, toolName: "run_shell", args: SHELL });
    expect(noRoom?.scope).toBe("server");

    // Different parent dir → different signature → no match.
    const miss = await matchCommandApproval({
      userId: userAId,
      roomId: roomAId,
      toolName: "run_shell",
      args: { command: "ls /other/dir" },
    });
    expect(miss).toBeNull();
  });

  test("per-user isolation (#17): user B never matches user A's rule", async () => {
    const asB = await matchCommandApproval({ userId: userBId, roomId: roomAId, toolName: "run_shell", args: SHELL });
    expect(asB).toBeNull();
  });
});

describe("matchCommandApproval — room scope (#2,#3) + room-wins (#4)", () => {
  const FILE = { command: "read", path: "/docs/x/notes.md" };

  test("room rule matches only in its room; isolation in other room", async () => {
    const c = classifyCall("file", FILE);
    await createCommandApproval({
      userId: userAId,
      scope: "room",
      roomId: roomAId,
      toolName: "file",
      signature: c.signature,
      signatureKey: c.signatureKey,
    });

    const inA = await matchCommandApproval({ userId: userAId, roomId: roomAId, toolName: "file", args: FILE });
    expect(inA?.scope).toBe("room");
    const inB = await matchCommandApproval({ userId: userAId, roomId: roomBId, toolName: "file", args: FILE });
    expect(inB).toBeNull();
  });

  test("room scope wins over server when both match", async () => {
    // Seed a server rule for the SAME file signature; room rule already exists.
    const c = classifyCall("file", FILE);
    await createCommandApproval({
      userId: userAId,
      scope: "server",
      roomId: null,
      toolName: "file",
      signature: c.signature,
      signatureKey: c.signatureKey,
    });
    const inA = await matchCommandApproval({ userId: userAId, roomId: roomAId, toolName: "file", args: FILE });
    expect(inA?.scope).toBe("room");
    // In room B only the server rule applies.
    const inB = await matchCommandApproval({ userId: userAId, roomId: roomBId, toolName: "file", args: FILE });
    expect(inB?.scope).toBe("server");
  });
});

describe("createCommandApproval — idempotency + revoke", () => {
  test("persists and matches a large apply_patch signature without exceeding the DB index limit", async () => {
    const args = {
      patch: `*** Begin Patch\n${"x".repeat(32_000)}\n*** End Patch`,
      target: "current",
    };
    const classified = classifyCall("apply_patch", args);

    const created = await createCommandApproval({
      userId: userAId,
      scope: "server",
      roomId: null,
      toolName: "apply_patch",
      signature: classified.signature,
      signatureKey: classified.signatureKey,
    });

    expect(created.created).toBe(true);
    expect(classified.signatureKey).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(
      await matchCommandApproval({
        userId: userAId,
        roomId: roomAId,
        toolName: "apply_patch",
        args,
      }),
    ).toMatchObject({ id: created.id, scope: "server" });
  });

  test("second create of the same server-scope tuple (NULL room_id) is a no-op", async () => {
    const c = classifyCall("run_shell", { command: "git status" });
    const first = await createCommandApproval({
      userId: userAId, scope: "server", roomId: null, toolName: "run_shell",
      signature: c.signature, signatureKey: c.signatureKey,
    });
    expect(first.created).toBe(true);
    const second = await createCommandApproval({
      userId: userAId, scope: "server", roomId: null, toolName: "run_shell",
      signature: c.signature, signatureKey: c.signatureKey,
    });
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });

  test("revoke flips active=false → subsequent match returns null (#16 half)", async () => {
    const args = { command: "echo hello" };
    const c = classifyCall("run_shell", args);
    const created = await createCommandApproval({
      userId: userAId, scope: "server", roomId: null, toolName: "run_shell",
      signature: c.signature, signatureKey: c.signatureKey,
    });
    expect(await matchCommandApproval({ userId: userAId, roomId: null, toolName: "run_shell", args })).not.toBeNull();
    await revokeCommandApproval(created.id, userAId);
    expect(await matchCommandApproval({ userId: userAId, roomId: null, toolName: "run_shell", args })).toBeNull();
  });

  test("listCommandApprovals returns active rows with rendered label + scope", async () => {
    const rows = await listCommandApprovals(userAId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => typeof r.label === "string" && r.label.length > 0)).toBe(true);
    expect(rows.some((r) => r.scope === "room")).toBe(true);
    // room-scope rows carry a roomLabel; server rows do not.
    const roomRow = rows.find((r) => r.scope === "room");
    expect(roomRow?.roomLabel).toBeTruthy();
    expect(rows.find((r) => r.scope === "server")?.roomLabel ?? null).toBeNull();
  });
});

describe("matchCapabilityApproval — capability-scoped standing grants", () => {
  const CAP = "control_desktop";

  test("server capability rule matches regardless of tool args; different slug → null", async () => {
    await createCapabilityApproval({
      userId: userAId,
      scope: "server",
      roomId: null,
      capabilitySlug: CAP,
    });

    const inA = await matchCapabilityApproval({
      userId: userAId,
      roomId: roomAId,
      capabilitySlug: CAP,
    });
    expect(inA?.scope).toBe("server");

    const otherArgs = await matchCapabilityApproval({
      userId: userAId,
      roomId: roomBId,
      capabilitySlug: CAP,
    });
    expect(otherArgs?.scope).toBe("server");

    const miss = await matchCapabilityApproval({
      userId: userAId,
      roomId: roomAId,
      capabilitySlug: "manage_server_security",
    });
    expect(miss).toBeNull();
  });

  test("per-user isolation: user B never matches user A's capability rule", async () => {
    const asB = await matchCapabilityApproval({
      userId: userBId,
      roomId: roomAId,
      capabilitySlug: CAP,
    });
    expect(asB).toBeNull();
  });

  test("room capability rule matches only in its room; room wins over server", async () => {
    await createCapabilityApproval({
      userId: userAId,
      scope: "room",
      roomId: roomBId,
      capabilitySlug: "invoke_external_api",
    });

    const inB = await matchCapabilityApproval({
      userId: userAId,
      roomId: roomBId,
      capabilitySlug: "invoke_external_api",
    });
    expect(inB?.scope).toBe("room");
    const inA = await matchCapabilityApproval({
      userId: userAId,
      roomId: roomAId,
      capabilitySlug: "invoke_external_api",
    });
    expect(inA).toBeNull();

    await createCapabilityApproval({
      userId: userAId,
      scope: "server",
      roomId: null,
      capabilitySlug: "invoke_external_api",
    });
    const roomWins = await matchCapabilityApproval({
      userId: userAId,
      roomId: roomBId,
      capabilitySlug: "invoke_external_api",
    });
    expect(roomWins?.scope).toBe("room");
  });

  test("createCapabilityApproval idempotent; revoke clears subsequent match", async () => {
    const first = await createCapabilityApproval({
      userId: userAId,
      scope: "server",
      roomId: null,
      capabilitySlug: "read_files",
    });
    expect(first.created).toBe(true);
    const second = await createCapabilityApproval({
      userId: userAId,
      scope: "server",
      roomId: null,
      capabilitySlug: "read_files",
    });
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);

    expect(
      await matchCapabilityApproval({
        userId: userAId,
        roomId: null,
        capabilitySlug: "read_files",
      }),
    ).not.toBeNull();
    await revokeCommandApproval(first.id, userAId);
    expect(
      await matchCapabilityApproval({
        userId: userAId,
        roomId: null,
        capabilitySlug: "read_files",
      }),
    ).toBeNull();
  });

  test("listCommandApprovals includes capability rows with capability label", async () => {
    const rows = await listCommandApprovals(userAId);
    const capRow = rows.find(
      (r) => r.approvalKind === APPROVAL_KIND_CAPABILITY && r.capabilitySlug === CAP,
    );
    expect(capRow?.label).toBe(`capability: ${CAP}`);
  });
});
