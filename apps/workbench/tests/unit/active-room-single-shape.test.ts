import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const activeRoomSource = readFileSync(
  `${repoRoot}src/modes/rooms/shape/ActiveRoom.tsx`,
  "utf8",
);

describe("ActiveRoom single-shape dispatcher (M160)", () => {
  test("dispatches to the Slack shell only", () => {
    expect(activeRoomSource).toContain("SlackShapeRoom");
  });

  test("no multi-shape selection machinery remains", () => {
    // A `switch` on room shape, a shape-selection hook, or a sibling
    // renderer import would mean the three-way dispatcher crept back.
    expect(activeRoomSource).not.toContain("switch (");
    expect(activeRoomSource).not.toContain("/signal/");
    expect(activeRoomSource).not.toContain("agent-coord");
    expect(activeRoomSource).not.toContain("use-room-shape");
  });
});
