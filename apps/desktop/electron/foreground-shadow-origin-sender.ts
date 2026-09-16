import { createHash, randomUUID } from "node:crypto";

import type { NautiloApiClient } from "@nautilo/api-client";
import {
  canonicalRemoteOrdinaryRequestBody,
  normalizeRemoteOrdinaryRequestBody,
} from "@nautilo/types";

type RoomMessageBody = Parameters<NautiloApiClient["sendRoomMessage"]>[1];
type RoomMessageResult = ReturnType<NautiloApiClient["sendRoomMessage"]>;

export interface DesktopOriginAuthority {
  readonly relayId: string;
  readonly desktopSessionId: string;
  readonly relayToken: string;
}

export interface DesktopForegroundShadowOriginSenderInput {
  readonly api: Pick<
    NautiloApiClient,
    "mintElectronOriginCredential" | "sendRoomMessage"
  >;
  readonly resolveOriginAuthority: () => DesktopOriginAuthority | null;
  readonly createRequestId?: () => string;
}

/**
 * Sends one exact prepared Shadow request from Electron main.
 *
 * Origin proof is optional authority layered over the normal signed-in server
 * request. It is always minted before the Message POST. If it is unavailable,
 * the same normalized body is sent once without the origin header. A failed or
 * ambiguous Message POST is never retried here.
 */
export function createDesktopForegroundShadowOriginSender(
  input: DesktopForegroundShadowOriginSenderInput,
): (roomId: string, body: RoomMessageBody) => RoomMessageResult {
  const createRequestId = input.createRequestId ?? randomUUID;
  return async (roomId, body) => {
    const normalizedBody = normalizeRemoteOrdinaryRequestBody(
      structuredClone(body),
    ) as unknown as RoomMessageBody;
    const origin = input.resolveOriginAuthority();
    if (origin === null) {
      return input.api.sendRoomMessage(roomId, normalizedBody);
    }

    const path = `/api/rooms/${encodeURIComponent(roomId)}/messages`;
    const bodySha256 = createHash("sha256")
      .update(canonicalRemoteOrdinaryRequestBody(normalizedBody), "utf8")
      .digest("hex");
    let credential: string;
    try {
      const issued = await input.api.mintElectronOriginCredential(
        {
          requestId: createRequestId(),
          relayId: origin.relayId,
          desktopSessionId: origin.desktopSessionId,
          method: "POST",
          path,
          bodySha256,
        },
        origin.relayToken,
      );
      credential = issued.credential;
    } catch {
      // No Message POST has occurred yet. Degrade once to normal server auth.
      return input.api.sendRoomMessage(roomId, normalizedBody);
    }
    return input.api.sendRoomMessage(roomId, normalizedBody, {
      electronOriginCredential: credential,
    });
  };
}
