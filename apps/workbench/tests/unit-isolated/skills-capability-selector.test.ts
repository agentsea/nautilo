import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(import.meta.dir, "../../src/pages/skills/skills-page.tsx"),
  "utf8",
);

describe("Desktop Skill capability selector", () => {
  test("defaults to Genie choosing and never asks a Human for internal tool names", () => {
    expect(source).toContain("Needed capabilities");
    expect(source).toContain("Let Genie use what is available");
    expect(source).toContain("fetchSkillToolOptions()");
    expect(source).toContain('type="checkbox"');
    expect(source).not.toContain("file, run_web_search");
    expect(source).not.toContain("Optional comma-separated tool names");
  });
});
