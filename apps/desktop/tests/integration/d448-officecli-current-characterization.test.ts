/**
 * D448 Phase 6.1 Office lane B — characterize the existing Desktop-only
 * Current Folder Office mutation lanes before the unified coordinator exists.
 *
 * These are deliberately narrow behavior tests. `officecli` is the agent's
 * headless final-OOXML path; `officeRun` is retained only for Writer's
 * compatibility importer/structured-output path. Neither test declares a
 * general fallback or conflict-resolution contract.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createWorkspaceGuard, type RelayDispatchRequest, type RelayFsChangeEvent } from "@nautilo/relay";
import type { OfficeCliRunResult } from "@nautilo/config/officecli";
import { createGuardedNodeAdapter } from "../../electron/local-file-history/file-adapter.ts";
import { LocalFileHistoryJournal } from "../../electron/local-file-history/journal.ts";
import { LocalDurableMutationJournal } from "../../electron/local-file-history/durable-mutations.ts";
import { createJournalStorage, type JournalStorage } from "../../electron/local-file-history/storage.ts";
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
  mockedHistoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "d448-office-history-mock-"));
  ({ handleLocalFileDispatch } = await import("../../electron/local-file-dispatch/index.ts"));
});

afterAll(async () => {
  if (mockedHistoryRoot) await fs.rm(mockedHistoryRoot, { recursive: true, force: true });
});

const OWNER = "00000000-0000-4000-8000-000000000451";
const AGENT = "00000000-0000-4000-8000-000000000452";
const RELAY = "relay-d448-office-characterization";
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function routing(root: string, turnId = "turn-office-1") {
  return { ownerId: OWNER, agentId: AGENT, turnId, currentFolder: root, workspaceRoot: "" };
}

function officeRequest(input: {
  root: string;
  operation: Record<string, unknown>;
  approvalObtained?: boolean;
}): RelayDispatchRequest {
  return {
    correlationId: "d448-office-characterization",
    toolName: "local-file",
    executionClass: "local-file",
    impact: "destructive",
    approvalObtained: input.approvalObtained ?? true,
    allowedRoots: [input.root],
    args: {
      operation: { kind: "office", operation: input.operation },
      allowedRoots: [input.root],
    },
  };
}

async function fixture(): Promise<{
  root: string;
  journalRoot: string;
  guard: ReturnType<typeof createWorkspaceGuard>;
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "d448-office-root-"));
  const journalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "d448-office-journal-"));
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

function success(): OfficeCliRunResult {
  return { stdout: JSON.stringify({ ok: true }), stderr: "", exitCode: 0 };
}

function payloadOf(result: Awaited<ReturnType<typeof handleLocalFileDispatch>>): {
  ok: boolean;
  result?: Record<string, unknown>;
  message?: string;
  code?: string;
} {
  expect(result.status).toBe("ok");
  return result.result as { ok: boolean; result?: Record<string, unknown>; message?: string; code?: string };
}

describe("D448 Phase 6.1 — Desktop Current Folder Office lanes", () => {
  test("agent OfficeCLI stages its final OOXML bytes and delegates the only live write to the V2 coordinator", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    const source = path.join(root, "docs", "source.docx");
    const output = path.join(root, "docs", "final.docx");
    const initial = Buffer.concat([ZIP_MAGIC, Buffer.from("source-ooxml")]);
    const finalBytes = Buffer.concat([ZIP_MAGIC, Buffer.from("agent-final-ooxml")]);
    const events: RelayFsChangeEvent[] = [];
    const argvCalls: string[][] = [];
    const coordinatorBatches: unknown[] = [];
    let resolvePublished!: () => void;
    const published = new Promise<void>((resolve) => {
      resolvePublished = resolve;
    });
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, initial);
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
        publishToRenderer: async (batch) => {
          coordinatorBatches.push(batch);
          resolvePublished();
          return "published";
        },
      });
      const result = await handleLocalFileDispatch(officeRequest({
        root,
        operation: {
          subkind: "officecli",
          zone: "current",
          command: "set",
          payload: {
            path: "docs/source.docx",
            out: "docs/final.docx",
            target: "/body/p[1]",
            props: { text: "agent final" },
          },
          _routing: routing(root, "turn-office-final"),
        },
      }), {
        relayId: RELAY,
        guard,
        journalRootDir: journalRoot,
        onFsChange: (event) => events.push(event),
        officeCliCommit: async (input) => await runtime.commitOfficeCli({
          ...input,
          reauthorize: async () => {},
        }),
        officeRun: async (argv) => {
          argvCalls.push([...argv]);
          const staged = argv[1];
          if (typeof staged !== "string") throw new Error("expected OfficeCLI staged document path");
          await fs.writeFile(staged, finalBytes);
          return success();
        },
      });

      const payload = payloadOf(result);
      expect(payload.ok).toBe(true);
      expect(payload.result).toMatchObject({
        applied: true,
        path: "docs/final.docx",
        zone: "current",
        byteLength: finalBytes.byteLength,
      });
      expect(payload.result?.["revisionId"]).toEqual(expect.any(String));
      expect(payload.result?.["revisionGroupId"]).toEqual(expect.any(String));
      expect(payload.result?.["operationId"]).toEqual(expect.any(String));
      expect(argvCalls).toHaveLength(1);
      expect(argvCalls[0]?.[0]).toBe("set");
      expect(argvCalls[0]?.[1]).not.toBe(source);
      expect(await fs.readFile(source)).toEqual(initial);
      expect(await fs.readFile(output)).toEqual(finalBytes);
      const canonicalOutput = await fs.realpath(output);
      expect(events).toEqual([]);
      await published;
      expect(coordinatorBatches).toEqual([expect.objectContaining({
        operationId: payload.result?.["operationId"],
        events: [expect.objectContaining({
          mutation: "create",
          actor: { kind: "agent", agentId: AGENT },
        })],
      })]);

      const journal = new LocalFileHistoryJournal({
        rootDir: journalRoot,
        relayId: RELAY,
        fileAdapter: createGuardedNodeAdapter({ allowedRoots: [root] }),
      });
      await journal.init();
      expect(journal.entryCount()).toBe(0);
      const durable = await durableJournal.lookupOperation(payload.result?.["operationId"] as string);
      expect(durable).toMatchObject({
        intent: {
          state: "committed",
          paths: [expect.objectContaining({
            canonicalPath: canonicalOutput,
            revisionIds: [payload.result?.["revisionId"]],
          })],
        },
      });
    } finally {
      await cleanup();
    }
  });

  test("agent OfficeCLI refuses an occupied output without falling back to the V1 journal/direct-write lane", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    const source = path.join(root, "source.docx");
    const output = path.join(root, "final.docx");
    const sourceBytes = Buffer.concat([ZIP_MAGIC, Buffer.from("source")]);
    const before = Buffer.concat([ZIP_MAGIC, Buffer.from("human-existing")]);
    const produced = Buffer.concat([ZIP_MAGIC, Buffer.from("agent-produced")]);
    const events: RelayFsChangeEvent[] = [];
    await fs.writeFile(source, sourceBytes);
    await fs.writeFile(output, before);
    try {
      const adapter = createGuardedNodeAdapter({ allowedRoots: [root] });
      const storage = createJournalStorage(journalRoot);
      const failingStorage: JournalStorage = {
        ...storage,
        async writeManifest() {
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
      const result = await handleLocalFileDispatch(officeRequest({
        root,
        operation: {
          subkind: "officecli",
          zone: "current",
          command: "set",
          payload: { path: "source.docx", out: "final.docx", target: "/body/p[1]", props: { text: "agent" } },
          _routing: routing(root, "turn-office-compensate"),
        },
      }), {
        relayId: RELAY,
        guard,
        journal,
        journalRootDir: journalRoot,
        onFsChange: (event) => events.push(event),
        officeRun: async (argv) => {
          await fs.writeFile(argv[1]!, produced);
          return success();
        },
      });

      const payload = payloadOf(result);
      expect(payload.ok).toBe(false);
      expect(payload.code).toBe("EXISTS");
      expect(payload.message).toContain("already exists");
      expect(await fs.readFile(source)).toEqual(sourceBytes);
      expect(await fs.readFile(output)).toEqual(before);
      expect(journal.entryCount()).toBe(0);
      expect(events).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("compatibility-only office.run importer reads structured JSON without mutating Current Folder bytes, revisions, or events", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    const source = path.join(root, "import.docx");
    const bytes = Buffer.concat([ZIP_MAGIC, Buffer.from("import-source")]);
    const events: RelayFsChangeEvent[] = [];
    const argvCalls: string[][] = [];
    await fs.writeFile(source, bytes);
    try {
      const result = await handleLocalFileDispatch(officeRequest({
        root,
        approvalObtained: false,
        operation: {
          subkind: "officeRun",
          mode: "read",
          inputPath: "import.docx",
          readSpec: { verb: "get", target: "/body", json: true },
          _routing: routing(root, "turn-office-import"),
        },
      }), {
        relayId: RELAY,
        guard,
        journalRootDir: journalRoot,
        onFsChange: (event) => events.push(event),
        officeRun: async (argv) => {
          argvCalls.push([...argv]);
          return { stdout: JSON.stringify({ body: [{ text: "imported" }] }), stderr: "", exitCode: 0 };
        },
      });

      const payload = payloadOf(result);
      expect(payload).toEqual({ ok: true, result: { json: { body: [{ text: "imported" }] } } });
      expect(argvCalls).toHaveLength(1);
      expect(argvCalls[0]?.[0]).toBe("get");
      expect(argvCalls[0]?.[1]).not.toBe(source);
      expect(await fs.readFile(source)).toEqual(bytes);
      expect(events).toEqual([]);
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

  test("compatibility-only office.run stages create/batch/close output but delegates its only live write to V2", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    const output = path.join(root, "writer-output.docx");
    const finalBytes = Buffer.concat([ZIP_MAGIC, Buffer.from("writer-compat-output")]);
    const events: RelayFsChangeEvent[] = [];
    const commands: string[] = [];
    const coordinatorBatches: unknown[] = [];
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
        publishToRenderer: async (batch) => {
          coordinatorBatches.push(batch);
          return "published";
        },
      });
      const result = await handleLocalFileDispatch(officeRequest({
        root,
        operation: {
          subkind: "officeRun",
          mode: "write",
          outputPath: "writer-output.docx",
          ops: [{ command: "add", parent: "/", type: "paragraph", props: { text: "compat" } }],
          overwrite: false,
          officeType: "docx",
          _routing: routing(root, "turn-office-output-success"),
        },
      }), {
        relayId: RELAY,
        guard,
        journalRootDir: journalRoot,
        onFsChange: (event) => events.push(event),
        officeRun: async (argv) => {
          commands.push(argv[0] ?? "");
          if (argv[0] === "create") await fs.writeFile(argv[1]!, finalBytes);
          return success();
        },
        officeCliCommit: async (input) => await runtime.commitOfficeCli({
          ...input,
          reauthorize: async () => {},
        }),
      });

      const payload = payloadOf(result);
      expect(payload).toMatchObject({
        ok: true,
        result: {
          byteLength: finalBytes.byteLength,
          displayPath: "writer-output.docx",
        },
      });
      expect(commands).toEqual(["create", "batch", "close"]);
      expect(await fs.readFile(output)).toEqual(finalBytes);
      expect(events).toEqual([]);
      // Publication is intentionally decoupled from the durable commit. A busy
      // shared CI runner can delay that outbox microtask beyond 100 ms even
      // though the committed bytes and V2 receipt are already authoritative.
      for (let attempt = 0; attempt < 200 && coordinatorBatches.length === 0; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      expect(coordinatorBatches).toEqual([
        expect.objectContaining({
          events: [expect.objectContaining({
            mutation: "create",
            actor: { kind: "agent", agentId: AGENT },
          })],
        }),
      ]);
      const journal = new LocalFileHistoryJournal({
        rootDir: journalRoot,
        relayId: RELAY,
        fileAdapter: createGuardedNodeAdapter({ allowedRoots: [root] }),
      });
      await journal.init();
      expect(journal.entryCount()).toBe(0);
      const manifest = await createJournalStorage(journalRoot).readManifest();
      expect(manifest?.v).toBe(3);
      if (manifest?.v === 3) {
        expect(manifest.legacyEntries).toEqual([]);
        expect(manifest.mutations).toHaveLength(1);
        expect(manifest.mutations[0]).toMatchObject({
          state: "committed",
          producer: { operation: "officecli", turnId: "turn-office-output-success" },
        });
      }
    } finally {
      await cleanup();
    }
  });

  test("compatibility-only office.run output refuses an existing file when overwrite is false and does not fall back to OfficeCLI mutation", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    const output = path.join(root, "writer-output.docx");
    const before = Buffer.concat([ZIP_MAGIC, Buffer.from("human-output")]);
    const events: RelayFsChangeEvent[] = [];
    let runnerCalls = 0;
    await fs.writeFile(output, before);
    try {
      const result = await handleLocalFileDispatch(officeRequest({
        root,
        operation: {
          subkind: "officeRun",
          mode: "write",
          outputPath: "writer-output.docx",
          ops: [{ command: "add", parent: "/", type: "paragraph", props: { text: "compat" } }],
          overwrite: false,
          officeType: "docx",
          _routing: routing(root, "turn-office-output"),
        },
      }), {
        relayId: RELAY,
        guard,
        journalRootDir: journalRoot,
        onFsChange: (event) => events.push(event),
        officeRun: async () => {
          runnerCalls += 1;
          return success();
        },
      });

      const payload = payloadOf(result);
      expect(payload).toMatchObject({ ok: false, code: "EXISTS" });
      expect(runnerCalls).toBe(0);
      expect(await fs.readFile(output)).toEqual(before);
      expect(events).toEqual([]);
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

  test("office.run loses to a human target edit made while its private generator is running", async () => {
    const { root, journalRoot, guard, cleanup } = await fixture();
    const output = path.join(root, "writer-output.docx");
    const initial = Buffer.concat([ZIP_MAGIC, Buffer.from("initial")]);
    const human = Buffer.concat([ZIP_MAGIC, Buffer.from("human")]);
    const generated = Buffer.concat([ZIP_MAGIC, Buffer.from("agent")]);
    await fs.writeFile(output, initial);
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
      const result = await handleLocalFileDispatch(officeRequest({
        root,
        operation: {
          subkind: "officeRun",
          mode: "write",
          outputPath: "writer-output.docx",
          ops: [],
          overwrite: true,
          officeType: "docx",
          _routing: routing(root, "turn-office-human-wins"),
        },
      }), {
        relayId: RELAY,
        guard,
        journalRootDir: journalRoot,
        officeRun: async (argv) => {
          if (argv[0] === "create") {
            await fs.writeFile(argv[1]!, generated);
            await fs.writeFile(output, human);
          }
          return success();
        },
        officeCliCommit: async (input) => await runtime.commitOfficeCli({
          ...input,
          reauthorize: async () => {},
        }),
      });

      expect(payloadOf(result)).toMatchObject({
        ok: false,
        code: "CONFLICT",
        message: expect.stringContaining("changed after OfficeCLI staging"),
      });
      expect(await fs.readFile(output)).toEqual(human);
    } finally {
      await cleanup();
    }
  });
});
