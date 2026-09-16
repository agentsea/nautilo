import { V2_LIMITS, assertV2Limit } from "../v2-types/limits.ts";
import { MAX_METADATA_BYTES } from "./device-transfer-common-v2.ts";

const FRAME_LENGTH_BYTES = 4;

function checkedAggregate(
  parts: readonly number[],
): number {
  let total = 0;
  for (const part of parts) {
    assertV2Limit(
      "Device transfer approval aggregate component bytes",
      part,
      V2_LIMITS.recoveryArchiveBytes,
    );
    total += part;
    assertV2Limit(
      "Device transfer approval aggregate bytes",
      total,
      V2_LIMITS.recoveryArchiveBytes,
    );
  }
  return total;
}

/**
 * Internal resource-accounting seam. It remains outside the public v2 barrel
 * so the pre-HPKE aggregate guard can be tested without allocating 64 MiB.
 */
export function deviceTransferApprovalBasePredictionV2(
  joinWireBytes: readonly number[],
): number {
  assertV2Limit(
    "Device transfer join count",
    joinWireBytes.length,
    V2_LIMITS.recoveryPackages,
  );
  return checkedAggregate([
    MAX_METADATA_BYTES,
    FRAME_LENGTH_BYTES,
    V2_LIMITS.signatureBytes,
    ...joinWireBytes.flatMap((length) => [
      FRAME_LENGTH_BYTES,
      length,
    ]),
  ]);
}

export function advanceDeviceTransferApprovalPredictionV2(
  currentBytes: number,
  packageMetadataBytes: number,
  ciphertextBytes: number,
): number {
  return checkedAggregate([
    currentBytes,
    FRAME_LENGTH_BYTES,
    packageMetadataBytes,
    FRAME_LENGTH_BYTES,
    ciphertextBytes,
  ]);
}
