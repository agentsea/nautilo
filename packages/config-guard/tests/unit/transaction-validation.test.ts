import { describe, expect, test } from "bun:test";
import { transaction } from "../../src/transaction";

describe("transaction() input validation", () => {
  test("rejects missing actor", () => {
    return expect(
      transaction({
        operations: [],
        healthCheck: "none",
        reason: "test",
      } as unknown),
    ).rejects.toMatchObject({ code: "VALIDATION", name: "ConfigGuardError" });
  });

  test("rejects invalid healthCheck", () => {
    return expect(
      transaction({
        operations: [],
        healthCheck: "all",
        reason: "test",
        actor: "test",
      } as unknown),
    ).rejects.toMatchObject({ code: "VALIDATION", name: "ConfigGuardError" });
  });

  test("rejects non-array operations", () => {
    return expect(
      transaction({
        operations: {},
        healthCheck: "none",
        reason: "test",
        actor: "test",
      } as unknown),
    ).rejects.toMatchObject({ code: "VALIDATION", name: "ConfigGuardError" });
  });
});
