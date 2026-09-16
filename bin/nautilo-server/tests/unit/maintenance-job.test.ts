import { describe, expect, test } from "bun:test";
import { parseMaintenanceJobArgs } from "../../src/maintenance-job";

describe("maintenance job argv", () => {
  test("accepts only direction and two opaque identifiers", () => {
    expect(parseMaintenanceJobArgs(["bun", "maintenance-job.ts", "export", "op-1", "object_2"])).toEqual({ direction: "export", operationId: "op-1", objectId: "object_2" });
    expect(parseMaintenanceJobArgs(["bun", "maintenance-job.ts", "migrate", "schema-v2", "execution-2"])).toEqual({
      direction: "migrate", migrationId: "schema-v2", executionId: "execution-2",
    });
  });

  test("rejects extra args, traversal, and secrets with exit-2 class input failures", () => {
    for (const args of [
      ["bun", "job", "export", "op", "object", "extra"],
      ["bun", "job", "restore", "..", "object"],
      ["bun", "job", "export", "op", "postgres://secret@host/db"],
      ["bun", "job", "migrate", "schema", "execution", "secret"],
      ["bun", "job", "migrate", ".", "execution"],
      ["bun", "job", "migrate", "..", "execution"],
      ["bun", "job", "migrate", "schema:unsafe", "execution"],
      ["bun", "job", "migrate", "schema", `e${"a".repeat(128)}`],
    ]) expect(() => parseMaintenanceJobArgs(args)).toThrow("invalid maintenance job arguments");
  });

  test("accepts the exact 128-byte identifier boundary", () => {
    const identifier = `i${"a".repeat(127)}`;
    expect(parseMaintenanceJobArgs(["bun", "job", "migrate", identifier, identifier])).toEqual({
      direction: "migrate", migrationId: identifier, executionId: identifier,
    });
  });
});
