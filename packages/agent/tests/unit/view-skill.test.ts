import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as skillsDb from "@nautilo/db";
import { getBundledSkill } from "../../src/skills/bundled";
import { buildSkillBodyBlock } from "../../src/prompts/templates";
import {
  createEngagedSkillsHandle,
  createViewSkillTool,
} from "../../src/tools/skills/view-skill";

const OFFICIAL_SKILL_NAME = "interactive-artifact-authoring";
const officialBundled = getBundledSkill(OFFICIAL_SKILL_NAME)!;

const USER_A = "00000000-0000-0000-0000-000000000001";
const USER_B = "00000000-0000-0000-0000-000000000002";
const AGENT_A = "00000000-0000-0000-0000-0000000000a1";

const restores: Array<() => void> = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

function mockGetByName(
  impl: (
    agentId: string,
    userId: string,
    name: string,
  ) => ReturnType<typeof skillsDb.getByName>,
) {
  const sp = spyOn(skillsDb, "getByName").mockImplementation(impl);
  restores.push(() => sp.mockRestore());
}

describe("view_skill (v1 pull + engage)", () => {
  test("returns headered body and marks skill engaged", async () => {
    mockGetByName(async (agentId, userId, name) => {
      if (agentId === AGENT_A && userId === USER_A && name === "teaching-mode") {
        return {
          id: "skill-1",
          agentId: AGENT_A,
          userId: USER_A,
          name: "teaching-mode",
          description: "Tutor",
          body: "# Teaching\n\nUse drills.",
          enabled: true,
          requiresTools: [],
          source: "user",
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        };
      }
      return null;
    });

    const engagedSkills = createEngagedSkillsHandle([]);
    const tool = createViewSkillTool({
      ownerId: USER_A,
      agentId: AGENT_A,
      engagedSkills,
    });
    const result = await tool.invoke({ name: "teaching-mode" });

    expect(result).toBe(
      buildSkillBodyBlock({ name: "teaching-mode", body: "# Teaching\n\nUse drills." }),
    );
    expect(engagedSkills.toArray()).toEqual(["teaching-mode"]);
  });

  test("miss returns clean not-found message without engaging", async () => {
    mockGetByName(async () => null);

    const engagedSkills = createEngagedSkillsHandle([]);
    const tool = createViewSkillTool({
      ownerId: USER_A,
      agentId: AGENT_A,
      engagedSkills,
    });
    const result = await tool.invoke({ name: "missing-skill" });
    expect(result).toBe('Skill "missing-skill" not found.');
    expect(engagedSkills.toArray()).toEqual([]);
  });

  test("cross-user isolation — other speaker's skill is not found", async () => {
    mockGetByName(async (agentId, userId, name) => {
      if (agentId === AGENT_A && userId === USER_B && name === "teaching-mode") {
        return {
          id: "skill-b",
          agentId: AGENT_A,
          userId: USER_B,
          name: "teaching-mode",
          description: "Other user",
          body: "other user body",
          enabled: true,
          requiresTools: [],
          source: "user",
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        };
      }
      return null;
    });

    const engagedSkills = createEngagedSkillsHandle([]);
    const tool = createViewSkillTool({
      ownerId: USER_A,
      agentId: AGENT_A,
      engagedSkills,
    });
    const result = await tool.invoke({ name: "teaching-mode" });
    expect(result).toBe('Skill "teaching-mode" not found.');
    expect(engagedSkills.toArray()).toEqual([]);
  });

  test("missing context returns context error", async () => {
    const tool = createViewSkillTool();
    const result = await tool.invoke({ name: "teaching-mode" });
    expect(result).toBe("view_skill failed: no agent or user in context.");
  });

  test("official skill returns bundled body when no DB row exists", async () => {
    mockGetByName(async () => null);

    const engagedSkills = createEngagedSkillsHandle([]);
    const tool = createViewSkillTool({
      ownerId: USER_A,
      agentId: AGENT_A,
      engagedSkills,
    });
    const result = await tool.invoke({ name: OFFICIAL_SKILL_NAME });

    expect(result).toBe(
      buildSkillBodyBlock({ name: OFFICIAL_SKILL_NAME, body: officialBundled.body }),
    );
    expect(engagedSkills.toArray()).toEqual([OFFICIAL_SKILL_NAME]);
  });

  test("DB row shadows official skill by name", async () => {
    mockGetByName(async (agentId, userId, name) => {
      if (
        agentId === AGENT_A &&
        userId === USER_A &&
        name === OFFICIAL_SKILL_NAME
      ) {
        return {
          id: "fork-1",
          agentId: AGENT_A,
          userId: USER_A,
          name: OFFICIAL_SKILL_NAME,
          description: "User fork",
          body: "# My forked authoring rules",
          enabled: true,
          requiresTools: [],
          source: "user",
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        };
      }
      return null;
    });

    const engagedSkills = createEngagedSkillsHandle([]);
    const tool = createViewSkillTool({
      ownerId: USER_A,
      agentId: AGENT_A,
      engagedSkills,
    });
    const result = await tool.invoke({ name: OFFICIAL_SKILL_NAME });

    expect(result).toBe(
      buildSkillBodyBlock({
        name: OFFICIAL_SKILL_NAME,
        body: "# My forked authoring rules",
      }),
    );
    expect(result).not.toContain(officialBundled.body.slice(0, 40));
    expect(engagedSkills.toArray()).toEqual([OFFICIAL_SKILL_NAME]);
  });

  test("disabled DB row hides official skill", async () => {
    mockGetByName(async (agentId, userId, name) => {
      if (
        agentId === AGENT_A &&
        userId === USER_A &&
        name === OFFICIAL_SKILL_NAME
      ) {
        return {
          id: "disabled-fork",
          agentId: AGENT_A,
          userId: USER_A,
          name: OFFICIAL_SKILL_NAME,
          description: "Disabled fork",
          body: "should not surface",
          enabled: false,
          requiresTools: [],
          source: "user",
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        };
      }
      return null;
    });

    const engagedSkills = createEngagedSkillsHandle([]);
    const tool = createViewSkillTool({
      ownerId: USER_A,
      agentId: AGENT_A,
      engagedSkills,
    });
    const result = await tool.invoke({ name: OFFICIAL_SKILL_NAME });

    expect(result).toBe(`Skill "${OFFICIAL_SKILL_NAME}" not found.`);
    expect(engagedSkills.toArray()).toEqual([]);
  });

  test("guest actorRole returns not found even for official skill", async () => {
    mockGetByName(async () => null);

    const engagedSkills = createEngagedSkillsHandle([]);
    const tool = createViewSkillTool({
      ownerId: USER_A,
      agentId: AGENT_A,
      actorRole: "guest",
      engagedSkills,
    });
    const result = await tool.invoke({ name: OFFICIAL_SKILL_NAME });

    expect(result).toBe(`Skill "${OFFICIAL_SKILL_NAME}" not found.`);
    expect(engagedSkills.toArray()).toEqual([]);
  });
});
