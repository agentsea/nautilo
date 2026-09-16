import { describe, expect, test } from "bun:test";
import { requestMiniAppLifecycle } from "./mini-app-lifecycle";

function harness() {
  const host = new EventTarget() as Window;
  const sent: unknown[] = [];
  const source = { postMessage: (message: unknown) => sent.push(message) } as Window;
  const iframe = { contentWindow: source } as HTMLIFrameElement;
  const reply = (replySource: Window, data: unknown) => {
    const event = new Event("message") as MessageEvent;
    Object.defineProperties(event, {
      source: { value: replySource },
      data: { value: data },
    });
    host.dispatchEvent(event);
  };
  return { host, source, iframe, sent, reply };
}

describe("mini-app lifecycle request", () => {
  test("accepts an explicit absence of a locally admitted draft", async () => {
    const h = harness();
    const pending = requestMiniAppLifecycle({ iframe: h.iframe, reason: "close", hostWindow: h.host });
    const request = h.sent[0] as { requestId: string };
    h.reply(h.source, {
      type: "nautilo.app.lifecycle.prepare-close.result",
      requestId: request.requestId,
      ok: true,
      result: { noLocalChanges: true, documentSaved: false, recoveryPersisted: false, recoverableDraftExact: false },
    });
    expect(await pending).toEqual({
      status: "ready",
      result: { noLocalChanges: true, documentSaved: false, recoveryPersisted: false, recoverableDraftExact: false },
    });
  });

  test("accepts only concrete saved or exact-recovery readiness", async () => {
    const h = harness();
    const pending = requestMiniAppLifecycle({
      iframe: h.iframe,
      reason: "replace",
      hostWindow: h.host,
    });
    const request = h.sent[0] as { requestId: string };
    h.reply(h.source, {
      type: "nautilo.app.lifecycle.prepare-close.result",
      requestId: request.requestId,
      ok: true,
      result: { documentSaved: false, recoveryPersisted: true, recoverableDraftExact: true },
    });
    expect(await pending).toEqual({
      status: "ready",
      result: { documentSaved: false, recoveryPersisted: true, recoverableDraftExact: true },
    });
  });

  test("rejects a generic or partial recovery result", async () => {
    const h = harness();
    const pending = requestMiniAppLifecycle({ iframe: h.iframe, reason: "close", hostWindow: h.host });
    const request = h.sent[0] as { requestId: string };
    h.reply(h.source, {
      type: "nautilo.app.lifecycle.prepare-close.result",
      requestId: request.requestId,
      ok: true,
      result: {
        documentSaved: false,
        recoveryPersisted: true,
        recoverableDraftExact: false,
        errorMessage: "Serialization is incomplete.",
      },
    });
    expect(await pending).toEqual({ status: "blocked", message: "Serialization is incomplete." });
  });

  test("rejects malformed no-local-changes facts", async () => {
    const h = harness();
    const pending = requestMiniAppLifecycle({ iframe: h.iframe, reason: "close", hostWindow: h.host });
    const request = h.sent[0] as { requestId: string };
    h.reply(h.source, {
      type: "nautilo.app.lifecycle.prepare-close.result",
      requestId: request.requestId,
      ok: true,
      result: { noLocalChanges: "true", documentSaved: false, recoveryPersisted: false, recoverableDraftExact: false },
    });
    expect(await pending).toEqual({ status: "blocked", message: "The app returned an invalid close result." });
  });

  test("ignores wrong-source, wrong-request, and replaced-frame callbacks", async () => {
    const h = harness();
    const abort = new AbortController();
    const pending = requestMiniAppLifecycle({
      iframe: h.iframe,
      reason: "navigate",
      signal: abort.signal,
      hostWindow: h.host,
    });
    const request = h.sent[0] as { requestId: string };
    const ready = {
      type: "nautilo.app.lifecycle.prepare-close.result",
      requestId: request.requestId,
      ok: true,
      result: { documentSaved: true, recoveryPersisted: false, recoverableDraftExact: false },
    };
    h.reply({} as Window, ready);
    h.reply(h.source, { ...ready, requestId: "stale" });
    h.iframe.contentWindow = {} as Window;
    h.reply(h.source, ready);
    abort.abort();
    expect(await pending).toEqual({ status: "cancelled" });
  });
});
