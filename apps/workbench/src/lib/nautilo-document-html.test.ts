import { describe, expect, test } from "bun:test";
import {
  extractHtmlJsonScript,
  htmlMatchesContentAssociation,
} from "./nautilo-document-html";

const MANIFEST = `{"documentType":"spreadsheet","editor":"wafflebase","payloadId":"wafflebase-spreadsheet","payloadFormat":"application/vnd.wafflebase.spreadsheet+json","version":"1.0"}`;

describe("HTML JSON content associations", () => {
  const spreadsheetAssociation = {
    id: "spreadsheet-html",
    kind: "html-script-json" as const,
    scriptId: "manifest",
    scriptType: "application/vnd.nautilo.document+json",
    match: {
      documentType: "spreadsheet",
      editor: "wafflebase",
      payloadFormat: "application/vnd.wafflebase.spreadsheet+json",
    },
  };

  test("extracts a JSON script by declared id and MIME type", () => {
    const html = `<!doctype html><html><head><script type="application/vnd.nautilo.document+json" id="manifest">${MANIFEST}</script></head></html>`;
    expect(extractHtmlJsonScript(html, "manifest", "application/vnd.nautilo.document+json")).toEqual({
      documentType: "spreadsheet",
      editor: "wafflebase",
      payloadId: "wafflebase-spreadsheet",
      payloadFormat: "application/vnd.wafflebase.spreadsheet+json",
      version: "1.0",
    });
    expect(htmlMatchesContentAssociation(html, spreadsheetAssociation)).toBe(true);
  });

  test("does not match plain HTML", () => {
    expect(htmlMatchesContentAssociation("<h1>Hello</h1>", spreadsheetAssociation)).toBe(false);
  });

  test("rejects malformed JSON and prototype pollution keys", () => {
    expect(
      htmlMatchesContentAssociation(
        '<script type="application/vnd.nautilo.document+json" id="manifest">{bad</script>',
        spreadsheetAssociation,
      ),
    ).toBe(false);
    expect(
      htmlMatchesContentAssociation(
        '<script type="application/vnd.nautilo.document+json" id="manifest">{"documentType":"spreadsheet","editor":"wafflebase","payloadId":"wafflebase-spreadsheet","payloadFormat":"application/vnd.wafflebase.spreadsheet+json","version":"1.0","constructor":{"x":1}}</script>',
        spreadsheetAssociation,
      ),
    ).toBe(false);
  });

  test("uses app-declared fields rather than hardcoded document types", () => {
    const association = {
      id: "kanban-html",
      kind: "html-script-json" as const,
      scriptId: "manifest",
      scriptType: "application/vnd.nautilo.document+json",
      match: { documentType: "kanban", editor: "cards" },
    };
    const html = `<script type="application/vnd.nautilo.document+json" id="manifest">{"documentType":"kanban","editor":"cards","version":"1.0"}</script>`;
    expect(htmlMatchesContentAssociation(html, association)).toBe(true);
  });
});
