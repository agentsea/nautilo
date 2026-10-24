import { expect, test } from "bun:test";
import { Jimp, JimpMime } from "jimp";

test("image schema consumers retain their supported processing operations", async () => {
  const image = new Jimp({ width: 32, height: 32, color: 0xff0000ff });
  image.resize({ w: 24, h: 24 }).crop({ x: 1, y: 1, w: 20, h: 20 })
    .contain({ w: 30, h: 30 }).cover({ w: 24, h: 24 }).rotate(90)
    .flip({ horizontal: true }).blit({ src: new Jimp({ width: 2, height: 2, color: 0x00ff00ff }), x: 0, y: 0 });
  for (const mime of [JimpMime.png, JimpMime.jpeg]) {
    const encoded = await image.getBuffer(mime);
    expect(encoded.length).toBeGreaterThan(0);
    const decoded = await Jimp.read(encoded);
    expect([decoded.width, decoded.height]).toEqual([24, 24]);
  }
  expect(() => image.resize({ w: -1 })).toThrow();
});
