/**
 * M169 (R1 + R2) — unit coverage for the DORMANT subagent-run transcript
 * reader. `readSubagentRunTranscript` maps the agent-authored run transcript
 * (`getRunAgentTranscript` rows) → labelled `RoomHistoryHit[]` via the M166
 * `runAgentTranscriptToHits` helper. All DB lookups are injected so this runs
 * with no server / DB / API keys.
 *
 * Invariants asserted:
 *   - empty run → `[]` (no agent-authored rows).
 *   - assistant + tool rows render with the agent's display name + `@handle`,
 *     `tool:<name>` narration, ISO-UTC time, and NEVER a raw uuid.
 *   - display name COALESCEs to "Genie" (M156 seed Agent), NOT "Agent".
 *   - a missing handle falls back to "" (never a raw agent id).
 *   - a throwing display-name / handle lookup degrades to the fallbacks.
 *   - feeds `buildTranscriptContext({kind:"subagent"})` to one composite
 *     `HumanMessage` when wired through the injected `readSubagentTranscript`.
 */
import { describe, test, expect } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { ROOM_CONTEXT_MESSAGE_HEADER, type RunAgentTranscriptMessage } from "@nautilo/agent";
import {
  buildTranscriptContext,
  readSubagentRunTranscript,
  type BuildTranscriptContextDeps,
  type ReadSubagentRunTranscriptDeps,
  type TranscriptContextScope,
} from "@nautilo/runtime";

const SUBAGENT_SCOPE: Extract<TranscriptContextScope, { kind: "subagent" }> = {
  kind: "subagent",
  graphThreadId: "subagent:parent:run-1",
  ownerId: "owner-1",
  agentId: "agent-1",
  startedAt: null,
  completedAt: null,
};

const TWO_ROWS: RunAgentTranscriptMessage[] = [
  {
    role: "assistant",
    content: "I will search the memory now",
    toolName: null,
    toolCalls: null,
    createdAt: new Date("2026-06-01T10:00:00Z"),
  },
  {
    role: "tool",
    content: "found 3 matching notes",
    toolName: "search_memory",
    toolCalls: null,
    createdAt: new Date("2026-06-01T10:00:01Z"),
  },
];

function fakeDeps(opts: {
  rows?: RunAgentTranscriptMessage[];
  displayName?: string | null;
  handle?: string | null;
  displayNameThrows?: boolean;
  handleThrows?: boolean;
}): ReadSubagentRunTranscriptDeps {
  return {
    getRunAgentTranscript: async () => opts.rows ?? [],
    getAgentDisplayNameById: async () => {
      if (opts.displayNameThrows) throw new Error("display name lookup failed");
      return opts.displayName ?? null;
    },
    getAgentHandleById: async () => {
      if (opts.handleThrows) throw new Error("handle lookup failed");
      return opts.handle ?? null;
    },
  };
}

describe("readSubagentRunTranscript (M169 R1/R2)", () => {
  test("empty run → []", async () => {
    const hits = await readSubagentRunTranscript(SUBAGENT_SCOPE, fakeDeps({ rows: [] }));
    expect(hits).toEqual([]);
  });

  test("maps assistant + tool rows with display name + @handle + ISO time, no raw ids", async () => {
    const hits = await readSubagentRunTranscript(
      SUBAGENT_SCOPE,
      fakeDeps({ rows: TWO_ROWS, displayName: "Nova", handle: "nova" }),
    );
    expect(hits).toHaveLength(2);
    expect(hits[0]!.authorDisplayName).toBe("Nova");
    expect(hits[0]!.handle).toBe("nova");
    expect(hits[0]!.snippet).toContain("I will search the memory now");
    expect(hits[1]!.snippet).toContain("tool:search_memory");
    expect(hits[1]!.snippet).toContain("found 3 matching notes");
    expect(hits[0]!.ts.toISOString()).toBe("2026-06-01T10:00:00.000Z");
    // Labels never carry a raw agent uuid.
    for (const h of hits) {
      expect(h.snippet).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      );
    }
  });

  test("null display name COALESCEs to 'Genie' (M156), NOT 'Agent'", async () => {
    const hits = await readSubagentRunTranscript(
      SUBAGENT_SCOPE,
      fakeDeps({ rows: TWO_ROWS, displayName: null, handle: "genie" }),
    );
    expect(hits[0]!.authorDisplayName).toBe("Genie");
    expect(hits[0]!.authorDisplayName).not.toBe("Agent");
  });

  test("null handle falls back to '' (never a raw agent id)", async () => {
    const hits = await readSubagentRunTranscript(
      SUBAGENT_SCOPE,
      fakeDeps({ rows: TWO_ROWS, displayName: "Nova", handle: null }),
    );
    expect(hits[0]!.handle).toBe("");
  });

  test("throwing display-name / handle lookups degrade to fallbacks", async () => {
    const hits = await readSubagentRunTranscript(
      SUBAGENT_SCOPE,
      fakeDeps({ rows: TWO_ROWS, displayNameThrows: true, handleThrows: true }),
    );
    expect(hits[0]!.authorDisplayName).toBe("Genie");
    expect(hits[0]!.handle).toBe("");
  });

  test("wired through buildTranscriptContext({kind:'subagent'}) → one composite HumanMessage", async () => {
    const deps: BuildTranscriptContextDeps = {
      readRoomTranscript: async () => [],
      readSubagentTranscript: (scope) =>
        readSubagentRunTranscript(
          scope,
          fakeDeps({ rows: TWO_ROWS, displayName: "Genie", handle: "genie" }),
        ),
    };
    const result = await buildTranscriptContext({ scope: SUBAGENT_SCOPE }, deps);
    expect(result).toHaveLength(1);
    expect(HumanMessage.isInstance(result[0])).toBe(true);
    const content = result[0]!.content as string;
    expect(content.startsWith(ROOM_CONTEXT_MESSAGE_HEADER)).toBe(true);
    expect(content).toContain("I will search the memory now");
    expect(content).toContain("tool:search_memory");
    expect(content).toMatch(/\(@genie\):/);
  });
});
