import { describe, test, expect, spyOn, afterEach } from "bun:test";
import * as trust from "@nautilo/trust";
import { findAgentUserByNormalizedHandle } from "@nautilo/trust";

describe("findAgentUserByNormalizedHandle (M078)", () => {
  const restores: Array<() => void> = [];

  afterEach(() => {
    while (restores.length) restores.pop()!();
  });

  test("returns row when handle matches roster (case-insensitive)", async () => {
    const sp = spyOn(trust, "listAgentUsers").mockResolvedValue([
      { userId: "u-1", handle: "Bob", displayName: "B", role: "owner" },
    ]);
    restores.push(() => sp.mockRestore());
    const row = await findAgentUserByNormalizedHandle("ag-1", "@bob");
    expect(row?.userId).toBe("u-1");
  });

  test("returns null when not on roster", async () => {
    const sp = spyOn(trust, "listAgentUsers").mockResolvedValue([
      { userId: "u-1", handle: "other", displayName: "O", role: "owner" },
    ]);
    restores.push(() => sp.mockRestore());
    const row = await findAgentUserByNormalizedHandle("ag-1", "carol");
    expect(row).toBeNull();
  });
});
