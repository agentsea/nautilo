import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_UPLOAD_ALLOWED_EXTENSIONS,
  ARTIFACT_VIDEO_EXTENSIONS,
  classifyArtifactUpload,
  detectExecutableOrArchiveMagic,
  extensionOfArtifactName,
  isArtifactUploadAllowedByExtension,
  isLikelyIsoBmffMp4,
  isLikelyOoxmlZip,
} from "../../src/artifact-upload-policy";

describe("artifact-upload-policy", () => {
  test("extensionOfArtifactName normalizes case", () => {
    expect(extensionOfArtifactName("/a/b/Photo.PNG")).toBe(".png");
    expect(extensionOfArtifactName("nope")).toBe("");
    expect(extensionOfArtifactName(".hidden")).toBe("");
  });

  test("ARTIFACT_UPLOAD_ALLOWED_EXTENSIONS excludes svg and blocklisted sets", () => {
    expect(ARTIFACT_UPLOAD_ALLOWED_EXTENSIONS.has(".pdf")).toBe(true);
    expect(ARTIFACT_UPLOAD_ALLOWED_EXTENSIONS.has(".parquet")).toBe(true);
    expect(ARTIFACT_UPLOAD_ALLOWED_EXTENSIONS.has(".mp4")).toBe(true);
    expect(ARTIFACT_UPLOAD_ALLOWED_EXTENSIONS.has(".svg")).toBe(false);
    expect(ARTIFACT_UPLOAD_ALLOWED_EXTENSIONS.has(".exe")).toBe(false);
    expect(ARTIFACT_UPLOAD_ALLOWED_EXTENSIONS.has(".zip")).toBe(false);
  });

  test("allows broad artifact extensions", () => {
    for (const name of [
      "report.pdf",
      "sheet.xlsx",
      "data.csv",
      "config.json",
      "readme.md",
      "script.py",
      "image.png",
      "track.mp3",
      "table.parquet",
    ]) {
      expect(isArtifactUploadAllowedByExtension(name)).toBe(true);
    }
  });

  test("rejects executables, archives, svg, and extensionless names", () => {
    expect(isArtifactUploadAllowedByExtension("setup.exe")).toBe(false);
    expect(isArtifactUploadAllowedByExtension("lib.dll")).toBe(false);
    expect(isArtifactUploadAllowedByExtension("bundle.zip")).toBe(false);
    expect(isArtifactUploadAllowedByExtension("archive.tar")).toBe(false);
    expect(isArtifactUploadAllowedByExtension("logo.svg")).toBe(false);
    expect(isArtifactUploadAllowedByExtension("README")).toBe(false);
  });

  test("detectExecutableOrArchiveMagic recognizes ELF and zip signatures", () => {
    expect(detectExecutableOrArchiveMagic(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]))).toBe("executable");
    expect(detectExecutableOrArchiveMagic(new Uint8Array([0x4d, 0x5a]))).toBe("executable");
    expect(detectExecutableOrArchiveMagic(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe("archive");
  });

  test("classifyArtifactUpload rejects renamed executable and zip-in-csv", () => {
    const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00]);
    expect(classifyArtifactUpload({ filename: "notes.txt", headBytes: elf })).toEqual({
      ok: false,
      reason: "Executable content detected in upload",
      code: "executable_magic",
    });

    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]);
    expect(classifyArtifactUpload({ filename: "data.csv", headBytes: zip })).toEqual({
      ok: false,
      reason: "Archive content detected in upload",
      code: "archive_magic",
    });
  });

  test("classifyArtifactUpload accepts plain markdown bytes", () => {
    const md = new TextEncoder().encode("# Hello\n");
    expect(classifyArtifactUpload({ filename: "readme.md", headBytes: md })).toEqual({ ok: true });
  });

  /**
   * Minimal OOXML package prefix used by the carve-out tests below. A real
   * .docx/.xlsx/.pptx starts with a ZIP local-file header whose first entry
   * is `[Content_Types].xml`. We approximate that with: 30-byte local-file
   * header (PK\x03\x04 + 26 zero bytes) + the 19-byte filename
   * `[Content_Types].xml` + a little padding.
   */
  function ooxmlPrefix(marker = "[Content_Types].xml"): Uint8Array {
    const header = new Uint8Array(30);
    header[0] = 0x50;
    header[1] = 0x4b;
    header[2] = 0x03;
    header[3] = 0x04;
    const name = new TextEncoder().encode(marker);
    const tail = new Uint8Array(64);
    const out = new Uint8Array(header.length + name.length + tail.length);
    out.set(header, 0);
    out.set(name, header.length);
    out.set(tail, header.length + name.length);
    return out;
  }

  test("isLikelyOoxmlZip requires OOXML extension + ZIP magic + content-types marker", () => {
    const prefix = ooxmlPrefix();
    expect(isLikelyOoxmlZip("report.docx", prefix)).toBe(true);
    expect(isLikelyOoxmlZip("sheet.xlsx", prefix)).toBe(true);
    expect(isLikelyOoxmlZip("deck.pptx", prefix)).toBe(true);
    // Wrong extension: marker + ZIP magic but not an office extension.
    expect(isLikelyOoxmlZip("archive.zip", prefix)).toBe(false);
    // Plain zip prefix without the OOXML marker.
    const plainZip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);
    expect(isLikelyOoxmlZip("report.docx", plainZip)).toBe(false);
    // Right extension + marker but missing ZIP magic (executable bytes).
    const elfWithMarker = new Uint8Array(30);
    elfWithMarker[0] = 0x7f;
    elfWithMarker[1] = 0x45;
    elfWithMarker[2] = 0x4c;
    elfWithMarker[3] = 0x46;
    elfWithMarker.set(new TextEncoder().encode("[Content_Types].xml"), 4);
    expect(isLikelyOoxmlZip("report.docx", elfWithMarker)).toBe(false);
    // Non-OOXML extension rejected outright.
    expect(isLikelyOoxmlZip("notes.txt", prefix)).toBe(false);
  });

  test("classifyArtifactUpload allows OOXML docx/xlsx/pptx with marker in sniff window", () => {
    const prefix = ooxmlPrefix();
    expect(classifyArtifactUpload({ filename: "report.docx", headBytes: prefix })).toEqual({ ok: true });
    expect(classifyArtifactUpload({ filename: "sheet.xlsx", headBytes: prefix })).toEqual({ ok: true });
    expect(classifyArtifactUpload({ filename: "deck.pptx", headBytes: prefix })).toEqual({ ok: true });
  });

  test("classifyArtifactUpload rejects plain .zip with archive_magic", () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]);
    expect(classifyArtifactUpload({ filename: "bundle.zip", headBytes: zip })).toEqual({
      ok: false,
      reason: "Archive content detected in upload",
      code: "archive_magic",
    });
  });

  test("classifyArtifactUpload rejects .docx with executable magic", () => {
    const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00]);
    expect(classifyArtifactUpload({ filename: "report.docx", headBytes: elf })).toEqual({
      ok: false,
      reason: "Executable content detected in upload",
      code: "executable_magic",
    });
  });

  test("classifyArtifactUpload rejects .docx ZIP without OOXML marker in sniff window", () => {
    // ZIP magic but no [Content_Types].xml reachable in the sniffed prefix.
    // Conservative: reject as archive_magic rather than trusting the extension
    // alone. See isLikelyOoxmlZip docstring re: tracked follow-up for the
    // server route to do a deeper sniff / full central-directory check.
    const zipNoMarker = new Uint8Array(256);
    zipNoMarker[0] = 0x50;
    zipNoMarker[1] = 0x4b;
    zipNoMarker[2] = 0x03;
    zipNoMarker[3] = 0x04;
    expect(classifyArtifactUpload({ filename: "report.docx", headBytes: zipNoMarker })).toEqual({
      ok: false,
      reason: "Archive content detected in upload",
      code: "archive_magic",
    });
  });

  test("classifyArtifactUpload still rejects svg by extension", () => {
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>");
    expect(classifyArtifactUpload({ filename: "logo.svg", headBytes: svg })).toEqual({
      ok: false,
      reason: "Unsupported artifact file type",
      code: "unsupported_artifact_type",
    });
  });

  // ─── D423 Phase 2 — workspace-artifact .mp4 (ISO-BMFF ftyp magic) ───────
  //
  // The .mp4 extension is admitted by the workspace artifact policy ONLY
  // (ARTIFACT_VIDEO_EXTENSIONS), and never on extension alone: the sniffed
  // head must carry the ISO-BMFF `ftyp` box. These tests mirror the
  // local-media ingest ftyp sniff (hasIsoBmffFileTypeBox) and assert the
  // executable/archive hard-deny precedence is preserved for spoofed MP4s.

  /**
   * Minimal ISO-BMFF prefix: 4-byte box size, then `ftyp` at offset 4..8,
   * then a 4-byte major brand (`isom`), then a little padding. This matches
   * the shape a real MP4 ftyp box takes within the first 12+ bytes.
   */
  function mp4FtypPrefix(brand = "isom"): Uint8Array {
    const size = new Uint8Array([0x00, 0x00, 0x00, 0x18]);
    const ftyp = new TextEncoder().encode("ftyp");
    const brandBytes = new TextEncoder().encode(brand);
    const tail = new Uint8Array(8);
    const out = new Uint8Array(size.length + ftyp.length + brandBytes.length + tail.length);
    out.set(size, 0);
    out.set(ftyp, size.length);
    out.set(brandBytes, size.length + ftyp.length);
    out.set(tail, size.length + ftyp.length + brandBytes.length);
    return out;
  }

  test("ARTIFACT_VIDEO_EXTENSIONS admits only .mp4 and stays out of composer-chat sets", () => {
    expect(ARTIFACT_VIDEO_EXTENSIONS.has(".mp4")).toBe(true);
    expect(ARTIFACT_VIDEO_EXTENSIONS.has(".mov")).toBe(false);
    expect(ARTIFACT_VIDEO_EXTENSIONS.has(".webm")).toBe(false);
  });

  test("isLikelyIsoBmffMp4 requires ftyp at offset 4..8 and >= 12 head bytes", () => {
    expect(isLikelyIsoBmffMp4(mp4FtypPrefix())).toBe(true);
    // Too few bytes to read size + ftyp + brand.
    expect(isLikelyIsoBmffMp4(new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]))).toBe(false);
    // ftyp not at offset 4..8.
    const shifted = new Uint8Array(16);
    shifted.set(new TextEncoder().encode("ftyp"), 0);
    expect(isLikelyIsoBmffMp4(shifted)).toBe(false);
    // Empty head.
    expect(isLikelyIsoBmffMp4(new Uint8Array(0))).toBe(false);
  });

  test("isArtifactUploadAllowedByExtension admits .mp4", () => {
    expect(isArtifactUploadAllowedByExtension("media/meeting.mp4")).toBe(true);
    expect(isArtifactUploadAllowedByExtension("clip.MP4")).toBe(true);
  });

  test("classifyArtifactUpload accepts a valid .mp4 with ISO-BMFF ftyp magic", () => {
    const prefix = mp4FtypPrefix();
    expect(classifyArtifactUpload({ filename: "media/meeting.mp4", headBytes: prefix })).toEqual({ ok: true });
    // Major brand is not validated; any 4-byte brand after ftyp is accepted.
    expect(classifyArtifactUpload({ filename: "clip.mp4", headBytes: mp4FtypPrefix("mp42") })).toEqual({ ok: true });
  });

  test("classifyArtifactUpload rejects a spoofed .mp4 whose bytes are not ISO-BMFF", () => {
    // Benign text bytes renamed to .mp4: no exec/archive magic, no ftyp.
    const text = new TextEncoder().encode("not an mp4 file — no ISO-BMFF ftyp box here");
    expect(classifyArtifactUpload({ filename: "media/meeting.mp4", headBytes: text })).toEqual({
      ok: false,
      reason: "MP4 artifact missing ISO-BMFF ftyp header",
      code: "mp4_ftyp_missing",
    });
  });

  test("classifyArtifactUpload preserves executable hard-deny precedence for spoofed .mp4", () => {
    // ELF magic with an .mp4 extension: must be denied as executable_magic,
    // not accepted as video or rejected as mp4_ftyp_missing.
    const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x00, 0x00, 0x00]);
    expect(classifyArtifactUpload({ filename: "payload.mp4", headBytes: elf })).toEqual({
      ok: false,
      reason: "Executable content detected in upload",
      code: "executable_magic",
    });
    // MZ (PE) magic likewise.
    const mz = new Uint8Array([0x4d, 0x5a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(classifyArtifactUpload({ filename: "payload.mp4", headBytes: mz })).toEqual({
      ok: false,
      reason: "Executable content detected in upload",
      code: "executable_magic",
    });
  });

  test("classifyArtifactUpload preserves archive hard-deny precedence for spoofed .mp4", () => {
    // ZIP local-file-header magic with an .mp4 extension: archive_magic,
    // not mp4_ftyp_missing (and never accepted as video).
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);
    expect(classifyArtifactUpload({ filename: "payload.mp4", headBytes: zip })).toEqual({
      ok: false,
      reason: "Archive content detected in upload",
      code: "archive_magic",
    });
  });

  test("classifyArtifactUpload rejects a truncated .mp4 head that cannot contain ftyp", () => {
    // An .mp4 whose sniffed head is shorter than the 12-byte ftyp floor is
    // rejected as mp4_ftyp_missing rather than trusted on extension alone.
    const truncated = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
    expect(classifyArtifactUpload({ filename: "tiny.mp4", headBytes: truncated })).toEqual({
      ok: false,
      reason: "MP4 artifact missing ISO-BMFF ftyp header",
      code: "mp4_ftyp_missing",
    });
  });
});
