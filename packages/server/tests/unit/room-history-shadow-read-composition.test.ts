import { expect, test } from "bun:test";

import {
  createProductionRoomHistoryShadowReadComposition,
} from "../../src/routes/room-history-shadow-read-composition.ts";

test("plaintext history exits before Shadow projection and observation setup", async () => {
  const composition = createProductionRoomHistoryShadowReadComposition({
    getPolicy: () => Promise.resolve({ mode: "plaintext_only" }),
  });

  const result = await composition.project({
    authority: {
      userId: "10000000-0000-4000-8000-000000000001",
      humanActorId: "10000000-0000-4000-8000-000000000002",
    },
    roomId: "10000000-0000-4000-8000-000000000003",
    readerDeviceId: null,
    clientRequestKey: "history-read:plaintext",
    selectedCoordinates: [],
    now: Date.parse("2026-09-03T12:00:00.000Z"),
  });
  expect(result).toEqual({
    responseVersion: 1,
    status: "disabled",
    mode: "plaintext_only",
  });
});
