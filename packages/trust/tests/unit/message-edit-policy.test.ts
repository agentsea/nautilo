import { describe, expect, test } from "bun:test";
import { decideHumanMessageEdit } from "../../src/message-edit";

const CALLER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ID = "00000000-0000-4000-8000-000000000002";

function editInput(
  overrides: Partial<Parameters<typeof decideHumanMessageEdit>[0]> = {},
): Parameters<typeof decideHumanMessageEdit>[0] {
  return {
    callerIsMember: true,
    roomArchived: false,
    messageExists: true,
    messageRole: "user",
    sessionOwnerId: CALLER_ID,
    callerUserId: CALLER_ID,
    currentContent: "hello",
    originatedBy: null,
    ...overrides,
  };
}

describe("decideHumanMessageEdit (M230)", () => {
  test("allows the owning Human to edit an eligible user row", () => {
    expect(decideHumanMessageEdit(editInput())).toBe("allowed");
  });

  test("hides missing messages and membership failures", () => {
    expect(decideHumanMessageEdit(editInput({ messageExists: false }))).toBe("not_found");
    expect(decideHumanMessageEdit(editInput({ callerIsMember: false }))).toBe("not_found");
  });

  test("forbids editing another Human's message", () => {
    expect(decideHumanMessageEdit(editInput({ sessionOwnerId: OTHER_ID }))).toBe("forbidden");
  });

  test("rejects archived rooms and ineligible transcript rows", () => {
    expect(decideHumanMessageEdit(editInput({ roomArchived: true }))).toBe("room_archived");
    expect(decideHumanMessageEdit(editInput({ messageRole: "assistant" }))).toBe("ineligible");
    expect(decideHumanMessageEdit(editInput({ originatedBy: "task" }))).toBe("ineligible");
    expect(decideHumanMessageEdit(editInput({ originatedBy: "connected_web_operation" }))).toBe("ineligible");
    expect(decideHumanMessageEdit(editInput({ currentContent: "  " }))).toBe("ineligible");
    expect(decideHumanMessageEdit(editInput({ currentContent: null }))).toBe("ineligible");
  });
});
