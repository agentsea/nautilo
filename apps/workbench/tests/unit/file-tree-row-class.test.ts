/**
 * Regression lock — file-tree row class string.
 *
 * Context: the browser's default `:focus-visible` outline was painting
 * a bright yellow-orange ring around the focused row in the file tree.
 * The fix is to suppress the outline and let the focused row's
 * `--tree-row-active` fill carry the focus cue. That rule has
 * regressed TWICE (once before D087, once during the staged-patch UX
 * pass). These assertions pin the outline-suppression invariants so a
 * refactor can't silently remove them.
 *
 * If you're here because a test failed: the production code intentionally
 * suppresses Chromium's default focus outline for file-tree rows. If you
 * want to CHANGE the focus treatment (e.g. add a custom subtle ring), do
 * so explicitly — edit `buildFileRowClass` AND update this test. Do NOT
 * delete the assertions without reading the bug history.
 */

import { describe, expect, test } from "bun:test";

import { buildFileRowClass } from "../../src/components/browser-column/file-tree-view";

describe("buildFileRowClass — outline-suppression invariants (do not remove)", () => {
  const focusedClasses = buildFileRowClass(true);
  const unfocusedClasses = buildFileRowClass(false);

  test("both states suppress the default :focus outline", () => {
    for (const cls of [focusedClasses, unfocusedClasses]) {
      expect(cls).toMatch(/\boutline-none\b/);
      expect(cls).toMatch(/\bfocus:outline-none\b/);
      expect(cls).toMatch(/\bfocus-visible:outline-none\b/);
    }
  });

  test("both states suppress the default :focus-visible ring", () => {
    for (const cls of [focusedClasses, unfocusedClasses]) {
      // The yellow ring came back via a stray `focus-visible:ring-*`
      // utility — make sure it's either absent or explicitly zero.
      expect(cls).toMatch(/\bfocus-visible:ring-0\b/);
      expect(cls).not.toMatch(/\bfocus-visible:ring-(1|2|accent|warning|amber|orange|yellow)/);
    }
  });

  test("no warning / amber / yellow / orange tint classes anywhere", () => {
    // Defensive: the ring color was perceived as yellow because Chromium's
    // default `outline: auto` picked up the accent. Explicit warning-tinted
    // classes would be even worse — make sure they never land here.
    for (const cls of [focusedClasses, unfocusedClasses]) {
      expect(cls).not.toMatch(/\b(ring-warning|ring-amber|ring-yellow|ring-orange|border-warning|border-amber|border-yellow|border-orange|outline-warning|outline-amber|outline-yellow|outline-orange)\b/);
    }
  });
});

describe("buildFileRowClass — focus cue behavior", () => {
  // D357: the focus/selection fill moved off the shared --background-element
  // token (near-invisible in dark) to the dedicated --tree-row-active token.
  const ACTIVE_FILL = "bg-[var(--tree-row-active)]";

  test("focused row carries the --tree-row-active fill", () => {
    expect(buildFileRowClass(true).split(/\s+/)).toContain(ACTIVE_FILL);
  });

  test("unfocused row does NOT carry the active fill as a base class", () => {
    // Hover still provides `hover:bg-background-element`, but the resting
    // style should not be filled — assert by exact bare token.
    const tokens = buildFileRowClass(false).split(/\s+/);
    expect(tokens).not.toContain(ACTIVE_FILL);
  });

  test("both states keep the hover discovery affordance", () => {
    for (const cls of [buildFileRowClass(true), buildFileRowClass(false)]) {
      expect(cls).toMatch(/\bhover:bg-background-element\b/);
    }
  });

  test("selected row uses accent border + active fill without warning colors", () => {
    const cls = buildFileRowClass(false, true);
    expect(cls).toMatch(/\bborder-l-2\b/);
    expect(cls).toMatch(/\bborder-accent\b/);
    expect(cls.split(/\s+/)).toContain(ACTIVE_FILL);
    expect(cls).not.toMatch(/\b(border-warning|border-amber|border-yellow|border-orange)\b/);
  });
});
