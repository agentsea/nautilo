import { describe, expect, test } from "bun:test";
import { formatUserAttachmentDisplay } from "../../src/lib/user-attachment-display";

const attachment = (name: string, body = "File contents") =>
  `<attachment id="synthetic-attachment" filename="${name}" untrusted="true">\n${body}\n</attachment>`;

describe("shared user attachment display", () => {
  test("shows the filename and authored message without the internal envelope", () => {
    const stored = `${attachment("notes.txt")}\n\nCan you read this?`;
    expect(formatUserAttachmentDisplay(stored)).toBe("📎 Attached: notes\\.txt\n\nCan you read this?");
    expect(stored).toContain("File contents");
  });

  test("summarizes multiple and attachment-only messages", () => {
    expect(formatUserAttachmentDisplay(`${attachment("one")}\n\n${attachment("two")}`))
      .toBe("📎 Attached: one, two");
  });

  test("handles the audio transcript envelope without showing provider metadata", () => {
    const text = '<attachment-transcript id="synthetic-audio" filename="memo.wav" provider="example" model="example-model" untrusted="true">\nSpoken contents\n</attachment-transcript>\n\nSummarize it.';
    expect(formatUserAttachmentDisplay(text)).toBe("📎 Attached: memo\\.wav\n\nSummarize it.");
  });

  test("decodes escaped filenames once and renders Markdown punctuation literally", () => {
    expect(formatUserAttachmentDisplay(attachment("[notes](https://example.test)&amp;&lt;b&gt;.txt")))
      .toBe("📎 Attached: \\[notes\\]\\(https://example\\.test\\)\\&\\<b\\>\\.txt");
    expect(formatUserAttachmentDisplay(attachment("&amp;lt;"))).toBe("📎 Attached: \\&lt;");
  });

  test("preserves ordinary text, inline examples, code and incomplete envelopes", () => {
    for (const text of ["Hello", `Example: ${attachment("notes")}`, `\`\`\`xml\n${attachment("notes")}\n\`\`\``, '<attachment id="example" filename="notes" untrusted="true">\nunfinished']) {
      expect(formatUserAttachmentDisplay(text)).toBe(text);
    }
  });

  test("preserves the entire message when extracted text contains envelope delimiters", () => {
    for (const delimiter of ["</attachment>", "</attachment-transcript>", '<attachment id="example">']) {
      const text = `${attachment("notes.txt", `First line\n${delimiter}\n\nFile body after delimiter`)}\n\nAuthored message`;
      expect(formatUserAttachmentDisplay(text)).toBe(text);
    }
    const audio = '<attachment-transcript id="synthetic-audio" filename="memo.wav" provider="example" model="example-model" untrusted="true">\nFirst line\n</attachment-transcript>\n\nRemaining transcript\n</attachment-transcript>\n\nAuthored message';
    expect(formatUserAttachmentDisplay(audio)).toBe(audio);
  });

  test("does not partially summarize before a malformed following envelope", () => {
    const text = `${attachment("one")}\n\n<attachment id="unfinished">\nRemaining text`;
    expect(formatUserAttachmentDisplay(text)).toBe(text);
  });
});
