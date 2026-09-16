export interface HarnessPresentation {
  readonly displayName: string;
  readonly workingLabel: string;
  readonly taskLabel: string;
  readonly failedLabel: string;
  readonly stoppedLabel: string;
  readonly waitingLabel: string;
  /** Truthful fallback when the receipt has no durable tool-activity rows. */
  readonly acceptedEmptyLabel: string;
  readonly completedEmptyLabel: string;
  readonly erroredEmptyLabel: string;
  readonly cancelledEmptyLabel: string;
  readonly supportsPauseResume: boolean;
  /** Enables canonical Nautilo Task cancellation. This does not imply that the
   * external harness can return an authoritative graceful-cancel terminal. */
  readonly supportsTaskStop: boolean;
  readonly supportsRequests: boolean;
}

const PRESENTATIONS: Readonly<Record<string, HarnessPresentation>> = Object.freeze({
  native: Object.freeze({
    displayName: "Background task",
    workingLabel: "Background task is working",
    taskLabel: "Background task",
    failedLabel: "Background task failed",
    stoppedLabel: "Background task was stopped",
    waitingLabel: "Waiting for background task activity…",
    acceptedEmptyLabel: "This background task was accepted and will report back in this Room.",
    completedEmptyLabel: "This background task completed and reported its result in this Room.",
    erroredEmptyLabel: "This background task failed and reported its outcome in this Room.",
    cancelledEmptyLabel: "This background task was stopped.",
    supportsPauseResume: true,
    supportsTaskStop: true,
    supportsRequests: true,
  }),
  codex: Object.freeze({
    displayName: "Codex",
    workingLabel: "Codex is working",
    taskLabel: "Codex task",
    failedLabel: "Codex failed",
    stoppedLabel: "Codex was stopped",
    waitingLabel: "Waiting for Codex activity…",
    acceptedEmptyLabel: "Codex accepted this task. Its authoritative result appears separately in this Room.",
    completedEmptyLabel: "Codex completed this task. Its authoritative result is reported in this Room.",
    erroredEmptyLabel: "Codex failed this task. Its authoritative failure is reported in this Room.",
    cancelledEmptyLabel: "Codex stopped this task. Its authoritative status is reported in this Room.",
    supportsPauseResume: true,
    supportsTaskStop: true,
    supportsRequests: true,
  }),
  "claude-code": Object.freeze({
    displayName: "Claude Code",
    workingLabel: "Claude Code is working",
    taskLabel: "Claude Code task",
    failedLabel: "Claude Code failed",
    stoppedLabel: "Claude Code was stopped",
    waitingLabel: "Waiting for Claude Code activity…",
    acceptedEmptyLabel: "Claude Code accepted this task. Its authoritative result appears separately in this Room.",
    completedEmptyLabel: "Claude Code completed this task. Its authoritative result is reported in this Room.",
    erroredEmptyLabel: "Claude Code failed this task. Its authoritative failure is reported in this Room.",
    cancelledEmptyLabel: "Claude Code stopped this task. Its authoritative status is reported in this Room.",
    supportsPauseResume: false,
    supportsTaskStop: true,
    supportsRequests: true,
  }),
  "hermes-acp": Object.freeze({
    displayName: "Hermes via ACP",
    workingLabel: "Hermes is working",
    taskLabel: "Hermes task",
    failedLabel: "Hermes failed",
    stoppedLabel: "Hermes stopped",
    waitingLabel: "Waiting for Hermes activity…",
    acceptedEmptyLabel: "Hermes accepted this task. Its authoritative result appears separately in this Room.",
    completedEmptyLabel: "Hermes completed this task. Its authoritative result is reported in this Room.",
    erroredEmptyLabel: "Hermes failed this task. Its authoritative failure is reported in this Room.",
    cancelledEmptyLabel: "Hermes stopped this task. Its authoritative status is reported in this Room.",
    supportsPauseResume: false,
    // Nautilo owns Task cancellation and exact process containment even while
    // Hermes' graceful ACP Stop capability remains release-gated upstream.
    supportsTaskStop: true,
    supportsRequests: false,
  }),
  "opencode-acp": Object.freeze({
    displayName: "OpenCode via ACP",
    workingLabel: "OpenCode is working",
    taskLabel: "OpenCode task",
    failedLabel: "OpenCode failed",
    stoppedLabel: "OpenCode stopped",
    waitingLabel: "Waiting for OpenCode activity…",
    acceptedEmptyLabel: "OpenCode accepted this task. Its authoritative result appears separately in this Room.",
    completedEmptyLabel: "OpenCode completed this task. Its authoritative result is reported in this Room.",
    erroredEmptyLabel: "OpenCode failed this task. Its detailed outcome and recovery guidance are reported in this Room.",
    cancelledEmptyLabel: "OpenCode stopped this task. Its authoritative status is reported in this Room.",
    supportsPauseResume: false,
    supportsTaskStop: true,
    supportsRequests: false,
  }),
});

export function harnessPresentation(harnessId: string | null | undefined): HarnessPresentation | null {
  return harnessId ? PRESENTATIONS[harnessId] ?? null : null;
}

/**
 * The Task receipt is durable, but external-harness progress is deliberately
 * process-local. Once that overlay is gone, explain the canonical Task state
 * rather than falsely claiming no execution happened.
 */
export function harnessReceiptEmptyLabel(
  presentation: HarnessPresentation,
  canonicalStatus: string | undefined,
  _receiptStatus: string | undefined,
  active: boolean,
): string {
  switch (canonicalStatus) {
    case "paused":
      return "This task is paused. Its recorded activity remains available.";
    case "awaiting":
      return "This task is awaiting a reply. Its recorded activity remains available.";
    case "completed":
      return presentation.completedEmptyLabel;
    case "errored":
      return presentation.erroredEmptyLabel;
    case "cancelled":
      return presentation.cancelledEmptyLabel;
  }
  if (active) return presentation.waitingLabel;
  return presentation.acceptedEmptyLabel;
}
