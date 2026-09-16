/**
 * D246 Wave 3 regression test — synchronized transcript sizing.
 *
 * Models a room load/reset where the legacy runtime message array is AHEAD of
 * assistant-ui's synchronized AUI client lookup, and proves that sourcing the
 * transcript count + keys from the synchronized AUI state (the lookup itself)
 * guarantees `ThreadPrimitive.MessageByIndex` never requests an out-of-bounds
 * index from an empty (or shorter) lookup — the `tapClientLookup: Index 0 out
 * of bounds (length: 0)` crash observed on a deployed instance after de0a8e8e8.
 *
 * The fix mirrors upstream `ThreadPrimitive.Messages` (subscribe to
 * `useAuiState((s) => s.thread.messages.length)`), NOT a try/catch around the
 * throw. The test asserts both halves: the synchronized path never throws, and
 * the legacy "size off the runtime array" path WOULD throw — establishing the
 * regression is real and the fix addresses it.
 */
import { describe, expect, test } from "bun:test";
import {
  deriveTranscriptSync,
  renderIndicesForCount,
  type TranscriptMessageLike,
} from "./conversation-transcript-sync";

/**
 * Faithful model of assistant-ui's `tapClientLookup.get({ index })` — the exact
 * throw the production AppErrorBoundary surfaced (`useClientLookup: Index N out
 * of bounds (length: L)`; upstream names it `tapClientLookup`). See
 * EXTERNAL/assistant-ui/packages/store/src/tapClientLookup.ts.
 */
function makeLookup(length: number): {
  length: number;
  get: (index: number) => string;
} {
  return {
    length,
    get(index: number): string {
      if (index < 0 || index >= length) {
        throw new Error(
          `tapClientLookup: Index ${index} out of bounds (length: ${length})`,
        );
      }
      return `msg-${index}`;
    },
  };
}

/** Model of `ThreadPrimitive.MessageByIndex` resolving through the lookup. */
function renderRow(lookup: { get: (index: number) => string }, index: number): string {
  return lookup.get(index);
}

const runtimeAhead: readonly TranscriptMessageLike[] = [
  { id: "r1" },
  { id: "r2" },
  { id: "r3" },
];

describe("deriveTranscriptSync (synchronized sizing)", () => {
  test("empty synchronized lookup → count 0, no keys, no rows rendered", () => {
    const synchronizedMessages: readonly TranscriptMessageLike[] = [];
    const plan = deriveTranscriptSync(synchronizedMessages);
    expect(plan.count).toBe(0);
    expect(plan.keys).toEqual([]);
    expect(plan.latestMessageId).toBeNull();
    expect(renderIndicesForCount(plan.count)).toEqual([]);
  });

  test("derivation ignores the runtime array entirely (only synchronized ids)", () => {
    const synchronizedMessages: readonly TranscriptMessageLike[] = [
      { id: "s1" },
      { id: "s2" },
    ];
    const plan = deriveTranscriptSync(synchronizedMessages);
    expect(plan.count).toBe(2);
    expect(plan.keys).toEqual(["s1", "s2"]);
    expect(plan.latestMessageId).toBe("s2");
  });
});

describe("D246 Wave 3 regression — runtime ahead of synchronized AUI lookup", () => {
  test("synchronized path: index 0 is never requested from an empty lookup", () => {
    // Room reset just fired: runtime has already seeded 3 messages, but the
    // synchronized AUI client lookup is still empty (length: 0).
    const lookup = makeLookup(0);

    // The fix: size off the SYNCHRONIZED messages, not the runtime array.
    const synchronizedMessages: readonly TranscriptMessageLike[] = [];
    const plan = deriveTranscriptSync(synchronizedMessages);

    // Sanity: the runtime array is ahead, but the synchronized count is 0.
    expect(runtimeAhead.length).toBe(3);
    expect(plan.count).toBe(0);

    const indices = renderIndicesForCount(plan.count);
    expect(indices).toEqual([]);

    // TranscriptWindow would call renderRow for each index. With count 0 it
    // calls none, so the empty lookup is never touched.
    let threw: Error | null = null;
    try {
      for (const i of indices) renderRow(lookup, i);
    } catch (err) {
      threw = err as Error;
    }
    expect(threw).toBeNull();
  });

  test("synchronized path never requests an out-of-bounds index as the lookup catches up", () => {
    // The lookup rebuilds incrementally while the runtime stays 3-deep.
    const stages: Array<readonly TranscriptMessageLike[]> = [
      [],
      [{ id: "s1" }],
      [{ id: "s1" }, { id: "s2" }],
      [{ id: "s1" }, { id: "s2" }, { id: "s3" }],
    ];

    for (const synchronizedMessages of stages) {
      const lookup = makeLookup(synchronizedMessages.length);
      const plan = deriveTranscriptSync(synchronizedMessages);
      // Invariant: the count handed to the window IS the lookup length.
      expect(plan.count).toBe(lookup.length);

      const indices = renderIndicesForCount(plan.count);
      // Every rendered index must be within the lookup.
      for (const i of indices) {
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(lookup.length);
        // Resolves without throwing.
        expect(() => renderRow(lookup, i)).not.toThrow();
      }
    }
  });

  test("legacy path (size off the runtime array) WOULD throw — the regression is real", () => {
    // The pre-fix code did `useThread((s) => s.messages)` and passed
    // `count={messages.length}` to TranscriptWindow. Model that: size off the
    // runtime array while the synchronized lookup is still empty.
    const lookup = makeLookup(0);
    const legacyCount = runtimeAhead.length; // 3 — sourced from the runtime thread
    const indices = renderIndicesForCount(legacyCount);

    expect(indices).toEqual([0, 1, 2]);

    // Index 0 against an empty lookup reproduces the production crash.
    let thrown: Error | null = null;
    try {
      for (const i of indices) renderRow(lookup, i);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown?.message).toBe(
      "tapClientLookup: Index 0 out of bounds (length: 0)",
    );
  });

  test("keys are derived from synchronized ids, so getItemKey stays in-sync with the lookup", () => {
    const synchronizedMessages: readonly TranscriptMessageLike[] = [
      { id: 7 },
      { id: 11 },
      { id: "abc" },
    ];
    const plan = deriveTranscriptSync(synchronizedMessages);
    expect(plan.keys).toEqual(["7", "11", "abc"]);
    // getItemKey fallback mirrors ConversationTranscript's own fallback.
    const getItemKey = (index: number): string => plan.keys[index] ?? String(index);
    expect(getItemKey(0)).toBe("7");
    expect(getItemKey(2)).toBe("abc");
    expect(getItemKey(99)).toBe("99");
  });

  test("takes tail identity from the synchronized canonical order", () => {
    const plan = deriveTranscriptSync([
      { id: "optimistic" },
      { id: "42" },
      { id: "84" },
    ]);
    expect(plan.keys).toEqual(["optimistic", "42", "84"]);
    expect(plan.latestMessageId).toBe("84");
  });
});
