import { beforeEach, expect, mock, test } from "bun:test";
import type { Configuration } from "../../src/subagents/deep-research/shared/config";
import type { AgentState } from "../../src/subagents/deep-research/agent/state";

let invoke = mock(async (): Promise<unknown> => ({ content: "Research report with citations" }));
mock.module("../../src/subagents/deep-research/providers/router", () => ({
  createModel: async () => ({ invoke }),
}));
const { createFinalReportGenerationNode } = await import("../../src/subagents/deep-research/agent/graph");
const cfg = { final_report_model: "openai:gpt-5.5-2026-04-23", anthropic_long_context_beta: false } as Configuration;
const state: AgentState = {
  messages: [], supervisor_messages: [], raw_notes: [], notes: ["A sourced finding"],
  research_brief: "Investigate this topic", report_language: "English", final_report: undefined,
};
beforeEach(() => { invoke = mock(async () => ({ content: "Research report with citations" })); });

test("successful synthesis yields a report", async () => {
  expect((await createFinalReportGenerationNode(cfg)(state)).final_report).toBe("Research report with citations");
});

test("provider timeout rejects with its cause instead of a successful error report", async () => {
  const cause = new Error("Venice: Request timed out.");
  invoke = mock(async () => { throw cause; });
  const error = await createFinalReportGenerationNode(cfg)(state).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).cause).toBe(cause);
  expect((error as Error).message).toContain("the report model timed out");
  expect(invoke).toHaveBeenCalledTimes(1);
});

test("empty synthesis rejects instead of completing the Task", async () => {
  invoke = mock(async () => ({ content: "  " }));
  const error = await createFinalReportGenerationNode(cfg)(state).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("final report generation failed");
});

test("context rejection retains the cause without retrying on shortened findings", async () => {
  const cause = new Error("context_length_exceeded");
  invoke = mock(async () => { throw cause; });
  const error = await createFinalReportGenerationNode(cfg)(state).catch((e: unknown) => e);
  expect((error as Error).cause).toBe(cause);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(state.notes).toEqual(["A sourced finding"]);
});
