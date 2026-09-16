import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OFFICIAL_SKILLS } from "../../../packages/agent/src/skills/bundled/index.ts";
import { projectOfficialSkills, renderProjectedSkill } from "./evaluate.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

describe("official skill evaluator projection", () => {
  test("renders strict YAML metadata without changing the canonical body", () => {
    const skill = OFFICIAL_SKILLS.find((candidate) => candidate.name === "office-calc");
    expect(skill).toBeDefined();

    const projected = renderProjectedSkill(skill!);
    const bodyStart = projected.indexOf("\n---\n", 4) + "\n---\n".length;

    expect(projected).toContain(`description: ${JSON.stringify(skill!.description)}`);
    expect(projected).toContain("license: MIT");
    expect(projected.slice(bodyStart)).toBe(skill!.body);
  });

  test("projects every canonical official skill and the repository license", async () => {
    const destinationRoot = await temporaryRoot("nautilo-skill-projection-");
    const repositoryRoot = await temporaryRoot("nautilo-skill-repository-");
    await writeFile(join(repositoryRoot, "LICENSE"), "test license\n", "utf8");

    const skillsRoot = await projectOfficialSkills({ destinationRoot, repositoryRoot });
    const projectedNames = (await readdir(skillsRoot)).sort();
    const canonicalNames = OFFICIAL_SKILLS.map((skill) => skill.name).sort();

    expect(projectedNames).toEqual(canonicalNames);
    expect(await readFile(join(destinationRoot, "LICENSE"), "utf8")).toBe("test license\n");

    for (const skill of OFFICIAL_SKILLS) {
      const projected = await readFile(join(skillsRoot, skill.name, "SKILL.md"), "utf8");
      const bodyStart = projected.indexOf("\n---\n", 4) + "\n---\n".length;
      expect(projected.slice(bodyStart)).toBe(skill.body);
    }
  });

  test("keeps reviewed Nautilo policy differences advisory", async () => {
    const policy = await readFile(resolve(import.meta.dir, "policy.yaml"), "utf8");

    expect(policy).toContain("SCHEMA.author_missing: medium");
    expect(policy).toContain("QUALITY.quality_efficiency: medium");
    expect(policy).toContain("PII.personal_paths: medium");
    expect(policy).not.toContain("SCHEMA.author_format");
    expect(policy).not.toContain("QUALITY.*");
    expect(policy).not.toContain("PII.*");
  });
});
