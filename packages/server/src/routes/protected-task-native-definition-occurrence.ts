import {
  deriveTaskContentCryptoObjectIdV1,
} from "@nautilo/lattice-bridge";
import type {
  NativeProtectedTaskDefinitionOccurrenceV1,
} from "@nautilo/lattice-bridge/server";

import {
  createCurrentProtectedTaskRuntimeAuthorityPort,
  type CurrentProtectedTaskRuntimeAuthorityPort,
} from "./task-runtime-current-authority";
import type { ProtectedTaskRunningOccurrence } from "@nautilo/runtime";

export type LoadCurrentNativeProtectedTaskDefinitionOccurrenceInput = Readonly<
  Omit<
    Parameters<CurrentProtectedTaskRuntimeAuthorityPort>[0],
    "occurrence" | "use"
  > & Readonly<{ occurrence: ProtectedTaskRunningOccurrence }>
>;

type Dependencies = Readonly<{
  withCurrentAuthority: CurrentProtectedTaskRuntimeAuthorityPort;
}>;

type Options = Readonly<{
  requireNativeExecution?: true;
}>;

const productionDependencies: Dependencies = Object.freeze({
  withCurrentAuthority: createCurrentProtectedTaskRuntimeAuthorityPort(),
});

function hasExactDefinitionCoordinates(
  input: LoadCurrentNativeProtectedTaskDefinitionOccurrenceInput,
): boolean {
  const { occurrence, record, request } = input;
  return (record.snapshot.state === "claimed"
      || record.snapshot.state === "running")
    && occurrence.run.status === "running"
    && typeof occurrence.run.jobId === "string"
    && occurrence.run.jobId.length > 0
    && occurrence.run.taskId === occurrence.task.id
    && occurrence.task.contentRevision >= 1
    && occurrence.task.cryptoAccessRevision === 0
    && occurrence.task.cryptoRequiredNamespaceFingerprint.length === 32
    && occurrence.task.cryptoObjectId === deriveTaskContentCryptoObjectIdV1({
      kind: "definition",
      taskId: occurrence.task.id,
      contentRevision: occurrence.task.contentRevision,
    })
    && record.snapshot.workId === occurrence.run.id
    && request.workId === occurrence.run.id
    && request.sourceRoomId.length > 0;
}

/**
 * Builds the native definition opener's scalar occurrence from the accepted
 * execution authority. The durable grant is still claimed while its already
 * running TaskRun opens input; later rechecks may observe it as running. The
 * shared authority owner proves the current running TaskRun in either phase,
 * then releases its short product/crypto transactions before this adapter
 * returns. Neither a secret nor model work is carried through this boundary.
 */
export function createCurrentNativeProtectedTaskDefinitionOccurrenceLoader(
  dependencies: Partial<Dependencies> = {},
  options: Options = {},
): (
  input: LoadCurrentNativeProtectedTaskDefinitionOccurrenceInput,
) => Promise<NativeProtectedTaskDefinitionOccurrenceV1 | null> {
  const withCurrentAuthority = dependencies.withCurrentAuthority
    ?? productionDependencies.withCurrentAuthority;

  return async input => {
    if (!hasExactDefinitionCoordinates(input)) return null;
    const { occurrence, request } = input;
    return withCurrentAuthority({
      ...input,
      use: current => {
        if (options.requireNativeExecution === true
          && current.nativeExecutionSupported !== true) return null;
        const matching = current.namespaceRequirements.filter(requirement =>
          requirement.namespaceId === occurrence.task.contentNamespaceId
        );
        const durableMatching = input.record.authoritySet.namespaceRequirements
          .filter(requirement =>
            requirement.namespaceId === occurrence.task.contentNamespaceId
          );
        const definition = matching[0];
        const durableDefinition = durableMatching[0];
        if (
          matching.length !== 1
          || durableMatching.length !== 1
          || definition === undefined
          || durableDefinition === undefined
          || definition.domainId !== durableDefinition.domainId
          || definition.expectedAccessRevision
            !== durableDefinition.expectedAccessRevision
          || definition.expectedAccessRevision
            !== input.record.expectedNamespaceAccessRevision
          || definition.expectedPolicyRevision
            !== current.foreground.policyRevision
          || definition.expectedPolicyRevision
            !== durableDefinition.expectedPolicyRevision
          || definition.expectedPolicyRevision
            !== input.record.expectedPolicyRevision
          || definition.operations.length !== 2
          || definition.operations[0] !== "decrypt"
          || definition.operations[1] !== "encrypt"
          || durableDefinition.operations.length !== 2
          || durableDefinition.operations[0] !== "decrypt"
          || durableDefinition.operations[1] !== "encrypt"
          || current.foreground.roomId !== request.sourceRoomId
          || current.foreground.subjectHumanId !== input.subject.humanActorId
        ) return null;
        return Object.freeze({
          taskId: occurrence.task.id,
          taskRunId: occurrence.run.id,
          sourceRoomId: request.sourceRoomId,
          agentId: occurrence.task.agentId,
          requesterHumanId: current.foreground.subjectHumanId,
          objectId: occurrence.task.cryptoObjectId,
          contentRevision: occurrence.task.contentRevision,
          cryptoAccessRevision: 0,
          namespaceId: definition.namespaceId,
          domainId: definition.domainId,
          expectedAccessRevision: definition.expectedAccessRevision,
          expectedPolicyRevision: definition.expectedPolicyRevision,
        });
      },
    });
  };
}
