import { describe, expect, test } from "bun:test";
import { installNautiloAppBridgeClient, type NautiloAppBridge, type PreparedAppExport } from "./app-bridge-client";
import { requestMiniAppExport } from "./mini-app-export";

const SHA = "a".repeat(64);
const VALID: PreparedAppExport = {
  content: "AP8BgEE=",
  encoding: "base64",
  mimeType: "application/octet-stream",
  byteLength: 5,
  sourceSha256: SHA,
  warnings: ["One warning"],
};

function message(target: EventTarget, source: Window, data: unknown): void {
  const event = new Event("message") as MessageEvent;
  Object.defineProperties(event, { source: { value: source }, data: { value: data } });
  target.dispatchEvent(event);
}

function hostHarness() {
  const host = new EventTarget() as Window;
  const sent: unknown[] = [];
  const source = { postMessage: (value: unknown) => sent.push(value) } as Window;
  const frameEvents = new EventTarget();
  const iframe = frameEvents as HTMLIFrameElement;
  Object.defineProperty(iframe, "contentWindow", { value: source, writable: true });
  return {
    host, source, iframe, sent,
    reply: (replySource: Window, data: unknown) => message(host, replySource, data),
    reload: () => frameEvents.dispatchEvent(new Event("load")),
  };
}

function clientHarness() {
  const child = new EventTarget() as Window;
  const sent: unknown[] = [];
  const parent = { postMessage: (value: unknown) => sent.push(value) } as Window;
  Object.defineProperties(child, {
    parent: { value: parent },
    crypto: { value: crypto },
    document: { value: { documentElement: { dataset: {}, style: {} } } },
  });
  installNautiloAppBridgeClient(child);
  return {
    child, parent, sent,
    api: (child as Window & { nautiloApp: NautiloAppBridge }).nautiloApp,
    request: (data: unknown, source: Window = parent) => message(child, source, data),
  };
}

describe("mini-app export host request", () => {
  test("accepts only a valid response from the exact mounted frame", async () => {
    const h = hostHarness();
    const pending = requestMiniAppExport({
      iframe: h.iframe, actionId: "powerpoint", mimeType: VALID.mimeType, hostWindow: h.host,
    });
    const request = h.sent[0] as { requestId: string };
    h.reply({} as Window, { type: "nautilo.app.export.prepare.result", requestId: request.requestId, ok: true, result: VALID });
    h.reply(h.source, { type: "nautilo.app.export.prepare.result", requestId: "wrong", ok: true, result: VALID });
    h.reply(h.source, { type: "nautilo.app.export.prepare.result", requestId: request.requestId, ok: true, result: VALID });
    expect(await pending).toEqual(VALID);
  });

  test.each([
    ["MIME", { ...VALID, mimeType: "application/pdf" }],
    ["byte length", { ...VALID, byteLength: 4 }],
    ["SHA", { ...VALID, sourceSha256: "A".repeat(64) }],
    ["base64 alphabet", { ...VALID, content: "AP8BgE-_" }],
    ["base64 padding", { ...VALID, content: "AP8BgEE" }],
    ["warnings", { ...VALID, warnings: [3] }],
  ])("rejects invalid %s payloads", async (_label, result) => {
    const h = hostHarness();
    const pending = requestMiniAppExport({ iframe: h.iframe, actionId: "powerpoint", mimeType: VALID.mimeType, hostWindow: h.host });
    const request = h.sent[0] as { requestId: string };
    h.reply(h.source, { type: "nautilo.app.export.prepare.result", requestId: request.requestId, ok: true, result });
    await expect(pending).rejects.toThrow("invalid export payload");
  });

  test("rejects app errors and unavailable frames", async () => {
    const h = hostHarness();
    const pending = requestMiniAppExport({ iframe: h.iframe, actionId: "powerpoint", mimeType: VALID.mimeType, hostWindow: h.host });
    const request = h.sent[0] as { requestId: string };
    h.reply(h.source, { type: "nautilo.app.export.prepare.result", requestId: request.requestId, ok: false, error: "serialization failed" });
    await expect(pending).rejects.toThrow("serialization failed");
    Object.defineProperty(h.iframe, "contentWindow", { value: null, writable: true });
    await expect(requestMiniAppExport({ iframe: h.iframe, actionId: "x", mimeType: VALID.mimeType, hostWindow: h.host }))
      .rejects.toThrow("unavailable");
  });

  test("rejects abort, reload, and replacement of the mounted frame", async () => {
    const aborted = hostHarness();
    const controller = new AbortController();
    const abortPending = requestMiniAppExport({ iframe: aborted.iframe, actionId: "x", mimeType: VALID.mimeType, signal: controller.signal, hostWindow: aborted.host });
    controller.abort();
    await expect(abortPending).rejects.toThrow("aborted");

    const loaded = hostHarness();
    const loadPending = requestMiniAppExport({ iframe: loaded.iframe, actionId: "x", mimeType: VALID.mimeType, hostWindow: loaded.host });
    loaded.reload();
    await expect(loadPending).rejects.toThrow("reloaded");

    const replaced = hostHarness();
    const replaceAbort = new AbortController();
    const replacePending = requestMiniAppExport({ iframe: replaced.iframe, actionId: "x", mimeType: VALID.mimeType, signal: replaceAbort.signal, hostWindow: replaced.host });
    const request = replaced.sent[0] as { requestId: string };
    Object.defineProperty(replaced.iframe, "contentWindow", { value: {} as Window, writable: true });
    replaced.reply(replaced.source, { type: "nautilo.app.export.prepare.result", requestId: request.requestId, ok: true, result: VALID });
    replaceAbort.abort();
    await expect(replacePending).rejects.toThrow("aborted");
  });
});

describe("mini-app export client", () => {
  test("replies promptly when no handler is registered and ignores non-parent requests", () => {
    const h = clientHarness();
    const request = { type: "nautilo.app.export.prepare", requestId: "r1", actionId: "powerpoint", mimeType: VALID.mimeType };
    h.request(request, {} as Window);
    expect(h.sent).toHaveLength(0);
    h.request(request);
    expect(h.sent).toEqual([{
      type: "nautilo.app.export.prepare.result", requestId: "r1", ok: false,
      error: "The app has no export handler registered.",
    }]);
  });

  test("uses one replaceable handler and unsubscribe cannot remove its successor", async () => {
    const h = clientHarness();
    const first = h.api.exports.onPrepare(async () => ({ ...VALID, warnings: ["old"] }));
    const second = h.api.exports.onPrepare(async ({ actionId, mimeType }) => ({ ...VALID, mimeType, warnings: [actionId] }));
    first();
    h.request({ type: "nautilo.app.export.prepare", requestId: "r2", actionId: "powerpoint", mimeType: VALID.mimeType });
    await new Promise((resolve) => queueMicrotask(resolve));
    await new Promise((resolve) => queueMicrotask(resolve));
    expect(h.sent).toEqual([{
      type: "nautilo.app.export.prepare.result", requestId: "r2", ok: true,
      result: { ...VALID, warnings: ["powerpoint"] },
    }]);
    second();
    h.request({ type: "nautilo.app.export.prepare", requestId: "r3", actionId: "powerpoint", mimeType: VALID.mimeType });
    expect(h.sent.at(-1)).toMatchObject({ requestId: "r3", ok: false });
  });

  test("returns handler errors", async () => {
    const h = clientHarness();
    h.api.exports.onPrepare(() => { throw new Error("cannot serialize"); });
    h.request({ type: "nautilo.app.export.prepare", requestId: "r4", actionId: "powerpoint", mimeType: VALID.mimeType });
    await new Promise((resolve) => queueMicrotask(resolve));
    await new Promise((resolve) => queueMicrotask(resolve));
    expect(h.sent).toEqual([{
      type: "nautilo.app.export.prepare.result", requestId: "r4", ok: false, error: "cannot serialize",
    }]);
  });
});
