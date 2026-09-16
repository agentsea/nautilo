import { describe, test, expect, beforeEach } from "bun:test";
import {
  hasRevertDispatcher,
  requestRevert,
  requestUndoTurn,
  setRevertDispatcher,
} from "../../src/adapters/tool-invoke-ref";

describe("tool-invoke-ref (revert dispatcher)", () => {
  beforeEach(() => {
    setRevertDispatcher(null);
  });

  test("hasRevertDispatcher is false before registration", () => {
    expect(hasRevertDispatcher()).toBe(false);
  });

  test("hasRevertDispatcher flips to true after registration", () => {
    setRevertDispatcher(() => {});
    expect(hasRevertDispatcher()).toBe(true);
  });

  test("hasRevertDispatcher flips back to false when cleared", () => {
    setRevertDispatcher(() => {});
    setRevertDispatcher(null);
    expect(hasRevertDispatcher()).toBe(false);
  });

  test("requestRevert no-ops when dispatcher is not registered", () => {
    requestRevert({ path: "/tmp/x.md", command: "write" });
  });

  test("requestRevert forwards the built message to the dispatcher", () => {
    const sent: string[] = [];
    setRevertDispatcher((text) => {
      sent.push(text);
    });
    requestRevert({
      path: "/tmp/a.md",
      zone: "current",
      command: "insert",
    });
    requestRevert({
      path: "/tmp/b.md",
      revisionId: "rev-9",
      command: "delete",
    });
    expect(sent).toEqual([
      "Revert the insert I just applied to /tmp/a.md (zone: current).",
      "Revert the delete I just applied to /tmp/b.md (revision: rev-9).",
    ]);
  });

  test("re-registering replaces the dispatcher", () => {
    const sent: string[] = [];
    setRevertDispatcher((text) => {
      sent.push(`first:${text}`);
    });
    requestRevert({ path: "/one.md" });
    setRevertDispatcher((text) => {
      sent.push(`second:${text}`);
    });
    requestRevert({ path: "/two.md" });
    expect(sent).toEqual([
      "first:Revert the edit I just applied to /one.md.",
      "second:Revert the edit I just applied to /two.md.",
    ]);
  });

  test("requestUndoTurn invokes only the trusted turn id without inferring a path or zone", () => {
    const sent: string[] = [];
    setRevertDispatcher((text) => {
      sent.push(text);
    });
    requestUndoTurn({ turnId: "turn-448" });
    expect(sent).toEqual(["Use file with {\"command\":\"undo_turn\",\"targetTurnId\":\"turn-448\"}."]);
  });

  test("requestUndoTurn rejects an empty turn id", () => {
    const sent: string[] = [];
    setRevertDispatcher((text) => {
      sent.push(text);
    });
    requestUndoTurn({ turnId: "  " });
    expect(sent).toEqual([]);
  });
});
