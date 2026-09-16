/**
 * M088C item 4 — pin the wire shape of OpenFileTarget builders + the
 * shape validator used by `requestOpenFile`. The builders are the
 * single source of truth for `kind: "fs"` / `kind: "artifact"` emits;
 * a future PR that drops the discriminator would either need to delete
 * these tests or change the builders themselves.
 */

import { describe, expect, test } from "bun:test";
import {
  artifactOpenFileTarget,
  fsOpenFileTarget,
  isOpenFileTarget,
  openTargetForKnownRef,
  reloadArtifactOpenFileTarget,
} from "../../src/components/browser-column/open-file-target";

describe("fsOpenFileTarget", () => {
  test("emits kind: 'fs' with path + rootPath", () => {
    expect(fsOpenFileTarget("/work/a.md", "/work")).toEqual({
      kind: "fs",
      path: "/work/a.md",
      rootPath: "/work",
    });
  });
});

describe("artifactOpenFileTarget", () => {
  test("emits kind: 'artifact' with id + path + mimeType (no roomId)", () => {
    expect(
      artifactOpenFileTarget({ id: "row-1", path: "drafts/x.md", mimeType: "text/markdown" }),
    ).toEqual({
      kind: "artifact",
      id: "row-1",
      path: "drafts/x.md",
      mimeType: "text/markdown",
    });
  });

  test("includes roomId when provided", () => {
    expect(
      artifactOpenFileTarget({
        id: "row-2",
        path: "x.png",
        mimeType: "image/png",
        roomId: "room-7",
      }),
    ).toEqual({
      kind: "artifact",
      id: "row-2",
      path: "x.png",
      mimeType: "image/png",
      roomId: "room-7",
    });
  });

  test("includes reloadToken when provided", () => {
    expect(
      artifactOpenFileTarget({
        id: "row-4",
        path: "quiz.html",
        mimeType: "text/html",
        reloadToken: 2,
      }),
    ).toEqual({
      kind: "artifact",
      id: "row-4",
      path: "quiz.html",
      mimeType: "text/html",
      reloadToken: 2,
    });
  });

  test("omits roomId field entirely when undefined (does not set roomId: undefined)", () => {
    const t = artifactOpenFileTarget({ id: "row-3", path: "x", mimeType: "x" });
    expect("roomId" in t).toBe(false);
  });
});

describe("reloadArtifactOpenFileTarget", () => {
  test("drops revision-bound size metadata before reloading changed bytes", () => {
    const current = artifactOpenFileTarget({
      id: "artifact-1",
      path: "decks/live.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      roomId: "room-1",
      sizeBytes: 17_772,
      reloadToken: 4,
    });
    if (current.kind !== "artifact") throw new Error("expected artifact target");

    expect(reloadArtifactOpenFileTarget(current)).toEqual({
      kind: "artifact",
      id: "artifact-1",
      path: "decks/live.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      roomId: "room-1",
      reloadToken: 5,
    });
  });

  test("adopts a committed rename while invalidating the old byte length", () => {
    const current = artifactOpenFileTarget({
      id: "artifact-1",
      path: "before.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 120,
    });
    if (current.kind !== "artifact") throw new Error("expected artifact target");

    expect(reloadArtifactOpenFileTarget(current, "after.docx")).toMatchObject({
      path: "after.docx",
      reloadToken: 1,
    });
    expect(reloadArtifactOpenFileTarget(current, "after.docx")).not.toHaveProperty("sizeBytes");
  });
});

describe("openTargetForKnownRef (D322 link-click resolution)", () => {
  test("artifact ref → artifact target with internal id + mime + active room", () => {
    expect(
      openTargetForKnownRef(
        {
          kind: "artifact",
          path: "artifacts/leveraged-etfs.html",
          artifactId: "row-1",
          mimeType: "text/html",
        },
        "room-9",
      ),
    ).toEqual({
      kind: "artifact",
      id: "row-1",
      path: "artifacts/leveraged-etfs.html",
      mimeType: "text/html",
      roomId: "room-9",
    });
  });

  test("artifact ref without an active room omits roomId", () => {
    const t = openTargetForKnownRef(
      { kind: "artifact", path: "a.html", artifactId: "row-2", mimeType: "text/html" },
      null,
    );
    expect("roomId" in t).toBe(false);
  });

  test("fs ref → fs target with path + rootPath (room ignored)", () => {
    expect(
      openTargetForKnownRef(
        { kind: "fs", path: "/work/out/summary.pdf", rootPath: "/work" },
        "room-9",
      ),
    ).toEqual({
      kind: "fs",
      path: "/work/out/summary.pdf",
      rootPath: "/work",
    });
  });
});

describe("isOpenFileTarget", () => {
  test("accepts well-formed fs target", () => {
    expect(isOpenFileTarget(fsOpenFileTarget("/a", "/"))).toBe(true);
  });

  test("accepts well-formed artifact target", () => {
    expect(
      isOpenFileTarget(
        artifactOpenFileTarget({ id: "i", path: "p", mimeType: "m" }),
      ),
    ).toBe(true);
  });

  test("rejects null / non-object", () => {
    expect(isOpenFileTarget(null)).toBe(false);
    expect(isOpenFileTarget(undefined)).toBe(false);
    expect(isOpenFileTarget("string")).toBe(false);
    expect(isOpenFileTarget(42)).toBe(false);
  });

  test("rejects payload missing kind discriminator", () => {
    expect(isOpenFileTarget({ path: "/a", rootPath: "/" })).toBe(false);
    expect(isOpenFileTarget({ id: "i", path: "p", mimeType: "m" })).toBe(false);
  });

  test("rejects payload with unknown kind", () => {
    expect(
      isOpenFileTarget({ kind: "url", path: "/a", rootPath: "/" }),
    ).toBe(false);
  });

  test("rejects fs missing rootPath / wrong type", () => {
    expect(isOpenFileTarget({ kind: "fs", path: "/a" })).toBe(false);
    expect(isOpenFileTarget({ kind: "fs", path: "/a", rootPath: 7 })).toBe(false);
  });

  test("rejects artifact missing id / wrong type", () => {
    expect(isOpenFileTarget({ kind: "artifact", path: "p", mimeType: "m" })).toBe(false);
    expect(
      isOpenFileTarget({ kind: "artifact", id: 1, path: "p", mimeType: "m" }),
    ).toBe(false);
  });
});
