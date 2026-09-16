import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as skillsDb from "@nautilo/db";
import {
  formatSkillSlashUserMessage,
  parseSkillSlashCommand,
  resolveSkillSlashCommandContent,
} from "../../src/messaging/skill-slash-command";

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

describe("parseSkillSlashCommand", () => {
  test("parses name only", () => {
    expect(parseSkillSlashCommand("/skill teaching-mode")).toEqual({
      name: "teaching-mode",
      trailingText: "",
    });
  });

  test("parses name and trailing user text", () => {
    expect(parseSkillSlashCommand("/skill teaching-mode help me practice")).toEqual({
      name: "teaching-mode",
      trailingText: "help me practice",
    });
  });

  test("returns null for non-skill slash commands", () => {
    expect(parseSkillSlashCommand("/undo")).toBeNull();
    expect(parseSkillSlashCommand("hello /skill foo")).toBeNull();
  });
});

describe("formatSkillSlashUserMessage", () => {
  test("embeds skill body with optional trailing text", () => {
    const out = formatSkillSlashUserMessage(
      { name: "quiz", body: "# Quiz\n\nAsk questions." },
      "start now",
    );
    expect(out).toContain("## Skill: quiz");
    expect(out).toContain("# Quiz");
    expect(out).toContain("start now");
  });
});

describe("resolveSkillSlashCommandContent (/skill dispatch)", () => {
  test("expands enabled skill into user-turn content", async () => {
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

    const out = await resolveSkillSlashCommandContent(
      "/skill teaching-mode help me practice",
      AGENT_A,
      USER_A,
    );
    expect(out.handled).toBe(true);
    expect(out.content).toContain("## Skill: teaching-mode");
    expect(out.content).toContain("# Teaching");
    expect(out.content).toContain("help me practice");
  });

  test("miss returns not-found user message", async () => {
    mockGetByName(async () => null);

    const out = await resolveSkillSlashCommandContent(
      "/skill missing",
      AGENT_A,
      USER_A,
    );
    expect(out.handled).toBe(true);
    expect(out.content).toBe('Skill "missing" not found.');
  });

  test("disabled skill is treated as not found", async () => {
    mockGetByName(async () => ({
      id: "skill-2",
      agentId: AGENT_A,
      userId: USER_A,
      name: "off-mode",
      description: "Off",
      body: "secret",
      enabled: false,
      requiresTools: [],
      source: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    }));

    const out = await resolveSkillSlashCommandContent(
      "/skill off-mode",
      AGENT_A,
      USER_A,
    );
    expect(out.handled).toBe(true);
    expect(out.content).toBe('Skill "off-mode" not found.');
    expect(out.content).not.toContain("secret");
  });

  test("cross-user isolation at dispatch", async () => {
    mockGetByName(async (agentId, userId, name) => {
      if (agentId === AGENT_A && userId === USER_B && name === "teaching-mode") {
        return {
          id: "skill-b",
          agentId: AGENT_A,
          userId: USER_B,
          name: "teaching-mode",
          description: "Other",
          body: "other body",
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

    const out = await resolveSkillSlashCommandContent(
      "/skill teaching-mode",
      AGENT_A,
      USER_A,
    );
    expect(out.handled).toBe(true);
    expect(out.content).toBe('Skill "teaching-mode" not found.');
  });

  test("non-skill messages pass through unchanged", async () => {
    const out = await resolveSkillSlashCommandContent(
      "tutor me in French",
      AGENT_A,
      USER_A,
    );
    expect(out.handled).toBe(false);
    expect(out.content).toBe("tutor me in French");
  });
});
