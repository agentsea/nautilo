import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import {
  REVIEWED_PUBLIC_JOIN_AVAILABILITY_COVERAGE,
  REVIEWED_PUBLIC_JOIN_AVAILABILITY_DTO_DECLARATIONS,
} from "../../baseline/reviewed-public-join-availability";
import { validateCoverageEntry } from "../../src/model";
import {
  auditDtoDeclarations,
  discoverHttpDtoInventory,
} from "../../src/node/dto-inventory";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../../..");
const LOCATOR = "http:request_response:GET /api/public-join";

describe("public join availability encryption inventory review", () => {
  test("pins the exact boolean-only public response contract", async () => {
    const observations = (await discoverHttpDtoInventory(REPOSITORY_ROOT))
      .filter((entry) => entry.locator === LOCATOR);
    const declarations = DTO_BASELINE_DECLARATIONS
      .filter((entry) => entry.locator === LOCATOR);

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      id: "wire.http.request.response.get.api.public.join.1bfmmlm",
      structuralSignatures: ["response.body:{available:boolean}"],
      arbitraryPayloads: [],
    });
    expect(auditDtoDeclarations({ observations, declarations })).toEqual({
      ok: true,
      counts: { observations: 1, declarations: 1, arbitraryPayloads: 0 },
    });
    expect(declarations).toEqual([
      ...REVIEWED_PUBLIC_JOIN_AVAILABILITY_DTO_DECLARATIONS,
    ]);
  });

  test("classifies only ephemeral content-free availability metadata", () => {
    expect(REVIEWED_PUBLIC_JOIN_AVAILABILITY_COVERAGE).toHaveLength(1);
    const [entry] = REVIEWED_PUBLIC_JOIN_AVAILABILITY_COVERAGE;
    expect(entry && validateCoverageEntry(entry)).toEqual({ ok: true });
    expect(entry).toMatchObject({
      locator: LOCATOR,
      classification: "bounded_metadata",
      metadataAllowlist: ["available"],
    });
    if (!entry || entry.classification !== "bounded_metadata") {
      throw new Error("public join availability must remain bounded metadata");
    }
    expect(entry.plaintextReason).toMatch(/excludes the invite token/);
    expect(BASELINE_REGISTRY.entries.filter((item) => item.locator === LOCATOR))
      .toEqual([...REVIEWED_PUBLIC_JOIN_AVAILABILITY_COVERAGE]);
  });
});
