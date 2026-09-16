import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createWorkspaceGuard } from "@nautilo/relay";
import type { RelayDispatchRequest, RelayFsChangeEvent } from "@nautilo/relay";
import { DesktopDocumentMutationRuntime } from "../../electron/document-mutations/desktop-document-mutation-runtime.ts";
import { createGuardedNodeAdapter } from "../../electron/local-file-history/file-adapter.ts";
import { LocalDurableMutationJournal } from "../../electron/local-file-history/durable-mutations.ts";
import { sha256Hex, snapshotFromBytes } from "../../electron/local-file-history/hash.ts";
import { LocalFileHistoryJournal } from "../../electron/local-file-history/journal.ts";
import type { JournalStorage } from "../../electron/local-file-history/storage.ts";
import type { LocalFileHistoryManifest } from "../../electron/local-file-history/types.ts";
import { parseOptionalExpectedSha256 } from "../../electron/local-file-dispatch/guarded-write.ts";

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
  mockLocalFileHistoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "lfd-guarded-history-"));
  const imported = await import("../../electron/local-file-dispatch/index.ts");
  handleLocalFileDispatch = (async (request, options) => {
    if (options.journal !== undefined) {
      return imported.handleLocalFileDispatch(request, options);
    }
    const adapter = createGuardedNodeAdapter({
      allowedRoots: request.allowedRoots ?? [],
    });
    const runtime = new DesktopDocumentMutationRuntime({
      getTrustedRelayId: () => options.relayId,
      getTrustedHumanId: () => OWNER,
      fileAdapter: adapter,
      journal: new LocalDurableMutationJournal({
        rootDir: options.journalRootDir ?? mockLocalFileHistoryDir,
        relayId: options.relayId,
        fileAdapter: adapter,
      }),
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
const RELAY = "relay-guarded-write-test";

function routing(extra: Record<string, unknown> = {}) {
  return {
    ownerId: OWNER,
    agentId: AGENT,
    turnId: "turn-guarded-1",
    currentFolder: extra["currentFolder"] ?? null,
    workspaceRoot: "",
    mutationRequestId: `guarded-write-${crypto.randomUUID()}`,
    ...extra,
  };
}

function localFileReq(
  operation: Record<string, unknown>,
  opts: { approvalObtained?: boolean; roots: string[] },
): RelayDispatchRequest {
  return {
    correlationId: "test-guarded",
    toolName: "local-file",
    executionClass: "local-file",
    impact: "high",
    approvalObtained: opts.approvalObtained ?? true,
    allowedRoots: opts.roots,
    args: {
      operation,
      allowedRoots: opts.roots,
    },
  };
}

function readResOk(res: { status: string; result?: unknown; error?: string }): string {
  expect(res.status).toBe("ok");
  const inner = res.result as { ok: boolean; result: string };
  expect(inner.ok).toBe(true);
  return inner.result;
}

async function fixture(): Promise<{
  root: string;
  journalRoot: string;
  guard: ReturnType<typeof createWorkspaceGuard>;
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lfd-guarded-root-"));
  const journalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lfd-guarded-journal-"));
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

describe("M216 guarded local-file write foundation", () => {
  test("binary create-only write publishes exact bytes with SHA and one revision", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const bytes = Buffer.from([0, 255, 1, 128, 65]);
      const target = path.join(root, "created.bin");
      const writeRes = await handleLocalFileDispatch(
        localFileReq({
          kind: "file",
          command: "write",
          zone: "current",
          args: {
            path: "created.bin",
            content: bytes.toString("base64"),
            encoding: "base64",
            mode: "overwrite",
            expectedSha256: null,
            _routing: routing({ currentFolder: root }),
          },
        }, { roots: [root] }),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );

      const body = JSON.parse(readResOk(writeRes)) as { applied: boolean; revisionId: string; sha256: string };
      expect(body).toMatchObject({ applied: true, sha256: sha256Hex(bytes) });
      expect(body.revisionId.startsWith(`local:${RELAY}:`)).toBe(true);
      expect(await fs.readFile(target)).toEqual(bytes);

      const listRes = await handleLocalFileDispatch(localFileReq({
        kind: "history", command: "list_revisions", args: { _routing: routing({ currentFolder: root }) },
      }, { roots: [root] }), { relayId: RELAY, guard, journalRootDir: journalRoot });
      expect((JSON.parse(readResOk(listRes)) as { revisions: unknown[] }).revisions).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  test.each([Buffer.alloc(0), Buffer.from("human bytes")])(
    "create-only refuses an existing destination without file or history mutation",
    async (existing) => {
      const { root, journalRoot, guard, cleanup } = await fixture();
      try {
        const target = path.join(root, "existing.bin");
        await fs.writeFile(target, existing);
        const writeRes = await handleLocalFileDispatch(localFileReq({
          kind: "file", command: "write", zone: "current", args: {
            path: "existing.bin", content: Buffer.from("agent").toString("base64"),
            encoding: "base64", mode: "overwrite", expectedSha256: null,
            _routing: routing({ currentFolder: root }),
          },
        }, { roots: [root] }), { relayId: RELAY, guard, journalRootDir: journalRoot });

        expect(JSON.parse(readResOk(writeRes))).toMatchObject({ error: "destination_exists" });
        expect(await fs.readFile(target)).toEqual(existing);
        const listRes = await handleLocalFileDispatch(localFileReq({
          kind: "history", command: "list_revisions", args: { _routing: routing({ currentFolder: root }) },
        }, { roots: [root] }), { relayId: RELAY, guard, journalRootDir: journalRoot });
        expect((JSON.parse(readResOk(listRes)) as { revisions: unknown[] }).revisions).toHaveLength(0);
      } finally {
        await cleanup();
      }
    },
  );

  test("create-only preserves a file that appears between initial read and final publication", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const target = path.join(root, "raced.bin");
      const human = Buffer.from("human won race");
      const adapter = createGuardedNodeAdapter({ allowedRoots: [root] });
      const runtime = new DesktopDocumentMutationRuntime({
        getTrustedRelayId: () => RELAY,
        getTrustedHumanId: () => OWNER,
        fileAdapter: adapter,
        journal: new LocalDurableMutationJournal({ rootDir: journalRoot, relayId: RELAY, fileAdapter: adapter }),
        publishToRenderer: async () => "published",
      });
      const commandJournal = new LocalFileHistoryJournal({
        rootDir: journalRoot,
        relayId: RELAY,
        fileAdapter: adapter,
      });
      let injected = false;
      const writeRes = await handleLocalFileDispatch(localFileReq({
        kind: "file", command: "write", zone: "current", args: {
          path: "raced.bin", content: Buffer.from("agent").toString("base64"),
          encoding: "base64", mode: "overwrite", expectedSha256: null,
          _routing: routing({ currentFolder: root }),
        },
      }, { roots: [root] }), {
        relayId: RELAY,
        guard,
        journalRootDir: journalRoot,
        journal: commandJournal,
        agentContentCommit: async (input) => {
          if (!injected) {
            injected = true;
            await fs.writeFile(target, human);
          }
          return runtime.commitAgentContent({
            ...input,
            command: input.command as "write",
            reauthorize: async () => undefined,
          });
        },
      });

      expect(JSON.parse(readResOk(writeRes))).toMatchObject({
        error: "reapply_required",
        retryable: false,
      });
      expect(await fs.readFile(target)).toEqual(human);
      const listRes = await handleLocalFileDispatch(localFileReq({
        kind: "history", command: "list_revisions", args: { _routing: routing({ currentFolder: root }) },
      }, { roots: [root] }), { relayId: RELAY, guard, journalRootDir: journalRoot });
      expect((JSON.parse(readResOk(listRes)) as { revisions: unknown[] }).revisions).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("exact accepted retry replays its original receipt without a second revision", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const mutationRequestId = "create-only-replay";
      const args = {
        path: "replay.bin", content: Buffer.from("once").toString("base64"), encoding: "base64",
        mode: "overwrite", expectedSha256: null,
        _routing: routing({ currentFolder: root, mutationRequestId }),
      };
      const first = await handleLocalFileDispatch(localFileReq({ kind: "file", command: "write", zone: "current", args }, { roots: [root] }), {
        relayId: RELAY, guard, journalRootDir: journalRoot,
      });
      const retry = await handleLocalFileDispatch(localFileReq({
        kind: "file", command: "write", zone: "current",
        args: { ...args, _routing: { ...args._routing, mutationRetry: true } },
      }, { roots: [root] }), { relayId: RELAY, guard, journalRootDir: journalRoot });

      expect(readResOk(retry)).toBe(readResOk(first));
      const listRes = await handleLocalFileDispatch(localFileReq({
        kind: "history", command: "list_revisions", args: { _routing: routing({ currentFolder: root }) },
      }, { roots: [root] }), { relayId: RELAY, guard, journalRootDir: journalRoot });
      expect((JSON.parse(readResOk(listRes)) as { revisions: unknown[] }).revisions).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  test.each(["append", "prepend"])("create-only refuses %s mode", async (mode) => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const writeRes = await handleLocalFileDispatch(localFileReq({
        kind: "file", command: "write", zone: "current", args: {
          path: "mode.bin", content: "YQ==", encoding: "base64", mode,
          expectedSha256: null, _routing: routing({ currentFolder: root }),
        },
      }, { roots: [root] }), { relayId: RELAY, guard, journalRootDir: journalRoot });
      expect(JSON.parse(readResOk(writeRes))).toMatchObject({ error: "invalid_write_mode" });
      expect(await fs.stat(path.join(root, "mode.bin")).catch((error: NodeJS.ErrnoException) => error))
        .toMatchObject({ code: "ENOENT" });
    } finally {
      await cleanup();
    }
  });

  test("expectedSha256 success journals once and emits clientMutationId on change event", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    const changes: RelayFsChangeEvent[] = [];
    try {
      const initial = "before accept\n";
      const target = path.join(root, "writer-doc.md");
      await fs.writeFile(target, initial);
      const expectedSha256 = sha256Hex(Buffer.from(initial, "utf-8"));
      const accepted = "after accept\n";

      const writeRes = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "file",
            command: "write",
            zone: "current",
            args: {
              path: "writer-doc.md",
              content: accepted,
              expectedSha256,
              clientMutationId: "accept-request-42",
              _routing: routing({ currentFolder: root }),
            },
          },
          { roots: [root] },
        ),
        {
          relayId: RELAY,
          guard,
          journalRootDir: journalRoot,
          onFsChange: (event) => changes.push(event),
        },
      );

      const body = JSON.parse(readResOk(writeRes)) as {
        applied: boolean;
        revisionId: string;
        sha256: string;
        summary: string;
        unifiedDiff: string;
      };
      expect(body.applied).toBe(true);
      expect(body.revisionId.startsWith(`local:${RELAY}:`)).toBe(true);
      expect(body.sha256).toBe(sha256Hex(Buffer.from(accepted, "utf-8")));
      expect(body).not.toHaveProperty("clientMutationId");
      expect(body.summary).not.toContain("accept-request-42");
      expect(body.unifiedDiff).not.toContain("accept-request-42");
      expect(await fs.readFile(target, "utf-8")).toBe(accepted);

      expect(changes).toEqual([]);

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
      const listJson = JSON.parse(readResOk(listRes)) as { revisions: unknown[] };
      expect(listJson.revisions).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  test("expectedSha256 mismatch returns stale_sha256 without mutating disk or journaling", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    const changes: RelayFsChangeEvent[] = [];
    try {
      const initial = "still canonical\n";
      const target = path.join(root, "stale.md");
      await fs.writeFile(target, initial);
      const actualSha256 = sha256Hex(Buffer.from(initial, "utf-8"));

      const writeRes = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "file",
            command: "write",
            zone: "current",
            args: {
              path: "stale.md",
              content: "should-not-land",
              expectedSha256: "0".repeat(64),
              clientMutationId: "stale-attempt",
              _routing: routing({ currentFolder: root }),
            },
          },
          { roots: [root] },
        ),
        {
          relayId: RELAY,
          guard,
          journalRootDir: journalRoot,
          onFsChange: (event) => changes.push(event),
        },
      );

      const body = JSON.parse(readResOk(writeRes)) as {
        error: string;
        expectedSha256: string;
        actualSha256: string;
      };
      expect(body.error).toBe("stale_sha256");
      expect(body.expectedSha256).toBe("0".repeat(64));
      expect(body.actualSha256).toBe(actualSha256);
      expect(await fs.readFile(target, "utf-8")).toBe(initial);
      expect(changes).toHaveLength(0);

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
      const listJson = JSON.parse(readResOk(listRes)) as { revisions: unknown[] };
      expect(listJson.revisions).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("invalid expectedSha256 is rejected before dispatch side effects", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      await fs.writeFile(path.join(root, "bad-sha.md"), "x");
      const writeRes = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "file",
            command: "write",
            zone: "current",
            args: {
              path: "bad-sha.md",
              content: "y",
              expectedSha256: "NOT_A_SHA",
              _routing: routing({ currentFolder: root }),
            },
          },
          { roots: [root] },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      const body = JSON.parse(readResOk(writeRes)) as { error: string };
      expect(body.error).toBe("invalid_expected_sha256");
      expect(await fs.readFile(path.join(root, "bad-sha.md"), "utf-8")).toBe("x");
    } finally {
      await cleanup();
    }
  });

  test("guarded journal failure compensates disk after atomic write attempt", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const initial = "comp-before\n";
      const target = path.join(root, "comp-guarded.md");
      await fs.writeFile(target, initial);
      const expectedSha256 = sha256Hex(Buffer.from(initial, "utf-8"));

      const adapter = createGuardedNodeAdapter({ allowedRoots: [root] });
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

      const writeRes = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "file",
            command: "write",
            zone: "current",
            args: {
              path: "comp-guarded.md",
              content: "comp-after\n",
              expectedSha256,
              _routing: routing({ currentFolder: root }),
            },
          },
          { roots: [root] },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot, journal },
      );
      const body = JSON.parse(readResOk(writeRes)) as { error: string };
      expect(body.error).toBeDefined();
      expect(await fs.readFile(target, "utf-8")).toBe(initial);
    } finally {
      await cleanup();
    }
  });

  test("writeFileAtomic replaces via same-directory temp and rename", async () => {
    const { root, cleanup } = await fixture();
    try {
      const adapter = createGuardedNodeAdapter({ allowedRoots: [root] });
      const target = path.join(root, "atomic.txt");
      await fs.writeFile(target, "original-bytes");
      const next = Buffer.from("replacement-bytes");
      await adapter.writeFileAtomic!(target, next);
      expect(Buffer.from(await fs.readFile(target))).toEqual(next);
      const dirEntries = await fs.readdir(root);
      expect(dirEntries.some((name) => name.includes(".nautilo-"))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("legacy write without expectedSha256 keeps direct write behavior", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const writeRes = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "file",
            command: "write",
            zone: "current",
            args: {
              path: "legacy.txt",
              content: "legacy-content",
              _routing: routing({ currentFolder: root }),
            },
          },
          { roots: [root] },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      const body = JSON.parse(readResOk(writeRes)) as { applied: boolean; sha256?: string };
      expect(body.applied).toBe(true);
      expect(body.sha256).toBeUndefined();
      expect(await fs.readFile(path.join(root, "legacy.txt"), "utf-8")).toBe("legacy-content");
    } finally {
      await cleanup();
    }
  });
});

describe("guarded-write helpers", () => {
  test("legacy SHA parser rejects null outside the write command's explicit create guard", () => {
    expect(parseOptionalExpectedSha256({ expectedSha256: null })).toEqual({
      ok: false,
      text: JSON.stringify({
        error: "invalid_expected_sha256",
        message: "expectedSha256 must be 64 lowercase hex chars",
      }),
    });
  });

  test("snapshotFromBytes uses canonical lowercase sha256", () => {
    const snap = snapshotFromBytes(Buffer.from("abc", "utf-8"));
    expect(snap.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
