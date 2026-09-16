import { HumanMessage } from "@langchain/core/messages";
import type { EvaluationChatModel } from "@nautilo/agent/model-evaluation";
import type { ModelBenchmarkUsage } from "@nautilo/reflection/evaluation";

function textContent(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const content = (response as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (!block || typeof block !== "object") return "";
    const typed = block as { type?: unknown; text?: unknown };
    return typed.type === "text" && typeof typed.text === "string" ? typed.text : "";
  }).join("");
}

function safeToken(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : undefined;
}

export function extractSafeUsage(response: unknown, call: number): ModelBenchmarkUsage {
  const usage = response && typeof response === "object"
    ? (response as { usage_metadata?: unknown }).usage_metadata
    : undefined;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return { call };
  const row = usage as Record<string, unknown>;
  const inputTokens = safeToken(row["input_tokens"]);
  const outputTokens = safeToken(row["output_tokens"]);
  const totalTokens = safeToken(row["total_tokens"]);
  return {
    call,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

export function createExactHierarchyModelInvoker(input: {
  readonly model: EvaluationChatModel;
  readonly usage: ModelBenchmarkUsage[];
}): (prompt: string, signal?: AbortSignal) => Promise<string> {
  return async (prompt, signal) => {
    const response = await input.model.invoke(
      [new HumanMessage(prompt)],
      signal === undefined ? {} : { signal },
    );
    input.usage.push(extractSafeUsage(response, input.usage.length + 1));
    return textContent(response);
  };
}
