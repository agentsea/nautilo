import type {
  RecallRecordFreshness,
  RecallRecordView,
  RecallRecordsPort,
  RecallRecordsUnavailableReason,
} from "@nautilo/agent";
import {
  RECORD_SEARCH_POLICY_V1,
  type RecordEvidencePort,
  type RecordSearchPort,
} from "@nautilo/reflection/search";

function freshness(
  lifecycle: "current" | "stale" | "superseded" | "resolved" | "sunset",
): RecallRecordFreshness {
  return lifecycle === "current" ? "current" : lifecycle === "stale" ? "stale" : "dirty";
}

function view(input: Readonly<{
  recordRef: string;
  statement: string;
  structuralHeight: number;
  lifecycle: "current" | "stale" | "superseded" | "resolved" | "sunset";
}>): RecallRecordView {
  return {
    recordRef: input.recordRef,
    statement: input.statement,
    structuralHeight: input.structuralHeight,
    freshness: freshness(input.lifecycle),
  };
}

function mapUnavailable(reason: string): RecallRecordsUnavailableReason {
  switch (reason) {
    case "stale_restart": return "invalid_continuation";
    case "source_changed": return "changed";
    case "unauthorized": return "revoked";
    case "purged": return "purged";
    case "capacity_exceeded": return "bounded";
    case "source_unavailable": return "not_found";
    case "blocked": return "revoked";
    default: return "temporarily_unavailable";
  }
}

function evidenceKind(kind: string): "memory" | "observation" | "message" {
  if (kind === "memory") return "memory";
  if (kind === "message") return "message";
  return "observation";
}

/** Bind the model-facing tool to one already-authorized Room search/evidence pair. */
export function createForegroundRecordRecallPort(input: Readonly<{
  bindingRef: string;
  search: RecordSearchPort;
  evidence: RecordEvidencePort;
}>): RecallRecordsPort & Readonly<{
  searchStructural(request: Parameters<RecallRecordsPort["search"]>[0]): Promise<Readonly<{
    status: "ok";
    records: readonly Readonly<{
      representation: "structural";
      recordRef: string;
      structuralHeight: number;
    }>[];
    continuation?: string;
  }> | Readonly<{ status: "unavailable"; reason: RecallRecordsUnavailableReason }>>;
}> {
  return Object.freeze({
    async searchStructural(request: Parameters<RecallRecordsPort["search"]>[0]) {
      if (input.search.searchStructural === undefined) {
        return { status: "unavailable" as const, reason: "temporarily_unavailable" as const };
      }
      const result = await input.search.searchStructural({
        query: request.query,
        limit: request.limit,
        searchBindingRef: input.bindingRef,
        ...(request.continuation === undefined ? {} : { continuation: request.continuation }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (result.status === "unavailable") {
        return { status: "unavailable" as const, reason: mapUnavailable(result.reason) };
      }
      return {
        status: "ok" as const,
        records: result.results.map((record) => ({
          representation: "structural" as const,
          recordRef: record.recordRef,
          structuralHeight: record.structuralHeight,
        })),
        ...(result.continuation === undefined
          ? {}
          : { continuation: result.continuation }),
      };
    },
    async search(request: Parameters<RecallRecordsPort["search"]>[0]) {
      const result = await input.search.search({
        query: request.query,
        limit: request.limit,
        searchBindingRef: input.bindingRef,
        ...(request.continuation === undefined
          ? {}
          : { continuation: request.continuation }),
      });
      if (result.status === "unavailable") {
        return { status: "unavailable" as const, reason: mapUnavailable(result.reason) };
      }
      return {
        status: "ok" as const,
        records: result.results.map(view),
        ...(result.continuation === undefined ? {} : { continuation: result.continuation }),
      };
    },

    async expand(request: Parameters<RecallRecordsPort["expand"]>[0]) {
      const result = await input.evidence.expand({
        rootRecordRef: request.recordRef,
        evidenceBindingRef: input.bindingRef,
        traversalWorkLimit: RECORD_SEARCH_POLICY_V1.traversalWorkMaximum,
        openedPayloadBytesLimit:
          RECORD_SEARCH_POLICY_V1.openedRecordPayloadBytesMaximum,
        returnedBytesLimit: RECORD_SEARCH_POLICY_V1.returnedBytesMaximum,
        ...(request.continuation === undefined
          ? {}
          : { continuation: request.continuation }),
      });
      if (result.status === "unavailable") {
        return { status: "unavailable" as const, reason: mapUnavailable(result.reason) };
      }
      const root = result.nodes.find((node) => node.depth === 0);
      if (root === undefined) {
        return { status: "unavailable" as const, reason: "temporarily_unavailable" as const };
      }
      return {
        status: "ok" as const,
        record: view(root),
        evidence: [
          ...result.nodes
            .filter((node) => node.depth === 1)
            .map((node) => ({ kind: "record" as const, record: view(node) })),
          ...result.sources.map((source) => ({
            kind: evidenceKind(source.kind),
            availability: "current" as const,
            body: source.content,
          })),
        ],
        ...(result.continuation === undefined ? {} : { continuation: result.continuation }),
      };
    },
  });
}
