import { describe, expect, mock, test } from "bun:test";
import type { NautiloApiClient } from "@nautilo/api-client/browser";
import { sendOrdinaryRoomMessage } from "../../src/lib/ordinary-room-message";

const body = { content: "hello" };

function clientWith(sendRoomMessage: ReturnType<typeof mock>): NautiloApiClient {
  return { sendRoomMessage } as unknown as NautiloApiClient;
}

describe("sendOrdinaryRoomMessage", () => {
  test("falls back once to server-only chat when Desktop origin is unavailable", async () => {
    const serverSend = mock(async () => ({ messageId: 7, jobId: null }));
    const desktopSend = mock(async () => {
      throw new Error(
        "Error invoking remote method 'ordinaryChat:sendRoomMessage': Error: Desktop origin is unavailable.",
      );
    });

    await expect(
      sendOrdinaryRoomMessage(clientWith(serverSend), "room-1", body, desktopSend),
    ).resolves.toEqual({ messageId: 7, jobId: null });
    expect(desktopSend).toHaveBeenCalledTimes(1);
    expect(serverSend).toHaveBeenCalledTimes(1);
  });

  test("never retries an ambiguous or failed Room message", async () => {
    const serverSend = mock(async () => ({ messageId: 7, jobId: null }));
    const failure = new Error("request failed after dispatch");
    const desktopSend = mock(async () => {
      throw failure;
    });

    await expect(
      sendOrdinaryRoomMessage(clientWith(serverSend), "room-1", body, desktopSend),
    ).rejects.toBe(failure);
    expect(serverSend).not.toHaveBeenCalled();
  });
});
