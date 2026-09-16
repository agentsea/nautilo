import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  sanitizeJsonSchemaForGemini,
  convertToolToSanitizedOpenAITool,
  GEMINI_INCOMPATIBLE_SCHEMA_KEYS,
} from "../../src/providers/gemini-schema";
import { createApplyPatchTool } from "../../src/tools/apply-patch/apply-patch-tool";

const providerFixture = JSON.parse(readFileSync(
  join(import.meta.dir, "../fixtures/apply-patch/capability/provider-schema.json"),
  "utf8",
)) as { readonly parameters: Record<string, unknown> };

describe("sanitizeJsonSchemaForGemini", () => {
  test("strips exclusiveMinimum and exclusiveMaximum at any depth", () => {
    const input = {
      type: "object",
      properties: {
        n: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 100, minimum: 0 },
        nested: {
          type: "object",
          properties: {
            inner: { type: "number", exclusiveMinimum: 1 },
          },
        },
      },
    };
    const out = sanitizeJsonSchemaForGemini(input) as {
      properties: { n: Record<string, unknown>; nested: { properties: { inner: Record<string, unknown> } } };
    };
    expect(out.properties.n).not.toHaveProperty("exclusiveMinimum");
    expect(out.properties.n).not.toHaveProperty("exclusiveMaximum");
    expect(out.properties.n).toHaveProperty("minimum", 0);
    expect(out.properties.nested.properties.inner).not.toHaveProperty("exclusiveMinimum");
  });

  test("preserves unrelated keywords (description, enum, format, type, etc.)", () => {
    const input = {
      type: "string",
      description: "an email",
      format: "email",
      enum: ["a", "b"],
      pattern: "^.+$",
      minLength: 1,
      maxLength: 100,
    };
    const out = sanitizeJsonSchemaForGemini(input);
    expect(out).toEqual(input);
  });

  test("handles arrays of schemas", () => {
    const input = {
      type: "array",
      items: { type: "number", exclusiveMinimum: 0 },
    };
    const out = sanitizeJsonSchemaForGemini(input) as { items: Record<string, unknown> };
    expect(out.items).not.toHaveProperty("exclusiveMinimum");
    expect(out.items).toHaveProperty("type", "number");
  });

  test("is non-mutating", () => {
    const input = { type: "number", exclusiveMinimum: 5 };
    const before = JSON.stringify(input);
    sanitizeJsonSchemaForGemini(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  test("strips $schema, $id, $ref, $defs, allOf and other Gemini-rejected keywords", () => {
    const input = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "x",
      $defs: { foo: { type: "string" } },
      allOf: [{ type: "object" }],
      type: "object",
    };
    const out = sanitizeJsonSchemaForGemini(input) as Record<string, unknown>;
    for (const key of ["$schema", "$id", "$defs", "allOf"]) {
      expect(out).not.toHaveProperty(key);
    }
    expect(out).toHaveProperty("type", "object");
  });

  test("primitives and null pass through unchanged", () => {
    expect(sanitizeJsonSchemaForGemini(null)).toBeNull();
    expect(sanitizeJsonSchemaForGemini(42)).toBe(42);
    expect(sanitizeJsonSchemaForGemini("hi")).toBe("hi");
  });

  test("GEMINI_INCOMPATIBLE_SCHEMA_KEYS contains the documented exclusion list", () => {
    expect(GEMINI_INCOMPATIBLE_SCHEMA_KEYS.has("exclusiveMinimum")).toBe(true);
    expect(GEMINI_INCOMPATIBLE_SCHEMA_KEYS.has("exclusiveMaximum")).toBe(true);
  });
});

describe("convertToolToSanitizedOpenAITool", () => {
  test("emits apply_patch's implemented provider schema exactly", () => {
    const tool = createApplyPatchTool();
    const out = convertToolToSanitizedOpenAITool(tool) as {
      function: { parameters: Record<string, unknown> };
    };
    expect(out.function.parameters).toEqual(providerFixture.parameters);
  });

  test("converts a Zod-schema tool into OpenAI shape with sanitized parameters", () => {
    // Mimic a LangChain `StructuredTool` enough that the helper sees
    // `name`, `description`, and `schema` (Zod). z.number().gt(0) emits
    // `exclusiveMinimum` in the JSON Schema output.
    const tool = {
      name: "score",
      description: "rank a document",
      schema: z.object({ score: z.number().gt(0).lt(100) }),
    };
    const out = convertToolToSanitizedOpenAITool(tool) as {
      type: string;
      function: { name: string; description: string; parameters: { properties: { score: Record<string, unknown> } } };
    };
    expect(out.type).toBe("function");
    expect(out.function.name).toBe("score");
    expect(out.function.description).toBe("rank a document");
    expect(out.function.parameters.properties.score).not.toHaveProperty("exclusiveMinimum");
    expect(out.function.parameters.properties.score).not.toHaveProperty("exclusiveMaximum");
  });

  test("passes through non-LangChain tools unchanged", () => {
    const native = { functionDeclarations: [{ name: "x", parameters: { type: "object" } }] };
    expect(convertToolToSanitizedOpenAITool(native)).toBe(native);
    expect(convertToolToSanitizedOpenAITool(null)).toBeNull();
    expect(convertToolToSanitizedOpenAITool({ name: "x" /* no schema */ })).toEqual({ name: "x" });
  });
});
