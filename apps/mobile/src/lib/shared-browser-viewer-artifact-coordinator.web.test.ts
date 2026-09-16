import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ApiError, type ArtifactDto } from "@nautilo/api-client/browser";
import type { BrowserArtifactArrayBufferOptions } from "./shared-browser-viewer-byte-source-contract";

const ensureValidToken = mock(
  async (_serverId: string, _baseUrl: string, _options?: { forceRefresh?: boolean }): Promise<string | null> => "token",
);
const emitAuthDead = mock(() => {});
mock.module("@/lib/auth", () => ({ ensureValidToken }));
mock.module("@/lib/auth-events", () => ({ emitAuthDead }));

const { acquireBrowserArtifact } = await import("./shared-browser-viewer-artifact-coordinator.web");
const { acquireBrowserArtifact: acquireNativeBrowserArtifact } = await import("./shared-browser-viewer-artifact-coordinator");

const artifact: ArtifactDto = {
  id: "artifact-internal",
  artifactId: "artifact-stable",
  path: "report.pdf",
  mimeType: "application/pdf",
  size: 4,
  revision: 7,
  updatedAt: "2026-08-11T00:00:00.000Z",
  createdAt: "2026-08-10T00:00:00.000Z",
  namespaceIds: ["namespace-1"],
  canWrite: false,
};

function input(overrides: { maxBytes?: number; signal?: AbortSignal } = {}) {
  const client = {
    setToken: mock((_token: string) => {}),
    getWorkspaceArtifact: mock(async (_artifactId: string, _options?: { roomId?: string }): Promise<ArtifactDto | null> => artifact),
    getWorkspaceArtifactBytesArrayBuffer: mock(async (
      _artifactId: string,
      _options: BrowserArtifactArrayBufferOptions,
    ): Promise<ArrayBuffer> => new Uint8Array([1, 2, 3, 4]).buffer),
  };
  return {
    serverId: "server-1",
    baseUrl: "https://nautilo.example.test",
    artifactId: artifact.id,
    maxBytes: 8,
    signal: new AbortController().signal,
    client,
    ...overrides,
  };
}

beforeEach(() => {
  ensureValidToken.mockReset();
  ensureValidToken.mockImplementation(async () => "token");
  emitAuthDead.mockClear();
});

describe("Mobile Web browser artifact coordinator", () => {
  test("retries metadata once with a forced shared-token refresh on 401", async () => {
    ensureValidToken.mockImplementation(async (_serverId, _baseUrl, options) => options?.forceRefresh ? "fresh" : "current");
    const value = input();
    value.client.getWorkspaceArtifact.mockImplementationOnce(async () => { throw new ApiError(401, "expired"); });
    value.client.getWorkspaceArtifact.mockImplementationOnce(async () => artifact);

    expect(await acquireBrowserArtifact(value)).toMatchObject({ kind: "ready", artifact });
    expect(ensureValidToken.mock.calls.map((call) => call[2])).toEqual([
      { forceRefresh: false }, { forceRefresh: true }, { forceRefresh: false },
    ]);
    expect(value.client.setToken).toHaveBeenNthCalledWith(1, "current");
    expect(value.client.setToken).toHaveBeenNthCalledWith(2, "fresh");
    expect(emitAuthDead).not.toHaveBeenCalled();
  });

  test("retries bytes once with a forced shared-token refresh on 401", async () => {
    ensureValidToken.mockImplementation(async (_serverId, _baseUrl, options) => options?.forceRefresh ? "fresh" : "current");
    const value = input();
    value.client.getWorkspaceArtifactBytesArrayBuffer.mockImplementationOnce(async () => { throw new ApiError(401, "expired"); });
    value.client.getWorkspaceArtifactBytesArrayBuffer.mockImplementationOnce(async () => new ArrayBuffer(4));

    expect(await acquireBrowserArtifact(value)).toMatchObject({ kind: "ready", artifact });
    expect(ensureValidToken.mock.calls.map((call) => call[2])).toEqual([
      { forceRefresh: false }, { forceRefresh: false }, { forceRefresh: true },
    ]);
    expect(emitAuthDead).not.toHaveBeenCalled();
  });

  test("emits auth-dead exactly once after a terminal 401 or missing forced token", async () => {
    const second401 = input();
    second401.client.getWorkspaceArtifact.mockImplementation(async () => { throw new ApiError(401, "expired"); });
    expect(await acquireBrowserArtifact(second401)).toEqual({ kind: "auth_dead" });
    expect(emitAuthDead).toHaveBeenCalledTimes(1);

    emitAuthDead.mockClear();
    ensureValidToken.mockImplementation(async (_serverId, _baseUrl, options) => options?.forceRefresh ? null : "current");
    const missingForced = input();
    missingForced.client.getWorkspaceArtifact.mockImplementationOnce(async () => { throw new ApiError(401, "expired"); });
    expect(await acquireBrowserArtifact(missingForced)).toEqual({ kind: "auth_dead" });
    expect(emitAuthDead).toHaveBeenCalledTimes(1);
  });

  test("cancellation wins before and during either phase without auth death", async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const before = input({ signal: preAborted.signal });
    expect(await acquireBrowserArtifact(before)).toEqual({ kind: "cancelled" });
    expect(before.client.getWorkspaceArtifact).not.toHaveBeenCalled();

    const duringMetadata = input();
    duringMetadata.client.getWorkspaceArtifact.mockImplementation(async () => {
      throw new DOMException("cancelled", "AbortError");
    });
    expect(await acquireBrowserArtifact(duringMetadata)).toEqual({ kind: "cancelled" });

    const during = input();
    during.client.getWorkspaceArtifactBytesArrayBuffer.mockImplementation(async () => {
      throw new DOMException("cancelled", "AbortError");
    });
    expect(await acquireBrowserArtifact(during)).toEqual({ kind: "cancelled" });
    expect(emitAuthDead).not.toHaveBeenCalled();
  });

  test("uses canonical metadata to reject the caller cap before acquiring bytes", async () => {
    const value = input({ maxBytes: 3 });
    expect(await acquireBrowserArtifact(value)).toMatchObject({
      kind: "too_large", artifact, declaredBytes: 4, maxBytes: 3,
    });
    expect(value.client.getWorkspaceArtifactBytesArrayBuffer).not.toHaveBeenCalled();
  });

  test("maps non-auth and integrity failures without exposing raw errors", async () => {
    for (const [status, expected] of [
      [403, { kind: "forbidden" }],
      [404, { kind: "not_found" }],
      [501, { kind: "not_implemented" }],
    ] as const) {
      const mapped = input();
      mapped.client.getWorkspaceArtifact.mockImplementation(async () => { throw new ApiError(status, "private message"); });
      expect(await acquireBrowserArtifact(mapped)).toEqual(expected);
    }

    const mismatch = input();
    mismatch.client.getWorkspaceArtifactBytesArrayBuffer.mockImplementation(async () => new ArrayBuffer(3));
    expect(await acquireBrowserArtifact(mismatch)).toEqual({ kind: "unavailable", reason: "integrity" });

    const unavailable = input();
    unavailable.client.getWorkspaceArtifact.mockImplementation(async () => { throw new Error("sensitive upstream detail"); });
    expect(await acquireBrowserArtifact(unavailable)).toEqual({ kind: "unavailable", reason: "metadata" });
  });

  test("keeps the native facade unavailable without touching the client", async () => {
    const value = input();
    expect(await acquireNativeBrowserArtifact(value)).toEqual({ kind: "unavailable", reason: "platform" });
    expect(value.client.getWorkspaceArtifact).not.toHaveBeenCalled();
    expect(value.client.getWorkspaceArtifactBytesArrayBuffer).not.toHaveBeenCalled();
  });
});
