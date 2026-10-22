import { isDeepStrictEqual } from "node:util";
import { reconstructProtectedTaskMetadataV1 } from "@nautilo/types";
import { CodexAuthorityService, type CodexBindingMutationPort, type CodexRelaySessionAuthorityPort } from "../codex/authority";
import { CodexCanonicalFactsService, type CodexCanonicalFactsReader } from "../codex/canonical-facts";
import { assertCodexExecutionAdmission } from "../codex/execution-admission";
import { isCodexHarnessExecutionMetadata, type CodexTaskExecutionRouteDeps } from "../codex/harness-admission";
import type { CodexHarnessExecution } from "../codex/harness-execution";
import { codexRequestScopePartitionIdentity, type CodexRequestBroker,
  type CodexRequestSourcePartition } from "../codex/request-broker";
import { codexCapabilityModelId, createCodexModelOutputContract } from "../codex/model-output-contract";
import { parseProtectedTaskCodexSelection, sameProtectedTaskCodexSelection, type ProtectedTaskCodexSelection } from "./protected-task-codex-selection";
import { createProtectedTaskExternalExecution, type ProtectedTaskExternalExecutionFactory, type ProtectedTaskExternalExecutionDependencies,
  type ProtectedTaskExternalProvider } from "./protected-task-external-execution";
import type { ProductionProtectedTaskNativeExecutionInput } from "./protected-task-native-execution-composition";
import type { createProtectedTaskExternalRequests } from "./protected-task-external-requests";

export type ProtectedTaskCodexProviderInput = Pick<CodexTaskExecutionRouteDeps,
  "preferences" | "preflight" | "models" | "limits" | "admissionFactory"> & Readonly<{
  canonicalReader: CodexCanonicalFactsReader;
  sessions: CodexRelaySessionAuthorityPort;
  mutations: CodexBindingMutationPort;
  execution: Pick<CodexHarnessExecution, "start" | "respond">;
  requestBroker: Pick<CodexRequestBroker, "hasLiveRequest">;
  requestPartition: Pick<CodexRequestSourcePartition, "protect">;
  now?: () => number;
}>;
type Profile = NonNullable<Awaited<ReturnType<ProtectedTaskCodexProviderInput["preferences"]["getProfile"]>>>;
type PublicAdmission = Readonly<{
  selection: ProtectedTaskCodexSelection;
  profile: Profile;
  posture: Awaited<ReturnType<ProtectedTaskCodexProviderInput["preferences"]["getOwnerPreference"]>>["defaultPosture"];
  selectedModel: string;
  outputContract: ReturnType<typeof createCodexModelOutputContract>;
  session: NonNullable<ReturnType<CodexRelaySessionAuthorityPort["getCodexSession"]>>;
}>;

/** Only provider admission lives here; shared Task owners retain plaintext and grant custody. */
export function createProtectedTaskCodexProvider(input: ProtectedTaskCodexProviderInput):
ProtectedTaskExternalProvider<ProtectedTaskCodexSelection, PublicAdmission> {
  const now = () => new Date((input.now ?? Date.now)());
  const issued = new WeakMap<PublicAdmission, PublicAdmission>();
  const profileAuthority = new CodexAuthorityService(
    new CodexCanonicalFactsService(input.canonicalReader), input.sessions, input.mutations, now,
  );
  const admit = async (ownerId: string, supplied: ProtectedTaskCodexSelection): Promise<PublicAdmission | null> => {
    const selection = parseProtectedTaskCodexSelection(supplied);
    if (selection === null) return null;
    try {
      const preference = await input.preferences.getOwnerPreference(ownerId);
      if (!preference.enabled || preference.accountProfileId === null) return null;
      const profile = await input.preferences.getProfile(ownerId, preference.accountProfileId);
      if (!profile || profile.id !== preference.accountProfileId || profile.userId !== ownerId
        || profile.authState !== "signed_in" || profile.removalState !== "active"
        || profile.relayId !== selection.execution.readiness.relayId) return null;
      await input.preflight.prepare(profile);
      const catalog = await input.models.list(profile);
      const selectedModel = catalog.models.find(model => model.id === selection.execution.harnessModelId);
      if (!selectedModel) return null;
      const contract = createCodexModelOutputContract(selectedModel.model,
        await input.limits.resolve(codexCapabilityModelId(selectedModel.model)));
      if (selection.execution.outputContract !== undefined
        && selection.execution.outputContract.capabilityModelId !== contract.capabilityModelId) return null;
      const readiness = profileAuthority.checkProfileReadiness(profile, selection.execution.collaborationMode);
      if (readiness.relayId !== selection.execution.readiness.relayId
        || readiness.pairingGenerationRef !== selection.execution.readiness.pairingGenerationRef) return null;
      const session = input.sessions.getCodexSession(profile.relayId, ownerId);
      if (session === null) return null;
      const admitted = Object.freeze({ selection, profile: Object.freeze({ ...profile }),
        posture: preference.defaultPosture, selectedModel: selectedModel.model, outputContract: contract,
        session: structuredClone(session) });
      issued.set(admitted, structuredClone(admitted));
      return admitted;
    } catch { return null; }
  };
  return {
    matchesCurrentSelection: (current, selection) => sameProtectedTaskCodexSelection(current.codexExecutionSelection, selection),
    admit,
    sameAdmission: (left, right) => isDeepStrictEqual(left, right),
    start: async ({ occurrence, reference, jobId, signal, assertCurrent, admission, payload }) => {
      const original = issued.get(admission);
      issued.delete(admission);
      if (!original || !isDeepStrictEqual(original, admission)) throw new TypeError("Protected Codex admission changed");
      signal.throwIfAborted();
      await assertCurrent();
      if (occurrence.task.ownerId !== occurrence.task.requestorId
        || occurrence.run.jobId !== jobId || occurrence.task.callingRoomId === null
        || reference.taskId !== occurrence.task.id || reference.taskRunId !== occurrence.run.id
        || reference.inputObjectId !== occurrence.task.cryptoObjectId) {
        throw new TypeError("Protected Codex occurrence changed");
      }
      const restored = reconstructProtectedTaskMetadataV1(admission.selection, payload.protectedMetadata);
      if (restored.status !== "supported" || !isCodexHarnessExecutionMetadata(restored.metadata)) {
        throw new TypeError("Protected Codex execution content is unsupported");
      }
      const execution = restored.metadata["execution"];
      if (execution === null || typeof execution !== "object" || Array.isArray(execution)) {
        throw new TypeError("Protected Codex execution content is unsupported");
      }
      const directory = (execution as Readonly<Record<string, unknown>>)["workingDirectory"];
      const workingDirectory = typeof directory === "string" ? directory : null;
      const facts = { taskId: occurrence.task.id, taskRunId: occurrence.run.id,
        ownerId: occurrence.task.ownerId, requestorId: occurrence.task.requestorId,
        agentId: occurrence.task.agentId, roomId: occurrence.task.callingRoomId,
        graphThreadId: occurrence.run.graphThreadId, laneKey: `task:${occurrence.task.id}`, parentTaskId: null };
      const authority = new CodexAuthorityService(new CodexCanonicalFactsService({
        ...input.canonicalReader,
        getJob: async id => {
          const job = await input.canonicalReader.getJob(id);
          return job !== null && isDeepStrictEqual(job.input, reference) ? job : null;
        },
      }, {
        assertProtectedJobBinding: async binding => {
          await assertCurrent();
          const matches = isDeepStrictEqual(binding.job.input, reference)
            && binding.task.id === facts.taskId && binding.task.ownerId === facts.ownerId
            && binding.task.requestorId === facts.requestorId && binding.task.agentId === facts.agentId
            && binding.task.parentTaskId === null && binding.task.targetRoomId === facts.roomId
            && binding.run.id === facts.taskRunId && binding.run.taskId === facts.taskId
            && binding.run.jobId === jobId && binding.run.graphThreadId === facts.graphThreadId
            && binding.job.id === jobId && binding.job.roomId === facts.roomId
            && binding.job.laneKey === facts.laneKey;
          await assertCurrent();
          return matches;
        },
      }), input.sessions, input.mutations, now);
      const scopeRequest = { actorId: facts.ownerId, agentId: facts.agentId, taskId: facts.taskId,
        taskRunId: facts.taskRunId, jobId, roomId: facts.roomId, profileId: admission.profile.id,
        laneKey: facts.laneKey, posture: admission.posture,
        collaborationMode: admission.selection.execution.collaborationMode };
      const scope = await authority.deriveScope(scopeRequest);
      const fresh = await admit(facts.ownerId, admission.selection);
      if (fresh === null || !isDeepStrictEqual(fresh, admission)) {
        throw new TypeError("Protected Codex provider authority changed");
      }
      const genuine = await input.admissionFactory.create({ facts, scope, jobId, prompt: payload.prompt,
        selectedModel: admission.selectedModel, outputContract: admission.outputContract,
        collaborationMode: admission.selection.execution.collaborationMode, workingDirectory, signal });
      assertCodexExecutionAdmission(genuine);
      if (genuine.taskId !== facts.taskId || genuine.taskRunId !== facts.taskRunId || genuine.jobId !== jobId
        || genuine.ownerId !== facts.ownerId || genuine.requesterId !== facts.requestorId
        || genuine.roomId !== facts.roomId || genuine.laneKey !== facts.laneKey || genuine.parentTaskId !== null
        || genuine.source !== "room" || genuine.prompt !== payload.prompt || genuine.abortSignal !== signal
        || !isDeepStrictEqual(genuine.codex, { scope, selectedModel: admission.selectedModel,
          outputContract: admission.outputContract, collaborationMode: admission.selection.execution.collaborationMode,
          workingDirectory, bindingKind: "task" })) {
        throw new TypeError("Protected Codex execution admission was substituted");
      }
      const assertProvider = async () => {
        signal.throwIfAborted();
        await assertCurrent();
        if (!isDeepStrictEqual(scope, await authority.deriveScope(scopeRequest))) {
          throw new TypeError("Protected Codex current provider authority changed");
        }
        signal.throwIfAborted();
      };
      return {
        attribution: { taskId: facts.taskId, roomId: facts.roomId,
          bindingId: genuine.binding.id, bindingGeneration: genuine.binding.generation },
        outputs: (async function* () {
          const protectedRequests = input.requestPartition.protect(codexRequestScopePartitionIdentity({
            relayId: genuine.codex.scope.relayId,
            bindingId: genuine.binding.id,
            bindingGeneration: genuine.binding.generation,
            taskId: genuine.taskId,
            jobId: genuine.jobId,
          }));
          try {
            // Install the exact partition before the first provider await so a
            // request emitted synchronously during start is already private.
            await assertProvider();
            for await (const output of input.execution.start(genuine)) {
              await assertProvider();
              yield output;
            }
          } finally {
            protectedRequests.close();
          }
        })(),
        hasLiveRequest: (requestId, ownerId) => input.requestBroker.hasLiveRequest(requestId, ownerId),
        respond: async (response, invocation, options) => {
          options?.signal?.throwIfAborted();
          await assertProvider();
          options?.signal?.throwIfAborted();
          await input.execution.respond(response, invocation);
          await assertProvider();
          options?.signal?.throwIfAborted();
        },
      };
    },
  };
}

export function createProtectedTaskCodexExecution(input: ProductionProtectedTaskNativeExecutionInput
  & ProtectedTaskCodexProviderInput & Readonly<{
    requests: Pick<ReturnType<typeof createProtectedTaskExternalRequests>, "register">;
  }>, overrides: Partial<ProtectedTaskExternalExecutionDependencies> = {}): ProtectedTaskExternalExecutionFactory<ProtectedTaskCodexSelection> {
  return createProtectedTaskExternalExecution({ ...input, provider: createProtectedTaskCodexProvider(input) }, overrides);
}
