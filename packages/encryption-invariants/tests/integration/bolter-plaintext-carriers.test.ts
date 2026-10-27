import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BASELINE_REGISTRY, WAVE_0_FROZEN_BASELINE_DEBT } from "../../baseline/existing-debt";
import { BOLTER_PLAINTEXT_COVERAGE, BOLTER_PLAINTEXT_SOURCE_ALARMS,
  BOLTER_PLAINTEXT_SOURCE_DECLARATIONS } from "../../baseline/reviewed-bolter-plaintext-carriers";
import { validateCoverageEntry } from "../../src/model";
import { auditCoverageRegistry, compareInventory } from "../../src/registry";
import { CURRENT_SOURCE_ALARM_REVIEWS, inspectSourceAlarmReviews } from "../../src/node/source-alarm-review";
import { inspectDeclaredSourceInventory, scanSourceAlarms, SOURCE_DECLARATIONS } from "../../src/node/source-inventory";
import { collectRepositoryInventory, repositoryVerificationCategories } from "../../src/node/repository-inventory";

const root = resolve(import.meta.dir, "../../../..");
const paths = BOLTER_PLAINTEXT_SOURCE_DECLARATIONS.map(item => item.evidence[0]!.path);
const currentDeclarations = SOURCE_DECLARATIONS.filter((item) =>
  BOLTER_PLAINTEXT_SOURCE_DECLARATIONS.some((historical) => historical.id === item.id)
);

describe("exact authorized Bolter plaintext carriers", () => {
  test("verifies executable carrier and admission evidence without adding frozen debt", async () => {
    expect(BOLTER_PLAINTEXT_COVERAGE).toHaveLength(8);
    expect(WAVE_0_FROZEN_BASELINE_DEBT).toHaveLength(1590);
    const debtBefore = JSON.stringify(BASELINE_REGISTRY.debt);
    const inspection = await inspectDeclaredSourceInventory({ repoRoot: root, declarations: currentDeclarations });
    expect(inspection.errors).toEqual([]);
    expect(inspection.observations).toHaveLength(8);
    const registry = { ...BASELINE_REGISTRY, entries: BOLTER_PLAINTEXT_COVERAGE };
    expect(auditCoverageRegistry(registry).ok).toBe(true);
    expect(compareInventory({ observed: inspection.observations, registry: { entries: BOLTER_PLAINTEXT_COVERAGE, debt: [], exceptions: [] }, frozenBaselineDebt: [] })).toEqual({ unknown: [], stale: [], unfrozenDebt: [] });
    for (const entry of BOLTER_PLAINTEXT_COVERAGE) {
      expect(validateCoverageEntry(entry)).toEqual({ ok: true });
      expect(BASELINE_REGISTRY.entries).toContainEqual(entry);
      expect(SOURCE_DECLARATIONS.some(item => item.id === entry.id && item.locator === entry.locator)).toBe(true);
      expect(entry.classification).toBe("authorized_plaintext");
      expect(entry.mode).toBe("plaintext_only");
      expect(entry.releaseImpact).toBe("blocks_whole_product_claim");
      for (const path of entry.noRetentionTestEvidence) expect((await readFile(resolve(root, path), "utf8")).length).toBeGreaterThan(0);
    }
    // Classifying one exact carrier cannot declare an unreviewed second sink.
    const unreviewed = { id: "source.fixture.unreviewed", surface: "processor" as const, locator: "packages/fixture/src/new.ts#newSink" };
    expect(compareInventory({ observed: [unreviewed], registry: { entries: BOLTER_PLAINTEXT_COVERAGE, debt: [], exceptions: [] }, frozenBaselineDebt: [] }).unknown).toEqual([`processor:${unreviewed.locator}`]);
    expect(JSON.stringify(BASELINE_REGISTRY.debt)).toBe(debtBefore);
  });

  test("closes exact spawn and fixed diagnostics while inventorying undetected IPC carriers", async () => {
    const scan = await scanSourceAlarms({ repoRoot: root, scanRoots: paths });
    expect(scan.errors).toEqual([]);
    expect(scan.alarms).toHaveLength(6);
    const currentPathReviews = CURRENT_SOURCE_ALARM_REVIEWS.filter((review) =>
      paths.includes(review.locator.split("#")[0]!)
    );
    expect(inspectSourceAlarmReviews(scan.alarms, currentPathReviews).errors).toEqual([]);
    for (const review of BOLTER_PLAINTEXT_SOURCE_ALARMS) expect(CURRENT_SOURCE_ALARM_REVIEWS).toContainEqual(review);
    expect(BOLTER_PLAINTEXT_SOURCE_ALARMS.every(review => review.closure !== "baseline_debt")).toBe(true);
    const changed = scan.alarms.map(alarm => ({ ...alarm, locator: alarm.locator.replace(":1", ":2") }));
    expect(inspectSourceAlarmReviews(changed, BOLTER_PLAINTEXT_SOURCE_ALARMS).errors.some(error => error.startsWith("new source alarm has no closure:"))).toBe(true);
  });

  test("retention scope excludes archives, logs, zeroization and remote erasure claims", async () => {
    for (const path of paths.filter((path) =>
      path !== "apps/desktop/electron/bolter-bridge/connection-owner.ts"
    )) {
      const source = await readFile(resolve(root, path), "utf8");
      expect(source).not.toMatch(/\b(?:writeFile|appendFile|createWriteStream|logger|console)\s*[.(]/u);
    }
    const providerEventDiagnostic = CURRENT_SOURCE_ALARM_REVIEWS.find((review) =>
      review.locator === "apps/desktop/electron/bolter-bridge/connection-owner.ts#log_emitter:d9fe2303095b762b:1"
    );
    expect(providerEventDiagnostic?.closure).toBe("baseline_debt");
    expect(providerEventDiagnostic && "evidenceGap" in providerEventDiagnostic
      ? providerEventDiagnostic.evidenceGap : "").toContain("provider event kind");
    const handover = await readFile(resolve(root, "apps/desktop/electron/bolter-bridge/handover.ts"), "utf8");
    expect(handover).toContain("socket.write(Buffer.concat"); // This is real plaintext wire content.
    expect(handover.indexOf("await store(jsonl)")).toBeLessThan(handover.indexOf("socket.end(\"committed\\n\")"));
    const spool = await readFile(resolve(root, "apps/desktop/electron/bolter-bridge/inbox-spool.ts"), "utf8");
    expect(spool).toContain("this.options.cipher.seal(plaintext)");
    expect(spool).toContain("file.writeFile(ciphertext)");
    expect(BASELINE_REGISTRY.entries.find(entry => entry.id === "file.desktop-bolter-inbox")?.classification).toBe("device_local");
    const publication = BOLTER_PLAINTEXT_COVERAGE.find(entry => entry.id === "source.bolter.publication")!;
    expect(publication.cleanupContract).toContain("Trusted injected ports can retain references");
    expect(publication.cleanupContract).toContain("heap zeroization or remote erasure is not claimed");
  });

  test("repository verification rejects nonexistent no-retention proof", async () => {
    const inventory = await collectRepositoryInventory(root);
    const entry = BOLTER_PLAINTEXT_COVERAGE[0]!;
    const missing = "packages/encryption-invariants/tests/unit/nonexistent-no-retention-fixture.test.ts";
    const registry = { ...BASELINE_REGISTRY, entries: [{ ...entry, noRetentionTestEvidence: [missing] }] };
    const errors = repositoryVerificationCategories(inventory, registry).find(category => category.category === "repository_evidence")!.errors;
    expect(errors.filter(error => error.startsWith(`${entry.id}:`))).toEqual([`${entry.id}: missing no-retention test evidence path ${missing}`]);
  }, 120_000);
});
