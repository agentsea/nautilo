#!/usr/bin/env bun

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { LegacyLimitDebt } from "../model";
import {
  checkRegistry,
  legacyLockFor,
  parseDecisions,
  parseLegacyDebt,
  parseLegacyLock,
  parseInventory,
  renderInventory,
  renderInvestigationMap,
  renderLegacyDebt,
  renderLegacyLock,
  renderMatrix,
  renderScout,
} from "./registry";
import { scanRepositoryWithEvidence } from "./scanner";

type Command = "inventory" | "report" | "check" | "scout" | "admit-legacy" | "shrink-legacy";

const packageRoot = resolve(import.meta.dir, "../..");
const defaultRepositoryRoot = resolve(packageRoot, "../..");
const paths = {
  inventory: join(packageRoot, "baseline/limit-inventory.jsonl"),
  decisions: join(packageRoot, "baseline/reviewed-limit-decisions.jsonl"),
  legacy: join(packageRoot, "baseline/legacy-unreviewed.jsonl"),
  legacyLock: join(packageRoot, "baseline/legacy-lock.json"),
  matrix: join(packageRoot, "generated/limit-matrix.md"),
  scout: join(packageRoot, "generated/limit-scout.jsonl"),
  investigationMap: join(packageRoot, "generated/investigation-map.md"),
};

function usage(): never {
  process.stderr.write("Usage: bun src/node/cli.ts <inventory|report|check|scout|admit-legacy|shrink-legacy> [--root PATH]\n");
  process.exit(2);
}

function argumentsFor(argv: readonly string[]): { command: Command; repositoryRoot: string } {
  const command = argv[0];
  if (!["inventory", "report", "check", "scout", "admit-legacy", "shrink-legacy"].includes(command ?? "")) usage();
  const rootIndex = argv.indexOf("--root");
  const repositoryRoot = rootIndex >= 0 ? argv[rootIndex + 1] : defaultRepositoryRoot;
  if (!repositoryRoot) usage();
  return { command: command as Command, repositoryRoot: resolve(repositoryRoot) };
}

async function readDecisions() {
  return parseDecisions(await readFile(paths.decisions, "utf8"));
}

async function readLegacy() {
  return parseLegacyDebt(await readFile(paths.legacy, "utf8"));
}

async function writeProjection(input: {
  readonly observations: Awaited<ReturnType<typeof scanRepositoryWithEvidence>>["observations"];
  readonly linksByLocator: Awaited<ReturnType<typeof scanRepositoryWithEvidence>>["linksByLocator"];
  readonly decisions: Awaited<ReturnType<typeof readDecisions>>;
  readonly legacy: readonly LegacyLimitDebt[];
  readonly writeInventory: boolean;
}): Promise<void> {
  await mkdir(join(packageRoot, "baseline"), { recursive: true });
  await mkdir(join(packageRoot, "generated"), { recursive: true });
  if (input.writeInventory) await writeFile(paths.inventory, renderInventory(input.observations), "utf8");
  await writeFile(paths.investigationMap, renderInvestigationMap({
    observations: input.observations,
    decisions: input.decisions,
    legacy: input.legacy,
    linksByLocator: input.linksByLocator,
  }), "utf8");
  await writeFile(paths.matrix, renderMatrix({
    observations: input.observations,
    decisions: input.decisions,
    legacy: input.legacy,
  }), "utf8");
}

async function run(): Promise<number> {
  const { command, repositoryRoot } = argumentsFor(process.argv.slice(2));
  if (command === "admit-legacy") {
    try {
      await access(paths.legacyLock);
      throw new Error("Refusing to reinitialize frozen legacy debt. The legacy lock already exists and debt may only shrink.");
    } catch (error) {
      if (error instanceof Error && !error.message.includes("ENOENT")) throw error;
    }
  }
  const scan = await scanRepositoryWithEvidence(repositoryRoot, { lanes: command === "scout" ? ["scout"] : ["primary"] });
  const { observations, linksByLocator } = scan;
  if (command === "scout") {
    await mkdir(join(packageRoot, "generated"), { recursive: true });
    await writeFile(paths.scout, renderScout(scan), "utf8");
    process.stdout.write(`Wrote non-blocking wide scout: ${observations.length} mechanically grouped leads\n`);
    return 0;
  }
  const decisions = await readDecisions();

  if (command === "admit-legacy") {
    let existing: LegacyLimitDebt[] = [];
    try {
      existing = await readLegacy();
    } catch {
      existing = [];
    }
    if (existing.length > 0) {
      throw new Error("Refusing to replace existing legacy debt. Use shrink-legacy; new debt may not be admitted.");
    }
    const decided = new Set(decisions.map((decision) => `${decision.locator}\0${decision.fingerprint}`));
    const legacy = observations
      .filter((observation) => !decided.has(`${observation.locator}\0${observation.fingerprint}`))
      .map((observation): LegacyLimitDebt => ({
        locator: observation.locator,
        fingerprint: observation.fingerprint,
        owner: observation.owner,
        mechanicalPriority: observation.mechanicalPriority,
      }));
    await writeFile(paths.legacy, renderLegacyDebt(legacy), "utf8");
    await writeFile(paths.legacyLock, renderLegacyLock(legacyLockFor(legacy)), "utf8");
    await writeProjection({ observations, linksByLocator, decisions, legacy, writeInventory: true });
    process.stdout.write(`Admitted initial frozen legacy debt: observations=${observations.length} legacy=${legacy.length} reviewed=${decisions.length}\n`);
    return 0;
  }

  const legacy = await readLegacy();
  if (command === "shrink-legacy") {
    const current = new Map(observations.map((observation) => [observation.locator, observation]));
    const decided = new Set(decisions.map((decision) => `${decision.locator}\0${decision.fingerprint}`));
    const shrunk = legacy.filter((debt) => {
      const observation = current.get(debt.locator);
      return observation?.fingerprint === debt.fingerprint
        && !decided.has(`${debt.locator}\0${debt.fingerprint}`);
    });
    if (shrunk.length > legacy.length) throw new Error("Legacy debt growth is forbidden");
    await writeFile(paths.legacy, renderLegacyDebt(shrunk), "utf8");
    await writeFile(paths.legacyLock, renderLegacyLock(legacyLockFor(shrunk)), "utf8");
    await writeProjection({ observations, linksByLocator, decisions, legacy: shrunk, writeInventory: true });
    process.stdout.write(`Shrank frozen legacy debt: ${legacy.length} -> ${shrunk.length}\n`);
    return 0;
  }

  if (command === "inventory") {
    await writeProjection({ observations, linksByLocator, decisions, legacy, writeInventory: true });
    process.stdout.write(`Wrote deterministic inventory: ${observations.length} observations\n`);
    return 0;
  }
  if (command === "report") {
    await writeProjection({ observations, linksByLocator, decisions, legacy, writeInventory: false });
    process.stdout.write(`Wrote limit matrix: ${observations.length} observations\n`);
    return 0;
  }

  const [committedInventory, legacyLock, committedMatrix, committedInvestigationMap] = await Promise.all([
    readFile(paths.inventory, "utf8").then(parseInventory),
    readFile(paths.legacyLock, "utf8").then(parseLegacyLock),
    readFile(paths.matrix, "utf8"),
    readFile(paths.investigationMap, "utf8"),
  ]);
  const result = checkRegistry({ current: observations, committedInventory, decisions, legacy, legacyLock });
  const expectedMatrix = renderMatrix({ observations, decisions, legacy });
  const expectedInvestigationMap = renderInvestigationMap({ observations, decisions, legacy, linksByLocator });
  const errors = [...result.errors];
  if (committedMatrix !== expectedMatrix) errors.push("generated limit matrix is stale; run limits:report and review the diff");
  if (committedInvestigationMap !== expectedInvestigationMap) errors.push("generated investigation map is stale; run limits:report and review the diff");
  if (errors.length > 0) {
    process.stderr.write(`Limit invariant check failed (${errors.length} issue${errors.length === 1 ? "" : "s"}):\n`);
    for (const error of errors) process.stderr.write(`- ${error}\n`);
    return 1;
  }
  process.stdout.write(`Limit invariant check passed: observations=${result.observations} reviewed=${result.reviewed} legacy=${result.legacy}\n`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await run());
  } catch (error) {
    process.stderr.write(`Limit invariant command failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
