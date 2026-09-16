import type { LaneTurnRegistration } from "./fork-metadata";

type LaneForkState = {
  seqCounter: number;
  /**
   * Highest contiguous sequence whose outcome is reconciled on the lane's
   * commit-ordering contract. Advances when a main turn completes
   * (`markMainCompleted`) or a fork completes (`markForkCompleted`).
   */
  committedSeq: number;
  /**
   * Terminal (completed/failed/cancelled) sequences — main or fork — waiting to
   * advance past earlier unreconciled turns. M170: replaces the old split of
   * `pendingSpliceBySeq` (forks) + `completedMainTerminal` (mains). With the
   * splice gone, a fork's reply already lives in the parent transcript, so a
   * fork completion is just another terminal sequence to advance past.
   */
  completedTerminal: Set<number>;
  /** Active main-lane job (holds the lock in JobManager). */
  activeMain: { jobId: string; seq: number } | null;
  /** Turns not yet fully reconciled (removed when their sequence is committed). */
  turns: Map<number, LaneTurnRegistration>;
  /** M170 — fork checkpoint thread id by sequence, for resume-time advancement. */
  forkCheckpointBySeq: Map<number, string>;
};

/**
 * M085 / M170 — per-thread lane bookkeeping for fork-on-busy commit ordering.
 *
 * M170 removed the checkpoint splice machinery: a fork now rebuilds its history
 * from the DB transcript (M168) and its reply rows are written straight to the
 * parent transcript, so the coordinator no longer touches the graph/checkpoint
 * at all. It retains ONLY the lane/sequence ordering that decides *when* a turn
 * forks (`hasUnreconciledLowerTurns`) and which predecessors are in flight
 * (`getTurnsBeforeSequence`, feeding the R2b marker).
 *
 * In-memory v1: process restart drops lane state (a fork mid-flight at restart
 * loses its ordering slot; the transcript rows it already wrote are unaffected).
 */
class ForkCoordinator {
  private readonly lanes = new Map<string, LaneForkState>();
  /** M170 — fork checkpoint thread id → its lane + sequence (resume-time lookup). */
  private readonly seqByCheckpoint = new Map<string, { laneKey: string; sequence: number }>();

  private lane(laneKey: string): LaneForkState {
    let s = this.lanes.get(laneKey);
    if (!s) {
      s = {
        seqCounter: 0,
        committedSeq: 0,
        completedTerminal: new Set(),
        activeMain: null,
        turns: new Map(),
        forkCheckpointBySeq: new Map(),
      };
      this.lanes.set(laneKey, s);
    }
    return s;
  }

  /** Allocate the next sequence number for a foreground dispatch on this lane (main or fork). */
  nextSequence(laneKey: string): number {
    const s = this.lane(laneKey);
    s.seqCounter += 1;
    return s.seqCounter;
  }

  registerTurn(laneKey: string, turn: LaneTurnRegistration): void {
    const s = this.lane(laneKey);
    s.turns.set(turn.sequence, turn);
    if (turn.kind === "main") {
      s.activeMain = { jobId: turn.jobId, seq: turn.sequence };
    }
  }

  /**
   * Register a fork turn. `forkThreadId` (the `:fork:` checkpoint thread) lets a
   * resume path advance ordering by checkpoint id (`markForkCompletedByCheckpoint`)
   * once the fork's post-resume rows are persisted (R6).
   */
  registerForkTurn(
    laneKey: string,
    turn: Omit<LaneTurnRegistration, "kind"> & { forkThreadId?: string },
  ): void {
    const { forkThreadId, ...rest } = turn;
    this.registerTurn(laneKey, { ...rest, kind: "fork" });
    if (forkThreadId) {
      this.lane(laneKey).forkCheckpointBySeq.set(turn.sequence, forkThreadId);
      this.seqByCheckpoint.set(forkThreadId, { laneKey, sequence: turn.sequence });
    }
  }

  /**
   * R2b — predecessor turns whose sequence is lower than `forkSequence` (in
   * order). Feeds the transient in-flight `[FORK BACKGROUND]` marker so a fork
   * does not redo an in-flight predecessor whose reply hasn't committed yet.
   */
  getTurnsBeforeSequence(laneKey: string, forkSequence: number): LaneTurnRegistration[] {
    const s = this.lanes.get(laneKey);
    if (!s) return [];
    const out: LaneTurnRegistration[] = [];
    for (const [seq, t] of s.turns) {
      if (seq < forkSequence) out.push(t);
    }
    out.sort((a, b) => a.sequence - b.sequence);
    return out;
  }

  getActiveMainJobId(laneKey: string): string | undefined {
    return this.lanes.get(laneKey)?.activeMain?.jobId;
  }

  /**
   * BLOCKER #1 helper. Returns true while any lower-sequence turn (a paused fork,
   * or any registered turn) has not been reconciled yet. The next ordinary
   * main-lane dispatch must route to a fork instead of running on the parent
   * checkpoint until this returns false.
   */
  hasUnreconciledLowerTurns(laneKey: string): boolean {
    const s = this.lanes.get(laneKey);
    if (!s) return false;
    return s.committedSeq < s.seqCounter;
  }

  /** Highest sequence ever issued on this lane (for diagnostics + BLOCKER #1 checks). */
  getSeqCounter(laneKey: string): number {
    return this.lanes.get(laneKey)?.seqCounter ?? 0;
  }

  /** MAJOR #4 — diagnostic predicate for eviction tests. */
  hasLaneForTests(laneKey: string): boolean {
    return this.lanes.has(laneKey);
  }

  /** MAJOR #4 — diagnostic count for eviction tests. */
  getLaneCountForTests(): number {
    return this.lanes.size;
  }

  private maybeEvictLane(laneKey: string, s: LaneForkState): void {
    if (
      s.activeMain === null &&
      s.turns.size === 0 &&
      s.completedTerminal.size === 0 &&
      s.forkCheckpointBySeq.size === 0 &&
      s.seqCounter === s.committedSeq
    ) {
      this.lanes.delete(laneKey);
    }
  }

  /**
   * Called when the main-lane job completes (releases the lane lock).
   * Marks the main sequence terminal and advances contiguous `committedSeq`.
   */
  markMainCompleted(laneKey: string, jobId: string): void {
    const s = this.lane(laneKey);
    if (!s.activeMain || s.activeMain.jobId !== jobId) return;
    const mainSeq = s.activeMain.seq;
    s.activeMain = null;
    s.completedTerminal.add(mainSeq);
    this.advanceCommitted(laneKey);
  }

  /**
   * M170 — called when a fork reaches a terminal outcome (clean completion, or
   * failure/cancellation). The fork's reply rows are already in the parent
   * transcript; this only advances the lane's commit ordering so a later main
   * turn cannot write ahead of this fork (R4). Idempotent and a no-op for an
   * unknown lane or an already-reconciled sequence.
   */
  markForkCompleted(laneKey: string, sequence: number): void {
    const s = this.lanes.get(laneKey);
    if (!s) return;
    if (sequence <= s.committedSeq) {
      this.clearForkCheckpoint(s, sequence);
      return;
    }
    s.completedTerminal.add(sequence);
    this.clearForkCheckpoint(s, sequence);
    this.advanceCommitted(laneKey);
  }

  /**
   * M170 R6 — resume-path convenience: advance ordering for the fork identified
   * by its `:fork:` checkpoint thread. No-op for unknown / non-fork threads, so
   * resume sites can call it unconditionally after a resume settles.
   */
  markForkCompletedByCheckpoint(forkThreadId: string): string | undefined {
    const m = this.seqByCheckpoint.get(forkThreadId);
    if (!m) return undefined;
    this.markForkCompleted(m.laneKey, m.sequence);
    return m.laneKey;
  }

  private clearForkCheckpoint(s: LaneForkState, sequence: number): void {
    const cp = s.forkCheckpointBySeq.get(sequence);
    if (cp !== undefined) {
      s.forkCheckpointBySeq.delete(sequence);
      this.seqByCheckpoint.delete(cp);
    }
  }

  /**
   * Advance `committedSeq` contiguously past every terminal sequence (main or
   * fork). Never skips an unreconciled lower turn, so `hasUnreconciledLowerTurns`
   * keeps routing a contended main turn to a fork until earlier turns reconcile.
   */
  private advanceCommitted(laneKey: string): void {
    const s = this.lane(laneKey);
    for (;;) {
      const next = s.committedSeq + 1;
      if (s.completedTerminal.has(next)) {
        s.completedTerminal.delete(next);
        s.turns.delete(next);
        s.committedSeq = next;
        continue;
      }
      break;
    }
    this.maybeEvictLane(laneKey, s);
  }

  /**
   * Monotonic ordering cursor: highest contiguous sequence reconciled on the
   * lane (tests / diagnostics). An evicted lane returns 0 by contract (it was
   * fully reconciled at eviction, where `committedSeq === seqCounter`).
   */
  getCommittedSeq(laneKey: string): number {
    return this.lanes.get(laneKey)?.committedSeq ?? 0;
  }

  /** Tests — synchronously advance contiguous ordering. */
  advanceCommittedForTests(laneKey: string): void {
    this.advanceCommitted(laneKey);
  }
}

export const forkCoordinator = new ForkCoordinator();
