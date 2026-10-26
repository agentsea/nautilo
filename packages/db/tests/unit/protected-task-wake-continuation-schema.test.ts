import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import { protectedTaskWakeContinuationReceipts } from
  "../../src/schema/protected-task-wake-continuation-receipts";

describe("protected Task wake continuation receipt schema", () => {
  test("binds immutable product, authorization, capsule, destination, and checkpoint facts", () => {
    const config = getTableConfig(protectedTaskWakeContinuationReceipts);
    const columns = config.columns.map(column => column.name);
    const expectedColumns = [
      "wake_job_id", "segment", "task_id", "task_run_id", "binding_id",
      "wake_operation_id", "prior_recipient_generation",
      "wake_authorization_request_id", "additional_authorization_request_id",
      "interrupt_id", "operation_id",
      "request_digest", "required_authority_digest",
      "semantic_authority_requirements", "retained_source_namespace_ids",
      "source_envelope_digest", "initial_policy_revision",
      "initial_agent_authorization_revision", "destination_room_id",
      "destination_namespace_id", "destination_authority_digest",
      "checkpoint_thread_id", "checkpoint_contract",
      "expected_checkpoint_count", "checkpoint_ordered_digest",
      "expected_blob_count", "blob_ordered_digest",
      "expected_pending_write_count", "pending_write_ordered_digest",
      "sealed_at",
    ];
    for (const column of expectedColumns) expect(columns).toContain(column);
    expect(config.primaryKeys).toHaveLength(1);
    const uniqueNames = config.uniqueConstraints.map(value => value.name);
    expect(uniqueNames).toContain(
      "uq_protected_task_wake_continuation_authorization_generation",
    );
    expect(uniqueNames).toContain(
      "uq_protected_task_wake_continuation_interrupt",
    );
    const foreignKeyNames = config.foreignKeys.map(value => value.getName());
    expect(foreignKeyNames).toContain(
      "protected_task_wake_continuation_binding_fk",
    );
    expect(foreignKeyNames).toContain(
      "protected_task_wake_continuation_destination_fk",
    );
  });

  test("admits product read/insert only; mutation immutability remains migration-owned", () => {
    const config = getTableConfig(protectedTaskWakeContinuationReceipts);
    expect(config.policies.map(policy => `${policy.for}`)).toEqual([
      "select",
      "insert",
    ]);
  });
});
