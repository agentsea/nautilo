import { describe, expect, test } from "bun:test";
import {
  selectSkillsForTurn,
  type SkillBody,
} from "./select-skills-for-turn";

function skill(
  name: string,
  body: string,
  opts?: Partial<Pick<SkillBody, "description" | "requiresTools">>,
): SkillBody {
  return {
    id: `id-${name}`,
    name,
    description: opts?.description ?? `${name} description`,
    body,
    requiresTools: opts?.requiresTools ?? [],
  };
}

describe("selectSkillsForTurn (v1 catalog-only)", () => {
  test("returns catalog entries without auto-injecting bodies", () => {
    const alpha = skill("alpha", "a".repeat(500));
    const beta = skill("beta", "b".repeat(500));

    const result = selectSkillsForTurn({
      skills: [alpha, beta],
      availableToolNames: [],
    });

    expect(result.catalog.map((c) => c.name)).toEqual(["alpha", "beta"]);
    expect(Object.keys(result)).toEqual(["catalog"]);
  });

  test("caller passes empty skills for guest path", () => {
    const result = selectSkillsForTurn({
      skills: [],
      availableToolNames: ["file", "search_memory"],
    });

    expect(result.catalog).toEqual([]);
  });

  test("withholds skills when a required tool is absent (R15)", () => {
    const gated = skill("teach", "teaching instructions", {
      requiresTools: ["file"],
    });
    const open = skill("chat", "chat instructions");

    const withheld = selectSkillsForTurn({
      skills: [gated, open],
      availableToolNames: ["search_memory"],
    });
    expect(withheld.catalog.map((c) => c.name)).toEqual(["chat"]);

    const allowed = selectSkillsForTurn({
      skills: [gated, open],
      availableToolNames: ["file", "search_memory"],
    });
    expect(allowed.catalog.map((c) => c.name)).toEqual(["teach", "chat"]);
  });

  test("lists authorized deferred dependencies with an activation hint, never forbidden ones", () => {
    const file = skill("file-authoring", "Create an artifact", {
      requiresTools: ["file", "read_artifact_events"],
    });
    const office = skill("office-authoring", "Generate a spreadsheet", {
      requiresTools: ["officecli"],
    });
    const media = skill("media-authoring", "Generate an image", {
      requiresTools: ["generate_image"],
    });

    const result = selectSkillsForTurn({
      skills: [file, office, media],
      availableToolNames: [],
      eligibleToolNames: ["file", "read_artifact_events", "officecli"],
    });

    expect(result.catalog.map((entry) => entry.name)).toEqual([
      "file-authoring",
      "office-authoring",
    ]);
    expect(result.catalog[0]).toMatchObject({
      activationHint: "activate filesystem: file, read_artifact_events",
    });
    expect(result.catalog[1]).toMatchObject({
      activationHint: "activate productivity: officecli",
    });
    expect(result.catalog.some((entry) => entry.name === "media-authoring")).toBe(false);
  });

  test("caps the catalog block under catalogBudgetChars", () => {
    const skills = [
      skill("one", "body", { description: "d".repeat(200) }),
      skill("two", "body", { description: "e".repeat(200) }),
      skill("three", "body", { description: "f".repeat(200) }),
    ];

    const result = selectSkillsForTurn({
      skills,
      availableToolNames: [],
      catalogBudgetChars: 250,
    });

    expect(result.catalog.length).toBeGreaterThan(0);
    expect(result.catalog.length).toBeLessThan(skills.length);
  });
});
