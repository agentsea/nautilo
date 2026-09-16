import { afterEach, describe, expect, mock, test } from "bun:test";
import { createAdmissionFetch } from "./admission-fetch";
import {
  getCryptoAdmissionSnapshot,
  requestCryptoAdmissionRefresh,
  resetCryptoAdmissionAccess,
  setCryptoAdmissionAccessState,
} from "./crypto-admission-access";

const policy = { mode: "shadow_encryption", shadowBehavior: "strict" } as const;
const open = (identity = "server:alice:device") => setCryptoAdmissionAccessState({
  identity, status: "open", policy,
});
afterEach(resetCryptoAdmissionAccess);

describe("Workbench admission transport", () => {
  test("blocks writes immediately and never sends them after recovery", async () => {
    open();
    requestCryptoAdmissionRefresh("transport_disconnected");
    const network = mock(async () => new Response("ok"));
    const fetcher = createAdmissionFetch(network);
    await expect(fetcher("/api/rooms/r/messages", { method: "POST", body: "draft" }))
      .rejects.toMatchObject({ code: "crypto_admission_paused" });
    open();
    await Promise.resolve();
    expect(network).not.toHaveBeenCalled();
  });

  test("a paused read retains its pending result instead of manufacturing an empty page", async () => {
    open();
    requestCryptoAdmissionRefresh("transport_disconnected");
    const network = mock(async () => new Response("current history"));
    const fetcher = createAdmissionFetch(network);
    const pending = fetcher("/api/rooms/r/messages");
    await Promise.resolve();
    expect(network).not.toHaveBeenCalled();
    open();
    expect(await (await pending).text()).toBe("current history");
    expect(network).toHaveBeenCalledTimes(1);
  });

  test("reselects an in-flight read after admission changes without releasing its old body", async () => {
    open();
    let finish!: (response: Response) => void;
    const network = mock(() => Promise.resolve(new Response("new body")));
    network.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = createAdmissionFetch(network)("/api/rooms/r/messages");
    await Promise.resolve();
    requestCryptoAdmissionRefresh("encryption_policy_changed");
    finish(new Response("stale body"));
    await Promise.resolve();
    open();
    expect(await (await pending).text()).toBe("new body");
    expect(network).toHaveBeenCalledTimes(2);
  });

  test("does not release an in-flight read or replay a write into another identity", async () => {
    open();
    let finish!: (response: Response) => void;
    const network = mock(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const pending = createAdmissionFetch(network)("/api/rooms/r/messages");
    await Promise.resolve();
    open("server:bob:device");
    finish(new Response("alice body"));
    await expect(pending).rejects.toThrow("Workspace access changed");
    expect(network).toHaveBeenCalledTimes(1);
  });

  test("a write committed during interruption is not automatically replayed", async () => {
    open();
    let finish!: (response: Response) => void;
    const network = mock(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const pending = createAdmissionFetch(network)("/api/rooms/r/messages", { method: "POST" });
    requestCryptoAdmissionRefresh("device_admission_expired");
    finish(new Response("committed"));
    await expect(pending).rejects.toThrow("Workspace access changed");
    open();
    expect(network).toHaveBeenCalledTimes(1);
  });

  test("only the exact recovery inventory bypasses a paused gate", async () => {
    open();
    requestCryptoAdmissionRefresh("transport_disconnected");
    const network = mock(async () => new Response("control"));
    const fetcher = createAdmissionFetch(network);
    await fetcher("/api/encryption-transition/policy");
    await fetcher("/api/crypto-device-admission/challenge", { method: "POST" });
    await fetcher("/api/admin/encryption-transition", { method: "POST" });
    await expect(fetcher("/api/admin/users", { method: "POST" })).rejects.toThrow();
    await expect(fetcher("/api/protected/devices/initial-bootstrap/begin/extra", { method: "POST" })).rejects.toThrow();
    expect(network).toHaveBeenCalledTimes(3);
  });

  test("retains server denial responses for canonical typed admission handling", async () => {
    open();
    const fetcher = createAdmissionFetch(async () => new Response(
      JSON.stringify({ code: "device_removed_or_stale" }), { status: 428 },
    ));
    const response = await fetcher("/api/rooms/r/messages");
    expect(response.status).toBe(428);
    expect((await response.json()).code).toBe("device_removed_or_stale");
    expect(getCryptoAdmissionSnapshot().status).toBe("blocked");
  });

  test("a stale server denial cannot revoke another signed-in installation", async () => {
    open();
    let finish!: (response: Response) => void;
    const pending = createAdmissionFetch(() => new Promise<Response>((resolve) => {
      finish = resolve;
    }))("/api/rooms/r/messages");
    await Promise.resolve();
    open("server:bob:device");
    finish(Response.json({ code: "device_removed_or_stale" }, { status: 428 }));
    await expect(pending).rejects.toThrow("Workspace access changed");
    expect(getCryptoAdmissionSnapshot().status).toBe("open");
    expect(getCryptoAdmissionSnapshot().identity).toBe("server:bob:device");
  });

  test("ordinary server errors do not impersonate an explicit admission denial", async () => {
    open();
    const response = await createAdmissionFetch(async () => Response.json(
      { error: "Temporary failure" }, { status: 503 },
    ))("/api/rooms/r/messages");
    expect(response.status).toBe(503);
    expect(getCryptoAdmissionSnapshot().status).toBe("open");
  });

  test("aborted reads stop waiting and revoked access cannot resume them", async () => {
    open();
    requestCryptoAdmissionRefresh("transport_disconnected");
    const network = mock(async () => new Response("unexpected"));
    const controller = new AbortController();
    const pending = createAdmissionFetch(network)("/api/rooms/r/messages", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
    const revoked = createAdmissionFetch(network)("/api/rooms/r/messages");
    requestCryptoAdmissionRefresh("device_removed_or_stale");
    await expect(revoked).rejects.toThrow("no longer available");
    expect(getCryptoAdmissionSnapshot().status).toBe("blocked");
    expect(network).not.toHaveBeenCalled();
  });

  test("does not release body bytes delivered after headers but after a pause", async () => {
    open();
    const cancelled = mock(() => undefined);
    const response = await createAdmissionFetch(async () => new Response(
      new ReadableStream({ cancel: cancelled }),
    ))("/api/rooms/r/messages");
    const reading = response.text();
    requestCryptoAdmissionRefresh("encryption_policy_changed");
    await expect(reading).rejects.toMatchObject({ code: "crypto_admission_paused" });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  test("even an already buffered body cannot be consumed after invalidation or reopen", async () => {
    open();
    const response = await createAdmissionFetch(async () => Response.json({ secret: "old" }))(
      "/api/memories",
    );
    const copy = response.clone();
    requestCryptoAdmissionRefresh("transport_disconnected");
    open();
    await expect(response.json()).rejects.toMatchObject({ code: "crypto_admission_paused" });
    await expect(copy.text()).rejects.toMatchObject({ code: "crypto_admission_paused" });
  });

  test("stream readers stop receiving chunks on account change", async () => {
    open();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = await createAdmissionFetch(async () => new Response(
      new ReadableStream<Uint8Array>({ start(value) { controller = value; } }),
    ))("/api/files/download");
    const reader = response.body!.getReader();
    controller.enqueue(new TextEncoder().encode("admitted"));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("admitted");
    const next = reader.read();
    open("server:bob:device");
    await expect(next).rejects.toMatchObject({ code: "crypto_admission_paused" });
  });

  test("an unconsumed response does not lock its upstream body and cancellation stays lazy", async () => {
    open();
    const cancelled = mock(() => undefined);
    const upstream = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const response = await createAdmissionFetch(async () => new Response(upstream))(
      "/api/rooms/r/messages",
    );

    expect(upstream.locked).toBe(false);
    await response.body!.cancel("status-only caller");
    expect(upstream.locked).toBe(false);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  test("a guarded clone preserves the source response metadata", async () => {
    open();
    const source = Response.json({ ok: true });
    Object.defineProperties(source, {
      url: { value: "https://nautilo.test/api/rooms/r/messages" },
      redirected: { value: true },
      type: { value: "cors" },
    });
    const response = await createAdmissionFetch(async () => source)(
      "/api/rooms/r/messages",
    );

    const clone = response.clone();
    expect(clone.url).toBe(source.url);
    expect(clone.redirected).toBe(true);
    expect(clone.type).toBe("cors");
  });

  test("preserves bodyless conditional and mutation responses", async () => {
    open();
    for (const status of [204, 205, 304]) {
      const source = new Response(null, { status });
      // Reproduce the empty-body stream exposed by a browser fetch adapter.
      Object.defineProperty(source, "body", { value: new ReadableStream({ start(c) { c.close(); } }) });
      const response = await createAdmissionFetch(async () => source)("/api/workspace/artifacts");
      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
      expect(await response.text()).toBe("");
    }
  });
});
