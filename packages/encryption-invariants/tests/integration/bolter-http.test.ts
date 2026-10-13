import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { BOLTER_HTTP_COVERAGE, BOLTER_HTTP_DECLARATIONS } from "../../baseline/reviewed-bolter-http";
import { BASELINE_REGISTRY, WAVE_0_FROZEN_BASELINE_DEBT } from "../../baseline/existing-debt";
import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { auditDtoDeclarations, discoverHttpDtoInventory } from "../../src/node/dto-inventory";
import { validateCoverageEntry } from "../../src/model";

test("pins closed Bolter HTTP contracts without authorizing protected content or new frozen debt", async () => {
  const observations = (await discoverHttpDtoInventory(resolve(import.meta.dir, "../../../..")))
    .filter(item => item.locator.includes("/api/bolter/"));
  expect(observations).toHaveLength(14);
  expect(auditDtoDeclarations({ observations, declarations: BOLTER_HTTP_DECLARATIONS })).toEqual({ok: true,
    counts: { observations: 14, declarations: 14, arbitraryPayloads: 0 }});
  expect(WAVE_0_FROZEN_BASELINE_DEBT).toHaveLength(1590);
  for (const declaration of BOLTER_HTTP_DECLARATIONS) expect(DTO_BASELINE_DECLARATIONS).toContainEqual(declaration);
  for (const entry of BOLTER_HTTP_COVERAGE) {
    expect(validateCoverageEntry(entry)).toEqual({ok:true});
    expect(BASELINE_REGISTRY.entries).toContainEqual(entry);
    expect(entry.mode).toBe("plaintext_only");
    expect(entry.releaseImpact).toBe("blocks_whole_product_claim");
  }
}, 120_000);
