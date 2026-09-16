import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const devSourceRoot = join(repoRoot, "bin/nautilo-dev/src");

function source(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function walk(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
  });
}

describe("D489 lifecycle repository guards", () => {
  test("keeps one clone spine, one selector, and one bounded canonical seed store", () => {
    const productionFiles = walk(devSourceRoot).filter((path) => path.endsWith(".ts"));
    const declarations = (pattern: RegExp): string[] => productionFiles
      .filter((path) => pattern.test(readFileSync(path, "utf8")))
      .map((path) => relative(repoRoot, path));

    expect(declarations(/export async function materializeClone\s*\(/)).toEqual([
      "bin/nautilo-dev/src/commands/clone.ts",
    ]);
    expect(declarations(/export function selectCloneMaterialization\s*\(/)).toEqual([
      "bin/nautilo-dev/src/lib/clone-source-selection.ts",
    ]);

    const devStack = source("bin/nautilo-dev/src/commands/dev-stack.ts");
    expect(devStack).toContain("source: { kind: \"canonical-default\" }");
    expect(devStack).toContain("await materializeClone(");

    const seedStore = source("bin/nautilo-dev/src/lib/clone-seed-store.ts");
    expect(seedStore).toContain('return join(resolve(userHome), ".nautilo-clone-seeds")');
    expect(seedStore).toContain('currentPointer: join(absoluteRoot, "current.json")');
    expect(seedStore).toContain('previousPointer: join(absoluteRoot, "previous.json")');
    expect(seedStore).toContain('failureRecord: join(absoluteRoot, "last-failed.json")');
    expect(seedStore).toContain('artifactPolicy: "current-plus-one-previous-or-failed"');
  });

  test("keeps checkpoint deletion out of startup and behind the explicit maintenance command", () => {
    const productionFiles = walk(devSourceRoot).filter((path) => path.endsWith(".ts"));
    const deletionOwners = productionFiles
      .filter((path) => /DELETE\s+FROM\s+langchain\.(?:checkpoints|checkpoint_writes|checkpoint_blobs)/i
        .test(readFileSync(path, "utf8")))
      .map((path) => relative(repoRoot, path));
    expect(deletionOwners).toEqual([
      "bin/nautilo-dev/src/lib/checkpoint-semantic-compaction.ts",
    ]);

    const rootManifest = JSON.parse(source("package.json")) as { scripts: Record<string, string> };
    const index = source("bin/nautilo-dev/src/index.ts");
    expect(rootManifest.scripts["dev:compact-checkpoints"])
      .toBe("bun bin/nautilo-dev/src/index.ts compact-checkpoints");
    expect(index).toContain('case "compact-checkpoints"');
    for (const startupPath of [
      "bin/nautilo-dev/src/commands/dev-stack.ts",
      "bin/nautilo-dev/src/commands/infra-start.ts",
      "bin/nautilo-dev/src/commands/server-start.ts",
      "bin/nautilo-server/src/index.ts",
    ]) {
      const startup = source(startupPath);
      for (const maintenanceReference of [
        "compactCheckpointsCmd",
        "compact-checkpoints",
        "checkpoint-semantic-compaction",
        "checkpoint-physical-reclamation",
      ]) expect(startup).not.toContain(maintenanceReference);
      expect(startup).not.toMatch(/DELETE\s+FROM\s+langchain\.(?:checkpoints|checkpoint_writes|checkpoint_blobs)/i);
    }
  });

  test("keeps the final packaged macOS Local Network contract guarded", () => {
    const builder = source("apps/desktop/electron-builder.yml");
    const afterPack = source("apps/desktop/scripts/after-pack.cjs");
    const afterSign = source("apps/desktop/scripts/after-sign.cjs");
    const inspector = source("apps/desktop/scripts/inspect-macos-local-network-artifact.ts");
    const manifest = JSON.parse(source("apps/desktop/package.json")) as { scripts: Record<string, string> };

    expect(builder.match(/^ {6}- _nautilo\._tcp$/gm)).toEqual(["      - _nautilo._tcp"]);
    expect(builder).toContain("NSLocalNetworkUsageDescription:");
    expect(builder).toContain("afterSign: ./scripts/after-sign.cjs");
    expect(afterPack).toContain("assertMacLocalNetworkInfo(bundlePath)");
    expect(afterSign).toContain("inspect-macos-local-network-artifact.ts");
    expect(inspector).toContain('EXPECTED_BUNDLE_ID = "com.nautilo.desktop"');
    expect(inspector).toContain('EXPECTED_BONJOUR_SERVICES = ["_nautilo._tcp"]');
    expect(manifest.scripts["inspect:mac:local-network"]).toBe("bun scripts/inspect-macos-local-network-artifact.ts");
  });

  test("allowlists every disposable parent launcher and enforces exact cleanup evidence", () => {
    const integrationRoot = join(repoRoot, "bin/nautilo-dev/tests/integration");
    const discovered = walk(integrationRoot)
      .filter((path) => path.endsWith(".ts"))
      .filter((path) => {
        const body = readFileSync(path, "utf8");
        return /(?:Bun\.spawn\(|spawn\("bun")/.test(body) &&
          /NAUTILO_D489_(?:LIVE_CHILD|PARENT_OWNS_CLEANUP)/.test(body);
      })
      .map((path) => relative(repoRoot, path))
      .sort();
    expect(discovered).toEqual([
      "bin/nautilo-dev/tests/integration/d489-checkpoint-maintenance-acceptance-runner.ts",
      "bin/nautilo-dev/tests/integration/d489-default-clone-acceptance.test.ts",
    ]);

    const clone = source(discovered[1]!);
    expect(clone.indexOf("writeJournal({")).toBeLessThan(clone.indexOf('const child = spawn("bun"'));
    expect(clone).toMatch(/finally\s*{[\s\S]*emergencyCleanup\(journalPath\)/);
    for (const marker of [
      "containers:", "images:", "volumes:", "networks:", "buildCache:",
      "pidFiles:", "roots:", "credentials:", "beforeOwnedBytes: 0",
      "peakOwnedBytes:", "afterOwnedBytes:", "afterFilesystemBytes:",
      "requiredImageIds", "NAUTILO_DISPOSABLE_NO_PULL_BUILD",
    ]) expect(clone).toContain(marker);
    expect(clone).toContain("expect(byteEvidence.afterOwnedBytes).toBe(0)");
    expect(clone).toContain("expect(byteEvidence.afterFilesystemBytes).toBe(0)");

    const checkpointRunner = source(discovered[0]!);
    const checkpointWorker = source("bin/nautilo-dev/tests/integration/d489-checkpoint-maintenance-acceptance.test.ts");
    const checkpointJournal = source("bin/nautilo-dev/tests/integration/helpers/d489-disposable-resource-journal.ts");
    expect(checkpointWorker.indexOf("createD489ResourceJournal(runId)"))
      .toBeLessThan(checkpointWorker.indexOf('"run", "-d", "--pull=never"'));
    expect(checkpointRunner).toMatch(/finally\s*{[\s\S]*parentFinally\(\)/);
    for (const marker of [
      "resources: D489OwnedResources", "container:", "volume:", "network:",
      "reuse-only-never-remove", "processes:", "filesRoot:",
      "beforeOwnedDockerBytes: 0", "peakOwnedDockerBytes:", "afterOwnedDockerBytes:",
      "afterOwnedFilesystemBytes", "objectExists(kind, name)", "${kind}-residue",
      "process-residue", "files-residue", "never pulls or builds",
    ]) expect(checkpointJournal).toContain(marker);
    expect(checkpointJournal).toContain("journal.measurements.afterOwnedDockerBytes !== 0");
    expect(checkpointJournal).toContain("journal.measurements.afterOwnedFilesystemBytes !== 0");
  });
});
