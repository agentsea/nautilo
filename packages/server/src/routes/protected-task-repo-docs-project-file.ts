import { randomUUID } from "node:crypto";
import path from "node:path";
import { bindDelegatedLocalExecution, type ProtectedTaskProjectFilePort } from "@nautilo/agent";
import { isRelayTaskProjectFileDispatch, type RelayLocalFileRequest, type RelayLocalFileResult } from "@nautilo/relay";
import type { ProtectedTaskRepoDocsLocalExecutionInput } from "./protected-task-repo-docs-local-execution";

/** Borrow the same live Task project owner as the trusted Git wrapper. The
 * Desktop resolves its grant and root locally; this root is only an assertion. */
export function createProtectedTaskRepoDocsProjectFilePort(
  input: ProtectedTaskRepoDocsLocalExecutionInput & Readonly<{ workspaceRoot: string; relayId: string }>,
): ProtectedTaskProjectFilePort {
  const { delegated, registry, signal, assertCurrent, workspaceRoot, relayId } = input;
  const state = Object.freeze({ ...input.state });
  const suffix = path.join("nautilo-repo-docs", `task-run-${delegated.taskRunId}`);
  if (!path.isAbsolute(workspaceRoot) || path.normalize(workspaceRoot) !== workspaceRoot
    || !workspaceRoot.endsWith(`${path.sep}${suffix}`)
    || state.currentTaskId !== delegated.taskId || state.currentTaskRunId !== delegated.taskRunId
    || state.trustedExecutionEntrypoint !== "background.task"
    || !state.agentId || !state.causalHumanUserId || !state.roomId || !relayId) {
    throw new TypeError("Protected repo docs project file identity is invalid");
  }
  // The source descriptor is resolved under live authority on every call.
  // The exact relay comes from that descriptor, never a model-selected host.
  return Object.freeze({
    taskId: delegated.taskId, taskRunId: delegated.taskRunId,
    agentId: state.agentId, humanUserId: state.causalHumanUserId,
    relayId,
    workspaceRoot,
    async dispatch(request: RelayLocalFileRequest, options: Parameters<ProtectedTaskProjectFilePort["dispatch"]>[1]): Promise<RelayLocalFileResult> {
      const operation = options.mutating ? "input" : "read";
      if (request.allowedRoots.length !== 1 || request.allowedRoots[0] !== workspaceRoot
        || options.mutating && options.approvalObtained !== true) {
        return { ok: false, code: "TASK_PROJECT_FILE_UNAVAILABLE", message: "The exact Task project file request is unavailable." };
      }
      const lifetime = AbortSignal.any([signal, delegated.signal, ...(options.signal ? [options.signal] : [])]);
      let sent = false;
      try {
        return await delegated.withAdmission(operation, async source => {
          lifetime.throwIfAborted(); source.signal.throwIfAborted(); await assertCurrent();
          if (source.taskId !== delegated.taskId || source.taskRunId !== delegated.taskRunId
            || source.delegation.agentId !== state.agentId || source.delegation.humanUserId !== state.causalHumanUserId
            || relayId !== source.delegation.target.relayId) {
            throw new TypeError("Protected repo docs project source changed");
          }
          const target = source.delegation.target.relayId;
          const pin = bindDelegatedLocalExecution({ registry, source, state,
            invocationId: `repo-docs-file:${randomUUID()}`, operation: "start" });
          if (pin === null) throw new TypeError("Protected repo docs file target is unavailable");
          const binding = Object.freeze({ ...pin, operation });
          const args = structuredClone(request) as unknown as Record<string, unknown>;
          const envelope = { toolName: "local-file", executionClass: "local-file" as const, args,
            localExecutionBinding: binding };
          const current = () => {
            const capabilities = registry.getCapabilities(target);
            return capabilities !== null && capabilities !== undefined && isRelayTaskProjectFileDispatch({ request: envelope,
            capabilities, protocolVersion: registry.getProtocolVersion?.(target) ?? 0,
            userId: registry.getUserId?.(target) ?? "", relayId: target,
            desktopSessionId: registry.getDesktopSessionId?.(target),
            pairingGeneration: registry.getLocalExecutionPairingGeneration?.(target),
            instanceId: source.delegation.target.instanceId });
          };
          if (!current()) throw new TypeError("Protected repo docs file transport changed");
          lifetime.throwIfAborted(); source.signal.throwIfAborted(); await assertCurrent();
          if (!current()) throw new TypeError("Protected repo docs file transport changed");
          sent = true;
          const result = await registry.dispatch(target, { ...envelope,
            impact: options.mutating ? "destructive" : "read-only", approvalObtained: options.approvalObtained,
            signal: AbortSignal.any([lifetime, source.signal]) });
          lifetime.throwIfAborted(); source.signal.throwIfAborted(); await assertCurrent();
          if (!current()) throw new TypeError("Protected repo docs file transport changed");
          const value: unknown = result.result;
          if (result.status !== "ok" || value === null || typeof value !== "object"
            || !Object.hasOwn(value, "ok")) throw new TypeError("Protected repo docs file response is unavailable");
          const response = value as { ok?: unknown; result?: unknown; code?: unknown; message?: unknown };
          if (response.ok === true) return { ok: true, ...(response.result === undefined ? {} : { result: response.result }) };
          if (response.ok === false) return { ok: false, code: typeof response.code === "string" ? response.code : "TASK_PROJECT_FILE_FAILED",
            message: "The exact Task project file operation failed." };
          throw new TypeError("Protected repo docs file response is unavailable");
        });
      } catch {
        return { ok: false, code: sent && options.mutating ? "TASK_PROJECT_FILE_OUTCOME_UNKNOWN" : "TASK_PROJECT_FILE_UNAVAILABLE",
          message: sent && options.mutating ? "The Task file mutation outcome is unconfirmed. Inspect the same file; do not resend uncertain changes."
            : "The exact Task project file authority is unavailable." };
      }
    },
  });
}
