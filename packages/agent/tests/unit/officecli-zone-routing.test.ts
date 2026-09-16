/**
 * M206 — `officecli` current/absolute zone routing through typed `local-file`
 * office dispatch (no server staging or fs byte transport).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import type { OfficeCliRunResult } from "@nautilo/config/officecli";
import type { RelayCapabilities, RelayDispatchResult } from "@nautilo/relay";
import { RELAY_PROTOCOL_VERSION } from "@nautilo/relay";
import type { ToolRelayRegistry } from "../../src/nodes/tools";
import { setRelayRegistry } from "../../src/nodes/tools";
import { createOfficeCliTool, type CreateOfficeCliToolDeps } from "../../src/tools/office/officecli";
import type {
  WorkspaceOfficeCliCommitExecution,
  WorkspaceOfficeCliCommitRequest,
} from "../../src/tools/office/workspace-runtime-adapter";

const USER_A = "00000000-0000-0000-0000-0000000000a0";
const AGENT_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const NS_A1 = "11111111-1111-1111-1111-111111111101";
const ROOM_1 = "00000000-0000-0000-0000-0000000000a2";

function namespaceEnvelope(): MemoryAccessEnvelope {
  return {
    ownerId: USER_A,
    actorId: "00000000-0000-0000-0000-0000000000a1",
    agentId: AGENT_1,
    roomId: ROOM_1,
    readableNamespaces: [NS_A1],
    mutableNamespaces: [NS_A1],
    writableNamespaces: [NS_A1],
    toolPolicy: {},
  };
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
function ooxml(tag: string): Buffer {
  return Buffer.concat([ZIP_MAGIC, Buffer.from(tag)]);
}

interface OfficeDispatchCall {
  subkind: string;
  command?: string | undefined;
  mutating: boolean;
}

function makeRelayRegistry(opts: { canRunOffice?: boolean } = {}): {
  registry: ToolRelayRegistry;
  calls: OfficeDispatchCall[];
} {
  const calls: OfficeDispatchCall[] = [];
  const caps: RelayCapabilities = {
    profile: "desktop-agent",
    canReadWorkspace: true,
    canWriteWorkspace: true,
    localFileExecution: true,
    canRunOffice: opts.canRunOffice ?? true,
    allowedRoots: ["/"],
  };
  const registry: ToolRelayRegistry = {
    findByCapabilityForUser(capability: string): string[] {
      return (caps as unknown as Record<string, unknown>)[capability] === true ? ["relay-1"] : [];
    },
    getCapabilities(): RelayCapabilities {
      return caps;
    },
    getProtocolVersion(): number {
      return RELAY_PROTOCOL_VERSION;
    },
    async dispatch(): Promise<RelayDispatchResult> {
      throw new Error("fs dispatch must not be called by officecli zone routing");
    },
    async localFileDispatch(_relayId, req, meta) {
      const op = req.operation;
      if (op.kind !== "office") throw new Error("expected office operation");
      calls.push({
        subkind: String(op.operation["subkind"]),
        command: typeof op.operation["command"] === "string" ? op.operation["command"] : undefined,
        mutating: meta.mutating,
      });
      if (op.operation["command"] === "view") {
        return { ok: true, result: JSON.stringify({ ok: true, command: "view" }) };
      }
      return {
        ok: true,
        result: {
          applied: true,
          path: "report.docx",
          byteLength: 128,
          summary: "Applied officecli set report.docx (128 bytes).",
        },
      };
    },
  };
  return { registry, calls };
}

let tmpRoot = "";
let currentFolder = "";
let runnerCalls: string[][] = [];

async function fakeRun(argv: readonly string[]): Promise<OfficeCliRunResult> {
  const call = [...argv];
  runnerCalls.push(call);
  const command = call[0];
  if (command && call[1]) {
    await writeFile(call[1], ooxml(String(command)));
  }
  return { stdout: JSON.stringify({ ok: true, command }), stderr: "", exitCode: 0 };
}

const applyBinaryContentPatchMock = mock(
  async (args: Parameters<NonNullable<CreateOfficeCliToolDeps["applyBinaryContentPatch"]>>[0]) => ({
    applied: true as const,
    path: args.resolution.resolved,
    zone: args.resolution.resolvedZone,
    command: args.command,
    stats: { additions: 0, deletions: 0 },
    summary: args.summary,
    unifiedDiff: "Binary files differ\n",
    binary: true as const,
    bytes: args.bytes,
    ...(args.ctx.workspaceArtifactMeta ? { artifactId: args.ctx.workspaceArtifactMeta.artifactId } : {}),
  }),
);

const workspaceCommitExecutionMock = mock(
  async (
    request: WorkspaceOfficeCliCommitRequest,
  ): ReturnType<WorkspaceOfficeCliCommitExecution> => ({
    ok: true,
    revisionId: `revision-${request.outputPath}`,
    artifactInternalId: `created-${request.outputPath}`,
    artifactId: `created-${request.outputPath}`,
  }),
);

const resolveWorkspaceArtifactMock = mock(async (params: { logicalPath: string; intent: string }) => {
  if (params.intent === "create") {
    return {
      ok: true,
      artifact: null,
      physicalPath: join(tmpRoot, "ws-output.bin"),
      artifactId: `art-${params.logicalPath}`,
      storageUri: `file://${join(tmpRoot, "ws-output.bin")}`,
      logicalPath: params.logicalPath,
    };
  }
  return { ok: false, reason: `unexpected intent ${params.intent}` };
});

function baseCtx() {
  return {
    ownerId: USER_A,
    agentId: AGENT_1,
    roomId: ROOM_1,
    turnId: "turn-officecli",
    workspacePath: tmpRoot,
    currentFolder,
    memoryAccessEnvelope: namespaceEnvelope(),
  };
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "officecli-zone-test-"));
  currentFolder = tmpRoot;
  runnerCalls = [];
  applyBinaryContentPatchMock.mockClear();
  workspaceCommitExecutionMock.mockClear();
  resolveWorkspaceArtifactMock.mockClear();
});

describe("officecli zone routing (M206)", () => {
  test('zone "current" with no relay registry returns desktop OfficeCLI required error', async () => {
    setRelayRegistry(null);
    const tool = createOfficeCliTool(baseCtx(), {
      run: fakeRun,
      tempDirRoot: tmpRoot,
    });

    const result = String(
      await tool.invoke({ command: "view", zone: "current", path: "report.docx", mode: "text" }),
    );

    expect(result).toContain("desktop app");
    expect(result).toContain("OfficeCLI");
    expect(runnerCalls).toHaveLength(0);
  });

  test('zone "current" without canRunOffice fails closed', async () => {
    const { registry } = makeRelayRegistry({ canRunOffice: false });
    setRelayRegistry(registry);
    const tool = createOfficeCliTool(baseCtx(), {
      run: fakeRun,
      tempDirRoot: tmpRoot,
    });

    const result = String(
      await tool.invoke({ command: "view", zone: "current", path: "report.docx", mode: "text" }),
    );

    expect(result).toContain("LOCAL_FILE_EXECUTION_UNSUPPORTED");
    expect(runnerCalls).toHaveLength(0);
  });

  test('zone "current" read dispatches one local-file office operation', async () => {
    const { registry, calls } = makeRelayRegistry();
    setRelayRegistry(registry);
    const tool = createOfficeCliTool(baseCtx(), {
      run: fakeRun,
      tempDirRoot: tmpRoot,
    });

    const result = String(
      await tool.invoke({ command: "view", zone: "current", path: "report.docx", mode: "text" }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.subkind).toBe("officecli");
    expect(calls[0]?.command).toBe("view");
    expect(calls[0]?.mutating).toBe(false);
    expect(result).toContain('"ok":true');
    expect(runnerCalls).toHaveLength(0);
  });

  test('zone "current" write dispatches mutating local-file office operation', async () => {
    const { registry, calls } = makeRelayRegistry();
    setRelayRegistry(registry);
    const tool = createOfficeCliTool(baseCtx(), {
      run: fakeRun,
      tempDirRoot: tmpRoot,
    });

    const result = String(
      await tool.invoke({
        command: "set",
        zone: "current",
        path: "report.docx",
        out: "report.docx",
        target: "/body/p[1]",
        props: { text: "Hello" },
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.mutating).toBe(true);
    expect(result).toContain("Applied officecli set");
    expect(runnerCalls).toHaveLength(0);
  });

  test('zone "workspace" uses the canonical Workspace commit port, never local office dispatch or the legacy binary patch path', async () => {
    const { registry, calls } = makeRelayRegistry();
    setRelayRegistry(registry);
    const tool = createOfficeCliTool(baseCtx(), {
      run: fakeRun,
      workspaceCommitExecution: workspaceCommitExecutionMock,
      applyBinaryContentPatch: applyBinaryContentPatchMock,
      resolveWorkspaceArtifact:
        resolveWorkspaceArtifactMock as unknown as NonNullable<CreateOfficeCliToolDeps["resolveWorkspaceArtifact"]>,
      tempDirRoot: tmpRoot,
    });

    const result = String(
      await tool.invoke({
        command: "create",
        zone: "workspace",
        out: "generated/sample.docx",
        commands: [{ command: "add", parent: "/", type: "paragraph", props: { text: "hi" } }],
      }),
    );

    const parsed = JSON.parse(result) as { applied: true; binary: true };
    expect(parsed.applied).toBe(true);
    expect(workspaceCommitExecutionMock).toHaveBeenCalledTimes(1);
    expect(applyBinaryContentPatchMock).toHaveBeenCalledTimes(0);
    expect(calls).toHaveLength(0);
  });
});
