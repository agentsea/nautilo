import { describe, expect, test } from "bun:test";
import { WEBSITE_CATALOGUE, searchWebsiteCatalogue } from "./website-catalogue";

describe("WEBSITE_CATALOGUE", () => {
  test("keeps the launch presets in one browser-safe source", () => {
    expect(WEBSITE_CATALOGUE.map((website) => website.id)).toEqual(expect.arrayContaining([
      "google", "google-maps", "notion", "slack", "linkedin", "x", "facebook",
      "instagram", "pinterest", "reddit", "bluesky", "amazon", "etsy", "ebay", "walmart",
      "airbnb", "booking", "tripadvisor",
    ]));
    expect(WEBSITE_CATALOGUE.every((website) => website.startUrl.startsWith("https://"))).toBeTrue();
    expect(WEBSITE_CATALOGUE.every((website) => website.relatedDomains.length > 0)).toBeTrue();
  });

  test("searches names, domains, categories, and aliases without account state", () => {
    expect(searchWebsiteCatalogue("twitter").map((website) => website.id)).toEqual(["x"]);
    expect(searchWebsiteCatalogue("at protocol").map((website) => website.id)).toEqual(["bluesky"]);
    expect(searchWebsiteCatalogue("travel").map((website) => website.id)).toEqual([
      "airbnb", "booking", "tripadvisor",
    ]);
    expect(searchWebsiteCatalogue("not-a-site")).toEqual([]);
    expect(WEBSITE_CATALOGUE.some((website) => "connected" in website)).toBeFalse();
  });
});
