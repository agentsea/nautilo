import type {
  AnchorRef,
  RecordLifecycle,
  RecordSnapshot,
  SyntheticAccessAudience,
  SyntheticEligibleRecord,
} from "../contracts/hierarchy";

const FIXTURE_RECORD_STATEMENT_MAX_CODE_POINTS = 800;

export interface MemoryFixtureInput {
  readonly recordRef: string;
  readonly logicalMemoryRef: string;
  readonly observedRevision?: string;
  readonly contentFingerprint: string;
  readonly statement: string;
  readonly memoryType: string;
  readonly importance?: number;
  readonly lifecycle: RecordLifecycle;
  readonly anchors?: readonly AnchorRef[];
  readonly attachmentAudiences: readonly SyntheticAccessAudience[];
  readonly initialPublicationScope: SyntheticAccessAudience;
}

export interface MemoryFixtureProjection {
  readonly eligibleRecord: SyntheticEligibleRecord;
  readonly compatibility: {
    readonly memoryType: string;
    readonly importance?: number;
    readonly attachmentCount: number;
  };
}

export interface JournalEventFixtureInput {
  readonly recordRef: string;
  /** The effective M219 event identity, not a Journal rollup identity. */
  readonly logicalEventRef: string;
  readonly observedRevision?: string;
  readonly contentFingerprint: string;
  readonly statement: string;
  readonly eventKind: string;
  readonly lifecycle: RecordLifecycle;
  readonly anchors?: readonly AnchorRef[];
  readonly audience: SyntheticAccessAudience;
  readonly initialPublicationScope: SyntheticAccessAudience;
}

function codePoints(value: string): number {
  return Array.from(value).length;
}

function requireBoundedText(label: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new TypeError(`${label} must not be empty`);
  if (codePoints(trimmed) > FIXTURE_RECORD_STATEMENT_MAX_CODE_POINTS) {
    throw new RangeError(
      `${label} exceeds ${FIXTURE_RECORD_STATEMENT_MAX_CODE_POINTS} Unicode code points`,
    );
  }
  return trimmed;
}

function requireOpaqueRef(label: string, value: string): string {
  if (value.trim().length === 0) throw new TypeError(`${label} must not be empty`);
  return value;
}

function normalizeAudience(audience: SyntheticAccessAudience): SyntheticAccessAudience {
  if (audience.kind !== "access") throw new TypeError("fixture audience must use kind=access");
  const humans = [...new Set(audience.humanRefs)];
  if (humans.length !== audience.humanRefs.length || humans.some((ref) => ref.length === 0)) {
    throw new TypeError("fixture audience must contain unique non-empty Human references");
  }
  return { kind: "access", humanRefs: humans.sort((left, right) => left.localeCompare(right)) };
}

function unionAudiences(
  audiences: readonly SyntheticAccessAudience[],
): SyntheticAccessAudience {
  if (audiences.length === 0) {
    throw new TypeError("authored Memory fixture needs at least one Namespace attachment");
  }
  return {
    kind: "access",
    humanRefs: [...new Set(audiences.flatMap((audience) => normalizeAudience(audience).humanRefs))]
      .sort((left, right) => left.localeCompare(right)),
  };
}

function commonSnapshot(input: {
  recordRef: string;
  logicalObjectRef: string;
  observedRevision?: string;
  contentFingerprint: string;
  statement: string;
  posture: "authored" | "derived";
  sourceOwnedKind: string;
  lifecycle: RecordLifecycle;
  anchors?: readonly AnchorRef[];
}): RecordSnapshot {
  return {
    recordRef: requireOpaqueRef("recordRef", input.recordRef),
    observedLogicalObjectRef: requireOpaqueRef(
      "observed logical object reference",
      input.logicalObjectRef,
    ),
    ...(input.observedRevision === undefined
      ? {}
      : { observedRevision: requireOpaqueRef("observed revision", input.observedRevision) }),
    observedContentFingerprint: requireOpaqueRef(
      "content fingerprint",
      input.contentFingerprint,
    ),
    posture: input.posture,
    anchors: [...new Set(input.anchors ?? [])],
    statement: requireBoundedText("statement", input.statement),
    sourceRefs: [],
    childRecordRefs: [],
    structuralHeight: 0,
    lifecycle: input.lifecycle,
    sourceOwnedKind: input.sourceOwnedKind,
  };
}

/** Adapt an authored logical Memory without turning it into a derived Record. */
export function adaptMemoryFixture(input: MemoryFixtureInput): MemoryFixtureProjection {
  const audience = unionAudiences(input.attachmentAudiences);
  return {
    eligibleRecord: {
      snapshot: commonSnapshot({
        recordRef: input.recordRef,
        logicalObjectRef: input.logicalMemoryRef,
        contentFingerprint: input.contentFingerprint,
        statement: input.statement,
        posture: "authored",
        sourceOwnedKind: `memory:${requireOpaqueRef("memory type", input.memoryType)}`,
        lifecycle: input.lifecycle,
        ...(input.observedRevision === undefined
          ? {}
          : { observedRevision: input.observedRevision }),
        ...(input.anchors === undefined ? {} : { anchors: input.anchors }),
      }),
      audience,
      initialPublicationScope: normalizeAudience(input.initialPublicationScope),
    },
    compatibility: {
      memoryType: input.memoryType,
      ...(input.importance === undefined ? {} : { importance: input.importance }),
      attachmentCount: input.attachmentAudiences.length,
    },
  };
}

/** Adapt one effective Journal event; presentation rollups are intentionally absent. */
export function adaptJournalEventFixture(
  input: JournalEventFixtureInput,
): SyntheticEligibleRecord {
  return {
    snapshot: commonSnapshot({
      recordRef: input.recordRef,
      logicalObjectRef: input.logicalEventRef,
      contentFingerprint: input.contentFingerprint,
      statement: input.statement,
      posture: "derived",
      sourceOwnedKind: `journal_event:${requireOpaqueRef("event kind", input.eventKind)}`,
      lifecycle: input.lifecycle,
      ...(input.observedRevision === undefined
        ? {}
        : { observedRevision: input.observedRevision }),
      ...(input.anchors === undefined ? {} : { anchors: input.anchors }),
    }),
    audience: normalizeAudience(input.audience),
    initialPublicationScope: normalizeAudience(input.initialPublicationScope),
  };
}
