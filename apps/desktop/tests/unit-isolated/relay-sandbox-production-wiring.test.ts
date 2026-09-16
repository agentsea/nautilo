import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// This is deliberately a source-level receipt: it verifies Electron's
// packaging result is threaded into the composed handler. The portable
// envelope-resolution behavior is covered through @nautilo/sandbox directly.
const relaySource = readFileSync(
  resolve(import.meta.dir, "../../electron/relay.ts"),
  "utf8",
);

test("relay startup derives sandbox production enforcement from Electron packaging", () => {
  const startRelay = relaySource.slice(relaySource.indexOf("export async function startRelay"));

  expect(startRelay).toContain("const isProduction = await resolveElectronIsPackaged();");
  expect(startRelay).toMatch(/onDispatch: makeDispatchHandler\(guard, \{[\s\S]*?isProduction,/);
  expect(relaySource).toContain("options.isProduction ?? process.env[\"NODE_ENV\"] === \"production\"");
});
