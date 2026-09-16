/**
 * M185 — iframe-side `nautiloApp` bridge client tests.
 *
 * Pins the postMessage round-trip contract: requestId pairing, source
 * validation on responses, pending-request behavior, and that request
 * envelopes carry no host identifiers.
 */

/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-implied-eval, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  buildNautiloAppBridgeClientScript,
  installNautiloAppBridgeClient,
} from "../../src/apps/app-bridge-client";
import type { NautiloAppBridge } from "../../src/apps/app-bridge-client";

interface CapturedMessage {
  type: string;
  requestId?: string;
  op?: string;
  key?: string;
  value?: unknown;
  summary?: unknown;
  update?: unknown;
  baseSha256?: string | null;
  baseRevision?: number | null;
  ref?: string;
  document?: unknown;
  sourceFingerprint?: string;
  job?: unknown;
  mediaId?: string;
  mediaKind?: string;
  enabled?: boolean;
}

type TestWindow = Window & { nautiloApp?: NautiloAppBridge };

interface TestState {
  win: TestWindow;
  capturedMessages: CapturedMessage[];
  origPostMessage: typeof Window.prototype.postMessage;
}

const NO_RESPONSE_WINDOW_MS = 35;
type HappyDomAsyncApi = {
  happyDOM?: {
    cancelAsync?: () => Promise<void>;
    close?: () => Promise<void>;
  };
};

function setupParentStub(state: TestState): void {
  state.origPostMessage = state.win.parent.postMessage.bind(state.win.parent);
  state.win.parent.postMessage = (message: unknown) => {
    state.capturedMessages.push(message as CapturedMessage);
  };
}

function teardownParentStub(state: TestState): void {
  state.win.parent.postMessage = state.origPostMessage;
}

function respondAsParent(state: TestState, requestId: string, payload: object): void {
  const event = new state.win.MessageEvent("message", {
    data: { type: "nautilo.app.res", requestId, ...payload },
    source: state.win.parent as unknown as MessageEventSource,
  });
  state.win.dispatchEvent(event);
}

function setupBridge(): TestState {
  const win = new Window({ url: "http://127.0.0.1:3001/" }) as TestWindow;
  const state: TestState = {
    win,
    capturedMessages: [],
    origPostMessage: win.parent.postMessage,
  };
  setupParentStub(state);
  installNautiloAppBridgeClient(win as unknown as Window);
  return state;
}

describe("M185 nautiloApp bridge client (iframe side)", () => {
  let state: TestState;

  beforeEach(() => {
    state = setupBridge();
  });

  test("templates require an editable host grant and send no owner or document authority", async () => {
    expect(state.win.nautiloApp!.templates).toBeUndefined();
    new Function("window", buildNautiloAppBridgeClientScript(undefined, "preview", { templates: true }))(state.win);
    expect(state.win.nautiloApp!.templates).toBeUndefined();
    new Function("window", buildNautiloAppBridgeClientScript(undefined, "edit", { templates: true }))(state.win);
    const saved = state.win.nautiloApp!.templates!.save({ name: "Quarterly update", content: "slide-content" });
    const request = state.capturedMessages.at(-1)!;
    expect(request).toEqual({ type: "nautilo.app.templates.req", requestId: request.requestId,
      op: "save", name: "Quarterly update", content: "slide-content" });
    respondAsParent(state, request.requestId!, { ok: true, value: { id: "template-id", name: "Quarterly update" } });
    await expect(saved).resolves.toEqual({ id: "template-id", name: "Quarterly update" });
    const read = state.win.nautiloApp!.templates!.read("template-id");
    const readRequest = state.capturedMessages.at(-1)!;
    expect(readRequest).toEqual({ type: "nautilo.app.templates.req", requestId: readRequest.requestId, op: "read", templateId: "template-id" });
    respondAsParent(state, readRequest.requestId!, { ok: true, value: { content: "slide-content" } });
    await expect(read).resolves.toEqual({ content: "slide-content" });
    const removed = state.win.nautiloApp!.templates!.remove("template-id");
    const removeRequest = state.capturedMessages.at(-1)!;
    expect(removeRequest).toEqual({ type: "nautilo.app.templates.req", requestId: removeRequest.requestId, op: "remove", templateId: "template-id" });
    respondAsParent(state, removeRequest.requestId!, { ok: false, status: 403, error: "Template access denied" });
    await expect(removed).rejects.toThrow("Template access denied");
  });

  afterEach(async () => {
    teardownParentStub(state);
    const asyncApi = state.win as Window & HappyDomAsyncApi;
    await asyncApi.happyDOM?.cancelAsync?.();
    await asyncApi.happyDOM?.close?.();
    state.win.close();
  });

  test("install creates frozen window.nautiloApp without host identifier fields", () => {
    expect(Object.isFrozen(state.win.nautiloApp)).toBe(true);
    expect(Object.isFrozen(state.win.nautiloApp?.document)).toBe(true);
    expect(Object.isFrozen(state.win.nautiloApp?.assets)).toBe(true);
    expect(Object.isFrozen(state.win.nautiloApp?.state)).toBe(true);
    expect(Object.isFrozen(state.win.nautiloApp?.preferences)).toBe(true);
    expect(Object.isFrozen(state.win.nautiloApp?.context)).toBe(true);
    expect(Object.isFrozen(state.win.nautiloApp?.humanEdit)).toBe(true);
    expect(Object.isFrozen(state.win.nautiloApp?.lifecycle)).toBe(true);
    expect(state.win.nautiloApp?.version).toBe(1);
    expect(typeof state.win.nautiloApp?.document.read).toBe("function");
    expect(typeof state.win.nautiloApp?.document.stat).toBe("function");
    expect(typeof state.win.nautiloApp?.document.write).toBe("function");
    expect(typeof state.win.nautiloApp?.document.onChange).toBe("function");
    expect(typeof state.win.nautiloApp?.state.get).toBe("function");
    expect(typeof state.win.nautiloApp?.state.set).toBe("function");
    expect(typeof state.win.nautiloApp?.preferences.get).toBe("function");
    expect(typeof state.win.nautiloApp?.context.set).toBe("function");
    expect(typeof state.win.nautiloApp?.humanEdit.set).toBe("function");
    expect(typeof state.win.nautiloApp?.lifecycle.onPrepareClose).toBe("function");
    expect(typeof state.win.nautiloApp?.session.onChange).toBe("function");
    expect("recovery" in (state.win.nautiloApp ?? {})).toBe(false);
    expect("appId" in (state.win.nautiloApp ?? {})).toBe(false);
    expect("artifactId" in (state.win.nautiloApp ?? {})).toBe(false);
    expect("id" in (state.win.nautiloApp ?? {})).toBe(false);
    expect("path" in (state.win.nautiloApp ?? {})).toBe(false);
    expect("rootPath" in (state.win.nautiloApp ?? {})).toBe(false);
    expect("roomId" in (state.win.nautiloApp ?? {})).toBe(false);
    expect("namespaceId" in (state.win.nautiloApp ?? {})).toBe(false);
  });

  test("exposes recovery only when the edit host explicitly enables it", async () => {
    installNautiloAppBridgeClient(state.win as unknown as Window, undefined, "edit", { recovery: true });

    expect(Object.isFrozen(state.win.nautiloApp?.recovery)).toBe(true);
    const pending = state.win.nautiloApp!.recovery!.read();
    const message = state.capturedMessages.at(-1)!;
    expect(message).toMatchObject({ type: "nautilo.app.recovery.req", op: "read" });
    expect("appId" in message).toBe(false);
    expect("artifactId" in message).toBe(false);
    respondAsParent(state, message.requestId!, { ok: true, value: { revision: null, draft: null } });
    await expect(pending).resolves.toEqual({ revision: null, draft: null });
  });

  test("does not expose recovery in preview even when the capability is requested", () => {
    installNautiloAppBridgeClient(state.win as unknown as Window, undefined, "preview", { recovery: true });

    expect("recovery" in state.win.nautiloApp!).toBe(false);
  });

  test("replaces server placeholder with the real frozen bridge", () => {
    state.win.nautiloApp = Object.freeze({ version: 1, appId: "sample-app" }) as never;
    installNautiloAppBridgeClient(state.win as unknown as Window);
    expect(Object.isFrozen(state.win.nautiloApp)).toBe(true);
    expect("appId" in (state.win.nautiloApp ?? {})).toBe(false);
    expect(typeof state.win.nautiloApp?.document.read).toBe("function");
  });

  test("presentation theme bootstraps before app code and accepts only finite parent updates", () => {
    installNautiloAppBridgeClient(state.win as unknown as Window, "light");
    expect(state.win.document.documentElement.dataset.theme).toBe("light");
    expect(state.win.document.documentElement.style.colorScheme).toBe("light");
    expect(buildNautiloAppBridgeClientScript("dark")).toContain('"dark"');

    state.win.dispatchEvent(
      new state.win.MessageEvent("message", {
        data: { type: "nautilo.app.presentation.theme", theme: "dark" },
        source: null,
      }),
    );
    state.win.dispatchEvent(
      new state.win.MessageEvent("message", {
        data: { type: "nautilo.app.presentation.theme", theme: "night" },
        source: state.win.parent as unknown as MessageEventSource,
      }),
    );
    expect(state.win.document.documentElement.dataset.theme).toBe("light");
    expect(state.win.document.documentElement.style.colorScheme).toBe("light");

    state.win.dispatchEvent(
      new state.win.MessageEvent("message", {
        data: { type: "nautilo.app.presentation.theme", theme: "dark" },
        source: state.win.parent as unknown as MessageEventSource,
      }),
    );
    expect(state.win.document.documentElement.dataset.theme).toBe("dark");
    expect(state.win.document.documentElement.style.colorScheme).toBe("dark");
  });

  test("document.read posts expected message and resolves on parent response", async () => {
    const p = state.win.nautiloApp!.document.read();
    expect(state.capturedMessages.length).toBe(1);
    const msg = state.capturedMessages[0]!;
    expect(msg.type).toBe("nautilo.app.document.req");
    expect(msg.op).toBe("read");
    expect(typeof msg.requestId).toBe("string");
    expect(msg.requestId!.length).toBeGreaterThan(0);
    expect("appId" in msg).toBe(false);
    expect("artifactId" in msg).toBe(false);
    respondAsParent(state, msg.requestId!, { ok: true, value: { content: "{}" } });
    await expect(p).resolves.toEqual({ content: "{}" });
  });

  test("video generation is opt-in and posts no parent authority", async () => {
    expect(state.win.nautiloApp?.videoGeneration).toBeUndefined();
    installNautiloAppBridgeClient(state.win as unknown as Window, { videoGeneration: true });
    const request = state.win.nautiloApp!.videoGeneration!.request({
      document: { sha256: "a".repeat(64), revision: 2 },
      sourceFingerprint: `sha256:${"b".repeat(64)}`,
      job: {
        source: { kind: "quick-brief" },
        prompt: "A clean compiler prompt.",
        modelId: "venice:seedance-2-5-text-to-video-basic",
        requestedSettings: { durationSeconds: 5, aspectRatio: "16:9", resolution: "720p" },
      },
    });
    const msg = state.capturedMessages.at(-1)!;
    expect(msg.type).toBe("nautilo.app.video-generation.request");
    expect(msg.document).toEqual({ sha256: "a".repeat(64), revision: 2 });
    expect(msg.sourceFingerprint).toBe(`sha256:${"b".repeat(64)}`);
    expect("token" in msg).toBe(false);
    expect("roomId" in msg).toBe(false);
    expect("projectArtifactId" in msg).toBe(false);
    expect("reviewHandle" in msg).toBe(false);
    respondAsParent(state, msg.requestId!, { ok: true, value: { kind: "queued" } });
    await expect(request).resolves.toEqual({ kind: "queued" });
  });

  test("batch reference import preserves successes and explicit failures without host authority", async () => {
    installNautiloAppBridgeClient(state.win as unknown as Window, { videoGeneration: true });
    const asset = { artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53", path: "refs/a.png", label: "A", mediaKind: "image", mimeType: "image/png", sizeBytes: 8 };
    const result = { kind: "ready", assets: [asset, { ...asset, artifactId: "58a0266d-b1c2-4ffd-9c10-2865bea8fc53", label: "B", path: "refs/b.png" }], failures: [{ label: "broken.png", code: "processing_unavailable" }] };
    const pending = state.win.nautiloApp!.videoGeneration!.importReferences({ mediaKind: "image" });
    const message = state.capturedMessages.at(-1)!;
    expect(message).toMatchObject({ op: "importReferences", mediaKind: "image" });
    expect(Object.keys(message).sort()).toEqual(["mediaKind", "op", "requestId", "type"]);
    respondAsParent(state, message.requestId!, { ok: true, value: result });
    await expect(pending).resolves.toEqual(result);
    const invalid = state.win.nautiloApp!.videoGeneration!.importReferences({ mediaKind: "image" });
    respondAsParent(state, state.capturedMessages.at(-1)!.requestId!, { ok: true, value: { ...result, assets: [{ ...asset, reviewHandle: "private" }] } });
    await expect(invalid).resolves.toMatchObject({ kind: "unavailable" });
  });

  test("saved reference preview sends only its project-local identity", async () => {
    installNautiloAppBridgeClient(state.win as unknown as Window, { mediaProxy: true, videoGeneration: true });
    const pending = state.win.nautiloApp!.media!.openPreview({ referenceId: "ref_cast" });
    const message = state.capturedMessages.at(-1)!;
    expect(message).toMatchObject({ type: "nautilo.app.media.req", op: "openPreview", referenceId: "ref_cast" });
    expect(Object.keys(message).sort()).toEqual(["op", "referenceId", "requestId", "type"]);
    respondAsParent(state, message.requestId!, { ok: true, value: { kind: "ready", url: "blob:saved-reference", mimeType: "image/png", sizeBytes: 24, revokeToken: "preview_ref" } });
    await expect(pending).resolves.toMatchObject({ kind: "ready", revokeToken: "preview_ref" });
  });

  test("reference import returns only a closed safe Workspace asset", async () => {
    installNautiloAppBridgeClient(state.win as unknown as Window, { videoGeneration: true });
    const safeAsset = {
      artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53",
      path: "video-references/reference.png",
      label: "Character reference",
      mediaKind: "image" as const,
      mimeType: "image/png",
      sizeBytes: 8,
    };
    const ready = state.win.nautiloApp!.videoGeneration!.importReference({ mediaKind: "image" });
    const request = state.capturedMessages.at(-1)!;
    expect(request).toMatchObject({ type: "nautilo.app.video-generation.req", op: "importReference", mediaKind: "image" });
    expect(request).not.toHaveProperty("path");
    expect(request).not.toHaveProperty("artifactId");
    expect(request).not.toHaveProperty("base64");
    respondAsParent(state, request.requestId!, { ok: true, value: { kind: "ready", asset: safeAsset } });
    await expect(ready).resolves.toEqual({ kind: "ready", asset: safeAsset });

    const expectRejected = async (asset: Record<string, unknown>) => {
      const pending = state.win.nautiloApp!.videoGeneration!.importReference({ mediaKind: "image" });
      const message = state.capturedMessages.at(-1)!;
      respondAsParent(state, message.requestId!, { ok: true, value: { kind: "ready", asset } });
      await expect(pending).resolves.toEqual({ kind: "unavailable", code: "invalid_response" });
    };
    await expectRejected({ ...safeAsset, path: "/private/reference.png" });
    await expectRejected({ ...safeAsset, mediaKind: "video", mimeType: "image/png" });
    await expectRejected({ ...safeAsset, artifactId: "internal-row-17" });
    await expectRejected({ ...safeAsset, sizeBytes: 100 * 1024 * 1024 + 1 });
    await expectRejected({ ...safeAsset, provider: { url: "https://provider.example/job" } });
  });

  test("queued generation exposes only its safe take selector for scene sequencing", async () => {
    installNautiloAppBridgeClient(state.win as unknown as Window, { videoGeneration: true });
    for (const takeId of ["take_abcdefghijklmnop", "https://not-a-take.invalid"]) {
      const request = state.win.nautiloApp!.videoGeneration!.request({
        document: { sha256: "a".repeat(64), revision: 2 }, sourceFingerprint: `sha256:${"b".repeat(64)}`,
        job: { source: { kind: "quick-brief" }, prompt: "Opening", modelId: "venice:seedance-2-5-text-to-video-basic" },
      });
      const message = state.capturedMessages.at(-1)!;
      respondAsParent(state, message.requestId!, { ok: true, value: { kind: "queued", takeId, receiptId: "private", reviewHandle: "private" } });
      expect(await request).toEqual(takeId.startsWith("take_") ? { kind: "queued", takeId } : { kind: "queued" });
    }
  });

  test("Video host layout is a separate opt-in with one closed reversible request", async () => {
    expect(state.win.nautiloApp?.hostLayout).toBeUndefined();
    installNautiloAppBridgeClient(state.win as unknown as Window, { videoHostLayout: true });
    const request = state.win.nautiloApp!.hostLayout!.setFullWidth({ enabled: true });
    const msg = state.capturedMessages.at(-1)!;
    expect(msg).toMatchObject({ type: "nautilo.app.video-host-layout.req", op: "setFullWidth", enabled: true });
    expect("path" in msg).toBe(false);
    expect("roomId" in msg).toBe(false);
    respondAsParent(state, msg.requestId!, { ok: true, value: undefined });
    await expect(request).resolves.toBeUndefined();
  });

  test("larger generated-take collections cross the serialized bridge without losing labels", async () => {
    new Function("window", buildNautiloAppBridgeClientScript({ videoGeneration: true }))(state.win);
    const takes = Array.from({ length: 513 }, (_, index) => ({
      takeId: `take_${String(index).padStart(16, "0")}`, shotId: "quick-brief",
      shotLabel: "Complete creative label ".repeat(50), documentRevision: index,
    }));
    const pending = state.win.nautiloApp!.videoGeneration!.listTakes();
    const request = state.capturedMessages.at(-1)!;
    respondAsParent(state, request.requestId!, { ok: true, value: { kind: "ready", takes } });
    await expect(pending).resolves.toEqual({ kind: "ready", takes });
  });

  test("generated-take operations use opaque handles and fail closed on malformed status", async () => {
    installNautiloAppBridgeClient(state.win as unknown as Window, { videoGeneration: true });
    const list = state.win.nautiloApp!.videoGeneration!.listTakes();
    const listMessage = state.capturedMessages.at(-1)!;
    expect(listMessage.type).toBe("nautilo.app.video-generation.req");
    expect(listMessage.op).toBe("listTakes");
    expect("token" in listMessage).toBe(false);
    expect("roomId" in listMessage).toBe(false);
    respondAsParent(state, listMessage.requestId!, { ok: true, value: { kind: "ready", takes: [{ takeId: "take_abcdefghijklmnop", shotId: "quick-brief", shotLabel: "Quick brief", documentRevision: 4 }] } });
    await expect(list).resolves.toEqual({ kind: "ready", takes: [{ takeId: "take_abcdefghijklmnop", shotId: "quick-brief", shotLabel: "Quick brief", documentRevision: 4 }] });

    const malformed = state.win.nautiloApp!.videoGeneration!.getTakeStatus({ takeId: "take_abcdefghijklmnop" });
    const statusMessage = state.capturedMessages.at(-1)!;
    expect(statusMessage.op).toBe("getTakeStatus");
    expect((statusMessage as unknown as Record<string, unknown>)["takeId"]).toBe("take_abcdefghijklmnop");
    respondAsParent(state, statusMessage.requestId!, { ok: true, value: { kind: "ready", status: { takeId: "take_abcdefghijklmnop", receiptId: "must-not-pass" } } });
    await expect(malformed).resolves.toEqual({ kind: "unavailable", code: "invalid_response" });
  });

  test("document.write includes baseSha256 and baseRevision when provided", async () => {
    const p = state.win.nautiloApp!.document.write('{"cells":[]}', {
      baseSha256: "abc123",
      baseRevision: 7,
    });
    expect(state.capturedMessages.length).toBe(1);
    const msg = state.capturedMessages[0]!;
    expect(msg.type).toBe("nautilo.app.document.req");
    expect(msg.op).toBe("write");
    expect(msg.value).toBe('{"cells":[]}');
    expect(msg.baseSha256).toBe("abc123");
    expect(msg.baseRevision).toBe(7);
    respondAsParent(state, msg.requestId!, { ok: true, value: { saved: true } });
    await expect(p).resolves.toEqual({ saved: true });
  });

  test("document.write accepts { content: string } envelope", async () => {
    const p = state.win.nautiloApp!.document.write({ content: "hello" });
    const msg = state.capturedMessages[0]!;
    expect(msg.value).toEqual({ content: "hello" });
    respondAsParent(state, msg.requestId!, { ok: true, value: null });
    await expect(p).resolves.toBeNull();
  });

  test("document.saveCopy posts only the exact content and resolves the host path", async () => {
    const pending = state.win.nautiloApp!.document.saveCopy({ content: "exact draft" });
    const message = state.capturedMessages.at(-1)!;
    expect(message).toMatchObject({
      type: "nautilo.app.document.req",
      op: "saveCopy",
      value: { content: "exact draft" },
    });
    expect(JSON.stringify(message)).not.toContain("artifactId");
    respondAsParent(state, message.requestId!, { ok: true, value: { path: "copy.design.json" } });
    await expect(pending).resolves.toEqual({ path: "copy.design.json" });
  });

  test("assets pick and read use the source-bound request protocol without caller authority", async () => {
    const pick = state.win.nautiloApp!.assets.pick();
    const pickMessage = state.capturedMessages.at(-1)!;
    expect(pickMessage).toMatchObject({ type: "nautilo.app.assets.req", op: "pick" });
    expect("appId" in pickMessage).toBeFalse();
    expect("artifactId" in pickMessage).toBeFalse();
    respondAsParent(state, pickMessage.requestId!, { ok: true, value: null });
    await expect(pick).resolves.toBeNull();

    const ref = "artifact:123e4567-e89b-12d3-a456-426614174000:" + "a".repeat(64);
    const read = state.win.nautiloApp!.assets.read(ref);
    const readMessage = state.capturedMessages.at(-1)!;
    expect(readMessage).toMatchObject({ type: "nautilo.app.assets.req", op: "read", ref });
    expect("sessionToken" in readMessage).toBeFalse();
    respondAsParent(state, readMessage.requestId!, { ok: true, value: { ref, name: "photo.png" } });
    await expect(read).resolves.toEqual({ ref, name: "photo.png" });
  });

  test("state.get/set post expected messages", async () => {
    const getP = state.win.nautiloApp!.state.get("sheet");
    const getMsg = state.capturedMessages[0]!;
    expect(getMsg.type).toBe("nautilo.app.state.req");
    expect(getMsg.op).toBe("get");
    expect(getMsg.key).toBe("sheet");
    respondAsParent(state, getMsg.requestId!, { ok: true, value: { rows: 1 } });
    await expect(getP).resolves.toEqual({ rows: 1 });

    const setP = state.win.nautiloApp!.state.set("sheet", { rows: 2 });
    const setMsg = state.capturedMessages[1]!;
    expect(setMsg.op).toBe("set");
    expect(setMsg.key).toBe("sheet");
    expect(setMsg.value).toEqual({ rows: 2 });
    respondAsParent(state, setMsg.requestId!, { ok: true, value: null });
    await expect(setP).resolves.toBeUndefined();
  });

  test("state.get/set reject bad keys before posting", async () => {
    await expect(state.win.nautiloApp!.state.get("")).rejects.toThrow(/non-empty string/);
    await expect(state.win.nautiloApp!.state.set("", 1)).rejects.toThrow(/non-empty string/);
    await expect(state.win.nautiloApp!.state.get("x".repeat(129))).rejects.toThrow(/at most 128/);
    await expect(state.win.nautiloApp!.state.set("bad:key", 1)).rejects.toThrow(/must not contain ':'/);
    expect(state.capturedMessages.length).toBe(0);
  });

  test("preferences expose only registered app keys and receive parent updates", async () => {
    const read = state.win.nautiloApp!.preferences.get("writer.spellcheck");
    const request = state.capturedMessages[0]!;
    expect(request.type).toBe("nautilo.app.preferences.req");
    respondAsParent(state, request.requestId!, { ok: true, value: { enabled: false, language: "en-US", personalWords: [] } });
    await expect(read).resolves.toEqual({ enabled: false, language: "en-US", personalWords: [] });
    const seen: unknown[] = [];
    const unsubscribe = state.win.nautiloApp!.preferences.subscribe("writer.spellcheck", (value) => seen.push(value));
    state.win.dispatchEvent(new state.win.MessageEvent("message", { data: { type: "nautilo.app.preferences.changed", key: "writer.spellcheck", value: { enabled: true } }, source: state.win.parent as unknown as MessageEventSource }));
    expect(seen).toEqual([{ enabled: true }]);
    unsubscribe();

    const designSeen: unknown[] = [];
    const unsubscribeDesign = state.win.nautiloApp!.preferences.subscribe(
      "design.agentReceipts",
      (value) => designSeen.push(value),
    );
    state.win.dispatchEvent(new state.win.MessageEvent("message", {
      data: { type: "nautilo.app.preferences.changed", key: "design.agentReceipts", value: { enabled: false } },
      source: state.win.parent as unknown as MessageEventSource,
    }));
    expect(designSeen).toEqual([{ enabled: false }]);
    unsubscribeDesign();

    const videoSeen: unknown[] = [];
    const unsubscribeVideo = state.win.nautiloApp!.preferences.subscribe(
      "video.agentReceipts",
      (value) => videoSeen.push(value),
    );
    state.win.dispatchEvent(new state.win.MessageEvent("message", {
      data: { type: "nautilo.app.preferences.changed", key: "video.agentReceipts", value: { enabled: false } },
      source: state.win.parent as unknown as MessageEventSource,
    }));
    state.win.dispatchEvent(new state.win.MessageEvent("message", {
      data: { type: "nautilo.app.preferences.changed", key: "other.preference", value: { enabled: true } },
      source: state.win.parent as unknown as MessageEventSource,
    }));
    expect(videoSeen).toEqual([{ enabled: false }]);
    unsubscribeVideo();
  });

  test("preview bootstrap exposes frozen host mode and leaves document navigation readable", () => {
    expect(state.win.nautiloApp!.context.mode).toBe("edit");
    installNautiloAppBridgeClient(state.win as unknown as Window, "dark", "preview");
    expect(state.win.nautiloApp!.context.mode).toBe("preview");
    expect(Object.isFrozen(state.win.nautiloApp!.context)).toBe(true);
    new Function("window", buildNautiloAppBridgeClientScript("light", "preview"))(state.win);
    expect(state.win.nautiloApp!.context.mode).toBe("preview");
    expect(typeof state.win.nautiloApp!.document.read).toBe("function");
    expect(state.win.document.documentElement.dataset["theme"]).toBe("light");
  });

  test("context.set posts one-way update without creating a pending request", () => {
    state.win.nautiloApp!.context.set({ title: "Quarterly", rowCount: 12 });
    expect(state.capturedMessages.length).toBe(1);
    const msg = state.capturedMessages[0]!;
    expect(msg.type).toBe("nautilo.app.context.update");
    expect(msg.summary).toEqual({ title: "Quarterly", rowCount: 12 });
    expect("requestId" in msg).toBe(false);
  });

  test("humanEdit.set posts draft state without any target or session authority", () => {
    state.win.nautiloApp!.humanEdit.set({
      state: "dirty",
      draftPatch: { kind: "anchored_text", oldString: "before", newString: "human" },
    });
    expect(state.capturedMessages).toEqual([
      {
        type: "nautilo.app.human-edit.update",
        update: {
          state: "dirty",
          draftPatch: { kind: "anchored_text", oldString: "before", newString: "human" },
        },
      },
    ]);
    const wire = state.capturedMessages[0] as unknown as Record<string, unknown>;
    for (const key of [
      "target",
      "path",
      "rootPath",
      "roomId",
      "relayId",
      "artifactId",
      "baseVersion",
      "sessionToken",
    ]) {
      expect(key in wire).toBe(false);
      expect(key in (wire["update"] as Record<string, unknown>)).toBe(false);
    }
  });

  test("document.onChange receives parent document-change notifications", () => {
    const events: Array<{ type: "changed" | "renamed" | "deleted"; path?: string }> = [];
    const unsubscribe = state.win.nautiloApp!.document.onChange((event) => {
      events.push(event);
    });

    state.win.dispatchEvent(
      new state.win.MessageEvent("message", {
        data: {
          type: "nautilo.app.document.changed",
          event: { type: "changed", path: "Budget.html" },
        },
        source: state.win.parent as unknown as MessageEventSource,
      }),
    );
    expect(events).toEqual([{ type: "changed", path: "Budget.html" }]);

    unsubscribe();
    state.win.dispatchEvent(
      new state.win.MessageEvent("message", {
        data: {
          type: "nautilo.app.document.changed",
          event: { type: "deleted" },
        },
        source: state.win.parent as unknown as MessageEventSource,
      }),
    );
    expect(events).toHaveLength(1);
  });

  test("document.onChange replays queued document changes posted before subscription", async () => {
    state.win.dispatchEvent(
      new state.win.MessageEvent("message", {
        data: {
          type: "nautilo.app.document.changed",
          event: { type: "changed", path: "Queued.html" },
        },
        source: state.win.parent as unknown as MessageEventSource,
      }),
    );

    const events: unknown[] = [];
    state.win.nautiloApp!.document.onChange((event) => {
      events.push(event);
    });

    await Promise.resolve();
    expect(events).toEqual([{ type: "changed", path: "Queued.html" }]);
  });

  test("live command receiver rejects wrong sender, version, session and deadline and unregisters", () => {
    const capability = { sessionToken: "a".repeat(43), sessionId: "route-a", documentVersion: { kind: "artifact_revision", revision: 7 } };
    state.win.dispatchEvent(new state.win.MessageEvent("message", { data: { type: "nautilo.app.live-session", capability }, source: state.win.parent }));
    let calls = 0;
    const unregister = state.win.nautiloApp!.session.onCommand(() => { calls += 1; return { accepted: true }; });
    const invoke = (patch: object = {}, source: unknown = state.win.parent) => {
      const results: unknown[] = [];
      let closed = false;
      const event = new state.win.MessageEvent("message", {
        data: { type: "nautilo.app.live-command", sessionId: "route-a", documentVersion: capability.documentVersion, deadline: Date.now() + 1_000, command: { action: "pause" }, ...patch },
        source: source as Window,
      });
      Object.defineProperty(event, "ports", { value: [{ postMessage: (result: unknown) => results.push(result), close: () => { closed = true; } }] });
      state.win.dispatchEvent(event);
      return { results, closed };
    };
    expect(invoke({}, null).results).toEqual([]);
    expect(calls).toBe(0);
    for (const patch of [{ sessionId: "route-b" }, { documentVersion: { kind: "artifact_revision", revision: 6 } }, { deadline: 0 }]) {
      expect(invoke(patch)).toEqual({ results: [{ status: "rejected", code: "session_closed", stateChanged: false, retrySafe: false }], closed: true });
    }
    expect(calls).toBe(0);
    expect(invoke()).toEqual({ results: [{ accepted: true }], closed: true });
    expect(calls).toBe(1);
    unregister();
    expect(invoke().results).toEqual([{ status: "rejected", code: "session_closed", stateChanged: false, retrySafe: false }]);
    expect(calls).toBe(1);
  });

  test("live capability is accepted only from the parent and replayed once", async () => {
    const received: unknown[] = [];
    state.win.dispatchEvent(
      new state.win.MessageEvent("message", {
        data: {
          type: "nautilo.app.live-session",
          capability: {
            sessionToken: "a".repeat(43),
            sessionId: "route-a",
            documentVersion: { kind: "artifact_revision", revision: 7 },
          },
        },
        source: null,
      }),
    );
    state.win.dispatchEvent(
      new state.win.MessageEvent("message", {
        data: {
          type: "nautilo.app.live-session",
          capability: {
            sessionToken: "b".repeat(43),
            sessionId: "route-b",
            documentVersion: { kind: "artifact_revision", revision: 8 },
          },
        },
        source: state.win.parent as unknown as MessageEventSource,
      }),
    );
    const unsubscribe = state.win.nautiloApp!.session.onChange((capability) => received.push(capability));
    await Promise.resolve();

    expect(received).toEqual([
      {
        sessionToken: "b".repeat(43),
        sessionId: "route-b",
        documentVersion: { kind: "artifact_revision", revision: 8 },
      },
    ]);
    unsubscribe();
  });

  test("live proposals accept only parent source and deduplicate", async () => {
    const received: unknown[] = [];
    const proposal = {
      proposalId: "tool-386",
      appId: "nautilo-writer",
      sessionId: "writer-routing-session",
      documentVersion: { kind: "artifact_revision", revision: 7 },
      operations: [{ type: "insert_text" }],
    };
    const unsubscribe = state.win.nautiloApp!.session.onProposal((next) => received.push(next));

    state.win.dispatchEvent(
      new state.win.MessageEvent("message", {
        data: { type: "nautilo.app.live-proposal", proposal },
        source: null,
      }),
    );
    state.win.dispatchEvent(
      new state.win.MessageEvent("message", {
        data: { type: "nautilo.app.live-proposal", proposal },
        source: state.win.parent as unknown as MessageEventSource,
      }),
    );
    state.win.dispatchEvent(
      new state.win.MessageEvent("message", {
        data: { type: "nautilo.app.live-proposal", proposal },
        source: state.win.parent as unknown as MessageEventSource,
      }),
    );
    await Promise.resolve();
    expect(received).toEqual([proposal]);

    state.win.dispatchEvent(
      new state.win.MessageEvent("message", {
        data: {
          type: "nautilo.app.live-proposal",
          proposal: { ...proposal, proposalId: "tool-387" },
        },
        source: state.win.parent as unknown as MessageEventSource,
      }),
    );
    await Promise.resolve();
    expect(received).toEqual([proposal, { ...proposal, proposalId: "tool-387" }]);
    unsubscribe();
  });

  test("holds a proposal until Writer receives capability, then acknowledges visible review once", async () => {
    const proposal = {
      proposalId: "tool-queued",
      appId: "nautilo-writer",
      sessionId: "writer-routing-session",
      documentVersion: { kind: "artifact_revision" as const, revision: 7 },
      operations: [{ type: "insert_text" }],
    };
    const received: string[] = [];
    const unsubscribeCapability = state.win.nautiloApp!.session.onChange(() => {
      received.push("capability");
    });
    const unsubscribe = state.win.nautiloApp!.session.onProposal((next) => {
      received.push(next.proposalId);
      state.win.nautiloApp!.session.acknowledgeProposal({
        proposalId: next.proposalId,
        documentVersion: next.documentVersion,
      });
    });
    state.win.dispatchEvent(
      new state.win.MessageEvent("message", {
        data: { type: "nautilo.app.live-proposal", proposal },
        source: state.win.parent as unknown as MessageEventSource,
      }),
    );
    await Promise.resolve();
    expect(received).toEqual([]);

    state.win.dispatchEvent(
      new state.win.MessageEvent("message", {
        data: {
          type: "nautilo.app.live-session",
          capability: {
            sessionToken: "a".repeat(43),
            sessionId: proposal.sessionId,
            documentVersion: proposal.documentVersion,
          },
        },
        source: state.win.parent as unknown as MessageEventSource,
      }),
    );
    await Promise.resolve();
    expect(received).toEqual(["capability", "tool-queued"]);
    expect(state.capturedMessages.filter((message) => message.type === "nautilo.app.live-proposal.ack")).toEqual([{
      type: "nautilo.app.live-proposal.ack",
      proposalId: "tool-queued",
      documentVersion: { kind: "artifact_revision", revision: 7 },
    }]);

    state.win.dispatchEvent(
      new state.win.MessageEvent("message", {
        data: { type: "nautilo.app.live-proposal", proposal },
        source: state.win.parent as unknown as MessageEventSource,
      }),
    );
    await Promise.resolve();
    expect(received).toEqual(["capability", "tool-queued"]);
    expect(state.capturedMessages.filter((message) => message.type === "nautilo.app.live-proposal.ack")).toHaveLength(1);
    unsubscribeCapability();
    unsubscribe();
  });

  test("live proposal dedupe cache evicts old IDs without retaining their payloads", async () => {
    const sendProposal = (proposalId: string) => {
      state.win.dispatchEvent(
        new state.win.MessageEvent("message", {
          data: {
            type: "nautilo.app.live-proposal",
            proposal: {
              proposalId,
              appId: "nautilo-writer",
              sessionId: "writer-routing-session",
              documentVersion: { kind: "artifact_revision", revision: 7 },
              operations: [{ type: "insert_text" }],
            },
          },
          source: state.win.parent as unknown as MessageEventSource,
        }),
      );
    };

    const received: string[] = [];
    const unsubscribe = state.win.nautiloApp!.session.onProposal((proposal) => {
      received.push(proposal.proposalId);
    });
    for (let index = 0; index <= 256; index += 1) sendProposal(`bounded-${index}`);
    await Promise.resolve();
    expect(received).toHaveLength(257);
    expect(received.at(-1)).toBe("bounded-256");

    sendProposal("bounded-256");
    expect(received).toHaveLength(257);

    sendProposal("bounded-0");
    expect(received).toHaveLength(258);
    expect(received.at(-1)).toBe("bounded-0");
    unsubscribe();
  });

  test("session.onClosed accepts only parent source", async () => {
    const received: unknown[] = [];
    const unsubscribe = state.win.nautiloApp!.session.onClosed((event) => received.push(event));

    state.win.dispatchEvent(
      new state.win.MessageEvent("message", {
        data: { type: "nautilo.app.live-session.closed", sessionId: "route-a", reason: "session_closed" },
        source: null,
      }),
    );
    state.win.dispatchEvent(
      new state.win.MessageEvent("message", {
        data: { type: "nautilo.app.live-session.closed", sessionId: "route-a", reason: "relay_disconnected" },
        source: state.win.parent as unknown as MessageEventSource,
      }),
    );
    await Promise.resolve();
    expect(received).toEqual([{ sessionId: "route-a", reason: "relay_disconnected" }]);
    unsubscribe();
  });

  test("session.acceptProposal posts stable requestId and no mutation ids", async () => {
    const responsePromise = state.win.nautiloApp!.session.acceptProposal({
      requestId: "accept-retry-1",
      proposalId: "proposal-1",
      documentVersion: { kind: "local_sha", sha256: "a".repeat(64) },
      acceptedOperationIndexes: [0, 2],
      acceptedContent: "<html></html>",
    });

    expect(state.capturedMessages).toEqual([
      {
        type: "nautilo.app.session.req",
        op: "acceptProposal",
        requestId: "accept-retry-1",
        proposalId: "proposal-1",
        documentVersion: { kind: "local_sha", sha256: "a".repeat(64) },
        acceptedOperationIndexes: [0, 2],
        acceptedContent: "<html></html>",
      },
    ]);
    expect(JSON.stringify(state.capturedMessages)).not.toContain("clientMutationId");
    expect(JSON.stringify(state.capturedMessages)).not.toContain("mutationId");

    respondAsParent(state, "accept-retry-1", {
      ok: true,
      value: {
        ok: true,
        documentVersion: { kind: "local_sha", sha256: "b".repeat(64) },
        contentSha256: "b".repeat(64),
        localRevisionRef: "rev-1",
      },
    });
    await expect(responsePromise).resolves.toEqual({
      ok: true,
      documentVersion: { kind: "local_sha", sha256: "b".repeat(64) },
      contentSha256: "b".repeat(64),
      localRevisionRef: "rev-1",
    });
  });

  test("session.acceptProposal resolves structured failure on acceptance_conflict", async () => {
    const secret = "private accepted document bytes";
    const responsePromise = state.win.nautiloApp!.session.acceptProposal({
      requestId: "accept-conflict-1",
      proposalId: "proposal-1",
      documentVersion: { kind: "local_sha", sha256: "a".repeat(64) },
      acceptedOperationIndexes: [0],
      acceptedContent: secret,
    });

    respondAsParent(state, "accept-conflict-1", {
      ok: false,
      code: "acceptance_conflict",
      message: "acceptance_conflict",
      status: 409,
    });

    const result = await responsePromise;
    expect(result).toEqual({
      ok: false,
      code: "acceptance_conflict",
      message: "acceptance_conflict",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("session.resolveProposal sends only proposal identity and persisted outcome", async () => {
    const responsePromise = state.win.nautiloApp!.session.resolveProposal({
      proposalId: "proposal-1",
      documentVersion: { kind: "artifact_revision", revision: 4 },
      outcome: "accepted",
    });
    const request = state.capturedMessages[0]!;
    expect(request).toMatchObject({
      type: "nautilo.app.session.req",
      op: "resolveProposal",
      proposalId: "proposal-1",
      documentVersion: { kind: "artifact_revision", revision: 4 },
      outcome: "accepted",
    });
    expect(JSON.stringify(request)).not.toContain("sessionToken");
    expect(JSON.stringify(request)).not.toContain("taskId");
    respondAsParent(state, request.requestId!, {
      ok: true,
      value: { ok: true, taskStatus: "completed" },
    });
    await expect(responsePromise).resolves.toEqual({ ok: true, taskStatus: "completed" });
  });

  test("session.acceptProposal fail-closes malformed failure responses", async () => {
    const responsePromise = state.win.nautiloApp!.session.acceptProposal({
      requestId: "accept-malformed-1",
      proposalId: "proposal-1",
      documentVersion: { kind: "local_sha", sha256: "a".repeat(64) },
      acceptedOperationIndexes: [0],
      acceptedContent: "<html></html>",
    });

    respondAsParent(state, "accept-malformed-1", {
      ok: false,
      error: "sneaky /repo/notes.html token leak",
      status: 409,
    });

    await expect(responsePromise).resolves.toEqual({
      ok: false,
      code: "invalid_request",
      message: "invalid_request",
    });
  });

  test("document.read still rejects on generic ok:false bridge failures", async () => {
    const p = state.win.nautiloApp!.document.read();
    const id = state.capturedMessages[0]!.requestId!;
    respondAsParent(state, id, { ok: false, error: "Conflict", status: 409 });
    await expect(p).rejects.toThrow(/409.*Conflict/);
  });

  test("document.onChange accepts patch_applied and changed reloadRequired events", () => {
    const events: unknown[] = [];
    const unsubscribe = state.win.nautiloApp!.document.onChange((event) => {
      events.push(event);
    });

    state.win.dispatchEvent(
      new state.win.MessageEvent("message", {
        data: {
          type: "nautilo.app.document.changed",
          event: {
            type: "patch_applied",
            path: "Budget.html",
            patchId: "patch-42",
            revision: 8,
            sha256: "sha-next",
            previousRevision: 7,
            previousSha256: "sha-prev",
            patch: { kind: "anchored_text", oldString: "a", newString: "b" },
            author: { kind: "agent", displayName: "Genie" },
            rebased: false,
            envelope: {
              content: "b",
              mimeType: "text/html",
              path: "Budget.html",
              baseSha256: "sha-next",
              baseRevision: 8,
            },
          },
        },
        source: state.win.parent as unknown as MessageEventSource,
      }),
    );
    state.win.dispatchEvent(
      new state.win.MessageEvent("message", {
        data: {
          type: "nautilo.app.document.changed",
          event: { type: "changed", path: "Budget.html", reloadRequired: true },
        },
        source: state.win.parent as unknown as MessageEventSource,
      }),
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "patch_applied",
      patchId: "patch-42",
      envelope: { baseSha256: "sha-next", path: "Budget.html" },
    });
    expect(events[1]).toEqual({
      type: "changed",
      path: "Budget.html",
      reloadRequired: true,
    });

    unsubscribe();
  });

  test("document.onChange ignores malformed patch_applied payloads", () => {
    const events: unknown[] = [];
    const unsubscribe = state.win.nautiloApp!.document.onChange((event) => {
      events.push(event);
    });

    state.win.dispatchEvent(
      new state.win.MessageEvent("message", {
        data: {
          type: "nautilo.app.document.changed",
          event: {
            type: "patch_applied",
            patchId: "patch-bad",
            revision: 1,
            sha256: "sha-next",
            previousRevision: 0,
            previousSha256: "sha-prev",
            patch: { kind: "anchored_text", oldString: "a", newString: "b" },
          },
        },
        source: state.win.parent as unknown as MessageEventSource,
      }),
    );

    expect(events).toHaveLength(0);
    unsubscribe();
  });

  test("unknown response requestId is ignored", async () => {
    const p = state.win.nautiloApp!.document.read();
    const id = state.capturedMessages[0]!.requestId!;
    respondAsParent(state, "unknown-id", { ok: true, value: "ignored" });
    respondAsParent(state, id, { ok: true, value: "real" });
    await expect(p).resolves.toBe("real");
  });

  test("ok:false rejects with status and message", async () => {
    const p = state.win.nautiloApp!.document.read();
    const id = state.capturedMessages[0]!.requestId!;
    respondAsParent(state, id, { ok: false, error: "Conflict", status: 409 });
    await expect(p).rejects.toThrow(/409.*Conflict/);
  });

  test("response from non-parent source is ignored", async () => {
    const p = state.win.nautiloApp!.state.get("key");
    const id = state.capturedMessages[0]!.requestId!;
    state.win.dispatchEvent(
      new state.win.MessageEvent("message", {
        data: { type: "nautilo.app.res", requestId: id, ok: true, value: "spoof" },
        source: null,
      }),
    );
    respondAsParent(state, id, { ok: true, value: "real" });
    await expect(p).resolves.toBe("real");
  });

  test("elapsed wall time does not reject a pending bridge request", async () => {
    const p = state.win.nautiloApp!.document.stat();
    const requestId = state.capturedMessages[0]!.requestId!;
    let settled = false;
    void p.finally(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, NO_RESPONSE_WINDOW_MS));

    expect(settled).toBe(false);
    respondAsParent(state, requestId, { ok: true, value: { size: 42 } });
    await expect(p).resolves.toEqual({ size: 42 });
  });

  test("document.write remains pending without a response and accepts a late canonical response", async () => {
    const p = state.win.nautiloApp!.document.write({ content: "late canonical save" });
    const requestId = state.capturedMessages[0]!.requestId!;
    let settled = false;
    void p.finally(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, NO_RESPONSE_WINDOW_MS));

    expect(settled).toBe(false);
    expect(state.capturedMessages).toHaveLength(1);
    respondAsParent(state, requestId, {
      ok: true,
      value: { kind: "saved", sha256: "canonical-sha", revision: 9 },
    });
    await expect(p).resolves.toEqual({ kind: "saved", sha256: "canonical-sha", revision: 9 });
  });

  test("buildNautiloAppBridgeClientScript contains no host identifiers", () => {
    const script = buildNautiloAppBridgeClientScript();
    expect(script).not.toMatch(/artifactId/);
    expect(script).not.toMatch(/roomId/);
    expect(script).not.toMatch(/namespaceId/);
    expect(script).not.toMatch(/bearer/i);
    expect(script).toContain("nautilo.app.document.req");
    expect(script).toContain("nautilo.app.live-proposal");
    expect(script).not.toContain("nautiloApp timeout");
  });

  test("build script can be evaluated to install the client", async () => {
    new Function("window", buildNautiloAppBridgeClientScript())(state.win);

    expect(Object.isFrozen(state.win.nautiloApp)).toBe(true);
    expect(state.win.nautiloApp?.version).toBe(1);
    const p = state.win.nautiloApp!.document.read();
    const id = state.capturedMessages[0]!.requestId!;
    respondAsParent(state, id, { ok: true, value: "from-inline" });
    await expect(p).resolves.toBe("from-inline");
  });

  test("serialized authored history read sends no path, revision, or actor authority", async () => {
    new Function("window", buildNautiloAppBridgeClientScript())(state.win);
    const pending = state.win.nautiloApp!.document.authoredChange();
    const request = state.capturedMessages[0]!;
    expect(typeof request.requestId).toBe("string");
    expect(request).toEqual({ type: "nautilo.app.document.req", op: "authoredChange", requestId: request.requestId });
    respondAsParent(state, request.requestId!, { ok: true, value: { kind: "none" } });
    await expect(pending).resolves.toEqual({ kind: "none" });
  });

  test("build script defaults recovery off and honors an explicit edit capability", () => {
    new Function("window", buildNautiloAppBridgeClientScript())(state.win);
    expect("recovery" in state.win.nautiloApp!).toBe(false);

    new Function(
      "window",
      buildNautiloAppBridgeClientScript(undefined, "edit", { recovery: true }),
    )(state.win);
    expect(typeof state.win.nautiloApp!.recovery?.write).toBe("function");
  });

  test("build script handles patch_applied document changes without external helpers", () => {
    new Function("window", buildNautiloAppBridgeClientScript())(state.win);

    const events: unknown[] = [];
    state.win.nautiloApp!.document.onChange((event) => {
      events.push(event);
    });

    state.win.dispatchEvent(
      new state.win.MessageEvent("message", {
        data: {
          type: "nautilo.app.document.changed",
          event: {
            type: "patch_applied",
            path: "Budget.html",
            patchId: "patch-inline",
            revision: 9,
            sha256: "sha-next",
            previousRevision: 8,
            previousSha256: "sha-prev",
            patch: { kind: "anchored_text", oldString: "a", newString: "b" },
            envelope: {
              content: "b",
              mimeType: "text/html",
              path: "Budget.html",
              baseSha256: "sha-next",
              baseRevision: 9,
            },
          },
        },
        source: state.win.parent as unknown as MessageEventSource,
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "patch_applied",
      patchId: "patch-inline",
      envelope: { content: "b", baseSha256: "sha-next" },
    });
  });

  test("registers an awaited close handler and responds only to the parent", async () => {
    const calls: unknown[] = [];
    const unregister = state.win.nautiloApp!.lifecycle.onPrepareClose(async (request) => {
      calls.push(request);
      return { documentSaved: false, recoveryPersisted: true, recoverableDraftExact: true };
    });
    expect(state.capturedMessages.at(-1)).toEqual({ type: "nautilo.app.lifecycle.register" });

    const request = {
      type: "nautilo.app.lifecycle.prepare-close",
      requestId: "close-1",
      reason: "replace",
      action: "prepare-close",
    };
    state.win.dispatchEvent(new state.win.MessageEvent("message", { data: request, source: null }));
    await Promise.resolve();
    expect(calls).toHaveLength(0);

    state.win.dispatchEvent(new state.win.MessageEvent("message", {
      data: request,
      source: state.win.parent as unknown as MessageEventSource,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([{ reason: "replace", action: "prepare-close" }]);
    expect(state.capturedMessages.at(-1)).toMatchObject({
      type: "nautilo.app.lifecycle.prepare-close.result",
      requestId: "close-1",
      ok: true,
    });

    unregister();
    expect(state.capturedMessages.at(-1)).toEqual({ type: "nautilo.app.lifecycle.unregister" });
  });

  test("turns a synchronous close-handler throw into a failure response", async () => {
    state.win.nautiloApp!.lifecycle.onPrepareClose(() => {
      throw new Error("flush failed synchronously");
    });
    state.win.dispatchEvent(new state.win.MessageEvent("message", {
      data: {
        type: "nautilo.app.lifecycle.prepare-close",
        requestId: "close-sync-throw",
        reason: "close",
        action: "prepare-close",
      },
      source: state.win.parent as unknown as MessageEventSource,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.capturedMessages.at(-1)).toEqual({
      type: "nautilo.app.lifecycle.prepare-close.result",
      requestId: "close-sync-throw",
      ok: false,
      error: "flush failed synchronously",
    });
  });

  test("does not expose asset reads without a trusted grant", () => {
    expect(state.win.nautiloApp?.asset).toBeUndefined();
    expect(state.win.nautiloApp?.media).toBeUndefined();
  });

  test("export capability discovery exposes only a host-owned boolean", async () => {
    installNautiloAppBridgeClient(state.win as unknown as Window, { mediaProxy: true });
    for (const [value, expected] of [[{ workspace: true }, true], [{ workspace: false }, false], [{ workspace: true, roomId: "forbidden" }, false]] as const) {
      const pending = state.win.nautiloApp!.media!.getExportCapabilities();
      const message = state.capturedMessages.at(-1)!;
      expect(message).toMatchObject({ type: "nautilo.app.media.req", op: "exportCapabilities" });
      expect(Object.keys(message).sort()).toEqual(["op", "requestId", "type"]);
      respondAsParent(state, message.requestId!, { ok: true, value });
      await expect(pending).resolves.toEqual({ workspace: expected });
    }
  });

  test("granted raster reads use opaque refs and transferable bytes", async () => {
    installNautiloAppBridgeClient(state.win as unknown as Window, { assetReadRaster: true });
    const pending = state.win.nautiloApp!.asset!.read({ ref: "media/poster.png" });
    const message = state.capturedMessages.at(-1)!;
    expect(message).toMatchObject({ type: "nautilo.app.asset.req", op: "read", ref: "media/poster.png" });
    expect(message).not.toHaveProperty("path");
    respondAsParent(state, message.requestId!, {
      ok: true,
      value: {
        kind: "ready",
        mimeType: "image/png",
        sizeBytes: 3,
        bytes: new Uint8Array([1, 2, 3]),
      },
    });
    await expect(pending).resolves.toMatchObject({ kind: "ready", mimeType: "image/png", sizeBytes: 3 });
  });

  test("Workspace media blobs become iframe-owned URLs and are revoked on close", async () => {
    installNautiloAppBridgeClient(state.win as unknown as Window, { mediaProxy: true });
    const pending = state.win.nautiloApp!.media!.openPreview({ mediaId: "source" });
    const message = state.capturedMessages.at(-1)!;
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "video/mp4" });
    respondAsParent(state, message.requestId!, { ok: true, value: { kind: "ready", url: "blob:https://parent.invalid/owned", blob, mimeType: "video/mp4", sizeBytes: 3, revokeToken: "preview-blob" } });
    const result = await pending;
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("Preview failed");
    expect(result.url).not.toBe("blob:https://parent.invalid/owned");
    expect([...new Uint8Array(await (await fetch(result.url)).arrayBuffer())]).toEqual([1, 2, 3]);
    const close = state.win.nautiloApp!.media!.closePreview(result.revokeToken);
    respondAsParent(state, state.capturedMessages.at(-1)!.requestId!, { ok: true, value: undefined });
    await close;
    await expect(fetch(result.url)).rejects.toThrow();
  });

  test("native previews carry derived waveform peaks without media bytes and reject malformed peaks", async () => {
    installNautiloAppBridgeClient(state.win as unknown as Window, { mediaProxy: true });
    for (const peaks of [[0, 0.4, 1], [Number.NaN], [-1], [2]]) {
      const pending = state.win.nautiloApp!.media!.openPreview({ mediaId: "source" });
      respondAsParent(state, state.capturedMessages.at(-1)!.requestId!, { ok: true, value: {
        kind: "ready", url: "nautilo-media://proxy/opaque", mimeType: "audio/wav", sizeBytes: 101 * 1024 * 1024,
        revokeToken: "opaque", waveform: { peaks, samplesPerSecond: 100 },
      } });
      if (peaks.length === 3) await expect(pending).resolves.toMatchObject({ kind: "ready", waveform: { peaks, samplesPerSecond: 100 } });
      else await expect(pending).resolves.toEqual({ kind: "unavailable", code: "invalid_response" });
    }
  });

  test("rejects a Workspace media blob with mismatched declared bytes", async () => {
    installNautiloAppBridgeClient(state.win as unknown as Window, { mediaProxy: true });
    const pending = state.win.nautiloApp!.media!.openPreview({ mediaId: "source" });
    respondAsParent(state, state.capturedMessages.at(-1)!.requestId!, { ok: true, value: { kind: "ready", url: "blob:https://parent.invalid/owned", blob: new Blob(["abc"], { type: "video/mp4" }), mimeType: "video/mp4", sizeBytes: 4, revokeToken: "bad" } });
    await expect(pending).resolves.toEqual({ kind: "unavailable", code: "invalid_response" });
  });

  test("granted media proxy imports and previews only through opaque messages", async () => {
    installNautiloAppBridgeClient(state.win as unknown as Window, { mediaProxy: true });

    const importPending = state.win.nautiloApp!.media!.importVideo();
    const importMessage = state.capturedMessages.at(-1)!;
    expect(importMessage).toMatchObject({ type: "nautilo.app.media.req", op: "importVideo" });
    expect(importMessage).not.toHaveProperty("path");
    respondAsParent(state, importMessage.requestId!, {
      ok: true,
      value: { kind: "ready", mediaRef: "media/clip.mp4", label: "clip.mp4", durationSec: 3, frameRate: { numerator: 30, denominator: 1 } },
    });
    await expect(importPending).resolves.toMatchObject({ kind: "ready", mediaRef: "media/clip.mp4" });

    const previewPending = state.win.nautiloApp!.media!.openPreview({ ref: "media/clip.mp4" });
    const previewMessage = state.capturedMessages.at(-1)!;
    expect(previewMessage).toMatchObject({ type: "nautilo.app.media.req", op: "openPreview", ref: "media/clip.mp4" });
    expect(previewMessage).not.toHaveProperty("path");
    respondAsParent(state, previewMessage.requestId!, {
      ok: true,
      value: { kind: "ready", url: "nautilo-media://proxy/preview_opaque", mimeType: "video/mp4", sizeBytes: 24, revokeToken: "preview_opaque" },
    });
    const preview = await previewPending;
    expect(preview).toMatchObject({ kind: "ready", revokeToken: "preview_opaque" });
    const closePending = state.win.nautiloApp!.media!.closePreview("preview_opaque");
    const closeMessage = state.capturedMessages.at(-1)!;
    expect(closeMessage).toMatchObject({ type: "nautilo.app.media.req", op: "closePreview", revokeToken: "preview_opaque" });
    respondAsParent(state, closeMessage.requestId!, { ok: true, value: undefined });
    await closePending;

    const progress: unknown[] = [];
    const exportSettings = { resolution: "720p" as const, quality: "custom" as const, videoBitrateKbps: 4500, audioBitrateKbps: 320 as const };
    const countBeforeInvalid = state.capturedMessages.length;
    expect(await state.win.nautiloApp!.media!.exportVideo({ document: { sha256: "a".repeat(64), revision: 4 }, exportSettings: { ...exportSettings, videoBitrateKbps: -1 } })).toEqual({ kind: "unavailable", code: "invalid_settings" });
    expect(state.capturedMessages).toHaveLength(countBeforeInvalid);
    const exportPending = state.win.nautiloApp!.media!.exportVideo({ document: { sha256: "a".repeat(64), revision: 4 }, publishToWorkspace: true, exportSettings }, { onProgress: (value) => progress.push(value) });
    const exportMessage = state.capturedMessages.at(-1)!;
    expect(exportMessage).toMatchObject({ type: "nautilo.app.media.req", op: "exportVideo", sha256: "a".repeat(64), revision: 4, publishToWorkspace: true });
    expect(exportMessage).toHaveProperty("exportSettings", exportSettings);
    expect(exportMessage).not.toHaveProperty("path"); expect(exportMessage).not.toHaveProperty("plan");
    state.win.dispatchEvent(new state.win.MessageEvent("message", { source: state.win.parent as unknown as MessageEventSource, data: { type: "nautilo.app.media.export-progress", requestId: exportMessage.requestId, progress: { stage: "publishing", processedTimeUs: 20 } } }));
    respondAsParent(state, exportMessage.requestId!, { ok: true, value: { kind: "succeeded", label: "cut.mp4", sizeBytes: 12, warnings: [], workspace: { status: "unknown", path: "exports/cut.mp4" } } });
    await expect(exportPending).resolves.toMatchObject({ kind: "succeeded", label: "cut.mp4", workspace: { status: "unknown", path: "exports/cut.mp4" } });
    expect(progress).toEqual([{ stage: "publishing", processedTimeUs: 20 }]);

    const controller = new AbortController(); const cancelled = state.win.nautiloApp!.media!.exportVideo({ document: { sha256: "b".repeat(64), revision: null } }, { signal: controller.signal });
    controller.abort(); const cancelMessage = state.capturedMessages.at(-1)!; expect(cancelMessage).toMatchObject({ type: "nautilo.app.media.cancel" });
    respondAsParent(state, state.capturedMessages.at(-2)!.requestId!, { ok: true, value: { kind: "cancelled" } });
    await expect(cancelled).resolves.toEqual({ kind: "cancelled" });
  });

  test("serialized media proxy transports durable audio and image media without a generation grant", async () => {
    new Function("window", buildNautiloAppBridgeClientScript({ mediaProxy: true }))(state.win);
    expect(state.win.nautiloApp!.videoGeneration).toBeUndefined();

    const audioPending = state.win.nautiloApp!.media!.importVideo();
    const audioMessage = state.capturedMessages.at(-1)!;
    respondAsParent(state, audioMessage.requestId!, {
      ok: true,
      value: {
        kind: "ready",
        mediaKind: "audio",
        mediaRef: "media/theme.m4a",
        label: "theme.m4a",
        durationSec: 12.5,
        source: {
          kind: "workspace-artifact",
          artifactId: "123e4567-e89b-42d3-a456-426614174000",
          path: "media/theme.m4a",
        },
      },
    });
    await expect(audioPending).resolves.toEqual({
      kind: "ready",
      mediaKind: "audio",
      mediaRef: "media/theme.m4a",
      label: "theme.m4a",
      durationSec: 12.5,
      source: {
        kind: "workspace-artifact",
        artifactId: "123e4567-e89b-42d3-a456-426614174000",
        path: "media/theme.m4a",
      },
    });

    const imagePending = state.win.nautiloApp!.media!.importVideo();
    const imageMessage = state.capturedMessages.at(-1)!;
    respondAsParent(state, imageMessage.requestId!, {
      ok: true,
      value: {
        kind: "ready",
        mediaKind: "image",
        mediaRef: "media/title.webp",
        label: "title.webp",
        source: {
          kind: "workspace-artifact",
          artifactId: "123e4567-e89b-42d3-a456-426614174001",
          path: "media/title.webp",
        },
      },
    });
    await expect(imagePending).resolves.toMatchObject({
      kind: "ready",
      mediaKind: "image",
      mediaRef: "media/title.webp",
    });

    for (const invalidValue of [
      {
        kind: "ready", mediaKind: "audio", mediaRef: "media/theme.wav", label: "theme.wav", durationSec: 2,
        frameRate: { numerator: 30, denominator: 1 },
      },
      { kind: "ready", mediaKind: "image", mediaRef: "media/title.png", label: "title.png", durationSec: 2 },
      {
        kind: "ready", mediaKind: "image", mediaRef: "media/title.png", label: "title.png",
        source: { kind: "workspace-artifact", artifactId: "not-an-artifact-id", path: "media/title.png" },
      },
    ]) {
      const pending = state.win.nautiloApp!.media!.importVideo();
      const message = state.capturedMessages.at(-1)!;
      respondAsParent(state, message.requestId!, { ok: true, value: invalidValue });
      await expect(pending).resolves.toEqual({ kind: "unavailable", code: "invalid_response" });
    }

    for (const [mimeType, ref] of [["audio/mp4", "media/theme.m4a"], ["image/webp", "media/title.webp"]] as const) {
      const pending = state.win.nautiloApp!.media!.openPreview({ ref });
      const message = state.capturedMessages.at(-1)!;
      respondAsParent(state, message.requestId!, {
        ok: true,
        value: { kind: "ready", url: `nautilo-media://proxy/${message.requestId}`, mimeType, sizeBytes: 24, revokeToken: message.requestId },
      });
      await expect(pending).resolves.toMatchObject({ kind: "ready", mimeType });
    }

    const invalidPreview = state.win.nautiloApp!.media!.openPreview({ ref: "media/title.webp" });
    const invalidPreviewMessage = state.capturedMessages.at(-1)!;
    respondAsParent(state, invalidPreviewMessage.requestId!, {
      ok: true,
      value: { kind: "ready", url: "nautilo-media://proxy/invalid", mimeType: "text/html", sizeBytes: 24, revokeToken: "invalid" },
    });
    await expect(invalidPreview).resolves.toEqual({ kind: "unavailable", code: "invalid_response" });
  });

  test("Video generation hosts expose durable previews only by opaque media id", async () => {
    installNautiloAppBridgeClient(state.win as unknown as Window, { videoGeneration: true });
    expect(state.win.nautiloApp!.media).toBeDefined();
    await expect(state.win.nautiloApp!.media!.importVideo()).resolves.toEqual({
      kind: "unavailable",
      code: "unsupported_environment",
    });

    const pending = state.win.nautiloApp!.media!.openPreview({ mediaId: "media_generated_take" });
    const message = state.capturedMessages.at(-1)!;
    expect(message).toMatchObject({ type: "nautilo.app.media.req", op: "openPreview", mediaId: "media_generated_take" });
    expect(message).not.toHaveProperty("ref");
    expect(message).not.toHaveProperty("artifactId");
    expect(message).not.toHaveProperty("path");
    respondAsParent(state, message.requestId!, {
      ok: true,
      value: { kind: "ready", url: "blob:opaque-parent-preview", mimeType: "video/mp4", sizeBytes: 24, revokeToken: "preview_opaque" },
    });
    await expect(pending).resolves.toMatchObject({ kind: "ready", revokeToken: "preview_opaque" });
  });
});
