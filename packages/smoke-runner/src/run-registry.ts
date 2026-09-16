/**
 * In-memory registry of in-flight and completed smoke runs for the
 * HTTP API (D063 Phase 3).
 *
 * Each run gets an id + a status record. Subscribers (SSE streams)
 * attach while the run is in-flight and receive every RunnerEvent.
 * Once a run completes, its final RunReport is persisted so late
 * `GET /api/smoke/runs/:id/report` calls still return data.
 *
 * Lifetime: process-lifetime, in-memory only. When the server
 * restarts, the registry is empty. For CI workflows that need
 * persisted history, write the report to disk via the CLI's
 * --json-report flag or hit /report and save the response.
 *
 * Bounded by `maxCompleted` (default 32) — oldest completed runs
 * evict first. In-flight runs never evict.
 */

import type { RunReport } from "./types.ts";
import type { RunFilter, RunnerOptions, RunnerEvent } from "./runner.ts";
import { Runner } from "./runner.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunStatus =
  | "running"
  | "completed"
  | "failed";

export interface RunRecord {
  readonly runId: string;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly progress: RunProgress;
  /** Set once the run completes. */
  readonly report?: RunReport;
  /** Set when status === "failed". */
  readonly error?: string;
}

export interface RunProgress {
  readonly total: number;
  readonly done: number;
}

export type RunEventSubscriber = (evt: RunnerEvent) => void;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Everything RunRegistry needs to build a Runner at start() time,
 *  minus the per-run onEvent which the registry injects itself. */
export type RunnerConfig = Omit<RunnerOptions, "onEvent">;

export interface RunRegistryOptions {
  readonly maxCompleted?: number;
}

interface InternalRecord {
  record: RunRecord;
  subscribers: Set<RunEventSubscriber>;
  /** In-flight event log so late `subscribe()` callers can replay
   *  events that fired before they attached. Cleared when the run
   *  completes (the final report covers everything). */
  eventLog: RunnerEvent[];
}

export class RunRegistry {
  private readonly runs = new Map<string, InternalRecord>();
  private readonly order: string[] = []; // chronological insertion order for eviction
  private readonly maxCompleted: number;

  constructor(opts: RunRegistryOptions = {}) {
    this.maxCompleted = opts.maxCompleted ?? 32;
  }

  /**
   * Start a run. Returns the run record immediately (status: "running")
   * and executes the runner in the background. The registry builds the
   * Runner per-call with its own onEvent bridge so subscribers get
   * per-test progress.
   *
   * On runner exception, the record is marked "failed" and all
   * subscribers receive no further events.
   */
  start(runnerConfig: RunnerConfig, filter: RunFilter): RunRecord {
    const runId = generateRunId();
    const record: RunRecord = {
      runId,
      status: "running",
      startedAt: new Date().toISOString(),
      progress: { total: 0, done: 0 },
    };
    const subscribers = new Set<RunEventSubscriber>();
    const eventLog: RunnerEvent[] = [];
    this.runs.set(runId, { record, subscribers, eventLog });
    this.order.push(runId);

    // Build the Runner with our onEvent injected. Any subscribers that
    // attach mid-run see every event from that point on; earlier
    // events are NOT replayed. SSE clients should attach before posting
    // the run (or accept the race).
    const runner = new Runner({
      ...runnerConfig,
      onEvent: (evt) => {
        this.updateProgress(runId, evt);
        const cur = this.runs.get(runId);
        if (!cur) return;
        cur.eventLog.push(evt);
        for (const sub of cur.subscribers) {
          try { sub(evt); } catch { /* subscriber error must not break the run */ }
        }
      },
    });

    // Kick off the runner in the background.
    void (async () => {
      try {
        const report = await runner.runMatrix(filter);
        this.complete(runId, report);
      } catch (err) {
        this.fail(runId, err instanceof Error ? err.message : String(err));
      }
    })();

    return record;
  }

  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId)?.record;
  }

  /**
   * Subscribe to RunnerEvents for an in-flight run. Returns an
   * unsubscribe function. Subscribing to a completed run is a no-op
   * (returns a no-op unsubscriber) — the caller should check
   * `get(runId).status` first.
   *
   * When a subscriber attaches AFTER the run started but before it
   * completes, every RunnerEvent that already fired is replayed
   * synchronously through `sub` before the function returns. This
   * closes the race where a client POST /runs → GET /stream sequence
   * would miss the "run-start" event that fired on the POST response
   * path.
   */
  subscribe(runId: string, sub: RunEventSubscriber): () => void {
    const entry = this.runs.get(runId);
    if (!entry || entry.record.status !== "running") {
      return () => {};
    }
    // Replay the event log so the subscriber sees everything from the
    // start of this run. Do it BEFORE registering so the replay
    // happens in-order with no duplicate "current live event" firing.
    for (const evt of entry.eventLog) {
      try { sub(evt); } catch { /* ignore — don't break attach on a single bad handler */ }
    }
    entry.subscribers.add(sub);
    return () => { entry.subscribers.delete(sub); };
  }

  /** Enumerate all runs, oldest first. Clones to insulate consumers. */
  list(): readonly RunRecord[] {
    return this.order.map((id) => this.runs.get(id)!.record);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private updateProgress(runId: string, evt: RunnerEvent): void {
    const entry = this.runs.get(runId);
    if (!entry) return;
    let next = entry.record;
    if (evt.type === "run-start") {
      next = { ...entry.record, progress: { total: evt.total, done: 0 } };
    } else if (evt.type === "test-end") {
      next = {
        ...entry.record,
        progress: {
          total: entry.record.progress.total,
          done: entry.record.progress.done + 1,
        },
      };
    }
    entry.record = next;
  }

  private complete(runId: string, report: RunReport): void {
    const entry = this.runs.get(runId);
    if (!entry) return;
    entry.record = {
      ...entry.record,
      status: "completed",
      finishedAt: new Date().toISOString(),
      report,
      progress: { total: report.results.length, done: report.results.length },
    };
    entry.subscribers.clear();
    entry.eventLog.length = 0; // final report covers everything; free memory
    this.evictIfNeeded();
  }

  private fail(runId: string, error: string): void {
    const entry = this.runs.get(runId);
    if (!entry) return;
    entry.record = {
      ...entry.record,
      status: "failed",
      finishedAt: new Date().toISOString(),
      error,
    };
    entry.subscribers.clear();
    entry.eventLog.length = 0;
    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    // Keep at most maxCompleted completed/failed records. Always keep
    // in-flight. Evict oldest completed/failed first.
    const completed: string[] = [];
    for (const id of this.order) {
      const r = this.runs.get(id);
      if (r && (r.record.status === "completed" || r.record.status === "failed")) {
        completed.push(id);
      }
    }
    while (completed.length > this.maxCompleted) {
      const oldest = completed.shift()!;
      this.runs.delete(oldest);
      const idx = this.order.indexOf(oldest);
      if (idx >= 0) this.order.splice(idx, 1);
    }
  }
}

function generateRunId(): string {
  // Timestamp + 6 hex chars of entropy. Readable in logs, URL-safe.
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  const rand = Math.random().toString(16).slice(2, 8);
  return `${ts}-${rand}`;
}
