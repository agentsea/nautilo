import { resolve } from "node:path";

import { CRYPTO_STORAGE_BYTE_LIMITS } from "@nautilo/db";
import {
  PROTECTED_MESSAGE_MAX_NAMESPACE_ENVELOPE_BYTES_V2,
} from "@nautilo/types";
import {
  findConfidentialMessageColumnReferences,
} from "../../src/node/confidential-message-access";
import { describe, expect, it } from "bun:test";

const repositoryRoot = resolve(import.meta.dir, "../../../..");

describe("Wave 9 confidential message direct-access closure", () => {
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
    expect(routingPredicates).toHaveLength(14);
    expect(routingPredicates.every((reference) =>
      reference.signature === "sql`(${sessionMessages.metadata}->>'originatedBy') IS DISTINCT FROM 'task' AND (${sessionMessages.metadata}->>'originatedBy') IS DISTINCT FROM 'connected_web_operation'`,"
      || reference.signature === "${sessionMessages.metadata}->>'originatedBy'"
      || reference.signature === "and (${sessionMessages.metadata}->>'originatedBy')"
    )).toBe(true);
    const addedRoutingPredicates = {
      // One SQL predicate reads the originatedBy discriminator twice to exclude
      // Task and Connected Website rows; neither occurrence projects metadata.
      "packages/agent/src/store/session-store.ts#metadata": 2,
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
