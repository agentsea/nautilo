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
    "binds the public signer certificate variant to its exact Memory and message-backfill contracts",
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

      expect(REVIEWED_TASK_RUNTIME_SIGNER_DTO_LOCATORS).toHaveLength(9);
      expect(locators.size).toBe(9);
      expect(declarations).toHaveLength(9);
      expect(observations).toHaveLength(9);
      const messageBackfillDeclaration = declarations.find((declaration) =>
        declaration.locator ===
          "http:request_response:POST /api/message-backfill/source"
      );
      expect(messageBackfillDeclaration).toBeDefined();
      expect((messageBackfillDeclaration?.structuralSignatures ?? []).reduce(
        (count, signature) =>
          count + signature.split('kind:"task_runtime"').length - 1,
        0,
      )).toBe(4);
      expect((messageBackfillDeclaration?.structuralSignatures ?? []).reduce(
        (count, signature) =>
          count + signature.split(
            '{evidenceBytesBase64url:string;kind:"task_runtime_signer_certificate"}',
          ).length - 1,
        0,
      )).toBe(2);
      expect(auditDtoDeclarations({ observations, declarations })).toEqual({
        ok: true,
        counts: { observations: 9, declarations: 9, arbitraryPayloads: 0 },
      });
    },
  );
});
