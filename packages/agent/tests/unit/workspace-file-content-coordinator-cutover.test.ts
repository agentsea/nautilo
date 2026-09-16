import { afterEach, describe, expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { DocumentPatchEvent } from "@nautilo/types";
import { setWorkspaceArtifactEventSink } from "../../src/tools/file/artifact-store";
import { handleReplaceBlock } from "../../src/tools/file/blocks";
import { handleInsert } from "../../src/tools/file/commands/insert";
import { handleStrReplace } from "../../src/tools/file/commands/str-replace";
import { handleWrite } from "../../src/tools/file/commands/write";
import {
  createFileMutationRequestId,
  setWorkspaceFileContentCommitExecution,
  setWorkspaceFileContentRecoveryExecution,
  type WorkspaceFileContentCommitRequest,
} from "../../src/tools/file/workspace-runtime-adapter";
import { dispatchWorkspaceCommand } from "../../src/tools/file/workspace-commands";

const envelope = {
  ownerId: "owner-1",
  actorId: "human-1",
  agentId: "agent-1",
  roomId: "room-1",
  readableNamespaces: ["namespace-1"],
  mutableNamespaces: ["namespace-1"],
  writableNamespaces: ["namespace-1"],
  toolPolicy: {},
};

function context(logicalPath: string, physicalPath: string) {
  return {
    zoneCtx: { workspaceRoot: "", currentFolder: null },
    ownerId: "owner-1",
    agentId: "agent-1",
    roomId: "room-1",
    turnId: "turn-1",
    mutationRequestId: `request:${logicalPath}`,
    memoryAccessEnvelope: envelope,
    workspaceArtifactMeta: {
      mode: "update" as const,
      artifactId: "public-artifact-1",
      rowId: "11111111-1111-4111-8111-111111111111",
      logicalPath,
      namespaceId: "namespace-1",
      storageUri: `file://${physicalPath}`,
      mimeType: "text/plain",
      expectedRevision: 7,
    },
  };
}

function createContext(logicalPath: string, physicalPath: string) {
  return {
    zoneCtx: { workspaceRoot: "", currentFolder: null },
    ownerId: "owner-1",
    agentId: "agent-1",
    roomId: "room-1",
    turnId: "turn-1",
    mutationRequestId: `request:${logicalPath}`,
    memoryAccessEnvelope: envelope,
    workspaceArtifactMeta: {
      mode: "create" as const,
      artifactId: "planner-placeholder-id",
      logicalPath,
      namespaceId: "namespace-1",
      storageUri: `file://${physicalPath}`,
      mimeType: "text/plain",
    },
  };
}

function parsed(result: string) {
  return JSON.parse(result) as {
    applied: true;
    revisionId: string;
    command: string;
    path: string;
    unifiedDiff: string;
    blockOps?: unknown[];
    artifactId?: string;
    artifactInternalId?: string;
  };
}

afterEach(() => {
  setWorkspaceFileContentCommitExecution(undefined);
  setWorkspaceFileContentRecoveryExecution(undefined);
  setWorkspaceArtifactEventSink(null);
});

describe("Workspace file content coordinator cutover", () => {
  test("ordinary content planners invoke the coordinator port and preserve envelopes without legacy bytes or events", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "workspace-file-cutover-"));
    try {
      const original = "alpha\nbeta\ngamma\n";
      const commands = [
        {
          name: "write",
          run: (filePath: string) =>
            handleWrite(
              {
                command: "write",
                path: "notes/a.txt",
                zone: "workspace",
                content: "alpha\nBETA\ngamma\n",
              },
              { resolved: filePath, resolvedZone: "workspace" },
              context("notes/a.txt", filePath),
            ),
        },
        {
          name: "insert",
          run: (filePath: string) =>
            handleInsert(
              {
                command: "insert",
                path: "notes/a.txt",
                zone: "workspace",
                lineNumber: 2,
                content: "inserted",
              },
              { resolved: filePath, resolvedZone: "workspace" },
              context("notes/a.txt", filePath),
            ),
        },
        {
          name: "str_replace",
          run: (filePath: string) =>
            handleStrReplace(
              {
                command: "str_replace",
                path: "notes/a.txt",
                zone: "workspace",
                oldString: "beta",
                newString: "BETA",
              },
              { resolved: filePath, resolvedZone: "workspace" },
              context("notes/a.txt", filePath),
            ),
        },
      ];
      const requests: WorkspaceFileContentCommitRequest[] = [];
      const legacyEvents: DocumentPatchEvent[] = [];
      setWorkspaceArtifactEventSink((event) => {
        if (event.type === "document.patch.applied") legacyEvents.push(event);
      });
      setWorkspaceFileContentCommitExecution(async (request) => {
        requests.push(request);
        return { ok: true, revisionId: `revision-${request.command}` };
      });

      for (const command of commands) {
        const filePath = path.join(root, `${command.name}.txt`);
        await fsp.writeFile(filePath, original);
        const result = parsed(await command.run(filePath));
        expect(result).toMatchObject({
          applied: true,
          command: command.name,
          path: "notes/a.txt",
          revisionId: `revision-${command.name}`,
        });
        expect(result.unifiedDiff.length).toBeGreaterThan(0);
        expect(await fsp.readFile(filePath, "utf8")).toBe(original);
      }

      expect(requests.map((request) => request.command)).toEqual([
        "write",
        "insert",
        "str_replace",
      ]);
      expect(requests[0]?.source).toMatchObject({
        artifactInternalId: "11111111-1111-4111-8111-111111111111",
        revision: 7,
        logicalPath: "notes/a.txt",
      });
      expect(legacyEvents).toEqual([]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("block content mutation uses the same coordinator port and preserves block projection", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "workspace-block-cutover-"));
    try {
      const filePath = path.join(root, "blocks.html");
      const original = "<html><body><p id=\"a\">Before</p></body></html>";
      await fsp.writeFile(filePath, original);
      let request: WorkspaceFileContentCommitRequest | undefined;
      setWorkspaceFileContentCommitExecution(async (input) => {
        request = input;
        return { ok: true, revisionId: "revision-block" };
      });
      const result = parsed(await handleReplaceBlock(
        {
          command: "replace_block",
          path: "blocks.html",
          zone: "workspace",
          target: { block: "a" },
          newContent: "<p id=\"a\">After</p>",
        },
        { resolved: filePath, resolvedZone: "workspace" },
        context("blocks.html", filePath),
      ));
      expect(result.revisionId).toBe("revision-block");
      expect(result.blockOps).toHaveLength(1);
      expect(request?.command).toBe("replace_block");
      expect(Buffer.from(request!.output.bytes).toString("utf8")).toContain("After");
      expect(await fsp.readFile(filePath, "utf8")).toBe(original);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("projects the committed create identity instead of the planner placeholder", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "workspace-create-cutover-"));
    try {
      const filePath = path.join(root, "new.txt");
      let request: WorkspaceFileContentCommitRequest | undefined;
      setWorkspaceFileContentCommitExecution(async (input) => {
        request = input;
        return {
          ok: true,
          revisionId: "revision-create",
          artifactId: "22222222-2222-4222-8222-222222222222",
          artifactInternalId: "22222222-2222-4222-8222-222222222222",
        };
      });
      const result = parsed(await handleWrite(
        {
          command: "write",
          path: "notes/new.txt",
          zone: "workspace",
          content: "new\n",
        },
        { resolved: filePath, resolvedZone: "workspace" },
        createContext("notes/new.txt", filePath),
      ));

      expect(request?.source).toBeUndefined();
      expect(result).toMatchObject({
        revisionId: "revision-create",
        artifactId: "22222222-2222-4222-8222-222222222222",
        artifactInternalId: "22222222-2222-4222-8222-222222222222",
      });
      expect(result.artifactId).not.toBe("planner-placeholder-id");
      const exists = await fsp.stat(filePath).then(
        () => true,
        () => false,
      );
      expect(exists).toBe(false);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("preserves clean, dirty non-overlap, and dirty overlap coordinator command semantics", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "workspace-conflict-cutover-"));
    try {
      const filePath = path.join(root, "conflict.txt");
      await fsp.writeFile(filePath, "alpha\nbeta\ngamma\n");
      for (const scenario of [
        { name: "clean", outcome: "applied" },
        { name: "dirty-non-overlap", outcome: "rebased" },
        { name: "dirty-overlap", outcome: "conflict" },
      ] as const) {
        setWorkspaceFileContentCommitExecution(async () =>
          scenario.outcome === "conflict"
            ? {
                ok: false,
                code: "human_edit_conflict",
                message: "conflict",
              }
            : {
                ok: true,
                revisionId: `revision-${scenario.outcome}`,
              });
        const result = await handleStrReplace(
          {
            command: "str_replace",
            path: "notes/a.txt",
            zone: "workspace",
            oldString: "beta",
            newString: "BETA",
          },
          { resolved: filePath, resolvedZone: "workspace" },
          context("notes/a.txt", filePath),
        );
        if (scenario.outcome === "conflict") {
          expect(result, scenario.name).toContain("human edit conflicts");
        } else {
          expect(parsed(result), scenario.name).toMatchObject({
            applied: true,
            command: "str_replace",
            revisionId: `revision-${scenario.outcome}`,
          });
        }
        expect(await fsp.readFile(filePath, "utf8"), scenario.name).toBe(
          "alpha\nbeta\ngamma\n",
        );
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("a new public dispatch recovers a lost insert response before replanning bytes", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "workspace-retry-cutover-"));
    try {
      const filePath = path.join(root, "retry.txt");
      const original = "alpha\nbeta\n";
      await fsp.writeFile(filePath, original);
      const args = {
        command: "insert" as const,
        path: "notes/retry.txt",
        zone: "workspace" as const,
        lineNumber: 2,
        content: "inserted",
      };
      const mutationRequestId = createFileMutationRequestId("tool-call-1", args);
      let commitCalls = 0;
      let recoveryCalls = 0;
      setWorkspaceFileContentCommitExecution(async () => {
        commitCalls += 1;
        return {
          ok: false,
          code: "unknown",
          message: "lost response",
          retryable: true,
          mutationRequestId,
        };
      });
      const initialContext = {
        ...context("notes/retry.txt", filePath),
        mutationRequestId,
      };
      const unknown = JSON.parse(await handleInsert(
        args,
        { resolved: filePath, resolvedZone: "workspace" },
        initialContext,
      )) as { code: string; mutationRequestId: string };
      expect(unknown).toMatchObject({
        code: "unknown",
        mutationRequestId,
      });

      setWorkspaceFileContentRecoveryExecution(async () => {
        recoveryCalls += 1;
        return { ok: true, revisionId: "revision-insert" };
      });
      const recovered = JSON.parse(await dispatchWorkspaceCommand(
        { ...args, retryRequestId: unknown.mutationRequestId },
        {
          ...initialContext,
          turnId: "turn-2",
        },
      ) as string) as { applied: boolean; recovered: boolean; revisionId: string };
      expect(recovered).toMatchObject({
        applied: true,
        recovered: true,
        revisionId: "revision-insert",
      });
      expect(commitCalls).toBe(1);
      expect(recoveryCalls).toBe(1);
      expect(await fsp.readFile(filePath, "utf8")).toBe(original);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
