import {
  acceptProtectedTaskHumanContinuation,
  resolvePublishedProtectedTaskAwaitReply,
  protectedTaskHumanContinuationAcceptanceId,
  type DirectDatabase,
} from "@nautilo/db";

type MessageCoordinate = Readonly<{ operationId: string; messageId: number }>;
type AcceptancePorts = Readonly<{
  resolve: typeof resolvePublishedProtectedTaskAwaitReply;
  accept: typeof acceptProtectedTaskHumanContinuation;
}>;

const productionPorts: AcceptancePorts = {
  resolve: resolvePublishedProtectedTaskAwaitReply,
  accept: acceptProtectedTaskHumanContinuation,
};

/** Record one content-free reply acceptance, then wait
 * for a separate fresh-authority execution segment. */
export async function acceptPublishedProtectedTaskReply(
  db: DirectDatabase,
  message: MessageCoordinate,
  ports: AcceptancePorts = productionPorts,
): Promise<
  | "no_match" | "ambiguous" | "accepted" | "exact_replay"
  | "conflict" | "not_found" | "stale"
> {
  const resolved = await ports.resolve(db, message);
  if (resolved.status !== "resolved") return resolved.status;
  const input = resolved.input;
  const accepted = await ports.accept(db, { ...input, acceptance: {
    ...input.acceptance,
    acceptanceId: protectedTaskHumanContinuationAcceptanceId({
      taskId: input.taskId, taskRunId: input.taskRunId, priorJobId: input.priorJobId,
      executionSegment: input.executionSegment, ...input.acceptance,
    }),
  } });
  return accepted.status === "rejected" ? accepted.reason : accepted.status;
}
