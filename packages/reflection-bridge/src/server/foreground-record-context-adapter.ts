import type {
  ForegroundRecordContextPort,
  ForegroundRecordContextItemV1,
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
  /** Reopens an ordinary result through the canonical Record repository. */
  readonly reopenOrdinaryRecord?: (
    recordRef: string,
  ) => Promise<ForegroundRecordContextItemV1 | null>;
}>): ForegroundRecordContextPort {
  return Object.freeze({
    representation: input.representation,
    ...(input.representation !== "ordinary" || input.reopenOrdinaryRecord === undefined
      ? {}
      : { reopenOrdinaryRecord: input.reopenOrdinaryRecord }),
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
        const records: ForegroundRecordContextItemV1[] = [];
        for (const record of response.results) {
          const reopened = input.representation === "ordinary"
            ? await input.reopenOrdinaryRecord?.(record.recordRef)
            : undefined;
          if (reopened === null || (
            reopened !== undefined
            && (
              reopened.recordRef !== record.recordRef
              || reopened.statement !== record.statement
              || reopened.lifecycle !== record.lifecycle
              || reopened.structuralHeight !== record.structuralHeight
              || reopened.modelExposureDependency === undefined
            )
          )) {
            return {
              status: "unavailable",
              representation: input.representation,
              queryEmbeddingStatus: "available",
              reason: "integrity_failure",
            };
          }
          records.push(reopened ?? {
            recordRef: record.recordRef,
            statement: record.statement,
            lifecycle: record.lifecycle as Exclude<typeof record.lifecycle, "sunset">,
            structuralHeight: record.structuralHeight,
          });
        }
        return {
          status: "available",
          representation: input.representation,
          queryEmbeddingStatus: "available",
          candidateCount: response.results.length,
          records,
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
