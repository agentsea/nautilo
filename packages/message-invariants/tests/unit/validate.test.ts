import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import {
  dedupeToolMessagesByCallId,
  dedupeToolCallIdsWithinAIMessages,
  dedupeToolCallIdsAcrossAIMessages,
  validateMessageHistory,
  finalSafetyNetPass,
} from "../../src/validate.js";

describe("D143 Layer 3 — dedupeToolMessagesByCallId", () => {
  test("L3-DD1: three ToolMessages same tool_call_id keeps latest; repairs idx 0 and 1", () => {
    const a = new ToolMessage({ content: "a", tool_call_id: "X", name: "t" });
    const b = new ToolMessage({ content: "b", tool_call_id: "X", name: "t" });
    const c = new ToolMessage({ content: "c", tool_call_id: "X", name: "t" });
    const { messages, repairs } = dedupeToolMessagesByCallId([a, b, c]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toBe(c);
    expect(repairs).toHaveLength(2);
    expect(repairs[0]).toContain("idx 0");
    expect(repairs[1]).toContain("idx 1");
  });

  test("L3-DD2: no duplicates leaves input unchanged; repairs empty", () => {
    const msgs = [
      new ToolMessage({ content: "1", tool_call_id: "a", name: "t" }),
      new ToolMessage({ content: "2", tool_call_id: "b", name: "t" }),
    ];
    const { messages, repairs } = dedupeToolMessagesByCallId(msgs);
    expect(messages).toEqual(msgs);
    expect(repairs).toEqual([]);
  });

  test("L3-DD3: ToolMessages without tool_call_id are not deduped away", () => {
    const x = new ToolMessage({ content: "x", tool_call_id: "", name: "t" });
    const y = new ToolMessage({ content: "y", tool_call_id: "tmp", name: "t" });
    delete (y as { tool_call_id?: string }).tool_call_id;
    const { messages, repairs } = dedupeToolMessagesByCallId([x, y]);
    expect(messages).toHaveLength(2);
    expect(repairs).toEqual([]);
  });
});

describe("D143 Layer 3 — validateMessageHistory", () => {
  test("L3-VH1: dedupe runs before orphan check — one ToolMessage kept, no orphan repairs", () => {
    const ai = new AIMessage({
      content: "",
      tool_calls: [{ id: "X", name: "search_memory", args: { query: "q" } }],
    });
    const t0 = new ToolMessage({ content: "0", tool_call_id: "X", name: "search_memory" });
    const t1 = new ToolMessage({ content: "1", tool_call_id: "X", name: "search_memory" });
    const t2 = new ToolMessage({ content: "2", tool_call_id: "X", name: "search_memory" });
    const { messages, repairs } = validateMessageHistory([new HumanMessage("h"), ai, t0, t1, t2]);
    const tools = messages.filter((m) => m instanceof ToolMessage);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toBe(t2);
    expect(repairs.some((r) => r.includes("orphan"))).toBe(false);
    expect(repairs.filter((r) => r.startsWith("Dropped duplicate"))).toHaveLength(2);
  });

  test("L3-VH2: still removes orphan ToolMessages", () => {
    const orphan = new ToolMessage({
      content: "result",
      tool_call_id: "nonexistent",
      name: "some_tool",
    });
    const { messages, repairs } = validateMessageHistory([new HumanMessage("hello"), orphan]);
    expect(messages).toHaveLength(1);
    expect(repairs.some((r) => r.includes("orphan"))).toBe(true);
  });

  test("L3-VH3: still repairs AIMessage with unfulfilled tool_calls", () => {
    const ai = new AIMessage({
      content: "",
      tool_calls: [{ id: "tc_1", name: "search_memory", args: { query: "test" } }],
    });
    const { messages, repairs } = validateMessageHistory([new HumanMessage("hello"), ai]);
    expect(repairs.some((r) => r.includes("unfulfilled"))).toBe(true);
    // Empty content + all tool_calls stripped → removeToolCallsFromAIMessage returns null.
    expect(messages).toHaveLength(1);
    expect(messages[0]).toBeInstanceOf(HumanMessage);
  });
});

describe("D143 Layer 3 — finalSafetyNetPass", () => {
  test("L3-FSN1: returns messages array only", () => {
    const out = finalSafetyNetPass([new HumanMessage("x")]);
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(1);
    expect("repairs" in (out as object)).toBe(false);
  });
});

describe("D143 Layer 3 — dedupeToolCallIdsWithinAIMessages (reviewer blocker, within-message)", () => {
  test("L3-DW1: duplicate id within one AIMessage's tool_calls — keeps last occurrence", () => {
    const ai = new AIMessage({
      content: "",
      tool_calls: [
        { id: "X", name: "t1", args: { v: 1 } },
        { id: "Y", name: "t2", args: {} },
        { id: "X", name: "t1", args: { v: 2 } }, // duplicate of position 0 — should win
      ],
    });
    const { messages, repairs } = dedupeToolCallIdsWithinAIMessages([ai]);
    expect(messages).toHaveLength(1);
    const survivor = messages[0] as AIMessage;
    expect(survivor.tool_calls).toHaveLength(2);
    expect(survivor.tool_calls?.map((tc) => tc.id)).toEqual(["Y", "X"]);
    // Survivor's X carries the LATER args (v:2), not v:1.
    expect(survivor.tool_calls?.find((tc) => tc.id === "X")?.args).toEqual({ v: 2 });
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toContain("tc-position 0");
  });

  test("L3-DW2: duplicate id within content tool_use blocks — keeps last occurrence", () => {
    // LangChain typing for `content` is strict — `string | (ContentBlock | Text)[]`.
    // At runtime any structured block array is accepted and passed
    // through verbatim, but the typing rejects free-form blocks. We
    // construct through the strict types and then re-cast on read to
    // verify the dedupe behavior end-to-end.
    const ai = new AIMessage({
      content: "",
      tool_calls: [{ id: "X", name: "t", args: { v: 2 } }],
    });
    (ai as unknown as { content: unknown }).content = [
      { type: "tool_use", id: "X", name: "t", input: { v: 1 } },
      { type: "text", text: "thinking..." },
      { type: "tool_use", id: "X", name: "t", input: { v: 2 } },
    ];
    const { messages, repairs } = dedupeToolCallIdsWithinAIMessages([ai]);
    const survivor = messages[0] as AIMessage;
    expect(Array.isArray(survivor.content)).toBe(true);
    const blocks = survivor.content as Array<{ type: string; id?: string; input?: Record<string, unknown> }>;
    const toolUseBlocks = blocks.filter((b) => b.type === "tool_use");
    expect(toolUseBlocks).toHaveLength(1);
    expect(toolUseBlocks[0]?.input).toEqual({ v: 2 });
    expect(repairs.some((r) => r.includes("content tool_use block"))).toBe(true);
  });

  test("L3-DW3: no duplicates — passes through unchanged (object identity preserved)", () => {
    const ai = new AIMessage({
      content: "",
      tool_calls: [
        { id: "X", name: "t", args: {} },
        { id: "Y", name: "t", args: {} },
      ],
    });
    const { messages, repairs } = dedupeToolCallIdsWithinAIMessages([ai]);
    expect(messages[0]).toBe(ai);
    expect(repairs).toEqual([]);
  });

  test("L3-DW4: non-AIMessage messages pass through untouched", () => {
    const human = new HumanMessage("hi");
    const tool = new ToolMessage({ content: "r", tool_call_id: "X", name: "t" });
    const { messages, repairs } = dedupeToolCallIdsWithinAIMessages([human, tool]);
    expect(messages).toEqual([human, tool]);
    expect(repairs).toEqual([]);
  });
});

describe("D143 Layer 3 — dedupeToolCallIdsAcrossAIMessages (reviewer blocker, across-message)", () => {
  test("L3-DA1: two AIMessages with same tool_call_id — earlier one's tool_call is stripped", () => {
    const a1 = new AIMessage({
      content: "I'll search",
      tool_calls: [{ id: "X", name: "search", args: { q: "first" } }],
    });
    const a2 = new AIMessage({
      content: "Retrying the search",
      tool_calls: [{ id: "X", name: "search", args: { q: "second" } }],
    });
    const { messages, repairs } = dedupeToolCallIdsAcrossAIMessages([a1, a2]);
    expect(messages).toHaveLength(2);
    // a1's tool_call X is stripped; content "I'll search" preserved.
    // LangChain's AIMessage initializes tool_calls to [] rather than
    // leaving it undefined when constructed without tool_calls, so we
    // assert via length-0 not toBeUndefined.
    const survivor1 = messages[0] as AIMessage;
    expect(survivor1.tool_calls ?? []).toHaveLength(0);
    expect(survivor1.content).toBe("I'll search");
    // a2 keeps its tool_call X (it's the latest owner).
    const survivor2 = messages[1] as AIMessage;
    expect(survivor2.tool_calls).toHaveLength(1);
    expect(survivor2.tool_calls?.[0]?.id).toBe("X");
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toContain("Stripped stale tool_call id=X from AIMessage at idx 0");
  });

  test("L3-DA2: AIMessage with empty content + stripped tool_calls is dropped entirely", () => {
    const a1 = new AIMessage({
      content: "",
      tool_calls: [{ id: "X", name: "t", args: {} }],
    });
    const a2 = new AIMessage({
      content: "",
      tool_calls: [{ id: "X", name: "t", args: {} }],
    });
    const { messages, repairs } = dedupeToolCallIdsAcrossAIMessages([a1, a2]);
    // a1 had only the stripped tool_call + empty content → dropped.
    expect(messages).toHaveLength(1);
    expect((messages[0] as AIMessage).tool_calls?.[0]?.id).toBe("X");
    expect(repairs).toHaveLength(1);
  });

  test("L3-DA3: multiple distinct tool_call_ids across messages — none stripped", () => {
    const a1 = new AIMessage({ content: "", tool_calls: [{ id: "A", name: "t", args: {} }] });
    const a2 = new AIMessage({ content: "", tool_calls: [{ id: "B", name: "t", args: {} }] });
    const { messages, repairs } = dedupeToolCallIdsAcrossAIMessages([a1, a2]);
    expect(messages[0]).toBe(a1);
    expect(messages[1]).toBe(a2);
    expect(repairs).toEqual([]);
  });

  test("L3-DA4: partial overlap — AIMessage with [X, Y] followed by AIMessage with [X] keeps Y in first, X in second", () => {
    const a1 = new AIMessage({
      content: "",
      tool_calls: [
        { id: "X", name: "t1", args: {} },
        { id: "Y", name: "t2", args: {} },
      ],
    });
    const a2 = new AIMessage({
      content: "",
      tool_calls: [{ id: "X", name: "t1", args: { retry: true } }],
    });
    const { messages, repairs } = dedupeToolCallIdsAcrossAIMessages([a1, a2]);
    const survivor1 = messages[0] as AIMessage;
    expect(survivor1.tool_calls?.map((tc) => tc.id)).toEqual(["Y"]);
    const survivor2 = messages[1] as AIMessage;
    expect(survivor2.tool_calls?.map((tc) => tc.id)).toEqual(["X"]);
    expect(repairs).toHaveLength(1);
  });
});

describe("D143 Layer 3 — validateMessageHistory composed (reviewer blocker)", () => {
  test("L3-VH4: approval-resume bug shape — two AIMessages + two ToolMessages with same tool_call_id → exactly one of each survives", () => {
    // This is the exact shape the reviewer caught: existing dedupe
    // collapsed the two ToolMessages to one, but the earlier
    // AIMessage was left with a stale tool_call pointing at a
    // deduped-away ToolMessage. Anthropic 400. Now both sides
    // dedupe.
    const a1 = new AIMessage({
      content: "First attempt",
      tool_calls: [{ id: "toolu_DUP", name: "run_shell", args: { cmd: "echo a" } }],
    });
    const t1 = new ToolMessage({ content: "first", tool_call_id: "toolu_DUP", name: "run_shell" });
    const a2 = new AIMessage({
      content: "Retry attempt",
      tool_calls: [{ id: "toolu_DUP", name: "run_shell", args: { cmd: "echo b" } }],
    });
    const t2 = new ToolMessage({ content: "second", tool_call_id: "toolu_DUP", name: "run_shell" });
    const { messages, repairs } = validateMessageHistory([new HumanMessage("user"), a1, t1, a2, t2]);

    // Count unique tool_use sources across the final array.
    const toolUseOwners = messages
      .filter((m): m is AIMessage => m instanceof AIMessage && Boolean(m.tool_calls?.length))
      .flatMap((m) => m.tool_calls?.map((tc) => tc.id) ?? []);
    const toolResults = messages
      .filter((m): m is ToolMessage => m instanceof ToolMessage)
      .map((m) => m.tool_call_id);

    // Exactly one AIMessage owns tool_call_id "toolu_DUP".
    expect(toolUseOwners.filter((id) => id === "toolu_DUP")).toHaveLength(1);
    // Exactly one ToolMessage carries "toolu_DUP".
    expect(toolResults.filter((id) => id === "toolu_DUP")).toHaveLength(1);
    // The LATER pair wins: a2's args (cmd: echo b) and t2's content (second).
    const survivor = messages.find(
      (m) => m instanceof AIMessage && (m.tool_calls ?? []).some((tc) => tc.id === "toolu_DUP"),
    ) as AIMessage;
    expect(survivor.tool_calls?.[0]?.args).toEqual({ cmd: "echo b" });
    const survivorTool = messages.find(
      (m) => m instanceof ToolMessage && m.tool_call_id === "toolu_DUP",
    ) as ToolMessage;
    expect(survivorTool.content).toBe("second");
    // Repairs log BOTH sides (ToolMessage dedupe + AIMessage tool_call strip).
    expect(repairs.some((r) => r.includes("Dropped duplicate ToolMessage"))).toBe(true);
    expect(repairs.some((r) => r.includes("Stripped stale tool_call"))).toBe(true);
  });

  test("L3-VH6 (reviewer follow-up): content-only tool_use block (no parallel tool_calls[]) is recognized as a tool_use source — its ToolMessage pair is NOT marked orphan", () => {
    // Defense-in-depth case: a hypothetical AIMessage where the raw
    // Anthropic-wire `tool_use` content block carries id "Y" but the
    // parallel LangChain `tool_calls[]` field is empty. In the current
    // production pipeline this shape is impossible — the Anthropic
    // adapter populates both surfaces in parallel. But a future
    // provider adapter or manual construction could produce it. The
    // validator must NOT mistake the ToolMessage pair for an orphan.
    const aiContentOnly = new AIMessage({
      content: "",
      tool_calls: [],
    });
    (aiContentOnly as unknown as { content: unknown }).content = [
      { type: "text", text: "calling tool" },
      { type: "tool_use", id: "Y", name: "search", input: { q: "hi" } },
    ];
    const tY = new ToolMessage({ content: "result", tool_call_id: "Y", name: "search" });
    const { messages, repairs } = validateMessageHistory([
      new HumanMessage("hi"),
      aiContentOnly,
      tY,
    ]);
    // ToolMessage Y is NOT orphan-removed — content-only source recognized.
    expect(messages.some((m) => m instanceof ToolMessage && m.tool_call_id === "Y")).toBe(true);
    // No orphan repair logged for Y.
    expect(repairs.some((r) => r.includes("orphan"))).toBe(false);
  });

  test("L3-VH5: stale tool_call left behind after ToolMessage dedupe — earlier AIMessage's tool_call IS stripped (not left as unfulfilled)", () => {
    // Verifies the FIX is in step 3 (across-AIMessages dedupe), NOT
    // only in step 4 (unfulfilled-strip). The difference: across-
    // AIMessages preserves the LATER AIMessage's content + tool_call
    // intact; unfulfilled-strip would strip from the LATER one too
    // because both would look unfulfilled at the toolCallInfo
    // overwrite step.
    const a1 = new AIMessage({
      content: "First attempt",
      tool_calls: [{ id: "X", name: "t", args: {} }],
    });
    const a2 = new AIMessage({
      content: "Second attempt",
      tool_calls: [{ id: "X", name: "t", args: {} }],
    });
    const t = new ToolMessage({ content: "ok", tool_call_id: "X", name: "t" });
    const { messages } = validateMessageHistory([a1, a2, t]);
    // a1 stripped of tool_call X but content "First attempt" survives.
    const first = messages.find((m) => m instanceof AIMessage && m.content === "First attempt") as AIMessage | undefined;
    expect(first).toBeDefined();
    expect(first?.tool_calls ?? []).toHaveLength(0);
    // a2 keeps its tool_call X, paired with the ToolMessage.
    const second = messages.find((m) => m instanceof AIMessage && m.content === "Second attempt") as AIMessage | undefined;
    expect(second).toBeDefined();
    expect(second?.tool_calls?.[0]?.id).toBe("X");
    // Final state: 3 messages (a1-stripped, a2-with-tc, t).
    expect(messages).toHaveLength(3);
  });
});
