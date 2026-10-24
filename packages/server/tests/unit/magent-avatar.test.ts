import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { createMagentAvatarLoader } from "../../src/messaging/magent-avatar";

describe("mAgent bound Genie avatar", () => {
  test("reads the fixed Genie and returns portable normalized PNG pixels", async () => {
    const source = await sharp({ create: { width: 32, height: 16, channels: 4, background: "#123456" } })
      .webp().toBuffer();
    const seen: string[] = [];
    const load = createMagentAvatarLoader({
      async findAvatar(genieId) { seen.push(genieId); return { kind: "uploaded", blobId: "synthetic-avatar" }; },
      async readAvatar(avatar) { expect(avatar).toEqual({ kind: "uploaded", blobId: "synthetic-avatar" }); return source; },
    });
    const result = await load("bound-genie");
    expect(seen).toEqual(["bound-genie"]);
    expect(result?.contentType).toBe("image/png");
    const metadata = await sharp(result!.bytes).metadata();
    expect(metadata.format).toBe("png");
    expect([metadata.width, metadata.height]).toEqual([256, 256]);
    expect(metadata.exif).toBeUndefined();
    expect(Object.keys(result!).sort()).toEqual(["bytes", "contentType"]);
  });
  test("reports explicit absence without falling back to another identity", async () => {
    let reads = 0;
    const load = createMagentAvatarLoader({ async findAvatar() { return null; }, async readAvatar() { reads++; return null; } });
    expect(await load("bound-genie")).toBeNull();
    expect(reads).toBe(0);
  });
  test("missing or undecodable pixels are absent", async () => {
    for (const input of [null, Buffer.from("not an image")]) {
      const load = createMagentAvatarLoader({ async findAvatar() { return { kind: "preset", id: "shell" }; },
        async readAvatar() { return input; } });
      expect(await load("bound-genie")).toBeNull();
    }
  });
});

 test("does not expose storage diagnostics through the operator helper", async () => {
   const load = createMagentAvatarLoader({ async findAvatar() { throw new Error("storage detail"); },
     async readAvatar() { return null; } });
   expect(load("bound-genie")).rejects.toThrow("magent_avatar_unavailable");
 });
