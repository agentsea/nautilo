import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  RELAY_FS_MAX_BYTES,
  RELAY_LOCAL_DOCUMENT_CHUNK_BYTES,
  RELAY_LOCAL_DOCUMENT_MAX_BYTES,
  RELAY_LOCAL_DOCUMENT_TRANSFER_TTL_MS,
  createWorkspaceGuard,
  type RelayDispatchRequest,
} from "@nautilo/relay";
import { DesktopDocumentMutationRuntime } from "../../electron/document-mutations/desktop-document-mutation-runtime.ts";
import { resetDocumentTransferSessionsForTests } from "../../electron/local-file-dispatch/document-chunks.ts";
import { createGuardedNodeAdapter } from "../../electron/local-file-history/file-adapter.ts";
import { LocalDurableMutationJournal } from "../../electron/local-file-history/durable-mutations.ts";
import { sha256Hex } from "../../electron/local-file-history/hash.ts";

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
  mockLocalFileHistoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "lfd-doc-history-"));
  ({ handleLocalFileDispatch } = await import("../../electron/local-file-dispatch/index.ts"));
});

afterAll(async () => {
  if (mockLocalFileHistoryDir) {
    await fs.rm(mockLocalFileHistoryDir, { recursive: true, force: true });
  }
});

afterEach(() => {
  resetDocumentTransferSessionsForTests();
});

const OWNER = "00000000-0000-4000-8000-000000000001";
const AGENT = "00000000-0000-4000-8000-000000000002";
const RELAY = "relay-document-transport-test";

function routing(extra: Record<string, unknown> = {}) {
  return {
    ownerId: OWNER,
    agentId: AGENT,
    turnId: "turn-doc-1",
    mutationRequestId: "d448:turn-doc-1:test-semantics",
    currentFolder: extra["currentFolder"] ?? null,
    workspaceRoot: "",
    ...extra,
  };
}

function documentReq(
  command: string,
  args: Record<string, unknown>,
  opts: { approvalObtained?: boolean; roots: string[]; currentFolder: string },
): RelayDispatchRequest {
  return {
    correlationId: "test-document",
    toolName: "local-file",
    executionClass: "local-file",
    impact: command.startsWith("write") ? "high" : "read-only",
    approvalObtained: opts.approvalObtained ?? command.startsWith("write"),
    allowedRoots: opts.roots,
    args: {
      operation: {
        kind: "document",
        command,
        zone: "current",
        args: {
          ...args,
          _routing: routing({ currentFolder: opts.currentFolder }),
        },
      },
      allowedRoots: opts.roots,
    },
  };
}

function fileReadReq(
  relativePath: string,
  opts: { roots: string[]; currentFolder: string },
): RelayDispatchRequest {
  return {
    correlationId: "test-read",
    toolName: "local-file",
    executionClass: "local-file",
    impact: "read-only",
    approvalObtained: false,
    allowedRoots: opts.roots,
    args: {
      operation: {
        kind: "file",
        command: "read",
        zone: "current",
        args: {
          path: relativePath,
          binary: true,
          _routing: routing({ currentFolder: opts.currentFolder }),
        },
      },
      allowedRoots: opts.roots,
    },
  };
}

function innerOk(res: { status: string; result?: unknown }): unknown {
  expect(res.status).toBe("ok");
  const inner = res.result as { ok: boolean; result: unknown };
  expect(inner.ok).toBe(true);
  return inner.result;
}

function innerText(res: { status: string; result?: unknown }): string {
  return innerOk(res) as string;
}

async function fixture(): Promise<{
  root: string;
  journalRoot: string;
  guard: ReturnType<typeof createWorkspaceGuard>;
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lfd-doc-root-"));
  const journalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lfd-doc-journal-"));
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

function makeBytes(size: number, fill = "a"): Buffer {
  const unit = Buffer.from(fill, "utf-8");
  if (unit.byteLength === 1) {
    return Buffer.alloc(size, unit[0]);
  }
  const out = Buffer.alloc(size);
  for (let offset = 0; offset < size; ) {
    const take = Math.min(unit.byteLength, size - offset);
    unit.copy(out, offset, 0, take);
    offset += take;
  }
  return out;
}

function contentCoordinator(root: string, journalRoot: string) {
  const adapter = createGuardedNodeAdapter({ allowedRoots: [root] });
  const journal = new LocalDurableMutationJournal({
    rootDir: journalRoot,
    relayId: RELAY,
    fileAdapter: adapter,
  });
  const batches: unknown[] = [];
  const runtime = new DesktopDocumentMutationRuntime({
    getTrustedRelayId: () => RELAY,
    getTrustedHumanId: () => OWNER,
    fileAdapter: adapter,
    journal,
    publishToRenderer: async (batch) => {
      batches.push(batch);
      return "published";
    },
  });
  let operationId = "";
  return {
    journal,
    batches,
    operationId: () => operationId,
    agentContentCommit: async (
      input: Omit<
        Parameters<DesktopDocumentMutationRuntime["commitAgentContent"]>[0],
        "reauthorize"
      >,
    ) => {
      const result = await runtime.commitAgentContent({
        ...input,
        reauthorize: async () => undefined,
      });
      if (result.ok) operationId = result.operationId;
      return result;
    },
  };
}

async function readDocumentViaChunks(
  dispatch: typeof handleLocalFileDispatch,
  opts: {
    root: string;
    journalRoot: string;
    guard: ReturnType<typeof createWorkspaceGuard>;
    relativePath: string;
    expectedSize: number;
  },
): Promise<{ bytes: Buffer; sha256: string; sessionId: string; chunkCount: number }> {
  const sessionId = randomUUID();
  const metaRaw = innerText(
    await dispatch(
      documentReq(
        "read_meta",
        { path: opts.relativePath, sessionId },
        { roots: [opts.root], currentFolder: opts.root },
      ),
      { relayId: RELAY, guard: opts.guard, journalRootDir: opts.journalRoot },
    ),
  );
  const meta = JSON.parse(metaRaw) as {
    sessionId: string;
    totalBytes: number;
    chunkCount: number;
    sha256: string;
  };
  expect(meta.totalBytes).toBe(opts.expectedSize);
  const parts: Buffer[] = [];
  for (let index = 0; index < meta.chunkCount; index += 1) {
    const chunkRaw = innerText(
      await dispatch(
        documentReq(
          "read_chunk",
          {
            path: opts.relativePath,
            sessionId,
            index,
            chunkCount: meta.chunkCount,
            offset: index * RELAY_LOCAL_DOCUMENT_CHUNK_BYTES,
          },
          { roots: [opts.root], currentFolder: opts.root },
        ),
        { relayId: RELAY, guard: opts.guard, journalRootDir: opts.journalRoot },
      ),
    );
    const chunk = JSON.parse(chunkRaw) as { data: string };
    parts.push(Buffer.from(chunk.data, "base64"));
  }
  const bytes = Buffer.concat(parts);
  expect(bytes.byteLength).toBe(meta.totalBytes);
  expect(sha256Hex(bytes)).toBe(meta.sha256);
  return { bytes, sha256: meta.sha256, sessionId, chunkCount: meta.chunkCount };
}

describe("M216 local document transport", () => {
  test("generic file.read cap remains 16 MiB", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const size = RELAY_FS_MAX_BYTES + 1;
      await fs.writeFile(path.join(root, "large.bin"), makeBytes(size));

      const res = await handleLocalFileDispatch(
        fileReadReq("large.bin", { roots: [root], currentFolder: root }),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      expect(res.status).toBe("ok");
      const inner = res.result as { ok: boolean; result: string };
      expect(inner.ok).toBe(true);
      expect(inner.result).toContain(`${RELAY_FS_MAX_BYTES}-byte read cap`);
    } finally {
      await cleanup();
    }
  });

  test("ordered document read succeeds through 50 MiB", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const size = RELAY_LOCAL_DOCUMENT_MAX_BYTES;
      const relativePath = "max-writer-doc.bin";
      await fs.writeFile(path.join(root, relativePath), makeBytes(size, "w"));

      const { bytes } = await readDocumentViaChunks(handleLocalFileDispatch, {
        root,
        journalRoot,
        guard,
        relativePath,
        expectedSize: size,
      });
      expect(bytes.byteLength).toBe(size);
    } finally {
      await cleanup();
    }
  }, 120_000);

  test("retires complete reads while rejecting an early final chunk", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const size = RELAY_FS_MAX_BYTES + 1;
      const relativePath = "sequential-large.bin";
      await fs.writeFile(path.join(root, relativePath), makeBytes(size, "r"));

      const earlySessionId = randomUUID();
      const earlyMeta = JSON.parse(
        innerText(
          await handleLocalFileDispatch(
            documentReq(
              "read_meta",
              { path: relativePath, sessionId: earlySessionId },
              { roots: [root], currentFolder: root },
            ),
            { relayId: RELAY, guard, journalRootDir: journalRoot },
          ),
        ),
      ) as { chunkCount: number };
      const finalIndex = earlyMeta.chunkCount - 1;
      const earlyFinal = JSON.parse(
        innerText(
          await handleLocalFileDispatch(
            documentReq(
              "read_chunk",
              {
                path: relativePath,
                sessionId: earlySessionId,
                index: finalIndex,
                chunkCount: earlyMeta.chunkCount,
                offset: finalIndex * RELAY_LOCAL_DOCUMENT_CHUNK_BYTES,
              },
              { roots: [root], currentFolder: root },
            ),
            { relayId: RELAY, guard, journalRootDir: journalRoot },
          ),
        ),
      ) as { error: string };
      expect(earlyFinal.error).toBe("invalid_chunk");

      const firstAfterEarlyFinal = JSON.parse(
        innerText(
          await handleLocalFileDispatch(
            documentReq(
              "read_chunk",
              {
                path: relativePath,
                sessionId: earlySessionId,
                index: 0,
                chunkCount: earlyMeta.chunkCount,
                offset: 0,
              },
              { roots: [root], currentFolder: root },
            ),
            { relayId: RELAY, guard, journalRootDir: journalRoot },
          ),
        ),
      ) as { index: number };
      expect(firstAfterEarlyFinal.index).toBe(0);
      resetDocumentTransferSessionsForTests();

      for (let readNumber = 0; readNumber < 5; readNumber += 1) {
        const completed = await readDocumentViaChunks(handleLocalFileDispatch, {
          root,
          journalRoot,
          guard,
          relativePath,
          expectedSize: size,
        });
        expect(completed.bytes).toEqual(makeBytes(size, "r"));

        const afterCompletion = JSON.parse(
          innerText(
            await handleLocalFileDispatch(
              documentReq(
                "read_chunk",
                {
                  path: relativePath,
                  sessionId: completed.sessionId,
                  index: completed.chunkCount - 1,
                  chunkCount: completed.chunkCount,
                  offset: (completed.chunkCount - 1) * RELAY_LOCAL_DOCUMENT_CHUNK_BYTES,
                },
                { roots: [root], currentFolder: root },
              ),
              { relayId: RELAY, guard, journalRootDir: journalRoot },
            ),
          ),
        ) as { error: string };
        expect(afterCompletion.error).toBe("invalid_session");
      }
    } finally {
      await cleanup();
    }
  }, 120_000);

  test("rejects malformed, out-of-order, oversize, and SHA-mismatch transfers", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const size = RELAY_FS_MAX_BYTES + 64 * 1024;
      const relativePath = "chunked.bin";
      const target = path.join(root, relativePath);
      const initial = makeBytes(size, "x");
      await fs.writeFile(target, initial);
      const expectedSha256 = sha256Hex(initial);

      const sessionId = randomUUID();
      const meta = JSON.parse(
        innerText(
          await handleLocalFileDispatch(
            documentReq(
              "read_meta",
              { path: relativePath, sessionId },
              { roots: [root], currentFolder: root },
            ),
            { relayId: RELAY, guard, journalRootDir: journalRoot },
          ),
        ),
      ) as { chunkCount: number };

      const writeSessionBadOrder = randomUUID();
      innerText(
        await handleLocalFileDispatch(
          documentReq(
            "write_begin",
            {
              path: relativePath,
              sessionId: writeSessionBadOrder,
              totalBytes: size,
              chunkCount: meta.chunkCount,
              expectedSha256,
            },
            { roots: [root], currentFolder: root, approvalObtained: true },
          ),
          { relayId: RELAY, guard, journalRootDir: journalRoot },
        ),
      );

      const badOrder = innerText(
        await handleLocalFileDispatch(
          documentReq(
            "write_chunk",
            {
              path: relativePath,
              sessionId: writeSessionBadOrder,
              index: 1,
              chunkCount: meta.chunkCount,
              offset: RELAY_LOCAL_DOCUMENT_CHUNK_BYTES,
              data: Buffer.alloc(RELAY_LOCAL_DOCUMENT_CHUNK_BYTES, "z").toString("base64"),
            },
            { roots: [root], currentFolder: root, approvalObtained: true },
          ),
          { relayId: RELAY, guard, journalRootDir: journalRoot },
        ),
      );
      expect(JSON.parse(badOrder).error).toBe("out_of_order_chunk");
      expect(await fs.readFile(target)).toEqual(initial);

      await fs.writeFile(path.join(root, "oversize.bin"), makeBytes(RELAY_LOCAL_DOCUMENT_MAX_BYTES + 1));
      const oversize = innerText(
        await handleLocalFileDispatch(
          documentReq(
            "read_meta",
            { path: "oversize.bin", sessionId: randomUUID() },
            { roots: [root], currentFolder: root },
          ),
          { relayId: RELAY, guard, journalRootDir: journalRoot },
        ),
      );
      expect(JSON.parse(oversize).error).toBe("document_too_large");

      const writeSessionId = randomUUID();
      const nextContent = makeBytes(size, "y");
      const nextSha = sha256Hex(nextContent);
      innerText(
        await handleLocalFileDispatch(
          documentReq(
            "write_begin",
            {
              path: relativePath,
              sessionId: writeSessionId,
              totalBytes: nextContent.byteLength,
              chunkCount: Math.ceil(nextContent.byteLength / RELAY_LOCAL_DOCUMENT_CHUNK_BYTES),
              expectedSha256,
            },
            { roots: [root], currentFolder: root, approvalObtained: true },
          ),
          { relayId: RELAY, guard, journalRootDir: journalRoot },
        ),
      );

      for (let index = 0; index < Math.ceil(nextContent.byteLength / RELAY_LOCAL_DOCUMENT_CHUNK_BYTES); index += 1) {
        const offset = index * RELAY_LOCAL_DOCUMENT_CHUNK_BYTES;
        const slice = nextContent.subarray(
          offset,
          Math.min(nextContent.byteLength, offset + RELAY_LOCAL_DOCUMENT_CHUNK_BYTES),
        );
        innerText(
          await handleLocalFileDispatch(
            documentReq(
              "write_chunk",
              {
                path: relativePath,
                sessionId: writeSessionId,
                index,
                chunkCount: Math.ceil(nextContent.byteLength / RELAY_LOCAL_DOCUMENT_CHUNK_BYTES),
                offset,
                data: slice.toString("base64"),
              },
              { roots: [root], currentFolder: root, approvalObtained: true },
            ),
            { relayId: RELAY, guard, journalRootDir: journalRoot },
          ),
        );
      }

      const shaMismatch = innerText(
        await handleLocalFileDispatch(
          documentReq(
            "write_commit",
            {
              path: relativePath,
              sessionId: writeSessionId,
              totalBytes: nextContent.byteLength,
              chunkCount: Math.ceil(nextContent.byteLength / RELAY_LOCAL_DOCUMENT_CHUNK_BYTES),
              expectedSha256,
              sha256: "0".repeat(64),
            },
            { roots: [root], currentFolder: root, approvalObtained: true },
          ),
          { relayId: RELAY, guard, journalRootDir: journalRoot },
        ),
      );
      expect(JSON.parse(shaMismatch).error).toBe("sha256_mismatch");
      expect(await fs.readFile(target)).toEqual(initial);
      await expect(
        fs.access(path.join(os.tmpdir(), "nautilo-document-staging", `${writeSessionId}.part`)),
      ).rejects.toThrow();

      const listRes = await handleLocalFileDispatch(
        {
          correlationId: "list",
          toolName: "local-file",
          executionClass: "local-file",
          impact: "read-only",
          approvalObtained: false,
          allowedRoots: [root],
          args: {
            operation: {
              kind: "history",
              command: "list_revisions",
              args: { _routing: routing({ currentFolder: root }) },
            },
            allowedRoots: [root],
          },
        },
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      const revisions = JSON.parse(innerText(listRes) as string) as { revisions: unknown[] };
      expect(revisions.revisions).toHaveLength(0);
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("interrupted staging leaves canonical/history intact and cleans temp", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const size = RELAY_FS_MAX_BYTES + 256 * 1024;
      const relativePath = "stage-abort.bin";
      const target = path.join(root, relativePath);
      const initial = makeBytes(size, "s");
      await fs.writeFile(target, initial);
      const expectedSha256 = sha256Hex(initial);
      const sessionId = randomUUID();
      const chunkCount = Math.ceil(size / RELAY_LOCAL_DOCUMENT_CHUNK_BYTES);

      innerText(
        await handleLocalFileDispatch(
          documentReq(
            "write_begin",
            {
              path: relativePath,
              sessionId,
              totalBytes: size,
              chunkCount,
              expectedSha256,
            },
            { roots: [root], currentFolder: root, approvalObtained: true },
          ),
          { relayId: RELAY, guard, journalRootDir: journalRoot },
        ),
      );

      const firstSlice = initial.subarray(0, RELAY_LOCAL_DOCUMENT_CHUNK_BYTES);
      innerText(
        await handleLocalFileDispatch(
          documentReq(
            "write_chunk",
            {
              path: relativePath,
              sessionId,
              index: 0,
              chunkCount,
              offset: 0,
              data: firstSlice.toString("base64"),
            },
            { roots: [root], currentFolder: root, approvalObtained: true },
          ),
          { relayId: RELAY, guard, journalRootDir: journalRoot },
        ),
      );

      innerText(
        await handleLocalFileDispatch(
          documentReq("write_abort", { path: relativePath, sessionId }, {
            roots: [root],
            currentFolder: root,
            approvalObtained: true,
          }),
          { relayId: RELAY, guard, journalRootDir: journalRoot },
        ),
      );

      expect(await fs.readFile(target)).toEqual(initial);
      const stagingEntries = await fs.readdir(path.join(os.tmpdir(), "nautilo-document-staging"));
      expect(stagingEntries.some((name) => name.includes(sessionId))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("terminal write failures retire staging and interrupted writes expire by TTL", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    const realNow = Date.now;
    try {
      const size = RELAY_FS_MAX_BYTES + 1;
      const relativePath = "write-cleanup.bin";
      const initial = makeBytes(size, "q");
      await fs.writeFile(path.join(root, relativePath), initial);
      const expectedSha256 = sha256Hex(initial);
      const chunkCount = Math.ceil(size / RELAY_LOCAL_DOCUMENT_CHUNK_BYTES);

      for (let failureNumber = 0; failureNumber < 5; failureNumber += 1) {
        const sessionId = randomUUID();
        const begin = JSON.parse(
          innerText(
            await handleLocalFileDispatch(
              documentReq(
                "write_begin",
                { path: relativePath, sessionId, totalBytes: size, chunkCount, expectedSha256 },
                { roots: [root], currentFolder: root, approvalObtained: true },
              ),
              { relayId: RELAY, guard, journalRootDir: journalRoot },
            ),
          ),
        ) as { sessionId: string };
        expect(begin.sessionId).toBe(sessionId);

        const malformed = JSON.parse(
          innerText(
            await handleLocalFileDispatch(
              documentReq(
                "write_chunk",
                {
                  path: relativePath,
                  sessionId,
                  index: 0,
                  chunkCount,
                  offset: 0,
                  data: "",
                },
                { roots: [root], currentFolder: root, approvalObtained: true },
              ),
              { relayId: RELAY, guard, journalRootDir: journalRoot },
            ),
          ),
        ) as { error: string };
        expect(malformed.error).toBe("malformed_chunk");
        await expect(
          fs.access(path.join(os.tmpdir(), "nautilo-document-staging", `${sessionId}.part`)),
        ).rejects.toThrow();
      }

      let now = realNow();
      Date.now = () => now;
      const interruptedSessionId = randomUUID();
      innerText(
        await handleLocalFileDispatch(
          documentReq(
            "write_begin",
            {
              path: relativePath,
              sessionId: interruptedSessionId,
              totalBytes: size,
              chunkCount,
              expectedSha256,
            },
            { roots: [root], currentFolder: root, approvalObtained: true },
          ),
          { relayId: RELAY, guard, journalRootDir: journalRoot },
        ),
      );
      innerText(
        await handleLocalFileDispatch(
          documentReq(
            "write_chunk",
            {
              path: relativePath,
              sessionId: interruptedSessionId,
              index: 0,
              chunkCount,
              offset: 0,
              data: initial.subarray(0, RELAY_LOCAL_DOCUMENT_CHUNK_BYTES).toString("base64"),
            },
            { roots: [root], currentFolder: root, approvalObtained: true },
          ),
          { relayId: RELAY, guard, journalRootDir: journalRoot },
        ),
      );

      now += RELAY_LOCAL_DOCUMENT_TRANSFER_TTL_MS + 1;
      const expiredAbort = JSON.parse(
        innerText(
          await handleLocalFileDispatch(
            documentReq(
              "write_abort",
              { path: relativePath, sessionId: interruptedSessionId },
              { roots: [root], currentFolder: root, approvalObtained: true },
            ),
            { relayId: RELAY, guard, journalRootDir: journalRoot },
          ),
        ),
      ) as { aborted: boolean };
      expect(expiredAbort.aborted).toBe(true);
      await expect(
        fs.access(path.join(os.tmpdir(), "nautilo-document-staging", `${interruptedSessionId}.part`)),
      ).rejects.toThrow();
    } finally {
      Date.now = realNow;
      await cleanup();
    }
  }, 60_000);

  test("document write commit journals once and preserves clientMutationId for host bridge", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    const coordinator = contentCoordinator(root, journalRoot);
    try {
      const size = RELAY_FS_MAX_BYTES + 128 * 1024;
      const relativePath = "accept-large.bin";
      const target = path.join(root, relativePath);
      const initial = makeBytes(size, "b");
      await fs.writeFile(target, initial);
      const expectedSha256 = sha256Hex(initial);
      const nextContent = makeBytes(size, "c");
      const nextSha = sha256Hex(nextContent);
      const sessionId = randomUUID();
      const chunkCount = Math.ceil(size / RELAY_LOCAL_DOCUMENT_CHUNK_BYTES);

      innerText(
        await handleLocalFileDispatch(
          documentReq(
            "write_begin",
            {
              path: relativePath,
              sessionId,
              totalBytes: size,
              chunkCount,
              expectedSha256,
              clientMutationId: "accept-chunk-99",
            },
            { roots: [root], currentFolder: root, approvalObtained: true },
          ),
          { relayId: RELAY, guard, journalRootDir: journalRoot },
        ),
      );

      for (let index = 0; index < chunkCount; index += 1) {
        const offset = index * RELAY_LOCAL_DOCUMENT_CHUNK_BYTES;
        const slice = nextContent.subarray(offset, Math.min(size, offset + RELAY_LOCAL_DOCUMENT_CHUNK_BYTES));
        innerText(
          await handleLocalFileDispatch(
            documentReq(
              "write_chunk",
              {
                path: relativePath,
                sessionId,
                index,
                chunkCount,
                offset,
                data: slice.toString("base64"),
              },
              { roots: [root], currentFolder: root, approvalObtained: true },
            ),
            { relayId: RELAY, guard, journalRootDir: journalRoot },
          ),
        );
      }

      const commitRaw = innerText(
        await handleLocalFileDispatch(
          documentReq(
            "write_commit",
            {
              path: relativePath,
              sessionId,
              totalBytes: size,
              chunkCount,
              expectedSha256,
              sha256: nextSha,
              clientMutationId: "accept-chunk-99",
            },
            { roots: [root], currentFolder: root, approvalObtained: true },
          ),
          {
            relayId: RELAY,
            guard,
            journalRootDir: journalRoot,
            agentContentCommit: coordinator.agentContentCommit,
          },
        ),
      );
      const body = JSON.parse(commitRaw) as {
        applied: boolean;
        revisionId: string;
        sha256: string;
      };
      expect(body.applied).toBe(true);
      expect(body.revisionId.startsWith(`local:${RELAY}:`)).toBe(true);
      expect(body.sha256).toBe(nextSha);
      expect(await fs.readFile(target)).toEqual(nextContent);
      await expect(
        fs.access(path.join(os.tmpdir(), "nautilo-document-staging", `${sessionId}.part`)),
      ).rejects.toThrow();

      expect(await coordinator.journal.lookupOperation(coordinator.operationId())).toMatchObject({
        intent: {
          state: "committed",
          paths: [{ revisionIds: [expect.any(String)] }],
        },
      });
      for (
        let attempt = 0;
        attempt < 50 && coordinator.batches.length === 0;
        attempt += 1
      ) {
        await Bun.sleep(5);
      }
      expect(coordinator.batches).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  test("guarded single-message write still works at or below 16 MiB", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    const coordinator = contentCoordinator(root, journalRoot);
    try {
      const initial = "small doc\n";
      const target = path.join(root, "small.md");
      await fs.writeFile(target, initial);
      const expectedSha256 = sha256Hex(Buffer.from(initial, "utf-8"));
      const accepted = "accepted small\n";

      const res = await handleLocalFileDispatch(
        {
          correlationId: "small-write",
          toolName: "local-file",
          executionClass: "local-file",
          impact: "high",
          approvalObtained: true,
          allowedRoots: [root],
          args: {
            operation: {
              kind: "file",
              command: "write",
              zone: "current",
              args: {
                path: "small.md",
                content: accepted,
                expectedSha256,
                _routing: routing({ currentFolder: root }),
              },
            },
            allowedRoots: [root],
          },
        },
        {
          relayId: RELAY,
          guard,
          journalRootDir: journalRoot,
          agentContentCommit: coordinator.agentContentCommit,
        },
      );
      const body = JSON.parse(innerText(res) as string) as { applied: boolean; sha256: string };
      expect(body.applied).toBe(true);
      expect(body.sha256).toBe(sha256Hex(Buffer.from(accepted, "utf-8")));
    } finally {
      await cleanup();
    }
  });

  test("explicit chunk commit retry replays before requiring an expired staging session", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const target = path.join(root, "retry.bin");
      await fs.writeFile(target, "after");
      const request = documentReq(
        "write_commit",
        {
          path: "retry.bin",
          sessionId: "expired-session",
          totalBytes: 5,
          chunkCount: 1,
          expectedSha256: sha256Hex(Buffer.from("before")),
          sha256: sha256Hex(Buffer.from("after")),
        },
        { roots: [root], currentFolder: root, approvalObtained: true },
      );
      const operation = (request.args as {
        operation: { args: Record<string, unknown> };
      }).operation;
      operation.args["_routing"] = {
        ...routing({ currentFolder: root }),
        mutationRequestId: "d448:chunk-retry:semantic",
        mutationRetry: true,
      };
      let replayCalls = 0;
      const response = innerText(await handleLocalFileDispatch(request, {
        relayId: RELAY,
        guard,
        journalRootDir: journalRoot,
        agentContentCommit: async (input) => {
          expect(input.replayOnly).toBe(true);
          replayCalls += 1;
          return {
            ok: true,
            revisionId: "chunk-retry-revision",
            sha256: sha256Hex(Buffer.from("after")),
            before: Buffer.from("before"),
            after: Buffer.from("after"),
          };
        },
      }));
      expect(JSON.parse(response)).toMatchObject({
        applied: true,
        revisionId: `local:${RELAY}:chunk-retry-revision`,
      });
      expect(replayCalls).toBe(1);
    } finally {
      await cleanup();
    }
  });
});
