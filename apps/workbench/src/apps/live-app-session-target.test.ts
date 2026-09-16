import { describe, expect, test } from "bun:test";
import { fsOpenFileTarget } from "../components/browser-column/open-file-target";
import {
  buildIssueLiveSessionRequest,
  fsBoundDisplayPath,
  liveReviewBoundTargetKey,
} from "./live-app-session-target";

describe("live app session target helpers", () => {
  test("buildIssueLiveSessionRequest for artifact revision", () => {
    const target = {
      kind: "artifact" as const,
      id: "art-1",
      path: "notes.txt",
      mimeType: "text/plain",
    };
    expect(
      buildIssueLiveSessionRequest(
        target,
        { kind: "artifact_revision", revision: 3 },
        null,
      ),
    ).toEqual({
      targetKind: "artifact",
      artifactId: "art-1",
      documentVersion: { kind: "artifact_revision", revision: 3 },
    });
  });

  test("buildIssueLiveSessionRequest for current file requires relay hint", () => {
    const target = fsOpenFileTarget("/Users/me/project/docs/note.txt", "/Users/me/project");
    expect(
      buildIssueLiveSessionRequest(
        target,
        { kind: "local_sha", sha256: "a".repeat(64) },
        null,
      ),
    ).toBeNull();
    expect(
      buildIssueLiveSessionRequest(
        target,
        { kind: "local_sha", sha256: "a".repeat(64) },
        "relay-abc",
      ),
    ).toEqual({
      targetKind: "currentFile",
      relayIdHint: "relay-abc",
      currentFolder: "/Users/me/project",
      relativePath: "docs/note.txt",
      documentVersion: { kind: "local_sha", sha256: "a".repeat(64) },
    });
  });

  test("fsBoundDisplayPath never returns absolute paths under the root", () => {
    const target = fsOpenFileTarget("/repo/sub/file.json", "/repo");
    expect(fsBoundDisplayPath(target)).toBe("sub/file.json");
    expect(fsBoundDisplayPath(target)).not.toContain("/repo");
  });

  test("liveReviewBoundTargetKey discriminates artifact and fs bindings", () => {
    expect(
      liveReviewBoundTargetKey({
        kind: "artifact",
        id: "a1",
        path: "x",
        mimeType: "text/plain",
      }),
    ).toBe("artifact:a1");
    expect(
      liveReviewBoundTargetKey(
        fsOpenFileTarget("/root/sub/file.txt", "/root"),
      ),
    ).toBe("fs:/root:/root/sub/file.txt");
  });
});
