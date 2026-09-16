import { describe, expect, test } from "bun:test";
import type {
  CryptoPostgresExecutor,
} from "../../src/server/index.ts";
import {
  allHumansHaveOperationCapacity,
  humanHasOperationCapacity,
} from "../../src/server/delivery/postgres-human-operation-capacity.ts";

class CapacityExecutor implements CryptoPostgresExecutor {
  readonly queries: Array<{
    readonly statement: string;
    readonly parameters: readonly unknown[];
  }> = [];

  constructor(
    private readonly outstandingByHuman: ReadonlyMap<string, number>,
  ) {}

  query<Row>(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    this.queries.push({ statement, parameters });
    if (statement.includes("pg_advisory_xact_lock")) {
      return Promise.resolve([]);
    }
    const count = this.outstandingByHuman.get(String(parameters[0])) ?? 0;
    return Promise.resolve(
      Array.from(
        { length: count },
        (_, index) => ({ operation_id: `operation_${index}` }),
      ) as Row[],
    );
  }
}

describe("Postgres Human operation capacity", () => {
  test("counts device and membership work under one serialized ceiling", async () => {
    const executor = new CapacityExecutor(new Map([
      ["human_available", 7],
      ["human_full", 8],
    ]));

    expect(
      await humanHasOperationCapacity(executor, "human_available"),
    ).toBe(true);
    expect(await humanHasOperationCapacity(executor, "human_full")).toBe(
      false,
    );
    const capacitySql = executor.queries
      .filter(({ statement }) =>
        statement.includes("crypto_delivery_operations operation")
      )
      .map(({ statement }) => statement)
      .join("\n");
    expect(capacitySql).toContain("operation.human_id = $1");
    expect(capacitySql).toContain(
      "$1 = ANY(membership.old_participants)",
    );
    expect(capacitySql).toContain(
      "$1 = ANY(membership.new_participants)",
    );
    expect(capacitySql).toContain(
      "state NOT IN ('active', 'failed', 'cancelled')",
    );
  });

  test("locks a membership participant set once in canonical order", async () => {
    const executor = new CapacityExecutor(new Map());
    expect(await allHumansHaveOperationCapacity(executor, [
      "human_b",
      "human_a",
      "human_b",
    ])).toBe(true);
    expect(
      executor.queries
        .filter(({ statement }) =>
          statement.includes("pg_advisory_xact_lock")
        )
        .map(({ parameters }) => parameters[0]),
    ).toEqual([
      "crypto-human-operation-capacity/human_a",
      "crypto-human-operation-capacity/human_b",
    ]);
  });
});
