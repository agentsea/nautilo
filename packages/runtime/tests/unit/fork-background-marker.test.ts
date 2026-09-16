import { describe, test, expect } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { buildForkBackgroundMarker } from "../../src/fork/fork-initial-messages";

/**
 * M170 R2b — the in-flight-predecessor marker. A fork now rebuilds history from
 * the DB transcript (so the predecessor's committed user message is already in
 * context); this transient marker only tells the fork "don't redo the in-flight
 * predecessor." It must be a HumanMessage (never AIMessage / SystemMessage) and
 * carry `nautilo_transient_context: true` so `persistMessages` drops it at the
 * persistence boundary — it never reaches the visible transcript.
 */
describe("buildForkBackgroundMarker (M170 R2b)", () => {
  test("is a HumanMessage, not an AIMessage", () => {
    const m = buildForkBackgroundMarker(1);
    expect(m).toBeInstanceOf(HumanMessage);
    expect(m).not.toBeInstanceOf(AIMessage);
  });

  test("carries the transient-context flag (never persisted)", () => {
    const m = buildForkBackgroundMarker(1);
    expect(m.additional_kwargs["nautilo_transient_context"]).toBe(true);
  });

  test("content references [FORK BACKGROUND] and uses singular for one predecessor", () => {
    const m = buildForkBackgroundMarker(1);
    expect(typeof m.content).toBe("string");
    const content = m.content as string;
    expect(content).toContain("[FORK BACKGROUND]");
    expect(content).toContain("request shown above is");
    expect(content).not.toContain("requests shown above are");
  });

  test("uses plural for multiple predecessors", () => {
    const m = buildForkBackgroundMarker(2);
    const content = m.content as string;
    expect(content).toContain("requests shown above are");
  });
});
