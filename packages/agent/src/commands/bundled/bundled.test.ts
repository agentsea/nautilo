import { describe, expect, test } from "bun:test";
import { getBundledCommand, OFFICIAL_COMMANDS } from "./index";
import { parseFrontmatter } from "./parse-frontmatter";

describe("OFFICIAL_COMMANDS registry", () => {
  test("loads the expected official commands with valid metadata", () => {
    expect(OFFICIAL_COMMANDS).toHaveLength(7);
    for (const cmd of OFFICIAL_COMMANDS) {
      expect(cmd.source).toBe("official");
      expect(Number.isFinite(cmd.version)).toBe(true);
      expect(cmd.id).toBe(`official:${cmd.name}`);
      expect(cmd.description.length).toBeGreaterThan(0);
      expect(cmd.body.length).toBeGreaterThan(0);
    }
    expect(OFFICIAL_COMMANDS.map((c) => c.name).sort()).toEqual([
      "explain",
      "intro",
      "release-notes",
      "review-diff",
      "summarize",
      "tone-professional",
      "write-tests",
    ]);
  });

  test("intro metadata + body", () => {
    const cmd = getBundledCommand("intro")!;
    expect(cmd.source).toBe("official");
    expect(cmd.version).toBe(3);
    expect(cmd.id).toBe("official:intro");
    expect(cmd.body).toContain("$ARGUMENTS");
    // Guides an offer-to-launch that defers to explicit user consent.
    expect(cmd.body).toContain("launch_customization");
    expect(cmd.body).toContain("find_explainer");
    expect(cmd.body).toContain("hasMore");
    expect(cmd.body).toContain("play_explainer");
    expect(cmd.body).toContain("does not authorize autoplay");
  });

  test("summarize metadata + body", () => {
    const cmd = getBundledCommand("summarize")!;
    expect(cmd.source).toBe("official");
    expect(cmd.version).toBe(1);
    expect(cmd.id).toBe("official:summarize");
    expect(cmd.body).toContain("$ARGUMENTS");
  });

  test("review-diff metadata + body", () => {
    const cmd = getBundledCommand("review-diff")!;
    expect(cmd.source).toBe("official");
    expect(cmd.version).toBe(1);
    expect(cmd.id).toBe("official:review-diff");
    expect(cmd.body).toContain("$ARGUMENTS");
    expect(cmd.body).toContain("Verdict");
  });

  test("explain metadata + body", () => {
    const cmd = getBundledCommand("explain")!;
    expect(cmd.source).toBe("official");
    expect(cmd.version).toBe(1);
    expect(cmd.id).toBe("official:explain");
    expect(cmd.body).toContain("$ARGUMENTS");
  });

  test("write-tests metadata + body", () => {
    const cmd = getBundledCommand("write-tests")!;
    expect(cmd.source).toBe("official");
    expect(cmd.version).toBe(1);
    expect(cmd.id).toBe("official:write-tests");
    expect(cmd.body).toContain("$ARGUMENTS");
  });

  test("release-notes metadata + body", () => {
    const cmd = getBundledCommand("release-notes")!;
    expect(cmd.source).toBe("official");
    expect(cmd.version).toBe(1);
    expect(cmd.id).toBe("official:release-notes");
    expect(cmd.body).toContain("$ARGUMENTS");
  });

  test("tone-professional metadata + body", () => {
    const cmd = getBundledCommand("tone-professional")!;
    expect(cmd.source).toBe("official");
    expect(cmd.version).toBe(1);
    expect(cmd.id).toBe("official:tone-professional");
    expect(cmd.body).toContain("$ARGUMENTS");
  });

  test("getBundledCommand lookup", () => {
    const cmd = getBundledCommand("summarize");
    expect(cmd).toBeDefined();
    expect(cmd?.id).toBe("official:summarize");

    expect(getBundledCommand("nope")).toBeUndefined();
  });
});

describe("parseFrontmatter", () => {
  test("throws on malformed frontmatter block", () => {
    expect(() => parseFrontmatter("no frontmatter here")).toThrow(
      "must start with a frontmatter block",
    );

    expect(() => parseFrontmatter("---\nname: foo\nno closing delimiter")).toThrow(
      "malformed or unclosed frontmatter block",
    );

    expect(() =>
      parseFrontmatter(`---
name: test-command
description: A test
source: official
---
# Body
`),
    ).toThrow("missing required key: version");
  });

  test("parses valid frontmatter and body", () => {
    const { frontmatter, body } = parseFrontmatter(`---
name: test-command
description: A test command
source: official
version: 2
---

# Heading

Body text.
`);

    expect(frontmatter.name).toBe("test-command");
    expect(frontmatter.description).toBe("A test command");
    expect(frontmatter.source).toBe("official");
    expect(frontmatter.version).toBe("2");
    expect(body).toBe("# Heading\n\nBody text.\n");
  });
});
