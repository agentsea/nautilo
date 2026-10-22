import { sha256 } from "@noble/hashes/sha2.js";
import { encodeMessagePayloadV2 } from "@nautilo/lattice-bridge";
import {
  lockExactProtectedTaskMessageAllocation,
  type LockedProtectedTaskMessageAllocation,
} from "./protected-task-message-allocation";
import type { ProtectedTaskOutputReadClosedProof } from "./protected-task-output-read-product";

export type LockedProtectedTaskRunResultMessageAllocation = LockedProtectedTaskMessageAllocation;

/** Read the existing allocation without decrypting the retained result or Message. */
export function lockExactProtectedTaskRunResultMessageAllocation(input:
  Omit<Parameters<typeof lockExactProtectedTaskMessageAllocation>[0],
    "intent" | "sessionId" | "shadowContentMatches"> & Readonly<{
      intent: ProtectedTaskOutputReadClosedProof;
      destinationNamespaceId: string;
    }>,
): Promise<LockedProtectedTaskRunResultMessageAllocation | null> {
  const { intent } = input;
  if (intent.invocation.kind !== "raw" || intent.result.contentRevision !== 1
    || intent.result.terminalStatus === "cancelled"
    || input.expectedPayloadDigest.length !== 32) {
    throw new TypeError("Task result Message allocation requires a raw revision-one result");
  }
  return lockExactProtectedTaskMessageAllocation({ ...input,
    intent: {
      representation: intent.representation,
      acceptedPolicyRevision: intent.acceptedPolicyRevision,
      destinationRoomId: intent.invocation.roomId,
      destinationNamespaceId: input.destinationNamespaceId,
      messageOperationId: intent.invocation.operationId,
    },
    sessionId: intent.invocation.sessionId,
    shadowContentMatches: content => {
      const digest = sha256(encodeMessagePayloadV2({ role: "assistant", content }));
      return digest.every((byte, index) => byte === input.expectedPayloadDigest[index]);
    },
  });
}
