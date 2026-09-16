import { describe, expect, test } from "bun:test";
import type { WorkspaceArtifactEvent } from "@nautilo/api-client/browser";
import type { FsMkdirResult, FsRenameResult, FsTrashResult } from "../../src/lib/desktop";
import {
  buildMoveDestinationPath,
  collectSiblingNamesAt,
  executeFileTreeMkdir,
  executeFileTreeMove,
  executeFileTreeTrash,
  formatFsMkdirError,
  formatFsMoveError,
  formatFsTrashError,
  isCyclicFolderMove,
  localCommittedMutationRefreshPath,
  parentDirectoryPath,
  resolveCreateFolderParent,
} from "../../src/components/browser-column/file-tree-view";

function localCreateEvent(canonicalPath: string): WorkspaceArtifactEvent {
  return {
    type: "document.mutation.committed",
    operationId: "operation-create",
    revisionGroupId: "group-create",
    sequence: 0,
    outcome: "applied",
    actor: { kind: "agent", agentId: "agent-1" },
    mutation: "create",
    path: {
      kind: "create",
      after: { kind: "local_file", relayId: "relay-1", canonicalPath },
    },
    after: {
      identity: { kind: "local_file", relayId: "relay-1", canonicalPath },
      backendVersion: { kind: "local_revision", revisionId: "revision-1" },
      sha256: "a".repeat(64),
    },
  } as WorkspaceArtifactEvent;
}

describe("buildMoveDestinationPath", () => {
  test("joins target dir with source basename", () => {
    expect(buildMoveDestinationPath("/root/a.txt", "/root/sub")).toBe("/root/sub/a.txt");
    expect(buildMoveDestinationPath("C:\\root\\dir", "C:\\root")).toBe("C:\\root\\dir");
  });
});

describe("parentDirectoryPath", () => {
  test("returns parent for nested file paths", () => {
    expect(parentDirectoryPath("/root/sub/file.txt", "/root")).toBe("/root/sub");
    expect(parentDirectoryPath("/root/file.txt", "/root")).toBe("/root");
  });
});

describe("localCommittedMutationRefreshPath", () => {
  test("targets the containing directory for a committed local create", () => {
    expect(
      localCommittedMutationRefreshPath(
        localCreateEvent("/root/sub/new-writer.html"),
        "/root",
      ),
    ).toBe("/root/sub");
  });

  test("ignores committed local paths outside the mounted Files root", () => {
    expect(
      localCommittedMutationRefreshPath(
        localCreateEvent("/other/new-writer.html"),
        "/root",
      ),
    ).toBeNull();
  });
});

describe("isCyclicFolderMove", () => {
  test("blocks self and descendant targets", () => {
    expect(isCyclicFolderMove("/root/a", "/root/a")).toBe(true);
    expect(isCyclicFolderMove("/root/a", "/root/a/b")).toBe(true);
    expect(isCyclicFolderMove("/root/a", "/root/b")).toBe(false);
  });
});

describe("resolveCreateFolderParent", () => {
  const entries = new Map([
    ["/root", { path: "/root", type: "directory" as const }],
    ["/root/sub", { path: "/root/sub", type: "directory" as const }],
    ["/root/sub/file.txt", { path: "/root/sub/file.txt", type: "file" as const }],
  ]);

  test("uses focused directory row", () => {
    expect(
      resolveCreateFolderParent({
        focusedRow: { entry: { path: "/root/sub", type: "directory" } },
        rootPath: "/root",
        selectedPaths: new Set(),
        entries,
      }),
    ).toBe("/root/sub");
  });

  test("uses parent of focused file row", () => {
    expect(
      resolveCreateFolderParent({
        focusedRow: { entry: { path: "/root/sub/file.txt", type: "file" } },
        rootPath: "/root",
        selectedPaths: new Set(),
        entries,
      }),
    ).toBe("/root/sub");
  });

  test("falls back to root path", () => {
    expect(
      resolveCreateFolderParent({
        focusedRow: undefined,
        rootPath: "/root",
        selectedPaths: new Set(),
        entries,
      }),
    ).toBe("/root");
  });
});

describe("collectSiblingNamesAt", () => {
  test("lists names under root and nested parent", () => {
    const entries = new Map([
      ["/root/a.txt", { name: "a.txt", childrenPaths: null }],
      ["/root/sub", { name: "sub", childrenPaths: ["/root/sub/nested.txt"] }],
      ["/root/sub/nested.txt", { name: "nested.txt", childrenPaths: null }],
    ]);
    expect(collectSiblingNamesAt(entries, "/root", "/root", ["/root/a.txt", "/root/sub"])).toEqual([
      "a.txt",
      "sub",
    ]);
    expect(collectSiblingNamesAt(entries, "/root/sub", "/root", ["/root/a.txt", "/root/sub"])).toEqual([
      "nested.txt",
    ]);
  });
});

describe("formatFsMoveError", () => {
  test("maps exists to Name in use", () => {
    expect(formatFsMoveError("exists").title).toBe("Name in use");
  });
});

describe("formatFsMkdirError", () => {
  test("maps exists to Name in use", () => {
    expect(formatFsMkdirError("exists").title).toBe("Name in use");
  });
});

describe("executeFileTreeMove", () => {
  test("short-circuits noop when destination equals source", async () => {
    let called = false;
    const result = await executeFileTreeMove({
      rename: async () => {
        called = true;
        return { ok: true };
      },
      fromPath: "/root/a.txt",
      fromType: "file",
      toDirPath: "/root",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("noop");
    expect(called).toBe(false);
  });

  test("blocks cyclic folder moves before rename", async () => {
    let called = false;
    const result = await executeFileTreeMove({
      rename: async () => {
        called = true;
        return { ok: true };
      },
      fromPath: "/root/a",
      fromType: "directory",
      toDirPath: "/root/a/child",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("cyclic");
    expect(called).toBe(false);
  });

  test("returns exists when rename collides", async () => {
    const result = await executeFileTreeMove({
      rename: async (): Promise<FsRenameResult> => ({ ok: false, code: "exists" }),
      fromPath: "/root/a.txt",
      fromType: "file",
      toDirPath: "/root/sub",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("exists");
  });

  test("calls rename with joined destination path", async () => {
    let captured: { from: string; to: string } | null = null;
    const result = await executeFileTreeMove({
      rename: async (from, to): Promise<FsRenameResult> => {
        captured = { from, to };
        return { ok: true };
      },
      fromPath: "/root/a.txt",
      fromType: "file",
      toDirPath: "/root/sub",
    });
    expect(result.ok).toBe(true);
    expect(captured).toEqual({ from: "/root/a.txt", to: "/root/sub/a.txt" });
  });
});

describe("executeFileTreeMkdir", () => {
  test("returns exists on collision", async () => {
    const result = await executeFileTreeMkdir({
      mkdir: async (): Promise<FsMkdirResult> => ({ ok: false, code: "exists" }),
      path: "/root/new",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("exists");
  });

  test("passes through success", async () => {
    const result = await executeFileTreeMkdir({
      mkdir: async (): Promise<FsMkdirResult> => ({ ok: true }),
      path: "/root/new",
    });
    expect(result.ok).toBe(true);
  });
});

describe("executeFileTreeTrash", () => {
  test("passes the target path to trash and reports success", async () => {
    let captured: string | null = null;
    const result = await executeFileTreeTrash({
      trash: async (p): Promise<FsTrashResult> => {
        captured = p;
        return { ok: true };
      },
      path: "/root/wrong-folder",
    });
    expect(result.ok).toBe(true);
    expect(captured).toBe("/root/wrong-folder");
  });

  test("surfaces a forbidden/error result", async () => {
    const result = await executeFileTreeTrash({
      trash: async (): Promise<FsTrashResult> => ({ ok: false, code: "forbidden" }),
      path: "/etc/passwd",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("forbidden");
  });
});

describe("formatFsTrashError", () => {
  test("maps codes to user-facing copy", () => {
    expect(formatFsTrashError("forbidden").title).toBe("Delete blocked");
    expect(formatFsTrashError("error", "in use").message).toBe("in use");
  });
});

describe("non-desktop move guard messaging", () => {
  test("formatFsMoveError covers forbidden and generic error", () => {
    expect(formatFsMoveError("forbidden").title).toBe("Move blocked");
    expect(formatFsMoveError("error", "disk full").message).toBe("disk full");
  });
});
