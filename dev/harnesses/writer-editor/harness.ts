/**
 * P1.4 dev-harness — proves NautiloDocStore end-to-end in a real browser.
 *
 *  - Wires the store to the *browser* MemDocStore (`createStore`) and a *stub*
 *    nautiloApp bridge (`writePatch` renders the container + patch stats).
 *  - Mounts the Wafflebase editor on the store so live keystrokes flow through
 *    every DocStore mutation → debounce → serialize → anchored patch → bridge.
 *  - "Simulate peer append" builds a peer edit on the last-flushed container and
 *    calls `applyRemotePatch` → `resetAfterDocumentReplace()` → `render()`, the
 *    exact inbound path P2.2 will wire in the real mini-app.
 *
 * Not shipped. Run: `bun install && bun run dev` in this dir, open :5211.
 */
import {
  CanvasTextMeasurer,
  DEFAULT_PAGE_SETUP,
  computeLayout,
  computeScaleFactor,
  getEffectiveDimensions,
  getPageXOffset,
  getPageYOffset,
  getTotalHeight,
  initialize,
  MemDocStore,
  paginateLayout,
} from "@nautilo/office-docs/browser";
import { NautiloDocStore } from "../../../packages/first-party-apps/writer/src/nautilo-doc-store";
import {
  createDefaultManifest,
  wafflebaseDocumentToPayload,
  parseWriterHtml,
  serializeWriterHtml,
} from "../../../packages/first-party-apps/writer/src/office-document";
import {
  fixture as overlayFixture,
  geometryForChanges,
  hitTestChange,
  nextChange,
  paintOverlay,
} from "./overlay-spike";

const $ = (id: string) => document.getElementById(id)!;
const editorEl = $("editor");
const out = $("container-out");
const logEl = $("log");
const writeCountEl = $("writeCount");
const patchDeltaEl = $("patchDelta");
const rebaseEl = $("rebaseState");
const overlayHost = $("overlay-spike");
const overlayCanvas = $("overlay-canvas") as HTMLCanvasElement;
const overlayMeta = $("overlay-meta");

const overlay = overlayFixture();
const overlayManifest = createDefaultManifest();
const overlayCanonical = serializeWriterHtml(overlayManifest, wafflebaseDocumentToPayload(overlay.document));
let writeCount = 0;
let lastContainer = overlayCanonical;

function log(line: string) {
  logEl.textContent = `${new Date().toLocaleTimeString()}  ${line}\n${logEl.textContent}`;
}

const store = new NautiloDocStore(overlayCanonical, {
  createStore: (doc) => new MemDocStore(doc),
  writePatch: ({ container, patch }) => {
    writeCount += 1;
    lastContainer = container;
    out.textContent = container;
    writeCountEl.textContent = String(writeCount);
    patchDeltaEl.textContent = `-${patch.oldString.length}/+${patch.newString.length} chars`;
    log(`bridge write #${writeCount} — patch replaces ${patch.oldString.length}→${patch.newString.length} chars`);
    // exposed for agent-browser assertions
    (window as unknown as Record<string, unknown>)["__writes"] = writeCount;
    (window as unknown as Record<string, unknown>)["__lastContainer"] = container;
  },
  debounceMs: 300,
});

await store.initBase();

const editor = initialize(editorEl, store);
(window as unknown as Record<string, unknown>)["__editor"] = editor;
(window as unknown as Record<string, unknown>)["__store"] = store;
log("editor mounted on NautiloDocStore — start typing");

// The adapter never receives the store; it computes from an immutable snapshot
// and paints into a sibling canvas positioned over the public editor surface.
overlayMeta.textContent = "creating public canvas measurer";
const overlayMeasurer = new CanvasTextMeasurer();
overlayMeta.textContent = "computing public document layout";
let overlayScale = 1;
let renderedScale = 1;
let overlayLayout = createOverlayLayout(320).overlay;

function createOverlayLayout(canvasWidth: number) {
  const setup = overlay.document.pageSetup ?? DEFAULT_PAGE_SETUP;
  const dimensions = getEffectiveDimensions(setup);
  const contentWidth = dimensions.width - setup.margins.left - setup.margins.right;
  const { layout } = computeLayout(
    overlay.document.blocks,
    overlayMeasurer,
    contentWidth,
    undefined,
    undefined,
    undefined,
    overlay.document.styles,
  );
  const paginated = paginateLayout(layout, setup);
  return {
    overlay: geometryForChanges(
      overlay.document,
      overlay.changes,
      layout,
      paginated,
      getPageXOffset(paginated, canvasWidth),
      (pageIndex) => getPageYOffset(paginated, pageIndex),
      (text) => overlayMeasurer.measureWidth(text, { family: "Arial", size: 12, weight: "normal", style: "normal" }),
    ),
    totalHeight: getTotalHeight(paginated),
  };
}

function renderOverlay() {
  const width = Math.max(320, overlayHost.clientWidth);
  const setup = overlay.document.pageSetup ?? DEFAULT_PAGE_SETUP;
  const autoScale = computeScaleFactor(width, getEffectiveDimensions(setup).width);
  renderedScale = autoScale * overlayScale;
  const computed = createOverlayLayout(width / renderedScale);
  const height = Math.max(420, computed.totalHeight * renderedScale);
  overlayCanvas.width = width * devicePixelRatio;
  overlayCanvas.height = height * devicePixelRatio;
  overlayCanvas.style.height = `${height}px`;
  const context = overlayCanvas.getContext("2d")!;
  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);
  editorEl.style.transform = `scale(${overlayScale})`;
  editorEl.style.transformOrigin = "top center";
  overlayLayout = computed.overlay;
  paintOverlay(context, overlayLayout, overlay.changes, renderedScale);
  const immutable = serializeWriterHtml(overlayManifest, wafflebaseDocumentToPayload(overlay.document)) === overlayCanonical;
  overlayMeta.textContent = `public layout: ${overlayLayout.rects.length} range fragments · ${overlayLayout.pageCount} pages\n` +
    `zoom ${Math.round(overlayScale * 100)}% · canonical snapshot unchanged: ${immutable ? "yes" : "NO"}`;
}

new ResizeObserver(renderOverlay).observe(overlayHost);
renderOverlay();

$("overlayScale").addEventListener("click", () => {
  overlayScale = overlayScale === 1 ? 0.75 : 1;
  $("overlayScale").textContent = `Overlay scale: ${Math.round(overlayScale * 100)}%`;
  renderOverlay();
});

overlayCanvas.addEventListener("click", (event) => {
  const rect = overlayCanvas.getBoundingClientRect();
  const id = hitTestChange(overlayLayout, (event.clientX - rect.left) / renderedScale, (event.clientY - rect.top) / renderedScale);
  const change = nextChange(overlay.changes, id);
  overlayMeta.textContent += `\nhit: ${id ?? "none"} · next: ${change?.id ?? "none"}`;
});

(window as unknown as Record<string, unknown>)["__overlaySpike"] = {
  canonicalUnchanged: () => serializeWriterHtml(overlayManifest, wafflebaseDocumentToPayload(overlay.document)) === overlayCanonical,
  getLayout: () => overlayLayout,
  getScale: () => overlayScale,
  getRenderScale: () => renderedScale,
  hitTest: (x: number, y: number, pageIndex?: number) => hitTestChange(overlayLayout, x, y, pageIndex),
  nextChange: (currentId: string | null) => nextChange(overlay.changes, currentId),
};

$("saveNow").addEventListener("click", () => void store.flush());

$("inbound").addEventListener("click", () => {
  // Build a peer edit ON TOP of the last-flushed container so the local (still
  // un-flushed) keystrokes have a stable anchor to rebase against.
  const parsed = parseWriterHtml(lastContainer);
  const manifest = parsed.ok ? parsed.document.manifest : createDefaultManifest();
  const blocks = parsed.ok ? [...parsed.document.document.blocks] : [];
  blocks.push({
    id: `peer-${Date.now()}`,
    type: "paragraph",
    inlines: [{ text: "PEER APPEND (inbound patch)", style: {} }],
  } as unknown);
  const remote = serializeWriterHtml(manifest, { blocks });

  const res = store.applyRemotePatch(remote);
  if (res.ok) {
    editor.resetAfterDocumentReplace();
    editor.render();
    rebaseEl.textContent = res.rebased ? "rebased local edits ✓" : "clean load ✓";
    log(`applyRemotePatch OK — rebased=${res.rebased} → editor re-rendered`);
  } else {
    rebaseEl.textContent = `conflict: ${res.reason}`;
    log(`applyRemotePatch CONFLICT — ${res.reason} (local edits preserved, not clobbered)`);
  }
});
