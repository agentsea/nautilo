import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEPENDENCY_PINS } from "../../../dependency-pins.ts";
import { buildAuthContract } from "../../../contracts/auth.ts";

describe("deployment security image baselines", () => {
  test("Compose and signed hosting inputs select the same immutable dependencies", () => {
    const external = JSON.parse(readFileSync(new URL("../../../releases/qualification/external-images-v1.json", import.meta.url), "utf8")) as {
      images: Record<"logto-postgres" | "app-postgres" | "logto", { reference: string }>;
    };
    expect(external.images["logto-postgres"].reference).toBe(DEPENDENCY_PINS.postgres);
    expect(external.images["app-postgres"].reference).toBe(DEPENDENCY_PINS.pgvectorPg17);
    expect(external.images.logto.reference).toBe(DEPENDENCY_PINS.logto);
    for (const reference of [DEPENDENCY_PINS.postgres, DEPENDENCY_PINS.pgvectorPg17, DEPENDENCY_PINS.logto]) {
      expect(reference).toMatch(/@sha256:[a-f0-9]{64}$/);
    }
  });

  test("the deployment contract uses its packaged application version", () => {
    const contract = buildAuthContract();
    const recipe = JSON.parse(readFileSync(new URL("../../../../packaging/logto/manifest.json", import.meta.url), "utf8")) as {
      nodeVersion: string;
      upstreamVersion: string;
    };
    expect(recipe.nodeVersion).toBe("22.23.4");
    expect(contract.logtoEngine.minimumVersion).toBe(DEPENDENCY_PINS.packagedLogtoImageTag);
    expect(contract.logtoEngine.image).toBe(DEPENDENCY_PINS.logto);
    expect(DEPENDENCY_PINS.logto).toStartWith("ghcr.io/agentsea/nautilo-logto-runtime@sha256:");
  });

  test("the PG16 maintenance stage matches the selected auth database image", () => {
    const dockerfile = readFileSync(new URL("../../../../packaging/docker/Dockerfile", import.meta.url), "utf8");
    expect(dockerfile).toContain(`FROM ${DEPENDENCY_PINS.postgres} AS pg16-client`);
  });
});
