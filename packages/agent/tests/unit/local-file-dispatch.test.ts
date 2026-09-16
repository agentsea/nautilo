import { afterEach, describe, expect, test } from "bun:test";
import { setRelayRegistry } from "../../src/nodes/tools";
import type { ToolRelayRegistry } from "../../src/nodes/tools";
import {
  LOCAL_FILE_EXECUTION_UNSUPPORTED,
  RELAY_PROTOCOL_VERSION,
  DESKTOP_FILESYSTEM_GRANT_SNAPSHOT_AGENT_SCOPE,
  type RelayLocalFileRequest,
  type RelayDesktopFilesystemGrantSnapshot,
} from "@nautilo/relay";
import { executeLocalFileCommand } from "../../src/tools/file/local-file-dispatch";
import type { RelayDesktopFilesystemGrantRequest } from "../../src/tools/file/local-file-routing";
import { setLiveReviewWriteGuard } from "../../src/tools/file/live-review-write-guard";
import { runWithRequiredOrdinaryHostContext } from "../../src/runtime/ordinary-host-dispatch-context";

const ownerId = "user-1";

afterEach(() => {
  setLiveReviewWriteGuard(null);
});

function stringOutput(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected string tool output");
  return value;
}

function outputRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(stringOutput(value)) as Record<string, unknown>;
}

const GRANT_ROOT = "/Users/alice/project";
const GRANT_SNAPSHOT: RelayDesktopFilesystemGrantSnapshot = {
  revision: 1,
  instanceId: "instance-A",
  agentScope: DESKTOP_FILESYSTEM_GRANT_SNAPSHOT_AGENT_SCOPE,
  grants: [
    {
      id: "grant-1",
      canonicalRoot: GRANT_ROOT,
      access: ["read"],
      policyVersion: 2,
      lifetime: "durable",
    },
  ],
};

type LocalFileDispatchOpts = {
  mutating: boolean;
  approvalObtained: boolean;
  desktopFilesystemGrantRequest?: RelayDesktopFilesystemGrantRequest;
  requiredRelaySessionId?: string;
  requiredDesktopSessionId?: string;
  requiredPairingGeneration?: string;
};

function makeSnapshotRegistry(
  capture: (call: {
    relayId: string;
    req: RelayLocalFileRequest;
    opts: LocalFileDispatchOpts;
  }) => void,
): ToolRelayRegistry {
  return {
    findByCapabilityForUser() {
      return ["relay-desktop"];
    },
    getCapabilities() {
      return {
        profile: "desktop-agent",
        workspaceRoot: "/Users/alice/project", dataDir: "/Users/alice/.nautilo", toolsBin: "/opt/nautilo/tools", userHome: "/Users/alice",
        canReadWorkspace: true,
        canWriteWorkspace: true,
        localFileExecution: true,
        allowedRoots: [GRANT_ROOT],
      };
    },
    getProtocolVersion() {
      return RELAY_PROTOCOL_VERSION;
    },
    getDesktopFilesystemGrantSnapshot() {
      return GRANT_SNAPSHOT;
    },
    async dispatch() {
      throw new Error("fs dispatch must not be used for local file commands");
    },
    async localFileDispatch(relayId, req, opts) {
      capture({ relayId, req, opts: opts as LocalFileDispatchOpts });
      return { ok: true, result: JSON.stringify({ matches: [] }) };
    },
  };
}

function makeRegistry(
  localFileDispatch: NonNullable<ToolRelayRegistry["localFileDispatch"]>,
): ToolRelayRegistry {
  return {
    findByCapabilityForUser() {
      return ["relay-desktop"];
    },
    getCapabilities() {
      return {
        profile: "desktop-agent",
        workspaceRoot: "/Users/alice/project", dataDir: "/Users/alice/.nautilo", toolsBin: "/opt/nautilo/tools", userHome: "/Users/alice",
        canReadWorkspace: true,
        canWriteWorkspace: true,
        localFileExecution: true,
        allowedRoots: ["/Users/alice/project"],
      };
    },
    getProtocolVersion() {
      return RELAY_PROTOCOL_VERSION;
    },
    async dispatch() {
      throw new Error("fs dispatch must not be used for local file commands");
    },
    localFileDispatch,
  };
}

describe("executeLocalFileCommand (M206)", () => {
  test("forwards the private exact Task continuation fence to final dispatch", async () => {
    const options: LocalFileDispatchOpts[] = [];
    setRelayRegistry(
      makeRegistry(async (_relayId, _req, opts) => {
        options.push(opts);
        return { ok: true, result: JSON.stringify({ matches: [] }) };
      }),
    );

    await runWithRequiredOrdinaryHostContext({
      relayId: "relay-desktop",
      currentFolderRoot: "/Users/alice/project",
      workspaceRoot: "/srv/ws",
      requiredRelaySessionId: "socket-1",
      requiredDesktopSessionId: "desktop-1",
      requiredPairingGeneration: "pairing-1",
    }, () => executeLocalFileCommand(
      { command: "grep", zone: "current", path: ".", query: "todo" },
      {
        ownerId,
        agentId: "agent-1",
        turnId: "turn-1",
        zoneCtx: { workspaceRoot: "/srv/ws", currentFolder: "/Users/alice/project" },
        approvalObtained: true,
      },
    ));

    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      requiredRelaySessionId: "socket-1",
      requiredDesktopSessionId: "desktop-1",
      requiredPairingGeneration: "pairing-1",
    });
  });

  test("native searches attach shared sandbox policy and missing Desktop paths fail before dispatch", async () => {
    const captured: Parameters<NonNullable<ToolRelayRegistry["localFileDispatch"]>>[2][] = [];
    const registry = makeRegistry(async (_id, _req, opts) => {
      captured.push(opts);
      return { ok: true, result: JSON.stringify({ matches: [] }) };
    });
    const context = { ownerId, agentId: "agent-1", zoneCtx: { workspaceRoot: "/srv/server-workspace", currentFolder: "/Users/alice/project" }, approvalObtained: false };
    setRelayRegistry(registry);
    for (const args of [
      { command: "grep" as const, zone: "current" as const, path: ".", query: "needle" },
      { command: "glob" as const, zone: "current" as const, path: ".", pattern: "*.ts" },
    ]) {
      await executeLocalFileCommand(args, context);
    }
    expect(captured).toHaveLength(2);
    for (const opts of captured) {
      expect(opts.sandboxProfile).toMatchObject({ workspace: "/Users/alice/project", dataDir: "/Users/alice/.nautilo", toolsBin: "/opt/nautilo/tools" });
    }
    const capabilities = registry.getCapabilities("relay-desktop")!;
    setRelayRegistry({ ...registry, getCapabilities: () => ({ ...capabilities, toolsBin: undefined }) });
    const failed = await executeLocalFileCommand({ command: "grep", zone: "current", path: ".", query: "needle" }, context);
    expect(JSON.stringify(failed)).toContain("LOCAL_FILE_SANDBOX_UNAVAILABLE");
    expect(JSON.stringify(failed)).toContain("No files were searched");
    expect(captured).toHaveLength(2);
    // Ordinary reads use the established local filesystem authority, not a process sandbox.
    await executeLocalFileCommand({ command: "read", zone: "current", path: "notes.md" }, context);
    expect(captured).toHaveLength(3);
    expect(captured[2]?.sandboxProfile).toBeUndefined();
  });

  test("dispatches one local-file request and never fsDispatch", async () => {
    const calls: Array<{ relayId: string; req: RelayLocalFileRequest }> = [];
    setRelayRegistry(
      makeRegistry(async (relayId, req) => {
        calls.push({ relayId, req });
        return { ok: true, result: JSON.stringify({ matches: [] }) };
      }),
    );

    const out = await executeLocalFileCommand(
      { command: "grep", zone: "current", path: ".", query: "todo" },
      {
        ownerId,
        agentId: "agent-1",
        turnId: "turn-1",
        zoneCtx: { workspaceRoot: "/srv/ws", currentFolder: "/Users/alice/project" },
        approvalObtained: true,
      },
    );

    expect(typeof out).toBe("string");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.relayId).toBe("relay-desktop");
    expect(calls[0]?.req.operation.kind).toBe("search");
    if (calls[0]?.req.operation.kind === "search") {
      expect(calls[0].req.operation.command).toBe("grep");
      expect(calls[0].req.operation.zone).toBe("current");
      expect(calls[0].req.operation.args).toMatchObject({
        path: ".",
        query: "todo",
        limit: 200,
        caseMode: "smart",
      });
    }
  });

  test("returns LOCAL_FILE_EXECUTION_UNSUPPORTED when no qualifying relay", async () => {
    setRelayRegistry(
      makeRegistry(async () => ({ ok: true, result: "noop" })),
    );
    setRelayRegistry({
      findByCapabilityForUser() {
        return [];
      },
      getCapabilities() {
        return {
          profile: "desktop-agent",
        workspaceRoot: "/Users/alice/project", dataDir: "/Users/alice/.nautilo", toolsBin: "/opt/nautilo/tools", userHome: "/Users/alice",
          canReadWorkspace: true,
          canWriteWorkspace: true,
          localFileExecution: true,
        };
      },
      getProtocolVersion() {
        return RELAY_PROTOCOL_VERSION;
      },
      async dispatch() {
        throw new Error("unexpected");
      },
      async localFileDispatch() {
        return { ok: true };
      },
    });

    const out = await executeLocalFileCommand(
      { command: "read", zone: "absolute", path: "/tmp/x.txt" },
      {
        ownerId,
        agentId: "agent-1",
        zoneCtx: { workspaceRoot: "", currentFolder: null },
        approvalObtained: true,
      },
    );
    expect(out).toContain(LOCAL_FILE_EXECUTION_UNSUPPORTED);
    expect(out).toContain("desktop app");
  });

  test("passes approvalObtained for mutating commands", async () => {
    let approvalPassed = false;
    setRelayRegistry(
      makeRegistry(async (_id, _req, opts) => {
        approvalPassed = opts.approvalObtained;
        return { ok: true, result: JSON.stringify({ applied: true }) };
      }),
    );

    await executeLocalFileCommand(
      { command: "write", zone: "current", path: "a.txt", content: "hi" },
      {
        ownerId,
        agentId: "agent-1",
        turnId: "turn-1",
        zoneCtx: { workspaceRoot: "", currentFolder: "/Users/alice/project" },
        approvalObtained: true,
      },
    );
    expect(approvalPassed).toBe(true);
  });
});

describe("executeLocalFileCommand exact open Writer gate", () => {
  const ctx = {
    ownerId,
    agentId: "agent-1",
    turnId: "turn-1",
    zoneCtx: { workspaceRoot: "", currentFolder: GRANT_ROOT },
    approvalObtained: true,
  };

  test("routes open-file content mutations to Desktop coordinator admission instead of the legacy Writer gate", async () => {
    let dispatchCalls = 0;
    setRelayRegistry(makeRegistry(async () => {
      dispatchCalls += 1;
      return { ok: true, result: JSON.stringify({ applied: true }) };
    }));
    setLiveReviewWriteGuard(async (target) =>
      target.surface === "currentFolder" &&
      target.ownerId === ownerId &&
      target.relayId === "relay-desktop" &&
      target.candidatePaths?.includes(`${GRANT_ROOT}/open.doc.html`) === true,
    );

    const out = await executeLocalFileCommand(
      {
        command: "str_replace",
        zone: "current",
        path: "open.doc.html",
        oldString: "a",
        newString: "b",
      },
      ctx,
    );

    expect(outputRecord(out)).toEqual({ applied: true });
    expect(dispatchCalls).toBe(1);
  });

  test("allows reads, different files, and closed sessions", async () => {
    const commands: string[] = [];
    setRelayRegistry(makeRegistry(async (_relayId, req) => {
      if (req.operation.kind === "file") commands.push(req.operation.command);
      return { ok: true, result: JSON.stringify({ applied: true }) };
    }));
    setLiveReviewWriteGuard(async (target) =>
      target.surface === "currentFolder" &&
      target.candidatePaths?.includes(`${GRANT_ROOT}/open.doc.html`) === true,
    );

    await executeLocalFileCommand(
      { command: "read", zone: "current", path: "open.doc.html" },
      ctx,
    );
    await executeLocalFileCommand(
      { command: "write", zone: "current", path: "other.doc.html", content: "x" },
      ctx,
    );
    setLiveReviewWriteGuard(async () => false);
    await executeLocalFileCommand(
      { command: "write", zone: "current", path: "open.doc.html", content: "x" },
      ctx,
    );

    expect(commands).toEqual(["read", "write", "write"]);
  });

  test("checks move source, destination, and directory-expanded destination", async () => {
    const probed: string[][] = [];
    let dispatchCalls = 0;
    setRelayRegistry(makeRegistry(async () => {
      dispatchCalls += 1;
      return { ok: true, result: "unused" };
    }));
    setLiveReviewWriteGuard(async (target) => {
      if (target.surface !== "currentFolder") return false;
      probed.push([...(target.candidatePaths ?? [])]);
      return target.candidatePaths?.includes(
        `${GRANT_ROOT}/archive/open.doc.html`,
      ) === true;
    });

    const out = await executeLocalFileCommand(
      {
        command: "move",
        zone: "current",
        path: "open.doc.html",
        destinationPath: "archive",
      },
      ctx,
    );

    expect(outputRecord(out)["code"]).toBe("use_edit_open_writer");
    expect(probed).toEqual([[
      `${GRANT_ROOT}/open.doc.html`,
      `${GRANT_ROOT}/archive`,
      `${GRANT_ROOT}/archive/open.doc.html`,
    ]]);
    expect(dispatchCalls).toBe(0);
  });

  test.each([
    {
      label: "recursive delete",
      args: {
        command: "delete" as const,
        zone: "current" as const,
        path: "docs",
        recursive: true,
      },
    },
    {
      label: "parent directory move",
      args: {
        command: "move" as const,
        zone: "current" as const,
        path: "docs",
        destinationPath: "archive",
      },
    },
  ])("blocks an open descendant during $label", async ({ args }) => {
    let dispatchCalls = 0;
    setRelayRegistry(makeRegistry(async () => {
      dispatchCalls += 1;
      return { ok: true, result: JSON.stringify({ applied: true }) };
    }));
    setLiveReviewWriteGuard(async (target) =>
      target.surface === "currentFolder" &&
      target.directoryCandidatePaths?.includes(`${GRANT_ROOT}/docs`) === true,
    );

    const out = await executeLocalFileCommand(args, ctx);

    expect(outputRecord(out)["code"]).toBe("use_edit_open_writer");
    expect(dispatchCalls).toBe(0);
  });
});

describe("executeLocalFileCommand D418 grant-reference transport", () => {
  test("native glob and grep preserve search semantics and carry the same read grant envelope", async () => {
    const calls: Array<{
      relayId: string;
      req: RelayLocalFileRequest;
      opts: LocalFileDispatchOpts;
    }> = [];
    setRelayRegistry(makeSnapshotRegistry((c) => calls.push(c)));
    const ctx = {
      ownerId,
      agentId: "agent-1",
      turnId: "turn-1",
      zoneCtx: { workspaceRoot: "/srv/ws", currentFolder: GRANT_ROOT },
      approvalObtained: false,
    };

    await executeLocalFileCommand(
      { command: "glob", zone: "current", path: "src", pattern: "**/*.ts", limit: 7, discoveryCursor: "cursor-from-glob", includeIgnored: true, hidden: "exclude" },
      ctx,
    );
    await executeLocalFileCommand(
      {
        command: "grep",
        zone: "current",
        path: "src",
        query: "Needle",
        glob: "**/*.ts",
        limit: 3,
        discoveryCursor: "cursor-from-grep",
        includeIgnored: true,
        hidden: "exclude",
        caseMode: "sensitive",
        lineRange: { from: 2, to: 4 },
      },
      ctx,
    );

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.opts.desktopFilesystemGrantRequest?.grantIds)).toEqual([["grant-1"], ["grant-1"]]);
    expect(calls[0]?.req.operation).toMatchObject({
      kind: "search",
      command: "glob",
      zone: "current",
      args: { path: "src", pattern: "**/*.ts", limit: 7, discoveryCursor: "cursor-from-glob", includeIgnored: true, hidden: "exclude" },
    });
    expect(calls[1]?.req.operation).toMatchObject({
      kind: "search",
      command: "grep",
      zone: "current",
      args: {
        path: "src",
        query: "Needle",
        glob: "**/*.ts",
        limit: 3,
        discoveryCursor: "cursor-from-grep",
        includeIgnored: true,
        hidden: "exclude",
        caseMode: "sensitive",
        lineRange: { from: 2, to: 4 },
      },
    });
  });

  test("read-only op under an advertised grant forwards exactly one reference", async () => {
    const calls: Array<{
      relayId: string;
      req: RelayLocalFileRequest;
      opts: LocalFileDispatchOpts;
    }> = [];
    setRelayRegistry(makeSnapshotRegistry((c) => calls.push(c)));

    await executeLocalFileCommand(
      { command: "read", zone: "current", path: "src/index.ts" },
      {
        ownerId,
        agentId: "agent-1",
        turnId: "turn-1",
        zoneCtx: { workspaceRoot: "/srv/ws", currentFolder: GRANT_ROOT },
        approvalObtained: false,
      },
    );

    expect(calls).toHaveLength(1);
    const grant = calls[0]?.opts.desktopFilesystemGrantRequest;
    expect(grant).toBeDefined();
    expect(grant?.grantIds).toEqual(["grant-1"]);
    expect(grant?.operation).toBe("read");
    expect(grant?.requestedRoot).toBe(`${GRANT_ROOT}/src/index.ts`);
    expect(grant?.subject).toEqual({
      userId: ownerId,
      instanceId: "instance-A",
      relayId: "relay-desktop",
      agentScope: DESKTOP_FILESYSTEM_GRANT_SNAPSHOT_AGENT_SCOPE,
    });
    // The reference rides OUTER envelope metadata, never inside operation args.
    if (calls[0]?.req.operation.kind === "file") {
      expect(calls[0].req.operation.args).not.toHaveProperty("desktopFilesystemGrantRequest");
    }
  });

  test("mutating command sends no grant reference despite an advertised grant", async () => {
    const calls: Array<{
      relayId: string;
      req: RelayLocalFileRequest;
      opts: LocalFileDispatchOpts;
    }> = [];
    setRelayRegistry(makeSnapshotRegistry((c) => calls.push(c)));

    await executeLocalFileCommand(
      { command: "write", zone: "current", path: "src/index.ts", content: "x" },
      {
        ownerId,
        agentId: "agent-1",
        turnId: "turn-1",
        zoneCtx: { workspaceRoot: "/srv/ws", currentFolder: GRANT_ROOT },
        approvalObtained: true,
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts.desktopFilesystemGrantRequest).toBeUndefined();
  });

  test("read-only op outside every advertised grant root keeps the baseline", async () => {
    const calls: Array<{
      relayId: string;
      req: RelayLocalFileRequest;
      opts: LocalFileDispatchOpts;
    }> = [];
    setRelayRegistry(makeSnapshotRegistry((c) => calls.push(c)));

    await executeLocalFileCommand(
      { command: "read", zone: "absolute", path: "/etc/hosts" },
      {
        ownerId,
        agentId: "agent-1",
        turnId: "turn-1",
        zoneCtx: { workspaceRoot: "/srv/ws", currentFolder: GRANT_ROOT },
        approvalObtained: false,
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts.desktopFilesystemGrantRequest).toBeUndefined();
  });
});

describe("local routing never touches Postgres backup", () => {
  test("executeLocalFileCommand module has no backup imports", async () => {
    const mod = await import("../../src/tools/file/local-file-dispatch");
    const src = Bun.file(new URL("../../src/tools/file/local-file-dispatch.ts", import.meta.url));
    const text = await src.text();
    expect(text).not.toContain("recordRevision");
    expect(text).not.toContain("file_revisions");
    expect(text).not.toContain("../backups");
    expect(mod.executeLocalFileCommand).toBeDefined();
  });

  test("local-history-routing module has no db imports", async () => {
    const src = Bun.file(
      new URL("../../src/tools/file/local-history-routing.ts", import.meta.url),
    );
    const text = await src.text();
    expect(text).not.toContain("@nautilo/db");
    expect(text).not.toContain("file_revisions");
  });
});
