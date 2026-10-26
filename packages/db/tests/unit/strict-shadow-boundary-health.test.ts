import { describe, expect, test } from "bun:test";

import {
  compileOfflineDirectQuery,
  createOfflineDirectDb,
} from "../../src/config/direct-database";
import { retireLegacyUnsupportedTaskObserverHealth } from
  "../../src/utils/strict-shadow-boundary-health";

describe("Strict Shadow boundary health", () => {
  test("retires only the exact legacy Task observer signal in one policy epoch", async () => {
    const offline = createOfflineDirectDb();
    const compiledQueries: ReturnType<typeof compileOfflineDirectQuery>[] = [];
    const database = {
      delete(table: Parameters<typeof offline.delete>[0]) {
        const query = offline.delete(table);
        return {
          where(predicate: Parameters<typeof query.where>[0]) {
            compiledQueries.push(compileOfflineDirectQuery(query.where(predicate)));
            return Promise.resolve();
          },
        };
      },
    };

    await retireLegacyUnsupportedTaskObserverHealth(database as never, 17);

    const [compiled] = compiledQueries;
    expect(compiled).toBeDefined();
    expect(compiled?.sql).toContain('delete from "encryption_transition_boundary_health"');
    expect(compiled?.sql).toContain('"policy_revision" = $1');
    expect(compiled?.sql).toContain('"boundary_id" = $2');
    expect(compiled?.sql).toContain('"family" = $3');
    expect(compiled?.sql).toContain('"operation" = $4');
    expect(compiled?.sql).toContain('"actor_class" = $5');
    expect(compiled?.sql).toContain('"state" = $6');
    expect(compiled?.sql).toContain('"reason" = $7');
    expect(compiled?.params).toEqual([
      17,
      "background.task.observer",
      "task",
      "process",
      "background",
      "unsupported",
      "unsupported_operation",
    ]);
  });

  test("rejects an invalid policy epoch before issuing a delete", async () => {
    let deleted = false;
    const database = { delete() { deleted = true; throw new Error("unexpected"); } };
    await Promise.resolve(expect(
      retireLegacyUnsupportedTaskObserverHealth(database as never, 0),
    ).rejects.toThrow("policy revision must be positive"));
    expect(deleted).toBeFalse();
  });
});
