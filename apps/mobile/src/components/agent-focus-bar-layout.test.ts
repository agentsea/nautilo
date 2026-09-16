import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("./agent-focus-bar.tsx", import.meta.url)).text();

describe("mobile Genie focus rail", () => {
  test("identifies every Genie before selection with name and owner metadata", () => {
    expect(source).toContain("{railAgents.map(renderAgentChip)}");
    expect(source).toContain("{agent.displayName}");
    expect(source).toContain("agentOwnerLabel(agent)");
    expect(source).toContain("styles.ownerName");
  });

  test("keeps the rail scrollable and pins a measured-overflow Finder", () => {
    expect(source).toContain("horizontal");
    expect(source).toContain("onContentSizeChange");
    expect(source).toContain("agentRailOverflows(railContentWidth, railAvailableWidth)");
    expect(source).toContain('<Text style={styles.findLabel}>Find</Text>');
    expect(source).not.toContain("All 8");
  });

  test("opens a searchable single-Genie chooser", () => {
    expect(source).toContain("Choose a Genie");
    expect(source).toContain("Search Genie, owner, or handle");
    expect(source).toContain("filterAgentFinderEntries(agents, finderQuery)");
    expect(source).toContain("toggleAgentFocus(agent.actorId)");
    expect(source).toContain("setFinderVisible(false)");
  });

  test("moves the just-used Genie to the start of the visible rail", () => {
    expect(source).toContain("orderAgentsByRecentUse(agents, recentActorIds)");
    expect(source).toContain("railRef.current?.scrollTo({ x: 0, animated: true })");
  });
});
