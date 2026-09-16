import { describe, expect, test } from "bun:test";
import { buildActiveMiniAppBlock } from "../../src/prompts/templates";

describe("buildActiveMiniAppBlock", () => {
  test("returns empty string when context is absent", () => {
    expect(buildActiveMiniAppBlock(null)).toBe("");
    expect(buildActiveMiniAppBlock(undefined)).toBe("");
  });

  test("renders compact active mini-app block with generic app fields", () => {
    const out = buildActiveMiniAppBlock({
      appId: "sample-app",
      appName: "Sample App",
      documentPath: "budget.html",
      targetKind: "artifact",
      selection: { label: "Sheet1 A1:C12" },
      summary: {
        state: "saved",
        description: "revenue/cost worksheet with 40 rows.",
      },
      updatedAt: 1,
    });

    expect(out).toContain("## Active mini-app");
    expect(out).toContain("App: Sample App (sample-app)");
    expect(out).toContain('Document: artifact "budget.html"');
    expect(out).toContain("Target: artifact");
    expect(out).toContain("Selection: Sheet1 A1:C12");
    expect(out).toContain("State: saved");
    expect(out).toContain("Summary: revenue/cost worksheet with 40 rows.");
    expect(out).not.toContain("Active sheet:");
    expect(out).not.toContain("Used range:");
  });

  test("sanitizes prompt strings", () => {
    const out = buildActiveMiniAppBlock({
      appId: "sample-app",
      appName: "Bad\nName",
      documentPath: "budget.document.json",
      updatedAt: 1,
    });
    expect(out).toContain("App: BadName (sample-app)");
    expect(out).not.toContain("\nName");
  });

  test("strips live review authority from advisory Writer summary", () => {
    const sessionToken = "writer-session-token-opaque";
    const outline = Array.from({ length: 30 }, (_, index) => ({
      id: `block-${index}`,
      text: "long outline content ".repeat(12),
    }));
    const out = buildActiveMiniAppBlock({
      appId: "nautilo-writer",
      appName: "Writer",
      summary: {
        documentType: "document",
        blockCount: outline.length,
        outline,
        liveSession: {
          sessionToken,
          sessionId: "routing-only-session-id",
          baseRevision: 42,
        },
        openDocumentWorkflow: "Use edit-open-writer only.",
      },
      updatedAt: 1,
    });

    expect(out).toContain("## Active mini-app");
    expect(out).toContain("App: Writer (nautilo-writer)");
    expect(out).toContain("Summary:");
    expect(out).toContain("documentType");
    expect(out).toContain("blockCount");
    expect(out).not.toContain("Writer review session:");
    expect(out).not.toContain("Live mini-app review session");
    expect(out).not.toContain(sessionToken);
    expect(out).not.toContain("routing-only-session-id");
    expect(out).not.toContain("baseRevision");
    expect(out).not.toContain("edit-open-writer");
    expect(out).not.toContain('"sessionToken"');
    expect(out).not.toContain('"sessionId"');
  });

  test("does not add Writer review credentials for other mini-apps", () => {
    const out = buildActiveMiniAppBlock({
      appId: "sample-app",
      appName: "Sample App",
      summary: {
        description: "Current document summary.",
        liveSession: {
          sessionToken: "not-a-writer-token",
          baseRevision: 7,
        },
      },
      updatedAt: 1,
    });

    expect(out).toContain("Summary: Current document summary.");
    expect(out).not.toContain("Writer review session:");
    expect(out).not.toContain("not-a-writer-token");
    expect(out).not.toContain("edit-open-writer");
    expect(out).not.toContain("Writer scope rule:");
  });
});
