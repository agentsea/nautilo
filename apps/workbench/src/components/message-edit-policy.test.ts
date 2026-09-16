import { describe, expect, test } from "bun:test";
import {
  inlineEditKeyAction,
  remoteEditResolution,
} from "./message-edit-policy";

describe("inline Human message editing (M230)", () => {
  test("Enter saves, Shift+Enter remains a newline, and Escape cancels", () => {
    expect(
      inlineEditKeyAction({
        key: "Enter",
        shiftKey: false,
        isComposing: false,
      }),
    ).toBe("save");
    expect(
      inlineEditKeyAction({
        key: "Enter",
        shiftKey: true,
        isComposing: false,
      }),
    ).toBe("none");
    expect(
      inlineEditKeyAction({
        key: "Escape",
        shiftKey: false,
        isComposing: false,
      }),
    ).toBe("cancel");
    expect(
      inlineEditKeyAction({
        key: "Enter",
        shiftKey: false,
        isComposing: true,
      }),
    ).toBe("none");
  });

  test("a newer remote edit closes an untouched editor but preserves a dirty draft", () => {
    expect(
      remoteEditResolution({
        localBaseRevision: 1,
        remoteRevision: 2,
        localDraft: "original",
        localBaseContent: "original",
      }),
    ).toBe("close");
    expect(
      remoteEditResolution({
        localBaseRevision: 1,
        remoteRevision: 2,
        localDraft: "my correction",
        localBaseContent: "original",
      }),
    ).toBe("conflict");
    expect(
      remoteEditResolution({
        localBaseRevision: 2,
        remoteRevision: 2,
        localDraft: "my correction",
        localBaseContent: "original",
      }),
    ).toBe("none");
  });
});
