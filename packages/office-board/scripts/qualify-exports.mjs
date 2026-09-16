import console from "node:console";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
assert.equal(typeof globalThis.DOMParser, "undefined");
assert.equal(typeof globalThis.document, "undefined");
for (const entry of [
  "@nautilo/office-board",
  "@nautilo/office-board/node",
  "@nautilo/office-board/browser",
]) {
  for (const api of /** @type {typeof import("@nautilo/office-board")[]} */ ([
    await import(entry),
    require(entry),
  ])) {
    const mapped = api.mapMiroItems({
      items: [
        {
          id: "a",
          type: "text",
          data: { content: "<p>Read <b>me &amp; keep me</b></p>" },
        },
      ],
      connectors: [],
      resolveImageUrl: (url) => url,
    });
    assert.equal(mapped.inits[0].type, "text");
    if (mapped.inits[0].type !== "text")
      throw new Error("Mapper did not return text");
    assert.equal(
      mapped.inits[0].data.blocks[0].inlines.map((i) => i.text).join(""),
      "Read me & keep me",
    );
    assert.equal(mapped.inits[0].data.blocks[0].inlines[1].style.bold, true);
    assert.equal(
      api.boardToSlidesDocument({ meta: { title: "Board" }, elements: [] })
        .slides[0].id,
      "board",
    );
    const zoom = api.zoomAt(api.DEFAULT_VIEWPORT, { x: 30, y: 40 }, 20);
    assert.equal(zoom.zoom, 20);
    assert.deepEqual(api.screenToWorld(zoom, { x: 30, y: 40 }), {
      x: 30,
      y: 40,
    });
  }
}
assert.equal(typeof globalThis.DOMParser, "undefined");
console.log(
  "Board: root/node/browser ESM and CommonJS exports pass without DOM globals",
);
