import { describe, expect, test } from "bun:test";

import {
  claimInboundShareReceipt,
  saveInboundShareReceipt,
  stageNativeInboundFileReceipt,
} from "./inbound-share-custody.web";
import { getNativeInboundShareStore, openInboundShareFile } from "./inbound-share-file.web";
import { claimPendingShare, savePendingShare } from "./pending-share.web";
import { canOpenSharedTextDraft, stageNativeSharedTextIntent } from "./share-handoff.web";

const scope = { serverId: "server-1", viewerId: "human-1" };
const intent = { id: "intent-123", kind: "text" as const, value: "hello", createdAt: new Date().toISOString() };
const receipt = {
  id: "receipt-123",
  nativeReceiptId: "native-123",
  filename: "photo.png",
  mimeType: "image/png",
  sizeBytes: 12,
  createdAt: new Date().toISOString(),
};

describe("browser native Share custody boundary", () => {
  test("claims no pending text or file receipt", async () => {
    expect(await claimPendingShare(scope)).toBeNull();
    expect(await claimInboundShareReceipt(scope)).toBeNull();
  });

  test("rejects attempts to create native receipt custody", async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun rejects matcher
    await expect(savePendingShare(intent)).rejects.toThrow("installed Mobile app");
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun rejects matcher
    await expect(saveInboundShareReceipt(receipt, scope)).rejects.toThrow("installed Mobile app");
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun rejects matcher
    await expect(openInboundShareFile(receipt)).rejects.toThrow("installed Mobile app");
  });

  test("never calls an injected native handoff store", async () => {
    let calls = 0;
    const native = {
      peekAsync: async () => { calls += 1; return intent; },
      ackAsync: async () => { calls += 1; return true; },
      clearAsync: async () => { calls += 1; },
    };
    expect(await stageNativeSharedTextIntent(async () => {}, Date.now(), native)).toBeNull();
    expect(await stageNativeInboundFileReceipt(async () => {}, Date.now(), native)).toBeNull();
    expect(await getNativeInboundShareStore()).toBeNull();
    expect(calls).toBe(0);
  });

  test("cannot turn forged browser state into an actionable Share draft", () => {
    expect(canOpenSharedTextDraft({
      pending: intent,
      owner: scope,
      currentServerId: scope.serverId,
      currentViewerId: scope.viewerId,
      roomId: "room-1",
      authorizedRoomIds: new Set(["room-1"]),
      switchingServer: false,
    })).toBe(false);
  });
});
