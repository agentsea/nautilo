import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { clearToolCatalog, initToolCatalog, ToolCatalog } from "@nautilo/catalog";
import { setConfigOverrides } from "@nautilo/config";
import * as skillsDb from "@nautilo/db";
import type { SkillBody } from "@nautilo/db";
import { z } from "zod";
import { getBundledSkill } from "../../src/skills/bundled";
import { registerAllTools } from "../../src/tools/register-all";
import { createDiscoverSkillsTool } from "../../src/tools/skills/discover-skills";

const OFFICIAL_SKILL_NAME = "interactive-artifact-authoring";
const officialBundled = getBundledSkill(OFFICIAL_SKILL_NAME)!;
const MINI_APP_SKILL_NAME = "mini-app-authoring";
const miniAppBundled = getBundledSkill(MINI_APP_SKILL_NAME)!;
const OFFICE_GENERATE_SKILL_NAME = "office-generate";
const officeGenerateBundled = getBundledSkill(OFFICE_GENERATE_SKILL_NAME)!;

const USER_A = "00000000-0000-0000-0000-000000000001";
const AGENT_A = "00000000-0000-0000-0000-0000000000a1";

const restores: Array<() => void> = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
  setConfigOverrides({ nautilo_office_enabled: false });
});

function mockGetEnabledBodies(
  impl: (
    agentId: string,
    userId: string,
  ) => ReturnType<typeof skillsDb.getEnabledBodies>,
) {
  const sp = spyOn(skillsDb, "getEnabledBodies").mockImplementation(impl);
  restores.push(() => sp.mockRestore());
}

function makeSkill(
  name: string,
  description: string,
  requiresTools: string[] = [],
): SkillBody {
  return {
    id: `id-${name}`,
    name,
    description,
    body: `# ${name}`,
    requiresTools,
  };
}

function parseResponse(raw: string) {
  return JSON.parse(raw) as {
    results: Array<{
      name: string;
      description: string;
      requiresTools: string[];
      activationHint?: string;
    }>;
    truncated: boolean;
    hint?: string;
    nextCursor?: string;
  };
}

describe("discover_skills", () => {
  test("query matches name and description (case-insensitive)", async () => {
    mockGetEnabledBodies(async () => [
      makeSkill("teaching-mode", "Tutor in French"),
      makeSkill("quiz-mode", "Make quizzes fast"),
    ]);

    const tool = createDiscoverSkillsTool({ ownerId: USER_A, agentId: AGENT_A });

    const byName = parseResponse(await tool.invoke({ query: "TEACHING" }));
    expect(byName.results.map((r) => r.name)).toEqual(["teaching-mode"]);

    const byDescription = parseResponse(await tool.invoke({ query: "quizzes" }));
    expect(byDescription.results.map((r) => r.name)).toEqual(["quiz-mode"]);
  });

  test("pagination — page fills, truncated hint and nextCursor when >25 match", async () => {
    const skills = Array.from({ length: 30 }, (_, i) => {
      const n = String(i).padStart(2, "0");
      return makeSkill(`skill-${n}`, `Topic alpha ${n}`);
    });
    mockGetEnabledBodies(async () => skills);

    const tool = createDiscoverSkillsTool({ ownerId: USER_A, agentId: AGENT_A });
    const page1 = parseResponse(await tool.invoke({ query: "topic" }));

    expect(page1.results).toHaveLength(25);
    expect(page1.truncated).toBe(true);
    expect(page1.hint).toBe("narrow your query (5 more match)");
    expect(page1.nextCursor).toBe("25");

    const page2 = parseResponse(
      await tool.invoke({ query: "topic", cursor: page1.nextCursor }),
    );
    expect(page2.results).toHaveLength(5);
    expect(page2.truncated).toBe(false);
    expect(page2.hint).toBeUndefined();
    expect(page2.nextCursor).toBeUndefined();
  });

  test("guest and missing context return empty results", async () => {
    mockGetEnabledBodies(async () => [makeSkill("teaching-mode", "Tutor")]);

    const guestTool = createDiscoverSkillsTool({
      ownerId: USER_A,
      agentId: AGENT_A,
      actorRole: "guest",
    });
    const guestResult = parseResponse(await guestTool.invoke({}));
    expect(guestResult.results).toEqual([]);
    expect(guestResult.truncated).toBe(false);

    const noContextTool = createDiscoverSkillsTool();
    const noContextResult = parseResponse(await noContextTool.invoke({}));
    expect(noContextResult.results).toEqual([]);
    expect(noContextResult.truncated).toBe(false);
  });

  test("requiresTools present in each result", async () => {
    const catalog = new ToolCatalog();
    setConfigOverrides({ nautilo_office_enabled: true });
    // M203 — officecli registration is gated on a usable binary (no longer
    // committed to git). Force it on so the office bundled skills' requiresTools
    // are satisfied regardless of whether the host has provisioned a binary.
    registerAllTools(catalog, { officeCliAvailable: () => true });
    initToolCatalog(catalog);
    restores.push(() => clearToolCatalog());

    mockGetEnabledBodies(async () => [
      makeSkill("needs-search", "Uses memory", ["search_memory"]),
      makeSkill("plain", "No deps", []),
    ]);

    const tool = createDiscoverSkillsTool({
      ownerId: USER_A,
      agentId: AGENT_A,
      actorRole: "owner",
      relayCapabilities: { canUseComputer: true },
      memoryAccessEnvelope: {
        ownerId: USER_A,
        actorId: "actor-a",
        agentId: AGENT_A,
        roomId: "room-a",
        readableNamespaces: [],
        mutableNamespaces: [],
        writableNamespaces: [],
        toolPolicy: { search_memory: "read_only" },
      },
    });
    const result = parseResponse(await tool.invoke({}));

    expect(result.results.map((r) => r.name).sort()).toEqual([
      "computer-use",
      "connected-websites",
      MINI_APP_SKILL_NAME,
      "mcp-setup",
      OFFICIAL_SKILL_NAME,
      "needs-search",
      "office-calc",
      "office-control",
      OFFICE_GENERATE_SKILL_NAME,
      "office-impress",
      "plain",
    ].sort());
    expect(result.results.find((r) => r.name === "needs-search")?.requiresTools).toEqual([
      "search_memory",
    ]);
    expect(result.results.find((r) => r.name === "plain")?.requiresTools).toEqual([]);
    expect(result.results.find((r) => r.name === OFFICIAL_SKILL_NAME)?.requiresTools).toEqual(
      officialBundled.requiresTools,
    );
    expect(result.results.find((r) => r.name === MINI_APP_SKILL_NAME)?.requiresTools).toEqual(
      miniAppBundled.requiresTools,
    );
    expect(result.results.find((r) => r.name === OFFICE_GENERATE_SKILL_NAME)?.requiresTools).toEqual(
      officeGenerateBundled.requiresTools,
    );
  });

  test("lists authorized deferred file and Office skills with hints, but hides forbidden media", async () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog, { officeCliAvailable: () => true });
    initToolCatalog(catalog);
    restores.push(() => clearToolCatalog());
    mockGetEnabledBodies(async () => [
      makeSkill("file-authoring", "Create an artifact", ["file", "read_artifact_events"]),
      makeSkill("office-authoring", "Generate a spreadsheet", ["officecli"]),
      makeSkill("media-authoring", "Generate an image", ["generate_image"]),
    ]);

    const tool = createDiscoverSkillsTool({
      ownerId: USER_A,
      agentId: AGENT_A,
      memoryAccessEnvelope: {
        ownerId: USER_A,
        actorId: "actor-a",
        agentId: AGENT_A,
        roomId: "room-a",
        readableNamespaces: [],
        mutableNamespaces: [],
        writableNamespaces: [],
        toolPolicy: {
          file: "allow",
          read_artifact_events: "read_only",
          officecli: "allow",
          generate_image: "forbidden",
        },
      },
    });

    const result = parseResponse(await tool.invoke({ query: "authoring" }));
    expect(result.results.map((entry) => entry.name)).toContain("file-authoring");
    expect(result.results.map((entry) => entry.name)).toContain("office-authoring");
    expect(result.results.find((entry) => entry.name === "file-authoring")?.activationHint).toBe(
      "activate filesystem: file, read_artifact_events",
    );
    expect(result.results.find((entry) => entry.name === "office-authoring")?.activationHint)
      .toBe("activate productivity: officecli");
    expect(result.results.some((entry) => entry.name === "media-authoring")).toBe(false);
  });

  test("uses catalog metadata without constructing deferred schemas", async () => {
    let factoryCalls = 0;
    const catalog = new ToolCatalog();
    catalog.register({
      name: "file",
      category: "files",
      trustTier: "guest",
      impact: "read-only",
      exposure: "discoverable",
      factory: () => {
        factoryCalls += 1;
        return new DynamicStructuredTool({
          name: "file",
          description: "Deferred file tool",
          schema: z.object({}),
          func: async () => "ok",
        });
      },
    });
    initToolCatalog(catalog);
    restores.push(() => clearToolCatalog());
    mockGetEnabledBodies(async () => [makeSkill("file-authoring", "Create files", ["file"])]);

    const tool = createDiscoverSkillsTool({
      ownerId: USER_A,
      agentId: AGENT_A,
      memoryAccessEnvelope: {
        ownerId: USER_A,
        actorId: "actor-a",
        agentId: AGENT_A,
        roomId: "room-a",
        readableNamespaces: [],
        mutableNamespaces: [],
        writableNamespaces: [],
        toolPolicy: { file: "allow" },
      },
    });
    const result = parseResponse(await tool.invoke({}));

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.activationHint).toBe("activate filesystem: file");
    // One construction is required at catalog registration to capture its
    // description; discovery itself must not create another schema instance.
    expect(factoryCalls).toBe(1);
  });

  test("no match returns a clear message", async () => {
    mockGetEnabledBodies(async () => [makeSkill("teaching-mode", "Tutor")]);

    const tool = createDiscoverSkillsTool({ ownerId: USER_A, agentId: AGENT_A });
    const result = await tool.invoke({ query: "nonexistent" });

    expect(result).toContain("No skills found");
    expect(result).toContain('matching "nonexistent"');
  });

  test("official skill appears when requiresTools are satisfied", async () => {
    const catalog = new ToolCatalog();
    setConfigOverrides({ nautilo_office_enabled: true });
    // M203 — officecli registration is gated on a usable binary (no longer
    // committed to git). Force it on so the office bundled skills' requiresTools
    // are satisfied regardless of whether the host has provisioned a binary.
    registerAllTools(catalog, { officeCliAvailable: () => true });
    initToolCatalog(catalog);
    restores.push(() => clearToolCatalog());

    mockGetEnabledBodies(async () => []);

    const tool = createDiscoverSkillsTool({
      ownerId: USER_A,
      agentId: AGENT_A,
      actorRole: "owner",
      relayCapabilities: { canUseComputer: true },
      memoryAccessEnvelope: {
        ownerId: USER_A,
        actorId: "actor-a",
        agentId: AGENT_A,
        roomId: "room-a",
        readableNamespaces: [],
        mutableNamespaces: [],
        writableNamespaces: [],
        toolPolicy: {
          file: "allow",
          read_artifact_events: "read_only",
        },
      },
    });
    const result = parseResponse(await tool.invoke({}));

    expect(result.results.map((r) => r.name)).toEqual([
      "computer-use",
      "connected-websites",
      OFFICIAL_SKILL_NAME,
      "mcp-setup",
      MINI_APP_SKILL_NAME,
      "office-calc",
      "office-control",
      OFFICE_GENERATE_SKILL_NAME,
      "office-impress",
    ]);
    const officialResult = result.results.find((r) => r.name === OFFICIAL_SKILL_NAME);
    expect(officialResult?.description).toBe(officialBundled.description);
    expect(officialResult?.requiresTools).toEqual(officialBundled.requiresTools);
    const miniAppResult = result.results.find((r) => r.name === MINI_APP_SKILL_NAME);
    expect(miniAppResult?.description).toBe(miniAppBundled.description);
    expect(miniAppResult?.requiresTools).toEqual(miniAppBundled.requiresTools);
    const officeGenerateResult = result.results.find((r) => r.name === OFFICE_GENERATE_SKILL_NAME);
    expect(officeGenerateResult?.description).toBe(officeGenerateBundled.description);
    expect(officeGenerateResult?.requiresTools).toEqual(officeGenerateBundled.requiresTools);
  });

  test("official skill withheld when requiresTools are not satisfied", async () => {
    mockGetEnabledBodies(async () => [makeSkill("plain", "No deps", [])]);

    const tool = createDiscoverSkillsTool({ ownerId: USER_A, agentId: AGENT_A });
    const result = parseResponse(await tool.invoke({}));

    expect(result.results.map((r) => r.name)).toEqual(["plain"]);
    expect(result.results.some((r) => r.name === OFFICIAL_SKILL_NAME)).toBe(false);
  });

  test("Computer Use guidance follows the actual observation tool's relay availability", async () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    initToolCatalog(catalog);
    restores.push(() => clearToolCatalog());
    mockGetEnabledBodies(async () => []);

    for (const enabled of [false, true]) {
      const tool = createDiscoverSkillsTool({
        ownerId: USER_A,
        agentId: AGENT_A,
        actorRole: "owner",
        relayCapabilities: { canUseComputer: enabled },
      });
      const response = await tool.invoke({ query: "computer-use" });
      if (enabled) {
        const result = parseResponse(response);
        expect(result.results.map((entry) => entry.name)).toEqual(["computer-use"]);
        expect(result.results[0]?.requiresTools).toEqual(["computer_observe"]);
      } else {
        expect(response).toContain("No skills found");
      }
    }
  });

  test("DB row shadows official skill by name in discover results", async () => {
    const catalog = new ToolCatalog();
    setConfigOverrides({ nautilo_office_enabled: true });
    // M203 — officecli registration is gated on a usable binary (no longer
    // committed to git). Force it on so the office bundled skills' requiresTools
    // are satisfied regardless of whether the host has provisioned a binary.
    registerAllTools(catalog, { officeCliAvailable: () => true });
    initToolCatalog(catalog);
    restores.push(() => clearToolCatalog());

    mockGetEnabledBodies(async () => [
      makeSkill(OFFICIAL_SKILL_NAME, "Forked description", []),
    ]);

    const tool = createDiscoverSkillsTool({
      ownerId: USER_A,
      agentId: AGENT_A,
      actorRole: "owner",
      relayCapabilities: { canUseComputer: true },
      memoryAccessEnvelope: {
        ownerId: USER_A,
        actorId: "actor-a",
        agentId: AGENT_A,
        roomId: "room-a",
        readableNamespaces: [],
        mutableNamespaces: [],
        writableNamespaces: [],
        toolPolicy: {
          file: "allow",
          read_artifact_events: "read_only",
        },
      },
    });
    const result = parseResponse(await tool.invoke({}));

    expect(result.results.map((r) => r.name)).toEqual([
      "computer-use",
      "connected-websites",
      OFFICIAL_SKILL_NAME,
      "mcp-setup",
      MINI_APP_SKILL_NAME,
      "office-calc",
      "office-control",
      OFFICE_GENERATE_SKILL_NAME,
      "office-impress",
    ]);
    const shadowed = result.results.find((r) => r.name === OFFICIAL_SKILL_NAME);
    expect(shadowed?.description).toBe("Forked description");
    expect(shadowed?.requiresTools).toEqual([]);
  });
});
