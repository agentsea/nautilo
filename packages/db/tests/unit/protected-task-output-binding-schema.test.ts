import { describe, expect, test } from "bun:test";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";

import {
  protectedTaskRunMessageOperationId,
  protectedTaskRunOutputBindingId,
  protectedTaskRunResultObjectId,
  protectedTaskRunResultOperationId,
  protectedTaskRunWakeJobId,
  protectedTaskRunWakeOperationId,
} from "../../src/queries/protected-task-output-bindings";
import { protectedTaskRunOutputBindings } from
  "../../src/schema/protected-task-run-output-bindings";
import { SENSITIVE_TABLES } from "../../src/utils/agent-role-grants";

const TASK_ID = "10000000-0000-4000-8000-000000000001";
const RUN_ID = "20000000-0000-4000-8000-000000000002";

const dialect = new PgDialect();

function checks(): string {
  return getTableConfig(protectedTaskRunOutputBindings).checks
    .map((check) => dialect.sqlToQuery(check.value).sql.replaceAll('"', ""))
    .join("\n");
}

describe("protected TaskRun output binding identities", () => {
  test("derives every accepted operation from the exact TaskRun", () => {
    expect(protectedTaskRunOutputBindingId(RUN_ID))
      .toBe(`task-run-output:${RUN_ID}`);
    expect(protectedTaskRunResultOperationId(RUN_ID))
      .toBe(`task-run-result:${RUN_ID}`);
    expect(protectedTaskRunMessageOperationId(RUN_ID))
      .toBe(`task-run-delivery-message:${RUN_ID}`);
    expect(protectedTaskRunWakeOperationId(RUN_ID))
      .toBe(`task-run-delivery-wake:${RUN_ID}`);
    expect(protectedTaskRunResultObjectId(TASK_ID, RUN_ID)).toBe(
      "task-run-result:v1:c3d2c1c68222360a4404fe37119db6e3e7fcf973c1f1ccf2c4a894683c83705e",
    );
    expect(protectedTaskRunWakeJobId(RUN_ID)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(protectedTaskRunWakeJobId(RUN_ID)).toBe(
      protectedTaskRunWakeJobId(RUN_ID),
    );
  });

  test("keeps destination and completion facts content-free and coherent", () => {
    const config = getTableConfig(protectedTaskRunOutputBindings);
    expect(config.columns.map((column) => column.name)).toEqual([
      "task_run_id",
      "binding_id",
      "delivery_mode",
      "destination_room_id",
      "destination_namespace_id",
      "result_operation_id",
      "result_object_id",
      "message_operation_id",
      "wake_operation_id",
      "accepted_policy_revision",
      "accepted_at",
      "result_terminal_at",
      "result_attached_at",
      "message_id",
      "message_published_at",
      "wake_job_id",
      "wake_scheduled_at",
      "completed_at",
    ]);
    const sql = checks();
    expect(sql).toContain("delivery_mode");
    expect(sql).toContain("raw_and_wake");
    expect(sql).toContain("result_attached_at");
    expect(sql).toContain("message_published_at");
    expect(sql).toContain("wake_scheduled_at");
    expect(SENSITIVE_TABLES).toContain("protected_task_run_output_bindings");
  });
});
