import type { BoardModel } from "@nautilo/office-board";
import {
  makeDefaultSlidesTextBlock,
  type Element as BoardElement,
} from "@nautilo/office-slides/browser";
import { mountBoardSurface, type BoardSurface } from "./src/board-surface";
const root = document.querySelector<HTMLElement>("#app")!;
const query = new URL(location.href).searchParams;
let theme: "light" | "dark" = query.get("theme") === "dark" ? "dark" : "light";
let surface: BoardSurface;
const errors: string[] = [];
function note(
  id: string,
  x: number,
  y: number,
  color: string,
  text: string,
): BoardElement {
  const blocks = text.split("\n\n").map((content, index) => {
    const block = makeDefaultSlidesTextBlock();
    block.style = {
      ...block.style,
      alignment: "left",
      lineHeight: 1.25,
      marginTop: 0,
      marginBottom: index === 0 ? 14 : 0,
    };
    block.inlines = [
      {
        text: content,
        style: {
          fontFamily: "Inter",
          fontSize: index === 0 ? 11 : 14,
          bold: index === 0,
          color: "#292524",
        },
      },
    ];
    return block;
  });
  return {
    id,
    type: "shape",
    frame: { x, y, w: 252, h: 200, rotation: 0 },
    data: {
      kind: "roundRect",
      fill: { kind: "srgb", value: color },
      text: { blocks, verticalAnchor: "middle", autofit: "shrink" },
    },
  };
}
function example(): BoardModel {
  const heading = makeDefaultSlidesTextBlock();
  heading.inlines = [
    {
      text: "Make room for what’s next.",
      style: {
        fontFamily: "Georgia",
        fontSize: 34,
        color: { kind: "role", role: "text" },
      },
    },
  ];
  const sub = makeDefaultSlidesTextBlock();
  sub.inlines = [
    {
      text: "A shared map of the ideas worth bringing to life.",
      style: {
        fontFamily: "Inter",
        fontSize: 16,
        color: { kind: "role", role: "textSecondary" },
      },
    },
  ];
  return {
    meta: { title: "The next chapter" },
    elements: [
      {
        id: "heading",
        type: "text",
        frame: { x: 0, y: -160, w: 800, h: 72, rotation: 0 },
        data: { blocks: [heading] },
      },
      {
        id: "subtitle",
        type: "text",
        frame: { x: 0, y: -86, w: 800, h: 42, rotation: 0 },
        data: { blocks: [sub] },
      },
      note(
        "idea",
        0,
        30,
        "#fff1b8",
        "01 / THE IDEA\n\nGive a good thought somewhere to grow.",
      ),
      note(
        "people",
        336,
        30,
        "#d7edcf",
        "02 / THE PEOPLE\n\nBring different perspectives into the same room.",
      ),
      note(
        "make",
        672,
        30,
        "#d5e6ff",
        "03 / THE FIRST STEP\n\nMake something small enough to try today.",
      ),
      note(
        "question",
        180,
        330,
        "#f6d8e4",
        "A question to keep asking\n\nWhat would make this simpler?",
      ),
      note(
        "learn",
        516,
        330,
        "#e7dcf5",
        "Leave space for surprise\n\nThe best answer might not be on this board yet.",
      ),
      ...[
        ["link1", "idea", "people"],
        ["link2", "people", "make"],
      ].map(([id, start, end]): BoardElement => ({
        id,
        type: "connector",
        frame: { x: 0, y: 0, w: 0, h: 0, rotation: 0 },
        routing: "straight",
        start: { kind: "attached", elementId: start, siteIndex: 1 },
        end: { kind: "attached", elementId: end, siteIndex: 3 },
        stroke: { color: "#a99176", width: 2 },
        arrowheads: { end: { kind: "triangle", size: "md" } },
      })),
    ],
  };
}
function mount(model: BoardModel): void {
  surface?.dispose();
  surface = mountBoardSurface(
    root,
    model,
    {
      changed() {
        const download = document.querySelector<HTMLButtonElement>("#download");
        if (download && surface) download.disabled = surface.hasPendingImages();
      },
      error(message) {
        errors.push(message);
      },
    },
    {
      theme,
      status: "Interface preview · Edits stay in this tab",
      readOnly: query.has("readonly"),
    },
  );
  const download = document.querySelector<HTMLButtonElement>("#download");
  if (download) download.disabled = surface.hasPendingImages();
}
mount(
  query.has("example")
    ? example()
    : { meta: { title: "Untitled board" }, elements: [] },
);
document
  .querySelector("#example")
  ?.addEventListener("click", () => mount(example()));
document
  .querySelector("#blank")
  ?.addEventListener("click", () =>
    mount({ meta: { title: "Untitled board" }, elements: [] }),
  );
document
  .querySelector<HTMLSelectElement>("#theme")
  ?.addEventListener("change", (event) => {
    theme = (event.target as HTMLSelectElement).value as "light" | "dark";
    surface.setTheme(theme);
  });
const themeControl = document.querySelector<HTMLSelectElement>("#theme");
if (themeControl) themeControl.value = theme;
document.querySelector("#download")?.addEventListener("click", () => {
  const content = JSON.stringify(surface.read(), null, 2);
  const url = URL.createObjectURL(
    new Blob([content], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "Board.preview.json";
  a.click();
  URL.revokeObjectURL(url);
});
// Preview-only acceptance hook; this is not the app/Genie API or persistence contract.
Object.assign(window, {
  boardPreview: {
    read: () => surface.read(),
    viewport: () => surface.viewport(),
    selection: () => surface.selection(),
    pending: () => surface.hasPendingImages(),
    dispose: () => surface.dispose(),
    errors,
  },
});
