/**
 * Ensures Drizzle meta snapshots 0023–0038 exist and chain from 0022.
 * Missing snapshots caused `drizzle-kit generate` to diff 0022 (still
 * `profiles.avatar_url`) against current schema (`avatar_ref`, etc.),
 * triggering the interactive rename/create prompt.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const META = resolve(import.meta.dirname, "../../src/migrations/meta");

function readSnap(name: string): {
  id: string;
  prevId: string;
  tables: Record<string, { columns?: Record<string, { name: string }> }>;
} {
  return JSON.parse(readFileSync(resolve(META, name), "utf-8")) as {
    id: string;
    prevId: string;
    tables: Record<string, { columns?: Record<string, { name: string }> }>;
  };
}

describe("Drizzle meta snapshot chain 0022→0038", () => {
  test("snapshots 0023–0038 exist on disk", () => {
    for (const n of [
      "0023",
      "0024",
      "0025",
      "0026",
      "0027",
      "0028",
      "0029",
      "0030",
      "0031",
      "0032",
      "0033",
      "0034",
      "0035",
      "0036",
      "0037",
      "0038",
    ]) {
      expect(existsSync(resolve(META, `${n}_snapshot.json`))).toBe(true);
    }
  });

  test("0023 profiles: avatar_ref + public_profile; no avatar_url", () => {
    const s = readSnap("0023_snapshot.json");
    const profiles = s.tables["public.profiles"];
    expect(profiles).toBeDefined();
    const cols = profiles!.columns ?? {};
    expect(cols["avatar_ref"]).toBeDefined();
    expect(cols["public_profile"]).toBeDefined();
    expect(cols["avatar_url"]).toBeUndefined();
  });

  test("prevId chain links 0022 → … → 0038", () => {
    const snaps = [
      "0022",
      "0023",
      "0024",
      "0025",
      "0026",
      "0027",
      "0028",
      "0029",
      "0030",
      "0031",
      "0032",
      "0033",
      "0034",
      "0035",
      "0036",
      "0037",
      "0038",
      "0039",
      "0040",
      "0041",
      "0042",
      "0043",
      "0044",
      "0045",
    ].map((n) => readSnap(`${n}_snapshot.json`));
    for (let i = 1; i < snaps.length; i++) {
      expect(snaps[i]!.prevId).toBe(snaps[i - 1]!.id);
    }
  });

  test("0028 includes invites table (M066, after main's D104 0026/0027)", () => {
    const s = readSnap("0028_snapshot.json");
    expect(s.tables["public.invites"]).toBeDefined();
  });

  test("0026 includes logto_account_security table (D104)", () => {
    const s = readSnap("0026_snapshot.json");
    expect(s.tables["public.logto_account_security"]).toBeDefined();
  });

  test("0025 users includes server_role", () => {
    const s = readSnap("0025_snapshot.json");
    const usersTable = s.tables["public.users"];
    expect(usersTable).toBeDefined();
    expect(usersTable!.columns?.["server_role"]).toBeDefined();
  });

  test("0031 session_messages has fingerprint + partial unique index (M070)", () => {
    const s = readSnap("0031_snapshot.json");
    const sm = s.tables["public.session_messages"] as {
      columns?: Record<string, unknown>;
      indexes?: Record<string, { name?: string; where?: string }>;
    };
    expect(sm).toBeDefined();
    expect(sm.columns?.["fingerprint"]).toBeDefined();
    const uq = sm.indexes?.["uq_session_messages_session_fingerprint"];
    expect(uq).toBeDefined();
    expect(uq?.where).toContain("fingerprint");
  });

  test("0032 session_messages has tool_name (persisted tool display)", () => {
    const s = readSnap("0032_snapshot.json");
    const sm = s.tables["public.session_messages"] as { columns?: Record<string, unknown> };
    expect(sm).toBeDefined();
    expect(sm.columns?.["tool_name"]).toBeDefined();
  });

  test("0036 memories table has no legacy namespace_id column (M076)", () => {
    const s = readSnap("0036_snapshot.json");
    const memoriesTable = s.tables["public.memories"];
    expect(memoriesTable).toBeDefined();
    expect(memoriesTable!.columns?.["namespace_id"]).toBeUndefined();
  });

  test("0037 memories table has no owner_id or persona_id (M081)", () => {
    const s = readSnap("0037_snapshot.json");
    const memoriesTable = s.tables["public.memories"];
    expect(memoriesTable).toBeDefined();
    expect(memoriesTable!.columns?.["owner_id"]).toBeUndefined();
    expect(memoriesTable!.columns?.["persona_id"]).toBeUndefined();
  });

  test("0038 memories table has no room_id (M083)", () => {
    const s = readSnap("0038_snapshot.json");
    const memoriesTable = s.tables["public.memories"];
    expect(memoriesTable).toBeDefined();
    expect(memoriesTable!.columns?.["room_id"]).toBeUndefined();
  });

  test("0035 includes memory_namespaces junction (M076)", () => {
    const s = readSnap("0035_snapshot.json");
    expect(s.tables["public.memory_namespaces"]).toBeDefined();
  });

  test("0034 sessions has uq_sessions_owner_thread (M075)", () => {
    const s = readSnap("0034_snapshot.json");
    const sess = s.tables["public.sessions"] as {
      indexes?: Record<string, { isUnique?: boolean; columns?: { expression: string }[] }>;
    };
    expect(sess).toBeDefined();
    const uq = sess.indexes?.["uq_sessions_owner_thread"];
    expect(uq).toBeDefined();
    expect(uq?.isUnique).toBe(true);
    expect(uq?.columns?.map((c) => c.expression)).toEqual(["owner_id", "thread_id"]);
  });
});
