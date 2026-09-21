import { describe, expect, test } from "bun:test";
import { isSupportedModelCatalogWorkload } from "../../src/config/model-catalog/supported-providers";
import { isSupportedChoiceProvider } from "../../src/providers/choice-provider-support";
import { resolveChoiceDriver } from "../../src/providers/choice-driver";

describe("Choice driver resolution", () => {
  test("uses one shared support decision for catalog admission and invocation", () => {
    expect(isSupportedChoiceProvider("OPENROUTER")).toBe(true);
    expect(isSupportedModelCatalogWorkload("OPENROUTER", "decision")).toBe(true);
    expect(resolveChoiceDriver("OPENROUTER")).not.toBeNull();

    expect(isSupportedChoiceProvider("venice")).toBe(true);
    expect(isSupportedModelCatalogWorkload("venice", "decision")).toBe(true);
    expect(resolveChoiceDriver("venice")).not.toBeNull();
    expect(resolveChoiceDriver("typesafe")).not.toBeNull();
    expect(isSupportedModelCatalogWorkload("typesafe", "decision")).toBe(true);
    expect(isSupportedModelCatalogWorkload("typesafe", "chat")).toBe(false);
    expect(isSupportedModelCatalogWorkload("typesafe", "generation")).toBe(false);
    expect(resolveChoiceDriver("unknown")).toBeNull();
  });

  test("does not restrict supported chat transports", () => {
    expect(isSupportedModelCatalogWorkload("venice", "chat")).toBe(true);
  });
});
