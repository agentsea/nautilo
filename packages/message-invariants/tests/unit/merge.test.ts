import { describe, expect, test } from "bun:test";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { mergeMessagesPreservingInvariants } from "../../src/merge.js";

describe("mergeMessagesPreservingInvariants (D143 L2)", () => {
  test("L2-M1: right ToolMessage wins on same tool_call_id", () => {
    const left: BaseMessage[] = [
      new ToolMessage({ content: "old", tool_call_id: "X", name: "t" }),
    ];
    const right: BaseMessage[] = [
      new ToolMessage({ content: "new", tool_call_id: "X", name: "t" }),
    ];
    const out = mergeMessagesPreservingInvariants(left, right);
    expect(out).toHaveLength(1);
    expect(out[0]).toBeInstanceOf(ToolMessage);
    expect((out[0] as ToolMessage).content).toBe("new");
    expect((out[0] as ToolMessage).tool_call_id).toBe("X");
  });

  test("L2-M2: non-ToolMessage rows pass through without dedupe", () => {
    const h = new HumanMessage("hi");
    const a1 = new AIMessage("one");
    const a2 = new AIMessage("two");
    const left: BaseMessage[] = [h, a1];
    const right: BaseMessage[] = [a2];
    const out = mergeMessagesPreservingInvariants(left, right);
    expect(out).toEqual([h, a1, a2]);
  });

  test("L2-M3: ToolMessages without tool_call_id are kept on both sides", () => {
    const tmL = new ToolMessage({ content: "L", tool_call_id: "", name: "n" });
    const tmR = new ToolMessage({ content: "R", tool_call_id: "", name: "n" });
    const out = mergeMessagesPreservingInvariants([tmL], [tmR]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(tmL);
    expect(out[1]).toBe(tmR);
  });

  test("L2-M4: empty left returns right unchanged", () => {
    const right: BaseMessage[] = [new HumanMessage("x")];
    expect(mergeMessagesPreservingInvariants([], right)).toEqual(right);
  });

  test("L2-M5: empty right returns left unchanged", () => {
    const left: BaseMessage[] = [new HumanMessage("x")];
    expect(mergeMessagesPreservingInvariants(left, [])).toEqual(left);
  });

  test("L2-M6: selective ToolMessage replacement + append", () => {
    const tA = new ToolMessage({ content: "A", tool_call_id: "A", name: "n" });
    const tBleft = new ToolMessage({
      content: "B-left",
      tool_call_id: "B",
      name: "n",
    });
    const tC = new ToolMessage({ content: "C", tool_call_id: "C", name: "n" });
    const tBright = new ToolMessage({
      content: "B-right",
      tool_call_id: "B",
      name: "n",
    });
    const tD = new ToolMessage({ content: "D", tool_call_id: "D", name: "n" });
    const left: BaseMessage[] = [tA, tBleft, tC];
    const right: BaseMessage[] = [tBright, tD];
    const out = mergeMessagesPreservingInvariants(left, right);
    expect(out.map((m) => (m as ToolMessage).content)).toEqual([
      "A",
      "C",
      "B-right",
      "D",
    ]);
  });

  test("L2-M7 (reviewer blocker): right AIMessage tool_call collides with left AIMessage tool_call — left's tool_call stripped, content preserved", () => {
    const aLeft = new AIMessage({
      content: "left-side reasoning before the tool call",
      tool_calls: [{ id: "X", name: "search", args: { q: "old" } }],
    });
    const aRight = new AIMessage({
      content: "right-side reasoning",
      tool_calls: [{ id: "X", name: "search", args: { q: "new" } }],
    });
    const tRight = new ToolMessage({ content: "result", tool_call_id: "X", name: "search" });
    const out = mergeMessagesPreservingInvariants([aLeft], [aRight, tRight]);
    // aLeft survives with content but no tool_call (X stripped because right owns it).
    expect(out).toHaveLength(3);
    expect((out[0] as AIMessage).content).toBe("left-side reasoning before the tool call");
    expect((out[0] as AIMessage).tool_calls ?? []).toHaveLength(0);
    expect(out[1]).toBe(aRight);
    expect(out[2]).toBe(tRight);
  });

  test("L2-M8 (reviewer blocker, fork-splice happy path): RIGHT ToolMessage supersedes LEFT ToolMessage for same id; LEFT AIMessage source preserved", () => {
    // Models the approval-resume + fork-splice case: parent has
    // [A1(tc=X), T1(X)] and the fork emits [T2(X)] as its splice
    // suffix (newer tool response for the SAME assistant tool_call).
    // RIGHT has NO AIMessage source for X, so the merge is NOT a
    // collision with A1's tool_call — A1 stays the source, and the
    // newer T2 replaces the older T1. This is the correct
    // class-aware semantic; an earlier mis-implementation stripped
    // A1's tool_call too, which would have broken the happy-path
    // call site in nodes/tools.ts.
    const a1 = new AIMessage({
      content: "I'll run the shell command",
      tool_calls: [{ id: "X", name: "run_shell", args: { cmd: "ls" } }],
    });
    const t1 = new ToolMessage({ content: "old-output", tool_call_id: "X", name: "run_shell" });
    const t2 = new ToolMessage({ content: "new-output", tool_call_id: "X", name: "run_shell" });
    const out = mergeMessagesPreservingInvariants([a1, t1], [t2]);
    expect(out).toHaveLength(2);
    // A1 kept INTACT with its tool_call X (pairs with t2 across the merge boundary).
    expect(out[0]).toBe(a1);
    expect((out[0] as AIMessage).tool_calls?.[0]?.id).toBe("X");
    // T1 dropped (right has fresher T2 for same id). T2 kept.
    expect(out[1]).toBe(t2);
  });

  test("L2-M9 (happy-path call-site sanity): LEFT AIMessage source + RIGHT ToolMessage response with same id — NOT a collision; both kept", () => {
    // This is the literal shape every call to
    // `mergeMessagesPreservingInvariants(state.messages, results)` in
    // nodes/tools.ts produces: LEFT has the assistant turn that
    // emitted the tool_calls; RIGHT has the freshly-executed
    // ToolMessages pairing with them. The merge must NOT strip the
    // LEFT AIMessage's tool_calls. If this test fails, every tool
    // invocation in the agent breaks.
    const aLeft = new AIMessage({
      content: "running the tool",
      tool_calls: [{ id: "X", name: "t", args: {} }],
    });
    const tRight = new ToolMessage({ content: "result", tool_call_id: "X", name: "t" });
    const out = mergeMessagesPreservingInvariants([aLeft], [tRight]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(aLeft);
    expect((out[0] as AIMessage).tool_calls?.[0]?.id).toBe("X");
    expect(out[1]).toBe(tRight);
  });

  test("L2-M10: LEFT AIMessage with multiple tool_calls + RIGHT ToolMessages for some — LEFT AIMessage preserved unchanged (happy path; tool_calls pair across boundary)", () => {
    // RIGHT carries only ToolMessages, no AIMessage source. So no
    // tool_call collision with LEFT AIMessage; LEFT's tool_calls all
    // stay intact. Unfulfilled ones (Y) get repaired later by the L3
    // final-safety-net pass, not by the merge.
    const aLeft = new AIMessage({
      content: "doing multiple things",
      tool_calls: [
        { id: "X", name: "t1", args: {} },
        { id: "Y", name: "t2", args: {} },
        { id: "Z", name: "t3", args: {} },
      ],
    });
    const tRightX = new ToolMessage({ content: "x", tool_call_id: "X", name: "t1" });
    const tRightZ = new ToolMessage({ content: "z", tool_call_id: "Z", name: "t3" });
    const out = mergeMessagesPreservingInvariants([aLeft], [tRightX, tRightZ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(aLeft);
    // ALL three tool_calls preserved on aLeft. Y is unfulfilled here;
    // L3 repairs it. Merge is not responsible for orphan repair.
    expect((out[0] as AIMessage).tool_calls?.map((tc) => tc.id)).toEqual(["X", "Y", "Z"]);
  });

  test("L2-M11 (reviewer blocker, true AIMessage source collision): RIGHT AIMessage with same tool_call_id as LEFT AIMessage — LEFT's tool_call IS stripped", () => {
    // This IS a real collision: two AIMessages on different sides of
    // the merge boundary claiming the same tool_call_id. Right wins,
    // left's tool_call gets stripped. If LEFT's AIMessage retains
    // other content, the message survives with stripped tool_calls;
    // if it had only the tool_call + empty content, it gets dropped.
    const aLeftWithContent = new AIMessage({
      content: "first try",
      tool_calls: [{ id: "X", name: "t", args: {} }],
    });
    const aRight = new AIMessage({
      content: "retry",
      tool_calls: [{ id: "X", name: "t", args: { retry: true } }],
    });
    const tRight = new ToolMessage({ content: "result", tool_call_id: "X", name: "t" });
    const out1 = mergeMessagesPreservingInvariants([aLeftWithContent], [aRight, tRight]);
    expect(out1).toHaveLength(3);
    // LEFT AIMessage survives with content, but tool_calls stripped.
    expect((out1[0] as AIMessage).content).toBe("first try");
    expect((out1[0] as AIMessage).tool_calls ?? []).toHaveLength(0);
    expect(out1[1]).toBe(aRight);
    expect(out1[2]).toBe(tRight);

    // Variant: LEFT AIMessage had empty content + only the tool_call → dropped entirely.
    const aLeftEmpty = new AIMessage({
      content: "",
      tool_calls: [{ id: "Y", name: "t", args: {} }],
    });
    const aRightY = new AIMessage({
      content: "retry",
      tool_calls: [{ id: "Y", name: "t", args: { retry: true } }],
    });
    const tRightY = new ToolMessage({ content: "result", tool_call_id: "Y", name: "t" });
    const out2 = mergeMessagesPreservingInvariants([aLeftEmpty], [aRightY, tRightY]);
    expect(out2).toHaveLength(2);
    expect(out2[0]).toBe(aRightY);
    expect(out2[1]).toBe(tRightY);
  });
});
