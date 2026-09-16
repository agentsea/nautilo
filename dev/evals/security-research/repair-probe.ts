import { z } from "zod";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { resolveTaskModel } from "../../../packages/agent/src/config/resolve-task-model";
import { createUniversalModel } from "../../../packages/agent/src/providers/universal";
import { createSecurityScanTool } from "../../../packages/agent/src/tools/security/security-scan";
import { modelOutputPreflightNode } from "../../../packages/agent/src/nodes/model-output-preflight";
import type { NautiloState } from "../../../packages/agent/src/agent/state";

// Provider credentials come from the operator's normal environment. Never print them.
// This isolated provider probe executes no tool and makes no audit-completeness claim.
const selected = resolveTaskModel({ baseModelId: "openai:gpt-5.5-2026-04-23", taskPreference: "security_research" });
const source = await Bun.file(new URL("section-fixture/packages/identity/policy.mjs", import.meta.url)).text();
const messages = [
  new SystemMessage("Continue the source evidence recording request. The preceding malformed call was rejected and did not execute. Repair it with one schema-valid security_scan record call. Do not repeat the file read. This is a synthetic local source fixture, and no tool call from your response will be executed."),
  new HumanMessage("Record one evidence entry describing the identity cache lookup and its cache key in packages/identity/policy.mjs. Include exact fileCitations for the source you read. Use version security-scan-v1, operation record, action append. The Task already has an active scan."),
  new AIMessage({ content: "", tool_calls: [{ id: "source-read", name: "file", args: { command: "read", path: "packages/identity/policy.mjs" } }] }),
  new ToolMessage({ name: "file", tool_call_id: "source-read", content: source }),
  new AIMessage({ content: "", invalid_tool_calls: [{ id: "broken-record", name: "security_scan", args: '{"version":"security-scan-v1","operation":"record",', error: "Malformed args.", type: "invalid_tool_call" }] }),
];
const repairedHistory = modelOutputPreflightNode({ messages } as NautiloState).messages!;
const tool = createSecurityScanTool();
const model = await createUniversalModel(selected.modelId, { timeoutMs: null });
if (!model.bindTools) throw Error("Selected model cannot bind tools");
const began = performance.now();
try {
  const result = await model.bindTools([tool]).invoke(repairedHistory);
  if (!AIMessage.isInstance(result)) throw Error("Unexpected provider response");
  const calls = result.tool_calls ?? [];
  const valid = calls.length === 1 && calls[0]?.name === "security_scan" && (tool.schema as z.ZodType<unknown>).safeParse(calls[0]?.args).success
    && calls[0]?.args["operation"] === "record" && !(result.invalid_tool_calls?.length);
  console.log(JSON.stringify({ selected, durationMs: performance.now() - began, valid, invalidCallCount: result.invalid_tool_calls?.length ?? 0,
    calls: calls.map((call) => ({ name: call.name, args: call.args })), usage: result.usage_metadata,
    scope: "Controlled malformed history plus real default-model repair; no tools executed; separate from ordinary Task acceptance." }));
  if (!valid) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ selected, failed: true, errorName: error instanceof Error ? error.name : "unknown", scope: "Provider repair probe" }));
  process.exitCode = 1;
}
