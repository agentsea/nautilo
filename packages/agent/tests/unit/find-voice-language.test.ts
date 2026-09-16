/**
 * D261 Phase 3/4 — find_voice language filter (structured JSON, curated catalog, no API key).
 */
import { describe, expect, test } from "bun:test";
import type { FindVoiceToolResult } from "@nautilo/types";
import { createFindVoiceTool } from "../../src/tools/config/find-voice";

function parseResult(raw: string): FindVoiceToolResult {
  return JSON.parse(raw) as FindVoiceToolResult;
}

describe("D261 — find_voice language filter", () => {
  test("language=es returns Spanish curated voices only", async () => {
    const prev = process.env["ELEVENLABS_API_KEY"];
    delete process.env["ELEVENLABS_API_KEY"];
    try {
      const tool = createFindVoiceTool();
      const out = parseResult(await tool.invoke({ query: "", language: "es", limit: 10 }));
      const names = out.candidates.map((c) => c.name.toLowerCase());
      expect(names.some((n) => n.includes("beatriz"))).toBe(true);
      expect(names.some((n) => n.includes("carolyn"))).toBe(false);
      expect(names.some((n) => n.includes("jessica"))).toBe(false);
    } finally {
      if (prev !== undefined) process.env["ELEVENLABS_API_KEY"] = prev;
    }
  });

  test("language=en returns English curated voices", async () => {
    const prev = process.env["ELEVENLABS_API_KEY"];
    delete process.env["ELEVENLABS_API_KEY"];
    try {
      const tool = createFindVoiceTool();
      const out = parseResult(await tool.invoke({ query: "", language: "en", limit: 10 }));
      const names = out.candidates.map((c) => c.name.toLowerCase());
      expect(names.some((n) => n.includes("carolyn"))).toBe(true);
      expect(names.some((n) => n.includes("jessica"))).toBe(true);
      expect(names.some((n) => n.includes("beatriz"))).toBe(false);
    } finally {
      if (prev !== undefined) process.env["ELEVENLABS_API_KEY"] = prev;
    }
  });
});
