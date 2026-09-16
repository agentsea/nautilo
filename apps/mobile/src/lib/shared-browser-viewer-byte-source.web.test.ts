import { describe, expect, test } from "bun:test";
import type { ArtifactDto } from "@nautilo/api-client/browser";

import {
  acquireBrowserArtifactViewerBytes,
  BrowserArtifactByteSourceError,
  type BrowserArtifactArrayBufferClient,
  type BrowserArtifactArrayBufferOptions,
} from "./shared-browser-viewer-byte-source.web";
import { acquireBrowserArtifactViewerBytes as acquireNativeBytes } from "./shared-browser-viewer-byte-source";

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

async function rejected<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject.");
}

describe("Mobile Web shared viewer byte source", () => {
  test("delegates one exact bounded acquisition and returns the same ArrayBuffer", async () => {
    const signal = new AbortController().signal;
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const calls: Array<{ id: string; options: BrowserArtifactArrayBufferOptions }> = [];
    const client: BrowserArtifactArrayBufferClient = {
      async getWorkspaceArtifactBytesArrayBuffer(id, options) {
        calls.push({ id, options });
        return bytes;
      },
    };

    const result = await acquireBrowserArtifactViewerBytes({
      client,
      artifactId: artifact.id,
      artifact,
      roomId: "room-1",
      maxBytes: 8,
      signal,
    });

    expect(calls).toEqual([{
      id: artifact.id,
      options: {
        roomId: "room-1",
        signal,
        expectedBytes: 4,
        maxBytes: 8,
      },
    }]);
    expect(result.bytes).toBe(bytes);
    expect(result).toMatchObject({ artifact, declaredBytes: 4, observedBytes: 4 });
  });

  test("supports aggregate browsing without inventing a discussion-room requirement", async () => {
    const signal = new AbortController().signal;
    let options: BrowserArtifactArrayBufferOptions | undefined;
    const client: BrowserArtifactArrayBufferClient = {
      async getWorkspaceArtifactBytesArrayBuffer(_id, nextOptions) {
        options = nextOptions;
        return new ArrayBuffer(4);
      },
    };

    await acquireBrowserArtifactViewerBytes({
      client,
      artifactId: artifact.id,
      artifact,
      maxBytes: 8,
      signal,
    });
    expect(options).toEqual({ signal, expectedBytes: 4, maxBytes: 8 });
  });

  test("fails before acquisition for an invalid scope, bad metadata, or an exceeded cap", async () => {
    let calls = 0;
    const client: BrowserArtifactArrayBufferClient = {
      async getWorkspaceArtifactBytesArrayBuffer() {
        calls += 1;
        return new ArrayBuffer(4);
      },
    };
    const base = {
      client,
      artifactId: artifact.id,
      artifact,
      roomId: "room-1",
      maxBytes: 8,
      signal: new AbortController().signal,
    };

    expect(await rejected(acquireBrowserArtifactViewerBytes({ ...base, roomId: " " }))).toMatchObject({
      code: "invalid_input",
    });
    expect(await rejected(acquireBrowserArtifactViewerBytes({ ...base, maxBytes: 0 }))).toMatchObject({
      code: "invalid_input",
    });
    expect(await rejected(acquireBrowserArtifactViewerBytes({
      ...base,
      artifact: { ...artifact, id: "other" },
    }))).toMatchObject({ code: "stale_metadata" });
    expect(await rejected(acquireBrowserArtifactViewerBytes({ ...base, maxBytes: 3 }))).toMatchObject({
      code: "size",
    });
    expect(calls).toBe(0);
  });

  test("rejects a client result that no longer matches the authorized metadata", async () => {
    const client: BrowserArtifactArrayBufferClient = {
      async getWorkspaceArtifactBytesArrayBuffer() {
        return new ArrayBuffer(3);
      },
    };

    const pending = acquireBrowserArtifactViewerBytes({
      client,
      artifactId: artifact.id,
      artifact,
      roomId: "room-1",
      maxBytes: 8,
      signal: new AbortController().signal,
    });
    expect(await rejected(pending)).toEqual(
      new BrowserArtifactByteSourceError(
        "stale_metadata",
        "Artifact bytes do not match the authorized metadata.",
      ),
    );
  });

  test("propagates cancellation and transport failures without remapping them", async () => {
    const abort = new DOMException("cancelled", "AbortError");
    const client: BrowserArtifactArrayBufferClient = {
      async getWorkspaceArtifactBytesArrayBuffer() {
        throw abort;
      },
    };

    const pending = acquireBrowserArtifactViewerBytes({
      client,
      artifactId: artifact.id,
      artifact,
      roomId: "room-1",
      maxBytes: 8,
      signal: new AbortController().signal,
    });
    expect(await rejected(pending)).toBe(abort);
  });

  test("keeps the native facade fail-closed without invoking the browser capability", async () => {
    let calls = 0;
    const client: BrowserArtifactArrayBufferClient = {
      async getWorkspaceArtifactBytesArrayBuffer() {
        calls += 1;
        return new ArrayBuffer(4);
      },
    };

    const error = await rejected(acquireNativeBytes({
      client,
      artifactId: artifact.id,
      artifact,
      roomId: "room-1",
      maxBytes: 8,
      signal: new AbortController().signal,
    }));
    expect(error).toMatchObject({ code: "unavailable" });
    expect(calls).toBe(0);
  });
});
