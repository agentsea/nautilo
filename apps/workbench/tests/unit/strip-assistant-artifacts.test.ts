/**
 * D087 Phase 1 — anti-regression tests for the render-time filter
 * that strips narrator emotion tags and tool-call scratchpad
 * scaffolding from assistant-authored text.
 *
 * The filter lives in `apps/workbench/src/lib/strip-assistant-artifacts.ts`
 * and is called by `conversation.tsx`'s `AssistantBubble` (empty-bubble
 * suppression) and `AssistantText` (markdown preprocess). Both call
 * sites rely on the guarantees locked below:
 *
 *   1. TAG MARKERS are removed; INTERIOR content is preserved.
 *   2. SELF-CLOSING forms (`<result/>`) are handled.
 *   3. WORD-BOUNDARY is enforced so `<resultSet>`-style identifiers are
 *      NOT false-positive stripped.
 *   4. Only the ENUMERATED emotion tags strip; unknown bracketed
 *      tokens (`[todo]`, `[cite:42]`, …) are preserved.
 *   5. `isEmptyAfterStrip` treats whitespace-only as empty — matches
 *      the bubble-suppression intent.
 *   6. Pure: idempotent, no mutation, no throws.
 *
 * If any of these properties regress, the bug the D087 UX pass fixed
 * (stray `<result> </result>` blocks bleeding into the conversation
 * log, "Genie:" ghost bubbles with nothing inside, false-positive
 * strips of legitimate `<resultSet>` identifiers) comes back.
 */

import { describe, test, expect } from "bun:test";
import {
  stripAssistantArtifacts,
  isEmptyAfterStrip,
} from "../../src/lib/strip-assistant-artifacts";

describe("stripAssistantArtifacts — XML scaffold tags", () => {
  test("strips paired <result> markers and preserves interior content", () => {
    expect(stripAssistantArtifacts("<result>keep me</result>")).toBe("keep me");
  });

  test("strips <answer>, <thinking>, and <output> pairs the same way", () => {
    expect(stripAssistantArtifacts("<answer>A</answer>")).toBe("A");
    expect(stripAssistantArtifacts("<thinking>B</thinking>")).toBe("B");
    expect(stripAssistantArtifacts("<output>C</output>")).toBe("C");
  });

  test("strips self-closing form (`<result/>`) entirely", () => {
    expect(stripAssistantArtifacts("<result/>")).toBe("");
    expect(stripAssistantArtifacts("before<result/>after")).toBe("beforeafter");
  });

  test("strips tags with trailing whitespace before `>`", () => {
    expect(stripAssistantArtifacts("<result >keep</result >")).toBe("keep");
    expect(stripAssistantArtifacts("<thinking   />")).toBe("");
  });

  test("empty-tag pair (`<result></result>`) yields empty string", () => {
    expect(stripAssistantArtifacts("<result></result>")).toBe("");
    expect(stripAssistantArtifacts("<result>   </result>")).toBe("   ");
  });

  // ---- NEGATIVE BOUNDARIES — word-boundary guarantee ---------------------

  test("`<resultSet>` is NOT stripped (word-boundary protection)", () => {
    // The regex `<\/?(result|answer|thinking|output)\s*\/?>` requires
    // the tag name to be immediately followed by whitespace, `/`, or
    // `>`. `<resultSet>` has `S` after `result`, so the match refuses.
    // If this test starts failing, the XML_SCAFFOLD_TAG_RE has been
    // loosened in a way that risks collateral damage to legitimate
    // `<resultSet>` / `<thinking-face>` / `<outputBuffer>` identifiers
    // inside code fences or XML-ish content.
    expect(stripAssistantArtifacts("<resultSet>data</resultSet>")).toBe(
      "<resultSet>data</resultSet>",
    );
  });

  test("`<results>`, `<answers>`, and `<thinker>` are NOT stripped", () => {
    expect(stripAssistantArtifacts("<results/>")).toBe("<results/>");
    expect(stripAssistantArtifacts("<answers>many</answers>")).toBe(
      "<answers>many</answers>",
    );
    expect(stripAssistantArtifacts("<thinker>name</thinker>")).toBe(
      "<thinker>name</thinker>",
    );
  });

  test("tags with attributes are NOT stripped (preserves legitimate XML)", () => {
    // `<result score="0.9">` has `"` after `result` via the space —
    // the attribute shape doesn't match `\s*\/?>`. Preserved.
    expect(
      stripAssistantArtifacts(`<result score="0.9">value</result>`),
    ).toBe(`<result score="0.9">value`);
    // NOTE: the CLOSING `</result>` is still stripped because it
    // matches the regex cleanly (no attrs on close tags). This is
    // the expected behavior — attrs on opening tag leave the opening
    // tag alone but the close is still cleaned up. The net result
    // still has the opening tag visible, which is fine — this shape
    // almost never appears in Claude output in practice; the only
    // path that concerns us is the bare `<result>…</result>` pairs.
  });
});

describe("stripAssistantArtifacts — emotion tags", () => {
  test("strips known narrator emotion tags with trailing space", () => {
    expect(stripAssistantArtifacts("[laughs] hello")).toBe("hello");
    expect(stripAssistantArtifacts("[sighs] maybe")).toBe("maybe");
    expect(stripAssistantArtifacts("[cheerful] Loud and clear")).toBe(
      "Loud and clear",
    );
    expect(stripAssistantArtifacts("I am [excited] about this")).toBe(
      "I am about this",
    );
  });

  test("strips multi-word emotion tags (happy gasp / frustrated sigh / clears throat)", () => {
    expect(stripAssistantArtifacts("[happy gasp] yes!")).toBe("yes!");
    expect(stripAssistantArtifacts("[frustrated sigh] okay…")).toBe("okay…");
    expect(stripAssistantArtifacts("[clears throat] as I was saying")).toBe(
      "as I was saying",
    );
  });

  test("case-insensitive matching", () => {
    expect(stripAssistantArtifacts("[Laughs] hi")).toBe("hi");
    expect(stripAssistantArtifacts("[SIGHS]")).toBe("");
  });

  // ---- NEGATIVE BOUNDARIES — emotion-tag closed list --------------------

  test("UNKNOWN bracketed tokens are preserved (cite / todo / doc-link markers)", () => {
    // These are legitimate markers other systems embed in assistant
    // text. A greedy `\[\w+\]` style strip would eat them. The closed
    // list keeps them safe.
    expect(stripAssistantArtifacts("see [cite:42] for details")).toBe(
      "see [cite:42] for details",
    );
    expect(stripAssistantArtifacts("[todo] fix later")).toBe("[todo] fix later");
    expect(stripAssistantArtifacts("note [doc:auth.md]")).toBe(
      "note [doc:auth.md]",
    );
    expect(stripAssistantArtifacts("[skeptical]")).toBe("[skeptical]");
  });

  test("brackets with commas inside are preserved (not a single emotion tag)", () => {
    expect(stripAssistantArtifacts("[laughs, then sighs]")).toBe(
      "[laughs, then sighs]",
    );
  });
});

describe("stripAssistantArtifacts — structural properties", () => {
  test("idempotent (running twice produces the same output as once)", () => {
    const input = "<result>[laughs] hi</result>";
    expect(stripAssistantArtifacts(stripAssistantArtifacts(input))).toBe(
      stripAssistantArtifacts(input),
    );
  });

  test("empty string returns empty string", () => {
    expect(stripAssistantArtifacts("")).toBe("");
  });

  test("plain text with no artifacts passes through unchanged", () => {
    const input =
      "Hello, I am Genie. I can help you today with anything you need.";
    expect(stripAssistantArtifacts(input)).toBe(input);
  });

  test("does not throw on unusual inputs", () => {
    expect(() => stripAssistantArtifacts("\n\t ")).not.toThrow();
    expect(() => stripAssistantArtifacts("<<<>>>")).not.toThrow();
    expect(() => stripAssistantArtifacts("[[[]]]")).not.toThrow();
  });

  test("strips across multiline content (global flag is set)", () => {
    const input = `line one [laughs]
<result>
line three
</result>
line five [sighs]`;
    const out = stripAssistantArtifacts(input);
    expect(out).not.toContain("[laughs]");
    expect(out).not.toContain("[sighs]");
    expect(out).not.toContain("<result>");
    expect(out).not.toContain("</result>");
    expect(out).toContain("line one");
    expect(out).toContain("line three");
    expect(out).toContain("line five");
  });
});

describe("stripAssistantArtifacts — D261 voice markup", () => {
  test("strips paired <voice lang> markers and preserves interior", () => {
    expect(
      stripAssistantArtifacts('<voice lang="es">¿Cómo estás?</voice>'),
    ).toBe("¿Cómo estás?");
  });

  test("strips voice tags inside longer assistant prose", () => {
    const input =
      'Hello. <voice lang="es">¿Cómo estás?</voice> I asked in Spanish.';
    expect(stripAssistantArtifacts(input)).toBe(
      "Hello. ¿Cómo estás? I asked in Spanish.",
    );
  });
});

describe("isEmptyAfterStrip — bubble-suppression gate", () => {
  test("true for empty string", () => {
    expect(isEmptyAfterStrip("")).toBe(true);
  });

  test("true for whitespace-only", () => {
    expect(isEmptyAfterStrip("   \n\t ")).toBe(true);
  });

  test("true for `<result></result>` (empty pair) — the canonical bug shape", () => {
    // This is THE scenario commit 90edc00 fixed: Claude emits an empty
    // `<result></result>` block, strip yields "", and the bubble must
    // suppress so no ghost "Genie:" label renders.
    expect(isEmptyAfterStrip("<result></result>")).toBe(true);
  });

  test("true for whitespace-only inside `<result>` pair", () => {
    expect(isEmptyAfterStrip("<result>   \n  </result>")).toBe(true);
  });

  test("false when stripped content has non-whitespace characters", () => {
    expect(isEmptyAfterStrip("<result>ok</result>")).toBe(false);
    expect(isEmptyAfterStrip("hi")).toBe(false);
    expect(isEmptyAfterStrip("[laughs] yes")).toBe(false);
  });
});
