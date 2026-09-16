import { describe, test, expect, spyOn, afterEach, beforeEach } from "bun:test";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import * as db from "@nautilo/db";
import { dispatchWorkspaceCommand, isWorkspaceArtifactCommand } from "../../src/tools/file/workspace-commands";
import type { DispatchContext } from "../../src/tools/file/dispatch";
import * as trustAgentDb from "../../src/store/trust-agent-db";

// M033 Phase 6 — `resolveWorkspaceArtifact` / `listWorkspaceArtifacts` /
// `applyWorkspaceArtifactRowChange` wrap RLS-gated reads in `withAgentTrustContext`,
// which would otherwise open a real postgres-js connection in this unit test.
// Mock so the wrap fans out to the inner fn with a stub conn (the test mocks
// the inner queries directly on `@nautilo/db`).
const MOCK_CONN = {} as never;

const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "20000000-0000-4000-8000-000000000002";

function namespaceEnvelope(over?: Partial<Extract<MemoryAccessEnvelope, { memoryMode?: "namespace" }>>): MemoryAccessEnvelope {
  return {
    ownerId: OWNER_ID,
    actorId: "30000000-0000-4000-8000-000000000003",
    agentId: AGENT_ID,
    roomId: "room-1",
    readableNamespaces: ["ns-read"],
    mutableNamespaces: ["ns-mut"],
    writableNamespaces: ["ns-write"],
    toolPolicy: {},
    ...over,
  };
}

describe("isWorkspaceArtifactCommand (M162 — undo/redo route through artifact resolver)", () => {
  test("undo and redo are workspace-artifact commands", () => {
    // Regression guard: before M162, undo/redo skipped the artifact
    // resolver and fell through to the generic workspace-FS resolver,
    // so Revert on a workspace artifact failed with file_missing.
    expect(isWorkspaceArtifactCommand("undo")).toBe(true);
    expect(isWorkspaceArtifactCommand("redo")).toBe(true);
  });

  test("non-artifact agent verbs stay out of the workspace path", () => {
    expect(isWorkspaceArtifactCommand("undo_turn")).toBe(false);
    expect(isWorkspaceArtifactCommand("list_revisions")).toBe(false);
  });

  test("copy is a workspace-artifact command", () => {
    expect(isWorkspaceArtifactCommand("copy")).toBe(true);
  });
});

describe("dispatchWorkspaceCommand (workspace authorization and coordinator admission)", () => {
  const restores: Array<() => void> = [];
  let workspaceRoot: string;
  let ctxBase: Omit<DispatchContext, "memoryAccessEnvelope">;

  beforeEach(async () => {
    workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "m088a-ws-"));
    ctxBase = {
      zoneCtx: { workspaceRoot, currentFolder: null },
      ownerId: OWNER_ID,
      turnId: "turn-m088a",
    };
    const spTrust = spyOn(trustAgentDb, "withAgentTrustContext").mockImplementation(
      async (_ctx, fn) => fn(MOCK_CONN),
    );
    restores.push(() => spTrust.mockRestore());
  });

  afterEach(async () => {
    while (restores.length) restores.pop()!();
    await fsp.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
  });

  test("glob and grep fail before Workspace envelope or artifact resolution", async () => {
    const artifactLookup = spyOn(db, "findArtifactByPathForNamespaces");
    restores.push(() => artifactLookup.mockRestore());

    const glob = JSON.parse(await dispatchWorkspaceCommand(
      { command: "glob", zone: "workspace", path: ".", pattern: "**/*.ts" },
      { ...ctxBase, memoryAccessEnvelope: null },
    ) as string) as { code: string; message: string };
    expect(glob).toMatchObject({ code: "unsupported_zone" });
    expect(glob.message).toContain("file.list");

    const grep = JSON.parse(await dispatchWorkspaceCommand(
      { command: "grep", zone: "workspace", path: ".", query: "needle" },
      { ...ctxBase, memoryAccessEnvelope: null },
    ) as string) as { code: string; message: string };
    expect(grep).toMatchObject({ code: "unsupported_zone" });
    expect(grep.message).toContain("file.read");
    expect(artifactLookup).not.toHaveBeenCalled();
  });

  test("no envelope → authenticated room/namespace context error", async () => {
    const out = await dispatchWorkspaceCommand(
      { command: "read", zone: "workspace", path: "a.md" },
      { ...ctxBase, memoryAccessEnvelope: null },
    );
    expect(typeof out).toBe("string");
    expect(out as string).toContain("Workspace artifact access requires an authenticated room/namespace context");
  });

  test("scope-mode envelope → scope mode not implemented", async () => {
    const scopeEnv: MemoryAccessEnvelope = {
      memoryMode: "scope",
      ownerId: OWNER_ID,
      actorId: "a",
      agentId: AGENT_ID,
      roomId: "",
      scopeId: "scope-1",
      toolPolicy: {},
    };
    const out = await dispatchWorkspaceCommand(
      { command: "read", zone: "workspace", path: "a.md" },
      { ...ctxBase, memoryAccessEnvelope: scopeEnv },
    );
    expect(out as string).toContain("Artifact scope mode is not implemented yet");
  });

  test("file.write new artifact with writableNamespaces=[] → no writable namespace error", async () => {
    const sp = spyOn(db, "findArtifactByPathForNamespaces").mockResolvedValue(null);
    restores.push(() => sp.mockRestore());

    const out = await dispatchWorkspaceCommand(
      { command: "write", zone: "workspace", path: "new.md", content: "hi" },
      {
        ...ctxBase,
        memoryAccessEnvelope: namespaceEnvelope({ writableNamespaces: [] }),
      },
    );
    expect(out as string).toContain("no writable namespace for new workspace artifacts");
  });

  test("file.read with no visible artifact → No workspace artifact at", async () => {
    const sp = spyOn(db, "findArtifactByPathForNamespaces").mockResolvedValue(null);
    restores.push(() => sp.mockRestore());

    const out = await dispatchWorkspaceCommand(
      { command: "read", zone: "workspace", path: "gone.md" },
      { ...ctxBase, memoryAccessEnvelope: namespaceEnvelope() },
    );
    expect(out as string).toContain("No workspace artifact found at");
    expect(out as string).toContain("gone.md");
  });

  test("file.str_replace with no visible artifact → str_replace suffix", async () => {
    const sp = spyOn(db, "findArtifactByPathForNamespaces").mockResolvedValue(null);
    restores.push(() => sp.mockRestore());

    const out = await dispatchWorkspaceCommand(
      {
        command: "str_replace",
        zone: "workspace",
        path: "gone.md",
        oldString: "a",
        newString: "b",
      },
      { ...ctxBase, memoryAccessEnvelope: namespaceEnvelope() },
    );
    expect(out as string).toContain('No workspace artifact at "gone.md"');
    expect(out as string).toContain("to str_replace");
  });

  test("file.move cross-zone (destinationZone current) → cross-zone error", async () => {
    const sp = spyOn(db, "findArtifactByPathForNamespaces").mockResolvedValue(null);
    restores.push(() => sp.mockRestore());

    const out = await dispatchWorkspaceCommand(
      {
        command: "move",
        zone: "workspace",
        path: "a.md",
        destinationPath: "b.md",
        destinationZone: "current",
      },
      { ...ctxBase, memoryAccessEnvelope: namespaceEnvelope() },
    );
    expect(out as string).toContain("cross-zone move out of workspace is not supported");
  });

  test("file.move same source and destination path → identical paths error", async () => {
    const out = await dispatchWorkspaceCommand(
      {
        command: "move",
        zone: "workspace",
        path: "same.md",
        destinationPath: "same.md",
      },
      { ...ctxBase, memoryAccessEnvelope: namespaceEnvelope() },
    );
    expect(out as string).toContain("source and destination paths are identical");
  });

  test("file.copy without canonical mutation context → missing_context", async () => {
    const sp = spyOn(db, "findArtifactByPathForNamespaces").mockResolvedValue(null);
    restores.push(() => sp.mockRestore());

    const out = await dispatchWorkspaceCommand(
      { command: "copy", zone: "workspace", path: "a.md", destinationPath: "b.md" },
      { ...ctxBase, memoryAccessEnvelope: namespaceEnvelope() },
    );
    expect(JSON.parse(out as string)).toMatchObject({
      error: "missing_context",
      code: "missing_context",
    });
  });
});
