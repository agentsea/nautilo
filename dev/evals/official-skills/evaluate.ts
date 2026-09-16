#!/usr/bin/env bun

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  OFFICIAL_SKILLS,
  type BundledSkill,
} from "../../../packages/agent/src/skills/bundled/index.ts";

const EVALUATION_ROOT = import.meta.dir;
const REPOSITORY_ROOT = resolve(EVALUATION_ROOT, "../../..");
const DEFAULT_RESULTS_ROOT = join(EVALUATION_ROOT, ".results");
const POLICY_PATH = join(EVALUATION_ROOT, "policy.yaml");
const TIER_ONE_CHECKS = "schema,pii,license,quality,unicode,lint";

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function renderProjectedSkill(skill: BundledSkill): string {
  const requiresTools = skill.requiresTools.join(",");
  return [
    "---",
    `name: ${yamlString(skill.name)}`,
    `description: ${yamlString(skill.description)}`,
    "license: MIT",
    "metadata:",
    `  nautilo-source: ${yamlString(skill.source)}`,
    `  nautilo-version: ${yamlString(String(skill.version))}`,
    `  nautilo-requires-tools: ${yamlString(requiresTools)}`,
    "---",
    skill.body,
  ].join("\n");
}

export async function projectOfficialSkills(options: {
  destinationRoot: string;
  repositoryRoot?: string;
  skills?: readonly BundledSkill[];
}): Promise<string> {
  const repositoryRoot = options.repositoryRoot ?? REPOSITORY_ROOT;
  const skills = options.skills ?? OFFICIAL_SKILLS;
  const skillsRoot = join(options.destinationRoot, "skills");

  await mkdir(skillsRoot, { recursive: true });
  await writeFile(
    join(options.destinationRoot, "LICENSE"),
    await readFile(join(repositoryRoot, "LICENSE")),
  );

  for (const skill of [...skills].sort((left, right) => left.name.localeCompare(right.name))) {
    const skillRoot = join(skillsRoot, skill.name);
    await mkdir(skillRoot, { recursive: true });
    await writeFile(join(skillRoot, "SKILL.md"), renderProjectedSkill(skill), "utf8");
  }

  return skillsRoot;
}

function assertSafeResultsRoot(resultsRoot: string): void {
  const resolved = resolve(resultsRoot);
  if (resolved === resolve(DEFAULT_RESULTS_ROOT)) return;
  throw new Error(`Refusing to replace unexpected results directory: ${resolved}`);
}

export async function evaluateOfficialSkills(): Promise<number> {
  const projectionRoot = await mkdtemp(join(tmpdir(), "nautilo-official-skills-"));
  const resultsRoot = DEFAULT_RESULTS_ROOT;

  try {
    assertSafeResultsRoot(resultsRoot);
    await rm(resultsRoot, { recursive: true, force: true });
    await mkdir(resultsRoot, { recursive: true });
    const skillsRoot = await projectOfficialSkills({ destinationRoot: projectionRoot });

    process.stdout.write(
      `[eval:official-skills] evaluator=799f9d61d3f22afaf6eb151f8a46236262ca797d skills=${OFFICIAL_SKILLS.length}\n`,
    );
    process.stdout.write(`[eval:official-skills] reports=${resultsRoot}\n`);

    const result = spawnSync(
      "uv",
      [
        "run",
        "--frozen",
        "--project",
        EVALUATION_ROOT,
        "skillevaluator",
        "validate",
        skillsRoot,
        "--checks",
        TIER_ONE_CHECKS,
        "--no-dedup",
        "--continue-on-failure",
        "--policy",
        POLICY_PATH,
        "--report",
        "json",
        "--output-dir",
        resultsRoot,
      ],
      { cwd: REPOSITORY_ROOT, stdio: "inherit" },
    );

    if (result.error) {
      process.stderr.write(`[eval:official-skills] failed to start uv: ${result.error.message}\n`);
      return 1;
    }
    return result.status ?? 1;
  } finally {
    await rm(projectionRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const status = await evaluateOfficialSkills();
  process.exit(status);
}
