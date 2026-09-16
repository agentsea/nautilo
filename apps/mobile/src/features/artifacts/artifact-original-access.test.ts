import { beforeEach, expect, mock, test } from "bun:test";

let token = "token-a";
let tokenOwner = "human-a";
let metadataCalls = 0;
let downloads = 0;
let downloadedUrl = "";
let authDead = 0;
let reject = false;

class TestApiError extends Error { constructor(public status: number, message: string) { super(message); } }
mock.module("@nautilo/api-client/browser", () => ({
  ApiError: TestApiError,
  NautiloApiClient: class {
    setToken() {}
    getWorkspaceArtifactBytesUrl() { return "https://server.invalid/bytes"; }
    async getWorkspaceArtifact() {
      metadataCalls += 1;
      if (reject) throw new TestApiError(401, "Rejected bearer");
      return { id: "row-a", artifactId: "artifact-a", path: "reports/original.bin", mimeType: "application/octet-stream", size: 4, revision: 1, canWrite: false };
    }
  },
}));
mock.module("@/lib/auth", () => ({ ensureValidToken: async () => token }));
mock.module("@/lib/auth-events", () => ({ emitAuthDead: () => { authDead += 1; } }));
mock.module("@/lib/server-store", () => ({ loadTokenSnapshot: async () => ({ tokens: { accessToken: token, userId: tokenOwner } }) }));
mock.module("@/lib/original-file-download", () => ({ downloadOriginalFile: async (input: { url: string }) => {
  downloads += 1;
  downloadedUrl = input.url;
  return { fileUri: "file:///cache/original.bin", size: 4, cleanup: () => {} };
} }));

const { acquireAuthorizedArtifactOriginal } = await import("./artifact-original-access");
const scope = { serverId: "server-a", accountId: "human-a", sourceKind: "artifact" as const, sourceId: "row-a", generation: 1 };

beforeEach(() => { token = "token-a"; tokenOwner = "human-a"; metadataCalls = downloads = authDead = 0; downloadedUrl = ""; reject = false; });

test("uses the existing bytes API without a storage-upgrade capability and labels its consistency truthfully", async () => {
  const result = await acquireAuthorizedArtifactOriginal({ scope, baseUrl: "https://server.invalid", isCurrent: () => true, controller: new AbortController() });
  expect(result).toMatchObject({ kind: "ready", filename: "original.bin", consistency: "metadata_rechecked_not_immutable" });
  expect(metadataCalls).toBe(2); expect(downloads).toBe(1); expect(authDead).toBe(0);
  expect(downloadedUrl).toBe("https://server.invalid/bytes");
});

test("refreshes exactly once after a current 401 and emits auth-dead only for its owner", async () => {
  reject = true;
  const result = await acquireAuthorizedArtifactOriginal({ scope, baseUrl: "https://server.invalid", isCurrent: () => true, controller: new AbortController() });
  expect(result).toEqual({ kind: "failed", reason: "auth_dead" });
  expect(metadataCalls).toBe(2); expect(downloads).toBe(0); expect(authDead).toBe(1);
});

test("never reports auth-dead when the stored credential belongs to another account", async () => {
  tokenOwner = "human-b";
  const result = await acquireAuthorizedArtifactOriginal({ scope, baseUrl: "https://server.invalid", isCurrent: () => true, controller: new AbortController() });
  expect(result).toEqual({ kind: "failed", reason: "cancelled" });
  expect(metadataCalls).toBe(0); expect(downloads).toBe(0); expect(authDead).toBe(0);
});
