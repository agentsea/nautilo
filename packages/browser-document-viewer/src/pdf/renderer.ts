/**
 * Framework-neutral, imperative PDF canvas renderer.
 *
 * This module deliberately accepts already-acquired bytes and an injected
 * runtime. It never acquires a document, constructs a URL, or makes a policy
 * decision on the host's behalf.
 */

export interface BrowserPdfViewport {
  readonly width: number;
  readonly height: number;
}

export interface BrowserPdfRenderTask {
  readonly promise: PromiseLike<void>;
  cancel: () => void;
}

export interface BrowserPdfPage {
  getViewport: (options: { scale: number; rotation?: number }) => BrowserPdfViewport;
  render: (options: {
    canvas: HTMLCanvasElement;
    canvasContext: CanvasRenderingContext2D;
    viewport: BrowserPdfViewport;
  }) => BrowserPdfRenderTask;
  cleanup?: () => void;
}

export interface BrowserPdfDocument {
  readonly numPages: number;
  getPage: (pageNumber: number) => PromiseLike<BrowserPdfPage>;
  destroy?: () => void;
}

export interface BrowserPdfLoadingTask {
  readonly promise: PromiseLike<BrowserPdfDocument>;
  destroy?: () => void;
}

export interface BrowserPdfRuntime {
  getDocument: (source: { data: Uint8Array }) => BrowserPdfLoadingTask;
}

export type BrowserPdfRendererStatus =
  | { readonly kind: "loading" }
  | { readonly kind: "rendering"; readonly pageNumber: number; readonly pageCount: number }
  | { readonly kind: "ready"; readonly pageCount: number }
  | { readonly kind: "error"; readonly message: "Document preview failed." };

export type BrowserPdfRendererOutcome =
  | { readonly kind: "ready"; readonly pageCount: number }
  | { readonly kind: "error" }
  | { readonly kind: "closed" };

export interface RenderBrowserPdfOptions {
  /** The owning host hands the renderer an already-authorized byte buffer. */
  readonly bytes: ArrayBuffer;
  readonly host: HTMLElement;
  readonly runtime: BrowserPdfRuntime;
  /** Configures the runtime's already-approved worker before parsing starts. */
  readonly configureWorker: () => void | PromiseLike<void>;
  readonly signal: AbortSignal;
  /** Absolute caller-owned deadline. The renderer has no timeout default. */
  readonly deadlineAt: number;
  readonly scale: number;
  readonly devicePixelRatio: number;
  readonly rotation?: number;
  readonly onStatus: (status: BrowserPdfRendererStatus) => void;
  readonly onCanvas?: (canvas: HTMLCanvasElement, pageNumber: number) => void;
}

export interface BrowserPdfRenderer {
  readonly done: Promise<BrowserPdfRendererOutcome>;
  close: () => void;
}

/** Stable evidence marker for the Mobile Web export-closure probe. */
export const BROWSER_PDF_RENDERER_CLOSURE_MARKER =
  "nautilo.browser-document-viewer.pdf-renderer.v1" as const;

const SAFE_ERROR_MESSAGE = "Document preview failed." as const;
const activeRenderers = new WeakMap<HTMLElement, BrowserPdfRenderer>();

function callOnce(callback: (() => void) | undefined): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    callback?.();
  };
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * Renders all pages into caller-owned DOM. Starting another renderer for the
 * same host closes the prior generation before any new parser work begins.
 */
export function renderBrowserPdf(options: RenderBrowserPdfOptions): BrowserPdfRenderer {
  if (!Number.isSafeInteger(options.deadlineAt))
    throw new RangeError("PDF render deadline must be a safe integer timestamp.");
  if (!isPositiveFinite(options.scale)) throw new RangeError("PDF render scale must be positive.");
  if (!isPositiveFinite(options.devicePixelRatio))
    throw new RangeError("PDF renderer device pixel ratio must be positive.");
  if (options.rotation !== undefined && !Number.isFinite(options.rotation))
    throw new RangeError("PDF render rotation must be finite.");

  activeRenderers.get(options.host)?.close();
  options.host.replaceChildren();

  let active = true;
  let settle!: (outcome: BrowserPdfRendererOutcome) => void;
  const done = new Promise<BrowserPdfRendererOutcome>((resolve) => {
    settle = resolve;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyLoading: (() => void) | undefined;
  let destroyDocument: (() => void) | undefined;
  let cleanupPage: (() => void) | undefined;
  let cancelRender: (() => void) | undefined;
  let renderer!: BrowserPdfRenderer;
  let hostCleared = false;

  const clearDeadline = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };
  const release = () => {
    clearDeadline();
    options.signal.removeEventListener("abort", close);
    cancelRender?.();
    cancelRender = undefined;
    cleanupPage?.();
    cleanupPage = undefined;
    destroyDocument?.();
    destroyDocument = undefined;
    destroyLoading?.();
    destroyLoading = undefined;
  };
  const clearHost = () => {
    if (hostCleared) return;
    hostCleared = true;
    options.host.replaceChildren();
  };
  const finish = (outcome: BrowserPdfRendererOutcome, clearRenderedHost: boolean) => {
    if (!active) return;
    active = false;
    release();
    if (clearRenderedHost) clearHost();
    if (activeRenderers.get(options.host) === renderer) activeRenderers.delete(options.host);
    settle(outcome);
  };
  const reportStatus = (status: BrowserPdfRendererStatus): boolean => {
    try {
      options.onStatus(status);
      return true;
    } catch {
      return false;
    }
  };
  const fail = () => {
    if (!active) return;
    finish({ kind: "error" }, true);
    reportStatus({ kind: "error", message: SAFE_ERROR_MESSAGE });
  };
  const close = () => {
    if (active) finish({ kind: "closed" }, true);
    else clearHost();
  };

  renderer = { done, close };
  activeRenderers.set(options.host, renderer);
  options.signal.addEventListener("abort", close, { once: true });

  if (options.signal.aborted) {
    close();
    return renderer;
  }
  if (options.deadlineAt <= Date.now()) {
    fail();
    return renderer;
  }
  timer = setTimeout(fail, options.deadlineAt - Date.now());
  if (!reportStatus({ kind: "loading" })) {
    fail();
    return renderer;
  }
  if (!active) return renderer;

  void (async () => {
    try {
      await options.configureWorker();
      if (!active) return;

      const loading = options.runtime.getDocument({ data: new Uint8Array(options.bytes) });
      destroyLoading = callOnce(() => loading.destroy?.());
      const document = await loading.promise;
      if (!active) {
        callOnce(() => document.destroy?.())();
        return;
      }
      destroyDocument = callOnce(() => document.destroy?.());

      if (!Number.isSafeInteger(document.numPages) || document.numPages <= 0) throw new Error("invalid page count");
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        if (!reportStatus({ kind: "rendering", pageNumber, pageCount: document.numPages })) {
          fail();
          return;
        }
        if (!active) return;
        const page = await document.getPage(pageNumber);
        if (!active) {
          callOnce(() => page.cleanup?.())();
          return;
        }
        cleanupPage = callOnce(() => page.cleanup?.());
        const viewport = page.getViewport({
          scale: options.scale,
          ...(options.rotation !== undefined ? { rotation: options.rotation } : {}),
        });
        if (!isPositiveFinite(viewport.width) || !isPositiveFinite(viewport.height)) throw new Error("invalid viewport");

        const canvas = options.host.ownerDocument.createElement("canvas");
        canvas.width = Math.floor(viewport.width * options.devicePixelRatio);
        canvas.height = Math.floor(viewport.height * options.devicePixelRatio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("canvas unavailable");
        context.setTransform(options.devicePixelRatio, 0, 0, options.devicePixelRatio, 0, 0);
        options.onCanvas?.(canvas, pageNumber);
        if (!active) return;
        options.host.append(canvas);
        const task = page.render({ canvas, canvasContext: context, viewport });
        cancelRender = callOnce(() => task.cancel());
        await task.promise;
        cancelRender = undefined;
        cleanupPage();
        cleanupPage = undefined;
        if (!active) return;
      }
      if (!reportStatus({ kind: "ready", pageCount: document.numPages })) {
        fail();
        return;
      }
      if (!active) return;
      finish({ kind: "ready", pageCount: document.numPages }, false);
    } catch {
      fail();
    }
  })();

  return renderer;
}

// Retain the marker in this lazily imported module itself. The Mobile export
// probe uses it to prove this exact shared renderer did not enter initial or
// native closures.
Object.defineProperty(renderBrowserPdf, "browserViewerClosureMarker", {
  value: BROWSER_PDF_RENDERER_CLOSURE_MARKER,
});
