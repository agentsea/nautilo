import { describe, expect, test } from "bun:test";
import type { ReflectionSemanticReconciliationBindingV2 } from
  "@nautilo/lattice-crypto/background";
import type { ClaimedProtectedRecordPublication } from
  "@nautilo/reflection-bridge/server";
import type { PostgresJsBridgeConnection } from "@nautilo/db";

import { attachReflectionSemanticRecovery } from
  "../../src/reflection/attach-semantic-recovery";

const binding: ReflectionSemanticReconciliationBindingV2 = {
  kind: "semantic",
  publicationId: "semantic-publication",
  recordRef: "generated-record",
  sourceRecordRef: "source-record",
  claimGeneration: 7,
  representationGeneration: 1,
  attachmentPlanHash: new Uint8Array(32).fill(1),
  objectId: "saved-object",
  objectType: "nautilo.reflection.record.v1",
  createdAt: 1_700_000_000_000,
  payloadHash: new Uint8Array(32).fill(2),
  namespaceEnvelopes: [{
    namespaceId: "namespace-one",
    envelopeHash: new Uint8Array(32).fill(3),
  }],
};
const item: ClaimedProtectedRecordPublication = {
  idempotencyKey: "publication-receipt",
  recordId: binding.recordRef,
  state: "reserved",
  leaseToken: "publication-lease",
  reservedCryptoObjectId: binding.objectId,
  replay: {
    publicationBindingRef: "journal:namespace:namespace-one:protected:v1",
    requestCommitment: new Uint8Array(32).fill(4),
    structuralHeight: 1,
    processingGeneration: 1,
  },
};

describe("Reflection semantic saved-output attachment", () => {
  test("rejects a stale or forged source claim before commit authorization", async () => {
    let authorized = 0;
    const product = {
      async query(statement: string) {
        if (statement.includes("current_user AS current_role")) {
          return [{ current_role: "nautilo", session_role: "nautilo" }];
        }
        if (statement.includes('from "reflection_record_semantic_work"')) {
          return [{
            generation: binding.claimGeneration + 1,
            completed_generation: binding.claimGeneration,
            state: "pending",
          }];
        }
        throw new Error(`Unexpected query: ${statement}`);
      },
    } as Pick<PostgresJsBridgeConnection, "query">;

    const failure = await attachReflectionSemanticRecovery({
      held: {
        executor: { query: async () => [] },
        product,
        issuerSigningPublicKey: new Uint8Array(32),
      },
      item,
      binding,
      plaintext: new Uint8Array([1, 2, 3]),
      commitmentKey: new Uint8Array(32).fill(5),
      authorizeCommit: async () => {
        authorized += 1;
        return Date.now();
      },
      signal: new AbortController().signal,
    }).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    if (failure instanceof Error) {
      expect(failure.message).toContain("source generation is no longer current");
    }
    expect(authorized).toBe(0);
  });
});
