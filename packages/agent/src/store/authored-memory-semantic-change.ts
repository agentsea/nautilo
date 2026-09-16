import { randomUUID } from "node:crypto";

export type AuthoredMemorySemanticChangeKind =
  | "replace"
  | "demote"
  | "archive"
  | "restore"
  | "scope"
  | "delete";

export type AuthoredMemorySemanticChange = Readonly<{
  memoryId: string;
  changeKind: AuthoredMemorySemanticChangeKind;
  /** Content-free, per-success identity used only for durable admission replay. */
  changeRef: string;
}>;

export type AuthoredMemorySemanticChangeSink = (
  change: AuthoredMemorySemanticChange,
) => Promise<void>;

let installed: Readonly<{
  token: symbol;
  sink: AuthoredMemorySemanticChangeSink;
}> | null = null;

/** One process-local bridge-owned sink; installing twice is a composition error. */
export function installAuthoredMemorySemanticChangeSink(
  sink: AuthoredMemorySemanticChangeSink,
): () => void {
  if (installed !== null) {
    throw new Error("authored Memory semantic-change sink is already installed");
  }
  const token = Symbol("authored-memory-semantic-change");
  installed = { token, sink };
  return () => {
    if (installed?.token === token) installed = null;
  };
}

/**
 * Notify only after the canonical mutation succeeded. Admission failure cannot
 * roll back or misreport an already committed Memory change; the durable
 * repair cursor remains the recovery owner.
 */
export async function emitAuthoredMemorySemanticChange(
  memoryId: string,
  changeKind: AuthoredMemorySemanticChangeKind,
  replayStableChangeRef?: string,
): Promise<void> {
  const sink = installed?.sink;
  if (sink === undefined) return;
  try {
    await sink(Object.freeze({
      memoryId,
      changeKind,
      changeRef: replayStableChangeRef === undefined
        ? `memory-change:${randomUUID()}`
        : `memory-change:stable:${replayStableChangeRef}`,
    }));
  } catch {
    // The canonical Memory mutation already committed. Recovery is adapter-owned.
  }
}

export function _resetAuthoredMemorySemanticChangeSinkForTests(): void {
  installed = null;
}

/** Durable receipt owner retries this acknowledged delivery, never the committed mutation. */
export async function deliverAuthoredMemorySemanticChange(change: AuthoredMemorySemanticChange): Promise<void> {
  if (!installed) throw new Error("memory_semantic_change_unavailable");
  await installed.sink(Object.freeze(change));
}
