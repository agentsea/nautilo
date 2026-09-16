import { describe, expect, test } from "bun:test";

import {
  directoryKindsForViewer,
  filterDirectoryEntriesForViewer,
  mergeDirectoryEntries,
  type DirectoryEntry,
} from "./directory";

const entries: DirectoryEntry[] = [
  {
    kind: "user",
    id: "user-a",
    handle: "amy",
    displayName: "Amy",
    lastContactAt: null,
    actionable: true,
    actionReason: "available",
  },
  {
    kind: "agent",
    id: "agent-z",
    handle: "zeta",
    displayName: "Zeta",
    lastContactAt: "2026-08-13T10:00:00.000Z",
    actionable: false,
    actionReason: "invoke_agents_required",
  },
];

describe("new-conversation directory projection", () => {
  test("keeps basic Genie identity visible without granting invocation authority", () => {
    expect(directoryKindsForViewer(false)).toEqual(["user", "agent"]);
    expect(directoryKindsForViewer(true)).toEqual(["user", "agent"]);
    expect(filterDirectoryEntriesForViewer(entries, false)).toEqual(entries);
    expect(filterDirectoryEntriesForViewer(entries, true)).toEqual(entries);
  });

  test("merges independent pages, dedupes, and keeps recent contacts first", () => {
    const merged = mergeDirectoryEntries(entries, [
      { ...entries[0], displayName: "Amy Updated" },
      {
        kind: "user",
        id: "user-b",
        handle: "bea",
        displayName: "Bea",
        lastContactAt: "2026-08-12T10:00:00.000Z",
        actionable: true,
        actionReason: "available",
      },
    ]);

    expect(merged.map((entry) => `${entry.kind}:${entry.id}`)).toEqual([
      "agent:agent-z",
      "user:user-b",
      "user:user-a",
    ]);
    expect(merged[2]?.displayName).toBe("Amy Updated");
  });

});
