import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Validator, type Schema } from "@cfworker/json-schema";
import { createGenerateVideoTool, createGenerateMusicTool, GenerateVideoSchema, GenerateMusicSchema } from "../../src/tools/media/generate-media-entry";
import {
  convertToolToAnthropicTool,
  ensureAnthropicObjectInputSchema,
  wrapAnthropicModelForToolSchemas,
} from "../../src/providers/anthropic-schema";
import type { ChatModel } from "../../src/providers/types";
import { normalizeMediaGenerationIntent } from "../../src/media-generation";

describe("Anthropic tool-schema normalization", () => {
  test("removes provider-forbidden root unions without mutating the source", () => {
    const schema = { anyOf: [{ type: "object", required: ["query"] }] };
    expect(ensureAnthropicObjectInputSchema(schema)).toEqual({
      type: "object",
      properties: {},
      required: ["query"],
    });
    expect(schema).not.toHaveProperty("type");
  });

  test("converts a union-shaped LangChain tool to a valid Anthropic descriptor", () => {
    const tool = {
      name: "lookup",
      description: "Look something up",
      schema: z.discriminatedUnion("action", [
        z.object({ action: z.literal("search"), query: z.string() }),
        z.object({ action: z.literal("expand"), ref: z.string() }),
      ]),
    };
    const converted = convertToolToAnthropicTool(tool) as {
      name: string;
      input_schema: Record<string, unknown>;
    };
    expect(converted.name).toBe("lookup");
    expect(converted.input_schema["type"]).toBe("object");
    expect(converted.input_schema).not.toHaveProperty("oneOf");
    expect(converted.input_schema["required"]).toEqual(["action"]);
    expect(Object.keys(converted.input_schema["properties"] as object)).toEqual(["action", "query", "ref"]);
    expect(tool.schema.safeParse({ action: "search", ref: "wrong branch" }).success).toBe(false);
  });

  test("keeps real video and music tools as coherent provider object schemas", () => {
    const video = convertToolToAnthropicTool(createGenerateVideoTool()) as { input_schema: Schema };
    const music = convertToolToAnthropicTool(createGenerateMusicTool()) as { input_schema: Schema };
    for (const schema of [video.input_schema, music.input_schema]) {
      for (const keyword of ["oneOf", "allOf", "anyOf"]) expect(schema).not.toHaveProperty(keyword);
      expect(schema.type).toBe("object");
    }
    expect(video.input_schema.properties?.["action"]).toMatchObject({
      enum: ["generate", "prepare"],
      default: "generate",
    });
    expect(video.input_schema.required).toContain("action");
    const validateVideo = new Validator(video.input_schema);
    for (const args of [
      { action: "prepare", prompt: "A forest" },
      { model: "seedance-2-5-text-to-video-basic", prompt: "A forest" },
      { model: "seedance-2-5-reference-to-video-basic", prompt: "A forest", referenceImages: [{ path: "frame.png" }] },
      { model: "seedance-2-5-reference-to-video-basic", prompt: "Continue <Video 1>", referenceVideos: [{ path: "scene.mp4" }] },
      { model: "seedance-2-5-reference-to-video-basic", prompt: "Continue <Video 1> using <Image 1>", referenceImages: [{ path: "frame.png" }], referenceVideos: [{ path: "scene.mp4" }] },
      { model: "minimax-h3-enhanced-text-to-video", prompt: "A forest" },
    ]) {
      expect(GenerateVideoSchema.safeParse(args).success).toBe(true);
      expect(validateVideo.validate(GenerateVideoSchema.parse(args)).valid).toBe(true);
    }
    const validateMusic = new Validator(music.input_schema);
    for (const args of [
      { model: "sonilo-v1-1-music", prompt: "Piano" },
      { model: "minimax-music-v26", prompt: "Quiet piano music", forceInstrumental: true },
    ]) {
      expect(GenerateMusicSchema.safeParse(args).success).toBe(true);
      expect(validateMusic.validate(GenerateMusicSchema.parse(args)).valid).toBe(true);
    }
    const missingReference = { model: "seedance-2-5-reference-to-video-basic", prompt: "A forest" } as const;
    const conflictingMusic = { model: "minimax-music-v26", prompt: "Quiet piano music", forceInstrumental: true, lyrics: "No" } as const;
    expect(GenerateVideoSchema.safeParse(missingReference).success).toBe(true);
    expect(validateVideo.validate(GenerateVideoSchema.parse(missingReference)).valid).toBe(true);
    expect(() => normalizeMediaGenerationIntent(missingReference)).toThrow("Attach at least one image or video reference");
    expect(GenerateMusicSchema.safeParse(conflictingMusic).success).toBe(true);
    expect(validateMusic.validate(conflictingMusic).valid).toBe(true);
    expect(() => normalizeMediaGenerationIntent(conflictingMusic)).toThrow("Instrumental music cannot include lyrics");
  });

  test("projects root intersections including roots already declaring object", () => {
    const schema = ensureAnthropicObjectInputSchema({
      type: "object", properties: { id: { type: "string" } }, required: ["id"],
      allOf: [
        { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        { type: "object", properties: { name: { minLength: 3 }, count: { type: "integer" } }, required: ["count"] },
      ],
    }) as Schema;
    expect(schema).not.toHaveProperty("allOf");
    expect(schema.required).toEqual(["id", "name", "count"]);
    const validator = new Validator(schema);
    expect(validator.validate({ id: "a", name: "hello", count: 1 }).valid).toBe(true);
    expect(validator.validate({ id: "a", name: "hi", count: 1 }).valid).toBe(false);
  });

  test("normalizes native and OpenAI descriptors while preserving nested unions and definitions", () => {
    const schema = { type: "object", $defs: { text: { type: "string" } }, anyOf: [
      { type: "object", properties: { value: { anyOf: [{ $ref: "#/$defs/text" }, { type: "number" }] } }, required: ["value"] },
      { type: "object", properties: { option: { type: "boolean" } }, required: ["option"] },
    ] };
    for (const tool of [
      { name: "test", input_schema: schema },
      { type: "function", function: { name: "test", parameters: schema } },
    ]) {
      const converted = convertToolToAnthropicTool(tool) as { input_schema: Schema };
      expect(converted.input_schema).not.toHaveProperty("anyOf");
      expect(converted.input_schema.$defs).toEqual(schema.$defs);
      expect(new Validator(converted.input_schema).validate({ value: "hello" }).valid).toBe(true);
    }
  });

  test("preserves Anthropic built-ins and normalizes recursively bound custom tools", () => {
    const captured: unknown[][] = [];
    const makeModel = (): ChatModel => ({
      invoke: async () => ({}),
      bindTools: (tools) => {
        captured.push(tools);
        return makeModel();
      },
    });
    const wrapped = wrapAnthropicModelForToolSchemas(makeModel());
    const builtin = { type: "web_search_20250305", name: "web_search" };
    const rebound = wrapped.bindTools!([
      builtin,
      { name: "custom", description: "Custom", schema: z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]) },
    ]);
    rebound.bindTools!([{ name: "again", description: "Again", schema: z.object({}) }]);

    expect(captured[0]?.[0]).toEqual(builtin);
    expect(captured[0]?.[1]).toMatchObject({
      name: "custom",
      input_schema: { type: "object" },
    });
    expect(captured[1]?.[0]).toMatchObject({
      name: "again",
      input_schema: { type: "object" },
    });
  });
});
