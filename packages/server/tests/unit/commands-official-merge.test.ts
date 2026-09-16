import { describe, expect, test } from "bun:test";
import { buildCommandList, type CommandListItem } from "../../src/routes/commands";

const OFFICIAL_NAME = "summarize-thread";

function dbItem(
  overrides: Partial<CommandListItem> & Pick<CommandListItem, "name">,
): CommandListItem {
  return {
    description: "db description",
    enabled: true,
    source: "user",
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
    version: number;
  }> = {},
) {
  return {
    name: OFFICIAL_NAME,
    description: "official description",
    body: "official body content here",
    version: 1,
    ...overrides,
  };
}

describe("buildCommandList", () => {
  test("official-only (no DB) → one item, official:true, forked:false, source:official, enabled:true", () => {
    const result = buildCommandList([], [officialInput()]);

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

    const result = buildCommandList([db], [officialInput({ version: 2 })]);

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

  test("pure user command (no official) → official:false, forked:false", () => {
    const db = dbItem({ name: "my-custom-command", description: "custom" });

    const result = buildCommandList([db], [officialInput()]);

    expect(result).toHaveLength(2);
    const custom = result.find((c) => c.name === "my-custom-command");
    expect(custom).toMatchObject({
      official: false,
      forked: false,
      description: "custom",
    });
  });

  test("mixed set → sorted by name asc, no duplicate names", () => {
    const dbItems = [
      dbItem({ name: "zebra-command" }),
      dbItem({ name: OFFICIAL_NAME, description: "fork", source: "user" }),
      dbItem({ name: "alpha-command" }),
    ];

    const result = buildCommandList(dbItems, [
      officialInput(),
      officialInput({ name: "beta-official", description: "beta", body: "beta body", version: 3 }),
    ]);

    expect(result.map((c) => c.name)).toEqual([
      "alpha-command",
      "beta-official",
      OFFICIAL_NAME,
      "zebra-command",
    ]);

    const names = result.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("disabled fork still shows with forked:true, enabled:false", () => {
    const db = dbItem({
      name: OFFICIAL_NAME,
      enabled: false,
      source: "user",
    });

    const result = buildCommandList([db], [officialInput()]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      official: true,
      forked: true,
      enabled: false,
    });
  });
});
