import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, actors, eq, roomMembers, rooms } from "@nautilo/db";
import { HERMES_ACP_READINESS_TIMEOUT_MS, OPENCODE_ACP_EXECUTION_START_TIMEOUT_MS, type HarnessExecutionOutput } from "@nautilo/runtime";
import type { AcpExecutionScope, AcpProcessScope, RelayAcpSemanticEvent, RelayAcpTerminalEvent } from "@nautilo/relay";
import { parseHermesAcpExecutionMetadata, type HermesAcpTaskExecutionDeps, type HermesAcpSession } from "../acp/task-execution";
import type { ProductionProtectedTaskNativeExecutionInput } from "./protected-task-native-execution-composition";
import type { ProtectedTaskExternalProvider } from "./protected-task-external-execution";
import { waitForProtectedTaskExternalOperation } from "./protected-task-external-operation";
import type { ProtectedTaskHermesSelection } from "./protected-task-hermes-selection";
import type { ProtectedTaskOpenCodeSelection } from "./protected-task-opencode-selection";
import { parseOpenCodeAcpExecutionMetadata, type OpenCodeAcpTaskExecutionDeps } from "../acp/opencode-task-execution";
import type { HeldProtectedTaskRuntimeAuthority } from "./task-runtime-current-authority";

type Selection = ProtectedTaskHermesSelection | ProtectedTaskOpenCodeSelection;
type Input = Pick<ProductionProtectedTaskNativeExecutionInput, "db"> & Readonly<{ mintId?: () => string }> & (
  | Readonly<{ registrationId: "hermes-acp"; relay: HermesAcpTaskExecutionDeps["relay"] }>
  | Readonly<{ registrationId: "opencode-acp"; relay: OpenCodeAcpTaskExecutionDeps["relay"] }>
);

/** Shared transient custody for the two existing autonomous ACP transports. */
export function createProtectedTaskAcpProvider<S extends Selection>(input: Input,
  matchesCurrentSelection: (current: HeldProtectedTaskRuntimeAuthority, selection: S) => boolean,
): ProtectedTaskExternalProvider<S, HermesAcpSession> {
  const registrationId = input.registrationId;
  const providerName = registrationId === "hermes-acp" ? "Hermes" : "OpenCode";
  const getSession = (relayId: string, ownerId: string) => input.registrationId === "hermes-acp"
    ? input.relay.getAcpSession(relayId, ownerId)
    : input.relay.getAcpSessionForRegistration(relayId, ownerId, "opencode-acp");
  const mint = input.mintId ?? randomUUID;
  return {
    matchesCurrentSelection,
    admit: async (ownerId, selection) => {
      if (selection.execution.harnessId !== registrationId
        || (selection.execution.harnessId === "opencode-acp" && selection.execution.executionProfile !== "autonomous")) return null;
      const receipt = selection.execution.readiness;
      const connected = await input.relay.listConnected();
      if (!connected.includes(receipt.relayId)) return null;
      const session = getSession(receipt.relayId, ownerId);
      if (session === null || session.userId !== ownerId || session.relayId !== receipt.relayId
        || session.pairingGenerationRef !== receipt.pairingGenerationRef) return null;
      const { userId: _owner, ...socket } = session;
      // Connection generations may refresh before effects; re-pairing never does.
      // The owning parser still requires this provider's complete compatible socket.
      const current = { execution: { ...selection.execution, readiness: socket } };
      if ((registrationId === "hermes-acp" ? parseHermesAcpExecutionMetadata(current)
        : parseOpenCodeAcpExecutionMetadata(current)) === null) return null;
      return Object.freeze({ ...session });
    },
    sameAdmission: (left, right) => isDeepStrictEqual(left, right),
    start: async ({ occurrence, jobId, signal, assertCurrent, admission, payload }) => {
      signal.throwIfAborted();
      if (Object.keys(payload.protectedMetadata).length !== 0 || occurrence.task.callingRoomId === null) {
        throw new TypeError(`Protected ${providerName} definition is unsupported`);
      }
      const task = occurrence.task;
      const roomId = task.callingRoomId!;
      const assertIdentity = async () => {
        const [room, owner, member] = await Promise.all([
        input.db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId)).limit(1),
        input.db.select({ ownerId: actors.ownerId }).from(actors).where(and(eq(actors.agentId, task.agentId), eq(actors.kind, "agent"))).limit(1),
        input.db.select({ actorId: roomMembers.actorId }).from(roomMembers).innerJoin(actors, eq(actors.id, roomMembers.actorId))
          .where(and(eq(roomMembers.roomId, roomId), eq(actors.agentId, task.agentId), eq(actors.kind, "agent"))).limit(1),
      ]);
        if (room.length !== 1 || owner.length !== 1 || owner[0]!.ownerId !== task.ownerId || member.length !== 1) {
          throw new TypeError(`Protected ${providerName} execution identity changed`);
      }
      };
      const fence = async () => {
        signal.throwIfAborted();
        if (!isDeepStrictEqual(getSession(admission.relayId, task.ownerId), admission)) {
          throw new TypeError(`Protected ${providerName} provider admission changed`);
        }
        await assertCurrent();
        await assertIdentity();
        await assertCurrent();
        if (!isDeepStrictEqual(getSession(admission.relayId, task.ownerId), admission)) {
          throw new TypeError(`Protected ${providerName} provider admission changed`);
        }
        signal.throwIfAborted();
      };
      await fence();
      const ready = await waitForProtectedTaskExternalOperation(signal, input.registrationId === "hermes-acp"
        ? input.relay.requestAcpReadiness({ relayId: admission.relayId, userId: task.ownerId,
          requestId: mint(), registrationId: "hermes-acp", timeoutMs: HERMES_ACP_READINESS_TIMEOUT_MS })
        : input.relay.requestAcpReadiness({ relayId: admission.relayId, userId: task.ownerId,
          requestId: mint(), registrationId: "opencode-acp" }));
      if (ready !== "ready") throw new TypeError(`Protected ${providerName} provider is unavailable`);
      await fence();
      const binding = Object.freeze({ bindingId: mint(), bindingGeneration: mint(), ownerId: task.ownerId,
        taskId: task.id, taskRunId: occurrence.run.id, jobId,
        profileId: mint(), profileGeneration: mint(), postureId: mint(), postureGeneration: mint() });
      const workspace = Object.freeze(structuredClone(await waitForProtectedTaskExternalOperation(signal, input.registrationId === "hermes-acp" ? input.relay.requestAcpPrepare({
        relayId: admission.relayId, userId: task.ownerId, requestId: mint(), binding,
        // Preserve the existing provider transport's preparation budget.
        timeoutMs: 5_000,
      }) : input.relay.requestAcpPrepare({ relayId: admission.relayId, userId: task.ownerId,
        requestId: mint(), binding, registrationId: "opencode-acp", timeoutMs: 5_000,
      }))));
      await fence();
      const { userId: _owner, ...socket } = admission;
      const scope: AcpExecutionScope = Object.freeze({ socket: Object.freeze(socket), binding, workspace });
      let process: AcpProcessScope | null = null;
      let contained = false;
      const contain = () => {
        if (process !== null && !contained) {
          contained = true;
          try {
            if (input.registrationId === "hermes-acp") input.relay.containAcpExecution(scope, process);
            else input.relay.containAcpExecution(scope, process, "opencode-acp");
          } catch { /* Actual containment is not assumed. */ }
        }
      };
      const starting = input.registrationId === "hermes-acp"
        ? input.relay.requestAcpStart({ relayId: admission.relayId, userId: task.ownerId,
          scope, prompt: payload.prompt, timeoutMs: 15_000 })
        : input.relay.requestAcpStart({ relayId: admission.relayId, userId: task.ownerId,
          scope, prompt: payload.prompt, registrationId: "opencode-acp", executionProfile: "autonomous",
          timeoutMs: OPENCODE_ACP_EXECUTION_START_TIMEOUT_MS });
      // A late host receipt still owns an exact process that must be contained.
      void starting.then(value => {
        if (value.registrationId === registrationId && isDeepStrictEqual(value.scope, scope)) { process = Object.freeze(structuredClone(value.process)); if (signal.aborted) contain(); }
      }, () => undefined);
      const started = await waitForProtectedTaskExternalOperation(signal, starting);
      if (started.registrationId !== registrationId || !isDeepStrictEqual(started.scope, scope) || started.capabilities.requests !== "unsupported") {
        contain(); throw new TypeError(`Protected ${providerName} provider receipt changed`);
      }
      process = Object.freeze(structuredClone(started.process));
      try { await fence(); } catch (error) { contain(); throw error; }
      const subscription = input.registrationId === "hermes-acp"
        ? input.relay.subscribeAcpExecution(scope, process)
        : input.relay.subscribeAcpExecution(scope, process, "opencode-acp");
      if (subscription === null) { contain(); throw new TypeError(`Protected ${providerName} stream is unavailable`); }
      let completed = false;
      let closed = false;
      const close = () => {
        if (!closed) {
          closed = true;
          try { subscription.close(); } catch { /* Teardown cannot suppress exact containment. */ }
        }
      };
      const onAbort = () => { close(); if (!completed) contain(); };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      const attribution = Object.freeze({ taskId: task.id, roomId,
        bindingId: binding.bindingId, bindingGeneration: binding.bindingGeneration,
        vendorSessionId: process.acpSessionId, vendorTurnId: process.turnRef, vendorItemId: null });
      const outputs: AsyncIterable<HarnessExecutionOutput> = {
        async *[Symbol.asyncIterator]() {
          try {
            await fence();
            for (;;) {
              const event: RelayAcpSemanticEvent | RelayAcpTerminalEvent | null =
                await waitForProtectedTaskExternalOperation(signal, subscription.next());
              await fence();
              if (event === null || event.registrationId !== registrationId || !isDeepStrictEqual(event.scope, scope) || !isDeepStrictEqual(event.process, process)) {
                throw new TypeError(`Protected ${providerName} stream identity changed`);
              }
              if (event.type === "relay:acp-semantic") {
                if (event.capabilities.requests !== "unsupported") throw new TypeError(`Protected ${providerName} requests are unsupported`);
                if (event.payload.kind === "runtime_status") {
                  if (registrationId !== "opencode-acp" || (event.payload.state !== "healthy" && event.payload.state !== "possibly_stalled")) {
                    throw new TypeError(`Protected ${providerName} semantic output is unsupported`);
                  }
                  yield { kind: "progress", attribution, message: event.payload.state === "healthy"
                    ? "OpenCode activity resumed" : "OpenCode is awaiting activity" };
                } else yield { ...event.payload, attribution };
                await fence();
                subscription.acknowledge(event.eventId, event.eventSequence);
              } else {
                completed = event.status === "completed";
                subscription.acknowledge(event.eventId, event.eventSequence);
                yield { kind: "terminal", status: event.status, attribution,
                  ...(event.code === undefined ? {} : { code: event.code }) };
                return;
              }
            }
          } finally {
            signal.removeEventListener("abort", onAbort);
            close();
            if (!completed) contain();
          }
        },
      };
      return { attribution, outputs,
        hasLiveRequest: () => false,
        respond: () => Promise.reject(new TypeError(`Protected ${providerName} requests are unsupported`)),
      };
    },
  };
}