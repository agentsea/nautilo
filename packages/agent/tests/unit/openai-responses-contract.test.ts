/**
 * D334 Phase 1 — LangChain Responses API contract probe.
 *
 * Pins @langchain/openai@1.4.5 bytes Nautilo's OpenAI Responses migration depends on.
 * Hermetic only: no live OpenAI calls, no secrets.
 *
 * Phase 1.5 posture (binding constraint for Phase 3 carryover tests):
 * - Default OpenAI Responses path: zdrEnabled=false with store=true so OpenAI retains
 *   reasoning items and LangChain can replay reasoning ids (and raw response_metadata.output
 *   when present).
 * - If operator enables ZDR: MUST request include: ["reasoning.encrypted_content"] on
 *   Responses calls; otherwise convertMessagesToResponsesInput drops reasoning on replay
 *   (only replays when !zdrEnabled || encrypted_content is present).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { AIMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  ChatOpenAI,
  ChatOpenAIResponses,
  convertMessagesToResponsesInput,
  convertReasoningSummaryToResponsesReasoningItem,
  convertResponsesDeltaToChatGenerationChunk,
  convertResponsesMessageToAIMessage,
  convertResponsesUsageToUsageMetadata,
} from "@langchain/openai";

const require = createRequire(import.meta.url);
const LC_OPENAI_ROOT = dirname(require.resolve("@langchain/openai/package.json"));
const PINNED_VERSION = "1.4.5";

function readDist(relativePath: string): string {
  return readFileSync(join(LC_OPENAI_ROOT, relativePath), "utf8");
}

/** Minimal Nautilo-style function tool for bindTools probes. */
function makeNautiloStyleTool() {
  return new DynamicStructuredTool({
    name: "get_current_time",
    description: "Return the current time in a timezone.",
    schema: z.object({
      timezone: z.string().optional().describe("IANA timezone, e.g. UTC"),
    }),
    func: async ({ timezone }) => `now:${timezone ?? "UTC"}`,
  });
}

/** Minimal completed Responses payload with a function_call output item. */
function makeFunctionCallResponse() {
  return {
    id: "resp_d334_fc",
    object: "response" as const,
    created_at: 1_718_000_000,
    status: "completed" as const,
    model: "gpt-5.5",
    output: [
      {
        type: "function_call" as const,
        id: "fc_d334_1",
        call_id: "call_d334_1",
        name: "get_current_time",
        arguments: JSON.stringify({ timezone: "UTC" }),
      },
    ],
  };
}

/** Minimal completed Responses payload with reasoning + visible assistant text. */
function makeReasoningResponse() {
  return {
    id: "resp_d334_reasoning",
    object: "response" as const,
    created_at: 1_718_000_001,
    status: "completed" as const,
    model: "gpt-5.5",
    output: [
      {
        type: "reasoning" as const,
        id: "rs_d334_1",
        summary: [{ type: "summary_text" as const, text: "hidden chain-of-thought" }],
      },
      {
        type: "message" as const,
        id: "msg_d334_1",
        role: "assistant" as const,
        content: [{ type: "output_text" as const, text: "Visible answer.", annotations: [] }],
      },
    ],
  };
}

interface ToolCallChunkLike {
  type?: unknown;
  name?: unknown;
  id?: unknown;
  index?: unknown;
}

interface ResponseInputItemLike {
  type?: unknown;
  role?: unknown;
  content?: unknown;
  id?: unknown;
  encrypted_content?: unknown;
}

function responseItems(value: unknown): ResponseInputItemLike[] {
  expect(Array.isArray(value)).toBe(true);
  return value as ResponseInputItemLike[];
}

function responsesMessage(value: unknown): Parameters<typeof convertResponsesMessageToAIMessage>[0] {
  return value as Parameters<typeof convertResponsesMessageToAIMessage>[0];
}

function responsesStreamEvent(value: unknown): Parameters<typeof convertResponsesDeltaToChatGenerationChunk>[0] {
  return value as Parameters<typeof convertResponsesDeltaToChatGenerationChunk>[0];
}

describe("D334 Phase 1.1 — @langchain/openai package byte audit", () => {
  it(`pins installed version to ${PINNED_VERSION}`, () => {
    const pkg = JSON.parse(readFileSync(join(LC_OPENAI_ROOT, "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    expect(pkg.name).toBe("@langchain/openai");
    expect(pkg.version).toBe(PINNED_VERSION);
  });

  it("exports ChatOpenAI.useResponsesApi and bindTools on the installed surface", () => {
    const indexTypes = readDist("dist/chat_models/index.d.ts");
    expect(indexTypes).toContain("useResponsesApi?: boolean");
    expect(indexTypes).toContain("useResponsesApi: boolean");
    expect(indexTypes).toContain("bindTools");

    const llm = new ChatOpenAI({
      model: "gpt-5.5",
      apiKey: "d334-probe-key",
      useResponsesApi: true,
    });
    expect(llm.useResponsesApi).toBe(true);
    expect(typeof llm.bindTools).toBe("function");
  });

  it("exports ChatOpenAIResponses and Responses streaming entry points", () => {
    const responsesTypes = readDist("dist/chat_models/responses.d.ts");
    expect(responsesTypes).toContain("declare class ChatOpenAIResponses");
    expect(responsesTypes).toContain("_streamResponseChunks");
    expect(responsesTypes).toContain("completionWithRetry");
    expect(typeof ChatOpenAIResponses).toBe("function");
  });

  it("exports Responses converters used by the migration probe", () => {
    expect(typeof convertResponsesMessageToAIMessage).toBe("function");
    expect(typeof convertResponsesDeltaToChatGenerationChunk).toBe("function");
    expect(typeof convertMessagesToResponsesInput).toBe("function");
    expect(typeof convertReasoningSummaryToResponsesReasoningItem).toBe("function");
    expect(typeof convertResponsesUsageToUsageMetadata).toBe("function");

    const converterSource = readDist("dist/converters/responses.js");
    expect(converterSource).toContain("convertResponsesMessageToAIMessage");
    expect(converterSource).toContain("convertResponsesDeltaToChatGenerationChunk");
    expect(converterSource).toContain('item.type === "function_call"');
    expect(converterSource).toContain('item.type === "reasoning"');
    expect(converterSource).toContain("additional_kwargs.reasoning");
    expect(converterSource).toContain("response_metadata.output");
  });
});

describe("D334 Phase 1.2 — Responses bindTools() contract probe", () => {
  it("bindTools(useResponsesApi: true) keeps invoke/stream runnables", () => {
    const llm = new ChatOpenAI({
      model: "gpt-5.5",
      apiKey: "d334-probe-key",
      useResponsesApi: true,
      reasoning: { effort: "medium" },
    });
    const bound = llm.bindTools([makeNautiloStyleTool()], { tool_choice: "auto" });

    expect(typeof bound.invoke).toBe("function");
    expect(typeof bound.stream).toBe("function");
    expect(llm.useResponsesApi).toBe(true);
  });

  it("maps Responses function_call output to post_model-consumable tool_calls", () => {
    const message = convertResponsesMessageToAIMessage(responsesMessage(makeFunctionCallResponse()));

    expect(message.tool_calls).toHaveLength(1);
    const [call] = message.tool_calls ?? [];
    expect(call?.name).toBe("get_current_time");
    expect(call?.args).toEqual({ timezone: "UTC" });
    expect(call?.id).toBe("call_d334_1");
    expect(call?.type).toBe("tool_call");
    expect(message.invalid_tool_calls ?? []).toHaveLength(0);
  });

  it("maps streaming function_call added events to tool_call_chunks", () => {
    const chunk = convertResponsesDeltaToChatGenerationChunk(responsesStreamEvent({
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_d334_stream",
        call_id: "call_d334_stream",
        name: "get_current_time",
        arguments: "",
      },
    }));
    expect(chunk).not.toBeNull();
    if (!chunk) throw new Error("expected Responses converter to emit a chunk");

    const chunkMessage = chunk.message as unknown as { tool_call_chunks?: ToolCallChunkLike[] };
    const toolCallChunks = chunkMessage.tool_call_chunks ?? [];
    expect(toolCallChunks).toHaveLength(1);
    expect(toolCallChunks[0]?.type).toBe("tool_call_chunk");
    expect(toolCallChunks[0]?.name).toBe("get_current_time");
    expect(toolCallChunks[0]?.id).toBe("call_d334_stream");
    expect(toolCallChunks[0]?.index).toBe(0);
  });
});

describe("D334 Phase 1.3 — reasoning metadata contract probe", () => {
  it("lands Responses reasoning in additional_kwargs.reasoning and reasoning content blocks", () => {
    const message = convertResponsesMessageToAIMessage(responsesMessage(makeReasoningResponse()));

    expect(message.additional_kwargs?.["reasoning"]).toMatchObject({
      id: "rs_d334_1",
      type: "reasoning",
    });

    const blocks = Array.isArray(message.content) ? message.content : [];
    const reasoningBlocks = blocks.filter(
      (block) => typeof block === "object" && block !== null && block.type === "reasoning",
    );
    const textBlocks = blocks.filter(
      (block) => typeof block === "object" && block !== null && block.type === "text",
    );

    expect(reasoningBlocks).toHaveLength(1);
    expect(reasoningBlocks[0]).toMatchObject({
      type: "reasoning",
      reasoning: "hidden chain-of-thought",
    });
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0]).toMatchObject({ type: "text", text: "Visible answer." });

    // Reasoning must stay out of the visible assistant string aggregate.
    expect(message.text).toBe("Visible answer.");
    expect(message.text).not.toContain("hidden chain-of-thought");
  });

  it("preserves response_metadata.output for checkpoint carryover fields", () => {
    const message = convertResponsesMessageToAIMessage(responsesMessage(makeReasoningResponse()));
    const output = message.response_metadata?.["output"];

    expect(Array.isArray(output)).toBe(true);
    expect(output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "reasoning", id: "rs_d334_1" }),
        expect.objectContaining({ type: "message", id: "msg_d334_1" }),
      ]),
    );
  });

  it("streams reasoning into distinguishable non-visible chunks", () => {
    const chunk = convertResponsesDeltaToChatGenerationChunk(responsesStreamEvent({
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 0,
      item: {
        type: "reasoning",
        id: "rs_d334_stream",
        summary: [{ type: "summary_text", text: "streaming hidden thought" }],
      },
    }));
    expect(chunk).not.toBeNull();

    expect(chunk!.message.additional_kwargs?.["reasoning"]).toMatchObject({
      id: "rs_d334_stream",
      type: "reasoning",
    });

    const blocks = Array.isArray(chunk!.message.content) ? chunk!.message.content : [];
    expect(blocks.some((block) => typeof block === "object" && block.type === "reasoning")).toBe(
      true,
    );
    expect(chunk!.text).toBe("");
  });
});

describe("D334 Phase 1.5 — ZDR / store / encrypted-reasoning replay gate", () => {
  const reasoningSummary = {
    type: "reasoning" as const,
    id: "rs_d334_replay",
    summary: [{ type: "summary_text" as const, text: "same-turn carryover" }],
  };

  it("pins converter guard strings for reasoning and raw output replay", () => {
    const source = readDist("dist/converters/responses.js");
    expect(source).toContain("if (!zdrEnabled && responseMetadata?.output != null");
    expect(source).toContain("const hasEncryptedContent = !!reasoning?.encrypted_content");
    expect(source).toContain("if (reasoning && (!zdrEnabled || hasEncryptedContent))");
    expect(source).toContain('include: ["reasoning.encrypted_content"]');
  });

  it("replays raw response_metadata.output only when ZDR is disabled", () => {
    const rawOutput = [
      { type: "reasoning" as const, id: "rs_raw", summary: [] },
      {
        type: "message" as const,
        id: "msg_raw",
        role: "assistant" as const,
        content: [{ type: "output_text" as const, text: "stored", annotations: [] }],
      },
    ];
    const assistant = new AIMessage({
      content: "stored",
      response_metadata: { output: rawOutput },
      additional_kwargs: { reasoning: reasoningSummary },
    });

    const replay = convertMessagesToResponsesInput({
      messages: [assistant],
      zdrEnabled: false,
      model: "gpt-5.5",
    });
    expect(replay as unknown).toEqual(rawOutput);

    const zdrOnReplay = convertMessagesToResponsesInput({
      messages: [assistant],
      zdrEnabled: true,
      model: "gpt-5.5",
    });
    expect(zdrOnReplay as unknown).not.toEqual(rawOutput);
  });

  it("replays reasoning summaries when ZDR is off", () => {
    const assistant = new AIMessage({
      content: "visible",
      additional_kwargs: { reasoning: reasoningSummary },
    });

    const input = convertMessagesToResponsesInput({
      messages: [assistant],
      zdrEnabled: false,
      model: "gpt-5.5",
    });

    expect(input[0]).toMatchObject({ type: "reasoning", id: "rs_d334_replay" });
    expect(input.some((item) => item.type === "message")).toBe(true);
  });

  it("drops reasoning on replay when ZDR is on without encrypted_content", () => {
    const assistant = new AIMessage({
      content: "visible",
      additional_kwargs: { reasoning: reasoningSummary },
    });

    const rawInput: unknown = convertMessagesToResponsesInput({
      messages: [assistant],
      zdrEnabled: true,
      model: "gpt-5.5",
    });
    const input = responseItems(rawInput);

    expect(input.some((item) => item.type === "reasoning")).toBe(false);
    expect(input).toHaveLength(1);
    expect(input[0]?.type).toBe("message");
    expect(input[0]?.role).toBe("assistant");
    expect(input[0]?.content).toBe("visible");
  });

  it("replays reasoning when ZDR is on but encrypted_content is present", () => {
    const assistant = new AIMessage({
      content: "visible",
      additional_kwargs: {
        reasoning: {
          ...reasoningSummary,
          encrypted_content: "encrypted-reasoning-blob",
        },
      },
    });

    const rawInput: unknown = convertMessagesToResponsesInput({
      messages: [assistant],
      zdrEnabled: true,
      model: "gpt-5.5",
    });
    const input = responseItems(rawInput);

    expect(input[0]).toMatchObject({
      type: "reasoning",
      id: "rs_d334_replay",
      encrypted_content: "encrypted-reasoning-blob",
    });
  });
});
