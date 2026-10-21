import { afterEach, beforeAll, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createWorkspaceGuard,
  type RelayCapabilities,
  type RelayDispatchRequest,
  type RelayLocalExecutionBindingV4,
  type RelaySandboxProfile,
} from "@nautilo/relay";
import type { Sandbox } from "@nautilo/sandbox";
import { createGuardedNodeAdapter } from "../../electron/local-file-history/file-adapter.ts";
import { snapshotFromBytes } from "../../electron/local-file-history/hash.ts";
import { LocalFileHistoryJournal } from "../../electron/local-file-history/journal.ts";

mock.module("electron", () => ({ app: { getPath: () => "/tmp/task-project-local-file-test" } }));

let makeDispatchHandler: typeof import("../../electron/relay.ts").makeDispatchHandler;
beforeAll(async () => { ({ makeDispatchHandler } = await import("../../electron/relay.ts")); });

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const TASK_ID = "00000000-0000-4000-8000-000000000001";
const RUN_ID = "00000000-0000-4000-8000-000000000002";
const HUMAN_ID = "00000000-0000-4000-8000-000000000003";
const AGENT_ID = "00000000-0000-4000-8000-000000000004";

function binding(
  operation: "read" | "input" = "read",
  ceiling: "basic" | "development" = "basic",
): RelayLocalExecutionBindingV4 {
  const profile = ceiling === "development" ? { id: "profile-a", revision: 4 } : null;
  return {
    version: 4,
    generation: "host-generation",
    invocationId: "task-file-call",
    executionId: "task-file-execution",
    operation,
    localNetworkPolicy: { mode: "isolated" },
    authority: {
      kind: "delegated",
      taskId: TASK_ID,
      taskRunId: RUN_ID,
      roomId: "room-a",
      delegation: {
        version: 1,
        humanUserId: HUMAN_ID,
        agentId: AGENT_ID,
        sourceRoomId: "room-a",
        sourceConversationId: "thread-a",
        rootTaskId: TASK_ID,
        target: {
          instanceId: "instance-a",
          relayId: "relay-a",
          pairingGeneration: "raw-pair-a",
          serverOrigin: "https://server.invalid",
          serverFingerprint: "server-fingerprint-a",
        },
        projectGrantId: "task-project-grant",
        ceiling,
        profile,
      },
    },
    owner: {
      instanceId: "instance-a",
      humanUserId: HUMAN_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      conversationId: "thread-a",
      relayId: "relay-a",
      desktopSessionId: "desktop-a",
      pairingGeneration: "pair-a",
      serverBindingId: "server-binding-a",
      profileId: profile?.id ?? null,
      profileRevision: profile?.revision ?? null,
      grantIds: ["task-project-grant"],
      grantRevision: null,
      protectedPolicyVersion: 1,
    },
  };
}

function capabilities(): RelayCapabilities {
  return {
    profile: "desktop-agent",
    localFileExecution: true,
    canDelegateLocalExecution: true,
    canUseTaskProjectFiles: true,
    localExecution: {
      version: 1,
      generation: "host-generation",
      pipe: true,
      pty: true,
      localNetworkPolicy: true,
      capacity: 8,
    },
  };
}

function readRequest(projectRoot: string, overrides: Partial<RelayDispatchRequest> = {}): RelayDispatchRequest {
  return {
    correlationId: "task-project-read",
    toolName: "local-file",
    executionClass: "local-file",
    impact: "read-only",
    approvalObtained: true,
    localExecutionBinding: binding(),
    args: {
      operation: {
        kind: "file",
        command: "read",
        zone: "absolute",
        args: {
          path: join(projectRoot, "inside.txt"),
          _routing: {
            ownerId: HUMAN_ID,
            agentId: AGENT_ID,
            turnId: "turn-a",
            currentFolder: null,
            workspaceRoot: "",
          },
        },
      },
      allowedRoots: [projectRoot],
    },
    ...overrides,
  };
}

function searchRequest(
  projectRoot: string,
  localExecutionBinding: RelayLocalExecutionBindingV4 = binding(),
): RelayDispatchRequest {
  return {
    correlationId: "task-project-search",
    toolName: "local-file",
    executionClass: "local-file",
    impact: "read-only",
    approvalObtained: true,
    localExecutionBinding,
    args: {
      operation: {
        kind: "search",
        command: "glob",
        zone: "absolute",
        args: {
          path: projectRoot,
          pattern: "*.txt",
          limit: 20,
          includeIgnored: false,
          hidden: "exclude",
        },
        routing: {
          ownerId: HUMAN_ID,
          agentId: AGENT_ID,
          turnId: "turn-a",
          currentFolder: null,
          workspaceRoot: "",
        },
      },
      allowedRoots: [projectRoot],
    },
  };
}

function fixture(input: {
  access?: readonly ("read" | "create_modify" | "delete" | "execute")[];
  accessAt?: (call: number) => readonly ("read" | "create_modify" | "delete" | "execute")[];
  expiresAt?: number;
  onResolve?: (call: number, projectRoot: string) => void;
  contextPairingGeneration?: string;
  grantIdsAt?: (call: number) => readonly string[];
  includeProfileRoots?: boolean;
  createSandbox?: NonNullable<Parameters<typeof makeDispatchHandler>[1]>["createSandbox"];
  probeRipgrep?: NonNullable<Parameters<typeof makeDispatchHandler>[1]>["probeRipgrep"];
  searchExecute?: NonNullable<Parameters<typeof makeDispatchHandler>[1]>["localFileSearchExecute"];
  commitContent?: NonNullable<Parameters<typeof makeDispatchHandler>[1]>["commitDesktopAgentContent"];
} = {}) {
  const delegationRoot = realpathSync(mkdtempSync(join(tmpdir(), "task-project-grant-")));
  const baselineRoot = realpathSync(mkdtempSync(join(tmpdir(), "task-project-baseline-")));
  roots.push(delegationRoot, baselineRoot);
  const projectRoot = join(delegationRoot, "nautilo-repo-docs", `task-run-${RUN_ID}`);
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(join(projectRoot, "openwiki"));
  mkdirSync(join(projectRoot, ".git", "hooks"), { recursive: true });
  writeFileSync(join(projectRoot, "inside.txt"), "inside-only");
  writeFileSync(join(projectRoot, "openwiki", "page.md"), "generated-page");
  writeFileSync(join(projectRoot, ".git", "config"), "private-git-control");
  writeFileSync(join(baselineRoot, "outside.txt"), "baseline-secret");
  let calls = 0;
  const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: baselineRoot }), {
    relayId: "relay-a",
    isProduction: true,
    protectedPathPolicy: { check: () => ({ allowed: true }), descriptors: [], schemaVersion: 1 } as never,
    ...(input.commitContent === undefined ? {} : { commitDesktopAgentContent: input.commitContent }),
    ...(input.createSandbox === undefined ? {} : { createSandbox: input.createSandbox }),
    ...(input.probeRipgrep === undefined ? {} : { probeRipgrep: input.probeRipgrep }),
    ...(input.searchExecute === undefined ? {} : { localFileSearchExecute: input.searchExecute }),
    taskProjectFileDispatchContext: () => ({
      capabilities: capabilities(),
      protocolVersion: 30,
      userId: HUMAN_ID,
      relayId: "relay-a",
      desktopSessionId: "desktop-a",
      pairingGeneration: input.contextPairingGeneration ?? "pair-a",
      instanceId: "instance-a",
    }),
    resolveLocalExecutionDelegation: async () => {
      calls += 1;
      input.onResolve?.(calls, projectRoot);
      return {
        root: delegationRoot,
        grantIds: input.grantIdsAt?.(calls) ?? ["task-project-grant"],
        access: input.accessAt?.(calls) ?? input.access ?? ["read", "create_modify", "delete"],
        dataDir: join(delegationRoot, ".private"),
        readOnlyRoots: input.includeProfileRoots ? [baselineRoot] : [],
        writableRoots: input.includeProfileRoots ? [baselineRoot] : [],
        networkPolicy: { mode: "isolated" },
        ...(input.expiresAt === undefined ? {} : { authorityExpiresAt: input.expiresAt }),
        isCurrent: () => true,
      };
    },
  });
  return { baselineRoot, projectRoot, handler, calls: () => calls };
}

test("uses only the exact locally resolved Task project child and reproves it before reading", async () => {
  const f = fixture();
  const result = await f.handler(readRequest(f.projectRoot));
  expect(result.status).toBe("ok");
  expect(JSON.stringify(result.result)).toContain("inside-only");
  expect(f.calls()).toBe(4);

  const outside = await f.handler(readRequest(f.projectRoot, {
    args: {
      ...readRequest(f.projectRoot).args,
      operation: {
        kind: "file",
        command: "read",
        zone: "absolute",
        args: {
          path: join(f.baselineRoot, "outside.txt"),
          _routing: { ownerId: HUMAN_ID, agentId: AGENT_ID, turnId: "turn-a", currentFolder: null, workspaceRoot: "" },
        },
      },
    },
  }));
  expect(outside).toMatchObject({
    status: "error",
    errorCode: "TASK_PROJECT_FILE_AUTHORITY_UNAVAILABLE",
  });
});

test("excludes Git control data from protected Task reads without changing ordinary local reads", async () => {
  const f = fixture();
  const protectedRead = readRequest(f.projectRoot, {
    args: {
      ...readRequest(f.projectRoot).args,
      operation: {
        kind: "file",
        command: "read",
        zone: "absolute",
        args: {
          path: join(f.projectRoot, ".git", "config"),
          _routing: { ownerId: HUMAN_ID, agentId: AGENT_ID, turnId: "turn-a", currentFolder: null, workspaceRoot: "" },
        },
      },
    },
  });
  expect(await f.handler(protectedRead)).toMatchObject({
    status: "error",
    errorCode: "TASK_PROJECT_FILE_AUTHORITY_UNAVAILABLE",
  });

  const ordinaryRead = { ...protectedRead, localExecutionBinding: undefined };
  const ordinary = await f.handler(ordinaryRead);
  expect(ordinary.status).toBe("ok");
  expect(JSON.stringify(ordinary.result)).toContain("private-git-control");
});

test("rejects a real same-agent revision from another project because its reference has no path proof", async () => {
  const f = fixture();
  const journalRoot = mkdtempSync(join(tmpdir(), "task-project-foreign-history-"));
  roots.push(journalRoot);
  const foreignPath = join(f.baselineRoot, "outside.txt");
  const journal = new LocalFileHistoryJournal({
    rootDir: journalRoot,
    relayId: "relay-a",
    fileAdapter: createGuardedNodeAdapter({ allowedRoots: [f.baselineRoot] }),
  });
  const recorded = await journal.recordSuccessfulMutation({
    ownerId: HUMAN_ID,
    agentId: AGENT_ID,
    turnId: "foreign-turn",
    requestedPath: foreignPath,
    zone: "absolute",
    operation: "write",
    preState: snapshotFromBytes(Buffer.from("before")),
    postState: snapshotFromBytes(Buffer.from("baseline-secret")),
  });
  if (!recorded.ok) throw new Error(recorded.message);

  const pin = readRequest(f.projectRoot, {
    correlationId: "task-project-pin-foreign-revision",
    impact: "destructive",
    localExecutionBinding: binding("input"),
    args: {
      operation: {
        kind: "history",
        command: "pin_revision",
        args: {
          revisionId: recorded.data.revisionRef,
          _routing: {
            ownerId: HUMAN_ID,
            agentId: AGENT_ID,
            turnId: "turn-a",
            currentFolder: f.projectRoot,
            workspaceRoot: f.projectRoot,
          },
        },
      },
      allowedRoots: [f.projectRoot],
    },
  });
  expect(await f.handler(pin)).toMatchObject({
    status: "error",
    errorCode: "TASK_PROJECT_FILE_AUTHORITY_UNAVAILABLE",
  });
  // The relay reloads the grant once, then the Task-project operation policy
  // rejects the pathless revision reference before journal dispatch.
  expect(f.calls()).toBe(1);
});

test("confines protected Task mutations to a real non-symlinked openwiki subtree", async () => {
  let committed = 0;
  const f = fixture({
    commitContent: async (input) => {
      await input.reauthorize();
      committed += 1;
      writeFileSync(input.targetPath, input.after);
      return {
        ok: true,
        operationId: "operation-a",
        revisionId: "revision-a",
        sha256: "0".repeat(64),
        before: input.before,
        after: input.after,
        byteLength: input.after.byteLength,
        replayed: false,
      };
    },
  });
  const write = (targetPath: string): RelayDispatchRequest => readRequest(f.projectRoot, {
    impact: "destructive",
    localExecutionBinding: binding("input"),
    args: {
      operation: {
        kind: "file",
        command: "write",
        zone: "absolute",
        args: {
          path: targetPath,
          content: "updated",
          _routing: {
            ownerId: HUMAN_ID,
            agentId: AGENT_ID,
            turnId: "turn-a",
            mutationRequestId: `mutation-${committed}`,
            currentFolder: null,
            workspaceRoot: "",
          },
        },
      },
      allowedRoots: [f.projectRoot],
    },
  });

  expect(await f.handler(write(join(f.projectRoot, ".git", "hooks", "pre-commit"))))
    .toMatchObject({ status: "error", errorCode: "TASK_PROJECT_FILE_AUTHORITY_UNAVAILABLE" });
  expect(await f.handler(write(join(f.projectRoot, "README.md"))))
    .toMatchObject({ status: "error", errorCode: "TASK_PROJECT_FILE_AUTHORITY_UNAVAILABLE" });
  expect(committed).toBe(0);

  expect(await f.handler(write(join(f.projectRoot, "openwiki", "page.md"))))
    .toMatchObject({ status: "ok" });
  expect(committed).toBe(1);

  rmSync(join(f.projectRoot, "openwiki"), { recursive: true, force: true });
  symlinkSync(join(f.projectRoot, ".git"), join(f.projectRoot, "openwiki"), "dir");
  expect(await f.handler(write(join(f.projectRoot, "openwiki", "page.md"))))
    .toMatchObject({ status: "error", errorCode: "TASK_PROJECT_FILE_AUTHORITY_UNAVAILABLE" });
  expect(committed).toBe(1);
});

test("creates a local read-only isolated sandbox for Task project search without a server envelope", async () => {
  let captured: RelaySandboxProfile | undefined;
  let closed = 0;
  const fakeSandbox = {
    containmentActive: () => true,
    protectedFileMaskSupported: () => true,
    close: async () => { closed += 1; },
  } as unknown as Sandbox;
  const f = fixture({
    createSandbox: async (envelope) => {
      captured = envelope as RelaySandboxProfile;
      return fakeSandbox;
    },
    probeRipgrep: async () => ({ ok: true, binaryPath: "/trusted/rg", version: "14.1.0" }),
    searchExecute: async (input) => {
      input.onStdoutChunk(Buffer.from("inside.txt\0"));
      return { exitCode: 0, stderr: "", timedOut: false, aborted: false, stoppedEarly: false };
    },
  });
  const result = await f.handler(searchRequest(f.projectRoot));
  expect(result.status).toBe("ok");
  expect(JSON.stringify(result.result)).toContain("inside.txt");
  expect(captured).toBeDefined();
  expect(captured!.config).toMatchObject({
    mode: "enabled",
    writablePaths: [],
    projectPaths: [],
    readOnlyPaths: [f.projectRoot],
    networkPolicy: { mode: "isolated" },
  });
  expect(captured!.workspace).not.toBe(f.projectRoot);
  expect(captured!.config.writablePaths).not.toContain(f.baselineRoot);
  expect(captured!.config.readOnlyPaths).not.toContain(f.baselineRoot);
  expect(captured!.failIfNoBackend).toBe(true);
  expect(existsSync(captured!.workspace)).toBe(false);
  expect(closed).toBe(1);
});

test("reproves Task project identity immediately before search execution", async () => {
  let sandboxCreated = false;
  let replaced = false;
  let executed = 0;
  const fakeSandbox = {
    containmentActive: () => true,
    protectedFileMaskSupported: () => true,
    close: async () => {},
  } as unknown as Sandbox;
  const f = fixture({
    createSandbox: async () => {
      sandboxCreated = true;
      return fakeSandbox;
    },
    onResolve(_call, projectRoot) {
      if (!sandboxCreated || replaced) return;
      replaced = true;
      rmSync(projectRoot, { recursive: true, force: true });
      mkdirSync(projectRoot, { recursive: true });
      writeFileSync(join(projectRoot, "inside.txt"), "replacement");
    },
    probeRipgrep: async () => ({ ok: true, binaryPath: "/trusted/rg", version: "14.1.0" }),
    searchExecute: async () => {
      executed += 1;
      return { exitCode: 0, stderr: "", timedOut: false, aborted: false, stoppedEarly: false };
    },
  });

  expect(await f.handler(searchRequest(f.projectRoot))).toMatchObject({
    status: "error",
    errorCode: "TASK_PROJECT_FILE_AUTHORITY_UNAVAILABLE",
  });
  expect(replaced).toBe(true);
  expect(executed).toBe(0);
});

test("accepts a current Development delegation but never exposes its profile roots", async () => {
  const development = binding("read", "development");
  const f = fixture({
    grantIdsAt: () => ["profile-grant", "task-project-grant"],
    includeProfileRoots: true,
  });
  expect(await f.handler(readRequest(f.projectRoot, { localExecutionBinding: development }))).toMatchObject({ status: "ok" });
  expect(await f.handler(readRequest(f.projectRoot, {
    localExecutionBinding: development,
    args: {
      ...readRequest(f.projectRoot).args,
      allowedRoots: [f.baselineRoot],
      operation: {
        kind: "file",
        command: "read",
        zone: "absolute",
        args: {
          path: join(f.baselineRoot, "outside.txt"),
          _routing: { ownerId: HUMAN_ID, agentId: AGENT_ID, turnId: "turn-a", currentFolder: null, workspaceRoot: "" },
        },
      },
    },
  }))).toMatchObject({ status: "error", errorCode: "TASK_PROJECT_FILE_AUTHORITY_UNAVAILABLE" });

  const changedGrants = fixture({
    grantIdsAt: (call) => call === 1
      ? ["profile-grant", "task-project-grant"]
      : ["replacement-profile-grant", "task-project-grant"],
  });
  expect(await changedGrants.handler(readRequest(changedGrants.projectRoot, {
    localExecutionBinding: development,
  }))).toMatchObject({ status: "error", errorCode: "TASK_PROJECT_FILE_AUTHORITY_UNAVAILABLE" });

  const changedProfile = fixture({
    grantIdsAt: () => ["profile-grant", "task-project-grant"],
    onResolve: (call) => { if (call > 1) throw new Error("PROFILE_BINDING_MISMATCH"); },
  });
  expect(await changedProfile.handler(readRequest(changedProfile.projectRoot, {
    localExecutionBinding: development,
  }))).toMatchObject({ status: "error", errorCode: "TASK_PROJECT_FILE_AUTHORITY_UNAVAILABLE" });

  const changedGeneration: RelayLocalExecutionBindingV4 = {
    ...development,
    generation: "another-host-generation",
  };
  const stale = fixture({ grantIdsAt: () => ["profile-grant", "task-project-grant"] });
  expect(await stale.handler(readRequest(stale.projectRoot, {
    localExecutionBinding: changedGeneration,
  }))).toMatchObject({ status: "error", errorCode: "TASK_PROJECT_FILE_AUTHORITY_UNAVAILABLE" });
  expect(stale.calls()).toBe(0);
});

test("rejects foreign roots, stale topology, expired or insufficient grants before file access", async () => {
  const foreign = fixture();
  const foreignRoot = join(foreign.baselineRoot, "nautilo-repo-docs", `task-run-${RUN_ID}`);
  mkdirSync(foreignRoot, { recursive: true });
  expect(await foreign.handler(readRequest(foreignRoot))).toMatchObject({
    status: "error",
    errorCode: "TASK_PROJECT_FILE_AUTHORITY_UNAVAILABLE",
  });

  const staleTopology = fixture({ contextPairingGeneration: "another-pair" });
  expect(await staleTopology.handler(readRequest(staleTopology.projectRoot))).toMatchObject({
    status: "error",
    errorCode: "TASK_PROJECT_FILE_AUTHORITY_UNAVAILABLE",
  });
  expect(staleTopology.calls()).toBe(0);

  const expired = fixture({ expiresAt: Date.now() - 1 });
  expect(await expired.handler(readRequest(expired.projectRoot))).toMatchObject({
    status: "error",
    errorCode: "TASK_PROJECT_FILE_AUTHORITY_UNAVAILABLE",
  });

  const readOnly = fixture({ access: ["read"] });
  const mutation = readRequest(readOnly.projectRoot, {
    impact: "destructive",
    localExecutionBinding: binding("input"),
    args: {
      operation: {
        kind: "file",
        command: "write",
        zone: "absolute",
        args: {
          path: join(readOnly.projectRoot, "inside.txt"),
          content: "must-not-write",
          _routing: { ownerId: HUMAN_ID, agentId: AGENT_ID, turnId: "turn-a", mutationRequestId: "mutation-a", currentFolder: null, workspaceRoot: "" },
        },
      },
      allowedRoots: [readOnly.projectRoot],
    },
  });
  expect(await readOnly.handler(mutation)).toMatchObject({
    status: "error",
    errorCode: "TASK_PROJECT_FILE_AUTHORITY_UNAVAILABLE",
  });
  expect(Bun.file(join(readOnly.projectRoot, "inside.txt")).text()).resolves.toBe("inside-only");
});

test("detects project-directory replacement and grant drift during immediate reproof", async () => {
  const replaced = fixture({
    onResolve(call, projectRoot) {
      if (call !== 2) return;
      rmSync(projectRoot, { recursive: true, force: true });
      mkdirSync(projectRoot, { recursive: true });
      writeFileSync(join(projectRoot, "inside.txt"), "replacement");
    },
  });
  expect(await replaced.handler(readRequest(replaced.projectRoot))).toMatchObject({
    status: "error",
    errorCode: "TASK_PROJECT_FILE_AUTHORITY_UNAVAILABLE",
  });

  const reduced = fixture({ accessAt: (call) => call === 1 ? ["read", "create_modify"] : ["read"] });
  expect(await reduced.handler(readRequest(reduced.projectRoot))).toMatchObject({
    status: "error",
    errorCode: "TASK_PROJECT_FILE_AUTHORITY_UNAVAILABLE",
  });
});

test("fails closed without a local resolver and honors abort before authority lookup", async () => {
  const f = fixture();
  const withoutResolver = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: f.baselineRoot }), {
    relayId: "relay-a",
    protectedPathPolicy: { check: () => ({ allowed: true }) } as never,
    taskProjectFileDispatchContext: () => ({
      capabilities: capabilities(), protocolVersion: 30, userId: HUMAN_ID, relayId: "relay-a",
      desktopSessionId: "desktop-a", pairingGeneration: "pair-a", instanceId: "instance-a",
    }),
  });
  expect(await withoutResolver(readRequest(f.projectRoot))).toMatchObject({
    status: "error",
    errorCode: "TASK_PROJECT_FILE_AUTHORITY_UNAVAILABLE",
  });

  const abort = new AbortController();
  abort.abort();
  expect(await f.handler(readRequest(f.projectRoot), abort.signal)).toMatchObject({
    status: "error",
    errorCode: "TASK_PROJECT_FILE_AUTHORITY_UNAVAILABLE",
  });
  expect(f.calls()).toBe(0);
});

test("reproves the same grant again inside the canonical content coordinator", async () => {
  let committed = 0;
  let revokedAtCommit = false;
  const f = fixture({
    accessAt: () => revokedAtCommit ? ["read"] : ["read", "create_modify"],
    commitContent: async (input) => {
      revokedAtCommit = true;
      await input.reauthorize();
      committed += 1;
      writeFileSync(input.targetPath, input.after);
      return {
        ok: true,
        operationId: "operation-a",
        revisionId: "revision-a",
        sha256: "0".repeat(64),
        before: input.before,
        after: input.after,
        byteLength: input.after.byteLength,
        replayed: false,
      };
    },
  });
  const mutation = readRequest(f.projectRoot, {
    impact: "destructive",
    localExecutionBinding: binding("input"),
    args: {
      operation: {
        kind: "file",
        command: "write",
        zone: "absolute",
        args: {
          path: join(f.projectRoot, "openwiki", "page.md"),
          content: "must-not-commit",
          _routing: {
            ownerId: HUMAN_ID,
            agentId: AGENT_ID,
            turnId: "turn-a",
            mutationRequestId: "mutation-a",
            currentFolder: null,
            workspaceRoot: "",
          },
        },
      },
      allowedRoots: [f.projectRoot],
    },
  });
  const denied = await f.handler(mutation);
  expect(JSON.stringify(denied)).toContain("TASK_PROJECT_FILE_AUTHORITY_UNAVAILABLE");
  expect(committed).toBe(0);
  expect(await Bun.file(join(f.projectRoot, "openwiki", "page.md")).text()).toBe("generated-page");
});
