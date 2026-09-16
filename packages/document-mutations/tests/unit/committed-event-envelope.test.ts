import { expect, test } from "bun:test";
import {
  deriveAtomicDocumentMutationBatchIdempotencyKey,
  validateAtomicDocumentMutationEventBatchEnvelope,
} from "../../src/committed-events";

const event = {
  type: "document.mutation.committed" as const,
  operationId: "op-1",
  revisionGroupId: "group-1",
  sequence: 0,
  outcome: "applied" as const,
  actor: { kind: "human" as const, humanId: "human-1" },
  mutation: "update" as const,
  path: {
    kind: "update" as const,
    before: { kind: "workspace_artifact" as const, artifactId: "11111111-1111-4111-8111-111111111111", logicalPath: "note.md" },
    after: { kind: "workspace_artifact" as const, artifactId: "11111111-1111-4111-8111-111111111111", logicalPath: "note.md" },
  },
  before: {
    identity: { kind: "workspace_artifact" as const, artifactId: "11111111-1111-4111-8111-111111111111", logicalPath: "note.md" },
    backendVersion: { kind: "artifact_revision" as const, revision: 1 }, sha256: "a".repeat(64),
  },
  after: {
    identity: { kind: "workspace_artifact" as const, artifactId: "11111111-1111-4111-8111-111111111111", logicalPath: "note.md" },
    backendVersion: { kind: "artifact_revision" as const, revision: 2 }, sha256: "b".repeat(64),
  },
};

test("D448 durable event envelope validator accepts only contiguous exact committed truth", () => {
  const batch = {
    operationId: "op-1",
    revisionGroupId: "group-1",
    idempotencyKey: deriveAtomicDocumentMutationBatchIdempotencyKey("op-1", "group-1"),
    events: [event],
  };
  expect(validateAtomicDocumentMutationEventBatchEnvelope(batch)).toBe(true);
  expect(validateAtomicDocumentMutationEventBatchEnvelope({
    ...batch,
    events: [{ ...event, sequence: 1 }],
  })).toBe(false);
  expect(validateAtomicDocumentMutationEventBatchEnvelope({
    ...batch,
    idempotencyKey: "other",
  })).toBe(false);
  expect(validateAtomicDocumentMutationEventBatchEnvelope({
    ...batch,
    extra: true,
  })).toBe(false);
});
