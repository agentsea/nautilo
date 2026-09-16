import { describe, expect, test } from "bun:test";
import type {
  DurableModelExposureDependency,
  DurableRecordEnvelope,
  DurableRecordLifecycleMutation,
  DurableRecordLifecycleMutationResult,
  DurableRecordPublication,
  DurableRecordPublicationResult,
  DurableRecordReadRequest,
  DurableRecordReadResult,
} from "@nautilo/reflection/durable";

import {
  createHmacOrganizerPublicationIdentityPort,
  ORGANIZER_PUBLICATION_COMMITMENT_MAX_BYTES,
  OrganizerProposalPublisher,
  type OrganizerCrossRoomPublicationFencePort,
  type OrganizerProposalRepositoryPort,
  type OrganizerSourceDependencyValidationPort,
} from "../../src/server";
import {
  crossRoomApplicationPlanToken,
  type CrossRoomInputCoordinate,
  type CrossRoomPublicationPlan,
  type CrossRoomRecordInputCoordinate,
} from "../../src/server/cross-room-execution";

const ROOM = {
  roomAnchorRef: "room:alpha",
  terminalAuthorityLeafHandle: "namespace:alpha",
  readBindingRef: "read:alpha",
  publicationBindingRef: "publish:alpha",
  producerPolicyVersion: "candidate-policy-v1",
} as const;

const budget = {
  maxModelCalls: 0,
  maxVisitedRecords: 16,
  maxCreatedRecords: 1,
  maxTraversalWork: 16,
  maxStatementCharacters: 800,
};

function record(
  recordRef: string,
  options: {
    readonly height?: number;
    readonly lifecycle?: DurableRecordEnvelope["lifecycle"];
    readonly room?: string;
    readonly terminalHandle?: string;
    readonly terminalHandles?: readonly string[];
    readonly extraAnchors?: DurableRecordEnvelope["semantic"]["anchors"];
    readonly children?: readonly string[];
    readonly sources?: DurableRecordEnvelope["semantic"]["sourceDependencies"];
  } = {},
): DurableRecordEnvelope {
  const room = options.room ?? ROOM.roomAnchorRef;
  const terminalHandle = options.terminalHandle ?? ROOM.terminalAuthorityLeafHandle;
  return {
    recordRef,
    semantic: {
      observedContentFingerprint: `fixture:${recordRef}`,
      posture: "derived",
      statement: `Statement for ${recordRef}`,
      sourceDependencies: options.sources ?? [],
      anchors: [
        { anchorRef: room, kind: "room", role: "origin" },
        ...(options.extraAnchors ?? []),
      ],
      childRecordRefs: options.children ?? [],
      producer: { producerRef: "stenographer", policyVersion: "fixture:v1" },
      terminalAuthorityLeafHandles: options.terminalHandles ?? [terminalHandle],
    },
    lifecycle: options.lifecycle ?? "current",
    structuralHeight: options.height ?? 0,
    processingGeneration: 1,
  };
}

class FixtureRepository implements OrganizerProposalRepositoryPort {
  readonly records = new Map<string, DurableRecordEnvelope>();
  readonly publications: DurableRecordPublication[] = [];
  readonly transitions: DurableRecordLifecycleMutation[] = [];
  readonly reads: DurableRecordReadRequest[] = [];
  readonly #publicationByKey = new Map<string, DurableRecordPublication>();

  read(input: DurableRecordReadRequest): Promise<DurableRecordReadResult> {
    this.reads.push(input);
    const found = this.records.get(input.recordRef);
    return Promise.resolve(found === undefined
      ? { status: "unavailable", recordRef: input.recordRef, reason: "not_found" }
      : { status: "available", record: found });
  }

  readCompletedPublication(input: Readonly<{
    idempotencyKey: string;
    readBindingRef: string;
  }>): Promise<
    | { readonly status: "available"; readonly record: DurableRecordEnvelope }
    | { readonly status: "unavailable"; readonly reason: "not_found" }
  > {
    const prior = this.#publicationByKey.get(input.idempotencyKey);
    if (prior === undefined) {
      return Promise.resolve({
        status: "unavailable",
        reason: "not_found",
      });
    }
    this.reads.push({ recordRef: prior.record.recordRef, readBindingRef: input.readBindingRef });
    return Promise.resolve({ status: "available", record: prior.record });
  }

  publish(input: DurableRecordPublication): Promise<DurableRecordPublicationResult> {
    const prior = this.#publicationByKey.get(input.idempotencyKey);
    if (prior !== undefined) {
      return Promise.resolve(
        JSON.stringify(prior) === JSON.stringify(input)
          ? { status: "replayed", record: input.record }
          : { status: "rejected", recordRef: input.record.recordRef, reason: "idempotency_conflict" },
      );
    }
    this.#publicationByKey.set(input.idempotencyKey, input);
    this.publications.push(input);
    this.records.set(input.record.recordRef, input.record);
    return Promise.resolve({ status: "published", record: input.record });
  }

  transitionLifecycle(
    input: DurableRecordLifecycleMutation,
  ): Promise<DurableRecordLifecycleMutationResult> {
    this.transitions.push(input);
    const current = this.records.get(input.recordRef);
    if (current === undefined) {
      return Promise.resolve({ status: "not_found", recordRef: input.recordRef, replayed: false });
    }
    if (
      current.lifecycle === input.to
      && current.processingGeneration === input.expectedProcessingGeneration + 1
    ) {
      return Promise.resolve({
        status: "transitioned",
        recordRef: input.recordRef,
        lifecycle: input.to,
        replayed: true,
      });
    }
    if (
      current.lifecycle !== input.from
      || current.processingGeneration !== input.expectedProcessingGeneration
    ) {
      return Promise.resolve({ status: "conflict", recordRef: input.recordRef, replayed: false });
    }
    this.records.set(input.recordRef, {
      ...current,
      lifecycle: input.to,
      processingGeneration: current.processingGeneration + 1,
    });
    return Promise.resolve({
      status: "transitioned",
      recordRef: input.recordRef,
      lifecycle: input.to,
      replayed: false,
    });
  }
}

function publisher(
  repository: FixtureRepository,
  validateSource: OrganizerSourceDependencyValidationPort["validate"] = () =>
    Promise.resolve("current"),
  crossRoomFences?: OrganizerCrossRoomPublicationFencePort,
  recordBindings?: Readonly<{
    read(recordRef: string): Promise<Readonly<{
      originPublicationBindingRef: string;
      currentAccessBindingRefs: readonly string[];
      representationGeneration: number;
      authorityProjectionGeneration: number | null;
    }> | null>;
  }>,
  preserveExactPlanInvocationOrigin = false,
): OrganizerProposalPublisher {
  return new OrganizerProposalPublisher({
    repository,
    sourceDependencies: { validate: validateSource },
    identity: createHmacOrganizerPublicationIdentityPort(
      new Uint8Array(32).fill(0x4d),
    ),
    room: ROOM,
    ...(crossRoomFences === undefined ? {} : { crossRoomFences }),
    ...(recordBindings === undefined ? {} : { recordBindings }),
    ...(preserveExactPlanInvocationOrigin
      ? { preserveExactPlanInvocationOrigin: true }
      : {}),
  });
}

function publicationPlan(input: Readonly<{
  idempotencyKey: string;
  inputs: readonly CrossRoomInputCoordinate[];
  modelExposureDependencies?: readonly DurableModelExposureDependency[];
  outputNamespace?: string;
  predecessorOnlyRecordRef?: string;
}>): CrossRoomPublicationPlan {
  const outputNamespace = input.outputNamespace ?? "namespace:access:abc";
  return {
    applicationPlanToken: crossRoomApplicationPlanToken("application-plan:abc"),
    policyVersion: "candidate-policy-v1",
    selectedInputs: input.inputs,
    ...(input.modelExposureDependencies === undefined
      ? {}
      : { modelExposureDependencies: input.modelExposureDependencies }),
    ...(input.predecessorOnlyRecordRef === undefined
      ? {}
      : { predecessorOnlyRecordRef: input.predecessorOnlyRecordRef }),
    output: {
      accessRoomRef: "room:access:abc",
      accessNamespaceRef: outputNamespace,
      publicationBindingRef: `publish:${outputNamespace}`,
      authorityGeneration: 8,
      includesPublicBoundary: false,
    },
    commitments: {
      authority: "commitment:authority:abc",
      representation: "commitment:representation:ordinary:3",
    },
    budget: {
      maxInputItems: input.inputs.length,
      maxInputBytes: 64_000,
      maxModelCalls: 2,
      maxOutputItems: 1,
      maxOutputBytes: 16_000,
    },
    idempotencyKey: input.idempotencyKey,
  };
}

function plannedRecord(input: Readonly<{
  role: "changed" | "candidate";
  recordRef: string;
  namespaceRef: string;
  readBindingRef: string;
  processingGeneration?: number;
}>): CrossRoomRecordInputCoordinate {
  return {
    kind: "record",
    role: input.role,
    recordRef: input.recordRef,
    processingGeneration: input.processingGeneration ?? 1,
    representationGeneration: 3,
    authorityGeneration: 4,
    read: {
      namespaceRef: input.namespaceRef,
      bindingRef: input.readBindingRef,
    },
  };
}

describe("Organizer proposal publisher", () => {
  test("publishes and replays a deterministic mixed Record/Memory parent", async () => {
    const repository = new FixtureRepository();
    repository.records.set("record:a", record("record:a", {
      extraAnchors: [{ anchorRef: "subject:database", kind: "subject", role: "topic" }],
    }));
    repository.records.set("record:b", record("record:b", { height: 1 }));
    const apply = publisher(repository);
    const input = {
      proposal: {
        operation: "create_parent" as const,
        statement: "PostgreSQL was selected for portable transactions and managed backups.",
        childRecordRefs: ["record:a", "record:b"],
        sourceDependencies: [{
          sourceKind: "memory/v1",
          logicalSourceRef: "memory:backup-preference",
          observedRevision: "revision:4",
          observedContentFingerprint: "sha256:memory-4",
          terminalAuthorityLeafHandle: ROOM.terminalAuthorityLeafHandle,
          authorityBearing: true,
        }],
      },
      idempotencyKey: "sleep:raw-logical-identity:7",
      changedRecordRef: "record:a",
      changeReason: "created" as const,
      budget,
    };

    const first = await apply.apply(input);
    const replay = await apply.apply({
      ...input,
      // The model is not part of durable replay identity. If the process dies
      // after publication but before work completion, a changed retry must
      // recognize the already-committed result instead of conflicting.
      proposal: {
        ...input.proposal,
        statement: "A different valid model rendering on retry.",
        childRecordRefs: ["record:missing-on-retry"],
      },
    });
    expect(first).toMatchObject({
      status: "applied",
      operation: "create_parent",
      replayed: false,
      usage: { visitedRecords: 2, createdRecords: 1, traversalWork: 2 },
    });
    expect(replay).toMatchObject({
      status: "applied",
      operation: "create_parent",
      replayed: true,
      usage: { visitedRecords: 0, createdRecords: 0, traversalWork: 0 },
      changedRecord: {
        logicalObjectRef: repository.publications[0]!.record.recordRef,
        generation: 1,
        recordRef: repository.publications[0]!.record.recordRef,
      },
    });
    expect(repository.publications).toHaveLength(1);
    const publication = repository.publications[0]!;
    expect(publication.idempotencyKey).toMatch(/^organizer-publication:[0-9a-f]{64}$/u);
    expect(publication.idempotencyKey).not.toContain("raw-logical-identity");
    expect(publication.record.recordRef).toMatch(/^organizer-record:[0-9a-f]{64}$/u);
    expect(publication.record.semantic.observedContentFingerprint)
      .toMatch(/^hmac-sha256:[0-9a-f]{64}$/u);
    expect(publication.record).toMatchObject({
      lifecycle: "current",
      structuralHeight: 2,
      processingGeneration: 1,
      semantic: {
        posture: "derived",
        childRecordRefs: ["record:a", "record:b"],
        producer: { producerRef: "organizer", policyVersion: "candidate-policy-v1" },
        terminalAuthorityLeafHandles: [ROOM.terminalAuthorityLeafHandle],
      },
    });
    expect(publication.record.semantic.anchors).toEqual([
      { anchorRef: ROOM.roomAnchorRef, kind: "room", role: "origin" },
      { anchorRef: "subject:database", kind: "subject", role: "topic" },
    ]);
    expect(publication.record.semantic.sourceDependencies).toEqual(
      input.proposal.sourceDependencies,
    );
    expect(first.status === "applied" ? first.changedRecord : undefined).toEqual({
      logicalObjectRef: publication.record.recordRef,
      generation: 1,
      recordRef: publication.record.recordRef,
    });
    expect(repository.reads.every((read) => read.readBindingRef === ROOM.readBindingRef))
      .toBe(true);
  });

  test("does not publish a derived height-zero lookalike from authored sources alone", async () => {
    const repository = new FixtureRepository();
    const result = await publisher(repository).apply({
      proposal: {
        operation: "create_parent",
        statement: "Two authored observations without a native Record edge.",
        childRecordRefs: [],
        sourceDependencies: [
          {
            sourceKind: "memory/v1",
            logicalSourceRef: "memory:first",
            observedRevision: "1",
            observedContentFingerprint: "sha256:first-1",
            terminalAuthorityLeafHandle: ROOM.terminalAuthorityLeafHandle,
            authorityBearing: true,
          },
          {
            sourceKind: "memory/v1",
            logicalSourceRef: "memory:second",
            observedRevision: "1",
            observedContentFingerprint: "sha256:second-1",
            terminalAuthorityLeafHandle: ROOM.terminalAuthorityLeafHandle,
            authorityBearing: true,
          },
        ],
      },
      idempotencyKey: "sleep:source-only:1",
      changedRecordRef: "record:a",
      changeReason: "created",
      budget,
    });

    expect(result).toEqual({
      status: "unavailable",
      failureCode: "publication_unavailable",
      failureDetail: "publication_plan_invalid",
    });
    expect(repository.publications).toHaveLength(0);
  });

  for (const [operation, relation] of [
    ["supersede_parent", "supersedes"],
    ["resolve_parent", "resolves"],
  ] as const) {
    test(`derives the ${relation} edge without model-assigned structure`, async () => {
      const repository = new FixtureRepository();
      repository.records.set("record:child", record("record:child"));
      repository.records.set("record:parent", record("record:parent", { height: 1 }));
      const result = await publisher(repository).apply({
        proposal: {
          operation,
          parentRecordRef: "record:parent",
          statement: `A grounded ${operation} statement.`,
          childRecordRefs: ["record:child"],
          sourceDependencies: [],
        },
        idempotencyKey: `sleep:${operation}:1`,
        changedRecordRef: "record:a",
        changeReason: "dependency_lost",
        budget,
      });
      expect(result).toMatchObject({ status: "applied", operation, replayed: false });
      expect(repository.publications[0]?.predecessor).toEqual({
        recordRef: "record:parent",
        relation,
      });
      expect(repository.publications[0]?.record.structuralHeight).toBe(1);
    });
  }

  test("extends A+B with C while preserving predecessor support automatically", async () => {
    const repository = new FixtureRepository();
    repository.records.set("record:a", record("record:a"));
    repository.records.set("record:b", record("record:b"));
    repository.records.set("record:c", record("record:c"));
    repository.records.set("record:p1", record("record:p1", {
      height: 1,
      children: ["record:a", "record:b"],
    }));

    const result = await publisher(repository).apply({
      proposal: {
        operation: "extend_parent",
        parentRecordRef: "record:p1",
        statement: "The decision now includes the operational constraint from C.",
        additionRecordRefs: ["record:c"],
        additionSourceDependencies: [],
      },
      idempotencyKey: "sleep:extend-p1:1",
      changedRecordRef: "record:c",
      changeReason: "created",
      budget,
    });

    expect(result).toMatchObject({
      status: "applied",
      operation: "extend_parent",
      replayed: false,
    });
    expect(repository.publications[0]).toMatchObject({
      predecessor: { recordRef: "record:p1", relation: "supersedes" },
      record: {
        lifecycle: "current",
        structuralHeight: 1,
        semantic: {
          childRecordRefs: ["record:a", "record:b", "record:c"],
        },
      },
    });
  });

  test("does not publish a paraphrase or equivalent wrapper with unchanged evidence", async () => {
    const repository = new FixtureRepository();
    repository.records.set("record:a", record("record:a"));
    repository.records.set("record:b", record("record:b"));
    repository.records.set("record:p1", record("record:p1", {
      height: 1,
      children: ["record:a", "record:b"],
    }));
    repository.records.set("record:equivalent", record("record:equivalent", {
      height: 1,
      children: ["record:a", "record:b"],
    }));
    const apply = publisher(repository);

    expect(await apply.apply({
      proposal: {
        operation: "wrap_parent",
        parentRecordRef: "record:p1",
        statement: "Different words over the same support.",
        additionRecordRefs: ["record:a"],
        additionSourceDependencies: [],
      },
      idempotencyKey: "sleep:paraphrase:1",
      changedRecordRef: "record:p1",
      changeReason: "created",
      budget,
    })).toMatchObject({ status: "applied", operation: "no_change" });

    expect(await apply.apply({
      proposal: {
        operation: "extend_parent",
        parentRecordRef: "record:p1",
        statement: "A wrapper with no new terminal evidence.",
        additionRecordRefs: ["record:equivalent"],
        additionSourceDependencies: [],
      },
      idempotencyKey: "sleep:equivalent:1",
      changedRecordRef: "record:equivalent",
      changeReason: "created",
      budget,
    })).toMatchObject({ status: "applied", operation: "no_change" });
    expect(repository.publications).toHaveLength(0);
  });

  test("preserves exact authored support and grows only with a new source identity", async () => {
    const repository = new FixtureRepository();
    const priorSource = {
      sourceKind: "memory/v1",
      logicalSourceRef: "memory:prior",
      observedRevision: "2",
      observedContentFingerprint: "sha256:prior-2",
      terminalAuthorityLeafHandle: ROOM.terminalAuthorityLeafHandle,
      authorityBearing: true,
    } as const;
    const newSource = {
      sourceKind: "memory/v1",
      logicalSourceRef: "memory:new",
      observedRevision: "1",
      observedContentFingerprint: "sha256:new-1",
      terminalAuthorityLeafHandle: ROOM.terminalAuthorityLeafHandle,
      authorityBearing: true,
    } as const;
    repository.records.set("record:a", record("record:a"));
    repository.records.set("record:p1", record("record:p1", {
      height: 1,
      children: ["record:a"],
      sources: [priorSource],
    }));
    const apply = publisher(repository);

    expect(await apply.apply({
      proposal: {
        operation: "extend_parent",
        parentRecordRef: "record:p1",
        statement: "No new evidence.",
        additionRecordRefs: ["record:a"],
        additionSourceDependencies: [priorSource],
      },
      idempotencyKey: "sleep:same-source:1",
      changedRecordRef: "record:a",
      changeReason: "revised",
      budget,
    })).toMatchObject({ status: "applied", operation: "no_change" });

    expect(await apply.apply({
      proposal: {
        operation: "extend_parent",
        parentRecordRef: "record:p1",
        statement: "The parent now also includes the new authored observation.",
        additionRecordRefs: ["record:a"],
        additionSourceDependencies: [newSource],
      },
      idempotencyKey: "sleep:new-source:1",
      changedRecordRef: "record:a",
      changeReason: "created",
      budget,
    })).toMatchObject({ status: "applied", operation: "extend_parent" });
    expect(repository.publications[0]?.record.semantic.sourceDependencies)
      .toEqual([newSource, priorSource]);
  });

  test("does not extend when exact authored support is no longer current", async () => {
    const repository = new FixtureRepository();
    const source = {
      sourceKind: "memory/v1",
      logicalSourceRef: "memory:prior",
      observedRevision: "2",
      observedContentFingerprint: "sha256:prior-2",
      terminalAuthorityLeafHandle: ROOM.terminalAuthorityLeafHandle,
      authorityBearing: true,
    } as const;
    repository.records.set("record:a", record("record:a"));
    repository.records.set("record:p1", record("record:p1", { sources: [source] }));
    const result = await publisher(
      repository,
      () => Promise.resolve("unavailable"),
    ).apply({
      proposal: {
        operation: "extend_parent",
        parentRecordRef: "record:p1",
        statement: "Must not preserve stale authored support.",
        additionRecordRefs: ["record:a"],
        additionSourceDependencies: [],
      },
      idempotencyKey: "sleep:stale-source:1",
      changedRecordRef: "record:a",
      changeReason: "created",
      budget,
    });
    expect(result).toEqual({
      status: "unavailable",
      failureCode: "publication_unavailable",
      failureDetail: "publication_source_unavailable",
    });
    expect(repository.publications).toHaveLength(0);
  });

  test("returns typed unavailable when exact extension closure exceeds its bound", async () => {
    const repository = new FixtureRepository();
    repository.records.set("record:a", record("record:a"));
    repository.records.set("record:b", record("record:b"));
    repository.records.set("record:c", record("record:c"));
    repository.records.set("record:p1", record("record:p1", {
      height: 1,
      children: ["record:a", "record:b"],
    }));
    expect(await publisher(repository).apply({
      proposal: {
        operation: "extend_parent",
        parentRecordRef: "record:p1",
        statement: "Cannot be proven inside the selected graph budget.",
        additionRecordRefs: ["record:c"],
        additionSourceDependencies: [],
      },
      idempotencyKey: "sleep:bounded:1",
      changedRecordRef: "record:c",
      changeReason: "created",
      budget: { ...budget, maxVisitedRecords: 2 },
    })).toEqual({
      status: "unavailable",
      failureCode: "publication_unavailable",
      failureDetail: "publication_budget_exhausted",
    });
    expect(repository.publications).toHaveLength(0);
  });

  test("completes oversized scheduled maintenance without a retry tail", async () => {
    const repository = new FixtureRepository();
    repository.records.set("record:a", record("record:a"));
    repository.records.set("record:b", record("record:b"));
    repository.records.set("record:c", record("record:c"));
    repository.records.set("record:p1", record("record:p1", {
      height: 1,
      children: ["record:a", "record:b"],
    }));

    expect(await publisher(repository).apply({
      proposal: {
        operation: "extend_parent",
        parentRecordRef: "record:p1",
        statement: "Optional maintenance cannot fit its proof budget.",
        additionRecordRefs: ["record:c"],
        additionSourceDependencies: [],
      },
      idempotencyKey: "sleep:scheduled-bounded:1",
      changedRecordRef: "record:c",
      changeReason: "scheduled_review",
      budget: { ...budget, maxVisitedRecords: 2 },
    })).toEqual({
      status: "applied",
      operation: "no_change",
      replayed: false,
      usage: {
        modelCalls: 0,
        visitedRecords: 0,
        createdRecords: 0,
        traversalWork: 0,
      },
    });
    expect(repository.publications).toHaveLength(0);
  });

  test("contracts an ancestor-descendant proposal instead of retrying it", async () => {
    const repository = new FixtureRepository();
    repository.records.set("record:leaf", record("record:leaf"));
    repository.records.set("record:parent", record("record:parent", {
      height: 1,
      children: ["record:leaf"],
    }));

    const result = await publisher(repository).apply({
      proposal: {
        operation: "create_parent",
        statement: "This support is already represented by the selected parent.",
        childRecordRefs: ["record:leaf", "record:parent"],
        sourceDependencies: [],
      },
      idempotencyKey: "sleep:ancestor-descendant:1",
      changedRecordRef: "record:leaf",
      changeReason: "created",
      budget,
    });

    expect(result).toMatchObject({
      status: "applied",
      operation: "no_change",
      usage: { createdRecords: 0 },
    });
    expect(repository.publications).toHaveLength(0);
  });

  test("retries a concurrent predecessor conflict from the winning head", async () => {
    const repository = new FixtureRepository();
    repository.records.set("record:a", record("record:a"));
    repository.records.set("record:b", record("record:b"));
    repository.publish = (input) => Promise.resolve({
      status: "rejected",
      recordRef: input.record.recordRef,
      reason: "structural_conflict",
      structuralReason: "child_parent_changed",
    });

    const result = await publisher(repository).apply({
      proposal: {
        operation: "create_parent",
        statement: "A concurrent graph winner already made this proposal obsolete.",
        childRecordRefs: ["record:a", "record:b"],
        sourceDependencies: [],
      },
      idempotencyKey: "sleep:repository-conflict:1",
      changedRecordRef: "record:a",
      changeReason: "created",
      budget,
    });

    expect(result).toEqual({
      status: "stale",
      failureDetail: "publication_child_parent_changed",
    });
  });

  test("keeps deterministic structural rejection typed and non-retryable", async () => {
    const repository = new FixtureRepository();
    repository.records.set("record:a", record("record:a"));
    repository.records.set("record:b", record("record:b"));
    repository.publish = (input) => Promise.resolve({
      status: "rejected",
      recordRef: input.record.recordRef,
      reason: "structural_conflict",
      structuralReason: "height_mismatch",
    });

    const result = await publisher(repository).apply({
      proposal: {
        operation: "create_parent",
        statement: "This malformed proposal must remain diagnosable.",
        childRecordRefs: ["record:a", "record:b"],
        sourceDependencies: [],
      },
      idempotencyKey: "sleep:repository-height:1",
      changedRecordRef: "record:a",
      changeReason: "created",
      budget,
    });

    expect(result).toEqual({
      status: "unavailable",
      failureCode: "publication_unavailable",
      failureDetail: "publication_height_mismatch",
    });
  });

  test("scheduled promotion requires pairwise-disjoint effective evidence closures", async () => {
    const repository = new FixtureRepository();
    for (const leaf of ["a", "b", "c", "d"]) {
      repository.records.set(`record:${leaf}`, record(`record:${leaf}`));
    }
    repository.records.set("record:p1", record("record:p1", {
      height: 1,
      children: ["record:a", "record:b"],
    }));
    repository.records.set("record:overlap", record("record:overlap", {
      height: 1,
      children: ["record:b", "record:c"],
    }));
    repository.records.set("record:disjoint", record("record:disjoint", {
      height: 1,
      children: ["record:c", "record:d"],
    }));
    const apply = publisher(repository);
    const proposal = {
      operation: "create_parent" as const,
      statement: "Stable parent clusters earn a higher abstraction.",
      childRecordRefs: ["record:p1", "record:overlap"],
      sourceDependencies: [],
    };
    expect(await apply.apply({
      proposal,
      idempotencyKey: "sleep:promotion-overlap:1",
      changedRecordRef: "record:p1",
      changeReason: "scheduled_review",
      budget,
    })).toMatchObject({ status: "applied", operation: "no_change" });
    expect(repository.publications).toHaveLength(0);

    expect(await apply.apply({
      proposal: { ...proposal, childRecordRefs: ["record:p1", "record:disjoint"] },
      idempotencyKey: "sleep:promotion-disjoint:1",
      changedRecordRef: "record:p1",
      changeReason: "scheduled_review",
      budget,
    })).toMatchObject({ status: "applied", operation: "create_parent" });
    expect(repository.publications).toHaveLength(1);
  });

  test("scheduled extension rejects overlap that ordinary attachment may absorb", async () => {
    const repository = new FixtureRepository();
    for (const leaf of ["a", "b", "c", "d"]) {
      repository.records.set(`record:${leaf}`, record(`record:${leaf}`));
    }
    repository.records.set("record:left", record("record:left", {
      height: 1,
      children: ["record:a", "record:b"],
    }));
    repository.records.set("record:overlap", record("record:overlap", {
      height: 1,
      children: ["record:b", "record:c"],
    }));
    repository.records.set("record:top", record("record:top", {
      height: 2,
      children: ["record:left", "record:d"],
    }));
    const apply = publisher(repository);
    const proposal = {
      operation: "extend_parent" as const,
      parentRecordRef: "record:top",
      statement: "The higher abstraction absorbs the related overlapping cluster.",
      additionRecordRefs: ["record:overlap"],
      additionSourceDependencies: [],
    };

    expect(await apply.apply({
      proposal,
      idempotencyKey: "sleep:scheduled-overlap-extension:1",
      changedRecordRef: "record:overlap",
      changeReason: "scheduled_review",
      budget,
    })).toMatchObject({ status: "applied", operation: "no_change" });
    expect(repository.publications).toHaveLength(0);

    expect(await apply.apply({
      proposal,
      idempotencyKey: "sleep:attachment-overlap-extension:1",
      changedRecordRef: "record:overlap",
      changeReason: "created",
      budget,
    })).toMatchObject({ status: "applied", operation: "extend_parent" });
    expect(repository.publications[0]?.record.semantic.childRecordRefs).toEqual([
      "record:d",
      "record:left",
      "record:overlap",
    ]);
  });

  test("sunsets a parent by exact generation and reports restart-safe replay", async () => {
    const repository = new FixtureRepository();
    repository.records.set("record:parent", record("record:parent", { height: 1 }));
    const apply = publisher(repository);
    const input = {
      proposal: { operation: "dissolve_parent" as const, parentRecordRef: "record:parent" },
      idempotencyKey: "sleep:dissolve:1",
      changedRecordRef: "record:a",
      changeReason: "dependency_lost" as const,
      budget,
    };
    const first = await apply.apply(input);
    const replay = await apply.apply(input);
    expect(first).toMatchObject({
      status: "applied",
      operation: "dissolve_parent",
      replayed: false,
      changedRecord: { recordRef: "record:parent", generation: 2 },
    });
    expect(replay).toMatchObject({
      status: "applied",
      operation: "dissolve_parent",
      replayed: true,
      changedRecord: { recordRef: "record:parent", generation: 2 },
    });
    expect(repository.transitions).toEqual([{
      recordRef: "record:parent",
      expectedProcessingGeneration: 1,
      from: "current",
      to: "sunset",
    }]);
  });

  test("rejects wrong-Room support and insufficient budgets before publication", async () => {
    const repository = new FixtureRepository();
    repository.records.set("record:a", record("record:a"));
    repository.records.set("record:other", record("record:other", {
      room: "room:other",
      terminalHandle: "namespace:other",
    }));
    const apply = publisher(repository);
    const proposal = {
      operation: "create_parent" as const,
      statement: "Should not publish.",
      childRecordRefs: ["record:other"],
      sourceDependencies: [{
        sourceKind: "memory",
        logicalSourceRef: "memory:alpha",
        terminalAuthorityLeafHandle: ROOM.terminalAuthorityLeafHandle,
        authorityBearing: true,
      }],
    };
    expect(await apply.apply({
      proposal,
      idempotencyKey: "sleep:wrong-room:1",
      changedRecordRef: "record:other",
      changeReason: "created",
      budget,
    })).toEqual({
      status: "unavailable",
      failureCode: "publication_unavailable",
      failureDetail: "publication_child_unavailable",
    });
    const readsAfterWrongRoom = repository.reads.length;
    expect(await apply.apply({
      proposal: { ...proposal, childRecordRefs: ["record:a"] },
      idempotencyKey: "sleep:no-budget:1",
      changedRecordRef: "record:a",
      changeReason: "created",
      budget: { ...budget, maxVisitedRecords: 0 },
    })).toEqual({
      status: "unavailable",
      failureCode: "publication_unavailable",
      failureDetail: "publication_budget_exhausted",
    });
    expect(repository.reads).toHaveLength(readsAfterWrongRoom);
    expect(repository.publications).toHaveLength(0);
  });

  test("extends an equal-audience cross-Room parent through exact per-Record bindings", async () => {
    const repository = new FixtureRepository();
    repository.records.set("record:a", record("record:a", {
      room: "room:a",
      terminalHandle: "namespace:a",
    }));
    repository.records.set("record:b", record("record:b", {
      room: "room:b",
      terminalHandle: "namespace:b",
    }));
    repository.records.set("record:c", record("record:c", {
      room: "room:c",
      terminalHandle: "namespace:c",
    }));
    repository.records.set("record:p1", record("record:p1", {
      height: 1,
      room: "room:access:ab",
      terminalHandles: ["namespace:a", "namespace:b"],
      children: ["record:a", "record:b"],
    }));
    const idempotencyKey = "cross-room:extend:equal:1";
    const plan = publicationPlan({
      idempotencyKey,
      inputs: [
        plannedRecord({
          role: "changed",
          recordRef: "record:p1",
          namespaceRef: "namespace:access:ab",
          readBindingRef: "read:p1",
        }),
        plannedRecord({
          role: "candidate",
          recordRef: "record:c",
          namespaceRef: "namespace:c",
          readBindingRef: "read:c",
        }),
      ],
    });
    const fenceCalls: string[] = [];
    const result = await publisher(repository, undefined, {
      revalidate: ({ predecessorRecordRef }) => {
        fenceCalls.push(predecessorRecordRef ?? "none");
        return Promise.resolve({
          status: "current",
          predecessorAudience: "equal",
        });
      },
    }).apply({
      proposal: {
        operation: "extend_parent",
        parentRecordRef: "record:p1",
        statement: "The shared decision also incorporates C.",
        additionRecordRefs: ["record:c"],
        additionSourceDependencies: [],
      },
      publicationPlan: plan,
      idempotencyKey,
      changedRecordRef: "record:p1",
      changeReason: "created",
      budget,
    });

    expect(result).toMatchObject({ status: "applied", operation: "extend_parent" });
    expect(fenceCalls).toEqual(["record:p1", "record:p1"]);
    expect(repository.reads).toContainEqual({
      recordRef: "record:p1",
      readBindingRef: "read:p1",
    });
    expect(repository.reads).toContainEqual({
      recordRef: "record:a",
      readBindingRef: "read:p1",
    });
    expect(repository.reads).toContainEqual({
      recordRef: "record:b",
      readBindingRef: "read:p1",
    });
    expect(repository.reads).toContainEqual({
      recordRef: "record:c",
      readBindingRef: "read:c",
    });
    expect(repository.publications[0]).toMatchObject({
      predecessor: { recordRef: "record:p1", relation: "supersedes" },
      publicationBindingRef: "publish:namespace:access:abc",
      record: {
        structuralHeight: 1,
        semantic: {
          childRecordRefs: ["record:a", "record:b", "record:c"],
          terminalAuthorityLeafHandles: ["namespace:a", "namespace:b", "namespace:c"],
        },
      },
    });
    expect(repository.publications[0]?.record.semantic.anchors).toEqual([
      { anchorRef: "room:a", kind: "room", role: "origin" },
      { anchorRef: "room:access:abc", kind: "room", role: "origin" },
      { anchorRef: "room:b", kind: "room", role: "origin" },
      { anchorRef: "room:c", kind: "room", role: "origin" },
    ]);
    expect(repository.publications[0]?.record.semantic.terminalAuthorityLeafHandles)
      .not.toContain("namespace:access:abc");
  });

  test("keeps exact same-Room publication origin separate from output access", async () => {
    const repository = new FixtureRepository();
    repository.records.set("record:a", record("record:a"));
    repository.records.set("record:b", record("record:b"));
    const idempotencyKey = "same-room:protected:1";
    const plan = publicationPlan({
      idempotencyKey,
      inputs: [
        plannedRecord({role: "changed", recordRef: "record:a", namespaceRef: "namespace:alpha", readBindingRef: "read:a"}),
        plannedRecord({role: "candidate", recordRef: "record:b", namespaceRef: "namespace:alpha", readBindingRef: "read:b"}),
      ],
    });
    const result = await publisher(repository, undefined, {
      revalidate: () => Promise.resolve({status: "current"}),
    }, undefined, true).apply({
      proposal: {operation: "create_parent", statement: "Same Room parent.", childRecordRefs: ["record:a", "record:b"], sourceDependencies: []},
      publicationPlan: plan,
      idempotencyKey,
      changedRecordRef: "record:a",
      changeReason: "created",
      budget,
    });

    expect(result).toMatchObject({status: "applied", operation: "create_parent"});
    expect(repository.publications[0]).toMatchObject({
      publicationBindingRef: "publish:namespace:access:abc",
      originPublicationBindingRef: ROOM.publicationBindingRef,
      record: {semantic: {anchors: [{anchorRef: ROOM.roomAnchorRef, kind: "room", role: "origin"}]}},
    });
  });

  test("supersedes a dependency-loss parent when remaining authority expands", async () => {
    const repository = new FixtureRepository();
    repository.records.set("record:b", record("record:b", {
      height: 1,
      room: "room:b",
      terminalHandle: "namespace:b",
      children: ["record:b-leaf"],
    }));
    repository.records.set("record:b-leaf", record("record:b-leaf", {
      room: "room:b-leaf",
      terminalHandle: "namespace:b-leaf",
    }));
    repository.records.set("record:p1", record("record:p1", {
      height: 1,
      room: "room:access:ab",
      terminalHandles: ["namespace:a", "namespace:b"],
      children: ["record:b"],
    }));
    const idempotencyKey = "sleep-dependency-loss:record:p1:2";
    const plan = publicationPlan({
      idempotencyKey,
      predecessorOnlyRecordRef: "record:p1",
      outputNamespace: "namespace:access:b",
      inputs: [
        plannedRecord({
          role: "changed",
          recordRef: "record:p1",
          namespaceRef: "namespace:access:ab",
          readBindingRef: "read:p1",
        }),
        plannedRecord({
          role: "candidate",
          recordRef: "record:b",
          namespaceRef: "namespace:b",
          readBindingRef: "read:b",
        }),
      ],
    });
    const result = await publisher(repository, undefined, {
      revalidate: () => Promise.resolve({
        status: "current",
        predecessorAudience: "different",
      }),
    }, {
      async read(recordRef) {
        return recordRef === "record:b-leaf"
          ? {
              originPublicationBindingRef: "read:b-leaf",
              currentAccessBindingRefs: ["read:b-leaf"],
              representationGeneration: 1,
              authorityProjectionGeneration: 1,
            }
          : null;
      },
    }).apply({
      proposal: {
        operation: "supersede_parent",
        parentRecordRef: "record:p1",
        statement: "Only B remains supported.",
        childRecordRefs: ["record:b"],
        sourceDependencies: [],
      },
      publicationPlan: plan,
      idempotencyKey,
      changedRecordRef: "record:p1",
      changeReason: "dependency_lost",
      budget,
    });

    expect(result).toMatchObject({ status: "applied", operation: "supersede_parent" });
    expect(repository.publications[0]).toMatchObject({
      predecessor: { recordRef: "record:p1", relation: "supersedes" },
      publicationBindingRef: "publish:namespace:access:b",
      record: { semantic: { childRecordRefs: ["record:b"] } },
    });
    expect(repository.reads).toContainEqual({
      recordRef: "record:b-leaf",
      readBindingRef: "read:b-leaf",
    });
  });

  test("publishes narrower P1+C as a higher parent while preserving P1", async () => {
    const repository = new FixtureRepository();
    repository.records.set("record:a", record("record:a", {
      room: "room:a",
      terminalHandle: "namespace:a",
    }));
    repository.records.set("record:b", record("record:b", {
      room: "room:b",
      terminalHandle: "namespace:b",
    }));
    repository.records.set("record:c", record("record:c", {
      room: "room:c",
      terminalHandle: "namespace:c",
    }));
    repository.records.set("record:p1", record("record:p1", {
      height: 1,
      room: "room:access:ab",
      terminalHandles: ["namespace:a", "namespace:b"],
      children: ["record:a", "record:b"],
    }));
    const idempotencyKey = "cross-room:extend:narrower:1";
    const plan = publicationPlan({
      idempotencyKey,
      outputNamespace: "namespace:access:narrower",
      inputs: [
        plannedRecord({
          role: "changed",
          recordRef: "record:p1",
          namespaceRef: "namespace:access:ab",
          readBindingRef: "read:p1",
        }),
        plannedRecord({
          role: "candidate",
          recordRef: "record:c",
          namespaceRef: "namespace:c",
          readBindingRef: "read:c",
        }),
      ],
    });
    const result = await publisher(repository, undefined, {
      revalidate: () => Promise.resolve({
        status: "current",
        predecessorAudience: "different",
      }),
    }).apply({
      proposal: {
        operation: "extend_parent",
        parentRecordRef: "record:p1",
        statement: "The narrower group relates P1 to C without replacing P1.",
        additionRecordRefs: ["record:c"],
        additionSourceDependencies: [],
      },
      publicationPlan: plan,
      idempotencyKey,
      changedRecordRef: "record:p1",
      changeReason: "created",
      budget,
    });

    expect(result).toMatchObject({ status: "applied", operation: "extend_parent" });
    expect(repository.publications).toHaveLength(1);
    expect(repository.publications[0]?.predecessor).toBeUndefined();
    expect(repository.publications[0]).toMatchObject({
      publicationBindingRef: "publish:namespace:access:narrower",
      record: {
        structuralHeight: 2,
        semantic: {
          childRecordRefs: ["record:c", "record:p1"],
          terminalAuthorityLeafHandles: ["namespace:a", "namespace:b", "namespace:c"],
        },
      },
    });
    expect(repository.records.get("record:p1")?.lifecycle).toBe("current");
    expect(repository.transitions).toHaveLength(0);
  });

  test("reschedules when predecessor authority changes after exact-source validation", async () => {
    const repository = new FixtureRepository();
    repository.records.set("record:a", record("record:a"));
    repository.records.set("record:b", record("record:b"));
    repository.records.set("record:c", record("record:c"));
    repository.records.set("record:p1", record("record:p1", {
      height: 1,
      children: ["record:a", "record:b"],
    }));
    const idempotencyKey = "cross-room:extend:authority-race:1";
    const plan = publicationPlan({
      idempotencyKey,
      inputs: [
        plannedRecord({
          role: "changed",
          recordRef: "record:p1",
          namespaceRef: "namespace:p1",
          readBindingRef: "read:p1",
        }),
        plannedRecord({
          role: "candidate",
          recordRef: "record:c",
          namespaceRef: "namespace:c",
          readBindingRef: "read:c",
        }),
      ],
    });
    let fenceCall = 0;
    const result = await publisher(repository, undefined, {
      revalidate: () => Promise.resolve({
        status: "current",
        predecessorAudience: ++fenceCall === 1 ? "equal" : "different",
      }),
    }).apply({
      proposal: {
        operation: "extend_parent",
        parentRecordRef: "record:p1",
        statement: "A conclusion whose authority changed during publication.",
        additionRecordRefs: ["record:c"],
        additionSourceDependencies: [],
      },
      publicationPlan: plan,
      idempotencyKey,
      changedRecordRef: "record:p1",
      changeReason: "created",
      budget,
    });

    expect(result).toEqual({
      status: "stale",
      failureDetail: "publication_authority_fence_stale",
    });
    expect(repository.publications).toHaveLength(0);
    expect(repository.transitions).toHaveLength(0);
  });

  test("opens selected authored support through its exact source binding", async () => {
    const repository = new FixtureRepository();
    repository.records.set("record:a", record("record:a", {
      room: "room:a",
      terminalHandle: "namespace:a",
    }));
    const sourceReads: string[] = [];
    const idempotencyKey = "cross-room:mixed:create:1";
    const plan = publicationPlan({
      idempotencyKey,
      inputs: [
        plannedRecord({
          role: "changed",
          recordRef: "record:a",
          namespaceRef: "namespace:a",
          readBindingRef: "read:a",
        }),
        {
          kind: "source",
          sourceKind: "memory",
          role: "candidate",
          logicalSourceRef: "memory:one",
          contentGeneration: 2,
          representationGeneration: 3,
          authorityGeneration: 4,
          read: { namespaceRef: "namespace:m", bindingRef: "read:memory" },
        },
      ],
    });
    const result = await publisher(
      repository,
      async (input) => {
        sourceReads.push(input.readBindingRef);
        return "current";
      },
      { revalidate: () => Promise.resolve({ status: "current" }) },
    ).apply({
      proposal: {
        operation: "create_parent",
        statement: "The Record and authored Memory support one conclusion.",
        childRecordRefs: ["record:a"],
        sourceDependencies: [{
          sourceKind: "memory/v1",
          logicalSourceRef: "memory:one",
          observedRevision: "2",
          terminalAuthorityLeafHandle: "namespace:m",
          authorityBearing: true,
        }],
      },
      publicationPlan: plan,
      idempotencyKey,
      changedRecordRef: "record:a",
      changeReason: "created",
      budget,
    });

    expect(result).toMatchObject({ status: "applied", operation: "create_parent" });
    expect(sourceReads).toEqual(["read:memory"]);
  });

  test("persists complete uncited Record and source exposure as authority provenance", async () => {
    const repository = new FixtureRepository();
    repository.records.set("record:a", record("record:a", {
      room: "room:a",
      terminalHandle: "namespace:a",
    }));
    repository.records.set("record:b", record("record:b", {
      room: "room:b",
      terminalHandle: "namespace:b",
    }));
    repository.records.set("record:c", record("record:c", {
      room: "room:c",
      terminalHandle: "namespace:c",
    }));
    const exposure = [
      {
        kind: "record",
        recordRef: "record:a",
        observedProcessingGeneration: 1,
        terminalAuthorityLeafHandles: ["namespace:a"],
      },
      {
        kind: "record",
        recordRef: "record:b",
        observedProcessingGeneration: 1,
        terminalAuthorityLeafHandles: ["namespace:b"],
      },
      {
        kind: "record",
        recordRef: "record:c",
        observedProcessingGeneration: 1,
        terminalAuthorityLeafHandles: ["namespace:c"],
      },
      {
        kind: "source",
        sourceKind: "memory",
        logicalSourceRef: "memory:uncited",
        observedRevision: "4",
        observedContentFingerprint: "sha256:memory-4",
        terminalAuthorityLeafHandle: "namespace:m",
      },
    ] as const satisfies readonly DurableModelExposureDependency[];
    const idempotencyKey = "cross-room:complete-exposure:1";
    const plan = publicationPlan({
      idempotencyKey,
      inputs: [
        plannedRecord({
          role: "changed",
          recordRef: "record:a",
          namespaceRef: "namespace:a",
          readBindingRef: "read:a",
        }),
        plannedRecord({
          role: "candidate",
          recordRef: "record:b",
          namespaceRef: "namespace:b",
          readBindingRef: "read:b",
        }),
        plannedRecord({
          role: "candidate",
          recordRef: "record:c",
          namespaceRef: "namespace:c",
          readBindingRef: "read:c",
        }),
        {
          kind: "source",
          sourceKind: "memory",
          role: "candidate",
          logicalSourceRef: "memory:uncited",
          contentGeneration: 4,
          representationGeneration: 3,
          authorityGeneration: 4,
          read: { namespaceRef: "namespace:m", bindingRef: "read:m" },
        },
      ],
      modelExposureDependencies: exposure,
    });
    const sourceValidations: unknown[] = [];
    const result = await publisher(
      repository,
      (input) => {
        sourceValidations.push(input);
        return Promise.resolve("current");
      },
      { revalidate: () => Promise.resolve({ status: "current" }) },
    ).apply({
      proposal: {
        operation: "create_parent",
        statement: "Only A and B are cited by the conclusion.",
        childRecordRefs: ["record:a", "record:b"],
        sourceDependencies: [],
      },
      publicationPlan: plan,
      idempotencyKey,
      changedRecordRef: "record:a",
      changeReason: "created",
      budget,
    });

    expect(result).toMatchObject({ status: "applied", operation: "create_parent" });
    expect(repository.publications).toHaveLength(1);
    const semantic = repository.publications[0]!.record.semantic;
    expect(semantic.modelExposureDependencies).toBe(exposure);
    expect(semantic.childRecordRefs).toEqual(["record:a", "record:b"]);
    expect(semantic.sourceDependencies).toEqual([]);
    expect(semantic.terminalAuthorityLeafHandles).toEqual([
      "namespace:a",
      "namespace:b",
      "namespace:c",
      "namespace:m",
    ]);
    expect(sourceValidations).toEqual([{
      dependency: {
        sourceKind: "memory",
        logicalSourceRef: "memory:uncited",
        observedRevision: "4",
        observedContentFingerprint: "sha256:memory-4",
        terminalAuthorityLeafHandle: "namespace:m",
        authorityBearing: true,
      },
      readBindingRef: "read:m",
    }]);

    const modifiedRepository = new FixtureRepository();
    for (const [recordRef, value] of repository.records) {
      if (!recordRef.startsWith("organizer-record:")) {
        modifiedRepository.records.set(recordRef, value);
      }
    }
    const modifiedExposure = exposure.map((dependency) =>
      dependency.kind === "source"
        ? {
            ...dependency,
            observedContentFingerprint: "sha256:memory-5",
          }
        : dependency
    );
    const modified = await publisher(
      modifiedRepository,
      () => Promise.resolve("current"),
      { revalidate: () => Promise.resolve({ status: "current" }) },
    ).apply({
      proposal: {
        operation: "create_parent",
        statement: "Only A and B are cited by the conclusion.",
        childRecordRefs: ["record:a", "record:b"],
        sourceDependencies: [],
      },
      publicationPlan: {
        ...plan,
        modelExposureDependencies: modifiedExposure,
      },
      idempotencyKey,
      changedRecordRef: "record:a",
      changeReason: "created",
      budget,
    });
    expect(modified).toMatchObject({ status: "applied" });
    expect(
      modifiedRepository.publications[0]!.record.semantic.observedContentFingerprint,
    ).not.toBe(semantic.observedContentFingerprint);
  });

  test("stale uncited exposure prevents publication and no-change completion", async () => {
    const repository = new FixtureRepository();
    repository.records.set("record:a", record("record:a", {
      room: "room:a",
      terminalHandle: "namespace:a",
    }));
    repository.records.set("record:b", record("record:b", {
      room: "room:b",
      terminalHandle: "namespace:b",
    }));
    repository.records.set("record:c", record("record:c", {
      room: "room:c",
      terminalHandle: "namespace:c",
    }));
    const idempotencyKey = "cross-room:stale-uncited-no-change:1";
    const plan = publicationPlan({
      idempotencyKey,
      inputs: [
        plannedRecord({
          role: "changed",
          recordRef: "record:a",
          namespaceRef: "namespace:a",
          readBindingRef: "read:a",
        }),
        plannedRecord({
          role: "candidate",
          recordRef: "record:b",
          namespaceRef: "namespace:b",
          readBindingRef: "read:b",
        }),
        plannedRecord({
          role: "candidate",
          recordRef: "record:c",
          namespaceRef: "namespace:c",
          readBindingRef: "read:c",
          processingGeneration: 2,
        }),
      ],
      modelExposureDependencies: [{
        kind: "record",
        recordRef: "record:a",
        observedProcessingGeneration: 1,
        terminalAuthorityLeafHandles: ["namespace:a"],
      }, {
        kind: "record",
        recordRef: "record:b",
        observedProcessingGeneration: 1,
        terminalAuthorityLeafHandles: ["namespace:b"],
      }, {
        kind: "record",
        recordRef: "record:c",
        observedProcessingGeneration: 2,
        terminalAuthorityLeafHandles: ["namespace:c"],
      }],
    });
    const apply = publisher(
      repository,
      undefined,
      { revalidate: () => Promise.resolve({ status: "current" }) },
    );

    expect(await apply.apply({
      proposal: {
        operation: "create_parent",
        statement: "A stale uncited exposure must block this publication.",
        childRecordRefs: ["record:a", "record:b"],
        sourceDependencies: [],
      },
      publicationPlan: plan,
      idempotencyKey,
      changedRecordRef: "record:a",
      changeReason: "created",
      budget,
    })).toEqual({
      status: "stale",
      failureDetail: "publication_authority_fence_stale",
    });
    expect(await apply.apply({
      proposal: { operation: "no_change" },
      publicationPlan: plan,
      idempotencyKey,
      changedRecordRef: "record:a",
      changeReason: "created",
      budget,
    })).toEqual({
      status: "stale",
      failureDetail: "publication_authority_fence_stale",
    });
    expect(repository.publications).toHaveLength(0);
    expect(repository.transitions).toHaveLength(0);
  });

  test("unavailable uncited source prevents an exposure-fenced lifecycle change", async () => {
    const repository = new FixtureRepository();
    repository.records.set("record:parent", record("record:parent", {
      room: "room:p",
      terminalHandle: "namespace:p",
    }));
    const idempotencyKey = "cross-room:source-wait-dissolve:1";
    const plan = publicationPlan({
      idempotencyKey,
      inputs: [
        plannedRecord({
          role: "changed",
          recordRef: "record:parent",
          namespaceRef: "namespace:p",
          readBindingRef: "read:p",
        }),
        {
          kind: "source",
          sourceKind: "memory",
          role: "candidate",
          logicalSourceRef: "memory:uncited",
          contentGeneration: 4,
          representationGeneration: 3,
          authorityGeneration: 4,
          read: { namespaceRef: "namespace:m", bindingRef: "read:m" },
        },
      ],
      modelExposureDependencies: [{
        kind: "record",
        recordRef: "record:parent",
        observedProcessingGeneration: 1,
        terminalAuthorityLeafHandles: ["namespace:p"],
      }, {
        kind: "source",
        sourceKind: "memory",
        logicalSourceRef: "memory:uncited",
        observedRevision: "4",
        observedContentFingerprint: "sha256:memory-4",
        terminalAuthorityLeafHandle: "namespace:m",
      }],
    });
    const result = await publisher(
      repository,
      () => Promise.resolve("unavailable"),
      { revalidate: () => Promise.resolve({ status: "current" }) },
    ).apply({
      proposal: { operation: "dissolve_parent", parentRecordRef: "record:parent" },
      publicationPlan: plan,
      idempotencyKey,
      changedRecordRef: "record:parent",
      changeReason: "dependency_lost",
      budget,
    });

    expect(result).toEqual({
      status: "unavailable",
      failureCode: "publication_unavailable",
      failureDetail: "publication_source_unavailable",
    });
    expect(repository.transitions).toHaveLength(0);
  });

  test("rejects a predecessor-only model input omitted from complete exposure", async () => {
    const repository = new FixtureRepository();
    repository.records.set("record:obsolete", record("record:obsolete", {
      room: "room:obsolete",
      terminalHandle: "namespace:obsolete",
    }));
    repository.records.set("record:remaining", record("record:remaining", {
      room: "room:remaining",
      terminalHandle: "namespace:remaining",
    }));
    const idempotencyKey = "cross-room:missing-predecessor-exposure:1";
    const plan = publicationPlan({
      idempotencyKey,
      predecessorOnlyRecordRef: "record:obsolete",
      inputs: [
        plannedRecord({
          role: "changed",
          recordRef: "record:obsolete",
          namespaceRef: "namespace:obsolete",
          readBindingRef: "read:obsolete",
        }),
        plannedRecord({
          role: "candidate",
          recordRef: "record:remaining",
          namespaceRef: "namespace:remaining",
          readBindingRef: "read:remaining",
        }),
      ],
      modelExposureDependencies: [{
        kind: "record",
        recordRef: "record:remaining",
        observedProcessingGeneration: 1,
        terminalAuthorityLeafHandles: ["namespace:remaining"],
      }],
    });

    expect(await publisher(
      repository,
      undefined,
      { revalidate: () => Promise.resolve({ status: "current" }) },
    ).apply({
      proposal: { operation: "no_change" },
      publicationPlan: plan,
      idempotencyKey,
      changedRecordRef: "record:obsolete",
      changeReason: "dependency_lost",
      budget,
    })).toEqual({
      status: "unavailable",
      failureCode: "publication_unavailable",
      failureDetail: "publication_plan_invalid",
    });
    expect(repository.reads).toHaveLength(0);
    expect(repository.transitions).toHaveLength(0);
  });

  test("rejects unplanned, inconsistent, and final-fence-raced cross-Room dependencies", async () => {
    const repository = new FixtureRepository();
    repository.records.set("record:a", record("record:a"));
    repository.records.set("record:b", record("record:b"));
    repository.records.set("record:c", record("record:c"));
    const inputs = [
      plannedRecord({
        role: "changed",
        recordRef: "record:a",
        namespaceRef: "namespace:a",
        readBindingRef: "read:a",
      }),
      plannedRecord({
        role: "candidate",
        recordRef: "record:b",
        namespaceRef: "namespace:b",
        readBindingRef: "read:b",
      }),
    ] as const;
    const base = {
      proposal: {
        operation: "create_parent" as const,
        statement: "Only the exact selected dependencies may publish.",
        childRecordRefs: ["record:a", "record:b"],
        sourceDependencies: [],
      },
      changedRecordRef: "record:a",
      changeReason: "created" as const,
      budget,
    };

    const unplannedKey = "cross-room:unplanned:1";
    const unplanned = await publisher(repository, undefined, {
      revalidate: () => Promise.resolve({ status: "current" }),
    }).apply({
      ...base,
      proposal: { ...base.proposal, childRecordRefs: ["record:a", "record:c"] },
      publicationPlan: publicationPlan({ idempotencyKey: unplannedKey, inputs }),
      idempotencyKey: unplannedKey,
    });
    expect(unplanned).toMatchObject({ status: "unavailable" });
    expect(repository.reads).toHaveLength(0);

    const staleKey = "cross-room:stale:1";
    const stale = await publisher(repository, undefined, {
      revalidate: () => Promise.resolve({ status: "current" }),
    }).apply({
      ...base,
      publicationPlan: publicationPlan({
        idempotencyKey: staleKey,
        inputs: [inputs[0], { ...inputs[1], processingGeneration: 2 }],
      }),
      idempotencyKey: staleKey,
    });
    expect(stale).toEqual({
      status: "stale",
      failureDetail: "publication_child_parent_changed",
    });

    const readsBeforeInitialFence = repository.reads.length;
    const initialFenceKey = "cross-room:initial-fence-race:1";
    const initialFenceRace = await publisher(repository, undefined, {
      revalidate: () => Promise.resolve({
        status: "stale",
        failureDetail: "publication_authority_fence_stale",
      }),
    }).apply({
      ...base,
      publicationPlan: publicationPlan({ idempotencyKey: initialFenceKey, inputs }),
      idempotencyKey: initialFenceKey,
    });
    expect(initialFenceRace).toEqual({
      status: "stale",
      failureDetail: "publication_authority_fence_stale",
    });
    expect(repository.reads).toHaveLength(readsBeforeInitialFence);

    let fenceCall = 0;
    const racedKey = "cross-room:fence-race:1";
    const raced = await publisher(repository, undefined, {
      revalidate: () => Promise.resolve(
        ++fenceCall === 1
          ? { status: "current" }
          : {
              status: "stale",
              failureDetail: "publication_authority_fence_stale",
            },
      ),
    }).apply({
      ...base,
      publicationPlan: publicationPlan({ idempotencyKey: racedKey, inputs }),
      idempotencyKey: racedKey,
    });
    expect(raced).toEqual({
      status: "stale",
      failureDetail: "publication_authority_fence_stale",
    });
    expect(repository.publications).toHaveLength(0);
  });

  test("keeps identity commitments keyed, purpose-separated, and bounded", () => {
    expect(() => createHmacOrganizerPublicationIdentityPort(new Uint8Array(31)))
      .toThrow(/at least 32 bytes/);
    const identity = createHmacOrganizerPublicationIdentityPort(new Uint8Array(32).fill(7));
    const bytes = new TextEncoder().encode("same input");
    const one = identity.commit({ purpose: "record_identity", canonicalBytes: bytes });
    const replay = identity.commit({ purpose: "record_identity", canonicalBytes: bytes });
    const otherPurpose = identity.commit({
      purpose: "content_fingerprint",
      canonicalBytes: bytes,
    });
    expect(one).toBe(replay);
    expect(one).not.toBe(otherPurpose);
    expect(one).not.toContain("same input");
    expect(() => identity.commit({
      purpose: "record_identity",
      canonicalBytes: new Uint8Array(ORGANIZER_PUBLICATION_COMMITMENT_MAX_BYTES + 1),
    })).toThrow(/out of bounds/);
  });
});
