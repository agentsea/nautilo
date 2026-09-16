import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { detectOfficeCliPlatformKey, type OfficeCliPlatformKey, type OfficeCliRunResult } from "@nautilo/config/officecli";
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

function artifact(path: string, physicalPath: string) {
  return {
    id: `row-${path}`,
    artifactId: `art-${path}`,
    path,
    storageUri: `file://${physicalPath}`,
    size: 4,
    revision: 1,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

let tmpRoot = "";
let inputPhysical = "";
let outputPhysical = "";
let runnerCalls: string[][] = [];

// Real OOXML/ZIP local-file magic (PK\x03\x04). The tool guards against
// blank/corrupt output by requiring this prefix, so fixtures must emit it —
// the trailing tag identifies which command produced the bytes.
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
function ooxml(tag: string): Buffer {
  return Buffer.concat([ZIP_MAGIC, Buffer.from(tag)]);
}

const applyBinaryContentPatchMock = mock(async (args: Parameters<NonNullable<CreateOfficeCliToolDeps["applyBinaryContentPatch"]>>[0]) => {
  await writeFile(args.resolution.resolved, args.newBytes);
  return {
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
  };
});

const workspaceCommitExecutionMock = mock(
  async (
    request: WorkspaceOfficeCliCommitRequest,
  ): ReturnType<WorkspaceOfficeCliCommitExecution> => {
    const inPlace =
      request.source !== undefined &&
      request.source.logicalPath === request.outputPath;
    const artifactInternalId = inPlace
      ? request.source.artifactInternalId
      : `created-${request.outputPath}`;
    return {
      ok: true,
      revisionId: `revision-${request.outputPath}`,
      artifactInternalId,
      artifactId: inPlace ? request.source.artifactId : artifactInternalId,
    };
  },
);

const resolveWorkspaceArtifactMock = mock(async (params: {
  logicalPath: string;
  intent: "read" | "mutate" | "create" | "create_or_update";
}) => {
  if (params.intent === "read") {
    return {
      ok: true,
      artifact: artifact(params.logicalPath, inputPhysical),
      physicalPath: inputPhysical,
      artifactId: `art-${params.logicalPath}`,
      storageUri: `file://${inputPhysical}`,
      logicalPath: params.logicalPath,
    };
  }
  if (params.intent === "create") {
    return {
      ok: true,
      artifact: null,
      physicalPath: outputPhysical,
      artifactId: `art-${params.logicalPath}`,
      storageUri: `file://${outputPhysical}`,
      logicalPath: params.logicalPath,
    };
  }
  if (params.intent === "create_or_update" || params.intent === "mutate") {
    // In-place path: reuse the existing input artifact row + physical bytes.
    return {
      ok: true,
      artifact: artifact(params.logicalPath, inputPhysical),
      physicalPath: inputPhysical,
      artifactId: `art-${params.logicalPath}`,
      storageUri: `file://${inputPhysical}`,
      logicalPath: params.logicalPath,
    };
  }
  return { ok: false, reason: "unexpected resolver intent" };
});

async function fakeRun(argv: readonly string[]): Promise<OfficeCliRunResult> {
  const call = [...argv];
  runnerCalls.push(call);
  const command = call[0];
  if (command === "create") {
    await writeFile(call[1]!, ooxml(`doc:${basename(call[1]!)}`));
  }
  if (command === "batch") {
    await writeFile(call[1]!, ooxml(`batch:${basename(call[1]!)}`));
  }
  if (command === "set") {
    await writeFile(call[1]!, ooxml("edited"));
  }
  if (command === "merge") {
    await writeFile(call[2]!, ooxml("merged"));
  }
  if (command === "view" && call[2] === "screenshot") {
    const outIndex = call.indexOf("--out");
    if (outIndex >= 0) await writeFile(call[outIndex + 1]!, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  }
  return { stdout: JSON.stringify({ success: true }), stderr: "", exitCode: 0 };
}

function deps(overrides: Partial<CreateOfficeCliToolDeps> = {}): CreateOfficeCliToolDeps {
  const base: CreateOfficeCliToolDeps = {
    run: fakeRun,
    workspaceCommitExecution: workspaceCommitExecutionMock,
    applyBinaryContentPatch: applyBinaryContentPatchMock,
    resolveWorkspaceArtifact: resolveWorkspaceArtifactMock as unknown as NonNullable<CreateOfficeCliToolDeps["resolveWorkspaceArtifact"]>,
    tempDirRoot: tmpRoot,
  };
  return Object.assign(base, overrides);
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "officecli-tool-test-"));
  inputPhysical = join(tmpRoot, "input.docx");
  outputPhysical = join(tmpRoot, "output.bin");
  await writeFile(inputPhysical, ooxml("input"));
  runnerCalls = [];
  applyBinaryContentPatchMock.mockClear();
  workspaceCommitExecutionMock.mockClear();
  resolveWorkspaceArtifactMock.mockClear();
});

function pngBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function lastBatchCommands(): Array<{ command: string; parent?: string; type?: string; props?: Record<string, string> }> {
  const batchCall = runnerCalls.find((argv) => argv[0] === "batch");
  expect(batchCall).toBeDefined();
  const commandsIndex = batchCall!.indexOf("--commands");
  expect(commandsIndex).toBeGreaterThan(-1);
  return JSON.parse(batchCall![commandsIndex + 1]!) as Array<{ command: string; parent?: string; type?: string; props?: Record<string, string> }>;
}

async function installHermeticVendoredOfficeCli(
  root: string,
): Promise<{ vendorRoot: string; binaryPath: string; platformKey: OfficeCliPlatformKey }> {
  const platformKey = detectOfficeCliPlatformKey();
  if (platformKey === null) {
    throw new Error("unsupported test platform");
  }
  const vendorRoot = join(root, "vendor-officecli");
  const binaryPath = join(vendorRoot, platformKey, "officecli");
  await mkdir(dirname(binaryPath), { recursive: true });
  await writeFile(binaryPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(
    join(vendorRoot, "manifest.json"),
    JSON.stringify({
      officecli: {
        version: "test",
        source: "https://example.com/officecli",
        license: "Apache-2.0",
        artifacts: {
          [platformKey]: { sha256: "a".repeat(64) },
        },
      },
    }),
  );
  return { vendorRoot, binaryPath, platformKey };
}

describe("officecli tool", () => {
  test("resolves the bundled officecli binary with OFFICECLI_PATH unset", async () => {
    outputPhysical = join(tmpRoot, "zero-config-output.bin");
    const previousOfficeCliPath = process.env["OFFICECLI_PATH"];
    const previousVendorRoot = process.env["OFFICECLI_VENDOR_ROOT"];
    delete process.env["OFFICECLI_PATH"];
    const { vendorRoot, binaryPath } = await installHermeticVendoredOfficeCli(tmpRoot);
    process.env["OFFICECLI_VENDOR_ROOT"] = vendorRoot;
    let resolvedBinaryPath: string | null = null;

    try {
      const tool = createOfficeCliTool(
        { ownerId: USER_A, agentId: AGENT_1, roomId: ROOM_1, turnId: "turn-officecli", memoryAccessEnvelope: namespaceEnvelope() },
        {
          makeOfficeCreateRun: (options) => {
            resolvedBinaryPath = options.binaryPath;
            return fakeRun;
          },
          workspaceCommitExecution: workspaceCommitExecutionMock,
          applyBinaryContentPatch: applyBinaryContentPatchMock,
          resolveWorkspaceArtifact: resolveWorkspaceArtifactMock as unknown as NonNullable<CreateOfficeCliToolDeps["resolveWorkspaceArtifact"]>,
          tempDirRoot: tmpRoot,
        },
      );

      const result = String(await tool.invoke({
        command: "create",
        out: "generated/zero-config.docx",
        commands: [{ command: "add", parent: "/", type: "paragraph", props: { text: "zero config" } }],
      }));

      expect(result).not.toContain("binary not found");
      expect(resolvedBinaryPath).not.toBeNull();
      expect(resolvedBinaryPath!).toBe(binaryPath);
      const parsed = JSON.parse(result) as { applied: true; binary: true };
      expect(parsed.applied).toBe(true);
      expect(parsed.binary).toBe(true);
    } finally {
      if (previousOfficeCliPath === undefined) {
        delete process.env["OFFICECLI_PATH"];
      } else {
        process.env["OFFICECLI_PATH"] = previousOfficeCliPath;
      }
      if (previousVendorRoot === undefined) {
        delete process.env["OFFICECLI_VENDOR_ROOT"];
      } else {
        process.env["OFFICECLI_VENDOR_ROOT"] = previousVendorRoot;
      }
    }
  });

  test("rejects blank/unflushed output and persists nothing (D396 0-byte bug guard)", async () => {
    // Regression: OfficeCLI's default resident defers the disk write, so a
    // process that mutates then exits without flush leaves a blank file. The
    // tool must NOT persist that or report success.
    outputPhysical = join(tmpRoot, "blank-output.bin");
    const blankRun = async (argv: readonly string[]) => {
      const call = [...argv];
      if (call[0] === "create" || call[0] === "batch") {
        await writeFile(call[1]!, Buffer.alloc(0)); // 0-byte — the unflushed-resident symptom
      }
      return { stdout: JSON.stringify({ success: true }), stderr: "", exitCode: 0 };
    };
    const tool = createOfficeCliTool(
      { ownerId: USER_A, agentId: AGENT_1, roomId: ROOM_1, turnId: "turn-officecli", memoryAccessEnvelope: namespaceEnvelope() },
      {
        resolveOfficeCliPath: () => join(tmpRoot, "stub-officecli"),
        makeOfficeCreateRun: () => blankRun,
        workspaceCommitExecution: workspaceCommitExecutionMock,
        applyBinaryContentPatch: applyBinaryContentPatchMock,
        resolveWorkspaceArtifact: resolveWorkspaceArtifactMock as unknown as NonNullable<CreateOfficeCliToolDeps["resolveWorkspaceArtifact"]>,
        tempDirRoot: tmpRoot,
      },
    );

    const result = String(await tool.invoke({
      command: "create",
      out: "generated/blank.docx",
      commands: [{ command: "add", parent: "/", type: "paragraph", props: { text: "should not persist" } }],
    }));

    expect(result).toContain("invalid Office document");
    // Nothing may be persisted — the blank bytes never reach the patch pipeline.
    expect(applyBinaryContentPatchMock).toHaveBeenCalledTimes(0);
  });

  test("rejects malformed batch objects before spawning OfficeCLI", async () => {
    const tool = createOfficeCliTool(
      { ownerId: USER_A, agentId: AGENT_1, roomId: ROOM_1, turnId: "turn-officecli", memoryAccessEnvelope: namespaceEnvelope() },
      deps(),
    );

    let threw = false;
    const malformedInput: unknown = {
        command: "create",
        out: "generated/bad-batch.docx",
        commands: [
          // Regression for Jeannie's failed run: the raw escape hatch must use
          // OfficeCLI's exact batch shape (`command`, and add uses parent+type).
          { cmd: "add", path: "/body/p[1]", props: { text: "bad" } },
        ],
      };
    try {
      tool.schema.parse(malformedInput);
    } catch (err) {
      threw = true;
      expect(String(err)).toContain("\"commands\"");
      expect(String(err)).toContain("\"command\"");
      expect(String(err)).toContain("No matching discriminator");
    }
    expect(threw).toBe(true);
    expect(runnerCalls).toHaveLength(0);
    expect(applyBinaryContentPatchMock).toHaveBeenCalledTimes(0);
  });

  test("creates workspace artifacts across Office formats through the injected runner", async () => {
    for (const ext of ["docx", "xlsx", "pptx"]) {
      outputPhysical = join(tmpRoot, `created-${ext}.bin`);
      const tool = createOfficeCliTool(
        { ownerId: USER_A, agentId: AGENT_1, roomId: ROOM_1, turnId: "turn-officecli", memoryAccessEnvelope: namespaceEnvelope() },
        deps(),
      );

      const result = String(await tool.invoke({
        command: "create",
        out: `generated/sample.${ext}`,
        commands: [{ command: "add", parent: "/", type: "paragraph", props: { text: ext } }],
      }));

      const parsed = JSON.parse(result) as { applied: true; binary: true; artifactId: string };
      expect(parsed.applied).toBe(true);
      expect(parsed.binary).toBe(true);
      expect(parsed.artifactId).toBe(`created-generated/sample.${ext}`);
    }

    expect(runnerCalls.some((argv) => argv[0] === "create" && argv.includes("--type") && argv.includes("docx"))).toBe(true);
    expect(runnerCalls.some((argv) => argv[0] === "create" && argv.includes("--type") && argv.includes("xlsx"))).toBe(true);
    expect(runnerCalls.some((argv) => argv[0] === "create" && argv.includes("--type") && argv.includes("pptx"))).toBe(true);
    expect(runnerCalls.some((argv) => argv[0] === "batch" && argv.includes("--commands"))).toBe(true);
    expect(workspaceCommitExecutionMock).toHaveBeenCalledTimes(3);
    expect(applyBinaryContentPatchMock).toHaveBeenCalledTimes(0);
  });

  test("rejects merge-only data before workspace generation or local relay dispatch", async () => {
    let localDispatches = 0;
    const localOperation = async () => {
      localDispatches += 1;
      return { ok: true as const, result: { applied: true } };
    };
    const context = {
      ownerId: USER_A,
      agentId: AGENT_1,
      roomId: ROOM_1,
      turnId: "turn-officecli",
      currentFolder: tmpRoot,
      memoryAccessEnvelope: namespaceEnvelope(),
    };

    for (const zone of ["workspace", "current"] as const) {
      const tool = createOfficeCliTool(context, deps({ executeLocalOfficeOperation: localOperation }));
      const result = String(await tool.invoke({
        command: "create",
        zone,
        out: `generated/${zone}.docx`,
        data: "# This must not be silently ignored",
      }));

      expect(result).toStartWith("Error: `data` is merge-only; use `commands` when creating a document.");
      expect(result).toContain('parent: "/body"');
      expect(result).toContain('type: "markdown"');
    }

    expect(runnerCalls).toHaveLength(0);
    expect(localDispatches).toBe(0);
    expect(workspaceCommitExecutionMock).not.toHaveBeenCalled();
    expect(applyBinaryContentPatchMock).not.toHaveBeenCalled();
  });

  test("runs path-inferred workspace help without treating create as a help verb", async () => {
    const helpCalls: string[][] = [];
    const tool = createOfficeCliTool(
      { ownerId: USER_A, agentId: AGENT_1, roomId: ROOM_1, turnId: "turn-officecli", memoryAccessEnvelope: namespaceEnvelope() },
      deps({
        run: async (argv) => {
          helpCalls.push([...argv]);
          return { stdout: "DOCX help", stderr: "", exitCode: 0 };
        },
      }),
    );

    const result = String(await tool.invoke({ command: "help", path: "reports/brief.docx" }));

    expect(helpCalls).toEqual([["help", "docx", "--json"]]);
    expect(result).toBe("DOCX help");
  });

  test("infers workspace help format and preserves each nonzero diagnostic fallback", async () => {
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

    for (const { response, expected } of cases) {
      const helpCalls: string[][] = [];
      const tool = createOfficeCliTool(
        { ownerId: USER_A, agentId: AGENT_1, roomId: ROOM_1, turnId: "turn-officecli", memoryAccessEnvelope: namespaceEnvelope() },
        deps({ run: async (argv) => { helpCalls.push([...argv]); return response; } }),
      );
      const result = String(await tool.invoke({ command: "help", path: "reports/brief.docx", verb: "create" }));

      expect(helpCalls).toEqual([["help", "docx", "create", "--json"]]);
      expect(result).toContain(expected);
    }
  });

  test("gives explicit help format priority over type and path", async () => {
    const helpCalls: string[][] = [];
    const tool = createOfficeCliTool(
      { ownerId: USER_A, agentId: AGENT_1, roomId: ROOM_1, turnId: "turn-officecli", memoryAccessEnvelope: namespaceEnvelope() },
      deps({
        run: async (argv) => {
          helpCalls.push([...argv]);
          return { stdout: "{}", stderr: "", exitCode: 0 };
        },
      }),
    );

    await tool.invoke({ command: "help", format: "pptx", type: "xlsx", path: "reports/brief.docx" });

    expect(helpCalls).toEqual([["help", "pptx", "--json"]]);
  });

  test("embeds generated workspace image inputs as picture batch commands with provenance", async () => {
    outputPhysical = join(tmpRoot, "deck-output.bin");
    const tool = createOfficeCliTool(
      { ownerId: USER_A, agentId: AGENT_1, roomId: ROOM_1, turnId: "turn-officecli", memoryAccessEnvelope: namespaceEnvelope() },
      deps({
        resolveImageBytes: async () => ({
          bytes: pngBytes(100, 50),
          fileName: "hero.png",
          mimeType: "image/png",
          artifactId: "img-art-1",
          logicalPath: "generated-images/2026-07-08/hero.png",
          provenance: { prompt: "blue whale", model: "openai:gpt-image-2" },
        }),
      }),
    );

    const result = String(await tool.invoke({
      command: "create",
      out: "generated/deck.pptx",
      commands: [{ command: "add", parent: "/", type: "slide", props: { title: "Hero" } }],
      imageInputs: [{
        source: "workspace",
        path: "generated-images/2026-07-08/hero.png",
        parent: "/slide[1]",
        at: "top-left",
        size: { w: 5 },
        alt: "Generated whale",
        provenance: { prompt: "blue whale", model: "openai:gpt-image-2", seed: "test" },
      }],
    }));

    const parsed = JSON.parse(result) as { applied: true; binary: true };
    expect(parsed.applied).toBe(true);
    expect(parsed.binary).toBe(true);
    const commands = lastBatchCommands();
    const picture = commands.find((cmd) => cmd.type === "picture");
    expect(picture).toBeDefined();
    expect(picture!.parent).toBe("/slide[1]");
    expect(picture!.props?.["path"]).toContain("officecli-images-");
    expect(picture!.props?.["x"]).toBe("0cm");
    expect(picture!.props?.["y"]).toBe("0cm");
    expect(picture!.props?.["width"]).toBe("5cm");
    expect(picture!.props?.["height"]).toBe("2.5cm");
    expect(picture!.props?.["alt"]).toBe("Generated whale");

    const commitCall = workspaceCommitExecutionMock.mock.calls[0]![0];
    const commandArgs = commitCall.commandArgs as { officecliImages?: Array<{ provenance?: Record<string, unknown> }> };
    expect(commandArgs.officecliImages?.[0]?.provenance?.["prompt"]).toBe("blue whale");
    expect(commandArgs.officecliImages?.[0]?.provenance?.["model"]).toBe("openai:gpt-image-2");
    expect(commandArgs.officecliImages?.[0]?.provenance?.["seed"]).toBe("test");
  });

  test("embeds user filesystem image inputs into an existing document via batch", async () => {
    const logoPath = join(tmpRoot, "logo.png");
    await writeFile(logoPath, pngBytes(200, 100));
    const tool = createOfficeCliTool(
      {
        ownerId: USER_A,
        agentId: AGENT_1,
        roomId: ROOM_1,
        turnId: "turn-officecli",
        currentFolder: tmpRoot,
        memoryAccessEnvelope: namespaceEnvelope(),
      },
      deps(),
    );

    const result = String(await tool.invoke({
      command: "batch",
      path: "docs/input.pptx",
      out: "docs/output.pptx",
      commands: [{ command: "add", parent: "/", type: "slide", props: { title: "Assets" } }],
      imageInputs: [{
        source: "fs",
        path: "logo.png",
        parent: "/slide[1]",
        at: { x: 1, y: 2 },
        w: 4,
      }],
    }));

    const parsed = JSON.parse(result) as { applied: true; binary: true };
    expect(parsed.applied).toBe(true);
    expect(parsed.binary).toBe(true);
    const picture = lastBatchCommands().find((cmd) => cmd.type === "picture");
    expect(picture).toBeDefined();
    expect(picture!.props?.["x"]).toBe("1cm");
    expect(picture!.props?.["y"]).toBe("2cm");
    expect(picture!.props?.["width"]).toBe("4cm");
    expect(picture!.props?.["height"]).toBe("2cm");
    expect(workspaceCommitExecutionMock).toHaveBeenCalledTimes(1);
    expect(applyBinaryContentPatchMock).toHaveBeenCalledTimes(0);
  });

  test("edits a copied input and delegates exact bytes to the Workspace coordinator port", async () => {
    const tool = createOfficeCliTool(
      { ownerId: USER_A, agentId: AGENT_1, roomId: ROOM_1, turnId: "turn-officecli", memoryAccessEnvelope: namespaceEnvelope() },
      deps(),
    );

    const result = String(await tool.invoke({
      command: "set",
      path: "docs/input.docx",
      out: "docs/output.docx",
      target: "/body/p[1]",
      props: { text: "Hello" },
    }));

    const parsed = JSON.parse(result) as { applied: true; binary: true };
    expect(parsed.applied).toBe(true);
    expect(parsed.binary).toBe(true);
    expect(runnerCalls.some((argv) => argv[0] === "set" && argv[2] === "/body/p[1]" && argv.includes("text=Hello"))).toBe(true);
    expect(workspaceCommitExecutionMock).toHaveBeenCalledTimes(1);
    expect(applyBinaryContentPatchMock).toHaveBeenCalledTimes(0);
    const commitCall = workspaceCommitExecutionMock.mock.calls[0]![0];
    expect([...commitCall.postImage]).toEqual([...ooxml("edited")]);
    expect([...(await readFile(inputPhysical))]).toEqual([...ooxml("input")]);
    expect(commitCall.outputPath).toBe("docs/output.docx");
    expect(commitCall.source).toMatchObject({
      artifactInternalId: "row-docs/input.docx",
      artifactId: "art-docs/input.docx",
      logicalPath: "docs/input.docx",
      revision: 1,
    });
  });

  test("edits closed workspace file in place when out equals path", async () => {
    const tool = createOfficeCliTool(
      { ownerId: USER_A, agentId: AGENT_1, roomId: ROOM_1, turnId: "turn-officecli", memoryAccessEnvelope: namespaceEnvelope() },
      deps(),
    );

    const result = String(await tool.invoke({
      command: "set",
      path: "docs/input.docx",
      out: "docs/input.docx",
      target: "/body/p[1]",
      props: { text: "InPlace" },
    }));

    const parsed = JSON.parse(result) as { applied: true; binary: true; artifactId: string };
    expect(parsed.applied).toBe(true);
    expect(parsed.binary).toBe(true);
    expect(parsed.artifactId).toBe("art-docs/input.docx");
    expect(workspaceCommitExecutionMock).toHaveBeenCalledTimes(1);
    expect(applyBinaryContentPatchMock).toHaveBeenCalledTimes(0);
    const commitCall = workspaceCommitExecutionMock.mock.calls[0]![0];
    expect(commitCall.outputPath).toBe("docs/input.docx");
    expect(commitCall.source).toMatchObject({
      artifactInternalId: "row-docs/input.docx",
      artifactId: "art-docs/input.docx",
    });
    // The coordinator stub is non-mutating; the producer cannot touch live bytes.
    expect([...(await readFile(inputPhysical))]).toEqual([...ooxml("input")]);
  });

  test("defaults omitted out to path for in-place closed-file mutation", async () => {
    const tool = createOfficeCliTool(
      { ownerId: USER_A, agentId: AGENT_1, roomId: ROOM_1, turnId: "turn-officecli", memoryAccessEnvelope: namespaceEnvelope() },
      deps(),
    );

    const result = String(await tool.invoke({
      command: "set",
      path: "docs/input.docx",
      target: "/body/p[1]",
      props: { text: "DefaultOut" },
    }));

    const parsed = JSON.parse(result) as { applied: true; binary: true };
    expect(parsed.applied).toBe(true);
    expect(workspaceCommitExecutionMock).toHaveBeenCalledTimes(1);
    expect(applyBinaryContentPatchMock).toHaveBeenCalledTimes(0);
    expect(workspaceCommitExecutionMock.mock.calls[0]![0].outputPath)
      .toBe("docs/input.docx");
  });

  test("renders screenshots with the injected runner and bypasses write lockout", async () => {
    const tool = createOfficeCliTool(
      { ownerId: USER_A, agentId: AGENT_1, roomId: ROOM_1, turnId: "turn-officecli", memoryAccessEnvelope: namespaceEnvelope() },
      deps({
        getOfficeSessionManager: () => ({
          hasActiveSession: () => true,
          async acquire() {
            return { error: "unused" };
          },
          invalidate() {},
          closeAll() {},
        }),
      }),
    );

    const result = String(await tool.invoke({
      command: "view",
      path: "docs/input.docx",
      mode: "screenshot",
      page: "1",
    }));

    const parsed = JSON.parse(result) as { ok: true; screenshots: Array<{ bytes: number; base64: string }> };
    expect(parsed.ok).toBe(true);
    expect(parsed.screenshots[0]!.bytes).toBe(4);
    expect(parsed.screenshots[0]!.base64.length).toBeGreaterThan(0);
    expect(applyBinaryContentPatchMock).not.toHaveBeenCalled();
  });

  test("surfaces view issues, dump, and merge commands", async () => {
    const tool = createOfficeCliTool(
      { ownerId: USER_A, agentId: AGENT_1, roomId: ROOM_1, turnId: "turn-officecli", memoryAccessEnvelope: namespaceEnvelope() },
      deps(),
    );

    const issues = JSON.parse(String(await tool.invoke({
      command: "view",
      path: "docs/input.docx",
      mode: "issues",
    }))) as { ok: true; issues: { success: boolean } };
    expect(issues.ok).toBe(true);
    expect(issues.issues.success).toBe(true);

    const dump = JSON.parse(String(await tool.invoke({
      command: "dump",
      path: "docs/input.docx",
      target: "/body",
    }))) as { success: boolean };
    expect(dump.success).toBe(true);

    const merged = JSON.parse(String(await tool.invoke({
      command: "merge",
      path: "docs/input.docx",
      out: "docs/merged.docx",
      data: { name: "Nautilo" },
    }))) as { applied: true; binary: true };
    expect(merged.applied).toBe(true);
    expect(merged.binary).toBe(true);
    expect(runnerCalls.some((argv) => argv[0] === "view" && argv[2] === "issues")).toBe(true);
    expect(runnerCalls.some((argv) => argv[0] === "dump")).toBe(true);
    expect(runnerCalls.some((argv) => argv[0] === "merge")).toBe(true);
  });

  test("stages extensionless workspace artifacts with their logical extension for read commands", async () => {
    inputPhysical = join(tmpRoot, "artifact-uuid-without-extension");
    await writeFile(inputPhysical, ooxml("extensionless-input"));
    const tool = createOfficeCliTool(
      { ownerId: USER_A, agentId: AGENT_1, roomId: ROOM_1, turnId: "turn-officecli", memoryAccessEnvelope: namespaceEnvelope() },
      deps(),
    );

    await tool.invoke({
      command: "view",
      path: "pressure-test/report3.docx",
      mode: "text",
    });

    const viewCall = runnerCalls.find((argv) => argv[0] === "view");
    expect(viewCall).toBeDefined();
    expect(basename(viewCall![1]!)).toBe("report3.docx");
    expect(viewCall![1]).not.toBe(inputPhysical);
  });

  test("reports the exact number of emitted text-view records without rewriting vendor totals", async () => {
    const tool = createOfficeCliTool(
      { ownerId: USER_A, agentId: AGENT_1, roomId: ROOM_1, turnId: "turn-officecli", memoryAccessEnvelope: namespaceEnvelope() },
      deps({
        run: async () => ({
          stdout: JSON.stringify({
            success: true,
            data: {
              totalElements: 3,
              elements: [
                { path: "/body/p[1]", type: "paragraph", text: "One" },
                { path: "/body/p[2]", type: "paragraph", text: "Two" },
              ],
            },
          }),
          stderr: "",
          exitCode: 0,
        }),
      }),
    );

    const result = JSON.parse(String(await tool.invoke({
      command: "view",
      path: "report.docx",
      mode: "text",
    }))) as { data: { totalElements: number; returnedElements: number; elements: unknown[] } };

    expect(result.data.totalElements).toBe(3);
    expect(result.data.returnedElements).toBe(2);
    expect(result.data.elements).toHaveLength(2);
  });

  test("describes complete reads and scopes the batch cap accurately", () => {
    const tool = createOfficeCliTool();
    const schema = tool.schema as unknown as {
      shape: {
        data: { description?: string };
        verb: { description?: string };
        commands: {
          unwrap: () => {
            element: { options: Array<{ shape: { command: { value?: string }; type?: { description?: string } } }> };
          };
        };
      };
    };
    const add = schema.shape.commands.unwrap().element.options.find((option) => option.shape.command.value === "add");

    expect(tool.description).toContain("use command=view with mode=text");
    expect(tool.description).toContain("omit start, end, maxLines, and limit");
    expect(tool.description).toContain("returnedElements");
    expect(tool.description).toContain("does not limit document elements or read results");
    expect(tool.description).toContain('"type":"markdown"');
    expect(tool.description).toContain("native Word elements");
    expect(tool.description).toContain("Top-level data is merge-only");
    expect(tool.description).toContain("Omit verb for create or general format help");
    expect(schema.shape.data.description).toContain("Merge-only template data");
    expect(schema.shape.data.description).toContain("Do not supply data to create");
    expect(schema.shape.verb.description).toContain("accepts add, set, get, query, or remove");
    expect(schema.shape.verb.description).toContain("create is a top-level command");
    expect(add?.shape.type?.description).toContain("type:'markdown'");
    expect(add?.shape.type?.description).toContain("native Word elements");
    expect(tool.description).not.toContain("edit_doc/office");
  });

  test("stages coordinator storage paths whose dot suffix is not an Office extension", async () => {
    inputPhysical = join(
      tmpRoot,
      "content-sha.42c75f99-d9bd-4261-b14f-804f3ffaa72f",
    );
    await writeFile(inputPhysical, ooxml("coordinator-output"));
    const tool = createOfficeCliTool(
      {
        ownerId: USER_A,
        agentId: AGENT_1,
        roomId: ROOM_1,
        turnId: "turn-officecli",
        memoryAccessEnvelope: namespaceEnvelope(),
      },
      deps(),
    );

    await tool.invoke({
      command: "view",
      path: "decks/coordinator-output.pptx",
      mode: "text",
    });

    const viewCall = runnerCalls.find((argv) => argv[0] === "view");
    expect(viewCall).toBeDefined();
    expect(basename(viewCall![1]!)).toBe("coordinator-output.pptx");
    expect(viewCall![1]).not.toBe(inputPhysical);
  });

  test("refuses workspace mutation when an editor session is open", async () => {
    const tool = createOfficeCliTool(
      { ownerId: USER_A, agentId: AGENT_1, roomId: ROOM_1, turnId: "turn-officecli", memoryAccessEnvelope: namespaceEnvelope() },
      deps({
        getOfficeSessionManager: () => ({
          hasActiveSession: () => true,
          async acquire() {
            return { error: "unused" };
          },
          invalidate() {},
          closeAll() {},
        }),
      }),
    );

    let refused = false;
    try {
      const result = String(await tool.invoke({
        command: "set",
        path: "docs/input.docx",
        out: "docs/output.docx",
        target: "/body/p[1]",
        props: { text: "Blocked" },
      }));
      refused = result.includes("refused to mutate");
    } catch {
      refused = false;
    }

    expect(refused).toBe(true);
    expect(runnerCalls).toHaveLength(0);
    expect(applyBinaryContentPatchMock).not.toHaveBeenCalled();
  });
});
