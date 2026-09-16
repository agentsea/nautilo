/**
 * M088C item 4 step 3 — pin `requestOpenFile` dispatcher behavior.
 * Returns false on shape-invalid payloads instead of routing them
 * blindly to the viewer drawer (which would 404 against the artifact
 * API for any payload that lacks the `kind` discriminator).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  requestOpenFile,
  setOpenFileDispatcher,
} from "../../src/adapters/open-file-ref";
import {
  artifactOpenFileTarget,
  fsOpenFileTarget,
} from "../../src/components/browser-column/open-file-target";

let dispatchSpy: ReturnType<typeof mock>;

beforeEach(() => {
  dispatchSpy = mock(() => {});
  setOpenFileDispatcher(dispatchSpy);
});

afterEach(() => {
  setOpenFileDispatcher(null);
});

describe("requestOpenFile", () => {
  test("dispatches a valid fs target and returns true", () => {
    const target = fsOpenFileTarget("/work/a.md", "/work");
    expect(requestOpenFile(target)).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledWith(target);
  });

  test("dispatches a valid artifact target and returns true", () => {
    const target = artifactOpenFileTarget({ id: "row-1", path: "x.md", mimeType: "text/markdown" });
    expect(requestOpenFile(target)).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledWith(target);
  });

  test("returns false when no dispatcher is registered", () => {
    setOpenFileDispatcher(null);
    expect(requestOpenFile(fsOpenFileTarget("/a", "/"))).toBe(false);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  test("returns false on payload missing kind discriminator", () => {
    expect(
      requestOpenFile({ path: "/a", rootPath: "/" } as unknown as Parameters<typeof requestOpenFile>[0]),
    ).toBe(false);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  test("returns false on payload with unknown kind", () => {
    expect(
      requestOpenFile({ kind: "url", path: "/a", rootPath: "/" } as unknown as Parameters<
        typeof requestOpenFile
      >[0]),
    ).toBe(false);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  test("returns false on fs payload with bad field types", () => {
    expect(
      requestOpenFile({ kind: "fs", path: "/a", rootPath: 7 } as unknown as Parameters<
        typeof requestOpenFile
      >[0]),
    ).toBe(false);
  });
});
