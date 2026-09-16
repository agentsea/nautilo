export {
  createOwnerClaimTarget,
  OwnerClaimControllerError,
  type CreateOwnerClaimTargetOptions,
  type OwnerClaimControllerFailure,
  type OwnerClaimState,
  type OwnerClaimTarget,
  type OwnerClaimTargetStatus,
  type OwnerClaimTargetTransportPolicy,
} from "@nautilo/compose-lifecycle";

import { createHash } from "node:crypto";

export function hashOwnerClaim(claim: string): string {
  if (!/^inv_[A-Za-z0-9_-]{32}$/.test(claim)) throw new Error("Owner claim is invalid");
  return createHash("sha256").update(claim, "utf8").digest("hex");
}
