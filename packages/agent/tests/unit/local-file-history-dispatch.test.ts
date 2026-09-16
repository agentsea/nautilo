import { afterEach, describe, expect, test } from "bun:test";
import { setRelayRegistry } from "../../src/nodes/tools";
import type { ToolRelayRegistry } from "../../src/nodes/tools";
import {
  LOCAL_FILE_EXECUTION_UNSUPPORTED,
  RELAY_PROTOCOL_VERSION,
  type RelayLocalFileRequest,
} from "@nautilo/relay";
import { executeLocalFileCommand } from "../../src/tools/file/local-file-dispatch";
import { RELAY_OWNERSHIP_MISMATCH } from "../../src/tools/file/local-file-routing";
import { LOCAL_HISTORY_INPUT_REQUIRED } from "../../src/tools/file/local-history-routing";
import { setLiveReviewWriteGuard } from "../../src/tools/file/live-review-write-guard";

const ownerId = "user-1";
const agentId = "agent-1";
const relayDesktop = "relay-desktop";
const relayOther = "relay-other";
const localRef = `local:${relayDesktop}:550e8400-e29b-41d4-a716-446655440000`;
const crossRelayRef = `local:${relayOther}:550e8400-e29b-41d4-a716-446655440000`;

const zoneCtx = {
  workspaceRoot: "/srv/ws",
  currentFolder: "/Users/alice/project",
};

const dispatchCtx = {
  ownerId,
  agentId,
  turnId: "turn-1",
  zoneCtx,
  approvalObtained: true,
};

afterEach(() => {
  setRelayRegistry(null);
  setLiveReviewWriteGuard(null);
});

function outputRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new Error("expected string tool output");
  return JSON.parse(value) as Record<string, unknown>;
}

function makeRegistry(
  localFileDispatch: NonNullable<ToolRelayRegistry["localFileDispatch"]>,
  relayIds: string[] = [relayDesktop],
): ToolRelayRegistry {
  return {
    findByCapabilityForUser(_cap, userId) {
      expect(userId).toBe(ownerId);
      return relayIds;
    },
    getCapabilities(_relayId) {
      return {
        profile: "desktop-agent",
        canReadWorkspace: true,
        canWriteWorkspace: true,
        localFileExecution: true,
        allowedRoots: ["/Users/alice/project"],
      };
    },
    getProtocolVersion() {
      return RELAY_PROTOCOL_VERSION;
    },
    async dispatch() {
      throw new Error("fs dispatch must not be used for local history");
    },
    localFileDispatch,
  };
}

describe("executeLocalFileCommand — local history routing (M206)", () => {
  test("undo_turn with zone dispatches history op without Postgres", async () => {
    const calls: RelayLocalFileRequest[] = [];
    setRelayRegistry(
      makeRegistry(async (_id, req) => {
        calls.push(req);
        if (
          req.operation.kind === "history" &&
          req.operation.command === "list_revisions"
        ) {
          return {
            ok: true,
            result: JSON.stringify({
              revisions: [{
                revisionId: localRef,
                turnId: "turn-9",
                canonicalPath: "/Users/alice/project/a.txt",
              }],
              truncated: false,
            }),
          };
        }
        return {
          ok: true,
          result: JSON.stringify({ turnId: "turn-9", appliedCount: 1, patches: [], summary: "ok" }),
        };
      }),
    );

    const out = await executeLocalFileCommand(
      { command: "undo_turn", targetTurnId: "turn-9", zone: "current" },
      dispatchCtx,
    );
    expect(typeof out).toBe("string");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.operation).toMatchObject({
      kind: "history",
      command: "list_revisions",
      args: { revisionTurnId: "turn-9", zone: "current" },
    });
    expect(calls[1]?.operation.kind).toBe("history");
    if (calls[1]?.operation.kind === "history") {
      expect(calls[1].operation.command).toBe("undo_turn");
      expect(calls[1].operation.args["targetTurnId"]).toBe("turn-9");
      expect(calls[1].operation.args["zone"]).toBe("current");
    }
  });

  test.each(["undo", "redo"] as const)(
    "%s blocks an exact open canonical revision target before restore",
    async (command) => {
      const calls: RelayLocalFileRequest[] = [];
      setRelayRegistry(
        makeRegistry(async (_id, req) => {
          calls.push(req);
          if (
            req.operation.kind === "history" &&
            req.operation.command === "list_revisions"
          ) {
            return {
              ok: true,
              result: JSON.stringify({
                revisions: [{
                  revisionId: localRef,
                  turnId: "turn-1",
                  canonicalPath: "/Users/alice/project/open.doc.html",
                }],
                truncated: false,
              }),
            };
          }
          return { ok: true, result: JSON.stringify({ applied: true }) };
        }),
      );
      setLiveReviewWriteGuard(async (target) =>
        target.surface === "currentFolder" &&
        target.relayId === relayDesktop &&
        target.canonicalTargetIdentities?.includes(
          "/Users/alice/project/open.doc.html",
        ) === true,
      );

      const out = await executeLocalFileCommand(
        { command, zone: "current", path: "open.doc.html" },
        dispatchCtx,
      );

      expect(outputRecord(out)["code"]).toBe("use_edit_open_writer");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.operation).toMatchObject({
        kind: "history",
        command: "list_revisions",
      });
    },
  );

  test("undo_turn blocks when any canonical revision target is open", async () => {
    const calls: RelayLocalFileRequest[] = [];
    setRelayRegistry(
      makeRegistry(async (_id, req) => {
        calls.push(req);
        if (
          req.operation.kind === "history" &&
          req.operation.command === "list_revisions"
        ) {
          return {
            ok: true,
            result: JSON.stringify({
              revisions: [
                {
                  revisionId: localRef,
                  turnId: "turn-9",
                  canonicalPath: "/Users/alice/project/other.txt",
                },
                {
                  revisionId: localRef,
                  turnId: "turn-9",
                  canonicalPath: "/Users/alice/project/open.doc.html",
                },
              ],
              truncated: false,
            }),
          };
        }
        return { ok: true, result: JSON.stringify({ appliedCount: 2 }) };
      }),
    );
    setLiveReviewWriteGuard(async (target) =>
      target.surface === "currentFolder" &&
      target.canonicalTargetIdentities?.includes(
        "/Users/alice/project/open.doc.html",
      ) === true,
    );

    const out = await executeLocalFileCommand(
      { command: "undo_turn", targetTurnId: "turn-9", zone: "current" },
      dispatchCtx,
    );

    expect(outputRecord(out)["code"]).toBe("use_edit_open_writer");
    expect(calls).toHaveLength(1);
  });

  test("history restore fails safely when canonical identities are incomplete", async () => {
    let mutationDispatched = false;
    setRelayRegistry(
      makeRegistry(async (_id, req) => {
        if (
          req.operation.kind === "history" &&
          req.operation.command === "list_revisions"
        ) {
          return {
            ok: true,
            result: JSON.stringify({
              revisions: [{ revisionId: localRef, turnId: "turn-9" }],
              truncated: false,
            }),
          };
        }
        mutationDispatched = true;
        return { ok: true };
      }),
    );

    const out = await executeLocalFileCommand(
      { command: "undo_turn", targetTurnId: "turn-9", zone: "current" },
      dispatchCtx,
    );

    expect(outputRecord(out)["code"]).toBe("local_history_identity_unavailable");
    expect(mutationDispatched).toBe(false);
  });

  test("list_revisions with zone dispatches journal-only history op", async () => {
    const calls: RelayLocalFileRequest[] = [];
    setRelayRegistry(
      makeRegistry(async (_id, req) => {
        calls.push(req);
        return { ok: true, result: JSON.stringify({ revisions: [], truncated: false }) };
      }),
    );

    await executeLocalFileCommand({ command: "list_revisions", zone: "current" }, dispatchCtx);
    expect(calls[0]?.operation.kind).toBe("history");
    if (calls[0]?.operation.kind === "history") {
      expect(calls[0].operation.command).toBe("list_revisions");
    }
  });

  test("list_revisions infers absolute zone for absolute path filter", async () => {
    const calls: RelayLocalFileRequest[] = [];
    setRelayRegistry(
      makeRegistry(async (_id, req) => {
        calls.push(req);
        return { ok: true, result: JSON.stringify({ revisions: [], truncated: false }) };
      }),
    );

    await executeLocalFileCommand(
      { command: "list_revisions", path: "/Users/alice/project/a.txt" },
      dispatchCtx,
    );
    if (calls[0]?.operation.kind === "history") {
      expect(calls[0].operation.args["zone"]).toBe("absolute");
    }
  });

  test("pin_revision with local ref dispatches with approval", async () => {
    let approvalPassed = false;
    setRelayRegistry(
      makeRegistry(async (_id, _req, opts) => {
        approvalPassed = opts.approvalObtained;
        return { ok: true, result: JSON.stringify({ ok: true, revisionId: localRef, pinned: true }) };
      }),
    );

    await executeLocalFileCommand({ command: "pin_revision", revisionId: localRef }, dispatchCtx);
    expect(approvalPassed).toBe(true);
  });

  test("rejects cross-relay local revision ref before dispatch", async () => {
    let dispatched = false;
    setRelayRegistry(
      makeRegistry(async () => {
        dispatched = true;
        return { ok: true };
      }),
    );

    const out = await executeLocalFileCommand(
      { command: "pin_revision", revisionId: crossRelayRef },
      dispatchCtx,
    );
    expect(dispatched).toBe(false);
    expect(out).toContain(RELAY_OWNERSHIP_MISMATCH);
  });

  test("relative list_revisions path without zone returns input-required JSON", async () => {
    let dispatched = false;
    setRelayRegistry(
      makeRegistry(async () => {
        dispatched = true;
        return { ok: true };
      }),
    );

    const out = await executeLocalFileCommand(
      { command: "list_revisions", path: "notes.txt" },
      dispatchCtx,
    );
    expect(dispatched).toBe(false);
    const parsed = JSON.parse(out as string) as { error: string };
    expect(parsed.error).toBe(LOCAL_HISTORY_INPUT_REQUIRED);
  });

  test("offline relay returns LOCAL_FILE_EXECUTION_UNSUPPORTED", async () => {
    setRelayRegistry({
      findByCapabilityForUser() {
        return [];
      },
      getCapabilities() {
        return {
          profile: "desktop-agent",
          canReadWorkspace: true,
          canWriteWorkspace: true,
          localFileExecution: true,
        };
      },
      getProtocolVersion() {
        return RELAY_PROTOCOL_VERSION;
      },
      async dispatch() {
        throw new Error("unexpected");
      },
      async localFileDispatch() {
        return { ok: true };
      },
    });

    const out = await executeLocalFileCommand(
      { command: "undo_turn", targetTurnId: "turn-9", zone: "absolute" },
      dispatchCtx,
    );
    expect(out).toContain(LOCAL_FILE_EXECUTION_UNSUPPORTED);
  });

  test("unpin_revision with local ref targets owning relay", async () => {
    const calls: string[] = [];
    setRelayRegistry(
      makeRegistry(async (relayId, req) => {
        calls.push(relayId);
        if (req.operation.kind === "history") {
          expect(req.operation.command).toBe("unpin_revision");
        }
        return {
          ok: true,
          result: JSON.stringify({ ok: true, revisionId: localRef, pinned: false }),
        };
      }),
    );

    await executeLocalFileCommand({ command: "unpin_revision", revisionId: localRef }, dispatchCtx);
    expect(calls).toEqual([relayDesktop]);
  });
});
