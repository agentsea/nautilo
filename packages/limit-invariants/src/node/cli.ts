#!/usr/bin/env bun

import { access, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
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
import { ensureLimitAuditDirectories, limitAuditPaths, readRequiredLimitAudit } from "./storage";

type Command = "inventory" | "report" | "check" | "scout" | "admit-legacy" | "shrink-legacy";

const packageRoot = resolve(import.meta.dir, "../..");
const defaultRepositoryRoot = resolve(packageRoot, "../..");
const paths = limitAuditPaths(packageRoot);

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
  return parseDecisions(await readRequiredLimitAudit(paths.decisions, "reviewed decision"));
}

async function readLegacy() {
  return parseLegacyDebt(await readRequiredLimitAudit(paths.legacy, "legacy debt"));
}

async function writeProjection(input: {
  readonly observations: Awaited<ReturnType<typeof scanRepositoryWithEvidence>>["observations"];
  readonly linksByLocator: Awaited<ReturnType<typeof scanRepositoryWithEvidence>>["linksByLocator"];
  readonly decisions: Awaited<ReturnType<typeof readDecisions>>;
  readonly legacy: readonly LegacyLimitDebt[];
  readonly writeInventory: boolean;
}): Promise<void> {
  await ensureLimitAuditDirectories(paths);
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

/** Run the strict semantic gate against the private local evidence for one exact source tree. */
export async function runLimitCheck(repositoryRoot: string): Promise<number> {
  const [{ observations }, decisions, legacy, committedInventory, legacyLock] = await Promise.all([
    scanRepositoryWithEvidence(resolve(repositoryRoot), { lanes: ["primary"] }),
    readDecisions(),
    readLegacy(),
    readRequiredLimitAudit(paths.inventory, "inventory").then(parseInventory),
    readRequiredLimitAudit(paths.legacyLock, "legacy lock").then(parseLegacyLock),
  ]);
  const result = checkRegistry({ current: observations, committedInventory, decisions, legacy, legacyLock });
  if (!result.ok) {
    process.stderr.write(`Limit invariant check failed (${result.errors.length} issue${result.errors.length === 1 ? "" : "s"}):\n`);
    for (const error of result.errors) process.stderr.write(`- ${error}\n`);
    return 1;
  }
  process.stdout.write(`Limit invariant check passed: observations=${result.observations} reviewed=${result.reviewed} legacy=${result.legacy}\n`);
  return 0;
}

async function run(): Promise<number> {
  const { command, repositoryRoot } = argumentsFor(process.argv.slice(2));
  if (command === "check") return runLimitCheck(repositoryRoot);
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
    await ensureLimitAuditDirectories(paths);
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

  throw new Error("Unhandled limit invariant command");
}

if (import.meta.main) {
  try {
    process.exit(await run());
  } catch (error) {
    process.stderr.write(`Limit invariant command failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
