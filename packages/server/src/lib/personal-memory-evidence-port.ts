import {
  MODEL_INPUT_EXPOSURE_METADATA_KEY,
  bindModelInputExposure,
  bindModelInputExposureFromAuthorizedPersistedPayload,
  readModelInputExposure,
} from "@nautilo/agent";
import {
  findReflectionEnabledHumanOwnersWith,
  findReflectionLegacyJournalEventSourceWith,
  findReflectionMemoryNamespaceIdsWith,
  findReflectionMemorySourceWith,
  findReflectionMessageSourceWith,
  findReflectionProfileSoulSourceWith,
  findReflectionRollupSourceWith,
  type DirectDatabase,
} from "@nautilo/db";
import type { DurableModelExposureDependency } from "@nautilo/reflection/durable";
import {
  stenographerJournalEventObservationFingerprint,
  stenographerJournalRollupObservationFingerprint,
  type MemorySourceDerivation,
  type PersonalMemoryEvidencePort,
  type RecordRepositorySelection,
} from "@nautilo/reflection-bridge/server";
import {
  reflectionMessageSourceFingerprint,
  type OrdinarySourceFingerprintPort,
  type ProfileSoulFingerprintInput,
} from "@nautilo/runtime";
import {
  findRoomByNamespaceId,
  getRoomWithAccess,
} from "@nautilo/trust";

type SourceDependency = Extract<
  DurableModelExposureDependency,
  { kind: "source" }
>;

type CurrentRoomAccess = Readonly<{
  namespaceId: string;
  humanActorIds: readonly string[];
  isPublicNamespaceBoundary: boolean;
  externalContext?: boolean;
}>;

type Audience = Readonly<{
  roomId: string;
  namespaceId: string;
  humanIds: readonly string[];
  includesPublicBoundary: boolean;
}>;

export interface PersonalMemoryEvidencePortOptions {
  readonly db: DirectDatabase;
  readonly selected: () => RecordRepositorySelection;
  readonly fingerprints?: Pick<OrdinarySourceFingerprintPort, "memory">;
  readonly fingerprintProfileSoul: (input: ProfileSoulFingerprintInput) => string;
  readonly readRecord: PersonalMemoryEvidencePort["readRecord"];
  readonly openProtectedSource?: (
    dependency: SourceDependency,
  ) => Promise<MemorySourceDerivation | null>;
  readonly roomQueries?: Readonly<{
    findRoomByNamespaceId(
      namespaceId: string,
    ): Promise<Readonly<{ roomId: string }> | null>;
    getRoomWithAccess(roomId: string): Promise<CurrentRoomAccess | null>;
  }>;
}

const MESSAGE_REF = /^message:([1-9][0-9]*)$/u;
const SOUL_REF = /^agent-soul:([0-9a-f-]+)$/iu;
const ROLLUP_REF = /^journal-rollup:([0-9a-f-]+)$/iu;
const JOURNAL_EVENT_REF = /^journal-event:([0-9a-f-]+)$/iu;
const MEMORY_REF = /^memory:([0-9a-f-]+)$/iu;
const INVALID_EXPOSURE = Symbol("invalid_exposure");

function exactFields(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const fields = [...expected].sort();
  return actual.length === fields.length
    && actual.every((field, index) => field === fields[index]);
}

function isStrictStoredDependency(
  value: unknown,
): value is DurableModelExposureDependency {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) return false;
  const record = value as Record<string, unknown>;
  if (record["kind"] === "record") {
    return exactFields(record, [
      "kind",
      "recordRef",
      "observedProcessingGeneration",
      "terminalAuthorityLeafHandles",
    ]);
  }
  if (record["kind"] !== "source") return false;
  return exactFields(record, [
    "kind",
    "sourceKind",
    "logicalSourceRef",
    ...(Object.hasOwn(record, "observedRevision")
      ? ["observedRevision"]
      : []),
    ...(Object.hasOwn(record, "observedContentFingerprint")
      ? ["observedContentFingerprint"]
      : []),
    "terminalAuthorityLeafHandle",
  ]);
}

function normalizeStoredExposure(
  value: unknown,
): readonly DurableModelExposureDependency[] | undefined
  | typeof INVALID_EXPOSURE {
  if (value === null || value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(isStrictStoredDependency)) {
    return INVALID_EXPOSURE;
  }
  try {
    const carrier = bindModelInputExposure({}, {
      status: "complete",
      dependencies: value,
    });
    const exposure = readModelInputExposure(carrier);
    return exposure?.status === "complete"
      ? exposure.dependencies
      : INVALID_EXPOSURE;
  } catch {
    return INVALID_EXPOSURE;
  }
}

function exactObservedSource(
  dependency: SourceDependency,
  revision: string,
  fingerprint: string,
): boolean {
  return dependency.observedRevision === revision
    && dependency.observedContentFingerprint === fingerprint;
}

function sourceResult(
  audience: Audience,
  evidence:
    | Readonly<{ kind: "human"; authorHumanId: string }>
    | Readonly<{
        kind: "derived";
        modelExposureDependencies: readonly DurableModelExposureDependency[];
      }>
    | Readonly<{ kind: "unknown" }>,
): MemorySourceDerivation {
  return Object.freeze({
    status: "current" as const,
    audienceHumanIds: audience.humanIds,
    includesPublicBoundary: audience.includesPublicBoundary,
    ...evidence,
  });
}

/**
 * Adapt exact current product sources to the representation-neutral personal
 * Memory proof. The caller owns the selected Record repository and protected
 * source opener; this adapter never falls back across representations.
 */
export function createPersonalMemoryEvidencePort(
  options: PersonalMemoryEvidencePortOptions,
): PersonalMemoryEvidencePort {
  const roomQueries = options.roomQueries ?? {
    findRoomByNamespaceId,
    getRoomWithAccess,
  };

  const readAudience = async (namespaceId: string): Promise<Audience | null> => {
    const room = await roomQueries.findRoomByNamespaceId(namespaceId);
    if (room === null) return null;
    const access = await roomQueries.getRoomWithAccess(room.roomId);
    if (access === null || access.namespaceId !== namespaceId) return null;
    const humanIds = await findReflectionEnabledHumanOwnersWith(
      options.db,
      access.humanActorIds,
    );
    if (humanIds === null) return null;
    return Object.freeze({
      roomId: room.roomId,
      namespaceId,
      humanIds,
      includesPublicBoundary:
        access.isPublicNamespaceBoundary || access.externalContext === true,
    });
  };

  const readOrdinarySource = async (
    dependency: SourceDependency,
  ): Promise<MemorySourceDerivation | null> => {
    const audience = await readAudience(
      dependency.terminalAuthorityLeafHandle,
    );
    if (audience === null) return null;

    if (dependency.sourceKind === "message") {
      const match = MESSAGE_REF.exec(dependency.logicalSourceRef);
      const messageId = match === null ? Number.NaN : Number(match[1]);
      if (!Number.isSafeInteger(messageId)) return null;
      const row = await findReflectionMessageSourceWith(
        options.db,
        messageId,
        audience.roomId,
        audience.namespaceId,
      );
      if (
        row === null
        || row.content === null
        || row.sourceUserDisabledAt !== null
        || !exactObservedSource(
          dependency,
          String(row.editRevision),
          reflectionMessageSourceFingerprint({
            id: row.id,
            editRevision: row.editRevision,
            content: row.content,
          }),
        )
      ) return null;
      if (row.role === "user" && row.externalAuthorship === false) {
        return sourceResult(audience, {
          kind: "human",
          authorHumanId: row.sourceUserId,
        });
      }
      if (
        (row.role === "assistant" || row.role === "tool")
        && row.externalAuthorship === false
      ) {
        if (row.agentId === null) {
          return sourceResult(audience, { kind: "unknown" });
        }
        const carrier = {};
        const persisted = row.metadata?.[MODEL_INPUT_EXPOSURE_METADATA_KEY];
        if (
          !bindModelInputExposureFromAuthorizedPersistedPayload(
            carrier,
            persisted,
          )
        ) return sourceResult(audience, { kind: "unknown" });
        const exposure = readModelInputExposure(carrier);
        return exposure?.status === "complete"
          && exposure.dependencies.length > 0
          ? sourceResult(audience, {
              kind: "derived",
              modelExposureDependencies: exposure.dependencies,
            })
          : sourceResult(audience, { kind: "unknown" });
      }
      return sourceResult(audience, { kind: "unknown" });
    }

    if (dependency.sourceKind === "profile_soul") {
      const match = SOUL_REF.exec(dependency.logicalSourceRef);
      if (match === null) return null;
      const row = await findReflectionProfileSoulSourceWith(
        options.db,
        match[1]!,
      );
      if (
        row === null
        || row.disabledAt !== null
        || row.soulFile === null
        || !exactObservedSource(
          dependency,
          String(row.soulRevision),
          options.fingerprintProfileSoul({
            agentId: row.agentId,
            profileId: row.profileId,
            userId: row.userId,
            soulRevision: row.soulRevision,
            soulFile: row.soulFile,
          }),
        )
      ) return null;
      return sourceResult(audience, {
        kind: "human",
        authorHumanId: row.userId,
      });
    }

    if (dependency.sourceKind === "journal_rollup") {
      const match = ROLLUP_REF.exec(dependency.logicalSourceRef);
      if (match === null) return null;
      const row = await findReflectionRollupSourceWith(
        options.db,
        match[1]!,
        audience.roomId,
        audience.namespaceId,
      );
      if (row === null || row.content === null) return null;
      const ancestry = normalizeStoredExposure(
        row.modelExposureDependencies,
      );
      if (ancestry === INVALID_EXPOSURE) return null;
      if (!exactObservedSource(
        dependency,
        `through:${row.throughEventSequence}:version:${row.compactorVersion}`,
        stenographerJournalRollupObservationFingerprint({
          rollupId: row.id,
          throughEventSequence: row.throughEventSequence,
          content: row.content,
          compactorVersion: row.compactorVersion,
          ...(ancestry === undefined
            ? {}
            : { modelExposureDependencies: ancestry }),
        }),
      )) return null;
      return ancestry === undefined
        ? sourceResult(audience, { kind: "unknown" })
        : sourceResult(audience, {
            kind: "derived",
            modelExposureDependencies: ancestry,
          });
    }

    if (dependency.sourceKind === "journal_event") {
      const match = JOURNAL_EVENT_REF.exec(dependency.logicalSourceRef);
      if (match === null) return null;
      const row = await findReflectionLegacyJournalEventSourceWith(
        options.db,
        match[1]!,
        audience.roomId,
        audience.namespaceId,
      );
      if (
        row === null
        || row.statement === null
        || !exactObservedSource(
          dependency,
          `sequence:${row.sequence}:status:${row.status}`,
          stenographerJournalEventObservationFingerprint({
            eventId: row.id,
            sequence: row.sequence,
            kind: row.kind,
            statement: row.statement,
            status: row.status,
          }),
        )
      ) return null;
      return sourceResult(audience, { kind: "unknown" });
    }

    if (dependency.sourceKind === "memory") {
      const match = MEMORY_REF.exec(dependency.logicalSourceRef);
      if (match === null) return null;
      const row = await findReflectionMemorySourceWith(
        options.db,
        match[1]!,
        audience.namespaceId,
      );
      if (
        row === null
        || row.content === null
        || row.type === null
        || row.contentRevision < 1
        || options.fingerprints === undefined
        || !exactObservedSource(
          dependency,
          String(row.contentRevision),
          options.fingerprints.memory({
            id: row.id,
            type: row.type,
            content: row.content,
            contentRevision: row.contentRevision,
          }),
        )
      ) return null;
      const currentNamespaceIds = await findReflectionMemoryNamespaceIdsWith(
        options.db,
        row.id,
      );
      if (
        currentNamespaceIds === null
        || currentNamespaceIds.length === 0
        || !currentNamespaceIds.includes(audience.namespaceId)
      ) return null;
      const audiences = [audience];
      for (const namespaceId of currentNamespaceIds) {
        if (namespaceId === audience.namespaceId) continue;
        const current = await readAudience(namespaceId);
        if (current === null) return null;
        audiences.push(current);
      }
      const currentAudience = {
        roomId: audience.roomId,
        namespaceId: audience.namespaceId,
        humanIds: [...new Set(audiences.flatMap((value) => value.humanIds))]
          .sort(),
        includesPublicBoundary: audiences.some((value) =>
          value.includesPublicBoundary
        ),
      };
      const ancestry = normalizeStoredExposure(
        row.modelExposureDependencies,
      );
      if (ancestry === INVALID_EXPOSURE) return null;
      return ancestry === undefined
        ? sourceResult(currentAudience, { kind: "unknown" })
        : sourceResult(currentAudience, {
            kind: "derived",
            modelExposureDependencies: ancestry,
          });
    }

    return null;
  };

  const result: PersonalMemoryEvidencePort = {
    readRecord: options.readRecord,
    async readSource(dependency: SourceDependency) {
      const selection = options.selected();
      return selection.selectedRepresentation === "ordinary"
        ? readOrdinarySource(dependency)
        : options.openProtectedSource?.(dependency) ?? null;
    },
    async readAudience(terminalAuthorityLeafHandle: string) {
      const resolved = await readAudience(terminalAuthorityLeafHandle);
      return resolved === null
        ? null
        : {
            humanIds: resolved.humanIds,
            includesPublicBoundary: resolved.includesPublicBoundary,
          };
    },
  };
  return Object.freeze(result);
}
