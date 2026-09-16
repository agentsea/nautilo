import { describe, expect, test } from "bun:test";

import { writerRemotePostimageState } from "./writer-remote-postimage-state";

describe("Writer app remote postimage publication", () => {
  test("an identical authoritative postimage clears the pending dirty/lease truth", () => {
    expect(writerRemotePostimageState(false)).toEqual({
      dirty: false,
      saveStatus: "saved",
    });
  });

  test("a non-overlap rebase remains a dirty human draft", () => {
    expect(writerRemotePostimageState(true)).toEqual({
      dirty: true,
      saveStatus: "unsaved",
    });
  });
});
