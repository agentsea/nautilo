import { describe, expect, test } from "bun:test";

import { decodeChatSearchSnippet } from "./chat-search-presentation";

describe("D470 mobile chat-search presentation", () => {
  test("decodes the server's five escaped entities for native text", () => {
    expect(
      decodeChatSearchSnippet("&lt;tag&gt; &amp; &quot;quote&quot; &#39;apostrophe&#39;"),
    ).toBe(`<tag> & "quote" 'apostrophe'`);
  });

  test("leaves ordinary text unchanged and never recursively decodes", () => {
    expect(decodeChatSearchSnippet("plain <tag> & text")).toBe("plain <tag> & text");
    expect(decodeChatSearchSnippet("&amp;lt;tag&amp;gt; &amp;amp;"))
      .toBe("&lt;tag&gt; &amp;");
  });
});
