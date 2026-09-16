import { describe, expect, test } from "bun:test";

import { mergeTextHumanPriority } from "../../src/human-priority-text-merge";

const merge = (base: string, humanDraft: string, agentPostimage: string) =>
  mergeTextHumanPriority({ base, humanDraft, agentPostimage });

describe("mergeTextHumanPriority", () => {
  test("returns the shared text when both sides are identical", () => {
    expect(merge("base\n", "same\n", "same\n")).toEqual({
      ok: true,
      text: "same\n",
      strategy: "identical",
    });
  });

  test("returns the agent postimage when the human draft is unchanged", () => {
    expect(merge("base\n", "base\n", "agent\n")).toEqual({
      ok: true,
      text: "agent\n",
      strategy: "human_unchanged",
    });
  });

  test("returns the human draft when the agent postimage is unchanged", () => {
    expect(merge("base\n", "human\n", "base\n")).toEqual({
      ok: true,
      text: "human\n",
      strategy: "agent_unchanged",
    });
  });

  test("combines disjoint line updates", () => {
    expect(merge("one\ntwo\nthree\n", "ONE\ntwo\nthree\n", "one\ntwo\nTHREE\n")).toMatchObject({
      ok: true,
      text: "ONE\ntwo\nTHREE\n",
    });
  });

  test("combines adjacent independent insertions", () => {
    expect(merge("one\ntwo\n", "human\none\ntwo\n", "one\nagent\ntwo\n")).toMatchObject({
      ok: true,
      text: "human\none\nagent\ntwo\n",
    });
  });

  test("returns a conflict for different insertions at the same location", () => {
    expect(merge("one\ntwo\n", "one\nhuman\ntwo\n", "one\nagent\ntwo\n")).toEqual({
      ok: false,
      reason: "conflict",
    });
  });

  test("accepts an identical insertion", () => {
    expect(merge("one\ntwo\n", "one\nshared\ntwo\n", "one\nshared\ntwo\n")).toEqual({
      ok: true,
      text: "one\nshared\ntwo\n",
      strategy: "identical",
    });
  });

  test("accepts an identical update through the common postimage fast path", () => {
    expect(merge("one\ntwo\n", "one\nTWO\n", "one\nTWO\n")).toEqual({
      ok: true,
      text: "one\nTWO\n",
      strategy: "identical",
    });
  });

  test("accepts an identical deletion", () => {
    expect(merge("one\ntwo\nthree\n", "one\nthree\n", "one\nthree\n")).toEqual({
      ok: true,
      text: "one\nthree\n",
      strategy: "identical",
    });
  });

  test("returns a marker-free conflict for different overlapping updates", () => {
    const result = merge("one\ntwo\n", "one\nhuman\n", "one\nagent\n");
    expect(result).toEqual({ ok: false, reason: "conflict" });
    expect(JSON.stringify(result)).not.toContain("<<<<<<<");
  });

  test("does not let tolerant smart-quote matching admit an authoritative overlap", () => {
    expect(merge(
      'quote: "base"\n',
      'quote: "human"\n',
      "quote: \u201cbase\u201d\n",
    )).toEqual({ ok: false, reason: "conflict" });
  });

  test("does not let en/em dash normalization admit an authoritative overlap", () => {
    expect(merge(
      "range: a-b\n",
      "range: a-H\n",
      "range: a\u2014b\n",
    )).toEqual({ ok: false, reason: "conflict" });
    expect(merge(
      "range: a-b\n",
      "range: a\u2013H\n",
      "range: a\u2014b\n",
    )).toEqual({ ok: false, reason: "conflict" });
  });

  test("returns a conflict when a human update overlaps an agent deletion", () => {
    expect(merge("one\ntwo\nthree\n", "one\nHUMAN\nthree\n", "one\nthree\n")).toEqual({
      ok: false,
      reason: "conflict",
    });
  });

  test("conservatively conflicts for an adjacent deletion and update", () => {
    expect(merge("one\ntwo\nthree\n", "one\nthree\n", "one\ntwo\nTHREE\n")).toEqual({
      ok: false,
      reason: "conflict",
    });
  });

  test("conservatively conflicts for an adjacent deletion and insertion", () => {
    expect(merge("one\ntwo\nthree\n", "one\nthree\n", "one\ntwo\nagent\nthree\n")).toEqual({
      ok: false,
      reason: "conflict",
    });
  });

  test("combines a human deletion with a non-adjacent agent update", () => {
    expect(
      merge("one\ntwo\nkeep\nthree\n", "one\nkeep\nthree\n", "one\ntwo\nkeep\nTHREE\n"),
    ).toMatchObject({
      ok: true,
      text: "one\nkeep\nTHREE\n",
    });
  });

  test("merges multi-hunk edits with line-preserving diff3", () => {
    expect(
      merge(
        "title\nalpha\nkeep-a\nbeta\nkeep-b\ngamma\nkeep-c\nfooter\n",
        "title\nALPHA\nkeep-a\nbeta\nkeep-b\nGAMMA\nkeep-c\nfooter\n",
        "title\nalpha\nkeep-a\nBETA\nkeep-b\ngamma\nkeep-c\nagent footer\n",
      ),
    ).toMatchObject({
      ok: true,
      text: "title\nALPHA\nkeep-a\nBETA\nkeep-b\nGAMMA\nkeep-c\nagent footer\n",
    });
  });

  test("preserves Unicode text", () => {
    expect(merge("🌊\ncafé\n東京\n", "🌊\nCAFÉ\n東京\n", "🌊\ncafé\n京都\n")).toMatchObject({
      ok: true,
      text: "🌊\nCAFÉ\n京都\n",
    });
  });

  test("preserves a missing final newline", () => {
    expect(merge("one\ntwo", "ONE\ntwo", "one\ntwo\nthree")).toMatchObject({
      ok: true,
      text: "ONE\ntwo\nthree",
    });
  });

  test("preserves CRLF line terminators", () => {
    expect(merge("one\r\ntwo\r\nthree\r\n", "ONE\r\ntwo\r\nthree\r\n", "one\r\ntwo\r\nTHREE\r\n")).toMatchObject({
      ok: true,
      text: "ONE\r\ntwo\r\nTHREE\r\n",
    });
  });

  test("keeps every generated independent pair of edits deterministically", () => {
    const base = ["zero", "one", "two", "three", "four", "five"].join("\n") + "\n";
    for (let humanIndex = 0; humanIndex < 6; humanIndex++) {
      for (let agentIndex = 0; agentIndex < 6; agentIndex++) {
        const human = base.replace(
          `${["zero", "one", "two", "three", "four", "five"][humanIndex]}\n`,
          `human-${humanIndex}\n`,
        );
        const agent = base.replace(
          `${["zero", "one", "two", "three", "four", "five"][agentIndex]}\n`,
          `agent-${agentIndex}\n`,
        );
        const result = merge(base, human, agent);
        if (humanIndex === agentIndex) {
          expect(result).toEqual({ ok: false, reason: "conflict" });
        } else {
          expect(result).toMatchObject({
            ok: true,
            text: agent.replace(
              `${["zero", "one", "two", "three", "four", "five"][humanIndex]}\n`,
              `human-${humanIndex}\n`,
            ),
          });
        }
      }
    }
  });
});
