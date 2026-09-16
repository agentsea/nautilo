import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ELEVENLABS_CURATED_VOICE_IDS } from "../../src/lib/curated-voices.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "data");

const VOICE_RE = /^[a-z]+:[a-z0-9_-]+$/i;

describe("Genie curated data files", () => {
  test("genie-names.json size and parse", () => {
    const raw = readFileSync(join(root, "genie-names.json"), "utf8");
    const names = JSON.parse(raw) as string[];
    expect(Array.isArray(names)).toBe(true);
    expect(names.length).toBeGreaterThan(100);
    expect(names.length).toBeLessThan(500);
  });

  test("genie-personalities.json: unique ids, archetype + soul file fields populated", () => {
    // D112 Phase 19.6 — every archetype must ship a hand-authored
    // `soulFile` with the `{{NAME}}` placeholder so randomized setups
    // land with a real persona instead of `soulFile: null` (which used
    // to trigger an unsolicited `regenerate_soul` call on first turn).
    const raw = readFileSync(join(root, "genie-personalities.json"), "utf8");
    const rows = JSON.parse(raw) as {
      id: string;
      archetype: string;
      summary: string;
      soulFile: string;
    }[];

    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);

    expect(rows.length).toBeGreaterThanOrEqual(10);

    for (const r of rows) {
      expect(typeof r.id).toBe("string");
      expect(r.id.length).toBeGreaterThan(0);
      expect(typeof r.archetype).toBe("string");
      expect(r.archetype.length).toBeGreaterThan(0);
      expect(r.summary.length).toBeGreaterThan(10);
      expect(typeof r.soulFile).toBe("string");
      expect(r.soulFile).toContain("{{NAME}}");
      expect(r.soulFile.length).toBeGreaterThan(400);
    }
  });

  test("genie-voices.json ids match voice regex", () => {
    const raw = readFileSync(join(root, "genie-voices.json"), "utf8");
    const rows = JSON.parse(raw) as { id: string; label: string }[];
    expect(rows.length).toBe(Object.keys(ELEVENLABS_CURATED_VOICE_IDS).length);
    for (const r of rows) {
      expect(r.id).toMatch(VOICE_RE);
      expect(r.id.startsWith("elevenlabs:")).toBe(true);
      const [, slug = ""] = r.id.split(":", 2);
      expect(ELEVENLABS_CURATED_VOICE_IDS[slug]).toBeDefined();
      expect(r.label.length).toBeGreaterThan(0);
    }
    for (const slug of Object.keys(ELEVENLABS_CURATED_VOICE_IDS)) {
      expect(rows.some((r) => r.id === `elevenlabs:${slug}`)).toBe(true);
    }
  });
});
