import { expect, test } from "bun:test";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { securityScanToolResultSchema, SECURITY_SCAN_INITIAL_LANES } from "@nautilo/types";
import { securityResearchContinuation } from "../../src/tools/security/research-continuation";
const status = { version: "security-scan-v1", scanId: "scan_test", state: "active", phase: "researching", terminalState: null,
  mode: "deep_research", modelId: "openrouter:z-ai/glm-5.3", modelState: "running", completedSteps: 1, totalSteps: 2,
  lanes: SECURITY_SCAN_INITIAL_LANES, coverage: [], hypotheses: [] };
function receipt(value: unknown, args: Record<string, unknown> = {}) {
  expect(securityScanToolResultSchema.safeParse(value).success).toBe(true);
  return [new AIMessage({ content: "", tool_calls: [{ id: "scan-call", name: "security_scan", args }] }),
    new ToolMessage({ name: "security_scan", tool_call_id: "scan-call", content: JSON.stringify(value) })];
}
test("actual incomplete-research feedback survives the short error-label wire contract", () => {
  const continuation = "Section storage: trace the caller, account membership and final output. " + "Inspect counterevidence before deciding. ".repeat(6);
  expect(continuation.length).toBeGreaterThan(240);
  const messages = receipt({ ok: false, operation: "results", error: { code: "research_incomplete", retryable: true,
    message: "Research remains incomplete. Continue this same active scan.", continuation } });
  expect(securityResearchContinuation(messages)).toContain(continuation);
});
test("genuine revoked authority, provider failures, and cancellation permit the real failure outcome", () => {
  for (const code of ["root_revoked", "root_not_authorized", "model_failed", "relay_unavailable", "cancelled"]) {
    expect(securityResearchContinuation(receipt({ ok: false, operation: "status", error: { code, retryable: false, message: "Unavailable" } }))).toBeNull();
  }
  expect(securityResearchContinuation(receipt({ ok: true, operation: "status", result: { ...status, state: "cancelled", phase: null, terminalState: "cancelled", modelState: "cancelled" } }))).toBeNull();
});
test("research stays in the existing scan, while an explicit scanner-only request is not promoted to LLM research", () => {
  expect(securityResearchContinuation(receipt({ ok: true, operation: "status", result: status }))).toContain("existing scan");
  expect(securityResearchContinuation(receipt({ ok: true, operation: "start", result: { ...status, mode: "scanners_only", modelState: "disabled", modelId: null } }))).toBeNull();
});
