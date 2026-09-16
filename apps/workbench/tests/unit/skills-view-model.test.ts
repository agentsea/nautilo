import { describe, expect, test } from "bun:test";
import {
  formatSkillTitle,
  partitionSkills,
  rowAffordances,
  rowKind,
  type SkillRowKind,
} from "../../src/pages/skills/skills-view-model";
import type { SkillListItem } from "../../src/lib/skills-api";

describe("formatSkillTitle", () => {
  test("title-cases a hyphenated slug", () => {
    expect(formatSkillTitle("interactive-artifact-authoring")).toBe(
      "Interactive Artifact Authoring",
    );
  });
  test("handles underscores and extra separators", () => {
    expect(formatSkillTitle("teaching__mode")).toBe("Teaching Mode");
    expect(formatSkillTitle("quiz")).toBe("Quiz");
  });
});

function skill(overrides: Partial<SkillListItem> & Pick<SkillListItem, "name">): SkillListItem {
  return {
    description: "",
    enabled: true,
    source: "user",
    requiresTools: [],
    tokenEstimate: 100,
    updatedAt: "2026-06-01T00:00:00.000Z",
    official: false,
    forked: false,
    ...overrides,
  };
}

describe("rowKind", () => {
  test("user skill → yours", () => {
    expect(rowKind({ official: false, forked: false })).toBe("yours");
    expect(rowKind({ official: false, forked: true })).toBe("yours");
  });

  test("official untouched → official-untouched", () => {
    expect(rowKind({ official: true, forked: false })).toBe("official-untouched");
  });

  test("official fork → official-customized", () => {
    expect(rowKind({ official: true, forked: true })).toBe("official-customized");
  });
});

describe("rowAffordances", () => {
  const cases: Array<{ kind: SkillRowKind; expected: ReturnType<typeof rowAffordances> }> = [
    {
      kind: "yours",
      expected: {
        badge: null,
        canToggle: true,
        canEdit: true,
        canDelete: true,
        canCustomize: false,
        canReset: false,
      },
    },
    {
      kind: "official-untouched",
      expected: {
        badge: "★ official",
        canToggle: false,
        toggleHint: "Customize to disable",
        canEdit: false,
        canDelete: false,
        canCustomize: true,
        canReset: false,
      },
    },
    {
      kind: "official-customized",
      expected: {
        badge: "★ official · customized",
        canToggle: true,
        canEdit: true,
        canDelete: false,
        canCustomize: false,
        canReset: true,
      },
    },
  ];

  for (const { kind, expected } of cases) {
    test(`${kind}`, () => {
      expect(rowAffordances(kind)).toEqual(expected);
    });
  }
});

describe("partitionSkills", () => {
  test("splits official vs yours and preserves order within each group", () => {
    const a = skill({ name: "a", official: true, forked: false });
    const b = skill({ name: "b", official: false });
    const c = skill({ name: "c", official: true, forked: true });
    const d = skill({ name: "d", official: false });

    const { official, yours } = partitionSkills([a, b, c, d]);

    expect(official.map((s) => s.name)).toEqual(["a", "c"]);
    expect(yours.map((s) => s.name)).toEqual(["b", "d"]);
  });

  test("empty input → empty groups", () => {
    expect(partitionSkills([])).toEqual({ official: [], yours: [] });
  });
});
