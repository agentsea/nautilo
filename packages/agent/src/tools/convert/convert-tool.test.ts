import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { runWithTurn } from "@nautilo/logger";
import { resolveConvertBackend } from "./backend-resolver";
import { createConvertTool, type ConvertToolDeps } from "./convert-tool";
import { runWithCapabilityFundingSession, type CapabilityFundingSession } from "../../runtime/capability-funding";
import { runWithUsageContext } from "../../usage/usage-context";
import type { ConversionRuntime } from "./conversion-runtime";
import {
  setWorkspaceFileContentCommitExecution,
  setWorkspaceFileContentRecoveryExecution,
  type WorkspaceFileContentCommitExecution,
  type WorkspaceFileContentRecoveryExecution,
} from "../file/workspace-runtime-adapter";

function sha(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function conversionRuntime(overrides: Partial<ConversionRuntime> = {}): ConversionRuntime {
  return {
    execute: async () => ({
      status: "error",
      code: "unused",
      message: "unused",
      retryable: false,
      uncertainEffect: false,
    }),
    resume: async () => ({
      status: "error",
      code: "unused",
      message: "unused",
      retryable: false,
      uncertainEffect: false,
    }),
    resumePublication: async () => ({
      status: "error",
      code: "unused",
      message: "unused",
      retryable: false,
      uncertainEffect: false,
    }),
    confirmPublication: async () => undefined,
    failPublication: async () => undefined,
    cancel: async () => ({
      status: "error",
      code: "unused",
      message: "unused",
      retryable: false,
      uncertainEffect: false,
    }),
    ...overrides,
  };
}

const memoryAccessEnvelope = {
  ownerId: "owner-1",
  actorId: "owner-1",
  agentId: "agent-1",
  roomId: "room-1",
  readableNamespaces: ["10000000-0000-4000-8000-000000000004"],
  mutableNamespaces: ["10000000-0000-4000-8000-000000000004"],
  writableNamespaces: ["10000000-0000-4000-8000-000000000004"],
  toolPolicy: {},
};

function durableToolContext() {
  return {
    ownerId: "owner-1",
    causalHumanUserId: "owner-1",
    workspacePath: "/unused",
    currentFolder: "/unused",
    agentId: "agent-1",
    roomId: "room-1",
    stableToolCallId: "tool-call-1",
    memoryAccessEnvelope,
  };
}

function destinationPreparer(
  mode: "create" | "update" = "create",
  revision = 1,
): NonNullable<ConvertToolDeps["prepareWorkspaceDestination"]> {
  return async (destinationPath, _zone, _zoneCtx, ctx) => ({
    ok: true,
    resolution: { resolved: path.join(baseDir, destinationPath), resolvedZone: "workspace" },
    ctx: {
      ...ctx,
      workspaceArtifactMeta: {
        mode,
        artifactId: "artifact-1",
        logicalPath: destinationPath,
        namespaceId: "10000000-0000-4000-8000-000000000004",
        storageUri: `artifact://${destinationPath}`,
        mimeType: "application/pdf",
        ...(mode === "update" ? {
          rowId: "10000000-0000-4000-8000-000000000020",
          expectedRevision: revision,
        } : {}),
      },
    },
  });
}

const personalCapability = {
  humanUserId: "owner-1",
  async resolveModel() { throw new Error("unused"); },
  async openModel() { throw new Error("unused"); },
  async openService() { throw new Error("unused"); },
} as CapabilityFundingSession;

const serverCapability = {
  ...personalCapability,
  parentFundingKind: "server" as const,
};

const originalBackendEnv = process.env["NAUTILO_CONVERT_BACKEND"];
const originalCloudKey = process.env["CLOUDCONVERT_API_KEY"];

let baseDir: string;
let workspaceRoot: string;
let currentFolder: string;

beforeAll(async () => {
  baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), "nautilo-convert-tool-"));
  workspaceRoot = path.join(baseDir, "workspace");
  currentFolder = path.join(baseDir, "current");
  await fsp.mkdir(workspaceRoot, { recursive: true });
  await fsp.mkdir(currentFolder, { recursive: true });
});

afterAll(async () => {
  await fsp.rm(baseDir, { recursive: true, force: true });
});

afterEach(() => {
  setWorkspaceFileContentCommitExecution(undefined);
  setWorkspaceFileContentRecoveryExecution(undefined);
  if (originalBackendEnv === undefined) {
    delete process.env["NAUTILO_CONVERT_BACKEND"];
  } else {
    process.env["NAUTILO_CONVERT_BACKEND"] = originalBackendEnv;
  }
  if (originalCloudKey === undefined) {
    delete process.env["CLOUDCONVERT_API_KEY"];
  } else {
    process.env["CLOUDCONVERT_API_KEY"] = originalCloudKey;
  }
});

describe("resolveConvertBackend", () => {
  test("explicit backend wins over env and default", () => {
    process.env["NAUTILO_CONVERT_BACKEND"] = "cloud";
    const result = resolveConvertBackend({
      explicit: "local",
      inputFormat: "md",
      outputFormat: "pdf",
      isCloudConfigured: () => true,
    });
    expect(result).toEqual({ ok: true, backend: "local" });
  });

  test("NAUTILO_CONVERT_BACKEND env applies when explicit omitted", () => {
    delete process.env["NAUTILO_CONVERT_BACKEND"];
    process.env["NAUTILO_CONVERT_BACKEND"] = "cloud";
    const result = resolveConvertBackend({
      inputFormat: "html",
      outputFormat: "pdf",
      isCloudConfigured: () => true,
    });
    expect(result).toEqual({ ok: true, backend: "cloud" });
  });

  test("defaults to local when no explicit or env", () => {
    delete process.env["NAUTILO_CONVERT_BACKEND"];
    const result = resolveConvertBackend({
      inputFormat: "md",
      outputFormat: "docx",
      isCloudConfigured: () => false,
    });
    expect(result).toEqual({ ok: true, backend: "local" });
  });

  test("auto prefers local for md→pdf", () => {
    const result = resolveConvertBackend({
      explicit: "auto",
      inputFormat: "md",
      outputFormat: "pdf",
      isCloudConfigured: () => true,
    });
    expect(result).toEqual({ ok: true, backend: "local" });
  });

  test("auto falls through to cloud when local cannot handle pair", () => {
    const result = resolveConvertBackend({
      explicit: "auto",
      inputFormat: "html",
      outputFormat: "pdf",
      isCloudConfigured: () => true,
    });
    expect(result).toEqual({ ok: true, backend: "cloud" });
  });

  test("auto fails closed when cloud is needed but not configured", () => {
    const result = resolveConvertBackend({
      explicit: "auto",
      inputFormat: "html",
      outputFormat: "pdf",
      isCloudConfigured: () => false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("No backend can convert");
    }
  });

  test("cloud backend fails closed without API key", () => {
    const result = resolveConvertBackend({
      explicit: "cloud",
      inputFormat: "html",
      outputFormat: "pdf",
      isCloudConfigured: () => false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("CloudConvert is not connected");
    }
  });
});

describe("convert tool description", () => {
  test("keyless description omits cloud format matrix", () => {
    const description = createConvertTool(undefined, {
      isCloudConvertConfigured: () => false,
    }).description;
    expect(description).toContain("Markdown → PDF or DOCX");
    expect(description).not.toContain("CloudConvert routes");
  });

  test("keyed description advertises cloud matrix", () => {
    const description = createConvertTool(undefined, {
      isCloudConvertConfigured: () => true,
    }).description;
    expect(description).toContain("CloudConvert routes");
    expect(description).toContain("HTML → PDF");
  });

  test("personal capability description does not advertise CloudConvert", () => {
    const description = runWithCapabilityFundingSession(personalCapability, () =>
      createConvertTool(undefined, { isCloudConvertConfigured: () => true }).description);
    expect(description).toContain("Markdown → PDF or DOCX");
    expect(description).not.toContain("CloudConvert routes");
  });

  test("server-funded capability description preserves configured cloud conversion", () => {
    const description = runWithCapabilityFundingSession(serverCapability, () =>
      createConvertTool(undefined, { isCloudConvertConfigured: () => true }).description);
    expect(description).toContain("CloudConvert routes");
  });

  test("personal capability advertises CloudConvert when the durable runtime is installed", () => {
    const description = runWithCapabilityFundingSession(personalCapability, () =>
      createConvertTool(undefined, {
        isCloudConvertConfigured: () => false,
        conversionRuntime: conversionRuntime(),
      }).description);
    expect(description).toContain("CloudConvert routes");
  });
});

describe("createConvertTool", () => {
  test("refuses durable dispatch without a canonical stable tool-call identity", async () => {
    const execute = mock(async (_input: Parameters<ConversionRuntime["execute"]>[0]) => ({
      status: "error" as const,
      code: "must_not_execute",
      message: "must not execute",
      retryable: false,
      uncertainEffect: false,
    }));
    const tool = createConvertTool({ ...durableToolContext(), stableToolCallId: "" }, {
      conversionRuntime: conversionRuntime({ execute }),
    });
    const result = await runWithTurn("turn-without-stable-call", () => tool.invoke({
      html: "<p>Hi</p>",
      format: "pdf",
      destinationPath: "report.pdf",
      backend: "cloud",
    }));
    expect(String(result)).toContain("requires trusted Human, Room, turn, and tool-call identity");
    expect(execute).not.toHaveBeenCalled();
  });

  test("rejects an invalid normalized output format before durable dispatch", async () => {
    const execute = mock(async (_input: Parameters<ConversionRuntime["execute"]>[0]) => ({
      status: "error" as const,
      code: "must_not_execute",
      message: "must not execute",
      retryable: false,
      uncertainEffect: false,
    }));
    const tool = createConvertTool(durableToolContext(), {
      conversionRuntime: conversionRuntime({ execute }),
    });
    const result = await runWithTurn("turn-invalid-format", () => tool.invoke({
      html: "<p>Hi</p>",
      format: ".",
      destinationPath: "report.",
      backend: "cloud",
    }));
    expect(String(result)).toContain("format must normalize to 1-32");
    expect(execute).not.toHaveBeenCalled();
  });

  test("exposes durable cancellation by opaque recovery handle", async () => {
    const cancel = mock(async (_input: Parameters<ConversionRuntime["cancel"]>[0]) => ({
      status: "error" as const,
      code: "conversion_cancel_pending",
      message: "Cancellation is pending.",
      retryable: true,
      uncertainEffect: true,
      recoveryHandle: `cvr_${"a".repeat(32)}`,
    }));
    const tool = createConvertTool({ causalHumanUserId: "owner-1" }, {
      conversionRuntime: conversionRuntime({ cancel }),
    });
    const controller = new AbortController();
    const result = await tool.invoke({
      action: "cancel",
      recoveryHandle: `cvr_${"a".repeat(32)}`,
    }, { signal: controller.signal });
    expect(cancel).toHaveBeenCalledWith({
      operationKey: `cvr_${"a".repeat(32)}`,
      causalHumanUserId: "owner-1",
      signal: controller.signal,
    });
    expect(String(result)).toContain("conversion_cancel_pending");
  });

  test("publishes a durable start through the canonical Artifact commit port", async () => {
    const output = Buffer.from("%PDF-durable");
    const execute = mock(async (_input: Parameters<ConversionRuntime["execute"]>[0]) => ({
      status: "ready_to_publish" as const,
      operationKey: "1".repeat(64),
      recoveryHandle: `cvr_${"2".repeat(32)}`,
      outputFormat: "pdf",
      bytes: output,
      outputSha256: "3".repeat(64),
    }));
    const confirmPublication = mock(async () => undefined);
    const commit = mock(async (_request: Parameters<WorkspaceFileContentCommitExecution>[0]) => ({
      ok: true as const,
      revisionId: "10000000-0000-4000-8000-000000000030",
      artifactId: "artifact-1",
      artifactInternalId: "10000000-0000-4000-8000-000000000020",
    }));
    setWorkspaceFileContentCommitExecution(commit);
    const controller = new AbortController();
    const tool = createConvertTool(durableToolContext(), {
      conversionRuntime: conversionRuntime({ execute, confirmPublication }),
      prepareWorkspaceDestination: destinationPreparer(),
    });
    const result = await runWithTurn("turn-durable-start", () => tool.invoke({
      html: "<p>Hi</p>",
      format: "pdf",
      destinationPath: "report.pdf",
      backend: "cloud",
    }, { signal: controller.signal }));
    expect(execute.mock.calls[0]![0].signal).toBe(controller.signal);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]![0].commandArgs).toEqual({
      command: "convert",
      destinationPathDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      outputFormat: "pdf",
      backend: "cloud",
    });
    expect(confirmPublication).toHaveBeenCalledWith({
      operationKey: "1".repeat(64),
      artifactId: "artifact-1",
      revisionId: "10000000-0000-4000-8000-000000000030",
    });
    expect(String(result)).toContain(`cvr_${"2".repeat(32)}`);
  });

  test("returns the recovery handle when durable confirmation fails after Artifact commit", async () => {
    const output = Buffer.from("%PDF-durable");
    const handle = `cvr_${"2".repeat(32)}`;
    const execute = mock(async () => ({
      status: "ready_to_publish" as const,
      operationKey: "1".repeat(64),
      recoveryHandle: handle,
      outputFormat: "pdf",
      bytes: output,
      outputSha256: sha(output),
    }));
    const confirmPublication = mock(async () => { throw new Error("database unavailable"); });
    const commit = mock(async () => ({
      ok: true as const,
      revisionId: "10000000-0000-4000-8000-000000000030",
      artifactId: "artifact-1",
    }));
    setWorkspaceFileContentCommitExecution(commit);
    const tool = createConvertTool(durableToolContext(), {
      conversionRuntime: conversionRuntime({ execute, confirmPublication }),
      prepareWorkspaceDestination: destinationPreparer(),
    });

    const result = await runWithTurn("turn-confirm-failure", () => tool.invoke({
      html: "<p>Hi</p>",
      format: "pdf",
      destinationPath: "report.pdf",
      backend: "cloud",
    }));
    const parsed = JSON.parse(String(result)) as Record<string, unknown>;
    expect(commit).toHaveBeenCalledTimes(1);
    expect(confirmPublication).toHaveBeenCalledTimes(1);
    expect(parsed).toMatchObject({
      error: "conversion_publication_confirmation_uncertain",
      retryable: true,
      uncertainEffect: true,
      recoveryHandle: handle,
    });
  });

  test("preserves the recovery handle when a failed Artifact commit cannot be recorded", async () => {
    const output = Buffer.from("%PDF-durable");
    const handle = `cvr_${"3".repeat(32)}`;
    const execute = mock(async () => ({
      status: "ready_to_publish" as const,
      operationKey: "1".repeat(64),
      recoveryHandle: handle,
      outputFormat: "pdf",
      bytes: output,
      outputSha256: sha(output),
    }));
    const failPublication = mock(async () => { throw new Error("database unavailable"); });
    setWorkspaceFileContentCommitExecution(mock(async () => ({
      ok: false as const,
      code: "human_edit_conflict" as const,
      message: "The destination changed.",
    })));
    const tool = createConvertTool(durableToolContext(), {
      conversionRuntime: conversionRuntime({ execute, failPublication }),
      prepareWorkspaceDestination: destinationPreparer(),
    });

    const result = await runWithTurn("turn-fail-publication-receipt", () => tool.invoke({
      html: "<p>Hi</p>",
      format: "pdf",
      destinationPath: "report.pdf",
      backend: "cloud",
    }));
    const parsed = JSON.parse(String(result)) as Record<string, unknown>;
    expect(failPublication).toHaveBeenCalledTimes(1);
    expect(parsed).toMatchObject({
      error: "conversion_publication_recovery_uncertain",
      retryable: true,
      uncertainEffect: true,
      recoveryHandle: handle,
    });
  });

  test("recovers a committed Artifact receipt after the destination revision changed", async () => {
    const resume = mock(async () => ({
      status: "recover_publication" as const,
      operationKey: "4".repeat(64),
      recoveryHandle: `cvr_${"5".repeat(32)}`,
      outputFormat: "pdf",
    }));
    const resumePublication = mock(async () => { throw new Error("must not redownload"); });
    const confirmPublication = mock(async () => undefined);
    const recover = mock(async (_request: Parameters<WorkspaceFileContentRecoveryExecution>[0]) => ({
      ok: true as const,
      revisionId: "10000000-0000-4000-8000-000000000031",
      artifactId: "artifact-1",
      artifactInternalId: "10000000-0000-4000-8000-000000000020",
    }));
    setWorkspaceFileContentRecoveryExecution(recover);
    const tool = createConvertTool(durableToolContext(), {
      conversionRuntime: conversionRuntime({ resume, resumePublication, confirmPublication }),
      prepareWorkspaceDestination: destinationPreparer("update", 2),
    });
    const result = await runWithTurn("turn-durable-recover", () => tool.invoke({
      action: "resume",
      recoveryHandle: `cvr_${"5".repeat(32)}`,
      format: "pdf",
      destinationPath: "report.pdf",
    }));
    expect(recover).toHaveBeenCalledTimes(1);
    expect(resumePublication).not.toHaveBeenCalled();
    expect(confirmPublication).toHaveBeenCalledTimes(1);
    expect(String(result)).toContain("Recovered the committed");
  });

  test("returns the existing recovery handle when recovered Artifact confirmation fails", async () => {
    const handle = `cvr_${"5".repeat(32)}`;
    const resume = mock(async () => ({
      status: "recover_publication" as const,
      operationKey: "4".repeat(64),
      recoveryHandle: handle,
      outputFormat: "pdf",
    }));
    const resumePublication = mock(async () => { throw new Error("must not redownload"); });
    const confirmPublication = mock(async () => { throw new Error("database unavailable"); });
    const recover = mock(async () => ({
      ok: true as const,
      revisionId: "10000000-0000-4000-8000-000000000031",
      artifactId: "artifact-1",
    }));
    setWorkspaceFileContentRecoveryExecution(recover);
    const tool = createConvertTool(durableToolContext(), {
      conversionRuntime: conversionRuntime({ resume, resumePublication, confirmPublication }),
      prepareWorkspaceDestination: destinationPreparer("update", 2),
    });

    const result = await runWithTurn("turn-recovered-confirm-failure", () => tool.invoke({
      action: "resume",
      recoveryHandle: handle,
      format: "pdf",
      destinationPath: "report.pdf",
    }));
    const parsed = JSON.parse(String(result)) as Record<string, unknown>;
    expect(recover).toHaveBeenCalledTimes(1);
    expect(resumePublication).not.toHaveBeenCalled();
    expect(parsed).toMatchObject({
      error: "conversion_publication_confirmation_uncertain",
      retryable: true,
      uncertainEffect: true,
      recoveryHandle: handle,
    });
  });

  test("preserves the existing handle when Artifact receipt recovery throws", async () => {
    const handle = `cvr_${"6".repeat(32)}`;
    const resume = mock(async () => ({
      status: "recover_publication" as const,
      operationKey: "4".repeat(64),
      recoveryHandle: handle,
      outputFormat: "pdf",
    }));
    const resumePublication = mock(async () => { throw new Error("must not redownload"); });
    setWorkspaceFileContentRecoveryExecution(mock(async () => {
      throw new Error("recovery store unavailable");
    }));
    const tool = createConvertTool(durableToolContext(), {
      conversionRuntime: conversionRuntime({ resume, resumePublication }),
      prepareWorkspaceDestination: destinationPreparer("update", 2),
    });

    const result = await runWithTurn("turn-recovery-read-failure", () => tool.invoke({
      action: "resume",
      recoveryHandle: handle,
      format: "pdf",
      destinationPath: "report.pdf",
    }));
    const parsed = JSON.parse(String(result)) as Record<string, unknown>;
    expect(resumePublication).not.toHaveBeenCalled();
    expect(parsed).toMatchObject({
      error: "conversion_publication_recovery_uncertain",
      retryable: true,
      uncertainEffect: true,
      recoveryHandle: handle,
    });
  });

  test("does not project a published receipt onto the caller's supplied path", async () => {
    const resume = mock(async () => ({
      status: "published" as const,
      operationKey: "8".repeat(64),
      recoveryHandle: `cvr_${"9".repeat(32)}`,
      outputFormat: "pdf",
      artifactId: "artifact-original",
      revisionId: "10000000-0000-4000-8000-000000000039",
    }));
    const tool = createConvertTool(durableToolContext(), {
      conversionRuntime: conversionRuntime({ resume }),
      prepareWorkspaceDestination: destinationPreparer(),
    });
    const result = await runWithTurn("turn-published-recovery", () => tool.invoke({
      action: "resume",
      recoveryHandle: `cvr_${"9".repeat(32)}`,
      format: "pdf",
      destinationPath: "caller-supplied.pdf",
    }));
    expect(String(result)).toContain("artifact-original");
    expect(String(result)).not.toContain("caller-supplied.pdf");
  });

  test("reapplies the same publication receipt when no Artifact commit exists", async () => {
    const bytes = Buffer.from("%PDF-reapply");
    const resume = mock(async () => ({
      status: "recover_publication" as const,
      operationKey: "6".repeat(64),
      recoveryHandle: `cvr_${"7".repeat(32)}`,
      outputFormat: "pdf",
    }));
    const resumePublication = mock(async () => ({
      status: "ready_to_publish" as const,
      operationKey: "6".repeat(64),
      recoveryHandle: `cvr_${"7".repeat(32)}`,
      outputFormat: "pdf",
      bytes,
      outputSha256: sha(bytes),
    }));
    const confirmPublication = mock(async () => undefined);
    const recover = mock(async (_request: Parameters<WorkspaceFileContentRecoveryExecution>[0]) => ({
      ok: false as const,
      code: "reapply_required" as const,
      message: "No committed mutation exists.",
    }));
    const commit = mock(async (_request: Parameters<WorkspaceFileContentCommitExecution>[0]) => ({
      ok: true as const,
      revisionId: "10000000-0000-4000-8000-000000000032",
      artifactId: "artifact-1",
    }));
    setWorkspaceFileContentRecoveryExecution(recover);
    setWorkspaceFileContentCommitExecution(commit);
    const tool = createConvertTool(durableToolContext(), {
      conversionRuntime: conversionRuntime({ resume, resumePublication, confirmPublication }),
      prepareWorkspaceDestination: destinationPreparer(),
    });
    await runWithTurn("turn-durable-reapply", () => tool.invoke({
      action: "resume",
      recoveryHandle: `cvr_${"7".repeat(32)}`,
      format: "pdf",
      destinationPath: "report.pdf",
    }));
    expect(resumePublication).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(recover.mock.calls[0]![0].mutationRequestId)
      .toBe(commit.mock.calls[0]![0].mutationRequestId);
    expect(commit.mock.calls[0]![0].commandArgs).toEqual({
      command: "convert",
      destinationPathDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      outputFormat: "pdf",
      backend: "cloud",
    });
  });

  test("local inline md→pdf with local destination fails closed (mixed route)", async () => {
    const destRel = "out.pdf";
    const tool = createConvertTool(
      {
        ownerId: "owner-1",
        causalHumanUserId: "owner-1",
        workspacePath: workspaceRoot,
        currentFolder,
        agentId: "agent-1",
        roomId: "room-1",
      },
      {
        isCloudConvertConfigured: () => false,
        markdownToPdfBuffer: async () => Buffer.from("%PDF-1.4 fake"),
        markdownToDocxBuffer: async () => Buffer.from("docx"),
      },
    );

    const result = await runWithTurn("turn-convert-local", () =>
      tool.invoke({
        markdown: "# Hello",
        format: "pdf",
        destinationPath: destRel,
        destinationZone: "current",
        backend: "local",
      }),
    );

    expect(String(result)).toContain("local destination conversion requires a local-zone source file");
  });

  test("cloud html→pdf invokes adapter and surfaces egress provenance", async () => {
    const destRel = "report.pdf";
    const fakePdf = Buffer.from("%PDF-cloud");
    let convertCalled = false;

    const tool = createConvertTool(
      {
        ownerId: "owner-1",
        causalHumanUserId: "owner-1",
        workspacePath: workspaceRoot,
        currentFolder,
        agentId: "agent-1",
        roomId: "room-1",
      },
      {
        isCloudConvertConfigured: () => true,
        cloudConvert: async (bytes, fromFmt, toFmt) => {
          convertCalled = true;
          expect(fromFmt).toBe("html");
          expect(toFmt).toBe("pdf");
          expect(bytes.toString("utf-8")).toContain("<p>Hi</p>");
          return fakePdf;
        },
        markdownToPdfBuffer: async () => {
          throw new Error("local generator should not run");
        },
        assertServerFunding: async () => {},
      },
    );

    const result = await runWithTurn("turn-convert-cloud", () =>
      tool.invoke({
        html: "<p>Hi</p>",
        format: "pdf",
        destinationPath: destRel,
        destinationZone: "workspace",
        backend: "cloud",
      }),
    );

    expect(convertCalled).toBe(true);
    expect(String(result)).toContain("envelope");
  });

  test("cloud html→pdf with local destination fails closed", async () => {
    const tool = createConvertTool(
      {
        ownerId: "owner-1",
        workspacePath: workspaceRoot,
        currentFolder,
        agentId: "agent-1",
        roomId: "room-1",
      },
      { isCloudConvertConfigured: () => true },
    );

    const result = await tool.invoke({
      html: "<p>Hi</p>",
      format: "pdf",
      destinationPath: "report.pdf",
      destinationZone: "current",
      backend: "cloud",
    });

    expect(String(result)).toContain("cloud conversion with local source or destination");
  });

  test("cloud request fails closed when key absent", async () => {
    const tool = createConvertTool(
      {
        ownerId: "owner-1",
        workspacePath: workspaceRoot,
        currentFolder,
      },
      { isCloudConvertConfigured: () => false },
    );

    const result = await tool.invoke({
      html: "<p>Hi</p>",
      format: "pdf",
      destinationPath: "out.pdf",
      destinationZone: "current",
      backend: "cloud",
    });

    expect(String(result)).toContain("CloudConvert is not connected");
  });

  test("personal capability blocks explicit cloud conversion before dispatch", async () => {
    let convertCalled = false;
    const tool = createConvertTool({
      ownerId: "owner-1", causalHumanUserId: "owner-1", workspacePath: workspaceRoot,
      currentFolder, agentId: "agent-1", roomId: "room-1",
    }, {
      isCloudConvertConfigured: () => true,
      cloudConvert: async () => { convertCalled = true; return Buffer.from("unexpected"); },
      assertServerFunding: async () => {},
    });
    const result = await runWithCapabilityFundingSession(personalCapability, () => tool.invoke({
      html: "<p>Hi</p>", format: "pdf", destinationPath: "personal.pdf",
      destinationZone: "workspace", backend: "cloud",
    }));
    expect(String(result)).toContain("Personal CloudConvert funding requires the durable conversion runtime");
    expect(convertCalled).toBe(false);
  });

  test("server-funded capability preserves the CloudConvert funding guard and dispatch", async () => {
    let fundingChecked = false;
    let convertCalled = false;
    const tool = createConvertTool({
      ownerId: "owner-1", causalHumanUserId: "owner-1", workspacePath: workspaceRoot,
      currentFolder, agentId: "agent-1", roomId: "room-1",
    }, {
      isCloudConvertConfigured: () => true,
      cloudConvert: async () => { convertCalled = true; return Buffer.from("%PDF-cloud"); },
      assertServerFunding: async (humanUserId, origin) => {
        fundingChecked = humanUserId === "owner-1" && origin === "cloud_conversion";
      },
    });
    const result = await runWithCapabilityFundingSession(serverCapability, () =>
      tool.invoke({
        html: "<p>Hi</p>", format: "pdf", destinationPath: "server-funded.pdf",
        destinationZone: "workspace", backend: "cloud",
      }));
    expect(String(result)).toContain("envelope");
    expect(fundingChecked).toBe(true);
    expect(convertCalled).toBe(true);
  });

  test("ambient personal funding prevents auto from falling through to cloud", async () => {
    let convertCalled = false;
    const tool = createConvertTool({
      ownerId: "owner-1", causalHumanUserId: "owner-1", workspacePath: workspaceRoot,
      currentFolder, agentId: "agent-1", roomId: "room-1",
    }, {
      isCloudConvertConfigured: () => true,
      cloudConvert: async () => { convertCalled = true; return Buffer.from("unexpected"); },
      assertServerFunding: async () => {},
    });
    const result = await runWithUsageContext({ callType: "other", funding: {
      kind: "personal", humanUserId: "owner-1", payerHumanId: "owner-1",
      providerRoute: "openrouter", credentialId: "credential-1", credentialRevision: 1,
    } }, () => tool.invoke({
      html: "<p>Hi</p>", format: "pdf", destinationPath: "personal-auto.pdf",
      destinationZone: "workspace", backend: "auto",
    }));
    expect(String(result)).toContain("Personal CloudConvert funding requires the durable conversion runtime");
    expect(convertCalled).toBe(false);
  });

  test("factory description hides cloud routes when key absent", () => {
    const tool = createConvertTool(undefined, { isCloudConvertConfigured: () => false });
    expect(tool.description).not.toContain("CloudConvert routes");
  });
});
