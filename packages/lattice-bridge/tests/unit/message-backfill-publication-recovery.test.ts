import {expect, test} from "bun:test";
import {LatticeCrypto} from "@nautilo/lattice-crypto";
import {recoverReservedMessageBackfillPublication} from "../../src/server/message/message-backfill-authority";

// Test the production recovery ordering, with the persistence/authority ports
// supplied by its caller. A stored object must never reach pending-source reset.
test.each([false, true])("changed Tool source resets only an absent protected object (stored=%s)", async stored => {
  const crypto = new LatticeCrypto();
  const oldDigest = crypto.hash(new TextEncoder().encode("old call"));
  const newDigest = crypto.hash(new TextEncoder().encode("new call"));
  const payloadBytes = Uint8Array.of(1, 2, 3);
  let resets = 0;
  type Input = Parameters<typeof recoverReservedMessageBackfillPublication>[0];
  const input = {
    crypto,
    claim: {coordinate: {sessionId: "session", messageId: 42, revision: 0, role: "tool", namespaceId: "namespace"},
      cryptoObjectId: "object", keyClass: "human", sourceRevision: 7},
    sourceDigest: newDigest,
    product: {
      getRevision: async () => ({lifecycle: {cryptoObjectId: "object", keyClass: "human",
        namespaceIdAtAllocation: "namespace", repairIdentityDigest: oldDigest, allocationRequestDigest: oldDigest}}),
      refreshPendingToolRepairSource: async (source: {sourceRevision: number; sourceDigest: Uint8Array}) => {
        expect(source.sourceRevision).toBe(7); expect(source.sourceDigest).toEqual(newDigest);
        resets += 1; return "refreshed";
      },
    },
    storage: {getObject: async () => stored ? {payloadBytes} : null},
  } as unknown as Input;
  expect(await recoverReservedMessageBackfillPublication(input)).toBe(stored ? "conflict" : "absent");
  expect(resets).toBe(stored ? 0 : 1);
  if (stored) expect(payloadBytes).toEqual(new Uint8Array(3));
});
