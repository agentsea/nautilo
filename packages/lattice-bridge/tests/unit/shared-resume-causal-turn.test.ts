import { describe, expect, test } from "bun:test";
import type { PostgresJsBridgeConnection } from "@nautilo/db";
import { LatticeCrypto, humanAiReadableLiveShadowExecutionInputSetDigest } from "@nautilo/lattice-crypto";
import { PostgresSharedAgentLiveShadowPlanner } from "../../src/server/message/postgres-shared-agent-live-shadow-plan.ts";

const coordinates = [
  { operationId: "human-first", messageId: 41, inputOrdinal: 1 },
  { operationId: "human-second", messageId: 42, inputOrdinal: 2 },
];
const crypto = new LatticeCrypto();
const digest = humanAiReadableLiveShadowExecutionInputSetDigest(crypto, coordinates);
const request = {
  executionId: "resume-execution",
  sessionId: "10000000-0000-4000-8000-000000000001",
  roomId: "20000000-0000-4000-8000-000000000001",
  agentId: "30000000-0000-4000-8000-000000000001",
  subjectHumanId: "human:caller",
  subjectUserId: "40000000-0000-4000-8000-000000000001",
  policyRevision: 6,
};

function fixture(change?: (rows: Record<string, unknown>[]) => void) {
  const rows: Record<string, unknown>[] = coordinates.map((entry) => ({
    operation_id: entry.operationId,
    message_id: entry.messageId,
    input_ordinal: entry.inputOrdinal,
    human_turn_id: entry.operationId,
    input_count: 2,
    input_set_digest: digest.slice(),
    invocation_input_count: 2,
    invocation_input_set_digest: digest.slice(),
  }));
  change?.(rows);
  let sql = "";
  const product = { query: async (statement: string) => { sql = statement; return rows; } } as unknown as PostgresJsBridgeConnection;
  const planner = new PostgresSharedAgentLiveShadowPlanner(product, product, undefined, null, { serverId: "test" });
  return { planner, sql: () => sql };
}

describe("resume causal Human lineage", () => {
  test("uses the last original Human input, never the resume operation", async () => {
    const f = fixture();
    expect(await f.planner.loadResumeCausalHumanTurnId(request)).toBe("human-second");
    expect(f.sql()).not.toContain('"content"');
    for (const field of ["execution_kind", "invocation_id", "owner_id", "transcript_origin", "subject_human_id", "human_message_id", "session_id", "room_id", "agent_id"]) {
      expect(f.sql()).toContain(field);
    }
  });
  test("requires consistent source session, source policy, and live invocation in SQL", async () => {
    const f = fixture();
    await f.planner.loadResumeCausalHumanTurnId(request);
    expect(f.sql()).toContain('"session_messages"."session_id" = "conversation_shared_agent_shadow_operations"."session_id"');
    expect(f.sql()).toContain('"conversation_shared_agent_shadow_operations"."policy_revision" = "conversation_shared_agent_shadow_executions"."policy_revision"');
    expect(f.sql()).toContain('"conversation_shared_agent_shadow_invocations"."state" in');
  });
  test.each([
    ["missing input", (rows: Record<string, unknown>[]) => { rows.pop(); }],
    ["ambiguous ordinal", (rows: Record<string, unknown>[]) => { rows[1]!["input_ordinal"] = 1; }],
    ["changed input digest", (rows: Record<string, unknown>[]) => { rows[0]!["input_set_digest"] = new Uint8Array(32); }],
    ["invocation mismatch", (rows: Record<string, unknown>[]) => { rows[0]!["invocation_input_set_digest"] = new Uint8Array(32); }],
    ["wrong Human message identity", (rows: Record<string, unknown>[]) => { rows[1]!["human_turn_id"] = "other-turn"; }],
    ["absent lineage", (rows: Record<string, unknown>[]) => { rows.length = 0; }],
  ])("fails closed on %s", async (_label, change) => {
    expect(await fixture(change).planner.loadResumeCausalHumanTurnId(request)).toBeNull();
  });
});
