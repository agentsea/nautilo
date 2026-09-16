/**
 * M080 — static regression guards on trust `queries.ts` (M080 block) and
 * agent scope store. Runs in the normal `tests/unit/` process (no DB, no
 * `mock.module` on `@nautilo/db`).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readQueriesM080Block(): string {
  const path = join(__dirname, "../../src/queries.ts");
  const full = readFileSync(path, "utf8");
  const marker = "// M080 — Ephemeral agent scopes";
  const i = full.indexOf(marker);
  if (i < 0) throw new Error(`M080 marker not found in queries.ts`);
  return full.slice(i);
}

describe("M080 queries.ts invariants", () => {
  test("M080 block does not reference removed memory columns or speaker on memories", () => {
    const block = readQueriesM080Block();
    expect(block).not.toMatch(/memories\.owner/i);
    expect(block).not.toMatch(/memories\.room/i);
    expect(block).not.toMatch(/speakerUserId[^\n]*memories/i);
  });
});

describe("M080 agent-scope-store invariants", () => {
  test("attachMemoryToScope source matches M081/M083 guards", () => {
    const path = join(
      __dirname,
      "../../../agent/src/store/agent-scope-store.ts",
    );
    const src = readFileSync(path, "utf8");
    expect(src).not.toMatch(/memories\.owner/i);
    expect(src).not.toMatch(/memories\.room/i);
    expect(src).not.toMatch(/speakerUserId[^\n]*memories/i);
  });
});
