import type { BoardRecoveryBridge, BoardRecoveryDraft } from "./board-bridge";

function nullableRevision(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

const RECOVERY_KEYS = ["version", "content", "exact", "baseSha256", "baseRevision"] as const;
const SHA256 = /^[a-f0-9]{64}$/u;

export function parseBoardRecoveryDraft(value: unknown): BoardRecoveryDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The recovery copy is invalid. It has been kept for recovery.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== RECOVERY_KEYS.length || RECOVERY_KEYS.some(key => !Object.hasOwn(record, key))
    || record.version !== 1 || typeof record.content !== "string" || typeof record.exact !== "boolean"
    || !(record.baseSha256 === null || (typeof record.baseSha256 === "string" && SHA256.test(record.baseSha256)))
    || !nullableRevision(record.baseRevision)) {
    throw new Error("The recovery copy is invalid. It has been kept for recovery.");
  }
  return { version: 1, content: record.content, exact: record.exact, baseSha256: record.baseSha256, baseRevision: record.baseRevision };
}

/** Independent of network saves. Keep one in-flight snapshot and the newest
 * pending snapshot; compare-and-swap also fences other open editor instances. */
export class BoardRecovery {
  private revision: string | null = null;
  private ready = false;
  private pending: BoardRecoveryDraft | null | undefined;
  private running?: Promise<void>;

  constructor(private readonly bridge: BoardRecoveryBridge) {}

  async read(): Promise<BoardRecoveryDraft | null> {
    const result = await this.bridge.read();
    if (!result || !(result.revision === null || typeof result.revision === "string")) throw new Error("The recovery receipt is invalid.");
    const draft = result.draft === null ? null : parseBoardRecoveryDraft(result.draft);
    this.revision = result.revision;
    this.ready = true;
    return draft;
  }

  update(draft: BoardRecoveryDraft | null): Promise<void> {
    if (!this.ready) return Promise.reject(new Error("Crash recovery is unavailable. Keep this board open until it saves."));
    // A later edit may retry a failed I/O attempt, always against the same
    // receipt. Never adopt another editor's revision after a conflict.
    this.pending = draft;
    // Start after assigning running. drain releases it synchronously at its
    // last pending check, so an intervening update cannot strand a snapshot.
    this.running ??= Promise.resolve().then(() => this.drain());
    return this.running;
  }

  private async drain(): Promise<void> {
    try {
      let lastFailure: Error | undefined;
      while (this.pending !== undefined) {
        const draft = this.pending;
        this.pending = undefined;
        try {
          const result = await this.bridge.write({ expectedRevision: this.revision, draft });
          if (!result || !(result.revision === null || typeof result.revision === "string")) throw new Error("The recovery receipt is invalid.");
          this.revision = result.revision;
          lastFailure = undefined;
        } catch (error) {
          lastFailure = error instanceof Error ? error : new Error(String(error));
        }
      }
      if (lastFailure) throw lastFailure;
    } finally {
      // Retain the expected revision on every failure, including CAS conflicts.
      this.running = undefined;
    }
  }
}
