import { describe, expect, test } from "bun:test";
import {
  formatCommandTitle,
  partitionCommands,
  rowAffordances,
  rowKind,
  type CommandRowKind,
} from "../../src/pages/commands/commands-view-model";
import type { CommandListItem } from "../../src/lib/commands-api";

describe("formatCommandTitle", () => {
  test("title-cases a hyphenated slug", () => {
    expect(formatCommandTitle("interactive-artifact-authoring")).toBe(
      "Interactive Artifact Authoring",
    );
  });
  test("handles underscores and extra separators", () => {
    expect(formatCommandTitle("teaching__mode")).toBe("Teaching Mode");
    expect(formatCommandTitle("quiz")).toBe("Quiz");
  });
});

function command(
  overrides: Partial<CommandListItem> & Pick<CommandListItem, "name">,
): CommandListItem {
  return {
    description: "",
    enabled: true,
    source: "user",
    tokenEstimate: 100,
    updatedAt: "2026-06-01T00:00:00.000Z",
    official: false,
    forked: false,
    ...overrides,
  };
}

describe("rowKind", () => {
  test("user command → yours", () => {
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
  const cases: Array<{ kind: CommandRowKind; expected: ReturnType<typeof rowAffordances> }> = [
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

describe("partitionCommands", () => {
  test("splits official vs yours and preserves order within each group", () => {
    const a = command({ name: "a", official: true, forked: false });
    const b = command({ name: "b", official: false });
    const c = command({ name: "c", official: true, forked: true });
    const d = command({ name: "d", official: false });

    const { official, yours } = partitionCommands([a, b, c, d]);

    expect(official.map((c) => c.name)).toEqual(["a", "c"]);
    expect(yours.map((c) => c.name)).toEqual(["b", "d"]);
  });

  test("empty input → empty groups", () => {
    expect(partitionCommands([])).toEqual({ official: [], yours: [] });
  });
});
