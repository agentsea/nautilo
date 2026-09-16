import { describe, expect, test } from "bun:test";
import type { CommandApprovalRow } from "@nautilo/api-client";
import {
  classifyToolFamily,
  getApprovalHeadline,
  getApprovalSubline,
  hasMappedToolDisplay,
} from "../../src/components/approvals/tool-display";

function row(
  overrides: Partial<CommandApprovalRow> & Pick<CommandApprovalRow, "id">,
): CommandApprovalRow {
  return {
    scope: "server",
    roomId: null,
    roomLabel: null,
    toolPattern: "run_shell",
    label: "run_shell ls <directory:/proj>",
    approvalKind: "tool",
    capabilitySlug: null,
    active: true,
    createdAt: "2026-06-01T12:00:00.000Z",
    ...overrides,
  };
}

describe("tool display helpers", () => {
  test("maps known tool patterns to friendly headlines and stripped sublines", () => {
    expect(getApprovalHeadline(row({ id: "shell" }))).toBe("Run shell command");
    expect(getApprovalSubline(row({ id: "shell" }))).toBe("ls <directory:/proj>");

    expect(
      getApprovalHeadline(row({ id: "file", toolPattern: "file.read", label: "file.read on /tmp/*" })),
    ).toBe("File access");
    expect(
      getApprovalSubline(row({ id: "file", toolPattern: "file.read", label: "file.read on /tmp/*" })),
    ).toBe("on /tmp/*");

    expect(
      getApprovalHeadline(row({ id: "web", toolPattern: "web_fetch", label: "web_fetch https://x" })),
    ).toBe("Fetch URL");
    expect(
      getApprovalSubline(row({ id: "web", toolPattern: "web_fetch", label: "web_fetch https://x" })),
    ).toBe("https://x");

    expect(
      getApprovalHeadline(
        row({
          id: "cap",
          toolPattern: "_capability",
          approvalKind: "capability",
          capabilitySlug: "control_desktop",
          label: "capability: control_desktop",
        }),
      ),
    ).toBe("Capability");
    expect(
      getApprovalSubline(
        row({
          id: "cap",
          toolPattern: "_capability",
          approvalKind: "capability",
          capabilitySlug: "control_desktop",
          label: "capability: control_desktop",
        }),
      ),
    ).toBe("control_desktop");
  });

  test("falls back to raw toolPattern headline and full label subline when unmapped", () => {
    const unmapped = row({
      id: "custom",
      toolPattern: "synthetic_tool",
      label: "synthetic_tool do something custom",
    });

    expect(hasMappedToolDisplay(unmapped)).toBe(false);
    expect(getApprovalHeadline(unmapped)).toBe("synthetic_tool");
    expect(getApprovalSubline(unmapped)).toBe("synthetic_tool do something custom");
  });

  test("classifies tool families for chip filters", () => {
    expect(classifyToolFamily(row({ id: "shell" }))).toBe("shell");
    expect(
      classifyToolFamily(row({ id: "file", toolPattern: "file.write", label: "file.write x" })),
    ).toBe("files");
    expect(
      classifyToolFamily(row({ id: "web", toolPattern: "web_fetch", label: "web_fetch x" })),
    ).toBe("network");
    expect(
      classifyToolFamily(
        row({
          id: "cap",
          toolPattern: "_capability",
          approvalKind: "capability",
          label: "capability: x",
        }),
      ),
    ).toBe("capabilities");
    expect(
      classifyToolFamily(row({ id: "other", toolPattern: "custom_thing", label: "custom_thing x" })),
    ).toBe("other");
  });
});
