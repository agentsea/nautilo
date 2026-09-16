import type {
  ForegroundRecordContextPort,
  ForegroundRecordSelectionResult,
} from "@nautilo/reflection/foreground";
import type { RecordSearchPort } from "@nautilo/reflection/search";

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Narrow first-page projection over Wave 8's exact authority-filtered search.
 * The binding is already invocation-scoped; no evidence or continuation is
 * opened for automatic foreground context.
 */
export function createForegroundRecordContextPort(input: Readonly<{
  readonly bindingRef: string;
  readonly representation: "ordinary" | "protected";
  readonly search: RecordSearchPort;
}>): ForegroundRecordContextPort {
  return Object.freeze({
    representation: input.representation,
    async select(
      request: Parameters<ForegroundRecordContextPort["select"]>[0],
    ): Promise<ForegroundRecordSelectionResult> {
      if (isAborted(request.signal)) {
        return {
          status: "unavailable",
          representation: input.representation,
          queryEmbeddingStatus: "unavailable",
          reason: "cancelled",
        };
      }
      try {
        const response = await input.search.search({
          query: request.query,
          limit: request.limit,
          searchBindingRef: input.bindingRef,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        if (response.status === "unavailable") {
          return {
            status: "unavailable",
            representation: input.representation,
            queryEmbeddingStatus: response.reason === "embedding_unavailable"
              ? "unavailable"
              : "available",
            reason: isAborted(request.signal)
              ? "cancelled"
              : response.reason,
          };
        }
        if (response.results.some((record) => record.lifecycle === "sunset")) {
          return {
            status: "unavailable",
            representation: input.representation,
            queryEmbeddingStatus: "available",
            reason: "integrity_failure",
          };
        }
        return {
          status: "available",
          representation: input.representation,
          queryEmbeddingStatus: "available",
          candidateCount: response.results.length,
          records: response.results.map((record) => ({
            recordRef: record.recordRef,
            statement: record.statement,
            lifecycle: record.lifecycle as Exclude<typeof record.lifecycle, "sunset">,
            structuralHeight: record.structuralHeight,
          })),
        };
      } catch {
        return {
          status: "unavailable",
          representation: input.representation,
          queryEmbeddingStatus: "unavailable",
          reason: isAborted(request.signal)
            ? "cancelled"
            : "internal_error",
        };
      }
    },
    ...(input.search.searchStructural === undefined ? {} : {
      async selectStructural(
        request: Parameters<NonNullable<ForegroundRecordContextPort["selectStructural"]>>[0],
      ) {
        const response = await input.search.searchStructural!({
          query: request.query,
          limit: request.limit,
          searchBindingRef: input.bindingRef,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        if (response.status === "unavailable") return {
          status: "unavailable" as const,
          representation: "protected" as const,
          queryEmbeddingStatus: response.reason === "embedding_unavailable"
            ? "unavailable" as const : "available" as const,
          reason: response.reason,
        };
        return {
          status: "available" as const,
          representation: "protected" as const,
          queryEmbeddingStatus: "available" as const,
          candidateCount: response.results.length,
          records: response.results.map((record) => ({
            representation: "structural" as const,
            recordRef: record.recordRef,
            structuralHeight: record.structuralHeight,
          })),
        };
      },
    }),
  });
}
