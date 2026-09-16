import { describe, expect, mock, test } from "bun:test";
import {
  BROWSER_PDF_RENDERER_CLOSURE_MARKER,
  renderBrowserPdf,
  type BrowserPdfDocument,
  type BrowserPdfPage,
  type BrowserPdfRuntime,
} from "../src/pdf/renderer";

test("publishes a stable Web export-closure marker", () => {
  expect(BROWSER_PDF_RENDERER_CLOSURE_MARKER).toBe("nautilo.browser-document-viewer.pdf-renderer.v1");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHost() {
  const children: unknown[] = [];
  const context = { setTransform: mock(() => {}) };
  const canvas = {
    width: 0,
    height: 0,
    style: {} as CSSStyleDeclaration,
    className: "",
    getContext: mock(() => context),
  };
  const host = {
    children,
    ownerDocument: { createElement: mock(() => canvas) },
    append: mock((child: unknown) => children.push(child)),
    replaceChildren: mock(() => {
      children.length = 0;
    }),
  };
  return {
    host: host as unknown as HTMLElement,
    canvas: canvas as unknown as HTMLCanvasElement,
    context,
    children,
  };
}

function readyRuntime(overrides: Partial<BrowserPdfPage> = {}) {
  const pageCleanup = mock(() => {});
  const page: BrowserPdfPage = {
    getViewport: mock(() => ({ width: 120, height: 80 })),
    render: mock(() => ({ promise: Promise.resolve(), cancel: mock(() => {}) })),
    cleanup: pageCleanup,
    ...overrides,
  };
  const documentDestroy = mock(() => {});
  const document: BrowserPdfDocument = {
    numPages: 1,
    getPage: mock(async () => page),
    destroy: documentDestroy,
  };
  const loadingDestroy = mock(() => {});
  const runtime: BrowserPdfRuntime = {
    getDocument: mock(() => ({ promise: Promise.resolve(document), destroy: loadingDestroy })),
  };
  return { runtime, page, pageCleanup, documentDestroy, loadingDestroy };
}

function options(host: HTMLElement, runtime: BrowserPdfRuntime, signal = new AbortController().signal) {
  return {
    bytes: new Uint8Array([1, 2, 3]).buffer,
    host,
    runtime,
    configureWorker: mock(() => {}),
    signal,
    deadlineAt: Date.now() + 1_000,
    scale: 1.25,
    devicePixelRatio: 2,
    onStatus: mock(() => {}),
  };
}

describe("browser PDF renderer", () => {
  test("renders an already-acquired buffer without fetch or blob URLs", async () => {
    const { host, canvas, context, children } = createHost();
    const { runtime, documentDestroy, loadingDestroy } = readyRuntime();
    const input = options(host, runtime);
    const fetchSpy = mock(() => Promise.reject(new Error("must not fetch")));
    const originalFetch = globalThis.fetch;
    const originalCreateObjectURL = URL.createObjectURL;
    const blobSpy = mock(() => "blob:forbidden");
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    URL.createObjectURL = blobSpy;
    try {
      const renderer = renderBrowserPdf(input);
      expect(await renderer.done).toEqual({ kind: "ready", pageCount: 1 });
      expect(runtime.getDocument).toHaveBeenCalledWith({ data: expect.any(Uint8Array) });
      expect((runtime.getDocument as ReturnType<typeof mock>).mock.calls[0]![0].data.buffer).toBe(input.bytes);
      expect(children).toEqual([canvas]);
      expect(canvas.width).toBe(240);
      expect(canvas.height).toBe(160);
      expect(context.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(blobSpy).not.toHaveBeenCalled();
      renderer.close();
      expect(children).toEqual([]);
      expect(documentDestroy).toHaveBeenCalledTimes(1);
      expect(loadingDestroy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
      URL.createObjectURL = originalCreateObjectURL;
    }
  });

  test("preserves PDF runtime method receivers through lifecycle cleanup", async () => {
    const { host } = createHost();
    let runtime!: BrowserPdfRuntime;
    let loading!: { promise: Promise<BrowserPdfDocument>; destroy: () => void };
    let document!: BrowserPdfDocument;
    let page!: BrowserPdfPage;
    let task!: { promise: Promise<void>; cancel: () => void };
    const calls: string[] = [];

    task = {
      promise: Promise.resolve(),
      cancel() {
        expect(this).toBe(task);
        calls.push("task.cancel");
      },
    };
    page = {
      getViewport() {
        expect(this).toBe(page);
        calls.push("page.getViewport");
        return { width: 12, height: 8 };
      },
      render() {
        expect(this).toBe(page);
        calls.push("page.render");
        return task;
      },
      cleanup() {
        expect(this).toBe(page);
        calls.push("page.cleanup");
      },
    };
    document = {
      numPages: 1,
      async getPage() {
        expect(this).toBe(document);
        calls.push("document.getPage");
        return page;
      },
      destroy() {
        expect(this).toBe(document);
        calls.push("document.destroy");
      },
    };
    loading = {
      promise: Promise.resolve(document),
      destroy() {
        expect(this).toBe(loading);
        calls.push("loading.destroy");
      },
    };
    runtime = {
      getDocument() {
        expect(this).toBe(runtime);
        calls.push("runtime.getDocument");
        return loading;
      },
    };

    expect(await renderBrowserPdf(options(host, runtime)).done).toEqual({ kind: "ready", pageCount: 1 });
    expect(calls).toEqual([
      "runtime.getDocument",
      "document.getPage",
      "page.getViewport",
      "page.render",
      "page.cleanup",
      "document.destroy",
      "loading.destroy",
    ]);
  });

  test("aborting destroys an in-flight loading task exactly once", async () => {
    const { host } = createHost();
    const pending = deferred<BrowserPdfDocument>();
    const destroy = mock(() => {});
    const runtime: BrowserPdfRuntime = {
      getDocument: mock(() => ({ promise: pending.promise, destroy })),
    };
    const controller = new AbortController();
    const renderer = renderBrowserPdf(options(host, runtime, controller.signal));
    await Promise.resolve();
    controller.abort();
    expect(await renderer.done).toEqual({ kind: "closed" });
    renderer.close();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test("an already-aborted signal closes without reporting a preview failure", async () => {
    const { host } = createHost();
    const { runtime } = readyRuntime();
    const controller = new AbortController();
    controller.abort();
    const input = options(host, runtime, controller.signal);
    const renderer = renderBrowserPdf(input);
    expect(await renderer.done).toEqual({ kind: "closed" });
    expect(input.onStatus).not.toHaveBeenCalled();
    expect(runtime.getDocument).not.toHaveBeenCalled();
  });

  test("aborting an active page render cancels every acquired resource once", async () => {
    const { host } = createHost();
    const renderStarted = deferred<void>();
    const renderPending = deferred<void>();
    const cancel = mock(() => {});
    const pageCleanup = mock(() => {});
    const page: BrowserPdfPage = {
      getViewport: () => ({ width: 12, height: 8 }),
      render: () => {
        renderStarted.resolve();
        return { promise: renderPending.promise, cancel };
      },
      cleanup: pageCleanup,
    };
    const documentDestroy = mock(() => {});
    const loadingDestroy = mock(() => {});
    const runtime: BrowserPdfRuntime = {
      getDocument: () => ({
        destroy: loadingDestroy,
        promise: Promise.resolve({ numPages: 1, destroy: documentDestroy, getPage: async () => page }),
      }),
    };
    const controller = new AbortController();
    const renderer = renderBrowserPdf(options(host, runtime, controller.signal));
    await renderStarted.promise;
    controller.abort();
    expect(await renderer.done).toEqual({ kind: "closed" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pageCleanup).toHaveBeenCalledTimes(1);
    expect(documentDestroy).toHaveBeenCalledTimes(1);
    expect(loadingDestroy).toHaveBeenCalledTimes(1);
  });

  test("a replacement closes and destroys the prior generation", async () => {
    const { host } = createHost();
    const pending = deferred<BrowserPdfDocument>();
    const firstDestroy = mock(() => {});
    const firstRuntime: BrowserPdfRuntime = {
      getDocument: mock(() => ({ promise: pending.promise, destroy: firstDestroy })),
    };
    const first = renderBrowserPdf(options(host, firstRuntime));
    await Promise.resolve();
    const secondRuntime = readyRuntime().runtime;
    const second = renderBrowserPdf(options(host, secondRuntime));
    expect(await first.done).toEqual({ kind: "closed" });
    expect(await second.done).toEqual({ kind: "ready", pageCount: 1 });
    expect(firstDestroy).toHaveBeenCalledTimes(1);
  });

  test("a caller deadline cancels an in-flight loading task and reports one safe error", async () => {
    const { host } = createHost();
    const pending = deferred<BrowserPdfDocument>();
    const destroy = mock(() => {});
    const runtime: BrowserPdfRuntime = {
      getDocument: mock(() => ({ promise: pending.promise, destroy })),
    };
    const input = options(host, runtime);
    input.deadlineAt = Date.now() + 1;
    const renderer = renderBrowserPdf(input);
    expect(await renderer.done).toEqual({ kind: "error" });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(input.onStatus).toHaveBeenLastCalledWith({ kind: "error", message: "Document preview failed." });
  });

  test("a parser failure destroys document and loading resources without exposing its message", async () => {
    const { host } = createHost();
    const documentDestroy = mock(() => {});
    const loadingDestroy = mock(() => {});
    const runtime: BrowserPdfRuntime = {
      getDocument: mock(() => ({
        destroy: loadingDestroy,
        promise: Promise.resolve({
          numPages: 1,
          destroy: documentDestroy,
          getPage: async () => Promise.reject(new Error("private parser detail")),
        }),
      })),
    };
    const input = options(host, runtime);
    const renderer = renderBrowserPdf(input);
    expect(await renderer.done).toEqual({ kind: "error" });
    expect(documentDestroy).toHaveBeenCalledTimes(1);
    expect(loadingDestroy).toHaveBeenCalledTimes(1);
    expect(input.onStatus).toHaveBeenLastCalledWith({ kind: "error", message: "Document preview failed." });
  });

  test("a throwing host status callback fails closed without leaving parser work behind", async () => {
    const { host } = createHost();
    const { runtime } = readyRuntime();
    const input = options(host, runtime);
    input.onStatus = mock(() => {
      throw new Error("host callback failure");
    });
    const renderer = renderBrowserPdf(input);
    expect(await renderer.done).toEqual({ kind: "error" });
    expect(runtime.getDocument).not.toHaveBeenCalled();
    renderer.close();
  });
});
