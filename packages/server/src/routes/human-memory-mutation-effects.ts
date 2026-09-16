import type {
  ForegroundMemoryEffectReceiptStatus,
} from "./foreground-memory-effect-receipts";
import type {
  ProtectedMemoryRouteAuthority,
  ProtectedMemoryRoutePorts,
} from "./protected-memory-composition";

/** Publication is final before effect delivery begins. A lost notification
 * keeps the original mutation identity and its pending receipt; it is never
 * an instruction to perform the write again. Replays also retry the effect. */
export function withHumanMemoryMutationEffects(input: Readonly<{
  ports: ProtectedMemoryRoutePorts;
  deliver: (request: Readonly<{
    authority: ProtectedMemoryRouteAuthority;
    operationId: string;
    memoryId: string;
  }>) => Promise<ForegroundMemoryEffectReceiptStatus>;
  wakeRecovery: () => void;
}>): ProtectedMemoryRoutePorts {
  const after = async <Result extends object>(
    result: Result,
    request: Parameters<typeof input.deliver>[0],
  ): Promise<Result & { followUpPending?: true }> => {
    if ("reason" in result
      && !("status" in result && result.status === "ordinary_fallback")) return result;
    try {
      if (await input.deliver(request) !== "pending") return result;
    } catch {
      // The committed result remains valid even if this connection disappeared.
    }
    try { input.wakeRecovery(); } catch { /* Durable receipt survives the wake. */ }
    return Object.freeze({ ...result, followUpPending: true });
  };
  return Object.freeze({
    ...(input.ports.embeddingConfiguration === undefined ? {} : {
      embeddingConfiguration: input.ports.embeddingConfiguration,
    }),
    planCreate: input.ports.planCreate.bind(input.ports),
    list: input.ports.list.bind(input.ports),
    detail: input.ports.detail.bind(input.ports),
    search: input.ports.search.bind(input.ports),
    brief: input.ports.brief.bind(input.ports),
    planAccess: input.ports.planAccess.bind(input.ports),
    async createPrepared(request) {
      return after(await input.ports.createPrepared(request), {
        authority: request.authority,
        operationId: request.prepared.operationId,
        memoryId: request.prepared.memoryId,
      });
    },
    async updatePrepared(request) {
      return after(await input.ports.updatePrepared(request), {
        authority: request.authority,
        operationId: request.prepared.operationId,
        memoryId: request.memoryId,
      });
    },
    async archive(request) { return after(await input.ports.archive(request), request); },
    async transitionTier(request) { return after(await input.ports.transitionTier(request), request); },
    async restore(request) { return after(await input.ports.restore(request), request); },
    async commitAccess(request) {
      return after(await input.ports.commitAccess(request), {
        authority: request.authority,
        operationId: request.prepared.operationId,
        memoryId: request.memoryId,
      });
    },
  } satisfies ProtectedMemoryRoutePorts);
}
