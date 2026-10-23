import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import {
  REVIEWED_MESSAGE_MODEL_INPUT_EXPOSURE_DTO_LOCATORS,
} from "../../baseline/reviewed-message-model-input-exposure-dto";
import {
  auditDtoDeclarations,
  discoverDtoInventory,
} from "../../src/node/dto-inventory";

const repositoryRoot = resolve(import.meta.dir, "../../../..");
const NAMED_LOCATORS = [
  "http:accepted_arbitrary:packages/types/src/api.ts#RoomMessageDto",
  "http:accepted_arbitrary:packages/types/src/api.ts#RoomMessagesAroundPage",
] as const;

describe("Message model-input exposure DTO inventory", () => {
  test("binds protected Message metadata to its shared closed codec", async () => {
    const locators = new Set<string>([
      ...REVIEWED_MESSAGE_MODEL_INPUT_EXPOSURE_DTO_LOCATORS,
      ...NAMED_LOCATORS,
    ]);
    const declarations = DTO_BASELINE_DECLARATIONS.filter((declaration) =>
      locators.has(declaration.locator)
    );
    const observations = (await discoverDtoInventory(repositoryRoot)).filter(
      (observation) => locators.has(observation.locator),
    );

    expect(declarations).toHaveLength(5);
    expect(observations).toHaveLength(5);
    expect(
      declarations.flatMap((declaration) => declaration.arbitraryPayloads),
    ).toEqual([
      {
        path: "response.body.shadowEncryption",
        schema: "ProtectedMessageDtoV2",
      },
      {
        path: "modelInputExposure",
        schema: "parseModelInputExposureMetadataV1",
      },
      {
        path: "messages[].modelInputExposure",
        schema: "parseModelInputExposureMetadataV1",
      },
    ]);
    expect(auditDtoDeclarations({ observations, declarations })).toEqual({
      ok: true,
      counts: { observations: 5, declarations: 5, arbitraryPayloads: 3 },
    });
  }, 60_000);
});
