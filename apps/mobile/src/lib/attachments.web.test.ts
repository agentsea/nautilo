import { describe, expect, test } from "bun:test";

import { pickImages, uploadImageAsset } from "./attachments.web";

describe("Web attachment boundary", () => {
  test("fails closed without opening native media or filesystem custody", async () => {
    expect(await pickImages(1)).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matcher typing
    await expect(uploadImageAsset("https://alpha.example.test", "room-1", {
      uri: "blob:https://alpha.example.test/file",
      name: "file.png",
    })).rejects.toThrow("unavailable");
  });
});
