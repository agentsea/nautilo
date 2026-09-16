/// <reference types="bun-types" />

// `artifact-discussion.ts` statically imports `@/lib/auth`, which transitively
// pulls `expo-auth-session` / `expo-web-browser` at module load. Those native
// modules cannot be parsed by bun's test runtime (`__DEV__ is not defined` /
// `Unexpected typeof`), and `@react-native-async-storage/async-storage` reaches
// for `window.localStorage` on every call. So before importing the module under
// test we register two stub modules:
//   - `@/lib/auth`            → a controllable `ensureValidToken` seam.
//   - `@react-native-async-storage/async-storage` → an in-memory store whose
//     getItem/setItem can also be made to throw, to exercise the hint helpers'
//     "storage failure must not block discussion" safe-handling branch.
// The platform byte adapter is mocked at its public seam. Native filesystem and
// Web fetch/object-URL behavior have their own projection tests; this suite
// owns aggregate metadata/admission/result mapping only.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ArtifactByteDownloadInput } from "@/lib/artifact-byte-download";

const ensureValidToken = mock(
  async (_serverId: string, _baseUrl: string, _opts?: { forceRefresh?: boolean }): Promise<string | null> => null,
);
mock.module("@/lib/auth", () => ({ ensureValidToken }));

const storage = new Map<string, string>();
let getItemImpl: (key: string) => Promise<string | null> = async (key) => storage.get(key) ?? null;
let setItemImpl: (key: string, value: string) => Promise<void> = async (key, value) => {
  storage.set(key, value);
};
const getItem = mock((key: string) => getItemImpl(key));
const setItem = mock((key: string, value: string) => setItemImpl(key, value));
mock.module("@react-native-async-storage/async-storage", () => ({
  default: { getItem, setItem },
  useAsyncStorage: () => ({ getItem, setItem }),
}));

// Bun resolves the platform adapter graph far enough to parse this native
// module before replacing the public seam below. Keep this parse-only stub;
// behavior is not exercised through it.
mock.module("expo-file-system", () => ({
  Directory: class {},
  File: class {},
  Paths: { cache: "file:///cache" },
}));

let downloadedText = "# Test artifact";
const downloadArtifactBytes = mock(async (_input: ArtifactByteDownloadInput) => ({
  kind: "text" as const,
  content: downloadedText,
}));
const releaseArtifactFileUri = mock((_fileUri: string) => {});
mock.module("@/lib/artifact-byte-download", () => ({
  downloadArtifactBytes,
  releaseArtifactFileUri,
}));

// Dynamic import so the mocks above are registered before the module loads.
async function load() {
  return await import("./artifact-discussion");
}

beforeEach(() => {
  storage.clear();
  ensureValidToken.mockImplementation(async () => null);
  getItemImpl = async (key) => storage.get(key) ?? null;
  setItemImpl = async (key, value) => {
    storage.set(key, value);
  };
  getItem.mockClear();
  setItem.mockClear();
  downloadedText = "# Test artifact";
  downloadArtifactBytes.mockClear();
  releaseArtifactFileUri.mockClear();
});

describe("isDiscussionCandidate", () => {
  test("true when roomId matches a candidate id", async () => {
    const { isDiscussionCandidate } = await load();
    const candidates = [
      { id: "room-1", label: "General", kind: "room" },
      { id: "room-2", label: "Project", kind: "room" },
    ];
    expect(isDiscussionCandidate("room-1", candidates)).toBe(true);
    expect(isDiscussionCandidate("room-2", candidates)).toBe(true);
  });

  test("false (and narrows roomId away) for undefined roomId", async () => {
    const { isDiscussionCandidate } = await load();
    const candidates = [{ id: "room-1", label: "General", kind: "room" }];
    expect(isDiscussionCandidate(undefined, candidates)).toBe(false);
    // Type-level: the predicate is `roomId is string`, so an undefined input
    // must never be treated as a candidate.
    const roomId: string | undefined = undefined;
    if (isDiscussionCandidate(roomId, candidates)) {
      // Unreachable but proves the narrowing is sound.
      expect<string>(roomId).toBeDefined();
    }
  });

  test("false for a stale hint whose room no longer exists in the candidate list", async () => {
    const { isDiscussionCandidate } = await load();
    const candidates = [{ id: "room-1", label: "General", kind: "room" }];
    // A hint persisted from a prior session that has since been deleted.
    expect(isDiscussionCandidate("room-gone", candidates)).toBe(false);
  });

  test("false for an empty candidate list regardless of roomId", async () => {
    const { isDiscussionCandidate } = await load();
    expect(isDiscussionCandidate("room-1", [])).toBe(false);
    expect(isDiscussionCandidate(undefined, [])).toBe(false);
  });
});

describe("artifactDiscussionRef", () => {
  test("builds the existing workspace-artifact focus pointer from viewer metadata", async () => {
    const { artifactDiscussionRef } = await load();
    expect(
      artifactDiscussionRef({
        id: "internal-row-id",
        artifactId: "workspace/history-of-tea.md",
        path: "history-of-tea.md",
        mimeType: "text/markdown",
        size: 4096,
        revision: 3,
        updatedAt: "2026-07-26T10:00:00.000Z",
        createdAt: "2026-07-25T10:00:00.000Z",
        namespaceIds: ["namespace-1"],
        canWrite: true,
      }),
    ).toEqual({
      artifactId: "workspace/history-of-tea.md",
      path: "history-of-tea.md",
      mimeType: "text/markdown",
      size: 4096,
    });
  });
});

describe("readDiscussionRoomHint / writeDiscussionRoomHint", () => {
  test("round-trips a persisted roomId and returns undefined for a missing key", async () => {
    const { readDiscussionRoomHint, writeDiscussionRoomHint } = await load();
    expect(await readDiscussionRoomHint("srv-1", "art-1")).toBeUndefined();

    await writeDiscussionRoomHint("srv-1", "art-1", "room-9");
    expect(await readDiscussionRoomHint("srv-1", "art-1")).toBe("room-9");
    // Keys are isolated by server + artifact.
    expect(await readDiscussionRoomHint("srv-1", "art-2")).toBeUndefined();
    expect(await readDiscussionRoomHint("srv-2", "art-1")).toBeUndefined();
  });

  test("read treats an empty-string stored value as no hint", async () => {
    const { readDiscussionRoomHint } = await load();
    storage.set("nautilo.artifact-discussion-room.v1.srv-1.art-1", "");
    expect(await readDiscussionRoomHint("srv-1", "art-1")).toBeUndefined();
  });

  test("read swallows a storage failure and returns undefined (safe handling)", async () => {
    const { readDiscussionRoomHint } = await load();
    getItemImpl = async () => {
      throw new Error("storage corrupted");
    };
    const result = await readDiscussionRoomHint("srv-1", "art-1");
    expect(result).toBeUndefined();
  });

  test("write swallows a storage failure and does not throw (advisory hint)", async () => {
    const { writeDiscussionRoomHint } = await load();
    setItemImpl = async () => {
      throw new Error("disk full");
    };
    const result = await writeDiscussionRoomHint("srv-1", "art-1", "room-9");
    expect(result).toBeUndefined();
  });
});

describe("fetchAggregateArtifactBytes", () => {
  test("video metadata delegates to its owned native-file player without the legacy preview download or cap", async () => {
    const { fetchAggregateArtifactBytes } = await load();
    ensureValidToken.mockImplementation(async () => "tok");
    const artifact = { id: "movie", artifactId: "movie-stable", path: "clip.mp4", mimeType: "video/mp4", revision: 2, size: 80 * 1024 * 1024, updatedAt: "2026-09-08T00:00:00Z", createdAt: "2026-09-08T00:00:00Z", namespaceIds: ["private-a"], canWrite: false };
    const client = { setToken: mock(() => {}), getWorkspaceArtifact: mock(async () => artifact) };
    expect(await fetchAggregateArtifactBytes({ serverId: "srv-1", baseUrl: "http://127.0.0.1:9", client: client as never, artifactId: "movie" })).toEqual({ kind: "video", artifact });
    expect(downloadArtifactBytes).not.toHaveBeenCalled();
  });
  test("auth_dead when ensureValidToken returns null, before any client call", async () => {
    const { fetchAggregateArtifactBytes } = await load();
    ensureValidToken.mockImplementation(async () => null);
    const client = {
      setToken: mock(() => {}),
      getWorkspaceArtifact: mock(async () => null),
    };
    const result = await fetchAggregateArtifactBytes({
      serverId: "srv-1",
      baseUrl: "http://127.0.0.1:9",
      client: client as never,
      artifactId: "art-1",
    });
    expect(result).toEqual({ kind: "auth_dead" });
    // The aggregate read must not even touch the client when the token is dead.
    expect(client.setToken).not.toHaveBeenCalled();
    expect(client.getWorkspaceArtifact).not.toHaveBeenCalled();
  });

  test("not_found when the metadata fetch returns null", async () => {
    const { fetchAggregateArtifactBytes } = await load();
    ensureValidToken.mockImplementation(async () => "tok");
    const client = {
      setToken: mock(() => {}),
      getWorkspaceArtifact: mock(async () => null),
    };
    const result = await fetchAggregateArtifactBytes({
      serverId: "srv-1",
      baseUrl: "http://127.0.0.1:9",
      client: client as never,
      artifactId: "art-1",
    });
    expect(result).toEqual({ kind: "not_found" });
    expect(client.setToken).toHaveBeenCalledWith("tok");
  });

  test("unsupported for an office artifact, before any native download", async () => {
    const { fetchAggregateArtifactBytes } = await load();
    ensureValidToken.mockImplementation(async () => "tok");
    const client = {
      setToken: mock(() => {}),
      getWorkspaceArtifact: mock(async () => ({
        artifactId: "art-1",
        revision: 1,
        path: "report.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 1024,
      })),
    };
    const result = await fetchAggregateArtifactBytes({
      serverId: "srv-1",
      baseUrl: "http://127.0.0.1:9",
      client: client as never,
      artifactId: "art-1",
    });
    expect(result).toMatchObject({ kind: "unsupported", ext: ".docx", artifact: { artifactId: "art-1", path: "report.docx" } });
  });

  test("too_large when a text artifact exceeds the text cap, before any native download", async () => {
    const { fetchAggregateArtifactBytes } = await load();
    ensureValidToken.mockImplementation(async () => "tok");
    const client = {
      setToken: mock(() => {}),
      getWorkspaceArtifact: mock(async () => ({
        artifactId: "art-1",
        revision: 1,
        path: "big.txt",
        mimeType: "text/plain",
        size: 100 * 1024 * 1024,
      })),
    };
    const result = await fetchAggregateArtifactBytes({
      serverId: "srv-1",
      baseUrl: "http://127.0.0.1:9",
      client: client as never,
      artifactId: "art-1",
    });
    expect(result).toMatchObject({
      kind: "too_large",
      sizeBytes: 100 * 1024 * 1024,
      maxBytes: 50 * 1024 * 1024,
      viewerKind: "text",
      artifact: { artifactId: "art-1", path: "big.txt" },
    });
  });

  test("downloads and decodes Markdown through the platform byte adapter", async () => {
    const { fetchAggregateArtifactBytes } = await load();
    ensureValidToken.mockImplementation(async () => "tok");
    downloadedText = "# A Brief History of Tea";
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

    const result = await fetchAggregateArtifactBytes({
      serverId: "srv-1",
      baseUrl: "http://127.0.0.1:3001",
      client: client as never,
      artifactId: "internal-1",
    });

    expect(result).toEqual({
      kind: "text",
      content: "# A Brief History of Tea",
      mimeType: "text/markdown",
      artifact,
    });
    expect(downloadArtifactBytes).toHaveBeenCalledTimes(1);
    expect(downloadArtifactBytes.mock.calls[0]?.[0]).toMatchObject({
      url: "http://localhost/artifacts/internal-1/bytes",
      token: "tok",
      text: true,
    });
  });

  test("downloads canonical Writer HTML as text for the native read-only renderer", async () => {
    const { fetchAggregateArtifactBytes } = await load();
    ensureValidToken.mockImplementation(async () => "tok");
    downloadedText = "<!DOCTYPE html><html><body></body></html>";
    const artifact = {
      id: "internal-writer",
      artifactId: "external-writer",
      revision: 2,
      path: "documents/brief.html",
      mimeType: "text/html",
      size: 897_423,
      updatedAt: "2026-08-07T00:00:00.000Z",
      createdAt: "2026-08-06T00:00:00.000Z",
      namespaceIds: ["ns-1"],
      canWrite: true,
    };
    const client = {
      setToken: mock(() => {}),
      getWorkspaceArtifact: mock(async () => artifact),
      getWorkspaceArtifactBytesUrl: mock(() => "http://localhost/artifacts/internal-writer/bytes"),
    };

    const result = await fetchAggregateArtifactBytes({
      serverId: "srv-1",
      baseUrl: "http://127.0.0.1:3001",
      client: client as never,
      artifactId: "internal-writer",
    });

    expect(result).toMatchObject({
      kind: "text",
      content: downloadedText,
      mimeType: "text/html",
      artifact: { id: "internal-writer", path: "documents/brief.html" },
    });
    expect(downloadArtifactBytes).toHaveBeenCalledTimes(1);
  });
});
