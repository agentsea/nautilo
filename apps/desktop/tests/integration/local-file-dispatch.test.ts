import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createWorkspaceGuard } from "@nautilo/relay";
import { Sandbox } from "@nautilo/sandbox";
import { DesktopDocumentMutationRuntime } from "../../electron/document-mutations/desktop-document-mutation-runtime.ts";
import { createGuardedNodeAdapter } from "../../electron/local-file-history/file-adapter.ts";
import { LocalDurableMutationJournal } from "../../electron/local-file-history/durable-mutations.ts";
import { LocalFileHistoryJournal } from "../../electron/local-file-history/journal.ts";
import type { JournalStorage } from "../../electron/local-file-history/storage.ts";
import type { LocalFileHistoryManifest } from "../../electron/local-file-history/types.ts";
import type { RelayDispatchRequest } from "@nautilo/relay";

let mockLocalFileHistoryDir = "";

mock.module("electron", () => ({
  app: {
    getPath: () => os.tmpdir(),
    isPackaged: false,
  },
}));

mock.module("../../electron/paths", () => ({
  localFileHistoryDirPath: () => mockLocalFileHistoryDir,
}));

let handleLocalFileDispatch: typeof import("../../electron/local-file-dispatch/index.ts").handleLocalFileDispatch;

beforeAll(async () => {
  mockLocalFileHistoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "lfd-history-mock-"));
  const imported = await import("../../electron/local-file-dispatch/index.ts");
  handleLocalFileDispatch = (async (request, options) => {
    if (options.journal !== undefined) {
      return imported.handleLocalFileDispatch(request, options);
    }
    const allowedRoots = request.allowedRoots ?? [];
    const adapter = createGuardedNodeAdapter({ allowedRoots });
    const durable = new LocalDurableMutationJournal({
      rootDir: options.journalRootDir ?? mockLocalFileHistoryDir,
      relayId: options.relayId,
      fileAdapter: adapter,
    });
    const runtime = new DesktopDocumentMutationRuntime({
      getTrustedRelayId: () => options.relayId,
      getTrustedHumanId: () => OWNER,
      fileAdapter: adapter,
      journal: durable,
      publishToRenderer: async () => "published",
    });
    return imported.handleLocalFileDispatch(request, {
      ...options,
      agentContentCommit: (input) =>
        runtime.commitAgentContent({
          ...input,
          command: input.command as
            | "write"
            | "insert"
            | "str_replace"
            | "document_write_commit",
          reauthorize: async () => undefined,
        }),
      structuralCommit: (input) =>
        runtime.commitAgentStructural({
          ...input,
          reauthorize: async () => undefined,
        }),
      historyCommit: (input) =>
        runtime.commitHistoryRestore({
          ...input,
          reauthorize: async () => undefined,
        }),
    });
  }) as typeof handleLocalFileDispatch;
});

afterAll(async () => {
  if (mockLocalFileHistoryDir) {
    await fs.rm(mockLocalFileHistoryDir, { recursive: true, force: true });
  }
});

const OWNER = "00000000-0000-4000-8000-000000000001";
const AGENT = "00000000-0000-4000-8000-000000000002";
const RELAY = "relay-desktop-test";

function routing(extra: Record<string, unknown> = {}) {
  const mutationRequestId = `local-dispatch-${crypto.randomUUID()}`;
  return {
    ownerId: OWNER,
    agentId: AGENT,
    turnId: "turn-1",
    currentFolder: extra["currentFolder"] ?? null,
    workspaceRoot: "",
    mutationRequestId,
    ...extra,
  };
}

function localFileReq(
  operation: Record<string, unknown>,
  opts: { approvalObtained?: boolean; roots: string[] },
): RelayDispatchRequest {
  return {
    correlationId: "test",
    toolName: "local-file",
    executionClass: "local-file",
    impact: "read-only",
    approvalObtained: opts.approvalObtained ?? false,
    allowedRoots: opts.roots,
    args: {
      operation,
      allowedRoots: opts.roots,
    },
  };
}

async function fixture(): Promise<{
  root: string;
  journalRoot: string;
  guard: ReturnType<typeof createWorkspaceGuard>;
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lfd-root-"));
  const journalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lfd-journal-"));
  const guard = createWorkspaceGuard({ allowedRoots: [root] });
  return {
    root,
    journalRoot,
    guard,
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(journalRoot, { recursive: true, force: true });
    },
  };
}

describe("handleLocalFileDispatch (M206)", () => {
  test("guarded adapter serves media ranges without whole-file reads", async () => {
    const { root, cleanup } = await fixture();
    try {
      const source = Buffer.alloc(17 * 1024 * 1024, 0x5a);
      await fs.writeFile(path.join(root, "large.mp4"), source);
      const adapter = createGuardedNodeAdapter({ allowedRoots: [root] });
      const first = await adapter.readRange!(path.join(root, "large.mp4"), 0, 1024 * 1024);
      const second = await adapter.readRange!(path.join(root, "large.mp4"), 16 * 1024 * 1024, 1024 * 1024);
      expect(first.byteLength).toBe(1024 * 1024);
      expect(second.byteLength).toBe(1024 * 1024);
      expect(Buffer.from(first).equals(source.subarray(0, 1024 * 1024))).toBe(true);
      expect(Buffer.from(second).equals(source.subarray(16 * 1024 * 1024))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("rejects mutation without approvalObtained", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const req = localFileReq(
        {
          kind: "file",
          command: "write",
          zone: "current",
          args: {
            path: "notes.txt",
            content: "hello",
            _routing: routing({ currentFolder: root }),
          },
        },
        { roots: [root], approvalObtained: false },
      );
      const res = await handleLocalFileDispatch(req, { relayId: RELAY, guard, journalRootDir: journalRoot });
      expect(res.status).toBe("error");
      expect(res.error).toContain("approvalObtained");
    } finally {
      await cleanup();
    }
  });

  test("rejects forbidden argv/executable fields", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const req = localFileReq(
        {
          kind: "file",
          command: "read",
          zone: "current",
          args: {
            path: "x.txt",
            argv: ["rm", "-rf", "/"],
            _routing: routing({ currentFolder: root }),
          },
        },
        { roots: [root], approvalObtained: true },
      );
      const res = await handleLocalFileDispatch(req, { relayId: RELAY, guard, journalRootDir: journalRoot });
      expect(res.status).toBe("error");
      expect(res.error).toContain("argv");
    } finally {
      await cleanup();
    }
  });

  test("read with binary:true returns base64 content", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const payload = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]);
      await fs.writeFile(path.join(root, "binary.docx"), payload);

      const readRes = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "file",
            command: "read",
            zone: "current",
            args: {
              path: "binary.docx",
              binary: true,
              _routing: routing({ currentFolder: root }),
            },
          },
          { roots: [root] },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      expect(readRes.status).toBe("ok");
      const parsed = JSON.parse(readResOk(readRes)) as { content: string; binary: boolean };
      expect(parsed.binary).toBe(true);
      expect(Buffer.from(parsed.content, "base64").equals(payload)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("text read returns the exact citable line window", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      await fs.writeFile(path.join(root, "source.ts"), "one\ntwo\nthree\n");
      const readRes = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "file",
            command: "read",
            zone: "current",
            args: {
              path: "source.ts",
              offset: 2,
              limit: 2,
              _routing: routing({ currentFolder: root }),
            },
          },
          { roots: [root] },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      expect(readRes.status).toBe("ok");
      expect(JSON.parse(readResOk(readRes))).toMatchObject({ content: "two\nthree\n", startLine: 2, endLine: 3, startByte: 4, endByte: 14, nextCursor: null });

      const rangeReadRes = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "file",
            command: "read",
            zone: "current",
            args: {
              path: "source.ts",
              offset: 1,
              limit: 1,
              lineRange: { from: 2, to: 3 },
              _routing: routing({ currentFolder: root }),
            },
          },
          { roots: [root] },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      expect(rangeReadRes.status).toBe("ok");
      expect(JSON.parse(readResOk(rangeReadRes))).toMatchObject({ content: "two\nthree\n", startLine: 2, endLine: 3, startByte: 4, endByte: 14, nextCursor: null });
    } finally {
      await cleanup();
    }
  });

  test("current-folder read returns bounded parent discovery when the exact target is absent", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      await fs.mkdir(path.join(root, "api", "demo", "start"), { recursive: true });
      await fs.mkdir(path.join(root, "api", "demo", "convert"), { recursive: true });
      await fs.writeFile(path.join(root, "api", "demo", "start", "route.ts"), "export const POST = 1;\n");
      await fs.writeFile(path.join(root, "api", "demo", "convert", "route.ts"), "export const POST = 2;\n");

      const readRes = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "file",
            command: "read",
            zone: "current",
            args: {
              path: "api/demo/route.ts",
              _routing: routing({ currentFolder: root }),
            },
          },
          { roots: [root] },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );

      expect(readRes.status).toBe("ok");
      const recovery = JSON.parse(readResOk(readRes)) as {
        ok: boolean;
        command: string;
        readStatus: string;
        requestedPath: string;
        entries: Array<{ name: string; type: string }>;
      };
      expect(recovery).toMatchObject({
        ok: true,
        command: "read",
        readStatus: "target_not_found",
        requestedPath: "api/demo/route.ts",
      });
      expect(recovery.entries.some((entry) => entry.name === "start" && entry.type === "directory")).toBe(true);
      expect(recovery.entries.some((entry) => entry.name === "convert" && entry.type === "directory")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("write with binary field is rejected before dispatch", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const res = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "file",
            command: "write",
            zone: "current",
            args: {
              path: "blocked.txt",
              content: "x",
              binary: true,
              _routing: routing({ currentFolder: root }),
            },
          },
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      expect(res.status).toBe("error");
      expect(res.error).toContain("binary");
    } finally {
      await cleanup();
    }
  });

  test("undo_turn reverts all files from an appOperationId transaction", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    const appOpId = "app:writer:00000000-0000-4000-8000-0000000000aa";
    try {
      const writeRes = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "file",
            command: "write",
            zone: "current",
            args: {
              path: "ui-op.txt",
              content: "from-ui",
              _routing: routing({ currentFolder: root, turnId: undefined, appOperationId: appOpId }),
            },
          },
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      expect((JSON.parse(readResOk(writeRes)) as Record<string, unknown>).applied).toBe(true);
      expect(await fs.readFile(path.join(root, "ui-op.txt"), "utf-8")).toBe("from-ui");

      const undoTurnRes = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "history",
            command: "undo_turn",
            args: {
              targetTurnId: appOpId,
              zone: "current",
              _routing: routing({ currentFolder: root, appOperationId: appOpId }),
            },
          },
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      const undoTurnJson = JSON.parse(readResOk(undoTurnRes)) as { appliedCount: number };
      expect(undoTurnJson.appliedCount).toBe(1);
      expect(fs.stat(path.join(root, "ui-op.txt"))).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  test("read and typed native grep return content; write returns metadata envelope", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    const sandbox = await Sandbox.create({
      config: { mode: "disabled", writablePaths: [], projectPaths: [], passthroughEnv: [] },
      workspace: root,
      dataDir: root,
      toolsBin: root,
      detectBackendOverride: () => Promise.resolve({ kind: "none" }),
    });
    try {
      await fs.writeFile(path.join(root, "alpha.txt"), "hello alpha\nbeta line\n");

      const readRes = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "file",
            command: "read",
            zone: "current",
            args: { path: "alpha.txt", _routing: routing({ currentFolder: root }) },
          },
          { roots: [root] },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      expect(readRes.status).toBe("ok");
      const readPayload = (readRes.result as { result: string }).result;
      expect(readPayload).toContain("hello alpha");

      const grepRes = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "search",
            command: "grep",
            zone: "current",
            args: {
              path: ".",
              query: "beta",
              limit: 200,
              includeIgnored: false,
              hidden: "include",
              caseMode: "smart",
            },
            routing: routing({ currentFolder: root }),
          },
          { roots: [root] },
        ),
        {
          relayId: RELAY,
          guard,
          journalRootDir: journalRoot,
          sandbox,
          ripgrepRuntime: {
            ok: true,
            binaryPath: "/managed/rg",
            version: "15.1.0",
          },
          searchExecute: async (input) => {
            input.onStdoutChunk(Buffer.from(`${JSON.stringify({
              type: "match",
              data: {
                path: { text: "alpha.txt" },
                lines: { text: "beta line\n" },
                line_number: 2,
                submatches: [{ match: { text: "beta" }, start: 0, end: 4 }],
              },
            })}\n`));
            return {
              exitCode: 0,
              stderr: "",
              timedOut: false,
              aborted: false,
              stoppedEarly: false,
            };
          },
        },
      );
      expect(grepRes.status).toBe("ok");
      const grepText = JSON.stringify((grepRes.result as { result: unknown }).result);
      expect(grepText).toContain("beta");

      const writeRes = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "file",
            command: "write",
            zone: "current",
            args: {
              path: "new.txt",
              content: "created",
              _routing: routing({ currentFolder: root }),
            },
          },
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      expect(writeRes.status).toBe("ok");
      const writeJson = JSON.parse(
        (writeRes.result as { result: string }).result,
      ) as { applied: boolean; revisionId: string };
      expect(writeJson.applied).toBe(true);
      expect(writeJson.revisionId.startsWith(`local:${RELAY}:`)).toBe(true);
      expect(writeJson).not.toHaveProperty("content");
    } finally {
      await sandbox.close();
      await cleanup();
    }
  });

  test("rejects paths outside allowed roots and symlink escapes", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const outside = path.join(os.tmpdir(), `lfd-outside-${Date.now()}.txt`);
      await fs.writeFile(outside, "secret");

      const absRes = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "file",
            command: "read",
            zone: "absolute",
            args: { path: outside, _routing: routing() },
          },
          { roots: [root] },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      expect(readResOk(absRes)).toContain("outside allowed roots");

      const link = path.join(root, "escape-link");
      await fs.symlink(outside, link);
      const symRes = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "file",
            command: "read",
            zone: "current",
            args: { path: "escape-link", _routing: routing({ currentFolder: root }) },
          },
          { roots: [root] },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      expect(readResOk(symRes)).toContain("symlink");

      await fs.unlink(outside);
    } finally {
      await cleanup();
    }
  });

  test("journal-backed undo/redo and list_revisions use local refs only", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const writeRes = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "file",
            command: "write",
            zone: "current",
            args: {
              path: "journal.txt",
              content: "v1",
              _routing: routing({ currentFolder: root }),
            },
          },
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      const writeJson = JSON.parse(readResOk(writeRes)) as { revisionId: string };

      const listRes = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "history",
            command: "list_revisions",
            args: { _routing: routing({ currentFolder: root }) },
          },
          { roots: [root] },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      const listJson = JSON.parse(readResOk(listRes)) as {
        revisions: Array<{ revisionId: string }>;
      };
      expect(listJson.revisions.length).toBeGreaterThan(0);
      expect(listJson.revisions[0]?.revisionId.startsWith(`local:${RELAY}:`)).toBe(true);

      const undoRes = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "history",
            command: "undo",
            args: {
              zone: "current",
              path: "journal.txt",
              revisionId: writeJson.revisionId,
              _routing: routing({ currentFolder: root }),
            },
          },
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      const undoJson = JSON.parse(readResOk(undoRes)) as { applied: boolean };
      expect(undoJson.applied).toBe(true);
      expect(fs.stat(path.join(root, "journal.txt"))).rejects.toThrow();

      const redoRes = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "history",
            command: "redo",
            args: {
              zone: "current",
              path: "journal.txt",
              _routing: routing({ currentFolder: root }),
            },
          },
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      const redoJson = JSON.parse(readResOk(redoRes)) as { applied: boolean };
      expect(redoJson.applied).toBe(true);
      const disk2 = await fs.readFile(path.join(root, "journal.txt"), "utf-8");
      expect(disk2).toBe("v1");
    } finally {
      await cleanup();
    }
  });

  test("move and delete mutate disk with journal revision refs", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      await fs.writeFile(path.join(root, "move-me.txt"), "payload");

      const moveRes = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "file",
            command: "move",
            zone: "current",
            args: {
              path: "move-me.txt",
              destinationPath: "moved.txt",
              _routing: routing({ currentFolder: root }),
            },
          },
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      const moveJson = JSON.parse(readResOk(moveRes)) as { revisionId: string };
      expect(moveJson.revisionId.startsWith(`local:${RELAY}:`)).toBe(true);
      expect(fs.stat(path.join(root, "moved.txt"))).resolves.toBeDefined();

      const delRes = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "file",
            command: "delete",
            zone: "current",
            args: {
              path: "moved.txt",
              _routing: routing({ currentFolder: root }),
            },
          },
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      const delJson = JSON.parse(readResOk(delRes)) as { applied: boolean };
      expect(delJson.applied).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("write without turnId fails before disk mutation", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const target = path.join(root, "no-turn.txt");
      const res = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "file",
            command: "write",
            zone: "current",
            args: {
              path: "no-turn.txt",
              content: "blocked",
              _routing: routing({ currentFolder: root, turnId: undefined }),
            },
          },
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      const body = readResOk(res);
      const parsed = JSON.parse(body) as { error: string };
      expect(parsed.error).toBe("missing_turn_id");
      expect(fs.stat(target)).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  test("journal failure compensates disk and returns error", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      await fs.writeFile(path.join(root, "comp.txt"), "before");
      const adapter = createGuardedNodeAdapter({ allowedRoots: [root] });
      const manifestWrites = 0;
      const baseStorage = (await import("../../electron/local-file-history/storage.ts"))
        .createJournalStorage(journalRoot);
      const failingStorage: JournalStorage = {
        ...baseStorage,
        async writeManifest(_manifest: LocalFileHistoryManifest) {
          throw new Error("journal persist failed");
        },
      };
      const journal = new LocalFileHistoryJournal({
        rootDir: journalRoot,
        relayId: RELAY,
        fileAdapter: adapter,
        storage: failingStorage,
      });
      await journal.init();

      const res = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "file",
            command: "write",
            zone: "current",
            args: {
              path: "comp.txt",
              content: "after",
              _routing: routing({ currentFolder: root }),
            },
          },
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot, journal },
      );
      const body = readResOk(res);
      const parsed = JSON.parse(body) as { error: string };
      expect(parsed.error).toBeDefined();
      expect(await fs.readFile(path.join(root, "comp.txt"), "utf-8")).toBe("before");
    } finally {
      await cleanup();
    }
  });

  test("undo create removes file; undo delete restores bytes; undo move restores source", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const createRes = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "file",
            command: "write",
            zone: "current",
            args: {
              path: "created.txt",
              content: "new-file",
              _routing: routing({ currentFolder: root }),
            },
          },
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      expect(readResOk(createRes)).toContain("applied");
      expect(fs.stat(path.join(root, "created.txt"))).resolves.toBeDefined();

      const undoCreate = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "history",
            command: "undo",
            args: {
              zone: "current",
              path: "created.txt",
              _routing: routing({ currentFolder: root }),
            },
          },
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      expect((JSON.parse(readResOk(undoCreate)) as Record<string, unknown>).applied).toBe(true);
      expect(fs.stat(path.join(root, "created.txt"))).rejects.toThrow();

      await fs.writeFile(path.join(root, "gone.txt"), "restore-me");
      const delRes = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "file",
            command: "delete",
            zone: "current",
            args: { path: "gone.txt", _routing: routing({ currentFolder: root }) },
          },
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      expect((JSON.parse(readResOk(delRes)) as Record<string, unknown>).applied).toBe(true);
      expect(fs.stat(path.join(root, "gone.txt"))).rejects.toThrow();

      const undoDelete = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "history",
            command: "undo",
            args: {
              zone: "current",
              path: "gone.txt",
              _routing: routing({ currentFolder: root }),
            },
          },
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      expect((JSON.parse(readResOk(undoDelete)) as Record<string, unknown>).applied).toBe(true);
      expect(await fs.readFile(path.join(root, "gone.txt"), "utf-8")).toBe("restore-me");

      await fs.writeFile(path.join(root, "src.txt"), "payload");
      const moveRes = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "file",
            command: "move",
            zone: "current",
            args: {
              path: "src.txt",
              destinationPath: "dest.txt",
              _routing: routing({ currentFolder: root }),
            },
          },
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      expect((JSON.parse(readResOk(moveRes)) as Record<string, unknown>).revisionId).toBeDefined();
      expect(fs.stat(path.join(root, "src.txt"))).rejects.toThrow();
      expect(await fs.readFile(path.join(root, "dest.txt"), "utf-8")).toBe("payload");

      const undoMove = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "history",
            command: "undo",
            args: {
              zone: "current",
              path: "src.txt",
              _routing: routing({ currentFolder: root }),
            },
          },
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      expect((JSON.parse(readResOk(undoMove)) as Record<string, unknown>).applied).toBe(true);
      expect(await fs.readFile(path.join(root, "src.txt"), "utf-8")).toBe("payload");
      expect(fs.stat(path.join(root, "dest.txt"))).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  test("move/copy reject symlink destinations before mutation", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      await fs.writeFile(path.join(root, "src.txt"), "data");
      const outside = path.join(os.tmpdir(), `lfd-sym-dest-${Date.now()}.txt`);
      await fs.writeFile(outside, "secret");
      const link = path.join(root, "dest-link");
      await fs.symlink(outside, link);

      const moveRes = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "file",
            command: "move",
            zone: "current",
            args: {
              path: "src.txt",
              destinationPath: "dest-link",
              _routing: routing({ currentFolder: root }),
            },
          },
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      expect(readResOk(moveRes)).toContain("symbolic-link target rejected");
      expect(await fs.readFile(path.join(root, "src.txt"), "utf-8")).toBe("data");

      const copyRes = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "file",
            command: "copy",
            zone: "current",
            args: {
              path: "src.txt",
              destinationPath: "dest-link",
              _routing: routing({ currentFolder: root }),
            },
          },
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      expect(readResOk(copyRes)).toContain("symbolic-link target rejected");

      await fs.unlink(outside);
    } finally {
      await cleanup();
    }
  });

  test("copy rejects binary sources, preserves text, and rejects workspace destinations", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      await fs.writeFile(path.join(root, "binary.bin"), Buffer.from([0x00, 0x01, 0x02]));
      const binaryCopy = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "file",
            command: "copy",
            zone: "current",
            args: {
              path: "binary.bin",
              destinationPath: "binary-copy.bin",
              _routing: routing({ currentFolder: root }),
            },
          },
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      expect(readResOk(binaryCopy)).toContain("binary_source");
      expect(fs.stat(path.join(root, "binary-copy.bin"))).rejects.toThrow();

      await fs.writeFile(path.join(root, "source.txt"), "copy this text\n");
      const textCopy = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "file",
            command: "copy",
            zone: "current",
            args: {
              path: "source.txt",
              destinationPath: "copied.txt",
              _routing: routing({ currentFolder: root }),
            },
          },
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      expect((JSON.parse(readResOk(textCopy)) as Record<string, unknown>).applied).toBe(true);
      expect(await fs.readFile(path.join(root, "copied.txt"), "utf8")).toBe("copy this text\n");

      const workspaceDestination = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "file",
            command: "copy",
            zone: "current",
            args: {
              path: "source.txt",
              destinationPath: "must-not-write.txt",
              destinationZone: "workspace",
              _routing: routing({ currentFolder: root }),
            },
          },
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      expect(readResOk(workspaceDestination)).toContain('unsupported local file zone "workspace"');
      expect(fs.stat(path.join(root, "must-not-write.txt"))).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  test("D418 local-file dispatch without validated authority fails closed", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      await fs.writeFile(path.join(root, "grant.txt"), "secret");
      const req = localFileReq(
        {
          kind: "file",
          command: "read",
          zone: "current",
          args: { path: "grant.txt", _routing: routing({ currentFolder: root }) },
        },
        { roots: [root] },
      );
      req.desktopFilesystemGrantRequest = {
        version: 1,
        grantIds: ["g1"],
        requestedRoot: root,
        operation: "read",
        subject: { userId: "u", instanceId: "i", relayId: "r", agentScope: "a" },
        policy: { policyVersion: 1, lifetime: "durable" },
      };
      // No options.desktopFilesystemAuthority → server roots cannot widen.
      const res = await handleLocalFileDispatch(req, { relayId: RELAY, guard, journalRootDir: journalRoot });
      expect(res.status).toBe("error");
      expect(res.error).toContain("locally validated authority");
    } finally {
      await cleanup();
    }
  });

  test("D418 local-file dispatch is jailed to the validated authority, not server roots", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "lfd-server-root-"));
    try {
      await fs.writeFile(path.join(root, "inside.txt"), "inside");
      const outsideFile = path.join(otherDir, "secret.txt");
      await fs.writeFile(outsideFile, "server-secret");

      const grantEnvelope = {
        version: 1 as const,
        grantIds: ["g1"],
        requestedRoot: root,
        operation: "read" as const,
        subject: { userId: "u", instanceId: "i", relayId: "r", agentScope: "a" },
        policy: { policyVersion: 1, lifetime: "durable" as const },
      };

      // Server presents allowedRoots=[otherDir]; only the validated root reaches
      // the guarded adapter.
      const insideReq = localFileReq(
        {
          kind: "file",
          command: "read",
          zone: "current",
          args: { path: "inside.txt", _routing: routing({ currentFolder: root }) },
        },
        { roots: [otherDir] },
      );
      insideReq.desktopFilesystemGrantRequest = grantEnvelope;
      const insideRes = await handleLocalFileDispatch(insideReq, {
        relayId: RELAY,
        guard,
        journalRootDir: journalRoot,
        desktopFilesystemAuthority: { roots: [root] },
      });
      expect(insideRes.status).toBe("ok");
      expect((insideRes.result as { ok: boolean }).ok).toBe(true);

      const outsideReq = localFileReq(
        {
          kind: "file",
          command: "read",
          zone: "absolute",
          args: { path: outsideFile, _routing: routing() },
        },
        { roots: [otherDir] },
      );
      outsideReq.desktopFilesystemGrantRequest = grantEnvelope;
      const outsideRes = await handleLocalFileDispatch(outsideReq, {
        relayId: RELAY,
        guard,
        journalRootDir: journalRoot,
        desktopFilesystemAuthority: { roots: [root] },
      });
      expect(readResOk(outsideRes)).toContain("outside allowed roots");
    } finally {
      await fs.rm(otherDir, { recursive: true, force: true });
      await cleanup();
    }
  });

  test("recursive delete is explicitly rejected without mutating disk", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      await fs.mkdir(path.join(root, "tree", "nested"), { recursive: true });
      await fs.writeFile(path.join(root, "tree", "nested", "leaf.txt"), "x");

      const delRes = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "file",
            command: "delete",
            zone: "current",
            args: {
              path: "tree",
              recursive: true,
              _routing: routing({ currentFolder: root }),
            },
          },
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      expect(JSON.parse(readResOk(delRes))).toMatchObject({
        error: "recursive_delete_unsupported",
      });
      expect(
        await fs.readFile(path.join(root, "tree", "nested", "leaf.txt"), "utf8"),
      ).toBe("x");
    } finally {
      await cleanup();
    }
  });
});

function readResOk(res: { status: string; result?: unknown; error?: string }): string {
  expect(res.status).toBe("ok");
  const inner = res.result as { ok: boolean; result: string };
  expect(inner.ok).toBe(true);
  return inner.result;
}


test("text transport recovers a late range beyond 16 MiB and every byte of a long line", async () => {
  const { root, journalRoot, guard, cleanup } = await fixture();
  try {
    const prefix = "short\n".repeat(3_000_000);
    const tail = "🦑é界".repeat(20_000) + "\r\nend\n";
    await fs.writeFile(path.join(root, "large.txt"), prefix + tail);
    const read = async (args: Record<string, unknown>) => {
      const result = await handleLocalFileDispatch(localFileReq({ kind: "file", command: "read", zone: "current",
        args: { path: "large.txt", ...args, _routing: routing({ currentFolder: root }) },
      }, { roots: [root] }), { relayId: RELAY, guard, journalRootDir: journalRoot });
      return readResOk(result);
    };
    const pages: Buffer[] = [];
    for (const lineRange of [null, [], {}, { from: 0, to: 1 }, { from: 3, to: 2 }]) {
      expect(await read({ lineRange })).toContain("Error: read lineRange");
    }
    const first = JSON.parse(await read({ offset: 0, limit: 1 })) as import("@nautilo/relay").TextWindow;
    expect(first.startLine).toBe(1);
    expect(first.endLine).toBe(1);
    let page = JSON.parse(await read({ lineRange: { from: 3_000_001, to: 3_000_002 } })) as import("@nautilo/relay").TextWindow;
    const initialCursor = page.nextCursor;
    expect(initialCursor).not.toBeNull();
    expect(page.startByte).toBe(Buffer.byteLength(prefix));
    while (true) {
      pages.push(Buffer.from(page.content));
      if (!page.nextCursor) break;
      page = JSON.parse(await read({ readCursor: page.nextCursor })) as import("@nautilo/relay").TextWindow;
    }
    expect(Buffer.concat(pages).equals(Buffer.from(tail))).toBe(true);
    expect(page.endByte).toBe(Buffer.byteLength(prefix + tail));
    await fs.appendFile(path.join(root, "large.txt"), "changed");
    expect(await read({ readCursor: initialCursor })).toContain("Source changed");
  } finally { await cleanup(); }
});

describe("D580 Desktop discovery pages", () => {
  test("list cursor survives relay dispatch and exposes excluded subtrees", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      await fs.writeFile(path.join(root, "a.ts"), "source");
      await fs.writeFile(path.join(root, "b.ts"), "source");
      await fs.mkdir(path.join(root, "node_modules"));
      await fs.writeFile(path.join(root, "node_modules", "dependency.ts"), "source");
      const invoke = async (extra: Record<string, unknown> = {}) => {
        const response = await handleLocalFileDispatch(localFileReq({ kind: "file", command: "list", zone: "current",
          args: { path: ".", recursive: true, limit: 2, ...extra, _routing: routing({ currentFolder: root }) } }, { roots: [root] }),
        { guard, relayId: RELAY, journalRootDir: journalRoot });
        expect(response.status).toBe("ok");
        const envelope = response.result as { result: string };
        return JSON.parse(envelope.result) as { entries: Array<{ name: string; descendants?: string }>; nextCursor: string | null; complete: boolean; incompleteReasons: Array<{ reason: string; count: number }> };
      };
      const first = await invoke();
      expect(first.entries.map((entry) => entry.name)).toEqual(["a.ts", "b.ts"]);
      expect(first.nextCursor).toBeString();
      const second = await invoke({ discoveryCursor: first.nextCursor });
      expect(second.entries).toEqual([{ name: "node_modules", path: path.join(await fs.realpath(root), "node_modules"), type: "directory", descendants: "excluded_directory" }]);
      expect(second).toMatchObject({ nextCursor: null, complete: false, incompleteReasons: [{ reason: "excluded_directory", count: 1 }] });
      const expanded = await invoke({ includeIgnored: true, limit: 10 });
      expect(expanded.entries.map((entry) => entry.name)).toContain("dependency.ts");
      expect(expanded.complete).toBe(true);
    } finally { await cleanup(); }
  });
});

describe("create-only local documents", () => {
  test("creates once, replays the durable receipt, and rejects a different create", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const identity = routing({ currentFolder: root });
      const request = (retry = false, fresh = false) => localFileReq({
        kind: "file", command: "create", zone: "current",
        args: { path: "fresh.doc.html", content: "original", _routing: {
          ...(fresh ? routing({ currentFolder: root }) : identity),
          ...(retry ? { mutationRetry: true } : {}),
        } },
      }, { roots: [root], approvalObtained: true });
      const options = { relayId: RELAY, guard, journalRootDir: journalRoot };
      const first = JSON.parse(readResOk(await handleLocalFileDispatch(request(), options)));
      expect(first.applied).toBe(true);
      expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
      const replay = JSON.parse(readResOk(await handleLocalFileDispatch(request(true), options)));
      expect(replay.revisionId).toBe(first.revisionId);
      expect(replay.sha256).toBe(first.sha256);
      const collision = JSON.parse(readResOk(await handleLocalFileDispatch(request(false, true), options)));
      expect(collision.error).toBe("EXISTS");
      expect(await fs.readFile(path.join(root, "fresh.doc.html"), "utf8")).toBe("original");
    } finally { await cleanup(); }
  });

  test("does not overwrite a file created concurrently at atomic publication", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const adapter = createGuardedNodeAdapter({ allowedRoots: [root] });
      const publish = adapter.writeFileAtomicConditional!.bind(adapter);
      let raced = false;
      adapter.writeFileAtomicConditional = async (target, expected, bytes) => {
        if (!raced && expected.kind === "missing") {
          raced = true;
          await fs.writeFile(target, "concurrent Human document", { flag: "wx" });
        }
        return publish(target, expected, bytes);
      };
      const runtime = new DesktopDocumentMutationRuntime({
        getTrustedRelayId: () => RELAY, getTrustedHumanId: () => OWNER,
        fileAdapter: adapter,
        journal: new LocalDurableMutationJournal({ rootDir: journalRoot, relayId: RELAY, fileAdapter: adapter }),
        publishToRenderer: async () => "published",
      });
      const { handleLocalFileDispatch: dispatch } = await import("../../electron/local-file-dispatch/index.ts");
      const result = await dispatch(localFileReq({
        kind: "file", command: "create", zone: "current",
        args: { path: "raced.doc.html", content: "Genie document", _routing: routing({ currentFolder: root }) },
      }, { roots: [root], approvalObtained: true }), {
        relayId: RELAY, guard, journalRootDir: journalRoot,
        agentContentCommit: input => runtime.commitAgentContent({ ...input, reauthorize: async () => undefined }),
      });
      const receipt = JSON.parse(readResOk(result));
      expect(raced).toBe(true);
      expect(receipt.applied).not.toBe(true);
      expect(typeof receipt.error).toBe("string");
      expect(await fs.readFile(path.join(root, "raced.doc.html"), "utf8")).toBe("concurrent Human document");
    } finally { await cleanup(); }
  });

  test("requires mutation approval and rejects overwrite options", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const request = (approved: boolean, extra = {}) => localFileReq({
        kind: "file", command: "create", zone: "current",
        args: { path: "new.doc.html", content: "new", ...extra, _routing: routing({ currentFolder: root }) },
      }, { roots: [root], approvalObtained: approved });
      const options = { relayId: RELAY, guard, journalRootDir: journalRoot };
      expect((await handleLocalFileDispatch(request(false), options)).status).toBe("error");
      const invalid = JSON.parse(readResOk(await handleLocalFileDispatch(request(true, { mode: "overwrite" }), options)));
      expect(invalid.error).toBe("invalid_create_options");
      expect(await fs.access(path.join(root, "new.doc.html")).then(() => true, () => false)).toBe(false);
    } finally { await cleanup(); }
  });
});
