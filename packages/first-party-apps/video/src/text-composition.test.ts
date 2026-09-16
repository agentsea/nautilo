import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderTextCompositionHtml, renderTextCompositionMarkup } from "./text-composition";

test("all text stays literal, including Unicode, line breaks, markup and filter syntax", () => {
  const win = new Window();
  try {
    const text = `Hello <img src="https://bad.invalid" onerror="alert(1)"> & 'quotes'\nمرحبا 日本語 é 🎬\n{\\pos(0,0)} x';movie=/private/file`;
    const markup = renderTextCompositionMarkup("caption", text);
    win.document.body.innerHTML = markup;
    expect(win.document.querySelector("[data-text-content]")!.textContent).toBe(text);
    expect(win.document.querySelectorAll("img,script,iframe,a,link").length).toBe(0);
    expect(markup).toContain("font-size:3cqw");
    expect(markup).toContain("align-items:flex-end");
    expect(renderTextCompositionHtml("caption", text, 1920, 1080)).toContain(markup);
    expect(renderTextCompositionHtml("caption", text, 1920, 1080)).toContain("default-src 'none'");
  } finally { win.close(); }
});

test("title is transparent; caption and callout have shared boxed typography", () => {
  expect(renderTextCompositionMarkup("text", "Title")).toContain("background:transparent");
  for (const kind of ["caption", "callout"] as const) expect(renderTextCompositionMarkup(kind, "Words")).toContain("background:#000b");
  expect(() => renderTextCompositionHtml("text", "Title", NaN, 100)).toThrow("invalid_text_composition");
});
