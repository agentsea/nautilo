import { expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DirectDatabase } from "../../src/config/direct-database";
import { findTimedOutRunningTasks, getTaskById, getTaskByIdWithMutationVersion, listAwaitingWriterReviewTasks,
  listPendingWriterReviewVerificationTasks, listRunningWriterReviewVerificationTasks } from "../../src/queries/tasks";
import { tasks } from "../../src/schema/tasks";

function capture() {
  let selection: unknown;
  let condition: Parameters<PgDialect["sqlToQuery"]>[0] | undefined;
  const query = {
    from: (_table: unknown) => query,
    innerJoin: (_table: unknown, _on: unknown) => query,
    where: (value: Parameters<PgDialect["sqlToQuery"]>[0]) => { condition = value; return query; },
    orderBy: (..._order: unknown[]) => query,
    limit: (_limit: number) => query,
    then: <Value>(resolve: (value: never[]) => Value | PromiseLike<Value>) => Promise.resolve([]).then(resolve),
  };
  const db = { select: (value: unknown) => { selection = value; return query; } } as unknown as DirectDatabase;
  return { db, read: () => ({ selection, query: new PgDialect().sqlToQuery(condition!) }) };
}

test.each([listAwaitingWriterReviewTasks, listPendingWriterReviewVerificationTasks,
  listRunningWriterReviewVerificationTasks])("Writer restart discovery excludes protected content before materialization (%#)", async read => {
  const fixture = capture();
  expect(await read(fixture.db, { limit: 1 })).toEqual([]);
  const query = fixture.read().query;
  expect(query.sql).toContain('"tasks"."content_representation" =');
  expect(query.sql).toContain('"task_runs"."result_representation" =');
  expect(query.params.filter(value => value === "ordinary")).toHaveLength(2);
});

test("time-limit watchdog selects only Task identity and representation", async () => {
  const fixture = capture();
  expect(await findTimedOutRunningTasks(fixture.db, new Date("2026-10-13T00:00:00.000Z"))).toEqual([]);
  expect(fixture.read().selection).toEqual({ task: { id: tasks.id, contentRepresentation: tasks.contentRepresentation } });
  expect(fixture.read().query.sql).toContain('"task_runs"."job_id" is not null');
  expect(fixture.read().query.params).toContain("running");
});

test.each([getTaskById, getTaskByIdWithMutationVersion])("ordinary Task lookup fences the row while default lookup is unchanged (%#)", async lookup => {
  const ordinary = capture();
  await lookup(ordinary.db, "task-id", { ordinaryOnly: true });
  expect(ordinary.read().query.sql).toContain('"tasks"."content_representation" =');
  expect(ordinary.read().query.params).toEqual(["task-id", "ordinary"]);
  const legacy = capture();
  await lookup(legacy.db, "task-id");
  expect(legacy.read().query.params).toEqual(["task-id"]);
  expect(legacy.read().query.sql).not.toContain("content_representation");
});
