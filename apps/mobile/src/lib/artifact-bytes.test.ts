/// <reference types="bun-types" />

import { describe, expect, mock, test } from "bun:test";
import { NautiloApiClient } from "@nautilo/api-client/browser";

let downloadedText = "# Test artifact";
const downloadFileAsync = mock(async (_url: string, destination: FakeFile) => destination);

class FakeDirectory {
  readonly uri: string;

  constructor(base: string, name: string) {
    this.uri = `${base.replace(/\/$/, "")}/${name}`;
  }

  create(): void {}
}

class FakeFile {
  static readonly downloadFileAsync = downloadFileAsync;
  readonly uri: string;
  exists = true;

  constructor(base: string | FakeDirectory, name?: string) {
    const root = typeof base === "string" ? base : base.uri;
    this.uri = name ? `${root.replace(/\/$/, "")}/${name}` : root;
  }

  async text(): Promise<string> {
    return downloadedText;
  }

  delete(): void {
    this.exists = false;
  }
}

mock.module("expo-file-system", () => ({
  Directory: FakeDirectory,
  File: FakeFile,
  Paths: { cache: "file:///cache" },
}));

const ensureValidToken = mock(async () => "token");
mock.module("@/lib/auth", () => ({ ensureValidToken }));

const {
  MAX_IMAGE_BYTES,
  MAX_PDF_BYTES,
  MAX_TEXT_BYTES,
  artifactCacheName,
  capForKind,
  classifyArtifactKind,
  fetchArtifactBytes,
  normalizeDownloadError,
  replaceArtifactBytesMetadata,
  tokenNeedsRefresh,
} = await import("./artifact-bytes");

describe("classifyArtifactKind", () => {
  test("video is a native-player candidate, not a capped text or image preview", () => {
    expect(classifyArtifactKind("clip.MP4", "application/octet-stream")).toBe("video");
    expect(classifyArtifactKind("clip", "Video/QuickTime; codecs=hvc1")).toBe("video");
    expect(capForKind("video")).toBeNull();
  });
  test("markdown by extension or mime", () => {
    expect(classifyArtifactKind("notes/hello.md", "text/markdown")).toBe("markdown");
    expect(classifyArtifactKind("notes/hello.markdown", "application/octet-stream")).toBe("markdown");
    expect(classifyArtifactKind("x", "text/markdown")).toBe("markdown");
  });

  test("image by mime prefix or extension", () => {
    expect(classifyArtifactKind("a/binary.blob", "image/png")).toBe("image");
    expect(classifyArtifactKind("photos/cat.jpeg", "application/octet-stream")).toBe("image");
    expect(classifyArtifactKind("icons/logo.svg", "image/svg+xml")).toBe("image");
  });

  test("pdf by mime or extension", () => {
    expect(classifyArtifactKind("doc.pdf", "application/pdf")).toBe("pdf");
    expect(classifyArtifactKind("doc.pdf", "application/octet-stream")).toBe("pdf");
  });

  test("text by mime prefix or known extension", () => {
    expect(classifyArtifactKind("readme.txt", "text/plain")).toBe("text");
    expect(classifyArtifactKind("src/index.ts", "application/octet-stream")).toBe("text");
    expect(classifyArtifactKind("cfg/config.yaml", "text/yaml")).toBe("text");
  });

  test("Writer and HTML candidates enter the document reader", () => {
    expect(classifyArtifactKind("report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("unsupported");
    expect(classifyArtifactKind("page.html", "text/html")).toBe("writer");
    expect(classifyArtifactKind("page.html", "application/octet-stream")).toBe("writer");
    expect(classifyArtifactKind("page.htm", "application/octet-stream")).toBe("writer");
    expect(classifyArtifactKind("document", "Text/HTML; charset=utf-8")).toBe("writer");
    expect(classifyArtifactKind("archive.zip", "application/zip")).toBe("unsupported");
  });
});

describe("capForKind", () => {
  test("text, markdown, and Writer share the 50 MiB cap; image + pdf share 25 MiB", () => {
    expect(capForKind("text")).toBe(MAX_TEXT_BYTES);
    expect(capForKind("markdown")).toBe(MAX_TEXT_BYTES);
    expect(capForKind("writer")).toBe(MAX_TEXT_BYTES);
    expect(capForKind("image")).toBe(MAX_IMAGE_BYTES);
    expect(capForKind("pdf")).toBe(MAX_PDF_BYTES);
    expect(capForKind("unsupported")).toBeNull();
  });

  test("caps match the Phase 1.4 documented upper bounds", () => {
    expect(MAX_TEXT_BYTES).toBe(50 * 1024 * 1024);
    expect(MAX_IMAGE_BYTES).toBe(25 * 1024 * 1024);
    expect(MAX_PDF_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe("artifactCacheName", () => {
  test("revision-safe: encodes id + revision + extension", () => {
    expect(artifactCacheName("ext-uuid-1", 3, ".png")).toBe("nautilo-artifact-ext-uuid-1-rev3.png");
    expect(artifactCacheName("ext-uuid-1", 4, ".png")).not.toBe(artifactCacheName("ext-uuid-1", 3, ".png"));
  });

  test("sanitizes unsafe id characters", () => {
    expect(artifactCacheName("ext/uuid+odd", 1, ".pdf")).toBe("nautilo-artifact-ext_uuid_odd-rev1.pdf");
  });

  test("omits extension when null", () => {
    expect(artifactCacheName("id", 0, null)).toBe("nautilo-artifact-id-rev0");
  });
});

test("metadata replacement retains text and file payloads for a successful artifact mutation", () => {
  const before = {
    id: "row", artifactId: "stable", revision: 1, path: "old.md", mimeType: "text/markdown", size: 3,
    updatedAt: "then", createdAt: "before", namespaceIds: [], canWrite: true,
  };
  const after = { ...before, path: "new.md", revision: 2 };
  expect(replaceArtifactBytesMetadata({ kind: "text", content: "# bytes", mimeType: before.mimeType, artifact: before }, after)).toEqual({ kind: "text", content: "# bytes", mimeType: before.mimeType, artifact: after });
  expect(replaceArtifactBytesMetadata({ kind: "unsupported", ext: ".docx", artifact: before }, after)).toMatchObject({ artifact: after });
});

describe("normalizeDownloadError", () => {
  test("AbortError (by name) → aborted, no status", () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    expect(normalizeDownloadError(e)).toEqual({ status: null, aborted: true });
  });

  test("Android UnableToDownload: 'HTTP 401' → status 401", () => {
    const e = new Error("Unable to download a file: HTTP 401");
    expect(normalizeDownloadError(e)).toEqual({ status: 401, aborted: false });
  });

  test("iOS UnableToDownload: 'response has status 403' → status 403", () => {
    const e = new Error("Unable to download a file: response has status 403");
    expect(normalizeDownloadError(e)).toEqual({ status: 403, aborted: false });
  });

  test("iOS UnableToDownload: 'server returned HTTP 501' → status 501", () => {
    const e = new Error("Unable to download a file: server returned HTTP 501");
    expect(normalizeDownloadError(e)).toEqual({ status: 501, aborted: false });
  });

  test("Android range/download: 'response has status: 404' → status 404", () => {
    const e = new Error("Unable to download a file: response has status: 404");
    expect(normalizeDownloadError(e)).toEqual({ status: 404, aborted: false });
  });

  test("network/IO error with no HTTP status → status null", () => {
    const e = new Error("Unable to download a file: Failed to move downloaded file: disk full");
    expect(normalizeDownloadError(e)).toEqual({ status: null, aborted: false });
  });

  test("non-Error thrown is stringified", () => {
    expect(normalizeDownloadError("boom HTTP 500")).toEqual({ status: 500, aborted: false });
  });
});

describe("tokenNeedsRefresh (force-refresh seam)", () => {
  const now = 1_000_000;

  test("fresh token within the 60s guard does not need refresh", () => {
    expect(tokenNeedsRefresh(now + 120_000, now, false)).toBe(false);
  });

  test("token past the 60s guard needs refresh", () => {
    expect(tokenNeedsRefresh(now + 30_000, now, false)).toBe(true);
    expect(tokenNeedsRefresh(now, now, false)).toBe(true);
    expect(tokenNeedsRefresh(now - 5_000, now, false)).toBe(true);
  });

  test("forceRefresh bypasses the 60s guard even for a far-future token", () => {
    expect(tokenNeedsRefresh(now + 3_600_000, now, true)).toBe(true);
  });

  test("forceRefresh false defers to the freshness guard", () => {
    expect(tokenNeedsRefresh(now + 120_000, now, false)).toBe(false);
  });
});

describe("fetchArtifactBytes — missing_room seam (no native/secure-storage)", () => {
  // roomId="" returns before any token or native call, so this exercises the
  // C1 fail-closed guard without loading expo-file-system or expo-secure-store.
  test("empty roomId → missing_room without touching the client", async () => {
    const client = new NautiloApiClient("http://127.0.0.1:9");
    const result = await fetchArtifactBytes({
      serverId: "srv_x",
      baseUrl: "http://127.0.0.1:9",
      client,
      artifactId: "int-1",
      roomId: "",
    });
    expect(result).toEqual({ kind: "missing_room" });
  });

  test("Markdown downloads and decodes through the statically bundled filesystem", async () => {
    downloadedText = "# A Brief History of Tea";
    downloadFileAsync.mockClear();
    ensureValidToken.mockClear();
    const artifact = {
      id: "internal-1",
      artifactId: "external-1",
      revision: 4,
      path: "artifacts/history-of-tea.md",
      mimeType: "text/markdown",
      size: 3_296,
      updatedAt: "2026-07-25T00:00:00.000Z",
      createdAt: "2026-07-24T00:00:00.000Z",
      namespaceIds: ["ns-1"],
      canWrite: true,
    };
    const client = {
      setToken: mock(() => {}),
      getWorkspaceArtifact: mock(async () => artifact),
      getWorkspaceArtifactBytesUrl: mock(() => "http://localhost/artifacts/internal-1/bytes"),
    };

    const result = await fetchArtifactBytes({
      serverId: "srv_x",
      baseUrl: "http://127.0.0.1:3001",
      client: client as never,
      artifactId: "internal-1",
      roomId: "room-1",
    });

    expect(result).toEqual({
      kind: "text",
      content: "# A Brief History of Tea",
      mimeType: "text/markdown",
      artifact,
    });
    expect(downloadFileAsync).toHaveBeenCalledTimes(1);
  });
});
