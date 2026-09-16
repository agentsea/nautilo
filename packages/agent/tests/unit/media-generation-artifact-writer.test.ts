import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  MediaArtifactIndexCommitError,
  MediaArtifactWriteError,
  writeStagedMediaArtifact,
  type MediaArtifactIndexCommit,
} from "../../src/media-generation";

const receiptId = "mg_0123456789abcdef";

function mp4Bytes(brand = "isom"): Uint8Array {
  return Uint8Array.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, ...Buffer.from(brand), 0, 0, 0, 0]);
}

function m4aBytes(brand = "M4A "): Uint8Array {
  return mp4Bytes(brand);
}

function mp3Bytes(): Uint8Array {
  return Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 1]);
}

async function* chunks(...parts: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield part;
}

async function tempRoot(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "nautilo-media-writer-"));
}

async function errorOf(operation: Promise<unknown>): Promise<MediaArtifactWriteError> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof MediaArtifactWriteError) return error;
    throw error;
  }
  throw new Error("expected MediaArtifactWriteError");
}

function indexCommitter(record: { calls: MediaArtifactIndexCommit[]; fail?: "not_committed" | "unknown" }) {
  return {
    async commit(input: MediaArtifactIndexCommit) {
      record.calls.push(input);
      expect(await fsp.stat(input.finalPath)).toMatchObject({ size: input.size });
      if (record.fail) throw new MediaArtifactIndexCommitError(record.fail);
      return { artifactId: "media-artifact-external", artifactInternalId: "media-artifact-internal", artifactRevision: 7 };
    },
  };
}

async function mediaPaths(root: string): Promise<readonly string[]> {
  const names = await fsp.readdir(path.join(root, "media")).catch(() => [] as string[]);
  return names;
}

describe("staged generated-media artifact writer", () => {
  test("streams and atomically finalizes MP4 before exact artifact indexing, yielding a lifecycle cleanup proof", async () => {
    const root = await tempRoot();
    try {
      const calls: MediaArtifactIndexCommit[] = [];
      const bytes = mp4Bytes();
      const result = await writeStagedMediaArtifact({
        receiptId,
        mimeType: "video/mp4",
        stream: chunks(bytes.subarray(0, 7), bytes.subarray(7)),
        serverArtifactRoot: root,
        maxBytes: 1024,
        fileToken: "video-token",
        indexCommitter: indexCommitter({ calls }),
      });
      expect(result).toMatchObject({
        artifactId: "media-artifact-external",
        artifactInternalId: "media-artifact-internal",
        artifactRevision: 7,
        mimeType: "video/mp4",
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        commitProof: { receiptId, artifactInternalId: "media-artifact-internal", artifactRevision: 7, state: "durably_committed" },
      });
      expect(calls).toHaveLength(1);
      expect(await fsp.readFile(calls[0]!.finalPath)).toEqual(Buffer.from(bytes));
      expect(await fsp.readdir(path.join(root, ".media-staging"))).toEqual([]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("accepts both provider audio containers grounded in the current locked media contract", async () => {
    const root = await tempRoot();
    try {
      for (const [mimeType, bytes, token] of [
        ["audio/mp4", m4aBytes(), "m4a-token"],
        ["audio/mp4", m4aBytes("isom"), "m4a-isom-token"],
        ["audio/mp4", m4aBytes("mp42"), "m4a-mp42-token"],
        ["audio/mpeg", mp3Bytes(), "mp3-token"],
      ] as const) {
        const calls: MediaArtifactIndexCommit[] = [];
        const result = await writeStagedMediaArtifact({
          receiptId,
          mimeType,
          stream: chunks(bytes),
          serverArtifactRoot: root,
          maxBytes: 1024,
          fileToken: token,
          indexCommitter: indexCommitter({ calls }),
        });
        expect(result.mimeType).toBe(mimeType);
        expect(calls[0]?.mimeType).toBe(mimeType);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects interrupted, empty, malformed, and oversized streams before index commit and cleans staging", async () => {
    const root = await tempRoot();
    try {
      async function* interrupted(): AsyncGenerator<Uint8Array> {
        yield mp4Bytes().subarray(0, 8);
        throw new Error("provider body private failure");
      }
      const cases: Array<{
        stream: AsyncIterable<Uint8Array>;
        maxBytes: number;
        token: string;
        code: MediaArtifactWriteError["code"];
      }> = [
        { stream: interrupted(), maxBytes: 1024, token: "interrupt-token", code: "MEDIA_ARTIFACT_STREAM_INTERRUPTED" },
        { stream: chunks(), maxBytes: 1024, token: "empty-token", code: "MEDIA_ARTIFACT_EMPTY" },
        { stream: chunks(mp3Bytes()), maxBytes: 1024, token: "wrong-mime-token", code: "MEDIA_ARTIFACT_MIME_MISMATCH" },
        { stream: chunks(mp4Bytes()), maxBytes: 8, token: "oversize-token", code: "MEDIA_ARTIFACT_TOO_LARGE" },
      ];
      for (const item of cases) {
        const calls: MediaArtifactIndexCommit[] = [];
        const error = await errorOf(writeStagedMediaArtifact({
          receiptId,
          mimeType: "video/mp4",
          stream: item.stream,
          serverArtifactRoot: root,
          maxBytes: item.maxBytes,
          fileToken: item.token,
          indexCommitter: indexCommitter({ calls }),
        }));
        expect(error.code).toBe(item.code);
        expect(error.message).not.toContain("provider body private failure");
        expect(calls).toEqual([]);
      }
      expect(await fsp.readdir(path.join(root, ".media-staging"))).toEqual([]);
      expect(await mediaPaths(root)).toEqual([]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("removes only proven-unindexed finals and never deletes committed or uncertain index outcomes", async () => {
    const root = await tempRoot();
    try {
      const failedCalls: MediaArtifactIndexCommit[] = [];
      const error = await errorOf(writeStagedMediaArtifact({
        receiptId,
        mimeType: "video/mp4",
        stream: chunks(mp4Bytes()),
        serverArtifactRoot: root,
        maxBytes: 1024,
        fileToken: "index-failure-token",
        indexCommitter: indexCommitter({ calls: failedCalls, fail: "not_committed" }),
      }));
      expect(error.code).toBe("MEDIA_ARTIFACT_INDEX_FAILED");
      expect(failedCalls).toHaveLength(1);
      expect(await mediaPaths(root)).toEqual([]);

      const uncertainCalls: MediaArtifactIndexCommit[] = [];
      const unknownError = await errorOf(writeStagedMediaArtifact({
        receiptId,
        mimeType: "video/mp4",
        stream: chunks(mp4Bytes()),
        serverArtifactRoot: root,
        maxBytes: 1024,
        fileToken: "index-unknown-token",
        indexCommitter: indexCommitter({ calls: uncertainCalls, fail: "unknown" }),
      }));
      expect(unknownError.code).toBe("MEDIA_ARTIFACT_INDEX_FAILED");
      expect(uncertainCalls).toHaveLength(1);
      expect(await mediaPaths(root)).toEqual(["mg_0123456789abcdef-index-unknown-token.mp4"]);

      const successfulCalls: MediaArtifactIndexCommit[] = [];
      await writeStagedMediaArtifact({
        receiptId,
        mimeType: "video/mp4",
        stream: chunks(mp4Bytes()),
        serverArtifactRoot: root,
        maxBytes: 1024,
        fileToken: "index-success-token",
        indexCommitter: indexCommitter({ calls: successfulCalls }),
      });
      expect(successfulCalls).toHaveLength(1);
      expect(await fsp.stat(successfulCalls[0]!.finalPath)).toMatchObject({ size: mp4Bytes().byteLength });
      expect(await fsp.readdir(path.join(root, ".media-staging"))).toEqual([]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
