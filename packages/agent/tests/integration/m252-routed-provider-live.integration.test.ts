/**
 * M252 bounded live qualification for unpublished OpenRouter and Venice routes.
 *
 * This suite is deliberately excluded from ordinary paid execution unless
 * NAUTILO_RUN_M252_LIVE=1 is set. Image calls require the second explicit
 * NAUTILO_RUN_M252_LIVE_IMAGES=1 gate. Never add prompts containing user data
 * or log provider response bodies here.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { readFile } from "node:fs/promises";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { setConfigOverrides } from "@nautilo/config";
import { ModelCatalogSchema } from "@nautilo/types";
import { z } from "zod";
import {
  configureRuntimeModelCatalog,
  hydrateRuntimeModelCatalog,
  resetRuntimeModelCatalog,
} from "../../src/config/model-catalog/runtime-catalog";
import { generateImages } from "../../src/image-gen";
import { createUniversalModel } from "../../src/providers/universal";
import { embedTexts } from "../../src/store/embeddings";

const LIVE = process.env["NAUTILO_RUN_M252_LIVE"] === "1";
const LIVE_IMAGES =
  LIVE && process.env["NAUTILO_RUN_M252_LIVE_IMAGES"] === "1";
const INVOKE_TIMEOUT_MS = 90_000;
const IMAGE_TIMEOUT_MS = 180_000;
const EMBEDDING_DIMS = 1536;

const CHAT_ROUTES = [
  { id: "openrouter:openai/gpt-5.5", key: "OPENROUTER_API_KEY" },
  { id: "openrouter:anthropic/claude-sonnet-4.6", key: "OPENROUTER_API_KEY" },
  { id: "openrouter:google/gemini-3.1-pro-preview", key: "OPENROUTER_API_KEY" },
  { id: "venice:openai-gpt-55-pro", key: "VENICE_API_KEY" },
  { id: "venice:claude-sonnet-4-6", key: "VENICE_API_KEY" },
  { id: "venice:gemini-3-1-pro-preview", key: "VENICE_API_KEY" },
] as const;

const EMBEDDING_ROUTES = [
  { id: "openrouter:openai/text-embedding-3-small", key: "OPENROUTER_API_KEY" },
  { id: "venice:text-embedding-3-small", key: "VENICE_API_KEY" },
] as const;

const IMAGE_ROUTES = [
  {
    route: "openrouter:openai/gpt-image-2",
    provider: "openrouter" as const,
    model: "openai/gpt-image-2",
    key: "OPENROUTER_API_KEY",
  },
  {
    route: "venice:gpt-image-2",
    provider: "venice" as const,
    model: "gpt-image-2",
    key: "VENICE_API_KEY",
  },
] as const;

function configured(key: string): boolean {
  return Boolean(process.env[key]?.trim());
}

function visibleText(message: AIMessage): string {
  if (typeof message.content === "string" && message.content.trim()) {
    return message.content.trim();
  }
  const fromBlocks = Array.isArray(message.content) ? message.content
    .map((block) => {
      if (typeof block === "string") return block;
      if (!block || typeof block !== "object") return "";
      const value = block as Record<string, unknown>;
      return typeof value["text"] === "string" ? value["text"] : "";
    })
    .join("")
    .trim() : "";
  if (fromBlocks) return fromBlocks;
  const direct = (message as unknown as { text?: unknown }).text;
  return typeof direct === "string" ? direct.trim() : "";
}

function tokenSignal(message: AIMessage): number {
  const usage = (message as unknown as {
    usage_metadata?: { input_tokens?: number; output_tokens?: number };
  }).usage_metadata;
  return (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
}

/** Structural diagnostics only: never include provider text or raw bodies. */
function safeMessageShape(message: AIMessage): Record<string, unknown> {
  const metadata = message.response_metadata as Record<string, unknown> | undefined;
  return {
    contentKind: Array.isArray(message.content) ? "blocks" : typeof message.content,
    contentBlocks: Array.isArray(message.content) ? message.content.length : undefined,
    blockTypes: Array.isArray(message.content)
      ? message.content.map((block) =>
          block && typeof block === "object"
            ? (block as Record<string, unknown>)["type"] ?? "object"
            : typeof block)
      : undefined,
    visibleChars: visibleText(message).length,
    toolCalls: message.tool_calls?.length ?? 0,
    invalidToolCalls: message.invalid_tool_calls?.length ?? 0,
    finishReason: metadata?.["finish_reason"],
    usage: message.usage_metadata,
  };
}

async function activateCandidateCatalog(): Promise<void> {
  const catalog = ModelCatalogSchema.parse(
    JSON.parse(
      await readFile(
        new URL("../fixtures/m252-routed-model-candidates.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  configureRuntimeModelCatalog({
    loader: {
      get: async () => ({
        catalog,
        source: "remote-fresh",
        stale: false,
        fetchedAt: "2026-08-12T00:00:00.000Z",
        originUrl: "https://catalog.invalid/m252-live-candidates.json",
        reason: "",
        catalogVersion: catalog.catalogVersion,
      }),
      refresh: async () => {},
      clearCache: () => {},
    },
  });
  await hydrateRuntimeModelCatalog();
}

const probeTool = new DynamicStructuredTool({
  name: "m252_provider_probe",
  description: "Echo a short public test marker. Always call this tool when asked.",
  schema: z.object({ marker: z.string() }),
  func: async ({ marker }) => JSON.stringify({ accepted: marker === "m252" }),
});

describe.serial("M252 routed providers (bounded live qualification)", () => {
  beforeAll(async () => {
    if (!LIVE) return;
    delete process.env["NAUTILO_TEST_MODE"];
    await activateCandidateCatalog();
  });

  afterAll(() => {
    setConfigOverrides({});
    resetRuntimeModelCatalog();
  });

  for (const row of CHAT_ROUTES) {
    const enabled = LIVE && configured(row.key);
    (enabled ? test : test.skip)(
      `${row.id}: forced tool call, tool result, final answer, and usage metadata`,
      async () => {
        const model = await createUniversalModel(row.id, {
          maxTokens: row.id.includes("gemini") ? 2_048 : 512,
          timeoutMs: 75_000,
        });
        expect(model.bindTools).toBeFunction();
        const withTool = model.bindTools?.([probeTool], {
          tool_choice: {
            type: "function",
            function: { name: "m252_provider_probe" },
          },
        });
        if (!withTool) throw new Error(`${row.id} did not expose bindTools`);
        const continuation = model.bindTools?.([probeTool], { tool_choice: "auto" });
        if (!continuation) throw new Error(`${row.id} did not preserve bindTools`);

        const human = new HumanMessage(
          "Call m252_provider_probe exactly once with marker m252. After its result, reply with exactly OK.",
        );
        const toolRequest = (await withTool.invoke([human])) as AIMessage;
        const calls = toolRequest.tool_calls ?? [];
        if (calls.length !== 1) {
          throw new Error(
            `${row.id} did not return one forced tool call: ${JSON.stringify(safeMessageShape(toolRequest))}`,
          );
        }
        const call = calls[0];
        if (!call?.id) throw new Error(`${row.id} returned a tool call without an id`);
        expect(call.name).toBe("m252_provider_probe");

        const result = await probeTool.invoke(call);
        const toolMessage = result instanceof ToolMessage
          ? result
          : new ToolMessage({
              content: result,
              tool_call_id: call.id,
              name: call.name,
            });
        // Keep the schema on the continuation, but return to normal automatic
        // choice. The user instruction says exactly once, so a second call is
        // itself a qualification failure while a provider may still require
        // the tool declaration to consume the ToolMessage correctly.
        const final = (await continuation.invoke([
          human,
          toolRequest,
          toolMessage,
        ])) as AIMessage;

        if (!visibleText(final)) {
          throw new Error(
            `${row.id} returned no visible continuation: ${JSON.stringify(safeMessageShape(final))}`,
          );
        }
        expect(final.tool_calls ?? []).toHaveLength(0);
        expect(tokenSignal(toolRequest) + tokenSignal(final)).toBeGreaterThan(0);
      },
      INVOKE_TIMEOUT_MS,
    );
  }

  for (const row of EMBEDDING_ROUTES) {
    const enabled = LIVE && configured(row.key);
    (enabled ? test : test.skip)(
      `${row.id}: returns a pgvector-compatible embedding`,
      async () => {
        setConfigOverrides({
          nautilo_embedding_model: row.id,
          nautilo_embedding_dims: EMBEDDING_DIMS,
        });
        const vectors = await embedTexts(["M252 public embedding probe"]);
        expect(vectors).toHaveLength(1);
        expect(vectors[0]).toHaveLength(EMBEDDING_DIMS);
        expect(vectors[0]?.every(Number.isFinite)).toBe(true);
      },
      INVOKE_TIMEOUT_MS,
    );
  }

  for (const row of IMAGE_ROUTES) {
    const enabled = LIVE_IMAGES && configured(row.key);
    (enabled ? test : test.skip)(
      `${row.route}: returns one bounded PNG`,
      async () => {
        const result = await generateImages(
          {
            model: row.model,
            prompt: "A plain blue circle centered on a white background",
            count: 1,
            size: "1024x1024",
            quality: "low",
            background: "opaque",
            format: "png",
          },
          {
            ...(process.env["OPENROUTER_API_KEY"]
              ? { openrouterKey: process.env["OPENROUTER_API_KEY"] }
              : {}),
            ...(process.env["VENICE_API_KEY"]
              ? { veniceKey: process.env["VENICE_API_KEY"] }
              : {}),
          },
          row.provider,
        );
        expect(result.model).toBe(row.model);
        expect(result.mime).toBe("image/png");
        expect(result.bytes).toHaveLength(1);
        expect(result.bytes[0]?.byteLength).toBeGreaterThan(100);
      },
      IMAGE_TIMEOUT_MS,
    );
  }

  for (const provider of ["openrouter", "venice"] as const) {
    const keyName = provider === "openrouter" ? "OPENROUTER_API_KEY" : "VENICE_API_KEY";
    const modelId = provider === "openrouter"
      ? "openrouter:openai/gpt-5.5"
      : "venice:openai-gpt-55-pro";
    const enabled = LIVE && configured(keyName);
    (enabled ? test : test.skip)(
      `${provider}: authentication failure is provider-labeled and secret-free`,
      async () => {
        const disposableSecret = `m252-invalid-${provider}-credential`;
        const model = await createUniversalModel(modelId, {
          apiKey: disposableSecret,
          maxTokens: 1,
          timeoutMs: 30_000,
        });
        const failure = await model
          .invoke([new HumanMessage("Reply with one word.")])
          .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message.toLowerCase()).toContain(provider);
        expect((failure as Error).message).not.toContain(disposableSecret);
      },
      INVOKE_TIMEOUT_MS,
    );
  }
});
