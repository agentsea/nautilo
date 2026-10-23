import type { CodexRequestEvent, CodexRequestResponse } from "@nautilo/types";

type RecoveryInput = Readonly<{
  clientActionSessionId: string;
  requestId?: string;
  signal?: AbortSignal;
  isCurrent: () => boolean;
}>;
export interface ProtectedTaskExternalRequestClient {
  recoverProtectedTaskExternalRequests(input: RecoveryInput): Promise<
    | Readonly<{ status: "ready"; entries: readonly Readonly<{
        event: CodexRequestEvent; responseCapability: string;
      }>[] }>
    | Readonly<{ status: "unavailable"; entries: readonly [] }>
  >;
  respondProtectedTaskExternalRequest(input: RecoveryInput & Readonly<{
    requestId: string; responseCapability: string; response: CodexRequestResponse;
  }>): Promise<Readonly<{ status: "responded" | "unavailable" }>>;
}

/** Refresh read authority on the explicit click, then make one response attempt. */
export async function respondFreshProtectedTaskExternalRequest(input: RecoveryInput & Readonly<{
  client: ProtectedTaskExternalRequestClient;
  expectedEvent: CodexRequestEvent;
  response: CodexRequestResponse;
}>): Promise<"responded" | "not_sent" | "unconfirmed"> {
  const isCurrent = () => !input.signal?.aborted && input.isCurrent();
  if (!isCurrent()) return "not_sent";
  let recovered: Awaited<ReturnType<ProtectedTaskExternalRequestClient["recoverProtectedTaskExternalRequests"]>>;
  try {
    recovered = await input.client.recoverProtectedTaskExternalRequests({
      clientActionSessionId: input.clientActionSessionId,
      requestId: input.expectedEvent.requestId,
      signal: input.signal,
      isCurrent,
    });
  } catch { return "not_sent"; }
  if (!isCurrent() || recovered.status !== "ready") return "not_sent";
  const entry = recovered.entries.find(candidate => candidate.event.requestId === input.expectedEvent.requestId);
  // Expiry can only be shortened by current grant admission. The identity and
  // actual question must still match what the Human answered.
  if (entry === undefined
    || entry.event.ownerId !== input.expectedEvent.ownerId
    || entry.event.taskId !== input.expectedEvent.taskId
    || entry.event.jobId !== input.expectedEvent.jobId
    || entry.event.roomId !== input.expectedEvent.roomId
    || JSON.stringify(entry.event.request) !== JSON.stringify(input.expectedEvent.request)
    || input.response.kind !== entry.event.request.kind) return "not_sent";
  try {
    const result = await input.client.respondProtectedTaskExternalRequest({
      clientActionSessionId: input.clientActionSessionId,
      requestId: entry.event.requestId,
      responseCapability: entry.responseCapability,
      response: input.response,
      signal: input.signal,
      isCurrent,
    });
    return isCurrent() && result.status === "responded" ? "responded" : "unconfirmed";
  } catch { return "unconfirmed"; }
}
