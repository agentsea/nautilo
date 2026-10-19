import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import {
  REVIEWED_TASK_RUNTIME_SIGNER_DTO_LOCATORS,
} from "../../baseline/reviewed-task-runtime-signer-dto";
import {
  auditDtoDeclarations,
  discoverDtoInventory,
} from "../../src/node/dto-inventory";

const repositoryRoot = join(import.meta.dir, "../../../..");

describe("Task runtime signer DTO inventory", () => {
  test(
    "binds the public signer certificate variant to its exact Memory contracts",
    async () => {
      const locators = new Set<string>(
        REVIEWED_TASK_RUNTIME_SIGNER_DTO_LOCATORS,
      );
      const declarations = DTO_BASELINE_DECLARATIONS.filter((declaration) =>
        locators.has(declaration.locator)
      );
      const observations = (await discoverDtoInventory(repositoryRoot)).filter(
        (observation) => locators.has(observation.locator),
      );

      expect(REVIEWED_TASK_RUNTIME_SIGNER_DTO_LOCATORS).toHaveLength(8);
      expect(locators.size).toBe(8);
      expect(declarations).toHaveLength(8);
      expect(observations).toHaveLength(8);
      expect(auditDtoDeclarations({ observations, declarations })).toEqual({
        ok: true,
        counts: { observations: 8, declarations: 8, arbitraryPayloads: 0 },
      });
    },
  );
});
