/**
 * M163 — `getRunAgentTranscript` is the single source of truth for "the
 * agent-authored transcript of a Task run". This suite seeds sessions +
 * session_messages directly (superuser, bypassing RLS) and then reads back
 * through the helper (which runs under the owner's RLS trust context) to verify
 * the safety contract:
 *
 *   - Role filter (R2): only `assistant`/`tool` rows; `user`/`system` excluded.
 *   - Run-window + agent-id isolation (R3): a shared bot thread returns only the
 *     queried run's rows; a different `sessions.agent_id` is excluded.
 *   - Peer-owned session (R4): a session owned by another user returns [].
 *   - Tool-call args (R8): `assistant` rows surface parsed `toolCalls`; `tool`
 *     rows are null; malformed `tool_calls` JSON degrades to null (no throw).
 *
 * Sessions are seeded with `room_id = NULL` (the `sessions_path_c` RLS policy
 * lets any authenticated caller read those), so the owner/agent scoping is
 * proven to come from the helper's WHERE clause, not from RLS room membership.
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import {
  createDirectDb,
  ensureDatabase,
  resolveAgentDatabaseConnectionString,
  users,
  agents,
  sessions,
  sessionMessages,
  inArray,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { getRunAgentTranscript, getRunAgentTranscriptSnapshot } from "../../src/store/session-store";

let db: ReturnType<typeof createDirectDb>;
let ownerId: string;
let peerId: string;
let agentA: string;
let agentB: string;
const ts = Date.now().toString(36);

async function seedSession(
  owner: string,
  threadId: string,
  agentId: string,
): Promise<string> {
  const [s] = await db
    .insert(sessions)
    .values({ ownerId: owner, threadId, personaId: "owner", agentId })
    .returning({ id: sessions.id });
  if (!s) throw new Error("seed session failed");
  return s.id;
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);
  if (!process.env["DB_AGENT_DIRECT_CONNECTION"]?.trim()) {
    process.env["DB_AGENT_DIRECT_CONNECTION"] = resolveAgentDatabaseConnectionString();
  }

  const [u] = await db
    .insert(users)
    .values({
      name: `m163-owner-${ts}`,
      email: `m163owner-${ts}@test.local`,
      handle: `m163o${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  const [p] = await db
    .insert(users)
    .values({
      name: `m163-peer-${ts}`,
      email: `m163peer-${ts}@test.local`,
      handle: `m163p${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!u || !p) throw new Error("seed users failed");
  ownerId = u.id;
  peerId = p.id;

  const [aA] = await db
    .insert(agents)
    .values({ handle: `m163-agentA-${ts}` })
    .returning({ id: agents.id });
  const [aB] = await db
    .insert(agents)
    .values({ handle: `m163-agentB-${ts}` })
    .returning({ id: agents.id });
  if (!aA || !aB) throw new Error("seed agents failed");
  agentA = aA.id;
  agentB = aB.id;
});

async function deleteAllSeededSessions(): Promise<void> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(inArray(sessions.ownerId, [ownerId, peerId]));
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, ids));
    await db.delete(sessions).where(inArray(sessions.id, ids));
  }
}

afterEach(async () => {
  await deleteAllSeededSessions();
});

afterAll(async () => {
  if (!db) return;
  try {
    await deleteAllSeededSessions();
    await db.delete(agents).where(inArray(agents.id, [agentA, agentB]));
    await db.delete(users).where(inArray(users.id, [ownerId, peerId]));
  } finally {
    await db.end();
  }
});

describe("getRunAgentTranscript (M163)", () => {
  test("all visible rows beyond500 are returned and a frozen end excludes later appends", async () => {
    const threadId = `subagent:m163-paged-${ts}`;
    const sid = await seedSession(ownerId, threadId, agentA);
    const at = new Date("2024-03-06T10:00:00.000Z");
    await db.insert(sessionMessages).values(Array.from({ length: 503 }, (_, index) => ({
      sessionId: sid, role: index % 2 ? "tool" : "assistant", content: `saved-row-${index}`,
      createdAt: at,
    })));
    const options = { ownerId, graphThreadId: threadId, agentId: agentA, startedAt: null, completedAt: null };
    const initial = await getRunAgentTranscriptSnapshot(options);
    expect(initial.messages).toHaveLength(503);
    expect(new Set(initial.messages.map((row) => row.id)).size).toBe(503);
    expect(initial.messages.at(-1)?.content).toBe("saved-row-502");
    await db.insert(sessionMessages).values({ sessionId: sid, role: "assistant", content: "appended-final-finding", createdAt: at });
    const frozen = await getRunAgentTranscriptSnapshot(options, initial.end);
    expect(frozen).toEqual(initial);
    const full = await getRunAgentTranscript(options);
    expect(full).toHaveLength(504);
    expect(full.at(-1)?.content).toBe("appended-final-finding");
    expect(full.at(-1)).not.toHaveProperty("id");
    expect(await getRunAgentTranscript({ ...options, ownerId: peerId })).toEqual([]);
    expect(await getRunAgentTranscript({ ...options, agentId: agentB })).toEqual([]);
  });

  test("MV1 — role filter: only assistant/tool survive; brief/system/peer-reply dropped", async () => {
    const threadId = `room:m163-mv1-${ts}:bot:${agentA}`;
    const sid = await seedSession(ownerId, threadId, agentA);

    const base = new Date("2024-03-01T10:00:00.000Z").getTime();
    await db.insert(sessionMessages).values([
      { sessionId: sid, role: "user", content: "BRIEF", createdAt: new Date(base) },
      { sessionId: sid, role: "system", content: "SYS PROMPT", createdAt: new Date(base + 1000) },
      { sessionId: sid, role: "assistant", content: "the agent reply", createdAt: new Date(base + 2000) },
      { sessionId: sid, role: "tool", content: "tool output", toolName: "search", createdAt: new Date(base + 3000) },
      { sessionId: sid, role: "user", content: "PEER REPLY", createdAt: new Date(base + 4000) },
    ]);

    const out = await getRunAgentTranscript({
      ownerId,
      graphThreadId: threadId,
      agentId: agentA,
      startedAt: null,
      completedAt: null,
    });

    expect(out.map((m) => m.role)).toEqual(["assistant", "tool"]);
    const contents = out.map((m) => m.content);
    expect(contents).toEqual(["the agent reply", "tool output"]);
    expect(contents).not.toContain("BRIEF");
    expect(contents).not.toContain("SYS PROMPT");
    expect(contents).not.toContain("PEER REPLY");
  });

  test("MV2 — run-window isolation on a shared bot thread", async () => {
    const threadId = `room:m163-mv2-${ts}:bot:${agentA}`;
    const sid = await seedSession(ownerId, threadId, agentA);

    const runAStart = new Date("2024-03-02T10:00:00.000Z");
    const runAEnd = new Date("2024-03-02T10:05:00.000Z");
    await db.insert(sessionMessages).values([
      { sessionId: sid, role: "assistant", content: "runA assistant", createdAt: new Date("2024-03-02T10:01:00.000Z") },
      { sessionId: sid, role: "tool", content: "runA tool", toolName: "x", createdAt: new Date("2024-03-02T10:02:00.000Z") },
      // A later chat turn / sibling run on the SAME (room, agent) bot thread:
      { sessionId: sid, role: "assistant", content: "runB assistant", createdAt: new Date("2024-03-02T11:00:00.000Z") },
    ]);

    const out = await getRunAgentTranscript({
      ownerId,
      graphThreadId: threadId,
      agentId: agentA,
      startedAt: runAStart,
      completedAt: runAEnd,
    });

    expect(out.map((m) => m.content)).toEqual(["runA assistant", "runA tool"]);
  });

  test("MV2 — agent-id filter: rows on the same thread under a different agent are excluded", async () => {
    const threadId = `room:m163-mv2agent-${ts}:bot:${agentB}`;
    // Session is attributed to agentB; querying as agentA must return nothing.
    const sid = await seedSession(ownerId, threadId, agentB);
    await db.insert(sessionMessages).values([
      { sessionId: sid, role: "assistant", content: "other agent's work", createdAt: new Date("2024-03-03T10:00:00.000Z") },
    ]);

    const out = await getRunAgentTranscript({
      ownerId,
      graphThreadId: threadId,
      agentId: agentA,
      startedAt: null,
      completedAt: null,
    });

    expect(out).toEqual([]);
  });

  test("MV3 — peer-owned session returns [] under the requester's context (R4)", async () => {
    const threadId = `room:m163-mv3-${ts}:bot:${agentA}`;
    // Session owned by the PEER (the DM's human member), not the task owner.
    const sid = await seedSession(peerId, threadId, agentA);
    await db.insert(sessionMessages).values([
      { sessionId: sid, role: "assistant", content: "private DM-with-peer reply", createdAt: new Date("2024-03-04T10:00:00.000Z") },
      { sessionId: sid, role: "user", content: "peer's own words", createdAt: new Date("2024-03-04T10:01:00.000Z") },
    ]);

    const out = await getRunAgentTranscript({
      ownerId, // the task owner, NOT the peer
      graphThreadId: threadId,
      agentId: agentA,
      startedAt: null,
      completedAt: null,
    });

    expect(out).toEqual([]);
  });

  test("MV6 — tool-call args: assistant surfaces parsed toolCalls; tool row is null", async () => {
    const threadId = `room:m163-mv6-${ts}:bot:${agentA}`;
    const sid = await seedSession(ownerId, threadId, agentA);
    const toolCalls = JSON.stringify([
      { name: "search", args: { q: "x" }, id: "call_1" },
    ]);
    await db.insert(sessionMessages).values([
      { sessionId: sid, role: "assistant", content: "", toolCalls, createdAt: new Date("2024-03-05T10:00:00.000Z") },
      { sessionId: sid, role: "tool", content: "results", toolName: "search", createdAt: new Date("2024-03-05T10:00:01.000Z") },
    ]);

    const out = await getRunAgentTranscript({
      ownerId,
      graphThreadId: threadId,
      agentId: agentA,
      startedAt: null,
      completedAt: null,
    });

    expect(out).toHaveLength(2);
    expect(out[0]?.role).toBe("assistant");
    expect(out[0]?.toolCalls).toEqual([
      { name: "search", args: { q: "x" }, id: "call_1" },
    ]);
    expect(out[1]?.role).toBe("tool");
    expect(out[1]?.toolCalls).toBeNull();
  });

  test("MV6 — malformed tool_calls JSON degrades to null without throwing", async () => {
    const threadId = `room:m163-mv6bad-${ts}:bot:${agentA}`;
    const sid = await seedSession(ownerId, threadId, agentA);
    await db.insert(sessionMessages).values([
      { sessionId: sid, role: "assistant", content: "still here", toolCalls: "{not json", createdAt: new Date("2024-03-06T10:00:00.000Z") },
    ]);

    const out = await getRunAgentTranscript({
      ownerId,
      graphThreadId: threadId,
      agentId: agentA,
      startedAt: null,
      completedAt: null,
    });

    expect(out).toHaveLength(1);
    expect(out[0]?.content).toBe("still here");
    expect(out[0]?.toolCalls).toBeNull();
  });
});
