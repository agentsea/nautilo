import { describe, expect, test } from "bun:test";
import {
  documentCommitPlanSchema,
  documentIdentitySchema,
  documentMutationCommittedEventSchema,
  documentMutationResultSchema,
  documentVersionSchema,
  humanEditLeaseSchema,
  humanEditLeaseCandidateTargetSchema,
  humanEditLeaseRecordSchema,
  humanEditLeaseStoreResultSchema,
  parseDocumentCommitPlan,
  registerHumanEditLeaseRequestSchema,
  releaseHumanEditLeaseRequestSchema,
  renewHumanEditLeaseRequestSchema,
  updateHumanEditLeaseRequestSchema,
  type DocumentCommitPlan,
  type DocumentIdentity,
  type DocumentMutationCommittedEvent,
  type DocumentVersion,
  type HumanEditLeaseCandidateTarget,
  type RegisterHumanEditLeaseRequest,
} from "../../src/document-mutations";
import { anchoredTextPatchSchema } from "../../src/document-patches";

type ModelApplyPatchInput = { target?: "workspace" | "current"; patch: string };
type Assert<T extends true> = T;
type ModelInputCannotBeIdentity = Assert<
  ModelApplyPatchInput extends DocumentIdentity ? false : true
>;
type LeaseCandidateCannotBeIdentity = Assert<
  HumanEditLeaseCandidateTarget extends DocumentIdentity ? false : true
>;
type LeaseRegisterRequestCannotCarryHumanId = Assert<
  RegisterHumanEditLeaseRequest extends { humanId: string } ? false : true
>;

const ARTIFACT_ID = "7d3bef58-16f0-4c6f-8ee7-137b28d8bfd6";
const OTHER_ARTIFACT_ID = "bb4d92f7-6686-4e72-9cea-3b344206dd44";
const CREATE_ARTIFACT_ID = "11111111-1111-4111-8111-111111111111";
const MOVE_ARTIFACT_ID = "22222222-2222-4222-8222-222222222222";
const DELETE_ARTIFACT_ID = "33333333-3333-4333-8333-333333333333";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

const workspaceIdentity = {
  kind: "workspace_artifact",
  artifactId: ARTIFACT_ID,
  logicalPath: "notes/draft.md",
} as const;
const movedWorkspaceIdentity = {
  ...workspaceIdentity,
  logicalPath: "notes/final.md",
} as const;
const workspaceVersion = {
  identity: workspaceIdentity,
  backendVersion: { kind: "artifact_revision", revision: 7 },
  sha256: SHA_A,
} as const;
const movedWorkspaceVersion = {
  identity: movedWorkspaceIdentity,
  backendVersion: { kind: "artifact_revision", revision: 8 },
  sha256: SHA_B,
} as const;
const overwriteDestinationIdentity = {
  ...movedWorkspaceIdentity,
  artifactId: OTHER_ARTIFACT_ID,
} as const;
const overwriteDestinationVersion = {
  identity: overwriteDestinationIdentity,
  backendVersion: { kind: "artifact_revision", revision: 3 },
  sha256: SHA_B,
} as const;
const localIdentity = {
  kind: "local_file",
  relayId: "relay-1",
  canonicalPath: "/Users/test/notes/draft.md",
} as const;
const localVersion = {
  identity: localIdentity,
  backendVersion: { kind: "local_sha", sha256: SHA_A },
  sha256: SHA_A,
} as const;

function versionForIdentity(identity: DocumentIdentity): DocumentVersion {
  return identity.kind === "workspace_artifact"
    ? {
        identity,
        backendVersion: { kind: "artifact_revision", revision: 1 },
        sha256: SHA_A,
      }
    : {
        identity,
        backendVersion: { kind: "local_sha", sha256: SHA_A },
        sha256: SHA_A,
      };
}

function expectedSnapshot(
  identity: DocumentIdentity = workspaceIdentity,
  version: DocumentVersion = versionForIdentity(identity),
) {
  return { identity, expectedVersion: version, bytes: new Uint8Array([1]) };
}

function postImage(identity: DocumentIdentity = workspaceIdentity, sha256 = SHA_B) {
  return { identity, sha256, bytes: new Uint8Array([2]) };
}

function plan(entries: unknown[]) {
  return {
    operationId: "operation-1",
    actor: { kind: "agent", agentId: "agent-1" },
    turnId: "turn-1",
    entries,
  };
}

function eventBase() {
  return {
    type: "document.mutation.committed",
    operationId: "operation-1",
    revisionGroupId: "group-1",
    sequence: 0,
    outcome: "applied",
    actor: { kind: "agent", agentId: "agent-1" },
  } as const;
}

describe("D448 document mutation identity and version schemas", () => {
  test("accepts normalized Workspace and local identities and exact versions", () => {
    expect(documentIdentitySchema.parse(workspaceIdentity)).toEqual(workspaceIdentity);
    expect(documentIdentitySchema.parse(localIdentity)).toEqual(localIdentity);
    expect(documentIdentitySchema.safeParse({
      kind: "local_file",
      relayId: "relay-2",
      canonicalPath: "C:\\Users\\test\\draft.md",
    }).success).toBe(true);
    expect(documentVersionSchema.parse(workspaceVersion)).toEqual(workspaceVersion);
    expect(documentVersionSchema.parse(localVersion)).toEqual(localVersion);
  });

  test("rejects malformed paths, hashes, revisions, ids, and unknown fields", () => {
    for (const logicalPath of ["", "/absolute.md", "notes/../secret.md", "notes//draft.md", "notes\\draft.md"]) {
      expect(documentIdentitySchema.safeParse({ ...workspaceIdentity, logicalPath }).success).toBe(false);
    }
    for (const canonicalPath of ["", "/", "relative/file.md", "/tmp/../secret", "C:\\"]) {
      expect(documentIdentitySchema.safeParse({ ...localIdentity, canonicalPath }).success).toBe(false);
    }
    expect(documentIdentitySchema.safeParse({ ...workspaceIdentity, artifactId: "" }).success).toBe(false);
    expect(documentIdentitySchema.safeParse({ ...localIdentity, relayId: " " }).success).toBe(false);
    expect(documentIdentitySchema.safeParse({ ...workspaceIdentity, root: "/tmp" }).success).toBe(false);
    expect(documentVersionSchema.safeParse({ ...workspaceVersion, sha256: "ABC" }).success).toBe(false);
    expect(documentVersionSchema.safeParse({
      ...workspaceVersion,
      backendVersion: { kind: "artifact_revision", revision: -1 },
    }).success).toBe(false);
    expect(documentVersionSchema.safeParse({
      ...workspaceVersion,
      backendVersion: { kind: "artifact_revision", revision: Number.MAX_SAFE_INTEGER + 1 },
    }).success).toBe(false);
    expect(documentVersionSchema.safeParse({
      ...localVersion,
      backendVersion: { kind: "local_sha", sha256: SHA_B },
    }).success).toBe(false);
  });
});

describe("D448 document mutation commit plans and leases", () => {
  test("accepts exact read-only preconditions but rejects aliases, duplicate paths, and mixed backends", () => {
    const sourceIdentity = {
      ...workspaceIdentity,
      artifactId: OTHER_ARTIFACT_ID,
      logicalPath: "reports/source.docx",
    } as const;
    const sourceVersion = {
      identity: sourceIdentity,
      backendVersion: { kind: "artifact_revision" as const, revision: 4 },
      sha256: SHA_A,
    } as const;
    const outputIdentity = {
      ...workspaceIdentity,
      artifactId: CREATE_ARTIFACT_ID,
      logicalPath: "reports/output.docx",
    } as const;
    const valid = plan([{ kind: "create", after: postImage(outputIdentity) }]);
    expect(documentCommitPlanSchema.safeParse({
      ...valid,
      preconditions: [{
        identity: sourceIdentity,
        expectedVersion: sourceVersion,
        bytes: new Uint8Array([1]),
      }],
    }).success).toBe(true);

    const duplicated = {
      identity: sourceIdentity,
      expectedVersion: sourceVersion,
      bytes: new Uint8Array([1]),
    };
    expect(documentCommitPlanSchema.safeParse({
      ...valid,
      preconditions: [duplicated, duplicated],
    }).success).toBe(false);
    expect(documentCommitPlanSchema.safeParse({
      ...valid,
      preconditions: [{
        identity: outputIdentity,
        expectedVersion: {
          identity: outputIdentity,
          backendVersion: { kind: "artifact_revision", revision: 1 },
          sha256: SHA_A,
        },
        bytes: new Uint8Array([1]),
      }],
    }).success).toBe(false);
    expect(documentCommitPlanSchema.safeParse({
      ...valid,
      preconditions: [{
        identity: localIdentity,
        expectedVersion: localVersion,
        bytes: new Uint8Array([1]),
      }],
    }).success).toBe(false);
  });

  test("accepts only closed single-update human editor-save correlation", () => {
    const legacy = documentCommitPlanSchema.parse(
      plan([{ kind: "update", before: expectedSnapshot(), after: postImage() }]),
    );
    expect(legacy.editorSave).toBeUndefined();

    const editorSave = {
      ...plan([{ kind: "update", before: expectedSnapshot(), after: postImage() }]),
      actor: { kind: "human", humanId: "human-1" },
      editorSave: {
        kind: "editor_save",
        checkpoint: true,
        baseVersion: workspaceVersion,
        requestId: "request-1",
        clientMutationId: "client-mutation-1",
        anchoredPatch: {
          kind: "anchored_text",
          oldString: "before",
          newString: "after",
        },
      },
    };
    expect(documentCommitPlanSchema.parse(editorSave)).toMatchObject({
      editorSave: {
        checkpoint: true,
        baseVersion: workspaceVersion,
        requestId: "request-1",
        clientMutationId: "client-mutation-1",
      },
    });
    expect(documentCommitPlanSchema.safeParse({
      ...editorSave,
      actor: { kind: "agent", agentId: "agent-1" },
    }).success).toBe(false);
    expect(documentCommitPlanSchema.safeParse({
      ...editorSave,
      editorSave: { ...editorSave.editorSave, roomId: "forged-room" },
    }).success).toBe(false);
    expect(documentCommitPlanSchema.safeParse({
      ...editorSave,
      entries: [
        { kind: "update", before: expectedSnapshot(), after: postImage() },
        { kind: "delete", before: expectedSnapshot({
          ...workspaceIdentity,
          artifactId: DELETE_ARTIFACT_ID,
          logicalPath: "notes/delete.md",
        }) },
      ],
    }).success).toBe(false);
  });

  test("parses every operation with unambiguous shapes and a nonempty ordered plan", () => {
    const createdIdentity = {
      ...workspaceIdentity,
      artifactId: CREATE_ARTIFACT_ID,
      logicalPath: "notes/created.md",
    };
    const moveSourceIdentity = {
      ...workspaceIdentity,
      artifactId: MOVE_ARTIFACT_ID,
      logicalPath: "notes/old.md",
    };
    const moveAfterIdentity = {
      ...moveSourceIdentity,
      logicalPath: "notes/moved.md",
    };
    const deletedIdentity = {
      ...workspaceIdentity,
      artifactId: DELETE_ARTIFACT_ID,
      logicalPath: "notes/obsolete.md",
    };
    const parsed = parseDocumentCommitPlan(plan([
      { kind: "create", after: postImage(createdIdentity) },
      { kind: "update", before: expectedSnapshot(), after: postImage() },
      {
        kind: "move",
        source: expectedSnapshot(moveSourceIdentity),
        after: postImage(moveAfterIdentity),
      },
      { kind: "delete", before: expectedSnapshot(deletedIdentity) },
    ]));

    expect(parsed.entries.map((entry) => entry.kind)).toEqual([
      "create",
      "update",
      "move",
      "delete",
    ]);
    expect(documentCommitPlanSchema.safeParse(plan([])).success).toBe(false);
    expect(documentCommitPlanSchema.safeParse({ ...plan([{ kind: "create", after: postImage() }]), extra: true }).success).toBe(false);
  });

  test("rejects snapshot, update, and lease cross-identity combinations", () => {
    const crossArtifactIdentity = {
      ...workspaceIdentity,
      artifactId: OTHER_ARTIFACT_ID,
    };
    expect(documentCommitPlanSchema.safeParse(plan([{
      kind: "delete",
      before: expectedSnapshot(crossArtifactIdentity, workspaceVersion),
    }])).success).toBe(false);
    expect(documentCommitPlanSchema.safeParse(plan([{
      kind: "update",
      before: expectedSnapshot(),
      after: postImage(movedWorkspaceIdentity),
    }])).success).toBe(false);
    expect(documentCommitPlanSchema.safeParse(plan([{
      kind: "update",
      before: expectedSnapshot(),
      after: postImage(localIdentity),
    }])).success).toBe(false);

    expect(humanEditLeaseSchema.safeParse({
      leaseId: "lease-1",
      sessionId: "session-1",
      humanId: "human-1",
      identity: movedWorkspaceIdentity,
      baseVersion: workspaceVersion,
      generation: 0,
      state: "dirty",
    }).success).toBe(false);
    expect(humanEditLeaseSchema.safeParse({
      leaseId: "lease-1",
      sessionId: "session-1",
      humanId: "human-1",
      identity: workspaceIdentity,
      baseVersion: workspaceVersion,
      generation: -1,
      state: "dirty",
    }).success).toBe(false);
  });

  test("defines one strict anchored draft schema and coherent lease draft rules", () => {
    const draftPatch = {
      kind: "anchored_text",
      oldString: "before",
      newString: "after",
      scope: { from: 2, to: 4 },
    } as const;
    expect(anchoredTextPatchSchema.safeParse(draftPatch).success).toBe(true);
    expect(anchoredTextPatchSchema.safeParse({
      ...draftPatch,
      unexpected: true,
    }).success).toBe(false);
    expect(anchoredTextPatchSchema.safeParse({
      ...draftPatch,
      scope: { from: 4, to: 2 },
    }).success).toBe(false);

    const dirtyLease = {
      leaseId: "lease-1",
      sessionId: "session-1",
      humanId: "human-1",
      identity: workspaceIdentity,
      baseVersion: workspaceVersion,
      generation: 0,
      state: "dirty",
      draftPatch,
    } as const;
    expect(humanEditLeaseSchema.safeParse(dirtyLease).success).toBe(true);
    expect(humanEditLeaseSchema.safeParse({
      ...dirtyLease,
      state: "clean",
    }).success).toBe(false);
    expect(humanEditLeaseSchema.safeParse({
      ...dirtyLease,
      draftPatch: undefined,
    }).success).toBe(true);
  });

  test("keeps ephemeral lease records and store results strict", () => {
    const record = {
      lease: {
        leaseId: "lease-1",
        sessionId: "session-1",
        humanId: "human-1",
        identity: workspaceIdentity,
        baseVersion: workspaceVersion,
        generation: 0,
        state: "clean",
      },
      expiresAtMs: 1_000,
    } as const;
    expect(humanEditLeaseRecordSchema.safeParse(record).success).toBe(true);
    expect(humanEditLeaseRecordSchema.safeParse({
      ...record,
      durable: true,
    }).success).toBe(false);
    expect(humanEditLeaseStoreResultSchema.safeParse({
      status: "ok",
      record,
    }).success).toBe(true);
    expect(humanEditLeaseStoreResultSchema.safeParse({
      status: "stale_generation",
      record,
    }).success).toBe(true);
    expect(humanEditLeaseStoreResultSchema.safeParse({
      status: "forbidden",
    }).success).toBe(false);
  });

  test("accepts only untrusted candidate targets for human-edit lease transport", () => {
    const workspaceTarget = {
      kind: "workspace_artifact",
      artifactInternalId: ARTIFACT_ID,
      logicalPath: "notes/draft.md",
    } as const;
    const localTarget = {
      kind: "local_file",
      relayId: "relay-1",
      // Candidate paths are resolved by the trusted relay, not canonicalized by the browser.
      candidatePath: "/Users/test/notes/../notes/draft.md",
    } as const;
    expect(humanEditLeaseCandidateTargetSchema.parse(workspaceTarget)).toEqual(workspaceTarget);
    expect(humanEditLeaseCandidateTargetSchema.parse(localTarget)).toEqual(localTarget);

    for (const target of [
      { ...workspaceTarget, artifactInternalId: "not-a-uuid" },
      { ...workspaceTarget, logicalPath: "/notes/draft.md" },
      { ...workspaceTarget, artifactId: ARTIFACT_ID },
      { ...workspaceTarget, kind: "artifact" },
      { ...localTarget, relayId: " " },
      { ...localTarget, candidatePath: "notes/draft.md" },
      { ...localTarget, candidatePath: " " },
      { ...localTarget, canonicalPath: "/Users/test/notes/draft.md" },
    ]) {
      expect(humanEditLeaseCandidateTargetSchema.safeParse(target).success).toBe(false);
    }
  });

  test("keeps every lease transport request closed and authority-free", () => {
    const target = {
      kind: "workspace_artifact",
      artifactInternalId: ARTIFACT_ID,
      logicalPath: "notes/draft.md",
    } as const;
    const draftPatch = {
      kind: "anchored_text",
      oldString: "before",
      newString: "after",
    } as const;
    const registerRequest = {
      sessionId: "session-1",
      target,
      state: "dirty",
      draftPatch,
    } as const;
    const updateRequest = {
      ...registerRequest,
      expectedGeneration: 3,
    } as const;
    const releaseRequest = {
      sessionId: "session-1",
      expectedGeneration: 3,
    } as const;
    const renewRequest = {
      ...releaseRequest,
      target,
    } as const;

    expect(registerHumanEditLeaseRequestSchema.parse(registerRequest)).toEqual(registerRequest);
    expect(updateHumanEditLeaseRequestSchema.parse(updateRequest)).toEqual(updateRequest);
    expect(renewHumanEditLeaseRequestSchema.parse(renewRequest)).toEqual(renewRequest);
    expect(releaseHumanEditLeaseRequestSchema.parse(releaseRequest)).toEqual(releaseRequest);
    expect(registerHumanEditLeaseRequestSchema.safeParse({
      ...registerRequest,
      state: "clean",
    }).success).toBe(false);
    expect(updateHumanEditLeaseRequestSchema.safeParse({
      ...updateRequest,
      state: "clean",
    }).success).toBe(false);
    expect(registerHumanEditLeaseRequestSchema.safeParse({
      ...registerRequest,
      draftPatch: undefined,
    }).success).toBe(true);
    expect(updateHumanEditLeaseRequestSchema.safeParse({
      ...updateRequest,
      draftPatch: undefined,
    }).success).toBe(true);

    const authorityFields = {
      humanId: "human-1",
      leaseId: "lease-1",
      generation: 3,
      identity: workspaceIdentity,
      baseVersion: workspaceVersion,
      namespace: "workspace",
      owner: "owner-1",
      grant: "grant-1",
      root: "/Users/test",
      revision: 7,
      outcome: "applied",
    } as const;
    const schemasAndRequests = [
      [registerHumanEditLeaseRequestSchema, registerRequest],
      [updateHumanEditLeaseRequestSchema, updateRequest],
      [renewHumanEditLeaseRequestSchema, renewRequest],
      [releaseHumanEditLeaseRequestSchema, releaseRequest],
    ] as const;
    for (const [schema, request] of schemasAndRequests) {
      for (const [field, value] of Object.entries(authorityFields)) {
        expect(schema.safeParse({ ...request, [field]: value }).success).toBe(false);
      }
    }
    expect(updateHumanEditLeaseRequestSchema.safeParse({
      ...updateRequest,
      expectedGeneration: -1,
    }).success).toBe(false);
    expect(renewHumanEditLeaseRequestSchema.safeParse({
      ...renewRequest,
      target: { ...target, artifactInternalId: "not-a-uuid" },
    }).success).toBe(false);
    expect(releaseHumanEditLeaseRequestSchema.safeParse({
      ...releaseRequest,
      target,
    }).success).toBe(false);
    expect(releaseHumanEditLeaseRequestSchema.safeParse({
      ...releaseRequest,
      expectedGeneration: -1,
    }).success).toBe(false);
  });

  test("accepts a correlated overwrite move and rejects invalid move maps", () => {
    const overwriteMove = {
      kind: "move",
      source: expectedSnapshot(),
      destinationBefore: expectedSnapshot(
        overwriteDestinationIdentity,
        overwriteDestinationVersion,
      ),
      after: postImage(movedWorkspaceIdentity),
    };
    expect(documentCommitPlanSchema.safeParse(plan([overwriteMove])).success).toBe(true);

    const wrongPathDestination = {
      ...overwriteDestinationIdentity,
      logicalPath: "notes/wrong.md",
    };
    expect(documentCommitPlanSchema.safeParse(plan([{
      ...overwriteMove,
      destinationBefore: expectedSnapshot(wrongPathDestination),
    }])).success).toBe(false);
    expect(documentCommitPlanSchema.safeParse(plan([{
      ...overwriteMove,
      destinationBefore: expectedSnapshot(localIdentity, localVersion),
    }])).success).toBe(false);
    expect(documentCommitPlanSchema.safeParse(plan([{
      kind: "move",
      source: expectedSnapshot(),
      after: postImage(workspaceIdentity),
    }])).success).toBe(false);
    expect(documentCommitPlanSchema.safeParse(plan([{
      kind: "move",
      source: expectedSnapshot(),
      after: postImage({ ...movedWorkspaceIdentity, artifactId: OTHER_ARTIFACT_ID }),
    }])).success).toBe(false);
    expect(documentCommitPlanSchema.safeParse(plan([{
      kind: "move",
      source: expectedSnapshot(),
      after: postImage(localIdentity),
    }])).success).toBe(false);
    expect(documentCommitPlanSchema.safeParse(plan([{
      kind: "move",
      source: expectedSnapshot(localIdentity, localVersion),
      after: postImage({ ...localIdentity, relayId: "relay-2", canonicalPath: "/Users/test/notes/final.md" }),
    }])).success).toBe(false);
    const localAfterIdentity = {
      ...localIdentity,
      canonicalPath: "/Users/test/notes/final.md",
    };
    const wrongRelayDestination = {
      ...localAfterIdentity,
      relayId: "relay-2",
    };
    expect(documentCommitPlanSchema.safeParse(plan([{
      kind: "move",
      source: expectedSnapshot(localIdentity, localVersion),
      destinationBefore: expectedSnapshot(wrongRelayDestination),
      after: postImage(localAfterIdentity),
    }])).success).toBe(false);
  });

  test("rejects mixed backends and duplicate or colliding plan claims", () => {
    expect(documentCommitPlanSchema.safeParse(plan([
      { kind: "create", after: postImage(workspaceIdentity) },
      { kind: "create", after: postImage(localIdentity) },
    ])).success).toBe(false);
    expect(documentCommitPlanSchema.safeParse(plan([
      { kind: "create", after: postImage(localIdentity) },
      {
        kind: "create",
        after: postImage({
          ...localIdentity,
          relayId: "relay-2",
          canonicalPath: "/Users/test/notes/other.md",
        }),
      },
    ])).success).toBe(false);

    const samePathOtherArtifact = {
      ...workspaceIdentity,
      artifactId: OTHER_ARTIFACT_ID,
    };
    expect(documentCommitPlanSchema.safeParse(plan([
      { kind: "create", after: postImage(workspaceIdentity) },
      { kind: "create", after: postImage(samePathOtherArtifact) },
    ])).success).toBe(false);
    expect(documentCommitPlanSchema.safeParse(plan([
      { kind: "update", before: expectedSnapshot(), after: postImage() },
      { kind: "delete", before: expectedSnapshot() },
    ])).success).toBe(false);
    expect(documentCommitPlanSchema.safeParse(plan([
      { kind: "update", before: expectedSnapshot(), after: postImage() },
      { kind: "create", after: postImage(movedWorkspaceIdentity) },
    ])).success).toBe(false);
    expect(documentCommitPlanSchema.safeParse(plan([
      {
        kind: "move",
        source: expectedSnapshot(),
        after: postImage(movedWorkspaceIdentity),
      },
      {
        kind: "create",
        after: postImage({
          ...movedWorkspaceIdentity,
          artifactId: OTHER_ARTIFACT_ID,
        }),
      },
    ])).success).toBe(false);

    expect(documentCommitPlanSchema.safeParse(plan([
      {
        kind: "create",
        after: postImage({
          ...workspaceIdentity,
          artifactId: CREATE_ARTIFACT_ID,
          logicalPath: "notes/one.md",
        }),
      },
      {
        kind: "create",
        after: postImage({
          ...workspaceIdentity,
          artifactId: DELETE_ARTIFACT_ID,
          logicalPath: "notes/two.md",
        }),
      },
    ])).success).toBe(true);
  });
});

describe("D448 document mutation results and committed events", () => {
  test("validates stable result variants and rejects malformed result paths", () => {
    const applied = {
      kind: "applied",
      operationId: "operation-1",
      revisionGroupId: "group-1",
      paths: [{
        kind: "move",
        overwrite: false,
        before: workspaceIdentity,
        after: movedWorkspaceIdentity,
      }],
    };
    const conflict = {
      kind: "conflict",
      operationId: "operation-1",
      code: "human_edit_conflict",
      evidence: [{
        path: { kind: "update", before: workspaceIdentity, after: workspaceIdentity },
        currentVersion: workspaceVersion,
      }],
    };
    const overwriteApplied = {
      ...applied,
      paths: [{
        kind: "move",
        overwrite: true,
        before: workspaceIdentity,
        destinationBefore: overwriteDestinationIdentity,
        after: movedWorkspaceIdentity,
      }],
    };
    expect(documentMutationResultSchema.safeParse(applied).success).toBe(true);
    expect(documentMutationResultSchema.safeParse(overwriteApplied).success).toBe(true);
    expect(documentMutationResultSchema.safeParse(conflict).success).toBe(true);
    expect(documentMutationResultSchema.safeParse({
      ...conflict,
      evidence: [],
    }).success).toBe(false);
    expect(documentMutationResultSchema.safeParse({
      ...conflict,
      evidence: [{
        ...conflict.evidence[0],
        currentVersion: movedWorkspaceVersion,
      }],
    }).success).toBe(false);
    expect(documentMutationResultSchema.safeParse({
      kind: "failed",
      operationId: "operation-1",
      code: "backend_failure",
    }).success).toBe(true);
    expect(documentMutationResultSchema.safeParse({ ...applied, paths: [] }).success).toBe(false);
    expect(documentMutationResultSchema.safeParse({
      ...applied,
      paths: [{ kind: "update", before: workspaceIdentity, after: movedWorkspaceIdentity }],
    }).success).toBe(false);
    expect(documentMutationResultSchema.safeParse({
      ...overwriteApplied,
      paths: [{
        kind: "move",
        overwrite: true,
        before: workspaceIdentity,
        destinationBefore: {
          ...overwriteDestinationIdentity,
          logicalPath: "notes/wrong.md",
        },
        after: movedWorkspaceIdentity,
      }],
    }).success).toBe(false);
    expect(documentMutationResultSchema.safeParse({ ...conflict, code: "unknown_conflict" }).success).toBe(false);
  });

  test("correlates committed event mutation, path, versions, and sequence", () => {
    const moveEvent = {
      ...eventBase(),
      mutation: "move",
      overwrite: false,
      path: {
        kind: "move",
        overwrite: false,
        before: workspaceIdentity,
        after: movedWorkspaceIdentity,
      },
      before: workspaceVersion,
      after: movedWorkspaceVersion,
    } as const satisfies DocumentMutationCommittedEvent;
    const overwriteMoveEvent = {
      ...eventBase(),
      mutation: "move",
      overwrite: true,
      path: {
        kind: "move",
        overwrite: true,
        before: workspaceIdentity,
        destinationBefore: overwriteDestinationIdentity,
        after: movedWorkspaceIdentity,
      },
      before: workspaceVersion,
      destinationBefore: overwriteDestinationVersion,
      after: movedWorkspaceVersion,
    } as const satisfies DocumentMutationCommittedEvent;
    expect(documentMutationCommittedEventSchema.safeParse(moveEvent).success).toBe(true);
    expect(documentMutationCommittedEventSchema.safeParse(overwriteMoveEvent).success).toBe(true);
    expect(documentMutationCommittedEventSchema.safeParse({
      ...moveEvent,
      sequence: -1,
    }).success).toBe(false);
    expect(documentMutationCommittedEventSchema.safeParse({
      ...moveEvent,
      extra: true,
    }).success).toBe(false);
    expect(documentMutationCommittedEventSchema.safeParse({
      ...moveEvent,
      path: {
        kind: "move",
        overwrite: false,
        before: workspaceIdentity,
        after: { ...movedWorkspaceIdentity, logicalPath: "notes/other.md" },
      },
    }).success).toBe(false);
    expect(documentMutationCommittedEventSchema.safeParse({
      ...moveEvent,
      mutation: "update",
    }).success).toBe(false);
    const { destinationBefore: omittedDestinationVersion, ...missingDestinationVersion } =
      overwriteMoveEvent;
    void omittedDestinationVersion;
    expect(documentMutationCommittedEventSchema.safeParse(
      missingDestinationVersion,
    ).success).toBe(false);
    expect(documentMutationCommittedEventSchema.safeParse({
      ...moveEvent,
      destinationBefore: overwriteDestinationVersion,
    }).success).toBe(false);
    expect(documentMutationCommittedEventSchema.safeParse({
      ...overwriteMoveEvent,
      destinationBefore: {
        ...overwriteDestinationVersion,
        identity: {
          ...overwriteDestinationIdentity,
          logicalPath: "notes/wrong.md",
        },
      },
    }).success).toBe(false);

    const localAfterIdentity = {
      ...localIdentity,
      canonicalPath: "/Users/test/notes/final.md",
    } as const;
    const localAfterVersion = {
      identity: localAfterIdentity,
      backendVersion: { kind: "local_sha", sha256: SHA_B },
      sha256: SHA_B,
    } as const;
    const localOverwriteEvent = {
      ...eventBase(),
      mutation: "move",
      overwrite: true,
      path: {
        kind: "move",
        overwrite: true,
        before: localIdentity,
        destinationBefore: localAfterIdentity,
        after: localAfterIdentity,
      },
      before: localVersion,
      destinationBefore: {
        identity: localAfterIdentity,
        backendVersion: { kind: "local_sha", sha256: SHA_A },
        sha256: SHA_A,
      },
      after: localAfterVersion,
    } as const satisfies DocumentMutationCommittedEvent;
    expect(documentMutationCommittedEventSchema.safeParse(localOverwriteEvent).success).toBe(true);
    expect(documentMutationCommittedEventSchema.safeParse({
      ...localOverwriteEvent,
      destinationBefore: {
        ...localOverwriteEvent.destinationBefore,
        identity: {
          ...localAfterIdentity,
          relayId: "relay-2",
        },
      },
    }).success).toBe(false);

    const assertCompileTimeEventShapes = (): void => {
      const mismatchedEvent: DocumentMutationCommittedEvent = {
        ...eventBase(),
        mutation: "update",
        // @ts-expect-error An update event cannot carry a move path.
        path: {
          kind: "move",
          overwrite: false,
          before: workspaceIdentity,
          after: movedWorkspaceIdentity,
        },
        before: workspaceVersion,
        after: movedWorkspaceVersion,
      };
      void mismatchedEvent;

      // @ts-expect-error Overwrite move events require the displaced destination version.
      const missingOverwriteVersion: DocumentMutationCommittedEvent = {
        ...eventBase(),
        mutation: "move",
        overwrite: true,
        path: {
          kind: "move",
          overwrite: true,
          before: workspaceIdentity,
          destinationBefore: overwriteDestinationIdentity,
          after: movedWorkspaceIdentity,
        },
        before: workspaceVersion,
        after: movedWorkspaceVersion,
      };
      void missingOverwriteVersion;

      const unexpectedOverwriteVersion: DocumentMutationCommittedEvent = {
        ...moveEvent,
        // @ts-expect-error Non-overwrite moves cannot carry a displaced destination version.
        destinationBefore: overwriteDestinationVersion,
      };
      void unexpectedOverwriteVersion;
    };
    void assertCompileTimeEventShapes;
  });

  test("allows strict editor correlation only on human update events", () => {
    const editorAfter = {
      identity: workspaceIdentity,
      backendVersion: { kind: "artifact_revision", revision: 8 },
      sha256: SHA_B,
    } as const;
    const editorUpdate = {
      ...eventBase(),
      actor: { kind: "human", humanId: "human-1" },
      mutation: "update",
      path: { kind: "update", before: workspaceIdentity, after: workspaceIdentity },
      before: workspaceVersion,
      after: editorAfter,
      editorSave: {
        checkpoint: true,
        requestId: "request-1",
        clientMutationId: "client-mutation-1",
        anchoredPatch: {
          kind: "anchored_text",
          oldString: "before",
          newString: "after",
        },
      },
    } as const satisfies DocumentMutationCommittedEvent;
    expect(documentMutationCommittedEventSchema.safeParse(editorUpdate).success).toBe(true);
    expect(documentMutationCommittedEventSchema.safeParse({
      ...editorUpdate,
      editorSave: { ...editorUpdate.editorSave, baseVersion: workspaceVersion },
    }).success).toBe(false);
    expect(documentMutationCommittedEventSchema.safeParse({
      ...editorUpdate,
      editorSave: { ...editorUpdate.editorSave, requestId: " " },
    }).success).toBe(false);
    expect(documentMutationCommittedEventSchema.safeParse({
      ...editorUpdate,
      actor: { kind: "agent", agentId: "agent-1" },
    }).success).toBe(false);

    const structuralEventsWithEditorSave = [{
      ...eventBase(),
      actor: { kind: "human", humanId: "human-1" },
      mutation: "create",
      path: { kind: "create", after: workspaceIdentity },
      after: workspaceVersion,
      editorSave: editorUpdate.editorSave,
    }, {
      ...eventBase(),
      actor: { kind: "human", humanId: "human-1" },
      mutation: "move",
      overwrite: false,
      path: {
        kind: "move",
        overwrite: false,
        before: workspaceIdentity,
        after: movedWorkspaceIdentity,
      },
      before: workspaceVersion,
      after: movedWorkspaceVersion,
      editorSave: editorUpdate.editorSave,
    }, {
      ...eventBase(),
      actor: { kind: "human", humanId: "human-1" },
      mutation: "delete",
      path: { kind: "delete", before: workspaceIdentity },
      before: workspaceVersion,
      editorSave: editorUpdate.editorSave,
    }];
    for (const structuralEvent of structuralEventsWithEditorSave) {
      expect(documentMutationCommittedEventSchema.safeParse(structuralEvent).success).toBe(false);
    }
  });

  test("keeps model-facing target selection structurally separate from authority", () => {
    const modelInput = {
      target: "workspace",
      patch: "*** Begin Patch\n*** End Patch",
    } as const satisfies ModelApplyPatchInput;
    const compileTimeProof: ModelInputCannotBeIdentity = true;
    const leaseCandidateProof: LeaseCandidateCannotBeIdentity = true;
    const leaseRequestProof: LeaseRegisterRequestCannotCarryHumanId = true;

    expect(compileTimeProof).toBe(true);
    expect(leaseCandidateProof).toBe(true);
    expect(leaseRequestProof).toBe(true);
    expect(documentIdentitySchema.safeParse(modelInput).success).toBe(false);
  });
});

test("DocumentCommitPlan remains inferred from its runtime schema", () => {
  const typedPlan: DocumentCommitPlan = documentCommitPlanSchema.parse(
    plan([{ kind: "create", after: postImage() }]),
  );
  expect(typedPlan.entries[0]?.kind).toBe("create");
});
