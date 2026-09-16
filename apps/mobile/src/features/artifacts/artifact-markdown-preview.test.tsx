import { expect, test } from "bun:test";

test("shared Markdown preview preserves themed rendering without owning scroll", async () => {
  const source = await Bun.file(new URL("./artifact-markdown-preview.tsx", import.meta.url)).text();
  expect(source).toContain("markdownit={MOBILE_MARKDOWN_PARSER}");
  expect(source).toContain('accessibilityLabel="Markdown preview"');
  expect(source).toContain("createMarkdownStyles");
  expect(source).toContain("code_inline");
  expect(source).toContain('flexShrink: 1');
  expect(source).toContain('maxWidth: "100%"');
  expect(source).toContain('minWidth: 0');
  expect(source).toContain("blockquote");
  expect(source).not.toContain("ScrollView");
});
