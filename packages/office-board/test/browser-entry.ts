import {
  boardToSlidesDocument,
  mapMiroItems,
  zoomAt,
  DEFAULT_VIEWPORT,
} from "@nautilo/office-board/browser";
import {
  initializeEditor,
  MemSlidesStore,
} from "@nautilo/office-slides/browser";

const store = new MemSlidesStore(
  boardToSlidesDocument({
    meta: { title: "Browser qualification" },
    elements: [],
  }),
);
store.batch(() =>
  store.addElement("board", {
    type: "shape",
    frame: { x: -1000, y: -2000, w: 120, h: 80, rotation: 0 },
    data: { kind: "rect", fill: { kind: "srgb", value: "#3366ff" } },
  }),
);
const canvas = document.createElement("canvas");
canvas.width = 640;
canvas.height = 480;
const overlay = document.createElement("div");
document.body.append(canvas, overlay);
const editor = initializeEditor({
  canvas,
  overlay,
  store,
  hostWidth: 640,
  hostHeight: 480,
  dpr: 1,
  viewport: { zoom: 1, panX: 1100, panY: 2100 },
  cull: true,
  suppressSlideChrome: true,
});
editor.setViewport({ zoom: 1, panX: 1100, panY: 2100 });
const mapped = mapMiroItems({
  items: [
    { id: "x", type: "text", data: { content: "<p>A &amp; <b>B</b></p>" } },
  ],
  connectors: [],
  resolveImageUrl: (url) => url,
});
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    const pixel = [
      ...canvas.getContext("2d")!.getImageData(150, 140, 1, 1).data,
    ];
    document.body.dataset.result = JSON.stringify({
      pixel,
      text:
        mapped.inits[0].type === "text"
          ? mapped.inits[0].data.blocks
              .map((b) => b.inlines.map((i) => i.text).join(""))
              .join("")
          : "",
      zoom: zoomAt(DEFAULT_VIEWPORT, { x: 0, y: 0 }, 20).zoom,
    });
  }),
);
