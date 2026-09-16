import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(import.meta.dir, "../../app/(drawer)/(tabs)/settings/skills/[name].tsx"),
  "utf8",
);

describe("mobile Skill capability selector", () => {
  test("defaults to Genie choosing and never asks a Human for internal tool names", () => {
    expect(source).toContain("Needed capabilities");
    expect(source).toContain("Let Genie use what is available");
    expect(source).toContain("listSkillToolOptions()");
    expect(source).toContain('accessibilityRole="checkbox"');
    expect(source).not.toContain("file, run_web_search");
    expect(source).not.toContain("Optional comma-separated tool names");
  });

  test("keeps long Skill instructions inside a bounded editor so actions stay reachable", () => {
    expect(source).toContain("scrollEnabled");
    expect(source).toContain('bodyInput: { height: 260');
    expect(source).not.toContain('bodyInput: { minHeight: 260');
    expect(source).toContain('accessibilityLabel={`Reset ${skill.name} to official`}');
  });
});
