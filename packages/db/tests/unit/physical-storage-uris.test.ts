import { expect, test } from "bun:test";
import { join, parse, resolve } from "node:path";
import { physicalFileUriBase, physicalPathFromStorageUri, rebindPhysicalFileUri } from "../../src/utils/physical-storage-uris";

test("physical storage pointers preserve native paths without URL decoding", () => {
  const root = resolve("storage with spaces %20 café");
  expect(physicalFileUriBase(root)).toBe(`file://${root}`);
  expect(physicalPathFromStorageUri(`file://${root}`)).toBe(root);
  for (const value of [null, undefined, "https://example.test/file", "file://relative", "file://"]) {
    expect(physicalPathFromStorageUri(value)).toBeNull();
  }
});

test("rebinding uses native directory boundaries and preserves unrelated pointers", () => {
  const source = resolve("source");
  const target = resolve("target");
  expect(rebindPhysicalFileUri(`file://${source}`, source, target)).toBe(`file://${target}`);
  expect(rebindPhysicalFileUri(`file://${join(source, "artifacts", "name %20.txt")}`, source, target))
    .toBe(`file://${join(target, "artifacts", "name %20.txt")}`);
  const sibling = `file://${join(`${source}-other`, "file")}`;
  expect(rebindPhysicalFileUri(sibling, source, target)).toBe(sibling);
  expect(rebindPhysicalFileUri("s3://bucket/file", source, target)).toBe("s3://bucket/file");
});

test("physical roots reject filesystem roots, relative paths and control characters", () => {
  const root = resolve("source");
  for (const value of [parse(root).root, "relative", `${root}\ninvalid`]) {
    expect(() => physicalFileUriBase(value)).toThrow("Unsafe file-URI root");
  }
  expect(() => rebindPhysicalFileUri(`file://${root}`, root, root)).toThrow("must differ");
});

test("explicit storage-host syntax is independent of the operator platform", () => {
  expect(physicalFileUriBase("/var/lib/nautilo/artifacts", "posix")).toBe("file:///var/lib/nautilo/artifacts");
  expect(rebindPhysicalFileUri("file:///old/artifacts/file %20", "/old/artifacts", "/new/artifacts", "posix"))
    .toBe("file:///new/artifacts/file %20");
  expect(rebindPhysicalFileUri("file:///old/artifacts-other/file", "/old/artifacts", "/new/artifacts", "posix"))
    .toBe("file:///old/artifacts-other/file");
  expect(rebindPhysicalFileUri("file://C:\\old\\file %20", "C:\\old", "D:\\new", "win32"))
    .toBe("file://D:\\new\\file %20");
  expect(() => physicalFileUriBase("/", "posix")).toThrow();
  expect(() => physicalFileUriBase("C:\\", "win32")).toThrow();
});
