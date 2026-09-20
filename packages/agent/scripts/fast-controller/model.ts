import { createHash } from "node:crypto";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { ChatModel } from "../../src/providers/types";

export interface ModelRequest {
  role: "router" | "controller";
  instructions: string;
  schema: z.ZodType;
  context: unknown;
  signal: AbortSignal;
}
export type Decide = (request: ModelRequest) => Promise<unknown>;
export interface Measurement {
  role: ModelRequest["role"];
  elapsedMs: number;
  /** Instructions, schema and current context; excludes provider wire framing. */
  projectedPromptBytes: number;
  prefixHash: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  actualCostUsd: number | null;
  httpStatus: number | null;
  validationIssues: Array<{ code: string; path: string }>;
  outcome: "pending" | "valid" | "invalid" | "provider_error" | "cancelled";
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}
function metric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Explicit types on object-only unions preserve JSON Schema semantics while
 * avoiding gateways interpreting an untyped nested property as a string. */
export function explicitObjectUnions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(explicitObjectUnions);
  if (value === null || typeof value !== "object") return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, explicitObjectUnions(item)]));
  const branches = result["oneOf"] ?? result["anyOf"];
  if (result["type"] === undefined && Array.isArray(branches) && branches.length > 0
    && branches.every(branch => record(branch)["type"] === "object")) result["type"] = "object";
  return result;
}

/** Uses the ordinary provider's tool-output path, not a second HTTP
 * client or credential store. A tool proposal is data; this module has no actuator. */
export function createModelDecider(model: ChatModel, measurements: Measurement[]): Decide {
  if (!model.bindTools) throw new Error("structured_tool_output_unavailable");
  const bound = new Map<string, ChatModel>();
  return async request => {
    request.signal.throwIfAborted();
    const tool = { type: "function", function: { name: "submit_decision",
      description: "Return one proposed next decision. This does not execute an action.",
      parameters: explicitObjectUnions(z.toJSONSchema(request.schema)), strict: true } };
    const key = JSON.stringify(tool);
    let client = bound.get(key);
    if (!client) {
      // Some reasoning providers reject forced/named tool choice. Local schema
      // validation still requires exactly one decision before any execution.
      client = model.bindTools!([tool], { tool_choice: "auto", parallel_tool_calls: false });
      bound.set(key, client);
    }
    const tail = JSON.stringify(request.context);
    const instructions = request.instructions + " Return exactly one submit_decision tool call, not prose.";
    const prefix = instructions + key;
    const row: Measurement = { role: request.role, elapsedMs: 0,
      projectedPromptBytes: Buffer.byteLength(prefix + tail), prefixHash: createHash("sha256").update(prefix).digest("hex"),
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
      actualCostUsd: null, httpStatus: null, validationIssues: [], outcome: "pending" };
    measurements.push(row);
    const started = performance.now();
    try {
      const response = record(await client.invoke([new SystemMessage(instructions), new HumanMessage(tail)], { signal: request.signal }));
      const usage = record(response["usage_metadata"]);
      const details = record(usage["input_token_details"]);
      const metadata = record(response["response_metadata"]);
      row.inputTokens = metric(usage["input_tokens"]);
      row.outputTokens = metric(usage["output_tokens"]);
      row.cacheReadTokens = metric(details["cache_read"]);
      row.cacheWriteTokens = metric(details["cache_creation"]);
      row.actualCostUsd = metric(record(metadata["usage"])["cost"]);
      request.signal.throwIfAborted(); // account for late responses, never use them
      row.outcome = "invalid";
      const calls = response["tool_calls"];
      if (!Array.isArray(calls) || calls.length !== 1 || record(calls[0])["name"] !== "submit_decision"
        || (Array.isArray(response["invalid_tool_calls"]) && response["invalid_tool_calls"].length > 0)) {
        throw new Error("invalid_model_decision");
      }
      const parsed: unknown = request.schema.parse(record(calls[0])["args"]);
      row.outcome = "valid";
      return parsed;
    } catch (error) {
      if (error instanceof z.ZodError) row.validationIssues = error.issues.map(issue => ({ code: issue.code, path: issue.path.map(String).join(".") }));
      row.httpStatus = metric(record(error)["status"]);
      if (request.signal.aborted) row.outcome = "cancelled";
      else if (row.outcome === "pending") row.outcome = "provider_error";
      // Provider exceptions may contain request bodies or credentials.
      throw new Error(row.outcome === "invalid" ? "invalid_model_decision" : row.outcome);
    } finally { row.elapsedMs = performance.now() - started; }
  };
}
