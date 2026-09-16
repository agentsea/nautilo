import { afterEach, describe, expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { rasterizeSequenceText, type SequenceTextRasterDependencies } from "../../electron/sequence-text-raster.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true }))); });
async function output(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nautilo-text-raster-"));
  roots.push(root);
  return path.join(root, "frame.png");
}
async function expectError(promise: Promise<unknown>, message: string): Promise<void> {
  let caught: unknown;
  try { await promise; } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe(message);
}

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class FakeImage {
  constructor(private readonly width: number, private readonly height: number, private readonly bytes = Buffer.from("png")) {}
  getSize(): { width: number; height: number } { return { width: this.width, height: this.height }; }
  resize(options: { width: number; height: number }): FakeImage { return new FakeImage(options.width, options.height, Buffer.from(`png:${options.width}x${options.height}`)); }
  toPNG(): Buffer { return this.bytes; }
}

class FakeWindow {
  destroyed = false;
  loadedUrl = "";
  handlers = new Map<string, (event: { preventDefault(): void }) => void>();
  openHandler?: () => { action: "deny" };
  load = async (_url: string): Promise<void> => undefined;
  execute = async (_script: string): Promise<unknown> => true;
  capture = async (): Promise<FakeImage> => new FakeImage(320, 180);
  webContents = {
    on: (event: "will-navigate" | "will-attach-webview", handler: (event: { preventDefault(): void }) => void) => { this.handlers.set(event, handler); },
    setWindowOpenHandler: (handler: () => { action: "deny" }) => { this.openHandler = handler; },
    executeJavaScript: (script: string) => this.execute(script),
    capturePage: (_rect: { x: number; y: number; width: number; height: number }) => this.capture(),
  };
  async loadURL(url: string): Promise<void> { this.loadedUrl = url; return this.load(url); }
  isDestroyed(): boolean { return this.destroyed; }
  destroy(): void { this.destroyed = true; }
}

function harness(window: FakeWindow, observed: { partition?: string; sessionOptions?: { cache: false }; options?: Record<string, unknown>; requestAllowed?: (url: string) => boolean }): SequenceTextRasterDependencies {
  return {
    createSession: (partition, options) => {
      observed.partition = partition;
      observed.sessionOptions = options;
      return {
        setPermissionCheckHandler: (handler) => { expect(handler()).toBe(false); },
        setPermissionRequestHandler: (handler) => { handler(undefined, "camera", (allowed) => expect(allowed).toBe(false)); },
        webRequest: { onBeforeRequest: (_filter, handler) => {
          observed.requestAllowed = (url) => { let cancelled = false; handler({ url }, (response) => { cancelled = response.cancel; }); return !cancelled; };
        } },
      };
    },
    createWindow: (options) => { observed.options = options; return window; },
  };
}

describe("sequence text raster", () => {
  test("confines the renderer and loads hostile text only as escaped document data", async () => {
    const destination = await output(); const window = new FakeWindow(); const observed: Parameters<typeof harness>[1] = {};
    await rasterizeSequenceText({ kind: "caption", text: `<img src=https://attacker.invalid>\n<script>alert(1)</script>`, width: 320, height: 180, outputPath: destination }, harness(window, observed));

    expect(observed.partition).toBe("sequence-text-raster");
    expect(observed.sessionOptions).toEqual({ cache: false });
    expect(observed.options).toMatchObject({ show: false, focusable: false, frame: false, transparent: true, useContentSize: true, paintWhenInitiallyHidden: true, width: 320, height: 180,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
    expect((observed.options!.webPreferences as Record<string, unknown>).preload).toBeUndefined();
    expect(observed.requestAllowed!("https://attacker.invalid/font.woff2")).toBe(false);
    expect(observed.requestAllowed!("file:///tmp/secret")).toBe(false);
    expect(observed.requestAllowed!("data:text/html;charset=UTF-8,ok")).toBe(true);
    const html = decodeURIComponent(window.loadedUrl.split(",", 2)[1]!);
    expect(html).toContain("&lt;img src=https://attacker.invalid&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(window.openHandler?.()).toEqual({ action: "deny" });
    expect(window.handlers.has("will-navigate")).toBe(true);
    expect(window.handlers.has("will-attach-webview")).toBe(true);
    expect(window.destroyed).toBe(true);
    expect(await fsp.readFile(destination, "utf8")).toBe("png");
    expect((await fsp.stat(destination)).mode & 0o777).toBe(0o600);
  });

  test("waits for fonts, refuses overflow, and publishes no file", async () => {
    const destination = await output(); const window = new FakeWindow(); let script = "";
    window.execute = async (value) => { script = value; return false; };
    await expectError(rasterizeSequenceText({ kind: "text", text: "too tall", width: 320, height: 180, outputPath: destination }, harness(window, {})), "text_overflow");
    expect(script).toContain("document.fonts.ready");
    expect(script).toContain("[data-text-content]");
    expect(script).toContain("[data-text-safe-area]");
    expect(await fsp.stat(destination).then(() => true, () => false)).toBe(false);
  });

  test("resizes a device-scale capture to the exact requested dimensions", async () => {
    const destination = await output(); const window = new FakeWindow();
    window.capture = async () => new FakeImage(640, 360);
    await rasterizeSequenceText({ kind: "callout", text: "Exact", width: 320, height: 180, outputPath: destination }, harness(window, {}));
    expect(await fsp.readFile(destination, "utf8")).toBe("png:320x180");
  });

  test("cancellation before and during renderer awaits destroys the window and publishes nothing", async () => {
    const beforePath = await output(); const before = new AbortController(); before.abort(); let constructed = false;
    await expectError(rasterizeSequenceText({ kind: "text", text: "x", width: 320, height: 180, outputPath: beforePath, signal: before.signal }, { ...harness(new FakeWindow(), {}), createWindow: () => { constructed = true; return new FakeWindow(); } }), "cancelled");
    expect(constructed).toBe(false);

    const duringPath = await output(); const during = new AbortController(); const window = new FakeWindow(); const waiting = deferred<void>();
    window.load = () => waiting.promise;
    const pending = rasterizeSequenceText({ kind: "text", text: "x", width: 320, height: 180, outputPath: duringPath, signal: during.signal }, harness(window, {}));
    await Promise.resolve(); during.abort(); waiting.reject(new Error("destroyed"));
    await expectError(pending, "cancelled");
    expect(window.destroyed).toBe(true);
    expect(await fsp.stat(duringPath).then(() => true, () => false)).toBe(false);
  });

  test("cancellation settles a measurement that Chromium never resolves", async () => {
    const destination = await output(); const controller = new AbortController(); const window = new FakeWindow();
    const entered = deferred<void>();
    window.execute = () => { entered.resolve(); return new Promise<never>(() => undefined); };
    const pending = rasterizeSequenceText({ kind: "text", text: "x", width: 320, height: 180, outputPath: destination, signal: controller.signal }, harness(window, {}));
    await entered.promise; controller.abort();
    await expectError(pending, "cancelled");
    expect(window.destroyed).toBe(true);
    expect(await fsp.stat(destination).then(() => true, () => false)).toBe(false);
  });

  test("cancellation settles a capture that Chromium never resolves", async () => {
    const destination = await output(); const controller = new AbortController(); const window = new FakeWindow();
    const entered = deferred<void>();
    window.capture = () => { entered.resolve(); return new Promise<never>(() => undefined); };
    const pending = rasterizeSequenceText({ kind: "caption", text: "x", width: 320, height: 180, outputPath: destination, signal: controller.signal }, harness(window, {}));
    await entered.promise; controller.abort();
    await expectError(pending, "cancelled");
    expect(window.destroyed).toBe(true);
    expect(await fsp.stat(destination).then(() => true, () => false)).toBe(false);
  });

  test("removes a partial exclusive output after write failure", async () => {
    const destination = await output(); const window = new FakeWindow();
    const dependencies: SequenceTextRasterDependencies = { ...harness(window, {}), openFile: (async (file: string) => {
      const handle = await fsp.open(file, "wx", 0o600);
      return { writeFile: async (bytes: Uint8Array) => { await handle.writeFile(bytes); throw new Error("disk failed"); }, close: () => handle.close() } as never;
    }) as never };
    await expectError(rasterizeSequenceText({ kind: "caption", text: "x", width: 320, height: 180, outputPath: destination }, dependencies), "processing_failed");
    expect(await fsp.stat(destination).then(() => true, () => false)).toBe(false);
  });

  test("late cancellation after bytes are written still removes the unpublished output", async () => {
    const destination = await output(); const window = new FakeWindow(); const controller = new AbortController();
    const dependencies: SequenceTextRasterDependencies = { ...harness(window, {}), openFile: (async (file: string) => {
      const handle = await fsp.open(file, "wx", 0o600);
      return { writeFile: async (bytes: Uint8Array) => { await handle.writeFile(bytes); controller.abort(); }, close: () => handle.close() } as never;
    }) as never };
    await expectError(rasterizeSequenceText({ kind: "caption", text: "x", width: 320, height: 180, outputPath: destination, signal: controller.signal }, dependencies), "cancelled");
    expect(window.destroyed).toBe(true);
    expect(await fsp.stat(destination).then(() => true, () => false)).toBe(false);
  });

  test("an exclusive-open failure never unlinks a pre-existing output", async () => {
    const destination = await output(); await fsp.writeFile(destination, "existing", { mode: 0o600 });
    let unlinks = 0;
    await expectError(rasterizeSequenceText({ kind: "text", text: "x", width: 320, height: 180, outputPath: destination }, {
      ...harness(new FakeWindow(), {}),
      unlink: async (file) => { unlinks++; await fsp.unlink(file); },
    }), "processing_failed");
    expect(unlinks).toBe(0);
    expect(await fsp.readFile(destination, "utf8")).toBe("existing");
  });
});
