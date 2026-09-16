import { describe, expect, test } from "bun:test";
import { isAppBridgeRequest } from "../../src/apps/app-bridge";

describe("Video Workspace-copy bridge authority", () => {
  test("accepts only a saved SHA and opaque request identity from the iframe", () => {
    expect(isAppBridgeRequest({ type: "nautilo.app.media.req", requestId: "promotion-1", op: "saveWorkspaceCopy", sha256: "a".repeat(64) })).toBe(true);
    for (const smuggled of [
      { roomId: "10000000-0000-4000-8000-000000000001" },
      { documentPath: "/private/project.video.html" },
      { sources: [{ path: "media/source.mp4" }] },
      { content: "<html>untrusted</html>" },
    ]) expect(isAppBridgeRequest({ type: "nautilo.app.media.req", requestId: "promotion-1", op: "saveWorkspaceCopy", sha256: "a".repeat(64), ...smuggled })).toBe(false);
  });

  test("keeps capability discovery and explicit opening closed and authority-free", () => {
    expect(isAppBridgeRequest({ type: "nautilo.app.media.req", requestId: "cap-1", op: "workspaceCopyCapabilities" })).toBe(true);
    expect(isAppBridgeRequest({ type: "nautilo.app.media.req", requestId: "open-1", op: "openWorkspaceCopy" })).toBe(true);
    expect(isAppBridgeRequest({ type: "nautilo.app.media.req", requestId: "open-1", op: "openWorkspaceCopy", artifactId: "hidden" })).toBe(false);
  });
});
