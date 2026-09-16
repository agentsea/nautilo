import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression guard for a real routing hazard: because *every* Nautilo document
 * is `.html` / `text/html`, an app that claims `.html` (or `text/html`) by
 * extension/mime hijacks every other app's documents (association routing ranks
 * an extension/mime hit above a content match). "Nautilo Design" must therefore
 * be a pure content-matcher — it claims documents ONLY via its embedded
 * manifest (`documentType: "design"`), never by extension or mime. Do not add
 * `.html`/`text/html` (or any extension/mime) back to `fileAssociations`.
 */
const manifest = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "app.json"), "utf8"),
) as {
  fileAssociations?: { extensions?: unknown; mimeTypes?: unknown };
  contentAssociations?: Array<{
    scriptType?: string;
    match?: { documentType?: string };
  }>;
};

describe("nautilo-design association scope", () => {
  test("claims no files by extension or mime (content-matcher only)", () => {
    expect(manifest.fileAssociations?.extensions ?? []).toEqual([]);
    expect(manifest.fileAssociations?.mimeTypes ?? []).toEqual([]);
  });

  test("claims its own documents solely by the embedded design manifest", () => {
    const assoc = manifest.contentAssociations?.[0];
    expect(assoc?.match?.documentType).toBe("design");
    expect(assoc?.scriptType).toBe("application/vnd.nautilo.design+json");
  });
});
