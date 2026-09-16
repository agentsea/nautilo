/**
 * D124 / Stack 112 — new-chat empty state must render the profile avatar,
 * not a hardcoded shell glyph. The assistant name already came from
 * `useProfile()`; the hero avatar was the regression.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("conversation empty-state avatar (D124)", () => {
  test("ThreadPrimitive.Empty uses AuthenticatedAvatar with profile avatarSrc", () => {
    const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
    const source = readFileSync(`${repoRoot}src/components/conversation.tsx`, "utf8");
    const emptyBlock = source.slice(
      source.indexOf("<ThreadPrimitive.Empty>"),
      source.indexOf("</ThreadPrimitive.Empty>"),
    );

    expect(emptyBlock).toContain("AuthenticatedAvatar");
    expect(emptyBlock).toContain("src={avatarSrc}");
    // Regression: pre-D124 the empty hero was a bare shell glyph, not profile avatar.
    expect(emptyBlock).not.toMatch(
      /rounded-full bg-background-element text-2xl">\s*🐚\s*<\/div>/,
    );
  });
});
