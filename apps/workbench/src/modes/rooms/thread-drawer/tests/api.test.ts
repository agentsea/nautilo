import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const getToken = mock(() => "thread-token");
mock.module("../../../../lib/api", () => ({ apiClient: { getToken } }));

const { createSubthread, findExistingSubthread } = await import("../api");

const originalFetch = globalThis.fetch;
const fetchMock = mock<typeof fetch>();

describe("thread drawer subthread API bridge", () => {
  beforeEach(() => {
    getToken.mockClear();
    fetchMock.mockReset();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("finds an existing anchor with the authenticated list request", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      subthreads: [{ id: "child-2", anchorMessageId: 2 }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(findExistingSubthread("parent/a", 2)).resolves.toBe("child-2");
    expect(fetchMock).toHaveBeenCalledWith("/api/rooms/parent%2Fa/subthreads", expect.objectContaining({
      headers: expect.any(Headers),
    }));
    const init = fetchMock.mock.calls[0]![1]!;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer thread-token");
    expect(new Headers(init.headers).get("Accept")).toBe("application/json");
  });

  test("creates idempotently through the authenticated canonical endpoint", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ subthreadRoomId: "child-2" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));

    await expect(createSubthread("parent/a", 2)).resolves.toEqual({ subthreadRoomId: "child-2" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/rooms/parent%2Fa/messages/2/subthreads");
    expect(init).toEqual(expect.objectContaining({ method: "POST", body: "{}" }));
    expect(new Headers(init!.headers).get("Authorization")).toBe("Bearer thread-token");
  });

  test("does not reinterpret a failed existing-thread lookup as absence", async () => {
    fetchMock.mockResolvedValue(new Response("unavailable", { status: 503 }));

    await expect(findExistingSubthread("parent", 2)).rejects.toThrow("503");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("does not turn an authenticated create failure into an ambiguous miss", async () => {
    fetchMock.mockResolvedValue(new Response("forbidden", { status: 403 }));
    await expect(createSubthread("parent", 2)).rejects.toThrow("403");
  });
});
