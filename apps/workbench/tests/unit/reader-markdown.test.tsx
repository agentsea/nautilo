import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { ReaderMarkdown } from "../../src/viewers/markdown/markdown-viewer";

function renderMarkdown(content: string): string {
  return renderToStaticMarkup(<ReaderMarkdown content={content} />);
}

function parsedMarkdown(content: string) {
  const document = new Window().document;
  document.body.innerHTML = renderMarkdown(content);
  return document.body;
}

describe("ReaderMarkdown", () => {
  test("renders fenced code blocks without stray backticks", () => {
    const html = renderMarkdown(["```ts", "const value = 1", "```"].join("\n"));
    expect(html).toContain("<pre");
    expect(html).toContain("const value = 1");
    expect(html).not.toContain("```");
  });

  test("renders GFM tables as tables", () => {
    const html = renderMarkdown("| A | B |\n| - | - |\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<td>1</td>");
    expect(html).toContain("<td>2</td>");
  });

  test("renders GFM task lists", () => {
    const html = renderMarkdown("- [x] Done\n- [ ] Todo");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
    expect(html).toContain("Todo");
  });

  test("strikes only a completed item's own text in a tight nested task list", () => {
    const html = renderMarkdown("- [x] Parent done\n  - [ ] Child todo");

    expect(html).toContain('class="line-through">Parent done</span>');
    expect(html).not.toContain('class="line-through">Child todo</span>');
    expect(html).toMatch(/<ul[^>]*>.*Child todo.*<\/ul>/s);
    const body = parsedMarkdown("- [x] Parent done\n  - [ ] Child todo");
    expect(body.querySelector("li li")?.closest(".line-through")).toBeNull();
    expect(body.querySelector("li li .line-through")).toBeNull();
  });

  test("strikes only a completed item's own paragraph in a loose nested task list", () => {
    const html = renderMarkdown("- [x] Parent done\n\n  More parent text.\n\n  - [ ] Child todo");

    expect(html).toContain('class="line-through">Parent done</span>');
    expect(html).toContain('class="line-through">More parent text.</span>');
    expect(html).not.toContain('class="line-through">Child todo</span>');
  });

  test("does not put block content inside the inline strikethrough wrapper", () => {
    const html = renderMarkdown("- [x] Parent done\n\n  > Supporting quote");

    expect(html).toContain('class="line-through">Parent done</span>');
    expect(html).toContain("<blockquote>");
    expect(html).not.toMatch(/<span class="line-through">\s*<blockquote>/);
  });

  test("keeps a completed task's thematic break outside inline wrappers", () => {
    const html = renderMarkdown("- [x] Done\n\n  ---");
    expect(html).toContain("<hr/>");
    expect(html).not.toMatch(/<span[^>]*>\s*<hr/);
  });

  test("escapes raw HTML instead of executing/rendering it", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("unknown fenced language falls back to a code block", () => {
    const html = renderMarkdown(["```madeuplang", "hello()", "```"].join("\n"));
    expect(html).toContain("<pre");
    expect(html).toContain("hello()");
  });
});
