import {
  projectTaskTranscriptToolArgs,
  projectToolResultForEvent,
  type ServerEvent,
  type ToolEndEvent,
  type ToolStartEvent,
} from "@nautilo/types";
import { projectSemanticComputerResult } from "./tools/computer/model-result-projector";
type EventSink = {
  emit(event: ServerEvent): void;
};

const noopEventSink: EventSink = {
  emit: () => undefined,
};

let eventSink: EventSink = noopEventSink;

/**
 * Runtime injects this sink at server startup. Keeping it injectable prevents
 * @nautilo/agent from depending back on @nautilo/runtime, which closes the
 * Turbo build graph cycle.
 */
export function setAgentEventSink(sink: EventSink | null): void {
  eventSink = sink ?? noopEventSink;
}

export function emitAgentEvent(event: ServerEvent): void {
  eventSink.emit(event);
}

/**
 * Agent-local copy of the tool lifecycle event formatter. Runtime also has a
 * tracker for stream processing, but importing it from here would create an
 * agent -> runtime dependency cycle.
 */
export class AgentToolCallTracker {
  private activeCalls = new Map<string, { toolName: string; startTime: number }>();

  constructor(
    private readonly laneKey?: string | undefined,
    private readonly authorAgentId?: string | undefined,
    private readonly turnId?: string | undefined,
  ) {}

  toolStart(toolCallId: string, toolName: string, args?: unknown): ToolStartEvent {
    this.activeCalls.set(toolCallId, {
      toolName,
      startTime: Date.now(),
    });

    return {
      type: "tool.start",
      ...(this.laneKey ? { laneKey: this.laneKey } : {}),
      ...(this.authorAgentId ? { authorAgentId: this.authorAgentId } : {}),
      ...(this.turnId ? { turnId: this.turnId } : {}),
      toolCallId,
      toolName,
      argsSummary: args ? summarizeToolArgs(args, toolName) : undefined,
    };
  }

  toolEnd(
    toolCallId: string,
    toolName: string,
    status: "success" | "error",
    error?: string,
    result?: string,
    runShellOutcome?: ToolEndEvent["runShellOutcome"],
  ): ToolEndEvent {
    const call = this.activeCalls.get(toolCallId);
    const duration = call ? Date.now() - call.startTime : 0;
    this.activeCalls.delete(toolCallId);

    const event: ToolEndEvent = {
      type: "tool.end",
      ...(this.laneKey ? { laneKey: this.laneKey } : {}),
      ...(this.authorAgentId ? { authorAgentId: this.authorAgentId } : {}),
      ...(this.turnId ? { turnId: this.turnId } : {}),
      toolCallId,
      toolName,
      duration,
      status,
    };
    if (error !== undefined) event.error = error;
    if (result !== undefined) {
      // Computer Use persists the full, scanned host envelope in its durable
      // sidecar for diagnostics. Live UI events must receive the same closed,
      // semantic projection used by the model; the sealed Workbench renderer
      // deliberately rejects raw provider/action/capability bytes.
      const displayResult = projectSemanticComputerResult(toolName, result);
      const capped = projectToolResultForEvent(toolName, displayResult);
      event.result = capped.result;
      if (capped.truncated) event.resultTruncated = true;
    }
    // This is a narrow lifecycle disposition, never a generic tool error
    // annotation. The receiver keys it to this exact invocation.
    if (toolName === "run_shell" && runShellOutcome === "unknown") {
      event.runShellOutcome = "unknown";
    }
    return event;
  }
}

function summarizeToolArgs(args: unknown, toolName?: string): string {
  if (!args) return "";
  try {
    // Connected Website controls need the account identity while a read is
    // running. The complete Human request can exceed the generic preview cap,
    // which used to leave the client with truncated, invalid JSON and disable
    // both Watch live and Stop. Project only the non-secret control fields.
    const projected = (toolName === "browse_web" || toolName === "run_website_task" || toolName === "read_connected_web_account" || toolName === "act_connected_web_account")
      && typeof args === "object"
      && args !== null
      && !Array.isArray(args)
      ? (() => {
          const source = args as Record<string, unknown>;
          if (toolName === "run_website_task") return {
            ...(typeof source["account"] === "string" ? { account: safeBoundedText(source["account"], 2_048) } : { url: safeBoundedText(source["url"], 2_048) }),
            // The typed tool receipt owns the exact sign-in continuation.
          };
          if (toolName === "browse_web") return { url: safeBoundedText(source["url"], 2_048), request: safeBoundedText(source["request"], 4_096) };
          if (toolName === "act_connected_web_account") {
            const account = safeBoundedText(source["account"], 2_048);
            const target = safeBoundedText(source["target"], 1_024);
            // This is a display projection, not a copy of tool arguments. A
            // fixed three-key JSON object means the Workbench can still find
            // the action target while the original request remains private.
            return account && source["action"] === "save_item" && target
              ? { account, action: "save_item", target }
              : {};
          }
          return {
            ...(typeof source["account"] === "string" ? { account: source["account"] } : {}),
            ...(toolName === "read_connected_web_account" && (source["delivery"] === "text" || source["delivery"] === "workspace") ? { delivery: source["delivery"] } : {}),
          };
        })()
      : typeof args === "object" && args !== null && !Array.isArray(args)
        ? projectTaskTranscriptToolArgs(args as Record<string, unknown>)
        : {};
    // This is a parseable semantic projection, not a byte prefix. Individual
    // display values adapt to the shared transcript projection and visibly
    // ellipsize when needed; the persisted tool-call remains canonical.
    return JSON.stringify(projected);
  } catch {
    return "{}";
  }
}

function safeBoundedText(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength
    ? value.trim()
    : null;
}
