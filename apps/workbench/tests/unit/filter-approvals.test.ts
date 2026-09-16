import { describe, expect, test } from "bun:test";
import type { CommandApprovalRow } from "@nautilo/api-client";
import {
  extractRoomFilterOptions,
  filterApprovals,
  roomFilterLabel,
} from "../../src/components/approvals/filter-approvals";

function row(
  overrides: Partial<CommandApprovalRow> & Pick<CommandApprovalRow, "id" | "scope">,
): CommandApprovalRow {
  return {
    roomId: overrides.scope === "room" ? "room-1" : null,
    roomLabel: overrides.scope === "room" ? "Ops room" : null,
    toolPattern: "file.read",
    label: overrides.label ?? `${overrides.scope} label ${overrides.id}`,
    approvalKind: "tool",
    capabilitySlug: null,
    active: true,
    createdAt: "2026-06-01T12:00:00.000Z",
    ...overrides,
  };
}

const rows: CommandApprovalRow[] = [
  row({ id: "srv-1", scope: "server", toolPattern: "run_shell", label: "run_shell git status" }),
  row({
    id: "cap-1",
    scope: "server",
    toolPattern: "_capability",
    approvalKind: "capability",
    capabilitySlug: "control_desktop",
    label: "capability: control_desktop",
  }),
  row({
    id: "room-a",
    scope: "room",
    roomId: "room-a",
    roomLabel: "#infra-ops",
    toolPattern: "file.read",
    label: "file.read /tmp/a",
  }),
  row({
    id: "room-b",
    scope: "room",
    roomId: "room-b",
    roomLabel: "#general",
    toolPattern: "web_fetch",
    label: "web_fetch https://example.com",
  }),
];

describe("filterApprovals", () => {
  test("extracts unique room filter options in first-seen order", () => {
    expect(extractRoomFilterOptions(rows)).toEqual([
      { roomId: "room-a", roomLabel: "#infra-ops" },
      { roomId: "room-b", roomLabel: "#general" },
    ]);
    expect(roomFilterLabel({ roomId: "x", roomLabel: null })).toBe("Room: (unknown)");
  });

  test("filters by server scope", () => {
    const filtered = filterApprovals(rows, {
      scope: "server",
      search: "",
      family: "all",
    });
    expect(filtered.map((r) => r.id)).toEqual(["srv-1", "cap-1"]);
  });

  test("filters by room id", () => {
    const filtered = filterApprovals(rows, {
      scope: { roomId: "room-b" },
      search: "",
      family: "all",
    });
    expect(filtered.map((r) => r.id)).toEqual(["room-b"]);
  });

  test("search matches label and toolPattern case-insensitively", () => {
    const filtered = filterApprovals(rows, {
      scope: "all",
      search: "WEB_FETCH",
      family: "all",
    });
    expect(filtered.map((r) => r.id)).toEqual(["room-b"]);
  });

  test("family chip filter composes with scope and search", () => {
    const filtered = filterApprovals(rows, {
      scope: "server",
      search: "",
      family: "shell",
    });
    expect(filtered.map((r) => r.id)).toEqual(["srv-1"]);

    const none = filterApprovals(rows, {
      scope: "all",
      search: "git",
      family: "files",
    });
    expect(none).toEqual([]);
  });
});
