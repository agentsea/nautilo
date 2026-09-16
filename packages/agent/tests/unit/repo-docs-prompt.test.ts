import { describe, expect, test } from "bun:test";

import { createSystemPrompt } from "../../src/subagents/repo-docs/prompt";

describe("repository documentation prompt boundaries", () => {
  test("does not modify or create repository-wide agent instruction files", () => {
    const prompt = createSystemPrompt("init", "openwiki", "test repository");

    expect(prompt).not.toContain("## OpenWiki");
    expect(prompt).not.toContain("reference the OpenWiki quickstart");
    expect(prompt).not.toContain("create top-level AGENTS.md");
    expect(prompt).toContain(
      "Do not modify any file outside openwiki/, including AGENTS.md, CLAUDE.md",
    );
    expect(prompt).toContain(
      "must never silently promote itself into repository-wide agent authority",
    );
  });

  test("applies the boundary to a custom output directory", () => {
    const prompt = createSystemPrompt("update", "generated-docs", "test repository");

    expect(prompt).toContain("Keep all documentation under generated-docs/");
    expect(prompt).toContain(
      "Do not modify any file outside generated-docs/, including AGENTS.md, CLAUDE.md",
    );
  });
});
