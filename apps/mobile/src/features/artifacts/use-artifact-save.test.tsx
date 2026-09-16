import { beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ArtifactConvergenceEvent } from "./artifact-convergence";

const browser = new Window();
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator, IS_REACT_ACT_ENVIRONMENT: true });
let accountId = "reader";
let available = true;
let mediaAvailable = true;
let mimeType = "application/zip";
let nativeDestination = "";
let shareAvailable = true;
let finishShare: () => void;
let sequence = 0;
let downloads = 0;
let cleanups = 0;
let tokenOwner = "reader";
let authDead = 0;
let rejectMetadata = false;
let metadataCalls = 0;
let cachePreparationError: Error | null = null;
let downloadCleanupFailure = false;
let downloadOwnedCleanupFailure = false;
let downloadSize = 4;
let prepareExportCache: () => Promise<void> = async () => {};
class TestApiError extends Error { constructor(public status: number, message: string) { super(message); } }
let listener: (event: ArtifactConvergenceEvent) => void = () => {};
const nativeCalls: Array<{ requestId: string; filename: string }> = [];
const cancellations: string[] = [];
mock.module("@/lib/original-file-share", () => ({
  canShareOriginalFile: () => shareAvailable,
  shareOriginalFile: () => { nativeDestination = "share"; return new Promise<void>((resolve) => { finishShare = resolve; }); },
}));
let finishNative: (receipt: { status: "saved" | "cancelled" }) => void;
const subscribe = (next: typeof listener) => { listener = next; return () => { listener = () => {}; }; };
mock.module("expo-crypto", () => ({ randomUUID: () => `save-${++sequence}` }));
mock.module("@/providers/server-registry", () => ({ useServers: () => ({ activeServer: { id: "server", serverUrl: "https://test.invalid" } }) }));
mock.module("@/providers/auth", () => ({ useAuth: () => ({ viewer: { userId: accountId }, status: "signed-in" }) }));
mock.module("@/providers/artifact-events", () => ({ useArtifactEvents: () => ({ subscribe }) }));
mock.module("@/lib/auth", () => ({ ensureValidToken: async () => "synthetic-token" }));
mock.module("@/lib/auth-events", () => ({ emitAuthDead: () => { authDead++; } }));
mock.module("@/lib/server-store", () => ({ loadTokenSnapshot: async () => ({ tokens: { accessToken: "synthetic-token", userId: tokenOwner } }) }));
mock.module("@/lib/original-file-download", () => ({ downloadOriginalFile: async () => {
  downloads++;
  if (downloadCleanupFailure) {
    throw Object.assign(new Error("synthetic temporary cleanup failure"), { code: "ERR_EXPORT_TEMP_CLEANUP" });
  }
  return { fileUri: "file:///cache/nautilo-exports/one/original.zip", size: downloadSize, cleanup: () => {
    cleanups++;
    if (downloadOwnedCleanupFailure) throw new Error("synthetic owned cleanup failure");
  } };
} }));
mock.module("@nautilo/api-client/browser", () => ({
  ApiError: TestApiError,
  NautiloApiClient: class {
    setToken() {}
    getWorkspaceArtifactBytesUrl() { return "https://test.invalid/bytes"; }
    async getWorkspaceArtifact(id: string) {
      metadataCalls++;
      if (rejectMetadata) throw new TestApiError(401, "Rejected synthetic bearer");
      return {
      id, artifactId: "stable", path: "original.zip", mimeType, size: 4, revision: 1, canWrite: false,
    }; }
  },
}));
mock.module("../../../modules/nautilo-file-export", () => ({
  isFileExportAvailable: () => available,
  isMediaExportAvailable: () => mediaAvailable,
  default: {
    prepareExportCacheAsync: async () => {
      if (cachePreparationError) throw cachePreparationError;
      await prepareExportCache();
    },
    saveFileAsync: (input: { requestId: string; filename: string }) => {
      nativeDestination = "file";
      nativeCalls.push(input);
      return new Promise<{ status: "saved" | "cancelled" }>((resolve) => { finishNative = resolve; });
    },
    saveMediaAsync: (input: { requestId: string; filename: string }) => {
      nativeDestination = "media";
      nativeCalls.push(input);
      return new Promise<{ status: "saved" | "cancelled" }>((resolve) => { finishNative = resolve; });
    },
    cancelPendingExportAsync: async (requestId: string) => { cancellations.push(requestId); return true; },
  },
}));
const { useArtifactSave } = await import("./use-artifact-save");
let current: ReturnType<typeof useArtifactSave>;
function Harness() { current = useArtifactSave(); return createElement("span", null, current.state.message); }
async function mount() {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(Harness)); });
  return {
    host,
    render: async () => { await act(async () => { root.render(createElement(Harness)); }); },
    close: async () => { await act(async () => { root.unmount(); }); host.remove(); },
  };
}
beforeEach(() => {
  accountId = tokenOwner = "reader"; available = true; sequence = downloads = cleanups = authDead = 0;
  mediaAvailable = true; mimeType = "application/zip"; nativeDestination = "";
  shareAvailable = true;
  nativeCalls.length = cancellations.length = metadataCalls = 0; rejectMetadata = false;
  cachePreparationError = null; downloadCleanupFailure = false;
  downloadOwnedCleanupFailure = false; downloadSize = 4; prepareExportCache = async () => {};
});

test("read-only media waits for library completion and preserves original cleanup ownership", async () => {
  mimeType = "image/png";
  const ui = await mount();
  try {
    let operation!: Promise<void>;
    await act(async () => { operation = current.save("one", "media"); });
    expect(nativeDestination).toBe("media");
    expect(cleanups).toBe(0);
    expect(current.state.phase).toBe("destination");
    await act(async () => { finishNative({ status: "saved" }); await operation; });
    expect(ui.host.textContent).toBe("Saved to your photo library: original.zip");
    expect(cleanups).toBe(1);
  } finally { await ui.close(); }
});

test("media action rechecks canonical type and leaves Save file available for other formats", async () => {
  const ui = await mount();
  try {
    await act(async () => { await current.save("one", "media"); });
    expect(nativeCalls).toHaveLength(0);
    expect(ui.host.textContent).toContain("Use Save file instead");
    expect(cleanups).toBe(1);
  } finally { await ui.close(); }
});

test("old native media capability fails before downloading", async () => {
  mediaAvailable = false;
  const ui = await mount();
  try {
    await act(async () => { await current.save("one", "media"); });
    expect(downloads).toBe(0);
    expect(current.state.phase).toBe("failed");
    expect(ui.host.textContent).toContain("updated Nautilo");
  } finally { await ui.close(); }
});

test("iOS sharing waits for service dismissal and never calls it Saved or Delivered", async () => {
  const ui = await mount();
  try {
    let operation!: Promise<void>;
    await act(async () => { operation = current.save("one", "share"); });
    expect(nativeDestination).toBe("share");
    expect(nativeCalls).toHaveLength(0);
    expect(cleanups).toBe(0);
    await act(async () => { finishShare(); await operation; });
    expect(current.state.phase).toBe("handoff");
    expect(ui.host.textContent).toContain("Share sheet closed");
    expect(ui.host.textContent).not.toMatch(/Saved|Delivered/);
    expect(cleanups).toBe(1);
  } finally { await ui.close(); }
});

test("Android direct sharing defers to user-owned Files without acquiring a temporary share copy", async () => {
  shareAvailable = false;
  const ui = await mount();
  try {
    await act(async () => { await current.save("one", "share"); });
    expect(downloads).toBe(0);
    expect(ui.host.textContent).toContain("Files app");
  } finally { await ui.close(); }
});

test("read-only unsupported files reach native Save, and source cleanup waits for its receipt", async () => {
  const ui = await mount();
  try {
    let operation!: Promise<void>;
    await act(async () => { operation = current.save("one"); });
    expect(downloads).toBe(1); expect(cleanups).toBe(0);
    expect(current.state.phase).toBe("destination");
    await act(async () => { await current.save("one"); });
    expect(nativeCalls).toHaveLength(1);
    await act(async () => { finishNative({ status: "saved" }); await operation; });
    expect(ui.host.textContent).toBe("Saved: original.zip");
    expect(cleanups).toBe(1); expect(current.busy).toBe(false);
  } finally { await ui.close(); }
});

test("account switch cancels the exact pending save, retains its source, and fences its receipt", async () => {
  const ui = await mount();
  try {
    let operation!: Promise<void>;
    await act(async () => { operation = current.save("one"); });
    accountId = tokenOwner = "other-reader";
    await ui.render();
    expect(cancellations).toEqual(["save-1"]);
    expect(cleanups).toBe(0); expect(current.busy).toBe(true);
    await act(async () => { await current.save("two"); });
    expect(nativeCalls).toHaveLength(1);
    await act(async () => { finishNative({ status: "saved" }); await operation; });
    expect(ui.host.textContent).not.toContain("original.zip");
    expect(current.busy).toBe(false); expect(cleanups).toBe(1);
    await act(async () => { operation = current.save("two"); });
    expect(nativeCalls[1]?.requestId).toBe("save-2");
    await act(async () => { finishNative({ status: "cancelled" }); await operation; });
  } finally { await ui.close(); }
});

test("source revocation cancels native Save without deleting its in-use temporary source", async () => {
  const ui = await mount();
  try {
    let operation!: Promise<void>;
    await act(async () => { operation = current.save("one"); });
    await act(async () => { listener({ type: "deleted", id: "one" } as ArtifactConvergenceEvent); });
    expect(cancellations).toEqual(["save-1"]); expect(cleanups).toBe(0);
    expect(current.state.phase).toBe("cancelling");
    await act(async () => { finishNative({ status: "cancelled" }); await operation; });
    expect(ui.host.textContent).toBe("Save cancelled."); expect(cleanups).toBe(1);
  } finally { await ui.close(); }
});

test("a credential owned by another account never acquires bytes or opens a picker", async () => {
  const ui = await mount();
  try {
    tokenOwner = "other-reader";
    await act(async () => { await current.save("one"); });
    expect(downloads).toBe(0); expect(nativeCalls).toHaveLength(0);
    expect(current.state.phase).toBe("cancelled"); expect(authDead).toBe(0);
  } finally { await ui.close(); }
});

test("a real server 401 for the same account refreshes once then reports auth-dead", async () => {
  const ui = await mount();
  try {
    rejectMetadata = true;
    await act(async () => { await current.save("one"); });
    expect(metadataCalls).toBe(2);
    expect(downloads).toBe(0); expect(nativeCalls).toHaveLength(0);
    expect(current.state.phase).toBe("failed"); expect(authDead).toBe(1);
  } finally { await ui.close(); }
});

test("an old native build gives an explicit upgrade requirement, never a false Saved receipt", async () => {
  const ui = await mount();
  try {
    available = false;
    await act(async () => { await current.save("one"); });
    expect(ui.host.textContent).toContain("updated Nautilo");
    expect(downloads).toBe(0); expect(nativeCalls).toHaveLength(0);
  } finally { await ui.close(); }
});

test("a failed previous-process cache sweep blocks acquisition with an honest residual message", async () => {
  const ui = await mount();
  try {
    cachePreparationError = Object.assign(new Error("synthetic cache sweep failure"), { code: "ERR_EXPORT_CACHE_CLEANUP" });
    await act(async () => { await current.save("one"); });
    expect(downloads).toBe(0); expect(nativeCalls).toHaveLength(0);
    expect(current.state.phase).toBe("failed");
    expect(ui.host.textContent).toContain("temporary app copy could not be removed");
    expect(ui.host.textContent).not.toContain("restart");
  } finally { await ui.close(); }
});

test("download cleanup failure is not reported as connectivity or cancellation", async () => {
  const ui = await mount();
  try {
    downloadCleanupFailure = true;
    await act(async () => { await current.save("one"); });
    expect(nativeCalls).toHaveLength(0);
    expect(current.state.phase).toBe("failed");
    expect(ui.host.textContent).toContain("temporary app copy could not be removed");
  } finally { await ui.close(); }
});

test("size mismatch cleanup failure reports the residual temporary app copy", async () => {
  const ui = await mount();
  try {
    downloadSize = 3; downloadOwnedCleanupFailure = true;
    await act(async () => { await current.save("one"); });
    expect(cleanups).toBe(1); expect(nativeCalls).toHaveLength(0);
    expect(current.state.phase).toBe("failed");
    expect(ui.host.textContent).toContain("temporary app copy could not be removed");
  } finally { await ui.close(); }
});

test("cancellation during cache preparation settles idle ownership and busy state", async () => {
  let finishPreparation!: () => void;
  prepareExportCache = () => new Promise<void>((resolve) => { finishPreparation = resolve; });
  const ui = await mount();
  try {
    let operation!: Promise<void>;
    await act(async () => { operation = current.save("one"); });
    await act(async () => { current.cancel(); });
    expect(current.state.phase).toBe("cancelling");
    await act(async () => { finishPreparation(); await operation; });
    expect(current.state.phase).toBe("cancelled"); expect(current.busy).toBe(false);
    expect(downloads).toBe(0); expect(nativeCalls).toHaveLength(0);
  } finally { await ui.close(); }
});
