import { describe, expect, test } from "bun:test";
import {
  LOCAL_HISTORY_INPUT_REQUIRED,
  parseLocalRevisionRef,
  resolveLocalHistoryRouting,
  shouldRouteHistoryViaLocalRelay,
} from "../../src/tools/file/local-history-routing";
import { RELAY_OWNERSHIP_MISMATCH } from "../../src/tools/file/local-file-routing";
import { dispatchFileCommand } from "../../src/tools/file/dispatch";

const LOCAL_REF = "local:relay-a:550e8400-e29b-41d4-a716-446655440000";
const SERVER_UUID = "660e8400-e29b-41d4-a716-446655440001";

describe("parseLocalRevisionRef (M206)", () => {
  test("parses local:<relayId>:<uuid>", () => {
    const parsed = parseLocalRevisionRef(LOCAL_REF);
    expect(parsed).toEqual({
      relayId: "relay-a",
      revisionId: "550e8400-e29b-41d4-a716-446655440000",
    });
  });

  test("rejects bare UUID and malformed refs", () => {
    expect(parseLocalRevisionRef(SERVER_UUID)).toBeNull();
    expect(parseLocalRevisionRef("local:relay-only")).toBeNull();
    expect(parseLocalRevisionRef("local:relay:not-a-uuid")).toBeNull();
  });
});

describe("resolveLocalHistoryRouting (M206)", () => {
  test("direct dispatch cannot route explicit local undo_turn to Workspace", async () => {
    const output = await dispatchFileCommand(
      {
        command: "undo_turn",
        targetTurnId: "turn-9",
        zone: "current",
      },
      {
        ownerId: "owner-1",
        zoneCtx: {
          workspaceRoot: "/srv/workspace",
          currentFolder: "/Users/alice/project",
        },
      },
    );
    if (typeof output !== "string") throw new Error("expected string output");
    expect(JSON.parse(output)).toMatchObject({
      error: "local_relay_required",
      code: "local_relay_required",
    });

    const ambiguous = await dispatchFileCommand(
      {
        command: "undo_turn",
        targetTurnId: "turn-9",
      },
      {
        ownerId: "owner-1",
        zoneCtx: {
          workspaceRoot: "/srv/workspace",
          currentFolder: "/Users/alice/project",
        },
      },
    );
    if (typeof ambiguous !== "string") {
      throw new Error("expected string output");
    }
    expect(JSON.parse(ambiguous)).toMatchObject({
      error: "local_history_input_required",
      code: "local_history_input_required",
    });
  });

  test("undo_turn with local zone routes local", () => {
    const d = resolveLocalHistoryRouting({
      command: "undo_turn",
      targetTurnId: "turn-9",
      zone: "current",
    });
    expect(d.kind).toBe("local");
  });

  test("undo_turn without zone stays server when no current folder is open", () => {
    const d = resolveLocalHistoryRouting({
      command: "undo_turn",
      targetTurnId: "turn-9",
    });
    expect(d.kind).toBe("server");
    expect(
      shouldRouteHistoryViaLocalRelay({ command: "undo_turn", targetTurnId: "turn-9" }),
    ).toBe(false);
  });

  test("undo_turn without zone fails closed when current folder is open", () => {
    const d = resolveLocalHistoryRouting(
      { command: "undo_turn", targetTurnId: "turn-9" },
      { currentFolder: "/Users/alice/project" },
    );
    expect(d.kind).toBe("error");
    if (d.kind === "error") {
      expect(d.code).toBe(LOCAL_HISTORY_INPUT_REQUIRED);
    }
  });

  test("undo_turn with zone workspace stays server", () => {
    const d = resolveLocalHistoryRouting({
      command: "undo_turn",
      targetTurnId: "turn-9",
      zone: "workspace",
    });
    expect(d.kind).toBe("server");
  });

  test("list_revisions with local zone routes local", () => {
    const d = resolveLocalHistoryRouting({
      command: "list_revisions",
      zone: "current",
    });
    expect(d.kind).toBe("local");
  });

  test("list_revisions with Workspace logical path stays server-side", () => {
    expect(resolveLocalHistoryRouting({
      command: "list_revisions",
      zone: "workspace",
      path: "notes/history.md",
    })).toEqual({ kind: "server" });
  });

  test("list_revisions with absolute path infers absolute zone", () => {
    const d = resolveLocalHistoryRouting({
      command: "list_revisions",
      path: "/Users/alice/notes.txt",
    });
    expect(d.kind).toBe("local");
    if (d.kind === "local") {
      expect(d.args["zone"]).toBe("absolute");
    }
  });

  test("list_revisions with relative path without zone fails closed", () => {
    const d = resolveLocalHistoryRouting({
      command: "list_revisions",
      path: "notes.txt",
    });
    expect(d.kind).toBe("error");
    if (d.kind === "error") {
      expect(d.code).toBe(LOCAL_HISTORY_INPUT_REQUIRED);
    }
  });

  test("list_revisions without zone or path stays server", () => {
    expect(resolveLocalHistoryRouting({ command: "list_revisions" }).kind).toBe("server");
  });

  test("pin_revision with local ref routes local with relay hint", () => {
    const d = resolveLocalHistoryRouting({
      command: "pin_revision",
      revisionId: LOCAL_REF,
    });
    expect(d.kind).toBe("local");
    if (d.kind === "local") {
      expect(d.relayIdHint).toBe("relay-a");
    }
  });

  test("pin_revision with bare UUID stays server", () => {
    expect(
      resolveLocalHistoryRouting({ command: "pin_revision", revisionId: SERVER_UUID }).kind,
    ).toBe("server");
  });

  test("undo with local ref but workspace zone fails closed", () => {
    const d = resolveLocalHistoryRouting({
      command: "undo",
      zone: "workspace",
      path: "artifact.md",
      revisionId: LOCAL_REF,
    });
    expect(d.kind).toBe("error");
    if (d.kind === "error") {
      expect(d.code).toBe(LOCAL_HISTORY_INPUT_REQUIRED);
    }
  });

  test("non-history commands stay server", () => {
    expect(resolveLocalHistoryRouting({ command: "read", zone: "workspace", path: "x" }).kind).toBe(
      "server",
    );
  });
});

describe("relay ownership mismatch export", () => {
  test("RELAY_OWNERSHIP_MISMATCH is stable", () => {
    expect(RELAY_OWNERSHIP_MISMATCH).toBe("relay_ownership_mismatch");
  });
});
