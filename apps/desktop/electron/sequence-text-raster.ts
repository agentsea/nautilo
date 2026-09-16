import * as fsp from "node:fs/promises";
import { renderTextCompositionHtml } from "../../../packages/first-party-apps/video/src/text-composition.ts";

export type SequenceTextRasterInput = Readonly<{
  kind: "text" | "caption" | "callout";
  text: string;
  width: number;
  height: number;
  outputPath: string;
  signal?: AbortSignal;
}>;

type RasterImage = {
  getSize(): { width: number; height: number };
  resize(options: { width: number; height: number; quality: "best" }): RasterImage;
  toPNG(): Buffer;
};
type RasterSession = {
  setPermissionCheckHandler(handler: () => boolean): void;
  setPermissionRequestHandler(handler: (_contents: unknown, _permission: string, callback: (allowed: boolean) => void) => void): void;
  webRequest: { onBeforeRequest(filter: { urls: string[] }, handler: (details: { url: string }, callback: (response: { cancel: boolean }) => void) => void): void };
};
type RasterWindow = {
  webContents: {
    on(event: "will-navigate" | "will-attach-webview", handler: (event: { preventDefault(): void }) => void): void;
    setWindowOpenHandler(handler: () => { action: "deny" }): void;
    executeJavaScript(script: string, userGesture?: boolean): Promise<unknown>;
    capturePage(rect: { x: number; y: number; width: number; height: number }): Promise<RasterImage>;
  };
  loadURL(url: string): Promise<void>;
  isDestroyed(): boolean;
  destroy(): void;
};

export type SequenceTextRasterDependencies = Readonly<{
  renderHtml?: typeof renderTextCompositionHtml;
  createSession?: (partition: string, options: { cache: false }) => RasterSession;
  createWindow?: (options: Record<string, unknown>) => RasterWindow;
  openFile?: typeof fsp.open;
  unlink?: typeof fsp.unlink;
}>;

const MEASURE_SCRIPT = String.raw`(() => {
  const content = document.querySelector("[data-text-content]");
  const safeArea = document.querySelector("[data-text-safe-area]");
  if (!(content instanceof HTMLElement) || !(safeArea instanceof HTMLElement)) return false;
  const contentRect = content.getBoundingClientRect();
  const safeRect = safeArea.getBoundingClientRect();
  const epsilon = 0.5;
  return content.scrollWidth <= content.clientWidth && content.scrollHeight <= content.clientHeight &&
    contentRect.left >= safeRect.left - epsilon && contentRect.top >= safeRect.top - epsilon &&
    contentRect.right <= safeRect.right + epsilon && contentRect.bottom <= safeRect.bottom + epsilon;
})()`;

const cancelled = (): Error => new Error("cancelled");
const processingFailed = (): Error => new Error("processing_failed");
const RASTER_PARTITION = "sequence-text-raster";

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    const abort = () => { reject(cancelled()); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error instanceof Error ? error : processingFailed()); },
    );
  });
}

export async function rasterizeSequenceText(
  input: SequenceTextRasterInput,
  dependencies: SequenceTextRasterDependencies = {},
): Promise<void> {
  let window: RasterWindow | undefined;
  let createdOutput = false;
  const unlink = dependencies.unlink ?? fsp.unlink;
  const abort = () => {
    if (window && !window.isDestroyed()) window.destroy();
  };
  input.signal?.addEventListener("abort", abort, { once: true });

  try {
    if (input.signal?.aborted) throw cancelled();
    const electron = dependencies.createSession && dependencies.createWindow ? undefined : await import("electron");
    if (input.signal?.aborted) throw cancelled();
    const rasterSession = dependencies.createSession?.(RASTER_PARTITION, { cache: false }) ?? electron!.session.fromPartition(RASTER_PARTITION, { cache: false });
    rasterSession.setPermissionCheckHandler(() => false);
    rasterSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    rasterSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      callback({ cancel: !details.url.startsWith("data:text/html") });
    });

    const options = {
      show: false,
      focusable: false,
      frame: false,
      transparent: true,
      useContentSize: true,
      paintWhenInitiallyHidden: true,
      width: input.width,
      height: input.height,
      webPreferences: {
        session: rasterSession,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    };
    window = dependencies.createWindow?.(options) ?? new electron!.BrowserWindow(options as Electron.BrowserWindowConstructorOptions) as unknown as RasterWindow;
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());

    const html = (dependencies.renderHtml ?? renderTextCompositionHtml)(input.kind, input.text, input.width, input.height);
    await raceAbort(window.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`), input.signal);
    if (input.signal?.aborted) throw cancelled();
    const fits = await raceAbort(window.webContents.executeJavaScript(
      `document.fonts.ready.then(() => ${MEASURE_SCRIPT})`,
      false,
    ), input.signal);
    if (input.signal?.aborted) throw cancelled();
    if (fits !== true) throw new Error("text_overflow");

    let image = await raceAbort(window.webContents.capturePage({ x: 0, y: 0, width: input.width, height: input.height }), input.signal);
    if (input.signal?.aborted) throw cancelled();
    const size = image.getSize();
    if (size.width !== input.width || size.height !== input.height) {
      image = image.resize({ width: input.width, height: input.height, quality: "best" });
    }
    const png = image.toPNG();
    if (input.signal?.aborted) throw cancelled();
    const handle = await (dependencies.openFile ?? fsp.open)(input.outputPath, "wx", 0o600);
    createdOutput = true;
    try {
      if (input.signal?.aborted) throw cancelled();
      await handle.writeFile(png);
      if (input.signal?.aborted) throw cancelled();
    } finally {
      await handle.close();
    }
    if (input.signal?.aborted) throw cancelled();
    createdOutput = false;
  } catch (error) {
    if (createdOutput) await unlink(input.outputPath).catch(() => undefined);
    if (input.signal?.aborted || error instanceof Error && error.message === "cancelled") throw cancelled();
    if (error instanceof Error && error.message === "text_overflow") throw error;
    throw processingFailed();
  } finally {
    input.signal?.removeEventListener("abort", abort);
    if (window && !window.isDestroyed()) window.destroy();
  }
}
