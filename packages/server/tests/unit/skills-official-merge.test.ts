import { describe, expect, test } from "bun:test";
import {
  buildSkillList,
  friendlySkillToolLabel,
  unknownSkillToolRequirements,
  type SkillListItem,
} from "../../src/routes/skills";

const OFFICIAL_NAME = "interactive-artifact-authoring";

function dbItem(overrides: Partial<SkillListItem> & Pick<SkillListItem, "name">): SkillListItem {
  return {
    description: "db description",
    enabled: true,
    source: "user",
    requiresTools: [],
    tokenEstimate: 10,
    updatedAt: "2026-01-01T00:00:00.000Z",
    official: false,
    forked: false,
    ...overrides,
  };
}

function officialInput(
  overrides: Partial<{
    name: string;
    description: string;
    body: string;
    requiresTools: string[];
    version: number;
  }> = {},
) {
  return {
    name: OFFICIAL_NAME,
    description: "official description",
    body: "official body content here",
    requiresTools: ["file"],
    version: 1,
    ...overrides,
  };
}

describe("buildSkillList", () => {
  test("official-only (no DB) → one item, official:true, forked:false, source:official, enabled:true", () => {
    const result = buildSkillList([], [officialInput()]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: OFFICIAL_NAME,
      description: "official description",
      enabled: true,
      source: "official",
      official: true,
      forked: false,
      version: 1,
      updatedAt: "",
    });
    expect(result[0]!.tokenEstimate).toBeGreaterThan(0);
  });

  test("DB row shadows official by name → official:true, forked:true, keeps DB fields, no duplicate", () => {
    const db = dbItem({
      name: OFFICIAL_NAME,
      description: "fork description",
      enabled: false,
      source: "user",
      tokenEstimate: 42,
      updatedAt: "2026-06-01T12:00:00.000Z",
    });

    const result = buildSkillList([db], [officialInput({ version: 2 })]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: OFFICIAL_NAME,
      description: "fork description",
      enabled: false,
      source: "user",
      tokenEstimate: 42,
      updatedAt: "2026-06-01T12:00:00.000Z",
      official: true,
      forked: true,
      version: 2,
    });
  });

  test("pure user skill (no official) → official:false, forked:false", () => {
    const db = dbItem({ name: "my-custom-skill", description: "custom" });

    const result = buildSkillList([db], [officialInput()]);

    expect(result).toHaveLength(2);
    const custom = result.find((s) => s.name === "my-custom-skill");
    expect(custom).toMatchObject({
      official: false,
      forked: false,
      description: "custom",
    });
  });

  test("mixed set → sorted by name asc, no duplicate names", () => {
    const dbItems = [
      dbItem({ name: "zebra-skill" }),
      dbItem({ name: OFFICIAL_NAME, description: "fork", source: "user" }),
      dbItem({ name: "alpha-skill" }),
    ];

    const result = buildSkillList(dbItems, [
      officialInput(),
      officialInput({ name: "beta-official", description: "beta", body: "beta body", version: 3 }),
    ]);

    expect(result.map((s) => s.name)).toEqual([
      "alpha-skill",
      "beta-official",
      OFFICIAL_NAME,
      "zebra-skill",
    ]);

    const names = result.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("disabled fork still shows with forked:true, enabled:false", () => {
    const db = dbItem({
      name: OFFICIAL_NAME,
      enabled: false,
      source: "user",
    });

    const result = buildSkillList([db], [officialInput()]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      official: true,
      forked: true,
      enabled: false,
    });
  });
});

describe("Skill capability presentation and validation", () => {
  test("uses friendly labels rather than exposing internal tool identifiers", () => {
    expect(friendlySkillToolLabel("run_web_search")).toBe("Web search");
    expect(friendlySkillToolLabel("activate_tools")).toBe("Enable capabilities");
    expect(friendlySkillToolLabel("calendar_lookup")).toBe("Calendar Lookup");
    expect(friendlySkillToolLabel("app_nautilo_design__arrange_nodes"))
      .toBe("Arrange Nodes (Nautilo Design)");
  });

  test("rejects stale or invented requirements against the speaker catalogue", () => {
    expect(unknownSkillToolRequirements(
      [" file ", "made_up_tool", "made_up_tool"],
      new Set(["file", "run_web_search"]),
    )).toEqual(["made_up_tool"]);
  });
});
