import { beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

const browser = new Window();
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator, IS_REACT_ACT_ENVIRONMENT: true });

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  return { promise: new Promise<T>((done, fail) => { resolve = done; reject = fail; }), resolve, reject };
}
type Download = { fileUri: string; size: number; cleanup(): void };

let token = "token-a";
let snapshotOwner = "reader-a";
let pendingDownloads: Array<Deferred<Download>> = [];
let downloads: Array<{ url: string; token: string; filename: string; signal: AbortSignal }> = [];
let tokenCalls: Array<{ forceRefresh?: boolean }> = [];
let roomUrls: Array<{ attachmentId: string; roomId: string }> = [];
let cleanups = 0;
let cleanupFailures = 0;
let cachePrepares = 0;
let prepareGate: Deferred<void> | undefined;
let saves: Array<{ requestId: string; fileUri: string; filename: string; mimeType: string }> = [];
let cancellations: string[] = [];
let saveReceipt: Deferred<{ status: "saved" | "cancelled" }>;
let saveAvailable = true;
let nextId = 0;
let fileActions: Array<{ text: string; onPress?: () => void }> = [];

const nativeElement = (tag: string) => ({ children, onPress }: { children?: unknown; onPress?: () => void }) => createElement(tag, { onClick: onPress }, children as never);
mock.module("react-native", () => ({
  Alert: { alert: (_title: string, _message: string, actions: typeof fileActions) => { fileActions = actions; } },
  ActivityIndicator: nativeElement("span"), Modal: nativeElement("div"), Pressable: nativeElement("button"), Text: nativeElement("span"), View: nativeElement("div"),
  StyleSheet: { create: <T,>(styles: T) => styles }, Platform: { OS: "ios" },
}));
mock.module("react-native-safe-area-context", () => ({ SafeAreaView: nativeElement("div") }));
mock.module("expo-crypto", () => ({ randomUUID: () => `save-${++nextId}` }));
mock.module("../../../modules/nautilo-file-export", () => ({
  isFileExportAvailable: () => saveAvailable,
  isMediaExportAvailable: () => saveAvailable,
  default: {
    prepareExportCacheAsync: async () => { cachePrepares += 1; await prepareGate?.promise; },
    saveFileAsync: (input: { requestId: string; fileUri: string; filename: string; mimeType: string }) => { saves.push(input); return saveReceipt.promise; },
    saveMediaAsync: (input: { requestId: string; fileUri: string; filename: string; mimeType: string }) => { saves.push(input); return saveReceipt.promise; },
    cancelPendingExportAsync: async (requestId: string) => { cancellations.push(requestId); return true; },
  },
}));
mock.module("@/features/artifacts/artifact-image-inspector", () => ({ ArtifactImageInspector: ({ uri }: { uri: string }) => createElement("div", { "data-uri": uri }, "image-ready") }));
mock.module("@/features/artifacts/artifact-save-feedback", () => ({ nativeSaveFailureCopy: () => "Save failed." }));
mock.module("@/providers/theme", () => ({ useAppTheme: () => ({ color: { surface: { background: "#fff" }, border: { default: "#ddd" }, brand: { accent: "#205493" }, text: { foreground: "#222" } } }) }));
mock.module("@/lib/auth", () => ({ ensureValidToken: async (_serverId: string, _url: string, options: { forceRefresh?: boolean }) => { tokenCalls.push(options); return token; } }));
mock.module("@/lib/server-store", () => ({ loadTokenSnapshot: async () => ({ tokens: token ? { accessToken: token, userId: snapshotOwner } : null }) }));
mock.module("@/lib/api", () => ({ getApiClient: () => ({ getMessageAttachmentUrl: (attachmentId: string, input: { roomId: string }) => { roomUrls.push({ attachmentId, roomId: input.roomId }); return `https://test.invalid/rooms/${input.roomId}/attachments/${attachmentId}`; } }) }));
mock.module("@/lib/artifact-bytes", () => ({ normalizeDownloadError: (error: { status?: number }) => ({ status: error.status ?? null, aborted: false }) }));
mock.module("@/lib/original-file-download", () => ({ downloadOriginalFile: (input: { url: string; token: string; filename: string; signal: AbortSignal }) => {
  downloads.push(input);
  const next = deferred<Download>();
  pendingDownloads.push(next);
  return next.promise;
} }));

const { MessageAttachmentViewer } = await import("./message-attachment-viewer.native");

const attachment = { kind: "retained" as const, attachmentId: "attachment-a", uri: "attachment://retained/attachment-a", filename: "nested/photo.png", mimeType: "image/png", sizeBytes: 4 };
let scope = { serverId: "server-a", serverUrl: "https://test.invalid", accountId: "reader-a", roomId: "room-a", messageId: "message-a" };
async function mount(selectedAttachment = attachment) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let closes = 0;
  const render = async () => { await act(async () => { root.render(createElement(MessageAttachmentViewer, { attachment: selectedAttachment, scope, onClose: () => { closes += 1; } })); }); };
  await render();
  return { host, render, closes: () => closes, close: async () => { await act(async () => { root.unmount(); await Promise.resolve(); }); host.remove(); } };
}
function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((node) => node.textContent === label);
  if (!found) throw new Error(`Missing ${label}`);
  return found;
}
function resolveDownload(index = 0, size = attachment.sizeBytes): void {
  pendingDownloads[index].resolve({ fileUri: `file:///cache/nautilo-exports/op-${index}/photo.png`, size, cleanup: () => { cleanups += 1; if (cleanupFailures > 0) { cleanupFailures -= 1; throw new Error("synthetic cleanup failure"); } } });
}

function chooseFileAction(host: HTMLElement, label: string): void {
  button(host, "File actions").click();
  const action = fileActions.find((candidate) => candidate.text === label);
  if (!action?.onPress) throw new Error(`Missing native file action ${label}`);
  action.onPress();
}

beforeEach(() => {
  token = "token-a"; snapshotOwner = "reader-a"; scope = { serverId: "server-a", serverUrl: "https://test.invalid", accountId: "reader-a", roomId: "room-a", messageId: "message-a" };
  pendingDownloads = []; saveReceipt = deferred<{ status: "saved" | "cancelled" }>(); downloads = []; tokenCalls = []; roomUrls = []; cleanups = cleanupFailures = cachePrepares = nextId = 0; saves = []; cancellations = []; saveAvailable = true; prepareGate = undefined;
});

test("acquires only for the current owner and uses the room-scoped attachment URL", async () => {
  const ui = await mount();
  try {
    expect(cachePrepares).toBe(1);
    expect(roomUrls).toEqual([{ attachmentId: "attachment-a", roomId: "room-a" }]);
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatchObject({ url: "https://test.invalid/rooms/room-a/attachments/attachment-a", token: "token-a", filename: "photo.png" });
    await act(async () => { resolveDownload(); await Promise.resolve(); });
    expect(ui.host.textContent).toContain("image-ready");
  } finally { await ui.close(); }
});

test("documents, videos, and unsupported retained files expose honest Save recovery without a fake inline preview", async () => {
  for (const candidate of [
    { ...attachment, attachmentId: "document-a", filename: "report.pdf", mimeType: "application/pdf" },
    { ...attachment, attachmentId: "video-a", filename: "clip.mp4", mimeType: "video/mp4" },
    { ...attachment, attachmentId: "binary-a", filename: "archive.bin", mimeType: "application/octet-stream" },
  ]) {
    const ui = await mount(candidate);
    try {
      expect(downloads).toHaveLength(0);
      expect(ui.host.textContent).toContain(candidate.filename);
      expect(ui.host.textContent).toContain(candidate.mimeType);
      expect(ui.host.textContent).toContain("Inline preview is not available");
      expect(ui.host.textContent).not.toContain("image-ready");

      button(ui.host, "File actions").click();
      expect(fileActions.map((action) => action.text)).toEqual(candidate.mimeType.startsWith("video/")
        ? ["Save file…", "Save to Photos", "Cancel"]
        : ["Save file…", "Cancel"]);
      await act(async () => { button(ui.host, "Save file…").click(); await Promise.resolve(); });
      expect(downloads).toHaveLength(1);
      await act(async () => { resolveDownload(0); await Promise.resolve(); });
      expect(saves.at(-1)).toMatchObject({ filename: candidate.filename, mimeType: candidate.mimeType });
      await act(async () => { saveReceipt.resolve({ status: "saved" }); await Promise.resolve(); });
    } finally {
      await ui.close();
    }
    pendingDownloads = []; downloads = []; saves = []; fileActions = [];
    saveReceipt = deferred<{ status: "saved" | "cancelled" }>();
  }
});

test("rejects a stale account before requesting the room URL or attachment bytes", async () => {
  snapshotOwner = "reader-b";
  const ui = await mount();
  try {
    await act(async () => { await Promise.resolve(); });
    expect(roomUrls).toHaveLength(0); expect(downloads).toHaveLength(0);
    expect(ui.host.textContent).toContain("Could not prepare this attachment");
  } finally { await ui.close(); }
});

test("cancels a delayed prior-account download, cleans its late file, and never publishes it", async () => {
  const ui = await mount();
  try {
    scope = { ...scope, accountId: "reader-b" };
    snapshotOwner = "reader-b";
    await ui.render();
    expect(downloads[0].signal.aborted).toBe(true);
    await act(async () => { resolveDownload(); await Promise.resolve(); });
    expect(cleanups).toBe(1);
    expect(ui.host.textContent).not.toContain("image-ready");
  } finally { await ui.close(); }
});

test("reports a downloaded byte-count mismatch and releases its temporary file", async () => {
  const ui = await mount();
  try {
    await act(async () => { resolveDownload(0, 3); await Promise.resolve(); });
    expect(cleanups).toBe(1);
    expect(ui.host.textContent).toContain("Could not prepare this attachment");
    expect(ui.host.textContent).not.toContain("image-ready");
  } finally { await ui.close(); }
});

test("retries a failed preparation with a fresh acquisition", async () => {
  const ui = await mount();
  try {
    await act(async () => { pendingDownloads[0].reject(new Error("network")); await Promise.resolve(); });
    expect(ui.host.textContent).toContain("Could not prepare this attachment");
    await act(async () => { button(ui.host, "Retry attachment").click(); });
    expect(cachePrepares).toBe(2); expect(downloads).toHaveLength(2);
    await act(async () => { resolveDownload(1); await Promise.resolve(); });
    expect(ui.host.textContent).toContain("image-ready");
  } finally { await ui.close(); }
});

test("retries a 401 download once with a refreshed token, then reports the download failure", async () => {
  const ui = await mount();
  try {
    await act(async () => { pendingDownloads[0].reject({ status: 401 }); await Promise.resolve(); });
    expect(tokenCalls).toEqual([{ forceRefresh: false }, { forceRefresh: true }]);
    expect(downloads).toHaveLength(2);
    await act(async () => { pendingDownloads[1].reject(new Error("network")); await Promise.resolve(); });
    expect(ui.host.textContent).toContain("Could not prepare this attachment");
  } finally { await ui.close(); }
});

test("closing during a pending save requests exact cancellation and keeps the source until its receipt", async () => {
  const ui = await mount();
  try {
    await act(async () => { resolveDownload(); await Promise.resolve(); });
    await act(async () => { chooseFileAction(ui.host, "Save file…"); });
    expect(downloads).toHaveLength(2);
    await act(async () => { resolveDownload(1); await Promise.resolve(); });
    expect(saves).toEqual([{ requestId: "save-1", fileUri: "file:///cache/nautilo-exports/op-1/photo.png", filename: "photo.png", mimeType: "image/png" }]);
    await act(async () => { button(ui.host, "Close").click(); });
    expect(cancellations).toEqual(["save-1"]); expect(cleanups).toBe(0); expect(ui.closes()).toBe(0);
    await act(async () => { saveReceipt.resolve({ status: "cancelled" }); await Promise.resolve(); });
    expect(cleanups).toBe(2); expect(ui.closes()).toBe(1);
  } finally { await ui.close(); }
});

test("a cleanup failure while closing stays visible and a later Close retries only cleanup", async () => {
  const ui = await mount();
  try {
    await act(async () => { resolveDownload(); await Promise.resolve(); });
    cleanupFailures = 1;
    await act(async () => { button(ui.host, "Close").click(); });
    expect(ui.closes()).toBe(0);
    expect(ui.host.textContent).toContain("temporary app copy could not be removed");
    await act(async () => { button(ui.host, "Close").click(); });
    expect(ui.closes()).toBe(1);
    expect(cachePrepares).toBe(1);
  } finally { await ui.close(); }
});

test("save cleanup failure stays visible after the native receipt, then Close retries cleanup", async () => {
  const ui = await mount();
  try {
    await act(async () => { resolveDownload(); await Promise.resolve(); });
    await act(async () => { chooseFileAction(ui.host, "Save file…"); await Promise.resolve(); });
    await act(async () => { resolveDownload(1); await Promise.resolve(); });
    expect(saves).toHaveLength(1);
    await act(async () => { button(ui.host, "Close").click(); });
    cleanupFailures = 1;
    await act(async () => { saveReceipt.resolve({ status: "cancelled" }); await Promise.resolve(); });
    expect(ui.closes()).toBe(0);
    expect(ui.host.textContent).toContain("save operation ended");
    await act(async () => { button(ui.host, "Close").click(); });
    expect(ui.closes()).toBe(1);
  } finally { await ui.close(); }
});

test("a later Save drains the prior residual before acquiring another source", async () => {
  const ui = await mount();
  try {
    await act(async () => { resolveDownload(); await Promise.resolve(); });
    await act(async () => { chooseFileAction(ui.host, "Save file…"); await Promise.resolve(); });
    await act(async () => { resolveDownload(1); await Promise.resolve(); });
    cleanupFailures = 1;
    await act(async () => { saveReceipt.resolve({ status: "saved" }); await Promise.resolve(); });
    expect(cleanups).toBe(1);
    expect(downloads).toHaveLength(2);
    saveReceipt = deferred<{ status: "saved" | "cancelled" }>();
    await act(async () => { chooseFileAction(ui.host, "Save file…"); await Promise.resolve(); });
    expect(cleanups).toBe(2);
    expect(downloads).toHaveLength(3);
    expect(saves).toHaveLength(1);
    await act(async () => { resolveDownload(2); await Promise.resolve(); });
    await act(async () => { saveReceipt.resolve({ status: "cancelled" }); await Promise.resolve(); });
  } finally { await ui.close(); }
});

test("an observed source-loss unmount cancels its pending save and cleans only after its receipt", async () => {
  const ui = await mount();
  try {
    await act(async () => { resolveDownload(); await Promise.resolve(); });
    await act(async () => { chooseFileAction(ui.host, "Save file…"); await Promise.resolve(); });
    await act(async () => { resolveDownload(1); await Promise.resolve(); });
    expect(saves).toHaveLength(1);
    await ui.close();
    expect(cancellations).toEqual(["save-1"]); expect(cleanups).toBe(0);
    await act(async () => { saveReceipt.resolve({ status: "cancelled" }); await Promise.resolve(); });
    expect(cleanups).toBe(2);
  } finally {
    // The source-loss simulation has already unmounted the host.
  }
});

test("a fresh Room-source denial never exports the stale displayed attachment", async () => {
  const ui = await mount();
  try {
    await act(async () => { resolveDownload(); await Promise.resolve(); });
    expect(ui.host.textContent).toContain("image-ready");
    await act(async () => { chooseFileAction(ui.host, "Save file…"); await Promise.resolve(); });
    expect(downloads).toHaveLength(2);
    await act(async () => { pendingDownloads[1].reject({ status: 403 }); await Promise.resolve(); });
    expect(saves).toHaveLength(0);
    expect(cleanups).toBe(1);
    expect(ui.host.textContent).toContain("no longer available");
    expect(ui.host.textContent).not.toContain("image-ready");
  } finally { await ui.close(); }
});

test("a denied source with failed preview cleanup removes the preview and exposes retryable cleanup", async () => {
  const ui = await mount();
  try {
    await act(async () => { resolveDownload(); await Promise.resolve(); });
    await act(async () => { chooseFileAction(ui.host, "Save file…"); await Promise.resolve(); });
    cleanupFailures = 1;
    await act(async () => { pendingDownloads[1].reject({ status: 404 }); await Promise.resolve(); });
    expect(saves).toHaveLength(0);
    expect(ui.host.textContent).not.toContain("image-ready");
    expect(ui.host.textContent).toContain("temporary app copy could not be removed");
    await act(async () => { button(ui.host, "Close").click(); });
    expect(ui.closes()).toBe(1);
  } finally { await ui.close(); }
});

test("source loss during deferred save preparation never opens native Save and cleans after the fence settles", async () => {
  const ui = await mount();
  try {
    await act(async () => { resolveDownload(); await Promise.resolve(); });
    prepareGate = deferred<void>();
    await act(async () => { chooseFileAction(ui.host, "Save file…"); });
    await ui.close();
    expect(cancellations).toEqual(["save-1"]); expect(saves).toHaveLength(0); expect(cleanups).toBe(0);
    await act(async () => { prepareGate?.resolve(); await Promise.resolve(); });
    expect(saves).toHaveLength(0); expect(cleanups).toBe(1);
  } finally {
    // The source-loss simulation has already unmounted the host.
  }
});
