import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runWithTurn } from "@nautilo/logger";
import { resolveConvertBackend } from "./backend-resolver";
import { createConvertTool } from "./convert-tool";

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
      expect(result.error).toContain("CloudConvert not configured");
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
});

describe("createConvertTool", () => {
  test("local inline md→pdf with local destination fails closed (mixed route)", async () => {
    const destRel = "out.pdf";
    const tool = createConvertTool(
      {
        ownerId: "owner-1",
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

    expect(String(result)).toContain("CloudConvert not configured");
  });

  test("factory description hides cloud routes when key absent", () => {
    const tool = createConvertTool(undefined, { isCloudConvertConfigured: () => false });
    expect(tool.description).not.toContain("CloudConvert routes");
  });
});
