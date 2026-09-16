import { describe, expect, test } from "bun:test";
import {
  classifyDroppedTable,
  isUnhandledDataBearingDrift,
} from "../../src/lib/preflight";
import { RESTORE_MIGRATIONS } from "../../src/lib/restore-migrations";

describe("preflight intentional registered skips", () => {
  test("D425 server_maintenance is an explicit registered skip, not data loss", () => {
    const rule = RESTORE_MIGRATIONS.find(
      (entry) => entry.table === "public.server_maintenance",
    );
    const result = classifyDroppedTable(
      {
        table: "server_maintenance",
        columns: ["id", "enabled"],
        rowCount: 1,
      },
      rule,
    );

    expect(result.status).toBe("SKIP_INTENTIONAL");
    expect(result.note).toContain("Intentional registered skip");
    expect(result.note).toContain("server_maintenance");
    expect(isUnhandledDataBearingDrift(result)).toBe(false);
  });

  test("an unregistered dropped data table remains a blocking failure", () => {
    const result = classifyDroppedTable(
      {
        table: "unregistered_dropped_data",
        columns: ["id", "payload"],
        rowCount: 1,
      },
      undefined,
    );

    expect(result.status).toBe("SKIP_TABLE_MISSING");
    expect(isUnhandledDataBearingDrift(result)).toBe(true);
  });
});
