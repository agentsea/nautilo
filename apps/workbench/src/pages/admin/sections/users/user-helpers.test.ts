import { describe, expect, test } from "bun:test";
import type { GroupRow } from "@nautilo/api-client/browser";

import { orderedCanonicalGroups } from "./user-helpers";

function group(type: string, roleSlug: string): GroupRow {
  return {
    id: type,
    type,
    label: type,
    isSystem: true,
    ownerId: null,
    roleSlugs: [roleSlug],
    memberCount: 0,
  };
}

describe("orderedCanonicalGroups", () => {
  test("places Community between Contributor and Guest", () => {
    const groups = [
      group("guests", "guest"),
      group("communities", "community"),
      group("contributors", "contributor"),
    ];

    expect(orderedCanonicalGroups(groups).map((item) => item.type)).toEqual([
      "contributors",
      "communities",
      "guests",
    ]);
  });
});
