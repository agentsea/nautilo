import { describe, expect, test } from "bun:test";
import {
  decideFsWrite,
  FS_WRITE_FILE_MAX_BYTES,
  sha256Hex,
  writeFileAtomically,
} from "../../electron/fs-write";

describe("decideFsWrite", () => {
  const base = {
    targetPath: "/allowed/project/readme.md",
    allowed: true,
    baseSha256: null as string | null,
    currentSha256: null as string | null,
    contentBytes: 12,
  };

  test("allowed path with null base sha passes", () => {
    expect(decideFsWrite(base)).toEqual({ ok: true });
  });

  test("outside allowed roots returns forbidden before size/conflict", () => {
    expect(
      decideFsWrite({
        ...base,
        allowed: false,
        contentBytes: FS_WRITE_FILE_MAX_BYTES + 1,
        baseSha256: "abc",
        currentSha256: "def",
      }),
    ).toEqual({ ok: false, code: "forbidden" });
  });

  test("content over the cap returns too_large", () => {
    expect(
      decideFsWrite({
        ...base,
        contentBytes: FS_WRITE_FILE_MAX_BYTES + 1,
      }),
    ).toEqual({ ok: false, code: "too_large" });
  });

  test("exactly at the cap passes size gate", () => {
    expect(
      decideFsWrite({
        ...base,
        contentBytes: FS_WRITE_FILE_MAX_BYTES,
      }),
    ).toEqual({ ok: true });
  });

  test("matching base sha passes", () => {
    expect(
      decideFsWrite({
        ...base,
        baseSha256: "deadbeef",
        currentSha256: "deadbeef",
      }),
    ).toEqual({ ok: true });
  });

  test("mismatched base sha returns conflict", () => {
    expect(
      decideFsWrite({
        ...base,
        baseSha256: "expected",
        currentSha256: "on-disk",
      }),
    ).toEqual({ ok: false, code: "conflict" });
  });

  test("base sha on missing file (null current) returns conflict", () => {
    expect(
      decideFsWrite({
        ...base,
        baseSha256: "expected",
        currentSha256: null,
      }),
    ).toEqual({ ok: false, code: "conflict" });
  });

  test("null base sha skips sha guard even when current differs", () => {
    expect(
      decideFsWrite({
        ...base,
        baseSha256: null,
        currentSha256: "on-disk",
      }),
    ).toEqual({ ok: true });
  });
});

describe("sha256Hex", () => {
  test("hashes UTF-8 bytes", () => {
    expect(sha256Hex(Buffer.from("hello", "utf-8"))).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

describe("writeFileAtomically", () => {
  test("writes temp file in target directory then renames", async () => {
    const calls: string[] = [];
    const target = "/allowed/project/readme.md";

    await writeFileAtomically(target, Buffer.from("next", "utf-8"), {
      writeFile: async (p) => {
        calls.push(`write:${p}`);
      },
      rename: async (from, to) => {
        calls.push(`rename:${from}->${to}`);
      },
      unlink: async (p) => {
        calls.push(`unlink:${p}`);
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^write:\/allowed\/project\/\.readme\.md\.[a-f0-9]+\.tmp$/);
    expect(calls[1]).toMatch(
      /^rename:\/allowed\/project\/\.readme\.md\.[a-f0-9]+\.tmp->\/allowed\/project\/readme\.md$/,
    );
  });

  test("cleans temp file when rename fails", async () => {
    const unlinked: string[] = [];
    let tmpPath = "";

    await expect(
      writeFileAtomically("/allowed/project/readme.md", Buffer.from("x"), {
        writeFile: async (p) => {
          tmpPath = p;
        },
        rename: async () => {
          throw new Error("rename failed");
        },
        unlink: async (p) => {
          unlinked.push(p);
        },
      }),
    ).rejects.toThrow("rename failed");

    expect(unlinked).toEqual([tmpPath]);
  });
});
