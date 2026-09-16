import { describe, expect, mock, test } from "bun:test";
import { _test, loadOoxmlByteSource } from "../../../src/viewers/ooxml/source";
import { OOXML_MAX_SOURCE_BYTES } from "../../../src/viewers/ooxml/contract";

const signal = new AbortController().signal;
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
const le32 = (n: number) => [
  n & 255,
  (n >>> 8) & 255,
  (n >>> 16) & 255,
  (n >>> 24) & 255,
];
const join = (...parts: (number[] | Uint8Array)[]) =>
  Uint8Array.from(parts.flatMap((part) => [...part]));

function zip(): ArrayBuffer {
  const name = [...new TextEncoder().encode("[Content_Types].xml")];
  const data = [1, 2, 3];
  const local = join(
    le32(0x04034b50),
    le16(20),
    le16(0),
    le16(0),
    le32(0),
    le32(0),
    le32(data.length),
    le32(data.length),
    le16(name.length),
    le16(0),
    name,
    data,
  );
  const central = join(
    le32(0x02014b50),
    le16(20),
    le16(20),
    le16(0),
    le16(0),
    le32(0),
    le32(0),
    le32(data.length),
    le32(data.length),
    le16(name.length),
    le16(0),
    le16(0),
    le16(0),
    le16(0),
    le32(0),
    le32(0),
    name,
  );
  return join(
    local,
    central,
    le32(0x06054b50),
    le16(0),
    le16(0),
    le16(1),
    le16(1),
    le32(central.length),
    le32(local.length),
    le16(0),
  ).buffer;
}

describe("OOXML authorized byte source", () => {
  test("uses the bounded ArrayBuffer artifact API and preserves exact optional roomId", async () => {
    const getBytes = mock(async () => zip());
    const result = await loadOoxmlByteSource(
      {
        kind: "artifact",
        id: "artifact",
        path: "private.xlsx",
        mimeType: "application/test",
        roomId: "room",
      },
      { getWorkspaceArtifactBytesArrayBuffer: getBytes, desktopAPI: null },
      { maxTextBytes: 1, signal, deadlineAt: Date.now() + 1_000 },
    );
    expect(getBytes).toHaveBeenCalledWith(
      "artifact",
      expect.objectContaining({
        roomId: "room",
        maxBytes: OOXML_MAX_SOURCE_BYTES,
        signal,
      }),
    );
    expect(result.kind).toBe("ready");
  });

  test("preflights metadata and keeps the master buffer out of the Reader contract", async () => {
    const master = zip();
    const getBytes = mock(async () => master);
    const tooLarge = await loadOoxmlByteSource(
      {
        kind: "artifact",
        id: "large",
        path: "large.docx",
        mimeType: "application/test",
        sizeBytes: OOXML_MAX_SOURCE_BYTES + 1,
      },
      { getWorkspaceArtifactBytesArrayBuffer: getBytes, desktopAPI: null },
      { maxTextBytes: 1, signal, deadlineAt: Date.now() + 1_000 },
    );
    expect(tooLarge).toEqual({
      kind: "too_large",
      sizeBytes: OOXML_MAX_SOURCE_BYTES + 1,
      maxBytes: OOXML_MAX_SOURCE_BYTES,
    });
    expect(getBytes).not.toHaveBeenCalled();

    const ready = await loadOoxmlByteSource(
      {
        kind: "artifact",
        id: "ok",
        path: "ok.docx",
        mimeType: "application/test",
      },
      { getWorkspaceArtifactBytesArrayBuffer: getBytes, desktopAPI: null },
      { maxTextBytes: 1, signal, deadlineAt: Date.now() + 1_000 },
    );
    if (ready.kind !== "ready") throw new Error("fixture load failed");
    expect(ready.source).toMatchObject({ byteLength: master.byteLength });
    expect("clone" in ready.source).toBe(false);
    expect("buffer" in ready.source).toBe(false);
  });

  test("rejects malformed archives before any OOXML parser clone with a sanitized message", async () => {
    const getBytes = mock(async () => new Uint8Array([1, 2, 3]).buffer);
    await expect(
      loadOoxmlByteSource(
        {
          kind: "artifact",
          id: "malformed",
          path: "malformed.docx",
          mimeType: "application/test",
        },
        { getWorkspaceArtifactBytesArrayBuffer: getBytes, desktopAPI: null },
        { maxTextBytes: 1, signal, deadlineAt: Date.now() + 1_000 },
      ),
    ).resolves.toEqual({
      kind: "error",
      message: _test.ARCHIVE_PREFLIGHT_FAILURE_MESSAGE,
    });
  });

  test("preserves acquisition failures as a distinct sanitized error class", async () => {
    const getBytes = mock(async () => {
      throw new Error("private upstream detail");
    });
    await expect(
      loadOoxmlByteSource(
        {
          kind: "artifact",
          id: "unavailable",
          path: "unavailable.xlsx",
          mimeType: "application/test",
        },
        { getWorkspaceArtifactBytesArrayBuffer: getBytes, desktopAPI: null },
        { maxTextBytes: 1, signal, deadlineAt: Date.now() + 1_000 },
      ),
    ).resolves.toEqual({
      kind: "error",
      message: "Unable to load this file preview.",
    });
  });
});
