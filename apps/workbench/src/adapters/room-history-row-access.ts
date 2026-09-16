import {
  ClassifiedDataOperationError,
  classifyDataOperationFailure,
  type DataOperationFailureClass,
  type EncryptionDataOperationOwner,
} from "@nautilo/lattice-bridge";
import type { VaultRoomHistoryShadowReadResultV1 } from "@nautilo/lattice-bridge/client/browser";
import {
  projectAuthenticatedRoomHistoryPayload,
  type StoredSessionMessageDto,
} from "./session-rehydrate";

type Result = VaultRoomHistoryShadowReadResultV1["records"][number];
type Coordinate = Readonly<{ messageId: string; editRevision: number }>;
const key = (row: Coordinate) => `${row.messageId}\u0000${String(row.editRevision)}`;

function recordFailure(result: Extract<Result, { status: "fallback" }>): DataOperationFailureClass {
  switch (result.reason) {
    case "integrity_failure":
    case "parity_mismatch": return "integrity";
    case "current_read_authority_unavailable":
    case "retained_key_material_unavailable":
    case "client_custody_unavailable": return "key_waiting";
    case "client_crypto_unavailable":
    case "signer_evidence_unavailable":
    case "live_shadow_lifecycle_unavailable": return "recoverable_availability";
  }
}

/** Selection/identity belongs here; representation and eligibility belong to
 * the shared owner. An unavailable row never discards another verified row. */
export async function consumeRoomHistoryRows(
  owner: EncryptionDataOperationOwner,
  messages: readonly StoredSessionMessageDto[],
  results: readonly Result[],
  options: Readonly<{
    requireVerified?: boolean;
    pageFailure?: DataOperationFailureClass;
    expectedResults?: readonly Coordinate[];
  }> = {},
): Promise<readonly StoredSessionMessageDto[]> {
  const indexed = new Map<string, Result[]>();
  for (const result of results) {
    const coordinate = key(result);
    const matches = indexed.get(coordinate) ?? [];
    matches.push(result);
    indexed.set(coordinate, matches);
  }
  const expected = new Set(options.expectedResults?.map(key));
  const output: StoredSessionMessageDto[] = [];
  for (const row of messages) {
    const coordinate = key({ messageId: row.id, editRevision: row.editRevision ?? 0 });
    try {
      const consumed = await owner.read({
        ordinary: () => {
          // Exact protected edit/key recovery may never mistake the supplied
          // structural placeholder for an ordinary sibling.
          if (options.requireVerified || typeof row.content !== "string"
            || row.content === "Encrypted history is unavailable on this device.") {
            throw new ClassifiedDataOperationError("key_waiting", "Room history needs authenticated content");
          }
          return Promise.resolve(row);
        },
        protected: () => {
          if (options.pageFailure !== undefined) throw new ClassifiedDataOperationError(
            options.pageFailure, "Protected Room history is unavailable",
          );
          const matches = indexed.get(coordinate);
          if (matches === undefined) throw new ClassifiedDataOperationError(
            expected.has(coordinate) ? "integrity" : "key_waiting",
            "Room history has no authenticated result for the selected revision",
          );
          if (matches.length !== 1) throw new ClassifiedDataOperationError(
            "integrity", "Room history verification returned duplicate coordinates",
          );
          const result = matches[0];
          if (result.status === "fallback") throw new ClassifiedDataOperationError(
            recordFailure(result), "Room history could not authenticate the selected revision",
          );
          if (result.payload.role !== row.role) throw new ClassifiedDataOperationError(
            "integrity", "Room history authenticated a different role",
          );
          return Promise.resolve(result.payload);
        },
        consumeOrdinary: (ordinary) => ordinary,
        consumeProtected: (payload) => projectAuthenticatedRoomHistoryPayload(row, payload),
      });
      output.push(consumed.value);
    } catch (error) {
      const failure = classifyDataOperationFailure(error);
      // Account/policy/cancellation fences reject the whole stale operation,
      // not a seemingly successful page of placeholders.
      if (options.requireVerified || failure === "authority" || failure === "stale"
        || failure === "cancelled" || failure === "unknown") throw error;
      output.push(Object.freeze({
        ...row,
        content: "Encrypted history is unavailable on this device.",
        historyUnavailable: true,
        historyUnavailableReason: failure,
        toolCalls: row.role === "assistant" ? "[]" : row.toolCalls,
      }));
    }
  }
  return Object.freeze(output);
}
