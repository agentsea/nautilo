import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as trust from "@nautilo/trust";
import * as skillsDb from "../../../db/src/queries/skills";
import {
  canManageSkillsForAgent,
  createSkillManageTool,
  ownsAgent,
  unknownSkillTools,
  validateSkillFields,
} from "../../src/tools/skills/skill-manage";

const USER_A = "00000000-0000-0000-0000-000000000001";
const AGENT_A = "00000000-0000-0000-0000-0000000000a1";
const AGENT_B = "00000000-0000-0000-0000-0000000000b1";

const restores: Array<() => void> = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

function mockGate(opts: {
  ownedAgentIds: string[];
  capabilities?: string[];
}) {
  const spOwned = spyOn(trust, "findPersonalAgentsForUser").mockImplementation(
    async (userId: string) => {
      if (userId === USER_A) {
        return opts.ownedAgentIds.map((agentId) => ({
          agentId,
          handle: "genie",
          displayName: "Genie",
        }));
      }
      return [];
    },
  );
  restores.push(() => spOwned.mockRestore());

  const spCaps = spyOn(trust, "getUserCapabilities").mockResolvedValue(
    opts.capabilities ?? [],
  );
  restores.push(() => spCaps.mockRestore());
}

describe("validateSkillFields (R10)", () => {
  test("accepts valid frontmatter fields", () => {
    const result = validateSkillFields({
      name: "teaching-mode",
      description: "Tutor a language",
      body: "# Teaching\n\nUse drills.",
      requiresTools: ["file"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("teaching-mode");
      expect(result.value.requiresTools).toEqual(["file"]);
    }
  });

  test("deduplicates requirements and identifies only unknown catalogue names", () => {
    const catalog = { has: (name: string) => name === "file" };
    expect(unknownSkillTools(["missing", "file", "missing"], catalog)).toEqual(["missing"]);
  });

  test("rejects invalid name slug", () => {
    const result = validateSkillFields({
      name: "Teaching_Mode",
      description: "x",
      body: "y",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("[a-z0-9-]");
    }
  });

  test("rejects missing description", () => {
    const result = validateSkillFields({
      name: "quiz",
      description: "   ",
      body: "content",
    });
    expect(result.ok).toBe(false);
  });
});

describe("canManageSkillsForAgent two-gate", () => {
  test("allows profile-owner self-edit without manage_agents", async () => {
    mockGate({ ownedAgentIds: [AGENT_A] });
    expect(await ownsAgent(USER_A, AGENT_A)).toBe(true);
    expect(await canManageSkillsForAgent(USER_A, AGENT_A)).toBe(true);
  });

  test("denies another user's agent without manage_agents", async () => {
    mockGate({ ownedAgentIds: [AGENT_A] });
    expect(await canManageSkillsForAgent(USER_A, AGENT_B)).toBe(false);
  });

  test("allows cross-agent edit with manage_agents", async () => {
    mockGate({ ownedAgentIds: [AGENT_A], capabilities: ["manage_agents"] });
    expect(await canManageSkillsForAgent(USER_A, AGENT_B)).toBe(true);
  });
});

describe("skill_manage tool CRUD", () => {
  test("create happy path", async () => {
    mockGate({ ownedAgentIds: [AGENT_A] });
    const spGet = spyOn(skillsDb, "getByName").mockResolvedValue(null);
    restores.push(() => spGet.mockRestore());
    const spUpsert = spyOn(skillsDb, "upsertSkill").mockResolvedValue({
      id: "skill-1",
      agentId: AGENT_A,
      userId: USER_A,
      name: "teaching-mode",
      description: "Tutor",
      body: "body",
      enabled: true,
      requiresTools: [],
      source: "agent",
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });
    restores.push(() => spUpsert.mockRestore());

    const tool = createSkillManageTool({ ownerId: USER_A, agentId: AGENT_A });
    const out = await tool.invoke({
      action: "create",
      name: "teaching-mode",
      description: "Tutor",
      body: "body",
    });
    expect(out).toContain("created");
    expect(spUpsert).toHaveBeenCalled();
  });

  test("two-gate denial on another user's agent", async () => {
    mockGate({ ownedAgentIds: [AGENT_A] });
    const tool = createSkillManageTool({ ownerId: USER_A, agentId: AGENT_B });
    const out = await tool.invoke({
      action: "create",
      name: "teaching-mode",
      description: "Tutor",
      body: "body",
    });
    expect(out).toContain("denied");
  });

  test("malformed frontmatter rejected", async () => {
    mockGate({ ownedAgentIds: [AGENT_A] });
    const tool = createSkillManageTool({ ownerId: USER_A, agentId: AGENT_A });
    const out = await tool.invoke({
      action: "create",
      name: "Bad Name",
      description: "x",
      body: "y",
    });
    expect(out).toContain("failed");
    expect(out).toContain("[a-z0-9-]");
  });

  test("delete happy path", async () => {
    mockGate({ ownedAgentIds: [AGENT_A] });
    const spDelete = spyOn(skillsDb, "softDeleteSkill").mockResolvedValue(true);
    restores.push(() => spDelete.mockRestore());

    const tool = createSkillManageTool({ ownerId: USER_A, agentId: AGENT_A });
    const out = await tool.invoke({ action: "delete", name: "teaching-mode" });
    expect(out).toContain("deleted");
  });
});
