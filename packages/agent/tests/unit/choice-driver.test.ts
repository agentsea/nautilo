import { describe, expect, test } from "bun:test";
import { isSupportedModelCatalogWorkload } from "../../src/config/model-catalog/supported-providers";
import { isSupportedChoiceProvider } from "../../src/providers/choice-provider-support";
import { resolveChoiceDriver } from "../../src/providers/choice-driver";

describe("Choice driver resolution", () => {
  test("uses one shared support decision for catalog admission and invocation", () => {
    expect(isSupportedChoiceProvider("OPENROUTER")).toBe(true);
    expect(isSupportedModelCatalogWorkload("OPENROUTER", "decision")).toBe(true);
    expect(resolveChoiceDriver("OPENROUTER")).not.toBeNull();

    expect(isSupportedChoiceProvider("venice")).toBe(false);
    expect(isSupportedModelCatalogWorkload("venice", "decision")).toBe(false);
    expect(resolveChoiceDriver("venice")).toBeNull();
  });

  test("does not restrict supported chat transports", () => {
    expect(isSupportedModelCatalogWorkload("venice", "chat")).toBe(true);
  });
});
