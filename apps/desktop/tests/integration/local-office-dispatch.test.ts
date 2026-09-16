import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createWorkspaceGuard } from "@nautilo/relay";
import type { OfficeCliRunResult } from "@nautilo/config/officecli";
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
  mockLocalFileHistoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "lod-history-mock-"));
  ({ handleLocalFileDispatch } = await import("../../electron/local-file-dispatch/index.ts"));
});

afterAll(async () => {
  if (mockLocalFileHistoryDir) {
    await fs.rm(mockLocalFileHistoryDir, { recursive: true, force: true });
  }
});

const OWNER = "00000000-0000-4000-8000-000000000001";
const AGENT = "00000000-0000-4000-8000-000000000002";
const RELAY = "relay-office-test";
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function routing(extra: Record<string, unknown> = {}) {
  return {
    ownerId: OWNER,
    agentId: AGENT,
    turnId: "turn-1",
    currentFolder: extra["currentFolder"] ?? null,
    workspaceRoot: "",
    ...extra,
  };
}

function officeReq(
  operation: Record<string, unknown>,
  opts: { approvalObtained?: boolean; roots: string[] },
): RelayDispatchRequest {
  return {
    correlationId: "test",
    toolName: "local-file",
    executionClass: "local-file",
    impact: "destructive",
    approvalObtained: opts.approvalObtained ?? false,
    allowedRoots: opts.roots,
    args: { operation: { kind: "office", operation }, allowedRoots: opts.roots },
  };
}

async function fixture(): Promise<{
  root: string;
  journalRoot: string;
  guard: ReturnType<typeof createWorkspaceGuard>;
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "office-root-"));
  const journalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "office-journal-"));
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

function fakeRunner(responses: Record<string, OfficeCliRunResult>): (argv: readonly string[]) => Promise<OfficeCliRunResult> {
  return async (argv) => {
    const key = argv[0] ?? "";
    if (responses[key]) return responses[key];
    return { stdout: JSON.stringify({ ok: true, command: key }), stderr: "", exitCode: 0 };
  };
}

describe("handleLocalFileDispatch — local office (M206 Phase 3)", () => {
  test("rejects mutating officecli without approvalObtained", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const req = officeReq(
        {
          subkind: "officecli",
          zone: "current",
          command: "set",
          payload: { path: "doc.docx", out: "doc.docx", target: "/body/p[1]", props: { text: "x" } },
          _routing: routing({ currentFolder: root }),
        },
        { roots: [root], approvalObtained: false },
      );
      const res = await handleLocalFileDispatch(req, {
        relayId: RELAY,
        guard,
        journalRootDir: journalRoot,
        officeRun: fakeRunner({}),
      });
      expect(res.status).toBe("error");
      expect(res.error).toContain("approvalObtained");
    } finally {
      await cleanup();
    }
  });

  test("rejects malformed office subkind", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const req = officeReq(
        {
          subkind: "shell",
          _routing: routing({ currentFolder: root }),
        },
        { roots: [root], approvalObtained: true },
      );
      const res = await handleLocalFileDispatch(req, {
        relayId: RELAY,
        guard,
        journalRootDir: journalRoot,
        officeRun: fakeRunner({}),
      });
      expect(res.status).toBe("ok");
      const payload = res.result as { ok: boolean; message?: string };
      expect(payload.ok).toBe(false);
      expect(payload.message).toContain("unsupported local office subkind");
    } finally {
      await cleanup();
    }
  });

  test("rejects unsupported officecli command", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const req = officeReq(
        {
          subkind: "officecli",
          zone: "current",
          command: "exec",
          payload: { path: "doc.docx" },
          _routing: routing({ currentFolder: root, turnId: "turn-1" }),
        },
        { roots: [root], approvalObtained: true },
      );
      const res = await handleLocalFileDispatch(req, {
        relayId: RELAY,
        guard,
        journalRootDir: journalRoot,
        officeRun: fakeRunner({}),
      });
      const payload = res.result as { ok: boolean; message?: string };
      expect(payload.ok).toBe(false);
      expect(payload.message).toContain("unsupported or missing officecli command");
    } finally {
      await cleanup();
    }
  });

  test("rejects create data before invoking the local OfficeCLI runner", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    let runnerCalls = 0;
    try {
      const res = await handleLocalFileDispatch(officeReq(
        {
          subkind: "officecli",
          zone: "current",
          command: "create",
          payload: { out: "ignored.docx", data: "# Do not create this" },
          _routing: routing({ currentFolder: root }),
        },
        { roots: [root], approvalObtained: true },
      ), {
        relayId: RELAY,
        guard,
        journalRootDir: journalRoot,
        officeRun: async () => {
          runnerCalls += 1;
          return { stdout: "{}", stderr: "", exitCode: 0 };
        },
      });

      const payload = res.result as { ok: boolean; message?: string };
      expect(res.status).toBe("ok");
      expect(payload.ok).toBe(false);
      expect(payload.message).toContain("`data` is merge-only; use `commands` when creating a document.");
      expect(payload.message).toContain('parent: "/body"');
      expect(runnerCalls).toBe(0);
      const outputExists = await fs.access(path.join(root, "ignored.docx")).then(
        () => true,
        () => false,
      );
      expect(outputExists).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("runs path-inferred local help without treating create as a help verb", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    const calls: string[][] = [];
    try {
      const res = await handleLocalFileDispatch(officeReq(
        {
          subkind: "officecli",
          zone: "current",
          command: "help",
          payload: { path: "reports/brief.docx" },
          _routing: routing({ currentFolder: root }),
        },
        { roots: [root], approvalObtained: true },
      ), {
        relayId: RELAY,
        guard,
        journalRootDir: journalRoot,
        officeRun: async (argv) => {
          calls.push([...argv]);
          return { stdout: "DOCX help", stderr: "", exitCode: 0 };
        },
      });

      expect(res.status).toBe("ok");
      expect(calls).toEqual([["help", "docx", "--json"]]);
      expect(res.result).toEqual({ ok: true, result: "DOCX help" });
    } finally {
      await cleanup();
    }
  });

  test("infers local help format and preserves each nonzero diagnostic fallback", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    const cases: Array<{ response: OfficeCliRunResult; expected: string }> = [
      {
        response: {
          stdout: JSON.stringify({ success: false, error: { error: "error: unknown element 'create' for format 'docx'.\nUse: officecli help docx" } }),
          stderr: "ignored stderr",
          exitCode: 1,
        },
        expected: "Use: officecli help docx",
      },
      { response: { stdout: "not-json", stderr: "stderr-only correction", exitCode: 2 }, expected: "stderr-only correction" },
      { response: { stdout: "", stderr: "", exitCode: 3 }, expected: "exit 3" },
    ];
    try {
      for (const { response, expected } of cases) {
        const calls: string[][] = [];
        const res = await handleLocalFileDispatch(officeReq(
          {
            subkind: "officecli",
            zone: "current",
            command: "help",
            payload: { path: "reports/brief.docx", verb: "create" },
            _routing: routing({ currentFolder: root }),
          },
          { roots: [root], approvalObtained: true },
        ), {
          relayId: RELAY,
          guard,
          journalRootDir: journalRoot,
          officeRun: async (argv) => { calls.push([...argv]); return response; },
        });

        const payload = res.result as { ok: boolean; message?: string };
        expect(res.status).toBe("ok");
        expect(calls).toEqual([["help", "docx", "create", "--json"]]);
        expect(payload.ok).toBe(false);
        expect(payload.message).toContain(expected);
      }
    } finally {
      await cleanup();
    }
  });

  test("officecli create commits staged output through the V2 coordinator", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    const outPath = path.join(root, "new.docx");
    try {
      const run = fakeRunner({
        create: { stdout: JSON.stringify({ ok: true }), stderr: "", exitCode: 0 },
        batch: { stdout: JSON.stringify({ ok: true }), stderr: "", exitCode: 0 },
        close: { stdout: JSON.stringify({ ok: true }), stderr: "", exitCode: 0 },
      });

      const patchedRun = async (argv: readonly string[]): Promise<OfficeCliRunResult> => {
        if (argv[0] === "create" || argv[0] === "batch" || argv[0] === "close") {
          const target = argv[1];
          if (target) {
            await fs.writeFile(target, Buffer.concat([ZIP_MAGIC, Buffer.from("doc-bytes")]));
          }
          return { stdout: JSON.stringify({ ok: true }), stderr: "", exitCode: 0 };
        }
        return run(argv);
      };

      const req = officeReq(
        {
          subkind: "officecli",
          zone: "current",
          command: "create",
          payload: {
            out: "new.docx",
            commands: [{ command: "add", parent: "/", type: "paragraph", props: { text: "hi" } }],
          },
          _routing: routing({ currentFolder: root, turnId: "turn-1" }),
        },
        { roots: [root], approvalObtained: true },
      );

      const adapter = createGuardedNodeAdapter({ allowedRoots: [root] });
      const durableJournal = new LocalDurableMutationJournal({
        rootDir: journalRoot,
        relayId: RELAY,
        fileAdapter: adapter,
      });
      const runtime = new DesktopDocumentMutationRuntime({
        getTrustedRelayId: () => RELAY,
        getTrustedHumanId: () => OWNER,
        fileAdapter: adapter,
        journal: durableJournal,
        publishToRenderer: async () => "published",
      });

      const writeRes = await handleLocalFileDispatch(req, {
        relayId: RELAY,
        guard,
        journalRootDir: journalRoot,
        officeRun: patchedRun,
        officeCliCommit: async (input) => await runtime.commitOfficeCli({
          ...input,
          reauthorize: async () => {},
        }),
      });
      expect(writeRes.status).toBe("ok");
      const payload = writeRes.result as {
        ok: boolean;
        result?: { revisionId?: string; revisionGroupId?: string; operationId?: string };
      };
      expect(payload.ok).toBe(true);
      const revisionId = payload.result?.revisionId;
      expect(typeof revisionId).toBe("string");
      expect(typeof payload.result?.revisionGroupId).toBe("string");
      expect(typeof payload.result?.operationId).toBe("string");
      const written = await fs.readFile(outPath);
      expect(written.subarray(0, 4).equals(ZIP_MAGIC)).toBe(true);
      const durable = await durableJournal.lookupOperation(payload.result?.operationId as string);
      expect(durable).toMatchObject({
        intent: {
          state: "committed",
          paths: [expect.objectContaining({ revisionIds: [revisionId] })],
        },
      });
    } finally {
      await cleanup();
    }
  });

  test("officecli create rejects an occupied output before generation or coordinator commit", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    const output = path.join(root, "occupied.docx");
    const before = Buffer.concat([ZIP_MAGIC, Buffer.from("human-output")]);
    let runnerCalls = 0;
    let commits = 0;
    await fs.writeFile(output, before);
    try {
      const result = await handleLocalFileDispatch(officeReq(
        {
          subkind: "officecli",
          zone: "current",
          command: "create",
          payload: { out: "occupied.docx", commands: [] },
          _routing: routing({ currentFolder: root }),
        },
        { roots: [root], approvalObtained: true },
      ), {
        relayId: RELAY,
        guard,
        journalRootDir: journalRoot,
        officeRun: async () => {
          runnerCalls += 1;
          return { stdout: "{}", stderr: "", exitCode: 0 };
        },
        officeCliCommit: async () => {
          commits += 1;
          throw new Error("occupied output must not reach the coordinator");
        },
      });
      const payload = result.result as { ok: boolean; code?: string };
      expect(result.status).toBe("ok");
      expect(payload).toMatchObject({ ok: false, code: "EXISTS" });
      expect(runnerCalls).toBe(0);
      expect(commits).toBe(0);
      expect(await fs.readFile(output)).toEqual(before);
    } finally {
      await cleanup();
    }
  });

  test("officecli direct output rejects an occupied distinct target before generation or coordinator commit", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    const source = path.join(root, "source.docx");
    const output = path.join(root, "occupied.docx");
    const sourceBytes = Buffer.concat([ZIP_MAGIC, Buffer.from("source")]);
    const before = Buffer.concat([ZIP_MAGIC, Buffer.from("human-output")]);
    let runnerCalls = 0;
    let commits = 0;
    await fs.writeFile(source, sourceBytes);
    await fs.writeFile(output, before);
    try {
      const result = await handleLocalFileDispatch(officeReq(
        {
          subkind: "officecli",
          zone: "current",
          command: "set",
          payload: {
            path: "source.docx",
            out: "occupied.docx",
            target: "/body/p[1]",
            props: { text: "agent" },
          },
          _routing: routing({ currentFolder: root }),
        },
        { roots: [root], approvalObtained: true },
      ), {
        relayId: RELAY,
        guard,
        journalRootDir: journalRoot,
        officeRun: async () => {
          runnerCalls += 1;
          return { stdout: "{}", stderr: "", exitCode: 0 };
        },
        officeCliCommit: async () => {
          commits += 1;
          throw new Error("occupied output must not reach the coordinator");
        },
      });
      const payload = result.result as { ok: boolean; code?: string };
      expect(result.status).toBe("ok");
      expect(payload).toMatchObject({ ok: false, code: "EXISTS" });
      expect(runnerCalls).toBe(0);
      expect(commits).toBe(0);
      expect(await fs.readFile(source)).toEqual(sourceBytes);
      expect(await fs.readFile(output)).toEqual(before);
    } finally {
      await cleanup();
    }
  });

  test("rejects invalid OOXML output bytes", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const req = officeReq(
        {
          subkind: "officecli",
          zone: "current",
          command: "set",
          payload: {
            path: "doc.docx",
            out: "doc.docx",
            target: "/body/p[1]",
            props: { text: "hi" },
          },
          _routing: routing({ currentFolder: root }),
        },
        { roots: [root], approvalObtained: true },
      );
      await fs.writeFile(path.join(root, "doc.docx"), Buffer.concat([ZIP_MAGIC, Buffer.from("orig")]));

      const badRun = async (argv: readonly string[]): Promise<OfficeCliRunResult> => {
        const target = argv[1];
        if (target) await fs.writeFile(target, Buffer.from("not-ooxml"));
        return { stdout: "{}", stderr: "", exitCode: 0 };
      };

      const res = await handleLocalFileDispatch(req, {
        relayId: RELAY,
        guard,
        journalRootDir: journalRoot,
        officeRun: badRun,
      });
      const payload = res.result as { ok: boolean; message?: string };
      expect(payload.ok).toBe(false);
      expect(payload.message).toContain("OOXML");
    } finally {
      await cleanup();
    }
  });

  test("rejects nested adversarial argv in officecli payload", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const req = officeReq(
        {
          subkind: "officecli",
          zone: "current",
          command: "set",
          payload: {
            path: "doc.docx",
            out: "doc.docx",
            props: { argv: ["set", "doc.docx", "--force"] },
          },
          _routing: routing({ currentFolder: root, turnId: "turn-1" }),
        },
        { roots: [root], approvalObtained: true },
      );
      const res = await handleLocalFileDispatch(req, {
        relayId: RELAY,
        guard,
        journalRootDir: journalRoot,
        officeRun: fakeRunner({}),
      });
      expect(res.status).toBe("error");
      expect(res.error).toContain("arbitrary execution field");
      expect(res.error).toContain("argv");
    } finally {
      await cleanup();
    }
  });

  test("rejects wire readArgv on officeRun read", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    try {
      const req = officeReq(
        {
          subkind: "officeRun",
          mode: "read",
          inputPath: "doc.docx",
          readArgv: ["get", "/body", "--json"],
          _routing: routing({ currentFolder: root }),
        },
        { roots: [root], approvalObtained: false },
      );
      const res = await handleLocalFileDispatch(req, {
        relayId: RELAY,
        guard,
        journalRootDir: journalRoot,
        officeRun: fakeRunner({}),
      });
      expect(res.status).toBe("error");
      expect(res.error).toContain("arbitrary execution field");
      expect(res.error).toContain("readArgv");
    } finally {
      await cleanup();
    }
  });

  test("local convert validates PDF output and commits through the V2 coordinator", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    const src = path.join(root, "notes.md");
    const dest = path.join(root, "out.pdf");
    await fs.writeFile(src, "# Title\n");
    try {
      const adapter = createGuardedNodeAdapter({ allowedRoots: [root] });
      const durableJournal = new LocalDurableMutationJournal({
        rootDir: journalRoot,
        relayId: RELAY,
        fileAdapter: adapter,
      });
      const runtime = new DesktopDocumentMutationRuntime({
        getTrustedRelayId: () => RELAY,
        getTrustedHumanId: () => OWNER,
        fileAdapter: adapter,
        journal: durableJournal,
        publishToRenderer: async () => "published",
      });
      const fakePdf = Buffer.from("%PDF-1.4\n% fake");
      const req = officeReq(
        {
          subkind: "convert",
          sourceZone: "current",
          sourcePath: "notes.md",
          destinationZone: "current",
          destinationPath: "out.pdf",
          inputFormat: "md",
          outputFormat: "pdf",
          backend: "local",
          summary: "Applied convert notes.md to PDF.",
          _routing: routing({ currentFolder: root, turnId: "turn-1" }),
        },
        { roots: [root], approvalObtained: true },
      );
      const res = await handleLocalFileDispatch(req, {
        relayId: RELAY,
        guard,
        journalRootDir: journalRoot,
        officeRun: fakeRunner({}),
        convertRunner: async () => new Uint8Array(fakePdf),
        officeCliCommit: async (input) => await runtime.commitOfficeCli({
          ...input,
          reauthorize: async () => {},
        }),
      });
      const payload = res.result as {
        ok: boolean;
        result?: { applied?: boolean; revisionId?: string; operationId?: string };
      };
      expect(payload.ok).toBe(true);
      expect(payload.result?.applied).toBe(true);
      expect(typeof payload.result?.revisionId).toBe("string");
      const written = await fs.readFile(dest);
      expect(written.subarray(0, 4).toString("ascii")).toBe("%PDF");
      expect(await durableJournal.lookupOperation(payload.result?.operationId as string)).toMatchObject({
        intent: {
          state: "committed",
          producer: { operation: "officecli", turnId: "turn-1" },
        },
      });
    } finally {
      await cleanup();
    }
  });

  test("failed convert validation does not write output", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    const src = path.join(root, "notes.md");
    const dest = path.join(root, "bad.pdf");
    await fs.writeFile(src, "# Title\n");
    try {
      const req = officeReq(
        {
          subkind: "convert",
          sourceZone: "current",
          sourcePath: "notes.md",
          destinationZone: "current",
          destinationPath: "bad.pdf",
          inputFormat: "md",
          outputFormat: "pdf",
          backend: "local",
          summary: "should not land",
          _routing: routing({ currentFolder: root, turnId: "turn-1" }),
        },
        { roots: [root], approvalObtained: true },
      );
      const res = await handleLocalFileDispatch(req, {
        relayId: RELAY,
        guard,
        journalRootDir: journalRoot,
        officeRun: fakeRunner({}),
        convertRunner: async () => new Uint8Array(Buffer.from("not-a-pdf")),
      });
      const payload = res.result as { ok: boolean; message?: string };
      expect(payload.ok).toBe(false);
      expect(payload.message).toContain("PDF magic");
      const outputExists = await fs.access(dest).then(
        () => true,
        () => false,
      );
      expect(outputExists).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("local convert loses to a human source edit made while conversion is running", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    const src = path.join(root, "notes.md");
    const dest = path.join(root, "out.pdf");
    await fs.writeFile(src, "# Initial\n");
    try {
      const adapter = createGuardedNodeAdapter({ allowedRoots: [root] });
      const durableJournal = new LocalDurableMutationJournal({
        rootDir: journalRoot,
        relayId: RELAY,
        fileAdapter: adapter,
      });
      const runtime = new DesktopDocumentMutationRuntime({
        getTrustedRelayId: () => RELAY,
        getTrustedHumanId: () => OWNER,
        fileAdapter: adapter,
        journal: durableJournal,
        publishToRenderer: async () => "published",
      });
      const req = officeReq(
        {
          subkind: "convert",
          sourceZone: "current",
          sourcePath: "notes.md",
          destinationZone: "current",
          destinationPath: "out.pdf",
          inputFormat: "md",
          outputFormat: "pdf",
          backend: "local",
          summary: "Applied convert notes.md to PDF.",
          _routing: routing({ currentFolder: root, turnId: "turn-convert-human-wins" }),
        },
        { roots: [root], approvalObtained: true },
      );
      const res = await handleLocalFileDispatch(req, {
        relayId: RELAY,
        guard,
        journalRootDir: journalRoot,
        convertRunner: async () => {
          await fs.writeFile(src, "# Human\n");
          return new Uint8Array(Buffer.from("%PDF-1.4\n% generated"));
        },
        officeCliCommit: async (input) => await runtime.commitOfficeCli({
          ...input,
          reauthorize: async () => {},
        }),
      });

      const payload = res.result as { ok: boolean; message?: string };
      expect(payload.ok).toBe(false);
      expect(payload.message).toContain("reread and regenerate");
      expect(await fs.readFile(src, "utf8")).toBe("# Human\n");
      const outputExists = await fs.access(dest).then(
        () => true,
        () => false,
      );
      expect(outputExists).toBe(false);
    } finally {
      await cleanup();
    }
  });
});
