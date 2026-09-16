import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createWorkspaceGuard } from "@nautilo/relay";
import type { RelayDispatchRequest } from "@nautilo/relay";
import { DesktopDocumentMutationRuntime } from "../../electron/document-mutations/desktop-document-mutation-runtime.ts";
import { createGuardedNodeAdapter } from "../../electron/local-file-history/file-adapter.ts";
import { LocalDurableMutationJournal } from "../../electron/local-file-history/durable-mutations.ts";

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
  mockLocalFileHistoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "lfd-bookend-history-mock-"));
  const imported = await import("../../electron/local-file-dispatch/index.ts");
  handleLocalFileDispatch = (async (request, options) => {
    const adapter = createGuardedNodeAdapter({
      allowedRoots: request.allowedRoots ?? [],
    });
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
const RELAY = "relay-bookend-test";

function routing(extra: Record<string, unknown> = {}) {
  const mutationRequestId = `local-dispatch-bookend-${crypto.randomUUID()}`;
  return {
    ownerId: OWNER,
    agentId: AGENT,
    turnId: "turn-bookend",
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lfd-bookend-"));
  const journalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lfd-bookend-journal-"));
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

function strReplaceOp(
  root: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: "file",
    command: "str_replace",
    zone: "current",
    args: { ...args, _routing: routing({ currentFolder: root }) },
  };
}

function readResOk(res: { status: string; result?: unknown; error?: string }): string {
  expect(res.status).toBe("ok");
  const inner = res.result as { ok: boolean; result: string };
  expect(inner.ok).toBe(true);
  return inner.result;
}

function readResErr(res: { status: string; result?: unknown; error?: string }): string {
  expect(res.status).toBe("ok");
  const inner = res.result as { ok: boolean; result: string };
  expect(inner.ok).toBe(true);
  return inner.result;
}

describe("handleLocalFileDispatch str_replace bookend (M206)", () => {
  test("bookend mode replaces span between fragments", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const content = [
        "export function foo() {",
        "  const x = 1;",
        "  return x;",
        "} // end foo",
        "",
      ].join("\n");
      await fs.writeFile(path.join(root, "module.ts"), content);

      const res = await handleLocalFileDispatch(
        localFileReq(
          strReplaceOp(root, {
            path: "module.ts",
            startFragment: "export function foo() {",
            endFragment: "} // end foo",
            newString: "export function foo() {\n  return 42;\n} // end foo",
          }),
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      const json = JSON.parse(readResOk(res)) as { applied: boolean; revisionId: string };
      expect(json.applied).toBe(true);
      expect(json.revisionId.startsWith(`local:${RELAY}:`)).toBe(true);

      const disk = await fs.readFile(path.join(root, "module.ts"), "utf-8");
      expect(disk).toBe("export function foo() {\n  return 42;\n} // end foo\n");
      expect(disk).not.toContain("const x = 1");
    } finally {
      await cleanup();
    }
  });

  test("rejects partial bookend (only startFragment)", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      await fs.writeFile(path.join(root, "x.txt"), "alpha beta gamma");

      const res = await handleLocalFileDispatch(
        localFileReq(
          strReplaceOp(root, {
            path: "x.txt",
            startFragment: "alpha",
            newString: "replaced",
          }),
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      const body = readResErr(res);
      expect(body).toContain("Bookend mode requires BOTH startFragment and endFragment");
      expect(await fs.readFile(path.join(root, "x.txt"), "utf-8")).toBe("alpha beta gamma");
    } finally {
      await cleanup();
    }
  });

  test("rejects missing startFragment match", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      await fs.writeFile(path.join(root, "x.txt"), "one two three");

      const res = await handleLocalFileDispatch(
        localFileReq(
          strReplaceOp(root, {
            path: "x.txt",
            startFragment: "missing",
            endFragment: "three",
            newString: "new",
          }),
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      const body = readResErr(res);
      expect(body).toContain("Could not find startFragment");
      expect(await fs.readFile(path.join(root, "x.txt"), "utf-8")).toBe("one two three");
    } finally {
      await cleanup();
    }
  });

  test("rejects ambiguous startFragment (multiple matches)", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      await fs.writeFile(path.join(root, "x.txt"), "BEGIN a END BEGIN b END");

      const res = await handleLocalFileDispatch(
        localFileReq(
          strReplaceOp(root, {
            path: "x.txt",
            startFragment: "BEGIN",
            endFragment: "END",
            newString: "REPLACED",
          }),
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      const body = readResErr(res);
      expect(body).toContain("startFragment matches more than once");
      expect(await fs.readFile(path.join(root, "x.txt"), "utf-8")).toBe("BEGIN a END BEGIN b END");
    } finally {
      await cleanup();
    }
  });

  test("rejects reversed bookend order", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      await fs.writeFile(path.join(root, "x.txt"), "END middle BEGIN");

      const res = await handleLocalFileDispatch(
        localFileReq(
          strReplaceOp(root, {
            path: "x.txt",
            startFragment: "BEGIN",
            endFragment: "END",
            newString: "new",
          }),
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      const body = readResErr(res);
      expect(body).toContain("bookend order is reversed");
      expect(await fs.readFile(path.join(root, "x.txt"), "utf-8")).toBe("END middle BEGIN");
    } finally {
      await cleanup();
    }
  });

  test("rejects empty bookend fragments", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      await fs.writeFile(path.join(root, "x.txt"), "content");

      const res = await handleLocalFileDispatch(
        localFileReq(
          strReplaceOp(root, {
            path: "x.txt",
            startFragment: "",
            endFragment: "content",
            newString: "new",
          }),
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      const body = readResErr(res);
      expect(body).toContain("Bookend mode requires both startFragment and endFragment");
      expect(await fs.readFile(path.join(root, "x.txt"), "utf-8")).toBe("content");
    } finally {
      await cleanup();
    }
  });

  test("rejects ambiguous multiple disambiguators", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      await fs.writeFile(path.join(root, "x.txt"), "alpha beta");

      const res = await handleLocalFileDispatch(
        localFileReq(
          strReplaceOp(root, {
            path: "x.txt",
            oldString: "alpha",
            startFragment: "alpha",
            endFragment: "beta",
            newString: "new",
          }),
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      const body = readResErr(res);
      expect(body).toContain("Ambiguous — multiple disambiguators");
      expect(await fs.readFile(path.join(root, "x.txt"), "utf-8")).toBe("alpha beta");
    } finally {
      await cleanup();
    }
  });

  test("journal undo restores pre-bookend bytes", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const original = "START\nkeep-me\nEND\n";
      await fs.writeFile(path.join(root, "undo-me.txt"), original);

      const replaceRes = await handleLocalFileDispatch(
        localFileReq(
          strReplaceOp(root, {
            path: "undo-me.txt",
            startFragment: "START",
            endFragment: "END",
            newString: "REPLACED",
          }),
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      const replaceJson = JSON.parse(readResOk(replaceRes)) as { revisionId: string };
      expect(await fs.readFile(path.join(root, "undo-me.txt"), "utf-8")).toBe("REPLACED\n");

      const undoRes = await handleLocalFileDispatch(
        localFileReq(
          {
            kind: "history",
            command: "undo",
            args: {
              zone: "current",
              path: "undo-me.txt",
              revisionId: replaceJson.revisionId,
              _routing: routing({ currentFolder: root }),
            },
          },
          { roots: [root], approvalObtained: true },
        ),
        { relayId: RELAY, guard, journalRootDir: journalRoot },
      );
      const undoJson = JSON.parse(readResOk(undoRes)) as { applied: boolean };
      expect(undoJson.applied).toBe(true);
      expect(await fs.readFile(path.join(root, "undo-me.txt"), "utf-8")).toBe(original);
    } finally {
      await cleanup();
    }
  });
});
