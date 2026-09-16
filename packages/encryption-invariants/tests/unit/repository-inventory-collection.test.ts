import { describe, expect, test } from "bun:test";

import { collectInventorySteps } from "../../src/node/inventory-collection";

describe("repository inventory collection", () => {
  test("returns successful step values in declaration order", async () => {
    const values = await collectInventorySteps([
      { label: "first", collect: () => 7 },
      { label: "second", collect: async () => "ready" },
    ] as const);

    expect(values).toEqual([7, "ready"]);
  });

  test("runs every step and reports every collection failure", async () => {
    let completed = false;

    expect(collectInventorySteps([
      {
        label: "migration tree",
        collect: () => {
          throw new Error("missing tail snapshot");
        },
      },
      {
        label: "source alarms",
        collect: () => Promise.reject(new Error("new source alarm")),
      },
      {
        label: "DTO inventory",
        collect: () => {
          completed = true;
          return [];
        },
      },
    ] as const)).rejects.toThrow(
      "repository inventory collection failed:\n"
      + "migration tree: missing tail snapshot\n"
      + "source alarms: new source alarm",
    );
    expect(completed).toBe(true);
  });
});
