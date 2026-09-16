import { expect, test } from "bun:test";
import {
  assertWorkspaceMutationEntryEventProof,
  type WorkspaceMutationReceiptEntryInput,
} from "../../src/queries/workspace-document-mutations";
import type { DocumentMutationCommittedEvent } from "@nautilo/types";

const sha = "a".repeat(64);
const entry: WorkspaceMutationReceiptEntryInput = {
  sequence: 0,
  kind: "update",
  revisionIds: ["revision-1"],
  undoRecordIds: ["undo-1"],
  artifactInternalId: "11111111-1111-4111-8111-111111111111",
  beforeLogicalPath: "note.md",
  afterLogicalPath: "note.md",
  beforeRevision: 1,
  afterRevision: 2,
  beforeSha256: sha,
  afterSha256: sha,
  beforeSize: 1,
  afterSize: 1,
  beforeStorageUri: "file:///immutable-before",
  afterStorageUri: "file:///immutable-after",
  checkpoint: false,
};

const event: Extract<DocumentMutationCommittedEvent, { mutation: "update" }> = {
  type: "document.mutation.committed",
  operationId: "op-1",
  revisionGroupId: "group-1",
  sequence: 0,
  outcome: "applied",
  actor: { kind: "human", humanId: "human-1" },
  mutation: "update",
  path: {
    kind: "update",
    before: { kind: "workspace_artifact", artifactId: entry.artifactInternalId, logicalPath: "note.md" },
    after: { kind: "workspace_artifact", artifactId: entry.artifactInternalId, logicalPath: "note.md" },
  },
  before: {
    identity: { kind: "workspace_artifact", artifactId: entry.artifactInternalId, logicalPath: "note.md" },
    backendVersion: { kind: "artifact_revision", revision: 1 }, sha256: sha,
  },
  after: {
    identity: { kind: "workspace_artifact", artifactId: entry.artifactInternalId, logicalPath: "note.md" },
    backendVersion: { kind: "artifact_revision", revision: 2 }, sha256: sha,
  },
  workspaceArtifactMetadata: { beforeMimeType: "text/plain", afterMimeType: "text/markdown" },
};

test("D448 receipt proof rejects MIME event metadata absent from durable entry evidence", () => {
  expect(() => assertWorkspaceMutationEntryEventProof(entry, event)).toThrow(
    "update MIME transition must exactly match its committed event",
  );
});

test("D448 structural receipt proofs accept exact create, delete, and overwrite-move events", () => {
  const sourceId = "22222222-2222-4222-8222-222222222222";
  const destinationId = "33333333-3333-4333-8333-333333333333";
  const actor = { kind: "agent" as const, agentId: "agent-1" };
  const base = {
    type: "document.mutation.committed" as const,
    operationId: "op-structural",
    revisionGroupId: "group-structural",
    outcome: "applied" as const,
    actor,
  };
  const createEntry: WorkspaceMutationReceiptEntryInput = {
    sequence: 0,
    kind: "create",
    revisionIds: ["create-revision"],
    undoRecordIds: ["create-undo"],
    artifactInternalId: sourceId,
    afterLogicalPath: "created.md",
    afterRevision: 1,
    afterSha256: sha,
    afterSize: 1,
    afterStorageUri: "file:///created",
    checkpoint: false,
  };
  const createIdentity = {
    kind: "workspace_artifact" as const,
    artifactId: sourceId,
    logicalPath: "created.md",
  };
  expect(() => assertWorkspaceMutationEntryEventProof(createEntry, {
    ...base,
    sequence: 0,
    mutation: "create",
    path: { kind: "create", after: createIdentity },
    after: {
      identity: createIdentity,
      backendVersion: { kind: "artifact_revision", revision: 1 },
      sha256: sha,
    },
  })).not.toThrow();

  const deleteEntry: WorkspaceMutationReceiptEntryInput = {
    sequence: 1,
    kind: "delete",
    revisionIds: ["delete-revision"],
    undoRecordIds: ["delete-undo"],
    artifactInternalId: sourceId,
    beforeLogicalPath: "created.md",
    beforeRevision: 1,
    beforeSha256: sha,
    beforeSize: 1,
    beforeStorageUri: "file:///created",
    checkpoint: false,
  };
  expect(() => assertWorkspaceMutationEntryEventProof(deleteEntry, {
    ...base,
    sequence: 1,
    mutation: "delete",
    path: { kind: "delete", before: createIdentity },
    before: {
      identity: createIdentity,
      backendVersion: { kind: "artifact_revision", revision: 1 },
      sha256: sha,
    },
  })).not.toThrow();

  const sourceIdentity = {
    kind: "workspace_artifact" as const,
    artifactId: sourceId,
    logicalPath: "source.md",
  };
  const destinationIdentity = {
    kind: "workspace_artifact" as const,
    artifactId: destinationId,
    logicalPath: "destination.md",
  };
  const movedIdentity = { ...destinationIdentity, artifactId: sourceId };
  const moveEntry: WorkspaceMutationReceiptEntryInput = {
    sequence: 2,
    kind: "move",
    revisionIds: ["move-revision", "destination-delete-revision"],
    undoRecordIds: ["move-undo", "destination-delete-undo"],
    artifactInternalId: sourceId,
    beforeLogicalPath: sourceIdentity.logicalPath,
    afterLogicalPath: movedIdentity.logicalPath,
    beforeRevision: 4,
    afterRevision: 5,
    beforeSha256: sha,
    afterSha256: sha,
    beforeSize: 1,
    afterSize: 1,
    beforeStorageUri: "file:///source-before",
    afterStorageUri: "file:///source-after",
    destinationBeforeArtifactInternalId: destinationId,
    destinationBeforeLogicalPath: destinationIdentity.logicalPath,
    destinationBeforeRevision: 8,
    destinationBeforeSha256: sha,
    destinationBeforeSize: 1,
    destinationBeforeStorageUri: "file:///destination-before",
    checkpoint: false,
  };
  expect(() => assertWorkspaceMutationEntryEventProof(moveEntry, {
    ...base,
    sequence: 2,
    mutation: "move",
    overwrite: true,
    path: {
      kind: "move",
      overwrite: true,
      before: sourceIdentity,
      destinationBefore: destinationIdentity,
      after: movedIdentity,
    },
    before: {
      identity: sourceIdentity,
      backendVersion: { kind: "artifact_revision", revision: 4 },
      sha256: sha,
    },
    destinationBefore: {
      identity: destinationIdentity,
      backendVersion: { kind: "artifact_revision", revision: 8 },
      sha256: sha,
    },
    after: {
      identity: movedIdentity,
      backendVersion: { kind: "artifact_revision", revision: 5 },
      sha256: sha,
    },
  })).not.toThrow();
});
