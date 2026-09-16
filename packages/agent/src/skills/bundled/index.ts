import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./parse-frontmatter";

export interface BundledSkill {
  id: string;
  name: string;
  description: string;
  body: string;
  requiresTools: string[];
  source: "official";
  version: number;
}

function parseInlineArray(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new Error(`Expected inline array for requiresTools, got: ${value}`);
  }
  const inner = trimmed.slice(1, -1);
  if (inner.trim() === "") return [];
  return inner
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function loadBundledSkill(filename: string): BundledSkill {
  const raw = readFileSync(join(import.meta.dir, filename), "utf8");
  const { frontmatter, body } = parseFrontmatter(raw);

  const name = frontmatter.name;
  const source = frontmatter.source;
  if (source !== "official") {
    throw new Error(
      `Bundled skill ${filename} has source=${source}; only "official" is supported`,
    );
  }

  const version = Number(frontmatter.version);
  if (!Number.isFinite(version)) {
    throw new Error(`Bundled skill ${filename} has invalid version: ${frontmatter.version}`);
  }

  return {
    id: `official:${name}`,
    name,
    description: frontmatter.description,
    body,
    requiresTools: parseInlineArray(frontmatter.requiresTools),
    source: "official",
    version,
  };
}

const BUNDLED_SKILL_FILES = readdirSync(import.meta.dir).filter((f) => f.endsWith(".md"));

export const OFFICIAL_SKILLS: readonly BundledSkill[] = BUNDLED_SKILL_FILES.map((filename) =>
  loadBundledSkill(filename),
);

const skillsByName = new Map(OFFICIAL_SKILLS.map((skill) => [skill.name, skill]));

export function getBundledSkill(name: string): BundledSkill | undefined {
  return skillsByName.get(name);
}
