import { describe, expect, test } from "bun:test";
import { ACP_RELAY_MAX_COMMANDS, ACP_RELAY_MAX_TEXT_BYTES, type RelayAcpSemanticEvent } from "@nautilo/relay";
import { projectOpenCodeAcpRoomOutput } from "../../src/acp/opencode-room-output";

const context = { ownerId: "owner", taskId: "task", taskRunId: "run" };
function event(payload: RelayAcpSemanticEvent["payload"]): RelayAcpSemanticEvent { return { type: "relay:acp-semantic", registrationId: "opencode-acp", scope: { socket: { relayId: "relay", relaySessionId: "session", desktopSessionId: "desktop", pairingGenerationRef: "pair", selectedProtocolVersion: 15, capabilityRevision: 1 }, binding: { bindingId: "binding", bindingGeneration: "generation", ownerId: "owner", taskId: "task", taskRunId: "run", jobId: "job", profileId: "profile", profileGeneration: "profile-generation", postureId: "posture", postureGeneration: "posture-generation" }, workspace: { workspaceReceiptId: "workspace", workspaceRevision: "1", workspaceFingerprint: "fingerprint", workspaceExpiresAt: "2099-01-01T00:00:00.000Z" } }, process: { connectionId: "connection", processGeneration: 1, acpSessionId: "acp", turnGeneration: 1, turnRef: "turn" }, capabilities: { requests: "unsupported" }, payload, eventId: "event", eventSequence: 2 }; }

describe("OpenCode ACP room output", () => {
  test("maps only bounded provisional delta and command facts to owner-private task progress", () => {
    expect(projectOpenCodeAcpRoomOutput(event({ kind: "output_delta", vendorItemId: null, text: "Working" }), context)).toEqual({ type: "task.progress", taskId: "task", taskRunId: "run", ownerId: "owner", detail: "Working" });
    expect(projectOpenCodeAcpRoomOutput(event({ kind: "command_summary", vendorItemId: "item", commands: [{ summary: "Checked status", status: "completed" }] }), context, 1_700_000_000_000)).toMatchObject({ type: "task.progress", detail: "Checked status", activity: { kind: "command", status: "completed", startedAt: 1_700_000_000_000, endedAt: 1_700_000_000_000 } });
  });
  test("maps only fixed runtime health states to owner-private progress without activity", () => {
    expect(projectOpenCodeAcpRoomOutput(event({ kind: "runtime_status", state: "possibly_stalled" }), context)).toEqual({ type: "task.progress", taskId: "task", taskRunId: "run", ownerId: "owner", detail: "OpenCode is still running but no recent activity was observed. You can keep waiting or Stop the task." });
    expect(projectOpenCodeAcpRoomOutput(event({ kind: "runtime_status", state: "healthy" }), context)).toEqual({ type: "task.progress", taskId: "task", taskRunId: "run", ownerId: "owner", detail: "OpenCode activity resumed." });
  });
  test("suppresses completion and rejects mismatched, malformed, or permission-shaped values", () => {
    expect(projectOpenCodeAcpRoomOutput(event({ kind: "assistant_completed", vendorItemId: null, text: "result" }), context)).toBeNull();
    for (const value of [
      { ...event({ kind: "output_delta", vendorItemId: null, text: "x" }), registrationId: "hermes-acp" },
      { ...event({ kind: "output_delta", vendorItemId: null, text: "x" }), capabilities: { requests: "supported" } },
      { ...event({ kind: "output_delta", vendorItemId: null, text: "x" }), scope: { ...event({ kind: "output_delta", vendorItemId: null, text: "x" }).scope, binding: { ...event({ kind: "output_delta", vendorItemId: null, text: "x" }).scope.binding, taskId: "other" } } },
      { ...event({ kind: "output_delta", vendorItemId: null, text: "x" }), payload: { kind: "permission", optionId: "allow" } },
    ]) expect(() => projectOpenCodeAcpRoomOutput(value as RelayAcpSemanticEvent, context)).toThrow("ACP_ROOM_OUTPUT_INVALID");
  });
  test("suppresses whitespace-only progress and enforces command and text limits", () => {
    expect(projectOpenCodeAcpRoomOutput(event({ kind: "output_delta", vendorItemId: null, text: " \n\t " }), context)).toBeNull();
    expect(projectOpenCodeAcpRoomOutput(event({ kind: "command_summary", vendorItemId: null, commands: [{ summary: "  ", status: "running" }] }), context)).toBeNull();
    const commands = Array.from({ length: ACP_RELAY_MAX_COMMANDS }, (_, index) => ({ summary: `command-${index}`, status: "running" as const }));
    expect(projectOpenCodeAcpRoomOutput(event({ kind: "command_summary", vendorItemId: null, commands }), context)).toMatchObject({ detail: `command-${ACP_RELAY_MAX_COMMANDS - 1}` });
    expect(() => projectOpenCodeAcpRoomOutput(event({ kind: "command_summary", vendorItemId: null, commands: [...commands, { summary: "one too many", status: "running" }] }), context)).toThrow("ACP_ROOM_OUTPUT_INVALID");
    for (const payload of [
      { kind: "output_delta" as const, vendorItemId: null, text: "nul\0text" },
      { kind: "output_delta" as const, vendorItemId: null, text: "x".repeat(ACP_RELAY_MAX_TEXT_BYTES + 1) },
      { kind: "command_summary" as const, vendorItemId: null, commands: [{ summary: "nul\0text", status: "running" as const }] },
      { kind: "command_summary" as const, vendorItemId: null, commands: [{ summary: "x".repeat(ACP_RELAY_MAX_TEXT_BYTES + 1), status: "running" as const }] },
    ]) expect(() => projectOpenCodeAcpRoomOutput(event(payload), context)).toThrow("ACP_ROOM_OUTPUT_INVALID");
  });
  test("rejects an invented command clock rather than emitting an epoch duration", () => {
    const command = event({ kind: "command_summary", vendorItemId: "item", commands: [{ summary: "Checked status", status: "running" }] });
    expect(() => projectOpenCodeAcpRoomOutput(command, context, 0)).toThrow("ACP_ROOM_OUTPUT_INVALID");
    expect(() => projectOpenCodeAcpRoomOutput(command, context, Number.NaN)).toThrow("ACP_ROOM_OUTPUT_INVALID");
  });
  test("uses one stable command activity identity so task-state merging retains first observed start and terminal end", () => {
    const running = projectOpenCodeAcpRoomOutput(event({ kind: "command_summary", vendorItemId: "command-1", commands: [{ summary: "Checking", status: "running" }] }), context, 1_000);
    const completed = projectOpenCodeAcpRoomOutput(event({ kind: "command_summary", vendorItemId: "command-1", commands: [{ summary: "Checked", status: "completed" }] }), context, 1_250);
    expect(running?.activity).toMatchObject({ id: "command-1", startedAt: 1_000, status: "running" });
    expect(running?.activity?.endedAt).toBeUndefined();
    expect(completed?.activity).toMatchObject({ id: "command-1", startedAt: 1_250, endedAt: 1_250 });
    // The existing task-state merge retains its current start for a matching id
    // and overlays the terminal observation, yielding 1000 → 1250 rather than
    // an epoch-derived duration.
    const merged = { ...running?.activity, ...completed?.activity, startedAt: running?.activity?.startedAt ?? completed?.activity?.startedAt };
    expect(merged).toMatchObject({ id: "command-1", startedAt: 1_000, endedAt: 1_250, status: "completed" });
  });
});
