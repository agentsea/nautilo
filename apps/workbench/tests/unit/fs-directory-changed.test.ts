import { describe, expect, test } from "bun:test";
import { fsDirectoryChangeAffectsFile } from "../../src/lib/fs-directory-changed";

describe("fsDirectoryChangeAffectsFile", () => {
  const rootPath = "/tmp/workspace";
  const filePath = "/tmp/workspace/notes.txt";
  const parentPath = "/tmp/workspace";

  test("matches exact changedPath from desktop watcher", () => {
    expect(
      fsDirectoryChangeAffectsFile(
        { rootPath, path: parentPath, changedPath: filePath },
        filePath,
      ),
    ).toBe(true);
  });

  test("ignores changedPath for a different file", () => {
    expect(
      fsDirectoryChangeAffectsFile(
        {
          rootPath,
          path: parentPath,
          changedPath: "/tmp/workspace/other.txt",
        },
        filePath,
      ),
    ).toBe(false);
  });

  test("falls back to parent directory when changedPath is absent", () => {
    expect(
      fsDirectoryChangeAffectsFile({ rootPath, path: parentPath }, filePath),
    ).toBe(true);
  });

  test("supports legacy events that used path as the file path", () => {
    expect(
      fsDirectoryChangeAffectsFile({ rootPath, path: filePath }, filePath),
    ).toBe(true);
  });
});
