import { describe, expect, test } from "bun:test";
import {
  audienceBadgeLabel,
  audienceState,
  audienceStateFromAccessList,
  canManageAccess,
  filterMemories,
  formatAccessList,
  formatAudienceFaces,
  formatImportanceStars,
  formatRelativeTime,
  memorySummaryLine,
  rowAffordances,
  rowKind,
  truncateContent,
  type MemoryRowKind,
} from "../../src/pages/memory/memory-view-model";
import type { MemoryListItem } from "../../src/lib/memory-api";

function memory(
  overrides: Partial<MemoryListItem> & Pick<MemoryListItem, "id">,
): MemoryListItem {
  return {
    type: "fact",
    content: "test memory",
    importance: 0.6,
    tier: 1,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T12:00:00.000Z",
    namespaceIds: ["ns-a"],
    ...overrides,
  };
}

describe("formatImportanceStars", () => {
  test("maps importance to 1–3 stars", () => {
    expect(formatImportanceStars(0.1)).toBe("⭐");
    expect(formatImportanceStars(0.6)).toBe("⭐⭐");
    expect(formatImportanceStars(0.95)).toBe("⭐⭐⭐");
  });
});

describe("rowKind", () => {
  test("namespace mode with namespace ids → namespace", () => {
    expect(rowKind({ namespaceIds: ["ns-a"] }, "namespace")).toBe("namespace");
  });

  test("scope mode default → scope", () => {
    expect(rowKind({ namespaceIds: [] }, "scope")).toBe("scope");
  });

  test("scope mode seed origin → scope-seed", () => {
    expect(rowKind({ namespaceIds: [], scopeOrigin: "seed" }, "scope")).toBe("scope-seed");
    expect(rowKind({ namespaceIds: [], origin: "seed" }, "scope")).toBe("scope-seed");
  });
});

describe("rowAffordances", () => {
  const cases: Array<{ kind: MemoryRowKind; expected: ReturnType<typeof rowAffordances> }> = [
    {
      kind: "namespace",
      expected: {
        badge: "⌂ ns",
        canEdit: true,
        canArchive: true,
        canDelete: true,
        isReadOnly: false,
      },
    },
    {
      kind: "scope",
      expected: {
        badge: "◇ scope",
        canEdit: true,
        canArchive: true,
        canDelete: true,
        isReadOnly: false,
      },
    },
    {
      kind: "scope-seed",
      expected: {
        badge: "◇ scope",
        canEdit: false,
        canArchive: false,
        canDelete: false,
        isReadOnly: true,
      },
    },
  ];

  for (const { kind, expected } of cases) {
    test(`${kind}`, () => {
      expect(rowAffordances(kind)).toEqual(expected);
    });
  }
});

describe("filterMemories", () => {
  const items = [
    memory({ id: "a", namespaceIds: ["ns-a"], content: "jazz fan" }),
    memory({ id: "b", namespaceIds: ["ns-b"], content: "shellfish allergy" }),
    memory({ id: "c", namespaceIds: [], scopeOrigin: "seed", content: "seed note" }),
  ];

  test("filters by query", () => {
    const out = filterMemories(items, "namespace", {
      query: "jazz",
      kind: "all",
      namespaceId: "all",
    });
    expect(out.map((i) => i.id)).toEqual(["a"]);
  });

  test("filters by namespace id", () => {
    const out = filterMemories(items, "namespace", {
      query: "",
      kind: "all",
      namespaceId: "ns-b",
    });
    expect(out.map((i) => i.id)).toEqual(["b"]);
  });

  test("filters scope kind in namespace mode", () => {
    const out = filterMemories(items, "namespace", {
      query: "",
      kind: "scope",
      namespaceId: "all",
    });
    expect(out.map((i) => i.id)).toEqual(["c"]);
  });
});

describe("memorySummaryLine", () => {
  test("counts namespace vs scope rows", () => {
    const items = [
      memory({ id: "a" }),
      memory({ id: "b", namespaceIds: [] }),
      memory({ id: "c", namespaceIds: [], scopeOrigin: "seed" }),
    ];
    expect(memorySummaryLine(items, "namespace")).toEqual({
      namespaceCount: 1,
      scopeCount: 2,
    });
  });
});

describe("truncateContent", () => {
  test("truncates long content", () => {
    const long = "a".repeat(200);
    expect(truncateContent(long, 20).endsWith("…")).toBe(true);
  });
});

describe("formatRelativeTime", () => {
  test("formats hours ago", () => {
    const iso = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(iso)).toBe("3h ago");
  });
});

describe("M173 access view-model", () => {
  test("canManageAccess mirrors canEdit (controls gate on manage_memories)", () => {
    expect(canManageAccess(true)).toBe(true);
    expect(canManageAccess(false)).toBe(false);
  });

  test("formatAccessList: empty / undefined → 'Only you'", () => {
    expect(formatAccessList(undefined)).toBe("Only you");
    expect(formatAccessList([])).toBe("Only you");
  });

  test("formatAccessList: prefers displayName, falls back to @handle", () => {
    expect(
      formatAccessList([
        { userHandle: "alice", displayName: "Alice" },
        { userHandle: "bob", displayName: "" },
      ]),
    ).toBe("Alice, @bob");
  });
});

describe("D328 audience helpers", () => {
  test("audienceState: <=1 namespace → private, >1 → shared", () => {
    expect(audienceState({ namespaceIds: [] })).toBe("private");
    expect(audienceState({ namespaceIds: ["ns-a"] })).toBe("private");
    expect(audienceState({ namespaceIds: ["ns-a", "ns-b"] })).toBe("shared");
  });

  test("audienceStateFromAccessList: <=1 person → private, >1 → shared", () => {
    expect(audienceStateFromAccessList(undefined)).toBe("private");
    expect(audienceStateFromAccessList([])).toBe("private");
    expect(audienceStateFromAccessList([{ userHandle: "alice", displayName: "Alice" }])).toBe(
      "private",
    );
    expect(
      audienceStateFromAccessList([
        { userHandle: "alice", displayName: "Alice" },
        { userHandle: "bob", displayName: "Bob" },
      ]),
    ).toBe("shared");
  });

  test("audienceBadgeLabel: private/shared glyphs", () => {
    expect(audienceBadgeLabel("private")).toBe("🔒 Private");
    expect(audienceBadgeLabel("shared")).toBe("👥 Shared");
  });

  test("formatAudienceFaces: empty → '', caps at max with +N", () => {
    expect(formatAudienceFaces(undefined)).toBe("");
    expect(formatAudienceFaces([])).toBe("");
    expect(
      formatAudienceFaces([{ userHandle: "you", displayName: "You" }]),
    ).toBe("You");
    expect(
      formatAudienceFaces([
        { userHandle: "you", displayName: "You" },
        { userHandle: "m", displayName: "Casey" },
        { userHandle: "s", displayName: "Sam" },
        { userHandle: "k", displayName: "Kai" },
      ]),
    ).toBe("You · Casey +2");
  });

});
