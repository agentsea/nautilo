import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Zip, ZipDeflate, zipSync } from "fflate";
import { validateOfficeUploadPackage } from "../../src/lib/office-upload-package";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const xml = new TextEncoder().encode("<synthetic/>");
function workbook(extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({ ...extra, "xl/workbook.xml": xml, "_rels/.rels": xml, "[Content_Types].xml": xml }, { level: 0 });
}
async function validate(bytes: Uint8Array, name = "sample.xlsx"): Promise<boolean> {
  const root = await mkdtemp(join(tmpdir(), "office-package-"));
  roots.push(root);
  const path = join(root, "upload");
  await writeFile(path, bytes);
  return validateOfficeUploadPackage(path, name);
}
function centralOffset(bytes: Uint8Array): number {
  return Buffer.from(bytes).readUInt32LE(bytes.length - 6);
}

describe("Office upload package structure", () => {
  test("accepts the actual shipped DOCX/XLSX/PPTX templates", async () => {
    for (const ext of ["docx", "xlsx", "pptx"]) {
      const bytes = await readFile(new URL(`../../assets/office-templates/blank.${ext}`, import.meta.url));
      expect(await validate(bytes, `blank.${ext}`)).toBe(true);
    }
  });

  test("accepts a workbook whose Office marker follows a large worksheet", async () => {
    const bytes = workbook({ "xl/worksheets/sheet1.xml": new Uint8Array(256 * 1024).fill(0x61) });
    expect(Buffer.from(bytes).indexOf("[Content_Types].xml")).toBeGreaterThan(64 * 1024);
    expect(await validate(bytes)).toBe(true);
  });

  test("accepts streamed ZIP data descriptors and archive comments", async () => {
    const chunks: Uint8Array[] = [];
    const zip = new Zip((error, bytes) => { if (error) throw error; chunks.push(bytes); });
    for (const name of ["xl/workbook.xml", "_rels/.rels", "[Content_Types].xml"]) {
      const part = new ZipDeflate(name);
      zip.add(part); part.push(xml, true);
    }
    zip.end();
    const streamed = Buffer.concat(chunks);
    expect(streamed.readUInt16LE(6) & 8).toBe(8);
    expect(await validate(streamed)).toBe(true);
    const comment = Buffer.from("synthetic ZIP comment");
    const commented = Buffer.concat([streamed, comment]);
    commented.writeUInt16LE(comment.length, streamed.length - 2);
    expect(await validate(commented)).toBe(true);
  });

  test("accepts ZIP64 directory and per-member sentinel sizes without truncation", async () => {
    const ordinary = Buffer.from(workbook());
    const central = centralOffset(ordinary);
    const oldEnd = ordinary.length - 22;
    const nameEnd = central + 46 + ordinary.readUInt16LE(central + 28);
    const extra = Buffer.alloc(28);
    extra.writeUInt16LE(1, 0); extra.writeUInt16LE(24, 2);
    extra.writeBigUInt64LE(BigInt(ordinary.readUInt32LE(central + 24)), 4);
    extra.writeBigUInt64LE(BigInt(ordinary.readUInt32LE(central + 20)), 12);
    extra.writeBigUInt64LE(BigInt(ordinary.readUInt32LE(central + 42)), 20);
    const body = Buffer.concat([ordinary.subarray(0, nameEnd), extra, ordinary.subarray(nameEnd, oldEnd)]);
    body.writeUInt16LE(28, central + 30);
    for (const field of [20, 24, 42]) body.writeUInt32LE(0xffffffff, central + field);
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0); record.writeBigUInt64LE(44n, 4);
    record.writeBigUInt64LE(3n, 24); record.writeBigUInt64LE(3n, 32);
    record.writeBigUInt64LE(BigInt(body.length - central), 40); record.writeBigUInt64LE(BigInt(central), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0); locator.writeBigUInt64LE(BigInt(body.length), 8); locator.writeUInt32LE(1, 16);
    const end = Buffer.from(ordinary.subarray(oldEnd));
    end.writeUInt16LE(0xffff, 8); end.writeUInt16LE(0xffff, 10);
    end.writeUInt32LE(0xffffffff, 12); end.writeUInt32LE(0xffffffff, 16);
    expect(await validate(Buffer.concat([body, record, locator, end]))).toBe(true);
  });

  test("rejects generic archives, marker text inside data, and format mismatch", async () => {
    expect(await validate(zipSync({ "notes.txt": new TextEncoder().encode("[Content_Types].xml") }))).toBe(false);
    expect(await validate(workbook(), "renamed.docx")).toBe(false);
    expect(await validate(workbook(), "renamed.zip")).toBe(false);
    expect(await validate(zipSync({ "[Content_Types].xml": xml, "xl/workbook.xml": xml }))).toBe(false);
    expect(await validate(zipSync({ "[Content_Types].xml": xml, "_rels/.rels": xml, "xl/workbook.xml": new Uint8Array() }))).toBe(false);
  });

  test("rejects malformed/truncated ZIPs and forged directory counts/ranges", async () => {
    const bytes = workbook();
    for (const cut of [0, 3, 21, bytes.length - 1, bytes.length - 22]) {
      expect(await validate(bytes.subarray(0, cut))).toBe(false);
    }
    for (const position of [12, 16]) {
      const corrupt = Buffer.from(bytes);
      corrupt.writeUInt32LE(0xfffffffe, corrupt.length - 22 + position);
      expect(await validate(corrupt)).toBe(false);
    }
  });

  test("rejects encrypted, macro-bearing and unsafe member paths", async () => {
    const encrypted = Buffer.from(workbook());
    encrypted.writeUInt16LE(encrypted.readUInt16LE(6) | 1, 6);
    const central = centralOffset(encrypted);
    encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8);
    expect(await validate(encrypted)).toBe(false);
    for (const name of ["xl/vbaProject.bin", "../escape.xml", "/absolute.xml", "xl\\unsafe.xml"]) {
      expect(await validate(workbook({ [name]: xml }))).toBe(false);
    }
  });

  test("rejects local/directory disagreement, duplicates, hidden local entries and executable prefixes", async () => {
    const bytes = Buffer.from(workbook());
    bytes[30] = 0x7a;
    expect(await validate(bytes)).toBe(false);
    const duplicate = Buffer.from(workbook({ "xl/one.xml": xml, "xl/two.xml": xml }));
    for (let at = 0; at < duplicate.length - 10; at++) {
      if (duplicate.subarray(at, at + 10).toString() === "xl/two.xml") duplicate.write("xl/one.xml", at);
    }
    expect(await validate(duplicate)).toBe(false);
    const hidden = Buffer.from(workbook());
    // Remove the first directory member, retaining its undeclared local entry.
    const first = centralOffset(hidden);
    const firstLength = 46 + hidden.readUInt16LE(first + 28) + hidden.readUInt16LE(first + 30) + hidden.readUInt16LE(first + 32);
    const without = Buffer.concat([hidden.subarray(0, first), hidden.subarray(first + firstLength)]);
    const endAt = without.length - 22;
    without.writeUInt16LE(2, endAt + 8); without.writeUInt16LE(2, endAt + 10);
    without.writeUInt32LE(hidden.readUInt32LE(hidden.length - 10) - firstLength, endAt + 12);
    expect(await validate(without)).toBe(false);
    expect(await validate(Buffer.concat([Buffer.from("MZ"), workbook()]))).toBe(false);
  });
});
