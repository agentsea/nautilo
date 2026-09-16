import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { supervisor, truncateSupervisorDirective } from "../../src/subagents/deep-research/supervisor/graph";
import {
  appendDroppedNotesNotice,
  buildSearchResultToolContent,
  selectNotesForCompression,
  truncateResearchBriefForPrompt,
} from "../../src/subagents/deep-research/researcher/graph";
import { formatSearchToolPrintable } from "../../src/subagents/deep-research/tools/index";
import { formatWebSearchSources, truncateWithMarker } from "../../src/tools/utilities/web-search";
import * as invokeModule from "../../src/utils/invoke";
import * as routerModule from "../../src/subagents/deep-research/providers/router";
import type { Configuration as DeepResearchConfiguration } from "../../src/subagents/deep-research/shared/config";

const restores: Array<() => void> = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

describe("deep-research caps (D274)", () => {
  test("supervisor rejects exhausted retries without changing accumulated messages", async () => {
    const existing = [{ role: "user" as const, content: "prior plan step" }];
    const cause = new Error("supervisor.invoke attempt 3/3 timed out after 60000ms");
    const spInvoke = spyOn(invokeModule, "invokeWithRetry").mockRejectedValue(cause);
    restores.push(() => spInvoke.mockRestore());
    const spModel = spyOn(routerModule, "createModel").mockResolvedValue({
      bindTools: () => ({ invoke: async () => ({}) }),
    } as never);
    restores.push(() => spModel.mockRestore());

    const result = await supervisor({
      supervisor_messages: existing,
      research_brief: "test brief",
      notes: [],
      raw_notes: [],
      research_iterations: 0,
    }, {
      supervisor_model: "test:supervisor",
      supervisor_model_max_tokens: 4321,
      max_researcher_iterations: 6,
      max_concurrent_research_units: 5,
    } as DeepResearchConfiguration).catch((error: unknown) => error);

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe("Deep Research supervisor failed");
    expect((result as Error).cause).toBe(cause);
    expect(spModel).toHaveBeenCalledWith(
      "test:supervisor",
      expect.objectContaining({ supervisor_model_max_tokens: 4321 }),
      { maxTokens: 4321 },
    );
    expect(existing).toEqual([{ role: "user", content: "prior plan step" }]);
  });

  test("A6: buildSearchResultToolContent honors search_max_results and shows subset count", () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      title: `Result ${i + 1}`,
      url: `https://example.com/${i + 1}`,
      snippet: "snippet",
    }));
    const notes = items.map((item) => `${item.title}\n${item.url}\n${item.snippet}`);
    const content = buildSearchResultToolContent(items, notes, 3);

    expect(content).toContain("Found 8 results (showing 3 of 8)");
    expect(content).toContain("Result 1");
    expect(content).not.toContain("Result 4");
  });

  test("A6: formatSearchToolPrintable honors search_max_results", () => {
    const items = Array.from({ length: 7 }, (_, i) => ({
      title: `Hit ${i + 1}`,
      url: `https://example.com/${i + 1}`,
    }));
    const printable = formatSearchToolPrintable(items, 2);

    expect(printable).toContain("Showing 2 of 7 results");
    expect(printable).toContain("Hit 1");
    expect(printable).not.toContain("Hit 3");
  });

  test("A6: selectNotesForCompression uses summarization_max_items and notes dropped count", () => {
    const notes = ["note-1", "note-2", "note-3", "note-4", "note-5"];
    const { text, takeCount, droppedCount } = selectNotesForCompression(notes, 2);

    expect(takeCount).toBe(2);
    expect(droppedCount).toBe(3);
    expect(text).toContain("[3 older note(s) omitted; compressing 2 most recent]");
    expect(text).toContain("note-4");
    expect(text).toContain("note-5");
    expect(text).not.toContain("note-1");
  });

  test("A6: appendDroppedNotesNotice prefixes compressed output when notes were dropped", () => {
    const out = appendDroppedNotesNotice("compressed summary", 2);
    expect(out).toContain("[2 older note(s) dropped from compression]");
    expect(out).toContain("compressed summary");
  });

  test("A6: truncateResearchBriefForPrompt appends marker when truncated", () => {
    const long = "x".repeat(700);
    const truncated = truncateResearchBriefForPrompt(long);
    expect(truncated.length).toBe(601);
    expect(truncated.endsWith("…")).toBe(true);
  });

  test("A6: truncateSupervisorDirective appends marker when truncated", () => {
    const long = "y".repeat(600);
    const truncated = truncateSupervisorDirective(long);
    expect(truncated.length).toBe(501);
    expect(truncated.endsWith("…")).toBe(true);
  });

  test("A6: formatWebSearchSources limits to configured max results", () => {
    const items = Array.from({ length: 6 }, (_, i) => ({
      url: `https://example.com/${i + 1}`,
      title: `Title ${i + 1}`,
    }));
    const sources = formatWebSearchSources(items, 2);
    expect(sources).toContain("Title 1");
    expect(sources).toContain("Title 2");
    expect(sources).not.toContain("Title 3");
  });

  test("A6: truncateWithMarker appends truncation marker for long page content", () => {
    const long = "z".repeat(100);
    const truncated = truncateWithMarker(long, 40);
    expect(truncated).toBe("z".repeat(40) + "…[truncated at 40 chars]");
  });
});
