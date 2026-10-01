import {
  acceptProtectedTaskAwaitReply,
  resolvePublishedProtectedTaskAwaitReply,
  type DirectDatabase,
} from "@nautilo/db";

type MessageCoordinate = Readonly<{ operationId: string; messageId: number }>;
type AcceptancePorts = Readonly<{
  resolve: typeof resolvePublishedProtectedTaskAwaitReply;
  accept: typeof acceptProtectedTaskAwaitReply;
}>;

const productionPorts: AcceptancePorts = {
  resolve: resolvePublishedProtectedTaskAwaitReply,
  accept: acceptProtectedTaskAwaitReply,
};

/** Dark composition leg: record one content-free reply acceptance, then wait
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
  const accepted = await ports.accept(db, resolved.input);
  return accepted.status === "rejected" ? accepted.reason : accepted.status;
}
