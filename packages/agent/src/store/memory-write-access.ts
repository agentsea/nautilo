/**
 * M076 + M082 — Pure overlap check for memory mutations (no DB / config imports).
 * Lives in its own module so unit tests can import it without loading
 * `memory-store.ts` (which eagerly binds `@nautilo/db` and embeddings).
 */

/** D234 — security-audit JSONL sink wired by the server at route registration. */
export type MemoryAuditEditAction =
  | "save"
  | "replace"
  | "demote"
  | "promote"
  | "patch";

export type MemoryAuditDeleteMode = "archive" | "hard";

export type MemoryAuditSinkInput = {
  readonly kind: "memory.edit" | "memory.delete";
  /** Stable receipt mutation identity for replayed background delivery. */
  readonly operationId?: string;
  readonly memoryId: string;
  readonly outcome: "success" | "failure";
  readonly action?: MemoryAuditEditAction;
  readonly mode?: MemoryAuditDeleteMode;
  readonly errorKind?: string;
  readonly namespaceId?: string;
  readonly scopeId?: string;
  readonly actorId: string | null;
  readonly ip: string;
  readonly userAgent?: string | undefined;
};

let memoryAuditSink: ((evt: MemoryAuditSinkInput) => void) | null = null;

export function setMemoryAuditSink(
  sink: ((evt: MemoryAuditSinkInput) => void) | null,
): void {
  memoryAuditSink = sink;
}

export function emitMemoryAudit(evt: MemoryAuditSinkInput): void {
  if (!memoryAuditSink) return;
  memoryAuditSink(evt);
}

export type MemoryAuditMeta = {
  readonly actorId?: string | null;
  readonly ip?: string;
  readonly userAgent?: string | undefined;
};

export function memoryAuditMetaFromTrust(trust?: {
  userId?: string | undefined;
  auditActorId?: string | null | undefined;
  auditIp?: string | undefined;
  auditUserAgent?: string | undefined;
}): MemoryAuditMeta {
  return {
    actorId: trust?.auditActorId ?? trust?.userId ?? null,
    ip: trust?.auditIp ?? "",
    userAgent: trust?.auditUserAgent,
  };
}

function auditFields(meta?: MemoryAuditMeta): Pick<
  MemoryAuditSinkInput,
  "actorId" | "ip" | "userAgent"
> {
  return {
    actorId: meta?.actorId ?? null,
    ip: meta?.ip ?? "",
    userAgent: meta?.userAgent,
  };
}

export async function withMemoryAudit<T>(
  evt: Omit<MemoryAuditSinkInput, "outcome" | "actorId" | "ip" | "userAgent">,
  meta: MemoryAuditMeta | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    const result = await fn();
    emitMemoryAudit({ ...evt, outcome: "success", ...auditFields(meta) });
    return result;
  } catch (err) {
    emitMemoryAudit({
      ...evt,
      outcome: "failure",
      errorKind: err instanceof Error ? err.name : "Error",
      ...auditFields(meta),
    });
    throw err;
  }
}

/**
 * M082: overlap semantics — the caller may mutate a memory iff their
 * mutable namespace ids intersect the memory's attached namespaces.
 * No-op when `mutableNamespaceIds` is empty/undefined (backward compat).
 */
export function assertNamespaceWriteAccess(
  memoryNamespaceIds: string[],
  mutableNamespaceIds: string[] | undefined,
  memoryId: string,
): void {
  if (!mutableNamespaceIds || mutableNamespaceIds.length === 0) return;
  if (memoryNamespaceIds.length === 0) {
    throw new Error(`Memory ${memoryId} has no namespace attachments`);
  }
  const overlap = memoryNamespaceIds.some((ns) => mutableNamespaceIds.includes(ns));
  if (!overlap) {
    throw new Error(`Memory ${memoryId} is in a namespace you cannot write to`);
  }
}

/** Receipt recovery must observe unavailable or failed audit delivery. */
export function deliverMemoryAudit(evt: MemoryAuditSinkInput): void {
  if (!memoryAuditSink) throw new Error("memory_audit_unavailable");
  memoryAuditSink(evt);
}
