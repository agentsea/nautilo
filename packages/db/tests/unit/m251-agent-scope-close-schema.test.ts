import { describe, expect, test } from "bun:test";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  AGENT_SCOPE_CLOSE_MAX_ITEMS,
  agentScopeCloseItems,
  agentScopeCloseOperations,
  agentScopes,
} from "../../src/schema";

describe("Wave 15 protected AgentScope close schema", () => {
  test("adds only open/closing lifecycle coordinates to AgentScope", () => {
    const columns = getTableColumns(agentScopes);
    for (const column of [
      "lifecycleState",
      "revision",
      "closeOperationId",
    ]) expect(Object.keys(columns)).toContain(column);
    expect(columns.lifecycleState?.enumValues).toEqual(["open", "closing"]);
    expect(getTableConfig(agentScopes).checks.map((check) => check.name))
      .toContainAllValues([
        "agent_scopes_lifecycle_state_check",
        "agent_scopes_revision_nonnegative",
        "agent_scopes_close_operation_portable",
        "agent_scopes_close_lifecycle_coherent",
      ]);
  });

  test("keeps one bounded content-free close receipt", () => {
    const columns = getTableColumns(agentScopeCloseOperations);
    for (const column of [
      "operationId",
      "scopeId",
      "parentAgentId",
      "speakerUserId",
      "sourceScopeRevision",
      "capturedItemCount",
      "inventoryDigest",
      "state",
      "failureCode",
      "terminalAt",
    ]) expect(Object.keys(columns)).toContain(column);
    expect(columns.state?.enumValues).toEqual([
      "active",
      "complete",
      "quarantined",
    ]);
    for (const forbidden of [
      "plaintext",
      "content",
      "embedding",
      "key",
      "grant",
      "signedBytes",
    ]) expect(Reflect.has(columns, forbidden)).toBeFalse();
    expect(AGENT_SCOPE_CLOSE_MAX_ITEMS).toBe(256);
  });

  test("captures exact per-Memory coordinates with bounded claims", () => {
    const columns = getTableColumns(agentScopeCloseItems);
    for (const column of [
      "operationId",
      "ordinal",
      "memoryId",
      "origin",
      "cryptoObjectId",
      "expectedContentRevision",
      "expectedAccessRevision",
      "expectedRequiredNamespaceFingerprint",
      "sourceOriginNamespaceId",
      "action",
      "targetNamespaceId",
      "state",
      "attemptCount",
      "nextAttemptAt",
      "claimToken",
      "claimOwner",
      "claimExpiresAt",
      "failureCode",
      "productReceiptRef",
      "cryptoReceiptRef",
      "terminalAt",
    ]) expect(Object.keys(columns)).toContain(column);
    expect(columns.state?.enumValues).toEqual([
      "pending",
      "claimed",
      "complete",
      "stale",
      "quarantined",
    ]);
    const checks = getTableConfig(agentScopeCloseItems).checks.map(
      (check) => check.name,
    );
    for (const check of [
        "agent_scope_close_items_ordinal_bounded",
        "agent_scope_close_items_action_coherent",
        "agent_scope_close_items_attempt_bound",
        "agent_scope_close_items_lifecycle_coherent",
    ]) expect(checks).toContain(check);
  });
});
