/**
 * Regression: api-client + workbench each maintain a hand-edited
 * `LLM_KEY_IDS` set because they ship in browser bundles and cannot
 * import the registry at runtime (transitively pulls `node:path`).
 *
 * This test is the contract that says: if you add a new LLM provider
 * to `key-registry.ts`, you MUST also update both browser-side sets.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAllKeyDefinitions } from "../../src/index";

const PACKAGE_ROOT = join(import.meta.dirname, "../..");
const REPO_ROOT = join(PACKAGE_ROOT, "../..");

const CONSUMERS = [
  {
    label: "packages/api-client/src/client.ts",
    path: join(REPO_ROOT, "packages/api-client/src/client.ts"),
  },
  {
    label: "apps/workbench/src/pages/settings/sections/model-section.tsx",
    path: join(REPO_ROOT, "apps/workbench/src/pages/settings/sections/model-section.tsx"),
  },
] as const;

function extractLlmKeyIds(src: string): string[] {
  // Matches:  const LLM_KEY_IDS = new Set<...>([ "a", "b", ... ]);
  const m = src.match(/const\s+LLM_KEY_IDS\s*=\s*new\s+Set(?:<[^>]*>)?\s*\(\s*\[([\s\S]*?)\]\s*\)/);
  if (!m) {
    throw new Error("Could not locate `LLM_KEY_IDS = new Set([...])` in source");
  }
  const body = m[1] ?? "";
  const ids: string[] = [];
  const idRe = /["']([^"']+)["']/g;
  let im: RegExpExecArray | null;
  while ((im = idRe.exec(body)) !== null) {
    ids.push(im[1] ?? "");
  }
  return ids;
}

describe("LLM_KEY_IDS hand-maintained sets must not drift from key-registry", () => {
  const canonical = new Set(
    getAllKeyDefinitions()
      .filter((d) => d.category === "llm" || d.category === "llm+embeddings")
      .map((d) => d.id),
  );

  for (const { label, path } of CONSUMERS) {
    test(`${label} matches the registry exactly`, () => {
      const src = readFileSync(path, "utf8");
      const found = new Set(extractLlmKeyIds(src));
      const missing = [...canonical].filter((id) => !found.has(id));
      const extra = [...found].filter((id) => !canonical.has(id));
      if (missing.length > 0 || extra.length > 0) {
        throw new Error(
          [
            `${label} drifted from canonical LLM key registry.`,
            missing.length > 0 ? `  Missing (in registry but not in file): ${missing.join(", ")}` : null,
            extra.length > 0 ? `  Extra (in file but not in registry): ${extra.join(", ")}` : null,
            `  Canonical set: ${[...canonical].sort().join(", ")}`,
            ``,
            `  If you added a new LLM provider, update BOTH:`,
            `    - packages/api-client/src/client.ts`,
            `    - apps/workbench/src/pages/settings/sections/model-section.tsx`,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
      expect([...found].sort()).toEqual([...canonical].sort());
    });
  }
});
