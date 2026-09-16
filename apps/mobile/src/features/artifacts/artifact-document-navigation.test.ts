import { expect, test } from "bun:test";
import { documentNavigation } from "./artifact-document-navigation";

test("only the static page and fragments stay inside the reader", () => {
  for (const url of ["about:blank", "about:blank#chapter", "#chapter"]) expect(documentNavigation(url)).toEqual({ kind: "internal" });
  for (const url of ["https://example.com/page", "http://example.com/", "mailto:hello@example.com"]) expect(documentNavigation(url)).toEqual({ kind: "confirm", url });
});

test("native, filesystem, script, credential and data destinations cannot escape", () => {
  for (const url of ["javascript:alert(1)", "file:///private/key", "content://secrets", "data:text/html,test", "intent://x", "nautilo://admin", "https://user:pass@example.com", "//example.com", "about:blank.evil"]) expect(documentNavigation(url)).toEqual({ kind: "blocked" });
});
