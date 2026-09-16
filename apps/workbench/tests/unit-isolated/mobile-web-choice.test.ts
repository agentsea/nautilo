import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const signInSource = readFileSync(
  join(import.meta.dir, "../../src/components/sign-in-dialog.tsx"),
  "utf8",
);
const accountMenuSource = readFileSync(
  join(import.meta.dir, "../../src/components/workbench-account-menu.tsx"),
  "utf8",
);

for (const [surface, source] of [
  ["signed-out sign-in dialog", signInSource],
  ["signed-in account menu", accountMenuSource],
] as const) {
  test(`${surface} offers a browser-only, same-tab Mobile Web choice`, () => {
    expect(source).toContain("isDesktop");
    expect(source).toMatch(/!isDesktop\s*\?\s*\(/);
    expect(source).toMatch(/!isDesktop[\s\S]{0,500}href="\/mobile\/"/);
    expect(source).toContain("Open Mobile");
    expect(source).toContain("rememberMobileInterfaceChoice");
    expect(source).not.toContain("preventDefault");
    expect(source).not.toMatch(/href="\/mobile\/"[^>]*\btarget=/);
    expect(source).not.toMatch(/(?:localStorage|sessionStorage|matchMedia|navigator\.userAgent|window\.open|location\.(?:assign|replace))/);
  });
}
