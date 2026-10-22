import { AIMessage } from "@langchain/core/messages";
import { isDeepStrictEqual } from "node:util";
import {
  createProtectedTaskTranscriptPort,
  createProtectedTaskFailurePayload,
  ProtectedTaskExecutionDidNotBeginError,
  assertProtectedTaskJobReferenceV1,
  type HarnessExecutionOutput,
  type HarnessRequestResponse,
  type ProtectedTaskRunningOccurrence,
  type ProtectedTaskPredispatchPlan,
  type ProtectedTaskJobReferenceV1,
  type TaskRuntimeGrantClaimPlan,
} from "@nautilo/runtime";
import {
  assertAuthenticTaskRuntimeExecutionEvidence,
} from "@nautilo/lattice-crypto";
import {
  decodeTaskRuntimeBackgroundAuthorizationRequestBase,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import {
  createPostgresForegroundAgentAcceptedExecutionEvidenceResolver,
  verifyCryptoPostgresHandle,
  withNativeProtectedTaskDefinitionV1,
} from "@nautilo/lattice-bridge/server";
import type { TaskPayloadV1, TaskRunResultPayloadV1 } from "@nautilo/lattice-bridge";
import type { AcceptedInvocationAuthority } from "@nautilo/trust";
import { CodexRoomOutputProjector } from "../codex/room-output";
import { createHumanProductTransactionContext } from "./human-message-product-store";
import {
  withCurrentProtectedTaskMemoryAuthority,
  type ProtectedTaskMemoryAuthorityInput,
} from "./current-protected-task-memory-authority";
import { createCurrentProtectedTaskRuntimeAuthorityPort, type HeldProtectedTaskRuntimeAuthority } from "./task-runtime-current-authority";
import { createCurrentNativeProtectedTaskDefinitionOccurrenceLoader } from "./protected-task-native-definition-occurrence";
import { createProtectedTaskNativeTranscriptPublisher } from "./protected-task-native-transcript-composition";
import { waitForProtectedTaskExternalOperation } from "./protected-task-external-operation";
import { withProtectedTaskRuntimeSigner } from "./protected-task-runtime-signer";
import { createProtectedTaskDefinitionForegroundAuthorizationResolver } from
  "./protected-task-runtime-access-lineage";

import type { ProductionProtectedTaskNativeExecutionInput } from "./protected-task-native-execution-composition";
import type { ProtectedTaskRuntimeGrantPlanBuilderDependencies } from "./protected-task-runtime-grant-plan";
import type { createProtectedTaskExternalRequests } from "./protected-task-external-requests";

export type ProtectedTaskExternalExecutionFactory<Selection> =
  (selection: Selection) => ProtectedTaskRuntimeGrantPlanBuilderDependencies["prepareExecution"];
type Publication = Readonly<{
  publish(payload: TaskRunResultPayloadV1): Promise<void>;
}>;

export type ProtectedTaskExternalExecutionDependencies = Readonly<{
  product: typeof createHumanProductTransactionContext;
  currentAuthority: ReturnType<typeof createCurrentProtectedTaskRuntimeAuthorityPort>;
  definition: typeof withNativeProtectedTaskDefinitionV1;
  memoryAuthority: typeof withCurrentProtectedTaskMemoryAuthority;
  signer: typeof withProtectedTaskRuntimeSigner;
  transcript: typeof createProtectedTaskNativeTranscriptPublisher;
}>;

const transientSlot = "protectedTaskExternalExecution";
const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function publicationFrom(input: Record<string, unknown>): Publication {
  const value = input["protectedTaskResultPublication"];
  if (value === null || typeof value !== "object"
    || typeof Reflect.get(value, "publish") !== "function") {
    throw new TypeError("Protected external Task result publication is unavailable");
  }
  return value as Publication;
}

/**
 * Execute the selected provider with one current Task grant. Provider effects
 * have no checkpoint representation here: losing a started stream leaves the
 * existing Runtime recovery owner to record an unknown outcome, never replay it.
 */
export type ProtectedTaskExternalExecutionContext = Readonly<{
  occurrence: ProtectedTaskRunningOccurrence;
  predispatch?: ProtectedTaskPredispatchPlan;
  reference: ProtectedTaskJobReferenceV1;
  jobId: string;
  signal: AbortSignal;
  assertCurrent(): Promise<void>;
}>;
export type ProtectedTaskExternalProviderSession = Readonly<{
  attribution: Readonly<{ taskId: string; roomId: string; bindingId: string; bindingGeneration: string }>;
  outputs: AsyncIterable<HarnessExecutionOutput>;
  hasLiveRequest(requestId: string, ownerId: string): boolean;
  respond(response: HarnessRequestResponse, authority: AcceptedInvocationAuthority,
    options?: Readonly<{ signal?: AbortSignal }>): Promise<void>;
}>;
export type ProtectedTaskExternalProvider<Selection, Admission> = Readonly<{
  matchesCurrentSelection(current: HeldProtectedTaskRuntimeAuthority, selection: Selection): boolean;
  admit(ownerId: string, selection: Selection): Promise<Admission | null>;
  sameAdmission(left: Admission, right: Admission): boolean;
  start(input: ProtectedTaskExternalExecutionContext & Readonly<{
    admission: Admission; payload: TaskPayloadV1;
  }>): ProtectedTaskExternalProviderSession | Promise<ProtectedTaskExternalProviderSession>;
}>;

export function createProtectedTaskExternalExecution<Selection extends object, Admission>(
  input: ProductionProtectedTaskNativeExecutionInput & Readonly<{
    provider: ProtectedTaskExternalProvider<Selection, Admission>;
    requests: Pick<ReturnType<typeof createProtectedTaskExternalRequests>, "register">;
  }>, overrides: Partial<ProtectedTaskExternalExecutionDependencies> = {},
): ProtectedTaskExternalExecutionFactory<Selection> {
  const dependencies: ProtectedTaskExternalExecutionDependencies = {
    product: createHumanProductTransactionContext,
    currentAuthority: createCurrentProtectedTaskRuntimeAuthorityPort(),
    definition: withNativeProtectedTaskDefinitionV1,
    memoryAuthority: withCurrentProtectedTaskMemoryAuthority,
    signer: withProtectedTaskRuntimeSigner,
    transcript: createProtectedTaskNativeTranscriptPublisher,
    ...overrides,
  };
  const now = input.now ?? Date.now;
  return suppliedSelection => {
    const selection = Object.freeze(structuredClone(suppliedSelection));
    const loadDefinition = createCurrentNativeProtectedTaskDefinitionOccurrenceLoader({
      withCurrentAuthority: operation => dependencies.currentAuthority({
        ...operation,
        use: current => {
          if (!input.provider.matchesCurrentSelection(current, selection)) {
            throw new TypeError("Protected external Task execution selection changed");
          }
          return operation.use(current);
        },
      }),
    });
    return async preparation => {
      const occurrence = structuredClone(preparation.occurrence);
      const reference = Object.freeze({ ...preparation.reference });
      const predispatch = preparation.predispatch;
      const policy = Object.freeze({ ...preparation.policy });
      assertProtectedTaskJobReferenceV1(reference);
      if (preparation.humanResume !== undefined || preparation.checkpointResume !== undefined
        || preparation.additionalAuthorityResume !== undefined || preparation.checkpointAadBinding !== undefined
        || reference.executionSegment !== 1 || occurrence.task.ownerId !== occurrence.task.requestorId
        || occurrence.task.callingRoomId === null
        || reference.taskId !== occurrence.task.id || reference.taskRunId !== occurrence.run.id
        || reference.inputObjectId !== occurrence.task.cryptoObjectId
        || predispatch.occurrence.task.id !== occurrence.task.id
        || predispatch.occurrence.run.id !== occurrence.run.id) {
        throw new TypeError("Protected external Task occurrence is unsupported");
      }
      const product = await dependencies.product(occurrence.task.requestorId, input.db);
      const transcriptPublisher = dependencies.transcript({ product });
      const issuedTokens = new WeakSet<object>();
      const timeLimit = new AbortController();
      const requestCheckpointPause: NonNullable<TaskRuntimeGrantClaimPlan["requestCheckpointPause"]> =
        (reason, requestId) => {
          // External providers have no portable checkpoint. Manual Pause keeps
          // waiting for their natural settlement, while the watchdog's hard
          // deadline ends the same signal-bound provider custody used for
          // cancellation and grant expiry.
          if (reason !== "time_limit" || typeof requestId !== "string"
            || !canonicalUuid.test(requestId) || timeLimit.signal.aborted) return false;
          timeLimit.abort(new Error("Protected Task time limit reached"));
          return true;
        };
      const openTransientInput: TaskRuntimeGrantClaimPlan["openTransientInput"] = async grant => {
        assertAuthenticTaskRuntimeExecutionEvidence(grant.evidence);
        assertProtectedTaskJobReferenceV1(grant.reference);
        const running = grant.occurrence;
        if (!isDeepStrictEqual(grant.reference, reference)
          || running.task.id !== occurrence.task.id || running.run.id !== occurrence.run.id
          || running.task.cryptoObjectId !== reference.inputObjectId
          || running.task.contentRevision !== occurrence.task.contentRevision
          || running.run.status !== "running" || running.run.jobId === null
          || grant.record.snapshot.state !== "claimed"
          || grant.record.snapshot.workId !== running.run.id
          || grant.record.snapshot.requestId !== reference.authorizationRequestId
          || grant.evidence.workId !== running.run.id
          || grant.evidence.requestId !== reference.authorizationRequestId
          || grant.evidence.policyRevision !== policy.revision
          || grant.evidence.result.objectId !== reference.resultObjectId
          || now() >= grant.evidence.expiresAt
          || grant.record.descriptorBytes === null) {
          throw new TypeError("Protected external Task grant identity changed");
        }
        const authorizationSignal = AbortSignal.any([grant.signal, timeLimit.signal]);
        authorizationSignal.throwIfAborted();
        const accepted = grant.record.snapshot.acceptedResponse;
        if (accepted?.kind !== "runtime") throw new TypeError("Protected external Task requester authority is unavailable");
        const beforeStart = await waitForProtectedTaskExternalOperation(authorizationSignal,
          input.provider.admit(running.task.requestorId, selection));
        if (beforeStart === null) {
          throw new ProtectedTaskExecutionDidNotBeginError();
        }
        let used = false;
        const token = Object.freeze({
          async run(transient: Record<string, unknown>, jobId: string, signal: AbortSignal) {
            if (used || transient[transientSlot] !== token || jobId !== running.run.jobId) {
              throw new TypeError("Protected external Task execution custody was reused or substituted");
            }
            used = true;
            const providerLifetime = new AbortController();
            const combined = AbortSignal.any([authorizationSignal, signal, providerLifetime.signal]);
            const request = decodeTaskRuntimeBackgroundAuthorizationRequestBase(
              input.crypto,
              grant.record.descriptorBytes!,
            );
            if (request === null || request.requestId !== reference.authorizationRequestId
              || request.workId !== running.run.id || request.sourceRoomId !== grant.evidence.sourceRoomId) {
              if (request !== null) destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
              throw new TypeError("Protected external Task request identity changed");
            }
            const current: ProtectedTaskMemoryAuthorityInput = {
              runner: product.canonicalRunner, restricted: input.restricted, crypto: input.crypto,
              serverScope: input.serverScope,
              subject: { userId: running.task.requestorId, humanActorId: accepted.issuingHumanId,
                deviceId: accepted.issuingDeviceId },
              occurrence: running, record: grant.record, request, evidence: grant.evidence,
              jobId, executionRoomId: predispatch.scheduling.roomId, reference, now, signal: combined,
              ...(preparation.scopeMemory === undefined ? {} : {
                scopeMemory: { binding: preparation.scopeMemory, targetRoomId: predispatch.target.roomId,
                  workIdentity: preparation.scopeWorkIdentity! },
              }),
            };
            const assertCurrent = async () => {
              combined.throwIfAborted();
              if (now() >= grant.evidence.expiresAt) throw new TypeError("Protected external Task authorization expired");
              const held = await dependencies.memoryAuthority(current, async authority => {
                await authority.assertCurrent();
                return isDeepStrictEqual(authority.policy, policy);
              });
              if (held !== true || await loadDefinition(current) === null) {
                throw new TypeError("Protected external Task execution authority changed");
              }
              combined.throwIfAborted();
            };
            const pending = new Map<string, { close(): void }>();
            try {
              const publication = publicationFrom(transient);
              await assertCurrent();
              const opened = await dependencies.definition({
                restricted: input.restricted, crypto: input.crypto, serverScope: input.serverScope,
                evidence: grant.evidence, domains: grant.domains, signal: combined,
                loadCurrentOccurrence: () => loadDefinition(current),
                resolveForegroundAgentAcceptedExecutionEvidence: principal =>
                  createPostgresForegroundAgentAcceptedExecutionEvidenceResolver({
                    product: product.handle, crypto: input.crypto, rejectInvalidSelectedEvidence: true,
                  })(principal),
                resolveTaskDefinitionForegroundAuthorization: async evidence => {
                  const resolver = await createProtectedTaskDefinitionForegroundAuthorizationResolver({
                    product, handle: await verifyCryptoPostgresHandle(input.restricted),
                    crypto: input.crypto, requesterHumanId: accepted.issuingHumanId,
                    task: running.task,
                  });
                  return resolver === null ? null : resolver(evidence);
                },
                execute: async payload => {
                  const admitted = await waitForProtectedTaskExternalOperation(combined, input.provider.admit(running.task.requestorId, selection));
                  if (admitted === null || !input.provider.sameAdmission(admitted, beforeStart)) {
                    return Object.freeze({ status: "provider_not_invoked" as const });
                  }
                  await assertCurrent();
                  const result = await dependencies.signer({ restricted: input.restricted, crypto: input.crypto,
                    evidence: grant.evidence, domains: grant.domains,
                    use: async (signer, history) => {
                      const identity = { taskId: running.task.id, taskRunId: running.run.id,
                        graphThreadId: running.run.graphThreadId, roomId: predispatch.scheduling.roomId,
                        humanTurnId: running.run.id, agentId: running.task.agentId };
                      const publish = await transcriptPublisher({ occurrence: running, record: grant.record,
                        request, current, policy, humanTurnId: running.run.id,
                        assertCurrentTaskAuthority: assertCurrent, domains: grant.domains, signer,
                        resolveHistoricalSignerPublicationManager: history });
                      const transcript = createProtectedTaskTranscriptPort({ identity, signal: combined, publish });
                      // Only question outputs use this projector. Its ordinary progress
                      // path writes ordinary transcripts and is deliberately never called.
                      const projector = new CodexRoomOutputProjector({ requestMode: "ephemeral" });
                      let candidate: Extract<HarnessExecutionOutput, { kind: "assistant_completed" }> | null = null;
                      const outcome = await (async () => {
                        const provider = await waitForProtectedTaskExternalOperation(combined, Promise.resolve(input.provider.start({
                          occurrence: running, predispatch, reference, jobId, signal: combined, assertCurrent,
                          admission: admitted, payload,
                        })));
                        await assertCurrent();
                        if (provider.attribution.taskId !== running.task.id
                          || provider.attribution.roomId !== running.task.callingRoomId) {
                          throw new TypeError("Protected external provider attribution changed");
                        }
                        for await (const output of provider.outputs) {
                          await assertCurrent();
                          if (output.attribution.taskId !== running.task.id
                            || output.attribution.bindingId !== provider.attribution.bindingId
                            || output.attribution.bindingGeneration !== provider.attribution.bindingGeneration
                            || output.attribution.roomId !== running.task.callingRoomId) {
                            throw new TypeError("Protected external Task provider output identity changed");
                          }
                          for (const [id, value] of pending) {
                            if (!provider.hasLiveRequest(id, running.task.requestorId)) {
                              value.close(); pending.delete(id);
                            }
                          }
                          if (output.kind === "assistant_completed") {
                            if (candidate !== null) throw new TypeError("Protected external Task result was repeated");
                            candidate = output;
                          } else if (output.kind === "terminal") {
                            if (output.status !== "completed" || candidate === null) {
                              // No success/known failure is invented from a disconnected
                              // or interrupted stream. The Runtime retains its exact claim.
                              throw new TypeError("Protected external Task provider outcome is unavailable");
                            }
                            await transcript.publishBatch({ ...identity, messages: [new AIMessage(candidate.text)] });
                            return Object.freeze({ formatVersion: 1 as const, resultText: candidate.text, lastError: null });
                          } else if (output.kind === "permission_selection_required" || output.kind === "user_input_required"
                            || output.kind === "command_approval_required" || output.kind === "network_approval_required"
                            || output.kind === "file_change_approval_required" || output.kind === "permissions_approval_required") {
                            const event = await projector.project(output, { jobId, laneKey: `task:${running.task.id}`,
                              facts: { taskId: running.task.id, taskRunId: running.run.id,
                                ownerId: running.task.ownerId, requestorId: running.task.requestorId,
                                agentId: running.task.agentId, roomId: running.task.callingRoomId,
                                graphThreadId: running.run.graphThreadId, laneKey: `task:${running.task.id}`,
                                parentTaskId: null } });
                            if (event?.type !== "codex.request") throw new TypeError("Protected external Task question is unavailable");
                            const registered = await input.requests.register({
                              identity: { taskId: running.task.id, taskRunId: running.run.id, jobId,
                                sourceRoomId: request.sourceRoomId, namespaceId: running.task.contentNamespaceId,
                                requestorId: running.task.requestorId, humanActorId: accepted.issuingHumanId,
                                agentId: running.task.agentId, roomId: running.task.callingRoomId, requestId: output.requestId },
                              deadlineAt: grant.evidence.expiresAt, signal: combined,
                              assertCurrentExecutionAuthority: assertCurrent,
                              read: () => Promise.resolve(provider.hasLiveRequest(output.requestId, running.task.requestorId) ? event : null),
                              respond: (response, authority, options) => provider.respond(response, authority, options),
                            });
                            if (registered === null) throw new TypeError("Protected external Task question could not be admitted");
                            pending.set(output.requestId, registered);
                          } else if (output.kind !== "progress" && output.kind !== "output_delta"
                            && output.kind !== "command_summary" && output.kind !== "patch_summary" && output.kind !== "usage") {
                            throw new TypeError("Protected external Task output is unsupported");
                          }
                        }
                        throw new TypeError("Protected external Task provider stream ended without settlement");
                      })().then(
                        value => ({ status: "fulfilled", value } as const),
                        (error: unknown) => ({ status: "rejected", error } as const),
                      );
                      const settled = await transcript.quiesce();
                      if (settled.failedPublicationCount !== 0) throw new TypeError("Protected external Task transcript did not settle");
                      if (outcome.status === "rejected") throw outcome.error;
                      return outcome.value;
                    },
                  });
                  return Object.freeze({ status: "completed" as const, result });
                },
              });
              await assertCurrent();
              await publication.publish(opened.status === "provider_not_invoked"
                ? createProtectedTaskFailurePayload()
                : opened.result);
            } finally {
              providerLifetime.abort(new Error("Protected Task provider custody ended"));
              for (const value of pending.values()) value.close();
              pending.clear();
              destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
            }
          },
        });
        issuedTokens.add(token);
        return { [transientSlot]: token };
      };
      const executor: TaskRuntimeGrantClaimPlan["executor"] = async function* (transient, jobId, laneKey, signal) {
        const token = transient[transientSlot];
        if (laneKey !== `task:${occurrence.task.id}` || token === null || typeof token !== "object"
          || !issuedTokens.has(token)) {
          throw new TypeError("Protected external Task execution input changed");
        }
        issuedTokens.delete(token);
        await (token as { run(input: Record<string, unknown>, jobId: string, signal: AbortSignal): Promise<void> }).run(transient, jobId, signal);
        yield* [];
      };
      return Object.freeze({ executor, openTransientInput, requestCheckpointPause,
        modelAttribution: "external" as const });
    };
  };
}
