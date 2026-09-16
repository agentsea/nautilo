import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ArtifactDto } from "@nautilo/api-client/browser";

let downloaded = 0;
let fileText = "# x";
let downloadError: Error | undefined;
let downloadFailuresBeforeSuccess = 0;
let token: string | null = "token";
const forceRefreshes: boolean[] = [];
const authDead: string[] = [];
const authDeadListeners = new Set<(serverId: string) => void>();

mock.module("expo-file-system", () => ({
  Directory: class {},
  File: class {},
  Paths: { cache: "file:///cache" },
}));
mock.module("@/lib/artifact-byte-download", () => ({
  downloadArtifactBytes: async () => {
    downloaded += 1;
    if (downloadFailuresBeforeSuccess > 0) {
      downloadFailuresBeforeSuccess -= 1;
      throw downloadError ?? new Error("download failed");
    }
    return { kind: "text", content: fileText };
  },
}));
mock.module("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  CryptoEncoding: { HEX: "hex" },
  digestStringAsync: async (_algorithm: string, value: string) => `sha256:${value}`,
}));
mock.module("@/lib/auth", () => ({
  ensureValidToken: async (_serverId: string, _baseUrl: string, options?: { forceRefresh?: boolean }) => {
    forceRefreshes.push(options?.forceRefresh === true);
    return token;
  },
}));
mock.module("@/lib/auth-events", () => ({
  emitAuthDead: (serverId: string) => {
    authDead.push(serverId);
    for (const listener of authDeadListeners) listener(serverId);
  },
  onAuthDead: (listener: (serverId: string) => void) => {
    authDeadListeners.add(listener);
    return () => authDeadListeners.delete(listener);
  },
}));

const { loadArtifactForEdit } = await import("./artifact-edit-loader");
const { MAX_NATIVE_SOURCE_EDIT_BYTES } = await import("./artifact-edit-limits");

const artifact = (overrides: Partial<ArtifactDto> = {}): ArtifactDto => ({
  id: "a",
  artifactId: "a",
  path: "README.md",
  mimeType: "text/markdown",
  size: 3,
  revision: 1,
  updatedAt: "",
  createdAt: "",
  namespaceIds: ["n"],
  canWrite: true,
  ...overrides,
});

function client(value: ArtifactDto | null = artifact()) {
  return {
    getWorkspaceArtifact: async () => value,
    getWorkspaceArtifactBytesUrl: () => "https://server.test/bytes",
    setToken: () => undefined,
  };
}

const baseInput = () => ({
  client: client(),
  artifactId: "a",
  serverId: "server",
  baseUrl: "https://server.test",
});

beforeEach(() => {
  downloaded = 0;
  fileText = "# x";
  downloadError = undefined;
  downloadFailuresBeforeSuccess = 0;
  token = "token";
  forceRefreshes.length = 0;
  authDead.length = 0;
});

describe("loadArtifactForEdit", () => {
  test("refuses metadata failures and Writer editing on both platforms before downloading", async () => {
    const unwritable = await loadArtifactForEdit({
      ...baseInput(), client: client(artifact({ canWrite: false })),
    });
    expect(unwritable).toMatchObject({ kind: "view-only", admission: { reason: "not_writable" } });

    const writer = await loadArtifactForEdit({
      ...baseInput(), client: client(artifact({ path: "doc.html", mimeType: "text/html" })),
    });
    expect(writer).toMatchObject({ kind: "view-only", admission: { reason: "unsupported_kind" } });
    const iosWriter = await loadArtifactForEdit({
      ...baseInput(),
      client: client(artifact({ path: "doc.html", mimeType: "text/html" })),
    });
    expect(iosWriter).toMatchObject({
      kind: "view-only",
      admission: { reason: "unsupported_kind" },
    });
    expect(downloaded).toBe(0);
  });

  test("uses already loaded source without redownloading", async () => {
    const result = await loadArtifactForEdit({ ...baseInput(), sourceContent: "# x" });
    expect(result).toMatchObject({
      kind: "ready",
      baseSha256: "sha256:# x",
      admission: { kind: "source", content: "# x" },
    });
    expect(downloaded).toBe(0);
  });

  test("rejects actual decoded content size even when metadata was smaller", async () => {
    fileText = "x".repeat(MAX_NATIVE_SOURCE_EDIT_BYTES + 1);
    const result = await loadArtifactForEdit({
      ...baseInput(),
    });
    expect(result).toMatchObject({ kind: "view-only", admission: { reason: "content_too_large" } });
  });

  test("retries only a byte-transport 401 with forced refresh", async () => {
    downloadError = new Error("HTTP 401");
    downloadFailuresBeforeSuccess = 1;
    const result = await loadArtifactForEdit({ ...baseInput() });
    expect(result).toMatchObject({ kind: "ready", admission: { kind: "source" } });
    expect(downloaded).toBe(2);
    expect(forceRefreshes).toEqual([false, false, true]);
  });

  test("maps missing token and abort without exposing an editor", async () => {
    token = null;
    expect(await loadArtifactForEdit(baseInput())).toEqual({ kind: "auth-dead" });
    expect(authDead).toEqual(["server"]);

    token = "token";
    const controller = new AbortController();
    controller.abort();
    expect(await loadArtifactForEdit({ ...baseInput(), signal: controller.signal })).toEqual({ kind: "cancelled" });
    expect(downloaded).toBe(0);
  });
});
