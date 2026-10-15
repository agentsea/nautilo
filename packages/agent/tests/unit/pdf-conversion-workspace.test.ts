import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithTurn } from "@nautilo/logger";
import * as artifactStore from "../../src/tools/file/artifact-store";
import * as workspace from "../../src/tools/file/workspace-commands";
import * as patches from "../../src/tools/file/commands/_shared";
import { createConvertTool } from "../../src/tools/convert/convert-tool";
import { resolveConvertBackend } from "../../src/tools/convert/backend-resolver";
import { syntheticPdf } from "../helpers/synthetic-pdf";

const envelope = { ownerId: "human", actorId: "human", agentId: "agent", roomId: "room",
  readableNamespaces: ["room-namespace"], mutableNamespaces: ["room-namespace"],
  writableNamespaces: ["room-namespace"], toolPolicy: {} };
const context = { ownerId: "human", causalHumanUserId: "human", agentId: "agent", roomId: "room",
  memoryAccessEnvelope: envelope };
const request = { sourcePath: "sample.pdf", sourceZone: "workspace" as const, format: "docx",
  destinationPath: "sample.docx", destinationZone: "workspace" as const, backend: "local" as const };
const cleanup: (() => void)[] = [];
let root: string | undefined;

afterEach(async () => {
  for (const restore of cleanup.splice(0).reverse()) restore();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function source(pages: string[], appendPageOperators = "") {
  root = await mkdtemp(join(tmpdir(), "synthetic-pdf-conversion-"));
  const physicalPath = join(root, "input");
  await writeFile(physicalPath, syntheticPdf(pages, appendPageOperators));
  const resolve = spyOn(artifactStore, "resolveWorkspaceArtifact").mockResolvedValue({
    ok: true, logicalPath: "sample.pdf", physicalPath, artifactId: "source-artifact", storageUri: `file://${physicalPath}`,
    artifact: { id: "source-row", revision: 1 } as NonNullable<Extract<artifactStore.ArtifactResolution, { ok: true }>["artifact"]>,
  });
  cleanup.push(() => resolve.mockRestore());
  const prepare = spyOn(workspace, "prepareWorkspaceArtifactTarget").mockResolvedValue({
    ok: true, physicalPath: join(root, "output"),
    meta: { mode: "create", artifactId: "output-artifact", logicalPath: "sample.docx", namespaceId: "room-namespace",
      storageUri: `file://${join(root, "output")}`, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  });
  cleanup.push(() => prepare.mockRestore());
  const publish = spyOn(patches, "applyBinaryContentPatch").mockImplementation(async (args) => ({
    applied: true, path: "sample.docx", zone: "workspace", command: "convert",
    stats: { additions: 0, deletions: 0 }, summary: args.summary, unifiedDiff: "",
    artifactId: "output-artifact", ...(args.warnings ? { warnings: args.warnings } : {}),
  }));
  cleanup.push(() => publish.mockRestore());
  return { resolve, prepare, publish };
}

describe("Workspace PDF conversion", () => {
  test("auto selects local text conversion even when cloud conversion is configured", () => {
    for (const outputFormat of ["txt", "md", "docx"]) {
      expect(resolveConvertBackend({ explicit: "auto", inputFormat: "pdf", outputFormat,
        isCloudConfigured: () => true })).toEqual({ ok: true, backend: "local" });
    }
  });

  test("authorized source bytes become a Word artifact through the existing mutation port", async () => {
    const { resolve, prepare, publish } = await source(["Synthetic amount 123.45"]);
    const cloud = mock(async () => { throw new Error("Cloud must not run"); });
    const tool = createConvertTool(context, { isCloudConvertConfigured: () => true, cloudConvert: cloud });
    const result = JSON.parse(String(await runWithTurn("synthetic-turn", () => tool.invoke(request)))) as { summary: string; applied: boolean; artifactId: string };
    expect(resolve.mock.calls[0]?.[0]).toMatchObject({ intent: "read", logicalPath: "sample.pdf",
      facts: { readableNamespaces: ["room-namespace"] } });
    expect(prepare.mock.calls[0]?.[1]).toMatchObject({ writableNamespaces: ["room-namespace"] });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0].newBytes.subarray(0, 2).toString()).toBe("PK");
    expect(result).toMatchObject({ applied: true, artifactId: "output-artifact" });
    expect(result.summary).toContain("redline styling are not preserved");
    expect(cloud).not.toHaveBeenCalled();
  });

  test("missing text never publishes a partial Word document or falls back to cloud", async () => {
    const { prepare, publish } = await source(["Readable", ""]);
    const cloud = mock(async () => { throw new Error("Cloud must not run"); });
    const result = await createConvertTool(context, { isCloudConvertConfigured: () => true, cloudConvert: cloud }).invoke(request);
    expect(String(result)).toContain("No output was created");
    expect(prepare).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(cloud).not.toHaveBeenCalled();
  });

  test("isolated scope cannot gain Room artifact access through conversion", async () => {
    const { resolve, publish } = await source(["Private synthetic document"]);
    const tool = createConvertTool({ ...context, memoryAccessEnvelope: {
      memoryMode: "scope", ownerId: "human", actorId: "human", agentId: "agent", roomId: "room",
      scopeId: "isolated-scope", toolPolicy: {},
    } });
    const result = await tool.invoke(request);
    expect(String(result)).toContain("in_background");
    expect(resolve).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  test("damaged PDF page content never publishes an apparently complete conversion", async () => {
    const { prepare, publish } = await source(["Readable paragraph"], " /Missing Do");
    const result = await createConvertTool(context).invoke(request);
    expect(String(result)).toContain("PDF text could not be extracted");
    expect(prepare).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
