import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { WAVE_0_FROZEN_BASELINE_DEBT } from "../../baseline/existing-debt";

import { CRYPTO_STORAGE_BYTE_LIMITS } from "@nautilo/db";
import {
  PROTECTED_MESSAGE_MAX_NAMESPACE_ENVELOPE_BYTES_V2,
} from "@nautilo/types";
import {
  findConfidentialMessageColumnReferences,
} from "../../src/node/confidential-message-access";
import { describe, expect, it } from "bun:test";

const repositoryRoot = resolve(import.meta.dir, "../../../..");
// These exact slice reads remain on the canonical plaintext Message boundary.
// Neither whole metadata nor authored reply text becomes bounded metadata.
const EXTERNAL_MESSAGE_READS = [
  {
    path: "packages/db/src/queries/bolter-bridge.ts", field: "metadata",
    signature: "role: sessionMessages.role, humanTurnId: sessionMessages.humanTurnId, metadata: sessionMessages.metadata,",
  },
  {
    path: "packages/db/src/queries/bolter-bridge.ts", field: "content",
    signature: "const [message] = await tx.select({ content: sessionMessages.content, fingerprint: sessionMessages.fingerprint })",
  },
  {
    path: "packages/db/src/queries/bolter-bridge.ts", field: "toolCalls",
    signature: "isNull(sessionMessages.toolCalls), isNull(sessionMessages.toolName),",
  },
  {
    path: "packages/db/src/queries/bolter-bridge.ts", field: "metadata",
    signature: "sql`${sessionMessages.metadata}->'externalFinalReply' = ${JSON.stringify({",
  },
  {
    path: "packages/trust/src/notification-classification.ts", field: "metadata",
    signature: "return sql`NOT (COALESCE(${sessionMessages.metadata}, '{}'::jsonb)",
  },
] as const;

function isExternalMessageRead(reference: { path: string; field: string; signature: string }): boolean {
  return EXTERNAL_MESSAGE_READS.some((reviewed) => reviewed.path === reference.path
    && reviewed.field === reference.field && reviewed.signature === reference.signature);
}

type ReviewedReferenceHandoff = Readonly<{
  path: string;
  field: "content" | "toolCalls" | "metadata";
  signature: string;
  /** Total exact occurrences in current source. */
  occurrences: number;
  /** Later reviewed occurrences removed from the frozen Wave 9 budget. */
  consume?: number;
}>;

const REVIEWED_LATER_REFERENCE_HANDOFFS = [
  // Human-visible history added two authenticated presentation sidecars. The
  // other two identical projections remain in the original Wave 9 budget.
  { path: "packages/agent/src/store/session-store.ts", field: "metadata", signature: "metadata: sessionMessages.metadata,", occurrences: 4, consume: 2 },
  // This SQL only decides whether an assistant row is a skip-only control row;
  // it does not select or return the serialized tool calls.
  { path: "packages/agent/src/store/session-store.ts", field: "toolCalls", signature: "WHEN pg_input_is_valid(${sessionMessages.toolCalls}, 'jsonb') THEN CASE", occurrences: 1 },
  { path: "packages/agent/src/store/session-store.ts", field: "toolCalls", signature: "WHEN ${sessionMessages.toolCalls} IS JSON ARRAY THEN NOT (", occurrences: 1 },
  { path: "packages/agent/src/store/session-store.ts", field: "toolCalls", signature: "jsonb_array_length((${sessionMessages.toolCalls})::jsonb) > 0", occurrences: 1 },
  { path: "packages/agent/src/store/session-store.ts", field: "toolCalls", signature: "FROM jsonb_array_elements((${sessionMessages.toolCalls})::jsonb) AS transcript_call(value)", occurrences: 1 },
  // The ordinary history reader's metadata projection and browser-control
  // predicates remain behind the same protected foreground-history proxy.
  { path: "packages/runtime/src/conductor/history-search.ts", field: "metadata", signature: "metadata: sessionMessages.metadata,", occurrences: 1 },
  { path: "packages/runtime/src/conductor/history-search.ts", field: "metadata", signature: "sql`(${sessionMessages.metadata}->>'nautilo_browser_decision_observation') IS DISTINCT FROM 'true'`,", occurrences: 1 },
  { path: "packages/runtime/src/conductor/history-search.ts", field: "metadata", signature: "sql`NOT (${sessionMessages.toolName} IN ('browser_snapshot', 'browser_screenshot') AND COALESCE(${sessionMessages.metadata}->'nautilo_tool_result'->>'toolCallId', '') LIKE 'browser-choice:%' AND ${sessionMessages.metadata}->'nautilo_tool_result'->>'toolStatus' = 'success')`,", occurrences: 2 },
  // Task delivery coverage uses only SQL presence/null predicates.
  { path: "packages/db/src/queries/task-run-message-associations.ts", field: "content", signature: "isNull(sessionMessages.content),", occurrences: 1 },
  { path: "packages/db/src/queries/task-run-message-associations.ts", field: "toolCalls", signature: "isNull(sessionMessages.toolCalls),", occurrences: 1 },
  { path: "packages/db/src/queries/task-run-message-associations.ts", field: "metadata", signature: "isNull(sessionMessages.metadata),", occurrences: 1 },
  { path: "packages/server/src/routes/protected-task-output-read-product.ts", field: "content", signature: "contentIsNull: isNull(sessionMessages.content).mapWith(Boolean),", occurrences: 1 },
  { path: "packages/server/src/routes/protected-task-output-read-product.ts", field: "toolCalls", signature: "toolCallsIsNull: isNull(sessionMessages.toolCalls).mapWith(Boolean),", occurrences: 1 },
  { path: "packages/server/src/routes/protected-task-terminal-message-product.ts", field: "content", signature: "isNull(sessionMessages.content), isNull(sessionMessages.toolCalls), isNull(sessionMessages.toolName),", occurrences: 1 },
  { path: "packages/server/src/routes/protected-task-terminal-message-product.ts", field: "toolCalls", signature: "isNull(sessionMessages.content), isNull(sessionMessages.toolCalls), isNull(sessionMessages.toolName),", occurrences: 1 },
  // These two exact readers run only under current protected Task authority.
  // The allocation reader authenticates the Shadow sibling by payload digest;
  // the reply reader re-proves the accepted decrypt grant before and after.
  { path: "packages/server/src/routes/protected-task-message-allocation.ts", field: "content", signature: "role: sessionMessages.role, content: sessionMessages.content,", occurrences: 1 },
  { path: "packages/server/src/routes/protected-task-message-allocation.ts", field: "toolCalls", signature: "toolCalls: sessionMessages.toolCalls, toolName: sessionMessages.toolName,", occurrences: 1 },
  { path: "packages/server/src/routes/protected-task-message-allocation.ts", field: "metadata", signature: "metadata: sessionMessages.metadata,", occurrences: 1 },
  { path: "packages/server/src/routes/protected-task-native-reply-authority.ts", field: "content", signature: "content: sessionMessages.content,", occurrences: 1 },
  { path: "packages/server/src/routes/protected-task-native-reply-authority.ts", field: "toolCalls", signature: "toolCalls: sessionMessages.toolCalls,", occurrences: 1 },
  { path: "packages/server/src/routes/protected-task-native-reply-authority.ts", field: "metadata", signature: "metadata: sessionMessages.metadata,", occurrences: 1 },
] as const satisfies readonly ReviewedReferenceHandoff[];

const REVIEWED_HANDOFF_EVIDENCE = [
  ["packages/agent/tests/integration/room-messages-cross-session.integration.test.ts", 'contentRepresentation: "structural"'],
  ["packages/runtime/src/context/foreground-history.ts", "protectLiveShadowForegroundHistory("],
  ["packages/db/tests/unit/task-run-message-associations.test.ts", 'toContain("session_messages.content is null")'],
  ["packages/server/tests/unit/protected-task-run-result-message-allocation.test.ts", "Shadow rejects arbitrary ordinary content"],
  ["packages/server/tests/unit/protected-task-native-reply-authority.test.ts", "expect(taskChecks).toBe(2)"],
  ["packages/server/tests/unit/protected-task-output-read-product.test.ts", "proof rejects a changed invocation, transaction, or current digest"],
  ["packages/server/src/routes/protected-task-terminal-message-product.ts", "The guard cannot escape the exact canonical authority-held transaction"],
] as const;

describe("Wave 9 confidential message direct-access closure", () => {
  it("pins exact external Message reads without expanding the original confidential budget", async () => {
    const references = await findConfidentialMessageColumnReferences(repositoryRoot);
    expect(references.filter(isExternalMessageRead).map(({ path, field, signature }) => ({ path, field, signature })))
      .toEqual([...EXTERNAL_MESSAGE_READS]);
    expect(references.filter((reference) => reference.path === "packages/db/src/queries/bolter-bridge.ts"))
      .toHaveLength(4);
    for (const column of ["content", "metadata", "tool_calls"]) {
      expect(WAVE_0_FROZEN_BASELINE_DEBT.some((debt) =>
        debt.id === `debt.db.public.session_messages.${column}`
        && debt.locator === `public.session_messages.${column}`
        && debt.releaseImpact === "blocks_whole_product_claim",
      )).toBe(true);
    }
  });
  it("keeps the browser namespace-envelope limit equal to durable storage", () => {
    expect(PROTECTED_MESSAGE_MAX_NAMESPACE_ENVELOPE_BYTES_V2).toBe(
      CRYPTO_STORAGE_BYTE_LIMITS.objectAccessEnvelope,
    );
  });

  it("locks the exact pre-repository confidential Drizzle access budget", async () => {
    const references = await findConfidentialMessageColumnReferences(
      repositoryRoot,
    );
    const counts = new Map<string, number>();
    for (const reference of references) {
      if (isExternalMessageRead(reference)) continue;
      const key = `${reference.path}#${reference.field}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    // Main added only originatedBy SQL predicates excluding Connected Website
    // supervision from Human activity. Pin those exact predicate occurrences
    // separately: they read one routing discriminator, not additional content
    // or metadata projections. The original confidential-access budget below
    // remains unchanged.
    const routingPredicates = references.filter((reference) =>
      reference.field === "metadata" && reference.signature.includes("->>'originatedBy'")
    );
    expect(routingPredicates).toHaveLength(15);
    expect(routingPredicates.every((reference) =>
      reference.signature === "sql`(${sessionMessages.metadata}->>'originatedBy') IS DISTINCT FROM 'task' AND (${sessionMessages.metadata}->>'originatedBy') IS DISTINCT FROM 'connected_web_operation'`,"
      || reference.signature === "sql`(${sessionMessages.metadata}->>'originatedBy') IS DISTINCT FROM 'task' AND (${sessionMessages.metadata}->>'originatedBy') IS DISTINCT FROM 'connected_web_operation' AND (${sessionMessages.metadata}->>'originatedBy') IS DISTINCT FROM 'scheduled_task_internal'`,"
      || reference.signature === "${sessionMessages.metadata}->>'originatedBy'"
      || reference.signature === "and (${sessionMessages.metadata}->>'originatedBy')"
    )).toBe(true);
    const addedRoutingPredicates = {
      // One SQL predicate reads the originatedBy discriminator twice to exclude
      // Task and Connected Website rows; neither occurrence projects metadata.
      "packages/agent/src/store/session-store.ts#metadata": 3,
      "packages/server/src/lib/subthread-root-affinity.ts#metadata": 1,
      // Full peer finalization selects only the SQL `content IS NULL`
      // predicate result; it never projects or materializes the body.
      "packages/server/src/messaging/peer-broadcast.ts#content": 1,
      "packages/trust/src/canonical-transcript-mutations.ts#metadata": 1,
      "packages/trust/src/notification-classification.ts#metadata": 3,
      "packages/trust/src/queries.ts#metadata": 1,
    };
    for (const [key, count] of Object.entries(addedRoutingPredicates)) {
      const remaining = (counts.get(key) ?? 0) - count;
      if (remaining === 0) counts.delete(key);
      else counts.set(key, remaining);
    }
    for (const handoff of REVIEWED_LATER_REFERENCE_HANDOFFS) {
      const exact = references.filter((reference) =>
        reference.path === handoff.path
        && reference.field === handoff.field
        && reference.signature === handoff.signature
      );
      expect(exact).toHaveLength(handoff.occurrences);
      const key = `${handoff.path}#${handoff.field}`;
      const remaining = (counts.get(key) ?? 0)
        - ("consume" in handoff ? handoff.consume : handoff.occurrences);
      if (remaining === 0) counts.delete(key);
      else counts.set(key, remaining);
    }
    for (const [path, anchor] of REVIEWED_HANDOFF_EVIDENCE) {
      expect(readFileSync(resolve(repositoryRoot, path), "utf8")).toContain(anchor);
    }
    expect(Object.fromEntries([...counts].sort())).toEqual({
      "packages/agent/src/store/session-store.ts#content": 5,
      "packages/agent/src/store/session-store.ts#metadata": 3,
      "packages/agent/src/store/session-store.ts#toolCalls": 5,
      "packages/db/src/queries/legacy-photo-history.ts#content": 2,
      "packages/db/src/queries/reflection-sources.ts#content": 1,
      "packages/runtime/src/conductor/history-search.ts#content": 1,
      "packages/server/src/lib/content-reports.ts#content": 1,
      "packages/server/src/lib/subthread-root-affinity.ts#content": 1,
      "packages/server/src/lib/subthread-root-affinity.ts#metadata": 1,
      "packages/trust/src/canonical-transcript-mutations.ts#content": 2,
      "packages/trust/src/canonical-transcript-mutations.ts#metadata": 2,
      "packages/trust/src/message-edit.ts#content": 1,
      "packages/trust/src/message-edit.ts#metadata": 1,
      "packages/trust/src/notification-classification.ts#content": 1,
      "packages/trust/src/notification-classification.ts#metadata": 4,
      "packages/trust/src/queries.ts#content": 2,
      "packages/trust/src/queries.ts#metadata": 1,
      "packages/trust/src/queries.ts#toolCalls": 1,
    });
  });

  it("detects a new direct confidential access with stable source evidence", async () => {
    const references = await findConfidentialMessageColumnReferences(
      repositoryRoot,
      {
        "packages/example/src/leak.ts": [
          "const safe = sessionMessages.id;",
          "const leaked = sessionMessages.content;",
          "const more = sessionMessages.metadata;",
        ].join("\n"),
      },
    );

    expect(references).toEqual([
      {
        field: "content",
        line: 2,
        path: "packages/example/src/leak.ts",
        signature: "const leaked = sessionMessages.content;",
      },
      {
        field: "metadata",
        line: 3,
        path: "packages/example/src/leak.ts",
        signature: "const more = sessionMessages.metadata;",
      },
    ]);
  });
});
