import { describe, expect, test } from "bun:test";
import { createEngagedSkillsHandle } from "./view-skill";
import { createEjectSkillTool } from "./eject-skill";

const USER_A = "00000000-0000-0000-0000-000000000001";
const AGENT_A = "00000000-0000-0000-0000-0000000000a1";

describe("eject (v1 engaged-set)", () => {
  test("removes an engaged skill name", async () => {
    const engagedSkills = createEngagedSkillsHandle(["alpha", "beta"]);
    const tool = createEjectSkillTool({
      ownerId: USER_A,
      agentId: AGENT_A,
      engagedSkills,
    });

    const result = await tool.invoke({ name: "alpha" });
    expect(result).toBe('Ejected skill "alpha".');
    expect(engagedSkills.toArray()).toEqual(["beta"]);
  });

  test("eject of un-pulled name is a clean no-op", async () => {
    const engagedSkills = createEngagedSkillsHandle(["beta"]);
    const tool = createEjectSkillTool({
      ownerId: USER_A,
      agentId: AGENT_A,
      engagedSkills,
    });

    const result = await tool.invoke({ name: "never-pulled" });
    expect(result).toBe('Ejected skill "never-pulled".');
    expect(engagedSkills.toArray()).toEqual(["beta"]);
  });

  test("missing context returns context error", async () => {
    const tool = createEjectSkillTool();
    const result = await tool.invoke({ name: "alpha" });
    expect(result).toBe("eject failed: no agent or user in context.");
  });
});
