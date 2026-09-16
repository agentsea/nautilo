/**
 * D448 local document mutation boundaries. Phase 11 replaces the ordinary
 * agent content lane with the process-scoped coordinator while retaining the
 * renderer editor characterization until its independent IPC boundary.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  createWorkspaceGuard,
  type RelayDispatchRequest,
  type RelayFsChangeEvent,
} from "@nautilo/relay";
import {
  decideFsWrite,
  sha256Hex as editorSha256,
  writeFileAtomically,
} from "../../electron/fs-write.ts";
import { createGuardedNodeAdapter } from "../../electron/local-file-history/file-adapter.ts";
import { LocalDurableMutationJournal } from "../../electron/local-file-history/durable-mutations.ts";
import { LocalFileHistoryJournal } from "../../electron/local-file-history/journal.ts";
import { DesktopDocumentMutationRuntime } from "../../electron/document-mutations/desktop-document-mutation-runtime.ts";

let mockedHistoryRoot = "";

mock.module("electron", () => ({
  app: {
    getPath: () => os.tmpdir(),
    isPackaged: false,
  },
}));

mock.module("../../electron/paths", () => ({
  localFileHistoryDirPath: () => mockedHistoryRoot,
}));

let handleLocalFileDispatch: typeof import("../../electron/local-file-dispatch/index.ts").handleLocalFileDispatch;

beforeAll(async () => {
  mockedHistoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "d448-characterization-history-"));
  ({ handleLocalFileDispatch } = await import("../../electron/local-file-dispatch/index.ts"));
});

afterAll(async () => {
  if (mockedHistoryRoot) {
    await fs.rm(mockedHistoryRoot, { recursive: true, force: true });
  }
});

const OWNER = "00000000-0000-4000-8000-000000000441";
const AGENT = "00000000-0000-4000-8000-000000000442";
const RELAY = "relay-d448-characterization";

function routing(root: string, turnId: string) {
  return {
    ownerId: OWNER,
    agentId: AGENT,
    turnId,
    mutationRequestId: `d448:${turnId}:test-semantics`,
    currentFolder: root,
    workspaceRoot: "",
  };
}

function localFileRequest(input: {
  root: string;
  operation: Record<string, unknown>;
  approvalObtained?: boolean;
}): RelayDispatchRequest {
  return {
    correlationId: "d448-characterization",
    toolName: "local-file",
    executionClass: "local-file",
    impact: "high",
    approvalObtained: input.approvalObtained ?? true,
    allowedRoots: [input.root],
    args: {
      operation: input.operation,
      allowedRoots: [input.root],
    },
  };
}

function typedWrite(root: string, relativePath: string, content: string, turnId: string): RelayDispatchRequest {
  return localFileRequest({
    root,
    operation: {
      kind: "file",
      command: "write",
      zone: "current",
      args: { path: relativePath, content, _routing: routing(root, turnId) },
    },
  });
}

function dispatchText(result: Awaited<ReturnType<typeof handleLocalFileDispatch>>): string {
  expect(result.status).toBe("ok");
  const envelope = result.result as { ok: boolean; result?: unknown; message?: unknown };
  expect(envelope.ok).toBe(true);
  expect(typeof envelope.result).toBe("string");
  return envelope.result as string;
}

async function fixture(): Promise<{
  root: string;
  journalRoot: string;
  guard: ReturnType<typeof createWorkspaceGuard>;
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "d448-characterization-root-"));
  const journalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "d448-characterization-journal-"));
  return {
    root,
    journalRoot,
    guard: createWorkspaceGuard({ allowedRoots: [root] }),
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(journalRoot, { recursive: true, force: true });
    },
  };
}

describe("D448 local document mutation characterization", () => {
  test("editor-style SHA-CAS direct primitive changes bytes but has no journal or event hook", async () => {
    const { root, journalRoot, cleanup } = await fixture();
    try {
      const target = path.join(root, "editor.txt");
      await fs.writeFile(target, "editor base\n");
      const baseSha256 = editorSha256(Buffer.from("editor base\n"));
      const next = Buffer.from("human editor save\n");

      // main.ts's fs:writeFile IPC handler is not exported and requires a
      // running Electron main process. These are its exact pure CAS decision
      // and same-directory atomic write primitives. Neither primitive accepts
      // an event callback or journal dependency; sender/root validation is
      // intentionally outside this isolated characterization.
      expect(
        decideFsWrite({
          targetPath: target,
          allowed: true,
          baseSha256,
          currentSha256: editorSha256(await fs.readFile(target)),
          contentBytes: next.byteLength,
        }),
      ).toEqual({ ok: true });
      await writeFileAtomically(target, next, {
        writeFile: async (filePath, bytes) => await fs.writeFile(filePath, bytes),
        rename: async (from, to) => await fs.rename(from, to),
        unlink: async (filePath) => await fs.unlink(filePath),
      });

      expect(await fs.readFile(target, "utf8")).toBe("human editor save\n");
      const journal = new LocalFileHistoryJournal({
        rootDir: journalRoot,
        relayId: RELAY,
        fileAdapter: createGuardedNodeAdapter({ allowedRoots: [root] }),
      });
      await journal.init();
      expect(journal.entryCount()).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("typed relay content mutation has one coordinator/V2 journal/outbox path and no generic duplicate event", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    const events: RelayFsChangeEvent[] = [];
    try {
      const adapter = createGuardedNodeAdapter({ allowedRoots: [root] });
      const durableJournal = new LocalDurableMutationJournal({
        rootDir: journalRoot,
        relayId: RELAY,
        fileAdapter: adapter,
      });
      const batches: unknown[] = [];
      const runtime = new DesktopDocumentMutationRuntime({
        getTrustedRelayId: () => RELAY,
        getTrustedHumanId: () => OWNER,
        fileAdapter: adapter,
        journal: durableJournal,
        publishToRenderer: async (batch) => {
          batches.push(batch);
          return "published";
        },
      });
      let committedOperationId = "";
      const payload = JSON.parse(
        dispatchText(
          await handleLocalFileDispatch(typedWrite(root, "relay.txt", "agent write\n", "turn-relay-write"), {
            relayId: RELAY,
            guard,
            journalRootDir: journalRoot,
            onFsChange: (event) => events.push(event),
            agentContentCommit: async (input) => {
              const result = await runtime.commitAgentContent({
                ...input,
                reauthorize: async () => undefined,
              });
              if (result.ok) committedOperationId = result.operationId;
              return result;
            },
          }),
        ),
      ) as { applied: boolean; revisionId: string };

      expect(payload.applied).toBe(true);
      expect(payload.revisionId.startsWith(`local:${RELAY}:`)).toBe(true);
      expect(await fs.readFile(path.join(root, "relay.txt"), "utf8")).toBe("agent write\n");
      expect(events).toEqual([]);

      const journal = new LocalFileHistoryJournal({
        rootDir: journalRoot,
        relayId: RELAY,
        fileAdapter: createGuardedNodeAdapter({ allowedRoots: [root] }),
      });
      await journal.init();
      expect(journal.entryCount()).toBe(0);
      expect(await durableJournal.lookupOperation(committedOperationId)).toMatchObject({
        intent: {
          state: "committed",
          actor: { kind: "agent", agentId: AGENT },
          paths: [{ revisionIds: [expect.any(String)] }],
        },
      });
      for (let attempt = 0; attempt < 50 && batches.length === 0; attempt += 1) {
        await Bun.sleep(5);
      }
      expect(batches).toHaveLength(1);
      expect(batches[0]).toMatchObject({
        operationId: committedOperationId,
        events: [{
          type: "document.mutation.committed",
          mutation: "create",
          after: { sha256: editorSha256(Buffer.from("agent write\n")) },
        }],
      });
    } finally {
      await cleanup();
    }
  });

  test.each([
    {
      code: "human_edit_conflict" as const,
      message: "A local file has an overlapping active human edit.",
    },
    {
      code: "reapply_required" as const,
      message: "A local human edit changed during admission.",
    },
  ])("preserves $code as a non-blind-retry relay envelope", async ({ code, message }) => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const target = path.join(root, "conflict.txt");
      await fs.writeFile(target, "human bytes\n");
      const response = JSON.parse(dispatchText(await handleLocalFileDispatch(
        typedWrite(root, "conflict.txt", "agent bytes\n", `turn-${code}`),
        {
          relayId: RELAY,
          guard,
          journalRootDir: journalRoot,
          agentContentCommit: async () => ({
            ok: false,
            code,
            message,
          }),
        },
      ))) as {
        error: string;
        message: string;
        retryable: boolean;
        hint: string;
      };
      expect(response).toMatchObject({
        error: code,
        message,
        retryable: false,
      });
      expect(response.hint).toContain("do not blindly retry");
      expect(await fs.readFile(target, "utf8")).toBe("human bytes\n");
    } finally {
      await cleanup();
    }
  });

  test("insert and str_replace route their computed postimages through the coordinator seam", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const target = path.join(root, "text.txt");
      await fs.writeFile(target, "one\ntwo");
      const commands: string[] = [];
      const agentContentCommit = async (input: {
        targetPath: string;
        before: Uint8Array | null;
        after: Uint8Array;
        command: string;
      }) => {
        commands.push(input.command);
        await fs.writeFile(input.targetPath, input.after);
        return {
          ok: true as const,
          revisionId: randomUUID(),
          sha256: editorSha256(input.after),
          before: input.before,
          after: input.after,
        };
      };
      const dispatch = async (
        command: "insert" | "str_replace",
        args: Record<string, unknown>,
      ) => dispatchText(await handleLocalFileDispatch(localFileRequest({
        root,
        operation: {
          kind: "file",
          command,
          zone: "current",
          args: {
            path: "text.txt",
            ...args,
            _routing: routing(root, `turn-${command}`),
          },
        },
      }), {
        relayId: RELAY,
        guard,
        journalRootDir: journalRoot,
        agentContentCommit,
      }));

      expect(JSON.parse(await dispatch("insert", {
        lineNumber: 2,
        content: "middle",
      }))).toMatchObject({ applied: true, command: "insert" });
      expect(await fs.readFile(target, "utf8")).toBe("one\nmiddle\ntwo");
      expect(JSON.parse(await dispatch("str_replace", {
        oldString: "middle",
        newString: "changed",
      }))).toMatchObject({ applied: true, command: "str_replace" });
      expect(await fs.readFile(target, "utf8")).toBe("one\nchanged\ntwo");
      expect(commands).toEqual(["insert", "str_replace"]);
    } finally {
      await cleanup();
    }
  });

  test("explicit str_replace retry replays before matching the already-replaced postimage", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const replacement = path.join(root, "replacement.txt");
      await fs.writeFile(replacement, "unrelated\n");
      await fs.symlink(replacement, path.join(root, "retry.txt"));
      let replayCalls = 0;
      const request = localFileRequest({
        root,
        operation: {
          kind: "file",
          command: "str_replace",
          zone: "current",
          args: {
            path: "retry.txt",
            oldString: "before",
            newString: "changed",
            _routing: {
              ...routing(root, "turn-retry"),
              mutationRequestId: "d448:retry:semantic",
              mutationRetry: true,
            },
          },
        },
      });
      const output = dispatchText(await handleLocalFileDispatch(request, {
        relayId: RELAY,
        guard,
        journalRootDir: journalRoot,
        agentContentCommit: async (input) => {
          expect(input.replayOnly).toBe(true);
          replayCalls += 1;
          return {
            ok: true,
            revisionId: "retry-revision",
            sha256: editorSha256(Buffer.from("changed\n")),
            before: Buffer.from("before\n"),
            after: Buffer.from("changed\n"),
          };
        },
      }));
      expect(JSON.parse(output)).toMatchObject({
        applied: true,
        revisionId: `local:${RELAY}:retry-revision`,
      });
      expect(replayCalls).toBe(1);
    } finally {
      await cleanup();
    }
  });

});
