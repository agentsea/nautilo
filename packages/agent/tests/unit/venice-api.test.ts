/**
 * Regression: every Venice API root must come from
 * `packages/agent/src/providers/venice-api.ts`. Other modules previously
 * had their own copies of `https://api.venice.ai/api/v1` which drifted
 * (e.g. catalog-cache vs universal.ts) and made overrides brittle.
 *
 * This test scans the agent package source for the `api.venice.ai` literal
 * and rejects occurrences outside `venice-api.ts`. Comments / log strings
 * that just *mention* the host are allowed (they don't construct URLs).
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  VENICE_API_V1_BASE,
  VENICE_CHAT_COMPLETIONS_URL,
  VENICE_EMBEDDINGS_URL,
  VENICE_IMAGE_GENERATION_URL,
  VENICE_MODELS_LIST_URL,
} from "../../src/providers/venice-api";

const AGENT_SRC = join(import.meta.dirname, "../../src");
const ALLOWED_FILE = join(AGENT_SRC, "providers/venice-api.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("Venice API URL is centralized in venice-api.ts", () => {
  test("VENICE_API_V1_BASE / *_URL constants have the expected shape", () => {
    expect(VENICE_API_V1_BASE).toBe("https://api.venice.ai/api/v1");
    expect(VENICE_CHAT_COMPLETIONS_URL.startsWith(VENICE_API_V1_BASE)).toBe(true);
    expect(VENICE_EMBEDDINGS_URL.startsWith(VENICE_API_V1_BASE)).toBe(true);
    expect(VENICE_IMAGE_GENERATION_URL.startsWith(VENICE_API_V1_BASE)).toBe(true);
    expect(VENICE_MODELS_LIST_URL).toBe(`${VENICE_API_V1_BASE}/models?type=all`);
  });

  test("no other agent source file constructs a URL via the api.venice.ai host literal", () => {
    const files = walk(AGENT_SRC);
    const offenders: { file: string; line: number; text: string }[] = [];
    for (const f of files) {
      if (f === ALLOWED_FILE) continue;
      const src = readFileSync(f, "utf8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (!line.includes("api.venice.ai")) continue;
        // Skip pure comment / log mentions (no URL construction).
        const trimmed = line.trim();
        const isComment = trimmed.startsWith("//") || trimmed.startsWith("*");
        const looksLikeUrl = /https?:\/\/api\.venice\.ai/.test(line);
        if (isComment && !looksLikeUrl) continue;
        if (looksLikeUrl) {
          offenders.push({ file: f, line: i + 1, text: trimmed });
        }
      }
    }
    if (offenders.length > 0) {
      const msg = offenders
        .map((o) => `  ${o.file}:${o.line}  ${o.text}`)
        .join("\n");
      throw new Error(
        `Found api.venice.ai URL literal outside packages/agent/src/providers/venice-api.ts:\n${msg}\n\n` +
          `Import VENICE_API_V1_BASE / VENICE_CHAT_COMPLETIONS_URL / VENICE_MODELS_LIST_URL instead.`,
      );
    }
    expect(offenders).toEqual([]);
  });
});
