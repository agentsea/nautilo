import type { ServerEvent } from "@nautilo/types";
import { ACP_RELAY_MAX_COMMANDS, ACP_RELAY_MAX_TEXT_BYTES, type RelayAcpSemanticEvent } from "@nautilo/relay";

const encoder = new TextEncoder();
type Context = Readonly<{ ownerId: string; taskId: string; taskRunId: string }>;

function bounded(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0") && encoder.encode(value).byteLength <= ACP_RELAY_MAX_TEXT_BYTES;
}
function command(value: unknown): value is Readonly<{ summary: string; status: "completed" | "failed" | "running" }> {
  return !!value && typeof value === "object" && !Array.isArray(value) && bounded((value as Record<string, unknown>)["summary"]) && (((value as Record<string, unknown>)["status"] === "completed") || ((value as Record<string, unknown>)["status"] === "failed") || ((value as Record<string, unknown>)["status"] === "running"));
}
/** Stateless provider-neutral ACP progress projection. It has no durable or
 * control surface: only validated provisional semantics reach the owner. */
export function projectOpenCodeAcpRoomOutput(
  event: RelayAcpSemanticEvent,
  context: Context,
  observedAt = Date.now(),
): Extract<ServerEvent, { readonly type: "task.progress" }> | null {
  if (
    event.registrationId !== "opencode-acp" || event.scope.binding.ownerId !== context.ownerId ||
    event.scope.binding.taskId !== context.taskId || event.scope.binding.taskRunId !== context.taskRunId ||
    event.capabilities.requests !== "unsupported"
  ) throw new TypeError("ACP_ROOM_OUTPUT_INVALID");
  if (event.payload.kind === "runtime_status") {
    const detail = event.payload.state === "possibly_stalled"
      ? "OpenCode is still running but no recent activity was observed. You can keep waiting or Stop the task."
      : event.payload.state === "healthy"
        ? "OpenCode activity resumed."
        : null;
    if (detail === null) throw new TypeError("ACP_ROOM_OUTPUT_INVALID");
    return { type: "task.progress", taskId: context.taskId, taskRunId: context.taskRunId, ownerId: context.ownerId, detail };
  }
  if (event.payload.kind === "assistant_completed") return null;
  if (event.payload.kind === "output_delta") {
    if (!bounded(event.payload.text)) throw new TypeError("ACP_ROOM_OUTPUT_INVALID");
    if (!event.payload.text.trim()) return null;
    return { type: "task.progress", taskId: context.taskId, taskRunId: context.taskRunId, ownerId: context.ownerId, detail: event.payload.text };
  }
  const commands: unknown = event.payload.commands;
  if (!Array.isArray(commands) || commands.length > ACP_RELAY_MAX_COMMANDS || commands.length === 0 || !commands.every(command)) throw new TypeError("ACP_ROOM_OUTPUT_INVALID");
  const last = commands.at(-1);
  if (!last) throw new TypeError("ACP_ROOM_OUTPUT_INVALID");
  const detail = last.summary;
  if (!detail.trim()) return null;
  if (!Number.isSafeInteger(observedAt) || observedAt <= 0) throw new TypeError("ACP_ROOM_OUTPUT_INVALID");
  const status = last.status === "failed" ? "failed" : last.status === "completed" ? "completed" : "running";
  return { type: "task.progress", taskId: context.taskId, taskRunId: context.taskRunId, ownerId: context.ownerId, detail, activity: { id: event.payload.vendorItemId ?? `acp:${event.eventId}`, kind: "command", name: "external_command", status, args: { detail }, startedAt: observedAt, ...(status === "running" ? {} : { endedAt: observedAt }) } };
}
