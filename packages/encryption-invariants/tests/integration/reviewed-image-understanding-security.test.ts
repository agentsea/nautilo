import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  BASELINE_REGISTRY,
  CURRENT_FROZEN_BASELINE_DEBT,
} from "../../baseline/existing-debt";
import {
  IMAGE_UNDERSTANDING_CONFIGURATION_LOCATOR,
  REVIEWED_IMAGE_UNDERSTANDING_COVERAGE,
  REVIEWED_IMAGE_UNDERSTANDING_DEBT_LINKS,
} from "../../baseline/reviewed-image-understanding-coverage";
import { validateCoverageEntry } from "../../src/model";
import { auditCoverageRegistry } from "../../src/registry";

const repoRoot = resolve(import.meta.dir, "../../../..");

async function source(path: string): Promise<string> {
  return Bun.file(resolve(repoRoot, path)).text();
}

describe("image understanding encryption review", () => {
  test("classifies only the nullable server model identifier", () => {
    expect(auditCoverageRegistry(BASELINE_REGISTRY)).toMatchObject({ ok: true });
    expect(REVIEWED_IMAGE_UNDERSTANDING_COVERAGE).toHaveLength(1);
    const [entry] = REVIEWED_IMAGE_UNDERSTANDING_COVERAGE;
    expect(entry?.locator).toBe(IMAGE_UNDERSTANDING_CONFIGURATION_LOCATOR);
    expect(entry && validateCoverageEntry(entry)).toEqual({ ok: true });
    expect(entry?.classification).toBe("bounded_metadata");
    if (entry?.classification !== "bounded_metadata") throw new Error("unexpected coverage class");
    expect(entry.metadataAllowlist).toEqual(["image_understanding_model"]);
    expect(BASELINE_REGISTRY.entries).toContainEqual(entry);
    expect(CURRENT_FROZEN_BASELINE_DEBT.some((debt) =>
      debt.locator === IMAGE_UNDERSTANDING_CONFIGURATION_LOCATOR
    )).toBe(false);
  });

  test("keeps strict admission and raw admin input on their frozen carriers", () => {
    expect(REVIEWED_IMAGE_UNDERSTANDING_DEBT_LINKS).toHaveLength(1);
    expect(REVIEWED_IMAGE_UNDERSTANDING_DEBT_LINKS.map((link) =>
      [link.locator, link.targetDebtIds]
    )).toEqual([
      [
        "http:request_response:POST /api/admin/server-models#request.body",
        ["debt.wire.http.request.response.post.api.admin.server.models.1nyrg5s"],
      ],
    ]);
    for (const link of REVIEWED_IMAGE_UNDERSTANDING_DEBT_LINKS) {
      expect(BASELINE_REGISTRY.reviewedDebtLinks).toContainEqual(link);
      for (const target of link.targetDebtIds) {
        expect(CURRENT_FROZEN_BASELINE_DEBT.some((debt) => debt.id === target)).toBe(true);
      }
    }
    expect(CURRENT_FROZEN_BASELINE_DEBT.some((debt) =>
      debt.id === "debt.db.public.jobs.metadata"
    )).toBe(true);
    expect(BASELINE_REGISTRY.entries.some((entry) =>
      entry.locator === "public.jobs.metadata"
    )).toBe(false);
    expect(BASELINE_REGISTRY.reviewedDebtLinks?.some((link) =>
      link.locator === "public.jobs.metadata"
    )).toBe(false);
  });

  test("persists a purpose-separated HMAC receipt and rejects content-shaped extensions", async () => {
    const commitment = await source(
      "packages/server/src/lib/image-assistance-input-commitment.ts",
    );
    expect(commitment).toContain('"nautilo/image-assistance/input-commitment/v1"');
    expect(commitment).toContain("createHmac(\"sha256\"");
    expect(commitment).toContain("PUSH_TOKEN_ENCRYPTION_KEY");
    expect(commitment).toContain("[IMAGE_ASSISTANCE_INPUT_DOMAIN, jobId, inputDigest]");

    const admission = await source("packages/types/src/image-assistance-admission.ts");
    expect(admission).toContain('"inputCommitment"');
    expect(admission).toContain("/^hmac-sha256:[0-9a-f]{64}$/");
    expect(admission).toContain("hasExactKeys(value, ADMISSION_KEYS)");
    expect(admission).not.toContain('"inputDigest"');
    for (const forbidden of ["question", "observations", "imageBase64", "apiKey", "secretKey"]) {
      expect(admission).not.toContain(`"${forbidden}"`);
    }

    const queries = await source("packages/db/src/queries/image-assistance-admission.ts");
    expect(queries).toContain('const METADATA_KEY = "imageAssistanceAdmission"');
    expect(queries).toContain("parseImageAssistanceAdmission(value)");
    expect(queries).not.toContain('"inputDigest"');
  });

  test("keeps the administrator projection to model configuration metadata", async () => {
    const schema = await source("packages/db/src/schema/server-model-config.ts");
    expect(schema).toContain(
      'imageUnderstandingModel: text("image_understanding_model")',
    );
    expect(schema).not.toContain(
      'imageUnderstandingModel: text("image_understanding_model").notNull()',
    );

    const route = await source("packages/server/src/routes/server-models.ts");
    expect(route).toContain('if ("imageUnderstandingModel" in raw)');
    expect(route).toContain("imageUnderstandingModel must be a string or null");
    expect(route).toContain("isSignedImageUnderstandingModel(id)");

    const client = await source("packages/api-client/src/client.ts");
    expect(client).toContain(
      "imageUnderstandingModel: z.string().nullable().optional().default(null)",
    );
    expect(client).toContain("imageUnderstandingModels: z.array(z.object({");
  });
});
