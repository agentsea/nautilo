import { describe, expect, test } from "bun:test";
import type { DurableRecordEnvelope } from "@nautilo/reflection/durable";

import { DualModeRecordSearchProjectionPublisher } from "../../src/server";

const vector = Object.freeze(Array.from({ length: 1_536 }, (_, index) => index === 0 ? 1 : 0));
const embedding = {
  provenance: {
    provider: "openai" as const,
    canonicalModel: "text-embedding-3-small",
    dimensions: 1_536 as const,
    contractVersion: 1 as const,
  },
  vector,
};

function record(generation = 3): DurableRecordEnvelope {
  return {
    recordRef: "record:publisher",
    semantic: {
      observedContentFingerprint: "sha256:record",
      posture: "derived",
      statement: "The exact statement to embed.",
      sourceDependencies: [],
      anchors: [],
      childRecordRefs: [],
      producer: { producerRef: "organizer", policyVersion: "v1" },
      terminalAuthorityLeafHandles: ["leaf:one"],
    },
    lifecycle: "current",
    structuralHeight: 0,
    processingGeneration: generation,
  };
}
for (const representation of ["ordinary", "protected"] as const) {
  describe(`${representation} statement projection publication`, () => {
    test("opens the selected Record and constructs provider-owned projection bytes", async () => {
      const calls: string[] = [];
      let published: unknown;
      const publisher = new DualModeRecordSearchProjectionPublisher({
        repository: {
          read: async () => {
            calls.push(`open:${representation}`);
            return { status: "available" as const, record: record() };
          },
        } as never,
        embedding: {
          embed: async (request) => {
            calls.push(`embed:${request.plaintext}`);
            return { status: "available" as const, embedding };
          },
        },
        projections: {
          publish: async (projection: unknown) => {
            calls.push("publish");
            published = projection;
            return "published" as const;
          },
        } as never,
      });
      expect(await publisher.publish({
        recordRef: "record:publisher",
        recordProcessingGeneration: 3,
        projectionVersion: 1,
        projectionGeneration: 1,
        projectionBindingRef: "binding:projection",
      })).toEqual({ status: "published", projectionGeneration: 1 });
      expect(calls).toEqual([
        `open:${representation}`,
        "embed:The exact statement to embed.",
        "publish",
      ]);
      expect(published).toMatchObject({
        recordRef: "record:publisher",
        recordProcessingGeneration: 3,
        embedding: { provenance: embedding.provenance },
      });
    });

    test("fails closed on generation drift and never calls the provider", async () => {
      let embedded = false;
      const publisher = new DualModeRecordSearchProjectionPublisher({
        repository: { read: async () => ({ status: "available", record: record(4) }) } as never,
        embedding: {
          embed: async () => {
            embedded = true;
            return { status: "available" as const, embedding };
          },
        },
        projections: {} as never,
      });
      expect(await publisher.publish({
        recordRef: "record:publisher",
        recordProcessingGeneration: 3,
        projectionVersion: 1,
        projectionGeneration: 1,
        projectionBindingRef: "binding:projection",
      })).toEqual({ status: "rejected", reason: "record_unavailable" });
      expect(embedded).toBe(false);
    });
  });
}
