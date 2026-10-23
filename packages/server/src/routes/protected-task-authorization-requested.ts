export type ProtectedTaskAuthorizationRequested = (
  requestorUserId: string,
) => void | Promise<void>;

/** Best-effort latency hint after the caller's durable request transaction commits. */
export async function notifyProtectedTaskAuthorizationRequestedAfterCommit(
  callback: ProtectedTaskAuthorizationRequested | undefined,
  requestorUserId: string,
): Promise<void> {
  if (callback === undefined) return;
  try {
    await callback(requestorUserId);
  } catch {
    // The durable request remains discoverable without the latency hint.
  }
}
