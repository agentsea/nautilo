import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./parse-frontmatter";

export interface BundledCommand {
  id: string;
  name: string;
  description: string;
  body: string;
  source: "official";
  version: number;
}

function loadBundledCommand(filename: string): BundledCommand {
  const raw = readFileSync(join(import.meta.dir, filename), "utf8");
  const { frontmatter, body } = parseFrontmatter(raw);

  const name = frontmatter.name;
  const source = frontmatter.source;
  if (source !== "official") {
    throw new Error(
      `Bundled command ${filename} has source=${source}; only "official" is supported`,
    );
  }

  const version = Number(frontmatter.version);
  if (!Number.isFinite(version)) {
    throw new Error(`Bundled command ${filename} has invalid version: ${frontmatter.version}`);
  }

  return {
    id: `official:${name}`,
    name,
    description: frontmatter.description,
    body,
    source: "official",
    version,
  };
}

const BUNDLED_COMMAND_FILES = readdirSync(import.meta.dir).filter((f) => f.endsWith(".md"));

export const OFFICIAL_COMMANDS: readonly BundledCommand[] = BUNDLED_COMMAND_FILES.map((filename) =>
  loadBundledCommand(filename),
);

const commandsByName = new Map(OFFICIAL_COMMANDS.map((cmd) => [cmd.name, cmd]));

export function getBundledCommand(name: string): BundledCommand | undefined {
  return commandsByName.get(name);
}
