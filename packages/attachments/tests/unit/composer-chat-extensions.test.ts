import { describe, expect, test } from "bun:test";
import {
  extensionOfBasename,
  isComposerChatAttachmentPathAllowed,
} from "../../src/composer-chat-extensions";

describe("composer-chat-extensions", () => {
  test("extensionOfBasename normalizes case", () => {
    expect(extensionOfBasename("/a/b/Photo.PNG")).toBe(".png");
    expect(extensionOfBasename("nope")).toBe("");
    expect(extensionOfBasename(".hidden")).toBe("");
  });

  test("allows policy text/audio/image extensions", () => {
    expect(isComposerChatAttachmentPathAllowed("/x/y/z.md")).toBe(true);
    expect(isComposerChatAttachmentPathAllowed("/x/y/z.m4a")).toBe(true);
    expect(isComposerChatAttachmentPathAllowed("/x/y/z.webp")).toBe(true);
  });

  test("rejects documents and unknown extensions", () => {
    expect(isComposerChatAttachmentPathAllowed("/x/y/z.pdf")).toBe(false);
    expect(isComposerChatAttachmentPathAllowed("/x/y/z.docx")).toBe(false);
    expect(isComposerChatAttachmentPathAllowed("/x/y/z.zip")).toBe(false);
    expect(isComposerChatAttachmentPathAllowed("/x/y/z.exe")).toBe(false);
  });
});
