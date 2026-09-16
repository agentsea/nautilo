import { describe, test, expect } from "bun:test";
import {
  extractSoulEssence,
  SOUL_FALLBACK_PROMPT,
} from "../../src/components/soul-extract";

describe("extractSoulEssence", () => {
  test("returns null for null / undefined / empty input", () => {
    expect(extractSoulEssence(null)).toBe(null);
    expect(extractSoulEssence(undefined)).toBe(null);
    expect(extractSoulEssence("")).toBe(null);
  });

  test("returns null when soul has no Essence section", () => {
    const md = `# Genie — Soul File

## Voice
warm, grounded

## Style
concise`;
    expect(extractSoulEssence(md)).toBe(null);
  });

  test("extracts single-paragraph Essence body", () => {
    const md = `# Genie — Soul File

## Essence
Genie is a chosen presence, not a generic assistant.

## Voice
warm`;
    expect(extractSoulEssence(md)).toBe(
      "Genie is a chosen presence, not a generic assistant.",
    );
  });

  test("extracts multi-paragraph Essence body with blank lines preserved between paragraphs", () => {
    const md = `# Genie — Soul File

## Essence
First paragraph about Genie.

Second paragraph with more detail.

## Voice
warm`;
    const out = extractSoulEssence(md);
    expect(out).toBe(
      "First paragraph about Genie.\n\nSecond paragraph with more detail.",
    );
  });

  test("extracts to end of file when Essence is the last section", () => {
    const md = `# Genie

## Essence
Closing essence content.`;
    expect(extractSoulEssence(md)).toBe("Closing essence content.");
  });

  test("tolerates case variations in the Essence header", () => {
    expect(extractSoulEssence("## essence\nbody\n")).toBe("body");
    expect(extractSoulEssence("## ESSENCE\nbody\n")).toBe("body");
    expect(extractSoulEssence("##  Essence  \nbody\n")).toBe("body");
  });

  test("trims leading and trailing blank lines from the body", () => {
    const md = `## Essence



paragraph with surrounding blanks




## Voice
x`;
    expect(extractSoulEssence(md)).toBe("paragraph with surrounding blanks");
  });

  test("handles CRLF line endings", () => {
    const md = "## Essence\r\nCRLF line.\r\n\r\n## Voice\r\nx";
    expect(extractSoulEssence(md)).toBe("CRLF line.");
  });

  test("fallback prompt is user-directed to the fix (not lorem ipsum)", () => {
    // Regression guard — the fallback is a real "go do this" prompt,
    // not filler text like "Genie is not a generic chatbot..."
    // which was the old hardcoded stub. If someone replaces this with
    // lorem ipsum, the test fails loudly.
    expect(SOUL_FALLBACK_PROMPT).toContain("Settings");
    expect(SOUL_FALLBACK_PROMPT).toContain("Add soul instructions");
    expect(SOUL_FALLBACK_PROMPT.toLowerCase()).not.toContain("lorem");
  });
});
