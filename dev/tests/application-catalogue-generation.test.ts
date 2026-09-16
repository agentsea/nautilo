import { expect, test } from "bun:test";
import {
  APPLICATION_CATALOGUE_MANIFEST_V1,
} from "../../apps/workbench/src/lib/application-catalogue-manifest";
import {
  applicationCatalogueMetadataFromManifest,
  assertGeneratedApplicationCatalogueIsCurrent,
  renderApplicationCatalogueV1,
} from "../scripts/generate-application-catalogue";

test("the checked-in application catalogue is deterministic and current", async () => {
  expect(applicationCatalogueMetadataFromManifest()).toHaveLength(53);
  await expect(assertGeneratedApplicationCatalogueIsCurrent()).resolves.toBeUndefined();
  expect(renderApplicationCatalogueV1()).toBe(renderApplicationCatalogueV1());
});

test("the generator rejects duplicate or malformed support IDs", () => {
  expect(() => applicationCatalogueMetadataFromManifest([
    ...APPLICATION_CATALOGUE_MANIFEST_V1,
    APPLICATION_CATALOGUE_MANIFEST_V1[0],
  ])).toThrow("duplicate");
  expect(() => applicationCatalogueMetadataFromManifest([{ ...APPLICATION_CATALOGUE_MANIFEST_V1[0], target: "BAD target" }])).toThrow("invalid");
});
