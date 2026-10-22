import type { LatticeCrypto } from "../crypto/index.ts";
import {
  decodeTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
  type TaskRuntimeBackgroundAuthorizationRequestV1,
} from "./task-runtime-request-v1.ts";
import {
  decodeTaskRuntimeBackgroundAuthorizationRequestV2,
  destroyTaskRuntimeBackgroundAuthorizationRequestV2,
  isTaskRuntimeBackgroundAuthorizationRequestV2Carrier,
} from "./task-runtime-request-v2.ts";
import {
  decodeTaskRuntimeBackgroundAuthorizationRequestV3,
  destroyTaskRuntimeBackgroundAuthorizationRequestV3,
  isTaskRuntimeBackgroundAuthorizationRequestV3Carrier,
} from "./task-runtime-request-v3.ts";

/**
 * Decode only the common Task Runtime admission coordinates.
 *
 * A recognized certified carrier is always decoded as its owned format first.
 * Malformed carrier bytes never fall through to the legacy decoder, while a
 * valid request returns an independently owned V1 projection for existing
 * admission owners.
 */
export function decodeTaskRuntimeBackgroundAuthorizationRequestBase(
  crypto: Pick<LatticeCrypto, "hash">,
  bytes: Uint8Array,
): TaskRuntimeBackgroundAuthorizationRequestV1 | null {
  const v2 = isTaskRuntimeBackgroundAuthorizationRequestV2Carrier(bytes);
  const v3 = isTaskRuntimeBackgroundAuthorizationRequestV3Carrier(bytes);
  if (!v2 && !v3) {
    return decodeTaskRuntimeBackgroundAuthorizationRequestV1(bytes);
  }
  const request = v2
    ? decodeTaskRuntimeBackgroundAuthorizationRequestV2(crypto, bytes)
    : decodeTaskRuntimeBackgroundAuthorizationRequestV3(crypto, bytes);
  if (request === null) return null;
  let encoded: Uint8Array | undefined;
  try {
    encoded = encodeTaskRuntimeBackgroundAuthorizationRequestV1(
      request.baseRequest,
    );
    return decodeTaskRuntimeBackgroundAuthorizationRequestV1(encoded);
  } finally {
    encoded?.fill(0);
    if (request.formatVersion === 2) {
      destroyTaskRuntimeBackgroundAuthorizationRequestV2(request);
    } else {
      destroyTaskRuntimeBackgroundAuthorizationRequestV3(request);
    }
  }
}
