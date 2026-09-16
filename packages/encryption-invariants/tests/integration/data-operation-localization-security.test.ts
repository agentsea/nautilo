import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { findDataOperationLocalizationViolations } from
  "../../src/node/data-operation-localization";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");

describe("M321 policy-hiding data-operation localization repository boundary", () => {
  test("migrated product consumers do not choose encryption representations", async () => {
    expect(await findDataOperationLocalizationViolations(repositoryRoot)).toEqual([]);
  });
});
