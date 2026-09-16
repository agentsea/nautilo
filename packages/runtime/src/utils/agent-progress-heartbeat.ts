import type { AgentProgressEvent } from "@nautilo/types";

const DEFAULT_AGENT_PROGRESS_INTERVAL_MS = 1_500;
const DEFAULT_AGENT_PROGRESS_QUIET_MS = 1_000;

function readEnv(name: string): string | undefined {
  return process.env[name];
}

/** Resolve tick interval from `NAUTILO_AGENT_PROGRESS_INTERVAL_MS`. */
export function resolveAgentProgressIntervalMs(
  raw: string | undefined = readEnv("NAUTILO_AGENT_PROGRESS_INTERVAL_MS"),
): number {
  if (raw === undefined || raw === "") return DEFAULT_AGENT_PROGRESS_INTERVAL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_AGENT_PROGRESS_INTERVAL_MS;
  return parsed;
}

/** Resolve quiet window from `NAUTILO_AGENT_PROGRESS_QUIET_MS`. */
export function resolveAgentProgressQuietMs(
  raw: string | undefined = readEnv("NAUTILO_AGENT_PROGRESS_QUIET_MS"),
): number {
  if (raw === undefined || raw === "") return DEFAULT_AGENT_PROGRESS_QUIET_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_AGENT_PROGRESS_QUIET_MS;
  return parsed;
}

export type AgentProgressPhase = AgentProgressEvent["phase"];

export interface AgentProgressHeartbeatConfig {
  laneKey: string;
  turnId: string;
  authorAgentId?: string | undefined;
  /** When true, no ticks are emitted (mirrors `suppressToolLifecycleEvents`). */
  suppressed?: boolean | undefined;
  intervalMs?: number | undefined;
  quietMs?: number | undefined;
  emit: (event: AgentProgressEvent) => void;
  now?: () => number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

/**
 * M178 — periodic in-flight heartbeat while a turn is quiet (no recent visible
 * tokens). The executor owns lifecycle (start/dispose around streamEvents).
 */
export class AgentProgressHeartbeat {
  private lastVisibleTokenAt: number;
  private awaitingToolAfterDone = false;
  private inPostModel = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private readonly intervalMs: number;
  private readonly quietMs: number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private readonly now: () => number;

  constructor(private readonly config: AgentProgressHeartbeatConfig) {
    this.now = config.now ?? (() => Date.now());
    this.lastVisibleTokenAt = this.now();
    this.intervalMs = config.intervalMs ?? resolveAgentProgressIntervalMs();
    this.quietMs = config.quietMs ?? resolveAgentProgressQuietMs();
    this.setIntervalFn = config.setIntervalFn ?? setInterval;
    this.clearIntervalFn = config.clearIntervalFn ?? clearInterval;
  }

  start(): void {
    if (this.disposed || this.config.suppressed || !this.config.turnId.trim()) return;
    if (this.timer) return;
    this.timer = this.setIntervalFn(() => {
      this.tick();
    }, this.intervalMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
  }

  noteVisibleToken(): void {
    this.lastVisibleTokenAt = this.now();
  }

  noteMessageDone(): void {
    this.awaitingToolAfterDone = true;
  }

  noteToolsPhaseStart(): void {
    this.awaitingToolAfterDone = false;
  }

  notePostModelStart(): void {
    this.inPostModel = true;
  }

  notePostModelEnd(): void {
    this.inPostModel = false;
  }

  private resolvePhase(): AgentProgressPhase {
    if (this.inPostModel) return "post_model";
    if (this.awaitingToolAfterDone) return "preparing_tool";
    return "thinking";
  }

  private tick(): void {
    if (this.disposed || this.config.suppressed || !this.config.turnId.trim()) return;
    const now = this.now();
    if (now - this.lastVisibleTokenAt <= this.quietMs) return;

    const event: AgentProgressEvent = {
      type: "agent.progress",
      laneKey: this.config.laneKey,
      turnId: this.config.turnId,
      phase: this.resolvePhase(),
    };
    if (this.config.authorAgentId) {
      event.authorAgentId = this.config.authorAgentId;
    }
    this.config.emit(event);
  }
}

/** Best-effort streamEvents hook — updates heartbeat phase hints from chain events. */
export function noteAgentProgressFromStreamEvent(
  ev: unknown,
  heartbeat: AgentProgressHeartbeat | null | undefined,
): void {
  if (!heartbeat || !ev || typeof ev !== "object") return;
  const eventObj = ev as Record<string, unknown>;
  const event = typeof eventObj["event"] === "string" ? eventObj["event"] : "";
  const name = typeof eventObj["name"] === "string" ? eventObj["name"] : "";
  if (event === "on_chain_start" && name === "post_model") {
    heartbeat.notePostModelStart();
  } else if (event === "on_chain_end" && name === "post_model") {
    heartbeat.notePostModelEnd();
  } else if (event === "on_chain_start" && name === "tools") {
    heartbeat.noteToolsPhaseStart();
  }
}
