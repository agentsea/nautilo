import { describe, expect, test } from "bun:test";
import type { PublicMiniAppDto } from "@nautilo/api-client/browser";
import {
  filterApps,
  sortApps,
  filterAndSortApps,
  DEFAULT_APP_SORT,
  APP_SORT_OPTIONS,
} from "./apps-sort";

function makeApp(overrides: Partial<PublicMiniAppDto> & Pick<PublicMiniAppDto, "id">): PublicMiniAppDto {
  return {
    name: overrides.name ?? overrides.id,
    description: null,
    version: "1.0.0",
    status: "ready",
    installedAt: null,
    sourceHash: "a".repeat(64),
    fileAssociations: null,
    canEditSource: false,
    ...overrides,
  };
}

describe("filterApps", () => {
  const apps = [
    makeApp({ id: "alpha", name: "Alpha App", description: "First app" }),
    makeApp({ id: "beta", name: "Beta Tool", description: "Second tool" }),
    makeApp({ id: "gamma", name: "Gamma", description: "Spreadsheet helper" }),
  ];

  test("returns all apps when query is empty or whitespace", () => {
    expect(filterApps(apps, "")).toHaveLength(3);
    expect(filterApps(apps, "   ")).toHaveLength(3);
  });

  test("matches by name", () => {
    expect(filterApps(apps, "beta").map((a) => a.id)).toEqual(["beta"]);
  });

  test("matches by description", () => {
    expect(filterApps(apps, "spreadsheet").map((a) => a.id)).toEqual(["gamma"]);
  });

  test("matches by id", () => {
    expect(filterApps(apps, "alpha").map((a) => a.id)).toEqual(["alpha"]);
  });
});

describe("sortApps", () => {
  const apps = [
    makeApp({ id: "charlie", name: "Charlie", installedAt: "2026-01-03T00:00:00.000Z" }),
    makeApp({ id: "alpha", name: "Alpha", installedAt: "2026-01-01T00:00:00.000Z" }),
    makeApp({ id: "bravo", name: "Bravo", installedAt: null }),
    makeApp({ id: "delta", name: "Delta", installedAt: "2026-01-02T00:00:00.000Z" }),
  ];

  test("name-asc sorts alphabetically by display name", () => {
    expect(sortApps(apps, "name-asc").map((a) => a.id)).toEqual(["alpha", "bravo", "charlie", "delta"]);
  });

  test("name-desc sorts reverse alphabetically", () => {
    expect(sortApps(apps, "name-desc").map((a) => a.id)).toEqual(["delta", "charlie", "bravo", "alpha"]);
  });

  test("newest sorts by installedAt descending; missing installedAt is oldest", () => {
    expect(sortApps(apps, "newest").map((a) => a.id)).toEqual(["charlie", "delta", "alpha", "bravo"]);
  });

  test("oldest sorts by installedAt ascending; missing installedAt is oldest", () => {
    expect(sortApps(apps, "oldest").map((a) => a.id)).toEqual(["bravo", "alpha", "delta", "charlie"]);
  });
});

describe("filterAndSortApps", () => {
  test("filters then sorts", () => {
    const apps = [
      makeApp({ id: "zulu", name: "Zulu Notes", description: "notes app" }),
      makeApp({ id: "alpha", name: "Alpha Notes", description: "notes app" }),
      makeApp({ id: "beta", name: "Beta Paint", description: "drawing" }),
    ];
    expect(filterAndSortApps(apps, "notes", "name-asc").map((a) => a.id)).toEqual(["alpha", "zulu"]);
  });

  test("exports default sort and options", () => {
    expect(DEFAULT_APP_SORT).toBe("name-asc");
    expect(APP_SORT_OPTIONS.map((o) => o.key)).toEqual(["name-asc", "name-desc", "newest", "oldest"]);
  });
});
