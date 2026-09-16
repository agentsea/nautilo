import { describe, expect, test } from "bun:test";
import {
  parseComputerUseOwnedAgents,
  selectComputerUseOwnedAgent,
} from "../../electron/computer-use/owned-agent-selection.ts";

describe("D516 Computer use owned Genie selection", () => {
  test("keeps the complete current owned-Agent projection and resolves only the requested exact ID", () => {
    const agents = parseComputerUseOwnedAgents({
      viewerRole: "owner",
      ownedAgents: [
        { agentId: "agent-first", displayName: "First", handle: "first" },
        { agentId: "agent-chosen", displayName: "Chosen", handle: "chosen" },
      ],
    });
    expect(agents).toEqual([
      { agentId: "agent-first", displayName: "First", handle: "first" },
      { agentId: "agent-chosen", displayName: "Chosen", handle: "chosen" },
    ]);
    expect(selectComputerUseOwnedAgent(agents!, "agent-chosen")).toEqual({
      agentId: "agent-chosen", displayName: "Chosen", handle: "chosen",
    });
    expect(selectComputerUseOwnedAgent(agents!, "agent-not-owned")).toBeNull();
  });

  test("rejects incomplete or non-owner profile projections rather than guessing an Agent", () => {
    expect(parseComputerUseOwnedAgents({ viewerRole: "guest", ownedAgents: [] })).toBeNull();
    expect(parseComputerUseOwnedAgents({
      viewerRole: "owner",
      ownedAgents: [{ agentId: "agent-1", displayName: "Genie" }],
    })).toBeNull();
    expect(parseComputerUseOwnedAgents({
      viewerRole: "owner",
      ownedAgents: [
        { agentId: "agent-1", displayName: "First", handle: "first" },
        { agentId: "agent-1", displayName: "Duplicated", handle: "duplicate" },
      ],
    })).toBeNull();
  });
});
