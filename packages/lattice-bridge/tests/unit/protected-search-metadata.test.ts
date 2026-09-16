import { describe, expect, test } from "bun:test";
import type { PostgresJsBridgeConnection } from "@nautilo/db";
import type { DurableSleepClaim } from "@nautilo/reflection/durable";

import { PostgresProtectedReflectionSearchMetadata } from
  "../../src/server/reflection/protected-search-metadata";

const claim: DurableSleepClaim = {
  recordRef: "record:one",
  logicalObjectRef: "record:one",
  generation: 2,
  changeReason: "created",
  stage: "search_projection",
  leaseToken: "lease:one",
};
const provenance = {
  provider: "openai" as const,
  canonicalModel: "text-embedding-3-small",
  dimensions: 1_536 as const,
  contractVersion: 1 as const,
};

describe("protected Reflection search metadata", () => {
  test("selects one current protected object and exact authority alternative without content", async () => {
    const statements: string[] = [];
    const product = {
      async query(statement: string) {
        statements.push(statement);
        if (statement.includes('"reflection_record_payload_representation_heads"')) {
          return [{
            record_id: claim.recordRef,
            processing_generation: 3,
            producer_policy_version: "policy:v1",
            lifecycle: "current",
            disposition: "available",
            representation_generation: 4,
            crypto_object_id: "object:four",
            processing_state: "current",
            access_namespace_id: "namespace:one",
          }];
        }
        if (statement.includes('from "reflection_record_search_projections"')) {
          return [];
        }
        throw new Error(`Unexpected query: ${statement}`);
      },
    } as Pick<PostgresJsBridgeConnection, "query">;
    const metadata = new PostgresProtectedReflectionSearchMetadata({
      product,
      configuredEmbedding: () => provenance,
    });

    expect(await metadata.resolve(claim)).toEqual({
      recordRef: claim.recordRef,
      processingGeneration: 3,
      representationGeneration: 4,
      producerPolicyVersion: "policy:v1",
      lifecycle: "current",
      inputBinding: {
        objectId: "object:four",
        namespaceId: "namespace:one",
        objectType: "nautilo.reflection.record.v1",
      },
      expectedEmbeddingProvenance: provenance,
      currentProjection: null,
    });
    const source = statements[0]!;
    expect(source).toContain('"representation" = $1');
    expect(source).toContain('"current" = $3');
    expect(source).toContain('"reflection_record_authority_alternatives"');
    expect(source).toContain("limit $5");
    expect(source).not.toContain("plaintext_payload_bytes");
  });

  test("fails closed when authority metadata is not an exact single row", async () => {
    const row = {
      record_id: claim.recordRef,
      processing_generation: 3,
      producer_policy_version: "policy:v1",
      lifecycle: "current",
      disposition: "available",
      representation_generation: 4,
      crypto_object_id: "object:four",
      processing_state: "current",
      access_namespace_id: "namespace:one",
    };
    const product = {
      query: async () => [row, row],
    } as unknown as Pick<PostgresJsBridgeConnection, "query">;
    const metadata = new PostgresProtectedReflectionSearchMetadata({
      product,
      configuredEmbedding: () => provenance,
    });

    expect(await metadata.resolve(claim)).toBeNull();
  });
});
