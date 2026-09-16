/**
 * M162 Phase 2 — file-tool description + system-prompt text for
 * immediate-apply edits (no staging / Accept / apply_patch guidance).
 */

import { describe, expect, test } from "bun:test";
import { buildFileEditsBlock } from "../../src/prompts/templates";
import { createFileTool } from "../../src/tools/file/file-tool";

const FORBIDDEN_IN_FILE_EDIT_GUIDANCE = ["staged", "Staged", "Accept", "Awaiting"] as const;

describe("M162 Phase 2 — file tool description", () => {
  test("FILE_TOOL_DESCRIPTION has no staging / Accept / Awaiting wording", () => {
    const desc = createFileTool().description;
    for (const word of FORBIDDEN_IN_FILE_EDIT_GUIDANCE) {
      expect(desc).not.toContain(word);
    }
    expect(desc).toMatch(/apply immediately/i);
    expect(desc).toContain("Revert");
    expect(desc).toMatch(/revisionId/);
    expect(desc).not.toMatch(/apply_patch/);
    expect(desc).not.toMatch(/list_patches/);
  });
});

describe("M162 Phase 2 — buildFileEditsBlock system prompt", () => {
  test("File edits block documents immediate apply, Revert, and undo", () => {
    const block = buildFileEditsBlock();
    expect(block).toContain("## File edits");
    expect(block).toMatch(/apply immediately/i);
    expect(block).toContain("Revert");
    expect(block).toContain("undo");
    expect(block).toContain('command:"undo"');
  });
});
