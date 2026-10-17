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

/**
 * Decode only the common Task Runtime admission coordinates.
 *
 * A recognized V2 carrier is always decoded as V2 first. Malformed V2 bytes
 * never fall through to the legacy decoder, while a valid V2 request returns
 * an independently owned V1 projection for existing admission owners.
 */
export function decodeTaskRuntimeBackgroundAuthorizationRequestBase(
  crypto: Pick<LatticeCrypto, "hash">,
  bytes: Uint8Array,
): TaskRuntimeBackgroundAuthorizationRequestV1 | null {
  if (!isTaskRuntimeBackgroundAuthorizationRequestV2Carrier(bytes)) {
    return decodeTaskRuntimeBackgroundAuthorizationRequestV1(bytes);
  }
  const request = decodeTaskRuntimeBackgroundAuthorizationRequestV2(
    crypto,
    bytes,
  );
  if (request === null) return null;
  let encoded: Uint8Array | undefined;
  try {
    encoded = encodeTaskRuntimeBackgroundAuthorizationRequestV1(
      request.baseRequest,
    );
    return decodeTaskRuntimeBackgroundAuthorizationRequestV1(encoded);
  } finally {
    encoded?.fill(0);
    destroyTaskRuntimeBackgroundAuthorizationRequestV2(request);
  }
}
