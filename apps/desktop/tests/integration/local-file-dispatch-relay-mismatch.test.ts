import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createWorkspaceGuard, type RelayDispatchRequest } from "@nautilo/relay";
import { createJournalStorage } from "../../electron/local-file-history/storage.ts";

let mockedHistoryRoot = "";
let handleLocalFileDispatch:
  typeof import("../../electron/local-file-dispatch/index.ts").handleLocalFileDispatch;

mock.module("electron", () => ({
  app: { getPath: () => os.tmpdir(), isPackaged: false },
}));

mock.module("../../electron/paths", () => ({
  localFileHistoryDirPath: () => mockedHistoryRoot,
}));

beforeAll(async () => {
  mockedHistoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lfd-relay-mismatch-"));
  ({ handleLocalFileDispatch } = await import("../../electron/local-file-dispatch/index.ts"));
});

afterAll(async () => {
  await fs.rm(mockedHistoryRoot, { recursive: true, force: true });
});

function request(operation: Record<string, unknown>, root: string): RelayDispatchRequest {
  return {
    correlationId: "relay-mismatch-test",
    toolName: "local-file",
    executionClass: "local-file",
    impact: "read-only",
    approvalObtained: false,
    allowedRoots: [root],
    args: { operation, allowedRoots: [root] },
  };
}

function routing(root: string) {
  return {
    ownerId: "00000000-0000-4000-8000-000000000001",
    agentId: "00000000-0000-4000-8000-000000000002",
    turnId: "turn-relay-mismatch",
    currentFolder: root,
    workspaceRoot: "",
    mutationRequestId: "local-dispatch-relay-mismatch",
  };
}

test("folder listing bypasses stale history while history remains fail-closed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lfd-relay-mismatch-files-"));
  try {
    await fs.writeFile(path.join(root, "visible.txt"), "visible\n");
    await createJournalStorage(mockedHistoryRoot).writeManifest({
      v: 1,
      relayId: "previous-relay",
      entries: [],
    });
    const guard = createWorkspaceGuard({ allowedRoots: [root] });
    const list = await handleLocalFileDispatch(
      request({
        kind: "file",
        command: "list",
        zone: "current",
        args: { path: ".", _routing: routing(root) },
      }, root),
      { relayId: "replacement-relay", guard, journalRootDir: mockedHistoryRoot },
    );
    expect(list.status).toBe("ok");
    expect(JSON.stringify(list.result)).toContain("visible.txt");

    let historyError: unknown;
    try {
      await handleLocalFileDispatch(
        request({
          kind: "history",
          command: "list_revisions",
          args: { _routing: routing(root) },
        }, root),
        { relayId: "replacement-relay", guard, journalRootDir: mockedHistoryRoot },
      );
    } catch (error) {
      historyError = error;
    }
    expect(historyError).toBeInstanceOf(Error);
    expect(String(historyError)).toContain("relay mismatch");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
