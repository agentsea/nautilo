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

const OWNER = "00000000-0000-4000-8000-000000000001";
const AGENT = "00000000-0000-4000-8000-000000000002";
const RELAY = "relay-line-endings-test";

beforeAll(async () => {
  mockLocalFileHistoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "lfd-eol-history-mock-"));
  const imported = await import("../../electron/local-file-dispatch/index.ts");
  handleLocalFileDispatch = (async (request, options) => {
    const adapter = createGuardedNodeAdapter({ allowedRoots: request.allowedRoots ?? [] });
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
          command: input.command as "write" | "insert" | "str_replace" | "document_write_commit",
          reauthorize: async () => undefined,
        }),
      structuralCommit: (input) => runtime.commitAgentStructural({ ...input, reauthorize: async () => undefined }),
      historyCommit: (input) => runtime.commitHistoryRestore({ ...input, reauthorize: async () => undefined }),
    });
  }) as typeof handleLocalFileDispatch;
});

// Windows can briefly keep a just-written journal directory busy.
async function removeDirectory(directory: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      await fs.rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "EBUSY" && code !== "EPERM") || Date.now() - started > 5_000) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

afterAll(async () => {
  if (mockLocalFileHistoryDir) await removeDirectory(mockLocalFileHistoryDir);
});

async function edit(
  initial: string | undefined,
  command: "str_replace" | "insert" | "write",
  args: Record<string, unknown>,
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lfd-eol-"));
  const journalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lfd-eol-journal-"));
  try {
    const file = path.join(root, "notes.txt");
    if (initial !== undefined) await fs.writeFile(file, initial);
    const request: RelayDispatchRequest = {
      correlationId: "test",
      toolName: "local-file",
      executionClass: "local-file",
      impact: "read-only",
      approvalObtained: true,
      allowedRoots: [root],
      args: {
        operation: {
          kind: "file",
          command,
          zone: "current",
          args: {
            path: "notes.txt",
            ...args,
            _routing: {
              ownerId: OWNER,
              agentId: AGENT,
              turnId: "turn-line-endings",
              currentFolder: root,
              workspaceRoot: "",
              mutationRequestId: `local-dispatch-eol-${crypto.randomUUID()}`,
            },
          },
        },
        allowedRoots: [root],
      },
    };
    const response = await handleLocalFileDispatch(request, {
      relayId: RELAY,
      guard: createWorkspaceGuard({ allowedRoots: [root] }),
      journalRootDir: journalRoot,
    });
    expect(response.status).toBe("ok");
    // Buffer decoding keeps a leading byte order mark as U+FEFF.
    return (await fs.readFile(file)).toString("utf-8");
  } finally {
    await removeDirectory(root);
    await removeDirectory(journalRoot);
  }
}

const BOM = String.fromCharCode(0xfeff);

describe("local file edits keep the file's line endings", () => {
  test("str_replace matches LF text in a CRLF file and writes CRLF", async () => {
    const disk = await edit("one\r\ntwo\r\nthree\r\n", "str_replace", {
      oldString: "one\ntwo",
      newString: "one\nnew\ntwo",
    });
    expect(disk).toBe("one\r\nnew\r\ntwo\r\nthree\r\n");
  });

  test("str_replace bookends and line ranges keep CRLF", async () => {
    expect(await edit("a\r\nb\r\nc\r\n", "str_replace", {
      startFragment: "a\nb",
      endFragment: "c",
      newString: "x\ny",
    })).toBe("x\r\ny\r\n");
    expect(await edit("a\r\nb\r\nc\r\n", "str_replace", {
      lineRange: { from: 2, to: 2 },
      newString: "x\ny",
    })).toBe("a\r\nx\r\ny\r\nc\r\n");
  });

  test("insert adds CRLF lines to a CRLF file", async () => {
    const disk = await edit("a\r\nc\r\n", "insert", { lineNumber: 2, content: "b1\nb2" });
    expect(disk).toBe("a\r\nb1\r\nb2\r\nc\r\n");
  });

  test("write keeps an existing CRLF file in CRLF", async () => {
    expect(await edit("old\r\nfile\r\n", "write", { content: "new\nfile\n" })).toBe("new\r\nfile\r\n");
  });

  test("LF, mixed, and new files are written as edited", async () => {
    expect(await edit("a\nb\n", "str_replace", { oldString: "b", newString: "x\ny" })).toBe("a\nx\ny\n");
    expect(await edit("a\r\nb\nc", "str_replace", { oldString: "b", newString: "x\ny" })).toBe("a\r\nx\ny\nc");
    expect(await edit(undefined, "write", { content: "new\nfile\n" })).toBe("new\nfile\n");
  });
});

describe("local file edits keep a UTF-8 byte order mark", () => {
  const source = `${BOM}using A;\r\nclass B {}\r\n`;

  test("str_replace keeps the mark at the start", async () => {
    expect(await edit(source, "str_replace", { oldString: "using A;\nclass B", newString: "using A;\nusing C;\nclass B" }))
      .toBe(`${BOM}using A;\r\nusing C;\r\nclass B {}\r\n`);
  });

  test("insert at the first line goes after the mark", async () => {
    expect(await edit(source, "insert", { lineNumber: 1, content: "// header" }))
      .toBe(`${BOM}// header\r\nusing A;\r\nclass B {}\r\n`);
  });

  test("write keeps one mark when overwriting, appending, and prepending", async () => {
    expect(await edit(source, "write", { content: "using X;\n" })).toBe(`${BOM}using X;\r\n`);
    expect(await edit(source, "write", { content: `${BOM}using X;\n` })).toBe(`${BOM}using X;\r\n`);
    expect(await edit(source, "write", { content: "// end\n", mode: "append" })).toBe(`${source}// end\r\n`);
    expect(await edit(source, "write", { content: "// top\n", mode: "prepend" }))
      .toBe(`${BOM}// top\r\nusing A;\r\nclass B {}\r\n`);
  });

  test("files without a mark do not gain one", async () => {
    expect(await edit("using A;\n", "write", { content: "using X;\n" })).toBe("using X;\n");
  });
});
