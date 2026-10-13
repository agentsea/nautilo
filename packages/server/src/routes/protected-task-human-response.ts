import {
  acceptProtectedTaskHumanContinuation,
  eq,
  protectedTaskHumanContinuationAcceptanceId,
  protectedTaskDefinitionSupportsPolicy,
  resolveParkedProtectedTaskHumanContinuationAcceptance,
  tasks,
  type DirectDatabase,
  type ProtectedTaskHumanContinuationAcceptance,
} from "@nautilo/db";
import { assertCanInvokeAgent, AgentInvocationDeniedError } from "@nautilo/trust";
import { ClassifiedDataOperationError, type EncryptionDataOperationOwner } from "@nautilo/lattice-bridge";

type HumanResponse = Exclude<ProtectedTaskHumanContinuationAcceptance["response"],
  { kind: "await_reply" }>;
export type ProtectedTaskHumanResponseInput = Readonly<{
  taskId: string;
  graphThreadId: string;
  userId: string;
  humanActorId: string | null;
  requestId?: string;
  response: HumanResponse;
}>;
export type ProtectedTaskHumanResponseResult =
  | Readonly<{ status: "not_applicable" }>
  | Readonly<{ status: "accepted" }>
  | Readonly<{ status: "rejected"; code: "task_approval_not_found" | "approval_stale" }>;

type Dependencies = Readonly<{
  task(taskId: string): Promise<Readonly<{
    representation: "ordinary" | "dual" | "protected";
    agentId: string; targetRoomId: string | null;
  }> | null>;
  admit: typeof assertCanInvokeAgent;
  resolve: typeof resolveParkedProtectedTaskHumanContinuationAcceptance;
  accept: typeof acceptProtectedTaskHumanContinuation;
}>;

/** Persist the exact categorical response. The observer obtains fresh authority later. */
export function createProtectedTaskHumanResponse(input: Readonly<{
  db: DirectDatabase;
  owner: EncryptionDataOperationOwner;
  wake(): void;
  now(): Date;
}>, overrides: Partial<Dependencies> = {}) {
  const dependencies: Dependencies = {
    task: async taskId => {
      const [row] = await input.db.select({ representation: tasks.contentRepresentation,
        agentId: tasks.agentId, targetRoomId: tasks.targetRoomId })
        .from(tasks).where(eq(tasks.id, taskId)).limit(1);
      return row ?? null;
    },
    admit: assertCanInvokeAgent,
    resolve: resolveParkedProtectedTaskHumanContinuationAcceptance,
    accept: acceptProtectedTaskHumanContinuation,
    ...overrides,
  };
  return async (supplied: ProtectedTaskHumanResponseInput): Promise<ProtectedTaskHumanResponseResult> => {
    const request = structuredClone(supplied);
    const ordinaryOnly = new ClassifiedDataOperationError(
      "recoverable_availability", "Task has no protected continuation",
    );
    const accept = async (mode: "shadow_encryption" | "encrypted_only"): Promise<ProtectedTaskHumanResponseResult> => {
      const task = await dependencies.task(request.taskId);
      if (task?.representation === "ordinary") throw ordinaryOnly;
      if (task === null || request.humanActorId === null) {
        return { status: "rejected", code: "task_approval_not_found" };
      }
      if (!protectedTaskDefinitionSupportsPolicy(task.representation, mode)) {
        return { status: "rejected", code: "approval_stale" };
      }
      if (request.response.kind !== "identity" && !request.requestId) {
        return { status: "rejected", code: "approval_stale" };
      }
      const acceptedBy = { userId: request.userId, humanActorId: request.humanActorId };
      const resolved = await dependencies.resolve(input.db, {
        taskId: request.taskId, graphThreadId: request.graphThreadId, acceptedBy,
        interrupt: { kind: request.response.kind,
          ...(request.requestId === undefined ? {}
            : request.response.kind === "prove_it" ? { id: request.requestId }
              : { requestId: request.requestId }) },
      });
      if (resolved.status !== "resolved") {
        return { status: "rejected", code: "task_approval_not_found" };
      }
      if (request.response.kind === "approval") {
        const allowedVerbs = resolved.interrupt.allowedVerbs ?? ["deny"];
        if (!allowedVerbs.includes(request.response.verb)
          || request.response.verb === "room" && task.targetRoomId === null) {
          return { status: "rejected", code: "approval_stale" };
        }
      }
      try {
        await dependencies.admit({ humanUserId: request.userId,
          origin: "foreground_resume", taskId: request.taskId, agentId: task.agentId,
          ...(task.targetRoomId === null ? {} : { roomId: task.targetRoomId }),
        });
      } catch (error) {
        if (!(error instanceof AgentInvocationDeniedError)) throw error;
        return { status: "rejected", code: "task_approval_not_found" };
      }
      const acceptance = {
        acceptedBy, interrupt: resolved.interrupt,
        acceptedAt: input.now(), response: request.response,
      };
      const accepted = await dependencies.accept(input.db, {
        ...resolved.input, acceptance: { ...acceptance,
          acceptanceId: protectedTaskHumanContinuationAcceptanceId({
            ...resolved.input, ...acceptance,
          }),
        },
      });
      if (accepted.status === "rejected") return { status: "rejected", code: "approval_stale" };
      input.wake();
      return { status: "accepted" };
    };
    return input.owner.runMutation({
      ordinary: () => Promise.resolve({ status: "not_applicable" } as const),
      // Only a proven ordinary Task may use the policy owner's Fallback path.
      // Protected acceptance failures must never resume an ordinary graph.
      classifyFailure: error => error === ordinaryOnly ? "recoverable_availability" : "integrity",
      dual: () => accept("shadow_encryption"),
      protected: () => accept("encrypted_only"),
    });
  };
}
