import { describe, expect, test } from "bun:test";
import {
  isCanonicalPathWithinRoot,
  isMediaProxyRequestAuthorized,
  isOpaqueMediaProxyId,
  isValidBoundMediaRef,
  mediaProxyRangeHeaders,
  parseMediaProxyPreviewToken,
} from "../../electron/media-proxy-policy.ts";

describe("D385 Desktop media proxy policy", () => {
  test("admits only bounded opaque ids and project-relative refs", () => {
    for (const value of ["request_1", "preview-2", "a.b~c"]) expect(isOpaqueMediaProxyId(value)).toBe(true);
    for (const value of ["", "/tmp/a", "https://x", "a/b", "x".repeat(257)]) expect(isOpaqueMediaProxyId(value)).toBe(false);
    for (const value of ["media/clip.mp4", "clips/A_1.mov"]) expect(isValidBoundMediaRef(value)).toBe(true);
    for (const value of ["/etc/passwd", "../clip.mp4", "a/../b.mp4", "file:clip.mp4", "https://x", "a\\b.mp4", "a//b.mp4", "a/./b.mp4"]) {
      expect(isValidBoundMediaRef(value)).toBe(false);
    }
  });

  test("requires canonical source and document paths within the exact root", () => {
    expect(isCanonicalPathWithinRoot("/work/project/video/movie.mp4", "/work/project")).toBe(true);
    expect(isCanonicalPathWithinRoot("/work/project", "/work/project")).toBe(true);
    expect(isCanonicalPathWithinRoot("/work/project-other/movie.mp4", "/work/project")).toBe(false);
    // A realpath-resolved symlink outside is rejected; callers must not use
    // textual containment before performing realpath.
    expect(isCanonicalPathWithinRoot("/private/etc/hosts", "/work/project")).toBe(false);
    expect(isCanonicalPathWithinRoot("relative/movie.mp4", "/work/project")).toBe(false);
    expect(isCanonicalPathWithinRoot("/anything", "/")).toBe(true);
  });

  test("parses only the opaque custom-scheme capability and enforces owner", () => {
    expect(parseMediaProxyPreviewToken("nautilo-media://proxy/preview_7")).toBe("preview_7");
    for (const value of ["file:///tmp/a", "nautilo-media://other/preview_7", "nautilo-media://proxy/a/b", "nautilo-media://proxy/../x", "nautilo-media://proxy/"]) {
      expect(parseMediaProxyPreviewToken(value)).toBeNull();
    }
    expect(isMediaProxyRequestAuthorized({ previewToken: "preview_7", ownerId: 17, requesterId: 17 })).toBe(true);
    expect(isMediaProxyRequestAuthorized({ previewToken: "preview_7", ownerId: 17, requesterId: 18 })).toBe(false);
    expect(isMediaProxyRequestAuthorized({ previewToken: null, ownerId: 17, requesterId: 17 })).toBe(false);
    expect(isMediaProxyRequestAuthorized({ previewToken: "preview_7", ownerId: 17, requesterId: undefined })).toBe(false);
  });

  test("forwards only syntactically valid byte ranges", () => {
    expect(mediaProxyRangeHeaders(new Headers({ Range: "bytes=0-1023", authorization: "must-not-forward" }))).toEqual({ Range: "bytes=0-1023" });
    expect(mediaProxyRangeHeaders(new Headers())).toEqual({});
    expect(mediaProxyRangeHeaders({ range: "bytes=0-1023", cookie: "no" })).toEqual({ Range: "bytes=0-1023" });
    expect(mediaProxyRangeHeaders({ Range: "bytes=-4096" })).toEqual({ Range: "bytes=-4096" });
    expect(mediaProxyRangeHeaders({ range: "bytes=-" })).toEqual({});
    expect(mediaProxyRangeHeaders({ range: "bytes=0-1,4-5" })).toEqual({});
    expect(mediaProxyRangeHeaders({ range: "items=0-1" })).toEqual({});
    expect(mediaProxyRangeHeaders({ range: "bytes=0-1\r\nX: y" })).toEqual({});
  });
});
