import { beforeEach, expect, mock, test } from "bun:test";
import type { Configuration } from "../../src/subagents/deep-research/shared/config";

const cause = new Error("supervisor.invoke attempt 3/3 timed out after 60000ms");
const finalInvoke = mock(async () => ({ content: "An unsourced report" }));
mock.module("../../src/subagents/deep-research/providers/router", () => ({
  createModel: async (id: string) => id === "test:supervisor"
    ? { bindTools: () => ({ invoke: async () => { throw cause; } }) }
    : { invoke: finalInvoke },
}));
mock.module("../../src/utils/invoke", () => ({
  invokeWithRetry: async () => { throw cause; },
}));
const { createDeepResearchGraph } = await import("../../src/subagents/deep-research/agent/graph");
const cfg = {
  allow_clarification: false,
  supervisor_model: "test:supervisor",
  final_report_model: "test:final",
  max_researcher_iterations: 6,
  max_concurrent_research_units: 5,
} as Configuration;

beforeEach(() => { finalInvoke.mockClear(); });

for (const notes of [[], ["A previously collected sourced finding"]]) {
  test(`supervisor exhaustion fails research before synthesis (${notes.length} prior notes)`, async () => {
    const error = await createDeepResearchGraph(undefined, cfg).invoke({
      messages: [{ role: "user", content: "Research DNS TTL semantics" }],
      research_brief: "Research DNS TTL semantics",
      notes,
      report_language: "English",
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Deep Research supervisor failed");
    expect((error as Error).cause).toBe(cause);
    expect(finalInvoke).not.toHaveBeenCalled();
  });
}
