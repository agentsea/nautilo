import "../bun-dom-preload";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup } from "@testing-library/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ToolActivityContext } from "../../src/adapters/runtime-contexts";
import { ToolCard } from "../../src/components/tool-card/tool-card";
import { getToolRenderer } from "../../src/components/tool-card/renderers";
import { readWebpageRenderer } from "../../src/components/tool-card/renderers/read-webpage";

const intervention = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  toolCallId: "tool-1",
  laneKey: "room:room-1",
  state: "awaiting_choice" as const,
  host: "example.com",
  reason: "human-verification" as const,
  expiresAt: "2026-08-07T22:00:00.000Z",
};

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("read_webpage challenge renderer", () => {
  test("registers without a model-facing result sentinel", () => {
    expect(getToolRenderer("read_webpage")).toBe(readWebpageRenderer);
    expect(readWebpageRenderer.autoExpandOnResult).toBeUndefined();
  });

  test("shows the explicit Human choices and temporary-session warning", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<readWebpageRenderer.ExpandedBody
      args={{ url: "https://example.com/" }}
      result={undefined}
      state="blocked"
      event={{
        toolCallId: "tool-1",
        toolName: "read_webpage",
        args: { url: "https://example.com/" },
        status: "running",
        startedAt: Date.now(),
        laneKey: "room:room-1",
        browserResearchIntervention: intervention,
      }}
      resultText={undefined}
      resultTruncated={false}
    />));

    expect(container.textContent).toContain("Verification required");
    expect(container.textContent).toContain("Do not sign in or enter private information");
    expect(container.textContent).toContain("Complete verification");
    expect(container.textContent).toContain("Try another source");
    expect(container.textContent).toContain("Stop research");
    expect(container.textContent).not.toContain("ws://");
    expect(container.querySelectorAll("button")).toHaveLength(3);
    await act(async () => root.unmount());
  });

  test("renders an error-bodied completed read as failed rather than succeeded", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(
      <ToolActivityContext.Provider value={[{
        toolCallId: "tool-failed-read",
        toolName: "read_webpage",
        args: { url: "https://example.com/empty" },
        status: "ok",
        startedAt: 1,
        endedAt: 2,
        result: "Error: [page_empty] This page returned no readable content. Try another URL or source.",
      }]}>
        <ToolCard
          toolName="read_webpage"
          toolCallId="tool-failed-read"
          args={{ url: "https://example.com/empty" }}
          status={{ type: "complete" }}
        />
      </ToolActivityContext.Provider>,
    ));

    expect(container.querySelector('[data-tool-card-state="error"]')).not.toBeNull();
    expect(container.textContent).toContain("errored");
    await act(async () => root.unmount());
  });

  test("renders temporary snapshot inspection text without exposing the opaque handle", async () => {
    const reference = "r".repeat(43);
    const result = JSON.stringify({
      kind: "browser_page_snapshot_inspection",
      result: { version: 1, operation: "range", reference, expiresAt: "2026-08-10T12:00:00.000Z",
        offsetCharacters: 12, startOffsetCharacters: 5, endOffsetCharacters: 20, content: "untrusted <tag>",
        startsMidBlock: true, endsMidBlock: false, truncatedBlock: true },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<readWebpageRenderer.ExpandedBody
      args={{ snapshot: { operation: "range" } }} result={undefined} state="success" event={undefined}
      resultText={result} resultTruncated={false}
    />));
    expect(container.querySelector('[data-testid="read-webpage-range-content"]')?.textContent).toContain("untrusted <tag>");
    expect(container.textContent).toContain("Temporary page context");
    expect(container.textContent).not.toContain(reference);
    expect(container.querySelector("tag")).toBeNull();
    await act(async () => root.unmount());
  });

  test("rejects a snapshot envelope with extra fields before rendering structured content", async () => {
    const reference = "x".repeat(43);
    const result = JSON.stringify({
      kind: "browser_page_snapshot_inspection", leaked: "must not render", result: {
        version: 1, operation: "find", reference, expiresAt: "2026-08-10T12:00:00.000Z",
        caseSensitive: false, totalMatches: 0, returnedMatches: 0, matchesOmitted: 0, matches: [],
      },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<readWebpageRenderer.ExpandedBody
      args={{ snapshot: { operation: "find" } }} result={undefined} state="success" event={undefined}
      resultText={result} resultTruncated={false}
    />));
    expect(container.querySelector('[data-testid="read-webpage-snapshot-inspection"]')).toBeNull();
    expect(container.textContent).not.toContain(reference);
    await act(async () => root.unmount());
  });
});
