import { afterEach, describe, expect, test } from "bun:test";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import {
  _setSecurityReportArtifactWriterForTests,
  _setSecurityReportExporterForTests,
  buildSecurityReportMarkdown,
  createSecurityReportArtifact,
  finalizeSecurityReportDelivery,
  isSecurityResearchTask,
  SECURITY_REPORT_MIME_TYPE,
  securityReportDeliveryText,
  securityReportLogicalPath,
} from "../../src/tasks/security-report-artifact";
import { eventBus } from "../../src/event-bus";

const envelope = {
  ownerId: "owner-1",
  actorId: "actor-1",
  agentId: "agent-1",
  roomId: "room-1",
  readableNamespaces: ["room-ns"],
  mutableNamespaces: ["room-ns"],
  writableNamespaces: ["room-ns"],
  toolPolicy: {},
} as unknown as MemoryAccessEnvelope;

afterEach(() => {
  _setSecurityReportArtifactWriterForTests(null);
  _setSecurityReportExporterForTests(null);
});

describe("security Task report artifacts", () => {
  test("recognizes only an explicit security_scan Task whitelist", () => {
    expect(isSecurityResearchTask({ toolWhitelist: ["file", "security_scan"] })).toBe(true);
    expect(isSecurityResearchTask({ toolWhitelist: ["file"] })).toBe(false);
    expect(isSecurityResearchTask({})).toBe(false);
  });

  test("builds a unique run-scoped Markdown artifact and returns the actual path", async () => {
    let capturedLogicalPath = "";
    let capturedMimeType = "";
    let capturedOverwrite = false;
    let capturedActor: unknown = undefined;
    let capturedBytes = Buffer.alloc(0);
    const artifact = await createSecurityReportArtifact({
      envelope,
      taskId: "task/unsafe",
      taskRunId: "run-22",
      modelId: "openrouter:z-ai/glm-5.3",
      generatedAt: new Date("2026-08-28T12:00:00.000Z"),
      reportState: "completed",
      report: "## Executive summary\n\nOne high-confidence finding.\n\n## Findings\n\nEvidence at `src/a.ts:12`.",
    }, async (input) => {
      capturedLogicalPath = input.logicalPath;
      capturedMimeType = input.mimeType;
      capturedOverwrite = input.overwrite === true;
      capturedActor = input.actor;
      capturedBytes = Buffer.from(input.bytes);
      return {
        ok: true,
        artifactId: "external-1",
        artifactInternalId: "internal-1",
        displayPath: "artifacts/security-reports/security-scan-task-unsafe-run-22.md",
        revision: 1,
        size: input.bytes.byteLength,
        sha256: "sha",
      };
    });

    expect(securityReportLogicalPath("task/unsafe", "run-22"))
      .toBe("artifacts/security-reports/security-scan-task-unsafe-run-22.md");
    expect(capturedLogicalPath).toBe(artifact.displayPath);
    expect(capturedMimeType).toBe(SECURITY_REPORT_MIME_TYPE);
    expect(capturedOverwrite).toBe(true);
    expect(capturedActor).toBeNull();
    expect(artifact.markdown).toContain("# Codebase security scan report");
    expect(artifact.markdown).toContain("openrouter:z-ai/glm-5.3");
    expect(artifact.markdown).toContain("## Findings");
    expect(artifact.markdown).toContain("`src/a.ts:12`");
    expect(capturedBytes.toString("utf8")).toBe(artifact.markdown);
    expect(securityReportDeliveryText(artifact.displayPath, "## Executive summary\n\nDone."))
      .toStartWith(`Research Markdown report: \`${artifact.displayPath}\``);
  });

  test("refuses successful Task finalization when the real artifact write fails", async () => {
    let failure: Error | null = null;
    try {
      await createSecurityReportArtifact({
        envelope,
        taskId: "task-1",
        taskRunId: "run-1",
        modelId: "model-1",
        reportState: "completed",
      report: "complete report",
      }, async () => ({
        ok: false,
        code: "WRITE_FAILED",
        message: "disk unavailable",
      }));
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message)
      .toBe("SECURITY_REPORT_ARTIFACT_FAILED:WRITE_FAILED:disk unavailable");
  });

  test("buildSecurityReportMarkdown retains the complete report bytes as Markdown", () => {
    const report = "  \n\n## Scope and method\n\nMapped all entry points.\n\n## Limitations\n\nSemgrep unavailable.\n  \n";
    const markdown = buildSecurityReportMarkdown({
      taskId: "task-1",
      taskRunId: "run-1",
      modelId: "model-1",
      generatedAt: "2026-08-28T12:00:00.000Z",
      report,
      reportState: "completed",
    });
    expect(markdown).toEndWith(`${report}\n`);
  });
});


test("unverified failure text never reaches the artifact writer", async () => {
  let writes = 0;
  expect(createSecurityReportArtifact({ envelope, taskId: "task", taskRunId: "run", modelId: "model", report: "Permission denied" } as Parameters<typeof createSecurityReportArtifact>[0], async () => {
    writes++;
    throw new Error("must not write");
  })).rejects.toThrow("SECURITY_RESEARCH_INCOMPLETE");
  expect(writes).toBe(0);
});

test("partial investigations are labeled partial in both artifact and delivery", () => {
  const markdown = buildSecurityReportMarkdown({ taskId: "task", taskRunId: "run", modelId: "model", generatedAt: "now", report: "Evidence with limitations", reportState: "partial" });
  expect(markdown).toStartWith("# Partial codebase security scan report");
  expect(securityReportDeliveryText("report.md", "Evidence with limitations", "partial")).toStartWith("Partial Markdown report:");
});

test("the durable review appendix survives a short final narrative in the actual artifact", () => {
  const appendix = "## Durable review log\n\nA source-backed note omitted by the final summary.";
  const markdown = buildSecurityReportMarkdown({ taskId: "t1", taskRunId: "r1", modelId: "m1", generatedAt: "2026-09-07T00:00:00Z", report: "One confirmed issue.", reportState: "completed", researchAppendix: appendix });
  expect(markdown).toContain("One confirmed issue.");
  expect(markdown).toContain(appendix);
});

test("final delivery rejects every missing-export shape before writing", () => {
  let writes = 0;
  _setSecurityReportArtifactWriterForTests(async () => { writes++; throw new Error("must not write"); });
  for (const researchAppendix of [undefined, null, "", "   "]) {
    expect(finalizeSecurityReportDelivery({ taskId: "t", taskRunId: "r", modelId: "m", report: "Finished", reportState: "completed", envelope, researchAppendix })).rejects.toThrow("SECURITY_RESEARCH_INCOMPLETE");
  }
  expect(writes).toBe(0);
});

test("runtime delivery waits for complete export, uses exact checkpoint scope, and publishes the saved appendix", async () => {
  const order: string[] = [];
  let saved = "";
  _setSecurityReportExporterForTests(async (request) => {
    expect(request).toMatchObject({ threadId: "exact-thread", taskId: "t", taskRunId: "r", userId: "owner-1", modelId: "m" });
    await request.assertActive?.();
    order.push("export-complete");
    return { reportState: "partial", researchAppendix: "## Durable review log\nAll pages, including the final evidence record." };
  });
  _setSecurityReportArtifactWriterForTests(async (request) => {
    order.push("artifact");
    expect(request.envelope).toBe(envelope);
    saved = Buffer.from(request.bytes).toString("utf8");
    return { ok: true, artifactId: "a", artifactInternalId: "b", displayPath: request.logicalPath, revision: 1, size: request.bytes.byteLength, sha256: "digest" };
  });
  const result = await finalizeSecurityReportDelivery({ taskId: "t", taskRunId: "r", userId: "owner-1", threadId: "exact-thread",
    modelId: "m", report: "Reviewed draft", reportState: null, researchAppendix: "Incomplete model page must not become appendix", envelope,
    assertActive: async () => { order.push("active"); } });
  expect(order.indexOf("export-complete")).toBeLessThan(order.indexOf("artifact"));
  expect(saved).toContain("All pages, including the final evidence record.");
  expect(saved).not.toContain("Incomplete model page");
  expect(result).toStartWith("Partial Markdown report:");
});

test("failed or cancelled runtime export cannot write an artifact even with a supplied legacy appendix", async () => {
  let writes = 0;
  _setSecurityReportArtifactWriterForTests(async () => { writes++; throw new Error("must not write"); });
  for (const cancel of [false, true]) {
    _setSecurityReportExporterForTests(async (request) => {
      if (!cancel) throw new Error("SECURITY_RESEARCH_EXPORT_INCOMPLETE");
      eventBus.emit({ type: "task.status", taskId: "t", ownerId: "owner-1", status: "cancelled" });
      expect(request.signal?.aborted).toBe(true);
      return { reportState: "completed", researchAppendix: "Complete saved research" };
    });
    const error = await finalizeSecurityReportDelivery({ taskId: "t", taskRunId: "r", userId: "owner-1", threadId: "exact-thread",
      modelId: "m", report: "Draft", reportState: "completed", researchAppendix: "Old appendix", envelope }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
  }
  expect(writes).toBe(0);
});

test("cancellation during artifact write prevents delivery and a same-run retry uses the same path", async () => {
  _setSecurityReportExporterForTests(async () => ({ reportState: "completed", researchAppendix: "Complete verified export" }));
  const paths: string[] = [];
  _setSecurityReportArtifactWriterForTests(async (request) => {
    paths.push(request.logicalPath);
    if (paths.length === 1) eventBus.emit({ type: "task.status", taskId: "t", ownerId: "owner-1", status: "cancelled" });
    return { ok: true, artifactId: "a", artifactInternalId: "b", displayPath: request.logicalPath, revision: paths.length,
      size: request.bytes.byteLength, sha256: "digest" };
  });
  const request = { taskId: "t", taskRunId: "r", userId: "owner-1", threadId: "exact-thread", modelId: "m", report: "Draft", reportState: null, envelope };
  const cancelled = await finalizeSecurityReportDelivery(request).catch((error: unknown) => error);
  expect(cancelled).toBeInstanceOf(Error);
  // The caller must separately revalidate active lifecycle/authorization. This
  // checks only the idempotent publication path, not permission to resume Stop.
  const retry = await finalizeSecurityReportDelivery(request);
  expect(retry).toStartWith("Research Markdown report:");
  expect(paths).toHaveLength(2);
  expect(paths[0]).toBe(paths[1]);
});

test("runtime delivery publishes the exact reviewed draft instead of regenerated final prose", async () => {
  const reviewed = "\n\n## Reviewed report\n\nExact π finding and its limitations.  \n\n";
  _setSecurityReportExporterForTests(async () => ({ reportState: "completed", researchAppendix: "Full saved research", reviewedReportDraft: reviewed }));
  let markdown = "";
  _setSecurityReportArtifactWriterForTests(async (request) => {
    markdown = Buffer.from(request.bytes).toString("utf8");
    return { ok: true, artifactId: "a", artifactInternalId: "b", displayPath: request.logicalPath, revision: 1,
      size: request.bytes.byteLength, sha256: "digest" };
  });
  const result = await finalizeSecurityReportDelivery({ taskId: "t", taskRunId: "r", userId: "owner-1", threadId: "thread",
    modelId: "m", report: "Regenerated and potentially different final prose", reportState: "completed", envelope });
  expect(markdown).toContain(reviewed);
  expect(markdown).not.toContain("Regenerated");
  expect(result).toContain(reviewed.trim());
  expect(result).not.toContain("Regenerated");
});
