import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

/**
 * M071 Phase 1B.8 — narrow guard: selected runtime sources must not reintroduce
 * the pre-resolver default literals removed in 1B.7 / earlier 1B work.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const NAUTILO_ROOT = join(__dirname, "../../../..");

function src(relFromNautiloRoot: string): string {
  return readFileSync(join(NAUTILO_ROOT, relFromNautiloRoot), "utf8");
}

describe("M071 Phase 1B runtime literals (sentinel)", () => {
  test("config-guard paths.ts does not hardcode legacy health base", () => {
    const text = src("packages/config-guard/src/paths.ts");
    expect(text).not.toContain("127.0.0.1:3001");
    expect(text).not.toMatch(/NAUTILO_SERVER_URL.*\?\?\s*["']http:/);
  });

  test("federated-id.ts getServerHostname does not use env ?? nautilo.local literal", () => {
    const text = src("packages/config/src/federated-id.ts");
    expect(text).not.toMatch(
      /getServerHostname[\s\S]*\?\?\s*["']nautilo\.local["']/,
    );
    expect(text).toContain("resolveInstance");
  });
});
