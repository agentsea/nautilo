/**
 * M067D Phase 5 — one cheap `invoke` per configured provider that has a
 * currently published signed-catalog route (skip when the env key is absent).
 * Exercises `createUniversalModel` + `bindTools` parity with the agent node.
 *
 * Assertions are **wire-level only**: `invoke` completes without throw, and
 * the assistant message carries either non-empty visible text or a non-empty
 * structured `content` payload (e.g. thinking-only blocks on some Anthropic
 * paths). We never assert on instruction-following — that is stochastic.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import type { AIMessage } from "@langchain/core/messages";
import { createUniversalModel } from "../../src/providers/universal";

const MAX_ASSISTANT_CHARS = 50_000;

/**
 * Extract user-visible text from a single content block. Skips Anthropic
 * thinking / redacted_thinking; ignores tool_use blocks (no user-visible text).
 */
function textFromBlock(block: unknown): string {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  const b = block as Record<string, unknown>;
  const typ = b["type"];
  if (typ === "thinking" || typ === "redacted_thinking") return "";
  if (typ === "tool_use" || typ === "function") return "";
  if (typeof b["text"] === "string") return b["text"];
  if (typeof b["content"] === "string") return b["content"];
  if (Array.isArray(b["content"])) {
    return b["content"].map(textFromBlock).join("");
  }
  return "";
}

/** All user-visible text from AIMessage.content (string or block array). */
function visibleTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(textFromBlock).join("");
}

/**
 * Best-effort visible assistant string: structured `content` first, then
 * LangChain's aggregated `.text` when content blocks are empty.
 */
function assistantVisibleString(message: AIMessage): string {
  const fromContent = visibleTextFromContent(message.content).trim();
  if (fromContent.length > 0) return fromContent;
  const direct = (message as unknown as { text?: unknown }).text;
  return typeof direct === "string" ? direct.trim() : "";
}

/** True when the model returned a non-empty wire payload (even if we skip it in visible text). */
function assistantMessageHasStructuredPayload(message: AIMessage): boolean {
  const c = message.content;
  if (typeof c === "string") return c.trim().length > 0;
  if (Array.isArray(c)) return c.length > 0;
  return false;
}

const ROWS: Array<{ modelId: string; envKey: string; alsoNeeds?: string }> = [
  { modelId: "openai:gpt-5.6-luna", envKey: "OPENAI_API_KEY" },
  { modelId: "anthropic:claude-sonnet-4-6", envKey: "ANTHROPIC_API_KEY" },
  {
    modelId: "google:gemini-3.1-flash-lite-preview",
    envKey: "GOOGLE_API_KEY",
  },
  {
    modelId: "fireworks:accounts/fireworks/models/deepseek-v4p1-flash",
    envKey: "FIREWORKS_API_KEY",
  },
  { modelId: "openrouter:openai/gpt-5.6-luna", envKey: "OPENROUTER_API_KEY" },
  { modelId: "venice:openai-gpt-56-luna", envKey: "VENICE_API_KEY" },
];

beforeAll(() => {
  delete process.env["NAUTILO_TEST_MODE"];
});

// Real provider invokes routinely exceed bun's 5s default. Use a generous
// per-test timeout so we measure wire-level success, not provider latency.
const PROVIDER_INVOKE_TIMEOUT_MS = 30_000;

// This is a wire-level smoke test: we only care that the round-trip completes
// and returns *something*. Capping the output budget keeps the test fast and
// cheap on every provider — without this, the factory falls back to each
// provider's full advertised max (e.g. 64k for Anthropic Haiku 4.5), which
// can stretch a "one-line greeting" invoke well past 30s of streaming.
const SMOKE_MAX_TOKENS = 64;

describe("Provider round-trip (M067D)", () => {
  for (const row of ROWS) {
    const requiredKeys = [
      row.envKey,
      ...(row.alsoNeeds ? [row.alsoNeeds] : []),
    ];
    const missingKeys = requiredKeys.filter(
      (key) => !process.env[key]?.trim(),
    );
    if (missingKeys.length > 0) {
      test.skip(
        `${row.modelId} invoke completes (missing ${missingKeys.join(", ")})`,
        () => {},
      );
      continue;
    }

    test(
      `${row.modelId} invoke completes (visible text or structured content)`,
      async () => {
        const model = await createUniversalModel(row.modelId, {
          maxTokens: SMOKE_MAX_TOKENS,
        });
        const invokeTarget = model.bindTools ? model.bindTools([]) : model;
        const res = (await invokeTarget.invoke([
          new HumanMessage("Reply with a single short greeting (one line)."),
        ])) as AIMessage;
        const text = assistantVisibleString(res);
        if (text.length > 0) {
          expect(text.length).toBeLessThanOrEqual(MAX_ASSISTANT_CHARS);
        } else {
          expect(assistantMessageHasStructuredPayload(res)).toBe(true);
        }
      },
      PROVIDER_INVOKE_TIMEOUT_MS,
    );
  }
});
