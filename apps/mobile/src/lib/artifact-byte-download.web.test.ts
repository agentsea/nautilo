import { describe, expect, test } from "bun:test";

import { createBrowserArtifactByteTransport } from "./artifact-byte-download.web";

describe("browser artifact byte transport", () => {
  test("uses the bearer for text without creating a retained object URL", async () => {
    const calls: unknown[] = [];
    const transport = createBrowserArtifactByteTransport({
      fetch: (url, init) => {
        calls.push([url, init.headers]);
        return Promise.resolve(new Response("hello", { status: 200 }));
      },
      createObjectURL: () => { throw new Error("unexpected object URL"); },
      revokeObjectURL: () => {},
    });
    expect(await transport.download({
      url: "https://alpha.example.test/api/file",
      token: "token",
      cacheName: "ignored.txt",
      text: true,
    })).toEqual({ kind: "text", content: "hello" });
    expect(calls).toEqual([[
      "https://alpha.example.test/api/file",
      { Authorization: "Bearer token" },
    ]]);
  });

  test("creates and explicitly releases binary object URLs", async () => {
    const revoked: string[] = [];
    const transport = createBrowserArtifactByteTransport({
      fetch: () => Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
      createObjectURL: () => "blob:https://alpha.example.test/artifact",
      revokeObjectURL: (url) => revoked.push(url),
    });
    expect(await transport.download({
      url: "https://alpha.example.test/api/file",
      token: "token",
      cacheName: "ignored.png",
      text: false,
    })).toEqual({ kind: "file", fileUri: "blob:https://alpha.example.test/artifact" });
    transport.release("blob:https://alpha.example.test/artifact");
    transport.release("file:///native-cache/artifact");
    expect(revoked).toEqual(["blob:https://alpha.example.test/artifact"]);
  });

  test("surfaces exact HTTP failure without manufacturing bytes", async () => {
    const transport = createBrowserArtifactByteTransport({
      fetch: () => Promise.resolve(new Response(null, { status: 403 })),
      createObjectURL: () => "blob:unexpected",
      revokeObjectURL: () => {},
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matcher typing
    await expect(transport.download({
      url: "https://alpha.example.test/api/file",
      token: "token",
      cacheName: "ignored",
      text: false,
    })).rejects.toThrow("HTTP 403");
  });
});
