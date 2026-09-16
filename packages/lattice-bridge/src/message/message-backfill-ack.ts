import { sha256 } from "@noble/hashes/sha2.js";
import {
  messageBackfillClaimSchema,
  type MessageBackfillAckRequest,
  type MessageBackfillClaim,
} from "@nautilo/api-client/browser";

const encoder = new TextEncoder();

/** Zod reconstructs this closed object in schema order; caller key order is irrelevant. */
export function messageBackfillClaimDigest(claim: MessageBackfillClaim): Uint8Array {
  return sha256(encoder.encode(JSON.stringify([
    "nautilo/message-backfill/claim/v1", messageBackfillClaimSchema.parse(claim),
  ])));
}

/** A singleton witness binds both independent source bytes and the opened manifest. */
export function messageBackfillAcknowledgementDigest(
  value: Omit<MessageBackfillAckRequest, "signatureBase64url">,
): Uint8Array {
  return sha256(encoder.encode(JSON.stringify([
    "nautilo/message-backfill/acknowledgement/v1", value.claimId,
    value.outcome, value.claimDigestBase64url, value.sourceDigestBase64url,
    value.manifestDigestBase64url,
  ])));
}
