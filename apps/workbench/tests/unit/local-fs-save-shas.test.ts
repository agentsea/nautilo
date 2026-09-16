import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearLocalFsSaveShasForTests,
  isLocalFsSaveSha,
  LOCAL_FS_SAVE_SHA_TTL_MS,
  registerLocalFsSaveSha,
} from "../../src/editors/local-fs-save-shas";

const PATH = "/repo/notes.md";

describe("local fs save SHA suppression", () => {
  beforeEach(() => {
    clearLocalFsSaveShasForTests();
  });

  test("recognizes overlapping autosaves when the older watcher callback is delayed", () => {
    registerLocalFsSaveSha(PATH, "save-a", 1_000);
    registerLocalFsSaveSha(PATH, "save-b", 1_100);

    expect(isLocalFsSaveSha(PATH, "save-a", 1_200)).toBe(true);
    expect(isLocalFsSaveSha(PATH, "save-b", 1_200)).toBe(true);
  });

  test("expires old saves so a later external revert is reloaded", () => {
    registerLocalFsSaveSha(PATH, "old-save", 1_000);

    expect(
      isLocalFsSaveSha(PATH, "old-save", 1_000 + LOCAL_FS_SAVE_SHA_TTL_MS + 1),
    ).toBe(false);
  });

  test("does not share suppression history across files", () => {
    registerLocalFsSaveSha(PATH, "same-bytes", 1_000);

    expect(isLocalFsSaveSha("/repo/other.md", "same-bytes", 1_100)).toBe(false);
  });
});
